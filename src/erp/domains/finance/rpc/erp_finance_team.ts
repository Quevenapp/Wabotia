// Pagamento da equipe (Wabotia, sem função no oráculo; tabela do motor
// erp_finance__team_payment, versão 21):
// - erp_finance_team_people: funcionários do cadastro e vendedores, com o
//   contato que recebe a conta a pagar (o do vendedor; o do funcionário é o
//   contato com o mesmo CPF);
// - erp_finance_team_pay: lança salário, comissão, adiantamento ou vale como
//   conta a pagar na categoria própria (Pessoal e equipe › Salários, …), com
//   a pessoa e o período ligados; na comissão, refaz a conta das vendas e
//   recusa valor diferente do conferido;
// - erp_finance_team_report: o que foi lançado por pessoa no período;
// - erp_finance_team_commission: comissão de cada vendedor pelas vendas
//   faturadas no período e o percentual do cadastro do vendedor.
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo, validDate } from "../../../engine/time.ts";
import { formatScaled, toScaled } from "../../../engine/dec.ts";
import { permitted } from "../../access/public.ts";
import {
  cents, cmpText, day, field, insertAudit, insertCategory, insertCommand, jsonArg, jsonBytes, keys, pgLower, replayed, requestHash,
  requireAccess, txt, uuidArg, uuidValue,
} from "../internal.ts";
import { activeAccount, activeContact, insertTitle, left } from "../titles.ts";
import { roundDiv } from "../commissions.ts";

export const TEAM_PAY_KINDS = ["salario", "comissao", "adiantamento", "vale"] as const;
export type TeamPayKind = (typeof TEAM_PAY_KINDS)[number];
/** Categoria própria: o primeiro nível e uma subcategoria por tipo. */
export const TEAM_CATEGORY = "Pessoal e equipe";
export const TEAM_SUBCATEGORIES: Readonly<Record<TeamPayKind, string>> = { salario: "Salários", comissao: "Comissões", adiantamento: "Adiantamentos", vale: "Vales" };
const KIND_LABEL: Readonly<Record<TeamPayKind, string>> = { salario: "Salário", comissao: "Comissão", adiantamento: "Adiantamento", vale: "Vale" };
/** Pedidos por consulta da comissão; acima disso, o período é grande demais. */
export const COMMISSION_ORDER_LIMIT = 20000;

/** Percentual do vendedor (decimal de 4 casas) em texto "5.0000", ou null. */
const rateText = (v: unknown) => (v === null || v === undefined ? null : formatScaled(toScaled(String(v), 4), 4));
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
const brMonth = (d: string) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;
const invalid = (): never => raise("22023", "erp_finance_invalid_query");
const dateArg = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "1900-01-01" || v > "2100-12-31") invalid();
  return v as string;
};
function argsOf(raw: unknown, allowed: readonly string[]) {
  const a = jsonArg(raw ?? {});
  if (jsonType(a) !== "object" || jsonBytes(a) > 8192 || Object.keys(a as object).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, unknown>;
}
const period = (o: Record<string, unknown>, maxDays = 400) => {
  const from = dateArg(o.from), to = dateArg(o.to);
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > maxDays) invalid();
  return { from, to };
};

/** Contatos ativos pelo CPF/CNPJ (só dígitos), numa consulta. */
function contactsByDocument(db: SqlDriver, docs: string[]) {
  const out = new Map<string, { id: string; name: string }>();
  if (!docs.length) return out;
  for (const r of db.exec(
    `SELECT c.record_id id, r.name, c.document FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id
     WHERE r.active=1 AND replace(replace(replace(replace(coalesce(c.document,''),'.',''),'-',''),'/',''),' ','') IN (SELECT value FROM json_each(?))
     ORDER BY r.name, c.record_id`,
    JSON.stringify(docs),
  ).rows) if (!out.has(digits(r.document))) out.set(digits(r.document), { id: String(r.id), name: String(r.name) });
  return out;
}

