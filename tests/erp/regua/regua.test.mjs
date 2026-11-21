// Régua de cobrança e contas recorrentes automáticas (versão 34;
// src/erp/domains/finance/dunning.ts e rpc/erp_finance_dunning.ts), com
// relógio simulado: os dias da régua vêm das preferências de Contas a
// receber; uma etapa por conta e canal, uma vez só; horário comercial e dia
// útil; conta paga ou cancelada sai da régua; posse vencida volta e, depois
// das tentativas, falha; a régua desligada não planeja nem toma nada; a
// recorrência automática gera a conta do período na data de emissão uma vez
// só (o alarme que repete não duplica) e, pedida, põe a cobrança na régua;
// a rotina é da parte Financeiro. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import {
  STAGE_GRACE_DAYS, currentStage, dunningStages, nextOpening, recurringAutoStep, stageLabel, withinHours,
} from "../../../src/erp/domains/finance/dunning.ts";
import { ROUTINES } from "../../../src/erp/scheduler/routines.ts";
import { runRound } from "../../../src/erp/scheduler/dispatch.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Meio-dia de São Paulo (15h UTC) do dia. */
const noon = (day) => Date.parse(`${day}T15:00:00.000Z`);
const CONFIG = { enabled: true, whatsapp: true, email: false, hour_from: 8, hour_to: 18, business_days: true };
const code = (c) => (e) => e.code === c || e.message === c;

function office(t, day = "2026-11-19") {
  const f = com1Fixture(t, { now: noon(day) });
  f.at = (when) => { f.clock.micros = BigInt(typeof when === "string" ? noon(when) : when) * 1000n; };
  // As preferências de Contas a receber, gravadas pela tela de Preferências (o administrador).
  f.prefs = (values) => f.rpc("erp_preferences_save", { p_command_id: randomUUID(), p_page: "financas-receber",
    p_changes: Object.entries(values).map(([key, value]) => ({ key, expected_version: 0, value })) });
  f.recurrence = (extra = {}) => f.rpc("erp_finance_recurrence_execute", {
    p_command_id: randomUUID(), p_action: "recurrence_create",
    p_data: { kind: "receivable", contact_id: f.customer.id, description: "Mensalidade de ensaio", issued_on: "2026-11-20", competence_on: "2026-11-01",
      due_on: "2026-11-25", amount_cents: "15000", frequency: "monthly", due_day: 25, ...extra },
  });
  f.round = (config = CONFIG, limit = 5, env) => f.rpc("erp_finance_dunning_round", { p_args: { config, limit } }, env);
  f.report = (id, outcome, reason = null) => f.rpc("erp_finance_dunning_report", { p_data: { id, outcome, reason } });
  f.overview = (config = CONFIG, env) => f.rpc("erp_finance_dunning_overview", { p_args: { config } }, env);
  f.steps = () => f.db.exec(`SELECT title_id, stage, channel, status, planned_on FROM "erp_finance__dunning_step" ORDER BY created_at`).rows;
  return f;
}

