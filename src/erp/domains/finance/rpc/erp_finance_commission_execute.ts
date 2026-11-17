// Comissões: public.erp_finance_commission_execute (pagamento por caixa ou por
// conta a pagar, outro lançamento, comissão manual e excluir),
// erp_finance_commission_page (razão por vendedor no mês),
// erp_finance_commission_statement (extrato do vendedor) e
// erp_finance_commission_report (relatório das operações comerciais, 370).
import { fromColumn } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { contactScope } from "../../catalog/public.ts";
import { get as preference } from "../../preferences/public.ts";
import {
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  expected,
  field,
  hasKey,
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
  toJsonb,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import { cashAccount, cashCategory, cashCompensate, cashPost, cashText, insertCashEntry, updateCashEntry } from "../cash.ts";
import { activeAccount, insertTitle } from "../titles.ts";
import { commissionRows, entryCounts, entryView, operationView, rate2, roundDiv, sellers, sellerView, sellerVisible } from "../commissions.ts";

const ACTIONS = ["commission_payment", "commission_entry", "commission_manual", "commission_delete"];
const textOf = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));
const lastDay = (month: string) => {
  const d = new Date(`${month}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

function paymentOrEntry(ctx: RpcContext, action: string, data: unknown, user: string, command: string) {
  const db = ctx.db;
  keys(data, action === "commission_payment" ? ["seller_id", "month", "posted_on", "category_id", "account_id", "amount_cents", "description"] : ["seller_id", "month", "posted_on", "amount_cents", "kind", "description"]);
  const seller = uuidValue(field(data, "seller_id"))!;
  sellerVisible(db, user, seller);
  const month = day(field(data, "month"));
  if (month.slice(8) !== "01" || month > "2100-12-01") raise("22023", "erp_finance_invalid_date");
  const posted = day(field(data, "posted_on"));
  const amount = cents(field(data, "amount_cents"), false);
  const text = cashText(data, "description", 240, true)!;
  if (CNTRL.test(text)) raise("22023", "erp_finance_invalid_text");
  const now = () => ctx.clock.next().toString();
  let id: string;
  if (action === "commission_entry") {
    const kind = txt(data, "kind", 10, true)!;
    if (!["credit", "debit"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    id = crypto.randomUUID();
    db.exec(
      'INSERT INTO "erp_finance__commission_entry"(id, seller_id, kind, month, posted_on, amount_cents, description, version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)',
      id, seller, kind, month, posted, amount, text, user, command, now(),
    );
  } else {
    const contact = one(db, 'SELECT contact_id FROM "erp_catalog__seller" WHERE id=?', seller)!.contact_id as string;
    const payable = (preference(db, "financas.comissoes_contas_pagar") ?? false) === true;
    id = crypto.randomUUID();
    if (payable) {
      // "Gerenciar comissões através de contas à pagar": a conta a pagar ao vendedor, vencendo na Data operação.
      const category = cashCategory(db, field(data, "category_id"), "payable");
      const title = insertTitle(ctx, {
        group_id: crypto.randomUUID(), installment: 1, installments: 1, kind: "payable", contact_id: contact, category_id: category, description: text,
        issued_on: posted, due_on: posted, amount_cents: amount, competence_on: posted, account_id: activeAccount(db, uuidValue(field(data, "account_id"), false)),
      });
      db.exec(
        'INSERT INTO "erp_finance__commission_entry"(id, seller_id, kind, month, posted_on, amount_cents, description, category_id, account_id, title_id, version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
        id, seller, "payment", month, posted, amount, text, category, uuidValue(field(data, "account_id"), false), title, user, command, now(),
      );
    } else {
      // O lançamento de caixa (saída) na Conta origem, com o vendedor como contato.
      const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
      const category = cashCategory(db, field(data, "category_id"), "payable");
      const activeContact = one(db, 'SELECT id FROM "erp_catalog__record" WHERE id=? AND active=1', contact)?.id ?? null;
      const entry = insertCashEntry(ctx, {
        account_id: account.id, kind: "out", amount_cents: amount, posted_on: posted, competence_on: posted, contact_id: activeContact, note: text,
        origin: "commission", source_key: `commission:${id}`, actor: user, command_id: command,
      });
      cashPost(ctx, entry, category, user, command);
      updateAccount(ctx, String(account.id), {});
      db.exec(
        'INSERT INTO "erp_finance__commission_entry"(id, seller_id, kind, month, posted_on, amount_cents, description, category_id, account_id, cash_entry_id, version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
        id, seller, "payment", month, posted, amount, text, category, account.id, entry.id, user, command, now(),
      );
    }
  }
  return { entity: "commission_entries", record: entryView(db, id) };
}

function manual(ctx: RpcContext, data: unknown, user: string, command: string) {
  const db = ctx.db;
  // Comissão manual: Data vencimento, Data crédito e Valor parcela, com a alíquota do vendedor ou a informada.
  keys(data, ["seller_id", "due_on", "credit_on", "parcel_cents", "rate", "description"]);
  const seller = uuidValue(field(data, "seller_id"))!;
  sellerVisible(db, user, seller);
  const due = day(field(data, "due_on"));
  const credit = day(field(data, "credit_on"));
  const amount = cents(field(data, "parcel_cents"), false);
  let rate4: bigint | null;
  if (hasKey(data, "rate") && field(data, "rate") !== null) {
    const raw = textOf(field(data, "rate"))!;
    if (jsonType(field(data, "rate")) !== "string" || !/^(0|[1-9][0-9]?|100)(\.[0-9]{1,4})?$/.test(raw)) raise("22023", "erp_finance_invalid_data");
    const [int, frac = ""] = raw.split(".");
    rate4 = BigInt(int) * 10000n + BigInt(frac.padEnd(4, "0"));
    if (rate4 > 1000000n) raise("22023", "erp_finance_invalid_data");
  } else {
    const s = one(db, 'SELECT commission_rate FROM "erp_catalog__seller" WHERE id=?', seller);
    rate4 = s?.commission_rate === null || s?.commission_rate === undefined ? null : fromColumn(s.commission_rate);
  }
  const commission = rate4 === null ? 0n : roundDiv(BigInt(amount) * rate4, 1000000n);
  if (rate4 === null || rate4 <= 0n || commission < 1n) raise("22023", "erp_finance_commission_rate_required");
  const text = cashText(data, "description", 240, false) ?? "Comissão manual";
  if (CNTRL.test(text)) raise("22023", "erp_finance_invalid_text");
  const id = crypto.randomUUID();
  const rule = one(db, 'SELECT commission_rule FROM "erp_catalog__seller" WHERE id=?', seller)!.commission_rule;
  db.exec(
    `INSERT INTO "erp_finance__commission"(id, seller_id, origin, rule, parcel_cents, base_cents, rate, commission_cents, due_on, credit_on, description, version, actor, command_id, created_at)
     VALUES(?,?,'manual',?,?,?,?,?,?,?,?,1,?,?,?)`,
    id, seller, rule, amount, amount, Number(rate4 * 100n), Number(commission), due, credit, text, user, command, ctx.clock.next().toString(),
  );
  return {
    entity: "commissions",
    record: {
      id, seller_id: seller, origin: "manual", due_on: due, credit_on: credit, parcel_cents: String(amount), rate: rate2(rate4, 4),
      commission_cents: String(commission), description: text, version: 1, deleted: false,
    },
  };
}

function remove(ctx: RpcContext, data: unknown, user: string, command: string): { result: Record<string, unknown>; before: unknown } {
  const db = ctx.db;
  // Excluir: comissão manual, outro lançamento ou pagamento por caixa (o lançamento de caixa é desfeito na mesma data).
  keys(data, ["target", "id", "expected_version"]);
  const target = txt(data, "target", 20, true);
  const id = uuidValue(field(data, "id"))!;
  if (target === "commission") {
    let c = one(db, 'SELECT * FROM "erp_finance__commission" WHERE id=?', id);
    if (!c || c.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    sellerVisible(db, user, String(c.seller_id));
    c = one(db, 'SELECT * FROM "erp_finance__commission" WHERE id=?', id)!;
    if (c.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    if (c.origin !== "manual" || c.deleted_at !== null) raise("40001", "erp_finance_commission_locked");
    const json = toJsonb("erp_finance__commission", c) as Record<string, unknown>;
    const before = Object.fromEntries(Object.entries(json).filter(([k]) => !["actor", "command_id", "deleted_by"].includes(k)));
    writeRow(ctx, "erp_finance__commission", "id", id, { deleted_at: ctx.clock.next().toString(), deleted_by: user, version: Number(c.version) + 1 });
    return { result: { entity: "commissions", record: { id, deleted: true } }, before };
  }
  if (target === "entry") {
    let e = one(db, 'SELECT * FROM "erp_finance__commission_entry" WHERE id=?', id);
    if (!e || e.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    sellerVisible(db, user, String(e.seller_id));
    if (e.title_id !== null) raise("40001", "erp_finance_commission_payment_title");
    e = one(db, 'SELECT * FROM "erp_finance__commission_entry" WHERE id=?', id)!;
    if (e.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    if (e.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    const before = entryView(db, id);
    if (e.cash_entry_id !== null) {
      const entry = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', e.cash_entry_id)!;
      if (entry.deleted_at === null) {
        setFlag(ctx, "erp_finance.commission_owner", "on");
        cashCompensate(ctx, String(entry.id), user, command);
        const now = ctx.clock.next().toString();
        const version = Number(one(db, 'SELECT version FROM "erp_finance__cash_entry" WHERE id=?', entry.id)!.version);
        updateCashEntry(ctx, String(entry.id), { deleted_at: now, deleted_by: user, deleted_note: "Pagamento de comissão excluído", version: version + 1, updated_at: now });
        setFlag(ctx, "erp_finance.commission_owner", "");
        updateAccount(ctx, String(entry.account_id), {});
      }
    }
    writeRow(ctx, "erp_finance__commission_entry", "id", id, { deleted_at: ctx.clock.next().toString(), deleted_by: user, version: Number(e.version) + 1 });
    return { result: { entity: "commission_entries", record: entryView(db, id) }, before };
  }
  raise("22023", "erp_finance_invalid_data");
}

export function erpFinanceCommissionExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 16384) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;
  let result: Record<string, unknown>;
  let before: unknown = null;
  if (action === "commission_payment" || action === "commission_entry") result = paymentOrEntry(ctx, action, data, user, command);
  else if (action === "commission_manual") result = manual(ctx, data, user, command);
  else ({ result, before } = remove(ctx, data, user, command));
  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

const monthOk = (m: string | null) => m !== null && m.slice(8) === "01" && m >= "1900-01-01" && m <= "2100-12-01";

export function erpFinanceCommissionPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const month = (a.p_month as string | null) ?? null;
  const situation = (a.p_situation as string | null) ?? null;
  const idle = (a.p_with_idle as boolean | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    !monthOk(month) || situation === null || !["all", "A", "I", "S"].includes(situation) || idle === null ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 || (query !== null && (charLength(query) > 120 || CNTRL.test(query)))
  )
    raise("22023", "erp_finance_invalid_query");
  const from = month!;
  const to = lastDay(from);
  const scope = contactScope(db, user);
  const picked = sellers(db).filter(
    (s) =>
      (scope === null || s.id === scope) &&
      (needle === null || pgLower([s.name, s.code].filter((x) => x !== null).map(String).join(" ")).includes(needle)) &&
      s.situation !== "E" && (situation === "all" || s.situation === situation),
  );
  const ids = new Set(picked.map((s) => String(s.id)));
  const rows = commissionRows(db, null).filter((r) => ids.has(r.seller_id) && r.void === false);
  const entries = db.exec('SELECT * FROM "erp_finance__commission_entry"').rows.filter((e) => ids.has(String(e.seller_id)) && entryCounts(db, e));
  const sums = picked.map((s) => {
    const mine = rows.filter((r) => r.seller_id === s.id);
    const ent = entries.filter((e) => e.seller_id === s.id);
    const inMonth = (d: string | null) => d !== null && d >= from && d <= to;
    const x = {
      id: String(s.id), name: String(s.name), situation: s.situation,
      billed: sum(mine.filter((r) => inMonth(r.released_on)).map((r) => r.parcel_cents)),
      previous:
        sum(mine.filter((r) => r.released_on !== null && r.released_on < from).map((r) => r.commission_cents)) +
        sum(ent.filter((e) => String(e.month) < from && e.kind !== "payment").map((e) => (e.kind === "credit" ? 1 : -1) * Number(e.amount_cents))) -
        sum(ent.filter((e) => String(e.month) < from && e.kind === "payment").map((e) => Number(e.amount_cents))),
      month: sum(mine.filter((r) => inMonth(r.released_on)).map((r) => r.commission_cents)),
      credits: sum(ent.filter((e) => e.kind === "credit" && e.month === from).map((e) => Number(e.amount_cents))),
      debits: sum(ent.filter((e) => e.kind === "debit" && e.month === from).map((e) => Number(e.amount_cents))),
      payments: sum(ent.filter((e) => e.kind === "payment" && e.month === from).map((e) => Number(e.amount_cents))),
      pending: sum(mine.filter((r) => r.created_on !== null && r.created_on <= to && (r.released_on === null || r.released_on > to)).map((r) => r.commission_cents)),
    };
    return { ...x, balance: x.previous + x.month + x.credits - x.debits - x.payments };
  });
  const shown = sums
    .filter((x) => idle || x.billed !== 0 || x.previous !== 0 || x.month !== 0 || x.credits !== 0 || x.debits !== 0 || x.payments !== 0 || x.pending !== 0)
    .sort((x, y) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(x.id, y.id));
  const total = (k: keyof (typeof shown)[number]) => String(sum(shown.map((x) => x[k] as number)));
  return {
    entity: "commissions", month: from.slice(0, 7), situation, with_idle: idle, page, limit, total: shown.length,
    items: shown.slice((page! - 1) * limit!, (page! - 1) * limit! + limit!).map((x) => ({
      seller_id: x.id, name: x.name, situation: x.situation, billed_cents: String(x.billed), previous_cents: String(x.previous), commission_cents: String(x.month),
      credit_cents: String(x.credits), debit_cents: String(x.debits), payment_cents: String(x.payments), pending_cents: String(x.pending), balance_cents: String(x.balance),
    })),
    totals: {
      billed_cents: total("billed"), previous_cents: total("previous"), commission_cents: total("month"), credit_cents: total("credits"), debit_cents: total("debits"),
      payment_cents: total("payments"), pending_cents: total("pending"), balance_cents: total("balance"),
    },
    data_mode: "erp_native",
  };
}

export function erpFinanceCommissionStatement(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const seller = uuidArg(a.p_seller);
  const month = (a.p_month as string | null) ?? null;
  const today = todaySaoPaulo();
  requireAccess(db, user, false);
  if (!monthOk(month)) raise("22023", "erp_finance_invalid_query");
  sellerVisible(db, user, seller);
  const from = month!;
  const to = lastDay(from);
  const rows = commissionRows(db, seller).filter((r) => r.void === false);
  const entries = db
    .exec('SELECT * FROM "erp_finance__commission_entry" WHERE seller_id=? AND deleted_at IS NULL', seller)
    .rows.map((e) => ({ e, counts: entryCounts(db, e) }));
  const monthRows = rows.filter((r) => r.released_on !== null && r.released_on >= from && r.released_on <= to);
  const pending = rows.filter((r) => r.created_on !== null && r.created_on <= to && (r.released_on === null || r.released_on > to));
  const counted = entries.filter((x) => x.counts).map((x) => x.e);
  const previous =
    sum(rows.filter((r) => r.released_on !== null && r.released_on < from).map((r) => r.commission_cents)) +
    sum(counted.filter((e) => String(e.month) < from).map((e) => (e.kind === "credit" ? 1 : -1) * Number(e.amount_cents)));
  const of = (kind: string) => counted.filter((e) => e.kind === kind && e.month === from);
  const group = (kind: string) => {
    const list = of(kind);
    return {
      total: list.length,
      amount_cents: String(sum(list.map((e) => Number(e.amount_cents)))),
      items: [...list]
        .sort((x, y) => cmpText(String(x.posted_on), String(y.posted_on)) || cmpText(String(x.id), String(y.id)))
        .slice(0, 500)
        .map((e) => entryView(db, String(e.id))),
    };
  };
  const commissions = sum(monthRows.map((r) => r.commission_cents));
  const credits = sum(of("credit").map((e) => Number(e.amount_cents)));
  const debits = sum(of("debit").map((e) => Number(e.amount_cents)));
  const payments = sum(of("payment").map((e) => Number(e.amount_cents)));
  const pendingTotal = sum(pending.map((r) => r.commission_cents));
  return {
    entity: "commission_statement",
    seller: sellerView(db, seller!),
    month: from.slice(0, 7),
    commissions: {
      total: monthRows.length,
      parcel_cents: String(sum(monthRows.map((r) => r.parcel_cents))),
      base_cents: String(sum(monthRows.map((r) => r.base_cents))),
      commission_cents: String(commissions),
      items: [...monthRows]
        .sort((x, y) => cmpText(x.released_on!, y.released_on!) || cmpText(x.description, y.description) || cmpText(x.id, y.id))
        .slice(0, 500)
        .map((r) => ({
          id: r.id, origin: r.origin, day: r.released_on, description: r.description, parcel_cents: String(r.parcel_cents), base_cents: String(r.base_cents),
          rate: rate2(r.rate, 6), commission_cents: String(r.commission_cents),
          document: r.document_id === null ? null : { id: r.document_id, kind: r.document_kind, number: r.document_number === null ? null : String(r.document_number) },
          title_id: r.title_id, version: r.version,
        })),
    },
    credits: group("credit"),
    debits: group("debit"),
    payments: group("payment"),
    pending: {
      total: pending.length,
      commission_cents: String(pendingTotal),
      items: [...pending]
        .sort((x, y) => cmpText(x.due_on, y.due_on) || cmpText(x.id, y.id))
        .slice(0, 500)
        .map((r) => ({ id: r.id, due_on: r.due_on, description: r.description, situation: r.due_on < today ? "overdue" : "upcoming", commission_cents: String(r.commission_cents) })),
    },
    summary: {
      previous_cents: String(previous), commission_cents: String(commissions), credit_cents: String(credits), debit_cents: String(debits), payment_cents: String(payments),
      pending_cents: String(pendingTotal), balance_cents: String(previous + commissions + credits - debits - payments),
    },
    payable: (preference(db, "financas.comissoes_contas_pagar") ?? false) === true,
    data_mode: "erp_native",
  };
}

export function erpFinanceCommissionReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const sellerId = uuidArg(a.p_seller_id);
  const state = (a.p_state as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  requireAccess(db, user, false);
  if (!permitted(db, user, "vendas.comissoes")) raise("42501", "erp_finance_forbidden");
  const span = from !== null && to !== null ? (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 : 0;
  if (
    from === null || to === null || from > to || from < "1900-01-01" || to > "2100-12-31" || span > 366 || state === null || !["all", "active", "cancelled"].includes(state) ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100
  )
    raise("22023", "erp_finance_invalid_query");
  const scope = contactScope(db, user);
  if (sellerId !== null) sellerVisible(db, user, sellerId);
  const ops = db
    .exec(
      `SELECT o.id, o.seller_id, o.confirmed_on, d.kind, d.number, d.body, d.contact_snapshot FROM "erp_finance__commission_operation" o
         JOIN "erp_documents__document" d ON d.id=o.document_id WHERE o.state<>'superseded' AND (?='all' OR o.state=?) AND o.confirmed_on>=? AND o.confirmed_on<=?`,
      state, state, from, to,
    )
    .rows.filter((o) => (sellerId === null || o.seller_id === sellerId) && (scope === null || o.seller_id === scope))
    .map((o) => {
      const body = JSON.parse(String(o.body));
      const snapshot = JSON.parse(String(o.contact_snapshot));
      const date = body && typeof body === "object" && !Array.isArray(body) ? textOf(body.date) : null;
      const name = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? textOf(snapshot.name) : null;
      return Object.assign({}, o, { document_date: date, contact_name: name ?? "", v: operationView(db, String(o.id))! }) as typeof o & {
        document_date: string | null;
        contact_name: string;
        v: NonNullable<ReturnType<typeof operationView>>;
      };
    });
  const pays = new Map<string, number>();
  for (const e of db.exec(`SELECT * FROM "erp_finance__commission_entry" WHERE kind='payment' AND posted_on>=? AND posted_on<=?`, from, to).rows)
    if ((sellerId === null || e.seller_id === sellerId) && (scope === null || e.seller_id === scope) && entryCounts(db, e))
      pays.set(String(e.seller_id), (pays.get(String(e.seller_id)) ?? 0) + Number(e.amount_cents));
  const involved = new Set([...ops.map((o) => String(o.seller_id)), ...pays.keys()]);
  const per = sellers(db)
    .filter((s) => involved.has(String(s.id)))
    .map((s) => {
      const mine = ops.filter((o) => o.seller_id === s.id);
      const add = (k: string) => sum(mine.map((o) => Number((o.v as Record<string, unknown>)[k])));
      return {
        seller_id: String(s.id), name: String(s.name), operations: mine.length, estimated: add("estimated_cents"), adjusted: add("adjusted_cents"),
        eligible: add("eligible_cents"), paid: pays.get(String(s.id)) ?? 0,
      };
    });
  const order = [...ops].sort(
    (x, y) => cmpText(String(x.confirmed_on), String(y.confirmed_on)) || (x.number === null ? (y.number === null ? 0 : 1) : y.number === null ? -1 : Number(x.number) - Number(y.number)) || cmpText(String(x.id), String(y.id)),
  );
  return {
    entity: "commission_report", from, to, seller_id: sellerId, state, page, limit, total: ops.length,
    items: order.slice((page - 1) * limit, (page - 1) * limit + limit).map((x) => ({
      ...x.v, document_number: x.number === null ? null : String(x.number), document_date: x.document_date, contact_name: x.contact_name,
      seller_name: per.find((p) => p.seller_id === x.seller_id)?.name ?? null,
    })),
    sellers: [...per]
      .sort((x, y) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(x.seller_id, y.seller_id))
      .map((p) => ({
        seller_id: p.seller_id, name: p.name, operations: p.operations, estimated_cents: String(p.estimated), adjusted_cents: String(p.adjusted),
        eligible_cents: String(p.eligible), paid_cents: String(p.paid),
      })),
    totals: {
      estimated_cents: String(sum(per.map((p) => p.estimated))), adjusted_cents: String(sum(per.map((p) => p.adjusted))),
      eligible_cents: String(sum(per.map((p) => p.eligible))), paid_cents: String(sum(per.map((p) => p.paid))),
    },
    data_mode: "erp_native",
    operational_effects: false,
  };
}

registerRpc("erp_finance_commission_execute", erpFinanceCommissionExecute);
registerRpc("erp_finance_commission_page", erpFinanceCommissionPage);
registerRpc("erp_finance_commission_statement", erpFinanceCommissionStatement);
registerRpc("erp_finance_commission_report", erpFinanceCommissionReport);
