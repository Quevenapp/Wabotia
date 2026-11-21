// Expedição: PDFs feitos no navegador, sem biblioteca nem rede (o mesmo
// gerador do DANFE, web/erp/app/lib/pdf-writer.ts, e o Code 128 de
// web/erp/app/lib/barcodes.ts):
// - etiqueta de volume 10 × 15 cm (uma por página) ou A4 com quatro por folha:
//   remetente, destinatário, endereço, pedido, volume N de M, peso e código de barras;
// - romaneio por transportadora: pedidos e volumes entregues, com espaço para assinatura.
// Puro: os testes do Node importam este arquivo.
import { code128 } from "./app/lib/barcodes.ts";
import { PdfPage, pdfDocument, textWidth, wrapText, type PdfFont } from "./app/lib/pdf-writer.ts";

export interface Party { name: string; street?: string | null; number?: string | null; complement?: string | null; district?: string | null;
  city?: string | null; state?: string | null; postal_code?: string | null; phone?: string | null; cnpj?: string | null }
export interface VolumeLabel { order_number: number; volume: number; volumes: number; barcode: string; recipient: Party; carrier: string | null;
  gross_weight_g: number | null; tracking_code: string | null }
export interface ManifestOrder { number: number; customer: string; city: string | null; state: string | null; shipped_on: string; volumes: number;
  gross_weight_g: number; tracking_code: string | null }
export interface ManifestCarrier { carrier: { id: string | null; name: string | null }; orders: ManifestOrder[]; volumes: number; gross_weight_g: number }

const postal = (v: string | null | undefined) => { const d = (v ?? "").replace(/\D/g, ""); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (v ?? ""); };
const kg = (g: number | null) => (g === null ? "—" : `${(g / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`);
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split("-").reverse().join("/") : v);
export const addressLines = (p: Party) => [
  [p.street, p.number].filter(Boolean).join(", ") + (p.complement ? ` — ${p.complement}` : ""),
  p.district ?? "", [p.city, p.state].filter(Boolean).join(" / "), p.postal_code ? `CEP ${postal(p.postal_code)}` : "",
].filter((line) => line.trim());

/** Barras do Code 128 como retângulos; sem como codificar, o texto. */
export function drawBarcode(page: PdfPage, x: number, y: number, w: number, h: number, value: string) {
  const bits = code128(value);
  if (!bits) { page.text(x, y + h / 2, value, { size: 8, font: "mono" }); return; }
  const module = w / bits.length;
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === "1") { const start = i; while (bits[i] === "1") i++; page.rect(x + start * module, y, (i - start) * module, h, { fill: true }); } else i++;
  }
}
function fit(page: PdfPage, x: number, y: number, text: string, width: number, size: number, font: PdfFont = "regular") {
  let s = size;
  while (s > 5 && textWidth(text, s, font) / (72 / 25.4) > width) s -= 0.5;
  page.text(x, y, text, { size: s, font });
}

