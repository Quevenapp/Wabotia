// Rotas da Expedição do ERP, em /api/v1/profiles/:profile/erp-expedicao
// (operações em ./contract.ts): pedidos na expedição, listas de separação,
// embalagens, volumes, expedição, etiquetas, romaneio, entrega local e
// devolução física.
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, nas sensíveis, a proposta que a pessoa confirmou), módulo ERP
// ligado e a parte Expedição ligada com Vendas e Estoque (desligada: 409
// module_disabled e qual ligar). O motor confere de novo papel, permissão,
// horário de acesso e segundo fator. A entrega local chama o módulo Entrega
// pelo comando que ele expõe (entrega.create), sem mudar o módulo.
import { ApiError, uid, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleEnabled, moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ERP_EXPEDICAO_PART, ERP_EXPEDICAO_ROUTE, erpShippingOperationFor, type ErpShippingOperation } from "./contract.ts";
import { ShippingArgsError, shippingRpcArgs, uuid } from "./args.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Motivos conhecidos do motor, em palavras de quem usa. */
const REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_shipping_access_denied: [403, "forbidden", "Seu papel no ERP não consulta a expedição. Peça ao administrador um papel no ERP em Gestão › Pessoas e acessos."],
  erp_document_access_denied: [403, "forbidden", "Seu usuário do ERP não vê pedidos de venda. O administrador libera em Sistema › Usuários › Permissões (Pedidos de venda)."],
  erp_shipping_role_denied: [403, "forbidden", "Seu papel no ERP só consulta a expedição. Separar, embalar, expedir e devolver pedem o papel Administrador, Vendas ou Estoque."],
  erp_stock_access_denied: [403, "forbidden", "Seu papel no ERP não lança estoque, e a devolução dá entrada no estoque. Peça a uma pessoa com o papel Estoque ou Administrador."],
  erp_shipping_invalid: [400, "invalid_request", "Confira os dados e tente de novo."],
  erp_shipping_command_missing: [400, "invalid_request", "Falta o identificador do pedido de gravação. Atualize a tela e tente de novo."],
  erp_shipping_command_conflict: [409, "conflict", "Este pedido de gravação já foi usado com outros dados. Atualize a tela e tente de novo."],
  erp_shipping_version_conflict: [409, "conflict", "Alguém mudou esta lista ou este pedido enquanto você trabalhava. Atualize a tela e confira antes de repetir."],
  erp_shipping_order_not_found: [404, "not_found", "Pedido de venda não encontrado (foi excluído ou o cliente não está na sua carteira). Atualize a tela."],
  erp_shipping_list_not_found: [404, "not_found", "Lista de separação não encontrada. Atualize a tela."],
  erp_shipping_list_closed: [409, "list_closed", "Esta lista de separação já foi concluída ou cancelada. Atualize a tela."],
  erp_shipping_row_not_found: [404, "not_found", "Este item não está na lista de separação. Atualize a tela."],
  erp_shipping_package_not_found: [404, "not_found", "A embalagem escolhida não existe mais. Atualize a tela e escolha outra."],
  erp_shipping_pending_not_found: [404, "not_found", "Pendência não encontrada. Atualize a tela."],
  erp_shipping_pending_resolved: [409, "conflict", "Esta pendência já foi resolvida."],
  erp_shipping_nothing_to_pick: [400, "nothing_to_pick", "Os pedidos escolhidos não têm produtos para separar (só serviços ou itens sem quantidade)."],
  erp_shipping_limit: [413, "too_large", "Itens demais para uma lista. Escolha menos pedidos ou um período menor."],
  erp_shipping_quantity_invalid: [400, "invalid_request", "Informe a quantidade separada (zero ou mais)."],
  erp_shipping_pick_over: [400, "pick_over", "A quantidade separada passa do que os pedidos pedem. Confira a quantidade."],
  erp_shipping_package_name: [400, "invalid_request", "Informe o nome da embalagem."],
  erp_shipping_package_measures: [400, "invalid_request", "Confira as medidas (em cm, de 0,1 a 10.000) e o peso vazio (em kg)."],
  erp_shipping_volumes_invalid: [400, "invalid_request", "Monte pelo menos um volume, com os itens dele."],
  erp_shipping_volume_measures: [400, "invalid_request", "Confira as medidas do volume (em cm) e o peso bruto (em kg)."],
  erp_shipping_volume_items: [400, "invalid_request", "Cada item do volume precisa ser um item do pedido, com quantidade maior que zero."],
  erp_shipping_volume_exceeds: [400, "volume_exceeds", "Os volumes têm mais unidades de um item do que o pedido. Confira as quantidades."],
  erp_shipping_tracking_single: [400, "invalid_request", "O código de rastreio vale para um pedido só. Expeda os pedidos um a um para informar o rastreio."],
  erp_shipping_period_invalid: [400, "invalid_request", "Confira o período do romaneio (até 92 dias, início antes do fim)."],
  erp_shipping_delivery_not_shipped: [409, "not_shipped", "A entrega local é criada depois que o pedido é expedido. Marque o pedido como expedido antes."],
  erp_shipping_delivery_not_own: [409, "not_own_delivery", "Este pedido vai por transportadora (ou está sem frete). A entrega local é só para entrega própria: frete por conta própria e sem transportadora."],
  erp_shipping_delivery_exists: [409, "delivery_exists", "Este pedido já tem uma entrega local. Acompanhe em Entregas."],
  erp_shipping_return_order_status: [409, "conflict", "Pedido em rascunho ou cancelado não tem devolução."],
  erp_shipping_return_reason: [400, "invalid_request", "Diga por que a mercadoria voltou (de 3 a 500 caracteres)."],
  erp_shipping_return_items: [400, "invalid_request", "Escolha os itens do pedido que voltaram, com quantidade e estado (volta ao estoque, avariado ou descarte)."],
  erp_shipping_return_exceeds: [400, "return_exceeds", "A devolução passa do que o pedido teve (contando as devoluções anteriores). Confira as quantidades."],
  erp_shipping_return_product_missing: [400, "invalid_request", "Item sem produto do cadastro não volta ao estoque. Marque como avariado ou descarte."],
  erp_shipping_return_warehouse_missing: [400, "warehouse_missing", "Escolha o depósito em que a mercadoria volta ao estoque (o pedido não tem depósito)."],
  erp_stock_version_conflict: [409, "conflict", "O saldo do estoque mudou enquanto você registrava. Tente de novo."],
  erp_stock_product_unavailable: [400, "invalid_request", "Um dos produtos que volta ao estoque está inativo ou não é produto físico. Marque como avariado ou descarte, ou ative o produto."],
  erp_stock_warehouse_unavailable: [400, "invalid_request", "O depósito escolhido está inativo. Escolha outro depósito."],
  erp_stock_composition_unsupported: [400, "invalid_request", "Kit (composição) não volta ao estoque pela devolução. Devolva os componentes ou marque como avariado."],
  // Frete (src/erp/domains/shipping/freight.ts): o que impede o frete de entrar no pedido.
  erp_shipping_freight_no_freight: [409, "freight_no_freight", "O pedido está \"sem frete\". Para cobrar o frete, mude a modalidade do frete no pedido e escolha o serviço de novo."],
  erp_shipping_freight_locked: [409, "freight_order_locked", "O pedido já está aprovado, atendido ou cancelado, e o frete dele não muda mais. O serviço e o valor ficaram registrados no frete da expedição."],
  erp_shipping_freight_installments: [409, "freight_installments", "O pedido tem parcelas que somam o total sem este frete. Ajuste ou tire as parcelas no pedido e escolha o serviço de novo."],
  erp_shipping_freight_value: [400, "invalid_request", "O valor ou o prazo do frete veio num formato que o pedido não aceita. Cote de novo."],
  erp_shipping_freight_tracking: [400, "invalid_request", "O código de rastreio do provedor veio num formato que o pedido não aceita. Confira o envio no provedor."],
  erp_document_version_conflict: [409, "conflict", "Alguém mudou o pedido enquanto você trabalhava. Atualize a tela e escolha o serviço de novo."],
  erp_document_state_locked: [409, "freight_order_locked", "O pedido não pode mais ser alterado (aprovado, atendido ou cancelado). O serviço e o valor ficaram registrados no frete da expedição."],
  erp_document_installment_total_mismatch: [409, "freight_installments", "As parcelas do pedido não fecham com o total com este frete. Ajuste as parcelas no pedido e escolha o serviço de novo."],
};
/** Motivo com complemento (os números dos pedidos em conflito, a situação atual). */
const PREFIXED: Readonly<Record<string, (detail: string) => [number, string, string]>> = {
  erp_shipping_orders_unavailable: (n) => [409, "orders_unavailable", `Os pedidos ${n.replace(/,/g, ", ")} já estão numa lista de separação ou passaram dessa etapa (ou estão em rascunho ou cancelados). Tire-os da seleção.`],
  erp_shipping_not_packed: (n) => [409, "not_packed", `Os pedidos ${n.replace(/,/g, ", ")} ainda não foram embalados. Monte os volumes antes de expedir.`],
  erp_shipping_status_conflict: (s) => [409, "status_conflict", `Os volumes são montados no pedido separado (este está ${({ to_pick: "a separar", picking: "em separação", shipped: "expedido" } as Record<string, string>)[s] ?? s}). Conclua a separação antes.`],
};

