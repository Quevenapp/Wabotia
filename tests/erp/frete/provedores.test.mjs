// Frete: os adaptadores dos Correios e do Melhor Envio contra provedores
// simulados (nenhuma rede): cotação com preço e prazo, contratação com a
// referência do Wabotia, resposta incerta marcada como incerta (nunca repetida
// às cegas), consulta do envio, etiqueta em PDF, cancelamento e rastreio
// normalizado; credenciais nunca aparecem nas mensagens. E o contrato das
// rotas: cotar e consultar são leitura; contratar e cancelar, sensíveis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { correiosProvider, CORREIOS_SANDBOX, CORREIOS_PRODUCTION } from "../../../src/erp/frete/correios.ts";
import { melhorEnvioProvider, MELHORENVIO_SANDBOX } from "../../../src/erp/frete/melhorenvio.ts";
import { FreightError, moneyCents, postalCode } from "../../../src/erp/frete/provider.ts";
import { correiosStatus, latestStatus, melhorEnvioStatus, nextCheck, trackingMessage, whatsappPhone } from "../../../src/erp/frete/tracking.ts";
import { ERP_FREIGHT_OPERATIONS, erpFreightOperationFor, erpFreightParams } from "../../../src/erp/frete/contract.ts";

const SECRET = "segredo-que-nao-pode-vazar-123";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/** Provedor simulado: rotas "MÉTODO caminho" → resposta (função ou valor); guarda as chamadas. */
function simulated(routes) {
  const calls = [];
  const http = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => { const [m, p] = k.split(" "); return m === init.method && (p.endsWith("*") ? u.pathname.startsWith(p.slice(0, -1)) : u.pathname === p); });
    if (!key) return new Response(JSON.stringify({ message: "rota não simulada" }), { status: 404 });
    const out = typeof routes[key] === "function" ? await routes[key]({ url: u, init, calls }) : routes[key];
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    if (out instanceof Uint8Array) return new Response(out, { status: 200, headers: { "Content-Type": "application/pdf" } });
    // [status, corpo] quando o primeiro item é o código HTTP; senão o próprio valor é o corpo (com 200).
    const [status, body] = Array.isArray(out) && typeof out[0] === "number" ? out : [200, out];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { http, calls };
}
const noSecret = (error) => { assert.ok(!String(error?.message).includes(SECRET), "a mensagem não leva a credencial"); return true; };

const volume = { length_mm: 200, width_mm: 150, height_mm: 101, weight_g: 900 };
const address = (name, cep) => ({ name, document: "11444777000161", phone: "11987654321", email: null, street: "Rua A", number: "10", complement: null, district: "Centro", city: "São Paulo", state: "SP", postal_code: cep });
const contractReq = (overrides = {}) => ({
  reference: "11111111-2222-4333-8444-555555555555", service_code: "03220", order_number: 42, from: address("Loja do Ensaio", "01001000"), to: address("Cliente", "20040002"),
  volumes: [volume], declared_cents: 6000, items: [{ description: "Caneca", quantity: 2, unit_cents: 3000 }], invoice: null, ...overrides,
});

test("contas: dinheiro dos provedores, CEP, rastreio normalizado e o aviso ao cliente", () => {
  assert.equal(moneyCents("25,30"), 2530);
  assert.equal(moneyCents("1.234,56"), 123456);
  assert.equal(moneyCents("18.9"), 1890);
  assert.equal(moneyCents(17.5), 1750);
  assert.equal(moneyCents("abc"), null);
  assert.equal(postalCode("01001-000"), "01001000");
  assert.equal(postalCode("123"), null);
  assert.equal(correiosStatus("BDE", "01", "Objeto entregue ao destinatário"), "delivered");
  assert.equal(correiosStatus("OEC", "01", "Objeto saiu para entrega ao destinatário"), "out_for_delivery");
  assert.equal(correiosStatus("PO", "01", "Objeto postado"), "posted");
  assert.equal(correiosStatus("RO", "01", "Objeto em transferência - por favor aguarde"), "in_transit");
  assert.equal(correiosStatus("LDI", "01", "Objeto aguardando retirada no endereço indicado"), "waiting_pickup");
  assert.equal(correiosStatus("BDE", "20", "Carteiro não atendido"), "exception");
  assert.equal(melhorEnvioStatus("posted"), "posted");
  assert.equal(melhorEnvioStatus("canceled"), "cancelled");
  assert.equal(latestStatus([{ at: 2, status: "in_transit" }, { at: 3, status: "delivered" }, { at: 1, status: "posted" }]), "delivered");
  assert.ok(nextCheck(0, 0) < nextCheck(0, 3));
  assert.equal(whatsappPhone("(11) 98765-4321"), "5511987654321");
  assert.equal(whatsappPhone("123"), null);
  const text = trackingMessage({ customer: "Maria da Silva", order_number: 42, status: "out_for_delivery", description: "Objeto saiu para entrega", location: "Rio de Janeiro/RJ", tracking_code: "AB123456789BR" });
  assert.match(text, /^Olá, Maria! Seu pedido 42 saiu para entrega/);
  assert.match(text, /AB123456789BR/);
});

