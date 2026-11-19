import { all, batch, exec, one } from "../db";
import { ApiError, json, now, type Conversation, type Env } from "../types";
import { sha } from "../security";
import { assertVerifiedIngress, signVerifiedIngress } from "../channel-extension-kernel";
import { receiveExtensionIngress, wakeChannelExtensions } from "../service";
import { prepareChannelInbound } from "../customer/channel-identity";
import { refreshChannelSummaryStatements } from "../channel-accounts";
import type { Statement } from "../customer/contracts";
import type { ChannelMaintenance, ChannelOperationContext, ChannelWritePlan, ExtensionConnection, NormalizedChannelEvent, VerifiedIngress } from "../channel-c2-contracts";
import { EMAIL_RAW_LIMIT, normalizeEmailAddress, parseEmailMime, type ParsedEmail } from "./email-mime";

const DAY = 86_400_000;
const LEASE = 120_000;
const MAINTENANCE_KEY = "email.inbox";
const object = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input)
  ? input as Record<string, unknown> : {};

export interface EmailInboxRow {
  id: string; profile_id: string; connection_id: string; event_key: string;
  sender: string; recipient: string; rfc_message_id: string | null; raw_hash: string;
  raw_key: string | null; raw_size: number; state: string; attempts: number;
  lease_until: number | null; next_at: number; error_code: string | null;
  conversation_id: string | null; message_id: string | null; metadata: string;
  created: number; updated: number;
}

