// Vinki: cache de sessão do controlador do ERP (web/erp/session-cache.ts usado por
// web/erp/app/lib/real-access.ts). Um teste por regra de invalidação, mais: o que fica
// fora da lista nunca é guardado, erros não são guardados, pedido em voo compartilhado
// com cancelamento por chamador e cópia a cada leitura.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createAccessController, AccessError } from "../app/lib/real-access.ts";
import { cachePolicy, writeScope, STABLE_TTL_MS, PERMISSIONS_TTL_MS } from "../session-cache.ts";

const actor = "c0000000-0000-4000-8000-000000000001";
const doc = "d0000000-0000-4000-8000-000000000001";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const isAbort = (error) => error instanceof DOMException && error.name === "AbortError";
const isStatus = (status) => (error) => error instanceof AccessError && error.status === status;

/** Resposta pendente que respeita o cancelamento do fetch, como o fetch real. */
function pending(options) {
  let resolve;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    options.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")), { once: true });
  });
  return { promise, resolve };
}

/** Controlador real com um fetch sintético; `handler` pode responder caminhos específicos. */
function harness({ apiUrl = "https://api.cache.test", handler } = {}) {
  const s = { role: "admin", me: 0, calls: [], authCallback() {}, session: { access_token: "synthetic-token", user: { id: actor } } };
  const auth = {
    getSession: async () => ({ data: { session: s.session }, error: null }),
    onAuthStateChange(callback) { s.authCallback = callback; return { data: { subscription: { unsubscribe() { s.authCallback = () => {}; } } } }; },
    signOut: async () => ({ error: null }),
  };
  s.fetcher = async (url, options = {}) => {
    const u = new URL(url), path = u.pathname + u.search;
    if (u.pathname === "/v1/me") { s.me++; return Response.json({ user_id: actor, role: s.role, resources: [], data_mode: "staging_readonly" }); }
    s.calls.push({ path, method: options.method, signal: options.signal });
    const custom = await handler?.(path, options, s);
    if (custom !== undefined) return custom;
    return Response.json({ path, call: s.calls.length, items: [{ id: 1 }] });
  };
  s.controller = createAccessController(auth, apiUrl, s.fetcher);
  s.reads = (path) => s.calls.filter((c) => c.path === path && c.method === "GET").length;
  s.start = async () => { s.stop = s.controller.start(); await settle(); assert.equal(s.controller.getSnapshot().phase, "ready"); };
  s.signIn = async (token) => { s.session = { access_token: token, user: { id: actor } }; s.authCallback("SIGNED_IN", s.session); await settle(); assert.equal(s.controller.getSnapshot().phase, "ready"); };
  return s;
}

const STABLE_READS = [
  ["system", "/v1/sistema/perfil"],
  ["preferences", "/v1/preferencias/empresa-geral"],
  ["listPreferences", "/v1/preferencias-listas/cadastros.produtos"],
  ["catalog", "/v1/cadastros/taxonomias/categorias-produtos"],
  ["catalog", "/v1/cadastros/taxonomias/tags"],
  ["catalog", "/v1/cadastros/taxonomias/grupos-tags"],
  ["catalog", "/v1/cadastros/tipos-contato"],
  ["catalog", "/v1/cadastros/vendedores/opcoes?q=ana"],
  ["documents", "/v1/documentos/sales_orders/situacoes"],
  ["documents", "/v1/documentos/sales_orders/categorias"],
  ["documents", "/v1/documentos/sales_orders/preferencias-listagem"],
  ["catalog", "/v1/cadastros"],
  ["documents", "/v1/documentos"],
  ["finance", "/v1/financeiro"],
];

test("lista estável: a segunda leitura vem do cache, e cada leitura recebe uma cópia", async () => {
  const s = harness(); await s.start();
  try {
    for (const [method, path] of STABLE_READS) {
      const first = await s.controller[method](path);
      first.items[0].id = 99; first.extra = true;
      const second = await s.controller[method](path);
      assert.equal(s.reads(path), 1, path);
      assert.notEqual(second, first, path);
      assert.deepEqual(second.items, [{ id: 1 }], path);
      assert.equal(second.extra, undefined, path);
    }
  } finally { s.stop(); }
});

