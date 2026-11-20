// Ponte do Documentos com o Financeiro (B5): public.erp_document_finance_preview, _post,
// _reverse_preview, _reverse, _get e _list. O lançamento das contas de pedido de venda, de compra
// e de OS: a prévia (document_preview_data e a forma e conta de cada parcela), as contas com
// o gatilho commission_capture (comissão de cada parcela) e document_title_number, o estorno e
// as leituras. O documento é lido e versionado pelo documents/public.ts.
// erp_document_mirror.require_visible: pelo documents/public.ts (o documento espelhado do Origin).
import { createHash } from "node:crypto";
import { toScaled } from "../../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { fromSqlite, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireCom1Posting } from "../../fiscal/comnfe/effect-policy.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import * as documents from "../../documents/public.ts";
import * as preferences from "../../preferences/public.ts";
import { commissionAmounts, commissionWeighted, documentSeller } from "../document-effects.ts";
import { commissionPolicy } from "../commissions.ts";
import { requireRpcParts } from "../../../engine/registry.ts";
import { driverContext, originScope, requireOriginOperation, assertOwnEffect } from "../../../engine/module-origin.ts";
import { linkedDocumentGuard } from "../../documents/module-policy.ts";
import { moduleFinanceAudit as insertAudit, moduleUpdateTitle as updateTitle, moduleFinancePreviewGuard } from "../module-posting.ts";
import { erpRequirement, erpRequirementMet } from "../../../parts.ts";
import { erpEntityRequirement } from "../../../parts-requirements.ts";
import {
  cents,
  day,
  documentCommandFinish,
  documentCommandStart,
  expected,
  field,
  keys,
  requireAccess,
  txt,
  uuidValue,
  writeRow,
} from "../internal.ts";
import { invoiceEffectActive } from "../invoices.ts";
import { insertTitle } from "../titles.ts";

type Data = Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const left = (s: string, n: number) => [...s].slice(0, n).join("");
const fieldText = (o: unknown, k: string): string | null => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const v = (o as Data)[k];
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** round(n/d) do numeric (meio para longe do zero) */
const roundDiv = (n: bigint, d: bigint) => {
  if (d < 0n) (n = -n), (d = -d);
  return n >= 0n ? (2n * n + d) / (2n * d) : -((2n * -n + d) / (2n * d));
};

/** erp_finance.document_lock(ator, kind, documento, versão) */
export function documentLock(db: SqlDriver, actor: string, kind: string | null, document: string | null, version: number | null): Row {
  const ctx = driverContext(db);
  linkedDocumentGuard(db, document, ctx);
  if (ctx && document) requireOriginOperation(ctx, originScope(ctx)!.operation, document);
  requireAccess(db, actor, true);
  documents.requireAccess(db, actor, kind, false);
  if (document === null || version === null || version < 1) raise("22023", "erp_document_finance_invalid_version");
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', document, kind);
  if (!d) raise("P0002", "erp_document_not_found");
  if (d.version !== version || d.version === 2147483647) raise("40001", "erp_document_version_conflict");
  return d;
}

