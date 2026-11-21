// Boleto pela API do banco (src/erp/boleto-api): os adaptadores do Banco
// Inter, Sicoob, Banco do Brasil e Itaú contra bancos simulados (nenhuma
// chamada sai daqui), as recusas em português, o aviso de pagamento, o
// contrato das operações e o PDF do boleto para todos os bancos.
import test from "node:test";
import assert from "node:assert/strict";
import { BOLETO_ADAPTERS } from "../../../src/erp/boleto-api/banks/index.ts";
import { BankError, reaisToCents, webhookRefs } from "../../../src/erp/boleto-api/adapter.ts";
import { bbOurNumber } from "../../../src/erp/boleto-api/banks/bb.ts";
import { itauAmount, itauBoletoId } from "../../../src/erp/boleto-api/banks/itau.ts";
import {
  BOLETO_BANK_INFO, ERP_BOLETO_OPERATIONS, ERP_BOLETO_MODULE_CONTRACT, bankByCode, erpBoletoOperationFor, erpBoletoParams,
} from "../../../src/erp/boleto-api/contract.ts";
import { barcodeDigit, boletoMissing, boletoPdf, digitableFromBarcode, formatDigitable } from "../../../src/erp/conversa/boleto.ts";

/** Código de barras válido do banco (moeda 9, fator 1000, valor e campo livre de 25 dígitos). */
function barcodeFor(bank, cents, free = "1".repeat(25)) {
  const head = `${bank}9`, tail = `1000${String(cents).padStart(10, "0")}${free}`;
  return `${head}${barcodeDigit(head + tail)}${tail}`;
}

/** Banco simulado: responde por regra (método + trecho do endereço) e guarda os pedidos. */
function simulated(rules) {
  const requests = [];
  const http = async request => {
    requests.push(request);
    for (const [method, part, reply] of rules) if (request.method === method && request.url.includes(part)) return typeof reply === "function" ? reply(request) : reply;
    return { status: 404, body: { message: "rota não simulada" } };
  };
  return { http, requests };
}
const token = { status: 200, body: { access_token: "tok-123", token_type: "Bearer", expires_in: 3600 } };
const ctx = (bank, http, fields, extra = {}) => ({ bank, http, environment: "producao", fields, hybrid: true, tokens: new Map(), ...extra });
const request = (extra = {}) => ({
  seu_numero: "1234567890", our_number: null, amount_cents: "12345", due_on: "2026-12-10", issued_on: "2026-11-21",
  payer: { name: "Ana Cliente", document: "12345678909", street: "Rua B", number: "20", district: "Centro", city: "Campinas", state: "SP", zip: "13010000" },
  instructions: ["Não receber após 60 dias do vencimento."], ...extra,
});

