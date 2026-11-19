import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { moduleCommand, moduleStates } from "../src/modules/registry";
import { readErpPartsState } from "../src/modules/erp/parts-state";
import { commitSettingsPlan, planSettings } from "../src/service";
import { applyAreaTemplate, previewAreaTemplate } from "../src/area-templates";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { engenheirosTemplate } from "../src/area-templates/models/engenheiros";
import { advogadosTemplate } from "../src/area-templates/models/advogados";
import { escritorioAdvocaciaTemplate } from "../src/area-templates/models/escritorio-advocacia";
import { restauranteTemplate } from "../src/area-templates/models/restaurante";
import { templateSelection } from "../web/admin/area-templates/AreaTemplatesPage";
import { fixture } from "./service-center-fixture";

const save = (profile: string, id: string, enabled = true) => exec(env,
  "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,1,'test') ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
  profile, id, Number(enabled));
const snapshot = async (profile: string) => ({
  modules: await all(env, "SELECT * FROM profile_modules WHERE profile_id=? ORDER BY module_id", profile),
  revision: await one(env, "SELECT * FROM profile_erp_revision WHERE profile_id=?", profile),
  events: await all(env, "SELECT * FROM events WHERE profile_id=? ORDER BY id", profile),
});
function delivery() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { profile, revision } = JSON.parse(String(init?.body));
    return Response.json({ profile, revision });
  });
  const idFromName = vi.fn((name: string) => name);
  const local = { ...env, COORDINATOR: { idFromName, get: () => ({ fetch }) } } as unknown as typeof env;
  return { local, fetch, idFromName };
}

describe("f2-corr-painel: confirmação de cascata", () => {
  it("recusa novos dependentes sem escrever e aceita a lista reconfirmada, independentemente da ordem", async () => {
    const f = await fixture(), d = delivery();
    for (const id of ["erp", "erp-produtos", "erp-vendas"]) await save(f.profile, id);
    const confirmed = ["erp-produtos", "erp-vendas"];
    await save(f.profile, "erp-financeiro"); // Outro administrador, depois da confirmação.
    const before = await snapshot(f.profile);
    await expect(moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "erp", enabled: false, cascade: true, confirmed_dependents: confirmed,
    })).rejects.toMatchObject({ status: 409, code: "module_cascade_conflict" });
    expect(await snapshot(f.profile)).toEqual(before);
    expect(d.idFromName).not.toHaveBeenCalled();
    const result = await moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "erp", enabled: false, cascade: true,
      confirmed_dependents: ["erp-financeiro", ...confirmed].reverse(),
    });
    expect(new Set(result.also_disabled)).toEqual(new Set([...confirmed, "erp-financeiro"]));
    const states = await moduleStates(env, f.profile);
    for (const id of ["erp", ...confirmed, "erp-financeiro"]) expect(states[id]).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("recusa confirmação inválida, duplicada, com IDs extras ou com dependente removido", async () => {
    const f = await fixture(), d = delivery();
    await save(f.profile, "erp"); await save(f.profile, "erp-financeiro");
    // Quando enviada, a lista deve corresponder ao conjunto atual.
    const beforeWarning = await snapshot(f.profile);
    await expect(moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "erp", enabled: false,
    })).rejects.toMatchObject({ status: 409, code: "module_required" });
    expect(await snapshot(f.profile)).toEqual(beforeWarning);
    for (const confirmed_dependents of [null, [], ["erp-financeiro", "erp-financeiro"], ["erp-financeiro", "agenda"], "erp-financeiro", [1]]) {
      const before = await snapshot(f.profile);
      await expect(moduleCommand(d.local, f.admin, f.profile, "module.set", {
        id: "erp", enabled: false, cascade: true, confirmed_dependents,
      })).rejects.toMatchObject({ status: 409, code: "module_cascade_conflict" });
      expect(await snapshot(f.profile)).toEqual(before);
    }
    await save(f.profile, "erp-financeiro", false);
    const afterRemoval = await snapshot(f.profile);
    await expect(moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "erp", enabled: false, cascade: true, confirmed_dependents: ["erp-financeiro"],
    })).rejects.toMatchObject({ status: 409, code: "module_cascade_conflict" });
    expect(await snapshot(f.profile)).toEqual(afterRemoval);
    expect((await moduleStates(env, f.profile)).erp).toBe(true);
    expect(d.idFromName).not.toHaveBeenCalled();
  });

  it("aceita cascade sem lista e desliga os dependentes atuais por compatibilidade", async () => {
    const f = await fixture(), d = delivery();
    await save(f.profile, "erp"); await save(f.profile, "erp-financeiro");
    const result = await moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "erp", enabled: false, cascade: true, confirmed_dependents: undefined,
    });
    expect(result.also_disabled).toEqual(["erp-financeiro"]);
    const states = await moduleStates(env, f.profile);
    expect(states.erp).toBe(false);
    expect(states["erp-financeiro"]).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("uma confirmação vazia não autoriza um dependente ligado depois", async () => {
    const f = await fixture(), d = delivery();
    await save(f.profile, "os"); await save(f.profile, "juridico");
    await expect(moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "os", enabled: false, cascade: true, confirmed_dependents: [],
    })).rejects.toMatchObject({ code: "module_cascade_conflict" });
    await moduleCommand(d.local, f.admin, f.profile, "module.set", {
      id: "os", enabled: false, cascade: true, confirmed_dependents: ["juridico"],
    });
    expect((await moduleStates(env, f.profile)).juridico).toBe(false);
    expect(d.idFromName).not.toHaveBeenCalled();
  });
});