/** The stream, not rawSize, is authoritative. No MIME decoding in the runtime handler. */
export async function readEmailStream(stream: ReadableStream<Uint8Array>, declaredSize: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > EMAIL_RAW_LIMIT) {
    await stream.cancel().catch(() => {});
    throw new ApiError(413, "email_too_large", "O e-mail excede o limite de 25 MiB.");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > EMAIL_RAW_LIMIT) throw new ApiError(413, "email_too_large", "O e-mail excede o limite de 25 MiB.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}

/** Exclusive Worker email runtime entry point. There is deliberately no HTTP route. */
export async function receiveEmail(message: ForwardableEmailMessage, env: Env, _execution: ExecutionContext): Promise<void> {
  let recipient: string, sender: string;
  try {
    recipient = normalizeEmailAddress(message.to);
    sender = normalizeEmailAddress(message.from, { allowEmpty: true });
  } catch {
    message.setReject("Endereço de envelope inválido.");
    return;
  }
  const address = await one<{ connection_id: string; profile_id: string; active: number; config: string; status: string }>(env,
    `SELECT a.connection_id,a.profile_id,a.active,c.config,c.status FROM email_channel_addresses a
     JOIN connections c ON c.id=a.connection_id AND c.profile_id=a.profile_id
     WHERE a.address=? AND c.kind='email' AND c.channel='email'`, recipient);
  const config = json(address?.config);
  if (!address || config.c2_enabled !== true || config.address !== recipient || config.remove_pending ||
      (!address.active && !await one(env, `SELECT id FROM email_channel_probes WHERE connection_id=? AND profile_id=?
        AND state='pending' AND expires>? LIMIT 1`, address.connection_id, address.profile_id, now())) ||
      (address.active && address.status !== "active")) {
    message.setReject("Este endereço não está disponível para recebimento.");
    return;
  }
  const bytes = await readEmailStream(message.raw, message.rawSize);
  const rawHash = await hashBytes(bytes);
  const eventKey = `email:${await sha(JSON.stringify([address.connection_id, sender, recipient, rawHash]))}`;
  const id = eventKey;
  if (await one(env, "SELECT id FROM email_channel_inbox WHERE event_key=?", eventKey)) return;
  // Raw objects have no row in media and can never be fetched by the normal media endpoint.
  const rawKey = `email-raw/${address.profile_id}/${id}`;
  await env.MEDIA.put(rawKey, bytes, { httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { connection_id: address.connection_id, sender_hash: await sha(sender) } });
  const time = now();
  // Never turn a storage failure into SMTP success. R2 is deliberately before D1;
  // a failed/indeterminate insert leaves an orphan for the bounded cron collector.
  await exec(env, `INSERT INTO email_channel_inbox(id,profile_id,connection_id,event_key,sender,recipient,
    raw_hash,raw_key,raw_size,state,next_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)
    ON CONFLICT(event_key) DO NOTHING`, id, address.profile_id, address.connection_id, eventKey,
  sender, recipient, rawHash, rawKey, bytes.byteLength, time, time, time);
  const response = await wakeChannelExtensions(env, address.profile_id, [MAINTENANCE_KEY], time);
  if (!response.ok) throw new ApiError(503, "email_wake_failed", "O processamento do e-mail aguarda recuperação.");
}

/** Normalization is pure: no parsing, storage, downloads or acceptance of client proof. */
export async function normalizeEmailIngress(input: unknown, scope: VerifiedIngress): Promise<NormalizedChannelEvent | null> {
  assertVerifiedIngress(scope);
  const body = object(input);
  if (scope.source !== "worker_email" || scope.channel !== "email" || scope.context !== "direct" ||
      typeof body.inboxId !== "string" || !/^email:[a-f0-9]{64}$/.test(body.inboxId) ||
      !Number.isSafeInteger(body.lease) || !Number.isSafeInteger(body.attempt) || Number(body.attempt) < 1) return null;
  return { key: body.inboxId, kind: "email.received", remoteId: body.inboxId, occurredAt: null,
    context: {}, content: { inboxId: body.inboxId, lease: body.lease, attempt: body.attempt } };
}

function leaseGuard(row: EmailInboxRow): Statement {
  return [`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM email_channel_inbox
    WHERE id=? AND profile_id=? AND connection_id=? AND state='processing' AND lease_until=? AND attempts=?)
    THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
  [`${row.id}:lease`, row.id, row.profile_id, row.connection_id, row.lease_until, row.attempts]];
}

export function emailMetadata(parsed: ParsedEmail): Record<string, unknown> {
  return { version: 1, subject: parsed.subject, messageId: parsed.messageId, inReplyTo: parsed.inReplyTo,
    references: parsed.references, from: parsed.from, replyTo: parsed.replyTo,
    authentication: parsed.authentication, attachmentWarnings: parsed.attachmentWarnings,
    identityTrust: "unverified_sender", classification: parsed.classification };
}

function finishRow(row: EmailInboxRow, time: number, state: string, metadata: Record<string, unknown>, options: {
  code?: string; messageId?: string | null; conversationId?: string; messageRecordId?: string;
} = {}): Statement {
  return [`UPDATE email_channel_inbox SET state=?,rfc_message_id=?,metadata=?,error_code=?,
    conversation_id=?,message_id=?,lease_until=NULL,next_at=0,updated=?
    WHERE id=? AND state='processing' AND lease_until=? AND attempts=?`,
  [state, options.messageId ?? null, JSON.stringify(metadata), options.code ?? null, options.conversationId ?? null,
    options.messageRecordId ?? null, time, row.id, row.lease_until, row.attempts]];
}

async function parseStoredEmail(env: Env, row: EmailInboxRow): Promise<ParsedEmail> {
  if (!row.raw_key) throw new ApiError(409, "email_raw_missing", "O conteúdo do e-mail não está disponível.");
  const stored = await env.MEDIA.get(row.raw_key);
  if (!stored) throw new ApiError(503, "email_raw_missing", "O conteúdo do e-mail aguarda recuperação.");
  if (stored.size > EMAIL_RAW_LIMIT) throw new ApiError(413, "email_too_large", "O e-mail excede o limite de 25 MiB.");
  const bytes = await readEmailStream(stored.body, stored.size);
  if (bytes.byteLength !== row.raw_size || await hashBytes(bytes) !== row.raw_hash)
    throw new ApiError(409, "email_raw_changed", "O conteúdo do e-mail não corresponde ao registro recebido.");
  return parseEmailMime(bytes, { sender: row.sender, recipient: row.recipient });
}

async function probeStatements(env: Env, row: EmailInboxRow, parsed: ParsedEmail, time: number): Promise<Statement[] | null> {
  if (parsed.classification !== "probe") return null;
  const digest = parsed.probeToken ? await sha(parsed.probeToken) : "";
  const probe = digest ? await one<{ id: string }>(env, `SELECT id FROM email_channel_probes WHERE profile_id=?
    AND connection_id=? AND token_hash=? AND state='pending' AND expires>?`, row.profile_id, row.connection_id, digest, time) : null;
  // Challenge text/token is never copied into metadata, audit or UI.
  const statements: Statement[] = [leaseGuard(row)];
  if (probe) statements.push([
    `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM email_channel_probes
      WHERE id=? AND state='pending' AND expires>? AND token_hash=?) AND EXISTS(SELECT 1 FROM email_channel_addresses
      WHERE connection_id=? AND profile_id=? AND address=?) AND EXISTS(SELECT 1 FROM connections
      WHERE id=? AND profile_id=? AND kind='email' AND channel='email' AND status IN ('active','paused')
      AND json_extract(config,'$.address')=? AND json_extract(config,'$.c2_enabled')=1
      AND coalesce(json_extract(config,'$.remove_pending'),0)=0) THEN 1 ELSE 0 END
      ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [`${row.id}:probe`, probe.id, time, digest, row.connection_id, row.profile_id, row.recipient,
      row.connection_id, row.profile_id, row.recipient],
  ], ["UPDATE email_channel_probes SET state='received',received_at=? WHERE id=? AND state='pending'", [time, probe.id]],
  ["UPDATE email_channel_addresses SET active=1,verified_at=?,updated=? WHERE connection_id=? AND profile_id=? AND address=?",
    [time, time, row.connection_id, row.profile_id, row.recipient]],
  [`UPDATE connections SET status='active' WHERE id=? AND profile_id=? AND kind='email' AND channel='email'
    AND json_extract(config,'$.address')=? AND json_extract(config,'$.c2_enabled')=1
    AND coalesce(json_extract(config,'$.remove_pending'),0)=0`, [row.connection_id, row.profile_id, row.recipient]],
  ...refreshChannelSummaryStatements(row.profile_id));
  statements.push(finishRow(row, time, "automatic", { version: 1, classification: "probe", probeState: probe ? "received" : "invalid" },
    { code: probe ? undefined : "email_probe_invalid" }));
  return statements;
}

