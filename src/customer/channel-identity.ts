import { all, one } from "../db";
import { allows } from "../access";
import { sha } from "../security";
import { ApiError, now, json, type Actor, type Conversation, type Env } from "../types";
import { visibleConversation, boundAllows } from "../visibility";
import { searchText } from "../contact-csv";
import type { ChannelIdentityPlan, ChannelIdentityPort } from "../channel-ports";
import type { CustomerChannelsView } from "../channel-contracts";
import type { CustomerRef, LinkState, SocialInboundEvidence, Statement } from "./contracts";
import { contactRow, customerAccess } from "./local";
import { previewContactMerge, mergeContacts, undoContactMerge } from "./merge";
import { assertVerifiedIngress } from "../channel-extension-kernel";

const emptyRef = (c: Conversation): CustomerRef & { verifiedPhone: null } => ({
  profileId: c.profile_id, namespace: "team", state: "pending", contactId: null,
  verifiedPhone: null, verifiedChannel: null, version: null, erp: null,
});
const denied = () => new ApiError(403, "invalid_channel_evidence", "A origem desta identidade não foi confirmada.");
// Mesmo limite do leitor social: a composição não pode rejeitar um sujeito
// autenticado que o transporte acabou de normalizar.
const opaque = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(s);
const presentation = (s: unknown) => typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) : "";

/** Somente entrada autenticada chama este adaptador. O lote deve inserir a
 * conversa antes destas instruções e confirmar inbox/mensagem junto delas. */
