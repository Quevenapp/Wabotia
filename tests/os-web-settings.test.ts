import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, Field } from "../web/ui";
import { WorkMenus, WorkSettingsPage, workSettingsTab } from "../web/modules/os/WorkSettingsPage";
import { ServiceOrdersSettingsPage } from "../web/modules/os/ServiceOrdersSettingsPage";
import { TemplateExamples, WorkTypesPage } from "../web/modules/os/types/WorkTypesPage";
import { FieldsEditor } from "../web/modules/os/types/FieldsEditor";
import { StagesEditor } from "../web/modules/os/types/StagesEditor";
import { labelIdentifier, newField, newWorkType, renameStage } from "../web/modules/os/types/type-draft";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";

const runtime = vi.hoisted(() => ({
  owner: null as any, app: {} as any, route: {} as any, settings: {} as any,
  templates: [] as any[], menus: [] as any[], navigate: vi.fn(), saveTypes: vi.fn(), reload: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: any) => {
    const owner = runtime.owner, index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (next: any) => { owner.slots[index] = typeof next === "function" ? next(owner.slots[index]) : next; }];
  } };
});
vi.mock("../web/app/AppContext", () => ({ useApp: () => runtime.app }));
vi.mock("../web/app/hooks", () => ({ useUnsavedGuard: vi.fn(), useAction: () => ({ busy: false, run: (fn: () => any) => fn() }) }));
vi.mock("../web/lib/api", async (original) => ({ ...await original<typeof import("../web/lib/api")>(), useIntents: () => runtime.app.api }));
vi.mock("../web/lib/routes", async (original) => ({ ...await original<typeof import("../web/lib/routes")>(), useRoute: () => runtime.route, navigate: runtime.navigate }));
vi.mock("../web/modules/os/work-hooks", () => ({
  ResourceState: () => null,
  useWorkApi: () => ({ saveTypes: runtime.saveTypes }),
  useWorkResource: (key: string) => ({ data: key.endsWith("/type-settings") ? runtime.settings : key.endsWith("/work-menus") ? { data: runtime.menus } : runtime.templates, reload: runtime.reload }),
}));

const instance = () => ({ slots: [] as any[], index: 0 });
function render<T>(owner: ReturnType<typeof instance>, fn: () => T) { owner.index = 0; runtime.owner = owner; return fn(); }
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return React.isValidElement(tree) ? [tree, ...elements((tree.props as any).children)] : [];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return React.isValidElement(tree) ? text((tree.props as any).children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
const component = (tree: any, type: any) => elements(tree).find((node) => node.type === type);
const button = (tree: any, label: string) => elements(tree).find((node) => node.type === Button && text(node) === label);
const field = (tree: any, label: string) => elements(tree).find((node) => node.type === Field && node.props.label === label);
const standard = () => structuredClone(assistenciaTecnicaTemplate.work_types.find((type) => type.id === "at_veiculos")!);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", new URL("https://painel.example/app/erp/modulos/tipos-de-trabalho"));
  runtime.route = { area: "admin", page: "work-types" };
  runtime.settings = { settings: { os_work_types: [] }, settings_revision: "rev1" };
  runtime.templates = [assistenciaTecnicaTemplate];
  runtime.menus = [];
  runtime.app = { root: "v1/profiles/a", settings: runtime.settings.settings, status: { settings_revision: "rev1" }, api: vi.fn(async () => ({ data: [], revision: "menus1" })), refresh: vi.fn(async () => {}) };
  runtime.navigate.mockImplementation((route) => { runtime.route = route; });
  runtime.saveTypes.mockResolvedValue({ settings_revision: "rev2" });
});
afterEach(() => vi.unstubAllGlobals());

