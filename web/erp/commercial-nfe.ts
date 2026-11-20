/** Cliente do percurso comercial. O corpo fiscal e seus resultados vêm do servidor. */
import type {
  CommercialSettings, ConfigSaveInput, EffectInput, EffectView, PublicEmissionPage,
  EmissionView, PublicEmissionSummary, FiscalBlocker, ListInput, PreparationResult, PrepareInput,
} from "../../src/erp/commercial-nfe/contracts.ts";

export type { ConfigSaveInput, EffectInput, EffectView, EmissionView, FiscalBlocker, PrepareInput };
export interface CommercialNfeConfig extends CommercialSettings { checklist?: { code: string; message: string }[] }
export interface EmitInput { emission_id: string; command_id: string; expected_version: number; body_revision: number; body_hash: string }
export type ResumeInput = Omit<EmitInput, "body_hash">;
export interface CancelInput { emission_id: string; command_id: string; expected_version: number; justification: string }
export type CommercialNfeAction = "read" | "configure" | "prepare" | "emit" | "resume" | "cancel" | "effect_stock" | "effect_finance";
export type CommercialNfeArtifact = "danfe" | "xml" | "cancellation_xml";
export interface CommercialNfeAccess {
  ready: boolean;
  role: string | null;
  /** Null significa todas as permissões do papel, conforme o contrato do ERP. */
  permissions: readonly string[] | null;
  demo?: boolean;
  parts: { base: boolean; products: boolean; sales: boolean; fiscal: boolean; stock: boolean; finance: boolean };
}
export interface CommercialNfePort {
  readonly scopeKey: string;
  access(): CommercialNfeAccess;
  config(signal?: AbortSignal): Promise<CommercialNfeConfig>;
  saveConfig(input: ConfigSaveInput, signal?: AbortSignal): Promise<CommercialNfeConfig>;
  prepare(input: PrepareInput, signal?: AbortSignal): Promise<PreparationResult>;
  list(input: ListInput, signal?: AbortSignal): Promise<PublicEmissionPage>;
  read(emissionId: string, signal?: AbortSignal): Promise<EmissionView>;
  emit(input: EmitInput, signal?: AbortSignal): Promise<EmissionView>;
  resume(input: ResumeInput, signal?: AbortSignal): Promise<EmissionView>;
  cancel(input: CancelInput, signal?: AbortSignal): Promise<EmissionView>;
  effects(input: EffectInput, signal?: AbortSignal): Promise<EffectView>;
  /** Blob obtido pelo vínculo da emissão; nunca renderização local de DANFE. */
  artifact(emissionId: string, kind: CommercialNfeArtifact, signal?: AbortSignal): Promise<Blob>;
}

const closedAccess: CommercialNfeAccess = { ready: false, role: null, permissions: [],
  parts: { base: false, products: false, sales: false, fiscal: false, stock: false, finance: false } };
const policies: Record<CommercialNfeAction, { roles: string[]; permission: string }> = {
  read: { roles: ["admin", "consulta", "fiscal"], permission: "vendas.notas_fiscais" },
  configure: { roles: ["admin"], permission: "outros.dados_empresa.gerenciar" },
  prepare: { roles: ["admin", "fiscal"], permission: "vendas.notas_fiscais.ie" },
  emit: { roles: ["admin", "fiscal"], permission: "vendas.notas_fiscais.ie" },
  resume: { roles: ["admin", "fiscal"], permission: "vendas.notas_fiscais.ie" },
  cancel: { roles: ["admin", "fiscal"], permission: "vendas.notas_fiscais.ie" },
  effect_stock: { roles: ["admin", "estoque"], permission: "suprimentos.controle_estoque.insercao" },
  effect_finance: { roles: ["admin", "financeiro"], permission: "financas.contas_receber.ie" },
};
/** Visibilidade da ação. O servidor revalida o papel e a política sensível
 * requireCom1SensitivePolicy, inclusive confirmação ou concessão de bots. */
export function canCommercialNfe(access: CommercialNfeAccess, action: CommercialNfeAction): boolean {
  const policy = policies[action];
  const segments = policy.permission.split("."), parent = segments.length > 2 ? segments.slice(0, 2).join(".") : null;
  return access.ready && !access.demo && access.parts.base && access.parts.fiscal &&
    policy.roles.includes(access.role ?? "") &&
    (access.role === "admin" || access.permissions === null || access.permissions.includes(policy.permission) && (!parent || access.permissions.includes(parent))) &&
    (!["prepare", "emit"].includes(action) || access.parts.products && access.parts.sales);
}

