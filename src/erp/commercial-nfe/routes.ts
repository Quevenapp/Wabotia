import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, isEngineActor } from "../../security";
import { erpIdentity } from "../../modules/erp/identity";
import { erpPrivacy, erpPrivacyChanged } from "../../customer/erp-privacy";
import { containsRestrictedContact, encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { ErpError } from "../engine/errors.ts";
import { erpFetch } from "../hub.ts";
import { com1ExecutionActor, type Com1Authority } from "../domains/fiscal/comnfe/access.ts";
import { commercialNfeHttp, type CommercialNfeHttpHandler } from "./slots.ts";

export { COM1_MODULE_CONTRACT, COM1_OPERATIONS, COM1_RESPONSE_SCHEMAS } from "./metadata.ts";
export type { CommercialNfeOperation } from "./metadata.ts";
import { COM1_OPERATIONS, type CommercialNfeOperation } from "./metadata.ts";
import { NFCE_OPERATIONS, NFCE_ROLES } from "./nfce-metadata.ts";
export { NFCE_OPERATIONS } from "./nfce-metadata.ts";
import { OS_NOTE_KINDS, OS_NOTE_OPERATIONS } from "./os-notes-metadata.ts";
export { OS_NOTE_OPERATIONS } from "./os-notes-metadata.ts";
import { NFSE_CANCEL_REASONS } from "./contracts.ts";
import { NFE_EVENT_FILES, NFE_EVENT_OPERATIONS } from "./events-metadata.ts";
export { NFE_EVENT_OPERATIONS } from "./events-metadata.ts";

export interface CommercialNfeHttpContext {
  env: Env;
  request: Request;
  profile: string;
  actor: Actor;
  identity: IdentityPort;
  operation: CommercialNfeOperation;
  params: { id?: string };
  input: Record<string, unknown>;
  authority: Com1Authority;
  /** Provedor/HTTP/relógio são injetados pelo serviço, nunca pelo corpo público. */
  fetch?: typeof fetch;
}

export interface CommercialNfeRouteDependencies {
  handle?: CommercialNfeHttpHandler;
  resolveIdentity?: typeof erpIdentity;
  checkGate?: (env: Env, profile: string, identity: IdentityPort) => Promise<void>;
  privacy?: typeof erpPrivacy;
  /** Política previamente conferida por área/bot/pessoa; origem externa nunca é promovida. */
  authority?: (actor: Actor, profile: string, operation: CommercialNfeOperation) => Promise<Com1Authority>;
  fetch?: typeof fetch;
}

async function checkGate(env: Env, profile: string, identity: IdentityPort): Promise<void> {
  const response = await erpFetch(env, profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST", headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) },
    body: JSON.stringify({ p_user_id: identity.actor?.user_id, p_session_id: identity.actor?.session_id }),
  });
  if (!response.ok) throw new ApiError(response.status === 409 ? 409 : 403, "fiscal_forbidden", "Seu acesso ao ERP não foi confirmado.");
  const gate = await response.json() as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (gate.open !== true || (gate.mfa_required && gate.mfa_ok !== true)) throw new ApiError(403, "fiscal_forbidden", "Confira o horário de acesso e o segundo fator do ERP.");
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function invalid(field?: string): never { throw new ApiError(400, "fiscal_invalid_request", `Informe os dados válidos da operação${field ? `: ${field}` : ""}.`); }

function validateInput(operation: CommercialNfeOperation, input: Record<string, unknown>): void {
  for (const key of operation.required) if (!Object.hasOwn(input, key)) invalid(key);
  for (const key of ["command_id", "document_id"])
    if (input[key] !== undefined && (typeof input[key] !== "string" || !UUID.test(input[key] as string))) invalid(key);
  for (const key of ["expected_version", "expected_document_version", "expected_emission_version", "body_revision"])
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1)) invalid(key);
  if (input.body_hash !== undefined && (typeof input.body_hash !== "string" || !/^[0-9a-f]{64}$/.test(input.body_hash))) invalid("body_hash");
  if (operation.name === "com1.list" && !["homologacao", "producao"].includes(String(input.environment))) invalid("environment");
  if (input.environment !== undefined && !["homologacao", "producao"].includes(String(input.environment))) invalid("environment");
  for (const key of ["stock_timing", "finance_timing"])
    if (input[key] !== undefined && !["existing", "on_authorization"].includes(String(input[key]))) invalid(key);
  for (const key of ["series_homologacao", "series_producao"])
    if (input[key] != null && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > 889)) invalid(key);
  for (const key of ["acknowledge_tax_limits", "enable_production", "new_fiscal_version", "physical_return_confirmed"])
    if (input[key] !== undefined && typeof input[key] !== "boolean") invalid(key);
  if (operation.name === "com1.effects" && (!["stock", "finance"].includes(String(input.axis)) || !["apply", "apply_skipped", "reconcile", "reverse"].includes(String(input.intent)))) invalid("axis/intent");
  if (input.justification !== undefined && (typeof input.justification !== "string" || [...input.justification.trim()].length < 15 || [...input.justification.trim()].length > 255)) invalid("justification");
  if (input.choices !== undefined) {
    if (!input.choices || typeof input.choices !== "object" || Array.isArray(input.choices)) invalid("choices");
    const choices = input.choices as Record<string, unknown>;
    if (Object.keys(choices).some(key => !["nature_id", "presence", "final_consumer", "series"].includes(key)) ||
      typeof choices.nature_id !== "string" || !UUID.test(choices.nature_id) || typeof choices.presence !== "string" ||
      typeof choices.final_consumer !== "boolean" || (choices.series != null && (!Number.isSafeInteger(choices.series) || Number(choices.series) < 0 || Number(choices.series) > 889))) invalid("choices");
  }
  for (const key of ["page", "per_page"])
    if (input[key] !== undefined && (!/^\d+$/.test(String(input[key])) || !Number.isSafeInteger(Number(input[key])) || Number(input[key]) < 1 || (key === "per_page" && Number(input[key]) > 100))) invalid(key);
  if (operation.name.startsWith("nfce.")) {
    if (input.consumer_document !== undefined && input.consumer_document !== null && (typeof input.consumer_document !== "string" || input.consumer_document.length > 24 ||
      !/^[0-9A-Za-z .\-/]*$/.test(input.consumer_document))) invalid("consumer_document");
    if (input.nature_id !== undefined && input.nature_id !== null && (typeof input.nature_id !== "string" || !UUID.test(input.nature_id))) invalid("nature_id");
    if (input.cash_session_id !== undefined && (typeof input.cash_session_id !== "string" || !UUID.test(input.cash_session_id))) invalid("cash_session_id");
    for (const key of ["from", "to"]) if (input[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input[key]))) invalid(key);
    if (input.pending_only !== undefined && !["true", "false"].includes(String(input.pending_only))) invalid("pending_only");
    if (input.via !== undefined && !["consumidor", "estabelecimento"].includes(String(input.via))) invalid("via");
  }
  if (operation.name.startsWith("osnota.") && operation.name !== "osnota.list") {
    if (!(OS_NOTE_KINDS as readonly string[]).includes(String(input.kind))) invalid("kind");
    if (input.reason !== undefined && (input.kind !== "nfse" || !(NFSE_CANCEL_REASONS as readonly string[]).includes(String(input.reason)))) invalid("reason");
  }
  if (operation.name === "nfse.config.save") {
    const code = (key: string, digits: number) => input[key] != null && input[key] !== "" && (typeof input[key] !== "string" || !new RegExp(`^\\d{${digits}}$`).test(input[key] as string));
    if (code("national_code", 6)) invalid("national_code");
    if (code("municipal_code", 3)) invalid("municipal_code");
    if (code("nbs", 9)) invalid("nbs");
    if (code("municipality_code", 7)) invalid("municipality_code");
    if (input.iss_withheld !== undefined && typeof input.iss_withheld !== "boolean") invalid("iss_withheld");
    if (input.parts_nature_id != null && (typeof input.parts_nature_id !== "string" || !UUID.test(input.parts_nature_id))) invalid("parts_nature_id");
    if (input.items !== undefined && (!input.items || typeof input.items !== "object" || Array.isArray(input.items))) invalid("items");
  }
  if (operation.name.startsWith("nfe.")) {
    // Depois da NF-e autorizada: o motor confere o resto (faixa, saldo a devolver, texto).
    if (input.correction_id !== undefined && (typeof input.correction_id !== "string" || !UUID.test(input.correction_id))) invalid("correction_id");
    if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 4000)) invalid("text");
    if (input.finance_option !== undefined && !["credito", "pagar"].includes(String(input.finance_option))) invalid("finance_option");
    if (input.model !== undefined && !["nfe", "nfce"].includes(String(input.model))) invalid("model");
    for (const key of ["series", "first", "last"])
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < (key === "series" ? 0 : 1) || Number(input[key]) > (key === "series" ? 889 : 999999999))) invalid(key);
    if (input.sequence !== undefined && !/^(?:[1-9]|1\d|20)$/.test(String(input.sequence))) invalid("sequence");
    if (input.items !== undefined && (!Array.isArray(input.items) || !input.items.length || input.items.length > 990 || input.items.some(item => !item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["item", "quantity"].includes(key)) || !Number.isSafeInteger((item as Record<string, unknown>).item) || Number((item as Record<string, unknown>).item) < 0 ||
      typeof (item as Record<string, unknown>).quantity !== "string" || !/^\d{1,11}(\.\d{1,4})?$/.test(String((item as Record<string, unknown>).quantity))))) invalid("items");
  }
  if (input.status !== undefined && !["bloqueada", "preparada", "enviando", "processando", "incerta", "rejeitada", "autorizada", "denegada", "cancelada", "arquivada"].includes(String(input.status))) invalid("status");
}

