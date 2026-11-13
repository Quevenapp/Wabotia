// Protocolos: seis estados, categorias e prazo (docs/CENTRAL-ATENDIMENTO.md).
import type { Row } from "./api";
import type { PillTone } from "../ui/controls";
import { span, whenLabel } from "./format";

export const ticketStates = [
  "open",
  "in_progress",
  "waiting_customer",
  "waiting_third",
  "resolved",
  "closed",
] as const;
export type TicketState = (typeof ticketStates)[number];

/** Texto para a equipe. */
export const ticketStateNames: Record<string, string> = {
  open: "Recebido",
  in_progress: "Em análise",
  waiting_customer: "Aguardando cliente",
  waiting_third: "Aguardando terceiro",
  resolved: "Resolvido",
  closed: "Encerrado",
};
/** Texto que o cliente vê na consulta de protocolos. */
export const ticketCustomerNames: Record<string, string> = {
  open: "Recebido",
  in_progress: "Em análise",
  waiting_customer: "Aguardando você",
  waiting_third: "Aguardando atualização",
  resolved: "Resolvido",
  closed: "Encerrado",
};
/** Cores: Recebido ticket; Em análise warn; Aguardando bot; Resolvido ok; Encerrado muted. */
export const ticketStateTones: Record<string, PillTone> = {
  open: "ticket",
  in_progress: "warn",
  waiting_customer: "bot",
  waiting_third: "bot",
  resolved: "ok",
  closed: "muted",
};
/** Estados desconhecidos (servidor mais novo) aparecem como texto neutro. */
export const ticketStateName = (status: string) =>
  ticketStateNames[status] || status || "—";
export const ticketStateTone = (status: string): PillTone =>
  ticketStateTones[status] || "muted";

/** Ativo = nem resolvido nem encerrado. */
export const ticketActive = (ticket: Row) =>
  !["resolved", "closed"].includes(ticket.status);

/** Nome da categoria; categorias removidas da configuração mostram o id gravado. */
export function categoryName(settings: Row, id?: string | null) {
  if (!id) return "";
  return (
    (settings.ticket_categories || []).find((item: Row) => item.id === id)
      ?.name || id
  );
}
export const enabledCategories = (settings: Row): Row[] =>
  (settings.ticket_categories || []).filter(
    (item: Row) => item.enabled !== false,
  );

export type Deadline = {
  kind: "none" | "answered" | "overdue" | "soon" | "ok" | "done";
  tone: "ok" | "warn" | "danger" | "muted";
  /** 1 = prazo inteiro pela frente; 0 = vencido. */
  fraction: number;
  /** "Respondido", "atrasado há 2 h", "vence em 42 min", "até Amanhã 14:00". */
  text: string;
};

/** "Hoje 14:00" → "hoje 14:00" no meio da frase. */
const lowerDay = (text: string) =>
  text.replace(/^(Hoje|Ontem|Amanhã)/, (word) => word.toLowerCase());

/** Prazo da primeira resposta, com o mesmo anel do relógio da janela. */
export function ticketDeadline(ticket: Row, now: number): Deadline {
  if (ticket.first_response_at)
    return { kind: "answered", tone: "ok", fraction: 1, text: "Respondido" };
  if (!ticket.response_due_at)
    return { kind: "none", tone: "muted", fraction: 0, text: "Sem prazo" };
  if (!ticketActive(ticket))
    return {
      kind: "done",
      tone: "muted",
      fraction: 0,
      text: "Prazo era " + lowerDay(whenLabel(ticket.response_due_at, now)),
    };
  const remaining = ticket.response_due_at - now;
  const total = Math.max(1, ticket.response_due_at - (ticket.created || now));
  const fraction = Math.min(1, Math.max(0, remaining / total));
  if (remaining <= 0)
    return {
      kind: "overdue",
      tone: "danger",
      fraction: 0,
      text: "atrasado há " + span(-remaining),
    };
  if (remaining < 3600_000)
    return {
      kind: "soon",
      tone: "warn",
      fraction,
      text: "vence em " + span(remaining),
    };
  return {
    kind: "ok",
    tone: "ok",
    fraction,
    text: "até " + lowerDay(whenLabel(ticket.response_due_at, now)),
  };
}