/** erp_finance.document_preview_data(documento, categoria, plano) */
export function documentPreviewData(db: SqlDriver, d: Row, category: string | null, plan: unknown): Data {
  const eligible =
    d.kind === "sales_orders" ? ["verified", "in_progress", "partially_fulfilled", "fulfilled"]
    : d.kind === "purchase_orders" ? ["open", "in_progress", "partially_fulfilled", "fulfilled"]
    : d.kind === "service_orders" ? ["approved", "in_progress", "waiting_parts", "service_done", "finalized"]
    : [];
  if (!eligible.includes(String(d.status))) raise("40001", "erp_document_finance_ineligible_state");
  if (
    one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, d.id) ||
    one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', d.id)
  )
    raise("40001", "erp_document_finance_already_posted");
  // 247: as contas do pedido foram lançadas pela nota fiscal dele.
  for (const o of db.exec('SELECT invoice_id FROM "erp_fiscal_invoices__invoice_order" WHERE document_id=?', d.id).rows)
    if (invoiceEffectActive(db, String(o.invoice_id))) raise("40001", "erp_document_finance_invoice_posted");
  const direction = d.kind === "purchase_orders" ? "payable" : "receivable";
  const c = one(db, 'SELECT r.version FROM "erp_catalog__record" r JOIN "erp_catalog__contact" x ON x.record_id=r.id WHERE r.id=? AND r.active=1', d.contact_id);
  if (!c) raise("22023", "erp_finance_invalid_contact");
  let g: Row | undefined;
  if (category !== null) {
    g = one(db, `SELECT id, name, version FROM "erp_finance__category" WHERE id=? AND active=1 AND kind IN (?, 'both')`, category, direction);
    if (!g) raise("22023", "erp_finance_invalid_category");
  }
  const body = parse(d.body) as Data;
  let issued = day(body?.date ?? null);
  const total = d.total === null ? null : BigInt(String(d.total));
  // Preferências > Serviços "Utilizar data atual no lançamento de contas de ordens de serviço" (174).
  let dates = "nao";
  if (d.kind === "service_orders") {
    const p = preferences.get(db, "os.data_contas");
    dates = p === null || p === undefined ? "nao" : typeof p === "string" ? p : jsonbText(p);
  }
  const today = todaySaoPaulo();
  const base = issued;
  if (dates === "data_atual" || dates === "recalcular") issued = today;
  if (total !== null && total <= 0n) raise("22023", "erp_document_finance_zero_total");
  const installments = body?.installments;
  if (installments !== undefined && installments !== null && !Array.isArray(installments))
    raise("22023", `cannot get array length of ${typeof installments === "object" ? "a non-array" : "a scalar"}`);
  let source: string;
  if (Array.isArray(installments) && installments.length > 0) {
    if (plan !== null && plan !== undefined) raise("22023", "erp_document_finance_saved_plan_required");
    source = "document";
  } else {
    source = "explicit";
    if (plan === null || plan === undefined || jsonType(plan) !== "array" || (plan as unknown[]).length < 1 || (plan as unknown[]).length > 120 || Buffer.byteLength(jsonbText(plan), "utf8") > 32768)
      raise("22023", "erp_document_finance_plan_required");
  }
  const parts: Data[] = [];
  let n = 0,
    sum = 0n;
  for (const part of (source === "document" ? installments : plan) as unknown[]) {
    let amount: bigint;
    let due: string;
    if (source === "explicit") {
      keys(part, ["amount_cents", "due_on", "method"]);
      amount = BigInt(cents(field(part, "amount_cents"), false));
      due = day(field(part, "due_on"));
    } else {
      const v = documents.decimalValue(field(part, "amount") ?? null, 2, 12) as string | null;
      // (decimal_value(...,2,12)*100)::bigint: o valor já tem no máximo 2 casas.
      amount = v === null ? 0n : toScaled(v, 2);
      due = day(field(part, "due_date"));
    }
    if (dates === "data_atual") due = today;
    else if (dates === "recalcular") due = addDays(today, Math.max(span(base, due), 0));
    if (amount <= 0n || due < issued) raise("22023", "erp_document_finance_invalid_installment");
    n++;
    sum += amount;
    parts.push({ position: n, amount_cents: amount.toString(), due_on: due, method: txt(part, "method", 100) });
  }
  if (total === null || sum !== total || n < 1 || n > 120) raise("22023", "erp_finance_installment_total_mismatch");
  const snapshot = parse(d.contact_snapshot) as Data | null;
  const r = {
    document_id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number), document_version: d.version, status: d.status, contact_id: d.contact_id,
    contact_name: fieldText(snapshot, "name"), contact_version: c.version, issued_on: issued, direction, total_cents: total.toString(),
    category_id: g?.id ?? null, category_name: g?.name ?? null, category_version: g?.version ?? null, plan_source: source, installments: parts,
  };
  return { ...r, preview_hash: sha256(jsonbText(r)) };
}

