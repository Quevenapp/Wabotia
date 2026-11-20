import { describe, expect, it } from "vitest";
import { areaTemplates } from "../src/area-templates/catalog";
import { reviseTemplate, templateRevisions } from "../src/area-templates/revisions";
import { isModuleMenuType, moduleOfMenuType, validateAreaTemplate, type AreaTemplate } from "../src/area-templates/validation";
import { moduleById } from "../src/modules/registry";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { servicosTemplate } from "../src/area-templates/models/servicos";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import { lavanderiaCosturaTemplate } from "../src/area-templates/models/lavanderia-costura";
import { graficaTemplate, despachanteTemplate, imobiliariaTemplate } from "../src/area-templates/models/exemplos";
import { engenheirosTemplate } from "../src/area-templates/models/engenheiros";
import { arquitetosTemplate } from "../src/area-templates/models/arquitetos";
import { construtorasTemplate } from "../src/area-templates/models/construtoras";
import { advogadosTemplate } from "../src/area-templates/models/advogados";
import { escritorioAdvocaciaTemplate } from "../src/area-templates/models/escritorio-advocacia";
import { clinicaMedicaTemplate } from "../src/area-templates/models/clinica-medica";
import { clinicaVeterinariaTemplate } from "../src/area-templates/models/clinica-veterinaria";
import { escolasTemplate } from "../src/area-templates/models/escolas";
import { professoresTemplate } from "../src/area-templates/models/professores";
import { condominiosTemplate } from "../src/area-templates/models/condominios";
import { restauranteTemplate } from "../src/area-templates/models/restaurante";
import { festasEventosTemplate } from "../src/area-templates/models/festas-eventos";

const bases: AreaTemplate[] = [
  assistenciaTecnicaTemplate, servicosTemplate, oficinaMecanicaTemplate, lavanderiaCosturaTemplate,
  graficaTemplate, despachanteTemplate, imobiliariaTemplate, engenheirosTemplate, arquitetosTemplate,
  construtorasTemplate, advogadosTemplate, escritorioAdvocaciaTemplate, clinicaMedicaTemplate,
  clinicaVeterinariaTemplate, escolasTemplate, professoresTemplate, condominiosTemplate,
  restauranteTemplate, festasEventosTemplate,
];
// Versões publicadas antes da revisão, quando o catálogo sobrescrevia o arquivo.
const published: Record<string, number> = { advogados: 2, escritorio_advocacia: 2 };
const baseVersion = (base: AreaTemplate) => published[base.id] ?? base.version;

