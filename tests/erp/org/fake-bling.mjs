// Simulador em memória: nunca abre socket nem delega ao fetch global.
// Por padrão a API de dados aceita exclusivamente GET. Com { writes: true }
// (mão dupla) aceita também POST e PUT nos caminhos de escrita, guarda cada
// escrita aplicada e deixa simular resposta incerta: queue({ method, path,
// apply, throw | status }) grava (ou não) e depois derruba a conexão ou
// devolve erro. OAuth usa fake-oauth.mjs.
import assert from "node:assert/strict";

const copy = value => structuredClone(value);
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...headers },
});

export class FakeClock {
  #time;
  constructor(now = Date.UTC(2026, 10, 19, 12)) {
    assert.ok(Number.isSafeInteger(now));
    this.#time = now;
  }
  now = () => this.#time;
  advance(milliseconds) {
    assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0);
    this.#time += milliseconds;
    return this.#time;
  }
  set(now) {
    assert.ok(Number.isSafeInteger(now) && now >= this.#time, "relógio não retrocede");
    this.#time = now;
  }
  iso = () => new Date(this.#time).toISOString();
}
export const fakeClock = now => new FakeClock(now);

/**
 * resource(path, rows), replacePage(path, page, rows) e setDetail permitem
 * alterar a lista entre chamadas sem produzir mutação HTTP. queue() injeta
 * erros, corpo lexical, truncamento ou queda. beforeRequest é síncrono.
 */
export class FakeBling {
  #resources = new Map();
  #replies = [];
  #hook = null;
  #calls = [];
  #mutationAttempts = 0;
  #clock;
  #writable = false;
  #writes = [];
  #stock = new Map();
  #nextId = 900001;
  constructor({ clock = new FakeClock(), baseUrl = "https://bling.invalid/Api/v3", writes = false } = {}) {
    this.#clock = clock;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#writable = writes === true;
  }
  get calls() { return copy(this.#calls); }
  get requests() { return this.calls; }
  get callCount() { return this.#calls.length; }
  /** Escritas efetivamente aplicadas (sempre 0 sem { writes: true }). */
  get mutations() { return this.#writes.length; }
  get mutationAttempts() { return this.#mutationAttempts; }
  /** Cópia das escritas aplicadas: método, caminho e corpo. */
  get writes() { return copy(this.#writes); }
  /** Lê um registro como está no simulador (depois das escritas). */
  record(path, id) { const resource = this.#resources.get(path); return resource?.details.has(id) ? copy(resource.details.get(id)) : null; }
  /** Saldo físico simulado de um produto num depósito. */
  setStock(product, deposit, quantity) { this.#stock.set(`${product}:${deposit}`, quantity); return this; }
  stock(product, deposit) { return this.#stock.get(`${product}:${deposit}`) ?? null; }
  resource(path, rows, { pageSize = 10, detail = true } = {}) {
    assert.ok(path.startsWith("/") && !path.includes("?"));
    assert.ok(Number.isInteger(pageSize) && pageSize > 0);
    const source = { rows: copy(rows), details: new Map(), pages: new Map(), pageSize, detail };
    for (const row of rows) {
      assert.equal(typeof row.id, "string", "IDs do fake são textuais");
      source.details.set(row.id, copy(row));
    }
    this.#resources.set(path, source);
    return this;
  }
  replaceRows(path, rows) {
    const resource = this.#resource(path);
    resource.rows = copy(rows);
    return this;
  }
  replacePage(path, page, rows) {
    assert.ok(Number.isSafeInteger(page) && page >= 1);
    this.#resource(path).pages.set(page, copy(rows));
    return this;
  }
  setDetail(path, id, record) {
    assert.equal(typeof id, "string");
    const details = this.#resource(path).details;
    if (record === null) details.delete(id);
    else details.set(id, copy(record));
    return this;
  }
  beforeRequest(hook) { this.#hook = hook; return this; }
  queue(reply) { this.#replies.push(reply); return this; }
  #resource(path) {
    const resource = this.#resources.get(path);
    assert.ok(resource, "recurso não registrado no simulador");
    return resource;
  }
  /** Conta real (versão 32): dados básicos da empresa em /empresas/me/dados-basicos. */
  company(record) { this.#company = copy(record); return this; }
  #company = null;
  /** Aplica uma escrita da mão dupla no estado simulado. */
  #write(method, path, body) {
    // Volta ao Bling (versão 32): situação do pedido de venda, sem corpo.
    const situation = path.match(/^\/pedidos\/vendas\/(\d+)\/situacoes\/(\d+)$/);
    if (method === "PATCH" && situation) {
      const resource = this.#resources.get("/pedidos/vendas");
      const current = resource?.details.get(situation[1]);
      if (!current) return { status: 404, data: { error: { type: "RESOURCE_NOT_FOUND" } } };
      this.#replace(resource, { ...current, situacao: { id: Number(situation[2]), valor: 0 } });
      return { status: 204, data: null };
    }
    const root = path.match(/^(\/(?:contatos|produtos|propostas-comerciais|pedidos\/vendas|pedidos\/compras|contas\/receber|contas\/pagar|listas-precos|campos-customizados))(?:\/(\d+))?(\/baixar)?$/);
    if (method === "POST" && path === "/estoques") {
      const product = String(body?.produto?.id), deposit = String(body?.deposito?.id);
      if (body?.operacao !== "B") return { status: 400, data: { error: { type: "VALIDATION_ERROR", description: "Operação de estoque não simulada." } } };
      this.#stock.set(`${product}:${deposit}`, Number(body.quantidade));
      return { status: 201, data: { data: { id: String(this.#nextId++) } } };
    }
    if (!root) return { status: 404, data: { error: { type: "RESOURCE_NOT_FOUND" } } };
    const [, collection, id, settle] = root;
    if (!this.#resources.has(collection)) this.resource(collection, []);
    const resource = this.#resources.get(collection);
    if (body?.nome === "RECUSAR") return { status: 400, data: { error: { type: "VALIDATION_ERROR", description: "Não foi possível salvar o contato", fields: [{ msg: "O nome informado não é aceito." }] } } };
    if (method === "POST" && settle) {
      const current = resource.details.get(id);
      if (!current) return { status: 404, data: { error: { type: "RESOURCE_NOT_FOUND" } } };
      const saldo = Math.round((Number(current.saldo ?? current.valor) - Number(body.valorRecebido)) * 100) / 100;
      this.#replace(resource, { ...current, saldo, situacao: saldo <= 0 ? 2 : 3 });
      return { status: 200, data: { data: { id: String(this.#nextId++) } } };
    }
    if (method === "POST" && !id) {
      const created = { ...copy(body), id: String(this.#nextId++) };
      this.#replace(resource, created);
      return { status: 201, data: { data: { id: created.id } } };
    }
    if (method === "PUT" && id) {
      if (!resource.details.has(id)) return { status: 404, data: { error: { type: "RESOURCE_NOT_FOUND" } } };
      this.#replace(resource, { ...copy(body), id });
      return { status: 204, data: null };
    }
    return { status: 405, data: { error: { type: "METHOD_NOT_ALLOWED" } } };
  }
  #replace(resource, record) {
    resource.details.set(record.id, copy(record));
    const index = resource.rows.findIndex(row => row.id === record.id);
    if (index >= 0) resource.rows[index] = copy(record); else resource.rows.push(copy(record));
  }
  /** Filtros de lista usados na conferência de uma criação incerta (só com { writes: true }). */
  #filtered(rows, params) {
    const digits = value => String(value ?? "").replace(/\D/g, "");
    return rows.filter(row => {
      if (params.has("numeroDocumento") && digits(row.numeroDocumento) !== digits(params.get("numeroDocumento"))) return false;
      if (params.has("codigos[]") && !params.getAll("codigos[]").includes(String(row.codigo))) return false;
      if (params.has("numero") && String(row.numero) !== params.get("numero")) return false;
      if (params.has("idContato") && String(row.contato?.id) !== params.get("idContato")) return false;
      if (params.has("dataInicial") && params.get("tipoFiltroData") === "V" && String(row.vencimento) < params.get("dataInicial")) return false;
      if (params.has("dataFinal") && params.get("tipoFiltroData") === "V" && String(row.vencimento) > params.get("dataFinal")) return false;
      return true;
    });
  }
  fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    if (request.method !== "GET") {
      this.#mutationAttempts++;
      if (!this.#writable) throw new Error("FAKE_BLING_GET_ONLY");
      assert.ok(["POST", "PUT", "PATCH"].includes(request.method), "método de escrita fora do simulador");
      const url = new URL(request.url), base = new URL(this.baseUrl);
      assert.equal(url.origin, base.origin, "host fora do simulador");
      const path = url.pathname.slice(base.pathname.replace(/\/$/, "").length);
      assert.ok(!/\/(nfe|nfce|ordens-servico)/.test(path), "nota fiscal e ordem de serviço nunca são escritas");
      assert.ok(!/\/(nfse|contratos|naturezas-operacoes)/.test(path), "NFS-e, contratos e naturezas nunca voltam ao Bling");
      assert.ok(/^Bearer \S+$/.test(request.headers.get("authorization") ?? ""), "escrita sem autorização");
      // PATCH da situação vai sem corpo; o resto da escrita é sempre JSON.
      const raw = await request.text();
      const body = raw ? JSON.parse(raw) : request.method === "PATCH" ? {} : JSON.parse(raw);
      const call = Object.freeze({ method: request.method, path, query: {}, at: this.#clock.now() });
      this.#calls.push(call);
      this.#hook?.(copy(call), this);
      const replyIndex = this.#replies.findIndex(reply => reply.method === request.method && (!reply.path || reply.path === path));
      const reply = replyIndex >= 0 ? this.#replies.splice(replyIndex, 1)[0] : null;
      let result = null;
      if (!reply || reply.apply) {
        result = this.#write(request.method, path, body);
        if (result.status < 300) this.#writes.push({ method: request.method, path, body: copy(body) });
      }
      if (reply?.advance) this.#clock.advance(reply.advance);
      if (reply?.throw) throw new Error(reply.throw === true ? "FAKE_BLING_CONNECTION_LOST" : reply.throw);
      if (reply?.status) return jsonResponse(reply.data ?? { error: { type: "simulated" } }, reply.status, reply.headers ?? {});
      return result.data === null ? new Response(null, { status: result.status }) : jsonResponse(result.data, result.status);
    }
    const url = new URL(request.url), base = new URL(this.baseUrl);
    assert.equal(url.origin, base.origin, "host fora do simulador");
    const basePath = base.pathname.replace(/\/$/, "");
    assert.ok(url.pathname.startsWith(basePath + "/"), "caminho fora da API simulada");
    const path = url.pathname.slice(basePath.length);
    // Só parâmetros de recursos são registrados; cabeçalhos não são guardados.
    for (const name of url.searchParams.keys())
      assert.ok(!/token|secret|code|authorization|password/i.test(name), "autorização não pertence à URL de dados");
    const call = Object.freeze({ method: "GET", path, query: Object.fromEntries(url.searchParams), at: this.#clock.now() });
    this.#calls.push(call);
    this.#hook?.(copy(call), this);
    const replyIndex = this.#replies.findIndex(reply => (!reply.method || reply.method === "GET") && (!reply.path || reply.path === path));
    if (replyIndex >= 0) {
      const reply = this.#replies.splice(replyIndex, 1)[0];
      if (reply.advance) this.#clock.advance(reply.advance);
      if (reply.throw) throw new Error(reply.throw === true ? "FAKE_BLING_CONNECTION_LOST" : reply.throw);
      const headers = { ...(reply.headers ?? {}) };
      if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
      if (reply.truncated) return new Response('{"data":[', { status: reply.status ?? 200, headers });
      if (reply.body !== undefined) return new Response(reply.body, { status: reply.status ?? 200, headers });
      return jsonResponse(reply.data ?? { error: { type: "simulated" } }, reply.status ?? 200, headers);
    }
    if (this.#company && path === "/empresas/me/dados-basicos") return jsonResponse({ data: copy(this.#company) });
    if (this.#writable && path === "/estoques/saldos") {
      const ids = url.searchParams.getAll("idsProdutos[]");
      return jsonResponse({ data: ids.map(id => ({ produto: { id: Number(id) }, depositos: [...this.#stock].filter(([key]) => key.startsWith(id + ":")).map(([key, saldo]) => ({ id: Number(key.split(":")[1]), saldoFisico: saldo })) })) });
    }
    const source = this.#resources.get(path);
    if (source) {
      const page = Number(url.searchParams.get("pagina") ?? 1);
      const limit = Number(url.searchParams.get("limite") ?? source.pageSize);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return jsonResponse({ error: { type: "invalid_page" } }, 400);
      const rows = this.#writable ? this.#filtered(source.rows, url.searchParams) : source.rows;
      return jsonResponse({ data: copy(source.pages.get(page) ?? rows.slice((page - 1) * limit, page * limit)) });
    }
    const slash = path.lastIndexOf("/"), parent = path.slice(0, slash), id = decodeURIComponent(path.slice(slash + 1));
    const resource = this.#resources.get(parent);
    if (resource?.detail && resource.details.has(id)) return jsonResponse({ data: copy(resource.details.get(id)) });
    return jsonResponse({ error: { type: "not_found" } }, 404);
  };
  assertReadOnly() {
    assert.equal(this.mutations, 0);
    assert.equal(this.mutationAttempts, 0);
    assert.ok(this.#calls.every(call => call.method === "GET"));
  }
}
export const fakeBling = options => new FakeBling(options);

/** Fatia D: registros de exemplo no formato público da API v3 (ainda não
 * conferido numa conta real). Cada caminho é o proposto em resources.ts. */
export const BLING_EXTRAS_PATHS = Object.freeze({
  price_lists: "/listas-precos", operation_natures: "/naturezas-operacoes", custom_fields: "/campos-customizados", contracts: "/contratos",
  service_invoices: "/nfse", product_lots: "/produtos/lotes", product_suppliers: "/produtos/fornecedores",
});
export function blingExtrasSample() {
  return {
    custom_fields: [
      { id: "7001", nome: "Voltagem", situacao: 1, obrigatorio: false, tipoCampo: { id: 4, nome: "Lista" }, modulo: { id: 1, nome: "Produtos" }, opcoes: [{ id: 1, nome: "110 V" }, { id: 2, nome: "220 V" }] },
      { id: "7002", nome: "Aniversário", obrigatorio: false, tipoCampo: { nome: "Data" }, modulo: { nome: "Contatos" } },
      { id: "7003", nome: "Sem módulo", tipoCampo: { nome: "Texto" } },
    ],
    price_lists: [
      { id: "8001", nome: "Atacado", produtos: [{ produto: { id: "501" }, preco: "9.90" }] },
      { id: "8002", nome: "Formato estranho", regras: [] },
    ],
    operation_natures: [
      { id: "9001", descricao: "Venda de mercadoria (Bling)", tipo: "S", crt: "1", padrao: true },
      { id: "9002", descricao: "Natureza sem regime", tipo: "S" },
    ],
    product_suppliers: [{ id: "9501", produto: { id: "501" }, fornecedor: { id: "301" }, codigo: "FORN-01", descricao: "Caneta do fornecedor", precoCusto: "1.25" }],
    product_lots: [{ id: "9601", produto: { id: "501" }, lote: "L-2026-01", dataValidade: "2027-01-31", saldo: "12", deposito: { id: "401" } }],
    contracts: [
      { id: "9701", numero: "15", descricao: "Manutenção mensal do ar-condicionado", contato: { id: "301", nome: "Cliente Bling" }, dataInicio: "2026-01-01", dataFim: "2026-12-31", valor: "150.00", periodicidade: "Mensal", situacao: "Ativo" },
      { id: "9702", numero: "16", contato: { id: "301" } },
    ],
    service_invoices: [{ id: "9801", numero: "321", serie: "1", dataEmissao: "2026-10-05", valor: "250.00", situacao: "Emitida", tomador: { nome: "Cliente Bling" } }],
  };
}
