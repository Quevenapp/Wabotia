// Financeiro (erp_finance): o que outros domínios chamam (docs/ERP-PORTE.md).
// Porte a função aqui com o nome do stub; o stub sai na próxima geração
// (scripts/erp/gen-ownership.mjs).
//
// accountName, accountActive e accountOptions: escritas pela P para o
// Catálogo; dono: Financeiro (sessão O). Leituras de erp_finance.account como
// as faz o Fagoo (erp_catalog.payment_method_dto, payment_method_accounts e
// a conferência de conta ativa de erp_catalog_payment_method_save).
import { one, type SqlDriver } from "../../engine/driver.ts";

export * from "./stubs.generated.ts";

/** left(text, n): caracteres, não unidades UTF-16. */
const left = (s: string, n: number) => [...s].slice(0, n).join("");
/**
 * lower() do Postgres: mapeamento simples, caractere a caractere (sem o
 * sigma final do JS; "İ" → "i").
 */
const lower = (s: string) =>
  [...s]
    .map((c) => {
      const l = c === "İ" ? "i" : c.toLowerCase();
      return [...l].length === 1 ? l : c;
    })
    .join("");
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