test("Banco Inter: OAuth com certificado, registro pelo código da solicitação e a linha pela consulta", async () => {
  const barcode = barcodeFor("077", 12345), line = digitableFromBarcode(barcode);
  const bank = simulated([
    ["POST", "/oauth/v2/token", token],
    ["POST", "/cobranca/v3/cobrancas", { status: 200, body: { codigoSolicitacao: "a1b2c3d4-0000-4000-8000-000000000001" } }],
    ["GET", "/cobranca/v3/cobrancas/a1b2c3d4", { status: 200, body: {
      cobranca: { codigoSolicitacao: "a1b2c3d4-0000-4000-8000-000000000001", situacao: "A_RECEBER", dataVencimento: "2026-12-10", valorNominal: "123.45" },
      boleto: { nossoNumero: "00012345678", codigoBarras: barcode, linhaDigitavel: formatDigitable(line) }, pix: { txid: "TX1", pixCopiaECola: "000201pix" } } }],
  ]);
  const record = await BOLETO_ADAPTERS.inter.register(ctx("inter", bank.http, { client_id: "id", client_secret: "segredo", conta_corrente: "123456" }), request());
  assert.deepEqual({ status: record.status, barcode: record.barcode, line: record.digitable_line, pix: record.pix_code, our: record.our_number, amount: record.amount_cents },
    { status: "registrado", barcode, line, pix: "000201pix", our: "00012345678", amount: "12345" });
  assert.ok(bank.requests.every(item => item.mtls), "o Inter exige certificado em todas as chamadas");
  const [auth, create] = bank.requests;
  assert.match(auth.body, /grant_type=client_credentials/);
  assert.match(auth.body, /scope=boleto-cobranca\.read%20boleto-cobranca\.write/);
  assert.equal(create.headers.Authorization, "Bearer tok-123");
  assert.equal(create.headers["x-conta-corrente"], "123456");
  const body = JSON.parse(create.body);
  assert.deepEqual({ seu: body.seuNumero, valor: body.valorNominal, venc: body.dataVencimento, doc: body.pagador.cpfCnpj, tipo: body.pagador.tipoPessoa, cep: body.pagador.cep },
    { seu: "1234567890", valor: 123.45, venc: "2026-12-10", doc: "12345678909", tipo: "FISICA", cep: "13010000" });
  // Homologação: o endereço do sandbox.
  const sandbox = simulated([["POST", "/oauth/v2/token", token], ["GET", "/cobranca/v3/cobrancas/x", { status: 200, body: { cobranca: { situacao: "A_RECEBER" } } }]]);
  await BOLETO_ADAPTERS.inter.consult(ctx("inter", sandbox.http, { client_id: "id", client_secret: "s" }, { environment: "sandbox" }), { bank_ref: "x", our_number: null });
  assert.ok(sandbox.requests.every(item => item.url.startsWith("https://cdpj-sandbox.partners.uatinter.co/")));
});

test("Banco Inter: recebido pelo Pix do boleto traz valor, data e o txid no comprovante", async () => {
  const bank = simulated([["POST", "/oauth/v2/token", token], ["GET", "/cobranca/v3/cobrancas/s1", { status: 200, body: {
    cobranca: { codigoSolicitacao: "s1", situacao: "RECEBIDO", valorTotalRecebido: "130.00", dataSituacao: "2026-12-09", origemRecebimento: "PIX" }, pix: { txid: "TX9" } } }]]);
  const record = await BOLETO_ADAPTERS.inter.consult(ctx("inter", bank.http, { client_id: "id", client_secret: "s" }), { bank_ref: "s1", our_number: null });
  assert.deepEqual({ status: record.status, paid: record.paid_cents, on: record.paid_on, via: record.paid_via }, { status: "pago", paid: "13000", on: "2026-12-09", via: "pix" });
  assert.match(record.receipt, /txid TX9/);
});

test("Sicoob: sandbox com o token do portal e sem certificado; produção com OAuth e certificado; boleto híbrido", async () => {
  const barcode = barcodeFor("756", 12345);
  const fields = { client_id: "cli", token_sandbox: "tok-sandbox", numero_cliente: "25546454", conta_corrente: "12345", modalidade: "1" };
  const sandbox = simulated([["POST", "/cobranca-bancaria/v3/boletos", { status: 200, body: { resultado: { nossoNumero: 2588658, codigoBarras: barcode, linhaDigitavel: digitableFromBarcode(barcode), qrCode: "000201sicoob" } } }]]);
  const record = await BOLETO_ADAPTERS.sicoob.register(ctx("sicoob", sandbox.http, fields, { environment: "sandbox" }), request());
  assert.equal(record.our_number, "2588658");
  assert.equal(record.pix_code, "000201sicoob");
  const [create] = sandbox.requests;
  assert.equal(create.mtls, false);
  assert.equal(create.headers.Authorization, "Bearer tok-sandbox");
  assert.equal(create.headers.client_id, "cli");
  assert.ok(create.url.startsWith("https://sandbox.sicoob.com.br/"));
  const body = JSON.parse(create.body);
  assert.deepEqual({ cliente: body.numeroCliente, conta: body.numeroContaCorrente, pix: body.codigoCadastrarPIX, valor: body.valor },
    { cliente: 25546454, conta: 12345, pix: 1, valor: 123.45 });

  const production = simulated([["POST", "auth.sicoob.com.br", token], ["GET", "/boletos?numeroCliente=25546454&codigoModalidade=1&nossoNumero=2588658",
    { status: 200, body: { resultado: { nossoNumero: 2588658, situacaoBoleto: "Liquidado", valor: 123.45, valorPago: 123.45, dataLiquidacao: "2026-12-10",
      listaHistorico: [{ dataHistorico: "2026-12-10", descricaoHistorico: "Liquidação do título" }] } } }]]);
  const paid = await BOLETO_ADAPTERS.sicoob.consult(ctx("sicoob", production.http, fields), { bank_ref: "2588658", our_number: "2588658" });
  assert.deepEqual({ status: paid.status, cents: paid.paid_cents, on: paid.paid_on }, { status: "pago", cents: "12345", on: "2026-12-10" });
  assert.ok(production.requests.every(item => item.mtls));
});

