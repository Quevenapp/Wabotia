// CNPJ alfanumérico no formulário fiscal: digitar o documento do
// destinatário, da transportadora, do intermediador e da credenciadora
// conserva as letras, e a nota com esse CNPJ passa na validação do contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fiscalDocumentInput, orderRecipient, carrierValues, validFiscalDocument } from "../../../web/erp/app/lib/fiscal-invoice-form-model.ts";
import { normalizeInvoiceInput } from "../../../packages/erp-domain/src/fiscal-invoice-contract.mjs";

const lettered = "12ABC34501DE35";
const input = (overrides = {}) => ({ model: "55", direction: "1", issue_type: "T", series: "1", number: "1", nature_description: "Venda de ensaio", issue_date: "2026-11-19",
  crt: "1", purpose: "1", presence: "9", final_consumer: false, recipient: { name: "Cliente com CNPJ alfanumérico", person_type: "J", document: lettered },
  items: [{ description: "Mercadoria", quantity: "1", unit_price: "10" }], ...overrides });

test("digitação de CPF/CNPJ conserva as letras do CNPJ alfanumérico e só tira a máscara", () => {
  assert.equal(fiscalDocumentInput("12.abc.345/01de-35"), lettered);
  assert.equal(fiscalDocumentInput("529.982.247-25"), "52998224725");
  assert.equal(fiscalDocumentInput("12ABC34501DE35999"), lettered);
  assert.equal(validFiscalDocument("12.ABC.345/01DE-35"), true);
  assert.equal(validFiscalDocument("12ABC34501DE36"), false);
  assert.equal(validFiscalDocument("52998224725"), true);
});

test("destinatário e transportadora do cadastro chegam ao formulário com as letras", () => {
  const contact = { contact_id: "10000000-0000-4000-8000-000000000001", name: "Cliente", document: "12.ABC.345/01DE-35", person_type: "J" };
  assert.equal(orderRecipient(contact).document, lettered);
  assert.equal(carrierValues(contact).document, lettered);
});

test("contrato da nota aceita o CNPJ alfanumérico no destinatário, na transportadora e no intermediador", () => {
  const normalized = normalizeInvoiceInput(input({
    transport: { mode: "manual", freight_by: "0", carrier: { name: "Transportadora alfanumérica", document: lettered } },
    intermediary: { present: true, cnpj: lettered, identification: "loja" },
  }));
  assert.equal(normalized.recipient.document, lettered);
  assert.equal(normalized.transport.carrier.document, lettered);
  assert.equal(normalized.intermediary.cnpj, lettered);
  // Continua recusando o que não é documento (letra nos dígitos verificadores, tamanho errado).
  assert.throws(() => normalizeInvoiceInput(input({ recipient: { name: "X", person_type: "J", document: "12ABC34501DEAA" } })));
  assert.throws(() => normalizeInvoiceInput(input({ recipient: { name: "X", person_type: "J", document: "12ABC345" } })));
});

test("os campos do formulário não apagam mais as letras do documento", () => {
  const form = readFileSync(new URL("../../../web/erp/app/components/FiscalInvoiceForm.tsx", import.meta.url), "utf8");
  for (const field of ["fiscal-recipient-document", "fiscal-carrier-document", "fiscal-intermediary-cnpj"]) {
    const line = form.split("\n").find(text => text.includes(`'${field}', String(`));
    assert.ok(line, field);
    assert.match(line, /fiscalDocumentInput\(value\)/, field);
    assert.doesNotMatch(line, /replace\(\/\\D\/g/, field);
  }
  const dialog = readFileSync(new URL("../../../web/erp/app/components/FiscalInstallmentDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /setCard\('cnpj', fiscalDocumentInput\(next\)\)/);
});
