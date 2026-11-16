import { batch, cachedAll, one } from "./db";
import { type Env, type Actor, uid, now, json } from "./types";
export async function event(
  env: Env,
  profile: string,
  kind: string,
  id: string,
  payload: any,
  uniqueKey?: string,
) {
  const sourceKey =
    uniqueKey ||
    ([
      "message.received",
      "message.sent",
      "bot.run.completed",
      "bot.run.failed",
      "conversation.created",
      "ticket.created",
    ].includes(kind)
      ? `${profile}:${kind}:${id}`
      : null);
  const row = await one(
    env,
    "INSERT INTO events(profile_id,kind,resource_id,payload,created,source_key) VALUES(?,?,?,?,?,?) ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET source_key=excluded.source_key RETURNING id",
    profile,
    kind,
    id,
    JSON.stringify(payload),
    now(),
    sourceKey,
  );
  const subs = await cachedAll(
    env,
    "SELECT s.*,a.scopes FROM webhook_subscriptions s JOIN applications a ON a.id=s.app_id WHERE s.profile_id=? AND s.enabled=1 AND a.disabled=0",
    profile,
  );
  const scope = kind.startsWith("call.")
    ? "calls:read"
    : kind.startsWith("bot.")
      ? "bots:invoke"
      : kind.startsWith("ticket.")
        ? "tickets:read"
        : kind.startsWith("queue.")
          ? "queue:read"
          : "conversations:read";
  const deliveries = subs
    .filter(
      (s) =>
        json(s.events, []).includes(kind) && json(s.scopes, []).includes(scope),
    )
    .map(
      (s) =>
        [
          "INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,event_id,next_at,created) VALUES(?,?,?,?,?)",
          [uid(), s.id, row.id, now(), now()],
        ] as [string, any[]],
    );
  if (deliveries.length) await batch(env, deliveries);
  return row.id;
}
export async function audit(
  env: Env,
  actor: Actor,
  profile: string,
  operation: string,
  id: string,
  requestId: string,
) {
  // `via`: a pessoa agiu pelo bot da conversa interna (src/bot-actions).
  const via = actor.via
    ? JSON.stringify({
        kind: actor.via.kind,
        bot_id: actor.via.bot_id,
        run_id: actor.via.run_id,
        proposal_id: actor.via.proposal_id ?? null,
      })
    : null;
  await env.DB.prepare(
    "INSERT INTO audit(profile_id,actor,operation,resource_id,request_id,via,created) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(profile, actor.id, operation, id, requestId, via, now())
    .run();
}
export async function wake(env: Env, profile: string) {
  await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch(
    "https://coordinator/wake",
    { method: "POST", body: JSON.stringify({ profile }) },
  );
}
