// Ligação de voz da conversa. A sinalização (WebRTC + rotas /calls) é a mesma
// de sempre; só a apresentação mudou: tela de ligação em sobreposição, que
// pode ser recolhida para continuar lendo a conversa (web/DESIGN.md §7).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Maximize2,
  Mic,
  MicOff,
  Phone,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import type { Row } from "../lib/api";
import { clock, conversationName, whenLabel } from "../lib/format";
import { Avatar } from "../ui";
import { useConversationLookup } from "./names";
import { CALL_INTENT_KEY, callFailed, callStatus, liveCall } from "./status";
import "../styles/calls.css";

export function CallPanel({
  api,
  root,
  conversation,
  enabled,
  me,
  refresh,
  demo,
  open = false,
  onClose,
  name: givenName,
}: {
  api: any;
  root: string;
  conversation: Row;
  enabled: boolean;
  me: Row;
  refresh: () => Promise<any>;
  demo: boolean;
  /** Abre a tela de ligação mesmo sem chamada em curso (botão do cabeçalho). */
  open?: boolean;
  onClose?: () => void;
  /** Nome do contato, quando quem chama já sabe (a conversa do detalhe não traz). */
  name?: string;
}) {
  const [calls, setCalls] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [muted, setMuted] = useState(false),
    [permission, setPermission] = useState<Row | null>(null),
    [minimized, setMinimized] = useState(false),
    [confirmEnd, setConfirmEnd] = useState(""),
    [, setTick] = useState(0);
  const peer = useRef<RTCPeerConnection | null>(null),
    stream = useRef<MediaStream | null>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    active = useRef<string>(""),
    answerSet = useRef(false),
    alive = useRef(true);
  function close() {
    active.current = "";
    peer.current?.close();
    peer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    answerSet.current = false;
    setMuted(false);
    if (audio.current) audio.current.srcObject = null;
  }
  async function load() {
    if (demo || !enabled) return;
    const result = await api(
      `${root}/calls?conversation_id=${encodeURIComponent(conversation.id)}`,
    );
    if (!alive.current) return;
    setCalls(result.data || []);
    if (active.current) {
      const call = await api(`${root}/calls/${active.current}?session=1`);
      if (!alive.current) return;
      if (!liveCall(call.status)) {
        close();
        return;
      }
      if (
        call.session?.sdp_type === "answer" &&
        peer.current &&
        !answerSet.current
      ) {
        answerSet.current = true;
        try {
          await peer.current.setRemoteDescription({
            type: "answer",
            sdp: call.session.sdp,
          });
        } catch (e) {
          setError(
            "Não foi possível conectar o áudio. Encerre a ligação e confira a rede.",
          );
        }
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    load().catch((e) => setError(e.message));
    const interval = setInterval(
      () => load().catch((e) => setError(e.message)),
      2500,
    );
    const keep = setInterval(() => {
      if (active.current)
        api(`${root}/calls/${active.current}/keepalive`, "POST", {}).catch(
          () => {},
        );
    }, 20000);
    return () => {
      alive.current = false;
      clearInterval(interval);
      clearInterval(keep);
      const id = active.current;
      close();
      if (id) api(`${root}/calls/${id}/terminate`, "POST", {}).catch(() => {});
    };
  }, [conversation.id, enabled, demo]);
  async function setup() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("Use HTTPS e um navegador com microfone e WebRTC.");
    stream.current = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const pc = new RTCPeerConnection();
    peer.current = pc;
    stream.current.getTracks().forEach((t) => pc.addTrack(t, stream.current!));
    pc.ontrack = (e) => {
      if (audio.current) {
        audio.current.srcObject = e.streams[0] || new MediaStream([e.track]);
        audio.current
          .play()
          .catch(() =>
            setNote("Clique em Reproduzir áudio para ouvir a ligação."),
          );
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed")
        setError(
          "A rede não conectou o áudio. Encerre a ligação e verifique firewall, VPN ou acesso UDP.",
        );
    };
    return pc;
  }
  async function gathered(pc: RTCPeerConnection) {
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", done);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", done);
          reject(
            Error("A rede demorou a preparar o áudio. Verifique sua conexão."),
          );
        }, 12000);
        pc.addEventListener("icegatheringstatechange", done);
      });
    return {
      sdp_type: pc.localDescription!.type,
      sdp: pc.localDescription!.sdp,
    };
  }
  async function perform(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message || "Não foi possível completar a ligação.");
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    try {
      const pc = await setup();
      await pc.setLocalDescription(await pc.createOffer());
      const call = await api(root + "/calls", "POST", {
        conversation_id: conversation.id,
        session: await gathered(pc),
      });
      active.current = call.id;
      if (call.status === "unknown" || call.status === "failed") {
        close();
        setError(call.error || "Ligação não confirmada.");
      } else setNote("Aguardando o cliente atender.");
    } catch (e) {
      close();
      throw e;
    }
  }
  async function accept(call: Row) {
    try {
      const claimed = await api(`${root}/calls/${call.id}/claim`, "POST", {});
      active.current = call.id;
      await refresh();
      const pc = await setup();
      if (!claimed.session)
        throw Error("Oferta de áudio ainda não chegou. Aguarde a atualização.");
      await pc.setRemoteDescription({
        type: "offer",
        sdp: claimed.session.sdp,
      });
      await pc.setLocalDescription(await pc.createAnswer());
      const session = await gathered(pc);
      // Pre-accept establishes media before the user is told the call was accepted.
      stream.current?.getAudioTracks().forEach((t) => (t.enabled = false));
      await api(`${root}/calls/${call.id}/pre_accept`, "POST", { session });
      await api(`${root}/calls/${call.id}/accept`, "POST", { session });
      stream.current?.getAudioTracks().forEach((t) => (t.enabled = true));
      setNote("Ligação atendida.");
    } catch (e) {
      const id = active.current;
      close();
      if (id)
        await api(`${root}/calls/${id}/reject`, "POST", {}).catch(() => {});
      throw e;
    }
  }

  const current = calls.filter((c) => liveCall(c.status)),
    own = conversation.owner === me.id && conversation.state === "human",
    main = current[0] || null,
    showing = enabled && (open || current.length > 0);
  const lookup = useConversationLookup(showing ? [conversation.id] : []);

  // "Atender" tocado no cartão da lista: atende assim que a ligação aparece.
  useEffect(() => {
    if (!enabled || busy || !calls.length) return;
    let intent: Row | null = null;
    try {
      intent = JSON.parse(sessionStorage.getItem(CALL_INTENT_KEY) || "null");
    } catch {
      intent = null;
    }
    if (!intent || intent.conversation_id !== conversation.id) return;
    sessionStorage.removeItem(CALL_INTENT_KEY);
    const call = calls.find(
      (item) =>
        item.id === intent!.call_id &&
        item.direction === "inbound" &&
        item.status === "ringing" &&
        (!item.actor || item.actor === me.id),
    );
    if (call && intent.action === "accept") void perform(() => accept(call));
  }, [calls, enabled]);
  // Cronômetro e nova chamada reabre a tela recolhida.
  const activeCall = current.find((c) => c.status === "active");
  useEffect(() => {
    if (!activeCall) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [activeCall?.id]);
  useEffect(() => {
    if (main?.status === "ringing") setMinimized(false);
  }, [main?.id]);
  useEffect(() => {
    if (!showing || minimized) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (current.length) setMinimized(true);
      else onClose?.();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [showing, minimized, current.length, onClose]);

  if (!enabled) return null;
  const name =
    givenName ||
    conversationName({ ...(lookup(conversation.id) || {}), ...conversation, contact_name: conversation.contact_name || lookup(conversation.id)?.contact_name });
  const seconds = (call: Row) =>
    Math.max(0, Math.floor((Date.now() - (call.started || call.updated || call.created)) / 1000));
  const stateText = main
    ? main.status === "active"
      ? clock(seconds(main))
      : callStatus[main.status] || main.status
    : "Ligação de voz";
  const endCall = (call: Row) =>
    perform(async () => {
      await api(`${root}/calls/${call.id}/terminate`, "POST", {});
      close();
    });
  const toggleMute = () => {
    const next = !muted;
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };
  const canPerform = permission?.actions?.some(
    (a: Row) => a.action_name === "start_call" && a.can_perform_action,
  );
  const past = calls.filter((c) => !liveCall(c.status));

  return createPortal(
    <>
      <audio ref={audio} autoPlay aria-label="Áudio da ligação" hidden />
      {showing && minimized && (
        <div className="call-mini" role="status">
          <Phone size={16} aria-hidden />
          <span className="truncate">
            {name} · {stateText}
          </span>
          {active.current && (
            <button
              type="button"
              aria-label={muted ? "Ativar microfone" : "Silenciar microfone"}
              aria-pressed={muted}
              onClick={toggleMute}
            >
              {muted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          <button
            type="button"
            aria-label="Abrir tela da ligação"
            onClick={() => setMinimized(false)}
          >
            <Maximize2 size={15} />
          </button>
          {main && main.actor === me.id && main.status !== "unknown" && (
            <button
              type="button"
              className="end"
              aria-label="Encerrar ligação"
              disabled={busy}
              onClick={() => void endCall(main)}
            >
              <PhoneOff size={16} />
            </button>
          )}
        </div>
      )}
      {showing && !minimized && (
        <div className="call-overlay">
          <section
            className="call-screen"
            role="dialog"
            aria-modal="false"
            aria-label={"Ligação com " + name}
          >
            <header className="call-screen-top">
              {current.length > 0 ? (
                <button
                  type="button"
                  aria-label="Recolher a tela da ligação"
                  title="Recolher"
                  onClick={() => setMinimized(true)}
                >
                  <ChevronDown size={22} />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Fechar"
                  title="Fechar"
                  onClick={() => onClose?.()}
                >
                  <X size={22} />
                </button>
              )}
              <span>Ligação de voz pelo WhatsApp</span>
            </header>
            <div
              className={
                "call-avatar" +
                (main && ["ringing", "dialing"].includes(main.status)
                  ? " pulsing"
                  : "")
              }
            >
              <Avatar
                name={name}
                seed={conversation.id}
                size={112}
                kind={conversation.chat_type === "group" ? "group" : "person"}
              />
            </div>
            <h2 className="call-name">{name}</h2>
            <p className="call-state" aria-live="polite">
              {main
                ? `${stateText} · ${main.direction === "inbound" ? "Recebida" : "Realizada"}`
                : own
                  ? "Pronto para ligar"
                  : "Assuma a conversa para ligar"}
            </p>
            {note && (
              <p className="call-note" role="status">
                {note}
              </p>
            )}
            {error && (
              <p className="call-note error" role="alert">
                {error}
              </p>
            )}
            {active.current && audio.current?.paused && audio.current?.srcObject ? (
              <button
                type="button"
                className="call-chip"
                onClick={() => void audio.current?.play().then(() => setNote(""))}
              >
                Reproduzir áudio
              </button>
            ) : null}
            {permission && (
              <p className="call-note">
                Permissão Meta:{" "}
                {permission.permission?.status === "no_permission"
                  ? "Ainda não concedida"
                  : permission.permission?.status || "Consultar novamente"}{" "}
                ·{" "}
                {canPerform
                  ? "Pode ligar agora"
                  : "Aguarde a autorização ou o fim do limite."}
              </p>
            )}
            <div className="call-controls">
              {current.map((call) => (
                <React.Fragment key={call.id}>
                  {call.direction === "inbound" &&
                    call.status === "ringing" &&
                    (!call.actor || call.actor === me.id) && (
                      <>
                        <span className="call-control">
                          <button
                            type="button"
                            className="call-round danger"
                            aria-label="Recusar"
                            disabled={busy}
                            onClick={() =>
                              perform(async () => {
                                await api(`${root}/calls/${call.id}/claim`, "POST", {});
                                await api(`${root}/calls/${call.id}/reject`, "POST", {});
                              })
                            }
                          >
                            <PhoneOff size={26} />
                          </button>
                          <small>Recusar</small>
                        </span>
                        <span className="call-control">
                          <button
                            type="button"
                            className="call-round ok"
                            aria-label="Atender com microfone"
                            disabled={busy}
                            onClick={() => perform(() => accept(call))}
                          >
                            <Phone size={26} />
                          </button>
                          <small>Atender</small>
                        </span>
                      </>
                    )}
                  {active.current === call.id && (
                    <span className="call-control">
                      <button
                        type="button"
                        className={"call-round" + (muted ? " on" : "")}
                        aria-label={
                          muted ? "Ativar microfone" : "Silenciar microfone"
                        }
                        aria-pressed={muted}
                        onClick={toggleMute}
                      >
                        {muted ? <MicOff size={24} /> : <Mic size={24} />}
                      </button>
                      <small>{muted ? "Mudo" : "Microfone"}</small>
                    </span>
                  )}
                  {call.actor === me.id && call.status !== "unknown" && (
                    <span className="call-control">
                      <button
                        type="button"
                        className="call-round danger"
                        aria-label="Encerrar"
                        disabled={busy}
                        onClick={() => void endCall(call)}
                      >
                        <PhoneOff size={26} />
                      </button>
                      <small>Encerrar</small>
                    </span>
                  )}
                  {call.status === "unknown" && call.actor === me.id && (
                    <button
                      type="button"
                      className="call-chip"
                      disabled={busy}
                      onClick={() => setConfirmEnd(call.id)}
                    >
                      Confirmar encerramento
                    </button>
                  )}
                </React.Fragment>
              ))}
              {current.length === 0 && (
                <span className="call-control">
                  <button
                    type="button"
                    className="call-round ok"
                    aria-label="Ligar"
                    disabled={busy || !own || demo}
                    onClick={() => perform(start)}
                  >
                    <Phone size={26} />
                  </button>
                  <small>Ligar</small>
                </span>
              )}
            </div>
            {confirmEnd && (
              <div className="call-confirm" role="alertdialog" aria-label="Confirmar encerramento">
                <p>Você conferiu no WhatsApp que esta ligação terminou?</p>
                <div>
                  <button
                    type="button"
                    className="call-chip"
                    onClick={() => setConfirmEnd("")}
                  >
                    Ainda não
                  </button>
                  <button
                    type="button"
                    className="call-chip solid"
                    disabled={busy}
                    onClick={() => {
                      const id = confirmEnd;
                      setConfirmEnd("");
                      void perform(async () => {
                        await api(`${root}/calls/${id}/reconcile`, "POST", {
                          confirmed_ended: true,
                        });
                        close();
                      });
                    }}
                  >
                    Sim, terminou
                  </button>
                </div>
              </div>
            )}
            <div className="call-permissions">
              <button
                type="button"
                className="call-chip"
                disabled={busy || !own || demo}
                onClick={() =>
                  perform(async () => {
                    const p = await api(
                      `${root}/conversations/${conversation.id}/call-permission`,
                    );
                    setPermission(p);
                  })
                }
              >
                <ShieldQuestion size={15} /> Verificar permissão
              </button>
              <button
                type="button"
                className="call-chip"
                disabled={busy || !own || demo}
                onClick={() =>
                  perform(async () => {
                    await api(root + "/calls/permission", "POST", {
                      conversation_id: conversation.id,
                    });
                    setNote(
                      "Pedido de permissão entrou na fila. Aguarde a resposta do cliente.",
                    );
                  })
                }
              >
                <ShieldCheck size={15} /> Pedir permissão
              </button>
            </div>
            {past.length > 0 && (
              <details className="call-history">
                <summary>Histórico de ligações</summary>
                <ul>
                  {past.map((call) => (
                    <li key={call.id}>
                      {call.direction === "inbound" ? (
                        <PhoneIncoming
                          size={14}
                          className={callFailed(call.status) ? "missed" : ""}
                        />
                      ) : (
                        <PhoneOutgoing
                          size={14}
                          className={callFailed(call.status) ? "missed" : ""}
                        />
                      )}
                      <span>
                        {whenLabel(call.created)} ·{" "}
                        {callStatus[call.status] || call.status}
                        {call.duration ? ` · ${clock(call.duration)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>
      )}
    </>,
    document.body,
  );
}