test("fora da lista nunca fica no cache (financeiro, estoque, documentos, preços, /v1/me)", async () => {
  const s = harness(); await s.start();
  try {
    const never = [
      ["finance", "/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=open"],
      ["finance", "/v1/financeiro/accounts?limit=100"],
      ["finance", "/v1/financeiro/categories?limit=25"],
      ["finance", "/v1/financeiro/controle-caixa/" + doc],
      ["stockPositions", "/v1/posicoes-estoque?active=true&warehouse_id=" + doc],
      ["documents", "/v1/documentos/sales_orders?page=1&limit=25"],
      ["documents", "/v1/documentos/sales_orders/" + doc],
      ["documents", "/v1/documentos/sales_orders/pagamento"],
      ["catalog", "/v1/cadastros/listas-precos"],
      ["catalog", "/v1/cadastros/listas-precos/aplicaveis?vendedor="],
      ["catalog", "/v1/cadastros/products?page=1&size=100"],
      ["company", "/v1/empresa/identidade"],
      ["system", "/v1/sistema/armazenamento"],
      ["preferences", `/v1/preferencias/comandos/${doc}`],
    ];
    for (const [method, path] of never) {
      await s.controller[method](path); await s.controller[method](path);
      assert.equal(s.reads(path), 2, path);
      assert.equal(cachePolicy(path)?.ttl ?? 0, 0, path);
    }
    // Sem dedupe para quem está fora da lista: dois pedidos iguais ao mesmo tempo vão os dois.
    const titles = "/v1/financeiro/titles?page=2&limit=100&kind=receivable";
    await Promise.all([s.controller.finance(titles), s.controller.finance(titles)]);
    assert.equal(s.reads(titles), 2);
    // /v1/me vai sempre ao servidor.
    const me = s.me; s.controller.retry(); await settle(); s.controller.retry(); await settle();
    assert.equal(s.me, me + 2);
  } finally { s.stop(); }
});

test("erros não ficam no cache", async () => {
  let fail = 2;
  const s = harness({ handler: (path) => path === "/v1/cadastros/taxonomias/tags" && fail-- > 0 ? Response.json({}, { status: fail ? 503 : 404 }) : undefined });
  await s.start();
  try {
    const path = "/v1/cadastros/taxonomias/tags";
    await assert.rejects(s.controller.catalog(path), isStatus(503));
    await assert.rejects(s.controller.catalog(path), isStatus(404));
    await s.controller.catalog(path); await s.controller.catalog(path);
    assert.equal(s.reads(path), 3);
  } finally { s.stop(); }
});

test("invalidação 1: escrita na mesma área invalida a área; escrita de configuração limpa tudo; escrita recusada também invalida", async () => {
  let refuse = false, gate = null;
  const s = harness({ handler: (path, options) => {
    if (options.method === "POST" && refuse) return Response.json({}, { status: 409 });
    if (path === "/v1/documentos/sales_orders/situacoes" && gate) { const p = pending(options); gate.resolve = p.resolve; return p.promise; }
  } });
  await s.start();
  const situations = "/v1/documentos/sales_orders/situacoes", types = "/v1/cadastros/tipos-contato", prefs = "/v1/preferencias/vendas-vendas";
  try {
    await s.controller.documents(situations); await s.controller.catalog(types); await s.controller.preferences(prefs);
    // Escrita em /v1/documentos: só a área de documentos sai do cache.
    await s.controller.documents(`/v1/documentos/sales_orders/${doc}/status`, { method: "POST", body: { status: "approved" } });
    await s.controller.documents(situations); await s.controller.catalog(types); await s.controller.preferences(prefs);
    assert.deepEqual([s.reads(situations), s.reads(types), s.reads(prefs)], [2, 1, 1]);
    // Escrita em /v1/cadastros (não é área "só ela"): limpa tudo, inclusive situações de documentos.
    await s.controller.catalog("/v1/cadastros/tipos-contato", { method: "POST", body: { command_id: doc, label: "Parceiro" } });
    await s.controller.documents(situations); await s.controller.catalog(types); await s.controller.preferences(prefs);
    assert.deepEqual([s.reads(situations), s.reads(types), s.reads(prefs)], [3, 2, 2]);
    // Escrita recusada (409) também invalida: o servidor pode ter mudado algo.
    refuse = true;
    await assert.rejects(s.controller.documents(`/v1/documentos/sales_orders/${doc}/status`, { method: "POST", body: { status: "x" } }), isStatus(409));
    refuse = false;
    await s.controller.documents(situations);
    assert.equal(s.reads(situations), 4);
    // Um GET em voo durante a escrita não guarda a resposta anterior à escrita.
    await s.controller.documents(`/v1/documentos/sales_orders/${doc}/status`, { method: "POST", body: { status: "approved" } });
    gate = {};
    const inFlight = s.controller.documents(situations); await settle();
    await s.controller.documents(`/v1/documentos/sales_orders/${doc}/status`, { method: "POST", body: { status: "approved" } });
    gate.resolve(Response.json({ old: true })); gate = null;
    assert.deepEqual(await inFlight, { old: true });
    await s.controller.documents(situations);
    assert.equal(s.reads(situations), 6);
    assert.equal(writeScope(`/v1/documentos/sales_orders/${doc}`), "/v1/documentos");
    assert.equal(writeScope("/v1/frente-caixa/actions/sale_finish"), "/v1/frente-caixa");
    assert.equal(writeScope("/v1/frente-caixa/actions/settings_save"), null);
    assert.equal(writeScope("/v1/sistema/situacoes"), null);
  } finally { s.stop(); }
});

