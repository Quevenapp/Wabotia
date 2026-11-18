// Provedor fiscal NFapi: FiscalProvider sobre o cliente fino (nfapi.ts).
//
// Repetição e idempotência na emissão (README.md desta pasta, "Emissão"):
// 1. A referência é derivada da FiscalKey (id e versão do documento do ERP)
//    e é a mesma em toda tentativa.
// 2. Versão > 1: antes de emitir, as versões anteriores precisam estar
//    encerradas sem nota válida; a que ficou `indefinida` é consultada antes.
// 3. 502 sem_resposta_conclusiva → POST .../consultar; só se continuar sem
//    conclusão, repete o POST com a mesma referência (o cofre consulta de
//    novo antes de reenviar).
// 4. Resposta perdida (rede, tempo esgotado, página da Cloudflare) → procura
//    a referência no cofre; só repete se ela não estiver lá.
// 5. 409 referencia_com_conteudo_diferente nunca é repetido: sobe como erro.
// 6. Rejeição e denegação voltam como resultado, com as mensagens da SEFAZ.
import type {
  ContractErrorCode,
  Distribuicao,
  EmissaoNfe,
  EmissaoNfse,
  InutilizacaoRegistrada,
  ManifestacaoRegistrada,
  NotaRecebida,
} from "./contract/types.generated.ts";
import {
  NfapiClient,
  NfapiError,
  NfapiOutdatedError,
  NfapiTransportError,
  olderThan,
  type NfapiDoc,
  type NfapiFile,
} from "./nfapi.ts";
import {
  FiscalError,
  type FiscalContext,
  type FiscalContingencyMode,
  type FiscalContingencyState,
  type FiscalDistributionState,
  type FiscalEmitOptions,
  type FiscalEnvironment,
  type FiscalFile,
  type FiscalKey,
  type FiscalKind,
  type FiscalManifestation,
  type FiscalMessage,
  type FiscalProvider,
  type FiscalProviderState,
  type FiscalReceivedNote,
  type FiscalResult,
  type FiscalStatus,
  type FiscalVoidResult,
  providerNotConfigured,
  registrationRejection,
} from "./provider.ts";
import { emissorConnection } from "./config.ts";

export const NFAPI_PROVIDER_ID = "nfapi";

const SITUACAO: Record<EmissaoNfe["situacao"] | EmissaoNfse["situacao"], FiscalStatus> = {
  processando: "processing",
  autorizada: "authorized",
  contingencia: "contingency",
  rejeitada: "rejected",
  denegada: "denied",
  erro: "error",
  indefinida: "undetermined",
  cancelada: "cancelled",
};
/** Situações do contrato que o provedor conhece (o teste confere com o enum). */
export const KNOWN_SITUACOES = Object.keys(SITUACAO);

/**
 * Situações em que já existe (ou pode existir) uma nota válida. A NFC-e em
 * contingência é nota válida: bloqueia versão nova como a autorizada.
 */
const OPEN: ReadonlySet<FiscalStatus> = new Set(["processing", "authorized", "contingency", "undetermined"]);

/** Desde esta versão o POST /v1/inutilizacoes repetido devolve 200 com `repetido`. */
const VOID_REPEAT_SAFE_VERSION = "0.4.1";

const CONTINGENCIA: Record<Exclude<FiscalContingencyMode, "never">, "automatica" | "forcada"> = {
  automatic: "automatica",
  forced: "forcada",
};

const REFERENCE = /^[A-Za-z0-9._:-]{1,80}$/;

/** Referência enviada ao cofre para um documento do ERP. */
export function fiscalReference(key: FiscalKey): string {
  const id = String(key?.document_id ?? "");
  const version = key?.version;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
    throw new FiscalError(400, "fiscal_invalid_key", "Id do documento fiscal inválido.");
  if (!Number.isInteger(version) || version < 1 || version > 9999)
    throw new FiscalError(400, "fiscal_invalid_key", "Versão do documento fiscal inválida (1 a 9999).");
  const reference = `wb.${id}.v${version}`;
  if (!REFERENCE.test(reference))
    throw new FiscalError(400, "fiscal_invalid_key", "Referência fora do formato do cofre.");
  return reference;
}

