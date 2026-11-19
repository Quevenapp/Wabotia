/** Canal de e-mail. A composição instala o descritor explicitamente, sem I/O. */
import type { ChannelConnectionDriver, ChannelExtension, ChannelOperationContext, ChannelRouteContext, ExtensionConnection } from "../channel-c2-contracts";
import type { ChannelConnection, ChannelSpec } from "../channel-contracts";
import { all, batch, exec, one } from "../db";
import { emailReady, normalizeEmailDomain, type ChannelEmailTransport } from "../email";
import { ApiError, json, requireValue, type Conversation } from "../types";
import { sha } from "../security";
import { configureChannelConnection } from "../channel-extension-kernel";
import { boundAllows, visibleConversation } from "../visibility";
import { assertDepartmentAccess } from "../departments";
import { emailMaintenance, normalizeEmailIngress, prepareEmailInbound, receiveEmail } from "./email-ingress";
import { completeEmail, deliverEmail, emailProviderTransport, emailReplySubject, prepareEmailSend } from "./email-provider";
import { EMAIL_MEDIA_POLICY, normalizeEmailAddress as normalizeMimeAddress } from "./email-mime";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const normalizeEmailAddress = (value: unknown) => normalizeMimeAddress(typeof value === "string" ? value : "");
const missing = (): never => { throw new ApiError(404, "not_found", "Conexão de e-mail não encontrada nesta área."); };

/** Conteúdo para o guia/UI; importar o descritor Worker no navegador não é necessário. */
export const EMAIL_SETUP_GUIDE = Object.freeze([
  "Escolha um domínio ou subdomínio com DNS na Cloudflare.",
  "Configure o recebimento no Email Routing e confira os MX antes de alterar.",
  "Se já usa Google, Microsoft ou outro provedor, preserve seus MX e valide o uso de um subdomínio.",
  "Crie uma regra de endereço exato para o Worker desta instalação.",
  "Configure o mesmo endereço no Wabotia e execute Testar recebimento.",
  "Confira também a configuração de envio em Gestão → Sistema.",
  "Mantenha o nome do Worker. Se ele mudar, revise a regra de recebimento.",
  "O recebimento aceita até 25 MiB. O processamento MIME tem limite local de 8 MiB para proteger a memória; mensagens maiores ficam em quarentena, sem abrir atendimento.",
]);
export const EMAIL_PENDING_CONTRACTS = Object.freeze([
  "Campos REST de MIME, cabeçalhos, anexos e ID retornado: a conferir com a conta real.",
  "Repetição da entrega após falha do handler, MX de subdomínio e nomes do painel: a conferir com a conta real.",
  "A outbox da base ainda não oferece recurso de teste sem conversa; o teste não envia nem ativa a conexão enquanto esse contrato estiver indisponível.",
]);
export const EMAIL_STATES = Object.freeze({
  pending: "Aguardando teste de recebimento", active: "Recebimento confirmado",
  automatic: "Automáticos", blocked: "Bloqueados", quarantine: "Quarentena",
  error: "Falha no processamento", unknown: "Envio indeterminado", inconclusive: "Teste inconclusivo",
  identity: "Remetente não confirmado", credential: "configurado",
});
export const EMAIL_ACKNOWLEDGEMENT = "Recebemos sua mensagem. Nossa equipe dará continuidade ao atendimento.";
export const EMAIL_GENERAL_REPLY = "Este canal fornece informações gerais e encaminha mensagens à equipe. Para consultar dados pessoais, pedidos ou protocolos, use um canal autenticado de atendimento.";

export const emailChannelSpec: ChannelSpec = {
  id: "email", label: "E-mail", enabled: true, transport: "email", serviceLine: true, context: "direct",
  contexts: { direct: { enabled: true, bot: false, publicReply: false } },
  text: { enabled: true, maxChars: 50_000 },
  media: EMAIL_MEDIA_POLICY,
  menu: { buttons: 0, quickReplies: 0, listItems: 0, fallback: "numbered_text" },
  window: { kind: "none" }, initiation: "business", templates: false, subject: true, replyTo: true, bold: "none",
};