test("etapas: antes, no dia e depois; a última que chegou, por até três dias e nunca depois do começo da seguinte", () => {
  const rules = { before: 3, on_due: true, after: 5 };
  assert.deepEqual(dunningStages("2026-12-10", rules), [
    { stage: "before", planned_on: "2026-12-07" }, { stage: "due", planned_on: "2026-12-10" }, { stage: "after", planned_on: "2026-12-15" },
  ]);
  assert.equal(currentStage("2026-12-10", "2026-12-06", rules), null);
  assert.equal(currentStage("2026-12-10", "2026-12-07", rules).stage, "before");
  assert.equal(currentStage("2026-12-10", "2026-12-09", rules).stage, "before");
  assert.equal(currentStage("2026-12-10", "2026-12-10", rules).stage, "due");
  assert.equal(currentStage("2026-12-10", "2026-12-12", rules).stage, "due");
  assert.equal(currentStage("2026-12-10", "2026-12-13", rules), null, "a do dia vale três dias");
  assert.equal(currentStage("2026-12-10", "2026-12-15", rules).stage, "after");
  assert.equal(currentStage("2026-12-10", "2026-12-17", rules).stage, "after");
  assert.equal(currentStage("2026-12-10", "2026-12-18", rules), null);
  // Sem a do dia, o aviso de antes não sai no vencimento; o de depois começa no dia seguinte.
  assert.equal(currentStage("2026-12-10", "2026-12-09", { before: 1, on_due: false, after: 1 }).stage, "before");
  assert.equal(currentStage("2026-12-10", "2026-12-10", { before: 1, on_due: false, after: 1 }), null);
  assert.equal(currentStage("2026-12-10", "2026-12-11", { before: 1, on_due: false, after: 1 }).stage, "after");
  assert.deepEqual(dunningStages("2026-12-10", { before: 0, on_due: false, after: 0 }), []);
  assert.equal(stageLabel("before", "2026-12-07", "2026-12-10"), "3 dias antes do vencimento");
  assert.equal(stageLabel("after", "2026-12-11", "2026-12-10"), "1 dia depois do vencimento");
  assert.equal(STAGE_GRACE_DAYS, 3);
});

test("horário comercial em São Paulo, só dia útil (feriados nacionais), e a próxima abertura", () => {
  const cfg = { hour_from: 8, hour_to: 18, business_days: true };
  assert.equal(withinHours(Date.parse("2026-11-19T11:00:00Z"), cfg), true, "quinta, 8h em São Paulo");
  assert.equal(withinHours(Date.parse("2026-11-19T10:59:00Z"), cfg), false, "7h59");
  assert.equal(withinHours(Date.parse("2026-11-19T21:00:00Z"), cfg), false, "18h");
  assert.equal(withinHours(Date.parse("2026-11-20T15:00:00Z"), cfg), false, "Consciência Negra");
  assert.equal(withinHours(Date.parse("2026-11-21T15:00:00Z"), cfg), false, "sábado");
  assert.equal(withinHours(Date.parse("2026-11-21T15:00:00Z"), { ...cfg, business_days: false }), true);
  // Quinta 19h → sexta é feriado → segunda 8h.
  assert.equal(new Date(nextOpening(Date.parse("2026-11-19T22:00:00Z"), cfg)).toISOString(), "2026-11-23T11:00:00.000Z");
  const inside = Date.parse("2026-11-19T15:00:00Z");
  assert.equal(nextOpening(inside, cfg), inside);
});

test("régua: desligada não planeja; ligada, uma etapa por conta e canal, só no horário, e nunca duas vezes", (t) => {
  const f = office(t, "2026-11-23");
  f.prefs({ "financas.boletos_dias_antes": 2, "financas.boletos_no_vencimento": true, "financas.boletos_dias_apos": 3 });
  const created = f.recurrence(); // conta com vencimento em 25/11
  const title = created.title.id;
  assert.equal(created.title.due_on, "2026-11-25");

  // Dois dias antes (segunda, 23/11, meio-dia). Desligada: nada.
  let r = f.round({ ...CONFIG, enabled: false });
  assert.deepEqual([r.planned, r.claimed.length, f.steps().length], [0, 0, 0]);
  const preview = f.overview({ ...CONFIG, enabled: false });
  assert.equal(preview.today_items.length, 0);
  assert.deepEqual(preview.rules, { before: 2, on_due: true, after: 3, source: "preference", grace_days: 3 });
  // Prévia ligada: o que vai sair hoje.
  const on = f.overview();
  assert.deepEqual(on.today_items.map((i) => [i.title_id, i.stage, i.status]), [[title, "before", "planned"]]);

  // Fora do horário (7h): planeja, mas não toma.
  f.at(Date.parse("2026-11-23T10:00:00Z"));
  r = f.round();
  assert.deepEqual([r.planned, r.claimed.length, r.in_hours, r.waiting], [1, 0, false, 1]);
  assert.equal(r.next_opening, "2026-11-23T11:00:00.000Z");
  // No horário: toma uma vez; a rodada seguinte não planeja nem toma de novo.
  f.at("2026-11-23");
  r = f.round();
  assert.equal(r.planned, 0);
  assert.equal(r.claimed.length, 1);
  const step = r.claimed[0];
  assert.deepEqual([step.title_id, step.stage, step.channel, step.status, step.stage_label], [title, "before", "whatsapp", "sending", "2 dias antes do vencimento"]);
  assert.equal(step.contact.id, f.customer.id);
  assert.equal(f.round().claimed.length, 0);
  f.report(step.id, "sent");
  assert.equal(f.round().claimed.length, 0, "enviada não volta");
  assert.equal(f.overview().sent.length, 1);

  // No dia do vencimento: a etapa do dia; o envio falha (sem consentimento) e fica com o motivo.
  f.at("2026-11-25");
  r = f.round();
  assert.deepEqual(r.claimed.map((s) => s.stage), ["due"]);
  f.report(r.claimed[0].id, "failed", "O cliente não autorizou avisos de cobrança.");
  const view = f.overview();
  assert.deepEqual(view.not_sent.map((s) => [s.stage, s.status, s.reason]), [["due", "failed", "O cliente não autorizou avisos de cobrança."]]);
  assert.equal(f.round().claimed.length, 0, "falha não repete sozinha");
  // Mesmo com o alarme repetindo a rodada várias vezes no dia, cada etapa existe uma vez só.
  for (let i = 0; i < 3; i++) f.round();
  assert.equal(f.steps().length, 2);
});

