import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runDue } from "../src/modules/mensalidade/due";
import { createPlan } from "../src/modules/mensalidade/store";
import {
  addDays,
  parseDocument,
  today,
} from "../src/modules/mensalidade/model";
import {
  chargeContractAgain,
  chargeInstallment,
  contractPlan,
  onInstallmentPaid,
  sellablePlans,
  situationByDocument,
  situationByPhone,
  type InstallmentPaid,
} from "../src/modules/mensalidade/public";
import {
  api,
  bearer,
  brasilia,
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";
import {
  approve,
  configurePayments,
  mp,
  useMercadoPago,
} from "./mensalidade-mp";

useMercadoPago();

const CPF = "529.982.247-25";
const CNPJ = "11.222.333/0001-81";
const CNPJ_ALFA = "12.ABC.345/01DE-35";
const root = (f: Fixture) => `/profiles/${f.profile}/mensalidade`;
const paidHeard: InstallmentPaid[] = [];
onInstallmentPaid("teste", async (_env, _profile, installment) => {
  paidHeard.push(installment);
});

async function setup() {
  const f = await fixture();
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "mensalidade", enabled: true },
    uid(),
  );
  const ctx = modulesApi(env, f.profile, "mensalidade");
  const plan = await createPlan(
    ctx,
    {
      name: "Suporte Mensal",
      amount_cents: 9900,
      due_day: 10,
      sellable: true,
      description: "Atendimento humano ilimitado",
    },
    f.admin.id,
  );
  return {
    f,
    ctx,
    plan,
    admin: await bearer(f.admin),
    member: await bearer(f.member),
  };
}

describe("mensalidade: documento do pagador", () => {
  it("confere CPF, CNPJ numérico e CNPJ alfanumérico", () => {
    expect(parseDocument(CPF)).toEqual({
      document: "52998224725",
      type: "cpf",
      display: "529.982.247-25",
    });
    expect(parseDocument("11222333000181")?.type).toBe("cnpj");
    expect(parseDocument(CNPJ_ALFA)).toEqual({
      document: "12ABC34501DE35",
      type: "cnpj",
      display: "12.ABC.345/01DE-35",
    });
    expect(parseDocument("12abc34501de35")?.document).toBe("12ABC34501DE35");
    for (const bad of [
      "529.982.247-24",
      "111.111.111-11",
      "11.222.333/0001-82",
      "12ABC34501DE36",
      "123",
      "",
    ])
      expect(parseDocument(bad), bad).toBeNull();
  });
});

