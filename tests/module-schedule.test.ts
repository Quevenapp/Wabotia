import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { onSchedule } from "../src/modules/api";
import { runModuleSchedules } from "../src/modules/schedule";
import { fixture, type Fixture } from "./service-center-fixture";

// Os ganchos são globais no carregamento; cada teste filtra pela própria área.
const calls: { module: string; profile: string; now: number }[] = [];
const failing = new Set<string>();
onSchedule("queue", async (ctx, { now }) => {
  calls.push({ module: "queue", profile: ctx.profile, now });
  if (failing.has(ctx.profile)) throw new Error("falha simulada da fila");
});
onSchedule("forms", async (ctx, { now }) => {
  calls.push({ module: "forms", profile: ctx.profile, now });
});
const of = (f: Fixture) => calls.filter((c) => c.profile === f.profile);
const off = (f: Fixture, id: string) =>
  perform(env, f.admin, f.profile, "module.set", { id, enabled: false }, uid());

describe("gancho periódico dos módulos (onSchedule)", () => {
  it("roda os módulos ligados com o instante da rodada", async () => {
    const f = await fixture();
    const at = Date.UTC(2026, 10, 15, 12, 0);
    const outcome = await runModuleSchedules(env, f.profile, at);
    expect(outcome).toEqual([
      { module: "queue", ok: true },
      { module: "forms", ok: true },
    ]);
    expect(of(f)).toEqual([
      { module: "queue", profile: f.profile, now: at },
      { module: "forms", profile: f.profile, now: at },
    ]);
  });

  it("pula módulo desligado na área", async () => {
    const f = await fixture();
    await off(f, "queue");
    await runModuleSchedules(env, f.profile, 1);
    expect(of(f).map((c) => c.module)).toEqual(["forms"]);
  });

  it("a falha de um módulo não impede os outros", async () => {
    const f = await fixture();
    failing.add(f.profile);
    const outcome = await runModuleSchedules(env, f.profile, 2);
    expect(outcome[0]).toMatchObject({
      module: "queue",
      ok: false,
      error: "falha simulada da fila",
    });
    expect(outcome[1]).toEqual({ module: "forms", ok: true });
    expect(of(f).map((c) => c.module)).toEqual(["queue", "forms"]);
  });

  it("o alarme do Coordinator da área roda a rodada no máximo uma vez por minuto", async () => {
    const f = await fixture();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    await stub.fetch("https://coordinator/wake", {
      method: "POST",
      body: JSON.stringify({ profile: f.profile }),
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(of(f).map((c) => c.module)).toEqual(["queue", "forms"]);
    await stub.fetch("https://coordinator/wake", {
      method: "POST",
      body: JSON.stringify({ profile: f.profile }),
    });
    await runDurableObjectAlarm(stub);
    expect(of(f)).toHaveLength(2);
  });
});
