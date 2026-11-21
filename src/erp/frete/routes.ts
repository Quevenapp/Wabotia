// Rotas do frete, em /api/v1/profiles/:profile/erp-expedicao/frete (operações
// em ./contract.ts). A rota da Expedição (src/erp/expedicao/routes.ts) entrega
// estes caminhos aqui depois de conferir a área.
//
// Conferências: pessoa da área (ou o bot com a operação concedida e, nas
// sensíveis, a proposta que a pessoa confirmou), módulo ERP ligado e a parte
// Expedição ligada com Vendas e Estoque (desligada: 409 module_disabled e o
// que ligar). A configuração dos provedores é do administrador do ERP. O
// motor confere de novo papel, carteira de clientes e parte.
import { ApiError, type Actor, type Env } from "../../types";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpRoleOf } from "../../modules/erp/identity";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ERP_EXPEDICAO_PART } from "../expedicao/contract.ts";
import { erpFreightOperationFor } from "./contract.ts";
import { providersView, saveProvider, saveSettings } from "./config.ts";
import {
  cancelShipment, checkProvider, chooseService, contractShipment, defaultFreightDeps, orderFreight, quoteOrder, refreshTracking, shipmentLabel,
  type FreightCall, type FreightDeps,
} from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** GET/POST /api/v1/profiles/:profile/erp-expedicao/frete/… (path: depois de /profiles/:profile/). */
export async function erpFreteRoute(env: Env, request: Request, profile: string, actor: Actor, path: string, deps: FreightDeps = defaultFreightDeps(env)): Promise<Response> {
  const url = new URL(request.url);
  const match = erpFreightOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "O frete da expedição atende uma pessoa da área (ou o bot, com a operação liberada por ela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  if (url.searchParams.size) bad("Esta rota não aceita parâmetros na consulta.");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ") || "nada no corpo"}.`);
  if (body !== undefined) for (const key of operation.required) if (body[key] === undefined || body[key] === null || body[key] === "") bad(`${key}: obrigatório.`);
  // Pelo bot: a operação concedida a ele e, nas sensíveis, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação do frete não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const off = erpPartOffMessage(ERP_EXPEDICAO_PART, erpRequirement(ERP_EXPEDICAO_PART), await moduleStates(env, profile));
  if (off) throw new ApiError(409, "module_disabled", off);
  if (operation.admin && erpRoleOf(actor) !== "admin")
    throw new ApiError(403, "forbidden", "Só o administrador do ERP configura os provedores de frete. Peça a ele em Gestão › Pessoas e acessos.");
  const id = params.id === undefined ? "" : UUID.test(params.id) ? params.id.toLowerCase() : bad("pedido: identificador inválido.");
  const call: FreightCall = { env, profile, actor, pathname: url.pathname, method: request.method };
  const b = body ?? {};
  switch (operation.name) {
    case "erp.expedicao.frete.pedido": return json(await orderFreight(call, id));
    case "erp.expedicao.frete.cotar": return json(await quoteOrder(call, id, deps));
    case "erp.expedicao.frete.escolher": return json(await chooseService(call, id, b));
    case "erp.expedicao.frete.contratar": return json(await contractShipment(call, id, b, deps));
    case "erp.expedicao.frete.cancelar": return json(await cancelShipment(call, id, deps));
    case "erp.expedicao.frete.rastrear": return json(await refreshTracking(call, id, deps));
    case "erp.expedicao.frete.etiqueta": {
      const label = await shipmentLabel(call, id, deps);
      return new Response(label.pdf as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="etiqueta-pedido-${label.number}.pdf"` } });
    }
    case "erp.expedicao.frete.provedores": return json(await providersView(env, profile));
    case "erp.expedicao.frete.provedor.salvar": return json(await saveProvider(env, profile, actor.id, params.provedor, b));
    case "erp.expedicao.frete.provedor.testar": return json({ ...(await checkProvider(env, profile, params.provedor, deps)), ...(await providersView(env, profile)) });
    case "erp.expedicao.frete.ajustes": return json({ settings: await saveSettings(env, profile, actor.id, b) });
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
