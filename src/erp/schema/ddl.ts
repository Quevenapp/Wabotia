// DDL aplicado no objeto: o esquema gerado de catalog.json
// (scripts/erp/gen-sqlite.mjs). Mudou o gerado ou a semeadura, suba
// ERP_DDL_VERSION e escreva o passo N→N+1 em migrate.ts (STEPS).
// 6: semeadura com as colunas __fold preenchidas (passo 5→6).
import { ERP_DDL_GENERATED, ERP_DDL_HASH } from "./ddl.generated.ts";

export const ERP_DDL_VERSION = 6;
export { ERP_DDL_HASH };
export const ERP_DDL: readonly string[] = ERP_DDL_GENERATED;
