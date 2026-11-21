// PDF do boleto de uma conta a receber, para o envio pela conversa. Os dados
// vêm do que o ERP já tem (a prévia do boleto da cobrança no banco: código de
// barras e linha digitável; a empresa; o cliente; a conta): nada é calculado
// de novo além do desenho. No layout comum de boleto: recibo do pagador em
// cima e ficha de compensação embaixo, com o código de barras intercalado
// 2 de 5 (ITF, 44 dígitos) desenhado em barras.
// Sem banco e sem rede: os testes do Node importam este arquivo.
import { PdfPage, pdfDocument, wrapText } from "../../../web/erp/app/lib/pdf-writer.ts";
import { qrMatrix } from "../../../web/erp/app/lib/barcodes.ts";
import { day, money } from "./rules.ts";

export interface BoletoData {
  bank: string;
  /** 44 dígitos. */
  barcode: string;
  /** 47 dígitos (com ou sem pontuação). */
  digitable_line: string;
  amount_cents: string;
  due_on: string;
  our_number: string;
  document_number: string | null;
  issued_on: string | null;
  beneficiary: { name: string | null; document: string | null; address: string | null };
  payer: { name: string | null; document: string | null; address: string | null };
  instructions: readonly string[];
  // Boleto registrado pela API do banco (src/erp/boleto-api), qualquer banco:
  /** "Agência / Código do beneficiário" como o banco informa; sem ele, o do Itaú carteira 109 pelo campo livre. */
  agency_code?: string | null;
  /** Carteira; sem ela, a do Itaú pelo campo livre. */
  wallet?: string | null;
  /** Pix copia e cola do boleto híbrido: QR Code ao lado do código de barras. */
  pix_code?: string | null;
  /** Registrado na homologação do banco: marca "sem valor" no PDF. */
  sandbox?: boolean;
}

const BANKS: Record<string, string> = { "341": "Itaú", "001": "Banco do Brasil", "237": "Bradesco", "033": "Santander", "104": "Caixa", "077": "Inter", "756": "Sicoob" };

/** Dígito do código de barras (módulo 11, posição 5). */
export function barcodeDigit(code43: string): number {
  let sum = 0, weight = 2;
  for (let i = code43.length - 1; i >= 0; i--) { sum += Number(code43[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const rest = 11 - (sum % 11);
  return rest === 0 || rest === 10 || rest === 11 ? 1 : rest;
}
const mod10 = (digits: string) => {
  let sum = 0, factor = 2;
  for (let i = digits.length - 1; i >= 0; i--) { const p = Number(digits[i]) * factor; sum += p > 9 ? p - 9 : p; factor = factor === 2 ? 1 : 2; }
  return (10 - (sum % 10)) % 10;
};
/** Linha digitável (47 dígitos) a partir do código de barras. */
export function digitableFromBarcode(barcode: string): string {
  const free = barcode.slice(19);
  const a = barcode.slice(0, 4) + free.slice(0, 5), b = free.slice(5, 15), c = free.slice(15, 25);
  return `${a}${mod10(a)}${b}${mod10(b)}${c}${mod10(c)}${barcode[4]}${barcode.slice(5, 19)}`;
}
export const formatDigitable = (line: string) =>
  `${line.slice(0, 5)}.${line.slice(5, 10)} ${line.slice(10, 15)}.${line.slice(15, 21)} ${line.slice(21, 26)}.${line.slice(26, 32)} ${line[32]} ${line.slice(33)}`;

/** O que falta para um boleto válido (lista vazia: dá para gerar). */
export function boletoMissing(data: Partial<BoletoData>): string[] {
  const missing: string[] = [];
  const barcode = String(data.barcode ?? "");
  if (!/^\d{44}$/.test(barcode) || barcodeDigit(barcode.slice(0, 4) + barcode.slice(5)) !== Number(barcode[4])) missing.push("o código de barras do boleto");
  else {
    const line = String(data.digitable_line ?? "").replace(/\D/g, "");
    if (line.length !== 47 || line !== digitableFromBarcode(barcode)) missing.push("a linha digitável conferida com o código de barras");
    if (data.bank && barcode.slice(0, 3) !== data.bank) missing.push("o banco do boleto");
    if (data.amount_cents && /^\d+$/.test(data.amount_cents) && Number(barcode.slice(9, 19)) !== Number(data.amount_cents)) missing.push("o valor do boleto igual ao da conta");
  }
  if (!/^\d+$/.test(String(data.amount_cents ?? "")) || data.amount_cents === "0") missing.push("o valor");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.due_on ?? ""))) missing.push("o vencimento");
  if (!data.our_number) missing.push("o nosso número");
  if (!data.beneficiary?.name) missing.push("o nome da empresa (beneficiário) em Dados da empresa");
  if (!data.beneficiary?.document) missing.push("o CNPJ da empresa em Dados da empresa");
  if (!data.payer?.name) missing.push("o nome do cliente (pagador)");
  if (!data.payer?.document) missing.push("o CPF ou CNPJ do cliente no cadastro");
  return missing;
}