describe("Configurar ordens de serviço", () => {
  it("preserva endereços antigos e reúne Modelos, WhatsApp e Prazos e garantia", () => {
    expect(workSettingsTab("work-types")).toBe("modelos");
    expect(workSettingsTab("service-orders-settings")).toBe("whatsapp");
    expect(workSettingsTab("service-orders-settings", "prazos")).toBe("prazos");
    const tree = WorkSettingsPage();
    expect(elements(tree).filter((node) => node.type === "a").map(text)).toEqual(["Modelos", "WhatsApp", "Prazos e garantia"]);
    expect(component(tree, WorkTypesPage)).toBeDefined();
    runtime.route = { page: "service-orders-settings" };
    const whatsapp = WorkSettingsPage();
    expect(component(whatsapp, WorkMenus)).toBeDefined();
    expect(component(whatsapp, ServiceOrdersSettingsPage).props.section).toBe("whatsapp");
    runtime.app.settings.os_work_types = [standard()];
    runtime.route.filters = { tab: "prazos" };
    const deadlines = WorkSettingsPage();
    expect(component(deadlines, ServiceOrdersSettingsPage).props.section).toBe("prazos");
    expect(elements(deadlines).find((node) => node.type === "a" && text(node).endsWith("→ Recursos"))?.props.href).toContain("editor=recursos");
  });

  it("oferece começar do zero ou exemplo, copia só a definição escolhida e abre o editor", () => {
    const owner = instance();
    let tree: any = render(owner, WorkTypesPage);
    button(tree, "Criar modelo").props.onClick();
    tree = render(owner, WorkTypesPage);
    expect(elements(tree).find((node) => node.type === "a" && text(node) === "Começar do zero")).toBeDefined();
    button(tree, "Começar de um exemplo").props.onClick();
    tree = render(owner, WorkTypesPage);
    const source = standard();
    component(tree, TemplateExamples).props.onChoose(source);
    expect(runtime.navigate).toHaveBeenCalledWith({ area: "admin", page: "work-types", typeId: "novo" });
    tree = render(owner, WorkTypesPage);
    expect(tree.props.seed.fields).toEqual(source.fields);
    expect(tree.props.seed.stages).toEqual(source.stages);
    expect(tree.props.seed.id).toBe(labelIdentifier(source.labels.singular, [], 64));
    expect(tree.props.seed).not.toBe(source);
    expect(runtime.saveTypes).not.toHaveBeenCalled();
    expect(runtime.app.api).not.toHaveBeenCalled();
  });

  it("busca exemplos por campos e agrupa pelo modelo de área", () => {
    const owner = instance(), onChoose = vi.fn();
    const draw = () => TemplateExamples({ templates: runtime.templates, onChoose });
    let tree = render(owner, draw);
    field(tree, "Buscar exemplos").props.onChange("quilometragem");
    tree = render(owner, draw);
    expect(text(tree)).toContain("Assistência técnica");
    expect(button(tree, "Serviços de oficina")).toBeDefined();
    button(tree, "Serviços de oficina").props.onClick();
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: "at_veiculos" }));
    field(tree, "Buscar exemplos").props.onChange("inexistente");
    expect(text(render(owner, draw))).toContain("Nenhum exemplo encontrado.");
  });

  it("adiciona só os campos novos do padrão e conserva placa sensível e revisão", async () => {
    const source = standard();
    const old = { ...source, id: "area_assistencia_tecnica__at_veiculos", revision: 3,
      fields: source.fields.filter((field) => !["marca_modelo", "ano", "cor", "ultima_manutencao"].includes(field.id)).map((field) => field.id === "placa" ? { ...field, sensitive: true, client_visible: false } : field) };
    runtime.settings.settings.os_work_types = [old];
    const tree = render(instance(), WorkTypesPage);
    expect(text(tree)).toContain("O modelo padrão ganhou campos: Marca e modelo, Ano, Cor, Última manutenção.");
    expect(text(tree)).toContain("As ordens abertas guardam a definição com que nasceram.");
    await button(tree, "Adicionar").props.onClick();
    const [saved] = runtime.saveTypes.mock.calls[0][0];
    expect(saved.revision).toBe(4);
    expect(saved.fields.slice(0, old.fields.length)).toEqual(old.fields);
    expect(saved.fields.map((field: any) => field.id)).toEqual(expect.arrayContaining(["marca_modelo", "ano", "cor", "ultima_manutencao"]));
    expect(runtime.saveTypes.mock.calls[0][1]).toBe("rev1");
  });

  it("mostra Abrir e Acompanhar de todos os modelos e reativa item desativado sem duplicar", async () => {
    runtime.app.settings.os_work_types = [standard()];
    runtime.menus = [{ id: "open", type: "os_open", enabled: false }];
    runtime.app.api.mockResolvedValue({ data: runtime.menus, revision: "menus1" });
    const tree = WorkMenus();
    expect(text(tree)).toContain("Ordens de serviço");
    expect(text(tree)).toContain("Serviços de oficina");
    expect(elements(tree).filter((node) => node.type === "strong").map(text)).toEqual(["Abrir", "Acompanhar", "Abrir", "Acompanhar"]);
    await button(tree, "Adicionar ao menu").props.onClick();
    expect(runtime.app.api).toHaveBeenCalledWith("v1/profiles/a/settings", "PUT", {
      menus_revision: "menus1", menus: [{ id: "open", type: "os_open", enabled: true }],
    });
  });

  it("não oferece expor placa quando o padrão de origem também a mantém sensível", () => {
    const type = standard();
    type.fields = type.fields.map((field) => field.id === "placa" ? { ...field, sensitive: true, client_visible: false } : field);
    runtime.templates = [{ ...assistenciaTecnicaTemplate, work_types: [type] }];
    runtime.settings.settings.os_work_types = [{ ...type, id: "area_assistencia_tecnica__at_veiculos" }];
    const tree = render(instance(), WorkTypesPage);
    expect(button(tree, "Criar nova Placa visível")).toBeUndefined();
    expect(text(tree)).toContain("Modelo de área: Assistência técnica");
  });

  it("separa mensagens e prazos sem perder os valores configurados", () => {
    runtime.app.settings.service_orders = { warranty_days: 150, texts: { opened: "Recebemos {item}" } };
    const whatsapp = render(instance(), () => ServiceOrdersSettingsPage({ section: "whatsapp" }));
    expect(field(whatsapp, "Ordem aberta").props.value).toBe("Recebemos {item}");
    expect(field(whatsapp, "Garantia (dias após a entrega)")).toBeUndefined();
    const deadlines = render(instance(), () => ServiceOrdersSettingsPage({ section: "prazos" }));
    expect(field(deadlines, "Garantia (dias após a entrega)").props.value).toBe(150);
    expect(field(deadlines, "Ordem aberta")).toBeUndefined();
  });
});

