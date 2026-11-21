// Maquininha integrada ao caixa (src/erp/terminal/service.ts) no D1, com o
// Mercado Pago Point simulado no lugar da rede e o ERP simulado (contexto da
// frente de caixa, a venda e a conciliação): nasce desligada e só o
// administrador muda; a cobrança vai com o valor das parcelas da forma da
// maquininha; aprovado traz bandeira, parcelas, autorização e NSU; recusado
// diz o motivo; nunca duas cobranças em andamento; resposta incerta é
// consultada antes de qualquer reenvio, que pede a confirmação da pessoa; o
// aviso assinado só faz consultar; parte desligada recusa; segredos fora das
// tabelas e das respostas; o bot só consulta. Nenhuma chamada de verdade.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { uid, type Actor } from "../src/types";
import { hmac, setSecret, secret } from "../src/security";
import type { TerminalHttp, TerminalHttpRequest } from "../src/erp/terminal/adapter";
import { pointManifest } from "../src/erp/terminal/providers/mercadopago-point";
import {
  cancelTerminalPayment, chargeTerminal, requirePdv, resendTerminalPayment, saveTerminalSettings, setTerminalErp, setTerminalTransport, terminalPayment,
  terminalPayments, terminalSaleFinished, terminalSettings, terminalWebhook, type TerminalErp, type TerminalPaymentRow, type TerminalReconcileArgs, type TerminalSale,
} from "../src/erp/terminal/service";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../src/modules/erp/bot-access";
import { erpPdvModule } from "../src/modules/erp/definition";
import { setModule } from "./erp-module-helper";

const admin = { id: "u-admin", kind: "user", name: "Dona", role: "admin", profiles: ["*"], scopes: [], bots: [] } as unknown as Actor;
const cashier = { ...admin, id: "u-caixa", role: "operator" } as unknown as Actor;
const store = "11111111-1111-4111-8111-111111111111";
const saleId = "22222222-2222-4222-8222-222222222222";
const DEBIT = "33333333-3333-4333-8333-333333333333";
const CREDIT = "44444444-4444-4444-8444-444444444444";
const DEVICE = "PAX_A910__SMARTPOS1";

afterEach(() => { setTerminalTransport(null); setTerminalErp(null); });

/** ERP simulado: a frente de caixa com a loja e as formas, a venda (mutável) e as chamadas da conciliação. */
function fakeErp(sale: Partial<TerminalSale> = {}) {
  const state = {
    sale: { id: saleId, number: "57", state: "open", account_id: store, payments: [
      { position: 1, payment_method_id: CREDIT, amount_cents: "10000", title_id: null, note: null },
      { position: 2, payment_method_id: CREDIT, amount_cents: "5990", title_id: null, note: null },
      { position: 3, payment_method_id: "55555555-5555-4555-8555-555555555555", amount_cents: "1000", title_id: null, note: null }], ...sale } as TerminalSale,
    permissions: { payments: true, finish: true },
    reconciled: [] as TerminalReconcileArgs[],
  };
  const port: TerminalErp = {
    context: async () => ({ stores: [{ id: store, name: "Loja do centro" }], permissions: state.permissions,
      methods: [{ id: DEBIT, description: "Cartão de débito", payment_type: "04" }, { id: CREDIT, description: "Cartão de crédito", payment_type: "03" },
        { id: "55555555-5555-4555-8555-555555555555", description: "Dinheiro", payment_type: "01" }] }),
    sale: async () => structuredClone(state.sale),
    reconcile: async (_env, _actor, _profile, args) => { state.reconciled.push(args); return { state: "matched", note: "Na conciliação de cartões, já casado com a venda." }; },
  };
  setTerminalErp(port);
  return state;
}