// Intercalado 2 de 5: n estreita, w larga (3 vezes). Início nnnn, fim wnn.
const ITF = ["nnwwn", "wnnnw", "nwnnw", "wwnnn", "nnwnw", "wnwnn", "nwwnn", "nnnww", "wnnwn", "nwnwn"];
/** Larguras alternadas (barra, espaço, barra…) em módulos. */
export function itfRuns(digits: string): number[] {
  if (!/^\d+$/.test(digits) || digits.length % 2) throw new Error("itf_digits");
  const width = (c: string) => c === "w" ? 3 : 1;
  const runs = [1, 1, 1, 1];
  for (let i = 0; i < digits.length; i += 2) {
    const bars = ITF[Number(digits[i])]!, spaces = ITF[Number(digits[i + 1])]!;
    for (let k = 0; k < 5; k++) runs.push(width(bars[k]!), width(spaces[k]!));
  }
  runs.push(3, 1, 1);
  return runs;
}

function barcodeBars(page: PdfPage, x: number, y: number, digits: string, widthMm = 103, heightMm = 13) {
  const runs = itfRuns(digits), module = widthMm / runs.reduce((a, b) => a + b, 0);
  let at = x;
  runs.forEach((run, index) => { if (index % 2 === 0) page.rect(at, y, run * module, heightMm, { fill: true, width: 0 }); at += run * module; });
}

const M = 10, W = 190;
function cell(page: PdfPage, x: number, y: number, w: number, h: number, label: string, value: string, opts: { bold?: boolean; align?: "left" | "right" } = {}) {
  page.rect(x, y, w, h, { width: 0.2 });
  page.text(x + 1, y + 2.6, label, { size: 5.5, gray: 0.35 });
  const right = opts.align === "right";
  page.text(right ? x + w - 1 : x + 1, y + h - 1.5, value, { size: 8, font: opts.bold ? "bold" : "regular", align: right ? "right" : "left" });
}

