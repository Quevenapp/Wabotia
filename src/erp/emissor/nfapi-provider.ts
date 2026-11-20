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
  NotaEmitida,
  Relatorio,
  Exportacao,
  ValoresFiscais,
} from "./contract/types.generated.ts";
import {
  NfapiClient,
  NfapiError,
  NfapiOutdatedError,
  NfapiTransportError,
  olderThan,
  EMISSION_MIN_VERSION,
  type NfapiDoc,
  type NfapiFile,
  type ExportacaoItem,
} from "./nfapi.ts";
import {
  FiscalError,
  type FiscalContext,
  type FiscalContingencyMode,
  type FiscalContingencyState,
  type FiscalDistributionState,
  type FiscalEmitOptions,
  type FiscalEnvironment,
  type FiscalExport,
  type FiscalExportItem,
  type FiscalCount,
  type FiscalIssuedNote,
  type FiscalReport,
  type FiscalReportWarning,
  type FiscalTaxTotals,
  type FiscalFile,
  type FiscalKey,
  type FiscalKind,
  type FiscalLookupIdentity,
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
import { emissorConnection, fiscalConnectionFingerprint } from "./config.ts";

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
const OPEN: ReadonlySet<FiscalStatus> = new Set(["processing", "authorized", "contingency", "undetermined", "error"]);

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

type Emission = EmissaoNfe | EmissaoNfse;
type ExpectedEmission = Partial<FiscalLookupIdentity> & { provider_ref?: string };

/** Não transforma uma resposta de outro vínculo em evidência desta emissão. */
function checkedEmission<T extends Emission>(kind: FiscalKind, emission: T, expected: ExpectedEmission = {}, envelopeKind?: FiscalKind | null): T {
  const object = emission && typeof emission === "object";
  const model = object && "modelo" in emission ? emission.modelo : object && typeof emission.serie === "string" ? "nfse" : null;
  const valid = object && model === kind && (!envelopeKind || envelopeKind === kind) &&
    typeof emission.id === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(emission.id) &&
    (emission.ambiente === "homologacao" || emission.ambiente === "producao") &&
    (expected.provider_ref === undefined || emission.id === expected.provider_ref) &&
    (expected.environment === undefined || emission.ambiente === expected.environment) &&
    (expected.access_key === undefined || emission.chaveAcesso === expected.access_key) &&
    (expected.reference === undefined || emission.referencia === expected.reference);
  if (!valid)
    throw new FiscalError(409, "fiscal_response_identity_mismatch",
      "O cofre devolveu uma emissão com modelo, ambiente, referência, identificador ou chave diferente do vínculo esperado. Consulte a operação original.",
      { unverified_emission: emission, retryable: false });
  return emission;
}

const identityOf = (emission: Emission): ExpectedEmission => ({
  environment: emission.ambiente,
  ...(emission.referencia === null || emission.referencia === undefined ? {} : { reference: emission.referencia }),
  provider_ref: emission.id,
  ...(["autorizada", "contingencia", "cancelada", "denegada"].includes(emission.situacao) && emission.chaveAcesso ? { access_key: emission.chaveAcesso } : {}),
});

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

// ----- Relatórios e exportação (0.11.0) -----

/** Intervalo sugerido para repetir o relatório ou consultar a exportação em preparo. */
export const REPORT_RETRY_MS = 1_500;
const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(value: unknown, field: string) {
  if (typeof value !== "string" || !ISO_DAY.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new FiscalError(400, "fiscal_invalid_request", `${field}: data AAAA-MM-DD.`, { field });
  return value;
}

/** Período do relatório e da exportação: de ≤ até, no máximo 366 dias. */
function periodOf(input: { environment?: unknown; from?: unknown; to?: unknown }) {
  if (input.environment !== "homologacao" && input.environment !== "producao")
    throw new FiscalError(400, "fiscal_invalid_request", "environment: homologacao ou producao.", { field: "environment" });
  const de = dayOf(input.from, "from");
  const ate = dayOf(input.to, "to");
  const days = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1) throw new FiscalError(400, "fiscal_invalid_request", "O período termina antes de começar.", { field: "to" });
  if (days > 366) throw new FiscalError(400, "fiscal_invalid_request", "O período vai até 366 dias.", { field: "to" });
  return { ambiente: input.environment as FiscalEnvironment, de, ate };
}

const STATUS_TO_SITUACAO = Object.fromEntries(Object.entries(SITUACAO).map(([k, v]) => [v, k])) as Record<
  FiscalStatus,
  NonNullable<NotaEmitida["situacao"]>
>;

export function toIssued(n: NotaEmitida): FiscalIssuedNote {
  return {
    provider_ref: n.id ?? "",
    kind: n.modelo ?? "nfe",
    environment: n.ambiente ?? "homologacao",
    reference: n.referencia ?? null,
    series: n.serie ?? "",
    number: n.numero ?? null,
    dps_number: n.numeroDps ?? null,
    status: (n.situacao && SITUACAO[n.situacao]) || "undetermined",
    access_key: n.chaveAcesso ?? null,
    protocol: n.protocolo ?? null,
    issued_at: n.emitidaEm ?? null,
    total: n.valor ?? null,
    recipient: n.destinatario ? { document: n.destinatario.documento ?? null, name: n.destinatario.nome ?? null } : null,
    xml_available: !!n.xmlDisponivel,
  };
}

function taxesOf(v: ValoresFiscais | undefined): FiscalTaxTotals {
  const n = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    total: n(v?.total), products: n(v?.produtos), services: n(v?.servicos), discount: n(v?.desconto),
    freight: n(v?.frete), insurance: n(v?.seguro), other: n(v?.outras), icms: n(v?.icms), icms_st: n(v?.icmsSt),
    fcp: n(v?.fcp), ipi: n(v?.ipi), pis: n(v?.pis), cofins: n(v?.cofins), ii: n(v?.ii), iss: n(v?.iss),
    ibs: n(v?.ibs), cbs: n(v?.cbs), is: n(v?.is),
  };
}

