import { ApiError } from "../../types";
import { createPiiMask } from "../../pii-mask";
import { ErpError } from "../engine/errors.ts";
import { CommercialNfeError } from "./artifacts.ts";
import type { CommercialNfeHttpContext } from "./routes.ts";
import type { CommercialNfeHttpHandler } from "./slots.ts";
import type {
  CommercialSettings, ConfigSaveInput, EffectInput, EffectView, EmissionPage, EmissionView,
  ListInput, PreparationResult, PrepareInput, ReadInput,
} from "./contracts.ts";

export interface PublicEmissionInput extends ReadInput {
  command_id: string;
  expected_version: number;
  body_revision: number;
  body_hash: string;
}
export type PublicResumeInput = Omit<PublicEmissionInput, "body_hash">;
export interface PublicCancellationInput extends ReadInput { command_id: string; expected_version: number; justification: string }

/** Mesmas operações para pessoa e bot; autoridade é resolvida pela rota base. */
export interface CommercialNfeService {
  configGet(): Promise<CommercialSettings>;
  configSave(input: ConfigSaveInput): Promise<CommercialSettings>;
  prepare(input: PrepareInput): Promise<PreparationResult>;
  list(input: ListInput): Promise<EmissionPage>;
  read(input: ReadInput): Promise<EmissionView>;
  emit(input: PublicEmissionInput): Promise<EmissionView>;
  resume(input: PublicResumeInput): Promise<EmissionView>;
  effects(input: EffectInput): Promise<EffectView>;
  danfe(input: ReadInput): Promise<Response>;
  xml(input: ReadInput): Promise<Response>;
  cancel(input: PublicCancellationInput): Promise<EmissionView>;
  cancellationXml(input: ReadInput): Promise<Response>;
}

export interface CommercialNfeHttpDependencies {
  service(context: CommercialNfeHttpContext): CommercialNfeService | Promise<CommercialNfeService>;
}

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const EMISSION_FIELDS = ["id", "document_id", "fiscal_version", "environment", "environment_confirmed", "connection_fingerprint", "reference",
  "current_body_revision", "status", "version", "provider_id", "provider_status", "messages", "series", "number", "access_key", "protocol",
  "issued_at", "authorized_at", "total", "created_at", "created_by", "updated_at"];
const REVISION_FIELDS = ["emission_id", "body_revision", "source_document_version", "snapshot", "tax_sources", "commercial_hash", "source_fingerprint",
  "body", "body_hash", "calculation", "blockers", "prepared_by", "prepared_at"];
const EFFECT_FIELDS = ["emission_id", "axis", "state", "origin", "ids", "fingerprint", "reason", "responsible_role", "person_id", "command_id", "result",
  "compensation_state", "compensation_command_id", "compensation_result", "updated_at"];
const CANCEL_FIELDS = ["emission_id", "justification", "command_id", "state", "messages", "protocol", "event_at", "repeated", "xml_status", "xml_hash"];
const CONFIG_FIELDS = ["id", "version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "connection_fingerprint",
  "connection_public", "production_enabled_at", "production_enabled_by", "tax_limits_acknowledged_at", "tax_limits_acknowledged_by", "updated_at", "updated_by", "checklist"];
const secretKey = /^(?:token|claim_token|lease_until|request|evidence|cancellation_xml|archived_xml|xml|xml_text|body_text|secret|password|senha|certificate|certificado|api_key|apikey|access_token|refresh_token|authorization|key_hash|code_hash)$/i;
const personalKey = /^(?:nome|name|fantasia|email|phone|mobile|telefone|celular|cpf|cnpj|document|issuer_cnpj|endereco|endereço|address|street|logradouro|bairro|district|complement|complemento|postal_code|cep|inscricaoEstadual|inscricaoMunicipal|contact_name|recipient_name)$/i;
const pick = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
};

function emissionDto(value: EmissionView, summary = false): Record<string, unknown> {
  // A listagem conserva identidade/revisão e situação; o detalhe contém o
  // snapshot para revisão. Não multiplicar corpos fiscais por página.
  const fields = summary ? REVISION_FIELDS.filter(key => !["snapshot", "tax_sources", "body", "calculation"].includes(key)) : REVISION_FIELDS;
  return { ...pick(value, EMISSION_FIELDS), revision: pick(value.revision, fields),
    effects: value.effects.map(effect => pick(effect, EFFECT_FIELDS)), cancellation: value.cancellation ? pick(value.cancellation, CANCEL_FIELDS) : null };
}

