// Peças comuns das páginas de Gestão: leitura de listas com escopo e
// paginação, diálogo de formulário e a chave exibida uma única vez.
import React, { useCallback, useId, useRef, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { useApp } from "../app/AppContext";
import { usePolling } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, CopyButton, Dialog, Notice } from "../ui";

/**
 * Lê um recurso e o relê a cada 15 s enquanto a aba está visível. O resultado
 * fica preso ao endereço pedido: ao trocar de página, cursor ou área, os
 * dados anteriores nunca aparecem como se fossem do novo recurso.
 */
export function useResource(url: string | null) {
  const app = useApp();
  const [state, setState] = useState<{ key: string; data: any } | null>(null);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const current = useRef(url);
  current.current = url;
  const reload = useCallback(async () => {
    if (!url) return;
    const request = ++latest.current;
    try {
      const data = await app.api(url);
      if (request !== latest.current || current.current !== url) return;
      setState({ key: url, data });
      setError("");
    } catch (e: any) {
      if (request === latest.current && current.current === url)
        setError(e.message);
    }
  }, [url, app.api]);
  usePolling(() => void reload(), 15000, [reload]);
  const data = url && state?.key === url ? state.data : null;
  return { data, loaded: data !== null, error, reload, setError };
}

/** Lista paginada por cursor (`{data, next_cursor}` ou lista direta). */
export function useList(base: string | null) {
  const [cursor, setCursor] = useState("");
  const scope = useRef(base);
  if (scope.current !== base) {
    scope.current = base;
    if (cursor) setCursor("");
  }
  const url = base
    ? base +
      (base.includes("?") ? "&" : "?") +
      "cursor=" +
      encodeURIComponent(cursor)
    : null;
  const resource = useResource(url);
  const raw = resource.data;
  const rows: Row[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data)
      ? raw.data
      : [];
  return {
    ...resource,
    raw,
    rows,
    cursor,
    setCursor,
    nextCursor: (raw?.next_cursor as string | null) || null,
  };
}

/** "Voltar ao início" / "Próxima página", como nas listas antigas do painel. */
export function Pager({
  cursor,
  nextCursor,
  setCursor,
}: {
  cursor: string;
  nextCursor: string | null;
  setCursor: (cursor: string) => void;
}) {
  if (!cursor && !nextCursor) return null;
  return (
    <div className="toolbar admin-pager">
      <Button secondary disabled={!cursor} onClick={() => setCursor("")}>
        Voltar ao início
      </Button>
      <Button
        secondary
        disabled={!nextCursor}
        onClick={() => setCursor(nextCursor || "")}
      >
        Próxima página <ArrowRight size={16} />
      </Button>
    </div>
  );
}

/**
 * Diálogo com formulário: corpo rolável, ações no rodapé, progresso no botão
 * e o erro do servidor dentro do próprio diálogo (sem fechá-lo).
 */
export function FormDialog({
  title,
  subtitle,
  onClose,
  onSubmit,
  children,
  submitLabel = "Salvar",
  size,
  disabled,
  danger,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** Lança o erro para mantê-lo no diálogo; ao resolver, quem chama fecha. */
  onSubmit: () => Promise<void>;
  children: React.ReactNode;
  submitLabel?: string;
  size?: "sm" | "md" | "lg" | "xl";
  disabled?: boolean;
  danger?: boolean;
}) {
  const app = useApp();
  const id = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size={size}
      footer={
        <>
          <Button secondary onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form={id}
            busy={busy}
            disabled={disabled}
            variant={danger ? "danger" : "primary"}
            icon={<Check size={17} />}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={id}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || app.demoBlocked()) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit();
          } catch (e: any) {
            setError(e?.message || "Não foi possível concluir.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Dialog>
  );
}

/** Chave ou segredo exibido somente uma vez. */
export function SecretDialog({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Guarde esta chave"
      onClose={onClose}
      footer={
        <Button onClick={onClose} icon={<Check size={16} />}>
          Guardei minha chave
        </Button>
      }
    >
      <p>
        A chave é exibida somente agora. Guarde-a no sistema que fará a
        integração.
      </p>
      <div className="secret-box">
        <code>{token}</code>
        <CopyButton value={token} />
      </div>
    </Dialog>
  );
}

/** Mantém a lista de valores marcados em grupos de caixas de seleção. */
export const toggled = <T,>(list: T[], value: T, on: boolean) =>
  on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
