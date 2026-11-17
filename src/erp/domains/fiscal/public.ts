// Fiscal (erp_fiscal_*, erp_dfe, erp_a1); bloco opcional erp-fiscal: o que outros domínios chamam (docs/ERP-PORTE.md).
// Porte a função aqui com o nome do stub; o stub sai na próxima geração
// (scripts/erp/gen-ownership.mjs).
import { one, type SqlDriver } from "../../engine/driver.ts";

export * from "./stubs.generated.ts";

// natureDescription e natureActive: escritas pela P para o Catálogo
// (erp_catalog.contact_dto e contact_check_full); dono: Fiscal.

/** (select n.description from erp_fiscal_invoices.nature n where n.id=…) */
export function natureDescription(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  const n = one(db, 'SELECT description FROM "erp_fiscal_invoices__nature" WHERE id=?', id);
  return n ? ((n.description as string | null) ?? null) : null;
}

/** exists(select 1 from erp_fiscal_invoices.nature where id=… and active) */
export const natureActive = (db: SqlDriver, id: string) =>
  !!one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__nature" WHERE id=? AND active=1', id);

// Portadas no F1 (src/erp/domains/fiscal/core.ts; dona: G). Papel, permissão e
// leituras recebem o SqlDriver; os validadores de valor (*Input, checkValue,
// specObject) recebem só o valor. nativeVisible e visible: para as etiquetas
// de nota do Catálogo (sessão B).
export {
  boolInput,
  checkValue,
  commandHash,
  commandReplay,
  digits,
  ipiSituationAllowed,
  moneyText,
  nativeVisible,
  preference,
  requireRead,
  requireWrite,
  roleOf,
  scalar,
  specObject,
  textInput,
  ufs,
  uuidInput,
  versionInput,
  visible,
} from "./core.ts";
