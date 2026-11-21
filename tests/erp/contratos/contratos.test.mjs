// Contratos de serviço (parte Contratos; Wabotia, sem função no oráculo): as
// contas de período, vencimento e reajuste; o contrato em rascunho, ativo,
// suspenso e encerrado; a cobrança que nasce desligada e, ligada, gera a
// conta a receber de cada período uma vez só (o alarme que repete não
// duplica); reajuste pela tabela de índices com prévia e histórico; aditivo a
// partir de uma data; aviso e renovação; papéis; a parte desligada; a rotina
// registrada; o acervo do Bling ausente. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { contractsDailyStep } from "../../../src/erp/domains/contracts/rpc.ts";
import {
  addMonths, adjusted, dueDate, lineTotal, nextAdjustmentMonth, parseMoney, parsePercent, parseQuantity, periodIndex, periodStart, renewedEnd,
} from "../../../src/erp/domains/contracts/model.ts";
import { ROUTINES } from "../../../src/erp/scheduler/routines.ts";
import { ERP_PART_DEPENDENCIES, ERP_PART_NAMES, ERP_PART_MODULES, normalizeErpParts } from "../../../src/erp/parts.ts";
import { runRound } from "../../../src/erp/scheduler/dispatch.ts";

const code = (c) => (e) => e.code === c || e.message === c;
const disabled = (e) => e.code === "module_disabled";
const DAY = 86_400_000;

function office(t) {
  const f = com1Fixture(t);
  f.service = f.catalog("products", { name: "Manutenção mensal", unit: "UN", kind: "S", format: "S", price: "300" });
  f.save = (data, env, command = randomUUID()) => f.rpc("erp_contract_save", { p_command_id: command, p_data: data }, env).contract;
  f.status = (c, action, extra = {}, env) => f.rpc("erp_contract_status", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, action, ...extra } }, env).contract;
  f.billing = (c, data, env) => f.rpc("erp_contract_billing", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, ...data } }, env);
  f.get = (c) => f.rpc("erp_contract_get", { p_args: { id: c.id } }).contract;
  f.daily = (day) => f.transaction((ctx) => contractsDailyStep(ctx, day));
  f.titles = (c) => f.db.exec(`SELECT t.amount_cents, t.due_on, t.issued_on, t.contact_id, t.source_reference, t.competence_on FROM "erp_finance__title" t
    JOIN "erp_contract__invoice" i ON i.title_id=t.id WHERE i.contract_id=? ORDER BY i.period_start`, c.id).rows;
  f.base = (extra = {}) => ({ contact_id: f.customer.id, object: "Manutenção preventiva dos computadores", starts_on: "2026-10-05", periodicity: "monthly", due_day: 10,
    items: [{ product_id: f.service.id, quantity: "1", unit_price: "300.00" }], ...extra });
  return f;
}

