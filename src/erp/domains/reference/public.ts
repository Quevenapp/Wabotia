// Referências (erp_reference): tabelas oficiais (CNAE, municípios, países)
// e o que outros domínios chamam (docs/ERP-PORTE.md).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { arrow } from "../../engine/json.ts";
import { referenceKey } from "./rpc/erp_reference_search.ts";

export * from "./stubs.generated.ts";

/** erp_reference.key: minúsculas, sem acento e só [a-z0-9]. */
export const key = referenceKey;

const btrim = (s: string) => s.replace(/^ +| +$/g, "");

/** erp_reference.municipality_known(cidade, uf): null sem cidade ou com UF vazia/EX. */
export function municipalityKnown(db: SqlDriver, city: string | null, uf: string | null): boolean | null {
  const c = btrim(city ?? "");
  const u = btrim(uf ?? "").toUpperCase();
  if (c === "" || u === "" || u === "EX") return null;
  return !!one(db, 'SELECT 1 x FROM "erp_reference__municipality" WHERE uf=? AND key=?', u, referenceKey(c));
}

/**
 * Gatilho erp_reference.company_extra_cnae (BEFORE INSERT/UPDATE em
 * erp_company.extra): o CNAE informado precisa existir na tabela oficial. Quem
 * escreve em extra chama antes, com os dados novos e os anteriores.
 */
export function companyExtraCnae(db: SqlDriver, data: Record<string, unknown> | null, previous: Record<string, unknown> | null, insert: boolean) {
  const text = arrow(data, "cnae");
  const digits = (text ?? "").replace(/[^0-9]/g, "");
  const changed = insert || text !== arrow(previous, "cnae");
  if (digits !== "" && changed && !one(db, 'SELECT 1 x FROM "erp_reference__cnae" WHERE code=?', digits))
    raise("22023", "erp_company_extra_cnae_unknown");
}
