import { ApiError } from "../../types";
import { createPiiMask } from "../../pii-mask";
import { ErpError } from "../engine/errors.ts";
import { CommercialNfeError } from "./artifacts.ts";
import { createCommercialNfeBridge } from "./bridge.ts";
import { createCommercialNfeService, freezeCommercialVaultSession } from "./service.ts";
import { emissorConnection, emissorView, fiscalConnectionFingerprint } from "../emissor/config.ts";
import { fiscalProviderFor } from "../emissor/index.ts";
import type { CommercialConnectionCheck } from "../domains/fiscal/comnfe/settings.ts";
import type { CommercialNfeHttpContext } from "./routes.ts";
import type { CommercialNfeHttpHandler } from "./slots.ts";
import { createNfceService, type NfceService, type NfceVaultStatus } from "./nfce-service.ts";
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
  /** Cupom do balcão (NFC-e); ausente, as operações nfce.* recusam como não habilitadas. */
  nfce?(context: CommercialNfeHttpContext): NfceService | Promise<NfceService>;
}

/** O que o último "Testar conexão" trouxe do cofre para a NFC-e (sem nova ida ao cofre). */
export async function nfceVaultStatus(context: CommercialNfeHttpContext): Promise<NfceVaultStatus> {
  const view = await emissorView(context.env, context.profile), checked = view.checked;
  const state = checked?.ok ? checked.state : null;
  const issuer = state?.certificate?.document?.kind === "cnpj" ? state.certificate.document.id.replace(/[.\/\-\s]/g, "").toUpperCase() : null;
  return { configured: !!view.configured && !!checked?.ok, checked_at: checked?.at ?? null, ufs: state ? state.documents.nfce : null,
    series: (checked?.ok ? checked.series ?? [] : []).filter(item => item.kind === "nfce" && (!item.cnpj || !issuer || item.cnpj === issuer))
      .map(item => ({ environment: item.environment, series: item.series, next_number: (item as { next_number?: number }).next_number ?? null })),
    contingency_pending: state?.contingency?.pending_notes ?? null, certificate_days_left: state?.certificate?.days_left ?? null,
    environments: state ? [...state.key.environments] : [] };
}

/** Prova pública do último Testar conexão; nenhuma chamada ao cofre na transação. */
export async function commercialConnectionCheck(context: CommercialNfeHttpContext): Promise<CommercialConnectionCheck | null> {
  const view = await emissorView(context.env, context.profile), checked = view.checked;
  const certificate = checked?.state?.certificate;
  if (!view.configured || view.provider !== "nfapi" || !view.url || !checked?.ok || !checked.state ||
      certificate?.document?.kind !== "cnpj" || !checked.contract?.vault) return null;
  const issuer = certificate.document.id.replace(/[.\/\-\s]/g, "").toUpperCase();
  return { fingerprint: await fiscalConnectionFingerprint({ provider: "nfapi", url: view.url, issuer_document: issuer }),
    provider: "nfapi", origin: view.url, issuer_cnpj: issuer, version: checked.contract.vault,
    checked_at: String(BigInt(checked.at) * 1000n), compatible: checked.contract.compatible === true,
    // O motor confere os dados atuais da empresa sob a mesma transação da configuração.
    company_matches: false, company_complete: false,
    environments: [...checked.state.key.environments],
    series: (checked.series ?? []).filter(series => series.kind === "nfe" && (!series.cnpj || series.cnpj === issuer))
      .map(series => ({ environment: series.environment, series: series.series })) };
}

/** Montagem de produção; testes podem substituir somente as portas de I/O. */
export function createDefaultCommercialNfeHttp(): CommercialNfeHttpHandler {
  const services = new WeakMap<CommercialNfeHttpContext, ReturnType<typeof build>>();
  const build = (context: CommercialNfeHttpContext) => {
    const bridge = createCommercialNfeBridge(context, { connection: commercialConnectionCheck });
    return { bridge, service: defaultService(context, bridge) };
  };
  const once = (context: CommercialNfeHttpContext) => { let built = services.get(context); if (!built) { built = build(context); services.set(context, built); } return built; };
  return createCommercialNfeHttp({ service: context => once(context).service,
    nfce: context => { const { bridge, service } = once(context); return createNfceService({ bridge, base: service, vaultStatus: () => nfceVaultStatus(context) }); } });
}

