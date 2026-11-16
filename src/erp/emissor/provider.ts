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
//   estão encerradas sem nota válida (rejeitada, erro, denegada ou cancelada).
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
   * Reservado: emitida em contingência (NFC-e offline, SVC), ainda a
   * transmitir. Nenhum provedor usa hoje (a NFapi não tem contingência).
   */
  | "contingency";

/** Modo de contingência pedido na emissão (reservado; README.md, "Contingência"). */
export interface FiscalContingency {
  mode: "offline" | "svc";
  /** Justificativa que vai no XML (xJust). */
  reason: string;
}

export interface FiscalEmitOptions {
  /** Emitir em contingência. Provedor sem suporte: 422 fiscal_contingency_not_supported. */
  contingency?: FiscalContingency;
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
  /**
   * Reservado para contingência: quando e por que saiu em contingência e
   * quando foi transmitida. Sempre null hoje.
   */
  contingency: (FiscalContingency & { since: string; transmitted_at: string | null }) | null;
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
}

export interface FiscalContext {
  env: Env;
  profile: string;
  /** Só testes e diagnóstico: fetch no lugar do global. */
  fetch?: typeof fetch;
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
  /** Modos de contingência que o provedor emite (vazio: nenhum). */
  contingency: FiscalContingency["mode"][];
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
   * Reservado: transmite uma nota emitida em contingência. Só existe em
   * provedor com `contingency` não vazio.
   */
  transmitContingency?(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<FiscalResult>;
  /** Emissão da chave no provedor, ou null se nunca chegou lá. */
  find(ctx: FiscalContext, kind: FiscalKind, key: FiscalKey): Promise<FiscalResult | null>;
  get(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<FiscalResult>;
  /** Fecha com o governo uma emissão sem resposta conclusiva (NF-e/NFC-e). */
  reconcile(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<FiscalResult>;
  xml(ctx: FiscalContext, kind: FiscalKind, ref: string): Promise<string>;
  cancel(
    ctx: FiscalContext,
    kind: FiscalKind,
    ref: string,
    input: { justification: string; reason?: "erro_emissao" | "servico_nao_prestado" | "outros" },
  ): Promise<FiscalResult>;
  /** Carta de correção (só NF-e); o texto substitui as cartas anteriores. */
  correct(ctx: FiscalContext, ref: string, text: string): Promise<FiscalResult>;
  voidRange(ctx: FiscalContext, input: FiscalVoidRange): Promise<FiscalVoidResult>;
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
  /** Pode ser repetido mais tarde com a mesma chave. */
  retryable?: boolean;
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
      retryable: details.retryable ?? false,
    };
  }
  /** Corpo de resposta HTTP do Wabotia, com os detalhes. */
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

export const providerNotConfigured = () =>
  new FiscalError(
    409,
    "fiscal_provider_not_configured",
    "Nenhum emissor de notas fiscais está configurado nesta área. Um administrador informa o endereço do cofre NFapi e a chave de API em ERP → Fiscal → Emissor.",
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
