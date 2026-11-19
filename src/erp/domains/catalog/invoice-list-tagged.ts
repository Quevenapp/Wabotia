// Listagem 358 + fiscal_mirror_reads (202610220003). O espelho já contém
// list_data normalizado; esta leitura não projeta nem altera dados do Origin.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { exact, formatScaled, rescale } from "../../engine/dec.ts";
import { raise } from "../../engine/errors.ts";
import { arrow, jsonbKeys } from "../../engine/json.ts";
import type { RpcArgs, RpcContext } from "../../engine/registry.ts";
import { pgHasCntrl, pgLength, pgLower } from "../../engine/text.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { digits, moneyText, nativeVisible, preference, requireRead, ufs } from "../fiscal/public.ts";
import { contactScope } from "./contact.ts";
import { compareText } from "./fields.ts";
import { catalogParts, catalogUnavailable } from "./cost.ts";
import { erpEntityRequirement } from "../../parts-requirements.ts";
import { erpRequirementMet } from "../../parts.ts";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v == null ? {} : JSON.parse(String(v));
const str = (v: unknown): string | null => v == null ? null : String(v);
const trim = (v: string | null) => (v ?? "").replace(/^ +| +$/g, "");
const groups: Record<string, number[]> = {
  pending: [1, 5], issued: [6, 7], authorized: [6], cancelled: [3], denied: [10], registered: [8], contingency: [2],
};
const nullableCompare = (a: unknown, b: unknown, desc = false): number => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : compareText(String(a), String(b));
  return desc ? -c : c;
};
// jsonb_build_object ordena as chaves por tamanho UTF-8 e bytes, inclusive
// nos objetos internos. Preserva a ordem dos arrays (página e pedidos).
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value !== null && typeof value === "object") {
    const row = value as Row;
    return Object.fromEntries(jsonbKeys(row).map((k) => [k, jsonbOrder(row[k])]));
  }
  return value;
}

/** listing_rows: XML preferencial, elegibilidade e uma ocorrência por chave. */
function mirrorRows(db: SqlDriver): Row[] {
  return db.exec(`WITH xml AS (
    SELECT r.entity, r.source_id, x.*, row_number() OVER (PARTITION BY r.entity,r.source_id ORDER BY
      (x.entity=r.entity AND x.source_id=r.source_id) DESC, x.last_success_at DESC NULLS LAST, x.archive_source_id) pos
    FROM "erp_fiscal_mirror__current" r LEFT JOIN "erp_fiscal_mirror__xml_cache" x
      ON x.access_key=r.access_key AND x.xml_id IS NOT NULL
  ), sources AS (
    SELECT r.*, x.environment, x.xml_id, x.xml_hash, x.xml_size,
      coalesce(x.protocol_present,0) protocol_present, coalesce(x.event_count,0) event_count,
      (NOT r.source_deleted AND x.environment IS NOT '2') eligible
    FROM "erp_fiscal_mirror__current" r JOIN xml x ON x.entity=r.entity AND x.source_id=r.source_id AND x.pos=1
  ), ranked AS (
    SELECT s.*, row_number() OVER (PARTITION BY access_key ORDER BY eligible DESC,last_seen_at DESC,entity DESC,source_id DESC) key_position
    FROM sources s
  ) SELECT r.*, CAST(r.last_seen_at AS TEXT) observed,
    (r.access_key IS NULL OR (r.key_position=1 AND NOT EXISTS(
      SELECT 1 FROM "erp_fiscal_invoices__invoice" v LEFT JOIN "erp_fiscal_invoices__invoice_source" ns ON ns.invoice_id=v.id
      WHERE v.access_key=r.access_key AND v.deleted_at IS NULL
      AND (CASE WHEN v.issue_type IN ('S','X') THEN ns.source_environment ELSE v.environment END) IS NOT '2'))) canonical
    FROM ranked r`).rows;
}

function inScope(db: SqlDriver, scope: string | null, contact: string | null): boolean {
  return scope === null || !!one(db, `SELECT 1 x FROM "erp_catalog__origin" o
    JOIN "erp_catalog__contact_profile" cp ON cp.record_id=o.record_id
    WHERE o.entity='contacts' AND o.source_id=? AND cp.seller_id=?`, contact, scope);
}

