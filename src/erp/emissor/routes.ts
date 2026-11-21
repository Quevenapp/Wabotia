// Rotas do emissor fiscal para o painel (contrato em README.md desta pasta,
// "Rotas para o painel"). Montagem, fora desta pasta (src/index.ts):
//
//   app.all("/api/v1/profiles/:profile/erp-emissor", h);
//   app.all("/api/v1/profiles/:profile/erp-emissor/*", h);
//   // h = (c) => erpEmissorRoute(c.env, c.req.raw, c.req.param("profile"), c.get("actor"))
//
// Fica fora de /erp/* porque /erp/* é a erp-api do Fagoo inteira.
// Devolve Response: o FiscalError leva campo, mensagens e emissão no corpo,
// que o tratador global de erros (só code e message) descartaria.
import { access, admin } from "../../security";
import { requireModule } from "../../modules/registry";
import { ApiError, type Actor, type Env } from "../../types";
import { emissorView, removeEmissor, saveEmissor, testEmissor } from "./config.ts";
import { fiscalProviderFor } from "./index.ts";
import { FiscalError, type FiscalEnvironment } from "./provider.ts";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { IDENTITY_HEADER, encodeIdentity } from "../engine/identity.ts";
import { erpFetch } from "../hub.ts";

export const EMISSOR_MODULE = "erp-fiscal";

/** Leitura: pessoa com papel erp:* (o administrador do Vinki vale erp:admin). */
function reader(actor: Actor, profile: string) {
  if (actor.kind !== "user") throw new ApiError(403, "erp_user_required", "O ERP atende só pessoas nesta fase.");
  access(actor, profile, "erp");
  if (!erpRoleOf(actor))
    throw new ApiError(403, "erp_role_required", "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.");
}

/**
 * Configuração (salvar, remover, testar): administrador e o portão do ERP na
 * mesma ida ao objeto (erp_access_gate_v2): fora do horário de acesso, ou
 * com a política de segundo fator ligada e a sessão sem aal2, recusa com os
 * códigos da erp-api (ERP_ACCESS_OUTSIDE_SCHEDULE, ERP_MFA_REQUIRED).
 */
async function configurator(env: Env, actor: Actor, profile: string) {
  admin(actor);
  const identity = await erpIdentity(env, actor, profile, "POST");
  if (!identity.parts?.customers || !identity.parts.fiscal)
    throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte desligada.");
  const r = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: actor.id, p_session_id: actor.sessionId ?? null }),
  });
  if (!r.ok) {
    // 42501: a pessoa não é membro ativo do ERP da área (o envelope não a trouxe).
    const refused = (await r.json().catch(() => null)) as { code?: string } | null;
    if (refused?.code === "module_disabled") throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte desligada.");
    if (refused?.code === "erp_parts_stale") throw new ApiError(409, "erp_parts_stale", "O estado das partes mudou. Tente novamente.");
    if (refused?.code === "erp_parts_unavailable") throw new ApiError(503, "erp_parts_unavailable", "Estado das partes indisponível.");
    if (refused?.code === "42501") throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo.");
    throw new ApiError(503, "erp_unavailable", "O ERP não respondeu ao conferir o acesso. Tente de novo.");
  }
  const gate = (await r.json()) as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (gate.open !== true) throw new ApiError(403, "ERP_ACCESS_OUTSIDE_SCHEDULE", "Fora do horário de acesso ao ERP.");
  if (gate.mfa_required && gate.mfa_ok !== true)
    throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para alterar o emissor fiscal.");
}

const REF = "([A-Za-z0-9_-]{1,80})";
/**
 * Leituras de documento que esta rota entregava (PDF, cupom, logotipo e XML
 * dos eventos) a qualquer papel erp:*, sem privacidade de cadastro nem o
 * portão de horário e segundo fator. O painel não as chama mais: a nota sai
 * por /erp-comercial-nfe/emissoes/:id/(danfe|xml), com a regra da fatia
 * fiscal. Fechadas com resposta clara, antes de qualquer ida ao cofre.
 */
const DOC_ROUTES: RegExp[] = [
  new RegExp(`^/logotipo$`),
  new RegExp(`^/nfe/${REF}/danfe$`),
  new RegExp(`^/nfce/${REF}/danfce$`),
  new RegExp(`^/nfce/${REF}/cupom$`),
  new RegExp(`^/(nfe|nfce|nfse)/${REF}/cancelamento/xml$`),
  new RegExp(`^/nfe/${REF}/carta-correcao/(\\d{1,2})/xml$`),
  new RegExp(`^/inutilizacoes/${REF}/xml$`),
];
export const EMISSOR_DOCUMENT_ROUTE_CLOSED = "fiscal_document_route_closed";

export async function erpEmissorRoute(
  env: Env,
  request: Request,
  profile: string,
  actor: Actor,
  options: { fetch?: typeof fetch } = {},
): Promise<Response> {
  reader(actor, profile);
  await requireModule(env, profile, "erp");
  await requireModule(env, profile, EMISSOR_MODULE);
  const url = new URL(request.url);
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-emissor`;
  const sub = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).replace(/\/+$/, "") : "";
  const method = request.method.toUpperCase();
  try {
    if (sub === "") {
      if (method === "GET") return Response.json(await emissorView(env, profile));
      if (method === "PUT") {
        await configurator(env, actor, profile);
        const body = await request.json().catch(() => {
          throw new ApiError(400, "invalid_json", "Corpo JSON inválido.");
        });
        return Response.json(await saveEmissor(env, actor, profile, body));
      }
      if (method === "DELETE") {
        await configurator(env, actor, profile);
        return Response.json(await removeEmissor(env, actor, profile));
      }
    }
    if (sub === "/test" && method === "POST") {
      await configurator(env, actor, profile);
      return Response.json(await testEmissor(env, actor, profile, options));
    }
    const ctx = { env, profile, fetch: options.fetch };
    if (sub === "/series" && method === "GET") {
      const provider = await fiscalProviderFor(ctx);
      return Response.json({ series: await provider.series(ctx) });
    }
    if (sub === "/sefaz" && method === "GET") {
      const uf = (url.searchParams.get("uf") || "").toUpperCase();
      const kind = url.searchParams.get("modelo") || "nfe";
      const environment = url.searchParams.get("ambiente") || "homologacao";
      if (!/^[A-Z]{2}$/.test(uf) || !["nfe", "nfce"].includes(kind) || !["homologacao", "producao"].includes(environment))
        throw new FiscalError(400, "fiscal_invalid_request", "Informe uf (duas letras), modelo (nfe|nfce) e ambiente.");
      const provider = await fiscalProviderFor(ctx);
      return Response.json(
        await provider.sefazStatus(ctx, {
          uf,
          kind: kind as "nfe" | "nfce",
          environment: environment as FiscalEnvironment,
        }),
      );
    }
    // Documentos fiscais não saem mais por aqui (ver DOC_ROUTES).
    if (method === "GET" && DOC_ROUTES.some(re => re.test(sub)))
      throw new ApiError(
        410,
        EMISSOR_DOCUMENT_ROUTE_CLOSED,
        "Os documentos fiscais saem pela própria nota, em Vendas › Notas fiscais (DANFE e XML), com o papel fiscal ou de administrador.",
      );
    throw new ApiError(404, "not_found", "Rota do emissor desconhecida.");
  } catch (error) {
    if (error instanceof FiscalError) return Response.json(error.toJSON(), { status: error.status });
    throw error;
  }
}
