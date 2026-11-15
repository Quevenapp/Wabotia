import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { startFlow } from "../src/modules/suporte/flow";
import { expirePayments } from "../src/payments";
import { situationByPhone } from "../src/modules/mensalidade/public";
import { api, bearer } from "./service-center-fixture";
import { approve, mp, useMercadoPago } from "./mensalidade-mp";
import {
  CPF_EM_DIA,
  CPF_NOVO,
  eventsOf,
  lastText,
  paymentFor,
  payerEmAtraso,
  payerSemAssinatura,
  releases,
  setupSuporte,
  talk,
  tap,
  texts,
  turnModule,
} from "./suporte-fixture";

useMercadoPago();

const rowsOf = (message: any) =>
  message.content.interactive.action.sections.flatMap((s: any) => s.rows);

describe("suporte: pagador em atraso", () => {
  it("oferece pagar a parcela em aberto e libera só quando o provedor confirma", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511971000001";
    await payerEmAtraso(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    const methods = (await texts(c.id)).at(-1)!;
    expect(methods.text).toContain("venceu em");
    expect(methods.text).toContain("Para liberar o atendimento, pague agora:");
    expect(rowsOf(methods).map((r: any) => r.id)).toEqual([
      "suporte:method:pix",
      "suporte:method:link",
    ]);
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=?",
      c.id,
    );
    const payment = await paymentFor(session.installment_id);
    expect(payment).toMatchObject({
      module_id: "mensalidade",
      method: "pix",
      conversation_id: c.id,
    });
    expect(await lastText(c.id)).toContain(
      "Assim que o pagamento for confirmado pelo banco",
    );
    // Mensagem do cliente não libera.
    c = await talk(f, "já paguei, segue o comprovante", phone);
    expect(await lastText(c.id)).toContain(
      "Ainda não recebemos a confirmação do pagamento.",
    );
    expect(await releases(c.id)).toHaveLength(0);
    // "1" reenvia o mesmo código.
    c = await talk(f, "1", phone);
    expect(await lastText(c.id)).toContain(payment.pix_code);
    expect(mp.created).toBe(1);
    // Webhook aprovado (repetido): mensalidade paga e conversa liberada uma vez.
    await approve(account.id, payment.id, 2);
    const rows = await releases(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "installment",
      actor: "provider",
      ref_id: session.installment_id,
    });
    expect(
      await one(
        env,
        "SELECT status FROM mensalidade_installments WHERE id=?",
        session.installment_id,
      ),
    ).toEqual({ status: "paid" });
    expect(
      (await one(env, "SELECT state FROM conversations WHERE id=?", c.id))
        .state,
    ).toBe("waiting");
  });
});