export class CommercialNfeError extends Error {
  status: number;
  code: string;
  blockers: FiscalBlocker[];
  uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; blockers?: FiscalBlocker[]; uncertain?: boolean } = {}) {
    super(message); this.name = "CommercialNfeError";
    this.status = options.status ?? 0; this.code = options.code ?? "fiscal_request_failed";
    this.blockers = options.blockers ?? []; this.uncertain = options.uncertain ?? false;
  }
}
const aborted = () => new DOMException("O contexto desta área foi encerrado.", "AbortError");
const invalidResponse = () => new CommercialNfeError("O servidor retornou dados fiscais incompletos. Consulte a mesma emissão antes de continuar.",
  { status: 502, code: "fiscal_invalid_response", uncertain: true });
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const environments = ["homologacao", "producao"];
const states = ["bloqueada", "preparada", "enviando", "processando", "incerta", "rejeitada", "autorizada", "denegada", "cancelada", "arquivada"];
const isBlocker = (value: unknown): value is FiscalBlocker => object(value) &&
  [value.code, value.field, value.message].every(text => typeof text === "string") &&
  object(value.correction) && typeof value.correction.screen === "string";
const blockers = (value: unknown): value is FiscalBlocker[] => Array.isArray(value) && value.every(isBlocker);
const messages = (value: unknown) => Array.isArray(value) && value.every(item => object(item) && typeof item.code === "string" && typeof item.description === "string");
const nullableTimestamp = (value: unknown) => value === null || typeof value === "string" && /^\d+$/.test(value);
const nullableSeries = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 889;
function checkEffect(value: unknown, emissionId?: string): EffectView {
  if (!object(value) || !uuid(value.emission_id) || emissionId && value.emission_id !== emissionId ||
    !["stock", "finance"].includes(value.axis) || !["aplicado", "reconhecido", "pendente", "pulado"].includes(value.state) ||
    !["estoque", "financeiro", "admin"].includes(value.responsible_role) || !object(value.ids) ||
    ![null, "pendente", "revertido", "compensacao_pendente", "transferido"].includes(value.compensation_state)) throw invalidResponse();
  return value as EffectView;
}
function validateEmission(value: unknown, emissionId?: string, summary = false): Record<string, any> {
  if (!object(value) || !uuid(value.id) || emissionId && value.id !== emissionId || !uuid(value.document_id) ||
    !positiveInteger(value.version) || !positiveInteger(value.fiscal_version) || value.fiscal_version > 9999 ||
    !states.includes(value.status) || !environments.includes(value.environment) ||
    value.reference !== `wb.${value.document_id}.v${value.fiscal_version}` || !positiveInteger(value.current_body_revision) ||
    !object(value.revision) || value.revision.emission_id !== value.id || value.revision.body_revision !== value.current_body_revision ||
    !positiveInteger(value.revision.source_document_version) || !blockers(value.revision.blockers) ||
    !Array.isArray(value.effects) || !messages(value.messages)) throw invalidResponse();
  if (!summary) {
    const snapshot = value.revision.snapshot;
    if (!object(value.revision.calculation) || !object(snapshot) ||
      !["document", "company", "recipient", "nature", "transport"].every(key => object(snapshot[key])) ||
      !["items", "products", "payments", "sources"].every(key => Array.isArray(snapshot[key]))) throw invalidResponse();
  }
  if (["autorizada", "cancelada"].includes(value.status) && (value.environment_confirmed !== true ||
    typeof value.provider_id !== "string" || !value.provider_id || !/^\d{44}$/.test(value.access_key ?? "") ||
    typeof value.protocol !== "string" || !value.protocol || !positiveInteger(value.number) ||
    !Number.isSafeInteger(value.series) || value.series < 0 || value.series > 889)) throw invalidResponse();
  value.effects.forEach((effect: unknown) => checkEffect(effect, value.id));
  if (value.cancellation !== null && (!object(value.cancellation) || value.cancellation.emission_id !== value.id ||
    !["pedido", "enviando", "incerto", "recusado", "registrado"].includes(value.cancellation.state) ||
    !["pendente", "disponivel"].includes(value.cancellation.xml_status) || typeof value.cancellation.justification !== "string" ||
    !messages(value.cancellation.messages))) throw invalidResponse();
  return value;
}
export const checkEmission = (value: unknown, emissionId?: string): EmissionView => validateEmission(value, emissionId) as EmissionView;
export const checkEmissionSummary = (value: unknown): PublicEmissionSummary => validateEmission(value, undefined, true) as PublicEmissionSummary;
function checkConfig(value: unknown): CommercialNfeConfig {
  if (!object(value) || value.id !== 1 || !positiveInteger(value.version) || !environments.includes(value.environment) ||
    !["existing", "on_authorization"].includes(value.stock_timing) || !["existing", "on_authorization"].includes(value.finance_timing) ||
    !nullableSeries(value.series_homologacao) || !nullableSeries(value.series_producao) ||
    !["production_enabled_at", "tax_limits_acknowledged_at", "updated_at"].every(key => nullableTimestamp(value[key])) ||
    !["production_enabled_by", "tax_limits_acknowledged_by", "updated_by"].every(key => value[key] === null || typeof value[key] === "string") ||
    (value.connection_fingerprint !== null && (typeof value.connection_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.connection_fingerprint))) ||
    (value.connection_public !== null && !object(value.connection_public)) ||
    (value.environment === "producao" && (!value.production_enabled_at || !value.production_enabled_by || !value.tax_limits_acknowledged_at)) ||
    (value.checklist !== undefined && (!Array.isArray(value.checklist) || !value.checklist.every((item: unknown) =>
      object(item) && typeof item.code === "string" && typeof item.message === "string")))) throw invalidResponse();
  if (value.connection_public !== null) {
    const connection = value.connection_public;
    let url: URL;
    try { url = new URL(connection.origin); } catch { throw invalidResponse(); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      connection.provider !== "nfapi" || typeof connection.issuer_cnpj !== "string" || typeof connection.version !== "string" ||
      typeof connection.compatible !== "boolean" || !nullableTimestamp(connection.checked_at) || connection.checked_at === null ||
      !Array.isArray(connection.environments) || !connection.environments.every((item: unknown) => typeof item === "string" && environments.includes(item)) ||
      !Array.isArray(connection.series) || !connection.series.every((item: unknown) => object(item) && environments.includes(item.environment) && item.series !== null && nullableSeries(item.series))) throw invalidResponse();
  }
  return value as CommercialNfeConfig;
}

