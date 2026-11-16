// Sondas da instalação de teste (src/erp/probe.ts) rodam no workerd local;
// sem ERP_PROBES=1 a rota do Worker não existe (404).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { setModule } from "./erp-module-helper";
import { bearer, fixture } from "./service-center-fixture";

const call = async (profile: string, name: string, body: Record<string, unknown> = {}) => {
  const r = await erpFetch(env, profile, `/erp-probe/${name}` as `/erp-${string}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return r.json<any>();
};

describe("sondas do ERP para a instalação de teste", () => {
  it("sem ERP_PROBES a rota responde 404, mesmo para administrador com o módulo ligado", async () => {
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    const r = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp-probe/limits`, {
      method: "POST",
      headers: { Authorization: "Bearer " + (await bearer(f.admin)), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(404);
  });

  it("setup, lançamento de 100 itens, carga, relatórios, limites, marcas e limpeza", async () => {
    const profile = "sonda-" + crypto.randomUUID();
    const user = crypto.randomUUID();
    expect(await call(profile, "setup", { user })).toMatchObject({ products: 100, warehouses: 10 });
    expect(await call(profile, "stock-post", { user, items: 100 })).toMatchObject({ items: 100, lines: 100 });
    expect((await call(profile, "load", { user, from: 1, count: 50 })).rows_written).toBeGreaterThanOrEqual(5000);
    expect(await call(profile, "report", { name: "saldo" })).toMatchObject({ report: "saldo" });
    const limits = await call(profile, "limits");
    // Limites do workerd local (a K compara com produção).
    expect(limits.params[100].ok).toBe(true);
    expect(limits.params[101].error).toMatch(/too many SQL variables/);
    expect(limits.plus_chain[1000].error).toMatch(/maximum depth 100/);
    expect(limits.like_pattern_bytes[51].error).toMatch(/too complex/);
    expect(limits.statement_bytes[100_000].error).toMatch(/too long/);
    console.log("ERP_LIMITS " + JSON.stringify(limits.statement_bytes));
    expect((await call(profile, "bookmark-mark", { label: "a" })).bookmark).toMatch(/./);
    expect((await call(profile, "bookmark-check")).marks).toHaveLength(1);
    expect(await call(profile, "wipe")).toEqual({ wiped: true });
    const left = await runInDurableObject(erpStub(env, profile), async (_i: any, state: DurableObjectState) => ({
      kind: await state.storage.get("kind"),
      tables: state.storage.sql.exec("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'").one().n,
    }));
    expect(left).toEqual({ kind: undefined, tables: 0 });
  }, 120_000);
});
