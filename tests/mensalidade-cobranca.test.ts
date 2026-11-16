import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { hmac } from "../src/security";
import { modulesApi } from "../src/modules/api";
import { mpManifest } from "../src/payments-mercadopago";
import { runDue } from "../src/modules/mensalidade/due";
import { warnSetup } from "../src/modules/mensalidade/billing";
import {
  createPlan,
  createSubscription,
} from "../src/modules/mensalidade/store";
import { addDays, DAY, today } from "../src/modules/mensalidade/model";
import {
  api,
  bearer,
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

const SECRET = "segredo-do-webhook-de-teste";
const TOKEN = "APP_USR-token-de-teste";

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

async function webhook(accountId: string, dataId: string, requestId = uid()) {
  const ts = String(Date.now());
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
      body: JSON.stringify({ type: "payment", data: { id: dataId } }),
    },
  );
}

const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));
const outboxRows = (conversationId: string) =>
  all(
    env,
    "SELECT kind,payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid",
    conversationId,
  ).then((rows) => rows.map((r) => ({ kind: r.kind, ...json(r.payload) })));
const installment = (subscription: string) =>
  one(
    env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? ORDER BY due_date LIMIT 1",
    subscription,
  );

/**
 * Área com Mensalidade, cliente que já escreveu na linha oficial e uma
 * assinatura cujo primeiro vencimento cai daqui a `daysAhead` dias.
 */
async function setup(
  options: { payments?: boolean; daysAhead?: number; rules?: any } = {},
) {
  const f = await fixture();
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "mensalidade", enabled: true },
    uid(),
  );
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://escola.example.com',?)",
    now(),
  );
  let account: any = null;
  if (options.payments !== false)
    account = await perform(
      env,
      f.admin,
      f.profile,
      "payment.account.save",
      {
        provider: "mercadopago",
        access_token: TOKEN,
        webhook_secret: SECRET,
        payer_email: "financeiro@escola.example.com",
      },
      uid(),
    );
  if (options.rules) await configure(f, { mensalidade: options.rules });
  const phone =
    "55119" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const c = await receive(f, f.line, "oi", phone);
  await drain(f);
  const ctx = modulesApi(env, f.profile, "mensalidade");
  const plan = await createPlan(
    ctx,
    { name: "Inglês Teens", amount_cents: 21000 },
    f.admin.id,
  );
  const day = today(now());
  const due = addDays(day, options.daysAhead ?? 3);
  const sub = await createSubscription(
    ctx,
    {
      plan_id: plan.id,
      customer_name: "Marina Alves",
      phone,
      discount_cents: 1000,
      start_date: day,
      due_day: Number(due.slice(8)),
    },
    f.admin.id,
  );
  return { f, ctx, c, sub, due, account, phone, plan };
}
// Ao meio-dia de Brasília do dia de hoje: "+1 h" depois das 23 h não pode
// virar o dia seguinte (a rodada do vencimento mandaria também o atraso).
const NOON = Date.parse(`${today(now())}T12:00:00-03:00`);
const at = (days: number, hours = 0) => NOON + days * DAY + hours * 3600_000;

