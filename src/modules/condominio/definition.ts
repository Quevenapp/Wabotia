import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
import type { ModuleDefinition } from "../types";

export const condominioModule: ModuleDefinition = {
  id: "condominio",
  name: "Condomínio",
  version: "1.0.0",
  builtin: true,
  description:
    "Unidades, moradores, portaria, comunicados e assembleias com voto por unidade.",
  default_enabled: false,
  requires: ["os"],
  management: NATIVE_MANAGEMENT_ITEMS.condominio,
  navigation: [
    { id: "condominio", label: "Condomínio", place: "admin", admin: false },
  ],
  menu_item_types: [
    {
      type: "cond_unit",
      label: "Minha unidade",
      description: "Abre acesso temporário às unidades do telefone verificado.",
    },
  ],
  grants: [
    {
      id: "admin",
      label: "Administração do condomínio",
      description:
        "Cadastro, comunicados e revisão financeira para habilitação eleitoral.",
    },
    {
      id: "portaria",
      label: "Portaria",
      description:
        "Nome, unidade, telefone e operação de encomendas e visitantes.",
    },
    {
      id: "mesa",
      label: "Mesa da assembleia",
      description:
        "Convocação, pauta, presença, representação, apuração e ata.",
    },
  ],
  routes: ["condominio"],
  operations: ["condominio."],
  scopes: [],
  settings: [],
  events: [],
  // Fora do catálogo comum e das ferramentas de cliente. Cada operação vem de
  // bot-grants.ts e só chega ao bot que o administrador liberou, com aviso
  // (src/bot-actions/area.ts); voto do morador continua só pelo QR dele.
  bot: { deny: ["condominio/", "condominio."], sensitive: ["condominio."] },
};
