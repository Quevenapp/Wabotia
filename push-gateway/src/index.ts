// Gateway de push do Wabotia: recebe notificações de qualquer servidor Wabotia
// e as repassa ao Firebase Cloud Messaging com a conta de serviço do aplicativo
// publicado nas lojas. Não guarda nem registra o conteúdo das mensagens.
import { Hono } from "hono";
import {
  sendFcm,
  type PushMessage,
  type PushResult,
  type ServiceAccount,
} from "../../src/push-fcm";
import pkg from "../package.json";

export interface Env {
  /** JSON da conta de serviço Firebase (wrangler secret put FCM_SERVICE_ACCOUNT). */
  FCM_SERVICE_ACCOUNT?: string;
  /** Opcional: exige Authorization: Bearer <valor> em POST /v1/push. */
  GATEWAY_SHARED_SECRET?: string;
}

export const MAX_MESSAGES = 100;
export const MAX_BODY_BYTES = 512 * 1024;
/** Mensagens por minuto por IP. O contador vive na memória de cada isolado. */
export const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public index?: number,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string, index?: number) =>
  new GatewayError(status, code, message, index);

const enc = new TextEncoder();
function safeEqual(a: string, b: string) {
  const x = enc.encode(a),
    y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  const subtle: any = crypto.subtle;
  if (typeof subtle.timingSafeEqual === "function")
    return subtle.timingSafeEqual(x, y) as boolean;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Conta de serviço: lida do segredo e validada uma vez por isolado.
let accountCache: { raw: string; account: ServiceAccount | null } | undefined;
export function serviceAccount(env: Env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;
  if (accountCache && accountCache.raw === raw) return accountCache.account;
  let account: ServiceAccount | null = null;
  try {
    const parsed: any = JSON.parse(raw);
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const client_email = text(parsed?.client_email),
      private_key = typeof parsed?.private_key === "string" ? parsed.private_key : "",
      project_id = text(parsed?.project_id),
      token_uri = text(parsed?.token_uri) || "https://oauth2.googleapis.com/token";
    if (
      client_email &&
      private_key.includes("PRIVATE KEY") &&
      project_id &&
      /^https:\/\//.test(token_uri)
    )
      account = { client_email, private_key, project_id, token_uri };
  } catch {}
  accountCache = { raw, account };
  return account;
}

// Limite por IP (janela fixa de 1 minuto) na memória do isolado: cada isolado
// do Cloudflare mantém o próprio contador, então o limite efetivo é por
// isolado e não global. Serve para conter abuso grosseiro, não para cobrança.
const buckets = new Map<string, { start: number; count: number }>();
export function consumeRate(ip: string, amount: number, now = Date.now()) {
  if (buckets.size > 5000)
    for (const [key, b] of buckets)
      if (now - b.start >= RATE_WINDOW_MS) buckets.delete(key);
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }
  if (bucket.count + amount > RATE_LIMIT) {
    const retryAfter = Math.max(
      1,
      Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000),
    );
    return { ok: false as const, retryAfter };
  }
  bucket.count += amount;
  return { ok: true as const, remaining: RATE_LIMIT - bucket.count };
}
export function resetRate() {
  buckets.clear();
}

