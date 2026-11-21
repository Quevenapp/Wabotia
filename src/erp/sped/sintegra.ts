// SINTEGRA (Convênio ICMS 57/95) do período: registros 10 (empresa), 11
// (endereço e contato), 50 (NF-e por CFOP e alíquota, entradas e saídas), 54
// (itens das NF-e e as despesas 991, 992 e 999), 61 e 61R (NFC-e por dia,
// série e alíquota, e o resumo mensal por item), 74 (inventário, quando
// pedido), 75 (cada produto citado) e 90 (totais). Registros de 126
// posições, só ASCII, CR LF ao gravar.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SpedProblem } from "./contract.ts";
import { cstIcms, entryCfop, hash, ieOf, itemOperation, supplierPrefix, withValues } from "./common.ts";
import type { BuildResult } from "./efd-icms-ipi.ts";
import { fixedField, onlyDigits, scaled, unscaled, yyyymmdd } from "./format.ts";
import { SINTEGRA_LAYOUT } from "./layout.ts";
import type { SpedDocument, SpedInput, SpedItem } from "./model.ts";

export interface SintegraSummary {
  [key: string]: number | string;
  registros: number; notas: number; nfce: number; valor_saidas: number; valor_entradas: number; icms_saidas: number; icms_entradas: number; inventario: number;
}

/** Monta um registro pelo layout (os valores na ordem dos campos). */
export function record(type: string, values: readonly (string | number | null | undefined)[]): string {
  const layout = SINTEGRA_LAYOUT[type];
  return layout.map((f, i) => fixedField(f.type, f.size, values[i] ?? (f.type === "X" ? "" : 0), f.decimals)).join("");
}
/** Código do produto em até 14 posições (o longo vira começo + resumo, sem colisão prática). */
export const code14 = (code: string) => code.length <= 14 ? code : `${code.slice(0, 5)}${hash(code)}`.slice(0, 14);
/** Decimal em texto → inteiro com as casas implícitas. */
const implied = (value: string, decimals: number) => scaled(value, decimals).toString();

interface Group50 { cfop: string; rate: string; total: number; base: number; icms: number; exempt: number; other: number }
function groups50(doc: SpedDocument): Group50[] {
  const map = new Map<string, Group50>();
  for (const item of doc.items) {
    const cfop = doc.own ? item.cfop : entryCfop(item.cfop), rate = item.icms_base > 0 ? item.icms_rate : "0";
    const key = `${cfop}|${implied(rate, 2)}`;
    const g = map.get(key) ?? { cfop, rate, total: 0, base: 0, icms: 0, exempt: 0, other: 0 };
    const opr = itemOperation(item), cst = cstIcms(item).slice(1);
    g.total += opr; g.base += item.icms_base; g.icms += item.icms;
    const rest = Math.max(0, opr - item.icms_base);
    if (["30", "40", "41"].includes(cst)) g.exempt += rest; else g.other += rest;
    map.set(key, g);
  }
  return [...map.values()];
}

