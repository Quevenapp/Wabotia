// public.erp_finance_statement_page (o extrato de Caixas e bancos: registros
// de caixa, pernas de transferência, baixas e estornos, tarifas de retorno e
// saldo inicial, com os saldos por dia e o resumo) e
// public.erp_finance_cash_entry_get.
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { dateArgError } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { btrim, charLength, cmpText, CNTRL, pgLower, requireAccess, uuidArg } from "../internal.ts";
import { cashEntryView } from "../cash.ts";

const UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dateArg(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const bad = dateArgError(String(v));
  if (bad) raise(bad.code, bad.message);
  return String(v);
}
const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/** erp_finance.statement_lines(conta, de, até, excluídas) */
export function statementLines(db: SqlDriver, account: string | null, from: string | null, to: string | null, deleted: boolean): Row[] {
  const scope = (col: string, posted: string) =>
    `(? IS NULL OR ${col}=?) AND (? IS NULL OR ${posted}>=?) AND (? IS NULL OR ${posted}<=?)`;
  const params = [account, account, from, from, to, to];
  const out: Row[] = [];
  out.push(
    ...db.exec(
      `SELECT e.id line_id, 'entry' line_kind, e.posted_on, e.created_at, e.account_id, CASE WHEN e.kind='in' THEN e.amount_cents ELSE -e.amount_cents END amount_cents,
              (SELECT m.category_id FROM "erp_finance__movement" m WHERE m.entry_id=e.id AND m.kind='entry' AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" c WHERE c.compensates_id=m.id) ORDER BY m.created_at DESC LIMIT 1) category_id,
              e.contact_id, e.note, NULL title_id, NULL title_kind, NULL transfer_id, e.id entry_id, e.version entry_version, e.origin entry_origin, e.competence_on
         FROM "erp_finance__cash_entry" e WHERE ${scope("e.account_id", "e.posted_on")} AND (e.deleted_at IS NOT NULL)=?`,
      ...params,
      deleted ? 1 : 0,
    ).rows,
    ...db.exec(
      `SELECT m.id line_id, 'transfer' line_kind, m.posted_on, m.created_at, m.account_id, m.delta_cents amount_cents, m.category_id, NULL contact_id, m.note,
              NULL title_id, NULL title_kind, m.transfer_id, NULL entry_id, NULL entry_version, NULL entry_origin, m.posted_on competence_on
         FROM "erp_finance__movement" m
        WHERE m.transfer_id IS NOT NULL AND ${scope("m.account_id", "m.posted_on")}
          AND NOT EXISTS(SELECT 1 FROM "erp_finance__transfer_deletion" d WHERE d.reversal_id=m.transfer_id)
          AND EXISTS(SELECT 1 FROM "erp_finance__transfer_deletion" d WHERE d.transfer_id=m.transfer_id)=?`,
      ...params,
      deleted ? 1 : 0,
    ).rows,
  );
  if (!deleted) {
    const settlementRows = db.exec(
      `SELECT m.id line_id, 'settlement' line_kind, m.posted_on, m.created_at, m.account_id, m.delta_cents amount_cents, m.kind m_kind, s.id s_id,
              coalesce(i.category_id, b.category_id, t.category_id) base_category, t.contact_id,
              coalesce(CASE WHEN m.kind='payment' THEN s.history END, m.note, t.description) note, t.id title_id, t.kind title_kind,
              NULL transfer_id, NULL entry_id, NULL entry_version, NULL entry_origin, t.competence_on
         FROM "erp_finance__movement" m JOIN "erp_finance__settlement" s ON s.id=m.settlement_id JOIN "erp_finance__title" t ON t.id=s.title_id
         LEFT JOIN "erp_finance__bordero_item" i ON i.settlement_id=coalesce(s.reverses_id, s.id) LEFT JOIN "erp_finance__bordero" b ON b.id=i.bordero_id
        WHERE ${scope("m.account_id", "m.posted_on")}`,
      ...params,
    ).rows;
    for (const r of settlementRows) {
      let category = r.base_category as string | null;
      if (r.m_kind === "bank_fee" || r.m_kind === "bank_fee_reversal") {
        const plan = one(
          db,
          `SELECT p.category_id FROM "erp_finance__settlement" s LEFT JOIN "erp_finance__settlement" original ON original.id=s.reverses_id
             JOIN "erp_finance__cnab_cash_plan" p ON p.command_id=CASE WHEN s.kind='payment' THEN s.command_id ELSE original.command_id END WHERE s.id=?`,
          r.s_id,
        );
        category = (plan?.category_id as string | null) ?? category;
      }
      const { m_kind, s_id, base_category, ...rest } = r;
      void m_kind;
      void s_id;
      void base_category;
      out.push({ ...rest, category_id: category });
    }
    out.push(
      ...db.exec(
        `SELECT m.id line_id, 'opening' line_kind, m.posted_on, m.created_at, m.account_id, m.delta_cents amount_cents, m.category_id, NULL contact_id,
                coalesce(m.note, 'Saldo inicial') note, NULL title_id, NULL title_kind, NULL transfer_id, NULL entry_id, NULL entry_version, NULL entry_origin, m.posted_on competence_on
           FROM "erp_finance__movement" m WHERE m.kind='opening' AND ${scope("m.account_id", "m.posted_on")}`,
        ...params,
      ).rows,
    );
  }
  return out;
}

