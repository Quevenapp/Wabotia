import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversation, perform } from "../src/service";
import { now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runDue } from "../src/modules/mensalidade/due";
import {
  createPlan,
  createSubscription,
} from "../src/modules/mensalidade/store";
import { addDays, today } from "../src/modules/mensalidade/model";
import { exec, one } from "../src/db";
import {
  application,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";
import { future, reservaSetup } from "./reserva-fixture";
import { botKey, tool, toolNames } from "./mcp-fixture";

// O bot está na conversa de "mine"; "other" é outro cliente da mesma área.
async function people(f: Fixture, a: string, b: string) {
  const talk = async (phone: string) => {
    const r = await receive(f, f.line, "oi", phone);
    await drain(f);
    return conversation(env, r.id, f.profile);
  };
  const token = await botKey(f);
  const mine = await talk(a);
  const other = await talk(b);
  expect(
    (await tool(token, "claim_conversation", { conversation_id: mine.id })).ok,
  ).toBe(true);
  return { token, mine, other };
}
const turnOn = (f: Fixture, id: string, enabled = true) =>
  perform(env, f.admin, f.profile, "module.set", { id, enabled }, uid());

describe("conferência N-8: leituras do bot sem dado pessoal, seja qual for o escopo", () => {
  it("mensalidade_situacao e reserva_minhas não trazem documento, telefones nem check-in", async () => {
    const s = await reservaSetup();
    const f = s.f;
    await turnOn(f, "mensalidade");
    const phone = "5511974449901";
    const r = await receive(f, f.line, "oi", phone);
    await drain(f);
    const c = await conversation(env, r.id, f.profile);
    // Chave com contacts:read (como o painel dava ao Hermes).
    const key = (
      await application(f, [
        "conversations:read",
        "conversations:write",
        "contacts:read",
        "notes:read",
      ])
    ).token;
    const ctx = modulesApi(env, f.profile, "mensalidade");
    const plan = await createPlan(
      ctx,
      { name: "Plano", amount_cents: 9900 },
      f.admin.id,
    );
    await createSubscription(
      ctx,
      {
        plan_id: plan.id,
        customer_name: "Cliente",
        phone,
        document: "529.982.247-25",
        start_date: today(now()),
      },
      f.admin.id,
    );
    const situation = await tool(key, "mensalidade_situacao", {
      conversation_id: c.id,
    });
    expect(situation.ok).toBe(true);
    const text = JSON.stringify(situation.data);
    expect(text).not.toContain("52998224725");
    expect(text).not.toContain("529.982.247-25");
    expect(text).not.toContain(phone);
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(15),
      nights: 1,
      conversation_id: c.id,
    });
    await exec(
      env,
      "UPDATE reserva_bookings SET checkin_answers=? WHERE id=?",
      JSON.stringify({ documento: "123.456.789-09" }),
      b.id,
    );
    const mine = await tool(key, "reserva_minhas", { conversation_id: c.id });
    expect(mine.ok).toBe(true);
    expect(JSON.stringify(mine.data)).not.toContain("123.456.789-09");
    expect(JSON.stringify(mine.data)).not.toContain(phone);
    expect(mine.data.data.map((x: any) => x.id)).toEqual([b.id]);
  });

  it("conferência N-13: mensalidade_situacao (GET) não revincula a assinatura", async () => {
    const f = await fixture();
    await turnOn(f, "mensalidade");
    const phone = "5511974449902";
    const r = await receive(f, f.line, "oi", phone);
    await drain(f);
    const c = await conversation(env, r.id, f.profile);
    const key = (await application(f, ["conversations:read"])).token;
    const ctx = modulesApi(env, f.profile, "mensalidade");
    const plan = await createPlan(
      ctx,
      { name: "Plano", amount_cents: 9900 },
      f.admin.id,
    );
    const sub = await createSubscription(
      ctx,
      {
        plan_id: plan.id,
        customer_name: "Cliente",
        phone,
        start_date: today(now()),
      },
      f.admin.id,
    );
    await runDue(ctx, now());
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET conversation_id=NULL WHERE id=?",
      sub.id,
    );
    const situation = await tool(key, "mensalidade_situacao", {
      conversation_id: c.id,
    });
    expect(situation.ok).toBe(true);
    // A leitura já casa pelo telefone…
    expect(situation.data.open).toHaveLength(1);
    // …e não grava a conversa na assinatura.
    const row = await one(
      env,
      "SELECT conversation_id FROM mensalidade_subscriptions WHERE id=?",
      sub.id,
    );
    expect(row.conversation_id).toBeNull();
  });
});

