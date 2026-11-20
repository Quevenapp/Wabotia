import type { AdminExtension } from "../modules/api";
import { ApiError } from "../types";
import { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
import { validateAreaTemplate } from "./validation";
import { areaTemplates as sharedAreaTemplates } from "./catalog";
import { previewUndoAreaTemplate, segmentState, setSegmentChoice, undoAreaTemplate } from "./footprint";

export { previewUndoAreaTemplate, segmentState, setSegmentChoice, undoAreaTemplate } from "./footprint";
export type { SegmentState, UndoPreview, UndoReport } from "./footprint";

export { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
export { validateAreaTemplate, validateAreaSetup } from "./validation";
export type { AreaTemplate, AreaTemplateSelection } from "./validation";
export type { AreaTemplatePreview, AreaTemplateApplyResult } from "../modules/os/contracts";

// Servidor e demonstração usam o mesmo catálogo (Engenharia 3 e Festas e eventos).
export const areaTemplates: typeof sharedAreaTemplates = sharedAreaTemplates;

/** Somente I registra este descritor em runtime.ts. Importar não publica rotas. */
// A fábrica evita ler uma constante ainda em inicialização no ciclo
// service → runtime → catálogo → engine → security → service.
export function createAreaTemplatesExtension(): AdminExtension { return {
  id: "area-templates",
  reads: [
    { path: "area-templates", handler: async () => ({ data: areaTemplates.map(({ id, version, name, description }) => ({ id, version, name, description })) }) },
    // "Qual é o seu negócio?" e os modelos aplicados (para desfazer e trocar de ramo).
    { path: "area-templates/segment/state", handler: (env, actor, profile) => segmentState(env, actor, profile, areaTemplates) },
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
    { method: "POST", path: "area-templates/segment/choice", op: "area-template.segment-choice" },
    { method: "POST", path: "area-templates/undo/preview", op: "area-template.undo-preview" },
    { method: "POST", path: "area-templates/undo", op: "area-template.undo" },
  ],
  commands: [
    { op: "area-template.preview", handler: (env, actor, profile, data) => previewAreaTemplate(env, actor, profile, data, areaTemplates) },
    { op: "area-template.apply", handler: (env, actor, profile, data, requestId) => applyAreaTemplate(env, actor, profile, data, areaTemplates, requestId) },
    { op: "area-template.export", handler: (env, actor, profile, data) => exportAreaTemplate(env, actor, profile, data) },
    { op: "area-template.segment-choice", handler: (env, actor, profile, data) => setSegmentChoice(env, actor, profile, data, areaTemplates) },
    { op: "area-template.undo-preview", handler: (env, actor, profile, data) => previewUndoAreaTemplate(env, actor, profile, data, areaTemplates) },
    { op: "area-template.undo", handler: (env, actor, profile, data) => undoAreaTemplate(env, actor, profile, data, areaTemplates) },
  ],
}; }
export const areaTemplatesExtension = createAreaTemplatesExtension();
