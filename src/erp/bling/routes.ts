/** Contrato HTTP pronto para a montagem final. Não registra rotas nem catálogo. */
import { BlingError, type BlingContext, type BlingOperationName } from "./contracts.ts";
import type { BlingApiPort } from "./ports.ts";
import { BLING_MODULE_CONTRACT, BLING_OPERATIONS, parseBlingOperationInput, xmlDownloadSchema } from "./schema.ts";
import { assertBlingIdentity, sanitizeBlingError } from "./permissions.ts";

/** Uma única fonte de nomes, métodos, efeitos, sensibilidade e schemas. */
export { BLING_OPERATIONS, BLING_MODULE_CONTRACT } from "./schema.ts";
export const BLING_OPERATION_DESCRIPTORS = BLING_OPERATIONS;
export const BLING_OPENAPI = BLING_MODULE_CONTRACT.openapi;

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function blingApiFailureResponse(error: unknown): Response {
  const failure = sanitizeBlingError(error);
  const headers = new Headers(privateHeaders);
  // retry_at permanece em milissegundos absolutos; evita inventar um relógio
  // de parede para calcular Retry-After nesta fronteira.
  return Response.json({ error: failure.toJSON() }, { status: failure.status, headers });
}

export function matchPublicBlingRoute(method: string, pathname: string, profile: string): {
  name: BlingOperationName; params: Record<string, string>;
} | null {
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/erp/v1/receber-bling`;
  if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return null;
  const relative = pathname.slice(prefix.length) || "/";
  for (const operation of Object.values(BLING_OPERATIONS)) {
    if (operation.name === "erp_bling_oauth_callback" || operation.method !== method) continue;
    const keys: string[] = [];
    const segments = operation.path.split("/").map(segment => {
      if (segment.startsWith(":")) { keys.push(segment.slice(1)); return "([^/]+)"; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    const match = new RegExp(`^${segments.join("/")}${operation.path === "/" ? "" : "/?"}$`).exec(relative);
    if (!match) continue;
    try {
      const params = Object.fromEntries(keys.map((key, index) => [key === "objectId" ? "object_id" : key, decodeURIComponent(match[index + 1])]));
      if (Object.values(params).some(value => /[/\\\u0000-\u001f]/.test(value))) throw new BlingError("BLING_RESPONSE_INVALID");
      return { name: operation.name, params };
    } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
  }
  return null;
}

function queryInput(url: URL, params: Record<string, string>): Record<string, unknown> {
  const input: Record<string, unknown> = Object.assign(Object.create(null), params);
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 || Object.hasOwn(params, key)) throw new BlingError("BLING_RESPONSE_INVALID");
    input[key] = value;
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "string" || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(input.limit)) throw new BlingError("BLING_RESPONSE_INVALID");
    input.limit = Number(input.limit);
  }
  if (input.deleted !== undefined) {
    if (input.deleted !== "true" && input.deleted !== "false") throw new BlingError("BLING_RESPONSE_INVALID");
    input.deleted = input.deleted === "true";
  }
  return input;
}

/** ctx é produzido pela autenticação do núcleo, nunca por body ou headers do
 * navegador. A API revalida concessões persistidas antes de tocar nas portas.
 */
export async function handlePublicBlingRequest(request: Request, ctx: BlingContext, api: BlingApiPort): Promise<Response> {
  try {
    assertBlingIdentity(ctx);
    const url = new URL(request.url);
    const route = matchPublicBlingRoute(request.method, url.pathname, ctx.profile);
    if (!route) return new Response(null, { status: 404, headers: privateHeaders });
    let raw: unknown;
    if (request.method === "GET") raw = queryInput(url, route.params);
    else {
      if (url.search) throw new BlingError("BLING_RESPONSE_INVALID");
      const text = await request.text();
      if (text.length > 262144) throw new BlingError("BLING_RESPONSE_INVALID");
      try { raw = JSON.parse(text); } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
    }
    const validated = parseBlingOperationInput(route.name, raw);
    // Preserva a ordem do envelope comprovado pelo núcleo no hash do comando;
    // o schema valida, mas não substitui esse envelope antes da API.
    const input = raw as typeof validated;
    const cookies: string[] = [];
    const context: BlingContext = { ...ctx, response: { setCookie(cookie) {
      if (route.name !== "erp_bling_oauth_start" || cookies.length || !/^__Host-[A-Za-z0-9_-]{1,100}$/.test(cookie.name) ||
          !/^[A-Za-z0-9_.-]{1,4096}$/.test(cookie.value) || !Number.isSafeInteger(cookie.max_age) || cookie.max_age < 0 || cookie.max_age > 600) {
        throw new BlingError("BLING_RESPONSE_INVALID");
      }
      cookies.push(`${cookie.name}=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie.max_age}`);
    } } };
    const result = await api.execute(context, route.name, input);
    assertBlingIdentity(context);
    const parsed = BLING_OPERATIONS[route.name].output.safeParse(result);
    if (!parsed.success) throw new BlingError("BLING_RESPONSE_INVALID", { status: 503 });
    const headers = new Headers(privateHeaders);
    if (route.name === "erp_bling_xml_get") {
      const xml = xmlDownloadSchema.parse(parsed.data);
      headers.set("Content-Type", xml.content_type);
      headers.set("Content-Disposition", `attachment; filename="${xml.filename}"`);
      headers.set("X-Content-SHA256", xml.sha256);
      return new Response(new Uint8Array(xml.bytes).buffer, { headers });
    }
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return Response.json(parsed.data, { headers });
  } catch (error) { return blingApiFailureResponse(error); }
}

/** callback_url/cookie_name vêm da instalação confiável e da porta OAuth.
 * A URL recebida, Host e parâmetros nunca escolhem o endereço de retorno.
 */
export async function handlePublicBlingCallback(
  request: Request, ctx: BlingContext, api: BlingApiPort,
  options: { callback_url: string; cookie_name: `__Host-${string}`; redirect_path?: string },
): Promise<Response> {
  try {
    assertBlingIdentity(ctx);
    const url = new URL(request.url), trusted = new URL(options.callback_url);
    if (request.method !== "GET" || trusted.protocol !== "https:" || trusted.username || trusted.password || trusted.search || trusted.hash ||
        trusted.pathname !== `/api/public/erp-bling/${encodeURIComponent(ctx.profile)}/callback` ||
        url.origin !== trusted.origin || url.pathname !== trusted.pathname ||
        !/^__Host-[A-Za-z0-9_-]{1,100}$/.test(options.cookie_name)) throw new BlingError("BLING_AUTH_REQUIRED");
    const query = queryInput(url, {});
    if (Object.keys(query).some(key => !["state", "code", "error"].includes(key))) throw new BlingError("BLING_RESPONSE_INVALID");
    const matches = (request.headers.get("Cookie") ?? "").split(";").map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(options.cookie_name + "="));
    if (matches.length !== 1) throw new BlingError("BLING_AUTH_REQUIRED");
    const browserNonce = matches[0].slice(options.cookie_name.length + 1);
    if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(browserNonce)) throw new BlingError("BLING_AUTH_REQUIRED");
    const input = parseBlingOperationInput("erp_bling_oauth_callback", { ...query, browser_nonce: browserNonce, callback_url: trusted.href });
    const result = await api.callback(ctx, input);
    assertBlingIdentity(ctx);
    const parsed = BLING_OPERATIONS.erp_bling_oauth_callback.output.safeParse(result);
    if (!parsed.success || parsed.data.redirect !== (options.redirect_path ?? "/receber-bling")) throw new BlingError("BLING_RESPONSE_INVALID", { status: 503 });
    return new Response(null, { status: 302, headers: { ...privateHeaders, Location: parsed.data.redirect,
      "Set-Cookie": `${options.cookie_name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` } });
  } catch (error) { return blingApiFailureResponse(error); }
}
