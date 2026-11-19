import { batch, exec, one } from "./db";
import { applyChannelEvents, channelEvent } from "./whatsapp";
import { conversation } from "./service";
import { event } from "./events";
import { ApiError, type Actor, type Conversation, type Env, now, json } from "./types";
import type { ChannelAuthorization, ChannelDeliveryContext, ChannelDeliveryResult, ChannelDeliveryState, ChannelOperationContext, ChannelOutboxRow, ChannelReview, ExtensionConnection, ExtensionKey, Resource, ServerChannelAction } from "./channel-c2-contracts";
import { channelExtension, extensionKey } from "./channel-extension-registry";
import { authorizeChannelAction, loadChannelOperationContext } from "./channel-extension-kernel";
import { engineActor, storedAccess } from "./security";
export async function finishDelivery(env: Env, row: any, external: string) {
  if (await completeChannelDelivery(env, row, external)) return;
  const payload = json(row.payload),
    attachments = payload.media_id
      ? [payload.media_id]
      : payload.template_media_ids || payload.attachments || [];
  const writes: [string, any[]][] = [
    [
      "UPDATE outbox SET status='sent',external_id=?,error=NULL,updated=? WHERE id=?",
      [external, now(), row.id],
    ],
  ];
  if (row.kind !== "team" && row.kind !== "action")
    writes.push([
      "INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "delivery:" + row.id,
        row.profile_id,
        row.conversation_id,
        "outbound",
        row.actor,
        payload.text || "",
        JSON.stringify(attachments),
        external,
        now(),
        "delivery:" + row.id,
        JSON.stringify(payload.content || {}),
        "sent",
      ],
    ]);
  await batch(env, writes);
  if (row.kind !== "team" && row.kind !== "action")
    await event(env, row.profile_id, "message.sent", row.id, {
      conversation_id: row.conversation_id,
      text: payload.text || "",
      attachments,
    });
  if (row.kind === "action" && payload.content?.type !== "read") {
    const conn = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      row.connection_id,
    );
    const c = await conversation(env, row.conversation_id, row.profile_id),
      content = payload.content;
    await channelEvent(env, conn, {
      event: content.type,
      external_id: c.recipient_id || c.external_id,
      message_id: content.target_external_id,
      event_id: row.id,
      participant: row.actor,
      emoji: content.emoji,
      text: content.text,
      timestamp: row.created,
    });
  }
  if (row.connection_id)
    await applyChannelEvents(env, row.connection_id, external);
  await exec(env, "UPDATE outbox SET completion_handled=1 WHERE id=?", row.id);
}

export interface ChannelDeliveryEnvelope {
  key: ExtensionKey;
  authorization: ChannelAuthorization;
  action: ServerChannelAction;
  resource: Resource;
  delivery: Record<string, unknown>;
}

/** O marcador é exclusivo da outbox produzida pelo kernel; legado não faz SQL. */
export function channelDeliveryEnvelope(row: Pick<ChannelOutboxRow, "kind" | "payload">): ChannelDeliveryEnvelope | null {
  if (row.kind !== "channel") return null;
  const stored = json(row.payload).c2 as ChannelDeliveryEnvelope | undefined;
  if (!stored || !stored.resource || !stored.authorization || !stored.action || !stored.delivery ||
      extensionKey(stored.key?.split("/")[0], stored.key?.split("/")[1] as "direct" | "comment" | "review") !== stored.key)
    throw new ApiError(409, "inbox_required", "A entrega de canal não foi preparada pelo servidor.");
  return stored;
}

