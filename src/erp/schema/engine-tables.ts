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

const DIGITS = (n: number) => "[0-9]".repeat(n);
const ARRAY = (c: string) => `"${c}" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("${c}") AND json_type("${c}")='array')`;
const T_NATURE = "erp_fiscal_reform__nature_class";
const T_PRODUCT = "erp_fiscal_reform__product_class";

export const ERP_ENGINE_TABLES: readonly EngineTable[] = [
  {
    // Classificação de IBS/CBS por natureza de operação: o padrão (escopo any)
    // e as exceções por NCM, produto ou grupo, como as regras da natureza.
    table: T_NATURE,
    ddl: [
      `CREATE TABLE "${T_NATURE}" (
  "nature_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "product_scope" TEXT NOT NULL,
  ${ARRAY("ncms")},
  ${ARRAY("product_ids")},
  ${ARRAY("group_ids")},
  "cst" TEXT NOT NULL,
  "cclasstrib" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("nature_id", "position"),
  CONSTRAINT "${T_NATURE}_position_check" CHECK (("position" >= 1) AND ("position" <= 50)),
  CONSTRAINT "${T_NATURE}_product_scope_check" CHECK ((product_scope IN ('any', 'ncm', 'products', 'groups'))),
  CONSTRAINT "${T_NATURE}_scope" CHECK ((((product_scope = 'any') AND (json_array_length(ncms) = 0) AND (json_array_length(product_ids) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'ncm') AND ((json_array_length(ncms) >= 1) AND (json_array_length(ncms) <= 10)) AND (json_array_length(product_ids) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'products') AND ((json_array_length(product_ids) >= 1) AND (json_array_length(product_ids) <= 10)) AND (json_array_length(ncms) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'groups') AND ((json_array_length(group_ids) >= 1) AND (json_array_length(group_ids) <= 10)) AND (json_array_length(ncms) = 0) AND (json_array_length(product_ids) = 0)))),
  CONSTRAINT "${T_NATURE}_cst_check" CHECK ((cst GLOB '${DIGITS(3)}')),
  CONSTRAINT "${T_NATURE}_cclasstrib_check" CHECK ((cclasstrib GLOB '${DIGITS(6)}')),
  CONSTRAINT "${T_NATURE}_nature_id_fkey" FOREIGN KEY ("nature_id") REFERENCES "erp_fiscal_invoices__nature" ("id")
) STRICT`,
    ],
    since: 7,
    owner: "G",
    structural: "reforma-classificacao",
  },
  {
    // Classificação de IBS/CBS do produto (e NBS do serviço): vence a da natureza.
    table: T_PRODUCT,
    ddl: [
      `CREATE TABLE "${T_PRODUCT}" (
  "product_id" TEXT NOT NULL PRIMARY KEY,
  "cst" TEXT NOT NULL,
  "cclasstrib" TEXT NOT NULL,
  "nbs" TEXT,
  "version" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${T_PRODUCT}_cst_check" CHECK ((cst GLOB '${DIGITS(3)}')),
  CONSTRAINT "${T_PRODUCT}_cclasstrib_check" CHECK ((cclasstrib GLOB '${DIGITS(6)}')),
  CONSTRAINT "${T_PRODUCT}_nbs_check" CHECK ((nbs GLOB '${DIGITS(9)}')),
  CONSTRAINT "${T_PRODUCT}_version_check" CHECK ((("version" >= 1) AND ("version" <= 2147483647))),
  CONSTRAINT "${T_PRODUCT}_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "erp_catalog__product" ("record_id")
) STRICT`,
    ],
    since: 7,
    owner: "G",
    structural: "reforma-classificacao",
  },
];

export const ERP_ENGINE_DDL: readonly string[] = ERP_ENGINE_TABLES.flatMap((t) => t.ddl);

/** Passo de migração: cria as tabelas do motor que nascem na versão `version`. */
export function createEngineTables(sql: { exec(query: string): { rowsWritten: number } }, version: number): number {
  let written = 0;
  for (const t of ERP_ENGINE_TABLES) if (t.since === version) for (const s of t.ddl) written += sql.exec(s).rowsWritten;
  return written;
}