/** Called only after the kernel's event deduplication. The lease assertion, identity,
 * ordinary inbox, media rows, message and terminal receipt commit in one D1 batch. */
export async function prepareEmailInbound(ctx: ChannelOperationContext, event: NormalizedChannelEvent): Promise<ChannelWritePlan> {
  if (!ctx.ingress) throw new ApiError(403, "invalid_channel_evidence", "A origem do e-mail não foi confirmada.");
  assertVerifiedIngress(ctx.ingress);
  const row = await one<EmailInboxRow>(ctx.env, `SELECT * FROM email_channel_inbox WHERE id=? AND profile_id=?
    AND connection_id=? AND recipient=? AND state='processing' AND lease_until=? AND attempts=?`, event.content.inboxId,
  ctx.authorization.profileId, ctx.connection.id, ctx.ingress.accountId, event.content.lease, event.content.attempt);
  if (!row || row.lease_until === null || row.lease_until <= ctx.now)
    throw new ApiError(409, "email_lease_lost", "O processamento do e-mail será retomado.");
  const parsed = await parseStoredEmail(ctx.env, row);
  const probe = await probeStatements(ctx.env, row, parsed, ctx.now);
  if (probe) return { statements: probe, wake: false };
  const metadata = emailMetadata(parsed);
  if (parsed.quarantineReason) return { statements: [leaseGuard(row), finishRow(row, ctx.now, "quarantine", metadata,
    { code: parsed.quarantineReason })], wake: false };
  const prior = parsed.messageId ? await one<EmailInboxRow>(ctx.env, `SELECT * FROM email_channel_inbox
    WHERE connection_id=? AND sender=? AND rfc_message_id=? AND state<>'quarantine' AND id<>? LIMIT 1`,
  row.connection_id, row.sender, parsed.messageId, row.id) : null;
  if (prior) return { statements: [leaseGuard(row), finishRow(row, ctx.now, "quarantine", metadata,
    { code: prior.raw_hash === row.raw_hash ? "email_duplicate_message_id" : "email_message_id_conflict" })], wake: false };
  const blocked = await one(ctx.env, `SELECT 1 FROM email_channel_blocks WHERE profile_id=? AND connection_id=?
    AND ((kind='address' AND value=?) OR (kind='domain' AND value=?))`, row.profile_id, row.connection_id,
  row.sender, row.sender.split("@")[1] ?? "");
  if (blocked || parsed.classification !== "human") return { statements: [leaseGuard(row),
    finishRow(row, ctx.now, blocked ? "blocked" : "automatic", metadata, { messageId: parsed.messageId })], wake: false };
  if (!await one(ctx.env, `SELECT 1 FROM email_channel_addresses WHERE profile_id=? AND connection_id=? AND address=? AND active=1`,
    row.profile_id, row.connection_id, row.recipient)) return { statements: [leaseGuard(row),
    finishRow(row, ctx.now, "quarantine", {}, { code: "receiving_unverified" })], wake: false };
  const id = `email:${await sha(JSON.stringify([row.profile_id, row.connection_id, row.sender]))}`;
  const old = await one<Conversation>(ctx.env, `SELECT * FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?`,
    row.profile_id, `channel:${row.connection_id}`, `email:${row.sender}`);
  const config = json(ctx.connection.config);
  const context = { version: 1, context: "direct", identityTrust: "unverified_sender", email: { ...metadata, sender: row.sender } };
  const created = !old;
  const conversation: Conversation = old ?? {
    id, profile_id: row.profile_id, connection_id: row.connection_id, external_namespace: `channel:${row.connection_id}`,
    external_id: `email:${row.sender}`, channel: "email", channel_account_id: row.recipient, channel_subject_id: row.sender,
    channel_context: JSON.stringify(context), account_label: ctx.connection.account_label ?? "", title: row.sender,
    phone: null, verified_phone: null, customer_link_state: "pending", chat_type: "direct", bot_policy: config.bot_enabled === true ? "mentions" : "off",
    state: config.bot_enabled === true ? "ai" : "waiting", owner: null, epoch: 1, session: `${row.id}:session`,
    topic: null, tags: "[]", last_customer: 0, created: row.created, updated: ctx.now,
  };
  if (conversation.channel !== "email" || conversation.connection_id !== row.connection_id ||
      conversation.channel_account_id !== row.recipient || conversation.channel_subject_id !== row.sender)
    throw new ApiError(409, "email_scope_changed", "A conversa não corresponde à conexão de recebimento.");
  if (conversation.state === "closed") {
    conversation.state = config.bot_enabled === true ? "ai" : "waiting";
    conversation.owner = null; conversation.session = `${row.id}:session`; conversation.epoch++;
  }
  const identity = await prepareChannelInbound(ctx.env, conversation, {
    provider: "email", channel: "email", accountId: row.recipient, subjectId: row.sender,
    subjectNamespace: "email-address", displayName: row.sender, ingress: ctx.ingress,
  });
  if (identity.customer.state === "blocked" || identity.customer.state === "excluded") return {
    statements: [leaseGuard(row), finishRow(row, ctx.now, "blocked", metadata, { code: "sender_blocked", messageId: parsed.messageId })], wake: false,
  };
  const writes: Statement[] = [leaseGuard(row)];
  if (created) writes.push([
    `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,epoch,session,
      last_customer,created,updated,channel,account_label,channel_account_id,channel_subject_id,channel_context,title,bot_policy)
      VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [conversation.id, row.profile_id, row.connection_id, conversation.external_namespace, conversation.external_id,
      conversation.state, conversation.epoch, conversation.session, 0, row.created, ctx.now, "email", conversation.account_label,
      row.recipient, row.sender, JSON.stringify(context), row.sender, conversation.bot_policy],
  ]);
  const attachments: string[] = [];
  for (const attachment of parsed.attachments) {
    const mediaId = `email:${await sha(JSON.stringify([row.id, attachment.index]))}`;
    const objectKey = `email-attachment/${row.profile_id}/${row.id}/${attachment.index}`;
    // Reuse only an already committed media row. A retry after rollback overwrites
    // the same private key, never creates another attachment identity.
    if (!await one(ctx.env, "SELECT id FROM media WHERE id=? AND profile_id=?", mediaId, row.profile_id)) {
      await ctx.env.MEDIA.put(objectKey, attachment.bytes, { httpMetadata: { contentType: attachment.mimeType } });
      writes.push(["INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        [mediaId, row.profile_id, attachment.name, attachment.mimeType, attachment.size, objectKey, `email:${row.connection_id}`, ctx.now]]);
    }
    attachments.push(mediaId);
  }
  const messageId = `${row.id}:message`;
  const content = { version: 1, type: "email", customerSession: conversation.session, email: { ...metadata, sender: row.sender } };
  writes.push([`UPDATE conversations SET state=?,owner=?,epoch=?,session=?,last_customer=max(last_customer,?),
    channel_context=?,updated=? WHERE id=? AND profile_id=?`, [conversation.state, conversation.owner, conversation.epoch,
    conversation.session, row.created, JSON.stringify(context), ctx.now, conversation.id, row.profile_id]],
  ...identity.statements,
  ["INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)", [row.id, row.profile_id,
    row.event_key, conversation.id, JSON.stringify({ text: parsed.text, attachments, content, channel: "email",
      message_record_id: messageId, message_id: parsed.messageId ?? row.id, occurred_at: parsed.occurredAt,
      epoch: conversation.epoch, session: conversation.session }), row.created]],
  [`INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content)
    VALUES(?,?,?,'customer',?,?,?,?,?,?)`, [messageId, row.profile_id, conversation.id,
    `customer:channel:${row.connection_id}:${row.sender}`, parsed.text, JSON.stringify(attachments), parsed.messageId ?? row.id,
    row.created, JSON.stringify(content)]],
  finishRow(row, ctx.now, "processed", metadata, { messageId: parsed.messageId, conversationId: conversation.id, messageRecordId: messageId }));
  return { statements: writes, conversationId: conversation.id, resource: { kind: "conversation", id: conversation.id }, wake: true };
}

async function processPending(env: Env, profileId: string, time: number): Promise<void> {
  const rows = await all<EmailInboxRow>(env, `SELECT * FROM email_channel_inbox WHERE profile_id=?
    AND ((state='pending' AND next_at<=?) OR (state='processing' AND lease_until<=?)) ORDER BY next_at,id LIMIT 3`, profileId, time, time);
  for (const old of rows) {
    const lease = time + LEASE;
    const claimed = await exec(env, `UPDATE email_channel_inbox SET state='processing',attempts=attempts+1,
      lease_until=?,updated=? WHERE id=? AND attempts=? AND ((state='pending' AND next_at<=?) OR (state='processing' AND lease_until<=?))`,
    lease, time, old.id, old.attempts, time, time);
    if (!claimed.meta.changes) continue;
    const row: EmailInboxRow = { ...old, state: "processing", attempts: old.attempts + 1, lease_until: lease };
    try {
      const connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='email' AND channel='email'", row.connection_id, row.profile_id);
      const config = json(connection?.config);
      if (!connection || config.address !== row.recipient || config.c2_enabled !== true || config.remove_pending) {
        await batch(env, [leaseGuard(row), finishRow(row, time, "quarantine", {}, { code: "channel_not_ready" })]);
        continue;
      }
      if (connection.status !== "active") {
        const parsed = await parseStoredEmail(env, row);
        const statements = await probeStatements(env, row, parsed, time);
        await batch(env, statements ?? [leaseGuard(row), finishRow(row, time, "quarantine", {}, { code: "receiving_unverified" })]);
        continue;
      }
      const scope: VerifiedIngress = { profileId, connectionId: row.connection_id, channel: "email", context: "direct",
        accountId: row.recipient, source: "worker_email" };
      const ticket = await signVerifiedIngress(env, scope, { inboxId: row.id, lease, attempt: row.attempts });
      await receiveExtensionIngress(env, profileId, ticket);
    } catch (error) {
      const permanent = error instanceof ApiError && ["email_raw_changed", "email_too_large", "email_mime_invalid", "email_parse_limit", "email_html_too_large"].includes(error.code);
      await exec(env, `UPDATE email_channel_inbox SET state=?,lease_until=NULL,next_at=?,error_code=?,updated=?
        WHERE id=? AND state='processing' AND lease_until=? AND attempts=?`,
      permanent ? "quarantine" : row.attempts >= 5 ? "error" : "pending", time + Math.min(60_000 * 2 ** row.attempts, DAY),
      permanent && error instanceof ApiError ? error.code : "email_processing_failed", time, row.id, lease, row.attempts);
    }
  }
}

async function nextPending(env: Env, profileId: string, time: number) {
  const row = await one<{ due: number | null }>(env, `SELECT min(CASE WHEN state='processing' THEN lease_until ELSE next_at END) due
    FROM email_channel_inbox WHERE profile_id=? AND state IN ('pending','processing')`, profileId);
  return { nextAt: row?.due == null ? null : Math.max(time + 1000, row.due), pending: row?.due != null };
}

/** Cron-only cleanup. Pagination cursor is durable in existing instance_settings;
 * it is not a queue and never touches a WhatsApp/DM message or its alarm path. */
export async function collectEmailStorage(env: Env, profileId: string, time: number): Promise<void> {
  const expired = await all<EmailInboxRow>(env, `SELECT * FROM email_channel_inbox WHERE profile_id=? AND raw_key IS NOT NULL
    AND ((state='processed' AND updated<?) OR (state NOT IN ('pending','processing','processed') AND updated<?))
    ORDER BY updated,id LIMIT 30`, profileId, time - 7 * DAY, time - 30 * DAY);
  for (const row of expired) {
    if (row.state !== "processed" && row.updated > time - 30 * DAY) continue;
    await env.MEDIA.delete(row.raw_key!);
    await exec(env, `UPDATE email_channel_inbox SET raw_key=NULL,
      sender=CASE WHEN state='processed' THEN sender ELSE '' END,
      recipient=CASE WHEN state='processed' THEN recipient ELSE '' END,
      rfc_message_id=CASE WHEN state='processed' THEN rfc_message_id ELSE NULL END,
      metadata=CASE WHEN state='processed' THEN metadata ELSE '{}' END WHERE id=? AND raw_key=?`, row.id, row.raw_key);
  }
  for (const prefix of [`email-raw/${profileId}/`, `email-attachment/${profileId}/`]) {
    const settingKey = `c2.email.gc:${prefix}`;
    const saved = await one<{ value: string }>(env, "SELECT value FROM instance_settings WHERE key=?", settingKey);
    const listed = await env.MEDIA.list({ prefix, limit: 100, ...(saved?.value ? { cursor: saved.value } : {}) });
    for (const item of listed.objects) {
      if (item.uploaded.getTime() > time - DAY) continue;
      const retained = prefix.startsWith("email-raw/")
        ? await one(env, "SELECT id FROM email_channel_inbox WHERE profile_id=? AND raw_key=?", profileId, item.key)
        : await one(env, `SELECT id FROM media WHERE profile_id=? AND object_key=? UNION ALL
          SELECT id FROM email_channel_inbox WHERE profile_id=? AND id=? AND state IN ('pending','processing') LIMIT 1`,
        profileId, item.key, profileId, item.key.slice(prefix.length).split("/")[0]);
      if (!retained) await env.MEDIA.delete(item.key);
    }
    await exec(env, `INSERT INTO instance_settings(key,value,updated) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated`, settingKey, listed.truncated ? listed.cursor : "", time);
  }
}

export const emailMaintenance: ChannelMaintenance = {
  key: MAINTENANCE_KEY,
  async run(ctx) { await processPending(ctx.env, ctx.profileId, ctx.now); return nextPending(ctx.env, ctx.profileId, ctx.now); },
  async recover(ctx) {
    // An orphan can exist even if the first inbox insert failed. Keep collecting
    // while the connection exists, or while historical receipts still remain.
    if (!await one(ctx.env, `SELECT 1 FROM connections WHERE profile_id=? AND channel='email'
      UNION ALL SELECT 1 FROM email_channel_inbox WHERE profile_id=? LIMIT 1`, ctx.profileId, ctx.profileId)) return { nextAt: null, pending: false };
    await exec(ctx.env, "UPDATE email_channel_probes SET state='expired' WHERE profile_id=? AND state='pending' AND expires<=?", ctx.profileId, ctx.now);
    await collectEmailStorage(ctx.env, ctx.profileId, ctx.now);
    return nextPending(ctx.env, ctx.profileId, ctx.now);
  },
};

/** Explicit erasure hook for the integration's personal-data deletion workflow.
 * It includes durable pending raw data; normal media never exposes MIME blobs. */
export async function eraseEmailContact(env: Env, profileId: string, contactId: string): Promise<void> {
  // O vínculo cadastral não é prova do remetente. Aqui ele serve somente para
  // aplicar o pedido humano de exclusão aos dados operacionais já vinculados.
  const scopes = await all<{ connection_id: string; sender: string }>(env, `SELECT DISTINCT c.id connection_id,i.subject_id sender
    FROM customer_channel_ids i JOIN connections c ON c.profile_id=i.profile_id AND c.channel='email'
      AND json_extract(c.config,'$.address')=i.account_id
    WHERE i.profile_id=? AND i.contact_id=? AND i.channel='email' AND i.subject_namespace='email-address'
    UNION SELECT DISTINCT coalesce(v.connection_id,substr(v.external_namespace,9)),i.subject_id
    FROM customer_channel_ids i JOIN conversations v ON v.profile_id=i.profile_id AND v.channel_identity_id=i.id AND v.channel='email'
    WHERE i.profile_id=? AND i.contact_id=? AND i.channel='email' AND i.subject_namespace='email-address'`,
  profileId, contactId, profileId, contactId);
  for (const scope of scopes) await eraseEmailData(env, profileId, scope.connection_id, scope.sender);
}
export async function eraseEmailData(env: Env, profileId: string, connectionId: string, sender: string): Promise<void> {
  const address = normalizeEmailAddress(sender);
  const senderHash = await sha(address);
  const conversations = await all<{ id: string }>(env, `SELECT id FROM conversations WHERE profile_id=?
    AND (connection_id=? OR external_namespace=?) AND channel='email' AND channel_subject_id=?`, profileId, connectionId, `channel:${connectionId}`, address);
  const conversationIds = JSON.stringify(conversations.map(conversation => conversation.id));
  const referencedMedia = await all<{ id: string; object_key: string }>(env, `SELECT DISTINCT m.id,m.object_key FROM media m WHERE m.profile_id=? AND m.id IN (
    SELECT a.value FROM messages v,json_each(v.attachments) a WHERE v.profile_id=? AND v.conversation_id IN (SELECT value FROM json_each(?))
    UNION SELECT json_extract(a.value,'$.mediaId') FROM outbox o,json_each(o.payload,'$.c2.delivery.attachments') a
      WHERE o.profile_id=? AND o.conversation_id IN (SELECT value FROM json_each(?)))`,
  profileId, profileId, conversationIds, profileId, conversationIds);
  // Anexos enviados também são dados pessoais. Uma cópia usada fora deste
  // atendimento conserva a própria política de retenção, sem apagar outro recurso.
  const retainedMedia = new Set<string>(), retainedKeys = new Set<string>();
  const exclusiveMedia = new Set<string>();
  const eraseOwnedMedia = async (media: { id: string; object_key: string }) => {
    if (retainedMedia.has(media.id) || exclusiveMedia.has(media.id)) return;
    const shared = await one(env, `SELECT 1 FROM messages v,json_each(v.attachments) a
      WHERE v.profile_id=? AND v.conversation_id NOT IN (SELECT value FROM json_each(?)) AND a.value=?
      UNION ALL SELECT 1 FROM outbox o,json_each(o.payload,'$.c2.delivery.attachments') a
      WHERE o.profile_id=? AND (o.conversation_id IS NULL OR o.conversation_id NOT IN (SELECT value FROM json_each(?)))
        AND json_extract(a.value,'$.mediaId')=?
      UNION ALL SELECT 1 FROM outbox o WHERE o.profile_id=?
        AND (o.conversation_id IS NULL OR o.conversation_id NOT IN (SELECT value FROM json_each(?)))
        AND (json_extract(o.payload,'$.media_id')=? OR EXISTS(SELECT 1 FROM json_each(o.payload,'$.attachments') a
          WHERE CASE WHEN a.type='object' THEN json_extract(a.value,'$.mediaId') ELSE a.value END=?)) LIMIT 1`,
      profileId, conversationIds, media.id, profileId, conversationIds, media.id, profileId, conversationIds, media.id, media.id);
    if (shared) { retainedMedia.add(media.id); retainedKeys.add(media.object_key); }
    else {
      await env.MEDIA.delete(media.object_key); await exec(env, "DELETE FROM media WHERE id=? AND profile_id=?", media.id, profileId);
      exclusiveMedia.add(media.id);
    }
  };
  for (const media of referencedMedia) await eraseOwnedMedia(media);
  const rows = await all<EmailInboxRow>(env, "SELECT * FROM email_channel_inbox WHERE profile_id=? AND connection_id=? AND sender=?", profileId, connectionId, address);
  for (const row of rows) {
    if (row.raw_key) await env.MEDIA.delete(row.raw_key);
    const attachmentPrefix = `email-attachment/${profileId}/${row.id}/`;
    // O ID inclui o hash completo; o prefixo excede o limite de padrões LIKE
    // do D1. Compare literalmente, com o mesmo escopo usado no R2.
    const media = await all<{ id: string; object_key: string }>(env,
      "SELECT id,object_key FROM media WHERE profile_id=? AND substr(object_key,1,length(?))=?", profileId, attachmentPrefix, attachmentPrefix);
    for (const item of media) await eraseOwnedMedia(item);
    let orphanCursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: attachmentPrefix, limit: 100, cursor: orphanCursor });
      for (const item of page.objects) if (!retainedKeys.has(item.key)) await env.MEDIA.delete(item.key);
      orphanCursor = page.truncated ? page.cursor : undefined;
    } while (orphanCursor);
    await batch(env, [
      ["DELETE FROM email_channel_inbox WHERE id=? AND profile_id=?", [row.id, profileId]],
      ["DELETE FROM inbox WHERE id=? AND profile_id=?", [row.id, profileId]],
      ["UPDATE messages SET text='',attachments='[]',content='{}',author='customer:erased',external_id=NULL WHERE id=? AND profile_id=?", [row.message_id, profileId]],
      ...media.filter(item => !retainedMedia.has(item.id)).map(item => ["DELETE FROM media WHERE id=? AND profile_id=?", [item.id, profileId]] as Statement),
    ]);
  }
  // Include raw objects whose D1 registration failed. Only the hash is kept in
  // private R2 metadata, so a deletion does not need to parse hostile orphan MIME.
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix: `email-raw/${profileId}/`, limit: 100, cursor, include: ["customMetadata"] });
    for (const item of page.objects) if (item.customMetadata?.connection_id === connectionId && item.customMetadata.sender_hash === senderHash)
      await env.MEDIA.delete(item.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (const conversation of conversations) await batch(env, [
    ["UPDATE conversations SET channel_subject_id=NULL,external_id=?,title='Contato excluído',channel_context='{}',epoch=epoch+1 WHERE id=? AND profile_id=?",
      [`erased:${conversation.id}`, conversation.id, profileId]],
    ["UPDATE messages SET text='',attachments='[]',content='{}',author='erased',external_id=NULL WHERE conversation_id=? AND profile_id=?", [conversation.id, profileId]],
    ["UPDATE inbox SET payload='{}',status='done' WHERE conversation_id=? AND profile_id=?", [conversation.id, profileId]],
    [`UPDATE outbox SET payload='{}',completion_handled=1,status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='sending' THEN 'unknown' ELSE status END
      WHERE conversation_id=? AND profile_id=? AND kind='channel'`, [conversation.id, profileId]],
    ["UPDATE email_log SET to_masked='',to_hash='',provider_message_id=NULL WHERE conversation_id=? AND profile_id=? AND purpose LIKE 'channel.email%'", [conversation.id, profileId]],
    ["UPDATE channel_delivery_state SET result_context='{}' WHERE profile_id=? AND resource_key=?", [profileId, `conversation:${conversation.id}`]],
    ["UPDATE events SET payload='{}' WHERE profile_id=? AND (resource_id=? OR resource_id IN (SELECT id FROM messages WHERE conversation_id=? AND profile_id=?))",
      [profileId, conversation.id, conversation.id, profileId]],
  ]);
  await exec(env, "DELETE FROM email_channel_blocks WHERE profile_id=? AND connection_id=? AND kind='address' AND value=?", profileId, connectionId, address);
}