test("contas: períodos, vencimento no mês, fim de mês, renovação, reajuste e arredondamento", () => {
  assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(periodStart("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(periodStart("2026-01-31", "monthly", 2), "2026-03-31");
  assert.equal(periodStart("2026-10-05", "quarterly", 1), "2027-01-05");
  assert.equal(periodIndex("2026-10-05", "monthly", "2026-11-19"), 1);
  assert.equal(periodIndex("2026-10-05", "monthly", "2026-11-04"), 0);
  assert.equal(periodIndex("2026-10-05", "bimonthly", "2026-12-05"), 1);
  assert.equal(periodIndex("2026-10-05", "annual", "2026-01-01"), 0);
  // O dia do vencimento no mês do começo; já passado, o do mês seguinte; 31 vira o último dia.
  assert.equal(dueDate("2026-11-05", 10), "2026-11-10");
  assert.equal(dueDate("2026-11-15", 10), "2026-12-10");
  assert.equal(dueDate("2027-02-01", 31), "2027-02-28");
  assert.equal(dueDate("2027-01-31", 30), "2027-02-28");
  // Renovação pelo prazo (ou pela duração atual).
  assert.equal(renewedEnd("2026-01-01", "2026-12-31", null), "2027-12-31");
  assert.equal(renewedEnd("2026-01-01", "2026-12-31", 6), "2027-06-30");
  // Reajuste: 12 meses depois do início, no mês de aniversário; depois, um por ano.
  assert.equal(nextAdjustmentMonth("2025-03-10", 3, null), "2026-03");
  assert.equal(nextAdjustmentMonth("2025-05-10", 3, null), "2027-03");
  assert.equal(nextAdjustmentMonth("2025-03-10", 3, "2026-03"), "2027-03");
  assert.equal(adjusted(30000, parsePercent("4.56")), 31368);
  assert.equal(adjusted(999, parsePercent("0.05")), 999); // 9,99 × 1,0005 = 9,994995 → 9,99
  assert.equal(adjusted(1000, parsePercent("0.05")), 1001); // 10,005 → 10,01 (metade para longe do zero)
  assert.equal(lineTotal(parseQuantity("2.5"), 1999), 4998); // 49,975 → 49,98
  assert.equal(parseMoney("1234,5"), 123450);
  assert.equal(parseMoney("1.234,50"), null);
});

test("parte Contratos: depende do Financeiro, com nome em palavras; a rotina diária é dela", () => {
  assert.equal(ERP_PART_MODULES.contracts, "erp-contratos");
  assert.deepEqual(ERP_PART_DEPENDENCIES["erp-contratos"], ["erp-financeiro"]);
  assert.equal(ERP_PART_NAMES["erp-contratos"], "Contratos");
  const routine = ROUTINES.find((r) => r.id === "contracts.daily");
  assert.equal(routine?.block, "erp-contratos");
});

test("contrato: rascunho, edição, ativação; a cobrança nasce desligada e, ligada, gera a conta de cada período uma vez só", (t) => {
  const f = office(t);
  let c = f.save(f.base({ seller_id: null, adjustment: null, notes: "Visitas na primeira semana" }));
  assert.deepEqual([c.label, c.status, c.amount_cents, c.billing.enabled, c.indefinite], ["Contrato 1", "draft", 30000, false, true]);
  assert.equal(c.items[0].description, "Manutenção mensal");
  // Rascunho muda tudo, inclusive os itens.
  c = f.save({ id: c.id, expected_version: c.version, items: [{ product_id: f.service.id, quantity: "2", unit_price: "150" }, { description: "Deslocamento", unit_price: "20" }] });
  assert.equal(c.amount_cents, 32000);
  assert.throws(() => f.save({ id: c.id, expected_version: c.version - 1, notes: "x" }), code("erp_contract_version_conflict"));
  c = f.status(c, "activate");
  assert.equal(c.status, "active");
  // Depois de ativo, itens e início só por aditivo.
  assert.throws(() => f.save({ id: c.id, expected_version: c.version, items: [{ description: "Outro", unit_price: "1" }] }), code("erp_contract_locked_field"));
  assert.throws(() => f.save({ id: c.id, expected_version: c.version, starts_on: "2026-10-06" }), code("erp_contract_locked_field"));
  // Ativo com a cobrança desligada: o alarme não gera nada.
  f.daily("2026-11-19");
  assert.equal(f.titles(c).length, 0);
  // Liga: o período de hoje (05/11 a 04/12) já começou e sai na hora; vence em 10/11.
  const on = f.billing(c, { enabled: true, send_whatsapp: true, emit_nfse: true });
  c = on.contract;
  assert.equal(on.created.length, 1);
  assert.deepEqual(f.titles(c).map((r) => [r.amount_cents, r.due_on, r.issued_on, r.contact_id, r.source_reference, r.competence_on]),
    [[32000, "2026-11-10", "2026-11-10", f.customer.id, "Contrato 1", "2026-11-05"]]);
  assert.equal(c.billing.next_period_on, "2026-12-05");
  assert.deepEqual([c.invoices[0].charge_status, c.invoices[0].nfse_status], ["pending", "not_configured"]);
  // O alarme que repete no mesmo dia (ou antes do próximo período) não gera de novo.
  f.daily("2026-11-19"); f.daily("2026-11-19"); f.daily("2026-12-04");
  assert.equal(f.titles(c).length, 1);
  // Chegou o próximo período: uma conta, mesmo com o alarme rodando duas vezes.
  f.daily("2026-12-05"); f.daily("2026-12-05");
  assert.deepEqual(f.titles(c).map((r) => r.due_on), ["2026-11-10", "2026-12-10"]);
  // A cobrança enviada pela pessoa fica marcada.
  const invoice = f.get(c).invoices.find((i) => i.period_start === "2026-12-05");
  const marked = f.rpc("erp_contract_invoice_mark", { p_command_id: randomUUID(), p_data: { id: invoice.id, action: "charge_sent" } }).invoice;
  assert.equal(marked.charge_status, "sent");
  const list = f.rpc("erp_contract_invoices", { p_args: { status: "charge_pending" } });
  assert.deepEqual(list.items.map((i) => i.period_start), ["2026-11-05"]);
  // Gerar à mão um período já faturado recusa.
  c = f.get(c);
  assert.throws(() => f.rpc("erp_contract_bill_now", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, period_start: "2026-12-05" } }), code("erp_contract_period_billed"));
  // À mão, o período seguinte sai antes do começo dele; o alarme depois não repete.
  const now = f.rpc("erp_contract_bill_now", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, period_start: "2027-01-05" } });
  assert.equal(now.invoice.due_on, "2027-01-10");
  assert.equal(now.contract.billing.next_period_on, "2027-02-05");
  f.daily("2027-01-05");
  assert.equal(f.titles(c).length, 3);
});

