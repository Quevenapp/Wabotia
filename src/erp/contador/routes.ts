// Rotas para o contador, em /api/v1/profiles/:profile/erp-contador (operações
// em ./contract.ts): pacote do período, relatórios fiscais, cadastro do
// contador e envio.
//
// Conferências, nesta ordem: pessoa da área (ou o bot com a operação
// concedida e, no envio, a proposta que a pessoa confirmou); módulo ERP e
// parte Fiscal ligados (desligada: 409 module_disabled e qual ligar); papel
// fiscal, administrador ou consulta para ver, fiscal ou administrador para
// montar, cadastrar e enviar; o portão do ERP (horário de acesso e segundo
// fator). O objeto da área confere de novo o papel e a parte.
import { ApiError, uid, type Actor, type Env } from "../../types";
import { audit } from "../../events";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { IDENTITY_HEADER, encodeIdentity, type IdentityPort } from "../engine/identity.ts";
import type { FiscalEnvironment, FiscalReport } from "../emissor/provider.ts";
import {
  CONTADOR_READ_ROLES, CONTADOR_WRITE_ROLES, contadorOperationFor, contadorPackageId, contadorPeriod,
  type ContadorChannel, type ContadorPackageView,
} from "./contract.ts";
import { buildReport, reportCsv, SIMPLES_ANNEXES, ANNEX_LABELS, type ReceivedSummary } from "./report.ts";
import { contadorDo, fiscalOffMessage, listSends, readSettings, saveSettings, sendToAccountant, zipResponse } from "./service.ts";

const noStore = { "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Portão do ERP (erp_access_gate_v2), como em src/erp/fiscal-cofre/routes.ts. */
async function accessGate(env: Env, actor: Actor, profile: string, identity: IdentityPort) {
  const { erpFetch } = await import("../hub.ts");
  const r = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: actor.id, p_session_id: actor.sessionId ?? null }),
  });
  if (!r.ok) {
    const refused = (await r.json().catch(() => null)) as { code?: string } | null;
    if (refused?.code === "module_disabled") throw new ApiError(409, "module_disabled", "Para o contador, ligue o módulo Fiscal em Gestão → Módulos.");
    if (refused?.code === "erp_parts_stale") throw new ApiError(409, "erp_parts_stale", "O estado dos módulos mudou agora. Tente de novo.");
    if (refused?.code === "42501") throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo. Fale com o administrador.");
    throw new ApiError(503, "erp_unavailable", "O ERP não respondeu ao conferir o acesso. Tente de novo.");
  }
  const gate = (await r.json()) as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (gate.open !== true) throw new ApiError(403, "ERP_ACCESS_OUTSIDE_SCHEDULE", "Fora do horário de acesso ao ERP. Fale com o administrador.");
  if (gate.mfa_required && gate.mfa_ok !== true) throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para ver os dados fiscais.");
}

const environmentOf = (value: unknown): FiscalEnvironment => {
  if (value === undefined || value === null || value === "" || value === "producao") return "producao";
  if (value === "homologacao") return "homologacao";
  return bad("Ambiente: producao ou homologacao.");
};

/** O relatório do emissor (cofre); sem emissor ou fora do ar, null e o motivo. */
async function vaultReport(env: Env, profile: string, environment: FiscalEnvironment, from: string, to: string, fetchImpl?: typeof fetch) {
  try {
    const { fiscalProviderFor } = await import("../emissor/index.ts");
    const ctx = { env, profile, fetch: fetchImpl };
    const provider = await fiscalProviderFor(ctx);
    return { report: await provider.report(ctx, { environment, from, to }) as FiscalReport, problem: null };
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    if (e?.code === "fiscal_provider_not_configured")
      return { report: null, problem: "A área não tem o emissor de notas configurado (Fiscal › Certificado e emissor): só aparecem as notas recebidas lançadas no ERP." };
    if (e?.code === "vault_outdated") return { report: null, problem: "O emissor de notas precisa de atualização para os relatórios. Atualize o cofre." };
    if (typeof e?.status === "number" && e.status < 500 && e.message) return { report: null, problem: `O emissor recusou o relatório: ${e.message}` };
    return { report: null, problem: "O emissor de notas não respondeu agora: as notas emitidas ficaram de fora. Tente de novo em instantes." };
  }
}