describe("mensalidade: aviso antes do vencimento com cobrança", () => {
  it("cria a cobrança Pix pela interface do núcleo uma vez, mesmo com rodadas repetidas", async () => {
    const { f, ctx, c, sub, due } = await setup({ daysAhead: 4 });
    // 4 dias antes (regra padrão: 3): parcela gerada, sem aviso.
    expect((await runDue(ctx, at(0))).notices).toEqual({
      before: 0,
      due: 0,
      overdue: 0,
    });
    const inst = await installment(sub.id);
    expect(inst).toMatchObject({
      due_date: due,
      amount_cents: 20000,
      status: "open",
    });
    expect(
      await one(env, "SELECT id FROM payments WHERE ref_id=?", inst.id),
    ).toBeNull();
    // 3 dias antes: cobrança.
    expect((await runDue(ctx, at(1))).notices).toMatchObject({ before: 1 });
    expect((await runDue(ctx, at(1, 1))).notices).toMatchObject({ before: 0 });
    const payments = await all(
      env,
      "SELECT * FROM payments WHERE profile_id=? AND module_id='mensalidade'",
      f.profile,
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      ref_id: inst.id,
      method: "pix",
      amount_cents: 20000,
      conversation_id: c.id,
    });
    expect(payments[0].description).toMatch(
      /^Mensalidade Inglês Teens [a-z]{3}\/\d{4} · vence em \d{2}\/\d{2}\/\d{4}$/,
    );
    const charged = await installment(sub.id);
    expect(charged).toMatchObject({
      payment_id: payments[0].id,
      payment_status: "created",
      charge_seq: 1,
    });
    expect(charged.pix_code).toMatch(/^00020126PIX/);
    expect(charged.notice_before_at).toBeGreaterThan(0);
    const sent = await outboxRows(c.id);
    // O núcleo entrega: botão com o link e o código copia e cola.
    expect(sent.map((m) => m.text).join("\n")).toContain(charged.pix_code);
    expect(sent.filter((m) => m.automation === "payment")).toHaveLength(2);
    expect(await events(f, "mensalidade.charged")).toHaveLength(1);
    expect(await events(f, "mensalidade.notice_sent")).toEqual([
      expect.objectContaining({ kind: "before", charged: true }),
    ]);
  });

  it("no dia reenvia o código que ainda vale; o cliente dizendo que pagou não dá baixa", async () => {
    const { f, ctx, c, sub } = await setup({ daysAhead: 2 });
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const before = (await outboxRows(c.id)).length;
    await runDue(ctx, at(2));
    await runDue(ctx, at(2, 1));
    const messages = (await outboxRows(c.id)).slice(before);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("vence hoje");
    expect(messages[0].text).toContain("Pix copia e cola:\n" + inst.pix_code);
    expect(messages[0].automation).toBe("mensalidade");
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM payments WHERE ref_id=?",
        inst.id,
      ),
    ).toEqual({ n: 1 });
    // "Já paguei" e um comprovante em texto não mudam nada.
    await receive(f, f.line, "já paguei, segue o comprovante", c.phone!);
    await drain(f);
    expect((await installment(sub.id)).status).toBe("open");
    expect(await events(f, "mensalidade.paid")).toHaveLength(0);
  });
});

