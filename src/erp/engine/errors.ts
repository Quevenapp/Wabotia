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

export function fromSqlite(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  const message = String((error as Error)?.message || error);
  const raised = /^([0-9A-Z]{5}):(.*?)(?:: SQLITE_CONSTRAINT.*)?$/s.exec(message);
  if (raised) return new ErpError(raised[1], raised[2]);
  if (/UNIQUE constraint failed/.test(message)) return new ErpError("23505", message);
  if (/FOREIGN KEY constraint failed/.test(message)) return new ErpError("23503", message);
  const check = /CHECK constraint failed: ([a-z0-9_]+)(?::|$)/.exec(message);
  const relation = check ? checkRelation(check[1]) : null;
  if (relation) return new ErpError("23514", `new row for relation "${relation.table}" violates check constraint "${relation.constraint}"`);
  if (/CHECK constraint failed|SQLITE_CONSTRAINT_DATATYPE|NOT NULL constraint/.test(message))
    return new ErpError("23514", message);
  return new ErpError("XX000", message);
}
