// Rotas do envio de documentos do ERP por e-mail, em
// /api/v1/profiles/:profile/erp-email (operações em ./contract.ts).
//
// Conferências: pessoa da área, módulo ERP ligado (o middleware de módulo já
// recusa com 409 module_disabled), a parte do ERP do documento ligada, o
// documento visível para a pessoa no ERP (lido como ela, pelas rotas do
// painel) e a privacidade de cadastro. Pelo bot: só a operação concedida e, no
// envio, a proposta que a pessoa confirmou; o destinatário tem de ser do
// cadastro. O e-mail sai pelo da instalação (src/email.ts).
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { ERP_EMAIL_DOC_TYPES, erpEmailOperationFor, type ErpEmailDocType } from "./contract.ts";
import { emailSituation, prepareEmail, requireEmailPart, resendDocumentEmail, sendDocumentEmail, sendHistory } from "./service.ts";
import { loadEmailDocument } from "./documents.ts";
import type { ReceivablePayment } from "../conversa/documents.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function docType(value: string | undefined): ErpEmailDocType {
  if (!ERP_EMAIL_DOC_TYPES.includes(value as ErpEmailDocType))
    throw new ApiError(404, "not_found", "Tipo de documento desconhecido: use proposta, pedido, compra, nota, nfce ou conta.");
  return value as ErpEmailDocType;
}
function paymentChoice(value: unknown): ReceivablePayment | null {
  if (value === undefined || value === null || value === "") return null;
  if (!["pix", "link", "boleto", "sem"].includes(String(value))) throw new ApiError(400, "invalid_request", "pagamento: use pix, link, boleto ou sem.");
  return value as ReceivablePayment;
}
function idempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key") ?? "";
  if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(400, "invalid_request", "Envie Idempotency-Key (até 200 caracteres ASCII).");
  return key;
}

/** GET/POST /api/v1/profiles/:profile/erp-email[/:tipo/:id[/envios[/:envio/reenviar]|/enviar]]. */
export async function erpEmailRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const match = erpEmailOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "Documentos do ERP vão por e-mail por uma pessoa da área (ou pelo bot, com a confirmação dela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => {
    throw new ApiError(400, "invalid_request", "Corpo do pedido inválido.");
  });
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !operation.body.includes(key))))
    throw new ApiError(400, "invalid_request", operation.body.length ? `Informe só: ${operation.body.join(", ")}.` : "Este pedido não leva campos.");
  // Pelo bot: a operação concedida a ele e, no envio, a proposta que a pessoa confirmou.
  if (actor.via && !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação de envio por e-mail não foi liberada para este bot, ou falta a confirmação da pessoa.");

  switch (operation.name) {
    case "erp.email.situacao":
      return json(await emailSituation(env));
    case "erp.email.preparar":
      return json(await prepareEmail(env, profile, actor, docType(params.tipo), params.id!, paymentChoice(url.searchParams.get("pagamento"))));
    case "erp.email.envios": {
      const type = docType(params.tipo);
      const parts = await requireEmailPart(env, profile, type);
      // Quem vê o documento no ERP vê os envios dele.
      const doc = await loadEmailDocument(env, profile, actor, type, params.id!, { parts, light: true });
      return json({ envios: await sendHistory(env, profile, type, doc.id) });
    }
    case "erp.email.enviar":
      return json(await sendDocumentEmail(env, profile, actor, docType(params.tipo), params.id!, body!, idempotencyKey(request)));
    case "erp.email.reenviar":
      return json(await resendDocumentEmail(env, profile, actor, docType(params.tipo), params.id!, String(params.envio), idempotencyKey(request)));
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
