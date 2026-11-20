// Revisão de acesso, achado B2: a costura da erp-api (local-fetch.ts) marca
// toda chamada como interna (SYSTEM_HEADER). Um nome de RPC só do sistema não
// pode chegar ao objeto a partir de uma requisição de pessoa ou de aplicação.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { normalizeErpParts, ERP_PARTS_TTL_MS } from "../../../src/erp/parts.ts";
import { SYSTEM_RPCS, COM1_INTERNAL_RPCS } from "../../../src/erp/engine/system-rpcs.ts";

// Só o inventário é real; os demais imports da costura viram peças inertes
// (o caminho recusado não pode precisar delas: nenhuma é chamada).
const source = readFileSync("src/erp/api/local-fetch.ts", "utf8");
const imported = new Map();
for (const [, list, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g))
  imported.set(from, [...(imported.get(from) ?? []), ...list.split(",").map(s => s.trim()).filter(s => s && !s.startsWith("type "))
    .map(s => s.split(/\s+as\s+/)[0].trim())]);
const built = await build({ entryPoints: ["src/erp/api/local-fetch.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [{ name: "costura-isolada", setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.importer.endsWith("local-fetch.ts") && !/system-rpcs\.ts$/.test(args.path)
      ? { path: args.path, namespace: "inerte" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "inerte" }, args => ({ loader: "js", contents: [...new Set(imported.get(args.path) ?? [])]
      .map(name => /^[A-Z0-9_]+$/.test(name) ? `export const ${name} = "x-inerte-${name.toLowerCase()}";` : `export function ${name}() {}`).join("\n") }));
  } }] });
const seam = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const profile = "area-costura";
const actor = { id: "b7200000-0000-4000-8000-000000000001", kind: "user", name: "Pessoa", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 0, runLimit: 0, sessionId: "s1" };
const identity = () => ({
  actor: { user_id: actor.id, name: "Pessoa", email: null, erp_role: "admin", session_id: "s1", aal: "aal2", verified_factor: true, is_agent: false },
  people: [], parts: normalizeErpParts(), partsControl: { profile, revision: "1", expires_at: Date.now() + ERP_PARTS_TTL_MS },
});

test("B2: nomes só do sistema são recusados na costura, sem ir ao objeto nem ao D1", async () => {
  const touched = [];
  // Qualquer acesso ao ambiente (D1, objeto, R2) denunciaria que a chamada passou.
  const env = new Proxy({}, { get(_target, key) { touched.push(String(key)); throw new Error(`acesso inesperado: ${String(key)}`); } });
  assert.ok(SYSTEM_RPCS.size >= 11 && COM1_INTERNAL_RPCS.size >= 5);
  for (const name of [...SYSTEM_RPCS, ...COM1_INTERNAL_RPCS]) {
    const call = seam.localFetch(env, profile, actor, identity());
    const response = await call(`https://erp.wabotia.invalid/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify({ p_lease: "x" }) });
    assert.equal(response.status, 403, name);
    assert.deepEqual(await response.json(), { code: "42501", message: "erp_rpc_system_only" }, name);
  }
  assert.deepEqual(touched, []);
});

test("B4 (segunda revisão): as erp_sync_* do service_role não passam da costura a partir de pessoa", async () => {
  const env = new Proxy({}, { get(_target, key) { throw new Error(`acesso inesperado: ${String(key)}`); } });
  const serviceOnly = ["erp_sync_ack", "erp_sync_census_add", "erp_sync_census_diff", "erp_sync_claim", "erp_sync_indicator_observe",
    "erp_sync_pull", "erp_sync_remote_deleted", "erp_sync_run_get", "erp_sync_run_update", "erp_sync_stage"];
  for (const name of serviceOnly) {
    assert.ok(SYSTEM_RPCS.has(name), name);
    const response = await seam.localFetch(env, profile, actor, identity())(`https://erp.wabotia.invalid/rest/v1/rpc/${name}`, { method: "POST", body: "{}" });
    assert.equal(response.status, 403, name);
    assert.deepEqual(await response.json(), { code: "42501", message: "erp_rpc_system_only" }, name);
  }
  // As da pessoa (com p_user_id) continuam fora do inventário do sistema.
  for (const name of ["erp_sync_request", "erp_sync_status", "erp_sync_browser", "erp_sync_request_without_browser"]) assert.ok(!SYSTEM_RPCS.has(name), name);
});

test("B2: a rota /erp-rpc e a costura usam o mesmo inventário", () => {
  const endpoint = readFileSync("src/erp/engine/rpc-endpoint.ts", "utf8");
  assert.match(endpoint, /import \{ SYSTEM_RPCS, COM1_INTERNAL_RPCS \} from "\.\/system-rpcs\.ts";/);
  assert.doesNotMatch(endpoint, /new Set\(\[\s*"erp_platform_schedule"/);
  assert.match(source, /import \{ SYSTEM_RPCS, COM1_INTERNAL_RPCS \} from "\.\.\/engine\/system-rpcs\.ts";/);
});
