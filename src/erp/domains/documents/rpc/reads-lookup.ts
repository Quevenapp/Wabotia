// Consultas do Documentos (sessão L, bloco B0): lotes de um produto, busca de
// produto para a linha do documento, descrição do produto no fornecedor,
// estrutura (composição) dos itens e casamento do XML de nota com contato e
// produtos. Portado de public.erp_document_* com os mesmos nomes.
// erp_document_mirror.require_visible sai (Origin fora: docs/ERP-FASE0.md).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { formatScaled, fromColumn, rescale } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import * as catalog from "../../catalog/public.ts";
import * as stock from "../../stock/public.ts";
import { contactUsable, requireAccess } from "../public.ts";
import { bool, by, cmpUuid } from "./reads-common.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;
const CNTRL_RUN = new RegExp(PG_CNTRL + "+", "gu");
const dec6 = (v: unknown) => (v === null || v === undefined ? null : formatScaled(fromColumn(v), 6));

/** public.erp_document_lot_options(p_user_id, p_kind, p_product_id, p_warehouse_id): lotes do produto com o saldo. */
export function erpDocumentLotOptions(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    productId = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id);
  if (kind === null || !["sales_orders", "service_orders"].includes(kind) || productId === null) raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, false);
  stock.requireAccess(ctx.db, user as string, false);
  const p = one(
    ctx.db,
    `SELECT r.id, r.name, r.code, p.unit, d.lot_control FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
       LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE r.id=?`,
    productId,
  );
  if (!p) raise("22023", "erp_document_product_unavailable");
  if (warehouse !== null && !one(ctx.db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse))
    raise("22023", "erp_document_warehouse_unavailable");
  const lots = ctx.db.exec('SELECT id, code, manufactured_on, expires_on, active FROM "erp_stock__lot" WHERE product_id=?', productId).rows;
  const items = [...lots]
    .sort(
      by<Row>(
        (x, y) => Number(bool(y.active)) - Number(bool(x.active)),
        (x, y) => pgCompareText(str(x.expires_on), str(y.expires_on)), // nulls last: pgCompareText põe null por último
        (x, y) => pgCompareText(pgLower(String(x.code)), pgLower(String(y.code))),
        (x, y) => cmpUuid(x.id, y.id),
      ),
    )
    .slice(0, 100)
    .map((l) => ({
      id: l.id,
      code: l.code,
      manufactured_on: l.manufactured_on,
      expires_on: l.expires_on,
      active: bool(l.active),
      quantity: formatScaled(stock.lotQuantity(ctx.db, String(l.id), warehouse), 6),
    }));
  return {
    kind,
    product: { id: p.id, name: pgLeft(String(p.name), 200), code: p.code, unit: p.unit, lot_control: bool(p.lot_control) },
    warehouse_id: warehouse,
    total: lots.length,
    items,
    ...NATIVE,
  };
}

/** public.erp_document_product_search(p_user_id, p_kind, p_query, p_limit): produtos para a linha do documento (sem variações agrupadoras). */
export function erpDocumentProductSearch(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    query = str(a.p_query),
    limit = a.p_limit === null || a.p_limit === undefined ? null : Number(a.p_limit);
  if (
    kind === null ||
    !["sales_orders", "sales_proposals", "service_orders"].includes(kind) ||
    limit === null ||
    limit < 1 ||
    limit > 25 ||
    query === null ||
    pgLength(pgBtrim(query)) < 2 ||
    pgLength(pgBtrim(query)) > 120 ||
    pgHasCntrl.test(query)
  )
    raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, true);
  catalog.requireAccess(ctx.db, user, "products", false);
  const terms = catalog.searchTerms(query);
  const page: string[] = [];
  const rows = ctx.db.exec(
    `SELECT r.id, r.name, r.code, p.gtin FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
      WHERE r.entity='products' AND r.active=1 AND (p.format IS NULL OR p.format<>'V')
        AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND (d.deleted_at IS NOT NULL OR d.item_type IN ('01','03','07','08')))`,
  ).rows;
  rows.sort((x, y) => cmpUuid(x.id, y.id));
  for (const r of rows) {
    if (page.length > limit) break;
    if (terms !== null) {
      const gtin = str(r.gtin);
      const text = catalog.fold([r.name, r.code, gtin].filter((x) => x !== null && x !== undefined).join(" "));
      if (!catalog.matches(terms, text, pgLower(gtin ?? "").replace(/[^0-9a-z]/g, ""), (gtin ?? "").replace(/[^0-9]/g, ""))) continue;
    }
    page.push(String(r.id));
  }
  const shown = page.slice(0, limit);
  const more = page.length > limit;
  return {
    entity: "products",
    items: shown.map((id) => catalog.dto(ctx.db, id)),
    has_more: more,
    next_cursor: more ? shown[shown.length - 1] : null,
    limit,
    ...NATIVE,
  };
}

