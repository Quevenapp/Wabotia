// DRE gerencial (Vinki, sem função no oráculo): erp_finance_dre lê o período
// pelo regime de caixa (baixas e lançamentos de caixa, pela data) ou de
// competência (contas e lançamentos de caixa, pela competência), agrupa pelas
// categorias financeiras do primeiro nível (grupo de DRE) e compara com o
// período anterior; com p_args.category_id, o detalhe da categoria até a
// conta. erp_finance_dre_cost_set marca a categoria de despesa que entra em
// Custos (tabela do motor erp_finance__dre_cost, versão 21). Uma consulta por
// fonte, com limite: nada de composições por linha.
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { validDate } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { categoryRow, cnabPlanForSettlement, cmpText, insertAudit, insertCommand, jsonArg, pgLower, replayed, requestHash, requireAccess, updateCategory, uuidArg } from "../internal.ts";
import { left } from "../titles.ts";

/** Linhas por fonte; acima disso o período é grande demais para uma leitura. */
export const DRE_SOURCE_LIMIT = 50000;
export const DRE_GROUPS = [
  "gross_revenue", "revenue_deductions", "costs", "operating_expenses", "financial_revenue", "financial_expenses",
  "other_revenue", "other_expenses", "income_taxes",
] as const;
export type DreGroup = (typeof DRE_GROUPS)[number] | "unclassified" | "none";
/** Subtotais: chave e os grupos somados (com sinal: receitas positivas, despesas negativas). */
export const DRE_LINES: readonly { key: string; groups: readonly DreGroup[] }[] = [
  { key: "net_revenue", groups: ["gross_revenue", "revenue_deductions"] },
  { key: "gross_profit", groups: ["gross_revenue", "revenue_deductions", "costs"] },
  { key: "operating_result", groups: ["gross_revenue", "revenue_deductions", "costs", "operating_expenses"] },
  { key: "financial_result", groups: ["financial_revenue", "financial_expenses"] },
  { key: "other_result", groups: ["other_revenue", "other_expenses"] },
  { key: "before_taxes", groups: DRE_GROUPS.filter((g) => g !== "income_taxes") },
  { key: "net_result", groups: DRE_GROUPS },
];

const DAY = 86400000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
const lastOfMonth = (y: number, m: number) => iso(Date.UTC(y, m + 1, 0));
const invalid = (): never => raise("22023", "erp_finance_invalid_query");

/** Período anterior: meses inteiros andam em meses (mês, trimestre, ano); o resto, o mesmo número de dias. */
export function previousPeriod(from: string, to: string) {
  const f = new Date(ms(from)), t = new Date(ms(to));
  if (from.endsWith("-01") && to === lastOfMonth(t.getUTCFullYear(), t.getUTCMonth())) {
    const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
    return { from: iso(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - months, 1)), to: iso(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0)) };
  }
  const days = Math.round((ms(to) - ms(from)) / DAY) + 1;
  return { from: iso(ms(from) - days * DAY), to: iso(ms(from) - DAY) };
}

const dateArg = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "1900-01-01" || v > "2100-12-31") invalid();
  return v as string;
};
const intArg = (v: unknown, fallback: number, min: number, max: number) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) invalid();
  return v as number;
};

export interface DreArgs { from: string; to: string; basis: "cash" | "competence"; compare: boolean; category: string | null; page: number; limit: number }
export function dreArgs(raw: unknown): DreArgs {
  const a = jsonArg(raw ?? {});
  if (jsonType(a) !== "object") invalid();
  const o = a as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["from", "to", "basis", "compare", "category_id", "page", "limit"].includes(k))) invalid();
  const from = dateArg(o.from), to = dateArg(o.to);
  if (from > to || (ms(to) - ms(from)) / DAY > 1100) invalid();
  if (!["cash", "competence"].includes(o.basis as string)) invalid();
  if (o.compare !== undefined && typeof o.compare !== "boolean") invalid();
  let category: string | null = null;
  if (o.category_id !== undefined && o.category_id !== null) category = o.category_id === "none" ? "none" : uuidArg(o.category_id);
  return { from, to, basis: o.basis as DreArgs["basis"], compare: o.compare !== false, category, page: intArg(o.page, 1, 1, 100000), limit: intArg(o.limit, 50, 1, 100) };
}

/** Uma parte do resultado: a categoria, o valor com sinal (entrada positiva) e a origem (para o detalhe). */
export interface DrePart { category_id: string | null; amount: number; on: string; source: "settlement" | "reversal" | "entry" | "title"; ref: string; title_id: string | null; description: string; contact_id: string | null }

const tooMany = (rows: Row[]) => { if (rows.length > DRE_SOURCE_LIMIT) raise("54000", "erp_finance_dre_limit"); return rows; };

