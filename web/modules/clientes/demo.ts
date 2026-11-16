// Demonstração do Cadastro de clientes (módulo "clientes"): fichas fictícias
// nos formatos de GET /clientes/customers, /customers/{id}, /timeline,
// /reveal, /erasures, /access-log e /conversations/{id}. Dados inventados.
import type { Row } from "../../lib/api";

export const clientesDemoModule: Row = {
  id: "clientes",
  name: "Cadastro de clientes",
  version: "1.0.0",
  description:
    "Ficha do cliente para nota fiscal, preenchida por ele pelo WhatsApp, com dados mascarados para a equipe, linha do tempo do relacionamento e exclusão a pedido do titular.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  navigation: [
    { id: "clientes", label: "Clientes", place: "admin", admin: false },
    { id: "clientes-settings", label: "Cadastro e privacidade", place: "admin", admin: true },
  ],
  menu_item_types: [
    { type: "clientes_cadastro", label: "Meu cadastro" },
    { type: "clientes_exclusao", label: "Excluir meus dados" },
  ],
};

const H = 3600000;
const now = Date.now();
const masked = (row: Row): Row => ({
  ...row,
  masked: true,
  revealable: true,
  fiscal_ready: { nfce: true, nfe: !!row.address.street, nfse: row.has_document },
  version: 1,
  created_by: "demo",
});

const customers: Row[] = [
  masked({
    id: "cli-1",
    status: "active",
    kind: "pf",
    name: "Mariana Costa",
    trade_name: "",
    document_type: "cpf",
    individual_business: false,
    has_document: true,
    document_display: "•••.456.789-••",
    ie: "",
    ie_indicator: "9",
    im: "",
    email: "m•••@e•••.com",
    phones: [{ phone: "+55 (11) •••••-1234", label: "", verified: true }],
    address: { cep: "01•••-•••", street: "•••", number: "•••", complement: "", district: "•••", city: "São Paulo", uf: "SP", city_ibge: "3550308" },
    country_code: "1058",
    notes: "",
    source: "self",
    created: now - 30 * 24 * H,
    updated: now - 2 * H,
    erased_at: null,
  }),
  masked({
    id: "cli-2",
    status: "active",
    kind: "pj",
    name: "Padaria Exemplo Ltda",
    trade_name: "Padaria Exemplo",
    document_type: "cnpj",
    individual_business: false,
    has_document: true,
    document_display: "12.345.678/0001-95",
    ie: "123456789110",
    ie_indicator: "1",
    im: "",
    email: "f•••@p•••.com.br",
    phones: [{ phone: "+55 (21) ••••-5678", label: "Financeiro", verified: false }],
    address: { cep: "20•••-•••", street: "•••", number: "•••", complement: "", district: "•••", city: "Rio de Janeiro", uf: "RJ", city_ibge: "3304557" },
    country_code: "1058",
    notes: "Nota sempre com o pedido de compra.",
    source: "panel",
    created: now - 90 * 24 * H,
    updated: now - 26 * H,
    erased_at: null,
  }),
  masked({
    id: "cli-3",
    status: "erased",
    kind: "pf",
    name: "",
    trade_name: "",
    document_type: null,
    individual_business: false,
    has_document: false,
    document_display: null,
    ie: "",
    ie_indicator: "9",
    im: "",
    email: "",
    phones: [],
    address: { cep: "", street: "", number: "", complement: "", district: "", city: "", uf: "", city_ibge: "" },
    country_code: "1058",
    notes: "",
    source: "self",
    created: now - 200 * 24 * H,
    updated: now - 10 * 24 * H,
    erased_at: now - 10 * 24 * H,
  }),
];

const erasures: Row[] = [
  {
    id: "exc-1",
    customer_id: "cli-3",
    status: "done",
    requested_via: "whatsapp",
    requested_by: "system",
    conversation_id: "demo-1",
    confirmed_via: "button",
    confirmed_at: now - 10 * 24 * H - H,
    expires_at: now - 8 * 24 * H,
    kept: { conversation_ids: ["c-1", "c-2"], ticket_ids: ["t-1"], fiscal_documents: 2, fiscal_retention_until: Date.UTC(2032, 0, 1, 3) },
    modules: { pedido: { status: "done", erased: 3, kept: 2 }, agenda: { status: "done", erased: 1, kept: 0 } },
    core: null,
    attempts: 1,
    error: null,
    completed_at: now - 10 * 24 * H,
    created: now - 10 * 24 * H - 2 * H,
    updated: now - 10 * 24 * H,
  },
];

