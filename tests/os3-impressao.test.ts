// OS3: regras puras do orçamento e a página de impressão (A4 e cupom 80 mm).
import { describe, expect, it } from "vitest";
import { quoteInstallments, quoteSubtotal, quoteTotal, termsSummary, validateQuoteItems, validateQuoteTerms } from "../src/modules/os/model";
import { buildPrintHtml, conditionsLines, warrantyLine } from "../web/modules/os/work/print";
import { needsReason } from "../web/modules/os/work/WorkQuoteCommercial";
import { catalogPick, previewInstallments, termsBody, termsDraft } from "../web/modules/os/work/QuoteParts";
import { draftTotals } from "../web/modules/os/work/QuoteEditor";

const order = (extra: Record<string, unknown> = {}) => ({
  id: "o", number: 12, display_number: "OF-12", status: "approved", status_label: "Aprovada", stage_label: "Aprovada",
  labels: { singular: "Ordem de serviço", plural: "Ordens", item: "Veículo", problem: "Problema relatado", customer_singular: "Cliente", customer_plural: "Clientes" },
  customer: { name: "João <b>Silva</b>", phone: "5511987654321" }, item: "Fiat Uno 2010", problem: "Barulho no freio",
  fields: [{ id: "km", label: "Quilometragem", client_visible: true, sensitive: false }, { id: "senha", label: "Senha do alarme", client_visible: false, sensitive: true }],
  extra: { km: 60000, senha: "1234" }, features: { warranty_days: 90 }, warranty_until: null,
  quote: {
    items: [
      { id: "a", description: "Pastilha de freio", code: "PF-01", quantity: 2, unit_cents: 8000, discount_cents: 1000, kind: "material" },
      { id: "b", description: "Mão de obra", quantity: 1, unit_cents: 12000, kind: "service" },
    ],
    total_cents: 26500, subtotal_cents: 28000, items_discount_cents: 1000, discount_cents: 500, note: "Peças originais.", valid_until: Date.UTC(2026, 11, 1, 12),
    terms: { payer_contact_id: null, payer_name: "", method: "pix", payment_method_id: null, method_label: "Pix", installments: { count: 2, first_due_on: "2026-12-10", interval_days: 30 } },
    installments: [{ number: 1, due_on: "2026-12-10", amount_cents: 13250 }, { number: 2, due_on: "2027-01-09", amount_cents: 13250 }],
  },
  ...extra,
}) as any;
const company = { name: "Oficina do Zé", document: "11222333000181", address: "Rua A, 10", phone: "1933334444", footer: "Obrigado pela preferência!" };

describe("OS3 regras do orçamento", () => {
  it("desconto por linha e no total; sem desconto o total é o de antes", () => {
    const items = validateQuoteItems([{ description: "Peça", quantity: 1.5, unit_cents: 101, discount_cents: 2 }, { description: "Serviço", unit_cents: 1000 }]);
    expect(quoteSubtotal(items)).toBe(1152);
    expect(quoteTotal(items, 50)).toBe(1100);
    expect(quoteTotal(validateQuoteItems([{ description: "Porção", quantity: 1.5, unit_cents: 101 }]))).toBe(152);
    expect(() => validateQuoteItems([{ description: "Peça", unit_cents: 100, discount_cents: 101 }])).toThrow("passa do valor do item");
    expect(() => quoteTotal(items, 5000)).toThrow("passa do valor");
  });
  it("condições: sem Financeiro não há parcelas; com ele, divisão exata em centavos", () => {
    const raw = { method: "card", installments: { count: 3, first_due_on: "2026-12-31", interval_days: 30 } };
    expect(validateQuoteTerms(raw, false)).toMatchObject({ method: "card", method_label: "Cartão", installments: null });
    const terms = validateQuoteTerms(raw, true)!;
    expect(quoteInstallments(terms, 1000)).toEqual([
      { number: 1, due_on: "2026-12-31", amount_cents: 334 }, { number: 2, due_on: "2027-01-30", amount_cents: 333 }, { number: 3, due_on: "2027-03-01", amount_cents: 333 }]);
    expect(quoteInstallments(terms, 2).map(p => p.amount_cents)).toEqual([1, 1]);
    expect(termsSummary(terms, 1000)).toContain("3 parcelas");
    expect(() => validateQuoteTerms({ installments: { count: 30, first_due_on: "2026-12-31" } }, true)).toThrow("1 a 24");
    expect(() => validateQuoteTerms({ installments: { count: 2, first_due_on: "2026-02-30" } }, true)).toThrow("primeira parcela");
    expect(() => validateQuoteTerms({ desconhecido: 1 }, true)).toThrow("campo desconhecido");
  });
});

