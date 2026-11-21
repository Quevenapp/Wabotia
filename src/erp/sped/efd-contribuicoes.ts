// EFD-Contribuições (PIS/COFINS) de um mês, para quem não é do Simples:
// bloco 0 (abertura, contador, regime 0110, estabelecimento 0140 com os
// participantes, unidades, itens e naturezas citados), A (NFS-e emitidas:
// A100 e A170), C (C010; NF-e emitidas e recebidas com C100 e C170; NFC-e com
// C100 e C175 por CFOP e CST), D, F, I e P vazios, M (créditos M100/M105 e
// M500/M505 no não cumulativo; apuração M200/M210 e M600/M610), 1 vazio e 9.
// Regras:
// - PIS/COFINS da saída: os do XML; NFS-e sem os tributos no XML usa as
//   alíquotas básicas do regime (não cumulativo 1,65% e 7,6%; cumulativo 0,65% e 3%);
// - entrada de terceiros: só no não cumulativo (no cumulativo não há crédito),
//   com o CST de entrada e o crédito básico sobre o valor do item menos o ICMS;
// - receita isenta, sem incidência, suspensa ou de alíquota zero (CST 04 a 09)
//   fica de fora do M400/M410 e do M800/M810: aviso para o contador completar no PVA.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SpedProblem } from "./contract.ts";
import { entryCfop, ieOf, itemEntry, itemOperation, Registry, SpedWriter, supplierPrefix, withValues } from "./common.ts";
import { analytic, phone, type BuildResult } from "./efd-icms-ipi.ts";
import { clean, ddmmyyyy, decimal, money, onlyDigits, scaled } from "./format.ts";
import { EFD_CONTRIBUICOES_VERSIONS, layoutVersion } from "./layout.ts";
import type { SpedDocument, SpedInput, SpedItem, SpedTax } from "./model.ts";

type Fields = (string | number | null | undefined)[];
export interface ContribSummary {
  [key: string]: number | string;
  receita_tributada: number; pis_apurado: number; cofins_apurado: number; credito_pis: number; credito_cofins: number;
  pis_a_recolher: number; cofins_a_recolher: number; receita_nao_tributada: number; documentos: number;
}

const TAXED = new Set(["01", "02", "03"]);
const UNTAXED = new Set(["04", "05", "06", "07", "08", "09"]);
const rateOf = (rate: string, fallback: string) => (scaled(rate, 4) > 0n ? rate : fallback);
/** Valor × alíquota (%) em centavos, arredondado. */
const apply = (base: number, rate: string) => Math.round((base * Number(scaled(rate, 4))) / 1_000_000);

