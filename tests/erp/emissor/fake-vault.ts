// Cofre NFapi simulado, em memória, a partir do contrato
// (src/erp/emissor/contract/openapi.json) e do comportamento descrito nele e
// no README do cofre: idempotência por referência e conteúdo, séries
// cadastradas, UFs atendidas, inutilização extinta em SP/AC/BA, emissão
// `indefinida` que se resolve na consulta. Toda resposta JSON é conferida
// contra o schema do contrato (strict): o simulado não inventa campo.
//
// Falhas sob encomenda (`plan`), por operação de emissão:
//   "lose"          o cofre processa e a resposta se perde (rede)
//   "drop"          o pedido nem chega ao cofre (rede)
//   "inconclusive"  o governo não responde: emissão indefinida, 502
//   "reject"        o governo rejeita: 422 nfe_rejeitada com cStat
//   "deny"          uso denegado: 422 nfe_denegada
//   "gateway"       o cofre processa e a Cloudflare devolve HTML 502
//   "same-zone"     página "error code: 1042" (não chega ao cofre)
//   "internal"      o cofre emite e responde 500 erro_interno
// `sefaz.get(referencia)` decide o que o governo sabe de uma emissão indefinida:
//   "authorized" (padrão), "absent" (nunca recebeu) ou "unknown".
import { expect } from "vitest";
import { operation, responseSchema, validate, requestSchema } from "./schema";

export type Behavior = "ok" | "lose" | "drop" | "inconclusive" | "reject" | "deny" | "gateway" | "same-zone" | "internal";
type Doc = "nfe" | "nfce" | "nfse";
type Env = "homologacao" | "producao";

interface Emission {
  id: string;
  doc: Doc;
  ambiente: Env;
  referencia: string | null;
  hash: string;
  serie: number | string;
  numero: number;
  situacao: "processando" | "autorizada" | "rejeitada" | "denegada" | "erro" | "indefinida" | "cancelada";
  chaveAcesso: string | null;
  protocolo: string | null;
  mensagens: { codigo: string; descricao: string }[];
  uf: string;
  valor: number;
  cartas: number;
  criadaEm: string;
  atualizadaEm: string;
}

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

export interface FakeVaultOptions {
  apiKey?: string;
  scope?: "completo" | "homologacao";
  version?: string;
  published?: string | null;
  certificateUntil?: string | null;
  series?: { modelo: "nfe" | "nfce"; ambiente: Env; serie: number; proximoNumero: number }[];
  openapi?: unknown;
}

