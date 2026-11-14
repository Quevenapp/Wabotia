import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { issueTicket, listBlocklist } from "../src/queue";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

const menus = [
  { id: "fila", label: "Entrar na fila", type: "queue" },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup(queue: any = {}) {
  const f = await fixture();
  const q = await run(f, f.admin, "queue.save", { name: "Geral" });
  const counter = await run(f, f.admin, "counter.save", {
    name: "Guichê 1",
    queue_ids: [q.id],
  });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  await configure(f, { menus, queue: { front_door: true, ...queue } });
  return { f, q, counter };
}
async function say(f: Fixture, text: string, phone: string) {
  const c = await receive(f, f.line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const whatsapp = (f: Fixture, queue: string, phone: string) =>
  issueTicket(env, f.profile, {
    queueId: queue,
    preferential: false,
    source: "whatsapp",
    actorId: "customer",
    phone,
  });
async function absent(
  f: Fixture,
  setup: { q: any; counter: any },
  phone: string,
) {
  const { ticket } = await whatsapp(f, setup.q.id, phone);
  const called = await run(f, f.member, "queue.call_next", {
    id: setup.counter.id,
  });
  expect(called.id).toBe(ticket.id);
  await run(f, f.member, "queue.no_show", { id: ticket.id });
}
const blocks = (f: Fixture, phone: string) =>
  all(
    env,
    "SELECT * FROM queue_blocklist WHERE profile_id=? AND phone=? ORDER BY created",
    f.profile,
    phone,
  );

describe("lista negra e anti-abuso", () => {
  it("3 ausências em 30 dias bloqueiam e o cliente é avisado no WhatsApp", async () => {
    const s = await setup();
    const { f } = s;
    const phone = "5511930000001";
    await absent(f, s, phone);
    await absent(f, s, phone);
    expect(await blocks(f, phone)).toHaveLength(0);
    await absent(f, s, phone);
    const [block] = await blocks(f, phone);
    expect(block).toMatchObject({
      reason: "auto_no_show",
      blocked_by: "system",
    });
    expect(Math.round((block.expires_at - block.created) / 86400000)).toBe(7);

    let c = await say(f, "oi", phone);
    c = await say(f, "1", phone);
    expect((await latest(c.id)).text).toMatch(
      /^Você está impedido de retirar senha pelo WhatsApp até \d\d\/\d\d por ausências seguidas\./,
    );
    await expect(whatsapp(f, s.q.id, phone)).rejects.toMatchObject({
      code: "contact_blocked",
    });

    // Still may talk to a person (default).
    c = await say(f, "2", phone);
    expect(c.state).toBe("waiting");
  });

  it("SAIR antes da chamada não conta como ausência", async () => {
    const s = await setup({ max_daily_per_contact: 10 });
    const { f } = s;
    const phone = "5511930000002";
    await absent(f, s, phone);
    await absent(f, s, phone);
    let c = await say(f, "oi", phone);
    c = await say(f, "1", phone);
    c = await say(f, "sim", phone);
    c = await say(f, "normal", phone);
    c = await say(f, "sair", phone);
    expect((await latest(c.id)).text).toContain("cancelada");
    expect(await blocks(f, phone)).toHaveLength(0);
  });

  it("limite diário e bloqueio por insistência", async () => {
    const s = await setup({ max_daily_per_contact: 2 });
    const { f } = s;
    const phone = "5511930000003";
    for (let i = 0; i < 2; i++) {
      const { ticket } = await whatsapp(f, s.q.id, phone);
      await run(f, f.member, "queue.call_next", { id: s.counter.id });
      await run(f, f.member, "queue.finish", { id: ticket.id });
    }
    await expect(whatsapp(f, s.q.id, phone)).rejects.toMatchObject({
      code: "daily_limit",
    });
    await expect(whatsapp(f, s.q.id, phone)).rejects.toMatchObject({
      code: "daily_limit",
    });
    await expect(whatsapp(f, s.q.id, phone)).rejects.toMatchObject({
      code: "contact_blocked",
    });
    expect((await blocks(f, phone))[0].reason).toBe("auto_too_many");
  });

  it("reincidência dobra o prazo; desbloqueio só por administrador", async () => {
    const s = await setup({ max_daily_per_contact: 20, block_days: 5 });
    const { f } = s;
    const phone = "5511930000004";
    for (let i = 0; i < 3; i++) await absent(f, s, phone);
    const [first] = await blocks(f, phone);
    await expect(
      run(f, f.member, "queue.unblock", { id: first.id }),
    ).rejects.toMatchObject({ status: 403 });
    await run(f, f.admin, "queue.unblock", { id: first.id });
    // The absences behind the first block do not count again.
    await absent(f, s, phone);
    expect(await blocks(f, phone)).toHaveLength(1);
    await absent(f, s, phone);
    await absent(f, s, phone);
    const second = (await blocks(f, phone))[1];
    expect(Math.round((second.expires_at - second.created) / 86400000)).toBe(
      10,
    );
  });

  it("bloqueio manual pela equipe e opção de impedir falar com atendente", async () => {
    const s = await setup({ blocked_can_talk: false });
    const { f } = s;
    const phone = "5511930000005";
    let c = await say(f, "oi", phone);
    const block = await run(f, f.member, "queue.block", {
      conversation_id: c.id,
      days: null,
      note: "Trote",
    });
    expect(block).toMatchObject({ reason: "manual", expires_at: null, phone });
    c = await say(f, "2", phone);
    expect(c.state).not.toBe("waiting");
    expect((await latest(c.id)).text).toBe(
      "Você está impedido de retirar senha pelo WhatsApp. Procure o atendimento presencial.",
    );

    await configure(f, { queue: { operators_can_block: false } });
    await expect(
      run(f, f.member, "queue.block", { phone: "5511930000099" }),
    ).rejects.toMatchObject({
      status: 403,
    });

    // A kiosk ticket of a blocked number stays valid but is not linked.
    const kiosk = await run(f, f.admin, "queue.issue", {
      queue_id: s.q.id,
      preferential: false,
      source: "staff",
    });
    const row = await one(
      env,
      "SELECT link_code FROM queue_tickets WHERE id=?",
      kiosk.id,
    );
    c = await say(f, `SENHA ${kiosk.code} ${row.link_code}`, phone);
    expect((await latest(c.id)).text).toContain("continua válida no balcão");
    expect(
      (
        await one(
          env,
          "SELECT conversation_id FROM queue_tickets WHERE id=?",
          kiosk.id,
        )
      ).conversation_id,
    ).toBeNull();

    const list = await listBlocklist(env, f.admin, f.profile);
    expect(list.data[0]).toMatchObject({ phone, active: true });
  });
});