const countOf = (x: { quantidade?: number; valor?: number } | undefined): FiscalCount => ({
  count: x?.quantidade ?? 0,
  amount: x?.valor ?? 0,
});

export function toReport(r: Relatorio, asked: { ambiente: FiscalEnvironment; de: string; ate: string }): FiscalReport {
  const e = r.emitidas ?? {};
  const rec = r.recebidas ?? {};
  const pending = r.notasPorLer ?? 0;
  const byStatus = (e.porSituacao ?? []).map((s) => ({
    ...countOf(s),
    kind: s.modelo ?? "nfe",
    status: (s.situacao && SITUACAO[s.situacao]) || ("undetermined" as FiscalStatus),
  }));
  const warnings: FiscalReportWarning[] = [];
  if (pending > 0)
    warnings.push({
      code: "pending_reads",
      message: `${pending} ${pending === 1 ? "nota ainda não lida" : "notas ainda não lidas"} pelo emissor: impostos, CFOP e natureza estão incompletos. O relatório se completa ao pedir de novo.`,
    });
  if (byStatus.some((s) => s.kind === "nfse"))
    warnings.push({
      code: "nfse_ibs_cbs_not_read",
      message: "IBS e CBS da NFS-e ainda não são lidos pelo emissor: aparecem zerados nos impostos.",
    });
  return {
    environment: r.ambiente ?? asked.ambiente,
    period: { from: r.periodo?.de ?? asked.de, to: r.periodo?.ate ?? asked.ate },
    pending_reads: pending,
    complete: pending === 0,
    retry_after_ms: pending > 0 ? REPORT_RETRY_MS : null,
    warnings,
    issued: {
      by_status: byStatus,
      authorized: { ...countOf(e.autorizadas), taxes: taxesOf(e.autorizadas?.impostos) },
      by_day: (e.porDia ?? []).map((d) => ({ ...countOf(d), day: d.dia ?? "" })),
      by_cfop: (e.porCfop ?? []).map((c) => ({ ...countOf(c), cfop: c.cfop ?? "" })),
      by_nature: (e.porNatureza ?? []).map((c) => ({ ...countOf(c), nature: c.natureza ?? "" })),
      by_recipient: (e.porDestinatario ?? []).map((c) => ({ ...countOf(c), document: c.documento ?? null, name: c.nome ?? null })),
    },
    received: {
      by_status: (rec.porSituacao ?? []).map((s) => ({ ...countOf(s), status: s.situacao ?? "" })),
      authorized: {
        ...countOf(rec.autorizadas),
        with_xml: rec.autorizadas?.comXml ?? 0,
        taxes: taxesOf(rec.autorizadas?.impostos),
      },
      as_third_party: rec.comoTerceiro ?? 0,
      by_cfop: (rec.porCfop ?? []).map((c) => ({ ...countOf(c), cfop: c.cfop ?? "" })),
      by_issuer: (rec.porEmitente ?? []).map((c) => ({ ...countOf(c), document: c.documento ?? null, name: c.nome ?? null })),
    },
  };
}

