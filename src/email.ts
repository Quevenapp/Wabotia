// Envio de e-mail pelo Cloudflare Email Sending, pela API REST (não pelo
// binding: a instalação não precisa republicar o Worker para ligar). Guia de
// configuração em docs/EMAIL.md.
//
// - Configuração em Gestão → Sistema: Account ID, token (guardado cifrado),
//   endereço e nome do remetente. Sem ela, o e-mail fica indisponível e os
//   links do administrador continuam valendo.
// - Nenhum segredo no assunto: links de uso único vão no corpo, com o código
//   no fragmento da URL (src/install-links.ts).
// - Cada envio fica em email_log, com o endereço mascarado e o hash, sem o
//   corpo. `key` torna o envio idempotente na área.
import { all, batch, exec, one } from "./db";
import { ApiError, type Actor, type Env, now, uid } from "./types";
import { admin, safeFetch, secret, setSecret, sha } from "./security";
import type { TranscriptEmailSettings, TranscriptSendResult } from "./channel-contracts";
import type { ChannelConnection } from "./channel-contracts";
import type { ChannelDeliveryResult } from "./channel-c2-contracts";

const CONFIG_ID = "email:config";
const API = "https://api.cloudflare.com/client/v4";
/** Limite diário de e-mails de módulos por área (ctx.sendEmail). */
export const EMAIL_AREA_DAILY = 200;
export const TRANSCRIPT_ACTOR_DAILY = 10;
export const TRANSCRIPT_AREA_DAILY = 50;

export interface EmailConfig {
  account_id?: string;
  token?: string;
  from_address?: string;
  from_name?: string;
  transcript_custom_enabled?: boolean;
  transcript_allowed_domains?: string[];
  updated?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Fachada exclusiva da outbox do canal. Módulos e transcrição não a utilizam. */
export interface ChannelEmailMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: readonly string[];
  automatic?: boolean;
  attachments?: readonly { name: string; mimeType: string; bytes: Uint8Array }[];
}
export interface ChannelEmailTransport {
  /** Campos REST de anexos/cabeçalhos: formato do plano; a conferir com a conta real.
   * Sem confirmação do contrato, deve devolver provider_contract_unverified antes da rede. */
  prepare(message: ChannelEmailMessage & { from: string }): Promise<{
    body: Readonly<Record<string, unknown>>;
    /** Mensagem efetivamente codificada, incluindo cabeçalhos e anexos. */
    encodedMessage: Uint8Array;
  }>;
  read(response: Response): Promise<ChannelDeliveryResult>;
}
let channelEmailTransport: ChannelEmailTransport | null = null;
export function registerChannelEmailTransport(transport: ChannelEmailTransport): void {
  if (channelEmailTransport && channelEmailTransport !== transport) throw new Error("Transporte de e-mail já registrado.");
  channelEmailTransport = transport;
}
const channelMessageId = (value: string) => value.length <= 998 && /^<[^<>\s\u0000-\u001f\u007f]+@[^<>\s\u0000-\u001f\u007f]+>$/.test(value);
export async function sendChannelEmail(env: Env, connection: ChannelConnection, input: ChannelEmailMessage,
  beforeFetch: () => Promise<void>, adapter?: ChannelEmailTransport): Promise<ChannelDeliveryResult> {
  // Stub não lê cofre, D1 nem R2.
  const transport = adapter ?? channelEmailTransport;
  if (!transport) throw new ApiError(503, "channel_not_ready", "O envio do canal de e-mail ainda não está disponível.");
  if (connection.channel !== "email" || connection.kind !== "email") throw new ApiError(400, "invalid_channel", "Conexão de e-mail obrigatória.");
  let config: Record<string, unknown>;
  try { config = JSON.parse(connection.config) as Record<string, unknown>; }
  catch { throw new ApiError(400, "invalid_request", "Configuração do canal inválida."); }
  const from = normalizeEmailAddress(config.address);
  const to = normalizeEmailAddress(input.to);
  if (typeof input.subject !== "string" || input.subject.length > 200 || /[\r\n\u0000]/.test(input.subject))
    throw new ApiError(400, "subject_invalid", "O assunto aceita até 200 caracteres, sem quebras de linha.");
  if (typeof input.text !== "string" || input.text.length > 50_000 || (!input.text.trim() && !input.attachments?.length))
    throw new ApiError(400, "invalid_request", "Informe texto de até 50.000 caracteres.");
  const references = input.references ?? [];
  const ids = [input.messageId, ...(input.inReplyTo ? [input.inReplyTo] : []), ...references];
  if (references.length > 50 || !ids.every(value => typeof value === "string" && channelMessageId(value)) ||
      new TextEncoder().encode(ids.join("\r\n")).byteLength > 8192)
    throw new ApiError(400, "invalid_request", "Cabeçalhos de encadeamento inválidos.");
  if ((input.attachments?.length ?? 0) > 32 || input.attachments?.some(attachment =>
    !attachment.name || attachment.name.length > 200 || /[\r\n\u0000/\\]/.test(attachment.name) ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType) || !(attachment.bytes instanceof Uint8Array)))
    throw new ApiError(400, "unsupported_content", "Anexo inválido.");
  const prepared = await transport.prepare({ ...input, to, from, references });
  const body = JSON.stringify(prepared.body);
  const maxBytes = 26_214_400;
  if (!(prepared.encodedMessage instanceof Uint8Array) || prepared.encodedMessage.byteLength > maxBytes ||
      new TextEncoder().encode(body).byteLength > maxBytes)
    throw new ApiError(413, "attachment_too_large", "O e-mail codificado excede 25 MiB.");
  const cfg = await emailConfig(env);
  if (!configured(cfg)) throw new ApiError(409, "email_unavailable", "Configure o envio de e-mail do Sistema.");
  await beforeFetch();
  try {
    const response = await emailProviderRequest(cfg, body);
    return await transport.read(response);
  } catch {
    return { kind: "unknown", code: "provider_unknown" };
  }
}

