import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid, type Actor } from "../src/types";
import { hmac } from "../src/security";
import { modulesApi, onPaymentUpdated } from "../src/modules/api";
import { expirePayments } from "../src/payments";
import { mpManifest, mpState } from "../src/payments-mercadopago";
import {
  api,
  bearer,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const SECRET = "segredo-do-webhook-de-teste";
const TOKEN = "APP_USR-token-de-teste";

// Mercado Pago simulado: nenhuma chamada sai para a rede.
type Remote = {
  status: string;
  status_detail?: string;
  amount: number;
  ref: string;
};
let remote: Map<string, Remote>;
let calls: { method: string; path: string; body: any; headers: Headers }[];
let nextId: number;
beforeEach(() => {
  remote = new Map();
  calls = [];
  nextId = 900000 + Math.floor(Math.random() * 90000);
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== "https://api.mercadopago.com")
      return new Response("{}", { status: 404 });
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname,
      body,
      headers: new Headers(init.headers),
    });
    const reply = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (new Headers(init.headers).get("Authorization") !== `Bearer ${TOKEN}`)
      return reply({ message: "invalid access token" }, 401);
    if (method === "GET" && url.pathname === "/users/me")
      return reply({ id: 4242, nickname: "LOJA_TESTE" });
    if (method === "POST" && url.pathname === "/v1/payments") {
      const id = String(nextId++);
      remote.set(id, {
        status: "pending",
        amount: body.transaction_amount,
        ref: body.external_reference,
      });
      return reply(
        {
          id: Number(id),
          status: "pending",
          status_detail: "pending_waiting_transfer",
          point_of_interaction: {
            transaction_data: {
              qr_code: `00020126PIX${id}`,
              qr_code_base64: "iVBORw0KGgo=",
              ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket`,
            },
          },
        },
        201,
      );
    }
    if (method === "POST" && url.pathname === "/checkout/preferences")
      return reply(
        {
          id: "pref-" + body.external_reference,
          init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${body.external_reference}`,
        },
        201,
      );
    const match = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
    if (match && method === "GET") {
      const r = remote.get(match[1]);
      if (!r) return reply({ message: "not found" }, 404);
      return reply({
        id: Number(match[1]),
        status: r.status,
        status_detail: r.status_detail || "",
        transaction_amount: r.amount,
        currency_id: "BRL",
        external_reference: r.ref,
        date_approved:
          r.status === "approved" ? "2026-11-15T12:00:00.000-03:00" : null,
      });
    }
    if (method === "PUT") return reply({});
    return reply({ message: "unexpected" }, 400);
  });
});
afterEach(() => vi.unstubAllGlobals());

const run = (f: Fixture, actor: Actor, op: string, data: any) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup() {
  const f = await fixture();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://atendimento.example.com',?)",
    now(),
  );
  const account = await run(f, f.admin, "payment.account.save", {
    provider: "mercadopago",
    access_token: TOKEN,
    webhook_secret: SECRET,
    payer_email: "pagamentos@loja.example.com",
  });
  return { f, account };
}
async function claimed(f: Fixture, phone: string, line = f.line) {
  const c = await receive(f, line, "quero pagar", phone);
  await drain(f);
  await run(f, f.member, "conversation.action", { id: c.id, action: "claim" });
  return conversation(env, c.id, f.profile);
}
const charge = (f: Fixture, c: any, body: any = {}) =>
  run(f, f.member, "conversation.action", {
    id: c.id,
    action: "charge",
    method: "pix",
    amount_cents: 1250,
    description: "Consulta de 15/11",
    ...body,
  });