const EXPORT_ITEM: Record<FiscalExportItem, ExportacaoItem> = {
  nfse: "nfse",
  nfe: "nfe",
  nfce: "nfce",
  events: "eventos",
  void_ranges: "inutilizacoes",
  received: "recebidas",
};
const EXPORT_ITEM_BACK = Object.fromEntries(Object.entries(EXPORT_ITEM).map(([k, v]) => [v, k])) as Record<ExportacaoItem, FiscalExportItem>;

/**
 * Link assinado repassado como veio. Só é aceito se sair do próprio cofre
 * (mesma origem): o ERP entrega o link ao navegador e nunca o abre.
 */
function linkOf(url: unknown, vaultOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new FiscalError(502, "fiscal_provider_error", "O emissor devolveu um link de exportação inválido.");
  }
  if (parsed.origin !== vaultOrigin)
    throw new FiscalError(502, "fiscal_provider_error", "O emissor devolveu um link de exportação fora do endereço do cofre.");
  return String(url);
}

export function toExport(x: Exportacao, vaultOrigin: string): FiscalExport {
  const preparing = x.situacao !== "pronta";
  const contents: Record<string, number> = {};
  for (const [k, v] of Object.entries(x.conteudo ?? {})) if (typeof v === "number") contents[k] = v;
  return {
    provider_ref: x.id ?? "",
    environment: x.ambiente ?? "homologacao",
    period: { from: x.periodo?.de ?? "", to: x.periodo?.ate ?? "" },
    include: (x.incluir ?? []).map((i) => EXPORT_ITEM_BACK[i]).filter(Boolean),
    status: preparing ? "preparing" : "ready",
    pending_reads: x.notasPorLer ?? 0,
    files: x.arquivos ?? 0,
    contents,
    parts: preparing
      ? []
      : (x.partes ?? []).filter((p) => p.url).map((p) => ({ part: p.parte ?? 0, name: p.nome ?? "", url: linkOf(p.url, vaultOrigin) })),
    spreadsheet: !preparing && x.planilha?.url ? { name: x.planilha.nome ?? "", url: linkOf(x.planilha.url, vaultOrigin) } : null,
    links_valid_until: x.linksValemAte ?? null,
    created_at: x.criadaEm ?? null,
    expires_at: x.expiraEm ?? null,
    retry_after_ms: preparing ? REPORT_RETRY_MS : null,
  };
}

const toFile = (f: NfapiFile): FiscalFile =>({ content_type: f.contentType, size: f.size, body: f.body });

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
  // Download da exportação (0.11.0): só o navegador baixa; link vencido pede
  // nova consulta da exportação (links novos).
  link_invalido: [410, "fiscal_export_link_expired", true],
  sem_resposta_conclusiva: [503, "fiscal_no_conclusive_answer", true],
  // Só aparece em GET /v1/sefaz/status, dentro de mensagem.codigo (não é erro HTTP).
  sem_conexao: [503, "fiscal_provider_unavailable", true],
  erro_interno: [503, "fiscal_provider_unavailable", true],
  cofre_nao_configurado: [409, "fiscal_provider_not_ready", false],
};

