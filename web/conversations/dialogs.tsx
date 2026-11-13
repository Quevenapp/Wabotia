// Diálogos curtos da conversa: etiquetas e explicação da janela de 24 horas.
import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useIntents, type Row } from "../lib/api";
import { date } from "../lib/format";
import type { WindowInfo } from "../lib/window";
import { whatsappServiceWindow } from "../whatsapp-service-window";
import { Button, Dialog, Notice, WindowRing, toast } from "../ui";
import { tagsOf } from "./model";

/** Edita as etiquetas da conversa em pílulas (ação `tags`). */
export function TagsDialog({
  conversation,
  onClose,
  onSaved,
}: {
  conversation: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [tags, setTags] = useState<string[]>(() => tagsOf(conversation));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = () => {
    const value = draft.trim().slice(0, 40);
    if (!value) return;
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase()))
      setTags([...tags, value].slice(0, 20));
    setDraft("");
  };
  async function save() {
    if (app.demoBlocked()) return;
    const next = draft.trim()
      ? [...tags, draft.trim().slice(0, 40)].slice(0, 20)
      : tags;
    setBusy(true);
    setError("");
    try {
      await write(`${app.root}/conversations/${conversation.id}/actions`, "POST", {
        action: "tags",
        tags: next,
      });
      toast("Etiquetas salvas.");
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Etiquetas"
      subtitle="Ajudam a equipe a encontrar e organizar as conversas."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={save} busy={busy}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="tag-editor">
        {tags.map((tag) => (
          <span className="pill tone-brand" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={"Remover etiqueta " + tag}
              onClick={() => setTags(tags.filter((item) => item !== tag))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {!tags.length && <span className="muted">Nenhuma etiqueta ainda.</span>}
      </div>
      <form
        className="tag-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          maxLength={40}
          disabled={tags.length >= 20}
          aria-label="Nova etiqueta"
          placeholder={tags.length >= 20 ? "Limite de 20 etiquetas" : "Nova etiqueta"}
          onChange={(event) => setDraft(event.target.value)}
          data-autofocus
        />
        <Button type="submit" variant="secondary" disabled={!draft.trim()}>
          Adicionar
        </Button>
      </form>
      {error && (
        <Notice tone="error" onRetry={save}>
          {error}
        </Notice>
      )}
    </Dialog>
  );
}

/** Explica a regra da janela em três linhas, com a contagem exata. */
export function WindowDialog({
  info,
  clockOffset,
  onClose,
}: {
  info: WindowInfo;
  /** Relógio do servidor menos o relógio local, em milissegundos. */
  clockOffset: number;
  onClose: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  // "Agora" do servidor, andando segundo a segundo enquanto o diálogo está aberto.
  const current = Date.now() + clockOffset;
  const exact = whatsappServiceWindow(
    info.lastCustomer,
    Math.max(current, info.lastCustomer),
  );
  return (
    <Dialog title="Janela de 24 horas" size="sm" onClose={onClose}>
      <div className="window-explain">
        <WindowRing info={info} size={96}>
          <span className="window-ring-text">
            <strong>{info.closed ? "Fechada" : exact.countdown}</strong>
          </span>
        </WindowRing>
        <ol>
          <li>
            O WhatsApp só aceita mensagem livre até 24 horas depois da última
            mensagem do cliente.
          </li>
          <li>
            Cada mensagem nova do cliente reabre o prazo. Respostas da equipe e
            modelos enviados não renovam.
          </li>
          <li>
            Com a janela fechada, a mensagem fica na fila e é entregue quando o
            cliente escrever. Nota interna, protocolo e transferência seguem
            normais.
          </li>
        </ol>
        <p className="muted">
          {info.lastCustomer
            ? `Última mensagem do cliente: ${date(info.lastCustomer)}. ` +
              (info.closed
                ? `Expirou em ${date(info.expiresAt)}.`
                : `Expira em ${date(info.expiresAt)}.`)
            : "Ainda não há mensagem recebida do cliente."}
        </p>
      </div>
    </Dialog>
  );
}
