// Formulários definidos pelo administrador: o primeiro uso concreto do passo
// web. Declaração só com dados, lida pelo registro (src/modules/registry.ts).
import type { ModuleDefinition } from "../types";

export const formsModule: ModuleDefinition = {
  id: "forms",
  name: "Formulários",
  version: "1.0.0",
  description:
    "Formulários do administrador (texto, escolha, data, aceite) respondidos numa página leve aberta pelo WhatsApp; as respostas vão para o contato e o protocolo.",
  builtin: true,
  // Não muda nada sozinho: sem formulário cadastrado, nada aparece ao cliente.
  default_enabled: true,
  navigation: [
    { id: "forms", label: "Formulários", place: "admin", admin: true },
  ],
  menu_item_types: [
    {
      type: "form",
      label: "Responder formulário",
      description:
        "Envia o link de um formulário; ao concluir, o cliente recebe a confirmação no WhatsApp.",
      reference: { field: "form_id", setting: "forms", label: "Formulário" },
    },
  ],
  events: ["form.submitted"],
  settings: [
    {
      key: "forms",
      description:
        "Lista de formulários: título, campos, textos e destino das respostas.",
    },
  ],
  routes: ["forms"],
  operations: ["form."],
  scopes: [],
};
