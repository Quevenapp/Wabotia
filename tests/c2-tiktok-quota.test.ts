import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ApiError, now, uid, type Conversation, type Env } from "../src/types";
import { engineActor } from "../src/security";
import { channelAutomationBlock, loadChannelOperationContext, prepareChannelAction } from "../src/channel-extension-kernel";
import { dispatchChannelDelivery, enqueueChannelPlan, recoverChannelDeliveries } from "../src/engine";
import { completeChannelDelivery, loadChannelDeliveryContext } from "../src/delivery";
import { handoff, perform } from "../src/service";
import type { ChannelAction } from "../src/channel-c2-contracts";
import type { ChannelOperationContext, ChannelOutboxRow } from "../src/channel-c2-contracts";
import type { SocialSendAttachment } from "../src/channel-contracts";
import type { Statement } from "../src/customer/contracts";
import { tiktokExtension, TIKTOK_MAX_MESSAGES, TIKTOK_WINDOW_MS } from "../src/c2/tiktok";
import { c2Fixture, c2ZernioWebhook, installTestExtension, measure, quietCoordinator, type C2Fixture } from "./c2-fixtures";

// Fixtures sintéticas: formato do plano; a conferir com a conta real.
const profiles = new Set<string>();
let clock = 0;
let unexpected: string[] = [];
let requests: { url: string; init?: RequestInit }[] = [];
let remote: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
beforeEach(() => {
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  unexpected = []; requests = []; remote = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (remote) return remote(url, init);
    unexpected.push("chamada externa inesperada");
    throw new Error("Rede inesperada na fixture TikTok.");
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

async function setup(lastCustomer = now() - 1_000) {
  const f = await c2Fixture("tiktok"); profiles.add(f.profile);
  await installTestExtension(f, tiktokExtension);
  const id = uid(), subject = "pessoa:opaca", thread = `thread:${id}`;
  await batch(env, [[
    `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,
      channel,channel_account_id,channel_subject_id,channel_context,chat_type,state,owner,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,'tiktok',?,?,'{"version":1,"context":"direct"}','direct','human',?,?,?,?)`,
    [id, f.profile, f.line, `channel:${f.line}`, `dm:${encodeURIComponent(subject)}`, id, f.account,
      subject, f.admin.id, lastCustomer, now(), now()],
  ], [
    "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?)",
    [f.line, `dm:${encodeURIComponent(subject)}`, thread],
  ]]);
  return { ...f, id, subject, thread };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function context(f: Fixture, commandId = uid(), bot = false): Promise<ChannelOperationContext> {
  return loadChannelOperationContext(env as Env, bot ? engineActor(f.profile, "") : f.admin, f.profile,
    { kind: "conversation", id: f.id }, commandId, bot ? "bot" : "human");
}
async function conversation(f: Fixture) {
  return (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=? AND profile_id=?", f.id, f.profile))!;
}
async function slots(f: C2Fixture) {
  return all<{ id: string; outbox_id: string | null; state: string; counted_at: number; provider_message_id: string | null }>(env,
    "SELECT id,outbox_id,state,counted_at,provider_message_id FROM tiktok_send_slots WHERE profile_id=? ORDER BY created,id", f.profile);
}
async function used(f: Fixture, count: number, at = now()) {
  if (!count) return;
  await batch(env, Array.from({ length: count }, (_, index): Statement => [
    `INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,provider_message_id,state,counted_at,created,updated)
      VALUES(?,?,?,?,?,'external',?,?,?)`,
    [uid(), f.profile, f.line, f.id, `external:${uid()}:${index}`, at, at, at],
  ]));
}
async function enqueue(f: Fixture, text = "Olá, tudo bem?", command = uid(), attachments?: readonly SocialSendAttachment[]) {
  const ctx = await context(f, command);
  const action: ChannelAction = { type: "message.send", text, attachments };
  const plan = await tiktokExtension.prepareSend(ctx, action);
  return { id: await enqueueChannelPlan(ctx, plan, action), ctx, action, plan };
}
async function dispatch(id: string) {
  const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
  await dispatchChannelDelivery(env as Env, row);
  return (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
}
async function image(f: Fixture, bytes = 3_000_000, mimeType = "image/png"): Promise<SocialSendAttachment> {
  const id = uid();
  await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'imagem.png',?,?,?,'test',?)",
    id, f.profile, mimeType, bytes, `test/${id}`, now());
  return { mediaId: id, kind: "image", mimeType, bytes, name: "imagem.png" };
}
function inbound(f: Fixture, timestamp: unknown = now()) {
  return { id: uid(), event: "message.received", account: { accountId: f.account, platform: "tiktok", profileId: f.remoteProfile },
    conversation: { id: f.thread, participantId: f.subject, accountId: f.account, platform: "tiktok", type: "direct" },
    message: { platformMessageId: uid(), conversationId: f.thread, platform: "tiktok", direction: "incoming",
      sender: { id: f.subject, name: "Pessoa sintética" }, text: "Outra entrada", sentAt: timestamp } };
}
function allowMessage(f: Fixture, response: () => Promise<Response>) {
  remote = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "zernio.com" || parsed.pathname !== `/api/v1/inbox/conversations/${encodeURIComponent(f.thread)}/messages` || init?.method !== "POST") {
      unexpected.push("rota externa inesperada");
      throw new Error("A fixture aceita somente uma mensagem TikTok.");
    }
    return response();
  };
}

describe("c2-tiktok: janela e reserva persistente", { timeout: 30_000 }, () => {
  it("canal não usado conserva zero consultas nas guardas de automação e entrega", async () => {
    const result = await measure(env as Env, async counted => {
      for (const channel of ["whatsapp", "instagram", "facebook"] as const)
        expect(await channelAutomationBlock(counted, { channel, chat_type: "direct" } as Conversation, "legacy")).toBeNull();
      expect(await dispatchChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
      expect(await completeChannelDelivery(counted, { kind: "text" } as ChannelOutboxRow)).toBe(false);
    });
    expect(result.count).toMatchObject({ calls: 0, statements: 0 });
    expect(requests).toEqual([]);
  });

  it("aceita antes de 48 horas e bloqueia o instante exato, futuro e timestamp ausente", async () => {
    const f = await setup(now() - TIKTOK_WINDOW_MS + 1);
    const ctx = await context(f);
    expect((await tiktokExtension.prepareSend(ctx, { type: "message.send", text: "No limite" })).deliveries).toHaveLength(1);
    for (const timestamp of [now() - TIKTOK_WINDOW_MS, 0, now() + 1]) {
      await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", timestamp, f.id);
      await expect(tiktokExtension.prepareSend(await context(f), { type: "message.send", text: "Fora do limite" }))
        .rejects.toMatchObject({ code: timestamp <= 0 || timestamp > now() ? "cannot_initiate" : "window_closed" });
    }
    expect(await slots(f)).toEqual([]);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("nova entrada renova prazo sem zerar consumo; data inválida não renova", async () => {
    const f = await setup(now() - TIKTOK_WINDOW_MS + 1_000);
    await used(f, 9);
    const received = await c2ZernioWebhook(f, inbound(f));
    expect(received.ok, await received.clone().text()).toBe(true);
    expect((await conversation(f)).last_customer).toBe(now());
    expect((await tiktokExtension.view!(await context(f))).metadata).toMatchObject({
      remainingMessages: 1, closesAt: now() + TIKTOK_WINDOW_MS,
      tiktok: { remainingMessages: 1, conservativeQuota: true },
    });
    clock += 5_000;
    const invalid = await c2ZernioWebhook(f, inbound(f, "data inválida"));
    expect(invalid.ok).toBe(true);
    expect((await conversation(f)).last_customer).toBe(now() - 5_000);
    expect(await slots(f)).toHaveLength(9);
  }, 30_000);

  it("décima entrega reserva uma vez e décima primeira retorna quota_exhausted", async () => {
    const f = await setup(); await used(f, TIKTOK_MAX_MESSAGES - 1);
    const command = uid(), first = await enqueue(f, "Décima", command);
    expect(await slots(f)).toHaveLength(10);
    expect((await slots(f)).filter(slot => slot.state === "reserved")).toHaveLength(1);
    const replay = await enqueue(f, "Décima", command);
    expect(replay.id).toBe(first.id);
    expect(await slots(f)).toHaveLength(10);
    await expect(enqueue(f, "Décima primeira")).rejects.toMatchObject({ code: "quota_exhausted" });
    expect((await tiktokExtension.view!(await context(f))).metadata).toMatchObject({ remainingMessages: 0, state: "quota_exhausted" });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("texto com imagem exige duas vagas no mesmo lote e explicita texto antes da imagem", async () => {
    const f = await setup(), attachment = await image(f);
    await used(f, 9);
    await expect(enqueue(f, "Descrição", uid(), [attachment])).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(await slots(f)).toHaveLength(9);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    // A rodada antiga deixa a janela móvel; duas entregas entram juntas.
    await exec(env, "UPDATE tiktok_send_slots SET counted_at=? WHERE profile_id=?", now() - TIKTOK_WINDOW_MS, f.profile);
    const planned = await enqueue(f, "Descrição", uid(), [attachment]);
    expect(planned.plan.deliveries.map(item => item.payload.kind)).toEqual(["text", "image"]);
    expect(planned.plan.deliveries[0].payload).toMatchObject({ text: "Descrição" });
    expect(planned.plan.deliveries[1].payload).not.toHaveProperty("text");
    const pending = await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile);
    expect(pending).toHaveLength(2);
    expect((await slots(f)).filter(slot => slot.state === "reserved").map(slot => slot.outbox_id).sort())
      .toEqual(pending.map(row => row.id).sort());
  });

  it("duas preparações concorrentes, humana e bot, disputam a última vaga atomicamente", async () => {
    const f = await setup(); await used(f, 9);
    const human = await context(f), bot = await context(f, uid(), true);
    const action: ChannelAction = { type: "message.send", text: "Última vaga" };
    const plans = await Promise.all([tiktokExtension.prepareSend(human, action), tiktokExtension.prepareSend(bot, action)]);
    const results = await Promise.allSettled([enqueueChannelPlan(human, plans[0], action), enqueueChannelPlan(bot, plans[1], action)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ status: 409, code: "quota_exhausted" });
    expect(await slots(f)).toHaveLength(10);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  }, 30_000);

  it("reconfere prazo na entrega e libera reserva sem rede quando ele expira", async () => {
    const f = await setup(now() - TIKTOK_WINDOW_MS + 1_000);
    const { id } = await enqueue(f);
    clock += 1_000;
    const row = await dispatch(id);
    expect(row.status).toBe("failed"); expect(row.error).toBe("window_closed");
    expect(await slots(f)).toMatchObject([{ outbox_id: id, state: "released" }]);
    expect(requests).toEqual([]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", f.id)).toEqual([]);
  });

  it("mudança da thread depois da reserva impede envio ao destinatário antigo", async () => {
    const f = await setup();
    const { id } = await enqueue(f);
    await exec(env, "UPDATE zernio_conversations SET conversation_id=? WHERE connection_id=? AND external_id=?",
      "outra-thread", f.line, `dm:${encodeURIComponent(f.subject)}`);
    expect((await dispatch(id)).status).toBe("failed");
    expect((await slots(f)).find(slot => slot.outbox_id === id)?.state).toBe("released");
    expect(requests).toEqual([]);
  });

  it("saída externa após reserva impede ultrapassar dez antes da chamada remota", async () => {
    const f = await setup(); await used(f, 9);
    const { id } = await enqueue(f);
    await used(f, 1);
    expect((await dispatch(id)).error).toBe("quota_exhausted");
    expect((await slots(f)).filter(slot => slot.state === "released")).toHaveLength(1);
    expect((await slots(f)).filter(slot => slot.state !== "released")).toHaveLength(10);
    expect(requests).toEqual([]);
  });

  it("reconfere quota depois da reautorização assíncrona imediatamente antes da rede", async () => {
    const f = await setup(); await used(f, 9);
    const { id } = await enqueue(f);
    await exec(env, "UPDATE outbox SET status='sending' WHERE id=?", id);
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    const { context: delivery } = await loadChannelDeliveryContext(env as Env, row);
    const reauthorize = delivery.beforeFetch;
    delivery.beforeFetch = async () => {
      await reauthorize();
      // Outro ingresso confirma uma saída durante as leituras da reautorização.
      await used(f, 1);
    };
    expect(await tiktokExtension.deliver(delivery)).toMatchObject({ kind: "failed", code: "quota_exhausted" });
    expect(requests).toEqual([]);
    await exec(env, "UPDATE outbox SET status='failed',error='quota_exhausted' WHERE id=?", id);
    await completeChannelDelivery(env as Env, row);
    expect((await slots(f)).find(slot => slot.outbox_id === id)?.state).toBe("released");
  });

  it("texto com imagem faz exatamente dois POSTs de mensagem e duas conclusões", async () => {
    const f = await setup(), attachment = await image(f, 8);
    await env.MEDIA.put(`test/${attachment.mediaId}`, new Uint8Array(8), { httpMetadata: { contentType: "image/png" } });
    const queued = await enqueue(f, "Descrição separada", uid(), [attachment]);
    let messageCalls = 0;
    remote = async (url, init) => {
      if (url === "https://zernio.com/api/v1/media/presign" && init?.method === "POST")
        return Response.json({ uploadUrl: "https://upload.example.com/image", publicUrl: "https://cdn.example.com/image.png" });
      if (url === "https://upload.example.com/image" && init?.method === "PUT") return new Response(null, { status: 200 });
      if (url === `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(f.thread)}/messages` && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        if (messageCalls === 0) expect(payload).toEqual({ accountId: f.account, text: "Descrição separada" });
        else {
          expect(payload).toEqual({ accountId: f.account, attachments: [{ type: "image", payload: { url: "https://cdn.example.com/image.png" } }] });
          expect(payload).not.toHaveProperty("text");
        }
        messageCalls++;
        return Response.json({ message: { platformMessageId: `sent:${messageCalls}` } });
      }
      unexpected.push("rota externa inesperada");
      throw new Error("A fixture não permite outra chamada.");
    };
    expect((await dispatch(queued.id)).status).toBe("sent");
    const next = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE profile_id=? AND id<>?", f.profile, queued.id))!;
    expect((await dispatch(next.id)).status).toBe("sent");
    expect(messageCalls).toBe(2);
    expect(requests).toHaveLength(4); // presign e PUT não enviam mensagem de atendimento.
    expect((await slots(f)).map(slot => slot.state)).toEqual(["sent", "sent"]);
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=? AND direction='outbound'", f.id)).toHaveLength(2);
    await recoverChannelDeliveries(env as Env, f.profile);
    expect(requests).toHaveLength(4);
  }, 30_000);

  it("timeout mantém consumo unknown; reconciliação não repete rede nem devolve vaga", async () => {
    const f = await setup(); await used(f, 9);
    const { id } = await enqueue(f);
    allowMessage(f, async () => { throw new Error("Timeout sintético; token e resposta remota não podem escapar."); });
    const row = await dispatch(id);
    expect(row.status).toBe("unknown"); expect(row.error).toBe("provider_unknown");
    expect((await slots(f)).find(slot => slot.outbox_id === id)?.state).toBe("unknown");
    expect(requests).toHaveLength(1);
    await recoverChannelDeliveries(env as Env, f.profile);
    await expect(perform(env as Env, f.admin, f.profile, "delivery.reconcile", { id, status: "pending" }, uid()))
      .rejects.toMatchObject({ code: "provider_contract_unverified" });
    await perform(env as Env, f.admin, f.profile, "delivery.reconcile", { id, status: "cancelled" }, uid());
    expect((await slots(f)).find(slot => slot.outbox_id === id)?.state).not.toBe("released");
    expect(await slots(f)).toHaveLength(10);
    await expect(enqueue(f, "Sem nova vaga")).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(requests).toHaveLength(1);
    const saved = JSON.stringify(await all(env, "SELECT payload,error FROM outbox WHERE profile_id=?", f.profile));
    expect(saved).not.toContain("Timeout sintético");
    expect(saved).not.toContain("chave-sintetica-c2");
  }, 30_000);

  it("crash após reautorização conserva a tentativa recente mesmo com reserva antiga", async () => {
    const f = await setup(); await used(f, 9);
    const { id } = await enqueue(f);
    const attemptedAt = now() - 1_000;
    await batch(env, [
      ["UPDATE tiktok_send_slots SET counted_at=? WHERE outbox_id=?", [now() - TIKTOK_WINDOW_MS - 1, id]],
      ["UPDATE channel_delivery_state SET attempted_at=? WHERE outbox_id=?", [attemptedAt, id]],
      ["UPDATE outbox SET status='unknown',error='provider_unknown',completion_handled=0 WHERE id=?", [id]],
    ]);
    const row = (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", id))!;
    await completeChannelDelivery(env as Env, row);
    await completeChannelDelivery(env as Env, row);
    expect((await slots(f)).find(slot => slot.outbox_id === id)).toMatchObject({ state: "unknown", counted_at: attemptedAt });
    expect((await tiktokExtension.view!(await context(f))).metadata.remainingMessages).toBe(0);
    clock = attemptedAt + TIKTOK_WINDOW_MS - 1;
    await exec(env, "UPDATE conversations SET last_customer=? WHERE id=?", now(), f.id);
    expect((await tiktokExtension.view!(await context(f))).metadata.remainingMessages).toBe(0);
    clock++;
    expect((await tiktokExtension.view!(await context(f))).metadata.remainingMessages).toBe(1);
    expect((await slots(f)).find(slot => slot.outbox_id === id)?.counted_at).toBe(attemptedAt);
    expect(requests).toEqual([]);
  });

  it("cancelamento antes da rede libera, mas recusa remota conhecida continua contabilizada", async () => {
    const f = await setup();
    const first = await enqueue(f);
    await exec(env, "UPDATE outbox SET status='cancelled' WHERE id=?", first.id);
    await completeChannelDelivery(env as Env, (await one<ChannelOutboxRow>(env, "SELECT * FROM outbox WHERE id=?", first.id))!);
    expect((await slots(f)).find(slot => slot.outbox_id === first.id)?.state).toBe("released");
    const second = await enqueue(f);
    allowMessage(f, async () => new Response(JSON.stringify({ code: "account_not_eligible", message: "resposta remota sintética sigilosa" }),
      { status: 403, headers: { "Content-Type": "application/json" } }));
    const row = await dispatch(second.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("tiktok_account_ineligible");
    expect((await slots(f)).find(slot => slot.outbox_id === second.id)?.state).not.toBe("released");
    expect((await tiktokExtension.view!(await context(f))).metadata.state).toBe("tiktok_account_ineligible");
    expect(JSON.stringify(await all(env, "SELECT config FROM connections WHERE id=?", f.line))).not.toContain("resposta remota");
  }, 30_000);

  it("texto e mídia inválidos não reservam e menu numerado usa a mesma quota", async () => {
    const f = await setup(), ctx = await context(f);
    for (const action of [
      { type: "message.send" as const, text: "x".repeat(6_001) },
      { type: "message.send" as const, text: "", attachments: [await image(f, 3_000_001)] },
      { type: "message.send" as const, text: "", attachments: [await image(f, 100, "image/gif")] },
    ]) await expect(tiktokExtension.prepareSend(ctx, action)).rejects.toBeInstanceOf(ApiError);
    const menu = await tiktokExtension.prepareMenu!(ctx, { token: "menu", title: "Como podemos ajudar?",
      items: [{ id: "sales", title: "Vendas" }, { id: "help", title: "Suporte" }], expiresAt: now() + 60_000 });
    expect(menu.deliveries).toHaveLength(1);
    expect(menu.deliveries[0].payload).toMatchObject({ kind: "text" });
    expect(menu.deliveries[0].payload.text).toContain("1. Vendas");
    expect(menu.deliveries[0].payload.text).toContain("2. Suporte");
    expect(menu.deliveries[0].payload).not.toHaveProperty("buttons");
    expect(menu.reservations).toBeTypeOf("function");
    await used(f, 10);
    await expect(tiktokExtension.prepareMenu!(ctx, { token: "menu", title: "Escolha", items: [{ id: "help", title: "Suporte" }], expiresAt: now() + 60_000 }))
      .rejects.toMatchObject({ code: "quota_exhausted" });
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("assinatura humana entra no limite de 6.000 antes de reservar texto ou menu", async () => {
    const f = await setup();
    await batch(env, [
      ["UPDATE users SET name='Ana' WHERE id=?", [f.admin.id]],
      ["UPDATE profiles SET settings=json_set(settings,'$.sender_signature',json('true')) WHERE id=?", [f.profile]],
    ]);
    const ctx = await context(f), text = "x".repeat(6_000);
    expect((await tiktokExtension.prepareSend(ctx, { type: "message.send", text })).deliveries).toHaveLength(1);
    await expect(prepareChannelAction(ctx, { type: "message.send", text })).rejects.toMatchObject({ code: "unsupported_content" });
    const title = "x".repeat(5_990);
    expect((await tiktokExtension.prepareSend(ctx, { type: "message.send", text: `${title}\n\n1. A` })).deliveries).toHaveLength(1);
    await expect(tiktokExtension.prepareMenu!(ctx, { token: "menu-assinado", title, items: [{ id: "a", title: "A" }], expiresAt: now() + 60_000 }))
      .rejects.toMatchObject({ code: "unsupported_content" });
    expect(await slots(f)).toEqual([]);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("transferência com quota esgotada cria somente nota interna e espera por pessoa", async () => {
    const f = await setup(); await used(f, 10);
    await exec(env, "UPDATE conversations SET state='ai',owner=NULL WHERE id=?", f.id);
    const c = await conversation(f);
    expect(await channelAutomationBlock(env as Env, c, "quota-test")).toMatchObject({ code: "quota_exhausted" });
    await handoff(env as Env, c, "Limite de mensagens atingido", null, undefined, false, { source: "staff" });
    expect((await conversation(f)).state).toBe("waiting");
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await slots(f)).toHaveLength(10);
    expect(await all(env, "SELECT direction FROM messages WHERE conversation_id=?", f.id)).toEqual([{ direction: "note" }]);
    expect(requests).toEqual([]);
  }, 30_000);
});