export function emailEnabled(connection: ChannelConnection): boolean {
  if (connection.channel !== "email" || connection.kind !== "email") return false;
  const config = record(json(connection.config));
  return config.c2_enabled === true && typeof config.address === "string" && !config.remove_pending;
}

function configuration(input: unknown) {
  const outer = record(input), config = record(outer.config ?? outer);
  for (const key of Object.keys(config)) {
    if (/token|secret|password|smtp|credential|zone|verified|account_id|remove_pending/i.test(key))
      throw new ApiError(400, "invalid_request", "A conexão usa somente o endereço e as opções do canal. Credenciais de envio pertencem ao Sistema.");
  }
  requireValue(!Object.keys(record(outer.secrets)).length, "Não informe credenciais nesta conexão.");
  for (const field of ["c2_enabled", "bot_enabled", "auto_ack_enabled"])
    requireValue(config[field] === undefined || typeof config[field] === "boolean", "Opção de e-mail inválida.");
  return { address: normalizeEmailAddress(config.address), c2_enabled: config.c2_enabled !== false,
    bot_enabled: config.bot_enabled === true, auto_ack_enabled: config.auto_ack_enabled === true };
}

export const emailConnectionDriver: ChannelConnectionDriver = {
  channel: "email",
  validate(input) { return { channel: "email", config: configuration(input) }; },
  async configure(ctx) {
    const config = configuration(ctx.input);
    const old = await one<{ address: string; verified_at: number | null; active: number }>(ctx.env,
      "SELECT address,verified_at,active FROM email_channel_addresses WHERE connection_id=? AND profile_id=?", ctx.connection.id, ctx.profileId);
    if (old && old.address !== config.address && await one(ctx.env,
      `SELECT 1 FROM conversations WHERE connection_id=? AND profile_id=? UNION ALL
       SELECT 1 FROM email_channel_inbox WHERE connection_id=? AND profile_id=? LIMIT 1`,
      ctx.connection.id, ctx.profileId, ctx.connection.id, ctx.profileId))
      throw new ApiError(409, "address_immutable", "Este endereço já possui histórico. Crie outra conexão e teste o novo endereço.");
    const owner = await one<{ connection_id: string }>(ctx.env, "SELECT connection_id FROM email_channel_addresses WHERE address=?", config.address);
    if (owner && owner.connection_id !== ctx.connection.id)
      throw new ApiError(409, "address_in_use", "Este endereço já está reservado por outra conexão.");
    const verified = old?.address === config.address && old.verified_at !== null && old.verified_at !== undefined;
    await batch(ctx.env, [
      [`INSERT INTO email_channel_addresses(connection_id,profile_id,address,active,verified_at,created,updated)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET address=excluded.address,active=excluded.active,
        verified_at=excluded.verified_at,updated=excluded.updated WHERE email_channel_addresses.profile_id=excluded.profile_id`,
      [ctx.connection.id, ctx.profileId, config.address, verified && config.c2_enabled ? 1 : 0, verified ? old!.verified_at : null, ctx.now, ctx.now]],
      ...(!verified ? [["UPDATE email_channel_probes SET state='expired' WHERE connection_id=? AND profile_id=? AND state='pending'", [ctx.connection.id, ctx.profileId]] as [string, unknown[]]] : []),
    ]);
    return { status: verified && config.c2_enabled ? "active" : "pending", configured: true,
      ...(!verified ? { code: "receiving_unverified" } : {}), configuration: config };
  },
  async probe(ctx) {
    const address = await one<{ verified_at: number | null; active: number }>(ctx.env,
      "SELECT verified_at,active FROM email_channel_addresses WHERE connection_id=? AND profile_id=? AND address=?",
      ctx.connection.id, ctx.profileId, json(ctx.connection.config).address ?? "");
    return { status: address?.active && address.verified_at ? "active" : "pending", configured: !!address,
      ...(address?.active && address.verified_at ? {} : { code: "receiving_unverified" }) };
  },
  async remove(ctx) {
    // O ciclo de remoção da base já pausou a conexão. Histórico e brutos seguem a retenção.
    await batch(ctx.env, [
      ["DELETE FROM email_channel_addresses WHERE connection_id=? AND profile_id=?", [ctx.connection.id, ctx.profileId]],
      ["DELETE FROM email_channel_blocks WHERE connection_id=? AND profile_id=?", [ctx.connection.id, ctx.profileId]],
      ["DELETE FROM email_channel_probes WHERE connection_id=? AND profile_id=?", [ctx.connection.id, ctx.profileId]],
    ]);
    return { status: "paused", configured: false };
  },
};

