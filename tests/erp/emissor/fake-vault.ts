// Cofre NFapi simulado, em memória, a partir do contrato
// (src/erp/emissor/contract/openapi.json) e do comportamento descrito nele e
// no código do cofre: idempotência por referência e conteúdo, séries
// cadastradas, UFs atendidas, inutilização extinta em SP/AC/BA, emissão
// `indefinida` que se resolve na consulta, contingência da NFC-e, documentos
// impressos e NF-e recebidas. Toda resposta JSON é conferida contra o schema
// do contrato (strict): o simulado não inventa campo.
//
// `version` simula um cofre antigo: operação mais nova que ele responde 404
// "Rota desconhecida." (como o roteador do cofre), e o pedido de NFC-e com
// `contingencia` em cofre anterior à 0.4.0 responde 400.
//
// Falhas sob encomenda (`plan`), por operação de emissão ou evento:
//   "lose"              o cofre processa e a resposta se perde (rede)
//   "drop"              o pedido nem chega ao cofre (rede)
//   "inconclusive"      o governo não responde: indefinida (ou contingência,
//                       na NFC-e com contingencia automatica), 502
//   "contingency-wait"  NFC-e automática: o governo não responde e o cofre
//                       fica esperando (processando) até `finishWait()`;
//                       a resposta se perde (o caixa desistiu de esperar)
//   "reject"            o governo rejeita: 422 nfe_rejeitada com cStat 539
//   "reject:245"        idem, com o cStat escolhido (245, 181)
//   "deny"              uso denegado: 422 nfe_denegada
//   "gateway"           o cofre processa e a Cloudflare devolve HTML 502
//   "same-zone"         página "error code: 1042" (não chega ao cofre)
//   "internal"          o cofre emite e responde 500 erro_interno
// `sefaz.get(referencia)` decide o que o governo sabe de uma emissão indefinida:
//   "authorized" (padrão), "absent" (nunca recebeu) ou "unknown".
// `sefazSends` conta o que saiu para o governo (emissão, transmissão de
// contingência, eventos, manifestação, consulta por chave), por chave.
import { expect } from "vitest";
import contract from "../../../src/erp/emissor/contract/openapi.json";
import { OPERATION_MIN_VERSION, olderThan } from "../../../src/erp/emissor/nfapi.ts";
import { operation, responseSchema, validate, requestSchema } from "./schema";

export type Behavior =
  | "ok"
  | "lose"
  | "drop"
  | "inconclusive"
  | "contingency-wait"
  | "reject"
  | `reject:${keyof typeof REJECTIONS}`
  | "deny"
  | "gateway"
  | "same-zone"
  | "internal";

/** cStat e xMotivo das rejeições simuladas (245 e 181 como relatados pela NFapi). */
const REJECTIONS = {
  "539": "Rejeição: Duplicidade de NF-e, com diferença na Chave de Acesso",
  "245": "Rejeição: CNPJ Emitente não cadastrado",
  "181": "Rejeição: CNPJ do destinatário inexistente na Receita Federal",
} as const;
type Doc = "nfe" | "nfce" | "nfse";
type Env = "homologacao" | "producao";
type Tipo = "ciencia" | "confirmacao" | "desconhecimento" | "nao_realizada";

interface Emission {
  id: string;
  doc: Doc;
  ambiente: Env;
  referencia: string | null;
  hash: string;
  serie: number | string;
  numero: number;
  situacao: "processando" | "autorizada" | "contingencia" | "rejeitada" | "denegada" | "erro" | "indefinida" | "cancelada";
  chaveAcesso: string | null;
  protocolo: string | null;
  mensagens: { codigo: string; descricao: string }[];
  uf: string;
  valor: number;
  cartas: number;
  contingencia: null | { pendente: boolean; desde: string; motivo: string; tentativas: number; ultima: string | null };
  /** Esperando o governo antes de cair em contingência (contingency-wait). */
  waiting: boolean;
  criadaEm: string;
  atualizadaEm: string;
}

interface Received {
  id: string;
  ambiente: Env;
  cnpj: string;
  chaveAcesso: string;
  sequencia: number;
  papel: "destinatario" | "terceiro";
  numero: number;
  valor: number;
  situacao: "autorizada" | "cancelada";
  xmlDisponivel: boolean;
  manifestacoes: { tipo: Tipo; sequencia: number; protocolo: string; registradaEm: string; justificativa: string | null; origem: string; xmlDisponivel: boolean }[];
  recebidaEm: string;
  atualizadaEm: string;
}

const spec = contract as any;

const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .filter((k) => (v as any)[k] !== undefined)
            .map((k) => [k, stable((v as any)[k])]),
        )
      : v;

const NFE_UFS = ["SP", "AC", "AL", "AP", "CE", "DF", "ES", "PA", "PB", "PI", "RJ", "RN", "RO", "RR", "SC", "SE", "TO"];
const NFCE_UFS = ["SP"];
const NO_VOID = ["SP", "AC", "BA"];
/** PDF mínimo (bytes do cabeçalho e do fim): o cliente repassa sem abrir. */
export const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const FAKE_CNPJ = "99888777000166";
export const LATEST = String(spec.info.version);

/** Caminho do contrato que casa com o caminho pedido (parâmetros como {id}). */
const TEMPLATES = Object.keys(spec.paths).map((template) => ({
  template,
  re: new RegExp(`^${template.replace(/\{\w+\}/g, "[^/]+")}$`),
  literal: !template.includes("{"),
}));
function contractPath(path: string) {
  // Caminho fixo antes de parametrizado (/v1/nfe-recebidas/manifestar ≠ /{id}).
  return (TEMPLATES.find((t) => t.literal && t.template === path) ?? TEMPLATES.find((t) => t.re.test(path)))?.template ?? path;
}

