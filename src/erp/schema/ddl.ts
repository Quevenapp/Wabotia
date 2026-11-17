// DDL aplicado no objeto: o esquema gerado de catalog.json
// (scripts/erp/gen-sqlite.mjs) e, no fim, as tabelas só do motor
// (engine-tables.ts). Mudou o gerado, a semeadura ou uma tabela do motor,
// suba ERP_DDL_VERSION e escreva o passo N→N+1 em migrate.ts (STEPS).
// 6: semeadura com as colunas __fold preenchidas (passo 5→6).
// 7: tabelas da classificação da reforma tributária (engine-tables.ts, passo 6→7).
// 8: gatilhos do override sqlTriggers (os 6 de imutabilidade do CNAB) e gatilhos
//    criados em ordem inversa do nome (ordem de disparo do Postgres); passo 7→8,
//    recreateTriggers.
import { createHash } from "node:crypto";
import { ERP_DDL_GENERATED, ERP_DDL_HASH as GENERATED_HASH } from "./ddl.generated.ts";
import { ERP_ENGINE_DDL } from "./engine-tables.ts";

export const ERP_DDL_VERSION = 8;
export const ERP_DDL: readonly string[] = [...ERP_DDL_GENERATED, ...ERP_ENGINE_DDL];
/** Hash do esquema: o do gerado; com tabelas do motor, o do gerado mais o DDL delas. */
export const ERP_DDL_HASH: string = ERP_ENGINE_DDL.length
  ? createHash("sha256").update(GENERATED_HASH + "\n" + ERP_ENGINE_DDL.join("\n"), "utf8").digest("hex")
  : GENERATED_HASH;
