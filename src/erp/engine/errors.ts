// Erro do motor com o mesmo par do Postgres (SQLSTATE + mensagem), para a
// costura da erp-api traduzir como hoje (upstream(): {code, message}).
// SQLSTATE usados pelo Fagoo: 22023, 40001, P0002, 55000, 42501, 23505,
// 54000, 0A000, 28000.
import { ERP_DDL_GENERATED } from "../schema/ddl.generated.ts";

export class ErpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function raise(code: string, message: string): never {
  throw new ErpError(code, message);
}

/** Função de outro domínio ainda não portada (stubs.generated.ts): 0A000, como RPC não portado. */
export function notPorted(id: string): never {
  throw new ErpError("0A000", `rpc_not_ported:${id}`);
}

/**
 * Erro do SQLite vindo de gatilho gerado (RAISE(ABORT,'<sqlstate>:<msg>')) ou
 * de restrição: vira ErpError com o código do Postgres equivalente.
 */
let checks: Map<string, { table: string; constraint: string }> | null = null;
/**
 * CHECK nomeado do DDL gerado ("<schema>__<restrição>", na tabela
 * "<schema>__<tabela>") → tabela e restrição do Postgres. Lido do DDL só no
 * primeiro erro de CHECK. Os nomes não se repetem dentro de um schema
 * (tests/erp/check-errors.test.mjs).
 */
export function checkRelation(name: string): { table: string; constraint: string } | null {
  if (!checks) {
    checks = new Map();
    for (const statement of ERP_DDL_GENERATED) {
      const table = /^CREATE TABLE "([a-z0-9_]+?)__([a-z0-9_]+)"/.exec(statement);
      if (!table) continue;
      for (const m of statement.matchAll(/CONSTRAINT "([a-z0-9_]+?)__([a-z0-9_]+)" CHECK/g))
        checks.set(`${m[1]}__${m[2]}`, { table: table[2], constraint: m[2] });
    }
  }
  return checks.get(name) ?? null;
}

let uniques: Map<string, string | null> | null = null;
/**
 * Unicidade do DDL gerado → nome do Postgres (o da restrição ou do índice,
 * que o Postgres põe na mensagem). Chaves: "<tabela sqlite>|<col>,<col>" e
 * "index:<índice sqlite>" (índice de expressão). Dois únicos nas mesmas
 * colunas (índices parciais diferentes) não têm como ser distinguidos pela
 * mensagem do SQLite: valor null, a mensagem fica a do SQLite
 * (tests/erp/check-errors.test.mjs lista quais).
 * - PRIMARY KEY (cols) → "<tabela>_pkey";
 * - CONSTRAINT "<schema>__<nome>" UNIQUE (cols) → "<nome>";
 * - CREATE UNIQUE INDEX "<schema>__<nome>" ON "<tabela>" (cols) → "<nome>".
 */
export function uniqueName(key: string): string | null | undefined {
  if (!uniques) {
    const map = new Map<string, string | null>();
    const put = (k: string, name: string) => map.set(k, map.has(k) && map.get(k) !== name ? null : name);
    const cols = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(",");
    for (const statement of ERP_DDL_GENERATED) {
      const table = /^CREATE TABLE "(([a-z0-9_]+?)__([a-z0-9_]+))"/.exec(statement);
      if (table) {
        const inlinePk = /^\s*"([^"]+)" INTEGER PRIMARY KEY/m.exec(statement);
        if (inlinePk) put(`${table[1]}|${inlinePk[1]}`, `${table[3]}_pkey`);
        const pk = /^\s*PRIMARY KEY \(([^)]*)\)/m.exec(statement);
        if (pk) put(`${table[1]}|${cols(pk[1])}`, `${table[3]}_pkey`);
        for (const m of statement.matchAll(/CONSTRAINT "[a-z0-9_]+?__([a-z0-9_]+)" UNIQUE \(([^)]*)\)/g)) put(`${table[1]}|${cols(m[2])}`, m[1]);
        continue;
      }
      const index = /^CREATE UNIQUE INDEX "([a-z0-9_]+?__([a-z0-9_]+))" ON "([a-z0-9_]+)" \((.*?)\)(?: WHERE .*)?$/s.exec(statement);
      if (index) {
        put(`index:${index[1]}`, index[2]);
        if (/^"[^"]+"(, "[^"]+")*$/.test(index[4])) put(`${index[3]}|${cols(index[4])}`, index[2]);
      }
    }
    uniques = map;
  }
  return uniques.get(key);
}

/** Mensagem do SQLite ("UNIQUE constraint failed: t.a, t.b" ou "…: index 'x'") → chave de uniqueName. */
export function uniqueKey(message: string): string | null {
  const index = /UNIQUE constraint failed: index '([^']+)'/.exec(message);
  if (index) return `index:${index[1]}`;
  const m = /UNIQUE constraint failed: ((?:[a-z0-9_]+\.[a-z0-9_]+(?:, )?)+)/.exec(message);
  if (!m) return null;
  const parts = m[1].split(", ").map((p) => p.split("."));
  return `${parts[0][0]}|${parts.map((p) => p[1]).join(",")}`;
}

export function fromSqlite(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  const message = String((error as Error)?.message || error);
  const raised = /^([0-9A-Z]{5}):(.*?)(?:: SQLITE_CONSTRAINT.*)?$/s.exec(message);
  if (raised) return new ErpError(raised[1], raised[2]);
  if (/UNIQUE constraint failed/.test(message)) {
    const key = uniqueKey(message);
    const name = key ? uniqueName(key) : null;
    return new ErpError("23505", name ? `duplicate key value violates unique constraint "${name}"` : message);
  }
  if (/FOREIGN KEY constraint failed/.test(message)) return new ErpError("23503", message);
  const check = /CHECK constraint failed: ([a-z0-9_]+)(?::|$)/.exec(message);
  const relation = check ? checkRelation(check[1]) : null;
  if (relation) return new ErpError("23514", `new row for relation "${relation.table}" violates check constraint "${relation.constraint}"`);
  if (/CHECK constraint failed|SQLITE_CONSTRAINT_DATATYPE|NOT NULL constraint/.test(message))
    return new ErpError("23514", message);
  return new ErpError("XX000", message);
}
