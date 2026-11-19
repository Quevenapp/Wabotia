// Venda do PDV: 204/205, sale_write da 242 e sale_effects da 267.
// Os efeitos pertencem aos RPCs dos respectivos domínios, na mesma transação.
import { createHash, randomUUID } from "node:crypto";
import { one, type SqlDriver, type Row } from "../../../engine/driver.ts";
import { fromSqlite, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { replay } from "../../../engine/receipt.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireRpcParts } from "../../../engine/parts-gate.ts";
import { commissionOperationSync } from "../../finance/document-effects.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgLeft, pgLength } from "../../../engine/text.ts";
import { documentTitleRows } from "../../finance/public.ts";
import {
  access, arrowText, bool, dec, decAdd, decCmp, decColumn, decFixed, decRound,
  flag, int, json, keys, nfce, prefFlag, saleView, step, today, txt, uid, usableSession,
  type Access, type Dec, type Json,
} from "../internal.ts";

/** erp_pos.cents (texto, até 14 dígitos, sem arredondamento). */
function cents(p: Json, key: string, positive = false, required = true): bigint | null {
  const v = p[key];
  if (v === null || v === undefined) {
    if (required) raise("22023", "erp_pos_invalid_amount");
    return null;
  }
  if (typeof v !== "string" || !/^[0-9]{1,14}$/.test(v) || (positive && BigInt(v) === 0n))
    raise("22023", "erp_pos_invalid_amount");
  return BigInt(v);
}

/** erp_pos.amount_text: os centavos não negativos com duas casas. */
const amountText = (v: bigint) => decFixed({ v, s: 2 }, 2);
/** erp_pos.document_version. */
const documentVersion = (db: SqlDriver, id: unknown) => one(db, 'SELECT version FROM "erp_documents__document" WHERE id=?', id)?.version ?? null;
const saleRow = (db: SqlDriver, id: string) => one(db, 'SELECT * FROM "erp_pos__sale" WHERE id=?', id);
const activePosting = (db: SqlDriver, domain: "stock" | "finance", document: unknown) =>
  one(db, `SELECT id, version FROM "erp_${domain}__document_posting" WHERE document_id=? AND state='active'`, document);
const payments = (db: SqlDriver, sale: unknown) =>
  db.exec('SELECT *, CAST(amount_cents AS TEXT) amount_cents FROM "erp_pos__sale_payment" WHERE sale_id=? ORDER BY position', sale).rows;
const qtyPattern = /^[0-9]{1,9}(\.[0-9]{1,6})?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const call = (ctx: RpcContext, name: string, args: RpcArgs) => invokeRpc(ctx, name, args) as Json;

/** erp_pos.sale_write: grava o pedido e as parcelas, sem lançar efeitos. */
function saleWrite(ctx: RpcContext, user: string, command: string, data: Json, finish: boolean, a: Access): string {
  requireRpcParts(ctx, "erp_pos_sale_execute", { p_action: finish ? "sale_finish" : "sale_save", p_data: data });
  const db = ctx.db, day = today(ctx);
  const fields = ["sale_id", "expected_version", "document_version", "kind", "table_number", "account_id", "cash_session_id", "contact_id", "price_list_id", "document", "payments", "destination_account_id", "to_ledger", "cash_received_cents"];
  keys(data, fields, fields);
  if (!a.items) raise("42501", "erp_pos_items_denied");
  const kind = txt(data, "kind", 10, true)!;
  const table = int(data, "table_number", 1, 9999, false);
  if (!["balcao", "mesa"].includes(kind) || (kind === "mesa") !== (table !== null)) raise("22023", "erp_pos_invalid_kind");
  if (kind === "mesa" && !prefFlag(db, "pdv.controle_mesas")) raise("22023", "erp_pos_tables_disabled");
  let id = uid(data, "sale_id");
  let old: Row | null = null;
  if (id === null) {
    if (int(data, "expected_version", 0, 0) !== 0 || int(data, "document_version", 1, 2147483646, false) !== null)
      raise("22023", "erp_pos_invalid_number");
  } else {
    old = saleRow(db, id);
    if (!old) raise("P0002", "erp_pos_not_found");
    if (old.version !== int(data, "expected_version", 1, 2147483646)) raise("40001", "erp_pos_version_conflict");
    if (old.state !== "open") raise("40001", "erp_pos_sale_state");
    if (int(data, "document_version", 1, 2147483646) !== documentVersion(db, old.document_id)) raise("40001", "erp_pos_document_state");
  }
  const account = uid(data, "account_id"), session = uid(data, "cash_session_id");
  if (session !== null) {
    const s = one(db, 'SELECT * FROM "erp_finance__cash_session" WHERE id=?', session);
    if (!s || !usableSession(db, user, s)) raise("40001", "erp_pos_cash_session_unavailable");
    if (account !== s.account_id) raise("22023", "erp_pos_invalid_store");
  } else if (finish && prefFlag(db, "pdv.controle_caixa")) raise("40001", "erp_pos_cash_session_required");
  if (account !== null && !one(db, `SELECT 1 FROM "erp_finance__account" WHERE id=? AND kind='cash' AND active=1 AND deleted_at IS NULL`, account))
    raise("22023", "erp_pos_invalid_store");
  const dest = uid(data, "destination_account_id");
  if (dest !== null && !one(db, 'SELECT 1 FROM "erp_finance__account" WHERE id=? AND active=1 AND deleted_at IS NULL', dest))
    raise("22023", "erp_pos_invalid_account");
  const list = uid(data, "price_list_id");
  if (list !== null && list !== old?.price_list_id && !one(db, 'SELECT 1 FROM "erp_pricing__price_list" WHERE id=?', list))
    raise("22023", "erp_pos_invalid_price_list");
  if (jsonType(data.to_ledger) !== "boolean" || (flag(data, "to_ledger") && dest !== null)) raise("22023", "erp_pos_invalid_data");
  let contact = uid(data, "contact_id");
  const identified = contact !== null;
  if (flag(data, "to_ledger") && !identified) raise("22023", "erp_pos_ledger_requires_contact");
  if (contact === null) {
    contact = one(db, 'SELECT consumer_contact_id FROM "erp_pos__settings" WHERE singleton=1')?.consumer_contact_id as string | null;
    if (contact == null) raise("22023", "erp_pos_consumer_required");
  }
  const doc = data.document as Json;
  keys(doc, ["date", "warehouse_id", "expected_date", "items", "discount_mode", "discount_value", "freight", "other_expenses", "notes", "internal_notes", "seller_id", "category_id"], ["date", "items"]);
  if (jsonType(doc.date) !== "string" || doc.date !== day) raise("22023", "erp_pos_invalid_date");
  if (!Array.isArray(doc.items) || doc.items.length < 1 || doc.items.length > 250) raise("22023", "erp_pos_invalid_items");
  const items = doc.items as Json[], wh = uid(doc, "warehouse_id");
  if (!Array.isArray(data.payments) || data.payments.length > 120) raise("22023", "erp_pos_invalid_payments");
  if (data.payments.length > 0 && !a.payments) raise("42501", "erp_pos_payments_denied");
  if (finish && (!a.payments || !a.finish)) raise("42501", "erp_pos_finish_denied");
  if (finish && data.payments.length === 0) raise("22023", "erp_pos_payments_required");
  const installments: Json[] = [], pay: Json[] = [];
  let sum = 0n, cash = 0n, change = 0n;
  for (const p of data.payments as Json[]) {
    const pf = ["payment_method_id", "days", "amount_cents", "note"];
    keys(p, pf, pf);
    const m = one(db, `SELECT * FROM "erp_catalog__payment_method" WHERE id=? AND active=1 AND deleted_at IS NULL AND applicable IN ('recebimentos','ambos')`, uid(p, "payment_method_id", true));
    if (!m) raise("22023", "erp_pos_invalid_payment_method");
    const days = int(p, "days", 0, 9999)!, amount = cents(p, "amount_cents", true)!, note = txt(p, "note", 2000, false, true);
    const due = new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    if (due > "2100-12-31") raise("22023", "erp_pos_invalid_number");
    installments.push({ due_date: due, amount: amountText(amount), method: m.description, note, payment_reference: null });
    pay.push({ position: pay.length + 1, payment_method_id: m.id, method_name: m.description, payment_type: m.payment_type, days, due_on: due, amount_cents: amount.toString(), note });
    sum += amount;
    if (days === 0 && ["01", "02"].includes(String(m.payment_type))) cash += amount;
  }
  if (new Set(data.payments.map((p) => arrowText(p, "payment_method_id"))).size > 1 && !a.change_method)
    raise("42501", "erp_pos_change_method_denied");
  const received = cents(data, "cash_received_cents", false, false);
  if (received !== null) {
    if (cash === 0n || received < cash) raise("22023", "erp_pos_cash_received_invalid");
    change = received - cash;
  }
  if (!a.edit_price) for (const item of items) {
    // SQL NULL (chave ausente) não é jsonb null: jsonb_typeof(NULL) <> 'string' é desconhecido.
    const type = jsonType(item?.unit_price);
    if (jsonType(item) !== "object" || (type !== null && type !== "string")) raise("22023", "erp_pos_invalid_items");
    if (arrowText(item, "product_id") !== null) {
      const product = uid(item, "product_id");
      const price = one(db, 'SELECT price FROM "erp_catalog__product" WHERE record_id=?', product)?.price;
      const lists = list === null ? [] : call(ctx, "erp_pricing_product_lists", { p_user_id: user, p_product_id: product }).items as Json[];
      const listPrice = arrowText(lists.find((l) => l.id === list), "list_price");
      const unit = arrowText(item, "unit_price");
      if (unit !== null && (!/^[0-9]{1,12}(\.[0-9]{1,10})?$/.test(unit) ||
        ((price == null || decCmp(dec(unit), dec(String(price))) !== 0) && (listPrice === null || decCmp(dec(unit), dec(listPrice)) !== 0))))
        raise("42501", "erp_pos_edit_price_denied");
      if (unit === null && price != null && listPrice === null) raise("42501", "erp_pos_edit_price_denied");
    }
  }
  if (old && !a.remove_items) {
    for (const i of db.exec('SELECT id, CAST(quantity AS TEXT) quantity FROM "erp_documents__item" WHERE document_id=?', old.document_id).rows)
      if (!items.some((n) => arrowText(n, "id") === i.id && typeof n?.quantity === "string" && qtyPattern.test(n.quantity) && decCmp(dec(n.quantity), decColumn(i.quantity, 6)) >= 0))
        raise("42501", "erp_pos_remove_items_denied");
  }
  if (wh !== null) {
    const quantities = new Map<string, Dec>();
    for (const n of items) {
      const product = arrowText(n, "product_id");
      if (product === null || !uuidPattern.test(product) || typeof n?.quantity !== "string" || !qtyPattern.test(n.quantity)) continue;
      const p = product.toLowerCase();
      if (!one(db, `SELECT 1 FROM "erp_catalog__product" WHERE record_id=? AND kind='P'`, p)) continue;
      quantities.set(p, decAdd(quantities.get(p) ?? dec("0"), dec(n.quantity)));
    }
    for (const [p, qty] of quantities) {
      const balance = decColumn(one(db, 'SELECT CAST(quantity AS TEXT) quantity FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', p, wh)?.quantity ?? "0", 6);
      if (prefFlag(db, "pdv.bloquear_quantidade_zero") && balance.v <= 0n) raise("22023", "erp_pos_stock_zero");
      if (!prefFlag(db, "pdv.estoque_negativo") && decCmp(qty, balance) > 0) raise("22023", "erp_pos_stock_insufficient");
    }
  }
  const body = { ...doc, contact_id: contact, installments, ship_date: day, price_list_id: list,
    commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
      transport: { freight_mode: /^0+(\.0+)?$/.test(arrowText(doc, "freight") ?? "0") ? "9" : "0", volume_count: null, gross_weight: null,
        delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } };
  const saved = call(ctx, "erp_document_save", { p_user_id: user, p_kind: "sales_orders", p_id: old?.document_id ?? null,
    p_expected_version: old ? documentVersion(db, old.document_id) : 0, p_command_id: step(command, "save"), p_body: body });
  if ("discount_approval" in saved) raise("22023", "erp_document_seller_discount_limit");
  const document = saved.document as Json;
  if (document.status !== "open") raise("40001", "erp_pos_document_state");
  const total = decRound(dec(String((document.totals as Json).total)), 2).v;
  if (pay.length > 0 && sum !== total) raise("22023", "erp_pos_payments_mismatch");
  const values = [account, session, kind, table, Number(identified), list, dest, Number(flag(data, "to_ledger")), total.toString(), received?.toString() ?? null, change.toString()];
  if (id === null) {
    id = randomUUID();
    db.exec(`INSERT INTO "erp_pos__sale"(id, document_id, operator_id, account_id, cash_session_id, kind, table_number, customer_identified, price_list_id,
      destination_account_id, to_ledger, total_cents, cash_received_cents, change_cents, state, command_id, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`, id, document.id, user, ...values, command, ctx.clock.next().toString(), ctx.clock.next().toString());
  } else {
    db.exec(`UPDATE "erp_pos__sale" SET account_id=?, cash_session_id=?, kind=?, table_number=?, customer_identified=?, price_list_id=?, destination_account_id=?,
      to_ledger=?, total_cents=?, cash_received_cents=?, change_cents=?, version=version+1, updated_at=? WHERE id=?`, ...values, ctx.clock.next().toString(), id);
    db.exec('DELETE FROM "erp_pos__sale_payment" WHERE sale_id=?', id);
  }
  for (const p of pay) db.exec(`INSERT INTO "erp_pos__sale_payment"(sale_id,position,payment_method_id,method_name,payment_type,days,due_on,amount_cents,note)
    VALUES(?,?,?,?,?,?,?,?,?)`, id, p.position, p.payment_method_id, p.method_name, p.payment_type, p.days, p.due_on, p.amount_cents, p.note);
  return id;
}

/** Bloco EXCEPTION: desfaz banco, SET LOCAL e gatilhos adiados da tentativa.
 * nextval não é transacional no Postgres: ctx.sequences é preservado. */
function attempt(ctx: RpcContext, fallback: string, fn: () => void): string | null {
  const settings = new Map(ctx.settings), deferred = ctx.deferred.length;
  try {
    ctx.db.transaction(fn);
    return null;
  } catch (error) {
    ctx.settings.clear();
    for (const [k, v] of settings) ctx.settings.set(k, v);
    ctx.deferred.length = deferred;
    const e = fromSqlite(error);
    if (!["22023", "40001", "42501", "P0002"].includes(e.code)) throw e;
    return /^erp_[a-z0-9_]{1,80}$/.test(e.message) ? e.message : fallback;
  }
}

/** erp_pos.sale_effects (267): Atendido, lançamentos e baixas parciais. */
function saleEffects(ctx: RpcContext, user: string, command: string, id: string, a: Access): Json {
  // Indisponibilidade é erro da operação inteira, antes dos blocos que geram pending.
  requireRpcParts(ctx, "erp_pos_sale_execute", { p_action: "sale_finish", p_data: { sale_id: id } });
  const db = ctx.db, day = today(ctx), s = saleRow(db, id)!;
  const d = one(db, 'SELECT *, CAST(number AS TEXT) number FROM "erp_documents__document" WHERE id=?', s.document_id)!;
  const reason = `Venda da frente de caixa nº ${d.number}`;
  const args = () => ({ p_user_id: user, p_kind: "sales_orders", p_document_id: d.id, p_expected_version: documentVersion(db, d.id) });
  if (d.status !== "fulfilled") call(ctx, "erp_document_transition", { p_user_id: user, p_kind: "sales_orders", p_id: d.id,
    p_expected_version: d.version, p_command_id: step(command, "fulfil"), p_status: "fulfilled", p_reason: null });
  let stock: string, finance: string, settled = 0n, open = 0n;
  const reasons: Json = {};
  if (activePosting(db, "stock", d.id)) stock = "posted";
  else if (!one(db, `SELECT 1 FROM "erp_documents__item" i JOIN "erp_catalog__product" x ON x.record_id=i.product_id WHERE i.document_id=? AND x.kind='P'`, d.id)) stock = "none";
  else if (["admin", "estoque"].includes(a.role)) {
    const refused = attempt(ctx, "erp_document_stock_refused", () => {
      const preview = call(ctx, "erp_document_stock_preview", { ...args(), p_occurred_on: day, p_reason: reason }).preview as Json;
      call(ctx, "erp_document_stock_post", { ...args(), p_command_id: step(command, "stock"), p_preview_hash: preview.preview_hash,
        p_occurred_on: day, p_reason: reason, p_ignored_item_ids: ((preview.ignored ?? []) as Json[]).map((i) => i.id ?? null) });
    });
    stock = refused === null ? "posted" : "pending";
    if (refused !== null) reasons.stock_reason = refused;
  } else stock = "pending";
  if (activePosting(db, "finance", d.id)) finance = "posted";
  else if (["admin", "financeiro"].includes(a.role)) {
    const refused = attempt(ctx, "erp_document_finance_refused", () => {
      const preview = call(ctx, "erp_document_finance_preview", { ...args(), p_category_id: null, p_plan: null }).preview as Json;
      call(ctx, "erp_document_finance_post", { ...args(), p_command_id: step(command, "finance"), p_preview_hash: preview.preview_hash, p_category_id: null, p_plan: null });
    });
    finance = refused === null ? "posted" : "pending";
    if (refused !== null) reasons.finance_reason = refused;
  } else finance = "pending";
  const posting = activePosting(db, "finance", d.id);
  if (posting) for (const p of payments(db, s.id)) {
    const t = documentTitleRows(db, String(posting.id)).find((t) => Number(t.position) === p.position);
    if (!t) continue;
    db.exec('UPDATE "erp_pos__sale_payment" SET title_id=? WHERE sale_id=? AND position=?', t.id, s.id, p.position);
    const m = one(db, 'SELECT * FROM "erp_catalog__payment_method" WHERE id=?', p.payment_method_id);
    const target = m?.account_id ?? s.destination_account_id ?? s.account_id;
    const amount = BigInt(String(p.amount_cents));
    if (["admin", "financeiro"].includes(a.role) && !bool(s.to_ledger) && p.days === 0 && m?.destination === "caixa" && target !== null && BigInt(String(t.settled_cents)) === 0n && !t.cancelled) {
      const refused = attempt(ctx, "erp_finance_settle_refused", () => {
        const result = call(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: step(command, `settle:${p.position}`), p_action: "settle",
          p_data: { id: t.id, expected_version: Number(t.version), account_id: target, posted_on: day, principal_cents: amount.toString(), note: pgLeft(`Recebido na frente de caixa — venda nº ${d.number}`, 500) } });
        db.exec('UPDATE "erp_pos__sale_payment" SET settlement_id=? WHERE sale_id=? AND position=?', (result.settlement as Json).id, s.id, p.position);
      });
      if (refused === null) settled += amount;
      else { open += amount; reasons.settle_reason ??= refused; }
    } else open += amount;
  }
  return { stock, finance, settled_cents: settled.toString(), open_cents: open.toString(), ...reasons };
}