function defaultService(context: CommercialNfeHttpContext, bridge: ReturnType<typeof createCommercialNfeBridge>) {
  return createCommercialNfeService(context, {
    bridge,
    vault: async emission => {
      const connection = await emissorConnection(context.env, context.profile);
      const checked = await commercialConnectionCheck(context);
      if (!connection || !checked) throw new CommercialNfeError(409, "fiscal_provider_not_configured", "Teste e confira a conexão do cofre antes de continuar.");
      if (!checked.compatible) throw new CommercialNfeError(409, "fiscal_provider_incompatible", "A versão do cofre não é compatível com esta integração.");
      if (!checked.environments.includes(emission.environment))
        throw new CommercialNfeError(409, "fiscal_environment_not_allowed", "A chave do cofre não permite o ambiente desta emissão.");
      if (connection.url !== checked.origin || connection.provider !== checked.provider)
        throw new CommercialNfeError(409, "fiscal_connection_changed", "Confira a conexão original desta emissão.");
      return freezeCommercialVaultSession(context, emission, {
        provider: await fiscalProviderFor({ env: context.env, profile: context.profile }),
        fingerprint: checked.fingerprint, connection,
      });
    },
  });
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
const personalKey = /^(?:nome|name|legal_name|trade_name|fantasia|email|nfe_email|phone|mobile|telefone|celular|cpf|cnpj|tax_id|document|issuer_cnpj|endereco|endereço|address|street|logradouro|bairro|district|complement|complemento|postal_code|cep|ie|state_registration|inscricaoEstadual|inscricaoMunicipal|contact_name|recipient_name|carrier_name)$/i;
const addressKey = /^(?:endereco|endereço|address)$/i;
const technicalKey = /^(?:id|.*_id|.*_ids|.*_hash|.*_fingerprint|reference|protocol|access_key|code|field|screen|entity|source|status|state|environment|.*_at)$/i;
const PRIVATE_VALUE = "[dado pessoal oculto]";

/** Mensagens e observações podem repetir dados de cadastros. Recolher antes
 * da projeção também protege a listagem, que não leva o snapshot ao cliente. */
function knownPersonalTextMask(value: unknown): (text: string) => string {
  const patterns = new Set<string>();
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const remember = (raw: string) => {
    const text = raw.trim();
    // Números curtos de endereço não viram regras globais para valores fiscais.
    if (text.length < 2 || /^\d{1,3}$/.test(text)) return;
    patterns.add(escape(text).replace(/\s+/g, "\\s+"));
    const document = text.toUpperCase().replace(/[.\-/\s]/g, "");
    if (/^[A-Z0-9]{12}\d{2}$/.test(document)) {
      patterns.add(escape(document));
      patterns.add(`${escape(document.slice(0, 2))}\\.\\s*${escape(document.slice(2, 5))}\\.\\s*${escape(document.slice(5, 8))}\\/\\s*${escape(document.slice(8, 12))}-\\s*${document.slice(12)}`);
    }
  };
  const visit = (item: unknown, depth = 0, privateAddress = false): void => {
    if (depth > 24 || !item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(entry => visit(entry, depth + 1, privateAddress)); return; }
    for (const [key, entry] of Object.entries(item)) {
      if (secretKey.test(key)) continue;
      if (typeof entry === "string" && (privateAddress || personalKey.test(key))) remember(entry);
      else visit(entry, depth + 1, privateAddress || addressKey.test(key));
    }
  };
  visit(value);
  if (!patterns.size) return text => text;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...patterns].sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text => text.replace(pattern, PRIVATE_VALUE);
}
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
  const maskKnown = masked ? knownPersonalTextMask(value) : (text: string) => text;
  const clean = (item: unknown, depth = 0, key = "", privateAddress = false): unknown => {
    if (depth > 24) return null;
    if (typeof item === "string") {
      if (masked && (privateAddress || personalKey.test(key))) return PRIVATE_VALUE;
      const text = item.replace(/\b(?:wab[ul]?_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g, "[oculto]");
      return technicalKey.test(key) ? text : maskKnown(text);
    }
    if (Array.isArray(item)) return item.map(entry => clean(entry, depth + 1, key, privateAddress));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).filter(([childKey]) => !secretKey.test(childKey)).map(([childKey, entry]) =>
      [childKey, clean(entry, depth + 1, childKey, privateAddress || addressKey.test(childKey))]));
  };
  return createPiiMask(masked).maskValue(clean(dto));
}

const awaiting = (value: unknown): boolean => {
  const result = value as Partial<EmissionView> | null;
  return !!result && (["enviando", "processando", "incerta"].includes(result.status ?? "") ||
    !!result.cancellation && ["pedido", "enviando", "incerto"].includes(result.cancellation.state));
};