describe("f2-corr-painel: sincronização só com revisão pendente", () => {
  for (const prior of ["never", "off", "on"] as const) it(`não acorda ERP por Agenda ou configuração comum: ${prior}`, async () => {
    const f = await fixture(), d = delivery();
    if (prior !== "never") {
      await save(f.profile, "erp", prior === "on");
      await exec(env, "UPDATE profile_erp_revision SET delivered_revision=revision WHERE profile_id=?", f.profile);
    }
    const before = (await readErpPartsState(env, f.profile)).erp_sync;
    const result = await moduleCommand(d.local, f.admin, f.profile, "module.set", { id: "agenda", enabled: true });
    expect(result.erp_sync).toEqual(before);
    const plan = await planSettings(d.local, f.admin, f.profile, { menu_greeting: "Olá, escolha uma opção." });
    expect((await commitSettingsPlan(d.local, f.admin, plan)).erp_sync).toEqual(before);
    expect(d.idFromName).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  for (const source of ["module", "settings"] as const) it(`entrega revisão pendente e não repete após ACK: ${source}`, async () => {
    const f = await fixture(), d = delivery();
    await save(f.profile, "erp", false);
    const change = async () => source === "module"
      ? moduleCommand(d.local, f.admin, f.profile, "module.set", { id: "agenda", enabled: true })
      : commitSettingsPlan(d.local, f.admin, await planSettings(d.local, f.admin, f.profile, { menu_greeting: "Olá!" }));
    expect((await readErpPartsState(env, f.profile)).erp_sync.status).toBe("pending");
    expect((await change()).erp_sync.status).toBe("applied");
    expect(d.idFromName).toHaveBeenCalledWith(`erp:${f.profile}`);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await change();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("uma entrega perdida continua pendente e uma configuração comum tenta novamente", async () => {
    const f = await fixture(), d = delivery();
    d.fetch.mockRejectedValueOnce(new Error("ACK perdido"));
    const first = await moduleCommand(d.local, f.admin, f.profile, "module.set", { id: "erp", enabled: true });
    expect(first.erp_sync.status).toBe("pending");
    const plan = await planSettings(d.local, f.admin, f.profile, { menu_greeting: "Olá!" });
    expect((await commitSettingsPlan(d.local, f.admin, plan)).erp_sync.status).toBe("applied");
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("entrega ativações, desligamentos e mudanças ERP de um plano de configurações", async () => {
    const f = await fixture(), d = delivery();
    await moduleCommand(d.local, f.admin, f.profile, "module.set", { id: "erp", enabled: true });
    await commitSettingsPlan(d.local, f.admin, await planSettings(d.local, f.admin, f.profile, {}, { modules: { "erp-financeiro": true } }));
    await moduleCommand(d.local, f.admin, f.profile, "module.set", { id: "erp", enabled: false, cascade: true, confirmed_dependents: ["erp-financeiro"] });
    expect(d.fetch).toHaveBeenCalledTimes(3);
    const bodies = d.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map(body => body.parts.customers)).toEqual([true, true, false]);
    expect(bodies.map(body => body.parts.finance)).toEqual([false, true, false]);
    expect((await readErpPartsState(env, f.profile)).erp_sync.status).toBe("applied");
  });
});

describe("f2-corr-painel: Fiscal optativo nos cinco modelos", () => {
  for (const model of [assistenciaTecnicaTemplate, engenheirosTemplate, advogadosTemplate, escritorioAdvocaciaTemplate, restauranteTemplate]) {
    it(`${model.id}: começa desmarcado, aparece na prévia se escolhido e preserva a escolha local`, async () => {
      const f = await fixture(), d = delivery();
      const defaults = templateSelection(model);
      expect(defaults.module_ids).not.toContain("erp-fiscal");
      expect(model.modules["erp-fiscal"]).toBe(true); // Opção de ligar, não proposta de desligar.
      const selection = { ...defaults, module_ids: defaults.module_ids.map(String), work_type_ids: [], menus: false, departments: false, ticket_categories: false, vocabulary: false, texts: false, bot_suggestions: false };
      const input = { manifest: model, selection };
      let preview = await previewAreaTemplate(d.local, f.admin, f.profile, input);
      expect(preview.can_apply).toBe(true);
      expect(preview.changes.some(change => change.path === "modules.erp-fiscal")).toBe(false);
      await applyAreaTemplate(d.local, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
      expect((await moduleStates(env, f.profile))["erp-fiscal"]).toBe(false);
      selection.module_ids.push("erp-fiscal");
      preview = await previewAreaTemplate(d.local, f.admin, f.profile, input);
      expect(preview.changes).toContainEqual(expect.objectContaining({ path: "modules.erp-fiscal", action: "set" }));
      await applyAreaTemplate(d.local, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
      expect((await moduleStates(env, f.profile))["erp-fiscal"]).toBe(true);
      await save(f.profile, "erp-fiscal", false);
      preview = await previewAreaTemplate(d.local, f.admin, f.profile, input);
      expect(preview.changes).toContainEqual(expect.objectContaining({ path: "modules.erp-fiscal", action: "keep" }));
      await applyAreaTemplate(d.local, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
      expect((await moduleStates(env, f.profile))["erp-fiscal"]).toBe(false);
    });
  }
});
