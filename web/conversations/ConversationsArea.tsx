// Área Conversas (web/DESIGN.md §3 a §5): lista à esquerda, conversa no meio
// e "Dados da conversa" à direita. Abaixo de 760 px, uma coluna por vez.
import React, { useCallback, useRef, useState } from "react";
import { useApp, useAppEvents } from "../app/AppContext";
import { ShortcutList } from "../app/chrome";
import type { Row } from "../lib/api";
import { conversationName } from "../lib/format";
import { navigate } from "../lib/routes";
import { BrandMark, Confirm } from "../ui";
import { NewTicketDialog } from "../tickets/NewTicketDialog";
import "../styles/chat.css";
import { useConversationActions } from "./actions";
import { ChatView, type ChatHandle } from "./ChatView";
import { ConversationList, type QuickAction } from "./ConversationList";
import { TagsDialog } from "./dialogs";
import type { SessionEvent } from "./MessageList";
import { TransferDialog, type TransferTab } from "./TransferDialog";
import { useConversationList } from "./useConversationList";

type DialogState =
  | { kind: "transfer"; conversation: Row; tab?: TransferTab }
  | { kind: "tags"; conversation: Row }
  | { kind: "ticket"; conversation: Row }
  | { kind: "resolve"; conversation: Row }
  | null;

export function ConversationsArea({ id }: { id?: string }) {
  const app = useApp();
  const list = useConversationList();
  const chat = useRef<ChatHandle>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [ticketsVersion, setTicketsVersion] = useState(0);
  // Eventos do atendimento vistos nesta sessão, por conversa (viram chips).
  const [sessionEvents, setSessionEvents] = useState<Record<string, SessionEvent[]>>(
    {},
  );

  const changed = useCallback(
    (conversationId: string) => {
      void list.refresh();
      if (conversationId === id) void chat.current?.reload();
      void app.refresh().catch(() => {});
    },
    [id, list.refresh, app.refresh],
  );
  const actions = useConversationActions(changed);

  useAppEvents((events) => {
    const added: Record<string, SessionEvent[]> = {};
    const push = (conversationId: string, event: SessionEvent) =>
      (added[conversationId] ||= []).push(event);
    for (const event of events) {
      const payload = event.payload || {};
      const key = String(event.id);
      if (event.kind === "conversation.updated") {
        const who = payload.actor ? app.names[payload.actor] : "";
        let text = "";
        if (payload.action === "claim") text = "Conversa assumida";
        else if (payload.action === "resolve") text = "Conversa concluída";
        else if (payload.action === "resume") text = "Conversa devolvida ao bot";
        else if (payload.action === "transfer" && payload.assigned_bot_id)
          text =
            "Transferida para o bot " +
            (app.names["bot:" + payload.assigned_bot_id] || "escolhido") +
            (who ? " por " + who : "");
        else if (payload.action === "transfer" && payload.owner)
          text =
            "Transferida para " +
            (payload.owner === app.me.id
              ? "você"
              : app.names[payload.owner] || "outra pessoa") +
            (who && payload.actor !== payload.owner ? " por " + who : "");
        else if (payload.state === "waiting") {
          const department = (app.settings.departments || []).find(
            (item: Row) => item.id === payload.department_id,
          )?.name;
          text = department
            ? "Encaminhada para a fila do setor " + department
            : "Encaminhada para a fila";
        }
        if (text) push(event.resource_id, { id: key, at: event.created, text });
      } else if (event.kind === "ticket.created" && payload.conversation_id)
        push(payload.conversation_id, {
          id: key,
          at: event.created,
          text: `Protocolo ${payload.number || ""} aberto`.replace("  ", " "),
        });
    }
    if (Object.keys(added).length)
      setSessionEvents((current) => {
        const next = { ...current };
        for (const [conversationId, items] of Object.entries(added)) {
          const known = new Set((next[conversationId] || []).map((item) => item.id));
          next[conversationId] = (next[conversationId] || []).concat(
            items.filter((item) => !known.has(item.id)),
          );
        }
        return next;
      });
  });

  const quick = (action: QuickAction, row: Row) => {
    if (action === "claim")
      void actions.act(row.id, "claim", {}, {
        success:
          row.state === "closed"
            ? "Conversa reaberta e assumida."
            : "Conversa assumida.",
      });
    else if (action === "take")
      void actions.act(row.id, "transfer", { target: app.me.id }, {
        success: "Conversa transferida para você.",
      });
    else if (action === "read") app.markRead(row.id);
    else setDialog({ kind: action, conversation: row } as DialogState);
  };

  return (
    <div className={"area conversations" + (id ? " detail-open" : "")}>
      <ConversationList
        list={list}
        selectedId={id}
        onQuick={quick}
        busyId={actions.busy ? actions.busy.split(":")[0] : null}
      />
      {id ? (
        <ChatView
          key={id}
          ref={chat}
          id={id}
          events={sessionEvents[id] || []}
          onLoaded={list.patch}
          onTransfer={(conversation, tab) =>
            setDialog({ kind: "transfer", conversation, tab })
          }
          onTags={(conversation) => setDialog({ kind: "tags", conversation })}
          onTicket={(conversation) => setDialog({ kind: "ticket", conversation })}
          onResolve={(conversation) => setDialog({ kind: "resolve", conversation })}
          ticketsVersion={ticketsVersion}
        />
      ) : (
        <section className="main-pane pane-empty" aria-label="Nenhuma conversa aberta">
          <BrandMark size={72} />
          <h2>Wabotia</h2>
          <p>
            Escolha uma conversa na lista para ver o contexto e responder. O que
            você enviar chega ao cliente pelo WhatsApp.
          </p>
          <ShortcutList />
        </section>
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          conversation={dialog.conversation}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
          onDone={() => changed(dialog.conversation.id)}
          onNewTicket={() =>
            setDialog({ kind: "ticket", conversation: dialog.conversation })
          }
        />
      )}
      {dialog?.kind === "tags" && (
        <TagsDialog
          conversation={dialog.conversation}
          onClose={() => setDialog(null)}
          onSaved={() => changed(dialog.conversation.id)}
        />
      )}
      {dialog?.kind === "ticket" && (
        <NewTicketDialog
          conversation={dialog.conversation}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setTicketsVersion((value) => value + 1);
            changed(dialog.conversation.id);
          }}
        />
      )}
      {dialog?.kind === "resolve" && (
        <Confirm
          title="Concluir conversa"
          confirmLabel="Concluir"
          busy={actions.isBusy(dialog.conversation.id, "resolve")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const conversation = dialog.conversation;
            const done = await actions.act(conversation.id, "resolve", {}, {
              success: "Conversa concluída.",
            });
            setDialog(null);
            // No celular, concluir devolve a pessoa à lista.
            if (done && conversation.id === id && window.innerWidth < 760)
              navigate({ area: "conversations" });
          }}
        >
          <p>
            Concluir o atendimento de {conversationName(dialog.conversation)}? A
            conversa sai da sua lista e, se a pesquisa de satisfação estiver
            ligada, o cliente recebe o convite para avaliar.
          </p>
        </Confirm>
      )}
    </div>
  );
}