test("régua: conta paga sai da régua; posse vencida volta e falha depois das tentativas; etapa velha não sai", (t) => {
  const f = office(t, "2026-11-25");
  f.prefs({ "financas.boletos_no_vencimento": true });
  const a = f.recurrence({ description: "Conta A" }).title, b = f.recurrence({ description: "Conta B" }).title;
  // Planeja fora do horário (as duas ficam a enviar).
  f.at(Date.parse("2026-11-25T23:00:00Z"));
  assert.equal(f.round().planned, 2);
  // A conta A é cancelada antes do envio: sai da régua com o motivo.
  f.db.exec(`UPDATE "erp_finance__title" SET cancelled=1 WHERE id=?`, a.id);
  f.at(Date.parse("2026-11-26T12:00:00Z")); // 9h do dia seguinte
  let r = f.round();
  assert.equal(r.tidy.cancelled, 1);
  assert.deepEqual(r.claimed.map((s) => s.title_id), [b.id]);
  assert.equal(f.overview().not_sent.find((s) => s.title_id === a.id).status, "cancelled");
  // Sem resposta de quem enviava: depois da posse, volta e é tomada de novo (até três tentativas).
  for (let attempt = 2; attempt <= 3; attempt++) {
    f.at(Date.parse("2026-11-26T12:00:00Z") + attempt * 11 * 60_000);
    r = f.round();
    assert.equal(r.tidy.released, 1);
    assert.equal(r.claimed[0].attempts, attempt);
  }
  f.at(Date.parse("2026-11-26T13:00:00Z"));
  r = f.round();
  assert.equal(r.tidy.failed, 1);
  assert.equal(r.claimed.length, 0);
  // "retry" devolve à fila enquanto houver tentativa.
  const c = f.recurrence({ description: "Conta C", due_on: "2026-11-26", issued_on: "2026-11-26", due_day: 26 }).title;
  r = f.round();
  assert.deepEqual(r.claimed.map((s) => s.title_id), [c.id]);
  f.report(r.claimed[0].id, "retry", "A linha estava ocupada.");
  assert.equal(f.round().claimed[0].attempts, 2);
  // Etapa que ficou na fila desligada por mais de três dias não sai mais.
  const d = f.recurrence({ description: "Conta D", due_on: "2026-11-27", issued_on: "2026-11-27", due_day: 27 }).title;
  f.at(Date.parse("2026-11-27T23:00:00Z"));
  f.round();
  f.at("2026-12-01");
  r = f.round({ ...CONFIG, enabled: false });
  assert.ok(r.tidy.skipped >= 1);
  assert.equal(f.db.exec(`SELECT status FROM "erp_finance__dunning_step" WHERE title_id=?`, d.id).rows[0].status, "skipped");
});

