import type { AreaTemplate, AreaTemplateSelection, AreaModuleId } from "../../modules/os/work-contracts";

/** O modelo traz menus da Ordem de serviço embutida (type_id service_order). */
export const usesBuiltin = (template: Pick<AreaTemplate, "menus">) =>
  template.menus.some(
    (menu) => "type_id" in menu && menu.type_id === "service_order",
  );
export function templateSelection(
  template: Pick<AreaTemplate, "menus" | "work_types" | "modules">,
): AreaTemplateSelection {
  return {
    work_type_ids: [
      ...(usesBuiltin(template) ? ["service_order"] : []),
      ...template.work_types.map((type) => type.id),
    ],
    // Por padrão o modelo só liga módulos. Desligar um módulo já ligado é
    // escolha explícita na revisão. Fiscal permanece disponível para ligar,
    // mas exige seleção explícita enquanto não há emissor.
    module_ids: Object.entries(template.modules)
      .filter(([id, enabled]) => enabled && id !== "erp-fiscal")
      .map(([id]) => id) as AreaModuleId[],
    menus: true,
    departments: true,
    ticket_categories: true,
    vocabulary: true,
    texts: true,
    bot_suggestions: true,
  };
}
