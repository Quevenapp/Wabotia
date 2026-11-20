// Dados nativos; PageId e pageModules são conferidos pelos testes, sem importar React.
import type { ManagementItem } from "./panel-contract.ts";

/** Chaves de ícone correspondem aos nomes de lucide-react usados em sections. */
export const NATIVE_MANAGEMENT_ITEMS = {
  os: [
    {
      id: "os.work", module: "os",
      group: "os", groupLabel: "Ordens de serviço", groupOrder: 100,
      label: "Ordens de serviço", labelKey: "workCollection", icon: "Wrench", order: 10, primary: true,
      target: { kind: "native", page: "work" },
      permission: { kind: "page", page: "work" },
    },
    {
      id: "os.types", module: "os",
      group: "os", groupLabel: "Ordens de serviço", groupOrder: 100,
      label: "Configurar", icon: "Settings", order: 20,
      target: { kind: "native", page: "work-types" },
      permission: { kind: "page", page: "work-types" },
    },
  ],
  agenda: [
    {
      id: "agenda.calendar", module: "agenda",
      group: "agenda", groupLabel: "Agenda", groupOrder: 110,
      label: "Agenda", icon: "CalendarDays", order: 10, primary: true,
      target: { kind: "native", page: "agenda" },
      permission: { kind: "page", page: "agenda" },
    },
    {
      id: "agenda.settings", module: "agenda",
      group: "agenda", groupLabel: "Agenda", groupOrder: 110,
      label: "Serviços e horários", icon: "CalendarClock", order: 20,
      target: { kind: "native", page: "agenda-settings" },
      permission: { kind: "page", page: "agenda-settings" },
    },
  ],
  mensalidade: [
    {
      id: "mensalidade.subscriptions", module: "mensalidade",
      group: "mensalidade", groupLabel: "Mensalidades", groupOrder: 120,
      label: "Mensalidades", icon: "PiggyBank", order: 10, primary: true,
      target: { kind: "native", page: "mensalidades" },
      permission: { kind: "page", page: "mensalidades" },
    },
    {
      id: "mensalidade.settings", module: "mensalidade",
      group: "mensalidade", groupLabel: "Mensalidades", groupOrder: 120,
      label: "Planos e regras", icon: "PiggyBank", order: 20,
      target: { kind: "native", page: "mensalidade-settings" },
      permission: { kind: "page", page: "mensalidade-settings" },
    },
  ],
  pedido: [
    {
      id: "pedido.orders", module: "pedido",
      group: "pedido", groupLabel: "Pedidos", groupOrder: 130,
      label: "Pedidos", icon: "ShoppingBag", order: 10, primary: true,
      target: { kind: "native", page: "pedidos" },
      permission: { kind: "page", page: "pedidos" },
    },
    {
      id: "pedido.catalog", module: "pedido",
      group: "pedido", groupLabel: "Pedidos", groupOrder: 130,
      label: "Cardápio e loja", icon: "UtensilsCrossed", order: 20,
      target: { kind: "native", page: "pedidos-cardapio" },
      permission: { kind: "page", page: "pedidos-cardapio" },
    },
  ],
  mesas: [
    {
      id: "mesas.tables", module: "mesas",
      group: "mesas", groupLabel: "Mesas", groupOrder: 140,
      label: "Mesas", icon: "Armchair", order: 10, primary: true,
      target: { kind: "native", page: "mesas" },
      permission: { kind: "page", page: "mesas" },
    },
  ],
  reserva: [
    {
      id: "reserva.reservations", module: "reserva",
      group: "reserva", groupLabel: "Reservas", groupOrder: 150,
      label: "Reservas", icon: "BedDouble", order: 10, primary: true,
      target: { kind: "native", page: "reserva" },
      permission: { kind: "page", page: "reserva" },
    },
    {
      id: "reserva.settings", module: "reserva",
      group: "reserva", groupLabel: "Reservas", groupOrder: 150,
      label: "Unidades e regras", icon: "CalendarRange", order: 20,
      target: { kind: "native", page: "reserva-settings" },
      permission: { kind: "page", page: "reserva-settings" },
    },
  ],
  suporte: [
    {
      id: "suporte.support", module: "suporte",
      group: "suporte", groupLabel: "Suporte pago", groupOrder: 160,
      label: "Suporte pago", icon: "LifeBuoy", order: 10, primary: true,
      target: { kind: "native", page: "suporte" },
      permission: { kind: "page", page: "suporte" },
    },
    {
      id: "suporte.settings", module: "suporte",
      group: "suporte", groupLabel: "Suporte pago", groupOrder: 160,
      label: "Regras do suporte", icon: "LifeBuoy", order: 20,
      target: { kind: "native", page: "suporte-settings" },
      permission: { kind: "page", page: "suporte-settings" },
    },
  ],
  condominio: [
    {
      id: "condominio.overview", module: "condominio",
      group: "condominio", groupLabel: "Condomínio", groupOrder: 170,
      label: "Condomínio", icon: "Blocks", order: 10, primary: true,
      target: { kind: "native", page: "condominio" },
      permission: { kind: "page", page: "condominio" },
    },
  ],
  juridico: [
    {
      id: "juridico.deadlines", module: "juridico",
      group: "juridico", groupLabel: "Jurídico", groupOrder: 180,
      label: "Prazos", icon: "CalendarClock", order: 10, primary: true,
      target: { kind: "native", page: "juridico" },
      permission: { kind: "page", page: "juridico" },
    },
  ],
  saude: [
    {
      id: "saude.records", module: "saude",
      group: "saude", groupLabel: "Saúde", groupOrder: 190,
      label: "Prontuários", icon: "FileText", order: 10, primary: true,
      target: { kind: "native", page: "saude" },
      permission: { kind: "page", page: "saude" },
    },
  ],
  ensino: [
    {
      id: "ensino.overview", module: "ensino",
      group: "ensino", groupLabel: "Ensino", groupOrder: 200,
      label: "Ensino", icon: "BookOpen", order: 10, primary: true,
      target: { kind: "native", page: "ensino" },
      permission: { kind: "page", page: "ensino" },
    },
  ],
  forms: [
    {
      id: "forms.forms", module: "forms",
      group: "forms", groupLabel: "Formulários", groupOrder: 210,
      label: "Formulários", icon: "ClipboardList", order: 10, primary: true,
      target: { kind: "native", page: "forms" },
      permission: { kind: "page", page: "forms" },
    },
  ],
  payments: [
    {
      id: "payments.billing", module: "payments",
      group: "payments", groupLabel: "Cobrança", groupOrder: 220,
      label: "Cobrança", icon: "CreditCard", order: 10, primary: true,
      target: { kind: "native", page: "payments" },
      permission: { kind: "page", page: "payments" },
    },
  ],
} as const satisfies Readonly<Record<string, readonly ManagementItem[]>>;
