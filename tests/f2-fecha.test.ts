import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { moduleCommand, moduleStates } from "../src/modules/registry";
import { commitSettingsPlan, planSettings } from "../src/service";
import { fixture } from "./service-center-fixture";

const core = ["erp-produtos", "erp-vendas", "erp-compras", "erp-estoque", "erp-financeiro"];
const oldSave = (profile: string, enabled: boolean) => exec(env,
  "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,'erp',?,1,'old') ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
  profile, Number(enabled));
function delivery() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { profile, revision } = JSON.parse(String(init?.body));
    return Response.json({ profile, revision });
  });
  const local = { ...env, COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as typeof env;
  return { local, fetch };
}
const snapshot = async (profile: string) => ({
  profile: await one(env, "SELECT * FROM profiles WHERE id=?", profile),
  modules: await all(env, "SELECT * FROM profile_modules WHERE profile_id=? ORDER BY module_id", profile),
  revision: await one(env, "SELECT * FROM profile_erp_revision WHERE profile_id=?", profile),
  managed: await one(env, "SELECT * FROM profile_erp_parts_managed WHERE profile_id=?", profile),
  events: await all(env, "SELECT * FROM events WHERE profile_id=? ORDER BY id", profile),
});

describe("fechamento fase 2: janela entre migração e Worker", () => {
  for (const prior of [false, undefined]) it(`ativação antiga completa as cinco partes: estado anterior ${prior}`, async () => {
    const f = await fixture({ legacyErpModules: true });
    if (prior !== undefined) await oldSave(f.profile, prior);
    await oldSave(f.profile, true);
    const states = await moduleStates(env, f.profile);
    for (const id of ["erp", ...core]) expect(states[id]).toBe(true);
    for (const id of ["erp-fiscal", "erp-cobranca", "erp-pdv"]) expect(states[id]).toBe(false);
    expect(await one(env, "SELECT * FROM profile_erp_parts_managed WHERE profile_id=?", f.profile)).toBeNull();
  });

  for (const source of ["module", "settings"] as const) {
    const change = async (local: typeof env, f: Awaited<ReturnType<typeof fixture>>, id: string, enabled: boolean) =>
      source === "module"
        ? moduleCommand(local, f.admin, f.profile, "module.set", { id, enabled })
        : commitSettingsPlan(local, f.admin, await planSettings(local, f.admin, f.profile, {}, { modules: { [id]: enabled } }));

    it(`${source}: ativação nova conserva só a Base e entrega a escolha exata`, async () => {
      const f = await fixture({ legacyErpModules: true }), d = delivery();
      await change(d.local, f, "erp", true);
      const states = await moduleStates(env, f.profile);
      expect(states.erp).toBe(true);
      for (const id of core) expect(states[id]).toBe(false);
      expect(await one(env, "SELECT * FROM profile_erp_parts_managed WHERE profile_id=?", f.profile)).toEqual({ profile_id: f.profile });
      expect(d.fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(d.fetch.mock.calls[0][1]?.body));
      expect(body.parts).toEqual({ customers: true, products: false, sales: false, purchases: false,
        stock: false, finance: false, fiscal: false, billing: false, pos: false });
    });

    it(`${source}: desligamento explícito não é revertido por reativação antiga`, async () => {
      const f = await fixture({ legacyErpModules: true }), d = delivery();
      await oldSave(f.profile, true);
      await change(d.local, f, "erp-estoque", false);
      const before = await all(env, "SELECT * FROM profile_modules WHERE profile_id=? AND module_id<>'erp' ORDER BY module_id", f.profile);
      await oldSave(f.profile, false); await oldSave(f.profile, true);
      expect(await all(env, "SELECT * FROM profile_modules WHERE profile_id=? AND module_id<>'erp' ORDER BY module_id", f.profile)).toEqual(before);
      expect((await moduleStates(env, f.profile))["erp-estoque"]).toBe(false);
    });

    it(`${source}: falha no lote desfaz também a marca e não entrega nem publica`, async () => {
      const f = await fixture({ legacyErpModules: true }), d = delivery();
      const before = await snapshot(f.profile);
      const trigger = `f2_mark_${f.profile.replaceAll("-", "")}`;
      await exec(env, `CREATE TRIGGER ${trigger} BEFORE INSERT ON profile_modules
        WHEN NEW.profile_id='${f.profile}' BEGIN SELECT RAISE(ABORT,'f2_mark_failure'); END`);
      try {
        await expect(change(d.local, f, "erp", true)).rejects.toThrow(/f2_mark_failure/);
        expect(await snapshot(f.profile)).toEqual(before);
        expect(d.fetch).not.toHaveBeenCalled();
      } finally { await exec(env, `DROP TRIGGER ${trigger}`); }
    });
  }
});
