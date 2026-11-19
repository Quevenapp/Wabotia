import { all, one } from "./db";
import { allows, requireAccess } from "./access";
import { access, hmac, sha } from "./security";
import { assertDepartmentAccess } from "./departments";
import { boundAllows, visibleConversation } from "./visibility";
import { CHANNEL_REGISTRY, conversationChannel } from "./channels";
import { ApiError, json, now, type Actor, type Conversation, type Env } from "./types";
import {
  assertTranscriptRecipient, conversationEmailReplay, getTranscriptEmailConfig, normalizeEmailAddress,
  sendConversationEmail,
} from "./email";
import type { ChannelTranscriptPort } from "./channel-ports";
import type {
  TranscriptDestination, TranscriptLimits, TranscriptOptions, TranscriptPreview,
  TranscriptPreviewRequest, TranscriptRange, TranscriptSendRequest, TranscriptSendResult,
} from "./channel-contracts";

export const TRANSCRIPT_LIMITS: TranscriptLimits = Object.freeze({
  maxMessages: 2000, maxTextChars: 50000, maxHtmlChars: 200000,
  actorPer24Hours: 10, profilePer24Hours: 50, previewTtlMs: 10 * 60 * 1000,
});
const unavailable = "Configure o envio em Gestão → Sistema → E-mail.";
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Ator autenticado pelo chamador; nenhum campo do corpo serve como prova humana. */
function authorizeActor(actor: Actor, profile: string) {
  if (actor.via || actor.module || actor.credential || actor.kind === "connector" ||
      actor.id.startsWith("bot:") || actor.scopes.includes("conversations:bound") ||
      (actor.kind === "user" && actor.role === "service"))
    fail(403, "access_denied", "Bots e execuções automáticas não podem exportar conversas.");
  access(actor, profile, "conversations:read");
  requireAccess(actor, "conversations");
  requireAccess(actor, "conversations:email");
  if (actor.expiresAt !== undefined && actor.expiresAt <= now())
    fail(401, "invalid_token", "Acesso expirado.");
}

async function authorized(env: Env, original: Actor, input: Conversation) {
  authorizeActor(original, input.profile_id);
  // Revalidar também o replay e a concessão revogada após a prévia.
  const user = original.kind === "user";
  const row = await one(env, user
    ? "SELECT id,name,role,profiles,access,email FROM users WHERE id=? AND disabled=0"
    : "SELECT id,name,profiles,scopes FROM applications WHERE id=? AND disabled=0",
  user ? original.id : original.id.replace(/^app:/, ""));
  if (!row) fail(403, "access_denied", "Acesso não está mais disponível.");
  const actor: Actor = {
    ...original, name: row.name, profiles: json(row.profiles, []),
    ...(user ? { role: row.role, access: json(row.access, null) }
      : { scopes: original.scopes.filter(s => json(row.scopes, []).includes(s)) }),
  };
  authorizeActor(actor, input.profile_id);
  if (!user && original.keyId && !await one(env,
    "SELECT 1 FROM api_keys WHERE id=? AND app_id=? AND revoked=0 AND expires>?",
    original.keyId, row.id, now())) fail(401, "invalid_token", "Chave revogada ou expirada.");
  const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", input.id, input.profile_id);
  if (!c || !visibleConversation(actor, c) || !await boundAllows(env, actor, c))
    return fail(404, "not_found", "Conversa não encontrada.");
  await assertDepartmentAccess(env, actor, c);
  const connection = c.connection_id ? await one(env,
    "SELECT id,profile_id,kind,channel,account_label,config FROM connections WHERE id=? AND profile_id=?", c.connection_id, c.profile_id) : null;
  const channel = conversationChannel(c, connection);
  const context = json(c.channel_context).context;
  const application = c.external_namespace.startsWith("app:") && !c.connection_id;
  if (c.chat_type !== "direct" || (context && context !== "direct") ||
      (!application && (!connection || connection.kind === "ai" ||
        c.external_namespace !== `channel:${connection.id}` ||
        !channel || !["whatsapp", "instagram", "facebook"].includes(channel))))
    fail(409, "transcript_unsupported", "Somente conversas externas diretas podem ser enviadas por e-mail.");
  return { actor, c, selfEmail: user ? row.email as string : null,
    channel: channel ? CHANNEL_REGISTRY[channel].label : "Aplicação",
    account: c.account_label || connection?.account_label || "" };
}
type Authorized = Awaited<ReturnType<typeof authorized>>;
type Recipient = { address: string; contactId: string | null };