/** Uma etiqueta no retângulo (x, y, w, h) em mm; o desenho é pensado para 100 × 150 e escala com a altura. */
export function drawLabel(page: PdfPage, x: number, y: number, w: number, h: number, label: VolumeLabel, sender: Party) {
  const k = h / 150, pad = 4 * k, inner = w - 2 * pad;
  page.rect(x, y, w, h, { width: 0.4 });
  let cy = y + pad + 3 * k;
  page.text(x + pad, cy, "REMETENTE", { size: 6 * k, font: "bold", gray: 0.35 });
  cy += 4 * k;
  fit(page, x + pad, cy, sender.name, inner, 8 * k, "bold");
  for (const line of addressLines(sender).slice(0, 2)) { cy += 3.6 * k; fit(page, x + pad, cy, line, inner, 6.5 * k); }
  cy += 3 * k;
  page.line(x, cy, x + w, cy, { width: 0.3 });
  cy += 5 * k;
  page.text(x + pad, cy, "DESTINATÁRIO", { size: 6.5 * k, font: "bold", gray: 0.35 });
  cy += 7 * k;
  for (const line of wrapText(label.recipient.name, inner * (72 / 25.4), 13 * k, "bold").slice(0, 2)) { page.text(x + pad, cy, line, { size: 13 * k, font: "bold" }); cy += 6 * k; }
  for (const line of addressLines(label.recipient).flatMap((l) => wrapText(l, inner * (72 / 25.4), 10 * k)).slice(0, 5)) { page.text(x + pad, cy, line, { size: 10 * k }); cy += 5 * k; }
  if (label.recipient.phone) { page.text(x + pad, cy, `Telefone: ${label.recipient.phone}`, { size: 8 * k }); cy += 4.5 * k; }
  cy += 1 * k;
  page.line(x, cy, x + w, cy, { width: 0.3 });
  // Pedido e volume N de M, grandes, para quem separa no caminhão.
  cy += 9 * k;
  page.text(x + pad, cy, `Pedido ${label.order_number}`, { size: 14 * k, font: "bold" });
  page.text(x + w - pad, cy, `Volume ${label.volume} de ${label.volumes}`, { size: 14 * k, font: "bold", align: "right" });
  cy += 6 * k;
  page.text(x + pad, cy, `Peso bruto: ${kg(label.gross_weight_g)}`, { size: 8.5 * k });
  if (label.carrier) fit(page, x + w / 2, cy, `Transportadora: ${label.carrier}`, w / 2 - pad, 8.5 * k);
  if (label.tracking_code) { cy += 4.5 * k; page.text(x + pad, cy, `Rastreio: ${label.tracking_code}`, { size: 8.5 * k, font: "mono" }); }
  const barH = 22 * k, barY = y + h - pad - barH - 5 * k;
  drawBarcode(page, x + pad + 4 * k, barY, inner - 8 * k, barH, label.barcode);
  page.text(x + w / 2, barY + barH + 4.5 * k, label.barcode, { size: 9 * k, font: "mono", align: "center" });
}

/** Etiquetas em PDF: "10x15" (uma por página de 100 × 150 mm) ou "a4" (quatro por folha, 2 × 2). */
export function labelsPdf(labels: readonly VolumeLabel[], sender: Party, format: "10x15" | "a4"): Uint8Array {
  const pages: PdfPage[] = [];
  if (format === "10x15") for (const label of labels) { const page = new PdfPage(100, 150); drawLabel(page, 2, 2, 96, 146, label, sender); pages.push(page); }
  else {
    const w = 98, h = 142, slots = [[5, 5], [107, 5], [5, 150], [107, 150]];
    labels.forEach((label, index) => {
      if (index % 4 === 0) pages.push(new PdfPage());
      const [x, y] = slots[index % 4];
      drawLabel(pages[pages.length - 1], x, y, w, h, label, sender);
    });
  }
  if (!pages.length) pages.push(new PdfPage(format === "10x15" ? 100 : 210, format === "10x15" ? 150 : 297));
  return pdfDocument(pages, { title: "Etiquetas de volume", producer: "Wabotia" });
}

export interface PickPrintRow { location: string | null; warehouse: string | null; description: string; code: string | null; unit: string | null; quantity: string; orders: string }
/** Lista de separação para imprimir: na ordem de caminhada, com a caixinha para marcar à mão. */
export function pickListPdf(number: number, rows: readonly PickPrintRow[], when: string): Uint8Array {
  const pages: PdfPage[] = [];
  const L = 12, R = 198;
  let page = new PdfPage(), y = 0;
  const head = () => {
    page = new PdfPage(); pages.push(page); y = 16;
    page.text(L, y, `Lista de separação ${number}`, { size: 15, font: "bold" });
    page.text(R, y, when, { size: 9, align: "right" });
    y += 9;
    ["", "Endereço", "Produto", "Qtd.", "Pedidos"].forEach((t, i) => page.text([L, L + 8, L + 40, L + 128, L + 146][i], y, t, { size: 8, font: "bold" }));
    y += 2; page.line(L, y, R, y, { width: 0.3 }); y += 6;
  };
  head();
  for (const r of rows) {
    if (y > 280) head();
    page.rect(L, y - 3.5, 4, 4, { width: 0.3 });
    fit(page, L + 8, y, [r.location, r.warehouse].filter(Boolean).join(" · ") || "—", 30, 9, "bold");
    fit(page, L + 40, y, `${r.description}${r.code ? ` (${r.code})` : ""}`, 86, 9);
    page.text(L + 140, y, `${r.quantity}${r.unit ? ` ${r.unit}` : ""}`, { size: 9, font: "bold", align: "right" });
    fit(page, L + 146, y, r.orders, R - L - 146, 8);
    y += 2.4; page.line(L, y, R, y, { width: 0.1, dash: true }); y += 5;
  }
  return pdfDocument(pages, { title: `Lista de separação ${number}`, producer: "Wabotia" });
}

