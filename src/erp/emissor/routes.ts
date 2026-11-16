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

export const EMISSOR_MODULE = "erp-fiscal";

function reader(actor: Actor, profile: string) {
  if (actor.kind !== "user") throw new ApiError(403, "erp_user_required", "O ERP atende só pessoas nesta fase.");
  access(actor, profile, "erp");
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
        admin(actor);
        const body = await request.json().catch(() => {
          throw new ApiError(400, "invalid_json", "Corpo JSON inválido.");
        });
        return Response.json(await saveEmissor(env, actor, profile, body));
      }
      if (method === "DELETE") return Response.json(await removeEmissor(env, actor, profile));
    }
    if (sub === "/test" && method === "POST")
      return Response.json(await testEmissor(env, actor, profile, options));
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
    throw new ApiError(404, "not_found", "Rota do emissor desconhecida.");
  } catch (error) {
    if (error instanceof FiscalError) return Response.json(error.toJSON(), { status: error.status });
    throw error;
  }
}
