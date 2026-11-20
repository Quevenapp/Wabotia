// OS3: o comercial da ordem (docs/ORDEM-DE-SERVICO.md, "Orçamento" e
// "Cobrança e recebimento"). Contra o ERP simulado da fase 3; nenhuma
// chamada a provedor, banco ou rede.
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, uid, type Actor } from "../src/types";
import type { ModuleContext } from "../src/modules/api";
import type { CustomWorkType } from "../src/modules/os/contracts";
import type { IntegrationEvent } from "../src/integrations/contracts";
import { createOrder, saveQuote, sendQuote, decide, changeStatus, loadOrder, orderView, reopenQuote, quoteSummary, quotePageSpec } from "../src/modules/os/store";
import { builtinWorkType } from "../src/modules/os/work-types";
import { validateWorkType } from "../src/modules/os/validation";
import { osModule } from "../src/modules/os/definition";
import { commercialOf, stableQuoteItems, workPrivacy } from "../src/modules/os/commercial/projection";
import { patchWorkCommercial, requireCommercialWriter } from "../src/modules/os/commercial/routes";
import { paymentsView, recordManualReceipt } from "../src/modules/os/commercial/receipts";
import { validateEvent } from "../src/integrations/privacy";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

afterEach(() => vi.restoreAllMocks());
const quiet = { notify: false };
const repairType = (): CustomWorkType => {
  const builtin = builtinWorkType({ service_orders: { warranty_days: 0 } });
  return validateWorkType({ ...builtin, kind: "custom", id: "oficina", number_prefix: "OF",
    transitions: builtin.transitions.filter(t => t.id !== "quoted_analyzing") });
};
async function fixture(options: { erp?: boolean; custom?: boolean; finance?: boolean } = {}) {
  const f = await f3Fixture();
  if (options.erp === false) await setParts(f.profile, { erp: false });
  if (options.finance === false) await setParts(f.profile, { "erp-financeiro": false });
  const type = repairType();
  const settings: Record<string, unknown> = { service_orders: { warranty_days: 90 }, os_work_types: options.custom ? [type] : [] };
  await exec(f.env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(settings), f.profile);
  const ctx = {
    env: f.env, profile: f.profile, settings: async () => settings,
    access: (actor: Actor) => { if (!actor.profiles.includes(f.profile)) throw new ApiError(404, "not_found", "Trabalho não encontrado."); },
    requireEnabled: async () => {}, mayRead: () => true,
    publish: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}), sendInteractive: vi.fn(async () => {}),
    paymentsReady: async () => ({ ready: false, reason: "payments_disabled", message: "O módulo Cobrança está desligado.", methods: [] }),
  } as unknown as ModuleContext;
  const opened = await createOrder(ctx, { item: "Fiat Uno 2010", problem: "Barulho no freio", phone: "5511999999988", customer_name: "Cliente",
    source: "panel", sourceKey: uid(), actor: f.actor.id, type_id: options.custom ? type.id : "service_order", notify: false });
  await patchWorkCommercial(ctx, f.actor, opened.order.id, { version: opened.order.row_version, customer_ref: f.local }, uid());
  return { ...f, ctx, type, settings, row: await loadOrder(ctx, opened.order.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const events = async (f: Fixture) => (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND source_id=? ORDER BY source_revision,seq", f.profile, f.row.id))
  .map(r => JSON.parse(r.payload_json) as IntegrationEvent);
const piece = (extra: Record<string, unknown> = {}) => ({ description: "Pastilha de freio dianteira", quantity: 2, unit_cents: 8000, ...extra });
const labor = (extra: Record<string, unknown> = {}) => ({ description: "Troca das pastilhas", quantity: 1, unit_cents: 12000, ...extra });
async function approved(f: Fixture, data: Record<string, unknown> = {}) {
  const saved = await saveQuote(f.ctx, f.row, { items: [piece(), labor()], ...data }, f.actor.id, uid(), { human: true });
  const sent = await sendQuote(f.ctx, saved, f.actor.id, { ...quiet, mutationKey: uid() });
  return decide(f.ctx, sent, "approve", f.actor.id, "panel", "", { ...quiet, quote_version: sent.quote_version, mutationKey: uid(),
    detail: { by_name: "Maria (esposa)", at: Date.now() - 60_000, channel: "phone" } });
}

describe("OS3 orçamento: catálogo, desconto e vínculo", () => {
  it("edição sem id/kind (tela clássica antiga) mantém linha, classificação e vínculo do catálogo", async () => {
    const f = await fixture(), line = uid(), product = uid();
    const first = await saveQuote(f.ctx, f.row, { items: [piece({ id: line, kind: "material", unit: "UN", code: "PF-01" }), labor()] }, f.actor.id);
    await exec(f.env, "INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,'os','quote_item',?,?,?,?,?)",
      f.profile, first.id, line, product, Date.now(), f.actor.id);
    // Cliente antigo devolve só descrição, quantidade e valor.
    const edited = await saveQuote(f.ctx, first, { items: [piece(), labor({ unit_cents: 15000 })] }, f.actor.id);
    const items = orderView(edited).quote!.items;
    expect(items[0]).toMatchObject({ id: line, kind: "material", unit: "UN" });
    expect((await events(f)).at(-1)!.snapshot.items[0]).toMatchObject({ id: line, kind: "material", product_id: product });
    // A tela nova reenvia id, kind e unit: idem.
    const again = await saveQuote(f.ctx, edited, { items: [piece({ id: line, kind: "material", unit: "UN" }), labor({ unit_cents: 15000 })] }, f.actor.id);
    expect(orderView(again).quote!.items[0].id).toBe(line);
    expect((await events(f)).at(-1)!.snapshot.items[0].product_id).toBe(product);
  });

  it("desconto por linha e no total: total líquido, documento com preço de lista e desconto", async () => {
    const f = await fixture();
    const saved = await saveQuote(f.ctx, f.row, { items: [piece({ discount_cents: 1000 }), labor()], discount_cents: 500 }, f.actor.id);
    expect(saved.quote_total_cents).toBe(16000 + 12000 - 1000 - 500);
    expect(orderView(saved).quote).toMatchObject({ subtotal_cents: 28000, items_discount_cents: 1000, discount_cents: 500, total_cents: 26500 });
    const event = (await events(f)).at(-1)!;
    expect(event.snapshot).toMatchObject({ total_cents: 26500, discount_cents: 1500 });
    expect(event.snapshot.items.map(i => i.unit_cents)).toEqual([8000, 12000]);
    validateEvent(event);
    await expect(saveQuote(f.ctx, saved, { items: [piece({ discount_cents: 99999 })] }, f.actor.id)).rejects.toThrow("passa do valor do item");
    await expect(saveQuote(f.ctx, saved, { items: [piece()], discount_cents: 99999 }, f.actor.id)).rejects.toThrow("passa do valor");
  });

  it("sem Produtos e serviços: itens do catálogo seguem como avulsos, sem erro", async () => {
    const f = await fixture();
    await setParts(f.profile, { "erp-produtos": false, "erp-estoque": false });
    const saved = await saveQuote(f.ctx, f.row, { items: [piece({ id: uid(), kind: "material" }), labor()] }, f.actor.id);
    expect(saved.quote_total_cents).toBe(28000);
    expect((await events(f)).at(-1)!.snapshot.items.every(i => i.kind === "free" && i.product_id === null)).toBe(true);
  });
});

describe("OS3 condições de pagamento", () => {
  it("com Financeiro: pagador do cadastro, forma e parcelas viram a conta a receber", async () => {
    const f = await fixture();
    const payer = uid();
    await exec(f.env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Empresa Pagadora','empresa','manual',?,?,?,?)",
      payer, f.profile, f.actor.id, f.actor.id, Date.now(), Date.now());
    const method = uid();
    const saved = await saveQuote(f.ctx, f.row, { items: [piece(), labor()], terms: {
      payer_contact_id: payer, method: "other", payment_method_id: method, method_label: "Boleto da casa",
      installments: { count: 3, first_due_on: "2026-12-10", interval_days: 30 },
    } }, f.actor.id);
    const quote = orderView(saved).quote!;
    expect(quote.terms).toMatchObject({ payer_contact_id: payer, payer_name: "Empresa Pagadora", method_label: "Boleto da casa" });
    expect(quote.installments).toEqual([
      { number: 1, due_on: "2026-12-10", amount_cents: 9334 }, { number: 2, due_on: "2027-01-09", amount_cents: 9333 }, { number: 3, due_on: "2027-02-08", amount_cents: 9333 },
    ]);
    expect(commercialOf(saved)).toMatchObject({ customer_ref: payer, installments_source: "quote" });
    const event = (await events(f)).at(-1)!;
    expect(event.snapshot.installments.map(i => [i.due_on, i.amount_cents, i.payment_method_id])).toEqual([
      ["2026-12-10", 9334, method], ["2027-01-09", 9333, method], ["2027-02-08", 9333, method]]);
    expect(event.snapshot.customer_ref).toBe(payer);
    expect(quoteSummary(saved)).toContain("Pagamento: 3 parcelas");
    // Parcelas do orçamento têm data própria: a execução não exige vencer hoje.
    const sent = await sendQuote(f.ctx, saved, f.actor.id, quiet);
    const ok = await decide(f.ctx, sent, "approve", f.actor.id, "panel", "", quiet);
    expect((await changeStatus(f.ctx, ok, "in_progress", f.actor.id, "", quiet)).status).toBe("in_progress");
  });

  it("sem Financeiro: guarda só pagador, forma e total combinado, sem parcelas", async () => {
    const f = await fixture({ finance: false });
    const saved = await saveQuote(f.ctx, f.row, { items: [labor()], terms: { method: "pix", installments: { count: 4, first_due_on: "2026-12-10", interval_days: 30 } } }, f.actor.id);
    const quote = orderView(saved).quote!;
    expect(quote.terms).toMatchObject({ method: "pix", method_label: "Pix", installments: null });
    expect(quote.installments).toEqual([]);
    expect(commercialOf(saved).installments ?? []).toEqual([]);
  });

  it("pagador inexistente é recusado com mensagem clara", async () => {
    const f = await fixture();
    await expect(saveQuote(f.ctx, f.row, { items: [labor()], terms: { payer_contact_id: uid() } }, f.actor.id)).rejects.toMatchObject({ code: "customer_required" });
  });
});

describe("OS3 aprovação, trava e reabertura", () => {
  it("registra quem aprovou e quando; aprovado fica travado e reabrir exige motivo", async () => {
    const f = await fixture({ erp: false });
    const ok = await approved(f);
    expect(orderView(ok).decision).toMatchObject({ decision: "approved", detail: { by_name: "Maria (esposa)", channel: "phone" } });
    expect(orderView(ok).quote!.locked).toBe(true);
    await expect(saveQuote(f.ctx, ok, { items: [labor()] }, f.actor.id)).rejects.toMatchObject({ code: "quote_locked" });
    await expect(reopenQuote(f.ctx, ok, { version: ok.row_version, reason: " " }, f.actor.id)).rejects.toThrow("motivo");
    const reopened = await reopenQuote(f.ctx, ok, { version: ok.row_version, reason: "Cliente pediu peça original" }, f.actor.id, uid());
    expect(reopened).toMatchObject({ status: "analyzing", decision: null });
    expect(commercialOf(reopened).authorization).toBeNull();
    const history = await all(f.env, "SELECT note FROM os_history WHERE order_id=? ORDER BY created,rowid", f.row.id);
    expect(history.at(-1)!.note).toContain("Orçamento reaberto: Cliente pediu peça original");
    // Data informada no futuro não vale.
    const sent = await sendQuote(f.ctx, await saveQuote(f.ctx, reopened, { items: [labor()] }, f.actor.id), f.actor.id, quiet);
    await expect(decide(f.ctx, sent, "approve", f.actor.id, "panel", "", { ...quiet, detail: { by_name: "Maria", at: Date.now() + 86_400_000 } })).rejects.toThrow("futuro");
  });

  it("com documento no ERP, reabrir é recusado com o que fazer", async () => {
    const f = await fixture();
    const ok = await approved(f);
    await expect(reopenQuote(f.ctx, ok, { version: ok.row_version, reason: "Mudou" }, f.actor.id)).rejects.toMatchObject({ code: "quote_reopen_blocked" });
  });
});

describe("OS3 recebimento pela fila da fase 3", () => {
  it("ERP desligado: recebimento fica na ordem, alocado à parcela, sem evento", async () => {
    const f = await fixture({ erp: false });
    const ok = await approved(f);
    const view = await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 10000, method: "pix" }, uid());
    expect(view).toMatchObject({ total_cents: 28000, received_cents: 10000, balance_cents: 18000, finance: { enabled: false } });
    expect(await one(f.env, "SELECT sum(amount_cents) cents FROM module_erp_allocations WHERE profile_id=?", f.profile)).toMatchObject({ cents: 10000 });
    expect((await events(f)).some(e => e.operation === "receive")).toBe(false);
    const history = await all(f.env, "SELECT kind,note FROM os_history WHERE order_id=? AND kind='os.receipt_recorded'", ok.id);
    expect(history[0].note).toContain("Recebimento de R$ 100,00 (Pix)");
  });

  it("recebimento antes da execução segue junto da conta a receber, no mesmo lote", async () => {
    const f = await fixture();
    const ok = await approved(f);
    await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 5000, method: "cash" }, uid());
    expect((await events(f)).some(e => e.operation === "receive")).toBe(false);
    await changeStatus(f.ctx, await loadOrder(f.ctx, ok.id), "in_progress", f.actor.id, "", quiet);
    const out = await events(f);
    const execute = out.find(e => e.operation === "execute")!, receive = out.find(e => e.operation === "receive")!;
    expect(execute.eligible.finance).toBe(true);
    expect(receive).toMatchObject({ source_revision: execute.source_revision, seq: execute.seq! + 1, eligible: { finance: true } });
    out.forEach(validateEvent);
    // Depois da conta a receber, o recebimento vai direto para a fila.
    await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 3000, method: "pix" }, uid());
    expect((await events(f)).filter(e => e.operation === "receive")).toHaveLength(2);
    const view = await paymentsView(f.ctx, f.actor, ok.id);
    expect(view).toMatchObject({ received_cents: 8000, finance: { enabled: true, obligation: true } });
  });

  it("antes da aprovação não recebe; repetição da mesma chave não duplica", async () => {
    const f = await fixture({ erp: false });
    await expect(recordManualReceipt(f.ctx, f.actor, f.row.id, { amount_cents: 100, method: "pix" }, uid())).rejects.toMatchObject({ code: "quote_not_approved" });
    const ok = await approved(f), key = uid();
    await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 100, method: "pix" }, key);
    await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 100, method: "pix" }, key);
    expect(await all(f.env, "SELECT 1 FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });
});

