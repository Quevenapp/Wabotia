import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one, withReadCache } from "../src/db";
import { json } from "../src/types";
import { modules, moduleById, moduleStates } from "../src/modules/registry";
import { applyAreaTemplate, areaTemplates, previewAreaTemplate } from "../src/area-templates";
import { validateAreaTemplate, validateSelection, type AreaTemplate, type AreaTemplateSelection } from "../src/area-templates/validation";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { advogadosTemplate } from "../src/area-templates/models/advogados";
import { escritorioAdvocaciaTemplate } from "../src/area-templates/models/escritorio-advocacia";
import { engenheirosTemplate } from "../src/area-templates/models/engenheiros";
import { restauranteTemplate } from "../src/area-templates/models/restaurante";
import { bearer, fixture, type Fixture } from "./service-center-fixture";
import { motorWorkType } from "./os-motor-fixture";

const selection = (module_ids: string[], extra: Partial<AreaTemplateSelection> = {}): AreaTemplateSelection => ({
  work_type_ids: [], module_ids, menus: false, departments: false, ticket_categories: false,
  vocabulary: false, texts: false, bot_suggestions: false, ...extra,
});
const manifest = (states: Record<string, boolean>): AreaTemplate => ({
  schema_version: 1, id: "f2_modelos", version: 1, name: "Partes e extensões", description: "Configuração declarativa.",
  work_types: [], modules: states,
  vocabulary: { collection_label: "Trabalhos", customer_singular: "Cliente", customer_plural: "Clientes" },
  departments: [], ticket_categories: [], menus: [], texts: {},
  bot: { instructions: "", allowed_operations: [], denied_operations: [], suggested_roles: [] }, manual_steps: [],
});
const enabledIds = (model: AreaTemplate) => Object.keys(model.modules).filter((id) => model.modules[id]);
const configured = async (f: Fixture) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings);
async function saveModule(f: Fixture, id: string, enabled: boolean) {
  await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated,updated_by=excluded.updated_by",
    f.profile, id, enabled ? 1 : 0, 1, f.admin.id);
}
async function snapshot(f: Fixture) {
  return {
    settings: await configured(f),
    modules: await all(env, "SELECT * FROM profile_modules WHERE profile_id=? ORDER BY module_id", f.profile),
    provenance: await all(env, "SELECT * FROM os_area_template_applications WHERE profile_id=? ORDER BY template_id", f.profile),
    revision: await one(env, "SELECT * FROM profile_erp_revision WHERE profile_id=?", f.profile),
    events: await all(env, "SELECT * FROM events WHERE profile_id=? ORDER BY id", f.profile),
  };
}
async function apply(f: Fixture, model: AreaTemplate, choices = selection(enabledIds(model))) {
  const input = { manifest: model, selection: choices };
  const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
  expect(preview.conflicts).toEqual([]);
  expect(preview.can_apply).toBe(true);
  return applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
}
const commerce = ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "erp-fiscal"];
const service = ["erp", "erp-financeiro", "erp-fiscal"];
const posRequirements = ["erp", "erp-produtos", "erp-vendas", "erp-financeiro", "erp-estoque"];
const examples: Array<[AreaTemplate, string[]]> = [
  [assistenciaTecnicaTemplate, [...commerce, "os"]],
  [advogadosTemplate, [...service, "os", "juridico"]],
  [escritorioAdvocaciaTemplate, [...service, "os", "juridico"]],
  [engenheirosTemplate, [...service, "os"]],
  [restauranteTemplate, [...commerce, "pedido", "queue"]],
];