export function toResult(
  kind: FiscalKind,
  e: (EmissaoNfe | EmissaoNfse) & { repetido?: boolean },
  replayed = false,
): FiscalResult {
  const nfe = kind === "nfse" ? null : (e as EmissaoNfe);
  const nfse = kind === "nfse" ? (e as EmissaoNfse) : null;
  return {
    kind,
    status: SITUACAO[e.situacao] ?? "undetermined",
    provider_ref: e.id,
    reference: e.referencia ?? null,
    environment: e.ambiente,
    series: String(e.serie),
    number: e.numero,
    access_key: e.chaveAcesso ?? null,
    protocol: nfe?.protocolo ?? null,
    nfse_number: nfse?.numeroNfse ?? null,
    issued_at: nfe?.emitidaEm ?? null,
    authorized_at: nfe?.autorizadaEm ?? null,
    total: nfe?.valor ?? null,
    qr_code: nfe?.qrCode ?? null,
    consult_url: nfe?.urlConsulta ?? null,
    corrections: nfe?.cartasCorrecao ?? 0,
    messages: (e.mensagens || []).map((m) => ({ code: m.codigo, description: m.descricao })),
    xml_available: !!e.xmlDisponivel,
    replayed,
    event_repeated: typeof e.repetido === "boolean" ? e.repetido : null,
    contingency: contingencyOf(nfe),
  };
}

function contingencyOf(e: EmissaoNfe | null): FiscalContingencyState | null {
  const c = e?.contingencia;
  if (!c) return null;
  return {
    pending: !!c.pendente,
    since: c.desde ?? null,
    reason: c.motivo ?? null,
    transmission_attempts: c.tentativasDeTransmissao ?? 0,
    last_attempt_at: c.ultimaTentativa ?? null,
    normal_note_in_review: c.notaNormalEmConferencia ?? null,
    review_failure: c.falhaNaConferencia ?? null,
    normal_note_cancelled: c.notaNormalCancelada ?? null,
  };
}

const ROLE = { destinatario: "recipient", terceiro: "third_party" } as const;
const RECEIVED_STATUS = { autorizada: "authorized", cancelada: "cancelled", denegada: "denied" } as const;

function manifestationOf(m: ManifestacaoRegistrada): FiscalManifestation {
  return {
    type: m.tipo ?? null,
    sequence: m.sequencia ?? null,
    protocol: m.protocolo ?? null,
    registered_at: m.registradaEm ?? null,
    justification: m.justificativa ?? null,
    origin: m.origem ?? null,
    xml_available: !!m.xmlDisponivel,
  };
}

/** NotaRecebida do contrato → nota recebida neutra. */
export function toReceived(n: NotaRecebida): FiscalReceivedNote {
  const refused = n.cienciaAutomaticaRecusada;
  return {
    provider_ref: n.id,
    environment: n.ambiente,
    cnpj: n.cnpj,
    access_key: n.chaveAcesso,
    sequence: n.sequencia,
    role: ROLE[n.papel] ?? "third_party",
    issuer: { document: n.emitente?.documento ?? null, name: n.emitente?.nome ?? null, ie: n.emitente?.ie ?? null },
    series: n.serie ?? null,
    number: n.numero ?? null,
    issued_at: n.emitidaEm ?? null,
    authorized_at: n.autorizadaEm ?? null,
    protocol: n.protocolo ?? null,
    operation: n.tipoOperacao ?? null,
    total: n.valor ?? null,
    status: n.situacao ? RECEIVED_STATUS[n.situacao] : null,
    xml_available: !!n.xmlDisponivel,
    manifestation: n.manifestacao ? manifestationOf(n.manifestacao) : null,
    manifestations: (n.manifestacoes || []).map(manifestationOf),
    automatic_acknowledgement_refused: refused?.codigo ? { code: refused.codigo, description: refused.descricao ?? "" } : null,
    received_at: n.recebidaEm ?? null,
    updated_at: n.atualizadaEm ?? null,
    repeated: typeof n.repetido === "boolean" ? n.repetido : null,
  };
}

function distributionOf(d: Distribuicao): FiscalDistributionState {
  return {
    cnpj: d.cnpj ?? null,
    environment: d.ambiente ?? null,
    uf: d.uf ?? null,
    automatic_query: !!d.consultaAutomatica,
    automatic_acknowledgement: !!d.cienciaAutomatica,
    last_nsu: d.ultimoNsu ?? null,
    max_nsu: d.maiorNsu ?? null,
    last_query_at: d.ultimaConsulta ?? null,
    next_query_at: d.proximaConsulta ?? null,
    blocked: !!d.bloqueada,
    message: d.mensagem?.codigo ? { code: d.mensagem.codigo, description: d.mensagem.descricao ?? "" } : null,
    key_queries: { last_hour: d.consultasPorChave?.naUltimaHora ?? 0, limit: d.consultasPorChave?.limite ?? null },
    recovering_documents: d.documentosARecuperar ?? 0,
  };
}