test("Banco do Brasil: nosso número do convênio, datas com ponto, chave do desenvolvedor e Basic no OAuth", async () => {
  const our = bbOurNumber("3128557", 7);
  assert.equal(our, "00031285570000000007");
  const barcode = barcodeFor("001", 12345);
  const bank = simulated([["POST", "oauth.hm.bb.com.br/oauth/token", token],
    ["POST", "/cobrancas/v2/boletos?gw-dev-app-key=chave", { status: 201, body: { numero: our, linhaDigitavel: digitableFromBarcode(barcode), codigoBarraNumerico: barcode,
      qrCode: { url: "https://qr", txId: "TXBB", emv: "000201bb" } } }]]);
  const fields = { client_id: "id", client_secret: "sec", chave_desenvolvedor: "chave", convenio: "3128557", carteira: "17", variacao: "35" };
  const record = await BOLETO_ADAPTERS.bb.register(ctx("bb", bank.http, fields, { environment: "sandbox" }), request({ our_number: our }));
  assert.deepEqual({ ref: record.bank_ref, barcode: record.barcode, pix: record.pix_code }, { ref: our, barcode, pix: "000201bb" });
  const [auth, create] = bank.requests;
  assert.equal(auth.headers.Authorization, `Basic ${btoa("id:sec")}`);
  assert.equal(auth.mtls, false, "homologação do BB sem certificado");
  const body = JSON.parse(create.body);
  assert.deepEqual({ conv: body.numeroConvenio, venc: body.dataVencimento, emissao: body.dataEmissao, titulo: body.numeroTituloCliente, pix: body.indicadorPix, tipo: body.pagador.tipoInscricao },
    { conv: 3128557, venc: "10.12.2026", emissao: "21.11.2026", titulo: our, pix: "S", tipo: 1 });
  // Consulta: estado 6 (liquidado) com o valor pago e a data de recebimento.
  const consult = simulated([["POST", "oauth.bb.com.br/oauth/token", token], ["GET", `/boletos/${our}?gw-dev-app-key=chave&numeroConvenio=3128557`,
    { status: 200, body: { codigoEstadoTituloCobranca: 6, valorPagoSacado: 123.45, dataRecebimentoTitulo: "10.12.2026" } }]]);
  const paid = await BOLETO_ADAPTERS.bb.consult(ctx("bb", consult.http, fields), { bank_ref: our, our_number: our });
  assert.deepEqual({ status: paid.status, cents: paid.paid_cents, on: paid.paid_on }, { status: "pago", cents: "12345", on: "2026-12-10" });
  assert.ok(consult.requests.every(item => item.mtls), "produção do BB com certificado");
  // Sem pagamento, estado 7: baixado.
  const closed = simulated([["POST", "/oauth/token", token], ["GET", "/boletos/", { status: 200, body: { codigoEstadoTituloCobranca: 7 } }]]);
  assert.equal((await BOLETO_ADAPTERS.bb.consult(ctx("bb", closed.http, fields), { bank_ref: our, our_number: our })).status, "baixado");
});