describe("mensalidade: confirmação pelo webhook", () => {
  it("marca a parcela como paga, envia o comprovante e ignora o webhook repetido", async () => {
    const { f, ctx, c, sub, account } = await setup();
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      inst.payment_id,
    );
    // Pendente no provedor: nada muda.
    expect((await webhook(account.id, payment.provider_ref)).status).toBe(200);
    expect((await installment(sub.id)).status).toBe("open");
    remote.get(payment.provider_ref)!.status = "approved";
    expect((await webhook(account.id, payment.provider_ref)).status).toBe(200);
    const paid = await installment(sub.id);
    expect(paid).toMatchObject({
      status: "paid",
      paid_via: "pix",
      paid_by: "provider",
      payment_status: "paid",
    });
    expect(paid.paid_at).toBe(Date.parse("2026-11-15T12:00:00.000-03:00"));
    const receipts = () =>
      outboxRows(c.id).then((rows) =>
        rows.filter((m) => m.text.startsWith("Comprovante de pagamento")),
      );
    const [receipt] = await receipts();
    expect(receipt.text).toContain("Cliente: Marina Alves");
    expect(receipt.text).toContain("Mensalidade: Inglês Teens — ");
    expect(receipt.text).toContain("Valor: R$ 200,00");
    expect(receipt.text).toContain("Pago em 15/11/2026 12:00 (Pix)");
    expect(receipt.kind).toBe("notification");
    // Só o comprovante do módulo: o núcleo não manda "Pagamento recebido".
    expect(
      (await outboxRows(c.id)).filter((m) =>
        m.text.startsWith("Pagamento recebido"),
      ),
    ).toHaveLength(0);
    // Repetido (o Mercado Pago reenvia): nada de novo.
    await webhook(account.id, payment.provider_ref);
    await webhook(account.id, payment.provider_ref, "outro-pedido");
    expect(await receipts()).toHaveLength(1);
    expect(await events(f, "mensalidade.paid")).toEqual([
      expect.objectContaining({
        installment_id: inst.id,
        via: "pix",
        by: "provider",
        payment_id: payment.id,
      }),
    ]);
    // Paga: sem avisos de atraso depois do vencimento.
    expect((await runDue(ctx, at(10))).notices).toEqual({
      before: 0,
      due: 0,
      overdue: 0,
    });
  });

  it("pagamento depois da baixa manual fica registrado como duplicado; estorno reabre", async () => {
    const { f, ctx, sub, account } = await setup();
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      inst.payment_id,
    );
    const admin = await bearer(f.admin);
    await api(
      admin,
      `/profiles/${f.profile}/mensalidade/installments/${inst.id}/pay`,
      "POST",
      {
        note: "Dinheiro",
      },
    );
    // A baixa manual cancela o Pix que ainda estava aberto.
    expect(
      await one(env, "SELECT status FROM payments WHERE id=?", payment.id),
    ).toEqual({
      status: "cancelled",
    });
    // Se o cliente pagar mesmo assim (corrida), entra como duplicado.
    remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    expect(await installment(sub.id)).toMatchObject({
      status: "paid",
      paid_via: "manual",
      paid_by: f.admin.id,
    });
    expect(
      (await events(f, "mensalidade.paid")).map((e) => e.duplicate),
    ).toEqual([undefined, true]);

    // Outra parcela paga pelo Pix e estornada volta a ficar em aberto.
    const second = await setup();
    await runDue(second.ctx, at(0));
    const open = await installment(second.sub.id);
    const pay2 = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      open.payment_id,
    );
    remote.get(pay2.provider_ref)!.status = "approved";
    await webhook(second.account.id, pay2.provider_ref);
    remote.get(pay2.provider_ref)!.status = "refunded";
    await webhook(second.account.id, pay2.provider_ref);
    expect(await installment(second.sub.id)).toMatchObject({
      status: "open",
      paid_at: null,
      payment_status: "refunded",
    });
    expect(await events(second.f, "mensalidade.refunded")).toHaveLength(1);
  });
});

describe("mensalidade: atraso e janela de 24 horas", () => {
  it("limita os avisos de atraso por parcela e respeita o intervalo", async () => {
    const { f, ctx, c, sub } = await setup({
      daysAhead: 1,
      rules: { overdue_max: 2, overdue_every_days: 2, due_today: false },
    });
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const overdueTexts = async () =>
      (await outboxRows(c.id)).filter((m) => /venceu em/.test(m.text));
    // Venceu ontem: primeiro aviso.
    expect((await runDue(ctx, at(2))).notices).toMatchObject({ overdue: 1 });
    expect((await installment(sub.id)).status).toBe("overdue");
    // Mesmo dia e dia seguinte: dentro do intervalo de 2 dias.
    expect((await runDue(ctx, at(2, 2))).notices).toMatchObject({ overdue: 0 });
    expect((await runDue(ctx, at(3))).notices).toMatchObject({ overdue: 0 });
    expect((await runDue(ctx, at(4, 1))).notices).toMatchObject({ overdue: 1 });
    // Limite de 2 atingido.
    expect((await runDue(ctx, at(7))).notices).toMatchObject({ overdue: 0 });
    expect((await runDue(ctx, at(12))).notices).toMatchObject({ overdue: 0 });
    const late = await overdueTexts();
    expect(late).toHaveLength(2);
    expect(late[0].text).toContain("está em aberto há 1 dia");
    expect(late[0].text).toContain(inst.pix_code);
    expect(await installment(sub.id)).toMatchObject({ overdue_notices: 2 });
    // A cobrança que ainda valia foi reaproveitada: uma só no provedor.
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM payments WHERE ref_id=?",
        inst.id,
      ),
    ).toEqual({ n: 1 });
  });

  it("cliente fora da janela: avisos e cobrança saem como notificação", async () => {
    const { ctx, c, sub } = await setup({ daysAhead: 3 });
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 3 * DAY,
      c.id,
    );
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const rows = await outboxRows(c.id);
    const charge = rows.filter((m) => m.automation === "payment");
    // Uma única notificação com o valor, o link e o código.
    expect(charge.map((m) => m.kind)).toEqual(["notification"]);
    expect(charge[0].text).toContain("Pix copia e cola:\n" + inst.pix_code);
    await runDue(ctx, at(3));
    const today_ = (await outboxRows(c.id)).at(-1)!;
    expect(today_).toMatchObject({
      kind: "notification",
      automation: "mensalidade",
    });
    expect(today_.text).toContain("vence hoje");
  });
});

