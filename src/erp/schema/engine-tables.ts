// Tabelas só do motor: dado do Wabotia que o Fagoo não tem (ex.: a
// classificação da reforma tributária). O esquema gerado do oráculo não as
// conhece; elas entram aqui, em DDL do SQLite escrito à mão, e:
// - vão no fim do ERP_DDL e mudam o ERP_DDL_HASH (schema/ddl.ts);
// - são criadas nos objetos já migrados pelo passo da versão em que nasceram
//   (`since`, schema/migrate.ts: createEngineTables no STEPS);
// - entram no backup (engine/dump.ts);
// - ficam fora do diferencial: o oráculo não as tem, o harness não as espelha
//   nem compara (tests/erp/harness usa ERP_TABLES, o gerado). O RPC que só o
//   motor tem é testado no SQLite, com as próprias asserções.
// Cada tabela é declarada também em structural.ts (o motivo e a decisão).
// Regras do DDL: nomes "<schema>__<tabela>" como no gerado; uuid e data em
// TEXT, decimal escalado em INTEGER, json em TEXT com json_valid, array como
// json; STRICT; CHECK nomeados "<schema>__<tabela>_<coluna>_check".

export interface EngineTable {
  /** Nome no SQLite ("<schema>__<tabela>"). */
  table: string;
  /** CREATE TABLE e índices (sem IF NOT EXISTS: o passo cria uma vez). */
  ddl: readonly string[];
  /** ERP_DDL_VERSION em que a tabela nasce (o passo since-1 → since a cria). */
  since: number;
  /** Sessão dona. */
  owner: string;
  /** Id da entrada em structural.ts. */
  structural: string;
}

export const ERP_ENGINE_TABLES: readonly EngineTable[] = [];

export const ERP_ENGINE_DDL: readonly string[] = ERP_ENGINE_TABLES.flatMap((t) => t.ddl);

/** Passo de migração: cria as tabelas do motor que nascem na versão `version`. */
export function createEngineTables(sql: { exec(query: string): { rowsWritten: number } }, version: number): number {
  let written = 0;
  for (const t of ERP_ENGINE_TABLES) if (t.since === version) for (const s of t.ddl) written += sql.exec(s).rowsWritten;
  return written;
}
