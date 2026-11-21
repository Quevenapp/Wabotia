// Esquema do ERP no SQLite do objeto: versão em código, aplicada na primeira
// chamada (não passa pelas migrações do D1). PRAGMA user_version não é
// autorizado no objeto (prova 1), então a versão fica em erp_meta.
import { ERP_DDL, ERP_DDL_HASH, ERP_DDL_VERSION } from "./ddl.ts";
import { ERP_DDL_GENERATED } from "./ddl.generated.ts";
import { createEngineTables } from "./engine-tables.ts";
import { ERP_SEED } from "./seed.generated.ts";

export const ERP_SCHEMA_VERSION = ERP_DDL_VERSION;

/**
 * Estado das rotinas do agendador (src/erp/scheduler/, docs/ERP-AGENDADOR.md):
 * estrutura do Wabotia fora do DDL gerado (structural.ts, "agendador"), criada
 * aqui como a erp_meta, para valer também em instância que já existe. Fora do
 * backup (engine/dump.ts leva ERP_TABLES): numa restauração as rotinas vencem
 * e rodam uma vez, sem efeito repetido.
 */
export const WB_ROUTINE_DDL = `CREATE TABLE IF NOT EXISTS wb_routine(
  id TEXT PRIMARY KEY,
  next_run_us INTEGER NOT NULL,
  last_run_us INTEGER,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok','partial','error','skipped')),
  last_error TEXT,
  last_ms INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
) STRICT`;

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

type Sql = DurableObjectStorage["sql"];

/**
 * Colunas normalizadas e calculadas das linhas semeadas (uma por id), com o
 * valor da semeadura: preenche só o que está NULL. A semeadura até a versão 5
 * as deixava NULL (label__fold dos tipos de contato do sistema).
 */
export function fillSeedNormalized(sql: Sql): number {
  let written = 0;
  for (const t of ERP_SEED) {
    const id = t.columns.indexOf("id");
    const normalized = t.columns.filter((c) => /__fold$|__k\d+$/.test(c));
    if (!normalized.length) continue;
    if (id < 0) throw new Error(`Semeadura de ${t.table} com coluna normalizada e sem id.`);
    for (const row of t.rows)
      for (const c of normalized)
        written += sql.exec(
          `UPDATE ${q(t.table)} SET ${q(c)} = ? WHERE "id" = ? AND ${q(c)} IS NULL`,
          row[t.columns.indexOf(c)] as string | null,
          row[id] as string,
        ).rowsWritten;
  }
  return written;
}

/**
 * Recria os gatilhos do DDL na ordem dele: apaga os que a instância tem e cria
 * todos de novo. Traz os gerados depois que ela foi criada (o override
 * sqlTriggers) e a ordem de criação, que no SQLite decide qual gatilho dispara
 * primeiro (gen-sqlite.mjs cria em ordem inversa do nome, para valer a ordem do
 * Postgres). Gatilho não muda dados; devolve 0 linhas.
 * Só os do DDL gerado: gatilho de tabela do motor (engine-tables.ts) nasce com
 * a tabela, no passo do `since` dela. Recriá-lo aqui quebraria a subida de
 * uma instância antiga (6→9: o passo 7→8 roda antes de a tabela existir).
 */
export function recreateTriggers(sql: Sql): number {
  const triggers = ERP_DDL_GENERATED.flatMap((statement) => {
    const m = /^CREATE TRIGGER "((?:[^"]|"")+)"/.exec(statement);
    return m ? [{ name: m[1].replace(/""/g, '"'), statement }] : [];
  });
  for (const t of triggers) sql.exec(`DROP TRIGGER IF EXISTS ${q(t.name)}`);
  for (const t of triggers) sql.exec(t.statement);
  return 0;
}

/** Passos N→N+1 para instância que já tem o esquema (mesmo DDL, dados a ajustar). */
// Tabela só do motor nova (engine-tables.ts, since: N+1): suba ERP_DDL_VERSION
// e ponha N: (sql) => createEngineTables(sql, N + 1) (somado a outro passo da
// mesma versão, se houver). Gatilho novo ou reordenado no gerado: N: recreateTriggers.
const STEPS: Record<number, (sql: Sql) => number> = {
  5: fillSeedNormalized,
  6: (sql) => createEngineTables(sql, 7),
  7: recreateTriggers,
  8: (sql) => createEngineTables(sql, 9),
  9: (sql) => createEngineTables(sql, 10),
  10: (sql) => createEngineTables(sql, 11),
  11: (sql) => createEngineTables(sql, 12),
  12: (sql) => createEngineTables(sql, 13),
  13: (sql) => createEngineTables(sql, 14),
  14: (sql) => createEngineTables(sql, 15),
  15: (sql) => createEngineTables(sql, 16),
};

/** Garante erp_meta e aplica o DDL e a semeadura quando a versão gravada é menor. */
export function migrate(storage: DurableObjectStorage): MigrateResult {
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  );
  sql.exec(WB_ROUTINE_DDL);
  const row = sql
    .exec("SELECT value FROM erp_meta WHERE key='schema_version'")
    .toArray()[0];
  const current = row ? Number(row.value) : 0;
  if (current > ERP_SCHEMA_VERSION) return { status: "newer", version: current };
  if (current === ERP_SCHEMA_VERSION) return { status: "current", version: current };
  if (current !== 0) {
    for (let v = current; v < ERP_SCHEMA_VERSION; v++)
      if (!STEPS[v]) throw new Error(`Migração do esquema do ERP ${v}→${v + 1} não existe.`);
    let rowsWritten = 0;
    storage.transactionSync(() => {
      for (let v = current; v < ERP_SCHEMA_VERSION; v++) rowsWritten += STEPS[v](sql);
      sql.exec(
        "INSERT INTO erp_meta(key,value) VALUES('schema_version',?),('schema_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        String(ERP_SCHEMA_VERSION),
        ERP_DDL_HASH,
      );
    });
    return { status: "applied", version: ERP_SCHEMA_VERSION, rowsWritten };
  }
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
