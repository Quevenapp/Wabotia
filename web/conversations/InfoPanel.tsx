// Dados da conversa (mobile/DESIGN.md §7, web/DESIGN.md §4): painel lateral
// com telefone, linha, anel grande da janela, estado, etiquetas, protocolos,
// mídia compartilhada e ações.
import React, { useEffect, useState } from "react";
import {
  Bot,
  CheckCheck,
  FileText,
  Phone,
  Plus,
  ShieldCheck,
  Star,
  Tags,
  Undo2,
  UserPlus,
  UserRoundPen,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import {
  conversationName,
  digits,
  parse,
  phone as formatPhone,
  whenLabel,
} from "../lib/format";
import { linkProps } from "../lib/routes";
import { ticketStateName, ticketStateTone } from "../lib/tickets";
import type { WindowInfo } from "../lib/window";
import {
  Avatar,
  CopyButton,
  Pill,
  SidePanel,
  Spinner,
  WindowRing,
  conversationBadge,
  toast,
  toastError,
} from "../ui";
import { GroupControls } from "../WhatsAppGroups";
import { isImage, mediaUrl } from "./Media";
import { headerSubtitle, isMine, tagsOf } from "./model";

export type InfoActions = {
  contact: () => void;
  tags: () => void;
  ticket: () => void;
  call?: () => void;
  bot: () => void;
  survey: () => void;
  consent: () => void;
  resume: () => void;
  resolve: () => void;
  window: () => void;
  openImage: (id: string) => void;
};

export function InfoPanel({
  detail,
  info,
  busy,
  actions,
  refresh,
  onClose,
  ticketsVersion,
}: {
  detail: Row;
  info: WindowInfo | null;
  busy: boolean;
  actions: InfoActions;
  refresh: () => Promise<any>;
  onClose: () => void;
  /** Muda quando um protocolo é aberto, para reler a lista. */
  ticketsVersion: number;
}) {
  const app = useApp();
  const c = detail.conversation,
    cap: Row = detail.capabilities || {};
  const group = c.chat_type === "group";
  const mine = isMine(c, app.me.id);
  const name =
    detail.contact?.name || conversationName({ ...c, contact_name: c.contact_name });
  const tags = tagsOf(c);
  const [tickets, setTickets] = useState<Row[] | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const number = digits(c.phone || "");

  useEffect(() => {
    let alive = true;
    if (!number) {
      setTickets([]);
      return;
    }
    app
      .api(app.root + "/tickets?limit=100&q=" + encodeURIComponent(number))
      .then(
        (result) =>
          alive &&
          setTickets(
            (result.data || [])
              .filter((ticket: Row) => ticket.conversation_id === c.id)
              .sort((a: Row, b: Row) => (b.created || 0) - (a.created || 0)),
          ),
      )
      .catch(() => alive && setTickets([]));
    return () => {
      alive = false;
    };
  }, [c.id, number, ticketsVersion, app.ticketCounts.active, app.ticketCounts.overdue]);

  const line = (app.status.connections || []).find(
    (connection: Row) => connection.id === c.connection_id,
  );
  const media: Row[] = detail.media || [];
  const images = media.filter((file) => isImage(file.type));
  const others = media.filter((file) => !isImage(file.type));
  const members: Row[] = parse(detail.group?.participants, []);

  return (
    <SidePanel
      title={group ? "Dados do grupo" : "Dados da conversa"}
      onClose={onClose}
      className="info-panel"
    >
      <section className="info-hero">
        <Avatar
          name={name}
          seed={c.id}
          size={96}
          kind={group ? "group" : "person"}
          badge={conversationBadge(c, app.me.id)}
        />
        <h3>{name}</h3>
        {c.phone && !group && (
          <p className="info-phone">
            <span>{formatPhone(c.phone)}</span>
            <CopyButton value={c.phone} label="Copiar telefone" />
          </p>
        )}
        {group && (
          <p className="muted">
            Grupo · {members.length}{" "}
            {members.length === 1 ? "participante" : "participantes"}
          </p>
        )}
        <p className="muted">
          {line ? "Linha " + line.name : c.connection_id ? "Linha de atendimento" : "Sem linha de WhatsApp"}
        </p>
      </section>

      {info && (
        <section className="info-section info-window">
          <button
            type="button"
            className={"info-window-button tone-" + info.tone}
            onClick={actions.window}
            aria-label="Janela de 24 horas. Ver explicação"
          >
            <WindowRing info={info} size={96}>
              <span className="window-ring-text">
                <strong>{info.closed ? "Fechada" : info.long}</strong>
                {!info.closed && <small>restantes</small>}
              </span>
            </WindowRing>
          </button>
          <div>
            <strong>Janela de 24 horas</strong>
            <small>
              {info.lastCustomer
                ? "Última mensagem do cliente: " +
                  whenLabel(info.lastCustomer, app.now)
                : "O cliente ainda não escreveu."}
            </small>
            {!info.closed && <small>Aberta {info.until}</small>}
          </div>
        </section>
      )}

      <section className="info-section">
        <h4>Atendimento</h4>
        <p className="info-state">
          <Pill
            tone={
              c.state === "waiting"
                ? "warn"
                : c.state === "ai"
                  ? "bot"
                  : c.state === "human"
                    ? mine
                      ? "brand"
                      : "muted"
                    : "muted"
            }
          >
            {c.state === "waiting"
              ? "Na fila"
              : c.state === "ai"
                ? "Com o bot"
                : c.state === "human"
                  ? "Com atendente"
                  : "Concluída"}
          </Pill>
          <span>{headerSubtitle(c, app)}</span>
        </p>
      </section>

      <section className="info-section">
        <h4>
          Etiquetas
          <button type="button" className="text-link" onClick={actions.tags}>
            <Tags size={14} /> Editar
          </button>
        </h4>
        <div className="info-tags">
          {tags.length ? (
            tags.map((tag) => (
              <Pill key={tag} tone="brand">
                {tag}
              </Pill>
            ))
          ) : (
            <span className="muted">Nenhuma etiqueta.</span>
          )}
        </div>
      </section>

      <section className="info-section">
        <h4>
          Protocolos desta conversa
          <button type="button" className="text-link" onClick={actions.ticket}>
            <Plus size={14} /> Abrir protocolo
          </button>
        </h4>
        {!tickets ? (
          <Spinner label="Carregando…" />
        ) : tickets.length ? (
          <div className="info-tickets">
            {tickets.map((ticket) => (
              <a
                key={ticket.id}
                className="info-ticket"
                {...linkProps({ area: "tickets", id: ticket.id })}
              >
                <span className="info-ticket-top">
                  <strong className="mono">{ticket.number}</strong>
                  <Pill tone={ticketStateTone(ticket.status)}>
                    {ticketStateName(ticket.status)}
                  </Pill>
                </span>
                <span className="info-ticket-title">{ticket.title}</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="muted">Nenhum protocolo aberto para esta conversa.</p>
        )}
      </section>

      {group && (
        <section className="info-section">
          <h4>Grupo</h4>
          <label className="info-policy">
            <span>Respostas do bot</span>
            <select
              value={c.bot_policy || "mentions"}
              disabled={policyBusy || app.demo}
              onChange={async (event) => {
                setPolicyBusy(true);
                try {
                  await app.api(`${app.root}/groups/${c.id}/policy`, "PUT", {
                    bot_policy: event.target.value,
                  });
                  await refresh();
                  toast("Política do bot atualizada.");
                } catch (e) {
                  toastError(e);
                } finally {
                  setPolicyBusy(false);
                }
              }}
            >
              <option value="off">Somente atendimento humano</option>
              <option value="mentions">Quando mencionada ou /bot</option>
              <option value="all">Todas as mensagens</option>
            </select>
          </label>
          <p className="muted">
            {detail.group?.announcement
              ? "Somente administradores podem enviar."
              : "Participantes podem enviar mensagens."}
          </p>
          {cap.group_manage && !app.demo && (
            <div className="info-group-controls">
              <GroupControls
                api={app.api}
                root={app.root}
                c={c}
                capabilities={cap}
                refresh={refresh}
              />
            </div>
          )}
        </section>
      )}

      <section className="info-section">
        <h4>Mídia compartilhada</h4>
        {media.length ? (
          <>
            {images.length > 0 && (
              <div className="info-media-grid">
                {images.map((file) => (
                  <button
                    type="button"
                    key={file.id}
                    onClick={() => actions.openImage(file.id)}
                    aria-label={"Abrir imagem " + (file.name || "")}
                  >
                    <img
                      src={mediaUrl(app.root, file.id) + "?inline=1"}
                      alt={file.name || "Imagem"}
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}
            {others.map((file) => (
              <a
                key={file.id}
                className="info-file"
                href={mediaUrl(app.root, file.id)}
                download={file.name || true}
              >
                <FileText size={17} />
                <span className="truncate">{file.name || "Anexo"}</span>
              </a>
            ))}
          </>
        ) : (
          <p className="muted">Fotos, áudios e documentos aparecem aqui.</p>
        )}
      </section>

      <section className="info-section info-actions">
        {actions.call && (
          <button type="button" onClick={actions.call}>
            <Phone size={18} /> Ligar
          </button>
        )}
        {!group && (
          <button type="button" onClick={actions.contact}>
            {detail.contact ? <UserRoundPen size={18} /> : <UserPlus size={18} />}
            {detail.contact ? "Editar contato" : "Salvar contato"}
          </button>
        )}
        <button type="button" onClick={actions.bot}>
          <Bot size={18} /> Consultar bot
        </button>
        {!group && (
          <button type="button" disabled={busy} onClick={actions.survey}>
            <Star size={18} /> Pesquisa de satisfação
          </button>
        )}
        {!group && (
          <button type="button" disabled={busy} onClick={actions.consent}>
            <ShieldCheck size={18} /> Solicitar consentimento
          </button>
        )}
        {mine && (
          <button type="button" disabled={busy} onClick={actions.resume}>
            <Undo2 size={18} /> Devolver ao bot
          </button>
        )}
        {mine && (
          <button type="button" className="danger" disabled={busy} onClick={actions.resolve}>
            <CheckCheck size={18} /> Concluir
          </button>
        )}
      </section>
    </SidePanel>
  );
}