test("invalidação 2: logout, 401 e parada do controlador esvaziam o cache", async () => {
  const s = harness({ handler: (path) => path === "/v1/estoque/expirado" ? Response.json({}, { status: 401 }) : undefined });
  await s.start();
  const path = "/v1/preferencias/empresa-geral";
  try {
    await s.controller.preferences(path); await s.controller.preferences(path);
    assert.equal(s.reads(path), 1);
    await s.controller.logout();
    await s.signIn("synthetic-token-2");
    await s.controller.preferences(path);
    assert.equal(s.reads(path), 2);
    // 401 de qualquer chamada encerra a sessão (denyAccess) e o cache.
    await assert.rejects(s.controller.stock("/v1/estoque/expirado"), isStatus(401));
    assert.equal(s.controller.getSnapshot().phase, "signed_out");
    await s.signIn("synthetic-token-3");
    await s.controller.preferences(path);
    assert.equal(s.reads(path), 3);
    // Parar e iniciar de novo o controlador (desmontar a área) também.
    s.stop(); await s.start();
    await s.controller.preferences(path);
    assert.equal(s.reads(path), 4);
  } finally { s.stop(); }
});

test("invalidação 3: troca de papel pelo /v1/me esvazia o cache; sem troca, o cache fica", async () => {
  const s = harness(); await s.start();
  const profile = "/v1/sistema/perfil", prefs = "/v1/preferencias/empresa-geral";
  try {
    await s.controller.system(profile); await s.controller.preferences(prefs);
    s.controller.retry(); await settle(); // o mesmo papel: nada muda
    await s.controller.system(profile); await s.controller.preferences(prefs);
    assert.deepEqual([s.reads(profile), s.reads(prefs)], [1, 1]);
    s.role = "vendas"; s.controller.retry(); await settle();
    assert.equal(s.controller.getSnapshot().membership.role, "vendas");
    await s.controller.system(profile); await s.controller.preferences(prefs);
    assert.deepEqual([s.reads(profile), s.reads(prefs)], [2, 2]);
  } finally { s.stop(); }
});

test("invalidação 4: troca de área (outro apiUrl) não compartilha o cache", async () => {
  const calls = [];
  const a = harness({ apiUrl: "https://area-a.cache.test", handler: (path) => { calls.push("a" + path); } });
  const b = harness({ apiUrl: "https://area-b.cache.test", handler: (path) => { calls.push("b" + path); } });
  await a.start(); await b.start();
  const path = "/v1/cadastros/tipos-contato";
  try {
    await a.controller.catalog(path); await b.controller.catalog(path); await a.controller.catalog(path); await b.controller.catalog(path);
    assert.deepEqual(calls, ["a" + path, "b" + path]);
    // A área A é desmontada e montada de novo (outro controlador ou o mesmo reiniciado): lê de novo.
    a.stop(); await a.start();
    await a.controller.catalog(path);
    assert.deepEqual(calls, ["a" + path, "b" + path, "a" + path]);
  } finally { a.stop(); b.stop(); }
});

