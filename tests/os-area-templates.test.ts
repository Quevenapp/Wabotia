import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one, withReadCache } from "../src/db";
import { json, type Env } from "../src/types";
import { canonical, sha } from "../src/security";
import { onSettingsSave, registerAdminExtension } from "../src/modules/api";
import { moduleStates } from "../src/modules/registry";
import { settingsRevision } from "../src/service";
import {
  applyAreaTemplate, areaTemplates, areaTemplatesExtension, exportAreaTemplate,
  previewAreaTemplate, validateAreaSetup, validateAreaTemplate,
} from "../src/area-templates";
import type { AreaTemplate, AreaTemplateSelection } from "../src/area-templates";
import type { CustomWorkType } from "../src/modules/os/contracts";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import { bearer, fixture } from "./service-center-fixture";
import { motorWorkType, MOTOR_SENTINEL } from "./os-motor-fixture";

// Integração local ao isolado: produção continua dependendo do registro por I.
registerAdminExtension(areaTemplatesExtension);
onSettingsSave("os", "os_area_setup", validateAreaSetup);

const selection = (extra: Partial<AreaTemplateSelection> = {}): AreaTemplateSelection => ({
  work_type_ids: ["projeto", "service_order"], module_ids: ["os"], menus: true,
  departments: true, ticket_categories: true, vocabulary: true, texts: true,
  bot_suggestions: true, ...extra,
});
function manifest(): AreaTemplate {
  return {
    schema_version: 1, id: "teste", version: 1, name: "Modelo de teste", description: "Configuração declarativa.",
    work_types: [motorWorkType()], modules: { os: true },
    vocabulary: { collection_label: "Projetos", customer_singular: "Solicitante", customer_plural: "Solicitantes" },
    departments: [{ id: "equipe", name: "Equipe", members: [], enabled: true }],
    ticket_categories: [{ id: "prazo", name: "Prazo", enabled: true }],
    menus: [
      { id: "abrir", label: "Abrir projeto", type: "os_open", type_id: "projeto" },
      { id: "legado", label: "Abrir OS", type: "os_open", type_id: "service_order" },
      { id: "humano", label: "Equipe", type: "human", department_id: "equipe" },
      { id: "aviso", label: "Informações", type: "message", content: "Consulte nossa equipe." },
    ],
    texts: { instructions: "Orientação inicial", menu_greeting: "Boas-vindas" },
    bot: { instructions: "Consultar somente o titular.", allowed_operations: ["os.create"], denied_operations: ["os.private-fields"], suggested_roles: ["os:technician"] },
    manual_steps: ["Conferir acesso da equipe."],
  };
}
const request = () => ({ manifest: manifest(), selection: selection() });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cfg = async (f: Fixture) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings);
const application = (f: Fixture, id = "teste") => one(env, "SELECT * FROM os_area_template_applications WHERE profile_id=? AND template_id=?", f.profile, id);
const save = (f: Fixture, settings: any) => exec(env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(settings), f.profile);
async function apply(f: Fixture, input = request()) {
  const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
  expect(preview.conflicts).toEqual([]);
  return applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
}
async function snapshot(f: Fixture) {
  return {
    settings: (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings,
    modules: await all(env, "SELECT * FROM profile_modules WHERE profile_id=? ORDER BY module_id", f.profile),
    applications: await all(env, "SELECT * FROM os_area_template_applications WHERE profile_id=?", f.profile),
    events: await all(env, "SELECT * FROM events WHERE profile_id=?", f.profile),
  };
}

describe("modelos de área: manifesto", () => {
  it("valida Assistência técnica sem copiar o embutido e sem conceder papéis", () => {
    const model = validateAreaTemplate(assistenciaTecnicaTemplate);
    expect(model.work_types.map((type) => type.id)).toEqual(["at_eletronicos", "at_eletrodomesticos", "at_veiculos", "at_roupas"]);
    expect(model.menus.some((menu) => "type_id" in menu && menu.type_id === "service_order")).toBe(true);
    expect(model.departments.every((department) => department.members.length === 0)).toBe(true);
    expect(model.manual_steps.join(" ")).toContain("manualmente");
    expect(areaTemplates).toContain(assistenciaTecnicaTemplate);
  });

  it("normaliza textos sem alterar o objeto recebido e limita bytes UTF-8", () => {
    const source = manifest(); source.name = "  Projeto  ";
    expect(validateAreaTemplate(source).name).toBe("Projeto");
    expect(source.name).toBe("  Projeto  ");
    expect(() => validateAreaTemplate({ ...source, description: "á".repeat(65536) })).toThrowError(expect.objectContaining({ status: 413, code: "template_too_large" }));
  });

  it.each([
    (m: any) => { m.code = "executar"; },
    (m: any) => { m.departments[0].members = ["pessoa"]; },
    (m: any) => { m.modules.desconhecido = true; },
    (m: any) => { m.menus[0].type_id = "inexistente"; },
    (m: any) => { m.menus[2].department_id = "outro"; },
    (m: any) => { m.work_types[0].id = "service_order"; },
    (m: any) => { m.work_types[0].fields[0].id = "constructor"; },
    (m: any) => { m.work_types[0].fields[1].required = true; },
    (m: any) => { m.work_types[0].fields[1].client_visible = true; },
    (m: any) => { m.work_types[0].stages[0].message = "{campo_segredo}"; },
    (m: any) => { m.work_types[0].stages[0].message = "{desconhecido}"; },
    (m: any) => { m.work_types[0].stages.push({ id: "isolada", label: "Isolada", base_status: "analyzing", message: "" }); },
    (m: any) => { m.work_types[0].transitions[0].from = "entregue"; },
    (m: any) => { m.work_types[0].transitions = []; },
    (m: any) => { m.work_types[0].fields[0].kind = "expression"; },
    (m: any) => { m.work_types[0].stages[0].message = "<script>alert(1)</script>"; },
    (m: any) => { m.work_types[0].retired_field_ids = ["referencia"]; },
    (m: any) => { m.work_types[0].revision = 2; },
    (m: any) => { m.work_types[0].stages[0].unknown = true; },
    (m: any) => { m.menus.push(m.menus[0]); },
    (m: any) => { m.work_types[0].fields[0].max_length = NaN; },
    (m: any) => { m.toJSON = () => manifest(); },
    (m: any) => { m.work_types[0].id = "a".repeat(64); },
    (m: any) => { m.work_types[0].stages[0].message = "javascript:alert(1)"; },
  ])("recusa esquema, referências, código e grafos inválidos (%#)", (mutate) => {
    const model = manifest(); mutate(model);
    expect(() => validateAreaTemplate(model)).toThrowError(expect.objectContaining({ code: "invalid_template" }));
  });

  it("valida sugestões salvas e recusa membros ou permissões fora do contrato", () => {
    const setup = { template_id: "teste", bot: manifest().bot, manual_steps: ["Revisar"] };
    expect(validateAreaSetup([setup])).toEqual([setup]);
    expect(() => validateAreaSetup([setup, setup])).toThrow();
    expect(() => validateAreaSetup([{ ...setup, grants: ["admin"] }])).toThrow();
  });
});

describe("modelos de área: prévia e confirmação", () => {
  it("prévia não escreve; confirma configuração, módulos e procedência com os desligado", async () => {
    const f = await fixture(), input = request();
    await save(f, { ...(await cfg(f)), service_orders: { warranty_days: 12 } });
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(await snapshot(f)).toEqual(before);
    expect(preview.can_apply).toBe(true);
    const result = await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash });
    expect(result.applied).toBe(true);
    const settings = await cfg(f);
    expect(settings.os_work_types[0].id).toBe("area_teste__projeto");
    expect(settings.os_work_types[0].fields).toEqual(input.manifest.work_types[0].fields);
    expect(settings.os_work_types[0].stages).toEqual(input.manifest.work_types[0].stages);
    expect(settings.service_orders).toEqual({ warranty_days: 12 });
    expect(settings.menus.find((m: any) => m.id === "area_teste__abrir").type_id).toBe("area_teste__projeto");
    expect(settings.menus.find((m: any) => m.id === "area_teste__legado").type_id).toBe("service_order");
    expect(settings.menus.find((m: any) => m.id === "area_teste__humano").department_id).toBe("area_teste__equipe");
    expect(settings.menus.find((m: any) => m.id === "area_teste__aviso").type).toBe("content");
    expect(settings.os_area_setup).toEqual([{ template_id: "teste", bot: input.manifest.bot, manual_steps: input.manifest.manual_steps }]);
    expect((await moduleStates(env, f.profile)).os).toBe(true);
    expect(result.settings_revision).toBe(await settingsRevision(env, f.profile));
    expect(await application(f)).toMatchObject({ profile_id: f.profile, template_version: 1, applied_by: f.admin.id });
    const users = await all(env, "SELECT role FROM users WHERE id IN (?,?,?)", f.admin.id, f.member.id, f.other.id);
    expect(users.filter((user) => user.role === "admin")).toHaveLength(1);
  });

  it("aplica o modelo pronto com apenas o embutido e com todos os tipos opcionais", async () => {
    for (const work of [["service_order"], ["service_order", ...assistenciaTecnicaTemplate.work_types.map((t) => t.id)]]) {
      const f = await fixture();
      const input = { manifest: assistenciaTecnicaTemplate, selection: selection({ work_type_ids: work, module_ids: Object.keys(assistenciaTecnicaTemplate.modules) as AreaTemplateSelection["module_ids"] }) };
      await apply(f, input);
      expect((await cfg(f)).os_work_types?.length || 0).toBe(work.length - 1);
      expect((await cfg(f)).service_orders).toBeUndefined();
    }
  });

  it("hash canônico aceita ordem de propriedades/seleção e inclui a área", async () => {
    const f = await fixture(), other = await fixture(), input = request();
    const first = await previewAreaTemplate(env, f.admin, f.profile, input);
    const reordered = { selection: { ...input.selection, work_type_ids: [...input.selection.work_type_ids].reverse() }, manifest: { ...Object.fromEntries(Object.entries(input.manifest).reverse()), texts: Object.fromEntries(Object.entries(input.manifest.texts).reverse()) } };
    expect((await previewAreaTemplate(env, f.admin, f.profile, reordered)).preview_hash).toBe(first.preview_hash);
    expect((await previewAreaTemplate(env, other.admin, other.profile, input)).preview_hash).not.toBe(first.preview_hash);
  });

  it.each(["settings", "modules", "provenance", "manifest", "selection"])("recusa prévia antiga depois de alterar %s", async (part) => {
    const f = await fixture(), input = request();
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    if (part === "settings") await save(f, { ...(await cfg(f)), hidden_manual_value: "mudou" });
    if (part === "modules") await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?, 'forms', 1, 1, ?)", f.profile, f.admin.id);
    if (part === "provenance") await exec(env, "INSERT INTO os_area_template_applications(profile_id,template_id,template_version,manifest_hash,applied_by,applied_at) VALUES(?, 'teste', 1, ?, ?, 1)", f.profile, await sha(canonical(validateAreaTemplate(input.manifest))), f.admin.id);
    if (part === "manifest") input.manifest.name = "Outro nome";
    if (part === "selection") input.selection.texts = false;
    const before = await snapshot(f);
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash })).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(await snapshot(f)).toEqual(before);
  });

  it("relê configuração mesmo recebendo um env com cache aquecido", async () => {
    const f = await fixture(), cached = withReadCache(env), input = request();
    const preview = await previewAreaTemplate(cached, f.admin, f.profile, input);
    await save(f, { ...(await cfg(f)), instructions: "Edição concorrente" });
    await expect(applyAreaTemplate(cached, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash })).rejects.toMatchObject({ code: "preview_stale" });
  });

  it("falha no lote D1 não deixa configuração, módulo, procedência ou evento parcial", async () => {
    const f = await fixture(), input = request();
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    const before = await snapshot(f);
    let calls = 0;
    const broken = { ...env, DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") return (statements: D1PreparedStatement[]) => {
          calls++;
          // Violação real de CHECK dentro do MESMO lote, após as escritas legítimas.
          return target.batch([...statements, target.prepare("INSERT INTO os_area_template_applications(profile_id,template_id,template_version,manifest_hash,applied_by,applied_at) VALUES(?, 'falha', 0, 'hash', 'ator', 1)").bind(f.profile)]);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) } as Env;
    await expect(applyAreaTemplate(broken, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await snapshot(f)).toEqual(before);
    expect((await apply(f, input)).applied).toBe(true);
  });

  it("informa dependência desligada sem cascata e recusa confirmar", async () => {
    const f = await fixture(), input = request();
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?, 'erp', 1, 1, ?)", f.profile, f.admin.id);
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?, 'erp-fiscal', 1, 1, ?)", f.profile, f.admin.id);
    input.manifest.modules.erp = false; input.selection.module_ids.push("erp");
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(false);
    expect(preview.conflicts.some((c) => c.code === "dependency_conflict")).toBe(true);
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash })).rejects.toMatchObject({ code: "dependency_conflict" });
    expect(await snapshot(f)).toEqual(before);
  });

  it("recusa prefixo ocupado inclusive por menu oculto não selecionado", async () => {
    const f = await fixture(), input = request();
    await save(f, { ...(await cfg(f)), menus: [{ id: "area_teste__manual", label: "Manual", type: "os_track" }] });
    input.selection.menus = false;
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ code: "prefix_conflict", path: "menus.area_teste__manual" }));
    await expect(applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash })).rejects.toMatchObject({ code: "template_conflict" });
  });

  it("respeita o limite agregado de tipos, incluindo arquivados", async () => {
    const f = await fixture(), input = request();
    await save(f, { ...(await cfg(f)), os_work_types: Array.from({ length: 20 }, (_, i) => ({ ...motorWorkType(), id: `manual_${i}`, archived: true })) });
    const before = await snapshot(f);
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(false);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ path: "os_work_types", code: "collection_limit" }));
    expect(await snapshot(f)).toEqual(before);
  });

  it("não acrescenta menu humano se o setor foi deixado fora da seleção", async () => {
    const f = await fixture(), input = request(); input.selection.departments = false;
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(false);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ path: "menus.area_teste__humano", code: "reference_conflict" }));
    expect(await application(f)).toBeNull();
  });
});

