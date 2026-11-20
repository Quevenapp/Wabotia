import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json } from "../src/types";
import { onSettingsSave, registerAdminExtension } from "../src/modules/api";
import { configuredModuleStates } from "../src/modules/registry";
import {
  applyAreaTemplate, areaTemplates, areaTemplatesExtension, previewAreaTemplate, previewUndoAreaTemplate,
  segmentState, setSegmentChoice, undoAreaTemplate, validateAreaSetup,
} from "../src/area-templates";
import { SEGMENTS, SEGMENT_GROUPS, searchSegments } from "../src/area-templates/segments";
import { ownerSummary } from "../src/area-templates/owner-summary";
import { templateExamples } from "../src/area-templates/examples";
import { templateSelection } from "../web/admin/area-templates/selection";
import { fixture } from "./service-center-fixture";

registerAdminExtension(areaTemplatesExtension);
onSettingsSave("os", "os_area_setup", validateAreaSetup);

const template = (id: string) => areaTemplates.find((entry) => entry.id === id)!;
const settings = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);
const modules = async (profile: string) => configuredModuleStates(Object.fromEntries(
  (await all(env, "SELECT module_id,enabled FROM profile_modules WHERE profile_id=?", profile)).map((row) => [row.module_id, row.enabled])));
async function apply(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const input = { template_id: id, selection: templateSelection(template(id) as any) };
  const preview = await previewAreaTemplate(env, f.admin, f.profile, input, areaTemplates);
  expect(preview.conflicts).toEqual([]);
  await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }, areaTemplates);
  return preview;
}

describe("O segmento primeiro: ramos", () => {
  it("cada ramo aponta para um modelo do catálogo e todo grupo tem ramo", () => {
    for (const segment of SEGMENTS) if (segment.template_id) expect(template(segment.template_id), segment.id).toBeDefined();
    for (const group of SEGMENT_GROUPS) expect(SEGMENTS.some((segment) => segment.group === group.id), group.id).toBe(true);
    expect(new Set(SEGMENTS.map((segment) => segment.id)).size).toBe(SEGMENTS.length);
  });
  it("busca por palavra, sem acento e sem diferenciar maiúsculas", () => {
    expect(searchSegments("advogado").map((segment) => segment.id)).toEqual(expect.arrayContaining(["advogado", "escritorio_advocacia"]));
    expect(searchSegments("MECÂNICO").map((segment) => segment.id)).toContain("oficina");
    expect(searchSegments("pet").map((segment) => segment.id)).toContain("veterinaria");
    expect(searchSegments("")).toHaveLength(SEGMENTS.length);
    expect(searchSegments("zzzz")).toEqual([]);
  });
  it("prévia em linguagem de dono: liga, cria e não mexe", () => {
    const summary = ownerSummary(
      { work_types: [{ id: "manutencao", labels: { singular: "Manutenção de veículo" } }], modules: { os: true, agenda: true, erp: true } },
      [
        { path: "modules.os", action: "set", reason: "" }, { path: "modules.agenda", action: "set", reason: "" }, { path: "modules.erp", action: "keep", reason: "" },
        { path: "os_work_types.area_oficina__manutencao", action: "add", reason: "" },
        { path: "departments.area_oficina__a", action: "add", reason: "" }, { path: "departments.area_oficina__b", action: "add", reason: "" },
        { path: "menus.area_oficina__m", action: "add", reason: "" },
        { path: "examples.agenda", action: "add", reason: "" },
        { path: "menu_greeting", action: "keep", reason: "" },
      ],
    );
    expect(summary.turn_on).toEqual(["Ordem de Serviço", "Agenda"]);
    expect(summary.already_on).toEqual(["Cadastros"]);
    expect(summary.create).toEqual(expect.arrayContaining(['o modelo de ordem "Manutenção de veículo"', "2 setores", "1 opção no menu do WhatsApp"]));
    expect(summary.untouched.join(" ")).toContain("mensagens");
  });
  it("exemplos só para os módulos do modelo", () => {
    expect(templateExamples({ id: "x", modules: { os: true } })).toEqual({});
    const consultoria = templateExamples(template("consultoria"));
    expect(consultoria.agenda?.services.length).toBeGreaterThan(0);
    expect(consultoria.agenda?.services.every((service) => service.name.endsWith("(exemplo)"))).toBe(true);
    expect(consultoria.mensalidade?.name).toContain("(exemplo)");
  });
});

