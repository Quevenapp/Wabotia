// Simulador em memória: nunca abre socket nem delega ao fetch global.
// A API de dados aceita exclusivamente GET. OAuth usa fake-oauth.mjs.
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
  constructor({ clock = new FakeClock(), baseUrl = "https://bling.invalid/Api/v3" } = {}) {
    this.#clock = clock;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  get calls() { return copy(this.#calls); }
  get requests() { return this.calls; }
  get callCount() { return this.#calls.length; }
  get mutations() { return 0; }
  get mutationAttempts() { return this.#mutationAttempts; }
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
  fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    if (request.method !== "GET") {
      this.#mutationAttempts++;
      throw new Error("FAKE_BLING_GET_ONLY");
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
    const replyIndex = this.#replies.findIndex(reply => !reply.path || reply.path === path);
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
    const source = this.#resources.get(path);
    if (source) {
      const page = Number(url.searchParams.get("pagina") ?? 1);
      const limit = Number(url.searchParams.get("limite") ?? source.pageSize);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return jsonResponse({ error: { type: "invalid_page" } }, 400);
      return jsonResponse({ data: copy(source.pages.get(page) ?? source.rows.slice((page - 1) * limit, page * limit)) });
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
