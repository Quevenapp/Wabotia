// Cliente fino do cofre NFapi: uma função por operação do contrato
// (contract/openapi.json), sem repetição nem interpretação. Quem decide
// repetir, consultar ou desistir é o provedor (nfapi-provider.ts).
//
// - Autenticação: Authorization: Bearer nfapi_...
// - Erro do cofre (JSON { erro: { codigo, mensagem } }) → NfapiError, com
//   campo, mensagens (cStat/xMotivo) e a emissão quando o corpo traz.
// - Sem resposta do cofre (rede, tempo esgotado, página de erro da
//   Cloudflare) → NfapiTransportError: o pedido pode ou não ter chegado.
// - Operação que o cofre instalado ainda não tem (versão abaixo da mínima,
//   lida em GET /v1/cofre quando a chamada falha) → NfapiOutdatedError,
//   nunca o 404 cru.
// - PDF e imagem voltam como vieram (tipo e tamanho do cofre), com limite de
//   tamanho. Nada do conteúdo de uma nota vai para log.
// - Em processo de teste, nenhum POST sai para um cofre que não seja o
//   simulado (host .test ou .invalid): veja TEST_PROCESS abaixo.
import type {
  CancelamentoNfe,
  CancelamentoNfse,
  CartaCorrecao,
  Cofre,
  ContractOperation,
  Cupom,
  Distribuicao,
  DocumentoDistribuido,
  EmissaoNfe,
  EmissaoNfse,
  Erro,
  Inutilizacao,
  InutilizacaoRegistrada,
  NotaRecebida,
  PedidoNfce,
  PedidoNfe,
  PedidoNfse,
  Serie,
  Sincronizacao,
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
    /** `too_large`: arquivo (PDF, imagem) acima do limite do cliente; não foi lido. */
    readonly kind: "network" | "timeout" | "same_zone" | "bad_response" | "too_large",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "NfapiTransportError";
  }
}

/**
 * A operação não existe no cofre instalado: a versão dele (GET /v1/cofre) é
 * anterior à mínima da operação. Código estável: `vault_outdated`.
 */
export class NfapiOutdatedError extends Error {
  readonly codigo = "vault_outdated";
  constructor(
    readonly operation: string,
    readonly minVersion: string,
    readonly vaultVersion: string,
  ) {
    super(
      `O cofre instalado está na versão ${vaultVersion}; esta função precisa da ${minVersion} ou mais nova. Atualize o cofre pelo painel dele.`,
    );
    this.name = "NfapiOutdatedError";
  }
}

/**
 * Versão mínima do cofre por operação, pelo histórico do canal estável da
 * NFapi (as que não estão aqui existem desde a 0.3.2, a mais antiga aceita):
 * 0.4.1 XML dos eventos e consulta de inutilizações; 0.7.0 cupom da NFC-e;
 * 0.8.0 DANFE, DANFE NFC-e e logotipo; 0.9.0 NF-e recebidas. O pedido de
 * NFC-e com `contingencia` diferente de "nunca" precisa da 0.4.0.
 */
export const OPERATION_MIN_VERSION: Partial<Record<ContractOperation, string>> = {
  "GET /v1/nfe/{id}/cancelamento/xml": "0.4.1",
  "GET /v1/nfce/{id}/cancelamento/xml": "0.4.1",
  "GET /v1/nfse/{id}/cancelamento/xml": "0.4.1",
  "GET /v1/nfe/{id}/carta-correcao/{sequencia}/xml": "0.4.1",
  "GET /v1/inutilizacoes": "0.4.1",
  "GET /v1/inutilizacoes/{id}": "0.4.1",
  "GET /v1/inutilizacoes/{id}/xml": "0.4.1",
  "GET /v1/nfce/{id}/cupom": "0.7.0",
  "GET /v1/nfe/{id}/danfe": "0.8.0",
  "GET /v1/nfce/{id}/danfce": "0.8.0",
  "GET /v1/cofre/logotipo": "0.8.0",
  "GET /v1/nfe-recebidas": "0.9.0",
  "POST /v1/nfe-recebidas/manifestar": "0.9.0",
  "GET /v1/nfe-recebidas/{id}": "0.9.0",
  "GET /v1/nfe-recebidas/{id}/xml": "0.9.0",
  "GET /v1/nfe-recebidas/{id}/danfe": "0.9.0",
  "POST /v1/nfe-recebidas/{id}/manifestar": "0.9.0",
  "GET /v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml": "0.9.0",
  "GET /v1/distribuicao": "0.9.0",
  "POST /v1/distribuicao/sincronizar": "0.9.0",
  "POST /v1/distribuicao/consultar-chave": "0.9.0",
  "GET /v1/distribuicao/documentos": "0.9.0",
  "GET /v1/distribuicao/documentos/{sequencia}/xml": "0.9.0",
};
export const CONTINGENCY_MIN_VERSION = "0.4.0";

