import type { AdminExtension } from "../modules/api";
import { ApiError } from "../types";
import { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
import { validateAreaTemplate } from "./validation";
import { areaTemplates as sharedAreaTemplates } from "./catalog";
import { engenheirosTemplate } from "./models/engenheiros";
import { festasEventosTemplate } from "./models/festas-eventos";

export { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
export { validateAreaTemplate, validateAreaSetup } from "./validation";
export type { AreaTemplate, AreaTemplateSelection } from "./validation";
export type { AreaTemplatePreview, AreaTemplateApplyResult } from "../modules/os/contracts";

// O catálogo compartilhado ainda fixa a versão anterior de Engenharia.
// A composição do servidor usa o manifesto atualizado e inclui Eventos.
export const areaTemplates: typeof sharedAreaTemplates = [
  ...sharedAreaTemplates.map(template => template.id === engenheirosTemplate.id ? engenheirosTemplate : template),
  festasEventosTemplate,
];

/** Somente I registra este descritor em runtime.ts. Importar não publica rotas. */
// A fábrica evita ler uma constante ainda em inicialização no ciclo
// service → runtime → catálogo → engine → security → service.
export function createAreaTemplatesExtension(): AdminExtension { return {
  id: "area-templates",
  reads: [
    { path: "area-templates", handler: async () => ({ data: areaTemplates.map(({ id, version, name, description }) => ({ id, version, name, description })) }) },
    { path: "area-templates/:template_id", handler: async (_env, _actor, _profile, { params }) => {
      const template = areaTemplates.find((entry) => entry.id === params.template_id);
      if (!template) throw new ApiError(404, "template_not_found", "Modelo de área não encontrado.");
      return validateAreaTemplate(template);
    } },
  ],
  writes: [
    { method: "POST", path: "area-templates/preview", op: "area-template.preview" },
    { method: "POST", path: "area-templates/apply", op: "area-template.apply" },
    { method: "POST", path: "area-templates/export", op: "area-template.export" },
  ],
  commands: [
    { op: "area-template.preview", handler: (env, actor, profile, data) => previewAreaTemplate(env, actor, profile, data, areaTemplates) },
    { op: "area-template.apply", handler: (env, actor, profile, data, requestId) => applyAreaTemplate(env, actor, profile, data, areaTemplates, requestId) },
    { op: "area-template.export", handler: (env, actor, profile, data) => exportAreaTemplate(env, actor, profile, data) },
  ],
}; }
export const areaTemplatesExtension = createAreaTemplatesExtension();
