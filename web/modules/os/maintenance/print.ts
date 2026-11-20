// OS4: impressão do contrato de manutenção em A4 (dados do Estabelecimento,
// cliente, objetos cobertos, cobertura, valores, vigência, condições e campo
// de assinatura). Função pura; quem chama abre com openPrint (work/print.ts).
import type { PrintCompany } from "../work/print";
import { printMoney } from "../work/print";
import { brDate, hoursText, type Contract } from "./types";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const phone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  const local = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  return local.length === 11 ? `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
    : local.length === 10 ? `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}` : value;
};
const documentLabel = (value?: string) => {
  const digits = (value || "").replace(/\D/g, "");
  if (digits.length === 14) return `CNPJ ${digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}`;
  if (digits.length === 11) return `CPF ${digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")}`;
  return value || "";
};
const PERIOD = { month: "por mês", quarter: "por trimestre", year: "por ano" } as const;

export function buildContractPrintHtml(contract: Contract, company: PrintCompany | null, now = Date.now()) {
  const c = contract.coverage;
  const limit = c.unit === "visits" ? `${c.limit} ${c.limit === 1 ? "visita" : "visitas"}` : `${hoursText(c.limit)} horas`;
  const excessPrice = c.excess_unit_cents === null ? "pelo orçamento da ordem" : `${printMoney(c.excess_unit_cents)} por ${c.unit === "visits" ? "visita" : "hora"} excedente`;
  const head = [
    company?.name ? `<h1>${escape(company.name)}</h1>` : "",
    [documentLabel(company?.document), company?.address, company?.phone ? phone(company.phone) : ""].filter(Boolean).map(v => `<div>${escape(v)}</div>`).join(""),
  ].join("");
  const facts: [string, string][] = [
    ["Cliente", [contract.customer.name, contract.customer.phone ? phone(contract.customer.phone) : ""].filter(Boolean).join(" · ") || "—"],
    ["Situação", contract.status_label],
    ["Vigência", `de ${brDate(contract.starts_on)} ${contract.ends_on ? `até ${brDate(contract.ends_on)}` : "por prazo indeterminado"}`],
    ["Plano", contract.plan ? `${contract.plan.name}${contract.plan.period_label ? ` (${contract.plan.period_label.toLowerCase()})` : ""}` : "—"],
    ["Valor", contract.subscription ? `${printMoney(contract.subscription.charge_cents)} ${contract.subscription.period_label.toLowerCase()}, cobrado pela assinatura` : contract.plan?.amount_cents != null ? printMoney(contract.plan.amount_cents) : "—"],
    ...(contract.adjustment ? [["Reajuste", `${String(contract.adjustment.percent).replace(".", ",")}% ao ano, a partir de ${brDate(contract.adjustment.on)}`] as [string, string]] : []),
    ["Emitido em", new Date(now).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })],
  ];
  const coverage: [string, string][] = [
    ["Modelos incluídos", c.type_labels.join(", ")],
    ...(c.services ? [["Serviços incluídos", c.services] as [string, string]] : []),
    ["Limite", `${limit} ${PERIOD[c.period]}`],
    ["Excedente", `${c.excess === "approval" ? "Com aprovação do cliente antes da execução" : "Cobrado no orçamento da ordem"}; ${excessPrice}`],
    ...(contract.visits ? [["Visitas programadas", contract.visits.text] as [string, string]] : []),
  ];
  const css = `@page{size:A4;margin:14mm}body{font:12px/1.45 system-ui,Arial,sans-serif;color:#111;margin:0}h1{font-size:18px;margin:0 0 2px}h2{font-size:15px;margin:14px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}dt{font-weight:600}dd{margin:0}ul{margin:4px 0;padding-left:18px}.terms{white-space:pre-wrap}.sign{margin-top:56px;display:flex;gap:32px}.sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}footer{margin-top:18px;color:#555;font-size:11px}`;
  const list = (rows: [string, string][]) => `<dl>${rows.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join("")}</dl>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escape(contract.display_number)}</title><style>${css}</style></head><body>
<header>${head}</header>
<h2>Contrato de manutenção · ${escape(contract.display_number)}</h2>
${list(facts)}
${contract.objects.length ? `<h2>Objetos cobertos</h2><ul>${contract.objects.map(o => `<li>${escape(o.type_label)}: ${escape(o.identifier)}</li>`).join("")}</ul>` : ""}
<h2>Cobertura</h2>
${list(coverage)}
${contract.terms ? `<h2>Condições</h2><div class="terms">${escape(contract.terms)}</div>` : ""}
<div class="sign"><div>${escape(company?.name || "Contratada")}</div><div>${escape(contract.customer.name || "Contratante")}</div></div>
<div class="sign"><div>Local e data: ______________________, ____/____/______</div></div>
${company?.footer ? `<footer>${escape(company.footer)}</footer>` : ""}
</body></html>`;
}
