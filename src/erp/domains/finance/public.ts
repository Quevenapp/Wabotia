// Financeiro (erp_finance): o que outros domínios chamam (docs/ERP-PORTE.md).
// Porte a função aqui com o nome do stub; o stub sai na próxima geração
// (scripts/erp/gen-ownership.mjs).
//
// accountName, accountActive e accountOptions: escritas pela P para o
// Catálogo; dono: Financeiro (sessão O). Leituras de erp_finance.account como
// as faz o Fagoo (erp_catalog.payment_method_dto, payment_method_accounts e
// a conferência de conta ativa de erp_catalog_payment_method_save).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { pgLeft as left, pgLower as lower } from "../../engine/text.ts";

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

/** Ordem do texto no oráculo (collation C): bytes UTF-8. */
const encoder = new TextEncoder();
function compareText(a: string, b: string) {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** (select left(a.name,200) from erp_finance.account a where a.id=…) */
export function accountName(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  const a = one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', id);
  return a ? left(String(a.name), 200) : null;
}

/** exists(select 1 from erp_finance.account where id=… and active) */
export const accountActive = (db: SqlDriver, id: string) =>
  !!one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1', id);

/** erp_catalog.payment_method_accounts: até 500 contas por lower(name), id. */
export function accountOptions(db: SqlDriver): { id: string; name: string; active: boolean }[] {
  return db
    .exec('SELECT id, name, active FROM "erp_finance__account"')
    .rows.map((a) => ({ id: String(a.id), name: String(a.name), active: !!Number(a.active), key: lower(String(a.name)) }))
    .sort((x, y) => compareText(x.key, y.key) || compareText(x.id, y.id))
    .slice(0, 500)
    .map((a) => ({ id: a.id, name: left(a.name, 200), active: a.active }));
}

// Para o domínio 11 (erp_preferences.report_source, bases "comissoes" e "caixa"):
// - commissionRows(db, vendedor | null): as linhas de erp_finance.commission_rows,
//   com os nomes das colunas do oráculo; rate vem como bigint escalado (6 casas,
//   numeric(10,6)) e void pode ser null, como no Postgres;
// - statementLines(db, conta | null, de | null, até | null, excluídas): as linhas de
//   erp_finance.statement_lines (sem ordem; quem lê ordena).
export { commissionPolicy, commissionRows, operationTitles as commissionOperationTitles, operationView as commissionOperationView, type CommissionRow } from "./commissions.ts";
export { statementLines } from "./rpc/erp_finance_statement_page.ts";
export { dto } from "./titles.ts";
export { titlesMarkReturned } from "./title-returns.ts";
export {
  documentTitleRows,
  erpDocumentFinancePost,
  erpDocumentFinancePreview,
  erpDocumentFinanceReverse,
  erpDocumentFinanceReversePreview,
} from "./rpc/erp_document_finance.ts";
export {
  commissionConfirmed,
  commissionOperationCapture,
  commissionOperationSync,
  guardPostedDocument,
  guardPostedItem,
  notesEditAllowed,
  notesItemAllowed,
} from "./document-effects.ts";
export { categoryForFee, commandExists, execute, insertCnabCashPlan, settlementMovements, type CnabCashPlan } from "./cnab-plan.ts";
export { requirePermission } from "./internal.ts";

// categoryLabel e categoryActive: escritas pela P para o Catálogo
// (erp_catalog.contact_dto e contact_check_full); dono: Financeiro (sessão O).

/** (select left(c.name,200) from erp_finance.category c where c.id=…) */
export function categoryLabel(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  const c = one(db, 'SELECT name FROM "erp_finance__category" WHERE id=?', id);
  return c ? left(String(c.name), 200) : null;
}

/** exists(select 1 from erp_finance.category where id=… and active) */
export const categoryActive = (db: SqlDriver, id: string) =>
  !!one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1', id);
