// ERP como módulo da área (PLANO-FAGOO.md, item 16): desligado de fábrica,
// instância erp:<área> e esquema criados só no primeiro uso com o módulo
// ligado, cron sem acordar o ERP, opcionais com 409 próprio.
import {
  createExecutionContext,
  env,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { erpStub } from "../src/erp/hub";
import { ERP_DDL_VERSION } from "../src/erp/schema/ddl";
import { setModule } from "./erp-module-helper";
import { bearer, fixture } from "./service-center-fixture";

const erpExists = async (profile: string) => {
  const id = env.COORDINATOR.idFromName("erp:" + profile).toString();
  return (await listDurableObjectIds(env.COORDINATOR)).some((x) => x.toString() === id);
};

describe("ERP como módulo da área", () => {
  it("desligado de fábrica: 409, nenhuma instância erp:, cron e alarme da área não a criam", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const res = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp/v1/plataforma/referencias/cnae?q=4744`, {
      headers: { Authorization: "Bearer " + token },
    });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe("module_disabled");
    // Cron do Worker (acorda as áreas) e alarme da área: nada do ERP.
    const ctx = createExecutionContext();
    await worker.scheduled!({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as any, env, ctx);
    await waitOnExecutionContext(ctx);
    await runDurableObjectAlarm(env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile)));
    expect(await erpExists(f.profile)).toBe(false);
  });

  it("primeiro uso com o módulo ligado cria a instância e o esquema; desligar recusa e guarda os dados", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const get = (path: string) =>
      SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp${path}`, { headers: { Authorization: "Bearer " + token } });
    await setModule(f.profile, "erp", true, f.admin.id);
    expect(await erpExists(f.profile)).toBe(false);
    // Sem vínculo erp_access a erp-api recusa (403), mas a instância e o esquema já nascem.
    const first = await get("/v1/plataforma/referencias/cnae?q=4744");
    expect(first.status).not.toBe(409);
    expect(await erpExists(f.profile)).toBe(true);
    const meta = await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) =>
      state.storage.sql.exec("SELECT value FROM erp_meta WHERE key='schema_version'").toArray(),
    );
    expect(Number((meta[0] as any).value)).toBe(ERP_DDL_VERSION);
    // Desligado de novo: 409 antes do objeto; os dados ficam.
    await setModule(f.profile, "erp", false, f.admin.id);
    expect((await get("/v1/plataforma/referencias/cnae?q=4744")).status).toBe(409);
    expect(await erpExists(f.profile)).toBe(true);
  }, 120_000);

  it("opcional desligado responde 409 antes do objeto; rota do Origin responde 404", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const get = (path: string) =>
      SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp${path}`, { headers: { Authorization: "Bearer " + token } });
    await setModule(f.profile, "erp", true, f.admin.id);
    for (const [path, module] of [
      ["/v1/notas-fiscais", "erp-fiscal"],
      ["/v1/estoque/checkin", "erp-fiscal"],
      ["/v1/financeiro/remessas", "erp-cobranca"],
      ["/v1/frente-caixa/contexto", "erp-pdv"],
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(409);
      expect((await r.json<any>()).error.code).toBe("module_disabled");
      // O opcional ligado passa do portão (a resposta vem da erp-api).
      await setModule(f.profile, module, true, f.admin.id);
      expect((await get(path)).status, path).not.toBe(409);
      await setModule(f.profile, module, false, f.admin.id);
    }
    const origin = await get("/v1/preparacao-virada");
    expect(origin.status).toBe(404);
    expect((await origin.json<any>()).error.code).toBe("erp_route_removed");
    // Opcional ligado com o erp desligado conta como desligado (requires).
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    await setModule(f.profile, "erp", false, f.admin.id);
    expect((await get("/v1/notas-fiscais")).status).toBe(409);
  }, 120_000);
});
