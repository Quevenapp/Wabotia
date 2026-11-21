// Rotas da Produção (ordem de produção), em /api/v1/profiles/:profile/erp-producao
// (operações e argumentos em ./contract.ts).
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, em criar, concluir e estornar, a proposta que a pessoa
// confirmou), a parte Produção ligada (e Estoque e Produtos, de que ela
// depende; Compras para virar pedido de compra) — desligada: 409
// module_disabled dizendo qual ligar. O motor confere de novo papel,
// permissão, horário de acesso e segundo fator (o portão roda no objeto).
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleStates } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ProductionArgsError, erpProductionOperationFor, productionRpcArgs, uuidArg, type ErpProductionOperation } from "./contract.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Motivos conhecidos do motor, em palavras de quem usa. */
export const PRODUCTION_REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_stock_access_denied: [403, "forbidden", "Seu papel no ERP não mexe no estoque. A produção precisa do papel Estoque ou Administrador (e da permissão Controle de estoque). Peça ao administrador em Pessoas e acessos."],
  erp_production_purchase_denied: [403, "forbidden", "Seu papel no ERP não cria pedido de compra. Peça a quem cuida das compras ou ao administrador."],
  erp_production_not_found: [404, "not_found", "A ordem de produção não foi encontrada. Atualize a lista."],
  erp_production_completion_not_found: [404, "not_found", "O apontamento não foi encontrado. Atualize a ordem."],
  erp_production_product_not_found: [404, "not_found", "O produto não foi encontrado. Atualize a tela e escolha de novo."],
  erp_production_warehouse_not_found: [404, "not_found", "O depósito não foi encontrado. Atualize a tela e escolha de novo."],
  erp_production_version_conflict: [409, "conflict", "A ordem mudou depois que você abriu (outra pessoa ou outra aba). Atualize a ordem e confira de novo."],
  erp_production_command_conflict: [409, "conflict", "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo."],
  erp_production_invalid: [400, "invalid_request", "Confira os dados da ordem e tente de novo."],
  erp_production_invalid_query: [400, "invalid_request", "Confira os filtros (o período começa antes de terminar)."],
  erp_production_invalid_date: [400, "invalid_request", "Confira a data (dia, mês e ano válidos)."],
  erp_production_invalid_quantity: [400, "invalid_request", "Informe uma quantidade maior que zero, com até 6 casas decimais."],
  erp_production_invalid_cost: [400, "invalid_request", "Informe o custo adicional em reais, como 35,50."],
  erp_production_invalid_inputs: [400, "invalid_request", "Confira os insumos: cada um com a quantidade por unidade maior que zero (até 100 insumos)."],
  erp_production_invalid_loss: [400, "invalid_request", "A perda prevista vai de 0 a 1000%."],
  erp_production_duplicate_input: [400, "invalid_request", "O mesmo insumo aparece duas vezes. Junte as quantidades numa linha só."],
  erp_production_input_is_product: [400, "invalid_request", "O produto acabado não pode ser insumo dele mesmo."],
  erp_production_input_unavailable: [400, "invalid_request", "Um dos insumos está inativo, excluído, sem unidade ou não é produto simples. Troque o insumo ou corrija o cadastro em Produtos."],
  erp_production_warehouse_required: [400, "invalid_request", "Escolha o depósito dos insumos e o do acabado (ou defina um depósito padrão em Estoque › Depósitos)."],
  erp_production_warehouse_inactive: [400, "invalid_request", "O depósito escolhido está inativo. Escolha outro ou reative em Estoque › Depósitos."],
  erp_production_warehouse_locked: [409, "conflict", "A ordem já tem apontamento ativo: os depósitos não mudam. Estorne os apontamentos antes, se precisar."],
  erp_production_product_locked: [409, "conflict", "A ordem já tem apontamento: o produto acabado não muda. Crie outra ordem."],
  erp_production_quantity_below_produced: [400, "invalid_request", "A quantidade da ordem não pode ficar menor do que já foi produzido."],
  erp_production_not_editable: [409, "conflict", "Ordem concluída ou cancelada não é editada."],
  erp_production_status_invalid: [409, "conflict", "Essa mudança não vale para a situação atual da ordem. Atualize a ordem."],
  erp_production_reason_required: [400, "invalid_request", "Escreva o motivo (pelo menos 3 letras)."],
  erp_production_has_completions: [409, "conflict", "A ordem tem apontamento ativo. Estorne os apontamentos antes de cancelar, ou encerre a ordem."],
  erp_production_nothing_produced: [409, "conflict", "Nada foi produzido nesta ordem ainda. Para desistir dela, cancele."],
  erp_production_not_completable: [409, "conflict", "Ordem concluída ou cancelada não recebe apontamento."],
  erp_production_insufficient_stock: [409, "insufficient_stock", "Falta saldo de insumo no depósito dos insumos e o Estoque não permite saldo negativo. Confira a prévia, lance a entrada dos insumos ou ligue o saldo negativo nas Preferências do estoque."],
  erp_production_lot_required: [400, "lot_required", "Este produto controla lote: informe o lote do que foi produzido (e a validade, se tiver)."],
  erp_production_lot_not_controlled: [400, "invalid_request", "Este produto não controla lote. Tire o lote ou ligue o controle de lote no cadastro do produto."],
  erp_production_lot_inactive: [409, "conflict", "Esse lote está inativo. Use outro código ou reative o lote em Estoque › Lotes."],
  erp_production_already_reversed: [409, "conflict", "Este apontamento já foi estornado."],
  erp_production_stock_reversed: [409, "conflict", "Um dos lançamentos deste apontamento já foi estornado direto no Estoque. Confira os lançamentos de estoque."],
  erp_production_finished_moved: [409, "finished_moved", "O produto acabado já saiu do depósito depois deste apontamento (venda, transferência ou outro uso). O estorno não é feito: faça um ajuste no Estoque, se precisar."],
  erp_production_supplier_required: [400, "supplier_required", "Escolha o fornecedor dos insumos sem fornecedor padrão."],
  erp_production_product_deleted: [400, "invalid_request", "O produto está na lixeira. Restaure em Produtos para fabricar."],
  erp_production_product_not_product: [400, "invalid_request", "Serviço não é fabricado. Escolha um produto."],
  erp_production_product_inactive: [400, "invalid_request", "O produto está inativo. Reative em Produtos para fabricar."],
  erp_production_product_no_unit: [400, "invalid_request", "O produto não tem unidade. Informe a unidade no cadastro do produto."],
  erp_production_product_variations: [400, "invalid_request", "Produto com variações não é fabricado direto. Escolha a variação."],
  erp_production_product_not_simple: [400, "invalid_request", "Este tipo de produto não é fabricado. Escolha um produto simples ou com composição."],
  erp_production_product_no_composition: [400, "invalid_request", "O produto é do formato composição mas a composição está vazia. Monte a composição em Produtos."],
  erp_production_product_virtual: [400, "invalid_request", "A composição deste produto é Virtual (sem estoque próprio). Para fabricar, mude o tipo de estoque para Físico na composição do produto."],
  erp_production_product_kit_components: [400, "invalid_request", "A composição deste produto lança estoque pelos componentes na venda; fabricar daria baixa dos insumos duas vezes. Na composição do produto, escolha \"Lançar estoque: Produto\"."],
  erp_stock_insufficient_or_excess_quantity: [409, "insufficient_stock", "Falta saldo no estoque para este lançamento e o Estoque não permite saldo negativo. Confira os saldos."],
  erp_stock_reserved_quantity_unavailable: [409, "reserved", "Parte do saldo de um insumo está reservada para pedidos de venda. Libere a reserva ou lance a entrada do insumo."],
  erp_stock_lot_insufficient: [409, "lot_insufficient", "O lote não tem mais saldo suficiente para o estorno (parte já saiu)."],
  erp_stock_lot_code_taken: [409, "conflict", "Esse código de lote já existe para este produto."],
  erp_stock_lot_invalid: [400, "invalid_request", "Confira o lote: código de até 60 caracteres e fabricação antes da validade."],
  erp_stock_lot_expiry_required: [400, "invalid_request", "As Preferências de lotes pedem a validade: informe a validade do lote."],
  erp_stock_lot_manufacture_required: [400, "invalid_request", "As Preferências de lotes pedem a data de fabricação: informe a fabricação do lote."],
  erp_stock_price_decimals_exceeded: [400, "invalid_request", "O custo tem mais casas decimais do que as Preferências da empresa permitem para preço de entrada."],
  erp_stock_version_conflict: [409, "conflict", "O saldo de um produto mudou enquanto a operação rodava. Atualize a ordem e tente de novo."],
  erp_stock_already_reversed: [409, "conflict", "Um dos lançamentos já foi estornado no Estoque."],
};

