// Backup e restauração em páginas (src/erp/engine/backup-pages.ts): ida e
// volta com banco pequeno e acima do antigo teto de 16 MiB, queda em cada
// etapa com retomada, retrato consistente com escrita chegando no meio,
// backup do formato 1, restauração recusada com XML em voo, troca tudo ou
// nada e memória de pico independente do tamanho. Relógio simulado; R2 em
// memória; nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freshDatabase, memoryBucket, fakeClock, seedRaw, snapshot, runToEnd } from "./helpers.mjs";
import {
  startBackup, startRestore, runBackupJob, readManifest, ErpBackupJobError, ERP_RESTORE_SWAP_LIMIT_BYTES,
  BACKUP_PART_TARGET_BYTES, BACKUP_STORAGE_NOTE,
} from "../../../src/erp/engine/backup-pages.ts";
import {
  backupFence, fencedWrite, ErpBackupFencedError, readBackupJob, backupJobStatus, BACKUP_BARRIER_LEASE_MS, BACKUP_BARRIER_MAX_MS,
} from "../../../src/erp/engine/backup-state.ts";
import { dumpAll, backupToR2, DUMP_TABLES, ALL_TABLES, ErpRestoreBusyError, ERP_LOGICAL_BACKUP_LIMIT_BYTES } from "../../../src/erp/engine/dump.ts";
import { markXmlObjectDelete } from "../../../src/erp/bling/xml.ts";
import { ERP_BACKUP_OPERATIONS } from "../../../src/erp/engine/backup-operations.ts";

const PROFILE = "area-backup";
/** wb_bling_control muda de propósito na restauração (revisões avançam, coleta desligada). */
const COMPARED = DUMP_TABLES.filter(table => table !== "wb_bling_control");
const manifestOf = (bucket, prefix) => JSON.parse(new TextDecoder().decode(bucket.stored.get(prefix + "manifest.json").bytes));
const keysUnder = (bucket, prefix) => [...bucket.stored.keys()].filter(key => key.startsWith(prefix)).sort();
const auxRows = db => Number(db.prepare("SELECT count(*) n FROM erp_meta WHERE key LIKE 'wb_backup_part:%' OR key LIKE 'wb_backup_table:%' OR key LIKE 'wb_restore_chunk:%'").get().n);
const rawCount = db => Number(db.prepare("SELECT count(*) n FROM origin_sync__raw_record").get().n);

async function backupOf(source, bucket, clock, options = {}) {
  startBackup(source.storage, PROFILE, { now: clock.now });
  const done = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now, ...options });
  assert.equal(done.job.phase, "done", JSON.stringify(done.job.error));
  return done;
}

async function restoreInto(target, bucket, prefix, clock, options = {}) {
  await startRestore(target.storage, bucket, "area-destino", prefix, { now: clock.now });
  return runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, ...options });
}

test("ida e volta com banco pequeno: formato 2, tabelas iguais às do formato 1, partes conferidas", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 300 });
  // Coleta ligada e credencial pronta na origem: não podem voltar assim.
  source.db.prepare(`INSERT INTO wb_bling_control(revision,credential_revision,collect_enabled,state,approved_by,approved_at,approval_hash,app_configured,credential_status,updated_at)
    VALUES(1,1,1,'running','administrator',1,?,1,'ready',1)`).run("a".repeat(64));
  const done = await backupOf(source, bucket, clock);
  const manifest = manifestOf(bucket, done.job.prefix);
  assert.equal(manifest.format, 2);
  assert.deepEqual(manifest.tables, dumpAll(source.storage).manifest.tables, "mesmo hash por tabela que o formato 1");
  assert.equal(manifest.parts.length, manifest.totals.parts);
  assert.deepEqual(keysUnder(bucket, done.job.prefix), [...manifest.parts.map(p => done.job.prefix + p.key), done.job.prefix + "manifest.json"].sort(), "nenhuma parte órfã");
  for (const part of manifest.parts) for (const field of ["table", "seq", "index", "key", "rows", "bytes", "text_bytes", "sha256"]) assert.ok(field in part, field);
  assert.equal(manifest.external_objects.included, false);
  assert.equal(manifest.external_objects.note, BACKUP_STORAGE_NOTE);
  for (const secret of ["origin_sync__credentials", "origin_sync__oauth_state"]) assert.ok(!manifest.tables.some(t => t.table === secret));
  assert.equal(readManifest(JSON.stringify(manifest)).parts.length, manifest.parts.length);
  assert.equal(backupFence(source.storage, clock.now()), null, "barreira solta no fim");
  assert.equal(auxRows(source.db), 0, "sem linhas auxiliares depois do fim");
  const target = freshDatabase();
  const restored = await restoreInto(target, bucket, done.job.prefix, clock);
  assert.equal(restored.job.phase, "done", JSON.stringify(restored.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
  assert.equal(auxRows(target.db), 0);
  const control = target.db.prepare("SELECT collect_enabled,state,credential_status,approved_by FROM wb_bling_control").get();
  assert.deepEqual({ ...control }, { collect_enabled: 0, state: "off", credential_status: "missing", approved_by: null });
});

