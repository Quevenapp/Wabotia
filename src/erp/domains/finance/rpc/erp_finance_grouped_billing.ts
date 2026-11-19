// Faturamento agrupado (SQL 141, com as notas da 247): public.erp_finance_grouped_billing_execute
// (gerar contas por cliente e excluir), _page, _candidates e _documents.
// O erp_document_mirror.require_visible vem do documents/public.ts: sem documento espelhado, não faz nada.
// grouped_billing.number é identity: nextIdentity (engine/sequence.ts), que não
// volta com a transação, como o nextval do Postgres.
import { fromColumn } from "../../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireRpcParts } from "../../../engine/parts-gate.ts";
import { erpRequirementMet, type ErpPartKey } from "../../../parts.ts";
import { erpEntityRequirement } from "../../../parts-requirements.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { guardTrashChild, mirrorRequireVisible as documentsMirrorRequireVisible, requireAccess as documentsAccess } from "../../documents/public.ts";
import { uuidIn } from "../../../engine/args.ts";
import {
  bool,
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  expected,
  field,
  insertAudit,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  setFlag,
  ts,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import { cashCategory, cashText } from "../cash.ts";
import { invoiceContact, invoiceEffectActive, invoiceOrdersPosted, invoiceTotalCents } from "../invoices.ts";
import { insertTitle, left, updateTitle } from "../titles.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const cmpNumNullsLast = (x: unknown, y: unknown) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : Number(x) - Number(y));

/** erp_finance.grouped_billing_access */
function access(db: SqlDriver, user: string, write: boolean) {
  requireAccess(db, user, write);
  // Os pedidos são lidos como o lançamento financeiro os lê (017).
  documentsAccess(db, user, "sales_orders", false);
}

/** (d.total*100)::bigint: total é numeric com 2 casas, guardado escalado. */
const docCents = (d: Row) => (d.total === null || d.total === undefined ? null : Number(fromColumn(d.total)));



/** erp_finance.grouped_billing_eligible(document) */
function documentEligible(db: SqlDriver, d: Row) {
  const total = docCents(d);
  return (
    d.kind === "sales_orders" &&
    ["verified", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(d.status)) &&
    total !== null && total > 0 &&
    !one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, d.id) &&
    !one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', d.id) &&
    !db.exec('SELECT invoice_id FROM "erp_fiscal_invoices__invoice_order" WHERE document_id=?', d.id).rows.some((o) => invoiceEffectActive(db, String(o.invoice_id)))
  );
}

/** erp_finance.grouped_billing_invoice_eligible(invoice) */
function invoiceEligible(db: SqlDriver, v: Row) {
  return (
    v.model === "55" && v.direction === "1" && v.deleted_at === null && ![3, 10].includes(Number(v.status)) &&
    (invoiceTotalCents(v.totals) ?? 0) > 0 && invoiceContact(v.recipient) !== null && !invoiceEffectActive(db, String(v.id)) &&
    invoiceOrdersPosted(db, String(v.id)).length === 0
  );
}

