// Interface de provedor fiscal do ERP. O ERP (domínio Fiscal, ainda não
// portado) fala só com FiscalProvider; a NFapi é a única implementação
// (nfapi-provider.ts). Adaptada de src/modules/vendas/fiscal.ts
// (feat/modulo-vendas), com o que o cofre oferece: consulta, XML, carta de
// correção, inutilização, séries e estado.
//
// Regras que todo provedor cumpre:
// - `key` identifica o documento do ERP (id e versão). A mesma chave nunca
//   gera duas notas, em qualquer número de repetições.
// - Uma versão nova do mesmo documento só é emitida quando as anteriores
//   estão encerradas por cancelamento ou denegação. Rejeição conclusiva
//   permite corrigir na mesma referência; erro não libera revisão.
// - Erro sobe como FiscalError, com o código do ERP (`fiscal_*`), o código
//   original do provedor, o campo recusado e as mensagens do governo.
import { ApiError, type Env } from "../../types";

export type FiscalKind = "nfe" | "nfce" | "nfse";
export type FiscalEnvironment = "homologacao" | "producao";

/** Situação da emissão, neutra (o cofre usa os nomes em português). */
export type FiscalStatus =
  | "processing"
  | "authorized"
  | "rejected"
  | "denied"
  | "error"
  | "undetermined"
  | "cancelled"
  /**
   * NFC-e emitida em contingência offline (tipo de emissão 9), ainda a
   * transmitir ou em transmissão. É nota válida: o caixa imprime e a regra
   * das versões a trata como autorizada.
   */
  | "contingency";

/**
 * Contingência na emissão da NFC-e (README.md, "Contingência"):
 * - `never` (padrão): sem resposta do governo, 503 fiscal_no_conclusive_answer;
 * - `automatic`: o emissor espera até 20 s e, sem resposta, emite em
 *   contingência com número novo (status `contingency`);
 * - `forced`: emite direto em contingência.
 */
export type FiscalContingencyMode = "never" | "automatic" | "forced";

/** Estado da contingência de uma nota (null fora de contingência). */
export interface FiscalContingencyState {
  /** Ainda falta transmitir ao governo. */
  pending: boolean;
  since: string | null;
  reason: string | null;
  transmission_attempts: number;
  last_attempt_at: string | null;
  /** Nota normal da mesma venda que o emissor está conferindo (pode ter sido autorizada antes da queda). */
  normal_note_in_review: string | null;
  review_failure: string | null;
  /** Nota normal cancelada pelo emissor para a venda ficar com uma nota só. */
  normal_note_cancelled: string | null;
}

export interface FiscalEmitOptions {
  /** Só NFC-e. Outro documento, ou provedor sem suporte: 422 fiscal_contingency_not_supported. */
  contingency?: FiscalContingencyMode;
  /**
   * Manter a data de emissão do pedido. Padrão: o provedor a retira e o
   * emissor carimba a hora da emissão (no fuso da UF), o que deixa o corpo
   * igual entre tentativas e evita a rejeição de NFC-e com data atrasada.
   * Com `true`, o ERP precisa reenviar exatamente a mesma data.
   */
  keep_issue_date?: boolean;
}

export interface FiscalMessage {
  /** cStat da SEFAZ, código da NFS-e Nacional ou do provedor. */
  code: string;
  /** xMotivo ou descrição. */
  description: string;
}

/** Documento do ERP que origina a nota. */
export interface FiscalKey {
  /** Id do documento fiscal no ERP (uuid). */
  document_id: string;
  /** Versão do documento, a partir de 1. Sobe só para reemitir. */
  version: number;
}

/** Identidade congelada pelo serviço para consultar uma emissão existente. */
export interface FiscalLookupIdentity {
  environment: FiscalEnvironment;
  reference?: string;
  /** Chave já confirmada pelo cofre, quando o vínculo possui nota válida. */
  access_key?: string;
}