describe("Identificadores avançados do modelo", () => {
  it("gera o ID do campo pelo rótulo e deixa o ID em Avançado recolhido", () => {
    const onChange = vi.fn();
    const tree = FieldsEditor({ fields: [newField()], onChange });
    const advanced = elements(tree).find((node) => node.type === "details");
    expect(advanced.props.open).toBeUndefined();
    expect(field(advanced, "Identificador")).toBeDefined();
    field(tree, "Rótulo").props.onChange("Última manutenção");
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: "ultima_manutencao", label: "Última manutenção" })]);
    const locked = FieldsEditor({ fields: [{ ...newField(), id: "campo_salvo", label: "Anterior" }], locked: ["campo_salvo"], onChange });
    field(locked, "Rótulo").props.onChange("Novo rótulo");
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: "campo_salvo" })]);
    const retired = FieldsEditor({ fields: [newField()], locked: ["cor"], onChange });
    field(retired, "Rótulo").props.onChange("Cor");
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: "cor_2" })]);
  });

  it("gera ID de etapa, mantém referências e não troca identificadores já salvos", () => {
    const original = newWorkType();
    const renamed = renameStage(original, 0, "entrada", "Entrada");
    expect(renamed.initial_stage).toBe("entrada");
    expect(renamed.transitions.every((transition) => transition.from === "entrada")).toBe(true);
    const draft = { ...original, stages: [...original.stages, { id: "", label: "", base_status: "in_progress" as const, message: "" }] };
    const onChange = vi.fn();
    const tree = StagesEditor({ type: draft, onChange });
    elements(tree).filter((node) => node.type === Field && node.props.label === "Nome").at(-1).props.onChange("Em preparação");
    expect(onChange.mock.calls[0][0].stages.at(-1).id).toBe("em_preparacao");
    expect(elements(tree).filter((node) => node.type === "details").every((node) => !node.props.open)).toBe(true);
  });
});
