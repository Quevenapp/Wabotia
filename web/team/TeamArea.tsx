// Equipe: presença, conversas internas, pessoas, bots e setores
// (web/DESIGN.md §7, mobile/DESIGN.md §9). Absorve as antigas páginas
// "Disponibilidade" e "Conversa interna".
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Building2, ListChecks, MessagesSquare, Terminal, Users } from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { ListHeader } from "../app/chrome";
import { usePolling } from "../app/hooks";
import { useIntents, type Row } from "../lib/api";
import { listTime, plural } from "../lib/format";
import { linkProps, navigate, teamSegments } from "../lib/routes";
import {
  Avatar,
  CountBadge,
  Empty,
  IconButton,
  Notice,
  Pill,
  SearchBox,
  Segmented,
  SkeletonRows,
  Switch,
  toastError,
} from "../ui";
import { BotConsole } from "./BotConsole";
import { InternalChat } from "./InternalChat";
import { botLinesText, peekBotContext, readPreviews } from "./shared";
import "../styles/team.css";

type Segment = (typeof teamSegments)[number];
const RUNS = "execucoes";

export function TeamArea({ sub, id }: { sub?: string; id?: string }) {
  const app = useApp();
  const write = useIntents(app.api);
  const consoleOpen = sub === "bots" && !!id;
  const chatId = !consoleOpen ? id : undefined;
  const [segment, setSegment] = useState<Segment>(
    (teamSegments as readonly string[]).includes(sub || "")
      ? (sub as Segment)
      : "conversas",
  );
  const [query, setQuery] = useState(""),
    [chats, setChats] = useState<Row[] | null>(null),
    [presence, setPresence] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [opening, setOpening] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.setAttribute("data-global-search", "");
  }, []);
  // O endereço escolhe o segmento quando não há conversa aberta.
  useEffect(() => {
    if (sub && (teamSegments as readonly string[]).includes(sub) && (!id || sub === "bots"))
      setSegment(sub as Segment);
  }, [sub, id]);
  // "Consultar bot" na conversa: abre o console do atendente (ou do primeiro bot).
  useEffect(() => {
    if (consoleOpen || !peekBotContext() || !app.bots.length) return;
    const bot =
      app.bots.find((item) => item.id === app.settings.attendant_bot) ||
      app.bots.find((item) => item.enabled) ||
      app.bots[0];
    navigate({ area: "team", sub: "bots", id: bot.id }, { replace: true });
  }, [consoleOpen, app.bots, app.settings.attendant_bot]);

  const loadChats = useCallback(async () => {
    try {
      const result = await app.api(app.root + "/internal-chats");
      setChats(result.data || []);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [app.api, app.root]);
  // O diretório (app.team) é relido pela casca a cada 20 s; aqui ficam as
  // conversas internas e a presença de cada pessoa.
  usePolling(
    () => {
      void loadChats();
      app
        .api(app.root + "/presence")
        .then((rows) => setPresence(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    },
    20_000,
    [loadChats, app.api, app.root],
  );
  useAppEvents((events) => {
    if (
      events.some(
        (event) => event.kind === "internal.message" || event.kind === "resync",
      )
    )
      void loadChats();
  });

  const previews = useMemo(
    () => readPreviews(app.profile),
    [app.profile, chats, chatId],
  );
  const matches = (name: string) =>
    String(name || "")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const people = app.team.filter((item) => item.kind === "user"),
    bots = app.team.filter((item) => item.kind === "bot"),
    departments: Row[] = app.settings.departments || [];

  async function openPeer(peer: Row) {
    if (opening) return;
    const existing = (chats || []).find((chat) => chat.peer?.id === peer.id);
    if (existing) {
      navigate({ area: "team", sub: "conversas", id: existing.id });
      return;
    }
    if (app.demoBlocked()) return;
    setOpening(peer.id);
    try {
      const chat = await write(app.root + "/internal-chats", "POST", {
        peer_id: peer.id,
      });
      await loadChats();
      navigate({ area: "team", sub: "conversas", id: chat.id });
    } catch (e) {
      toastError(e, () => void openPeer(peer));
    } finally {
      setOpening("");
    }
  }
  const changeSegment = (next: Segment) => {
    setSegment(next);
    setQuery("");
    // Com conversa aberta, só a lista muda; sem ela, o endereço acompanha.
    if (!chatId && !consoleOpen)
      navigate({ area: "team", sub: next }, { replace: true });
  };

  const internalTotal = Object.values(app.internalUnread).reduce(
    (sum, value) => sum + value,
    0,
  );
  const visibleChats = (chats || []).filter((chat) =>
    matches(chat.peer?.name || ""),
  );

  return (
    <div
      className={"area team-area" + (chatId || consoleOpen ? " detail-open" : "")}
    >
      <section className="list-pane" aria-label="Equipe">
        <ListHeader title="Equipe" presence={false} />
        <div className="presence-card">
          <Avatar name={app.me.name} seed={app.me.id} size={52} online={app.online} />
          <div>
            <strong>
              {app.online ? "Você está online" : "Você está offline"}
            </strong>
            <small>
              {plural(app.peopleOnline, "pessoa online", "pessoas online")} ·{" "}
              {plural(app.botsOnline, "bot ativo", "bots ativos")}
            </small>
            {!app.online && (
              <small>Offline: novos atendimentos não são encaminhados a você.</small>
            )}
          </div>
          <Switch
            label="Presença no atendimento"
            checked={app.online}
            busy={app.presenceBusy}
            onChange={(next) => void app.setOnline(next)}
          />
        </div>
        <div className="list-toolbar">
          <Segmented<Segment>
            label="Seções de Equipe"
            value={segment}
            onChange={changeSegment}
            full
            options={[
              { value: "conversas", label: "Conversas", count: internalTotal },
              { value: "pessoas", label: "Pessoas" },
              { value: "bots", label: "Bots" },
              { value: "setores", label: "Setores" },
            ]}
          />
          <SearchBox
            ref={searchRef}
            value={query}
            onChange={setQuery}
            placeholder={
              segment === "setores"
                ? "Buscar setor"
                : segment === "bots"
                  ? "Buscar bot"
                  : "Buscar pessoa ou bot"
            }
          />
        </div>
        <div className="pane-scroll" role="tabpanel">
          {error && segment === "conversas" && (
            <div className="team-list-notice">
              <Notice tone="error" onRetry={() => void loadChats()}>
                {error}
              </Notice>
            </div>
          )}
          {segment === "conversas" &&
            (chats === null && !error ? (
              <SkeletonRows rows={4} />
            ) : visibleChats.length ? (
              <ul className="team-list">
                {visibleChats.map((chat) => {
                  const peer =
                    app.team.find((item) => item.id === chat.peer?.id) ||
                    chat.peer ||
                    {};
                  const preview = previews[chat.id];
                  const unread = app.internalUnread[chat.id] || 0;
                  return (
                    <li key={chat.id}>
                      <a
                        {...linkProps({
                          area: "team",
                          sub: "conversas",
                          id: chat.id,
                        })}
                        className={
                          "team-row" + (chat.id === chatId ? " selected" : "")
                        }
                        aria-current={chat.id === chatId ? "true" : undefined}
                      >
                        <Avatar
                          name={peer.name || "?"}
                          seed={peer.id}
                          kind={peer.kind === "bot" ? "bot" : "person"}
                          online={!!peer.online}
                        />
                        <span className="team-row-text">
                          <strong className="truncate">
                            {peer.name || "Contato indisponível"}
                          </strong>
                          <small className="truncate">
                            {preview
                              ? (preview.author === app.me.id ? "Você: " : "") +
                                preview.text
                              : peer.kind === "bot"
                                ? "Conversa com bot"
                                : "Conversa interna"}
                          </small>
                        </span>
                        <span className="team-row-side">
                          <time className={unread ? "unread" : ""}>
                            {listTime(chat.updated, app.now)}
                          </time>
                          <CountBadge
                            count={unread}
                            label={`${unread} não lidas`}
                          />
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : chats !== null ? (
              <Empty
                icon={<MessagesSquare size={28} />}
                title={
                  query ? "Nenhuma conversa encontrada" : "Nenhuma conversa interna"
                }
                description="Escolha alguém em Pessoas ou um bot em Bots para começar. As mensagens ficam dentro do Wabotia."
              />
            ) : null)}
          {segment === "pessoas" &&
            (people.length ? (
              <ul className="team-list">
                {people.filter((person) => matches(person.name)).map((person) => {
                  const me = person.id === app.me.id;
                  const info = (
                    <>
                      <Avatar
                        name={person.name}
                        seed={person.id}
                        online={!!person.online}
                      />
                      <span className="team-row-text">
                        <strong className="truncate">
                          {person.name}
                          {me ? " (você)" : ""}
                        </strong>
                        <small className="truncate">
                          {person.online ? "Online" : "Offline"}
                        </small>
                      </span>
                    </>
                  );
                  return (
                    <li key={person.id}>
                      {me ? (
                        <div className="team-row static">{info}</div>
                      ) : (
                        <button
                          type="button"
                          className="team-row"
                          disabled={!!opening}
                          aria-busy={opening === person.id}
                          onClick={() => void openPeer(person)}
                          title={"Conversar com " + person.name}
                        >
                          {info}
                          <span className="team-row-side">
                            <MessagesSquare size={18} aria-hidden />
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <SkeletonRows rows={3} />
            ))}
          {segment === "bots" && (
            <>
              <ul className="team-list">
                {bots.filter((bot) => matches(bot.name)).map((bot) => (
                  <li key={bot.id} className="team-row-with-action">
                    <button
                      type="button"
                      className="team-row"
                      disabled={!!opening}
                      aria-busy={opening === bot.id}
                      onClick={() => void openPeer(bot)}
                      title={"Conversar com " + bot.name}
                    >
                      <Avatar
                        name={bot.name}
                        seed={bot.id}
                        kind="bot"
                        online={!!bot.online}
                      />
                      <span className="team-row-text">
                        <strong className="truncate">{bot.name}</strong>
                        <small className="truncate">
                          {bot.online ? "Disponível" : "Indisponível"} ·{" "}
                          {botLinesText(bot.line_ids)}
                        </small>
                      </span>
                    </button>
                    <IconButton
                      label={"Console de " + bot.name}
                      active={consoleOpen && id === bot.bot_id}
                      onClick={() =>
                        navigate({ area: "team", sub: "bots", id: bot.bot_id })
                      }
                    >
                      <Terminal size={18} />
                    </IconButton>
                  </li>
                ))}
              </ul>
              {!bots.length && (
                <Empty
                  icon={<Bot size={28} />}
                  title="Nenhum bot nesta área"
                  description="Os bots aparecem aqui depois de conectar o Hermes em Gestão."
                />
              )}
              <a
                {...linkProps({ area: "team", sub: "bots", id: RUNS })}
                className={
                  "team-row team-runs-link" +
                  (consoleOpen && id === RUNS ? " selected" : "")
                }
              >
                <span className="team-icon">
                  <ListChecks size={22} />
                </span>
                <span className="team-row-text">
                  <strong>Execuções recentes</strong>
                  <small className="truncate">
                    Pedidos feitos aos bots e seus resultados
                  </small>
                </span>
              </a>
            </>
          )}
          {segment === "setores" &&
            (departments.length ? (
              <ul className="team-list">
                {departments
                  .filter((department) => matches(department.name))
                  .map((department) => {
                    const members: Row[] = (department.members || [])
                      .map((member: string) =>
                        people.find((person) => person.id === member),
                      )
                      .filter(Boolean);
                    const online = members.filter((member) => member.online).length;
                    return (
                      <li key={department.id}>
                        <div className="team-row static">
                          <span className="team-icon">
                            <Building2 size={22} />
                          </span>
                          <span className="team-row-text">
                            <strong className="truncate">{department.name}</strong>
                            <small className="truncate">
                              {members.length
                                ? `${online} de ${members.length} online`
                                : "Sem pessoas neste setor"}
                            </small>
                          </span>
                          <span className="team-row-side">
                            {department.enabled === false ? (
                              <Pill tone="muted">Desativado</Pill>
                            ) : (
                              <span className="avatar-stack">
                                {members.slice(0, 4).map((member) => (
                                  <Avatar
                                    key={member.id}
                                    name={member.name}
                                    seed={member.id}
                                    size={26}
                                  />
                                ))}
                                {members.length > 4 && (
                                  <span className="avatar-more">
                                    +{members.length - 4}
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            ) : (
              <Empty
                icon={<Building2 size={28} />}
                title="Nenhum setor configurado"
                description="Os setores são criados em Gestão → Menus e ações. Sem setores, os encaminhamentos usam a fila geral."
              />
            ))}
        </div>
      </section>
      <section className="main-pane team-pane" aria-label="Conversa interna">
        {consoleOpen ? (
          <BotConsole key={id} botId={id === RUNS ? undefined : id} />
        ) : chatId ? (
          <InternalChat key={chatId} chatId={chatId} onActivity={loadChats} />
        ) : (
          <div className="pane-empty">
            <span className="empty-icon">
              <Users size={30} />
            </span>
            <h2>Sua equipe, em uma conversa</h2>
            <p>
              Selecione uma pessoa ou um bot para conversar internamente. Estas
              mensagens ficam dentro do Wabotia e não são enviadas ao cliente.
            </p>
            <p>
              O estado das pessoas acompanha a disponibilidade de cada uma. Para
              bots, acompanha a habilitação e a conexão com o Hermes.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