export interface FiscalResult {
  kind: FiscalKind;
  status: FiscalStatus;
  /** Id da emissão no provedor (para consultar, cancelar, baixar o XML). */
  provider_ref: string;
  /** Referência enviada ao provedor (derivada da FiscalKey). */
  reference: string | null;
  environment: FiscalEnvironment;
  series: string;
  number: number;
  access_key: string | null;
  protocol: string | null;
  /** Só NFS-e: número da nota no município/Sistema Nacional. */
  nfse_number: string | null;
  issued_at: string | null;
  authorized_at: string | null;
  /** Valor total somado pelo provedor (vNF). */
  total: number | null;
  /** Só NFC-e. */
  qr_code: string | null;
  consult_url: string | null;
  corrections: number;
  messages: FiscalMessage[];
  xml_available: boolean;
  /** true quando a resposta veio de uma emissão anterior com a mesma chave. */
  replayed: boolean;
  /**
   * Cancelamento e carta de correção: `repetido` do emissor. true quando o
   * evento já estava registrado e nada novo foi ao governo; false quando esta
   * chamada registrou; null fora de evento ou quando a resposta se perdeu e
   * o estado foi lido depois. Não basta para decidir o efeito no ERP: depois
   * de uma resposta perdida, a chamada seguinte vem com true. Lance o efeito
   * pelo estado do próprio documento (ainda não cancelado → cancele).
   */
  event_repeated: boolean | null;
  /** NFC-e que saiu em contingência (mesmo depois de transmitida); null nas demais. */
  contingency: FiscalContingencyState | null;
}

/**
 * Arquivo do emissor (DANFE, DANFE NFC-e, logotipo) como veio: tipo e tamanho
 * do emissor, bytes sem transformação. Gerado na hora; nada fica guardado.
 */
export interface FiscalFile {
  content_type: string;
  size: number;
  body: Uint8Array<ArrayBuffer>;
}

/** Cupom da NFC-e em JSON (o `Cupom` do contrato da NFapi), para a impressora do caixa. */
export type FiscalReceipt = Record<string, unknown>;

export type FiscalManifestationType = "ciencia" | "confirmacao" | "desconhecimento" | "nao_realizada";

export interface FiscalManifestation {
  type: FiscalManifestationType | null;
  sequence: number | null;
  protocol: string | null;
  registered_at: string | null;
  justification: string | null;
  /** Quem registrou no emissor (manual, automática). */
  origin: string | null;
  xml_available: boolean;
}

/** NF-e que outra empresa emitiu contra o CNPJ (distribuição de DF-e). */
export interface FiscalReceivedNote {
  provider_ref: string;
  environment: FiscalEnvironment;
  cnpj: string;
  access_key: string;
  /** Cresce a cada mudança: a mesma nota reaparece. Trate por provider_ref ou access_key. */
  sequence: number;
  /** Só as de `recipient` se confrontam com pedido de compra. */
  role: "recipient" | "third_party";
  issuer: { document: string | null; name: string | null; ie: string | null };
  series: number | null;
  number: number | null;
  issued_at: string | null;
  authorized_at: string | null;
  protocol: string | null;
  operation: "entrada" | "saida" | null;
  total: number | null;
  status: "authorized" | "cancelled" | "denied" | null;
  /** Antes da manifestação só há resumo: sem itens nem XML. */
  xml_available: boolean;
  manifestation: FiscalManifestation | null;
  manifestations: FiscalManifestation[];
  /** A ciência automática foi recusada pelo governo (cStat e motivo). */
  automatic_acknowledgement_refused: FiscalMessage | null;
  received_at: string | null;
  updated_at: string | null;
  /** Manifestação ou consulta repetida: nada novo foi ao governo. Null fora disso. */
  repeated: boolean | null;
}

export interface FiscalReceivedPage {
  items: FiscalReceivedNote[];
  /** Guarde e passe em `after` na próxima leitura. */
  last_sequence: number;
  has_more: boolean;
}

