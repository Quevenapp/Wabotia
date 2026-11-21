import { all, one, exec, batch, cachedOne, PROFILE_SETTINGS_SQL } from "./db";
import {
  type Actor,
  type Env,
  ApiError,
  json,
  now,
  uid,
  requireValue,
} from "./types";
import { access } from "./security";
import { event } from "./events";
import { createRun } from "./service";
import { declaredGrants, grantsFor } from "./module-grants";
import { moduleStates } from "./modules/registry";
import { approvalView } from "./approvals";

function teamAccess(actor: Actor, profile: string) {
  access(actor, profile, "presence:read");
  if (actor.kind !== "user" || actor.id.startsWith("bot:"))
    throw new ApiError(
      403,
      "people_only",
      "A conversa interna exige uma conta de pessoa.",
    );
}
/**
 * Pessoas ativas da área (id, nome, papel), para os aplicativos escolherem um
 * responsável (ordem de serviço, agenda…). Sem bots nem consultas ao provedor,
 * ao contrário de teamDirectory. Pessoa da área ou chave com conversations:read.
 */
export async function areaPeople(
  env: Env,
  actor: Actor,
  profile: string,
  grant?: string | null,
) {
  access(actor, profile, "conversations:read");
  const users = await all(
    env,
    "SELECT id,name,role,access FROM users WHERE disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?)) ORDER BY name COLLATE NOCASE,id",
    profile,
  );
  // Papéis nos módulos ligados (docs/MODULOS.md, "Acessos e papéis").
  const states = await moduleStates(env, profile);
  if (grant)
    requireValue(
      declaredGrants(states).some((g) => g.id === grant),
      "Papel desconhecido ou de módulo desligado.",
    );
  return {
    data: users
      .map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        grants: grantsFor({ access: u.access }, states),
      }))
      .filter((u) => !grant || u.grants.includes(grant)),
  };
}