export interface EmailMeta {
  /** Finalidade (account.reset, account.invite, test, billing…). */
  purpose: string;
  profileId?: string | null;
  moduleId?: string | null;
  userId?: string | null;
  /** Idempotência na área: o mesmo `key` não sai duas vezes. */
  key?: string | null;
}

export type EmailStatus = "sent" | "queued" | "bounced";

const emailShape = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const validEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && emailShape.test(value);

/** Domínio exato, inclusive a forma ASCII de domínios internacionais. */
export function normalizeEmailDomain(value: unknown): string {
  if (typeof value !== "string")
    throw new ApiError(400, "invalid_request", "Informe domínios de e-mail válidos.");
  const domain = value.trim().toLowerCase();
  if (!domain || /[\s/@:#?%\\]/.test(domain))
    throw new ApiError(400, "invalid_request", "Informe domínios de e-mail válidos, sem endereço ou caminho.");
  let host: string;
  try {
    host = new URL(`https://${domain}`).hostname;
  } catch {
    throw new ApiError(400, "invalid_request", "Domínio de e-mail inválido.");
  }
  if (host.length > 253 || !host.includes(".") || host.endsWith(".") ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new ApiError(400, "invalid_request", "Domínio de e-mail inválido.");
  return host;
}

export function normalizeEmailAddress(value: unknown): string {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!validEmail(address))
    throw new ApiError(400, "invalid_request", "E-mail do destinatário inválido.");
  const at = address.lastIndexOf("@");
  const normalized = `${address.slice(0, at)}@${normalizeEmailDomain(address.slice(at + 1))}`;
  if (!validEmail(normalized))
    throw new ApiError(400, "invalid_request", "E-mail do destinatário inválido.");
  return normalized;
}

function transcriptSettings(cfg: EmailConfig): TranscriptEmailSettings {
  return {
    transcript_custom_enabled: cfg.transcript_custom_enabled === true,
    transcript_allowed_domains: cfg.transcript_allowed_domains ?? [],
  };
}

/** Projeção sem credencial, usada pelas opções e pela prévia. */
export async function getTranscriptEmailConfig(env: Env) {
  const cfg = await emailConfig(env);
  return { configured: configured(cfg), ...transcriptSettings(cfg) };
}

export function assertTranscriptRecipient(cfg: TranscriptEmailSettings, value: unknown): string {
  const address = normalizeEmailAddress(value);
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (cfg.transcript_allowed_domains.length && !cfg.transcript_allowed_domains.includes(domain))
    throw new ApiError(403, "email_domain_not_allowed", "O domínio do destinatário não está autorizado para transcrições.");
  return address;
}

export async function emailConfig(env: Env): Promise<EmailConfig> {
  return (await secret(env, CONFIG_ID)) as EmailConfig;
}

export const configured = (cfg: EmailConfig) =>
  !!(cfg.account_id && cfg.token && cfg.from_address);

/** O e-mail está configurado (esqueci a senha, convites e alertas). */
export async function emailReady(env: Env) {
  try {
    return configured(await emailConfig(env));
  } catch {
    // Sem MASTER_KEY, nada a decifrar: sem e-mail.
    return false;
  }
}

export function publicEmailConfig(cfg: EmailConfig) {
  return {
    configured: configured(cfg),
    account_id: cfg.account_id || "",
    token_configured: !!cfg.token,
    from_address: cfg.from_address || "",
    from_name: cfg.from_name || "",
    ...transcriptSettings(cfg),
    updated: cfg.updated || 0,
  };
}

/** system.email.configure: grava (ou, com `remove`, apaga) a configuração. */
export async function configureEmail(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (data?.remove === true) {
    await exec(env, "DELETE FROM secrets WHERE id=?", CONFIG_ID);
    return publicEmailConfig({});
  }
  const accountId = String(data?.account_id || "").trim();
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new ApiError(
      400,
      "invalid_request",
      "Informe o Account ID da Cloudflare (32 caracteres).",
    );
  const from = String(data?.from_address || "")
    .trim()
    .toLowerCase();
  if (!validEmail(from))
    throw new ApiError(
      400,
      "invalid_request",
      "Informe o endereço do remetente, no domínio cadastrado na Cloudflare.",
    );
  const name = String(data?.from_name ?? "").trim();
  if (name.length > 80 || /[\r\n<>"]/.test(name))
    throw new ApiError(
      400,
      "invalid_request",
      "Use um nome de remetente com até 80 caracteres, sem aspas nem < >.",
    );
  const old = await emailConfig(env);
  if (data?.transcript_custom_enabled !== undefined && typeof data.transcript_custom_enabled !== "boolean")
    throw new ApiError(400, "invalid_request", "A opção de endereço digitado deve ser verdadeira ou falsa.");
  let domains = old.transcript_allowed_domains ?? [];
  if (data?.transcript_allowed_domains !== undefined) {
    if (!Array.isArray(data.transcript_allowed_domains) || data.transcript_allowed_domains.length > 100)
      throw new ApiError(400, "invalid_request", "Informe uma lista com até 100 domínios permitidos.");
    domains = [...new Set<string>(data.transcript_allowed_domains.map(normalizeEmailDomain))].sort();
  }
  // Token vazio mantém o atual, se a conta for a mesma.
  const token =
    data?.token || (old.account_id === accountId ? old.token || "" : "");
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 1024 ||
    /\s/.test(token)
  )
    throw new ApiError(
      400,
      "invalid_request",
      "Informe um token de API da Cloudflare com permissão de envio de e-mail.",
    );
  const cfg: EmailConfig = {
    account_id: accountId,
    token,
    from_address: from,
    from_name: name,
    transcript_custom_enabled: data?.transcript_custom_enabled ?? old.transcript_custom_enabled ?? false,
    transcript_allowed_domains: domains,
    updated: now(),
  };
  await setSecret(env, CONFIG_ID, cfg);
  return publicEmailConfig(cfg);
}

/** Endereço mascarado para o registro: "an***@exemplo.com". */
export function maskEmail(address: string) {
  const [user, domain] = address.split("@");
  return `${user.slice(0, Math.min(2, user.length - 1))}***@${domain}`;
}

/**
 * Assunto sem segredo: sem quebra de linha, sem endereço de link e sem
 * sequência longa que pareça um código (link, token, senha).
 */
export function assertSafeSubject(subject: string) {
  if (
    !subject.trim() ||
    subject.length > 200 ||
    /[\r\n]/.test(subject) ||
    /[a-z][a-z0-9+.-]*:\/\//i.test(subject) ||
    /#(reset|invite|setup)=/i.test(subject) ||
    /[A-Za-z0-9_-]{24,}/.test(subject)
  )
    throw new ApiError(
      400,
      "invalid_subject",
      "Assunto inválido: até 200 caracteres, sem links nem códigos.",
    );
}

/** Erros da API de envio da Cloudflare (docs/EMAIL.md, "Problemas"). */
const PROVIDER_ERRORS: Record<number, [number, string, string]> = {
  10105: [
    409,
    "email_not_entitled",
    "A conta Cloudflare não tem o envio de e-mail liberado. Ele exige o plano Workers Paid (docs/EMAIL.md).",
  ],
  10203: [
    409,
    "email_sending_disabled",
    "O envio de e-mail está desligado para este domínio na Cloudflare. Confira o domínio em Email Sending (docs/EMAIL.md).",
  ],
  10207: [
    409,
    "email_account_suspended",
    "A Cloudflare suspendeu o envio de e-mail desta conta. Veja o aviso no painel da Cloudflare.",
  ],
  10101: [
    502,
    "email_unauthorized",
    "A Cloudflare recusou o token. Crie um token com a permissão de envio de e-mail (docs/EMAIL.md).",
  ],
  10102: [
    502,
    "email_unauthorized",
    "O token não tem permissão de envio de e-mail nesta conta (docs/EMAIL.md).",
  ],
  10103: [
    502,
    "email_unauthorized",
    "Use um token de API (não a chave global) com a permissão de envio de e-mail.",
  ],
  10004: [
    429,
    "email_throttled",
    "A Cloudflare limitou os envios por agora. Tente de novo em alguns minutos.",
  ],
  10001: [400, "email_invalid", "A Cloudflare recusou a mensagem."],
  10200: [400, "email_invalid", "A mensagem passou do tamanho permitido."],
  10202: [
    400,
    "email_invalid",
    "A Cloudflare recusou o remetente ou o destinatário. Confira o endereço do remetente no domínio cadastrado.",
  ],
};

class ProviderError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly providerCode: string,
    readonly indeterminate = false,
  ) {
    super(status, code, message);
  }
}

/** Transporte comum, mantendo o contrato de módulos e transcrição. */
function emailProviderRequest(cfg: EmailConfig, body: string): Promise<Response> {
  return safeFetch(`${API}/accounts/${cfg.account_id}/email/sending/send`, {
    method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body,
  });
}

async function deliver(
  cfg: EmailConfig,
  msg: EmailMessage,
  strict = false,
): Promise<EmailStatus> {
  let response: Response;
  try {
    response = await emailProviderRequest(cfg, JSON.stringify({
          to: msg.to,
          from: cfg.from_name
            ? { address: cfg.from_address, name: cfg.from_name }
            : cfg.from_address,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ProviderError(
      502,
      "email_failed",
      "Não foi possível falar com a Cloudflare para enviar o e-mail.",
      "network",
      true,
    );
  }
  const body: any = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const code = Number(body?.errors?.[0]?.code) || 0;
    const known = PROVIDER_ERRORS[code];
    throw new ProviderError(
      known?.[0] ?? 502,
      known?.[1] ?? "email_failed",
      known?.[2] ??
        `A Cloudflare não enviou o e-mail (HTTP ${response.status}).`,
      String(code || response.status),
      strict && (response.status >= 500 || !body || (response.ok && body?.success !== false)),
    );
  }
  // Leitor único do retorno: delivered/queued e eventual ID de mensagem são
  // a conferir com a conta real. Transcrição sem confirmação fica indeterminada;
  // provider_message_id permanece vazio até haver um campo documentado.
  const result = body.result ?? body;
  const has = (list: unknown) =>
    Array.isArray(list) &&
    list.some((item) => String(item).toLowerCase() === msg.to);
  if (has(result.permanent_bounces)) return "bounced";
  if (has(result.queued)) return "queued";
  if (strict && !has(result.delivered))
    throw new ProviderError(502, "email_unknown", "O provedor não confirmou o resultado do envio. Confira antes de enviar novamente.", "unconfirmed", true);
  return "sent";
}

/**
 * Envia um e-mail e registra em email_log. Sem configuração, 409
 * email_unavailable. Com `key` já usada na área, devolve o envio anterior
 * sem mandar de novo.
 */
export async function sendEmail(
  env: Env,
  msg: EmailMessage,
  meta: EmailMeta,
): Promise<{ id: string; status: EmailStatus | string; repeated?: true }> {
  const to = String(msg.to || "")
    .trim()
    .toLowerCase();
  if (!validEmail(to))
    throw new ApiError(
      400,
      "invalid_request",
      "E-mail do destinatário inválido.",
    );
  assertSafeSubject(msg.subject);
  if (
    typeof msg.text !== "string" ||
    !msg.text.trim() ||
    msg.text.length > 50000
  )
    throw new ApiError(400, "invalid_request", "Informe o texto do e-mail.");
  if (
    msg.html !== undefined &&
    (typeof msg.html !== "string" || msg.html.length > 200000)
  )
    throw new ApiError(400, "invalid_request", "HTML do e-mail inválido.");
  const cfg = await emailConfig(env);
  if (!configured(cfg))
    throw new ApiError(
      409,
      "email_unavailable",
      "O envio de e-mail não está configurado nesta instalação (Gestão → Sistema).",
    );
  const id = uid();
  const inserted = await exec(
    env,
    "INSERT OR IGNORE INTO email_log(id,profile_id,module_id,user_id,purpose,to_masked,to_hash,status,key,created) VALUES(?,?,?,?,?,?,?,'sending',?,?)",
    id,
    meta.profileId ?? null,
    meta.moduleId ?? null,
    meta.userId ?? null,
    meta.purpose,
    maskEmail(to),
    await sha(to),
    meta.key ?? null,
    now(),
  );
  if (!inserted.meta?.changes) {
    const previous = await one(
      env,
      "SELECT id,status FROM email_log WHERE profile_id IS ? AND key=?",
      meta.profileId ?? null,
      meta.key,
    );
    return { id: previous.id, status: previous.status, repeated: true };
  }
  try {
    const status = await deliver(cfg, { ...msg, to });
    await exec(env, "UPDATE email_log SET status=? WHERE id=?", status, id);
    return { id, status };
  } catch (e) {
    await exec(
      env,
      "UPDATE email_log SET status='failed',error_code=? WHERE id=?",
      e instanceof ProviderError ? e.providerCode : "error",
      id,
    );
    throw e;
  }
}

export interface ConversationEmailInput extends EmailMessage {
  profileId: string;
  actorId: string;
  conversationId: string;
  /** Chave HTTP original; o registro usa uma chave composta, sem expô-la. */
  key: string;
  /** SHA-256 da seleção e do conteúdo aprovado, calculado pelo handler. */
  requestHash: string;
}

type ConversationEmailReplayInput = Pick<ConversationEmailInput, "profileId" | "actorId" | "key" | "requestHash">;

async function conversationEmailKey(input: ConversationEmailReplayInput) {
  if (typeof input.key !== "string" || !input.key || input.key.length > 200 || !/^[\x21-\x7e]+$/.test(input.key))
    throw new ApiError(400, "invalid_request", "Envie Idempotency-Key (até 200 caracteres ASCII).");
  if (!/^[a-f0-9]{64}$/.test(input.requestHash))
    throw new ApiError(400, "invalid_request", "A transcrição precisa de uma prévia válida.");
  const digest = await sha(JSON.stringify([input.profileId, input.actorId, input.key]));
  return { id: `email:${digest}`, key: `conversation.email:${digest}` };
}

/** Apenas leitura. O handler deve reautorizar ator, conversa e destinatário antes. */
export async function conversationEmailReplay(
  env: Env,
  input: ConversationEmailReplayInput,
): Promise<TranscriptSendResult | null> {
  const { key } = await conversationEmailKey(input);
  const previous = await one<{
    id: string; status: TranscriptSendResult["status"]; to_masked: string; request_hash: string;
  }>(env, "SELECT id,status,to_masked,request_hash FROM email_log WHERE profile_id=? AND key=?", input.profileId, key);
  if (!previous) return null;
  if (previous.request_hash !== input.requestHash)
    throw new ApiError(409, "idempotency_conflict", "Esta chave já foi usada com outra transcrição ou destinatário.");
  return { id: previous.id, status: previous.status, to_masked: previous.to_masked, duplicate: true };
}

const TRANSCRIPT_PURPOSE = "conversation.email";
const transcriptStatusText: Record<TranscriptSendResult["status"], string> = {
  reserved: "reserva registrada",
  sending: "envio em andamento",
  queued: "aceita na fila do provedor",
  sent: "envio confirmado pelo provedor",
  failed: "envio recusado pelo provedor",
  unknown: "resultado indeterminado; confira com a equipe antes de enviar novamente",
};
const transcriptNote = (to: string, status: TranscriptSendResult["status"]) =>
  `Transcrição por e-mail para ${to}: ${transcriptStatusText[status]}.`;

/**
 * Fronteira de envio da transcrição: o handler reautoriza e aprova o conteúdo
 * antes de chamar. Uma única instrução reserva o registro e ambas as cotas;
 * notas/auditoria ficam na mesma transação. Nada repete a chamada ao provedor.
 */
export async function sendConversationEmail(
  env: Env,
  input: ConversationEmailInput,
): Promise<TranscriptSendResult> {
  const { id, key } = await conversationEmailKey(input);
  assertSafeSubject(input.subject);
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 50000 ||
    (input.html !== undefined && (typeof input.html !== "string" || input.html.length > 200000)))
    throw new ApiError(400, "transcript_too_large", "A transcrição excede o limite. Escolha um intervalo menor.");
  const cfg = await emailConfig(env);
  if (!configured(cfg))
    throw new ApiError(409, "email_unavailable", "Configure o envio em Gestão → Sistema → E-mail.");
  const to = assertTranscriptRecipient(transcriptSettings(cfg), input.to);
  const toMasked = maskEmail(to);
  const noteId = `${id}:note`;
  const at = now();
  // O estado inicial já é indeterminado: se a execução cair depois da reserva,
  // uma repetição nunca confunde a falta de confirmação com permissão de enviar.
  const result = await batch(env, [
    [
      `INSERT OR IGNORE INTO email_log(id,profile_id,module_id,user_id,purpose,to_masked,to_hash,status,error_code,key,created,conversation_id,request_hash)
       SELECT ?,?,NULL,?,?,?,?,'unknown','delivery_unconfirmed',?,?,?,?
       WHERE (SELECT count(*) FROM email_log WHERE profile_id=? AND purpose=? AND created>? AND user_id=?)<?
         AND (SELECT count(*) FROM email_log WHERE profile_id=? AND purpose=? AND created>?)<?`,
      [id, input.profileId, input.actorId, TRANSCRIPT_PURPOSE, toMasked, await sha(to), key, at,
        input.conversationId, input.requestHash,
        input.profileId, TRANSCRIPT_PURPOSE, at - 86400000, input.actorId, TRANSCRIPT_ACTOR_DAILY,
        input.profileId, TRANSCRIPT_PURPOSE, at - 86400000, TRANSCRIPT_AREA_DAILY],
    ],
    [
      `INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created,content)
       SELECT ?,e.profile_id,e.conversation_id,'note',e.user_id,?,'[]',e.created,json_object('emailLogId',e.id)
       FROM email_log e JOIN conversations c ON c.id=e.conversation_id AND c.profile_id=e.profile_id
       WHERE e.id=? AND e.request_hash=?`,
      [noteId, transcriptNote(toMasked, "unknown"), id, input.requestHash],
    ],
    [
      `INSERT INTO audit(profile_id,actor,operation,resource_id,request_id,created)
       SELECT e.profile_id,e.user_id,?,e.conversation_id,e.id,e.created FROM email_log e
       WHERE e.id=? AND e.request_hash=? AND NOT EXISTS (
         SELECT 1 FROM audit a WHERE a.profile_id=e.profile_id AND a.operation=? AND a.request_id=e.id
       )`,
      [TRANSCRIPT_PURPOSE, id, input.requestHash, TRANSCRIPT_PURPOSE],
    ],
  ]);
  if (!result[0].meta?.changes) {
    const previous = await conversationEmailReplay(env, input);
    if (!previous)
      throw new ApiError(429, "email_limit", "Limite de transcrições atingido: 10 por pessoa ou aplicação e 50 por área em 24 horas.");
    return previous;
  }

  let status: TranscriptSendResult["status"];
  let errorCode: string | null = null;
  try {
    const delivered = await deliver(cfg, { to, subject: input.subject, text: input.text, html: input.html }, true);
    status = delivered === "bounced" ? "failed" : delivered;
    if (delivered === "bounced") errorCode = "bounced";
  } catch (error) {
    const definite = error instanceof ProviderError && !error.indeterminate;
    status = definite ? "failed" : "unknown";
    errorCode = error instanceof ProviderError ? error.providerCode : "delivery_unconfirmed";
  }
  try {
    await batch(env, [
      ["UPDATE email_log SET status=?,error_code=? WHERE id=? AND status='unknown'", [status, errorCode, id]],
      ["UPDATE messages SET text=? WHERE id=? AND profile_id=? AND direction='note'", [transcriptNote(toMasked, status), noteId, input.profileId]],
    ]);
  } catch {
    // O provedor pode ter recebido. Não repetir nem transformar em falha segura.
    return { id, status: "unknown", to_masked: toMasked, duplicate: false };
  }
  return { id, status, to_masked: toMasked, duplicate: false };
}

/** Envios de módulos na área nas últimas 24 h (limite EMAIL_AREA_DAILY). */
export async function areaEmailCount(env: Env, profileId: string) {
  // Registros legados podem não ter module_id. Nesses casos, só as finalidades
  // de avisos já reconhecidas pelos módulos entram no teto. Transcrições e
  // e-mails de conta continuam fora, sem reclassificar nem regravar o histórico.
  return (
    await one(
      env,
      `SELECT count(*) n FROM email_log WHERE profile_id=? AND created>?
       AND (module_id IS NOT NULL OR (
         module_id IS NULL AND purpose IN ('billing','scheduling','order','booking')
       ))`,
      profileId,
      now() - 86400000,
    )
  ).n as number;
}

/** Últimos envios (Gestão → Sistema), sem corpo e com o endereço mascarado. */
export async function emailLog(env: Env, limit = 50) {
  return all(
    env,
    "SELECT id,profile_id,module_id,user_id,conversation_id,purpose,to_masked,status,error_code,provider_message_id,created FROM email_log ORDER BY created DESC LIMIT ?",
    Math.min(200, Math.max(1, limit)),
  );
}

// ---- Mensagens da conta ----------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

const brasilia = (at: number) =>
  new Date(at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });

export type AccountEmailKind =
  "reset" | "invite" | "password_changed" | "mfa_reset" | "test";

/**
 * Texto dos e-mails da conta. O assunto nunca leva o link nem o código; o
 * link vai no corpo, com o código no fragmento.
 */
export function accountEmail(
  kind: AccountEmailKind,
  input: { name?: string; url?: string; expiresAt?: number; at?: number },
): Omit<EmailMessage, "to"> {
  const hello = `Olá${input.name ? ", " + input.name : ""}.`;
  const until = input.expiresAt ? brasilia(input.expiresAt) : "";
  const when = brasilia(input.at ?? now());
  const content: Record<AccountEmailKind, [string, string[], string?]> = {
    reset: [
      "Redefinir sua senha do Wabotia",
      [
        hello,
        "Recebemos um pedido para redefinir a senha da sua conta. Use o link abaixo para criar uma senha nova. Ele vale uma vez só" +
          (until ? `, até ${until}.` : "."),
        "Se não foi você, ignore este e-mail: sua senha continua a mesma.",
      ],
      "Criar senha nova",
    ],
    invite: [
      "Convite para o Wabotia",
      [
        hello,
        "Você foi convidado para a equipe de atendimento. Use o link abaixo para criar sua senha e entrar. Ele vale uma vez só" +
          (until ? `, até ${until}.` : "."),
      ],
      "Criar minha senha",
    ],
    password_changed: [
      "Sua senha do Wabotia foi trocada",
      [
        hello,
        `A senha da sua conta foi trocada em ${when} (horário de Brasília) e as sessões abertas foram encerradas.`,
        "Se não foi você, fale com o administrador da sua empresa agora.",
      ],
    ],
    mfa_reset: [
      "O segundo fator da sua conta foi removido",
      [
        hello,
        `O segundo fator (aplicativo autenticador) da sua conta foi removido em ${when} (horário de Brasília) e as sessões abertas foram encerradas. Ao entrar, cadastre-o de novo em Minha conta.`,
        "Se você não pediu isso, fale com o administrador da sua empresa agora.",
      ],
    ],
    test: [
      "Teste de e-mail do Wabotia",
      [
        hello,
        "Este é um teste do envio de e-mail da sua instalação. Se chegou, os e-mails de senha, convite e alertas da conta também vão chegar.",
      ],
    ],
  };
  const [subject, paragraphs, action] = content[kind];
  const link = action && input.url ? input.url : "";
  const text = [
    ...paragraphs,
    ...(link ? [`${action}: ${link}`] : []),
    "— Wabotia",
  ].join("\n\n");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;max-width:560px">` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    (link
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#128c7e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action!)}</a></p><p style="font-size:13px;color:#52606d">Se o botão não abrir, copie o endereço: ${escapeHtml(link)}</p>`
      : "") +
    `<p style="font-size:13px;color:#52606d">— Wabotia</p></div>`;
  return { subject, text, html };
}

