// Itaú: API de Boletos (cash management v2) e boleto com Pix
// (boletos_pix). OAuth client_credentials com certificado (mTLS) em todas as
// chamadas; no sandbox do portal o registro roda como "simulacao". O nosso
// número (8 dígitos) é escolhido pelo Wabotia; o id do boleto é
// beneficiário (12) + carteira (3) + nosso número (8).
// Contrato público: devportal.itau.com.br (Boletos, Boleto com Pix). Conferir
// na homologação: docs/BOLETO-API.md.
import {
  BankError, barcodeOf, call, isoDate, json, lineOf, list, need, oauthToken, object, onlyDigits, personKind, str,
  type BankContext, type BoletoAdapter, type BoletoRecord, type BoletoRef,
} from "../adapter.ts";

const NAME = "Itaú";
const sandbox = (ctx: BankContext) => ctx.environment === "sandbox";
const SANDBOX = "https://sandbox.devportal.itau.com.br/itau-ep9-gtw-cash-management-ext-v2/v2";
const base = (ctx: BankContext) => sandbox(ctx) ? SANDBOX : "https://api.itau.com.br/cash_management/v2";
const pixBase = (ctx: BankContext) => sandbox(ctx) ? SANDBOX : "https://secure.api.itau/pix_recebimentos_conciliacoes/v2";
const consultBase = (ctx: BankContext) => sandbox(ctx) ? SANDBOX : "https://secure.api.cloud.itau.com.br/boletoscash/v2";
/** Valor com 17 dígitos (15 inteiros e 2 decimais), como a API pede. */
export const itauAmount = (cents: string) => cents.padStart(17, "0");
const beneficiary = (ctx: BankContext) => need(ctx, "beneficiario", "o id do beneficiário no Itaú");
const wallet = (ctx: BankContext) => need(ctx, "carteira", "a carteira");
export const itauBoletoId = (beneficiaryId: string, walletCode: string, ourNumber: string) => `${beneficiaryId}${walletCode}${ourNumber.slice(0, 8)}`;

async function headers(ctx: BankContext) {
  const clientId = need(ctx, "client_id", "o Client ID");
  const token = await oauthToken(ctx, NAME, {
    url: sandbox(ctx) ? "https://sandbox.devportal.itau.com.br/api/oauth/jwt" : "https://sts.itau.com.br/api/oauth/token", mtls: true,
    values: { grant_type: "client_credentials", client_id: clientId, client_secret: need(ctx, "client_secret", "o Client Secret") },
  });
  return { Authorization: `Bearer ${token}`, "x-itau-apikey": clientId, "x-itau-correlationID": crypto.randomUUID(), "x-itau-flowID": crypto.randomUUID(),
    "Content-Type": "application/json", Accept: "application/json" };
}

/** Itaú usa centavos com 17 dígitos ou reais com ponto, conforme o campo. */
const amountOf = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  if (/^\d{10,17}$/.test(text)) return String(BigInt(text));
  if (/^\d+(\.\d{1,2})?$/.test(text)) { const [int, frac = ""] = text.split("."); return String(BigInt(int!) * 100n + BigInt((frac + "00").slice(0, 2))); }
  return null;
};

/** O boleto do Itaú (resposta do registro, data.dado_boleto, ou da consulta, data[0].dado_boleto). */
export function itauRecord(body: unknown, ref: BoletoRef): BoletoRecord {
  const data = object(object(body).data ?? body);
  const first = object(Array.isArray(object(body).data) ? object(body).data[0] : data);
  const boleto = object(first.dado_boleto), item = object(list(boleto.dados_individuais_boleto)[0]), qr = object(first.dados_qrcode ?? data.dados_qrcode);
  const situation = String(item.situacao_geral_boleto ?? "").toLowerCase();
  const payments = list(boleto.pagamentos_cobranca).map(object);
  const paid = situation.startsWith("paga") || situation.startsWith("liquidad");
  const payment = payments.at(-1);
  const ourNumber = onlyDigits(item.numero_nosso_numero) ?? ref.our_number;
  return {
    bank_ref: ref.bank_ref || ourNumber || "", our_number: ourNumber,
    status: paid ? "pago" : situation.startsWith("baixad") ? "baixado" : "registrado",
    barcode: barcodeOf(item.codigo_barras), digitable_line: lineOf(item.numero_linha_digitavel),
    pix_code: str(qr.emv ?? qr.pix_copia_e_cola), pix_txid: str(qr.txid), due_on: isoDate(item.data_vencimento),
    amount_cents: amountOf(item.valor_titulo ?? boleto.valor_total_titulo),
    paid_cents: paid ? amountOf(payment?.valor_pago_total_cobranca ?? item.valor_pago) : null,
    paid_on: paid ? isoDate(payment?.data_inclusao_pagamento ?? item.data_pagamento) : null,
    paid_via: paid ? (/pix/i.test(String(payment?.descricao_meio_pagamento ?? payment?.codigo_tipo_pagamento ?? "")) ? "pix" : "boleto") : null,
    receipt: paid ? [ourNumber ? `nosso número ${ourNumber}` : null, str(payment?.codigo_instituicao_financeira_pagamento) ? `banco pagador ${payment!.codigo_instituicao_financeira_pagamento}` : null].filter(Boolean).join(", ") || null : null,
  };
}

