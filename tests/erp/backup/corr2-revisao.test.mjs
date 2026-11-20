// Segunda revisão da junção candidata, achados M5 e M6 (restauração e backup).
// M5: a restauração só é recusada por I/O de XML de fato no ar (marca na
// memória, ou unidade com dono e posse viva, com margem); unidade em espera
// com progresso ou erro gravado não trava. M6: backup e restauração medem em
// bytes UTF-8 e pelo mesmo teto; nunca sai um backup que a restauração recusa
// por tamanho. Relógio simulado; R2 em memória; nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDatabase, memoryBucket, fakeClock, seedRaw, snapshot, runToEnd } from "./helpers.mjs";
import { startBackup, startRestore, runBackupJob } from "../../../src/erp/engine/backup-pages.ts";
import { readBackupJob } from "../../../src/erp/engine/backup-state.ts";
import {
  dumpAll, backupToR2, readBackup, restoreAll, measureDump, DUMP_TABLES, ALL_TABLES,
  ErpBackupTooLargeError, ErpRestoreBusyError, ARCHIVE_IO_LEASE_MARGIN_MS,
} from "../../../src/erp/engine/dump.ts";
import { markXmlObjectDelete } from "../../../src/erp/bling/xml.ts";

const PROFILE = "area-corr2", TARGET = "area-corr2-destino";
/** wb_bling_control muda de propósito na restauração (revisões avançam, coleta desligada). */
const COMPARED = DUMP_TABLES.filter(table => table !== "wb_bling_control");
const keysUnder = (bucket, prefix) => [...bucket.stored.keys()].filter(key => key.startsWith(prefix));
const utf8 = text => Buffer.byteLength(text, "utf8");

/** Unidade do Bling gravada à mão no destino (o estado que a coleta deixa). */
function unit(db, fields) {
  const row = {
    id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), command_id: crypto.randomUUID(), request_hash: "d".repeat(64),
    generation: 1, authorization_revision: 0, credential_revision: 0, kind: "xml_store", profile: TARGET, phase: "waiting",
    owner: null, fence: null, lease_until: null, account_id: null, parts_revision: null, progress: "{}", error_code: null,
    not_before: 0, created_at: 0, updated_at: 0, ...fields,
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO wb_bling_unit(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map(n => row[n]));
  return row.id;
}
const live = (clock, kind, phase, leaseUntil) => ({
  kind, phase, owner: "dono", fence: "f1", lease_until: leaseUntil ?? clock.now() + 4_000, account_id: "conta1", parts_revision: "1",
});

/**
 * Texto acentuado (2 bytes por letra em UTF-8, não escapado pelo JSON) e
 * caracteres de controle crus (um byte no banco, seis no NDJSON: \u0001).
 */
function seedTricky(db, rows) {
  db.prepare("INSERT INTO origin_sync__resource_state(resource,updated_at) VALUES('contacts',0) ON CONFLICT(resource) DO NOTHING").run();
  const insert = db.prepare(`INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at)
    VALUES('contacts','contacts',?,json_object('nome',?),'[]',?,1,1,1,1)`);
  for (let i = 0; i < rows; i++)
    insert.run(String(i).padStart(10, "0"), `Ação é ótima, coração ${i} `.repeat(20), `controle\u0001\u0002\u001f${i}`.repeat(20));
}

async function backupOf(source, bucket, clock, options = {}) {
  startBackup(source.storage, PROFILE, { now: clock.now });
  return runToEnd(runBackupJob, source.storage, bucket, { now: clock.now, ...options });
}

test("M5: sem fotografia de partes, unidade de XML em espera com progresso e apagamentos com erro ou progresso gravados não travam a restauração", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 200 });
  const done = await backupOf(source, bucket, clock);
  assert.equal(done.job.phase, "done");
  const target = freshDatabase();
  // Nenhuma fotografia de partes nem ERP ativo: o caminho em páginas não as lê.
  unit(target.db, { kind: "xml_store", phase: "waiting", progress: JSON.stringify({ xml: { phase: "stored", documents: [{ sha256: "a".repeat(64) }] } }) });
  unit(target.db, { kind: "r2_delete", phase: "waiting", error_code: "BLING_RETRY_WAIT", not_before: clock.now() + 30_000 });
  unit(target.db, { kind: "r2_delete", phase: "queued", progress: JSON.stringify({ deleted: true }) });
  // Posse vencida há mais que a margem: quem caiu no meio não trava para sempre.
  unit(target.db, live(clock, "xml_store", "fetching", clock.now() - ARCHIVE_IO_LEASE_MARGIN_MS - 1));
  await startRestore(target.storage, bucket, TARGET, done.job.prefix, { now: clock.now });
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now });
  assert.equal(end.job.phase, "done", JSON.stringify(end.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});

