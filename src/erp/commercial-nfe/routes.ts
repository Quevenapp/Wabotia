import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, isEngineActor } from "../../security";
import { erpIdentity } from "../../modules/erp/identity";
import { erpPrivacy, erpPrivacyChanged } from "../../customer/erp-privacy";
import { containsRestrictedContact, encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { ErpError } from "../engine/errors.ts";
import { erpFetch } from "../hub.ts";
import { requireCom1SensitivePolicy, type Com1Action, type Com1Authority } from "../domains/fiscal/comnfe/access.ts";
import { commercialNfeHttp } from "./slots.ts";

export interface CommercialNfeOperation {
  name: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  summary: string;
  action: Com1Action;
  sensitive: boolean;
  body: readonly string[];
  required: readonly string[];
  query?: readonly string[];
}

/** Fonte única dos nomes, campos, efeitos e OpenAPI para painel, bots e bridge. */
export const COM1_OPERATIONS: readonly CommercialNfeOperation[] = Object.freeze([
  { name: "com1.config.get", method: "GET", path: "config", summary: "Consultar configuração fiscal comercial e checklist sem segredos", action: "read", sensitive: false, body: [], required: [] },
  { name: "com1.config.save", method: "PUT", path: "config", summary: "Alterar ambiente, políticas de efeitos e série fiscal da área", action: "configure", sensitive: true,
    body: ["command_id", "expected_version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "acknowledge_tax_limits", "enable_production"],
    required: ["command_id", "expected_version", "environment", "stock_timing", "finance_timing"] },
  { name: "com1.prepare", method: "POST", path: "pedidos/:id/preparar", summary: "Preparar NF-e do pedido salvo e apresentar cálculo e bloqueios", action: "prepare", sensitive: true,
    body: ["command_id", "expected_document_version", "choices", "new_fiscal_version", "expected_emission_version"], required: ["command_id", "expected_document_version", "choices"] },
  { name: "com1.list", method: "GET", path: "emissoes", summary: "Listar emissões comerciais de um ambiente fiscal", action: "read", sensitive: false, body: [], required: [], query: ["environment", "document_id", "status", "page", "per_page"] },
  { name: "com1.get", method: "GET", path: "emissoes/:id", summary: "Consultar preparação, situação fiscal, efeitos e cancelamento", action: "read", sensitive: false, body: [], required: [] },
  { name: "com1.emit", method: "POST", path: "emissoes/:id/emitir", summary: "Emitir a revisão confirmada da NF-e pelo cofre", action: "emit", sensitive: true,
    body: ["command_id", "expected_version", "body_revision", "body_hash"], required: ["command_id", "expected_version", "body_revision", "body_hash"] },
  { name: "com1.resume", method: "POST", path: "emissoes/:id/retomar", summary: "Consultar e retomar a mesma emissão sem criar outra referência", action: "resume", sensitive: true,
    body: ["command_id", "expected_version", "body_revision"], required: ["command_id", "expected_version", "body_revision"] },
  { name: "com1.effects", method: "POST", path: "emissoes/:id/efeitos", summary: "Conciliar ou aplicar um efeito de estoque ou financeiro sem emitir nota", action: "effect_stock", sensitive: true,
    body: ["command_id", "expected_version", "axis", "intent", "physical_return_confirmed"], required: ["command_id", "expected_version", "axis", "intent"] },
  { name: "com1.danfe", method: "GET", path: "emissoes/:id/danfe", summary: "Obter o DANFE gerado pelo cofre para a emissão vinculada", action: "read", sensitive: false, body: [], required: [] },
  { name: "com1.xml", method: "GET", path: "emissoes/:id/xml", summary: "Obter o XML fiscal da emissão vinculada no cofre", action: "read", sensitive: false, body: [], required: [] },
  { name: "com1.cancel", method: "POST", path: "emissoes/:id/cancelar", summary: "Solicitar ou retomar cancelamento fiscal com justificativa", action: "cancel", sensitive: true,
    body: ["command_id", "expected_version", "justification"], required: ["command_id", "expected_version", "justification"] },
  { name: "com1.cancel.xml", method: "GET", path: "emissoes/:id/cancelamento/xml", summary: "Obter o XML arquivado do cancelamento ou informar sua pendência", action: "read", sensitive: false, body: [], required: [] },
]);

const propertySchemas: Record<string, unknown> = {
  command_id: { type: "string", format: "uuid" }, expected_version: { type: "integer", minimum: 1 },
  expected_document_version: { type: "integer", minimum: 1 }, expected_emission_version: { type: "integer", minimum: 1 },
  body_revision: { type: "integer", minimum: 1 }, body_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
  environment: { type: "string", enum: ["homologacao", "producao"] },
  stock_timing: { type: "string", enum: ["existing", "on_authorization"] }, finance_timing: { type: "string", enum: ["existing", "on_authorization"] },
  series_homologacao: { type: ["integer", "null"], minimum: 0, maximum: 889 }, series_producao: { type: ["integer", "null"], minimum: 0, maximum: 889 },
  acknowledge_tax_limits: { type: "boolean" }, enable_production: { type: "boolean" }, new_fiscal_version: { type: "boolean" },
  axis: { type: "string", enum: ["stock", "finance"] }, intent: { type: "string", enum: ["apply", "apply_skipped", "reconcile", "reverse"] },
  physical_return_confirmed: { type: "boolean" }, justification: { type: "string", minLength: 15, maxLength: 255 },
  document_id: { type: "string", format: "uuid" }, page: { type: "integer", minimum: 1 }, per_page: { type: "integer", minimum: 1, maximum: 100 },
  status: { type: "string", enum: ["bloqueada", "preparada", "enviando", "processando", "incerta", "rejeitada", "autorizada", "denegada", "cancelada", "arquivada"] },
  choices: { type: "object", additionalProperties: false, properties: { nature_id: { type: "string", format: "uuid" }, presence: { type: "string" }, final_consumer: { type: "boolean" }, series: { type: ["integer", "null"], minimum: 0, maximum: 889 } }, required: ["nature_id", "presence", "final_consumer"] },
};

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/Com1${name}` });
const outputObject = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required });
const nullableText = { type: ["string", "null"] };
const outputJson = { type: "object", additionalProperties: true };
const timestamp = { type: ["string", "null"], pattern: "^[0-9]+$", description: "Microssegundos UTC em texto decimal exato." };
const outputArray = (name: string) => ({ type: "array", items: schemaRef(name) });

/** DTOs públicos correspondentes a contracts.ts. Recibos/tokens internos não são publicados. */
export const COM1_RESPONSE_SCHEMAS: Record<string, unknown> = {
  Com1FiscalBlocker: outputObject({ code: { type: "string" }, field: { type: "string" }, item_id: { type: "string" }, entity_id: { type: "string" },
    message: { type: "string" }, correction: outputObject({ screen: { type: "string" }, id: { type: "string" }, field: { type: "string" } }, ["screen"]) },
  ["code", "field", "message", "correction"]),
  Com1CommercialSettings: outputObject({ id: { type: "integer", const: 1 }, version: propertySchemas.expected_version,
    environment: propertySchemas.environment, stock_timing: propertySchemas.stock_timing, finance_timing: propertySchemas.finance_timing,
    series_homologacao: propertySchemas.series_homologacao, series_producao: propertySchemas.series_producao,
    connection_fingerprint: nullableText, connection_public: { type: ["object", "null"], description: "Identidade pública conferida da conexão; nunca credenciais." },
    production_enabled_at: timestamp, production_enabled_by: nullableText, tax_limits_acknowledged_at: timestamp,
    tax_limits_acknowledged_by: nullableText, updated_at: timestamp, updated_by: nullableText,
    checklist: { type: "array", items: outputObject({ code: { type: "string" }, message: { type: "string" } }) } },
  ["id", "version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "connection_fingerprint", "connection_public", "production_enabled_at", "production_enabled_by", "tax_limits_acknowledged_at", "tax_limits_acknowledged_by", "updated_at", "updated_by"]),
  Com1FiscalMessage: outputObject({ code: { type: "string" }, description: { type: "string" } }),
  Com1ImmutableRevision: outputObject({ emission_id: { type: "string", format: "uuid" }, body_revision: propertySchemas.body_revision,
    source_document_version: propertySchemas.expected_document_version, snapshot: outputJson, tax_sources: outputJson,
    commercial_hash: propertySchemas.body_hash, source_fingerprint: propertySchemas.body_hash,
    body: { type: ["object", "null"], description: "PedidoNfe imutável produzido no servidor; omissão de campos fiscais não suportados gera bloqueio." },
    body_hash: nullableText, calculation: outputJson, blockers: outputArray("FiscalBlocker"), prepared_by: { type: "string" }, prepared_at: timestamp }),
  Com1EffectView: outputObject({ emission_id: { type: "string", format: "uuid" }, axis: propertySchemas.axis,
    state: { type: "string", enum: ["aplicado", "reconhecido", "pendente", "pulado"] }, origin: nullableText, ids: outputJson,
    fingerprint: nullableText, reason: nullableText, responsible_role: { type: "string", enum: ["estoque", "financeiro", "admin"] },
    person_id: nullableText, command_id: nullableText, result: { type: ["object", "null"] },
    compensation_state: { type: ["string", "null"], enum: ["pendente", "revertido", "compensacao_pendente", null] },
    compensation_command_id: nullableText, compensation_result: { type: ["object", "null"] }, updated_at: timestamp }),
  Com1CancellationView: outputObject({ emission_id: { type: "string", format: "uuid" }, justification: propertySchemas.justification,
    command_id: propertySchemas.command_id, state: { type: "string", enum: ["pedido", "enviando", "incerto", "recusado", "registrado"] },
    messages: outputArray("FiscalMessage"), protocol: nullableText, event_at: timestamp, repeated: { type: "boolean" },
    xml_status: { type: "string", enum: ["pendente", "disponivel"] }, xml_hash: nullableText }),
  Com1EmissionView: outputObject({ id: { type: "string", format: "uuid" }, document_id: propertySchemas.document_id,
    fiscal_version: { type: "integer", minimum: 1, maximum: 9999 }, environment: propertySchemas.environment, environment_confirmed: { type: "boolean" },
    connection_fingerprint: nullableText, reference: { type: "string", description: "wb.<UUID do pedido>.v<versão fiscal>" },
    current_body_revision: propertySchemas.body_revision, status: propertySchemas.status, version: propertySchemas.expected_version,
    provider_id: nullableText, provider_status: nullableText, messages: outputArray("FiscalMessage"), series: { type: ["integer", "null"] },
    number: { type: ["integer", "null"] }, access_key: nullableText, protocol: nullableText, issued_at: timestamp, authorized_at: timestamp,
    total: { type: ["string", "null"], pattern: "^[0-9]+$", description: "Total em centavos exatos." }, created_at: timestamp,
    created_by: { type: "string" }, updated_at: timestamp, revision: schemaRef("ImmutableRevision"), effects: outputArray("EffectView"),
    cancellation: { anyOf: [schemaRef("CancellationView"), { type: "null" }] } }),
  Com1PreparationResult: outputObject({ emission: schemaRef("EmissionView"), blockers: outputArray("FiscalBlocker"),
    effects_preview: outputArray("EffectView"), replayed: { type: "boolean" } }),
  Com1EmissionPage: outputObject({ items: outputArray("EmissionView"), page: propertySchemas.page, per_page: propertySchemas.per_page,
    total: { type: "integer", minimum: 0 } }),
  Com1Error: outputObject({ code: { type: "string" }, message: { type: "string" }, field: { type: "string" }, blockers: outputArray("FiscalBlocker") }, ["code", "message"]),
};

const jsonResponse = (name: string, description: string) => ({ description, content: { "application/json": { schema: schemaRef(name) } } });
function operationResponses(name: string) {
  const schema = name.startsWith("com1.config.") ? "CommercialSettings" : name === "com1.prepare" ? "PreparationResult"
    : name === "com1.list" ? "EmissionPage" : name === "com1.effects" ? "EffectView" : "EmissionView";
  const binary = name === "com1.danfe" ? "application/pdf" : ["com1.xml", "com1.cancel.xml"].includes(name) ? "application/xml" : null;
  return {
    "200": binary ? { description: "Arquivo correspondente à emissão vinculada, privado e sem cache.", content: { [binary]: { schema: { type: "string", format: "binary" } } } }
      : jsonResponse(schema, "Resultado público da operação"),
    "202": jsonResponse(binary ? "Error" : schema, "Operação inconclusiva ou arquivo pendente; consultar a mesma emissão"),
    "400": jsonResponse("Error", "Formato inválido"), "403": jsonResponse("Error", "Acesso recusado"),
    "404": jsonResponse("Error", "Vínculo não visível"), "409": jsonResponse("Error", "Conflito, configuração ou parte desligada"),
    "422": jsonResponse("Error", "Bloqueios fiscais"),
  };
}

/**
 * Pronto para incorporar ao módulo ERP Fiscal. A matriz da base não permite
 * editar modules/erp/definition.ts, modules/runtime.ts ou openapi.ts. Enquanto
 * não ligados, estes metadados não afirmam que o catálogo global já os inclui.
 */
export const COM1_MODULE_CONTRACT = {
  module: "erp-fiscal", routes: ["erp-comercial-nfe"], operations: ["com1."],
  definition: { bot: { sensitive: COM1_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(COM1_OPERATIONS.map(op => [op.name, op.summary])) } },
  openapi: { components: { schemas: COM1_RESPONSE_SCHEMAS }, paths: Object.fromEntries([...new Set(COM1_OPERATIONS.map(op => op.path))].map(path => [
    `/profiles/{profile}/erp-comercial-nfe/${path.replace(":id", "{id}")}`,
    Object.fromEntries(COM1_OPERATIONS.filter(op => op.path === path).map(op => [op.method.toLowerCase(), {
      operationId: op.name, summary: op.summary,
      description: `${op.summary}. Permissão: erp:${op.method === "GET" ? "read" : "write"}. ${op.sensitive ? "Categoria sensível; por padrão exige confirmação da pessoa com o papel responsável." : "Consulta fiscal sujeita às regras de privacidade."}`,
      parameters: [{ name: "profile", in: "path", required: true, schema: { type: "string" } },
        ...(path.includes(":id") ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] : []),
        ...(op.query ?? []).map(name => ({ name, in: "query", required: name === "environment", schema: propertySchemas[name] ?? { type: "string" } }))],
      ...(op.method === "GET" ? {} : { requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(op.body.map(key => [key, propertySchemas[key]])), required: op.required } } } } }),
      responses: operationResponses(op.name),
    }])) ])) },
};

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
  if (input.status !== undefined && !["bloqueada", "preparada", "enviando", "processando", "incerta", "rejeitada", "autorizada", "denegada", "cancelada", "arquivada"].includes(String(input.status))) invalid("status");
}

/** Entrada restrita. A base permanece fechada até installCommercialNfeHttp. */
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
    const operation = COM1_OPERATIONS.find(op => op.method === request.method.toUpperCase() && new RegExp(`^${op.path.replace(":id", "[^/]+")}$`).test(path));
    if (!operation) throw new ApiError(404, "not_found", "Operação não encontrada.");
    const id = operation.path.includes(":id") ? path.split("/")[1] : undefined;
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
    const identity = await (dependencies.resolveIdentity ?? erpIdentity)(env, actor, profile, request.method);
    const person = identity.actor;
    if (!person) throw new ApiError(403, "fiscal_forbidden", "Seu acesso não permite esta operação fiscal.");
    const authority: Com1Authority = dependencies.authority ? await dependencies.authority(actor, profile, operation) : {
      origin: "application", proposed_by: actor.via?.bot_id ?? null,
      confirmed_by: actor.via?.proposal_id ? person.user_id : null,
      confirmation_id: actor.via?.proposal_id ?? null,
    };
    const action = operation.name === "com1.effects" && input.axis === "finance" ? "effect_finance" : operation.action;
    requireCom1SensitivePolicy(person, action, authority);
    // erpIdentity marca via de bot como agente. Após confirmação comprovada na
    // identidade autenticada, executa a pessoa que confirmou; autoria proposta
    // permanece em authority. Assim o portão legado conserva horário/MFA.
    if (actor.kind === "user" && actor.via?.proposal_id && !person.is_technical && person.session_id &&
      authority.origin === "application" && authority.confirmation_id === actor.via.proposal_id && authority.confirmed_by === person.user_id)
      identity.actor = { ...person, is_agent: false };
    const allowed = action === "configure" ? ["admin"] : action === "read" ? ["admin", "consulta", "fiscal"]
      : action === "effect_stock" ? ["admin", "estoque"] : action === "effect_finance" ? ["admin", "financeiro"] : ["admin", "fiscal"];
    if (!person.erp_role || !allowed.includes(person.erp_role)) throw new ApiError(403, "fiscal_forbidden", "Seu papel não permite esta operação.");
    if (!identity.parts?.customers || !identity.parts.fiscal || (["prepare", "emit"].includes(action) && (!identity.parts.products || !identity.parts.sales)))
      throw new ApiError(409, "module_disabled", "Esta operação depende de uma parte desligada.");
    const privacy = await (dependencies.privacy ?? erpPrivacy)(env, profile);
    identity.customer_privacy = privacy;
    await (dependencies.checkGate ?? checkGate)(env, profile, identity);
    const result = await commercialNfeHttp()({ env, request, profile, actor, identity, operation, params: { id }, input, authority, fetch: dependencies.fetch });
    const currentPrivacy = await (dependencies.privacy ?? erpPrivacy)(env, profile);
    if (erpPrivacyChanged(privacy, currentPrivacy)) throw new ApiError(403, "erp_customer_restricted", "O acesso cadastral mudou. Atualize a consulta.");
    if (result.headers.get("Content-Type")?.includes("application/json")) {
      const data = await result.clone().json();
      if (containsRestrictedContact(data, new Set(currentPrivacy.restricted_contact_ids))) throw new ApiError(403, "erp_customer_restricted", "O resultado contém cadastro restrito.");
    }
    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "private, no-store"); headers.set("X-Content-Type-Options", "nosniff");
    return new Response(result.body, { status: result.status, headers });
  } catch (error) {
    if (error instanceof ApiError) return Response.json({ code: error.code, message: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    if (error instanceof ErpError) return Response.json({ code: error.message, message: error.message === "com1_not_ready" ? "O fluxo comercial de NF-e ainda não está habilitado." : error.message },
      { status: error.code === "42501" ? 403 : error.code === "22023" ? 400 : 409, headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}

export const erpCommercialNfeRoute = commercialNfeRoute;
