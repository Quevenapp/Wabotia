// Notas fiscais no Financeiro (SQL 247), as leituras: public.erp_finance_invoice_finance_get,
// _flags, _preview e erp_finance_invoice_order_titles; e as escritas erp_finance_invoice_finance_post
// (erp_finance.invoice_post, com a captura de comissão de cada parcela) e _reverse.
// A rota fica atrás do bloco erp-fiscal (src/erp/blocks.ts): com o bloco desligado responde 409
// antes do motor. A emissão da nota é do Fiscal, ainda não portado: os testes criam a nota direto
// no banco. Quando o Fiscal for portado, os testes de notas precisam ser revisitados.
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { activeRole } from "../../access/public.ts";
import {
  charLength,
  documentCommandFinish,
  documentCommandStart,
  expected,
  field,
  insertAudit,
  jsonArg,
  keys,
  requireAccess,
  setFlag,
  txt,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import {
  insertInvoiceTitle,
  invoiceBlockedReason,
  invoiceContact,
  invoiceEffect,
  invoiceKind,
  invoiceLabel,
  invoiceOrdersPosted,
  invoicePostingSummary,
  invoiceTitleRows,
  invoiceTotalCents,
} from "../invoices.ts";
import { insertTitle, left, updateTitle } from "../titles.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** erp_finance.invoice_read_access: admin, financeiro, consulta e fiscal leem. */
function invoiceReadAccess(db: SqlDriver, user: string) {
  const role = activeRole(db, user);
  if (role === null || !["admin", "financeiro", "consulta", "fiscal"].includes(role)) raise("42501", "erp_finance_access_denied");
  return role;
}

/** to_char(cents/100.0,'FM9999999999990.00') */
const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const textOf = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));