function coverage(db: SqlDriver, sources: Row[], scope: string | null, model: string, direction: string): Row {
  const visible = sources.filter((r) => !r.source_deleted && r.environment !== "2" && r.canonical);
  const incomplete = (r: Row) => r.access_key === null || arrow(obj(r.listing), "total") === null || arrow(obj(r.listing), "status") === null;
  const pending = db.exec(`SELECT r.payload FROM "erp_fiscal_mirror__seed" q
    JOIN "origin_sync__raw_record" r ON r.entity=q.entity AND r.source_id=q.source_id WHERE r.entity=?`, model === "65" ? "nfce" : "nfe").rows
    .some((r) => {
      const p = obj(r.payload);
      return (model === "65" || arrow(p, "tipo") === direction) && inScope(db, scope, arrow(p.contato, "id"));
    });
  const keys = new Set<unknown>(sources.map((r) => r.access_key).filter((k) => k !== null));
  const xmlPending = db.exec(`SELECT x.access_key FROM "erp_fiscal_mirror__xml_seed" q
    JOIN "origin_fiscal__source" x ON x.id=q.archive_source_id`).rows.some((r) => keys.has(r.access_key));
  const times = visible.map((r) => BigInt(String(r.observed))).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return {
    scope: "model_direction", source_count: sources.length, visible_count: visible.length,
    xml_count: visible.filter((r) => r.xml_id !== null).length, missing_xml_count: visible.filter((r) => r.xml_id === null).length,
    homologation_count: sources.filter((r) => r.environment === "2").length,
    duplicate_count: sources.filter((r) => !r.canonical).length, incomplete_count: visible.filter(incomplete).length,
    oldest_observed_at: times.length ? jsonTimestamp(times[0]) : null,
    latest_observed_at: times.length ? jsonTimestamp(times[times.length - 1]) : null,
    partial: visible.some((r) => r.xml_id === null || incomplete(r)) || pending || xmlPending,
  };
}

function originRow(db: SqlDriver, r: Row): Row {
  const listing = obj(r.listing);
  const contact = one(db, `SELECT payload FROM "origin_sync__raw_record" WHERE entity='contacts' AND source_id=?`, arrow(listing, "contact_source_id"));
  const ambiguous = one(db, `SELECT 1 x FROM "erp_fiscal_mirror__current" WHERE entity=? AND source_id=?`, r.entity === "nfe" ? "nfce" : "nfe", r.source_id);
  const orders = ambiguous || !catalogParts(db).sales ? [] : db.exec(`SELECT order_source_id id, 'sales_orders' kind, order_number number,
    order_date date, contact_name FROM "erp_fiscal_invoices__origin_order_link"
    WHERE invoice_source_id=? AND order_number IS NOT NULL ORDER BY CAST(order_number AS INTEGER),order_source_id`, r.source_id).rows;
  return {
    ...listing, origin: "origin", id: r.source_id, version: null, nature: null, issue_type: null,
    status_raw: r.status_raw, environment: r.environment, access_key: r.access_key,
    xml_id: r.xml_id, xml_hash: r.xml_hash, xml_size: r.xml_size, protocol_present: !!r.protocol_present, event_count: r.event_count,
    contact_code: contact ? arrow(obj(contact.payload), "codigo") : null, product_ids: [],
    orders, order_numbers: orders.map((o) => o.number), observed_at: jsonTimestamp(String(r.observed)),
    source_environment: r.environment, seller_source_id: arrow(obj(r.payload).vendedor, "id"),
  };
}

function nativeRows(db: SqlDriver, model: string, direction: string): Row[] {
  const parts = catalogParts(db);
  const kinds = ["sales_orders", "sales_proposals", "service_orders", "purchase_orders"].filter(kind => erpRequirementMet(parts, erpEntityRequirement(kind)!));
  return db.exec(`SELECT v.*, c.trade_name, cr.code contact_code, ns.source_environment imported_environment
    FROM "erp_fiscal_invoices__invoice" v
    LEFT JOIN "erp_catalog__contact" c ON c.record_id=json_extract(v.recipient,'$.contact_id')
    LEFT JOIN "erp_catalog__record" cr ON cr.id=json_extract(v.recipient,'$.contact_id')
    LEFT JOIN "erp_fiscal_invoices__invoice_source" ns ON ns.invoice_id=v.id
    WHERE v.deleted_at IS NULL AND v.model=? AND v.direction=?`, model, direction).rows.map((v) => {
    const recipient = obj(v.recipient), transport = obj(v.transport);
    const orders = kinds.length === 0 ? [] : db.exec(`SELECT d.id,d.kind,CAST(d.number AS TEXT) number,json_extract(d.body,'$.date') date,c.name contact_name
      FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id
      LEFT JOIN "erp_catalog__record" c ON c.id=d.contact_id WHERE o.invoice_id=?
      ${parts.sales && parts.purchases ? "" : "AND d.kind IN (SELECT value FROM json_each(?))"}
      ORDER BY d.number,d.id`, v.id, ...(parts.sales && parts.purchases ? [] : [JSON.stringify(kinds)])).rows;
    return {
      ...v, ...Object.fromEntries(["name", "document", "person_type", "email", "phone", "state"].map((k) => [k, arrow(recipient, k)])),
      origin: "brufap", entry_date: v.exit_date, nature: v.nature_description, status_raw: null,
      total: arrow(obj(v.totals), "total"), xml_id: null, xml_hash: null, xml_size: null,
      protocol_present: v.protocol !== null, event_count: 0, carrier: arrow(transport.carrier, "name"), tracking: arrow(transport, "tracking_code"),
      product_ids: db.exec(`SELECT product_id FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? AND product_id IS NOT NULL`, v.id).rows.map((i) => i.product_id),
      product_codes: [], orders, order_numbers: orders.map((o) => o.number), observed_at: null,
      source_environment: ["S", "X"].includes(String(v.issue_type)) ? v.imported_environment : v.issue_type === "T" ? null : v.environment,
    };
  });
}

