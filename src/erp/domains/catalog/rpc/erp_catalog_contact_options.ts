// public.erp_catalog_contact_options: contatos ativos para os seletores
// (cliente, fornecedor, transportadora, técnico), com busca e cidade, no
// escopo do vendedor; erp_catalog.contact_option_item. A busca e a ordem
// seguem o Postgres em TS (fold, matches, collation C).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { requireAccess } from "../access.ts";
import { contactCarrierMatch } from "../carrier.ts";
import { contactScope, contactSituation, contactSourceSituation, contactPrivacyVisible, contactRequirePrivacy } from "../contact.ts";
import { contactTypeSlugs } from "../contact-core.ts";
import { compareText, matches, searchTerms } from "../fields.ts";
import { fold } from "../internal.ts";

const ROLES = ["customer", "supplier", "carrier", "technician"];
const concatWs = (sep: string, ...xs: unknown[]) => xs.filter((x) => x !== null && x !== undefined).map(String).join(sep);

/** erp_catalog.contact_option_item(p_id) */
export function contactOptionItem(db: SqlDriver, id: string): Record<string, unknown> | null {
  contactRequirePrivacy(db, id);
  const r = one(
    db,
    `SELECT r.id, CAST(r.version AS TEXT) version, r.active, r.name, r.code, CAST(r.created_at AS TEXT) created_at,
     CAST(r.updated_at AS TEXT) updated_at, c.trade_name, c.person_type, c.document, c.ie, c.email, c.phone, c.mobile,
     c.postal_code, c.street, c.number, c.complement, c.district, c.city, c.state, c.roles, cp.situation, cp.notes
     FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
     LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE r.id=? AND r.entity='contacts'`,
    id,
  );
  if (!r) return null;
  const origin = one(db, 'SELECT source_id, state FROM "erp_catalog__origin" WHERE record_id=?', id);
  const persons = one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__contact_person" WHERE contact_id=?', id)!;
  const notes = r.notes === null || r.notes === undefined ? "" : pgBtrim(String(r.notes));
  const text = (k: string) => (r[k] ?? null) as string | null;
  return {
    id: r.id,
    entity: "contacts",
    version: Number(r.version),
    active: !!Number(r.active),
    name: r.name,
    code: text("code"),
    trade_name: text("trade_name"),
    person_type: text("person_type"),
    document: text("document"),
    ie: text("ie"),
    email: text("email"),
    phone: text("phone"),
    mobile: text("mobile"),
    postal_code: text("postal_code"),
    street: text("street"),
    number: text("number"),
    complement: text("complement"),
    district: text("district"),
    city: text("city"),
    state: text("state"),
    roles: JSON.parse(String(r.roles)),
    types: contactTypeSlugs(db, id),
    situation: contactSituation(!!Number(r.active), (r.situation as string | null) ?? contactSourceSituation(db, id)),
    has_notes: notes !== "",
    persons: Number(persons.n),
    created_at: jsonTimestamp(String(r.created_at)),
    updated_at: jsonTimestamp(String(r.updated_at)),
    source: origin ? { system: "origin", source_id: origin.source_id, state: origin.state } : null,
  };
}

export function erpCatalogContactOptions(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const query = (a.p_query ?? null) as string | null;
  const role = (a.p_role ?? null) as string | null;
  const cityArg = (a.p_city ?? null) as string | null;
  const limit = (a.p_limit ?? null) as number | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (
    limit === null || limit < 1 || limit > 50 ||
    (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query))) ||
    (role !== null && !ROLES.includes(role)) ||
    (cityArg !== null && (pgLength(cityArg) > 100 || pgHasCntrl.test(cityArg)))
  )
    raise("22023", "erp_catalog_invalid_query");
  const city = cityArg === null || pgBtrim(cityArg) === "" ? null : pgBtrim(cityArg);
  const scope = contactScope(db, user);
  const terms = searchTerms(query);
  const technicians =
    role === "technician"
      ? new Set(
          db
            .exec(
              `SELECT l.contact_id FROM "erp_catalog__contact_type_link" l JOIN "erp_catalog__contact_type" t ON t.id=l.type_id
               WHERE t.slug='technician' AND t.active=1`,
            )
            .rows.map((x) => String(x.contact_id)),
        )
      : null;
  const rows = db
    .exec(
      `SELECT r.id, r.name, r.code, c.trade_name, c.email, c.document, c.phone, c.mobile, c.city, c.roles, cp.fax
       FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
       LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id
       WHERE r.entity='contacts' AND r.active=1 AND (? IS NULL OR cp.seller_id=?)`,
      scope, scope,
    )
    .rows.map((r): Record<string, unknown> & { id: string; carrier: string | null } => ({
      ...(r as Record<string, unknown>),
      id: String(r.id),
      carrier: role === "carrier" ? contactCarrierMatch(db, String(r.id)) : null,
    }))
    .filter((r) => {
      if (!contactPrivacyVisible(db, r.id)) return false;
      const roles: string[] = JSON.parse(String(r.roles));
      if (role !== null && !roles.includes(role) && !(role === "carrier" && r.carrier !== null) && !(role === "technician" && technicians!.has(r.id)))
        return false;
      if (
        terms !== null &&
        !matches(
          terms,
          fold(concatWs(" ", r.name, r.code, r.trade_name, r.email, r.document, r.phone, r.mobile)),
          pgLower(String(r.document ?? "")).replace(/[^0-9a-z]/g, ""),
          concatWs("|", r.document, r.phone, r.mobile, r.fax).replace(/[^0-9|]/g, ""),
        )
      )
        return false;
      return city === null || fold(String(r.city ?? ""))!.includes(fold(city)!);
    })
    .sort(
      (x, y) =>
        (x.carrier === "untyped" ? 1 : 0) - (y.carrier === "untyped" ? 1 : 0) ||
        compareText(fold(String(x.name))!, fold(String(y.name))!) ||
        compareText(x.id, y.id),
    )
    .slice(0, limit + 1);
  return {
    scope: "contact_options",
    data_mode: "erp_native",
    role,
    limit,
    scoped: scope !== null,
    has_more: rows.length > limit,
    items: rows
      .slice(0, limit)
      .map((r) => ({ ...contactOptionItem(db, r.id), ...(role === "carrier" ? { carrier_match: contactCarrierMatch(db, r.id) } : {}) })),
  };
}

registerRpc("erp_catalog_contact_options", erpCatalogContactOptions);
