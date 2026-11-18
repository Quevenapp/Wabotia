// Painel da fila: a chamada (`call`) e o panorama (`snapshot`) do mesmo
// instante. O envio aos painéis roda fora do comando (ctx.waitUntil); se um
// segundo comando terminar entre a leitura dos eventos e a do panorama, o
// painel recebia `call` da senha A e, logo depois, um panorama em que a
// atual já era a B, antes do `call` da B.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { perform } from "../src/service";
import { bearer, fixture } from "./service-center-fixture";

/** A primeira leitura dos eventos novos no envio aos painéis. */
const EVENTS = /^SELECT id[^]*FROM events WHERE profile_id=\? AND id>\?/;

/**
 * Segura a primeira leitura de eventos do envio aos painéis até `release`:
 * a janela em que outro comando roda inteiro.
 */
function gateEvents(stub: DurableObjectStub) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let armed = true;
  const install = runInDurableObject(stub, async (instance: any) => {
    const original = instance.env;
    const DB = new Proxy(original.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!armed || !EVENTS.test(sql)) return stmt;
            armed = false;
            // Lê agora e só devolve depois: o que a leitura viu fica para
            // trás enquanto o outro comando roda.
            const held =
              (bound: any, method: string) =>
              async (...a: any[]) => {
                const result = await bound[method](...a);
                await gate;
                return result;
              };
            return {
              bind: (...args: any[]) => {
                const bound = stmt.bind(...args);
                return { all: held(bound, "all"), first: held(bound, "first") };
              },
            };
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    instance.env = { ...original, DB };
  });
  return { install, release: () => release() };
}

async function setup() {
  const f = await fixture();
  const run = (op: string, data: any, actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  await run("module.set", { id: "queue", enabled: true });
  const queue = await run("queue.save", { name: "Geral", service_minutes: 10 });
  const counter = await run("counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run("counter.state", { id: counter.id, status: "open" }, f.member);
  for (let i = 0; i < 3; i++)
    await run("queue.issue", {
      queue_id: queue.id,
      preferential: false,
      source: "staff",
    });
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  const command = async (operation: string, data: any, actor = f.member) => {
    const response = await stub.fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({
        profile: f.profile,
        actor,
        operation,
        data,
        key: uid(),
        requestId: uid(),
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as any;
  };
  // O painel: socket da fila, guardando os quadros em ordem.
  const response = await SELF.fetch(
    `https://test/api/v1/profiles/${f.profile}/queue/ws`,
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${await bearer(f.admin)}`,
      },
    },
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const frames: any[] = [];
  ws.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data))),
  );
  return { f, queue, counter, stub, command, frames, ws };
}

/** Espera até um quadro satisfazer `done` (ou falha em 5 s). */
async function until(frames: any[], done: (frames: any[]) => boolean) {
  for (let i = 0; i < 250 && !done(frames); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(done(frames), JSON.stringify(frames.map(summary))).toBe(true);
}
const summary = (f: any) =>
  f.type === "call"
    ? `call ${f.data.code}`
    : f.type === "snapshot"
      ? `snapshot recent=${f.data.recent_calls.map((c: any) => c.code).join(",")} current=${f.data.counters.map((c: any) => c.current?.code ?? "-").join(",")}`
      : f.type;

/**
 * Nenhum panorama mostra uma senha chamada no teste (como última chamada ou
 * atual de guichê) antes de o painel ter recebido o `call` dela.
 */
function coherent(frames: any[], called: Set<string>) {
  const delivered = new Set<string>();
  const problems: string[] = [];
  for (const frame of frames) {
    if (frame.type === "call") delivered.add(frame.data.ticket_id);
    if (frame.type !== "snapshot") continue;
    const shown = [
      ...frame.data.recent_calls.map((c: any) => c.ticket_id),
      ...frame.data.counters.map((c: any) => c.current?.id).filter(Boolean),
    ];
    for (const id of shown)
      if (called.has(id) && !delivered.has(id))
        problems.push(`${summary(frame)} antes do call de ${id}`);
  }
  return problems;
}

describe("painel: chamada e panorama do mesmo instante", () => {
  it("chamar A e chamar B em seguida, com o envio de A no meio", async () => {
    const { stub, command, frames, counter, ws } = await setup();
    // O socket recebe o panorama inicial antes de começar.
    await until(frames, (f) => f.some((x) => x.type === "snapshot"));
    frames.length = 0;
    const { install, release } = gateEvents(stub);
    await install;
    const a = await command("queue.call_next", { id: counter.id });
    // O envio da A está parado na leitura dos eventos; a B roda inteira.
    const b = await command("queue.call_next", { id: counter.id });
    release();
    await until(frames, (f) =>
      f.some(
        (x) =>
          x.type === "snapshot" && x.data.recent_calls[0]?.ticket_id === b.id,
      ),
    );
    expect(
      frames.filter((x) => x.type === "call").map((x) => x.data.code),
    ).toEqual([a.code, b.code]);
    expect(coherent(frames, new Set([a.id, b.id]))).toEqual([]);
    // A janela aconteceu: o envio da A só voltou depois da B, e leva as
    // duas chamadas com o panorama do mesmo instante.
    expect(frames.map((x) => x.type)).toEqual(["call", "call", "snapshot"]);
    ws.close();
  });

  it("chamar A e concluir A em seguida, com o envio de A no meio", async () => {
    const { stub, command, frames, counter, ws } = await setup();
    await until(frames, (f) => f.some((x) => x.type === "snapshot"));
    frames.length = 0;
    const { install, release } = gateEvents(stub);
    await install;
    const a = await command("queue.call_next", { id: counter.id });
    await command("queue.finish", { id: a.id });
    release();
    await until(frames, (f) =>
      f.some(
        (x) => x.type === "snapshot" && x.data.counters[0].current === null,
      ),
    );
    expect(
      frames.filter((x) => x.type === "call").map((x) => x.data.code),
    ).toEqual([a.code]);
    expect(coherent(frames, new Set([a.id]))).toEqual([]);
    // O panorama depois do call é o do mesmo instante dos eventos lidos:
    // a A já concluída, ainda como a última chamada.
    const last = frames.filter((x) => x.type === "snapshot").at(-1);
    expect(last.data.recent_calls[0].ticket_id).toBe(a.id);
    ws.close();
  });
});
