// Estoque da nota: migrações 259 e 295 (última invoice_preview_data).
// A nota fiscal é somente lida. Os comandos e as transições de lançamento/fator
// cumprem guard_invoice_posting e guard_unit_conversion no ponto da escrita.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgUpper } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import * as preferences from "../../preferences/public.ts";
import { balanceKept, commandTaken, negativeAllowed, QTY_MAX, sha256 } from "../internal.ts";
import { invoiceAccess, invoiceFlag, invoiceReference } from "../invoice-read.ts";
import { invoiceScreen } from "../ledger.ts";
import { compositionLines } from "./document-stock.ts";
import { post } from "./erp_stock_post.ts";

type Row = Record<string, any>;
const parse = (v: any): any => typeof v === "string" ? JSON.parse(v) : v;
const t6 = (n: bigint) => formatScaled(n, 6);
const stamp = (v: any) => v == null ? null : jsonTimestamp(v);
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = (v: unknown) => sha256(jsonbText(v));
export const unitKey = (v: string | null) => v === null ? null : pgUpper(pgBtrim(v));
export const invoiceLabel = (model: string, number: number | null) => `${model === "65" ? "NFC-e" : "NF-e"} ${number === null ? "sem número" : String(number).padStart(6, "0").slice(0, 6)}`;
export function invoiceSummary(v: Row) {
  return { id: v.id, model: v.model, direction: v.direction, screen: invoiceScreen(v.model, v.direction), number: v.number, series: v.series, status: v.status,
    version: v.version, label: invoiceLabel(v.model, v.number), issue_date: v.issue_date, exit_date: v.exit_date, deleted: v.deleted_at !== null };
}
export function invoiceDay(db: SqlDriver, issue: string | null, exit: string | null) {
  const today = todaySaoPaulo(), day = exit ?? issue ?? today;
  return preferences.get(db, "estoque.data_lancamento") === "data_documento" && day < today ? day : today;
}
export function invoicePostingDto(db: SqlDriver, id: string) {
  const p = one(db, 'SELECT * FROM "erp_stock__invoice_posting" WHERE id=?', id) as Row | null;
  if (!p) return null;
  const s = parse(p.snapshot);
  return { id: p.id, invoice_id: p.invoice_id, invoice_version: p.invoice_version, source: p.source, state: p.state, version: p.version,
    warehouse: { id: p.warehouse_id, name: one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', p.warehouse_id)?.name ?? null }, movement_id: p.movement_id,
    occurred_on: arrow(s, "occurred_on"), direction: arrow(s, "direction"), positions: s.positions?.length ?? null, ignored_items: s.ignored?.length ?? null,
    created_at: stamp(p.created_at), reversal_movement_id: p.reversal_movement_id, reversed_at: stamp(p.reversed_at) };
}
export const invoiceReserved = (db: SqlDriver, invoice: string) => !!one(db, `SELECT 1 FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_stock__reservation" r ON r.document_id=o.document_id AND r.state='active' WHERE o.invoice_id=?`, invoice);
export function invoiceBlock(db: SqlDriver, v: Row) {
  if (v.deleted_at !== null) return "deleted";
  if (v.status === 3) return "cancelled";
  if (v.status === 10) return "denied";
  if (one(db, `SELECT 1 FROM "erp_stock__invoice_posting" WHERE invoice_id=? AND state='active'`, v.id)) return "posted";
  if (invoiceReference(db, v.id)) return "reference";
  if (invoiceReserved(db, v.id)) return "reserved";
  if (!one(db, 'SELECT 1 FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? AND product_id IS NOT NULL', v.id)) return "no_products";
  return null;
}
export function invoiceLock(db: SqlDriver, actor: string, invoice: string | null, version: number | null): Row {
  if (invoice === null) raise("22023", "erp_invoice_stock_invalid");
  invoiceAccess(db, actor, true);
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', invoice);
  if (!v) raise("P0002", "erp_invoice_not_found");
  if (version !== null && v.version !== version) raise("40001", "erp_invoice_stock_version_conflict");
  return v;
}
export function invoiceSupplier(db: SqlDriver, v: Row): string | null {
  const id = arrow(parse(v.recipient), "contact_id");
  return id && UUID.test(id) && one(db, 'SELECT 1 FROM "erp_catalog__contact" WHERE record_id=?', id) ? id : null;
}
export function invoiceUnitRule(db: SqlDriver, supplier: string | null, product: string, productUnit: string, itemUnit: string | null, data: Row, quantity: bigint, itemQuantity: bigint): Row | null {
  const c = supplier === null ? null : one(db, 'SELECT factor FROM "erp_stock__unit_conversion" WHERE product_id=? AND supplier_id=? AND unit=?', product, supplier, unitKey(itemUnit));
  if (c) {
    const factor = fromColumn(c.factor), numerator = quantity * factor;
    const rule = { conversion: "supplier", factor: t6(factor) };
    if (numerator > QTY_MAX * 1000000n) return { ...rule, problem: "excess" };
    if (numerator % 1000000n) return { ...rule, problem: "inexact" };
    return { ...rule, quantity: t6(numerator / 1000000n) };
  }
  const tax = data?.others, taxQuantity = arrow(tax, "tax_quantity");
  if (jsonType(tax) === "object" && unitKey(arrow(tax, "tax_unit")) === unitKey(productUnit) && taxQuantity !== null && /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(taxQuantity) && toScaled(taxQuantity, 6) > 0n) {
    const tq = toScaled(taxQuantity, 6), numerator = tq * quantity;
    const q = quantity === itemQuantity ? tq : (numerator + itemQuantity / 2n) / itemQuantity;
    const rule = { conversion: "tax_unit" };
    if (q > QTY_MAX) return { ...rule, problem: "excess" };
    if (q * itemQuantity !== numerator || q <= 0n) return { ...rule, problem: "inexact" };
    return { ...rule, quantity: t6(q) };
  }
  return null;
}
export function invoicePreviewData(db: SqlDriver, v: Row, warehouse: string, source: string, lines: Row[] | null = null): Row {
  if (!["invoice", "checkin"].includes(source) || (source === "checkin") !== (lines !== null)) raise("22023", "erp_invoice_stock_invalid");
  const direction = v.direction === "0" ? "receipt" : "issue";
  if (one(db, `SELECT 1 FROM "erp_stock__invoice_posting" WHERE invoice_id=? AND state='active'`, v.id)) raise("40001", "erp_invoice_stock_already_posted");
  if (invoiceReference(db, v.id)) raise("40001", "erp_invoice_stock_posted_by_reference");
  if (invoiceReserved(db, v.id)) raise("40001", "erp_invoice_stock_reserved_document");
  const w = one(db, 'SELECT r.* FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=? AND r.active=1', warehouse);
  if (!w) raise("22023", "erp_stock_warehouse_unavailable");
  const supplier = direction === "receipt" ? invoiceSupplier(db, v) : null;
  const ignored: Row[] = [], groups = new Map<string, { quantity: bigint; sources: Row[] }>();
  const add = (product: string, q: bigint, origin: Row) => { const g = groups.get(product) ?? { quantity: 0n, sources: [] }; g.quantity += q; g.sources.push(origin); groups.set(product, g); };
  const rows = db.exec(`SELECT i.*,r.active,p.unit,p.kind,p.format FROM "erp_fiscal_invoices__invoice_item" i
    LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.invoice_id=? ORDER BY i.position`, v.id).rows as Row[];
  for (const row of rows) {
    const line = lines?.find(l => l.position === row.position);
    if (source === "checkin" && !line) continue;
    const q = source === "checkin" ? toScaled(line!.quantity, 6) : fromColumn(row.quantity) * 100n, data = parse(row.data), itemUnit = arrow(data, "unit");
    if (row.product_id === null || row.kind === "S") {
      ignored.push({ position: row.position, product_id: row.product_id, description: pgLeft(arrow(data, "description") ?? "", 120), quantity: t6(q), unit: itemUnit, reason: row.product_id === null ? "unlinked_item" : "service" });
    } else if (row.kind !== "P" || !row.active || row.unit === null) raise("22023", "erp_stock_product_unavailable");
    else if (row.format === "V" || (row.format === "E" && direction === "receipt")) raise("22023", "erp_invoice_stock_composition_unsupported");
    else if (unitKey(row.unit) !== unitKey(itemUnit)) {
      const rule = direction === "receipt" ? invoiceUnitRule(db, supplier, row.product_id, row.unit, itemUnit, data, q, fromColumn(row.quantity) * 100n) : null;
      if (rule === null) raise("22023", "erp_invoice_stock_unit_mismatch");
      if (rule.problem) raise("22023", "erp_invoice_stock_conversion_inexact");
      add(row.product_id, toScaled(rule.quantity, 6), { position: row.position, quantity: rule.quantity, invoice_quantity: t6(q), invoice_unit: itemUnit, conversion: rule.conversion, ...(rule.factor ? { factor: rule.factor } : {}) });
    } else if (row.format === "E") {
      for (const l of compositionLines(db, row.product_id, q)) {
        const quantity = l.quantity!;
        add(l.product_id, quantity, l.role === "composition" ? { position: row.position, quantity: t6(q) } : { position: row.position, quantity: t6(quantity), kit_product_id: row.product_id, kit_quantity: t6(q), component_quantity: t6(l.per_kit / 10n ** 24n) });
      }
    } else add(row.product_id, q, { position: row.position, quantity: t6(q) });
  }
  const positions = [...groups].sort(([a], [b]) => pgCompareText(a, b)).map(([id, g]) => {
    // O cast de sum(qty) para numeric(18,6) precede a guarda de saldo.
    if (g.quantity > QTY_MAX || g.quantity < -QTY_MAX) raise("22003", "numeric field overflow");
    const r = one(db, 'SELECT r.name,r.version,p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', id)!;
    const b = one(db, 'SELECT CAST(quantity AS TEXT) quantity,version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', id, warehouse);
    const q = direction === "issue" ? -g.quantity : g.quantity, before = b ? fromColumn(b.quantity) : 0n;
    return { product_id: id, product_name: r.name, catalog_version: r.version, warehouse_id: warehouse, unit: r.unit, quantity: t6(q), balance_before: t6(before), balance_after: t6(before + q), expected_version: b?.version ?? 0, sources: g.sources };
  });
  if (positions.length < 1 || positions.length > 100) raise("22023", "erp_invoice_stock_position_limit");
  if (positions.some(p => { const q = toScaled(p.quantity, 6), after = toScaled(p.balance_after, 6); return (q < 0n && after < 0n && !negativeAllowed(db)) || after > QTY_MAX || after < -QTY_MAX || p.expected_version === 2147483647; })) raise("22023", "erp_stock_insufficient_or_excess_quantity");
  const result = { action: "post", source, invoice: invoiceSummary(v), direction, occurred_on: invoiceDay(db, v.issue_date, v.exit_date),
    reason: (source === "checkin" ? "Check-in de recebimento da " : "Lançamento de estoque da ") + invoiceLabel(v.model, v.number),
    warehouse: { id: w.id, name: w.name, version: w.version, active: !!w.active }, positions, ignored };
  return { ...result, preview_hash: hash(result) };
}
export function invoiceReversePreviewData(db: SqlDriver, v: Row, p: Row): Row {
  const positions = db.exec(`SELECT e.product_id,e.warehouse_id,e.unit,CAST(e.quantity AS TEXT) quantity,CAST(b.quantity AS TEXT) balance,b.version,r.name,r.version catalog_version
    FROM "erp_stock__entry" e JOIN "erp_stock__balance" b ON b.product_id=e.product_id AND b.warehouse_id=e.warehouse_id JOIN "erp_catalog__record" r ON r.id=e.product_id WHERE e.movement_id=?`, p.movement_id).rows
    .sort((a, b) => pgCompareText(String(a.product_id), String(b.product_id)) || pgCompareText(String(a.warehouse_id), String(b.warehouse_id)))
    .map(e => ({ product_id: e.product_id, product_name: e.name, catalog_version: e.catalog_version, warehouse_id: e.warehouse_id, unit: e.unit,
      quantity: t6(-fromColumn(e.quantity)), balance_before: t6(fromColumn(e.balance)), balance_after: t6(fromColumn(e.balance) - fromColumn(e.quantity)), expected_version: e.version, sources: [],
      ...(balanceKept(db, p.movement_id, String(e.product_id), String(e.warehouse_id)) ? { balance_kept: true } : {}) }));
  if (positions.length < 1 || positions.length > 100 || positions.some(p => { const after = toScaled(p.balance_after, 6), q = toScaled(p.quantity, 6); return (after < 0n && q < 0n && !negativeAllowed(db) && !p.balance_kept) || after > QTY_MAX || p.expected_version === 2147483647; })) raise("22023", "erp_stock_insufficient_or_excess_quantity");
  const day = String(one(db, 'SELECT occurred_on FROM "erp_stock__movement" WHERE id=?', p.movement_id)!.occurred_on), today = todaySaoPaulo();
  const result = { action: "reverse", invoice: invoiceSummary(v), posting: invoicePostingDto(db, p.id), direction: "reversal", occurred_on: day > today ? day : today,
    reason: "Estorno do estoque da " + invoiceLabel(v.model, v.number), warehouse: { id: p.warehouse_id, name: one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', p.warehouse_id)?.name ?? null }, positions, ignored: [] };
  return { ...result, preview_hash: hash(result) };
}
export function invoiceReplay(db: SqlDriver, a: Row, action: string, h: string): Row | null {
  if (a.p_command_id === null) raise("22023", "erp_invoice_stock_invalid");
  invoiceAccess(db, a.p_user_id, true);
  const c = one(db, 'SELECT * FROM "erp_stock__invoice_command" WHERE id=?', a.p_command_id);
  if (c) {
    if (c.actor !== a.p_user_id || c.action !== action || c.invoice_id !== a.p_invoice_id || c.request_hash !== h) raise("40001", "erp_invoice_stock_conflict");
    return { ...parse(c.result), flag: invoiceFlag(db, a.p_invoice_id), replayed: true };
  }
  if (commandTaken(db, a.p_command_id)) raise("40001", "erp_invoice_stock_conflict");
  return null;
}
function saveCommand(ctx: RpcContext, a: Row, action: string, h: string, result: Row) {
  ctx.db.exec('INSERT INTO "erp_stock__invoice_command"(id,actor,action,invoice_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)', a.p_command_id, a.p_user_id, action, a.p_invoice_id, h, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, flag: invoiceFlag(ctx.db, a.p_invoice_id), replayed: false };
}
const movementItems = (preview: Row) => preview.positions.map((p: Row) => ({ product_id: p.product_id, warehouse_id: p.warehouse_id, quantity: p.quantity, expected_version: p.expected_version }));
export function saveInvoicePosting(ctx: RpcContext, a: Row, v: Row, preview: Row, source: string, h: string, extra: Row = {}) {
  const movement = post(ctx, { user: a.p_user_id, command: a.p_command_id, kind: preview.direction, occurredOn: preview.occurred_on, reason: preview.reason, reference: invoiceLabel(v.model, v.number), items: movementItems(preview) }) as Row;
  if (movement.replayed !== false) raise("40001", "erp_invoice_stock_conflict");
  const id = crypto.randomUUID(), { preview_hash, ...snapshot } = preview;
  ctx.db.exec(`INSERT INTO "erp_stock__invoice_posting"(id,invoice_id,invoice_version,source,warehouse_id,movement_id,state,version,snapshot,preview_hash,actor,command_id,created_at) VALUES(?,?,?,?,?,?,'active',1,?,?,?,?,?)`, id, v.id, v.version, source, a.p_warehouse_id, movement.movement.id, JSON.stringify(snapshot), preview_hash, a.p_user_id, a.p_command_id, ctx.clock.next().toString());
  return saveCommand(ctx, a, source === "checkin" ? "checkin" : "post", h, { scope: source === "checkin" ? "stock_checkin_post" : "stock_invoice_post", data_mode: "erp_native", command_id: a.p_command_id, invoice: invoiceSummary(v), posting: invoicePostingDto(ctx.db, id), movement: movement.movement, ...extra });
}
registerRpc("erp_stock_invoice_flags", ({ db }, a) => {
  invoiceAccess(db, a.p_user_id as string, false);
  const ids = jsonbArg(a.p_ids);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) raise("22023", "erp_stock_invalid_query");
  return { scope: "stock_invoice_flags", data_mode: "erp_native", items: ids.slice().sort(pgCompareText).filter(id => one(db, 'SELECT 1 FROM "erp_fiscal_invoices__invoice" WHERE id=?', id)).map(id => ({ invoice_id: id, ...invoiceFlag(db, id) })) };
});
registerRpc("erp_stock_invoice_get", ({ db }, a) => {
  const role = invoiceAccess(db, a.p_user_id as string, false), v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', a.p_invoice_id);
  if (!v) raise("P0002", "erp_invoice_not_found");
  const w = one(db, 'SELECT r.id,r.name FROM "erp_stock__warehouse_default" d JOIN "erp_catalog__record" r ON r.id=d.warehouse_id WHERE r.active=1');
  const postings = db.exec('SELECT id,created_at FROM "erp_stock__invoice_posting" WHERE invoice_id=?', v.id).rows.sort((a, b) => Number(b.created_at) - Number(a.created_at) || pgCompareText(String(a.id), String(b.id))).slice(0, 20);
  return { scope: "stock_invoice", data_mode: "erp_native", invoice: invoiceSummary(v), flag: invoiceFlag(db, String(v.id)), block: invoiceBlock(db, v), can_manage: ["admin", "estoque"].includes(role),
    occurred_on: invoiceDay(db, v.issue_date as string, v.exit_date as string | null), date_mode: preferences.get(db, "estoque.data_lancamento") ?? "data_atual", checkin_post: preferences.get(db, "nfe.estoque_checkin") === true,
    default_warehouse: w ?? null, postings: postings.map(p => invoicePostingDto(db, String(p.id))) };
});
function invoicePost(ctx: RpcContext, a: Row, write: boolean) {
  invoiceAccess(ctx.db, a.p_user_id, true);
  if (a.p_expected_version === null || a.p_expected_version < 1 || a.p_warehouse_id === null || (write && (a.p_preview_hash === null || !/^[a-f0-9]{64}$/.test(a.p_preview_hash)))) raise("22023", "erp_invoice_stock_invalid");
  const h = write ? hash({ profile: "stock-invoice-post-259", actor: a.p_user_id, invoice_id: a.p_invoice_id, version: a.p_expected_version, warehouse_id: a.p_warehouse_id, hash: a.p_preview_hash }) : "";
  if (write) { const replay = invoiceReplay(ctx.db, a, "post", h); if (replay) return replay; }
  const v = invoiceLock(ctx.db, a.p_user_id, a.p_invoice_id, a.p_expected_version);
  if (["deleted", "cancelled", "denied", "no_products"].includes(invoiceBlock(ctx.db, v) ?? "")) raise("40001", "erp_invoice_stock_ineligible");
  const preview = invoicePreviewData(ctx.db, v, a.p_warehouse_id, "invoice");
  if (!write) return { scope: "stock_invoice_preview", data_mode: "erp_native", preview };
  if (a.p_preview_hash !== preview.preview_hash) raise("40001", "erp_invoice_stock_preview_conflict");
  return saveInvoicePosting(ctx, a, v, preview, "invoice", h);
}
registerRpc("erp_stock_invoice_preview", (ctx, a) => invoicePost(ctx, a, false));
registerRpc("erp_stock_invoice_post", (ctx, a) => invoicePost(ctx, a, true));
function invoiceReverse(ctx: RpcContext, a: Row, write: boolean) {
  const db = ctx.db;
  invoiceAccess(db, a.p_user_id, true);
  if (a.p_posting_id === null || a.p_posting_version === null || a.p_posting_version < 1 || (write && (a.p_preview_hash === null || !/^[a-f0-9]{64}$/.test(a.p_preview_hash)))) raise("22023", "erp_invoice_stock_invalid");
  const h = write ? hash({ profile: "stock-invoice-reverse-259", actor: a.p_user_id, invoice_id: a.p_invoice_id, posting_id: a.p_posting_id, posting_version: a.p_posting_version, hash: a.p_preview_hash }) : "";
  if (write) { const replay = invoiceReplay(db, a, "reverse", h); if (replay) return replay; }
  const v = invoiceLock(db, a.p_user_id, a.p_invoice_id, null), p = one(db, 'SELECT * FROM "erp_stock__invoice_posting" WHERE id=? AND invoice_id=?', a.p_posting_id, v.id) as Row | null;
  if (!p) raise("P0002", "erp_invoice_stock_not_found");
  if (p.state !== "active" || p.version !== a.p_posting_version) raise("40001", "erp_invoice_stock_version_conflict");
  const preview = invoiceReversePreviewData(db, v, p);
  if (!write) return { scope: "stock_invoice_reverse_preview", data_mode: "erp_native", preview };
  if (a.p_preview_hash !== preview.preview_hash) raise("40001", "erp_invoice_stock_preview_conflict");
  const movement = post(ctx, { user: a.p_user_id, command: a.p_command_id, kind: "reversal", occurredOn: preview.occurred_on, reason: preview.reason, reference: "Estorno " + invoiceLabel(v.model, v.number), items: movementItems(preview), reversesId: p.movement_id }) as Row;
  if (movement.replayed !== false) raise("40001", "erp_invoice_stock_conflict");
  // Única transição permitida pelo gatilho: estornar o próprio movimento,
  // preservar a cópia e avançar uma versão. post já validou reverses_id.
  db.exec(`UPDATE "erp_stock__invoice_posting" SET state='reversed',version=version+1,reversal_movement_id=?,reversed_at=?,reversed_by=?,reversal_command_id=? WHERE id=?`, movement.movement.id, ctx.clock.next().toString(), a.p_user_id, a.p_command_id, p.id);
  return saveCommand(ctx, a, "reverse", h, { scope: "stock_invoice_reverse", data_mode: "erp_native", command_id: a.p_command_id, invoice: invoiceSummary(v), posting: invoicePostingDto(db, p.id), movement: movement.movement, balance_adjustments: movement.balance_adjustments ?? [] });
}
registerRpc("erp_stock_invoice_reverse_preview", (ctx, a) => invoiceReverse(ctx, a, false));
registerRpc("erp_stock_invoice_reverse", (ctx, a) => invoiceReverse(ctx, a, true));

export function invoiceUnitsDto(db: SqlDriver, role: string, v: Row) {
  const supplier = invoiceSupplier(db, v);
  const rows = db.exec(`SELECT i.*,r.id,r.name,r.code,p.unit FROM "erp_fiscal_invoices__invoice_item" i JOIN "erp_catalog__record" r ON r.id=i.product_id
    JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.invoice_id=? AND p.kind='P' AND p.unit IS NOT NULL AND coalesce(p.format,'S') NOT IN ('E','V') ORDER BY i.position`, v.id).rows as Row[];
  const items = rows.filter(i => v.direction === "0" && unitKey(i.unit) !== unitKey(arrow(parse(i.data), "unit")));
  const s = supplier === null ? null : one(db, 'SELECT id,name FROM "erp_catalog__record" WHERE id=?', supplier);
  return { scope: "stock_invoice_units", data_mode: "erp_native", invoice: invoiceSummary(v), supplier: s,
    can_manage: ["admin", "estoque"].includes(role) && v.direction === "0" && v.deleted_at === null, total: items.length,
    items: items.slice(0, 100).map(i => {
      const data = parse(i.data), unit = arrow(data, "unit"), q = fromColumn(i.quantity) * 100n, tax = data.others;
      const c = one(db, 'SELECT factor,version FROM "erp_stock__unit_conversion" WHERE supplier_id=? AND product_id=? AND unit=?', supplier, i.id, unitKey(unit));
      const rule = invoiceUnitRule(db, supplier, i.id, i.unit, unit, data, q, q);
      return { position: i.position, description: pgLeft(arrow(data, "description") ?? "", 120), unit, quantity: t6(q), product: { id: i.id, name: i.name, code: i.code, unit: i.unit },
        tax: jsonType(tax) === "object" && (arrow(tax, "tax_unit") ?? "") !== "" ? { unit: arrow(tax, "tax_unit"), quantity: arrow(tax, "tax_quantity") } : null,
        factor: c ? { factor: t6(fromColumn(c.factor)), version: c.version } : null, rule: rule?.conversion ?? null, converted_quantity: rule?.quantity ?? null, problem: rule?.problem ?? null };
    }) };
}
registerRpc("erp_stock_invoice_units", ({ db }, a) => {
  const role = invoiceAccess(db, a.p_user_id as string, false);
  if (a.p_invoice_id === null) raise("22023", "erp_invoice_stock_invalid");
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', a.p_invoice_id);
  if (!v) raise("P0002", "erp_invoice_not_found");
  return invoiceUnitsDto(db, role, v);
});
registerRpc("erp_stock_invoice_unit_save", (ctx, args) => {
  const a: Row = args, db = ctx.db, role = invoiceAccess(db, a.p_user_id, true);
  if (a.p_command_id === null || a.p_invoice_id === null || a.p_position === null || a.p_position < 1 || a.p_position > 990 || a.p_expected_version === null || a.p_expected_version < 0 || a.p_expected_version > 2147483646 ||
    (a.p_factor !== null && (!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(a.p_factor) || toScaled(a.p_factor, 6) === 0n)) || (a.p_factor === null && a.p_expected_version === 0)) raise("22023", "erp_stock_unit_conversion_invalid");
  const h = hash({ profile: "stock-invoice-unit-295", actor: a.p_user_id, invoice_id: a.p_invoice_id, position: a.p_position, expected_version: a.p_expected_version, factor: a.p_factor });
  const command = one(db, 'SELECT actor,request_hash,result FROM "erp_stock__unit_conversion_command" WHERE id=?', a.p_command_id);
  if (command) {
    if (command.actor !== a.p_user_id || command.request_hash !== h) raise("40001", "erp_stock_unit_conversion_conflict");
    return { ...parse(command.result), replayed: true };
  }
  if (commandTaken(db, a.p_command_id)) raise("40001", "erp_stock_unit_conversion_conflict");
  const v = invoiceLock(db, a.p_user_id, a.p_invoice_id, null);
  if (v.deleted_at !== null || v.direction !== "0") raise("22023", "erp_stock_unit_conversion_unavailable");
  const supplier = invoiceSupplier(db, v);
  if (!supplier) raise("22023", "erp_stock_unit_conversion_unavailable");
  const i = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? AND position=?', v.id, a.p_position);
  if (!i) raise("P0002", "erp_invoice_item_not_found");
  const p = one(db, 'SELECT * FROM "erp_catalog__product" WHERE record_id=?', i.product_id);
  if (!p || p.kind !== "P" || p.unit === null || ["E", "V"].includes(String(p.format))) raise("22023", "erp_stock_unit_conversion_unavailable");
  const unit = unitKey(arrow(parse(i.data), "unit"));
  if (!unit || pgLength(unit) > 6 || pgHasCntrl.test(unit) || unit === unitKey(String(p.unit))) raise("22023", "erp_stock_unit_conversion_unavailable");
  const k = one(db, 'SELECT factor,version FROM "erp_stock__unit_conversion" WHERE product_id=? AND supplier_id=? AND unit=?', p.record_id, supplier, unit);
  if ((k?.version ?? 0) !== a.p_expected_version) raise("40001", "erp_stock_unit_conversion_version_conflict");
  const factor = a.p_factor === null ? null : toScaled(a.p_factor, 6);
  if ((k ? fromColumn(k.factor) : null) === factor) raise("22023", "erp_stock_unit_conversion_unchanged");
  if (factor === null) db.exec('DELETE FROM "erp_stock__unit_conversion" WHERE product_id=? AND supplier_id=? AND unit=?', p.record_id, supplier, unit);
  else if (!k) db.exec('INSERT INTO "erp_stock__unit_conversion"(product_id,supplier_id,unit,factor,version,updated_by,command_id,updated_at) VALUES(?,?,?,?,1,?,?,?)', p.record_id, supplier, unit, factor.toString(), a.p_user_id, a.p_command_id, ctx.clock.next().toString());
  else db.exec('UPDATE "erp_stock__unit_conversion" SET factor=?,version=version+1,updated_at=?,updated_by=?,command_id=? WHERE product_id=? AND supplier_id=? AND unit=?', factor.toString(), ctx.clock.next().toString(), a.p_user_id, a.p_command_id, p.record_id, supplier, unit);
  const { scope, data_mode, ...units } = invoiceUnitsDto(db, role, v);
  const result = { scope: "stock_invoice_unit_save", data_mode, command_id: a.p_command_id, position: a.p_position, product_id: p.record_id, supplier_id: supplier, unit, product_unit: p.unit,
    before: k ? { factor: t6(fromColumn(k.factor)), version: k.version } : null, after: factor === null ? null : { factor: t6(factor), version: Number(k?.version ?? 0) + 1 }, saved_at: stamp(ctx.clock.next().toString()), units };
  db.exec('INSERT INTO "erp_stock__unit_conversion_command"(id,actor,invoice_id,product_id,supplier_id,unit,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)', a.p_command_id, a.p_user_id, v.id, p.record_id, supplier, unit, h, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
});