test("Correios: token pelo cartão, preço e prazo de cada serviço do contrato, na homologação", async () => {
  const { http, calls } = simulated({
    "POST /token/v1/autentica/cartaopostagem": { token: "tok-1", expiraEm: "2026-11-22T00:00:00" },
    "GET /preco/v1/nacional/03220": { pcFinal: "32,10" },
    "GET /preco/v1/nacional/03298": { pcFinal: "21,40" },
    "GET /prazo/v1/nacional/03220": { prazoEntrega: 2 },
    "GET /prazo/v1/nacional/03298": { prazoEntrega: 6 },
  });
  const conn = { sandbox: true, credentials: { usuario: "empresa", codigo_acesso: SECRET, cartao_postagem: "0067599079" }, options: { contrato: "9912345678", dr: "72" } };
  const options = await correiosProvider.quote(http, conn, { from_postal_code: "01001000", to_postal_code: "20040002", volumes: [volume], declared_cents: 6000 });
  assert.deepEqual(options.map((o) => [o.service_name, o.price_cents, o.delivery_days]), [["SEDEX", 3210, 2], ["PAC", 2140, 6]]);
  assert.ok(calls.every((c) => c.path && true));
  const auth = calls[0];
  assert.equal(auth.headers.Authorization, `Basic ${btoa(`empresa:${SECRET}`)}`);
  assert.deepEqual(auth.body, { numero: "0067599079" });
  const price = calls.find((c) => c.path === "/preco/v1/nacional/03220");
  const q = new URLSearchParams(price.query);
  assert.deepEqual([q.get("psObjeto"), q.get("comprimento"), q.get("altura"), q.get("nuContrato"), q.get("nuDR")], ["900", "20", "11", "9912345678", "72"]);
  assert.equal(price.headers.Authorization, "Bearer tok-1");
  // Homologação x produção pelo interruptor.
  const urls = [];
  await correiosProvider.check(async (url) => { urls.push(url); return new Response(JSON.stringify({ token: "t" })); }, { ...conn, sandbox: false });
  assert.ok(urls[0].startsWith(CORREIOS_PRODUCTION));
  assert.ok(!CORREIOS_PRODUCTION.startsWith(CORREIOS_SANDBOX));
});

test("Correios: credencial recusada e falta de credencial dizem o que fazer, sem mostrar a credencial", async () => {
  const { http } = simulated({ "POST /token/v1/autentica/cartaopostagem": [401, { msgs: [`Usuário ou senha ${SECRET} inválidos`] }] });
  const conn = { sandbox: true, credentials: { usuario: "empresa", codigo_acesso: SECRET, cartao_postagem: "1" }, options: {} };
  await assert.rejects(correiosProvider.check(http, conn), (e) => e instanceof FreightError && e.code === "freight_provider_auth" && /Confira em Expedição/.test(e.message) && noSecret(e));
  await assert.rejects(correiosProvider.check(http, { ...conn, credentials: {} }), (e) => e.code === "freight_provider_not_configured" && /usuário/.test(e.message));
});

