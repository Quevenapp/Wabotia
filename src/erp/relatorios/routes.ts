// Rotas dos relatórios do ERP, em /api/v1/profiles/:profile/erp-relatorios
// (operações em ./contract.ts): DRE gerencial, gráficos de vendas,
// financeiro e estoque, lotes vencendo e pagamento da equipe.
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, no lançamento, a proposta que a pessoa confirmou), módulo ERP
// ligado, as partes do ERP da operação ligadas (desligada: 409
// module_disabled e qual ligar). O motor confere de novo papel, permissão,
// horário de acesso e segundo fator (o portão roda no objeto, na mesma ida).
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { erpReportOperationFor, type ErpReportOperation } from "./contract.ts";
import { ReportArgsError, reportRpcArgs, uuid } from "./args.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Motivos conhecidos do motor, em palavras de quem usa. */
const REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_finance_access_denied: [403, "forbidden", "Seu papel no ERP não consulta o Financeiro. Peça ao administrador o papel Financeiro ou Administrador em Pessoas e acessos."],
  erp_finance_permission_denied: [403, "forbidden", "Seu usuário do ERP não tem a permissão deste relatório. O administrador libera em Sistema › Usuários › Permissões."],
  erp_stock_access_denied: [403, "forbidden", "Seu papel no ERP não consulta o Estoque. Peça ao administrador em Pessoas e acessos."],
  erp_report_access_denied: [403, "forbidden", "Seu papel no ERP não consulta os relatórios de vendas, ou falta a permissão Relatórios de vendas (Sistema › Usuários › Permissões)."],
  erp_finance_invalid_query: [400, "invalid_request", "Confira o período (até três anos) e os filtros."],
  erp_stock_invalid_query: [400, "invalid_request", "Confira o período (o giro vai até um ano, sem passar de hoje) e os filtros."],
  erp_preferences_invalid_query: [400, "invalid_request", "Confira o período (até três anos) e o agrupamento."],
  erp_finance_dre_limit: [413, "too_large", "O período tem lançamentos demais para uma leitura. Escolha um período menor."],
  erp_finance_chart_limit: [413, "too_large", "O período tem contas demais para uma leitura. Escolha um período menor."],
  erp_stock_chart_limit: [413, "too_large", "O estoque tem lançamentos demais para uma leitura. Escolha um período menor ou um depósito."],
  erp_report_chart_limit: [413, "too_large", "O período tem pedidos demais para uma leitura. Escolha um período menor."],
  erp_finance_team_commission_limit: [413, "too_large", "O período tem pedidos demais para calcular a comissão. Escolha um período menor."],
  erp_finance_not_found: [404, "not_found", "Não encontrado: a pessoa, a categoria ou a conta foi excluída. Atualize a tela."],
  erp_stock_warehouse_not_found: [404, "not_found", "O depósito não foi encontrado. Atualize a tela."],
  erp_finance_dre_cost_top_payable: [400, "invalid_request", "Só uma categoria de despesa do primeiro nível pode ir para Custos."],
  erp_finance_team_contact_missing: [409, "contact_missing", "Esta pessoa ainda não tem um contato com o mesmo CPF. Cadastre o contato em Cadastros › Contatos (com o CPF do funcionário) e tente de novo."],
  erp_finance_team_commission_rate_missing: [409, "rate_missing", "O vendedor não tem percentual de comissão. Informe o percentual em Cadastros › Vendedores e calcule de novo."],
  erp_finance_team_commission_changed: [409, "commission_changed", "As vendas do período ou o percentual mudaram depois da conferência. Calcule a comissão de novo e confira antes de lançar."],
  erp_finance_team_commission_exists: [409, "commission_exists", "Já existe comissão lançada para este vendedor em parte deste período. Confira em Pagamentos da equipe."],
  erp_finance_team_category_inactive: [409, "category_inactive", "A categoria Pessoal e equipe (ou a subcategoria do tipo) está inativa. Ative em Financeiro › Categorias ou escolha outra categoria."],
  erp_finance_team_invalid_period: [400, "invalid_request", "Confira o período de referência (até 400 dias, início antes do fim)."],
  erp_finance_invalid_due_date: [400, "invalid_request", "O vencimento não pode ser antes da emissão."],
  erp_finance_invalid_category: [400, "invalid_request", "A categoria escolhida não é de despesa ativa."],
  erp_finance_invalid_account: [400, "invalid_request", "A conta financeira escolhida está inativa."],
  erp_finance_invalid_cents: [400, "invalid_request", "Informe um valor maior que zero."],
  erp_finance_command_conflict: [409, "conflict", "Este pedido já foi usado com outros dados. Recarregue a tela e tente de novo."],
  erp_finance_version_conflict: [409, "conflict", "A categoria mudou enquanto você editava. Atualize a tela."],
};

/** O comando do lançamento: o do corpo, o da Idempotency-Key ou o do próprio pedido (a repetição devolve o mesmo resultado). */
async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) return uuid(value, "comando", true)!;
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-relatorios-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Chama o RPC no objeto erp: da área, como a pessoa (com o portão de horário e segundo fator). */
async function callReportRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, operation: ErpReportOperation, args: Record<string, unknown>) {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read: method === "GET", gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${operation.rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte do ERP desligada. Ligue em Gestão → Módulos.");
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || response.status === 409 && /parte desligada/.test(code)) throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte do ERP desligada. Ligue em Gestão → Módulos.");
    const known = REASONS[code];
    if (known) throw new ApiError(known[0], known[1], known[2]);
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta consulta. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

/** GET/POST /api/v1/profiles/:profile/erp-relatorios/… */
export async function erpRelatoriosRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpReportOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "Os relatórios do ERP atendem uma pessoa da área (ou o bot, com a operação liberada por ela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  if (body !== undefined) for (const key of operation.required) if (body[key] === undefined || body[key] === null || body[key] === "") bad(`${key}: obrigatório.`);
  // Pelo bot: a operação concedida a ele e, no lançamento, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação dos relatórios do ERP não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(operation.parts[0], erpRequirement(...operation.parts), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  const args = await reportRpcArgs(operation, params, url.searchParams, body, (sent) => commandId(sent.comando, request.headers.get("Idempotency-Key"), profile, operation.name, sent)).catch((error: unknown) => {
    throw error instanceof ReportArgsError ? new ApiError(400, "invalid_request", error.message) : error;
  });
  return json(await callReportRpc(env, profile, actor, url.pathname, request.method, operation, args));
}