test("suspensão não cobra, reativação volta no período de hoje; encerrar pede motivo e para tudo", (t) => {
  const f = office(t);
  let c = f.status(f.save(f.base()), "activate");
  c = f.billing(c, { enabled: true }).contract;
  assert.equal(f.titles(c).length, 1);
  c = f.status(c, "suspend", { reason: "Cliente pediu pausa" });
  f.daily("2026-12-05"); f.daily("2027-01-05");
  assert.equal(f.titles(c).length, 1);
  f.clock.advance(60 * DAY); // hoje: 18/01/2027
  c = f.status(c, "resume");
  assert.equal(c.billing.next_period_on, "2027-01-05");
  f.daily("2027-01-18");
  assert.deepEqual(f.titles(c).map((r) => r.competence_on), ["2026-11-05", "2027-01-05"]);
  assert.throws(() => f.status(c, "end", { reason: "" }), code("erp_contract_reason_required"));
  c = f.status(f.get(c), "end", { reason: "Cliente encerrou a empresa" });
  assert.equal(c.status, "ended");
  f.daily("2027-02-05");
  assert.equal(f.titles(c).length, 2);
  assert.throws(() => f.save({ id: c.id, expected_version: c.version, notes: "x" }), code("erp_contract_not_editable"));
  assert.deepEqual(c.events.slice(0, 1).map((e) => e.kind), ["ended"]);
});

