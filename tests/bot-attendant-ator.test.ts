// Ator do motor de atendimento (revisão A do PLANO-BOTS): até a 0.21.0 era
// `bot:attendant` com kind "user" e role "admin". Agora é aplicação sem
// privilégio, presa ao bot da execução, e não alcança operação, módulo, rota
// interna nem ERP (tripwire). A proposta do cliente confirmada roda presa à
// conversa (conversations:bound) mesmo depois da janela da execução.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, createRun, perform } from "../src/service";
import { internalCall } from "../src/mcp";
import { erpIdentity } from "../src/modules/erp/identity";
import {
  admin,
  canProfile,
  ENGINE_ACTOR_ID,
  engineActor,
} from "../src/security";
import { now, uid } from "../src/types";
import { newToolState } from "../src/bot-actions/actions";
import {
  customerToolContext,
  runCustomerTool,
} from "../src/bot-actions/customer";
import { agendaSetup, at, future } from "./agenda-fixture";
import {
  bot,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

const TRIPWIRE = /bot:attendant/;

describe("ator do motor de atendimento", () => {
  it("é aplicação sem privilégio, presa à área e ao bot da execução", async () => {
    const actor = engineActor("area-1", "bot-1");
    expect(actor).toMatchObject({
      id: ENGINE_ACTOR_ID,
      kind: "app",
      role: "service",
      profiles: ["area-1"],
      scopes: ["bots:invoke"],
      bots: ["bot-1"],
    });
    expect(() => admin(actor)).toThrow();
    expect(canProfile(actor, "area-1")).toBe(true);
    expect(canProfile(actor, "area-2")).toBe(false);
  });

  it("tripwire: não executa operação, rota interna, contexto de módulo nem ERP", async () => {
    const f = await fixture();
    const actor = engineActor(f.profile, "bot-1");
    await expect(
      perform(env, actor, f.profile, "settings", {}, uid()),
    ).rejects.toThrow(TRIPWIRE);
    await expect(
      internalCall(env, actor, {
        method: "GET",
        path: `/profiles/${f.profile}/conversations`,
      }),
    ).rejects.toThrow(TRIPWIRE);
    await expect(erpIdentity(env, actor, f.profile, "GET")).rejects.toThrow(
      TRIPWIRE,
    );
    // Mesmo que alguém monte à mão o ator antigo (administrador) com o id do
    // motor, as portas recusam pelo id.
    const old = { ...actor, kind: "user" as const, role: "admin" as const };
    await expect(
      perform(env, old, f.profile, "settings", {}, uid()),
    ).rejects.toThrow(TRIPWIRE);
  });

  it("cria a execução em toda conversa da área, inclusive a aberta por aplicação; outra aplicação não", async () => {
    const f = await fixture();
    const botId = await bot(f);
    const c = await receive(f, f.line, "oi", "5511933330001");
    await drain(f);
    // Conversa de outra aplicação: a visibilidade de aplicação a esconde, mas
    // o motor processa a caixa de entrada da própria área.
    await exec(
      env,
      "UPDATE conversations SET external_namespace='app:outra-aplicacao' WHERE id=?",
      c.id,
    );
    const run = await createRun(
      env,
      engineActor(f.profile, botId),
      f.profile,
      { bot_id: botId, input: "oi" },
      { conversation_id: c.id, phase: "attendant", epoch: c.epoch },
    );
    expect(run.status).toBe("queued");
    expect(
      (await one(env, "SELECT actor FROM bot_runs WHERE id=?", run.id)).actor,
    ).toBe(ENGINE_ACTOR_ID);
    // Uma aplicação comum com o mesmo bot e o mesmo escopo não alcança.
    await expect(
      createRun(
        env,
        { ...engineActor(f.profile, botId), id: "app:" + uid() },
        f.profile,
        { bot_id: botId, input: "oi" },
        { conversation_id: c.id, phase: "attendant", epoch: c.epoch },
      ),
    ).rejects.toMatchObject({ status: 404 });
    // E o ator do motor só alcança o bot da execução.
    const other = await bot(f);
    await expect(
      createRun(
        env,
        engineActor(f.profile, botId),
        f.profile,
        { bot_id: other, input: "oi" },
        { conversation_id: c.id, phase: "attendant", epoch: c.epoch },
      ),
    ).rejects.toMatchObject({ status: 403, code: "bot_not_allowed" });
  });
});

async function customerRun(f: Fixture, botId: string, phone: string) {
  const c = await receive(f, f.line, "oi", phone);
  await drain(f);
  await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
  const id = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,?,?,?, 'running',?, 'attendant','{}',?,?)",
    id,
    f.profile,
    botId,
    ENGINE_ACTOR_ID,
    c.id,
    c.epoch,
    "{}",
    now(),
    now(),
  );
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", id);
  return { c: await conversation(env, c.id, f.profile), run };
}

describe("proposta do cliente confirmada, presa à conversa", () => {
  it("confirmada depois da janela da execução (2 min), roda presa à conversa da proposta", async () => {
    const s = await agendaSetup();
    const botId = await bot(s.f);
    const phone = "5511944440001";
    const a = await customerRun(s.f, botId, phone);
    const ctx = (await customerToolContext(env, a.run))!;
    const proposed = JSON.parse(
      await runCustomerTool(ctx, newToolState(), "agenda_agendar", {
        service_id: s.corte.id,
        starts: at(future(), "10:00"),
        resumo: "Agendar",
      }),
    );
    // A execução terminou há 5 minutos: a chave presa não alcança mais a
    // conversa pela execução, só pela proposta que está rodando.
    await exec(
      env,
      "UPDATE bot_runs SET status='completed',updated=? WHERE id=?",
      now() - 5 * 60000,
      a.run.id,
    );
    await receive(s.f, s.f.line, "Confirmar", phone, {
      interactive_reply_id: `botacao:sim:${proposed.proposta}`,
    });
    await drain(s.f);
    expect(
      await one(
        env,
        "SELECT status,error FROM bot_proposals WHERE id=?",
        proposed.proposta,
      ),
    ).toMatchObject({ status: "done", error: null });
    const appointments = await all(
      env,
      "SELECT conversation_id FROM agenda_appointments WHERE profile_id=?",
      s.f.profile,
    );
    expect(appointments).toEqual([{ conversation_id: a.c.id }]);
  });
});
