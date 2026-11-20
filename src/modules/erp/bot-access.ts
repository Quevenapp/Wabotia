// Concessão nominal nas opções já existentes do bot. Não concede papel ERP:
// o envelope conserva a pessoa e o motor revalida papel, horário e MFA.
import { one } from "../../db";
import { ApiError, json, type Actor, type Env } from "../../types";
import { COM1_OPERATIONS } from "../../erp/commercial-nfe/metadata.ts";
import { erpCommercialOperations } from "./commercial-operations.ts";

export const ERP_BOT_OPERATIONS = [
  ...erpCommercialOperations.map(op => ({ id: op.id, method: op.method, path: `erp${op.path}`, summary: op.summary })),
  ...COM1_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary })),
  { id: "erp_preferences_import_jobs", method: "GET", path: "erp/v1/importacoes", summary: "Consultar importações por planilha" },
  { id: "erp_preferences_import_job", method: "GET", path: "erp/v1/importacoes/:id", summary: "Consultar resultado de uma importação" },
  { id: "erp_preferences_import_batch", method: "POST", path: "erp/v1/importacoes/:tipo/lote", summary: "Simular ou confirmar um lote de importação por planilha" },
];

export function erpBotOperationsInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ERP_BOT_OPERATIONS.length ||
      value.some(id => typeof id !== "string" || !ERP_BOT_OPERATIONS.some(op => op.id === id)) ||
      new Set(value).size !== value.length)
    throw new ApiError(400, "invalid_request", "Escolha operações conhecidas do ERP, sem repetições.");
  return value;
}

/** Lida de novo em cada chamada/confirmação; nunca aceita concessão em `via`. */
export async function erpBotGrantedOperations(env: Env, actor: Actor, profile: string): Promise<readonly string[]> {
  if (actor.kind !== "user" || !actor.via) return [];
  const row = await one(env, `SELECT b.remote_profile,c.config FROM bots b
    JOIN connections c ON c.id=b.connection_id AND c.profile_id=b.profile_id
    JOIN bot_runs r ON r.bot_id=b.id AND r.profile_id=b.profile_id
    JOIN internal_chats h ON h.id=json_extract(r.context,'$.internal_chat_id') AND h.profile_id=r.profile_id
    WHERE b.id=? AND b.profile_id=? AND b.enabled=1 AND c.status='active' AND r.id=? AND r.actor=? AND r.conversation_id IS NULL
      AND ((h.member_a=? AND h.member_b=?) OR (h.member_b=? AND h.member_a=?))`,
    actor.via.bot_id, profile, actor.via.run_id, actor.id,
    actor.id, `bot:${actor.via.bot_id}`, actor.id, `bot:${actor.via.bot_id}`);
  const granted = row && json(row.config).bot_options?.[row.remote_profile]?.erp_operations;
  return Array.isArray(granted) ? granted.filter((id): id is string => typeof id === "string") : [];
}

export async function erpBotOperationGranted(env: Env, actor: Actor, profile: string, operation: string): Promise<boolean> {
  return (await erpBotGrantedOperations(env, actor, profile)).includes(operation);
}

/** Somente a rota nominal liberada; escrita usa a proposta já reclamada pela
 * confirmação humana. Um id de proposta solto não é prova de confirmação. */
export async function erpBotDelegation(env: Env, actor: Actor, profile: string, method: string, path?: string): Promise<boolean> {
  if (!actor.via || !path) return false;
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/`;
  if (!path.startsWith(prefix)) return false;
  const route = path.slice(prefix.length), verb = method.toUpperCase();
  const operation = ERP_BOT_OPERATIONS.find(op => op.method === (verb === "HEAD" ? "GET" : verb) &&
    new RegExp(`^${op.path.replace(/:[a-z_]+/g, "[^/]+")}$`).test(route));
  if (!operation || !await erpBotOperationGranted(env, actor, profile, operation.id)) return false;
  if (verb === "GET" || verb === "HEAD") return true;
  if (!actor.sessionId || !actor.via.proposal_id) return false;
  const proposal = await one(env, `SELECT path,params FROM bot_proposals WHERE id=? AND profile_id=?
    AND actor=? AND bot_id=? AND run_id=? AND mode='team' AND status='running' AND method=? AND decided_at IS NOT NULL`,
    actor.via.proposal_id, profile, actor.id, actor.via.bot_id, actor.via.run_id, verb);
  if (!proposal) return false;
  const params = json(proposal.params);
  return proposal.path.replace(/:(\w+)/g, (_: string, key: string) => encodeURIComponent(String(params[key] ?? ""))) === route;
}
