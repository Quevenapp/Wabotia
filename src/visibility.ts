import { one } from "./db";
import { type Actor, type Env, json, now } from "./types";

/**
 * Chave restrita ao atendimento (conferência A1): com `conversations:bound`,
 * a aplicação só alcança as conversas que um dos bots dela está atendendo
 * agora (execução na fila ou em andamento, ou encerrada há menos de 2 min) e
 * as do próprio namespace. É o perfil da chave do Hermes: um cliente que
 * injeta instruções no bot não chega à conversa de outro cliente.
 */
export const BOUND_SCOPE = "conversations:bound";
export const isBound = (actor: Actor) =>
  actor.kind === "app" && actor.scopes.includes(BOUND_SCOPE);
/**
 * Marcação, não permissão: o administrador escolheu a área inteira para uma
 * aplicação com bots (chave do Hermes "acesso a toda a área").
 */
export const WHOLE_AREA_SCOPE = "conversations:all";
/**
 * Chave de bot emitida antes de `conversations:bound` (segunda conferência,
 * A1): aplicação com bots e acesso a conversas, sem a restrição nem a
 * marcação de área inteira. O painel avisa e oferece prender às conversas do
 * bot ou confirmar a área inteira; nada é rebaixado sozinho.
 */
export function wholeAreaPending(app: { scopes: unknown; bots: unknown }) {
  const scopes: string[] = json(app.scopes as any, []);
  const bots: string[] = json(app.bots as any, []);
  return (
    bots.length > 0 &&
    scopes.some((s) =>
      ["conversations:read", "conversations:write"].includes(s),
    ) &&
    !scopes.includes(BOUND_SCOPE) &&
    !scopes.includes(WHOLE_AREA_SCOPE)
  );
}
export async function boundAllows(env: Env, actor: Actor, c: any) {
  if (!isBound(actor)) return true;
  if (c.external_namespace === `app:${actor.id}`) return true;
  if (!actor.bots.length) return false;
  return !!(await one(
    env,
    "SELECT 1 FROM bot_runs WHERE conversation_id=? AND bot_id IN (SELECT value FROM json_each(?)) AND (status IN ('queued','starting','running') OR updated>?) LIMIT 1",
    c.id,
    JSON.stringify(actor.bots),
    now() - 120_000,
  ));
}

export function visibleConversation(actor: Actor, c: any) {
  return (
    actor.kind !== "app" ||
    !c.external_namespace.startsWith("app:") ||
    c.external_namespace === `app:${actor.id}`
  );
}
/** Nota interna preenchida no evento (até dois níveis: o registro dentro). */
function carriesNotes(value: any, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 2) return false;
  for (const [key, inner] of Object.entries(value)) {
    if (
      ["notes", "paid_note"].includes(key) &&
      typeof inner === "string" &&
      inner.trim()
    )
      return true;
    if (inner && typeof inner === "object" && carriesNotes(inner, depth + 1))
      return true;
  }
  return false;
}

export async function visibleEvent(env: Env, actor: Actor, e: any) {
  if (e.kind.startsWith("internal.")) {
    if (actor.kind !== "user") return false;
    const chat = await one(
      env,
      "SELECT id FROM internal_chats WHERE id=? AND profile_id=? AND (member_a=? OR member_b=?)",
      json(e.payload).chat_id || "",
      e.profile_id,
      actor.id,
      actor.id,
    );
    return !!chat;
  }
  if (e.kind.startsWith("bot.")) {
    const run = await one(
      env,
      "SELECT actor,context FROM bot_runs WHERE id=?",
      e.resource_id,
    );
    if (json(run?.context).internal_chat_id && run?.actor !== actor.id)
      return false;
  }
  if (actor.kind !== "app") return true;
  // Módulo ligado ou desligado: sem conteúdo de conversa, vale para qualquer
  // aplicação da área (aparelhos pareados escondem telas).
  if (e.kind === "module.changed") return true;
  // Queue events carry no conversation content: any queue scope may read them.
  if (e.kind.startsWith("queue."))
    return (
      !e.kind.startsWith("queue.blocked") &&
      !e.kind.startsWith("queue.unblocked") &&
      ["queue:read", "queue:issue", "queue:operate"].some((s) =>
        actor.scopes.includes(s),
      )
    );
  const scope = e.kind.startsWith("call.")
    ? "calls:read"
    : e.kind.startsWith("bot.")
      ? "bots:invoke"
      : e.kind.startsWith("ticket.")
        ? "tickets:read"
        : "conversations:read";
  if (!actor.scopes.includes(scope)) return false;
  if (e.kind.startsWith("call.")) {
    const call = await one(
      env,
      "SELECT actor FROM calls WHERE id=?",
      e.resource_id,
    );
    if (!call || (call.actor && call.actor !== actor.id)) return false;
  }
  if (e.kind.startsWith("bot.")) {
    const run = await one(
      env,
      "SELECT actor,bot_id FROM bot_runs WHERE id=?",
      e.resource_id,
    );
    return !!run && run.actor === actor.id && actor.bots.includes(run.bot_id);
  }
  const payload = json(e.payload);
  // Conferência M6: eventos de módulo levam o registro inteiro (telefone,
  // respostas do check-in, observações) e os de passo web levam as
  // respostas; sem contacts:read a aplicação não os recebe. Os da OS e do
  // Pedido levam também a nota interna: exigem notes:read.
  if (
    (payload.module_id ||
      e.kind === "web_step.completed" ||
      e.kind === "form.submitted") &&
    !actor.scopes.includes("contacts:read")
  )
    return false;
  if (
    (payload.module_id === "os" ||
      payload.module_id === "pedido" ||
      // Agenda, Reserva e os demais: quando o registro leva nota interna
      // (segunda conferência, M6).
      (payload.module_id && carriesNotes(payload))) &&
    !actor.scopes.includes("notes:read")
  )
    return false;
  let id = payload.conversation_id;
  if (e.kind.startsWith("conversation.")) id = e.resource_id;
  if (e.kind.startsWith("ticket."))
    id = (
      await one(
        env,
        "SELECT conversation_id FROM tickets WHERE id=?",
        e.resource_id,
      )
    )?.conversation_id;
  const c = id
    ? await one(
        env,
        "SELECT external_namespace FROM conversations WHERE id=?",
        id,
      )
    : null;
  return !!c && visibleConversation(actor, c);
}
