import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
// Agenda: serviços, profissionais, horários, agendamento pelo WhatsApp,
// lembrete e confirmação. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Uso: docs/AGENDA.md.
import type { ModuleDefinition } from "../types";

export const agendaModule: ModuleDefinition = {
  id: "agenda",
  integration: { route: "title", uses: ["customers", "products", "finance"], operations: ["recognize", "receive", "cancel", "reverse"], privacy: "adult_payer_only" },
  name: "Agenda",
  version: "1.0.0",
  description:
    "Serviços, profissionais e horários; o cliente agenda, confirma, remarca e cancela pelo WhatsApp, com lembrete antes do horário.",
  builtin: true,
  default_enabled: false,
  management: NATIVE_MANAGEMENT_ITEMS.agenda,
  navigation: [
    // No trilho quando o núcleo aceitar áreas de módulo; por ora em Gestão.
    { id: "agenda", label: "Agenda", place: "admin", admin: false },
    {
      id: "agenda-settings",
      label: "Serviços e horários",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "agenda",
      label: "Agendar horário",
      description:
        "Mostra serviços, profissionais e horários livres e confirma o agendamento pelo WhatsApp.",
    },
    {
      type: "agenda_mine",
      label: "Meus agendamentos",
      description:
        "Mostra os agendamentos do cliente, com opção de cancelar ou remarcar.",
    },
  ],
  events: [
    "agenda.booked",
    "agenda.rescheduled",
    "agenda.cancelled",
    "agenda.confirmed",
    "agenda.no_show",
  ],
  settings: [
    {
      key: "agenda",
      description:
        "Antecedência mínima e máxima, intervalo entre horários, lembrete e textos enviados ao cliente.",
    },
  ],
  routes: ["agenda"],
  operations: ["agenda."],
  scopes: [],
};