function voidResultOf(body: InutilizacaoRegistrada, fallback: Partial<FiscalVoidResult> = {}): FiscalVoidResult {
  return {
    provider_ref: body.id ?? "",
    kind: body.modelo ?? fallback.kind ?? "",
    environment: body.ambiente ?? fallback.environment ?? "homologacao",
    series: body.serie ?? fallback.series ?? 0,
    first: body.numeroInicial ?? fallback.first ?? 0,
    last: body.numeroFinal ?? fallback.last ?? 0,
    protocol: body.protocolo ?? null,
    created_at: body.criadaEm ?? null,
    justification: body.justificativa ?? fallback.justification ?? null,
    xml_available: !!body.xmlDisponivel,
    repeated: typeof body.repetido === "boolean" ? body.repetido : null,
  };
}

const toFile = (f: NfapiFile): FiscalFile => ({ content_type: f.contentType, size: f.size, body: f.body });

/** Horário ISO em `erro.mensagem` do 429 ("Tente depois de 2026-11-17T15:00:00.000Z."). */
export function retryAtOf(message: string): string | null {
  const m = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/.exec(message);
  return m && Number.isFinite(Date.parse(m[0])) ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Erros do cofre → erros do ERP

/**
 * Código do cofre → [status HTTP do Wabotia, código do ERP, pode repetir].
 * As chaves são exatamente a tabela `x-codigos` do contrato (o teste de
 * contrato confere). Código fora da tabela é tratado pelo status HTTP.
 */
export const ERROR_MAP: Record<ContractErrorCode, [number, string, boolean]> = {
  requisicao_invalida: [422, "fiscal_invalid_request", false],
  nao_autenticado: [409, "fiscal_provider_unauthorized", false],
  chave_somente_homologacao: [409, "fiscal_key_homologation_only", false],
  producao_bloqueada: [409, "fiscal_production_blocked", false],
  host_nao_permitido: [502, "fiscal_provider_error", false],
  certificado_do_cliente_invalido: [409, "fiscal_certificate_rejected", false],
  nao_encontrado: [404, "fiscal_document_not_found", false],
  referencia_com_conteudo_diferente: [409, "fiscal_reference_conflict", false],
  emissao_em_andamento: [409, "fiscal_in_progress", true],
  certificado_ausente: [409, "fiscal_certificate_missing", false],
  certificado_vencido: [409, "fiscal_certificate_expired", false],
  nfe_nao_autorizada: [409, "fiscal_not_authorized", false],
  nfse_nao_autorizada: [409, "fiscal_not_authorized", false],
  faixa_em_uso: [409, "fiscal_range_in_use", false],
  numero_ja_utilizado: [409, "fiscal_number_used", false],
  serie_nao_cadastrada: [422, "fiscal_series_not_registered", false],
  serie_obrigatoria: [422, "fiscal_series_required", false],
  uf_nao_suportada: [422, "fiscal_uf_not_supported", false],
  inutilizacao_extinta: [422, "fiscal_void_range_abolished", false],
  emitente_divergente: [422, "fiscal_emitter_mismatch", false],
  nfe_rejeitada: [422, "fiscal_rejected", false],
  nfe_denegada: [422, "fiscal_denied", false],
  nfse_rejeitada: [422, "fiscal_rejected", false],
  cancelamento_rejeitado: [422, "fiscal_rejected", false],
  carta_rejeitada: [422, "fiscal_rejected", false],
  inutilizacao_rejeitada: [422, "fiscal_rejected", false],
  carta_nao_se_aplica: [422, "fiscal_correction_not_applicable", false],
  limite_de_cartas: [422, "fiscal_correction_limit", false],
  // NF-e recebidas e manifestação (0.9.0).
  distribuicao_nao_configurada: [409, "fiscal_distribution_not_configured", false],
  xml_indisponivel: [409, "fiscal_xml_unavailable", false],
  manifestacao_ja_registrada: [409, "fiscal_manifestation_already_registered", false],
  chave_de_acesso_invalida: [422, "fiscal_invalid_access_key", false],
  justificativa_obrigatoria: [422, "fiscal_justification_required", false],
  limite_de_manifestacoes: [422, "fiscal_manifestation_limit", false],
  manifestacao_rejeitada: [422, "fiscal_rejected", false],
  nota_nao_localizada: [422, "fiscal_received_note_not_found", false],
  consulta_rejeitada: [422, "fiscal_rejected", false],
  // 429: retry_at sai de erro.mensagem. Repetível só depois do horário.
  consumo_indevido: [429, "fiscal_queries_blocked", true],
  limite_de_consultas: [429, "fiscal_query_limit", true],
  sem_resposta_conclusiva: [503, "fiscal_no_conclusive_answer", true],
  // Só aparece em GET /v1/sefaz/status, dentro de mensagem.codigo (não é erro HTTP).
  sem_conexao: [503, "fiscal_provider_unavailable", true],
  erro_interno: [503, "fiscal_provider_unavailable", true],
  cofre_nao_configurado: [409, "fiscal_provider_not_ready", false],
};

/** Converte qualquer falha do cliente em FiscalError (preserva o resto). */
export function fiscalError(error: unknown, kind: FiscalKind | null = null): unknown {
  if (error instanceof FiscalError) return error;
  if (error instanceof NfapiOutdatedError)
    return new FiscalError(409, "vault_outdated", error.message, {
      provider_code: error.codigo,
      min_version: error.minVersion,
      retryable: false,
    });
  if (error instanceof NfapiTransportError) {
    if (error.kind === "same_zone")
      return new FiscalError(
        502,
        "fiscal_provider_same_zone",
        "A Cloudflare recusou a chamada do Wabotia ao cofre (erro 1042). Instale o cofre em outra zona ou ligue a flag global_fetch_strictly_public no Wabotia.",
        { retryable: false },
      );
    if (error.kind === "too_large") return new FiscalError(502, "fiscal_file_too_large", error.message, { retryable: false });
    return new FiscalError(503, "fiscal_provider_unreachable", error.message, { retryable: true });
  }
  if (error instanceof NfapiError) {
    const known = (ERROR_MAP as Record<string, [number, string, boolean] | undefined>)[error.codigo];
    const [status, code, retryable] =
      known ?? (error.status >= 500 ? [503, "fiscal_provider_unavailable", true] : [422, "fiscal_provider_rejected", false]);
    const emission = error.emissao;
    const emissionKind = kind ?? (emission && "idDps" in emission ? "nfse" : null);
    const messages = error.mensagens.map((m) => ({ code: m.codigo, description: m.descricao }));
    const registration = error.status === 422 ? registrationRejection(messages) : null;
    return new FiscalError(status, registration?.code ?? code, registration?.message ?? error.message, {
      provider_code: error.codigo,
      field: error.campo,
      messages,
      emission: emission && emissionKind ? toResult(emissionKind, emission) : null,
      retryable: registration ? false : retryable,
      retry_at: error.status === 429 ? retryAtOf(error.message) : null,
    });
  }
  return error;
}

// ---------------------------------------------------------------------------
// Provedor

export interface NfapiProviderOptions {
  /** Esperas entre tentativas de emissão (ms); o tamanho define o máximo de reenvios. */
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createNfapiProvider(options: NfapiProviderOptions = {}): FiscalProvider {
  const delays = options.delays ?? [0, 1_500, 4_000];
  const sleep = options.sleep ?? defaultSleep;

  async function client(ctx: FiscalContext) {
    const conn = await emissorConnection(ctx.env, ctx.profile);
    if (!conn || conn.provider !== NFAPI_PROVIDER_ID) throw providerNotConfigured();
    return new NfapiClient({ url: conn.url, apiKey: conn.api_key, fetch: ctx.fetch });
  }

  /** Leitura com uma nova tentativa só para falha de transporte. */
  async function read<T>(run: () => Promise<T>, kind: FiscalKind | null = null): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NfapiTransportError && error.kind !== "same_zone")
        try {
          return await run();
        } catch (again) {
          throw fiscalError(again, kind);
        }
      throw fiscalError(error, kind);
    }
  }

  const nfeLike = (kind: FiscalKind): kind is "nfe" | "nfce" => kind === "nfe" || kind === "nfce";

  /** Emissões da referência; a referência é única por ambiente. */
  async function byReference(api: NfapiClient, kind: FiscalKind, reference: string, ambiente?: FiscalEnvironment) {
    return (await api.listar(kind as NfapiDoc, { referencia: reference, ambiente, limite: 10 })).body.filter(
      (e) => e.referencia === reference && (!ambiente || e.ambiente === ambiente),
    );
  }

  /** Fecha uma emissão indefinida consultando a SEFAZ (NF-e/NFC-e). */
  async function settle(api: NfapiClient, kind: FiscalKind, e: EmissaoNfe | EmissaoNfse) {
    if (e.situacao !== "indefinida" || !nfeLike(kind)) return e;
    try {
      return (await api.consultar(kind, e.id)).body;
    } catch (error) {
      if (error instanceof NfapiTransportError || (error instanceof NfapiError && error.status >= 500)) return e;
      throw error;
    }
  }

  /**
   * Versão nova só depois de a anterior ser cancelada (ou denegada, que
   * consome o número). Rejeitada ou com erro, a anterior aceita conteúdo novo
   * com a mesma referência: reenvie nela. Qualquer versão anterior com nota
   * válida ou sem conclusão bloqueia.
   */
  async function previousVersionsClosed(api: NfapiClient, kind: FiscalKind, key: FiscalKey, ambiente: FiscalEnvironment) {
    for (let version = 1; version < key.version; version++) {
      const reference = fiscalReference({ document_id: key.document_id, version });
      for (const found of await byReference(api, kind, reference, ambiente)) {
        const settled = await settle(api, kind, found);
        const result = toResult(kind, settled);
        if ((result.status === "rejected" || result.status === "error") && version === key.version - 1)
          throw new FiscalError(
            409,
            "fiscal_previous_version_reusable",
            `A versão ${version} deste documento foi rejeitada e não virou nota: reenvie o pedido corrigido na versão ${version}. Versão nova só depois de um cancelamento.`,
            { emission: result, retryable: false },
          );
        if (OPEN.has(result.status))
          throw new FiscalError(
            409,
            "fiscal_previous_version_open",
            result.status === "authorized"
              ? `A versão ${version} deste documento já tem nota autorizada (${result.access_key ?? result.provider_ref}). Cancele-a antes de emitir de novo.`
              : `A versão ${version} deste documento ainda está sem conclusão no governo. Consulte-a antes de emitir de novo.`,
            { emission: result, retryable: result.status !== "authorized" },
          );
      }
    }
  }

  async function emit(
    ctx: FiscalContext,
    kind: FiscalKind,
    request: Record<string, unknown>,
    key: FiscalKey,
    options: FiscalEmitOptions = {},
  ) {
    const mode = options.contingency;
    if (mode !== undefined && mode !== "never" && kind !== "nfce")
      throw new FiscalError(422, "fiscal_contingency_not_supported", "A contingência existe só na NFC-e.");
    if (mode !== undefined && !["never", "automatic", "forced"].includes(mode))
      throw new FiscalError(400, "fiscal_invalid_request", "Contingência inválida (never, automatic ou forced).", { field: "contingency" });
    const reference = fiscalReference(key);
    if (request.referencia !== undefined && request.referencia !== reference)
      throw new FiscalError(400, "fiscal_invalid_request", "A referência do pedido é definida pelo ERP a partir do documento.", {
        field: "referencia",
      });
    const environment = (request.ambiente ?? "homologacao") as FiscalEnvironment;
    // dataEmissao entra na comparação de conteúdo do cofre: por padrão sai,
    // e o cofre carimba a hora da emissão no fuso da UF.
    const { dataEmissao, ...rest } = request;
    // contingencia fica fora da comparação de conteúdo do cofre: trocar o
    // modo entre tentativas não gera conflito de referência.
    const body = {
      ...(options.keep_issue_date && dataEmissao !== undefined ? request : rest),
      referencia: reference,
      ...(mode !== undefined && kind === "nfce" ? { contingencia: mode === "never" ? "nunca" : CONTINGENCIA[mode] } : {}),
    };
    const api = await client(ctx);
    const mine = async () =>
      (await byReference(api, kind, reference, environment).catch(() => [])).find((e) => e.ambiente === environment) ?? null;
    try {
      await previousVersionsClosed(api, kind, key, environment);
      let last: EmissaoNfe | EmissaoNfse | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (attempt > 0 && delays[attempt]) await sleep(delays[attempt]);
        try {
          const response = await api.emitir(kind as NfapiDoc, body as never);
          return toResult(kind, response.body, response.status === 200);
        } catch (error) {
          lastError = error;
          // Resposta perdida, ou falha interna do cofre no meio da emissão:
          // o cofre pode ter emitido. Procura antes de repetir.
          const lost =
            error instanceof NfapiTransportError
              ? error.kind !== "same_zone"
              : error instanceof NfapiError &&
                error.status >= 500 &&
                error.codigo !== "sem_resposta_conclusiva" &&
                error.codigo !== "cofre_nao_configurado";
          if (lost) {
            const found = await mine();
            if (!found) continue;
            last = await settle(api, kind, found);
            if (last.situacao === "indefinida") continue;
            return toResult(kind, last, true);
          }
          if (!(error instanceof NfapiError)) throw error;
          if (error.codigo === "sem_resposta_conclusiva") {
            // NF-e/NFC-e: /consultar. NFS-e não tem consulta: só a repetição
            // com a mesma referência fecha (o cofre consulta antes de reenviar).
            const pending = error.emissao ?? (await mine());
            if (pending) {
              last = await settle(api, kind, pending);
              if (last.situacao !== "indefinida") return toResult(kind, last, true);
            }
            continue;
          }
          if (error.codigo === "emissao_em_andamento") {
            const found = await mine();
            if (found) return toResult(kind, found, true);
            throw error;
          }
          // Rejeição, denegação ou erro antes de transmitir: resultado com a
          // emissão, salvo rejeição de cadastro (não adianta repetir): erro.
          if (error.status === 422 && error.emissao) {
            const rejected = toResult(kind, error.emissao);
            const registration = registrationRejection(rejected.messages);
            if (registration)
              throw new FiscalError(422, registration.code, registration.message, {
                provider_code: error.codigo,
                messages: rejected.messages,
                emission: rejected,
                retryable: false,
              });
            return rejected;
          }
          throw error;
        }
      }
      // Tentativas esgotadas. Com emissão conhecida, ela volta como está
      // (processando/indefinida): o ERP guarda o provider_ref e consulta depois.
      if (last) return toResult(kind, last, true);
      throw lastError;
    } catch (error) {
      throw fiscalError(error, kind);
    }
  }

  /** Evento (cancelamento, carta): repete uma vez se a resposta não foi conclusiva. */
  async function event(
    ctx: FiscalContext,
    kind: FiscalKind,
    ref: string,
    run: (api: NfapiClient) => Promise<(EmissaoNfe | EmissaoNfse) & { repetido?: boolean }>,
    done: (e: EmissaoNfe | EmissaoNfse, before: EmissaoNfe | EmissaoNfse | null) => boolean,
  ) {
    const api = await client(ctx);
    let before: EmissaoNfe | EmissaoNfse | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        return toResult(kind, await run(api));
      } catch (error) {
        const inconclusive =
          error instanceof NfapiTransportError
            ? error.kind !== "same_zone"
            : error instanceof NfapiError && (error.codigo === "sem_resposta_conclusiva" || error.status >= 500);
        if (!inconclusive || attempt > 0) throw fiscalError(error, kind);
        // O cofre só grava o evento com a resposta do governo: se ele já
        // consta, devolve; senão repete (a SEFAZ trata duplicidade).
        const now = await api.obter(kind as NfapiDoc, ref).then((r) => r.body).catch(() => null);
        if (now && done(now, before)) return toResult(kind, now, true);
        before = now;
      }
    }
  }

  const provider: FiscalProvider = {
    id: NFAPI_PROVIDER_ID,
    name: "NFapi (cofre do emitente)",
    kinds: ["nfe", "nfce", "nfse"],
    contingency: ["automatic", "forced"],
    emit,
    async find(ctx, kind, key) {
      const reference = fiscalReference(key);
      const api = await client(ctx);
      const list = await read(() => byReference(api, kind, reference), kind);
      // Mais de um ambiente: prefere a nota válida, depois a mais nova.
      const ranked = list
        .map((e) => toResult(kind, e))
        .sort((a, b) => Number(OPEN.has(b.status)) - Number(OPEN.has(a.status)));
      return ranked[0] ?? null;
    },
    async get(ctx, kind, ref) {
      const api = await client(ctx);
      return toResult(kind, await read(async () => (await api.obter(kind as NfapiDoc, ref)).body, kind));
    },
    async reconcile(ctx, kind, ref) {
      if (!nfeLike(kind))
        throw new FiscalError(422, "fiscal_not_supported", "A consulta à SEFAZ existe só para NF-e e NFC-e.");
      const api = await client(ctx);
      return toResult(kind, await read(async () => (await api.consultar(kind, ref)).body, kind));
    },
    async xml(ctx, kind, ref) {
      const api = await client(ctx);
      return read(async () => (await api.xml(kind as NfapiDoc, ref)).body, kind);
    },
    cancel(ctx, kind, ref, input) {
      if (kind === "nfse" && !input.reason)
        throw new FiscalError(422, "fiscal_invalid_request", "Informe o motivo do cancelamento da NFS-e.", { field: "motivo" });
      const body =
        kind === "nfse" ? { motivo: input.reason!, justificativa: input.justification } : { justificativa: input.justification };
      return event(
        ctx,
        kind,
        ref,
        async (api) => (await api.cancelar(kind as NfapiDoc, ref, body as never)).body,
        (e) => e.situacao === "cancelada",
      );
    },
    correct(ctx, ref, text) {
      return event(
        ctx,
        "nfe",
        ref,
        async (api) => (await api.cartaCorrecao(ref, { correcao: text })).body,
        // Sem o estado anterior não dá para saber se esta carta entrou: repete.
        (e, before) => !!before && ((e as EmissaoNfe).cartasCorrecao ?? 0) > ((before as EmissaoNfe).cartasCorrecao ?? 0),
      );
    },
    async voidRange(ctx, input) {
      const api = await client(ctx);
      const pedido = {
        modelo: input.kind,
        ambiente: input.environment,
        serie: input.series,
        numeroInicial: input.first,
        numeroFinal: input.last,
        justificativa: input.justification,
        uf: input.uf as never,
        ...(input.cnpj ? { cnpj: input.cnpj } : {}),
      };
      const fallback = { ...input, environment: input.environment ?? "homologacao" };
      try {
        return voidResultOf((await api.inutilizar(pedido)).body, fallback);
      } catch (error) {
        // Desde a 0.4.1 a faixa já inutilizada volta 200 com `repetido`:
        // depois de resposta não conclusiva, uma repetição é segura. Em cofre
        // mais antigo, não repete (a SEFAZ recusaria a faixa repetida).
        const inconclusive =
          error instanceof NfapiTransportError
            ? error.kind === "network" || error.kind === "timeout" || error.kind === "bad_response"
            : error instanceof NfapiError && (error.codigo === "sem_resposta_conclusiva" || error.status >= 500) && error.codigo !== "cofre_nao_configurado";
        if (!inconclusive) throw fiscalError(error);
        const version = await api.cofre().then((r) => r.body?.versao ?? null).catch(() => null);
        if (!version || olderThan(version, VOID_REPEAT_SAFE_VERSION)) throw fiscalError(error);
        try {
          return voidResultOf((await api.inutilizar(pedido)).body, fallback);
        } catch (again) {
          throw fiscalError(again);
        }
      }
    },
    async voidRanges(ctx, filter = {}) {
      const api = await client(ctx);
      const list = await read(async () =>
        (await api.inutilizacoes({ modelo: filter.kind, ambiente: filter.environment, serie: filter.series })).body,
      );
      return list.map((v) => voidResultOf(v));
    },
    async voidRangeGet(ctx, ref) {
      const api = await client(ctx);
      return voidResultOf(await read(async () => (await api.inutilizacao(ref)).body));
    },
    async voidRangeXml(ctx, ref) {
      const api = await client(ctx);
      return read(async () => (await api.inutilizacaoXml(ref)).body);
    },
    async cancellationXml(ctx, kind, ref) {
      const api = await client(ctx);
      return read(async () => (await api.cancelamentoXml(kind as NfapiDoc, ref)).body, kind);
    },
    async correctionXml(ctx, ref, sequence) {
      if (!Number.isInteger(sequence) || sequence < 1 || sequence > 20)
        throw new FiscalError(400, "fiscal_invalid_request", "Sequência da carta de correção: de 1 a 20.", { field: "sequence" });
      const api = await client(ctx);
      return read(async () => (await api.cartaCorrecaoXml(ref, sequence)).body, "nfe");
    },
    async danfe(ctx, ref) {
      const api = await client(ctx);
      return toFile(await read(() => api.danfe(ref), "nfe"));
    },
    async danfce(ctx, ref, options = {}) {
      const width = options.width ?? "80";
      const copy = options.copy ?? "consumer";
      if (!["80", "58"].includes(width) || !["consumer", "establishment"].includes(copy))
        throw new FiscalError(400, "fiscal_invalid_request", "Largura 80 ou 58; via consumer ou establishment.", {
          field: !["80", "58"].includes(width) ? "width" : "copy",
        });
      const api = await client(ctx);
      return toFile(
        await read(() => api.danfce(ref, { largura: width, via: copy === "consumer" ? "consumidor" : "estabelecimento" }), "nfce"),
      );
    },
    async receipt(ctx, ref, options = {}) {
      const copy = options.copy ?? "consumer";
      if (!["consumer", "establishment"].includes(copy))
        throw new FiscalError(400, "fiscal_invalid_request", "Via consumer ou establishment.", { field: "copy" });
      const api = await client(ctx);
      return (await read(
        async () => (await api.cupom(ref, { via: copy === "consumer" ? "consumidor" : "estabelecimento" })).body,
        "nfce",
      )) as unknown as Record<string, unknown>;
    },
    async logo(ctx) {
      const api = await client(ctx);
      try {
        return toFile(await read(() => api.logotipo()));
      } catch (error) {
        if (error instanceof FiscalError && error.details.provider_code === "nao_encontrado") return null;
        throw error;
      }
    },
    async received(ctx, filter = {}) {
      const after = filter.after ?? 0;
      const limit = filter.limit ?? 50;
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new FiscalError(400, "fiscal_invalid_request", "after: inteiro ≥ 0; limit: de 1 a 200.", { field: "after" });
      const api = await client(ctx);
      const page = await read(async () =>
        (await api.recebidas({ depois: after, limite: limit, ambiente: filter.environment, chaveAcesso: filter.access_key })).body,
      );
      return { items: page.recebidas.map(toReceived), last_sequence: page.ultimaSequencia, has_more: page.haMais };
    },
    async receivedGet(ctx, ref) {
      const api = await client(ctx);
      return toReceived(await read(async () => (await api.recebida(ref)).body));
    },
    async receivedXml(ctx, ref) {
      const api = await client(ctx);
      return read(async () => (await api.recebidaXml(ref)).body);
    },
    async receivedDanfe(ctx, ref) {
      const api = await client(ctx);
      return toFile(await read(() => api.recebidaDanfe(ref)));
    },
    async manifestationXml(ctx, ref, type, sequence) {
      const api = await client(ctx);
      return read(async () => (await api.manifestacaoXml(ref, type, sequence)).body);
    },
    async manifest(ctx, target, input) {
      if (!["ciencia", "confirmacao", "desconhecimento", "nao_realizada"].includes(input.type))
        throw new FiscalError(400, "fiscal_invalid_request", "Tipo de manifestação inválido.", { field: "type" });
      const pedido = {
        tipo: input.type,
        ...(input.type === "nao_realizada" && input.justification !== undefined ? { justificativa: input.justification } : {}),
      };
      const api = await client(ctx);
      // Sem nova tentativa automática: a manifestação é evento fiscal. Repetir
      // é seguro (o cofre devolve `repetido`), mas é decisão de quem chama.
      try {
        const r =
          "ref" in target
            ? await api.manifestar(target.ref, pedido)
            : await api.manifestarPorChave({
                ...pedido,
                chaveAcesso: target.access_key,
                ...(target.environment ? { ambiente: target.environment } : {}),
                ...(target.cnpj ? { cnpj: target.cnpj } : {}),
              });
        return toReceived(r.body);
      } catch (error) {
        throw fiscalError(error);
      }
    },
    async distribution(ctx) {
      const api = await client(ctx);
      return (await read(async () => (await api.distribuicao()).body)).map(distributionOf);
    },
    async queryAccessKey(ctx, input) {
      const api = await client(ctx);
      // Sem nova tentativa automática: cada consulta gasta a cota do CNPJ.
      try {
        const r = await api.consultarChave({
          chaveAcesso: input.access_key,
          ...(input.environment ? { ambiente: input.environment } : {}),
          ...(input.cnpj ? { cnpj: input.cnpj } : {}),
        });
        return toReceived(r.body);
      } catch (error) {
        throw fiscalError(error);
      }
    },
    async series(ctx) {
      const api = await client(ctx);
      const list = await read(async () => (await api.series()).body);
      return list.map((s) => ({
        kind: s.modelo ?? "nfe",
        environment: s.ambiente ?? "homologacao",
        series: s.serie ?? 0,
        next_number: s.proximoNumero ?? 1,
        description: s.descricao ?? null,
        cnpj: s.cnpj ?? "",
      }));
    },
    async state(ctx) {
      const api = await client(ctx);
      return stateFromCofre(await read(async () => (await api.cofre()).body));
    },
    async sefazStatus(ctx, input) {
      const api = await client(ctx);
      const s = await read(async () =>
        (await api.sefazStatus({ uf: input.uf, modelo: input.kind, ambiente: input.environment })).body,
      );
      return {
        in_operation: !!s.emOperacao,
        authorizer: s.autorizador ?? "",
        message: s.mensagem?.codigo ? { code: s.mensagem.codigo, description: s.mensagem.descricao ?? "" } : null,
        average_seconds: s.tempoMedioSegundos ?? null,
      };
    },
  };
  return provider;
}

