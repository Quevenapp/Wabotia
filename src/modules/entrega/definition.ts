// Entrega: acompanhamento da entrega em tempo real. O entregador (pessoa da
// equipe) inicia a rota no app, que manda a posição em lotes; o cliente recebe
// no WhatsApp a previsão de chegada, a localização ou o link de
// acompanhamento, e os avisos de saída, chegada e entrega. Declaração só com
// dados, lida pelo registro (src/modules/registry.ts). Código em ./entrega.ts;
// uso em docs/ENTREGA.md.
import type { ModuleDefinition } from "../types";

export const entregaModule: ModuleDefinition = {
  id: "entrega",
  name: "Entrega",
  version: "1.0.0",
  description:
    "Acompanhamento da entrega em tempo real: o entregador inicia a rota no app e o cliente recebe no WhatsApp a previsão de chegada, a localização e o link com o mapa.",
  builtin: true,
  default_enabled: false,
  navigation: [
    { id: "entregas", label: "Entregas", place: "admin", admin: false },
    {
      id: "entregas-settings",
      label: "Entrega",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "entrega_onde",
      label: "Onde está minha entrega",
      description:
        "Responde com a previsão de chegada das entregas em andamento do cliente e o link de acompanhamento.",
    },
  ],
  events: [
    "entrega.created",
    "entrega.assigned",
    "entrega.started",
    "entrega.arriving",
    "entrega.delivered",
    "entrega.cancelled",
    "entrega.signal_lost",
  ],
  settings: [
    {
      key: "entrega",
      description:
        "Entregadores, velocidade média, frequência e tipo das atualizações ao cliente, raio do aviso de chegada, envio de posições pelo app e retenção.",
    },
  ],
  routes: ["entrega"],
  operations: ["entrega."],
  scopes: [],
};