test("reajuste: aviso no mês de aniversário, índice informado na tabela, prévia, aplicação com histórico e aviso ao cliente", (t) => {
  const f = office(t);
  let c = f.status(f.save(f.base({ starts_on: "2025-03-01", adjustment: { index: "ipca", month: 3, notify: true } })), "activate");
  assert.equal(c.adjustment.next_month, "2026-03");
  let preview = f.rpc("erp_contract_adjust_preview", { p_args: { id: c.id } });
  assert.deepEqual([preview.month, preview.missing_rate, preview.effective_on], ["2026-03", true, "2026-03-01"]);
  // A rotina avisa o que falta.
  f.daily("2026-11-19");
  let notices = f.rpc("erp_contract_notices", { p_args: {} }).items;
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /Informe o IPCA de mar\/2026/);
  f.daily("2026-11-19");
  assert.equal(f.rpc("erp_contract_notices", { p_args: {} }).items.length, 1);
  assert.throws(() => f.rpc("erp_contract_adjust", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, month: "2026-03", percent: "4.56" } }), code("erp_contract_rate_missing"));
  f.rpc("erp_contract_rate_save", { p_command_id: randomUUID(), p_data: { index: "ipca", month: "2026-03", percent: "4,56" } });
  preview = f.rpc("erp_contract_adjust_preview", { p_args: { id: c.id } });
  assert.deepEqual([preview.percent, preview.before_cents, preview.after_cents], ["4.5600", 30000, 31368]);
  assert.throws(() => f.rpc("erp_contract_adjust", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, month: "2026-03", percent: "4.5" } }), code("erp_contract_rate_changed"));
  assert.throws(() => f.rpc("erp_contract_adjust", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, month: "2027-03", percent: "4.56" } }), code("erp_contract_adjustment_month_changed"));
  c = f.rpc("erp_contract_adjust", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, month: "2026-03", percent: "4.56" } }).contract;
  assert.deepEqual([c.amount_cents, c.adjustment.last_month, c.adjustment.next_month], [31368, "2026-03", "2027-03"]);
  assert.deepEqual(c.history_items.map((i) => [i.unit_cents, i.valid_until]), [[30000, "2026-02-28"]]);
  assert.equal(c.events[0].kind, "adjustment");
  assert.match(c.events[0].summary, /de R\$ 300,00 para R\$ 313,68/);
  notices = f.rpc("erp_contract_notices", { p_args: {} }).items;
  assert.deepEqual(notices.map((n) => n.kind), ["customer_adjustment"]);
  assert.match(notices[0].message, /passa de R\$ 300,00 para R\$ 313,68 a partir de 01\/03\/2026/);
  // Ainda não chegou março de 2027: o próximo reajuste não vale agora.
  f.rpc("erp_contract_rate_save", { p_command_id: randomUUID(), p_data: { index: "ipca", month: "2027-03", percent: "3" } });
  assert.throws(() => f.rpc("erp_contract_adjust", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, month: "2027-03", percent: "3" } }), code("erp_contract_adjustment_too_early"));
  // Percentual fixo não usa a tabela.
  const fixed = f.save(f.base({ starts_on: "2025-06-01", adjustment: { index: "fixed", percent: "10", month: 6 } }));
  assert.equal(f.rpc("erp_contract_adjust_preview", { p_args: { id: fixed.id } }).after_cents, 33000);
  assert.throws(() => f.save(f.base({ adjustment: { index: "fixed", month: 6 } })), code("erp_contract_invalid_percent"));
});

test("aditivo muda itens a partir de uma data (as faturas antes ficam); renovação avisa antes do fim e estende a vigência", (t) => {
  const f = office(t);
  let c = f.status(f.save(f.base({ ends_on: "2026-12-15", renewal_notice_days: 30 })), "activate");
  c = f.billing(c, { enabled: true }).contract;
  c = f.rpc("erp_contract_amend", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, effective_on: "2026-12-05",
    items: [{ product_id: f.service.id, unit_price: "350" }], reason: "Inclusão de mais duas máquinas" } }).contract;
  assert.deepEqual([c.amount_cents, c.scheduled_items.map((i) => i.unit_cents)], [30000, [35000]]);
  assert.equal(c.events[0].kind, "amendment");
  assert.throws(() => f.rpc("erp_contract_amend", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version, effective_on: "2026-11-20",
    items: [{ description: "x", unit_price: "1" }], reason: "Teste" } }), code("erp_contract_future_change"));
  f.daily("2026-12-05");
  assert.deepEqual(f.titles(c).map((r) => r.amount_cents), [30000, 35000]);
  // Depois do fim, não fatura.
  f.daily("2027-01-05");
  assert.equal(f.titles(c).length, 2);
  // O aviso de renovação saiu (30 dias antes de 15/12) uma vez só.
  const notices = f.rpc("erp_contract_notices", { p_args: {} }).items.filter((n) => n.kind === "renewal");
  assert.equal(notices.length, 1);
  c = f.get(c);
  c = f.rpc("erp_contract_renew", { p_command_id: randomUUID(), p_data: { id: c.id, expected_version: c.version } }).contract;
  assert.equal(c.ends_on, "2027-02-15"); // duração de 2 meses inteiros (05/10 a 15/12)
  assert.equal(c.notices.length, 0);
  assert.equal(c.events[0].kind, "renewal");
  // Com a vigência nova, o período de janeiro sai.
  f.daily("2027-01-05");
  assert.equal(f.titles(c).length, 3);
  const indefinite = f.status(f.save(f.base()), "activate");
  assert.throws(() => f.rpc("erp_contract_renew", { p_command_id: randomUUID(), p_data: { id: indefinite.id, expected_version: indefinite.version } }), code("erp_contract_indefinite"));
});