async function webhook(
  accountId: string,
  dataId: string,
  options: { secret?: string; requestId?: string; type?: string } = {},
) {
  const ts = String(Date.now());
  const requestId = options.requestId || uid();
  const v1 = await hmac(
    options.secret || SECRET,
    mpManifest(dataId, requestId, ts),
  );
  return SELF.fetch(
    `https://test/webhooks/payments/mercadopago/${accountId}?data.id=${dataId}&type=${options.type || "payment"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        action: "payment.updated",
        type: options.type || "payment",
        data: { id: dataId },
        live_mode: true,
      }),
    },
  );
}
const row = (id: string) => one(env, "SELECT * FROM payments WHERE id=?", id);
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT * FROM events WHERE profile_id=? AND kind=?",
    f.profile,
    kind,
  );

describe("Cobrança: conta do provedor", () => {
  it("guarda credenciais cifradas e nunca as devolve", async () => {
    const { f, account } = await setup();
    expect(JSON.stringify(account)).not.toContain(TOKEN);
    expect(JSON.stringify(account)).not.toContain(SECRET);
    expect(account).toMatchObject({
      provider: "mercadopago",
      access_token_set: true,
      webhook_secret_set: true,
      webhook_url: `https://atendimento.example.com/webhooks/payments/mercadopago/${account.id}`,
    });
    const stored = await one(
      env,
      "SELECT value FROM secrets WHERE id=?",
      "payment-account:" + account.id,
    );
    expect(stored.value).not.toContain(TOKEN);
    const token = await bearer(f.admin);
    const view = await (
      await api(token, `/profiles/${f.profile}/payments/account`)
    ).json<any>();
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const checked = await (
      await api(token, `/profiles/${f.profile}/payments/account/check`)
    ).json<any>();
    expect(checked.checked).toMatchObject({ id: "4242", name: "LOJA_TESTE" });
    // Atendente não lê nem altera a conta.
    expect(
      (
        await api(
          await bearer(f.member),
          `/profiles/${f.profile}/payments/account`,
        )
      ).status,
    ).toBe(403);
    // Salvar sem informar de novo mantém os segredos.
    await run(f, f.admin, "payment.account.save", {
      payer_email: "outro@loja.example.com",
    });
    const again = await (
      await api(token, `/profiles/${f.profile}/payments/account/check`)
    ).json<any>();
    expect(again.payer_email).toBe("outro@loja.example.com");
  });
});

describe("Cobrança: criar e entregar", () => {
  it("Pix pela ação Cobrar: botão com o QR na linha oficial e o código copiável", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000001");
    const payment = await charge(f, c);
    expect(payment).toMatchObject({
      status: "created",
      method: "pix",
      amount_cents: 1250,
      trigger: "agent",
    });
    const create = calls.find(
      (x) => x.path === "/v1/payments" && x.method === "POST",
    )!;
    expect(create.body).toMatchObject({
      transaction_amount: 12.5,
      payment_method_id: "pix",
      external_reference: payment.id,
      payer: { email: "pagamentos@loja.example.com" },
      notification_url: `https://atendimento.example.com/webhooks/payments/mercadopago/${account.id}`,
    });
    expect(create.body.date_of_expiration).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-03:00$/,
    );
    expect(create.headers.get("X-Idempotency-Key")).toBe(payment.id);
    const sent = await outbox(c.id);
    const button = sent.find((m) => m.content?.interactive?.type === "cta_url");
    expect(button.content.interactive.action.parameters).toMatchObject({
      display_text: "Ver QR Code Pix",
      url: expect.stringContaining("/ticket"),
    });
    expect(button.text).toMatch(/Valor: R\$\s12,50/);
    expect(sent.at(-1).text).toBe(payment.pix_code);
    expect(await events(f, "payment.created")).toHaveLength(1);
    // Repetir o mesmo pedido (mesma Idempotency-Key) não cobra de novo.
    const key = uid();
    const token = await bearer(f.member);
    const body = {
      action: "charge",
      method: "link",
      amount_cents: 5000,
      description: "Sinal",
    };
    const a = await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      body,
      key,
    );
    const b = await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      body,
      key,
    );
    expect((await a.json<any>()).id).toBe((await b.json<any>()).id);
    expect(
      calls.filter((x) => x.path === "/checkout/preferences"),
    ).toHaveLength(1);
  });

  it("link pela linha QR: link no texto, sem botão", async () => {
    const { f } = await setup();
    const c = await claimed(f, "5511970000002", f.qr);
    const payment = await charge(f, c, { method: "link" });
    const sent = await latest(c.id);
    expect(sent.content).toBeUndefined();
    expect(sent.text).toContain(payment.url);
  });

  it("recusa sem conta, sem responsabilidade, fora da janela e com o módulo desligado", async () => {
    const f = await fixture();
    await exec(
      env,
      "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://x.example.com',?)",
      now(),
    );
    const c = await claimed(f, "5511970000003");
    await expect(charge(f, c)).rejects.toMatchObject({
      code: "payments_not_configured",
    });
    const { f: g } = await setup();
    const d = await receive(g, g.line, "oi", "5511970000004");
    await drain(g);
    await expect(charge(g, d)).rejects.toMatchObject({
      code: "invalid_request",
    });
    const e = await claimed(g, "5511970000005");
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86400000,
      e.id,
    );
    await expect(
      charge(g, await conversation(env, e.id, g.profile)),
    ).rejects.toMatchObject({ code: "window_closed" });
    await run(g, g.admin, "module.set", { id: "payments", enabled: false });
    const h = await claimed(g, "5511970000006");
    await expect(charge(g, h)).rejects.toMatchObject({
      code: "module_disabled",
    });
    await expect(charge(g, h, { amount_cents: 0 })).rejects.toBeTruthy();
  });
});

