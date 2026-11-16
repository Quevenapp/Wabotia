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
});
