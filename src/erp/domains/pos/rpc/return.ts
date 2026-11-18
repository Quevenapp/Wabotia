// Devolução do PDV: 206, substituída pela 292 (parcelas Devolvido).
import { createHash, randomUUID } from "node:crypto";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { replay } from "../../../engine/receipt.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgLeft, pgLength } from "../../../engine/text.ts";
import { documentTitleRows, titlesMarkReturned } from "../../finance/public.ts";
import {
  access, arrowText, dec, decAdd, decCmp, decColumn, decDiv, decFixed, decMul, decRound,
  int, json, keys, returned, returnsView, saleView, step, today, txt, uid, usableSession,
  type Dec, type Json,
} from "../internal.ts";

function erpPosReturnExecute(ctx: RpcContext, args: RpcArgs): Json {
  const db = ctx.db, day = today(ctx), user = args.p_user_id as string | null;
  const a = access(db, user, true);
  const command = args.p_command_id as string | null, action = args.p_action, data = args.p_data as Json;
  if (command == null || action !== "sale_return" || data == null || jsonType(data) !== "object" ||
    new TextEncoder().encode(jsonbText(data)).length > 65536) raise("22023", "erp_pos_invalid_action");
  const hash = createHash("sha256").update(jsonbText({ actor: user, scope: "return", action, data })).digest("hex");
  const previous = replay(db, "erp_pos__command", command, user!, hash, "erp_pos_command_conflict");
  if (previous) return JSON.parse(jsonbText({ ...previous, replayed: true }));
  if (!a.finish) raise("42501", "erp_pos_finish_denied");
  const fields = ["sale_id", "expected_version", "items", "refund_account_id", "cash_session_id", "reason"];
  keys(data, fields, fields);
  const reason = txt(data, "reason", 500, true)!;
  if (pgLength(reason) < 3) raise("22023", "erp_pos_reason_required");
  let account = uid(data, "refund_account_id");
  const session = uid(data, "cash_session_id");
  if (session !== null) {
    const sess = one(db, 'SELECT * FROM "erp_finance__cash_session" WHERE id=?', session);
    if (!sess || !usableSession(db, user!, sess) || (arrowText(data, "refund_account_id") !== null && account !== sess.account_id))
      raise("40001", "erp_pos_cash_session_unavailable");
    account = String(sess.account_id);
  }
  const s = one(db, 'SELECT * FROM "erp_pos__sale" WHERE id=?', uid(data, "sale_id", true));
  if (!s) raise("P0002", "erp_pos_not_found");
  if (s.version !== int(data, "expected_version", 1, 2147483646)) raise("40001", "erp_pos_version_conflict");
  if (s.state !== "finished") raise("40001", "erp_pos_sale_state");
  const history = db.exec('SELECT items, CAST(refund_cents AS TEXT) refund_cents FROM "erp_pos__sale_return" WHERE sale_id=?', s.id).rows;
  if (history.length >= 20) raise("22023", "erp_pos_returns_limit");
  const d = one(db, 'SELECT *, CAST(number AS TEXT) number FROM "erp_documents__document" WHERE id=?', s.document_id)!;
  const stockPosting = one(db, `SELECT * FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, d.id);
  const financePosting = one(db, `SELECT id FROM "erp_finance__document_posting" WHERE document_id=? AND state='active'`, d.id);
  if (!financePosting || (!stockPosting && one(db, `SELECT 1 FROM "erp_documents__item" i JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.document_id=? AND p.kind='P'`, d.id)))
    raise("40001", "erp_pos_return_effects_pending");
  account ??= s.account_id as string | null;
  const id = String(s.id), done = returned(db, id);
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 250) raise("22023", "erp_pos_invalid_items");
  const totals = json(d.body)?.totals, subtotal = dec(arrowText(totals, "subtotal") ?? "0"), discount = dec(arrowText(totals, "discount") ?? "0");
  const factor = subtotal.v > 0n ? decDiv(decAdd(subtotal, { v: -discount.v, s: discount.s }), subtotal) : dec("0");
  const items: Json[] = [], stock = new Map<string, Dec>(), seen = new Set<string>();
  let cents = 0n, refund = 0n, movement: unknown = null, entry: unknown = null;
  for (const x of data.items as Json[]) {
    keys(x, ["item_id", "quantity"], ["item_id", "quantity"]);
    const i = one(db, 'SELECT *, CAST(quantity AS TEXT) quantity FROM "erp_documents__item" WHERE id=? AND document_id=?', uid(x, "item_id", true), d.id);
    if (!i || seen.has(String(i.id))) raise("22023", "erp_pos_invalid_items");
    seen.add(String(i.id));
    if (typeof x.quantity !== "string" || !/^[0-9]{1,9}(\.[0-9]{1,6})?$/.test(x.quantity) || dec(x.quantity).v <= 0n)
      raise("22023", "erp_pos_invalid_items");
    const qty = dec(x.quantity), quantity = decColumn(i.quantity, 6), accumulated = decAdd(qty, dec(arrowText(done, String(i.id)) ?? "0"));
    const cmp = decCmp(accumulated, quantity), itemData = json(i.data), total = dec(arrowText(itemData, "total")!);
    if (cmp > 0) raise("22023", "erp_pos_return_exceeds");
    let line: bigint;
    if (cmp === 0) {
      let prior = 0n;
      for (const r of history) for (const l of json(r.items) as Json[])
        if (arrowText(l, "item_id") === i.id) prior += BigInt(arrowText(l, "value_cents") ?? "0");
      line = decRound(decMul(decMul(total, factor), dec("100")), 0).v - prior;
      if (line < 0n) line = 0n;
    } else line = decRound(decMul(decMul(decDiv(decMul(total, qty), quantity), factor), dec("100")), 0).v;
    cents += line;
    items.push({ item_id: i.id, product_id: i.product_id, description: arrowText(itemData, "description"), unit: arrowText(itemData, "unit"),
      quantity: decFixed(qty, 6), value_cents: line.toString() });
    if (one(db, 'SELECT kind FROM "erp_catalog__product" WHERE record_id=?', i.product_id)?.kind === "P") {
      const product = String(i.product_id);
      stock.set(product, decAdd(stock.get(product) ?? dec("0"), qty));
    }
  }
  if (stock.size > 0) {
    if (!["admin", "estoque"].includes(a.role)) raise("42501", "erp_pos_return_stock_denied");
    const lines: Json[] = [];
    for (const [product, qty] of [...stock].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const wh = one(db, 'SELECT warehouse_id FROM "erp_stock__entry" WHERE movement_id=? AND product_id=? ORDER BY ordinal LIMIT 1', stockPosting?.movement_id ?? null, product);
      if (!wh) continue;
      lines.push({ product_id: product, warehouse_id: wh.warehouse_id, quantity: decFixed(qty, 6),
        expected_version: one(db, 'SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, wh.warehouse_id)?.version ?? 0 });
    }
    if (lines.length > 0) {
      invokeRpc(ctx, "erp_stock_post", { p_user_id: user, p_command_id: step(command, "return_stock"), p_kind: "receipt", p_occurred_on: day,
        p_reason: pgLeft(`Devolução da venda nº ${d.number} na frente de caixa: ${reason}`, 500), p_items: lines, p_reference: pgLeft(`PDV venda ${d.number}`, 100) });
      movement = one(db, 'SELECT id FROM "erp_stock__movement" WHERE command_id=?', step(command, "return_stock"))?.id ?? null;
    }
  }
  const complete = !db.exec('SELECT id, CAST(quantity AS TEXT) quantity FROM "erp_documents__item" WHERE document_id=?', d.id).rows.some((i) => {
    const current = items.find((l) => l.item_id === i.id);
    return decCmp(decColumn(i.quantity, 6), decAdd(dec(arrowText(done, String(i.id)) ?? "0"), dec(arrowText(current, "quantity") ?? "0"))) > 0;
  });
  let open: string[] = [];
  if (cents > 0n) {
    if (!["admin", "financeiro"].includes(a.role)) raise("42501", "erp_pos_return_finance_denied");
    const titles = documentTitleRows(db, String(financePosting.id)).filter((t) => !t.cancelled);
    const paid = titles.reduce((sum, t) => sum + BigInt(String(t.settled_cents)), 0n);
    const refunded = history.reduce((sum, r) => sum + BigInt(String(r.refund_cents)), 0n);
    if (complete) {
      open = titles.filter((t) => BigInt(String(t.settled_cents)) === 0n).sort((a, b) => Number(a.position) - Number(b.position)).map((t) => String(t.id));
      if (titles.some((t) => BigInt(String(t.settled_cents)) > 0n && BigInt(String(t.settled_cents)) < BigInt(String(t.amount_cents))))
        raise("22023", "erp_pos_return_partial_title");
    }
    const available = paid - refunded, cap = available > 0n ? available : 0n;
    const cash = open.length > 0 && cap < cents ? cap : cents;
    if (cash > available) raise("22023", "erp_pos_return_exceeds_paid");
    if (cash > 0n) {
      if (account === null) raise("22023", "erp_pos_invalid_account");
      invokeRpc(ctx, "erp_finance_cash_execute", { p_user_id: user, p_command_id: step(command, "refund"), p_action: "entry_save",
        p_data: { id: null, expected_version: 0, account_id: account, kind: "out", amount_cents: cash.toString(), posted_on: day, competence_on: day,
          category_id: null, contact_id: d.contact_id, note: pgLeft(`Devolução da venda nº ${d.number} (frente de caixa): ${reason}`, 2000), origin: "manual" } });
      entry = one(db, 'SELECT id FROM "erp_finance__cash_entry" WHERE command_id=?', step(command, "refund"))?.id ?? null;
      refund = cash;
    }
    if (open.length > 0) titlesMarkReturned(ctx, user, step(command, "titles_returned"), open,
      { kind: "pos_return", id, label: pgLeft(`Devolução da venda nº ${d.number} (frente de caixa)`, 120) });
  }
  const before = saleView(db, id, true);
  db.exec(`INSERT INTO "erp_pos__sale_return"(id,sale_id,items,value_cents,refund_cents,refund_account_id,cash_session_id,stock_movement_id,cash_entry_id,reason,actor,command_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), id, jsonbText(items), cents.toString(), refund.toString(), entry === null ? null : account,
    session, movement, entry, reason, user, command, ctx.clock.next().toString());
  db.exec('UPDATE "erp_pos__sale" SET version=version+1, updated_at=? WHERE id=?', ctx.clock.next().toString(), id);
  access(db, user, true);
  const result = { entity: "pos_sale", record: { ...saleView(db, id, true), returns: returnsView(db, id), returned: returned(db, id) },
    return: { value_cents: cents.toString(), refund_cents: refund.toString(), stock: movement !== null, refund: entry !== null, returned_titles: open.length,
      items: items.map((l) => ({ item_id: l.item_id, quantity: l.quantity, value_cents: l.value_cents })) }, action, data_mode: "erp_native", replayed: false };
  db.exec('INSERT INTO "erp_pos__command"(id,actor,scope,request_hash,result,created_at) VALUES(?,?,?,?,?,?)', command, user, "return", hash, jsonbText(result), ctx.clock.next().toString());
  db.exec('INSERT INTO "erp_pos__audit"(id,actor,command_id,sale_id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_pos__audit", "id"), user, command, id, action, before === null ? null : jsonbText(before), jsonbText(result.return), ctx.clock.next().toString());
  return JSON.parse(jsonbText(result));
}

registerRpc("erp_pos_return_execute", erpPosReturnExecute);
