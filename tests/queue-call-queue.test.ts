// Painel de TV: a tela acompanha a fala (web/queue/call-queue.ts). Relógio
// e anúncios controlados pelo teste.
import { describe, expect, it } from "vitest";
import {
  CALL_HOLD_MS,
  CALL_QUEUE_CAP,
  CALL_STALE_MS,
  createCallQueue,
} from "../web/queue/call-queue";
import type { CallFrame } from "../web/queue/live";

const call = (code: string, ticket = code): CallFrame => ({
  ticket_id: ticket,
  code,
  preferential: false,
  queue_id: "q",
  queue_name: "Geral",
  counter_id: "c",
  counter_name: "Guichê 1",
  call_count: 1,
  recall: false,
  at: 0,
  speech: `Senha ${code}, Guichê 1`,
});

function harness() {
  let clock = 0;
  const shown: (string | null)[] = [];
  const spoken: {
    code: string;
    hurry: () => boolean;
    short?: boolean;
    done: () => void;
  }[] = [];
  const timers: { at: number; run: () => void }[] = [];
  const queue = createCallQueue({
    announce: (c, hurry) =>
      new Promise<void>((done) => spoken.push({ code: c.code, hurry, done })),
    show: (c) => shown.push(c?.code ?? null),
    now: () => clock,
    setTimer: (run, ms) => {
      const t = { at: clock + ms, run };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => timers.splice(timers.indexOf(t as any), 1),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    queue,
    shown,
    spoken,
    /** Termina o anúncio em curso (anota se a fala se repetiria). */
    async finish() {
      const current = spoken.at(-1)!;
      current.short = current.hurry();
      current.done();
      await flush();
    },
    async advance(ms: number) {
      clock += ms;
      for (const t of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.run();
      }
      await flush();
    },
  };
}

describe("fila de chamadas do painel", () => {
  it("o destaque é a senha anunciada; a seguinte só entra quando a fala dela começa", async () => {
    const h = harness();
    h.queue.push(call("N001"));
    h.queue.push(call("N002"));
    h.queue.push(call("N003"));
    // Só a N001 na tela, falando; a N002 e a N003 esperam.
    expect(h.shown).toEqual(["N001"]);
    expect(h.spoken.map((s) => s.code)).toEqual(["N001"]);
    expect(h.queue.waiting.map((c) => c.code)).toEqual(["N002", "N003"]);
    await h.finish();
    expect(h.shown).toEqual(["N001", "N002"]);
    await h.finish();
    await h.finish();
    expect(h.shown).toEqual(["N001", "N002", "N003"]);
    // Com outras esperando, fala uma vez; a última, duas.
    expect(h.spoken.map((s) => s.short)).toEqual([true, true, false]);
    // Acabou: o destaque fica e depois volta ao panorama.
    await h.advance(CALL_HOLD_MS - 1);
    expect(h.shown.at(-1)).toBe("N003");
    await h.advance(1);
    expect(h.shown.at(-1)).toBeNull();
  });

  it("rajada de 20 em 20 s: no máximo 3 esperando, e a fala termina logo", async () => {
    const h = harness();
    for (let i = 1; i <= 20; i++) {
      h.queue.push(call(`N${String(i).padStart(3, "0")}`));
      expect(h.queue.waiting.length).toBeLessThanOrEqual(CALL_QUEUE_CAP);
      await h.advance(1000);
    }
    // A primeira ainda falando: as 3 mais novas esperam, as outras só
    // aparecem em "Últimas chamadas".
    expect(h.queue.waiting.map((c) => c.code)).toEqual([
      "N018",
      "N019",
      "N020",
    ]);
    for (let i = 0; i < 3; i++) await h.finish();
    await h.finish();
    expect(h.shown).toEqual(["N001", "N018", "N019", "N020"]);
  });

  it("espera longa demais não é anunciada; rechamada substitui a que espera", async () => {
    const h = harness();
    h.queue.push(call("N001"));
    h.queue.push(call("N002"));
    h.queue.push(call("N002", "N002"));
    expect(h.queue.waiting.map((c) => c.code)).toEqual(["N002"]);
    h.queue.push(call("N003"));
    await h.advance(CALL_STALE_MS + 1);
    h.queue.push(call("N004"));
    await h.finish();
    // N002 e N003 passaram de 30 s esperando: vai direto para a N004.
    expect(h.shown).toEqual(["N001", "N004"]);
  });

  it("nova chamada durante o destaque final cancela a volta ao panorama", async () => {
    const h = harness();
    h.queue.push(call("N001"));
    await h.finish();
    await h.advance(5000);
    h.queue.push(call("N002"));
    await h.advance(CALL_HOLD_MS);
    expect(h.shown).toEqual(["N001", "N002"]);
  });
});
