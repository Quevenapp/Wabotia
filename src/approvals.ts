// Pedido de aprovação à equipe, originado numa conversa de cliente (docs/API.md
// "Pedidos de aprovação", docs/MODULOS.md "Pedido de aprovação"). Ex.: o
// cliente pede desconto ao bot; o módulo monta o cartão com dados lidos por
// código (itens, preço de tabela, últimas compras), a equipe aprova (com
// ajuste opcional), recusa ou assume a conversa. O modelo nunca concede nada
// e não escreve os números: no máximo um resumo, guardado à parte.
import { all, exec, one } from "./db";
import { actorForUser, canProfile } from "./security";
import { allows, rolesOf } from "./access";
import { audit, event } from "./events";
import { approvalHook } from "./modules/hooks";
import { enqueue, handoffToPerson, handoff as coreHandoff, conversation } from "./service";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";

/** Quem pode decidir (e quem vê um campo restrito). */
export interface ApprovalAudience {
  /** Só administradores. */
  admin?: boolean;
  /** Item do acesso por pessoa (módulo ou área do núcleo), ex.: "mensalidade". */
  access?: string;
  /** Papel de módulo, ex.: "caixa:supervisor". */
  role?: string;
}

/** Linha do cartão, montada pelo módulo com dados lidos por código. */
export interface ApprovalField {
  key: string;
  label: string;
  /** Texto já formatado ("R$ 89,90", "11/2026"). */
  value: string;
  /** Campo sensível (custo, margem): só para esta audiência. */
  restricted?: ApprovalAudience;
}

export interface ApprovalRequest {
  kind: string;
  ref?: string | null;
  title: string;
  fields: ApprovalField[];
  approvers: ApprovalAudience;
  /** Ajuste opcional ao aprovar (valor do desconto, por exemplo). */
  adjust?: {
    label: string;
    type: "money" | "percent" | "number";
    min?: number;
    max?: number;
  } | null;
  /** Prazo para decidir; padrão 30 min, de 5 min a 7 dias. */
  ttlMinutes?: number;
  /** Resumo escrito pelo bot: mostrado à parte, como não verificado. */
  modelSummary?: string | null;
  /** Execução do bot que pediu (para o cartão na conversa interna). */
  runId?: string | null;
  botId?: string | null;
  /** Repetir a mesma chave devolve o mesmo pedido. */
  key: string;
}

const DEFAULT_TTL = 30;
const MAX_APPROVER_MESSAGES = 20;

function audienceAllows(actor: Actor, audience: ApprovalAudience | undefined) {
  if (!audience) return true;
  if (actor.kind !== "user") return false;
  if (actor.role === "admin") return true;
  if (audience.admin) return false;
  if (audience.role && !rolesOf(actor).includes(audience.role)) return false;
  if (audience.access && !allows(actor, audience.access)) return false;
  return true;
}

/** O pedido como a pessoa vê: campos restritos só para quem pode. */
export function approvalView(row: any, viewer: Actor | null) {
  if (!row) return null;
  const fields: ApprovalField[] = json(row.fields, []);
  const expired = row.status === "pending" && row.expires_at <= now();
  return {
    id: row.id,
    module_id: row.module_id,
    kind: row.kind,
    ref_id: row.ref_id,
    conversation_id: row.conversation_id,
    title: row.title,
    status: expired ? "expired" : row.status,
    fields: fields
      .filter((f) => !f.restricted || (viewer && audienceAllows(viewer, f.restricted)))
      .map(({ restricted, ...f }) => f),
    hidden_fields: fields.filter(
      (f) => f.restricted && !(viewer && audienceAllows(viewer, f.restricted)),
    ).length,
    model_summary: row.model_summary,
    adjust: json(row.adjust, null),
    can_decide: !!viewer && audienceAllows(viewer, json(row.approvers, {})),
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    reason: row.reason,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    expires_at: row.expires_at,
    created: row.created,
  };
}

