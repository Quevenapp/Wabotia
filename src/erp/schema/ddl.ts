// DDL aplicado no objeto: o esquema gerado de catalog.json
// (scripts/erp/gen-sqlite.mjs). Mudou o gerado, suba ERP_DDL_VERSION (a
// migração N→N+1 com dados vem na fase 2; hoje uma instância nova).
import { ERP_DDL_GENERATED, ERP_DDL_HASH } from "./ddl.generated";

export const ERP_DDL_VERSION = 2;
export { ERP_DDL_HASH };
export const ERP_DDL: readonly string[] = ERP_DDL_GENERATED;
