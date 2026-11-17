// CNAB, bloco C1: as listas das telas de remessas e retornos (migrações 211 a
// 213, versões finais no oráculo). public.erp_cnab_remittance_page,
// _remittance_detail, _remittance_candidates, _return_page e _return_detail.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { bool, date, int, text, uuid } from "../args.ts";
import {
  access,
  bankLabel,
  financePermission,
  get,
  parse,
  profileRow,
  REMITTANCE_COLUMNS,
  remittanceFilename,
  returnApplied,
  returnGroup,
  returnNumber,
  toRemittance,
  ts,
  txt,
} from "../core.ts";

const invalidQuery = (): never => raise("22023", "erp_cnab_invalid_query");
/** lower(nullif(btrim(q),'')) */
const searchTerm = (q: string | null) => (q === null || pgBtrim(q) === "" ? null : pgLower(pgBtrim(q)));
const ltrimZeros = (s: string) => s.replace(/^0+/, "");
const big = (v: unknown) => (v === null || v === undefined ? 0n : BigInt(typeof v === "string" ? v : String(v)));

/** erp_cnab.list_query(q) e as conferências de página e período das duas páginas. */
function pageArgs(a: RpcArgs) {
  const q = text(a, "p_query");
  if (q !== null && (pgLength(q) > 120 || pgHasCntrl.test(q))) invalidQuery();
  const page = int(a, "p_page");
  const limit = int(a, "p_limit");
  const from = date(a, "p_from");
  const to = date(a, "p_to");
  const outOfRange = (d: string | null) => d !== null && (d < "1900-01-01" || d > "2100-12-31");
  if (page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 || (from !== null && to !== null && from > to) || outOfRange(from) || outOfRange(to))
    invalidQuery();
  return { query: searchTerm(q), page: page!, limit: limit!, from, to };
}

const remittanceTotals = (db: SqlDriver, id: string) => {
  const rows = db.exec('SELECT snapshot FROM "erp_cnab__billing_title" WHERE remittance_id=?', id).rows;
  return { count: rows.length, total: rows.reduce((s, b) => s + big(txt(parse(b.snapshot), "title", "amountCents")), 0n) };
};

export function erpCnabRemittancePage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  access(db, user);
  financePermission(db, user, "financas.remessas");
  const { query, page, limit, from, to } = pageArgs(a);
  const base = db
    .exec(
      `SELECT r.*, p.identity FROM (SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance") r JOIN "erp_cnab__profile" p ON p.id=r.profile_id
       WHERE (? IS NULL OR r.generated_on>=?) AND (? IS NULL OR r.generated_on<=?)`,
      from,
      from,
      to,
      to,
    )
    .rows.map((row) => ({ r: toRemittance(row), bank: txt(parse(row.identity), "bank") }))
    .map((x) => ({ ...x, filename: remittanceFilename(x.r.snapshot, x.r.sequence) }));
  const filtered = base.filter(({ r, filename }) => {
    if (query === null) return true;
    const digits = ltrimZeros(query);
    return pgLower(filename).includes(query) || (digits !== "" && r.sequence.includes(digits));
  });
  filtered.sort(
    (x, y) =>
      (x.r.generated_on < y.r.generated_on ? 1 : x.r.generated_on > y.r.generated_on ? -1 : 0) ||
      (BigInt(x.r.sequence) < BigInt(y.r.sequence) ? 1 : BigInt(x.r.sequence) > BigInt(y.r.sequence) ? -1 : 0) ||
      (x.r.id < y.r.id ? -1 : x.r.id > y.r.id ? 1 : 0),
  );
  const items = filtered.slice((page - 1) * limit, page * limit).map(({ r, bank, filename }) => {
    const t = remittanceTotals(db, r.id);
    return {
      id: r.id,
      profile_id: r.profile_id,
      purpose: r.purpose,
      state: r.state,
      sequence: r.sequence,
      generated_on: r.generated_on,
      created_at: ts(r.created_at),
      filename,
      bank,
      bank_name: bankLabel(bank),
      titles: t.count,
      total_cents: t.total.toString(),
      file_hash: r.file_hash,
      byte_size: r.byte_size,
      encoding_profile: get(r.snapshot, "encoding_profile"),
      excludable: r.state === "reserved" && r.object_path === null,
    };
  });
  return { entity: "cnab_remittances", page, limit, total: filtered.length, items, data_mode: "erp_native" };
}

