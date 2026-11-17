// O cron do Worker acorda o agendador do ERP (src/index.ts, scheduled →
// wakeErpAreas): no primeiro disparo da hora, só as áreas com o ERP ligado.
// As regras do wakeErpAreas em si estão em tests/erp-do-scheduler.test.ts;
// aqui é a ligação no scheduled de verdade.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { erpFetch, erpStub } from "../src/erp/hub";
import { fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const blocksOf = (profile: string) =>
  runInDurableObject(erpStub(env, profile), (_i: any, s: DurableObjectState) =>
    s.storage.get("erp_blocks"),
  );

async function cron(at: string) {
  const ctx = createExecutionContext();
  await worker.scheduled!(
    { scheduledTime: Date.parse(at), cron: "*/5 * * * *", noRetry() {} } as any,
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

describe("cron do Worker e o agendador do ERP", () => {
  it(
    "acorda só no primeiro disparo da hora e só áreas com o ERP ligado",
    { timeout: 120_000 },
    async () => {
      const on = await fixture();
      const off = await fixture();
      await setModule(on.profile, "erp", true, on.admin.id);
      // Os dois objetos existem (sem blocos gravados ainda).
      await erpFetch(env, on.profile, "/erp-ping");
      await erpFetch(env, off.profile, "/erp-ping");
      expect(await blocksOf(on.profile)).toBeUndefined();

      // Fora do primeiro disparo da hora: nada acorda.
      await cron("2026-11-17T15:35:00Z");
      expect(await blocksOf(on.profile)).toBeUndefined();

      // Primeiro disparo da hora: a área ligada recebe o wake (com os
      // blocos); a desligada, não.
      await cron("2026-11-17T16:00:00Z");
      expect(await blocksOf(on.profile)).toBeTruthy();
      expect(await blocksOf(off.profile)).toBeUndefined();
    },
  );
});