/** Estado da consulta ao Ambiente Nacional, por CNPJ e ambiente (só leitura: NSU e espera são do emissor). */
export interface FiscalDistributionState {
  cnpj: string | null;
  environment: FiscalEnvironment | null;
  uf: string | null;
  automatic_query: boolean;
  automatic_acknowledgement: boolean;
  last_nsu: number | null;
  max_nsu: number | null;
  last_query_at: string | null;
  /** Antes disso o emissor não consulta (espera de uma hora do Ambiente Nacional). */
  next_query_at: string | null;
  blocked: boolean;
  message: FiscalMessage | null;
  key_queries: { last_hour: number; limit: number | null };
  /**
   * Documentos que ficaram para trás (outro sistema consultou o mesmo CNPJ) e
   * que o emissor ainda vai buscar sozinho, um a um. Zero no uso normal e
   * quando o cofre é anterior a 0.9.1.
   */
  recovering_documents: number;
}

// ---------------------------------------------------------------------------
// Relatórios e exportação (NFapi 0.11.0)

/** Nota emitida como aparece nas listagens (qualquer dos três documentos). */
export interface FiscalIssuedNote {
  provider_ref: string;
  kind: FiscalKind;
  environment: FiscalEnvironment;
  reference: string | null;
  series: string;
  /** NFS-e: número da nota autorizada (null antes); o da declaração está em dps_number. */
  number: string | null;
  dps_number: number | null;
  status: FiscalStatus;
  access_key: string | null;
  protocol: string | null;
  issued_at: string | null;
  total: number | null;
  /** Destinatário (NF-e, NFC-e) ou tomador (NFS-e); null quando a nota não identifica ninguém. */
  recipient: { document: string | null; name: string | null } | null;
  xml_available: boolean;
}

export interface FiscalIssuedFilter {
  /** Primeiro e último dia de emissão (AAAA-MM-DD). */
  from?: string;
  to?: string;
  kind?: FiscalKind;
  status?: FiscalStatus;
  environment?: FiscalEnvironment;
  /** Número, chave, referência, ou parte do nome ou do documento (5 dígitos ou mais) do destinatário. */
  search?: string;
  page?: number;
  /** 1 a 200 (padrão 50). */
  per_page?: number;
}

export interface FiscalIssuedPage {
  items: FiscalIssuedNote[];
  /** Quantidade e valor (R$) do filtro inteiro, não só desta página. */
  total: number;
  amount: number;
  page: number;
  per_page: number;
}

/** Totais lidos dos XML, em reais. `total` é o valor do documento (vNF; na NFS-e, o líquido). */
export interface FiscalTaxTotals {
  total: number;
  products: number;
  services: number;
  discount: number;
  freight: number;
  insurance: number;
  other: number;
  icms: number;
  icms_st: number;
  fcp: number;
  ipi: number;
  pis: number;
  cofins: number;
  ii: number;
  iss: number;
  ibs: number;
  cbs: number;
  is: number;
}

/** Quantidade de notas e valor em reais. */
export interface FiscalCount {
  count: number;
  amount: number;
}

export interface FiscalReportWarning {
  /**
   * pending_reads: o emissor ainda não leu o XML de algumas notas (impostos,
   * CFOP e natureza incompletos; repita o pedido). nfse_ibs_cbs_not_read: IBS
   * e CBS da NFS-e ainda não são lidos e aparecem zerados.
   */
  code: "pending_reads" | "nfse_ibs_cbs_not_read";
  message: string;
}

/**
 * Totais de um período pelos dias de emissão. Só a nota autorizada entra nos
 * totais fiscais; cancelada e recusada aparecem só em by_status. Das
 * recebidas, só as com XML completo entram nos impostos (with_xml).
 */