export function erpCnabRemittanceDetail(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  access(db, user);
  financePermission(db, user, "financas.remessas");
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=?`, uuid(a, "p_id"));
  if (!row) raise("P0002", "erp_cnab_not_found");
  const r = toRemittance(row!);
  const p = profileRow(db, r.profile_id)!;
  const bank = txt(p.identity, "bank");
  const t = remittanceTotals(db, r.id);
  const titles = db
    .exec(
      `SELECT b.id, b.title_id, b.our_number, b.document_number, b.snapshot, t.description, c.name FROM "erp_cnab__billing_title" b
       JOIN "erp_finance__title" t ON t.id=b.title_id JOIN "erp_catalog__record" c ON c.id=t.contact_id WHERE b.remittance_id=?`,
      r.id,
    )
    .rows.map((b) => ({ b, s: parse(b.snapshot) }))
    .map(({ b, s }) => ({ b, s, due: txt(s, "title", "dueOn") }))
    .sort(
      (x, y) =>
        pgCompareDate(x.due, y.due) || pgCompareText(String(x.b.document_number), String(y.b.document_number)) || (String(x.b.id) < String(y.b.id) ? -1 : String(x.b.id) > String(y.b.id) ? 1 : 0),
    )
    .slice(0, 500)
    .map(({ b, s }) => ({
      billing_title_id: b.id,
      title_id: b.title_id,
      contact_name: pgLeft(txt(s, "title", "payer", "name") ?? String(b.name), 200),
      our_number: b.our_number,
      document_number: b.document_number,
      issued_on: txt(s, "title", "issuedOn"),
      due_on: txt(s, "title", "dueOn"),
      description: b.description,
      amount_cents: txt(s, "title", "amountCents"),
    }));
  const accountName = one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', p.account_id);
  return {
    entity: "cnab_remittance",
    record: {
      id: r.id,
      profile_id: r.profile_id,
      purpose: r.purpose,
      state: r.state,
      sequence: r.sequence,
      generated_on: r.generated_on,
      created_at: ts(r.created_at),
      filename: remittanceFilename(r.snapshot, r.sequence),
      file_hash: r.file_hash,
      byte_size: r.byte_size,
      encoding_profile: get(r.snapshot, "encoding_profile"),
      bank,
      bank_name: bankLabel(bank),
      excludable: r.state === "reserved" && r.object_path === null,
    },
    account: {
      bank,
      bank_name: bankLabel(bank),
      agency: txt(p.identity, "agency"),
      account: txt(p.identity, "account"),
      account_digit: txt(p.identity, "accountDigit"),
      wallet: txt(p.identity, "wallet"),
      name: accountName ? accountName.name : null,
    },
    titles,
    titles_total: t.count,
    total_cents: t.total.toString(),
    data_mode: "erp_native",
  };
}

/** Ordem de (x)::date, nulos por último (ORDER BY ascendente do Postgres). */
const pgCompareDate = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);

export function erpCnabRemittanceCandidates(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const today = todaySaoPaulo();
  const q = text(a, "p_query");
  const query = searchTerm(q);
  const method = uuid(a, "p_payment_method_id");
  const account = uuid(a, "p_account_id");
  const without = bool(a, "p_without_account");
  const after = uuid(a, "p_after");
  const limit = int(a, "p_limit");
  access(db, uuid(a, "p_user_id"));
  if (without === null || limit === null || limit < 1 || limit > 15 || (q !== null && (pgLength(q) > 120 || pgHasCntrl.test(q)))) invalidQuery();
  if (method !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__payment_method" WHERE id=? AND deleted_at IS NULL', method)) invalidQuery();
  if (account !== null && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=?', account)) invalidQuery();
  const named = db
    .exec(
      `SELECT t.id, t.version, t.description, CAST(t.amount_cents AS TEXT) amount_cents, CAST(t.settled_cents AS TEXT) settled_cents, t.issued_on, t.due_on, t.cancelled,
         t.account_id, t.payment_method_id, r.name contact_name, r.active, c.person_type
       FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id JOIN "erp_catalog__contact" c ON c.record_id=r.id
       WHERE t.kind='receivable' AND t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents=0 AND t.amount_cents BETWEEN 1 AND 9999999999999
         AND t.issued_on<=? AND t.due_on>=?
         AND NOT EXISTS(SELECT 1 FROM "erp_cnab__billing_title" b WHERE b.title_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM "erp_finance__origin_import_origin" o WHERE o.title_id=t.id)
         AND (? IS NULL OR t.payment_method_id=?)
         AND (? IS NULL OR t.account_id=? OR (?=1 AND t.account_id IS NULL))
         AND (? IS NOT NULL OR ?=1 OR t.account_id IS NOT NULL)
       ORDER BY t.id`,
      today,
      today,
      method,
      method,
      account,
      account,
      without ? 1 : 0,
      account,
      without ? 1 : 0,
    )
    .rows.filter((t) => query === null || pgLower(`${t.description} ${t.contact_name}`).includes(query));
  const page = named.filter((t) => after === null || String(t.id) > after).slice(0, limit! + 1);
  const shown = page.slice(0, limit!);
  // payer_ready: r.active AND c.person_type IN ('F','J'), com nulo quando o tipo falta e o cadastro está ativo.
  const payerReady = (active: unknown, type: unknown) => (Number(active) !== 1 ? false : type === null ? null : type === "F" || type === "J");
  const items = shown.map((t) => ({
    id: t.id,
    version: Number(t.version),
    kind: "receivable",
    description: t.description,
    contact_name: t.contact_name,
    amount_cents: String(t.amount_cents),
    settled_cents: String(t.settled_cents),
    issued_on: t.issued_on,
    due_on: t.due_on,
    cancelled: Number(t.cancelled) === 1,
    payer_ready: payerReady(t.active, t.person_type),
    account_id: t.account_id ?? null,
    account_name: t.account_id === null ? null : ((n) => (n ? pgLeft(String(n.name), 200) : null))(one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', t.account_id)),
    payment_method_id: t.payment_method_id ?? null,
    payment_method_name:
      t.payment_method_id === null ? null : ((m) => (m ? pgLeft(String(m.description), 200) : null))(one(db, 'SELECT description FROM "erp_catalog__payment_method" WHERE id=?', t.payment_method_id)),
  }));
  const more = page.length > limit!;
  const linked = (m: { account_id: unknown }) => account !== null && m.account_id === account;
  const methods = db
    .exec(`SELECT id, description, active, account_id FROM "erp_catalog__payment_method" WHERE deleted_at IS NULL AND applicable IN ('recebimentos','ambos')`)
    .rows.map((m) => ({ id: String(m.id), description: String(m.description), active: Number(m.active), account_id: m.account_id, key: pgLower(String(m.description)) }))
    .sort((x, y) => pgCompareText(x.key, y.key) || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
    .slice(0, 200)
    .sort(
      (x, y) =>
        Number(linked(y)) - Number(linked(x)) ||
        Number(y.active) - Number(x.active) ||
        pgCompareText(x.key, y.key) ||
        (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0),
    )
    .map((m) => ({ id: m.id, description: pgLeft(String(m.description), 200), active: Number(m.active) === 1, linked: linked(m) }));
  return {
    entity: "titles",
    data_mode: "erp_native",
    operational_effects: false,
    items,
    has_more: more,
    next_cursor: more ? shown[shown.length - 1].id : null,
    eligible_total: named.length,
    remittance_limit: 30,
    filters: { payment_method_id: method, account_id: account, without_account: without },
    payment_methods: methods,
  };
}

interface ReturnFile {
  id: string;
  profile_id: string;
  purpose: string;
  generated_on: string;
  created_at: string;
  file_hash: string;
  record_count: number;
  evidence: unknown;
  identity: unknown;
}
const RETURN_FILE = `SELECT f.id, f.profile_id, f.purpose, f.generated_on, CAST(f.created_at AS TEXT) created_at, f.file_hash, f.record_count, f.evidence, p.identity
  FROM "erp_cnab__return_file" f JOIN "erp_cnab__profile" p ON p.id=f.profile_id
  WHERE NOT EXISTS(SELECT 1 FROM "erp_cnab__return_exclusion" x WHERE x.file_id=f.id)`;
const toReturnFile = (r: Record<string, unknown>): ReturnFile => ({
  id: String(r.id),
  profile_id: String(r.profile_id),
  purpose: String(r.purpose),
  generated_on: String(r.generated_on),
  created_at: String(r.created_at),
  file_hash: String(r.file_hash),
  record_count: Number(r.record_count),
  evidence: parse(r.evidence),
  identity: parse(r.identity),
});

export function erpCnabReturnPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  access(db, user);
  financePermission(db, user, "financas.retornos");
  const { query, page, limit, from, to } = pageArgs(a);
  const filtered = db
    .exec(`${RETURN_FILE} AND (? IS NULL OR f.generated_on>=?) AND (? IS NULL OR f.generated_on<=?)`, from, from, to, to)
    .rows.map(toReturnFile)
    .map((f) => ({ f, filename: `RETORNO_${f.id}.RET`, number: returnNumber(f.evidence) }))
    .filter(({ f, filename, number }) => {
      if (query === null) return true;
      const digits = ltrimZeros(query);
      return pgLower(filename).includes(query) || f.file_hash.startsWith(query) || (number !== null && digits !== "" && ltrimZeros(number) === digits);
    })
    .sort(
      (x, y) =>
        (x.f.generated_on < y.f.generated_on ? 1 : x.f.generated_on > y.f.generated_on ? -1 : 0) ||
        (BigInt(x.f.created_at) < BigInt(y.f.created_at) ? 1 : BigInt(x.f.created_at) > BigInt(y.f.created_at) ? -1 : 0) ||
        (x.f.id < y.f.id ? -1 : x.f.id > y.f.id ? 1 : 0),
    );
  const items = filtered.slice((page - 1) * limit, page * limit).map(({ f, filename, number }) => {
    const bank = txt(f.identity, "bank");
    const total = db
      .exec('SELECT e.payload FROM "erp_cnab__return_occurrence" o JOIN "erp_cnab__return_event" e ON e.id=o.event_id WHERE o.file_id=?', f.id)
      .rows.reduce((s, e) => s + big(txt(parse(e.payload), "amountCents")), 0n);
    return {
      id: f.id,
      profile_id: f.profile_id,
      purpose: f.purpose,
      generated_on: f.generated_on,
      created_at: ts(f.created_at),
      filename,
      bank,
      bank_name: bankLabel(bank),
      number,
      titles: f.record_count - 2,
      total_cents: total.toString(),
      excludable: !returnApplied(db, f.id),
    };
  });
  return { entity: "cnab_returns", page, limit, total: filtered.length, items, data_mode: "erp_native" };
}

export function erpCnabReturnDetail(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  access(db, user);
  financePermission(db, user, "financas.retornos");
  const group = text(a, "p_group");
  const page = int(a, "p_page");
  const limit = int(a, "p_limit");
  if (group === null || !["entries", "settlements", "others"].includes(group) || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100)
    invalidQuery();
  const row = one(db, `${RETURN_FILE} AND f.id=?`, uuid(a, "p_id"));
  if (!row) raise("P0002", "erp_cnab_not_found");
  const f = toReturnFile(row!);
  const ev = db
    .exec(
      `SELECT o.line, o.duplicate, e.id event_id, e.payload, e.billing_title_id FROM "erp_cnab__return_occurrence" o JOIN "erp_cnab__return_event" e ON e.id=o.event_id WHERE o.file_id=?`,
      f.id,
    )
    .rows.map((o) => {
      const p = parse(o.payload);
      return {
        line: Number(o.line),
        duplicate: Number(o.duplicate) === 1,
        event_id: o.event_id,
        billing_title_id: o.billing_title_id as string | null,
        payload: p,
        grp: returnGroup(txt(p, "kind")),
        amount: big(txt(p, "amountCents")),
        paid: big(txt(p, "paidCents")),
        fee: big(txt(p, "adjustments", "fee")),
        interest: big(txt(p, "adjustments", "interest")),
        discount: big(txt(p, "adjustments", "discount")),
      };
    });
  const sum = (xs: typeof ev, k: "amount" | "paid" | "fee" | "interest" | "discount") => xs.reduce((s, x) => s + x[k], 0n).toString();
  const of = (g: string) => ev.filter((x) => x.grp === g);
  const summary = {
    titles: ev.length,
    amount_cents: sum(ev, "amount"),
    amount_with_additions_cents: ev.reduce((s, x) => s + x.amount + x.interest, 0n).toString(),
    entries: of("entries").length,
    entries_cents: sum(of("entries"), "amount"),
    settlements: of("settlements").length,
    settlements_cents: sum(of("settlements"), "paid"),
    others: of("others").length,
    interest_cents: sum(ev, "interest"),
    discount_cents: sum(ev, "discount"),
    fee_cents: sum(ev, "fee"),
  };
  const selected = of(group!).sort((x, y) => x.line - y.line);
  const items = selected.slice((page! - 1) * limit!, page! * limit!).map((v) => {
    const b = v.billing_title_id === null ? undefined : one(db, 'SELECT snapshot FROM "erp_cnab__billing_title" WHERE id=?', v.billing_title_id);
    return {
      line: v.line,
      event_id: v.event_id,
      duplicate: v.duplicate,
      kind: txt(v.payload, "kind"),
      occurrence: txt(v.payload, "occurrence"),
      document_number: txt(v.payload, "documentNumber"),
      our_number: txt(v.payload, "ourNumber"),
      occurrence_date: txt(v.payload, "occurrenceDate"),
      credit_date: txt(v.payload, "creditDate"),
      due_date: txt(v.payload, "dueDate"),
      contact_name: b ? pgLeft(txt(parse(b.snapshot), "title", "payer", "name") ?? "", 200) : null,
      fee_cents: v.fee.toString(),
      interest_cents: v.interest.toString(),
      amount_cents: v.amount.toString(),
      paid_cents: v.paid.toString(),
    };
  });
  const bank = txt(f.identity, "bank");
  return {
    entity: "cnab_return",
    record: {
      id: f.id,
      profile_id: f.profile_id,
      purpose: f.purpose,
      generated_on: f.generated_on,
      created_at: ts(f.created_at),
      filename: `RETORNO_${f.id}.RET`,
      bank,
      bank_name: bankLabel(bank),
      number: returnNumber(f.evidence),
      excludable: !returnApplied(db, f.id),
    },
    summary,
    group,
    page,
    limit,
    total: selected.length,
    items,
    data_mode: "erp_native",
  };
}

registerRpc("erp_cnab_remittance_page", erpCnabRemittancePage);
registerRpc("erp_cnab_remittance_detail", erpCnabRemittanceDetail);
registerRpc("erp_cnab_remittance_candidates", erpCnabRemittanceCandidates);
registerRpc("erp_cnab_return_page", erpCnabReturnPage);
registerRpc("erp_cnab_return_detail", erpCnabReturnDetail);
