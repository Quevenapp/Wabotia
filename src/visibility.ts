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
  if (actor.kind !== "app") return true;
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
