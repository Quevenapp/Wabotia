// Lista de conversas: filtros, busca, paginação por cursor e atualização
// pelos eventos da área (com uma releitura lenta de reserva).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useAppEvents } from "../app/AppContext";
import type { Row } from "../lib/api";
import { readText, writeText } from "../lib/storage";
import { isMine } from "./model";
import { conversationChannel, conversationChannels } from "../channels";

export type ChipId = "all" | "waiting" | "mine" | "ai" | "closed";
export const chipStates: Record<ChipId, string> = {
  all: "",
  waiting: "waiting",
  mine: "human",
  ai: "ai",
  closed: "closed",
};
const PAGE = 50;
export function conversationListKey(root: string, generation: number, chip: string, search: string, department: string, channel: string, channels: readonly string[] = []) {
  return JSON.stringify([root, generation, chip, search, department, channel, channels]);
}

/** Geração comum à primeira página, paginação e eventos. A troca de filtro
 * invalida respostas já durante o render, antes de o efeito iniciar a carga. */
export function createConversationListGate() {
  let key = "", revision = 0;
  return {
    update(next: string) { if (key !== next) { key = next; revision++; } },
    begin(scope: string) { if (scope === key) revision++; return { key: scope, revision }; },
    capture(scope: string) { return { key: scope, revision }; },
    current(token: { key: string; revision: number }) { return token.key === key && token.revision === revision; },
    invalidate() { revision++; },
  };
}
const sortRows = (rows: Row[]) =>
  rows.sort(
    (a, b) => (b.updated || 0) - (a.updated || 0) || (a.id < b.id ? 1 : -1),
  );