async function connection(ctx: ChannelRouteContext): Promise<ExtensionConnection> {
  const row = await one<ExtensionConnection>(ctx.env, "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='email' AND channel='email'", ctx.params.id, ctx.profileId);
  return row ?? missing();
}

async function setup(ctx: ChannelRouteContext) {
  const row = await connection(ctx), config = record(json(row.config));
  const address = await one<{ active: number; verified_at: number | null }>(ctx.env,
    "SELECT active,verified_at FROM email_channel_addresses WHERE connection_id=? AND profile_id=?", row.id, ctx.profileId);
  const probe = await one<{ state: string; expires: number; received_at: number | null }>(ctx.env,
    "SELECT state,expires,received_at FROM email_channel_probes WHERE connection_id=? AND profile_id=? ORDER BY created DESC,id DESC LIMIT 1", row.id, ctx.profileId);
  return { id: row.id, channel: "email", status: row.status, address: config.address ?? "", configured: !!address,
    sending: await emailReady(ctx.env) ? "configurado" : null, receiving: address?.active === 1 && address.verified_at !== null,
    bot_enabled: config.bot_enabled === true, auto_ack_enabled: config.auto_ack_enabled === true,
    probe: probe ? { state: probe.state === "pending" && probe.expires <= ctx.now ? "expired" : probe.state,
      expires: probe.expires, received_at: probe.received_at } : null,
    guide: EMAIL_SETUP_GUIDE, pending_contracts: EMAIL_PENDING_CONTRACTS, identityTrust: "unverified_sender" };
}

/** Um desafio não é prova de pessoa. Sem uma operação de outbox sem conversa
 * para testes, não criar atendimento fictício nem enviar fora da fila. */
async function startProbe(ctx: ChannelRouteContext) {
  const row = await connection(ctx);
  const previous = await one<{ id: string; state: string; expires: number }>(ctx.env,
    "SELECT id,state,expires FROM email_channel_probes WHERE profile_id=? AND command_id=?", ctx.profileId, ctx.commandId);
  if (previous) return { ...previous, code: "provider_contract_unverified", message: "Teste inconclusivo: o contrato de envio do teste pela outbox está pendente." };
  requireValue(!!await one(ctx.env, "SELECT 1 FROM email_channel_addresses WHERE connection_id=? AND profile_id=?", row.id, ctx.profileId), "Configure o endereço antes do teste.");
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const id = `email-probe:${await sha(JSON.stringify([ctx.profileId, ctx.commandId]))}`;
  await exec(ctx.env, `INSERT INTO email_channel_probes(id,profile_id,connection_id,command_id,token_hash,expires,state,created)
    VALUES(?,?,?,?,?,?,'failed',?) ON CONFLICT(profile_id,command_id) DO NOTHING`,
    id, ctx.profileId, row.id, ctx.commandId, await sha(token), ctx.now + 600_000, ctx.now);
  return { id, state: "failed", expires: ctx.now + 600_000, code: "provider_contract_unverified",
    message: "Teste inconclusivo: o contrato de envio do teste pela outbox está pendente." };
}

