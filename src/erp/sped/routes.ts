// Rotas das obrigações em arquivo, em /api/v1/profiles/:profile/erp-sped
// (operações em ./contract.ts): conferência, geração, lista, download,
// configuração e envio ao contador.
//
// Conferências, nesta ordem: pessoa da área (ou o bot com a operação
// concedida e, no envio, a proposta que a pessoa confirmou); módulo ERP e
// parte Fiscal ligados (desligada: 409 module_disabled e qual ligar); papel
// fiscal, administrador ou consulta para ver, fiscal ou administrador para
// gerar, configurar e enviar; o portão do ERP (horário de acesso e segundo
// fator). O objeto da área confere de novo o papel e a parte.
import { ApiError, uid, type Actor, type Env } from "../../types";
import { audit } from "../../events";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { IDENTITY_HEADER, encodeIdentity, type IdentityPort } from "../engine/identity.ts";
import type { ContadorChannel } from "../contador/contract.ts";
import {
  inventoryDay, isKind, SPED_OFF_MESSAGE, SPED_READ_ROLES, SPED_WRITE_ROLES, spedFileId, spedOperationFor, spedPeriod, type SpedFileView,
} from "./contract.ts";
import { listPending, sendSpedFile, spedDo, textResponse } from "./service.ts";

const noStore = { "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Portão do ERP (erp_access_gate_v2), como em src/erp/contador/routes.ts. */
async function accessGate(env: Env, actor: Actor, profile: string, identity: IdentityPort) {
  const { erpFetch } = await import("../hub.ts");
  const r = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: actor.id, p_session_id: actor.sessionId ?? null }),
  });
  if (!r.ok) {
    const refused = (await r.json().catch(() => null)) as { code?: string } | null;
    if (refused?.code === "module_disabled") throw new ApiError(409, "module_disabled", SPED_OFF_MESSAGE);
    if (refused?.code === "erp_parts_stale") throw new ApiError(409, "erp_parts_stale", "O estado dos módulos mudou agora. Tente de novo.");
    if (refused?.code === "42501") throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo. Fale com o administrador.");
    throw new ApiError(503, "erp_unavailable", "O ERP não respondeu ao conferir o acesso. Tente de novo.");
  }
  const gate = (await r.json()) as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (gate.open !== true) throw new ApiError(403, "ERP_ACCESS_OUTSIDE_SCHEDULE", "Fora do horário de acesso ao ERP. Fale com o administrador.");
  if (gate.mfa_required && gate.mfa_ok !== true) throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para ver os dados fiscais.");
}

const environmentOf = (value: unknown): "producao" | "homologacao" => {
  if (value === undefined || value === null || value === "" || value === "producao") return "producao";
  if (value === "homologacao") return "homologacao";
  return bad("Ambiente: producao ou homologacao.");
};
/** Reais (número ou texto "1.234,56") → centavos. */
function reaisToCents(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) bad("Saldo credor anterior: valor em reais, zero ou mais.");
  return Math.round(n * 100);
}

