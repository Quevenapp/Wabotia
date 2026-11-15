// Revisão de segurança M4 e M5: o que muda quanto se cobra ou quem fala pelo
// pagador é só de administrador (ou integração); atendente comum, não.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { createPlan } from "../src/modules/mensalidade/store";
import { situationByPhone } from "../src/modules/mensalidade/public";
import { api, bearer, fixture, type Fixture } from "./service-center-fixture";

const CNPJ = "11.222.333/0001-81";
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
  const plan = await createPlan(
    modulesApi(env, f.profile, "mensalidade"),
    { name: "Suporte Mensal", amount_cents: 9900 },
    f.admin.id,
  );
  return {
    f,
    plan,
    admin: await bearer(f.admin),
    member: await bearer(f.member),
  };
}

const code = async (res: Response) => (await res.json<any>()).error?.code;

describe("M4: valor, desconto e plano da assinatura", () => {
  it("atendente cadastra e edita dados do cliente, mas não muda o que se cobra", async () => {
    const { f, plan, admin, member } = await setup();
    const other = await createPlan(
      modulesApi(env, f.profile, "mensalidade"),
      { name: "Barato", amount_cents: 100 },
      f.admin.id,
    );
    // Cadastro pelo valor do plano: pode.
    const created = await api(member, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Loja Gama",
      phone: "5511982000001",
    });
    expect(created.status).toBe(200);
    const sub = await created.json<any>();
    // Valor ou desconto no cadastro: não.
    const priced = await api(member, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Loja Delta",
      phone: "5511982000002",
      discount_cents: 9800,
    });
    expect(priced.status).toBe(403);
    expect(await code(priced)).toBe("admin_required");
    for (const change of [
      { discount_cents: 9899 },
      { amount_cents: 1 },
      { plan_id: other.id },
    ]) {
      const res = await api(
        member,
        `${root(f)}/subscriptions/${sub.id}`,
        "PATCH",
        change,
      );
      expect(res.status, JSON.stringify(change)).toBe(403);
    }
    const renamed = await api(
      member,
      `${root(f)}/subscriptions/${sub.id}`,
      "PATCH",
      { customer_name: "Loja Gama Ltda", notes: "Prefere Pix" },
    );
    expect(renamed.status).toBe(200);
    const discounted = await api(
      admin,
      `${root(f)}/subscriptions/${sub.id}`,
      "PATCH",
      { discount_cents: 900 },
    );
    expect(discounted.status).toBe(200);
    expect((await discounted.json<any>()).discount_cents).toBe(900);
  });
});

describe("M5: telefone autorizado e documento do pagador", () => {
  it("só administrador autoriza telefone, troca documento ou liga telefone novo a documento existente", async () => {
    const { f, plan, admin, member } = await setup();
    const res = await api(admin, `${root(f)}/payers`, "POST", {
      name: "Empresa Alfa",
      document: CNPJ,
      phones: ["5511982000010"],
    });
    const payer = await res.json<any>();
    await api(admin, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      payer_id: payer.id,
      customer_name: "Empresa Alfa",
      phone: "5511982000010",
    });
    const friend = "5511982000019";
    const add = await api(
      member,
      `${root(f)}/payers/${payer.id}/phones`,
      "POST",
      { phone: friend },
    );
    expect(add.status).toBe(403);
    // Pela assinatura com o documento do pagador: também não.
    const sneaky = await api(member, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Amigo",
      phone: friend,
      document: CNPJ,
    });
    expect(sneaky.status).toBe(403);
    expect(await situationByPhone(env, f.profile, friend)).toBeNull();
    const redoc = await api(member, `${root(f)}/payers/${payer.id}`, "PATCH", {
      document: "529.982.247-25",
    });
    expect(redoc.status).toBe(403);
    const rename = await api(member, `${root(f)}/payers/${payer.id}`, "PATCH", {
      name: "Empresa Alfa Ltda",
    });
    expect(rename.status).toBe(200);
    // Mesmo telefone já autorizado: o atendente cadastra outra assinatura.
    const same = await api(member, `${root(f)}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Empresa Alfa",
      phone: "5511982000010",
      document: CNPJ,
    });
    expect(same.status).toBe(200);
    const ok = await api(
      admin,
      `${root(f)}/payers/${payer.id}/phones`,
      "POST",
      {
        phone: friend,
        label: "Pedro",
      },
    );
    expect(ok.status).toBe(200);
    expect(
      (await ok.json<any>()).phones.map((p: any) => p.created_by),
    ).toContain(f.admin.id);
  });
});