/** Documento do tipo, visível ao usuário (senão P0002 erp_document_not_found). */
function visibleDocument(db: SqlDriver, user: string | null, kind: string | null, id: string | null) {
  const d = id === null || kind === null ? null : one(db, 'SELECT id, contact_id FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!d || !contactUsable(db, user, str(d.contact_id))) raise("P0002", "erp_document_not_found");
  return d;
}

/** public.erp_document_supplier_descriptions(p_user_id, p_kind, p_document_id): descrição de cada item no fornecedor. */
export function erpDocumentSupplierDescriptions(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  requireAccess(ctx.db, user, kind, false);
  const d = visibleDocument(ctx.db, user, kind, id);
  const clean = (s: unknown) => (s === null || s === undefined ? null : pgBtrim(String(s).replace(CNTRL_RUN, " ")));
  const items = ctx.db
    .exec('SELECT id, position, product_id FROM "erp_documents__item" WHERE document_id=? AND product_id IS NOT NULL', id)
    .rows.sort((x, y) => Number(x.position) - Number(y.position))
    .flatMap((i) => {
      const s = ctx.db
        .exec('SELECT supplier_id, description, is_default, position FROM "erp_catalog__product_supplier" WHERE record_id=?', i.product_id)
        .rows.filter((ps) => {
          const c = clean(ps.description);
          return c !== null && c !== "";
        })
        .sort(
          by<Row>(
            (x, y) =>
              Number(kind === "purchase_orders" && y.supplier_id === d.contact_id) - Number(kind === "purchase_orders" && x.supplier_id === d.contact_id),
            (x, y) => Number(bool(y.is_default)) - Number(bool(x.is_default)),
            (x, y) => Number(x.position) - Number(y.position),
          ),
        )[0];
      return s ? [{ item_id: i.id, product_id: i.product_id, description: pgLeft(clean(s.description)!, 120) }] : [];
    });
  return { kind, document_id: id, items, ...NATIVE };
}

/** public.erp_document_structures(p_user_id, p_kind, p_document_id): composição vigente do produto de cada item. */
export function erpDocumentStructures(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  requireAccess(ctx.db, user, kind, false);
  visibleDocument(ctx.db, user, kind, id);
  const items = ctx.db
    .exec(
      `SELECT i.id, i.position, i.product_id, CAST(i.quantity AS TEXT) quantity, p.production FROM "erp_documents__item" i
        LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.document_id=? AND i.product_id IS NOT NULL`,
      id,
    )
    .rows.sort((x, y) => Number(x.position) - Number(y.position))
    .map((i) => ({
      item_id: i.id,
      position: Number(i.position),
      product_id: i.product_id,
      production: i.production,
      components: ctx.db
        .exec(
          `SELECT ci.position, ci.component_id, CAST(ci.quantity AS TEXT) quantity, r.code, r.name, cp.unit
             FROM "erp_stock__composition" c JOIN "erp_stock__composition_item" ci ON ci.product_id=c.product_id AND ci.version=c.version
             JOIN "erp_catalog__record" r ON r.id=ci.component_id LEFT JOIN "erp_catalog__product" cp ON cp.record_id=ci.component_id
            WHERE c.product_id=?`,
          i.product_id,
        )
        .rows.sort((x, y) => Number(x.position) - Number(y.position))
        .map((c) => ({
          product_id: c.component_id,
          code: c.code === null ? null : pgLeft(String(c.code), 100),
          description: pgLeft(String(c.name), 200),
          unit: c.unit === null ? null : pgLeft(String(c.unit), 16),
          quantity: dec6(c.quantity),
          total: i.quantity === null ? null : formatScaled(rescale(fromColumn(c.quantity) * fromColumn(i.quantity), 12, 6), 6),
        })),
    }));
  return { kind, document_id: id, items, ...NATIVE };
}

/** O texto do jsonb (->>): texto puro; número, objeto etc. pelo texto do jsonb; null quando JSON null ou ausente. */
const arrowText = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
};