export async function prepareChannelInbound(env: Env, c: Conversation, evidence: SocialInboundEvidence): Promise<ChannelIdentityPlan> {
  if (!["instagram", "facebook"].includes(evidence.channel) || evidence.subjectNamespace !== "dm")
    return prepareExtensionIdentity(env, c, evidence);
  if (!["instagram", "facebook"].includes(evidence.channel))
    throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
  if (evidence.provider !== "zernio" || evidence.subjectNamespace !== "dm" ||
      !opaque(evidence.accountId) || !opaque(evidence.subjectId) ||
      !c.connection_id || c.external_namespace !== `channel:${c.connection_id}` || c.chat_type !== "direct" ||
      c.channel !== evidence.channel || c.channel_account_id !== evidence.accountId || c.channel_subject_id !== evidence.subjectId ||
      evidence.phone !== undefined || evidence.phoneJid !== undefined) throw denied();
  const account = await one(env,
    `SELECT a.connection_id FROM zernio_channel_accounts a JOIN connections k ON k.id=a.connection_id AND k.profile_id=a.profile_id
     WHERE a.profile_id=? AND a.connection_id=? AND a.channel=? AND a.account_id=? AND k.channel=a.channel AND k.kind='zernio'`,
    c.profile_id, c.connection_id, evidence.channel, evidence.accountId);
  if (!account) throw denied();
  const key = [c.profile_id, "team", evidence.channel, evidence.accountId, evidence.subjectNamespace, evidence.subjectId];
  const old = await one(env,
    `SELECT i.*,k.version contact_version,k.identity_state,k.merged_into,k.erp_contact_id,k.erp_version
     FROM customer_channel_ids i LEFT JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id AND k.namespace=i.namespace
     WHERE i.profile_id=? AND i.namespace=? AND i.channel=? AND i.account_id=? AND i.subject_namespace=? AND i.subject_id=?`, ...key);
  // IDs determinísticos permitem duas preparações concorrentes da mesma
  // primeira entrada sem deixar uma segunda ficha sem dono.
  const digest = await sha(JSON.stringify(key));
  const identityId = old?.id ?? `channel:${digest}`;
  const contactId = old?.contact_id ?? `social:${digest}`;
  const blocked = c.customer_link_state === "blocked" || old?.state === "blocked";
  const excluded = c.customer_link_state === "excluded" || old?.state === "erased" ||
    (!!old && (!old.contact_id || old.identity_state !== "active" || old.merged_into));
  const ready = !blocked && !excluded && (!old || old.state === "ready");
  const state: LinkState = blocked ? "blocked" : excluded ? "excluded" : ready ? "ready" : old?.state === "ambiguous" ? "ambiguous" : "pending";
  const time = now();
  const name = evidence.displayName === undefined ? old?.display_name ?? "" : presentation(evidence.displayName);
  const username = evidence.username === undefined ? old?.username ?? "" : presentation(evidence.username);
  const statements: Statement[] = [[
    `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN
       EXISTS(SELECT 1 FROM zernio_channel_accounts a JOIN connections k ON k.id=a.connection_id AND k.profile_id=a.profile_id
         WHERE a.profile_id=? AND a.connection_id=? AND a.channel=? AND a.account_id=? AND k.channel=a.channel AND k.kind='zernio')
       AND EXISTS(SELECT 1 FROM conversations v WHERE v.id=? AND v.profile_id=? AND v.connection_id=?
         AND v.external_namespace='channel:'||v.connection_id AND v.chat_type='direct' AND v.channel=?
         AND v.channel_account_id=? AND v.channel_subject_id=?
         AND (v.customer_link_state IS ? OR (?=1 AND v.customer_link_state='ready' AND v.channel_identity_id=?)))
       AND ${old ? `EXISTS(SELECT 1 FROM customer_channel_ids i LEFT JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id AND k.namespace=i.namespace
         WHERE i.id=? AND i.profile_id=? AND i.version=? AND i.state=? AND i.contact_id IS ?
           AND k.version IS ? AND k.identity_state IS ? AND k.merged_into IS ?)` : `NOT EXISTS(SELECT 1 FROM customer_channel_ids i
         WHERE i.profile_id=? AND i.namespace=? AND i.channel=? AND i.account_id=? AND i.subject_namespace=? AND i.subject_id=?
           AND (i.id<>? OR i.contact_id IS NOT ? OR i.state<>'ready' OR i.version<>1))
         AND NOT EXISTS(SELECT 1 FROM contacts k WHERE k.id=? AND (k.profile_id<>? OR k.namespace<>'team' OR k.identity_state<>'active' OR k.merged_into IS NOT NULL))`}
       THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [`channel-inbound:${c.id}`, c.profile_id, c.connection_id, evidence.channel, evidence.accountId,
      c.id, c.profile_id, c.connection_id, evidence.channel, evidence.accountId, evidence.subjectId, c.customer_link_state ?? "pending", ready ? 1 : 0, identityId,
      ...(old ? [old.id, c.profile_id, old.version, old.state, old.contact_id, old.contact_version ?? null, old.identity_state ?? null, old.merged_into ?? null]
        : [...key, identityId, contactId, contactId, c.profile_id])],
  ]];
  if (!old && ready) statements.push([
    `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
     VALUES(?,?,'team',?,'',?,'automatic','channel_identity','channel_identity',?,?) ON CONFLICT(id) DO NOTHING`,
    [contactId, c.profile_id, name || `Contato do ${evidence.channel === "instagram" ? "Instagram" : "Facebook"}`, searchText(`${name} ${username}`), time, time],
  ], [
    `INSERT INTO customer_channel_ids(id,profile_id,namespace,channel,account_id,subject_namespace,subject_id,display_name,username,
       contact_id,connection_id,proof_conversation_id,state,created,updated)
     VALUES(?,?,'team',?,?,?,?,?,?,?,?,?,'ready',?,?)
     ON CONFLICT(profile_id,namespace,channel,account_id,subject_namespace,subject_id) DO NOTHING`,
    [identityId, c.profile_id, evidence.channel, evidence.accountId, evidence.subjectNamespace, evidence.subjectId,
      name, username, contactId, c.connection_id, c.id, time, time],
  ]);
  if (old && ready && (old.display_name !== name || old.username !== username)) statements.push([
    "UPDATE customer_channel_ids SET display_name=?,username=?,version=version+1,updated=? WHERE id=? AND profile_id=? AND state='ready'",
    [name, username, time, identityId, c.profile_id],
  ]);
  // Um pedido já bloqueado sem identidade não cria dados por outro caminho.
  statements.push([
    `UPDATE conversations SET channel_identity_id=?,verified_phone=NULL,customer_identity_proof=NULL,customer_link_state=?
     WHERE id=? AND profile_id=?`, [old || ready ? identityId : null, state, c.id, c.profile_id],
  ]);
  if (ready) statements.push([
    `INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'channel_identity',?)
     ON CONFLICT(conversation_id) DO UPDATE SET contact_id=excluded.contact_id,linked_by=excluded.linked_by
       WHERE conversation_contacts.profile_id=excluded.profile_id`, [c.id, c.profile_id, contactId, time],
  ], [
    `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
     VALUES(?,'conversations','session',?,?,?,'channel_identity',?) ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
    [c.profile_id, `${c.id}:${c.session}`, contactId, c.id, time],
  ]);
  const customer = { ...emptyRef(c), state, ...(ready ? {
    contactId, version: old?.contact_version ?? 1,
    verifiedChannel: { identityId, channel: evidence.channel, accountId: evidence.accountId, subjectNamespace: evidence.subjectNamespace, subjectId: evidence.subjectId },
    erp: old?.erp_contact_id && old.erp_version !== null ? { id: old.erp_contact_id, version: old.erp_version } : null,
  } : {}) };
  return { statements, identityId, customer };
}

