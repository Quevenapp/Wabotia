// Mercado Pago Point pela API de integração de pagamentos (Point Integration
// API). Campos conforme a documentação pública do Mercado Pago; nenhuma
// chamada real foi feita: os testes usam o provedor simulado.
// - Terminais: GET /point/integration-api/devices (devices[].id e
//   operating_mode); a cobrança pela nuvem pede o modo PDV, ligado com
//   PATCH /point/integration-api/devices/{id} {"operating_mode":"PDV"}.
// - Cobrança: POST /point/integration-api/devices/{id}/payment-intents com
//   amount em centavos, payment.type (debit_card ou credit_card),
//   payment.installments e installments_cost (seller ou buyer) e
//   additional_info.external_reference; volta o id da intenção.
// - Consulta: GET /point/integration-api/payment-intents/{id} (state OPEN,
//   ON_TERMINAL, PROCESSING, PROCESSED, FINISHED, CANCELED, ABANDONED ou
//   ERROR e payment.id); o resultado do cartão sai de GET /v1/payments/{id}
//   (status, status_detail, payment_method_id, installments,
//   authorization_code, card.last_four_digits, fee_details).
// - Achar depois de resposta incerta: GET
//   /point/integration-api/payment-intents/events?startDate&endDate e a
//   consulta de cada intenção, comparando a referência externa e o terminal.
// - Cancelar: DELETE /point/integration-api/devices/{id}/payment-intents/{intent}
//   (só enquanto a cobrança não está na tela da maquininha).
// - Aviso: x-signature "ts=…,v1=…" com x-request-id e o data.id da consulta,
//   como o da Cobrança (src/payments-mercadopago.ts); o corpo nunca basta.
import {
  TerminalError, brandOf, reaisToCents, shortReason,
  type TerminalCharge, type TerminalChargeState, type TerminalContext, type TerminalDevice, type TerminalHttpRequest, type TerminalProvider,
} from "../adapter.ts";

export const MERCADOPAGO_POINT_API = "https://api.mercadopago.com";
/** Diferença máxima entre o ts assinado do aviso e o relógio (a mesma da Cobrança). */
export const POINT_WEBHOOK_WINDOW_MS = 15 * 60_000;

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;