/** erp_finance.statement_line_cancelled */
const lineCancelled = (db: SqlDriver, kind: string, line: string) =>
  kind === "settlement" &&
  !!one(
    db,
    `SELECT 1 x FROM "erp_finance__movement" m JOIN "erp_finance__settlement" s ON s.id=m.settlement_id
      WHERE m.id=? AND (s.kind='reversal' OR EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id)) LIMIT 1`,
    line,
  );

/** erp_finance.line_reconciled */
export const lineReconciled = (db: SqlDriver, kind: string, id: string) =>
  kind === "entry"
    ? !!one(db, 'SELECT 1 x FROM "erp_finance__reconciliation_link" WHERE entry_id=? AND undone_at IS NULL LIMIT 1', id)
    : ["transfer", "settlement"].includes(kind)
      ? !!one(db, 'SELECT 1 x FROM "erp_finance__reconciliation_link" WHERE movement_id=? AND undone_at IS NULL LIMIT 1', id)
      : false;

/** erp_finance.origin_declared_origin: só com o espelho do Origin, desligado nesta instalação. */
function originDeclaredOrigin(db: SqlDriver, title: string) {
  if (
    one(
      db,
      `SELECT 1 x FROM "erp_finance__origin_import_origin" o JOIN "origin_sync__raw_record" r ON r.entity=o.entity AND r.source_id=o.source_id WHERE o.title_id=? LIMIT 1`,
      title,
    )
  )
    raise("0A000", "rpc_not_ported:erp_finance.origin_declared_origin");
  return null;
}

/** erp_finance.statement_line_dto */
export function statementLineDto(db: SqlDriver, l: Row) {
  let doc: Record<string, unknown> | null = null;
  if (l.title_id !== null) {
    const d = one(
      db,
      `SELECT d.kind, CAST(d.number AS TEXT) number FROM "erp_finance__document_title" x JOIN "erp_finance__document_posting" dp ON dp.id=x.posting_id
         JOIN "erp_documents__document" d ON d.id=dp.document_id WHERE x.title_id=? LIMIT 1`,
      l.title_id,
    );
    if (d) doc = { kind: d.kind, number: d.number };
    if (!doc) {
      const i = one(
        db,
        `SELECT CAST(i.number AS TEXT) number FROM "erp_finance__invoice_title" x JOIN "erp_finance__invoice_posting" ip ON ip.id=x.posting_id
           JOIN "erp_fiscal_invoices__invoice" i ON i.id=ip.invoice_id WHERE x.title_id=? AND i.number IS NOT NULL LIMIT 1`,
        l.title_id,
      );
      if (i) doc = { kind: "fiscal_invoices", number: i.number };
    }
    if (!doc) doc = originDeclaredOrigin(db, String(l.title_id));
  }
  const name = (table: string, id: unknown) => (id === null ? null : (one(db, `SELECT name FROM "${table}" WHERE id=?`, id)?.name ?? null));
  return {
    line_id: l.line_id,
    line_kind: l.line_kind,
    posted_on: l.posted_on,
    competence_on: l.competence_on,
    account_id: l.account_id,
    account_name: name("erp_finance__account", l.account_id),
    amount_cents: String(l.amount_cents),
    category_id: l.category_id ?? null,
    category_name: name("erp_finance__category", l.category_id ?? null),
    contact_id: l.contact_id ?? null,
    contact_name: name("erp_catalog__record", l.contact_id ?? null),
    note: l.note ?? null,
    title_id: l.title_id ?? null,
    title_kind: l.title_kind ?? null,
    document: doc,
    transfer_id: l.transfer_id ?? null,
    entry_id: l.entry_id ?? null,
    entry_version: l.entry_version ?? null,
    entry_origin: l.entry_origin ?? null,
    reconciled: lineReconciled(db, String(l.line_kind), String(l.line_id)),
  };
}