test("alarme: a rodada do agendador com a rotina dos contratos gera a conta do período uma vez, mesmo rodando de novo; com a parte desligada, pula", async (t) => {
  const f = office(t);
  let c = f.status(f.save(f.base()), "activate");
  c = f.billing(c, { enabled: true }).contract;
  const routine = ROUTINES.find((r) => r.id === "contracts.daily");
  const at = Date.parse("2026-12-05T10:00:00Z"); // 07:00 em São Paulo
  const round = (parts) => runRound(f.db, { routines: [routine], parts: normalizeErpParts(parts), now: () => at, clock: f.clock, yieldTurn: async () => {} });
  const first = await round();
  assert.deepEqual(first.routines, [{ id: "contracts.daily", status: "ok" }]);
  f.db.exec("UPDATE wb_routine SET next_run_us=? WHERE id='contracts.daily'", String(BigInt(at) * 1000n));
  await round();
  assert.deepEqual(f.titles(c).map((r) => r.competence_on), ["2026-11-05", "2026-12-05"]);
  f.db.exec("UPDATE wb_routine SET next_run_us=? WHERE id='contracts.daily'", String(BigInt(at) * 1000n));
  const off = await round({ contracts: false });
  assert.deepEqual(off.routines, [{ id: "contracts.daily", status: "skipped" }]);
});

test("papéis, repetição do comando, parte desligada e acervo do Bling ausente", (t) => {
  const f = office(t);
  const command = randomUUID();
  const first = f.rpc("erp_contract_save", { p_command_id: command, p_data: f.base() });
  const again = f.rpc("erp_contract_save", { p_command_id: command, p_data: f.base() });
  assert.deepEqual([first.replayed, again.replayed, again.contract.id], [false, true, first.contract.id]);
  assert.throws(() => f.rpc("erp_contract_save", { p_command_id: command, p_data: f.base({ object: "Outro" }) }), code("erp_contract_command_conflict"));
  assert.equal(f.rpc("erp_contract_list", { p_args: {} }, { role: "vendas" }).items.length, 1);
  assert.throws(() => f.save(f.base(), { role: "vendas" }), code("erp_contract_write_denied"));
  assert.throws(() => f.rpc("erp_contract_list", { p_args: {} }, { role: "fiscal" }), code("erp_contract_access_denied"));
  assert.throws(() => f.rpc("erp_contract_list", { p_args: {} }, { parts: { contracts: false } }), disabled);
  assert.throws(() => f.rpc("erp_contract_list", { p_args: {} }, { parts: { finance: false } }), disabled);
  assert.throws(() => f.save(f.base({ items: [] })), code("erp_contract_invalid_items"));
  assert.throws(() => f.save(f.base({ ends_on: "2026-01-01" })), code("erp_contract_invalid_period"));
  assert.throws(() => f.save(f.base({ periodicity: "weekly" })), code("erp_contract_invalid_periodicity"));
  const bling = f.rpc("erp_contract_bling_list", { p_args: {} });
  assert.deepEqual([bling.available, bling.items.length], [false, 0]);
});

