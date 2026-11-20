// Concessão nominal nas opções já existentes do bot. Não concede papel ERP:
// o envelope conserva a pessoa e o motor revalida papel, horário e MFA.
import { one } from "../../db";
import { ApiError, json, type Actor, type Env } from "../../types";
import { COM1_OPERATIONS } from "../../erp/commercial-nfe/metadata.ts";
import { BLING_OPERATIONS } from "../../erp/bling/schema.ts";
import { erpCommercialOperations } from "./commercial-operations.ts";

/** `sensitive` vem da definição de cada operação: leitura sensível (arquivo de
 * cobrança, registro de atividades) segue o mesmo caminho de proposta da escrita. */
export const ERP_BOT_OPERATIONS: readonly { id: string; method: string; path: string; summary: string; sensitive: boolean }[] = [
  ...Object.values(BLING_OPERATIONS).filter(op => op.name !== "erp_bling_oauth_callback").map(op => ({
    id: op.name, method: op.method, path: `erp/v1/receber-bling${op.path === "/" ? "" : op.path}`, summary: op.summary, sensitive: op.sensitive,
  })),
  ...erpCommercialOperations.map(op => ({ id: op.id, method: op.method, path: `erp${op.path}`, summary: op.summary, sensitive: op.sensitive })),
  ...COM1_OPERATIONS.map(op => ({ id: op.name, method: op.method, path: `erp-comercial-nfe/${op.path}`, summary: op.summary, sensitive: op.sensitive })),
  { id: "erp_preferences_import_jobs", method: "GET", path: "erp/v1/importacoes", summary: "Consultar importações por planilha", sensitive: false },
  { id: "erp_preferences_import_job", method: "GET", path: "erp/v1/importacoes/:id", summary: "Consultar resultado de uma importação", sensitive: false },
  { id: "erp_preferences_import_batch", method: "POST", path: "erp/v1/importacoes/:tipo/lote", summary: "Simular ou confirmar um lote de importação por planilha", sensitive: false },
];

/** Leituras sensíveis que o administrador pode deixar o bot executar sozinho. */
export const ERP_BOT_SENSITIVE_READS: readonly string[] = ERP_BOT_OPERATIONS.filter(op => op.sensitive && op.method === "GET").map(op => op.id);

export function erpBotOperationsInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ERP_BOT_OPERATIONS.length ||
      value.some(id => typeof id !== "string" || !ERP_BOT_OPERATIONS.some(op => op.id === id)) ||
      new Set(value).size !== value.length)
    throw new ApiError(400, "invalid_request", "Escolha operações conhecidas do ERP, sem repetições.");
  return value;
}

/** Opção do administrador, desligada por padrão: leituras sensíveis que este
 * bot executa sem proposta. Só vale junto da concessão nominal da operação. */
export function erpBotAutonomousInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ERP_BOT_SENSITIVE_READS.length ||
      value.some(id => typeof id !== "string" || !ERP_BOT_SENSITIVE_READS.includes(id)) || new Set(value).size !== value.length)
    throw new ApiError(400, "invalid_request", "Escolha leituras sensíveis conhecidas do ERP, sem repetições.");
  return value;
}

/** Lida de novo em cada chamada/confirmação; nunca aceita concessão em `via`. */
export async function erpBotGrantedOperations(env: Env, actor: Actor, profile: string): Promise<readonly string[]> {
  return (await erpBotOptions(env, actor, profile)).operations;
}

const names = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
async function erpBotOptions(env: Env, actor: Actor, profile: string): Promise<{ operations: readonly string[]; autonomous: readonly string[] }> {
  if (actor.kind !== "user" || !actor.via) return { operations: [], autonomous: [] };
  const row = await one(env, `SELECT b.remote_profile,c.config FROM bots b
    JOIN connections c ON c.id=b.connection_id AND c.profile_id=b.profile_id
    JOIN bot_runs r ON r.bot_id=b.id AND r.profile_id=b.profile_id
    JOIN internal_chats h ON h.id=json_extract(r.context,'$.internal_chat_id') AND h.profile_id=r.profile_id
    WHERE b.id=? AND b.profile_id=? AND b.enabled=1 AND c.status='active' AND r.id=? AND r.actor=? AND r.conversation_id IS NULL
      AND ((h.member_a=? AND h.member_b=?) OR (h.member_b=? AND h.member_a=?))`,
    actor.via.bot_id, profile, actor.via.run_id, actor.id,
    actor.id, `bot:${actor.via.bot_id}`, actor.id, `bot:${actor.via.bot_id}`);
  const options = row && json(row.config).bot_options?.[row.remote_profile];
  const operations = names(options?.erp_operations);
  return { operations, autonomous: names(options?.erp_autonomous_operations).filter(id => operations.includes(id)) };
}

export async function erpBotOperationGranted(env: Env, actor: Actor, profile: string, operation: string): Promise<boolean> {
  return (await erpBotGrantedOperations(env, actor, profile)).includes(operation);
}

/** Somente a rota nominal liberada; escrita e leitura sensível usam a proposta
 * já reclamada pela confirmação humana. Um id de proposta solto não é prova de
 * confirmação. A leitura sensível dispensa a proposta só quando o
 * administrador marcou aquela operação como autônoma para aquele bot. */
export function erpBotOperation(profile: string, method: string, path?: string) {
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/`;
  if (!path?.startsWith(prefix)) return undefined;
  const route = path.slice(prefix.length), verb = method.toUpperCase();
  return ERP_BOT_OPERATIONS.find(op => op.method === (verb === "HEAD" ? "GET" : verb) &&
    new RegExp(`^${op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+")}/?$`).test(route));
}

export async function erpBotDelegation(env: Env, actor: Actor, profile: string, method: string, path?: string, body?: unknown): Promise<boolean> {
  if (!actor.via || !path) return false;
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/`;
  if (!path.startsWith(prefix)) return false;
  const route = path.slice(prefix.length), verb = method.toUpperCase();
  const operation = erpBotOperation(profile, verb, path);
  if (!operation) return false;
  const options = await erpBotOptions(env, actor, profile);
  if (!options.operations.includes(operation.id)) return false;
  const reading = verb === "GET" || verb === "HEAD";
  if (reading && (!operation.sensitive || options.autonomous.includes(operation.id))) return true;
  if (!actor.sessionId || !actor.via.proposal_id) return false;
  const proposal = await one(env, `SELECT path,params FROM bot_proposals WHERE id=? AND profile_id=?
    AND actor=? AND bot_id=? AND run_id=? AND mode='team' AND status='running' AND method=? AND decided_at IS NOT NULL`,
    actor.via.proposal_id, profile, actor.id, actor.via.bot_id, actor.via.run_id, reading ? "GET" : verb);
  if (!proposal) return false;
  const params = json(proposal.params);
  const keys = new Set<string>();
  const resolved = proposal.path.replace(/:(\w+)/g, (_: string, key: string) => { keys.add(key); return encodeURIComponent(String(params[key] ?? "")); });
  if (resolved !== route.replace(/\/$/, "")) return false;
  if (body === undefined) return true;
  const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return canonical(body) === canonical(Object.fromEntries(Object.entries(params).filter(([key]) => !keys.has(key))));
}