async function linkedContact(env: Env, auth: Authorized) {
  const { actor, c } = auth;
  if (!allows(actor, "contacts") || (actor.kind === "app" && !actor.scopes.includes("contacts:read"))) return null;
  // Vínculo cadastral explícito ou prova telefônica vigente; nunca procurar por nome/foto.
  return one<{ id: string; name: string; email: string }>(env,
    `SELECT k.id,k.name,k.email FROM conversations v
     LEFT JOIN conversation_contacts l ON l.conversation_id=v.id AND l.profile_id=v.profile_id
     LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace=CASE WHEN v.external_namespace LIKE 'app:%' THEN v.external_namespace ELSE 'team' END
       AND p.phone=v.verified_phone AND p.state='ready' AND v.customer_link_state='ready'
     JOIN contacts k ON k.id=coalesce(l.contact_id,p.contact_id) AND k.profile_id=v.profile_id
     WHERE v.id=? AND v.profile_id=? AND k.identity_state='active' AND k.merged_into IS NULL
       AND (?=1 OR k.namespace=?)`, c.id, c.profile_id, actor.kind === "user" ? 1 : 0, `app:${actor.id}`);
}

async function recipient(env: Env, auth: Authorized, destination: TranscriptDestination): Promise<Recipient> {
  const config = await getTranscriptEmailConfig(env);
  if (!config.configured) return fail(409, "email_unavailable", unavailable);
  let address: string;
  let contactId: string | null = null;
  if (destination.kind === "self") {
    if (!auth.selfEmail) return fail(403, "access_denied", "Aplicações não têm o destino Meu e-mail.");
    address = auth.selfEmail;
  } else if (destination.kind === "contact") {
    const contact = await linkedContact(env, auth);
    if (!contact?.email) return fail(409, "recipient_unavailable", "Contato sem e-mail cadastrado disponível.");
    address = contact.email;
    contactId = contact.id;
  } else {
    if (!config.transcript_custom_enabled) return fail(403, "custom_recipient_disabled", "O envio para endereço digitado está desligado.");
    address = destination.address;
  }
  return { address: assertTranscriptRecipient(config, address), contactId };
}

function previewInput(input: TranscriptPreviewRequest): TranscriptPreviewRequest {
  if (!record(input) || !record(input.destination) || !record(input.range))
    return fail(400, "invalid_request", "Informe o destinatário e o período.");
  const d = input.destination, r = input.range;
  let destination: TranscriptDestination;
  if (d.kind === "self" || d.kind === "contact") destination = { kind: d.kind };
  else if (d.kind === "custom" && typeof d.address === "string") destination = { kind: "custom", address: normalizeEmailAddress(d.address) };
  else return fail(400, "invalid_request", "Destinatário inválido.");
  let range: TranscriptRange;
  if (r.kind === "session") range = { kind: "session" };
  else if (r.kind === "dates" && Number.isSafeInteger(r.from) && Number.isSafeInteger(r.to) &&
      r.from >= 0 && r.to >= r.from && r.to <= 8640000000000000)
    range = { kind: "dates", from: r.from, to: r.to };
  else return fail(400, "invalid_request", "Informe um intervalo de datas válido.");
  return { destination, range };
}

