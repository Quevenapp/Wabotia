// Rotas da maquininha integrada ao caixa, em /api/v1/profiles/:profile/erp-maquininha
// (operações em ./contract.ts), e o aviso do provedor em /webhooks/maquininha/:código.
//
// Conferências: pessoa da área, módulo erp-pdv ligado (o middleware de módulo
// já recusa com 409 module_disabled; a parte e as dependências são
// conferidas de novo no serviço), a venda lida como a pessoa no ERP (papel e
// permissões de pagamento e fechamento do PDV) e o administrador para a
// configuração. Pelo bot: só as consultas concedidas; enviar a cobrança,
// cancelar, reenviar e configurar não existem para ele (exigem pessoa no caixa).
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, rate, sha } from "../../security";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { ERP_TERMINAL_PART, erpTerminalOperationFor } from "./contract.ts";
import {
  cancelTerminalPayment, chargeTerminal, listTerminals, requirePdv, resendTerminalPayment, saveCashier, saveTerminalSettings, terminalPayment, terminalPayments,
  terminalSaleFinished, terminalSettings, terminalWebhook,
} from "./service.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw new ApiError(400, "invalid_request", `Identificador ${what} inválido.`);
  return value.toLowerCase();
}

/** GET/POST /api/v1/profiles/:profile/erp-maquininha/… */
export async function erpTerminalRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const match = erpTerminalOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "A maquininha do caixa atende uma pessoa da área (o bot só consulta os pagamentos, com a operação liberada).");
  await requireModule(env, profile, ERP_TERMINAL_PART);
  await requirePdv(env, profile);
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => {
    throw new ApiError(400, "invalid_request", "Corpo do pedido inválido.");
  });
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !operation.body.includes(key))))
    throw new ApiError(400, "invalid_request", operation.body.length ? `Informe só: ${operation.body.join(", ")}.` : "Este pedido não leva campos.");
  // Pelo bot: só as consultas concedidas a ele. Cobrar na maquininha exige pessoa no caixa.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", operation.bot === false
      ? "Cobrar, cancelar ou configurar a maquininha exige uma pessoa no caixa: não é feito pelo bot."
      : "Esta consulta da maquininha não foi liberada para este bot.");
  const origin = url.origin;

  switch (operation.name) {
    case "erp.maquininha.configuracao": return json(await terminalSettings(env, actor, profile, origin));
    case "erp.maquininha.configuracao.salvar": return json(await saveTerminalSettings(env, actor, profile, body!, origin));
    case "erp.maquininha.terminais": return json(await listTerminals(env, actor, profile));
    case "erp.maquininha.caixa.salvar": return json(await saveCashier(env, actor, profile, uuidParam(params.caixa, "do caixa"), body!, origin));
    case "erp.maquininha.cobrar": return json(await chargeTerminal(env, actor, profile, body!));
    case "erp.maquininha.pagamentos": return json(await terminalPayments(env, actor, profile, url.searchParams));
    case "erp.maquininha.pagamento": return json(await terminalPayment(env, actor, profile, uuidParam(params.id, "do pagamento")));
    case "erp.maquininha.cancelar": return json(await cancelTerminalPayment(env, actor, profile, uuidParam(params.id, "do pagamento")));
    case "erp.maquininha.reenviar": return json(await resendTerminalPayment(env, actor, profile, uuidParam(params.id, "do pagamento"), body!));
    case "erp.maquininha.venda_concluida": return json(await terminalSaleFinished(env, actor, profile, uuidParam(params.id, "do pagamento")));
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}

/** POST /webhooks/maquininha/:código: limite por IP antes de qualquer leitura; só o código conhecido chega ao serviço. */
export async function erpTerminalWebhookRoute(env: Env, request: Request, token: string, ip: string): Promise<Response> {
  await rate(env, `maquininha-webhook:${await sha(ip || "local")}`, 240);
  const raw = await request.text();
  if (raw.length > 64_000) throw new ApiError(413, "payload_too_large", "Aviso grande demais.");
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return json(await terminalWebhook(env, token, { headers: request.headers, query: new URL(request.url).searchParams, body }));
}
