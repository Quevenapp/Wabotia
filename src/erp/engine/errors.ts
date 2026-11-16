// Erro do motor com o mesmo par do Postgres (SQLSTATE + mensagem), para a
// costura da erp-api traduzir como hoje (upstream(): {code, message}).
// SQLSTATE usados pelo Fagoo: 22023, 40001, P0002, 55000, 42501, 23505,
// 54000, 0A000, 28000.
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

/**
 * Erro do SQLite vindo de gatilho gerado (RAISE(ABORT,'<sqlstate>:<msg>')) ou
 * de restrição: vira ErpError com o código do Postgres equivalente.
 */
export function fromSqlite(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  const message = String((error as Error)?.message || error);
  const raised = /^([0-9A-Z]{5}):(.*?)(?:: SQLITE_CONSTRAINT.*)?$/s.exec(message);
  if (raised) return new ErpError(raised[1], raised[2]);
  if (/UNIQUE constraint failed/.test(message)) return new ErpError("23505", message);
  if (/FOREIGN KEY constraint failed/.test(message)) return new ErpError("23503", message);
  if (/CHECK constraint failed|SQLITE_CONSTRAINT_DATATYPE|NOT NULL constraint/.test(message))
    return new ErpError("23514", message);
  return new ErpError("XX000", message);
}