/** Converte qualquer falha do cliente em FiscalError (preserva o resto). */
export function fiscalError(error: unknown, kind: FiscalKind | null = null, expected: ExpectedEmission = {}): unknown {
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
    const emissionKind = kind ?? error.emissionKind;
    if (emission && emissionKind) {
      try { checkedEmission(emissionKind, emission, expected, error.emissionKind); }
      catch (mismatch) { return mismatch; }
    }
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
  /** Relógio de timeout do transporte, injetável em testes determinísticos. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createNfapiProvider(options: NfapiProviderOptions = {}): FiscalProvider {
  const delays = options.delays ?? [0, 1_500, 4_000];
  const sleep = options.sleep ?? defaultSleep;

  async function client(ctx: FiscalContext) {
    const conn = await emissorConnection(ctx.env, ctx.profile);
    if (!conn || conn.provider !== NFAPI_PROVIDER_ID) throw providerNotConfigured();
    const api = new NfapiClient({ url: conn.url, apiKey: conn.api_key, fetch: ctx.fetch, timeoutSignal: options.timeoutSignal });
    if (ctx.connection_fingerprint !== undefined) {
      const state = await read(() => api.cofre());
      const issuer = state.body.certificado?.documento?.id;
      const fingerprint = issuer ? await fiscalConnectionFingerprint({ provider: conn.provider, url: conn.url, issuer_document: issuer }) : null;
      if (fingerprint !== ctx.connection_fingerprint)
        throw new FiscalError(409, "fiscal_connection_changed", "Esta emissão pertence a outro cofre. Restabeleça a conexão original para consultar o resultado.");
    }
    return api;
  }

  /** Leitura com uma nova tentativa só para falha de transporte. */
  async function read<T>(run: () => Promise<T>, kind: FiscalKind | null = null, expected: ExpectedEmission = {}): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NfapiTransportError && error.kind !== "same_zone")
        try {
          return await run();
        } catch (again) {
          throw fiscalError(again, kind, expected);
        }
      throw fiscalError(error, kind, expected);
    }
  }

  const nfeLike = (kind: FiscalKind): kind is "nfe" | "nfce" => kind === "nfe" || kind === "nfce";

  /** Emissões da referência; a referência é única por ambiente. */
  async function byReference(api: NfapiClient, kind: FiscalKind, reference: string, ambiente?: FiscalEnvironment) {
    if (ambiente !== undefined && ambiente !== "homologacao" && ambiente !== "producao")
      throw new FiscalError(400, "fiscal_invalid_request", "Ambiente inválido (homologacao ou producao).", { field: "environment" });
    const list = (await api.listar(kind as NfapiDoc, { referencia: reference, ambiente, limite: 10 })).body;
    const identities = new Set<string>();
    for (const e of list) {
      checkedEmission(kind, e, { reference, environment: ambiente });
      const key = `${e.ambiente}:${e.referencia}`;
      if (identities.has(key))
        throw new FiscalError(409, "fiscal_response_identity_mismatch", "O cofre devolveu mais de uma emissão para a mesma referência e ambiente.", { unverified_emission: list });
      identities.add(key);
    }
    return list;
  }

  /** Fecha uma emissão indefinida consultando a SEFAZ (NF-e/NFC-e). */
  async function settle(api: NfapiClient, kind: FiscalKind, e: EmissaoNfe | EmissaoNfse) {
    if (e.situacao !== "indefinida" || !nfeLike(kind)) return e;
    try {
      return checkedEmission(kind, (await api.consultar(kind, e.id)).body, identityOf(e));
    } catch (error) {
      if (error instanceof NfapiError && error.emissao)
        return checkedEmission(kind, error.emissao, identityOf(e), error.emissionKind);
      if (error instanceof NfapiTransportError || (error instanceof NfapiError && error.status >= 500)) return e;
      throw error;
    }
  }

  /**
   * Versão nova só depois de a anterior ser cancelada (ou denegada, que
   * consome o número). Rejeitada conclusivamente aceita conteúdo novo
   * com a mesma referência. Qualquer versão anterior com erro, nota
   * válida ou sem conclusão bloqueia.
   */
  async function previousVersionsClosed(api: NfapiClient, kind: FiscalKind, key: FiscalKey, ambiente: FiscalEnvironment) {
    for (let version = 1; version < key.version; version++) {
      const reference = fiscalReference({ document_id: key.document_id, version });
      for (const found of await byReference(api, kind, reference, ambiente)) {
        const settled = await settle(api, kind, found);
        const result = toResult(kind, settled);
        if (result.status === "rejected")
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
    if (environment !== "homologacao" && environment !== "producao")
      throw new FiscalError(400, "fiscal_invalid_request", "Ambiente inválido (homologacao ou producao).", { field: "ambiente" });
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
    const expected: ExpectedEmission = { reference, environment };
    let known: Emission | null = null;
    const remember = (emission: Emission, envelopeKind?: FiscalKind | null) => {
      const checked = checkedEmission(kind, emission, expected, envelopeKind);
      if (known && (["autorizada", "cancelada", "denegada"].includes(known.situacao)) &&
          checked.situacao !== known.situacao && !(known.situacao === "autorizada" && checked.situacao === "cancelada"))
        throw new FiscalError(409, "fiscal_response_state_conflict", "O cofre devolveu uma situação incompatível com a emissão já confirmada.", {
          emission: toResult(kind, known, true), unverified_emission: checked,
        });
      expected.provider_ref = checked.id;
      const identity = identityOf(checked);
      if (identity.access_key) expected.access_key = identity.access_key;
      known = checked;
      return checked;
    };
    const mine = async () => {
      const found = (await byReference(api, kind, reference, environment))[0];
      return found ? remember(found) : null;
    };
    try {
      await read(() => api.exigirVersao(`POST /v1/${kind}`, EMISSION_MIN_VERSION), kind);
      await previousVersionsClosed(api, kind, key, environment);
      const existing = await read(mine, kind, expected);
      if (existing?.situacao === "erro")
        throw new FiscalError(409, "fiscal_emission_not_revisable",
          "A emissão anterior está com erro sem rejeição conclusiva. Consulte o mesmo vínculo antes de corrigir o corpo.",
          { emission: toResult(kind, existing, true), retryable: true });
      if (existing?.situacao === "processando") return toResult(kind, existing, true);
      if (existing?.situacao === "indefinida" && nfeLike(kind)) {
        const settled = remember(await settle(api, kind, existing));
        if (settled.situacao !== "rejeitada") return toResult(kind, settled, true);
      }
      // NFS-e não possui /consultar de emissão: a recuperação legada é o
      // mesmo POST/referência. O cofre recusa conteúdo diferente enquanto
      // indefinida; /conferir trata somente cancelamento externo.
      let last: EmissaoNfe | EmissaoNfse | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (attempt > 0 && delays[attempt]) await sleep(delays[attempt]);
        try {
          const response = await api.emitir(kind as NfapiDoc, body as never);
          return toResult(kind, remember(response.body), response.status === 200);
        } catch (error) {
          lastError = error;
          const evidence = error instanceof NfapiError && error.emissao ? remember(error.emissao, error.emissionKind) : null;
          if (evidence) last = evidence;
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
            // A emissão no próprio erro também é evidência: não a descarte
            // para depender de uma listagem que pode falhar ou estar atrasada.
            const found = evidence ?? await read(mine, kind, expected);
            if (!found) continue;
            last = remember(await settle(api, kind, found));
            if (last.situacao === "indefinida") continue;
            if (last.situacao === "erro") throw fiscalError(error, kind, expected);
            return toResult(kind, last, true);
          }
          if (!(error instanceof NfapiError)) throw error;
          if (error.codigo === "sem_resposta_conclusiva") {
            // NF-e/NFC-e: /consultar. NFS-e não tem consulta: só a repetição
            // com a mesma referência fecha (o cofre consulta antes de reenviar).
            const pending = evidence ?? (await read(mine, kind, expected));
            if (pending) {
              last = remember(await settle(api, kind, pending));
              if (last.situacao !== "indefinida") return toResult(kind, last, true);
            }
            continue;
          }
          if (error.codigo === "emissao_em_andamento") {
            const found = evidence ?? await read(mine, kind, expected);
            if (found) return toResult(kind, found, true);
            throw error;
          }
          // Rejeição, denegação ou erro antes de transmitir: resultado com a
          // emissão, salvo rejeição de cadastro (não adianta repetir): erro.
          if (error.status === 422 && evidence && (evidence.situacao === "rejeitada" || evidence.situacao === "denegada")) {
            const rejected = toResult(kind, evidence);
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
      const converted = fiscalError(error, kind, expected);
      if (known && converted instanceof FiscalError && !converted.details.emission && !converted.details.unverified_emission)
        converted.details.emission = toResult(kind, known, true);
      throw converted;
    }
  }

  /** Evento (cancelamento, carta): repete uma vez se a resposta não foi conclusiva. */
  async function event(
    ctx: FiscalContext,
    kind: FiscalKind,
    ref: string,
    run: (api: NfapiClient) => Promise<(EmissaoNfe | EmissaoNfse) & { repetido?: boolean }>,
    done: (e: EmissaoNfe | EmissaoNfse, before: EmissaoNfe | EmissaoNfse | null) => boolean,
    identity?: FiscalLookupIdentity,
  ) {
    const api = await client(ctx);
    const expected: ExpectedEmission = { ...identity, provider_ref: ref };
    let before = checkedEmission(kind,
      await read(async () => (await api.obter(kind as NfapiDoc, ref)).body, kind, expected), expected);
    Object.assign(expected, identityOf(before));
    let evidence: Emission | null = before;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = checkedEmission(kind, await run(api), expected);
        if (!done(result, before))
          throw new FiscalError(503, "fiscal_no_conclusive_answer", "O cofre ainda não confirmou o evento fiscal.", {
            emission: toResult(kind, result), retryable: true,
          });
        return toResult(kind, result);
      } catch (error) {
        if (error instanceof NfapiError && error.emissao)
          evidence = checkedEmission(kind, error.emissao, expected, error.emissionKind);
        const inconclusive =
          error instanceof NfapiTransportError
            ? error.kind !== "same_zone"
            : error instanceof NfapiError && (error.codigo === "sem_resposta_conclusiva" || error.status >= 500);
        if (!inconclusive || attempt > 0) {
          const converted = fiscalError(error, kind, expected);
          if (evidence && converted instanceof FiscalError && !converted.details.emission && !converted.details.unverified_emission)
            converted.details.emission = toResult(kind, evidence, true);
          throw converted;
        }
        if (evidence && done(evidence, before)) return toResult(kind, evidence, true);
        // O cofre só grava o evento com a resposta do governo: se ele já
        // consta, devolve; senão repete (a SEFAZ trata duplicidade).
        let now: Emission | null = null;
        try { now = checkedEmission(kind, (await api.obter(kind as NfapiDoc, ref)).body, expected); }
        catch (lookupError) {
          if (!(lookupError instanceof NfapiTransportError)) throw fiscalError(lookupError, kind, expected);
        }
        if (now && done(now, before)) return toResult(kind, now, true);
        if (now) { before = now; evidence = now; }
      }
    }
  }

  const provider: FiscalProvider = {
    id: NFAPI_PROVIDER_ID,
    name: "NFapi (cofre do emitente)",
    kinds: ["nfe", "nfce", "nfse"],
    contingency: ["automatic", "forced"],
    emit,
    async find(ctx, kind, key, environment) {
      const reference = fiscalReference(key);
      const api = await client(ctx);
      const list = await read(() => byReference(api, kind, reference, environment), kind, { reference, environment });
      if (list.length > 1)
        throw new FiscalError(409, "fiscal_environment_required", "Informe o ambiente para consultar esta referência, presente em mais de um ambiente.");
      return list[0] ? toResult(kind, list[0], true) : null;
    },
    async get(ctx, kind, ref, identity) {
      const api = await client(ctx);
      const expected = { ...identity, provider_ref: ref };
      return toResult(kind, checkedEmission(kind,
        await read(async () => (await api.obter(kind as NfapiDoc, ref)).body, kind, expected), expected));
    },
    async reconcile(ctx, kind, ref, identity) {
      if (!nfeLike(kind))
        throw new FiscalError(422, "fiscal_not_supported", "A consulta à SEFAZ existe só para NF-e e NFC-e.");
      const api = await client(ctx);
      const expected = { ...identity, provider_ref: ref };
      return toResult(kind, checkedEmission(kind,
        await read(async () => (await api.consultar(kind, ref)).body, kind, expected), expected));
    },
    async xml(ctx, kind, ref) {
      const api = await client(ctx);
      return read(async () => (await api.xml(kind as NfapiDoc, ref)).body, kind);
    },
    cancel(ctx, kind, ref, input, identity) {
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
        identity,
      );
    },
    correct(ctx, ref, text) {
      return event(
        ctx,
        "nfe",
        ref,
        async (api) => (await api.cartaCorrecao(ref, { correcao: text })).body,
        // Repetição confirmada pelo cofre não incrementa a sequência. Fora
        // dela, o avanço em relação à leitura anterior comprova a carta.
        (e, before) => ("repetido" in e && e.repetido === true) ||
          (!!before && ((e as EmissaoNfe).cartasCorrecao ?? 0) > ((before as EmissaoNfe).cartasCorrecao ?? 0)),
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
    async issued(ctx, filter = {}) {
      const page = filter.page ?? 1;
      const perPage = filter.per_page ?? 50;
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 200)
        throw new FiscalError(400, "fiscal_invalid_request", "page: inteiro ≥ 1; per_page: de 1 a 200.", { field: "per_page" });
      if (filter.kind !== undefined && !["nfe", "nfce", "nfse"].includes(filter.kind))
        throw new FiscalError(400, "fiscal_invalid_request", "kind: nfe, nfce ou nfse.", { field: "kind" });
      if (filter.status !== undefined && !STATUS_TO_SITUACAO[filter.status])
        throw new FiscalError(400, "fiscal_invalid_request", "Situação desconhecida.", { field: "status" });
      const api = await client(ctx);
      const body = await read(async () =>
        (await api.notas({
          de: filter.from === undefined ? undefined : dayOf(filter.from, "from"),
          ate: filter.to === undefined ? undefined : dayOf(filter.to, "to"),
          modelo: filter.kind,
          situacao: filter.status && STATUS_TO_SITUACAO[filter.status],
          ambiente: filter.environment,
          busca: filter.search?.trim() || undefined,
          pagina: page,
          porPagina: perPage,
        })).body,
      );
      return { items: body.notas.map(toIssued), total: body.total, amount: body.valor, page: body.pagina, per_page: body.porPagina };
    },
    async report(ctx, input) {
      const asked = periodOf(input);
      const api = await client(ctx);
      return toReport(await read(async () => (await api.relatorio(asked)).body), asked);
    },
    async exportCreate(ctx, input) {
      const asked = periodOf(input);
      const include = input.include;
      if (include !== undefined && (!Array.isArray(include) || !include.length || include.some((i) => !EXPORT_ITEM[i])))
        throw new FiscalError(400, "fiscal_invalid_request", "include: nfse, nfe, nfce, events, void_ranges ou received.", { field: "include" });
      const api = await client(ctx);
      // Sem nova tentativa automática: um POST repetido criaria outra exportação.
      try {
        const r = await api.exportar({ ...asked, ...(include ? { incluir: [...new Set(include)].map((i) => EXPORT_ITEM[i]) } : {}) });
        return toExport(r.body, api.origin);
      } catch (error) {
        throw fiscalError(error);
      }
    },
    async exportGet(ctx, ref) {
      const api = await client(ctx);
      try {
        return toExport(await read(async () => (await api.exportacao(ref)).body), api.origin);
      } catch (error) {
        if (error instanceof FiscalError && error.details.provider_code === "nao_encontrado")
          throw new FiscalError(404, "fiscal_export_not_found", "Exportação inexistente: ela é apagada 24 horas depois de criada. Crie outra.", {
            provider_code: "nao_encontrado",
          });
        throw error;
      }
    },
    async exports(ctx) {
      const api = await client(ctx);
      return (await read(async () => (await api.exportacoes()).body)).map((x) => toExport(x, api.origin));
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