async function call(ctx: TerminalContext, method: TerminalHttpRequest["method"], path: string, body?: unknown, charge = false) {
  const request: TerminalHttpRequest = {
    method, url: MERCADOPAGO_POINT_API + path,
    headers: { Authorization: `Bearer ${ctx.credentials.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (!ctx.credentials.access_token) throw new TerminalError("configuracao", "Falta o Access Token do Mercado Pago. O administrador cola em Preferências → Vendas → Frente de caixa → Maquininha integrada (ou usa a conta da Cobrança).");
  let response;
  try { response = await ctx.http(request); }
  catch (error) {
    if (error instanceof TerminalError) throw error;
    // O pedido de cobrança pode ter chegado: quem chamou consulta antes de enviar outro.
    throw charge ? new TerminalError("incerto", "O Mercado Pago não respondeu a tempo. A cobrança pode ter chegado à maquininha: o Wabotia confere antes de enviar outra.")
      : new TerminalError("indisponivel", "O Mercado Pago não respondeu. Tente de novo em instantes.");
  }
  const data = object(response.body);
  if (response.status === 401 || response.status === 403)
    throw new TerminalError("credencial", "O Mercado Pago recusou a credencial. Confira o Access Token (em Gestão → Cobrança, se a maquininha usa a mesma conta, ou em Preferências → Vendas → Frente de caixa → Maquininha integrada).");
  if (charge && (response.status >= 500 || response.status === 408 || response.status === 429))
    throw new TerminalError("incerto", "O Mercado Pago demorou para confirmar a cobrança. Ela pode ter chegado à maquininha: o Wabotia confere antes de enviar outra.");
  if (response.status >= 500 || response.status === 429) throw new TerminalError("indisponivel", "O Mercado Pago está instável agora. Tente de novo em instantes.");
  if (response.status === 404) throw new TerminalError("recusado", "O Mercado Pago não achou a maquininha ou a cobrança. Confira o terminal escolhido para o caixa.");
  if (response.status === 409)
    throw new TerminalError("ocupado", charge ? "A maquininha já tem outra cobrança na fila. Termine ou cancele a cobrança na maquininha e tente de novo."
      : "A cobrança já está na tela da maquininha e não pode ser cancelada daqui. Cancele na própria maquininha e depois consulte.");
  if (response.status >= 400) {
    const reason = shortReason(data.message) ?? shortReason(data.error);
    throw new TerminalError("recusado", `O Mercado Pago recusou o pedido${reason ? ` (${reason})` : ""}. Confira o valor, as parcelas e a maquininha.`);
  }
  return data;
}

/** Recusa do cartão em palavras (status_detail do pagamento). */
const REJECTIONS: Readonly<Record<string, string>> = Object.freeze({
  cc_rejected_insufficient_amount: "Saldo ou limite insuficiente no cartão.",
  cc_rejected_bad_filled_security_code: "Senha ou código de segurança errado.",
  cc_rejected_bad_filled_date: "Data de validade do cartão errada.",
  cc_rejected_bad_filled_other: "Algum dado do cartão foi digitado errado.",
  cc_rejected_call_for_authorize: "O banco do cartão pediu autorização: o cliente precisa falar com o banco dele.",
  cc_rejected_card_disabled: "O cartão está bloqueado ou não foi desbloqueado.",
  cc_rejected_blacklist: "O cartão não pode ser usado.",
  cc_rejected_high_risk: "Recusado pela análise de segurança do Mercado Pago.",
  cc_rejected_max_attempts: "Tentativas demais com este cartão. Use outro cartão.",
  cc_rejected_duplicated_payment: "Pagamento repetido: o mesmo valor já foi pago com este cartão há pouco.",
  cc_rejected_invalid_installments: "O cartão não aceita este número de parcelas.",
  cc_rejected_card_error: "O cartão não foi lido. Tente de novo ou use outro cartão.",
  rejected_by_issuer: "O banco do cartão recusou o pagamento.",
  rejected_by_bank: "O banco do cartão recusou o pagamento.",
});
export const pointRejection = (detail: unknown) => (typeof detail === "string" && REJECTIONS[detail]) || "O banco do cartão recusou o pagamento.";

const INTENT_STATES: Readonly<Record<string, [TerminalChargeState, string | null]>> = Object.freeze({
  OPEN: ["aguardando", "A cobrança está na fila da maquininha."],
  ON_TERMINAL: ["aguardando", "A cobrança está na tela da maquininha: o cliente pode passar o cartão."],
  PROCESSING: ["processando", "A maquininha está processando o cartão."],
  CANCELED: ["cancelado", "A cobrança foi cancelada (na maquininha ou no caixa)."],
  ABANDONED: ["cancelado", "A maquininha desistiu da cobrança: ninguém passou o cartão a tempo."],
  ERROR: ["erro", "A maquininha avisou um erro na cobrança. Confira a maquininha e tente de novo."],
});

const kindOf = (value: unknown) => value === "debit_card" ? "debito" as const : value === "credit_card" ? "credito" as const : null;
const fee = (payment: Record<string, any>) => {
  const list = Array.isArray(payment.fee_details) ? payment.fee_details : [];
  if (!list.length) return null;
  let sum = 0;
  for (const item of list) { const cents = reaisToCents(object(item).amount); if (cents === null) return null; sum += cents; }
  return sum;
};

async function readIntent(ctx: TerminalContext, ref: string): Promise<TerminalCharge> {
  const intent = await call(ctx, "GET", `/point/integration-api/payment-intents/${encodeURIComponent(ref)}`);
  const info = object(intent.additional_info), payment = object(intent.payment);
  const base: TerminalCharge = {
    ref: text(intent.id) ?? ref, state: "aguardando", reason: null, reference: text(info.external_reference), device_id: text(intent.device_id),
    payment_id: text(payment.id), amount_cents: typeof intent.amount === "number" && Number.isSafeInteger(intent.amount) ? intent.amount : null,
    kind: kindOf(payment.type), installments: Number.isSafeInteger(payment.installments) ? payment.installments : null,
    brand: null, authorization: null, nsu: null, last4: null, paid_at: null, fee_cents: null,
  };
  const state = String(intent.state ?? "").toUpperCase();
  if (state === "FINISHED" || state === "PROCESSED") {
    if (!base.payment_id) return { ...base, state: "processando", reason: "A maquininha terminou; esperando o resultado do cartão." };
    const paid = await call(ctx, "GET", `/v1/payments/${encodeURIComponent(base.payment_id)}`);
    const status = String(paid.status ?? "");
    const card = object(paid.card), details = object(paid.transaction_details);
    const full: TerminalCharge = {
      ...base, kind: kindOf(paid.payment_type_id) ?? base.kind, installments: Number.isSafeInteger(paid.installments) ? paid.installments : base.installments,
      amount_cents: reaisToCents(paid.transaction_amount) ?? base.amount_cents, brand: brandOf(paid.payment_method_id),
      authorization: text(paid.authorization_code), last4: typeof card.last_four_digits === "string" && /^\d{4}$/.test(card.last_four_digits) ? card.last_four_digits : null,
      // O Mercado Pago não chama o número de NSU: a referência da adquirente, quando vem, e senão o número da operação.
      nsu: text(details.acquirer_reference) ?? text(paid.id), fee_cents: fee(paid),
      paid_at: typeof paid.date_approved === "string" && Number.isFinite(Date.parse(paid.date_approved)) ? Date.parse(paid.date_approved) : null,
    };
    if (status === "approved") return { ...full, state: "aprovado", reason: null };
    if (status === "rejected") return { ...full, state: "recusado", reason: pointRejection(paid.status_detail) };
    if (status === "cancelled" || status === "refunded" || status === "charged_back") return { ...full, state: "cancelado", reason: "O pagamento foi cancelado ou estornado no Mercado Pago." };
    return { ...full, state: "processando", reason: "O Mercado Pago ainda está analisando o pagamento." };
  }
  const [mapped, reason] = INTENT_STATES[state] ?? ["aguardando", null];
  return { ...base, state: mapped, reason };
}

const DEVICE_MODES: Readonly<Record<string, string>> = Object.freeze({ PDV: "integrado ao caixa", STANDALONE: "uso avulso (fora do caixa)" });

/** HMAC-SHA256 em hexadecimal (WebCrypto: Worker e Node). */
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Manifest assinado pelo Mercado Pago; partes ausentes ficam de fora (o mesmo da Cobrança). */
export const pointManifest = (dataId: string | null, requestId: string | null, ts: string) =>
  (dataId ? `id:${dataId.toLowerCase()};` : "") + (requestId ? `request-id:${requestId};` : "") + `ts:${ts};`;

const isoDay = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);

export const mercadoPagoPoint: TerminalProvider = {
  id: "mercadopago",
  name: "Mercado Pago",
  maxInstallments: 12,

  async listDevices(ctx) {
    const data = await call(ctx, "GET", "/point/integration-api/devices?limit=50");
    const devices = Array.isArray(data.devices) ? data.devices.map(object) : [];
    return devices.filter(item => text(item.id)).map((item): TerminalDevice => {
      const mode = text(item.operating_mode);
      return { id: text(item.id)!, name: text(item.id)!, mode, ready: mode === "PDV",
        note: mode === "PDV" ? null : `Em ${DEVICE_MODES[mode ?? ""] ?? "outro modo"}: ao escolher para o caixa, o Wabotia passa para o modo integrado (a maquininha pode pedir para reiniciar).` };
    });
  },

  async prepareDevice(ctx, deviceId) {
    await call(ctx, "PATCH", `/point/integration-api/devices/${encodeURIComponent(deviceId)}`, { operating_mode: "PDV" });
  },

  async createCharge(ctx, request) {
    if (!Number.isSafeInteger(request.amount_cents) || request.amount_cents < 1) throw new TerminalError("recusado", "Valor da cobrança inválido.");
    const credit = request.kind === "credito";
    const payment = credit
      ? { type: "credit_card", installments: request.installments, installments_cost: request.installments_cost === "cliente" ? "buyer" : "seller" }
      : { type: "debit_card", installments: 1 };
    const data = await call(ctx, "POST", `/point/integration-api/devices/${encodeURIComponent(request.device_id)}/payment-intents`, {
      amount: request.amount_cents, description: request.description.slice(0, 60), payment,
      additional_info: { external_reference: request.reference, print_on_terminal: true },
    }, true);
    const ref = text(data.id);
    if (!ref) throw new TerminalError("incerto", "O Mercado Pago respondeu sem o número da cobrança. O Wabotia confere na maquininha antes de enviar outra.");
    return { ref };
  },

  getCharge: readIntent,

  async findCharge(ctx, input) {
    const now = ctx.now?.() ?? Date.now();
    const data = await call(ctx, "GET", `/point/integration-api/payment-intents/events?startDate=${isoDay(input.since - 86_400_000)}&endDate=${isoDay(now)}`);
    const events = Array.isArray(data.events) ? data.events.map(object) : [];
    const ids = [...new Set(events.map(event => text(event.payment_intent_id)).filter((id): id is string => !!id))].reverse().slice(0, 20);
    for (const id of ids) {
      const charge = await readIntent(ctx, id);
      if (charge.reference === input.reference && (!charge.device_id || charge.device_id === input.device_id)) return charge;
    }
    return null;
  },

  async cancelCharge(ctx, input) {
    await call(ctx, "DELETE", `/point/integration-api/devices/${encodeURIComponent(input.device_id)}/payment-intents/${encodeURIComponent(input.ref)}`);
  },

  async verifyWebhook(ctx, input) {
    const parts: Record<string, string> = {};
    for (const piece of (input.headers.get("x-signature") || "").split(",")) {
      const [key, ...rest] = piece.split("=");
      if (key && rest.length) parts[key.trim()] = rest.join("=").trim();
    }
    if (!ctx.credentials.webhook_secret || !parts.ts || !parts.v1) throw new TerminalError("credencial", "Aviso sem assinatura.");
    const ts = Number(parts.ts), tsMs = ts < 1e12 ? ts * 1000 : ts;
    if (!Number.isFinite(tsMs) || Math.abs((ctx.now?.() ?? Date.now()) - tsMs) > POINT_WEBHOOK_WINDOW_MS) throw new TerminalError("credencial", "Aviso fora do prazo.");
    const signedId = input.query.get("data.id");
    const expected = await hmacHex(ctx.credentials.webhook_secret, pointManifest(signedId, input.headers.get("x-request-id"), parts.ts));
    if (!sameText(expected, parts.v1.toLowerCase())) throw new TerminalError("credencial", "Assinatura do aviso inválida.");
    const body = object(input.body);
    // Só ids: quem chamou consulta cada um no provedor.
    const refs = [signedId, text(object(body.data).id), text(body.id), text(body.payment_intent_id)].filter((id): id is string => !!id && id.length <= 80);
    return { refs: [...new Set(refs)] };
  },
};