test("Itaú: valor com 17 dígitos, boleto com Pix, simulação no sandbox e o id do boleto", async () => {
  assert.equal(itauAmount("12345"), "00000000000012345");
  assert.equal(itauBoletoId("150000052061", "109", "00000007"), "15000005206110900000007");
  const barcode = barcodeFor("341", 12345);
  const bank = simulated([["POST", "/api/oauth/jwt", token], ["POST", "/boletos_pix", { status: 200, body: { data: {
    dado_boleto: { dados_individuais_boleto: [{ numero_nosso_numero: "00000007", codigo_barras: barcode, numero_linha_digitavel: digitableFromBarcode(barcode) }] },
    dados_qrcode: { emv: "000201itau", txid: "TXI" } } } }]]);
  const fields = { client_id: "id", client_secret: "sec", beneficiario: "150000052061", carteira: "109" };
  const record = await BOLETO_ADAPTERS.itau.register(ctx("itau", bank.http, fields, { environment: "sandbox" }), request({ our_number: "00000007" }));
  assert.deepEqual({ ref: record.bank_ref, our: record.our_number, pix: record.pix_code, barcode: record.barcode },
    { ref: "15000005206110900000007", our: "00000007", pix: "000201itau", barcode });
  const create = bank.requests[1];
  assert.ok(create.mtls);
  assert.equal(create.headers["x-itau-apikey"], "id");
  const body = JSON.parse(create.body);
  assert.equal(body.etapa_processo_boleto, "simulacao");
  assert.equal(body.dado_boleto.valor_total_titulo, "00000000000012345");
  assert.equal(body.dado_boleto.pagador.pessoa.tipo_pessoa.numero_cadastro_pessoa_fisica, "12345678909");
  // Sem o boleto híbrido: o endereço dos boletos comuns e "efetivacao" em produção.
  const plain = simulated([["POST", "sts.itau.com.br", token], ["POST", "/cash_management/v2/boletos", { status: 200, body: { data: {} } }]]);
  await BOLETO_ADAPTERS.itau.register(ctx("itau", plain.http, fields, { hybrid: false }), request({ our_number: "00000008" }));
  assert.equal(JSON.parse(plain.requests[1].body).etapa_processo_boleto, "efetivacao");
  // Consulta: paga, com o valor do pagamento.
  const consult = simulated([["POST", "sts.itau.com.br", token], ["GET", "boletoscash/v2/boletos?id_beneficiario=150000052061&codigo_carteira=109&nosso_numero=00000007",
    { status: 200, body: { data: [{ dado_boleto: { dados_individuais_boleto: [{ numero_nosso_numero: "00000007", situacao_geral_boleto: "Paga" }],
      pagamentos_cobranca: [{ valor_pago_total_cobranca: "00000000000012345", data_inclusao_pagamento: "2026-12-10" }] } }] } }]]);
  const paid = await BOLETO_ADAPTERS.itau.consult(ctx("itau", consult.http, fields), { bank_ref: "15000005206110900000007", our_number: "00000007" });
  assert.deepEqual({ status: paid.status, cents: paid.paid_cents, on: paid.paid_on }, { status: "pago", cents: "12345", on: "2026-12-10" });
});

test("alterar vencimento e baixar: cada banco no próprio endereço", async () => {
  const fields = { client_id: "id", client_secret: "sec", chave_desenvolvedor: "k", convenio: "3128557", carteira: "109", variacao: "35",
    beneficiario: "150000052061", numero_cliente: "1", conta_corrente: "2", token_sandbox: "t" };
  const expected = {
    inter: [["PATCH", "/cobranca/v3/cobrancas/R1"], ["POST", "/cobranca/v3/cobrancas/R1/cancelar"]],
    sicoob: [["PATCH", "/boletos/N1"], ["POST", "/boletos/N1/baixar"]],
    bb: [["PATCH", "/boletos/R1?"], ["POST", "/boletos/R1/baixar?"]],
    itau: [["PATCH", "/boletos/R1/data_vencimento"], ["PATCH", "/boletos/R1/baixa"]],
  };
  for (const [id, [due, cancel]] of Object.entries(expected)) {
    const bank = simulated([["POST", "token", token], ["POST", "/oauth/jwt", token], ["PATCH", "/", { status: 200, body: {} }], ["POST", "/", { status: 200, body: {} }]]);
    const c = ctx(id, bank.http, fields);
    await BOLETO_ADAPTERS[id].changeDue(c, { bank_ref: "R1", our_number: "N1" }, "2026-12-20");
    await BOLETO_ADAPTERS[id].cancel(c, { bank_ref: "R1", our_number: "N1" }, "cliente pagou em dinheiro");
    const calls = bank.requests.filter(item => !/token|jwt/.test(item.url));
    assert.equal(calls[0].method, due[0], id);
    assert.ok(calls[0].url.includes(due[1]), `${id}: ${calls[0].url}`);
    assert.ok(JSON.stringify(calls[0].body).includes(id === "bb" ? "20.12.2026" : "2026-12-20"), id);
    assert.equal(calls[1].method, cancel[0], id);
    assert.ok(calls[1].url.includes(cancel[1]), `${id}: ${calls[1].url}`);
  }
});

