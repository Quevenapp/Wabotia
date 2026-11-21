import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec } from "../src/db";
import { fixture } from "./service-center-fixture";
import { ERP_MODULE_IDS, normalizeErpParts } from "../src/erp/parts";
import { modules, moduleCommand, listModules, resolveStates, enabledDependents } from "../src/modules/registry";
import { acknowledgeErpParts, readErpPartsState, deliverErpParts } from "../src/modules/erp/parts-state";
import { erpIdentity } from "../src/modules/erp/identity";
import { erpApi, localFetch } from "../src/erp/api/local-fetch";
import { erpStub } from "../src/erp/hub";
import { encodeIdentity, IDENTITY_HEADER } from "../src/erp/engine/identity";
import { handleRpc } from "../src/erp/engine/rpc-endpoint";
import { applyErpPartsSnapshot } from "../src/erp/parts-control";
import { migrate } from "../src/erp/hub-engine";

const enable = (profile: string, id: string, value = 1) => exec(env,
  "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,'agora','test') ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
  profile, id, value);

describe("fase 2: contrato, entrega e portões", () => {
  it("nove módulos embutidos, padrões fechados e seis papéis somente na Base", () => {
    const defs = modules.filter(m => ERP_MODULE_IDS.includes(m.id as any));
    // + Produção (erp-producao): dez módulos embutidos.
    expect(defs).toHaveLength(10);
    expect(defs.every(m => m.builtin && !m.default_enabled)).toBe(true);
    expect(defs.find(m => m.id === "erp")?.grants).toHaveLength(6);
    expect(defs.filter(m => m.id !== "erp").every(m => !m.grants?.length)).toBe(true);
    expect(defs.find(m => m.id === "erp")?.navigation[0].label).toBe("ERP");
    const states = resolveStates(Object.fromEntries(ERP_MODULE_IDS.map(id => [id, 1])));
    expect(enabledDependents("erp-produtos", states)).toEqual(expect.arrayContaining(["erp-vendas", "erp-compras", "erp-estoque", "erp-pdv"]));
    expect(resolveStates({ erp: 1, "erp-pdv": 1 })["erp-pdv"]).toBe(false);
  });

  it("leitura fresca consistente, perfil vazio e ACK antigo não encobrem revisão nova", async () => {
    const f = await fixture();
    let s = await readErpPartsState(env, f.profile);
    expect(s.snapshot.revision).toBe("0"); expect(Object.values(s.snapshot.parts).every(v => !v)).toBe(true);
    await enable(f.profile, "erp");
    s = await readErpPartsState(env, f.profile);
    expect(s.snapshot.parts.customers).toBe(true);
    await enable(f.profile, "erp-produtos");
    await acknowledgeErpParts(env, f.profile, s.snapshot.revision);
    const latest = await readErpPartsState(env, f.profile);
    expect(BigInt(latest.snapshot.revision)).toBeGreaterThan(BigInt(s.snapshot.revision));
    expect(latest.erp_sync).toMatchObject({ status: "pending", delivered_revision: s.snapshot.revision });
    expect((await listModules(env, f.admin, f.profile)).erp_sync).toEqual(latest.erp_sync);
  });

  it("dependências exigem confirmação e cascata grava o conjunto antes dos eventos", async () => {
    const f = await fixture();
    for (const id of ERP_MODULE_IDS) await enable(f.profile, id);
    await expect(moduleCommand(env, f.admin, f.profile, "module.set", { id: "erp-produtos", enabled: false })).rejects.toMatchObject({ code: "module_required" });
    const result = await moduleCommand(env, f.admin, f.profile, "module.set", { id: "erp-produtos", enabled: false, cascade: true });
    expect(result.also_disabled).toEqual(expect.arrayContaining(["erp-vendas", "erp-compras", "erp-estoque", "erp-pdv"]));
    const rows = await all(env, "SELECT module_id,enabled FROM profile_modules WHERE profile_id=?", f.profile);
    for (const id of ["erp-produtos", ...result.also_disabled!]) expect(rows.find(r => r.module_id === id).enabled).toBe(0);
    expect(rows.find(r => r.module_id === "erp-financeiro").enabled).toBe(1);
    expect(result.erp_sync.status).toMatch(/pending|applied/);
  });

  it("falha no meio da cascata desfaz todas as linhas do batch", async () => {
    const f = await fixture();
    for (const id of ERP_MODULE_IDS) await enable(f.profile, id);
    const initial = await readErpPartsState(env, f.profile);
    // Interrompe depois da primeira escrita para provar atomicidade, não só estado final.
    const trigger = `f2_cascade_${f.profile.replaceAll("-", "")}`;
    await exec(env, `CREATE TRIGGER ${trigger} BEFORE UPDATE OF enabled ON profile_modules
      WHEN NEW.profile_id='${f.profile}' AND NEW.module_id='erp-vendas' AND NEW.enabled=0
      BEGIN SELECT RAISE(ABORT,'f2_cascade_failure'); END`);
    try {
      await expect(moduleCommand(env, f.admin, f.profile, "module.set", { id: "erp-produtos", enabled: false, cascade: true })).rejects.toThrow();
      const after = await readErpPartsState(env, f.profile);
      expect(after.snapshot.parts).toEqual(initial.snapshot.parts);
      expect(after.snapshot.revision).toBe(initial.snapshot.revision);
    } finally { await exec(env, `DROP TRIGGER ${trigger}`); }
  });

  it("entrega perdida ou ACK de outra revisão permanece pendente", async () => {
    const f = await fixture(); await enable(f.profile, "erp");
    const { snapshot } = await readErpPartsState(env, f.profile);
    const unavailable = { ...env, COORDINATOR: { idFromName: () => "id", get: () => ({ fetch: async () => { throw new Error("perdida"); } }) } } as any;
    expect(await deliverErpParts(unavailable, snapshot)).toBe(false);
    const wrong = { ...env, COORDINATOR: { idFromName: () => "id", get: () => ({ fetch: async () => Response.json({ profile: f.profile, revision: "999" }) }) } } as any;
    expect(await deliverErpParts(wrong, snapshot)).toBe(false);
    expect((await readErpPartsState(env, f.profile)).erp_sync.status).toBe("pending");
  });

  it("HTTP ignora envelope externo e responde 409 com o código público", async () => {
    const f = await fixture(); await enable(f.profile, "erp");
    const identity = await erpIdentity(env, f.admin, f.profile);
    const request = new Request(`https://test/api/v1/profiles/${f.profile}/erp/v1/cadastros/products`, {
      headers: { [IDENTITY_HEADER]: encodeIdentity({ ...identity, parts: normalizeErpParts() }) },
    });
    await expect(erpApi(env, request, f.profile, f.admin, identity)).rejects.toMatchObject({ status: 409, code: "module_disabled" });
    const gate: { denied: string | null; partsDenied?: string } = { denied: null };
    const response = await localFetch(env, f.profile, f.admin, identity, { read: true, gate })("https://erp.wabotia.invalid/rest/v1/rpc/erp_catalog_product_list", {
      method: "POST", body: JSON.stringify({ p_user_id: f.admin.id }),
    });
    expect(response.status).toBe(409); expect(gate.partsDenied).toBe("module_disabled");
  });

  it("entrada de produção exige mapa completo; revisão antiga falha antes do motor comercial", async () => {
    const f = await fixture(); await enable(f.profile, "erp");
    const identity = await erpIdentity(env, f.admin, f.profile);
    await runInDurableObject(erpStub(env, f.profile), async (_instance: any, state: DurableObjectState) => {
      migrate(state.storage);
      const invoke = (port: any) => handleRpc(state, f.profile, "erp_access_me", new Request("https://internal/erp-rpc/erp_access_me", {
        method: "POST", headers: { [IDENTITY_HEADER]: encodeIdentity(port) }, body: JSON.stringify({ p_user_id: f.admin.id }),
      }));
      expect((await invoke({ ...identity, parts: { customers: true } })).status).toBe(503);
      const snapshot = { ...identity.partsControl!, parts: identity.parts!, revision: String(BigInt(identity.partsControl!.revision) + 1n) };
      await applyErpPartsSnapshot(state.storage, f.profile, snapshot);
      const stale = await invoke(identity);
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "erp_parts_stale" });
    });
  });
});