async function deliveryActor(env: Env, row: ChannelOutboxRow, proof: ChannelAuthorization): Promise<Actor> {
  if (proof.profileId !== row.profile_id || proof.actor.id !== row.actor)
    throw new ApiError(403, "forbidden", "Autorização da entrega inválida.");
  if (proof.origin === "human") {
    const user = await one(env, "SELECT id,name,role,profiles,access FROM users WHERE id=? AND disabled=0", row.actor);
    if (!user || proof.actor.kind !== "user" || proof.actor.via)
      throw new ApiError(403, "forbidden", "A autorização de publicação foi revogada.");
    return { id: user.id, name: user.name, role: user.role, profiles: json(user.profiles, []), access: storedAccess(user.access),
      kind: "user", scopes: [], bots: [], rate: 100, runLimit: 100 };
  }
  if (proof.origin !== "bot" || proof.actor.kind !== "app" || row.actor !== "bot:attendant")
    throw new ApiError(403, "forbidden", "Origem da entrega indisponível.");
  const botId = proof.actor.bots[0] ?? "";
  if (botId && !(await one(env, "SELECT id FROM bots WHERE id=? AND profile_id=? AND enabled=1", botId, row.profile_id)))
    throw new ApiError(403, "forbidden", "Bot desativado antes do envio.");
  return engineActor(row.profile_id, botId);
}

/** Releitura completa após o CAS e imediatamente antes da rede. */
export async function loadChannelDeliveryContext(env: Env, row: ChannelOutboxRow, reauthorize = true): Promise<{ context: ChannelDeliveryContext; operation: ChannelOperationContext; envelope: ChannelDeliveryEnvelope }> {
  const envelope = channelDeliveryEnvelope(row);
  if (!envelope) throw new ApiError(409, "inbox_required", "Entrega de canal obrigatória.");
  const sidecar = await one<ChannelDeliveryState>(env, "SELECT * FROM channel_delivery_state WHERE outbox_id=? AND profile_id=?", row.id, row.profile_id);
  if (!sidecar || sidecar.connection_id !== row.connection_id || sidecar.resource_key !== `${envelope.resource.kind}:${envelope.resource.id}`)
    throw new ApiError(409, "inbox_required", "Reserva de entrega inválida.");
  let operation: ChannelOperationContext;
  if (reauthorize) {
    const actor = await deliveryActor(env, row, envelope.authorization);
    operation = await loadChannelOperationContext(env, actor, row.profile_id, envelope.resource, row.dedupe, envelope.authorization.origin === "bot" ? "bot" : "human");
  } else {
    // Efeito remoto confirmado precisa concluir mesmo após revogação ou remoção.
    // Este caminho não reenvia e não lê credencial.
    const resource = envelope.resource.kind === "connection" ? null : envelope.resource.kind === "review"
      ? await one<ChannelReview>(env, "SELECT * FROM reviews WHERE id=? AND profile_id=?", envelope.resource.id, row.profile_id)
      : await one<Conversation>(env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", envelope.resource.id, row.profile_id);
    const historicalConversation = envelope.resource.kind === "conversation" && resource &&
      resource.connection_id === null && (resource as Conversation).external_namespace === `channel:${row.connection_id}` &&
      (resource as Conversation).channel === channelExtension(envelope.key).spec.id;
    if (envelope.resource.kind !== "connection" && (!resource || (resource.connection_id !== row.connection_id && !historicalConversation)))
      throw new ApiError(409, "inbox_required", "O recurso da conclusão mudou.");
    const extension = channelExtension(envelope.key);
    const connection = await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", row.connection_id, row.profile_id) ?? {
      id: sidecar.connection_id, profile_id: row.profile_id, channel: extension.spec.id, kind: extension.spec.transport,
      name: "", mode: "", config: "{}", status: "removed", created: 0,
    };
    operation = { env, connection, now: now(), commandId: row.dedupe, authorization: envelope.authorization,
      resource: envelope.resource.kind === "connection" ? envelope.resource : envelope.resource.kind === "review" ? { ...envelope.resource, review: resource as ChannelReview }
        : { ...envelope.resource, conversation: resource as Conversation } };
  }
  if (!operation.resource || operation.connection.id !== row.connection_id || operation.connection.profile_id !== row.profile_id ||
      (envelope.resource.kind === "conversation" ? row.conversation_id !== envelope.resource.id : row.conversation_id !== null))
    throw new ApiError(409, "inbox_required", "O recurso da entrega mudou.");
  const resource = operation.resource;
  const contextKey = resource.kind === "connection" ? "direct" : resource.kind === "review" ? "review" : resource.conversation.chat_type === "comment" ? "comment" : json(resource.conversation.channel_context).context || "direct";
  if (extensionKey(operation.connection.channel, contextKey) !== envelope.key)
    throw new ApiError(409, "inbox_required", "O canal da entrega mudou.");
  if (reauthorize) {
    if ((resource.kind !== "connection" && operation.connection.status !== "active") || (resource.kind === "conversation" && resource.conversation.epoch !== row.epoch))
      throw new ApiError(410, "message_expired", "A conversa ou a conexão mudou antes do envio.");
    await authorizeChannelAction(operation, envelope.action);
  }
  const context: ChannelDeliveryContext = { env, outbox: row, sidecar, resource, connection: operation.connection,
    configuration: json(operation.connection.config), now: now(),
    beforeFetch: async () => {
      const persisted = await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=? AND profile_id=? AND status='sending'", row.id, row.profile_id);
      if (!persisted) throw new ApiError(410, "message_expired", "Entrega cancelada antes do envio.");
      if (!await one(env, `SELECT 1 FROM channel_delivery_state s WHERE s.outbox_id=? AND s.profile_id=? AND s.not_before<=?
        AND NOT EXISTS(SELECT 1 FROM channel_delivery_state p JOIN outbox o ON o.id=p.outbox_id
          WHERE p.profile_id=s.profile_id AND p.resource_key=s.resource_key
            AND (o.status IN ('pending','sending','unknown') OR (o.status IN ('sent','failed','cancelled') AND o.completion_handled=0))
            AND (p.created<s.created OR (p.created=s.created AND p.outbox_id<s.outbox_id)))`, row.id, row.profile_id, now()))
        throw new ApiError(409, "delivery_order_changed", "A entrega aguarda uma operação anterior do recurso.");
      await loadChannelDeliveryContext(env, persisted);
    },
  };
  return { context, operation, envelope };
}