describe("OS3 dado da ordem não é segredo por padrão", () => {
  it("oficina personalizada leva os itens como escritos; áreas sensíveis continuam reservadas", async () => {
    const f = await fixture({ custom: true });
    await saveQuote(f.ctx, f.row, { items: [piece(), labor()] }, f.actor.id);
    const snapshot = (await events(f)).at(-1)!.snapshot;
    expect(snapshot.privacy).toBe("commercial");
    expect(snapshot.description).toMatch(/^Ordem de serviço OF-1$/);
    expect(snapshot.items.map(i => i.description)).toEqual(["Pastilha de freio dianteira", "Troca das pastilhas"]);
    const ctx = { ...f.ctx, settings: async () => ({}) } as ModuleContext;
    expect(await workPrivacy(ctx, { type_id: "area_clinica_medica__atendimento" })).toBe("adult_payer_only");
    expect(await workPrivacy(ctx, { type_id: "area_escritorio_advocacia__processo" })).toBe("adult_payer_only");
    expect(await workPrivacy(ctx, { type_id: "area_oficina_mecanica__at_veiculos" })).toBe("commercial");
    const health = { ...f.ctx, settings: async () => ({ os_area_setup: [{ template_id: "clinica_medica" }] }) } as ModuleContext;
    expect(await workPrivacy(health, { type_id: "oficina" })).toBe("adult_payer_only");
  });
});

