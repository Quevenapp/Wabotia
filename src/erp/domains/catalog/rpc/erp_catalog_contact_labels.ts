// public.erp_catalog_contact_labels: modelos de etiqueta de contato (os padrões
// de erp_preferences.label_defaults do tipo 'contato' e até 100 modelos
// salvos, por lower(descrição) e id) e os valores de cada contato
// (erp_catalog.contact_label_values), na ordem pedida; trilha contacts_export/labels.
// Preferências pelo public.ts da G (labelDefaults, labelDto, reportClean).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgLower } from "../../../engine/text.ts";
import { labelDefaults, labelDto, reportClean } from "../../preferences/public.ts";
import { requireAccess } from "../access.ts";
import { auxiliaryAudit } from "../command.ts";
import { contactScope, contactRequirePrivacy } from "../contact.ts";
import { compareText } from "../fields.ts";
import type { SqlDriver } from "../../../engine/driver.ts";

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** concat_ws: pula os nulos. */
const concatWs = (sep: string, ...xs: (string | null)[]) => xs.filter((x) => x !== null).join(sep);

/** erp_catalog.contact_label_values(p_id) */
function contactLabelValues(db: SqlDriver, id: string) {
  const c = one(
    db,
    `SELECT r.name, c.trade_name, c.document, c.street, c.number, c.complement, c.district, c.city, c.state, c.postal_code, c.phone
     FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.entity='contacts'`,
    id,
  );
  if (!c) return null;
  const complement = s(c.complement) === null ? null : pgBtrim(s(c.complement)!);
  return {
    nome: reportClean(s(c.name), 200),
    fantasia: reportClean(s(c.trade_name), 200),
    documento: reportClean(s(c.document), 20),
    endereco: reportClean(concatWs(", ", s(c.street), s(c.number)) + (complement === null || complement === "" ? "" : " - " + complement), 200),
    bairro: reportClean(s(c.district), 100),
    cidade_uf: reportClean(concatWs("/", s(c.city), s(c.state)), 110),
    cep: reportClean(s(c.postal_code), 9),
    telefone: reportClean(s(c.phone), 40),
  };
}

export function erpCatalogContactLabels(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const ids = (a.p_ids ?? null) as (string | null)[] | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_catalog_invalid_query");
  for (const id of ids)
    if (!one(db, `SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.entity='contacts'`, id))
      raise("P0002", "erp_catalog_not_found");
  const scope = contactScope(db, user);
  for (const id of ids) contactRequirePrivacy(db, id);
  if (scope !== null)
    for (const id of ids)
      if (!one(db, `SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?`, id, scope))
        raise("42501", "erp_catalog_contact_not_visible");
  const defaults = labelDefaults()
    .filter((d) => d.type === "contato")
    .map((d) => ({ ...d, default: true, version: 0, updated_at: null }));
  const saved = db
    .exec(`SELECT id, type, description, config, version, updated_at FROM "erp_preferences__label_template" WHERE type='contato'`)
    .rows.map((t) => ({ t, key: pgLower(String(t.description)) }))
    .sort((x, y) => compareText(x.key, y.key) || compareText(String(x.t.id), String(y.t.id)))
    .slice(0, 100)
    .map(({ t }) => labelDto(t as Record<string, unknown>));
  const result = {
    scope: "contact_labels",
    data_mode: "erp_native",
    templates: [...defaults, ...saved],
    items: ids.map((id) => ({ id, values: contactLabelValues(db, id!) })),
  };
  auxiliaryAudit(ctx, { actor: user!, command: null, subject: "contacts_export", subjectId: null, action: "labels", after: { total: ids.length } });
  return result;
}

registerRpc("erp_catalog_contact_labels", erpCatalogContactLabels);
