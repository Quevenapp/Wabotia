// Fase 0 do ERP, prova 2: a instância "erp:<área>" da classe Coordinator
// convive com a da área. O alarme do ERP não roda o pipeline do WhatsApp nem
// toca o D1; a área continua igual.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { erpFetch, erpStub, ERP_PROFILE_HEADER } from "../src/erp/hub";
import { countingEnv } from "./d1-counter";
import { drain, fixture, receive } from "./service-center-fixture";

describe("ERP fase 0: instância erp: ao lado da área", () => {
  it("alarme do ERP não toca outbox/inbox nem consulta o D1; a área segue igual", async () => {
    const f = await fixture();
    // Mensagem pendente da área: se o pipeline rodasse, seria processada.
    const c = await receive(f, f.line, "oi", "5511964000001");
    const pending = await one(
      env,
      "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='pending'",
      f.profile,
    );
    expect(pending!.n).toBeGreaterThan(0);
    const outboxBefore = await all(env, "SELECT id,status FROM outbox WHERE profile_id=?", f.profile);

    const ping = await (await erpFetch(env, f.profile, "/erp-ping")).json<any>();
    expect(ping).toMatchObject({ kind: "erp", profile: f.profile });
    expect((await erpFetch(env, f.profile, "/erp-wake", { method: "POST" })).status).toBe(200);

    const stub = erpStub(env, f.profile);
    // O alarme roda com o D1 contado: nenhuma instrução.
    const counted = await runInDurableObject(stub, async (instance: any, state) => {
      const original = instance.env;
      const { env: wrapped, count } = countingEnv(original);
      instance.env = wrapped;
      (instance as any).erp.env = wrapped;
      try {
        await instance.alarm();
      } finally {
        instance.env = original;
        (instance as any).erp.env = original;
      }
      return {
        count,
        profileKey: await state.storage.get("profile"),
        kind: await state.storage.get("kind"),
        bound: await state.storage.get("erp_profile"),
        lastAlarm: state.storage.sql
          .exec("SELECT value FROM erp_meta WHERE key='last_alarm'")
          .toArray()[0]?.value,
      };
    });
    expect(counted.count.statements).toBe(0);
    expect(counted.profileKey).toBeUndefined();
    expect(counted.kind).toBe("erp");
    expect(counted.bound).toBe(f.profile);
    expect(Number(counted.lastAlarm)).toBeGreaterThan(0);
    // O alarme agendado pelo /erp-wake também roda pelo caminho do runtime.
    await erpFetch(env, f.profile, "/erp-wake", { method: "POST" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Nada mudou no D1 da área.
    expect(
      (await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='pending'", f.profile))!.n,
    ).toBe(pending!.n);
    expect(await all(env, "SELECT id,status FROM outbox WHERE profile_id=?", f.profile)).toEqual(
      outboxBefore,
    );

    // A área processa como sempre.
    await drain(f);
    expect(
      (await one(env, "SELECT count(*) n FROM inbox WHERE profile_id=? AND status='pending'", f.profile))!.n,
    ).toBe(0);
    expect((await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id)).length).toBeGreaterThan(0);
    const area = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const areaKeys = await runInDurableObject(area, async (_i: any, state) => ({
      kind: await state.storage.get("kind"),
      tables: state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='erp_meta'")
        .toArray().length,
    }));
    expect(areaKeys).toEqual({ kind: undefined, tables: 0 });
  });

  it("recusa outra área, instância de área e rotas da área na instância do ERP", async () => {
    const f = await fixture();
    const other = await fixture();
    await erpFetch(env, f.profile, "/erp-ping");
    // A instância do ERP de f recebe o cabeçalho de outra área.
    const mismatch = await erpStub(env, f.profile).fetch("https://coordinator/erp-ping", {
      headers: { [ERP_PROFILE_HEADER]: other.profile },
    });
    expect(mismatch.status).toBe(409);
    // O nome do objeto ("erp:<f>") não bate com a área pedida.
    expect((await mismatch.json<any>()).error.code).toBe("erp_wrong_instance");
    // A instância da área, mesmo nunca chamada antes, não vira ERP.
    const area = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const wrong = await area.fetch("https://coordinator/erp-ping", {
      headers: { [ERP_PROFILE_HEADER]: f.profile },
    });
    expect(wrong.status).toBe(409);
    expect((await wrong.json<any>()).error.code).toBe("erp_wrong_instance");
    // Rota da área na instância do ERP: 404, sem gravar "profile".
    const command = await erpStub(env, f.profile).fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({ profile: f.profile, operation: "x" }),
    });
    expect(command.status).toBe(404);
    expect(
      await runInDurableObject(erpStub(env, f.profile), (_i: any, s) => s.storage.get("profile")),
    ).toBeUndefined();
    // Sem cabeçalho de área: 400.
    expect((await erpStub(env, f.profile).fetch("https://coordinator/erp-ping")).status).toBe(400);
  });
});
