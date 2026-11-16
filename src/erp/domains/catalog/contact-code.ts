// Código de contato e tipos de contato: o maior código numérico já usado
// (erp_catalog.record, entity='contacts') e o contador de próximo número.
import { one, type SqlDriver } from "../../engine/driver.ts";

/** coalesce(max(code::numeric),0) dos contatos com código ^[0-9]{1,15}$ */
export function highestContactCode(db: SqlDriver): bigint {
  let max = 0n;
  for (const r of db.exec(
    `SELECT code FROM "erp_catalog__record" WHERE entity='contacts' AND length(code) BETWEEN 1 AND 15 AND code NOT GLOB '*[^0-9]*'`,
  ).rows) {
    const v = BigInt(String(r.code));
    if (v > max) max = v;
  }
  return max;
}

/** A linha única de erp_catalog.contact_code_counter (ou null). */
export function contactCodeCounter(db: SqlDriver): { next: bigint; version: number } | null {
  const c = one(
    db,
    'SELECT CAST(next_number AS TEXT) next_number, CAST(version AS TEXT) version FROM "erp_catalog__contact_code_counter" WHERE id=1',
  );
  return c ? { next: BigInt(String(c.next_number)), version: Number(c.version) } : null;
}
