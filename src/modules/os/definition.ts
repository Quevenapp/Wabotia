// Ordem de Serviço: assistência técnica, oficina, lavanderia e serviços
// parecidos. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Código em ./os.ts; uso em docs/ORDEM-DE-SERVICO.md.
import type { ModuleDefinition } from "../types";

export const osModule: ModuleDefinition = {
  id: "os",
  name: "Ordem de Serviço",
  version: "1.0.0",
  description:
    "Ordens de serviço numeradas com orçamento, aprovação pelo WhatsApp, acompanhamento pelo cliente e retirada.",
  builtin: true,
  default_enabled: false,
  navigation: [
    {
      id: "service-orders",
      label: "Ordens de serviço",
      place: "admin",
      admin: false,
    },
    {
      id: "service-orders-settings",
      label: "Ordem de serviço",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "os_open",
      label: "Abrir ordem de serviço",
      description:
        "Envia um link para o cliente informar o item, o problema e aceitar os termos; a ordem é aberta ao concluir.",
    },
    {
      type: "os_track",
      label: "Acompanhar ordem de serviço",
      description:
        "Mostra as ordens abertas do telefone da conversa e o estado de cada uma.",
    },
  ],
  events: [
    "os.opened",
    "os.quoted",
    "os.approved",
    "os.declined",
    "os.status_changed",
    "os.delivered",
    "os.stale",
  ],
  settings: [
    {
      key: "service_orders",
      description:
        "Termos, mensagens ao cliente, validade padrão do orçamento, garantia e prazos de aviso.",
    },
  ],
  routes: ["service-orders"],
  operations: ["os."],
  scopes: [],
  grants: [
    {
      id: "technician",
      label: "Técnico",
      description:
        "Executa as ordens de serviço; aparece na escolha do responsável da ordem.",
    },
  ],
};
