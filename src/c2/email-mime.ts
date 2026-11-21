import PostalMime, { type Address, type Email } from "postal-mime";
import { CHANNEL_REGISTRY } from "../channels";
import type { ChannelSpec, MediaKind } from "../channel-contracts";
import { ApiError } from "../types";

export const EMAIL_RAW_LIMIT = 25 * 1024 * 1024;
/** Limite adicional do parser em memória. O recebimento bruto continua em 25 MiB;
 * mensagens maiores ficam retidas com diagnóstico, sem tentar alocar a árvore MIME. */
export const EMAIL_PARSE_LIMIT = 8 * 1024 * 1024;
export const EMAIL_TEXT_LIMIT = 50_000;
export const EMAIL_ATTACHMENT_LIMIT = 32;
const HEADER_LIMIT = 64 * 1024;
const HTML_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();

/** A mesma lista de tipos da política local; o envelope é um limite adicional.
 * MIME declarado não equivale a antivírus nem a inspeção universal do arquivo. */
export const EMAIL_MEDIA_POLICY: ChannelSpec["media"] = Object.fromEntries(
  Object.entries(CHANNEL_REGISTRY.whatsapp.media)
    .filter(([kind, rule]) => kind !== "sticker" && rule.receive && rule.send)
    .map(([kind, rule]) => [kind, { ...rule, maxSendBytes: Math.min(rule.maxSendBytes ?? 0, EMAIL_RAW_LIMIT), mimeTypes: [...rule.mimeTypes] }]),
);

export interface EmailEnvelope { sender: string; recipient: string }
export interface EmailAttachment {
  index: number; name: string; mimeType: string; size: number; bytes: Uint8Array; kind: MediaKind;
}
export interface ParsedEmail {
  text: string; subject: string; from?: string; replyTo?: string;
  messageId: string | null; inReplyTo: string | null; references: string[];
  occurredAt: number | null;
  classification: "human" | "automatic" | "bounce" | "list" | "probe";
  /** Apenas para comparação com o hash do desafio; nunca persistir ou projetar. */
  probeToken?: string;
  quarantineReason?: string;
  authentication: { method: string; result: string }[];
  attachments: EmailAttachment[]; attachmentWarnings: string[];
  identityTrust: "unverified_sender"; verifiedChannel: null;
}

