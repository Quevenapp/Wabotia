import test from "node:test";
import assert from "node:assert/strict";
import { fakeNfeValue } from "./fake-vault-value.ts";

const item = (overrides = {}) => ({ quantidade: 2, valorUnitario: 25.5, impostos: { icms: {} }, ...overrides });

test("cofre simulado totaliza R$ 51 do pedido em vez de devolver valor fixo", () => {
  assert.equal(fakeNfeValue({ itens: [item()] }), 51);
  assert.equal(fakeNfeValue({ itens: [item({ valorTotal: 49.99 })] }), 49.99);
});

test("totalização soma centavos por item e conserva a precisão de quantidade/preço", () => {
  assert.equal(fakeNfeValue({ itens: [item({ quantidade: 1, valorUnitario: 0.1 }), item({ quantidade: 1, valorUnitario: 0.2 })] }), 0.3);
  assert.equal(fakeNfeValue({ itens: [item({ quantidade: 3, valorUnitario: 0.335 })] }), 1.01);
  assert.equal(fakeNfeValue({ itens: [item({ quantidade: 0.0001, valorUnitario: 50 }), item({ quantidade: 1, valorUnitario: 1e-7 })] }), 0.01);
});

test("pagamento com troco ou sem pagamento não muda o total; item excluído não compõe", () => {
  const itens = [item(), item({ valorTotal: 900, compoeTotal: false })];
  assert.equal(fakeNfeValue({ itens, pagamentos: [{ forma: "01", valor: 100 }], troco: 49 }), 51);
  assert.equal(fakeNfeValue({ itens, pagamentos: [{ forma: "90", valor: 0 }] }), 51);
});

test("totalização usa acréscimos, descontos e tributos declarados, sem calcular alíquotas", () => {
  const data = item({ valorTotal: 100, frete: 4.5, seguro: 1.2, outrasDespesas: 0.3, desconto: 6,
    impostos: { icms: { valor: 18, fcp: { valor: 2 }, st: { valor: 10, fcp: { valor: 1 } }, desoneracao: { valor: 3, deduzDoTotal: true } },
      ipi: { valor: 5 }, ii: { valor: 7 }, pis: { valor: 1.65 }, cofins: { valor: 7.6 } } });
  assert.equal(fakeNfeValue({ itens: [data] }), 120);
  data.impostos.icms.desoneracao.deduzDoTotal = false;
  assert.equal(fakeNfeValue({ itens: [data] }), 123);
});
