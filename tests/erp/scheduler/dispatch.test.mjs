// Agendador do ERP com relógio controlado (docs/ERP-AGENDADOR.md): o
// despachante sobre node:sqlite com as funções reais da plataforma (domínio
// Preferências). Date.now é trocado pelo relógio do teste (as funções da
// plataforma e o Clock do motor o leem); o orçamento usa um relógio de parede
// injetado.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { Clock } from "../../../src/erp/engine/time.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { runRound, taskErrorCode, TASK_HANDLERS } from "../../../src/erp/scheduler/dispatch.ts";
import { ROUTINES, nextHour, nextLocalTime, retentionStep } from "../../../src/erp/scheduler/routines.ts";
import { notificationDigest } from "../../../src/erp/domains/preferences/home-notifications.ts";

const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  MIN = 60_000;
const realNow = Date.now;
let now, db, lite, clock;
const at = (iso) => (now = Date.parse(iso));
const round = (extra = {}) =>
  runRound(db, { now: () => now, elapsed: () => 0, yieldTurn: async () => {}, clock, ...extra });
const tasks = () =>
  db.exec(`SELECT purpose, operation_id, status, CAST(attempts AS TEXT) attempts FROM "erp_platform__task" ORDER BY created_at, id`).rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
const routine = (id) => db.exec("SELECT CAST(next_run_us AS TEXT) next_run_us, last_status, runs, failures, last_error FROM wb_routine WHERE id=?", id).rows[0];
const nextRun = (id) => Number(BigInt(routine(id).next_run_us) / 1000n);

beforeEach(() => {
  lite = freshLite();
  db = nodeDriver(lite);
  clock = new Clock();
  at("2026-11-16T15:20:00Z");
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
  lite.close();
});

test("primeira rodada: gera a hora e o dia, roda as notificações; a limpeza espera o armazenamento", async () => {
  const r = await round();
  assert.deepEqual(
    r.routines.map((x) => [x.id, x.status]),
    [["platform.schedule", "ok"], ["retention", "ok"]],
  );
  assert.deepEqual(tasks(), [
    { purpose: "notifications_generate", operation_id: "notificacoes:2026-11-16T12", status: "done", attempts: 1 },
    { purpose: "export_cleanup", operation_id: "limpeza-exportacoes:2026-11-16", status: "queued", attempts: 0 },
  ]);
  assert.deepEqual(r.tasks.map((t) => [t.purpose, t.outcome]), [["notifications_generate", "done"]]);
  assert.equal(r.more, false);
  // A limpeza (sem executor) não acorda o alarme: a próxima acordada é a hora cheia.
  assert.equal(r.nextWake, Date.parse("2026-11-16T16:00:00Z"));
  assert.equal(nextRun("retention"), Date.parse("2026-11-17T06:10:00Z"), "03:10 em São Paulo (UTC-3)");
  // O mesmo agora de novo: nada vence, nada se repete.
  const again = await round();
  assert.deepEqual([again.routines, again.tasks], [[], []]);
  assert.equal(tasks().length, 2);
});

test("hora cheia: uma tarefa nova de notificações; a limpeza do dia é a mesma", async () => {
  await round();
  at("2026-11-16T16:00:00Z");
  const r = await round();
  assert.deepEqual(r.routines.map((x) => x.id), ["platform.schedule"]);
  assert.deepEqual(
    tasks().map((t) => t.operation_id),
    ["notificacoes:2026-11-16T12", "limpeza-exportacoes:2026-11-16", "notificacoes:2026-11-16T13"],
  );
  assert.equal(tasks()[2].status, "done");
});

test("três dias parado: cada rotina roda uma vez (sem enxurrada de horas) e volta ao horário", async () => {
  await round();
  at("2026-11-19T17:42:00Z");
  const r = await round();
  assert.deepEqual(r.routines.map((x) => [x.id, x.status]), [["platform.schedule", "ok"], ["retention", "ok"]]);
  const ops = tasks().map((t) => t.operation_id);
  assert.equal(ops.filter((o) => o.startsWith("notificacoes:")).length, 2, "a hora perdida não é recuperada");
  assert.ok(ops.includes("notificacoes:2026-11-19T14"));
  assert.ok(ops.includes("limpeza-exportacoes:2026-11-19"));
  assert.equal(nextRun("platform.schedule"), Date.parse("2026-11-19T18:00:00Z"));
  assert.equal(nextRun("retention"), Date.parse("2026-11-20T06:10:00Z"));
});

