// Financeiro: contas a pagar e a receber (erp_finance.title). Ajudantes de
// validação, o DTO (erp_finance.dto) e a camada de tabela de title
// (title_defaults, guard_zero_title, protect_*, title_history_guard,
// title_long_history e o zz_origin_sync, que com o Origin desligado não grava).
import { fromColumn } from "../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import * as sync from "../sync/public.ts";
import {
  bool,
  captureFinance,
  CNTRL,
  field,
  hasKey,
  titleUpdateGuards,
  toJsonb,
  txt,
  writeRow,
} from "./internal.ts";

// ---------------------------------------------------------------------------
// Validadores

/** erp_finance.utf16_length: unidades UTF-16 (o limite do Origin). */
export const utf16Length = (s: string) => s.length;

/** left(texto, n) do Postgres: n caracteres (pontos de código). */
export const left = (s: string, n: number) => [...s].slice(0, n).join("");
/** rtrim(texto): tira espaços à direita. */
const rtrim = (s: string) => s.replace(/ +$/, "");

/** erp_finance.title_text: descrição curta (até 240 UTF-16) e histórico longo. */
export function titleText(data: unknown): { description: string; history: string | null } {
  const v = txt(data, "description", 2000, true)!;
  if (utf16Length(v) > 2000) raise("22023", "erp_finance_invalid_text");
  if (utf16Length(v) <= 240) return { description: v, history: null };
  let n = 240;
  let description = rtrim(left(v, n));
  while (utf16Length(description) > 240) {
    n--;
    description = rtrim(left(v, n));
  }
  return { description, history: v };
}

/** erp_finance.bank_number */
export function bankNumber(data: unknown): string | null {
  const v = txt(data, "bank_number", 60);
  if (v !== null && CNTRL.test(v)) raise("22023", "erp_finance_invalid_text");
  return v;
}

/** erp_finance.bp: pontos-base 0..10000; ausente → null. */
export function bp(data: unknown, key: string): number | null {
  if (!hasKey(data, key)) return null;
  const v = field(data, key);
  if (jsonType(v) !== "number" || !/^[0-9]{1,5}$/.test(jsonbText(v))) raise("22023", "erp_finance_invalid_percent");
  if ((v as number) > 10000) raise("22023", "erp_finance_invalid_percent");
  return v as number;
}

/** erp_finance.active_category: categoria ativa do tipo (ou 'both'). */
export function activeCategory(db: SqlDriver, id: string | null, kind: string): string | null {
  if (id === null) return null;
  if (!one(db, `SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND kind IN (?, 'both')`, id, kind))
    raise("22023", "erp_finance_invalid_category");
  return id;
}

