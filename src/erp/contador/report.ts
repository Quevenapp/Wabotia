// Relatórios fiscais do período para o contador: conferência, sem cálculo de
// guia. Junta o que o emissor (cofre) leu dos XML autorizados (emitidas e
// recebidas: por CFOP, natureza, situação e impostos destacados), as notas
// recebidas lançadas no ERP (por natureza) e, no Simples Nacional, a receita
// separada por anexo conforme a natureza da operação (o anexo de cada
// natureza vem do cadastro do contador em Preferências do Fiscal).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { FiscalReport, FiscalTaxTotals } from "../emissor/provider.ts";
import { periodLabel } from "./contract.ts";

export const SIMPLES_ANNEXES = ["I", "II", "III", "IV", "V"] as const;
export type SimplesAnnex = typeof SIMPLES_ANNEXES[number];
export const ANNEX_LABELS: Readonly<Record<SimplesAnnex, string>> = Object.freeze({
  I: "Anexo I (comércio)", II: "Anexo II (indústria)", III: "Anexo III (serviços)", IV: "Anexo IV (serviços)", V: "Anexo V (serviços)",
});
const CRT_LABELS: Record<string, string> = { "1": "Simples Nacional", "2": "Simples Nacional (excesso de sublimite)", "3": "Regime normal", "4": "MEI" };
export const isSimples = (crt: string | null) => crt === "1" || crt === "2" || crt === "4";

export interface Line { key: string; label: string; count: number; amount: number }
export interface TaxSummary { icms: number; icms_st: number; ipi: number; pis: number; cofins: number; iss: number }
export interface ReceivedSummary {
  by_nature: { nature: string; count: number; amount: number }[];
  by_cfop: { cfop: string; count: number; amount: number }[];
  by_status: { status: string; count: number; amount: number }[];
  with_entry: { count: number; amount: number };
}

export interface ContadorReport {
  environment: string;
  period: { from: string; to: string; label: string };
  /** false: o emissor ainda lê XML (pending_reads); repita depois de retry_after_ms. */
  complete: boolean;
  pending_reads: number;
  retry_after_ms: number | null;
  /** O emissor respondeu (false: sem emissor configurado ou fora do ar; só o que o ERP tem). */
  vault: boolean;
  notices: string[];
  regime: { crt: string | null; label: string };
  issued: { authorized: { count: number; amount: number }; taxes: TaxSummary; by_cfop: Line[]; by_nature: Line[]; by_status: Line[] };
  received: {
    authorized: { count: number; amount: number; with_xml: number }; taxes: TaxSummary; as_third_party: number;
    by_cfop: Line[]; by_status: Line[];
    /** Das notas recebidas lançadas no ERP (a natureza não vem do emissor). */
    by_nature: Line[];
    with_entry: { count: number; amount: number };
  };
  /** Só no Simples Nacional (CRT 1, 2 ou 4). */
  simples: null | {
    by_annex: (Line & { natures: string[] })[];
    unassigned: { amount: number; count: number; natures: string[] };
    total: number;
  };
}

const KIND: Record<string, string> = { nfe: "NF-e", nfce: "NFC-e", nfse: "NFS-e" };
const STATUS: Record<string, string> = {
  authorized: "autorizada", cancelled: "cancelada", rejected: "rejeitada", denied: "denegada", processing: "em processamento", error: "com erro",
  undetermined: "sem resposta do governo", contingency: "em contingência", autorizada: "autorizada", cancelada: "cancelada", denegada: "denegada",
};
const cents = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
const taxes = (t: FiscalTaxTotals | undefined): TaxSummary => ({
  icms: cents(t?.icms ?? 0), icms_st: cents(t?.icms_st ?? 0), ipi: cents(t?.ipi ?? 0), pis: cents(t?.pis ?? 0), cofins: cents(t?.cofins ?? 0), iss: cents(t?.iss ?? 0),
});
const emptyTaxes = (): TaxSummary => ({ icms: 0, icms_st: 0, ipi: 0, pis: 0, cofins: 0, iss: 0 });
const byAmount = (a: Line, b: Line) => b.amount - a.amount || a.label.localeCompare(b.label, "pt-BR");
export const natureKey = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

