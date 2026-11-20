// Restauração em etapas (src/erp/engine/backup-swap.ts): transações pequenas
// com checkpoint, área inteira parada durante a troca, queda no meio com
// retomada, ordem das chaves estrangeiras (referência da própria tabela fora
// da faixa, ciclo entre tabelas), conferência do fim e volta à marca da
// recuperação no tempo (falsa: cópia do banco, helpers.mjs) quando a troca
// não pode terminar. Relógio simulado; R2 em memória; nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDatabase, memoryBucket, fakeClock, seedRaw, snapshot, runToEnd } from "./helpers.mjs";
import {
  startBackup, startRestore, runBackupJob, restoreRollbackKey, ERP_OBJECT_DISK_LIMIT_BYTES,
} from "../../../src/erp/engine/backup-pages.ts";
import { RESTORE_SWAP_TXN_BYTES, RESTORE_SWAP_MAX_MS, restorePlan } from "../../../src/erp/engine/backup-swap.ts";
import {
  readBackupJob, backupJobStatus, restoreSwapping, restoreSwappingResponse, backupFence, ERP_RESTORE_SWAPPING_CODE, ERP_RESTORE_SWAPPING_MESSAGE,
} from "../../../src/erp/engine/backup-state.ts";
import { DUMP_TABLES, ALL_TABLES } from "../../../src/erp/engine/dump.ts";

const SOURCE = "area-origem", TARGET = "area-destino";
const COMPARED = DUMP_TABLES.filter(table => table !== "wb_bling_control");
const auxRows = db => Number(db.prepare("SELECT count(*) n FROM erp_meta WHERE key LIKE 'wb_backup_%' AND key <> 'wb_backup_job' OR key LIKE 'wb_restore_%'").get().n);
const triggers = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => ({ ...r }));

async function backupOf(source, bucket, clock) {
  startBackup(source.storage, SOURCE, { now: clock.now });
  const done = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
  assert.equal(done.job.phase, "done", JSON.stringify(done.job.error));
  return done.job.prefix;
}

/** Categorias em árvore com o pai DEPOIS do filho (rowid maior) e nomes longos: a tabela passa de vários pedaços do estágio. */
function seedForwardTree(db, n = 240) {
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys=ON");
  const insert = db.prepare("INSERT INTO erp_finance__category(id,name,kind,created_at,updated_at,parent_id) VALUES(?,?,'receivable',1,1,?)");
  for (let i = 0; i < n; i++) insert.run(`filho-${i}`, `Categoria filha ${i} ` + "x".repeat(2_000), `pai-${i}`);
  for (let i = 0; i < n; i++) insert.run(`pai-${i}`, `Categoria mãe ${i} ` + "y".repeat(2_000), null);
  db.exec("COMMIT");
}

/** Ciclo entre tabelas: a origem aponta a tentativa atual, a tentativa aponta a origem. */
function seedCycle(db, n = 300) {
  const origin = db.prepare("INSERT INTO origin_price_refresh__origin(source_id) VALUES(?)");
  const attempt = db.prepare(`INSERT INTO origin_price_refresh__attempt(id,source_id,owner,scheduler_fence,resource_fence,checkpoint_version,proposal_id,proposal_hash,proposal_version,product_hash,product_version,product_seen_at,document_links,started_at)
    VALUES(?,?,'dono','f','r',0,'p',?,1,'h',1,1,'[]',1)`);
  const link = db.prepare("UPDATE origin_price_refresh__origin SET current_attempt=? WHERE source_id=?");
  for (let i = 0; i < n; i++) {
    origin.run(`origem-${i}`);
    attempt.run(`tentativa-${i}`, `origem-${i}`, "z".repeat(1_500));
    link.run(`tentativa-${i}`, `origem-${i}`);
  }
}

