import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { perform } from "../src/service";
import { json, uid } from "../src/types";
import {
  enabledDependents,
  listModules,
  missingRequirements,
  moduleEnabled,
  modules,
  resolveStates,
  type ModuleDefinition,
} from "../src/modules/registry";
import { fixture } from "./service-center-fixture";

const fake = (
  id: string,
  requires: string[] = [],
  default_enabled = false,
): ModuleDefinition => ({
  id,
  name: id.toUpperCase(),
  version: "1.0.0",
  description: "",
  builtin: true,
  default_enabled,
  navigation: [],
  menu_item_types: [],
  events: [],
  settings: [],
  routes: [],
  operations: [],
  scopes: [],
  requires,
});

describe("requires: regras puras", () => {
  // mensal ← suporte ← extra
  const list = [
    fake("mensal"),
    fake("suporte", ["mensal"]),
    fake("extra", ["suporte"]),
  ];
  it("dependente conta como desligado sem o requerido, em cadeia", () => {
    expect(resolveStates({ suporte: 1, extra: 1 }, list)).toEqual({
      mensal: false,
      suporte: false,
      extra: false,
    });
    expect(resolveStates({ mensal: 1, suporte: 1, extra: 1 }, list)).toEqual({
      mensal: true,
      suporte: true,
      extra: true,
    });
  });
  it("lista o que falta para ligar e quem cai ao desligar", () => {
    const off = resolveStates({}, list);
    expect(missingRequirements("suporte", off, list)).toEqual(["mensal"]);
    expect(missingRequirements("mensal", off, list)).toEqual([]);
    const on = resolveStates({ mensal: 1, suporte: 1, extra: 1 }, list);
    expect(enabledDependents("mensal", on, list)).toEqual(["suporte", "extra"]);
    expect(enabledDependents("extra", on, list)).toEqual([]);
  });
});

describe("requires: ligar e desligar na área", () => {
  // Módulo de teste que depende de Formulários, só durante o caso.
  async function withDependent(run: () => Promise<void>) {
    const list = modules as ModuleDefinition[];
    list.push(fake("teste_dep", ["forms"]));
    try {
      await run();
    } finally {
      list.splice(
        list.findIndex((m) => m.id === "teste_dep"),
        1,
      );
    }
  }
  const set = (f: any, id: string, enabled: boolean, extra: any = {}) =>
    perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id, enabled, ...extra },
      uid(),
    );

  it("não liga sem o requerido; desligar o requerido pede cascade e desliga junto", async () => {
    await withDependent(async () => {
      const f = await fixture();
      await set(f, "forms", false);
      await expect(set(f, "teste_dep", true)).rejects.toMatchObject({
        status: 409,
        code: "module_requires",
        message: expect.stringMatching(/depende de Formulários/),
      });
      await set(f, "forms", true);
      await set(f, "teste_dep", true);
      expect(await moduleEnabled(env, f.profile, "teste_dep")).toBe(true);
      const view = (await listModules(env, f.admin, f.profile)).data.find(
        (m: any) => m.id === "teste_dep",
      );
      expect(view).toMatchObject({ enabled: true, requires: ["forms"] });

      await expect(set(f, "forms", false)).rejects.toMatchObject({
        status: 409,
        code: "module_required",
        message: expect.stringMatching(/TESTE_DEP depende de Formulários/),
      });
      expect(await moduleEnabled(env, f.profile, "forms")).toBe(true);
      const result = await set(f, "forms", false, { cascade: true });
      expect(result).toMatchObject({
        enabled: false,
        also_disabled: ["teste_dep"],
      });
      expect(await moduleEnabled(env, f.profile, "teste_dep")).toBe(false);
      const events = await all(
        env,
        "SELECT payload FROM events WHERE profile_id=? AND kind='module.changed' ORDER BY id",
        f.profile,
      );
      expect(events.map((e) => json(e.payload)).at(-1)).toMatchObject({
        module_id: "teste_dep",
        enabled: false,
        because: "forms",
      });
      // Religar o requerido não religa o dependente sozinho.
      await set(f, "forms", true);
      expect(await moduleEnabled(env, f.profile, "teste_dep")).toBe(false);
    });
  });
});
