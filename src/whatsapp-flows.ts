// WhatsApp Flows through Zernio (docs.zernio.com/platforms/whatsapp/flows):
// create a DRAFT, upload its Flow JSON, publish it (irreversible), list them
// and send a published Flow with a flow_token that correlates the answer.
// The answer arrives on message.received and is normalized as
// content.flow_reply (whatsapp-inbound.ts).
import { ApiError, Env, requireValue } from "./types";
import { zernioAccountId, zernioRequest } from "./zernio";
import { buildInteractive, flowToken } from "./whatsapp-interactive";

export const FLOW_CATEGORIES = [
  "SIGN_UP",
  "SIGN_IN",
  "APPOINTMENT_BOOKING",
  "LEAD_GENERATION",
  "CONTACT_US",
  "CUSTOMER_SUPPORT",
  "SURVEY",
  "OTHER",
] as const;
export type FlowCategory = (typeof FLOW_CATEGORIES)[number];
export type FlowStatus =
  "DRAFT" | "PUBLISHED" | "DEPRECATED" | "BLOCKED" | "THROTTLED";

export interface ZernioFlow {
  id: string;
  name: string;
  status: FlowStatus;
  categories: string[];
  version?: number;
  lineageId?: string;
  validation_errors?: unknown[];
}
export interface FlowValidationError {
  error?: string;
  error_type?: string;
  message?: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
}

const segment = (value: string) => {
  requireValue(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value),
    "ID do Flow inválido.",
  );
  return encodeURIComponent(value);
};

function flow(value: any): ZernioFlow {
  if (!value || typeof value.id !== "string" || !value.id)
    throw new ApiError(
      502,
      "zernio_unknown",
      "A Zernio não informou o Flow. Confira a lista de Flows antes de repetir.",
    );
  return value;
}

/** GET /v1/whatsapp/flows: every Flow of the line's WhatsApp Business Account. */
export async function zernioListFlows(env: Env, conn: any) {
  const query = new URLSearchParams({ accountId: zernioAccountId(conn) });
  const result = await zernioRequest(env, conn, `whatsapp/flows?${query}`);
  requireValue(Array.isArray(result.flows), "A Zernio não retornou os Flows.");
  return { data: result.flows as ZernioFlow[] };
}

/**
 * POST /v1/whatsapp/flows: a new DRAFT. `clone_flow_id` copies another Flow's
 * JSON; with `as_version` the copy is the next version of the same lineage
 * (the way to change a published Flow).
 */
export async function zernioCreateFlow(
  env: Env,
  conn: any,
  data: {
    name: string;
    categories: FlowCategory[];
    clone_flow_id?: string;
    as_version?: boolean;
    /** HTTPS data_exchange endpoint; only for Flows that use one. */
    endpoint_uri?: string;
  },
  idempotencyKey?: string,
) {
  requireValue(
    typeof data?.name === "string" &&
      data.name.trim() &&
      data.name.length <= 200,
    "Informe o nome do Flow.",
  );
  requireValue(
    Array.isArray(data.categories) &&
      data.categories.length > 0 &&
      data.categories.every((c) => FLOW_CATEGORIES.includes(c)),
    `Categorias do Flow: ${FLOW_CATEGORIES.join(", ")}.`,
  );
  if (data.endpoint_uri !== undefined)
    requireValue(
      typeof data.endpoint_uri === "string" &&
        data.endpoint_uri.startsWith("https://"),
      "O endpoint do Flow precisa usar HTTPS.",
    );
  const result = await zernioRequest(
    env,
    conn,
    "whatsapp/flows",
    "POST",
    {
      accountId: zernioAccountId(conn),
      name: data.name,
      categories: data.categories,
      ...(data.clone_flow_id
        ? {
            cloneFlowId: decodeURIComponent(segment(data.clone_flow_id)),
            ...(data.as_version ? { asVersion: true } : {}),
          }
        : {}),
      ...(data.endpoint_uri ? { endpointUri: data.endpoint_uri } : {}),
    },
    idempotencyKey,
  );
  return flow(result.flow);
}

