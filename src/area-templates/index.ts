import type { AdminExtension } from "../modules/api";
import type { AreaTemplate } from "../modules/os/contracts";
import { ApiError } from "../types";
import { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
import { validateAreaTemplate } from "./validation";
import { assistenciaTecnicaTemplate } from "./models/assistencia-tecnica";

export { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
export { validateAreaTemplate, validateAreaSetup } from "./validation";
export type { AreaTemplate, AreaTemplateSelection, AreaTemplatePreview, AreaTemplateApplyResult } from "../modules/os/contracts";

// Um modelo por linha. Os demais arquivos são entregues por seus próprios donos.
export const areaTemplates: readonly AreaTemplate[] = [
  assistenciaTecnicaTemplate,
  // REGISTRO RESERVADO I — acrescentar aqui uma linha por modelo importado.
  // servicosTemplate,
  // obrasTemplate,
  // juridicoTemplate,
  // saudeTemplate,
  // ensinoTemplate,
  // condominioTemplate,
];

/** Somente I registra este descritor em runtime.ts. Importar não publica rotas. */
export const areaTemplatesExtension: AdminExtension = {
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
    { op: "area-template.apply", handler: (env, actor, profile, data) => applyAreaTemplate(env, actor, profile, data, areaTemplates) },
    { op: "area-template.export", handler: (env, actor, profile, data) => exportAreaTemplate(env, actor, profile, data) },
  ],
};

// IMPORTS RESERVADOS I — imports dos outros seis modelos, sem alterar seus arquivos.
