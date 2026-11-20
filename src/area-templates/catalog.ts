// Catálogo declarativo compartilhado com a demonstração, sem carregar o motor do servidor.
import type { AreaTemplate } from "./validation";
import { revisedAreaTemplates } from "./revisions";
import { comercioTemplate } from "./models/comercio";
import { locacaoTemplate } from "./models/locacao";
import { consultoriaTemplate } from "./models/consultoria";

// Os modelos existentes saem revisados (revisions.ts); os novos vêm no fim.
export const areaTemplates: readonly AreaTemplate[] = [
  ...revisedAreaTemplates,
  comercioTemplate,
  locacaoTemplate,
  consultoriaTemplate,
];
