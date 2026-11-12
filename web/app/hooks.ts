import { useCallback, useEffect, useRef, useState } from "react";
import { setNavigationGuard } from "../lib/routes";
import { toast, toastError } from "../ui";
import { useApp } from "./AppContext";

/** Segura a navegação e o fechamento da aba enquanto houver alterações não salvas. */
export function useUnsavedGuard(dirty: boolean) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    setNavigationGuard(() => ref.current);
    return () => setNavigationGuard(null);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);
}

/** true quando a largura da janela casa com a consulta (ex.: "(max-width: 759px)"). */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export const useCompact = () => useMedia("(max-width: 759px)");

/**
 * Executa uma ação com retorno padrão: progresso (`busy`), aviso curto ao
 * terminar e erro legível com "Tentar de novo". Em demonstração nada é salvo.
 */
export function useAction() {
  const { demoBlocked } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const run = useCallback(
    async function run<T>(
      fn: () => Promise<T>,
      options: { success?: string; key?: string; retry?: boolean } = {},
    ): Promise<T | undefined> {
      if (demoBlocked()) return undefined;
      setBusy(options.key || "busy");
      try {
        const result = await fn();
        if (options.success) toast(options.success);
        return result;
      } catch (error) {
        toastError(
          error,
          options.retry === false ? undefined : () => void run(fn, options),
        );
        return undefined;
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [demoBlocked],
  );
  return { busy: busy !== null, busyKey: busy, run };
}

/** Recarrega em intervalos enquanto a aba está visível e ao voltar a ela. */
export function usePolling(load: () => void, ms: number, deps: any[]) {
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    ref.current();
    const timer = setInterval(() => {
      if (!document.hidden) ref.current();
    }, ms);
    const visible = () => !document.hidden && ref.current();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, deps);
}
