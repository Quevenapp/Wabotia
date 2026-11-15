import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runModuleSchedules } from "../src/modules/schedule";
import { runDue } from "../src/modules/mensalidade/due";
import {
  createPlan,
  createSubscription,
  loadSubscription,
  setSubscriptionStatus,
} from "../src/modules/mensalidade/store";
import { today } from "../src/modules/mensalidade/model";
import {
  api,
  bearer,
  brasilia,
  fixture,
  type Fixture,
} from "./service-center-fixture";

const root = (f: Fixture) => `/profiles/${f.profile}/mensalidade`;
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));
// Só parcelas e vencidas; os avisos têm testes próprios (mensalidade-cobranca).
const generate = (ctx: any, at: number) => runDue(ctx, at, { notices: false });
const installments = (subscription: string) =>
  all(
    env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? ORDER BY due_date",
    subscription,
  );

async function setup(planData: any = {}) {
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
    { name: "Natação", amount_cents: 15000, due_day: 10, ...planData },
    f.admin.id,
  );
  const subscribe = (data: any = {}) =>
    createSubscription(
      ctx,
      {
        plan_id: plan.id,
        customer_name: "Lia",
        phone: "11987654321",
        ...data,
      },
      f.admin.id,
    );
  return { f, ctx, plan, subscribe };
}

describe("mensalidade: geração de parcelas", () => {
  it("dia 31 vira o último dia do mês curto, sem repetir em rodadas repetidas", async () => {
    const { f, ctx, subscribe } = await setup({ due_day: 31 });
    const sub = await subscribe({
      start_date: "2027-01-01",
      discount_cents: 2500,
    });
    const jan = brasilia(2027, 1, 1, 8);
    expect(await generate(ctx, jan)).toEqual({ created: 1, overdue: 0 });
    expect(await generate(ctx, jan)).toEqual({ created: 0, overdue: 0 });
    const feb = brasilia(2027, 2, 1, 9);
    expect(await generate(ctx, feb)).toEqual({ created: 1, overdue: 1 });
    expect(await generate(ctx, feb + 60_000)).toEqual({
      created: 0,
      overdue: 0,
    });
    // O gancho do núcleo roda a mesma função e também não repete.
    expect(
      await runModuleSchedules(env, f.profile, feb + 120_000),
    ).toContainEqual({ module: "mensalidade", ok: true });
    expect(await generate(ctx, brasilia(2027, 3, 5))).toMatchObject({
      created: 1,
    });
    expect(await generate(ctx, brasilia(2027, 4, 2))).toMatchObject({
      created: 1,
    });
    const rows = await installments(sub.id);
    expect(rows.map((r) => [r.period_key, r.due_date, r.status])).toEqual([
      ["2027-01", "2027-01-31", "overdue"],
      ["2027-02", "2027-02-28", "overdue"],
      ["2027-03", "2027-03-31", "overdue"],
      ["2027-04", "2027-04-30", "open"],
    ]);
    expect(rows.every((r) => r.amount_cents === 12500)).toBe(true);
    expect(await events(f, "mensalidade.installment_created")).toHaveLength(4);
    expect(
      (await events(f, "mensalidade.overdue")).map((e) => e.period_key),
    ).toEqual(["2027-01", "2027-02", "2027-03"]);
  });

  it("pausada não gera e cancela as não vencidas; retomar pula a pausa; encerrada para", async () => {
    const { f, ctx, subscribe } = await setup();
    const sub = await subscribe({ start_date: "2027-01-01" });
    await generate(ctx, brasilia(2027, 1, 1));
    await setSubscriptionStatus(
      ctx,
      await loadSubscription(ctx, sub.id),
      "paused",
      f.admin.id,
      brasilia(2027, 1, 5),
    );
    expect((await installments(sub.id)).map((r) => r.status)).toEqual([
      "cancelled",
    ]);
    // Pausada: nada novo, e a cancelada não vira vencida.
    expect(await generate(ctx, brasilia(2027, 2, 15))).toEqual({
      created: 0,
      overdue: 0,
    });
    await setSubscriptionStatus(
      ctx,
      await loadSubscription(ctx, sub.id),
      "active",
      f.admin.id,
      brasilia(2027, 3, 20),
    );
    expect(await generate(ctx, brasilia(2027, 3, 20))).toMatchObject({
      created: 1,
    });
    expect(
      (await installments(sub.id)).map((r) => [r.due_date, r.status]),
    ).toEqual([
      ["2027-01-10", "cancelled"],
      ["2027-04-10", "open"],
    ]);
    // Uma parcela vencida continua devida depois de encerrar.
    await generate(ctx, brasilia(2027, 4, 11));
    await generate(ctx, brasilia(2027, 4, 20));
    await setSubscriptionStatus(
      ctx,
      await loadSubscription(ctx, sub.id),
      "ended",
      f.admin.id,
      brasilia(2027, 4, 25),
    );
    const ended = await loadSubscription(ctx, sub.id);
    expect(ended).toMatchObject({ status: "ended", end_date: "2027-04-25" });
    expect(
      (await installments(sub.id)).map((r) => [r.due_date, r.status]),
    ).toEqual([
      ["2027-01-10", "cancelled"],
      ["2027-04-10", "overdue"],
      ["2027-05-10", "cancelled"],
    ]);
    expect(await generate(ctx, brasilia(2027, 8, 1))).toEqual({
      created: 0,
      overdue: 0,
    });
    expect(await installments(sub.id)).toHaveLength(3);
  });

  it("início no passado gera as parcelas atrasadas marcadas como retroativas", async () => {
    const { ctx, subscribe } = await setup({ period: "quarterly" });
    const sub = await subscribe({ start_date: "2026-01-01", due_day: 5 });
    expect(await generate(ctx, brasilia(2026, 7, 20))).toEqual({
      created: 3,
      overdue: 0,
    });
    expect(
      (await installments(sub.id)).map((r) => [
        r.due_date,
        r.status,
        r.retroactive,
      ]),
    ).toEqual([
      ["2026-01-05", "overdue", 1],
      ["2026-04-05", "overdue", 1],
      ["2026-07-05", "overdue", 1],
    ]);
  });
});

