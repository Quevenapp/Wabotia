// Maquininha integrada ao caixa (src/erp/terminal): o adaptador do Mercado
// Pago Point contra um provedor simulado (nenhuma chamada sai daqui), as
// recusas em palavras, a resposta incerta, o aviso assinado, o contrato das
// operações (o bot só consulta) e a observação gravada na parcela da venda.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TerminalError, brandOf, reaisToCents } from "../../../src/erp/terminal/adapter.ts";
import { mercadoPagoPoint, pointManifest, pointRejection } from "../../../src/erp/terminal/providers/mercadopago-point.ts";
import { TERMINAL_ADAPTERS } from "../../../src/erp/terminal/providers/index.ts";
import {
  ERP_TERMINAL_MODULE_CONTRACT, ERP_TERMINAL_OPERATIONS, ERP_TERMINAL_PART, TERMINAL_PROVIDERS, erpTerminalOperationFor, erpTerminalParams, terminalPaymentNote,
} from "../../../src/erp/terminal/contract.ts";

/** Provedor simulado: responde por regra (método + trecho do endereço) e guarda os pedidos. */
function simulated(rules) {
  const requests = [];
  const http = async (request) => {
    requests.push(request);
    for (const [method, part, reply] of rules) if (request.method === method && request.url.includes(part)) {
      const value = typeof reply === "function" ? reply(request) : reply;
      if (value instanceof Error) throw value;
      return value;
    }
    return { status: 404, body: { message: "rota não simulada" } };
  };
  return { requests, ctx: { http, credentials: { access_token: "APP_USR-teste", webhook_secret: "segredo-do-aviso" } } };
}
const intent = (state, extra = {}) => ({ status: 200, body: { id: "pi-1", device_id: "PAX_A910__SMARTPOS1", amount: 15990, state,
  additional_info: { external_reference: "ref1" }, payment: { id: 777, type: "credit_card", installments: 3 }, ...extra } });

test("só o Mercado Pago, pelo mesmo desenho dos outros provedores", () => {
  assert.deepEqual(TERMINAL_PROVIDERS, ["mercadopago"]);
  assert.equal(TERMINAL_ADAPTERS.mercadopago, mercadoPagoPoint);
  for (const key of ["listDevices", "prepareDevice", "createCharge", "getCharge", "findCharge", "cancelCharge", "verifyWebhook"]) assert.equal(typeof mercadoPagoPoint[key], "function", key);
});

test("terminais: modo integrado (PDV) pronto; os outros avisam que mudam de modo", async () => {
  const { ctx, requests } = simulated([["GET", "/point/integration-api/devices", { status: 200, body: { devices: [
    { id: "PAX_A910__SMARTPOS1", operating_mode: "PDV" }, { id: "GERTEC_MP35P__8701", operating_mode: "STANDALONE" }] } }],
  ["PATCH", "/point/integration-api/devices/GERTEC", { status: 200, body: { operating_mode: "PDV" } }]]);
  const devices = await mercadoPagoPoint.listDevices(ctx);
  assert.deepEqual(devices.map((d) => [d.id, d.ready]), [["PAX_A910__SMARTPOS1", true], ["GERTEC_MP35P__8701", false]]);
  assert.match(devices[1].note, /modo integrado/);
  await mercadoPagoPoint.prepareDevice(ctx, "GERTEC_MP35P__8701");
  assert.deepEqual(JSON.parse(requests.at(-1).body), { operating_mode: "PDV" });
  assert.equal(requests[0].headers.Authorization, "Bearer APP_USR-teste");
});

test("cobrança: valor em centavos, débito à vista, crédito parcelado com quem paga os juros, referência externa", async () => {
  const { ctx, requests } = simulated([["POST", "/payment-intents", { status: 201, body: { id: "pi-9" } }]]);
  assert.deepEqual(await mercadoPagoPoint.createCharge(ctx, { reference: "ref1", device_id: "PAX_A910__SMARTPOS1", amount_cents: 15990, kind: "credito", installments: 3,
    installments_cost: "loja", description: "Venda nº 12" }), { ref: "pi-9" });
  const credit = JSON.parse(requests[0].body);
  assert.match(requests[0].url, /\/point\/integration-api\/devices\/PAX_A910__SMARTPOS1\/payment-intents$/);
  assert.deepEqual(credit, { amount: 15990, description: "Venda nº 12", payment: { type: "credit_card", installments: 3, installments_cost: "seller" },
    additional_info: { external_reference: "ref1", print_on_terminal: true } });
  await mercadoPagoPoint.createCharge(ctx, { reference: "ref2", device_id: "D", amount_cents: 500, kind: "debito", installments: 1, installments_cost: "cliente", description: "x" });
  assert.deepEqual(JSON.parse(requests[1].body).payment, { type: "debit_card", installments: 1 });
});

