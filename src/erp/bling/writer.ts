/** Escrita de volta no Bling (mão dupla): uma tentativa por chamada, sem
 * repetição, espera ou renovação escondidas. Só os caminhos da API v3 das
 * entidades da mão dupla; nota fiscal e ordem de serviço não têm caminho aqui.
 *
 * O resultado diz o que se sabe: gravou, recusou (definitivo), limite de taxa,
 * falta autorizar, ou INCERTO (tempo esgotado, queda de conexão ou erro do
 * servidor depois do envio). Incerto nunca é repetido por esta camada: quem
 * chama confere por GET antes de tentar de novo. */
import { BLING_BUDGET, type BlingContext } from "./contracts.ts";

export type BlingWriteMethod = "POST" | "PUT";
export interface BlingWriteRequest { method: BlingWriteMethod; path: string; body: Record<string, unknown>; deadline: number }
export interface BlingReadRequest { path: string; query?: Record<string, string | string[]>; deadline: number }
export type BlingWriteResult =
  | { kind: "ok"; status: number; data: unknown }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "rate"; retry_at: number }
  | { kind: "auth"; status: 401 | 403; message: string }
  | { kind: "uncertain"; reason: "timeout" | "network" | "server"; status: number | null }
  | { kind: "not_sent"; retry_at: number; message: string };
export type BlingReadResult =
  | { kind: "ok"; data: unknown }
  | { kind: "missing" }
  | { kind: "rate"; retry_at: number }
  | { kind: "retry"; retry_at: number; message: string }
  | { kind: "auth"; status: 401 | 403; message: string };
export interface BlingWritePort {
  send(ctx: BlingContext, request: BlingWriteRequest): Promise<BlingWriteResult>;
  read(ctx: BlingContext, request: BlingReadRequest): Promise<BlingReadResult>;
}

const ID = "[1-9][0-9]{0,39}";
const ROOT = "(contatos|produtos|propostas-comerciais|pedidos/vendas|pedidos/compras|contas/receber|contas/pagar)";
/** Caminhos que aceitam escrita, por método. Nada além disto sai daqui. */
const WRITE_PATHS: Record<BlingWriteMethod, RegExp[]> = {
  POST: [new RegExp(`^/${ROOT}$`), new RegExp(`^/contas/(receber|pagar)/${ID}/baixar$`), /^\/estoques$/],
  PUT: [new RegExp(`^/${ROOT}/${ID}$`)],
};
const READ_PATHS = [new RegExp(`^/${ROOT}(/${ID})?$`), /^\/estoques\/saldos$/];
export const isWritablePath = (method: BlingWriteMethod, path: string) => WRITE_PATHS[method]?.some(re => re.test(path)) ?? false;
export const isReadablePath = (path: string) => READ_PATHS.some(re => re.test(path));

const ALLOWED_BASES = ["https://api.bling.com.br/Api/v3", "https://bling.invalid/Api/v3"];
const RESPONSE_LIMIT = 2 * 1024 * 1024;
export interface BlingWriterTimer { set(callback: () => void, milliseconds: number): unknown; clear(handle: unknown): void }
const defaultTimer: BlingWriterTimer = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
export interface BlingWriterOptions {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Token de acesso do cofre, conferido antes de cada chamada. Nunca vai a log, erro ou banco. */
  accessToken(ctx: BlingContext): Promise<string>;
  /** Apenas a origem oficial fixa ou o domínio reservado do simulador. */
  baseUrl?: string;
  timer?: BlingWriterTimer;
}