interface Person { kind: "employee" | "seller"; id: string; name: string; contact_id: string | null; contact_name: string | null; active: boolean; rate: string | null; salary_cents: string | null; job_title: string | null }
function people(db: SqlDriver, showSalary: boolean): Person[] {
  const employees = db.exec('SELECT id, name, cpf, job_title, salary, situation FROM "erp_catalog__employee" ORDER BY name, id LIMIT 2000').rows;
  const byDoc = contactsByDocument(db, [...new Set(employees.map((e) => digits(e.cpf)).filter((d) => d.length >= 11))]);
  const sellers = db.exec(
    `SELECT s.id, s.contact_id, r.name, r.active, CAST(s.commission_rate AS TEXT) commission_rate FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id ORDER BY r.name, s.id LIMIT 2000`,
  ).rows;
  return [
    ...employees.map((e) => {
      const c = byDoc.get(digits(e.cpf)) ?? null;
      return {
        kind: "employee" as const, id: String(e.id), name: left(String(e.name), 200), contact_id: c?.id ?? null, contact_name: c ? left(c.name, 200) : null,
        active: e.situation === "ativo", rate: null, salary_cents: showSalary && e.salary !== null ? String(e.salary) : null, job_title: (e.job_title as string | null) ?? null,
      };
    }),
    ...sellers.map((s) => ({
      kind: "seller" as const, id: String(s.id), name: left(String(s.name), 200), contact_id: String(s.contact_id), contact_name: left(String(s.name), 200),
      active: Number(s.active) === 1, rate: rateText(s.commission_rate), salary_cents: null, job_title: "Vendedor",
    })),
  ].sort((x, y) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(x.kind, y.kind) || cmpText(x.id, y.id));
}

/** A categoria própria do tipo (Pessoal e equipe › Salários, …), criada na primeira vez. */
export function teamCategory(ctx: RpcContext, kind: TeamPayKind): string {
  const db = ctx.db;
  const find = (parent: string | null, name: string) =>
    db.exec('SELECT id, name, active FROM "erp_finance__category" WHERE kind=\'payable\' AND deleted_at IS NULL AND parent_id IS ? ORDER BY created_at, id', parent)
      .rows.find((r) => pgLower(String(r.name)) === pgLower(name));
  const top = find(null, TEAM_CATEGORY);
  if (top && Number(top.active) !== 1) raise("40001", "erp_finance_team_category_inactive");
  const topId = top ? String(top.id) : insertCategory(ctx, { name: TEAM_CATEGORY, kind: "payable", parent_id: null, dre_group: "operating_expenses" });
  const sub = find(topId, TEAM_SUBCATEGORIES[kind]);
  if (sub && Number(sub.active) !== 1) raise("40001", "erp_finance_team_category_inactive");
  return sub ? String(sub.id) : insertCategory(ctx, { name: TEAM_SUBCATEGORIES[kind], kind: "payable", parent_id: topId, dre_group: null });
}

