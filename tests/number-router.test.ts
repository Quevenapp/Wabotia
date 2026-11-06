import { env, SELF } from "cloudflare:test";
import { it, expect, vi, afterEach } from "vitest";
import { all, one, exec } from "../src/db";
import { Actor, defaults, uid, now, json } from "../src/types";
import { setSecret, sha, hmac } from "../src/security";
import { accountCommand, metaCredentials } from "../src/meta-accounts";
import {
  numberUsage,
  billingPeriod,
  observeMetaUsage,
} from "../src/number-quota";
import {
  routerCommand,
  routerView,
  selectPoolNumbers,
  routerLink,
  routedMessage,
} from "../src/number-router";
import { inbound, conversation, enqueue, perform } from "../src/service";
import { deliver } from "../src/engine";
import { finishDelivery } from "../src/delivery";
import { metaInbound } from "../src/meta-inbound";
import { visibleConversation } from "../src/visibility";
const admin: Actor = {
  id: "router-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 600,
  runLimit: 3,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(count = 2, baseline = 0) {
  const profile = uid(),
    account = uid(),
    waba = "123" + uid().replace(/\D/g, "");
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Teste roteador",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,timezone,created) VALUES(?,?,?,?,?,?)",
    account,
    profile,
    "Conta teste",
    waba,
    "America/Sao_Paulo",
    now(),
  );
  await setSecret(env, "meta-account:" + account, {
    token: "fake-account-token",
    app_secret: "fake-app-secret",
    verify_token: "fake-verify-token",
  });
  const numbers: any[] = [];
  for (let i = 0; i < count; i++) {
    const id = uid(),
      phone = waba + String(i + 1),
      config = {
        meta_account_id: account,
        waba_id: waba,
        phone_id: phone,
        number: "551199999" + String(i + 1).padStart(4, "0"),
        verified_at: now(),
      };
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','direct','active',?,?)",
      id,
      profile,
      "Número " + (i + 1),
      JSON.stringify(config),
      now(),
    );
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,service_limit,baseline_period,baseline_used,monitored_at) VALUES(?,?,?,1000,?,?,?)",
      id,
      account,
      phone,
      billingPeriod(now(), "America/Sao_Paulo"),
      baseline,
      now() - 1000,
    );
    numbers.push(await one(env, "SELECT * FROM connections WHERE id=?", id));
  }
  const appId = uid(),
    token = "fake-" + uid(),
    scopes = [
      "routing:read",
      "routing:send",
      "routing:paid",
      "conversations:read",
      "conversations:write",
      "media:read",
      "media:write",
    ];
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    appId,
    "Aplicação teste",
    JSON.stringify([profile]),
    JSON.stringify(scopes),
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    appId,
    await sha(token),
    "fake",
    now() + 86400000,
    now(),
  );
  const actor: Actor = {
    ...admin,
    id: "app:" + appId,
    kind: "app",
    role: "service",
    profiles: [profile],
    scopes,
  };
  const pool = await routerCommand(
    env,
    admin,
    profile,
    "router.pool.save",
    {
      account_id: account,
      name: "Grupo teste",
      members: numbers.map((n) => n.id),
      strategy: "least_used",
      enabled: true,
      allow_paid: true,
      public_enabled: true,
    },
    uid(),
  );
  await routerCommand(
    env,
    admin,
    profile,
    "router.grants.save",
    {
      app_id: appId,
      numbers: numbers.map((n) => n.id),
      pools: [pool.id],
      allow_paid: true,
    },
    uid(),
  );
  return { profile, account, waba, numbers, appId, actor, token, pool };
}
async function customer(f: any, n = 0, to = "5511999991111", at = now()) {
  const r = await inbound(
    env,
    f.profile,
    { external_id: to, message_id: uid(), text: "Olá", customer_at: at },
    "channel:" + f.numbers[n].id,
    f.numbers[n].id,
  );
  return conversation(env, r.conversation_id, f.profile);
}
const service = (f: any, more: any = {}) => ({
  pool_id: f.pool.id,
  to: "5511999991111",
  external_id: "pedido-123",
  text: "Resposta de atendimento",
  ...more,
});
const paid = (f: any, more: any = {}) => ({
  pool_id: f.pool.id,
  to: "5511999992222",
  external_id: "pedido-pago",
  allow_paid: true,
  consent: {
    granted: true,
    category: "utility",
    reference: "Aceite no pedido 123",
  },
  template: {
    name: "pedido_atualizado",
    language: "pt_BR",
    components: [{ type: "body", parameters: [{ type: "text", text: "123" }] }],
  },
  ...more,
});
function metaMock(
  components: any[] = [{ type: "BODY", text: "Pedido {{1}} atualizado." }],
) {
  const sent: any[] = [];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    expect(url.startsWith("https://graph.facebook.com/")).toBe(true);
    expect(init.headers.Authorization).toBe("Bearer fake-account-token");
    if (url.includes("/message_templates?"))
      return Response.json({
        data: [
          {
            name: "pedido_atualizado",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            components,
          },
        ],
      });
    if (url.endsWith("/media")) return Response.json({ id: "provider-media" });
    if (url.endsWith("/messages")) {
      sent.push(JSON.parse(init.body));
      return Response.json({ messages: [{ id: "wamid." + uid() }] });
    }
    throw Error("Unexpected Graph call");
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch };
}
it("reserva atomicamente a última unidade da cota em pedidos concorrentes", async () => {
  const f = await fixture(1, 999),
    c = await customer(f);
  const results = await Promise.allSettled([
    enqueue(env, c, admin.id, "text", { text: "A" }, uid()),
    enqueue(env, c, admin.id, "text", { text: "B" }, uid()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1000,
    remaining: 0,
    reserved: 1,
  });
});
it("conta mensagens confirmadas uma vez, mesmo com webhooks duplicados e fora de ordem", async () => {
  const f = await fixture(1),
    c = await customer(f),
    id = await enqueue(
      env,
      c,
      admin.id,
      "text",
      { text: "Olá" },
      "quota:" + uid(),
    );
  await finishDelivery(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", id),
    "wamid.one",
  );
  const event = {
    message_id: "wamid.one",
    status: "delivered",
    timestamp: now(),
    pricing: {
      category: "service",
      billable: false,
      type: "free_customer_service",
    },
  };
  await observeMetaUsage(env, f.numbers[0], event);
  await observeMetaUsage(env, f.numbers[0], event);
  await observeMetaUsage(env, f.numbers[0], {
    ...event,
    status: "sent",
    timestamp: now() - 1000,
  });
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1,
    reserved: 0,
    free_confirmed: 1,
  });
});
it("libera falha confirmada e preserva reserva sem confirmação", async () => {
  const f = await fixture(1),
    c = await customer(f),
    id = await enqueue(env, c, admin.id, "text", { text: "Olá" }, uid());
  await exec(env, "UPDATE outbox SET status='unknown' WHERE id=?", id);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1);
  await exec(
    env,
    "UPDATE outbox SET external_id='wamid.failed' WHERE id=?",
    id,
  );
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "wamid.failed",
    status: "failed",
    timestamp: now(),
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("troca o mês no fuso Meta sem descartar mensagens ainda reservadas", async () => {
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-11-30T23:59:00-03:00"),
  );
  const f = await fixture(1, 900),
    c = await customer(f),
    id = await enqueue(env, c, admin.id, "text", { text: "Olá" }, uid());
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(901);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-12-01T00:01:00-03:00"),
  );
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    period: "2026-12",
    baseline: 0,
    used: 1,
  });
  await exec(
    env,
    "UPDATE outbox SET external_id='wamid.month',status='sent' WHERE id=?",
    id,
  );
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "wamid.month",
    status: "delivered",
    timestamp: now() - 180000,
    pricing: { category: "service", billable: false },
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("conta entregas de outros sistemas e separa modelos pagos da cota de atendimento", async () => {
  const f = await fixture(1);
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "outside-service",
    status: "delivered",
    timestamp: now(),
    pricing: { category: "service", billable: false },
  });
  await observeMetaUsage(env, f.numbers[0], {
    message_id: "outside-template",
    status: "delivered",
    timestamp: now(),
    pricing: { category: "marketing", billable: true },
  });
  expect(await numberUsage(env, f.numbers[0].id)).toMatchObject({
    used: 1,
    delivered: 2,
    free_confirmed: 1,
    billable_confirmed: 1,
  });
});
it("escolhe número disponível e mantém o remetente do atendimento quando a cota acaba", async () => {
  const f = await fixture();
  await customer(f, 0);
  await customer(f, 1);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[0].id,
  );
  const first = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  expect(first.number_id).toBe(f.numbers[1].id);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=999 WHERE connection_id=?",
    f.numbers[1].id,
  );
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=0 WHERE connection_id=?",
    f.numbers[0].id,
  );
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "sender_unavailable" });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      service(f, { pool_id: undefined, number_id: f.numbers[0].id }),
      uid(),
    ),
  ).rejects.toMatchObject({ code: "sender_pinned" });
});
it("recusa janela falsa, destinatário sem mensagem e número não autorizado", async () => {
  const f = await fixture();
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "no_eligible_sender" });
  await customer(f, 0, "5511999991111", now() - 25 * 3600000);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ code: "no_eligible_sender" });
  await exec(env, "DELETE FROM number_router_grants WHERE app_id=?", f.appId);
  expect((await routerView(env, f.actor, f.profile)).numbers).toHaveLength(0);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", service(f), uid()),
  ).rejects.toMatchObject({ status: 403 });
});
it("link público alterna números disponíveis, pausa e esgotamento são respeitados", async () => {
  const f = await fixture(),
    pool = await one(env, "SELECT * FROM number_pools WHERE id=?", f.pool.id);
  const a = await routerLink(env, f.profile, pool.public_token),
    b = await routerLink(env, f.profile, pool.public_token);
  expect(a.url).not.toBe(b.url);
  expect(a.url).toMatch(/^https:\/\/wa.me\/\d+$/);
  await exec(
    env,
    "UPDATE connections SET status='paused' WHERE id=?",
    f.numbers[0].id,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, pool.id)).map((n) => n.id),
  ).toEqual([f.numbers[1].id]);
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[1].id,
  );
  await expect(
    routerLink(env, f.profile, pool.public_token),
  ).rejects.toMatchObject({ code: "pool_exhausted" });
});
it("webhook compartilhado valida assinatura e WABA, separa números e deduplica entradas", async () => {
  const f = await fixture(20);
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: f.waba,
        changes: f.numbers.map((n: any, i: number) => ({
          value: {
            metadata: { phone_number_id: json(n.config).phone_id },
            messages: [
              {
                id: "shared-" + i,
                from: "5511999994444",
                timestamp: String(Math.floor(now() / 1000)),
                type: "text",
                text: { body: "Olá " + i },
              },
            ],
          },
        })),
      },
      {
        id: "other-waba",
        changes: [
          {
            value: {
              metadata: { phone_number_id: json(f.numbers[0].config).phone_id },
              messages: [
                {
                  id: "wrong-account",
                  from: "5511999994444",
                  type: "text",
                  text: { body: "Não aceitar" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(body),
    url = "https://test/webhooks/meta-accounts/" + f.account;
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        body: raw,
        headers: { "X-Hub-Signature-256": "invalid" },
      })
    ).status,
  ).toBe(403);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await SELF.fetch(url, {
          method: "POST",
          body: raw,
          headers: {
            "X-Hub-Signature-256":
              "sha256=" + (await hmac("fake-app-secret", raw)),
          },
        })
      ).status,
    ).toBe(200);
  const convs = await all(
    env,
    "SELECT * FROM conversations WHERE profile_id=?",
    f.profile,
  );
  expect(convs).toHaveLength(20);
  expect(
    (
      await one(
        env,
        "SELECT count(*) n FROM messages WHERE profile_id=?",
        f.profile,
      )
    ).n,
  ).toBe(20);
  expect(
    (
      await SELF.fetch(
        url +
          "?hub.mode=subscribe&hub.verify_token=fake-verify-token&hub.challenge=123",
      )
    ).status,
  ).toBe(200);
  expect(await metaCredentials(env, f.numbers[0])).toMatchObject({
    token: "fake-account-token",
  });
});
it("API exige idempotência, repete o recibo e recusa conteúdo diferente com a mesma chave", async () => {
  const f = await fixture();
  await customer(f, 0);
  const url = `https://test/api/v1/profiles/${f.profile}/router/messages`,
    headers = {
      Authorization: "Bearer " + f.token,
      "Content-Type": "application/json",
      "Idempotency-Key": uid(),
    };
  const first = await SELF.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(service(f)),
  });
  expect(first.status).toBe(202);
  const saved = await first.json<any>();
  const second = await SELF.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(service(f)),
  });
  expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await second.json<any>()).delivery_id).toBe(saved.delivery_id);
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(service(f, { text: "Outra mensagem" })),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await SELF.fetch(url, {
        method: "POST",
        headers: { Authorization: headers.Authorization },
        body: JSON.stringify(service(f)),
      })
    ).status,
  ).toBe(400);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1);
});
it("modelo pago exige autorização por pedido, escopo, origem e consentimento da categoria", async () => {
  const f = await fixture();
  const mock = metaMock();
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, { allow_paid: false }),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    routerCommand(
      env,
      {
        ...f.actor,
        scopes: f.actor.scopes.filter((s) => s !== "routing:paid"),
      },
      f.profile,
      "router.send",
      paid(f),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.send",
      paid(f, {
        consent: { granted: true, category: "marketing", reference: "Prova" },
      }),
      uid(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await exec(env, "UPDATE number_pools SET allow_paid=0 WHERE id=?", f.pool.id);
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "paid_disabled" });
  expect(mock.sent).toHaveLength(0);
});
it("envia modelo aprovado ao telefone real sem abrir janela artificial e isola a conversa da aplicação", async () => {
  const f = await fixture(1, 1000),
    mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  let c = await conversation(env, result.conversation_id, f.profile, f.actor);
  expect(c.last_customer).toBe(0);
  expect(c.external_id).toBe("pedido-pago");
  expect(c.recipient_id).toBe("5511999992222");
  expect(visibleConversation({ ...f.actor, id: "app:other" }, c)).toBe(false);
  await expect(
    inbound(
      env,
      f.profile,
      { external_id: "pedido-pago", message_id: "spoof", text: "Falso" },
      "app:" + f.actor.id,
      null,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0]).toMatchObject({
    to: "5511999992222",
    type: "template",
    template: { name: "pedido_atualizado" },
  });
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(1000);
  const response = await inbound(
    env,
    f.profile,
    {
      external_id: "5511999992222",
      message_id: "reply-real",
      text: "Obrigado",
      customer_at: now(),
    },
    "channel:" + f.numbers[0].id,
    f.numbers[0].id,
  );
  expect(response.conversation_id).toBe(c.id);
  c = await conversation(env, c.id, f.profile);
  expect(c.last_customer).toBeGreaterThan(0);
  expect(
    (
      await one(
        env,
        "SELECT count(*) n FROM conversations WHERE profile_id=?",
        f.profile,
      )
    ).n,
  ).toBe(1);
});
it("modelo com mídia usa arquivo privado autorizado e envia somente o ID Meta", async () => {
  const f = await fixture(1),
    mock = metaMock([
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Pedido {{1}} atualizado." },
    ]),
    media = uid();
  await env.MEDIA.put(f.profile + "/" + media, "fake-image");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    media,
    f.profile,
    "foto.jpg",
    "image/jpeg",
    10,
    f.profile + "/" + media,
    f.actor.id,
    now(),
  );
  const body = paid(f);
  body.template.components.unshift({
    type: "header",
    parameters: [{ type: "image", media_id: media }],
  } as any);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    body,
    uid(),
  );
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent[0].template.components[0]).toEqual({
    type: "header",
    parameters: [{ type: "image", image: { id: "provider-media" } }],
  });
  expect(JSON.stringify(mock.sent)).not.toContain("wabotia_media_id");
});
it("revogar origem antes da entrega cancela o envio e libera a reserva", async () => {
  const f = await fixture(1);
  await customer(f);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const mock = metaMock();
  await exec(env, "DELETE FROM number_router_grants WHERE app_id=?", f.appId);
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("cancelled");
  expect(mock.sent).toHaveLength(0);
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("recusa cadastrar um 21º número e exige confirmação do consumo inicial", async () => {
  const f = await fixture(20);
  const phone = f.waba + "999";
  await exec(
    env,
    "UPDATE meta_accounts SET discovered=?,discovered_at=? WHERE id=?",
    JSON.stringify([
      { phone_id: phone, number: "5511999988888", name: "Extra" },
    ]),
    now(),
    f.account,
  );
  await expect(
    accountCommand(env, admin, f.profile, "meta-number.save", {
      account_id: f.account,
      phone_id: phone,
      baseline_used: 0,
      baseline_confirmed: true,
    }),
  ).rejects.toThrow(/20/);
  const next = await fixture(1);
  await exec(
    env,
    "UPDATE meta_accounts SET discovered=?,discovered_at=? WHERE id=?",
    JSON.stringify([
      { phone_id: phone, number: "5511999988888", name: "Extra" },
    ]),
    now(),
    next.account,
  );
  await expect(
    accountCommand(env, admin, next.profile, "meta-number.save", {
      account_id: next.account,
      phone_id: phone,
      baseline_used: 0,
    }),
  ).rejects.toThrow(/contador inicial/);
});
it("consulta e cancela somente envios autorizados ainda na fila, liberando a reserva", async () => {
  const f = await fixture(1);
  await customer(f);
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  const row = await one(
    env,
    "SELECT * FROM outbox WHERE id=?",
    result.delivery_id,
  );
  expect(await routedMessage(env, f.actor, f.profile, row.id)).toMatchObject({
    status: "pending",
    number_id: f.numbers[0].id,
    billable: null,
  });
  await expect(
    routedMessage(env, { ...f.actor, id: "app:other" }, f.profile, row.id),
  ).rejects.toMatchObject({ status: 404 });
  await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.cancel",
    { id: row.id },
    uid(),
  );
  expect((await numberUsage(env, f.numbers[0].id))!.reserved).toBe(0);
  const mock = metaMock();
  await deliver(env, row);
  expect(mock.sent).toHaveLength(0);
  const next = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    service(f),
    uid(),
  );
  await exec(
    env,
    "UPDATE outbox SET status='sending' WHERE id=?",
    next.delivery_id,
  );
  await expect(
    routerCommand(
      env,
      f.actor,
      f.profile,
      "router.cancel",
      { id: next.delivery_id },
      uid(),
    ),
  ).rejects.toThrow(/fila/);
});
it("não transforma notificações automáticas em modelos pagos fora da janela", async () => {
  const f = await fixture(1),
    c = await customer(f, 0, "5511999991111", now() - 25 * 3600000),
    mock = metaMock();
  const id = await enqueue(
    env,
    c,
    admin.id,
    "notification",
    { text: "Protocolo atualizado" },
    uid(),
  );
  await deliver(env, await one(env, "SELECT * FROM outbox WHERE id=?", id));
  expect(
    await one(env, "SELECT status,error FROM outbox WHERE id=?", id),
  ).toMatchObject({
    status: "failed",
    error: expect.stringContaining("autorização explícita"),
  });
  expect(mock.fetch).not.toHaveBeenCalled();
  expect((await numberUsage(env, f.numbers[0].id))!.used).toBe(0);
});
it("consentimento revogado impede modelo e uma declaração não substitui a revogação", async () => {
  const f = await fixture(1),
    mock = metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await exec(
    env,
    "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,'revoked','Cliente retirou autorização',?)",
    uid(),
    f.profile,
    result.conversation_id,
    now(),
  );
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("failed");
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "consent_revoked" });
  expect(mock.sent).toHaveLength(0);
});
it("confere a revogação novamente depois de preparar uma mídia paga", async () => {
  const f = await fixture(1),
    mock = metaMock([{ type: "HEADER", format: "IMAGE" }]),
    media = uid();
  await env.MEDIA.put(f.profile + "/" + media, "fake-image");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    media,
    f.profile,
    "foto.jpg",
    "image/jpeg",
    10,
    f.profile + "/" + media,
    f.actor.id,
    now(),
  );
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f, {
      template: {
        name: "pedido_atualizado",
        language: "pt_BR",
        components: [
          { type: "header", parameters: [{ type: "image", media_id: media }] },
        ],
      },
    }),
    uid(),
  );
  const original = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (input: any, init: any) => {
    const response = await original(input, init);
    if (String(input).endsWith("/media"))
      await exec(
        env,
        "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,'revoked','Retirado durante upload',?)",
        uid(),
        f.profile,
        result.conversation_id,
        now(),
      );
    return response;
  });
  await deliver(
    env,
    await one(env, "SELECT * FROM outbox WHERE id=?", result.delivery_id),
  );
  expect(mock.sent).toHaveLength(0);
});
it("nova tentativa de modelo exige nova autorização explícita e registra o administrador", async () => {
  const f = await fixture(1);
  metaMock();
  const result = await routerCommand(
    env,
    f.actor,
    f.profile,
    "router.send",
    paid(f),
    uid(),
  );
  await exec(
    env,
    "UPDATE outbox SET status='unknown' WHERE id=?",
    result.delivery_id,
  );
  await expect(
    perform(
      env,
      admin,
      f.profile,
      "delivery.reconcile",
      { id: result.delivery_id, status: "pending" },
      uid(),
    ),
  ).rejects.toThrow(/autorização explícita/);
  const retry = await perform(
    env,
    admin,
    f.profile,
    "delivery.reconcile",
    { id: result.delivery_id, status: "pending", allow_paid: true },
    uid(),
  );
  const saved = await one(env, "SELECT * FROM outbox WHERE id=?", retry.id);
  expect(json(saved.payload).retry_authorization.actor).toBe(admin.id);
  expect(
    (await one(env, "SELECT status FROM outbox WHERE id=?", result.delivery_id))
      .status,
  ).toBe("cancelled");
});
it("escopo pago não substitui permissão paga da origem e números pausados nunca entram no sorteio", async () => {
  const f = await fixture(3),
    mock = metaMock();
  await exec(
    env,
    "UPDATE number_router_grants SET allow_paid=0 WHERE app_id=?",
    f.appId,
  );
  await expect(
    routerCommand(env, f.actor, f.profile, "router.send", paid(f), uid()),
  ).rejects.toMatchObject({ code: "source_not_allowed" });
  await exec(
    env,
    "UPDATE number_pools SET strategy='random' WHERE id=?",
    f.pool.id,
  );
  await exec(
    env,
    "UPDATE connections SET status='paused' WHERE id=?",
    f.numbers[0].id,
  );
  await exec(
    env,
    "UPDATE meta_numbers SET baseline_used=1000 WHERE connection_id=?",
    f.numbers[1].id,
  );
  expect(
    (await selectPoolNumbers(env, f.profile, f.pool.id)).map((n) => n.id),
  ).toEqual([f.numbers[2].id]);
  expect(mock.sent).toHaveLength(0);
});
it("descobre na WABA e adiciona número pausado com histórico, sem expor as credenciais", async () => {
  const f = await fixture(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      expect(String(input)).toContain(`/${f.waba}/phone_numbers?`);
      return Response.json({
        data: [
          {
            id: "99887766",
            display_phone_number: "+55 11 99999-3333",
            verified_name: "Loja",
          },
        ],
      });
    }),
  );
  await accountCommand(env, admin, f.profile, "meta-account.discover", {
    id: f.account,
  });
  const result = await accountCommand(
    env,
    admin,
    f.profile,
    "meta-number.save",
    {
      account_id: f.account,
      phone_id: "99887766",
      baseline_used: 345,
      baseline_confirmed: true,
    },
  );
  expect(result).toMatchObject({
    status: "paused",
    usage: { used: 345, remaining: 655 },
  });
  const view = await routerView(env, admin, f.profile);
  expect(view.numbers.find((n: any) => n.id === result.id).number).toBe(
    "5511999993333",
  );
  expect(JSON.stringify(view)).not.toContain("fake-account-token");
});
