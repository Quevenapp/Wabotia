// Protocolos: lista de cartões à esquerda e detalhe à direita
// (web/DESIGN.md §6, docs/CENTRAL-ATENDIMENTO.md §2 e §3).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus, UserRound } from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { ListHeader } from "../app/chrome";
import type { Row } from "../lib/api";
import { navigate } from "../lib/routes";
import { enabledCategories, ticketActive } from "../lib/tickets";
import {
  Button,
  Chip,
  Empty,
  IconButton,
  Notice,
  SearchBox,
  SkeletonRows,
  type PillTone,
} from "../ui";
import { NewTicketDialog } from "./NewTicketDialog";
import { TicketCard } from "./TicketCard";
import { TicketDetail } from "./TicketDetail";
import "../styles/tickets.css";

type FilterId =
  | "active"
  | "open"
  | "in_progress"
  | "waiting"
  | "overdue"
  | "done"
  | "all";

const filters: {
  id: FilterId;
  label: string;
  query: string;
  tone?: PillTone;
  empty: [string, string];
}[] = [
  {
    id: "active",
    label: "Ativos",
    query: "active=1",
    empty: [
      "Nenhum protocolo ativo",
      "Solicitações novas e em andamento aparecem aqui.",
    ],
  },
  {
    id: "open",
    label: "Recebidos",
    query: "status=open",
    empty: ["Nada aguardando análise", "Protocolos recém-abertos aparecem aqui."],
  },
  {
    id: "in_progress",
    label: "Em análise",
    query: "status=in_progress",
    empty: ["Nenhum protocolo em análise", "Mude o estado para acompanhar aqui."],
  },
  {
    id: "waiting",
    label: "Aguardando",
    query: "status=waiting_customer,waiting_third",
    empty: [
      "Nada aguardando retorno",
      "Protocolos que dependem do cliente ou de terceiros aparecem aqui.",
    ],
  },
  {
    id: "overdue",
    label: "Atrasados",
    query: "overdue=1",
    tone: "danger",
    empty: ["Nenhum protocolo atrasado", "Todos os prazos estão em dia. Bom trabalho!"],
  },
  {
    id: "done",
    label: "Resolvidos",
    query: "status=resolved,closed",
    empty: [
      "Nenhum protocolo resolvido",
      "Protocolos resolvidos e encerrados ficam guardados aqui.",
    ],
  },
  {
    id: "all",
    label: "Todos",
    query: "",
    empty: [
      "Solicitações acompanhadas do começo ao fim",
      "Abra um protocolo a partir de uma conversa. Solicitações sem pessoas disponíveis também geram protocolos.",
    ],
  },
];

/** "7" ou "100+" quando a contagem passou do que uma consulta devolve. */
const countText = (count: number, more: boolean) =>
  count ? count + (more ? "+" : "") : "";

