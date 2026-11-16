// Financeiro (erp_finance): o que outros domínios chamam (docs/ERP-PORTE.md).
// Porte a função aqui com o nome do stub; o stub sai na próxima geração
// (scripts/erp/gen-ownership.mjs).
export * from "./stubs.generated.ts";

// Portadas (src/erp/domains/finance/internal.ts). Assinaturas: leitura pura
// recebe o SqlDriver; validadores de p_data recebem só o valor.
export {
  assertSettlementPostings,
  categoryDepth,
  categoryInUse,
  cents,
  cnabPlanForSettlement,
  day,
  expected,
  keys,
  permissionKey,
  requireAccess,
  txt,
  uuidValue,
} from "./internal.ts";
