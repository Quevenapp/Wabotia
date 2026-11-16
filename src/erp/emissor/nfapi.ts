// Cliente fino do cofre NFapi: uma função por operação do contrato
// (contract/openapi.json), sem repetição nem interpretação. Quem decide
// repetir, consultar ou desistir é o provedor (nfapi-provider.ts).
//
// - Autenticação: Authorization: Bearer nfapi_...
// - Erro do cofre (JSON { erro: { codigo, mensagem } }) → NfapiError, com
//   campo, mensagens (cStat/xMotivo) e a emissão quando o corpo traz.
// - Sem resposta do cofre (rede, tempo esgotado, página de erro da
//   Cloudflare) → NfapiTransportError: o pedido pode ou não ter chegado.
import type {
  CancelamentoNfe,
  CancelamentoNfse,
  CartaCorrecao,
  Cofre,
  ContractOperation,
  EmissaoNfe,
  EmissaoNfse,
  Erro,
  Inutilizacao,
  InutilizacaoRegistrada,
  PedidoNfce,
  PedidoNfe,
  PedidoNfse,
  Serie,
  StatusSefaz,
} from "./contract/types.generated.ts";

export type NfapiDoc = "nfe" | "nfce" | "nfse";
export type NfapiDocNfe = "nfe" | "nfce";
export type Mensagem = { codigo: string; descricao: string };
export type Emissao<K extends NfapiDoc> = K extends "nfse" ? EmissaoNfse : EmissaoNfe;
export type Pedido<K extends NfapiDoc> = K extends "nfse" ? PedidoNfse : K extends "nfce" ? PedidoNfce : PedidoNfe;

export interface NfapiConnection {
  /** Origem https do cofre, sem barra no fim. */
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Tempo máximo de uma chamada de emissão ou evento (ms). */
  writeTimeoutMs?: number;
  /** Tempo máximo de uma leitura (ms). */
  readTimeoutMs?: number;
}

export interface NfapiResponse<T> {
  /** 200 ou 201: na emissão, 200 diz que a referência já tinha nota. */
  status: number;
  body: T;
}

/** Erro devolvido pelo cofre, no formato do contrato (schema Erro). */
export class NfapiError extends Error {
  readonly status: number;
  readonly codigo: string;
  readonly campo: string | null;
  readonly mensagens: Mensagem[];
  /** Emissão que o cofre mandou junto (rejeição, sem resposta conclusiva). */
  readonly emissao: EmissaoNfe | EmissaoNfse | null;
  constructor(status: number, body: Erro) {
    super(body.erro.mensagem);
    this.name = "NfapiError";
    this.status = status;
    this.codigo = body.erro.codigo;
    this.campo = body.campo ?? null;
    this.mensagens = Array.isArray(body.mensagens) ? body.mensagens : [];
    this.emissao = body.nfe ?? body.nfce ?? body.nfse ?? null;
  }
}

/**
 * O cofre não respondeu com algo do contrato. `same_zone`: a Cloudflare
 * recusou a chamada de Worker para Worker (erro 1042; README.md desta pasta).
 */
export class NfapiTransportError extends Error {
  constructor(
    readonly kind: "network" | "timeout" | "same_zone" | "bad_response",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "NfapiTransportError";
  }
}

const isErro = (value: unknown): value is Erro =>
  !!value &&
  typeof value === "object" &&
  !!(value as Erro).erro &&
  typeof (value as Erro).erro.codigo === "string" &&
  typeof (value as Erro).erro.mensagem === "string";

/**
 * Formato antigo dos erros gerais do cofre (até 0.3.1: 503
 * cofre_nao_configurado, 404 de rota, 500 erro_interno saíam como
 * `{ error: { code, message } }`). Aceito enquanto houver cofre antigo
 * instalado; a 0.3.2 usa `{ erro: { codigo, mensagem } }` em tudo.
 */
function legacyErro(value: unknown): Erro | null {
  const e = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!e || typeof e.code !== "string") return null;
  return { erro: { codigo: e.code, mensagem: typeof e.message === "string" ? e.message : e.code } };
}

/** Cancelamento e carta de correção: a emissão e se o evento já existia. */
export type ComRepetido<T> = T & { repetido: boolean };

/** Caminho do contrato com os parâmetros preenchidos. */
function fill(template: string, params: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (typeof value !== "string" || !value) throw new TypeError(`Parâmetro ausente: ${name}`);
    return encodeURIComponent(value);
  });
}