describe("Cobrança: webhook do Mercado Pago", () => {
  it("webhook válido: consulta o pagamento e marca como pago uma vez só", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000010");
    const payment = await charge(f, c);
    const providerId = (await row(payment.id)).provider_ref;
    // Pendente no provedor: nada muda.
    let response = await webhook(account.id, providerId);
    expect(response.status).toBe(200);
    expect((await row(payment.id)).status).toBe("created");
    remote.get(providerId)!.status = "approved";
    response = await webhook(account.id, providerId);
    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      status: "paid",
      changed: true,
    });
    const paid = await row(payment.id);
    expect(paid).toMatchObject({
      status: "paid",
      provider_status: "approved",
      provider_payment_id: providerId,
    });
    expect(paid.paid_at).toBe(Date.parse("2026-11-15T12:00:00.000-03:00"));
    expect((await latest(c.id)).text).toMatch(
      /^Pagamento recebido: R\$\s12,50/,
    );
    // Webhook repetido (mesmo e novo request-id): sem efeito.
    await webhook(account.id, providerId);
    await webhook(account.id, providerId, { requestId: "outro" });
    expect(await events(f, "payment.paid")).toHaveLength(1);
    expect(
      (await outbox(c.id)).filter((m) =>
        String(m.text).startsWith("Pagamento recebido"),
      ),
    ).toHaveLength(1);
  });

  it("assinatura inválida ou ausente: 401, sem consultar nem mudar nada", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000011");
    const payment = await charge(f, c);
    const providerId = (await row(payment.id)).provider_ref;
    remote.get(providerId)!.status = "approved";
    const before = calls.length;
    expect(
      (await webhook(account.id, providerId, { secret: "errado" })).status,
    ).toBe(401);
    const unsigned = await SELF.fetch(
      `https://test/webhooks/payments/mercadopago/${account.id}?data.id=${providerId}&type=payment`,
      { method: "POST", body: "{}" },
    );
    expect(unsigned.status).toBe(401);
    expect(calls.length).toBe(before);
    expect((await row(payment.id)).status).toBe("created");
    // Conta desconhecida.
    expect((await webhook(uid(), providerId)).status).toBe(404);
  });

  it("mensagem do cliente nunca marca como paga; valor divergente é ignorado", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000012");
    const payment = await charge(f, c);
    await receive(f, f.line, "Já paguei! Segue o comprovante", "5511970000012");
    await drain(f);
    expect((await row(payment.id)).status).toBe("created");
    const providerId = (await row(payment.id)).provider_ref;
    Object.assign(remote.get(providerId)!, {
      status: "approved",
      amount: 1.25,
    });
    await webhook(account.id, providerId);
    expect((await row(payment.id)).status).toBe("created");
  });

  it("estorno depois de pago; outros tipos de notificação são ignorados", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000013");
    const payment = await charge(f, c);
    const providerId = (await row(payment.id)).provider_ref;
    remote.get(providerId)!.status = "approved";
    await webhook(account.id, providerId);
    remote.get(providerId)!.status = "refunded";
    await webhook(account.id, providerId);
    expect((await row(payment.id)).status).toBe("refunded");
    expect(await events(f, "payment.refunded")).toHaveLength(1);
    const other = await webhook(account.id, "123", { type: "merchant_order" });
    expect(await other.json<any>()).toMatchObject({ ignored: true });
    expect(mpState("charged_back")).toBe("refunded");
    expect(mpState("cancelled", "expired")).toBe("expired");
    expect(mpState("in_process")).toBe("pending");
  });
});