export const itau: BoletoAdapter = {
  bank: "itau",
  async check(ctx) { beneficiary(ctx); wallet(ctx); await headers(ctx); },
  async register(ctx, request) {
    if (!request.our_number) throw new BankError("configuracao", "Falta o nosso número do Itaú.");
    const payer = request.payer, kind = personKind(payer.document);
    const body = {
      etapa_processo_boleto: sandbox(ctx) ? "simulacao" : "efetivacao",
      beneficiario: { id_beneficiario: beneficiary(ctx) },
      dado_boleto: {
        descricao_instrumento_cobranca: "boleto", tipo_boleto: "a vista", codigo_carteira: wallet(ctx), valor_total_titulo: itauAmount(request.amount_cents),
        codigo_especie: "01", data_emissao: request.issued_on,
        pagador: {
          pessoa: { nome_pessoa: payer.name.slice(0, 50), tipo_pessoa: kind === "J"
            ? { codigo_tipo_pessoa: "J", numero_cadastro_nacional_pessoa_juridica: payer.document }
            : { codigo_tipo_pessoa: "F", numero_cadastro_pessoa_fisica: payer.document } },
          endereco: { nome_logradouro: [payer.street, payer.number].filter(Boolean).join(", ").slice(0, 45), nome_bairro: (payer.district ?? "").slice(0, 15),
            nome_cidade: (payer.city ?? "").slice(0, 20), sigla_UF: payer.state ?? "", numero_CEP: payer.zip ?? "" },
        },
        dados_individuais_boleto: [{ numero_nosso_numero: request.our_number, data_vencimento: request.due_on, valor_titulo: itauAmount(request.amount_cents),
          texto_seu_numero: request.seu_numero.slice(0, 10) }],
        lista_mensagem_cobranca: request.instructions.slice(0, 4).map(text => ({ mensagem: text.slice(0, 100) })),
      },
    };
    const url = ctx.hybrid ? `${pixBase(ctx)}/boletos_pix` : `${base(ctx)}/boletos`;
    const response = await call(ctx, NAME, { method: "POST", url, headers: await headers(ctx), body: json(body), mtls: true }, "registrar o boleto", true);
    const id = itauBoletoId(beneficiary(ctx), wallet(ctx), request.our_number);
    return itauRecord(response.body, { bank_ref: id, our_number: request.our_number });
  },
  async consult(ctx, ref) {
    const query = `id_beneficiario=${beneficiary(ctx)}&codigo_carteira=${wallet(ctx)}&nosso_numero=${encodeURIComponent(ref.our_number ?? ref.bank_ref.slice(-8))}`;
    const response = await call(ctx, NAME, { method: "GET", url: `${consultBase(ctx)}/boletos?${query}`, headers: await headers(ctx), mtls: true }, "consultar o boleto");
    // O id do boleto (beneficiário + carteira + nosso número), também quando só o nosso número era conhecido.
    const ourNumber = ref.our_number ?? ref.bank_ref.slice(-8);
    return itauRecord(response.body, { bank_ref: itauBoletoId(beneficiary(ctx), wallet(ctx), ourNumber), our_number: ourNumber });
  },
  async changeDue(ctx, ref, dueOn) {
    await call(ctx, NAME, { method: "PATCH", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.bank_ref)}/data_vencimento`, headers: await headers(ctx),
      body: json({ data_vencimento: dueOn }), mtls: true }, "alterar o vencimento");
  },
  async cancel(ctx, ref) {
    await call(ctx, NAME, { method: "PATCH", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.bank_ref)}/baixa`, headers: await headers(ctx), body: json({}), mtls: true }, "baixar o boleto");
  },
};
