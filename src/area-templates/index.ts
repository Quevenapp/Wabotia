import type { AdminExtension } from "../modules/api";
import type { AreaTemplate } from "../modules/os/contracts";
import { ApiError } from "../types";
import { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
import { validateAreaTemplate } from "./validation";
import { assistenciaTecnicaTemplate } from "./models/assistencia-tecnica";
import { servicosTemplate } from "./models/servicos";
import { oficinaMecanicaTemplate } from "./models/oficina-mecanica";
import { lavanderiaCosturaTemplate } from "./models/lavanderia-costura";
import { graficaTemplate, despachanteTemplate, imobiliariaTemplate } from "./models/exemplos";
import { engenheirosTemplate } from "./models/engenheiros";
import { arquitetosTemplate } from "./models/arquitetos";
import { construtorasTemplate } from "./models/construtoras";
import { advogadosTemplate } from "./models/advogados";
import { escritorioAdvocaciaTemplate } from "./models/escritorio-advocacia";
import { clinicaMedicaTemplate } from "./models/clinica-medica";
import { clinicaVeterinariaTemplate } from "./models/clinica-veterinaria";
import { escolasTemplate } from "./models/escolas";
import { professoresTemplate } from "./models/professores";
import { condominiosTemplate } from "./models/condominios";

export { applyAreaTemplate, exportAreaTemplate, previewAreaTemplate } from "./engine";
export { validateAreaTemplate, validateAreaSetup } from "./validation";
export type { AreaTemplate, AreaTemplateSelection, AreaTemplatePreview, AreaTemplateApplyResult } from "../modules/os/contracts";

// Um modelo por linha. Os demais arquivos são entregues por seus próprios donos.
export const areaTemplates: readonly AreaTemplate[] = [
  assistenciaTecnicaTemplate,
  // REGISTRO RESERVADO I — acrescentar aqui uma linha por modelo importado.
  servicosTemplate,
  oficinaMecanicaTemplate,
  lavanderiaCosturaTemplate,
  graficaTemplate,
  despachanteTemplate,
  imobiliariaTemplate,
  engenheirosTemplate,
  arquitetosTemplate,
  construtorasTemplate,
  advogadosTemplate,
  escritorioAdvocaciaTemplate,
  clinicaMedicaTemplate,
  clinicaVeterinariaTemplate,
  escolasTemplate,
  professoresTemplate,
  condominiosTemplate,
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

// IMPORTS RESERVADOS I — imports dos outros seis modelos, sem alterar seus arquivos.
