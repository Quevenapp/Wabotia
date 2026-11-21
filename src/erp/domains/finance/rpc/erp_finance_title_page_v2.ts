// public.erp_finance_title_page_v2: lista de contas a receber/pagar com as
// opções do Origin (em aberto, vencidas, emitidas, recebidas/pagas), filtros,
// totais e as colunas da tela.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { storeFilter } from "../../stores/public.ts";
import { dateArgError, todaySaoPaulo } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { btrim, charLength, cmpText, CNTRL, pgLower, requireAccess, uuidArg } from "../internal.ts";
import { dto, left, titleOrigin, titleSeller } from "../titles.ts";

const UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["open", "partial", "paid", "cancelled", "returned"];

function dateArg(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const bad = dateArgError(String(v));
  if (bad) raise(bad.code, bad.message);
  return String(v);
}

/** erp_finance.require_permission */
export function requirePermission(ctx: RpcContext, user: string, key: string) {
  if (!permitted(ctx.db, user, key)) raise("42501", "erp_finance_permission_denied");
}

/** erp_finance.title_payments */
export function titlePayments(ctx: RpcContext, title: string) {
  const s = one(
    ctx.db,
    `SELECT max(s.posted_on) settled_on, coalesce(sum(s.fee_cents),0) fee, coalesce(sum(s.interest_cents),0) interest,
            coalesce(sum(s.penalty_cents),0) penalty, coalesce(sum(s.discount_cents),0) discount,
            coalesce(max(EXISTS(SELECT 1 FROM "erp_cnab__operational_settlement" o WHERE o.settlement_id=s.id)),0) by_return
       FROM "erp_finance__settlement" s
      WHERE s.title_id=? AND s.kind='payment' AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id)`,
    title,
  )!;
  return {
    settled_on: s.settled_on ?? null,
    fee_cents: String(s.fee),
    interest_cents: String(s.interest),
    penalty_cents: String(s.penalty),
    discount_cents: String(s.discount),
    settled_by_return: !!s.by_return,
  };
}