describe("mensalidade: ordem dos avisos ao reenviar", () => {
  it("sem Cobrança e sem linha oficial: acusa primeiro a Cobrança; com ela, a linha", async () => {
    const { f, ctx, plan } = await setup({ payments: false });
    // Cliente que nunca escreveu e nenhuma linha oficial ativa na área.
    const sub = await createSubscription(
      ctx,
      {
        plan_id: plan.id,
        customer_name: "Bruno Lima",
        phone: "5511977001122",
        start_date: today(now()),
        due_day: Number(addDays(today(now()), 3).slice(8)),
      },
      f.admin.id,
    );
    await exec(
      env,
      "UPDATE connections SET status='disabled' WHERE profile_id=? AND kind='zernio'",
      f.profile,
    );
    // A rodada periódica não quebra: o aviso falha com o motivo.
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    expect(inst.notice_error).toMatch(/linha oficial/);
    const admin = await bearer(f.admin);
    const path = `/profiles/${f.profile}/mensalidade/installments/${inst.id}/charge`;
    const first = await api(admin, path, "POST", {});
    expect(first.status).toBe(409);
    expect((await first.json<any>()).error.code).toBe(
      "payments_not_configured",
    );
    // Com a Cobrança pronta, vale o aviso da linha.
    await perform(
      env,
      f.admin,
      f.profile,
      "payment.account.save",
      {
        provider: "mercadopago",
        access_token: TOKEN,
        webhook_secret: SECRET,
        payer_email: "financeiro@escola.example.com",
      },
      uid(),
    );
    const second = await api(admin, path, "POST", {});
    expect(second.status).toBe(400);
    expect((await second.json<any>()).error.message).toMatch(
      /Nenhuma linha oficial ativa/,
    );
  });
});