export function TicketsArea({ id }: { id?: string }) {
  const app = useApp();
  const [filter, setFilter] = useState<FilterId>("active"),
    [category, setCategory] = useState(""),
    [mine, setMine] = useState(false),
    [search, setSearch] = useState(""),
    [rows, setRows] = useState<Row[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [counts, setCounts] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const categories = enabledCategories(app.settings);
  const current = filters.find((item) => item.id === filter)!;

  useEffect(() => {
    // Ctrl+K e "/" focam esta busca (a casca procura por este atributo).
    searchRef.current?.setAttribute("data-global-search", "");
  }, []);

  const queryString = useCallback(
    (after = "") =>
      [
        "limit=100",
        current.query,
        category ? "category=" + encodeURIComponent(category) : "",
        search.trim() ? "q=" + encodeURIComponent(search.trim()) : "",
        after ? "cursor=" + encodeURIComponent(after) : "",
      ]
        .filter(Boolean)
        .join("&"),
    [current.query, category, search],
  );

  /** Carrega do início. A API pagina por id; aqui reunimos até 300 e ordenamos. */
  const load = useCallback(async () => {
    const mark = ++request.current;
    try {
      let all: Row[] = [],
        after: string | null = "";
      for (let page = 0; page < 3 && after !== null; page++) {
        const result: Row = await app.api(
          `${app.root}/tickets?${queryString(after)}`,
        );
        if (mark !== request.current) return;
        all = all.concat(result.data || []);
        after = result.next_cursor || null;
      }
      setRows(all);
      setCursor(after);
      setError("");
    } catch (e: any) {
      if (mark === request.current) setError(e.message);
    }
  }, [app.api, app.root, queryString]);

  const loadCounts = useCallback(async () => {
    try {
      const [active, overdue, done] = await Promise.all(
        ["active=1", "overdue=1", "status=resolved,closed"].map((query) =>
          app.api(`${app.root}/tickets?limit=100&${query}`),
        ),
      );
      const activeRows: Row[] = (active.data || []).filter(ticketActive),
        more = !!active.next_cursor;
      const by = (states: string[]) =>
        activeRows.filter((ticket) => states.includes(ticket.status)).length;
      setCounts({
        active: countText(activeRows.length, more),
        open: countText(by(["open"]), more),
        in_progress: countText(by(["in_progress"]), more),
        waiting: countText(by(["waiting_customer", "waiting_third"]), more),
        overdue: countText(
          (overdue.data || []).filter(ticketActive).length,
          !!overdue.next_cursor,
        ),
        done: countText((done.data || []).length, !!done.next_cursor),
      });
    } catch {
      /* os contadores são um complemento da lista */
    }
  }, [app.api, app.root]);

  // Trocar de chip ou de categoria mostra o esqueleto; a busca mantém a lista.
  useEffect(() => {
    setRows(null);
    setCursor(null);
  }, [filter, category]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load]);
  const latest = useRef({ load, loadCounts });
  latest.current = { load, loadCounts };
  const reload = useCallback(() => {
    void latest.current.load();
    void latest.current.loadCounts();
  }, []);
  useEffect(() => {
    void loadCounts();
    const timer = setInterval(() => !document.hidden && reload(), 60_000);
    return () => clearInterval(timer);
  }, [loadCounts, reload]);
  useAppEvents((events) => {
    if (
      events.some(
        (event) => event.kind.startsWith("ticket.") || event.kind === "resync",
      )
    )
      reload();
  });

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const mark = request.current;
    setLoadingMore(true);
    try {
      const result = await app.api(`${app.root}/tickets?${queryString(cursor)}`);
      if (mark !== request.current) return;
      setRows((existing) => [...(existing || []), ...(result.data || [])]);
      setCursor(result.next_cursor || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = useMemo(() => {
    const list = (rows || []).filter(
      (ticket) => !mine || ticket.owner === app.me.id,
    );
    // Atrasados: o mais antigo primeiro. Demais: abertos por último em cima.
    return filter === "overdue"
      ? list.sort((a, b) => (a.response_due_at || 0) - (b.response_due_at || 0))
      : list.sort((a, b) => (b.created || 0) - (a.created || 0));
  }, [rows, mine, filter, app.me.id]);

  return (
    <div className={"area tickets-area" + (id ? " detail-open" : "")}>
      <section className="list-pane" aria-label="Lista de protocolos">
        <ListHeader
          title="Protocolos"
          actions={
            <IconButton
              label="Novo protocolo"
              onClick={() => setCreating(true)}
            >
              <Plus size={21} />
            </IconButton>
          }
        />
        <div className="list-toolbar">
          <SearchBox
            ref={searchRef}
            value={search}
            onChange={setSearch}
            placeholder="Número do protocolo ou telefone"
            label="Buscar protocolos"
          />
          <div className="chip-row" role="group" aria-label="Filtrar por estado">
            {filters.map((item) => (
              <Chip
                key={item.id}
                active={filter === item.id}
                tone={item.tone}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                {counts[item.id] ? <b> {counts[item.id]}</b> : null}
              </Chip>
            ))}
          </div>
          <div className="ticket-filters">
            <Chip
              active={mine}
              onClick={() => setMine(!mine)}
              icon={<UserRound size={14} />}
            >
              Meus
            </Chip>
            {(categories.length > 0 || category) && (
              <select
                className="ticket-category-filter"
                aria-label="Filtrar por categoria"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">Todas as categorias</option>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="pane-scroll">
          {error && (
            <div className="ticket-list-notice">
              <Notice tone="error" onRetry={reload}>
                {error}
              </Notice>
            </div>
          )}
          {rows === null && !error ? (
            <SkeletonRows rows={6} avatar={false} />
          ) : visible.length ? (
            <div className="ticket-list">
              {visible.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  selected={ticket.id === id}
                />
              ))}
              {cursor && (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={loadingMore}
                  onClick={() => void loadMore()}
                >
                  Carregar mais
                </Button>
              )}
            </div>
          ) : rows !== null ? (
            <Empty
              icon={<FileText size={28} />}
              title={
                search.trim()
                  ? "Nenhum protocolo encontrado"
                  : mine
                    ? "Nenhum protocolo com você"
                    : current.empty[0]
              }
              description={
                search.trim()
                  ? "Confira o número (WA-…) ou o telefone do cliente."
                  : mine
                    ? "Desligue “Meus” para ver os protocolos de toda a equipe."
                    : current.empty[1]
              }
              action={
                cursor ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    Procurar em mais protocolos
                  </Button>
                ) : undefined
              }
            />
          ) : null}
        </div>
      </section>
      <section className="main-pane ticket-pane" aria-label="Protocolo">
        {id ? (
          <TicketDetail key={id} id={id} onChanged={reload} />
        ) : (
          <div className="pane-empty">
            <span className="empty-icon">
              <FileText size={30} />
            </span>
            <h2>Protocolos</h2>
            <p>
              Selecione um protocolo para ver o estado, o prazo e os andamentos,
              ou abra um novo a partir de uma conversa.
            </p>
            <Button icon={<Plus size={17} />} onClick={() => setCreating(true)}>
              Novo protocolo
            </Button>
          </div>
        )}
      </section>
      {creating && (
        <NewTicketDialog
          onClose={() => setCreating(false)}
          onCreated={(ticket) => {
            reload();
            if (ticket?.id) navigate({ area: "tickets", id: ticket.id });
          }}
        />
      )}
    </div>
  );
}