export interface FiscalReport {
  environment: FiscalEnvironment;
  period: { from: string; to: string };
  /** Notas cujo XML o emissor ainda não leu. Enquanto > 0, repita depois de retry_after_ms. */
  pending_reads: number;
  complete: boolean;
  retry_after_ms: number | null;
  warnings: FiscalReportWarning[];
  issued: {
    by_status: (FiscalCount & { kind: FiscalKind; status: FiscalStatus })[];
    authorized: FiscalCount & { taxes: FiscalTaxTotals };
    by_day: (FiscalCount & { day: string })[];
    /** count: notas em que o CFOP aparece; amount: valor dos itens. */
    by_cfop: (FiscalCount & { cfop: string })[];
    /** Natureza da operação; na NFS-e, o código de tributação nacional. */
    by_nature: (FiscalCount & { nature: string })[];
    /** Os 50 de maior valor. */
    by_recipient: (FiscalCount & { document: string | null; name: string | null })[];
  };
  received: {
    by_status: (FiscalCount & { status: string })[];
    /** Autorizadas com o titular como destinatário; taxes soma só as with_xml. */
    authorized: FiscalCount & { with_xml: number; taxes: FiscalTaxTotals };
    /** Notas em que o titular é só transportador ou autorizado: fora dos totais. */
    as_third_party: number;
    by_cfop: (FiscalCount & { cfop: string })[];
    by_issuer: (FiscalCount & { document: string | null; name: string | null })[];
  };
}

export type FiscalExportItem = "nfse" | "nfe" | "nfce" | "events" | "void_ranges" | "received";

/**
 * Exportação dos XML de um período, com planilha de resumo. Os links são
 * para o navegador do usuário abrir direto no emissor (sem chave), valem até
 * links_valid_until (cerca de 30 min) e o servidor do Wabotia nunca baixa
 * esses arquivos. Link vencido: consulte a exportação de novo (links novos).
 * A exportação some em 24 h (404 fiscal_export_not_found).
 */
export interface FiscalExport {
  provider_ref: string;
  environment: FiscalEnvironment;
  period: { from: string; to: string };
  include: FiscalExportItem[];
  /** preparing: consulte de novo depois de retry_after_ms (cada consulta leva o trabalho adiante). */
  status: "preparing" | "ready";
  pending_reads: number;
  files: number;
  /** Arquivos de cada tipo (nfse, nfe, nfce, eventos, inutilizacoes, recebidas, ...), como o emissor conta. */
  contents: Record<string, number>;
  /** Partes do ZIP (até 400 arquivos cada; a planilha vai na primeira). */
  parts: { part: number; name: string; url: string }[];
  spreadsheet: { name: string; url: string } | null;
  links_valid_until: string | null;
  created_at: string | null;
  expires_at: string | null;
  retry_after_ms: number | null;
}

export interface FiscalSeries {
  kind: "nfe" | "nfce";
  environment: FiscalEnvironment;
  series: number;
  next_number: number;
  description: string | null;
  cnpj: string;
}

export interface FiscalVoidRange {
  kind: "nfe" | "nfce";
  environment?: FiscalEnvironment;
  series: number;
  first: number;
  last: number;
  justification: string;
  uf: string;
  cnpj?: string;
}

export interface FiscalVoidResult {
  provider_ref: string;
  kind: string;
  environment: FiscalEnvironment;
  series: number;
  first: number;
  last: number;
  protocol: string | null;
  created_at: string | null;
  justification: string | null;
  xml_available: boolean;
  /** true: a faixa já estava inutilizada e nada foi ao governo (repetir é seguro). */
  repeated: boolean | null;
}