describe("OS3 impressão", () => {
  it("A4: empresa, cliente, objeto, itens, totais, condições, garantia e assinatura", () => {
    const html = buildPrintHtml({ order: order(), company, now: Date.UTC(2026, 10, 20, 15) }, "quote", "a4");
    for (const text of ["Oficina do Zé", "CNPJ 11.222.333/0001-81", "Orçamento · Ordem de serviço OF-12", "(11) 98765-4321", "Fiat Uno 2010",
      "Pastilha de freio", "PF-01", "R$ 150,00", "Descontos", "- R$ 15,00", "R$ 265,00", "Parcela 1/2: R$ 132,50 em 10/12/2026",
      "Forma de pagamento: Pix", "Garantia de 90 dias, contada da entrega.", "De acordo do cliente", "Obrigado pela preferência!", "@page{size:A4", "Quilometragem", "60000"])
      expect(html, text).toContain(text);
    expect(html).toContain("João &lt;b&gt;Silva&lt;/b&gt;");
    expect(html).not.toContain("Senha do alarme");
    expect(html).not.toContain("1234");
  });
  it("cupom de 80 mm e ordem de serviço com recebido e saldo", () => {
    const html = buildPrintHtml({ order: order(), company, received_cents: 10000 }, "order", "cupom");
    expect(html).toContain("@page{size:80mm auto");
    expect(html).toContain("Recebido");
    expect(html).toContain("R$ 165,00");
    expect(html).toContain("Assinatura do cliente");
  });
  it("área reservada imprime itens genéricos e omite o relato", () => {
    const html = buildPrintHtml({ order: order(), company: null, privacy: "reserved" }, "quote", "a4");
    expect(html).toContain("Serviço contratado");
    expect(html).not.toContain("Pastilha de freio");
    expect(html).not.toContain("Barulho no freio");
  });
  it("sem parcelas mostra o total combinado; garantia da entrega prevalece", () => {
    const plain = order({ quote: { ...order().quote, terms: null, installments: [] } });
    expect(conditionsLines(plain)).toEqual(["Total combinado: R$ 265,00"]);
    expect(warrantyLine(order({ warranty_until: Date.UTC(2027, 1, 18, 12) }))).toBe("Garantia até 18/02/2027.");
    expect(warrantyLine(order({ features: { warranty_days: 0 } }))).toBe("Sem garantia.");
  });
});

describe("OS3 tela: motivo, condições e catálogo", () => {
  it("pede motivo para cancelar e voltar etapa, como o servidor", () => {
    expect(needsReason("received", "cancelled")).toBe(true);
    expect(needsReason("ready", "in_progress")).toBe(true);
    expect(needsReason("quoted", "analyzing")).toBe(true);
    expect(needsReason("approved", "analyzing")).toBe(true);
    expect(needsReason("received", "analyzing")).toBe(false);
    expect(needsReason("in_progress", "ready")).toBe(false);
  });
  it("monta o corpo das condições e a prévia das parcelas", () => {
    const draft = { ...termsDraft(null), method: "erp:7f1c3a52-6a1b-4e7e-9d3b-1f2a3b4c5d6e", methodLabel: "Boleto", count: "2", first: "2026-12-10", interval: "15" };
    expect(termsBody(draft, true)).toEqual({ payer_contact_id: null, payer_name: "", method: "other", payment_method_id: "7f1c3a52-6a1b-4e7e-9d3b-1f2a3b4c5d6e",
      method_label: "Boleto", installments: { count: 2, first_due_on: "2026-12-10", interval_days: 15 } });
    expect(termsBody({ ...draft, method: "pix", methodLabel: "Pix" }, false)).toMatchObject({ method: "pix", installments: null });
    expect(previewInstallments(draft, 1001)).toEqual([{ number: 1, due_on: "2026-12-10", amount_cents: 501 }, { number: 2, due_on: "2026-12-25", amount_cents: 500 }]);
    expect(() => termsBody({ ...draft, count: "0" }, true)).toThrow("1 a 24");
  });
  it("item do catálogo traz preço da lista, código e tipo; totais do rascunho", () => {
    expect(catalogPick({ id: "p", name: "Óleo 5W30", code: "OL-1", unit: "L", kind: "P", price: "42.90" })).toEqual({ id: "p", name: "Óleo 5W30", code: "OL-1", unit: "L", kind: "material", price_cents: 4290 });
    expect(catalogPick({ id: "s", name: "Alinhamento", kind: "S", price: null })).toMatchObject({ kind: "service", price_cents: null });
    const line = { id: "x", kind: "free" as const, unit: "UN", code: "", description: "Peça", quantity: "2", price: "10,00", discount: "1,00", pick: null, linked: null };
    expect(draftTotals([line], "2,00")).toEqual({ subtotal: 2000, discounts: 300, total: 1700 });
  });
});