/** A conclusão do descritor e completion_handled são confirmadas no mesmo lote. */
export async function completeChannelDelivery(env: Env, candidate: ChannelOutboxRow, externalId = ""): Promise<boolean> {
  if (candidate.kind !== "channel") return false;
  const row = await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=? AND profile_id=?", candidate.id, candidate.profile_id);
  if (!row || row.completion_handled) return true;
  if (!["sent", "failed", "unknown", "cancelled"].includes(row.status)) return true;
  const { context, envelope } = await loadChannelDeliveryContext(env, row, false);
  const result: ChannelDeliveryResult = row.status === "sent"
    ? { kind: "sent", externalId: row.external_id || externalId || undefined, context: json(context.sidecar.result_context) }
    : { kind: row.status === "unknown" ? "unknown" : "failed", code: row.error && /^[a-z_]{1,64}$/.test(row.error) ? row.error : "provider_unknown" };
  const plan = await channelExtension(envelope.key).complete({ ...context, result });
  if (plan.statements.length > 500 || (plan.resource && (plan.resource.kind !== context.resource.kind || plan.resource.id !== context.resource.id)) ||
      (plan.conversationId && (context.resource.kind !== "conversation" || plan.conversationId !== context.resource.id)))
    throw new ApiError(409, "inbox_required", "O plano de conclusão não pertence ao recurso.");
  try {
    await batch(env, [[`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM outbox
      WHERE id=? AND profile_id=? AND status=? AND completion_handled=0) THEN 1 ELSE 0 END
      ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`, [`c2-completion:${row.id}`, row.id, row.profile_id, row.status]],
      ...plan.statements,
      ["UPDATE outbox SET completion_handled=1,updated=? WHERE id=? AND profile_id=? AND status=?", [now(), row.id, row.profile_id, row.status]],
    ]);
  } catch (error) {
    if (!(await one(env, "SELECT 1 FROM outbox WHERE id=? AND profile_id=? AND completion_handled=1", row.id, row.profile_id))) throw error;
  }
  return true;
}