/** a < b, em versões x.y.z (texto fora do formato conta como 0.0.0). */
export function olderThan(a: string, b: string) {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? ["", "0", "0", "0"]).slice(1).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/**
 * Espera máxima do cofre antes de emitir a NFC-e em contingência
 * (`contingencia: "automatica"`), e a folga que o cliente dá por cima dela.
 */
export const CONTINGENCY_WAIT_MS = 20_000;
export const CONTINGENCY_MIN_WRITE_TIMEOUT_MS = CONTINGENCY_WAIT_MS + 40_000;

/** Limites de tamanho dos arquivos repassados (o cofre não guarda os PDFs: gera na hora). */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Arquivo do cofre como veio: tipo e tamanho do cofre, bytes sem transformação. */
export interface NfapiFile {
  status: number;
  contentType: string;
  size: number;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * Processo de teste (vitest ou node --test). Lido do ambiente do executor,
 * não de uma opção: um teste não desliga a trava sem querer. Em produção nada
 * disso existe (import.meta.env some no pacote; process.env só tem as vars).
 */
export const TEST_PROCESS: boolean = (() => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    if (env && (env.VITEST || env.MODE === "test")) return true;
  } catch {
    // sem import.meta.env
  }
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return !!(p && (p.VITEST || p.VITEST_POOL_ID || p.NODE_TEST_CONTEXT));
})();

/** Hosts reservados (RFC 6761), que nunca são um cofre de verdade: o cofre simulado usa um deles. */
export const isFakeVaultHost = (hostname: string) => /\.(test|invalid)$/i.test(hostname);

/** Recusa de um POST em processo de teste para cofre que não é o simulado. */
export class NfapiTestGuardError extends Error {
  constructor(readonly operation: string, readonly host: string) {
    super(
      `Teste tentou ${operation} em ${host}, que não é o cofre simulado: nada foi enviado. Em teste, os POST (emissão, eventos, manifestação, consulta por chave) só vão para hosts .test ou .invalid.`,
    );
    this.name = "NfapiTestGuardError";
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

/** Pedido de manifestação do destinatário (justificativa só na operação não realizada, 15 a 255). */
export interface Manifestacao {
  tipo: "ciencia" | "confirmacao" | "desconhecimento" | "nao_realizada";
  justificativa?: string;
}

interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  accept?: "json" | "text" | "binary";
  /** Só com accept "binary": tipos aceitos (prefixo do Content-Type). */
  types?: string[];
  maxBytes?: number;
  /** Versão mínima do cofre, quando o pedido usa um campo mais novo que a operação. */
  minVersion?: string;
  /** Tempo-limite de escrita mínimo para esta chamada (espera da contingência). */
  minWriteTimeoutMs?: number;
}

/** Lê o corpo até `max` bytes; acima disso para de ler e recusa. */
async function readCapped(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("Content-Length"));
  const tooLarge = () =>
    new NfapiTransportError("too_large", `O arquivo do cofre passa do limite de ${Math.floor(max / 1024 / 1024)} MB e não foi repassado.`, response.status);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

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
  async call<T>(operation: ContractOperation, options: CallOptions = {}): Promise<NfapiResponse<T>> {
    const minVersion = options.minVersion ?? OPERATION_MIN_VERSION[operation];
    if (!minVersion) return this.send<T>(operation, options);
    try {
      return await this.send<T>(operation, options);
    } catch (error) {
      throw await this.outdated(operation, minVersion, error);
    }
  }

  /** Arquivo (PDF, imagem) como o cofre mandou, com limite de tamanho. */
  async file(
    operation: ContractOperation,
    options: Omit<CallOptions, "accept" | "body"> & { types: string[]; maxBytes: number },
  ): Promise<NfapiFile> {
    try {
      return await this.send<never>(operation, { ...options, accept: "binary" }) as unknown as NfapiFile;
    } catch (error) {
      const minVersion = OPERATION_MIN_VERSION[operation];
      throw minVersion ? await this.outdated(operation, minVersion, error) : error;
    }
  }