/** Estado do emissor para o painel (GET /v1/cofre na NFapi). */
export interface FiscalProviderState {
  provider: string;
  version: string;
  update: { published: string | null; pending: boolean };
  certificate: {
    holder: string;
    document: { kind: "cnpj" | "cpf"; id: string } | null;
    valid_until: string;
    days_left: number;
  } | null;
  production_released: boolean;
  key: { scope: "completo" | "homologacao" | null; environments: FiscalEnvironment[] };
  documents: { nfse: boolean; nfe: string[] | null; nfce: string[] | null };
  /** Notas em contingência ainda não transmitidas (null: emissor que não informa). */
  contingency: { pending_notes: number } | null;
  /** O emissor tem logotipo para os documentos impressos (null: não informa). */
  logo: boolean | null;
}

export interface FiscalContext {
  env: Env;
  profile: string;
  /** Só testes e diagnóstico: fetch no lugar do global. */
  fetch?: typeof fetch;
  /** Conexão pública congelada pelo serviço; a rotação da chave não a altera. */
  connection_fingerprint?: string;
}

/**
 * Corpo de emissão já no formato do provedor. Hoje é o pedido da NFapi
 * (PedidoNfe/PedidoNfce/PedidoNfse, sem `referencia`); o mapeamento da nota
 * do ERP para ele espera o domínio Fiscal. Opaco para o ERP.
 */
export type ProviderRequest = Record<string, unknown>;