/** Reconsulta a prova persistida; valores fornecidos pelo cliente ou ficha
 * administrativa nunca bastam para produzir verifiedChannel. */
export async function resolveChannelCustomer(env: Env, c: Conversation): Promise<CustomerRef> {
  if (!["instagram", "facebook"].includes(c.channel ?? "") ||
      c.chat_type === "comment" || json(c.channel_context).context === "comment") return resolveExtensionIdentity(env, c);
  const base = emptyRef(c);
  const row = await one(env,
    `SELECT v.customer_link_state,i.*,k.version contact_version,k.identity_state,k.merged_into,k.erp_contact_id,k.erp_version
     FROM conversations v JOIN customer_channel_ids i ON i.id=v.channel_identity_id AND i.profile_id=v.profile_id AND i.namespace='team'
       AND i.channel=v.channel AND i.account_id=v.channel_account_id AND i.subject_namespace='dm' AND i.subject_id=v.channel_subject_id
     JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id AND k.namespace=i.namespace
     JOIN zernio_channel_accounts a ON a.connection_id=v.connection_id AND a.profile_id=v.profile_id AND a.channel=i.channel AND a.account_id=i.account_id
     WHERE v.id=? AND v.profile_id=? AND v.external_namespace=? AND v.external_namespace='channel:'||v.connection_id AND v.chat_type='direct'`,
    c.id, c.profile_id, c.external_namespace);
  if (!row) return base;
  if (row.customer_link_state === "blocked" || row.state === "blocked") return { ...base, state: "blocked" };
  if (row.customer_link_state === "excluded" || row.state === "erased" || row.identity_state !== "active" || row.merged_into) return { ...base, state: "excluded" };
  if (row.customer_link_state !== "ready" || row.state !== "ready" || !row.proof_conversation_id) return base;
  return { ...base, state: "ready", contactId: row.contact_id, version: row.contact_version,
    verifiedChannel: { identityId: row.id, channel: row.channel, accountId: row.account_id, subjectNamespace: row.subject_namespace, subjectId: row.subject_id },
    erp: row.erp_contact_id && row.erp_version !== null ? { id: row.erp_contact_id, version: row.erp_version } : null };
}

export async function readCustomerChannels(env: Env, actor: Actor, profileId: string, contactId: string): Promise<CustomerChannelsView> {
  customerAccess(actor, profileId);
  const contact = await contactRow(env, actor, profileId, contactId);
  if (actor.kind !== "user" || actor.via || contact.identity_state !== "active") return { channels: [], other_conversations: [] };
  const rows = await all(env,
    `SELECT i.id,i.channel,coalesce(nullif(a.account_label,''),k.account_label,'') account_label,i.display_name,i.username,i.state,i.connection_id
     FROM customer_channel_ids i LEFT JOIN zernio_channel_accounts a ON a.connection_id=i.connection_id AND a.profile_id=i.profile_id
     LEFT JOIN connections k ON k.id=i.connection_id AND k.profile_id=i.profile_id
     WHERE i.profile_id=? AND i.namespace=? AND i.contact_id=? AND i.state<>'erased' ORDER BY i.channel,i.created,i.id`,
    profileId, contact.namespace, contact.id);
  const conversations = allows(actor, "conversations") ? await all(env,
    `SELECT v.*,k.channel connection_channel,k.account_label connection_account_label FROM conversations v
     LEFT JOIN connections k ON k.id=v.connection_id AND k.profile_id=v.profile_id
     WHERE v.profile_id=? AND (EXISTS(SELECT 1 FROM conversation_contacts l
       WHERE l.profile_id=v.profile_id AND l.conversation_id=v.id AND l.contact_id=?) OR v.customer_identity_proof=?)
     ORDER BY v.updated DESC,v.id DESC LIMIT 101`, profileId, contact.id, contact.id) : [];
  const visible = [];
  const phones = new Set<string>();
  for (const v of conversations) if (visibleConversation(actor, v) && await boundAllows(env, actor, v)) {
    const channel = v.channel ?? (v.connection_channel === "whatsapp" && v.verified_phone ? "whatsapp" : null);
    visible.push({ id: v.id, channel, account_label: v.account_label || v.connection_account_label || "",
      title: contact.name || "Conversa", state: v.state, updated: v.updated });
    if (channel === "whatsapp" && v.customer_identity_proof === contact.id && v.customer_link_state === "ready" &&
        v.connection_id && v.external_namespace === `channel:${v.connection_id}` && !phones.has(v.connection_id)) {
      phones.add(v.connection_id);
      rows.push({ id: `whatsapp:${v.connection_id}`, channel: "whatsapp", account_label: v.connection_account_label || "",
        display_name: contact.name, username: "", state: "ready", connection_id: v.connection_id });
    }
  }
  // A ficha só expõe IDs locais e apresentação, nunca account_id/subject_id.
  return { channels: rows, other_conversations: visible.slice(0, 100) };
}

