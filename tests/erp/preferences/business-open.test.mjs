import assert from "node:assert/strict";
import { test } from "node:test";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { parsePreferencesRoute, executePreferencesRoute } from "../../../src/erp/fagoo/workers/erp-api/src/preferences.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const MONTHLY = "/v1/meu-negocio/mensal?de=2026-11-01&ate=2026-11-19&comparar_de=2026-10-01&comparar_ate=2026-10-19&situacoes=verified,in_progress,fulfilled";

async function routed(driver, clock, path, { userId = ADMIN, body, environment = {} } = {}) {
  const request = new Request("https://erp.test" + path, { method: body ? "POST" : "GET",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return executePreferencesRoute(await parsePreferencesRoute(request), { userId, rpc: (name, args) => callRpc(driver, name, args, clock, environment) });
}

test("Meu negócio: instalação nova atende todas as leituras da abertura pelo adaptador real", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-19T15:00:00Z") });
  const lite = freshLite(), baseDriver = nodeDriver(lite), clock = new Clock(), statements = [];
  const driver = { ...baseDriver, exec(sql, ...args) { statements.push({ sql, args }); return baseDriver.exec(sql, ...args); } };
  try {
    driver.exec('INSERT INTO "erp_access__membership" (user_id,role,active,created_at,updated_at) VALUES (?,\'admin\',1,0,0)', ADMIN);
    const calls = [];
    const handler = createHandler({ fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN, app_metadata: {} });
      assert.ok(url.pathname.startsWith("/rest/v1/rpc/"));
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      calls.push(name);
      return Response.json(callRpc(driver, name, JSON.parse(init.body), clock));
    } });
    const env = { SUPABASE_URL: "https://erp.wabotia.invalid", SUPABASE_DEPLOYMENT: "self-hosted", SUPABASE_SERVICE_ROLE_KEY: "test" };
    const counts = [];
    for (const path of ["/v1/preferencias/meu-negocio", "/v1/sistema/permissoes", MONTHLY]) {
      statements.length = 0;
      const response = await handler(new Request("https://erp.test" + path, { headers: { Authorization: "Bearer human" } }), env, {});
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.data_mode, "erp_native", path);
      if (path === MONTHLY) assert.equal(result.panel, "mensal");
      counts.push([path.split("?")[0], statements.filter(s => /^\s*(SELECT|WITH)\b/i.test(s.sql)).length]);
      for (const statement of statements.filter(s => s.sql.includes("FROM \"erp_documents__document\" d WHERE"))) {
        assert.match(statement.sql, /BETWEEN \? AND \?/);
        const plan = lite.prepare("EXPLAIN QUERY PLAN " + statement.sql).all(...statement.args);
        assert.ok(plan.some(row => /SEARCH d USING INDEX erp_documents__erp_documents_kind_date_(id|number).*<expr>/.test(row.detail)), JSON.stringify(plan));
      }
    }
    assert.deepEqual(calls, ["erp_preferences_page", "erp_access_permissions_me", "erp_home_business_panel"]);
    t.diagnostic("Abertura (banco novo, sem portão do Worker): " + JSON.stringify(counts));
  } finally { lite.close(); }
});

test("Meu negócio: alterna painéis/períodos, salva e confere metas sem contornar papéis e partes", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-19T15:00:00Z") });
  const lite = freshLite(), driver = nodeDriver(lite), clock = new Clock();
  try {
    driver.exec('INSERT INTO "erp_access__membership" (user_id,role,active,created_at,updated_at) VALUES (?,\'admin\',1,0,0)', ADMIN);
    const panels = ["mensal", "pedidos-venda", "vendas-vendedor", "margem-pedido", "novos-recorrentes", "curva-abc"];
    for (const panel of panels) for (const month of ["10", "11"]) {
      const data = await routed(driver, clock, `/v1/meu-negocio/${panel}?de=2026-${month}-01&ate=2026-${month}-19&situacoes=verified,in_progress,fulfilled`);
      assert.equal(data.panel, panel);
      assert.equal(data.filters.from, `2026-${month}-01`);
    }
    const input = { command_id: crypto.randomUUID(), goal_id: null, expected_version: 0,
      data: { name: "Meta comercial", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "1000.00", active: true } };
    const saved = await routed(driver, clock, "/v1/meu-negocio/metas", { body: input });
    assert.equal(saved.goal.version, 1);
    assert.equal(saved.goal.target, "1000.00");
    assert.equal((await routed(driver, clock, "/v1/meu-negocio/metas")).items[0].id, saved.goal.id);
    assert.equal((await routed(driver, clock, "/v1/meu-negocio/metas/comandos/" + input.command_id)).replayed, true);
    assert.equal((await routed(driver, clock, "/v1/meu-negocio/metas", { body: input })).replayed, true);
    assert.equal(driver.exec('SELECT count(*) n FROM "erp_home__goal_audit"').rows[0].n, 1);
    await assert.rejects(() => routed(driver, clock, MONTHLY, { userId: "00000000-0000-4000-8000-000000000002" }), e => e.status === 403);
    await assert.rejects(() => routed(driver, clock, MONTHLY, { environment: { parts: { sales: false } } }), e => e.code === "module_disabled");
    await assert.rejects(() => routed(driver, clock, "/v1/meu-negocio/metas", { body: input, environment: { parts: { sales: false } } }), e => e.code === "module_disabled");
  } finally { lite.close(); }
});