/** Anexos cadastrados (natureza → anexo), só os válidos, pela chave sem acento e caixa. */
export function annexMap(value: unknown): Map<string, SimplesAnnex> {
  const out = new Map<string, SimplesAnnex>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [nature, annex] of Object.entries(value as Record<string, unknown>))
    if (typeof annex === "string" && (SIMPLES_ANNEXES as readonly string[]).includes(annex) && nature.trim()) out.set(natureKey(nature), annex as SimplesAnnex);
  return out;
}

export function buildReport(input: {
  environment: string; from: string; to: string;
  vault: FiscalReport | null; vaultProblem?: string | null;
  received: ReceivedSummary; crt: string | null; annexes: unknown;
}): ContadorReport {
  const v = input.vault;
  const notices: string[] = [];
  if (!v) notices.push(input.vaultProblem || "O emissor de notas não respondeu: as notas emitidas e o que o emissor leu das recebidas ficaram de fora.");
  for (const w of v?.warnings ?? []) if (w.code !== "pending_reads") notices.push(w.message);
  if (v && !v.complete) notices.push(`O emissor ainda está lendo ${v.pending_reads} nota(s): CFOP, natureza e impostos estão parciais. A tela atualiza sozinha.`);
  notices.push("Só a nota autorizada entra nos totais; cancelada e recusada aparecem só em Por situação. Estes números são do que foi autorizado e servem para conferência: não calculam guia.");
  const issuedStatus: Line[] = (v?.issued.by_status ?? []).map((s) => ({ key: `${s.kind}:${s.status}`, label: `${KIND[s.kind] ?? s.kind} ${STATUS[s.status] ?? s.status}`, count: s.count, amount: cents(s.amount) }));
  const issuedNature: Line[] = (v?.issued.by_nature ?? []).map((n) => ({ key: n.nature, label: n.nature || "Sem natureza informada", count: n.count, amount: cents(n.amount) })).sort(byAmount);
  const report: ContadorReport = {
    environment: input.environment,
    period: { from: input.from, to: input.to, label: periodLabel(input.from, input.to) },
    complete: v ? v.complete : true, pending_reads: v?.pending_reads ?? 0, retry_after_ms: v && !v.complete ? v.retry_after_ms ?? 1500 : null,
    vault: !!v, notices,
    regime: { crt: input.crt, label: input.crt ? CRT_LABELS[input.crt] ?? `CRT ${input.crt}` : "Regime não informado no cadastro da empresa" },
    issued: {
      authorized: { count: v?.issued.authorized.count ?? 0, amount: cents(v?.issued.authorized.amount ?? 0) },
      taxes: v ? taxes(v.issued.authorized.taxes) : emptyTaxes(),
      by_cfop: (v?.issued.by_cfop ?? []).map((c) => ({ key: c.cfop, label: c.cfop, count: c.count, amount: cents(c.amount) })).sort(byAmount),
      by_nature: issuedNature,
      by_status: issuedStatus,
    },
    received: {
      authorized: { count: v?.received.authorized.count ?? 0, amount: cents(v?.received.authorized.amount ?? 0), with_xml: v?.received.authorized.with_xml ?? 0 },
      taxes: v ? taxes(v.received.authorized.taxes) : emptyTaxes(),
      as_third_party: v?.received.as_third_party ?? 0,
      by_cfop: (v?.received.by_cfop ?? []).map((c) => ({ key: c.cfop, label: c.cfop, count: c.count, amount: cents(c.amount) })).sort(byAmount),
      by_status: (v?.received.by_status ?? []).map((s) => ({ key: s.status, label: STATUS[s.status] ?? s.status, count: s.count, amount: cents(s.amount) })),
      by_nature: input.received.by_nature.map((n) => ({ key: n.nature, label: n.nature, count: n.count, amount: cents(n.amount) })).sort(byAmount),
      with_entry: { count: input.received.with_entry.count, amount: cents(input.received.with_entry.amount) },
    },
    simples: null,
  };
  if (isSimples(input.crt)) {
    const map = annexMap(input.annexes);
    const groups = new Map<SimplesAnnex, Line & { natures: string[] }>();
    const unassigned = { amount: 0, count: 0, natures: [] as string[] };
    for (const n of issuedNature) {
      const annex = map.get(natureKey(n.key));
      if (!annex) { unassigned.amount = cents(unassigned.amount + n.amount); unassigned.count += n.count; unassigned.natures.push(n.label); continue; }
      const g = groups.get(annex) ?? { key: annex, label: ANNEX_LABELS[annex], count: 0, amount: 0, natures: [] };
      g.amount = cents(g.amount + n.amount); g.count += n.count; g.natures.push(n.label);
      groups.set(annex, g);
    }
    const byAnnex = SIMPLES_ANNEXES.filter((a) => groups.has(a)).map((a) => groups.get(a)!);
    report.simples = { by_annex: byAnnex, unassigned, total: cents(byAnnex.reduce((s, g) => s + g.amount, 0) + unassigned.amount) };
    if (unassigned.natures.length)
      notices.push("Há natureza sem anexo do Simples escolhido: informe o anexo de cada natureza em Fiscal › Para o contador › Contador e anexos.");
  }
  return report;
}

