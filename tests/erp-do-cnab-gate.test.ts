// CNAB atrás do módulo erp-cobranca (pedido da orquestração, bloco C1): com o
// módulo desligado, nenhuma rota do CNAB chega ao objeto (409
// module_disabled); ligado, o RPC portado responde pelo objeto erp:<área>.
// O legado Itaú (Origin) é rota externa: 404 com o módulo ligado ou não.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { enableErpParts, setModule } from "./erp-module-helper";
import { bearer, fixture } from "./service-center-fixture";

const x = "00000000-0000-4000-8000-000000000001";
// Uma rota por prefixo do bloco (src/erp/blocks.ts), de leitura e de escrita.
const ROUTES: [string, string][] = [
  ["GET", "/v1/cnab"],
  ["GET", "/v1/cnab/profiles"],
  ["GET", `/v1/cnab/returns/${x}/review`],
  ["GET", "/v1/cobranca-operacional/profiles"],
  ["GET", "/v1/cobranca-operacional-v2/profiles"],
  ["GET", "/v1/retornos-operacionais/files"],
  ["GET", `/v1/retornos-operacionais/settlements/${x}`],
  ["GET", `/v1/conferencia-retornos/files/${x}`],
  ["GET", `/v1/boletos-itau/${x}/preview`],
  ["GET", `/v1/retornos-itau109/commands/${x}`],
  ["GET", "/v1/financeiro/remessa-candidatos"],
  ["GET", "/v1/financeiro/remessas"],
  ["GET", "/v1/financeiro/retornos"],
  ["POST", "/v1/financeiro/actions/remittance_exclude"],
  ["POST", "/v1/financeiro/actions/return_exclude"],
];

describe("CNAB atrás do módulo erp-cobranca", () => {
  it("desligado: 409 em toda rota do CNAB; ligado: o RPC portado responde; legado Itaú: 404", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const call = (method: string, path: string) =>
      SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp${path}`, {
        method,
        headers: { Authorization: "Bearer " + token, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify({ command_id: x, data: { id: x } }) : undefined,
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
    const legacy = await call("GET", "/v1/cobrancas-legadas-itau");
    expect(legacy.status).toBe(404);
    expect((await legacy.json<any>()).error.code).toBe("erp_route_removed");

    await setModule(f.profile, "erp-cobranca", true, f.admin.id);
    for (const [method, path] of ROUTES) expect((await call(method, path)).status, `${method} ${path}`).not.toBe(409);
    const access = await call("GET", "/v1/cnab");
    const body = await access.json<any>();
    expect(access.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ configure: true, productionReady: false, financialMutationPerformed: false });
    const profiles = await call("GET", "/v1/cobranca-operacional-v2/profiles");
    expect(profiles.status).toBe(200);
    expect((await profiles.json<any>()).items).toEqual([]);
    expect((await call("GET", "/v1/cobrancas-legadas-itau")).status).toBe(404);

    // Desligado de novo: 409 outra vez, antes do objeto.
    await setModule(f.profile, "erp-cobranca", false, f.admin.id);
    expect((await call("GET", "/v1/cnab")).status).toBe(409);
  }, 120_000);
});
