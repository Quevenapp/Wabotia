// Motor do ERP: acesso síncrono ao SQLite. Duas implementações com o mesmo
// contrato: ctx.storage.sql no objeto (aqui) e node:sqlite nos testes
// (tests/erp/harness/node-driver.mjs). Só sintaxe TypeScript apagável: o
// Node dos testes importa estes arquivos direto.
//
// Regras do dialeto (docs/ERP-FASE0.md, prova 1):
// - parâmetros: no máximo 100 por instrução; listas por json_each(?);
// - BigInt nunca vai como parâmetro: i64 e decimais escalados vão como texto
//   (a coluna STRICT converte para inteiro);
// - i64 é lido por CAST(… AS TEXT) (como número perde precisão sem erro);
// - transação só por transaction(): aninhada vira savepoint.

export type Row = Record<string, unknown>;

export interface SqlResult {
  rows: Row[];
  rowsRead: number;
  rowsWritten: number;
}

export interface SqlDriver {
  /** Área da instância, fornecida pelo transporte; nunca por argumentos de RPC. */
  readonly originProfile?: string;
  exec(sql: string, ...params: unknown[]): SqlResult;
  transaction<T>(fn: () => T): T;
}

/** Driver do objeto: ctx.storage.sql e transactionSync. */
export function storageDriver(storage: DurableObjectStorage, originProfile?: string): SqlDriver {
  return {
    originProfile,
    exec(sql, ...params) {
      const cursor = storage.sql.exec(sql, ...params);
      const rows = cursor.toArray() as Row[];
      return { rows, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
    },
    transaction(fn) {
      return storage.transactionSync(fn);
    },
  };
}

/** Uma linha ou nada. */
export const one = (db: SqlDriver, sql: string, ...params: unknown[]) =>
  db.exec(sql, ...params).rows[0] ?? null;

/** Lista de valores como um parâmetro só (json_each). */
export const list = (values: readonly unknown[]) => JSON.stringify(values);
