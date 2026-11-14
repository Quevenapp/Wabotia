// Tempo real da fila (docs/FILA-SENHAS.md, "Tempo real"): WebSocket com
// reconexão e anúncio por voz das chamadas para os painéis.
import { useEffect, useRef, useState } from "react";

export type QueueFrame =
  | { type: "snapshot"; data: any }
  | { type: "call"; data: CallFrame }
  | { type: "pong" };

export type CallFrame = {
  ticket_id: string;
  code: string;
  preferential: boolean;
  queue_id: string;
  queue_name: string;
  counter_id: string | null;
  counter_name: string | null;
  call_count: number;
  recall: boolean;
  at: number;
  speech: string;
};

/**
 * Mantém um WebSocket aberto enquanto `path` existir. Reconecta com espera
 * crescente (1 s → 30 s). `connected` indica se as atualizações chegam ao vivo;
 * quem usa deve reler por HTTP enquanto estiver desconectado.
 */
export function useQueueSocket(
  path: string | null,
  onFrame: (frame: QueueFrame) => void,
  protocols?: string[],
) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onFrame);
  handler.current = onFrame;
  const key = protocols?.join(",") || "";
  useEffect(() => {
    if (!path) return;
    let socket: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      ping: ReturnType<typeof setInterval> | undefined,
      wait = 1000,
      closed = false;
    const open = () => {
      const url = new URL(path, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = protocols?.length
          ? new WebSocket(url.href, protocols)
          : new WebSocket(url.href);
      } catch {
        retry();
        return;
      }
      socket.onopen = () => {
        wait = 1000;
        setConnected(true);
        ping = setInterval(
          () => socket?.readyState === 1 && socket.send('{"type":"ping"}'),
          25000,
        );
      };
      socket.onmessage = (event) => {
        try {
          handler.current(JSON.parse(String(event.data)));
        } catch {
          /* quadro inválido: ignora */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        retry();
      };
    };
    const retry = () => {
      if (closed) return;
      timer = setTimeout(open, wait);
      wait = Math.min(30000, wait * 2);
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(ping);
      socket?.close();
    };
  }, [path, key]);
  return connected;
}

let audio: AudioContext | null = null;
/** Precisa de um toque na página antes (política de áudio dos navegadores). */
export function unlockAudio() {
  try {
    audio ||= new AudioContext();
    void audio.resume();
    // Algumas TVs só liberam a voz depois de uma fala iniciada por toque.
    speechSynthesis?.speak(new SpeechSynthesisUtterance(""));
  } catch {
    /* sem áudio */
  }
  return !!audio;
}
function chime() {
  if (!audio) return Promise.resolve();
  const start = audio.currentTime;
  for (const [offset, freq] of [
    [0, 880],
    [0.28, 660],
  ] as const) {
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, start + offset + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + offset);
    osc.stop(start + offset + 0.55);
  }
  return new Promise((resolve) => setTimeout(resolve, 900));
}
function say(text: string) {
  return new Promise<void>((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 0.95;
    const voice = speechSynthesis
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith("pt"));
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.speak(utterance);
    setTimeout(resolve, 8000);
  });
}

/** Fila de anúncios: uma chamada por vez; rajadas grandes só tocam o sinal. */
export function createAnnouncer() {
  let chain = Promise.resolve();
  let pending = 0;
  return (call: CallFrame, voice = true) => {
    pending++;
    chain = chain.then(async () => {
      const burst = pending > 4;
      await chime();
      if (voice && !burst) {
        await say(call.speech);
        await new Promise((r) => setTimeout(r, 400));
        await say(call.speech);
      }
      pending--;
    });
  };
}