// ---------------------------------------------------------------------------
// CSV (planilha: ponto e vírgula, vírgula decimal, UTF-8 com BOM)

/** Marca UTF-8 no começo do CSV: a planilha abre os acentos certos. */
const BOM_CHAR = String.fromCharCode(0xfeff);
/** Valor em reais na planilha (vírgula decimal). */
const brl = (value: number) => (Math.round((Number(value) || 0) * 100) / 100).toFixed(2).replace(".", ",");
const cell = (v: string | number) => {
  const t = typeof v === "number" ? String(v) : String(v).replace(/[\r\n]+/g, " ");
  // Planilha não executa fórmula vinda de dado de terceiro (número negativo continua número).
  const safe = typeof v === "string" && /^[=+\-@\t]/.test(t) && !/^-?\d+(,\d+)?$/.test(t) ? `'${t}` : t;
  return /[;"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function reportCsv(r: ContadorReport): string {
  const rows: (string | number)[][] = [["Relatórios fiscais para o contador", r.period.label], ["Ambiente", r.environment === "homologacao" ? "Homologação (teste)" : "Produção"],
    ["Regime", r.regime.label], []];
  const section = (title: string, head: string, lines: Line[]) => {
    rows.push([title], [head, "Notas", "Valor (R$)"], ...lines.map((l) => [l.label, l.count, brl(l.amount)]), []);
  };
  const tax = (title: string, t: TaxSummary) => rows.push([title], ["Imposto", "Valor (R$)"], ["ICMS", brl(t.icms)], ["ICMS-ST", brl(t.icms_st)], ["IPI", brl(t.ipi)],
    ["PIS", brl(t.pis)], ["COFINS", brl(t.cofins)], ["ISS", brl(t.iss)], []);
  rows.push(["Notas emitidas autorizadas", r.issued.authorized.count, brl(r.issued.authorized.amount)], []);
  section("Emitidas por CFOP", "CFOP", r.issued.by_cfop);
  section("Emitidas por natureza da operação", "Natureza", r.issued.by_nature);
  section("Emitidas por situação", "Situação", r.issued.by_status);
  tax("Impostos destacados nas emitidas", r.issued.taxes);
  rows.push(["Notas recebidas autorizadas", r.received.authorized.count, brl(r.received.authorized.amount)], []);
  section("Recebidas por CFOP", "CFOP", r.received.by_cfop);
  section("Recebidas por natureza (lançadas no ERP)", "Natureza", r.received.by_nature);
  section("Recebidas por situação", "Situação", r.received.by_status);
  tax("Impostos destacados nas recebidas", r.received.taxes);
  if (r.simples) {
    rows.push(["Receita por anexo do Simples Nacional"], ["Anexo", "Notas", "Valor (R$)", "Naturezas"],
      ...r.simples.by_annex.map((g) => [g.label, g.count, brl(g.amount), g.natures.join(", ")]),
      ...(r.simples.unassigned.natures.length ? [["Sem anexo informado", r.simples.unassigned.count, brl(r.simples.unassigned.amount), r.simples.unassigned.natures.join(", ")]] : []),
      ["Total", "", brl(r.simples.total)], []);
  }
  for (const n of r.notices) rows.push(["Aviso", n]);
  return BOM_CHAR + rows.map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