/** Instalado explicitamente por cn-servidor em channel-runtime.ts. */
export const channelIdentityImplementation: ChannelIdentityPort = {
  channels: ["instagram", "facebook", "telegram", "email", "tiktok"], prepareInbound: prepareChannelInbound,
  readChannels: readCustomerChannels, previewMerge: previewContactMerge, merge: mergeContacts, undoMerge: undoContactMerge,
};

/** O namespace é parte da prova. Comentário nunca equivale à DM do autor. */
function extensionSubject(channel: Conversation["channel"], context: string): string | null {
  if ((channel === "instagram" || channel === "facebook") && context === "comment") return "comment-author";
  if (channel === "telegram" && context === "direct") return "telegram-user";
  if (channel === "tiktok" && context === "direct") return "dm";
  if (channel === "email" && context === "direct") return "email-address";
  return null;
}

async function prepareExtensionIdentity(env: Env, c: Conversation, evidence: SocialInboundEvidence): Promise<ChannelIdentityPlan> {
  const scope = evidence.ingress;
  if (!scope) throw denied();
  assertVerifiedIngress(scope);
  const namespace = extensionSubject(evidence.channel, scope.context);
  const context = c.chat_type === "comment" ? "comment" : json(c.channel_context).context || "direct";
  const provider = scope.source === "telegram_secret" ? "telegram_bot" : scope.source === "worker_email" ? "email" : "zernio";
  if (!namespace || scope.context !== context || namespace !== evidence.subjectNamespace || provider !== evidence.provider ||
      !opaque(evidence.subjectId) || !opaque(evidence.accountId) ||
      scope.profileId !== c.profile_id || scope.connectionId !== c.connection_id ||
      scope.channel !== c.channel || scope.channel !== evidence.channel || scope.accountId !== evidence.accountId ||
      c.channel_account_id !== evidence.accountId || c.channel_subject_id !== evidence.subjectId ||
      c.external_namespace !== `channel:${c.connection_id}` || (scope.context === "comment" ? !["direct", "comment"].includes(c.chat_type) : c.chat_type !== "direct") ||
      evidence.phone !== undefined || evidence.phoneJid !== undefined) throw denied();
  const connectionGuard = provider === "zernio"
    ? `EXISTS(SELECT 1 FROM connections k JOIN zernio_channel_accounts a ON a.connection_id=k.id AND a.profile_id=k.profile_id
       AND a.channel=k.channel WHERE k.id=? AND k.profile_id=? AND k.channel=? AND k.kind=? AND k.status='active' AND a.account_id=?)`
    : `EXISTS(SELECT 1 FROM connections k WHERE k.id=? AND k.profile_id=? AND k.channel=? AND k.kind=? AND k.status='active'
        AND CAST(coalesce(json_extract(k.config,'$.${provider === "email" ? "address" : "bot_id"}'),json_extract(k.config,'$.account_id')) AS TEXT)=?)`;
  const connectionParams = [c.connection_id, c.profile_id, c.channel, provider, evidence.accountId];
  if (!(await one(env, `SELECT 1 ok WHERE ${connectionGuard}`, ...connectionParams))) throw denied();
  const key = [c.profile_id, "team", evidence.channel, evidence.accountId, namespace, evidence.subjectId];
  const old = await one(env, `SELECT i.*,k.version contact_version,k.identity_state,k.merged_into
    FROM customer_channel_ids i LEFT JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id AND k.namespace=i.namespace
    WHERE i.profile_id=? AND i.namespace=? AND i.channel=? AND i.account_id=? AND i.subject_namespace=? AND i.subject_id=?`, ...key);
  const digest = await sha(JSON.stringify(key));
  const identityId = old?.id ?? `channel:${digest}`;
  const contactId = old?.contact_id ?? `social:${digest}`;
  const blocked = c.customer_link_state === "blocked" || old?.state === "blocked";
  const excluded = c.customer_link_state === "excluded" || old?.state === "erased" ||
    (!!old && (!old.contact_id || old.identity_state !== "active" || old.merged_into));
  const ready = !blocked && !excluded && (!old || old.state === "ready");
  const state: LinkState = blocked ? "blocked" : excluded ? "excluded" : ready ? "ready" : old?.state === "ambiguous" ? "ambiguous" : "pending";
  const time = now(), name = presentation(evidence.displayName ?? old?.display_name), username = presentation(evidence.username ?? old?.username);
  const statements: Statement[] = [[`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN ${connectionGuard}
    AND EXISTS(SELECT 1 FROM conversations v WHERE v.id=? AND v.profile_id=? AND v.connection_id=? AND v.channel=?
      AND v.channel_account_id=? AND v.channel_subject_id=? AND ${scope.context === "comment" ? "(v.chat_type='comment' OR (v.chat_type='direct' AND json_extract(v.channel_context,'$.context')='comment'))" : "v.chat_type='direct'"} AND v.external_namespace='channel:'||v.connection_id
      AND (v.customer_link_state IS ? OR (?=1 AND v.customer_link_state='ready' AND v.channel_identity_id=?)))
    AND ${old ? `EXISTS(SELECT 1 FROM customer_channel_ids i LEFT JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id
      WHERE i.id=? AND i.version=? AND i.state=? AND i.contact_id IS ? AND k.version IS ? AND k.identity_state IS ? AND k.merged_into IS ?)`
      : `NOT EXISTS(SELECT 1 FROM customer_channel_ids i WHERE i.profile_id=? AND i.namespace=? AND i.channel=? AND i.account_id=?
          AND i.subject_namespace=? AND i.subject_id=? AND (i.id<>? OR i.contact_id IS NOT ? OR i.state<>'ready'))
         AND NOT EXISTS(SELECT 1 FROM contacts k WHERE k.id=? AND (k.profile_id<>? OR k.namespace<>'team' OR k.identity_state<>'active' OR k.merged_into IS NOT NULL))`}
    THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [`channel-inbound:${c.id}`, ...connectionParams, c.id, c.profile_id, c.connection_id, c.channel, evidence.accountId, evidence.subjectId,
      c.customer_link_state ?? "pending", ready ? 1 : 0, identityId,
      ...(old ? [old.id, old.version, old.state, old.contact_id, old.contact_version ?? null, old.identity_state ?? null, old.merged_into ?? null]
        : [...key, identityId, contactId, contactId, c.profile_id])]]];
  if (!old && ready) statements.push([
    `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
     VALUES(?,?,'team',?,'',?,'automatic','channel_identity','channel_identity',?,?) ON CONFLICT(id) DO NOTHING`,
    [contactId, c.profile_id, name || "Contato", searchText(`${name} ${username}`), time, time],
  ], [
    `INSERT INTO customer_channel_ids(id,profile_id,namespace,channel,account_id,subject_namespace,subject_id,display_name,username,
      contact_id,connection_id,proof_conversation_id,state,created,updated) VALUES(?,?,'team',?,?,?,?,?,?,?,?,?,'ready',?,?)
      ON CONFLICT(profile_id,namespace,channel,account_id,subject_namespace,subject_id) DO NOTHING`,
    [identityId, c.profile_id, evidence.channel, evidence.accountId, namespace, evidence.subjectId, name, username,
      // Campo legado satisfaz o vínculo cadastral; em e-mail nunca é prova de pessoa.
      contactId, c.connection_id, c.id, time, time],
  ]);
  if (old && ready && (old.display_name !== name || old.username !== username)) statements.push([
    "UPDATE customer_channel_ids SET display_name=?,username=?,version=version+1,updated=? WHERE id=? AND profile_id=? AND state='ready'",
    [name, username, time, identityId, c.profile_id],
  ]);
  statements.push(["UPDATE conversations SET channel_identity_id=?,verified_phone=NULL,customer_identity_proof=NULL,customer_link_state=? WHERE id=? AND profile_id=?",
    [old || ready ? identityId : null, state, c.id, c.profile_id]]);
  if (ready) statements.push([
    `INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'channel_identity',?)
      ON CONFLICT(conversation_id) DO UPDATE SET contact_id=excluded.contact_id,linked_by=excluded.linked_by WHERE conversation_contacts.profile_id=excluded.profile_id`,
    [c.id, c.profile_id, contactId, time],
  ], [
    `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
      VALUES(?,'conversations','session',?,?,?,'channel_identity',?) ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
    [c.profile_id, `${c.id}:${c.session}`, contactId, c.id, time],
  ]);
  const trust = evidence.channel === "email" ? "unverified_sender" : namespace === "comment-author" ? "none" : "channel";
  return { statements, identityId, customer: { ...emptyRef(c), state, identityTrust: trust,
    ...(ready ? { contactId, version: old?.contact_version ?? 1,
      verifiedChannel: trust === "channel" ? { identityId, channel: evidence.channel, accountId: evidence.accountId, subjectNamespace: namespace, subjectId: evidence.subjectId } : null } : {}) } };
}