/** Romaneio de expedição: uma seção por transportadora, com a lista e o espaço para assinatura de quem recebeu. */
export function manifestPdf(carriers: readonly ManifestCarrier[], sender: Party, period: { from: string; to: string }): Uint8Array {
  const pages: PdfPage[] = [];
  const L = 12, R = 198;
  const cols = [L, L + 20, L + 82, L + 122, L + 140, L + 162];
  for (const group of carriers.length ? carriers : [{ carrier: { id: null, name: null }, orders: [], volumes: 0, gross_weight_g: 0 }]) {
    let page = new PdfPage(), y = 0;
    const head = (continued: boolean) => {
      page = continued ? new PdfPage() : page;
      if (continued) pages.push(page);
      y = 16;
      page.text(L, y, "Romaneio de expedição", { size: 15, font: "bold" });
      page.text(R, y, `${day(period.from)}${period.to !== period.from ? ` a ${day(period.to)}` : ""}`, { size: 9, align: "right" });
      y += 7;
      page.text(L, y, `${sender.name}${sender.cnpj ? ` · CNPJ ${sender.cnpj}` : ""}`, { size: 9 });
      y += 5;
      page.text(L, y, `Transportadora: ${group.carrier.name ?? "Sem transportadora (entrega própria ou retirada)"}`, { size: 10, font: "bold" });
      y += 8;
      ["Pedido", "Cliente", "Cidade / UF", "Volumes", "Peso bruto", "Rastreio"].forEach((t, i) => page.text(cols[i], y, t, { size: 8, font: "bold" }));
      y += 2;
      page.line(L, y, R, y, { width: 0.3 });
      y += 5;
    };
    pages.push(page);
    head(false);
    for (const o of group.orders) {
      if (y > 240) head(true);
      page.text(cols[0], y, String(o.number), { size: 8.5 });
      fit(page, cols[1], y, o.customer, 60, 8.5);
      fit(page, cols[2], y, [o.city, o.state].filter(Boolean).join(" / "), 38, 8.5);
      page.text(cols[3] + 10, y, String(o.volumes), { size: 8.5, align: "right" });
      page.text(cols[4] + 18, y, kg(o.gross_weight_g), { size: 8.5, align: "right" });
      fit(page, cols[5], y, o.tracking_code ?? "", R - cols[5], 8, "mono");
      y += 2.2;
      page.line(L, y, R, y, { width: 0.1, dash: true });
      y += 4.3;
    }
    y += 2;
    page.text(L, y, `${group.orders.length} pedido${group.orders.length === 1 ? "" : "s"} · ${group.volumes} volume${group.volumes === 1 ? "" : "s"} · ${kg(group.gross_weight_g)}`, { size: 9.5, font: "bold" });
    // Assinatura de quem recebeu os volumes.
    const sy = Math.max(y + 18, 250);
    page.text(L, sy - 10, "Recebi os volumes acima em perfeito estado.", { size: 8.5 });
    page.line(L, sy, L + 80, sy, { width: 0.3 });
    page.text(L, sy + 4, "Nome legível de quem recebeu", { size: 7.5 });
    page.line(L + 90, sy, L + 135, sy, { width: 0.3 });
    page.text(L + 90, sy + 4, "Documento", { size: 7.5 });
    page.line(L + 145, sy, R, sy, { width: 0.3 });
    page.text(L + 145, sy + 4, "Data e hora", { size: 7.5 });
    page.line(L, sy + 18, L + 110, sy + 18, { width: 0.3 });
    page.text(L, sy + 22, "Assinatura", { size: 7.5 });
  }
  return pdfDocument(pages, { title: "Romaneio de expedição", producer: "Wabotia" });
}
