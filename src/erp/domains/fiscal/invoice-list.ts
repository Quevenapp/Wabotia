// list_rows, list_query e coverage: notas nativas e o espelho local, sem Origin vivo.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { exact, formatScaled, rescale } from "../../engine/dec.ts";
import type { RpcArgs, RpcContext } from "../../engine/registry.ts";
import { requireRpcParts } from "../../engine/parts-gate.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../engine/text.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { contactScope } from "../catalog/public.ts";
import { digits, moneyText, nativeVisible, preference, requireRead, UFS, type Json } from "./core.ts";
import { compareNullable, INVOICE, invoiceOrders, object, originSellerIds, pick, rows, text } from "./invoices.ts";

const STATUS_GROUPS: Record<string, number[]> = {
  pending: [1, 5],
  issued: [6, 7],
  authorized: [6],
  cancelled: [3],
  denied: [10],
  registered: [8],
  contingency: [2],
};
export const statusGroup = (g: string | null): number[] | null => (g !== null && Object.hasOwn(STATUS_GROUPS, g) ? STATUS_GROUPS[g] : null);

/** O mesmo ranking da view erp_fiscal_mirror.listing_rows, antes de filtrar modelo/direção. */
export function mirrorListingRows(db: SqlDriver): Json[] {
  return db
    .exec(
      `WITH candidates AS (
    SELECT r.entity,r.source_id,x.archive_source_id,row_number() OVER(PARTITION BY r.entity,r.source_id
      ORDER BY (x.entity=r.entity AND x.source_id=r.source_id) DESC,x.last_success_at DESC,x.archive_source_id) position
    FROM erp_fiscal_mirror__current r JOIN erp_fiscal_mirror__xml_cache x ON x.access_key=r.access_key AND x.xml_id IS NOT NULL
    ), sources AS (
    SELECT r.*,x.environment,x.xml_id,x.xml_hash,x.xml_size,coalesce(x.protocol_present,0) protocol_present,coalesce(x.event_count,0) event_count,
      (NOT r.source_deleted AND x.environment IS NOT '2') eligible
    FROM erp_fiscal_mirror__current r LEFT JOIN candidates c ON c.entity=r.entity AND c.source_id=r.source_id AND c.position=1
    LEFT JOIN erp_fiscal_mirror__xml_cache x ON x.archive_source_id=c.archive_source_id
    ), ranked AS (SELECT s.*,row_number() OVER(PARTITION BY access_key ORDER BY eligible DESC,last_seen_at DESC,entity DESC,source_id DESC) key_position FROM sources s)
    SELECT r.entity,r.source_id,r.access_key,CAST(r.last_seen_at AS TEXT) last_seen_at,r.source_deleted,r.listing,r.payload,r.status_raw,
      r.environment,r.xml_id,r.xml_hash,r.xml_size,r.protocol_present,r.event_count,r.eligible,
      (r.access_key IS NULL OR (r.key_position=1 AND NOT EXISTS(SELECT 1 FROM erp_fiscal_invoices__invoice v
       LEFT JOIN erp_fiscal_invoices__invoice_source ns ON ns.invoice_id=v.id WHERE v.access_key=r.access_key AND v.deleted_at IS NULL
       AND (CASE WHEN v.issue_type IN ('S','X') THEN ns.source_environment ELSE v.environment END) IS NOT '2'))) canonical FROM ranked r`,
    )
    .rows.map((r) => ({
      ...r,
      listing: JSON.parse(String(r.listing)),
      payload: JSON.parse(String(r.payload)),
      last_seen_at: jsonTimestamp(String(r.last_seen_at)),
      source_deleted: r.source_deleted === 1,
      eligible: r.eligible === 1,
      canonical: r.canonical === 1,
      protocol_present: r.protocol_present === 1,
    }));
}
const contactInScope = (db: SqlDriver, scope: string | null, source: unknown) =>
  scope === null ||
  (source != null &&
    !!one(
      db,
      `SELECT 1 FROM erp_catalog__origin o
  JOIN erp_catalog__contact_profile cp ON cp.record_id=o.record_id WHERE o.entity='contacts' AND o.source_id=? AND cp.seller_id=?`,
      String(source),
      scope,
    ));

