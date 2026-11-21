// PDF da proposta e do pedido igual à impressão da tela: o mesmo modelo
// (web/erp/app/lib/document-print-model.ts, documentPrintModel) que a
// DocumentPrintSheet do painel desenha, na mesma ordem: cabeçalho com a
// empresa e o logotipo, empresa, cliente, datas (validade), endereço de
// entrega, itens, totais, condições de pagamento, parcelas, entrega,
// observações e o rodapé "Documento comercial sem validade fiscal".
// Só o que a impressão normal mostra ao cliente; nada interno.
import { PdfPage, wrapText } from "../../../web/erp/app/lib/pdf-writer.ts";
import type { DocumentPrintModel } from "../../../web/erp/app/lib/document-print-model.ts";
import { drawImage, pdfDocumentWithImage, type PdfImage } from "./pdf-image.ts";

const M = 14, W = 210 - 2 * M, BOTTOM = 280;
type Model = Pick<DocumentPrintModel, "title" | "number" | "titleNumber" | "company" | "cancelled" | "template" | "showContact" | "contactLabel" | "contact" |
  "contactCode" | "expectedDate" | "validUntil" | "details" | "deliveryAddress" | "items" | "totals" | "showTotals" | "paymentTerms" | "installments" |
  "showDueDates" | "dueLabel" | "deliveryTerms" | "notes" | "footer" | "version" | "date" | "columns">;