/** Projeção única da saída: recibos/capacidades/XML restrito nunca saem em JSON. */
export function commercialNfePublicDto(context: CommercialNfeHttpContext, value: unknown): unknown {
  const name = context.operation.name;
  let dto: unknown;
  if (name === "com1.prepare") {
    const result = value as PreparationResult;
    dto = { emission: emissionDto(result.emission), blockers: result.blockers,
      effects_preview: result.effects_preview.map(effect => pick(effect, EFFECT_FIELDS)), replayed: result.replayed };
  } else if (name === "com1.list") {
    const page = value as EmissionPage;
    dto = { items: page.items.map(item => emissionDto(item, true)), page: page.page, per_page: page.per_page, total: page.total };
  } else if (name.startsWith("com1.config.")) dto = pick(value, CONFIG_FIELDS);
  else if (name === "com1.effects") dto = pick(value, EFFECT_FIELDS);
  else dto = emissionDto(value as EmissionView);
  const masked = !!(context.actor.via || context.identity.actor?.is_agent || context.identity.actor?.is_technical) && context.actor.via?.masked !== false;
  const clean = (item: unknown, depth = 0): unknown => {
    if (depth > 24) return null;
    if (typeof item === "string") return item.replace(/\b(?:wab[ul]?_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g, "[oculto]");
    if (Array.isArray(item)) return item.map(entry => clean(entry, depth + 1));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !secretKey.test(key)).map(([key, entry]) =>
      [key, masked && personalKey.test(key) ? "[dado pessoal oculto]" : clean(entry, depth + 1)]));
  };
  return createPiiMask(masked).maskValue(clean(dto));
}

const awaiting = (value: unknown): boolean => {
  const result = value as Partial<EmissionView> | null;
  return !!result && (["enviando", "processando", "incerta"].includes(result.status ?? "") ||
    !!result.cancellation && ["pedido", "enviando", "incerto"].includes(result.cancellation.state));
};

/** Instalar com installCommercialNfeHttp; não altera registros de produção ao importar. */
export function createCommercialNfeHttp(dependencies: CommercialNfeHttpDependencies): CommercialNfeHttpHandler {
  return async context => {
    try {
      const service = await dependencies.service(context);
      const input = context.input;
      const identified = { ...input, emission_id: context.params.id! };
      let result: unknown;
      switch (context.operation.name) {
        case "com1.config.get": result = await service.configGet(); break;
        case "com1.config.save": result = await service.configSave(input as unknown as ConfigSaveInput); break;
        case "com1.prepare": result = await service.prepare({ ...input, document_id: context.params.id! } as unknown as PrepareInput); break;
        case "com1.list": result = await service.list({ ...input,
          ...(input.page === undefined ? {} : { page: Number(input.page) }),
          ...(input.per_page === undefined ? {} : { per_page: Number(input.per_page) }),
        } as unknown as ListInput); break;
        case "com1.get": result = await service.read(identified); break;
        case "com1.emit": result = await service.emit(identified as unknown as PublicEmissionInput); break;
        case "com1.resume": result = await service.resume(identified as unknown as PublicResumeInput); break;
        case "com1.effects": result = await service.effects(identified as unknown as EffectInput); break;
        case "com1.danfe": result = await service.danfe(identified); break;
        case "com1.xml": result = await service.xml(identified); break;
        case "com1.cancel": result = await service.cancel(identified as unknown as PublicCancellationInput); break;
        case "com1.cancel.xml": result = await service.cancellationXml(identified); break;
        default: throw new ApiError(404, "not_found", "Operação fiscal não encontrada.");
      }
      if (result instanceof Response) {
        const headers = new Headers(result.headers);
        for (const [key, value] of Object.entries(PRIVATE_HEADERS)) headers.set(key, value);
        return new Response(result.body, { status: result.status, headers });
      }
      const dto = commercialNfePublicDto(context, result);
      const blocked = (result as Partial<EmissionView>).status === "bloqueada" ||
        context.operation.name === "com1.prepare" && (result as PreparationResult).blockers.length > 0;
      return Response.json(dto, { status: blocked ? 422 : awaiting(result) ? 202 : 200, headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof ApiError || error instanceof CommercialNfeError) return Response.json({ code: error.code, message: error.message }, { status: error.status, headers: PRIVATE_HEADERS });
      if (error instanceof ErpError) {
        const status = ["fiscal_blocked", "com1_emission_blocked", "com1_preparation_blocked"].includes(error.message) ? 422
          : error.code === "42501" ? 403 : error.code === "22023" ? 400 : error.code === "P0002" ? 404 : 409;
        return Response.json({ code: /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : "fiscal_operation_failed",
          message: "Não foi possível concluir a operação fiscal. Consulte a emissão e revise os dados." }, { status, headers: PRIVATE_HEADERS });
      }
      return Response.json({ code: "fiscal_service_unavailable", message: "O serviço não concluiu a operação. Consulte a mesma emissão antes de tentar novamente." },
        { status: 503, headers: PRIVATE_HEADERS });
    }
  };
}