/** GET/POST/PUT /api/v1/profiles/:profile/erp-contador/… */
export async function erpContadorRoute(env: Env, request: Request, profile: string, actor: Actor, options: { fetch?: typeof fetch } = {}): Promise<Response> {
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = contadorOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "O que é do contador atende uma pessoa da área (ou o bot, com a operação liberada por ela).");
  const { operation, params } = match;
  await requireModule(env, profile, "erp");
  const off = await fiscalOffMessage(env, profile);
  if (off) throw new ApiError(409, "module_disabled", off);
  const role = erpRoleOf(actor);
  if (!role) throw new ApiError(403, "erp_role_required", "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.");
  if (!CONTADOR_READ_ROLES.includes(role))
    throw new ApiError(403, "erp_fiscal_role_required", "O que é do contador é do papel fiscal, do administrador ou da consulta. Peça ao administrador em Pessoas e acessos.");
  if (operation.access === "write" && !CONTADOR_WRITE_ROLES.includes(role))
    throw new ApiError(403, "erp_fiscal_role_required", "Montar o pacote, cadastrar o contador e enviar são do papel fiscal ou do administrador.");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  // Pelo bot: a operação concedida a ele e, no envio, a proposta que a pessoa confirmou.
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação do contador não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const identity = await erpIdentity(env, actor, profile, request.method, url.pathname);
  await accessGate(env, actor, profile, identity);
  const q = url.searchParams;

  switch (operation.name) {
    case "nfe.contador.pacotes": {
      const { pacotes } = await contadorDo<{ pacotes: ContadorPackageView[] }>(env, profile, "listar", {}, identity);
      return json({ pacotes, envios: await listSends(env, profile, 20) });
    }
    case "nfe.contador.pacote.ver": {
      if (!/^[0-9a-f]{16}$/.test(params.id)) bad("Pacote inválido.");
      return json(await contadorDo(env, profile, "ver", { id: params.id }, identity));
    }
    case "nfe.contador.pacote": {
      const period = contadorPeriod(body!.de, body!.ate);
      if (typeof period === "string") bad(period);
      const { from, to } = period as { from: string; to: string };
      if (body!.refazer !== undefined && typeof body!.refazer !== "boolean") bad("Refazer: verdadeiro ou falso.");
      const environment = environmentOf(body!.ambiente);
      const id = await contadorPackageId(environment, from, to);
      const result = await contadorDo<{ pacote: ContadorPackageView; reaproveitado: boolean }>(env, profile, "pedir",
        { id, environment, from, to, redo: body!.refazer === true }, identity);
      if (!result.reaproveitado) await audit(env, actor, profile, "erp_contador.package", `${id} ${environment} ${from}..${to}`, uid());
      return json(result, result.reaproveitado ? 200 : 201);
    }
    case "nfe.contador.pacote.baixar": {
      if (!/^[0-9a-f]{16}$/.test(params.id)) bad("Pacote inválido.");
      const files = await contadorDo<{ keys: string[]; bytes: number; filename: string }>(env, profile, "arquivos", { id: params.id }, identity);
      await audit(env, actor, profile, "erp_contador.download", params.id, uid());
      return zipResponse(env, files);
    }
    case "nfe.contador.relatorio": {
      const period = contadorPeriod(q.get("de"), q.get("ate"));
      if (typeof period === "string") bad(period);
      const { from, to } = period as { from: string; to: string };
      const environment = environmentOf(q.get("ambiente"));
      const [vault, resumo, settings] = await Promise.all([
        vaultReport(env, profile, environment, from, to, options.fetch),
        contadorDo<{ recebidas: ReceivedSummary; crt: string | null }>(env, profile, "resumo", { environment, from, to }, identity),
        readSettings(env, profile),
      ]);
      const report = buildReport({ environment, from, to, vault: vault.report, vaultProblem: vault.problem, received: resumo.recebidas, crt: resumo.crt, annexes: settings.annexes });
      if (q.get("formato") === "csv")
        return new Response(reportCsv(report), { headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="relatorios-fiscais_${from}_a_${to}.csv"`, "X-Content-Type-Options": "nosniff" } });
      return json(report);
    }
    case "nfe.contador.cadastro": {
      const [settings, natures] = await Promise.all([
        readSettings(env, profile),
        contadorDo<{ crt: string | null; naturezas: string[] }>(env, profile, "naturezas", {}, identity),
      ]);
      const { whatsappLines, lineView } = await import("../conversa/service.ts");
      const { emailReady } = await import("../../email");
      return json({
        contador: { nome: settings.name, email: settings.email, whatsapp: settings.phone, canal: settings.channel, linha: settings.connection_id,
          automatico: settings.auto_enabled, dia: settings.auto_day, ultimo_mes_automatico: settings.auto_last_month, anexos: settings.annexes,
          atualizado_em: settings.updated },
        naturezas: natures.naturezas, crt: natures.crt, anexos_validos: SIMPLES_ANNEXES.map((a) => ({ id: a, nome: ANNEX_LABELS[a] })),
        linhas: (await whatsappLines(env, profile)).map(lineView), email_disponivel: await emailReady(env),
        pode_editar: CONTADOR_WRITE_ROLES.includes(role),
      });
    }
    case "nfe.contador.cadastro.salvar": {
      const saved = await saveSettings(env, profile, actor, body!);
      return json({ contador: { nome: saved.name, email: saved.email, whatsapp: saved.phone, canal: saved.channel, linha: saved.connection_id,
        automatico: saved.auto_enabled, dia: saved.auto_day, ultimo_mes_automatico: saved.auto_last_month, anexos: saved.annexes, atualizado_em: saved.updated } });
    }
    case "nfe.contador.envios.ver": return json({ envios: await listSends(env, profile, 100) });
    case "nfe.contador.enviar": {
      if (typeof body!.pacote !== "string" || !/^[0-9a-f]{16}$/.test(body!.pacote)) bad("Informe o pacote (id da lista de pacotes).");
      if (body!.canal !== undefined && body!.canal !== "whatsapp" && body!.canal !== "email") bad("Canal: whatsapp ou email.");
      const envio = await sendToAccountant(env, profile, { actor, packageId: body!.pacote as string, channel: body!.canal as ContadorChannel | undefined, identity });
      return json({ envio }, 201);
    }
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