test("cobrança sem resposta ou com erro do servidor é incerta (consulta antes de reenviar); fila ocupada e credencial recusada dizem o que fazer", async () => {
  for (const reply of [new Error("timeout"), { status: 502, body: null }, { status: 408, body: null }]) {
    const { ctx } = simulated([["POST", "/payment-intents", reply]]);
    await assert.rejects(mercadoPagoPoint.createCharge(ctx, { reference: "r", device_id: "D", amount_cents: 100, kind: "debito", installments: 1, installments_cost: "loja", description: "x" }),
      (e) => e instanceof TerminalError && e.kind === "incerto" && /confere antes de enviar outra/.test(e.message));
  }
  const busy = simulated([["POST", "/payment-intents", { status: 409, body: { message: "queued" } }]]);
  await assert.rejects(mercadoPagoPoint.createCharge(busy.ctx, { reference: "r", device_id: "D", amount_cents: 100, kind: "debito", installments: 1, installments_cost: "loja", description: "x" }),
    (e) => e.kind === "ocupado" && /outra cobrança na fila/.test(e.message));
  const denied = simulated([["GET", "/devices", { status: 401, body: {} }]]);
  await assert.rejects(mercadoPagoPoint.listDevices(denied.ctx), (e) => e.kind === "credencial" && /Access Token/.test(e.message));
  // Consulta sem resposta não é incerta: só tenta de novo.
  const down = simulated([["GET", "/payment-intents/", new Error("rede")]]);
  await assert.rejects(mercadoPagoPoint.getCharge(down.ctx, "pi-1"), (e) => e.kind === "indisponivel");
  const empty = simulated([]);
  empty.ctx.credentials.access_token = "";
  await assert.rejects(mercadoPagoPoint.listDevices(empty.ctx), (e) => e.kind === "configuracao");
});

test("consulta: aprovado com bandeira, parcelas, autorização, NSU, final do cartão e tarifa; recusado com o motivo em palavras", async () => {
  const approved = simulated([["GET", "/payment-intents/pi-1", intent("FINISHED")], ["GET", "/v1/payments/777", { status: 200, body: {
    id: 777, status: "approved", payment_method_id: "master", payment_type_id: "credit_card", installments: 3, transaction_amount: 159.9, authorization_code: "A1B2C3",
    card: { last_four_digits: "4321" }, transaction_details: { acquirer_reference: "NSU998877" }, fee_details: [{ amount: 4.5 }, { amount: 0.3 }], date_approved: "2026-11-21T10:00:00.000-03:00" } }]]);
  const paid = await mercadoPagoPoint.getCharge(approved.ctx, "pi-1");
  assert.equal(paid.state, "aprovado");
  assert.deepEqual([paid.brand, paid.kind, paid.installments, paid.authorization, paid.nsu, paid.last4, paid.amount_cents, paid.fee_cents, paid.reference],
    ["mastercard", "credito", 3, "A1B2C3", "NSU998877", "4321", 15990, 480, "ref1"]);
  const rejected = simulated([["GET", "/payment-intents/pi-1", intent("FINISHED")], ["GET", "/v1/payments/777", { status: 200, body: {
    id: 777, status: "rejected", status_detail: "cc_rejected_insufficient_amount", payment_method_id: "visa", payment_type_id: "credit_card", installments: 3, transaction_amount: 159.9 } }]]);
  const refused = await mercadoPagoPoint.getCharge(rejected.ctx, "pi-1");
  assert.equal(refused.state, "recusado");
  assert.equal(refused.reason, "Saldo ou limite insuficiente no cartão.");
  assert.equal(pointRejection("algo_novo"), "O banco do cartão recusou o pagamento.");
  // Sem o NSU da adquirente, o número da operação.
  const plain = simulated([["GET", "/payment-intents/pi-1", intent("PROCESSED")], ["GET", "/v1/payments/777", { status: 200, body: { id: 777, status: "approved", payment_method_id: "debelo", payment_type_id: "debit_card", installments: 1, transaction_amount: 159.9 } }]]);
  const debit = await mercadoPagoPoint.getCharge(plain.ctx, "pi-1");
  assert.deepEqual([debit.state, debit.brand, debit.kind, debit.nsu, debit.fee_cents], ["aprovado", "elo", "debito", "777", null]);
});

