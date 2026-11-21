// Sicoob: API Cobrança Bancária v3. Produção com certificado (mTLS) e OAuth
// pelo Client ID; o sandbox usa um token fixo do portal, sem certificado. O
// nosso número é gerado pelo banco. Sem webhook de liquidação nesta API: o
// pagamento chega pela consulta periódica.
// Contrato público: developers.sicoob.com.br (Cobrança Bancária v3). Conferir
// na homologação: docs/BOLETO-API.md.
import {
  BankError, barcodeOf, call, centsToReais, isoDate, json, lineOf, list, need, oauthToken, object, reaisToCents, str,
  type BankContext, type BoletoAdapter, type BoletoRecord, type BoletoRef,
} from "../adapter.ts";

const NAME = "Sicoob";
const base = (ctx: BankContext) => ctx.environment === "sandbox"
  ? "https://sandbox.sicoob.com.br/sicoob/sandbox/cobranca-bancaria/v3" : "https://api.sicoob.com.br/cobranca-bancaria/v3";
const mtls = (ctx: BankContext) => ctx.environment === "producao";

async function headers(ctx: BankContext) {
  const clientId = need(ctx, "client_id", "o Client ID");
  const token = ctx.environment === "sandbox" ? need(ctx, "token_sandbox", "o token do sandbox do Sicoob")
    : await oauthToken(ctx, NAME, {
      url: "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token", mtls: true,
      values: { grant_type: "client_credentials", client_id: clientId, scope: "boletos_inclusao boletos_consulta boletos_alteracao" },
    });
  return { Authorization: `Bearer ${token}`, client_id: clientId, "Content-Type": "application/json", Accept: "application/json" };
}
const client = (ctx: BankContext) => ({ numeroCliente: Number(need(ctx, "numero_cliente", "o número do cliente no Sicoob")), codigoModalidade: Number(ctx.fields.modalidade || 1) });

/** O boleto do Sicoob (resultado do registro ou da consulta). */
export function sicoobRecord(body: unknown, ref: BoletoRef): BoletoRecord {
  const raw = object(body).resultado;
  const result = object(Array.isArray(raw) ? raw[0] : raw);
  const situation = String(result.situacaoBoleto ?? "").toLowerCase();
  const paid = situation.startsWith("liquidado");
  const history = list(result.listaHistorico).map(object);
  const settlement = history.find(item => /liquida/i.test(String(item.descricaoHistorico ?? item.tipoHistorico ?? "")));
  return {
    bank_ref: str(result.nossoNumero) ?? ref.bank_ref, our_number: str(result.nossoNumero) ?? ref.our_number,
    status: paid ? "pago" : situation.startsWith("baixado") ? "baixado" : "registrado",
    barcode: barcodeOf(result.codigoBarras), digitable_line: lineOf(result.linhaDigitavel), pix_code: str(result.qrCode), pix_txid: str(result.txid),
    due_on: isoDate(result.dataVencimento), amount_cents: reaisToCents(result.valor),
    paid_cents: paid ? reaisToCents(result.valorPago ?? result.valorLiquidado ?? result.valorRecebido) : null,
    paid_on: paid ? isoDate(result.dataLiquidacao ?? settlement?.dataHistorico) : null,
    paid_via: paid ? (/pix/i.test(String(settlement?.descricaoHistorico ?? "")) ? "pix" : "boleto") : null,
    receipt: paid ? [str(result.nossoNumero) ? `nosso número ${result.nossoNumero}` : null, str(settlement?.descricaoHistorico)].filter(Boolean).join(", ").slice(0, 160) || null : null,
  };
}

export const sicoob: BoletoAdapter = {
  bank: "sicoob",
  async check(ctx) { await headers(ctx); client(ctx); need(ctx, "conta_corrente", "a conta corrente no Sicoob"); },
  async register(ctx, request) {
    const payer = request.payer;
    const body = {
      ...client(ctx), numeroContaCorrente: Number(need(ctx, "conta_corrente", "a conta corrente no Sicoob")), codigoEspecieDocumento: "DM",
      dataEmissao: request.issued_on, seuNumero: request.seu_numero.slice(0, 18), identificacaoBoletoEmpresa: request.seu_numero.slice(0, 25),
      identificacaoEmissaoBoleto: 2, identificacaoDistribuicaoBoleto: 2, valor: Number(centsToReais(request.amount_cents)), dataVencimento: request.due_on,
      tipoDesconto: 0, tipoMulta: 0, tipoJurosMora: 3, numeroParcela: 1, aceite: false,
      pagador: { numeroCpfCnpj: payer.document, nome: payer.name.slice(0, 50), endereco: [payer.street, payer.number].filter(Boolean).join(", ").slice(0, 40),
        bairro: (payer.district ?? "").slice(0, 30), cidade: (payer.city ?? "").slice(0, 40), cep: payer.zip ?? "", uf: payer.state ?? "" },
      mensagensInstrucao: request.instructions.slice(0, 5).map(text => text.slice(0, 40)),
      gerarPdf: false, codigoCadastrarPIX: ctx.hybrid ? 1 : 0,
    };
    const response = await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/boletos`, headers: await headers(ctx), body: json(body), mtls: mtls(ctx) }, "registrar o boleto", true);
    const record = sicoobRecord(response.body, { bank_ref: "", our_number: null });
    if (!record.bank_ref) throw new BankError("incerto", "O Sicoob aceitou o pedido mas não devolveu o nosso número. Confira no aplicativo do banco antes de registrar de novo.");
    return record;
  },
  async consult(ctx, ref) {
    const c = client(ctx);
    const query = `numeroCliente=${c.numeroCliente}&codigoModalidade=${c.codigoModalidade}&nossoNumero=${encodeURIComponent(ref.our_number ?? ref.bank_ref)}`;
    const response = await call(ctx, NAME, { method: "GET", url: `${base(ctx)}/boletos?${query}`, headers: await headers(ctx), mtls: mtls(ctx) }, "consultar o boleto");
    return sicoobRecord(response.body, ref);
  },
  async changeDue(ctx, ref, dueOn) {
    await call(ctx, NAME, { method: "PATCH", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.our_number ?? ref.bank_ref)}`, headers: await headers(ctx),
      body: json({ ...client(ctx), prorrogacaoVencimento: { dataVencimento: dueOn } }), mtls: mtls(ctx) }, "alterar o vencimento");
  },
  async cancel(ctx, ref) {
    await call(ctx, NAME, { method: "POST", url: `${base(ctx)}/boletos/${encodeURIComponent(ref.our_number ?? ref.bank_ref)}/baixar`, headers: await headers(ctx),
      body: json(client(ctx)), mtls: mtls(ctx) }, "baixar o boleto");
  },
};
