// Rotas do boleto pela API do banco, em /api/v1/profiles/:profile/erp-boleto
// (operações em ./contract.ts), e o aviso do banco em /webhooks/boleto/:código.
//
// Conferências: pessoa da área, módulo erp-cobranca ligado (o middleware de
// módulo já recusa com 409 module_disabled; a parte e o Financeiro são
// conferidos de novo no serviço), a conta a receber visível para a pessoa no
// ERP (lida como ela), o papel de remessas para registrar, alterar e baixar,
// e o administrador para os interruptores e a configuração da conta
// financeira. Pelo bot: só a operação concedida e, na escrita, a proposta
// que a pessoa confirmou.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, rate, sha } from "../../security";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { ERP_BOLETO_PART, erpBoletoOperationFor } from "./contract.ts";
import {
  accountConfig, bankSwitches, boletoContext, boletoPdfFor, boletoWebhook, cancelBoleto, changeBoletoDue, confirmBoletoSettlement,
  consultBoleto, registerBoleto, requireBilling, saveAccountConfig, saveBankSwitch,
} from "./service.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw new ApiError(400, "invalid_request", `Identificador ${what} inválido.`);
  return value.toLowerCase();
}

/** GET/POST /api/v1/profiles/:profile/erp-boleto/… */
export async function erpBoletoRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const match = erpBoletoOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "O boleto pelo banco é pedido por uma pessoa da área (ou pelo bot, com a confirmação dela).");
  await requireModule(env, profile, ERP_BOLETO_PART);
  await requireBilling(env, profile);
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => {
    throw new ApiError(400, "invalid_request", "Corpo do pedido inválido.");
  });
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !operation.body.includes(key))))
    throw new ApiError(400, "invalid_request", operation.body.length ? `Informe só: ${operation.body.join(", ")}.` : "Este pedido não leva campos.");
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação do boleto pelo banco não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const origin = url.origin;

  switch (operation.name) {
    case "erp.boleto.bancos": return json(await bankSwitches(env, actor, profile));
    case "erp.boleto.bancos.salvar": return json(await saveBankSwitch(env, actor, profile, String(params.banco), body!));
    case "erp.boleto.conta_financeira": return json(await accountConfig(env, actor, profile, uuidParam(params.conta, "da conta financeira"), origin));
    case "erp.boleto.conta_financeira.salvar": return json(await saveAccountConfig(env, actor, profile, uuidParam(params.conta, "da conta financeira"), body!, origin));
    case "erp.boleto.ver": return json(await boletoContext(env, actor, profile, uuidParam(params.id, "da conta")));
    case "erp.boleto.registrar": return json(await registerBoleto(env, actor, profile, uuidParam(params.id, "da conta"), body!));
    case "erp.boleto.consultar_banco": return json(await consultBoleto(env, actor, profile, uuidParam(params.id, "da conta")));
    case "erp.boleto.vencimento": return json(await changeBoletoDue(env, actor, profile, uuidParam(params.id, "da conta"), body!));
    case "erp.boleto.baixar": return json(await cancelBoleto(env, actor, profile, uuidParam(params.id, "da conta"), body!));
    case "erp.boleto.confirmar_baixa": return json(await confirmBoletoSettlement(env, actor, profile, uuidParam(params.id, "da conta")));
    case "erp.boleto.pdf": {
      const pdf = await boletoPdfFor(env, actor, profile, uuidParam(params.id, "da conta"));
      return new Response(pdf.bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${pdf.name.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
        "Cache-Control": "private, no-store" } });
    }
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}

/** POST /webhooks/boleto/:código: limite por IP antes de qualquer leitura; só o código conhecido chega ao serviço. */
export async function erpBoletoWebhookRoute(env: Env, request: Request, token: string, ip: string): Promise<Response> {
  await rate(env, `boleto-webhook:${await sha(ip || "local")}`, 240);
  const raw = await request.text();
  if (raw.length > 256_000) throw new ApiError(413, "payload_too_large", "Aviso grande demais.");
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return json(await boletoWebhook(env, token, body));
}