/** O comando da gravação: o do corpo, o da Idempotency-Key ou o do próprio pedido (a repetição devolve o mesmo resultado). */
async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) return uuid(value, "comando", true)!;
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-expedicao-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Chama o RPC no objeto erp: da área, como a pessoa (com o portão de horário e segundo fator). O frete (src/erp/frete/) usa o mesmo caminho. */
export async function callShippingRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, rpc: string, args: Record<string, unknown>, read: boolean) {
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
  const off = "A Expedição depende de uma parte do ERP desligada (Expedição, Vendas ou Estoque). Ligue em Gestão → Módulos.";
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", off);
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || response.status === 409 && /parte desligada/.test(code)) throw new ApiError(409, "module_disabled", off);
    const known = REASONS[code];
    if (known) throw new ApiError(known[0], known[1], known[2]);
    const [prefix, ...rest] = code.split(":");
    if (PREFIXED[prefix]) { const [status, c, message] = PREFIXED[prefix](rest.join(":")); throw new ApiError(status, c, message); }
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta ação na expedição. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

/**
 * Entrega local: o preparo no motor (pedido expedido, entrega própria), a
 * entrega no módulo Entrega pelo comando dele (a chave fixa por pedido não
 * duplica a entrega) e o registro da entrega no pedido.
 */