describe("mensalidade: pagadores", () => {
  it("cadastra com vários telefones, recusa documento repetido e vincula telefone", async () => {
    const { f, admin, member } = await setup();
    const res = await api(member, root(f) + "/payers", "POST", {
      document: CNPJ,
      name: "Contabilidade Silva Ltda",
      phones: ["11 98100-0001", { phone: "11981000002", label: "Financeiro" }],
    });
    expect(res.status).toBe(200);
    const payer = await res.json<any>();
    expect(payer).toMatchObject({
      document: "11222333000181",
      document_type: "cnpj",
      document_display: "11.222.333/0001-81",
      name: "Contabilidade Silva Ltda",
    });
    expect(payer.phones.map((p: any) => [p.phone, p.label])).toEqual([
      ["5511981000001", ""],
      ["5511981000002", "Financeiro"],
    ]);
    const dup = await api(admin, root(f) + "/payers", "POST", {
      document: "11222333000181",
      name: "Outro",
    });
    expect(dup.status).toBe(409);
    expect((await dup.json<any>()).error.code).toBe("payer_exists");
    expect(
      (
        await api(admin, root(f) + "/payers", "POST", {
          document: "11.222.333/0001-82",
          name: "X",
        })
      ).status,
    ).toBe(400);
    const linked = await (
      await api(member, `${root(f)}/payers/${payer.id}/phones`, "POST", {
        phone: "11981000003",
        label: "Estagiário",
      })
    ).json<any>();
    expect(linked.phones).toHaveLength(3);
    const removed = await (
      await api(member, `${root(f)}/payers/${payer.id}/phones/remove`, "POST", {
        phone: "5511981000003",
      })
    ).json<any>();
    expect(removed.phones).toHaveLength(2);
    const found = await (
      await api(member, `${root(f)}/payers?q=silva`)
    ).json<any>();
    expect(found.data.map((p: any) => p.id)).toEqual([payer.id]);
    const byDoc = await (
      await api(member, `${root(f)}/payers?q=22233`)
    ).json<any>();
    expect(byDoc.data.map((p: any) => p.id)).toEqual([payer.id]);
    expect(
      (
        await all(
          env,
          "SELECT kind FROM events WHERE profile_id=? AND kind LIKE 'mensalidade.payer_%'",
          f.profile,
        )
      ).length,
    ).toBe(3);
  });

  it("assinatura com documento acha ou cria o pagador; telefone de dois funcionários", async () => {
    const { f, ctx, plan, member } = await setup();
    const first = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        customer_name: "Empresa XPTO",
        phone: "11981000010",
        document: CNPJ_ALFA,
      })
    ).json<any>();
    expect(first.payer).toMatchObject({
      name: "Empresa XPTO",
      document_display: "12.ABC.345/01DE-35",
    });
    const second = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        customer_name: "Filial",
        phone: "11981000011",
        document: "12abc34501de35",
      })
    ).json<any>();
    expect(second.payer.id).toBe(first.payer.id);
    const detail = await (
      await api(member, `${root(f)}/payers/${first.payer.id}`)
    ).json<any>();
    expect(detail.phones.map((p: any) => p.phone).sort()).toEqual([
      "5511981000010",
      "5511981000011",
    ]);
    expect(detail.subscriptions).toHaveLength(2);
    // Os dois telefones enxergam o mesmo pagador.
    for (const phone of ["5511981000010", "11981000011"]) {
      const s = await situationByPhone(env, f.profile, phone);
      expect(s?.payer.id).toBe(first.payer.id);
      expect(s?.phone_linked).toBe(true);
    }
    // Sem documento: um pagador por assinatura, com o telefone dela.
    const plain = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        customer_name: "Ana",
        phone: "11981000012",
      })
    ).json<any>();
    expect(plain.payer).toMatchObject({ name: "Ana", document_display: null });
    expect(await situationByPhone(env, f.profile, "5511999990000")).toBeNull();
    expect(ctx.profile).toBe(f.profile);
  });

  it("assinaturas antigas viram pagadores com o telefone que já têm (migração 0051)", async () => {
    const { f, plan } = await setup();
    const id = uid();
    await exec(
      env,
      "INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,customer_name,phone,period,amount_cents,discount_cents,due_day,start_date,status,bill_from,created_by,created,updated) VALUES(?,?,?,?,?,'monthly',9900,0,10,'2026-01-01','active','2026-01-01','x',1,1)",
      id,
      f.profile,
      plan.id,
      "Antigo",
      "5511981000099",
    );
    // Mesmos comandos da migração, sobre uma assinatura sem pagador.
    await exec(
      env,
      "INSERT INTO mensalidade_payers(id,profile_id,document,document_type,name,created_by,created,updated) SELECT 'payer-' || id, profile_id, NULL, NULL, customer_name, 'migration', created, updated FROM mensalidade_subscriptions WHERE payer_id IS NULL",
    );
    await exec(
      env,
      "INSERT OR IGNORE INTO mensalidade_payer_phones(payer_id,profile_id,phone,label,created_by,created) SELECT 'payer-' || id, profile_id, phone, '', 'migration', created FROM mensalidade_subscriptions WHERE payer_id IS NULL AND phone <> ''",
    );
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET payer_id = 'payer-' || id WHERE payer_id IS NULL",
    );
    const s = await situationByPhone(env, f.profile, "5511981000099");
    expect(s?.payer).toMatchObject({ id: "payer-" + id, name: "Antigo" });
    expect(s?.subscriptions.map((x) => x.id)).toEqual([id]);
  });
});