test("consulta: na fila, na tela, processando, cancelada, abandonada e erro", async () => {
  const cases = [["OPEN", "aguardando", /fila/], ["ON_TERMINAL", "aguardando", /tela da maquininha/], ["PROCESSING", "processando", /processando/],
    ["CANCELED", "cancelado", /cancelada/], ["ABANDONED", "cancelado", /ninguém passou o cartão/], ["ERROR", "erro", /erro/]];
  for (const [state, expected, reason] of cases) {
    const { ctx } = simulated([["GET", "/payment-intents/pi-1", intent(state, { payment: {} })]]);
    const charge = await mercadoPagoPoint.getCharge(ctx, "pi-1");
    assert.equal(charge.state, expected, state);
    assert.match(charge.reason, reason, state);
  }
  const { ctx } = simulated([["GET", "/payment-intents/pi-1", intent("FINISHED", { payment: {} })]]);
  assert.equal((await mercadoPagoPoint.getCharge(ctx, "pi-1")).state, "processando", "terminou sem o pagamento: ainda não é aprovado");
});

test("achar depois de resposta incerta: pela referência e pelo terminal; não achou, null", async () => {
  const { ctx } = simulated([
    ["GET", "/payment-intents/events", { status: 200, body: { events: [{ payment_intent_id: "pi-0", status: "FINISHED" }, { payment_intent_id: "pi-1", status: "OPEN" }] } }],
    ["GET", "/payment-intents/pi-0", { status: 200, body: { id: "pi-0", device_id: "D", amount: 100, state: "FINISHED", additional_info: { external_reference: "outra" }, payment: {} } }],
    ["GET", "/payment-intents/pi-1", intent("OPEN", { payment: {} })],
  ]);
  const found = await mercadoPagoPoint.findCharge(ctx, { reference: "ref1", device_id: "PAX_A910__SMARTPOS1", since: Date.now() - 60_000 });
  assert.equal(found.ref, "pi-1");
  assert.equal(await mercadoPagoPoint.findCharge(ctx, { reference: "nao-existe", device_id: "PAX_A910__SMARTPOS1", since: Date.now() }), null);
});

test("cancelar: só enquanto não está na tela da maquininha", async () => {
  const ok = simulated([["DELETE", "/devices/D/payment-intents/pi-1", { status: 200, body: { id: "pi-1" } }]]);
  await mercadoPagoPoint.cancelCharge(ok.ctx, { ref: "pi-1", device_id: "D" });
  assert.equal(ok.requests[0].method, "DELETE");
  const onScreen = simulated([["DELETE", "/payment-intents/", { status: 409, body: {} }]]);
  await assert.rejects(mercadoPagoPoint.cancelCharge(onScreen.ctx, { ref: "pi-1", device_id: "D" }), (e) => e.kind === "ocupado" && /Cancele na própria maquininha/.test(e.message));
});

test("aviso: assinatura do Mercado Pago conferida, prazo, e só ids (o resultado sai da consulta)", async () => {
  const { ctx } = simulated([]);
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", "segredo-do-aviso").update(pointManifest("pi-1", "req-1", ts)).digest("hex");
  const input = (signature, id = "pi-1") => ({ headers: new Headers({ "x-signature": signature, "x-request-id": "req-1" }), query: new URLSearchParams({ "data.id": id }),
    body: { id: "pi-1", state: "FINISHED", payment: { id: 777 } } });
  assert.deepEqual(await mercadoPagoPoint.verifyWebhook(ctx, input(`ts=${ts},v1=${v1}`)), { refs: ["pi-1"] });
  await assert.rejects(mercadoPagoPoint.verifyWebhook(ctx, input(`ts=${ts},v1=${"0".repeat(64)}`)), (e) => e.kind === "credencial");
  await assert.rejects(mercadoPagoPoint.verifyWebhook(ctx, input(`ts=${ts},v1=${v1}`, "pi-2")), (e) => e.kind === "credencial", "id trocado não vale");
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const oldV1 = createHmac("sha256", "segredo-do-aviso").update(pointManifest("pi-1", "req-1", old)).digest("hex");
  await assert.rejects(mercadoPagoPoint.verifyWebhook(ctx, input(`ts=${old},v1=${oldV1}`)), (e) => /prazo/.test(e.message));
  await assert.rejects(mercadoPagoPoint.verifyWebhook(ctx, { headers: new Headers(), query: new URLSearchParams(), body: {} }), (e) => /sem assinatura/.test(e.message));
});

