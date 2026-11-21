import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
import type { ModuleDefinition } from "../types";

export const saudeModule: ModuleDefinition = {
  id: "saude",
  name: "Saúde — prontuário",
  version: "1.0.0",
  description: "Prontuário protegido de pacientes e animais, com autoria, auditoria e guarda.",
  builtin: true,
  default_enabled: false,
  requires: ["os"],
  management: NATIVE_MANAGEMENT_ITEMS.saude,
  navigation: [{ id: "saude", label: "Prontuários", place: "admin", admin: false }],
  menu_item_types: [],
  events: [],
  settings: [],
  routes: ["saude"],
  operations: ["saude."],
  scopes: ["conversations:read", "conversations:write"],
  grants: [
    { id: "clinical_read", label: "Leitura clínica", description: "Ler e exportar prontuários da área. Exige também os:sensitive." },
    { id: "clinical_write", label: "Escrita clínica", description: "Cadastrar e escrever prontuários. Exige leitura clínica; só o autor assina sua evolução." },
    { id: "responsible", label: "Responsável técnico", description: "Consultar auditoria e configurar guarda. Não concede leitura clínica." },
  ],
  // Fora do catálogo comum; cada operação vem de bot-grants.ts e só chega ao
  // bot que o administrador liberou, com aviso (src/bot-actions/area.ts).
  bot: { deny: ["saude", "saude."], sensitive: ["saude", "saude."] },
};