export function buildSintegra(input: SpedInput): BuildResult<SintegraSummary> {
  const { company, settings } = input;
  const warnings: string[] = [];
  const problems: SpedProblem[] = [];
  const lines: string[] = [];
  const cnpj = onlyDigits(company.cnpj);
  if (cnpj.length !== 14) problems.push({ kind: "empresa", blocking: true, link: "/empresa-configuracoes", message: "O SINTEGRA pede o CNPJ só com números (14 dígitos). Confira o CNPJ em Empresa." });
  lines.push(record("10", ["10", cnpj, ieOf(company.ie) || "ISENTO", company.name, company.city, company.uf, onlyDigits(company.phone).slice(-10), yyyymmdd(input.from), yyyymmdd(input.to),
    "3", settings.sintegra.nature, settings.sintegra.purpose]));
  lines.push(record("11", ["11", company.street, onlyDigits(company.number).slice(-5) || "0", company.complement ?? "", company.district, onlyDigits(company.postal_code),
    settings.sintegra.contact ?? settings.accountant.name ?? company.name, onlyDigits(company.phone).slice(-12)]));

  const products = new Map<string, { item: SpedItem | null; description: string; unit: string; ncm: string; ipi: string; icms: string; red: string; st: number }>();
  const product = (doc: SpedDocument | null, item: SpedItem): string => {
    const catalog = item.product_id ? input.products[item.code] : undefined;
    const code = code14(catalog ? item.code : `${doc ? supplierPrefix(doc) : ""}${item.code}`);
    if (!products.has(code)) products.set(code, { item, description: catalog?.description ?? item.description, unit: (catalog?.unit ?? item.unit).slice(0, 6),
      ncm: onlyDigits(catalog?.ncm ?? item.ncm).slice(0, 8), ipi: item.ipi.rate, icms: item.icms_rate, red: item.icms_reduction ?? "0", st: 0 });
    return code;
  };

  // 50 e 54: NF-e (modelo 55), em ordem de data.
  const nfe = input.documents.filter((d) => d.model === "55").sort((a, b) => (a.own ? a.issued_on : a.io_on ?? a.issued_on).localeCompare(b.own ? b.issued_on : b.io_on ?? b.issued_on) || Number(a.number) - Number(b.number));
  const r50: string[] = [], r54: string[] = [];
  let outTotal = 0, inTotal = 0, outIcms = 0, inIcms = 0;
  for (const doc of nfe) {
    const p = doc.party;
    const doc14 = onlyDigits(p?.document ?? "").padStart(14, "0");
    const ie = p && p.country === "1058" ? ieOf(p.ie) || "ISENTO" : "ISENTO";
    const uf = p?.country !== "1058" ? "EX" : (p?.uf ?? company.uf);
    const day = doc.own ? doc.issued_on : doc.io_on ?? doc.issued_on;
    const emitter = doc.own ? "P" : "T";
    const number = onlyDigits(doc.number).slice(-6);
    if (doc.situation === "05") {
      const first = Number(doc.number), last = Number(doc.number_to ?? doc.number);
      for (let n = first; n <= last && n - first < 10000; n++)
        r50.push(record("50", ["50", cnpj, ieOf(company.ie) || "ISENTO", yyyymmdd(day), company.uf, "55", doc.series, String(n).slice(-6), doc.direction === "1" ? "5102" : "1102", "P", 0, 0, 0, 0, 0, 0, "4"]));
      continue;
    }
    if (!withValues(doc)) {
      const situation = doc.situation === "04" ? "2" : "S";
      const cfop = doc.items[0]?.cfop ?? (doc.direction === "1" ? "5102" : "1102");
      r50.push(record("50", ["50", doc14, ie, yyyymmdd(day), uf, "55", doc.series, number, doc.own ? cfop : entryCfop(cfop), emitter, 0, 0, 0, 0, 0, 0, situation]));
      continue;
    }
    for (const g of groups50(doc)) {
      r50.push(record("50", ["50", doc14, ie, yyyymmdd(day), uf, "55", doc.series, number, g.cfop, emitter, g.total, g.base, g.icms, g.exempt, g.other, implied(g.rate, 2), "N"]));
      if (/^[5-7]/.test(g.cfop)) { outTotal += g.total; outIcms += g.icms; } else { inTotal += g.total; inIcms += g.icms; }
    }
    doc.items.forEach((item, index) => {
      const codeItem = product(doc, item);
      r54.push(record("54", ["54", doc14, "55", doc.series, number, doc.own ? item.cfop : entryCfop(item.cfop), cstIcms(item), item.n || index + 1, codeItem,
        implied(item.qty, 3), item.amount, item.discount, item.icms_base, item.st_base, item.ipi.value, implied(item.icms_base > 0 ? item.icms_rate : "0", 2)]));
    });
    const cfop = doc.own ? (doc.items[0]?.cfop ?? "5102") : entryCfop(doc.items[0]?.cfop ?? "5102");
    for (const [n, value] of [[991, doc.totals.freight], [992, doc.totals.insurance], [999, doc.totals.other]] as const)
      if (value > 0 && !doc.items.some((i) => (n === 991 ? i.freight : n === 992 ? i.insurance : i.other) > 0))
        r54.push(record("54", ["54", doc14, "55", doc.series, number, cfop, "", n, "", 0, value, 0, 0, 0, 0, 0]));
  }
  lines.push(...r50, ...r54);

  // 61 e 61R: NFC-e (modelo 65) por dia, série e alíquota; resumo mensal por item.
  const nfce = input.documents.filter((d) => d.model === "65" && withValues(d));
  const r61 = new Map<string, { day: string; series: string; first: number; last: number; rate: string; total: number; base: number; icms: number; exempt: number; other: number }>();
  const r61r = new Map<string, { code: string; qty: bigint; total: number; base: number; rate: string }>();
  for (const doc of nfce) {
    const n = Number(onlyDigits(doc.number));
    for (const g of groups50({ ...doc, own: true })) {
      const key = `${doc.issued_on}|${doc.series}|${implied(g.rate, 2)}`;
      const r = r61.get(key) ?? { day: doc.issued_on, series: doc.series, first: n, last: n, rate: g.rate, total: 0, base: 0, icms: 0, exempt: 0, other: 0 };
      r.first = Math.min(r.first, n); r.last = Math.max(r.last, n);
      r.total += g.total; r.base += g.base; r.icms += g.icms; r.exempt += g.exempt; r.other += g.other;
      r61.set(key, r);
      outTotal += g.total; outIcms += g.icms;
    }
    for (const item of doc.items) {
      const codeItem = product(null, item), rate = item.icms_base > 0 ? item.icms_rate : "0";
      const key = `${codeItem}|${implied(rate, 2)}`;
      const r = r61r.get(key) ?? { code: codeItem, qty: 0n, total: 0, base: 0, rate };
      r.qty += scaled(item.qty, 3); r.total += itemOperation(item); r.base += item.icms_base;
      r61r.set(key, r);
    }
  }
  for (const r of [...r61.values()].sort((a, b) => a.day.localeCompare(b.day) || a.series.localeCompare(b.series)))
    lines.push(record("61", ["61", "", "", yyyymmdd(r.day), "65", r.series, "", r.first, r.last, r.total, r.base, r.icms, r.exempt, r.other, implied(r.rate, 2), ""]));
  const month = `${input.from.slice(5, 7)}${input.from.slice(0, 4)}`;
  for (const r of r61r.values())
    lines.push(record("61R", ["61", "R", month, r.code, implied(unscaled(r.qty, 3), 3), r.total, r.base, implied(r.rate, 2), ""]));

  // 74: inventário, quando pedido.
  let inventory = 0;
  if (input.inventory) {
    for (const item of input.inventory.items) {
      if (scaled(item.qty, 6) <= 0n) continue;
      const codeItem = code14(item.code);
      if (!products.has(codeItem)) products.set(codeItem, { item: null, description: item.description, unit: (item.unit ?? "UN").slice(0, 6), ncm: onlyDigits(item.ncm).slice(0, 8), ipi: "0", icms: "0", red: "0", st: 0 });
      inventory += item.amount;
      lines.push(record("74", ["74", yyyymmdd(input.inventory.day), codeItem, implied(item.qty, 3), item.amount, "1", "0".repeat(14), "", company.uf, ""]));
    }
  }

  // 75: cada produto citado.
  for (const [codeItem, p] of [...products].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(record("75", ["75", yyyymmdd(input.from), yyyymmdd(input.to), codeItem, p.ncm, p.description, p.unit, implied(p.ipi, 2), implied(p.icms, 2), implied(p.red, 2), p.st]));

  // 90: totais por tipo e o total geral (99), até 9 pares por registro 90.
  const counts = new Map<string, number>();
  for (const l of lines) { const t = l.slice(0, 2); if (t !== "10" && t !== "11") counts.set(t, (counts.get(t) ?? 0) + 1); }
  const pairs = [...counts].sort(([a], [b]) => a.localeCompare(b));
  const perLine = 9;
  const nineties = Math.max(1, Math.ceil((pairs.length + 1) / perLine));
  pairs.push(["99", lines.length + nineties]);
  for (let i = 0; i < nineties; i++) {
    const chunk = pairs.slice(i * perLine, (i + 1) * perLine);
    const body = chunk.map(([t, q]) => `${t}${String(q).padStart(8, "0")}`).join("");
    lines.push(`90${cnpj.padStart(14, "0").slice(-14)}${fixedField("X", 14, ieOf(company.ie) || "ISENTO")}${body.padEnd(95, " ")}${nineties}`);
  }
  if (input.documents.some((d) => d.model === "nfse")) warnings.push("As NFS-e (serviços) não entram no SINTEGRA: o serviço é do ISS, fora do Convênio 57/95.");
  return {
    lines, warnings, problems,
    summary: { registros: lines.length, notas: nfe.length, nfce: nfce.length, valor_saidas: outTotal, valor_entradas: inTotal, icms_saidas: outIcms, icms_entradas: inIcms, inventario: inventory },
  };
}