describe("mensalidade: sem cobrança configurada ou sem conversa", () => {
  it("avisa com as instruções, alerta o administrador uma vez por dia e aceita baixa manual", async () => {
    const { f, ctx, c, sub } = await setup({
      payments: false,
      rules: {
        manual_instructions:
          "Pague na secretaria ou pelo Pix CNPJ 12.345.678/0001-90.",
      },
    });
    await runDue(ctx, at(0));
    const notice = (await outboxRows(c.id)).at(-1)!;
    expect(notice.text).toContain("vence em");
    expect(notice.text).toContain("Pague na secretaria ou pelo Pix CNPJ");
    expect(
      await one(env, "SELECT id FROM payments WHERE profile_id=?", f.profile),
    ).toBeNull();
    expect(await events(f, "mensalidade.setup_needed")).toEqual([
      expect.objectContaining({ reason: "payments_not_configured" }),
    ]);
    // Outro aviso nas 24 horas seguintes não repete o alerta; dias depois, sim.
    expect(await warnSetup(ctx, "payments_not_configured", at(0, 5))).toBe(
      false,
    );
    await runDue(ctx, at(3));
    expect((await outboxRows(c.id)).at(-1)!.text).toContain("vence hoje");
    expect(await events(f, "mensalidade.setup_needed")).toHaveLength(2);
    const summary = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/mensalidade/summary`,
      )
    ).json<any>();
    expect(summary.payments_ready).toBe(false);
    // Reenviar cobrança explica o motivo; a baixa manual funciona.
    const admin = await bearer(f.admin);
    const inst = await installment(sub.id);
    const resend = await api(
      admin,
      `/profiles/${f.profile}/mensalidade/installments/${inst.id}/charge`,
      "POST",
      {},
    );
    expect(resend.status).toBe(409);
    expect((await resend.json<any>()).error.code).toBe(
      "payments_not_configured",
    );
    const paid = await (
      await api(
        admin,
        `/profiles/${f.profile}/mensalidade/installments/${inst.id}/pay`,
        "POST",
        { note: "Dinheiro" },
      )
    ).json<any>();
    expect(paid.status).toBe("paid");
    expect((await outboxRows(c.id)).at(-1)!.text).toContain("Pago em");
  });

  it("telefone que nunca escreveu: abre a conversa na linha oficial e cobra por notificação", async () => {
    const { f, ctx, sub } = await setup();
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET phone='5511900000000',conversation_id=NULL WHERE id=?",
      sub.id,
    );
    await runDue(ctx, at(0));
    const opened = await one(
      env,
      "SELECT conversation_id FROM mensalidade_subscriptions WHERE id=?",
      sub.id,
    );
    expect(opened.conversation_id).toBeTruthy();
    const convo = await conversation(env, opened.conversation_id, f.profile);
    expect(convo.phone).toBe("5511900000000");
    const inst = await installment(sub.id);
    expect(inst.payment_id).toBeTruthy();
    // Sem janela: a cobrança sai só como notificação de modelo.
    const rows = await outboxRows(convo.id);
    expect(
      rows.filter((m) => m.automation === "payment").map((m) => m.kind),
    ).toEqual(["notification"]);
    expect(await events(f, "mensalidade.notice_failed")).toEqual([]);
  });

  it("aceite de cobrança registrado por administrador no cadastro, com evidência (B9)", async () => {
    const { f, ctx, plan } = await setup();
    const token = await bearer(f.admin);
    const path = `/profiles/${f.profile}/mensalidade/subscriptions`;
    const body = {
      plan_id: plan.id,
      customer_name: "Nova Aluna",
      phone: "11900000001",
      billing_consent: true,
    };
    // Atendente comum não declara o aceite em nome do cliente.
    const member = await api(await bearer(f.member), path, "POST", body);
    expect(member.status).toBe(403);
    // Sem a evidência: recusado, e nada é criado.
    const bare = await api(token, path, "POST", body);
    expect(bare.status).toBe(400);
    expect((await bare.json<any>()).error.code).toBe(
      "consent_evidence_required",
    );
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=? AND phone='5511900000001'",
        f.profile,
      ),
    ).toEqual({ n: 0 });
    const sub = await (
      await api(token, path, "POST", {
        ...body,
        billing_consent_evidence: "Ficha de matrícula assinada em 10/11",
      })
    ).json<any>();
    expect(sub.customer.conversation_id).toBeTruthy();
    const convo = await conversation(
      env,
      sub.customer.conversation_id,
      f.profile,
    );
    const consent = await ctx.consent(convo, "billing");
    expect(consent).toMatchObject({ status: "granted" });
    expect(JSON.stringify(consent)).toContain(
      "Ficha de matrícula assinada em 10/11",
    );
    // Sem o aceite marcado, nada é registrado.
    const other = await (
      await api(
        token,
        `/profiles/${f.profile}/mensalidade/subscriptions`,
        "POST",
        {
          plan_id: plan.id,
          customer_name: "Sem aceite",
          phone: "11900000002",
        },
      )
    ).json<any>();
    expect(other.customer.conversation_id).toBeNull();
  });

  it("reenviar cobrança pela equipe manda o código que ainda vale", async () => {
    const { f, ctx, c, sub } = await setup();
    await runDue(ctx, at(0));
    const inst = await installment(sub.id);
    const member = await bearer(f.member);
    const key = "reenvio-" + uid();
    const path = `/profiles/${f.profile}/mensalidade/installments/${inst.id}/charge`;
    const first = await api(member, path, "POST", {}, key);
    expect(first.status).toBe(200);
    const replay = await api(member, path, "POST", {}, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const resent = (await outboxRows(c.id)).filter((m) =>
      m.text.startsWith("Segunda via:"),
    );
    expect(resent).toHaveLength(1);
    expect(resent[0].text).toContain(inst.pix_code);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM payments WHERE ref_id=?",
        inst.id,
      ),
    ).toEqual({ n: 1 });
    expect((await conversation(env, c.id, f.profile)).id).toBe(c.id);
  });
});