/** Normalização operacional conservadora: não remove pontos nem +tag. */
export function normalizeEmailAddress(value: unknown, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") throw invalidAddress();
  if (options.allowEmpty && (value === "" || value === "<>")) return "";
  if (value.length > 320 || /[\s<>(),;:\\"'\u0000-\u001f\u007f]/.test(value)) throw invalidAddress();
  const split = value.lastIndexOf("@");
  const local = value.slice(0, split);
  const domain = value.slice(split + 1);
  if (split <= 0 || split !== value.indexOf("@") || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/i.test(local) || local.startsWith(".") ||
      local.endsWith(".") || local.includes("..") || !domain || /[/?#%]/.test(domain)) throw invalidAddress();
  let host: string;
  try { host = new URL(`https://${domain}`).hostname.toLowerCase(); } catch { throw invalidAddress(); }
  if (host.length > 253 || !host.includes(".") || !host.split(".").every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw invalidAddress();
  const result = `${local.toLowerCase()}@${host}`;
  if (result.length > 254) throw invalidAddress();
  return result;
}
function invalidAddress(): ApiError { return new ApiError(400, "email_address_invalid", "Informe um único endereço de e-mail válido."); }

export function sanitizeEmailSubject(value: string, strict = false): string {
  if (typeof value !== "string" || (strict && (value.length > 200 || /[\r\n\u0000]/.test(value))))
    throw new ApiError(400, "subject_invalid", "O assunto deve ter até 200 caracteres, sem quebras de linha.");
  return cleanText(value).replace(/[\r\n]+/g, " ").slice(0, 200);
}
export function normalizeEmailMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length <= 998 && /^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(id) &&
    !/[<>]/.test(id.slice(1, -1)) && id.indexOf("@") === id.lastIndexOf("@") ? id : null;
}
export function emailReferences(value: string, inReplyTo: string | null = null): string[] {
  const output: string[] = [];
  let bytes = inReplyTo ? encoder.encode(inReplyTo).length : 0;
  for (const token of value.slice(0, HEADER_LIMIT).split(/\s+/)) {
    const id = normalizeEmailMessageId(token);
    if (!id || output.includes(id)) continue;
    const size = encoder.encode(id).length + 1;
    if (output.length === 50 || bytes + size > 8 * 1024) break;
    output.push(id); bytes += size;
  }
  return output;
}
export function safeEmailFilename(value: string | null, index = 0): string {
  const leaf = (value ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  return cleanText(leaf).replace(/[\r\n<>:"|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || `anexo-${index + 1}`;
}
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}
function mailbox(value: Address | undefined): string | undefined {
  if (!value?.address) return undefined;
  try { return normalizeEmailAddress(value.address); } catch { return undefined; }
}

const invisibleTags = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "svg", "math", "template", "noscript", "img", "picture", "source", "video", "audio", "link", "meta", "base", "input", "button", "select", "textarea"]);
const blockTags = new Set(["p", "div", "section", "article", "header", "footer", "aside", "address", "blockquote", "pre", "li", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br"]);
const namedEntities: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", Aacute: "Á", agrave: "à", Agrave: "À", acirc: "â", Acirc: "Â", atilde: "ã", Atilde: "Ã",
  eacute: "é", Eacute: "É", ecirc: "ê", Ecirc: "Ê", iacute: "í", Iacute: "Í",
  oacute: "ó", Oacute: "Ó", ocirc: "ô", Ocirc: "Ô", otilde: "õ", Otilde: "Õ",
  uacute: "ú", Uacute: "Ú", uuml: "ü", Uuml: "Ü", ccedil: "ç", Ccedil: "Ç",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", euro: "€",
};
/** Decode character references only after parsing; this output is always plain text. */
function decodeTextEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return namedEntities[entity] ?? whole;
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
  });
}

/** HTMLRewriter is a passive parser. No DOM, URL resolution, fetch or markup is
 * exposed. A first parse removes excluded subtrees; a second extracts text only. */
export async function emailHtmlToText(html: string): Promise<string> {
  if (html.length > HTML_LIMIT) throw new ApiError(422, "email_html_too_large", "O conteúdo HTML excede o limite local de processamento.");
  const stripped = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (invisibleTags.has(tag) || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
        element.remove(); return;
      }
      // DOM and Worker typings share Element; the runtime iterator is [name,value].
      // Snapshot first: removing an attribute invalidates the runtime iterator.
      const attributes = Array.from(element.attributes as unknown as Iterable<readonly [string, string]>);
      for (const [name] of attributes) element.removeAttribute(name);
      if (blockTags.has(tag)) { element.before("\n"); element.after("\n"); }
      if (tag === "td" || tag === "th") element.after("\t");
    },
    comments(comment) { comment.remove(); },
  }).transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  const chunks: string[] = [];
  let length = 0;
  const plain = new HTMLRewriter().onDocument({
    text(chunk) {
      length += chunk.text.length;
      if (length > HTML_LIMIT) throw new ApiError(422, "email_html_too_large", "O conteúdo HTML excede o limite local de processamento.");
      chunks.push(chunk.text);
    },
  }).transform(stripped);
  // Drain without materializing a second serialized HTML string.
  const reader = plain.body!.getReader();
  try { while (!(await reader.read()).done) { /* Parse the bounded stream. */ } }
  finally { reader.releaseLock(); }
  return cleanText(decodeTextEntities(chunks.join(""))).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function headerValues(email: Email, key: string): string[] {
  return email.headers.filter(header => header.key === key).map(header => header.value);
}
function classify(email: Email, sender: string, subject: string): Pick<ParsedEmail, "classification" | "probeToken"> {
  const probeHeaders = headerValues(email, "x-wabotia-email-probe");
  const probePrefix = "vinki: teste de recebimento";
  if (probeHeaders.length || subject.toLowerCase().startsWith(probePrefix)) {
    const candidates = probeHeaders.length ? probeHeaders : [subject.slice(probePrefix.length).trim()];
    const token = candidates.length === 1 && /^[\da-f]{64}$/i.test(candidates[0]) ? candidates[0].toLowerCase() : undefined;
    return { classification: "probe", ...(token ? { probeToken: token } : {}) };
  }
  const header = (name: string) => headerValues(email, name).join(";").toLowerCase();
  const contentType = header("content-type");
  if (!sender || header("return-path").trim() === "<>" || contentType.includes("multipart/report") ||
      contentType.includes("message/delivery-status") || email.attachments.some(item =>
        ["message/delivery-status", "message/disposition-notification"].includes(item.mimeType))) return { classification: "bounce" };
  if (["list-id", "list-unsubscribe", "list-post", "list-help", "mailing-list"].some(name => headerValues(email, name).length) ||
      /\b(?:bulk|list|junk)\b/.test(header("precedence"))) return { classification: "list" };
  if (headerValues(email, "auto-submitted").some(value => value.trim().toLowerCase() !== "no") ||
      headerValues(email, "x-autoreply").length || headerValues(email, "x-autorespond").length ||
      /\b(?:all|autoreply|oof)\b/.test(header("x-auto-response-suppress"))) return { classification: "automatic" };
  return { classification: "human" };
}
function authentication(email: Email): ParsedEmail["authentication"] {
  const result: ParsedEmail["authentication"] = [];
  for (const value of headerValues(email, "authentication-results")) {
    for (const match of value.matchAll(/\b(spf|dkim|dmarc)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/gi)) {
      if (result.length === 12) return result;
      result.push({ method: match[1].toLowerCase(), result: match[2].toLowerCase() });
    }
  }
  return result;
}

