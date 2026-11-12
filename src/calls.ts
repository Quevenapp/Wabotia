import { one, exec } from "./db";
import { Actor, ApiError, Env, now, uid, requireValue } from "./types";
import { access, seal, unseal } from "./security";
import { conversation } from "./service";
import { event } from "./events";

const finalStates = ["completed", "failed", "rejected", "missed"];
export async function callView(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
  session = false,
) {
  access(actor, profile, "calls:read");
  const row = await one(
    env,
    "SELECT * FROM calls WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row || (actor.kind === "app" && row.actor && row.actor !== actor.id))
    throw new ApiError(404, "not_found", "Ligação não encontrada.");
  await conversation(env, row.conversation_id, profile, actor);
  const { local_session, remote_session, ...result } = row;
  if (session) {
    access(actor, profile, "calls:write");
    requireValue(
      row.actor === actor.id,
      "Assuma a ligação antes de obter o áudio.",
    );
    result.session = remote_session ? await unseal(env, remote_session) : null;
  }
  return result;
}
export async function callPermission(
  env: Env,
  conn: any,
  recipient: string,
): Promise<any> {
  throw new ApiError(
    422,
    "unsupported_capability",
    "Ligações no navegador não estão disponíveis pela Zernio. Configure o encaminhamento no painel Zernio.",
  );
}
function session(value: any, type: string) {
  requireValue(
    value?.sdp_type === type &&
      typeof value.sdp === "string" &&
      value.sdp.length <= 60000 &&
      value.sdp.startsWith("v=0") &&
      /(?:^|\n)m=audio /.test(value.sdp) &&
      !/(?:^|\n)m=(video|application) /.test(value.sdp),
    "Sessão de voz WebRTC inválida. Vídeo e compartilhamento de tela não são suportados.",
  );
  return { sdp_type: type, sdp: value.sdp };
}
async function changed(env: Env, row: any, source?: string) {
  await event(
    env,
    row.profile_id,
    "call.updated",
    row.id,
    {
      conversation_id: row.conversation_id,
      call_id: row.id,
      status: row.status,
      direction: row.direction,
    },
    source,
  );
}
export async function callCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  key: string,
) {
  access(actor, profile, "calls:write");
  access(actor, profile, "calls:read");
  if (
    [
      "call.configure",
      "call.permission",
      "call.start",
      "call.pre_accept",
      "call.accept",
      "call.reject",
      "call.terminate",
    ].includes(op)
  )
    throw new ApiError(
      422,
      "unsupported_capability",
      "Ligações no navegador não estão disponíveis pela Zernio. Configure o encaminhamento no painel Zernio.",
    );
  const row = await one(
    env,
    "SELECT * FROM calls WHERE id=? AND profile_id=?",
    data.id,
    profile,
  );
  requireValue(row, "Ligação não encontrada.");
  const c = await conversation(env, row.conversation_id, profile, actor);
  if (actor.kind === "app" && (row.actor || op !== "call.claim"))
    requireValue(
      row.actor === actor.id,
      "A ligação não pertence a esta aplicação.",
    );
  if (op === "call.claim") {
    access(actor, profile, "conversations:write");
    requireValue(
      row.direction === "inbound" && !finalStates.includes(row.status),
      "A ligação não está disponível.",
    );
    if (row.actor && row.actor !== actor.id)
      throw new ApiError(
        409,
        "call_claimed",
        "Outro atendente já assumiu esta ligação.",
      );
    requireValue(
      !c.owner || c.owner === actor.id,
      "A conversa pertence a outro atendente.",
    );
    const other = await one(
      env,
      "SELECT id FROM calls WHERE actor=? AND id<>? AND status NOT IN ('completed','failed','rejected','missed')",
      actor.id,
      row.id,
    );
    if (other)
      throw new ApiError(
        409,
        "call_in_progress",
        "Encerre a outra ligação antes de atender.",
      );
    await exec(
      env,
      "UPDATE conversations SET owner=?,state='human',epoch=epoch+1 WHERE id=?",
      actor.id,
      c.id,
    );
    await exec(
      env,
      "UPDATE calls SET actor=?,lease_until=? WHERE id=?",
      actor.id,
      now() + 90000,
      row.id,
    );
    return callView(env, actor, profile, row.id, true);
  }
  requireValue(
    row.actor === actor.id,
    "Somente o responsável pode controlar a ligação.",
  );
  if (op === "call.keepalive") {
    requireValue(!finalStates.includes(row.status), "A ligação já terminou.");
    await exec(
      env,
      "UPDATE calls SET lease_until=? WHERE id=?",
      now() + 90000,
      row.id,
    );
    return { ok: true };
  }
  if (op === "call.reconcile") {
    requireValue(
      row.status === "unknown" && data.confirmed_ended === true,
      "Confirme que a ligação terminou no WhatsApp antes de reconciliar.",
    );
    await exec(
      env,
      "UPDATE calls SET status='completed',ended=?,updated=?,remote_session=NULL,local_session=NULL WHERE id=?",
      now(),
      now(),
      row.id,
    );
    await changed(env, { ...row, status: "completed" });
    return { id: row.id, status: "completed" };
  }
  throw new ApiError(
    422,
    "unsupported_capability",
    "Controle de áudio no navegador indisponível pela Zernio.",
  );
}