function categoryMatches(db: SqlDriver, id: unknown, category: string): boolean {
  return !!one(db, `SELECT 1 x FROM "erp_finance__invoice_posting" ip
    JOIN "erp_finance__invoice_title" it ON it.posting_id=ip.id JOIN "erp_finance__title" t ON t.id=it.title_id
    WHERE ip.invoice_id=? AND ip.state='active' AND t.category_id=?
    UNION ALL SELECT 1 FROM "erp_finance__grouped_billing_invoice" gi
    JOIN "erp_finance__grouped_billing" g ON g.id=gi.billing_id AND g.state='active'
    JOIN "erp_finance__grouped_billing_title" gt ON gt.billing_id=g.id JOIN "erp_finance__title" t ON t.id=gt.title_id
    WHERE gi.invoice_id=? AND gi.active=1 AND t.category_id=? LIMIT 1`, id, category, id, category);
}

/** Argumentos já convertidos pela assinatura do registro, inclusive defaults. */
export function invoiceListTagged(ctx: RpcContext, a: RpcArgs): unknown {
  if (!ctx.parts.finance && a.p_category_id != null)
    raise("module_disabled", "Esta rotina depende de uma parte desligada.");
  const db = ctx.db, text = (key: string) => str(a[`p_${key}`]);
  const user = text("user_id"), role = requireRead(db, user), scope = contactScope(db, user);
  const origin = text("origin"), model = text("model"), direction = text("direction"), order = text("order"), dateType = text("date_type");
  if (text("order_number") !== null && (!ctx.parts.sales || (origin === "brufap" && !ctx.parts.purchases)))
    raise("module_disabled", "Esta rotina depende de uma parte desligada.");
  const page = a.p_page as number | null, limit = a.p_limit as number | null;
  const tag = text("tag"), category = text("category_id"), from = text("date_from"), to = text("date_to"), status = text("status");
  const state = text("state"), person = text("person_type"), series = a.p_series as number | null;
  const codes = status === null || !Object.hasOwn(groups, status) ? null : groups[status];
  if (!origin || !["origin", "brufap"].includes(origin) || !model || !["55", "65"].includes(model) || !direction || !["0", "1"].includes(direction)
    || (model === "65" && direction !== "1") || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100
    || !order || !["date_desc", "date_asc", "number_desc", "number_asc"].includes(order) || !dateType || !["issue", "entry"].includes(dateType)
    || (from !== null && to !== null && from > to) || (status !== null && !codes)
    || (state !== null && ![...ufs(), "EX"].includes(state)) || (person !== null && !["J", "F", "E"].includes(person))
    || (series !== null && (series < 0 || series > 999))
    || ["query", "nature", "carrier", "trade_name", "document", "email", "phone", "contact_code", "order_number", "tracking"].some((k) => {
      const s = text(k); return s !== null && (pgLength(s) > 120 || pgHasCntrl.test(s));
    }) || tag === null || (tag !== "none" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tag))
    || (category !== null && origin !== "brufap")) raise("22023", "erp_fiscal_query_invalid");
  if (origin === "brufap" && !["admin", "fiscal"].includes(role)) raise("42501", "erp_fiscal_invoice_forbidden");
  const product = text("product_id"), seller = text("seller_id");
  const productCode = product === null ? null : one(db, `SELECT code FROM "erp_catalog__record" WHERE id=? AND entity='products'`, product)?.code;
  const sellers = seller === null ? [] : db.exec(`SELECT DISTINCT r.source_id FROM "origin_sync__raw_record" r
    JOIN "erp_catalog__origin" o ON o.entity='contacts' AND o.source_id=CAST(json_extract(r.payload,'$.contato.id') AS TEXT)
    JOIN "erp_catalog__seller" s ON s.contact_id=o.record_id WHERE r.entity='sellers' AND s.id=?`, seller).rows.map((r) => r.source_id);
  const sources = origin === "origin" ? mirrorRows(db).filter((r) => {
    const l = obj(r.listing);
    return r.entity === (model === "65" ? "nfce" : "nfe") && (model === "65" || arrow(l, "direction") === direction)
      && inScope(db, scope, arrow(l, "contact_source_id"));
  }) : [];
  const rows = origin === "origin" ? sources.filter((r) => r.eligible && r.canonical).map((r) => originRow(db, r)) : nativeRows(db, model!, direction!);
  const q = trim(text("query")), qd = digits(q);
  const contains = (value: unknown, query: string) => pgLower(str(value) ?? "").includes(pgLower(query));
  const kept = rows.filter((r) => {
    if (scope !== null && origin === "brufap" && !nativeVisible(db, user, String(r.id))) return false;
    if (q && !(contains(r.name, q) || contains(r.trade_name, q) || (qd.length >= 5 && String(r.document ?? "").includes(qd))
      || (qd === q && qd !== "" && r.number != null && String(r.number).replace(/^0+/, "") === qd.replace(/^0+/, ""))
      || (qd.length === 44 && r.access_key === qd))) return false;
    const date = str(dateType === "entry" ? r.entry_date : r.issue_date);
    if ((from !== null && (date === null || date < from)) || (to !== null && (date === null || date > to))) return false;
    if (codes && !codes.includes(Number(r.status))) return false;
    if (product !== null && !(r.product_ids as unknown[]).includes(product) && !(productCode != null && (r.product_codes as unknown[]).includes(productCode))) return false;
    if (state !== null && r.state !== state || person !== null && r.person_type !== person || series !== null && r.series !== series) return false;
    if (["nature", "carrier", "trade_name", "email", "tracking"].some((k) => trim(text(k)) && !contains(r[k], trim(text(k))))) return false;
    if (digits(text("document")) && r.document !== digits(text("document"))) return false;
    if (digits(text("phone")) && !String(r.phone ?? "").includes(digits(text("phone")))) return false;
    if (trim(text("contact_code")) && r.contact_code !== trim(text("contact_code"))) return false;
    if (trim(text("order_number")) && !(r.order_numbers as unknown[]).includes(trim(text("order_number")))) return false;
    if (seller !== null && !(origin === "brufap" ? r.seller_id === seller : sellers.includes(r.seller_source_id))) return false;
    const tags = db.exec(`SELECT tag_id FROM "erp_catalog__invoice_tag" WHERE origin=? AND model=? AND invoice_id=?`, origin, model, r.id).rows;
    if (tag === "none" ? tags.length > 0 : !tags.some((t) => t.tag_id === tag)) return false;
    return category === null || categoryMatches(db, r.id, category);
  });
  const desc = order!.endsWith("desc");
  kept.sort((a, b) => (order!.startsWith("date") ? nullableCompare(a.issue_date, b.issue_date, desc) : 0)
    || nullableCompare(a.number, b.number, desc) || compareText(String(a.origin), String(b.origin)) || compareText(String(b.id), String(a.id)));
  const items = kept.slice((page! - 1) * limit!, page! * limit!).map((r) => ({
    ...Object.fromEntries(["origin", "id", "version", "number", "series", "issue_date", "entry_date", "name", "document", "state", "nature", "status", "status_raw",
      "environment", "issue_type", "access_key", "xml_id", "xml_hash", "xml_size", "protocol_present", "event_count", "orders", "observed_at", "source_environment"].map((k) => [k, r[k] ?? null])),
    total: moneyText(str(r.total)), total_known: r.total != null, fiscal_status: r.status === 7 ? 6 : r.status ?? null, danfe_emitted: r.status === 7,
    source_origin: origin === "origin" ? "origin" : ["S", "X"].includes(String(r.issue_type)) ? "xml_import" : r.issue_type === "T" ? "third_party" : "brufap_native",
  }));
  return jsonbOrder({
    ...catalogUnavailable(ctx.parts, ["sales", "purchases"]),
    items, origin, model, direction, page, limit, order, has_more: kept.length > page! * limit!, total_count: kept.length,
    total_amount: formatScaled(rescale(kept.reduce((sum, r) => sum + exact(str(r.total) ?? "0"), 0n), 30, 2), 2),
    amount_unknown: kept.filter((r) => r.total == null).length, brufap_visible: ["admin", "fiscal"].includes(role),
    show_totals: preference(db, "nfe.exibir_totais", "boolean", true),
    data_mode: origin === "origin" ? "origin_mirror_readonly" : "erp_native_homologation",
    coverage: origin === "origin" ? coverage(db, sources, scope, model!, direction!) : null,
  });
}