export function erpFinanceTitlePageV2(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const from = dateArg(a.p_from);
  const to = dateArg(a.p_to);
  const paymentMethod = uuidArg(a.p_payment_method);
  const seller = uuidArg(a.p_seller);
  const kind = (a.p_kind as string | null) ?? null;
  const page = (a.p_page as number | null);
  const limit = (a.p_limit as number | null);
  const order = (a.p_order as string | null);
  const query = (a.p_query as string | null) ?? null;
  const option = (a.p_option as string | null);
  const statuses = (a.p_statuses as string[] | null) ?? null;
  const dateField = (a.p_date_field as string | null);
  const account = (a.p_account as string | null) ?? null;
  const categories = (a.p_categories as string[] | null) ?? null;
  const remittance = (a.p_remittance as string | null) ?? null;
  const amount = (a.p_amount_cents as number | string | null) ?? null;
  const documentArg = (a.p_document as string | null) ?? null;
  const paymentType = (a.p_payment_type as string | null) ?? null;
  const today = todaySaoPaulo();
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  const docNeedle = documentArg === null || btrim(documentArg) === "" ? null : pgLower(btrim(documentArg));
  const noAccount = account === "none";
  const amountN = amount === null ? null : Number(amount);

  requireAccess(db, user, false);
  if (
    kind === null || !["receivable", "payable"].includes(kind) ||
    page === null || page < 1 || page > 100000 ||
    limit === null || limit < 1 || limit > 100 ||
    order === null || !["due_asc", "due_desc"].includes(order) ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (documentArg !== null && (charLength(documentArg) > 60 || CNTRL.test(documentArg))) ||
    option === null || !["open", "overdue", "issued", "settled"].includes(option) ||
    dateField === null || !["due", "issued", "settled", "competence"].includes(dateField) ||
    (["open", "overdue"].includes(option) && dateField !== "due") ||
    (option === "settled" && dateField !== "settled") ||
    (statuses !== null &&
      (option !== "issued" || statuses.length < 1 || statuses.length > 5 || statuses.includes(null as unknown as string) ||
        statuses.some((s) => !STATUSES.includes(s)) || new Set(statuses).size !== statuses.length)) ||
    (from !== null && (from < "1900-01-01" || from > "2100-12-31")) ||
    (to !== null && (to < "1900-01-01" || to > "2100-12-31")) ||
    (from !== null && to !== null && from > to) ||
    (account !== null && !noAccount && !UUID_I.test(account)) ||
    (categories !== null &&
      (categories.length < 1 || categories.length > 50 || categories.includes(null as unknown as string) ||
        new Set(categories.map((c) => pgLower(c))).size !== categories.length ||
        categories.some((c) => c !== "none" && !UUID_I.test(c)))) ||
    (remittance !== null && (!["yes", "no"].includes(remittance) || option !== "open")) ||
    (amountN !== null && (amountN < 1 || amountN > 999999999999999)) ||
    (paymentType !== null && !/^[0-9]{2}$/.test(paymentType)) ||
    (seller !== null && kind !== "receivable")
  )
    raise("22023", "erp_finance_invalid_query");
  // 246: Permissões > Finanças > Contas a Receber / Contas a Pagar.
  requirePermission(ctx, user, kind === "receivable" ? "financas.contas_receber" : "financas.contas_pagar");
  const accountId = account !== null && !noAccount ? account.toLowerCase() : null;
  const noCategory = categories !== null && categories.includes("none");
  const categoryIds = categories === null ? null : categories.filter((c) => c !== "none").map((c) => c.toLowerCase());
  let digits: string | null = null;
  if (needle !== null && /^[0-9 ./-]+$/.test(needle)) {
    digits = needle.replace(/[^0-9]/g, "");
    if (digits.length < 3) digits = null;
  }
  const lo = from ?? "1900-01-01",
    hi = to ?? "2100-12-31";
  const paidIn = (id: string) =>
    !!one(
      db,
      `SELECT 1 x FROM "erp_finance__settlement" s WHERE s.title_id=? AND s.kind='payment' AND s.posted_on BETWEEN ? AND ?
         AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id) LIMIT 1`,
      id,
      lo,
      hi,
    );
  const rows = db.exec(
    `SELECT t.id, t.due_on, t.issued_on, t.competence_on, t.amount_cents, t.settled_cents, t.cancelled, t.account_id, t.category_id,
            t.payment_method_id, t.description, t.source_reference, t.bank_number,
            r.name, c.trade_name, c.email, c.document, CAST(d.number AS TEXT) doc_number,
            EXISTS(SELECT 1 FROM "erp_finance__title_return" x WHERE x.title_id=t.id) returned,
            EXISTS(SELECT 1 FROM "erp_cnab__billing_title" b WHERE b.title_id=t.id) billed,
            (SELECT f.payment_type FROM "erp_catalog__payment_method" f WHERE f.id=t.payment_method_id) payment_type
       FROM "erp_finance__title" t
       JOIN "erp_catalog__record" r ON r.id=t.contact_id
       LEFT JOIN "erp_catalog__contact" c ON c.record_id=t.contact_id
       LEFT JOIN "erp_finance__document_title" l ON l.title_id=t.id
       LEFT JOIN "erp_finance__document_posting" dp ON dp.id=l.posting_id
       LEFT JOIN "erp_documents__document" d ON d.id=dp.document_id
      WHERE t.kind=? AND t.deleted_at IS NULL`,
    kind,
  ).rows;
  const open = (t: Record<string, unknown>) => !t.cancelled && Number(t.settled_cents) < Number(t.amount_cents);
  // Lojas (versão 27): com duas lojas ou mais, só as contas das lojas que a pessoa vê (ou da loja em uso).
  const inStore = storeFilter(ctx, user);
  const filtered = rows.filter((t) => {
    const id = String(t.id);
    if (inStore !== null && !inStore.title(id)) return false;
    const amountT = Number(t.amount_cents),
      settledT = Number(t.settled_cents);
    const cancelled = !!t.cancelled;
    if (option === "open" && !open(t)) return false;
    if (option === "overdue" && !(open(t) && String(t.due_on) < today)) return false;
    if (option === "settled" && !paidIn(id)) return false;
    if (
      statuses !== null &&
      !(
        (statuses.includes("open") && !cancelled && settledT === 0) ||
        (statuses.includes("partial") && !cancelled && settledT > 0 && settledT < amountT) ||
        (statuses.includes("paid") && !cancelled && settledT === amountT) ||
        (statuses.includes("cancelled") && cancelled && !t.returned) ||
        (statuses.includes("returned") && cancelled && !!t.returned)
      )
    )
      return false;
    const within = (d: unknown) => String(d) >= lo && String(d) <= hi;
    if (
      !(
        (from === null && to === null) ||
        (dateField === "settled" && option === "settled") ||
        (dateField === "due" && within(t.due_on)) ||
        (dateField === "issued" && within(t.issued_on)) ||
        (dateField === "competence" && within(t.competence_on)) ||
        (dateField === "settled" && paidIn(id))
      )
    )
      return false;
    if (account !== null && !((noAccount && t.account_id === null) || t.account_id === accountId)) return false;
    if (categories !== null && !((noCategory && t.category_id === null) || categoryIds!.includes(String(t.category_id))))
      return false;
    if (remittance !== null && (remittance === "yes") !== !!t.billed) return false;
    if (amountN !== null && amountT !== amountN) return false;
    if (paymentMethod !== null && t.payment_method_id !== paymentMethod) return false;
    if (paymentType !== null && t.payment_type !== paymentType) return false;
    if (seller !== null && titleSeller(db, id) !== seller) return false;
    if (docNeedle !== null && !pgLower([t.source_reference, t.doc_number].filter((v) => v !== null).join(" ")).includes(docNeedle))
      return false;
    if (needle !== null) {
      const text = pgLower(
        [t.name, t.trade_name, t.email, t.document, t.description, t.source_reference, t.bank_number, t.doc_number]
          .filter((v) => v !== null)
          .join(" "),
      );
      const byDigits = digits !== null && String(t.document ?? "").replace(/[^0-9]/g, "").includes(digits);
      if (!text.includes(needle) && !byDigits) return false;
    }
    return true;
  });
  const sign = order === "due_asc" ? 1 : -1;
  filtered.sort((x, y) => sign * (cmpText(String(x.due_on), String(y.due_on)) || cmpText(String(x.id), String(y.id))));
  let amountSum = 0,
    balanceSum = 0;
  for (const t of filtered) {
    amountSum += Number(t.amount_cents);
    balanceSum += t.cancelled ? 0 : Number(t.amount_cents) - Number(t.settled_cents);
  }
  let feeSum = 0;
  if (filtered.length)
    feeSum = Number(
      one(
        db,
        `SELECT coalesce(sum(s.fee_cents),0) f FROM "erp_finance__settlement" s
          WHERE s.title_id IN (SELECT value FROM json_each(?)) AND s.kind='payment'
            AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id)`,
        JSON.stringify(filtered.map((t) => t.id)),
      )!.f,
    );
  const items = filtered.slice((page - 1) * limit, (page - 1) * limit + limit).map((p) => {
    const id = String(p.id);
    const acc = one(db, 'SELECT a.name FROM "erp_finance__account" a JOIN "erp_finance__title" t ON t.account_id=a.id WHERE t.id=?', id);
    const rem = one(
      db,
      `SELECT r.id, r.sequence, r.state, b.our_number FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id WHERE b.title_id=?`,
      id,
    );
    const bank = one(
      db,
      `SELECT a.institution_code, a.institution_name FROM "erp_finance__title" t
         LEFT JOIN "erp_catalog__payment_method" f ON f.id=t.payment_method_id
         JOIN "erp_finance__account" a ON a.id=coalesce(f.account_id, t.account_id)
        WHERE t.id=? AND t.payment_method_id IS NOT NULL AND a.institution_code IS NOT NULL`,
      id,
    );
    return {
      ...dto(db, "titles", id),
      overdue: open(p) && String(p.due_on) < today,
      origin: titleOrigin(db, id),
      account_name: acc?.name ?? null,
      remittance: rem ? { id: rem.id, sequence: rem.sequence, state: rem.state, our_number: rem.our_number } : null,
      payments: titlePayments(ctx, id),
      payment_bank: bank ? { code: bank.institution_code, name: bank.institution_name === null ? null : left(String(bank.institution_name), 80) } : null,
      imported: !!one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" o WHERE o.title_id=? LIMIT 1', id),
    };
  });
  return {
    entity: "titles",
    kind,
    items,
    page,
    limit,
    order,
    option,
    total: filtered.length,
    totals: { count: filtered.length, amount_cents: String(amountSum), balance_cents: String(balanceSum), fee_cents: String(feeSum) },
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_title_page_v2", erpFinanceTitlePageV2);