export async function conversationEmailOptions(env: Env, actor: Actor, conversation: Conversation): Promise<TranscriptOptions> {
  const base: TranscriptOptions = { available: false, reason: null, destinations: [], ranges: [], limits: TRANSCRIPT_LIMITS };
  try {
    const auth = await authorized(env, actor, conversation);
    const config = await getTranscriptEmailConfig(env);
    if (!config.configured) return { ...base, reason: unavailable };
    const destinations: TranscriptDestination["kind"][] = [];
    for (const kind of ["self", "contact"] as const) {
      try { await recipient(env, auth, { kind }); destinations.push(kind); }
      catch (error) { if (!(error instanceof ApiError)) throw error; }
    }
    if (config.transcript_custom_enabled) destinations.push("custom");
    const session = auth.c.session && await one(env,
      `SELECT 1 FROM messages WHERE conversation_id=? AND profile_id=? AND direction IN ('customer','outbound')
       AND json_extract(content,'$.customerSession')=? AND NOT EXISTS (
         SELECT 1 FROM messages legacy WHERE legacy.conversation_id=? AND legacy.profile_id=?
           AND legacy.direction IN ('customer','outbound') AND coalesce(json_extract(legacy.content,'$.customerSession'),'')='') LIMIT 1`,
      auth.c.id, auth.c.profile_id, auth.c.session, auth.c.id, auth.c.profile_id);
    return { ...base, available: !!destinations.length,
      reason: destinations.length ? null : "Nenhum destinatário autorizado disponível.", destinations,
      ranges: session ? ["session", "dates"] : ["dates"] };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ...base, reason: error.message };
  }
}

interface MessageRow {
  id: string; direction: string; author: string; text: string; attachments: string;
  created: number; content: string; author_name: string | null;
}
interface BoundSelection {
  range: TranscriptRange; session: string | null;
  upper: { created: number; id: string };
}
interface PreviewToken {
  version: 1; purpose: "conversation.email"; actor: string; actorKind: Actor["kind"];
  profile: string; conversation: string; destination: TranscriptDestination;
  recipient: Recipient; selection: BoundSelection; generatedAt: number; expiresAt: number;
  requestHash: string;
}

async function selected(env: Env, c: Conversation, selection: Omit<BoundSelection, "upper"> & { upper?: BoundSelection["upper"] }) {
  const args: unknown[] = [c.profile_id, c.id];
  let where = "m.profile_id=? AND m.conversation_id=? AND m.direction IN ('customer','outbound')";
  if (selection.range.kind === "session") {
    // Saídas legadas nem sempre têm customerSession. Não exportar somente a
    // metade etiquetada de uma conversa que não pode ser delimitada com segurança.
    if (!selection.session || await one(env,
      `SELECT 1 FROM messages WHERE profile_id=? AND conversation_id=? AND direction IN ('customer','outbound')
       AND coalesce(json_extract(content,'$.customerSession'),'')='' LIMIT 1`, c.profile_id, c.id))
      return fail(409, "session_unavailable", "Não foi possível delimitar este atendimento. Escolha um intervalo de datas.");
    where += " AND json_extract(m.content,'$.customerSession')=?";
    args.push(selection.session);
  } else {
    where += " AND m.created>=? AND m.created<=?";
    args.push(selection.range.from, selection.range.to);
  }
  if (selection.upper) {
    where += " AND (m.created<? OR (m.created=? AND m.id<=?))";
    args.push(selection.upper.created, selection.upper.created, selection.upper.id);
  }
  const rows = await all<MessageRow>(env,
    `SELECT m.id,m.direction,m.author,m.text,m.attachments,m.created,m.content,u.name author_name
     FROM messages m LEFT JOIN users u ON u.id=m.author WHERE ${where} ORDER BY m.created,m.id LIMIT 2001`, ...args);
  if (rows.length > TRANSCRIPT_LIMITS.maxMessages) fail(413, "transcript_too_large", "Há mais de 2.000 mensagens. Escolha um intervalo menor.");
  if (!rows.length) fail(409, selection.range.kind === "session" ? "session_unavailable" : "transcript_empty",
    selection.range.kind === "session" ? "Não foi possível delimitar este atendimento. Escolha um intervalo de datas." : "Não há mensagens públicas neste período.");
  return rows;
}

