// Cálculo de IBS, CBS e IS por item (reforma tributária do consumo), sem I/O:
// serve à NF-e (comnfe/taxes.ts), às propostas e pedidos (bloco informativo)
// e ao relatório do contador. Aritmética decimal exata (catalog/pricing/money):
// alíquota efetiva com 4 casas e valores com 2, metade para longe do zero,
// como as calculadoras oficiais da Receita Federal.
//
// Regras:
// - Alíquotas do ano do documento (reform-table.ts, REFORM_YEAR_RATES), ou as
//   que a empresa informou para um ano ainda não publicado.
// - Redução da classificação: alíquota efetiva = alíquota × (1 − redução/100),
//   separada para IBS (estadual e municipal) e CBS.
// - CST de isenção, imunidade ou não incidência: sem base nem valor. CST de
//   regime que o ERP não calcula: só CST e classificação, valores com o contador.
// - Simples Nacional (CRT 1, 2 e 4): não destaca IBS/CBS do regime regular,
//   salvo a opção da empresa pelo regime regular (configuração da reforma).
// - Imposto Seletivo a partir de 2027, pela alíquota do produto; integra a
//   base do IBS e da CBS (EC 132/2023, art. 153, § 6º, IV).
// - Base da NF-e em 2026 (reformBaseFromItem): valor do item com frete,
//   seguro e outras despesas, menos desconto, ICMS, FCP, DIFAL, PIS e COFINS.
import { add, compareNum, mul, neg, num, round, shift, sign, text, type Num } from "../catalog/pricing/money.ts";
import { reformClassEntry, reformCst, reformYearRates, REFORM_FIRST_YEAR, REFORM_LAST_YEAR } from "./reform-table.ts";

export const SIMPLES_CRTS = ["1", "2", "4"];

export interface ReformRateOverride {
  cbs?: string | null;
  ibs_uf?: string | null;
  ibs_mun?: string | null;
}

/** Configuração da reforma da empresa (tabela erp_fiscal_reform__settings). */
export interface ReformCompanySettings {
  /** Empresa do Simples que optou por recolher IBS/CBS pelo regime regular. */
  simples_regular: boolean;
  /** Alíquotas informadas pela empresa por ano ("2027": {...}), em %. */
  rates: Record<string, ReformRateOverride>;
}

export const DEFAULT_REFORM_SETTINGS: ReformCompanySettings = Object.freeze({ simples_regular: false, rates: {} }) as ReformCompanySettings;

export interface ReformClassInput {
  cst: string;
  cclasstrib: string;
  source?: string | null;
}

export interface ReformSelectiveInput {
  cst: string;
  cclasstrib: string;
  /** Alíquota ad valorem em %. */
  rate: string;
}

export interface ReformItemInput {
  item_id?: string | null;
  description?: string | null;
  /** Base antes do IS, texto decimal com até 2 casas. */
  base: string;
  classification: ReformClassInput | null;
  selective?: ReformSelectiveInput | null;
}

export interface ReformContext {
  year: number;
  crt: string | null;
  settings?: ReformCompanySettings | null;
}

export type ReformItemStatus =
  | "calculated"
  | "exempt"
  | "manual"
  | "unclassified"
  | "unknown_class"
  | "class_mismatch"
  | "simples"
  | "rates_unpublished"
  | "out_of_range";

export interface ReformTaxPart {
  /** Alíquota cheia do ano, %. */
  rate: string;
  /** Redução da classificação, %. */
  reduction: string;
  /** Alíquota efetiva, % com 4 casas. */
  effective_rate: string;
  value: string;
}

export interface ReformItemResult {
  item_id: string | null;
  description: string | null;
  status: ReformItemStatus;
  message: string | null;
  cst: string | null;
  cclasstrib: string | null;
  class_description: string | null;
  source: string | null;
  base: string | null;
  cbs: ReformTaxPart | null;
  ibs_uf: ReformTaxPart | null;
  ibs_mun: ReformTaxPart | null;
  ibs: string | null;
  selective: { cst: string; cclasstrib: string; base: string; rate: string; value: string } | null;
}

export interface ReformTotals {
  base: string;
  cbs: string;
  ibs_uf: string;
  ibs_mun: string;
  ibs: string;
  selective: string;
  /** CBS + IBS + IS. */
  total: string;
}

export interface ReformRatesView {
  year: number;
  cbs: string | null;
  ibs_uf: string | null;
  ibs_mun: string | null;
  informative: boolean;
  selective: boolean;
  /** test: alíquotas de teste de 2026; table: da tabela; company: informadas pela empresa; unpublished: faltam. */
  origin: "test" | "table" | "company" | "unpublished";
  note: string;
}

export interface ReformResult {
  year: number;
  regime: "regular" | "simples" | "simples_regular";
  rates: ReformRatesView;
  /** 2026: só informa; não muda o total a pagar. */
  informative: boolean;
  /** O total do documento nunca muda por este cálculo nesta versão. */
  affects_total: false;
  items: ReformItemResult[];
  totals: ReformTotals;
  /** Aviso geral para a tela (Simples, ano sem alíquota, classificação faltando). */
  notices: { code: string; message: string }[];
}