  /**
   * A chamada falhou como falha uma rota que o cofre não tem (404, 405, 400 ou
   * resposta fora do contrato): lê a versão do cofre e, se for anterior à
   * mínima, troca o erro por NfapiOutdatedError. Senão, o erro original.
   */
  private async outdated(operation: string, minVersion: string, error: unknown) {
    const routeMissing =
      (error instanceof NfapiError && [400, 404, 405].includes(error.status)) ||
      (error instanceof NfapiTransportError && error.kind === "bad_response");
    if (!routeMissing) return error;
    const version = await this.cofre().then((r) => r.body?.versao ?? null).catch(() => null);
    return version && olderThan(version, minVersion) ? new NfapiOutdatedError(operation, minVersion, version) : error;
  }

  private async send<T>(operation: ContractOperation, options: CallOptions): Promise<NfapiResponse<T>> {
    const [method, template] = operation.split(" ") as [string, string];
    const url = new URL(this.base + fill(template, options.params ?? {}));
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    const write = method !== "GET";
    // Trava de teste: POST é emissão, evento, manifestação ou consulta ao
    // governo. Em teste, só para o cofre simulado; nada sai.
    if (write && TEST_PROCESS && !isFakeVaultHost(url.hostname)) throw new NfapiTestGuardError(operation, url.hostname);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.connection.apiKey}`,
      Accept:
        options.accept === "binary"
          ? [...(options.types ?? []), "application/json"].join(", ")
          : options.accept === "text"
            ? "application/xml, application/json"
            : "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const timeout = write
      ? Math.max(this.connection.writeTimeoutMs ?? 90_000, options.minWriteTimeoutMs ?? 0)
      : (this.connection.readTimeoutMs ?? 20_000);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new NfapiTransportError("timeout", "O cofre não respondeu no tempo esperado.");
      throw new NfapiTransportError("network", "Não foi possível falar com o cofre.");
    }
    const type = response.headers.get("Content-Type") || "";
    if (options.accept === "binary" && response.ok) {
      const expected = (options.types ?? []).some((t) => type.toLowerCase().startsWith(t));
      if (!expected) {
        await response.body?.cancel().catch(() => undefined);
        throw new NfapiTransportError("bad_response", `O cofre respondeu um arquivo de tipo inesperado (${type || "sem tipo"}).`, response.status);
      }
      const body = await readCapped(response, options.maxBytes ?? MAX_PDF_BYTES);
      return { status: response.status, contentType: type, size: body.byteLength, body } as unknown as NfapiResponse<T>;
    }
    const text = await response.text().catch(() => "");
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

  /**
   * Emite. NFC-e com `contingencia` "automatica" ou "forcada": precisa do
   * cofre 0.4.0 e de tempo-limite acima da espera de até 20 s do cofre.
   */
  emitir<K extends NfapiDoc>(doc: K, pedido: Pedido<K>) {
    const contingencia = (pedido as { contingencia?: string }).contingencia;
    const contingent = doc === "nfce" && contingencia !== undefined && contingencia !== "nunca";
    return this.call<Emissao<K>>(`POST /v1/${doc}` as ContractOperation, {
      body: pedido,
      ...(contingent ? { minVersion: CONTINGENCY_MIN_VERSION, minWriteTimeoutMs: CONTINGENCY_MIN_WRITE_TIMEOUT_MS } : {}),
    });
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
  /** 201 homologada; 200 com `repetido` (0.4.1 em diante): a faixa já estava inutilizada. */
  inutilizar(pedido: Inutilizacao) {
    return this.call<InutilizacaoRegistrada>("POST /v1/inutilizacoes", { body: pedido });
  }

  // ----- XML dos eventos (0.4.1) e documentos impressos (0.7.0 e 0.8.0) -----

  /** XML do evento de cancelamento com o retorno do governo. */
  cancelamentoXml(doc: NfapiDoc, id: string) {
    return this.call<string>(`GET /v1/${doc}/{id}/cancelamento/xml` as ContractOperation, { params: { id }, accept: "text" });
  }
  /** XML da carta de correção de número `sequencia` (1 a 20). */
  cartaCorrecaoXml(id: string, sequencia: number) {
    return this.call<string>("GET /v1/nfe/{id}/carta-correcao/{sequencia}/xml", {
      params: { id, sequencia: String(sequencia) },
      accept: "text",
    });
  }
  /** DANFE (PDF), gerado na hora pelo cofre. */
  danfe(id: string) {
    return this.file("GET /v1/nfe/{id}/danfe", { params: { id }, types: ["application/pdf"], maxBytes: MAX_PDF_BYTES });
  }
  /** DANFE NFC-e (PDF) em bobina de 80 ou 58 mm, via do consumidor ou do estabelecimento. */
  danfce(id: string, opcoes: { largura?: "80" | "58"; via?: "consumidor" | "estabelecimento" } = {}) {
    return this.file("GET /v1/nfce/{id}/danfce", {
      params: { id },
      query: { largura: opcoes.largura, via: opcoes.via },
      types: ["application/pdf"],
      maxBytes: MAX_PDF_BYTES,
    });
  }
  /** Cupom da NFC-e em JSON, para a impressora do caixa. */
  cupom(id: string, opcoes: { via?: "consumidor" | "estabelecimento" } = {}) {
    return this.call<Cupom>("GET /v1/nfce/{id}/cupom", { params: { id }, query: { via: opcoes.via } });
  }
  /** Logotipo do emitente (PNG ou JPEG); 404 sem logotipo. */
  logotipo() {
    return this.file("GET /v1/cofre/logotipo", { types: ["image/png", "image/jpeg"], maxBytes: MAX_IMAGE_BYTES });
  }

  // ----- Inutilizações registradas (0.4.1) -----

  async inutilizacoes(filtro: { modelo?: NfapiDocNfe; ambiente?: "homologacao" | "producao"; serie?: number } = {}) {
    const r = await this.call<{ inutilizacoes?: InutilizacaoRegistrada[] }>("GET /v1/inutilizacoes", { query: filtro });
    return { status: r.status, body: Array.isArray(r.body?.inutilizacoes) ? r.body.inutilizacoes : [] };
  }
  inutilizacao(id: string) {
    return this.call<InutilizacaoRegistrada>("GET /v1/inutilizacoes/{id}", { params: { id } });
  }
  inutilizacaoXml(id: string) {
    return this.call<string>("GET /v1/inutilizacoes/{id}/xml", { params: { id }, accept: "text" });
  }

  // ----- NF-e recebidas e manifestação do destinatário (0.9.0) -----

  /**
   * Notas recebidas depois da sequência `depois`. Ler não consulta o governo.
   * A mesma nota reaparece quando muda: guarde `ultimaSequencia` e trate
   * pela `id` ou pela `chaveAcesso`.
   */
  async recebidas(filtro: { depois?: number; limite?: number; ambiente?: "homologacao" | "producao"; chaveAcesso?: string } = {}) {
    const r = await this.call<{ recebidas?: NotaRecebida[]; ultimaSequencia?: number; haMais?: boolean }>("GET /v1/nfe-recebidas", {
      query: filtro,
    });
    return {
      status: r.status,
      body: {
        recebidas: Array.isArray(r.body?.recebidas) ? r.body.recebidas : [],
        ultimaSequencia: typeof r.body?.ultimaSequencia === "number" ? r.body.ultimaSequencia : (filtro.depois ?? 0),
        haMais: !!r.body?.haMais,
      },
    };
  }
  recebida(id: string) {
    return this.call<NotaRecebida>("GET /v1/nfe-recebidas/{id}", { params: { id } });
  }
  /** XML da nota recebida; 409 xml_indisponivel antes da manifestação (só há resumo). */
  recebidaXml(id: string) {
    return this.call<string>("GET /v1/nfe-recebidas/{id}/xml", { params: { id }, accept: "text" });
  }
  recebidaDanfe(id: string) {
    return this.file("GET /v1/nfe-recebidas/{id}/danfe", { params: { id }, types: ["application/pdf"], maxBytes: MAX_PDF_BYTES });
  }
  /** Manifestação do destinatário. Evento fiscal: repetir devolve `repetido` sem enviar nada. */
  manifestar(id: string, pedido: Manifestacao) {
    return this.call<NotaRecebida>("POST /v1/nfe-recebidas/{id}/manifestar", { params: { id }, body: pedido });
  }
  /** Manifestação pela chave de acesso (nota que o cofre ainda não baixou). */
  manifestarPorChave(pedido: Manifestacao & { chaveAcesso: string; ambiente?: "homologacao" | "producao"; cnpj?: string }) {
    return this.call<NotaRecebida>("POST /v1/nfe-recebidas/manifestar", { body: pedido });
  }
  manifestacaoXml(id: string, tipo: Manifestacao["tipo"], sequencia: number) {
    return this.call<string>("GET /v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml", {
      params: { id, tipo, sequencia: String(sequencia) },
      accept: "text",
    });
  }
  /** Estado da consulta ao Ambiente Nacional por CNPJ e ambiente. NSU e espera são do cofre. */
  async distribuicao() {
    const r = await this.call<{ distribuicoes?: Distribuicao[] }>("GET /v1/distribuicao");
    return { status: r.status, body: Array.isArray(r.body?.distribuicoes) ? r.body.distribuicoes : [] };
  }
  /**
   * Pede ao cofre uma consulta ao Ambiente Nacional agora. Nunca em laço: o
   * cofre já consulta sozinho no ritmo permitido. O ERP não usa.
   */
  sincronizar(pedido: { ambiente?: "homologacao" | "producao"; cnpj?: string } = {}) {
    return this.call<Sincronizacao>("POST /v1/distribuicao/sincronizar", { body: pedido });
  }
  /** Busca uma NF-e pela chave no Ambiente Nacional. Gasta a cota: 18 por hora (429). */
  consultarChave(pedido: { chaveAcesso: string; ambiente?: "homologacao" | "producao"; cnpj?: string }) {
    return this.call<NotaRecebida>("POST /v1/distribuicao/consultar-chave", { body: pedido });
  }
  async documentosDistribuidos(filtro: { depois?: number; limite?: number; ambiente?: "homologacao" | "producao"; chaveAcesso?: string } = {}) {
    const r = await this.call<{ documentos?: DocumentoDistribuido[]; ultimaSequencia?: number; haMais?: boolean }>(
      "GET /v1/distribuicao/documentos",
      { query: filtro },
    );
    return {
      status: r.status,
      body: {
        documentos: Array.isArray(r.body?.documentos) ? r.body.documentos : [],
        ultimaSequencia: typeof r.body?.ultimaSequencia === "number" ? r.body.ultimaSequencia : (filtro.depois ?? 0),
        haMais: !!r.body?.haMais,
      },
    };
  }
  documentoDistribuidoXml(sequencia: number) {
    return this.call<string>("GET /v1/distribuicao/documentos/{sequencia}/xml", {
      params: { sequencia: String(sequencia) },
      accept: "text",
    });
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
        `GET /v1/${doc}/{id}/cancelamento/xml`,
        ...(doc === "nfse" ? [] : [`POST /v1/${doc}/{id}/consultar`]),
      ] as ContractOperation[],
  ),
  "POST /v1/nfe/{id}/carta-correcao",
  "GET /v1/nfe/{id}/carta-correcao/{sequencia}/xml",
  "GET /v1/nfe/{id}/danfe",
  "GET /v1/nfce/{id}/danfce",
  "GET /v1/nfce/{id}/cupom",
  "POST /v1/inutilizacoes",
  "GET /v1/inutilizacoes",
  "GET /v1/inutilizacoes/{id}",
  "GET /v1/inutilizacoes/{id}/xml",
  "GET /v1/nfe-recebidas",
  "GET /v1/nfe-recebidas/{id}",
  "GET /v1/nfe-recebidas/{id}/xml",
  "GET /v1/nfe-recebidas/{id}/danfe",
  "POST /v1/nfe-recebidas/{id}/manifestar",
  "POST /v1/nfe-recebidas/manifestar",
  "GET /v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml",
  "GET /v1/distribuicao",
  "POST /v1/distribuicao/sincronizar",
  "POST /v1/distribuicao/consultar-chave",
  "GET /v1/distribuicao/documentos",
  "GET /v1/distribuicao/documentos/{sequencia}/xml",
  "GET /v1/series",
  "GET /v1/cofre",
  "GET /v1/cofre/logotipo",
  "GET /v1/sefaz/status",
  "GET /v1/openapi.json",
];
