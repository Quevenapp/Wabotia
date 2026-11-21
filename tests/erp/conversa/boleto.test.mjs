// Boleto em PDF da conta a receber (src/erp/conversa/boleto.ts) e o PDF com
// logotipo (pdf-image.ts): regras puras, sem banco e sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import { barcodeDigit, boletoMissing, boletoPdf, digitableFromBarcode, formatDigitable, itfRuns } from "../../../src/erp/conversa/boleto.ts";
import { messageText } from "../../../src/erp/conversa/rules.ts";
import { pdfDocumentWithImage, pdfImage } from "../../../src/erp/conversa/pdf-image.ts";
import { PdfPage } from "../../../web/erp/app/lib/pdf-writer.ts";

// Itaú 341, moeda 9, fator 1000 e R$ 123,45; campo livre: carteira 109, nosso número 12345678 (DAC 0), agência 1234, conta 12345-6, 000.
const free = "109" + "12345678" + "0" + "1234" + "12345" + "6" + "000";
const head = "3419", tail = "1000" + "0000012345" + free;
const barcode = `${head}${barcodeDigit(head + tail)}${tail}`;
const line = digitableFromBarcode(barcode);
const data = {
  bank: "341", barcode, digitable_line: formatDigitable(line), amount_cents: "12345", due_on: "2026-12-10", our_number: "109/12345678-0",
  document_number: "NF 10", issued_on: "2026-11-20",
  beneficiary: { name: "Oficina Exemplo Ltda", document: "CNPJ 11.222.333/0001-81", address: "Rua A, 10 - Centro - São Paulo/SP" },
  payer: { name: "Ana Cliente", document: "CPF 123.456.789-09", address: "Rua B, 20 - Bairro - Campinas/SP" },
  instructions: ["Não receber após 60 dias do vencimento."],
};

test("código de barras e linha digitável conferem entre si", () => {
  assert.equal(barcode.length, 44);
  assert.equal(line.length, 47);
  assert.equal(line.slice(0, 4), "3419");
  assert.equal(line[32], barcode[4]);
  assert.equal(line.slice(33), barcode.slice(5, 19));
  assert.match(formatDigitable(line), /^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);
  assert.deepEqual(boletoMissing(data), []);
});

test("intercalado 2 de 5: 44 dígitos ocupam 405 módulos", () => {
  const runs = itfRuns(barcode);
  assert.equal(runs.reduce((a, b) => a + b, 0), 405);
  assert.deepEqual(runs.slice(0, 4), [1, 1, 1, 1]);
  assert.deepEqual(runs.slice(-3), [3, 1, 1]);
  assert.throws(() => itfRuns("123"));
});

test("falta de dado não gera boleto e diz o que falta", () => {
  const wrong = barcode.slice(0, 4) + ((Number(barcode[4]) % 9) + 1) + barcode.slice(5);
  assert.ok(boletoMissing({ ...data, barcode: wrong }).includes("o código de barras do boleto"));
  assert.ok(boletoMissing({ ...data, digitable_line: "1".repeat(47) }).some(item => item.includes("linha digitável")));
  assert.ok(boletoMissing({ ...data, amount_cents: "999" }).includes("o valor do boleto igual ao da conta"));
  const missing = boletoMissing({ ...data, payer: { name: "Ana", document: null, address: null }, beneficiary: { name: null, document: null, address: null } });
  assert.ok(missing.includes("o CPF ou CNPJ do cliente no cadastro"));
  assert.ok(missing.includes("o nome da empresa (beneficiário) em Dados da empresa"));
  assert.ok(missing.includes("o CNPJ da empresa em Dados da empresa"));
});

test("o PDF do boleto sai em uma página A4 com a linha digitável", () => {
  const pdf = boletoPdf(data);
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/Count 1/);
  assert.ok(text.includes(formatDigitable(line)));
  assert.ok(text.includes("Ficha de compensa"));
});

test("a mensagem da conta cita o boleto anexado", () => {
  const text = messageText({ type: "conta", label: "Conta", customer: "Ana Cliente", total_cents: "12345", due_on: "2026-12-10", description: "Conta", boleto_line: formatDigitable(line), attachments: 1 });
  assert.match(text, /boleto vai em PDF/);
  assert.ok(text.includes(formatDigitable(line)));
  assert.doesNotMatch(text, /Se tiver dúvida/);
});

test("logotipo JPEG entra como imagem do PDF; arquivo estranho fica de fora", async () => {
  // JPEG mínimo: SOI, SOF0 (8 bits, 2x3, 3 componentes) e EOI.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
  const image = await pdfImage(jpeg);
  assert.deepEqual({ width: image?.width, height: image?.height, colors: image?.colors, filter: image?.filter }, { width: 2, height: 3, colors: 3, filter: "DCTDecode" });
  assert.equal(await pdfImage(new Uint8Array([1, 2, 3])), null);
  const page = new PdfPage();
  page.text(10, 10, "Proposta comercial nº 1");
  const text = new TextDecoder("latin1").decode(pdfDocumentWithImage([page], image, { title: "Proposta" }));
  assert.match(text, /\/XObject << \/Im1 \d+ 0 R >>/);
  assert.match(text, /\/Subtype \/Image \/Width 2 \/Height 3/);
  assert.match(text, /startxref\n\d+\n%%EOF\n$/);
});