function safeMetadata(value: string) {
  const meta = record(json(value));
  return { subject: typeof meta.subject === "string" ? meta.subject.slice(0, 200) : "",
    ...(typeof meta.from === "string" ? { from: meta.from.slice(0, 254) } : {}),
    ...(typeof meta.replyTo === "string" ? { replyTo: meta.replyTo.slice(0, 254) } : {}),
    authentication: Array.isArray(meta.authentication) ? meta.authentication.slice(0, 12).map(entry => {
      const item = record(entry); return { method: String(item.method ?? "").slice(0, 30), result: String(item.result ?? "").slice(0, 30) };
    }) : [],
    attachmentWarnings: Array.isArray(meta.attachmentWarnings) ? meta.attachmentWarnings.filter((v): v is string => typeof v === "string").slice(0, 33).map(v => v.slice(0, 200)) : [],
  };
}
async function inbox(ctx: ChannelRouteContext) {
  const row = await connection(ctx), input = record(ctx.input);
  const state = input.state ?? "automatic";
  requireValue(["automatic", "blocked", "quarantine", "error"].includes(String(state)), "Selecione uma caixa de e-mail.");
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
  let before = Number.MAX_SAFE_INTEGER, beforeId = "\uffff";
  if (input.cursor !== undefined) {
    requireValue(typeof input.cursor === "string" && input.cursor.length <= 400, "Cursor inválido.");
    const cursor = record(json(input.cursor));
    requireValue(Number.isSafeInteger(cursor.created) && typeof cursor.id === "string" && cursor.id.length <= 200, "Cursor inválido.");
    before = Number(cursor.created); beforeId = String(cursor.id);
  }
  const rows = await all<{ id: string; sender: string; recipient: string; state: string; error_code: string | null; metadata: string; created: number }>(ctx.env,
    `SELECT id,sender,recipient,state,error_code,metadata,created FROM email_channel_inbox WHERE profile_id=? AND connection_id=? AND state=?
     AND (created<? OR (created=? AND id<?)) ORDER BY created DESC,id DESC LIMIT ?`,
    ctx.profileId, row.id, state, before, before, beforeId, Math.floor(limit) + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { data: page.map(({ metadata, ...item }) => ({ ...item, ...safeMetadata(metadata), identityTrust: "unverified_sender" })),
    next_cursor: rows.length > limit && last ? JSON.stringify({ created: last.created, id: last.id }) : null };
}

async function block(ctx: ChannelRouteContext, remove: boolean) {
  const row = await connection(ctx), input = record(ctx.input);
  requireValue(input.kind === "address" || input.kind === "domain", "Escolha endereço ou domínio.");
  const value = input.kind === "address" ? normalizeEmailAddress(input.value) : normalizeEmailDomain(input.value);
  if (remove) await exec(ctx.env, "DELETE FROM email_channel_blocks WHERE profile_id=? AND connection_id=? AND kind=? AND value=?", ctx.profileId, row.id, input.kind, value);
  else await exec(ctx.env, `INSERT INTO email_channel_blocks(profile_id,connection_id,kind,value,actor_id,created) VALUES(?,?,?,?,?,?)
    ON CONFLICT(connection_id,kind,value) DO NOTHING`, ctx.profileId, row.id, input.kind, value, ctx.actor.id, ctx.now);
  return { kind: input.kind, value, blocked: !remove };
}

async function newEmail(ctx: ChannelRouteContext, transport: ChannelEmailTransport) {
  const input = record(ctx.input);
  requireValue(input.confirmed === true && typeof input.connectionId === "string", "Confirme o endereço e escolha uma conexão.");
  const to = normalizeEmailAddress(input.address);
  const row = await one<ExtensionConnection>(ctx.env, "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='email' AND channel='email' AND status='active'", input.connectionId, ctx.profileId);
  if (!row || !emailEnabled(row) || !await emailReady(ctx.env))
    throw new ApiError(409, "email_unavailable", "Escolha uma conexão de e-mail com recebimento e envio prontos.");
  const config = record(json(row.config));
  if (!await one(ctx.env, "SELECT 1 FROM email_channel_addresses WHERE connection_id=? AND profile_id=? AND address=? AND active=1 AND verified_at IS NOT NULL", row.id, ctx.profileId, config.address))
    throw new ApiError(409, "receiving_unverified", "Confirme o recebimento desta conexão antes de abrir um e-mail.");
  // A capacidade é conferida antes de criar uma conversa vazia.
  await transport.prepare({ from: String(config.address), to, subject: "Novo e-mail", text: "Verificação local de capacidade.", messageId: "<capability@wabotia.invalid>" });
  if (await one(ctx.env, `SELECT 1 FROM email_channel_blocks WHERE profile_id=? AND connection_id=?
      AND ((kind='address' AND value=?) OR (kind='domain' AND value=?))`, ctx.profileId, row.id, to, to.split("@")[1]))
    throw new ApiError(409, "sender_blocked", "O endereço está bloqueado nesta conexão.");
  const identity = await one<{ state: string; identity_state: string | null }>(ctx.env,
    `SELECT i.state,k.identity_state FROM customer_channel_ids i LEFT JOIN contacts k ON k.id=i.contact_id AND k.profile_id=i.profile_id
     WHERE i.profile_id=? AND i.namespace='team' AND i.channel='email' AND i.account_id=? AND i.subject_namespace='email-address' AND i.subject_id=?`, ctx.profileId, config.address, to);
  if (identity && (identity.state !== "ready" || identity.identity_state !== "active"))
    throw new ApiError(409, "sender_blocked", "A identidade deste endereço está bloqueada ou excluída.");
  const old = await one<Conversation>(ctx.env,
    "SELECT * FROM conversations WHERE profile_id=? AND connection_id=? AND external_namespace=? AND external_id=?", ctx.profileId, row.id, `channel:${row.id}`, `email:${to}`);
  if (old) {
    if (!visibleConversation(ctx.actor, old) || !await boundAllows(ctx.env, ctx.actor, old)) missing();
    await assertDepartmentAccess(ctx.env, ctx.actor, old);
    return { conversation_id: old.id, address: to, identityTrust: "unverified_sender", reused: true };
  }
  const id = `email:${await sha(JSON.stringify([ctx.profileId, row.id, to]))}`;
  await batch(ctx.env, [
    [`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active')
      AND EXISTS(SELECT 1 FROM connections WHERE id=? AND profile_id=? AND status='active' AND config=?) THEN 1 ELSE 0 END
      ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`, [id, input.contactId, ctx.profileId, row.id, ctx.profileId, row.config]],
    [`INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,owner,epoch,session,last_customer,
      created,updated,channel,channel_account_id,channel_subject_id,channel_context,account_label,title,customer_link_state)
      VALUES(?,?,?,?,?,NULL,'human',?,1,?,0,?,?,'email',?,?,?, ?,?,'pending') ON CONFLICT(profile_id,external_namespace,external_id) DO NOTHING`,
      [id, ctx.profileId, row.id, `channel:${row.id}`, `email:${to}`, ctx.actor.id, id, ctx.now, ctx.now, config.address, to,
        JSON.stringify({ version: 1, context: "direct", identityTrust: "unverified_sender", email: { subject: "", sender: to } }), row.account_label ?? "", to]],
  ]);
  // Nenhum vínculo com contactId: o endereço cadastral não prova a identidade operacional.
  return { conversation_id: id, address: to, identityTrust: "unverified_sender", reused: false };
}

async function transportReady(ctx: ChannelOperationContext, transport: ChannelEmailTransport) {
  if (ctx.connection.channel !== "email" || ctx.resource?.kind !== "conversation")
    throw new ApiError(503, "channel_not_ready", "Canal de e-mail indisponível.");
  await transport.prepare({ from: normalizeEmailAddress(json(ctx.connection.config).address),
    to: normalizeEmailAddress(ctx.resource.conversation.channel_subject_id), subject: "Verificação local",
    text: "Verificação local de capacidade.", messageId: "<capability@wabotia.invalid>" });
}

async function automated(ctx: ChannelOperationContext, acknowledgement: boolean, messageId: string, transport: ChannelEmailTransport) {
  if (ctx.connection.channel !== "email" || ctx.resource?.kind !== "conversation") return null;
  const config = record(json(ctx.connection.config));
  if (config[acknowledgement ? "auto_ack_enabled" : "bot_enabled"] !== true) return null;
  await transportReady(ctx, transport);
  // Só a entrada corrente já classificada pode disparar resposta. Não consultar ficha ou histórico.
  const incoming = await one<{ metadata: string }>(ctx.env,
    `SELECT metadata FROM email_channel_inbox WHERE profile_id=? AND connection_id=? AND conversation_id=? AND message_id=? AND state='processed'`,
    ctx.authorization.profileId, ctx.connection.id, ctx.resource.id, messageId);
  if (!incoming) return null;
  const action = { type: acknowledgement ? "email.acknowledgement" as const : "email.auto-reply" as const,
    text: acknowledgement ? EMAIL_ACKNOWLEDGEMENT : EMAIL_GENERAL_REPLY,
    subject: emailReplySubject(String(record(json(incoming.metadata)).subject ?? "")) };
  try { return { action, plan: await prepareEmailSend(ctx, action, messageId) }; }
  catch (error) { if (error instanceof ApiError && error.code === "quota_exhausted") return null; throw error; }
}

export function createEmailChannel(options: { transport?: ChannelEmailTransport } = {}): ChannelExtension {
  const transport = options.transport ?? emailProviderTransport;
  return {
    key: "email/direct", spec: emailChannelSpec, enabled: emailEnabled,
    connectionDriver: emailConnectionDriver, account: { importable: false, serviceLine: true },
    ingress: { email: receiveEmail }, normalize: normalizeEmailIngress, prepareInbound: prepareEmailInbound,
    async prepareSend(ctx, action) { await transportReady(ctx, transport); return prepareEmailSend(ctx, action); },
    deliver: ctx => deliverEmail(ctx, transport), complete: completeEmail,
    maintenance: [emailMaintenance],
    async view(ctx) {
      if (ctx.connection.channel !== "email" || ctx.resource?.kind !== "conversation") return { capabilities: {}, metadata: {} };
      const context = record(json(ctx.resource.conversation.channel_context)), email = record(context.email);
      const metadata = safeMetadata(JSON.stringify(email));
      return { capabilities: { subject: true, replyTo: true, templates: false }, metadata: {
        subject: emailReplySubject(metadata.subject), identityTrust: "unverified_sender",
        email: { ...metadata, sender: ctx.resource.conversation.channel_subject_id ?? "", identityTrust: "unverified_sender" },
      } };
    },
    prepareBotReply: (ctx, input) => automated(ctx, false, input.messageId, transport),
    prepareAcknowledgement: (ctx, input) => automated(ctx, true, input.messageId, transport),
    routes: [
      { method: "GET", path: "/connections/:id/setup", authorization: "admin", handler: setup },
      { method: "POST", path: "/connections/:id/setup", authorization: "admin", async handler(ctx) {
        const row = await connection(ctx);
        return configureChannelConnection(ctx.env, ctx.actor, ctx.profileId, { ...record(ctx.input), id: row.id, kind: "email", channel: "email" }, ctx.commandId);
      } },
      { method: "POST", path: "/connections/:id/email-test", authorization: "admin", handler: startProbe },
      { method: "GET", path: "/connections/:id/email-inbox", authorization: "admin", handler: inbox },
      { method: "PUT", path: "/connections/:id/email-blocks", authorization: "admin", handler: ctx => block(ctx, false) },
      { method: "DELETE", path: "/connections/:id/email-blocks", authorization: "admin", handler: ctx => block(ctx, true) },
      { method: "POST", path: "/conversations/email", authorization: "contact.reply", handler: ctx => newEmail(ctx, transport) },
    ],
  };
}

export const emailChannel = createEmailChannel();