/** Mede o texto gravado por transação externa: soma dos parâmetros dos INSERT/UPDATE da troca. */
function meterTransactions(storage) {
  const sizes = [];
  let depth = 0, current = 0;
  const exec = storage.sql.exec.bind(storage.sql), tx = storage.transactionSync.bind(storage);
  storage.sql.exec = (sql, ...params) => {
    if (depth && /^(INSERT INTO|UPDATE) "(?!erp_meta)/.test(sql)) for (const p of params) if (typeof p === "string") current += p.length;
    return exec(sql, ...params);
  };
  storage.transactionSync = fn => {
    if (depth++ === 0) current = 0;
    try { return tx(fn); } finally { if (--depth === 0 && current) sizes.push(current); }
  };
  return sizes;
}

test("plano da troca: pais antes dos filhos; ciclo com coluna anulável é completado depois; ciclo rígido numa transação", () => {
  const { storage, db } = freshDatabase();
  const plan = restorePlan(storage.sql);
  assert.deepEqual(plan.flatMap(g => g.tables).sort(), [...ALL_TABLES].sort(), "toda tabela entra uma vez");
  const position = new Map(plan.flatMap((g, i) => g.tables.map((t, j) => [t, [i, j]])));
  for (const group of plan) for (const table of group.tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      if (fk.table === table || group.fill[table]?.includes(fk.from) || group.atomic) continue;
      const [gc, tc] = position.get(table), [gp, tp] = position.get(fk.table);
      assert.ok(gp < gc || (gp === gc && tp < tc), `${fk.table} antes de ${table}`);
    }
  }
  const cycle = plan.find(g => g.tables.includes("origin_price_refresh__origin"));
  assert.deepEqual(cycle, { tables: ["origin_price_refresh__origin", "origin_price_refresh__attempt"], atomic: false, fill: { origin_price_refresh__origin: ["current_attempt"] } });
  assert.ok(plan.find(g => g.tables.includes("erp_sales_history__snapshot")).atomic, "as duas pontas obrigatórias: grupo numa transação");
});

test("troca em transações pequenas (até ~8 MiB de texto), várias invocações, igual ao backup; marca gravada antes da primeira", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 26_000, payload: 1_000 });
  seedCycle(source.db, 50);
  const prefix = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  seedRaw(target.db, { rows: 3_000, payload: 1_000, entity: "products" });
  const sizes = meterTransactions(target.storage);
  let blockedSeen = 0;
  const hooks = { at: (point, job) => { if (point === "swap:unit" && restoreSwapping(readBackupJob(target.storage))) blockedSeen++; } };
  await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, maxUnits: 2, hooks });
  assert.equal(end.job.phase, "done", JSON.stringify(end.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
  assert.equal(target.storage.bookmarks.taken.length, 1, "uma marca, antes da primeira transação da troca");
  assert.equal(target.storage.bookmarks.restored.length, 0);
  const big = sizes.filter(n => n > 1024 * 1024);
  assert.ok(big.length >= 3, `${big.length} transações grandes na troca`);
  // Um pedaço do estágio (256 K) e um lote (512 K) de folga sobre o orçamento.
  assert.ok(Math.max(...sizes) <= RESTORE_SWAP_TXN_BYTES + 768 * 1024, `maior transação: ${Math.max(...sizes)} bytes`);
  assert.ok(blockedSeen > 2, "área parada entre as transações da troca");
  assert.equal(auxRows(target.db), 0, "sem estágio, gatilhos guardados ou resto de linha");
  assert.deepEqual(triggers(target.db), triggers(source.db), "gatilhos de volta, iguais");
  assert.equal(restoreSwapping(readBackupJob(target.storage)), false, "área solta no fim");
});