test("M5: exclusão ou passo de XML de fato no ar continua recusando, com o motivo em português; nada muda", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 100 });
  const done = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  const before = snapshot(target.db, ALL_TABLES);
  const refused = async reason => {
    await assert.rejects(startRestore(target.storage, bucket, TARGET, done.job.prefix, { now: clock.now }), error => {
      assert.ok(error instanceof ErpRestoreBusyError);
      assert.equal(error.code, "erp_restore_archive_busy");
      assert.equal(error.reason, reason);
      assert.match(error.message, /A restauração não começou/);
      assert.match(error.message, reason === "delete" ? /exclusão de XML do acervo/ : /busca ou gravação de XML do acervo/);
      assert.match(error.message, /Espere a coleta do Bling em curso terminar/);
      return true;
    });
    assert.equal(readBackupJob(target.storage), null, "nenhum trabalho fica");
  };
  // Na memória desta instância (chamada viva além do prazo da posse).
  const key = `erp/${TARGET}/bling/xml/${"e".repeat(64)}`;
  markXmlObjectDelete(TARGET, key, true);
  try { await refused("delete"); } finally { markXmlObjectDelete(TARGET, key, false); }
  // No banco: exclusão no R2 com dono e posse viva.
  const deletion = unit(target.db, live(clock, "r2_delete", "waiting"));
  await refused("delete");
  // Posse vencida, mas dentro da margem: ainda conta como no ar.
  target.db.prepare("UPDATE wb_bling_unit SET lease_until=? WHERE id=?").run(clock.now() - ARCHIVE_IO_LEASE_MARGIN_MS + 1_000, deletion);
  await refused("delete");
  target.db.prepare("DELETE FROM wb_bling_unit WHERE id=?").run(deletion);
  // Passo de XML na fase de busca/gravação, com dono e posse viva.
  const xml = unit(target.db, live(clock, "xml_store", "fetching"));
  await refused("xml");
  target.db.prepare("DELETE FROM wb_bling_unit WHERE id=?").run(xml);
  assert.deepEqual(snapshot(target.db, ALL_TABLES), before);
});

test("M5: exclusão que fica no ar entre o início e a troca: a troca não começa e o banco fica como estava", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedRaw(source.db, { rows: 100 });
  const done = await backupOf(source, bucket, clock);
  const target = freshDatabase();
  await startRestore(target.storage, bucket, TARGET, done.job.prefix, { now: clock.now });
  const hooks = { at: name => { if (name === "swap:before") unit(target.db, live(clock, "r2_delete", "waiting")); } };
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now, hooks });
  assert.equal(end.job.phase, "failed");
  assert.equal(end.job.error.code, "erp_restore_archive_busy");
  assert.match(end.job.error.message, /exclusão de XML do acervo/);
  assert.equal(Number(target.db.prepare("SELECT count(*) n FROM origin_sync__raw_record").get().n), 0, "nada foi trocado");
});

test("M6 (formato 1): acentos e caracteres de controle perto do teto; mede em bytes UTF-8 e nunca devolve retrato que a leitura recusa", async () => {
  const source = freshDatabase();
  seedTricky(source.db, 300);
  const dump = dumpAll(source.storage);
  const chars = dump.files.reduce((total, file) => total + file.body.length, 0);
  const real = dump.files.reduce((total, file) => total + utf8(file.body), 0);
  assert.ok(real > chars, "acentos ocupam mais bytes que caracteres");
  assert.ok(measureDump(source.storage) < real, "a medição prévia não conta o escape dos caracteres de controle");
  // Logo abaixo dos bytes reais: falha antes de devolver o retrato (nada a gravar).
  assert.throws(() => dumpAll(source.storage, real - 1), error => error instanceof ErpBackupTooLargeError && error.code === "erp_backup_too_large");
  // No teto exato: grava, a leitura aceita o mesmo teto, e a ida e volta é igual.
  const bucket = memoryBucket();
  const saved = await backupToR2(bucket, PROFILE, dumpAll(source.storage, real));
  const read = await readBackup(bucket, saved.prefix, real);
  const target = freshDatabase();
  restoreAll(target.storage, read.manifest, read.files, { profile: TARGET });
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
  // A mesma regra pela leitura: um byte a menos, recusa.
  await assert.rejects(readBackup(bucket, saved.prefix, real - 1), ErpBackupTooLargeError);
});

test("M6 (em páginas): o backup confere o teto da restauração em bytes UTF-8 e falha antes de publicar; no teto exato, ida e volta", async () => {
  const clock = fakeClock(), source = freshDatabase(), bucket = memoryBucket();
  seedTricky(source.db, 2_000);
  const first = await backupOf(source, bucket, clock);
  assert.equal(first.job.phase, "done");
  const total = first.job.result.text_bytes;
  assert.ok(first.job.progress.parts_done > 1, "várias partes");
  // Um byte abaixo: o trabalho falha com erro claro, sem manifesto e sem partes.
  clock.advance(60_000);
  const over = await backupOf(source, bucket, clock, { swapLimitBytes: total - 1 });
  assert.equal(over.job.phase, "failed");
  assert.equal(over.job.error.code, "erp_backup_too_large");
  assert.match(over.job.error.message, /teto que a restauração lógica aceita/);
  assert.deepEqual(keysUnder(bucket, over.job.prefix), [], "nenhuma parte nem manifesto");
  // No teto exato: sai, e a restauração com o mesmo teto aceita.
  clock.advance(60_000);
  const exact = await backupOf(source, bucket, clock, { swapLimitBytes: total });
  assert.equal(exact.job.phase, "done", JSON.stringify(exact.job.error));
  assert.equal(exact.job.result.text_bytes, total);
  const target = freshDatabase();
  await startRestore(target.storage, bucket, TARGET, exact.job.prefix, { now: clock.now, swapLimitBytes: total });
  const end = await runToEnd(runBackupJob, target.storage, bucket, { now: clock.now });
  assert.equal(end.job.phase, "done", JSON.stringify(end.job.error));
  assert.deepEqual(snapshot(target.db, COMPARED), snapshot(source.db, COMPARED));
});