describe("mensalidade: situação com carência", () => {
  it("em dia, em atraso além da carência e sem assinatura", async () => {
    const { f, ctx, plan } = await setup();
    const member = await bearer(f.member);
    const sub = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        customer_name: "Bruno",
        phone: "11981000020",
        document: CPF,
        start_date: "2026-10-01",
        due_day: 5,
      })
    ).json<any>();
    await runDue(ctx, brasilia(2026, 10, 1), { notices: false });
    // Antes do vencimento: em dia.
    expect(
      (
        await situationByDocument(env, f.profile, CPF, {
          at: brasilia(2026, 10, 3),
        })
      )?.status,
    ).toBe("em_dia");
    await runDue(ctx, brasilia(2026, 10, 8), { notices: false });
    const late = await situationByDocument(env, f.profile, CPF, {
      at: brasilia(2026, 10, 8),
      phone: "11999990000",
    });
    expect(late).toMatchObject({
      status: "em_atraso",
      matched_by: "document",
      phone_linked: false,
    });
    expect(late?.open_installment).toMatchObject({
      due_date: "2026-10-05",
      status: "overdue",
    });
    // Carência de 5 dias: até 10/10 ainda em dia, com a parcela informada.
    await configure(f, { mensalidade: { grace_days: 5 } });
    const graced = await situationByDocument(env, f.profile, CPF, {
      at: brasilia(2026, 10, 10),
    });
    expect(graced).toMatchObject({ status: "em_dia", grace_days: 5 });
    expect(graced?.open_installment?.due_date).toBe("2026-10-05");
    expect(
      (
        await situationByDocument(env, f.profile, CPF, {
          at: brasilia(2026, 10, 11),
        })
      )?.status,
    ).toBe("em_atraso");
    // Rota para apps e integrações.
    const route = await (
      await api(
        member,
        `${root(f)}/situation?document=${encodeURIComponent(CPF)}`,
      )
    ).json<any>();
    expect(route.payer.id).toBe(sub.payer.id);
    expect(
      (await api(member, `${root(f)}/situation?phone=5511900000001`)).status,
    ).toBe(404);
    expect(
      (await api(member, `${root(f)}/situation?document=123`)).status,
    ).toBe(400);
    // Encerrada: sem assinatura.
    await api(
      await bearer(f.admin),
      `${root(f)}/subscriptions/${sub.id}/end`,
      "POST",
      {},
    );
    expect((await situationByDocument(env, f.profile, CPF))?.status).toBe(
      "sem_assinatura",
    );
    expect(await situationByDocument(env, f.profile, CNPJ)).toBeNull();
  });
});

