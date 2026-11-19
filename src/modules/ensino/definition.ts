import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
import type { ModuleDefinition } from "../types";

export const ensinoModule: ModuleDefinition = {
  id: "ensino", name: "Ensino", version: "1.0.0", builtin: true,
  description: "Turmas, frequência, avaliações e consulta protegida pelos responsáveis.",
  default_enabled: false, requires: ["os"],
  management: NATIVE_MANAGEMENT_ITEMS.ensino,
  navigation: [{ id: "ensino", label: "Ensino", place: "admin", admin: false }],
  menu_item_types: [{ type: "ensino_boletim", label: "Boletim e frequência",
    description: "Abre uma consulta protegida para o telefone verificado de um responsável autorizado." }],
  events: [], settings: [], routes: ["ensino"], operations: ["ensino."], scopes: [],
  grants: [
    { id: "secretaria", label: "Secretaria", description: "Administra todas as turmas e autoriza responsáveis da área." },
    { id: "professor", label: "Professor", description: "Consulta e registra frequência e notas somente nas próprias turmas." },
  ],
  // sensitive exige confirmação forte, mas NÃO substitui deny ou a barreira nos handlers.
  bot: { deny: ["ensino/", "ensino."], sensitive: ["ensino."] },
};
