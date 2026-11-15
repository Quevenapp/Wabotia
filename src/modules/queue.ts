// Fila presencial: o primeiro módulo embutido. O código continua em
// src/queue.ts e src/queue-flow.ts (contrato em docs/FILA-SENHAS.md); aqui fica
// só a declaração que o registro usa para ligar e desligar a fila.
import type { ModuleDefinition } from "./types";

export const queueModule: ModuleDefinition = {
  id: "queue",
  name: "Fila presencial",
  version: "1.0.0",
  description:
    "Senhas com guichês, painel de TV, totem Senhapp e entrada na fila pelo WhatsApp.",
  builtin: true,
  // Instalações anteriores aos módulos já usavam a fila (migração 0020).
  default_enabled: true,
  navigation: [
    { id: "queue", label: "Fila", place: "rail", admin: false },
    {
      id: "queue-settings",
      label: "Filas e guichês",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "queue",
      label: "Entrar na fila de espera",
      description: "Mostra a espera e emite uma senha pelo WhatsApp.",
    },
  ],
  events: [
    "queue.issued",
    "queue.called",
    "queue.recalled",
    "queue.started",
    "queue.finished",
    "queue.no_show",
    "queue.cancelled",
    "queue.transferred",
    "queue.counter",
    "queue.changed",
  ],
  settings: [
    {
      key: "queue",
      description:
        "Porta de entrada, avisos, limites e lista negra (docs/FILA-SENHAS.md).",
    },
  ],
  routes: ["queue"],
  operations: ["queue.", "counter."],
  scopes: ["queue:read", "queue:issue", "queue:operate"],
};