test("banco acima do antigo teto de 16 MiB: várias partes e invocações, ida e volta igual", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 18_000, payload: 1_000 });
  // Poucas unidades por invocação: o trabalho atravessa várias acordadas.
  const done = await backupOf(source, bucket, clock, { maxUnits: 4 });
  assert.ok(done.job.progress.text_bytes > ERP_LOGICAL_BACKUP_LIMIT_BYTES, `exportou ${done.job.progress.text_bytes} bytes`);
  assert.ok(done.invocations > 3, `${done.invocations} invocações`);
  const manifest = manifestOf(bucket, done.job.prefix);
  const raw = manifest.parts.filter(p => p.table === "origin_sync__raw_record");
  assert.ok(raw.length >= 16, `${raw.length} partes da tabela grande`);
  assert.ok(raw.every(p => p.text_bytes <= BACKUP_PART_TARGET_BYTES + 4096), "partes de ~1 MiB");
  assert.deepEqual(raw.map(p => p.index), raw.map((_, i) => i));
  const target = freshDatabase();
  const restored = await restoreInto(target, bucket, done.job.prefix, clock, { maxUnits: 4 });
  assert.equal(restored.job.phase, "done", JSON.stringify(restored.job.error));
  assert.ok(restored.invocations > 3);
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
  assert.deepEqual(dumpAll(target.storage, 1e12).manifest.tables.filter(t => t.table !== "wb_bling_control"), manifest.tables.filter(t => t.table !== "wb_bling_control"));
});

test("queda em cada etapa do backup: retoma do checkpoint sem repetir nem pular parte", async () => {
  const clock = fakeClock(), source = freshDatabase();
  seedRaw(source.db, { rows: 5_000, payload: 1_000 });
  for (const [point, nth] of [["export:after-put", 1], ["export:after-put", 3], ["publish:after-put", 1]]) {
    const bucket = memoryBucket();
    startBackup(source.storage, PROFILE, { now: clock.now });
    let hits = 0;
    const crash = { at: name => { if (name === point && ++hits === nth) throw new Error(`queda simulada em ${point}`); } };
    await assert.rejects(runBackupJob(source.storage, bucket, { now: clock.now, hooks: crash }), /queda simulada/);
    const halfway = readBackupJob(source.storage);
    assert.ok(["export", "publish"].includes(halfway.phase), "trabalho continua ativo depois da queda");
    if (point === "export:after-put") {
      assert.ok(!bucket.stored.has(halfway.prefix + "manifest.json"), "sem manifesto antes do fim");
      assert.ok(backupFence(source.storage, clock.now()), "barreira continua durante a queda");
    }
    // Retomada (o alarme): uma instância nova lê o checkpoint durável.
    clock.advance(5_000);
    const done = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
    assert.equal(done.job.phase, "done", `${point}: ${JSON.stringify(done.job.error)}`);
    const manifest = manifestOf(bucket, done.job.prefix);
    assert.deepEqual(manifest.parts.map(p => p.seq), manifest.parts.map((_, i) => i), `${point}: ordem contínua`);
    assert.deepEqual(manifest.tables, dumpAll(source.storage, 1e12).manifest.tables, `${point}: retrato igual`);
    assert.deepEqual(keysUnder(bucket, done.job.prefix), [...manifest.parts.map(p => done.job.prefix + p.key), done.job.prefix + "manifest.json"].sort(), `${point}: parte órfã reaproveitada`);
    const target = freshDatabase();
    assert.equal((await restoreInto(target, bucket, done.job.prefix, clock)).job.phase, "done");
    assert.equal(rawCount(target.db), 5_000);
  }
  // Erro do R2 numa gravação: o checkpoint não anda; a próxima invocação repete só aquela parte.
  const bucket = memoryBucket();
  startBackup(source.storage, PROFILE, { now: clock.now });
  let failures = 0;
  bucket.failPut = key => key.includes("origin_sync__raw_record.00002") && failures++ === 0;
  await assert.rejects(runBackupJob(source.storage, bucket, { now: clock.now }), /R2 indisponível/);
  bucket.failPut = null;
  const done = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
  assert.equal(done.job.phase, "done");
  assert.equal(bucket.puts.filter(key => key.endsWith("origin_sync__raw_record.00001.ndjson.gz")).length, 1, "parte já confirmada não é refeita");
});

