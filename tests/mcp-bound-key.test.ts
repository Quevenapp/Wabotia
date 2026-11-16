// Conferência A1 (resíduo alto): a chave do Hermes alcançava a conversa de
// qualquer cliente da área. Com injeção de prompt, o bot achava a vítima por
// list_conversations, lia os dados dela e cancelava o agendamento. Com
// conversations:bound, a chave só alcança a conversa que o bot atende agora.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { agendaSetup, at, future } from "./agenda-fixture";
import {
  api,
  application,
  bearer,
  bot,
  receive,
} from "./service-center-fixture";
import { mcp, tool } from "./mcp-fixture";

const BOUND = [
  "conversations:read",
  "conversations:write",
  "conversations:bound",
  "contacts:read",
  "tickets:read",
  "tickets:write",
];

async function setup() {
  const s = await agendaSetup();
  const botId = await bot(s.f);
  const app = await application(s.f, BOUND);
  await exec(
    env,
    "UPDATE applications SET bots=? WHERE id=?",
    JSON.stringify([botId]),
    app.id,
  );
  const victim = await receive(s.f, s.f.line, "oi", "5511974440101");
  const served = await receive(s.f, s.f.line, "oi", "5511974440102");
  const a = await s.run("agenda.book", {
    service_id: s.corte.id,
    professional_id: s.ana.id,
    starts: at(future(4), "10:00"),
    conversation_id: victim.id,
  });
  // O bot está atendendo só a conversa `served`.
  const run = (conversationId: string, status = "running") =>
    exec(
      env,
      "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,created,updated) VALUES(?,?,?,?,?,0,?,'{}',?,?)",
      uid(),
      s.f.profile,
      botId,
      "system",
      conversationId,
      status,
      now(),
      now(),
    );
  await run(served.id);
  return { s, app, victim, served, a, run };
}

describe("chave do bot presa à conversa em atendimento (conferência A1)", () => {
  it("não acha, não lê e não cancela nada de outro cliente", async () => {
    const { s, app, victim, a } = await setup();
    const p = s.f.profile;
    // Listas da área: fora.
    expect(
      (await tool(app.token, "list_conversations", { profile: p })).error,
    ).toMatch(/desconhecida/);
    for (const path of [
      `/profiles/${p}/conversations?q=5511974440101`,
      `/profiles/${p}/contacts`,
      `/profiles/${p}/events`,
      `/profiles/${p}/tickets`,
      `/profiles/${p}/agenda/appointments`,
    ])
      expect((await api(app.token, path)).status, path).toBe(403);
    // Conversa da vítima: como se não existisse.
    expect(
      (
        await tool(app.token, "get_conversation", {
          profile: p,
          conversation_id: victim.id,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await tool(app.token, "agenda_meus_agendamentos", {
          profile: p,
          conversation_id: victim.id,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await tool(app.token, "agenda_cancelar", {
          profile: p,
          conversation_id: victim.id,
          appointment_id: a.id,
          idempotency_key: uid(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await tool(app.token, "claim_conversation", {
          profile: p,
          conversation_id: victim.id,
          idempotency_key: uid(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await one(
          env,
          "SELECT status FROM agenda_appointments WHERE id=?",
          a.id,
        )
      ).status,
    ).toBe("booked");
  });

  it("atende normalmente a conversa em que o bot está", async () => {
    const { s, app, victim, served, run } = await setup();
    const p = s.f.profile;
    const got = await tool(app.token, "get_conversation", {
      profile: p,
      conversation_id: served.id,
    });
    expect(got.ok).toBe(true);
    expect(
      (
        await tool(app.token, "agenda_meus_agendamentos", {
          profile: p,
          conversation_id: served.id,
        })
      ).ok,
    ).toBe(true);
    // Quando o bot passar a atender a vítima, aí sim (é a conversa dele).
    await run(victim.id);
    expect(
      (
        await tool(app.token, "get_conversation", {
          profile: p,
          conversation_id: victim.id,
        })
      ).ok,
    ).toBe(true);
    // A lista de ferramentas mostra só as de atendimento.
    const names = (await mcp(app.token, "tools/list")).result.tools.map(
      (t: any) => t.name,
    );
    expect(names).toContain("reply_conversation");
    expect(names).toContain("agenda_meus_agendamentos");
    expect(names).not.toContain("list_conversations");
    expect(names).not.toContain("list_contacts");
    expect(names).not.toContain("list_events");
  });

  it("segunda conferência A1: chave antiga de bot é avisada e presa com um toque", async () => {
    const { s, victim } = await setup();
    // Chave do painel antigo: bots marcados e sem conversations:bound.
    const old = await application(s.f, [
      "conversations:read",
      "conversations:write",
      "contacts:read",
    ]);
    await exec(
      env,
      "UPDATE applications SET bots=(SELECT bots FROM applications WHERE id<>? AND bots<>'[]' LIMIT 1) WHERE id=?",
      old.id,
      old.id,
    );
    // Integração comum (sem bots) e área inteira escolhida: sem aviso.
    const plain = await application(s.f, ["conversations:read"]);
    const chosen = await application(s.f, [
      "conversations:read",
      "conversations:all",
    ]);
    await exec(
      env,
      "UPDATE applications SET bots=(SELECT bots FROM applications WHERE id=?) WHERE id=?",
      old.id,
      chosen.id,
    );
    const admin = await bearer(s.f.admin);
    const pending = async () =>
      (await (await api(admin, "/applications")).json<any>()).applications
        .filter((a: any) => a.whole_area_pending)
        .map((a: any) => a.id);
    expect(await pending()).toEqual([old.id]);
    expect(await pending()).not.toContain(plain.id);
    // Antes: a chave antiga ainda lê a conversa de outro cliente.
    const p = s.f.profile;
    expect(
      (await api(old.token, `/profiles/${p}/conversations/${victim.id}`))
        .status,
    ).toBe(200);
    // "Prender às conversas do bot": a mesma chave passa a ser restrita.
    const scopes = JSON.parse(
      (await one(env, "SELECT scopes FROM applications WHERE id=?", old.id))
        .scopes,
    );
    const saved = await api(admin, `/applications/${old.id}`, "PATCH", {
      scopes: [...scopes, "conversations:bound"],
    });
    expect(saved.status).toBe(200);
    expect(await pending()).toEqual([]);
    expect(
      (await api(old.token, `/profiles/${p}/conversations/${victim.id}`))
        .status,
    ).toBe(404);
  });

  it("execução encerrada há mais de 2 minutos não vale mais", async () => {
    const { s, app, victim } = await setup();
    await exec(
      env,
      "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,created,updated) SELECT ?,?,bot_id,'system',?,0,'completed','{}',?,? FROM bot_runs WHERE profile_id=? LIMIT 1",
      uid(),
      s.f.profile,
      victim.id,
      now() - 600_000,
      now() - 600_000,
      s.f.profile,
    );
    expect(
      (
        await tool(app.token, "get_conversation", {
          profile: s.f.profile,
          conversation_id: victim.id,
        })
      ).ok,
    ).toBe(false);
  });
});