/** O PDF do boleto (A4). Chame boletoMissing antes: aqui supõe dados completos. */
export function boletoPdf(data: BoletoData): Uint8Array {
  const page = new PdfPage();
  const bank = data.barcode.slice(0, 3), bankName = BANKS[bank] ?? `Banco ${bank}`;
  const line = formatDigitable(data.digitable_line.replace(/\D/g, ""));
  const value = money(data.amount_cents) ?? "", due = day(data.due_on) ?? data.due_on;
  // Agência e código do beneficiário (Itaú, carteira 109): no campo livre do código de barras.
  const free = data.barcode.slice(19);
  const agency = data.agency_code ?? (bank === "341" ? `${free.slice(12, 16)} / ${free.slice(16, 21)}-${free[21]}` : "");
  const wallet = data.wallet ?? (bank === "341" ? free.slice(0, 3) : "");
  if (data.sandbox) page.rotated(45, 200, "HOMOLOGAÇÃO - SEM VALOR", 35, { size: 34 });
  const header = (y: number, title: string) => {
    page.text(M, y, bankName, { size: 12, font: "bold" });
    page.line(M + 38, y - 5, M + 38, y + 1, { width: 0.4 });
    page.text(M + 41, y, `${bank}-${bankCheck(bank)}`, { size: 12, font: "bold" });
    page.line(M + 58, y - 5, M + 58, y + 1, { width: 0.4 });
    page.text(M + W, y, title, { size: title.length > 30 ? 8.5 : 10, font: "bold", align: "right" });
    page.line(M, y + 1.5, M + W, y + 1.5, { width: 0.4 });
  };

  // Recibo do pagador.
  let y = 18;
  header(y, "Recibo do pagador");
  y += 3;
  cell(page, M, y, 120, 8, "Beneficiário", `${data.beneficiary.name} · ${data.beneficiary.document}`);
  cell(page, M + 120, y, 35, 8, "Agência / Código do beneficiário", agency);
  cell(page, M + 155, y, 35, 8, "Vencimento", due, { bold: true, align: "right" });
  y += 8;
  cell(page, M, y, 120, 8, "Pagador", `${data.payer.name} · ${data.payer.document}`);
  cell(page, M + 120, y, 35, 8, "Nosso número", data.our_number);
  cell(page, M + 155, y, 35, 8, "Valor do documento", value, { bold: true, align: "right" });
  y += 8;
  cell(page, M, y, W, 8, "Linha digitável", line, { bold: true });
  y += 12;
  page.text(M, y, "Autenticação mecânica", { size: 6, gray: 0.4 });
  for (let x = M; x < M + W; x += 3) page.line(x, y + 6, x + 1.5, y + 6, { width: 0.2 });
  page.text(M + W / 2, y + 9, "corte aqui", { size: 6, gray: 0.5, align: "center" });

  // Ficha de compensação.
  y += 22;
  header(y, line);
  y += 3;
  cell(page, M, y, 145, 9, "Local de pagamento", "Pagável em qualquer banco, aplicativo de banco ou lotérica até o vencimento.");
  cell(page, M + 145, y, 45, 9, "Vencimento", due, { bold: true, align: "right" });
  y += 9;
  cell(page, M, y, 145, 9, "Beneficiário", `${data.beneficiary.name} · ${data.beneficiary.document}`);
  cell(page, M + 145, y, 45, 9, "Agência / Código do beneficiário", agency, { align: "right" });
  if (data.beneficiary.address) page.text(M + 60, y + 2.6, data.beneficiary.address.slice(0, 90), { size: 5.5, gray: 0.35 });
  y += 9;
  cell(page, M, y, 30, 9, "Data do documento", day(data.issued_on) ?? "");
  cell(page, M + 30, y, 40, 9, "Número do documento", data.document_number ?? "");
  cell(page, M + 70, y, 25, 9, "Espécie doc.", "DM");
  cell(page, M + 95, y, 20, 9, "Aceite", "N");
  cell(page, M + 115, y, 30, 9, "Data do processamento", day(data.issued_on) ?? "");
  cell(page, M + 145, y, 45, 9, "Nosso número", data.our_number, { align: "right" });
  y += 9;
  cell(page, M, y, 30, 9, "Uso do banco", "");
  cell(page, M + 30, y, 20, 9, "Carteira", wallet);
  cell(page, M + 50, y, 20, 9, "Espécie", "R$");
  cell(page, M + 70, y, 45, 9, "Quantidade", "");
  cell(page, M + 115, y, 30, 9, "Valor", "");
  cell(page, M + 145, y, 45, 9, "(=) Valor do documento", value, { bold: true, align: "right" });
  y += 9;
  page.rect(M, y, 145, 36, { width: 0.2 });
  page.text(M + 1, y + 2.6, "Instruções (texto de responsabilidade do beneficiário)", { size: 5.5, gray: 0.35 });
  let iy = y + 7;
  for (const text of data.instructions.slice(0, 6)) for (const part of wrapText(text, 140, 8).slice(0, 2)) { page.text(M + 1, iy, part, { size: 8 }); iy += 4; }
  ["(−) Desconto / abatimento", "(−) Outras deduções", "(+) Mora / multa", "(+) Outros acréscimos", "(=) Valor cobrado"].forEach((label, index) =>
    cell(page, M + 145, y + index * 7.2, 45, 7.2, label, ""));
  y += 36;
  page.rect(M, y, W, 16, { width: 0.2 });
  page.text(M + 1, y + 2.6, "Pagador", { size: 5.5, gray: 0.35 });
  page.text(M + 1, y + 7, `${data.payer.name} · ${data.payer.document}`, { size: 8, font: "bold" });
  if (data.payer.address) for (const [index, part] of wrapText(data.payer.address, 185, 8).slice(0, 2).entries()) page.text(M + 1, y + 11 + index * 4, part, { size: 8 });
  y += 19;
  barcodeBars(page, M + 5, y, data.barcode);
  page.text(M + W, y + 2, "Autenticação mecânica · Ficha de compensação", { size: 6, gray: 0.4, align: "right" });
  // Boleto híbrido: o QR Code do Pix ao lado do código de barras e o copia e cola embaixo.
  const qr = data.pix_code ? qrMatrix(data.pix_code) : null;
  if (data.pix_code) {
    const size = 26, x = M + W - size, top = y + 4;
    if (qr) {
      const cell = size / qr.length;
      qr.forEach((row, r) => row.forEach((dark, c) => { if (dark) page.rect(x + c * cell, top + r * cell, cell, cell, { fill: true, width: 0 }); }));
      page.text(x + size / 2, top + size + 3, "Pague também com Pix", { size: 6, align: "center" });
    }
    page.text(M, y + 20, "Pix copia e cola:", { size: 6, gray: 0.35 });
    wrapText(data.pix_code, qr ? 150 : W, 6, "mono").slice(0, 4).forEach((part, index) => page.text(M, y + 23 + index * 3, part, { size: 6, font: "mono" }));
  }
  return pdfDocument([page], { title: `Boleto ${data.document_number ?? data.our_number}`, producer: "Vinki" });
}

/** Dígito do código do banco no cabeçalho do boleto (módulo 11 com pesos 2 a 9). */
function bankCheck(bank: string) {
  let sum = 0, weight = 2;
  for (let i = bank.length - 1; i >= 0; i--) { sum += Number(bank[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const rest = 11 - (sum % 11);
  return rest >= 10 ? (bank === "001" ? "X" : "0") : String(rest);
}
