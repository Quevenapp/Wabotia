// Decisões do conversor que o catálogo não diz sozinho (PLANO-FAGOO-MOTOR.md,
// seção 3: "decisão por coluna em overrides"), divididas por domínio do
// porte: scripts/erp/overrides/<domínio>.mjs, cada um editado só pela sessão
// dona (docs/ERP-PORTE.md). Este arquivo só junta e recusa chave repetida.
//
// numeric sem precisão no Postgres (20 colunas): decisão coluna a coluna pela
// evidência do Fagoo (docs/ERP-FASE0.md, "As 20 colunas numeric"). Teto do
// i64: com 10 casas, ±922 milhões; preço de 14 inteiros + 10 casas vai em
// dec_text (decimal exato em TEXT, conta em TS).
import * as access from "./overrides/access.mjs";
import * as catalog from "./overrides/catalog.mjs";
import * as cnab from "./overrides/cnab.mjs";
import * as company from "./overrides/company.mjs";
import * as documents from "./overrides/documents.mjs";
import * as finance from "./overrides/finance.mjs";
import * as fiscal from "./overrides/fiscal.mjs";
import * as pos from "./overrides/pos.mjs";
import * as preferences from "./overrides/preferences.mjs";
import * as reference from "./overrides/reference.mjs";
import * as stock from "./overrides/stock.mjs";
import * as sync from "./overrides/sync.mjs";

const parts = { access, catalog, cnab, company, documents, finance, fiscal, pos, preferences, reference, stock, sync };

function merge(field, sub) {
  const out = {};
  for (const [domain, part] of Object.entries(parts))
    for (const [key, value] of Object.entries(sub ? (part[field]?.[sub] ?? {}) : part[field])) {
      if (key in out) throw Error(`overrides: ${key} declarado duas vezes (${domain})`);
      out[key] = value;
    }
  return out;
}

export const overrides = {
  columns: merge("columns"),
  discardTables: merge("discardTables"),
  /** Pendências cumpridas em TS, por domínio (overrides/<domínio>.mjs, `covered`). */
  covered: { checks: merge("covered", "checks"), triggers: merge("covered", "triggers") },
};