test("backup interrompido sem retomada: prazo da barreira cai, partes órfãs são limpas, sem manifesto", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 4_000, payload: 1_000 });
  const job = startBackup(source.storage, PROFILE, { now: clock.now });
  await runBackupJob(source.storage, bucket, { now: clock.now, maxUnits: 2 });
  assert.ok(keysUnder(bucket, job.prefix).length > 0);
  assert.ok(backupFence(source.storage, clock.now()));
  // Ninguém retomou dentro do prazo renovável: a barreira já caiu sozinha.
  clock.advance(BACKUP_BARRIER_LEASE_MS + 1);
  assert.equal(backupFence(source.storage, clock.now()), null, "escritas voltam mesmo sem ninguém limpar");
  // Queda também no meio da limpeza: a retomada continua apagando.
  const crash = { at: name => { if (name === "cleanup:after-delete") throw new Error("queda simulada na limpeza"); } };
  await assert.rejects(runBackupJob(source.storage, bucket, { now: clock.now, hooks: crash }), /queda simulada/);
  assert.equal(readBackupJob(source.storage).phase, "cleanup");
  const end = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, "erp_backup_expired");
  assert.deepEqual(keysUnder(bucket, job.prefix), [], "partes órfãs limpas");
  assert.equal(auxRows(source.db), 0);
  // Um backup novo começa do zero, noutro prefixo.
  clock.advance(1_000);
  const again = await backupOf(source, bucket, clock);
  assert.notEqual(again.job.prefix, job.prefix);
});

test("prazo absoluto da barreira: com progresso lento demais, o trabalho falha e solta as escritas", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 45_000, payload: 1_000 });
  const job = startBackup(source.storage, PROFILE, { now: clock.now });
  // Uma unidade a cada quase 2 min: o prazo renovável nunca vence, mas o absoluto sim.
  let units = 0;
  while (clock.now() - job.started_at <= BACKUP_BARRIER_MAX_MS) {
    const result = await runBackupJob(source.storage, bucket, { now: clock.now, maxUnits: 1 });
    assert.equal(result.more, true, "ainda havia partes quando o prazo absoluto venceu");
    assert.ok(backupFence(source.storage, clock.now()), "barreira em vigor enquanto há progresso");
    units++;
    clock.advance(BACKUP_BARRIER_LEASE_MS - 1);
  }
  assert.ok(units >= 30);
  assert.equal(backupFence(source.storage, clock.now()), null, "passado o prazo absoluto, as escritas voltam");
  const end = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, "erp_backup_expired");
  assert.deepEqual(keysUnder(bucket, job.prefix), []);
});

