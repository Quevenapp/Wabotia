// Montagem dos testes do backup em páginas: SQLite do Node com cursor
// preguiçoso (como o do objeto: SELECT não materializa a tabela), R2 em
// memória com o contrato usado (put/get/list/delete) e massa sintética.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../../src/erp/schema/migrate.ts";

/** ctx.storage mínimo: sql.exec (cursor preguiçoso), transactionSync aninhável e databaseSize. */
export function lazyStorage(db) {
  let depth = 0;
  return {
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

/** Roda o trabalho até terminar, como o alarme faria: uma invocação por chamada. */
export async function runToEnd(runBackupJob, storage, bucket, options = {}, maxInvocations = 10_000) {
  let result, invocations = 0;
  do {
    result = await runBackupJob(storage, bucket, options);
    invocations++;
    assert.ok(invocations < maxInvocations, "o trabalho não terminou");
  } while (result.more);
  return { ...result, invocations };
}
