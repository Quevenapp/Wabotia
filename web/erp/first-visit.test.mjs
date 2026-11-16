// Primeira visita do ERP (latência, 9.6): o GET /v1/me antecipado pela casca
// (ErpArea) é entregue ao primeiro GET /v1/me do controlador, uma vez só, do
// mesmo ator e dentro da janela; falhou, vai para a rede normalmente.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.location ??= new URL("https://painel.test/app/erp/acesso");
const { createFetchPort, erpApiUrl, prefetchErpMe, ME_PREFETCH_WINDOW_MS } =
  await import("./fetch-port.ts");

const actor = "a0000000-0000-4000-8000-000000000001";
const apiUrl = erpApiUrl("area-1");
const me = `${apiUrl}/v1/me`;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function recorder(answer = () => json({ source: "rede" })) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url), calls.length);
  };
  return { calls, impl };
}

test("o /v1/me antecipado é entregue ao primeiro GET /v1/me, uma vez só", async () => {
  const early = recorder(() => json({ source: "antecipado" }));
  prefetchErpMe(apiUrl, actor, early.impl);
  prefetchErpMe(apiUrl, actor, early.impl); // StrictMode: o segundo não repete
  assert.equal(early.calls.length, 1);
  assert.equal(early.calls[0].url, me);
  assert.equal(early.calls[0].init.method, "GET");
  assert.equal(early.calls[0].init.credentials, "same-origin");

  const network = recorder();
  const port = createFetchPort({ apiUrl, actor, fetchImpl: network.impl });
  const first = await port(me, {
    method: "GET",
    headers: { Authorization: "Bearer x" },
  });
  assert.deepEqual(await first.json(), { source: "antecipado" });
  assert.equal(network.calls.length, 0, "o primeiro não foi à rede");

  const second = await port(me, { method: "GET" });
  assert.deepEqual(await second.json(), { source: "rede" });
  assert.equal(network.calls.length, 1, "o segundo vai à rede");
});

test("outro ator, outro caminho, fora da janela ou falha: vai para a rede", async () => {
  const other = "a0000000-0000-4000-8000-000000000002";
  const network = recorder();

  prefetchErpMe(apiUrl, other, recorder().impl);
  const port = createFetchPort({ apiUrl, actor, fetchImpl: network.impl });
  await port(me, { method: "GET" });
  assert.equal(network.calls.length, 1, "ator diferente");
  await port(me, { method: "GET" });
  assert.equal(
    network.calls.length,
    2,
    "descartado depois da primeira tentativa",
  );

  prefetchErpMe(apiUrl, actor, recorder().impl);
  await port(`${apiUrl}/v1/financeiro`, { method: "GET" });
  assert.equal(network.calls.length, 3);
  const kept = await port(me, { method: "GET" });
  assert.equal(
    network.calls.length,
    3,
    "outro caminho não consome o antecipado",
  );
  assert.equal(kept.status, 200);

  const realNow = Date.now;
  try {
    prefetchErpMe(apiUrl, actor, recorder().impl);
    Date.now = () => realNow() + ME_PREFETCH_WINDOW_MS + 1;
    await port(me, { method: "GET" });
    assert.equal(network.calls.length, 4, "fora da janela");
  } finally {
    Date.now = realNow;
  }

  prefetchErpMe(apiUrl, actor, async () => {
    throw new TypeError("Failed to fetch");
  });
  const recovered = await port(me, { method: "GET" });
  assert.deepEqual(await recovered.json(), { source: "rede" });
  assert.equal(network.calls.length, 5, "falha de rede");

  prefetchErpMe(apiUrl, actor, async () => json({ code: "x" }, 503));
  await port(me, { method: "GET" });
  assert.equal(network.calls.length, 6, "resposta de erro");
});

test("a API simulada nunca recebe o antecipado; um cancelamento é respeitado", async () => {
  prefetchErpMe(
    apiUrl,
    actor,
    recorder(() => json({ source: "antecipado" })).impl,
  );
  const simulated = createFetchPort({
    apiUrl,
    actor,
    simulate: async () => json({ source: "simulado" }),
    fetchImpl: recorder().impl,
  });
  assert.deepEqual(await (await simulated(me, { method: "GET" })).json(), {
    source: "simulado",
  });
  // Ficou para quem vai à rede (e é consumido aqui).
  const real = createFetchPort({ apiUrl, actor, fetchImpl: recorder().impl });
  assert.deepEqual(await (await real(me, { method: "GET" })).json(), {
    source: "antecipado",
  });

  let answer;
  prefetchErpMe(
    apiUrl,
    actor,
    () => new Promise((resolve) => (answer = resolve)),
  );
  const network = recorder();
  const port = createFetchPort({ apiUrl, actor, fetchImpl: network.impl });
  const abort = new AbortController();
  const pending = port(me, { method: "GET", signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  answer(json({ source: "antecipado" }));
  assert.equal(network.calls.length, 0);
});
