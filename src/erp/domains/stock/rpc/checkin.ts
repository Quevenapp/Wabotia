// Check-in: corpos finais das migrações 147/181; integração ao estoque em 259.
// Os escritores abaixo cumprem guard_checkin/guard_checkin_item: somente avanço
// de versão, cópia no início/reinício, item recusado e conferência finalizada imutáveis.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgCompareText, pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { commandTaken, sha256, supplyPart } from "../internal.ts";
import { invoiceAccess } from "../invoice-read.ts";
import { checkinAccess, checkinNoteDto, checkinNoteOpen as noteOpen } from "./dashboards.ts";
import { invoiceLock, invoicePreviewData, invoiceReplay, saveInvoicePosting } from "./invoice-stock.ts";

type Row = Record<string, any>;
const parse = (v: any): any => typeof v === "string" ? JSON.parse(v) : v;
const t4 = (v: any) => v == null ? null : formatScaled(fromColumn(v), 4);
const stamp = (v: any) => v == null ? null : jsonTimestamp(v);
const quantity = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$/;
const inputInvalid = () => raise("22023", "erp_stock_checkin_input_invalid");
const hash = (v: unknown) => sha256(jsonbText(v));

const checkinNoteOpen = (v: Row) => noteOpen(v.direction, v.deleted_at, v.status);
export const checkinItemState = (received: bigint, quantity: bigint, issue: unknown) => issue != null ? "issue" : received === 0n ? "pending" : received < quantity ? "in_progress" : "complete";

