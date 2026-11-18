// Leituras da nota e os dois gatilhos do F2a, conforme os corpos finais do oráculo.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { formatScaled, toScaled } from "../../engine/dec.ts";
import { rowJson, rowJsonSelect } from "../../engine/row-json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgLeft } from "../../engine/text.ts";
import { validDate } from "../../engine/time.ts";
import { effectFlags } from "../documents/public.ts";
import { digits, moneyText, preference, scalar, type Json } from "./core.ts";

export const INVOICE = "erp_fiscal_invoices__invoice";
export const text = (v: unknown): string | null => (v == null ? null : String(v));
export const object = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
export const pick = (r: Json, keys: string): Json => Object.fromEntries(keys.split(" ").map((k) => [k, r[k] ?? null]));
export function rows(db: SqlDriver, table: string, clause = "", ...params: (string | number | null)[]): Json[] {
  return db.exec(`SELECT ${rowJsonSelect(table)} FROM "${table}" ${clause}`, ...params).rows.map((r) => rowJson(table, r));
}
export const invoiceRow = (db: SqlDriver, id: string | null) => rows(db, INVOICE, "WHERE id=?", id)[0] ?? null;
export function invoiceOrders(db: SqlDriver, id: string): Json[] {
  return db.exec(
    `SELECT d.id,d.kind,CAST(d.number AS TEXT) number,json_extract(d.body,'$.date') date,c.name contact_name
    FROM erp_fiscal_invoices__invoice_order o JOIN erp_documents__document d ON d.id=o.document_id
    LEFT JOIN erp_catalog__record c ON c.id=d.contact_id WHERE o.invoice_id=? ORDER BY d.number,d.id`,
    id,
  ).rows;
}
export function invoiceRecord(db: SqlDriver, id: string | null): Json | null {
  const v = invoiceRow(db, id);
  if (!v) return null;
  const r = pick(
    v,
    "id model direction issue_type environment status version series number access_key protocol authorized_at nature_id nature_description cfop issue_date exit_date exit_time crt purpose credit_debit_type presence final_consumer recipient export import_declaration auto_tax totals transport payment authorized_xml intermediary additional_info nature_additional_info nature_fiscal_info seller_id operation_destination created_at updated_at deleted_at delete_reason",
  );
  const amounts = one(
    db,
    `SELECT CAST(freight AS TEXT) freight,CAST(insurance AS TEXT) insurance,CAST(other_expenses AS TEXT) other_expenses,CAST(discount AS TEXT) discount FROM "${INVOICE}" WHERE id=?`,
    id,
  )!;
  for (const k of ["freight", "insurance", "other_expenses", "discount"]) r[k] = formatScaled(BigInt(String(amounts[k])), 2);
  r.references = v.doc_references;
  r.items = rows(db, "erp_fiscal_invoices__invoice_item", "WHERE invoice_id=? ORDER BY position", id).map((i) => ({ ...object(i.data), position: i.position }));
  r.orders = invoiceOrders(db, String(id));
  const seller = one(db, "SELECT r.name FROM erp_catalog__seller s JOIN erp_catalog__record r ON r.id=s.contact_id WHERE s.id=?", text(v.seller_id));
  r.seller_name = seller ? pgLeft(String(seller.name), 200) : null;
  return r;
}
export function invoiceEnvelope(r: Json, role: string) {
  return {
    invoice: r,
    writable:
      ["admin", "fiscal"].includes(role) && r.deleted_at === null && [1, 5, 8, 12].includes(Number(r.status)) && !["S", "X"].includes(String(r.issue_type)),
    emission_enabled: false,
    production_enabled: false,
    operational_effects: false,
    data_mode: "erp_native",
  };
}
export function orderEffects(ctx: RpcContext, id: string) {
  let stock = false,
    finance = false;
  for (const o of invoiceOrders(ctx.db, id).filter((o) => o.kind === "sales_orders")) {
    const f = effectFlags(ctx, String(o.id));
    stock ||= !!f.stock_active;
    finance ||= !!f.finance_active;
  }
  return { stock, finance };
}
export function editLocks(ctx: RpcContext, id: string) {
  const e = orderEffects(ctx, id);
  return {
    items: e.stock && preference(ctx.db, "nfe.bloquear_edicao_estoque", "boolean", false) === true,
    installments: e.finance && preference(ctx.db, "nfe.bloquear_edicao_contas", "boolean", false) === true,
  };
}

