import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runDue } from "../src/modules/mensalidade/due";
import {
  payManually,
  loadInstallment,
} from "../src/modules/mensalidade/installments";
import {
  createPlan,
  createSubscription,
} from "../src/modules/mensalidade/store";
import { addDays, today } from "../src/modules/mensalidade/model";
import {
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

// Mercado Pago simulado (só criação do Pix).
let nextId = 0;
beforeEach(() => {
  nextId = 500000 + Math.floor(Math.random() * 90000);
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const reply = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (
      url.origin === "https://api.mercadopago.com" &&
      init.method === "POST" &&
      url.pathname === "/v1/payments"
    ) {
      const id = String(nextId++);
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
    return reply({}, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

const menus = [
  {
    id: "mensalidades",
    label: "Minhas mensalidades",
    type: "mensalidade_list",
  },
  { id: "via", label: "Segunda via", type: "mensalidade_copy" },
  { id: "humano", label: "Falar com atendente", type: "human" },
];
const turn = (f: Fixture, enabled: boolean) =>
  perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "mensalidade", enabled },
    uid(),
  );

async function setup(payments = true) {
  const f = await fixture();
  await turn(f, true);
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://escola.example.com',?)",
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900001111" }),
    f.line,
    f.qr,
  );
  if (payments)
    await perform(
      env,
      f.admin,
      f.profile,
      "payment.account.save",
      {
        provider: "mercadopago",
        access_token: "APP_USR-token",
        webhook_secret: "segredo-do-webhook-de-teste",
        payer_email: "financeiro@escola.example.com",
      },
      uid(),
    );
  await configure(f, { menus });
  const ctx = modulesApi(env, f.profile, "mensalidade");
  const plan = await createPlan(
    ctx,
    { name: "Futsal", amount_cents: 12000 },
    f.admin.id,
  );
  return { f, ctx, plan };
}

/**
 * Assinatura só com o telefone (balcão), início 40 dias atrás: as parcelas
 * que já venceram foram pagas em dinheiro; a que vence em 5 dias está aberta.
 */
async function customer(
  f: Fixture,
  ctx: ReturnType<typeof modulesApi>,
  plan: any,
  phone: string,
) {
  const day = today(now());
  const sub = await createSubscription(
    ctx,
    {
      plan_id: plan.id,
      customer_name: "Pedro Lima",
      phone,
      start_date: addDays(day, -40),
      due_day: Number(addDays(day, 5).slice(8)),
    },
    f.admin.id,
  );
  await runDue(ctx, now(), { notices: false });
  const rows = await all(
    env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? ORDER BY due_date",
    sub.id,
  );
  for (const row of rows.filter((r) => r.status === "overdue"))
    await payManually(ctx, await loadInstallment(ctx, row.id), f.admin.id, {
      note: "Dinheiro",
    });
  return {
    sub,
    rows: await all(
      env,
      "SELECT * FROM mensalidade_installments WHERE subscription_id=? ORDER BY due_date",
      sub.id,
    ),
  };
}
async function say(
  f: Fixture,
  text: string,
  phone: string,
  line = f.line,
  content: any = {},
) {
  await receive(f, line, text, phone, content);
  await drain(f);
  return (
    await one(
      env,
      "SELECT id FROM conversations WHERE profile_id=? AND phone=?",
      f.profile,
      phone,
    )
  ).id as string;
}

describe("mensalidade no WhatsApp", () => {
  it("módulo desligado esconde Minhas mensalidades e Segunda via do menu", async () => {
    const { f } = await setup(false);
    await turn(f, false);
    const id = await say(f, "oi", "5511972000001");
    const menu = (await latest(id)).text as string;
    expect(menu).toContain("Falar com atendente");
    expect(menu).not.toContain("mensalidades");
    expect(menu).not.toContain("Segunda via");
    await turn(f, true);
    const again = await say(f, "menu", "5511972000001");
    expect((await latest(again)).text).toContain("Minhas mensalidades");
  });

  it("Minhas mensalidades mostra abertas e pagas e manda o Pix ao tocar na parcela", async () => {
    const { f, ctx, plan } = await setup();
    const phone = "5511972000002";
    const { rows } = await customer(f, ctx, plan, phone);
    const open = rows.filter((r) => ["open", "overdue"].includes(r.status));
    const paid = rows.filter((r) => r.status === "paid");
    expect(paid.length).toBeGreaterThanOrEqual(1);
    await say(f, "oi", phone);
    const id = await say(f, "1", phone);
    const list = await latest(id);
    expect(list.text).toContain("Suas mensalidades");
    expect(list.text).toContain("Em aberto:");
    expect(list.text).toContain("Pagas:");
    expect(list.text).toContain("Futsal");
    expect(list.content.interactive).toMatchObject({ type: "list" });
    const options = list.content.interactive.action.sections[0].rows;
    expect(options.map((r: any) => r.id)).toEqual(
      open.map((r) => "mensalidade:pix:" + r.id),
    );
    // A assinatura do balcão passou a ser desta conversa.
    expect(
      (
        await one(
          env,
          "SELECT conversation_id FROM mensalidade_subscriptions WHERE phone=?",
          phone,
        )
      ).conversation_id,
    ).toBe(id);
    // Toque na parcela: cobrança nova pela interface do núcleo.
    await say(f, options[0].title, phone, f.line, {
      interactive_reply_id: options[0].id,
    });
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE ref_id=?",
      open[0].id,
    );
    expect(payment).toMatchObject({
      module_id: "mensalidade",
      conversation_id: id,
    });
    expect((await outbox(id)).map((m) => m.text).join("\n")).toContain(
      payment.pix_code,
    );
    // "Já paguei" não dá baixa.
    await say(f, "já paguei", phone);
    expect((await loadInstallment(ctx, open[0].id)).status).toBe(
      open[0].status,
    );
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM events WHERE profile_id=? AND kind='mensalidade.paid' AND json_extract(payload,'$.by')='provider'",
        f.profile,
      ),
    ).toEqual({ n: 0 });

    // Segunda via: com uma parcela em aberto, reenvia o código que ainda vale.
    await say(f, "menu", phone);
    const second = await say(f, "2", phone);
    const copy = await latest(second);
    expect(copy.text).toMatch(/^Segunda via: /);
    expect(copy.text).toContain(payment.pix_code);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM payments WHERE ref_id=?",
        open[0].id,
      ),
    ).toEqual({ n: 1 });
  });

  it("linha QR: lista numerada; o número escolhe a parcela e MENU volta ao menu", async () => {
    const { f, ctx, plan } = await setup();
    const phone = "5511972000003";
    const { sub } = await customer(f, ctx, plan, phone);
    // Duas parcelas em aberto para a Segunda via perguntar qual.
    await exec(
      env,
      "UPDATE mensalidade_installments SET status='overdue',paid_at=NULL,paid_via=NULL,paid_by=NULL WHERE subscription_id=?",
      sub.id,
    );
    await say(f, "oi", phone, f.qr);
    const id = await say(f, "2", phone, f.qr);
    const choice = await latest(id);
    expect(choice.content).toBeUndefined();
    expect(choice.text).toContain(
      "mensalidades em aberto. Qual delas quer pagar?",
    );
    expect(choice.text).toMatch(/\n1\. [a-z]{3}\/\d{4} R\$/);
    expect(choice.text).toContain("Responda com o número da opção.");
    await say(f, "1", phone, f.qr);
    const first = await one(
      env,
      "SELECT * FROM mensalidade_installments WHERE subscription_id=? ORDER BY due_date LIMIT 1",
      sub.id,
    );
    expect(first.payment_id).toBeTruthy();
    expect((await outbox(id)).at(-1)!.text).toBe(first.pix_code);
    // Depois de usada, a escolha some: "1" volta a ser do menu.
    await say(f, "menu", phone, f.qr);
    await say(f, "1", phone, f.qr);
    expect((await latest(id)).text).toContain("Suas mensalidades");
    // MENU no meio da escolha devolve ao menu sem cobrar.
    const payments = (
      await all(env, "SELECT id FROM payments WHERE profile_id=?", f.profile)
    ).length;
    await say(f, "menu", phone, f.qr);
    expect((await latest(id)).text).toContain("Falar com atendente");
    expect(
      (await all(env, "SELECT id FROM payments WHERE profile_id=?", f.profile))
        .length,
    ).toBe(payments);
  });

  it("sem cobrança configurada mostra as instruções; outro telefone não vê nada", async () => {
    const { f, ctx, plan } = await setup(false);
    await configure(f, {
      menus,
      mensalidade: { manual_instructions: "Pague na recepção." },
    });
    const phone = "5511972000004";
    await customer(f, ctx, plan, phone);
    await say(f, "oi", phone);
    const id = await say(f, "2", phone);
    const text = (await latest(id)).text as string;
    expect(text).toContain("Mensalidade Futsal");
    expect(text).toContain("Pague na recepção.");
    expect(
      await one(env, "SELECT id FROM payments WHERE profile_id=?", f.profile),
    ).toBeNull();
    await say(f, "oi", "5511972000099");
    const other = await say(f, "1", "5511972000099");
    expect((await latest(other)).text).toBe(
      "Não encontramos mensalidades para este número.",
    );
    // Toque forjado numa parcela de outro cliente.
    await say(f, "x", "5511972000099", f.line, {
      interactive_reply_id: "mensalidade:pix:" + uid(),
    });
    expect((await latest(other)).text).toBe(
      "Não encontramos esta mensalidade para este número.",
    );
    expect((await conversation(env, other, f.profile)).id).toBe(other);
  });
});