export function emissionCanEmit(emission: EmissionView, access: CommercialNfeAccess): boolean {
  return canCommercialNfe(access, "emit") && emission.status === "preparada" &&
    emission.revision.blockers.length === 0 && emission.revision.body !== null &&
    /^[0-9a-f]{64}$/.test(emission.revision.body_hash ?? "") &&
    emission.current_body_revision === emission.revision.body_revision;
}

/** Apenas destinos locais conhecidos; nunca transformar screen em URL arbitrária. */
export function correctionTarget(blocker: FiscalBlocker, documentId?: string): string {
  const { screen, field } = blocker.correction;
  const targets: Record<string, string> = {
    company: "/empresa-configuracoes", issuer: "/empresa-configuracoes", company_identity: "/empresa-configuracoes", company_fiscal: "/empresa-configuracoes",
    contacts: "/cadastros-reais?cadastro=contacts", recipient: "/cadastros-reais?cadastro=contacts",
    products: "/cadastros-reais?cadastro=products", product: "/cadastros-reais?cadastro=products",
    natures: "/naturezas-operacao", nature: "/naturezas-operacao", taxes: "/naturezas-operacao", fiscal_natures: "/naturezas-operacao", operation_natures: "/naturezas-operacao",
    fiscal_parameters: "/naturezas-operacao?tela=impostos", payment_methods: "/formas-pagamento-empresa",
    settings: "/certificado-a1", emissor: "/certificado-a1", fiscal_settings: "/certificado-a1",
    documents: "/documentos-empresa?tipo=sales_orders", order: "/documentos-empresa?tipo=sales_orders", sales_orders: "/documentos-empresa?tipo=sales_orders",
    payments: "/documentos-empresa?tipo=sales_orders", transport: "/documentos-empresa?tipo=sales_orders",
  };
  // As fontes usam company, contacts, products, sales_orders, fiscal_natures,
  // fiscal_parameters e fiscal_settings; aliases preservam revisões anteriores.
  // Códigos conhecidos oferecem um destino seguro para revisões mais antigas.
  const fallback = /issuer|company/.test(blocker.code) || /municipality/.test(blocker.code) && /company|issuer|emitente/.test(blocker.field) ? "company"
    : /recipient|municipality/.test(blocker.code) ? "contacts"
    : /cfop|nature|tax_data|operation_unsupported|reform/.test(blocker.code) ? "natures"
    : /product/.test(blocker.code) ? "products"
    : /total|payment|transport|order|source_changed|environment_conflict/.test(blocker.code) ? "documents" : "settings";
  const target = targets[screen] ?? targets[fallback];
  const [path, query] = target.split("?"); const params = new URLSearchParams(query);
  const id = blocker.correction.id ?? (path === "/documentos-empresa" ? documentId : blocker.entity_id);
  if (id) params.set(path === "/documentos-empresa" ? "documento" : path === "/naturezas-operacao" ? "natureza" : "registro", id);
  if (field) params.set("campo", field);
  return path + (params.size ? `?${params}` : "");
}

