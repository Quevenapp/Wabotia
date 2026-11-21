// Rotas da conciliação do ERP, em /api/v1/profiles/:profile/erp-conciliacao
// (operações em ./contract.ts): extrato do banco (OFX e planilha), sugestões,
// conciliar, baixar, lançar, ignorar e desfazer, regras e modelos de planilha;
// extrato da adquirente, casamento com as vendas, taxas e recebimento na conta.
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, nas sensíveis, a proposta que a pessoa confirmou), módulo ERP
// ligado e a parte Financeiro ligada (desligada: 409 module_disabled e qual
// ligar). O motor confere de novo papel, permissão, horário de acesso e
// segundo fator.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ERP_CONCILIACAO_PART, erpReconciliationOperationFor, type ErpReconciliationOperation } from "./contract.ts";
import { ReconciliationArgsError, reconciliationRpcArgs, uuid } from "./args.ts";
import { RECONCILIATION_REASONS, prefixed } from "./reasons.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
/** Arquivo de até 2 MB em texto, com folga para o JSON. */
const BODY_LIMIT = 2_600_000;

/** O comando da gravação: o do corpo, o da Idempotency-Key ou o do próprio pedido (a repetição devolve o mesmo resultado). */
async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) return uuid(value, "comando", true)!;
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${await sha(JSON.stringify(body))}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-conciliacao-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const OFF = "A conciliação faz parte do Financeiro, que está desligado nesta área. Ligue Financeiro em Gestão → Módulos.";

/** Chama o RPC no objeto erp: da área, como a pessoa (com o portão de horário e segundo fator). */
async function callReconciliationRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, rpc: string, args: Record<string, unknown>, read: boolean) {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read, gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", OFF);
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || (response.status === 409 && /parte desligada/.test(code))) throw new ApiError(409, "module_disabled", OFF);
    const known = RECONCILIATION_REASONS[code] ?? prefixed(code);
    if (known) throw new ApiError(known[0], known[1], known[2]);
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta ação na conciliação. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

/** GET/POST /api/v1/profiles/:profile/erp-conciliacao/… */
export async function erpConciliacaoRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpReconciliationOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "A conciliação do ERP atende uma pessoa da área (ou o bot, com a operação liberada por ela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  let body: Record<string, unknown> | undefined;
  if (operation.method !== "GET") {
    const text = await request.text().catch(() => "");
    if (text.length > BODY_LIMIT) throw new ApiError(413, "file_invalid", "O arquivo passa de 2 MB. Exporte um período menor e importe de novo.");
    try { body = JSON.parse(text || "null"); } catch { bad("Corpo do pedido inválido."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key)))
      bad(`Informe só: ${operation.body.join(", ") || "nada no corpo"}.`);
    for (const key of operation.required) if (body![key] === undefined || body![key] === null || body![key] === "") bad(`${key}: obrigatório.`);
  }
  // Pelo bot: a operação concedida a ele e, nas sensíveis, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação da conciliação não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(ERP_CONCILIACAO_PART, erpRequirement(ERP_CONCILIACAO_PART), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  const args = await reconciliationRpcArgs(operation, params, url.searchParams, body, (sent) => commandId(sent.comando, request.headers.get("Idempotency-Key"), profile, operation.name, sent))
    .catch((error: unknown) => { throw error instanceof ReconciliationArgsError ? new ApiError(400, "invalid_request", error.message) : error; });
  return json(await callReconciliationRpc(env, profile, actor, url.pathname, request.method, operation.rpc, args, operation.method === "GET" || operation.read === true));
}

export type { ErpReconciliationOperation };
