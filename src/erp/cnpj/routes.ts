// Consulta de CNPJ para o cadastro de contato do ERP (pedido do dono, 21/11/2026: "quando colocar o
// cnpj, buscar os dados na receita e preencher os campos").
//
// GET /api/v1/profiles/:profile/erp-cnpj/:cnpj
//
// A Receita não tem API pública gratuita; as bases abertas que republicam o cadastro da Receita são
// consultadas pelo servidor (o navegador não fala com terceiros): BrasilAPI primeiro e, se ela não
// responder, a API pública do CNPJá (publica.cnpj.ws), que também traz a inscrição estadual.
// Só o CNPJ digitado sai daqui; nada é gravado: a tela preenche o formulário e a pessoa salva.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { requireModule } from "../../modules/registry";
import { lookupCnpj, validCnpjDigits } from "./lookup.ts";
export type { CnpjData } from "./lookup.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function erpCnpjRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "A consulta de CNPJ é feita por uma pessoa da área, no cadastro.");
  if (request.method.toUpperCase() !== "GET" && request.method.toUpperCase() !== "HEAD") throw new ApiError(405, "method_not_allowed", "Use GET.");
  await requireModule(env, profile, "erp");
  const url = new URL(request.url);
  const raw = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const cnpj = raw.replace(/[.\-/\s]/g, "").toUpperCase();
  if (/[A-Z]/.test(cnpj)) throw new ApiError(400, "cnpj_alphanumeric", "CNPJ com letras ainda não aparece nas bases públicas da Receita. Preencha os dados à mão.");
  if (!validCnpjDigits(cnpj)) throw new ApiError(400, "invalid_cnpj", "Confira o CNPJ: os dígitos verificadores não batem.");
  const result = await lookupCnpj(cnpj);
  if ("data" in result) return json(result.data);
  if ("notFound" in result) throw new ApiError(404, "cnpj_not_found", "CNPJ não encontrado na base da Receita. Confira o número ou preencha à mão.");
  if (result.failed === "busy") throw new ApiError(429, "cnpj_busy", "A consulta da Receita está com muitas buscas agora. Tente de novo em um minuto ou preencha à mão.");
  throw new ApiError(503, "cnpj_unavailable", "A consulta da Receita não respondeu agora. Tente de novo em instantes ou preencha à mão.");
}