/** erp_finance.grouped_billing_view */
function billingView(db: SqlDriver, id: string) {
  const b = one(db, 'SELECT b.*, r.name contact_name FROM "erp_finance__grouped_billing" b JOIN "erp_catalog__record" r ON r.id=b.contact_id WHERE b.id=?', id);
  if (!b) return null;
  const documents = db
    .exec('SELECT d.id, d.number, g.total_cents FROM "erp_finance__grouped_billing_document" g JOIN "erp_documents__document" d ON d.id=g.document_id WHERE g.billing_id=?', id)
    .rows.sort((x, y) => cmpNumNullsLast(x.number, y.number))
    .map((d) => ({ id: d.id, number: d.number === null ? null : String(d.number), total_cents: String(d.total_cents) }));
  const invoices = db
    .exec('SELECT i.id, i.number, g.total_cents FROM "erp_finance__grouped_billing_invoice" g JOIN "erp_fiscal_invoices__invoice" i ON i.id=g.invoice_id WHERE g.billing_id=?', id)
    .rows.sort((x, y) => cmpNumNullsLast(x.number, y.number) || cmpText(String(x.id), String(y.id)))
    .map((i) => ({ id: i.id, number: i.number === null ? null : String(i.number), total_cents: String(i.total_cents) }));
  const titles = db
    .exec('SELECT t.id, l.position, t.due_on, t.amount_cents, t.settled_cents, t.cancelled FROM "erp_finance__grouped_billing_title" l JOIN "erp_finance__title" t ON t.id=l.title_id WHERE l.billing_id=?', id)
    .rows.sort((x, y) => Number(x.position) - Number(y.position))
    .map((t) => ({ id: t.id, position: t.position, due_on: t.due_on, amount_cents: String(t.amount_cents), settled_cents: String(t.settled_cents), cancelled: bool(t.cancelled) }));
  const deletable =
    b.state === "active" &&
    !one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_title" l JOIN "erp_finance__settlement" s ON s.title_id=l.title_id WHERE l.billing_id=? LIMIT 1', id) &&
    !one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_title" l JOIN "erp_cnab__billing_title" c ON c.title_id=l.title_id WHERE l.billing_id=? LIMIT 1', id);
  return {
    id: b.id, number: String(b.number), contact_id: b.contact_id, contact_name: b.contact_name, issued_on: b.issued_on, condition: b.condition,
    total_cents: String(b.total_cents), state: b.state, version: b.version, created_at: ts(b.created_at), documents, invoices, titles, deletable,
  };
}

/** Lista JSON de uuids (cada um por uuid_value). */
const uuidList = (v: unknown) => ((v ?? []) as unknown[]).map((x) => uuidValue(x)!);