test("retrato de um instante: escrita no meio do backup é recusada inteira e não aparece pela metade", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 6_000, payload: 1_000 });
  const before = rawCount(source.db);
  const firstName = source.db.prepare("SELECT json_extract(payload,'$.nome') n FROM origin_sync__raw_record WHERE source_id='0000000001'").get().n;
  startBackup(source.storage, PROFILE, { now: clock.now });
  await runBackupJob(source.storage, bucket, { now: clock.now, maxUnits: 3 });
  const fence = backupFence(source.storage, clock.now());
  assert.equal(fence.code, "erp_backup_running");
  // Uma escrita de duas tabelas (como um RPC) chega entre duas páginas.
  const write = () => {
    source.db.prepare("UPDATE origin_sync__raw_record SET payload=json_object('nome','alterado') WHERE source_id='0000000001'").run();
    seedRaw(source.db, { rows: 10, offset: 900_000 });
    return "gravou";
  };
  assert.throws(() => fencedWrite(source.storage, fence, write), error => error instanceof ErpBackupFencedError && error.code === "erp_backup_running" && error.status === 503);
  assert.equal(rawCount(source.db), before, "nada gravado: a transação foi desfeita");
  // Leitura passa.
  assert.equal(fencedWrite(source.storage, fence, () => rawCount(source.db)), before);
  const done = await runToEnd(runBackupJob, source.storage, bucket, { now: clock.now });
  assert.equal(backupFence(source.storage, clock.now()), null);
  // Depois do backup a mesma escrita entra.
  assert.equal(fencedWrite(source.storage, backupFence(source.storage, clock.now()), write), "gravou");
  const target = freshDatabase();
  await restoreInto(target, bucket, done.job.prefix, clock);
  assert.equal(rawCount(target.db), before, "o retrato não tem a escrita posterior");
  assert.equal(target.db.prepare("SELECT json_extract(payload,'$.nome') n FROM origin_sync__raw_record WHERE source_id='0000000001'").get().n, firstName);
  assert.notEqual(firstName, "alterado");
  // Quem pediu vê o progresso e quanto tempo as escritas ficaram retidas.
  const status = backupJobStatus(done.job, clock.now()).job;
  assert.equal(status.percent, 100);
  assert.equal(status.barrier.active, false);
  assert.ok(status.barrier.held_ms >= 0);
});

test("queda em cada etapa da restauração: conferência retoma; troca é tudo ou nada", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 4_000, payload: 1_000 });
  const done = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  seedRaw(target.db, { rows: 50, payload: 100, entity: "products" });
  const original = snapshot(target.db, ALL_TABLES);
  for (const [point, nth] of [["stage:after-chunks", 1], ["stage:after-chunks", 7], ["swap:before", 1], ["swap:after", 1]]) {
    const db = freshDatabase();
    seedRaw(db.db, { rows: 50, payload: 100, entity: "products" });
    const own = snapshot(db.db, ALL_TABLES);
    await startRestore(db.storage, bucket, "area-destino", done.job.prefix, { now: clock.now });
    let hits = 0;
    const crash = { at: name => { if (name === point && ++hits === nth) throw new Error(`queda simulada em ${point}`); } };
    await assert.rejects(runBackupJob(db.storage, bucket, { now: clock.now, hooks: crash }), /queda simulada/);
    if (point !== "swap:after") {
      assert.deepEqual(snapshot(db.db, ALL_TABLES), own, `${point}: banco ainda como estava`);
      assert.ok(backupFence(db.storage, clock.now()).code === "erp_restore_running");
    }
    clock.advance(1_000);
    const end = await runToEnd(runBackupJob, db.storage, bucket, { now: clock.now });
    assert.equal(end.job.phase, "done", `${point}: ${JSON.stringify(end.job.error)}`);
    assert.deepEqual(snapshot(db.db, COMPARED), snapshot(source.db, COMPARED), `${point}: igual ao backup`);
    assert.equal(auxRows(db.db), 0);
  }
  // Falha no meio da transação da troca: o banco fica exatamente como estava.
  let inserts = 0;
  const realExec = target.storage.sql.exec.bind(target.storage.sql);
  target.storage.sql.exec = (sql, ...params) => {
    if (/^INSERT INTO "origin_sync__raw_record"/.test(sql) && ++inserts === 3) throw new Error("falha simulada no meio da troca");
    return realExec(sql, ...params);
  };
  await startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now });
  const failed = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now });
  assert.equal(failed.job.phase, "failed");
  assert.equal(failed.job.error.code, "erp_restore_failed");
  assert.deepEqual(snapshot(target.db, ALL_TABLES), original, "tudo ou nada: nada mudou");
  assert.equal(auxRows(target.db), 0, "estágio limpo");
  assert.equal(backupFence(target.storage, clock.now()), null, "barreira solta");
  target.storage.sql.exec = realExec;
  assert.equal((await restoreInto(target, bucket, done.job.prefix, clock)).job.phase, "done");
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});

