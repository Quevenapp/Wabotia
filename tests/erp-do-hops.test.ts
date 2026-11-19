// Idas ao objeto erp: e consultas ao D1 por requisição da erp-api (pedido da
// orquestração, latência das telas: sessao-M-erp-latencia.md). Alvo: uma ida
// ao objeto por requisição, com o portão (horário, segundo fator) dentro dela.
// As idas vêm do cabeçalho Server-Timing da costura (src/erp/api/local-fetch.ts).
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts } from "./erp-module-helper";
import { measure } from "./d1-counter";
import { erpApi } from "../src/erp/api/local-fetch";

const hopsOf = (r: Response) => {
  const timing = r.headers.get("Server-Timing") ?? "";
  return {
    hops: Number(/erp;desc="hops=(\d+)"/.exec(timing)?.[1] ?? NaN),
    rpcs: [...timing.matchAll(/erp-rpc-\d+;desc="([^"]+)"/g)].map((m) => m[1]),
  };
};

describe("ERP: uma ida ao objeto por requisição", () => {
  it("leitura, /v1/me e escrita: idas ao objeto e consultas ao D1; portão na mesma ida", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    await enableErpParts(f.profile, f.admin.id);
    await erpFetch(env, f.profile, "/erp-ping");
    const t = String(BigInt(Date.now()) * 1000n);
    const ids = { product: crypto.randomUUID(), warehouse: crypto.randomUUID() };
    await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'admin', 1, ?, ?)`, f.admin.id, t, t);
      for (const [id, entity] of [[ids.product, "products"], [ids.warehouse, "warehouses"]])
        sql.exec(
          `INSERT INTO "erp_catalog__record"(id, entity, name, active, created_by, updated_by, created_at, updated_at) VALUES(?, ?, 'Registro', 1, ?, ?, ?, ?)`,
          id, entity, f.admin.id, f.admin.id, t, t,
        );
      sql.exec(`INSERT INTO "erp_catalog__product"(record_id, unit, kind, format) VALUES(?, 'UN', 'P', 'S')`, ids.product);
      sql.exec(`INSERT INTO "erp_catalog__warehouse"(record_id) VALUES(?)`, ids.warehouse);
    });
    const base = `https://test/api/v1/profiles/${f.profile}/erp`;
    const call = async (path: string, init: RequestInit = {}) => {
      const ctx = createExecutionContext();
      const { result, count } = await measure(env, async (e) => {
        const r = await worker.fetch(
          new Request(base + path, { ...init, headers: { Authorization: "Bearer " + token, ...(init.body ? { "Content-Type": "application/json" } : {}) } }),
          e as any,
          ctx,
        );
        await waitOnExecutionContext(ctx);
        return r;
      });
      return { status: result.status, body: await result.json<any>(), d1: count.calls, d1_sql: count.sql, ...hopsOf(result) };
    };

    const me = await call("/v1/me");
    const read = await call("/v1/plataforma/referencias/cnae?q=4744");
    const write = await call("/v1/estoque/movimentos", {
      method: "POST",
      body: JSON.stringify({
        command_id: uid(),
        kind: "receipt",
        occurred_on: "2026-10-15",
        reason: "Entrada",
        items: [{ product_id: ids.product, warehouse_id: ids.warehouse, quantity: "1", expected_version: 0 }],
      }),
    });
    console.log("ERP_HOPS " + JSON.stringify({ me, read, write }, (k, v) => (k === "body" ? undefined : v)));
    for (const r of [me, read, write]) {
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      expect(r.hops).toBe(1);
    }
    expect(me.rpcs).toEqual(["erp_access_me"]);

    // Política de MFA ligada: o administrador está no escopo e a sessão é aal1.
    // O portão recusa na mesma ida, antes do RPC (403 ERP_MFA_REQUIRED).
    await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      state.storage.sql.exec(
        `INSERT INTO "erp_access__security_policy"(singleton, mfa_required, version, updated_at, updated_by) VALUES(1, 1, 1, ?, ?)`,
        t,
        f.admin.id,
      );
    });
    const gated = await call("/v1/plataforma/referencias/cnae?q=4744");
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("ERP_MFA_REQUIRED");
    expect(gated.hops).toBe(1);
    const gatedMe = await call("/v1/me");
    expect(gatedMe.status).toBe(403);
    expect(gatedMe.body.error.code).toBe("ERP_MFA_REQUIRED");
    expect(gatedMe.hops).toBe(1);
    // Nada foi gravado pela escrita recusada.
    const blocked = await call("/v1/estoque/movimentos", {
      method: "POST",
      body: JSON.stringify({
        command_id: uid(),
        kind: "receipt",
        occurred_on: "2026-10-15",
        reason: "Entrada",
        items: [{ product_id: ids.product, warehouse_id: ids.warehouse, quantity: "1", expected_version: 1 }],
      }),
    });
    expect(blocked.status).toBe(403);
    const version = await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) =>
      state.storage.sql.exec(`SELECT version FROM "erp_stock__balance" WHERE product_id=?`, ids.product).toArray(),
    );
    expect(version).toEqual([{ version: 1 }]);

    // Envelope do núcleo (erpApi com identity): aal2 na sessão passa no /v1/me
    // (accessGate da erp-api lê session_id e aal do token) e numa leitura; aal1 não.
    const session = crypto.randomUUID();
    const envelope = (aal: "aal1" | "aal2") => ({
      actor: { user_id: f.admin.id, name: "Admin", email: null, erp_role: "admin" as const, verified_factor: true, session_id: session, aal, is_agent: false },
      people: [{ user_id: f.admin.id, name: "Admin", email: null, erp_role: "admin" as const, verified_factor: true }],
    });
    const viaEnvelope = async (path: string, aal: "aal1" | "aal2") => {
      const r = await erpApi(env, new Request(base + path, { headers: { Authorization: "Bearer " + token } }), f.profile, f.admin as any, envelope(aal));
      return { status: r.status, body: await r.json<any>() };
    };
    expect((await viaEnvelope("/v1/me", "aal1")).body.error?.code).toBe("ERP_MFA_REQUIRED");
    const me2 = await viaEnvelope("/v1/me", "aal2");
    expect(me2.status, JSON.stringify(me2.body)).toBe(200);
    expect((await viaEnvelope("/v1/plataforma/referencias/cnae?q=4744", "aal2")).status).toBe(200);
  }, 120_000);
});
