import { channelAccountsHandlers } from "./channel-accounts";
import { channelIdentityImplementation } from "./customer/channel-identity";
import { conversationTranscriptPort } from "./conversation-email";
import { zernioSocialTransport } from "./zernio-social";
import {
  channelAccountsPort, channelIdentityPort, channelTranscriptPort,
  installChannelAccountsPort, installChannelIdentityPort,
  installChannelTranscriptPort, installSocialTransportPort,
} from "./channel-ports";
import { one } from "./db";
import { access, admin, legacyKeyScopes, storedAccess } from "./security";
import { requireAccess } from "./access";
import { customerAccess, human } from "./customer/local";
import { assertDepartmentAccess } from "./departments";
import { boundAllows, visibleConversation } from "./visibility";
import { ApiError, json, now, requireValue, type Actor, type Conversation, type Env } from "./types";

/**
 * Composição explícita nas entradas do Worker e do Coordinator. Importar o
 * entrypoint não ocupa os ports de quem exercita um adaptador isoladamente.
 * Reinstalar as mesmas implementações é idempotente; substituições falham.
 */
export function installChannelRuntime(): void {
  installChannelAccountsPort(channelAccountsHandlers);
  installChannelIdentityPort(channelIdentityImplementation);
  installChannelTranscriptPort(conversationTranscriptPort);
  installSocialTransportPort(zernioSocialTransport);
}

const operations = new Set([
  "channel.discover", "channel.import", "contact.merge-preview", "contact.merge", "contact.merge.undo",
  "conversation.email.preview", "conversation.email",
]);
export const isChannelOperation = (operation: string) => operations.has(operation);

const missing = (): never => { throw new ApiError(404, "not_found", "Recurso não encontrado."); };

/** O recibo não mantém uma concessão revogada, nem amplia os escopos da chave original. */
async function currentActor(env: Env, actor: Actor): Promise<Actor> {
  if (actor.via || actor.module || actor.credential || actor.kind === "connector" ||
      actor.id.startsWith("bot:") || actor.scopes.includes("conversations:bound"))
    throw new ApiError(403, "forbidden", "Esta operação não permite execução automática.");
  if (actor.expiresAt !== undefined && actor.expiresAt <= now()) missing();
  if (actor.kind === "user") {
    const row = await one(env, "SELECT name,role,profiles,access FROM users WHERE id=? AND disabled=0", actor.id);
    if (!row) missing();
    if (actor.sessionId && !await one(env, "SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires>?", actor.sessionId, actor.id, now())) missing();
    return { ...actor, name: row.name, role: row.role, profiles: json(row.profiles, []), access: storedAccess(row.access) };
  }
  const id = actor.id.replace(/^app:/, "");
  const row = await one(env, "SELECT name,profiles,scopes FROM applications WHERE id=? AND disabled=0", id);
  if (!row) missing();
  if (actor.keyId && !await one(env, "SELECT 1 FROM api_keys WHERE id=? AND app_id=? AND revoked=0 AND expires>?", actor.keyId, id, now())) missing();
  const scopes = legacyKeyScopes(json(row.scopes, []));
  return { ...actor, name: row.name, profiles: json(row.profiles, []), scopes: actor.scopes.filter(scope => scopes.includes(scope)) };
}