test("Bling: prévia dos contratos do acervo e adoção como contrato de serviço em rascunho, uma vez só; o já adotado como manutenção não vira genérico", (t) => {
  const f = office(t);
  const now = Date.parse("2026-11-19T12:00:00Z");
  const hash = (text) => text.length.toString(16).padStart(64, "0");
  f.db.exec("INSERT INTO wb_bling_control(id,account_id,credential_status,updated_at) VALUES(1,'conta','ready',?)", now);
  const seed = (payload) => {
    f.db.exec("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES('contracts',?)", now);
    f.db.exec(`INSERT INTO wb_bling_extra_raw(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at,generation)
      VALUES('contracts',?,'contracts',?,?,1,?,?,?,1)`, payload.id, JSON.stringify(payload), hash(JSON.stringify(payload)), now, now, now);
  };
  seed({ id: "9701", numero: "15", descricao: "Manutenção do ar-condicionado", contato: { id: "301", nome: "Cliente Bling" }, dataInicio: "2026-01-01", dataFim: "2026-12-31", valor: "150.00", periodicidade: "Bimestral", situacao: "Ativo" });
  seed({ id: "9702", numero: "16", contato: { id: "302" } });
  seed({ id: "9703", numero: "17", contato: { id: "301" }, dataInicio: "2026-02-01", valor: "90.00", periodicidade: "Mensal" });
  f.db.exec("INSERT INTO wb_bling_adoption_link(entity,source_id,record_id,source_version,source_hash,mode,adopted_by,adopted_at) VALUES('contacts','301',?,1,?,'created',?,?)",
    f.customer.id, hash("contacts301"), f.people.admin.user_id, now);
  f.db.exec(`INSERT INTO wb_bling_adoption_extra_link(entity,source_id,record_id,source_version,source_hash,mode,erp_hash,data,adopted_by,adopted_at)
    VALUES('contracts','9703',?,1,?,'created',NULL,'{}',?,?)`, randomUUID(), hash("x"), f.people.admin.user_id, now);
  const list = f.rpc("erp_contract_bling_list", { p_args: {} });
  assert.equal(list.available, true);
  const [first, second, third] = list.items;
  assert.deepEqual([first.ready, first.periodicity, first.contact_id, first.amount_cents, first.due_day], [true, "bimonthly", f.customer.id, 15000, 1]);
  assert.equal(second.ready, false);
  assert.ok(second.problems.some((p) => /cliente deste contrato ainda não foi trazido/.test(p)));
  assert.ok(second.problems.some((p) => /início/.test(p)));
  assert.deepEqual([third.ready, third.maintenance], [false, true]);
  assert.throws(() => f.rpc("erp_contract_bling_adopt", { p_command_id: randomUUID(), p_data: { source_id: "9703", version: "1" } }), code("erp_contract_bling_maintenance"));
  assert.throws(() => f.rpc("erp_contract_bling_adopt", { p_command_id: randomUUID(), p_data: { source_id: "9701", version: "2" } }), code("erp_contract_bling_changed"));
  const c = f.rpc("erp_contract_bling_adopt", { p_command_id: randomUUID(), p_data: { source_id: "9701", version: "1" } }).contract;
  assert.deepEqual([c.status, c.origin, c.billing.enabled, c.periodicity, c.starts_on, c.ends_on, c.amount_cents, c.bling_source_id],
    ["draft", "bling", false, "bimonthly", "2026-01-01", "2026-12-31", 15000, "9701"]);
  assert.throws(() => f.rpc("erp_contract_bling_adopt", { p_command_id: randomUUID(), p_data: { source_id: "9701", version: "1" } }), code("erp_contract_bling_linked"));
  assert.equal(f.rpc("erp_contract_bling_list", { p_args: {} }).items[0].linked.contract_id, c.id);
});