/** erp_finance.invoice_preview_data(nota, categoria, conta) */
export function invoicePreviewData(db: SqlDriver, v: Row, category: string | null, account: string | null) {
  const kind = invoiceKind(v.direction);
  const reason = invoiceBlockedReason(db, v);
  if (reason !== null) raise(["erp_finance_invalid_contact", "erp_finance_invoice_zero_total"].includes(reason) ? "22023" : "40001", reason);
  const c = one(
    db,
    'SELECT r.* FROM "erp_catalog__record" r JOIN "erp_catalog__contact" x ON x.record_id=r.id WHERE r.id=? AND r.active=1',
    invoiceContact(v.recipient),
  );
  if (!c) raise("22023", "erp_finance_invalid_contact");
  let g: Row | undefined;
  if (category !== null) {
    g = one(db, `SELECT * FROM "erp_finance__category" WHERE id=? AND active=1 AND deleted_at IS NULL AND kind IN (?, 'both')`, category, kind);
    if (!g) raise("22023", "erp_finance_invalid_category");
  } else {
    g = one(
      db,
      `SELECT x.* FROM "erp_finance__category_default" d JOIN "erp_finance__category" x ON x.id=d.category_id WHERE d.key=? AND x.active=1 AND x.deleted_at IS NULL`,
      kind === "receivable" ? "sale" : "purchase",
    );
  }
  let a: Row | undefined;
  if (account !== null) {
    a = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=? AND active=1 AND deleted_at IS NULL', account);
    if (!a) raise("22023", "erp_finance_invalid_account");
  }
  const total = invoiceTotalCents(v.totals)!;
  const payment = typeof v.payment === "string" ? JSON.parse(v.payment) : v.payment;
  const given = payment && typeof payment === "object" && Array.isArray(payment.installments) ? payment.installments : [];
  const parts = given.length > 0 ? given : [{ date: v.issue_date, amount: money(total) }];
  const out: Record<string, unknown>[] = [];
  let sum = 0;
  let n = 0;
  for (const part of parts) {
    const amountText = textOf(part?.amount), dateText = textOf(part?.date);
    if (amountText === null || !/^[0-9]{1,13}(\.[0-9]{1,2})?$/.test(amountText) || dateText === null || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateText))
      raise("22023", "erp_finance_invoice_invalid_installment");
    const [i, f = ""] = amountText.split(".");
    const amount = Number(i) * 100 + Number(f.padEnd(2, "0"));
    if (Number.isNaN(Date.parse(`${dateText}T00:00:00Z`)) || new Date(`${dateText}T00:00:00Z`).toISOString().slice(0, 10) !== dateText) raise("22008", `date/time field value out of range: "${dateText}"`);
    if (amount <= 0 || dateText < String(v.issue_date) || dateText > "2100-12-31") raise("22023", "erp_finance_invoice_invalid_installment");
    const methodText = textOf(part?.payment_method_id);
    const method = methodText !== null && UUID.test(methodText) ? one(db, 'SELECT * FROM "erp_catalog__payment_method" WHERE id=? AND deleted_at IS NULL', methodText.toLowerCase()) : undefined;
    const accountId =
      (a?.id as string | undefined) ??
      ((method?.account_id ? one(db, 'SELECT id FROM "erp_finance__account" WHERE id=? AND active=1 AND deleted_at IS NULL', method.account_id)?.id : undefined) as string | undefined) ??
      null;
    n++;
    sum += amount;
    const accountName = accountId === null ? null : ((one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', accountId)?.name as string | undefined) ?? null);
    out.push({
      position: n, amount_cents: String(amount), due_on: dateText, method: textOf(part?.method), payment_method_id: method?.id ?? null,
      payment_method_name: method ? left(String(method.description), 100) : null, account_id: accountId, account_name: accountName === null ? null : left(accountName, 200),
    });
  }
  if (n < 1 || n > 120 || sum !== total) raise("22023", "erp_finance_installment_total_mismatch");
  const seller = kind === "receivable" && v.seller_id !== null ? ((one(db, 'SELECT id FROM "erp_catalog__seller" WHERE id=?', v.seller_id)?.id as string | undefined) ?? null) : null;
  const r = {
    invoice_id: v.id, invoice_version: v.version, model: v.model, direction: kind, series: v.series, number: v.number === null ? null : String(v.number), status: v.status,
    issued_on: v.issue_date, contact_id: c.id, contact_name: left(String(c.name), 200), contact_version: c.version, total_cents: String(total),
    category_id: g?.id ?? null, category_name: g ? left(String(g.name), 200) : null, account_id: a?.id ?? null, account_name: a ? left(String(a.name), 200) : null,
    seller_id: seller, installments: out,
  };
  return { ...r, preview_hash: createHash("sha256").update(jsonbText(r), "utf8").digest("hex") };
}

function get(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = invoiceReadAccess(db, uuidArg(a.p_user_id)!);
  const id = uuidArg(a.p_invoice_id);
  if (id === null) raise("22023", "erp_finance_invalid_query");
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', id);
  if (!v) raise("P0002", "erp_finance_not_found");
  const active = (one(db, `SELECT id FROM "erp_finance__invoice_posting" WHERE invoice_id=? AND state='active'`, v.id)?.id as string | undefined) ?? null;
  const g = one(
    db,
    'SELECT b.id, b.number FROM "erp_finance__grouped_billing_invoice" g JOIN "erp_finance__grouped_billing" b ON b.id=g.billing_id WHERE g.invoice_id=? AND g.active=1',
    v.id,
  );
  const contact = invoiceContact(v.recipient);
  const contactName =
    (contact === null ? undefined : (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', contact)?.name as string | undefined)) ?? textOf((typeof v.recipient === "string" ? JSON.parse(v.recipient) : v.recipient)?.name);
  const postings = db
    .exec('SELECT id, created_at FROM "erp_finance__invoice_posting" WHERE invoice_id=?', v.id)
    .rows.sort((x, y) => Number(y.created_at) - Number(x.created_at) || (String(x.id) < String(y.id) ? -1 : 1))
    .slice(0, 20)
    .map((p) => invoicePostingSummary(db, String(p.id)));
  return {
    entity: "invoice_finance",
    invoice: {
      id: v.id, version: v.version, model: v.model, direction: v.direction, kind: invoiceKind(v.direction), series: v.series, number: v.number === null ? null : String(v.number),
      status: v.status, issue_date: v.issue_date, total_cents: String(invoiceTotalCents(v.totals) ?? 0), contact_id: contact,
      contact_name: contactName === null || contactName === undefined ? null : left(contactName, 200), deleted: v.deleted_at !== null,
    },
    active_posting: active === null ? null : invoicePostingSummary(db, active),
    titles: active === null ? [] : invoiceTitleRows(db, active),
    grouped_billing: g ? { id: g.id, number: String(g.number) } : null,
    orders_posted: invoiceOrdersPosted(db, String(v.id)),
    blocked_reason: invoiceBlockedReason(db, v),
    postings,
    writable: ["admin", "financeiro"].includes(role),
    data_mode: "erp_native",
    cash_movement_performed: false,
  };
}

function flags(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  invoiceReadAccess(db, uuidArg(a.p_user_id)!);
  const ids = (a.p_ids as (string | null)[] | null) ?? null;
  if (ids === null || ids.some((x) => Array.isArray(x)) || ids.length < 1 || ids.length > 100 || ids.includes(null)) raise("22023", "erp_finance_invalid_query");
  const wanted = new Set(ids.map((x) => String(x).toLowerCase()));
  const items = db
    .exec('SELECT id FROM "erp_fiscal_invoices__invoice"')
    .rows.filter((i) => wanted.has(String(i.id)))
    .sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1))
    .map((i) => {
      const categories = [
        ...new Set(
          db
            .exec(
              `SELECT t.category_id FROM "erp_finance__invoice_posting" p JOIN "erp_finance__invoice_title" l ON l.posting_id=p.id JOIN "erp_finance__title" t ON t.id=l.title_id
                 WHERE p.invoice_id=? AND p.state='active' AND t.category_id IS NOT NULL`,
              i.id,
            )
            .rows.map((r) => String(r.category_id)),
        ),
      ].sort();
      return {
        invoice_id: i.id,
        posted: !!one(db, `SELECT 1 x FROM "erp_finance__invoice_posting" WHERE invoice_id=? AND state='active' LIMIT 1`, i.id),
        grouped: !!one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_invoice" WHERE invoice_id=? AND active=1 LIMIT 1', i.id),
        category_ids: categories,
      };
    });
  return { entity: "invoice_finance_flags", items, data_mode: "erp_native" };
}

function preview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireAccess(db, uuidArg(a.p_user_id)!, true);
  const id = uuidArg(a.p_invoice_id);
  const expected = (a.p_expected_version as number | null) ?? null;
  if (id === null || expected === null || expected < 1) raise("22023", "erp_finance_invalid_query");
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', id);
  if (!v) raise("P0002", "erp_finance_not_found");
  if (v.version !== expected) raise("40001", "erp_finance_invoice_version_conflict");
  return { preview: invoicePreviewData(db, v, uuidArg(a.p_category_id), uuidArg(a.p_account_id)), data_mode: "erp_native", cash_movement_performed: false };
}

