import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp } from "../../app/AppContext";
import { useUnsavedGuard } from "../../app/hooks";
import { Button, Notice, SkeletonRows } from "../../ui";
import { createWorkApi, workError } from "./work-api";

export function useWorkApi() {
  const { api, root } = useApp();
  return useMemo(() => createWorkApi(api, root), [api, root]);
}
/** Resultados e erros pertencem à mesma chave; nada da área anterior pisca no DOM. */
export function useWorkResource<T>(
  key: string | null,
  load: () => Promise<T>,
  refresh?: string,
) {
  const loader = useRef(load);
  loader.current = load;
  const [attempt, retry] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    data?: T;
    error?: unknown;
  }>({ key: "" });
  useEffect(() => {
    let alive = true;
    // Uma atualização da mesma área mantém formulários e seus rascunhos montados.
    setState((old) =>
      refresh !== undefined && old.key === key ? { key, data: old.data } : { key },
    );
    if (!key) return;
    loader.current().then(
      (data) => {
        if (alive) setState({ key, data });
      },
      (error) => {
        if (alive)
          setState((old) => ({
            key,
            data: refresh !== undefined && old.key === key ? old.data : undefined,
            error,
          }));
      },
    );
    return () => {
      alive = false;
    };
  }, [key, attempt, refresh]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    reload: useCallback(() => retry((n) => n + 1), []),
  };
}
export function ResourceState({
  resource,
}: {
  resource: { data?: unknown; error?: unknown; reload: () => void };
}) {
  return resource.error ? (
    <Notice tone="error">
      {workError(resource.error)}{" "}
      <Button secondary onClick={resource.reload}>
        Tentar novamente
      </Button>
    </Notice>
  ) : resource.data === undefined ? (
    <SkeletonRows />
  ) : null;
}
export function useDraftGuard(dirty: boolean, close: () => void) {
  useUnsavedGuard(dirty);
  return () => {
    if (!dirty || window.confirm("Descartar as alterações não salvas?"))
      close();
  };
}
export const dateTimeInput = (at?: number | null) =>
  at == null ? "" : new Date(at - 3 * 3600000).toISOString().slice(0, 16);
export function dateTimeValue(value: string) {
  if (!value) return null;
  const at = Date.parse(value + ":00-03:00");
  if (!Number.isFinite(at)) throw new Error("Data e horário inválidos.");
  return at;
}
export const instantLabel = (at?: number | null) =>
  at == null
    ? "Sem vencimento"
    : new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
