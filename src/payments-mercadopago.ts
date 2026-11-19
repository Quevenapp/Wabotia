// Mercado Pago (docs/COBRANCA.md). Campos conferidos na documentação oficial
// em 15/11/2026:
// - Pix: POST /v1/payments com payment_method_id "pix", X-Idempotency-Key e
//   point_of_interaction.transaction_data.{qr_code, qr_code_base64, ticket_url}
//   na resposta; date_of_expiration entre 30 minutos e 30 dias.
// - Link: POST /checkout/preferences (Checkout Pro), init_point na resposta;
//   external_reference até 64 caracteres [A-Za-z0-9_-].
// - Webhook: x-signature "ts=...,v1=...", x-request-id, data.id da query (em
//   minúsculas); manifest "id:[data.id];request-id:[x-request-id];ts:[ts];"
//   (partes ausentes saem); HMAC-SHA256 hexadecimal com a assinatura secreta.
// Nenhuma chamada real foi feita nos testes: as respostas são simuladas.
import { ApiError } from "./types";
import { equal, hmac } from "./security";
import type {
  ChargeRequest,
  CreatedCharge,
  PaymentProvider,
  ProviderCredentials,
  ProviderPayment,
  ProviderPaymentState,
} from "./payments-provider";

export const MERCADOPAGO_API = "https://api.mercadopago.com";

/** Data no formato do Mercado Pago, no horário de Brasília (UTC-3). */
export const mpDate = (ms: number) =>
  new Date(ms - 3 * 3600000).toISOString().replace("Z", "-03:00");