describe("mensalidade: baixa manual, isenção e resumo", () => {
  it("dá baixa com registro de quem deu, repete a Idempotency-Key e recusa a segunda baixa", async () => {
    const { f, ctx, subscribe } = await setup();
    const sub = await subscribe({ start_date: "2026-10-01", due_day: 5 });
    const other = await subscribe({
      start_date: "2026-11-01",
      customer_name: "Rui",
      phone: "11987650099",
      discount_cents: 5000,
    });
    await generate(ctx, brasilia(2026, 11, 4, 10));
    const [oct, nov, dec] = await installments(sub.id);
    expect([oct.status, nov.status, dec.status]).toEqual([
      "overdue",
      "open",
      "open",
    ]);
    const admin = await bearer(f.admin);
    const member = await bearer(f.member);
    expect(
      (
        await api(member, `${root(f)}/installments/${nov.id}/pay`, "POST", {
          note: "Dinheiro",
        })
      ).status,
    ).toBe(403);
    const key = "baixa-" + uid();
    const body = {
      note: "Pagou em dinheiro na secretaria",
      paid_at: "2026-11-14",
    };
    const first = await api(
      admin,
      `${root(f)}/installments/${nov.id}/pay`,
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const paid = await first.json<any>();
    expect(paid).toMatchObject({
      status: "paid",
      status_label: "Paga",
      paid_via: "manual",
      paid_by: f.admin.id,
      paid_note: "Pagou em dinheiro na secretaria",
      paid_at: Date.parse("2026-11-14T12:00:00-03:00"),
    });
    const replay = await api(
      admin,
      `${root(f)}/installments/${nov.id}/pay`,
      "POST",
      body,
      key,
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json<any>()).id).toBe(nov.id);
    const again = await api(
      admin,
      `${root(f)}/installments/${nov.id}/pay`,
      "POST",
      body,
    );
    expect(again.status).toBe(409);
    expect((await again.json<any>()).error.code).toBe(
      "installment_not_payable",
    );
    expect(await events(f, "mensalidade.paid")).toEqual([
      expect.objectContaining({
        installment_id: nov.id,
        via: "manual",
        by: f.admin.id,
      }),
    ]);

    const waived = await (
      await api(admin, `${root(f)}/installments/${oct.id}/waive`, "POST", {
        note: "Bolsa de outubro",
      })
    ).json<any>();
    expect(waived).toMatchObject({ status: "waived", waived_by: f.admin.id });
    // Data futura não vale.
    expect(
      (
        await api(admin, `${root(f)}/installments/${dec.id}/pay`, "POST", {
          paid_at: Date.now() + 86_400_000 * 3,
        })
      ).status,
    ).toBe(400);

    const month = await (
      await api(member, `${root(f)}/installments?month=2026-11`)
    ).json<any>();
    expect(month.data.map((i: any) => [i.customer.name, i.status])).toEqual([
      ["Lia", "paid"],
      ["Rui", "open"],
    ]);
    expect(month.counts).toEqual({ paid: 1, open: 1 });
    const filtered = await (
      await api(member, `${root(f)}/installments?month=2026-11&status=open`)
    ).json<any>();
    expect(filtered.data.map((i: any) => i.subscription_id)).toEqual([
      other.id,
    ]);
    const totals = await (
      await api(member, `${root(f)}/summary?month=2026-11`)
    ).json<any>();
    expect(totals).toMatchObject({
      month: "2026-11",
      expected_cents: 25000,
      received_cents: 15000,
      overdue_cents: 0,
      open_cents: 10000,
      waived_cents: 0,
      payments_ready: false,
    });
    expect(totals.counts).toMatchObject({ paid: 1, open: 1, overdue: 0 });
    const late = await (
      await api(member, `${root(f)}/delinquents`)
    ).json<any>();
    expect(late.data).toEqual([]);
    // Dezembro vence e entra na lista de inadimplentes.
    await generate(ctx, brasilia(2026, 12, 6));
    const after = await (
      await api(member, `${root(f)}/delinquents`)
    ).json<any>();
    expect(
      after.data.map((d: any) => [d.customer.name, d.overdue_count]),
    ).toEqual([
      ["Rui", 1],
      ["Lia", 1],
    ]);
    expect(after.data[0]).toMatchObject({
      overdue_cents: 10000,
      oldest_due_date: "2026-11-10",
    });
    expect(after.data[1]).toMatchObject({
      overdue_cents: 15000,
      oldest_due_date: "2026-12-05",
    });
  });

  it("gerar agora pelo painel usa o mesmo cálculo e não repete", async () => {
    const { f, subscribe } = await setup();
    const day = today(now());
    const sub = await subscribe({
      start_date: day,
      due_day: Number(day.slice(8)),
    });
    const admin = await bearer(f.admin);
    const first = await (
      await api(admin, `${root(f)}/generate`, "POST", {})
    ).json<any>();
    expect(first.created).toBeGreaterThanOrEqual(1);
    const second = await (
      await api(admin, `${root(f)}/generate`, "POST", {})
    ).json<any>();
    expect(second).toEqual({ created: 0, overdue: 0 });
    const [installment] = await installments(sub.id);
    expect(installment).toMatchObject({ due_date: day, status: "open" });
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_installments WHERE subscription_id=?",
        sub.id,
      ),
    ).toEqual({ n: first.created });
  });
});
