// Sonda de medição do backup em páginas: gera um banco de ~N MiB de NDJSON
// (massa sintética no acervo do Bling), faz backup e restauração completos e
// imprime uma linha JSON com memória de pico, tempos, invocações e quanto
// tempo as escritas ficaram retidas. Roda num processo próprio, em geral com
// --max-old-space-size fixo: se a memória dependesse do tamanho do banco, o
// processo cairia. Bancos e R2 simulados ficam em arquivos temporários (fora
// do heap do V8). Usado por tests/erp/backup/paged.test.mjs e por
// scripts/erp-backup-measure.mjs. Nenhuma rede.
//
//   node --max-old-space-size=64 tests/erp/backup/memory-probe.mjs --mib 16
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { lazyStorage, seedRaw } from "./helpers.mjs";
import { startBackup, startRestore, runBackupJob } from "../../../src/erp/engine/backup-pages.ts";
import { backupFence } from "../../../src/erp/engine/backup-state.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[index + 1]]], []));
const mib = Number(args.mib ?? 16);
/** Orçamento de cada invocação (o mesmo do alarme em src/erp/hub.ts). */
const budgetMs = Number(args["budget-ms"] ?? 10_000), maxUnits = Number(args["max-units"] ?? 128);
const dir = mkdtempSync(join(tmpdir(), "wb-backup-probe-"));

let peakHeap = 0, peakRss = 0;
const sample = () => {
  const m = process.memoryUsage();
  peakHeap = Math.max(peakHeap, m.heapUsed);
  peakRss = Math.max(peakRss, m.rss);
};
const sampler = setInterval(sample, 5);

function fileStorage(name) {
  const db = new DatabaseSync(join(dir, name));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA foreign_keys=ON");
  return { db, storage: lazyStorage(db) };
}

/** R2 num SQLite em arquivo: os bytes não ocupam o heap do processo. */
function fileBucket() {
  const db = new DatabaseSync(join(dir, "r2.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE o(key TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
  const read = key => db.prepare("SELECT bytes FROM o WHERE key=?").get(key)?.bytes ?? null;
  return {
    async put(key, body) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      db.prepare("INSERT INTO o(key,bytes) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes").run(key, bytes);
    },
    async get(key) {
      const size = db.prepare("SELECT length(bytes) n FROM o WHERE key=?").get(key)?.n;
      if (size === undefined) return null;
      return { key, size: Number(size), get body() { return new Blob([read(key)]).stream(); },
        async text() { return new TextDecoder().decode(read(key)); }, async json() { return JSON.parse(new TextDecoder().decode(read(key))); } };
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const rows = db.prepare("SELECT key, length(bytes) size FROM o WHERE substr(key,1,length(?))=? ORDER BY key LIMIT ?").all(prefix, prefix, limit);
      return { objects: rows.map(r => ({ key: r.key, size: Number(r.size) })), truncated: false };
    },
    async delete(keys) { for (const key of [].concat(keys)) db.prepare("DELETE FROM o WHERE key=?").run(key); },
    close() { db.close(); },
  };
}

try {
  const source = fileStorage("source.sqlite");
  migrate(source.storage);
  // ~1.027 bytes de NDJSON por linha com 800 caracteres de texto (medido).
  const rows = Math.max(1, Math.round(mib * 1024 * 1024 / 1_027));
  seedRaw(source.db, { rows, payload: 800 });
  const bucket = fileBucket();
  const now = () => Date.now();
  globalThis.gc?.();
  const baseHeap = process.memoryUsage().heapUsed;
  peakHeap = baseHeap;

  // Backup: uma chamada de runBackupJob = uma invocação (rota ou alarme).
  const t0 = performance.now();
  startBackup(source.storage, "sonda", { now });
  let run, backupInvocations = 0, writesRefusedWhileRunning = 0, maxGapMs = 0;
  do {
    const before = performance.now();
    run = await runBackupJob(source.storage, bucket, { now, budgetMs, maxUnits });
    maxGapMs = Math.max(maxGapMs, performance.now() - before);
    backupInvocations++;
    if (backupFence(source.storage)) writesRefusedWhileRunning++;
    sample();
  } while (run.more);
  const backupMs = performance.now() - t0;
  if (run.job.phase !== "done") throw new Error("backup não terminou: " + JSON.stringify(run.job.error));
  const job = run.job;

  // Restauração numa instância nova.
  const target = fileStorage("target.sqlite");
  migrate(target.storage);
  const t1 = performance.now();
  let swapMs = 0, swapStart = 0;
  const hooks = { at: point => { if (point === "swap:before") swapStart = performance.now(); if (point === "swap:after") swapMs = performance.now() - swapStart; } };
  await startRestore(target.storage, bucket, "sonda", job.prefix, { now });
  let restoreInvocations = 0;
  do { run = await runBackupJob(target.storage, bucket, { now, budgetMs, maxUnits, hooks }); restoreInvocations++; sample(); } while (run.more);
  const restoreMs = performance.now() - t1;
  if (run.job.phase !== "done") throw new Error("restauração não terminou: " + JSON.stringify(run.job.error));
  const restored = Number(target.db.prepare("SELECT count(*) n FROM origin_sync__raw_record").get().n);
  if (restored !== rows) throw new Error(`restauradas ${restored} de ${rows} linhas`);
  clearInterval(sampler);
  sample();
  bucket.close(); source.db.close(); target.db.close();
  console.log(JSON.stringify({
    mib, rows, text_bytes: job.progress.text_bytes, gzip_bytes: job.progress.bytes, parts: job.progress.parts_done,
    backup_ms: Math.round(backupMs), backup_invocations: backupInvocations,
    writes_held_ms: Math.max(0, (job.barrier_released_at ?? job.finished_at) - job.started_at),
    restore_ms: Math.round(restoreMs), restore_invocations: restoreInvocations, swap_ms: Math.round(swapMs),
    restore_writes_held_ms: Math.max(0, (run.job.barrier_released_at ?? run.job.finished_at) - run.job.started_at),
    heap_base_mb: +(baseHeap / 2 ** 20).toFixed(1), heap_peak_mb: +(peakHeap / 2 ** 20).toFixed(1),
    heap_peak_over_base_mb: +((peakHeap - baseHeap) / 2 ** 20).toFixed(1), rss_peak_mb: +(peakRss / 2 ** 20).toFixed(1),
    budget_ms: budgetMs, max_units: maxUnits, max_invocation_ms: Math.round(maxGapMs), writes_refused_between_invocations: writesRefusedWhileRunning,
  }));
} finally {
  clearInterval(sampler);
  rmSync(dir, { recursive: true, force: true });
}