test("invalidação 5: qualquer 401/403 descarta os envelopes de permissão (as configurações ficam)", async () => {
  const s = harness({ handler: (path) => path === "/v1/estoque/bloqueado" ? Response.json({}, { status: 403 }) : undefined });
  await s.start();
  const envelopes = ["/v1/cadastros", "/v1/documentos", "/v1/financeiro"], situations = "/v1/documentos/sales_orders/situacoes";
  const read = (path) => path === "/v1/cadastros" ? s.controller.catalog(path) : path === "/v1/financeiro" ? s.controller.finance(path) : s.controller.documents(path);
  try {
    for (const path of [...envelopes, situations]) { await read(path); await read(path); }
    assert.deepEqual([...envelopes, situations].map(s.reads), [1, 1, 1, 1]);
    await assert.rejects(s.controller.stock("/v1/estoque/bloqueado"), isStatus(403));
    await settle(); // a revalidação do /v1/me confirma o mesmo papel
    assert.equal(s.controller.getSnapshot().phase, "ready");
    for (const path of [...envelopes, situations]) await read(path);
    assert.deepEqual([...envelopes, situations].map(s.reads), [2, 2, 2, 1]);
  } finally { s.stop(); }
});

test("TTL: 5 minutos para as configurações estáveis e 30 s para as permissões", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const s = harness();
  try {
    await s.start();
    const prefs = "/v1/preferencias/empresa-geral", envelope = "/v1/cadastros";
    await s.controller.preferences(prefs); await s.controller.catalog(envelope);
    mock.timers.tick(PERMISSIONS_TTL_MS - 1);
    await s.controller.preferences(prefs); await s.controller.catalog(envelope);
    assert.deepEqual([s.reads(prefs), s.reads(envelope)], [1, 1]);
    mock.timers.tick(2);
    await s.controller.preferences(prefs); await s.controller.catalog(envelope);
    assert.deepEqual([s.reads(prefs), s.reads(envelope)], [1, 2]);
    mock.timers.tick(STABLE_TTL_MS - PERMISSIONS_TTL_MS - 2);
    await s.controller.preferences(prefs);
    assert.equal(s.reads(prefs), 1);
    mock.timers.tick(2);
    await s.controller.preferences(prefs);
    assert.equal(s.reads(prefs), 2);
  } finally { s.stop?.(); mock.timers.reset(); }
});

test("pedido em voo: leituras iguais compartilham um fetch; cancelar um chamador não cancela os outros; todos cancelando cancela o fetch", async () => {
  const gates = new Map();
  const s = harness({ handler: (path, options) => {
    if (!["/v1/cadastros/tipos-contato", "/v1/cadastros/taxonomias/tags", "/v1/sistema/armazenamento"].includes(path)) return undefined;
    const p = pending(options); gates.set(path, p.resolve); return p.promise;
  } });
  await s.start();
  try {
    const types = "/v1/cadastros/tipos-contato", first = new AbortController();
    const p1 = s.controller.catalog(types, { signal: first.signal }), p2 = s.controller.catalog(types);
    await settle();
    assert.equal(s.reads(types), 1);
    first.abort();
    await assert.rejects(p1, isAbort);
    assert.equal(s.calls.find((c) => c.path === types).signal.aborted, false);
    gates.get(types)(Response.json({ items: [{ id: 7 }] }));
    assert.deepEqual(await p2, { items: [{ id: 7 }] });
    assert.deepEqual(await s.controller.catalog(types), { items: [{ id: 7 }] });
    assert.equal(s.reads(types), 1);

    const tags = "/v1/cadastros/taxonomias/tags", a = new AbortController(), b = new AbortController();
    const q1 = s.controller.catalog(tags, { signal: a.signal }), q2 = s.controller.catalog(tags, { signal: b.signal });
    await settle();
    a.abort(); b.abort();
    await assert.rejects(q1, isAbort); await assert.rejects(q2, isAbort);
    assert.equal(s.calls.find((c) => c.path === tags).signal.aborted, true);
    const q3 = s.controller.catalog(tags); await settle();
    assert.equal(s.reads(tags), 2); // nada ficou guardado do pedido cancelado
    gates.get(tags)(Response.json({ items: [] })); await q3;

    // Só em voo (armazenamento): compartilha quando é ao mesmo tempo, cada um com sua cópia; depois lê de novo.
    const storage = "/v1/sistema/armazenamento";
    const r1 = s.controller.system(storage), r2 = s.controller.system(storage);
    await settle();
    assert.equal(s.reads(storage), 1);
    gates.get(storage)(Response.json({ total_bytes: 10 }));
    const [v1, v2] = await Promise.all([r1, r2]);
    assert.deepEqual(v1, { total_bytes: 10 }); assert.notEqual(v1, v2);
    const r3 = s.controller.system(storage); await settle();
    assert.equal(s.reads(storage), 2);
    gates.get(storage)(Response.json({ total_bytes: 11 })); await r3;
  } finally { s.stop(); }
});
