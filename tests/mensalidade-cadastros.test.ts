import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { perform } from "../src/service";
import { json, uid } from "../src/types";
import {
  dueDates,
  money,
  validateMensalidadeSettings,
} from "../src/modules/mensalidade/model";
import {
  api,
  application,
  bearer,
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

const root = (f: Fixture) => `/profiles/${f.profile}/mensalidade`;
const turn = (f: Fixture, enabled: boolean) =>
  perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "mensalidade", enabled },
    uid(),
  );
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));

async function setup() {
  const f = await fixture();
  await turn(f, true);
  const admin = await bearer(f.admin);
  const member = await bearer(f.member);
  const plan = await (
    await api(admin, root(f) + "/plans", "POST", {
      name: "Inglês Kids",
      amount_cents: 18000,
      period: "monthly",
      due_day: 10,
    })
  ).json<any>();
  return { f, admin, member, plan };
}

describe("mensalidade: módulo desligado", () => {
  it("vem desligado e as rotas respondem 409 module_disabled", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    for (const [path, method, body] of [
      ["/plans", "GET", undefined],
      ["/subscriptions", "GET", undefined],
      ["/plans", "POST", { name: "X", amount_cents: 100 }],
      ["/subscriptions/import", "POST", { rows: [] }],
    ] as const) {
      const res = await api(token, root(f) + path, method, body);
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error.code).toBe("module_disabled");
    }
    const listed = await (
      await api(token, `/profiles/${f.profile}/modules`)
    ).json<any>();
    expect(listed.data.find((m: any) => m.id === "mensalidade")).toMatchObject({
      enabled: false,
      default_enabled: false,
    });
  });
});

describe("mensalidade: planos", () => {
  it("cria, altera, desativa e só exclui plano sem assinaturas", async () => {
    const { f, admin, member, plan } = await setup();
    expect(plan).toMatchObject({
      name: "Inglês Kids",
      amount_cents: 18000,
      period: "monthly",
      period_label: "Mensal",
      due_day: 10,
      active: true,
    });
    // Atendente não cria plano.
    const denied = await api(member, root(f) + "/plans", "POST", {
      name: "Outro",
      amount_cents: 100,
    });
    expect(denied.status).toBe(403);
    // Validações: centavos inteiros, periodicidade e dia.
    for (const body of [
      { name: "A", amount_cents: 10.5 },
      { name: "A", amount_cents: 100, period: "weekly" },
      { name: "A", amount_cents: 100, due_day: 32 },
    ]) {
      const res = await api(admin, root(f) + "/plans", "POST", body);
      expect(res.status).toBe(400);
    }
    const changed = await (
      await api(admin, `${root(f)}/plans/${plan.id}`, "PATCH", {
        amount_cents: 19000,
        period: "quarterly",
      })
    ).json<any>();
    expect(changed).toMatchObject({ amount_cents: 19000, period: "quarterly" });
    await api(admin, root(f) + "/subscriptions", "POST", {
      plan_id: plan.id,
      customer_name: "Ana",
      phone: "11987650001",
    });
    const blocked = await api(
      admin,
      `${root(f)}/plans/${plan.id}`,
      "DELETE",
      {},
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error.code).toBe("plan_in_use");
    const off = await (
      await api(admin, `${root(f)}/plans/${plan.id}`, "PATCH", {
        active: false,
      })
    ).json<any>();
    expect(off.active).toBe(false);
    // Plano desativado não aceita novas assinaturas.
    const refused = await api(admin, root(f) + "/subscriptions", "POST", {
      plan_id: plan.id,
      customer_name: "Bia",
      phone: "11987650002",
    });
    expect(refused.status).toBe(400);
    const spare = await (
      await api(admin, root(f) + "/plans", "POST", {
        name: "Avulso",
        amount_cents: 5000,
      })
    ).json<any>();
    expect(
      (await api(admin, `${root(f)}/plans/${spare.id}`, "DELETE", {})).status,
    ).toBe(200);
    const list = await (await api(member, root(f) + "/plans")).json<any>();
    expect(list.data.map((p: any) => p.name)).toEqual(["Inglês Kids"]);
    expect(list.data[0].subscriptions).toBe(1);
  });
});