export interface FakeVaultOptions {
  apiKey?: string;
  scope?: "completo" | "homologacao";
  /** Versão do cofre instalado (padrão: a do contrato). */
  version?: string;
  published?: string | null;
  certificateUntil?: string | null;
  series?: { modelo: "nfe" | "nfce"; ambiente: Env; serie: number; proximoNumero: number }[];
  openapi?: unknown;
  /** Logotipo do emitente (padrão: PNG). */
  logo?: "png" | "jpeg" | null;
  /** Notas recebidas configuradas (UF do estabelecimento informada). Padrão: true. */
  distribution?: boolean;
}

export function createFakeVault(options: FakeVaultOptions = {}) {
  const apiKey = options.apiKey ?? "nfapi_teste_0123456789";
  const version = options.version ?? LATEST;
  const emissions = new Map<string, Emission>();
  const received = new Map<string, Received>();
  const voids: { id: string; modelo: string; ambiente: Env; serie: number; numeroInicial: number; numeroFinal: number; justificativa: string; criadaEm: string }[] = [];
  const series = (
    options.series ?? [
      { modelo: "nfe", ambiente: "homologacao", serie: 1, proximoNumero: 1 },
      { modelo: "nfce", ambiente: "homologacao", serie: 1, proximoNumero: 1 },
    ]
  ).map((s) => ({ ...s }));
  const plan: Behavior[] = [];
  const sefaz = new Map<string, "authorized" | "absent" | "unknown">();
  /** Notas que o governo autorizou de fato (inclui as que o cofre não soube). */
  const authorizedAtSefaz: string[] = [];
  /** O que saiu para o governo, por chave (referência, nota recebida ou chave consultada). */
  const sefazSends = new Map<string, number>();
  const sent = (key: string) => sefazSends.set(key, (sefazSends.get(key) ?? 0) + 1);
  const calls: { method: string; path: string; body: any; auth: string | null; query: string }[] = [];
  const keyQueries: number[] = [];
  const state = { sefazOnline: false, blockedUntil: null as string | null, receivedSeq: 0 };
  let seq = 0;
  const iso = () => new Date(Date.UTC(2026, 10, 16, 12, 0, seq)).toISOString();
  const has = (min: string) => !olderThan(version, min);

  const view = (e: Emission) =>
    e.doc === "nfse"
      ? {
          id: e.id,
          ambiente: e.ambiente,
          referencia: e.referencia,
          serie: String(e.serie),
          numero: e.numero,
          idDps: `DPS${String(e.numero).padStart(15, "0")}`,
          situacao: e.situacao === "denegada" ? "rejeitada" : e.situacao,
          chaveAcesso: e.chaveAcesso,
          numeroNfse: e.situacao === "autorizada" || e.situacao === "cancelada" ? String(e.numero) : null,
          mensagens: e.mensagens,
          xmlDisponivel: e.situacao === "autorizada" || e.situacao === "cancelada",
          criadaEm: e.criadaEm,
          atualizadaEm: e.atualizadaEm,
        }
      : {
          id: e.id,
          modelo: e.doc,
          ambiente: e.ambiente,
          referencia: e.referencia,
          serie: Number(e.serie),
          numero: e.numero,
          situacao: e.situacao,
          chaveAcesso: e.chaveAcesso,
          protocolo: e.protocolo,
          emitidaEm: e.criadaEm,
          autorizadaEm: e.situacao === "autorizada" || e.situacao === "cancelada" ? e.atualizadaEm : null,
          valor: e.valor,
          qrCode: e.doc === "nfce" ? `https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${e.chaveAcesso}|2|2|1|X` : null,
          urlConsulta: e.doc === "nfce" ? "https://www.homologacao.nfce.fazenda.sp.gov.br/consulta" : null,
          cartasCorrecao: e.cartas,
          ...(has("0.4.0")
            ? {
                contingencia: e.contingencia
                  ? {
                      pendente: e.contingencia.pendente,
                      desde: e.contingencia.desde,
                      motivo: e.contingencia.motivo,
                      tentativasDeTransmissao: e.contingencia.tentativas,
                      ultimaTentativa: e.contingencia.ultima,
                      notaNormalEmConferencia: null,
                      falhaNaConferencia: null,
                      notaNormalCancelada: null,
                    }
                  : null,
              }
            : {}),
          mensagens: e.mensagens,
          xmlDisponivel: e.situacao === "autorizada" || e.situacao === "cancelada" || e.situacao === "contingencia",
          criadaEm: e.criadaEm,
          atualizadaEm: e.atualizadaEm,
        };

  const receivedView = (n: Received, repetido?: boolean) => {
    const last = n.manifestacoes.at(-1) ?? null;
    return {
      id: n.id,
      ambiente: n.ambiente,
      cnpj: n.cnpj,
      chaveAcesso: n.chaveAcesso,
      sequencia: n.sequencia,
      papel: n.papel,
      emitente: { documento: "11222333000181", nome: "FORNECEDOR SINTETICO LTDA", ie: null },
      serie: 1,
      numero: n.numero,
      emitidaEm: n.recebidaEm,
      autorizadaEm: n.recebidaEm,
      protocolo: "135260000099999",
      tipoOperacao: "saida",
      valor: n.valor,
      situacao: n.situacao,
      xmlDisponivel: n.xmlDisponivel,
      manifestacao: last,
      manifestacoes: n.manifestacoes,
      cienciaAutomaticaRecusada: null,
      eventos: [],
      recebidaEm: n.recebidaEm,
      atualizadaEm: n.atualizadaEm,
      ...(repetido === undefined ? {} : { repetido }),
    };
  };

  const erro = (codigo: string, mensagem: string, extra: Record<string, unknown> = {}) => ({
    erro: { codigo, mensagem },
    ...extra,
  });

  function authorize(e: Emission) {
    e.situacao = "autorizada";
    e.protocolo = `1352600000${String(++seq).padStart(5, "0")}`;
    e.mensagens = [{ codigo: "100", descricao: "Autorizado o uso da NF-e" }];
    e.atualizadaEm = iso();
    authorizedAtSefaz.push(e.id);
  }

  /** NFC-e sem resposta do governo: nota nova em contingência offline (tipo de emissão 9). */
  function toContingency(e: Emission, motivo = "SEFAZ sem resposta conclusiva") {
    const s = series.find((x) => x.modelo === e.doc && x.ambiente === e.ambiente && x.serie === Number(e.serie));
    if (s) e.numero = s.proximoNumero++;
    e.situacao = "contingencia";
    e.waiting = false;
    e.protocolo = null;
    e.mensagens = [];
    e.contingencia = { pendente: true, desde: iso(), motivo, tentativas: 0, ultima: null };
    e.chaveAcesso = accessKey(e, "9");
    e.atualizadaEm = iso();
  }

  /** O cofre tenta transmitir a nota em contingência (sozinho ou no /consultar). */
  function transmit(e: Emission) {
    if (!e.contingencia?.pendente) return;
    e.contingencia.tentativas++;
    e.contingencia.ultima = iso();
    sent(e.referencia || e.id);
    if (!state.sefazOnline) return;
    e.contingencia.pendente = false;
    authorize(e);
  }

  /** O que o governo sabe de uma emissão indefinida (retomada do cofre). */
  function resume(e: Emission) {
    const truth = sefaz.get(e.referencia || e.id) ?? "authorized";
    if (truth === "unknown") return;
    if (truth === "authorized") {
      // Já foi autorizada no governo quando ficou indefinida: só registra.
      e.situacao = "autorizada";
      e.protocolo = `1352600000${String(++seq).padStart(5, "0")}`;
      e.mensagens = [{ codigo: "100", descricao: "Autorizado o uso da NF-e" }];
      e.atualizadaEm = iso();
      if (!authorizedAtSefaz.includes(e.id)) authorizedAtSefaz.push(e.id);
      return;
    }
    e.situacao = "rejeitada";
    e.mensagens = [{ codigo: "217", descricao: "Rejeição: NF-e não consta na base de dados da SEFAZ" }];
    const s = series.find((x) => x.modelo === e.doc && x.ambiente === e.ambiente && x.serie === Number(e.serie));
    if (s && s.proximoNumero === e.numero + 1) s.proximoNumero = e.numero;
  }

  const accessKey = (e: Emission, tpEmis = "1") =>
    `35261199888777000166${e.doc === "nfce" ? "65" : "55"}${String(e.serie).padStart(3, "0")}${String(e.numero).padStart(9, "0")}${tpEmis}${String(seq).padStart(8, "0")}`
      .padEnd(44, "0")
      .slice(0, 44);

  type Out = {
    status: number;
    body?: unknown;
    text?: string;
    bytes?: Uint8Array;
    type?: string;
    lose?: boolean;
  };

  function emit(doc: Doc, body: any, behavior: Behavior): Out {
    const ambiente: Env = body.ambiente ?? "homologacao";
    if (options.scope === "homologacao" && ambiente === "producao")
      return { status: 403, body: erro("chave_somente_homologacao", "Esta chave só opera em homologação.") };
    if (body.contingencia !== undefined && !has("0.4.0"))
      return { status: 400, body: erro("requisicao_invalida", "contingencia: campo desconhecido.", { campo: "contingencia" }) };
    // Como o cofre: a contingência não entra na comparação de conteúdo.
    const hash = JSON.stringify(stable({ ...body, referencia: undefined, ambiente: undefined, contingencia: undefined }));
    const referencia = body.referencia ?? null;
    let e = referencia
      ? [...emissions.values()].find((x) => x.doc === doc && x.ambiente === ambiente && x.referencia === referencia)
      : undefined;
    if (e && e.hash !== hash && e.situacao !== "rejeitada" && e.situacao !== "erro")
      return {
        status: 409,
        body: erro(
          "referencia_com_conteudo_diferente",
          "Esta referência já foi usada em um pedido com conteúdo diferente. Use outra referência para um documento novo.",
        ),
      };
    if (e && (e.situacao === "autorizada" || e.situacao === "cancelada" || e.situacao === "contingencia"))
      return { status: 200, body: view(e) };
    if (e?.situacao === "processando")
      return { status: 409, body: erro("emissao_em_andamento", "Já existe uma emissão em andamento para esta referência.") };
    if (e?.situacao === "denegada")
      return { status: 422, body: erro("nfe_denegada", "Uso denegado.", { mensagens: e.mensagens, [doc]: view(e) }) };
    if (e?.situacao === "indefinida") {
      resume(e);
      if (e.situacao === "autorizada") return { status: 201, body: view(e) };
      if (e.situacao === "indefinida")
        return {
          status: 502,
          body: erro("sem_resposta_conclusiva", "Sem resposta do governo.", {
            mensagens: [{ codigo: "sem_resposta_conclusiva", descricao: "Sem resposta do governo." }],
            [doc]: view(e),
          }),
        };
    }
    let uf = "SP";
    if (doc !== "nfse") {
      uf = body.emitente?.endereco?.uf;
      if (!(doc === "nfce" ? NFCE_UFS : NFE_UFS).includes(uf))
        return {
          status: 422,
          body: erro("uf_nao_suportada", `A emissão de ${doc === "nfce" ? "NFC-e" : "NF-e"} para a UF ${uf} ainda não está disponível neste cofre.`),
        };
    }
    let numero: number;
    let serie: number | string;
    if (doc === "nfse") {
      serie = body.serie ?? "1";
      numero = ++seq;
    } else {
      const s = series.find((x) => x.modelo === doc && x.ambiente === ambiente && x.serie === (body.serie ?? 1));
      if (!s)
        return {
          status: 422,
          body: erro("serie_nao_cadastrada", `A série ${body.serie ?? 1} não está cadastrada para ${ambiente}. Cadastre-a na tela do cofre.`),
        };
      serie = s.serie;
      numero = s.proximoNumero++;
    }
    const now = iso();
    if (!e) {
      e = {
        id: `${doc === "nfce" ? "nfc" : doc === "nfse" ? "nfs" : "nfe"}_${(++seq).toString(16).padStart(20, "0")}`,
        doc,
        ambiente,
        referencia,
        hash,
        serie,
        numero,
        situacao: "processando",
        chaveAcesso: null,
        protocolo: null,
        mensagens: [],
        uf,
        valor: 100,
        cartas: 0,
        contingencia: null,
        waiting: false,
        criadaEm: now,
        atualizadaEm: now,
      };
      emissions.set(e.id, e);
    } else Object.assign(e, { hash, serie, numero, situacao: "processando", mensagens: [], atualizadaEm: now });
    e.chaveAcesso = accessKey(e);
    const contingencia = doc === "nfce" ? (body.contingencia ?? "nunca") : "nunca";
    if (contingencia === "forcada") {
      toContingency(e, "Contingência pedida pelo sistema emissor");
      return { status: 201, body: view(e) };
    }
    sent(referencia || e.id);
    if (behavior === "reject" || behavior.startsWith("reject:")) {
      const cstat = (behavior.split(":")[1] ?? "539") as keyof typeof REJECTIONS;
      e.situacao = "rejeitada";
      e.mensagens = [{ codigo: cstat, descricao: REJECTIONS[cstat] }];
      const s = series.find((x) => x.modelo === doc && x.ambiente === ambiente && x.serie === serie);
      if (s) s.proximoNumero--;
      return { status: 422, body: erro("nfe_rejeitada", e.mensagens[0].descricao, { mensagens: e.mensagens, [doc]: view(e) }) };
    }
    if (behavior === "deny") {
      e.situacao = "denegada";
      e.mensagens = [{ codigo: "302", descricao: "Uso Denegado: Irregularidade fiscal do destinatário" }];
      return { status: 422, body: erro("nfe_denegada", e.mensagens[0].descricao, { mensagens: e.mensagens, [doc]: view(e) }) };
    }
    if (behavior === "contingency-wait" && contingencia === "automatica") {
      // O governo não responde e o cofre espera (até 20 s) antes de cair em
      // contingência; quem chamou desistiu de esperar: a resposta se perde.
      e.waiting = true;
      return { status: 201, body: view(e), lose: true };
    }
    if (behavior === "inconclusive" && contingencia === "automatica") {
      toContingency(e);
      return { status: 201, body: view(e) };
    }
    if (behavior === "inconclusive") {
      // O governo pode ter autorizado (sefaz.get decide na retomada).
      e.situacao = "indefinida";
      e.mensagens = [{ codigo: "sem_resposta_conclusiva", descricao: "O governo não respondeu." }];
      if ((sefaz.get(e.referencia || e.id) ?? "authorized") === "authorized") authorizedAtSefaz.push(e.id);
      return {
        status: 502,
        body: erro("sem_resposta_conclusiva", "O governo não respondeu. Repita o pedido com a mesma referência.", {
          mensagens: e.mensagens,
          [doc]: view(e),
        }),
      };
    }
    authorize(e);
    if (behavior === "lose") return { status: 201, body: view(e), lose: true };
    if (behavior === "internal") return { status: 500, body: erro("erro_interno", "Falha inesperada do cofre.") };
    if (behavior === "gateway") return { status: 502, text: "<html>502 Bad Gateway</html>", type: "text/html" };
    return { status: 201, body: view(e) };
  }

  const pdf = (): Out => ({ status: 200, bytes: FAKE_PDF, type: "application/pdf" });
  const notFound = (what = "Emissão inexistente.") => ({ status: 404, body: erro("nao_encontrado", what) });
  const tipoOk = (t: unknown): t is Tipo => ["ciencia", "confirmacao", "desconhecimento", "nao_realizada"].includes(t as string);

  /** Manifestação do destinatário, com as regras do cofre (recebidas/servico.ts). */
  function manifest(n: Received, body: any, behavior: Behavior): Out {
    if (options.distribution === false)
      return { status: 409, body: erro("distribuicao_nao_configurada", "Configure as notas recebidas na tela /setup antes de manifestar.") };
    if (options.scope === "homologacao" && n.ambiente === "producao")
      return { status: 403, body: erro("chave_somente_homologacao", "Esta chave só opera em homologação.") };
    const tipo = body.tipo as Tipo;
    const justificativa = tipo === "nao_realizada" ? (body.justificativa?.trim() as string | undefined) : undefined;
    if (tipo === "nao_realizada" && (!justificativa || justificativa.length < 15 || justificativa.length > 255))
      return { status: 422, body: erro("justificativa_obrigatoria", "A operação não realizada exige a justificativa, de 15 a 255 caracteres.") };
    const last = n.manifestacoes.at(-1);
    if (last && last.tipo === tipo && (last.justificativa ?? undefined) === justificativa)
      return { status: 200, body: receivedView(n, true) };
    if (tipo === "ciencia" && n.manifestacoes.length > 0)
      return { status: 409, body: erro("manifestacao_ja_registrada", "A ciência da operação não cabe depois de outra manifestação da mesma nota.") };
    const sequencia = n.manifestacoes.filter((m) => m.tipo === tipo).length + 1;
    if (sequencia > 2)
      return { status: 422, body: erro("limite_de_manifestacoes", "Cada manifestação conclusiva pode ser registrada no máximo duas vezes por nota.") };
    sent(n.id);
    if (behavior === "inconclusive")
      return {
        status: 502,
        body: erro("sem_resposta_conclusiva", "O Ambiente Nacional não respondeu. Repita a manifestação.", {
          mensagens: [{ codigo: "sem_resposta_conclusiva", descricao: "Sem resposta." }],
        }),
      };
    n.manifestacoes.push({
      tipo,
      sequencia,
      protocolo: `191260000${String(++seq).padStart(6, "0")}`,
      registradaEm: iso(),
      justificativa: justificativa ?? null,
      origem: "api",
      xmlDisponivel: true,
    });
    n.sequencia = ++state.receivedSeq;
    n.atualizadaEm = iso();
    return { status: 200, body: receivedView(n, false), lose: behavior === "lose" };
  }

  function route(method: string, path: string, body: any, query: URLSearchParams): Out {
    if (method === "GET" && path === "/v1/openapi.json") return { status: 200, body: options.openapi };
    if (method === "GET" && path === "/v1/cofre") {
      const until = options.certificateUntil === undefined ? "2027-03-01T03:00:00.000Z" : options.certificateUntil;
      return {
        status: 200,
        body: {
          versao: version,
          atualizacao: { versaoPublicada: options.published ?? version, pendente: !!options.published && options.published !== version },
          certificado: until
            ? {
                titular: "EMPRESA EXEMPLO LTDA",
                documento: { kind: "cnpj", id: FAKE_CNPJ },
                validoAte: until,
                diasRestantes: Math.floor((Date.parse(until) - Date.parse("2026-11-16T12:00:00Z")) / 86_400_000),
              }
            : null,
          producaoLiberada: false,
          ...(has("0.4.0")
            ? { contingencia: { notasPendentes: [...emissions.values()].filter((e) => e.contingencia?.pendente).length } }
            : {}),
          ...(has("0.8.0") ? { logotipo: (options.logo === undefined ? "png" : options.logo) !== null } : {}),
          chave: { escopo: options.scope ?? "completo", ambientes: options.scope === "homologacao" ? ["homologacao"] : ["homologacao", "producao"] },
          documentos: { nfse: true, nfe: { ufs: NFE_UFS }, nfce: { ufs: NFCE_UFS } },
        },
      };
    }
    if (method === "GET" && path === "/v1/cofre/logotipo") {
      const logo = options.logo === undefined ? "png" : options.logo;
      if (!logo) return notFound("O cofre não tem logotipo.");
      return { status: 200, bytes: FAKE_PNG, type: logo === "png" ? "image/png" : "image/jpeg" };
    }
    if (method === "GET" && path === "/v1/series")
      return { status: 200, body: { series: series.map((s) => ({ ...s, descricao: null, cnpj: FAKE_CNPJ })) } };
    if (method === "GET" && path === "/v1/sefaz/status") {
      const uf = query.get("uf") || "";
      if (!/^[A-Z]{2}$/.test(uf)) return { status: 400, body: erro("requisicao_invalida", "uf: informe a UF.") };
      if (!NFE_UFS.includes(uf)) return { status: 422, body: erro("uf_nao_suportada", `A UF ${uf} ainda não está disponível neste cofre.`) };
      return {
        status: 200,
        body: {
          modelo: query.get("modelo") || "nfe",
          uf,
          ambiente: (query.get("ambiente") as Env) || "homologacao",
          autorizador: uf === "SP" ? "SP" : "SVRS",
          emOperacao: true,
          mensagem: { codigo: "107", descricao: "Serviço em Operação" },
          tempoMedioSegundos: 1,
        },
      };
    }

    // ----- Inutilizações -----
    if (path === "/v1/inutilizacoes" && method === "POST") {
      const behavior = plan.shift() ?? "ok";
      if (behavior === "drop") throw new TypeError("network connection lost");
      if (!NFE_UFS.includes(body.uf))
        return { status: 422, body: erro("uf_nao_suportada", `A UF ${body.uf} ainda não está disponível neste cofre.`) };
      if (NO_VOID.includes(body.uf))
        return {
          status: 422,
          body: erro(
            "inutilizacao_extinta",
            `A inutilização de numeração deixou de existir em ${body.uf} (Ajustes SINIEF 38 e 40 de 2026): números não usados simplesmente ficam sem nota.`,
          ),
        };
      const ambiente: Env = body.ambiente ?? "homologacao";
      const same = voids.find(
        (v) => v.modelo === body.modelo && v.ambiente === ambiente && v.serie === body.serie && v.numeroInicial === body.numeroInicial && v.numeroFinal === body.numeroFinal,
      );
      if (same && has("0.4.1")) return { status: 200, body: voidView(same, true) };
      sent(`inu:${body.modelo}:${body.serie}:${body.numeroInicial}-${body.numeroFinal}`);
      const v = { id: `inu_${(++seq).toString(16).padStart(20, "0")}`, modelo: body.modelo, ambiente, serie: body.serie, numeroInicial: body.numeroInicial, numeroFinal: body.numeroFinal, justificativa: body.justificativa, criadaEm: iso() };
      voids.push(v);
      return { status: 201, body: voidView(v, false), lose: behavior === "lose" };
    }
    if (path === "/v1/inutilizacoes" && method === "GET")
      return {
        status: 200,
        body: {
          inutilizacoes: voids
            .filter((v) => (!query.get("modelo") || v.modelo === query.get("modelo")) && (!query.get("serie") || v.serie === Number(query.get("serie"))))
            .reverse()
            .map((v) => voidView(v)),
        },
      };
    const inu = /^\/v1\/inutilizacoes\/([^/]+)(\/xml)?$/.exec(path);
    if (inu && method === "GET") {
      const v = voids.find((x) => x.id === inu[1]);
      if (!v) return notFound("Inutilização inexistente.");
      return inu[2] ? { status: 200, text: `<procInutNFe><inutNFe Id="ID${v.id}"/></procInutNFe>`, type: "application/xml" } : { status: 200, body: voidView(v) };
    }

    // ----- NF-e recebidas e distribuição -----
    if (path === "/v1/distribuicao" && method === "GET")
      return {
        status: 200,
        body: {
          distribuicoes:
            options.distribution === false
              ? []
              : [
                  {
                    cnpj: FAKE_CNPJ,
                    ambiente: "homologacao",
                    uf: "SP",
                    consultaAutomatica: false,
                    cienciaAutomatica: false,
                    ultimoNsu: state.receivedSeq,
                    maiorNsu: state.receivedSeq,
                    ultimaConsulta: null,
                    proximaConsulta: state.blockedUntil,
                    bloqueada: !!state.blockedUntil,
                    mensagem: null,
                    consultasPorChave: { naUltimaHora: keyQueries.length, limite: 18 },
                  },
                ],
        },
      };
    if (path === "/v1/distribuicao/sincronizar" && method === "POST") {
      if (options.distribution === false)
        return { status: 409, body: erro("distribuicao_nao_configurada", "Salve a configuração das notas recebidas antes de consultar.") };
      sent("distribuicao");
      return { status: 200, body: { consultou: true, lotes: 1, documentos: 0, notasNovas: 0 } };
    }
    if (path === "/v1/distribuicao/consultar-chave" && method === "POST") {
      if (options.distribution === false)
        return { status: 409, body: erro("distribuicao_nao_configurada", "Salve a configuração das notas recebidas antes de consultar.") };
      if ((body.ambiente ?? "homologacao") === "producao" && options.scope === "homologacao")
        return { status: 403, body: erro("chave_somente_homologacao", "Esta chave só opera em homologação.") };
      if (body.chaveAcesso.slice(20, 22) !== "55")
        return { status: 422, body: erro("chave_de_acesso_invalida", "Informe a chave de acesso (44 posições) de uma NF-e, modelo 55.") };
      if (state.blockedUntil)
        return { status: 429, body: erro("consumo_indevido", `O Ambiente Nacional bloqueou as consultas deste CNPJ por uma hora. Tente depois de ${state.blockedUntil}.`) };
      if (keyQueries.length >= 18)
        return { status: 429, body: erro("limite_de_consultas", `Limite de 18 consultas por chave em uma hora. Tente depois de 2026-11-16T13:00:00.000Z.`) };
      keyQueries.push(Date.now());
      sent(`chave:${body.chaveAcesso}`);
      const found = [...received.values()].find((n) => n.chaveAcesso === body.chaveAcesso);
      if (!found) return { status: 422, body: erro("nota_nao_localizada", "O Ambiente Nacional não tem esta nota disponível para este CNPJ.", { mensagens: [{ codigo: "137", descricao: "Nenhum documento localizado" }] }) };
      return { status: 200, body: receivedView(found) };
    }
    if (path === "/v1/distribuicao/documentos" && method === "GET")
      return { status: 200, body: { documentos: [], ultimaSequencia: Number(query.get("depois") || 0), haMais: false } };
    if (/^\/v1\/distribuicao\/documentos\/[^/]+\/xml$/.test(path) && method === "GET") return notFound("Documento inexistente.");
    if (path === "/v1/nfe-recebidas" && method === "GET") {
      const depois = Number(query.get("depois") || 0);
      const limite = Math.min(Number(query.get("limite") || 50), 200);
      const chave = query.get("chaveAcesso");
      const all = [...received.values()]
        .filter((n) => n.sequencia > depois && (!chave || n.chaveAcesso === chave) && (!query.get("ambiente") || n.ambiente === query.get("ambiente")))
        .sort((a, b) => a.sequencia - b.sequencia);
      const page = all.slice(0, limite);
      return {
        status: 200,
        body: { recebidas: page.map((n) => receivedView(n)), ultimaSequencia: page.at(-1)?.sequencia ?? depois, haMais: all.length > page.length },
      };
    }
    if (path === "/v1/nfe-recebidas/manifestar" && method === "POST") {
      const behavior = plan.shift() ?? "ok";
      if (behavior === "drop") throw new TypeError("network connection lost");
      let n = [...received.values()].find((x) => x.chaveAcesso === body.chaveAcesso);
      if (!n) n = addReceived({ chaveAcesso: body.chaveAcesso, papel: "destinatario", visible: false });
      return manifest(n, body, behavior);
    }
    const rec = /^\/v1\/nfe-recebidas\/([^/]+)(?:\/(xml|danfe|manifestar)|\/manifestacoes\/([^/]+)\/(\d+)\/xml)?$/.exec(path);
    if (rec) {
      const n = received.get(rec[1]);
      if (!n) return notFound("Nota recebida inexistente.");
      if (!rec[2] && !rec[3] && method === "GET") return { status: 200, body: receivedView(n) };
      if (rec[2] === "xml" && method === "GET")
        return n.xmlDisponivel
          ? { status: 200, text: `<nfeProc><NFe Id="NFe${n.chaveAcesso}"/></nfeProc>`, type: "application/xml" }
          : { status: 409, body: erro("xml_indisponivel", "O cofre só tem o resumo desta nota. O XML completo é liberado depois da manifestação do destinatário.") };
      if (rec[2] === "danfe" && method === "GET")
        return n.xmlDisponivel ? pdf() : { status: 409, body: erro("xml_indisponivel", "O DANFE precisa do XML completo, liberado depois da manifestação do destinatário.") };
      if (rec[2] === "manifestar" && method === "POST") {
        const behavior = plan.shift() ?? "ok";
        if (behavior === "drop") throw new TypeError("network connection lost");
        return manifest(n, body, behavior);
      }
      if (rec[3] && method === "GET") {
        const m = n.manifestacoes.find((x) => x.tipo === rec[3] && x.sequencia === Number(rec[4]));
        return m ? { status: 200, text: `<procEventoNFe><evento tpEvento="${m.tipo}"/></procEventoNFe>`, type: "application/xml" } : notFound("Manifestação inexistente.");
      }
    }

    // ----- Emissões -----
    const m = /^\/v1\/(nfe|nfce|nfse)(?:\/([^/]+)(?:\/(xml|cancelar|consultar|carta-correcao|danfe|danfce|cupom|cancelamento\/xml|carta-correcao\/(\d+)\/xml))?)?$/.exec(path);
    if (!m) return notFound("Rota desconhecida.");
    const [, doc, id, action, sequencia] = m as unknown as [string, Doc, string | undefined, string | undefined, string | undefined];
    if (!id) {
      if (method === "POST") {
        const behavior = plan.shift() ?? "ok";
        if (behavior === "drop") throw new TypeError("network connection lost");
        return emit(doc, body, behavior);
      }
      const ref = query.get("referencia");
      const amb = query.get("ambiente");
      const list = [...emissions.values()]
        .filter((e) => e.doc === doc && (!ref || e.referencia === ref) && (!amb || e.ambiente === amb))
        .reverse()
        .slice(0, Number(query.get("limite") || 50))
        .map(view);
      return { status: 200, body: { [doc]: list } };
    }
    const e = emissions.get(id);
    if (!e || e.doc !== doc) return notFound();
    if (!action && method === "GET") return { status: 200, body: view(e) };
    if (action === "xml" && method === "GET")
      return e.situacao === "autorizada" || e.situacao === "cancelada" || e.situacao === "contingencia"
        ? { status: 200, text: `<nfeProc><NFe Id="NFe${e.chaveAcesso}"/></nfeProc>`, type: "application/xml" }
        : notFound("XML indisponível.");
    if (action === "cancelamento/xml" && method === "GET")
      return e.situacao === "cancelada"
        ? { status: 200, text: `<procEventoNFe><evento tpEvento="110111"/></procEventoNFe>`, type: "application/xml" }
        : notFound("A nota não tem cancelamento.");
    if (action?.startsWith("carta-correcao/") && method === "GET")
      return Number(sequencia) <= e.cartas
        ? { status: 200, text: `<procEventoNFe><evento tpEvento="110110" nSeqEvento="${sequencia}"/></procEventoNFe>`, type: "application/xml" }
        : notFound("Carta de correção inexistente.");
    if ((action === "danfe" || action === "danfce") && method === "GET") {
      if (action === "danfce" && (!["80", "58"].includes(query.get("largura") ?? "80") || !["consumidor", "estabelecimento"].includes(query.get("via") ?? "consumidor")))
        return { status: 400, body: erro("requisicao_invalida", "largura: 80 ou 58; via: consumidor ou estabelecimento.", { campo: "largura" }) };
      return e.situacao === "autorizada" || e.situacao === "cancelada" || e.situacao === "contingencia"
        ? pdf()
        : { status: 409, body: erro("nfe_nao_autorizada", "A nota não tem XML autorizado arquivado.") };
    }
    if (action === "cupom" && method === "GET") {
      const via = query.get("via") ?? "consumidor";
      if (!["consumidor", "estabelecimento"].includes(via))
        return { status: 400, body: erro("requisicao_invalida", "via: consumidor ou estabelecimento.", { campo: "via" }) };
      if (!(e.situacao === "autorizada" || e.situacao === "contingencia"))
        return { status: 409, body: erro("nfe_nao_autorizada", "A nota não tem XML autorizado arquivado.") };
      return {
        status: 200,
        body: {
          id: e.id,
          situacao: e.situacao,
          modelo: "nfce",
          chaveAcesso: e.chaveAcesso,
          ambiente: e.ambiente,
          contingencia: e.situacao === "contingencia",
          pendenteDeAutorizacao: !!e.contingencia?.pendente,
          via,
          numero: e.numero,
          serie: Number(e.serie),
          emitidaEm: e.criadaEm,
          protocolo: e.protocolo,
          autorizadaEm: e.situacao === "autorizada" ? e.atualizadaEm : null,
          valorAPagar: e.valor,
          qrCode: `https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${e.chaveAcesso}|2|2|1|X`,
          urlConsulta: "https://www.homologacao.nfce.fazenda.sp.gov.br/consulta",
          secoes: [
            { divisao: "cabecalho", linhas: [{ tipo: "texto", texto: "EMPRESA EXEMPLO LTDA", alinhamento: "centro", negrito: true, tamanho: "normal" }] },
            { divisao: "totais", linhas: [{ tipo: "par", rotulo: "Valor a pagar R$", valor: "100,00", negrito: true }] },
            { divisao: "qrcode", linhas: [{ tipo: "qrcode", texto: "https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode", tamanhoMinimoMm: 25 }] },
          ],
        },
      };
    }
    if (action === "consultar" && method === "POST") {
      if (e.situacao === "indefinida") resume(e);
      if (e.situacao === "contingencia") transmit(e);
      return { status: 200, body: view(e) };
    }
    if (action === "cancelar" && method === "POST") {
      const behavior = plan.shift() ?? "ok";
      if (behavior === "drop") throw new TypeError("network connection lost");
      if (e.situacao === "cancelada") return { status: 200, body: { ...view(e), repetido: true } };
      if (e.situacao !== "autorizada")
        return { status: 409, body: erro(doc === "nfse" ? "nfse_nao_autorizada" : "nfe_nao_autorizada", "Só é possível cancelar uma nota autorizada.") };
      sent(`cancelar:${e.id}`);
      if (behavior === "inconclusive")
        return { status: 502, body: erro("sem_resposta_conclusiva", "Sem resposta.", { mensagens: [{ codigo: "sem_resposta_conclusiva", descricao: "Sem resposta." }] }) };
      e.situacao = "cancelada";
      e.mensagens = [{ codigo: "135", descricao: "Evento registrado e vinculado a NF-e" }];
      return { status: 200, body: { ...view(e), repetido: false }, lose: behavior === "lose" };
    }
    if (action === "carta-correcao" && method === "POST" && doc === "nfe") {
      const behavior = plan.shift() ?? "ok";
      if (e.situacao !== "autorizada") return { status: 409, body: erro("nfe_nao_autorizada", "Só é possível corrigir uma nota autorizada.") };
      if (e.cartas >= 20) return { status: 422, body: erro("limite_de_cartas", "A nota já tem o máximo de 20 cartas de correção.") };
      sent(`carta:${e.id}`);
      e.cartas++;
      return { status: 200, body: { ...view(e), repetido: false }, lose: behavior === "lose" };
    }
    return notFound("Rota desconhecida.");
  }

  function voidView(v: (typeof voids)[number], repetido?: boolean) {
    return {
      id: v.id,
      modelo: v.modelo,
      ambiente: v.ambiente,
      serie: v.serie,
      numeroInicial: v.numeroInicial,
      numeroFinal: v.numeroFinal,
      protocolo: "135260000000001",
      ...(has("0.4.1") ? { justificativa: v.justificativa, xmlDisponivel: true } : {}),
      criadaEm: v.criadaEm,
      ...(repetido !== undefined && has("0.4.1") ? { repetido } : {}),
    };
  }

  /** Uma NF-e emitida contra o CNPJ chega do Ambiente Nacional (só o resumo). */
  function addReceived(input: { chaveAcesso?: string; papel?: "destinatario" | "terceiro"; valor?: number; visible?: boolean } = {}) {
    const n: Received = {
      id: `rec_${(++seq).toString(16).padStart(20, "0")}`,
      ambiente: "homologacao",
      cnpj: FAKE_CNPJ,
      chaveAcesso: input.chaveAcesso ?? `3526111122233300018155001${String(seq).padStart(9, "0")}1${String(seq).padStart(8, "0")}`.padEnd(44, "0"),
      sequencia: ++state.receivedSeq,
      papel: input.papel ?? "destinatario",
      numero: seq,
      valor: input.valor ?? 250.5,
      situacao: "autorizada",
      xmlDisponivel: false,
      manifestacoes: [],
      recebidaEm: iso(),
      atualizadaEm: iso(),
    };
    received.set(n.id, n);
    return n;
  }

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const auth = new Headers(init.headers).get("Authorization");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body, auth, query: url.search });
    if (plan[0] === "same-zone" && method === "POST") {
      plan.shift();
      return new Response("error code: 1042", { status: 403, headers: { "Content-Type": "text/plain" } });
    }
    const opPath = contractPath(url.pathname);
    const op = operation(method, opPath);
    expect(op, `${method} ${opPath} não existe no contrato`).toBeTruthy();
    const key = `${method} ${opPath}` as keyof typeof OPERATION_MIN_VERSION;
    const min = OPERATION_MIN_VERSION[key];
    let out: Out;
    if (auth !== `Bearer ${apiKey}`) out = { status: 401, body: erro("nao_autenticado", "Chave de API ausente, inválida ou revogada.") };
    else if (min && olderThan(version, min)) out = notFound("Rota desconhecida.");
    else {
      const schema = requestSchema(method, opPath);
      const invalid = schema && body !== undefined ? validate(schema, body) : [];
      if (invalid.length) {
        const campo = invalid[0].split(":")[0].replace(/^\$\.?/, "");
        out = { status: 400, body: erro("requisicao_invalida", `${campo}: inválido.`, { campo }) };
      } else out = route(method, url.pathname, body, url.searchParams);
    }
    if (out.bytes !== undefined || out.text !== undefined) {
      if (out.status === 200 && out.type && opPath !== "/v1/openapi.json" && !(min && olderThan(version, min))) {
        const declared = Object.keys(spec.paths[opPath]?.[method.toLowerCase()]?.responses?.["200"]?.content ?? {});
        if (out.type !== "text/html") expect(declared, `${method} ${opPath} não declara ${out.type}`).toContain(out.type);
      }
      if (out.lose) throw new TypeError("network connection lost");
      return new Response(out.bytes ?? out.text!, {
        status: out.status,
        headers: { "Content-Type": out.type || "text/plain", ...(out.bytes ? { "Content-Length": String(out.bytes.byteLength) } : {}) },
      });
    }
    // Rota que o cofre antigo não tem: o contrato atual não descreve o 404 dele.
    if (!(min && olderThan(version, min)) && opPath !== "/v1/openapi.json" && auth === `Bearer ${apiKey}`) {
      const rs = responseSchema(method, opPath, out.status);
      expect(rs, `${method} ${opPath} não declara HTTP ${out.status}`).not.toBeUndefined();
      if (rs) expect(validate(rs, out.body, "$", true), `${method} ${opPath} ${out.status} fora do contrato`).toEqual([]);
    }
    if (out.lose) throw new TypeError("network connection lost");
    return Response.json(out.body, { status: out.status });
  };

  return {
    apiKey,
    version,
    fetch: fetcher as typeof fetch,
    plan,
    sefaz,
    sefazSends,
    calls,
    emissions,
    received,
    voids,
    series,
    authorizedAtSefaz,
    state,
    addReceived,
    /** O XML completo da nota recebida chegou (depois da manifestação). */
    deliverXml(id: string) {
      const n = received.get(id)!;
      n.xmlDisponivel = true;
      n.sequencia = ++state.receivedSeq;
      n.atualizadaEm = iso();
    },
    /** Termina a espera do governo: as NFC-e esperando caem em contingência. */
    finishWait() {
      for (const e of emissions.values()) if (e.waiting) toContingency(e);
    },
    /** O cofre transmite sozinho as notas em contingência (SEFAZ de volta). */
    transmitPending() {
      for (const e of emissions.values()) if (e.contingencia?.pendente) transmit(e);
    },
    /** Emissões com nota válida (autorizada ou em contingência) por referência que começa com o prefixo. */
    validNotes(prefix: string) {
      return [...emissions.values()].filter(
        (e) => e.referencia?.startsWith(prefix) && (e.situacao === "autorizada" || e.situacao === "contingencia"),
      );
    },
  };
}