test("restauração confere hash e contagem de cada parte antes de aplicar", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 3_000, payload: 1_000 });
  const done = await backupOf(source, bucket, clock);
  const manifest = manifestOf(bucket, done.job.prefix);
  const victim = manifest.parts.find(p => p.table === "origin_sync__raw_record" && p.index === 1);
  // Parte trocada por outra válida (gzip íntegro, conteúdo diferente).
  const other = manifest.parts.find(p => p.table === "origin_sync__raw_record" && p.index === 2);
  bucket.stored.set(done.job.prefix + victim.key, bucket.stored.get(done.job.prefix + other.key));
  const target = freshDatabase();
  const before = snapshot(target.db, ALL_TABLES);
  const end = await restoreInto(target, bucket, done.job.prefix, clock);
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, "erp_backup_part_corrupt");
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
  // Manifesto com contagem adulterada é recusado antes de qualquer trabalho.
  const tampered = structuredClone(manifest);
  tampered.parts[0].rows += 1;
  assert.throws(() => readManifest(JSON.stringify(tampered)), error => error instanceof ErpBackupJobError && error.code === "erp_backup_invalid");
  // Esquema diferente: recusa.
  assert.throws(() => readManifest(JSON.stringify({ ...manifest, schema_hash: "0".repeat(64) })), error => error.code === "erp_backup_schema_mismatch");
});

test("backup antigo (formato 1, um arquivo por tabela) continua restaurável pelo caminho em páginas", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 2_000, payload: 600 });
  const dump = dumpAll(source.storage);
  const saved = await backupToR2(bucket, PROFILE, dump);
  assert.equal(manifestOf(bucket, saved.prefix).format, 1);
  const target = freshDatabase();
  const end = await restoreInto(target, bucket, saved.prefix, clock, { maxUnits: 3 });
  assert.equal(end.job.phase, "done", JSON.stringify(end.job.error));
  assert.deepEqual(end.job.result, { tables: dump.manifest.tables.length, rows: dump.manifest.tables.reduce((s, t) => s + t.rows, 0) });
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});

