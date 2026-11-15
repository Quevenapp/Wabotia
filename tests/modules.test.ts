import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { perform } from "../src/service";
import { uid } from "../src/types";
import {
  hiddenMenuTypes,
  moduleById,
  moduleForMenuType,
  moduleForOperation,
  moduleForRoute,
  moduleStates,
  modules,
  resolveStates,
} from "../src/modules/registry";
import { api, bearer, fixture } from "./service-center-fixture";

describe("registro de módulos", () => {
  it("cada módulo declara o contrato completo, sem ids repetidos", () => {
    const ids = modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of modules) {
      expect(m.id).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m.name.length).toBeGreaterThan(0);
      expect(Array.isArray(m.navigation)).toBe(true);
      expect(Array.isArray(m.menu_item_types)).toBe(true);
      expect(Array.isArray(m.events)).toBe(true);
      expect(Array.isArray(m.settings)).toBe(true);
      expect(typeof m.default_enabled).toBe("boolean");
    }
    const types = modules.flatMap((m) => m.menu_item_types.map((t) => t.type));
    expect(new Set(types).size).toBe(types.length);
  });

  it("acha o dono de tipo de menu, operação e rota", () => {
    expect(moduleById("queue")?.name).toBe("Fila presencial");
    expect(moduleForMenuType("queue")?.id).toBe("queue");
    expect(moduleForMenuType("human")).toBeNull();
    expect(moduleForOperation("queue.call_next")?.id).toBe("queue");
    expect(moduleForOperation("counter.state")?.id).toBe("queue");
    expect(moduleForOperation("ticket.create")).toBeNull();
    expect(moduleForRoute("queue")?.id).toBe("queue");
    expect(moduleForRoute("tickets")).toBeNull();
  });

  it("sem registro vale o padrão; o registro salvo prevalece", () => {
    expect(resolveStates({}).queue).toBe(true);
    expect(resolveStates({ queue: 0 }).queue).toBe(false);
    expect(resolveStates({ queue: 1, unknown: 0 })).not.toHaveProperty(
      "unknown",
    );
    expect([...hiddenMenuTypes({ queue: false })]).toContain("queue");
    expect([...hiddenMenuTypes({ queue: true })]).not.toContain("queue");
  });

  it("administrador liga e desliga por área, com evento e auditoria do estado", async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await moduleStates(env, f.profile)).queue).toBe(true);
    const off = await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "queue", enabled: false },
      uid(),
    );
    expect(off).toMatchObject({ id: "queue", enabled: false });
    expect((await moduleStates(env, f.profile)).queue).toBe(false);
    // A outra área não muda.
    expect((await moduleStates(env, other.profile)).queue).toBe(true);
    const row = await one(
      env,
      "SELECT * FROM profile_modules WHERE profile_id=? AND module_id='queue'",
      f.profile,
    );
    expect(row).toMatchObject({ enabled: 0, updated_by: f.admin.id });
    const events = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='module.changed'",
      f.profile,
    );
    expect(events).toHaveLength(1);
    // Repetir o mesmo estado não publica outro evento.
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "queue", enabled: false },
      uid(),
    );
    expect(
      (
        await all(
          env,
          "SELECT id FROM events WHERE profile_id=? AND kind='module.changed'",
          f.profile,
        )
      ).length,
    ).toBe(1);
  });

  it("recusa atendente, módulo desconhecido e estado inválido", async () => {
    const f = await fixture();
    const set = (actor: any, data: any) =>
      perform(env, actor, f.profile, "module.set", data, uid());
    await expect(
      set(f.member, { id: "queue", enabled: false }),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      set(f.admin, { id: "nada", enabled: false }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      set(f.admin, { id: "queue", enabled: "não" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("GET e PUT /modules pela API", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const list = await (
      await api(token, `/profiles/${f.profile}/modules`)
    ).json<any>();
    const queue = list.data.find((m: any) => m.id === "queue");
    expect(queue).toMatchObject({
      enabled: true,
      default_enabled: true,
      version: "1.0.0",
      builtin: true,
    });
    const put = await api(
      token,
      `/profiles/${f.profile}/modules/queue`,
      "PUT",
      {
        enabled: false,
      },
    );
    expect(put.status).toBe(200);
    const after = await (
      await api(token, `/profiles/${f.profile}/modules`)
    ).json<any>();
    expect(after.data.find((m: any) => m.id === "queue")).toMatchObject({
      enabled: false,
      updated_by: f.admin.id,
    });
    const member = await bearer(f.member);
    const denied = await api(
      member,
      `/profiles/${f.profile}/modules/queue`,
      "PUT",
      {
        enabled: true,
      },
    );
    expect(denied.status).toBe(403);
  });
});