const ZERO = num("0");
const HUNDRED = num("100");
const DECIMAL = /^\d{1,13}(?:\.\d{1,10})?$/;
const RATE = /^\d{1,3}(?:\.\d{1,4})?$/;

const money = (value: Num) => text(round(value, 2));
const percentOf = (base: Num, rate: Num) => round(shift(mul(base, rate), 2), 2);

/** Alíquota efetiva com 4 casas: alíquota × (1 − redução/100). */
export function effectiveRate(rate: string, reduction: string): string {
  const factor = add(HUNDRED, neg(num(reduction)));
  const value = round(shift(mul(num(rate), factor), 2), 4);
  return text(sign(value) < 0 ? ZERO : value);
}

export const validReformRate = (value: unknown): value is string => typeof value === "string" && RATE.test(value) && compareNum(num(value), HUNDRED) <= 0;

/** Alíquotas do ano: as da tabela, completadas pelas que a empresa informou. */
export function reformRatesFor(year: number, settings?: ReformCompanySettings | null): ReformRatesView {
  const table = reformYearRates(Math.min(Math.max(year, REFORM_FIRST_YEAR), REFORM_LAST_YEAR));
  const own = settings?.rates?.[String(year)] ?? {};
  const pick = (key: "cbs" | "ibs_uf" | "ibs_mun") => {
    const value = own[key];
    if (validReformRate(value)) return { value, company: true };
    return { value: table?.[key] ?? null, company: false };
  };
  const cbs = pick("cbs"), uf = pick("ibs_uf"), mun = pick("ibs_mun");
  const complete = cbs.value !== null && uf.value !== null && mun.value !== null;
  const company = cbs.company || uf.company || mun.company;
  const origin: ReformRatesView["origin"] = !complete ? "unpublished" : company ? "company" : year <= 2026 ? "test" : "table";
  return {
    year, cbs: cbs.value, ibs_uf: uf.value, ibs_mun: mun.value,
    informative: year < REFORM_FIRST_YEAR ? true : table?.informative ?? false,
    selective: year >= 2027,
    origin,
    note: year < REFORM_FIRST_YEAR ? "Antes de 2026 não há IBS nem CBS: valores só de simulação, com as alíquotas de teste."
      : table?.note ?? "Fora da transição: confira as alíquotas com o contador.",
  };
}

const part = (base: Num, rate: string, reduction: string): ReformTaxPart => {
  const effective = effectiveRate(rate, reduction);
  return { rate: text(num(rate)), reduction: text(num(reduction)), effective_rate: effective, value: money(percentOf(base, num(effective))) };
};

const empty = (input: ReformItemInput, status: ReformItemStatus, message: string | null, extra: Partial<ReformItemResult> = {}): ReformItemResult => ({
  item_id: input.item_id ?? null, description: input.description ?? null, status, message,
  cst: input.classification?.cst ?? null, cclasstrib: input.classification?.cclasstrib ?? null,
  class_description: input.classification ? reformClassEntry(input.classification.cclasstrib)?.description ?? null : null,
  source: input.classification?.source ?? null, base: null, cbs: null, ibs_uf: null, ibs_mun: null, ibs: null, selective: null, ...extra,
});

export function regimeOf(crt: string | null, settings?: ReformCompanySettings | null): ReformResult["regime"] {
  if (!crt || !SIMPLES_CRTS.includes(crt)) return "regular";
  return settings?.simples_regular ? "simples_regular" : "simples";
}

/** Um item. Valores em texto decimal; nunca ponto flutuante. */
export function calculateReformItem(input: ReformItemInput, context: ReformContext, rates = reformRatesFor(context.year, context.settings)): ReformItemResult {
  if (typeof input.base !== "string" || !DECIMAL.test(input.base) || compareNum(num(input.base), ZERO) < 0)
    return empty(input, "out_of_range", "Valor do item fora do formato: confira o item.");
  const regime = regimeOf(context.crt, context.settings);
  if (regime === "simples")
    return empty(input, "simples", "Empresa do Simples Nacional: IBS e CBS não são destacados pelo regime regular.");
  const classification = input.classification;
  if (!classification) return empty(input, "unclassified", "Item sem classificação de IBS/CBS no produto nem na natureza.");
  const cst = reformCst(classification.cst);
  if (!cst || !/^\d{6}$/.test(classification.cclasstrib)) return empty(input, "unknown_class", `CST ${classification.cst} desconhecido: confira a classificação.`);
  if (!classification.cclasstrib.startsWith(classification.cst))
    return empty(input, "class_mismatch", `A classificação ${classification.cclasstrib} não pertence ao CST ${classification.cst}.`);
  if (cst.kind === "exempt") return empty(input, "exempt", `${cst.description}: sem base nem valor de IBS e CBS.`);
  if (cst.kind === "manual")
    return empty(input, "manual", `${cst.description}: o ERP envia CST e classificação; os valores ficam com o contador.`);
  const entry = reformClassEntry(classification.cclasstrib);
  if (!entry) return empty(input, "unknown_class", `A classificação ${classification.cclasstrib} não está na tabela embutida: o ERP não sabe a redução dela.`);
  if (!rates.cbs || !rates.ibs_uf || !rates.ibs_mun)
    return empty(input, "rates_unpublished", `As alíquotas de ${context.year} ainda não foram publicadas: informe-as na configuração da reforma.`);
  let base = round(num(input.base), 2);
  let selective: ReformItemResult["selective"] = null;
  const is = input.selective;
  if (is && rates.selective && validReformRate(is.rate) && /^\d{3}$/.test(is.cst) && /^\d{6}$/.test(is.cclasstrib)) {
    const value = is.cst === "000" ? percentOf(base, num(is.rate)) : ZERO;
    selective = { cst: is.cst, cclasstrib: is.cclasstrib, base: money(base), rate: text(num(is.rate)), value: money(value) };
    base = add(base, value);
  }
  const cbs = part(base, rates.cbs, entry.cbs_reduction);
  const uf = part(base, rates.ibs_uf, entry.ibs_reduction);
  const mun = part(base, rates.ibs_mun, entry.ibs_reduction);
  return {
    ...empty(input, "calculated", null), class_description: entry.description, base: money(base),
    cbs, ibs_uf: uf, ibs_mun: mun, ibs: money(add(num(uf.value), num(mun.value))), selective,
  };
}