/**
 * PUT /v1/whatsapp/flows/{flowId}/json: screens and navigation of a DRAFT, in
 * Meta's Flow JSON format. Meta answers 200 even when it rejects the JSON:
 * `valid` is false and `validation_errors` names line and column.
 */
export async function zernioUploadFlowJson(
  env: Env,
  conn: any,
  flowId: string,
  flowJson: Record<string, unknown>,
) {
  requireValue(
    flowJson &&
      typeof flowJson === "object" &&
      !Array.isArray(flowJson) &&
      Array.isArray((flowJson as any).screens),
    "Flow JSON inválido: informe version e screens.",
  );
  const result = await zernioRequest(
    env,
    conn,
    `whatsapp/flows/${segment(flowId)}/json`,
    "PUT",
    { accountId: zernioAccountId(conn), flow_json: flowJson },
  );
  const errors: FlowValidationError[] = Array.isArray(result.validation_errors)
    ? result.validation_errors
    : [];
  return { valid: errors.length === 0, validation_errors: errors };
}

/**
 * POST /v1/whatsapp/flows/{flowId}/publish. Irreversible: the Flow and its JSON
 * become immutable. Zernio answers 400 while the JSON has validation errors.
 */
export async function zernioPublishFlow(env: Env, conn: any, flowId: string) {
  await zernioRequest(
    env,
    conn,
    `whatsapp/flows/${segment(flowId)}/publish`,
    "POST",
    { accountId: zernioAccountId(conn) },
  );
  return { published: true };
}

export interface SendFlow {
  flow_id: string;
  /** Button label. */
  flow_cta: string;
  body: string;
  header?: string;
  footer?: string;
  /** Generated as `<flowId>:<uuid>` when absent; keep it to match the answer. */
  flow_token?: string;
  flow_action?: "navigate" | "data_exchange";
  /** For navigate: { screen, data? }. */
  flow_action_payload?: Record<string, unknown>;
  /** Sends a DRAFT Flow, for tests on your own number only. */
  draft?: boolean;
}

/**
 * POST /v1/whatsapp/flows/send: a published Flow addressed by phone number,
 * inside the 24-hour window. Returns the WhatsApp message id and the
 * flow_token (Zernio's response does not echo it, so it is always generated
 * here). For contacts known only by WhatsApp's business-scoped id, send
 * `{ type: "flow" }` through sendInteractive instead: that path uses the
 * conversation, not the phone number.
 */
export async function zernioSendFlow(
  env: Env,
  conn: any,
  to: string,
  data: SendFlow,
  idempotencyKey?: string,
) {
  const phone = typeof to === "string" ? to.replace(/^\+/, "") : "";
  requireValue(
    /^\d{8,16}$/.test(phone),
    "O envio de Flow por telefone exige o número do cliente. Para contatos sem número visível, envie o Flow dentro da conversa.",
  );
  const token = data.flow_token || flowToken(data.flow_id);
  // Same limits as the Flow sent inside the conversation.
  const built = buildInteractive({
    type: "flow",
    flow_id: data.flow_id,
    flow_cta: data.flow_cta,
    body: data.body,
    header: data.header,
    footer: data.footer,
    flow_token: token,
    flow_action: data.flow_action,
    flow_action_payload: data.flow_action_payload,
  });
  const result = await zernioRequest(
    env,
    conn,
    "whatsapp/flows/send",
    "POST",
    {
      accountId: zernioAccountId(conn),
      to: `+${phone}`,
      flow_id: data.flow_id,
      flow_cta: data.flow_cta,
      flow_action: built.action.parameters.flow_action,
      flow_token: token,
      ...(data.flow_action_payload
        ? { flow_action_payload: data.flow_action_payload }
        : {}),
      body: data.body,
      ...(built.header ? { header: built.header } : {}),
      ...(data.footer ? { footer: data.footer } : {}),
      ...(data.draft ? { draft: true } : {}),
    },
    idempotencyKey,
  );
  if (typeof result.messageId !== "string" || !result.messageId)
    throw new ApiError(
      502,
      "zernio_unknown",
      "A Zernio não informou o ID da mensagem do Flow. Confira a entrega antes de repetir.",
    );
  return { message_id: result.messageId as string, flow_token: token };
}
