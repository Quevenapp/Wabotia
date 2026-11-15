// Revisão de segurança M3, M6 e M7 na Mensalidade, sobre a base do núcleo:
// billing:write para aplicações, dados pessoais e notas com contacts:read e
// notes:read, e identidade só pelo telefone verificado.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { uid, type Actor, type Conversation } from "../src/types";
import { modulesApi } from "../src/modules/api";
import {
  createPlan,
  createSubscription,
} from "../src/modules/mensalidade/store";
import { statementText } from "../src/modules/mensalidade/chat";
import {
  chargeInstallment,
  onInstallmentPaid,
} from "../src/modules/mensalidade/public";
import {
  api,
  application,
  bearer,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";
import { approve, configurePayments, useMercadoPago } from "./mensalidade-mp";

useMercadoPago();

const CPF = "529.982.247-25";
const root = (f: Fixture) => `/profiles/${f.profile}/mensalidade`;

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
    { name: "Suporte Mensal", amount_cents: 9900 },
    f.admin.id,
  );
  const admin = await bearer(f.admin);
  const sub = await (
    await api(admin, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Empresa Alfa",
      phone: "5511985000001",
      document: CPF,
      notes: "Cliente desde 2019, pede nota fiscal",
    })
  ).json<any>();
  await api(admin, `${root(f)}/generate`, "POST", {});
  const inst = await one(
    env,
    "SELECT id FROM mensalidade_installments WHERE subscription_id=? LIMIT 1",
    sub.id,
  );
  return { f, ctx, plan, admin, sub, inst };
}

describe("M3: operação financeira de aplicação exige billing:write", () => {
  it("chave só de mensagens não dá baixa, não isenta nem muda valor", async () => {
    const { f, sub, inst } = await setup();
    expect(inst?.id).toBeTruthy();
    const chat = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    for (const [path, method, body] of [
      [`/installments/${inst.id}/pay`, "POST", {}],
      [`/installments/${inst.id}/waive`, "POST", {}],
      [`/subscriptions/${sub.id}`, "PATCH", { discount_cents: 9800 }],
      [`/subscriptions/${sub.id}/end`, "POST", {}],
      ["/plans", "POST", { name: "Grátis", amount_cents: 100 }],
    ] as const) {
      const res = await api(chat.token, root(f) + path, method, body);
      expect(res.status, path).toBe(403);
      expect((await res.json<any>()).error.code, path).toBe("missing_scope");
    }
    const erp = await application(f, [
      "conversations:read",
      "conversations:write",
      "billing:write",
    ]);
    const paid = await api(
      erp.token,
      `${root(f)}/installments/${inst.id}/pay`,
      "POST",
      { notify: false },
    );
    expect(paid.status).toBe(200);
    expect((await paid.json<any>()).status).toBe("paid");
  });
});

describe("M6: dados pessoais e notas nas leituras", () => {
  it("aplicação sem contacts:read e notes:read não vê documento, telefones nem observações", async () => {
    const { f, sub } = await setup();
    const reader = await application(f, ["conversations:read"]);
    // Pagadores e consulta por documento: cadastro de pessoas.
    for (const path of [
      "/payers",
      `/payers/${sub.payer.id}`,
      `/situation?document=${encodeURIComponent(CPF)}`,
    ]) {
      const res = await api(reader.token, root(f) + path);
      expect(res.status, path).toBe(403);
    }
    const detail = await (
      await api(reader.token, `${root(f)}/subscriptions/${sub.id}`)
    ).json<any>();
    const text = JSON.stringify(detail);
    expect(text).not.toContain("5511985000001");
    expect(text).not.toContain("52998224725");
    expect(text).not.toContain("nota fiscal");
    expect(detail.customer.name).toBe("Empresa Alfa");
    // Com as permissões, vê.
    const full = await application(f, [
      "conversations:read",
      "contacts:read",
      "notes:read",
    ]);
    const shown = await (
      await api(full.token, `${root(f)}/subscriptions/${sub.id}`)
    ).json<any>();
    expect(shown.customer.phone).toBe("5511985000001");
    expect(shown.notes).toContain("nota fiscal");
  });

  it("atendente vê o documento mascarado na lista e completo no detalhe", async () => {
    const { f, sub } = await setup();
    const member = await bearer(f.member);
    const list = await (await api(member, `${root(f)}/payers`)).json<any>();
    expect(list.data[0].document).toBeNull();
    expect(list.data[0].document_display).toBe("52*.***.***-25");
    const detail = await (
      await api(member, `${root(f)}/payers/${sub.payer.id}`)
    ).json<any>();
    expect(detail.document_display).toBe("529.982.247-25");
    const admin = await (
      await api(await bearer(f.admin), `${root(f)}/payers`)
    ).json<any>();
    expect(admin.data[0].document_display).toBe("529.982.247-25");
  });
});

