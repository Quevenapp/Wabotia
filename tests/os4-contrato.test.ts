// OS4: contrato de manutenção sobre a Mensalidade (docs/ORDEM-DE-SERVICO.md,
// "Contrato de manutenção"). Banco local do teste; nenhuma rede, provedor ou
// ERP real.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { changeStatus, createOrder, loadOrder, orderView } from "../src/modules/os/store";
import { osModule } from "../src/modules/os/definition";
import { MAINTENANCE_OPERATIONS } from "../src/modules/os/maintenance/routes";
import { maintenanceDue, runContractsDue } from "../src/modules/os/maintenance/store";
import {
  addCivilMonths, civilToday, firstVisit, nextVisit, periodKey, splitUsage, usageText, validateContract, visitDue,
} from "../src/modules/os/maintenance/model";
import { openapi } from "../src/openapi";
import { moduleRoutes } from "../src/modules/hooks";
import { fixture, type Fixture } from "./service-center-fixture";

const PHONE = "5511987650001";

async function setup(options: { mensalidade?: boolean } = {}) {
  const f = await fixture();
  const run = (op: string, data: any = {}) => perform(env, f.admin, f.profile, op, data, uid());
  await run("module.set", { id: "os", enabled: true });
  if (options.mensalidade !== false) await run("module.set", { id: "mensalidade", enabled: true });
  const contact = uid(), plan = uid(), at = now();
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,'team','Buffet Alegria',?,'buffet alegria','manual',?,?,?,?)`, contact, f.profile, PHONE, f.admin.id, f.admin.id, at, at);
  await exec(env, "INSERT INTO mensalidade_plans(id,profile_id,name,amount_cents,period,due_day,active,created_by,created,updated) VALUES(?,?,'Manutenção mensal',35000,'monthly',10,1,?,?,?)",
    plan, f.profile, f.admin.id, at, at);
  const ctx = modulesApi(env, f.profile, "os");
  return { f, run, ctx, contact, plan };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const coverage = (extra: Record<string, unknown> = {}) => ({ unit: "visits", limit: 2, period: "month", excess: "quote", excess_unit_cents: 18000, ...extra });
async function contract(s: Setup, extra: Record<string, unknown> = {}) {
  return s.run("os.contract.create", { contact_id: s.contact, plan_id: s.plan, coverage: coverage(), starts_on: civilToday(now()), terms: "Atendimento em até 48 horas.", ...extra });
}
async function order(s: Setup, f: Fixture = s.f) {
  return (await createOrder(s.ctx, { item: "Ar-condicionado da recepção", problem: "Manutenção preventiva", phone: PHONE, customer_name: "Buffet Alegria",
    source: "panel", sourceKey: uid(), actor: f.admin.id, notify: false })).order;
}

describe("OS4 regras puras do contrato", () => {
  it("período, uso, excedente e texto da tela", () => {
    expect(periodKey("month", "2026-11-20")).toBe("2026-11");
    expect(periodKey("quarter", "2026-11-20")).toBe("2026-T4");
    expect(periodKey("year", "2026-11-20")).toBe("2026");
    const visits = { type_ids: [], services: "", unit: "visits" as const, limit: 2, period: "month" as const, excess: "quote" as const, excess_unit_cents: null };
    expect(usageText(visits, 1)).toBe("1 de 2 visitas usadas neste mês");
    expect(splitUsage(visits, 2, 1)).toEqual({ covered: 0, excess: 1, remaining: 0 });
    const hours = { ...visits, unit: "hours" as const, limit: 300 };
    expect(usageText(hours, 90)).toBe("1,5 de 5 horas usadas neste mês");
    expect(splitUsage(hours, 240, 120)).toEqual({ covered: 60, excess: 60, remaining: 60 });
  });

  it("visitas programadas: a cada N dias ou todo dia D, com antecedência e vigência", () => {
    const every = { kind: "every_days" as const, days: 30, lead_days: 5, type_id: "service_order", item: "Visita" };
    expect(firstVisit(every, "2026-11-01")).toBe("2026-11-01");
    expect(nextVisit(every, "2026-11-01")).toBe("2026-12-01");
    const monthly = { kind: "month_day" as const, day: 31, lead_days: 3, type_id: "service_order", item: "Visita" };
    expect(firstVisit(monthly, "2026-01-15")).toBe("2026-01-31");
    expect(nextVisit(monthly, "2026-01-31")).toBe("2026-02-28");
    expect(nextVisit(monthly, "2026-02-28")).toBe("2026-03-31");
    expect(visitDue(every, "2026-12-01", "2026-11-26", null)).toBe(true);
    expect(visitDue(every, "2026-12-01", "2026-11-25", null)).toBe(false);
    expect(visitDue(every, "2026-12-01", "2026-11-30", "2026-11-30")).toBe(false);
    expect(addCivilMonths("2026-02-10", 12)).toBe("2027-02-10");
  });

  it("validação: cliente, plano, cobertura, vigência e reajuste", () => {
    const base = { contact_id: "c1", plan_id: "p1", coverage: coverage(), starts_on: "2026-11-01" };
    const valid = validateContract(base, ["service_order"]);
    expect(valid.coverage).toMatchObject({ unit: "visits", limit: 2, type_ids: [] });
    expect(validateContract({ ...base, coverage: coverage({ unit: "hours", limit: 5 }) }, ["service_order"]).coverage.limit).toBe(300);
    expect(validateContract({ ...base, adjustment: { percent: 5.5 } }, ["service_order"]).adjustment).toEqual({ bp: 550, on: "2027-11-01" });
    expect(() => validateContract({ ...base, coverage: undefined }, ["service_order"])).toThrow("Informe o que o contrato cobre");
    expect(() => validateContract({ ...base, ends_on: "2026-10-01" }, ["service_order"])).toThrow("Fim da vigência");
    expect(() => validateContract({ ...base, coverage: coverage({ type_ids: ["nao_existe"] }) }, ["service_order"])).toThrow("não existe");
    expect(() => validateContract({ ...base, contact_id: "outro" }, ["service_order"], valid)).toThrow("não muda");
  });
});

describe("OS4 contrato de manutenção", () => {
  it("cria o contrato com a assinatura da Mensalidade e mostra vencimentos e uso", async () => {
    const s = await setup();
    const created = await contract(s);
    expect(created).toMatchObject({ number: 1, status: "active", in_force: true, plan: { name: "Manutenção mensal" }, usage: { text: "0 de 2 visitas usadas neste mês" } });
    const sub = await one(env, "SELECT * FROM mensalidade_subscriptions WHERE id=?", created.subscription.id);
    expect(sub).toMatchObject({ plan_id: s.plan, phone: PHONE, amount_cents: 35000, status: "active" });
    expect(created.subscription.next_due.length).toBeGreaterThan(0);
    // Repetir o mesmo pedido (mesma chave) não cria outro contrato nem outra assinatura.
    const key = uid();
    const a = await perform(env, s.f.admin, s.f.profile, "os.contract.create", { contact_id: s.contact, plan_id: s.plan, coverage: coverage(), starts_on: civilToday(now()) }, key);
    const b = await perform(env, s.f.admin, s.f.profile, "os.contract.create", { contact_id: s.contact, plan_id: s.plan, coverage: coverage(), starts_on: civilToday(now()) }, key);
    expect(b.id).toBe(a.id);
    expect((await all(env, "SELECT id FROM mensalidade_subscriptions WHERE profile_id=?", s.f.profile)).length).toBe(2);
    const list = await s.ctx.read(s.f.admin, "service-orders/contracts", { situation: "active" });
    expect(list.data.map((c: any) => c.number)).toEqual([2, 1]);
  });

  it("sem a Mensalidade ligada, recusa com module_disabled e diz qual módulo ligar", async () => {
    const s = await setup({ mensalidade: false });
    await expect(contract(s)).rejects.toMatchObject({ code: "module_disabled", message: expect.stringContaining("Mensalidade") });
    const options = await s.ctx.read(s.f.admin, "service-orders/contract-options");
    expect(options).toMatchObject({ modules: { os: true, mensalidade: false }, missing: expect.stringContaining("Mensalidade") });
    const o = await order(s);
    expect(await s.ctx.read(s.f.admin, `service-orders/${o.id}/contract`)).toMatchObject({ available: false });
  });

  it("ordem coberta: linha com valor zero, limite do período, excedente com preço e cancelamento devolve", async () => {
    const s = await setup();
    const c = await contract(s);
    const first = await order(s);
    const view = await s.ctx.read(s.f.admin, `service-orders/${first.id}/contract`);
    expect(view.contracts[0]).toMatchObject({ headline: "Coberto pelo contrato nº 1: 0 de 2 visitas usadas neste mês", can_cover: true });
    const covered = await s.run("os.contract.cover", { id: first.id, contract_id: c.id });
    expect(covered.coverage).toMatchObject({ covered_units: 1, excess_units: 0 });
    const quote = orderView(await loadOrder(s.ctx, first.id)).quote!;
    expect(quote.items[0]).toMatchObject({ description: "Visita coberta pelo contrato nº 1", unit_cents: 0, covered: true });
    expect(quote.total_cents).toBe(0);
    const second = await order(s);
    await s.run("os.contract.cover", { id: second.id, contract_id: c.id });
    const third = await order(s);
    const excess = await s.run("os.contract.cover", { id: third.id, contract_id: c.id });
    expect(excess.coverage).toMatchObject({ covered_units: 0, excess_units: 1 });
    expect(excess.warnings.join(" ")).toContain("excedente");
    const excessQuote = orderView(await loadOrder(s.ctx, third.id)).quote!;
    expect(excessQuote.items[0]).toMatchObject({ description: "Visita excedente ao contrato nº 1", unit_cents: 18000 });
    expect(excessQuote.items[0].covered).toBeUndefined();
    expect((await s.ctx.read(s.f.admin, "service-orders/contracts")).data[0].usage.text).toBe("2 de 2 visitas usadas neste mês");
    // Cancelar a ordem devolve o limite.
    await changeStatus(s.ctx, await loadOrder(s.ctx, second.id), "cancelled", s.f.admin.id, "Cliente desistiu");
    expect((await s.ctx.read(s.f.admin, "service-orders/contracts")).data[0].usage.text).toBe("1 de 2 visitas usadas neste mês");
    // Item coberto precisa ter valor zero.
    await expect(s.run("os.quote.save", { id: third.id, items: [{ description: "Visita", unit_cents: 100, covered: true }] })).rejects.toThrow("valor zero");
    // Já marcada: não troca de contrato sem desmarcar.
    const other = await contract(s);
    await expect(s.run("os.contract.cover", { id: first.id, contract_id: other.id })).rejects.toMatchObject({ code: "already_covered" });
    await s.run("os.contract.release", { id: first.id, reason: "Marcada por engano" });
    expect((await s.ctx.read(s.f.admin, `service-orders/${first.id}/contract`)).coverage).toBeNull();
  });

  it("contrato em horas: o que passa do limite vira excedente", async () => {
    const s = await setup();
    const c = await contract(s, { coverage: coverage({ unit: "hours", limit: 5, excess_unit_cents: 9000 }) });
    const o = await order(s);
    const result = await s.run("os.contract.cover", { id: o.id, contract_id: c.id, hours: 6.5 });
    expect(result.coverage).toMatchObject({ covered_units: 300, excess_units: 90, covered_text: "5 horas", excess_text: "1,5 hora" });
    const items = orderView(await loadOrder(s.ctx, o.id)).quote!.items;
    expect(items.map(i => [i.quantity, i.unit_cents, i.covered ?? false])).toEqual([[5, 0, true], [1.5, 9000, false]]);
  });

  it("assinatura em atraso: block recusa a cobertura, warn só avisa", async () => {
    const s = await setup();
    const blocking = await contract(s, { overdue_policy: "block" });
    const warning = await contract(s, { overdue_policy: "warn" });
    for (const c of [blocking, warning])
      await exec(env, "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,created,updated) VALUES(?,?,?,?,?,?,'overdue',?,?)",
        uid(), s.f.profile, c.subscription.id, "2026-01", "2026-01-10", 35000, now(), now());
    const o = await order(s);
    const view = await s.ctx.read(s.f.admin, `service-orders/${o.id}/contract`);
    expect(view.contracts.find((c: any) => c.id === blocking.id)).toMatchObject({ can_cover: false, blocked_reason: expect.stringContaining("atraso") });
    await expect(s.run("os.contract.cover", { id: o.id, contract_id: blocking.id })).rejects.toMatchObject({ code: "contract_overdue" });
    const warned = await s.run("os.contract.cover", { id: o.id, contract_id: warning.id });
    expect(warned.warnings.join(" ")).toContain("em atraso");
  });

  it("suspender e encerrar com motivo; a assinatura acompanha; suspenso não cobre", async () => {
    const s = await setup();
    const c = await contract(s);
    await expect(s.run("os.contract.status", { contract_id: c.id, status: "suspended" })).rejects.toMatchObject({ code: "reason_required" });
    const suspended = await s.run("os.contract.status", { contract_id: c.id, status: "suspended", reason: "Cliente pediu pausa" });
    expect(suspended).toMatchObject({ status: "suspended", status_reason: "Cliente pediu pausa" });
    expect((await one(env, "SELECT status FROM mensalidade_subscriptions WHERE id=?", c.subscription.id)).status).toBe("paused");
    const o = await order(s);
    await expect(s.run("os.contract.cover", { id: o.id, contract_id: c.id })).rejects.toMatchObject({ code: "contract_suspended" });
    const ended = await s.run("os.contract.status", { contract_id: c.id, status: "ended", reason: "Fim do contrato" });
    expect(ended.status).toBe("ended");
    expect((await one(env, "SELECT status FROM mensalidade_subscriptions WHERE id=?", c.subscription.id)).status).toBe("ended");
    await expect(s.run("os.contract.update", { contract_id: c.id, terms: "x" })).rejects.toMatchObject({ code: "contract_ended" });
    const history = await s.ctx.read(s.f.admin, `service-orders/contracts/${c.id}`);
    expect(history.history.map((h: any) => h.kind)).toEqual(expect.arrayContaining(["created", "suspended", "ended"]));
  });

  it("visitas programadas: propõe em Manutenções a abrir, abre a ordem coberta ou pula; nunca sozinho", async () => {
    const s = await setup();
    const today = civilToday(now());
    const c = await contract(s, { visits: { kind: "every_days", days: 30, lead_days: 7, type_id: "service_order", item: "Manutenção preventiva", first_on: today } });
    await runContractsDue(s.ctx, now());
    expect((await all(env, "SELECT id FROM os_orders WHERE profile_id=?", s.f.profile)).length).toBe(0);
    const due = await maintenanceDue(s.ctx);
    expect(due.data).toEqual([expect.objectContaining({ due_on: today, item: "Manutenção preventiva" })]);
    const opened = await s.run("os.contract.visit", { contract_id: c.id, due_on: today });
    expect(opened.order).toMatchObject({ type_id: "service_order" });
    expect(opened.contract.visits.next_on).toBe(nextVisit({ kind: "every_days", days: 30, lead_days: 7, type_id: "service_order", item: "" }, today));
    expect((await s.ctx.read(s.f.admin, `service-orders/${opened.order.id}/contract`)).coverage).toMatchObject({ covered_units: 1 });
    await expect(s.run("os.contract.visit", { contract_id: c.id, due_on: today })).rejects.toMatchObject({ code: "version_conflict" });
    expect((await maintenanceDue(s.ctx)).data).toEqual([]);
  });

  it("reajuste anual: só avisa na data e não muda a assinatura", async () => {
    const s = await setup();
    const c = await contract(s, { adjustment: { percent: 7.5, on: civilToday(now()) } });
    await runContractsDue(s.ctx, now());
    const row = await one(env, "SELECT adjustment_on,adjustment_noticed_on FROM os_contracts WHERE id=?", c.id);
    expect(row).toEqual({ adjustment_noticed_on: civilToday(now()), adjustment_on: addCivilMonths(civilToday(now()), 12) });
    expect((await one(env, "SELECT amount_cents FROM mensalidade_subscriptions WHERE id=?", c.subscription.id)).amount_cents).toBe(35000);
    const view = await s.ctx.read(s.f.admin, `service-orders/contracts/${c.id}`);
    expect(view.warnings.join(" ")).toContain("Reajuste de 7,5%");
  });

  it("bots: nomes estáveis no OpenAPI e dinheiro/encerramento como proposta", () => {
    const spec = openapi("https://test");
    const ids = Object.values(spec.paths).flatMap((methods: any) => Object.values(methods).map((m: any) => m.operationId));
    for (const id of ["os.contract.create", "os.contract.update", "os.contract.status", "os.contract.cover", "os.contract.release", "os.contract.visit",
      "os.schedule.set", "os.schedule.cancel", "os.schedule.get", "os.contracts.list", "os.maintenance.due", "os.my_schedule"])
      expect(ids, id).toContain(id);
    for (const op of MAINTENANCE_OPERATIONS.sensitive) expect(osModule.bot?.sensitive).toContain(op);
    expect(osModule.bot?.sensitive).not.toContain("os.schedule.set");
    const create = spec.paths["/profiles/{profile}/service-orders/contracts"].post;
    expect(create.description).toContain("Mensalidade");
    expect(create.description).toContain("sensível");
    // Toda rota nova do módulo está no OpenAPI, com os parâmetros do caminho.
    const ours = /contract|schedule|maintenance-due/;
    const routes = [
      ...moduleRoutes().read.filter(r => r.path.startsWith("service-orders") && ours.test(r.path)).map(r => ["get", r.path]),
      ...moduleRoutes().write.filter(r => r.path.startsWith("service-orders") && ours.test(r.path)).map(r => [r.method.toLowerCase(), r.path]),
    ];
    expect(routes.length).toBe(17);
    for (const [method, path] of routes) {
      const entry = spec.paths["/profiles/{profile}/" + path.replace(/:(\w+)/g, "{$1}")]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.operationId, path).toMatch(/^os\./);
      for (const [, name] of path.matchAll(/:(\w+)/g))
        expect(entry.parameters).toContainEqual(expect.objectContaining({ in: "path", name, required: true }));
    }
  });

  it("bot sem confirmação da pessoa não cria contrato nem marca cobertura", async () => {
    const s = await setup();
    const bot = { ...s.f.admin, id: `bot:${uid()}` };
    await expect(perform(env, bot, s.f.profile, "os.contract.create", { contact_id: s.contact, plan_id: s.plan, coverage: coverage(), starts_on: civilToday(now()) }, uid()))
      .rejects.toMatchObject({ status: 403 });
  });
});