/** O documento: itens, totais e avisos. */
export function calculateReform(items: ReformItemInput[], context: ReformContext): ReformResult {
  const rates = reformRatesFor(context.year, context.settings);
  const results = items.map((item) => calculateReformItem(item, context, rates));
  const sum = (pick: (item: ReformItemResult) => string | null | undefined) =>
    money(results.reduce((acc, item) => { const v = pick(item); return v ? add(acc, num(v)) : acc; }, ZERO));
  const totals: ReformTotals = {
    base: sum((i) => i.base), cbs: sum((i) => i.cbs?.value), ibs_uf: sum((i) => i.ibs_uf?.value), ibs_mun: sum((i) => i.ibs_mun?.value),
    ibs: sum((i) => i.ibs), selective: sum((i) => i.selective?.value), total: "0.00",
  };
  totals.total = money(add(add(num(totals.cbs), num(totals.ibs)), num(totals.selective)));
  const regime = regimeOf(context.crt, context.settings);
  const notices: ReformResult["notices"] = [];
  if (regime === "simples")
    notices.push({ code: "reform_simples", message: "Sua empresa é do Simples Nacional: IBS e CBS não são destacados no documento. Se optou pelo regime regular, marque a opção na configuração da reforma." });
  if (results.some((r) => r.status === "rates_unpublished"))
    notices.push({ code: "reform_rates_unpublished", message: `As alíquotas de ${context.year} ainda não foram publicadas: informe-as na configuração da reforma tributária.` });
  if (results.some((r) => r.status === "unclassified"))
    notices.push({ code: "reform_unclassified", message: "Há itens sem classificação de IBS/CBS: classifique o produto ou ponha um padrão na natureza de operação." });
  if (results.some((r) => r.status === "unknown_class" || r.status === "class_mismatch"))
    notices.push({ code: "reform_unknown_class", message: "Há itens com classificação que o ERP não reconhece: confira o CST e a classificação com o contador." });
  if (results.some((r) => r.status === "manual"))
    notices.push({ code: "reform_manual", message: "Há itens em regime que o ERP não calcula (diferimento, suspensão, alíquota fixa e outros): os valores ficam com o contador." });
  return { year: context.year, regime, rates, informative: rates.informative, affects_total: false, items: results, totals, notices };
}

const dec = (value: unknown): Num => {
  if (value === null || value === undefined || value === "") return ZERO;
  const t = String(value);
  return /^-?\d+(?:\.\d+)?$/.test(t) ? num(t) : ZERO;
};

/**
 * Base do IBS/CBS de um item da NF-e (informe técnico 2025.002, 2026 a 2032):
 * produto + frete + seguro + outras despesas − desconto − ICMS − FCP − ICMS
 * do destino e FCP do destino (DIFAL) − PIS − COFINS. Nunca negativa.
 */
export function reformBaseFromItem(item: {
  gross?: unknown; freight?: unknown; insurance?: unknown; other_expenses?: unknown; discount?: unknown;
  icms?: unknown; fcp?: unknown; difal_dest?: unknown; difal_fcp?: unknown; pis?: unknown; cofins?: unknown;
}): string {
  let base = add(add(add(dec(item.gross), dec(item.freight)), dec(item.insurance)), dec(item.other_expenses));
  for (const minus of [item.discount, item.icms, item.fcp, item.difal_dest, item.difal_fcp, item.pis, item.cofins]) base = add(base, neg(dec(minus)));
  return money(sign(base) < 0 ? ZERO : base);
}

/** Ano do documento pela data (AAAA-MM-DD...), ou o ano corrente. */
export function reformYearOf(date: unknown, fallback = new Date()): number {
  const m = typeof date === "string" ? /^(\d{4})-\d{2}-\d{2}/.exec(date) : null;
  return m ? Number(m[1]) : fallback.getUTCFullYear();
}
