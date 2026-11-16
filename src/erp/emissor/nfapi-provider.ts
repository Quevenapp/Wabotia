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
import type { EmissaoNfe, EmissaoNfse } from "./contract/types.generated.ts";
import { NfapiClient, NfapiError, NfapiTransportError, type NfapiDoc } from "./nfapi.ts";
import {
  FiscalError,
  type FiscalContext,
  type FiscalEmitOptions,
  type FiscalEnvironment,
  type FiscalKey,
  type FiscalKind,
  type FiscalMessage,
  type FiscalProvider,
  type FiscalProviderState,
  type FiscalResult,
  type FiscalStatus,
  providerNotConfigured,
} from "./provider.ts";
import { emissorConnection } from "./config.ts";

export const NFAPI_PROVIDER_ID = "nfapi";

const SITUACAO: Record<EmissaoNfe["situacao"] | EmissaoNfse["situacao"], FiscalStatus> = {
  processando: "processing",
  autorizada: "authorized",
  rejeitada: "rejected",
  denegada: "denied",
  erro: "error",
  indefinida: "undetermined",
  cancelada: "cancelled",
};
/** Situações do contrato que o provedor conhece (o teste confere com o enum). */
export const KNOWN_SITUACOES = Object.keys(SITUACAO);

/** Situações em que já existe (ou pode existir) uma nota válida. */
const OPEN: ReadonlySet<FiscalStatus> = new Set(["processing", "authorized", "undetermined"]);

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

export function toResult(kind: FiscalKind, e: EmissaoNfe | EmissaoNfse, replayed = false): FiscalResult {
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
    contingency: null,
  };
}

// ---------------------------------------------------------------------------
// Erros do cofre → erros do ERP

/** Código do cofre → [status HTTP do Wabotia, código do ERP, pode repetir]. */
export const ERROR_MAP: Record<string, [number, string, boolean]> = {
  requisicao_invalida: [422, "fiscal_invalid_request", false],
  nao_autenticado: [409, "fiscal_provider_unauthorized", false],
  chave_somente_homologacao: [409, "fiscal_key_homologation_only", false],
  host_nao_permitido: [502, "fiscal_provider_error", false],
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
  cancelamento_rejeitado: [422, "fiscal_rejected", false],
  carta_rejeitada: [422, "fiscal_rejected", false],
  inutilizacao_rejeitada: [422, "fiscal_rejected", false],
  carta_nao_se_aplica: [422, "fiscal_correction_not_applicable", false],
  limite_de_cartas: [422, "fiscal_correction_limit", false],
  sem_resposta_conclusiva: [503, "fiscal_no_conclusive_answer", true],
  container_indisponivel: [503, "fiscal_provider_unavailable", true],
  sem_conexao: [503, "fiscal_provider_unavailable", true],
};