test("contas puras: bandeira e centavos", () => {
  assert.deepEqual(["visa", "debvisa", "master", "maestro", "elo", "amex", "hipercard", "diners", "cabal", "naranja", ""].map(brandOf),
    ["visa", "visa", "mastercard", "mastercard", "elo", "amex", "hipercard", "diners", "cabal", "outros", null]);
  assert.deepEqual([reaisToCents(159.9), reaisToCents("10.5"), reaisToCents("abc"), reaisToCents(0.1 + 0.2)], [15990, 1050, null, 30]);
});

test("contrato: parte Caixa / PDV; o bot só consulta os pagamentos; cobrar, cancelar, reenviar e configurar ficam na tela", () => {
  assert.equal(ERP_TERMINAL_PART, "erp-pdv");
  const forBot = ERP_TERMINAL_OPERATIONS.filter((op) => op.bot !== false);
  assert.deepEqual(forBot.map((op) => op.name).sort(), ["erp.maquininha.pagamento", "erp.maquininha.pagamentos"]);
  for (const op of forBot) { assert.equal(op.method, "GET"); assert.equal(op.sensitive, false); }
  for (const name of ["erp.maquininha.cobrar", "erp.maquininha.cancelar", "erp.maquininha.reenviar", "erp.maquininha.configuracao.salvar", "erp.maquininha.caixa.salvar", "erp.maquininha.venda_concluida"])
    assert.equal(ERP_TERMINAL_OPERATIONS.find((op) => op.name === name).bot, false, name);
  assert.deepEqual(ERP_TERMINAL_MODULE_CONTRACT.definition.bot.sensitive, []);
  assert.deepEqual(Object.keys(ERP_TERMINAL_MODULE_CONTRACT.definition.bot.hints).sort(), ["erp.maquininha.pagamento", "erp.maquininha.pagamentos"]);
  assert.equal(erpTerminalOperationFor("POST", "erp-maquininha/cobrar").operation.name, "erp.maquininha.cobrar");
  assert.deepEqual(erpTerminalOperationFor("GET", "erp-maquininha/pagamentos/abc").params, { id: "abc" });
  assert.equal(erpTerminalOperationFor("GET", "erp-maquininha/cobrar"), null);
  assert.deepEqual(Object.keys(erpTerminalParams(forBot.find((op) => op.name === "erp.maquininha.pagamentos")).properties).sort(), ["ate", "desde", "venda"]);
  for (const op of ERP_TERMINAL_OPERATIONS) assert.doesNotMatch(`${op.summary} ${op.description}`, /Fagoo|Origin/);
});

test("observação da parcela: bandeira, débito ou crédito com as parcelas, final, autorização e NSU", () => {
  assert.equal(terminalPaymentNote({ provider: "mercadopago", kind: "credito", installments: 3, brand: "mastercard", authorization: "A1B2C3", nsu: "998877", last4: "4321" }),
    "Maquininha Mercado Pago · Mastercard crédito 3x · final 4321 · autorização A1B2C3 · NSU 998877");
  assert.equal(terminalPaymentNote({ provider: "mercadopago", kind: "debito", installments: 1, brand: null, authorization: null, nsu: null }), "Maquininha Mercado Pago · débito");
  assert.equal(terminalPaymentNote({ provider: "mercadopago", kind: "credito", installments: 1, brand: "visa", authorization: null, nsu: "1" }), "Maquininha Mercado Pago · Visa crédito à vista · NSU 1");
});
