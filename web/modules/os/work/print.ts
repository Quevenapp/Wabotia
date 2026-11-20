// OS3: impressão do orçamento e da ordem de serviço, em A4 ou cupom de 80 mm.
// Página pronta para imprimir ou salvar em PDF pelo navegador. Função pura:
// recebe a ordem já autorizada para a pessoa e os dados do Estabelecimento.
import type { Order, QuoteItem, QuoteTerms } from "../work-contracts";

export type PrintFormat = "a4" | "cupom";
export type PrintKind = "quote" | "order";
export interface PrintCompany { name?: string; document?: string; address?: string; phone?: string; footer?: string }
export interface PrintInput {
  order: Order;
  company: PrintCompany | null;
  /** reserved: área sensível (saúde, ensino, jurídico); itens genéricos. */
  privacy?: "commercial" | "reserved";
  /** Recebido até agora, para a ordem de serviço. */
  received_cents?: number;
  /** Instante da impressão (testes fixam). */
  now?: number;
}

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export const printMoney = (cents: number | null | undefined) => {
  const value = Math.round(Number(cents ?? 0)), abs = Math.abs(value);
  return `${value < 0 ? "-" : ""}R$ ${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(abs % 100).padStart(2, "0")}`;
};
const civil = (date: string) => { const [y, m, d] = date.split("-"); return `${d}/${m}/${y}`; };
const day = (at?: number | null) => at == null ? "" :
  new Date(at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
const lineGross = (item: QuoteItem) => {
  const [whole, fraction = ""] = String(item.quantity).split(".");
  const scale = 10 ** fraction.length;
  return Math.round(Number(whole + fraction) * item.unit_cents / scale);
};
const quantity = (value: number) => String(value).replace(".", ",");
const documentLabel = (doc?: string) => !doc ? "" : /^\d{11}$/.test(doc) ? `CPF ${doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")}`
  : doc.length === 14 ? `CNPJ ${doc.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5")}` : doc;
const phone = (value?: string) => {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  return digits.length === 11 ? `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    : digits.length === 10 ? `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}` : value ?? "";
};

/** Texto das condições: forma, pagador e parcelas (ou só o total combinado). */
export function conditionsLines(order: Order) {
  const quote = order.quote, terms = quote?.terms as QuoteTerms | null | undefined;
  const lines: string[] = [];
  if (terms?.method_label) lines.push(`Forma de pagamento: ${terms.method_label}`);
  if (terms?.payer_name) lines.push(`Pagador: ${terms.payer_name}`);
  const parts = quote?.installments ?? [];
  if (parts.length > 1) parts.forEach(p => lines.push(`Parcela ${p.number}/${parts.length}: ${printMoney(p.amount_cents)} em ${civil(p.due_on)}`));
  else if (parts.length === 1) lines.push(`À vista: ${printMoney(parts[0].amount_cents)} em ${civil(parts[0].due_on)}`);
  else if (quote) lines.push(`Total combinado: ${printMoney(quote.total_cents)}`);
  return lines;
}
/** Garantia: a da entrega, se já entregue; senão a do modelo. */
export function warrantyLine(order: Order) {
  if (order.warranty_until) return `Garantia até ${day(order.warranty_until)}.`;
  const days = order.features?.warranty_days;
  if (days === undefined || days === null) return "";
  return days > 0 ? `Garantia de ${days} ${days === 1 ? "dia" : "dias"}, contada da entrega.` : "Sem garantia.";
}

export function buildPrintHtml(input: PrintInput, kind: PrintKind, format: PrintFormat) {
  const { order, company } = input, quote = order.quote, reserved = input.privacy === "reserved";
  const labels = order.labels ?? { singular: "Ordem de serviço", item: "Item", problem: "Problema", customer_singular: "Cliente" } as Order["labels"];
  const title = kind === "quote" ? `Orçamento · ${labels.singular} ${order.display_number ?? order.number}` : `${labels.singular} ${order.display_number ?? order.number}`;
  const items = (quote?.items ?? []).map(item => ({
    description: reserved ? "Serviço contratado" : item.description,
    code: reserved ? "" : item.code ?? "",
    quantity: quantity(item.quantity), unit: item.unit_cents, discount: item.discount_cents ?? 0, total: lineGross(item) - (item.discount_cents ?? 0),
  }));
  const object = order.object;
  const visibleFields = reserved ? [] : (order.fields ?? []).filter(f => f.client_visible && !f.sensitive && order.extra?.[f.id] !== undefined && order.extra?.[f.id] !== null && order.extra?.[f.id] !== "");
  const head = [
    company?.name ? `<h1>${escape(company.name)}</h1>` : "",
    [documentLabel(company?.document), company?.address, company?.phone ? phone(company.phone) : ""].filter(Boolean).map(v => `<div>${escape(v)}</div>`).join(""),
  ].join("");
  const facts: [string, string][] = [
    [labels.customer_singular || "Cliente", [order.customer?.name, order.customer?.phone ? phone(order.customer.phone) : ""].filter(Boolean).join(" · ") || "—"],
    ...(object ? [[object.type.labels.singular, [object.identifier, ...object.type.fields.filter(f => f.client_visible && !f.sensitive && f.id !== object.type.identifier_field_id && object.values[f.id] != null && object.values[f.id] !== "").map(f => `${f.label}: ${object.values[f.id] === true ? "Sim" : object.values[f.id] === false ? "Não" : object.values[f.id]}`)].filter(Boolean).join(" · ")] as [string, string]] : []),
    [labels.item || "Item", order.item],
    ...(reserved ? [] : [[labels.problem || "Problema", order.problem] as [string, string]]),
    ...visibleFields.map(f => [f.label, String(order.extra[f.id] === true ? "Sim" : order.extra[f.id] === false ? "Não" : order.extra[f.id])] as [string, string]),
    ["Emitido em", day(input.now ?? Date.now())],
    ...(kind === "quote" && quote?.valid_until ? [["Válido até", day(quote.valid_until)] as [string, string]] : []),
    ...(kind === "order" ? [["Situação", order.stage_label || order.status_label]] as [string, string][] : []),
  ];
  const discount = (quote?.items_discount_cents ?? 0) + (quote?.discount_cents ?? 0);
  const totals: [string, string][] = quote ? [
    ...(discount ? [["Subtotal", printMoney(quote.subtotal_cents ?? quote.total_cents + discount)], ["Descontos", `- ${printMoney(discount)}`]] as [string, string][] : []),
    ["Total", printMoney(quote.total_cents)],
    ...(kind === "order" && input.received_cents ? [["Recebido", printMoney(input.received_cents)], ["Saldo", printMoney(Math.max(0, quote.total_cents - input.received_cents))]] as [string, string][] : []),
  ] : [];
  const table = items.length ? format === "a4"
    ? `<table><thead><tr><th>Descrição</th><th>Código</th><th class="n">Qtd.</th><th class="n">Unitário</th><th class="n">Desconto</th><th class="n">Total</th></tr></thead><tbody>${items.map(i =>
        `<tr><td>${escape(i.description)}</td><td>${escape(i.code)}</td><td class="n">${escape(i.quantity)}</td><td class="n">${printMoney(i.unit)}</td><td class="n">${i.discount ? printMoney(i.discount) : ""}</td><td class="n">${printMoney(i.total)}</td></tr>`).join("")}</tbody></table>`
    : items.map(i => `<div class="item"><div>${escape(i.description)}${i.code ? ` (${escape(i.code)})` : ""}</div><div class="row"><span>${escape(i.quantity)} x ${printMoney(i.unit)}${i.discount ? ` - ${printMoney(i.discount)}` : ""}</span><span>${printMoney(i.total)}</span></div></div>`).join("")
    : `<p>Sem itens no orçamento.</p>`;
  const conditions = quote ? conditionsLines(order) : [];
  const warranty = warrantyLine(order);
  const css = format === "a4"
    ? `@page{size:A4;margin:14mm}body{font:12px/1.45 system-ui,Arial,sans-serif;color:#111;margin:0}h1{font-size:18px;margin:0 0 2px}h2{font-size:15px;margin:14px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border-bottom:1px solid #ccc;padding:4px;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}dt{font-weight:600}dd{margin:0}.totals{margin-left:auto;width:45%}.totals div{display:flex;justify-content:space-between}.totals div:last-child{font-weight:700}.sign{margin-top:48px;display:flex;gap:32px}.sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}footer{margin-top:18px;color:#555;font-size:11px}`
    : `@page{size:80mm auto;margin:3mm}body{font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#000;margin:0;width:74mm}h1{font-size:13px;margin:0;text-align:center}header div{text-align:center}h2{font-size:12px;margin:8px 0 4px;border-top:1px dashed #000;padding-top:4px}dl{margin:0}dt{font-weight:700;display:inline}dt::after{content:": "}dd{display:inline;margin:0}dd::after{content:"";display:block}.item{margin:2px 0}.row,.totals div{display:flex;justify-content:space-between}.totals div:last-child{font-weight:700}.sign{margin-top:28px}.sign div{border-top:1px solid #000;padding-top:2px;text-align:center;margin-top:24px}footer{margin-top:8px;text-align:center}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${css}</style></head><body>
<header>${head}</header>
<h2>${escape(title)}</h2>
<dl>${facts.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join("")}</dl>
<h2>Itens</h2>${table}
${totals.length ? `<div class="totals">${totals.map(([k, v]) => `<div><span>${escape(k)}</span><span>${escape(v)}</span></div>`).join("")}</div>` : ""}
${conditions.length ? `<h2>Condições</h2>${conditions.map(line => `<div>${escape(line)}</div>`).join("")}` : ""}
${quote?.note && !reserved ? `<h2>Observação</h2><div>${escape(quote.note)}</div>` : ""}
${warranty ? `<h2>Garantia</h2><div>${escape(warranty)}</div>` : ""}
<div class="sign"><div>${escape(kind === "quote" ? "De acordo do cliente" : "Assinatura do cliente")}</div><div>Data: ____/____/______</div></div>
${company?.footer ? `<footer>${escape(company.footer)}</footer>` : ""}
</body></html>`;
}

/** Abre a página numa janela própria e chama a impressão (ou PDF) do navegador. */
export function openPrint(html: string) {
  const win = window.open("", "_blank", "width=900,height=900");
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  return true;
}
