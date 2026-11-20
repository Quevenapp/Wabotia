// Montagem dos testes do backup em páginas: SQLite do Node com cursor
// preguiçoso (como o do objeto: SELECT não materializa a tabela), R2 em
// memória com o contrato usado (put/get/list/delete) e massa sintética.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../../src/erp/schema/migrate.ts";

let bookmarkDir = null;
/**
 * Recuperação no tempo falsa: a marca é uma cópia do banco (VACUUM INTO num
 * arquivo temporário); a volta, pedida para a próxima sessão, só acontece
 * quando o teste reinicia o objeto (restartSession), como na plataforma.
 */
export function fakeBookmarks(db) {
  const saved = new Map();
  let pending = null, next = 0;
  return {
    taken: [], restored: [],
    async getCurrentBookmark() {
      bookmarkDir ??= mkdtempSync(join(tmpdir(), "wb-bookmark-"));
      const id = `marca-${++next}`, file = join(bookmarkDir, `${process.pid}-${Date.now()}-${next}-${Math.random().toString(36).slice(2)}.sqlite`);
      db.exec(`VACUUM INTO '${file}'`);
      saved.set(id, file);
      this.taken.push(id);
      return id;
    },
    async onNextSessionRestoreBookmark(id) {
      if (!saved.has(id)) throw new Error("marca desconhecida");
      pending = id;
    },
    /** Reinício do objeto: aplica a volta pedida, se houver. */
    restartSession() {
      if (!pending) return false;
      restoreInPlace(db, saved.get(pending));
      this.restored.push(pending);
      pending = null;
      return true;
    },
  };
}

/** Troca o conteúdo do banco pelo da cópia, no lugar (as referências ao banco continuam valendo). */
function restoreInPlace(db, file) {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`ATTACH '${file}' AS marca`);
  try {
    db.exec("BEGIN");
    for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type='trigger'").all()) db.exec(`DROP TRIGGER main."${name}"`);
    const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA main.table_xinfo("${table}")`).all().filter(c => !c.hidden).map(c => `"${c.name}"`).join(",");
      db.exec(`DELETE FROM main."${table}"`);
      db.exec(`INSERT INTO main."${table}"(rowid,${cols}) SELECT rowid,${cols} FROM marca."${table}" ORDER BY rowid`);
    }
    if (db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='sqlite_sequence'").get()) {
      db.exec("DELETE FROM main.sqlite_sequence");
      db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM marca.sqlite_sequence");
    }
    for (const { sql } of db.prepare("SELECT sql FROM marca.sqlite_master WHERE type='trigger' ORDER BY rowid").all()) db.exec(sql);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("DETACH marca"); db.exec("PRAGMA foreign_keys=ON"); }
}

/** ctx.storage mínimo: sql.exec (cursor preguiçoso), transactionSync aninhável, databaseSize e a marca falsa. */
export function lazyStorage(db) {
  let depth = 0;
  const bookmarks = fakeBookmarks(db);
  return {
    bookmarks,
    getCurrentBookmark: () => bookmarks.getCurrentBookmark(),
    onNextSessionRestoreBookmark: id => bookmarks.onNextSessionRestoreBookmark(id),
    restartSession: () => bookmarks.restartSession(),
    sql: {
      get databaseSize() { return Number(db.prepare("PRAGMA page_count").get().page_count) * Number(db.prepare("PRAGMA page_size").get().page_size); },
      exec(sql, ...params) {
        assert.ok(params.length <= 100, "até 100 parâmetros SQL");
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);
        const columns = statement.columns();
        if (!columns.length) {
          const result = statement.run(...params);
          return { toArray: () => [], raw: () => [][Symbol.iterator](), rowsRead: 0, rowsWritten: Number(result.changes) };
        }
        const names = columns.map(c => c.name);
        const plain = value => typeof value === "bigint" ? (Number.isSafeInteger(Number(value)) ? Number(value) : value) : value;
        return {
          *raw() { statement.setReturnArrays(true); for (const row of statement.iterate(...params)) yield row.map(plain); },
          toArray() { statement.setReturnArrays(true); return statement.all(...params).map(row => Object.fromEntries(names.map((n, i) => [n, plain(row[i])]))); },
          rowsRead: 0, rowsWritten: 0,
        };
      },
    },
    transactionSync(fn) {
      const name = `paged_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        assert.ok(!result || typeof result.then !== "function", "transação síncrona não pode esperar I/O");
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally { depth--; }
    },
  };
}

