// F2a: nove RPCs da nota; as permissões são as do oráculo, inclusive require_write nas leituras do editor.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { formatScaled } from "../../../engine/dec.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgCompareText, pgLeft } from "../../../engine/text.ts";
import { contactRequireVisible } from "../../catalog/public.ts";
import { digits, moneyText, requireRead, requireWrite, scalar, type Json } from "../core.ts";
import { listQuery } from "../invoice-list.ts";
import {
  companyText,
  compareNullable,
  editLocks,
  invoiceEnvelope,
  invoiceRecord,
  invoiceRow,
  object,
  originDate,
  originInt,
  originItemsRefresh,
  originMoney,
  originNumber,
  pick,
  rows,
  text,
} from "../invoices.ts";

const invalid = () => raise("22023", "erp_fiscal_query_invalid");
const missing = () => raise("P0002", "erp_fiscal_invoice_not_found");
export function erpFiscalInvoiceGet(ctx: RpcContext, a: RpcArgs) {
  const role = requireWrite(ctx.db, text(a.p_user_id)),
    id = text(a.p_id);
  if (id === null) invalid();
  const r = invoiceRecord(ctx.db, id);
  if (!r) missing();
  return { ...invoiceEnvelope(r!, role), locks: editLocks(ctx, id!) };
}
export function erpFiscalInvoiceXmlGet(ctx: RpcContext, a: RpcArgs) {
  requireWrite(ctx.db, text(a.p_user_id));
  const id = text(a.p_id);
  if (id === null) invalid();
  const x = rows(ctx.db, "erp_fiscal_invoices__invoice_xml", "WHERE invoice_id=?", id)[0];
  if (!x) missing();
  return {
    ...pick(x, "invoice_id sha256 size signed protocol_status imported_at"),
    access_key: invoiceRow(ctx.db, id)?.access_key ?? null,
    xml: x.content,
    data_mode: "erp_native",
  };
}
export function erpFiscalInvoiceXmlSource(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db,
    role = requireWrite(db, text(a.p_user_id)),
    id = text(a.p_id);
  if (id === null) invalid();
  const v = invoiceRow(db, id);
  if (!v) missing();
  if (v!.deleted_at !== null || ["T", "S", "X"].includes(String(v!.issue_type))) raise("22023", "erp_fiscal_invoice_native_xml_unavailable");
  const i = object(rows(db, "erp_company__identity")[0]?.data),
    x = object(rows(db, "erp_company__extra")[0]?.data);
  const crt = rows(db, "erp_company__fiscal")[0]?.crt ?? null,
    document = digits(text(i.cnpj)) || null;
  const series = rows(db, "erp_fiscal_numbering__series", "WHERE model=? AND environment='2' AND series=?", text(v!.model), Number(v!.series));
  series.sort((a, b) => Number(b.issuer_cnpj === (document ?? "")) - Number(a.issuer_cnpj === (document ?? "")) || compareNullable(a.created_at, b.created_at));
  const address: Json = {};
  for (const [k, n] of Object.entries({
    street: 200,
    number: 30,
    complement: 200,
    district: 100,
    city: 100,
    municipality_code: 7,
    state: 2,
    postal_code: 9,
    phone: 40,
  }))
    address[k] = companyText(i, k, n);
  return {
    envelope: invoiceEnvelope(invoiceRecord(db, id)!, role),
    emitter: {
      legal_name: companyText(i, "legal_name", 200),
      trade_name: companyText(i, "trade_name", 200),
      document,
      person_type: x.person_type === "fisica" ? "fisica" : "juridica",
      ie: companyText(i, "ie", 30),
      ie_exempt: x.ie_exempt === true,
      municipal_registration: companyText(x, "municipal_registration", 30),
      cnae: companyText(x, "cnae", 9),
      suframa: companyText(x, "suframa", 12),
      substitute_ies: Array.isArray(x.substitute_ies) ? x.substitute_ies : [],
      crt,
      regime_confirmed: crt !== null,
      address,
    },
    numbering: series.length ? pick(series[0], "series next_number enabled") : { series: v!.series, next_number: null, enabled: null },
    data_mode: "erp_native_homologation",
  };
}
const keyArg = (a: RpcArgs) => {
  const key = text(a.p_key);
  if (key === null || !/^[0-9]{44}$/.test(key)) invalid();
  return key!;
};
export function erpFiscalInvoiceKeyLookup(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireWrite(db, text(a.p_user_id));
  const key = keyArg(a);
  const native: Json[] = rows(db, "erp_fiscal_invoices__invoice", "WHERE access_key=? AND deleted_at IS NULL", key).map((v) => ({
    origin: "brufap",
    ...pick(v, "id model direction number series issue_date"),
    name: v.recipient && object(v.recipient).name != null ? pgLeft(String(object(v.recipient).name), 200) : null,
    total: moneyText(text(object(v.totals).total)),
  }));
  const origin = db
    .exec(
      `SELECT r.entity,r.source_id,r.payload FROM origin_fiscal__source s JOIN origin_sync__raw_record r ON r.entity=s.entity AND r.source_id=s.source_id WHERE s.access_key=?`,
      key,
    )
    .rows.map((r) => {
      const p = JSON.parse(String(r.payload)),
        total = originMoney(p.valorNota);
      return {
        origin: "origin",
        id: r.source_id,
        model: r.entity === "nfe" ? "55" : "65",
        direction: r.entity === "nfce" ? "1" : ["0", "1"].includes(scalar(p.tipo, 2) ?? "") ? text(p.tipo) : null,
        number: originNumber(p.numero),
        series: originInt(p.serie),
        issue_date: originDate(p.dataEmissao),
        name: scalar(object(p.contato).nome, 200),
        total,
      };
    });
  const items = [...native, ...origin]
    .slice(0, 5)
    .sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "brufap" ? -1 : 1) || pgCompareText(String(a.id), String(b.id)));
  return { key, items, data_mode: "erp_native" };
}
export function erpFiscalInvoiceReturned(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireWrite(db, text(a.p_user_id));
  const key = keyArg(a);
  const notes = rows(
    db,
    "erp_fiscal_invoices__invoice",
    "WHERE deleted_at IS NULL AND purpose='4' AND status NOT IN (3,10) AND access_key IS NOT ?",
    key,
  ).filter((v) => (v.doc_references as Json[]).some((r) => r.key === key));
  notes.sort((a, b) => compareNullable(a.issue_date, b.issue_date) || compareNullable(a.created_at, b.created_at) || pgCompareText(String(a.id), String(b.id)));
  const groups = new Map<string, { product_id: unknown; code: string | null; description: string | null; quantity: bigint }>();
  for (const n of notes)
    for (const i of db.exec("SELECT product_id,data,CAST(quantity AS TEXT) quantity FROM erp_fiscal_invoices__invoice_item WHERE invoice_id=?", n.id).rows) {
      const d = JSON.parse(String(i.data)),
        code = d.code == null ? null : pgLeft(String(d.code), 60),
        description = d.description == null ? null : pgLeft(String(d.description), 120);
      const k = JSON.stringify([i.product_id, code, description]);
      const g = groups.get(k) ?? { product_id: i.product_id, code, description, quantity: 0n };
      g.quantity += BigInt(String(i.quantity));
      groups.set(k, g);
    }
  const items = [...groups.values()]
    .slice(0, 990)
    .sort((a, b) => compareNullable(a.description, b.description) || compareNullable(a.code, b.code) || compareNullable(a.product_id, b.product_id))
    .map((g) => ({ ...g, quantity: formatScaled(g.quantity, 4) }));
  return { key, returns: notes.slice(0, 50).map((n) => pick(n, "id model direction number series issue_date status")), items, data_mode: "erp_native" };
}
export function erpFiscalInvoiceItemHistory(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db,
    user = text(a.p_user_id),
    contact = text(a.p_contact_id),
    product = text(a.p_product_id),
    direction = text(a.p_direction);
  requireWrite(db, user);
  if (contact === null || product === null || direction === null || !["0", "1"].includes(direction)) invalid();
  const p = one(db, "SELECT code FROM erp_catalog__record WHERE id=? AND entity='products'", product);
  if (!p || !one(db, "SELECT 1 FROM erp_catalog__record WHERE id=? AND entity='contacts'", contact)) missing();
  contactRequireVisible(db, user, contact);
  const code = text(p!.code) || null;
  const sources = db.exec("SELECT source_id FROM erp_catalog__origin WHERE entity='contacts' AND record_id=?", contact).rows.map((o) => o.source_id);
  if (code !== null && sources.length) originItemsRefresh(ctx, 300);
  const native: Json[] = db
    .exec(
      `SELECT v.id,v.number,v.series,v.issue_date,v.issue_type,CAST(i.quantity AS TEXT) quantity,i.unit_price,CAST(i.total AS TEXT) total
    FROM erp_fiscal_invoices__invoice v JOIN erp_fiscal_invoices__invoice_item i ON i.invoice_id=v.id
    WHERE v.deleted_at IS NULL AND v.direction=? AND json_extract(v.recipient,'$.contact_id')=? AND i.product_id=?
    ORDER BY v.issue_date DESC NULLS LAST,v.number DESC NULLS LAST,v.id LIMIT 20`,
      direction,
      contact,
      product,
    )
    .rows.map((r) => ({ ...r, origin: "brufap", quantity: formatScaled(BigInt(String(r.quantity)), 4), total: formatScaled(BigInt(String(r.total)), 2) }));
  const origin: Json[] =
    code === null
      ? []
      : db
          .exec(
            `SELECT source_id id,contact_source,number,series,issue_date,quantity,unit_price,CAST(total AS TEXT) total
    FROM erp_fiscal_invoices__origin_item_index WHERE product_code=? AND direction=?`,
            code,
            direction,
          )
          .rows.filter((r) => sources.includes(r.contact_source))
          .map((r) => ({
            ...pick(r, "id number series issue_date quantity unit_price"),
            origin: "origin",
            issue_type: null,
            total: r.total === null ? null : formatScaled(BigInt(String(r.total)), 2),
          }));
  const items = [...native, ...origin]
    .sort((a, b) => compareNullable(a.issue_date, b.issue_date, true) || compareNullable(a.number, b.number, true) || pgCompareText(String(a.id), String(b.id)))
    .slice(0, 20);
  return { items, contact_id: contact, product_id: product, direction, data_mode: "erp_native" };
}
export function erpFiscalInvoicePricingStates(ctx: RpcContext, a: RpcArgs) {
  requireRead(ctx.db, text(a.p_user_id));
  const ids = a.p_invoice_ids as (string | null)[] | null;
  if (ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null)) invalid();
  const all = rows(ctx.db, "erp_fiscal_invoices__invoice_pricing")
    .filter((p) => ids!.includes(String(p.invoice_id)) && invoiceRow(ctx.db, String(p.invoice_id))?.deleted_at === null)
    .sort(
      (a, b) =>
        pgCompareText(String(a.invoice_id), String(b.invoice_id)) ||
        compareNullable(a.recorded_at, b.recorded_at, true) ||
        pgCompareText(String(a.catalog_command_id), String(b.catalog_command_id)),
    );
  const items = [...new Set(all.map((p) => p.invoice_id))].map((id) => {
    const p = all.find((p) => p.invoice_id === id)!;
    return { ...pick(p, "invoice_id recorded_at products"), count: all.filter((p) => p.invoice_id === id).length };
  });
  return { items, data_mode: "erp_native" };
}
export function erpFiscalInvoicePricingRecord(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db,
    user = text(a.p_user_id),
    id = text(a.p_invoice_id),
    command = text(a.p_catalog_command_id);
  requireWrite(db, user);
  if (id === null || command === null) invalid();
  const v = invoiceRow(db, id);
  if (!v || v.deleted_at !== null || v.direction !== "0") missing();
  let r = rows(db, "erp_fiscal_invoices__invoice_pricing", "WHERE invoice_id=? AND catalog_command_id=?", id, command)[0];
  let replayed = true;
  if (!r) {
    // O recibo é o comando do Catálogo; invoice_pricing é o registro de auditoria
    // e de replay deste RPC. O original não grava fiscal.command/fiscal.audit.
    const c = rows(db, "erp_catalog__command", "WHERE command_id=?", command)[0],
      result = object(c?.result);
    const unmatched = () => raise("22023", "erp_fiscal_invoice_pricing_unmatched");
    if (!c || c.actor !== user || result.entity !== "products" || !Object.hasOwn(result, "supplier_id") || !Array.isArray(result.items)) unmatched();
    const items = result.items as Json[];
    const products = [
      ...new Set(
        items
          .map((x) => text(object(x).product_id))
          .filter((p): p is string => p !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p)),
      ),
    ];
    if (
      products.length < 1 ||
      products.length > 100 ||
      products.length !== items.length ||
      products.some((p) => !one(db, "SELECT 1 FROM erp_fiscal_invoices__invoice_item WHERE invoice_id=? AND product_id=?", id, p))
    )
      unmatched();
    db.exec(
      "INSERT INTO erp_fiscal_invoices__invoice_pricing(invoice_id,catalog_command_id,products,recorded_by,recorded_at) VALUES(?,?,?,?,?)",
      id,
      command,
      products.length,
      user,
      ctx.clock.next().toString(),
    );
    r = rows(db, "erp_fiscal_invoices__invoice_pricing", "WHERE invoice_id=? AND catalog_command_id=?", id, command)[0];
    replayed = false;
  } else if (r.recorded_by !== user) raise("40001", "erp_fiscal_invoice_pricing_conflict");
  return { ...pick(r, "invoice_id catalog_command_id products recorded_at"), replayed, data_mode: "erp_native" };
}

registerRpc("erp_fiscal_invoice_get", erpFiscalInvoiceGet);
registerRpc("erp_fiscal_invoice_list", listQuery);
registerRpc("erp_fiscal_invoice_xml_get", erpFiscalInvoiceXmlGet);
registerRpc("erp_fiscal_invoice_xml_source", erpFiscalInvoiceXmlSource);
registerRpc("erp_fiscal_invoice_key_lookup", erpFiscalInvoiceKeyLookup);
registerRpc("erp_fiscal_invoice_returned", erpFiscalInvoiceReturned);
registerRpc("erp_fiscal_invoice_item_history", erpFiscalInvoiceItemHistory);
registerRpc("erp_fiscal_invoice_pricing_states", erpFiscalInvoicePricingStates);
registerRpc("erp_fiscal_invoice_pricing_record", erpFiscalInvoicePricingRecord);
