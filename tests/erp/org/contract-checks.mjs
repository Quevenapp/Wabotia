// Verificadores compartilhados. Tire o baseline depois de migrate/identidade.
import assert from "node:assert/strict";

export const COLLECTION_WRITE_TABLES = Object.freeze([
  "wb_bling_control", "wb_bling_unit", "wb_bling_receipt", "wb_bling_extra_raw", "wb_bling_record_version", "wb_bling_audit",
  "origin_sync__account", "origin_sync__resource_state", "origin_sync__raw_record", "origin_sync__batch_inbox",
  "erp_document_mirror__source_version", "origin_fiscal__source", "origin_fiscal__attempt", "origin_fiscal__object",
  "origin_fiscal__revision", "origin_fiscal__item", "erp_sync__inbox", "erp_sync__run", "erp_sync__issue",
]);
const permitted = new Set(COLLECTION_WRITE_TABLES);
const quote = name => `"${name.replaceAll('"', '""')}"`;
const stable = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { bigint: item.toString() } : item);

export function tableSnapshot(db, tables) {
  const names = tables ?? db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(names.map(name => {
    const query = db.prepare(`SELECT * FROM ${quote(name)}`);
    query.setReadBigInts(true);
    const rows = query.all().map(stable).sort();
    return [name, { count: rows.length, rows }];
  }));
}
export function operationalSnapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name).filter(name => !permitted.has(name));
  return tableSnapshot(db, tables);
}
export function assertOperationalUnchanged(db, baseline) {
  assert.deepEqual(operationalSnapshot(db), baseline, "conteúdo e contagem operacionais devem permanecer iguais");
}
export function assertNoSecrets(value, privateValues) {
  const text = typeof value === "string" ? value : stable(value);
  for (const privateValue of privateValues) {
    assert.equal(typeof privateValue, "string");
    assert.ok(privateValue.length > 0);
    assert.ok(!text.includes(privateValue), "material privado vazou");
  }
}

/** Lexer conservador: ignora literais/comentários, conserva identificadores citados. */
function sqlTokens(sql) {
  const tokens = [];
  const grammar = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|[^\s]/gy;
  let match;
  while ((match = grammar.exec(sql))) {
    const value = match[0];
    if (/^\s|^--|^\/\*/.test(value) || value.startsWith("'")) continue;
    tokens.push(value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.startsWith("`") ? value.slice(1, -1).replaceAll("``", "`") : value.startsWith("[") ? value.slice(1, -1) : value);
  }
  return tokens;
}
export function collectionWriteTargets(sql) {
  const tokens = sqlTokens(sql), upper = tokens.map(token => token.toUpperCase()), targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const operation = upper[i];
    if (["CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "VACUUM", "REINDEX"].includes(operation))
      throw new Error("BLING_TEST_SCHEMA_WRITE_FORBIDDEN");
    if (operation === "PRAGMA" && (upper.includes("=") || !["FOREIGN_KEY_CHECK", "TABLE_INFO", "INDEX_LIST", "INDEX_INFO", "DATABASE_LIST"].includes(upper[i + 1])))
      throw new Error("BLING_TEST_PRAGMA_WRITE_FORBIDDEN");
    if (!["INSERT", "REPLACE", "UPDATE", "DELETE"].includes(operation)) continue;
    // UPSERT DO UPDATE SET não abre um segundo alvo.
    if (operation === "UPDATE" && upper[i - 1] === "DO") continue;
    let index = i + 1;
    if (upper[index] === "OR") index += 2;
    if (["INTO", "FROM"].includes(upper[index])) index++;
    let table = tokens[index];
    if (tokens[index + 1] === ".") {
      if (table.toLowerCase() !== "main") throw new Error("BLING_TEST_ATTACHED_WRITE_FORBIDDEN");
      table = tokens[index + 2];
    }
    assert.ok(table && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table), "alvo SQL indefinido");
    targets.push({ operation: operation.toLowerCase(), table });
  }
  return targets;
}
export function assertCollectionWrite(sql) {
  const targets = collectionWriteTargets(sql);
  for (const { table } of targets) assert.ok(permitted.has(table), `DML fora do acervo: ${table}`);
  return targets;
}
/** Envolve SqlDriver; logs só contêm nome da tabela/operação, nunca parâmetros. */
export function guardCollectionDriver(driver, writes = []) {
  return {
    exec(sql, ...params) {
      writes.push(...assertCollectionWrite(sql));
      return driver.exec(sql, ...params);
    },
    transaction(fn) { return driver.transaction(fn); },
  };
}

/** Storage SQLite/transactionSync para testes das portas e migração, sem Worker. */
export function sqliteStorage(db, { beforeExec = () => {} } = {}) {
  let depth = 0;
  return {
    sql: {
      get databaseSize() { return Number(db.prepare("PRAGMA page_count").get().page_count) * Number(db.prepare("PRAGMA page_size").get().page_size); },
      exec(sql, ...params) {
        beforeExec(sql, params);
        assert.ok(params.length <= 100, "até 100 parâmetros SQL");
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);
        const columns = statement.columns();
        if (columns.length) {
          statement.setReturnArrays(true);
          const raw = statement.all(...params);
          const rows = raw.map(values => Object.fromEntries(columns.map((column, index) => [column.name, values[index]])));
          return { toArray: () => rows, raw: () => raw, rowsRead: rows.length, rowsWritten: 0 };
        }
        const result = statement.run(...params);
        return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(result.changes) };
      },
    },
    transactionSync(fn) {
      const name = `bling_test_${depth++}`;
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