/** erp_pos.sale_cancel: estorna baixas, contas, estoque e cancela o pedido. */
function saleCancel(ctx: RpcContext, user: string, command: string, data: Json, a: Access): string {
  requireRpcParts(ctx, "erp_pos_sale_execute", { p_action: "sale_cancel", p_data: data });
  const db = ctx.db, day = today(ctx);
  keys(data, ["sale_id", "expected_version", "reason"], ["sale_id", "expected_version", "reason"]);
  const s = saleRow(db, uid(data, "sale_id", true)!);
  if (!s) raise("P0002", "erp_pos_not_found");
  if (s.version !== int(data, "expected_version", 1, 2147483646)) raise("40001", "erp_pos_version_conflict");
  if (s.state === "cancelled") raise("40001", "erp_pos_sale_state");
  if (s.state === "finished" && !a.finish) raise("42501", "erp_pos_finish_denied");
  const reason = txt(data, "reason", 1000, true)!;
  if (pgLength(reason) < 3) raise("22023", "erp_pos_reason_required");
  if (nfce(db, String(s.document_id)) !== null) raise("40001", "erp_pos_sale_invoice_linked");
  if (one(db, 'SELECT 1 FROM "erp_pos__sale_return" WHERE sale_id=?', s.id)) raise("40001", "erp_pos_sale_has_returns");
  if (activePosting(db, "stock", s.document_id) && !["admin", "estoque"].includes(a.role)) raise("42501", "erp_pos_reverse_stock_denied");
  if (activePosting(db, "finance", s.document_id) && !["admin", "financeiro"].includes(a.role)) raise("42501", "erp_pos_reverse_finance_denied");
  const note = `Venda cancelada na frente de caixa: ${reason}`;
  for (const p of payments(db, s.id)) if (p.settlement_id !== null && !one(db, 'SELECT 1 FROM "erp_finance__settlement" WHERE reverses_id=?', p.settlement_id)) {
    const title = one(db, 'SELECT id, version FROM "erp_finance__title" WHERE id=?', p.title_id);
    call(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: step(command, `unsettle:${p.position}`), p_action: "reverse",
      p_data: { id: title?.id ?? null, expected_version: title?.version ?? null, settlement_id: p.settlement_id, posted_on: day, note: pgLeft(note, 500) } });
  }
  const args = () => ({ p_user_id: user, p_kind: "sales_orders", p_document_id: s.document_id, p_expected_version: documentVersion(db, s.document_id) });
  let financeReversed = false, stockReversed = false;
  const fp = activePosting(db, "finance", s.document_id);
  if (fp) {
    const posting = { p_posting_id: fp.id, p_posting_version: fp.version };
    const preview = call(ctx, "erp_document_finance_reverse_preview", { ...args(), ...posting }).preview as Json;
    const titles = ((preview.titles ?? []) as Json[]).map((t) => ({ id: arrowText(t, "id"), version: Number(t.version) }));
    call(ctx, "erp_document_finance_reverse", { ...args(), ...posting, p_command_id: step(command, "finance_reverse"), p_preview_hash: preview.preview_hash,
      p_title_versions: titles, p_reason: pgLeft(note, 1000) });
    financeReversed = true;
  }
  const sp = activePosting(db, "stock", s.document_id);
  if (sp) {
    const posting = { p_posting_id: sp.id, p_posting_version: sp.version, p_occurred_on: day, p_reason: pgLeft(note, 500) };
    const preview = call(ctx, "erp_document_stock_reverse_preview", { ...args(), ...posting }).preview as Json;
    call(ctx, "erp_document_stock_reverse", { ...args(), ...posting, p_command_id: step(command, "stock_reverse"), p_preview_hash: preview.preview_hash });
    stockReversed = true;
  }
  const d = one(db, 'SELECT id, version, status FROM "erp_documents__document" WHERE id=?', s.document_id)!;
  if (d.status !== "cancelled") call(ctx, "erp_document_transition", { p_user_id: user, p_kind: "sales_orders", p_id: d.id,
    p_expected_version: d.version, p_command_id: step(command, "cancel"), p_status: "cancelled", p_reason: reason });
  // O gatilho adiado roda fora do escopo temporário da Base. Compensar aqui
  // mantém a autorização restrita ao pedido desta venda, na mesma transação.
  if (!ctx.parts.finance || !ctx.parts.sales) commissionOperationSync(ctx, String(d.id));
  const old = json(s.effects);
  const effects = { stock: stockReversed || arrowText(old, "stock") === "posted" ? "reversed" : arrowText(old, "stock") ?? "none",
    finance: financeReversed || arrowText(old, "finance") === "posted" ? "reversed" : arrowText(old, "finance") ?? "none",
    settled_cents: arrowText(old, "settled_cents") ?? "0", open_cents: arrowText(old, "open_cents") ?? "0" };
  db.exec(`UPDATE "erp_pos__sale" SET state='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?, effects=?, version=version+1, updated_at=? WHERE id=?`,
    ctx.clock.next().toString(), user, reason, jsonbText(effects), ctx.clock.next().toString(), s.id);
  return String(s.id);
}