describe("ferramentas do bot: Reserva", () => {
  it("disponibilidade, reservar e minhas reservas só do cliente da conversa", async () => {
    const s = await reservaSetup();
    const { token, mine, other } = await people(
      s.f,
      "5511974440001",
      "5511974440002",
    );
    const start = future(12);
    const free = await tool(token, "reserva_disponibilidade", {
      start_date: start,
      nights: 2,
    });
    expect(free.ok).toBe(true);
    expect(JSON.stringify(free.data)).toContain(s.mar.id);

    const booked = await tool(token, "reserva_reservar", {
      conversation_id: mine.id,
      unit_id: s.mar.id,
      start_date: start,
      nights: 2,
      idempotency_key: "reserva-bot-1",
    });
    expect(booked.ok).toBe(true);
    expect(booked.data).toMatchObject({
      unit_id: s.mar.id,
      conversation_id: mine.id,
      source: "whatsapp",
    });
    const again = await tool(token, "reserva_reservar", {
      conversation_id: mine.id,
      unit_id: s.mar.id,
      start_date: start,
      nights: 2,
      idempotency_key: "reserva-bot-1",
    });
    expect(again.data.id).toBe(booked.data.id);

    // Reserva de outro cliente, feita pela equipe.
    await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: start,
      nights: 1,
      conversation_id: other.id,
    });
    const list = await tool(token, "reserva_minhas", {
      conversation_id: mine.id,
      phone: "5511974440002",
    });
    expect(list.data.data.map((b: any) => b.id)).toEqual([booked.data.id]);
  });
});

describe("ferramentas do bot: Ordem de Serviço", () => {
  it("situação das ordens só do cliente da conversa (inclusive as do balcão pelo telefone)", async () => {
    const f = await fixture();
    await turnOn(f, "os");
    const { token, mine, other } = await people(
      f,
      "5511975550001",
      "5511975550002",
    );
    const create = (data: any) =>
      perform(env, f.admin, f.profile, "os.create", data, uid());
    const own = await create({
      item: "Notebook",
      problem: "Não liga",
      conversation_id: mine.id,
    });
    const counter = await create({
      item: "Celular",
      problem: "Tela",
      phone: "5511975550001",
      customer_name: "Mesmo cliente",
    });
    await create({
      item: "Impressora",
      problem: "Papel",
      conversation_id: other.id,
    });
    const result = await tool(token, "os_situacao", {
      conversation_id: mine.id,
      phone: "5511975550002",
      q: "Impressora",
    });
    expect(result.ok).toBe(true);
    expect(result.data.data.map((o: any) => o.id).sort()).toEqual(
      [own.id, counter.id].sort(),
    );
    // Sem conversation_id a ferramenta recusa.
    expect((await tool(token, "os_situacao", {})).ok).toBe(false);
  });
});

describe("ferramentas do bot: Mensalidade", () => {
  it("situação e segunda via só do pagador da conversa", async () => {
    const f = await fixture();
    await turnOn(f, "mensalidade");
    const { token, mine, other } = await people(
      f,
      "5511976660001",
      "5511976660002",
    );
    const ctx = modulesApi(env, f.profile, "mensalidade");
    const plan = await createPlan(
      ctx,
      { name: "Suporte mensal", amount_cents: 9900 },
      f.admin.id,
    );
    const day = today(now());
    const due = addDays(day, 3);
    for (const [phone, name] of [
      ["5511976660001", "Cliente da conversa"],
      ["5511976660002", "Outro cliente"],
    ])
      await createSubscription(
        ctx,
        {
          plan_id: plan.id,
          customer_name: name,
          phone,
          start_date: day,
          due_day: Number(due.slice(8)),
        },
        f.admin.id,
      );
    await runDue(ctx, now());
    const mineSituation = await tool(token, "mensalidade_situacao", {
      conversation_id: mine.id,
      document: "52998224725",
    });
    expect(mineSituation.ok).toBe(true);
    expect(mineSituation.data.situation.status).toBe("em_dia");
    expect(mineSituation.data.open).toHaveLength(1);
    const theirs = await tool(token, "mensalidade_situacao", {
      conversation_id: other.id,
    });
    const theirInstallment = theirs.data.open[0].id;
    // Segunda via de mensalidade de outro cliente pela conversa do bot: 404.
    const steal = await tool(token, "mensalidade_segunda_via", {
      conversation_id: mine.id,
      installment_id: theirInstallment,
    });
    expect(steal.ok).toBe(false);
    expect(steal.error).toMatch(/404/);
    // A do próprio cliente chega até a Cobrança (aqui não configurada).
    const own = await tool(token, "mensalidade_segunda_via", {
      conversation_id: mine.id,
    });
    expect(own.ok).toBe(false);
    expect(own.error).toMatch(/payments_not_configured/);
    // Módulo desligado: as ferramentas somem.
    await turnOn(f, "mensalidade", false);
    const names = await toolNames(token);
    expect(names.some((n) => n.startsWith("mensalidade_"))).toBe(false);
  });
});