export interface FiscalProvider {
  id: string;
  name: string;
  kinds: FiscalKind[];
  /** Modos de contingência da NFC-e que o provedor emite além de `never` (vazio: nenhum). */
  contingency: Exclude<FiscalContingencyMode, "never">[];
  /**
   * Emite. Repetições internas usam a mesma referência; resposta perdida ou
   * sem conclusão do governo leva a uma consulta antes de qualquer reenvio.
   * Rejeição e denegação voltam como resultado (status), não como erro.
   */
  emit(
    ctx: FiscalContext,
    kind: FiscalKind,
    request: ProviderRequest,
    key: FiscalKey,
    options?: FiscalEmitOptions,
  ): Promise<FiscalResult>;
  /**
   * Emissão da chave no ambiente explícito, ou null. O ambiente é opcional
   * só para consumidores antigos; sem ele, resultados em dois ambientes
   * geram conflito, nunca a escolha silenciosa de uma das notas.
   */
  find(ctx: FiscalContext, kind: FiscalKind, key: FiscalKey, environment?: FiscalEnvironment): Promise<FiscalResult | null>;
  get(ctx: FiscalContext, kind: FiscalKind, ref: string, identity?: FiscalLookupIdentity): Promise<FiscalResult>;
  /**
   * Consulta o governo (NF-e/NFC-e): fecha uma emissão sem resposta
   * conclusiva e, na NFC-e em contingência, força uma tentativa de
   * transmissão (o emissor também transmite sozinho quando a SEFAZ volta).
   */
  reconcile(ctx: FiscalContext, kind: FiscalKind, ref: string, identity?: FiscalLookupIdentity): Promise<FiscalResult>;
  xml(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<string>;
  cancel(
    ctx: FiscalContext,
    kind: FiscalKind,
    ref: string,
    input: { justification: string; reason?: "erro_emissao" | "servico_nao_prestado" | "outros" },
    identity?: FiscalLookupIdentity,
  ): Promise<FiscalResult>;
  /** Carta de correção (só NF-e); o texto substitui as cartas anteriores. */
  correct(ctx: FiscalContext, ref: string, text: string): Promise<FiscalResult>;
  voidRange(ctx: FiscalContext, input: FiscalVoidRange): Promise<FiscalVoidResult>;

  // Leituras (qualquer papel erp:*). Arquivos vêm como o emissor mandou.
  /** XML do evento de cancelamento. */
  cancellationXml(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<string>;
  /** XML da carta de correção `sequence` (1 a 20; só NF-e). */
  correctionXml(ctx: FiscalContext, ref: string, sequence: number): Promise<string>;
  danfe(ctx: FiscalContext, ref: string): Promise<FiscalFile>;
  danfce(
    ctx: FiscalContext,
    ref: string,
    options?: { width?: "80" | "58"; copy?: "consumer" | "establishment" },
  ): Promise<FiscalFile>;
  receipt(ctx: FiscalContext, ref: string, options?: { copy?: "consumer" | "establishment" }): Promise<FiscalReceipt>;
  /** Logotipo do emitente; null quando o emissor não tem. */
  logo(ctx: FiscalContext): Promise<FiscalFile | null>;
  voidRanges(
    ctx: FiscalContext,
    filter?: { kind?: "nfe" | "nfce"; environment?: FiscalEnvironment; series?: number },
  ): Promise<FiscalVoidResult[]>;
  voidRangeGet(ctx: FiscalContext, ref: string): Promise<FiscalVoidResult>;
  voidRangeXml(ctx: FiscalContext, ref: string): Promise<string>;

  // NF-e recebidas (distribuição de DF-e). Ler não consulta o governo.
  received(
    ctx: FiscalContext,
    filter?: { after?: number; limit?: number; environment?: FiscalEnvironment; access_key?: string },
  ): Promise<FiscalReceivedPage>;
  receivedGet(ctx: FiscalContext, ref: string): Promise<FiscalReceivedNote>;
  /** 409 fiscal_xml_unavailable antes da manifestação (só há resumo). */
  receivedXml(ctx: FiscalContext, ref: string): Promise<string>;
  receivedDanfe(ctx: FiscalContext, ref: string): Promise<FiscalFile>;
  manifestationXml(ctx: FiscalContext, ref: string, type: FiscalManifestationType, sequence: number): Promise<string>;
  /**
   * Manifestação do destinatário: evento fiscal (ação sensível da categoria
   * nota fiscal no ERP). Repetir devolve `repeated: true` sem enviar nada.
   * Pela nota (`ref`) ou pela chave de acesso.
   */
  manifest(
    ctx: FiscalContext,
    target: { ref: string } | { access_key: string; environment?: FiscalEnvironment; cnpj?: string },
    input: { type: FiscalManifestationType; justification?: string },
  ): Promise<FiscalReceivedNote>;
  distribution(ctx: FiscalContext): Promise<FiscalDistributionState[]>;
  /** Busca uma NF-e pela chave no Ambiente Nacional. Gasta a cota (18 por hora: 429 com retry_at). */
  queryAccessKey(
    ctx: FiscalContext,
    input: { access_key: string; environment?: FiscalEnvironment; cnpj?: string },
  ): Promise<FiscalReceivedNote>;

  // Relatórios e exportação. Só leitura no emissor (nada vai ao governo).
  /** Notas emitidas com filtros; total e amount somam o filtro inteiro. */
  issued(ctx: FiscalContext, filter?: FiscalIssuedFilter): Promise<FiscalIssuedPage>;
  /** Totais do período (from e to em AAAA-MM-DD, até 366 dias). Repita enquanto pending_reads > 0. */
  report(ctx: FiscalContext, input: { environment: FiscalEnvironment; from: string; to: string }): Promise<FiscalReport>;
  /** Cria a exportação. Acompanhe com exportGet a cada 1 ou 2 s enquanto preparing, sem laço apertado. */
  exportCreate(
    ctx: FiscalContext,
    input: { environment: FiscalEnvironment; from: string; to: string; include?: FiscalExportItem[] },
  ): Promise<FiscalExport>;
  /** Estado e links novos. */
  exportGet(ctx: FiscalContext, ref: string): Promise<FiscalExport>;
  /** Exportações ainda válidas (menos de 24 h). */
  exports(ctx: FiscalContext): Promise<FiscalExport[]>;

  series(ctx: FiscalContext): Promise<FiscalSeries[]>;
  state(ctx: FiscalContext): Promise<FiscalProviderState>;
  sefazStatus(
    ctx: FiscalContext,
    input: { uf: string; kind?: "nfe" | "nfce"; environment?: FiscalEnvironment },
  ): Promise<{ in_operation: boolean; authorizer: string; message: FiscalMessage | null; average_seconds: number | null }>;
}

// ---------------------------------------------------------------------------
// Erros

export interface FiscalErrorDetails {
  /** Código original do provedor (ex.: "serie_nao_cadastrada"). */
  provider_code?: string | null;
  /** Campo recusado na validação do pedido. */
  field?: string | null;
  /** cStat/xMotivo e mensagens do provedor. */
  messages?: FiscalMessage[];
  /** Emissão que o provedor devolveu junto, quando há. */
  emission?: FiscalResult | null;
  /** Evidência cujo vínculo divergiu: persistir para conciliar, nunca aplicar como resultado. */
  unverified_emission?: unknown;
  /** Pode ser repetido mais tarde com a mesma chave. */
  retryable?: boolean;
  /** vault_outdated: versão mínima do emissor para a operação. */
  min_version?: string | null;
  /** 429: a partir de quando tentar de novo (ISO), quando o emissor informa. */
  retry_at?: string | null;
}

export class FiscalError extends ApiError {
  readonly details: Required<FiscalErrorDetails>;
  constructor(status: number, code: string, message: string, details: FiscalErrorDetails = {}) {
    super(status, code, message);
    this.name = "FiscalError";
    this.details = {
      provider_code: details.provider_code ?? null,
      field: details.field ?? null,
      messages: details.messages ?? [],
      emission: details.emission ?? null,
      unverified_emission: details.unverified_emission ?? null,
      retryable: details.retryable ?? false,
      min_version: details.min_version ?? null,
      retry_at: details.retry_at ?? null,
    };
  }
  /** Corpo de resposta HTTP do Wabotia, com os detalhes. */
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

/**
 * Rejeições "de cadastro" da SEFAZ (cStat): dependem de cadastro fora do
 * sistema e não se resolvem repetindo. Na emissão viram FiscalError com o
 * código próprio, a mensagem para a pessoa, o cStat e o xMotivo originais
 * em `messages` e a emissão rejeitada em `emission`. O ERP não insiste.
 */
export const REGISTRATION_REJECTIONS: Record<string, { code: string; message: string }> = {
  "245": {
    code: "fiscal_issuer_not_accredited",
    message:
      "A SEFAZ informou que o CNPJ da empresa não está cadastrado para este documento. Para emitir NFC-e, a empresa precisa se credenciar na SEFAZ do seu estado. Repetir a emissão não resolve.",
  },
  "181": {
    code: "fiscal_recipient_not_registered",
    message:
      "A SEFAZ não encontrou o CNPJ do destinatário na Receita Federal. Confira o CNPJ do cliente (em homologação, só CNPJ existente passa) e emita de novo com o dado corrigido.",
  },
};

/** Rejeição de cadastro conhecida na primeira mensagem, ou null. */
export function registrationRejection(messages: FiscalMessage[]) {
  const first = messages[0];
  return first && REGISTRATION_REJECTIONS[first.code] ? { cstat: first.code, ...REGISTRATION_REJECTIONS[first.code] } : null;
}

export const providerNotConfigured = () =>
  new FiscalError(
    409,
    "fiscal_provider_not_configured",
    "Nenhum emissor de notas fiscais está configurado nesta área. Um administrador informa o endereço do emissor e a chave de API em Preferências › Notas Fiscais › Emissor de notas.",
  );

// ---------------------------------------------------------------------------
// Registro

const providers = new Map<string, FiscalProvider>();

export function registerFiscalProvider(provider: FiscalProvider) {
  providers.set(provider.id, provider);
}
/** Só para testes. */
export function unregisterFiscalProvider(id: string) {
  providers.delete(id);
}
export const fiscalProviderById = (id: string | null | undefined) => (id ? providers.get(id) ?? null : null);
export const fiscalProviders = () =>
  [...providers.values()].map((p) => ({ id: p.id, name: p.name, kinds: p.kinds }));