test("restauração recusada com XML em voo ou sem conferência; nada muda e nenhum trabalho fica", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 200 });
  const done = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  const before = snapshot(target.db, ALL_TABLES);
  const key = `erp/area-destino/bling/xml/${"b".repeat(64)}`;
  markXmlObjectDelete("area-destino", key, true);
  try {
    await assert.rejects(startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now }), error => error instanceof ErpRestoreBusyError && error.code === "erp_restore_archive_busy");
  } finally { markXmlObjectDelete("area-destino", key, false); }
  assert.equal(readBackupJob(target.storage), null);
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
  // Exclusão já enviada e ainda não conferida no banco (durável): também recusa.
  target.db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,profile,phase,owner,fence,lease_until,not_before,created_at,updated_at)
    VALUES('u1','a1','c1',?,1,0,0,'r2_delete','area-destino','waiting','dono','f1',?,0,0,0)`).run("d".repeat(64), clock.now() + 4_000);
  await assert.rejects(startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now }), ErpRestoreBusyError);
  assert.equal(readBackupJob(target.storage), null);
});

test("XML em voo que aparece antes da troca: a troca não começa e o banco fica como estava", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 500 });
  const done = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  const before = snapshot(target.db, ALL_TABLES);
  await startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now });
  const key = `erp/area-destino/bling/xml/${"c".repeat(64)}`;
  const hooks = { at: name => { if (name === "swap:before") markXmlObjectDelete("area-destino", key, true); } };
  try {
    const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, hooks });
    assert.equal(end.job.phase, "failed");
    assert.equal(end.job.error.code, "erp_restore_archive_busy");
  } finally { markXmlObjectDelete("area-destino", key, false); }
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
});

test("um trabalho por área: backup e restauração não se sobrepõem; o mesmo pedido devolve o mesmo trabalho", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 3_000, payload: 1_000 });
  const first = startBackup(source.storage, PROFILE, { now: clock.now });
  assert.equal(startBackup(source.storage, PROFILE, { now: clock.now }).id, first.id);
  await assert.rejects(startRestore(source.storage, bucket, PROFILE, first.prefix, { now: clock.now }), error => error.code === "erp_backup_job_running");
  // Duas execuções concorrentes no mesmo objeto: uma avança, a outra só devolve o estado.
  const [a, b] = await Promise.all([runBackupJob(source.storage, bucket, { now: clock.now }), runBackupJob(source.storage, bucket, { now: clock.now })]);
  assert.ok([a, b].some(r => r.job?.phase === "done"));
  assert.equal(manifestOf(bucket, first.prefix).format, 2);
});

test("teto real da restauração: o disco do objeto (a troca em etapas não tem teto de memória), acima do provisório, e recusado antes da barreira", async () => {
  // Antes, 64 MiB pela memória da troca numa transação só (medição de 20/11/2026); agora, o que cabe no disco de 10 GB com o estágio.
  assert.equal(ERP_RESTORE_SWAP_LIMIT_BYTES, Math.floor((10_000_000_000 - 64 * 1024 * 1024) / 1.5));
  assert.ok(ERP_RESTORE_SWAP_LIMIT_BYTES >= 4 * ERP_LOGICAL_BACKUP_LIMIT_BYTES);
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 500 });
  const done = await backupOf(source, bucket, clock);
  // Abaixo do teto padrão: declara que a restauração lógica cobre, sem aviso.
  assert.deepEqual(manifestOf(bucket, done.job.prefix).logical_restore, { limit_bytes: ERP_RESTORE_SWAP_LIMIT_BYTES, exceeds_limit: false });
  assert.deepEqual(done.job.result.logical_restore, { limit_bytes: ERP_RESTORE_SWAP_LIMIT_BYTES, exceeds_limit: false });
  assert.equal(done.job.result.warning, undefined);
  const target = freshDatabase();
  await assert.rejects(startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now, swapLimitBytes: 1024 }), error => {
    assert.equal(error.code, "erp_restore_too_large");
    assert.equal(error.status, 413);
    assert.match(error.message, /esta versão restaura pelo caminho lógico até 1024 bytes/);
    assert.match(error.message, /recuperação no tempo do objeto da área/);
    assert.doesNotMatch(error.message, /CPU/);
    return true;
  });
  assert.equal(readBackupJob(target.storage), null);
  assert.equal(backupFence(target.storage, clock.now()), null);
});

test("backup acima do teto da restauração: conclui inteiro, declara exceeds_limit com o aviso, e a restauração dele é recusada sem barreira", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 3_000, payload: 1_000 });
  const limit = 64 * 1024;
  const done = await backupOf(source, bucket, clock, { swapLimitBytes: limit });
  const total = done.job.result.text_bytes;
  assert.ok(total > limit, `exportou ${total} bytes`);
  assert.ok(done.job.progress.parts_done > 1, "várias partes");
  const manifest = manifestOf(bucket, done.job.prefix);
  assert.equal(manifest.totals.text_bytes, total);
  assert.deepEqual(manifest.logical_restore, { limit_bytes: limit, exceeds_limit: true });
  assert.deepEqual(keysUnder(bucket, done.job.prefix), [...manifest.parts.map(p => done.job.prefix + p.key), done.job.prefix + "manifest.json"].sort(), "backup inteiro");
  assert.deepEqual(done.job.result.logical_restore, { limit_bytes: limit, exceeds_limit: true });
  assert.match(done.job.result.warning, /gravado inteiro/);
  assert.match(done.job.result.warning, new RegExp(`cobre até ${limit} bytes`));
  assert.match(done.job.result.warning, /recuperação no tempo/);
  assert.match(done.job.result.warning, /disco do objeto/);
  assert.deepEqual(backupJobStatus(readBackupJob(source.storage), clock.now()).job.result, done.job.result, "quem pede o estado vê o aviso");
  const target = freshDatabase();
  const before = snapshot(target.db, ALL_TABLES);
  await assert.rejects(startRestore(target.storage, bucket, "area-destino", done.job.prefix, { now: clock.now, swapLimitBytes: limit }), error => error.code === "erp_restore_too_large" && error.status === 413);
  assert.equal(readBackupJob(target.storage), null, "nenhum trabalho");
  assert.equal(backupFence(target.storage, clock.now()), null, "nenhuma barreira");
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
  // Com o teto padrão o mesmo backup restaura: o formato não muda com o aviso.
  const restored = await restoreInto(target, bucket, done.job.prefix, clock);
  assert.equal(restored.job.phase, "done", JSON.stringify(restored.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});

test("manifesto antigo, sem logical_restore, continua valendo para a restauração", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 300 });
  const done = await backupOf(source, bucket, clock);
  const manifest = manifestOf(bucket, done.job.prefix);
  delete manifest.logical_restore;
  await bucket.put(done.job.prefix + "manifest.json", JSON.stringify(manifest));
  assert.equal(readManifest(JSON.stringify(manifest)).parts.length, manifest.parts.length);
  const target = freshDatabase();
  const restored = await restoreInto(target, bucket, done.job.prefix, clock);
  assert.equal(restored.job.phase, "done", JSON.stringify(restored.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});

test("operações novas: nomes estáveis, descrição, categoria sensível (bot propõe, pessoa confirma)", () => {
  assert.deepEqual(ERP_BACKUP_OPERATIONS.map(o => o.name), ["erp.backup.start", "erp.backup.status", "erp.backup.restore", "erp.backup.list", "erp.backup.delete"]);
  for (const operation of ERP_BACKUP_OPERATIONS) {
    // Consultar o progresso e listar são leitura comum; o resto é sensível.
    const reading = operation.method === "GET";
    assert.equal(operation.sensitive, !reading);
    assert.deepEqual(operation.bot, { default: reading ? "run" : "propose", configurable: true });
    assert.equal(operation.category, "erp_backup");
    assert.ok(operation.summary.length > 10 && operation.description.length > 40);
  }
  assert.deepEqual(ERP_BACKUP_OPERATIONS.map(o => o.route), ["/erp-backup", "/erp-backup-status", "/erp-restore", null, null]);
});

test("memória de pico abaixo de um limite fixo, independente do tamanho (heap de 48 MB, 4 e 48 MiB)", () => {
  const probe = fileURLToPath(new URL("./memory-probe.mjs", import.meta.url));
  const results = [];
  for (const mib of [4, 48]) {
    // Pelo caminho na memória, 48 MiB precisariam de ~185 MB de heap (3,6 × + 12 MB).
    const run = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", "--max-old-space-size=48", probe, "--mib", String(mib)], { encoding: "utf8", timeout: 300_000 });
    assert.equal(run.status, 0, run.stderr);
    results.push(JSON.parse(run.stdout.trim().split("\n").at(-1)));
  }
  for (const r of results) assert.ok(r.heap_peak_over_base_mb < 32, `pico ${r.heap_peak_over_base_mb} MB acima da base em ${r.mib} MiB`);
  assert.ok(results[1].text_bytes > 2.5 * ERP_LOGICAL_BACKUP_LIMIT_BYTES);
  assert.ok(Math.abs(results[1].heap_peak_over_base_mb - results[0].heap_peak_over_base_mb) < 16, JSON.stringify(results));
});