describe("modelos de área: preservação e reaplicação", () => {
  const vehicleSelection = () => selection({
    work_type_ids: ["at_veiculos"], module_ids: ["os"], menus: false,
    departments: false, ticket_categories: false, vocabulary: false, texts: false, bot_suggestions: false,
  });

  it("avisa oficina equivalente antes de aplicar e conserva os dois modelos separados", async () => {
    const f = await fixture();
    await apply(f, { manifest: assistenciaTecnicaTemplate, selection: vehicleSelection() });
    const original = (await cfg(f)).os_work_types[0];
    const input = { manifest: oficinaMecanicaTemplate, selection: vehicleSelection() };
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(true);
    expect(preview.conflicts).toEqual([]);
    expect(preview.changes).toContainEqual(expect.objectContaining({
      path: "os_work_types.area_oficina_mecanica__at_veiculos", action: "add",
      reason: expect.stringContaining("Já existe um modelo equivalente"),
    }));
    await apply(f, input);
    const types = (await cfg(f)).os_work_types;
    expect(types).toHaveLength(2);
    expect(types.find((type: CustomWorkType) => type.id === original.id)).toEqual(original);
    expect(types.map((type: CustomWorkType) => type.id)).toEqual([
      "area_assistencia_tecnica__at_veiculos", "area_oficina_mecanica__at_veiculos",
    ]);
  });

  it("reaplicar oficina atualizada não acrescenta campos nem desclassifica a placa existente", async () => {
    const f = await fixture();
    const previous = structuredClone(assistenciaTecnicaTemplate);
    previous.version = 2;
    const vehicle = previous.work_types.find((type) => type.id === "at_veiculos")!;
    vehicle.fields = vehicle.fields.filter((field) => !["marca_modelo", "ano", "cor", "ultima_manutencao"].includes(field.id));
    const plate = vehicle.fields.find((field) => field.id === "placa")!;
    plate.client_visible = false;
    plate.sensitive = true;
    await apply(f, { manifest: previous, selection: vehicleSelection() });
    const original = (await cfg(f)).os_work_types;
    await apply(f, { manifest: assistenciaTecnicaTemplate, selection: vehicleSelection() });
    expect((await cfg(f)).os_work_types).toEqual(original);
    expect((await application(f, "assistencia_tecnica"))!.template_version).toBe(3);
  });

  it("segunda aplicação idêntica não grava nem publica eventos", async () => {
    const f = await fixture(); await apply(f);
    const before = await snapshot(f);
    expect((await apply(f)).applied).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });

  it("preserva listas manuais e escalares preenchidos", async () => {
    const f = await fixture();
    const settings = await cfg(f);
    settings.instructions = "Instrução manual";
    settings.os_vocabulary = { collection_label: "Equipe", customer_singular: "Titular", customer_plural: "Titulares" };
    settings.menus = [{ id: "manual", label: "Menu manual", type: "content", content: "Manual", enabled: false }];
    settings.departments = [{ id: "manual", name: "Setor manual", members: [f.member.id], enabled: true }];
    settings.ticket_categories = [{ id: "manual", name: "Categoria manual", enabled: true }];
    await save(f, settings); await apply(f);
    const saved = await cfg(f);
    expect(saved.instructions).toBe(settings.instructions);
    expect(saved.os_vocabulary).toEqual(settings.os_vocabulary);
    expect(saved.menus[0]).toMatchObject(settings.menus[0]);
    expect(saved.departments[0]).toEqual(settings.departments[0]);
    expect(saved.ticket_categories[0]).toEqual(settings.ticket_categories[0]);
  });

  it("não recria itens nem escalares apagados; preserva edição e módulo desligado à mão", async () => {
    const f = await fixture(); await apply(f);
    const settings = await cfg(f);
    settings.menus = settings.menus.filter((m: any) => m.id !== "area_teste__aviso");
    settings.ticket_categories = [];
    settings.os_work_types[0].labels.singular = "Projeto manual";
    settings.os_work_types[0].revision = 2;
    settings.departments[0].name = "Equipe manual";
    delete settings.menu_greeting;
    delete settings.os_vocabulary;
    settings.os_area_setup = [];
    await save(f, settings);
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='os'", f.profile);
    const before = await snapshot(f);
    const input = request();
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.can_apply).toBe(true);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "menus.area_teste__aviso", action: "skip" }));
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "menu_greeting", action: "skip" }));
    expect((await apply(f)).applied).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });

  it("nova versão acrescenta somente IDs/caminhos inéditos e permite selecionar um bloco depois", async () => {
    const f = await fixture(), input = request();
    input.selection.texts = false;
    await apply(f, input);
    const settings = await cfg(f);
    settings.ticket_categories = [];
    settings.departments[0].name = "Manual";
    await save(f, settings);
    input.manifest.version = 2;
    input.manifest.departments[0].name = "Nome atualizado no modelo";
    input.manifest.ticket_categories.push({ id: "novo", name: "Novo", enabled: true });
    input.selection.texts = true;
    expect((await apply(f, input)).applied).toBe(true);
    const saved = await cfg(f);
    expect(saved.departments[0].name).toBe("Manual");
    expect(saved.ticket_categories.map((c: any) => c.id)).toEqual(["area_teste__novo"]);
    expect(saved.menu_greeting).toBe("Boas-vindas");
    expect((await application(f))!.template_version).toBe(2);
  });

  it("não recria um tipo removido nem os menus já tratados", async () => {
    const f = await fixture(); await apply(f);
    const settings = await cfg(f);
    settings.os_work_types = [];
    settings.menus = settings.menus.filter((m: any) => m.type_id !== "area_teste__projeto");
    await save(f, settings);
    const before = await snapshot(f);
    expect((await apply(f)).applied).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });

  it("recusa alterar conteúdo sem subir versão", async () => {
    const f = await fixture(), input = request(); await apply(f, input);
    input.manifest.description = "Mudança sem versão";
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ code: "template_version_conflict" }));
  });

  it("inclui menus de tipos opcionais somente quando o tipo estiver selecionado", async () => {
    const f = await fixture(), input = request();
    input.selection.work_type_ids = ["service_order"];
    await apply(f, input);
    expect((await cfg(f)).menus.some((m: any) => m.id === "area_teste__abrir")).toBe(false);
    input.selection.work_type_ids.push("projeto");
    await apply(f, input);
    expect((await cfg(f)).menus.some((m: any) => m.id === "area_teste__abrir")).toBe(true);
  });

  it("inclui menus do embutido só quando selecionado, sem consumir IDs ignorados", async () => {
    const f = await fixture(), input = request();
    input.manifest.menus.push({ id: "acompanhar_legado", label: "Acompanhar OS", type: "os_track", type_id: "service_order" });
    input.selection.work_type_ids = ["projeto"];
    const paths = ["menus.area_teste__legado", "menus.area_teste__acompanhar_legado"];
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    for (const path of paths)
      expect(preview.changes).toContainEqual(expect.objectContaining({ path, action: "skip" }));
    await apply(f, input);
    expect((await cfg(f)).menus.some((m: any) => m.type_id === "service_order")).toBe(false);
    expect((await cfg(f)).menus.some((m: any) => m.id === "area_teste__abrir")).toBe(true);
    const seen = json((await application(f))!.seen_ids_json, []);
    for (const path of paths) expect(seen).not.toContain(path);

    input.selection.work_type_ids.push("service_order");
    await apply(f, input);
    expect((await cfg(f)).menus.filter((m: any) => m.type_id === "service_order")).toHaveLength(2);
    input.selection.work_type_ids = ["projeto"];
    const before = await snapshot(f);
    expect((await apply(f, input)).applied).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });

  it("permite menus informativos com os desligado e nenhum tipo selecionado", async () => {
    const f = await fixture(), input = request();
    input.selection = selection({ work_type_ids: [], module_ids: [] });
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input);
    expect(preview.conflicts).toEqual([]);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "menus.area_teste__legado", action: "skip" }));
    await apply(f, input);
    const settings = await cfg(f);
    expect(settings.menus.some((m: any) => m.type === "os_open" || m.type === "os_track")).toBe(false);
    expect(settings.menus).toContainEqual(expect.objectContaining({ id: "area_teste__aviso", type: "content" }));
    expect((await moduleStates(env, f.profile)).os).toBe(false);
  });
});