async function localDelivery(env: Env, profile: string, actor: Actor, pathname: string, args: Record<string, unknown>, body: Record<string, unknown>) {
  if (!await moduleEnabled(env, profile, "entrega"))
    throw new ApiError(409, "module_disabled", "A entrega local é feita pelo módulo Entrega, que está desligado nesta área. Ligue Entrega em Gestão → Módulos.");
  const prepared = await callShippingRpc(env, profile, actor, pathname, "POST", "erp_shipping_delivery_prepare", args, false);
  if (prepared.delivery_id) return { entrega_id: prepared.delivery_id, repetida: true };
  const courier = body.entregador === undefined || body.entregador === null || body.entregador === "" ? undefined
    : typeof body.entregador === "string" && body.entregador.length <= 100 ? body.entregador : bad("entregador: escolha uma pessoa entregadora.");
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch("https://coordinator/command", {
    method: "POST",
    body: JSON.stringify({ profile, operation: "entrega.create", actor, data: { ...prepared.entrega, ...(courier ? { courier_id: courier } : {}) },
      key: `erp-expedicao:${prepared.document_id}`, requestId: uid() }),
  });
  const created = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = created?.error ?? created ?? {};
    throw new ApiError(response.status, typeof error.code === "string" ? error.code : "entrega_failed",
      typeof error.message === "string" ? error.message : "A entrega não foi criada no módulo Entrega. Confira em Entregas antes de tentar de novo.");
  }
  const id = typeof created?.id === "string" ? created.id : typeof created?.delivery?.id === "string" ? created.delivery.id : null;
  if (!id) throw new ApiError(502, "entrega_failed", "O módulo Entrega não devolveu a entrega criada. Confira em Entregas antes de tentar de novo.");
  await callShippingRpc(env, profile, actor, pathname, "POST", "erp_shipping_delivery_record", { p_args: { document_id: prepared.document_id, delivery_id: id } }, false);
  return { entrega_id: id, repetida: false, entrega: created };
}

/** GET/POST /api/v1/profiles/:profile/erp-expedicao/… */
export async function erpExpedicaoRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  // Frete e transportadoras (cotação, etiqueta oficial e rastreio): o serviço de frete, na mesma parte.
  if (path === `${ERP_EXPEDICAO_ROUTE}/frete` || path.startsWith(`${ERP_EXPEDICAO_ROUTE}/frete/`)) {
    const { erpFreteRoute } = await import("../frete/routes.ts");
    return erpFreteRoute(env, request, profile, actor, path);
  }
  const match = erpShippingOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "A expedição do ERP atende uma pessoa da área (ou o bot, com a operação liberada por ela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ") || "nada no corpo"}.`);
  if (body !== undefined) for (const key of operation.required) if (body[key] === undefined || body[key] === null || body[key] === "") bad(`${key}: obrigatório.`);
  // Pelo bot: a operação concedida a ele e, nas sensíveis, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação da expedição não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(ERP_EXPEDICAO_PART, erpRequirement(ERP_EXPEDICAO_PART), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  const args = await shippingRpcArgs(operation, params, url.searchParams, body, (sent) => commandId(sent.comando, request.headers.get("Idempotency-Key"), profile, operation.name, sent))
    .catch((error: unknown) => { throw error instanceof ShippingArgsError ? new ApiError(400, "invalid_request", error.message) : error; });
  if (operation.name === "erp.expedicao.entrega_local") return json(await localDelivery(env, profile, actor, url.pathname, args, body ?? {}));
  const result = await callShippingRpc(env, profile, actor, url.pathname, request.method, operation.rpc, args, operation.method === "GET");
  // Pedido expedido com envio contratado: o rastreio dele entra na rodada do alarme (src/erp/frete/schedule.ts).
  if (operation.name === "erp.expedicao.expedir" && Array.isArray(result?.items)) {
    const shipped = result.items.filter((o: { status?: string }) => o?.status === "shipped").map((o: { id: string }) => o.id);
    if (shipped.length) await (await import("../frete/service.ts")).markShipped(env, profile, shipped).catch(() => {});
  }
  return json(result);
}

export type { ErpShippingOperation };
