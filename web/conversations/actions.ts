// Ações do atendimento sobre uma conversa (assumir, concluir, devolver ao
// bot…). Cada intenção reutiliza a mesma Idempotency-Key até ter resposta.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../app/AppContext";
import { useIntents, type Row } from "../lib/api";
import { toast, toastError } from "../ui";

export type ActionOptions = {
  success?: string;
  /** Sem aviso de erro: quem chama mostra o erro no próprio lugar. */
  silent?: boolean;
  route?: "actions" | "message-actions";
};

export function useConversationActions(done?: (conversationId: string) => void) {
  const app = useApp();
  const write = useIntents(app.api);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  /** Devolve o resultado, ou lança quando `silent` e a ação falha. */
  const act = useCallback(
    async (
      conversationId: string,
      action: string,
      body: Row = {},
      options: ActionOptions = {},
    ): Promise<any> => {
      if (app.demoBlocked()) return undefined;
      setBusy(conversationId + ":" + action);
      try {
        const result = await write(
          `${app.root}/conversations/${conversationId}/${options.route || "actions"}`,
          "POST",
          { action, ...body },
        );
        if (options.success) toast(options.success);
        doneRef.current?.(conversationId);
        return result ?? true;
      } catch (error) {
        if (options.silent) throw error;
        toastError(error, () => void act(conversationId, action, body, options));
        return undefined;
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [app.root, app.demoBlocked, write],
  );
  return {
    act,
    busy,
    isBusy: (conversationId: string, action?: string) =>
      busy !== null &&
      (action ? busy === conversationId + ":" + action : busy.startsWith(conversationId + ":")),
  };
}