export function useConversationList() {
  const app = useApp();
  const [chip, setChipState] = useState<ChipId>(() => {
    const saved = readText("wabotia:conversations-chip") as ChipId;
    return saved in chipStates ? saved : "all";
  });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [selectedChannel, setChannel] = useState("");
  const channels = conversationChannels(app.status);
  const channel = channels.length > 1 && channels.includes(selectedChannel as any) ? selectedChannel : "";
  const [resolvedScope, setResolvedScope] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const pages = useRef(0);
  const gate = useRef(createConversationListGate());
  const moreRequest = useRef(false);
  const refreshSequence = useRef(0);

  // Busca com pequena espera para não consultar a cada tecla.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const scope = conversationListKey(app.root, app.contextGeneration, chip, search, department, channel, channels);
  gate.current.update(scope);
  const path = useCallback(
    (after?: string | null) =>
      `${app.root}/conversations?limit=${PAGE}&q=${encodeURIComponent(search)}` +
      `&state=${chipStates[chip]}&department_id=${encodeURIComponent(department)}` +
      (channel ? `&channel=${encodeURIComponent(channel)}` : "") +
      (after ? `&cursor=${encodeURIComponent(after)}` : ""),
    [app.root, chip, search, department, channel],
  );
  const keep = useCallback(
    (list: Row[]) =>
      list.filter((row) => (chip !== "mine" || isMine(row, app.me.id)) &&
        (!channel || conversationChannel(row, app.lineKinds) === channel)),
    [chip, app.me.id, channel, app.lineKinds],
  );

  /** Primeira carga do filtro atual (substitui a lista). */
  const load = useCallback(async () => {
    const mine = gate.current.begin(scope);
    if (!gate.current.current(mine)) return;
    moreRequest.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    try {
      let collected: Row[] = [],
        next: string | null = null,
        fetched = 0;
      // "Minhas" é filtrado aqui: busca mais páginas até ter o suficiente.
      do {
        const page = await app.api(path(next));
        if (!gate.current.current(mine)) return;
        app.rememberConversations(page.data || []);
        collected = collected.concat(keep(page.data || []));
        next = page.next_cursor || null;
        fetched++;
      } while (chip === "mine" && next && collected.length < 20 && fetched < 6);
      pages.current = fetched;
      setRows(collected);
      setCursor(next);
      setResolvedScope(scope);
    } catch (e: any) {
      if (gate.current.current(mine)) { setError(e.message); setResolvedScope(scope); }
    } finally {
      if (gate.current.current(mine)) setLoading(false);
    }
  }, [app.api, app.rememberConversations, path, keep, chip, scope]);

  useEffect(() => {
    setRows([]);
    setCursor(null);
    pages.current = 0;
    moreRequest.current = false;
    setLoadingMore(false);
    void load();
    return () => gate.current.invalidate();
  }, [scope]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || loading || moreRequest.current || resolvedScope !== scope) return;
    const mine = gate.current.capture(scope);
    moreRequest.current = true;
    setLoadingMore(true);
    try {
      const page = await app.api(path(cursor));
      if (!gate.current.current(mine)) return;
      app.rememberConversations(page.data || []);
      pages.current++;
      setRows((current) => {
        const seen = new Set(current.map((row) => row.id));
        return current.concat(
          keep(page.data || []).filter((row: Row) => !seen.has(row.id)),
        );
      });
      setCursor(page.next_cursor || null);
    } catch (e: any) {
      if (gate.current.current(mine)) setError(e.message);
    } finally {
      if (gate.current.current(mine)) { moreRequest.current = false; setLoadingMore(false); }
    }
  }, [cursor, loadingMore, loading, app.api, app.rememberConversations, path, keep, scope, resolvedScope]);

  /**
   * Releitura leve: a primeira página traz tudo o que mudou (a ordem é por
   * atualização). `touched` são as conversas citadas nos eventos; as que
   * saíram do filtro deixam a lista.
   */
  const refresh = useCallback(
    async (touched?: Set<string>) => {
      if (resolvedScope !== scope || loading) return;
      const mine = gate.current.capture(scope);
      const sequence = ++refreshSequence.current;
      try {
        const page = await app.api(path(null));
        if (!gate.current.current(mine) || sequence !== refreshSequence.current) return;
        const fresh: Row[] = page.data || [];
        app.rememberConversations(fresh);
        const kept = keep(fresh);
        setError("");
        if (pages.current <= 1 && chip !== "mine") {
          setRows(kept);
          setCursor(page.next_cursor || null);
          return;
        }
        setRows((current) => {
          const byId = new Map(kept.map((row) => [row.id, row]));
          const freshIds = new Set(fresh.map((row) => row.id));
          const merged = current
            .filter(
              (row) =>
                byId.has(row.id) ||
                // Veio na página nova mas não passa no filtro local: saiu.
                (!freshIds.has(row.id) && !touched?.has(row.id)),
            )
            .map((row) => byId.get(row.id) || row);
          const seen = new Set(merged.map((row) => row.id));
          for (const row of kept) if (!seen.has(row.id)) merged.push(row);
          return sortRows(merged);
        });
      } catch {
        /* a próxima releitura tenta de novo */
      }
    },
    [app.api, app.rememberConversations, path, keep, chip, scope, resolvedScope, loading],
  );

  // Eventos: junta os que chegam em sequência em uma releitura só.
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const loadRef = useRef(load);
  loadRef.current = load;
  useAppEvents((events) => {
    let relevant = false;
    for (const event of events) {
      if (event.kind === "resync") {
        void loadRef.current();
        return;
      }
      if (event.kind.startsWith("conversation.")) {
        pending.current.add(event.resource_id);
        relevant = true;
      } else if (event.kind.startsWith("message.")) {
        if (event.payload?.conversation_id)
          pending.current.add(event.payload.conversation_id);
        relevant = true;
      }
    }
    if (!relevant) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const touched = pending.current;
      pending.current = new Set();
      void refreshRef.current(touched);
    }, 350);
  });
  useEffect(() => {
    const slow = setInterval(() => {
      if (!document.hidden) void refreshRef.current();
    }, 30_000);
    const visible = () => !document.hidden && void refreshRef.current();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(slow);
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const mineCount = useMemo(
    () => rows.filter((row) => isMine(row, app.me.id)).length,
    [rows, app.me.id],
  );
  return {
    chip,
    setChip: (next: ChipId) => {
      setChipState(next);
      writeText("wabotia:conversations-chip", next);
    },
    query,
    setQuery,
    search,
    department,
    setDepartment,
    channel,
    channels,
    setChannel,
    rows: resolvedScope === scope ? rows : [],
    hasMore: resolvedScope === scope && !!cursor,
    loading: loading || resolvedScope !== scope,
    loadingMore,
    error: resolvedScope === scope ? error : "",
    load,
    loadMore,
    refresh: () => refresh(),
    mineCount,
    /** Troca uma linha na hora (depois de assumir, etiquetar…). */
    patch: (row: Row) =>
      setRows((current) =>
        sortRows(
          keep(
            current.map((item) =>
              item.id === row.id
                ? { ...item, ...row, last_message: row.last_message ?? item.last_message, contact_name: row.contact_name ?? item.contact_name }
                : item,
            ),
          ),
        ),
      ),
  };
}
export type ConversationListState = ReturnType<typeof useConversationList>;
