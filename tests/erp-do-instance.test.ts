// Fase 0 do ERP, prova 2: a instância "erp:<área>" da classe Coordinator
// convive com a da área. O alarme do ERP não roda o pipeline do WhatsApp nem
// toca o D1; a área continua igual.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { erpFetch, erpStub, ERP_PROFILE_HEADER } from "../src/erp/hub";
import { countingEnv } from "./d1-counter";
import { drain, fixture, receive } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { syncErpParts } from "../src/modules/erp/parts-state";

async function authorize(f: Awaited<ReturnType<typeof fixture>>) {
  await setModule(f.profile, "erp", true, f.admin.id);
  expect((await syncErpParts(env, f.profile)).status).toBe("applied");
}

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
    await authorize(f);
    expect((await erpFetch(env, f.profile, "/erp-wake", { method: "POST" })).status).toBe(200);

    const stub = erpStub(env, f.profile);
    // Sem alarme, o /erp-wake agenda para já (o mais cedo vence): o runtime o
    // roda sozinho, e numa suíte lenta ele corria junto com a chamada manual
    // abaixo (falha intermitente). O teste tira esse alarme e agenda o seu, longe.
    await runInDurableObject(stub, (_i: any, state: DurableObjectState) => state.storage.deleteAlarm());
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
    // O alarme também roda pelo caminho do runtime. Agendado longe, para que
    // só o runDurableObjectAlarm o rode (sem disputa com o disparo automático).
    await runInDurableObject(stub, (_i: any, state: DurableObjectState) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );
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
    // Esquema, semeadura e alarme no objeto: 5 a 14,5 s no Dell com a suíte
    // inteira (conferência da K, 16/11); o padrão de 5 s estourava.
  }, 60_000);

  it("causa da falha intermitente: o /erp-wake sem alarme agenda para já e o runtime roda sozinho; o agendado longe, não", async () => {
    const f = await fixture();
    const stub = erpStub(env, f.profile);
    await erpFetch(env, f.profile, "/erp-ping");
    await authorize(f);
    await runInDurableObject(stub, (_i: any, state: DurableObjectState) => state.storage.deleteAlarm());
    const lastAlarm = () =>
      runInDurableObject(stub, (_i: any, state: DurableObjectState) =>
        state.storage.sql.exec("SELECT value FROM erp_meta WHERE key='last_alarm'").toArray()[0]?.value,
      );
    // Sem alarme, o wake (o mais cedo vence, docs/ERP-AGENDADOR.md) agenda
    // para agora: o runtime roda o alarme sozinho, sem o teste mandar. Era a
    // disputa com o runDurableObjectAlarm manual dos testes antigos.
    const before = Date.now();
    const woke = await (await erpFetch(env, f.profile, "/erp-wake", { method: "POST" })).json<any>();
    expect(woke.alarm).toBeLessThanOrEqual(Date.now() + 1);
    for (let i = 0; i < 200 && !(Number(await lastAlarm()) >= before); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(Number(await lastAlarm())).toBeGreaterThanOrEqual(before);
    // O alarme do agendador se reagenda (próxima rotina, no máximo 1 h).
    const next = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => state.storage.getAlarm());
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 3_600_000);
    // Padrão do teste: alarme agendado longe só roda quando o teste manda.
    await runInDurableObject(stub, (_i: any, state: DurableObjectState) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_i: any, state: DurableObjectState) => state.storage.deleteAlarm());
  }, 60_000);

  it("sem fotografia o wake falha fechado sem carregar dados nem agendar trabalho", async () => {
    const f = await fixture();
    const response = await erpFetch(env, f.profile, "/erp-wake", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "erp_parts_unavailable" } });
    const stored = await runInDurableObject(erpStub(env, f.profile), async (instance: any, state) => {
      await instance.alarm();
      return {
        alarm: await state.storage.getAlarm(),
        parts: await state.storage.get("erp_parts"),
        tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'erp_%'").toArray(),
      };
    });
    expect(stored).toEqual({ alarm: null, parts: undefined, tables: [] });
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