/** Pessoas da área que podem decidir (para o cartão e o push). */
async function eligibleApprovers(env: Env, profile: string, audience: ApprovalAudience) {
  const users = await all(
    env,
    "SELECT * FROM users WHERE disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?)) ORDER BY role='admin' DESC,created LIMIT 200",
    profile,
  );
  const out: string[] = [];
  for (const u of users) {
    const actor = await actorForUser(env, u.id);
    if (actor && canProfile(actor, profile) && audienceAllows(actor, audience)) out.push(u.id);
  }
  return out;
}

/** Cria o pedido (ou devolve o mesmo pela chave) e avisa quem decide. */
export async function requestApproval(
  env: Env,
  module: string,
  c: Conversation,
  request: ApprovalRequest,
) {
  requireValue(c.chat_type !== "group", "Pedido de aprovação só em conversa individual.");
  const sourceKey = `approval:${module}:${c.id}:${request.key}`;
  const old = await one(env, "SELECT * FROM approvals WHERE source_key=?", sourceKey);
  if (old) return old;
  requireValue(/^[a-z0-9_.-]{1,40}$/.test(request.kind), "Tipo de aprovação inválido.");
  const title = String(request.title || "").trim().slice(0, 200);
  requireValue(title, "Informe o título do pedido.");
  requireValue(
    Array.isArray(request.fields) && request.fields.length <= 30,
    "Até 30 linhas no cartão.",
  );
  const fields = request.fields.map((f) => ({
    key: String(f.key).slice(0, 60),
    label: String(f.label).slice(0, 80),
    value: String(f.value).slice(0, 300),
    ...(f.restricted ? { restricted: f.restricted } : {}),
  }));
  const ttl = Math.min(7 * 24 * 60, Math.max(5, Math.round(request.ttlMinutes || DEFAULT_TTL)));
  const id = uid(),
    at = now();
  await exec(
    env,
    "INSERT INTO approvals(id,profile_id,module_id,kind,ref_id,conversation_id,run_id,bot_id,title,fields,approvers,adjust,model_summary,status,expires_at,source_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
    id,
    c.profile_id,
    module,
    request.kind,
    request.ref ?? null,
    c.id,
    request.runId ?? null,
    request.botId ?? null,
    title,
    JSON.stringify(fields),
    JSON.stringify(request.approvers || { admin: true }),
    request.adjust ? JSON.stringify(request.adjust) : null,
    request.modelSummary ? String(request.modelSummary).slice(0, 1000) : null,
    at + ttl * 60000,
    sourceKey,
    at,
    at,
  );
  const approvers = await eligibleApprovers(env, c.profile_id, request.approvers || { admin: true });
  // O cartão na conversa interna de cada pessoa com o bot que atendeu.
  if (request.botId)
    for (const person of approvers.slice(0, MAX_APPROVER_MESSAGES)) {
      const [a, b] = [person, `bot:${request.botId}`].sort();
      await exec(
        env,
        "INSERT OR IGNORE INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)",
        uid(),
        c.profile_id,
        a,
        b,
        at,
        at,
      );
      const chat = await one(
        env,
        "SELECT id FROM internal_chats WHERE profile_id=? AND member_a=? AND member_b=?",
        c.profile_id,
        a,
        b,
      );
      const messageId = `approval:${id}:${person}`;
      await exec(
        env,
        "INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,kind,payload,status,source_key,created) VALUES(?,?,?,?,'approval',?,'sent',?,?)",
        messageId,
        chat.id,
        `bot:${request.botId}`,
        `Pedido de aprovação: ${title}. Decida no painel ou no app atualizado (vale ${ttl} minutos).`,
        JSON.stringify({ approval: { id } }),
        messageId,
        at,
      );
      await exec(env, "UPDATE internal_chats SET updated=? WHERE id=?", at, chat.id);
      await event(env, c.profile_id, "internal.message", messageId, { chat_id: chat.id }, `internal:${messageId}`);
    }
  await event(
    env,
    c.profile_id,
    "approval.requested",
    id,
    { approval_id: id, module_id: module, kind: request.kind, conversation_id: c.id, approvers, title },
    sourceKey,
  );
  return one(env, "SELECT * FROM approvals WHERE id=?", id);
}

