// Cadastro de clientes: linha do tempo do relacionamento. Nada é copiado:
// cada leitura pergunta ao núcleo (conversas e protocolos) e aos módulos
// pela API pública deles (ctx.read, com o mesmo ator e as mesmas
// permissões). Módulo desligado na área não aparece.
import type { Actor } from "../../types";
import type { ModuleContext } from "../api";
import { consentsOf, customerPhones, fiscalDocumentsOf } from "./store";

export interface TimelineItem {
  at: number;
  /** "core" (conversa, protocolo), "clientes" ou o id do módulo. */
  module: string;
  /** conversation, ticket, appointment, sale… */
  kind: string;
  /** Registro no módulo dono (abre a tela dele). */
  ref_id: string;
  title: string;
  status: string | null;
  conversation_id: string | null;
}

/**
 * Fontes dos módulos: rota pública por conversa (a regra do módulo já casa
 * a conversa e o telefone autenticado). `kind` nomeia o tipo no item.
 */
const SOURCES: {
  module: string;
  label: string;
  kind: string;
  path: (conversation: string) => string;
  query?: (conversation: string) => Record<string, string>;
}[] = [
  { module: "vendas", label: "Orçamento", kind: "quote", path: (id) => `vendas/conversations/${id}` },
  { module: "vendas", label: "Venda", kind: "sale", path: () => "vendas/sales", query: (id) => ({ conversation_id: id, limit: "20" }) },
  { module: "pedido", label: "Pedido", kind: "order", path: (id) => `pedido/conversations/${id}` },
  { module: "os", label: "Ordem de serviço", kind: "service_order", path: (id) => `service-orders/conversation/${id}` },
  { module: "reserva", label: "Reserva", kind: "booking", path: (id) => `reserva/conversations/${id}` },
  { module: "agenda", label: "Agendamento", kind: "appointment", path: (id) => `agenda/conversations/${id}` },
  { module: "mensalidade", label: "Mensalidade", kind: "installment", path: (id) => `mensalidade/conversations/${id}` },
  { module: "suporte", label: "Suporte", kind: "support", path: (id) => `suporte/conversations/${id}` },
];

const TIME_KEYS = [
  "starts_at",
  "start_at",
  "check_in_at",
  "due_at",
  "scheduled_at",
  "completed_at",
  "created",
  "created_at",
  "updated",
];
const TITLE_KEYS = [
  "service_name",
  "title",
  "plan_name",
  "description",
  "unit_name",
  "name",
];

/** Registros de uma resposta de módulo: arrays de objetos com `id` no 1º nível. */
export function recordsOf(value: any): any[] {
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === "object" && typeof v.id === "string");
  if (!value || typeof value !== "object") return [];
  const out: any[] = [];
  if (typeof value.id === "string" && TIME_KEYS.some((k) => typeof value[k] === "number"))
    out.push(value);
  for (const item of Object.values(value))
    if (Array.isArray(item))
      for (const v of item)
        if (v && typeof v === "object" && typeof v.id === "string") out.push(v);
  return out;
}

export function normalize(
  source: { module: string; label: string; kind: string },
  record: any,
  conversation: string,
): TimelineItem | null {
  const key = TIME_KEYS.find((k) => typeof record[k] === "number");
  if (!key) return null;
  const number = record.number ?? record.code ?? null;
  const detail = TITLE_KEYS.map((k) => record[k]).find(
    (v) => typeof v === "string" && v.trim(),
  );
  const title = [
    source.label + (number !== null && number !== undefined ? ` ${typeof number === "number" ? "nº " + number : number}` : ""),
    detail,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    at: record[key],
    module: source.module,
    kind: source.kind,
    ref_id: record.id,
    title: title.slice(0, 200),
    status: typeof record.status === "string" ? record.status : null,
    conversation_id:
      typeof record.conversation_id === "string" ? record.conversation_id : conversation,
  };
}

export async function customerTimeline(
  ctx: ModuleContext,
  actor: Actor,
  customer: any,
  query: { limit?: string } = {},
) {
  const limit = Math.min(300, Math.max(1, Math.floor(Number(query.limit)) || 100));
  const items: TimelineItem[] = [];
  const skipped: { module: string; reason: string }[] = [];
  items.push({
    at: customer.created,
    module: "clientes",
    kind: "customer",
    ref_id: customer.id,
    title: customer.source === "self" ? "Cadastro feito pelo cliente" : "Cadastro criado pela equipe",
    status: customer.status,
    conversation_id: null,
  });
  for (const consent of await consentsOf(ctx, customer.id))
    items.push({
      at: consent.created,
      module: "clientes",
      kind: "consent",
      ref_id: consent.id,
      title: `Aceite do cadastro (versão ${consent.terms_version || "?"})`,
      status: consent.status,
      conversation_id: consent.evidence?.conversation_id ?? null,
    });
  for (const doc of await fiscalDocumentsOf(ctx, customer.id))
    items.push({
      at: doc.issued_at,
      module: doc.module_id,
      kind: "fiscal_document",
      ref_id: doc.ref_id,
      title: `${String(doc.model).toUpperCase()}${doc.number ? " nº " + doc.number : ""}${doc.series ? " série " + doc.series : ""}`,
      status: "issued",
      conversation_id: null,
    });
  const phones = (await customerPhones(ctx, customer.id)).map((p) => p.phone);
  const conversations = await ctx.customerConversations(phones, { limit: 30 });
  for (const c of conversations)
    items.push({
      at: c.created,
      module: "core",
      kind: "conversation",
      ref_id: c.id,
      title: "Conversa no WhatsApp",
      status: c.state,
      conversation_id: c.id,
    });
  for (const t of await ctx.customerTickets(conversations.map((c) => c.id)))
    items.push({
      at: t.created,
      module: "core",
      kind: "ticket",
      ref_id: t.id,
      title: `Protocolo ${t.number}${t.title ? " · " + t.title : ""}`,
      status: t.status,
      conversation_id: t.conversation_id,
    });
  // Módulos: as rotas por conversa já casam também o telefone autenticado,
  // então as 3 conversas mais recentes bastam e mantêm as consultas ao D1
  // sob controle (docs/LIMITES.md).
  const perPhone = conversations.slice(0, 3).map((c) => c.id);
  const keys = new Set<string>();
  for (const source of SOURCES)
    for (const conversation of perPhone) {
      let response: any;
      try {
        response = await ctx.read(actor, source.path(conversation), source.query?.(conversation));
      } catch (error) {
        skipped.push({
          module: source.module,
          reason: String((error as Error)?.message || error).slice(0, 120),
        });
        break;
      }
      if (response === null) break; // rota inexistente ou módulo desligado
      for (const record of recordsOf(response)) {
        const item = normalize(source, record, conversation);
        const key = `${source.module}:${source.kind}:${record.id}`;
        if (item && !keys.has(key)) {
          keys.add(key);
          items.push(item);
        }
      }
    }
  items.sort((a, b) => b.at - a.at);
  return {
    customer_id: customer.id,
    data: items.slice(0, limit),
    skipped: [...new Map(skipped.map((s) => [s.module, s])).values()],
  };
}
