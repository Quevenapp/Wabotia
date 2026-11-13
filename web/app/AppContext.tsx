// Estado compartilhado do painel: sessão, área de atendimento, presença,
// equipe, contadores, relógio e o leitor único de eventos (web/DESIGN.md §10).
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Api, type Row } from "../lib/api";
import { readStore, readText, writeStore, writeText } from "../lib/storage";
import { notify, setTitleCount } from "../lib/notifications";
import { conversationName } from "../lib/format";
import { currentRoute, navigate, navigationGuarded } from "../lib/routes";
import { toast, toastError } from "../ui";
import type { PanelMode } from "../workspace-navigation";

export type AppEvent = {
  id: number;
  kind: string;
  resource_id: string;
  payload: Row;
  created: number;
};
type EventListener = (events: AppEvent[]) => void;

export type AppState = {
  demo: boolean;
  api: Api;
  me: Row;
  isAdmin: boolean;
  profiles: Row[];
  profile: string;
  profileName: string;
  /** Prefixo das rotas da área: "v1/profiles/{id}". */
  root: string;
  chooseProfile: (id: string) => void;
  /** Resposta de GET /status: settings, enabled, conversations, connections. */
  status: Row;
  settings: Row;
  statusLoaded: boolean;
  bots: Row[];
  /** Diretório de GET /team (pessoas e bots com presença). */
  team: Row[];
  /** Nome de cada pessoa ou bot por id (inclui "bot:{id}"). */
  names: Record<string, string>;
  /** Tipo de cada linha por id de conexão (para a janela de 24 h). */
  lineKinds: Record<string, string>;
  count: (state: string) => number;
  /** Minha presença no atendimento. */
  online: boolean;
  presenceBusy: boolean;
  setOnline: (next: boolean) => Promise<void>;
  peopleOnline: number;
  botsOnline: number;
  /** Relê status, bots, equipe e presença. */
  refresh: () => Promise<void>;
  /** "Agora" corrigido pelo relógio do servidor; anda de 30 em 30 s. */
  now: number;
  syncClock: (serverNow: number) => void;
  ringingCalls: Row[];
  /** Não lidas por conversa (local, por área de atendimento). */
  unread: Record<string, number>;
  unreadTotal: number;
  markRead: (conversationId: string) => void;
  /** Conversa aberta na tela: mensagens novas nela não contam como não lidas. */
  setOpenConversation: (id: string | null) => void;
  internalUnread: Record<string, number>;
  internalUnreadTotal: number;
  markInternalRead: (chatId: string) => void;
  setOpenInternalChat: (id: string | null) => void;
  /** Protocolos atrasados e ativos (para o trilho e o Início). */
  ticketCounts: { overdue: number; active: number };
  refreshTickets: () => void;
  /** Guarda nome e responsável das conversas vistas, para os avisos. */
  rememberConversations: (rows: Row[]) => void;
  onEvents: (listener: EventListener) => () => void;
  panelMode: PanelMode;
  setPanelMode: (mode: PanelMode) => void;
  /** Sem rede ou servidor fora do ar. */
  offline: boolean;
  reloadSession: () => Promise<void>;
  logout: () => Promise<void>;
  /** Em modo de demonstração avisa e devolve true (nada é salvo). */
  demoBlocked: () => boolean;
};

const Context = createContext<AppState | null>(null);
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error("useApp fora do AppProvider");
  return value;
}

const HIDDEN_PAUSE_MS = 30 * 60_000;