describe("fase 2: validação de módulos nos modelos", () => {
  it("aceita as nove partes, extensões registradas e uma seleção maior que doze", () => {
    const allowed = modules.filter((module) => module.builtin).map((module) => module.id);
    const model = validateAreaTemplate(manifest(Object.fromEntries(allowed.map((id) => [id, true]))));
    const choices = selection([...allowed].reverse());
    expect(allowed.length).toBeGreaterThan(12);
    expect(validateSelection(choices, model).module_ids).toEqual([...allowed].sort());
    expect(model.modules).toMatchObject({ juridico: true, "erp-produtos": true, "erp-cobranca": true, "erp-pdv": true });
    expect(choices.module_ids).toEqual([...allowed].reverse());
    expect(() => validateSelection(selection([...allowed, allowed[0]]), model)).toThrow();
  });

  it("recusa desconhecidos, estados não booleanos e IDs repetidos na seleção", () => {
    for (const states of [{ "erp-inexistente": true }, { erp: 1 }, { erp: "true" }, { erp: null }, { " erp": true }])
      expect(() => validateAreaTemplate({ ...manifest({}), modules: states })).toThrowError(expect.objectContaining({ code: "invalid_template" }));
    const model = validateAreaTemplate(manifest({ erp: true, "erp-financeiro": true }));
    for (const ids of [["erp-inexistente"], ["erp-financeiro", "erp-financeiro"], ["erp", " erp "], ["juridico"]])
      expect(() => validateSelection(selection(ids), model)).toThrowError(expect.objectContaining({ code: "invalid_template" }));
  });

  it("exige fechamento transitivo no manifesto, inclusive os e pedido", () => {
    const incomplete: Record<string, boolean>[] = [
      { "erp-pdv": true },
      { erp: true, "erp-vendas": true },
      { erp: false, "erp-financeiro": true },
      { juridico: true },
      { mesas: true },
    ];
    for (const states of incomplete)
      expect(() => validateAreaTemplate(manifest(states))).toThrowError(expect.objectContaining({ code: "invalid_template" }));
    expect(validateAreaTemplate(manifest({ os: true, juridico: true, pedido: true, mesas: true })).modules)
      .toEqual({ os: true, juridico: true, pedido: true, mesas: true });
    // Uma proposta explícita de desligamento não exige ligar os requisitos.
    expect(validateAreaTemplate(manifest({ erp: false, "erp-pdv": false })).modules["erp-pdv"]).toBe(false);
  });

  it("não permite hífen nos identificadores de tipos e campos de trabalho", () => {
    const model = manifest({ os: true });
    model.work_types = [motorWorkType()];
    const badType = structuredClone(model);
    badType.work_types[0].id = "tipo-com-hifen";
    expect(() => validateAreaTemplate(badType)).toThrow();
    const badField = structuredClone(model);
    badField.work_types[0].fields[0].id = "campo-com-hifen";
    expect(() => validateAreaTemplate(badField)).toThrow();
    expect(() => validateSelection(selection([], { work_type_ids: ["tipo-com-hifen"] }), model)).toThrow();
  });

  for (const [source, expected] of examples) it(`${source.id}: declara o conjunto e as opções sem prometer pontes`, () => {
    const model = validateAreaTemplate(source);
    expect(enabledIds(model).sort()).toEqual([...expected].sort());
    for (const id of enabledIds(model)) for (const required of moduleById(id)!.requires || [])
      expect(model.modules[required]).toBe(true);
    expect(model.modules["erp-pdv"]).toBe(false);
    expect(model.modules["erp-cobranca"]).toBe(false);
    for (const required of posRequirements) expect(model.modules).toHaveProperty(required);
    expect(model.manual_steps.join(" ")).toContain("ponte operacional");
    expect(model.manual_steps.join(" ")).toContain("ainda não está entregue");
    expect(model.manual_steps.join(" ")).toContain("emissão automática");
    expect(model.departments.every((department) => !department.members.length)).toBe(true);
    expect(JSON.stringify(model)).not.toMatch(/fagoo/i);
    const published = areaTemplates.find((template) => template.id === model.id)!;
    expect(published).toBeDefined();
    expect(published.modules).toEqual(model.modules);
    expect(published.version).toBe(model.id === "restaurante" ? 1 : model.id === "assistencia_tecnica" ? 3 : 2);
  });

  it("mantém processos e projetos como tipos existentes e Mesas como opção", () => {
    expect(advogadosTemplate.work_types.some((type) => type.id === "advocacia_processo")).toBe(true);
    expect(escritorioAdvocaciaTemplate.work_types.some((type) => type.id === "advocacia_processo")).toBe(true);
    expect(engenheirosTemplate.work_types.some((type) => type.id === "engenharia_projeto")).toBe(true);
    expect(restauranteTemplate.modules).toMatchObject({ mesas: false, pedido: true, queue: true });
  });
});