test("régua: os dias da própria régua valem sobre as preferências; em branco, vale a preferência", (t) => {
  const f = office(t, "2026-11-23");
  f.prefs({ "financas.boletos_dias_antes": 2 });
  const title = f.recurrence().title; // vence em 25/11
  // Dois dias antes: a preferência manda o aviso; a régua com "0 dias antes" não.
  assert.deepEqual(f.overview().today_items.map((i) => i.stage), ["before"]);
  assert.deepEqual(f.overview({ ...CONFIG, before: 0 }).today_items, []);
  const own = f.overview({ ...CONFIG, before: 0, on_due: true });
  assert.deepEqual([own.rules.source, own.rules.before, own.rules.on_due, own.rules.after], ["regua", 0, true, 0]);
  assert.deepEqual([own.preference_rules.before, own.preference_rules.source], [2, "preference"]);
  // No vencimento, só com a régua marcando o dia (a preferência não marca).
  f.at("2026-11-25");
  assert.equal(f.round().claimed.length, 0);
  assert.deepEqual(f.round({ ...CONFIG, on_due: true }).claimed.map((s) => [s.title_id, s.stage]), [[title.id, "due"]]);
  assert.throws(() => f.round({ ...CONFIG, before: 400 }), code("erp_dunning_invalid_config"));
});

test("régua: papéis e parte desligada", (t) => {
  const f = office(t);
  assert.throws(() => f.round(CONFIG, 5, { role: "consulta" }), code("erp_finance_access_denied"));
  assert.equal(f.overview(CONFIG, { role: "consulta" }).can_write, false);
  assert.throws(() => f.overview(CONFIG, { role: "vendas" }), code("erp_finance_access_denied"));
  assert.throws(() => f.round(CONFIG, 5, { parts: { finance: false } }), (e) => e.code === "module_disabled");
  assert.throws(() => f.round({ ...CONFIG, hour_to: 8 }), code("erp_dunning_invalid_config"));
  assert.throws(() => f.round({ ...CONFIG, extra: 1 }), code("erp_dunning_invalid_config"));
});

test("recorrência automática: gera na data de emissão, uma vez por período, e põe a cobrança na régua quando pedida", (t) => {
  const f = office(t, "2026-11-19");
  const created = f.recurrence({ issued_on: "2026-11-20", due_on: "2026-11-25" }); // emissão 5 dias antes do vencimento
  const rec = created.record;
  assert.equal(rec.next_on, "2026-12-25");
  assert.throws(() => f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: false, send_charge: true } }), code("erp_dunning_send_requires_auto"));
  assert.throws(() => f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: true } }, { role: "consulta" }), code("erp_finance_access_denied"));
  const set = f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: true, send_charge: true } });
  assert.deepEqual([set.item.auto_generate, set.item.send_charge], [true, true]);
  const titles = () => f.db.exec(`SELECT due_on FROM "erp_finance__title" WHERE recurrence_id=? ORDER BY due_on`, rec.id).rows.map((r) => r.due_on);
  const step = (day) => f.transaction((ctx) => recurringAutoStep(ctx, day));

  // Antes da emissão (20/12): nada.
  step("2026-12-19");
  assert.deepEqual(titles(), ["2026-11-25"]);
  // Na emissão: a conta de 25/12, uma vez só, mesmo com o alarme repetindo.
  f.at("2026-12-20");
  step("2026-12-20"); step("2026-12-20"); step("2026-12-21");
  assert.deepEqual(titles(), ["2026-11-25", "2026-12-25"]);
  const list = f.rpc("erp_finance_recurrence_auto_list", { p_args: {} });
  assert.equal(list.items[0].last_run.outcome, "generated");
  assert.equal(list.runs.length, 1);
  assert.equal(f.rpc("erp_finance_recurrence_get", { p_id: rec.id }).record.next_on, "2027-01-25");
  // A cobrança da conta nova entra na régua (etapa "issue"), e sai mesmo sem os dias da régua configurados.
  const steps = f.steps();
  assert.deepEqual(steps.map((s) => [s.stage, s.status, s.planned_on]), [["issue", "pending", "2026-12-20"]]);
  f.at(Date.parse("2026-12-21T15:00:00Z"));
  assert.deepEqual(f.round().claimed.map((s) => [s.stage, s.origin, s.stage_label]), [["issue", "recurrence", "Conta nova da recorrência"]]);

  // Desmarcada: o alarme não gera mais.
  f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: false } });
  step("2027-01-25");
  assert.equal(titles().length, 2);
  // Inativa não gera, mesmo marcada.
  f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: true } });
  const fresh = f.rpc("erp_finance_recurrence_get", { p_id: rec.id }).record;
  f.rpc("erp_finance_recurrence_execute", { p_command_id: randomUUID(), p_action: "recurrence_set_active", p_data: { id: rec.id, expected_version: fresh.version, active: false } });
  step("2027-01-25");
  assert.equal(titles().length, 2);
});