export function createFakeVault(options: FakeVaultOptions = {}) {
  const apiKey = options.apiKey ?? "nfapi_teste_0123456789";
  const emissions = new Map<string, Emission>();
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
  const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
  let seq = 0;
  const iso = () => new Date(Date.UTC(2026, 10, 16, 12, 0, seq)).toISOString();

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
          mensagens: e.mensagens,
          xmlDisponivel: e.situacao === "autorizada" || e.situacao === "cancelada",
          criadaEm: e.criadaEm,
          atualizadaEm: e.atualizadaEm,
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

  type Out = { status: number; body?: unknown; text?: string; type?: string; lose?: boolean; undeclared?: boolean };

  function emit(doc: Doc, body: any, behavior: Behavior): Out {
    const ambiente: Env = body.ambiente ?? "homologacao";
    if (options.scope === "homologacao" && ambiente === "producao")
      return { status: 403, body: erro("chave_somente_homologacao", "Esta chave só opera em homologação.") };
    const hash = JSON.stringify(stable({ ...body, referencia: undefined, ambiente: undefined }));
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
    if (e && (e.situacao === "autorizada" || e.situacao === "cancelada")) return { status: 200, body: view(e) };
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
        criadaEm: now,
        atualizadaEm: now,
      };
      emissions.set(e.id, e);
    } else Object.assign(e, { hash, serie, numero, situacao: "processando", mensagens: [], atualizadaEm: now });
    e.chaveAcesso = `35261199888777000166${doc === "nfce" ? "65" : "55"}${String(serie).padStart(3, "0")}${String(numero).padStart(9, "0")}1${String(seq).padStart(8, "0")}`.padEnd(44, "0").slice(0, 44);
    if (behavior === "reject") {
      e.situacao = "rejeitada";
      e.mensagens = [{ codigo: "539", descricao: "Rejeição: Duplicidade de NF-e, com diferença na Chave de Acesso" }];
      const s = series.find((x) => x.modelo === doc && x.ambiente === ambiente && x.serie === serie);
      if (s) s.proximoNumero--;
      return { status: 422, body: erro("nfe_rejeitada", e.mensagens[0].descricao, { mensagens: e.mensagens, [doc]: view(e) }) };
    }
    if (behavior === "deny") {
      e.situacao = "denegada";
      e.mensagens = [{ codigo: "302", descricao: "Uso Denegado: Irregularidade fiscal do destinatário" }];
      return { status: 422, body: erro("nfe_denegada", e.mensagens[0].descricao, { mensagens: e.mensagens, [doc]: view(e) }) };
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
    // erro_interno está na tabela x-codigos (500), mas as operações não
    // declaram 500: fica fora da conferência de status.
    if (behavior === "internal")
      return { status: 500, body: erro("erro_interno", "Falha inesperada do cofre."), undeclared: true };
    if (behavior === "gateway") return { status: 502, text: "<html>502 Bad Gateway</html>", type: "text/html" };
    return { status: 201, body: view(e) };
  }

  function route(method: string, path: string, body: any, query: URLSearchParams): Out {
    const m = /^\/v1\/(nfe|nfce|nfse)(?:\/([^/]+)(?:\/(xml|cancelar|consultar|carta-correcao))?)?$/.exec(path);
    if (method === "GET" && path === "/v1/openapi.json") return { status: 200, body: options.openapi };
    if (method === "GET" && path === "/v1/cofre") {
      const until = options.certificateUntil === undefined ? "2027-03-01T03:00:00.000Z" : options.certificateUntil;
      return {
        status: 200,
        body: {
          versao: options.version ?? "0.3.2",
          atualizacao: { versaoPublicada: options.published ?? options.version ?? "0.3.2", pendente: !!options.published && options.published !== (options.version ?? "0.3.2") },
          certificado: until
            ? {
                titular: "EMPRESA EXEMPLO LTDA",
                documento: { kind: "cnpj", id: "99888777000166" },
                validoAte: until,
                diasRestantes: Math.floor((Date.parse(until) - Date.parse("2026-11-16T12:00:00Z")) / 86_400_000),
              }
            : null,
          producaoLiberada: false,
          chave: { escopo: options.scope ?? "completo", ambientes: options.scope === "homologacao" ? ["homologacao"] : ["homologacao", "producao"] },
          documentos: { nfse: true, nfe: { ufs: NFE_UFS }, nfce: { ufs: NFCE_UFS } },
        },
      };
    }
    if (method === "GET" && path === "/v1/series")
      return { status: 200, body: { series: series.map((s) => ({ ...s, descricao: null, cnpj: "99888777000166" })) } };
    if (method === "GET" && path === "/v1/sefaz/status") {
      const uf = query.get("uf") || "";
      if (!/^[A-Z]{2}$/.test(uf)) return { status: 400, body: erro("requisicao_invalida", "uf: informe a UF."), };
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
    if (method === "POST" && path === "/v1/inutilizacoes") {
      if (!["SP", "AC", "AL", "AP", "CE", "DF", "ES", "PA", "PB", "PI", "RJ", "RN", "RO", "RR", "SC", "SE", "TO"].includes(body.uf))
        return { status: 422, body: erro("uf_nao_suportada", `A UF ${body.uf} ainda não está disponível neste cofre.`) };
      if (NO_VOID.includes(body.uf))
        return {
          status: 422,
          body: erro(
            "inutilizacao_extinta",
            `A inutilização de numeração deixou de existir em ${body.uf} (Ajustes SINIEF 38 e 40 de 2026): números não usados simplesmente ficam sem nota.`,
          ),
        };
      return {
        status: 201,
        body: {
          id: `inu_${(++seq).toString(16).padStart(20, "0")}`,
          modelo: body.modelo,
          ambiente: body.ambiente ?? "homologacao",
          serie: body.serie,
          numeroInicial: body.numeroInicial,
          numeroFinal: body.numeroFinal,
          protocolo: "135260000000001",
          criadaEm: iso(),
        },
      };
    }
    if (!m) return { status: 404, body: erro("nao_encontrado", "Rota desconhecida.") };
    const [, doc, id, action] = m as unknown as [string, Doc, string | undefined, string | undefined];
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
    if (!e || e.doc !== doc) return { status: 404, body: erro("nao_encontrado", "Emissão inexistente.") };
    if (!action && method === "GET") return { status: 200, body: view(e) };
    if (action === "xml" && method === "GET")
      return e.situacao === "autorizada" || e.situacao === "cancelada"
        ? { status: 200, text: `<nfeProc><NFe Id="NFe${e.chaveAcesso}"/></nfeProc>`, type: "application/xml" }
        : { status: 404, body: erro("nao_encontrado", "XML indisponível.") };
    if (action === "consultar" && method === "POST") {
      if (e.situacao === "indefinida") resume(e);
      return { status: 200, body: view(e) };
    }
    if (action === "cancelar" && method === "POST") {
      const behavior = plan.shift() ?? "ok";
      if (behavior === "drop") throw new TypeError("network connection lost");
      if (e.situacao === "cancelada") return { status: 200, body: { ...view(e), repetido: true } };
      if (e.situacao !== "autorizada")
        return { status: 409, body: erro(doc === "nfse" ? "nfse_nao_autorizada" : "nfe_nao_autorizada", "Só é possível cancelar uma nota autorizada.") };
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
      e.cartas++;
      return { status: 200, body: { ...view(e), repetido: false }, lose: behavior === "lose" };
    }
    return { status: 404, body: erro("nao_encontrado", "Rota desconhecida.") };
  }

  /** Caminho do contrato para validar a resposta. */
  function contractPath(path: string) {
    return path
      .replace(/^\/v1\/(nfe|nfce|nfse)\/[^/]+(\/(xml|cancelar|consultar|carta-correcao))?$/, (_, d, rest) => `/v1/${d}/{id}${rest ?? ""}`);
  }

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const auth = new Headers(init.headers).get("Authorization");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body, auth });
    if (plan[0] === "same-zone" && method === "POST") {
      plan.shift();
      return new Response("error code: 1042", { status: 403, headers: { "Content-Type": "text/plain" } });
    }
    const opPath = contractPath(url.pathname);
    const op = operation(method, opPath);
    expect(op, `${method} ${opPath} não existe no contrato`).toBeTruthy();
    let out: Out;
    if (auth !== `Bearer ${apiKey}`) out = { status: 401, body: erro("nao_autenticado", "Chave de API ausente, inválida ou revogada.") };
    else {
      const schema = requestSchema(method, opPath);
      const invalid = schema && body !== undefined ? validate(schema, body) : [];
      if (invalid.length) {
        const campo = invalid[0].split(":")[0].replace(/^\$\.?/, "");
        out = { status: 400, body: erro("requisicao_invalida", `${campo}: inválido.`, { campo }) };
      } else out = route(method, url.pathname, body, url.searchParams);
    }
    if (out.text !== undefined) {
      if (out.lose) throw new TypeError("network connection lost");
      return new Response(out.text, { status: out.status, headers: { "Content-Type": out.type || "text/plain" } });
    }
    if (out.undeclared) expect(validate({ $ref: "#/components/schemas/Erro" }, out.body, "$", true)).toEqual([]);
    else if (opPath !== "/v1/openapi.json") {
      const rs = responseSchema(method, opPath, out.status);
      expect(rs, `${method} ${opPath} não declara HTTP ${out.status}`).not.toBeUndefined();
      if (rs) expect(validate(rs, out.body, "$", true), `${method} ${opPath} ${out.status} fora do contrato`).toEqual([]);
    }
    if (out.lose) throw new TypeError("network connection lost");
    return Response.json(out.body, { status: out.status });
  };

  return {
    apiKey,
    fetch: fetcher as typeof fetch,
    plan,
    sefaz,
    calls,
    emissions,
    series,
    authorizedAtSefaz,
    /** Emissões com nota válida (autorizada) por referência que começa com o prefixo. */
    validNotes(prefix: string) {
      return [...emissions.values()].filter((e) => e.referencia?.startsWith(prefix) && e.situacao === "autorizada");
    },
  };
}