/** GET /v1/cofre → estado neutro para o painel. */
export function stateFromCofre(c: import("./contract/types.generated.ts").Cofre): FiscalProviderState {
  const cert = c.certificado ?? null;
  return {
    provider: NFAPI_PROVIDER_ID,
    version: c.versao ?? "",
    update: { published: c.atualizacao?.versaoPublicada ?? null, pending: !!c.atualizacao?.pendente },
    certificate: cert
      ? {
          holder: cert.titular ?? "",
          document: cert.documento?.kind && cert.documento.id ? { kind: cert.documento.kind, id: cert.documento.id } : null,
          valid_until: cert.validoAte ?? "",
          days_left: typeof cert.diasRestantes === "number" ? cert.diasRestantes : 0,
        }
      : null,
    production_released: !!c.producaoLiberada,
    key: { scope: c.chave?.escopo ?? null, environments: c.chave?.ambientes ?? [] },
    documents: {
      nfse: !!c.documentos?.nfse,
      nfe: c.documentos?.nfe?.ufs ?? null,
      nfce: c.documentos?.nfce?.ufs ?? null,
    },
    contingency: c.contingencia ? { pending_notes: c.contingencia.notasPendentes ?? 0 } : null,
    logo: typeof c.logotipo === "boolean" ? c.logotipo : null,
  };
}

export type { FiscalMessage };
