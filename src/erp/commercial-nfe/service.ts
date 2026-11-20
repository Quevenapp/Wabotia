import { createHash, randomUUID } from "node:crypto";
import type { FiscalProvider, FiscalResult } from "../emissor/provider.ts";
import type { CommercialNfeHttpContext } from "./routes.ts";
import type { CommercialNfeBridge } from "./bridge.ts";
import type {
  CancelRecordInput, ClaimResult, CommandReceipt, ConfigSaveInput, EffectInput, EmissionView,
  JsonObject, JsonValue, ListInput, PrepareInput, ReadInput, RecordInput,
} from "./contracts.ts";
import {
  commercialArtifact, commercialLookupIdentity, matchesCommercialResult, parseCancellationXml, privateFiscalFile,
  requireVaultBinding, CommercialNfeError as ApiError, type CommercialVaultSession,
} from "./artifacts.ts";

export interface CommercialEmitInput extends ReadInput {
  command_id: string; expected_version: number; body_revision: number; body_hash: string;
}
export type CommercialResumeInput = Omit<CommercialEmitInput, "body_hash">;
export interface CommercialCancelInput extends ReadInput { command_id: string; expected_version: number; justification: string }
export interface CommercialNfeServiceDependencies {
  bridge: CommercialNfeBridge;
  /** Resolve no servidor e captura conexão/credencial. Nunca aceita configuração do navegador. */
  vault(emission: EmissionView): Promise<CommercialVaultSession>;
  uuid?: () => string;
}

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const fail = (code: string, message: string): never => { throw new ApiError(409, code, message); };

/**
 * Adapta o provedor existente sem permitir que uma rotação/troca de configuração
 * redirecione uma operação aberta. Captura a chave somente na closure; ela nunca
 * entra no ERP. O adaptador da conexão calcula/confere o fingerprint público.
 */
export function freezeCommercialVaultSession(context: CommercialNfeHttpContext, emission: EmissionView, options: {
  provider: FiscalProvider; fingerprint: string; connection: { url: string; api_key: string }; fetch?: typeof fetch;
}): CommercialVaultSession {
  const url = new URL(options.connection.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !options.connection.api_key)
    fail("fiscal_provider_not_configured", "Confira a conexão do cofre antes de continuar.");
  const origin = url.origin, credential = options.connection.api_key, environment = emission.environment;
  const transport = options.fetch ?? context.fetch ?? globalThis.fetch;
  const pinnedFetch: typeof fetch = async (resource, init) => {
    const request = new Request(resource, init), target = new URL(request.url);
    if (target.origin !== origin) fail("fiscal_connection_changed", "Restabeleça a conexão original desta emissão.");
    // Também isola versões antigas do provedor cujo find não recebia ambiente.
    if (target.pathname === "/v1/nfe" && request.method === "GET") target.searchParams.set("ambiente", environment);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    const response = await transport(new Request(target, new Request(request, { headers, redirect: "manual" })));
    if (response.status >= 300 && response.status < 400)
      fail("fiscal_connection_changed", "O cofre tentou redirecionar esta operação. Confira a conexão original.");
    return response;
  };
  const vault: CommercialVaultSession = { provider: options.provider, fingerprint: options.fingerprint,
    context: { env: context.env, profile: context.profile, fetch: pinnedFetch, connection_fingerprint: options.fingerprint } };
  requireVaultBinding(emission, vault);
  return vault;
}

/** Erros de transporte não são rejeições fiscais. Não copiar mensagens arbitrárias com segredos. */
function externalFailure(error: unknown): { result: FiscalResult | null; error: { code: string; message: string }; evidence: JsonObject } {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const details = object.details && typeof object.details === "object" ? object.details as Record<string, unknown> : {};
  const code = typeof object.code === "string" && /^fiscal_[a-z0-9_]{1,100}$/.test(object.code) ? object.code : "fiscal_no_conclusive_answer";
  return { result: details.emission && typeof details.emission === "object" ? details.emission as FiscalResult : null,
    error: { code, message: "O resultado da operação precisa ser conferido no cofre pela mesma referência." },
    // Identidade divergente nunca vira resultado autorizado. Conservar a
    // evidência bruta no recibo restrito permite conciliar o retorno; o motor
    // sanitiza suas chaves antes de persistir, sem publicá-la no DTO/auditoria.
    evidence: { transport_error: code, retryable: details.retryable === true,
      ...(details.unverified_emission != null ? { unverified_emission: details.unverified_emission as JsonValue } : {}) } };
}

