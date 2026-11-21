// Banco do Brasil: API Cobranças v2. OAuth com Basic (Client ID e Secret) e a
// chave do desenvolvedor (gw-dev-app-key) em cada chamada; produção com
// certificado (mTLS). O nosso número é escolhido pelo Vinki:
// "000" + convênio (7) + sequência (10). Boleto híbrido com indicadorPix.
// Contrato público: developers.bb.com.br (API Cobranças v2). Conferir na
// homologação: docs/BOLETO-API.md.
import {
  BankError, barcodeOf, call, centsToReais, dotDate, isoDate, json, lineOf, need, oauthToken, object, personKind, reaisToCents, str,
  type BankContext, type BoletoAdapter, type BoletoRecord, type BoletoRef,
} from "../adapter.ts";

const NAME = "Banco do Brasil";
const sandbox = (ctx: BankContext) => ctx.environment === "sandbox";
const base = (ctx: BankContext) => sandbox(ctx) ? "https://api.hm.bb.com.br/cobrancas/v2" : "https://api.bb.com.br/cobrancas/v2";
const mtls = (ctx: BankContext) => !sandbox(ctx);
const key = (ctx: BankContext) => `gw-dev-app-key=${encodeURIComponent(need(ctx, "chave_desenvolvedor", "a chave do desenvolvedor do Banco do Brasil"))}`;
const basic = (id: string, secret: string) => btoa(`${id}:${secret}`);

async function headers(ctx: BankContext) {
  const token = await oauthToken(ctx, NAME, {
    url: sandbox(ctx) ? "https://oauth.hm.bb.com.br/oauth/token" : "https://oauth.bb.com.br/oauth/token", mtls: mtls(ctx),
    headers: { Authorization: `Basic ${basic(need(ctx, "client_id", "o Client ID"), need(ctx, "client_secret", "o Client Secret"))}` },
    values: { grant_type: "client_credentials", scope: "cobrancas.boletos-info cobrancas.boletos-requisicao" },
  });
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
}
const convenio = (ctx: BankContext) => need(ctx, "convenio", "o número do convênio");

/** Nosso número do Banco do Brasil (convênio de 7 dígitos): 20 dígitos. */
export const bbOurNumber = (convenio: string, sequence: number) => `000${convenio.padStart(7, "0")}${String(sequence).padStart(10, "0")}`;

/** O boleto do Banco do Brasil (resposta do registro ou da consulta). */
export function bbRecord(body: unknown, ref: BoletoRef): BoletoRecord {
  const b = object(body), qr = object(b.qrCode);
  // Estado do título: 6 liquidado; 7 baixado; 9 baixado (pago, se o banco informou o valor pago); o resto, em aberto.
  const state = Number(b.codigoEstadoTituloCobranca ?? 1);
  const paidCents = reaisToCents(b.valorPagoSacado);
  const paid = state === 6 || (state === 9 && !!paidCents && paidCents !== "0");
  const id = str(b.numero) ?? ref.bank_ref;
  return {
    bank_ref: id, our_number: id ?? ref.our_number, status: paid ? "pago" : state === 7 || state === 9 ? "baixado" : "registrado",
    barcode: barcodeOf(b.codigoBarraNumerico ?? b.textoCodigoBarrasTituloCobranca), digitable_line: lineOf(b.linhaDigitavel ?? b.codigoLinhaDigitavel),
    pix_code: str(qr.emv), pix_txid: str(qr.txId), due_on: isoDate(b.dataVencimentoTituloCobranca ?? b.dataVencimento),
    amount_cents: reaisToCents(b.valorOriginalTituloCobranca ?? b.valorOriginal),
    paid_cents: paid ? paidCents : null, paid_on: paid ? isoDate(b.dataRecebimentoTitulo ?? b.dataCreditoLiquidacao) : null,
    paid_via: paid ? (b.indicadorRecebimentoPix === "S" ? "pix" : "boleto") : null,
    receipt: paid ? [`nosso número ${id}`, str(b.codigoCanalPagamento) ? `canal ${b.codigoCanalPagamento}` : null].filter(Boolean).join(", ") : null,
  };
}

export const bb: BoletoAdapter = {
  bank: "bb",
  async check(ctx) { key(ctx); convenio(ctx); await headers(ctx); },
  async register(ctx, request) {
    if (!request.our_number) throw new BankError("configuracao", "Falta o nosso número do Banco do Brasil.");
    const payer = request.payer;
    const body = {
      numeroConvenio: Number(convenio(ctx)), numeroCarteira: Number(need(ctx, "carteira", "a carteira")), numeroVariacaoCarteira: Number(need(ctx, "variacao", "a variação da carteira")),
      codigoModalidade: 1, dataEmissao: dotDate(request.issued_on), dataVencimento: dotDate(request.due_on), valorOriginal: Number(centsToReais(request.amount_cents)),
      codigoAceite: "N", codigoTipoTitulo: 2, descricaoTipoTitulo: "DM", indicadorPermissaoRecebimentoParcial: "N",
      numeroTituloBeneficiario: request.seu_numero.slice(0, 15), numeroTituloCliente: request.our_number,
      mensagemBloquetoOcorrencia: request.instructions.join(" ").slice(0, 165),
      pagador: { tipoInscricao: personKind(payer.document) === "J" ? 2 : 1, numeroInscricao: Number(payer.document), nome: payer.name.slice(0, 60),
        endereco: [payer.street, payer.number].filter(Boolean).join(", ").slice(0, 60), cep: Number(payer.zip ?? 0), cidade: (payer.city ?? "").slice(0, 20),
        bairro: (payer.district ?? "").slice(0, 20), uf: payer.state ?? "" },
      indicadorPix: ctx.hybrid ? "S" : "N",
    };
    const response = await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/boletos?${key(ctx)}`, headers: await headers(ctx), body: json(body), mtls: mtls(ctx) }, "registrar o boleto", true);
    return bbRecord(response.body, { bank_ref: request.our_number, our_number: request.our_number });
  },
  async consult(ctx, ref) {
    const response = await call(ctx, NAME, { method: "GET", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.bank_ref)}?${key(ctx)}&numeroConvenio=${convenio(ctx)}`,
      headers: await headers(ctx), mtls: mtls(ctx) }, "consultar o boleto");
    return bbRecord({ numero: ref.bank_ref, ...object(response.body) }, ref);
  },
  async changeDue(ctx, ref, dueOn) {
    await call(ctx, NAME, { method: "PATCH", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.bank_ref)}?${key(ctx)}`, headers: await headers(ctx),
      body: json({ numeroConvenio: Number(convenio(ctx)), indicadorNovaDataVencimento: "S", alteracaoData: { novaDataVencimento: dotDate(dueOn) } }), mtls: mtls(ctx) }, "alterar o vencimento");
  },
  async cancel(ctx, ref) {
    await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.bank_ref)}/baixar?${key(ctx)}`, headers: await headers(ctx),
      body: json({ numeroConvenio: Number(convenio(ctx)) }), mtls: mtls(ctx) }, "baixar o boleto");
  },
};
