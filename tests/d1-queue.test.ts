// Idas ao D1 dos comandos quentes da fila (docs/LIMITES.md): cada ida é uma
// viagem até o banco (150 a 470 ms medidos do Brasil), então emitir e chamar
// senha juntam leituras e escritas em lotes. Antes: emitir 16 idas, chamar a
// próxima 17 e o panorama (GET /queue) 12.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { all, exec, one } from "../src/db";
import { json, uid } from "../src/types";
import { perform } from "../src/service";
import { sha } from "../src/security";
import { AHEAD_SQL, callFrame, serviceDay, ticketView } from "../src/queue";
import { bearer, fixture } from "./service-center-fixture";
import { countingEnv, type D1Count } from "./d1-counter";

/** Idas ao D1 (um lote conta uma) de cada caminho. */
const TRIPS: Record<string, number> = {
  // Até a resposta: a abertura (recibo, configurações e o começo da
  // emissão: fila, chave de origem) e a gravação com evento e vista. O
  // fechamento (auditoria + recibo) vai depois da resposta.
  "emitir senha": 2,
  "emitir senha preferencial": 2,
  // Totem (aplicação): o +1 do contador por minuto vai na abertura também.
  "emitir senha no totem": 2,
  // A abertura (com guichê, filas, candidatas e em curso) e o lote da chamada.
  "chamar a próxima": 2,
  "chamar a próxima (encerra a atual)": 2,
  // Pré-rota e o panorama inteiro.
  "GET /queue": 2,
};