function capability(emissionId: string, command: CommandReceipt) {
  if (!command.token) fail("com1_claim_missing", "A operação não possui uma reivindicação válida.");
  return { emission_id: emissionId, command_id: command.id, claim_token: command.token! };
}

function persistedBody(claim: ClaimResult): Record<string, unknown> {
  const request = claim.command.request;
  if (!request || typeof request.body_text !== "string" || hash(request.body_text) !== request.body_hash ||
    request.body_hash !== claim.revision.body_hash || request.reference !== claim.emission.reference || request.environment !== claim.emission.environment ||
    request.connection_fingerprint !== claim.emission.connection_fingerprint)
    fail("com1_persisted_request_invalid", "A intenção persistida precisa ser reconciliada antes de continuar.");
  const body = JSON.parse(request!.body_text as string) as Record<string, unknown>;
  if (body.referencia !== claim.emission.reference || body.ambiente !== claim.emission.environment)
    fail("com1_persisted_request_invalid", "O corpo persistido não corresponde à emissão.");
  return body;
}

/** Nenhuma chamada ao provedor ocorre dentro de RPC/transação SQLite. */
export function createCommercialNfeService(_context: CommercialNfeHttpContext, dependencies: CommercialNfeServiceDependencies) {
  const bridge = dependencies.bridge, uuid = dependencies.uuid ?? randomUUID;
  const read = (input: ReadInput) => bridge.call("erp_com1_get", input);
  const vaultFor = async (emission: EmissionView) => {
    const vault = await dependencies.vault(emission);
    requireVaultBinding(emission, vault);
    return vault;
  };

  async function effectsAfterEvidence(emission: EmissionView): Promise<EmissionView> {
    if (!["autorizada", "cancelada"].includes(emission.status)) return emission;
    // Cada eixo tem seu próprio RPC/commit. Pendências já foram gravadas pelo
    // record; falha ou revogação aqui não desfaz nem esconde o resultado fiscal.
    for (const axis of ["stock", "finance"] as const) {
      const existing = emission.effects.find(effect => effect.axis === axis);
      if (emission.status === "autorizada" && existing && ["aplicado", "reconhecido", "pulado"].includes(existing.state)) continue;
      if (emission.status === "cancelada" && existing?.compensation_state === "revertido") continue;
      try {
        const current = await read({ emission_id: emission.id });
        const input: EffectInput = { emission_id: emission.id, command_id: uuid(), expected_version: current.version, axis,
          intent: current.status === "cancelada" ? "reverse" : "apply" };
        await bridge.call(input.intent === "reverse" ? "erp_com1_effect_reverse" : "erp_com1_effect_apply", input);
      } catch { /* A pendência durável anterior é mantida; a outra área ainda é tentada. */ }
    }
    try { return await read({ emission_id: emission.id }); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && [403, 404].includes(Number(error.status))) throw error;
      return emission;
    }
  }

  async function operate(input: CommercialEmitInput | CommercialResumeInput, action: "emit" | "resume") {
    const before = await read({ emission_id: input.emission_id });
    if (action === "emit" && (before.status === "bloqueada" || !before.revision.body || before.revision.blockers.length))
      throw new ApiError(422, "com1_preparation_blocked", "Corrija os bloqueios fiscais e atualize a preparação.");
    const vault = await vaultFor(before);
    const bodyHash = "body_hash" in input ? input.body_hash : before.revision.body_hash;
    if (!bodyHash) throw new ApiError(422, "com1_preparation_blocked", "Corrija os bloqueios fiscais e atualize a preparação.");
    const claimInput = { ...input, action, body_hash: bodyHash, connection_fingerprint: vault.fingerprint };
    const claim = await bridge.call("erp_com1_claim", claimInput);
    if (claim.disposition === "replay" || claim.disposition === "busy") return read({ emission_id: input.emission_id });
    const cap = capability(claim.emission.id, claim.command), key = { document_id: claim.emission.document_id, version: claim.emission.fiscal_version };
    const body = persistedBody(claim);
    let foundAbsent = false;
    let record: RecordInput = { ...cap, connection_fingerprint: vault.fingerprint, result: null };
    try {
      if (claim.disposition === "send") {
        record.result = await vault.provider.emit(vault.context, "nfe", body, key, { keep_issue_date: true });
      } else {
        record.result = claim.emission.provider_id
          ? await vault.provider.get(vault.context, "nfe", claim.emission.provider_id, commercialLookupIdentity(claim.emission))
          : await vault.provider.find(vault.context, "nfe", key, claim.emission.environment);
        foundAbsent = !record.result && !claim.emission.provider_id;
      }
    } catch (error) { record = { ...record, ...externalFailure(error) }; }
    let persisted = await bridge.call("erp_com1_record", record);
    const reconcile = matchesCommercialResult(claim.emission, record.result) && record.result &&
      persisted.provider_id === record.result.provider_ref && ["processing", "undetermined"].includes(record.result.status);
    if (claim.disposition === "resume" && (foundAbsent || reconcile)) {
      // O commit fica fora do catch de transporte. Se falhar, a evidência
      // recebida não pode ser substituída por um erro fictício do provedor.
      // O replay revalida papel/portão/partes antes de outra chamada externa.
      await bridge.call("erp_com1_claim", claimInput);
      try { record = { ...cap, connection_fingerprint: vault.fingerprint,
        result: foundAbsent
          ? await vault.provider.emit(vault.context, "nfe", body, key, { keep_issue_date: true })
          : await vault.provider.reconcile(vault.context, "nfe", record.result!.provider_ref, commercialLookupIdentity(claim.emission)) }; }
      catch (error) { record = { ...cap, connection_fingerprint: vault.fingerprint, ...externalFailure(error) }; }
      persisted = await bridge.call("erp_com1_record", record);
    }
    return effectsAfterEvidence(persisted);
  }

  async function cancel(input: CommercialCancelInput): Promise<EmissionView> {
    const before = await read({ emission_id: input.emission_id }), vault = await vaultFor(before);
    const claimInput = { ...input, connection_fingerprint: vault.fingerprint };
    const claim = await bridge.call("erp_com1_cancel_claim", claimInput);
    if (claim.disposition === "busy") return read({ emission_id: input.emission_id });
    if (claim.disposition === "replay" && claim.cancellation.xml_status === "disponivel") return read({ emission_id: input.emission_id });
    // Replay de um pedido ainda em voo não autoriza um segundo cancelamento.
    if (claim.disposition === "replay" && claim.cancellation.state !== "registrado") return read({ emission_id: input.emission_id });
    const cap = capability(claim.emission.id, claim.command);
    if (claim.cancellation.state === "registrado") {
      // Arquivamento independente: evento conclusivo nunca volta a cancelar,
      // mesmo se uma leitura remota atrasada ainda disser "autorizada".
      let archived = before;
      try {
        if (!claim.emission.provider_id) fail("com1_cancellation_requires_authorization", "Confira o vínculo da emissão no cofre.");
        const xml = await vault.provider.cancellationXml(vault.context, "nfe", claim.emission.provider_id!);
        const event = parseCancellationXml(xml, claim.emission);
        if (event.protocol !== claim.cancellation.protocol || event.event_at !== claim.cancellation.event_at)
          fail("com1_cancellation_xml_conflict", "O XML difere do evento de cancelamento registrado.");
        await bridge.call("erp_com1_cancel_xml_record", { ...cap, xml, xml_hash: hash(xml) });
        archived = { ...before, cancellation: { ...claim.cancellation, xml_status: "disponivel", xml_hash: hash(xml) } };
      } catch { /* A falha mantém somente o arquivamento pendente. */ }
      return effectsAfterEvidence(archived);
    }
    let record: CancelRecordInput = { ...cap, connection_fingerprint: vault.fingerprint, state: "incerto", result: null };
    let persisted: EmissionView = before;
    let retryCancellation = false;
    try {
      if (!claim.emission.provider_id) fail("com1_cancellation_requires_authorization", "A emissão ainda não tem vínculo autorizado com o cofre.");
      const request = claim.command.request;
      if (!request || typeof request.body_text !== "string" || hash(request.body_text) !== request.body_hash ||
        request.reference !== claim.emission.reference || request.environment !== claim.emission.environment ||
        request.connection_fingerprint !== claim.emission.connection_fingerprint || request.provider_id !== claim.emission.provider_id ||
        JSON.parse(request.body_text).justificativa !== claim.cancellation.justification)
        fail("com1_persisted_request_invalid", "A intenção de cancelamento precisa ser reconciliada.");
      if (claim.disposition === "send") {
        record.result = await vault.provider.cancel(vault.context, "nfe", claim.emission.provider_id!, { justification: claim.cancellation.justification }, commercialLookupIdentity(claim.emission));
      } else {
        record.result = await vault.provider.get(vault.context, "nfe", claim.emission.provider_id!, commercialLookupIdentity(claim.emission));
        retryCancellation = matchesCommercialResult(claim.emission, record.result) && record.result!.status === "authorized";
      }
      record.state = record.result?.status === "cancelled" ? "registrado" : !retryCancellation && record.result?.status === "authorized" ? "recusado" : "incerto";
    } catch (error) {
      record = { ...record, ...externalFailure(error) };
      if (["fiscal_rejected", "fiscal_invalid_request", "fiscal_cancellation_rejected", "fiscal_event_rejected"].includes(record.error!.code)) record.state = "recusado";
    }
    // Primeiro preserva o fato fiscal; XML e compensações são etapas independentes.
    persisted = await bridge.call("erp_com1_cancel_record", record);
    if (retryCancellation) {
      await bridge.call("erp_com1_cancel_claim", claimInput);
      try {
        record = { ...cap, connection_fingerprint: vault.fingerprint, state: "incerto",
          result: await vault.provider.cancel(vault.context, "nfe", claim.emission.provider_id!, { justification: claim.cancellation.justification }, commercialLookupIdentity(claim.emission)) };
        record.state = record.result?.status === "cancelled" ? "registrado" : record.result?.status === "authorized" ? "recusado" : "incerto";
      } catch (error) {
        record = { ...cap, connection_fingerprint: vault.fingerprint, state: "incerto", ...externalFailure(error) };
        if (["fiscal_rejected", "fiscal_invalid_request", "fiscal_cancellation_rejected", "fiscal_event_rejected"].includes(record.error!.code)) record.state = "recusado";
      }
      persisted = await bridge.call("erp_com1_cancel_record", record);
    }
    if (persisted.status === "cancelada" && matchesCommercialResult(claim.emission, record.result) && record.result?.status === "cancelled") {
      try {
        const xml = await vault.provider.cancellationXml(vault.context, "nfe", claim.emission.provider_id!);
        const event = parseCancellationXml(xml, persisted);
        persisted = await bridge.call("erp_com1_cancel_record", { ...record, state: "registrado", event_protocol: event.protocol, event_at: event.event_at });
        await bridge.call("erp_com1_cancel_xml_record", { ...cap, xml, xml_hash: hash(xml) });
        persisted = { ...persisted, cancellation: { ...persisted.cancellation!, xml_status: "disponivel", xml_hash: hash(xml) } };
      } catch { /* Nota cancelada; XML do evento pendente de arquivamento. */ }
    }
    return effectsAfterEvidence(persisted);
  }

  return {
    configGet: () => bridge.call("erp_com1_config_get", undefined),
    configSave: (input: ConfigSaveInput) => bridge.call("erp_com1_config_save", input),
    prepare: (input: PrepareInput) => bridge.call("erp_com1_prepare", input),
    list: (input: ListInput) => bridge.call("erp_com1_list", input), read,
    emit: (input: CommercialEmitInput) => operate(input, "emit"),
    resume: (input: CommercialResumeInput) => operate(input, "resume"), cancel,
    effects: (input: EffectInput) => bridge.call(input.intent === "reverse" ? "erp_com1_effect_reverse" : "erp_com1_effect_apply", input),
    danfe: async (input: ReadInput) => { const emission = await read(input); return commercialArtifact(emission, await vaultFor(emission), "danfe"); },
    xml: async (input: ReadInput) => { const emission = await read(input); return commercialArtifact(emission, await vaultFor(emission), "xml"); },
    cancellationXml: async (input: ReadInput) => {
      const emission = await read(input) as EmissionView & { cancellation_xml?: string | null };
      if (emission.cancellation?.xml_status !== "disponivel" || !emission.cancellation_xml)
        return Response.json({ code: "fiscal_cancellation_xml_pending", message: "Nota cancelada; XML do evento pendente de arquivamento." },
          { status: 202, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      if (hash(emission.cancellation_xml) !== emission.cancellation.xml_hash) fail("com1_cancellation_xml_conflict", "Confira o XML arquivado do cancelamento.");
      parseCancellationXml(emission.cancellation_xml, emission);
      return privateFiscalFile(emission.id, "cancelamento", new TextEncoder().encode(emission.cancellation_xml));
    },
  };
}