/** Papéis que esta área pode conceder (módulos ligados) e quem tem cada um. */
export async function areaGrants(env: Env, actor: Actor, profile: string) {
  access(actor, profile, "conversations:read");
  const states = await moduleStates(env, profile);
  const people = (await areaPeople(env, actor, profile)).data;
  // O embutido não tem campos/filhos sensíveis. Preserve seu catálogo legado;
  // a concessão continua declarada e nunca é herdada do administrador.
  const customWork = states.os &&
    json((await cachedOne(env, PROFILE_SETTINGS_SQL, profile))?.settings).os_work_types?.length;
  return {
    data: declaredGrants(states).filter((g) => g.id !== "os:sensitive" || customWork ||
      people.some((p) => p.grants.includes(g.id))).map((g) => ({
      ...g,
      people: people
        .filter((p) => p.grants.includes(g.id))
        .map((p) => ({ id: p.id, name: p.name })),
    })),
  };
}
export async function teamDirectory(env: Env, actor: Actor, profile: string) {
  teamAccess(actor, profile);
  const users = await all(
    env,
    "SELECT u.id,u.name,coalesce(p.present,0) present FROM users u LEFT JOIN presence p ON p.actor=u.id AND p.profile_id=? WHERE u.disabled=0 AND (u.role='admin' OR EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?)) ORDER BY u.name,u.id",
    profile,
    profile,
  );
  const bots = await all(
    env,
    "SELECT b.id,b.name,b.enabled,b.line_ids,c.kind,c.status,c.last_seen,c.config FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.profile_id=? ORDER BY b.name,b.id",
    profile,
  );
  return {
    data: [
      ...users.map((u) => ({
        id: u.id,
        kind: "user",
        name: u.name,
        online: !!u.present,
      })),
      ...bots.map((b) => ({
        id: `bot:${b.id}`,
        kind: "bot",
        bot_id: b.id,
        name: b.name,
        // Um provedor de IA não tem servidor a sondar: conta como online quando
        // a conexão está ativa.
        online:
          !!b.enabled &&
          b.status === "active" &&
          b.kind === "ai",
        enabled: !!b.enabled,
        last_seen: b.last_seen,
        line_ids: b.line_ids === null ? null : json(b.line_ids, []),
        // Para a Equipe dizer o que o bot faz e por que está indisponível.
        connection_kind: b.kind,
        connection_status: b.status,
        does: botDoes(b),
      })),
    ],
  };
}
/** Uma linha sobre o que o bot faz na conversa interna (Equipe → Bots). */
export function botDoes(b: { kind: string; config?: unknown }) {
  if (b.kind !== "ai")
    return "Hermes retirado: escolha um bot interno.";
  const cfg = json(b.config as any);
  if (cfg.tools_unsupported_at)
    return "Só conversa: o provedor de IA recusou as ferramentas, então ele não consulta o sistema.";
  return "Consulta o Vinki e propõe ações em seu nome, com o seu acesso; nada muda antes de você tocar em Confirmar.";
}
export async function internalChat(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  teamAccess(actor, profile);
  const chat = await one(
    env,
    "SELECT * FROM internal_chats WHERE id=? AND profile_id=? AND (member_a=? OR member_b=?)",
    id,
    profile,
    actor.id,
    actor.id,
  );
  if (!chat)
    throw new ApiError(404, "not_found", "Conversa interna não encontrada.");
  return chat;
}
async function withPeer(
  env: Env,
  actor: Actor,
  profile: string,
  chat: any,
  directory?: any[],
) {
  const peerId = chat.member_a === actor.id ? chat.member_b : chat.member_a;
  const peer = (
    directory || (await teamDirectory(env, actor, profile)).data
  ).find((entry) => entry.id === peerId);
  return {
    ...chat,
    peer: peer || {
      id: peerId,
      kind: peerId.startsWith("bot:") ? "bot" : "user",
      name: "Contato indisponível",
      online: false,
    },
  };
}
export async function listInternalChats(
  env: Env,
  actor: Actor,
  profile: string,
) {
  teamAccess(actor, profile);
  const chats = await all(
    env,
    "SELECT * FROM internal_chats WHERE profile_id=? AND (member_a=? OR member_b=?) ORDER BY updated DESC,id LIMIT 200",
    profile,
    actor.id,
    actor.id,
  );
  const directory = (await teamDirectory(env, actor, profile)).data;
  return {
    data: await Promise.all(
      chats.map((chat) => withPeer(env, actor, profile, chat, directory)),
    ),
  };
}
export async function internalChatDetail(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  const chat = await internalChat(env, actor, profile, id);
  const messages = (
    await all(
      env,
      "SELECT m.id,m.author,m.text,m.kind,m.payload,m.created,coalesce(r.status,m.status) status,m.run_id FROM internal_messages m LEFT JOIN bot_runs r ON r.id=m.run_id WHERE m.chat_id=? ORDER BY m.created DESC,m.rowid DESC LIMIT 500",
      id,
    )
  )
    .reverse()
    .map((m) => ({
      ...m,
      // Proposta e resultado do bot (src/bot-actions): o estado vem da
      // proposta, sempre atual; `text` é a reserva para apps antigos.
      payload: m.payload ? json(m.payload, null) : null,
    }));
  // Pedido de aprovação (src/approvals.ts): o cartão como esta pessoa vê,
  // sempre atual (quem decidiu, campos restritos só para quem pode).
  const approvalIds = messages
    .filter((m) => m.kind === "approval" && m.payload?.approval?.id)
    .map((m) => m.payload.approval.id);
  if (approvalIds.length) {
    const rows = await all(
      env,
      "SELECT * FROM approvals WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
      profile,
      JSON.stringify(approvalIds),
    );
    for (const m of messages)
      if (m.kind === "approval")
        m.payload = {
          approval: approvalView(
            rows.find((r) => r.id === m.payload?.approval?.id),
            actor,
          ),
        };
  }
  // Estado atual das propostas mostradas (confirmada, vencida…).
  const ids = messages
    .filter((m) => m.kind === "proposal" && m.payload?.proposal?.id)
    .map((m) => m.payload.proposal.id);
  if (ids.length) {
    const rows = await all(
      env,
      "SELECT id,status,expires_at,decided_at,error FROM bot_proposals WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids),
    );
    for (const m of messages) {
      const row = rows.find((r) => r.id === m.payload?.proposal?.id);
      if (row) {
        const expired = row.status === "pending" && row.expires_at <= now();
        m.payload.proposal = {
          ...m.payload.proposal,
          status: expired ? "expired" : row.status,
          decided_at: row.decided_at,
          error: row.error,
        };
      }
    }
  }
  return { ...(await withPeer(env, actor, profile, chat)), messages };
}
export async function internalCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  requestId: string,
  // A question asked from the bot screen: same conversation, but the bot may
  // still return files, as a direct question always could.
  direct = false,
) {
  teamAccess(actor, profile);
  if (op === "internal.create") {
    const peer = (await teamDirectory(env, actor, profile)).data.find(
      (entry) => entry.id === data.peer_id,
    );
    requireValue(
      peer && peer.id !== actor.id,
      "Escolha outra pessoa ou bot desta área de atendimento.",
    );
    const [a, b] = [actor.id, peer.id].sort();
    const id = uid();
    await exec(
      env,
      "INSERT OR IGNORE INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)",
      id,
      profile,
      a,
      b,
      now(),
      now(),
    );
    const chat = await one(
      env,
      "SELECT * FROM internal_chats WHERE profile_id=? AND member_a=? AND member_b=?",
      profile,
      a,
      b,
    );
    return withPeer(env, actor, profile, chat);
  }
  const chat = await internalChat(env, actor, profile, data.id),
    peerId = chat.member_a === actor.id ? chat.member_b : chat.member_a;
  const peer = (await teamDirectory(env, actor, profile)).data.find(
    (entry) => entry.id === peerId,
  );
  requireValue(
    peer,
    "Este contato não está mais disponível na área de atendimento.",
  );
  requireValue(
    typeof data.text === "string" &&
      data.text.trim().length &&
      data.text.length <= 60000,
    "Informe uma mensagem de até 60.000 caracteres.",
  );
  const source = `internal:${profile}:${actor.id}:${requestId}`;
  const old = await one(
    env,
    "SELECT * FROM internal_messages WHERE source_key=?",
    source,
  );
  if (old) return old;
  const id = uid(),
    text = data.text.trim();
  let runId: string | null = null;
  if (peer.kind === "bot") {
    const history = await all(
      env,
      "SELECT author,text FROM internal_messages WHERE chat_id=? ORDER BY created DESC,rowid DESC LIMIT 20",
      chat.id,
    );
    const run = await createRun(
      env,
      actor,
      profile,
      {
        bot_id: peerId.slice(4),
        input: JSON.stringify({ message: text, history: history.reverse() }),
      },
      {
        source_key: source,
        context: {
          internal_chat_id: chat.id,
          internal_message_id: id,
          ...(direct ? { direct: true } : {}),
        },
      },
    );
    runId = run.id;
  }
  await batch(env, [
    [
      "INSERT INTO internal_messages(id,chat_id,author,text,status,run_id,source_key,created) VALUES(?,?,?,?,?,?,?,?)",
      [
        id,
        chat.id,
        actor.id,
        text,
        runId ? "queued" : "sent",
        runId,
        source,
        now(),
      ],
    ],
    ["UPDATE internal_chats SET updated=? WHERE id=?", [now(), chat.id]],
  ]);
  await event(
    env,
    profile,
    "internal.message",
    id,
    { chat_id: chat.id },
    `internal:${id}`,
  );
  return {
    id,
    author: actor.id,
    text,
    created: now(),
    status: runId ? "queued" : "sent",
    run_id: runId,
  };
}
/**
 * A person asking a bot directly (the bot screen of the panel and of the
 * apps) talks in the same private conversation the internal chat shows, so
 * the history is one and follows the person across devices. Returns null when
 * that conversation is not available (integrations, or a bot outside the
 * person's team directory); the caller then runs a plain direct question.
 */
