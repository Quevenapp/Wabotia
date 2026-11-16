// Esquema do ERP no SQLite do objeto: versão em código, aplicada na primeira
// chamada (não passa pelas migrações do D1). PRAGMA user_version não é
// autorizado no objeto (prova 1), então a versão fica em erp_meta.
import { ERP_DDL, ERP_DDL_HASH, ERP_DDL_VERSION } from "./ddl";
import { ERP_SEED } from "./seed.generated";

export const ERP_SCHEMA_VERSION = ERP_DDL_VERSION;

export type MigrateResult =
  | {
      status: "current" | "applied";
      version: number;
      statements?: number;
      seedRows?: number;
      rowsWritten?: number;
    }
  | { status: "newer"; version: number };

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Garante erp_meta e aplica o DDL e a semeadura quando a versão gravada é menor. */
export function migrate(storage: DurableObjectStorage): MigrateResult {
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  );
  const row = sql
    .exec("SELECT value FROM erp_meta WHERE key='schema_version'")
    .toArray()[0];
  const current = row ? Number(row.value) : 0;
  if (current > ERP_SCHEMA_VERSION) return { status: "newer", version: current };
  if (current === ERP_SCHEMA_VERSION) return { status: "current", version: current };
  if (current !== 0)
    throw new Error(
      `Migração do esquema do ERP ${current}→${ERP_SCHEMA_VERSION} ainda não existe (fase 2).`,
    );
  let rowsWritten = 0,
    seedRows = 0;
  // Uma instrução por vez (limite de 100 KB por instrução); tudo numa
  // transação: ou o esquema inteiro entra, ou nada.
  storage.transactionSync(() => {
    for (const statement of ERP_DDL) rowsWritten += sql.exec(statement).rowsWritten;
    // Semeadura com FKs adiadas e conferidas antes de sair da transação:
    // adiada sem conferência reiniciaria o objeto (prova 1).
    sql.exec("PRAGMA defer_foreign_keys = ON");
    for (const t of ERP_SEED) {
      const per = Math.max(1, Math.floor(100 / t.columns.length));
      for (let i = 0; i < t.rows.length; i += per) {
        const part = t.rows.slice(i, i + per);
        const values = part
          .map(() => `(${t.columns.map(() => "?").join(",")})`)
          .join(",");
        rowsWritten += sql.exec(
          `INSERT INTO ${q(t.table)} (${t.columns.map(q).join(",")}) VALUES ${values}`,
          ...part.flat(),
        ).rowsWritten;
        seedRows += part.length;
      }
    }
    const broken = sql.exec("PRAGMA foreign_key_check").toArray();
    if (broken.length)
      throw new Error("Semeadura do ERP com FK quebrada: " + JSON.stringify(broken[0]));
    sql.exec(
      "INSERT INTO erp_meta(key,value) VALUES('schema_version',?),('schema_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(ERP_SCHEMA_VERSION),
      ERP_DDL_HASH,
    );
  });
  return {
    status: "applied",
    version: ERP_SCHEMA_VERSION,
    statements: ERP_DDL.length,
    seedRows,
    rowsWritten,
  };
}