/** Regime de caixa: as baixas (principal, juros, multa, desconto e taxa nas categorias gravadas na baixa) e os lançamentos de caixa. */
function cashParts(db: SqlDriver, from: string, to: string): DrePart[] {
  const out: DrePart[] = [];
  const settlements = tooMany(db.exec(
    `SELECT s.id, s.kind, s.reverses_id, s.posted_on, s.principal_cents, s.interest_cents, s.penalty_cents, s.discount_cents, s.fee_cents,
       t.id title_id, t.kind tkind, t.category_id tcat, t.description, t.contact_id,
       (SELECT i.category_id FROM "erp_finance__bordero_item" i WHERE i.settlement_id=coalesce(s.reverses_id, s.id) LIMIT 1) icat,
       (SELECT b.category_id FROM "erp_finance__bordero_item" i JOIN "erp_finance__bordero" b ON b.id=i.bordero_id WHERE i.settlement_id=coalesce(s.reverses_id, s.id) LIMIT 1) bcat,
       c.interest_category_id, c.penalty_category_id, c.discount_category_id, c.fee_category_id
     FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id
       JOIN "erp_finance__account" a ON a.id=s.account_id AND a.deleted_at IS NULL
       LEFT JOIN "erp_finance__settlement_category" c ON c.settlement_id=coalesce(s.reverses_id, s.id)
     WHERE s.posted_on>=? AND s.posted_on<=? LIMIT ${DRE_SOURCE_LIMIT + 1}`,
    from, to,
  ).rows);
  for (const s of settlements) {
    const sign = s.kind === "reversal" ? -1 : 1, receivable = s.tkind === "receivable";
    const principal = (s.icat ?? s.bcat ?? s.tcat ?? null) as string | null;
    const base = { on: String(s.posted_on), source: (s.kind === "reversal" ? "reversal" : "settlement") as DrePart["source"], ref: String(s.id), title_id: String(s.title_id), description: String(s.description), contact_id: (s.contact_id as string | null) ?? null };
    const v = (k: string) => Number(s[k]);
    const push = (category: unknown, amount: number) => { if (amount !== 0) out.push({ ...base, category_id: (category as string | null) ?? principal, amount }); };
    push(principal, sign * (receivable ? v("principal_cents") : -v("principal_cents")));
    if (v("interest_cents") > 0) push(s.interest_category_id, sign * (receivable ? v("interest_cents") : -v("interest_cents")));
    if (v("penalty_cents") > 0) push(s.penalty_category_id, sign * (receivable ? v("penalty_cents") : -v("penalty_cents")));
    if (v("discount_cents") > 0) push(s.discount_category_id, sign * (receivable ? -v("discount_cents") : v("discount_cents")));
    if (v("fee_cents") > 0) {
      const plan = s.fee_category_id === null ? cnabPlanForSettlement(db, String(s.reverses_id ?? s.id)) : null;
      push(s.fee_category_id ?? (plan?.category_id as string | null | undefined) ?? principal, -sign * v("fee_cents"));
    }
  }
  return [...out, ...entryParts(db, "posted_on", from, to)];
}

/** Lançamentos de caixa (fora das transferências), com a categoria do último movimento não compensado. */
function entryParts(db: SqlDriver, column: "posted_on" | "competence_on", from: string, to: string): DrePart[] {
  return tooMany(db.exec(
    `SELECT e.id, e.kind, e.amount_cents, e.${column} d, e.note, e.contact_id,
       (SELECT m.category_id FROM "erp_finance__movement" m WHERE m.entry_id=e.id AND m.kind='entry'
          AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" x WHERE x.compensates_id=m.id) ORDER BY m.created_at DESC LIMIT 1) cat
     FROM "erp_finance__cash_entry" e JOIN "erp_finance__account" a ON a.id=e.account_id AND a.deleted_at IS NULL
     WHERE e.deleted_at IS NULL AND e.${column}>=? AND e.${column}<=? LIMIT ${DRE_SOURCE_LIMIT + 1}`,
    from, to,
  ).rows).map((e) => ({
    category_id: (e.cat as string | null) ?? null, amount: e.kind === "in" ? Number(e.amount_cents) : -Number(e.amount_cents), on: String(e.d),
    source: "entry" as const, ref: String(e.id), title_id: null, description: String(e.note ?? "Lançamento de caixa"), contact_id: (e.contact_id as string | null) ?? null,
  }));
}