/** Módulos que cada ramo precisa ligar (o especializado vem primeiro). */
const expected: Record<string, string[]> = {
  assistencia_tecnica: ["os", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"],
  servicos: ["os", "agenda", "mensalidade", "erp", "erp-financeiro"],
  oficina_mecanica: ["os", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"],
  lavanderia_costura: ["os", "erp", "erp-financeiro"],
  grafica: ["os", "erp", "erp-financeiro"],
  despachante: ["os", "agenda", "erp", "erp-financeiro"],
  imobiliaria: ["os", "agenda", "erp", "erp-financeiro"],
  engenharia: ["os", "agenda", "erp", "erp-financeiro"],
  arquitetura: ["os", "agenda", "erp", "erp-financeiro"],
  construtora: ["os", "agenda", "erp", "erp-financeiro"],
  advogados: ["juridico", "agenda", "mensalidade", "erp", "erp-financeiro"],
  escritorio_advocacia: ["juridico", "agenda", "mensalidade", "erp", "erp-financeiro"],
  clinica_medica: ["saude", "agenda", "erp", "erp-financeiro"],
  clinica_veterinaria: ["saude", "agenda", "erp", "erp-financeiro"],
  escolas: ["ensino", "agenda", "mensalidade", "erp", "erp-financeiro"],
  professores: ["ensino", "agenda", "mensalidade"],
  condominios: ["condominio", "reserva", "mensalidade", "erp", "erp-financeiro"],
  restaurante: ["pedido", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"],
  festas_eventos: ["os", "erp", "erp-financeiro"],
  comercio: ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "erp-pdv"],
  locacao: ["os", "reserva", "mensalidade", "erp", "erp-financeiro"],
  consultoria: ["agenda", "os", "mensalidade", "erp", "erp-financeiro"],
};
const enabled = (model: AreaTemplate) => Object.keys(model.modules).filter((id) => model.modules[id]);

describe("modelos de área por segmento", () => {
  it("catálogo com ids únicos: existentes na mesma ordem e os três novos no fim", () => {
    const ids = areaTemplates.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...bases.map((base) => base.id), "comercio", "locacao", "consultoria"]);
  });

  it.each(areaTemplates.map((model) => [model.id, model] as const))("%s passa em validateAreaTemplate", (_id, model) => {
    const valid = validateAreaTemplate(model);
    expect(valid.id).toBe(model.id);
    for (const id of enabled(valid)) for (const required of moduleById(id)!.requires || [])
      expect(valid.modules[required], `${id} exige ${required}`).toBe(true);
  });

  it.each(Object.entries(expected))("%s liga os módulos do ramo", (id, modules) => {
    const model = areaTemplates.find((entry) => entry.id === id)!;
    expect(model).toBeDefined();
    for (const module of modules) expect(model.modules[module], module).toBe(true);
  });

  it("nenhum menu de módulo aparece com o módulo desligado", () => {
    for (const model of areaTemplates) for (const menu of model.menus) if (isModuleMenuType(menu.type))
      expect(model.modules[moduleOfMenuType(menu.type)!], `${model.id}.${menu.id}`).toBe(true);
  });

  it("com a Agenda ligada, agendar usa o menu real da Agenda", () => {
    for (const model of areaTemplates.filter((entry) => entry.modules.agenda)) for (const menu of model.menus)
      if (menu.type === "human" || menu.type === "message")
        expect(menu.label, `${model.id}.${menu.id}`).not.toMatch(/agend/i);
    const advocacia = areaTemplates.find((model) => model.id === "advogados")!;
    expect(advocacia.menus.find((menu) => menu.id === "advocacia_agendar")?.type).toBe("agenda");
    expect(advocacia.menus.find((menu) => menu.id === "advocacia_mensalidades")?.type).toBe("mensalidade_list");
  });

  it("os três novos existem com os módulos pedidos", () => {
    const find = (id: string) => areaTemplates.find((model) => model.id === id)!;
    const comercio = find("comercio"), locacao = find("locacao"), consultoria = find("consultoria");
    for (const model of [comercio, locacao, consultoria]) {
      expect(model.version).toBe(1);
      expect(model.schema_version).toBe(1);
      expect(model.bot.allowed_operations).toEqual([]);
      expect(model.bot.suggested_roles).toEqual([]);
      expect(model.departments.every((department) => department.members.length === 0)).toBe(true);
    }
    expect(enabled(comercio).sort()).toEqual(expected.comercio.slice().sort());
    expect(comercio.modules.os).toBeUndefined();
    expect(comercio.work_types).toEqual([]);
    expect(comercio.menus.every((menu) => menu.type === "human")).toBe(true);
    expect(comercio.menus.map((menu) => menu.label)).toEqual(expect.arrayContaining(["Falar com um vendedor"]));
    expect(enabled(locacao).sort()).toEqual(expected.locacao.slice().sort());
    expect(locacao.work_types[0].object_type_id).toBe("bem_locado");
    expect(locacao.object_types?.map((type) => type.id)).toEqual(["bem_locado"]);
    expect(locacao.menus.map((menu) => menu.type)).toEqual(["os_open", "os_track", "reserva", "reserva_mine", "mensalidade_list", "human"]);
    expect(enabled(consultoria).sort()).toEqual(expected.consultoria.slice().sort());
    expect(consultoria.work_types[0].object_type_id).toBeUndefined();
    expect(consultoria.object_types).toBeUndefined();
    expect(consultoria.menus.map((menu) => menu.type)).toEqual(expect.arrayContaining(["agenda", "agenda_mine", "os_track", "mensalidade_list", "human"]));
  });

  it("versões revisadas superam as dos arquivos base, que permanecem intactos", () => {
    for (const base of bases) {
      const model = areaTemplates.find((entry) => entry.id === base.id)!;
      if (templateRevisions[base.id]) expect(model.version, base.id).toBe(baseVersion(base) + 1);
      else expect(model, base.id).toBe(base);
      expect(model.version).toBeGreaterThanOrEqual(base.version);
    }
    expect(advogadosTemplate.modules.agenda).toBe(false);
    expect(condominiosTemplate.modules).not.toHaveProperty("condominio");
  });

  it("reviseTemplate é pura e recusa referências inexistentes", () => {
    const before = structuredClone(servicosTemplate);
    const next = reviseTemplate(servicosTemplate, { enable_modules: ["erp"], remove_menus: ["pagamento"], add_menus: [{ id: "extra", label: "Extra", type: "agenda" }] });
    expect(servicosTemplate).toEqual(before);
    expect(next.version).toBe(servicosTemplate.version + 1);
    expect(next.modules.erp).toBe(true);
    expect(next.menus.map((menu) => menu.id)).toEqual(["pedir", "acompanhar", "horarios", "equipe", "extra"]);
    expect(() => reviseTemplate(servicosTemplate, { remove_menus: ["inexistente"] })).toThrow();
    expect(() => reviseTemplate(servicosTemplate, { replace_manual_steps: [{ starts_with: "Texto ausente", with: null }] })).toThrow();
  });
});