export function coverage(db: SqlDriver, user: string | null, model: string, direction: string, mirror = mirrorListingRows(db)) {
  const scope = contactScope(db, user),
    entity = model === "65" ? "nfce" : "nfe";
  const sources = mirror.filter(
    (r) =>
      r.entity === entity && (model === "65" || object(r.listing).direction === direction) && contactInScope(db, scope, object(r.listing).contact_source_id),
  );
  const visible = sources.filter((r) => !r.source_deleted && r.environment !== "2" && r.canonical);
  const incomplete = (r: Json) => r.access_key === null || object(r.listing).total == null || object(r.listing).status == null;
  const times = visible.map((r) => String(r.last_seen_at)).sort(pgCompareText);
  const pending = db
    .exec(
      `SELECT r.payload FROM erp_fiscal_mirror__seed q JOIN origin_sync__raw_record r ON r.entity=q.entity AND r.source_id=q.source_id WHERE r.entity=?`,
      entity,
    )
    .rows.some((r) => {
      const p = JSON.parse(String(r.payload));
      return (model === "65" || text(p.tipo) === direction) && contactInScope(db, scope, object(p.contato).id);
    });
  const pendingXml = db
    .exec(`SELECT x.access_key FROM erp_fiscal_mirror__xml_seed q JOIN origin_fiscal__source x ON x.id=q.archive_source_id`)
    .rows.some((x) => sources.some((s) => s.access_key === x.access_key));
  return {
    scope: "model_direction",
    source_count: sources.length,
    visible_count: visible.length,
    xml_count: visible.filter((r) => r.xml_id !== null).length,
    missing_xml_count: visible.filter((r) => r.xml_id === null).length,
    homologation_count: sources.filter((r) => r.environment === "2").length,
    duplicate_count: sources.filter((r) => !r.canonical).length,
    incomplete_count: visible.filter(incomplete).length,
    oldest_observed_at: times[0] ?? null,
    latest_observed_at: times.at(-1) ?? null,
    partial: visible.some((r) => r.xml_id === null || incomplete(r)) || pending || pendingXml,
  };
}

export function listRows(db: SqlDriver, origin: string, model: string, direction: string, role: string, mirror = mirrorListingRows(db)): Json[] {
  if (origin === "brufap") {
    if (!["admin", "fiscal"].includes(role)) return [];
    return rows(db, INVOICE, "WHERE deleted_at IS NULL AND model=? AND direction=?", model, direction).map((v) => {
      const recipient = object(v.recipient),
        transport = object(v.transport);
      const contact = one(
        db,
        "SELECT c.trade_name,r.code FROM erp_catalog__record r LEFT JOIN erp_catalog__contact c ON c.record_id=r.id WHERE r.id=?",
        text(recipient.contact_id),
      );
      const orders = invoiceOrders(db, String(v.id));
      return {
        ...pick(v, "id version number series issue_date status environment issue_type access_key"),
        origin,
        entry_date: v.exit_date,
        ...pick(recipient, "name document person_type email phone state"),
        trade_name: contact?.trade_name ?? null,
        nature: v.nature_description,
        status_raw: null,
        total: object(v.totals).total ?? null,
        xml_id: null,
        xml_hash: null,
        xml_size: null,
        protocol_present: v.protocol !== null,
        event_count: 0,
        carrier: object(transport.carrier).name ?? null,
        tracking: transport.tracking_code ?? null,
        contact_code: contact?.code ?? null,
        product_ids: db
          .exec("SELECT product_id FROM erp_fiscal_invoices__invoice_item WHERE invoice_id=? AND product_id IS NOT NULL", v.id)
          .rows.map((i) => i.product_id),
        product_codes: [],
        orders,
        order_numbers: orders.map((o) => o.number),
        seller_id: v.seller_id,
        observed_at: null,
        source_environment: ["S", "X"].includes(String(v.issue_type))
          ? (one(db, "SELECT source_environment FROM erp_fiscal_invoices__invoice_source WHERE invoice_id=?", v.id)?.source_environment ?? null)
          : v.issue_type === "T"
            ? null
            : v.environment,
      };
    });
  }
  return mirror
    .filter((r) => r.entity === (model === "55" ? "nfe" : "nfce") && (model === "65" || object(r.listing).direction === direction) && r.eligible && r.canonical)
    .map((r) => {
      const listing = object(r.listing),
        contact = one(db, "SELECT payload FROM origin_sync__raw_record WHERE entity='contacts' AND source_id=?", text(listing.contact_source_id));
      const ambiguous = mirror.some((m) => m.entity !== r.entity && m.source_id === r.source_id);
      const links = ambiguous
        ? []
        : rows(db, "erp_fiscal_invoices__origin_order_link", "WHERE invoice_source_id=? AND order_number IS NOT NULL", String(r.source_id)).sort((a, b) => {
            const x = BigInt(String(a.order_number)),
              y = BigInt(String(b.order_number));
            return (x < y ? -1 : x > y ? 1 : 0) || pgCompareText(String(a.order_source_id), String(b.order_source_id));
          });
      const orders = links.map((l) => ({
        id: l.order_source_id,
        kind: "sales_orders",
        number: l.order_number,
        date: l.order_date,
        contact_name: l.contact_name,
      }));
      return {
        ...pick(listing, "number series issue_date entry_date name trade_name document person_type email phone state total carrier tracking product_codes"),
        ...pick(r, "status_raw environment access_key xml_id xml_hash xml_size protocol_present event_count"),
        status: listing.status == null ? null : Number(listing.status),
        number: listing.number == null ? null : Number(listing.number),
        series: listing.series == null ? null : Number(listing.series),
        origin,
        id: r.source_id,
        version: null,
        nature: null,
        issue_type: null,
        contact_code: contact ? text(JSON.parse(String(contact.payload)).codigo) : null,
        product_ids: [],
        orders,
        order_numbers: orders.map((o) => o.number),
        observed_at: r.last_seen_at,
        source_environment: r.environment,
        contact_source_id: listing.contact_source_id,
        origin_seller: text(object(object(r.payload).vendedor).id),
      };
    });
}