describe("O segmento primeiro: aplicar, desfazer e trocar de ramo", () => {
  it("pergunta no primeiro acesso, registra o pular e dispensa o lembrete", async () => {
    const f = await fixture();
    expect(await segmentState(env, f.admin, f.profile, areaTemplates)).toMatchObject({ ask: true, remind: false, choice: null });
    expect(await setSegmentChoice(env, f.admin, f.profile, { action: "skip" }, areaTemplates)).toMatchObject({ ask: false, remind: true, choice: { status: "skipped" } });
    expect(await setSegmentChoice(env, f.admin, f.profile, { action: "dismiss" }, areaTemplates)).toMatchObject({ ask: false, remind: false });
    await expect(setSegmentChoice(env, f.member, f.profile, { action: "skip" }, areaTemplates)).rejects.toMatchObject({ status: 403 });
  });

  it("monta Agenda e Mensalidade de exemplo, grava a pegada e responde o ramo", async () => {
    const f = await fixture();
    const preview = await apply(f, "consultoria");
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.agenda", action: "add" }));
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.mensalidade", action: "add" }));
    const services = await all(env, "SELECT name FROM agenda_services WHERE profile_id=?", f.profile);
    expect(services.length).toBeGreaterThan(0);
    expect(services.every((service) => service.name.includes("(exemplo)"))).toBe(true);
    expect((await all(env, "SELECT * FROM agenda_hours WHERE profile_id=?", f.profile)).length).toBe(6);
    expect((await one(env, "SELECT name FROM mensalidade_plans WHERE profile_id=?", f.profile))!.name).toContain("(exemplo)");
    const footprint = await one(env, "SELECT * FROM area_template_footprints WHERE profile_id=? AND template_id='consultoria'", f.profile);
    expect(json(footprint!.modules_json)).toEqual(expect.arrayContaining(["agenda", "mensalidade", "os"]));
    expect(json(footprint!.examples_json).length).toBeGreaterThan(0);
    expect(await segmentState(env, f.admin, f.profile, areaTemplates)).toMatchObject({ ask: false, choice: { status: "chosen", template_id: "consultoria", segment_id: "consultoria" } });
  });

  it("não cria exemplo quando a área já tem cadastros", async () => {
    const f = await fixture();
    await exec(env, "INSERT INTO agenda_services(id,profile_id,name,duration_minutes,created,updated) VALUES('meu',?,'Meu serviço',30,1,1)", f.profile);
    await exec(env, "INSERT INTO mensalidade_plans(id,profile_id,name,amount_cents,created_by,created,updated) VALUES('meu',?,'Meu plano',100,'x',1,1)", f.profile);
    const preview = await apply(f, "consultoria");
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.agenda", action: "keep" }));
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.mensalidade", action: "keep" }));
    expect(await all(env, "SELECT id FROM agenda_services WHERE profile_id=?", f.profile)).toEqual([{ id: "meu" }]);
    expect(await all(env, "SELECT id FROM mensalidade_plans WHERE profile_id=?", f.profile)).toEqual([{ id: "meu" }]);
  });

  it("desfazer remove o que ninguém mexeu, mantém o alterado e diz por quê", async () => {
    const f = await fixture();
    await apply(f, "consultoria");
    const cfg = await settings(f.profile);
    const department = cfg.departments.find((entry: any) => entry.id.startsWith("area_consultoria__"));
    department.name = "Nome que eu escolhi";
    await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(cfg), f.profile);
    const plan = await one(env, "SELECT id FROM mensalidade_plans WHERE profile_id=?", f.profile);
    await exec(env, "UPDATE mensalidade_plans SET updated=updated+1 WHERE id=?", plan!.id);

    const preview = await previewUndoAreaTemplate(env, f.admin, f.profile, { template_id: "consultoria" }, areaTemplates);
    expect(preview.modules_off).toEqual(expect.arrayContaining(["Agenda", "Mensalidade", "Ordem de Serviço"]));
    expect(preview.kept).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("alterado") }));
    expect(preview.kept).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("editado") }));
    await undoAreaTemplate(env, f.admin, f.profile, { template_id: "consultoria", preview_hash: preview.preview_hash }, areaTemplates);

    const after = await settings(f.profile);
    expect(after.departments.map((entry: any) => entry.name)).toContain("Nome que eu escolhi");
    expect(after.menus.some((menu: any) => String(menu.id).startsWith("area_consultoria__"))).toBe(false);
    // Modelos de ordem não se apagam: ficam arquivados.
    const types = (after.os_work_types || []).filter((type: any) => type.id.startsWith("area_consultoria__"));
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((type: any) => type.archived)).toBe(true);
    const states = await modules(f.profile);
    expect(states.agenda).toBe(false);
    expect(states.mensalidade).toBe(false);
    expect(await all(env, "SELECT id FROM agenda_services WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM mensalidade_plans WHERE profile_id=?", f.profile)).toEqual([{ id: plan!.id }]);
    const state = await segmentState(env, f.admin, f.profile, areaTemplates);
    expect(state.applied[0]).toMatchObject({ template_id: "consultoria", status: "undone" });
    expect(state.applied[0].report?.kept.length).toBeGreaterThan(0);
    await expect(undoAreaTemplate(env, f.admin, f.profile, { template_id: "consultoria", preview_hash: preview.preview_hash }, areaTemplates))
      .rejects.toMatchObject({ code: "template_not_applied" });

    // Aplicar de novo recria o que saiu, sem conflito de prefixo.
    await apply(f, "consultoria");
    const again = await settings(f.profile);
    expect(again.menus.some((menu: any) => String(menu.id).startsWith("area_consultoria__"))).toBe(true);
    expect(again.os_work_types.filter((type: any) => type.id.startsWith("area_consultoria__")).every((type: any) => !type.archived)).toBe(true);
    expect((await modules(f.profile)).agenda).toBe(true);
  });

  it("recusa desfazer com prévia velha", async () => {
    const f = await fixture();
    await apply(f, "servicos");
    const preview = await previewUndoAreaTemplate(env, f.admin, f.profile, { template_id: "servicos" }, areaTemplates);
    const cfg = await settings(f.profile);
    cfg.menu_greeting = "Outra saudação";
    await exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(cfg), f.profile);
    await expect(undoAreaTemplate(env, f.admin, f.profile, { template_id: "servicos", preview_hash: preview.preview_hash }, areaTemplates))
      .rejects.toMatchObject({ code: "preview_stale" });
  });

  it("trocar de ramo: o módulo que o novo modelo também usa continua ligado", async () => {
    const f = await fixture();
    await apply(f, "servicos");
    await apply(f, "consultoria");
    // Os dois usam Ordem de Serviço: desfazer o primeiro não desliga a OS.
    const preview = await previewUndoAreaTemplate(env, f.admin, f.profile, { template_id: "servicos" }, areaTemplates);
    expect(preview.modules_off).not.toContain("Ordem de Serviço");
    await undoAreaTemplate(env, f.admin, f.profile, { template_id: "servicos", preview_hash: preview.preview_hash }, areaTemplates);
    expect((await modules(f.profile)).os).toBe(true);
  });
});
