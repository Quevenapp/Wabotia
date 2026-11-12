// Ligação tocando: cartão fixo no topo da lista de conversas, com
// Recusar/Atender quando o navegador oferece áudio; senão, só o aviso
// (web/DESIGN.md §3, mobile/DESIGN.md §4).
import React from "react";
import { Phone, PhoneOff } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { conversationName } from "../lib/format";
import { navigate } from "../lib/routes";
import { Avatar } from "../ui";
import { CALL_INTENT_KEY } from "./status";
import { useConversationLookup } from "./names";
import "../styles/calls.css";

export function RingingCard() {
  const app = useApp();
  const action = useAction();
  const calls = app.ringingCalls;
  const lookup = useConversationLookup(
    calls.map((call: Row) => call.conversation_id),
  );
  if (!calls.length) return null;
  const audio = !!navigator.mediaDevices?.getUserMedia && !!window.RTCPeerConnection;
  return (
    <div className="ringing-stack">
      {calls.map((call: Row) => {
        const conversation = lookup(call.conversation_id);
        const name = conversation
          ? conversationName(conversation)
          : "Cliente no WhatsApp";
        const open = () =>
          navigate({ area: "conversations", id: call.conversation_id });
        return (
          <div className="ringing-card" role="alert" key={call.id}>
            <span className="ringing-avatar">
              <Avatar name={name} seed={call.conversation_id} size={44} />
            </span>
            <div className="ringing-text">
              <strong className="truncate">Ligação de {name}</strong>
              <small>
                {audio
                  ? "Chamada de voz pelo WhatsApp"
                  : "Este navegador não oferece áudio para atender aqui."}
              </small>
            </div>
            {audio ? (
              <>
                <button
                  type="button"
                  className="call-round small danger"
                  aria-label={"Recusar ligação de " + name}
                  title="Recusar"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      async () => {
                        await app.api(`${app.root}/calls/${call.id}/claim`, "POST", {});
                        await app.api(`${app.root}/calls/${call.id}/reject`, "POST", {});
                      },
                      { success: "Ligação recusada.", retry: false },
                    )
                  }
                >
                  <PhoneOff size={19} />
                </button>
                <button
                  type="button"
                  className="call-round small ok"
                  aria-label={"Atender ligação de " + name}
                  title="Atender"
                  disabled={action.busy}
                  onClick={() => {
                    if (app.demoBlocked()) return;
                    try {
                      sessionStorage.setItem(
                        CALL_INTENT_KEY,
                        JSON.stringify({
                          conversation_id: call.conversation_id,
                          call_id: call.id,
                          action: "accept",
                        }),
                      );
                    } catch {
                      /* sem sessionStorage: a conversa abre e a pessoa atende lá */
                    }
                    open();
                  }}
                >
                  <Phone size={19} />
                </button>
              </>
            ) : (
              <button type="button" className="ringing-open" onClick={open}>
                Abrir conversa
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