export class NfapiClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly connection: NfapiConnection) {
    this.base = connection.url.replace(/\/+$/, "");
    this.fetcher = connection.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Chamada de uma operação do contrato. `operation` é checada contra o
   * contrato em tempo de compilação (ContractOperation).
   */
  async call<T>(
    operation: ContractOperation,
    options: {
      params?: Record<string, string>;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      accept?: "json" | "text";
    } = {},
  ): Promise<NfapiResponse<T>> {
    const [method, template] = operation.split(" ") as [string, string];
    const url = new URL(this.base + fill(template, options.params ?? {}));
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    const write = method !== "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.connection.apiKey}`,
      Accept: options.accept === "text" ? "application/xml, application/json" : "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: AbortSignal.timeout(
          write ? (this.connection.writeTimeoutMs ?? 90_000) : (this.connection.readTimeoutMs ?? 20_000),
        ),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new NfapiTransportError("timeout", "O cofre não respondeu no tempo esperado.");
      throw new NfapiTransportError("network", "Não foi possível falar com o cofre.");
    }
    const text = await response.text().catch(() => "");
    const type = response.headers.get("Content-Type") || "";
    if (response.ok && options.accept === "text" && !/json/i.test(type))
      return { status: response.status, body: text as T };
    let parsed: unknown = undefined;
    if (text)
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    if (parsed === undefined) {
      // Página da Cloudflare (1042, 52x) ou outra coisa que não é o cofre.
      if (/error code:?\s*1042\b|\b1042\b.*worker/i.test(text))
        throw new NfapiTransportError(
          "same_zone",
          "A Cloudflare recusou a chamada ao cofre (erro 1042: Worker chamando outro Worker da mesma zona).",
          response.status,
        );
      throw new NfapiTransportError(
        "bad_response",
        `O cofre respondeu HTTP ${response.status} fora do contrato.`,
        response.status,
      );
    }
    if (!response.ok) {
      if (isErro(parsed)) throw new NfapiError(response.status, parsed);
      const legacy = legacyErro(parsed);
      if (legacy) throw new NfapiError(response.status, legacy);
      throw new NfapiTransportError(
        "bad_response",
        `O cofre respondeu HTTP ${response.status} sem o corpo de erro do contrato.`,
        response.status,
      );
    }
    return { status: response.status, body: parsed as T };
  }

  // ----- Emissões (NF-e, NFC-e, NFS-e) -----

  emitir<K extends NfapiDoc>(doc: K, pedido: Pedido<K>) {
    return this.call<Emissao<K>>(`POST /v1/${doc}` as ContractOperation, { body: pedido });
  }
  async listar<K extends NfapiDoc>(
    doc: K,
    filtro: { referencia?: string; ambiente?: "homologacao" | "producao"; limite?: number } = {},
  ) {
    const r = await this.call<Record<string, Emissao<K>[]>>(`GET /v1/${doc}` as ContractOperation, {
      query: { referencia: filtro.referencia, ambiente: filtro.ambiente, limite: filtro.limite },
    });
    return { status: r.status, body: Array.isArray(r.body?.[doc]) ? r.body[doc] : [] };
  }
  obter<K extends NfapiDoc>(doc: K, id: string) {
    return this.call<Emissao<K>>(`GET /v1/${doc}/{id}` as ContractOperation, { params: { id } });
  }
  xml(doc: NfapiDoc, id: string) {
    return this.call<string>(`GET /v1/${doc}/{id}/xml` as ContractOperation, { params: { id }, accept: "text" });
  }
  /** NF-e e NFC-e: consulta a SEFAZ e fecha uma emissão `indefinida`. */
  consultar(doc: NfapiDocNfe, id: string) {
    return this.call<EmissaoNfe>(`POST /v1/${doc}/{id}/consultar` as ContractOperation, { params: { id } });
  }
  cancelar<K extends NfapiDoc>(doc: K, id: string, pedido: K extends "nfse" ? CancelamentoNfse : CancelamentoNfe) {
    return this.call<ComRepetido<Emissao<K>>>(`POST /v1/${doc}/{id}/cancelar` as ContractOperation, {
      params: { id },
      body: pedido,
    });
  }
  cartaCorrecao(id: string, pedido: CartaCorrecao) {
    return this.call<ComRepetido<EmissaoNfe>>("POST /v1/nfe/{id}/carta-correcao", { params: { id }, body: pedido });
  }
  inutilizar(pedido: Inutilizacao) {
    return this.call<InutilizacaoRegistrada>("POST /v1/inutilizacoes", { body: pedido });
  }

  // ----- Leituras do cofre -----

  async series() {
    const r = await this.call<{ series?: Serie[] }>("GET /v1/series");
    return { status: r.status, body: Array.isArray(r.body?.series) ? r.body.series : [] };
  }
  cofre() {
    return this.call<Cofre>("GET /v1/cofre");
  }
  sefazStatus(filtro: { uf: string; modelo?: NfapiDocNfe; ambiente?: "homologacao" | "producao" }) {
    return this.call<StatusSefaz>("GET /v1/sefaz/status", { query: filtro });
  }
  openapi() {
    return this.call<unknown>("GET /v1/openapi.json");
  }
}

/**
 * Operações que o cliente implementa, uma linha por operação do contrato. O
 * teste de contrato confere que esta lista e o contrato são iguais.
 */
export const CLIENT_OPERATIONS: readonly ContractOperation[] = [
  ...(["nfe", "nfce", "nfse"] as const).flatMap(
    (doc) =>
      [
        `POST /v1/${doc}`,
        `GET /v1/${doc}`,
        `GET /v1/${doc}/{id}`,
        `GET /v1/${doc}/{id}/xml`,
        `POST /v1/${doc}/{id}/cancelar`,
        ...(doc === "nfse" ? [] : [`POST /v1/${doc}/{id}/consultar`]),
      ] as ContractOperation[],
  ),
  "POST /v1/nfe/{id}/carta-correcao",
  "POST /v1/inutilizacoes",
  "GET /v1/series",
  "GET /v1/cofre",
  "GET /v1/sefaz/status",
  "GET /v1/openapi.json",
];