export interface CommercialNfePortOptions {
  scopeKey?: string;
  fetch?: typeof fetch;
  access?: () => CommercialNfeAccess;
  /** O runtime troca este sinal em cada revisão e o encerra na troca de área. */
  scope?: () => AbortSignal;
}
export function createCommercialNfePort(profile: string, options: CommercialNfePortOptions = {}): CommercialNfePort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe`;
  const access = options.access ?? (() => closedAccess);
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const pathId = (id: string) => { if (!uuid(id)) throw new CommercialNfeError("Identificador fiscal inválido.", { status: 400, code: "fiscal_invalid_request" }); return encodeURIComponent(id); };
  async function request(action: CommercialNfeAction, path: string, method: "GET" | "POST" | "PUT", body: object | undefined, caller?: AbortSignal, file?: CommercialNfeArtifact): Promise<unknown> {
    const scope = options.scope?.(), before = access();
    const signal = AbortSignal.any([...(scope ? [scope] : []), ...(caller ? [caller] : [])]);
    const ensure = () => { if (signal.aborted) throw aborted(); };
    ensure();
    if (!canCommercialNfe(before, action)) throw new CommercialNfeError(before.demo ? "A demonstração não emite notas nem grava configurações." : "Seu acesso ou as partes ligadas não permitem esta operação fiscal.", { status: 403, code: "fiscal_forbidden" });
    const authority = JSON.stringify(before);
    const assertCurrent = () => { ensure(); if (authority !== JSON.stringify(access())) throw aborted(); };
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, { method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: file === "danfe" ? "application/pdf" : file ? "application/xml" : "application/json",
          ...(body ? { "Content-Type": "application/json", "Idempotency-Key": String((body as { command_id?: string }).command_id ?? "") } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      assertCurrent();
    } catch (error) {
      assertCurrent();
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new CommercialNfeError(method === "GET" ? "Não foi possível consultar o servidor." : "A resposta não chegou. O resultado pode ter sido registrado; consulte e retome a mesma emissão.",
        { code: "fiscal_response_lost", uncertain: method !== "GET" });
    }
    if (file && response.ok && response.status !== 202) {
      const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (file === "danfe" ? type !== "application/pdf" : !["application/xml", "text/xml"].includes(type ?? "")) throw invalidResponse();
      let result: Blob;
      try { result = await response.blob(); }
      catch { assertCurrent(); throw new CommercialNfeError("O download do arquivo foi interrompido. Consulte o mesmo documento no cofre.", { code: "fiscal_file_interrupted" }); }
      assertCurrent(); if (result.size === 0) throw invalidResponse(); return result;
    }
    let value: unknown;
    try { value = await response.json(); } catch { assertCurrent(); throw invalidResponse(); }
    assertCurrent();
    const blockedPreparation = action === "prepare" && response.status === 422 && object(value) &&
      object(value.emission) && blockers(value.blockers) && Array.isArray(value.effects_preview);
    if ((!response.ok && !blockedPreparation) || file) {
      const detail = object(value) && object(value.error) ? value.error : object(value) ? value : {};
      throw new CommercialNfeError(typeof detail.message === "string" ? detail.message : "Não foi possível concluir a operação fiscal.", {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "fiscal_request_failed",
        blockers: blockers(detail.blockers) ? detail.blockers : [], uncertain: response.status === 202 || response.status === 408 || response.status >= 500,
      });
    }
    return value;
  }
  const pick = (input: object, fields: string[]) => Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, (input as Record<string, unknown>)[field]]));
  return {
    scopeKey: options.scopeKey ?? profile,
    access,
    config: async signal => checkConfig(await request("read", "config", "GET", undefined, signal)),
    saveConfig: async (input, signal) => checkConfig(await request("configure", "config", "PUT", pick(input,
      ["command_id", "expected_version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "acknowledge_tax_limits", "enable_production"]), signal)),
    async prepare(input, signal) {
      const body = { ...pick(input, ["command_id", "expected_document_version", "new_fiscal_version", "expected_emission_version"]),
        choices: pick(input.choices, ["nature_id", "presence", "final_consumer", "series"]) };
      const value = await request("prepare", `pedidos/${pathId(input.document_id)}/preparar`, "POST", body, signal);
      if (!object(value) || !blockers(value.blockers) || !Array.isArray(value.effects_preview) || typeof value.replayed !== "boolean") throw invalidResponse();
      const emission = checkEmission(value.emission);
      if (emission.document_id !== input.document_id || JSON.stringify(value.blockers) !== JSON.stringify(emission.revision.blockers)) throw invalidResponse();
      value.effects_preview.forEach((effect: unknown) => checkEffect(effect, emission.id));
      return value as PreparationResult;
    },
    async list(input, signal) {
      const query = new URLSearchParams(Object.entries(pick(input, ["environment", "document_id", "status", "page", "per_page"]))
        .filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      const value = await request("read", `emissoes?${query}`, "GET", undefined, signal);
      if (!object(value) || !Array.isArray(value.items) || !positiveInteger(value.page) || !positiveInteger(value.per_page) || !Number.isSafeInteger(value.total) || value.total < 0) throw invalidResponse();
      for (const item of value.items) { const emission = checkEmissionSummary(item); if (emission.environment !== input.environment || input.document_id && emission.document_id !== input.document_id) throw invalidResponse(); }
      return value as PublicEmissionPage;
    },
    read: async (id, signal) => checkEmission(await request("read", `emissoes/${pathId(id)}`, "GET", undefined, signal), id),
    emit: async (input, signal) => checkEmission(await request("emit", `emissoes/${pathId(input.emission_id)}/emitir`, "POST",
      pick(input, ["command_id", "expected_version", "body_revision", "body_hash"]), signal), input.emission_id),
    resume: async (input, signal) => checkEmission(await request("resume", `emissoes/${pathId(input.emission_id)}/retomar`, "POST",
      pick(input, ["command_id", "expected_version", "body_revision"]), signal), input.emission_id),
    cancel: async (input, signal) => checkEmission(await request("cancel", `emissoes/${pathId(input.emission_id)}/cancelar`, "POST",
      pick(input, ["command_id", "expected_version", "justification"]), signal), input.emission_id),
    effects: async (input, signal) => checkEffect(await request(input.axis === "stock" ? "effect_stock" : "effect_finance", `emissoes/${pathId(input.emission_id)}/efeitos`, "POST",
      pick(input, ["command_id", "expected_version", "axis", "intent", "physical_return_confirmed"]), signal), input.emission_id),
    artifact: async (id, kind, signal) => request("read", `emissoes/${pathId(id)}/${kind === "cancellation_xml" ? "cancelamento/xml" : kind}`, "GET", undefined, signal, kind) as Promise<Blob>,
  };
}

/** Uma intenção mantém os mesmos argumentos e UUID, inclusive após erro de
 * transporte. Reset é explícito e só deve ocorrer depois de resultado conclusivo. */
export function createCommandIntent(newId: () => string = () => crypto.randomUUID()) {
  let saved: { key: string; input: object; id: string } | null = null;
  let pending: Promise<unknown> | null = null;
  return {
    get commandId() { return saved?.id ?? null; },
    get pending() { return pending !== null; },
    run<T extends object, R>(args: T, send: (input: T & { command_id: string }) => Promise<R>): Promise<R> {
      const key = JSON.stringify(args);
      if (saved && key !== saved.key) return Promise.reject(new CommercialNfeError("O comando em andamento tem outros dados. Consulte o resultado antes de iniciar outra intenção.", { status: 409, code: "fiscal_command_conflict" }));
      if (!saved) { const id = newId(); saved = { key, id, input: structuredClone({ ...args, command_id: id }) }; }
      if (pending) return pending as Promise<R>;
      const input = structuredClone(saved.input) as T & { command_id: string };
      pending = Promise.resolve().then(() => send(input));
      const result = pending as Promise<R>;
      void result.finally(() => { if (pending === result) pending = null; }).catch(() => undefined);
      return result;
    },
    reset() { if (pending) throw new CommercialNfeError("Aguarde o comando em andamento.", { status: 409, code: "fiscal_command_pending" }); saved = null; },
  };
}