describe("suporte: sem assinatura, suporte avulso", () => {
  it("compra o pacote por Pix; webhook repetido libera uma vez com validade em horas", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511971000002";
    await payerSemAssinatura(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    const offer = (await texts(c.id)).at(-1)!;
    expect(offer.text).toContain(
      "O atendimento humano é para clientes com suporte contratado.",
    );
    expect(rowsOf(offer).map((r: any) => r.id)).toEqual([
      "suporte:pkg:avulso",
      "suporte:pkg:dia",
      `suporte:plan:${s.plan.id}`,
    ]);
    expect(rowsOf(offer)[1].description).toBe(
      "R$ 90,00 · 24 horas de atendimento",
    );
    // Pagador conhecido: não pede documento nem nome.
    c = await tap(f, phone, "suporte:pkg:dia", "Suporte 24 horas");
    expect(rowsOf((await texts(c.id)).at(-1)!).map((r: any) => r.id)).toContain(
      "suporte:method:pix",
    );
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const purchase = await one(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=?",
      c.id,
    );
    expect(purchase).toMatchObject({
      package_id: "dia",
      price_cents: 9000,
      status: "pending",
      method: "pix",
    });
    expect(purchase.payer_id).toBeTruthy();
    const payment = await paymentFor(purchase.id);
    expect(payment).toMatchObject({ module_id: "suporte", amount_cents: 9000 });
    await approve(account.id, payment.id, 3);
    const rows = await releases(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "package",
      actor: "provider",
      ref_id: purchase.id,
      until_ticket: 0,
    });
    expect(rows[0].valid_until).toBe(
      Date.parse("2026-11-15T12:00:00.000-03:00") + 24 * 3_600_000,
    );
    expect(await eventsOf(f, "suporte.purchase_paid")).toHaveLength(1);
    expect(await eventsOf(f, "suporte.released")).toHaveLength(1);
    const list = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/suporte/purchases?status=paid`,
      )
    ).json<any>();
    expect(list.data.map((p: any) => p.id)).toEqual([purchase.id]);
    expect(list.paid_cents).toBe(9000);
  });

  it("cobrança vencida não libera; o cliente pede outra e paga", async () => {
    const s = await setupSuporte({ methods: ["pix"] });
    const { f, account } = s;
    const phone = "5511971000003";
    await payerSemAssinatura(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    // Uma forma só: escolher o pacote já cobra.
    c = await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
    const first = await one(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=?",
      c.id,
    );
    await exec(
      env,
      "UPDATE payments SET expires_at=? WHERE id=?",
      now() - 1000,
      first.payment_id,
    );
    await expirePayments(env, f.profile);
    expect(
      await one(
        env,
        "SELECT status FROM suporte_purchases WHERE id=?",
        first.id,
      ),
    ).toEqual({ status: "expired" });
    expect(await eventsOf(f, "suporte.purchase_expired")).toHaveLength(1);
    expect(await releases(c.id)).toHaveLength(0);
    // "1": código novo (outra compra), depois pago.
    c = await talk(f, "1", phone);
    const purchases = await all(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=? ORDER BY created",
      c.id,
    );
    expect(purchases).toHaveLength(2);
    expect(purchases[1].status).toBe("pending");
    await approve(account.id, purchases[1].payment_id);
    expect((await releases(c.id)).map((r) => [r.kind, r.until_ticket])).toEqual(
      [["package", 1]],
    );
    // Pagar depois a cobrança vencida também vale (dinheiro confirmado vence):
    // a compra vira paga e fica registrada como outra liberação.
    await approve(account.id, first.payment_id);
    expect(
      await one(
        env,
        "SELECT status FROM suporte_purchases WHERE id=?",
        first.id,
      ),
    ).toEqual({ status: "paid" });
    expect(await releases(c.id)).toHaveLength(2);
    expect((await releases(c.id)).every((r) => r.kind === "package")).toBe(
      true,
    );
  });
});

describe("suporte: sem cadastro, plano mensal", () => {
  it("pede CPF e nome, contrata o plano e libera quando a primeira parcela é paga", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511971000004";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_NOVO, phone);
    const offer = (await texts(c.id)).at(-1)!;
    expect(rowsOf(offer).map((r: any) => r.id)).toContain(
      `suporte:plan:${s.plan.id}`,
    );
    expect(rowsOf(offer).at(-1).description).toBe(
      "R$ 99,00 por mês · Atendimento humano em horário comercial",
    );
    c = await tap(f, phone, `suporte:plan:${s.plan.id}`, "Suporte Mensal");
    expect(await lastText(c.id)).toBe(
      "Qual o nome completo ou a razão social de quem paga?",
    );
    c = await talk(f, "12", phone);
    expect(await lastText(c.id)).toContain("Envie o nome completo");
    c = await talk(f, "Maria Souza", phone);
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=?",
      c.id,
    );
    expect(session).toMatchObject({
      offer_kind: "plan",
      step: "awaiting_payment",
    });
    expect((await situationByPhone(env, f.profile, phone))?.status).toBe(
      "em_atraso",
    );
    expect(await eventsOf(f, "suporte.plan_contracted")).toHaveLength(1);
    const payment = await paymentFor(session.installment_id);
    await approve(account.id, payment.id, 2);
    expect((await releases(c.id)).map((r) => r.kind)).toEqual(["subscription"]);
    const situation = await situationByPhone(env, f.profile, phone);
    expect(situation).toMatchObject({ status: "em_dia", phone_linked: true });
    expect(situation?.payer).toMatchObject({
      name: "Maria Souza",
      document: "11144477735",
    });
  });

  it("Mensalidade desligada: o plano mensal some e o avulso continua, com CPF e nome na compra", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await turnModule(f, "mensalidade", false);
    const phone = "5511971000005";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    const offer = (await texts(c.id)).at(-1)!;
    expect(rowsOf(offer).map((r: any) => r.id)).toEqual([
      "suporte:pkg:avulso",
      "suporte:pkg:dia",
    ]);
    c = await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
    expect(await lastText(c.id)).toContain(
      "Para a compra, digite o CPF ou o CNPJ",
    );
    c = await talk(f, CPF_EM_DIA, phone);
    expect(await lastText(c.id)).toBe(
      "Qual o nome completo ou a razão social de quem paga?",
    );
    c = await talk(f, "Pedro Lima", phone);
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    expect(
      await one(
        env,
        "SELECT document,name,payer_id,status FROM suporte_purchases WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual({
      document: "52998224725",
      name: "Pedro Lima",
      payer_id: null,
      status: "pending",
    });
    const offers = await (
      await api(await bearer(f.member), `/profiles/${f.profile}/suporte/offers`)
    ).json<any>();
    expect(offers).toMatchObject({
      mensalidade: false,
      payments_ready: true,
      plans: [],
    });
    expect(offers.packages).toHaveLength(2);
  });

  it("sem a Cobrança configurada não oferece compra e explica", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await turnModule(f, "payments", false);
    const phone = "5511971000006";
    await payerSemAssinatura(s, phone);
    const c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    expect(await lastText(c.id)).toContain(
      "no momento não é possível contratar pelo WhatsApp",
    );
  });
});
