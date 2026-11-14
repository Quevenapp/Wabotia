import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import {
  closeDay,
  estimateMinutes,
  nextCycle,
  pickNext,
  serviceDay,
  speech,
} from "../src/queue";
import {
  api,
  application,
  bearer,
  fixture,
  type Fixture,
} from "./service-center-fixture";

const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup(extra: any = {}) {
  const f = await fixture();
  const queue = await run(f, f.admin, "queue.save", {
    name: "Geral",
    service_minutes: 10,
    ...extra,
  });
  const counter = await run(f, f.admin, "counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  return { f, queue, counter };
}
const issue = (f: Fixture, queue: string, preferential = false) =>
  run(f, f.admin, "queue.issue", {
    queue_id: queue,
    preferential,
    source: "staff",
  });

describe("ordem de chamada (porta de fila.rs)", () => {
  const q = (n: number, since: number | null, priority = 0) =>
    new Map([
      [
        "q",
        {
          normals_per_preferential: n,
          normals_since_preferential: since,
          priority,
        },
      ],
    ]);
  const c = (
    id: string,
    preferential: boolean,
    at: number,
    target?: string,
  ) => ({
    id,
    queue_id: "q",
    preferential,
    created_at: at,
    seq: at,
    target_counter_id: target ?? null,
  });
  it("preferencial na frente sem débito e com ciclo zero", () => {
    expect(
      pickNext([c("n1", false, 1), c("p1", true, 2)], q(0, 0), "x")!.id,
    ).toBe("p1");
    expect(
      pickNext([c("n1", false, 1), c("p1", true, 2)], q(2, null), "x")!.id,
    ).toBe("p1");
  });
  it("cede a vez à normal enquanto há débito", () => {
    const list = [c("n1", false, 1), c("p1", true, 2)];
    expect(pickNext(list, q(2, 1), "x")!.id).toBe("n1");
    expect(pickNext(list, q(2, 2), "x")!.id).toBe("p1");
    expect(pickNext([c("p1", true, 1)], q(2, 0), "x")!.id).toBe("p1");
  });
  it("transferida para o guichê vem primeiro", () => {
    const list = [c("p1", true, 1), c("n9", false, 9, "g2")];
    expect(pickNext(list, q(0, 0), "g2")!.id).toBe("n9");
    expect(pickNext(list, q(0, 0), "g1")!.id).toBe("p1");
  });
  it("ciclo, fala e estimativa", () => {
    expect(nextCycle(null, false)).toBe(null);
    expect(nextCycle(1, false)).toBe(2);
    expect(nextCycle(3, true)).toBe(0);
    expect(speech("N023", "Guichê 2")).toBe("Senha N 23, Guichê 2");
    expect(speech("PA105")).toBe("Senha P A 105");
    expect(estimateMinutes(4, 10, 2)).toBe(20);
    expect(estimateMinutes(3, 7, 0)).toBe(21);
  });
});

describe("operações da fila", () => {
  it("numera por tipo e chama na ordem com a proporção preferencial", async () => {
    const { f, queue, counter } = await setup({ normals_per_preferential: 1 });
    const n1 = await issue(f, queue.id);
    const n2 = await issue(f, queue.id);
    const p1 = await issue(f, queue.id, true);
    const n3 = await issue(f, queue.id);
    expect([n1.code, n2.code, p1.code, n3.code]).toEqual([
      "N001",
      "N002",
      "P001",
      "N003",
    ]);
    expect(p1.ahead).toBe(0);
    expect(n3.ahead).toBe(3);

    const order = [];
    for (let i = 0; i < 4; i++)
      order.push(
        (await run(f, f.member, "queue.call_next", { id: counter.id })).code,
      );
    // Preferential first, then one normal per preferential (no more preferentials).
    expect(order).toEqual(["P001", "N001", "N002", "N003"]);
    await expect(
      run(f, f.member, "queue.call_next", { id: counter.id }),
    ).rejects.toMatchObject({
      code: "queue_empty",
    });
    // Calling the next one finished the previous.
    const done = await one(
      env,
      "SELECT count(*) n FROM queue_tickets WHERE queue_id=? AND status='done'",
      queue.id,
    );
    expect(done.n).toBe(3);
  });

  it("rechamar, iniciar, concluir, ausente e transições inválidas", async () => {
    const { f, queue, counter } = await setup();
    const t = await issue(f, queue.id);
    await expect(
      run(f, f.member, "queue.start", { id: t.id }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
    const called = await run(f, f.member, "queue.call_next", {
      id: counter.id,
    });
    expect(called).toMatchObject({
      status: "called",
      counter_name: "Guichê 1",
      call_count: 1,
    });
    expect(
      (await run(f, f.member, "queue.recall", { id: t.id })).call_count,
    ).toBe(2);
    expect((await run(f, f.member, "queue.start", { id: t.id })).status).toBe(
      "serving",
    );
    expect((await run(f, f.member, "queue.finish", { id: t.id })).status).toBe(
      "done",
    );

    const u = await issue(f, queue.id);
    await run(f, f.member, "queue.call_next", { id: counter.id });
    expect((await run(f, f.member, "queue.no_show", { id: u.id })).status).toBe(
      "no_show",
    );
    await expect(
      run(f, f.member, "queue.recall", { id: u.id }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("guichê fechado não chama e transferência por fila e por guichê", async () => {
    const { f, queue, counter } = await setup();
    const other = await run(f, f.admin, "queue.save", {
      name: "Caixa",
      prefix_normal: "C",
      prefix_preferential: "D",
    });
    const second = await run(f, f.admin, "counter.save", {
      name: "Guichê 2",
      queue_ids: [other.id],
    });
    await expect(
      run(f, f.member, "queue.call_next", { id: second.id }),
    ).rejects.toMatchObject({
      code: "counter_closed",
    });
    await run(f, f.other, "counter.state", { id: second.id, status: "open" });

    const t = await issue(f, queue.id);
    await run(f, f.member, "queue.call_next", { id: counter.id });
    const moved = await run(f, f.member, "queue.transfer", {
      id: t.id,
      queue_id: other.id,
    });
    expect(moved).toMatchObject({
      status: "waiting",
      queue_id: other.id,
      code: "N001",
    });
    expect(
      (await run(f, f.other, "queue.call_next", { id: second.id })).id,
    ).toBe(t.id);

    // To a specific counter: only that counter calls it, ahead of the others.
    const later = await issue(f, other.id);
    await run(f, f.other, "queue.transfer", {
      id: t.id,
      counter_id: counter.id,
    });
    await expect(
      run(f, f.member, "queue.call_next", { id: counter.id }),
    ).resolves.toMatchObject({ id: t.id });
    expect(
      (await run(f, f.other, "queue.call_next", { id: second.id })).id,
    ).toBe(later.id);
  });

  it("tempo de espera: fixo e média real", async () => {
    const { f, queue, counter } = await setup({
      wait_mode: "fixed",
      service_minutes: 5,
    });
    for (let i = 0; i < 3; i++) await issue(f, queue.id);
    let overview = await (
      await api(await bearer(f.member), `/profiles/${f.profile}/queue`)
    ).json<any>();
    expect(overview.queues[0].waiting).toEqual({ normal: 3, preferential: 0 });
    expect(overview.queues[0].wait_minutes).toEqual({
      normal: 15,
      preferential: 0,
    });

    await run(f, f.admin, "queue.save", { id: queue.id, wait_mode: "average" });
    const t = await run(f, f.member, "queue.call_next", { id: counter.id });
    await run(f, f.member, "queue.start", { id: t.id });
    await exec(
      env,
      "UPDATE queue_tickets SET started_at=? WHERE id=?",
      now() - 20 * 60000,
      t.id,
    );
    await run(f, f.member, "queue.finish", { id: t.id });
    overview = await (
      await api(await bearer(f.member), `/profiles/${f.profile}/queue`)
    ).json<any>();
    // Two waiting × ~20 min ÷ 1 counter.
    expect(overview.queues[0].wait_minutes.normal).toBeGreaterThanOrEqual(40);
    expect(overview.counters[0]).toMatchObject({
      name: "Guichê 1",
      status: "open",
    });
  });

  it("virada do dia cancela senhas abertas de ontem", async () => {
    const { f, queue } = await setup();
    const t = await issue(f, queue.id);
    await exec(
      env,
      "UPDATE queue_tickets SET service_day='2000-01-01' WHERE id=?",
      t.id,
    );
    await closeDay(env, f.profile);
    const row = await one(
      env,
      "SELECT status,cancel_reason FROM queue_tickets WHERE id=?",
      t.id,
    );
    expect(row).toEqual({ status: "cancelled", cancel_reason: "day_closed" });
    expect((await issue(f, queue.id)).code).toBe("N001");
    expect(serviceDay(Date.UTC(2026, 10, 15, 2, 0))).toBe("2026-11-14");
  });

  it("totem pareado: escopos, idempotência e limite por minuto", async () => {
    const { f, queue } = await setup();
    const reader = await application(f, ["queue:read"]);
    const kiosk = await application(f, ["queue:read", "queue:issue"]);
    const body = { queue_id: queue.id, preferential: true };
    expect(
      (
        await api(
          reader.token,
          `/profiles/${f.profile}/queue/tickets`,
          "POST",
          body,
        )
      ).status,
    ).toBe(403);
    const key = uid();
    const first = await api(
      kiosk.token,
      `/profiles/${f.profile}/queue/tickets`,
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const ticket = await first.json<any>();
    expect(ticket).toMatchObject({
      code: "P001",
      source: "kiosk",
      preferential: true,
    });
    expect(ticket.phone).toBeUndefined();
    const again = await api(
      kiosk.token,
      `/profiles/${f.profile}/queue/tickets`,
      "POST",
      body,
      key,
    );
    expect((await again.json<any>()).id).toBe(ticket.id);
    let last = 0;
    for (let i = 0; i < 6; i++)
      last = (
        await api(
          kiosk.token,
          `/profiles/${f.profile}/queue/tickets`,
          "POST",
          body,
        )
      ).status;
    expect(last).toBe(429);
    // Public tracking shows no phone nor conversation.
    const tracking = await (
      await SELFfetch(`/api/public/queue/${ticket.public_token}`)
    ).json<any>();
    expect(tracking).toMatchObject({ code: "P001", status: "waiting" });
    expect(tracking.phone).toBeUndefined();
  });

  it("painel de TV por token só lê a fila", async () => {
    const { f, queue, counter } = await setup();
    const display = await run(f, f.admin, "queue.display.create", {
      name: "Recepção",
    });
    await issue(f, queue.id);
    await run(f, f.member, "queue.call_next", { id: counter.id });
    const res = await SELFfetch("/api/public/queue-display/state", {
      headers: { Authorization: `Display ${display.token}` },
    });
    expect(res.status).toBe(200);
    const state = await res.json<any>();
    expect(state.recent_calls[0]).toMatchObject({
      code: "N001",
      counter_name: "Guichê 1",
      speech: "Senha N 1, Guichê 1",
    });
    await run(f, f.admin, "queue.display.revoke", { id: display.id });
    expect(
      (
        await SELFfetch("/api/public/queue-display/state", {
          headers: { Authorization: `Display ${display.token}` },
        })
      ).status,
    ).toBe(401);
  });

  it("configuração exige administrador e valida os campos", async () => {
    const f = await fixture();
    await expect(
      run(f, f.member, "queue.save", { name: "X" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      run(f, f.admin, "queue.save", { name: "X", prefix_normal: "P" }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "settings",
        { queue: { notify_ahead: 99 } },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { queue: { front_door: true } },
      uid(),
    );
    const saved = await one(
      env,
      "SELECT settings FROM profiles WHERE id=?",
      f.profile,
    );
    expect(JSON.parse(saved.settings).queue).toMatchObject({
      front_door: true,
      notify_ahead: 2,
    });
  });
});

const SELFfetch = (path: string, init: RequestInit = {}) =>
  SELF.fetch("https://test" + path, init);