describe("fase 2: prévia e aplicação revisável", () => {
  for (const [source] of examples) it(`${source.id}: mostra todas as ativações e aplica só as selecionadas`, async () => {
    const f = await fixture();
    const model = areaTemplates.find((template) => template.id === source.id)!;
    const input = { template_id: model.id, selection: selection(enabledIds(model)) };
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input, areaTemplates);
    expect(preview.conflicts).toEqual([]);
    expect(preview.can_apply).toBe(true);
    expect(await snapshot(f)).toEqual(before);
    expect(preview.changes.filter((change) => change.path.startsWith("modules.")).map((change) => change.path).sort())
      .toEqual(enabledIds(model).map((id) => `modules.${id}`).sort());
    await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }, areaTemplates);
    const current = await moduleStates(env, f.profile);
    for (const id of enabledIds(model)) expect(current[id]).toBe(true);
    expect(current["erp-pdv"]).toBe(false);
    expect(current["erp-cobranca"]).toBe(false);
    const after = await snapshot(f);
    expect(after.settings).toEqual(before.settings);
    expect(Number(after.revision!.revision)).toBeGreaterThan(0);
    expect(after.provenance[0].template_version).toBe(model.version);
  });

  it("seleção incompleta do PDV mostra requisitos transitivos, não escreve nem liga ocultamente", async () => {
    const f = await fixture();
    const model = manifest(Object.fromEntries([...posRequirements, "erp-pdv"].map((id) => [id, true])));
    const input = { manifest: model, selection: selection(["erp-pdv"]) };
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(false);
    const dependency = preview.conflicts.find((item) => item.path === "modules.erp-pdv")!;
    expect(dependency.code).toBe("dependency_conflict");
    for (const required of posRequirements) expect(dependency.message).toContain(`(${required})`);
    expect(preview.changes.filter((change) => change.action === "set").map((change) => change.path)).toEqual(["modules.erp-pdv"]);
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }))
      .rejects.toMatchObject({ code: "dependency_conflict" });
    expect(await snapshot(f)).toEqual(before);
    await apply(f, model);
    for (const id of [...posRequirements, "erp-pdv"]) expect((await moduleStates(env, f.profile))[id]).toBe(true);
  });

  it.each([
    ["juridico", "os"], ["mesas", "pedido"], ["erp-cobranca", "erp-financeiro"],
  ])("a seleção de %s também exige %s explicitamente ou já ligado", async (id, requirement) => {
    const f = await fixture();
    const states: Record<string, boolean> = { [id]: true, [requirement]: true };
    if (id === "erp-cobranca") states.erp = true;
    const model = manifest(states);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, { manifest: model, selection: selection([id]) });
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ path: `modules.${id}`, code: "dependency_conflict" }));
    for (const required of Object.keys(states).filter((key) => key !== id)) await saveModule(f, required, true);
    await apply(f, model, selection([id]));
    expect((await moduleStates(env, f.profile))[id]).toBe(true);
  });

  it("desligamento em cascata exige selecionar todos os dependentes e mantém configurações", async () => {
    const f = await fixture();
    const ids = [...posRequirements, "erp-pdv", "erp-cobranca"];
    for (const id of ids) await saveModule(f, id, true);
    const model = manifest(Object.fromEntries(ids.map((id) => [id, false])));
    const before = await snapshot(f);
    const partial = { manifest: model, selection: selection(["erp"]) };
    const preview = await previewAreaTemplate(env, f.admin, f.profile, partial);
    expect(preview.can_apply).toBe(false);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ path: "modules.erp-pdv", code: "dependency_conflict" }));
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...partial, preview_hash: preview.preview_hash }))
      .rejects.toMatchObject({ code: "dependency_conflict" });
    expect(await snapshot(f)).toEqual(before);
    const result = await apply(f, model, selection(ids));
    expect(result.changes.filter((change) => change.action === "set")).toHaveLength(ids.length);
    for (const id of ids) expect((await moduleStates(env, f.profile))[id]).toBe(false);
    expect(await configured(f)).toEqual(before.settings);
  });

  it("reaplicação conserva escolhas locais, módulos e configurações não selecionados", async () => {
    const f = await fixture();
    const model = manifest({ erp: true, "erp-financeiro": true, "erp-fiscal": true, agenda: false });
    model.texts.menu_greeting = "Boas-vindas do modelo";
    await saveModule(f, "agenda", true);
    await apply(f, model, selection(["erp", "erp-financeiro"], { texts: true }));
    await saveModule(f, "erp-financeiro", false);
    const local = { ...(await configured(f)), menu_greeting: "Texto editado pela equipe", service_orders: { warranty_days: 12 } };
    await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(local), f.profile);
    const before = await snapshot(f);
    const next = { ...model, version: 2 };
    const result = await apply(f, next, selection(["erp", "erp-financeiro", "erp-fiscal"], { texts: true }));
    expect(result.changes).toContainEqual(expect.objectContaining({ path: "modules.erp-financeiro", action: "keep" }));
    expect((await moduleStates(env, f.profile))).toMatchObject({ erp: true, "erp-financeiro": false, "erp-fiscal": true, agenda: true });
    expect(await configured(f)).toEqual(before.settings);
    const once = await snapshot(f);
    await apply(f, next, selection(["erp", "erp-financeiro", "erp-fiscal"], { texts: true }));
    expect(await snapshot(f)).toEqual(once);
    const saved = json(once.provenance[0].seen_paths_json, []);
    expect(saved).not.toContain("modules.agenda");
  });

  it("publicação da versão 3 atualiza a versão 1 sem perder os caminhos já tratados", async () => {
    const f = await fixture();
    const published = areaTemplates.find((model) => model.id === assistenciaTecnicaTemplate.id)!;
    const legacy = { ...published, version: 1, modules: { os: true, payments: true, erp: false } };
    await apply(f, legacy, selection(["os", "payments"]));
    await saveModule(f, "payments", false);
    const local = { ...(await configured(f)), service_orders: { warranty_days: 12 }, menu_greeting: "Recepção local" };
    await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(local), f.profile);
    const input = { template_id: published.id, selection: selection(enabledIds(published), { texts: true }) };
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input, areaTemplates);
    expect(preview.conflicts).toEqual([]);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "modules.os", action: "keep" }));
    await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }, areaTemplates);
    expect((await moduleStates(env, f.profile))).toMatchObject({ erp: true, "erp-fiscal": true, payments: false });
    const settings = await configured(f);
    expect(settings.service_orders).toEqual(local.service_orders);
    expect(settings.menu_greeting).toBe(local.menu_greeting);
    expect((await snapshot(f)).provenance[0].template_version).toBe(3);
  });

  it("um novo dependente não religa um requisito desligado manualmente após a aplicação", async () => {
    const f = await fixture();
    const first = manifest({ erp: true, "erp-financeiro": true });
    await apply(f, first);
    await saveModule(f, "erp-financeiro", false);
    const next = { ...first, version: 2, modules: { ...first.modules, "erp-cobranca": true } };
    const input = { manifest: next, selection: selection(enabledIds(next)) };
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "modules.erp-financeiro", action: "keep" }));
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ path: "modules.erp-cobranca", code: "dependency_conflict" }));
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }))
      .rejects.toMatchObject({ code: "dependency_conflict" });
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["modules", "selection", "manifest", "settings"])("recusa prévia divergente por %s, inclusive com cache aquecido", async (change) => {
    const f = await fixture(), cached = withReadCache(env);
    const model = manifest({ erp: true, "erp-financeiro": true, "erp-fiscal": true });
    const input = { manifest: model, selection: selection(["erp", "erp-financeiro"]) };
    const preview = await previewAreaTemplate(cached, f.admin, f.profile, input);
    if (change === "modules") await saveModule(f, "erp-fiscal", true);
    if (change === "selection") input.selection.module_ids.push("erp-fiscal");
    if (change === "manifest") input.manifest.modules["erp-financeiro"] = false;
    if (change === "settings") await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify({ ...(await configured(f)), menu_greeting: "Mudou" }), f.profile);
    const before = await snapshot(f);
    await expect(applyAreaTemplate(cached, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }))
      .rejects.toMatchObject({ code: "preview_stale" });
    expect(await snapshot(f)).toEqual(before);
  });

  it("ativação e sugestões não concedem grants, acesso, papéis ou MFA", async () => {
    const f = await fixture();
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["os", "os:technician"]), f.member.id);
    await bearer(f.member);
    const local = await configured(f);
    const users = await all(env, "SELECT * FROM users WHERE id IN (?,?,?) ORDER BY id", f.admin.id, f.member.id, f.other.id);
    const sessions = await all(env, "SELECT * FROM sessions WHERE user_id=? ORDER BY hash", f.member.id);
    const source = areaTemplates.find((model) => model.id === assistenciaTecnicaTemplate.id)!;
    const model = { ...source, bot: { ...source.bot, suggested_roles: ["erp:admin", "erp:financeiro", "os:technician"] } };
    await apply(f, model, selection(enabledIds(model), { bot_suggestions: true }));
    const after = await configured(f);
    expect(after.module_grants).toEqual(local.module_grants);
    expect(after.person_access).toEqual(local.person_access);
    expect(after.os_area_setup).toContainEqual(expect.objectContaining({ template_id: model.id, bot: model.bot }));
    expect(await all(env, "SELECT * FROM users WHERE id IN (?,?,?) ORDER BY id", f.admin.id, f.member.id, f.other.id)).toEqual(users);
    expect(await all(env, "SELECT * FROM sessions WHERE user_id=? ORDER BY hash", f.member.id)).toEqual(sessions);
    expect(sessions[0].aal).toBe(1);
    expect(await all(env, "SELECT * FROM user_factors WHERE user_id IN (?,?,?)", f.admin.id, f.member.id, f.other.id)).toEqual([]);
  });
});