export function checkinRequested(db: SqlDriver, invoice: string, product: string | null) {
  if (product === null || !one(db, `SELECT 1 FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id WHERE o.invoice_id=? AND d.kind='purchase_orders'`, invoice)) return null;
  const rows = db.exec(`SELECT CAST(i.quantity AS TEXT) quantity, i.unit_price FROM "erp_fiscal_invoices__invoice_order" o
    JOIN "erp_documents__document" d ON d.id=o.document_id AND d.kind='purchase_orders'
    JOIN "erp_documents__item" i ON i.document_id=d.id AND i.product_id=? WHERE o.invoice_id=?`, product, invoice).rows;
  // Documentos armazena quantidade em escala 6; a projeção do check-in tem 4.
  const total = rows.reduce((n, r) => n + fromColumn(r.quantity ?? 0), 0n);
  const prices = [...new Set(rows.map(r => r.unit_price === null ? null : formatScaled(toScaled(String(r.unit_price), 10), 10)))]
    .sort((a, b) => a === null ? b === null ? 0 : 1 : b === null ? -1 : pgCompareText(a, b));
  return { quantity: formatScaled((total + 50n) / 100n, 4), prices };
}
function currentItems(db: SqlDriver, invoice: string): Row[] {
  const c = one(db, 'SELECT id FROM "erp_stock__checkin" WHERE invoice_id=?', invoice);
  if (c) return db.exec('SELECT * FROM "erp_stock__checkin_item" WHERE checkin_id=? ORDER BY position', c.id).rows;
  return db.exec('SELECT * FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? ORDER BY position', invoice).rows.map(i => {
    const data = parse(i.data);
    return { ...i, description: arrow(data, "description") ?? "", supplier_code: arrow(data, "code"), gtin: arrow(data, "gtin"), unit: arrow(data, "unit"), received: 0, issue: null, issue_quantity: null, issue_action: null };
  });
}
export function checkinItems(db: SqlDriver, invoice: string) {
  const recipient = parse(one(db, 'SELECT recipient FROM "erp_fiscal_invoices__invoice" WHERE id=?', invoice)?.recipient);
  const contact = arrow(recipient, "contact_id");
  const supplier = contact && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(contact) ? contact.toLowerCase() : null;
  return currentItems(db, invoice).map(i => {
    const r = one(db, 'SELECT code FROM "erp_catalog__record" WHERE id=?', i.product_id);
    const p = one(db, 'SELECT gtin FROM "erp_catalog__product" WHERE record_id=?', i.product_id);
    return {
      position: i.position, product_id: i.product_id, product_code: r?.code ?? null, product_gtin: p?.gtin ?? null,
      description: i.description, supplier_code: i.supplier_code, gtin: i.gtin, unit: i.unit, quantity: t4(i.quantity),
      unit_price: formatScaled(toScaled(String(i.unit_price), 10), 10), received: t4(i.received), issue: i.issue,
      issue_quantity: t4(i.issue_quantity), issue_action: i.issue_action,
      state: checkinItemState(fromColumn(i.received), fromColumn(i.quantity), i.issue), requested: checkinRequested(db, invoice, i.product_id),
      catalog_supplier_code: one(db, 'SELECT code FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', i.product_id, supplier)?.code ?? null,
      product_duns: db.exec('SELECT code, CAST(quantity AS TEXT) quantity FROM "erp_catalog__product_dun" WHERE record_id=? ORDER BY position', i.product_id).rows.map(d => ({ code: d.code, quantity: formatScaled(fromColumn(d.quantity), 6) })),
    };
  });
}
export function checkinDto(db: SqlDriver, invoice: string) {
  const c = one(db, 'SELECT * FROM "erp_stock__checkin" WHERE invoice_id=?', invoice) as Row | null;
  const items = checkinItems(db, invoice), note = checkinNoteDto(db, invoice);
  const name = (id: string) => { const n = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', id)?.name; return n == null ? null : pgLeft(String(n), 120); };
  return { note,
    checkin: c ? { id: c.id, state: c.state, version: c.version, invoice_version: c.invoice_version, stale: c.invoice_version !== note?.invoice_version,
      started_at: stamp(c.started_at), updated_at: stamp(c.updated_at), finished_at: stamp(c.finished_at) } : null,
    responsible: c ? { started_by_name: name(c.started_by), finished_by_name: name(c.finished_by) } : null,
    version: c?.version ?? 0, items,
    summary: { total: items.length, complete: items.filter(i => i.state === "complete").length, issue: items.filter(i => i.state === "issue" && i.issue !== "refused").length,
      refused: items.filter(i => i.issue === "refused").length, pending: items.filter(i => ["pending", "in_progress"].includes(i.state)).length },
    events: db.exec('SELECT * FROM (SELECT * FROM "erp_stock__checkin_event" WHERE checkin_id=? ORDER BY id DESC LIMIT 500) ORDER BY id', c?.id ?? null).rows.map(e => ({ id: e.id, action: e.action, position: e.position, description: e.description, quantity: t4(e.quantity), previous: t4(e.previous), at: stamp(e.created_at) })),
  };
}
registerRpc("erp_stock_checkin_get", ({ db }, a) => {
  const role = checkinAccess(db, a.p_user_id as string, false);
  if (a.p_invoice_id === null) raise("22023", "erp_stock_invalid_query");
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', a.p_invoice_id) as Row | null;
  if (!v || v.direction !== "0" || (!checkinNoteOpen(v) && !one(db, 'SELECT 1 FROM "erp_stock__checkin" WHERE invoice_id=?', v.id))) raise("P0002", "erp_stock_checkin_note_not_found");
  return { ...checkinDto(db, v.id), scope: "stock_checkin", data_mode: "erp_native", can_manage: ["admin", "estoque"].includes(role) };
});

function checkinBegin(db: SqlDriver, a: Row, action: string, h: string) {
  checkinAccess(db, a.p_user_id, true);
  const k = one(db, 'SELECT * FROM "erp_stock__checkin_command" WHERE id=?', a.p_command_id);
  if (k) {
    if (k.actor !== a.p_user_id || k.action !== action || k.invoice_id !== a.p_invoice_id || k.request_hash !== h) raise("40001", "erp_stock_checkin_command_conflict");
    return { replay: { ...parse(k.result), ...checkinDto(db, a.p_invoice_id), replayed: true }, v: null, c: null };
  }
  if (commandTaken(db, a.p_command_id)) raise("40001", "erp_stock_checkin_command_conflict");
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', a.p_invoice_id) as Row | null;
  if (!v || v.direction !== "0") raise("P0002", "erp_stock_checkin_note_not_found");
  const c = one(db, 'SELECT * FROM "erp_stock__checkin" WHERE invoice_id=?', v.id) as Row | null;
  if ((c?.version ?? 0) !== a.p_expected_version || c?.version === 2147483647) raise("40001", "erp_stock_checkin_version_conflict");
  if (c?.state === "finished") raise("40001", "erp_stock_checkin_finished");
  if (!checkinNoteOpen(v)) raise("40001", "erp_stock_checkin_note_closed");
  if (action !== "restart" && c && c.invoice_version !== v.version) raise("40001", "erp_stock_checkin_note_changed");
  if (!c && !one(db, 'SELECT 1 FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=?', v.id)) raise("22023", "erp_stock_checkin_note_empty");
  return { replay: null, v, c };
}
function checkinAdvance(ctx: RpcContext, a: Row, action: string, h: string, v: Row, c: Row | null, detail: unknown) {
  const db = ctx.db, at = ctx.clock.next().toString(), id = c?.id ?? crypto.randomUUID();
  const result = { scope: "stock_checkin", data_mode: "erp_native", receipt: { command_id: a.p_command_id, action, invoice_id: v.id,
    from_version: c?.version ?? 0, to_version: (c?.version ?? 0) + (action === "finish" ? 2 : 1), detail, saved_at: stamp(at) } };
  db.exec('INSERT INTO "erp_stock__checkin_command"(id,actor,action,invoice_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)', a.p_command_id, a.p_user_id, action, v.id, h, JSON.stringify(result), ctx.clock.next().toString());
  if (!c) db.exec(`INSERT INTO "erp_stock__checkin"(id,invoice_id,invoice_version,state,version,started_by,started_at,updated_by,updated_at) VALUES(?,?,?,'in_progress',1,?,?,?,?)`, id, v.id, v.version, a.p_user_id, at, a.p_user_id, at);
  else db.exec('UPDATE "erp_stock__checkin" SET version=version+1,invoice_version=?,updated_by=?,updated_at=? WHERE id=?', action === "restart" ? v.version : c.invoice_version, a.p_user_id, at, id);
  if (!c || action === "restart") {
    db.exec('DELETE FROM "erp_stock__checkin_item" WHERE checkin_id=?', id);
    for (const i of db.exec('SELECT * FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? ORDER BY position', v.id).rows) {
      const data = parse(i.data);
      db.exec('INSERT INTO "erp_stock__checkin_item"(checkin_id,position,product_id,description,supplier_code,gtin,unit,quantity,unit_price,received) VALUES(?,?,?,?,?,?,?,?,?,0)', id, i.position, i.product_id, arrow(data, "description") ?? "", arrow(data, "code"), arrow(data, "gtin"), arrow(data, "unit"), i.quantity, i.unit_price);
    }
  }
  return id;
}
function event(ctx: RpcContext, a: Row, id: string, action: string, position: number | null = null, description: string | null = null, q: string | null = null, previous: string | null = null) {
  ctx.db.exec('INSERT INTO "erp_stock__checkin_event"(id,checkin_id,command_id,actor,action,position,description,quantity,previous,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_stock__checkin_event", "id"), id, a.p_command_id, a.p_user_id, action, position, description, q === null ? null : toScaled(q, 4).toString(), previous === null ? null : toScaled(previous, 4).toString(), ctx.clock.next().toString());
}
function result(ctx: RpcContext, a: Row) {
  checkinAccess(ctx.db, a.p_user_id, true);
  return { ...parse(one(ctx.db, 'SELECT result FROM "erp_stock__checkin_command" WHERE id=?', a.p_command_id)!.result), ...checkinDto(ctx.db, a.p_invoice_id), replayed: false };
}
export function checkinWrite(ctx: RpcContext, args: RpcArgs, action: string) {
  const a: Row = { ...args }, db = ctx.db;
  checkinAccess(db, a.p_user_id, true);
  const min = ["restart", "finish"].includes(action) ? 1 : 0, max = action === "finish" ? 2147483645 : 2147483646;
  if (a.p_command_id === null || a.p_invoice_id === null || a.p_expected_version === null || a.p_expected_version < min || a.p_expected_version > max) inputInvalid();
  const body: Row = { profile: `stock-checkin-${action}-147`, actor: a.p_user_id, invoice_id: a.p_invoice_id, expected_version: a.p_expected_version };
  const pos = (p: any) => typeof p === "number" && /^[1-9][0-9]{0,2}$/.test(String(p));
  if (action === "save" || action === "batch") {
    const values: any = jsonbArg(action === "save" ? a.p_items : a.p_positions);
    if (!Array.isArray(values) || values.length < 1 || values.length > 990) inputInvalid();
    if (action === "save") {
      if (values.some((e: any) => !e || Array.isArray(e) || typeof e !== "object" || Object.keys(e).length !== 2 || !pos(e.position) || typeof e.received !== "string" || !quantity.test(e.received)) || new Set(values.map((e: any) => e.position)).size !== values.length) inputInvalid();
      body.items = values.slice().sort((a: Row, b: Row) => a.position - b.position);
    } else {
      if (values.some((e: any) => !pos(e)) || new Set(values).size !== values.length) inputInvalid();
      body.positions = values.slice().sort((a: number, b: number) => a - b);
    }
  }
  if (action === "issue") {
    if (a.p_position === null || a.p_position < 1 || a.p_position > 990 || !["missing", "damaged", "incorrect", "refused"].includes(a.p_kind) || a.p_action !== "none" || (a.p_kind === "refused") !== (a.p_quantity === null) || (a.p_quantity !== null && (!quantity.test(a.p_quantity) || toScaled(a.p_quantity, 4) === 0n))) inputInvalid();
    Object.assign(body, { position: a.p_position, kind: a.p_kind, quantity: a.p_quantity, action: a.p_action });
  }
  const h = hash(body), b = checkinBegin(db, a, action, h);
  if (b.replay) return b.replay;
  const byPosition = new Map(currentItems(db, a.p_invoice_id).map(i => [i.position, i]));
  const current = (position: number) => { const i = byPosition.get(position); if (!i) raise("P0002", "erp_stock_checkin_item_not_found"); return i; };
  let detail: Row = {}, changes: Row[] = [];
  if (action === "save" || action === "batch") {
    for (const x of action === "save" ? body.items : body.positions.map((position: number) => ({ position }))) {
      const i = current(x.position), q = action === "save" ? toScaled(x.received, 4) : fromColumn(i.quantity);
      if (action === "batch" || q !== fromColumn(i.received)) {
        if (i.issue === "refused") raise("22023", "erp_stock_checkin_item_refused");
        changes.push({ position: x.position, from: t4(i.received), to: formatScaled(q, 4), description: i.description });
      }
    }
    if (!changes.length) raise("22023", "erp_stock_checkin_unchanged");
    detail = { changes };
  } else if (action === "issue") {
    const i = current(a.p_position);
    if (i.issue === "refused") raise("22023", "erp_stock_checkin_item_refused");
    if (a.p_quantity !== null && toScaled(a.p_quantity, 4) > fromColumn(i.quantity)) raise("22023", "erp_stock_checkin_issue_quantity_invalid");
    detail = { position: a.p_position, kind: a.p_kind, quantity: a.p_quantity === null ? null : formatScaled(toScaled(a.p_quantity, 4), 4), action: a.p_action, previous: i.issue };
  } else if (action === "restart") detail = { from_invoice_version: b.c?.invoice_version ?? null, to_invoice_version: b.v!.version };
  const id = checkinAdvance(ctx, a, action, h, b.v!, b.c, detail);
  if (action === "save" || action === "batch") {
    for (const x of changes) {
      db.exec('UPDATE "erp_stock__checkin_item" SET received=? WHERE checkin_id=? AND position=?', toScaled(x.to, 4).toString(), id, x.position);
      event(ctx, a, id, action === "save" ? "received" : "batch", x.position, x.description, x.to, x.from);
    }
  } else if (action === "issue") {
    const i = current(a.p_position);
    db.exec('UPDATE "erp_stock__checkin_item" SET issue=?,issue_quantity=?,issue_action=? WHERE checkin_id=? AND position=?', a.p_kind, a.p_quantity === null ? null : toScaled(a.p_quantity, 4).toString(), a.p_action, id, a.p_position);
    event(ctx, a, id, a.p_kind, a.p_position, i.description, a.p_quantity);
  } else {
    event(ctx, a, id, action);
    if (action === "finish") db.exec(`UPDATE "erp_stock__checkin" SET state='finished',version=version+1,finished_by=?,finished_at=?,updated_at=?,updated_by=? WHERE id=?`, a.p_user_id, ctx.clock.next().toString(), ctx.clock.next().toString(), a.p_user_id, id);
  }
  return result(ctx, a);
}
registerRpc("erp_stock_checkin_save", (ctx, a) => checkinWrite(ctx, a, "save"));
registerRpc("erp_stock_checkin_issue", (ctx, a) => checkinWrite(ctx, a, "issue"));
registerRpc("erp_stock_checkin_batch", (ctx, a) => checkinWrite(ctx, a, "batch"));
registerRpc("erp_stock_checkin_restart", (ctx, a) => checkinWrite(ctx, a, "restart"));
registerRpc("erp_stock_checkin_finish", (ctx, a) => checkinWrite(ctx, a, "finish"));

export function checkinPostLines(db: SqlDriver, id: string) {
  return db.exec(`SELECT position, received FROM "erp_stock__checkin_item" WHERE checkin_id=? AND received>0 AND (issue IS NULL OR issue<>'refused') ORDER BY position`, id).rows.map(i => ({ position: i.position, quantity: formatScaled(fromColumn(i.received) * 100n, 6) }));
}
function checkinPostBegin(db: SqlDriver, a: Row) {
  checkinAccess(db, a.p_user_id, true);
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', a.p_invoice_id) as Row | null;
  if (!v || v.direction !== "0") raise("P0002", "erp_stock_checkin_note_not_found");
  const c = one(db, 'SELECT * FROM "erp_stock__checkin" WHERE invoice_id=?', a.p_invoice_id) as Row | null;
  if (!c || c.version !== a.p_expected_version) raise("40001", "erp_stock_checkin_version_conflict");
  if (c.state === "finished") raise("40001", "erp_stock_checkin_finished");
  if (!checkinNoteOpen(v)) raise("40001", "erp_stock_checkin_note_closed");
  if (c.invoice_version !== v.version) raise("40001", "erp_stock_checkin_note_changed");
  if (!checkinPostLines(db, c.id).length) raise("22023", "erp_stock_checkin_nothing_received");
  return c;
}
function checkinPost(ctx: RpcContext, a: Row, write: boolean) {
  invoiceAccess(ctx.db, a.p_user_id, true);
  if (a.p_expected_version === null || a.p_expected_version < 1 || a.p_expected_version > 2147483645 || a.p_warehouse_id === null || (write && (a.p_preview_hash === null || !/^[a-f0-9]{64}$/.test(a.p_preview_hash)))) raise("22023", "erp_invoice_stock_invalid");
  const h = write ? hash({ profile: "stock-checkin-post-259", actor: a.p_user_id, invoice_id: a.p_invoice_id, version: a.p_expected_version, warehouse_id: a.p_warehouse_id, hash: a.p_preview_hash }) : "";
  if (write) {
    const replay = invoiceReplay(ctx.db, a, "checkin", h);
    if (replay) return { ...replay, checkin: checkinDto(ctx.db, a.p_invoice_id) };
  }
  const v = invoiceLock(ctx.db, a.p_user_id, a.p_invoice_id, null), c = checkinPostBegin(ctx.db, a);
  const preview = invoicePreviewData(ctx.db, v, a.p_warehouse_id, "checkin", checkinPostLines(ctx.db, c.id));
  if (!write) return { scope: "stock_checkin_post_preview", data_mode: "erp_native", checkin_version: c.version, preview };
  if (a.p_preview_hash !== preview.preview_hash) raise("40001", "erp_invoice_stock_preview_conflict");
  const command = supplyPart(a.p_command_id, "checkin-finish");
  const finish = checkinWrite(ctx, { ...a, p_command_id: command }, "finish");
  if (finish.replayed) raise("40001", "erp_invoice_stock_conflict");
  return { ...saveInvoicePosting(ctx, a, v, preview, "checkin", h, { finish_command_id: command }), checkin: checkinDto(ctx.db, v.id) };
}
registerRpc("erp_stock_checkin_post_preview", (ctx, a) => checkinPost(ctx, a, false));
registerRpc("erp_stock_checkin_finish_post", (ctx, a) => checkinPost(ctx, a, true));