test("recorrência automática: falha fica registrada uma vez por período, sem travar as outras", (t) => {
  const f = office(t, "2026-11-19");
  const good = f.recurrence({ description: "Boa" }).record, bad = f.recurrence({ description: "Ruim" }).record;
  for (const r of [good, bad]) f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: r.id, auto_generate: true } });
  // A "Ruim" aponta para um contato que não existe mais: a conta dela não entra (a do período fica como falha).
  f.db.exec("PRAGMA foreign_keys=OFF");
  f.db.exec(`UPDATE "erp_finance__recurrence" SET contact_id=? WHERE id=?`, randomUUID(), bad.id);
  f.db.exec("PRAGMA foreign_keys=ON");
  const more = f.transaction((ctx) => recurringAutoStep(ctx, "2026-12-20"));
  assert.equal(more, false);
  const runs = f.rpc("erp_finance_recurrence_auto_list", { p_args: {} }).runs;
  assert.deepEqual(runs.map((r) => [r.description, r.outcome]).sort(), [["Boa", "generated"], ["Ruim", "failed"]]);
  assert.ok(runs.find((r) => r.outcome === "failed").reason);
  // O alarme seguinte não tenta de novo o mesmo período.
  assert.equal(f.transaction((ctx) => recurringAutoStep(ctx, "2026-12-21")), false);
});

test("rotina: registrada na parte Financeiro e rodada pelo despachante com o relógio simulado", async (t) => {
  const routine = ROUTINES.find((r) => r.id === "finance.recurring");
  assert.equal(routine?.block, "erp-financeiro");
  assert.equal(new Date(routine.next(Date.parse("2026-11-19T12:00:00Z"))).toISOString(), "2026-11-20T09:40:00.000Z");
  const f = office(t, "2026-11-19");
  const rec = f.recurrence().record;
  f.rpc("erp_finance_recurrence_auto_set", { p_data: { id: rec.id, auto_generate: true } });
  const at = Date.parse("2026-12-20T09:40:00Z");
  const report = await runRound(f.db, { now: () => at, parts: normalizeErpParts(), routines: [routine], handlers: {}, clock: f.clock, yieldTurn: async () => {} });
  assert.deepEqual(report.routines.map((r) => [r.id, r.status]), [["finance.recurring", "ok"]]);
  assert.equal(f.db.exec(`SELECT count(*) n FROM "erp_finance__title" WHERE recurrence_id=?`, rec.id).rows[0].n, 2);
  // Financeiro desligado: a rotina fica de lado.
  const off = await runRound(f.db, { now: () => at + DAY, parts: normalizeErpParts({ finance: false }), routines: [routine], handlers: {}, clock: f.clock, yieldTurn: async () => {} });
  assert.deepEqual(off.routines.map((r) => r.status), ["skipped"]);
});
