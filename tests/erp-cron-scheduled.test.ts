// O cron do Worker acorda o agendador do ERP (src/index.ts, scheduled →
// wakeErpAreas): renova a fotografia a cada cinco minutos e entrega desligamentos.
// As regras do wakeErpAreas em si estão em tests/erp-do-scheduler.test.ts;
// aqui é a ligação no scheduled de verdade.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { erpFetch, erpStub } from "../src/erp/hub";
import { fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { readErpPartsState } from "../src/modules/erp/parts-state";
import { ERP_PARTS_KEY } from "../src/erp/parts-control";
import type { ErpPartsSnapshot } from "../src/erp/parts";
import { exec } from "../src/db";
import { SCAN_TASK } from "../src/customer/sync";

const loads = vi.hoisted(() => ({ engine: 0 }));
vi.mock("../src/erp/hub-engine.ts", async original => {
  loads.engine++;
  return original<typeof import("../src/erp/hub-engine")>();
});
const inspect = (profile: string) =>
  runInDurableObject(erpStub(env, profile), async (_i: any, s: DurableObjectState) => ({
    snapshot: await s.storage.get<ErpPartsSnapshot>(ERP_PARTS_KEY),
    alarm: await s.storage.getAlarm(),
    schema: s.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'erp_%'").toArray(),
  }));

async function cron(at: number) {
  const ctx = createExecutionContext();
  await worker.scheduled!(
    { scheduledTime: at, cron: "*/5 * * * *", noRetry() {} } as any,
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

// scheduled também retoma o cadastro único. Uma varredura pendente chama o
// ERP legitimamente; este cenário mede a passagem que só renova autorização.
const reconciled = (profile: string, at: number) => exec(env,
  `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
   VALUES(?,'team',?,'{}',1,?) ON CONFLICT(profile_id,namespace,task)
   DO UPDATE SET complete=1,updated=excluded.updated`, profile, SCAN_TASK, at);

describe("cron do Worker e o agendador do ERP", () => {
  it(
    "renova a cada cinco minutos sem carregar o motor e entrega desligamento sem acordar a área desligada",
    { timeout: 120_000 },
    async () => {
      // Relógio adiantado mantém o runtime longe do alarme automático.
      const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 86_400_000 + 35 * 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      const on = await fixture(), off = await fixture();
      try {
        await setModule(on.profile, "erp", true, on.admin.id);
        await setModule(off.profile, "erp", false, off.admin.id);
        await reconciled(on.profile, start);
        expect((await inspect(on.profile)).snapshot).toBeUndefined();
        expect((await inspect(off.profile)).snapshot).toBeUndefined();
        await cron(start); // :35 também entrega, não só :00.
        const first = await inspect(on.profile), stopped = await inspect(off.profile);
        expect(first.snapshot?.parts.customers).toBe(true);
        expect(first.snapshot?.issued_at).toBe(start);
        expect(first.snapshot?.expires_at).toBe(start + 360_000);
        expect(first.alarm).toBe(start + 1_000);
        expect(stopped.snapshot?.parts.customers).toBe(false);
        expect(stopped.alarm).toBeNull();
        expect(first.schema).toEqual([]); expect(stopped.schema).toEqual([]);
        expect(loads.engine).toBe(0);
        expect((await readErpPartsState(env, on.profile)).erp_sync.status).toBe("applied");
        const planned = start + 3_600_000;
        await runInDurableObject(erpStub(env, on.profile), (_i: any, state) => state.storage.setAlarm(planned));

        clock.mockReturnValue(start + 300_000);
        await reconciled(on.profile, start + 300_000);
        await cron(start + 300_000);
        const renewed = await inspect(on.profile);
        expect(renewed.snapshot).toEqual({ ...first.snapshot, issued_at: start + 300_000, expires_at: start + 660_000 });
        expect(renewed.alarm).toBe(planned);
        expect(renewed.schema).toEqual([]);
        expect(await inspect(off.profile)).toEqual(stopped);
        expect(loads.engine).toBe(0);

        await setModule(on.profile, "erp", false, on.admin.id);
        expect((await readErpPartsState(env, on.profile)).erp_sync.status).toBe("pending");
        clock.mockReturnValue(start + 600_000);
        await cron(start + 600_000);
        const disabled = await inspect(on.profile);
        expect(disabled.snapshot?.parts.customers).toBe(false);
        expect(BigInt(disabled.snapshot!.revision)).toBeGreaterThan(BigInt(first.snapshot!.revision));
        expect(disabled.alarm).toBeNull(); expect(disabled.schema).toEqual([]);
        expect((await readErpPartsState(env, on.profile)).erp_sync.status).toBe("applied");
        expect(await inspect(off.profile)).toEqual(stopped);
        expect(loads.engine).toBe(0);
        // Controle positivo: a observação detecta a carga real quando pedida.
        // Só agora, depois das provas de zero carga, importa no contexto do
        // runner. importOriginal usa o RPC do Vitest, cujo I/O não pertence ao DO.
        await import("../src/erp/hub-engine.ts");
        expect(loads.engine).toBe(1);
        const probe = await fixture();
        expect((await erpFetch(env, probe.profile, "/erp-ping")).status).toBe(200);
        expect((await inspect(probe.profile)).schema.length).toBeGreaterThan(0);
        expect(loads.engine).toBe(1);
      } finally {
        clock.mockRestore();
        for (const f of [on, off])
          await runInDurableObject(erpStub(env, f.profile), (_i: any, state) => state.storage.deleteAlarm());
      }
    },
  );
});