/** Regime de competência: as contas (não canceladas nem excluídas) pela competência e os lançamentos de caixa pela competência. */
function competenceParts(db: SqlDriver, from: string, to: string): DrePart[] {
  const titles = tooMany(db.exec(
    `SELECT id, kind, category_id, competence_on, amount_cents, description, installment, installments, contact_id FROM "erp_finance__title"
     WHERE cancelled=0 AND deleted_at IS NULL AND competence_on>=? AND competence_on<=? LIMIT ${DRE_SOURCE_LIMIT + 1}`,
    from, to,
  ).rows).map((t) => ({
    category_id: (t.category_id as string | null) ?? null, amount: (t.kind === "receivable" ? 1 : -1) * Number(t.amount_cents), on: String(t.competence_on),
    source: "title" as const, ref: String(t.id), title_id: String(t.id),
    description: Number(t.installments) > 1 ? `${t.description} ${t.installment}/${t.installments}` : String(t.description), contact_id: (t.contact_id as string | null) ?? null,
  }));
  return [...titles, ...entryParts(db, "competence_on", from, to)];
}

export const dreParts = (db: SqlDriver, basis: DreArgs["basis"], from: string, to: string) =>
  basis === "cash" ? cashParts(db, from, to) : competenceParts(db, from, to);