/** Sem checksum: mascarar também documentos incompletos/incorretos digitados no atendimento. */
export const maskTranscriptDocuments = (text: string) => text
  .replace(/(?<!\d)\d{2}[. ]?\d{3}[. ]?\d{3}[\/ ]?\d{4}[- ]?\d{2}(?!\d)/g, "[CNPJ mascarado]")
  .replace(/(?<!\d)\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}(?!\d)/g, "[CPF mascarado]");
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeName = (text: string) => text.replace(/https?:\/\/\S+/gi, "[link não incluído]").replace(/[\u0000-\u001f\u007f]/g, " ");
const attachmentKind = (mime: string) => mime.startsWith("image/") ? "imagem" : mime.startsWith("video/") ? "vídeo" : mime.startsWith("audio/") ? "áudio" : "documento";

async function approvedContent(env: Env, auth: Authorized, input: TranscriptPreviewRequest, rows: MessageRow[], generatedAt: number) {
  const { c, actor } = auth;
  const profile = await one(env, "SELECT name,settings FROM profiles WHERE id=? AND enabled=1", c.profile_id);
  if (!profile) return fail(404, "not_found", "Área de atendimento não encontrada.");
  const settings = json(profile.settings);
  // O legado da área usa Brasília; a chave explícita, quando presente, prevalece.
  const timeZone = settings.timezone || "America/Sao_Paulo";
  let date: Intl.DateTimeFormat, stamp: Intl.DateTimeFormat;
  try {
    date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
    stamp = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { return fail(409, "invalid_timezone", "Fuso horário da área inválido."); }
  const period = input.range.kind === "dates" ? { from: input.range.from, to: input.range.to }
    : { from: rows[0].created, to: rows[rows.length - 1].created };
  const contact = await linkedContact(env, auth);
  const ids = rows.map(r => r.id);
  // Apenas metadados dos anexos da seleção. Não ler R2, URLs ou conteúdo de documentos.
  const media = await all<{ message_id: string; id: string; name: string; type: string; hidden: number }>(env,
    `SELECT m.id message_id,a.id,a.name,a.type,
       EXISTS(SELECT 1 FROM os_documents d WHERE d.profile_id=m.profile_id
         AND (d.source_media_id=a.id OR d.r2_key=a.object_key OR d.source_message_id=m.id)
         AND (d.sensitive=1 OR d.client_visible=0 OR d.archived_at IS NOT NULL)) hidden
     FROM messages m JOIN json_each(m.attachments) j JOIN media a ON a.id=j.value AND a.profile_id=m.profile_id
     WHERE m.profile_id=? AND m.conversation_id=? AND m.id IN (SELECT value FROM json_each(?))`, c.profile_id, c.id, JSON.stringify(ids));
  const hiddenMessages = new Set((await all<{ id: string }>(env,
    `SELECT DISTINCT m.id FROM messages m JOIN os_documents d ON d.profile_id=m.profile_id
       AND (d.source_message_id=m.id OR EXISTS (
         SELECT 1 FROM outbox o WHERE o.profile_id=m.profile_id AND o.conversation_id=m.conversation_id
           AND m.source_key='delivery:'||o.id AND instr(o.dedupe,'module:os:'||m.conversation_id||':document:'||d.id||':')=1))
     WHERE m.profile_id=? AND m.conversation_id=? AND m.id IN (SELECT value FROM json_each(?))
       AND (d.sensitive=1 OR d.client_visible=0 OR d.archived_at IS NOT NULL)`, c.profile_id, c.id, JSON.stringify(ids))).map(r => r.id));
  const byMessage = new Map<string, typeof media>();
  for (const item of media) {
    byMessage.set(item.message_id, [...(byMessage.get(item.message_id) || []), item]);
    if (item.hidden) hiddenMessages.add(item.message_id);
  }
  const warnings = new Set<string>();
  const blocks = [
    `Empresa: ${settings.establishment?.name || profile.name}`,
    `Canal: ${auth.channel}${auth.account ? ` · ${auth.account}` : ""}`,
    `Contato: ${contact?.name || c.title || "Contato"}`,
    `Período: ${stamp.format(period.from)} a ${stamp.format(period.to)} (${timeZone})`,
    `Gerado por: ${actor.name}`,
    `Gerado em: ${stamp.format(generatedAt)}`,
  ];
  for (const row of rows) {
    const content = json(row.content);
    const author = row.direction === "customer" ? "Contato" : row.author_name ? `Pessoa · ${row.author_name}`
      : row.author.startsWith("bot:") ? "IA" : "Saída externa";
    let text = row.text;
    if (content.deleted === true) text = "mensagem apagada";
    else if (hiddenMessages.has(row.id)) {
      // A legenda pode ser o próprio nome sigiloso do arquivo.
      text = "[documento não incluído]";
      warnings.add("Documentos sensíveis ou não visíveis foram omitidos, inclusive nomes e legendas.");
    } else {
      const value: unknown = json(row.attachments, []);
      const attachments = Array.isArray(value) ? value : [];
      for (const id of attachments) {
        const attachment = byMessage.get(row.id)?.find(m => m.id === id);
        text += `\n[${attachment ? `${attachmentKind(attachment.type)}: ${safeName(attachment.name)}` : "anexo indisponível"}]`;
      }
      if (attachments.length) warnings.add("Anexos aparecem somente como tipo e nome, sem arquivos ou links.");
    }
    blocks.push(`[${stamp.format(row.created)}] ${author}\n${text}`);
  }
  let text = blocks.join("\n\n");
  if (input.destination.kind === "custom") text = maskTranscriptDocuments(text);
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(text)}</pre></body></html>`;
  if (text.length > TRANSCRIPT_LIMITS.maxTextChars || html.length > TRANSCRIPT_LIMITS.maxHtmlChars)
    fail(413, "transcript_too_large", "A transcrição excede o limite de texto. Escolha um intervalo menor.");
  return { subject: `Conversa de atendimento · ${date.format(generatedAt)}`, text, html, period, warnings: [...warnings] };
}

const tokenEncoder = new TextEncoder();
async function signToken(env: Env, payload: PreviewToken) {
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32) return fail(503, "setup_required", "Chave de assinatura indisponível.");
  const encoded = btoa(String.fromCharCode(...tokenEncoder.encode(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encoded}.${await hmac(env.MASTER_KEY, `conversation.email.preview:${encoded}`)}`;
}
async function readToken(env: Env, token: unknown): Promise<PreviewToken> {
  if (typeof token !== "string" || token.length > 16384 || !/^[\w-]+\.[a-f0-9]{64}$/.test(token))
    return fail(400, "preview_invalid", "Prévia inválida. Gere uma nova prévia.");
  const [payload, signature] = token.split(".");
  const expected = await hmac(env.MASTER_KEY, `conversation.email.preview:${payload}`);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (difference) return fail(400, "preview_invalid", "Prévia inválida. Gere uma nova prévia.");
  let parsed: PreviewToken;
  try { parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)))); }
  catch { return fail(400, "preview_invalid", "Prévia inválida. Gere uma nova prévia."); }
  if (parsed.version !== 1 || parsed.purpose !== "conversation.email" || !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt - parsed.generatedAt !== TRANSCRIPT_LIMITS.previewTtlMs)
    return fail(400, "preview_invalid", "Prévia inválida. Gere uma nova prévia.");
  return parsed;
}