describe("modelos de área: exportação, importação e acesso", () => {
  it("exporta apenas definições selecionadas; importa o JSON em outra área", async () => {
    const f = await fixture(); await apply(f);
    const settings = await cfg(f);
    settings.instructions = MOTOR_SENTINEL;
    settings.departments[0].members = [f.member.id];
    settings.attendant_bot = MOTOR_SENTINEL;
    settings.os_area_setup[0].bot.instructions = MOTOR_SENTINEL;
    await save(f, settings);
    const exported = await exportAreaTemplate(env, f.admin, f.profile, { id: "exportado", name: "Exportado", type_ids: ["area_teste__projeto", "service_order"] });
    const serialized = JSON.stringify(exported);
    for (const secret of [MOTOR_SENTINEL, f.profile, f.member.id, f.line]) expect(serialized).not.toContain(secret);
    expect(exported.departments).toEqual([]);
    expect(exported.work_types[0].fields).toEqual(manifest().work_types[0].fields);
    expect(exported.work_types[0].id).toBe("tipo_1");
    expect(exported.work_types[0].revision).toBe(1);
    const other = await fixture();
    const imported = { manifest: JSON.parse(serialized), selection: selection({ work_type_ids: ["tipo_1", "service_order"] }) };
    await apply(other, imported);
    expect((await cfg(other)).os_work_types[0].id).toBe("area_exportado__tipo_1");
    expect(await application(other, "teste")).toBeNull();
    await expect(exportAreaTemplate(env, other.admin, other.profile, { id: "vazio", name: "Vazio", type_ids: ["area_teste__projeto"] })).rejects.toMatchObject({ code: "type_not_found" });
  });

  it("recusa entradas de exportação inválidas e fonte ambígua", async () => {
    const f = await fixture();
    await expect(exportAreaTemplate(env, f.admin, f.profile, { id: "teste", name: "Teste", type_ids: ["service_order", "service_order"] })).rejects.toMatchObject({ code: "invalid_export" });
    await expect(previewAreaTemplate(env, f.admin, f.profile, { ...request(), template_id: "teste" })).rejects.toMatchObject({ code: "invalid_template" });
    await expect(previewAreaTemplate(env, f.admin, f.profile, { ...request(), selection: selection({ work_type_ids: ["ausente"] }) })).rejects.toMatchObject({ code: "invalid_template" });
  });

  it("descritor publica catálogo administrativo com os desligado e recusa operador", async () => {
    const f = await fixture(), token = await bearer(f.admin), member = await bearer(f.member);
    const root = `/profiles/${f.profile}/area-templates`;
    // SELF usa outro isolado e não vê registros locais; exercitar a entrada real aqui.
    const worker = (await import("../src/index")).default;
    const get = async (auth: string, path: string) => {
      const context = createExecutionContext();
      const response = await worker.fetch(new Request(`https://test/api/v1${path}`, { headers: { Authorization: `Bearer ${auth}` } }), env, context);
      await waitOnExecutionContext(context);
      return response;
    };
    expect((await moduleStates(env, f.profile)).os).toBe(false);
    const catalog = await get(token, root);
    expect(catalog.status).toBe(200);
    expect((await catalog.json<any>()).data).toContainEqual(expect.objectContaining({ id: "assistencia_tecnica" }));
    const detail = await get(token, `${root}/assistencia_tecnica`);
    expect(detail.status).toBe(200);
    expect((await detail.json<any>()).schema_version).toBe(1);
    expect((await get(member, root)).status).toBe(403);
    expect((await get(token, `${root}/ausente`)).status).toBe(404);
    await expect(previewAreaTemplate(env, f.member, f.profile, request())).rejects.toMatchObject({ status: 403 });
    const handler = areaTemplatesExtension.commands.find((c) => c.op === "area-template.preview")!;
    const body = await handler.handler(env, f.admin, f.profile, { template_id: "assistencia_tecnica", selection: selection({ work_type_ids: ["service_order"], module_ids: ["os"] }) }, "previa");
    expect(body).toMatchObject({ can_apply: true, template_id: "assistencia_tecnica" });
  });
});
