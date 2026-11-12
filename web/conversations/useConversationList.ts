// Lista de conversas: filtros, busca, paginação por cursor e atualização
// pelos eventos da área (com uma releitura lenta de reserva).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useAppEvents } from "../app/AppContext";
import type { Row } from "../lib/api";
import { readText, writeText } from "../lib/storage";
import { isMine } from "./model";

export type ChipId = "all" | "waiting" | "mine" | "ai" | "closed";
export const chipStates: Record<ChipId, string> = {
  all: "",
  waiting: "waiting",
  mine: "human",
  ai: "ai",
  closed: "closed",
};
const PAGE = 50;
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
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const pages = useRef(0);
  const request = useRef(0);

  // Busca com pequena espera para não consultar a cada tecla.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const scope = JSON.stringify([app.root, chip, search, department]);
  const path = useCallback(
    (after?: string | null) =>
      `${app.root}/conversations?limit=${PAGE}&q=${encodeURIComponent(search)}` +
      `&state=${chipStates[chip]}&department_id=${encodeURIComponent(department)}` +
      (after ? `&cursor=${encodeURIComponent(after)}` : ""),
    [app.root, chip, search, department],
  );
  const keep = useCallback(
    (list: Row[]) =>
      chip === "mine" ? list.filter((row) => isMine(row, app.me.id)) : list,
    [chip, app.me.id],
  );

  /** Primeira carga do filtro atual (substitui a lista). */
  const load = useCallback(async () => {
    const mine = ++request.current;
    setLoading(true);
    setError("");
    try {
      let collected: Row[] = [],
        next: string | null = null,
        fetched = 0;
      // "Minhas" é filtrado aqui: busca mais páginas até ter o suficiente.
      do {
        const page = await app.api(path(next));
        if (mine !== request.current) return;
        app.rememberConversations(page.data || []);
        collected = collected.concat(keep(page.data || []));
        next = page.next_cursor || null;
        fetched++;
      } while (chip === "mine" && next && collected.length < 20 && fetched < 6);
      pages.current = fetched;
      setRows(collected);
      setCursor(next);
    } catch (e: any) {
      if (mine === request.current) setError(e.message);
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, [app.api, app.rememberConversations, path, keep, chip]);

  useEffect(() => {
    setRows([]);
    setCursor(null);
    void load();
  }, [scope]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || loading) return;
    const mine = request.current;
    setLoadingMore(true);
    try {
      const page = await app.api(path(cursor));
      if (mine !== request.current) return;
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
      if (mine === request.current) setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, loading, app.api, app.rememberConversations, path, keep]);

  /**
   * Releitura leve: a primeira página traz tudo o que mudou (a ordem é por
   * atualização). `touched` são as conversas citadas nos eventos; as que
   * saíram do filtro deixam a lista.
   */
  const refresh = useCallback(
    async (touched?: Set<string>) => {
      const mine = request.current;
      try {
        const page = await app.api(path(null));
        if (mine !== request.current) return;
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
    [app.api, app.rememberConversations, path, keep, chip],
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
    rows,
    hasMore: !!cursor,
    loading,
    loadingMore,
    error,
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