async function authorizeOperation(env: Env, original: Actor, profile: string, operation: string, data: any, result?: any) {
  const actor = await currentActor(env, original);
  requireValue(data && typeof data === "object" && !Array.isArray(data), "Pedido inválido.");
  if (operation.startsWith("channel.")) {
    access(actor, profile, "routing:read"); admin(actor);
    requireValue(typeof data.integrationId === "string" && data.integrationId.length > 0, "Informe a integração Zernio.");
    if (!await one(env, "SELECT id FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'", data.integrationId, profile)) missing();
    if (result?.connection?.id && !await one(env,
      `SELECT 1 FROM connections c JOIN zernio_channel_accounts a ON a.connection_id=c.id AND a.profile_id=c.profile_id
       WHERE c.id=? AND c.profile_id=? AND a.integration_id=? AND a.account_id=? AND a.channel=? AND c.channel=a.channel`,
      result.connection.id, profile, data.integrationId, data.accountId, data.channel)) missing();
    return { actor, conversation: null };
  }
  if (operation.startsWith("contact.")) {
    human(actor); customerAccess(actor, profile); customerAccess(actor, profile, true);
    requireAccess(actor, "contacts:merge");
    requireValue(typeof data.id === "string" && data.id.length > 0, "Informe a ficha de origem.");
    let sourceId = data.id, targetId = data.targetId;
    if (operation === "contact.merge.undo") {
      const merge = await one(env, "SELECT source_id,target_id FROM customer_merges WHERE profile_id=? AND id=? AND (source_id=? OR target_id=?)",
        profile, data.mergeId, sourceId, sourceId);
      if (!merge) missing();
      sourceId = merge.source_id; targetId = merge.target_id;
    }
    requireValue(typeof targetId === "string" && targetId.length > 0, "Informe a ficha de destino.");
    // Lê os dois IDs originais: resolver um alias não pode ocultar a restrição da origem.
    const source = await one(env, "SELECT namespace,identity_state FROM contacts WHERE profile_id=? AND id=?", profile, sourceId);
    const target = await one(env, "SELECT namespace,identity_state FROM contacts WHERE profile_id=? AND id=?", profile, targetId);
    if (!source || !target || source.namespace !== target.namespace ||
        source.identity_state !== "active" || target.identity_state !== "active") missing();
    if (result?.id && !result.error && operation !== "contact.merge-preview" && !await one(env,
      "SELECT 1 FROM customer_merges WHERE profile_id=? AND id=? AND ((source_id=? AND target_id=?) OR (source_id=? AND target_id=?))",
      profile, result.id, sourceId, targetId, targetId, sourceId)) missing();
    return { actor, conversation: null };
  }
  access(actor, profile, "conversations:read");
  requireAccess(actor, "conversations"); requireAccess(actor, "conversations:email");
  const conversation = await one<Conversation>(env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", data.id, profile);
  if (!conversation || !visibleConversation(actor, conversation) || !await boundAllows(env, actor, conversation)) missing();
  await assertDepartmentAccess(env, actor, conversation!);
  return { actor, conversation };
}

export async function performChannelOperation(env: Env, original: Actor, profile: string, operation: string, data: any, commandId: string) {
  const { actor, conversation } = await authorizeOperation(env, original, profile, operation, data);
  switch (operation) {
    case "channel.discover": return channelAccountsPort.discover(env, actor, profile, data.integrationId);
    case "channel.import": return channelAccountsPort.importAccount(env, actor, profile, {
      commandId, integrationId: data.integrationId, accountId: data.accountId, channel: data.channel,
    });
    case "contact.merge-preview": return channelIdentityPort.previewMerge(env, actor, profile, data.id, { targetId: data.targetId });
    case "contact.merge": {
      const { id, ...input } = data;
      return channelIdentityPort.merge(env, actor, profile, id, commandId, input);
    }
    case "contact.merge.undo": {
      const { id, ...input } = data;
      return channelIdentityPort.undoMerge(env, actor, profile, id, commandId, input);
    }
    case "conversation.email.preview": return channelTranscriptPort.preview(env, actor, conversation!, { destination: data.destination, range: data.range });
    case "conversation.email": return channelTranscriptPort.send(env, actor, conversation!, commandId, {
      previewToken: data.previewToken, confirmedRecipient: data.confirmedRecipient, customerRequested: data.customerRequested,
    });
    default: throw new ApiError(400, "invalid_operation", "Operação de canal inválida.");
  }
}

export async function authorizeChannelReplay(env: Env, actor: Actor, profile: string, operation: string, data: any, value: any) {
  await authorizeOperation(env, actor, profile, operation, data, value);
  // Nenhuma chamada de envio: o recibo é somente uma projeção já confirmada.
  return value && !value.error && ["channel.import", "contact.merge", "contact.merge.undo", "conversation.email"].includes(operation)
    ? { ...value, duplicate: true } : value;
}
