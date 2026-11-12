import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { inbound, enqueue, message } from "../src/service";
import { channelEvent } from "../src/whatsapp";
import { zernioInbound } from "../src/zernio";
import { now, uid } from "../src/types";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const profile_id = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,'Janela',1)",
    profile_id,
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Zernio','zernio','direct','active',?,1)",
    id,
    profile_id,
    JSON.stringify({ account_id: "remote-account" }),
  );
  const conn = await one(env, "SELECT * FROM connections WHERE id=?", id);
  return conn;
}
function payload(
  sentAt: any = new Date(now() - 1000).toISOString(),
  messageId = uid(),
) {
  return {
    id: uid(),
    event: "message.received",
    timestamp: new Date().toISOString(),
    account: { accountId: "remote-account", platform: "whatsapp" },
    conversation: { id: "remote-thread", participantId: "5511999991111" },
    message: {
      id: uid(),
      platform: "whatsapp",
      platformMessageId: messageId,
      direction: "incoming",
      sentAt,
      text: "Cliente",
      attachments: [],
      sender: { id: "5511999991111" },
    },
  };
}
async function receive(conn: any, body: any) {
  return zernioInbound(env, conn, body, async (data) =>
    Response.json(
      data.event
        ? await channelEvent(env, conn, data)
        : await inbound(
            env,
            conn.profile_id,
            data,
            `channel:${conn.id}`,
            conn.id,
          ),
    ),
  );
}
const conversation = (conn: any) =>
  one(env, "SELECT * FROM conversations WHERE connection_id=?", conn.id);

it("janela usa a última mensagem do cliente, com max para fora de ordem e dedupe antes de atualizá-la", async () => {
  const conn = await fixture(),
    latest = now() - 2 * 3600000,
    first = payload(new Date(latest).toISOString()),
    fetch = vi.spyOn(globalThis, "fetch");
  await receive(conn, first);
  expect((await conversation(conn)).last_customer).toBe(latest);
  await receive(conn, payload(new Date(latest - 25 * 3600000).toISOString()));
  expect((await conversation(conn)).last_customer).toBe(latest);
  const duplicate = {
    ...first,
    id: uid(),
    message: { ...first.message, sentAt: new Date().toISOString() },
  };
  expect(await (await receive(conn, duplicate)).json()).toMatchObject({
    duplicate: true,
  });
  expect((await conversation(conn)).last_customer).toBe(latest);
  expect(
    await all(
      env,
      "SELECT id FROM messages WHERE profile_id=?",
      conn.profile_id,
    ),
  ).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("mensagens e templates da empresa, recibos e status não reabrem a janela expirada", async () => {
  const conn = await fixture(),
    customerAt = now() - 25 * 3600000,
    body = payload(new Date(customerAt).toISOString()),
    fetch = vi.spyOn(globalThis, "fetch");
  await receive(conn, body);
  const c = await conversation(conn);
  for (const kind of ["text", "template"]) {
    await enqueue(
      env,
      c,
      "human-test",
      kind,
      { text: "Empresa", template_category: "utility" },
      uid(),
    );
    await message(
      env,
      c,
      "outbound",
      "human-test",
      kind === "template" ? "Template enviado" : "Resposta enviada",
    );
  }
  const outgoing = {
    ...body,
    id: uid(),
    message: {
      ...body.message,
      platformMessageId: uid(),
      direction: "outgoing",
      sentAt: new Date().toISOString(),
    },
    metadata: { templateName: "pedido" },
  };
  expect(await (await receive(conn, outgoing)).json()).toMatchObject({
    ignored: true,
  });
  for (const event of [
    "message.sent",
    "message.delivered",
    "message.read",
    "message.failed",
  ])
    await receive(conn, {
      ...outgoing,
      event,
      statusAt: new Date().toISOString(),
    });
  expect((await conversation(conn)).last_customer).toBe(customerAt);
  expect(now() - (await conversation(conn)).last_customer).toBeGreaterThan(
    86400000,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  undefined,
  "invalid",
  "1970-01-01T00:00:00.000Z",
  "1960-01-01T00:00:00.000Z",
  "future",
])(
  "preserva mensagem com horário %s sem abrir janela nem provocar retry do webhook",
  async (time) => {
    const conn = await fixture(),
      body = payload();
    body.message.sentAt =
      time === "future"
        ? new Date(now() + 86400000).toISOString()
        : (time as any);
    const response = await receive(conn, body);
    expect(response.status).toBe(200);
    expect((await conversation(conn)).last_customer).toBe(0);
    expect(
      await all(
        env,
        "SELECT id FROM messages WHERE profile_id=?",
        conn.profile_id,
      ),
    ).toHaveLength(1);
    expect(await (await receive(conn, body)).json()).toMatchObject({
      duplicate: true,
    });
    const correct = now() - 3600000;
    await receive(conn, payload(new Date(correct).toISOString()));
    await receive(conn, {
      ...body,
      message: { ...body.message, platformMessageId: uid() },
    });
    expect((await conversation(conn)).last_customer).toBe(correct);
  },
);

it("limita pequeno desvio de relógio ao recebimento e honra customer_at zero no ingresso autenticado", async () => {
  const conn = await fixture(),
    before = now();
  await receive(conn, payload(new Date(before + 60000).toISOString()));
  const c = await conversation(conn);
  expect(c.last_customer).toBeGreaterThanOrEqual(before);
  expect(c.last_customer).toBeLessThanOrEqual(now());
  await inbound(
    env,
    conn.profile_id,
    {
      external_id: "5511999991111",
      message_id: uid(),
      text: "Horário desconhecido",
      customer_at: 0,
    },
    `channel:${conn.id}`,
    conn.id,
  );
  expect((await conversation(conn)).last_customer).toBe(c.last_customer);
});

it.each(["message.delivered", "message.read", "message.failed"])(
  "status %s usa statusAt/event.timestamp, nunca sentAt ou relógio local",
  async (event) => {
    const conn = await fixture(),
      body = { ...payload("2026-01-31T20:00:00Z"), event },
      dispatch = vi.fn(async () => Response.json({ ok: true }));
    await zernioInbound(
      env,
      conn,
      {
        ...body,
        statusAt: "2026-02-01T05:00:00Z",
        timestamp: "2026-02-01T06:00:00Z",
      },
      dispatch,
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message_id: body.message.platformMessageId,
        timestamp: Date.parse("2026-02-01T05:00:00Z"),
      }),
    );
    await zernioInbound(
      env,
      conn,
      { ...body, statusAt: "invalid", timestamp: "2026-02-01T06:00:00Z" },
      dispatch,
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timestamp: Date.parse("2026-02-01T06:00:00Z"),
      }),
    );
    await zernioInbound(
      env,
      conn,
      { ...body, statusAt: undefined, timestamp: undefined },
      dispatch,
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ timestamp: 0 }),
    );
  },
);