/** Texto curto, sem quebra nem controle: o motivo do Bling dito na tela. */
function clean(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
/** Motivo da recusa em palavras, a partir do corpo de erro da API v3. */
export function blingRefusal(status: number, body: unknown): string {
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const fields = Array.isArray(e.fields) ? e.fields.map(f => f && typeof f === "object" ? clean((f as Record<string, unknown>).msg, 160) : null).filter(Boolean) : [];
  const said = [clean(e.description) ?? clean(e.message), ...fields].filter(Boolean).join(" ");
  const base = status === 404 ? "O registro não existe mais no Bling (foi excluído lá?)."
    : status === 409 ? "O Bling recusou porque o registro mudou lá ao mesmo tempo."
    : "O Bling recusou os dados.";
  return (said ? `${base} Motivo informado pelo Bling: ${said}` : `${base} Confira o registro no ERP e no Bling.`).slice(0, 590);
}
function retryAfter(value: string | null, now: number): number {
  if (value && /^\d{1,12}(?:\.\d{1,3})?$/.test(value.trim())) return now + Math.ceil(Number(value) * 1000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > now ? date : now + 60_000;
}
async function bodyOf(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) { void response.body?.cancel().catch(() => {}); return null; }
  try {
    const text = await response.text();
    if (!text || text.length > RESPONSE_LIMIT) return null;
    return JSON.parse(text);
  } catch { return null; }
}
const AUTH_TEXT = {
  401: "A conta do Bling precisa ser autorizada de novo. Peça a renovação em Receber dados do Bling → Configuração.",
  403: "O aplicativo do Bling não tem permissão para gravar este tipo de registro. Autorize de novo pedindo a permissão de escrita.",
} as const;

export function createBlingWriter(options: BlingWriterOptions): BlingWritePort {
  const base = options.baseUrl ?? ALLOWED_BASES[0];
  if (!ALLOWED_BASES.includes(base)) throw new Error("BLING_WRITER_BASE");
  const timer = options.timer ?? defaultTimer;

  /** Uma chamada com prazo. `sent` diz se o pedido pode ter saído. */
  async function call(ctx: BlingContext, method: "GET" | BlingWriteMethod, url: string, body: string | null, deadline: number):
    Promise<{ response: Response } | { error: "timeout" | "network" | "token"; message?: string }> {
    const limit = Math.min(deadline, ctx.clock.now() + BLING_BUDGET.http_ms);
    if (limit <= ctx.clock.now()) return { error: "token", message: "Sem tempo nesta rodada; tenta na próxima." };
    let token: string;
    try { token = await options.accessToken(ctx); }
    catch { return { error: "token", message: AUTH_TEXT[401] }; }
    if (!token || /\s/.test(token) || token.length > 8192) return { error: "token", message: AUTH_TEXT[401] };
    const controller = new AbortController(); let handle: unknown;
    const timeout = new Promise<{ error: "timeout" }>(resolve => { handle = timer.set(() => { controller.abort(); resolve({ error: "timeout" }); }, Math.max(1, limit - ctx.clock.now())); });
    const attempt = (async () => {
      try {
        const response = await options.fetch(url, { method, redirect: "manual", signal: controller.signal, body,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "enable-jwt": "1", ...(body !== null ? { "Content-Type": "application/json" } : {}) } });
        return { response };
      } catch { return controller.signal.aborted ? { error: "timeout" as const } : { error: "network" as const }; }
    })();
    try { return await Promise.race([attempt, timeout]); }
    finally { timer.clear(handle); }
  }
  function address(path: string, query?: Record<string, string | string[]>): string {
    const url = new URL(base + path);
    for (const [key, entry] of Object.entries(query ?? {})) {
      for (const value of Array.isArray(entry) ? entry : [entry]) {
        if (typeof value !== "string" || value.length > 200 || /[\r\n\0]/.test(value) || /token|secret|authorization|password/i.test(key)) throw new Error("BLING_WRITER_QUERY");
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  return {
    async send(ctx, request) {
      if (!isWritablePath(request.method, request.path)) return { kind: "rejected", status: 0, message: "Este tipo de registro não pode ser gravado no Bling por aqui." };
      let payload: string;
      try { payload = JSON.stringify(request.body); } catch { return { kind: "rejected", status: 0, message: "Os dados para o Bling não puderam ser montados." }; }
      if (payload.length > 1_000_000) return { kind: "rejected", status: 0, message: "O registro é grande demais para enviar ao Bling de uma vez." };
      const result = await call(ctx, request.method, address(request.path), payload, request.deadline);
      if ("error" in result) {
        // Sem token não houve envio. Tempo esgotado ou queda: pode ter entrado.
        if (result.error === "token") return { kind: "not_sent", retry_at: ctx.clock.now() + 15 * 60_000, message: result.message ?? AUTH_TEXT[401] };
        return { kind: "uncertain", reason: result.error, status: null };
      }
      const { response } = result, status = response.status;
      if (status >= 200 && status < 300) return { kind: "ok", status, data: await bodyOf(response) };
      if (status === 429) { void response.body?.cancel().catch(() => {}); return { kind: "rate", retry_at: retryAfter(response.headers.get("retry-after"), ctx.clock.now()) }; }
      if (status === 401 || status === 403) { void response.body?.cancel().catch(() => {}); return { kind: "auth", status, message: AUTH_TEXT[status] }; }
      // Erro do servidor ou redirecionamento: não dá para saber se gravou.
      if (status >= 500 || (status >= 300 && status < 400)) { void response.body?.cancel().catch(() => {}); return { kind: "uncertain", reason: "server", status }; }
      return { kind: "rejected", status, message: blingRefusal(status, await bodyOf(response)) };
    },
    async read(ctx, request) {
      if (!isReadablePath(request.path)) return { kind: "retry", retry_at: ctx.clock.now() + 3_600_000, message: "Consulta não permitida." };
      const result = await call(ctx, "GET", address(request.path, request.query), null, request.deadline);
      if ("error" in result) return result.error === "token" ? { kind: "auth", status: 401, message: result.message ?? AUTH_TEXT[401] }
        : { kind: "retry", retry_at: ctx.clock.now() + 60_000, message: "O Bling não respondeu a tempo à conferência." };
      const { response } = result, status = response.status;
      if (status === 200) {
        const data = await bodyOf(response);
        return data === null ? { kind: "retry", retry_at: ctx.clock.now() + 60_000, message: "A resposta da conferência veio vazia." } : { kind: "ok", data };
      }
      void response.body?.cancel().catch(() => {});
      if (status === 404) return { kind: "missing" };
      if (status === 429) return { kind: "rate", retry_at: retryAfter(response.headers.get("retry-after"), ctx.clock.now()) };
      if (status === 401 || status === 403) return { kind: "auth", status, message: AUTH_TEXT[status] };
      return { kind: "retry", retry_at: ctx.clock.now() + 60_000, message: "O Bling não respondeu à conferência." };
    },
  };
}