const timeline: Row[] = [
  { at: now - 2 * H, module: "vendas", kind: "sale", ref_id: "v-1", title: "Venda nº 128 · 2 itens", status: "completed", conversation_id: "demo-1" },
  { at: now - 2 * H, module: "vendas", kind: "fiscal_document", ref_id: "nf-1", title: "NFCE nº 3412 série 1", status: "issued", conversation_id: null },
  { at: now - 3 * 24 * H, module: "agenda", kind: "appointment", ref_id: "a-1", title: "Agendamento · Corte de cabelo", status: "done", conversation_id: "demo-1" },
  { at: now - 5 * 24 * H, module: "core", kind: "ticket", ref_id: "t-1", title: "Protocolo 10023 · Troca de produto", status: "resolved", conversation_id: "demo-1" },
  { at: now - 30 * 24 * H, module: "clientes", kind: "consent", ref_id: "ok-1", title: "Aceite do cadastro (versão 1)", status: "granted", conversation_id: "demo-1" },
  { at: now - 30 * 24 * H, module: "core", kind: "conversation", ref_id: "demo-1", title: "Conversa no WhatsApp", status: "closed", conversation_id: "demo-1" },
  { at: now - 30 * 24 * H, module: "clientes", kind: "customer", ref_id: "cli-1", title: "Cadastro feito pelo cliente", status: "active", conversation_id: null },
];

export function clientesDemo(rest: string, query: URLSearchParams): any {
  if (rest === "clientes/customers") {
    const q = (query.get("q") || "").toLowerCase();
    const status = query.get("status") || "active";
    return {
      data: customers.filter(
        (c) => (status === "all" || c.status === status) && (!q || c.name.toLowerCase().includes(q)),
      ),
      next_cursor: null,
    };
  }
  if (rest === "clientes/erasures") return { data: erasures };
  if (rest === "clientes/access-log" || /^clientes\/customers\/[^/]+\/access-log$/.test(rest))
    return {
      data: [
        { id: "l-1", customer_id: "cli-1", actor: "demo-admin", actor_kind: "user", action: "fiscal", fields: ["document", "address"], reason: "vendas: NFC-e da venda 128", created: now - 2 * H },
        { id: "l-2", customer_id: "cli-1", actor: "demo-admin", actor_kind: "user", action: "reveal", fields: ["document"], reason: "Conferir CPF com a cliente no balcão", created: now - 26 * H },
      ],
      next_cursor: null,
    };
  const conv = rest.match(/^clientes\/conversations\/([^/]+)$/);
  if (conv) return { conversation_id: conv[1], phone_verified: true, customer: detail("cli-1") };
  const match = rest.match(/^clientes\/customers\/([^/]+)(\/(timeline|reveal))?$/);
  if (match) {
    if (match[3] === "timeline") return { customer_id: match[1], data: timeline, skipped: [] };
    if (match[3] === "reveal")
      return {
        ...detail(match[1]),
        masked: false,
        document_display: "123.456.789-09",
        document: "12345678909",
        email: "mariana@exemplo.com",
        phones: [{ phone: "5511900001234", label: "", verified: true }],
        address: { cep: "01310100", street: "Avenida Exemplo", number: "100", complement: "Apto 12", district: "Centro", city: "São Paulo", uf: "SP", city_ibge: "3550308" },
      };
    return detail(match[1]);
  }
  return { data: [] };
}

function detail(id: string): Row {
  const row = customers.find((c) => c.id === id) || customers[0];
  return {
    ...row,
    consents: row.status === "active" ? [{ id: "ok-1", status: "granted", source: "web_step", terms_version: "1", created: row.created }] : [],
    fiscal_documents:
      row.id === "cli-1"
        ? [{ module_id: "vendas", ref_id: "nf-1", model: "nfce", series: "1", number: "3412", access_key: "", issued_at: now - 2 * H, retain_until: Date.UTC(2032, 0, 1, 3) }]
        : [],
    erasure: null,
  };
}