export async function askBotInChat(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  requestId: string,
) {
  if (actor.kind !== "user" || typeof data?.bot_id !== "string") return null;
  if (typeof data.input !== "string" || !data.input.trim()) return null;
  const peerId = `bot:${data.bot_id}`;
  let chat: any;
  try {
    if (
      !(await teamDirectory(env, actor, profile)).data.some(
        (entry) => entry.id === peerId,
      )
    )
      return null;
    chat = await internalCommand(
      env,
      actor,
      profile,
      "internal.create",
      { peer_id: peerId },
      requestId,
    );
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
  const message = await internalCommand(
    env,
    actor,
    profile,
    "internal.send",
    { id: chat.id, text: data.input },
    requestId,
    true,
  );
  if (!message.run_id) return null;
  const run = await one(
    env,
    "SELECT id,status FROM bot_runs WHERE id=?",
    message.run_id,
  );
  return { id: message.run_id, status: run?.status || "queued" };
}
/** What the person typed, for a run whose input carries the chat history. */
export function runQuestion(run: any) {
  if (!json(run.context).internal_chat_id) return run.input;
  const parsed = json(run.input, null);
  return typeof parsed?.message === "string" ? parsed.message : run.input;
}
export async function finishInternalRun(env: Env, run: any, output: string) {
  const chatId = json(run.context).internal_chat_id;
  if (!chatId) return;
  const chat = await one(
    env,
    "SELECT * FROM internal_chats WHERE id=? AND profile_id=? AND (member_a=? OR member_b=?)",
    chatId,
    run.profile_id,
    run.actor,
    run.actor,
  );
  if (!chat || ![chat.member_a, chat.member_b].includes(`bot:${run.bot_id}`))
    return;
  const parsed = json(output, null),
    text = typeof parsed?.text === "string" ? parsed.text : output;
  const id = `bot-reply:${run.id}`;
  await batch(env, [
    [
      "INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,source_key,created) VALUES(?,?,?,?,?,?)",
      [
        id,
        chat.id,
        `bot:${run.bot_id}`,
        String(text).slice(0, 60000),
        id,
        now(),
      ],
    ],
    ["UPDATE internal_chats SET updated=? WHERE id=?", [now(), chat.id]],
  ]);
  await event(
    env,
    run.profile_id,
    "internal.message",
    id,
    { chat_id: chat.id },
    id,
  );
}
