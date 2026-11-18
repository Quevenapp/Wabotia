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
import { FiscalError, type FiscalEnvironment, type FiscalFile, type FiscalKind } from "./provider.ts";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { IDENTITY_HEADER, encodeIdentity } from "../engine/identity.ts";
import { erpFetch } from "../hub.ts";

export const EMISSOR_MODULE = "erp-fiscal";

/** Leitura: pessoa com papel erp:* (o administrador do Wabotia vale erp:admin). */
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
  const r = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: actor.id, p_session_id: actor.sessionId ?? null }),
  });
  if (!r.ok) {
    // 42501: a pessoa não é membro ativo do ERP da área (o envelope não a trouxe).
    const refused = (await r.json().catch(() => null)) as { code?: string } | null;
    if (refused?.code === "42501") throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo.");
    throw new ApiError(503, "erp_unavailable", "O ERP não respondeu ao conferir o acesso. Tente de novo.");
  }
  const gate = (await r.json()) as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (gate.open !== true) throw new ApiError(403, "ERP_ACCESS_OUTSIDE_SCHEDULE", "Fora do horário de acesso ao ERP.");
  if (gate.mfa_required && gate.mfa_ok !== true)
    throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para alterar o emissor fiscal.");
}

const REF = "([A-Za-z0-9_-]{1,80})";
const DOC_ROUTES: [RegExp, string][] = [
  [new RegExp(`^/logotipo$`), "logo"],
  [new RegExp(`^/nfe/${REF}/danfe$`), "danfe"],
  [new RegExp(`^/nfce/${REF}/danfce$`), "danfce"],
  [new RegExp(`^/nfce/${REF}/cupom$`), "receipt"],
  [new RegExp(`^/(nfe|nfce|nfse)/${REF}/cancelamento/xml$`), "cancellation"],
  [new RegExp(`^/nfe/${REF}/carta-correcao/(\\d{1,2})/xml$`), "correction"],
  [new RegExp(`^/inutilizacoes/${REF}/xml$`), "void"],
];

/** Arquivo como o emissor mandou: tipo e tamanho dele, sem cache compartilhado. */
const fileResponse = (f: FiscalFile, name: string) =>
  new Response(f.body, {
    headers: {
      "Content-Type": f.content_type,
      "Content-Length": String(f.size),
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const xmlResponse = (xml: string, name: string) =>
  new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

async function documentRead(ctx: { env: Env; profile: string; fetch?: typeof fetch }, sub: string, query: URLSearchParams) {
  const hit = DOC_ROUTES.map(([re, name]) => [re.exec(sub), name] as const).find(([m]) => m);
  if (!hit) return null;
  const [m, name] = hit as [RegExpExecArray, string];
  const provider = await fiscalProviderFor(ctx);
  switch (name) {
    case "logo": {
      const logo = await provider.logo(ctx);
      if (!logo) throw new FiscalError(404, "fiscal_logo_missing", "O cofre não tem logotipo.");
      return fileResponse(logo, logo.content_type.includes("png") ? "logotipo.png" : "logotipo.jpg");
    }
    case "danfe":
      return fileResponse(await provider.danfe(ctx, m[1]), `danfe-${m[1]}.pdf`);
    case "danfce": {
      const width = query.get("largura") ?? "80";
      const via = query.get("via") ?? "consumidor";
      if (!["80", "58"].includes(width) || !["consumidor", "estabelecimento"].includes(via))
        throw new FiscalError(400, "fiscal_invalid_request", "Informe largura 80 ou 58 e via consumidor ou estabelecimento.", {
          field: !["80", "58"].includes(width) ? "largura" : "via",
        });
      return fileResponse(
        await provider.danfce(ctx, m[1], {
          width: width as "80" | "58",
          copy: via === "consumidor" ? "consumer" : "establishment",
        }),
        `danfce-${m[1]}.pdf`,
      );
    }
    case "receipt": {
      const via = query.get("via") ?? "consumidor";
      if (!["consumidor", "estabelecimento"].includes(via))
        throw new FiscalError(400, "fiscal_invalid_request", "Informe via consumidor ou estabelecimento.", { field: "via" });
      return Response.json(await provider.receipt(ctx, m[1], { copy: via === "consumidor" ? "consumer" : "establishment" }), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    case "cancellation":
      return xmlResponse(await provider.cancellationXml(ctx, m[1] as FiscalKind, m[2]), `cancelamento-${m[2]}.xml`);
    case "correction": {
      const sequence = Number(m[2]);
      return xmlResponse(await provider.correctionXml(ctx, m[1], sequence), `carta-correcao-${m[1]}-${sequence}.xml`);
    }
    case "void":
      return xmlResponse(await provider.voidRangeXml(ctx, m[1]), `inutilizacao-${m[1]}.xml`);
  }
  return null;
}

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
    // Leituras de documento (qualquer papel erp:*): PDF, cupom, logotipo e
    // XML dos eventos, repassados na hora (o cofre gera; nada fica guardado).
    if (method === "GET") {
      const read = await documentRead(ctx, sub, url.searchParams);
      if (read) return read;
    }
    throw new ApiError(404, "not_found", "Rota do emissor desconhecida.");
  } catch (error) {
    if (error instanceof FiscalError) return Response.json(error.toJSON(), { status: error.status });
    throw error;
  }
}