/** public.erp_document_xml_match(p_user_id, p_kind, p_document, p_items): contato pelo CPF/CNPJ e produtos pelo GTIN ou código. */
export function erpDocumentXmlMatch(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    document = str(a.p_document),
    items = a.p_items;
  requireAccess(ctx.db, user, kind, true);
  // A condição do Postgres em três valores: p_kind nulo deixa o primeiro termo nulo, e só um termo verdadeiro recusa.
  const badItem = (i: unknown) => {
    if (jsonType(i) !== "object") return true;
    const o = i as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== 2 || !keys.includes("code") || !keys.includes("gtin")) return true;
    if (o.code !== null && (typeof o.code !== "string" || pgLength(o.code) < 1 || pgLength(o.code) > 60)) return true;
    if (o.gtin !== null && (typeof o.gtin !== "string" || !/^([0-9]{8}|[0-9]{12,14})$/.test(o.gtin))) return true;
    return false;
  };
  if (
    (kind !== null && !["sales_orders", "purchase_orders"].includes(kind)) ||
    (document !== null && !/^[0-9]{11}([0-9]{3})?$/.test(document)) ||
    items === null ||
    items === undefined ||
    jsonType(items) !== "array" ||
    (items as unknown[]).length < 1 ||
    (items as unknown[]).length > 250 ||
    (items as unknown[]).some(badItem)
  )
    raise("22023", "erp_document_query_invalid");
  let contact: Row | null = null;
  if (document !== null) {
    const c = ctx.db
      .exec(
        `SELECT r.id, r.name, r.code, r.created_at, c.document FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
          WHERE r.entity='contacts' AND r.active=1`,
      )
      .rows.filter((r) => String(r.document ?? "").replace(/[^0-9]/g, "") === document)
      .sort(by<Row>((x, y) => Number(BigInt(String(x.created_at)) - BigInt(String(y.created_at))), (x, y) => cmpUuid(x.id, y.id)))[0];
    contact = c ? { id: c.id, name: c.name, code: c.code } : null;
  }
  const products = ctx.db
    .exec(
      `SELECT r.id, r.name, r.code, CAST(r.created_at AS TEXT) created_at, p.unit, p.gtin FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
        WHERE r.entity='products' AND r.active=1`,
    )
    .rows;
  const matched = (items as Record<string, unknown>[]).map((i) => {
    const gtin = arrowText(i, "gtin"),
      code = arrowText(i, "code");
    const byGtin = (p: Row) => gtin !== null && p.gtin !== null && p.gtin === gtin;
    // ORDER BY (i->>'gtin' is not null and p.gtin=i->>'gtin') DESC: produto sem GTIN dá NULL, e NULL vem
    // primeiro no DESC do Postgres. Posto: NULL 0, true 1, false 2.
    const rank = (p: Row) => (gtin === null ? 2 : p.gtin === null ? 0 : p.gtin === gtin ? 1 : 2);
    const hit = products
      .filter((p) => byGtin(p) || (code !== null && p.code !== null && pgLower(String(p.code)) === pgLower(code)))
      .sort(
        by<Row>(
          (x, y) => rank(x) - rank(y),
          (x, y) => (BigInt(String(x.created_at)) < BigInt(String(y.created_at)) ? -1 : BigInt(String(x.created_at)) > BigInt(String(y.created_at)) ? 1 : 0),
          (x, y) => cmpUuid(x.id, y.id),
        ),
      )[0];
    return hit ? { id: hit.id, name: hit.name, code: hit.code, unit: hit.unit, by: byGtin(hit) ? "gtin" : "code" } : null;
  });
  return { kind, contact, products: matched, ...NATIVE };
}

registerRpc("erp_document_lot_options", erpDocumentLotOptions);
registerRpc("erp_document_product_search", erpDocumentProductSearch);
registerRpc("erp_document_supplier_descriptions", erpDocumentSupplierDescriptions);
registerRpc("erp_document_structures", erpDocumentStructures);
registerRpc("erp_document_xml_match", erpDocumentXmlMatch);
