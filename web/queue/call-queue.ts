// Fila de chamadas do painel de TV: a tela acompanha a fala
// (docs/FILA-SENHAS.md, "Painel"). Numa rajada (várias chamadas em
// sequência), o destaque é sempre a senha que está sendo anunciada; a
// seguinte só toma o destaque quando o anúncio dela começa. O resto do
// panorama (aguardando, últimas chamadas) atualiza na hora, fora daqui.
//
// Regras:
// 1. Uma chamada por vez: sinal e a fala duas vezes; se, ao fim da primeira
//    fala, houver outras esperando, a fala não se repete.
// 2. Sem som, cada chamada fica no destaque por SILENT_MS.
// 3. No máximo CALL_QUEUE_CAP esperando: chegou mais uma, sai a mais antiga
//    da espera (ela continua em "Últimas chamadas").
// 4. Esperando há mais de CALL_STALE_MS desde que chegou: não é anunciada.
// 5. Rechamada de uma senha que ainda espera substitui a anterior, no mesmo
//    lugar (não fala duas vezes).
// 6. Acabou a fila: o último anunciado fica em destaque por CALL_HOLD_MS e
//    então o painel volta ao normal (a última chamada do panorama).
import type { CallFrame } from "./live";

export const CALL_QUEUE_CAP = 3;
export const CALL_STALE_MS = 30_000;
export const CALL_HOLD_MS = 12_000;
export const SILENT_MS = 4_000;

export interface CallQueueOptions {
  /**
   * Sinal e fala (ou a espera sem som). `hurry()`: há outras esperando
   * agora; perguntado antes de repetir a fala.
   */
  announce: (call: CallFrame, hurry: () => boolean) => Promise<void>;
  /** A senha em destaque, ou null para voltar ao panorama. */
  show: (call: CallFrame | null) => void;
  cap?: number;
  staleMs?: number;
  holdMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function createCallQueue({
  announce,
  show,
  cap = CALL_QUEUE_CAP,
  staleMs = CALL_STALE_MS,
  holdMs = CALL_HOLD_MS,
  now = Date.now,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: CallQueueOptions) {
  const waiting: { call: CallFrame; at: number }[] = [];
  let running = false;
  let hold: unknown;

  async function run() {
    running = true;
    try {
      for (let next = waiting.shift(); next; next = waiting.shift()) {
        if (now() - next.at > staleMs) continue;
        if (hold !== undefined) clearTimer(hold);
        hold = undefined;
        show(next.call);
        try {
          await announce(next.call, () => waiting.length > 0);
        } catch {
          // Sem voz: segue para a próxima.
        }
      }
    } finally {
      running = false;
    }
    hold = setTimer(() => {
      hold = undefined;
      show(null);
    }, holdMs);
  }

  return {
    push(call: CallFrame) {
      const same = waiting.findIndex(
        (w) => w.call.ticket_id === call.ticket_id,
      );
      if (same >= 0) waiting[same] = { call, at: now() };
      else waiting.push({ call, at: now() });
      while (waiting.length > cap) waiting.shift();
      if (!running) void run();
    },
    /** Senhas esperando a vez de ser anunciadas (sem a atual). */
    get waiting() {
      return waiting.map((w) => w.call);
    },
  };
}