/** Converte qualquer falha do cliente em FiscalError (preserva o resto). */
export function fiscalError(error: unknown, kind: FiscalKind | null = null): unknown {
  if (error instanceof FiscalError) return error;
  if (error instanceof NfapiTransportError) {
    if (error.kind === "same_zone")
      return new FiscalError(
        502,
        "fiscal_provider_same_zone",
        "A Cloudflare recusou a chamada do Wabotia ao cofre (erro 1042). Instale o cofre em outra zona ou ligue a flag global_fetch_strictly_public no Wabotia.",
        { retryable: false },
      );
    return new FiscalError(503, "fiscal_provider_unreachable", error.message, { retryable: true });
  }
  if (error instanceof NfapiError) {
    const known = ERROR_MAP[error.codigo];
    const [status, code, retryable] =
      known ?? (error.status >= 500 ? [503, "fiscal_provider_unavailable", true] : [422, "fiscal_provider_rejected", false]);
    const emission = error.emissao;
    const emissionKind = kind ?? (emission && "idDps" in emission ? "nfse" : null);
    return new FiscalError(status, code, error.message, {
      provider_code: error.codigo,
      field: error.campo,
      messages: error.mensagens.map((m) => ({ code: m.codigo, description: m.descricao })),
      emission: emission && emissionKind ? toResult(emissionKind, emission) : null,
      retryable,
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

  /** Emissões da referência (o cofre separa por ambiente). */
  async function byReference(api: NfapiClient, kind: FiscalKind, reference: string) {
    return (await api.listar(kind as NfapiDoc, { referencia: reference, limite: 10 })).body.filter(
      (e) => e.referencia === reference,
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

  async function previousVersionsClosed(api: NfapiClient, kind: FiscalKind, key: FiscalKey) {
    for (let version = 1; version < key.version; version++) {
      const reference = fiscalReference({ document_id: key.document_id, version });
      for (const found of await byReference(api, kind, reference)) {
        const settled = await settle(api, kind, found);
        const result = toResult(kind, settled);
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
    if (options.contingency)
      throw new FiscalError(
        422,
        "fiscal_contingency_not_supported",
        "O emissor NFapi ainda não emite em contingência: emita quando a SEFAZ voltar.",
      );
    const reference = fiscalReference(key);
    if (request.referencia !== undefined && request.referencia !== reference)
      throw new FiscalError(400, "fiscal_invalid_request", "A referência do pedido é definida pelo ERP a partir do documento.", {
        field: "referencia",
      });
    const environment = (request.ambiente ?? "homologacao") as FiscalEnvironment;
    const body = { ...request, referencia: reference };
    const api = await client(ctx);
    const mine = (list: (EmissaoNfe | EmissaoNfse)[]) => list.find((e) => e.ambiente === environment) ?? null;
    try {
      await previousVersionsClosed(api, kind, key);
      let last: EmissaoNfe | EmissaoNfse | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (attempt > 0 && delays[attempt]) await sleep(delays[attempt]);
        try {
          const response = await api.emitir(kind as NfapiDoc, body as never);
          return toResult(kind, response.body, response.status === 200);
        } catch (error) {
          lastError = error;
          if (error instanceof NfapiTransportError) {
            if (error.kind === "same_zone") throw error;
            // Resposta perdida: o cofre pode ter emitido. Procura antes de repetir.
            const found = mine(await byReference(api, kind, reference).catch(() => []));
            if (!found) continue;
            last = await settle(api, kind, found);
            if (last.situacao === "indefinida") continue;
            return toResult(kind, last, true);
          }
          if (!(error instanceof NfapiError)) throw error;
          if (error.codigo === "sem_resposta_conclusiva") {
            const pending = error.emissao ?? mine(await byReference(api, kind, reference).catch(() => []));
            if (pending) {
              last = await settle(api, kind, pending);
              if (last.situacao !== "indefinida") return toResult(kind, last, true);
            }
            continue;
          }
          if (error.codigo === "emissao_em_andamento") {
            const found = mine(await byReference(api, kind, reference));
            if (found) return toResult(kind, found, true);
            throw error;
          }
          if (error.codigo === "container_indisponivel" || error.codigo === "sem_conexao") continue;
          // Rejeição, denegação ou erro antes de transmitir: resultado com a emissão.
          if (error.status === 422 && error.emissao) return toResult(kind, error.emissao);
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
    run: (api: NfapiClient) => Promise<EmissaoNfe | EmissaoNfse>,
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
    contingency: [],
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
      // Sem nova tentativa automática: uma inutilização repetida pode ser
      // recusada pela SEFAZ como faixa já inutilizada.
      try {
        const { body } = await api.inutilizar({
          modelo: input.kind,
          ambiente: input.environment,
          serie: input.series,
          numeroInicial: input.first,
          numeroFinal: input.last,
          justificativa: input.justification,
          uf: input.uf as never,
          ...(input.cnpj ? { cnpj: input.cnpj } : {}),
        });
        return {
          provider_ref: body.id ?? "",
          kind: body.modelo ?? input.kind,
          environment: body.ambiente ?? input.environment ?? "homologacao",
          series: body.serie ?? input.series,
          first: body.numeroInicial ?? input.first,
          last: body.numeroFinal ?? input.last,
          protocol: body.protocolo ?? null,
          created_at: body.criadaEm ?? null,
        };
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
  };
}

export type { FiscalMessage };
