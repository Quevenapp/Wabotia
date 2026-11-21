// Banco Inter: API Cobrança v3 (boleto com Pix). Certificado (mTLS) em todas
// as chamadas, também no sandbox. O registro devolve só o código da
// solicitação; linha digitável, código de barras e Pix vêm da consulta.
// Contrato público: developers.inter.co (Cobrança v3). Conferir na
// homologação: docs/BOLETO-API.md.
import {
  BankError, call, centsToReais, isoDate, json, lineOf, barcodeOf, need, oauthToken, object, reaisToCents, str,
  type BankContext, type BoletoAdapter, type BoletoRecord, type BoletoRef,
} from "../adapter.ts";

const NAME = "Banco Inter";
const base = (ctx: BankContext) => ctx.environment === "sandbox" ? "https://cdpj-sandbox.partners.uatinter.co" : "https://cdpj.partners.bancointer.com.br";

async function headers(ctx: BankContext) {
  const token = await oauthToken(ctx, NAME, {
    url: `${base(ctx)}/oauth/v2/token`, mtls: true,
    values: { client_id: need(ctx, "client_id", "o Client ID"), client_secret: need(ctx, "client_secret", "o Client Secret"), grant_type: "client_credentials",
      scope: "boleto-cobranca.read boleto-cobranca.write" },
  });
  const account = ctx.fields.conta_corrente?.trim();
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...(account ? { "x-conta-corrente": account } : {}) };
}

/** A resposta da consulta (GET /cobranca/v3/cobrancas/{codigoSolicitacao}). */
export function interRecord(body: unknown, ref: BoletoRef): BoletoRecord {
  const b = object(body), charge = object(b.cobranca), boleto = object(b.boleto), pix = object(b.pix);
  const situation = String(charge.situacao ?? "").toUpperCase();
  const paid = situation === "RECEBIDO" || situation === "MARCADO_RECEBIDO";
  const closed = situation === "CANCELADO" || situation === "EXPIRADO" || situation === "FALHA_EMISSAO";
  return {
    bank_ref: str(charge.codigoSolicitacao) ?? ref.bank_ref, our_number: str(boleto.nossoNumero) ?? ref.our_number,
    status: paid ? "pago" : closed ? "baixado" : "registrado",
    barcode: barcodeOf(boleto.codigoBarras), digitable_line: lineOf(boleto.linhaDigitavel),
    pix_code: str(pix.pixCopiaECola), pix_txid: str(pix.txid),
    due_on: isoDate(charge.dataVencimento), amount_cents: reaisToCents(charge.valorNominal),
    paid_cents: paid ? reaisToCents(charge.valorTotalRecebido) : null, paid_on: paid ? isoDate(charge.dataSituacao) : null,
    paid_via: paid ? (String(charge.origemRecebimento ?? "").toUpperCase() === "PIX" ? "pix" : "boleto") : null,
    receipt: paid ? [str(charge.codigoSolicitacao), str(pix.txid) && String(charge.origemRecebimento ?? "").toUpperCase() === "PIX" ? `txid ${pix.txid}` : null].filter(Boolean).join(", ") || null : null,
  };
}

export const inter: BoletoAdapter = {
  bank: "inter",
  async check(ctx) { await headers(ctx); },
  async register(ctx, request) {
    const payer = request.payer;
    const body = {
      seuNumero: request.seu_numero.slice(0, 15), valorNominal: Number(centsToReais(request.amount_cents)), dataVencimento: request.due_on, numDiasAgenda: 60,
      pagador: { cpfCnpj: payer.document, tipoPessoa: payer.document.length === 14 ? "JURIDICA" : "FISICA", nome: payer.name.slice(0, 100),
        endereco: (payer.street ?? "").slice(0, 100), numero: (payer.number ?? "").slice(0, 10), bairro: (payer.district ?? "").slice(0, 60),
        cidade: (payer.city ?? "").slice(0, 60), uf: payer.state ?? "", cep: payer.zip ?? "" },
      mensagem: Object.fromEntries(request.instructions.slice(0, 5).map((text, index) => [`linha${index + 1}`, text.slice(0, 78)])),
    };
    const created = await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/cobranca/v3/cobrancas`, headers: await headers(ctx), body: json(body), mtls: true }, "registrar o boleto", true);
    const id = str(object(created.body).codigoSolicitacao);
    if (!id) throw new BankError("incerto", "O Banco Inter aceitou o pedido mas não devolveu o código da solicitação. Confira no aplicativo do banco antes de registrar de novo.");
    try { return await inter.consult(ctx, { bank_ref: id, our_number: null }); }
    catch {
      // Registrado; a linha digitável chega na próxima consulta.
      return { bank_ref: id, our_number: null, status: "registrado", barcode: null, digitable_line: null, pix_code: null, pix_txid: null,
        due_on: request.due_on, amount_cents: request.amount_cents, paid_cents: null, paid_on: null, paid_via: null, receipt: null };
    }
  },
  async consult(ctx, ref) {
    const response = await call(ctx, NAME, { method: "GET", url: `${base(ctx)}/cobranca/v3/cobrancas/${encodeURIComponent(ref.bank_ref)}`, headers: await headers(ctx), mtls: true }, "consultar o boleto");
    return interRecord(response.body, ref);
  },
  async changeDue(ctx, ref, dueOn) {
    await call(ctx, NAME, { method: "PATCH", url: `${base(ctx)}/cobranca/v3/cobrancas/${encodeURIComponent(ref.bank_ref)}`, headers: await headers(ctx),
      body: json({ dataVencimento: dueOn }), mtls: true }, "alterar o vencimento");
  },
  async cancel(ctx, ref, reason) {
    await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/cobranca/v3/cobrancas/${encodeURIComponent(ref.bank_ref)}/cancelar`, headers: await headers(ctx),
      body: json({ motivoCancelamento: reason.slice(0, 50) }), mtls: true }, "baixar o boleto");
  },
  async registerWebhook(ctx, url) {
    await call(ctx, NAME, { method: "PUT", url: `${base(ctx)}/cobranca/v3/cobrancas/webhook`, headers: await headers(ctx), body: json({ webhookUrl: url }), mtls: true }, "cadastrar o aviso de pagamento");
  },
};