export async function loadApproval(env: Env, profile: string, id: string) {
  const row = await one(env, "SELECT * FROM approvals WHERE id=? AND profile_id=?", id, profile);
  if (!row) throw new ApiError(404, "not_found", "Pedido de aprovação não encontrado.");
  return row;
}

export async function listApprovals(
  env: Env,
  actor: Actor,
  profile: string,
  query: { status?: string; conversation_id?: string },
) {
  requirePerson(actor);
  const rows = await all(
    env,
    `SELECT * FROM approvals WHERE profile_id=?${query.status === "pending" ? " AND status='pending' AND expires_at>?" : ""}${query.conversation_id ? " AND conversation_id=?" : ""} ORDER BY created DESC LIMIT 100`,
    profile,
    ...(query.status === "pending" ? [now()] : []),
    ...(query.conversation_id ? [query.conversation_id] : []),
  );
  return {
    data: rows
      .filter((r) => audienceAllows(actor, json(r.approvers, {})))
      .map((r) => approvalView(r, actor)),
  };
}

function requirePerson(actor: Actor) {
  if (actor.kind !== "user" || actor.via || actor.id.startsWith("bot:"))
    throw new ApiError(403, "person_required", "Só uma pessoa da equipe decide, pela sessão dela.");
}

export interface ApprovalDecision {
  status: "approved" | "declined" | "handoff" | "expired";
  /** Valor do ajuste, já validado pelo módulo. */
  value: number | null;
  reason: string | null;
  /** Quem decidiu (pessoa), ou null no vencimento. */
  actor: Actor | null;
}

const decisionStatus: Record<string, ApprovalDecision["status"]> = {
  approve: "approved",
  decline: "declined",
  handoff: "handoff",
};

/**
 * Decisão de uma pessoa: o primeiro vence (UPDATE condicionado). O módulo
 * confere o ajuste (validate) e aplica o efeito (decided) com o ator de quem
 * decidiu, então as regras dele (papel, limite) valem. Erro no módulo
 * devolve o pedido a pendente para outra pessoa tentar.
 */
