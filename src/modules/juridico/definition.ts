import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
import type { ModuleDefinition } from "../types";

export const juridicoModule: ModuleDefinition = {
  id: "juridico", name: "Jurídico", version: "1.0.0", builtin: true,
  description: "Calendários forenses e prazos com memória de cálculo e conferência do advogado.",
  default_enabled: false, requires: ["os"],
  management: NATIVE_MANAGEMENT_ITEMS.juridico,
  navigation: [{ id: "juridico", label: "Prazos", place: "admin", admin: false }],
  menu_item_types: [], settings: [], events: [],
  routes: ["juridico"], operations: ["juridico."],
  scopes: ["conversations:read", "conversations:write"],
  grants: [
    { id: "lawyer", label: "Advogado", description: "Calcula, confere e cumpre prazos da área. Exige também os:sensitive." },
    { id: "curator", label: "Curador de calendários", description: "Cadastra e revisa calendários da área. Exige também os:sensitive." },
  ],
  bot: { deny: ["juridico", "juridico."], sensitive: ["juridico."] },
};
