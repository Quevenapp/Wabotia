import {
  batch,
  cached,
  cachedAll,
  one,
  seedRead,
  WEBHOOK_SUBS_SQL,
} from "./db";
import { type Env, type Actor, uid, now, json } from "./types";
export async function event(
  env: Env,
  profile: string,
  kind: string,
  id: string,
  payload: any,
  uniqueKey?: string,
) {
  const insert = eventStatement(profile, kind, id, payload, uniqueKey);
  // O evento e as assinaturas de webhook numa ida só ao D1 (as assinaturas
  // ficam no cache da requisição para os próximos eventos).
  const subsRead = { sql: WEBHOOK_SUBS_SQL, args: [profile] };
  let row: any, subs: any[];
  if (cached(env, subsRead)) {
    row = await one(env, insert[0], ...insert[1]);
    subs = await cachedAll(env, WEBHOOK_SUBS_SQL, profile);
  } else {
    const [inserted, subsRows] = await batch(env, [
      insert,
      [WEBHOOK_SUBS_SQL, [profile]],
    ]);
    row = inserted.results[0];
    subs = subsRows.results as any[];
    seedRead(env, subsRead, subs);
  }
  await fanOut(env, profile, kind, row.id, subs);
  return row.id;
}

/**
 * A instrução que grava o evento (RETURNING id), para ir num lote com a
 * escrita que o gera. Depois do lote, chame fanOut com o id.
 */
export function eventStatement(
  profile: string,
  kind: string,
  id: string,
  payload: any,
  uniqueKey?: string,
): [string, any[]] {
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
  return [
    "INSERT INTO events(profile_id,kind,resource_id,payload,created,source_key) VALUES(?,?,?,?,?,?) ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET source_key=excluded.source_key RETURNING id",
    [profile, kind, id, JSON.stringify(payload), now(), sourceKey],
  ];
}

/**
 * Entregas de webhook de um evento já gravado (por quem gravou o evento no
 * mesmo lote da própria escrita, como a emissão da senha). `subs`: as
 * assinaturas, se já lidas; senão vêm do cache da requisição ou do banco.
 */
export async function fanOut(
  env: Env,
  profile: string,
  kind: string,
  eventId: number,
  subs?: any[],
) {
  subs ??= await cachedAll(env, WEBHOOK_SUBS_SQL, profile);
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
          [uid(), s.id, eventId, now(), now()],
        ] as [string, any[]],
    );
  if (deliveries.length) await batch(env, deliveries);
}
/** A instrução da auditoria, para ir num lote com outra escrita. */
export function auditStatement(
  actor: Actor,
  profile: string,
  operation: string,
  id: string,
  requestId: string,
): [string, any[]] {
  // `via`: a pessoa agiu pelo bot da conversa interna (src/bot-actions).
  const via = actor.via
    ? JSON.stringify({
        kind: actor.via.kind,
        bot_id: actor.via.bot_id,
        run_id: actor.via.run_id,
        proposal_id: actor.via.proposal_id ?? null,
      })
    : null;
  return [
    "INSERT INTO audit(profile_id,actor,operation,resource_id,request_id,via,created) VALUES(?,?,?,?,?,?,?)",
    [profile, actor.id, operation, id, requestId, via, now()],
  ];
}
export async function audit(
  env: Env,
  actor: Actor,
  profile: string,
  operation: string,
  id: string,
  requestId: string,
) {
  const [sql, args] = auditStatement(actor, profile, operation, id, requestId);
  await env.DB.prepare(sql)
    .bind(...args)
    .run();
}
export async function wake(env: Env, profile: string) {
  await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch(
    "https://coordinator/wake",
    { method: "POST", body: JSON.stringify({ profile }) },
  );
}
