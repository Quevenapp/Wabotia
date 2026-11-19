import { one, exec } from "./db";
import { CHANNEL_REGISTRY } from "./channels";
import { ApiError, type Env } from "./types";
import type { SocialEventScope, SocialInboundMedia } from "./channel-contracts";

export interface SocialMediaPolicy {
  exactOrigins: readonly string[];
  hostSuffixes: readonly string[];
}
/** Origens de CDN nas fixtures do anexo: a conferir com a conta real.
 * A lista nunca vem do webhook ou da configuração enviada pelo cliente.
 * Renovação não tem host/endpoint presumido: permanece desligada por padrão. */
export const SOCIAL_MEDIA_POLICY: SocialMediaPolicy = Object.freeze({
  exactOrigins: Object.freeze([]),
  hostSuffixes: Object.freeze(["fbcdn.net", "cdninstagram.com"]),
});
export interface SocialMediaRenewal {
  enabled: boolean;
  /** Um adaptador validado poderá instalar esta função. Não recebe a credencial
   * da Zernio e não deve inventar endpoint. a conferir com a conta real. */
  renew(scope: SocialEventScope, providerMediaId: string, signal: AbortSignal): Promise<string | null>;
}
export interface SocialMediaCopyOptions {
  /** Prazo compartilhado por todas as cópias, em epoch ms. */
  deadline?: number;
  fetcher?: typeof fetch;
  policy?: SocialMediaPolicy;
  renewal?: SocialMediaRenewal;
}
export const SOCIAL_MEDIA_UNAVAILABLE = "[Anexo indisponível. Solicite o reenvio ou verifique o tamanho e a conexão.]";

export function socialMediaUrl(raw: string, policy: SocialMediaPolicy = SOCIAL_MEDIA_POLICY): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(422, "unsupported_content", "Endereço de anexo inválido."); }
  const suffixAllowed = policy.hostSuffixes.some((suffix) =>
    /^[a-z0-9.-]+$/.test(suffix) && !suffix.startsWith(".") &&
    (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)));
  const credentialQuery = [...url.searchParams.keys()].some((key) => /^(authorization|access_token|api[_-]?key|password|secret)$/i.test(key));
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || credentialQuery ||
      (!policy.exactOrigins.includes(url.origin) && !suffixAllowed))
    throw new ApiError(422, "unsupported_content", "Origem de anexo não autorizada.");
  return url;
}

export async function socialMediaId(connectionId: string, messageId: string, index: number): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${connectionId}:${messageId}:${index}`));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function within<T>(task: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    // Consume late failures even if an uncancellable storage call already started.
    void task.catch(() => {});
    return Promise.reject(new ApiError(408, "unsupported_content", "Prazo de cópia do anexo encerrado."));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(408, "unsupported_content", "Prazo de cópia do anexo encerrado.")), remaining);
    task.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function download(
  media: SocialInboundMedia, source: string, scope: SocialEventScope,
  options: SocialMediaCopyOptions, deadline: number, signal: AbortSignal,
) {
  const rule = CHANNEL_REGISTRY[scope.channel].media[media.kind];
  if (!rule?.receive || !rule.maxSendBytes || !rule.mimeTypes.length)
    throw new ApiError(422, "unsupported_content", "Formato de anexo não autorizado.");
  const url = socialMediaUrl(source, options.policy);
  // In particular, never pass Zernio Authorization to Meta CDNs.
  const response = await within((options.fetcher ?? fetch)(url, { method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal }), deadline);
  if (!response.ok || !response.body) throw new ApiError(422, "unsupported_content", "Anexo indisponível.");
  const mime = (response.headers.get("Content-Type") ?? media.mimeType ?? "").split(";")[0].trim().toLowerCase();
  const declared = media.mimeType?.split(";")[0].trim().toLowerCase();
  const length = Number(response.headers.get("Content-Length") ?? 0);
  if (!rule.mimeTypes.includes(mime) || (declared && declared !== mime) || !Number.isSafeInteger(length) || length < 0 || length > rule.maxSendBytes) {
    void response.body.cancel().catch(() => {});
    throw new ApiError(422, "unsupported_content", "Formato ou tamanho de anexo não autorizado.");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await within(reader.read(), deadline);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > rule.maxSendBytes) throw new ApiError(422, "unsupported_content", "Anexo excede o limite local.");
      chunks.push(next.value);
    }
    if (!size || (length && length !== size)) throw new ApiError(422, "unsupported_content", "Anexo incompleto.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mime, size };
  } finally { void reader.cancel().catch(() => {}); }
}

/** Reutiliza cópias confirmadas. Falha de mídia nunca elimina texto/contexto.
 * Chamar somente depois da deduplicação de inbox; esta função não recebe evento. */
export async function copySocialMedia(
  env: Env, scope: SocialEventScope, messageId: string, media: readonly SocialInboundMedia[],
  options: SocialMediaCopyOptions = {},
): Promise<{ attachments: string[]; unavailable: boolean }> {
  // Mesmo um chamador com prazo maior não pode consumir os cinco segundos do webhook.
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 3000);
  const attachments: string[] = [];
  let unavailable = false;
  for (let index = 0; index < media.length; index++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      if (Date.now() >= deadline) throw new Error("deadline");
      const attachment = media[index], id = await socialMediaId(scope.connectionId, messageId, index);
      const existing = await within(one(env, "SELECT id FROM media WHERE id=? AND profile_id=?", id, scope.profileId), deadline);
      if (existing) { attachments.push(id); continue; }
      if (!attachment.sourceUrl) throw new Error("source");
      let result: Awaited<ReturnType<typeof download>>;
      try { result = await download(attachment, attachment.sourceUrl, scope, options, deadline, controller.signal); }
      catch (error) {
        if (!options.renewal?.enabled || !attachment.providerMediaId || controller.signal.aborted) throw error;
        const renewed = await within(options.renewal.renew(scope, attachment.providerMediaId, controller.signal), deadline);
        if (!renewed) throw error;
        result = await download(attachment, renewed, scope, options, deadline, controller.signal);
      }
      const objectKey = `${scope.profileId}/${id}`;
      await within(env.MEDIA.put(objectKey, result.bytes, { httpMetadata: { contentType: result.mime } }), deadline);
      await within(exec(env, "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        id, scope.profileId, (attachment.name ?? `${attachment.kind}-${messageId.slice(-10)}`).replace(/[\u0000-\u001f\u007f]/g, ""),
        result.mime, result.size, objectKey, `transport:${scope.connectionId}`, Date.now()), deadline);
      attachments.push(id);
    } catch { unavailable = true; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return { attachments, unavailable };
}