test("Correios: pré-postagem com a referência, etiqueta assíncrona em PDF, consulta, cancelamento e rastro", async () => {
  let created = 0;
  const { http, calls } = simulated({
    "POST /token/v1/autentica/cartaopostagem": { token: "tok" },
    "POST /prepostagem/v1/prepostagens": () => { created++; return { id: "PP123", codigoObjeto: "AB123456789BR" }; },
    "POST /prepostagem/v1/prepostagens/rotulo/assincrono/pdf": { idRecibo: "R1" },
    "GET /prepostagem/v1/prepostagens/rotulo/download/assincrono/R1": { dados: b64(PDF) },
    "GET /prepostagem/v1/prepostagens": { itens: [{ id: "PP123", codigoObjeto: "AB123456789BR", observacao: contractReq().reference, statusAtual: "PREPOSTADO" }] },
    "DELETE /prepostagem/v1/prepostagens/PP123": { ok: true },
    "GET /srorastro/v1/objetos/AB123456789BR": { objetos: [{ codObjeto: "AB123456789BR", eventos: [
      { codigo: "BDE", tipo: "01", dtHrCriado: "2026-11-23T14:10:00", descricao: "Objeto entregue ao destinatário", unidade: { endereco: { cidade: "Rio de Janeiro", uf: "RJ" } } },
      { codigo: "PO", tipo: "01", dtHrCriado: "2026-11-21T09:00:00", descricao: "Objeto postado", unidade: { endereco: { cidade: "São Paulo", uf: "SP" } } },
    ] }] },
  });
  const conn = { sandbox: true, credentials: { usuario: "u", codigo_acesso: SECRET, cartao_postagem: "1" }, options: {} };
  const result = await correiosProvider.contract(http, conn, contractReq());
  assert.deepEqual(result, { provider_ref: "PP123", tracking_code: "AB123456789BR", price_cents: null });
  const body = calls.find((c) => c.method === "POST" && c.path === "/prepostagem/v1/prepostagens").body;
  assert.equal(body.observacao, contractReq().reference, "a referência vai junto para a consulta da resposta incerta");
  assert.equal(body.codigoServico, "03220");
  assert.equal(body.destinatario.endereco.cep, "20040002");
  assert.deepEqual([body.destinatario.dddCelular, body.destinatario.celular], ["11", "987654321"]);
  assert.equal(body.itensDeclaracaoConteudo[0].valor, "30.00");
  // Com NF-e: a chave no lugar da declaração de conteúdo.
  await correiosProvider.contract(http, conn, contractReq({ invoice: { key: "3".repeat(44), number: 10, series: 1 } }));
  const withNfe = calls.filter((c) => c.method === "POST" && c.path === "/prepostagem/v1/prepostagens")[1].body;
  assert.equal(withNfe.chaveNFe, "3".repeat(44));
  assert.equal(withNfe.itensDeclaracaoConteudo, undefined);
  // Mais de um volume: recusa dizendo o que fazer, sem chamar a pré-postagem.
  await assert.rejects(correiosProvider.contract(http, conn, contractReq({ volumes: [volume, volume] })), (e) => e.code === "freight_correios_one_volume");
  assert.equal(created, 2);
  // Consulta pela referência (sem o número) e pelo número.
  assert.equal((await correiosProvider.find(http, conn, contractReq().reference, null)).provider_ref, "PP123");
  assert.equal(await correiosProvider.find(http, conn, "outra-referencia", null), null, "o provedor confirma que não existe");
  assert.deepEqual([...(await correiosProvider.label(http, conn, "PP123"))], [...PDF]);
  await correiosProvider.cancel(http, conn, "PP123");
  const events = await correiosProvider.track(http, conn, "PP123", "AB123456789BR");
  assert.deepEqual(events.map((e) => [e.status, e.location]), [["delivered", "Rio de Janeiro/RJ"], ["posted", "São Paulo/SP"]]);
  assert.equal(events[1].at, Date.parse("2026-11-21T09:00:00-03:00"), "horário de Brasília");
});

test("Correios: rede caída na pré-postagem é resposta incerta; recusa clara não é", async () => {
  const conn = { sandbox: true, credentials: { usuario: "u", codigo_acesso: SECRET, cartao_postagem: "1" }, options: {} };
  const down = simulated({ "POST /token/v1/autentica/cartaopostagem": { token: "t" }, "POST /prepostagem/v1/prepostagens": new TypeError("network") });
  await assert.rejects(correiosProvider.contract(down.http, conn, contractReq()), (e) => e.uncertain === true && /consulta antes/.test(e.message) && noSecret(e));
  const broken = simulated({ "POST /token/v1/autentica/cartaopostagem": { token: "t" }, "POST /prepostagem/v1/prepostagens": [503, { msg: "fora do ar" }] });
  await assert.rejects(correiosProvider.contract(broken.http, conn, contractReq()), (e) => e.uncertain === true);
  const refused = simulated({ "POST /token/v1/autentica/cartaopostagem": { token: "t" }, "POST /prepostagem/v1/prepostagens": [400, { msgs: ["CEP do destinatário inválido"] }] });
  await assert.rejects(correiosProvider.contract(refused.http, conn, contractReq()), (e) => e.uncertain === false && /CEP do destinatário inválido/.test(e.message));
  // Leitura (cotação) com rede caída não é incerta: só tenta de novo.
  const quoteDown = simulated({ "POST /token/v1/autentica/cartaopostagem": new TypeError("network") });
  await assert.rejects(correiosProvider.quote(quoteDown.http, conn, { from_postal_code: "01001000", to_postal_code: "20040002", volumes: [volume], declared_cents: 0 }), (e) => e.uncertain === false);
});