test("virada do dia em São Paulo e horário de verão antes de 2019", async () => {
  // 02:30 UTC de 17/11/2026 ainda é 16/11 em São Paulo.
  at("2026-11-17T02:30:00Z");
  await round();
  assert.deepEqual(tasks().map((t) => t.operation_id), ["notificacoes:2026-11-16T23", "limpeza-exportacoes:2026-11-16"]);
  // 04/11/2018: início do horário de verão (UTC-2); 03:10 local = 05:10 UTC, e no dia anterior 06:10 UTC.
  assert.equal(nextLocalTime(Date.parse("2018-11-03T07:00:00Z"), "03:10"), Date.parse("2018-11-04T05:10:00Z"));
  assert.equal(nextLocalTime(Date.parse("2018-11-03T05:00:00Z"), "03:10"), Date.parse("2018-11-03T06:10:00Z"));
  // Fim do horário de verão (17/02/2019): 03:10 volta a ser 06:10 UTC.
  assert.equal(nextLocalTime(Date.parse("2019-02-16T06:00:00Z"), "03:10"), Date.parse("2019-02-17T06:10:00Z"));
  assert.equal(nextHour(Date.parse("2018-11-04T03:30:00Z")), Date.parse("2018-11-04T04:00:00Z"));
  // Chave da hora no horário de verão: 03:30 UTC = 01:30 em São Paulo (a hora 00 não existiu).
  at("2018-11-04T03:30:00Z");
  db = nodeDriver((lite.close(), (lite = freshLite())));
  await round();
  assert.equal(tasks()[0].operation_id, "notificacoes:2018-11-04T01");
});

test("orçamento estourado: para entre unidades, grava partial e continua 1 s depois", async () => {
  let wall = 0;
  const ticking = () => wall;
  // Rotina de três unidades; cada unidade gasta 1,5 s do relógio de parede.
  let units = 0;
  const slow = { id: "teste.lento", block: "erp", next: nextHour, step: () => ((wall += 1500), ++units < 3 ? "more" : "done") };
  const r1 = await round({ routines: [slow], elapsed: ticking, budgetMs: 2000 });
  assert.equal(r1.more, true);
  assert.equal(r1.nextWake, now + 1000);
  assert.deepEqual(r1.routines, [{ id: "teste.lento", status: "partial" }]);
  assert.equal(routine("teste.lento").last_status, "partial");
  assert.equal(r1.tasks.length, 0, "sem orçamento a fila espera");
  now += 1000;
  const r2 = await round({ routines: [slow], elapsed: ticking, budgetMs: 2000 });
  assert.equal(units, 3);
  assert.deepEqual(r2.routines, [{ id: "teste.lento", status: "ok" }]);
  assert.equal(nextRun("teste.lento"), nextHour(now));
});

test("tarefa com arquivo criada na mesma rodada já conta como vencida (no milissegundo), sem ser tomada pela rodada", async () => {
  // O relógio do motor é monotônico em µs: a limpeza do dia nasce alguns µs
  // depois de `now`. Vencida no ms, ela vai para a acordada seguinte (1 s).
  const r = await round({ filePurposes: ["company_export", "export_cleanup"] });
  assert.equal(r.fileDue, true);
  assert.equal(tasks().find((t) => t.purpose === "export_cleanup").status, "queued", "a rodada não toma tarefa com arquivo");
  const none = await round({ filePurposes: [] });
  assert.equal(none.fileDue, false);
});

test("cede a vez entre as unidades (await de verdade entre transações)", async () => {
  const marks = [];
  let n = 0;
  const three = { id: "teste.tres", block: "erp", next: nextHour, step: () => (marks.push("unidade"), ++n < 3 ? "more" : "done") };
  await runRound(db, { now: () => now, elapsed: () => 0, clock, routines: [three], handlers: {}, yieldTurn: async () => void marks.push("cede") });
  assert.deepEqual(marks, ["unidade", "cede", "unidade", "cede", "unidade", "cede"]);
});

test("bloco desligado: rotina skipped, empurrada para o próximo horário; ligado, roda", async () => {
  let ran = 0;
  const fiscal = { id: "teste.fiscal", block: "erp-fiscal", next: nextHour, step: () => (ran++, "done") };
  const r = await round({ routines: [fiscal] });
  assert.deepEqual(r.routines, [{ id: "teste.fiscal", status: "skipped" }]);
  assert.equal(ran, 0);
  assert.equal(nextRun("teste.fiscal"), nextHour(now));
  now = nextHour(now);
  await round({ routines: [fiscal], blocks: { "erp-fiscal": true } });
  assert.equal(ran, 1);
});

test("rotina que falha: erro gravado, nova tentativa com backoff, o resto da rodada segue", async () => {
  const broken = { id: "teste.quebrada", block: "erp", next: nextHour, step: () => { throw new Error("falha sintética"); } };
  const r = await round({ routines: [broken, ROUTINES[0]] });
  assert.deepEqual(r.routines.map((x) => [x.id, x.status]), [["teste.quebrada", "error"], ["platform.schedule", "ok"]]);
  const row = routine("teste.quebrada");
  assert.deepEqual([row.last_status, Number(row.failures), row.last_error], ["error", 1, "falha sintética"]);
  assert.equal(nextRun("teste.quebrada"), now + 2 * MIN);
});