/** erp_documents.finance_payment_preview(documento, prévia): a forma e a conta de cada parcela. */
export function financePaymentPreview(db: SqlDriver, d: Row, preview: Data): Data {
  const body = parse(d.body) as Data;
  const parts: Data[] = [];
  for (const part of preview.installments as Data[]) {
    const src = preview.plan_source === "document" ? ((body?.installments as unknown[] | undefined)?.[Number(part.position) - 1] ?? null) : null;
    const methodText = fieldText(src, "payment_method_id");
    const method = methodText === null ? null : (uuidValue(methodText) as string);
    const details = src !== null && typeof src === "object" && !Array.isArray(src) ? (src as Data).details : null;
    const accountText = fieldText(details, "account_id") ?? fieldText(body, "payment_account_id");
    const account = accountText === null ? null : (uuidValue(accountText) as string);
    if (account !== null && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1', account)) raise("22023", "erp_document_finance_account_unavailable");
    const m = method === null ? undefined : one(db, 'SELECT description FROM "erp_catalog__payment_method" WHERE id=?', method);
    const a = account === null ? undefined : one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', account);
    parts.push({ ...part, payment_method_id: method, payment_method_name: m ? left(String(m.description), 100) : null, account_id: account, account_name: a ? left(String(a.name), 200) : null });
  }
  const { preview_hash: _h, ...rest } = preview;
  const r = { ...rest, installments: parts };
  return { ...r, preview_hash: sha256(jsonbText(r)) };
}

/** erp_finance.document_posting_summary(lançamento) */
export function documentPostingSummary(db: SqlDriver, id: string): Data | null {
  const p = one(db, 'SELECT * FROM "erp_finance__document_posting" WHERE id=?', id);
  if (!p) return null;
  const s = parse(p.snapshot) as Data;
  return {
    id: p.id, document_id: p.document_id, source_document_version: p.document_version, group_id: p.group_id, state: p.state, version: p.version,
    kind: fieldText(s, "kind"), number: fieldText(s, "number"), direction: fieldText(s, "direction"), total_cents: fieldText(s, "total_cents"),
    installments: Array.isArray(s?.installments) ? (s.installments as unknown[]).length : null, plan_source: fieldText(s, "plan_source"),
    created_at: jsonTimestamp(p.created_at as bigint), reversed_at: p.reversed_at === null ? null : jsonTimestamp(p.reversed_at as bigint), reason: p.reason,
  };
}

/** erp_finance.document_title_rows(lançamento) */
export function documentTitleRows(db: SqlDriver, posting: string): Data[] {
  return db
    .exec('SELECT t.*, l.position FROM "erp_finance__document_title" l JOIN "erp_finance__title" t ON t.id=l.title_id WHERE l.posting_id=? ORDER BY l.position', posting)
    .rows.map((t) => ({
      id: t.id, position: t.position, version: t.version, due_on: t.due_on, amount_cents: String(t.amount_cents), settled_cents: String(t.settled_cents),
      balance_cents: String(Number(t.amount_cents) - Number(t.settled_cents)), cancelled: Number(t.cancelled) === 1, category_id: t.category_id, description: t.description,
      cnab_linked: !!one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE title_id=? LIMIT 1', t.id),
    }));
}

/** erp_finance.commission_document(documento, vendedor): itens, soma ponderada (escala 10), base e regra. */
function commissionDocument(db: SqlDriver, document: string, seller: string) {
  // 370: a operação congelada da venda (base, percentual e regra da confirmação comercial).
  const o = one(db, `SELECT items_cents, rate, base_cents, rule FROM "erp_finance__commission_operation" WHERE document_id=? AND seller_id=? AND state='active'`, document, seller);
  if (o) {
    const items = BigInt(String(o.items_cents));
    return { items, weighted10: BigInt(String(o.rate)) * items * 10n ** 4n, base: BigInt(String(o.base_cents)), rule: o.rule };
  }
  const s = one(db, 'SELECT commission_rule FROM "erp_catalog__seller" WHERE id=?', seller);
  const w = commissionWeighted(db, document, seller);
  const a = commissionAmounts(db, document, commissionPolicy(db));
  return { items: w?.items_cents ?? 0n, weighted10: w?.weighted10 ?? 0n, base: a.base_cents, rule: s?.commission_rule ?? null };
}

/** erp_finance.commission_capture_title(conta): a comissão de uma parcela do documento. */
function commissionCaptureTitle(ctx: RpcContext, title: string) {
  if (!erpRequirementMet(ctx.parts, erpRequirement("erp-financeiro"))) return;
  const db = ctx.db;
  const l = one(db, 'SELECT * FROM "erp_finance__document_title" WHERE title_id=?', title);
  const p = l ? one(db, 'SELECT * FROM "erp_finance__document_posting" WHERE id=?', l.posting_id) : undefined;
  const snap = p ? (parse(p.snapshot) as Data) : null;
  if (!p || p.state !== "active" || !["sales_orders", "service_orders"].includes(fieldText(snap, "kind") ?? "")) return;
  if (one(db, 'SELECT 1 x FROM "erp_finance__commission" WHERE title_id=? LIMIT 1', title)) return;
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', p.document_id)!;
  if (!erpRequirementMet(ctx.parts, erpEntityRequirement(d.kind)!)) return;
  requireRpcParts(ctx, "erp_document_finance_post", { p_document_id: d.id, p_kind: d.kind });
  // 210: o vendedor do pedido (164) ou, no pedido espelhado, o do Origin (171).
  const seller = documentSeller(db, d);
  if (seller === null) return;
  const calc = commissionDocument(db, String(d.id), seller);
  if (calc.items <= 0n || calc.weighted10 <= 0n) return;
  const totalText = fieldText(snap, "total_cents");
  const total = totalText === null ? null : BigInt(totalText);
  if (total === null || total <= 0n) return;
  const position = Number(l!.position);
  const parts = (snap!.installments as Data[]) ?? [];
  let before = 0n,
    upto = 0n;
  for (const x of parts) {
    const amount = BigInt(String(x.amount_cents));
    if (Number(x.position) < position) before += amount;
    if (Number(x.position) <= position) upto += amount;
  }
  // round(base*weighted/(items*100)): weighted na escala 10.
  const commission = roundDiv(calc.base * calc.weighted10, calc.items * 100n * 10n ** 10n);
  const t = one(db, 'SELECT id, amount_cents, due_on FROM "erp_finance__title" WHERE id=?', title)!;
  const label = `${d.kind === "sales_orders" ? "Pedido de venda" : "Ordem de serviço"} nº ${d.number === null ? "" : String(d.number)} · parcela ${position}/${parts.length}`;
  db.exec(
    `INSERT INTO "erp_finance__commission"(id, seller_id, origin, posting_id, title_id, document_id, position, positions, rule, parcel_cents, base_cents, rate, commission_cents,
       due_on, description, version, actor, command_id, created_at) VALUES(?,?,'document',?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    crypto.randomUUID(), seller, p.id, t.id, d.id, position, parts.length, calc.rule, Number(t.amount_cents),
    Number(roundDiv(calc.base * upto, total) - roundDiv(calc.base * before, total)), Number(roundDiv(calc.weighted10, calc.items * 10n ** 4n)),
    Number(roundDiv(commission * upto, total) - roundDiv(commission * before, total)), t.due_on, left(label, 240), p.actor, p.command_id, ctx.clock.next().toString(),
  );
}

/** INSERT em document_title com os gatilhos AFTER commission_capture e document_title_number. */
function insertDocumentTitle(ctx: RpcContext, title: string, posting: string, position: number) {
  const db = ctx.db;
  db.exec('INSERT INTO "erp_finance__document_title"(title_id, posting_id, position) VALUES(?,?,?)', title, posting, position);
  // commission_capture: exception when data_exception or check_violation then null (subtransação).
  try {
    db.transaction(() => commissionCaptureTitle(ctx, title));
  } catch (e) {
    const err = fromSqlite(e);
    if (!(err.code.startsWith("22") || err.code === "23514")) throw err;
  }
  // document_title_number
  const d = one(db, 'SELECT x.kind, x.number FROM "erp_finance__document_posting" p JOIN "erp_documents__document" x ON x.id=p.document_id WHERE p.id=?', posting);
  if (d && ((d.kind === "sales_orders" && preferences.get(db, "vendas.numero_documento_conta") === true) || (d.kind === "service_orders" && preferences.get(db, "os.numero_documento_conta") === true))) {
    const t = one(db, 'SELECT source_reference FROM "erp_finance__title" WHERE id=?', title);
    if (t && t.source_reference === null) updateTitle(ctx, title, { source_reference: d.number === null ? null : String(d.number) });
  }
}

/** INSERT em erp_documents.audit */
function documentAudit(ctx: RpcContext, a: { actor: string; command: string; document: unknown; action: string; reason?: string | null; before: unknown; after: unknown }) {
  documents.mirrorGuardEffect(ctx.db, a.document); // aa_mirror_authority
  ctx.db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), a.actor, a.command, a.document, a.action, a.reason ?? null,
    a.before === null || a.before === undefined ? null : JSON.stringify(a.before), JSON.stringify(a.after), ctx.clock.next().toString(),
  );
}

const jsonArg = (v: unknown) => (v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);

export function erpDocumentFinancePreview(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_preview", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  // 239: Ordem de Serviço "Lançar contas".
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, true);
  if (!originScope(ctx)) documents.requireOsPermission(db, user, kind!, "lancar_contas");
  const d = documentLock(db, user, kind, (a.p_document_id as string | null) ?? null, (a.p_expected_version as number | null) ?? null);
  const category = documents.documentFinanceCategory(db, d, (a.p_category_id as string | null) ?? null);
  return { preview: financePaymentPreview(db, d, documentPreviewData(db, d, category, jsonArg(a.p_plan))), data_mode: "erp_native", cash_movement_performed: false };
}

export function erpDocumentFinancePost(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_post", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const documentId = (a.p_document_id as string | null) ?? null;
  const version = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const hash = (a.p_preview_hash as string | null) ?? null;
  const categoryArg = (a.p_category_id as string | null) ?? null;
  const plan = jsonArg(a.p_plan);
  const group = crypto.randomUUID();
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, true);
  if (!originScope(ctx)) documents.requireOsPermission(db, user, kind!, "lancar_contas");
  // O comando guarda a categoria como pedida: a repetição de um comando antigo continua batendo.
  const data = { kind, document_id: documentId, version, preview_hash: hash, category_id: categoryArg, plan };
  const replay = documentCommandStart(db, user, command, "post", data);
  if (replay) return replay;
  requireCom1Posting(ctx, documentId, "finance");
  const d = documentLock(db, user, kind, documentId, version);
  const category = documents.documentFinanceCategory(db, d, categoryArg);
  const preview = financePaymentPreview(db, d, documentPreviewData(db, d, category, plan));
  moduleFinancePreviewGuard(ctx, preview);
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_document_finance_preview_conflict");
  const beforeDoc = documents.documentDto(ctx, String(d.id));
  documents.guardTrashChild(db, String(d.id)); // guard_trash (BEFORE INSERT em document_posting)
  const posting = crypto.randomUUID();
  const { preview_hash: _h, ...snapshot } = preview;
  const label = `${d.kind === "sales_orders" ? "Pedido de venda" : d.kind === "purchase_orders" ? "Pedido de compra" : "Ordem de serviço"} nº ${d.number === null ? "" : String(d.number)}`;
  const parts = preview.installments as Data[];
  const createTitle = (part: Data) => insertTitle(ctx, {
    group_id: group, installment: Number(part.position), installments: parts.length, kind: preview.direction, contact_id: d.contact_id, category_id: category, description: d.number === null ? null : label,
    issued_on: preview.issued_on, due_on: part.due_on, amount_cents: Number(part.amount_cents), payment_method_id: part.payment_method_id ?? null, account_id: part.account_id ?? null,
  });
  // A guarda F2 de insertTitle exige Vendas quando a postagem já existe.
  // Para F3, validar o documento acima, criar parcelas e só então vinculá-las,
  // na MESMA transação. Nenhuma parte ou papel é artificialmente ligado.
  const moduleTitles = originScope(ctx) ? parts.map(createTitle) : null;
  db.exec(
    `INSERT INTO "erp_finance__document_posting"(id, document_id, document_version, group_id, state, version, snapshot, preview_hash, actor, command_id, created_at)
       VALUES(?,?,?,?,'active',1,?,?,?,?,?)`,
    posting, d.id, d.version, group, JSON.stringify(snapshot), hash, user, command, ctx.clock.next().toString(),
  );
  for (const [index, part] of parts.entries()) {
    const title = moduleTitles ? moduleTitles[index] : createTitle(part);
    insertDocumentTitle(ctx, title, posting, Number(part.position));
  }
  documents.updateDocument(ctx, String(d.id), { version: Number(d.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
  const result = { document_id: d.id, document_version: Number(d.version) + 1, posting: documentPostingSummary(db, posting), titles: documentTitleRows(db, posting) };
  insertAudit(ctx, user, command!, "document_post", null, result);
  documentAudit(ctx, { actor: user, command: command!, document: d.id, action: "finance_post", before: beforeDoc, after: result });
  return documentCommandFinish(ctx, user, command!, "post", data, result);
}

/** erp_finance.document_reverse_preview_data(documento, lançamento, versão) */
export function documentReversePreviewData(db: SqlDriver, d: Row, posting: string | null, version: number | null): Data {
  const p = one(db, 'SELECT * FROM "erp_finance__document_posting" WHERE id=? AND document_id=?', posting, d.id);
  if (!p) raise("P0002", "erp_document_finance_not_found");
  if (version === null || version < 1) raise("22023", "erp_document_finance_invalid_version");
  if (p.version !== version || p.state !== "active" || p.version === 2147483647) raise("40001", "erp_document_finance_version_conflict");
  // A conferência depois das travas das contas: a reserva do CNAB e as baixas usam as mesmas linhas.
  if (
    one(db, 'SELECT 1 x FROM "erp_finance__title" t JOIN "erp_finance__document_title" l ON l.title_id=t.id WHERE l.posting_id=? AND (t.settled_cents<>0 OR t.version=2147483647) LIMIT 1', p.id) ||
    one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" b JOIN "erp_finance__document_title" l ON l.title_id=b.title_id WHERE l.posting_id=? LIMIT 1', p.id)
  )
    raise("40001", "erp_document_finance_reverse_blocked");
  const t = documentTitleRows(db, String(p.id));
  const snap = parse(p.snapshot) as Data;
  if (!Array.isArray(snap?.installments) || t.length !== (snap.installments as unknown[]).length) raise("40001", "erp_document_finance_group_incomplete");
  const r = { document_id: d.id, document_version: d.version, posting: documentPostingSummary(db, String(p.id)), titles: t };
  return { ...r, preview_hash: sha256(jsonbText(r)) };
}

export function erpDocumentFinanceReversePreview(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_reverse_preview", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, true);
  if (!originScope(ctx)) documents.requireOsPermission(db, user, kind!, "lancar_contas");
  if (originScope(ctx)) assertOwnEffect(ctx, "finance_posting", String(a.p_posting_id));
  const d = documentLock(db, user, kind, (a.p_document_id as string | null) ?? null, (a.p_expected_version as number | null) ?? null);
  return {
    preview: documentReversePreviewData(db, d, (a.p_posting_id as string | null) ?? null, (a.p_posting_version as number | null) ?? null),
    data_mode: "erp_native", cash_movement_performed: false,
  };
}

export function erpDocumentFinanceReverse(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_reverse", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const documentId = (a.p_document_id as string | null) ?? null;
  const version = (a.p_expected_version as number | null) ?? null;
  const postingId = (a.p_posting_id as string | null) ?? null;
  const postingVersion = (a.p_posting_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const hash = (a.p_preview_hash as string | null) ?? null;
  const titles = jsonArg(a.p_title_versions);
  const reason = (a.p_reason as string | null) ?? null;
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, true);
  if (!originScope(ctx)) documents.requireOsPermission(db, user, kind!, "lancar_contas");
  if (originScope(ctx)) assertOwnEffect(ctx, "finance_posting", String(a.p_posting_id));
  const data = { kind, document_id: documentId, version, posting_id: postingId, posting_version: postingVersion, preview_hash: hash, title_versions: titles, reason };
  const replay = documentCommandStart(db, user, command, "reverse", data);
  if (replay) return replay;
  const d = documentLock(db, user, kind, documentId, version);
  const preview = documentReversePreviewData(db, d, postingId, postingVersion);
  const note = documents.textValue(reason, 1000, true) as string;
  if ([...note].length < 3) raise("22023", "erp_document_finance_reason_required");
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_document_finance_preview_conflict");
  if (titles === null || jsonType(titles) !== "array" || (titles as unknown[]).length < 1 || (titles as unknown[]).length > 120 || Buffer.byteLength(jsonbText(titles), "utf8") > 32768)
    raise("22023", "erp_document_finance_titles_required");
  for (const part of titles as unknown[]) {
    keys(part, ["id", "version"]);
    uuidValue(field(part, "id"));
    expected(field(part, "version"));
  }
  const sorted = (list: unknown[]) =>
    list
      .map((x) => ({ id: fieldText(x, "id"), version: Number(fieldText(x, "version")) }))
      .sort((x, y) => (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  const want = sorted(titles as unknown[]),
    have = sorted(preview.titles as unknown[]);
  if (want.length !== have.length || want.some((x, i) => x.id !== have[i].id || x.version !== have[i].version)) raise("40001", "erp_document_finance_title_version_conflict");
  const beforeDoc = documents.documentDto(ctx, String(d.id));
  for (const t of db.exec('SELECT t.id, t.version FROM "erp_finance__title" t JOIN "erp_finance__document_title" l ON l.title_id=t.id WHERE l.posting_id=? AND t.cancelled=0', postingId).rows)
    updateTitle(ctx, String(t.id), { cancelled: true, version: Number(t.version) + 1, updated_at: ctx.clock.next().toString() });
  const p = one(db, 'SELECT version FROM "erp_finance__document_posting" WHERE id=?', postingId)!;
  writeRow(ctx, "erp_finance__document_posting", "id", postingId, { state: "reversed", version: Number(p.version) + 1, reversed_at: ctx.clock.next().toString(), reversed_by: user, reason: note });
  documents.updateDocument(ctx, String(d.id), { version: Number(d.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
  const result = { document_id: d.id, document_version: Number(d.version) + 1, posting: documentPostingSummary(db, postingId!), titles: documentTitleRows(db, postingId!) };
  const { preview_hash: _h, ...beforeData } = preview;
  insertAudit(ctx, user, command!, "document_reverse", beforeData, result);
  documentAudit(ctx, { actor: user, command: command!, document: d.id, action: "finance_reverse", reason: note, before: beforeDoc, after: result });
  return documentCommandFinish(ctx, user, command!, "reverse", data, result);
}

export function erpDocumentFinanceGet(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_get", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const posting = (a.p_posting_id as string | null) ?? null;
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, false);
  requireAccess(db, user, false);
  documents.requireAccess(db, user, kind, false);
  const d = one(db, 'SELECT id, version FROM "erp_documents__document" WHERE id=? AND kind=?', (a.p_document_id as string | null) ?? null, kind);
  if (!d || !one(db, 'SELECT 1 x FROM "erp_finance__document_posting" WHERE id=? AND document_id=?', posting, d.id)) raise("P0002", "erp_document_finance_not_found");
  return { document_id: d.id, document_version: d.version, posting: documentPostingSummary(db, posting!), titles: documentTitleRows(db, posting!), data_mode: "erp_native" };
}

export function erpDocumentFinanceList(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_finance_list", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const after = (a.p_after as string | null) ?? null;
  documents.mirrorRequireVisible(db, user, (a.p_document_id as string | null) ?? null, false);
  requireAccess(db, user, false);
  documents.requireAccess(db, user, kind, false);
  if (limit === null || limit < 1 || limit > 100) raise("22023", "erp_document_finance_invalid_query");
  const d = one(db, 'SELECT id, kind, number, version FROM "erp_documents__document" WHERE id=? AND kind=?', (a.p_document_id as string | null) ?? null, kind);
  if (!d) raise("P0002", "erp_document_not_found");
  const page = db
    .exec('SELECT id FROM "erp_finance__document_posting" WHERE document_id=?', d.id)
    .rows.map((r) => String(r.id))
    .filter((id) => after === null || id > after)
    .sort()
    .slice(0, limit + 1);
  const shown = page.slice(0, limit);
  const more = page.length > limit;
  const active = one(db, `SELECT id FROM "erp_finance__document_posting" WHERE document_id=? AND state='active'`, d.id);
  return {
    document_id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number), document_version: d.version,
    active_posting: active ? documentPostingSummary(db, String(active.id)) : null, items: shown.map((id) => documentPostingSummary(db, id)), limit,
    has_more: more, next_cursor: more ? shown[shown.length - 1] : null, data_mode: "erp_native",
  };
}

registerRpc("erp_document_finance_preview", erpDocumentFinancePreview);
registerRpc("erp_document_finance_post", erpDocumentFinancePost);
registerRpc("erp_document_finance_reverse_preview", erpDocumentFinanceReversePreview);
registerRpc("erp_document_finance_reverse", erpDocumentFinanceReverse);
registerRpc("erp_document_finance_get", erpDocumentFinanceGet);
registerRpc("erp_document_finance_list", erpDocumentFinanceList);
