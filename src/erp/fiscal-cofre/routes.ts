// Relatórios e exportação pelo cofre (NFapi 0.11.0), bloco F6b do Fiscal
// (sessão G). Rotas para as telas "Relatórios fiscais" e "Exportação para o
// contador" do painel (sessão M). Contrato no README.md desta pasta.
// Montagem, fora desta pasta (src/index.ts), ao lado do /erp-emissor:
//
//   app.all("/api/v1/profiles/:profile/erp-fiscal-cofre/*", h);
//   // h = (c) => erpFiscalVaultRoute(c.env, c.req.raw, c.req.param("profile"), c.get("actor"))
//
// Regras do desenho aprovado (17/11):
// - Os números vêm do cofre, que é a fonte do que foi autorizado. Nada é
//   guardado no ERP e nada é somado aos relatórios gerenciais do ERP.
// - O arquivo da exportação não passa pelo Wabotia: o navegador recebe os
//   links assinados do cofre (válidos por cerca de 30 min) e os abre direto.
//   As urls não vão para tabela, log nem auditoria.
// - Papel fiscal ou administrador, no horário de acesso e com o segundo fator
//   quando a política pede (o portão do ERP). Bot ainda não: falta a liberação
//   por ação do plano dos bots, e o link iria para a pessoa, não para a conversa.
import { requireModule } from "../../modules/registry";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { audit } from "../../events";
import { ApiError, uid, type Actor, type Env } from "../../types";
import { IDENTITY_HEADER, encodeIdentity } from "../engine/identity.ts";
import { erpFetch } from "../hub.ts";
import { fiscalProviderFor } from "../emissor/index.ts";
import { EMISSOR_MODULE } from "../emissor/routes.ts";
import { FiscalError, type FiscalEnvironment, type FiscalExport, type FiscalExportItem } from "../emissor/provider.ts";

export const VAULT_ROUTE = "erp-fiscal-cofre";
const ROLES = new Set(["fiscal", "admin"]);

/** Papel fiscal ou administrador; pessoa, não aplicação nem bot. */
function fiscalReader(actor: Actor) {
  if (actor.kind !== "user") throw new ApiError(403, "erp_user_required", "O ERP atende só pessoas nesta fase.");
  if (actor.via)
    throw new ApiError(
      403,
      "erp_fiscal_bot_not_allowed",
      "Relatórios e exportação fiscal ainda não podem ser pedidos pelo bot. Abra a tela do Fiscal.",
    );
  const role = erpRoleOf(actor);
  if (!role) throw new ApiError(403, "erp_role_required", "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.");
  if (!ROLES.has(role))
    throw new ApiError(403, "erp_fiscal_role_required", "Relatórios e exportação fiscal são do papel fiscal ou do administrador.");
}

/**
 * Portão do ERP (erp_access_gate_v2), como na erp-api e na configuração do
 * emissor: fora do horário de acesso, ou sem o segundo fator quando a
 * política pede, recusa com os mesmos códigos.
 */
async function accessGate(env: Env, actor: Actor, profile: string) {
  const identity = await erpIdentity(env, actor, profile, "GET");
  if (!identity.parts?.customers || !identity.parts.fiscal)
    throw new ApiError(409, "module_disabled", "Esta rotina depende de uma parte desligada.");
  const r = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: actor.id, p_session_id: actor.sessionId ?? null }),
  });
  if (!r.ok) {
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
    throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para ver os dados fiscais.");
}

const EXPORT_ITEMS: readonly FiscalExportItem[] = ["nfse", "nfe", "nfce", "events", "void_ranges", "received"];
const REF = /^[A-Za-z0-9_-]{1,80}$/;
const noStore = { "Cache-Control": "private, no-store" };

/** Mesmo pedido: ambiente, período e o que incluir (a ordem do incluir não conta). */
const sameExport = (e: FiscalExport, environment: string, from: string, to: string, include: FiscalExportItem[]) =>
  e.environment === environment &&
  e.period.from === from &&
  e.period.to === to &&
  [...e.include].sort().join(",") === [...include].sort().join(",");

/** O que a auditoria guarda: id do cofre, ambiente, período e o que entrou. Nunca a url. */
const exportRecord = (e: FiscalExport) => `${e.provider_ref} ${e.environment} ${e.period.from}..${e.period.to} ${e.include.join(",")}`;

