// Estado compartilhado do painel: sessão, área de atendimento, presença,
// equipe, contadores, relógio e o leitor único de eventos (web/DESIGN.md §10).
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Api, type Row } from "../lib/api";
import { readStore, readText, writeStore, writeText } from "../lib/storage";
import { notify, setTitleCount } from "../lib/notifications";
import { conversationName } from "../lib/format";
import { channelNotificationTitle, conversationChannel, isMultichannel } from "../channels";
import { loadChannelUi } from "../channel-ui-loader";
import { currentRoute, navigate, navigationGuarded, type Route } from "../lib/routes";
import { toast, toastError } from "../ui";
import { accessAllows } from "../workspace-navigation";
import { createManagementGeneration, createManagementRequestScope } from "../management/registry";

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
  /** Troca de área; `target`: a tela para abrir na outra (padrão: a mesma área). */
  chooseProfile: (id: string, target?: Route) => void;
  /**
   * Empresas (áreas com ERP) em que a pessoa tem papel no ERP, com nome
   * fantasia e CNPJ (GET /profiles/:area/erp-empresas). Vazia sem ERP ou sem papel.
   */
  companies: Row[];
  /** Relê as empresas (depois de adicionar uma). */
  reloadCompanies: () => Promise<void>;
  /** Resposta de GET /status: settings, enabled, conversations, connections. */
  status: Row;
  settings: Row;
  /**
   * Módulos da área (Gestão → Módulos): true ligado, false desligado.
   * Vazio enquanto GET /status não chega; nada some antes disso.
   */
  modules: Record<string, boolean> | undefined;
  /** O módulo não está desligado na área. */
  moduleOn: (id: string) => boolean;
  statusLoaded: boolean;
  statusError?: string;
  /** Invalida respostas de módulos, pessoa, permissões e área anteriores. */
  contextGeneration: number;
  identityKey: string;
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

  // A ordem também importa: identity.ts valida o primeiro erp:<papel>.
  const accessKey = JSON.stringify(me.access ?? null);
  const identityKey = JSON.stringify([profile, me.id, me.role, accessKey, demo]);
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  const scope = useRef(createManagementGeneration());
  scope.current.update(identityKey);
  const [statusSnapshot, setStatusSnapshot] = useState<{ key: string; value: Row; loaded: boolean }>({ key: "", value: {}, loaded: false });
  const status = statusSnapshot.key === identityKey ? statusSnapshot.value : {};
  const statusLoaded = statusSnapshot.key === identityKey && statusSnapshot.loaded;
  const [statusFailure, setStatusFailure] = useState<{ key: string; message: string } | null>(null);
  const setStatus = (value: Row) => setStatusSnapshot({ key: identityKey, value, loaded: true });
  const lastModules = useRef("");
  const refreshSequence = useRef(0);
  const contextGeneration = scope.current.capture();
  const requests = useMemo(() => createManagementRequestScope(api), [api, identityKey]);
  requests.update(String(contextGeneration), true);
  useLayoutEffect(() => {
    requests.update(String(scope.current.capture()), true);
    return () => requests.update("disposed", false);
  }, [requests]);
  const [bots, setBots] = useState<Row[]>([]);
  const [team, setTeam] = useState<Row[]>([]);
  const [presence, setPresence] = useState<Row[]>([]);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [ringingCalls, setRingingCalls] = useState<Row[]>([]);
  const [ticketCounts, setTicketCounts] = useState({ overdue: 0, active: 0 });

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
  const refresh = useCallback(async () => {
    if (!profile || currentIdentity.current !== identityKey) return;
    const current = scope.current.capture();
    const sequence = ++refreshSequence.current;
    const [nextStatus, nextBots, nextTeam, nextPresence] = await Promise.all([
      api(root + "/status").then(async (value) => {
        // Os descritores precisam estar prontos antes de mostrar a área:
        // envio e formulários usam o mesmo registro síncrono da apresentação.
        await loadChannelUi(value);
        return value;
      }),
      api(root + "/bots"),
      accessAllows("team", me.role, me.access)
        ? api(root + "/team").catch(() => ({ data: [] }))
        : { data: [] },
      api(root + "/presence").catch(() => []),
    ]).catch((error) => {
      if (scope.current.current(current) && sequence === refreshSequence.current)
        setStatusFailure({ key: identityKey, message: "Não foi possível consultar os módulos desta área." });
      throw error;
    });
    if (!scope.current.current(current) || sequence !== refreshSequence.current) return;
    setStatusFailure(null);
    const modulesKey = JSON.stringify(Object.entries(nextStatus.modules || {}).sort());
    if (lastModules.current !== modulesKey) {
      lastModules.current = modulesKey;
      scope.current.invalidate();
    }
    setStatus(nextStatus);
    setBots(nextBots.data || nextBots);
    setTeam(nextTeam.data || []);
    setPresence(Array.isArray(nextPresence) ? nextPresence : []);
  }, [api, root, profile, identityKey]);
  const refreshTickets = useCallback(() => {
    // Acesso por pessoa: sem Protocolos, nada de contador nem aviso.
    if (!profile || currentIdentity.current !== identityKey || !accessAllows("tickets", me.role, me.access)) return;
    const current = scope.current.capture();
    Promise.all([
      api(root + "/tickets?overdue=1&limit=100"),
      api(root + "/tickets?active=1&limit=100"),
    ])
      .then(([overdue, active]) => {
        if (!scope.current.current(current)) return;
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
  }, [api, root, profile, me.id, identityKey]);

  useEffect(() => {
    setStatusSnapshot({ key: identityKey, value: {}, loaded: false });
    setBots([]);
    setTeam([]);
    setPresence([]);
    setPresenceBusy(false);
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
    if (!profile || demo || !accessAllows("calls", me.role, me.access)) return;
    let alive = true;
    const check = async () => {
      if (document.hidden) return;
      const current = scope.current.capture();
      try {
        const result = await api(root + "/calls?limit=30");
        if (alive && scope.current.current(current))
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
  }, [profile, me.id, demo, api, root, identityKey]);

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
  const knownIdentity = useRef(identityKey);
  if (knownIdentity.current !== identityKey) {
    knownIdentity.current = identityKey;
    known.current.clear();
  }
  const notificationStatus = useRef(status);
  notificationStatus.current = status;
  const rememberConversations = useCallback((rows: Row[]) => {
    for (const row of rows)
      if (row?.id)
        known.current.set(row.id, {
          id: row.id,
          name: conversationName(row),
          owner: row.owner,
          state: row.state,
          channel: row.channel,
          connection_id: row.connection_id,
          connection_kind: row.connection_kind,
          multichannel: row.multichannel,
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
      const moduleEvents = events.filter((event) => event.kind === "module.changed");
      if (moduleEvents.length) {
        scope.current.invalidate();
        requests.update(String(scope.current.capture()), false);
        setStatusSnapshot((old) => {
          if (old.key !== identityKey) return old;
          const modules = { ...old.value.modules };
          for (const event of moduleEvents) {
            const id = event.payload?.module_id || event.resource_id;
            if (typeof event.payload?.enabled === "boolean") modules[id] = event.payload.enabled;
          }
          return { ...old, value: { ...old.value, modules } };
        });
      }
      if (events.some((event) => /^(user|person|access|profile)\.(changed|updated|deleted)$/.test(event.kind))) {
        scope.current.invalidate();
        requests.update(String(scope.current.capture()), false);
        setStatusSnapshot({ key: identityKey, value: {}, loaded: false });
        void reloadSession().then(() => handlers.current.refresh()).catch(() => {});
      }
      let touchedStatus = moduleEvents.length > 0 || events.some((event) => event.kind === "resync"),
        touchedTickets = false;
      const nextUnread: Record<string, number> = {},
        nextInternal: Record<string, number> = {};
      for (const event of events) {
        const payload = event.payload || {};
        if (event.kind.startsWith("conversation.") || event.kind.startsWith("connection.")) touchedStatus = true;
        if (event.kind.startsWith("ticket.")) touchedTickets = true;
        if (event.kind === "message.received" && payload.conversation_id) {
          const id = payload.conversation_id;
          if (document.hidden || openConversation.current !== id)
            nextUnread[id] = (nextUnread[id] || 0) + 1;
          const row = known.current.get(id);
          if (row?.owner === me.id && row?.state === "human") {
            const summary = notificationStatus.current;
            const channel = payload.channel ?? conversationChannel(row, Object.fromEntries(
              (summary.connections || []).map((connection: Row) => [connection.id, connection.kind]),
            ));
            const minimal = summary.settings?.push?.preview === "minimal";
            notify(channelNotificationTitle(row.name || "Mensagem nova", channel,
              payload.multichannel === true || isMultichannel(summary), minimal), minimal ? "Wabotia" : payload.text || "Anexo", {
              tag: "message:" + id,
              open: () => navigate({ area: "conversations", id }),
            });
          }
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
          const current = scope.current.capture();
          const result = await api(root + "/events?after=" + after);
          if (!alive || currentIdentity.current !== identityKey || !scope.current.current(current))
            throw new DOMException("Contexto alterado", "AbortError");
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
  }, [profile, demo, api, root, me.id, identityKey, reloadSession, requests]);

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
      if (currentIdentity.current !== identityKey || demoBlocked()) return;
      const current = scope.current.capture();
      setPresenceBusy(true);
      try {
        await requests.api(root + "/presence", "PUT", { present: next });
        if (!scope.current.current(current)) return;
        setPresence((current) =>
          current.map((person) =>
            person.actor === me.id ? { ...person, present: next ? 1 : 0 } : person,
          ),
        );
        toast(next ? "Você está online" : "Você está offline");
        refresh().catch(() => {});
      } catch (error) {
        if (scope.current.current(current)) toastError(error, () => void setOnline(next));
      } finally {
        if (scope.current.current(current)) setPresenceBusy(false);
      }
    },
    [requests, root, me.id, refresh, demoBlocked, identityKey],
  );
  const chooseProfile = useCallback(
    (id: string, target?: Route) => {
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
        target ?? (route.area === "admin" ? route : { area: route.area, sub: route.sub }),
        { replace: true, force: true },
      );
      scope.current.invalidate();
      setProfile(id);
    },
    [profile],
  );
  // --- empresas (várias áreas com ERP) ---------------------------------
  // A lista é a mesma em qualquer área: lida uma vez por sessão, de uma área
  // com o ERP ligado (a rota pede o ERP), e de novo depois de adicionar empresa.
  const [companies, setCompanies] = useState<Row[]>([]);
  const companiesLoaded = useRef(false);
  const erpOn = statusLoaded && status.modules?.erp === true;
  const reloadCompanies = useCallback(async () => {
    if (demo || !profile) return;
    try {
      const result = await api(root + "/erp-empresas");
      companiesLoaded.current = true;
      setCompanies(Array.isArray(result?.empresas) ? result.empresas : []);
    } catch {
      /* sem papel no ERP ou ERP fora do ar: o seletor não aparece */
    }
  }, [api, root, demo, profile]);
  useEffect(() => {
    if (erpOn && !companiesLoaded.current) void reloadCompanies();
  }, [erpOn, reloadCompanies]);
  const logout = useCallback(async () => {
    try {
      if (!demo) await api("v1/logout", "POST", {});
    } finally {
      window.location.assign("/app");
    }
  }, [api, demo]);
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
    companies,
    reloadCompanies,
    status,
    settings: status.settings || {},
    modules: status.modules,
    moduleOn: (id: string) => status.modules?.[id] !== false,
    statusLoaded,
    statusError: statusFailure?.key === identityKey ? statusFailure.message : undefined,
    contextGeneration,
    identityKey,
    bots: statusLoaded ? bots : [],
    team: statusLoaded ? team : [],
    names: statusLoaded ? names : {},
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
    ringingCalls: statusLoaded ? ringingCalls : [],
    unread,
    unreadTotal,
    markRead,
    setOpenConversation,
    internalUnread,
    internalUnreadTotal,
    markInternalRead,
    setOpenInternalChat,
    ticketCounts: statusLoaded ? ticketCounts : { overdue: 0, active: 0 },
    refreshTickets,
    rememberConversations,
    onEvents,
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

/** Mantém o rascunho suspenso, mas fecha a API da tela ao perder ativação. */
export function ManagementRequestBoundary({ enabled, children }: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const app = useApp();
  const previous = useRef(app);
  if (enabled) previous.current = app;
  const requests = useMemo(() => createManagementRequestScope(app.api), [app.api]);
  const key = String(app.contextGeneration);
  requests.update(key, enabled);
  useLayoutEffect(() => {
    requests.update(key, enabled);
    return () => requests.update("disposed", false);
  }, [requests, key, enabled]);
  return <Context.Provider value={{ ...(enabled ? app : previous.current), api: requests.api }}>
    {children}
  </Context.Provider>;
}
