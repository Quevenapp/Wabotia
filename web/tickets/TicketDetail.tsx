// Detalhe do protocolo: estado em pílulas, categoria, responsável, prazo,
// linha do tempo e "Registrar andamento" fixo embaixo (web/DESIGN.md §6).
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  FileText,
  Lock,
  MessageCircle,
  Send,
  Trash2,
} from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { useCompact } from "../app/hooks";
import { useIntents, type Row } from "../lib/api";
import { conversationName, date, phone, whenLabel } from "../lib/format";
import { navigate } from "../lib/routes";
import {
  categoryName,
  enabledCategories,
  ticketActive,
  ticketDeadline,
  ticketStateName,
  ticketStateTone,
  ticketStates,
} from "../lib/tickets";
import {
  Avatar,
  Button,
  Confirm,
  CopyButton,
  Empty,
  IconButton,
  Notice,
  SkeletonBlock,
  toast,
} from "../ui";
import { MessageInput } from "../ui/chat";
import { DeadlineBadge } from "./TicketCard";

const pad = (value: number) => String(value).padStart(2, "0");
/** Milissegundos → valor de <input type="datetime-local"> no fuso do navegador. */
function toLocalInput(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TicketDetail({
  id,
  onChanged,
}: {
  id: string;
  /** Avisa a lista para recarregar depois de uma alteração. */
  onChanged: () => void;
}) {
  const app = useApp();
  const compact = useCompact();
  const write = useIntents(app.api);
  const [data, setData] = useState<Row | null>(null),
    [loadError, setLoadError] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [text, setText] = useState(""),
    [confirm, setConfirm] = useState(""),
    [editingDue, setEditingDue] = useState(false),
    [due, setDue] = useState("");
  const current = useRef(id);
  current.current = id;

  const load = useCallback(async () => {
    const wanted = id;
    try {
      const next = await app.api(`${app.root}/tickets/${encodeURIComponent(id)}`);
      if (current.current !== wanted) return;
      setData(next);
      setLoadError("");
    } catch (e: any) {
      if (current.current === wanted) setLoadError(e.message);
    }
  }, [app.api, app.root, id]);

  useEffect(() => {
    setData(null);
    setLoadError("");
    setError("");
    setText("");
    setEditingDue(false);
    void load();
  }, [id, load]);
  useAppEvents((events) => {
    if (
      events.some(
        (event) =>
          event.kind === "resync" ||
          (event.kind.startsWith("ticket.") && event.resource_id === id),
      )
    )
      void load();
  });

  const ticket: Row | null = data?.ticket || null;
  const conversation: Row | null = data?.conversation || null;

  async function patch(body: Row, key: string, success: string) {
    if (app.demoBlocked()) return false;
    setBusy(key);
    setError("");
    try {
      await write(`${app.root}/tickets/${encodeURIComponent(id)}`, "PATCH", body);
      toast(success);
      await load();
      app.refreshTickets();
      onChanged();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  const header = (
    <header className="pane-header ticket-header">
      {compact && (
        <IconButton label="Voltar" onClick={() => navigate({ area: "tickets" })}>
          <ArrowLeft size={20} />
        </IconButton>
      )}
      <div className="ticket-header-title">
        <span className="ticket-number">{ticket?.number || "Protocolo"}</span>
        {ticket && <CopyButton value={ticket.number} label="Copiar número" />}
      </div>
      {conversation &&
        (compact ? (
          <IconButton
            label="Abrir conversa"
            onClick={() =>
              navigate({ area: "conversations", id: conversation.id })
            }
          >
            <MessageCircle size={20} />
          </IconButton>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<MessageCircle size={15} />}
            onClick={() =>
              navigate({ area: "conversations", id: conversation.id })
            }
          >
            Abrir conversa
          </Button>
        ))}
    </header>
  );

  if (!ticket)
    return (
      <>
        {header}
        <div className="pane-scroll ticket-body">
          {loadError ? (
            <Empty
              icon={<FileText size={28} />}
              title="Não foi possível abrir o protocolo"
              description={loadError}
              action={<Button onClick={() => void load()}>Tentar de novo</Button>}
            />
          ) : (
            <>
              <SkeletonBlock height={210} />
              <SkeletonBlock height={160} />
            </>
          )}
        </div>
      </>
    );

  const canEdit = app.isAdmin || ticket.owner === app.me.id;
  const active = ticketActive(ticket);
  const deadline = ticketDeadline(ticket, app.now);
  const dueEditable = canEdit && active && !ticket.first_response_at;
  const categories = enabledCategories(app.settings);
  const categoryOptions = [
    ...categories,
    ...(ticket.category &&
    !categories.some((item) => item.id === ticket.category)
      ? [
          {
            id: ticket.category,
            name: categoryName(app.settings, ticket.category) + " (removida)",
          },
        ]
      : []),
  ];
  const people = app.team.filter((item) => item.kind === "user");
  const ownerKnown = people.some((item) => item.id === ticket.owner);
  const updates: Row[] = [...(data?.updates || [])].sort(
    (a, b) => a.created - b.created,
  );
  const stateOptions: string[] = ticketStates.includes(ticket.status)
    ? [...ticketStates]
    : [ticket.status, ...ticketStates];

  const changeState = (status: string) => {
    if (status === ticket.status) return;
    if (active && ["resolved", "closed"].includes(status)) setConfirm(status);
    else
      void patch({ status }, "status", `Estado: ${ticketStateName(status)}.`);
  };
  const sendProgress = async () => {
    const value = text.trim();
    if (!value || busy) return;
    if (await patch({ text: value }, "text", "Andamento registrado."))
      setText("");
  };

  return (
    <>
      {header}
      <div className="pane-scroll ticket-body">
        {error && (
          <Notice tone="error" onClose={() => setError("")}>
            {error}
          </Notice>
        )}
        {!canEdit && (
          <Notice>
            Somente o responsável ou um administrador altera este protocolo.
          </Notice>
        )}
        <section className="card ticket-summary">
          <h2 className="ticket-detail-title">{ticket.title}</h2>
          <div
            className="state-options"
            role="radiogroup"
            aria-label="Estado do protocolo"
          >
            {stateOptions.map((status) => (
              <button
                key={status}
                type="button"
                role="radio"
                aria-checked={status === ticket.status}
                className={"state-option tone-" + ticketStateTone(status)}
                disabled={
                  !canEdit ||
                  !!busy ||
                  !(ticketStates as readonly string[]).includes(status)
                }
                onClick={() => changeState(status)}
              >
                {ticketStateName(status)}
              </button>
            ))}
          </div>
          <div className="ticket-fields">
            <label className="field">
              <span>Categoria</span>
              <select
                value={ticket.category || ""}
                disabled={!canEdit || !!busy}
                onChange={(event) =>
                  void patch(
                    { category: event.target.value || null },
                    "category",
                    event.target.value
                      ? "Categoria alterada."
                      : "Categoria removida.",
                  )
                }
              >
                <option value="">Sem categoria</option>
                {categoryOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Responsável</span>
              <select
                value={ticket.owner || ""}
                disabled={!canEdit || !!busy}
                onChange={(event) =>
                  event.target.value &&
                  void patch(
                    { owner: event.target.value },
                    "owner",
                    "Responsável alterado.",
                  )
                }
              >
                {!ticket.owner && <option value="">Sem responsável</option>}
                {ticket.owner && !ownerKnown && (
                  <option value={ticket.owner}>
                    {app.names[ticket.owner] || "Pessoa indisponível"}
                  </option>
                )}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                    {person.id === app.me.id ? " (você)" : ""}
                    {person.online ? " · online" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ticket-due">
            <div className="ticket-due-main">
              <span className="ticket-due-label">Prazo da primeira resposta</span>
              <DeadlineBadge deadline={deadline} size={28} />
              {ticket.response_due_at ? (
                <small className="muted">{date(ticket.response_due_at)}</small>
              ) : null}
            </div>
            {dueEditable && !editingDue && (
              <Button
                variant="secondary"
                size="sm"
                icon={<CalendarClock size={15} />}
                onClick={() => {
                  setDue(
                    ticket.response_due_at
                      ? toLocalInput(ticket.response_due_at)
                      : "",
                  );
                  setEditingDue(true);
                }}
              >
                Alterar prazo
              </Button>
            )}
          </div>
          {editingDue && dueEditable && (
            <form
              className="ticket-due-editor"
              onSubmit={async (event) => {
                event.preventDefault();
                const value = Date.parse(due);
                if (!Number.isFinite(value)) return;
                if (
                  await patch(
                    { response_due_at: value },
                    "due",
                    "Prazo alterado.",
                  )
                )
                  setEditingDue(false);
              }}
            >
              <label className="field">
                <span>Novo prazo</span>
                <input
                  type="datetime-local"
                  value={due}
                  onChange={(event) => setDue(event.target.value)}
                  required
                />
                <small>
                  Só pode ser alterado antes da primeira resposta e enquanto o
                  protocolo está ativo.
                </small>
              </label>
              <div className="card-actions">
                <Button type="submit" size="sm" busy={busy === "due"} disabled={!due}>
                  Salvar prazo
                </Button>
                {ticket.response_due_at ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="danger"
                    icon={<Trash2 size={14} />}
                    disabled={!!busy}
                    onClick={async () => {
                      if (
                        await patch(
                          { response_due_at: null },
                          "due",
                          "Prazo removido.",
                        )
                      )
                        setEditingDue(false);
                    }}
                  >
                    Remover prazo
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => setEditingDue(false)}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          )}
          {conversation && (
            <div className="ticket-customer">
              <Avatar
                name={conversationName(conversation)}
                seed={conversation.id}
                size={40}
              />
              <div>
                <strong className="truncate">
                  {conversationName(conversation)}
                </strong>
                <small className="muted">
                  {conversation.phone &&
                  phone(conversation.phone) !== conversationName(conversation)
                    ? phone(conversation.phone)
                    : "Cliente deste protocolo"}
                </small>
              </div>
              <small className="muted ticket-opened">
                Aberto em {date(ticket.created)}
              </small>
            </div>
          )}
        </section>
        <section className="card ticket-timeline-card">
          <h2>Andamentos</h2>
          <ol className="timeline">
            <li className="timeline-item start">
              <span className="timeline-dot" aria-hidden />
              <div>
                <span className="timeline-head">
                  <strong>Protocolo aberto</strong>
                  <time>{whenLabel(ticket.created, app.now)}</time>
                </span>
              </div>
            </li>
            {updates.map((update) => {
              const author = update.actor || update.author;
              return (
                <li
                  key={update.id}
                  className={
                    "timeline-item" + (update.internal ? " internal" : "")
                  }
                >
                  <span className="timeline-dot" aria-hidden>
                    {update.internal ? <Lock size={10} /> : null}
                  </span>
                  <div>
                    <span className="timeline-head">
                      <strong>
                        {author === app.me.id
                          ? "Você"
                          : app.names[author] ||
                            (author === "system" ? "Sistema" : "Equipe")}
                      </strong>
                      {update.internal ? (
                        <span className="timeline-internal">
                          <Lock size={11} /> Interno
                        </span>
                      ) : null}
                      <time>{whenLabel(update.created, app.now)}</time>
                    </span>
                    <p>{update.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          {!updates.length && (
            <p className="muted timeline-empty">
              Nenhum andamento registrado ainda.
            </p>
          )}
        </section>
      </div>
      <footer className="chat-footer ticket-footer">
        <div className="composer">
          <div className="composer-field">
            <MessageInput
              value={text}
              onChange={setText}
              onSend={() => void sendProgress()}
              placeholder="Registrar andamento"
              label="Registrar andamento"
              disabled={!canEdit || busy === "text"}
              maxLength={4000}
            />
          </div>
          <button
            type="button"
            className="composer-send"
            aria-label="Enviar andamento"
            title="Enviar andamento"
            disabled={!canEdit || !text.trim() || !!busy}
            onClick={() => void sendProgress()}
          >
            <Send size={19} />
          </button>
        </div>
        <p className="ticket-footer-hint">
          O cliente recebe como “Protocolo {ticket.number}: texto”.
        </p>
      </footer>
      {confirm && (
        <Confirm
          title={
            confirm === "resolved"
              ? "Marcar como resolvido?"
              : "Encerrar o protocolo?"
          }
          confirmLabel={ticketStateName(confirm)}
          busy={busy === "status"}
          onClose={() => setConfirm("")}
          onConfirm={async () => {
            const status = confirm;
            await patch(
              { status },
              "status",
              `Estado: ${ticketStateName(status)}.`,
            );
            setConfirm("");
          }}
        >
          <p>
            O protocolo {ticket.number} deixa de contar como ativo: sai dos
            alertas de prazo e a conversa pode receber um novo protocolo
            automático.
          </p>
        </Confirm>
      )}
    </>
  );
}
