import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { perform } from "../src/service";
import { startFlow } from "../src/modules/suporte/flow";
import { expirePayments } from "../src/payments";
import { situationByPhone } from "../src/modules/mensalidade/public";
import { modulesApi } from "../src/modules/api";
import { createPayer } from "../src/modules/mensalidade/payers";
import { api, bearer, claim } from "./service-center-fixture";
import { approve, mp, remoteStatus, useMercadoPago } from "./mensalidade-mp";
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
    // Comprar pela conversa registra o aceite de cobrança (finalidade billing).
    expect(
      await one(
        env,
        "SELECT purpose,status,module_id FROM consents WHERE conversation_id=? AND purpose='billing'",
        c.id,
      ),
    ).toMatchObject({ purpose: "billing", status: "granted" });
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
    // "1": código novo na mesma compra (uma por sessão e pacote), depois pago.
    c = await talk(f, "1", phone);
    const purchases = await all(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=? ORDER BY created",
      c.id,
    );
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ status: "pending", charge_seq: 2 });
    expect(purchases[0].payment_id).not.toBe(first.payment_id);
    await approve(account.id, purchases[0].payment_id);
    expect((await releases(c.id)).map((r) => [r.kind, r.until_ticket])).toEqual(
      [["package", 1]],
    );
    // Pagar depois a cobrança vencida: dinheiro em dobro. Não libera de novo;
    // fica a pendência para a equipe estornar.
    await approve(account.id, first.payment_id);
    expect(
      await one(
        env,
        "SELECT status,attention FROM suporte_purchases WHERE id=?",
        first.id,
      ),
    ).toEqual({ status: "paid", attention: "duplicate_payment" });
    expect(await releases(c.id)).toHaveLength(1);
    expect(await eventsOf(f, "suporte.purchase_attention")).toEqual([
      expect.objectContaining({
        reason: "duplicate_payment",
        payment_id: first.payment_id,
      }),
    ]);
  });

  it("M8: trocar a forma cancela a cobrança aberta; estorno vira pendência", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511971000013";
    await payerSemAssinatura(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
    c = await tap(f, phone, "suporte:method:link", "Cartão ou link");
    const pix = await one(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=?",
      c.id,
    );
    // "2": trocar a forma; escolhe Pix.
    await talk(f, "2", phone);
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const after = await all(
      env,
      "SELECT * FROM suporte_purchases WHERE conversation_id=?",
      c.id,
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ method: "pix", status: "pending" });
    expect(after[0].payment_id).not.toBe(pix.payment_id);
    expect(
      await one(env, "SELECT status FROM payments WHERE id=?", pix.payment_id),
    ).toEqual({ status: "cancelled" });
    // Paga pelo Pix; depois o pagamento é estornado.
    await approve(account.id, after[0].payment_id);
    expect((await releases(c.id))[0].status).toBe("active");
    await remoteStatus(account.id, after[0].payment_id, "refunded");
    expect(
      await one(
        env,
        "SELECT status,attention FROM suporte_purchases WHERE id=?",
        pix.id,
      ),
    ).toEqual({ status: "refunded", attention: "refunded" });
    expect((await releases(c.id))[0].status).toBe("ended");
    // Outra sessão com outro pacote cancela a compra aberta da anterior.
    await startFlow(s.sctx, c, uid());
    await tap(f, phone, "suporte:pkg:dia", "Suporte 24 horas");
    await tap(f, phone, "suporte:method:pix", "Pix");
    await startFlow(s.sctx, c, uid());
    await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
    await tap(f, phone, "suporte:method:pix", "Pix");
    const open = await all(
      env,
      "SELECT package_id,status FROM suporte_purchases WHERE conversation_id=? AND status='pending'",
      c.id,
    );
    expect(open).toEqual([{ package_id: "avulso", status: "pending" }]);
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
    // Até o pagamento nada nasce no cadastro: nem pagador, nem assinatura.
    expect(session.contract_id).toBeTruthy();
    expect(await situationByPhone(env, f.profile, phone)).toBeNull();
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=?",
        f.profile,
      ),
    ).toEqual({ n: 0 });
    expect(await eventsOf(f, "suporte.plan_contracted")).toHaveLength(1);
    const payment = await paymentFor(session.contract_id);
    expect(payment).toMatchObject({
      module_id: "mensalidade",
      amount_cents: 9900,
    });
    await approve(account.id, payment.id, 2);
    expect((await releases(c.id)).map((r) => r.kind)).toEqual(["subscription"]);
    expect((await releases(c.id))[0].phone_linked).toBe(1);
    const situation = await situationByPhone(env, f.profile, phone);
    expect(situation).toMatchObject({ status: "em_dia", phone_linked: true });
    expect(situation?.payer).toMatchObject({
      name: "Maria Souza",
      document: "11144477735",
    });
  });

  // Contrata o plano com CPF_NOVO e devolve sessão, contrato e cobrança.
  async function contractWithNewCpf(s: any, phone: string) {
    const { f } = s;
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    await talk(f, CPF_NOVO, phone);
    await tap(f, phone, `suporte:plan:${s.plan.id}`, "Suporte Mensal");
    await talk(f, "Maria Souza", phone);
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=?",
      c.id,
    );
    return { c, session, payment: await paymentFor(session.contract_id) };
  }

  it("conferência N-6 (a): documento cadastrado antes do pagamento avisa a equipe", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const { c, session, payment } = await contractWithNewCpf(
      s,
      "5511971000011",
    );
    // Entre o Pix e o pagamento, o CPF passa a ser de um pagador cadastrado.
    const owner = await createPayer(
      modulesApi(env, f.profile, "mensalidade"),
      { document: CPF_NOVO, name: "Dono do CPF", phones: ["5511971000012"] },
      f.admin.id,
    );
    await approve(account.id, payment.id, 2);
    const contract = await one(
      env,
      "SELECT payer_id,payer_linked FROM mensalidade_contracts WHERE id=?",
      session.contract_id,
    );
    expect(contract).toEqual({ payer_id: owner.id, payer_linked: 0 });
    const alerts = await eventsOf(f, "mensalidade.contract_unlinked");
    expect(alerts).toHaveLength(1);
    expect(
      await all(
        env,
        "SELECT id FROM messages WHERE conversation_id=? AND external_id=?",
        c.id,
        `note:mensalidade:desvinculado:${session.contract_id}`,
      ),
    ).toHaveLength(1);
  });

  it("conferência N-6 (b): pagador da contratação é provisório e a confirmação mostra os telefones", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const buyer = "5511971000013";
    const { payment } = await contractWithNewCpf(s, buyer);
    await approve(account.id, payment.id);
    const bought = await situationByPhone(env, f.profile, buyer);
    expect(bought?.payer).toMatchObject({ provisional: true });
    expect(bought?.payer.created_by).toMatch(/^contrato:/);
    expect(bought?.payer.phones[0].created_by).toMatch(/^contrato:/);
    // O dono verdadeiro do CPF fala de outro telefone: aguarda confirmação,
    // e a equipe vê que o cadastro é provisório e de quem é o telefone.
    const real = "5511971000014";
    let c = await talk(f, "oi", real);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_NOVO, real);
    await claim(f, f.member, c.id);
    const status = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/suporte/conversations/${c.id}`,
      )
    ).json<any>();
    expect(status.awaiting_team).toBe(true);
    expect(status.unlinked_phone).toMatchObject({
      provisional: true,
      phones: [{ phone: buyer }],
    });
    expect(status.unlinked_phone.phones[0].created_by).toMatch(/^contrato:/);
  });

  it("sem planos oferecidos: só o avulso, com CPF e nome na compra", async () => {
    const s = await setupSuporte({ offer_plans: false });
    const { f } = s;
    const phone = "5511971000005";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_NOVO, phone);
    const offer = (await texts(c.id)).at(-1)!;
    expect(rowsOf(offer).map((r: any) => r.id)).toEqual([
      "suporte:pkg:avulso",
      "suporte:pkg:dia",
    ]);
    c = await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
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
      document: "11144477735",
      name: "Pedro Lima",
      payer_id: null,
      status: "pending",
    });
    const offers = await (
      await api(await bearer(f.member), `/profiles/${f.profile}/suporte/offers`)
    ).json<any>();
    expect(offers).toMatchObject({
      mensalidade: true,
      payments_ready: true,
      plans: [],
    });
    expect(offers.packages).toHaveLength(2);
  });

  it("Mensalidade é requisito: desligar pede cascata e o Suporte sai junto", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await expect(turnModule(f, "mensalidade", false)).rejects.toMatchObject({
      code: "module_required",
    });
    const result = await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "mensalidade", enabled: false, cascade: true },
      uid(),
    );
    expect(JSON.stringify(result)).toContain("suporte");
    const token = await bearer(f.member);
    const off = await api(token, `/profiles/${f.profile}/suporte/offers`);
    expect(off.status).toBe(409);
    expect((await off.json<any>()).error.code).toBe("module_disabled");
    await expect(turnModule(f, "suporte", true)).rejects.toMatchObject({
      code: "module_requires",
    });
    await turnModule(f, "mensalidade", true);
    await turnModule(f, "suporte", true);
    expect(
      (await api(token, `/profiles/${f.profile}/suporte/offers`)).status,
    ).toBe(200);
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