test("Melhor Envio: cotação, carrinho com a referência, pagamento e geração pela situação, etiqueta, cancelamento e rastreio", async () => {
  const order = { id: "ME-1", status: "pending", generated_at: null, tracking: null, price: "19.90" };
  const { http, calls } = simulated({
    "GET /api/v2/me": { email: "loja@exemplo.com.br" },
    "POST /api/v2/me/shipment/calculate": [
      { id: 1, name: "PAC", price: "19.90", delivery_time: 7, company: { name: "Correios" } },
      { id: 3, name: ".Package", custom_price: "15.50", custom_delivery_time: 5, company: { name: "Jadlog" } },
      { id: 17, name: "Mini Envios", error: "Dimensões acima do permitido" },
    ],
    "POST /api/v2/me/cart": () => ({ id: "ME-1", protocol: "ORD-1", status: "pending" }),
    "GET /api/v2/me/orders/ME-1": () => ({ ...order }),
    "POST /api/v2/me/shipment/checkout": () => { order.status = "released"; return { purchase: { id: "P1" } }; },
    "POST /api/v2/me/shipment/generate": () => { order.generated_at = "2026-11-21 10:00:00"; order.tracking = "ME2611ABCDE"; return { "ME-1": { status: true } }; },
    "POST /api/v2/me/shipment/print": { url: "https://sandbox.melhorenvio.com.br/imprimir/abc" },
    "GET /imprimir/abc": PDF,
    "POST /api/v2/me/shipment/cancellable": { "ME-1": { cancellable: true } },
    "POST /api/v2/me/shipment/cancel": { "ME-1": { canceled: true } },
    "GET /api/v2/me/orders/search": [{ id: "ME-1", tags: [{ tag: contractReq().reference }] }],
    "POST /api/v2/me/shipment/tracking": { "ME-1": { status: "posted", tracking: "ME2611ABCDE", generated_at: "2026-11-21 10:00:00", posted_at: "2026-11-21 16:30:00", delivered_at: null } },
  });
  const conn = { sandbox: true, credentials: { token: SECRET }, options: { email: "tecnico@exemplo.com.br" } };
  assert.deepEqual(await melhorEnvioProvider.check(http, conn), { account: "loja@exemplo.com.br" });
  assert.ok(calls[0].headers["User-Agent"].includes("tecnico@exemplo.com.br"));
  assert.ok(calls[0].headers.Authorization.endsWith(SECRET));
  const options = await melhorEnvioProvider.quote(http, conn, { from_postal_code: "01001000", to_postal_code: "20040002", volumes: [volume], declared_cents: 6000 });
  assert.deepEqual(options.map((o) => [o.service_code, o.company, o.price_cents, o.delivery_days]), [["1", "Correios", 1990, 7], ["3", "Jadlog", 1550, 5]], "o serviço com erro fica fora");
  const calc = calls.find((c) => c.path === "/api/v2/me/shipment/calculate").body;
  assert.deepEqual(calc.volumes, [{ height: 11, width: 15, length: 20, weight: 0.9 }]);
  assert.equal(calc.options.insurance_value, 60);

  const result = await melhorEnvioProvider.contract(http, conn, contractReq({ service_code: "1" }));
  assert.deepEqual(result, { provider_ref: "ME-1", tracking_code: "ME2611ABCDE", price_cents: 1990, cancelled: false });
  const cart = calls.find((c) => c.path === "/api/v2/me/cart").body;
  assert.deepEqual(cart.options.tags, [{ tag: contractReq().reference, url: null }]);
  assert.equal(cart.options.non_commercial, true);
  assert.equal(cart.to.company_document, "11444777000161");
  assert.equal(calls.filter((c) => c.path === "/api/v2/me/shipment/checkout").length, 1);
  // Consultar de novo um envio já pago e gerado não paga nem gera outra vez.
  await melhorEnvioProvider.find(http, conn, contractReq().reference, "ME-1");
  assert.equal(calls.filter((c) => c.path === "/api/v2/me/shipment/checkout").length, 1);
  assert.equal(calls.filter((c) => c.path === "/api/v2/me/shipment/generate").length, 1);
  assert.equal((await melhorEnvioProvider.find(http, conn, contractReq().reference, null)).provider_ref, "ME-1", "acha pela etiqueta interna");
  assert.deepEqual([...(await melhorEnvioProvider.label(http, conn, "ME-1"))], [...PDF]);
  const events = await melhorEnvioProvider.track(http, conn, "ME-1", "ME2611ABCDE");
  assert.deepEqual(events.map((e) => e.status), ["label_created", "posted"]);
  await melhorEnvioProvider.cancel(http, conn, "ME-1");
  assert.equal(calls.find((c) => c.path === "/api/v2/me/shipment/cancel").body.order.id, "ME-1");
  assert.ok(MELHORENVIO_SANDBOX.includes("sandbox"));
});

