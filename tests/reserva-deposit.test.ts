import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { uid } from "../src/types";
import { hmac } from "../src/security";
import { expirePayments } from "../src/payments";
import { mpManifest } from "../src/payments-mercadopago";
import { runDue } from "../src/modules/reserva/schedule";
import {
  api,
  bearer,
  latest,
  outbox,
  receive,
  drain,
} from "./service-center-fixture";
import {
  bookings,
  chatSetup,
  future,
  qrToSummary,
  say,
  type ReservaSetup,
} from "./reserva-fixture";

const SECRET = "segredo-do-webhook-da-pousada";
const TOKEN = "APP_USR-token-da-pousada";

// Mercado Pago simulado: nenhuma chamada sai para a rede.
let remote: Map<string, { status: string; amount: number; ref: string }>;
let nextId: number;
beforeEach(() => {
  remote = new Map();
  nextId = 700000 + Math.floor(Math.random() * 90000);
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const reply = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.origin !== "https://api.mercadopago.com") return reply({}, 404);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (new Headers(init.headers).get("Authorization") !== `Bearer ${TOKEN}`)
      return reply({ message: "invalid access token" }, 401);
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
    const match = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
    if (match && method === "GET") {
      const r = remote.get(match[1]);
      if (!r) return reply({ message: "not found" }, 404);
      return reply({
        id: Number(match[1]),
        status: r.status,
        status_detail: "",
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

const RULES = {
  deposit_type: "percent",
  deposit_percent: 30,
  deposit_deadline_minutes: 120,
};

async function setup(withAccount = true) {
  const s = await chatSetup(RULES);
  const account = withAccount
    ? await s.run("payment.account.save", {
        provider: "mercadopago",
        access_token: TOKEN,
        webhook_secret: SECRET,
        payer_email: "pagamentos@pousada.example.com",
      })
    : null;
  return { ...s, account };
}

async function webhook(accountId: string, dataId: string) {
  const ts = String(Date.now());
  const requestId = uid();
  const v1 = await hmac(SECRET, mpManifest(dataId, requestId, ts));
  return SELF.fetch(
    `https://test/webhooks/payments/mercadopago/${accountId}?data.id=${dataId}&type=payment`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        action: "payment.updated",
        type: "payment",
        data: { id: dataId },
      }),
    },
  );
}
/** Id do pagamento no Mercado Pago da cobrança do sinal da reserva. */
async function providerRef(bookingId: string) {
  const row = await one(
    env,
    "SELECT p.provider_ref FROM reserva_bookings b JOIN payments p ON p.id=b.payment_id WHERE b.id=?",
    bookingId,
  );
  return row!.provider_ref as string;
}
const events = (s: ReservaSetup, kind: string) =>
  all(
    env,
    "SELECT * FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    s.f.profile,
    kind,
  );

/** Reserva pelo WhatsApp (QR) até "aguardando pagamento". */
async function pendingByChat(s: ReservaSetup, phone: string, start: string) {
  let c = await qrToSummary(s, phone, start);
  expect((await latest(c.id)).text).toContain(
    "Sinal para garantir: R$ 180,00, pago em até 2 horas depois de confirmar.",
  );
  c = await say(s, "1", phone, s.f.qr);
  const [booking] = (await bookings(s)).filter(
    (b) => b.conversation_id === c.id,
  );
  return { c, booking };
}

describe("reserva: sinal pela Cobrança", () => {
  it("aguarda o sinal, ignora 'já paguei' e confirma só pelo webhook, uma vez", async () => {
    const s = await setup();
    const phone = "5511972000001";
    const before = Date.now();
    const { c, booking } = await pendingByChat(s, phone, future(6));
    expect(booking).toMatchObject({
      status: "pending_payment",
      deposit_cents: 18000,
      price_cents: 60000,
      payment_status: "created",
      payment_error: null,
    });
    expect(booking.payment_due_at).toBeGreaterThanOrEqual(before + 120 * 60000);
    const texts = (await outbox(c.id)).map((m) => m.text);
    const pending = texts.findIndex((t) => t.includes("Reserva #1 feita!"));
    expect(texts[pending]).toContain("pague o sinal de R$ 180,00 até");
    // A cobrança sai depois do texto da reserva.
    expect(texts.slice(pending + 1).join("\n")).toContain("00020126PIX");
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      booking.payment_id,
    );
    expect(payment).toMatchObject({
      module_id: "reserva",
      ref_id: booking.id,
      amount_cents: 18000,
      method: "pix",
    });

    // Mensagem do cliente não confirma.
    await say(s, "já paguei, segue o comprovante", phone, s.f.qr);
    expect((await bookings(s))[0].status).toBe("pending_payment");

    const ref = await providerRef(booking.id);
    remote.get(ref)!.status = "approved";
    expect((await webhook(s.account.id, ref)).status).toBe(200);
    const [paid] = await bookings(s);
    expect(paid).toMatchObject({
      status: "confirmed",
      payment_status: "paid",
      confirmed_by: "payment",
    });
    expect(paid.paid_at).toBeTruthy();
    // Webhook repetido: nada muda, nada se repete.
    expect((await webhook(s.account.id, ref)).status).toBe(200);
    expect((await webhook(s.account.id, ref)).status).toBe(200);
    expect(await events(s, "reserva.confirmed")).toHaveLength(1);
    const confirmations = (await outbox(c.id)).filter((m) =>
      m.text.includes("Reserva #1 confirmada!"),
    );
    expect(confirmations).toHaveLength(1);
    // Rodada periódica depois do prazo não mexe na reserva paga.
    await runDue(s.ctx, booking.payment_due_at + 60000);
    expect((await bookings(s))[0].status).toBe("confirmed");
  });

  it("cancelar a reserva aguardando o sinal cancela a cobrança (ctx.cancelCharge)", async () => {
    const s = await setup();
    const { booking } = await pendingByChat(s, "5511972000009", future(8));
    await s.run("reserva.cancel", { id: booking.id, reason: "Desistiu" });
    const payment = await one(
      env,
      "SELECT status FROM payments WHERE id=?",
      booking.payment_id,
    );
    expect(payment.status).toBe("cancelled");
    expect((await bookings(s))[0]).toMatchObject({ status: "cancelled" });
    // Só o reserva.cancelled: a cobrança cancelada não vira "expirada".
    expect(await events(s, "reserva.expired")).toHaveLength(0);
  });

  it("sinal vencido libera a unidade; pagamento atrasado vira aviso à equipe", async () => {
    const s = await setup();
    const start = future(7);
    const { c, booking } = await pendingByChat(s, "5511972000002", start);
    // Enquanto aguarda, a unidade está segura.
    const busy = await api(
      await bearer(s.f.admin),
      `/profiles/${s.f.profile}/reserva/bookings`,
      "POST",
      {
        unit_id: s.mar.id,
        start_date: start,
        nights: 1,
        customer_name: "Outro",
      },
    );
    expect((await busy.json<any>()).error.code).toBe("unit_unavailable");
    // Antes do prazo, nada; depois, libera.
    expect(
      (await runDue(s.ctx, booking.payment_due_at - 60000)).expired,
    ).toEqual([]);
    expect((await runDue(s.ctx, booking.payment_due_at)).expired).toEqual([
      booking.id,
    ]);
    expect(
      (await runDue(s.ctx, booking.payment_due_at + 60000)).expired,
    ).toEqual([]);
    const [expired] = await bookings(s);
    expect(expired).toMatchObject({
      status: "expired",
      cancelled_by: "system",
    });
    expect((await latest(c.id)).text).toContain(
      "O prazo para pagar o sinal da reserva #1 (Suíte Mar) acabou",
    );
    expect(await events(s, "reserva.expired")).toHaveLength(1);
    // Outro cliente fica com a unidade.
    const taken = await api(
      await bearer(s.f.admin),
      `/profiles/${s.f.profile}/reserva/bookings`,
      "POST",
      {
        unit_id: s.mar.id,
        start_date: start,
        nights: 2,
        customer_name: "Outro",
      },
    );
    expect(taken.status).toBe(200);
    // O Pix cai depois: não volta a reserva, avisa a equipe e o cliente.
    const ref = await providerRef(booking.id);
    remote.get(ref)!.status = "approved";
    expect((await webhook(s.account.id, ref)).status).toBe(200);
    const late = (await bookings(s))[0];
    expect(late).toMatchObject({ status: "expired", payment_status: "paid" });
    const [warning] = await events(s, "reserva.payment_late");
    expect(JSON.parse(warning.payload)).toMatchObject({
      reason: "unit_taken",
      needs_refund: true,
    });
    expect((await latest(c.id)).text).toContain("já tinha sido liberada");
  });

  it("pagamento atrasado com a unidade ainda livre reativa a reserva", async () => {
    const s = await setup();
    const { booking } = await pendingByChat(s, "5511972000003", future(3));
    await runDue(s.ctx, booking.payment_due_at + 1);
    const ref = await providerRef(booking.id);
    remote.get(ref)!.status = "approved";
    await webhook(s.account.id, ref);
    expect((await bookings(s))[0]).toMatchObject({
      status: "confirmed",
      payment_status: "paid",
    });
    const [confirmed] = await events(s, "reserva.confirmed");
    expect(JSON.parse(confirmed.payload)).toMatchObject({
      late: true,
      by: "payment",
    });
  });

  it("cobrança vencida no núcleo também libera a reserva", async () => {
    const s = await setup();
    const { booking } = await pendingByChat(s, "5511972000004", future(4));
    await exec(
      env,
      "UPDATE payments SET expires_at=? WHERE id=?",
      Date.now() - 1000,
      booking.payment_id,
    );
    await expirePayments(env, s.f.profile);
    expect((await bookings(s))[0]).toMatchObject({
      status: "expired",
      payment_status: "expired",
    });
  });

  it("sem conta de cobrança: o administrador vê o aviso e a reserva aguarda a equipe", async () => {
    const s = await setup(false);
    const admin = await bearer(s.f.admin);
    const overview = await (
      await api(admin, `/profiles/${s.f.profile}/reserva`)
    ).json<any>();
    expect(overview.deposit).toMatchObject({
      available: false,
      reason: "payments_not_configured",
    });
    expect(overview.deposit.message).toContain("Gestão → Cobrança");
    const { c, booking } = await pendingByChat(s, "5511972000005", future(5));
    expect(booking).toMatchObject({
      status: "pending_payment",
      payment_id: null,
      payment_error: "payments_not_configured",
    });
    expect((await latest(c.id)).text).toContain(
      "Não consegui gerar o pagamento do sinal (R$ 180,00) agora.",
    );
    // A equipe confirma à mão (sinal recebido por fora).
    const confirmed = await (
      await api(
        admin,
        `/profiles/${s.f.profile}/reserva/bookings/${booking.id}/confirm`,
        "POST",
        {},
      )
    ).json<any>();
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confirmed_by: s.f.admin.id,
    });
    // Cobrança desligada também aparece.
    await s.run("module.set", { id: "payments", enabled: false });
    const off = await (
      await api(admin, `/profiles/${s.f.profile}/reserva`)
    ).json<any>();
    expect(off.deposit.reason).toBe("payments_disabled");
  });

  it("a equipe pede o sinal ao reservar para uma conversa", async () => {
    const s = await setup();
    const phone = "5511972000006";
    const conv = await receive(s.f, s.f.qr, "oi", phone);
    await drain(s.f);
    const admin = await bearer(s.f.admin);
    const res = await api(
      admin,
      `/profiles/${s.f.profile}/reserva/bookings`,
      "POST",
      {
        unit_id: s.jardim.id,
        start_date: future(12),
        nights: 2,
        conversation_id: conv.id,
        deposit: true,
      },
    );
    const booking = await res.json<any>();
    expect(booking).toMatchObject({
      status: "pending_payment",
      deposit_cents: 27000,
      payment_status: "created",
      source: "panel",
    });
    const texts = (await outbox(conv.id)).map((m) => m.text).join("\n");
    expect(texts).toContain("Reserva #1 feita!");
    expect(texts).toContain("00020126PIX");
    // Sem deposit, a equipe reserva já confirmada.
    const direct = await (
      await api(admin, `/profiles/${s.f.profile}/reserva/bookings`, "POST", {
        unit_id: s.mar.id,
        start_date: future(12),
        nights: 2,
        conversation_id: conv.id,
      })
    ).json<any>();
    expect(direct).toMatchObject({ status: "confirmed", deposit_cents: 0 });
  });
});