/** public.erp_pos_sale_execute: recibo comum a todas as operações. */
function erpPosSaleExecute(ctx: RpcContext, args: RpcArgs): Json {
  requireRpcParts(ctx, "erp_pos_sale_execute", args);
  const db = ctx.db, user = args.p_user_id as string | null;
  const a = access(db, user, true);
  const command = args.p_command_id as string | null, action = args.p_action as string | null, data = args.p_data as Json;
  if (command == null || action == null || !["sale_save", "sale_finish", "sale_cancel", "sale_transfer"].includes(action) ||
    data == null || jsonType(data) !== "object" || new TextEncoder().encode(jsonbText(data)).length > 262144)
    raise("22023", "erp_pos_invalid_action");
  const hash = createHash("sha256").update(jsonbText({ actor: user, scope: "sale", action, data })).digest("hex");
  const previous = replay(db, "erp_pos__command", command, user!, hash, "erp_pos_command_conflict");
  if (previous) return JSON.parse(jsonbText({ ...previous, replayed: true }));
  let id: string, before: Json | null = null;
  if (action === "sale_save" || action === "sale_finish") {
    const old = uid(data, "sale_id");
    if (old !== null) before = saleView(db, old, true);
    id = saleWrite(ctx, user!, command, data, action === "sale_finish", a);
    if (action === "sale_finish") {
      const effects = saleEffects(ctx, user!, command, id, a);
      db.exec(`UPDATE "erp_pos__sale" SET state='finished', finished_at=?, finished_by=?, effects=?, version=version+1, updated_at=? WHERE id=?`,
        ctx.clock.next().toString(), user, jsonbText(effects), ctx.clock.next().toString(), id);
    }
  } else if (action === "sale_cancel") {
    before = saleView(db, uid(data, "sale_id", true)!, true);
    id = saleCancel(ctx, user!, command, data, a);
  } else {
    keys(data, ["sale_id", "expected_version", "table_number"], ["sale_id", "expected_version", "table_number"]);
    const s = saleRow(db, uid(data, "sale_id", true)!);
    if (!s) raise("P0002", "erp_pos_not_found");
    if (s.version !== int(data, "expected_version", 1, 2147483646)) raise("40001", "erp_pos_version_conflict");
    if (s.state !== "open" || s.kind !== "mesa" || !prefFlag(db, "pdv.controle_mesas")) raise("40001", "erp_pos_sale_state");
    const table = int(data, "table_number", 1, 9999);
    if (table === s.table_number) raise("22023", "erp_pos_invalid_number");
    if (one(db, `SELECT 1 FROM "erp_pos__sale" WHERE state='open' AND kind='mesa' AND table_number=?`, table)) raise("40001", "erp_pos_table_busy");
    id = String(s.id);
    before = saleView(db, id, true);
    db.exec('UPDATE "erp_pos__sale" SET table_number=?, version=version+1, updated_at=? WHERE id=?', table, ctx.clock.next().toString(), id);
  }
  access(db, user, true);
  const result = { entity: "pos_sale", record: saleView(db, id, true), action, data_mode: "erp_native", replayed: false };
  db.exec('INSERT INTO "erp_pos__command"(id, actor, scope, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    command, user, "sale", hash, jsonbText(result), ctx.clock.next().toString());
  db.exec('INSERT INTO "erp_pos__audit"(id,actor,command_id,sale_id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_pos__audit", "id"), user, command, id, action, before === null ? null : jsonbText(before), jsonbText(result.record), ctx.clock.next().toString());
  return JSON.parse(jsonbText(result));
}

registerRpc("erp_pos_sale_execute", erpPosSaleExecute);