describe("mensalidade: assinaturas", () => {
  it("cria pelo telefone e pela conversa; repetir a Idempotency-Key devolve a mesma", async () => {
    const { f, admin, member, plan } = await setup();
    const key = "assinar-" + uid();
    const body = {
      plan_id: plan.id,
      customer_name: "Ana Souza",
      phone: "(11) 98765-0001",
      discount_cents: 3000,
      start_date: "2026-12-01",
    };
    const first = await api(
      member,
      root(f) + "/subscriptions",
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const sub = await first.json<any>();
    expect(sub).toMatchObject({
      plan_id: plan.id,
      customer: { name: "Ana Souza", phone: "5511987650001" },
      period: "monthly",
      amount_cents: 18000,
      discount_cents: 3000,
      charge_cents: 15000,
      due_day: 10,
      start_date: "2026-12-01",
      end_date: null,
      status: "active",
    });
    const replay = await api(
      member,
      root(f) + "/subscriptions",
      "POST",
      body,
      key,
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json<any>()).id).toBe(sub.id);
    expect(
      await all(
        env,
        "SELECT id FROM mensalidade_subscriptions WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(1);
    // Desconto maior que o valor e datas inválidas são recusados.
    for (const bad of [
      { ...body, discount_cents: 18000 },
      { ...body, start_date: "2026-02-30" },
      { ...body, end_date: "2026-11-01" },
    ])
      expect(
        (await api(member, root(f) + "/subscriptions", "POST", bad)).status,
      ).toBe(400);

    // Pela conversa: telefone e conversa vêm dela.
    const c = await receive(f, f.line, "oi", "5511987650009");
    await drain(f);
    const linked = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        conversation_id: c.id,
        customer_name: "Caio",
        due_day: 31,
      })
    ).json<any>();
    expect(linked.customer).toMatchObject({
      phone: "5511987650009",
      conversation_id: c.id,
    });
    expect(linked.due_day).toBe(31);

    const detail = await (
      await api(member, `${root(f)}/subscriptions/${sub.id}`)
    ).json<any>();
    expect(detail.installments).toEqual([]);
    const search = await (
      await api(member, `${root(f)}/subscriptions?q=ana`)
    ).json<any>();
    expect(search.data.map((s: any) => s.id)).toEqual([sub.id]);
    expect(search.counts).toEqual({ active: 2 });
    expect((await events(f, "mensalidade.subscription_created")).length).toBe(
      2,
    );
  });

  it("altera, pausa, retoma e encerra com registro em eventos", async () => {
    const { f, admin, member, plan } = await setup();
    const sub = await (
      await api(member, root(f) + "/subscriptions", "POST", {
        plan_id: plan.id,
        customer_name: "Davi",
        phone: "11987650003",
      })
    ).json<any>();
    const changed = await (
      await api(member, `${root(f)}/subscriptions/${sub.id}`, "PATCH", {
        discount_cents: 2000,
        due_day: 5,
      })
    ).json<any>();
    expect(changed).toMatchObject({ charge_cents: 16000, due_day: 5 });
    // Pausar e encerrar: só administrador.
    expect(
      (
        await api(
          member,
          `${root(f)}/subscriptions/${sub.id}/pause`,
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    const paused = await (
      await api(admin, `${root(f)}/subscriptions/${sub.id}/pause`, "POST", {})
    ).json<any>();
    expect(paused).toMatchObject({ status: "paused", status_label: "Pausada" });
    expect(
      (await api(admin, `${root(f)}/subscriptions/${sub.id}/pause`, "POST", {}))
        .status,
    ).toBe(409);
    const resumed = await (
      await api(admin, `${root(f)}/subscriptions/${sub.id}/resume`, "POST", {})
    ).json<any>();
    expect(resumed.status).toBe("active");
    const ended = await (
      await api(admin, `${root(f)}/subscriptions/${sub.id}/end`, "POST", {})
    ).json<any>();
    expect(ended.status).toBe("ended");
    expect(ended.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      (
        await api(member, `${root(f)}/subscriptions/${sub.id}`, "PATCH", {
          notes: "x",
        })
      ).status,
    ).toBe(400);
    const changes = (await events(f, "mensalidade.subscription_changed")).map(
      (e) => e.change,
    );
    expect(changes).toEqual(["updated", "paused", "resumed", "ended"]);
  });

  it("importa vários clientes, aponta as linhas com erro e não duplica ao reimportar", async () => {
    const { f, admin, member, plan } = await setup();
    const rows = [
      { customer_name: "Eva", phone: "11 98765-0010", plan: "inglês kids" },
      {
        name: "Fábio",
        phone: "11987650011",
        plan_id: plan.id,
        discount_cents: 1800,
        due_day: 15,
      },
      { customer_name: "Gil", phone: "123", plan: "Inglês Kids" },
      { customer_name: "Hugo", phone: "11987650013", plan: "Natação" },
    ];
    expect(
      (await api(member, root(f) + "/subscriptions/import", "POST", { rows }))
        .status,
    ).toBe(403);
    const result = await (
      await api(admin, root(f) + "/subscriptions/import", "POST", { rows })
    ).json<any>();
    expect(result.created.map((s: any) => s.customer.name)).toEqual([
      "Eva",
      "Fábio",
    ]);
    expect(result.created[1]).toMatchObject({
      charge_cents: 16200,
      due_day: 15,
    });
    expect(result.errors.map((e: any) => e.line)).toEqual([3, 4]);
    expect(result.errors[1].message).toContain("Plano não encontrado");
    const again = await (
      await api(admin, root(f) + "/subscriptions/import", "POST", { rows })
    ).json<any>();
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s: any) => s.line)).toEqual([1, 2]);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=?",
        f.profile,
      ),
    ).toEqual({ n: 2 });
  });

  it("integração com conversations:write cria; sem a permissão, 403", async () => {
    const { f, plan } = await setup();
    const reader = await application(f, ["conversations:read"]);
    const writer = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    const body = {
      plan_id: plan.id,
      customer_name: "Ivo",
      phone: "11987650020",
    };
    expect(
      (await api(reader.token, root(f) + "/subscriptions", "POST", body))
        .status,
    ).toBe(403);
    expect(
      (await api(writer.token, root(f) + "/subscriptions", "POST", body))
        .status,
    ).toBe(200);
    expect((await api(reader.token, root(f) + "/subscriptions")).status).toBe(
      200,
    );
  });
});