async function contentHash(c: Conversation, target: Recipient, selection: BoundSelection, mail: { subject: string; text: string; html: string }) {
  return sha(JSON.stringify({ profile: c.profile_id, conversation: c.id, recipient: target,
    selection, subject: mail.subject, text: mail.text, html: mail.html }));
}

export async function previewConversationEmail(env: Env, actor: Actor, conversation: Conversation, value: TranscriptPreviewRequest): Promise<TranscriptPreview> {
  const auth = await authorized(env, actor, conversation);
  const input = previewInput(value);
  const target = await recipient(env, auth, input.destination);
  const selection = { range: input.range, session: input.range.kind === "session" ? auth.c.session : null };
  const rows = await selected(env, auth.c, selection);
  const last = rows[rows.length - 1];
  const bounded = { ...selection, upper: { created: last.created, id: last.id } };
  const generatedAt = now(), expiresAt = generatedAt + TRANSCRIPT_LIMITS.previewTtlMs;
  const mail = await approvedContent(env, auth, input, rows, generatedAt);
  const previewToken = await signToken(env, { version: 1, purpose: "conversation.email", actor: actor.id,
    actorKind: actor.kind, profile: auth.c.profile_id, conversation: auth.c.id, destination: input.destination,
    recipient: target, selection: bounded, generatedAt, expiresAt, requestHash: await contentHash(auth.c, target, bounded, mail) });
  return { recipient: target.address, period: mail.period, messageCount: rows.length,
    size: { textChars: mail.text.length, htmlChars: mail.html.length }, warnings: mail.warnings,
    requiresConfirmation: input.destination.kind !== "self", requiresCustomerRequest: input.destination.kind === "contact", previewToken, expiresAt };
}

