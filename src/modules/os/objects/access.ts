import { allows, rolesOf } from "../../../access";
import { one } from "../../../db";
import { ApiError, type Actor, type Conversation } from "../../../types";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { ObjectAudience } from "../os2-ports";
import { workCustomerScope } from "../public";

export const objectMissing = () => new ApiError(404, "not_found", "Objeto ou cliente não encontrado ou não acessível.");
export const objectBotActor = (actor: Actor) => !!actor.via || actor.id.startsWith("bot:");
export interface ObjectAccessOptions { write?: boolean; conversation_id?: string }
export interface AuthorizedObjectContact { contact_id: string; audience: ObjectAudience }

/** Autoriza o domínio antes de qualquer busca ou paginação de objetos. */
export async function authorizeObjectAccess(
  ctx: ModuleContext, actor: Actor, options: ObjectAccessOptions = {},
): Promise<ObjectAudience> {
  ctx.access(actor, options.write ? "conversations:write" : "conversations:read");
  if (!allows(actor, "os") || (actor.module && !actor.module.reach.includes("os"))) throw objectMissing();
  await ctx.requireEnabled();
  if (actor.credential) throw objectMissing();
  // A autorização da conversa, feita abaixo, substitui a autorização de uma
  // lista da área. Nenhuma configuração administrativa amplia o titular externo.
  if (options.conversation_id) return { kind: "customer" };
  if (isBound(actor) || (actor.kind !== "user" && actor.kind !== "app")) throw objectMissing();
  ctx.access(actor, "contacts:read");
  if (!allows(actor, "contacts")) throw objectMissing();
  if (objectBotActor(actor)) {
    const policy = (await ctx.settings()).os2_ai_access;
    if (policy?.enabled !== true) throw objectMissing();
    return { kind: "bot", ai_access: {
      enabled: true, internal: policy.internal === true, sensitive: policy.sensitive === true,
    } };
  }
  if (!ctx.mayRead(actor, "contacts")) throw objectMissing();
  return { kind: "staff" };
}

/** Resolve somente aliases ativos da mesma área e do cadastro compartilhado. */
async function canonicalContact(ctx: ModuleContext, contactId: string): Promise<string> {
  if (typeof contactId !== "string" || !contactId || contactId.length > 200) throw objectMissing();
  const visited = new Set<string>();
  let id = contactId;
  for (;;) {
    if (visited.has(id) || visited.size >= 32) throw objectMissing();
    visited.add(id);
    const contact = await one<{ id: string; merged_into: string | null }>(ctx.env,
      "SELECT id,merged_into FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'",
      ctx.profile, id);
    if (!contact) throw objectMissing();
    if (!contact.merged_into) return contact.id;
    id = contact.merged_into;
  }
}

/** Para passos autenticados pelo núcleo: recarrega a conversa e sua identidade. */
export async function resolveObjectConversationContact(ctx: ModuleContext, conversation: Conversation): Promise<string> {
  if (conversation.profile_id !== ctx.profile) throw objectMissing();
  await ctx.requireEnabled();
  const saved = await ctx.conversation(conversation.id);
  const scope = await workCustomerScope(ctx, saved);
  if (scope.sql === "0" || !scope.contactId)
    throw new ApiError(409, "customer_required", "Confirme o contato do cliente antes de consultar ou cadastrar o objeto.");
  return canonicalContact(ctx, scope.contactId);
}

export async function authorizeObjectConversation(
  ctx: ModuleContext, actor: Actor, conversationId: string, options: Pick<ObjectAccessOptions, "write"> = {},
): Promise<AuthorizedObjectContact> {
  const audience = await authorizeObjectAccess(ctx, actor, { ...options, conversation_id: conversationId });
  const conversation = await ctx.conversation(conversationId, actor);
  const scope = await workCustomerScope(ctx, conversation);
  if (scope.sql === "0" || !scope.contactId)
    throw new ApiError(409, "customer_required", "Confirme o contato do cliente antes de consultar ou cadastrar o objeto.");
  return { contact_id: await canonicalContact(ctx, scope.contactId), audience };
}

export async function authorizeObjectContact(
  ctx: ModuleContext, actor: Actor, contactId: string, options: ObjectAccessOptions = {},
): Promise<AuthorizedObjectContact> {
  if (options.conversation_id) {
    const access = await authorizeObjectConversation(ctx, actor, options.conversation_id, options);
    if (access.contact_id !== await canonicalContact(ctx, contactId)) throw objectMissing();
    return access;
  }
  const audience = await authorizeObjectAccess(ctx, actor, options);
  return { contact_id: await canonicalContact(ctx, contactId), audience };
}

/** Privados continuam separados. A única extensão para IA é o opt-in efetivo. */
export async function requireObjectPrivateAccess(ctx: ModuleContext, actor: Actor): Promise<void> {
  const audience = await authorizeObjectAccess(ctx, actor);
  const internalAi = audience.kind === "bot" && audience.ai_access?.enabled && audience.ai_access.sensitive;
  const person = actor.kind === "user" && !objectBotActor(actor) && !actor.module &&
    !actor.credential && rolesOf(actor).includes("os:sensitive");
  if (!internalAi && !person)
    throw new ApiError(403, "sensitive_forbidden", "Acesso aos campos privados não autorizado.");
}
