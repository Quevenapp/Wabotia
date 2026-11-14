import { one } from "./db";
import { type Actor, type Env, json } from "./types";
export function visibleConversation(actor: Actor, c: any) {
  return (
    actor.kind !== "app" ||
    !c.external_namespace.startsWith("app:") ||
    c.external_namespace === `app:${actor.id}`
  );
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