function orderTitles(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireAccess(db, uuidArg(a.p_user_id)!, false);
  const id = uuidArg(a.p_invoice_id);
  if (id === null || !one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice" WHERE id=?', id)) raise("P0002", "erp_finance_not_found");
  const effect = invoiceEffect(db, id);
  const owner = (effect?.owner as string | undefined) ?? null;
  return {
    entity: "invoice_order_titles", data_mode: "erp_native", operational_effects: false, invoice_id: id, owner,
    orders: owner === "orders" ? effect!.orders : [],
  };
}

/** erp_finance.invoice_post(usuário, comando, dados, origem) */
export function invoicePost(ctx: RpcContext, user: string, command: string | null, data: unknown, origin: "manual" | "automatic") {
  const db = ctx.db;
  if (data === null || data === undefined || jsonType(data) !== "object") raise("22023", "erp_finance_invalid_data");
  keys(data, ["invoice_id", "expected_version", "preview_hash", "category_id", "account_id"]);
  const group = crypto.randomUUID();
  const replay = documentCommandStart(db, user, command, "invoice_post", data);
  if (replay) return replay;
  const category = uuidValue(field(data, "category_id"), false);
  const account = uuidValue(field(data, "account_id"), false);
  // erp_finance.invoice_lock: as travas não têm efeito numa transação só.
  const id = uuidValue(field(data, "invoice_id"));
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', id);
  if (!v) raise("P0002", "erp_finance_not_found");
  if (v.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_invoice_version_conflict");
  const { preview_hash: hash, ...snapshot } = invoicePreviewData(db, v, category, account);
  const given = field(data, "preview_hash");
  if (jsonType(given) !== "string" || given !== hash) raise("40001", "erp_finance_invoice_preview_conflict");
  const posting = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__invoice_posting"(id, invoice_id, invoice_version, group_id, state, version, origin, snapshot, preview_hash, actor, command_id, created_at)
       VALUES(?,?,?,?,'active',1,?,?,?,?,?,?)`,
    posting, v.id, v.version, group, origin, JSON.stringify(snapshot), hash, user, command, ctx.clock.next().toString(),
  );
  const label = invoiceLabel(v.model, v.number);
  const parts = snapshot.installments;
  for (const part of parts) {
    const title = insertTitle(ctx, {
      group_id: group, installment: part.position, installments: parts.length, kind: snapshot.direction, contact_id: snapshot.contact_id,
      category_id: snapshot.category_id, description: label, source_reference: v.number === null ? null : String(v.number), issued_on: v.issue_date,
      due_on: part.due_on, amount_cents: Number(part.amount_cents), competence_on: v.issue_date, account_id: part.account_id,
      payment_method_id: part.payment_method_id, original_due_on: part.due_on,
    });
    insertInvoiceTitle(ctx, title, posting, Number(part.position));
  }
  const result = { invoice_id: v.id, invoice_version: v.version, posting: invoicePostingSummary(db, posting), titles: invoiceTitleRows(db, posting) };
  // A auditoria confere Lançar contas de Notas fiscais / Notas de entrada (246).
  insertAudit(ctx, user, command!, "invoice_post", null, result);
  return documentCommandFinish(ctx, user, command!, "invoice_post", data, result);
}

function post(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  requireAccess(ctx.db, user, true);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  const r = invoicePost(ctx, user, uuidArg(a.p_command_id), data, "manual");
  return r;
}

function reverse(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  requireAccess(db, user, true);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  if (data === null || jsonType(data) !== "object") raise("22023", "erp_finance_invalid_data");
  keys(data, ["invoice_id", "posting_id", "expected_version", "titles", "reason"]);
  const replay = documentCommandStart(db, user, command, "invoice_reverse", data);
  if (replay) return replay;
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', uuidValue(field(data, "invoice_id")));
  if (!v) raise("P0002", "erp_finance_not_found");
  const p = one(db, 'SELECT * FROM "erp_finance__invoice_posting" WHERE id=? AND invoice_id=?', uuidValue(field(data, "posting_id")), v.id);
  if (!p) raise("P0002", "erp_finance_not_found");
  if (p.state !== "active" || p.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_invoice_version_conflict");
  if (
    one(db, 'SELECT 1 x FROM "erp_finance__title" t JOIN "erp_finance__invoice_title" l ON l.title_id=t.id WHERE l.posting_id=? AND t.settled_cents<>0 LIMIT 1', p.id) ||
    one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" b JOIN "erp_finance__invoice_title" l ON l.title_id=b.title_id WHERE l.posting_id=? LIMIT 1', p.id)
  )
    raise("40001", "erp_finance_invoice_reverse_blocked");
  const note = txt(data, "reason", 1000, true)!;
  if (charLength(note) < 3) raise("22023", "erp_finance_invoice_reason_required");
  const titles = field(data, "titles");
  if (jsonType(titles) !== "array" || (titles as unknown[]).length < 1 || (titles as unknown[]).length > 120) raise("22023", "erp_finance_invalid_items");
  for (const part of titles as unknown[]) {
    keys(part, ["id", "version"]);
    uuidValue(field(part, "id"));
    expected(field(part, "version"));
  }
  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const want = (titles as unknown[]).map((x) => ({ id: String(field(x, "id")).toLowerCase(), version: Number(field(x, "version")) })).sort(byId);
  const have = db
    .exec('SELECT t.id, t.version FROM "erp_finance__title" t JOIN "erp_finance__invoice_title" l ON l.title_id=t.id WHERE l.posting_id=?', p.id)
    .rows.map((t) => ({ id: String(t.id), version: Number(t.version) }))
    .sort(byId);
  if (want.length !== have.length || want.some((x, i) => x.id !== have[i].id || x.version !== have[i].version))
    raise("40001", "erp_finance_invoice_title_version_conflict");
  const before = { posting: invoicePostingSummary(db, String(p.id)), titles: invoiceTitleRows(db, String(p.id)) };
  setFlag(ctx, "erp_finance.invoice_owner", String(p.id));
  for (const t of db.exec('SELECT t.id, t.version FROM "erp_finance__title" t JOIN "erp_finance__invoice_title" l ON l.title_id=t.id WHERE l.posting_id=? AND t.cancelled=0', p.id).rows)
    updateTitle(ctx, String(t.id), { cancelled: true, version: Number(t.version) + 1, updated_at: ctx.clock.next().toString() });
  setFlag(ctx, "erp_finance.invoice_owner", "");
  writeRow(ctx, "erp_finance__invoice_posting", "id", p.id, {
    state: "reversed", version: Number(p.version) + 1, reversed_at: ctx.clock.next().toString(), reversed_by: user, reason: note,
  });
  const result = { invoice_id: v.id, invoice_version: v.version, posting: invoicePostingSummary(db, String(p.id)), titles: invoiceTitleRows(db, String(p.id)) };
  insertAudit(ctx, user, command!, "invoice_reverse", before, result);
  const r = documentCommandFinish(ctx, user, command!, "invoice_reverse", data, result);
  return r;
}

registerRpc("erp_finance_invoice_finance_get", get);
registerRpc("erp_finance_invoice_finance_flags", flags);
registerRpc("erp_finance_invoice_finance_preview", preview);
registerRpc("erp_finance_invoice_order_titles", orderTitles);
registerRpc("erp_finance_invoice_finance_post", post);
registerRpc("erp_finance_invoice_finance_reverse", reverse);
