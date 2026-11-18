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
    { id: "work", label: "Trabalhos", place: "admin", admin: false },
    { id: "my-deadlines", label: "Meus prazos", place: "admin", admin: false },
    { id: "work-types", label: "Tipos de trabalho", place: "admin", admin: true },
  ],
  menu_item_types: [
    {
      type: "os_open",
      reference: {
        field: "type_id", setting: "os_work_types", label: "Tipo de trabalho",
        default_id: "service_order", builtins: [{ id: "service_order", label: "Ordem de serviço" }],
      },
      label: "Abrir ordem de serviço",
      description:
        "Envia um link para o cliente informar o item, o problema e aceitar os termos; a ordem é aberta ao concluir.",
    },
    {
      type: "os_track",
      reference: {
        field: "type_id", setting: "os_work_types", label: "Tipo de trabalho",
        default_id: "service_order", builtins: [{ id: "service_order", label: "Ordem de serviço" }],
      },
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
    "os.updated",
    "os.stage_changed",
    "os.quote_saved",
    "os.stage_approval_requested",
    "os.stage_approval_decided",
    "os.private_fields_changed",
    "os.task.created",
    "os.task.updated",
    "os.task.archived",
    "os.task.due",
    "os.person.created",
    "os.person.updated",
    "os.person.archived",
    "os.document_reserved",
    "os.document_ready",
    "os.document_archived",
    "os.entry.created",
    "os.entry.revised",
    "os.entry.archived",
  ],
  settings: [
    { key: "os_work_types", description: "Tipos personalizados de trabalho." },
    { key: "os_vocabulary", description: "Vocabulário da área." },
    { key: "os_area_setup", description: "Sugestões e pendências dos modelos de área." },
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
    {
      id: "sensitive",
      label: "Dados sensíveis",
      description: "Permite acesso humano explícito aos dados sensíveis do motor.",
    },
  ],
  bot: { deny: ["os.private", "service-orders/:id/private-fields", "os.document.upload", "service-orders/:id/private-tasks", "service-orders/:id/private-documents", "os.person.", "os.entry."] },
};

// REGISTRO RESERVADO F0/I — acrescentar eventos, grants e bot.deny das filhas.
// O grant os:sensitive entra na integração M/I; F0 conserva o catálogo legado.
// A não acrescenta area-templates a routes nem area-template. a operations:
// essas rotas precisam funcionar com os desligado.