interface CommissionRow { seller_id: string; orders: { id: string; number: number; on: string; base: bigint; invoiced: boolean }[]; base: bigint }
/** Vendas faturadas por vendedor (body.seller_id): pedidos de venda atendidos ou com nota fiscal, pela data do pedido; a base é a soma dos itens (sem frete). */
export function commissionSales(ctx: RpcContext, from: string, to: string, seller: string | null): Map<string, CommissionRow> {
  const fiscal = ctx.parts.fiscal;
  const rows = ctx.db.exec(
    `SELECT d.id, d.number, d.status, d.body ->> 'seller_id' seller, d.body ->> 'date' day,
       (SELECT CAST(coalesce(sum(i.total),0) AS TEXT) FROM "erp_documents__item" i WHERE i.document_id=d.id) items,
       ${fiscal ? `EXISTS(SELECT 1 FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" v ON v.id=o.invoice_id WHERE o.document_id=d.id AND v.deleted_at IS NULL)` : "0"} invoiced
     FROM "erp_documents__document" d WHERE d.authority='brufap' AND d.kind='sales_orders' AND d.deleted_at IS NULL AND d.status<>'cancelled'
       AND (d.body ->> 'date')>=? AND (d.body ->> 'date')<=? AND (? IS NULL OR (d.body ->> 'seller_id')=?) LIMIT ${COMMISSION_ORDER_LIMIT + 1}`,
    from, to, seller, seller,
  ).rows;
  if (rows.length > COMMISSION_ORDER_LIMIT) raise("54000", "erp_finance_team_commission_limit");
  const out = new Map<string, CommissionRow>();
  for (const r of rows) {
    const invoiced = Number(r.invoiced) === 1;
    if (!(invoiced || r.status === "fulfilled") || typeof r.seller !== "string" || !/^[0-9a-f-]{36}$/i.test(r.seller)) continue;
    const id = r.seller.toLowerCase();
    const row = out.get(id) ?? { seller_id: id, orders: [], base: 0n };
    const base = BigInt(String(r.items));
    row.orders.push({ id: String(r.id), number: Number(r.number), on: String(r.day), base, invoiced });
    row.base += base;
    out.set(id, row);
  }
  return out;
}
/** Comissão em centavos: base × percentual (4 casas) ÷ 100, arredondada. */
export const commissionCents = (base: bigint, rate: string) => roundDiv(base * toScaled(rate, 4), 1000000n);

function existingCommissions(db: SqlDriver, from: string, to: string) {
  return db.exec(
    `SELECT p.id, p.seller_id, p.title_id, p.period_from, p.period_to, t.amount_cents, t.cancelled, t.deleted_at FROM "erp_finance__team_payment" p
     JOIN "erp_finance__title" t ON t.id=p.title_id WHERE p.pay_kind='comissao' AND p.period_from<=? AND p.period_to>=?`,
    to, from,
  ).rows.filter((r) => Number(r.cancelled) === 0 && r.deleted_at === null);
}

export function erpFinanceTeamPeople(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const role = requireAccess(db, user, false);
  return {
    scope: "team_people", data_mode: "erp_native", role, kinds: TEAM_PAY_KINDS, items: people(db, role !== "consulta"),
  };
}

export function erpFinanceTeamCommission(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  requireAccess(db, user, false);
  const o = argsOf(a.p_args, ["from", "to", "seller_id"]);
  const { from, to } = period(o);
  const seller = o.seller_id === undefined || o.seller_id === null ? null : uuidArg(o.seller_id);
  if (!permitted(db, user, "vendas.comissoes")) raise("42501", "erp_finance_permission_denied");
  const sales = commissionSales(ctx, from, to, seller);
  const generated = existingCommissions(db, from, to);
  const sellers = db.exec(
    `SELECT s.id, s.contact_id, r.name, r.active, CAST(s.commission_rate AS TEXT) commission_rate FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE (? IS NULL OR s.id=?)`,
    seller, seller,
  ).rows;
  if (seller !== null && !sellers.length) raise("P0002", "erp_finance_not_found");
  const items = sellers.map((s) => {
    const row = sales.get(String(s.id));
    const rate = rateText(s.commission_rate);
    const base = row?.base ?? 0n;
    return {
      seller_id: String(s.id), name: left(String(s.name), 200), contact_id: String(s.contact_id), active: Number(s.active) === 1, rate,
      order_count: row?.orders.length ?? 0, base_cents: String(base), commission_cents: rate === null ? null : String(commissionCents(base, rate)),
      generated: generated.filter((g) => g.seller_id === s.id).map((g) => ({ id: String(g.id), title_id: String(g.title_id), period_from: String(g.period_from), period_to: String(g.period_to), amount_cents: String(g.amount_cents) })),
      orders: seller === null ? [] : (row?.orders ?? []).slice(0, 500).map((x) => ({ id: x.id, number: x.number, on: x.on, base_cents: String(x.base), invoiced: x.invoiced })),
    };
  }).filter((x) => seller !== null || x.order_count > 0 || x.generated.length > 0)
    .sort((x, y) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(x.seller_id, y.seller_id));
  return { scope: "team_commission", data_mode: "erp_native", from, to, fiscal_included: ctx.parts.fiscal, basis: "items_without_freight", items };
}

export function erpFinanceTeamReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  requireAccess(db, user, false);
  const o = argsOf(a.p_args, ["from", "to", "person_kind", "person_id", "pay_kind"]);
  const { from, to } = period(o, 1100);
  if (o.person_kind !== undefined && o.person_kind !== null && !["employee", "seller"].includes(o.person_kind as string)) invalid();
  if (o.pay_kind !== undefined && o.pay_kind !== null && !TEAM_PAY_KINDS.includes(o.pay_kind as TeamPayKind)) invalid();
  const person = o.person_id === undefined || o.person_id === null ? null : uuidArg(o.person_id);
  if (!permitted(db, user, "financas.contas_pagar")) raise("42501", "erp_finance_permission_denied");
  const today = todaySaoPaulo();
  const rows = db.exec(
    `SELECT p.*, t.description, t.due_on, t.amount_cents, t.settled_cents, t.cancelled, t.deleted_at, e.name employee_name, r.name seller_name
     FROM "erp_finance__team_payment" p JOIN "erp_finance__title" t ON t.id=p.title_id
       LEFT JOIN "erp_catalog__employee" e ON e.id=p.employee_id LEFT JOIN "erp_catalog__seller" s ON s.id=p.seller_id LEFT JOIN "erp_catalog__record" r ON r.id=s.contact_id
     WHERE p.period_from<=? AND p.period_to>=? AND (? IS NULL OR p.person_kind=?) AND (? IS NULL OR coalesce(p.employee_id, p.seller_id)=?) AND (? IS NULL OR p.pay_kind=?)
     ORDER BY p.period_from, t.due_on, p.id LIMIT 2001`,
    to, from, o.person_kind ?? null, o.person_kind ?? null, person, person, o.pay_kind ?? null, o.pay_kind ?? null,
  ).rows;
  const truncated = rows.length > 2000;
  const list = rows.slice(0, 2000).filter((r) => r.deleted_at === null);
  const status = (r: Row) => Number(r.cancelled) === 1 ? "cancelled" : Number(r.settled_cents) >= Number(r.amount_cents) ? "paid" : Number(r.settled_cents) > 0 ? "partial" : String(r.due_on) < today ? "overdue" : "open";
  const groups = new Map<string, { person_kind: string; person_id: string; name: string; by_kind: Record<string, number>; total: number; paid: number; open: number }>();
  for (const r of list) {
    if (Number(r.cancelled) === 1) continue;
    const id = String(r.employee_id ?? r.seller_id);
    const g = groups.get(`${r.person_kind}:${id}`) ?? { person_kind: String(r.person_kind), person_id: id, name: left(String(r.employee_name ?? r.seller_name ?? ""), 200), by_kind: {}, total: 0, paid: 0, open: 0 };
    g.by_kind[String(r.pay_kind)] = (g.by_kind[String(r.pay_kind)] ?? 0) + Number(r.amount_cents);
    g.total += Number(r.amount_cents);
    g.paid += Number(r.settled_cents);
    g.open += Number(r.amount_cents) - Number(r.settled_cents);
    groups.set(`${r.person_kind}:${id}`, g);
  }
  return {
    scope: "team_report", data_mode: "erp_native", from, to, truncated,
    people: [...groups.values()].sort((x, y) => cmpText(pgLower(x.name), pgLower(y.name)) || cmpText(x.person_id, y.person_id)).map((g) => ({
      person_kind: g.person_kind, person_id: g.person_id, name: g.name, total_cents: String(g.total), paid_cents: String(g.paid), open_cents: String(g.open),
      by_kind: Object.fromEntries(TEAM_PAY_KINDS.map((k) => [k, String(g.by_kind[k] ?? 0)])),
    })),
    items: list.map((r) => ({
      id: r.id, title_id: r.title_id, person_kind: r.person_kind, person_id: r.employee_id ?? r.seller_id, name: left(String(r.employee_name ?? r.seller_name ?? ""), 200),
      pay_kind: r.pay_kind, period_from: r.period_from, period_to: r.period_to, description: r.description, due_on: r.due_on,
      amount_cents: String(r.amount_cents), settled_cents: String(r.settled_cents), status: status(r), base_cents: r.base_cents === null ? null : String(r.base_cents), rate: r.rate ?? null,
    })),
  };
}

export function erpFinanceTeamPay(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  if (command === null) raise("22023", "erp_finance_invalid_action");
  keys(data, ["person_kind", "person_id", "pay_kind", "amount_cents", "issued_on", "due_on", "competence_on", "period_from", "period_to", "description", "category_id", "account_id"]);
  const hash = requestHash(user, "team_pay", data);
  const replay = replayed(db, command!, user, hash);
  if (replay) return replay;
  const personKind = txt(data, "person_kind", 20, true)!;
  if (!["employee", "seller"].includes(personKind)) raise("22023", "erp_finance_team_invalid_person");
  const personId = uuidValue(field(data, "person_id"))!;
  const payKind = txt(data, "pay_kind", 20, true) as TeamPayKind;
  if (!TEAM_PAY_KINDS.includes(payKind)) raise("22023", "erp_finance_team_invalid_kind");
  if (payKind === "comissao" && personKind !== "seller") raise("22023", "erp_finance_team_commission_seller");
  const amount = cents(field(data, "amount_cents"), false);
  const issued = day(field(data, "issued_on"));
  const due = day(field(data, "due_on"));
  if (due < issued) raise("22023", "erp_finance_invalid_due_date");
  const from = day(field(data, "period_from")), to = day(field(data, "period_to"));
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 400) raise("22023", "erp_finance_team_invalid_period");
  const competence = field(data, "competence_on") === undefined || field(data, "competence_on") === null ? from : day(field(data, "competence_on"));
  // Pessoa e contato que recebe a conta.
  let contact: string, name: string;
  if (personKind === "seller") {
    const s = one(db, 'SELECT s.contact_id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', personId);
    if (!s) raise("P0002", "erp_finance_not_found");
    contact = String(s!.contact_id);
    name = String(s!.name);
  } else {
    const e = one(db, 'SELECT name, cpf FROM "erp_catalog__employee" WHERE id=?', personId);
    if (!e) raise("P0002", "erp_finance_not_found");
    const c = contactsByDocument(db, [digits(e!.cpf)]).get(digits(e!.cpf));
    if (!c) raise("22023", "erp_finance_team_contact_missing");
    contact = c!.id;
    name = String(e!.name);
  }
  if (!activeContact(db, contact)) raise("22023", "erp_finance_team_contact_missing");
  let base: bigint | null = null, rate: string | null = null;
  if (payKind === "comissao") {
    // A comissão conferida: as vendas do período e o percentual de agora precisam dar o mesmo valor.
    rate = rateText(one(db, 'SELECT CAST(commission_rate AS TEXT) commission_rate FROM "erp_catalog__seller" WHERE id=?', personId)?.commission_rate);
    if (rate === null) raise("22023", "erp_finance_team_commission_rate_missing");
    base = commissionSales(ctx, from, to, personId).get(personId)?.base ?? 0n;
    if (commissionCents(base, rate!) !== BigInt(amount)) raise("40001", "erp_finance_team_commission_changed");
    if (existingCommissions(db, from, to).some((g) => g.seller_id === personId)) raise("40001", "erp_finance_team_commission_exists");
  }
  const chosen = uuidValue(field(data, "category_id"), false);
  if (chosen !== null && !one(db, `SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND deleted_at IS NULL AND kind='payable'`, chosen))
    raise("22023", "erp_finance_invalid_category");
  const category = chosen ?? teamCategory(ctx, payKind);
  const account = activeAccount(db, uuidValue(field(data, "account_id"), false));
  const description = txt(data, "description", 240) ?? left(`${KIND_LABEL[payKind]} · ${name} · ${from.slice(0, 7) === to.slice(0, 7) ? brMonth(from) : `${brMonth(from)} a ${brMonth(to)}`}`, 240);
  const title = insertTitle(ctx, {
    group_id: crypto.randomUUID(), installment: 1, installments: 1, kind: "payable", contact_id: contact, category_id: category, description,
    source_reference: left(`Equipe: ${KIND_LABEL[payKind]}`, 200), issued_on: issued, due_on: due, amount_cents: amount, competence_on: competence, account_id: account,
  });
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__team_payment"(id, title_id, person_kind, employee_id, seller_id, pay_kind, period_from, period_to, base_cents, rate, actor, command_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, title, personKind, personKind === "employee" ? personId : null, personKind === "seller" ? personId : null, payKind, from, to,
    base === null ? null : base.toString(), rate, user, command, ctx.clock.next().toString(),
  );
  const result = {
    entity: "titles", action: "team_pay", data_mode: "erp_native", replayed: false,
    record: { id: title, kind: "payable", description, amount_cents: String(amount), due_on: due, category_id: category, contact_id: contact },
    team_payment: { id, person_kind: personKind, person_id: personId, pay_kind: payKind, period_from: from, period_to: to, base_cents: base === null ? null : base.toString(), rate },
  };
  insertCommand(ctx, command!, user, hash, result);
  // title_create: a permissão Contas a pagar › Incluir/editar, como no lançamento comum.
  insertAudit(ctx, user, command!, "title_create", null, result);
  return result;
}

registerRpc("erp_finance_team_people", erpFinanceTeamPeople);
registerRpc("erp_finance_team_commission", erpFinanceTeamCommission);
registerRpc("erp_finance_team_report", erpFinanceTeamReport);
registerRpc("erp_finance_team_pay", erpFinanceTeamPay);