export function listQuery(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_fiscal_invoice_list", a);
  const db = ctx.db,
    user = text(a.p_user_id),
    role = requireRead(db, user);
  const origin = text(a.p_origin),
    model = text(a.p_model),
    direction = text(a.p_direction),
    order = text(a.p_order),
    dateType = text(a.p_date_type);
  const page = a.p_page as number,
    limit = a.p_limit as number,
    status = text(a.p_status),
    state = text(a.p_state),
    person = text(a.p_person_type);
  const codes = statusGroup(status),
    q = pgBtrim(text(a.p_query) ?? "") || null,
    qd = digits(q);
  const bad = () => raise("22023", "erp_fiscal_query_invalid");
  if (
    !origin ||
    !["origin", "brufap"].includes(origin) ||
    !model ||
    !["55", "65"].includes(model) ||
    !direction ||
    !["0", "1"].includes(direction) ||
    (model === "65" && direction !== "1") ||
    page == null ||
    page < 1 ||
    page > 100000 ||
    limit == null ||
    limit < 1 ||
    limit > 100 ||
    !order ||
    !["date_desc", "date_asc", "number_desc", "number_asc"].includes(order) ||
    !dateType ||
    !["issue", "entry"].includes(dateType) ||
    (a.p_date_from != null && a.p_date_to != null && String(a.p_date_from) > String(a.p_date_to)) ||
    (status !== null && codes === null) ||
    (state !== null && ![...UFS, "EX"].includes(state)) ||
    (person !== null && !["J", "F", "E"].includes(person)) ||
    (a.p_series != null && (Number(a.p_series) < 0 || Number(a.p_series) > 999)) ||
    (a.p_category_id != null && origin !== "brufap")
  )
    bad();
  for (const k of ["query", "nature", "carrier", "trade_name", "document", "email", "phone", "contact_code", "order_number", "tracking"]) {
    const v = text(a[`p_${k}`]);
    if (v !== null && (pgLength(v) > 120 || pgHasCntrl.test(v))) bad();
  }
  if (origin === "brufap" && !["admin", "fiscal"].includes(role)) raise("42501", "erp_fiscal_invoice_forbidden");
  const product =
    a.p_product_id == null ? null : (one(db, "SELECT code FROM erp_catalog__record WHERE entity='products' AND id=?", text(a.p_product_id))?.code ?? null);
  const sellers = a.p_seller_id != null && origin === "origin" ? originSellerIds(db, String(a.p_seller_id)) : [];
  const scope = contactScope(db, user),
    mirror = origin === "origin" ? mirrorListingRows(db) : [];
  const contains = (v: unknown, needle: string) => pgLower(String(v ?? "")).includes(pgLower(needle));
  const filtered = listRows(db, origin!, model!, direction!, role, mirror).filter((x) => {
    if (scope !== null && !(origin === "origin" ? contactInScope(db, scope, x.contact_source_id) : nativeVisible(db, user, String(x.id)))) return false;
    if (
      q !== null &&
      !(
        contains(x.name, q) ||
        contains(x.trade_name, q) ||
        (qd.length >= 5 && String(x.document ?? "").includes(qd)) ||
        (qd === q && qd !== "" && String(x.number ?? "").replace(/^0+/, "") === qd.replace(/^0+/, "")) ||
        (qd.length === 44 && x.access_key === qd)
      )
    )
      return false;
    const date = dateType === "entry" ? x.entry_date : x.issue_date;
    if (
      (a.p_date_from != null && (date == null || String(date) < String(a.p_date_from))) ||
      (a.p_date_to != null && (date == null || String(date) > String(a.p_date_to)))
    )
      return false;
    if (codes !== null && !codes.includes(Number(x.status))) return false;
    if (
      a.p_product_id != null &&
      !(x.product_ids as unknown[]).includes(a.p_product_id) &&
      !(product !== null && ((x.product_codes as unknown[]) ?? []).includes(product))
    )
      return false;
    if ((state !== null && x.state !== state) || (person !== null && x.person_type !== person) || (a.p_series != null && x.series !== a.p_series)) return false;
    for (const k of ["nature", "carrier", "trade_name", "email", "tracking"]) {
      const v = pgBtrim(text(a[`p_${k}`]) ?? "");
      if (v && !contains(x[k], v)) return false;
    }
    const document = digits(text(a.p_document)),
      phone = digits(text(a.p_phone));
    if ((document && x.document !== document) || (phone && !String(x.phone ?? "").includes(phone))) return false;
    const contact = pgBtrim(text(a.p_contact_code) ?? ""),
      number = pgBtrim(text(a.p_order_number) ?? "");
    if ((contact && x.contact_code !== contact) || (number && !(x.order_numbers as unknown[]).includes(number))) return false;
    if (a.p_seller_id != null && !(origin === "brufap" ? x.seller_id === a.p_seller_id : sellers.includes(String(x.origin_seller)))) return false;
    if (
      a.p_category_id != null &&
      !one(
        db,
        `SELECT 1 FROM erp_finance__invoice_posting ip JOIN erp_finance__invoice_title it ON it.posting_id=ip.id
      JOIN erp_finance__title t ON t.id=it.title_id WHERE ip.invoice_id=? AND ip.state='active' AND t.category_id=?
      UNION ALL SELECT 1 FROM erp_finance__grouped_billing_invoice gi JOIN erp_finance__grouped_billing g ON g.id=gi.billing_id AND g.state='active'
      JOIN erp_finance__grouped_billing_title gt ON gt.billing_id=g.id JOIN erp_finance__title t ON t.id=gt.title_id WHERE gi.invoice_id=? AND gi.active=1 AND t.category_id=?`,
        x.id,
        a.p_category_id,
        x.id,
        a.p_category_id,
      )
    )
      return false;
    return true;
  });
  const desc = order!.endsWith("desc");
  filtered.sort(
    (a, b) =>
      (order!.startsWith("date") ? compareNullable(a.issue_date, b.issue_date, desc) : 0) ||
      compareNullable(a.number, b.number, desc) ||
      pgCompareText(String(a.origin), String(b.origin)) ||
      pgCompareText(String(b.id), String(a.id)),
  );
  const items = filtered
    .slice((page - 1) * limit, page * limit)
    .map((x) => ({
      ...pick(
        x,
        "origin id version number series issue_date entry_date name document state nature status status_raw environment issue_type access_key xml_id xml_hash xml_size protocol_present event_count orders observed_at source_environment",
      ),
      total: moneyText(text(x.total)),
      total_known: x.total != null,
      fiscal_status: x.status === 7 ? 6 : x.status,
      danfe_emitted: x.status === 7,
      source_origin:
        origin === "origin" ? "origin" : ["S", "X"].includes(String(x.issue_type)) ? "xml_import" : x.issue_type === "T" ? "third_party" : "brufap_native",
    }));
  const total = filtered.reduce((sum, x) => sum + exact(text(x.total) ?? "0"), 0n);
  return {
    items,
    origin,
    model,
    direction,
    page,
    limit,
    order,
    has_more: filtered.length > page * limit,
    total_count: filtered.length,
    total_amount: formatScaled(rescale(total, 30, 2), 2),
    amount_unknown: filtered.filter((x) => x.total == null).length,
    brufap_visible: ["admin", "fiscal"].includes(role),
    show_totals: preference(db, "nfe.exibir_totais", "boolean", true),
    data_mode: origin === "origin" ? "origin_mirror_readonly" : "erp_native_homologation",
    coverage: origin === "origin" ? coverage(db, user, model!, direction!, mirror) : null,
  };
}