test("Melhor Envio: o carrinho criado e o pagamento sem resposta voltam incertos com o número do envio", async () => {
  const conn = { sandbox: true, credentials: { token: SECRET }, options: { email: "t@e.com" } };
  const { http } = simulated({
    "POST /api/v2/me/cart": { id: "ME-9", status: "pending" },
    "GET /api/v2/me/orders/ME-9": { id: "ME-9", status: "pending" },
    "POST /api/v2/me/shipment/checkout": new TypeError("network"),
  });
  await assert.rejects(melhorEnvioProvider.contract(http, conn, contractReq({ service_code: "1" })),
    (e) => e instanceof FreightError && e.uncertain && e.providerRef === "ME-9" && noSecret(e));
  const cancelRefused = simulated({ "POST /api/v2/me/shipment/cancellable": { "ME-9": { cancellable: false } } });
  await assert.rejects(melhorEnvioProvider.cancel(cancelRefused.http, conn, "ME-9"), (e) => e.code === "freight_cancel_refused" && !e.uncertain);
  await assert.rejects(melhorEnvioProvider.quote(http, { ...conn, credentials: {} }, { from_postal_code: "01001000", to_postal_code: "20040002", volumes: [volume], declared_cents: 0 }),
    (e) => e.code === "freight_provider_not_configured");
});

test("contrato: cotar e consultar são leitura para o bot; contratar e cancelar são sensíveis; o resto é da tela", () => {
  const byName = Object.fromEntries(ERP_FREIGHT_OPERATIONS.map((op) => [op.name, op]));
  for (const op of ERP_FREIGHT_OPERATIONS) {
    assert.ok(op.path.startsWith("erp-expedicao/frete/"), op.name);
    assert.ok(op.name.startsWith("erp.expedicao.frete."), op.name);
    assert.equal(op.sensitive, op.method !== "GET", op.name);
    assert.ok(op.description.length > 30 && !/Fagoo|Origin/.test(op.description), op.name);
  }
  const bot = ERP_FREIGHT_OPERATIONS.filter((op) => op.bot !== false);
  assert.deepEqual(bot.filter((op) => !op.sensitive).map((op) => op.name), ["erp.expedicao.frete.pedido", "erp.expedicao.frete.cotar"]);
  assert.deepEqual(bot.filter((op) => op.sensitive).map((op) => op.name), ["erp.expedicao.frete.contratar", "erp.expedicao.frete.cancelar"]);
  assert.ok(ERP_FREIGHT_OPERATIONS.filter((op) => op.admin).every((op) => op.bot === false));
  const id = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
  assert.equal(erpFreightOperationFor("GET", `erp-expedicao/frete/pedidos/${id}/cotacao`).operation.name, "erp.expedicao.frete.cotar");
  assert.equal(erpFreightOperationFor("POST", `erp-expedicao/frete/pedidos/${id}/envio/cancelar`).operation.name, "erp.expedicao.frete.cancelar");
  assert.equal(erpFreightOperationFor("POST", "erp-expedicao/frete/provedores/correios").params.provedor, "correios");
  assert.equal(erpFreightOperationFor("DELETE", `erp-expedicao/frete/pedidos/${id}`), null);
  assert.deepEqual(erpFreightParams(byName["erp.expedicao.frete.contratar"]).required, ["id"]);
});
