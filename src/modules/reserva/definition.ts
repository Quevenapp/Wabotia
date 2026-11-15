// Reserva e check-in: unidades reserváveis (quarto, chalé, quadra, salão),
// disponibilidade por diária ou por hora, reserva pelo WhatsApp com sinal pela
// Cobrança, check-in por passo web, lembrete e mensagem de saída.
// Declaração só com dados, lida pelo registro (src/modules/registry.ts).
// Uso: docs/RESERVA.md.
import type { ModuleDefinition } from "../types";

export const reservaModule: ModuleDefinition = {
  id: "reserva",
  name: "Reserva e check-in",
  version: "1.0.0",
  description:
    "Quartos, chalés, quadras e salões reservados pelo WhatsApp por diária ou por hora, com sinal por Pix ou link, check-in online, lembrete e mensagem de saída.",
  builtin: true,
  default_enabled: false,
  navigation: [
    // No trilho quando o núcleo aceitar áreas de módulo; por ora em Gestão.
    { id: "reserva", label: "Reservas", place: "admin", admin: false },
    {
      id: "reserva-settings",
      label: "Unidades e regras",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "reserva",
      label: "Fazer reserva",
      description:
        "Mostra as unidades, as datas ou horários livres e o valor, e confirma a reserva pelo WhatsApp (com sinal, se configurado).",
    },
    {
      type: "reserva_mine",
      label: "Minhas reservas",
      description:
        "Mostra as reservas do cliente, com check-in online e cancelamento dentro da política.",
    },
  ],
  events: [
    "reserva.created",
    "reserva.confirmed",
    "reserva.changed",
    "reserva.cancelled",
    "reserva.expired",
    "reserva.completed",
    "reserva.payment_late",
    "reserva.checkin_sent",
    "reserva.checkin_completed",
  ],
  settings: [
    {
      key: "reserva",
      description:
        "Antecedência, estadia mínima, horários de entrada e saída, sinal, política de cancelamento, check-in, lembrete e textos enviados ao cliente.",
    },
  ],
  routes: ["reserva"],
  operations: ["reserva."],
  scopes: [],
};
