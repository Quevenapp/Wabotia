// SPED Fiscal (EFD ICMS/IPI) de um mês, a partir das notas já normalizadas:
// bloco 0 (abertura, empresa, contador, participantes, unidades, itens e
// naturezas, só os citados), B (vazio), C (C100 das NF-e e NFC-e emitidas e
// recebidas, C170 só nas de terceiros, C190 por CST, CFOP e alíquota), D
// (vazio), E (E110 com os totais do C190, E116 quando há ICMS a recolher,
// E200/E210 do ICMS-ST retido e E500 a E520 do IPI na atividade industrial), G
// (vazio), H (inventário, quando pedido), K (vazio), 1 (1010) e 9.
// Regras do Guia Prático aplicadas aqui:
// - NF-e de emissão própria: C100 e C190, sem C170;
// - NFC-e (modelo 65): C100 sem participante, sem ST, IPI, PIS e COFINS, e C190; nunca C170;
// - cancelada ou denegada: C100 só com a identificação (sem DT_DOC, valores, C170 nem C190);
// - inutilizada: um C100 por número, COD_SIT 05, sem chave;
// - entrada de terceiros: C170 com o CFOP e o CST do IPI de entrada.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SpedProblem } from "./contract.ts";
import {
  cstIcms, entryCfop, entryCstIpi, ieOf, itemEntry, itemOperation, paymentIndicator, Registry, SpedWriter, supplierPrefix, withValues,
} from "./common.ts";
import { clean, ddmmyyyy, decimal, mmyyyy, money, onlyDigits, scaled } from "./format.ts";
import { EFD_ICMS_IPI_VERSIONS, layoutVersion } from "./layout.ts";
import type { SpedDocument, SpedInput, SpedItem } from "./model.ts";

type Fields = (string | number | null | undefined)[];
export interface EfdIcmsSummary {
  [key: string]: number | string;
  debitos: number; creditos: number; saldo_credor_anterior: number; saldo_apurado: number; icms_a_recolher: number; saldo_credor_transportar: number;
  st_retido: number; ipi_debitos: number; ipi_creditos: number; documentos: number; inventario: number;
}
export interface BuildResult<S> { lines: string[]; summary: S; warnings: string[]; problems: SpedProblem[] }

