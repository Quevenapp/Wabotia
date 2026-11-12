// Cartão de protocolo e prazo com anel (web/DESIGN.md §6, mobile/DESIGN.md §8).
import React from "react";
import { AlertTriangle, Check, Clock, Minus } from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { linkProps } from "../lib/routes";
import {
  categoryName,
  ticketDeadline,
  ticketStateName,
  ticketStateTone,
  type Deadline,
} from "../lib/tickets";
import { Avatar, Pill, ProgressRing } from "../ui";

/** Pílula do estado; estados desconhecidos aparecem como texto neutro. */
export function TicketStatePill({ status }: { status: string }) {
  return <Pill tone={ticketStateTone(status)}>{ticketStateName(status)}</Pill>;
}

/** Prazo da primeira resposta: anel + texto ("atrasado há 2 h", "Respondido"). */
export function DeadlineBadge({
  deadline,
  size = 20,
}: {
  deadline: Deadline;
  size?: number;
}) {
  const Icon =
    deadline.kind === "answered"
      ? Check
      : deadline.kind === "overdue"
        ? AlertTriangle
        : deadline.kind === "none"
          ? Minus
          : Clock;
  return (
    <span className={"ticket-deadline tone-" + deadline.tone}>
      <ProgressRing
        fraction={deadline.kind === "answered" ? 1 : deadline.fraction}
        tone={deadline.tone}
        size={size}
        stroke={size >= 40 ? 4 : 2.5}
        icon={<Icon size={Math.round(size * 0.5)} strokeWidth={2.5} />}
      />
      <span>
        {deadline.text.replace(
          /^(até|Prazo era) (Hoje|Ontem|Amanhã)/,
          (_all, start: string, day: string) => `${start} ${day.toLowerCase()}`,
        )}
      </span>
    </span>
  );
}

export function TicketCard({
  ticket,
  selected,
}: {
  ticket: Row;
  selected?: boolean;
}) {
  const app = useApp();
  const category = categoryName(app.settings, ticket.category);
  const owner = ticket.owner ? app.names[ticket.owner] || "Responsável" : "";
  return (
    <a
      {...linkProps({ area: "tickets", id: ticket.id })}
      className={"ticket-card" + (selected ? " selected" : "")}
      aria-current={selected ? "true" : undefined}
    >
      <span className="ticket-card-top">
        <span className="ticket-number">{ticket.number}</span>
        <TicketStatePill status={ticket.status} />
      </span>
      <strong className="ticket-title">{ticket.title}</strong>
      <span className="ticket-card-meta">
        {category && <span className="ticket-category truncate">{category}</span>}
        <span className="ticket-owner">
          {owner ? (
            <>
              <Avatar name={owner} seed={ticket.owner} size={20} />
              <span className="truncate">
                {ticket.owner === app.me.id ? "Você" : owner}
              </span>
            </>
          ) : (
            <span className="muted">Sem responsável</span>
          )}
        </span>
      </span>
      <DeadlineBadge deadline={ticketDeadline(ticket, app.now)} />
    </a>
  );
}
