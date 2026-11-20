import type { Com1Action } from "../domains/fiscal/comnfe/access.ts";

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
  Com1EmissionPage: outputObject({ items: outputArray("EmissionSummary"), page: propertySchemas.page, per_page: propertySchemas.per_page,
    total: { type: "integer", minimum: 0 } }),
  Com1ArtifactMetadata: outputObject({ emission_id: { type: "string", format: "uuid" },
    artifact: { type: "string", enum: ["danfe", "xml", "cancellation_xml"] }, content_type: { type: "string", enum: ["application/pdf", "application/xml"] },
    size_bytes: { type: ["integer", "null"], minimum: 0 }, download_url: { type: "string", description: "Caminho relativo da mesma rota autenticada; não concede acesso público." },
    authentication_required: { const: true, type: "boolean" } }),
  Com1Error: outputObject({ code: { type: "string" }, message: { type: "string" }, field: { type: "string" }, blockers: outputArray("FiscalBlocker") }, ["code", "message"]),
};

const jsonResponse = (name: string, description: string) => ({ description, content: { "application/json": { schema: schemaRef(name) } } });
// A lista omite os corpos grandes; o detalhe conserva a revisão completa.
const revisionSchema = COM1_RESPONSE_SCHEMAS.Com1ImmutableRevision as ReturnType<typeof outputObject>;
const omittedRevisionFields = new Set(["snapshot", "tax_sources", "body", "calculation"]);
COM1_RESPONSE_SCHEMAS.Com1RevisionSummary = outputObject(
  Object.fromEntries(Object.entries(revisionSchema.properties).filter(([key]) => !omittedRevisionFields.has(key))),
  revisionSchema.required.filter(key => !omittedRevisionFields.has(key)),
);
const emissionSchema = COM1_RESPONSE_SCHEMAS.Com1EmissionView as ReturnType<typeof outputObject>;
COM1_RESPONSE_SCHEMAS.Com1EmissionSummary = outputObject(
  { ...emissionSchema.properties, revision: schemaRef("RevisionSummary") }, emissionSchema.required,
);

function operationResponses(name: string) {
  const schema = name.startsWith("com1.config.") ? "CommercialSettings" : name === "com1.prepare" ? "PreparationResult"
    : name === "com1.list" ? "EmissionPage" : name === "com1.effects" ? "EffectView" : "EmissionView";
  const binary = name === "com1.danfe" ? "application/pdf" : ["com1.xml", "com1.cancel.xml"].includes(name) ? "application/xml" : null;
  return {
    "200": binary ? { description: "Arquivo correspondente à emissão vinculada, privado e sem cache.", content: { [binary]: { schema: { type: "string", format: "binary" } },
        "application/json": { schema: schemaRef("ArtifactMetadata") } } }
      : jsonResponse(schema, "Resultado público da operação"),
    "202": jsonResponse(binary ? "Error" : schema, "Operação inconclusiva ou arquivo pendente; consultar a mesma emissão"),
    "400": jsonResponse("Error", "Formato inválido"), "403": jsonResponse("Error", "Acesso recusado"),
    "404": jsonResponse("Error", "Vínculo não visível"), "409": jsonResponse("Error", "Conflito, configuração ou parte desligada"),
    "422": jsonResponse("Error", "Bloqueios fiscais"),
  };
}

/** Contrato leve compartilhado pela rota, pelo módulo Fiscal e pelo catálogo dos bots. */
export const COM1_MODULE_CONTRACT = {
  module: "erp-fiscal", routes: ["erp-comercial-nfe"], operations: ["com1."],
  definition: { bot: { sensitive: COM1_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(COM1_OPERATIONS.map(op => [op.name, op.summary])) } },
  openapi: { components: { schemas: COM1_RESPONSE_SCHEMAS }, paths: Object.fromEntries([...new Set(COM1_OPERATIONS.map(op => op.path))].map(path => [
    `/profiles/{profile}/erp-comercial-nfe/${path.replace(":id", "{id}")}`,
    Object.fromEntries(COM1_OPERATIONS.filter(op => op.path === path).map(op => [op.method.toLowerCase(), {
      operationId: op.name, summary: op.summary,
      description: `${op.summary}. Permissão: erp:${op.method === "GET" ? "read" : "write"}. ${op.sensitive ? "Categoria sensível; por padrão exige confirmação da pessoa com o papel responsável." : "Consulta fiscal sujeita às regras de privacidade."}${["com1.danfe", "com1.xml", "com1.cancel.xml"].includes(op.name) ? " A ferramenta do bot com Accept application/json recebe metadados e vínculo autenticado após validação do arquivo; download direto mantém o formato binário." : ""}`,
      parameters: [{ name: "profile", in: "path", required: true, schema: { type: "string" } },
        ...(path.includes(":id") ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] : []),
        ...(op.query ?? []).map(name => ({ name, in: "query", required: name === "environment", schema: propertySchemas[name] ?? { type: "string" } }))],
      ...(op.method === "GET" ? {} : { requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(op.body.map(key => [key, propertySchemas[key]])), required: op.required } } } } }),
      responses: operationResponses(op.name),
    }])) ])) },
};