/** Entrada restrita compartilhada pela tela, aplicações e propostas confirmadas. */
export async function commercialNfeRoute(env: Env, request: Request, profile: string, actor: Actor, dependencies: CommercialNfeRouteDependencies = {}): Promise<Response> {
  try {
    // Identidades externas têm o teto do cliente. Bots da equipe continuam
    // pelas mesmas operações, com a identidade autenticada e a política acima.
    if (isEngineActor(actor)) throw new ApiError(403, "fiscal_external_origin_forbidden", "A origem externa não alcança esta operação fiscal.");
    if (actor.kind === "app" && !actor.scopes.includes("erp:write") &&
      !(request.method === "GET" && actor.scopes.includes("erp:read")))
      throw new ApiError(403, "insufficient_scope", "A aplicação precisa do escopo de ERP correspondente à operação.");
    if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
    const url = new URL(request.url);
    const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe/`;
    if (!url.pathname.startsWith(prefix)) throw new ApiError(404, "not_found", "Operação não encontrada.");
    const path = url.pathname.slice(prefix.length).replace(/\/+$/, "");
    const operation = [...COM1_OPERATIONS, ...NFCE_OPERATIONS, ...OS_NOTE_OPERATIONS, ...NFE_EVENT_OPERATIONS].find(op => op.method === request.method.toUpperCase() && new RegExp(`^${op.path.replace(":id", "[^/]+")}$`).test(path));
    if (!operation) throw new ApiError(404, "not_found", "Operação não encontrada.");
    const id = operation.path.includes(":id") ? path.split("/")[operation.path.split("/").indexOf(":id")] : undefined;
    if (id !== undefined && !UUID.test(id)) invalid("id");
    const input: Record<string, unknown> = {};
    if (operation.method === "GET") {
      for (const [key, value] of url.searchParams) {
        if (!(operation.query ?? []).includes(key) || Object.hasOwn(input, key)) invalid(key);
        input[key] = value;
      }
    } else {
      if (url.search) invalid("query");
      const raw = await request.text();
      if (raw.length > 32_768) invalid("body");
      let body: unknown;
      try { body = JSON.parse(raw); } catch { invalid("body"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) invalid("body");
      for (const [key, value] of Object.entries(body)) {
        if (!operation.body.includes(key)) invalid(key);
        input[key] = value;
      }
    }
    validateInput(operation, input);
    const identity = await (dependencies.resolveIdentity ?? erpIdentity)(env, actor, profile, request.method, url.pathname);
    const person = identity.actor;
    if (!person) throw new ApiError(403, "fiscal_forbidden", "Seu acesso não permite esta operação fiscal.");
    const authority: Com1Authority = dependencies.authority ? await dependencies.authority(actor, profile, operation) : {
      origin: "application", proposed_by: actor.via?.bot_id ?? null,
      confirmed_by: actor.via?.proposal_id ? person.user_id : null,
      confirmation_id: actor.via?.proposal_id ?? null,
    };
    const action = operation.name === "com1.effects" && input.axis === "finance" ? "effect_finance" : operation.action;
    identity.actor = com1ExecutionActor(person, action, authority);
    const counter = operation.name.startsWith("nfce.");
    const allowed = counter ? NFCE_ROLES[action] ?? ["admin"] : action === "configure" ? ["admin"] : action === "read" ? ["admin", "consulta", "fiscal"]
      : action === "effect_stock" ? ["admin", "estoque"] : action === "effect_finance" ? ["admin", "financeiro"] : ["admin", "fiscal"];
    if (!person.erp_role || !allowed.includes(person.erp_role)) throw new ApiError(403, "fiscal_forbidden", "Seu papel não permite esta operação.");
    // Notas da ordem: tudo exige Fiscal; a nota de peças também Vendas e Produtos (o motor confere e explica).
    const orderNotes = operation.name.startsWith("osnota.") || operation.name.startsWith("nfse.");
    // Carta de correção, inutilização e devolução: só a parte Fiscal (e os
    // cadastros); estoque e financeiro da devolução respeitam as próprias partes no motor.
    if (operation.name.startsWith("nfe.")) {
      if (!identity.parts?.customers || !identity.parts.fiscal)
        throw new ApiError(409, "module_disabled", "Carta de correção, inutilização e devolução dependem da parte Fiscal ligada. Peça ao administrador para ligá-la em Gestão → Módulos.");
    } else if (orderNotes && (!identity.parts?.customers || !identity.parts.fiscal || (input.kind === "nfe" && action === "emit" && (!identity.parts.products || !identity.parts.sales))))
      throw new ApiError(409, "module_disabled", input.kind === "nfe" && identity.parts?.fiscal
        ? "A nota de peças depende das partes Vendas e Produtos ligadas. Peça ao administrador para ligá-las em Gestão → Módulos."
        : "As notas da ordem dependem da parte Fiscal ligada. Peça ao administrador para ligá-la em Gestão → Módulos.");
    if (!identity.parts?.customers || !identity.parts.fiscal || (!orderNotes && !operation.name.startsWith("nfe.") && ["prepare", "emit"].includes(action) && (!identity.parts.products || !identity.parts.sales)))
      throw new ApiError(409, "module_disabled", counter ? "O cupom fiscal depende das partes Caixa / PDV e Fiscal ligadas. Peça ao administrador para ligá-las em Gestão → Módulos." : "Esta operação depende de uma parte desligada.");
    if (counter && !identity.parts.pos)
      throw new ApiError(409, "module_disabled", "O cupom fiscal depende das partes Caixa / PDV e Fiscal ligadas. Peça ao administrador para ligá-las em Gestão → Módulos.");
    const privacy = await (dependencies.privacy ?? erpPrivacy)(env, profile);
    identity.customer_privacy = privacy;
    await (dependencies.checkGate ?? checkGate)(env, profile, identity);
    const result = await (dependencies.handle ?? commercialNfeHttp())({ env, request, profile, actor, identity, operation, params: { id }, input, authority, fetch: dependencies.fetch });
    const currentPrivacy = await (dependencies.privacy ?? erpPrivacy)(env, profile);
    if (erpPrivacyChanged(privacy, currentPrivacy)) throw new ApiError(403, "erp_customer_restricted", "O acesso cadastral mudou. Atualize a consulta.");
    if (result.headers.get("Content-Type")?.includes("application/json")) {
      const data = await result.clone().json();
      if (containsRestrictedContact(data, new Set(currentPrivacy.restricted_contact_ids))) throw new ApiError(403, "erp_customer_restricted", "O resultado contém cadastro restrito.");
    }
    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "private, no-store"); headers.set("X-Content-Type-Options", "nosniff");
    // A ferramenta interna pede JSON. Após obter e validar o mesmo arquivo,
    // devolve um vínculo autenticado à pessoa, sem bytes fiscais para a IA.
    // A navegação/download continua exigindo sessão, papel e privacidade.
    if (actor.via && request.headers.get("Accept")?.split(",").some(type => type.trim().split(";")[0] === "application/json") &&
        result.status === 200 && (["com1.danfe", "com1.xml", "com1.cancel.xml", "nfce.coupon", "osnota.xml", "osnota.pdf", "osnota.cancel.xml"].includes(operation.name) || Object.hasOwn(NFE_EVENT_FILES, operation.name)) &&
        /^(?:application\/pdf|application\/xml)(?:;|$)/i.test(headers.get("Content-Type") ?? "")) {
      const contentType = headers.get("Content-Type")!.split(";")[0];
      const rawSize = headers.get("Content-Length"), size = rawSize !== null && /^\d+$/.test(rawSize) ? Number(rawSize) : null;
      await result.body?.cancel();
      const eventFile = Object.hasOwn(NFE_EVENT_FILES, operation.name);
      return Response.json({ emission_id: id, artifact: ["com1.danfe", "osnota.pdf"].includes(operation.name) ? "danfe" : operation.name === "nfce.coupon" ? "danfce"
        : ["com1.xml", "osnota.xml"].includes(operation.name) ? "xml" : eventFile ? operation.name.replace(/^nfe\./, "").replace(/\./g, "_") : "cancellation_xml",
        content_type: contentType, size_bytes: size, download_url: eventFile ? `${url.pathname}${url.search}` : url.pathname, authentication_required: true },
        { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return new Response(result.body, { status: result.status, headers });
  } catch (error) {
    if (error instanceof ApiError) return Response.json({ code: error.code, message: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    if (error instanceof ErpError) return Response.json({ code: error.message, message: error.message === "com1_not_ready" ? "O fluxo comercial de NF-e ainda não está habilitado." : error.message },
      { status: error.code === "42501" ? 403 : error.code === "22023" ? 400 : 409, headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}

export const erpCommercialNfeRoute = commercialNfeRoute;
