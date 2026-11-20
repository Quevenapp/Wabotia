// Catálogo declarativo compartilhado com a demonstração, sem carregar o motor do servidor.
import type { AreaTemplate } from "../modules/os/contracts";
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
import { restauranteTemplate } from "./models/restaurante";
import { festasEventosTemplate } from "./models/festas-eventos";

export const areaTemplates: readonly AreaTemplate[] = [
  assistenciaTecnicaTemplate,
  servicosTemplate,
  oficinaMecanicaTemplate,
  lavanderiaCosturaTemplate,
  graficaTemplate,
  despachanteTemplate,
  imobiliariaTemplate,
  // A parte 2 publicou Engenharia 3 (objeto Imóvel); o manifesto já traz a versão.
  engenheirosTemplate,
  arquitetosTemplate,
  construtorasTemplate,
  { ...advogadosTemplate, version: 2 },
  { ...escritorioAdvocaciaTemplate, version: 2 },
  clinicaMedicaTemplate,
  clinicaVeterinariaTemplate,
  escolasTemplate,
  professoresTemplate,
  condominiosTemplate,
  restauranteTemplate,
  festasEventosTemplate,
];