/** No I/O. Call only after raw persistence and a durable lease. The MIME library
 * bounds headers, parts, depth and forwarded messages before allocating their
 * trees; the raw envelope, rendered text and attachment totals have own limits. */
export async function parseEmailMime(raw: Uint8Array | ArrayBuffer, envelope: EmailEnvelope): Promise<ParsedEmail> {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > EMAIL_RAW_LIMIT) throw new ApiError(413, "email_too_large", "O e-mail excede 25 MiB.");
  if (bytes.byteLength > EMAIL_PARSE_LIMIT) throw new ApiError(422, "email_parse_limit", "O bruto foi preservado; o processamento MIME aceita até 8 MiB nesta instalação.");
  const sender = normalizeEmailAddress(envelope.sender, { allowEmpty: true });
  normalizeEmailAddress(envelope.recipient);
  let email: Email;
  try {
    // The public parser copies typed-array views. Hand it the owned full buffer
    // when possible, without exposing neighbouring bytes of a sliced view.
    const source = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes;
    email = await PostalMime.parse(source, {
      attachmentEncoding: "arraybuffer", forceRfc822Attachments: true,
      maxHeadersSize: HEADER_LIMIT, maxNestingDepth: 12, maxPartCount: 96,
      maxRfc822NestingDepth: 0, maxForwardedAddresses: 64,
    });
  } catch {
    throw new ApiError(422, "email_mime_invalid", "Não foi possível processar o MIME dentro dos limites locais.");
  }
  const subject = sanitizeEmailSubject(email.subject ?? "");
  const classification = classify(email, sender, subject);
  // A text alternative takes precedence. An HTML-only body always passes through
  // the passive parser; no HTML body or headers survive in the returned DTO.
  // Automatic mail and probes need only diagnostic metadata; their bodies and
  // attachments never become attendance content (nor incur HTML conversion).
  let text = classification.classification !== "human" ? ""
    : email.text ? cleanText(email.text) : email.html ? await emailHtmlToText(email.html) : "";
  const attachmentWarnings: string[] = [];
  if (text.length > EMAIL_TEXT_LIMIT) {
    text = text.slice(0, EMAIL_TEXT_LIMIT);
    attachmentWarnings.push("O texto foi limitado a 50.000 caracteres.");
  }
  const messageIds = headerValues(email, "message-id").map(normalizeEmailMessageId);
  const conflictingIds = messageIds.length > 1 && new Set(messageIds).size > 1;
  const messageId = conflictingIds ? null : normalizeEmailMessageId(email.messageId);
  const inReplyTo = normalizeEmailMessageId(email.inReplyTo);
  const attachments: EmailAttachment[] = [];
  let total = 0;
  if (email.attachments.length > EMAIL_ATTACHMENT_LIMIT) attachmentWarnings.push("Os anexos após o limite de 32 arquivos foram recusados.");
  for (const [index, attachment] of email.attachments.entries()) {
    if (classification.classification !== "human") break;
    if (index >= EMAIL_ATTACHMENT_LIMIT) break;
    const mimeType = attachment.mimeType.split(";")[0].trim().toLowerCase();
    const name = safeEmailFilename(attachment.filename, index);
    const format = Object.entries(EMAIL_MEDIA_POLICY).find(([, rule]) => rule.receive && rule.mimeTypes.includes(mimeType));
    if (!format || typeof attachment.content === "string") {
      attachmentWarnings.push(`Anexo ${index + 1}: tipo não permitido.`); continue;
    }
    const data = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content);
    total += data.byteLength;
    if (data.byteLength > (format[1].maxSendBytes ?? 0) || total > EMAIL_RAW_LIMIT) {
      attachmentWarnings.push(`Anexo ${index + 1}: tamanho acima do limite local.`); continue;
    }
    attachments.push({ index, name, mimeType, size: data.byteLength, bytes: data, kind: format[0] as MediaKind });
  }
  const date = email.date ? Date.parse(email.date) : NaN;
  return {
    text, subject, ...(mailbox(email.from) ? { from: mailbox(email.from) } : {}),
    ...(email.replyTo?.length === 1 && mailbox(email.replyTo[0]) ? { replyTo: mailbox(email.replyTo[0]) } : {}),
    messageId, inReplyTo, references: emailReferences(email.references ?? "", inReplyTo),
    occurredAt: Number.isFinite(date) && date > 0 ? date : null,
    ...classification, ...(conflictingIds ? { quarantineReason: "email_message_id_conflict" } : {}),
    authentication: authentication(email), attachments, attachmentWarnings,
    identityTrust: "unverified_sender", verifiedChannel: null,
  };
}