test("recusas do banco em português, sem segredo nem número longo", async () => {
  const fields = { client_id: "id", client_secret: "segredo-que-nao-pode-vazar" };
  const refused = simulated([["POST", "/oauth/v2/token", token], ["POST", "/cobranca/v3/cobrancas", { status: 400, body: { title: "Requisição inválida", violacoes: [{ razao: "CPF 12345678909 inválido" }] } }]]);
  await assert.rejects(BOLETO_ADAPTERS.inter.register(ctx("inter", refused.http, fields), request()), error => {
    assert.ok(error instanceof BankError);
    assert.equal(error.kind, "recusado");
    assert.match(error.message, /Banco Inter recusou registrar o boleto/);
    assert.doesNotMatch(error.message, /12345678909|segredo/);
    return true;
  });
  const denied = simulated([["POST", "/oauth/v2/token", { status: 401, body: { error_description: "invalid client" } }]]);
  await assert.rejects(BOLETO_ADAPTERS.inter.consult(ctx("inter", denied.http, fields), { bank_ref: "x", our_number: null }), { kind: "credencial" });
  const down = simulated([["POST", "/oauth/v2/token", token], ["GET", "/cobranca", { status: 503, body: null }]]);
  await assert.rejects(BOLETO_ADAPTERS.inter.consult(ctx("inter", down.http, fields), { bank_ref: "x", our_number: null }), { kind: "indisponivel" });
  // Sem resposta no registro: "incerto" (pode ter chegado); na consulta, só indisponível.
  let first = true;
  const lost = async req => { if (req.url.includes("/oauth/")) return token; if (first) { first = false; throw new TypeError("network"); } return token; };
  await assert.rejects(BOLETO_ADAPTERS.inter.register(ctx("inter", lost, fields), request()), { kind: "incerto" });
  // Falta de campo: diz qual, antes de chamar o banco.
  await assert.rejects(BOLETO_ADAPTERS.bb.register(ctx("bb", simulated([]).http, { client_id: "a", client_secret: "b" }), request({ our_number: "1" })),
    error => error.kind === "configuracao" && /Falta o número do convênio/.test(error.message));
  await assert.rejects(BOLETO_ADAPTERS.bb.check(ctx("bb", simulated([]).http, { client_id: "a", client_secret: "b" })),
    error => error.kind === "configuracao" && /chave do desenvolvedor/.test(error.message));
});

test("aviso de pagamento: só as referências dos campos conhecidos, sem repetir", () => {
  assert.deepEqual(webhookRefs([{ codigoSolicitacao: "abc-1", situacao: "RECEBIDO", valorTotalRecebido: "10.00" }, { codigoSolicitacao: "abc-1" }]), ["abc-1"]);
  assert.deepEqual(webhookRefs({ data: [{ id: "00031285570000000007", numeroConvenio: 3128557 }] }).sort(), ["00031285570000000007"]);
  assert.deepEqual(webhookRefs({ evento: { id_boleto: "15000005206110900000007", nosso_numero: "00000007" } }).sort(), ["00000007", "15000005206110900000007"]);
  assert.deepEqual(webhookRefs({ codigoSolicitacao: "'; DROP TABLE x; --" }), []);
  assert.deepEqual(webhookRefs("texto"), []);
  assert.equal(reaisToCents("10.5"), "1050");
  assert.equal(reaisToCents(0.1), "10");
  assert.equal(reaisToCents("abc"), null);
});