const PLATFORMS = ["android", "ios"];
const PRIORITIES = ["high", "normal"];
const optionalText = (
  value: unknown,
  max: number,
  label: string,
  index: number,
) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw fail(
      400,
      "invalid_message",
      `Campo ${label} inválido (texto de até ${max} caracteres).`,
      index,
    );
  return value;
};
export function validateMessage(raw: unknown, index: number): PushMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw fail(400, "invalid_message", "Mensagem deve ser um objeto.", index);
  const m: any = raw;
  if (
    typeof m.token !== "string" ||
    m.token.length < 20 ||
    m.token.length > 4096 ||
    /\s/.test(m.token)
  )
    throw fail(
      400,
      "invalid_message",
      "Campo token inválido (20 a 4096 caracteres, sem espaços).",
      index,
    );
  if (!PLATFORMS.includes(m.platform))
    throw fail(
      400,
      "invalid_message",
      "Campo platform inválido (android ou ios).",
      index,
    );
  if (typeof m.title !== "string" || m.title.length > 200)
    throw fail(
      400,
      "invalid_message",
      "Campo title inválido (texto de até 200 caracteres).",
      index,
    );
  if (typeof m.body !== "string" || m.body.length > 500)
    throw fail(
      400,
      "invalid_message",
      "Campo body inválido (texto de até 500 caracteres).",
      index,
    );
  if (!m.title.trim() && !m.body.trim())
    throw fail(
      400,
      "invalid_message",
      "Informe title ou body com conteúdo.",
      index,
    );
  const data: Record<string, string> = {};
  if (m.data !== undefined && m.data !== null) {
    if (typeof m.data !== "object" || Array.isArray(m.data))
      throw fail(400, "invalid_message", "Campo data deve ser um objeto.", index);
    const entries = Object.entries(m.data);
    if (entries.length > 20)
      throw fail(
        400,
        "invalid_message",
        "Campo data aceita no máximo 20 chaves.",
        index,
      );
    for (const [key, value] of entries) {
      if (
        !key ||
        key.length > 64 ||
        typeof value !== "string" ||
        value.length > 1000
      )
        throw fail(
          400,
          "invalid_message",
          "Campo data deve conter apenas textos (chaves de até 64 e valores de até 1000 caracteres).",
          index,
        );
      data[key] = value;
    }
  }
  let priority: PushMessage["priority"] = "normal";
  if (m.priority !== undefined && m.priority !== null) {
    if (!PRIORITIES.includes(m.priority))
      throw fail(
        400,
        "invalid_message",
        "Campo priority inválido (high ou normal).",
        index,
      );
    priority = m.priority;
  }
  if (
    m.time_sensitive !== undefined &&
    m.time_sensitive !== null &&
    typeof m.time_sensitive !== "boolean"
  )
    throw fail(
      400,
      "invalid_message",
      "Campo time_sensitive deve ser verdadeiro ou falso.",
      index,
    );
  const message: PushMessage = {
    token: m.token,
    platform: m.platform,
    title: m.title,
    body: m.body,
    data,
    priority,
  };
  const collapse = optionalText(m.collapse_key, 100, "collapse_key", index),
    channel = optionalText(m.channel, 50, "channel", index),
    category = optionalText(m.category, 50, "category", index);
  if (collapse) message.collapse_key = collapse;
  if (channel) message.channel = channel;
  if (category) message.category = category;
  if (m.time_sensitive === true) message.time_sensitive = true;
  return message;
}

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  if (error instanceof GatewayError) {
    const body: any = {
      error: { code: error.code, message: error.message },
    };
    if (error.index !== undefined) body.error.index = error.index;
    const headers: Record<string, string> = {};
    if (error.status === 429 && (error as any).retryAfter)
      headers["Retry-After"] = String((error as any).retryAfter);
    return c.json(body, error.status as any, headers);
  }
  console.error("push-gateway: erro interno", error instanceof Error ? error.name : "");
  return c.json(
    { error: { code: "internal_error", message: "Erro interno do gateway." } },
    500,
  );
});
app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Rota não encontrada." } }, 404),
);

const health = (c: any) =>
  c.json({ service: "wabotia-push-gateway", version: pkg.version });
app.get("/health", health);
app.get("/", health);

app.post("/v1/push", async (c) => {
  const env = c.env;
  if (env.GATEWAY_SHARED_SECRET) {
    const header = c.req.header("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !safeEqual(token, env.GATEWAY_SHARED_SECRET))
      throw fail(401, "unauthorized", "Segredo do gateway inválido.");
  }
  const account = serviceAccount(env);
  if (!account)
    throw fail(
      503,
      "setup_required",
      "Gateway sem conta de serviço FCM válida. Publique o segredo FCM_SERVICE_ACCOUNT.",
    );
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES)
    throw fail(413, "payload_too_large", "Corpo da requisição muito grande.");
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw fail(400, "invalid_json", "Corpo deve ser JSON válido.");
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages))
    throw fail(400, "invalid_request", "Informe messages como lista.");
  if (payload.messages.length > MAX_MESSAGES)
    throw fail(
      400,
      "invalid_request",
      `Envie no máximo ${MAX_MESSAGES} mensagens por chamada.`,
    );
  const messages = payload.messages.map((m: unknown, i: number) =>
    validateMessage(m, i),
  );
  if (!messages.length) return c.json({ results: [] as PushResult[] });
  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    "unknown";
  const rate = consumeRate(ip, messages.length);
  if (!rate.ok) {
    const error = fail(
      429,
      "rate_limited",
      `Limite de ${RATE_LIMIT} mensagens por minuto excedido.`,
    );
    (error as any).retryAfter = rate.retryAfter;
    throw error;
  }
  const results = await sendFcm(account, messages, fetch);
  const counts = { ok: 0, unregistered: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  // Apenas contagens: nunca tokens, títulos, corpos ou dados.
  console.log(
    `push-gateway: ${messages.length} mensagem(ns) ok=${counts.ok} unregistered=${counts.unregistered} error=${counts.error}`,
  );
  return c.json({ results });
});

export default app;