/** BEFORE UPDATE/DELETE. Recebe linhas decodificadas por invoiceRow. */
export function guardInvoice(op: "UPDATE" | "DELETE", old: Json, next: Json | null) {
  if (op === "DELETE") raise("42501", "erp_fiscal_invoice_no_delete");
  const n = next!;
  if (
    old.deleted_at != null ||
    ["id", "model", "direction", "created_at", "created_by"].some((k) => n[k] != null && old[k] != null && n[k] !== old[k]) ||
    n.environment !== old.environment ||
    old.version === 2147483647 ||
    (n.version != null && Number(n.version) !== Number(old.version) + 1)
  )
    raise("40001", "erp_fiscal_invoice_immutable_identity");
  if (
    n.protocol !== old.protocol ||
    n.authorized_at !== old.authorized_at ||
    (n.access_key !== old.access_key && n.issue_type != null && !["T", "S", "X"].includes(String(n.issue_type)))
  )
    raise("42501", "erp_fiscal_invoice_authorization_immutable");
}
export function xmlSourceEnvironment(xml: string | null): string | null {
  const env = (part: string | undefined) => part?.match(/<tpAmb>([12])<\/tpAmb>/)?.[1] ?? null;
  const ide = env(xml?.match(/<ide>.*?<\/ide>/s)?.[0]);
  const prot = env(xml?.match(/<infProt[^>]*>.*?<\/infProt>/s)?.[0]);
  return ide !== null && ide === prot ? ide : null;
}
/** AFTER INSERT em invoice_xml: a primeira proveniência é conservada. */
export function invoiceSourceRecord(ctx: RpcContext, next: { invoice_id: string; sha256: string; content: string }) {
  ctx.db.exec(
    `INSERT INTO erp_fiscal_invoices__invoice_source(invoice_id,xml_sha256,source_environment,recorded_at)
    VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING`,
    next.invoice_id,
    next.sha256,
    xmlSourceEnvironment(next.content),
    ctx.clock.next().toString(),
  );
}
export function companyText(p: Json, key: string, max: number) {
  return typeof p[key] === "string" && pgBtrim(p[key] as string) !== "" ? pgLeft(pgBtrim(p[key] as string), max) : null;
}
export const originInt = (v: unknown) => (/^[0-9]{1,9}$/.test(scalar(v, 20) ?? "") ? Number(v) : null);
export function originDate(v: unknown) {
  const d = (scalar(v, 40) ?? "").slice(0, 10);
  return /^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(d) && validDate(d) ? d : null;
}
export const originMoney = (v: unknown) => (/^-?[0-9]{1,13}(\.[0-9]{1,10})?$/.test(scalar(v, 25) ?? "") ? moneyText(String(v)) : null);
export const originNumber = (v: unknown) => originInt(digits(scalar(v, 20)).replace(/^0+/, "") || null);

/** As três tabelas do índice existem no motor: faz as mesmas escritas, inclusive o cursor com sobreposição de 15 minutos. */
export function originItemsRefresh(ctx: RpcContext, limit: number | null): number {
  const db = ctx.db;
  const s = one(db, "SELECT CAST(changed_at AS TEXT) changed_at FROM erp_fiscal_invoices__origin_item_state WHERE singleton=1");
  const from = s?.changed_at == null ? null : (BigInt(String(s.changed_at)) - 900000000n).toString();
  const sources = db.exec(
    `SELECT x.entity,x.source_id,x.version_hash,CAST(x.changed_at AS TEXT) changed_at,x.payload FROM origin_sync__raw_record x
    WHERE x.entity IN ('nfe','nfce') AND (? IS NULL OR x.changed_at>=CAST(? AS INTEGER)) AND NOT EXISTS(
      SELECT 1 FROM erp_fiscal_invoices__origin_item_source b WHERE b.entity=x.entity AND b.source_id=x.source_id AND b.version_hash=x.version_hash)
    ORDER BY x.changed_at,x.entity,x.source_id LIMIT ?`,
    from,
    from,
    limit ?? 2147483647,
  ).rows;
  let max = s?.changed_at == null ? null : BigInt(String(s.changed_at));
  for (const r of sources) {
    const entity = String(r.entity),
      id = String(r.source_id),
      p = JSON.parse(String(r.payload)) as Json;
    db.exec(
      `INSERT INTO erp_fiscal_invoices__origin_item_source(entity,source_id,version_hash,indexed_at) VALUES(?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET version_hash=excluded.version_hash,indexed_at=excluded.indexed_at`,
      entity,
      id,
      r.version_hash,
      ctx.clock.next().toString(),
    );
    db.exec("DELETE FROM erp_fiscal_invoices__origin_item_index WHERE entity=? AND source_id=?", entity, id);
    const contact = scalar(object(p.contato).id, 40),
      direction = entity === "nfce" ? "1" : scalar(p.tipo, 2);
    for (const [pos, value] of (Array.isArray(p.itens) ? p.itens : []).entries()) {
      const item = object(value),
        code = scalar(item.codigo, 60);
      if (contact === null || direction === null || code === null) continue;
      const quantity = scalar(item.quantidade, 30),
        price = scalar(item.valor, 30),
        total = originMoney(item.valorTotal);
      db.exec(
        `INSERT INTO erp_fiscal_invoices__origin_item_index(entity,source_id,position,contact_source,direction,product_code,number,series,issue_date,quantity,unit_price,total)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        entity,
        id,
        pos + 1,
        contact,
        direction,
        code,
        originNumber(p.numero),
        originInt(p.serie),
        originDate(p.dataEmissao),
        quantity !== null && /^[0-9]{1,12}(\.[0-9]{1,10})?$/.test(quantity) ? quantity : null,
        price !== null && /^[0-9]{1,13}(\.[0-9]{1,10})?$/.test(price) ? price : null,
        total === null ? null : toScaled(total, 2).toString(),
      );
    }
    const at = BigInt(String(r.changed_at));
    if (max === null || at > max) max = at;
  }
  db.exec(
    "UPDATE erp_fiscal_invoices__origin_item_state SET changed_at=?,refreshed_at=? WHERE singleton=1",
    max?.toString() ?? null,
    ctx.clock.next().toString(),
  );
  return sources.length;
}
export function originSellerIds(db: SqlDriver, seller: string): string[] {
  return db
    .exec(
      `SELECT DISTINCT r.source_id FROM origin_sync__raw_record r
    JOIN erp_catalog__origin o ON o.entity='contacts' AND o.source_id=json_extract(r.payload,'$.contato.id')
    JOIN erp_catalog__seller s ON s.contact_id=o.record_id WHERE r.entity='sellers' AND s.id=?`,
      seller,
    )
    .rows.map((r) => String(r.source_id));
}
/** NULLS LAST nos dois sentidos (datas ISO e números). */
export function compareNullable(a: unknown, b: unknown, desc = false): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : pgCompareText(String(a), String(b));
  return desc ? -c : c;
}