/** erp_finance.active_account */
export function activeAccount(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  if (!one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1', id)) raise("22023", "erp_finance_invalid_account");
  return id;
}

/** erp_finance.payment_method_for */
export function paymentMethodFor(db: SqlDriver, method: string | null, kind: string, current: string | null) {
  if (method === null || method === current) return method;
  if (
    !one(
      db,
      `SELECT 1 x FROM "erp_catalog__payment_method" f WHERE f.id=? AND f.active=1 AND f.deleted_at IS NULL AND f.applicable IN ('ambos', ?)`,
      method,
      kind === "receivable" ? "recebimentos" : "pagamentos",
    )
  )
    raise("22023", "erp_finance_invalid_payment_method");
  return method;
}

/** erp_finance.seller_for */
export function sellerFor(db: SqlDriver, seller: string | null, kind: string, current: string | null) {
  if (seller === null || seller === current) return seller;
  if (
    kind !== "receivable" ||
    !one(db, 'SELECT 1 x FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=? AND r.active=1', seller)
  )
    raise("22023", "erp_finance_invalid_seller");
  return seller;
}

/** Contato ativo (erp_catalog.contact + record). */
export const activeContact = (db: SqlDriver, id: string) =>
  !!one(db, 'SELECT 1 x FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE c.record_id=? AND r.active=1', id);

// ---------------------------------------------------------------------------
// Vendedor da conta

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** erp_finance.commission_seller: vendedor pela referência do Origin (espelho). */
export function commissionSeller(db: SqlDriver, reference: unknown): string | null {
  if (jsonType(reference) !== "object") return null;
  const ref = reference as Record<string, unknown>;
  if ((ref.system === undefined || ref.system === null ? null : String(ref.system)) !== "origin") return null;
  const source = ref.source_id === undefined || ref.source_id === null ? null : typeof ref.source_id === "string" ? ref.source_id : jsonbText(ref.source_id);
  const row = one(
    db,
    `SELECT s.id FROM "origin_sync__raw_record" r
       JOIN "erp_catalog__origin" o ON o.entity='contacts' AND o.source_id=(r.payload->>'$.contato.id')
       JOIN "erp_catalog__seller" s ON s.contact_id=o.record_id
      WHERE r.entity='sellers' AND r.source_id=? ORDER BY s.id LIMIT 1`,
    source,
  );
  return (row?.id as string) ?? null;
}

/** erp_finance.document_seller(documento): vendedor do corpo, ou o do Origin. */
export function documentSeller(db: SqlDriver, body: unknown): string | null {
  const b = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown> | null;
  const raw = b && b.seller_id !== undefined && b.seller_id !== null ? (typeof b.seller_id === "string" ? b.seller_id : jsonbText(b.seller_id)) : null;
  const id = raw !== null && UUID_LOWER.test(raw) ? raw : null;
  if (id !== null && one(db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE id=?', id)) return id;
  const commercial = b?.commercial as Record<string, unknown> | undefined;
  return commissionSeller(db, commercial?.seller_reference);
}

/** erp_finance.title_inherited_seller: o do documento de origem ou o da nota fiscal. */
export function titleInheritedSeller(db: SqlDriver, title: string): string | null {
  const doc = one(
    db,
    `SELECT d.body FROM "erp_finance__document_title" l JOIN "erp_finance__document_posting" p ON p.id=l.posting_id
       JOIN "erp_documents__document" d ON d.id=p.document_id WHERE l.title_id=? LIMIT 1`,
    title,
  );
  const fromDocument = doc ? documentSeller(db, doc.body) : null;
  if (fromDocument !== null) return fromDocument;
  const invoice = one(
    db,
    `SELECT s.id FROM "erp_finance__invoice_title" l JOIN "erp_finance__invoice_posting" p ON p.id=l.posting_id
       JOIN "erp_fiscal_invoices__invoice" i ON i.id=p.invoice_id JOIN "erp_catalog__seller" s ON s.id=i.seller_id
      WHERE l.title_id=? AND i.direction='1' LIMIT 1`,
    title,
  );
  return (invoice?.id as string) ?? null;
}

/** erp_finance.title_seller: "sem vendedor" vence o do documento. */
export function titleSeller(db: SqlDriver, title: string): string | null {
  const t = one(db, `SELECT id, seller_none, seller_id FROM "erp_finance__title" WHERE id=? AND kind='receivable'`, title);
  if (!t) return null;
  if (bool(t.seller_none)) return null;
  return (t.seller_id as string | null) ?? titleInheritedSeller(db, title);
}

// ---------------------------------------------------------------------------
// Taxa da forma de pagamento

/** round() do Postgres em num/den (inteiros): metade para longe do zero. */
function roundDiv(num: bigint, den: bigint) {
  const q = num / den,
    r = num % den;
  const twice = (r < 0n ? -r : r) * 2n;
  return twice >= den ? q + (num < 0n ? -1n : 1n) : q;
}

/** erp_finance.payment_method_fee(forma, valor): alíquota e/ou taxa fixa, nunca mais que o valor. */
export function paymentMethodFee(db: SqlDriver, method: string, amount: number): number | null {
  const f = one(
    db,
    'SELECT fee_type, fee_rate, CAST(fee_fixed AS TEXT) fee_fixed FROM "erp_catalog__payment_method" WHERE id=?',
    method,
  );
  if (!f) return null;
  const a = BigInt(amount);
  const rate = f.fee_rate === null ? 0n : fromColumn(f.fee_rate); // escala 4
  const fixed = f.fee_fixed === null ? 0n : fromColumn(f.fee_fixed); // escala 2 = centavos
  let fee = 0n;
  if (["aliquota", "aliquota_fixa"].includes(String(f.fee_type))) fee += roundDiv(a * rate, 100n * 10000n);
  if (["fixa", "aliquota_fixa"].includes(String(f.fee_type))) fee += fixed;
  return Number(a < fee ? a : fee);
}

// ---------------------------------------------------------------------------
// DTO

/** erp_finance.dto('titles', id) */
export function titleDto(db: SqlDriver, id: string) {
  const t = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
  if (!t) return null;
  const contact = one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', t.contact_id);
  if (!contact) return null; // join erp_catalog.record
  const category = t.category_id ? one(db, 'SELECT name FROM "erp_finance__category" WHERE id=?', t.category_id) : null;
  const seller = titleSeller(db, id);
  const method = t.payment_method_id
    ? one(db, 'SELECT description, payment_type FROM "erp_catalog__payment_method" WHERE id=?', t.payment_method_id)
    : null;
  const sellerName = seller
    ? one(db, 'SELECT r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', seller)
    : null;
  const amount = Number(t.amount_cents),
    settled = Number(t.settled_cents);
  const cancelled = bool(t.cancelled);
  const base = toJsonb("erp_finance__title", t);
  for (const k of ["amount_cents", "settled_cents", "history", "seller_id", "seller_none"]) delete base[k];
  return {
    ...base,
    amount_cents: String(amount),
    settled_cents: String(settled),
    balance_cents: String(amount - settled),
    contact_name: contact.name,
    category_name: category?.name ?? null,
    document_linked:
      !!one(db, 'SELECT 1 x FROM "erp_finance__document_title" WHERE title_id=? LIMIT 1', id) ||
      !!one(db, 'SELECT 1 x FROM "erp_finance__invoice_title" WHERE title_id=? LIMIT 1', id),
    payment_method_name: method ? left(String(method.description), 100) : null,
    payment_type: method?.payment_type ?? null,
    payment_fee_cents: t.payment_method_id === null ? null : nullableText(paymentMethodFee(db, String(t.payment_method_id), amount)),
    grouped_billing_id: (one(db, 'SELECT billing_id FROM "erp_finance__grouped_billing_title" WHERE title_id=?', id)?.billing_id as string) ?? null,
    seller_id: seller,
    seller_name: sellerName ? left(String(sellerName.name), 200) : null,
    seller_source: t.seller_id !== null ? "conta" : seller !== null ? "documento" : null,
    seller_cleared: bool(t.seller_none),
    long_history: t.history !== null,
    status: cancelled ? "cancelled" : settled === 0 ? "open" : settled === amount ? "paid" : "partial",
    returned: cancelled && !!one(db, 'SELECT 1 x FROM "erp_finance__title_return" WHERE title_id=? LIMIT 1', id),
    overdue: !cancelled && settled < amount && String(t.due_on) < todaySaoPaulo(),
  };
}

const nullableText = (v: number | null) => (v === null ? null : String(v));

/** erp_finance.dto(entidade, id); id nulo não acha a linha e devolve null, como no Postgres. */
export function dto(db: SqlDriver, entity: string, id: string | null): Record<string, unknown> | null {
  if (entity === "accounts") {
    const a = one(db, 'SELECT id, name, kind, active, opening_recorded, version, created_at, updated_at FROM "erp_finance__account" WHERE id=?', id);
    if (!a) return null;
    const balance = one(db, 'SELECT CAST(coalesce(sum(delta_cents),0) AS TEXT) b FROM "erp_finance__movement" WHERE account_id=?', id)!.b;
    const j = toJsonb("erp_finance__account", a);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      active: bool(a.active),
      opening_recorded: bool(a.opening_recorded),
      version: a.version,
      created_at: j.created_at,
      updated_at: j.updated_at,
      balance_cents: balance,
    };
  }
  if (entity === "categories") {
    const c = one(db, 'SELECT * FROM "erp_finance__category" WHERE id=?', id);
    return c ? toJsonb("erp_finance__category", c) : null;
  }
  if (entity === "titles") return id === null ? null : titleDto(db, id);
  if (entity === "settlements") {
    const s = one(db, 'SELECT * FROM "erp_finance__settlement" WHERE id=?', id);
    if (!s) return null;
    const j = toJsonb("erp_finance__settlement", s);
    for (const k of ["actor", "command_id", "principal_cents", "interest_cents", "penalty_cents", "discount_cents", "fee_cents", "net_cash_cents"]) delete j[k];
    return {
      ...j,
      principal_cents: String(s.principal_cents),
      interest_cents: String(s.interest_cents),
      penalty_cents: String(s.penalty_cents),
      discount_cents: String(s.discount_cents),
      fee_cents: String(s.fee_cents),
      net_cash_cents: String(s.net_cash_cents),
      reversed: !!one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE reverses_id=? LIMIT 1', id),
    };
  }
  if (entity === "movements") {
    const m = one(db, 'SELECT * FROM "erp_finance__movement" WHERE id=?', id);
    if (!m) return null;
    const j = toJsonb("erp_finance__movement", m);
    delete j.actor;
    delete j.command_id;
    delete j.delta_cents;
    return { ...j, delta_cents: String(m.delta_cents) };
  }
  raise("22023", "erp_finance_invalid_entity");
}

/** erp_finance.title_origin: documento ou nota fiscal de origem da conta. */
export function titleOrigin(db: SqlDriver, title: string) {
  const doc = one(
    db,
    `SELECT d.id, d.kind, CAST(d.number AS TEXT) number FROM "erp_finance__document_title" l
       JOIN "erp_finance__document_posting" p ON p.id=l.posting_id JOIN "erp_documents__document" d ON d.id=p.document_id
      WHERE l.title_id=?`,
    title,
  );
  if (doc) return { document_id: doc.id, kind: doc.kind, number: doc.number };
  const inv = one(
    db,
    `SELECT i.id, i.model, i.direction, CAST(i.number AS TEXT) number FROM "erp_finance__invoice_title" l
       JOIN "erp_finance__invoice_posting" p ON p.id=l.posting_id JOIN "erp_fiscal_invoices__invoice" i ON i.id=p.invoice_id
      WHERE l.title_id=?`,
    title,
  );
  return inv ? { invoice_id: inv.id, kind: "fiscal_invoices", model: inv.model, direction: inv.direction, number: inv.number } : null;
}

/** erp_finance.title_billing: boleto e remessa da conta. */
export function titleBilling(db: SqlDriver, title: string) {
  const b = one(
    db,
    `SELECT b.our_number, b.document_number, r.id remittance_id, r.sequence, r.state FROM "erp_cnab__billing_title" b
       JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id WHERE b.title_id=?`,
    title,
  );
  return b
    ? {
        our_number: b.our_number,
        document_number: b.document_number,
        remittance_id: b.remittance_id,
        remittance_sequence: b.sequence,
        remittance_state: b.state,
        file_generated: b.state === "ready",
      }
    : null;
}

/** erp_finance.project_result_link: document_linked recalculado no recibo repetido. */
export function projectResultLink(db: SqlDriver, result: Record<string, unknown>) {
  if (result.entity !== "titles") return result;
  const linked = (id: unknown) =>
    !!one(db, 'SELECT 1 x FROM "erp_finance__document_title" WHERE title_id=? LIMIT 1', String(id).toLowerCase());
  const out = { ...result };
  if (jsonType(out.record) === "object") {
    const record = out.record as Record<string, unknown>;
    out.record = { ...record, document_linked: linked(record.id) };
  }
  if (Array.isArray(out.items))
    out.items = out.items.map((item) => ({ ...(item as Record<string, unknown>), document_linked: linked((item as Row).id) }));
  return out;
}

// ---------------------------------------------------------------------------
// Camada de tabela de title

/** erp_sync.guard_zero_title (INSERT, e UPDATE de amount/settled/origin_zero_source_id). */
function guardZeroTitle(ctx: RpcContext, old: Row | null, next: Row) {
  if (old && old.origin_zero_source_id !== null && Number(next.amount_cents) > 0 && next.origin_zero_source_id === old.origin_zero_source_id)
    next.origin_zero_source_id = null;
  if (next.origin_zero_source_id !== null && next.origin_zero_source_id !== undefined) {
    // Conta zerada do espelho do Origin: só com o Origin aplicando, nunca nesta fase.
    if (Number(next.amount_cents) !== 0 || Number(next.settled_cents) !== 0 || !sync.applying(ctx))
      raise("22023", "ZERO_TITLE_SOURCE_REQUIRED");
    raise("0A000", "rpc_not_ported:erp_sync.guard_zero_title(origin)");
  }
}

const TITLE_INSERT_COLS = [
  "id", "group_id", "installment", "installments", "kind", "contact_id", "category_id", "description", "source_reference",
  "issued_on", "due_on", "amount_cents", "settled_cents", "cancelled", "version", "created_at", "updated_at", "competence_on",
  "account_id", "bank_number", "interest_month_bp", "penalty_bp", "original_due_on", "recurrence_id", "recurrence_on",
  "payment_method_id", "seller_id", "history", "seller_none", "origin_zero_source_id",
];

/** INSERT em title com title_defaults, guard_zero_title e zz_origin_sync. Devolve o id. */
export function insertTitle(ctx: RpcContext, t: Record<string, unknown>) {
  const now = ctx.clock.next().toString();
  const row: Row = {
    id: crypto.randomUUID(),
    settled_cents: 0,
    cancelled: false,
    version: 1,
    created_at: now,
    updated_at: now,
    interest_month_bp: 0,
    penalty_bp: 0,
    seller_none: false,
    origin_zero_source_id: null,
    ...t,
  };
  // title_defaults
  row.competence_on = row.competence_on ?? row.issued_on;
  row.original_due_on = row.original_due_on ?? row.due_on;
  guardZeroTitle(ctx, null, row);
  ctx.db.exec(
    `INSERT INTO "erp_finance__title"(${TITLE_INSERT_COLS.map((c) => `"${c}"`).join(", ")}) VALUES(${TITLE_INSERT_COLS.map(() => "?").join(",")})`,
    ...TITLE_INSERT_COLS.map((c) => {
      const v = row[c] ?? null;
      return typeof v === "boolean" ? (v ? 1 : 0) : v;
    }),
  );
  captureFinance(ctx, "title", String(row.id));
  return String(row.id);
}

/** UPDATE de um title com os gatilhos; `set` traz só as colunas que mudam. */
export function updateTitle(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  const old = one(ctx.db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
  if (!old) return;
  const out = titleUpdateGuards(ctx, old, set);
  if ("amount_cents" in set || "settled_cents" in set || "origin_zero_source_id" in set) {
    const next = { ...old, ...out };
    guardZeroTitle(ctx, old, next);
    if (next.origin_zero_source_id !== old.origin_zero_source_id) out.origin_zero_source_id = next.origin_zero_source_id;
  }
  writeRow(ctx, "erp_finance__title", "id", id, out);
  captureFinance(ctx, "title", id);
}
