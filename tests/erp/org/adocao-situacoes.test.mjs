// Fatia B2: o mapa único das situações do Bling (em aberto, encerrado ou
// desconhecido). Função pura; nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLING_HISTORY_SCOPES, blingAccountSituation, blingDocumentSituation } from "../../../src/erp/bling/adoption-situations.ts";

test("propostas: Rascunho, Em aberto, Pendente e Aguardando estão em aberto; aprovadas e concluídas vão para o histórico", () => {
  assert.deepEqual(blingDocumentSituation("sales_proposals", { situacao: "Pendente" }), { scope: "open", native: "pending", history: null, label: "Pendente" });
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "Rascunho" }).native, "draft");
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "aguardando" }).native, "waiting");
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "Em aberto" }).native, "open");
  assert.deepEqual(blingDocumentSituation("sales_proposals", { situacao: "Aprovado" }), { scope: "closed", native: null, history: "fulfilled", label: "Aprovado" });
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "Não aprovado" }).history, "cancelled");
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "Concluído" }).history, "fulfilled");
  assert.equal(blingDocumentSituation("sales_proposals", { situacao: "Inventada" }).scope, "unknown");
});

test("pedidos de venda: pelo nome, pelo id padrão do Bling ou pelo valor; sempre entram Em aberto no ERP", () => {
  for (const situacao of [{ id: 6, valor: 0 }, { id: "15", valor: "3" }, { nome: "Em digitação" }, { id: 24 }, { id: 21 }]) {
    const s = blingDocumentSituation("sales_orders", { situacao });
    assert.equal(s.scope, "open", JSON.stringify(situacao)); assert.equal(s.native, "open");
  }
  assert.deepEqual(blingDocumentSituation("sales_orders", { situacao: { id: 9, valor: 1 } }), { scope: "closed", native: null, history: "fulfilled", label: "Atendido" });
  assert.equal(blingDocumentSituation("sales_orders", { situacao: { id: 12, valor: 2 } }).history, "cancelled");
  assert.equal(blingDocumentSituation("sales_orders", { situacao: { id: 18 } }).history, "fulfilled");
  assert.equal(blingDocumentSituation("sales_orders", { situacao: { nome: "Faturado" } }).history, "fulfilled");
  // Situação personalizada sem nome conhecido: vale o valor (módulo) do Bling.
  assert.equal(blingDocumentSituation("sales_orders", { situacao: { id: 777, valor: 1 } }).scope, "closed");
  assert.equal(blingDocumentSituation("sales_orders", { situacao: { id: 777 } }).scope, "unknown");
  assert.equal(blingDocumentSituation("sales_orders", {}).scope, "unknown");
});

test("pedidos de compra: valor 0 e 3 em aberto; 1 atendido e 2 cancelado no histórico", () => {
  assert.equal(blingDocumentSituation("purchase_orders", { situacao: { valor: 0 } }).scope, "open");
  assert.equal(blingDocumentSituation("purchase_orders", { situacao: { valor: "3" } }).scope, "open");
  assert.equal(blingDocumentSituation("purchase_orders", { situacao: { valor: 1 } }).history, "fulfilled");
  assert.equal(blingDocumentSituation("purchase_orders", { situacao: { valor: 2 } }).history, "cancelled");
  assert.equal(blingDocumentSituation("purchase_orders", { situacao: { valor: 9 } }).scope, "unknown");
});

test("contas: só a 1 com saldo igual ao valor está em aberto e inteira; o resto tem motivo", () => {
  assert.deepEqual(blingAccountSituation({ situacao: 1 }, 10000n, 10000n), { scope: "open", code: "1", label: "Em aberto" });
  assert.equal(blingAccountSituation({ situacao: "1" }, 10000n, null).scope, "open");
  assert.equal(blingAccountSituation({ situacao: 1 }, 10000n, 5000n).scope, "partial");
  assert.equal(blingAccountSituation({ situacao: 2 }, 10000n, 0n).scope, "paid");
  assert.equal(blingAccountSituation({ situacao: 3 }, null, null).scope, "partial");
  assert.equal(blingAccountSituation({ situacao: 4 }, null, null).scope, "returned");
  assert.equal(blingAccountSituation({ situacao: 5 }, null, null).scope, "cancelled");
  assert.equal(blingAccountSituation({ situacao: 6 }, null, null).scope, "partial");
  assert.equal(blingAccountSituation({ situacao: 7 }, null, null).scope, "other");
  assert.equal(blingAccountSituation({ situacao: 8 }, null, null).scope, "unknown");
  for (const text of Object.values(BLING_HISTORY_SCOPES)) assert.doesNotMatch(text, /Fagoo|Origin/);
});