export async function decideApproval(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
  data: { decision?: unknown; value?: unknown; reason?: unknown },
  requestId: string,
) {
  requirePerson(actor);
  const status = decisionStatus[String(data?.decision)];
  requireValue(status, "Decisão: approve, decline ou handoff.");
  let row = await loadApproval(env, profile, id);
  if (!audienceAllows(actor, json(row.approvers, {})))
    throw new ApiError(403, "approval_forbidden", "Você não pode decidir este pedido.");
  if (row.status === "pending" && row.expires_at <= now()) {
    await expireApproval(env, row);
    row = await loadApproval(env, profile, id);
  }
  if (row.status !== "pending") {
    // Repetição da mesma decisão pela mesma pessoa: o mesmo resultado.
    if (row.decided_by === actor.id && row.status === status) return approvalView(row, actor);
    throw new ApiError(
      409,
      row.status === "expired" ? "approval_expired" : "approval_closed",
      row.status === "expired"
        ? "O pedido venceu."
        : `Já decidido${row.decided_by ? " por outra pessoa" : ""}.`,
    );
  }
  const adjust = json(row.adjust, null);
  let value: number | null = null;
  if (status === "approved" && data.value !== undefined && data.value !== null && data.value !== "") {
    requireValue(adjust, "Este pedido não aceita ajuste.");
    value = Number(data.value);
    requireValue(
      Number.isFinite(value) &&
        (adjust.min === undefined || value >= adjust.min) &&
        (adjust.max === undefined || value <= adjust.max),
      `${adjust.label}: valor fora do permitido.`,
    );
  }
  const reason = data.reason ? String(data.reason).trim().slice(0, 300) || null : null;
  const claimed = await exec(
    env,
    "UPDATE approvals SET status='deciding',decided_by=?,updated=? WHERE id=? AND status='pending' AND expires_at>?",
    actor.id,
    now(),
    id,
    now(),
  );
  if (!claimed.meta.changes) {
    const fresh = await loadApproval(env, profile, id);
    throw new ApiError(409, "approval_closed", fresh.status === "expired" ? "O pedido venceu." : "Já decidido por outra pessoa.");
  }
  const hook = approvalHook(row.module_id, row.kind);
  const decision: ApprovalDecision = { status, value, reason, actor };
  try {
    if (status === "approved" && hook?.validate) await hook.validate(env, profile, row, decision);
    if (status === "handoff") {
      const c = await conversation(env, row.conversation_id, profile);
      await handoffToPerson(env, c, actor.id, `Pedido de aprovação: ${row.title}`, {
        module: row.module_id,
        summary: row.title,
        flags: ["pedido de aprovação"],
        at: now(),
      });
    }
    if (hook?.decided) await hook.decided(env, profile, row, decision);
  } catch (error) {
    await exec(env, "UPDATE approvals SET status='pending',decided_by=NULL,updated=? WHERE id=? AND status='deciding'", now(), id);
    throw error;
  }
  await exec(
    env,
    "UPDATE approvals SET status=?,value=?,reason=?,decided_at=?,updated=? WHERE id=?",
    status,
    value,
    reason,
    now(),
    now(),
    id,
  );
  await audit(env, actor, profile, `approval.${data.decision}`, id, requestId);
  await event(env, profile, "approval.decided", id, { approval_id: id, module_id: row.module_id, kind: row.kind, status, value, decided_by: actor.id, conversation_id: row.conversation_id }, `approval-decided:${id}`);
  return approvalView(await loadApproval(env, profile, id), actor);
}

/**
 * Vencido sem decisão: o módulo decide (gancho com status "expired"); sem
 * gancho, o padrão é avisar o cliente e passar a conversa para a equipe.
 */
export async function expireApproval(env: Env, row: any) {
  const claimed = await exec(
    env,
    "UPDATE approvals SET status='expired',decided_at=?,updated=? WHERE id=? AND status='pending' AND expires_at<=?",
    now(),
    now(),
    row.id,
    now(),
  );
  if (!claimed.meta.changes) return;
  const hook = approvalHook(row.module_id, row.kind);
  try {
    if (hook?.decided) await hook.decided(env, row.profile_id, row, { status: "expired", value: null, reason: null, actor: null });
    else {
      const c = await conversation(env, row.conversation_id, row.profile_id);
      await enqueue(env, c, "system", "notification", { text: "A equipe não respondeu a tempo. Vou passar sua conversa para um atendente.", automation: "approval" }, `approval-expired:${row.id}`);
      await coreHandoff(env, c, `Pedido de aprovação venceu: ${row.title}`, null, row.title, true, {
        meta: { module: row.module_id, summary: row.title, flags: ["aprovação vencida"], at: now() },
        source: "module",
      });
    }
  } catch (error) {
    console.error(JSON.stringify({ component: "approvals", approval: row.id, error: String((error as Error)?.message || error).slice(0, 300) }));
  }
  await event(env, row.profile_id, "approval.decided", row.id, { approval_id: row.id, module_id: row.module_id, kind: row.kind, status: "expired", conversation_id: row.conversation_id }, `approval-decided:${row.id}`);
}

/** Rodada periódica da área: vence os pedidos sem decisão. */
export async function expireApprovals(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT * FROM approvals WHERE profile_id=? AND status='pending' AND expires_at<=? LIMIT 20",
    profile,
    now(),
  ))
    await expireApproval(env, row);
}
