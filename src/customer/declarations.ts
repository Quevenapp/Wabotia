import type { ContactContribution, ContactProfileDeclaration } from "./profile-contracts";

// source é uma chave lógica do provedor, nunca SQL ou uma concessão de acesso.
// policy identifica a autorização que o provedor deve aplicar (ver o contrato).
const tableColumns: NonNullable<ContactContribution["columns"]> = [
  { key: "id", label: "Referência", format: "text" },
  { key: "status", label: "Situação", format: "status" },
  { key: "occurredAt", label: "Data", format: "datetime" },
];
const collection = (
  moduleId: string, id: string, title: string,
  extra: Partial<ContactContribution> = {},
): ContactContribution => ({
  id, kind: "collection", title, component: "table",
  source: `${moduleId}.${id}`, policy: "module", columns: tableColumns, ...extra,
});
const privateSection = (moduleId: string): ContactProfileDeclaration => ({
  contributions: [{
    id: "private", kind: "section", title: "Acesso ao módulo",
    component: "private.navigation", source: `${moduleId}.private`, policy: "private",
  }],
});

export const customerProfileDeclarations: Readonly<Record<string, ContactProfileDeclaration>> = {
  os: { contributions: [collection("os", "works", "Trabalhos", { titleKey: "works" })] },
  agenda: { contributions: [collection("agenda", "appointments", "Agendamentos")] },
  pedido: { contributions: [collection("pedido", "orders", "Pedidos")] },
  reserva: { contributions: [collection("reserva", "bookings", "Reservas", {
    columns: [...tableColumns, { key: "checkinStatus", label: "Check-in", format: "status" }],
  })] },
  mensalidade: { contributions: [
    collection("mensalidade", "subscriptions", "Assinaturas"),
    collection("mensalidade", "installments", "Parcelas"),
  ] },
  suporte: { contributions: [
    collection("suporte", "sessions", "Atendimentos"),
    collection("suporte", "purchases", "Compras"),
    collection("suporte", "releases", "Liberações"),
  ] },
  queue: { contributions: [collection("queue", "tickets", "Senhas da fila")] },
  forms: { contributions: [collection("forms", "submissions", "Formulários concluídos")] },
  condominio: {
    contributions: [
      { id: "units", kind: "section", title: "Unidades e vínculos", component: "condominio.units",
        source: "condominio.units", policy: "module" },
      collection("condominio", "deliveries", "Encomendas"),
      collection("condominio", "visits", "Visitas"),
      collection("condominio", "occurrences", "Ocorrências"),
      collection("condominio", "dues", "Mensalidades", {
        enabledWith: ["mensalidade"], policy: "condominio.dues",
      }),
    ],
    personTypes: [
      { key: "morador", label: "Morador", projection: "profile" },
      { key: "proprietario", label: "Proprietário", projection: "profile" },
      { key: "inquilino", label: "Inquilino", projection: "profile" },
      { key: "dependente", label: "Dependente", projection: "private" },
      { key: "sindico", label: "Síndico", projection: "profile" },
      { key: "zelador", label: "Zelador", projection: "profile" },
      { key: "porteiro", label: "Porteiro", projection: "profile" },
      { key: "prestador", label: "Prestador", projection: "profile" },
      { key: "empregado_unidade", label: "Empregado da unidade", projection: "profile" },
      { key: "visitante_recorrente", label: "Visitante recorrente", projection: "profile" },
    ],
  },
  saude: privateSection("saude"),
  ensino: privateSection("ensino"),
  juridico: privateSection("juridico"),
  erp: { contributions: [
    collection("erp", "sales", "Vendas", { component: "erp", policy: "erp" }),
    collection("erp", "open_titles", "Títulos em aberto", { component: "erp", policy: "erp" }),
    collection("erp", "ledger", "Extrato", { component: "erp", policy: "erp" }),
  ] },
};