export async function callWebhook(env: Env, conn: any, data: any) {
  const p = data.call,
    ts = (Number(p.timestamp) || Math.floor(now() / 1000)) * 1000;
  requireValue(p && typeof p.id === "string", "Evento de ligação inválido.");
  const key = `${conn.id}:${p.id}:${p.event || p.status}:${ts}`;
  if (
    await one(env, "SELECT event_key FROM call_events WHERE event_key=?", key)
  )
    return { duplicate: true };
  let row = await one(
    env,
    "SELECT * FROM calls WHERE connection_id=? AND external_id=?",
    conn.id,
    p.id,
  );
  if (!row && p.biz_opaque_callback_data) {
    row = await one(
      env,
      "SELECT * FROM calls WHERE id=? AND connection_id=? AND direction='outbound' AND external_id IS NULL",
      p.biz_opaque_callback_data,
      conn.id,
    );
    if (row)
      await exec(
        env,
        "UPDATE calls SET external_id=? WHERE id=?",
        p.id,
        row.id,
      );
  }
  if (!row && p.direction === "USER_INITIATED") {
    const recipient = p.from || p.from_user_id;
    requireValue(
      typeof recipient === "string" && recipient.length <= 200,
      "Origem da ligação inválida.",
    );
    let c = await one(
      env,
      "SELECT * FROM conversations WHERE connection_id=? AND coalesce(recipient_id,external_id)=?",
      conn.id,
      recipient,
    );
    if (!c) {
      const id = uid();
      await exec(
        env,
        "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,'waiting',?,0,?,?)",
        id,
        conn.profile_id,
        conn.id,
        "channel:" + conn.id,
        recipient,
        p.from || null,
        uid(),
        now(),
        now(),
      );
      c = await one(env, "SELECT * FROM conversations WHERE id=?", id);
    }
    const id = uid();
    await exec(
      env,
      "INSERT INTO calls(id,profile_id,connection_id,conversation_id,external_id,direction,status,created,updated,lease_until) VALUES(?,?,?,?,?,'inbound','ringing',?,?,?)",
      id,
      conn.profile_id,
      conn.id,
      c.id,
      p.id,
      now(),
      now(),
      now() + 90000,
    );
    row = await one(env, "SELECT * FROM calls WHERE id=?", id);
  }
  if (!row) return { ignored: true };
  let status = row.status;
  if (
    ts >= row.provider_at &&
    (!finalStates.includes(status) || p.event === "terminate")
  ) {
    if (p.event === "terminate" && !finalStates.includes(status))
      status =
        p.status === "FAILED" ? "failed" : p.duration ? "completed" : "missed";
    else if (!finalStates.includes(status) && p.status === "REJECTED")
      status = "rejected";
    else if (!finalStates.includes(status) && p.status === "ACCEPTED")
      status = "active";
    else if (
      !finalStates.includes(status) &&
      p.status === "RINGING" &&
      status !== "active"
    )
      status = "dialing";
    else if (
      p.event === "connect" &&
      row.direction === "outbound" &&
      status !== "active"
    )
      status = "connecting";
    const remote = p.session
      ? await seal(
          env,
          session(p.session, row.direction === "inbound" ? "offer" : "answer"),
        )
      : row.remote_session;
    await exec(
      env,
      "UPDATE calls SET status=?,remote_session=?,local_session=CASE WHEN ?=1 THEN NULL ELSE local_session END,provider_at=?,started=coalesce(started,?),ended=?,duration=?,updated=? WHERE id=?",
      status,
      finalStates.includes(status) ? null : remote,
      finalStates.includes(status) ? 1 : 0,
      ts,
      p.start_time ? Number(p.start_time) * 1000 : null,
      finalStates.includes(status) ? Number(p.end_time) * 1000 || ts : null,
      p.duration ?? row.duration,
      now(),
      row.id,
    );
  }
  await changed(env, { ...row, status }, key);
  // Keep SDP out of event history and application webhooks.
  await exec(
    env,
    "INSERT OR IGNORE INTO call_events(event_key,connection_id,external_id,payload,created) VALUES(?,?,?,?,?)",
    key,
    conn.id,
    p.id,
    JSON.stringify({
      event: p.event,
      status: p.status,
      timestamp: p.timestamp,
    }),
    now(),
  );
  return { received: true };
}
export async function expireCalls(env: Env, profile: string) {
  // Old calls must be reconciled locally; the retired provider is never contacted.
  await exec(
    env,
    "UPDATE calls SET status='unknown',error='Integração direta removida. Confirme o encerramento no WhatsApp e reconcilie.',updated=? WHERE profile_id=? AND status IN ('active','preaccepted','dialing','connecting','ringing') AND lease_until<?",
    now(),
    profile,
    now(),
  );
}