async function resolveExtensionIdentity(env: Env, c: Conversation): Promise<CustomerRef> {
  const context = c.chat_type === "comment" ? "comment" : json(c.channel_context).context || "direct";
  const namespace = extensionSubject(c.channel, context);
  const trust = c.channel === "email" ? "unverified_sender" : namespace === "comment-author" ? "none" : "channel";
  const base: CustomerRef = { ...emptyRef(c), identityTrust: trust };
  if (!namespace) return { ...base, identityTrust: "none" };
  const row = await one(env, `SELECT v.customer_link_state,i.*,k.version contact_version,k.identity_state,k.merged_into
    FROM conversations v JOIN customer_channel_ids i ON i.id=v.channel_identity_id AND i.profile_id=v.profile_id AND i.namespace='team'
      AND i.channel=v.channel AND i.account_id=v.channel_account_id AND i.subject_namespace=? AND i.subject_id=v.channel_subject_id
    JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id AND k.namespace=i.namespace
    JOIN connections cn ON cn.id=v.connection_id AND cn.profile_id=v.profile_id AND cn.channel=v.channel
    WHERE v.id=? AND v.profile_id=? AND v.external_namespace='channel:'||v.connection_id AND ${context === "comment" ? "(v.chat_type='comment' OR (v.chat_type='direct' AND json_extract(v.channel_context,'$.context')='comment'))" : "v.chat_type='direct'"}
      AND ${c.channel === "email" || c.channel === "telegram"
        ? `cn.kind='${c.channel === "email" ? "email" : "telegram_bot"}' AND CAST(coalesce(json_extract(cn.config,'$.${c.channel === "email" ? "address" : "bot_id"}'),json_extract(cn.config,'$.account_id')) AS TEXT)=v.channel_account_id`
        : "cn.kind='zernio' AND EXISTS(SELECT 1 FROM zernio_channel_accounts a WHERE a.connection_id=cn.id AND a.profile_id=cn.profile_id AND a.channel=v.channel AND a.account_id=v.channel_account_id)"}`, namespace, c.id, c.profile_id);
  if (!row) return base;
  if (row.customer_link_state === "blocked" || row.state === "blocked") return { ...base, state: "blocked" };
  if (row.customer_link_state === "excluded" || row.state === "erased" || row.identity_state !== "active" || row.merged_into) return { ...base, state: "excluded" };
  if (row.customer_link_state !== "ready" || row.state !== "ready") return base;
  return { ...base, state: "ready", contactId: row.contact_id, version: row.contact_version,
    verifiedChannel: trust === "channel" && row.proof_conversation_id ? {
      identityId: row.id, channel: row.channel, accountId: row.account_id, subjectNamespace: namespace, subjectId: row.subject_id,
    } : null };
}