const nextMonthDay = (to: string, day: number) => {
  const [y, m] = to.split("-").map(Number);
  const year = m === 12 ? y + 1 : y, month = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`;
};

interface C190Row { cst: string; cfop: string; rate: string; opr: number; base: number; icms: number; stBase: number; st: number; red: number; ipi: number }
/** C190 de uma nota: soma dos itens por CST, CFOP e alíquota. */
export function analytic(doc: SpedDocument): C190Row[] {
  const rows = new Map<string, C190Row>();
  for (const item of doc.items) {
    const cst = cstIcms(item), cfop = doc.own ? item.cfop : entryCfop(item.cfop), rate = decimal(item.icms_rate, 2);
    const key = `${cst}|${cfop}|${rate}`;
    const row = rows.get(key) ?? { cst, cfop, rate, opr: 0, base: 0, icms: 0, stBase: 0, st: 0, red: 0, ipi: 0 };
    row.opr += itemOperation(item); row.base += item.icms_base; row.icms += item.icms; row.stBase += item.st_base; row.st += item.st; row.ipi += item.ipi.value;
    if (/^(20|70)$/.test(cst.slice(1))) row.red += Math.max(0, item.amount - item.discount + item.freight + item.insurance + item.other - item.icms_base);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.cst.localeCompare(b.cst) || a.cfop.localeCompare(b.cfop) || a.rate.localeCompare(b.rate));
}

function c100(doc: SpedDocument, reg: Registry): Fields {
  const oper = doc.direction, emit = doc.own ? "0" : "1", model = doc.model;
  if (!withValues(doc)) {
    // Cancelada, denegada ou inutilizada: só a identificação.
    return ["C100", oper, emit, "", model, doc.situation, clean(doc.series, 3), onlyDigits(doc.number), doc.situation === "05" ? "" : doc.key ?? "",
      "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
  }
  const t = doc.totals, nfce = model === "65";
  return ["C100", oper, emit, nfce ? "" : reg.party(doc.party), model, doc.situation, clean(doc.series, 3), onlyDigits(doc.number), doc.key ?? "",
    ddmmyyyy(doc.issued_on), nfce ? "" : ddmmyyyy(doc.io_on ?? doc.issued_on), money(t.doc), paymentIndicator(doc.payment), money(t.discount), money(0), money(t.products),
    /^[0-49]$/.test(doc.freight_mode) ? doc.freight_mode : "9", money(t.freight), money(t.insurance), money(t.other), money(t.icms_base), money(t.icms),
    nfce ? "" : money(t.st_base), nfce ? "" : money(t.st), nfce ? "" : money(t.ipi), nfce ? "" : money(t.pis), nfce ? "" : money(t.cofins),
    nfce ? "" : money(0), nfce ? "" : money(0)];
}

function c170(doc: SpedDocument, item: SpedItem, index: number, input: SpedInput, reg: Registry): Fields {
  const entry = itemEntry(input, item, supplierPrefix(doc));
  const code = reg.item(entry);
  const unit = reg.unit(entry.unit);
  const cstIpi = entryCstIpi(item.ipi.cst);
  return ["C170", item.n || index + 1, code, "", decimal(item.qty, 5), unit, money(item.amount), money(item.discount), "0", cstIcms(item),
    doc.own ? item.cfop : entryCfop(item.cfop), reg.nature(doc.nature), money(item.icms_base), decimal(item.icms_rate, 2), money(item.icms),
    money(item.st_base), decimal(item.st_rate, 2), money(item.st), item.ipi.value || cstIpi ? "0" : "", cstIpi ?? "", "", money(item.ipi.base),
    decimal(item.ipi.rate, 2), money(item.ipi.value), entryCst(item.pis.cst), money(item.pis.base), decimal(item.pis.rate, 4), "", "", money(item.pis.value),
    entryCst(item.cofins.cst), money(item.cofins.base), decimal(item.cofins.rate, 4), "", "", money(item.cofins.value), "", money(0)];
}

/** CST do PIS/COFINS de saída do fornecedor → o de entrada (informativo no SPED Fiscal). */
export function entryCst(cst: string | null): string {
  if (!cst || !/^\d{2}$/.test(cst)) return "";
  const n = Number(cst);
  if (n >= 50) return cst;
  return ({ 1: "50", 2: "50", 3: "50", 4: "70", 5: "75", 6: "73", 7: "71", 8: "74", 9: "72", 49: "98" } as Record<number, string>)[n] ?? "99";
}

export function buildEfdIcmsIpi(input: SpedInput): BuildResult<EfdIcmsSummary> {
  const { company, settings } = input;
  const reg = new Registry();
  const warnings: string[] = [];
  const problems: SpedProblem[] = [];
  const version = layoutVersion(EFD_ICMS_IPI_VERSIONS, input.from);
  if (!version) problems.push({ kind: "configuracao", message: `O SPED Fiscal deste sistema começa em 2020; o período ${input.from.slice(0, 7)} é anterior.`, link: null, blocking: true });

  // Bloco C: notas de mercadoria (NF-e e NFC-e), na ordem de data, modelo, série e número.
  const docs = input.documents.filter((d) => d.model === "55" || d.model === "65")
    .sort((a, b) => (a.io_on ?? a.issued_on).localeCompare(b.io_on ?? b.issued_on) || a.model.localeCompare(b.model) || a.series.localeCompare(b.series) || Number(a.number) - Number(b.number));
  const blockC: Fields[] = [];
  let debits = 0, credits = 0, ipiDebits = 0, ipiCredits = 0;
  const stByUf = new Map<string, number>();
  const ipiRows = new Map<string, { cfop: string; cst: string; opr: number; base: number; ipi: number }>();
  for (const doc of docs) {
    if (doc.situation === "05") {
      // Inutilização: um C100 por número da faixa.
      const first = Number(doc.number), last = Number(doc.number_to ?? doc.number);
      for (let n = first; n <= last && n - first < 10000; n++) blockC.push(c100({ ...doc, number: String(n) }, reg));
      continue;
    }
    blockC.push(c100(doc, reg));
    if (!withValues(doc)) continue;
    if (!doc.own) doc.items.forEach((item, index) => blockC.push(c170(doc, item, index, input, reg)));
    for (const row of analytic(doc)) {
      blockC.push(["C190", row.cst, row.cfop, row.rate, money(row.opr), money(row.base), money(row.icms), money(row.stBase), money(row.st), money(row.red), money(row.ipi), ""]);
      const out = /^[5-7]/.test(row.cfop);
      if (out) debits += row.icms; else credits += row.icms;
      if (out && row.st > 0 && doc.model === "55") { const uf = doc.party?.uf ?? company.uf; stByUf.set(uf, (stByUf.get(uf) ?? 0) + row.st); }
    }
    if (settings.activity === "0") for (const item of doc.items) {
      const cfop = doc.own ? item.cfop : entryCfop(item.cfop), cst = (doc.own ? item.ipi.cst : entryCstIpi(item.ipi.cst)) ?? (/^[5-7]/.test(cfop) ? "53" : "03");
      const key = `${cfop}|${cst}`, r = ipiRows.get(key) ?? { cfop, cst, opr: 0, base: 0, ipi: 0 };
      r.opr += itemOperation(item); r.base += item.ipi.base; r.ipi += item.ipi.value; ipiRows.set(key, r);
      if (/^[5-7]/.test(cfop)) ipiDebits += item.ipi.value; else ipiCredits += item.ipi.value;
    }
  }

  // Bloco E: apuração do ICMS (E110) pelos C190.
  const previous = Math.max(0, Math.round(input.previous_credit || 0));
  const debitSide = debits, creditSide = credits + previous;
  const balance = Math.max(0, debitSide - creditSide);
  const toCarry = Math.max(0, creditSide - debitSide);
  const blockE: Fields[] = [["E100", ddmmyyyy(input.from), ddmmyyyy(input.to)],
    ["E110", money(debits), money(0), money(0), money(0), money(credits), money(0), money(0), money(0), money(previous), money(balance), money(0), money(balance), money(toCarry), money(0)]];
  if (balance > 0) {
    if (!settings.icms_revenue_code) problems.push({ kind: "configuracao", blocking: true, link: "/sped-fiscal?aba=configuracao",
      message: `Há ICMS a recolher no mês (${money(balance)}) e falta o código de receita do ICMS da sua UF (registro E116). Informe em Obrigações em arquivo › Configuração (o contador sabe o código).` });
    blockE.push(["E116", "000", money(balance), ddmmyyyy(nextMonthDay(input.to, settings.icms_due_day)), clean(settings.icms_revenue_code, 20), "", "", "", "", mmyyyy(input.from)]);
  }
  let stTotal = 0;
  for (const [uf, st] of [...stByUf].sort()) {
    stTotal += st;
    blockE.push(["E200", uf, ddmmyyyy(input.from), ddmmyyyy(input.to)]);
    blockE.push(["E210", "1", money(0), money(0), money(0), money(0), money(0), money(st), money(0), money(0), money(st), money(0), money(st), money(0), money(0)]);
  }
  if (stTotal > 0) warnings.push("Há ICMS-ST retido nas saídas: confira com o contador os registros E200/E210 (por UF) e o E250 de recolhimento, que o arquivo não traz.");
  if (settings.activity === "0") {
    blockE.push(["E500", "0", ddmmyyyy(input.from), ddmmyyyy(input.to)]);
    for (const r of [...ipiRows.values()].sort((a, b) => a.cfop.localeCompare(b.cfop) || a.cst.localeCompare(b.cst)))
      blockE.push(["E510", r.cfop, r.cst, money(r.opr), money(r.base), money(r.ipi)]);
    blockE.push(["E520", money(0), money(ipiDebits), money(ipiCredits), money(0), money(0), money(Math.max(0, ipiCredits - ipiDebits)), money(Math.max(0, ipiDebits - ipiCredits))]);
  }

  // Bloco H: inventário, quando pedido.
  const blockH: Fields[] = [];
  let inventoryTotal = 0;
  if (input.inventory) {
    const rows: Fields[] = [];
    for (const item of input.inventory.items) {
      if (scaled(item.qty, 6) <= 0n) continue;
      const code = reg.item({ code: item.code, description: clean(item.description, 200) || "Item sem descrição", unit: item.unit ?? "UN", gtin: item.gtin, ncm: onlyDigits(item.ncm) || null, ex_tipi: null, cest: null, type: "00", rate: null });
      inventoryTotal += item.amount;
      rows.push(["H010", code, reg.unit(item.unit), decimal(item.qty, 3), decimal(item.unit_cost, 6), money(item.amount), "0", "", "", "", ""]);
    }
    blockH.push(["H005", ddmmyyyy(input.inventory.day), money(inventoryTotal), "01"], ...rows);
  }

  // Bloco 0 (por último na montagem, primeiro no arquivo: só o que os outros citam).
  const w = new SpedWriter();
  const a = settings.accountant;
  w.add(["0000", version ?? "", "0", ddmmyyyy(input.from), ddmmyyyy(input.to), clean(company.name, 100), onlyDigits(company.cnpj), "", company.uf, ieOf(company.ie),
    company.city_code, clean(company.im, 30), clean(company.suframa, 9), settings.profile, settings.activity]);
  w.add(["0001", "0"]);
  w.add(["0005", clean(company.trade_name || company.name, 60), onlyDigits(company.postal_code), clean(company.street, 60), clean(company.number, 10), clean(company.complement, 60),
    clean(company.district, 60), phone(company.phone), "", clean(company.email, 120)]);
  w.add(["0100", clean(a.name, 100), onlyDigits(a.cpf), clean(a.crc, 15), onlyDigits(a.cnpj), onlyDigits(a.postal_code), clean(a.street, 60), clean(a.number, 10),
    clean(a.complement, 60), clean(a.district, 60), phone(a.phone), "", clean(a.email, 120), onlyDigits(a.city_code)]);
  for (const [code, p] of reg.parties) {
    const doc = p.document ?? "", foreign = p.country !== "1058";
    w.add(["0150", code, clean(p.name, 100) || "Participante sem nome", (foreign ? p.country : "1058").padStart(5, "0"),
      doc.length === 14 ? doc : "", doc.length === 11 ? doc : "", foreign ? "" : ieOf(p.ie), foreign ? "9999999" : onlyDigits(p.city_code), clean(p.suframa, 9),
      clean(p.street, 60), clean(p.number, 10), clean(p.complement, 60), clean(p.district, 60)]);
  }
  for (const [unit, description] of reg.units) w.add(["0190", unit, clean(description, 100)]);
  for (const item of reg.items.values())
    w.add(["0200", item.code, item.description, item.gtin ?? "", "", reg.unit(item.unit), item.type, item.ncm ?? "", clean(item.ex_tipi, 3), item.ncm ? item.ncm.slice(0, 2) : "", "", "", item.cest ?? ""]);
  for (const [code, description] of reg.natures) w.add(["0400", code, description]);
  w.close("0");
  w.add(["B001", "1"]); w.close("B");
  w.add(["C001", blockC.length ? "0" : "1"]); for (const r of blockC) w.add(r); w.close("C");
  w.add(["D001", "1"]); w.close("D");
  w.add(["E001", "0"]); for (const r of blockE) w.add(r); w.close("E");
  w.add(["G001", "1"]); w.close("G");
  w.add(["H001", blockH.length ? "0" : "1"]); for (const r of blockH) w.add(r); w.close("H");
  w.add(["K001", "1"]); w.close("K");
  w.add(["1001", "0"]); w.add(["1010", "N", "N", "N", "N", "N", "N", "N", "N", "N", "N", "N", "N", "N"]); w.close("1");
  const lines = w.finish();
  return {
    lines, warnings, problems,
    summary: { debitos: debits, creditos: credits, saldo_credor_anterior: previous, saldo_apurado: balance, icms_a_recolher: balance, saldo_credor_transportar: toCarry,
      st_retido: stTotal, ipi_debitos: ipiDebits, ipi_creditos: ipiCredits, documentos: docs.length, inventario: inventoryTotal },
  };
}

/** Telefone com DDD, só dígitos, até 11. */
export const phone = (value: string | null) => { const d = onlyDigits(value).replace(/^55(?=\d{10,11}$)/, ""); return d.length >= 10 ? d.slice(-11) : ""; };