test("referência da própria tabela fora da faixa e ciclo entre tabelas: a transação cresce ou completa depois; apagar também", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedForwardTree(source.db);
  seedCycle(source.db);
  const prefix = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  // O destino tem o mesmo desenho (filho antes do pai, ciclo), para a etapa de apagar.
  seedForwardTree(target.db, 120);
  seedCycle(target.db, 150);
  await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
  let fkRetries = 0;
  const tx = target.storage.transactionSync.bind(target.storage);
  target.storage.transactionSync = fn => { try { return tx(fn); } catch (error) { if (/FOREIGN KEY/.test(error.message)) fkRetries++; throw error; } };
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, swapTxnBytes: 2_048 });
  assert.equal(end.job.phase, "done", JSON.stringify(end.job.error));
  assert.ok(fkRetries > 0, "a referência caiu fora da faixa e a transação cresceu");
  assert.equal(target.storage.bookmarks.restored.length, 0);
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
  assert.equal(target.db.prepare("SELECT count(*) n FROM origin_price_refresh__origin WHERE current_attempt IS NULL").get().n, 0, "referência do ciclo completada");
  assert.deepEqual(target.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("queda no meio da troca: ao acordar continua de onde parou; entre uma e outra a área recusa leitura e escrita", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 4_000, payload: 1_000 });
  seedForwardTree(source.db, 60);
  const prefix = await backupOf(source, bucket, clock);
  for (const nth of [1, 4, 9]) {
    const target = freshDatabase();
    seedRaw(target.db, { rows: 500, payload: 400, entity: "products" });
    await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
    let units = 0;
    const crash = { at: point => { if (point === "swap:unit" && ++units === nth) throw new Error("queda simulada na troca"); } };
    await assert.rejects(runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, swapTxnBytes: 512 * 1024, hooks: crash }), /queda simulada/);
    const halfway = readBackupJob(target.storage);
    assert.equal(halfway.phase, "swap");
    assert.ok(restoreSwapping(halfway), "meio restaurado: área parada");
    assert.equal(backupJobStatus(halfway, clock.now()).job.blocked, true);
    const refused = restoreSwappingResponse();
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { code: ERP_RESTORE_SWAPPING_CODE, message: ERP_RESTORE_SWAPPING_MESSAGE, error: { code: ERP_RESTORE_SWAPPING_CODE, message: ERP_RESTORE_SWAPPING_MESSAGE } });
    assert.equal(ERP_RESTORE_SWAPPING_MESSAGE, "O ERP desta área está sendo restaurado. Volte em alguns minutos.");
    // Sem renovação, a barreira de escrita venceria; o bloqueio da troca não depende dela.
    clock.advance(10 * 60_000);
    assert.equal(backupFence(target.storage, clock.now()), null);
    assert.ok(restoreSwapping(readBackupJob(target.storage)), "bloqueio da troca sem prazo de barreira");
    const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, swapTxnBytes: 512 * 1024 });
    assert.equal(end.job.phase, "done", `${nth}: ${JSON.stringify(end.job.error)}`);
    assert.equal(target.storage.bookmarks.restored.length, 0, "a queda não volta à marca: retoma");
    assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED), `${nth}: igual ao backup`);
  }
});

/** Restauração que volta à marca: o banco fica como estava, o trabalho termina falho com o motivo. */
async function expectRollback(target, bucket, prefix, clock, options, code) {
  const before = snapshot(target.db, ALL_TABLES), beforeTriggers = triggers(target.db);
  const job = await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, ...options });
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, code, JSON.stringify(end.job.error));
  assert.match(end.job.error.message, /voltou ao estado de antes da restauração/);
  assert.equal(end.restarts, 1, "o objeto reiniciou uma vez");
  assert.equal(target.storage.bookmarks.restored.length, 1);
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before, "o banco como estava antes");
  assert.deepEqual(triggers(target.db), beforeTriggers);
  assert.equal(auxRows(target.db), 0, "estágio limpo");
  assert.equal(restoreSwapping(readBackupJob(target.storage)), false, "área solta");
  assert.equal(backupFence(target.storage, clock.now()), null);
  assert.ok(bucket.stored.has(restoreRollbackKey({ profile: TARGET, id: job.id })), "o motivo ficou registrado fora do objeto");
  return end;
}

test("conferência do fim que não bate (hash de uma tabela): volta à marca e o banco fica como estava", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 3_000, payload: 800 });
  const prefix = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  seedRaw(target.db, { rows: 200, payload: 300, entity: "products" });
  let tampered = false;
  // Uma linha muda depois de inserida (dado que não confere com o backup).
  const hooks = { at: (point, job) => {
    if (point !== "swap:unit" || tampered || job.cursor.swap?.step !== "verify") return;
    target.db.prepare("UPDATE origin_sync__raw_record SET version_hash='adulterado' WHERE rowid=(SELECT max(rowid) FROM origin_sync__raw_record)").run();
    tampered = true;
  } };
  await expectRollback(target, bucket, prefix, clock, { hooks, swapTxnBytes: 256 * 1024 }, "erp_restore_check_failed");
  assert.ok(tampered);
});