export function AppProvider({
  demo,
  api,
  me,
  profiles,
  offline,
  reloadSession,
  children,
}: {
  demo: boolean;
  api: Api;
  me: Row;
  profiles: Row[];
  offline: boolean;
  reloadSession: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [profile, setProfile] = useState(() => {
    const saved = readText("wabotia:profile");
    return profiles.some((item) => item.id === saved)
      ? saved
      : profiles[0]?.id || "";
  });
  useEffect(() => {
    if (!profiles.some((item) => item.id === profile))
      setProfile(profiles[0]?.id || "");
  }, [profiles]);
  const root = "v1/profiles/" + profile;

  const [status, setStatus] = useState<Row>({});
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [bots, setBots] = useState<Row[]>([]);
  const [team, setTeam] = useState<Row[]>([]);
  const [presence, setPresence] = useState<Row[]>([]);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [ringingCalls, setRingingCalls] = useState<Row[]>([]);
  const [ticketCounts, setTicketCounts] = useState({ overdue: 0, active: 0 });
  const [panelMode, setMode] = useState<PanelMode>(() =>
    readText("wabotia:panel-mode") === "advanced" ? "advanced" : "guided",
  );

  // Relógio único: "agora" do servidor, de 30 em 30 s.
  const clockOffset = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffset.current);
    const timer = setInterval(tick, 30_000);
    const visible = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const syncClock = useCallback((serverNow: number) => {
    if (!serverNow) return;
    const offset = serverNow - Date.now();
    // Só corrige diferenças que mudariam o que a pessoa vê.
    if (Math.abs(offset - clockOffset.current) > 5000) {
      clockOffset.current = offset;
      setNow(Date.now() + offset);
    }
  }, []);

  // --- dados da área ---------------------------------------------------
  const scope = useRef("");
  scope.current = profile;
  const refresh = useCallback(async () => {
    if (!profile) return;
    const current = profile;
    const [nextStatus, nextBots, nextTeam, nextPresence] = await Promise.all([
      api(root + "/status"),
      api(root + "/bots"),
      api(root + "/team").catch(() => ({ data: [] })),
      api(root + "/presence").catch(() => []),
    ]);
    if (scope.current !== current) return;
    setStatus(nextStatus);
    setBots(nextBots.data || nextBots);
    setTeam(nextTeam.data || []);
    setPresence(Array.isArray(nextPresence) ? nextPresence : []);
    setStatusLoaded(true);
  }, [api, root, profile]);
  const refreshTickets = useCallback(() => {
    if (!profile) return;
    const current = profile;
    Promise.all([
      api(root + "/tickets?overdue=1&limit=100"),
      api(root + "/tickets?active=1&limit=100"),
    ])
      .then(([overdue, active]) => {
        if (scope.current !== current) return;
        const activeRows = (active.data || []).filter(
          (ticket: Row) => !["closed", "resolved"].includes(ticket.status),
        );
        setTicketCounts({
          overdue: (overdue.data || []).filter(
            (ticket: Row) => !["closed", "resolved"].includes(ticket.status),
          ).length,
          active: activeRows.length,
        });
        // Aviso de protocolo meu perto do prazo (uma vez por protocolo).
        const warned = readStore<string[]>("wabotia:due-warned", []);
        const soon = activeRows.filter(
          (ticket: Row) =>
            ticket.owner === me.id &&
            !ticket.first_response_at &&
            ticket.response_due_at &&
            ticket.response_due_at - Date.now() < 3600_000 &&
            ticket.response_due_at > Date.now() &&
            !warned.includes(ticket.id),
        );
        if (soon.length) {
          writeStore(
            "wabotia:due-warned",
            [...warned, ...soon.map((ticket: Row) => ticket.id)].slice(-200),
          );
          for (const ticket of soon)
            notify(
              "Protocolo perto do prazo",
              `${ticket.number} · ${ticket.title}`,
              {
                tag: "due:" + ticket.id,
                open: () => navigate({ area: "tickets", id: ticket.id }),
              },
            );
        }
      })
      .catch(() => {});
  }, [api, root, profile, me.id]);

  useEffect(() => {
    setStatus({});
    setStatusLoaded(false);
    setBots([]);
    setTeam([]);
    setPresence([]);
    setRingingCalls([]);
    setTicketCounts({ overdue: 0, active: 0 });
    if (!profile) return;
    writeText("wabotia:profile", profile);
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      refresh().catch(() => {});
    };
    refresh().catch((error) => alive && toastError(error));
    refreshTickets();
    const timer = setInterval(load, 20_000);
    const ticketTimer = setInterval(
      () => !document.hidden && refreshTickets(),
      60_000,
    );
    const visible = () => {
      if (!document.hidden) {
        load();
        refreshTickets();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(ticketTimer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [profile, refresh, refreshTickets]);

  // Ligações tocando (quando o navegador e a linha permitirem áudio).
  useEffect(() => {
    if (!profile || demo) return;
    let alive = true;
    const check = async () => {
      if (document.hidden) return;
      try {
        const result = await api(root + "/calls?limit=30");
        if (alive)
          setRingingCalls(
            (result.data || []).filter(
              (call: Row) =>
                call.status === "ringing" &&
                (!call.actor || call.actor === me.id),
            ),
          );
      } catch {
        /* o painel segue funcionando enquanto reconecta */
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [profile, me.id, demo, api, root]);

  // --- não lidas (locais, por área) -------------------------------------
  const unreadKey = "wabotia:unread:" + profile,
    internalKey = "wabotia:unread-internal:" + profile;
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [internalUnread, setInternalUnread] = useState<Record<string, number>>(
    {},
  );
  useEffect(() => {
    setUnread(readStore(unreadKey, {}));
    setInternalUnread(readStore(internalKey, {}));
  }, [profile]);
  const openConversation = useRef<string | null>(null),
    openInternal = useRef<string | null>(null);
  const markRead = useCallback(
    (id: string) =>
      setUnread((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        writeStore(unreadKey, next);
        return next;
      }),
    [unreadKey],
  );
  const markInternalRead = useCallback(
    (id: string) =>
      setInternalUnread((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        writeStore(internalKey, next);
        return next;
      }),
    [internalKey],
  );
  const setOpenConversation = useCallback(
    (id: string | null) => {
      openConversation.current = id;
      if (id) markRead(id);
    },
    [markRead],
  );
  const setOpenInternalChat = useCallback(
    (id: string | null) => {
      openInternal.current = id;
      if (id) markInternalRead(id);
    },
    [markInternalRead],
  );
  const unreadTotal = useMemo(
      () => Object.values(unread).reduce((sum, value) => sum + value, 0),
      [unread],
    ),
    internalUnreadTotal = useMemo(
      () => Object.values(internalUnread).reduce((sum, value) => sum + value, 0),
      [internalUnread],
    );
  useEffect(() => {
    setTitleCount(unreadTotal + internalUnreadTotal);
    return () => setTitleCount(0);
  }, [unreadTotal, internalUnreadTotal]);

  // Índice leve das conversas vistas (nome, responsável) para os avisos.
  const known = useRef(new Map<string, Row>());
  const rememberConversations = useCallback((rows: Row[]) => {
    for (const row of rows)
      if (row?.id)
        known.current.set(row.id, {
          id: row.id,
          name: conversationName(row),
          owner: row.owner,
          state: row.state,
        });
  }, []);

  // --- eventos: um único leitor por aba ---------------------------------
  const eventListeners = useRef(new Set<EventListener>());
  const onEvents = useCallback((listener: EventListener) => {
    eventListeners.current.add(listener);
    return () => {
      eventListeners.current.delete(listener);
    };
  }, []);
  const handlers = useRef({ refresh, refreshTickets });
  handlers.current = { refresh, refreshTickets };
  useEffect(() => {
    if (!profile || demo) return;
    const cursorKey = "wabotia:events:" + profile;
    let cursor = readStore<number | null>(cursorKey, null);
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      hiddenSince = 0,
      running = false;
    const dispatch = (events: AppEvent[]) => {
      let touchedStatus = false,
        touchedTickets = false;
      const nextUnread: Record<string, number> = {},
        nextInternal: Record<string, number> = {};
      for (const event of events) {
        const payload = event.payload || {};
        if (event.kind.startsWith("conversation.")) touchedStatus = true;
        if (event.kind.startsWith("ticket.")) touchedTickets = true;
        if (event.kind === "message.received" && payload.conversation_id) {
          const id = payload.conversation_id;
          if (document.hidden || openConversation.current !== id)
            nextUnread[id] = (nextUnread[id] || 0) + 1;
          const row = known.current.get(id);
          if (row?.owner === me.id && row?.state === "human")
            notify(row.name || "Mensagem nova", payload.text || "Anexo", {
              tag: "message:" + id,
              open: () => navigate({ area: "conversations", id }),
            });
        }
        if (
          event.kind === "conversation.updated" &&
          payload.state === "waiting"
        )
          notify("Nova conversa na fila", "Um cliente aguarda atendimento.", {
            tag: "queue:" + event.resource_id,
            open: () =>
              navigate({ area: "conversations", id: event.resource_id }),
          });
        if (
          event.kind === "conversation.updated" &&
          payload.action === "transfer" &&
          payload.owner === me.id &&
          payload.actor !== me.id
        )
          notify("Conversa transferida para você", "Abra para continuar.", {
            tag: "transfer:" + event.resource_id,
            open: () =>
              navigate({ area: "conversations", id: event.resource_id }),
          });
        if (
          event.kind === "ticket.updated" &&
          payload.owner === me.id &&
          payload.previous_owner !== me.id &&
          payload.actor !== me.id
        )
          notify("Protocolo atribuído a você", payload.number || "", {
            tag: "ticket:" + event.resource_id,
            open: () => navigate({ area: "tickets", id: event.resource_id }),
          });
        if (event.kind === "internal.message" && payload.chat_id) {
          const id = payload.chat_id;
          if (
            payload.author !== me.id &&
            (document.hidden || openInternal.current !== id)
          )
            nextInternal[id] = (nextInternal[id] || 0) + 1;
        }
      }
      if (Object.keys(nextUnread).length)
        setUnread((current) => {
          const next = { ...current };
          for (const [id, count] of Object.entries(nextUnread))
            next[id] = (next[id] || 0) + count;
          writeStore("wabotia:unread:" + profile, next);
          return next;
        });
      if (Object.keys(nextInternal).length)
        setInternalUnread((current) => {
          const next = { ...current };
          for (const [id, count] of Object.entries(nextInternal))
            next[id] = (next[id] || 0) + count;
          writeStore("wabotia:unread-internal:" + profile, next);
          return next;
        });
      if (touchedStatus) handlers.current.refresh().catch(() => {});
      if (touchedTickets) handlers.current.refreshTickets();
      eventListeners.current.forEach((listener) => listener(events));
    };
    const poll = async () => {
      if (!alive || running) return;
      running = true;
      let delay = document.hidden ? 15_000 : 4000;
      try {
        // Aba oculta há muito tempo: pausa; ao voltar, retoma do cursor.
        if (document.hidden && Date.now() - hiddenSince > HIDDEN_PAUSE_MS)
          return;
        const fetchAfter = async (after: number) => {
          const result = await api(root + "/events?after=" + after);
          return {
            events: (result.data || []) as AppEvent[],
            cursor: Number(result.cursor) || after,
          };
        };
        if (cursor === null) {
          // Primeira vez neste navegador: acha o fim da fila sem repetir o
          // histórico (as telas já carregam tudo ao abrir). Cada consulta
          // devolve no máximo 100 eventos; menos de 100 ids de avanço = fim.
          let low = 0,
            high = 1024;
          for (let step = 0; step < 40 && alive; step++) {
            const probe = await fetchAfter(high);
            if (probe.cursor === high) break;
            low = probe.cursor;
            high = Math.max(high * 4, probe.cursor * 2);
          }
          for (let step = 0; step < 60 && alive; step++) {
            const page = await fetchAfter(low);
            if (page.cursor - low < 100) {
              low = page.cursor;
              break;
            }
            const middle = Math.floor((page.cursor + high) / 2);
            const probe = await fetchAfter(middle);
            if (probe.cursor === middle) {
              high = middle;
              low = page.cursor;
            } else low = probe.cursor;
          }
          if (!alive) return;
          cursor = low;
          writeStore(cursorKey, cursor);
          return;
        }
        for (let batch = 0; batch < 50; batch++) {
          const previous: number = cursor;
          const page = await fetchAfter(previous);
          if (!alive) return;
          cursor = Math.max(previous, page.cursor);
          writeStore(cursorKey, cursor);
          // Até cinco lotes seguidos viram avisos e não lidas; um acúmulo
          // maior (aba parada por dias) só pede às telas que recarreguem.
          if (page.events.length && batch < 5) dispatch(page.events);
          const maybeMore = cursor - previous >= 100;
          if (!maybeMore) {
            if (batch >= 5)
              dispatch([
                {
                  id: cursor,
                  kind: "resync",
                  resource_id: "",
                  payload: {},
                  created: Date.now(),
                },
              ]);
            break;
          }
        }
      } catch {
        delay = 8000;
      } finally {
        running = false;
        if (alive) timer = setTimeout(poll, delay);
      }
    };
    const visibility = () => {
      if (document.hidden) hiddenSince = Date.now();
      else {
        clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [profile, demo, api, root, me.id]);

  // --- derivados ---------------------------------------------------------
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const person of presence) map[person.actor] = person.name;
    for (const member of team) map[member.id] = member.name;
    for (const bot of bots) map["bot:" + bot.id] ||= bot.name;
    map[me.id] ||= me.name;
    return map;
  }, [presence, team, bots, me.id, me.name]);
  const lineKinds = useMemo(() => {
    const map: Record<string, string> = {};
    for (const connection of status.connections || [])
      map[connection.id] = connection.kind;
    return map;
  }, [status.connections]);
  const count = useCallback(
    (state: string) =>
      (status.conversations || []).find((item: Row) => item.state === state)
        ?.count || 0,
    [status.conversations],
  );
  const online = !!presence.find((person) => person.actor === me.id)?.present;
  const demoBlocked = useCallback(() => {
    if (!demo) return false;
    toast("Demonstração: nenhuma alteração é salva.", { tone: "info" });
    return true;
  }, [demo]);
  const setOnline = useCallback(
    async (next: boolean) => {
      if (demoBlocked()) return;
      setPresenceBusy(true);
      try {
        await api(root + "/presence", "PUT", { present: next });
        setPresence((current) =>
          current.map((person) =>
            person.actor === me.id ? { ...person, present: next ? 1 : 0 } : person,
          ),
        );
        toast(next ? "Você está online" : "Você está offline");
        refresh().catch(() => {});
      } catch (error) {
        toastError(error, () => void setOnline(next));
      } finally {
        setPresenceBusy(false);
      }
    },
    [api, root, me.id, refresh, demoBlocked],
  );
  const chooseProfile = useCallback(
    (id: string) => {
      if (id === profile) return;
      if (navigationGuarded()) {
        toast(
          "Salve ou descarte as alterações antes de trocar de área de atendimento.",
          { tone: "info" },
        );
        return;
      }
      // A conversa ou o protocolo aberto pertence à área anterior.
      const route = currentRoute();
      navigate(
        route.area === "admin" ? route : { area: route.area, sub: route.sub },
        { replace: true, force: true },
      );
      setProfile(id);
    },
    [profile],
  );
  const logout = useCallback(async () => {
    try {
      if (!demo) await api("v1/logout", "POST", {});
    } finally {
      window.location.assign("/app");
    }
  }, [api, demo]);
  const setPanelMode = useCallback((mode: PanelMode) => {
    setMode(mode);
    writeText("wabotia:panel-mode", mode);
  }, []);

  const value: AppState = {
    demo,
    api,
    me,
    isAdmin: me.role === "admin",
    profiles,
    profile,
    profileName:
      profiles.find((item) => item.id === profile)?.name || "Atendimento",
    root,
    chooseProfile,
    status,
    settings: status.settings || {},
    statusLoaded,
    bots,
    team,
    names,
    lineKinds,
    count,
    online,
    presenceBusy,
    setOnline,
    peopleOnline: team.filter((item) => item.kind === "user" && item.online)
      .length,
    botsOnline: team.filter((item) => item.kind === "bot" && item.online).length,
    refresh,
    now,
    syncClock,
    ringingCalls,
    unread,
    unreadTotal,
    markRead,
    setOpenConversation,
    internalUnread,
    internalUnreadTotal,
    markInternalRead,
    setOpenInternalChat,
    ticketCounts,
    refreshTickets,
    rememberConversations,
    onEvents,
    panelMode,
    setPanelMode,
    offline,
    reloadSession,
    logout,
    demoBlocked,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Escuta os eventos da área enquanto o componente está montado. */
export function useAppEvents(listener: EventListener) {
  const { onEvents } = useApp();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => onEvents((events) => ref.current(events)), [onEvents]);
}