export function buildEfdContribuicoes(input: SpedInput): BuildResult<ContribSummary> {
  const { company, settings } = input;
  const pc = settings.pis_cofins;
  const nonCumulative = pc.incidence !== "2";
  const basic = nonCumulative ? { pis: "1.65", cofins: "7.6" } : { pis: "0.65", cofins: "3" };
  const code = nonCumulative ? "01" : "51";
  const reg = new Registry();
  const warnings: string[] = [];
  const problems: SpedProblem[] = [];
  const version = layoutVersion(EFD_CONTRIBUICOES_VERSIONS, input.from);
  if (!version) problems.push({ kind: "configuracao", message: `A EFD-Contribuições deste sistema começa em 2019; o período ${input.from.slice(0, 7)} é anterior.`, link: null, blocking: true });
  if (pc.incidence === "3") warnings.push("Regime misto (cumulativo e não cumulativo): o arquivo apura tudo como não cumulativo. O contador separa as receitas no PVA.");

  // Apuração: base e valor por código de contribuição e alíquota; crédito básico das entradas.
  const contrib = { pis: new Map<string, { rec: number; base: number; value: number }>(), cofins: new Map<string, { rec: number; base: number; value: number }>() };
  const credit = { pis: { base: 0, value: 0 }, cofins: { base: 0, value: 0 } };
  let untaxed = 0;
  const addContribution = (kind: "pis" | "cofins", tax: SpedTax, revenue: number, fallback: string) => {
    if (!tax.cst || !TAXED.has(tax.cst)) { if (tax.cst && UNTAXED.has(tax.cst) && kind === "pis") untaxed += revenue; return; }
    const rate = rateOf(tax.rate, fallback), key = decimal(rate, 4);
    const row = contrib[kind].get(key) ?? { rec: 0, base: 0, value: 0 };
    row.rec += revenue; row.base += tax.base || revenue; row.value += tax.value || apply(tax.base || revenue, rate);
    contrib[kind].set(key, row);
  };

  // Bloco A: NFS-e emitidas (prestação de serviço).
  const blockA: Fields[] = [];
  const services = input.documents.filter((d) => d.model === "nfse").sort((a, b) => a.issued_on.localeCompare(b.issued_on) || a.number.localeCompare(b.number));
  for (const doc of services) {
    const s = doc.service;
    if (!s) continue;
    if (!withValues(doc)) {
      blockA.push(["A100", "1", "0", "", "02", clean(doc.series, 20), "", clean(doc.number, 128), clean(doc.key, 60), ddmmyyyy(doc.issued_on), "", money(0), "9", "", money(0), money(0), money(0), money(0), "", "", ""]);
      continue;
    }
    const revenue = s.amount - s.discount;
    const pis: SpedTax = s.pis.cst ? s.pis : { cst: "01", base: revenue, rate: basic.pis, value: apply(revenue, basic.pis) };
    const cofins: SpedTax = s.cofins.cst ? s.cofins : { cst: "01", base: revenue, rate: basic.cofins, value: apply(revenue, basic.cofins) };
    if (!s.pis.cst) warnings.push(`A NFS-e ${doc.number} não traz PIS e COFINS no XML: o arquivo usou as alíquotas básicas do regime (${decimal(basic.pis, 2)}% e ${decimal(basic.cofins, 2)}%).`);
    const item = reg.item({ code: `SERV-${s.code ?? "GERAL"}`, description: clean(s.description, 200) || "Serviço prestado", unit: "SV", gtin: null, ncm: null, ex_tipi: null, cest: null, type: "09", rate: null });
    blockA.push(["A100", "1", "0", reg.party(doc.party), "00", clean(doc.series, 20), "", clean(doc.number, 128), clean(doc.key, 60), ddmmyyyy(doc.issued_on),
      ddmmyyyy(doc.io_on ?? doc.issued_on), money(doc.totals.doc || revenue), "9", money(s.discount), money(pis.base), money(pis.value), money(cofins.base), money(cofins.value),
      money(s.pis_withheld), money(s.cofins_withheld), money(s.iss)]);
    blockA.push(["A170", 1, item, clean(s.description, 200), money(s.amount), money(s.discount), "", "", pis.cst, money(pis.base), decimal(pis.rate, 4), money(pis.value),
      cofins.cst, money(cofins.base), decimal(cofins.rate, 4), money(cofins.value), "", ""]);
    addContribution("pis", pis, revenue, basic.pis);
    addContribution("cofins", cofins, revenue, basic.cofins);
  }

  // Bloco C: NF-e (C100/C170) e NFC-e (C100/C175).
  const blockC: Fields[] = [];
  const goods = input.documents.filter((d) => (d.model === "55" || d.model === "65") && d.situation !== "05" && (d.own || nonCumulative))
    .sort((a, b) => (a.io_on ?? a.issued_on).localeCompare(b.io_on ?? b.issued_on) || a.model.localeCompare(b.model) || Number(a.number) - Number(b.number));
  for (const doc of goods) {
    if (!withValues(doc)) {
      if (doc.own) blockC.push(["C100", doc.direction, "0", "", doc.model, doc.situation, clean(doc.series, 3), onlyDigits(doc.number), doc.key ?? "",
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      continue;
    }
    const t = doc.totals, nfce = doc.model === "65";
    const lines = doc.items.map((item) => contribItem(doc, item, nonCumulative, basic));
    const pisTotal = lines.reduce((s, l) => s + l.pis.value, 0), cofinsTotal = lines.reduce((s, l) => s + l.cofins.value, 0);
    blockC.push(["C100", doc.direction, doc.own ? "0" : "1", nfce ? "" : reg.party(doc.party), doc.model, doc.situation, clean(doc.series, 3), onlyDigits(doc.number), doc.key ?? "",
      ddmmyyyy(doc.issued_on), nfce ? "" : ddmmyyyy(doc.io_on ?? doc.issued_on), money(t.doc), doc.payment === "0" || doc.payment === "1" ? doc.payment : "2", money(t.discount), money(0),
      money(t.products), /^[0-49]$/.test(doc.freight_mode) ? doc.freight_mode : "9", money(t.freight), money(t.insurance), money(t.other), money(t.icms_base), money(t.icms),
      nfce ? "" : money(t.st_base), nfce ? "" : money(t.st), nfce ? "" : money(t.ipi), money(pisTotal), money(cofinsTotal), nfce ? "" : money(0), nfce ? "" : money(0)]);
    if (nfce) {
      // C175: por CFOP, CST e alíquota.
      const groups = new Map<string, { cfop: string; opr: number; desc: number; pis: SpedTax; cofins: SpedTax }>();
      doc.items.forEach((item, i) => {
        const l = lines[i], key = `${item.cfop}|${l.pis.cst}|${l.pis.rate}|${l.cofins.cst}|${l.cofins.rate}`;
        const g = groups.get(key) ?? { cfop: item.cfop, opr: 0, desc: 0, pis: { ...l.pis, base: 0, value: 0 }, cofins: { ...l.cofins, base: 0, value: 0 } };
        g.opr += itemOperation(item); g.desc += item.discount; g.pis.base += l.pis.base; g.pis.value += l.pis.value; g.cofins.base += l.cofins.base; g.cofins.value += l.cofins.value;
        groups.set(key, g);
      });
      for (const g of groups.values())
        blockC.push(["C175", g.cfop, money(g.opr), money(g.desc), g.pis.cst, money(g.pis.base), decimal(g.pis.rate, 4), "", "", money(g.pis.value),
          g.cofins.cst, money(g.cofins.base), decimal(g.cofins.rate, 4), "", "", money(g.cofins.value), "", ""]);
    } else {
      doc.items.forEach((item, i) => {
        const l = lines[i], entry = itemEntry(input, item, supplierPrefix(doc));
        const codeItem = reg.item(entry), unit = reg.unit(entry.unit);
        blockC.push(["C170", item.n || i + 1, codeItem, "", decimal(item.qty, 5), unit, money(item.amount), money(item.discount), "0",
          (analytic({ ...doc, items: [item] })[0]?.cst) ?? "090", doc.own ? item.cfop : entryCfop(item.cfop), reg.nature(doc.nature), money(item.icms_base),
          decimal(item.icms_rate, 2), money(item.icms), money(item.st_base), decimal(item.st_rate, 2), money(item.st), item.ipi.value ? "0" : "", "", "",
          money(item.ipi.base), decimal(item.ipi.rate, 2), money(item.ipi.value), l.pis.cst, money(l.pis.base), decimal(l.pis.rate, 4), "", "", money(l.pis.value),
          l.cofins.cst, money(l.cofins.base), decimal(l.cofins.rate, 4), "", "", money(l.cofins.value), ""]);
      });
    }
    doc.items.forEach((item, i) => {
      const l = lines[i];
      if (doc.direction === "1" && doc.own) {
        const revenue = item.amount - item.discount;
        addContribution("pis", l.pis, revenue, basic.pis);
        addContribution("cofins", l.cofins, revenue, basic.cofins);
      } else if (!doc.own && nonCumulative && l.pis.cst === "50") {
        credit.pis.base += l.pis.base; credit.pis.value += l.pis.value; credit.cofins.base += l.cofins.base; credit.cofins.value += l.cofins.value;
      }
    });
  }

  // Bloco M.
  const blockM: Fields[] = [];
  const sum = (m: Map<string, { value: number }>) => [...m.values()].reduce((s, r) => s + r.value, 0);
  const pisDue = sum(contrib.pis), cofinsDue = sum(contrib.cofins);
  const pisUsed = Math.min(credit.pis.value, nonCumulative ? pisDue : 0), cofinsUsed = Math.min(credit.cofins.value, nonCumulative ? cofinsDue : 0);
  const nature = settings.activity === "0" ? "02" : "01";
  if (nonCumulative && credit.pis.value > 0) {
    blockM.push(["M100", "101", "0", money(credit.pis.base), decimal(basic.pis, 4), "", "", money(credit.pis.value), money(0), money(0), money(0), money(credit.pis.value),
      pisUsed === credit.pis.value ? "0" : "1", money(pisUsed), money(credit.pis.value - pisUsed)]);
    blockM.push(["M105", nature, "50", money(credit.pis.base), "", money(credit.pis.base), money(credit.pis.base), "", "", ""]);
  }
  const m200 = (due: number, used: number) => nonCumulative
    ? [money(due), money(used), money(0), money(due - used), money(0), money(0), money(due - used), money(0), money(0), money(0), money(0), money(due - used)]
    : [money(0), money(0), money(0), money(0), money(0), money(0), money(0), money(due), money(0), money(0), money(due), money(due)];
  blockM.push(["M200", ...m200(pisDue, pisUsed)]);
  for (const [rate, r] of contrib.pis)
    blockM.push(["M210", code, money(r.rec), money(r.base), money(0), money(0), money(r.base), rate, "", "", money(r.value), money(0), money(0), money(0), money(0), money(r.value)]);
  if (nonCumulative && credit.cofins.value > 0) {
    blockM.push(["M500", "101", "0", money(credit.cofins.base), decimal(basic.cofins, 4), "", "", money(credit.cofins.value), money(0), money(0), money(0), money(credit.cofins.value),
      cofinsUsed === credit.cofins.value ? "0" : "1", money(cofinsUsed), money(credit.cofins.value - cofinsUsed)]);
    blockM.push(["M505", nature, "50", money(credit.cofins.base), "", money(credit.cofins.base), money(credit.cofins.base), "", "", ""]);
  }
  blockM.push(["M600", ...m200(cofinsDue, cofinsUsed)]);
  for (const [rate, r] of contrib.cofins)
    blockM.push(["M610", code, money(r.rec), money(r.base), money(0), money(0), money(r.base), rate, "", "", money(r.value), money(0), money(0), money(0), money(0), money(r.value)]);
  if (untaxed > 0) warnings.push(`Há receita sem PIS e COFINS (CST 04 a 09, ${money(untaxed)}): o contador completa os registros M400/M410 e M800/M810 (natureza da receita) no PVA.`);

  // Bloco 0 e montagem.
  const w = new SpedWriter();
  const a = settings.accountant;
  w.add(["0000", version ?? "", "0", "", "", ddmmyyyy(input.from), ddmmyyyy(input.to), clean(company.name, 100), onlyDigits(company.cnpj), company.uf, company.city_code,
    clean(company.suframa, 9), pc.nature, pc.activity]);
  w.add(["0001", "0"]);
  w.add(["0100", clean(a.name, 100), onlyDigits(a.cpf), clean(a.crc, 15), onlyDigits(a.cnpj), onlyDigits(a.postal_code), clean(a.street, 60), clean(a.number, 10),
    clean(a.complement, 60), clean(a.district, 60), phone(a.phone), "", clean(a.email, 120), onlyDigits(a.city_code)]);
  w.add(["0110", pc.incidence, pc.incidence === "2" ? "" : pc.credit_method, pc.incidence === "2" ? "" : pc.contribution_type, pc.incidence === "2" ? pc.cumulative_regime : ""]);
  w.add(["0140", "", clean(company.name, 100), onlyDigits(company.cnpj), company.uf, ieOf(company.ie), company.city_code, clean(company.im, 30), clean(company.suframa, 9)]);
  for (const [partCode, p] of reg.parties) {
    const doc = p.document ?? "", foreign = p.country !== "1058";
    w.add(["0150", partCode, clean(p.name, 100) || "Participante sem nome", (foreign ? p.country : "1058").padStart(5, "0"), doc.length === 14 ? doc : "", doc.length === 11 ? doc : "",
      foreign ? "" : ieOf(p.ie), foreign ? "9999999" : onlyDigits(p.city_code), clean(p.suframa, 9), clean(p.street, 60), clean(p.number, 10), clean(p.complement, 60), clean(p.district, 60)]);
  }
  for (const [unit, description] of reg.units) w.add(["0190", unit, clean(description, 100)]);
  for (const item of reg.items.values())
    w.add(["0200", item.code, item.description, item.gtin ?? "", "", reg.unit(item.unit), item.type, item.ncm ?? "", clean(item.ex_tipi, 3), item.ncm ? item.ncm.slice(0, 2) : "", "", ""]);
  for (const [natCode, description] of reg.natures) w.add(["0400", natCode, description]);
  w.close("0");
  w.add(["A001", blockA.length ? "0" : "1"]); if (blockA.length) { w.add(["A010", onlyDigits(company.cnpj)]); for (const r of blockA) w.add(r); } w.close("A");
  w.add(["C001", blockC.length ? "0" : "1"]); if (blockC.length) { w.add(["C010", onlyDigits(company.cnpj), "2"]); for (const r of blockC) w.add(r); } w.close("C");
  w.add(["D001", "1"]); w.close("D");
  w.add(["F001", "1"]); w.close("F");
  w.add(["I001", "1"]); w.close("I");
  w.add(["M001", "0"]); for (const r of blockM) w.add(r); w.close("M");
  w.add(["P001", "1"]); w.close("P");
  w.add(["1001", "1"]); w.close("1");
  const lines = w.finish();
  return {
    lines, warnings, problems,
    summary: {
      receita_tributada: [...contrib.pis.values()].reduce((s, r) => s + r.rec, 0), pis_apurado: pisDue, cofins_apurado: cofinsDue,
      credito_pis: credit.pis.value, credito_cofins: credit.cofins.value, pis_a_recolher: pisDue - pisUsed, cofins_a_recolher: cofinsDue - cofinsUsed,
      receita_nao_tributada: untaxed, documentos: services.length + goods.length,
    },
  };
}

/** PIS e COFINS do item: da saída, os do XML (ou o básico do regime); da entrada, o crédito básico sobre o item menos o ICMS. */
function contribItem(doc: SpedDocument, item: SpedItem, nonCumulative: boolean, basic: { pis: string; cofins: string }): { pis: SpedTax; cofins: SpedTax } {
  if (doc.own) {
    const fill = (tax: SpedTax, fallback: string): SpedTax => tax.cst ? { ...tax, cst: tax.cst.padStart(2, "0") } : { cst: "01", base: item.amount - item.discount, rate: fallback, value: apply(item.amount - item.discount, fallback) };
    return { pis: fill(item.pis, basic.pis), cofins: fill(item.cofins, basic.cofins) };
  }
  const supplier = item.pis.cst ?? "01";
  const credited = nonCumulative && ["01", "02", "03"].includes(supplier);
  if (!credited) {
    const cst = ({ "04": "70", "05": "75", "06": "73", "07": "71", "08": "74", "09": "72" } as Record<string, string>)[supplier] ?? "70";
    return { pis: { cst, base: 0, rate: "0", value: 0 }, cofins: { cst, base: 0, rate: "0", value: 0 } };
  }
  const base = Math.max(0, item.amount - item.discount + item.freight + item.insurance + item.other + item.ipi.value - item.icms);
  return { pis: { cst: "50", base, rate: basic.pis, value: apply(base, basic.pis) }, cofins: { cst: "50", base, rate: basic.cofins, value: apply(base, basic.cofins) } };
}