interface CategoryInfo { id: string; name: string; path: string; kind: string; group: DreGroup; deleted: boolean }
/** As categorias (uma leitura) com o grupo do primeiro nível; Custos pela tabela do motor. */
export function dreCategories(db: SqlDriver): Map<string, CategoryInfo> {
  const rows = new Map(db.exec('SELECT id, name, kind, parent_id, dre_group, deleted_at FROM "erp_finance__category"').rows.map((r) => [String(r.id), r]));
  const costs = new Set(db.exec('SELECT category_id FROM "erp_finance__dre_cost"').rows.map((r) => String(r.category_id)));
  const out = new Map<string, CategoryInfo>();
  for (const [id, r] of rows) {
    const chain: Row[] = [r];
    for (let p = r; p.parent_id !== null && rows.has(String(p.parent_id)) && chain.length < 10; ) chain.unshift((p = rows.get(String(p.parent_id))!));
    const top = chain[0];
    const group: DreGroup = top.kind === "payable" && costs.has(String(top.id)) ? "costs" : ((top.dre_group as DreGroup | null) ?? "unclassified");
    out.set(id, { id, name: String(r.name), path: chain.map((c) => String(c.name)).join(" › "), kind: String(r.kind), group, deleted: r.deleted_at !== null });
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/** O DRE de duas listas de partes (período e anterior): grupos com categorias, subtotais e as fora do DRE. */
export function dreSummary(categories: Map<string, CategoryInfo>, current: DrePart[], previous: DrePart[] | null) {
  type Acc = { category_id: string | null; name: string; path: string; group: DreGroup; amount: number; previous: number; deleted: boolean };
  const acc = new Map<string, Acc>();
  const add = (p: DrePart, which: "amount" | "previous") => {
    const key = p.category_id ?? "none";
    let a = acc.get(key);
    if (!a) {
      const c = p.category_id === null ? undefined : categories.get(p.category_id);
      a = { category_id: p.category_id, name: c?.name ?? "Sem categoria", path: c?.path ?? "Sem categoria", group: c?.group ?? "unclassified", amount: 0, previous: 0, deleted: c?.deleted ?? false };
      acc.set(key, a);
    }
    a[which] += p.amount;
  };
  for (const p of current) add(p, "amount");
  for (const p of previous ?? []) add(p, "previous");
  const rows = [...acc.values()].filter((a) => a.amount !== 0 || a.previous !== 0)
    .sort((x, y) => cmpText(pgLower(x.path), pgLower(y.path)) || cmpText(x.category_id ?? "", y.category_id ?? ""));
  const view = (a: Acc) => ({ category_id: a.category_id, name: left(a.name, 200), path: left(a.path, 400), deleted: a.deleted, amount_cents: String(a.amount), previous_cents: previous ? String(a.previous) : null });
  const total = (gs: readonly DreGroup[], k: "amount" | "previous") => sum(rows.filter((r) => gs.includes(r.group)).map((r) => r[k]));
  const groups = DRE_GROUPS.map((key) => ({
    key, amount_cents: String(total([key], "amount")), previous_cents: previous ? String(total([key], "previous")) : null,
    categories: rows.filter((r) => r.group === key).map(view),
  }));
  const lines = DRE_LINES.map((l) => ({ key: l.key, amount_cents: String(total(l.groups, "amount")), previous_cents: previous ? String(total(l.groups, "previous")) : null }));
  const pick = (g: DreGroup) => ({ amount_cents: String(total([g], "amount")), previous_cents: previous ? String(total([g], "previous")) : null, categories: rows.filter((r) => r.group === g).map(view) });
  return { groups, lines, unclassified: pick("unclassified"), hidden: pick("none") };
}

export function erpFinanceDre(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const role = requireAccess(db, user, false);
  // { costs: true }: só as categorias marcadas como Custos (para a tela de categorias).
  const raw = jsonArg(a.p_args ?? {});
  if (jsonType(raw) === "object" && (raw as Record<string, unknown>).costs === true && Object.keys(raw).length === 1)
    return { scope: "finance_dre", data_mode: "erp_native", role, entity: "dre_costs", category_ids: db.exec('SELECT category_id FROM "erp_finance__dre_cost" ORDER BY category_id').rows.map((r) => String(r.category_id)) };
  const args = dreArgs(raw);
  if (!permitted(db, user, "financas.caixas_bancos.dre")) raise("42501", "erp_finance_permission_denied");
  const categories = dreCategories(db);
  const base = { scope: "finance_dre", data_mode: "erp_native", role, basis: args.basis, from: args.from, to: args.to };
  if (args.category !== null) {
    // Detalhe: o que formou o valor da categoria no período, até a conta.
    if (args.category !== "none" && !categories.has(args.category)) raise("P0002", "erp_finance_not_found");
    const parts = dreParts(db, args.basis, args.from, args.to).filter((p) => (p.category_id ?? "none") === args.category)
      .sort((x, y) => cmpText(x.on, y.on) || cmpText(x.ref, y.ref));
    const page = parts.slice((args.page - 1) * args.limit, args.page * args.limit);
    const names = new Map<string, string>();
    const contacts = [...new Set(page.map((p) => p.contact_id).filter((c): c is string => c !== null))];
    if (contacts.length) for (const r of db.exec(`SELECT id, name FROM "erp_catalog__record" WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(contacts)).rows) names.set(String(r.id), String(r.name));
    const c = args.category === "none" ? null : categories.get(args.category)!;
    return {
      ...base, entity: "dre_category_detail", category: { id: c?.id ?? null, name: c ? left(c.name, 200) : "Sem categoria", path: c ? left(c.path, 400) : "Sem categoria", group: c?.group ?? "unclassified" },
      page: args.page, limit: args.limit, total: parts.length, amount_cents: String(sum(parts.map((p) => p.amount))),
      items: page.map((p) => ({ source: p.source, id: p.ref, title_id: p.title_id, on: p.on, description: left(p.description, 240), contact_name: p.contact_id ? left(names.get(p.contact_id) ?? "", 200) || null : null, amount_cents: String(p.amount) })),
    };
  }
  const previous = args.compare ? previousPeriod(args.from, args.to) : null;
  const summary = dreSummary(categories, dreParts(db, args.basis, args.from, args.to), previous ? dreParts(db, args.basis, previous.from, previous.to) : null);
  return { ...base, entity: "dre", previous, ...summary };
}

/** Marca (ou desmarca) a categoria de despesa do primeiro nível como Custos no DRE; marcar grava Despesas Operacionais como grupo dela. */
export function erpFinanceDreCostSet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const id = uuidArg(a.p_category_id);
  const cost = a.p_cost;
  requireAccess(db, user, true);
  if (command === null || id === null || typeof cost !== "boolean") raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, "category_dre_cost", { id, cost });
  const replay = replayed(db, command!, user, hash);
  if (replay) return replay;
  const category = categoryRow(db, id!);
  if (!category || category.deleted_at !== null) raise("P0002", "erp_finance_not_found");
  if (category!.kind !== "payable" || category!.parent_id !== null) raise("22023", "erp_finance_dre_cost_top_payable");
  const before = { id, cost: !!one(db, 'SELECT 1 x FROM "erp_finance__dre_cost" WHERE category_id=?', id), dre_group: category!.dre_group };
  if (cost) {
    if (category!.dre_group !== "operating_expenses") updateCategory(ctx, id!, { dre_group: "operating_expenses" });
    db.exec('INSERT INTO "erp_finance__dre_cost"(category_id, actor, updated_at) VALUES(?,?,?) ON CONFLICT(category_id) DO UPDATE SET actor=excluded.actor, updated_at=excluded.updated_at', id, user, ctx.clock.next().toString());
  } else db.exec('DELETE FROM "erp_finance__dre_cost" WHERE category_id=?', id);
  const after = categoryRow(db, id!)!;
  const result = { entity: "dre_cost", action: "category_dre_cost", record: { id, cost, dre_group: after.dre_group, version: after.version }, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command!, user, hash, result);
  insertAudit(ctx, user, command!, "category_dre_cost", before, result);
  return result;
}

registerRpc("erp_finance_dre", erpFinanceDre);
registerRpc("erp_finance_dre_cost_set", erpFinanceDreCostSet);