function generate(ctx: RpcContext, data: unknown, user: string, command: string) {
  requireRpcParts(ctx, "erp_finance_grouped_billing_execute", { p_action: "grouped_billing_generate", p_data: data });
  const db = ctx.db;
  const today = todaySaoPaulo();
  // GERAR CONTAS: cada cliente com os seus pedidos e notas (o total lido é o CAS) e a Condição em dias depois de hoje.
  keys(data, ["items", "category_id"]);
  const items = field(data, "items");
  if (jsonType(items) !== "array" || (items as unknown[]).length < 1 || (items as unknown[]).length > 50) raise("22023", "erp_finance_invalid_items");
  const category =
    cashCategory(db, field(data, "category_id"), "receivable") ??
    ((one(
      db,
      `SELECT d.category_id FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id WHERE d.key='sale' AND c.active=1 AND c.deleted_at IS NULL`,
    )?.category_id ?? null) as string | null);
  const list = (item: unknown, key: string) => (field(item, key) === undefined ? [] : field(item, key));
  for (const item of items as unknown[]) {
    keys(item, ["contact_id", "document_ids", "invoice_ids", "total_cents", "condition", "days"]);
    const docs = list(item, "document_ids"), invs = list(item, "invoice_ids");
    if (
      jsonType(docs) !== "array" || jsonType(invs) !== "array" ||
      (docs as unknown[]).length > 200 || (invs as unknown[]).length > 200 || (docs as unknown[]).length + (invs as unknown[]).length < 1
    )
      raise("22023", "erp_finance_invalid_items");
  }
  const invoiceIds = [...new Set((items as unknown[]).flatMap((i) => uuidList(list(i, "invoice_ids"))))].sort(cmpText);
  const documentIds = new Set((items as unknown[]).flatMap((i) => uuidList(list(i, "document_ids"))));
  for (const inv of invoiceIds)
    for (const o of db.exec('SELECT document_id FROM "erp_fiscal_invoices__invoice_order" WHERE invoice_id=?', inv).rows) documentIds.add(String(o.document_id));
  if (documentIds.size + invoiceIds.length > 500) raise("22023", "erp_finance_invalid_items");
  const created: unknown[] = [];
  for (const item of items as unknown[]) {
    const contact = uuidValue(field(item, "contact_id"))!;
    const daysValue = field(item, "days");
    if (jsonType(daysValue) !== "array" || (daysValue as unknown[]).length < 1 || (daysValue as unknown[]).length > 120) raise("22023", "erp_finance_invalid_items");
    const days = (daysValue as unknown[]).filter((v) => jsonType(v) === "number" && /^[0-9]{1,4}$/.test(jsonbText(v))).map((v) => Number(jsonbText(v)));
    if (days.length !== (daysValue as unknown[]).length || days.some((d, k) => d > 3650 || (k > 0 && d < days[k - 1]))) raise("22023", "erp_finance_invalid_condition");
    const docsOfItem = uuidList(list(item, "document_ids"));
    const invoicesOfItem = uuidList(list(item, "invoice_ids"));
    const countIn = (table: string, ids: string[]) => ids.filter((id) => one(db, `SELECT 1 x FROM "${table}" WHERE id=?`, id)).length;
    if (
      new Set(docsOfItem).size !== docsOfItem.length || new Set(invoicesOfItem).size !== invoicesOfItem.length ||
      countIn("erp_documents__document", docsOfItem) !== docsOfItem.length || countIn("erp_fiscal_invoices__invoice", invoicesOfItem) !== invoicesOfItem.length
    )
      raise("22023", "erp_finance_invalid_items");
    let sum = 0;
    const numbers: string[] = [];
    const notes: string[] = [];
    const docs = docsOfItem.map((id) => one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', id)!).sort((x, y) => cmpNumNullsLast(x.number, y.number));
    for (const d of docs) {
      if (d.contact_id !== contact || !documentEligible(db, d)) raise("40001", "erp_finance_grouped_billing_document");
      documentsAccess(db, user, "sales_orders", false);
      sum += docCents(d)!;
      if (d.number !== null) numbers.push(String(d.number)); // concat_ws pula o número nulo
    }
    const invoices = invoicesOfItem
      .map((id) => one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', id)!)
      .sort((x, y) => cmpNumNullsLast(x.number, y.number) || cmpText(String(x.id), String(y.id)));
    for (const v of invoices) {
      if (invoiceContact(v.recipient) !== contact || !invoiceEligible(db, v)) raise("40001", "erp_finance_grouped_billing_document");
      // Uma nota e o seu pedido são uma venda só: nunca os dois no faturamento.
      if (db.exec('SELECT document_id FROM "erp_fiscal_invoices__invoice_order" WHERE invoice_id=?', v.id).rows.some((o) => docsOfItem.includes(String(o.document_id))))
        raise("22023", "erp_finance_grouped_billing_duplicate");
      sum += invoiceTotalCents(v.totals)!;
      notes.push(v.number === null ? "(sem número)" : String(v.number));
    }
    const total = cents(field(item, "total_cents"), false);
    if (sum !== total) raise("40001", "erp_finance_grouped_billing_total");
    const count = days.length;
    if (total < count) raise("22023", "erp_finance_invalid_condition");
    if (addDays(today, days[count - 1]) > "2100-12-31") raise("22023", "erp_finance_invalid_condition");
    // Ordem das colunas do INSERT (plano genérico): o nextval do number vem antes do cash_text da condição.
    const billing = crypto.randomUUID();
    const number = nextIdentity(ctx, "erp_finance__grouped_billing", "number");
    const condition = cashText(item, "condition", 200, true);
    db.exec(
      `INSERT INTO "erp_finance__grouped_billing"(id, number, contact_id, issued_on, condition, total_cents, state, version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,'active',1,?,?,?)`,
      billing, number, contact, today, condition, total, user, command, ctx.clock.next().toString(),
    );
    for (const d of docs) {
      guardTrashChild(db, String(d.id));
      db.exec('INSERT INTO "erp_finance__grouped_billing_document"(billing_id, document_id, total_cents, active) VALUES(?,?,?,1)', billing, d.id, docCents(d));
    }
    for (const v of invoices)
      db.exec('INSERT INTO "erp_finance__grouped_billing_invoice"(billing_id, invoice_id, total_cents, active) VALUES(?,?,?,1)', billing, v.id, invoiceTotalCents(v.totals));
    // Parcelas iguais em centavos exatos; as primeiras absorvem o resto (como Gerar parcelas do pedido).
    const parts = [numbers.length ? `pedidos nº ${numbers.join(", ")}` : null, notes.length ? `notas nº ${notes.join(", ")}` : null].filter((x) => x !== null);
    const description = left(`Faturamento agrupado: ${parts.join(" · ")}`, 240);
    for (let index = 1; index <= count; index++) {
      const part = Math.floor(total / count) + (index - 1 < total % count ? 1 : 0);
      const title = insertTitle(ctx, {
        group_id: billing, installment: index, installments: count, kind: "receivable", contact_id: contact, category_id: category, description,
        issued_on: today, due_on: addDays(today, days[index - 1]), amount_cents: part, competence_on: today,
      });
      db.exec('INSERT INTO "erp_finance__grouped_billing_title"(title_id, billing_id, position) VALUES(?,?,?)', title, billing, index);
    }
    created.push(billingView(db, billing));
  }
  return { entity: "grouped_billings", items: created };
}

function remove(ctx: RpcContext, data: unknown, user: string) {
  requireRpcParts(ctx, "erp_finance_grouped_billing_execute", { p_action: "grouped_billing_delete", p_data: data });
  const db = ctx.db;
  // Excluir selecionados: as contas sem baixa nem boleto são canceladas e os pedidos e notas liberados.
  keys(data, ["id", "expected_version"]);
  const row = one(db, 'SELECT * FROM "erp_finance__grouped_billing" WHERE id=?', uuidValue(field(data, "id")));
  if (!row || row.state !== "active") raise("P0002", "erp_finance_not_found");
  if (row.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
  const before = billingView(db, String(row.id))!;
  if (!before.deletable) raise("40001", "erp_finance_grouped_billing_locked");
  setFlag(ctx, "erp_finance.grouped_owner", "on");
  for (const t of db.exec('SELECT t.id, t.version FROM "erp_finance__grouped_billing_title" l JOIN "erp_finance__title" t ON t.id=l.title_id WHERE l.billing_id=? AND t.deleted_at IS NULL', row.id).rows) {
    const now = ctx.clock.next().toString();
    updateTitle(ctx, String(t.id), { cancelled: true, deleted_at: now, deleted_by: user, deleted_note: "Faturamento agrupado excluído", version: Number(t.version) + 1, updated_at: now });
  }
  setFlag(ctx, "erp_finance.grouped_owner", "");
  for (const g of db.exec('SELECT document_id FROM "erp_finance__grouped_billing_document" WHERE billing_id=?', row.id).rows) guardTrashChild(db, String(g.document_id));
  db.exec('UPDATE "erp_finance__grouped_billing_document" SET active=0 WHERE billing_id=?', row.id);
  db.exec('UPDATE "erp_finance__grouped_billing_invoice" SET active=0 WHERE billing_id=?', row.id);
  writeRow(ctx, "erp_finance__grouped_billing", "id", row.id, { state: "deleted", deleted_at: ctx.clock.next().toString(), deleted_by: user, version: Number(row.version) + 1 });
  return { result: { entity: "grouped_billings", record: { id: row.id, deleted: true } }, before };
}

export function erpFinanceGroupedBillingExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireRpcParts(ctx, "erp_finance_grouped_billing_execute", { ...a, p_data: data });
  access(db, user, true);
  if (command === null || action === null || !["grouped_billing_generate", "grouped_billing_delete"].includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 262144) raise("22023", "erp_finance_invalid_data");
  // require_visible de cada pedido citado ($.items[*].document_ids[*], texto com cara de uuid).
  const items = (data as Record<string, unknown>).items;
  if (Array.isArray(items))
    for (const it of items) {
      const ids = it !== null && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>).document_ids : undefined;
      if (Array.isArray(ids))
        for (const x of ids) if (typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x)) documentsMirrorRequireVisible(db, user, uuidIn(x), true);
    }
  const hash = requestHash(user, action, data);
  access(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;
  let result: Record<string, unknown>;
  let before: unknown = null;
  if (action === "grouped_billing_generate") result = generate(ctx, data, user, command);
  else ({ result, before } = remove(ctx, data, user));
  access(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

export function erpFinanceGroupedBillingPage(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_finance_grouped_billing_page", a);
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  access(db, user, false);
  if (page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 || (query !== null && (charLength(query) > 120 || CNTRL.test(query))) || (from !== null && to !== null && from > to))
    raise("22023", "erp_finance_invalid_query");
  const rows = db
    .exec(`SELECT b.id, b.issued_on, b.number, r.name FROM "erp_finance__grouped_billing" b JOIN "erp_catalog__record" r ON r.id=b.contact_id WHERE b.state='active'`)
    .rows.filter((b) => (from === null || String(b.issued_on) >= from) && (to === null || String(b.issued_on) <= to) && (needle === null || pgLower(String(b.name)).includes(needle)))
    .sort((x, y) => cmpText(String(y.issued_on), String(x.issued_on)) || Number(y.number) - Number(x.number));
  return {
    entity: "grouped_billings", from, to, page, limit, total: rows.length,
    items: rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((b) => billingView(db, String(b.id))),
    data_mode: "erp_native",
  };
}

/** p_documents uuid[]: ndims 1, 1..200, sem null */
const badDocuments = (docs: (string | null)[] | null) => docs !== null && (!Array.isArray(docs) || docs.some((d) => Array.isArray(d)) || docs.length < 1 || docs.length > 200 || docs.includes(null));

export function erpFinanceGroupedBillingCandidates(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_finance_grouped_billing_candidates", a);
  const sales = erpRequirementMet(ctx.parts, erpEntityRequirement("sales_orders")!);
  const fiscal = erpRequirementMet(ctx.parts, erpEntityRequirement("nfe")!);
  const unavailable: ErpPartKey[] = [];
  if (!sales) unavailable.push("sales");
  if (!fiscal) unavailable.push("fiscal");
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const documents = (a.p_documents as (string | null)[] | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  access(db, user, false);
  if (
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 || (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (documents === null && (from === null || to === null || from > to || span(from, to) > 366 || from < "1900-01-01" || to > "2100-12-31")) || badDocuments(documents)
  )
    raise("22023", "erp_finance_invalid_query");
  const chosen = documents === null ? null : new Set(documents.map((d) => String(d).toLowerCase()));
  const docs: { contact: string; kind: string; cents: number }[] = [];
  for (const d of sales ? db.exec(`SELECT * FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`).rows : []) {
    if (!documentEligible(db, d)) continue;
    const date = (JSON.parse(String(d.body)) as Record<string, unknown>)?.date;
    const dateText = date === undefined || date === null ? null : typeof date === "string" ? date : jsonbText(date);
    if (chosen !== null ? !chosen.has(String(d.id)) : dateText === null || dateText < from! || dateText > to!) continue;
    // 247: o pedido cuja nota do mesmo cliente está na lista é aquela venda: o Valor Total conta só a nota.
    const noted =
      fiscal &&
      chosen === null &&
      db
        .exec('SELECT i.* FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" i ON i.id=o.invoice_id WHERE o.document_id=?', d.id)
        .rows.some((i) => invoiceContact(i.recipient) === d.contact_id && String(i.issue_date) >= from! && String(i.issue_date) <= to! && invoiceEligible(db, i));
    docs.push({ contact: String(d.contact_id), kind: "sales_orders", cents: noted ? 0 : docCents(d)! });
  }
  if (chosen === null && fiscal)
    for (const i of db.exec('SELECT * FROM "erp_fiscal_invoices__invoice" WHERE issue_date>=? AND issue_date<=?', from, to).rows)
      if (invoiceEligible(db, i)) docs.push({ contact: invoiceContact(i.recipient)!, kind: "fiscal_invoices", cents: invoiceTotalCents(i.totals)! });
  const clients = new Map<string, { name: string; documents: number; invoices: number; cents: number }>();
  for (const x of docs) {
    const r = one(db, 'SELECT r.name FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=?', x.contact);
    if (!r || (needle !== null && !pgLower(String(r.name)).includes(needle))) continue;
    const c = clients.get(x.contact) ?? { name: String(r.name), documents: 0, invoices: 0, cents: 0 };
    if (x.kind === "sales_orders") c.documents++;
    else c.invoices++;
    c.cents += x.cents;
    clients.set(x.contact, c);
  }
  const sorted = [...clients.entries()].sort(([ix, x], [iy, y]) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(ix, iy));
  return {
    entity: "grouped_billing_candidates", from, to, selected: documents !== null, page, limit, total: sorted.length,
    ...(unavailable.length ? { unavailable_parts: unavailable } : {}),
    items: sorted
      .slice((page - 1) * limit, (page - 1) * limit + limit)
      .map(([id, c]) => ({ contact_id: id, contact_name: c.name, documents: c.documents, invoices: c.invoices, total_cents: String(c.cents) })),
    data_mode: "erp_native",
  };
}

export function erpFinanceGroupedBillingDocuments(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_finance_grouped_billing_documents", a);
  const sales = erpRequirementMet(ctx.parts, erpEntityRequirement("sales_orders")!);
  const fiscal = erpRequirementMet(ctx.parts, erpEntityRequirement("nfe")!);
  const unavailable: ErpPartKey[] = [];
  if (!sales) unavailable.push("sales");
  if (!fiscal) unavailable.push("fiscal");
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const contact = uuidArg(a.p_contact);
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const documents = (a.p_documents as (string | null)[] | null) ?? null;
  access(db, user, false);
  if (contact === null || (documents === null && (from === null || to === null || from > to || span(from, to) > 366)) || badDocuments(documents))
    raise("22023", "erp_finance_invalid_query");
  const chosen = documents === null ? null : new Set(documents.map((d) => String(d).toLowerCase()));
  const docs: { id: string; kind: string; number: string | null; sort: number | null; day: string | null; cents: number | null; version: unknown; orders: unknown }[] = [];
  for (const d of sales ? db.exec(`SELECT * FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders' AND contact_id=?`, contact).rows : []) {
    if (!documentEligible(db, d)) continue;
    const date = (JSON.parse(String(d.body)) as Record<string, unknown>)?.date;
    const day = date === undefined || date === null ? null : typeof date === "string" ? date : jsonbText(date);
    if (chosen !== null ? !chosen.has(String(d.id)) : day === null || day < from! || day > to!) continue;
    docs.push({ id: String(d.id), kind: "sales_orders", number: d.number === null ? null : String(d.number), sort: d.number === null ? null : Number(d.number), day, cents: docCents(d), version: d.version, orders: null });
  }
  if (chosen === null && fiscal)
    for (const i of db.exec('SELECT * FROM "erp_fiscal_invoices__invoice" WHERE issue_date>=? AND issue_date<=?', from, to).rows) {
      if (invoiceContact(i.recipient) !== contact || !invoiceEligible(db, i)) continue;
      const orders = db
        .exec('SELECT document_id FROM "erp_fiscal_invoices__invoice_order" WHERE invoice_id=?', i.id)
        .rows.map((o) => String(o.document_id))
        .sort(cmpText);
      docs.push({ id: String(i.id), kind: "fiscal_invoices", number: i.number === null ? null : String(i.number), sort: i.number === null ? null : Number(i.number), day: String(i.issue_date), cents: invoiceTotalCents(i.totals), version: i.version, orders });
    }
  docs.sort(
    (x, y) =>
      (x.day === null ? (y.day === null ? 0 : 1) : y.day === null ? -1 : cmpText(x.day, y.day)) ||
      cmpText(y.kind, x.kind) ||
      cmpNumNullsLast(x.sort, y.sort) ||
      cmpText(x.id, y.id),
  );
  return {
    entity: "grouped_billing_documents", contact_id: contact, total: docs.length,
    ...(unavailable.length ? { unavailable_parts: unavailable } : {}),
    items: docs.slice(0, 500).map((x) => ({ id: x.id, kind: x.kind, number: x.number, date: x.day, total_cents: x.cents === null ? null : String(x.cents), version: x.version, orders: x.orders })),
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_grouped_billing_execute", erpFinanceGroupedBillingExecute);
registerRpc("erp_finance_grouped_billing_page", erpFinanceGroupedBillingPage);
registerRpc("erp_finance_grouped_billing_candidates", erpFinanceGroupedBillingCandidates);
registerRpc("erp_finance_grouped_billing_documents", erpFinanceGroupedBillingDocuments);