test("tarefa que falha volta com backoff; posse vencida conta tentativa e é retomada", async () => {
  const failing = { notifications_generate: () => { throw new Error("x"); } };
  await round({ routines: [ROUTINES[0]], handlers: failing });
  const [t] = tasks();
  assert.deepEqual([t.status, t.attempts], ["queued", 1]);
  const r = await round({ routines: [ROUTINES[0]], handlers: failing });
  assert.equal(r.tasks.length, 0, "o backoff de 2 min ainda não venceu");
  assert.ok(r.nextWake > now + 2 * MIN - 1000 && r.nextWake <= now + 2 * MIN + 1, "acorda na próxima tentativa, antes da hora cheia");
  // Uma posse tomada por fora e abandonada: vence em 5 min e volta.
  now = r.nextWake;
  callRpc(db, "erp_platform_task_claim", { p_lease: crypto.randomUUID(), p_purposes: ["notifications_generate"] }, clock);
  assert.equal(tasks()[0].status, "running");
  now += 5 * MIN + 1000;
  const back = await round({ routines: [ROUTINES[0]] });
  assert.deepEqual(back.tasks.map((x) => x.outcome), ["done"]);
  const history = db.exec(`SELECT outcome, error_code FROM "erp_platform__task_attempt" ORDER BY attempt`).rows;
  assert.deepEqual(history.map((h) => h.outcome), ["retry", "expired", "done"]);
  assert.equal(history[0].error_code, "ERP_TASK_ERROR");
  assert.equal(taskErrorCode(Object.assign(new Error(), { name: "Error" })), "ERP_TASK_ERROR");
});

test("retenção: só tarefa terminada há mais de 90 dias; exportação e command_receipt ficam; sem gatilho contra o DELETE", () => {
  const triggers = db.exec(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('erp_platform__task','erp_platform__task_attempt')`,
  ).rows;
  assert.deepEqual(triggers, [], "task_guard/attempt_guard são cumpridos em código, não por gatilho");
  const us = (ms) => String(BigInt(ms) * 1000n);
  const add = (id, status, finishedDaysAgo, purpose = "notifications_generate") => {
    const fin = finishedDaysAgo === null ? null : us(now - finishedDaysAgo * DAY);
    db.exec(
      `INSERT INTO "erp_platform__task"(id, purpose, operation_id, status, attempts, max_attempts, next_attempt_at, created_at, finished_at)
       VALUES (?,?,?,?,1,3,?,?,?)`,
      id,
      purpose,
      "op:" + id,
      status,
      us(now - 100 * DAY),
      us(now - 100 * DAY),
      fin,
    );
    db.exec(`INSERT INTO "erp_platform__task_attempt"(task_id, attempt, lease_token, started_at, finished_at, outcome) VALUES (?,1,?,?,?,?)`,
      id, crypto.randomUUID(), us(now - 100 * DAY), fin, finishedDaysAgo === null ? null : status === "done" ? "done" : "failed");
  };
  const ids = { velha: crypto.randomUUID(), falhou: crypto.randomUUID(), recente: crypto.randomUUID(), fila: crypto.randomUUID(), exportacao: crypto.randomUUID() };
  add(ids.velha, "done", 91);
  add(ids.falhou, "failed", 120);
  add(ids.recente, "done", 89);
  add(ids.fila, "queued", null);
  add(ids.exportacao, "done", 200, "company_export");
  db.exec(`INSERT INTO "erp_platform__export"(id, command_id, requested_by, task_id, created_at) VALUES (?,?,?,?,?)`,
    crypto.randomUUID(), "cmd-export", crypto.randomUUID(), ids.exportacao, us(now - 200 * DAY));
  // Recibos de comando (as tabelas *command de cada domínio, engine/receipt.ts) ficam de fora.
  const receipts = db.exec(`SELECT count(*) n FROM "erp_stock__command"`).rows[0].n;
  assert.equal(db.transaction(() => retentionStep({ db, clock, now })), "done");
  const left = new Set(db.exec(`SELECT id FROM "erp_platform__task"`).rows.map((r) => r.id));
  assert.deepEqual([ids.velha, ids.falhou].map((i) => left.has(i)), [false, false]);
  assert.deepEqual([ids.recente, ids.fila, ids.exportacao].map((i) => left.has(i)), [true, true, true]);
  assert.equal(db.exec(`SELECT count(*) n FROM "erp_platform__task_attempt" WHERE task_id IN (?,?)`, ids.velha, ids.falhou).rows[0].n, 0);
  assert.equal(db.exec(`SELECT count(*) n FROM "erp_stock__command"`).rows[0].n, receipts);
});

test("certificado A1 desligado até o Fiscal: tabelas existem, vazias, o digest dá zero e não quebra", () => {
  const today = "2026-11-16";
  const d = notificationDigest(db, "certificado_a1", today, BigInt(now + 31 * DAY) * 1000n);
  assert.equal(d.quantity, 0);
  assert.ok(TASK_HANDLERS.notifications_generate);
});