/** Handlers tipados para composição por cn-servidor; mutações devem passar pelo Coordinator. */
export async function sendConversationTranscript(env: Env, actor: Actor, conversation: Conversation, commandId: string, input: TranscriptSendRequest): Promise<TranscriptSendResult> {
  const auth = await authorized(env, actor, conversation);
  if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200 || /[\r\n]/.test(commandId))
    return fail(400, "idempotency_required", "Informe Idempotency-Key de até 200 caracteres.");
  const token = await readToken(env, input?.previewToken);
  if (token.actor !== actor.id || token.actorKind !== actor.kind || token.profile !== auth.c.profile_id || token.conversation !== auth.c.id)
    return fail(403, "preview_scope", "Esta prévia não pertence ao ator e à conversa.");
  const request = previewInput({ destination: token.destination, range: token.selection.range });
  const target = await recipient(env, auth, request.destination);
  if (target.address !== token.recipient.address || target.contactId !== token.recipient.contactId)
    return fail(409, "preview_changed", "O destinatário mudou. Gere uma nova prévia.");
  if (request.destination.kind !== "self" &&
      (typeof input.confirmedRecipient !== "string" || normalizeEmailAddress(input.confirmedRecipient) !== target.address))
    return fail(400, "recipient_confirmation_required", "Confirme o endereço exibido na prévia.");
  if (request.destination.kind === "contact" && input.customerRequested !== true)
    return fail(400, "customer_request_required", "Confirme que o cliente pediu o envio.");
  // Uma prévia vencida ainda pode identificar um recibo já autorizado, sem
  // disponibilizar corpo nem reservar outro envio. Nova execução exige validade.
  const replay = await conversationEmailReplay(env, { profileId: auth.c.profile_id,
    actorId: actor.id, key: commandId, requestHash: token.requestHash });
  if (replay) return replay;
  if (token.expiresAt <= now()) return fail(410, "preview_expired", "A prévia venceu. Gere uma nova prévia.");
  if (request.range.kind === "session" && token.selection.session !== auth.c.session)
    return fail(409, "preview_changed", "O atendimento mudou. Gere uma nova prévia.");
  const rows = await selected(env, auth.c, token.selection);
  const mail = await approvedContent(env, auth, request, rows, token.generatedAt);
  const requestHash = await contentHash(auth.c, target, token.selection, mail);
  if (requestHash !== token.requestHash) return fail(409, "preview_changed", "O conteúdo mudou. Gere uma nova prévia.");
  return sendConversationEmail(env, { profileId: auth.c.profile_id, actorId: actor.id, conversationId: auth.c.id,
    key: commandId, requestHash, to: target.address, subject: mail.subject, text: mail.text, html: mail.html });
}

export const conversationTranscriptPort: ChannelTranscriptPort = {
  options: conversationEmailOptions, preview: previewConversationEmail, send: sendConversationTranscript,
};