describe("M7: identidade só pelo telefone verificado", () => {
  it("conversa de integração com o telefone de outra pessoa não puxa nem mostra as mensalidades dela", async () => {
    const { f, ctx, plan } = await setup();
    const victim = "5511985000009";
    const sub = await createSubscription(
      ctx,
      { plan_id: plan.id, customer_name: "Vítima", phone: victim },
      f.admin.id,
    );
    const appActor: Actor = {
      id: "app-integracao",
      kind: "app",
      name: "Integração",
      role: "operator",
      profiles: [f.profile],
      scopes: ["conversations:read", "conversations:write"],
      bots: [],
      rate: 60,
      runLimit: 3,
    };
    await perform(
      env,
      appActor,
      f.profile,
      "conversation.create",
      { external_id: victim, phone: victim, text: "Minhas mensalidades" },
      uid(),
    );
    const c = (await one(
      env,
      "SELECT * FROM conversations WHERE profile_id=? AND external_namespace=?",
      f.profile,
      "app:app-integracao",
    )) as Conversation;
    expect(c).toBeTruthy();
    expect(ctx.verifiedPhone(c)).toBeNull();
    expect((await statementText(ctx, c)).text).toBe("");
    expect(
      await one(
        env,
        "SELECT conversation_id FROM mensalidade_subscriptions WHERE id=?",
        sub.id,
      ),
    ).toEqual({ conversation_id: null });
  });
});

describe("A3: gancho de pagamento repetido pelo núcleo", () => {
  const calls: string[] = [];
  let failOnce = new Set<string>();
  onInstallmentPaid("teste-repeticao", async (_env, profile, inst) => {
    if (!failOnce.has(profile) && !calls.some((c) => c.startsWith(profile)))
      return;
    calls.push(`${profile}:${inst.id}`);
    if (failOnce.delete(profile)) throw new Error("falha transitória");
  });

  it("falha num ouvinte faz repetir; a repetição avisa de novo e não vira pagamento em dobro", async () => {
    const { f, ctx, inst } = await setup();
    const account = await configurePayments(f);
    const c = await receive(f, f.line, "oi", "5511985000001");
    await drain(f);
    const convo = await conversation(env, c.id, f.profile);
    const charged = await chargeInstallment(env, f.profile, {
      conversation: convo,
      installment_id: inst.id,
      key: uid(),
    });
    failOnce = new Set([f.profile]);
    await approve(account.id, charged.payment!.id);
    await approve(account.id, charged.payment!.id);
    expect(calls.filter((x) => x.startsWith(f.profile))).toEqual([
      `${f.profile}:${inst.id}`,
      `${f.profile}:${inst.id}`,
    ]);
    expect(
      await one(
        env,
        "SELECT status,payment_id FROM mensalidade_installments WHERE id=?",
        inst.id,
      ),
    ).toEqual({ status: "paid", payment_id: charged.payment!.id });
    const paid = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='mensalidade.paid'",
      f.profile,
    );
    expect(paid).toHaveLength(1);
    expect(JSON.stringify(paid)).not.toContain("duplicate");
    expect(ctx.profile).toBe(f.profile);
  });
});