/** O comando: o do corpo, o da Idempotency-Key ou o do próprio pedido (a repetição devolve o mesmo resultado). */
async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) return uuidArg(value, "comando", true)!;
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-producao-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Recusa do motor em palavras de quem usa: status HTTP, código e mensagem. */
export function productionFailure(status: number, body: any): ApiError {
  const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
  if (body?.code === "module_disabled" || status === 409 && /parte desligada/.test(code))
    return new ApiError(409, "module_disabled", "Esta rotina depende de uma parte do ERP desligada (Produção, Estoque, Produtos ou Compras). Ligue em Gestão → Módulos.");
  const known = PRODUCTION_REASONS[code];
  if (known) return new ApiError(known[0], known[1], known[2]);
  if (status === 403 || body?.code === "42501") return new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta operação. Peça ao administrador em Pessoas e acessos.");
  if (status >= 500) return new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  return new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
}

async function callProductionRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, operation: ErpProductionOperation, args: Record<string, unknown>) {
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
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte do ERP desligada (Produção, Estoque, Produtos ou Compras). Ligue em Gestão → Módulos.");
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) throw productionFailure(response.status, body);
  return body;
}

/** GET/POST /api/v1/profiles/:profile/erp-producao/… */
export async function erpProducaoRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpProductionOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "A produção do ERP atende uma pessoa da área (ou o bot, com a operação liberada por ela).");
  const { operation, params } = match;
  // Parte desligada antes de qualquer outra conferência: diz qual módulo ligar (e de quem ele depende).
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(operation.parts[0], erpRequirement(...operation.parts), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  if (body !== undefined) for (const key of operation.required) if (key !== "id" && (body[key] === undefined || body[key] === null || body[key] === "")) bad(`${key}: obrigatório.`);
  // Pelo bot: a operação concedida a ele e, nas sensíveis, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação da produção não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const args = await productionRpcArgs(operation, params, url.searchParams, body, (sent) => commandId(sent.comando, request.headers.get("Idempotency-Key"), profile, operation.name, sent)).catch((error: unknown) => {
    throw error instanceof ProductionArgsError ? new ApiError(400, "invalid_request", error.message) : error;
  });
  return json(await callProductionRpc(env, profile, actor, url.pathname, request.method, operation, args));
}