/** Mercado Pago Point simulado: a intenção muda com `next`; guarda os pedidos. */
function point(options: { create?: () => { status: number; body: unknown } | Error; intent?: () => Record<string, unknown>; payment?: () => Record<string, unknown>; events?: () => unknown[] } = {}) {
  const requests: TerminalHttpRequest[] = [];
  const http: TerminalHttp = async request => {
    requests.push(request);
    if (request.method === "POST" && request.url.includes("/payment-intents")) {
      const reply = options.create?.() ?? { status: 201, body: { id: `pi-${requests.filter(r => r.method === "POST").length}` } };
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (request.method === "GET" && request.url.includes("/payment-intents/events")) return { status: 200, body: { events: options.events?.() ?? [] } };
    if (request.method === "GET" && request.url.includes("/payment-intents/")) {
      const id = request.url.split("/").pop()!;
      const sent = requests.find(r => r.method === "POST");
      const reference = sent ? JSON.parse(sent.body!).additional_info.external_reference : null;
      return { status: 200, body: { id, device_id: DEVICE, amount: 15990, state: "OPEN", additional_info: { external_reference: reference }, payment: {}, ...options.intent?.() } };
    }
    if (request.method === "GET" && request.url.includes("/v1/payments/")) return { status: 200, body: { id: 777, transaction_amount: 159.9, ...options.payment?.() } };
    if (request.method === "DELETE") return { status: 200, body: {} };
    if (request.method === "GET" && request.url.includes("/devices")) return { status: 200, body: { devices: [{ id: DEVICE, operating_mode: "PDV" }] } };
    return { status: 404, body: null };
  };
  setTerminalTransport(() => http);
  return requests;
}

/** Área com o Caixa / PDV (e o que ele pede), a maquininha ligada com token próprio e o terminal da loja. */
async function area(options: { pdv?: boolean; enabled?: boolean } = {}) {
  const profile = `p-${uid()}`;
  for (const id of ["erp", "erp-vendas", "erp-financeiro", "erp-estoque"]) await setModule(profile, id, true, admin.id);
  await setModule(profile, "erp-pdv", options.pdv !== false, admin.id);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
  await setSecret(env, `erp-maquininha:${profile}`, { access_token: "APP_USR-token-do-teste", webhook_secret: "assinatura-do-aviso", webhook_token: token });
  const { sha } = await import("../src/security");
  await exec(env, `INSERT INTO erp_terminal_settings(profile_id,enabled,provider,credential,debit_method_id,credit_method_id,max_installments,installments_cost,webhook_hash,updated_by,updated)
    VALUES(?,?,'mercadopago','propria',?,?,12,'loja',?,?,1)`, profile, options.enabled === false ? 0 : 1, DEBIT, CREDIT, await sha(token), admin.id);
  await exec(env, "INSERT INTO erp_terminal_cashiers(profile_id,account_id,provider,device_id,device_name,updated_by,updated) VALUES(?,?,'mercadopago',?,'Caixa 1',?,1)", profile, store, DEVICE, admin.id);
  return { profile, token };
}
const rowOf = async (id: string) => (await one<TerminalPaymentRow>(env, "SELECT * FROM erp_terminal_payments WHERE id=?", id))!;
/** Libera a próxima consulta (a tela pergunta de 2 em 2 segundos). */
const unthrottle = (id: string) => exec(env, "UPDATE erp_terminal_payments SET checked_at=NULL WHERE id=?", id);
const charge = (profile: string, extra: Record<string, unknown> = {}) =>
  chargeTerminal(env, cashier, profile, { venda: saleId, caixa: store, tipo: "credito", parcelas: 3, comando: uid(), ...extra });

describe("configuração", () => {
  it("nasce desligada; só o administrador muda; o token vai para o cofre e nunca volta; formas conferidas", async () => {
    fakeErp();
    const profile = `p-${uid()}`;
    for (const id of ["erp", "erp-vendas", "erp-financeiro", "erp-estoque", "erp-pdv"]) await setModule(profile, id, true, admin.id);
    const first = await terminalSettings(env, admin, profile, "https://painel.exemplo");
    expect([first.ligado, first.credencial, first.pronto]).toEqual([false, "propria", false]);
    expect(first.formas.map(item => item.tipo)).toEqual(["debito", "credito"]);
    await expect(saveTerminalSettings(env, cashier, profile, { ligado: true }, "")).rejects.toMatchObject({ status: 403 });
    await expect(saveTerminalSettings(env, admin, profile, { credencial: "cobranca" }, "")).rejects.toMatchObject({ code: "erp_terminal_configuracao", message: expect.stringContaining("Cobrança") });
    await expect(saveTerminalSettings(env, admin, profile, { ligado: true, credencial: "propria" }, "")).rejects.toMatchObject({ status: 422 });
    await expect(saveTerminalSettings(env, admin, profile, { forma_debito: CREDIT, forma_credito: CREDIT }, "")).rejects.toMatchObject({ status: 400 });
    await expect(saveTerminalSettings(env, admin, profile, { forma_debito: CREDIT }, "")).rejects.toMatchObject({ message: expect.stringContaining("não é de cartão de débito") });
    const saved = await saveTerminalSettings(env, admin, profile, { ligado: true, credencial: "propria", access_token: "APP_USR-segredo-de-verdade", forma_debito: DEBIT, forma_credito: CREDIT, parcelas_max: 6 }, "https://painel.exemplo");
    expect([saved.ligado, saved.forma_debito_nome, saved.forma_credito_nome, saved.parcelas_max, saved.segredos_guardados]).toEqual([true, "Cartão de débito", "Cartão de crédito", 6, ["access_token"]]);
    expect(saved.aviso_url).toMatch(/^https:\/\/painel\.exemplo\/webhooks\/maquininha\/[0-9a-f]{48}$/);
    expect(saved.falta).toEqual(["a maquininha de um caixa"]);
    expect(JSON.stringify(saved)).not.toContain("segredo-de-verdade");
    expect(JSON.stringify(await terminalSettings(env, cashier, profile, "https://painel.exemplo"))).not.toMatch(/webhooks\/maquininha/);
    for (const table of ["erp_terminal_settings", "erp_terminal_audit"])
      expect(JSON.stringify(await all(env, `SELECT * FROM ${table}`))).not.toContain("segredo-de-verdade");
    expect((await secret(env, `erp-maquininha:${profile}`)).access_token).toBe("APP_USR-segredo-de-verdade");
    const audit = await all(env, "SELECT action FROM erp_terminal_audit WHERE profile_id=? ORDER BY created,rowid", profile);
    expect(audit.map(row => row.action)).toEqual(["settings_on"]);
  });

  it("Caixa / PDV desligado: 409 com o que ligar", async () => {
    const { profile } = await area({ pdv: false });
    await expect(requirePdv(env, profile)).rejects.toMatchObject({ status: 409, code: "module_disabled", message: expect.stringContaining("Caixa / PDV") });
    await expect(charge(profile)).rejects.toMatchObject({ code: "module_disabled" });
  });
});

describe("cobrança no terminal", () => {
  it("envia o valor das parcelas de crédito, espera e aprova com bandeira, parcelas, autorização e NSU; a venda concluída vai para a conciliação", async () => {
    const erp = fakeErp();
    const { profile } = await area();
    let state = "OPEN";
    const requests = point({ intent: () => ({ state, payment: state === "FINISHED" ? { id: 777, type: "credit_card", installments: 3 } : {} }),
      payment: () => ({ status: "approved", payment_method_id: "master", payment_type_id: "credit_card", installments: 3, authorization_code: "A1B2C3",
        card: { last_four_digits: "4321" }, transaction_details: { acquirer_reference: "998877" }, fee_details: [{ amount: 4.8 }] }) });
    const sent = await charge(profile);
    expect(sent.nova).toBe(true);
    expect([sent.pagamento.situacao, sent.pagamento.valor_centavos, sent.pagamento.parcelas, sent.pagamento.em_andamento]).toEqual(["aguardando", "15990", 3, true]);
    expect(sent.pagamento.situacao_rotulo).toBe("Aguardando pagamento na maquininha");
    const body = JSON.parse(requests.find(r => r.method === "POST")!.body!);
    expect(body).toMatchObject({ amount: 15990, payment: { type: "credit_card", installments: 3, installments_cost: "seller" } });
    expect(requests[0].url).toContain(`/devices/${DEVICE}/payment-intents`);
    await unthrottle(sent.pagamento.id);
    expect((await terminalPayment(env, cashier, profile, sent.pagamento.id)).pagamento.situacao).toBe("aguardando");
    state = "FINISHED";
    await unthrottle(sent.pagamento.id);
    const paid = (await terminalPayment(env, cashier, profile, sent.pagamento.id)).pagamento;
    expect([paid.situacao, paid.bandeira, paid.autorizacao, paid.nsu, paid.final_cartao]).toEqual(["aprovado", "mastercard", "A1B2C3", "998877", "4321"]);
    expect(paid.observacao).toBe("Maquininha Mercado Pago · Mastercard crédito 3x · final 4321 · autorização A1B2C3 · NSU 998877");
    // Aprovado e não usado: pedir de novo devolve o mesmo, sem nova cobrança.
    expect((await charge(profile)).pagamento.id).toBe(sent.pagamento.id);
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    await expect(terminalSaleFinished(env, cashier, profile, sent.pagamento.id)).rejects.toMatchObject({ code: "erp_terminal_sale_state" });
    erp.sale.state = "finished";
    const done = (await terminalSaleFinished(env, cashier, profile, sent.pagamento.id)).pagamento;
    expect([done.venda_concluida, done.conciliacao]).toEqual([true, "matched"]);
    expect(erp.reconciled).toEqual([expect.objectContaining({ sale_id: saleId, payment_method_id: CREDIT, acquirer: "mercadopago", product: "credit", brand: "mastercard",
      installments: 3, gross_cents: "15990", fee_cents: "480", nsu: "998877", authorization: "A1B2C3", reference: sent.pagamento.id })]);
    await terminalSaleFinished(env, cashier, profile, sent.pagamento.id);
    expect(erp.reconciled).toHaveLength(1);
    expect((await terminalPayments(env, cashier, profile, new URLSearchParams({ venda: saleId }))).pagamentos.map(p => p.id)).toEqual([sent.pagamento.id]);
  });

  it("recusado: a venda continua aberta com o motivo em palavras; cobrar de novo sai outra cobrança", async () => {
    fakeErp();
    const { profile } = await area();
    const requests = point({ intent: () => ({ state: "FINISHED", payment: { id: 777 } }), payment: () => ({ status: "rejected", status_detail: "cc_rejected_insufficient_amount", payment_type_id: "credit_card" }) });
    const sent = await charge(profile);
    await unthrottle(sent.pagamento.id);
    const refused = (await terminalPayment(env, cashier, profile, sent.pagamento.id)).pagamento;
    expect([refused.situacao, refused.motivo, refused.em_andamento, refused.observacao]).toEqual(["recusado", "Saldo ou limite insuficiente no cartão.", false, null]);
    const second = await charge(profile);
    expect(second.nova).toBe(true);
    expect(requests.filter(r => r.method === "POST")).toHaveLength(2);
  });

  it("nunca duas em andamento: o mesmo comando e outro comando devolvem a mesma cobrança, sem enviar de novo", async () => {
    fakeErp();
    const { profile } = await area();
    const requests = point();
    const command = uid();
    const first = await charge(profile, { comando: command });
    expect((await charge(profile, { comando: command })).pagamento.id).toBe(first.pagamento.id);
    const other = await charge(profile);
    expect([other.nova, other.pagamento.id]).toEqual([false, first.pagamento.id]);
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    // Cancelar a que espera libera uma nova.
    const cancelled = (await cancelTerminalPayment(env, cashier, profile, first.pagamento.id)).pagamento;
    expect(requests.some(r => r.method === "DELETE")).toBe(true);
    expect(cancelled.situacao).toBe("cancelado");
  });

  it("resposta incerta: consulta antes; achou, segue a mesma; não achou, só reenvia com a confirmação da pessoa", async () => {
    fakeErp();
    const { profile } = await area();
    let fail = true, events: unknown[] = [];
    const requests = point({ create: () => fail ? new Error("timeout") : { status: 201, body: { id: "pi-novo" } }, events: () => events });
    const sent = await charge(profile);
    expect([sent.pagamento.situacao, sent.pagamento.pode_reenviar]).toEqual(["incerto", true]);
    expect(sent.pagamento.motivo).toMatch(/confere antes de enviar outra/);
    // Pedir de novo consulta (não está no provedor) e não envia outra.
    const again = await charge(profile);
    expect([again.nova, again.pagamento.id, again.pagamento.situacao]).toEqual([false, sent.pagamento.id, "incerto"]);
    expect(again.pagamento.motivo).toMatch(/Não achamos a cobrança/);
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    await expect(resendTerminalPayment(env, cashier, profile, sent.pagamento.id, {})).rejects.toMatchObject({ code: "erp_terminal_confirm_required" });
    // Achou no provedor (a primeira tinha chegado): segue a mesma, sem reenviar.
    events = [{ payment_intent_id: "pi-chegou" }];
    const found = await resendTerminalPayment(env, cashier, profile, sent.pagamento.id, { confirmo: true });
    expect([found.reenviado, found.pagamento.situacao]).toEqual([false, "aguardando"]);
    expect((await rowOf(sent.pagamento.id)).provider_ref).toBe("pi-chegou");
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
  });

  it("resposta incerta sem a cobrança no provedor: a pessoa confirma e sai o reenvio, com a mesma referência", async () => {
    fakeErp();
    const { profile } = await area();
    let fail = true;
    const requests = point({ create: () => fail ? new Error("timeout") : { status: 201, body: { id: "pi-novo" } } });
    const sent = await charge(profile);
    fail = false;
    const resent = await resendTerminalPayment(env, cashier, profile, sent.pagamento.id, { confirmo: true });
    expect([resent.reenviado, resent.pagamento.situacao]).toEqual([true, "aguardando"]);
    const posts = requests.filter(r => r.method === "POST").map(r => JSON.parse(r.body!).additional_info.external_reference);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    expect((await rowOf(sent.pagamento.id)).attempts).toBe(2);
  });

  it("recusas antes de enviar: desligada, sem maquininha no caixa, outra loja, venda fechada, sem parcela na forma, papel sem fechamento", async () => {
    const erp = fakeErp();
    const off = await area({ enabled: false });
    point();
    await expect(charge(off.profile)).rejects.toMatchObject({ code: "erp_terminal_off", message: expect.stringContaining("Preferências") });
    const { profile } = await area();
    await expect(charge(profile, { caixa: "66666666-6666-4666-8666-666666666666" })).rejects.toMatchObject({ code: "erp_terminal_no_device" });
    await expect(charge(profile, { tipo: "debito", parcelas: 2 })).rejects.toMatchObject({ status: 400 });
    await expect(charge(profile, { parcelas: 13 })).rejects.toMatchObject({ status: 400 });
    await expect(charge(profile, { tipo: "debito", parcelas: 1 })).rejects.toMatchObject({ code: "erp_terminal_no_amount", message: expect.stringContaining("Cartão de débito") });
    erp.permissions.finish = false;
    await expect(charge(profile)).rejects.toMatchObject({ status: 403 });
    erp.permissions.finish = true;
    erp.sale.account_id = "77777777-7777-4777-8777-777777777777";
    await expect(charge(profile)).rejects.toMatchObject({ code: "erp_terminal_sale_store" });
    erp.sale.account_id = store; erp.sale.state = "finished";
    await expect(charge(profile)).rejects.toMatchObject({ code: "erp_terminal_sale_state" });
    expect(await all(env, "SELECT id FROM erp_terminal_payments WHERE profile_id=?", profile)).toEqual([]);
  });

  it("a cobrança no provedor que não confere com a venda nunca vale como pagamento", async () => {
    fakeErp();
    const { profile } = await area();
    point({ intent: () => ({ state: "FINISHED", amount: 100, payment: { id: 777 } }), payment: () => ({ status: "approved", transaction_amount: 1 }) });
    const sent = await charge(profile);
    await unthrottle(sent.pagamento.id);
    const checked = (await terminalPayment(env, cashier, profile, sent.pagamento.id)).pagamento;
    expect([checked.situacao, checked.observacao]).toEqual(["erro", null]);
    expect(checked.motivo).toMatch(/não confere com a venda/);
  });
});

describe("aviso do provedor", () => {
  it("assinado: consulta a cobrança citada; sem assinatura válida, 401; código desconhecido, 404", async () => {
    fakeErp();
    const { profile, token } = await area();
    let state = "OPEN";
    point({ intent: () => ({ state, payment: state === "FINISHED" ? { id: 777 } : {} }), payment: () => ({ status: "approved", payment_method_id: "visa", payment_type_id: "credit_card", installments: 3 }) });
    const sent = await charge(profile);
    const ref = (await rowOf(sent.pagamento.id)).provider_ref!;
    state = "FINISHED";
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = await hmac("assinatura-do-aviso", pointManifest(ref, "req-1", ts));
    const input = (signature: string) => ({ headers: new Headers({ "x-signature": signature, "x-request-id": "req-1" }), query: new URLSearchParams({ "data.id": ref }), body: { id: ref, state: "FINISHED" } });
    await expect(terminalWebhook(env, token, input(`ts=${ts},v1=${"0".repeat(64)}`))).rejects.toMatchObject({ status: 401 });
    expect((await rowOf(sent.pagamento.id)).status).toBe("aguardando");
    await expect(terminalWebhook(env, "f".repeat(48), input(`ts=${ts},v1=${v1}`))).rejects.toMatchObject({ status: 404 });
    expect(await terminalWebhook(env, token, input(`ts=${ts},v1=${v1}`))).toEqual({ received: true, checked: 1 });
    expect((await rowOf(sent.pagamento.id)).status).toBe("aprovado");
  });
});

describe("bots", () => {
  it("só consultam os pagamentos da maquininha; enviar ao terminal não existe para eles; a rota é do Caixa / PDV", () => {
    const ops = ERP_BOT_OPERATIONS.filter(op => op.id.startsWith("erp.maquininha."));
    expect(ops.map(op => [op.id, op.method, op.sensitive]).sort()).toEqual([["erp.maquininha.pagamento", "GET", false], ["erp.maquininha.pagamentos", "GET", false]]);
    for (const op of ops) expect(erpBotModules(op)).toContain("erp-pdv");
    expect(erpPdvModule.routes).toContain("erp-maquininha");
    expect(erpPdvModule.bot?.sensitive ?? []).toEqual([]);
  });
});
