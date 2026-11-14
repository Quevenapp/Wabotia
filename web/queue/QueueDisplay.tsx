// Painel de TV pelo navegador (/painel#t=<token>): senha chamada em destaque,
// últimas chamadas, espera por fila e anúncio por voz. Só leitura.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Maximize, Volume2 } from "lucide-react";
import {
  createAnnouncer,
  unlockAudio,
  useQueueSocket,
  type CallFrame,
} from "./live";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/queue.css";

const tokenFromHash = () =>
  new URLSearchParams(location.hash.replace(/^#/, "")).get("t") || "";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time className="display-clock">
      {now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

export function QueueDisplay() {
  const token = useMemo(tokenFromHash, []);
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [sound, setSound] = useState(false),
    [flash, setFlash] = useState<CallFrame | null>(null);
  const announce = useRef(createAnnouncer());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/public/queue-display/state", {
        headers: { Authorization: `Display ${token}` },
      });
      const data: any = await response.json();
      if (!response.ok)
        throw new Error(data?.error?.message || "Painel indisponível.");
      setState(data);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);

  const live = useQueueSocket(
    token ? "/api/public/queue-display/ws" : null,
    (frame) => {
      if (frame.type === "snapshot")
        setState((old: any) => ({ ...old, ...frame.data }));
      if (frame.type === "call") {
        setFlash(frame.data);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), 12000);
        if (sound) announce.current(frame.data);
      }
    },
    token ? ["wabotia-display", token] : undefined,
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => !live && void load(), 5000);
    return () => clearInterval(timer);
  }, [load, live]);

  // Keep the screen awake where the browser allows it.
  useEffect(() => {
    let lock: any;
    (navigator as any).wakeLock
      ?.request("screen")
      .then((l: any) => (lock = l))
      .catch(() => {});
    return () => lock?.release?.();
  }, []);

  if (!token)
    return (
      <main className="display display-message">
        <h1>Painel de senhas</h1>
        <p>
          Abra o link completo do painel, criado em Gestão → Filas e guichês.
        </p>
      </main>
    );
  if (!state)
    return (
      <main className="display display-message">
        <h1>Painel de senhas</h1>
        <p>{error || "Conectando…"}</p>
      </main>
    );

  const recent: CallFrame[] = state.recent_calls || [];
  const main = flash || recent[0] || null;
  const others = recent
    .filter((c) => c.ticket_id !== main?.ticket_id)
    .slice(0, 5);
  return (
    <main
      className={"display" + (flash ? " calling" : "")}
      onClick={() => {
        if (!sound) setSound(unlockAudio());
      }}
    >
      <header className="display-top">
        <strong>{state.display?.name || "Painel de senhas"}</strong>
        <div className="display-top-right">
          {!live && <span className="display-offline">Reconectando…</span>}
          <Clock />
          <button
            type="button"
            className="display-icon"
            aria-label="Tela cheia"
            onClick={(event) => {
              event.stopPropagation();
              void document.documentElement
                .requestFullscreen?.()
                .catch(() => {});
            }}
          >
            <Maximize size={22} />
          </button>
        </div>
      </header>
      <section className="display-hero" aria-live="assertive">
        {main ? (
          <>
            <span className="display-label">Senha</span>
            <span
              className={"display-code" + (main.preferential ? " pref" : "")}
            >
              {main.code}
            </span>
            <span className="display-counter">{main.counter_name}</span>
            {main.preferential && (
              <span className="display-tag">Preferencial</span>
            )}
          </>
        ) : (
          <span className="display-label">Aguardando a primeira chamada</span>
        )}
      </section>
      <aside className="display-side">
        <h2>Últimas chamadas</h2>
        <ol>
          {others.map((c) => (
            <li key={c.ticket_id + c.at}>
              <b className={c.preferential ? "pref" : ""}>{c.code}</b>
              <span>{c.counter_name}</span>
            </li>
          ))}
          {!others.length && <li className="display-empty">—</li>}
        </ol>
        <h2>Aguardando</h2>
        <ul>
          {(state.queues || [])
            .filter((q: any) => q.enabled)
            .map((q: any) => (
              <li key={q.id}>
                <span>{q.name}</span>
                <b>{q.waiting.normal + q.waiting.preferential}</b>
              </li>
            ))}
        </ul>
      </aside>
      {!sound && (
        <button
          type="button"
          className="display-sound"
          onClick={() => setSound(unlockAudio())}
        >
          <Volume2 size={22} /> Toque para ativar o som das chamadas
        </button>
      )}
    </main>
  );
}