/** Causas conhecidas do cupom, em palavras: o que aconteceu e o que fazer. */
export const NFCE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  com1_not_ready: "O cupom fiscal ainda não está habilitado nesta instalação. A venda continua sem cupom.",
  module_disabled: "O cupom fiscal depende das partes Caixa / PDV e Fiscal ligadas. Peça ao administrador para ligá-las em Gestão → Módulos.",
  fiscal_forbidden: "Seu papel não permite esta operação do cupom fiscal.",
  erp_pos_access_denied: "Seu vendedor não tem o módulo Frente de Caixa.",
  erp_pos_not_found: "Venda do caixa não encontrada ou sem acesso.",
  nfce_sale_not_finished: "Só a venda finalizada no caixa recebe cupom fiscal.",
  fiscal_consumer_document_invalid: "O CPF ou CNPJ do consumidor não confere. Confira os dígitos ou deixe em branco.",
  fiscal_emission_open: "A venda já tem nota fiscal emitida ou em andamento. Consulte a nota antes de pedir outra.",
  fiscal_environment_conflict: "Esta venda já foi usada em outro ambiente fiscal. Faça uma venda nova.",
  com1_version_conflict: "O cupom foi atualizado em outra tela. Atualize a lista e tente de novo.",
  com1_physical_return_required: "Confirme que a mercadoria voltou para a loja: só assim o estoque da venda é estornado.",
  com1_effect_requires_cancellation: "O cupom ainda não foi cancelado no cofre. Cancele o cupom antes da venda.",
  erp_pos_reverse_stock_denied: "O cupom foi cancelado, mas seu papel não estorna o estoque. Peça ao administrador ou ao estoque para cancelar a venda.",
  erp_pos_reverse_finance_denied: "O cupom foi cancelado, mas seu papel não estorna as contas. Peça ao administrador ou ao financeiro para cancelar a venda.",
  erp_pos_finish_denied: "O cupom foi cancelado, mas seu vendedor não pode cancelar venda finalizada.",
  erp_pos_sale_has_returns: "O cupom foi cancelado, mas a venda tem devolução registrada e não pode ser cancelada.",
  erp_pos_sale_invoice_linked: "A venda tem nota fiscal vigente: cancele a nota primeiro.",
  fiscal_config_conflict: "A configuração do cupom mudou em outra tela. Atualize e salve de novo.",
  fiscal_nature_missing: "Escolha uma natureza de operação de venda ativa para o cupom.",
  fiscal_provider_not_configured: "Configure o endereço e a chave do cofre e use Testar conexão.",
});

async function handleNfce(context: CommercialNfeHttpContext, nfce: NfceService): Promise<unknown> {
  const input = context.input, id = context.params.id!;
  switch (context.operation.name) {
    case "nfce.config.get": return nfce.config();
    case "nfce.config.save": return nfce.saveConfig(input as { command_id: string; expected_version: number; nature_id: string | null });
    case "nfce.sales": return nfce.sales({
      ...(input.environment === undefined ? {} : { environment: input.environment as "homologacao" | "producao" }),
      ...(input.cash_session_id === undefined ? {} : { cash_session_id: String(input.cash_session_id) }),
      ...(input.from === undefined ? {} : { from: String(input.from) }), ...(input.to === undefined ? {} : { to: String(input.to) }),
      ...(input.pending_only === undefined ? {} : { pending_only: input.pending_only === "true" }),
      ...(input.page === undefined ? {} : { page: Number(input.page) }), ...(input.per_page === undefined ? {} : { per_page: Number(input.per_page) }) });
    case "nfce.get": return nfce.get(id);
    case "nfce.emit": return nfce.emit(id, String(input.command_id), typeof input.consumer_document === "string" && input.consumer_document.trim() ? input.consumer_document.trim() : null);
    case "nfce.consult": return nfce.consult(id, String(input.command_id));
    case "nfce.cancel": return nfce.cancel(id, String(input.command_id), String(input.justification).trim(), input.physical_return_confirmed === true);
    case "nfce.coupon": return nfce.coupon(id, input.via === "estabelecimento" ? "establishment" : "consumer");
    default: throw new ApiError(404, "not_found", "Operação do cupom fiscal não encontrada.");
  }
}

/** Instalar com installCommercialNfeHttp; não altera registros de produção ao importar. */
export function createCommercialNfeHttp(dependencies: CommercialNfeHttpDependencies): CommercialNfeHttpHandler {
  return async context => {
    const counter = context.operation.name.startsWith("nfce.");
    try {
      if (counter) {
        if (!dependencies.nfce) throw new ErpError("0A000", "com1_not_ready");
        const result = await handleNfce(context, await dependencies.nfce(context));
        if (result instanceof Response) {
          const headers = new Headers(result.headers);
          for (const [key, value] of Object.entries(PRIVATE_HEADERS)) headers.set(key, value);
          return new Response(result.body, { status: result.status, headers });
        }
        const masked = !!(context.actor.via || context.identity.actor?.is_agent || context.identity.actor?.is_technical) && context.actor.via?.masked !== false;
        return Response.json(createPiiMask(masked).maskValue(result), { headers: PRIVATE_HEADERS });
      }
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
      if (counter && (error instanceof ApiError || error instanceof CommercialNfeError || error instanceof ErpError)) {
        const code = error instanceof ErpError ? (/^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : "fiscal_operation_failed") : error.code;
        const status = error instanceof ErpError ? (error.code === "42501" ? 403 : error.code === "22023" ? 400 : error.code === "P0002" ? 404 : 409) : error.status;
        return Response.json({ code, message: NFCE_MESSAGES[code] ?? (error instanceof ErpError ? "O cupom fiscal não pôde ser concluído. Consulte a venda na lista de cupons pendentes." : error.message) },
          { status, headers: PRIVATE_HEADERS });
      }
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