describe("OS3 bots e WhatsApp", () => {
  it("dinheiro e aprovação são propostas; só a pessoa que confirma escreve", () => {
    expect(osModule.bot?.sensitive).toEqual(expect.arrayContaining(["os.quote.save", "os.quote.reopen", "os.decide", "os.receipt.create", "os.charge.create"]));
    const person: Actor = { id: uid(), kind: "user", name: "P", role: "admin", profiles: [], scopes: [], bots: [], rate: 0, runLimit: 0 };
    expect(() => requireCommercialWriter({ ...person, via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } })).toThrow();
    expect(() => requireCommercialWriter({ ...person, via: { kind: "bot", bot_id: "b", run_id: "r", proposal_id: "p", masked: false } })).not.toThrow();
    expect(() => requireCommercialWriter({ ...person, id: "bot:x" })).toThrow();
  });

  it("página do link mostra itens, descontos, total e condições, com aprovar e recusar com motivo", async () => {
    const f = await fixture({ finance: false });
    const saved = await saveQuote(f.ctx, f.row, { items: [piece({ discount_cents: 1000 }), labor()], terms: { method: "pix" } }, f.actor.id);
    const sent = await sendQuote(f.ctx, saved, f.actor.id, quiet);
    const spec = quotePageSpec(sent);
    expect(spec.intro).toContain("Pastilha de freio dianteira");
    expect(spec.intro).toContain("Descontos: R$ 10,00");
    expect(spec.intro).toContain("Total: R$ 270,00");
    expect(spec.intro).toContain("Pagamento: Pix");
    expect(spec.fields.map(field => field.id)).toEqual(["decision", "reason", "name"]);
  });

  it("linhas antigas sem id continuam estáveis", () => {
    const row = { profile_id: "p", id: "o", quote_items: JSON.stringify([labor(), labor()]) };
    expect(new Set(stableQuoteItems(row).map(i => i.id)).size).toBe(2);
  });
});
