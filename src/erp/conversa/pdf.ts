// PDF da proposta comercial e do pedido de venda para o envio pela conversa.
// O painel imprime pelo navegador (DocumentPrintPreview); aqui o servidor monta
// uma via simples em A4 com o mesmo escritor de PDF do DANFE do painel
// (web/erp/app/lib/pdf-writer.ts: sem rede, sem script, fontes padrão).
// Só o que o cliente recebe impresso: identificação da empresa, cliente,
// itens, totais, condições e parcelas. Nada de observação interna.
import { PdfPage, pdfDocument, wrapText } from "../../../web/erp/app/lib/pdf-writer.ts";
import { day, decimalCents, money } from "./rules.ts";

export interface PrintableItem { code: string | null; description: string; unit: string; quantity: string; unit_price: string; total: string }
export interface PrintableDocument {
  title: string;
  number: string;
  status: string | null;
  date: string | null;
  valid_until: string | null;
  company: { name: string; document: string | null; contact: string | null; city: string | null } | null;
  customer: { name: string; document: string | null; city: string | null };
  items: readonly PrintableItem[];
  totals: { subtotal: string | null; discount: string | null; freight: string | null; total: string };
  payment_terms: string | null;
  delivery_terms: string | null;
  notes: string | null;
  installments: readonly { due_date: string; amount: string }[];
}

const MARGIN = 14, WIDTH = 210 - 2 * MARGIN, BOTTOM = 280;
const decimal = (value: string) => {
  if (!/^\d+(\.\d+)?$/.test(value)) return value;
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (trimmed ? `,${trimmed}` : "");
};
const reais = (value: string | null) => value === null ? "" : money(decimalCents(value)) ?? value;

export function documentPdf(doc: PrintableDocument): Uint8Array {
  const pages: PdfPage[] = [];
  let page = new PdfPage(), y = 0;
  const start = () => { page = new PdfPage(); pages.push(page); y = MARGIN + 4; };
  const need = (height: number) => { if (y + height <= BOTTOM) return false; start(); header(true); return true; };
  const header = (continued = false) => {
    if (doc.company) {
      page.text(MARGIN, y, doc.company.name, { size: 11, font: "bold" });
      const line = [doc.company.document, doc.company.city, doc.company.contact].filter(Boolean).join(" · ");
      if (line) page.text(MARGIN, y + 5, line, { size: 8, gray: 0.3 });
      y += 11;
    }
    page.text(MARGIN, y + 2, `${doc.title} nº ${doc.number}${continued ? " (continuação)" : ""}`, { size: 13, font: "bold" });
    y += 6;
    page.line(MARGIN, y, MARGIN + WIDTH, y, { width: 0.4 });
    y += 6;
  };
  start();
  header();
  const facts = [["Data", day(doc.date)], ["Válida até", day(doc.valid_until)], ["Situação", doc.status]].filter(([, value]) => value);
  page.text(MARGIN, y, facts.map(([label, value]) => `${label}: ${value}`).join("     "), { size: 9 });
  y += 7;
  page.text(MARGIN, y, "Cliente", { size: 8, font: "bold", gray: 0.35 });
  y += 5;
  page.text(MARGIN, y, doc.customer.name, { size: 10, font: "bold" });
  y += 5;
  const customerLine = [doc.customer.document, doc.customer.city].filter(Boolean).join(" · ");
  if (customerLine) { page.text(MARGIN, y, customerLine, { size: 9 }); y += 5; }
  y += 3;

  // Itens: código, descrição, quantidade, unitário e total.
  const columns = { code: MARGIN, description: MARGIN + 22, quantity: MARGIN + 128, price: MARGIN + 156, total: MARGIN + WIDTH };
  const head = () => {
    page.rect(MARGIN, y - 4, WIDTH, 6, { fill: true });
    page.text(columns.code + 1, y, "Código", { size: 8, font: "bold", gray: 1 });
    page.text(columns.description, y, "Descrição", { size: 8, font: "bold", gray: 1 });
    page.text(columns.quantity, y, "Qtd.", { size: 8, font: "bold", align: "right", gray: 1 });
    page.text(columns.price, y, "Unitário", { size: 8, font: "bold", align: "right", gray: 1 });
    page.text(columns.total - 1, y, "Total", { size: 8, font: "bold", align: "right", gray: 1 });
    y += 6;
  };
  head();
  for (const item of doc.items) {
    const lines = wrapText(item.description, 96, 8.5).slice(0, 6);
    if (need(lines.length * 4 + 3)) head();
    page.text(columns.code + 1, y, (item.code ?? "").slice(0, 14), { size: 8 });
    lines.forEach((line, index) => page.text(columns.description, y + index * 4, line, { size: 8.5 }));
    page.text(columns.quantity, y, `${decimal(item.quantity)} ${item.unit}`.trim(), { size: 8.5, align: "right" });
    page.text(columns.price, y, reais(item.unit_price), { size: 8.5, align: "right" });
    page.text(columns.total - 1, y, reais(item.total), { size: 8.5, align: "right" });
    y += lines.length * 4 + 1;
    page.line(MARGIN, y - 2, MARGIN + WIDTH, y - 2, { width: 0.1, dash: true });
    y += 1;
  }
  need(30);
  y += 3;
  const total = (label: string, value: string | null, bold = false) => {
    if (value === null || value === "0.00" && !bold) return;
    page.text(columns.price, y, label, { size: bold ? 10 : 9, font: bold ? "bold" : "regular", align: "right" });
    page.text(columns.total - 1, y, reais(value), { size: bold ? 10 : 9, font: bold ? "bold" : "regular", align: "right" });
    y += bold ? 6 : 5;
  };
  total("Subtotal", doc.totals.subtotal);
  total("Desconto", doc.totals.discount);
  total("Frete", doc.totals.freight);
  total("Total", doc.totals.total, true);
  y += 2;
  if (doc.installments.length) {
    need(6 + doc.installments.length * 4);
    page.text(MARGIN, y, "Parcelas", { size: 8, font: "bold", gray: 0.35 });
    y += 5;
    for (const [index, part] of doc.installments.slice(0, 24).entries()) {
      need(5);
      page.text(MARGIN, y, `${index + 1}ª  ${day(part.due_date) ?? part.due_date}  ${reais(part.amount)}`, { size: 9 });
      y += 4.5;
    }
    y += 2;
  }
  for (const [label, value] of [["Condições de pagamento", doc.payment_terms], ["Prazo de entrega", doc.delivery_terms], ["Observações", doc.notes]] as const) {
    if (!value) continue;
    const lines = wrapText(value, WIDTH, 9).slice(0, 30);
    need(6 + lines.length * 4.5);
    page.text(MARGIN, y, label, { size: 8, font: "bold", gray: 0.35 });
    y += 5;
    for (const line of lines) { page.text(MARGIN, y, line, { size: 9 }); y += 4.5; }
    y += 2;
  }
  pages.forEach((item, index) => item.text(MARGIN + WIDTH, 290, `Página ${index + 1} de ${pages.length}`, { size: 7, align: "right", gray: 0.4 }));
  return pdfDocument(pages, { title: `${doc.title} nº ${doc.number}`, producer: "Vinki" });
}