async function setup() {
  const f = await fixture();
  const run = (op: string, data: any, actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  await run("module.set", { id: "queue", enabled: true });
  const queue = await run("queue.save", {
    name: "Geral",
    service_minutes: 10,
    normals_per_preferential: 2,
  });
  const counter = await run("counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run("counter.state", { id: counter.id, status: "open" }, f.member);
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  /** O comando pelo Coordinator (/command), contando as idas ao D1. */
  const command = (operation: string, data: any, actor = f.admin) =>
    runInDurableObject(stub, async (instance: any) => {
      const original = instance.env;
      const { env: counted, count } = countingEnv(original);
      instance.env = counted;
      try {
        const response: Response = await instance.fetch(
          new Request("https://coordinator/command", {
            method: "POST",
            body: JSON.stringify({
              profile: f.profile,
              actor,
              operation,
              data,
              key: uid(),
              requestId: uid(),
            }),
          }),
        );
        expect(response.status).toBe(200);
        const timing = response.headers.get("Server-Timing") || "";
        expect(timing).toMatch(/^d1;desc="calls=\d+";dur=\d+/);
        // As idas até a resposta (o Server-Timing é fixado na resposta): o
        // fechamento do recibo vai depois, fora do caminho do cliente.
        const calls = Number(/calls=(\d+)/.exec(timing)![1]);
        return {
          count: { ...count, calls },
          body: (await response.json()) as any,
        };
      } finally {
        instance.env = original;
      }
    });
  return { f, run, queue, counter, command };
}

describe("idas ao D1 da fila", () => {
  it("emitir, chamar e o panorama dentro dos tetos", async () => {
    const { f, queue, counter, command } = await setup();
    const report: Record<string, D1Count> = {};
    report["emitir senha"] = (
      await command("queue.issue", { queue_id: queue.id, preferential: false })
    ).count;
    report["emitir senha preferencial"] = (
      await command("queue.issue", { queue_id: queue.id, preferential: true })
    ).count;
    const totem = {
      id: `app:${uid()}`,
      kind: "app",
      name: "Totem",
      role: "service",
      profiles: [f.profile],
      scopes: ["queue:issue"],
      bots: [],
      rate: 60,
      runLimit: 3,
    };
    report["emitir senha no totem"] = (
      await command(
        "queue.issue",
        { queue_id: queue.id, preferential: false },
        totem as any,
      )
    ).count;
    report["chamar a próxima"] = (
      await command("queue.call_next", { id: counter.id }, f.member)
    ).count;
    report["chamar a próxima (encerra a atual)"] = (
      await command("queue.call_next", { id: counter.id }, f.member)
    ).count;

    const token = await bearer(f.member);
    await exec(
      env,
      "UPDATE sessions SET id=? WHERE hash=?",
      uid(),
      await sha(token),
    );
    const get = async () => {
      const { env: counted, count } = countingEnv(env);
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://test/api/v1/profiles/${f.profile}/queue`, {
          headers: { Authorization: "Bearer " + token },
        }),
        counted as any,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      return { count, body: (await response.json()) as any };
    };
    // A primeira de pessoa no isolado grava o endereço público (uma vez).
    await get();
    const overview = await get();
    report["GET /queue"] = overview.count;

    const over = Object.entries(TRIPS)
      .filter(([name, ceiling]) => report[name].calls > ceiling)
      .map(
        ([name, ceiling]) =>
          `${name}: ${report[name].calls} idas (teto ${ceiling})\n  ${report[name].sql.join("\n  ")}`,
      );
    expect(over).toEqual([]);

    // O panorama lido em lote: duas chamadas, a segunda encerrou a primeira.
    const view = overview.body;
    expect(view.queues).toHaveLength(1);
    expect(view.queues[0].waiting).toEqual({ normal: 1, preferential: 0 });
    expect(view.queues[0].open_counters).toBe(1);
    expect(view.counters[0].current.code).toBe("N001");
    // O nome de quem está no guichê vem junto com o guichê (JOIN users).
    const person = await one(
      env,
      "SELECT name FROM users WHERE id=?",
      view.counters[0].user_id,
    );
    expect(person?.name).toBeTruthy();
    expect(view.counters[0].user_name).toBe(person.name);
    expect(view.recent_calls.map((c: any) => c.code)).toEqual(["N001", "P001"]);
  });

  it("o evento queue.called gravado no lote é o callFrame da senha", async () => {
    const { f, queue, counter, command } = await setup();
    await command("queue.issue", { queue_id: queue.id, preferential: true });
    const { body } = await command(
      "queue.call_next",
      { id: counter.id },
      f.member,
    );
    const ticket = await one(
      env,
      "SELECT * FROM queue_tickets WHERE id=?",
      body.id,
    );
    const q = await one(env, "SELECT * FROM queues WHERE id=?", queue.id);
    const c = await one(env, "SELECT * FROM counters WHERE id=?", counter.id);
    const saved = await one(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='queue.called' AND resource_id=?",
      f.profile,
      body.id,
    );
    expect(json(saved.payload)).toEqual(callFrame(ticket, q, c));
    // O ciclo da fila andou (preferencial zera) só porque a chamada pegou.
    expect(q.normals_since_preferential).toBe(0);
  });

  it("quem está na frente (AHEAD_SQL) bate com a vista da senha", async () => {
    const { f, run, queue, counter } = await setup();
    for (const preferential of [false, true, false, false, true, false])
      await run("queue.issue", {
        queue_id: queue.id,
        preferential,
        source: "staff",
      });
    // Uma preferencial chamada: a fila passa a dever normais.
    await run("queue.call_next", { id: counter.id }, f.member);
    // AHEAD_SQL só lista senhas com conversa (quem recebe o aviso).
    await exec(
      env,
      "UPDATE queue_tickets SET conversation_id=id WHERE queue_id=? AND status='waiting'",
      queue.id,
    );
    const q = await one(env, "SELECT * FROM queues WHERE id=?", queue.id);
    expect([q.normals_per_preferential, q.normals_since_preferential]).toEqual([
      2, 0,
    ]);
    const rows = await all(env, AHEAD_SQL, f.profile, queue.id, serviceDay());
    expect(rows.length).toBe(5);
    for (const row of rows) {
      const { ahead_count, ...ticket } = row;
      const view = await ticketView(env, ticket, { link: false });
      expect([ticket.code, ahead_count]).toEqual([ticket.code, view.ahead]);
    }
  });
});