describe("mensalidade: contratar pelo WhatsApp", () => {
  it("contrato pendente: pagador, assinatura e primeira parcela só nascem com o pagamento confirmado", async () => {
    const { f, ctx, plan } = await setup();
    const account = await configurePayments(f);
    const hidden = await createPlan(
      ctx,
      { name: "Interno", amount_cents: 100 },
      f.admin.id,
    );
    expect((await sellablePlans(env, f.profile)).map((p) => p.id)).toEqual([
      plan.id,
    ]);
    const phone = "5511981000030";
    const c = await receive(f, f.line, "quero suporte", phone);
    await drain(f);
    const convo = await conversation(env, c.id, f.profile);
    await expect(
      contractPlan(env, f.profile, {
        conversation: convo,
        plan_id: hidden.id,
        document: CPF,
        name: "Carla",
        sourceKey: uid(),
        actor: "customer",
      }),
    ).rejects.toMatchObject({ code: "plan_not_sellable" });
    const key = "contrato-" + uid();
    const { contract } = await contractPlan(env, f.profile, {
      conversation: convo,
      plan_id: plan.id,
      document: CPF,
      name: "Carla Dias",
      method: "pix",
      sourceKey: key,
      actor: "customer:" + phone,
    });
    expect(contract).toMatchObject({
      plan_id: plan.id,
      status: "pending",
      amount_cents: 9900,
      name: "Carla Dias",
      document_display: "529.982.247-25",
      payer_id: null,
    });
    expect(contract!.payment).toMatchObject({ status: "created" });
    expect(contract!.payment!.pix_code).toMatch(/^00020126PIX/);
    // Contratar pela conversa registra o aceite de cobranças pelo WhatsApp.
    expect(await ctx.consent(convo, "billing")).toMatchObject({
      status: "granted",
    });
    // Nada no cadastro antes do pagamento.
    expect(await situationByPhone(env, f.profile, phone)).toBeNull();
    expect(await situationByDocument(env, f.profile, CPF)).toBeNull();
    // Repetir a mesma chave: o mesmo contrato, sem outra cobrança.
    const again = await contractPlan(env, f.profile, {
      conversation: convo,
      plan_id: plan.id,
      document: CPF,
      name: "Carla Dias",
      method: "pix",
      sourceKey: key,
      actor: "customer:" + phone,
    });
    expect(again.contract!.id).toBe(contract!.id);
    expect(mp.created).toBe(1);
    // Webhook aprovado (repetido): nasce tudo uma vez, avisa o ouvinte uma vez.
    paidHeard.length = 0;
    await approve(account.id, contract!.payment!.id, 2);
    const situation = await situationByPhone(env, f.profile, phone);
    expect(situation).toMatchObject({ status: "em_dia", phone_linked: true });
    expect(situation!.payer).toMatchObject({
      name: "Carla Dias",
      document: "52998224725",
    });
    const sub = situation!.subscriptions[0];
    const inst = await one(
      env,
      "SELECT * FROM mensalidade_installments WHERE subscription_id=?",
      sub.id,
    );
    expect(inst).toMatchObject({
      status: "paid",
      upfront: 1,
      paid_via: "pix",
      paid_by: "provider",
      amount_cents: 9900,
      payment_id: contract!.payment!.id,
    });
    expect(
      paidHeard.map((p) => [
        p.id,
        p.payer_id,
        p.paid_via,
        p.conversation_id,
        p.contract_id,
      ]),
    ).toEqual([[inst.id, situation!.payer.id, "pix", convo.id, contract!.id]]);
    // Já em dia no mesmo plano (pagador do telefone): nada a pagar.
    await expect(
      contractPlan(env, f.profile, {
        conversation: convo,
        plan_id: plan.id,
        payer_id: situation!.payer.id,
        sourceKey: uid(),
        actor: "customer",
      }),
    ).rejects.toMatchObject({ code: "nothing_to_pay" });
    // O gerador não duplica a parcela do mês.
    await runDue(ctx, now() + 86_400_000, { notices: false });
    expect(
      (
        await all(
          env,
          "SELECT id FROM mensalidade_installments WHERE subscription_id=? AND period_key=?",
          sub.id,
          inst.period_key,
        )
      ).length,
    ).toBe(1);
    const events = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='mensalidade.installment_created'",
      f.profile,
    );
    expect(events.map((e) => json(e.payload).upfront)).toContain(true);
  });

  it("documento já cadastrado não contrata pelo WhatsApp; pagador só pelo telefone autorizado", async () => {
    const { f, admin, plan } = await setup();
    await configurePayments(f);
    const created = await api(admin, `${root(f)}/payers`, "POST", {
      name: "Empresa Alfa",
      document: CNPJ,
      phones: ["5511981000050"],
    });
    expect(created.status).toBe(200);
    const payer = await created.json<any>();
    const stranger = await receive(f, f.line, "oi", "5511981000059");
    await drain(f);
    const convo = await conversation(env, stranger.id, f.profile);
    // Documento de outra pessoa: recusado, e nada muda no cadastro dela.
    await expect(
      contractPlan(env, f.profile, {
        conversation: convo,
        plan_id: plan.id,
        document: CNPJ,
        name: "Atacante",
        sourceKey: uid(),
        actor: "customer",
      }),
    ).rejects.toMatchObject({ code: "payer_exists" });
    // Pagador de outro telefone: recusado.
    await expect(
      contractPlan(env, f.profile, {
        conversation: convo,
        plan_id: plan.id,
        payer_id: payer.id,
        sourceKey: uid(),
        actor: "customer",
      }),
    ).rejects.toMatchObject({ code: "phone_not_linked" });
    expect(
      (await situationByDocument(env, f.profile, CNPJ))!.payer.phones.map(
        (p: any) => p.phone,
      ),
    ).toEqual(["5511981000050"]);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_contracts WHERE profile_id=?",
        f.profile,
      ),
    ).toEqual({ n: 0 });
    // O telefone autorizado contrata em nome do pagador.
    const own = await receive(f, f.line, "oi", "5511981000050");
    await drain(f);
    const result = await contractPlan(env, f.profile, {
      conversation: await conversation(env, own.id, f.profile),
      plan_id: plan.id,
      payer_id: payer.id,
      sourceKey: uid(),
      actor: "customer",
    });
    expect(result.contract).toMatchObject({
      payer_id: payer.id,
      status: "pending",
    });
  });

  it("cobrar de novo reaproveita o Pix que vale e troca de forma cancelando a aberta", async () => {
    const { f, plan } = await setup();
    await configurePayments(f);
    const c = await receive(f, f.line, "oi", "5511981000040");
    await drain(f);
    const convo = await conversation(env, c.id, f.profile);
    const { contract } = await contractPlan(env, f.profile, {
      conversation: convo,
      plan_id: plan.id,
      document: CNPJ,
      name: "Loja",
      sourceKey: uid(),
      actor: "customer",
    });
    const same = await chargeContractAgain(env, f.profile, {
      conversation: convo,
      contract_id: contract!.id,
      key: uid(),
    });
    expect(same.payment?.id).toBe(contract!.payment!.id);
    expect(mp.created).toBe(1);
    const link = await chargeContractAgain(env, f.profile, {
      conversation: convo,
      contract_id: contract!.id,
      method: "link",
      key: uid(),
    });
    expect(link.payment?.id).not.toBe(contract!.payment!.id);
    expect(link.payment?.url).toContain("checkout");
    expect(link.method).toBe("link");
    expect(mp.created).toBe(2);
    expect(
      await one(
        env,
        "SELECT status FROM payments WHERE id=?",
        contract!.payment!.id,
      ),
    ).toEqual({ status: "cancelled" });
    expect(chargeInstallment).toBeTruthy();
    expect(addDays(today(now()), 0)).toBe(today(now()));
  });
});
