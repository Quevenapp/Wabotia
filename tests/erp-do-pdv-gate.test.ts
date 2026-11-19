// PDV atrás do módulo erp-pdv (pedido da orquestração, P1): com o módulo
// desligado, nenhuma rota da frente de caixa chega ao objeto (409
// module_disabled); ligado, o RPC portado responde pelo objeto erp:<área>.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { enableErpParts, setModule } from "./erp-module-helper";
import { bearer, fixture } from "./service-center-fixture";

const x = "00000000-0000-4000-8000-000000000001";
// Uma rota por RPC do PDV (src/erp/blocks.ts, prefixos /v1/frente-caixa e /v1/preferencias/vendas-frente-caixa).
const ROUTES: [string, string][] = [
  ["GET", "/v1/frente-caixa"],
  ["GET", "/v1/frente-caixa/vendas"],
  ["GET", "/v1/frente-caixa/favoritos"],
  ["GET", `/v1/frente-caixa/vendas/${x}`],
  ["GET", `/v1/frente-caixa/pedidos/${x}`],
  ["GET", `/v1/frente-caixa/caixas/${x}/resumo`],
  ["POST", "/v1/frente-caixa/actions/settings_save"],
  ["POST", "/v1/frente-caixa/actions/favorite_add"],
  ["POST", "/v1/frente-caixa/actions/favorite_remove"],
  ["POST", "/v1/frente-caixa/actions/sale_finish"],
  ["POST", "/v1/frente-caixa/actions/sale_return"],
  ["GET", "/v1/preferencias/vendas-frente-caixa"],
];

describe("PDV atrás do módulo erp-pdv", () => {
  it("desligado: 409 em toda rota da frente de caixa; ligado: o contexto responde pelo motor", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const call = (method: string, path: string) =>
      SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp${path}`, {
        method,
        headers: { Authorization: "Bearer " + token, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify({ command_id: x, data: { product_id: x } }) : undefined,
      });
    await enableErpParts(f.profile, f.admin.id);
    await erpFetch(env, f.profile, "/erp-ping");
    const t = String(BigInt(Date.now()) * 1000n);
    await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      state.storage.sql.exec(`INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'admin', 1, ?, ?)`, f.admin.id, t, t);
    });

    for (const [method, path] of ROUTES) {
      const r = await call(method, path);
      expect(r.status, `${method} ${path}`).toBe(409);
      expect((await r.json<any>()).error.code, path).toBe("module_disabled");
    }

    await setModule(f.profile, "erp-pdv", true, f.admin.id);
    for (const [method, path] of ROUTES) expect((await call(method, path)).status, `${method} ${path}`).not.toBe(409);
    const context = await call("GET", "/v1/frente-caixa");
    const body = await context.json<any>();
    expect(context.status, JSON.stringify(body)).toBe(200);
    // Certificado no cofre da NFapi: o motor não o lê (schema/structural.ts, "certificado-a1-cofre").
    expect(body).toMatchObject({ role: "admin", certificate: "missing" });

    // Desligado de novo: 409 outra vez, antes do objeto.
    await setModule(f.profile, "erp-pdv", false, f.admin.id);
    expect((await call("GET", "/v1/frente-caixa")).status).toBe(409);
  }, 120_000);
});
