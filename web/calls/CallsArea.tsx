// Ligações: histórico no estilo do aplicativo (web/DESIGN.md §7,
// mobile/DESIGN.md §10). A ligação em si acontece na conversa (CallPanel).
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
} from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { ListHeader } from "../app/chrome";
import type { Row } from "../lib/api";
import { clock, conversationName, phone, whenLabel } from "../lib/format";
import { linkProps } from "../lib/routes";
import { Avatar, Button, Chip, Empty, Notice, SkeletonRows } from "../ui";
import { RingingCard } from "./RingingCard";
import { useConversationLookup } from "./names";
import { callFailed, callStatus, liveCall } from "./status";
import "../styles/calls.css";

export function CallsArea() {
  const app = useApp();
  const [rows, setRows] = useState<Row[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [missedOnly, setMissedOnly] = useState(false),
    [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0),
    paged = useRef(false);
  const load = useCallback(async () => {
    const mark = ++request.current;
    try {
      const page = await app.api(app.root + "/calls?limit=50");
      if (mark !== request.current) return;
      // Mantém o que já foi carregado em páginas seguintes.
      setRows((existing) => {
        const first: Row[] = page.data || [];
        const ids = new Set(first.map((call) => call.id));
        return [
          ...first,
          ...(existing || []).filter((call) => !ids.has(call.id)),
        ];
      });
      if (!paged.current) setCursor(page.next_cursor || null);
      setError("");
    } catch (e: any) {
      if (mark === request.current) setError(e.message);
    }
  }, [app.api, app.root]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => !document.hidden && void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  useAppEvents((events) => {
    if (
      events.some(
        (event) => event.kind.startsWith("call.") || event.kind === "resync",
      )
    )
      void load();
  });
  const ringing = app.ringingCalls.length;
  useEffect(() => {
    void load();
  }, [ringing]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    paged.current = true;
    setLoadingMore(true);
    try {
      const page = await app.api(
        `${app.root}/calls?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
      setRows((existing) => {
        const ids = new Set((existing || []).map((call) => call.id));
        return [
          ...(existing || []),
          ...(page.data || []).filter((call: Row) => !ids.has(call.id)),
        ];
      });
      setCursor(page.next_cursor || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = (rows || [])
    .filter((call) => !missedOnly || callFailed(call.status))
    .sort((a, b) => b.created - a.created);
  const lookup = useConversationLookup(
    (rows || []).map((call) => call.conversation_id),
  );

  return (
    <div className="area calls-area">
      <section className="list-pane calls-pane" aria-label="Histórico de ligações">
        <ListHeader title="Ligações" />
        <div className="list-toolbar">
          <div className="chip-row" role="group" aria-label="Filtrar ligações">
            <Chip active={!missedOnly} onClick={() => setMissedOnly(false)}>
              Todas
            </Chip>
            <Chip
              active={missedOnly}
              tone="danger"
              onClick={() => setMissedOnly(true)}
              icon={<PhoneMissed size={14} />}
            >
              Perdidas
            </Chip>
          </div>
        </div>
        <div className="pane-scroll">
          <RingingCard />
          {error && (
            <div className="calls-notice">
              <Notice tone="error" onRetry={() => void load()}>
                {error}
              </Notice>
            </div>
          )}
          {rows === null && !error ? (
            <SkeletonRows rows={5} />
          ) : visible.length ? (
            <ul className="call-list">
              {visible.map((call) => {
                const conversation = lookup(call.conversation_id);
                const name = conversation
                  ? conversationName(conversation)
                  : "Conversa";
                const failed = callFailed(call.status),
                  live = liveCall(call.status);
                const Arrow = failed
                  ? PhoneMissed
                  : call.direction === "inbound"
                    ? PhoneIncoming
                    : PhoneOutgoing;
                return (
                  <li key={call.id}>
                    <a
                      {...linkProps({
                        area: "conversations",
                        id: call.conversation_id,
                      })}
                      className={"call-row" + (live ? " live" : "")}
                      title="Abrir conversa"
                    >
                      <Avatar
                        name={name}
                        seed={call.conversation_id}
                        size={48}
                        kind={
                          conversation?.chat_type === "group" ? "group" : "person"
                        }
                      />
                      <span className="call-row-text">
                        <strong className={"truncate" + (failed ? " missed" : "")}>
                          {name}
                        </strong>
                        <small>
                          <Arrow
                            size={14}
                            className={
                              "call-arrow " +
                              (failed
                                ? "missed"
                                : call.direction === "inbound"
                                  ? "in"
                                  : "out")
                            }
                            aria-hidden
                          />
                          <span className="truncate">
                            {call.direction === "inbound" ? "Recebida" : "Realizada"}
                            {" · "}
                            {callStatus[call.status] || call.status}
                            {call.duration ? " · " + clock(call.duration) : ""}
                          </span>
                        </small>
                        {conversation?.phone &&
                          name !== phone(conversation.phone) && (
                            <small className="call-row-phone truncate">
                              {phone(conversation.phone)}
                            </small>
                          )}
                      </span>
                      <span className="call-row-side">
                        <time>{whenLabel(call.created, app.now)}</time>
                        <span className="call-row-action" aria-hidden>
                          <MessageCircle size={18} />
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
              {cursor && (
                <li className="call-more">
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    Carregar mais
                  </Button>
                </li>
              )}
            </ul>
          ) : rows !== null ? (
            <Empty
              icon={<Phone size={28} />}
              title={
                missedOnly ? "Nenhuma ligação perdida" : "Nenhuma ligação registrada"
              }
              description={
                missedOnly
                  ? "Ligações não atendidas, recusadas ou com falha aparecem aqui."
                  : "As ligações recebidas e realizadas pelo WhatsApp aparecem aqui."
              }
            />
          ) : null}
          <div className="calls-notice">
            <Notice>
              O atendimento de áudio pelo navegador não está disponível na
              integração Zernio. O histórico das ligações continua aqui.
            </Notice>
          </div>
        </div>
      </section>
      <section className="main-pane" aria-label="Ligações">
        <div className="pane-empty">
          <span className="empty-icon">
            <Phone size={30} />
          </span>
          <h2>Ligações de voz</h2>
          <p>
            Toque em uma ligação para abrir a conversa. Quando a linha permite
            áudio pelo navegador, o botão de telefone no cabeçalho da conversa
            abre a tela de ligação; chamadas recebidas aparecem no topo da lista
            com Atender e Recusar.
          </p>
        </div>
      </section>
    </div>
  );
}