test("prazo da troca estourado e erro que se repete: voltam à marca (o erro de dado no meio está em paged.test.mjs)", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 3_000, payload: 800 });
  const prefix = await backupOf(source, bucket, clock);

  // Prazo: a troca começa e o relógio passa do prazo dela.
  {
    const target = freshDatabase();
    seedRaw(target.db, { rows: 100, payload: 200, entity: "products" });
    let units = 0;
    const hooks = { at: point => { if (point === "swap:unit" && ++units === 2) clock.advance(RESTORE_SWAP_MAX_MS + 1); } };
    await expectRollback(target, bucket, prefix, clock, { hooks, swapTxnBytes: 256 * 1024 }, "erp_restore_expired");
  }
  // Erro que se repete: a troca começa e o R2 cai; as invocações seguintes param no mesmo ponto.
  {
    const target = freshDatabase();
    seedRaw(target.db, { rows: 100, payload: 200, entity: "products" });
    const before = snapshot(target.db, ALL_TABLES);
    await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
    let units = 0;
    const realGet = bucket.get.bind(bucket);
    const down = async () => { throw new Error("R2 indisponível (simulado)"); };
    const hooks = { at: point => { if (point === "swap:unit" && ++units === 1) { bucket.get = down; throw new Error("R2 indisponível (simulado)"); } } };
    await assert.rejects(runBackupJob(target.storage, bucket, { now: clock.now, hooks, swapTxnBytes: 256 * 1024 }), /R2 indisponível/);
    for (let i = 0; i < 3; i++) await assert.rejects(runBackupJob(target.storage, bucket, { now: clock.now }), /R2 indisponível/);
    assert.ok(restoreSwapping(readBackupJob(target.storage)), "sem progresso, a área continua parada");
    bucket.get = realGet;
    const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now });
    assert.equal(end.job.phase, "failed");
    assert.equal(end.job.error.code, "erp_restore_failed");
    assert.match(end.job.error.message, /várias tentativas/);
    assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
  }
});

test("volta à marca que não se confirma: a área continua parada e o pedido de volta se repete", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 2_000, payload: 800 });
  const prefix = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
  const asked = [];
  // Ambiente sem volta de verdade: a marca é aceita, mas o reinício não traz o banco de volta.
  const bookmarks = { current: async () => "marca-x", restoreOnNextSession: async id => { asked.push(id); } };
  let units = 0;
  const hooks = { at: point => { if (point === "swap:unit" && ++units === 2) clock.advance(RESTORE_SWAP_MAX_MS + 1); } };
  // Uma invocação por chamada, como o alarme, até o pedido de volta (o objeto reiniciaria aqui).
  for (let i = 0; ; i++) {
    assert.ok(i < 200, "a troca não pediu a volta");
    try { if (!(await runBackupJob(target.storage, bucket, { now: clock.now, hooks, bookmarks, swapTxnBytes: 128 * 1024 })).more) assert.fail("terminou sem voltar"); }
    catch (error) { if (error?.code === "erp_restore_restart") break; throw error; }
  }
  // Reiniciou, mas o banco não voltou: o trabalho acorda em "rollback" e pede de novo.
  await assert.rejects(runBackupJob(target.storage, bucket, { now: clock.now, bookmarks }), { code: "erp_restore_restart" });
  const job = readBackupJob(target.storage);
  assert.equal(job.phase, "rollback");
  assert.equal(job.error.code, "erp_restore_expired");
  assert.ok(restoreSwapping(job), "nunca atende meio restaurada");
  assert.deepEqual(asked, ["marca-x", "marca-x"]);
  assert.equal(job.cursor.swap.rollbacks, 2);
});

test("sem a marca da recuperação no tempo, a troca não começa; disco insuficiente recusa antes de começar", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 1_500, payload: 800 });
  const prefix = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  seedRaw(target.db, { rows: 100, payload: 200, entity: "products" });
  const before = snapshot(target.db, ALL_TABLES);
  await startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now });
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, bookmarks: null });
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, "erp_restore_no_rollback");
  assert.match(end.job.error.message, /nada foi alterado/);
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
  assert.equal(auxRows(target.db), 0);
  // Disco: o banco atual mais o estágio não cabem no limite informado.
  await assert.rejects(startRestore(target.storage, bucket, TARGET, prefix, { now: clock.now, diskLimitBytes: 10 * 1024 * 1024 }), error => {
    assert.equal(error.code, "erp_restore_too_large");
    assert.equal(error.status, 413);
    assert.match(error.message, /não cabe no disco do ERP desta área/);
    assert.match(error.message, /Nada foi alterado/);
    return true;
  });
  assert.equal(readBackupJob(target.storage).phase, "failed", "nenhum trabalho novo");
  assert.ok(ERP_OBJECT_DISK_LIMIT_BYTES >= 10_000_000_000);
});
