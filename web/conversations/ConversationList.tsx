// Coluna da lista de conversas (mobile/DESIGN.md §4, web/DESIGN.md §3).
import React, { useEffect, useRef, useState } from "react";
import {
  CheckCheck,
  ExternalLink,
  FileText,
  Forward,
  Hand,
  Inbox,
  MailCheck,
  Tags,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { ListHeader } from "../app/chrome";
import type { Row } from "../lib/api";
import { conversationName, listTime, span } from "../lib/format";
import { href, linkProps, navigate } from "../lib/routes";
import { windowInfo } from "../lib/window";
import {
  Avatar,
  Chip,
  CountBadge,
  Empty,
  MenuList,
  Notice,
  Pill,
  SearchBox,
  SkeletonRows,
  Spinner,
  WindowRing,
  conversationBadge,
  type MenuAction,
} from "../ui";
import { Ticks } from "../ui/chat";
import { RingingCard } from "../calls/RingingCard";
import { isMine, ownerText, previewParts, tagsOf, WAIT_WARN_MS } from "./model";
import type { ChipId, ConversationListState } from "./useConversationList";

export type QuickAction =
  | "claim"
  | "take"
  | "transfer"
  | "resolve"
  | "tags"
  | "ticket"
  | "read";

/** O que o estado da conversa e o papel de quem atende permitem. */
export function allowed(row: Row, meId: string, admin: boolean) {
  const mine = isMine(row, meId);
  return {
    claim: row.state !== "human",
    take: row.state === "human" && !mine && admin,
    transfer: mine || admin,
    resolve: mine,
  };
}

const emptyByChip: Record<ChipId, [string, string]> = {
  all: [
    "Sua caixa de entrada está pronta",
    "As mensagens dos canais conectados aparecerão aqui.",
  ],
  waiting: ["Nenhuma conversa na fila", "Bom trabalho! Quem escrever aparece aqui."],
  mine: [
    "Nenhuma conversa com você",
    "Assuma uma conversa da fila para começar a atender.",
  ],
  ai: ["Nenhuma conversa com bots", "Os atendimentos automáticos aparecem aqui."],
  closed: ["Nenhuma conversa concluída", "As conversas encerradas ficam aqui."],
};

function ConversationRow({
  row,
  selected,
  onQuick,
  busy,
  onMenu,
}: {
  row: Row;
  selected: boolean;
  onQuick: (action: QuickAction, row: Row) => void;
  busy: boolean;
  onMenu: (row: Row, at: { x: number; y: number }) => void;
}) {
  const app = useApp();
  const name = conversationName(row);
  const unread = app.unread[row.id] || 0;
  const preview = previewParts(row, app);
  const info = windowInfo(row, app.lineKinds, app.now);
  const tags = tagsOf(row).slice(0, 2);
  const waited = app.now - (row.updated || app.now);
  const waiting = row.state === "waiting" && waited > WAIT_WARN_MS;
  const can = allowed(row, app.me.id, app.isAdmin);
  const group = row.chat_type === "group";
  return (
    <div
      className={
        "conv-row" + (selected ? " selected" : "") + (unread ? " unread" : "")
      }
      role="listitem"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(row, { x: event.clientX, y: event.clientY });
      }}
    >
      <a
        {...linkProps({ area: "conversations", id: row.id })}
        className="conv-link"
        data-conv-id={row.id}
        aria-current={selected ? "true" : undefined}
      >
        <Avatar
          name={name}
          seed={row.id}
          size={48}
          kind={group ? "group" : "person"}
          badge={conversationBadge(row, app.me.id)}
        />
        <span className="conv-body">
          <span className="conv-line">
            <strong className="truncate">{name}</strong>
            <time className={waiting ? "wait" : ""}>
              {waiting
                ? "espera " + span(waited)
                : listTime(row.last_message?.created || row.updated, app.now)}
            </time>
          </span>
          <span className="conv-line">
            <span
              className={
                "conv-preview truncate" +
                (preview.note ? " note" : "") +
                (preview.fallback ? " fallback" : "")
              }
            >
              {preview.ours && <Ticks status={preview.status} size={15} />}
              {preview.icon}
              <span className="truncate">{preview.text}</span>
            </span>
            <span className="conv-side">
              {info && (
                <span className={"conv-window tone-" + info.tone}>
                  <WindowRing info={info} size={22} />
                  {info.compact && <small>{info.compact}</small>}
                </span>
              )}
              <CountBadge
                count={unread}
                label={`${unread} ${unread === 1 ? "mensagem não lida" : "mensagens não lidas"}`}
              />
            </span>
          </span>
          <span className="conv-line conv-meta">
            {tags.map((tag) => (
              <Pill key={tag} tone="muted">
                {tag}
              </Pill>
            ))}
            <span className="truncate">{ownerText(row, app)}</span>
          </span>
        </span>
      </a>
      <div className="conv-quick">
        {(can.claim || can.take) && (
          <button
            type="button"
            title={
              can.take
                ? "Transferir para mim"
                : row.state === "closed"
                  ? "Reabrir e assumir"
                  : "Assumir"
            }
            aria-label={
              (can.take
                ? "Transferir para mim"
                : row.state === "closed"
                  ? "Reabrir e assumir"
                  : "Assumir") +
              ": " +
              name
            }
            disabled={busy}
            onClick={() => onQuick(can.take ? "take" : "claim", row)}
          >
            <Hand size={16} />
          </button>
        )}
        {can.transfer && (
          <button
            type="button"
            title="Transferir"
            aria-label={"Transferir: " + name}
            disabled={busy}
            onClick={() => onQuick("transfer", row)}
          >
            <Forward size={16} />
          </button>
        )}
        {can.resolve && (
          <button
            type="button"
            title="Concluir"
            aria-label={"Concluir: " + name}
            disabled={busy}
            onClick={() => onQuick("resolve", row)}
          >
            <CheckCheck size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ConversationList({
  list,
  selectedId,
  onQuick,
  busyId,
}: {
  list: ConversationListState;
  selectedId?: string;
  onQuick: (action: QuickAction, row: Row) => void;
  busyId: string | null;
}) {
  const app = useApp();
  const search = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ row: Row; at: { x: number; y: number } } | null>(
    null,
  );
  const departments: Row[] = app.settings.departments || [];
  const queue = app.count("waiting");
  const chips: { id: ChipId; label: string; count?: number; warn?: boolean }[] = [
    { id: "all", label: "Todas" },
    { id: "waiting", label: "Fila", count: queue, warn: queue > 0 },
    { id: "mine", label: "Minhas", count: list.mineCount },
    { id: "ai", label: "Bots", count: app.count("ai") },
    { id: "closed", label: "Concluídas" },
  ];

  // Ctrl+K e "/" focam esta busca (a casca procura por este atributo).
  useEffect(() => {
    search.current?.setAttribute("data-global-search", "");
  }, []);
  // Rolagem infinita: carrega a próxima página ao chegar perto do fim.
  const more = useRef(list.loadMore);
  more.current = list.loadMore;
  useEffect(() => {
    if (!sentinel.current || !scroll.current) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && void more.current(),
      { root: scroll.current, rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [list.hasMore]);

  const links = () =>
    Array.from(
      scroll.current?.querySelectorAll<HTMLAnchorElement>("a.conv-link") || [],
    );
  /** ↑/↓ percorrem a lista e abrem a conversa em foco. */
  function move(delta: number, from?: HTMLElement | null) {
    const items = links();
    if (!items.length) return;
    let index = from ? items.indexOf(from as HTMLAnchorElement) : -1;
    if (index < 0)
      index = items.findIndex((item) => item.dataset.convId === selectedId);
    const next =
      items[
        index < 0
          ? delta > 0
            ? 0
            : items.length - 1
          : Math.min(items.length - 1, Math.max(0, index + delta))
      ];
    if (!next) return;
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    const id = next.dataset.convId;
    if (id && id !== selectedId)
      navigate({ area: "conversations", id }, { replace: !!selectedId });
  }

  const menuItems = (row: Row): MenuAction[] => {
    const can = allowed(row, app.me.id, app.isAdmin);
    return [
      {
        label: row.state === "closed" ? "Reabrir e assumir" : "Assumir",
        icon: <Hand size={17} />,
        hidden: !can.claim,
        onSelect: () => onQuick("claim", row),
      },
      {
        label: "Transferir para mim",
        icon: <Hand size={17} />,
        hidden: !can.take,
        onSelect: () => onQuick("take", row),
      },
      {
        label: "Transferir",
        icon: <Forward size={17} />,
        hidden: !can.transfer,
        onSelect: () => onQuick("transfer", row),
      },
      {
        label: "Etiquetas",
        icon: <Tags size={17} />,
        onSelect: () => onQuick("tags", row),
      },
      {
        label: "Abrir protocolo",
        icon: <FileText size={17} />,
        onSelect: () => onQuick("ticket", row),
      },
      {
        label: "Marcar como lida",
        icon: <MailCheck size={17} />,
        hidden: !app.unread[row.id],
        onSelect: () => onQuick("read", row),
      },
      {
        label: "Concluir",
        icon: <CheckCheck size={17} />,
        hidden: !can.resolve,
        onSelect: () => onQuick("resolve", row),
      },
      {
        label: "Abrir em nova aba",
        icon: <ExternalLink size={17} />,
        separator: true,
        onSelect: () =>
          window.open(href({ area: "conversations", id: row.id }), "_blank", "noopener"),
      },
    ];
  };

  const [emptyTitle, emptyText] = emptyByChip[list.chip];
  return (
    <section className="list-pane conv-list" aria-label="Conversas">
      <ListHeader title="Conversas" />
      <div className="list-toolbar">
        <SearchBox
          ref={search}
          value={list.query}
          onChange={list.setQuery}
          placeholder="Buscar cliente ou telefone"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "Escape" && !list.query)
              (event.target as HTMLElement).blur();
          }}
        />
        <div className="chip-row" role="group" aria-label="Filtrar conversas">
          {chips.map((chip) => (
            <Chip
              key={chip.id}
              active={list.chip === chip.id}
              count={chip.count}
              tone={chip.warn ? "warn" : undefined}
              onClick={() => list.setChip(chip.id)}
            >
              {chip.label}
            </Chip>
          ))}
        </div>
        {departments.length > 0 && (
          <label className="conv-department">
            <span>Setor</span>
            <select
              aria-label="Filtrar conversas por setor"
              value={list.department}
              onChange={(event) => list.setDepartment(event.target.value)}
            >
              <option value="">Todos os setores</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <RingingCard />
      <div
        className="pane-scroll"
        ref={scroll}
        role="list"
        aria-label="Lista de conversas"
        aria-busy={list.loading}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const link = (event.target as HTMLElement).closest<HTMLElement>("a.conv-link");
          if (!link) return;
          event.preventDefault();
          move(event.key === "ArrowDown" ? 1 : -1, link);
        }}
      >
        {list.error && (
          <div className="conv-error">
            <Notice tone="error" onRetry={() => void list.load()}>
              {list.error}
            </Notice>
          </div>
        )}
        {list.loading && !list.rows.length ? (
          <SkeletonRows rows={8} />
        ) : list.rows.length ? (
          list.rows.map((row) => (
            <ConversationRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onQuick={onQuick}
              busy={busyId === row.id}
              onMenu={(target, at) => setMenu({ row: target, at })}
            />
          ))
        ) : (
          !list.error && (
            <Empty
              icon={list.search ? undefined : <Inbox size={28} />}
              title={list.search ? "Nada encontrado" : emptyTitle}
              description={
                list.search
                  ? `Nenhuma conversa para “${list.search}” neste filtro.`
                  : emptyText
              }
            />
          )
        )}
        {list.hasMore && (
          <div className="conv-more" ref={sentinel}>
            {list.loadingMore && <Spinner label="Carregando mais conversas…" />}
          </div>
        )}
      </div>
      {menu && (
        <MenuList
          items={menuItems(menu.row)}
          at={menu.at}
          label={"Ações de " + conversationName(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