export async function erpFiscalVaultRoute(
  env: Env,
  request: Request,
  profile: string,
  actor: Actor,
  options: { fetch?: typeof fetch } = {},
): Promise<Response> {
  fiscalReader(actor);
  await requireModule(env, profile, "erp");
  await requireModule(env, profile, EMISSOR_MODULE);
  const url = new URL(request.url);
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/${VAULT_ROUTE}`;
  const sub = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).replace(/\/+$/, "") : "";
  const method = request.method.toUpperCase();
  const ctx = { env, profile, fetch: options.fetch };
  try {
    if (sub === "/relatorio" && method === "GET") {
      await accessGate(env, actor, profile);
      const q = url.searchParams;
      const provider = await fiscalProviderFor(ctx);
      const report = await provider.report(ctx, {
        environment: (q.get("ambiente") || "producao") as FiscalEnvironment,
        from: q.get("de") || "",
        to: q.get("ate") || "",
      });
      // Enquanto o cofre lê, a tela repete a cada retry_after_ms: audita só a
      // resposta completa, uma por consulta vista.
      if (report.complete)
        await audit(env, actor, profile, "erp_fiscal.vault_report", `${report.environment} ${report.period.from}..${report.period.to}`, uid());
      return Response.json(report, { headers: noStore });
    }
    if (sub === "/exportacoes" && method === "GET") {
      await accessGate(env, actor, profile);
      const provider = await fiscalProviderFor(ctx);
      return Response.json({ exports: await provider.exports(ctx) }, { headers: noStore });
    }
    if (sub === "/exportacoes" && method === "POST") {
      await accessGate(env, actor, profile);
      const body = (await request.json().catch(() => {
        throw new ApiError(400, "invalid_json", "Corpo JSON inválido.");
      })) as { ambiente?: unknown; de?: unknown; ate?: unknown; incluir?: unknown; nova?: unknown };
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new ApiError(400, "invalid_json", "Corpo JSON inválido.");
      const include = body.incluir === undefined ? [...EXPORT_ITEMS] : body.incluir;
      if (!Array.isArray(include) || include.length === 0 || include.some((i) => !EXPORT_ITEMS.includes(i)))
        throw new FiscalError(400, "fiscal_invalid_request", `Escolha o que incluir entre ${EXPORT_ITEMS.join(", ")}.`, { field: "incluir" });
      const input = {
        environment: String(body.ambiente ?? "producao") as FiscalEnvironment,
        from: String(body.de ?? ""),
        to: String(body.ate ?? ""),
        include: [...new Set(include as FiscalExportItem[])],
      };
      const provider = await fiscalProviderFor(ctx);
      // O cofre não repete o POST sozinho e cada POST cria outra exportação.
      // Contra o clique duplo, e para baixar de novo no mesmo dia, o mesmo
      // pedido ainda válido (24 h) é reaproveitado; "nova": true gera outra.
      if (body.nova !== true) {
        const existing = (await provider.exports(ctx)).find((e) => sameExport(e, input.environment, input.from, input.to, input.include));
        if (existing) {
          const fresh = await provider.exportGet(ctx, existing.provider_ref);
          await audit(env, actor, profile, "erp_fiscal.vault_export_links", exportRecord(fresh), uid());
          return Response.json({ export: fresh, reused: true }, { headers: noStore });
        }
      }
      const created = await provider.exportCreate(ctx, input);
      await audit(env, actor, profile, "erp_fiscal.vault_export_create", exportRecord(created), uid());
      return Response.json({ export: created, reused: false }, { status: 201, headers: noStore });
    }
    const one = /^\/exportacoes\/([^/]+)$/.exec(sub);
    if (one && method === "GET") {
      if (!REF.test(one[1])) throw new FiscalError(404, "fiscal_export_not_found", "Exportação não encontrada.");
      await accessGate(env, actor, profile);
      const provider = await fiscalProviderFor(ctx);
      const found = await provider.exportGet(ctx, one[1]);
      // Links novos são acesso ao arquivo: auditados quando a exportação está pronta.
      if (found.status === "ready") await audit(env, actor, profile, "erp_fiscal.vault_export_links", exportRecord(found), uid());
      return Response.json(found, { headers: noStore });
    }
    throw new ApiError(404, "not_found", "Rota de relatórios fiscais desconhecida.");
  } catch (error) {
    if (error instanceof FiscalError) return Response.json(error.toJSON(), { status: error.status });
    throw error;
  }
}
