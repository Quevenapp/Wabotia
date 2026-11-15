// Interface de provedor de pagamento (docs/COBRANCA.md). O núcleo e as
// verticais falam só com src/payments.ts; um provedor novo (Asaas) implementa
// esta interface e entra em `providers`, sem mudar módulos.

export interface ProviderCredentials {
  access_token: string;
  webhook_secret: string;
}

export interface ChargeRequest {
  /** Id da cobrança no Wabotia: vai como external_reference. */
  id: string;
  amount_cents: number;
  currency: string;
  description: string;
  payer_email: string;
  expires_at: number;
  /** URL do webhook desta conta no Wabotia. */
  notification_url: string;
}

export interface CreatedCharge {
  /** Pix: id do pagamento; link: id da preferência. */
  provider_ref: string;
  provider_status: string;
  /** Página do provedor (ticket do Pix ou checkout do link). */
  url: string;
  pix_code?: string;
  /** QR em PNG base64, sem o prefixo data:. */
  pix_qr?: string;
}

/** Estado normalizado de um pagamento consultado no provedor. */
export type ProviderPaymentState =
  "pending" | "paid" | "rejected" | "cancelled" | "expired" | "refunded";

export interface ProviderPayment {
  id: string;
  state: ProviderPaymentState;
  /** Status bruto do provedor (approved, pending, charged_back…). */
  raw_status: string;
  external_reference: string | null;
  amount_cents: number;
  currency: string;
  paid_at: number | null;
}

export interface WebhookInput {
  headers: Headers;
  query: URLSearchParams;
  body: any;
}

export interface PaymentProvider {
  id: string;
  name: string;
  methods: readonly ("pix" | "link")[];
  /** Confere as credenciais e devolve dados públicos da conta. */
  test(creds: ProviderCredentials): Promise<{ id: string; name: string }>;
  createPix(
    creds: ProviderCredentials,
    req: ChargeRequest,
  ): Promise<CreatedCharge>;
  createLink(
    creds: ProviderCredentials,
    req: ChargeRequest,
  ): Promise<CreatedCharge>;
  getPayment(creds: ProviderCredentials, id: string): Promise<ProviderPayment>;
  /** Cancela no provedor uma cobrança ainda aberta (melhor esforço). */
  cancel(
    creds: ProviderCredentials,
    charge: { method: string; provider_ref: string },
  ): Promise<void>;
  /**
   * Valida a assinatura do webhook e devolve o id do pagamento notificado,
   * null para notificações que não são de pagamento. Lança em assinatura
   * inválida.
   */
  verifyWebhook(
    creds: ProviderCredentials,
    input: WebhookInput,
  ): Promise<{ paymentId: string | null }>;
}