describe("mensalidade: regras e datas", () => {
  it("valida as regras salvas em Gestão", async () => {
    const { f } = await setup();
    await configure(f, {
      mensalidade: { method: "link", days_before: 5, overdue_max: 2 },
    });
    const saved = await one(
      env,
      "SELECT settings FROM profiles WHERE id=?",
      f.profile,
    );
    expect(json(saved.settings).mensalidade).toEqual({
      method: "link",
      days_before: 5,
      overdue_max: 2,
    });
    for (const bad of [
      { method: "boleto" },
      { days_before: 40 },
      { overdue_max: -1 },
      { outra: 1 },
    ])
      expect(() => validateMensalidadeSettings(bad)).toThrow();
  });

  it("vencimentos: dia 31 vira o último dia do mês curto, trimestral e anual", () => {
    const monthly = dueDates(
      { start_date: "2027-01-01", due_day: 31, period: "monthly" },
      "2027-05-31",
    );
    expect(monthly.map((d) => d.due_date)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
    expect(new Set(monthly.map((d) => d.period_key)).size).toBe(5);
    // Ano bissexto.
    expect(
      dueDates(
        { start_date: "2028-02-01", due_day: 30, period: "monthly" },
        "2028-02-29",
      ),
    ).toEqual([{ period_key: "2028-02", due_date: "2028-02-29" }]);
    // Início depois do dia: primeiro vencimento no mês seguinte.
    expect(
      dueDates(
        { start_date: "2026-11-20", due_day: 10, period: "quarterly" },
        "2027-12-31",
      ).map((d) => d.due_date),
    ).toEqual([
      "2026-12-10",
      "2027-03-10",
      "2027-06-10",
      "2027-09-10",
      "2027-12-10",
    ]);
    expect(
      dueDates(
        {
          start_date: "2026-01-05",
          due_day: 5,
          period: "yearly",
          end_date: "2027-12-31",
        },
        "2030-01-01",
      ).map((d) => d.due_date),
    ).toEqual(["2026-01-05", "2027-01-05"]);
    expect(money(123456)).toBe("R$ 1.234,56");
  });
});