export function printModelPdf(model: Model, extra: { status: string | null; logo: PdfImage | null }): Uint8Array {
  const pages: PdfPage[] = [];
  let page = new PdfPage(), y = 0;
  const heading = `${model.title}${model.titleNumber ? ` nº ${model.number}` : ""}`;
  const start = (continued: boolean) => {
    page = new PdfPage(); pages.push(page); y = M + 2;
    if (continued) { page.text(M, y + 3, `${heading} (continuação)`, { size: 10, font: "bold" }); y += 8; }
  };
  const need = (height: number) => { if (y + height > BOTTOM) { start(true); return true; } return false; };
  const section = (title: string) => { need(10); y += 2; page.text(M, y, title, { size: 8, font: "bold", gray: 0.35 }); y += 4.5; };
  const lines = (text: string, size = 9, max = 40) => { for (const line of wrapText(text, W, size).slice(0, max)) { need(5); page.text(M, y, line, { size }); y += size * 0.5; } };

  start(false);
  // Cabeçalho: logotipo, "Empresa · Documento comercial", título; à direita nº, data e versão · situação.
  let left = M;
  if (extra.logo) {
    const h = 16, w = Math.min(40, h * extra.logo.width / extra.logo.height);
    drawImage(page, M, y, w, h);
    left = M + w + 4;
  }
  const brand = model.company?.tradeName || model.company?.legalName;
  page.text(left, y + 4, `${brand ? `${brand} · ` : ""}Documento comercial`, { size: 8, gray: 0.35 });
  page.text(left, y + 11, heading, { size: 14, font: "bold" });
  page.text(M + W, y + 4, `Nº ${model.number}`, { size: 9, font: "bold", align: "right" });
  if (model.date) page.text(M + W, y + 9, `Data ${model.date}`, { size: 8.5, align: "right" });
  page.text(M + W, y + 14, [`Versão ${model.version}`, extra.status].filter(Boolean).join(" · "), { size: 8.5, align: "right" });
  y += extra.logo ? 19 : 17;
  page.text(M, y, "Documento comercial sem validade fiscal", { size: 7, gray: 0.4 });
  y += 2;
  page.line(M, y, M + W, y, { width: 0.4 });
  y += 5;

  if (model.company) {
    section("Empresa");
    const c = model.company;
    page.text(M, y, c.legalName, { size: 9.5, font: "bold" }); y += 4.5;
    for (const line of [c.tradeName, `${c.cnpj && c.cnpj.replace(/\D/g, "").length === 11 ? "CPF" : "CNPJ"}: ${c.cnpj}${c.ie ? ` · IE: ${c.ie}` : ""}`,
      [c.address, c.district].filter(Boolean).join(" · "), `${c.city} · CEP ${c.postalCode}`, [c.email, c.phone].filter(Boolean).join(" · ")].filter(Boolean) as string[]) {
      page.text(M, y, line, { size: 8.5 }); y += 4;
    }
  } else { page.text(M, y, "Identificação da empresa ainda não cadastrada.", { size: 8, gray: 0.4 }); y += 4; }
  if (model.cancelled || model.template) { need(8); y += 2; page.text(M, y, model.cancelled ? "DOCUMENTO CANCELADO" : "MODELO DE PROPOSTA", { size: 10, font: "bold" }); y += 5; }

  if (model.showContact) {
    section(model.contactLabel);
    const k = model.contact;
    page.text(M, y, k.name, { size: 9.5, font: "bold" }); y += 4.5;
    for (const line of [model.contactCode ? `Código: ${model.contactCode}` : null, k.tradeName && k.tradeName !== k.name ? k.tradeName : null,
      k.document ? `CPF / CNPJ: ${k.document}` : null, k.address || null,
      [k.district, k.city, k.postalCode ? `CEP ${k.postalCode}` : null].filter(Boolean).join(" · ") || null, k.email || null, k.phones || null].filter(Boolean) as string[]) {
      need(5); page.text(M, y, line, { size: 8.5 }); y += 4;
    }
  }
  const dates = [model.expectedDate ? ["Data prevista", model.expectedDate] : null, model.validUntil ? ["Validade da proposta", model.validUntil] : null,
    ...model.details.map(row => [row.label, row.value])].filter(Boolean) as string[][];
  if (dates.length) { need(8); y += 2; page.text(M, y, dates.map(([label, value]) => `${label}: ${value}`).join("     "), { size: 9 }); y += 5; }
  if (model.deliveryAddress) {
    section("Endereço de entrega");
    const d = model.deliveryAddress;
    for (const line of [d.name, d.address, [d.district, d.city, d.postalCode ? `CEP ${d.postalCode}` : null].filter(Boolean).join(" · ")].filter(Boolean) as string[]) { page.text(M, y, line, { size: 8.5 }); y += 4; }
  }

  // Itens: as colunas da tela (Item, Descrição / código, Un., Quantidade, Preço unitário, Desc. %, Total).
  section("Itens");
  const values = model.columns.values, col = { pos: M + 1, desc: M + (model.columns.position ? 9 : 1), unit: M + 104, qty: M + 126, price: M + 148, disc: M + 162, total: M + W - 1 };
  const head = () => {
    page.rect(M, y - 4, W, 6, { fill: true });
    const h = { size: 7.5, font: "bold" as const, gray: 1 };
    if (model.columns.position) page.text(col.pos, y, "Item", h);
    page.text(col.desc, y, "Descrição / código", h);
    page.text(col.unit, y, "Un.", h);
    if (model.columns.quantity) page.text(col.qty, y, "Quantidade", { ...h, align: "right" });
    if (values) { page.text(col.price, y, "Preço unitário", { ...h, align: "right" }); page.text(col.disc, y, "Desc. %", { ...h, align: "right" }); page.text(col.total, y, "Total", { ...h, align: "right" }); }
    y += 6;
  };
  head();
  if (!model.items.length) { page.text(M, y, "Sem itens registrados.", { size: 8.5 }); y += 5; }
  for (const item of model.items) {
    const text = wrapText(item.description, values ? 92 : 150, 8.5).slice(0, 8);
    const sub = [item.code ? `Código: ${item.code}` : null, item.detailedDescription].filter(Boolean).join(" · ");
    const subLines = sub ? wrapText(sub, values ? 92 : 150, 7.5).slice(0, 4) : [];
    if (need((text.length + subLines.length) * 4 + 3)) head();
    if (model.columns.position) page.text(col.pos, y, String(item.position), { size: 8 });
    text.forEach((line, index) => page.text(col.desc, y + index * 4, line, { size: 8.5 }));
    subLines.forEach((line, index) => page.text(col.desc, y + (text.length + index) * 4, line, { size: 7.5, gray: 0.35 }));
    page.text(col.unit, y, item.unit ?? "", { size: 8.5 });
    if (model.columns.quantity) page.text(col.qty, y, item.quantity, { size: 8.5, align: "right" });
    if (values) {
      page.text(col.price, y, item.price, { size: 8.5, align: "right" });
      page.text(col.disc, y, item.discount, { size: 8.5, align: "right" });
      page.text(col.total, y, item.total, { size: 8.5, align: "right" });
    }
    y += (text.length + subLines.length) * 4 + 1;
    page.line(M, y - 2, M + W, y - 2, { width: 0.1, dash: true });
    y += 1;
  }
  if (model.showTotals) {
    need(8 + model.totals.length * 5);
    y += 2;
    model.totals.forEach((row, index) => {
      const last = index === model.totals.length - 1;
      page.text(col.disc, y, row.label, { size: last ? 10 : 8.5, font: last ? "bold" : "regular", align: "right" });
      page.text(col.total, y, row.value, { size: last ? 10 : 8.5, font: last ? "bold" : "regular", align: "right" });
      y += last ? 6 : 4.5;
    });
  }
  if (model.paymentTerms) { section("Condições de pagamento"); lines(model.paymentTerms); }
  if (model.installments.length && values) {
    section("Parcelas planejadas");
    for (const row of model.installments.slice(0, 48)) {
      need(5);
      page.text(M, y, `${row.position}ª`, { size: 8.5 });
      if (model.showDueDates) page.text(M + 12, y, `${model.dueLabel}: ${row.dueDate}`, { size: 8.5 });
      if (row.method) page.text(M + 70, y, String(row.method).slice(0, 50), { size: 8.5 });
      page.text(M + W, y, row.amount, { size: 8.5, align: "right" });
      y += 4.5;
    }
    page.text(M, y, "Não constitui boleto nem cobrança.", { size: 7, gray: 0.4 }); y += 4;
  }
  if (model.deliveryTerms) { section("Entrega / prazo"); lines(model.deliveryTerms); }
  if (model.notes) { section("Observações"); lines(model.notes); }
  if (model.footer) { need(8); y += 3; page.text(M, y, model.footer, { size: 7.5, gray: 0.35 }); }
  pages.forEach((item, index) => {
    item.text(M, 290, `${heading} · versão ${model.version} · Documento comercial sem validade fiscal.`, { size: 7, gray: 0.4 });
    item.text(M + W, 290, `Página ${index + 1} de ${pages.length}`, { size: 7, align: "right", gray: 0.4 });
  });
  return pdfDocumentWithImage(pages, extra.logo, { title: heading, producer: "Wabotia" });
}