/**
 * Link de convite ou de nova senha por e-mail, quando o administrador pede
 * (`send_email`). A falha não desfaz o link, que ele ainda pode copiar.
 */
export async function mailAccountLink(
  env: Env,
  user: { id: string; name?: string; email: string },
  kind: "reset" | "invite",
  link: { url: string; expires_at: number },
) {
  try {
    const sent = await sendEmail(
      env,
      {
        to: user.email,
        ...accountEmail(kind, {
          name: user.name,
          url: link.url,
          expiresAt: link.expires_at,
        }),
      },
      { purpose: `account.${kind}`, userId: user.id },
    );
    return { email_status: sent.status };
  } catch (e: any) {
    return {
      email_status: "failed",
      email_error: {
        code: e?.code || "email_failed",
        message: e?.message || "Não foi possível enviar o e-mail.",
      },
    };
  }
}

/**
 * Alerta da conta (senha trocada, segundo fator removido) sem atrapalhar a
 * ação: sem e-mail configurado ou com falha, só fica no registro.
 */
export async function alertAccount(
  env: Env,
  userId: string,
  kind: "password_changed" | "mfa_reset",
) {
  try {
    if (!(await emailReady(env))) return;
    const user = await one(
      env,
      "SELECT id,name,email FROM users WHERE id=?",
      userId,
    );
    if (!user?.email) return;
    await sendEmail(
      env,
      { to: user.email, ...accountEmail(kind, { name: user.name }) },
      { purpose: `account.${kind}`, userId },
    );
  } catch {
    // Registrado em email_log; o alerta não desfaz a ação.
  }
}