export function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const storage = lazyStorage(db);
  migrate(storage);
  return { db, storage };
}

/** R2 em memória. `failPut(key)` simula erro do R2 numa gravação. */
export function memoryBucket() {
  const stored = new Map();
  const bucket = {
    stored, puts: [], gets: 0, failPut: null,
    async put(key, body, options = {}) {
      if (bucket.failPut?.(key)) throw new Error("R2 indisponível (simulado)");
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body instanceof ArrayBuffer ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      bucket.puts.push(key);
      stored.set(key, { bytes: Uint8Array.from(bytes), customMetadata: options.customMetadata ?? {} });
      return { key, size: bytes.length };
    },
    async get(key) {
      bucket.gets++;
      const entry = stored.get(key);
      if (!entry) return null;
      const bytes = entry.bytes;
      return {
        key, size: bytes.length, customMetadata: entry.customMetadata,
        get body() { return new Blob([bytes]).stream(); },
        async text() { return new TextDecoder().decode(bytes); },
        async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
        async arrayBuffer() { return bytes.slice().buffer; },
      };
    },
    async head(key) { const entry = stored.get(key); return entry ? { key, size: entry.bytes.length } : null; },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const keys = [...stored.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map(key => ({ key, size: stored.get(key).bytes.length })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key); },
  };
  return bucket;
}

/** Relógio simulado: só anda quando o teste manda. */
export function fakeClock(start = Date.UTC(2026, 10, 20, 12)) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; }, set(value) { t = value; } };
}

/**
 * Massa sintética no acervo do Bling (origin_sync__raw_record): cada linha
 * leva ~`payload` bytes de texto pouco compressível. Gerada no próprio SQLite.
 */
export function seedRaw(db, { rows, payload = 800, entity = "contacts", offset = 0 }) {
  db.prepare("INSERT INTO origin_sync__resource_state(resource,updated_at) VALUES(?,0) ON CONFLICT(resource) DO NOTHING").run(entity);
  const insert = db.prepare(`INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at)
    WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i < ?)
    SELECT ?, ?, printf('%010d', i), json_object('nome', 'Registro ' || i, 'texto', substr(hex(randomblob(?)), 1, ?)), '[]', lower(hex(randomblob(32))), 1, i, i, i FROM n`);
  const batch = 50_000;
  for (let start = offset + 1; start <= offset + rows; start += batch) {
    const end = Math.min(offset + rows, start + batch - 1);
    insert.run(start, end, entity, entity, Math.ceil(payload / 2), payload);
  }
}

/** Retrato comparável do banco: linhas de todas as tabelas, em ordem de rowid. */
export function snapshot(db, tables) {
  const out = {};
  for (const table of tables) {
    const statement = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    const rows = statement.all();
    if (rows.length) out[table] = rows;
  }
  return out;
}

/** Hash barato do conteúdo de uma tabela grande, sem trazê-la toda à memória. */
export function tableDigest(db, table) {
  const row = db.prepare(`SELECT count(*) n, sum(length(payload)) bytes, max(source_id) last, min(source_id) first FROM "${table}"`).get();
  return { n: Number(row.n), bytes: Number(row.bytes ?? 0), first: row.first, last: row.last };
}

/**
 * Roda o trabalho até terminar, como o alarme faria: uma invocação por
 * chamada. Se a troca pede a volta à marca, reinicia o objeto (a marca falsa
 * aplica a volta) e continua, como a plataforma faria.
 */
export async function runToEnd(runBackupJob, storage, bucket, options = {}, maxInvocations = 10_000) {
  let result, invocations = 0, restarts = 0;
  do {
    try { result = await runBackupJob(storage, bucket, options); }
    catch (error) {
      if (error?.code !== "erp_restore_restart") throw error;
      storage.restartSession?.();
      restarts++;
      result = { more: true };
    }
    invocations++;
    assert.ok(invocations < maxInvocations, "o trabalho não terminou");
  } while (result.more);
  return { ...result, invocations, restarts };
}