async function call(
  creds: ProviderCredentials,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  let response: Response;
  try {
    response = await fetch(MERCADOPAGO_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(
      502,
      "provider_unavailable",
      "O Mercado Pago não respondeu. Tente de novo em instantes.",
    );
  }
  const data = await response.json<any>().catch(() => ({}));
  if (response.status === 401 || response.status === 403)
    throw new ApiError(
      502,
      "provider_auth",
      "O Mercado Pago recusou a credencial. Confira o Access Token em Gestão → Cobrança.",
    );
  if (!response.ok)
    throw new ApiError(
      502,
      "provider_error",
      "O Mercado Pago recusou a operação. Confira os dados no painel do provedor.",
    );
  return data;
}

/** Diferença máxima entre o ts assinado do webhook e o relógio. */
export const WEBHOOK_WINDOW_MS = 15 * 60_000;
const cents = (value: unknown) => Math.round(Number(value || 0) * 100);
const amount = (value: number) => Math.round(value) / 100;

export function mpState(status: string, detail?: string): ProviderPaymentState {
  if (status === "approved") return "paid";
  if (status === "refunded" || status === "charged_back") return "refunded";
  if (status === "cancelled")
    return detail === "expired" ? "expired" : "cancelled";
  if (status === "rejected") return "rejected";
  return "pending";
}

function parseSignature(header: string | null) {
  const parts: Record<string, string> = {};
  for (const piece of (header || "").split(",")) {
    const [key, ...rest] = piece.split("=");
    if (key && rest.length) parts[key.trim()] = rest.join("=").trim();
  }
  return parts;
}

/** Manifest assinado pelo Mercado Pago; partes ausentes ficam de fora. */
export function mpManifest(
  dataId: string | null,
  requestId: string | null,
  ts: string,
) {
  return (
    (dataId ? `id:${dataId.toLowerCase()};` : "") +
    (requestId ? `request-id:${requestId};` : "") +
    `ts:${ts};`
  );
}

export const mercadoPago: PaymentProvider = {
  id: "mercadopago",
  name: "Mercado Pago",
  methods: ["pix", "link"],

  async test(creds) {
    const me = await call(creds, "GET", "/users/me");
    return {
      id: String(me.id ?? ""),
      name: String(me.nickname || me.email || me.id || ""),
    };
  },

  async createPix(creds, req: ChargeRequest): Promise<CreatedCharge> {
    const data = await call(
      creds,
      "POST",
      "/v1/payments",
      {
        transaction_amount: amount(req.amount_cents),
        description: req.description,
        payment_method_id: "pix",
        payer: { email: req.payer_email },
        date_of_expiration: mpDate(req.expires_at),
        external_reference: req.id,
        notification_url: req.notification_url,
      },
      req.id,
    );
    const tx = data?.point_of_interaction?.transaction_data || {};
    if (!data?.id || !tx.qr_code)
      throw new ApiError(
        502,
        "provider_error",
        "O Mercado Pago não devolveu o código Pix.",
      );
    return {
      provider_ref: String(data.id),
      provider_status: String(data.status || "pending"),
      url: String(tx.ticket_url || ""),
      pix_code: String(tx.qr_code),
      ...(tx.qr_code_base64 ? { pix_qr: String(tx.qr_code_base64) } : {}),
    };
  },

  async createLink(creds, req: ChargeRequest): Promise<CreatedCharge> {
    const data = await call(
      creds,
      "POST",
      "/checkout/preferences",
      {
        items: [
          {
            id: req.id,
            title: req.description,
            quantity: 1,
            unit_price: amount(req.amount_cents),
            currency_id: req.currency,
          },
        ],
        external_reference: req.id,
        notification_url: req.notification_url,
        expires: true,
        expiration_date_to: mpDate(req.expires_at),
      },
      req.id,
    );
    if (!data?.id || !data.init_point)
      throw new ApiError(
        502,
        "provider_error",
        "O Mercado Pago não devolveu o link de pagamento.",
      );
    return {
      provider_ref: String(data.id),
      provider_status: "pending",
      url: String(data.init_point),
    };
  },

  async getPayment(creds, id): Promise<ProviderPayment> {
    const data = await call(
      creds,
      "GET",
      `/v1/payments/${encodeURIComponent(id)}`,
    );
    const raw = String(data?.status || "");
    const refunded = data?.transaction_amount_refunded == null ? null : cents(data.transaction_amount_refunded);
    const total = cents(data?.transaction_amount);
    const refundSignal = raw === "refunded" || data?.status_detail === "partially_refunded" || refunded !== null && refunded > 0 || data?.refunds?.length > 0;
    return {
      id: String(data?.id ?? id),
      state: mpState(raw, data?.status_detail),
      verified_method: data?.payment_method_id === "pix" ? "pix"
        : ["credit_card", "debit_card", "prepaid_card"].includes(data?.payment_type_id) ? "card" : "unknown",
      refunded_amount_cents: refunded,
      // Sem valor integral comprovado não se fabrica um estorno integral.
      refund_review_required: refundSignal && (!Number.isSafeInteger(refunded) || refunded !== total),
      raw_status: raw,
      external_reference: data?.external_reference
        ? String(data.external_reference)
        : null,
      amount_cents: cents(data?.transaction_amount),
      currency: String(data?.currency_id || "BRL"),
      paid_at: data?.date_approved
        ? Date.parse(data.date_approved) || null
        : null,
    };
  },

  async cancel(creds, charge) {
    if (charge.method === "pix")
      await call(
        creds,
        "PUT",
        `/v1/payments/${encodeURIComponent(charge.provider_ref)}`,
        { status: "cancelled" },
      );
    else
      await call(
        creds,
        "PUT",
        `/checkout/preferences/${encodeURIComponent(charge.provider_ref)}`,
        { expires: true, expiration_date_to: mpDate(Date.now()) },
      );
  },

  async verifyWebhook(creds, input) {
    const signature = parseSignature(input.headers.get("x-signature"));
    const requestId = input.headers.get("x-request-id");
    if (!creds.webhook_secret || !signature.ts || !signature.v1)
      throw new ApiError(401, "invalid_signature", "Assinatura ausente.");
    // Janela de tempo do ts assinado (revisão B2): aviso velho ou do futuro
    // não vale, mesmo com a assinatura certa.
    const ts = Number(signature.ts);
    const tsMs = ts < 1e12 ? ts * 1000 : ts;
    if (
      !Number.isFinite(tsMs) ||
      Math.abs(Date.now() - tsMs) > WEBHOOK_WINDOW_MS
    )
      throw new ApiError(401, "invalid_signature", "Assinatura fora do prazo.");
    // O id do pagamento só vale se veio na consulta, que entra no manifesto
    // assinado; o do corpo, se houver, tem de ser o mesmo (revisão B2).
    const signedId = input.query.get("data.id");
    const expected = await hmac(
      creds.webhook_secret,
      mpManifest(signedId, requestId, signature.ts),
    );
    if (!equal(expected, signature.v1.toLowerCase()))
      throw new ApiError(401, "invalid_signature", "Assinatura inválida.");
    const bodyId =
      input.body?.data?.id != null ? String(input.body.data.id) : null;
    if (bodyId !== null && signedId !== null && bodyId !== signedId)
      throw new ApiError(
        401,
        "invalid_signature",
        "data.id diferente do assinado.",
      );
    const type =
      input.query.get("type") || input.query.get("topic") || input.body?.type;
    return { paymentId: type === "payment" && signedId ? signedId : null };
  },
};
