// CSV do relatório de IBS, CBS e IS para o contador: separador ponto e
// vírgula, vírgula decimal e BOM, como o relatório fiscal do contador
// (src/erp/contador/report.ts). Sem I/O.

export interface ReformReportLine {
  month: string;
  cst: string;
  cclasstrib: string;
  description: string;
  notes: number;
  items: number;
  base: string;
  cbs: string;
  ibs_uf: string;
  ibs_mun: string;
  ibs: string;
  selective: string;
}

export interface ReformReport {
  from: string;
  to: string;
  environment: string;
  lines: ReformReportLine[];
  totals: { notes: number; base: string; cbs: string; ibs_uf: string; ibs_mun: string; ibs: string; selective: string };
  without_reform: number;
  table?: { version: string };
}

const BOM = "﻿";
const brl = (value: string) => value.replace(".", ",");
const date = (value: string) => value.split("-").reverse().join("/");
const cell = (value: string | number) => {
  const t = typeof value === "number" ? String(value) : String(value).replace(/[\r\n]+/g, " ");
  // Planilha não executa fórmula vinda de dado (número negativo continua número).
  const safe = typeof value === "string" && /^[=+\-@\t]/.test(t) && !/^-?\d+(,\d+)?$/.test(t) ? `'${t}` : t;
  return /[;"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function reformReportCsv(report: ReformReport): string {
  const rows: (string | number)[][] = [
    ["IBS, CBS e IS das NF-e autorizadas", `${date(report.from)} a ${date(report.to)}`],
    ["Ambiente", report.environment === "homologacao" ? "Homologação (teste)" : "Produção"],
    ["Tabela de classificações", report.table?.version ?? ""],
    [],
    ["Mês", "CST", "Classificação (cClassTrib)", "Descrição", "Notas", "Itens", "Base (R$)", "CBS (R$)", "IBS estadual (R$)", "IBS municipal (R$)", "IBS (R$)", "IS (R$)"],
    ...report.lines.map((l) => [l.month, l.cst, l.cclasstrib, l.description, l.notes, l.items, brl(l.base), brl(l.cbs), brl(l.ibs_uf), brl(l.ibs_mun), brl(l.ibs), brl(l.selective)]),
    ["Total", "", "", "", report.totals.notes, "", brl(report.totals.base), brl(report.totals.cbs), brl(report.totals.ibs_uf), brl(report.totals.ibs_mun), brl(report.totals.ibs), brl(report.totals.selective)],
  ];
  if (report.without_reform > 0)
    rows.push([], ["Aviso", `${report.without_reform} nota(s) autorizada(s) no período sem cálculo da reforma (emitidas antes do cálculo ou sem classificação).`]);
  rows.push([], ["Aviso", "Em 2026 IBS e CBS são informativos (alíquotas de teste de 0,9% e 0,1%): não mudam o total das notas. Confira com a apuração oficial."]);
  return BOM + rows.map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
