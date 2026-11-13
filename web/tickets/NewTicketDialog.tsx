// Novo protocolo: título, categoria e conversa (web/DESIGN.md §6).
// Aberto pelo atendente, não envia confirmação automática ao cliente.
import React, { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useIntents, type Row } from "../lib/api";
import { conversationName, phone } from "../lib/format";
import { enabledCategories } from "../lib/tickets";
import {
  Avatar,
  Button,
  Dialog,
  Field,
  Notice,
  SearchBox,
  Spinner,
  conversationBadge,
  toast,
} from "../ui";

export function NewTicketDialog({
  conversation,
  onClose,
  onCreated,
}: {
  /** Conversa já escolhida (aberto a partir dela); sem ela, a pessoa escolhe. */
  conversation?: Row | null;
  onClose: () => void;
  onCreated?: (ticket: Row) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [title, setTitle] = useState(""),
    [category, setCategory] = useState(""),
    [chosen, setChosen] = useState<Row | null>(conversation || null),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Row[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const categories = enabledCategories(app.settings);

  useEffect(() => {
    if (conversation) return;
    let alive = true;
    const timer = setTimeout(() => {
      app
        .api(
          `${app.root}/conversations?limit=20&q=${encodeURIComponent(query.trim())}`,
        )
        .then((page) => alive && setResults(page.data || []))
        .catch((e) => alive && setError(e.message));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, conversation, app.api, app.root]);

  async function create() {
    if (!chosen || !title.trim()) return;
    if (app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      const ticket = await write(app.root + "/tickets", "POST", {
        conversation_id: chosen.id,
        title: title.trim(),
        ...(category ? { category } : {}),
      });
      toast(`Protocolo ${ticket.number || ""} aberto.`.replace("  ", " "));
      app.refreshTickets();
      onCreated?.(ticket);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Novo protocolo"
      subtitle="O cliente acompanha pelo número. Protocolos abertos pela equipe não enviam confirmação automática."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={create}
            busy={busy}
            disabled={!chosen || !title.trim()}
            icon={<Check size={17} />}
          >
            Abrir protocolo
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field
          label="Título"
          value={title}
          onChange={setTitle}
          placeholder="Ex.: Nota fiscal não foi emitida"
          maxLength={300}
          required
          help="Até 300 caracteres. Diga em uma linha o que precisa ser resolvido."
        />
        {categories.length > 0 && (
          <Field
            label="Categoria"
            value={category}
            onChange={setCategory}
            options={categories}
            emptyOption="Sem categoria"
          />
        )}
        <div className="field">
          <span>Conversa</span>
          {chosen ? (
            <div className="picked-conversation">
              <Avatar
                name={conversationName(chosen)}
                seed={chosen.id}
                size={36}
                kind={chosen.chat_type === "group" ? "group" : "person"}
                badge={conversationBadge(chosen, app.me.id)}
              />
              <div>
                <strong className="truncate">{conversationName(chosen)}</strong>
                {chosen.phone && <small>{phone(chosen.phone)}</small>}
              </div>
              {!conversation && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setChosen(null)}
                >
                  Trocar
                </button>
              )}
            </div>
          ) : (
            <>
              <SearchBox
                value={query}
                onChange={setQuery}
                placeholder="Buscar cliente ou telefone"
              />
              <div className="conversation-picker" role="listbox" aria-label="Conversas">
                {results === null ? (
                  <Spinner label="Carregando conversas…" />
                ) : results.length ? (
                  results.map((row) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      key={row.id}
                      onClick={() => setChosen(row)}
                    >
                      <Avatar
                        name={conversationName(row)}
                        seed={row.id}
                        size={36}
                        kind={row.chat_type === "group" ? "group" : "person"}
                        badge={conversationBadge(row, app.me.id)}
                      />
                      <span>
                        <strong className="truncate">{conversationName(row)}</strong>
                        {row.phone && <small>{phone(row.phone)}</small>}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="muted">Nenhuma conversa encontrada.</p>
                )}
              </div>
            </>
          )}
        </div>
        {error && (
          <Notice tone="error" onRetry={chosen && title.trim() ? create : undefined}>
            {error}
          </Notice>
        )}
      </form>
    </Dialog>
  );
}