test("contrato: consultar é leitura; registrar, alterar, baixar e confirmar são sensíveis; configuração só pela tela", () => {
  const byName = Object.fromEntries(ERP_BOLETO_OPERATIONS.map(op => [op.name, op]));
  assert.equal(byName["erp.boleto.ver"].sensitive, false);
  assert.equal(byName["erp.boleto.consultar_banco"].method, "GET");
  assert.equal(byName["erp.boleto.consultar_banco"].sensitive, false);
  for (const name of ["erp.boleto.registrar", "erp.boleto.vencimento", "erp.boleto.baixar", "erp.boleto.confirmar_baixa"]) {
    assert.equal(byName[name].sensitive, true, name);
    assert.equal(byName[name].method, "POST", name);
    assert.ok(ERP_BOLETO_MODULE_CONTRACT.definition.bot.sensitive.includes(name), name);
  }
  for (const name of ["erp.boleto.bancos", "erp.boleto.bancos.salvar", "erp.boleto.conta_financeira", "erp.boleto.conta_financeira.salvar", "erp.boleto.pdf"])
    assert.equal(byName[name].bot, false, name);
  assert.deepEqual(ERP_BOLETO_MODULE_CONTRACT.routes, ["erp-boleto"]);
  assert.equal(erpBoletoOperationFor("POST", "erp-boleto/conta/abc/registrar").operation.name, "erp.boleto.registrar");
  assert.deepEqual(erpBoletoOperationFor("POST", "erp-boleto/contas-financeiras/xyz").params, { conta: "xyz" });
  assert.equal(erpBoletoOperationFor("GET", "erp-boleto/conta/abc/registrar"), null);
  assert.deepEqual(erpBoletoParams(byName["erp.boleto.vencimento"]).required, ["id", "vencimento"]);
  assert.equal(bankByCode("77"), "inter");
  assert.equal(bankByCode("756"), "sicoob");
  assert.equal(bankByCode("001"), "bb");
  assert.equal(bankByCode("341"), "itau");
  assert.equal(bankByCode("237"), null);
  // Segredos marcados: vão para o cofre, nunca voltam.
  for (const info of Object.values(BOLETO_BANK_INFO)) {
    for (const key of ["client_secret", "certificado", "chave_privada", "chave_desenvolvedor", "token_sandbox"]) {
      const field = info.fields.find(item => item.key === key);
      if (field) assert.equal(field.secret, true, `${info.id}.${key}`);
    }
  }
});

test("PDF do boleto para os quatro bancos: código de barras desenhado, Pix do híbrido e marca de homologação", () => {
  for (const code of ["077", "756", "001", "341"]) {
    const barcode = barcodeFor(code, 12345);
    const data = {
      bank: code, barcode, digitable_line: digitableFromBarcode(barcode), amount_cents: "12345", due_on: "2026-12-10", our_number: "00000007",
      document_number: "1234567890", issued_on: "2026-11-21",
      beneficiary: { name: "Oficina Exemplo Ltda", document: "CNPJ 11.222.333/0001-81", address: "Rua A, 10 - Centro - São Paulo/SP" },
      payer: { name: "Ana Cliente", document: "CPF 12345678909", address: "Rua B, 20 - Centro - Campinas/SP - CEP 13010-000" },
      instructions: ["Não receber após 60 dias do vencimento."], agency_code: "0001 / 12345-6", wallet: "17", pix_code: "00020126580014br.gov.bcb.pix0136pix-do-boleto", sandbox: true,
    };
    assert.deepEqual(boletoMissing(data), [], code);
    const text = new TextDecoder("latin1").decode(boletoPdf(data));
    assert.ok(text.startsWith("%PDF-1.4"), code);
    assert.ok(text.includes(formatDigitable(digitableFromBarcode(barcode))), code);
    assert.ok(text.includes("0001 / 12345-6"), code);
    assert.ok(text.includes("Pix copia e cola"), code);
    assert.match(text, /HOMOLOGA/, code);
  }
  // Sem a linha do banco, o PDF diz o que falta.
  assert.ok(boletoMissing({ bank: "077", barcode: "", digitable_line: "", amount_cents: "100", due_on: "2026-12-10", our_number: "1",
    document_number: null, issued_on: null, beneficiary: { name: "A", document: "B", address: null }, payer: { name: "C", document: "D", address: null }, instructions: [] })
    .includes("o código de barras do boleto"));
});