describe("Cobrança: expiração, cancelamento e módulos", () => {
  it("expira no alarme e cancela no provedor; aprovado depois ainda conta como pago", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000020");
    const payment = await charge(f, c);
    await exec(
      env,
      "UPDATE payments SET expires_at=? WHERE id=?",
      now() - 1000,
      payment.id,
    );
    await expirePayments(env, f.profile);
    expect((await row(payment.id)).status).toBe("expired");
    expect(await events(f, "payment.expired")).toHaveLength(1);
    const providerId = (await row(payment.id)).provider_ref;
    expect(
      calls.some(
        (x) => x.method === "PUT" && x.path === `/v1/payments/${providerId}`,
      ),
    ).toBe(true);
    remote.get(providerId)!.status = "approved";
    await webhook(account.id, providerId);
    expect((await row(payment.id)).status).toBe("paid");
  });

  it("atendente cancela uma cobrança aberta; paga não pode ser cancelada", async () => {
    const { f } = await setup();
    const c = await claimed(f, "5511970000021");
    const payment = await charge(f, c, { method: "link" });
    const token = await bearer(f.member);
    const cancel = await api(
      token,
      `/profiles/${f.profile}/payments/${payment.id}/cancel`,
      "POST",
      {},
    );
    expect(cancel.status).toBe(200);
    expect((await cancel.json<any>()).status).toBe("cancelled");
    expect(
      (
        await api(
          token,
          `/profiles/${f.profile}/payments/${payment.id}/cancel`,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    const detail = await (
      await api(token, `/profiles/${f.profile}/conversations/${c.id}`)
    ).json<any>();
    expect(detail.payments.map((p: any) => p.status)).toEqual(["cancelled"]);
    const list = await (
      await api(
        token,
        `/profiles/${f.profile}/payments?conversation_id=${c.id}`,
      )
    ).json<any>();
    expect(list.data[0].id).toBe(payment.id);
  });

  it("ctx.charge de um módulo e onPaymentUpdated chamado uma vez ao pagar", async () => {
    const { f, account } = await setup();
    const seen: any[] = [];
    onPaymentUpdated("forms", async (ctx, payment, { previous }) => {
      if (ctx.profile === f.profile)
        seen.push({ status: payment.status, previous, ref: payment.ref_id });
    });
    const c = await claimed(f, "5511970000022");
    const ctx = modulesApi(env, f.profile, "forms");
    const payment = await ctx.charge(c, {
      method: "pix",
      amount_cents: 9900,
      description: "Mensalidade de novembro",
      ref: "assinatura-7",
      sourceKey: "mensalidade:7:2026-11",
    });
    expect(payment).toMatchObject({
      module_id: "forms",
      ref_id: "assinatura-7",
      trigger: "module",
    });
    const again = await ctx.charge(c, {
      method: "pix",
      amount_cents: 9900,
      description: "Mensalidade de novembro",
      ref: "assinatura-7",
      sourceKey: "mensalidade:7:2026-11",
    });
    expect(again.id).toBe(payment.id);
    const providerId = (await row(payment.id)).provider_ref;
    remote.get(providerId)!.status = "approved";
    await webhook(account.id, providerId);
    await webhook(account.id, providerId);
    expect(seen).toEqual([
      { status: "paid", previous: "created", ref: "assinatura-7" },
    ]);
    // Fora da janela, o módulo pode pedir envio como notificação.
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86400000,
      c.id,
    );
    const late = await ctx.charge(await conversation(env, c.id, f.profile), {
      method: "link",
      amount_cents: 9900,
      description: "Mensalidade de dezembro",
      sourceKey: "mensalidade:7:2026-12",
      notification: true,
    });
    const sent = await one(
      env,
      "SELECT kind,payload FROM outbox WHERE dedupe=?",
      `payment:${late.id}`,
    );
    expect(sent.kind).toBe("notification");
    expect(json(sent.payload).text).toContain(late.url);
  });

  it("conferência B11: cobrança aberta que nunca chegou ao cliente é reenviada ao cobrar de novo", async () => {
    const { f } = await setup();
    const c = await claimed(f, "5511970000023");
    const ctx = modulesApi(env, f.profile, "forms");
    const input = {
      method: "pix" as const,
      amount_cents: 4900,
      description: "Pedido 12",
      sourceKey: "pedido:12:pix",
    };
    const payment = await ctx.charge(c, input);
    // O envio falhou depois de criar no provedor (simulado: nada na fila).
    await exec(
      env,
      "DELETE FROM outbox WHERE conversation_id=? AND dedupe LIKE 'payment%'",
      c.id,
    );
    const again = await ctx.charge(c, input);
    expect(again.id).toBe(payment.id);
    expect(
      await one(
        env,
        "SELECT id FROM outbox WHERE dedupe=?",
        `payment:${payment.id}`,
      ),
    ).toBeTruthy();
    // Já entregue: cobrar de novo não manda outra vez.
    await ctx.charge(c, input);
    expect(
      (
        await one(
          env,
          "SELECT count(*) AS n FROM outbox WHERE dedupe=?",
          `payment:${payment.id}`,
        )
      ).n,
    ).toBe(1);
  });
});

describe("Cobrança: lacunas dos módulos (cancelCharge, paymentsReady, receipt)", () => {
  it("paymentsReady diz se a área pode cobrar, sem ler tabelas do núcleo no módulo", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "forms");
    expect(await ctx.paymentsReady()).toMatchObject({
      ready: false,
      reason: "payments_not_configured",
    });
    await run(f, f.admin, "module.set", { id: "payments", enabled: false });
    expect((await ctx.paymentsReady()).reason).toBe("payments_disabled");
    const { f: g } = await setup();
    expect(await modulesApi(env, g.profile, "forms").paymentsReady()).toEqual({
      ready: true,
      reason: null,
      message: null,
      methods: ["pix", "link"],
    });
  });

  it("cancelCharge cancela a cobrança aberta do próprio módulo, uma vez", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000031");
    const ctx = modulesApi(env, f.profile, "forms");
    const payment = await ctx.charge(c, {
      method: "pix",
      amount_cents: 5000,
      description: "Sinal da reserva 12",
      sourceKey: "sinal:12",
    });
    const cancelled = await ctx.cancelCharge(payment);
    expect(cancelled.status).toBe("cancelled");
    // De novo: devolve como está, sem outro evento.
    expect((await ctx.cancelCharge(payment.id)).status).toBe("cancelled");
    expect(await events(f, "payment.cancelled")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    // Outro módulo não cancela a cobrança.
    await expect(
      modulesApi(env, f.profile, "payments").cancelCharge(payment.id),
    ).rejects.toMatchObject({ status: 404 });
    // Revisão B11: cobrar de novo com a mesma chave depois de cancelada abre
    // cobrança nova (antes devolvia a cancelada, sem reenviar).
    const again = await ctx.charge(c, {
      method: "pix",
      amount_cents: 5000,
      description: "Sinal da reserva 12",
      sourceKey: "sinal:12",
    });
    expect(again.id).not.toBe(payment.id);
    expect(again.status).toBe("created");
    // E a aberta é reaproveitada enquanto vale.
    const same = await ctx.charge(c, {
      method: "pix",
      amount_cents: 5000,
      description: "Sinal da reserva 12",
      sourceKey: "sinal:12",
    });
    expect(same.id).toBe(again.id);
    // Paga não se cancela.
    const paid = await ctx.charge(c, {
      method: "pix",
      amount_cents: 5000,
      description: "Sinal da reserva 13",
      sourceKey: "sinal:13",
    });
    const providerId = (await row(paid.id)).provider_ref;
    remote.get(providerId)!.status = "approved";
    await webhook(account.id, providerId);
    await expect(ctx.cancelCharge(paid)).rejects.toMatchObject({
      status: 409,
      code: "payment_closed",
    });
  });

  it("receipt: false não manda o 'Pagamento recebido' do núcleo", async () => {
    const { f, account } = await setup();
    const c = await claimed(f, "5511970000032");
    const ctx = modulesApi(env, f.profile, "forms");
    const own = await ctx.charge(c, {
      method: "pix",
      amount_cents: 4990,
      description: "Suporte avulso",
      sourceKey: "suporte:avulso:1",
      receipt: false,
    });
    const providerId = (await row(own.id)).provider_ref;
    remote.get(providerId)!.status = "approved";
    await webhook(account.id, providerId);
    expect((await row(own.id)).status).toBe("paid");
    const sent = (await outbox(c.id)).map((p: any) => p.text);
    expect(sent.some((t: string) => /Pagamento recebido/.test(t))).toBe(false);
    // A nota interna continua.
    const notes = await all(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note'",
      c.id,
    );
    expect(notes.map((n) => n.text)).toContainEqual(
      expect.stringMatching(
        /Pagamento confirmado pelo provedor: Suporte avulso/,
      ),
    );
  });
});
