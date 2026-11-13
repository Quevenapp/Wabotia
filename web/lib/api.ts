// Cliente HTTP do painel. Toda escrita leva Idempotency-Key; quem repete um
// pedido após falha de rede precisa reutilizar a mesma chave (veja createIntents).
import { useRef } from "react";

export type Row = Record<string, any>;
export type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
  idempotencyKey?: string,
) => Promise<any>;

export type ApiFailure = Error & { status: number; code?: string };

type Listener = (state: { online: boolean; unauthorized?: boolean }) => void;
const listeners = new Set<Listener>();
/** Avisos de rede (sem conexão / sessão encerrada) para a casca do aplicativo. */
export function onApiState(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const tell = (state: { online: boolean; unauthorized?: boolean }) =>
  listeners.forEach((listener) => listener(state));

export const api: Api = async (
  path,
  method = "GET",
  body,
  signal,
  idempotencyKey,
) => {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(method !== "GET"
          ? { "Idempotency-Key": idempotencyKey || crypto.randomUUID() }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch (cause: any) {
    if (cause?.name === "AbortError") throw cause;
    tell({ online: false });
    throw Object.assign(
      new Error("Sem conexão com o servidor. Confira sua rede e tente de novo."),
      { status: 0, code: "network" },
    );
  }
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // Respostas sem JSON (proxy fora do ar, 502) viram erro legível abaixo.
  }
  if (!response.ok) {
    if (response.status >= 502 && response.status <= 504 && !data)
      tell({ online: false });
    else tell({ online: true, unauthorized: response.status === 401 });
    throw Object.assign(
      new Error(
        data?.error?.message ||
          (response.status >= 500
            ? "O servidor não respondeu. Tente de novo em instantes."
            : "Não foi possível concluir."),
      ),
      { status: response.status, code: data?.error?.code },
    );
  }
  tell({ online: true });
  return data;
};

/** Erro definitivo: o servidor recusou e repetir com a mesma chave não ajuda. */
export const isFinalError = (error: any) =>
  error?.status >= 400 &&
  error?.status < 500 &&
  !["operation_unknown", "idempotency_conflict"].includes(error?.code);

/**
 * Guarda uma Idempotency-Key por intenção (caminho + corpo). A chave só é
 * descartada quando o servidor confirma ou recusa de forma definitiva; depois
 * de timeout ou queda de rede, repetir a mesma ação reutiliza a mesma chave.
 */
export function createIntents(request: Api = api) {
  const keys = new Map<string, string>();
  return async function write(
    path: string,
    method: string,
    body: Row = {},
    signal?: AbortSignal,
  ) {
    const intent = method + " " + path + " " + JSON.stringify(body);
    if (!keys.has(intent)) keys.set(intent, crypto.randomUUID());
    try {
      const result = await request(path, method, body, signal, keys.get(intent));
      keys.delete(intent);
      return result;
    } catch (error) {
      if (isFinalError(error)) keys.delete(intent);
      throw error;
    }
  };
}

/** createIntents estável durante a vida do componente. */
export function useIntents(request: Api = api) {
  const ref = useRef<ReturnType<typeof createIntents> | null>(null);
  if (!ref.current) ref.current = createIntents(request);
  return ref.current;
}