export function erpFinanceStatementPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const account = uuidArg(a.p_account);
  const from = dateArg(a.p_from);
  const to = dateArg(a.p_to);
  const tab = (a.p_tab as string | null);
  const deleted = (a.p_deleted as boolean | null);
  const categories = (a.p_categories as string[] | null) ?? null;
  const amount = (a.p_amount_cents as number | string | null) ?? null;
  const amountN = amount === null ? null : Number(amount);
  const query = (a.p_query as string | null) ?? null;
  const order = (a.p_order as string | null);
  const page = (a.p_page as number | null);
  const limit = (a.p_limit as number | null);
  const reconciliation = (a.p_reconciliation as string | null) ?? null;
  const cancelled = (a.p_cancelled as boolean | null);
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    tab === null || !["all", "in", "out"].includes(tab) || deleted === null || order === null || !["asc", "desc"].includes(order) ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (amountN !== null && (amountN < 1 || amountN > 999999999999999)) ||
    from === null || to === null || from < "1900-01-01" || to > "2100-12-31" || from > to || days(from, to) > 3660 ||
    (reconciliation !== null && (!["reconciled", "unreconciled"].includes(reconciliation) || deleted)) ||
    cancelled === null || (cancelled && deleted) ||
    (categories !== null &&
      (categories.length < 1 || categories.length > 200 || categories.includes(null as unknown as string) ||
        categories.some((c) => c !== "none" && !UUID_I.test(c))))
  )
    raise("22023", "erp_finance_invalid_query");
  if (!permitted(db, user, "financas.caixas_bancos")) raise("42501", "erp_finance_permission_denied");
  if (account !== null && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL', account))
    raise("P0002", "erp_finance_not_found");
  const none = categories !== null && categories.includes("none");
  const catIds = categories === null ? null : categories.filter((c) => c !== "none").map((c) => c.toLowerCase());
  const accounts = db
    .exec('SELECT id FROM "erp_finance__account" WHERE deleted_at IS NULL AND (? IS NULL OR id=?)', account, account)
    .rows.map((r) => String(r.id));
  const lines = statementLines(db, account, from, to, deleted).filter(
    (l) => accounts.includes(String(l.account_id)) && (!cancelled || lineCancelled(db, String(l.line_kind), String(l.line_id))),
  );
  const contactName = (id: unknown) => (id === null ? null : (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name ?? null));
  const filtered = lines.filter((l) => {
    const amt = Number(l.amount_cents);
    if (tab === "in" && !(amt > 0)) return false;
    if (tab === "out" && !(amt < 0)) return false;
    if (amountN !== null && Math.abs(amt) !== amountN) return false;
    if (catIds !== null && !((none && l.category_id === null) || (l.category_id !== null && catIds.includes(String(l.category_id))))) return false;
    if (needle !== null && !pgLower([l.note, contactName(l.contact_id)].filter((v) => v !== null).join(" ")).includes(needle)) return false;
    if (reconciliation !== null && lineReconciled(db, String(l.line_kind), String(l.line_id)) !== (reconciliation === "reconciled")) return false;
    return true;
  });
  const sign = order === "asc" ? 1 : -1;
  filtered.sort(
    (x, y) =>
      sign * cmpText(String(x.posted_on), String(y.posted_on)) ||
      sign * (Number(x.created_at) - Number(y.created_at)) ||
      cmpText(String(x.line_id), String(y.line_id)),
  );
  const pageRows = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
  const accountList = JSON.stringify(accounts);
  const sumUntil = (op: string, day: string | null) =>
    String(
      one(
        db,
        `SELECT coalesce(sum(delta_cents),0) s FROM "erp_finance__movement" WHERE account_id IN (SELECT value FROM json_each(?))${day === null ? "" : ` AND posted_on${op}?`}`,
        ...(day === null ? [accountList] : [accountList, day]),
      )!.s,
    );
  const dayBalances: Record<string, string> = {};
  for (const d of [...new Set(pageRows.map((p) => String(p.posted_on)))]) dayBalances[d] = sumUntil("<=", d);
  const before = Number(sumUntil("<", from));
  const sumLines = (pred: (l: Row) => boolean, f: (l: Row) => number) => lines.filter(pred).reduce((s, l) => s + f(l), 0);
  const summary = {
    before_cents: String(before),
    previous_cents: String(before + (deleted ? 0 : sumLines((l) => l.line_kind === "opening", (l) => Number(l.amount_cents)))),
    in_cents: String(deleted ? 0 : sumLines((l) => Number(l.amount_cents) > 0 && l.line_kind !== "opening", (l) => Number(l.amount_cents))),
    out_cents: String(deleted ? 0 : sumLines((l) => Number(l.amount_cents) < 0 && l.line_kind !== "opening", (l) => -Number(l.amount_cents))),
    closing_cents: sumUntil("<=", to),
    current_cents: sumUntil("", null),
    reconciled_lines: lines.filter((l) => lineReconciled(db, String(l.line_kind), String(l.line_id))).length,
  };
  return {
    entity: "statement",
    account_id: account,
    from,
    to,
    tab,
    deleted,
    cancelled,
    order,
    page,
    limit,
    reconciliation,
    total: filtered.length,
    items: pageRows.map((l) => statementLineDto(db, l)),
    day_balances: deleted || cancelled ? {} : dayBalances,
    summary,
    data_mode: "erp_native",
  };
}

export function erpFinanceCashEntryGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const id = uuidArg(a.p_id);
  requireAccess(ctx.db, user, false);
  const v = id === null ? null : cashEntryView(ctx.db, id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { entity: "cash_entries", record: v, data_mode: "erp_native" };
}

registerRpc("erp_finance_statement_page", erpFinanceStatementPage);
registerRpc("erp_finance_cash_entry_get", erpFinanceCashEntryGet);