/** GET/POST/PUT /api/v1/profiles/:profile/erp-sped/… */
export async function erpSpedRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = spedOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "SPED e SINTEGRA atendem uma pessoa da área (ou o bot, com a operação liberada por ela).");
  const { operation, params } = match;
  await requireModule(env, profile, "erp");
  const { fiscalOffMessage } = await import("../contador/service.ts");
  const off = await fiscalOffMessage(env, profile);
  if (off) throw new ApiError(409, "module_disabled", off);
  const role = erpRoleOf(actor);
  if (!role) throw new ApiError(403, "erp_role_required", "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.");
  if (!SPED_READ_ROLES.includes(role))
    throw new ApiError(403, "erp_fiscal_role_required", "SPED e SINTEGRA são do papel fiscal, do administrador ou da consulta. Peça ao administrador em Pessoas e acessos.");
  if (operation.access === "write" && !SPED_WRITE_ROLES.includes(role))
    throw new ApiError(403, "erp_fiscal_role_required", "Gerar arquivos, mudar a configuração e enviar ao contador são do papel fiscal ou do administrador.");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação de SPED não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const identity = await erpIdentity(env, actor, profile, request.method, url.pathname);
  await accessGate(env, actor, profile, identity);
  const q = url.searchParams;
  const ID = /^[0-9a-f]{16}$/;

  switch (operation.name) {
    case "nfe.sped.conferir": {
      const kind = q.get("tipo");
      if (!isKind(kind)) bad("Tipo: efd_icms_ipi, efd_contribuicoes ou sintegra.");
      const period = spedPeriod(kind as never, q.get("de"), q.get("ate"));
      if (typeof period === "string") bad(period);
      const { from, to } = period as { from: string; to: string };
      const inventory = inventoryDay(q.get("inventario"), to);
      if (inventory && typeof inventory === "object") bad(inventory.error);
      return json(await spedDo(env, profile, "conferir", { kind, from, to, inventory, environment: environmentOf(q.get("ambiente")) }, identity));
    }
    case "nfe.sped.gerar": {
      if (!isKind(body!.tipo)) bad("Tipo: efd_icms_ipi, efd_contribuicoes ou sintegra.");
      const kind = body!.tipo as "efd_icms_ipi";
      const period = spedPeriod(kind, body!.de, body!.ate);
      if (typeof period === "string") bad(period);
      const { from, to } = period as { from: string; to: string };
      const inventory = inventoryDay(body!.inventario, to);
      if (inventory && typeof inventory === "object") bad(inventory.error);
      if (body!.refazer !== undefined && typeof body!.refazer !== "boolean") bad("Refazer: verdadeiro ou falso.");
      const environment = environmentOf(body!.ambiente);
      const id = await spedFileId(kind, environment, from, to);
      const result = await spedDo<{ arquivo: SpedFileView; reaproveitado: boolean }>(env, profile, "pedir", {
        id, kind, environment, from, to, inventory, previous_credit: reaisToCents(body!.saldo_credor_anterior), redo: body!.refazer === true,
      }, identity);
      if (!result.reaproveitado) await audit(env, actor, profile, "erp_sped.file", `${id} ${kind} ${environment} ${from}..${to}`, uid());
      return json(result, result.reaproveitado ? 200 : 201);
    }
    case "nfe.sped.arquivos": {
      const { arquivos } = await spedDo<{ arquivos: SpedFileView[] }>(env, profile, "listar", {}, identity);
      return json({ arquivos, envios: await listPending(env, profile, 20) });
    }
    case "nfe.sped.arquivo.ver": {
      if (!ID.test(params.id)) bad("Arquivo inválido.");
      return json(await spedDo(env, profile, "ver", { id: params.id }, identity));
    }
    case "nfe.sped.arquivo.baixar": {
      if (!ID.test(params.id)) bad("Arquivo inválido.");
      const files = await spedDo<{ keys: string[]; bytes: number; filename: string }>(env, profile, "partes", { id: params.id }, identity);
      await audit(env, actor, profile, "erp_sped.download", params.id, uid());
      return textResponse(env, files);
    }
    case "nfe.sped.configuracao": {
      const result = await spedDo<{ configuracao: Record<string, any> }>(env, profile, "configuracao", {}, identity);
      // Contador ainda sem nome, e-mail ou telefone aqui: sugere os do cadastro do contador (Para o contador).
      const { readSettings } = await import("../contador/service.ts");
      const cadastro = await readSettings(env, profile).catch(() => null);
      return json({ ...result, contador_cadastro: cadastro ? { nome: cadastro.name, email: cadastro.email, telefone: cadastro.phone } : null,
        pode_editar: SPED_WRITE_ROLES.includes(role) });
    }
    case "nfe.sped.configuracao.salvar": {
      const result = await spedDo(env, profile, "configuracao.salvar", body!, identity);
      await audit(env, actor, profile, "erp_sped.settings", "configuracao", uid());
      return json(result);
    }
    case "nfe.sped.envios.ver": return json({ envios: await listPending(env, profile, 100) });
    case "nfe.sped.enviar": {
      if (typeof body!.arquivo !== "string" || !ID.test(body!.arquivo)) bad("Informe o arquivo (id da lista de arquivos).");
      if (body!.canal !== undefined && body!.canal !== "whatsapp" && body!.canal !== "email") bad("Canal: whatsapp ou email.");
      const result = await sendSpedFile(env, profile, { actor, identity, fileId: body!.arquivo as string, channel: body!.canal as ContadorChannel | undefined });
      return json(result, result.aguardando ? 202 : 201);
    }
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
