// Retirada do Hermes, passo 1: a atualização de uma instalação que tem Hermes
// (migração 0092_retira_hermes.sql) não quebra nada. Conexões pausadas e
// marcadas, bots desligados, Atendente vago, linha de volta à regra da área,
// ações de especialista desligadas, conversa sem bot; o resto não muda.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { defaults, json, now, uid } from "../src/types";
import migration from "../migrations/0092_retira_hermes.sql?raw";

/** Aplica o SQL da migração como o D1 aplicaria (instrução por instrução). */
async function migrate() {
  const statements = migration
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  for (const sql of statements) await env.DB.prepare(sql).run();
  return statements.length;
}

async function area() {
  const profile = uid(),
    hermes = uid(),
    hermesBot = uid(),
    ai = uid(),
    aiBot = uid(),
    line = uid(),
    lineAi = uid(),
    whatsapp = uid(),
    conversation = uid(),
    other = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Área com Hermes",
    JSON.stringify({
      ...defaults,
      attendant_bot: hermesBot,
      capabilities: [
        { id: "boleto", bot_id: hermesBot, condition: "x", instructions: "y", enabled: true },
        { id: "agenda", bot_id: aiBot, condition: "x", instructions: "y", enabled: true },
      ],
    }),
    now(),
  );
  const connection = (id: string, kind: string, config: any, status = "active") =>
    exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct',?,?,?)",
      id,
      profile,
      kind === "hermes" ? "Hermes local" : kind === "hermes-whatsapp" ? "WhatsApp pelo Hermes" : kind === "ai" ? "Bia" : "Linha " + id.slice(0, 4),
      kind,
      status,
      JSON.stringify(config),
      now(),
    );
  await connection(hermes, "hermes", { api_url: "https://hermes.example.com" });
  await connection(ai, "ai", { provider: "anthropic", model: "claude-haiku-5-5" });
  await connection(line, "zernio", { number: "5511999990001", service: { mode: "bot", bot_id: hermesBot, menu_mode: "manual" } });
  await connection(lineAi, "zernio", { number: "5511999990002", service: { mode: "bot", bot_id: aiBot, menu_mode: "manual" } });
  await connection(whatsapp, "hermes-whatsapp", { platform: "whatsapp" });
  const bot = (id: string, conn: string) =>
    exec(env, "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bot',1)", id, profile, conn);
  await bot(hermesBot, hermes);
  await bot(aiBot, ai);
  const convo = (id: string, assigned: string) =>
    exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,assigned_bot_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      profile,
      line,
      `channel:${line}`,
      id,
      "5511888880000",
      "ai",
      uid(),
      now(),
      assigned,
      now(),
      now(),
    );
  await convo(conversation, hermesBot);
  await convo(other, aiBot);
  // Aplicação do perfil Hermes (bots do Hermes) e uma integração comum.
  const app = (id: string, bots: string[]) =>
    exec(
      env,
      "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,'[]',?,?)",
      id,
      "App " + id.slice(0, 4),
      JSON.stringify([profile]),
      JSON.stringify(bots),
      now(),
    );
  const key = (id: string, appId: string) =>
    exec(env, "INSERT INTO api_keys(id,app_id,hash,prefix,expires,revoked,created) VALUES(?,?,?,'wb_',?,0,?)", id, appId, uid(), now() + 86400000, now());
  const hermesApp = uid(),
    otherApp = uid(),
    hermesKey = uid(),
    otherKey = uid();
  await app(hermesApp, [hermesBot]);
  await app(otherApp, [aiBot]);
  await key(hermesKey, hermesApp);
  await key(otherKey, otherApp);
  return { profile, hermes, hermesBot, ai, aiBot, line, lineAi, whatsapp, conversation, other, hermesKey, otherKey };
}

describe("retirada do Hermes: atualização de uma instalação com Hermes", () => {
  it("pausa e marca as conexões, desliga os bots, esvazia o Atendente, devolve a linha à área e desliga as ações de especialista", async () => {
    const f = await area();
    expect(await migrate()).toBe(7);
    // Chave da aplicação do perfil Hermes revogada; a da integração comum, não.
    const revoked = async (id: string) => (await one(env, "SELECT revoked FROM api_keys WHERE id=?", id)).revoked;
    expect(await revoked(f.hermesKey)).toBe(1);
    expect(await revoked(f.otherKey)).toBe(0);
    const conn = async (id: string) => await one(env, "SELECT status,config FROM connections WHERE id=?", id);
    // Conexões do Hermes: pausadas e marcadas (o cartão do painel lê "retired").
    for (const id of [f.hermes, f.whatsapp]) {
      const row = await conn(id);
      expect(row.status).toBe("paused");
      expect(json(row.config).retired).toBe(1);
    }
    expect((await one(env, "SELECT enabled FROM bots WHERE id=?", f.hermesBot)).enabled).toBe(0);
    // Linha que usava o bot do Hermes: regra da área.
    expect(json((await conn(f.line)).config).service).toEqual({ mode: "inherit", bot_id: null, menu_mode: "manual" });
    // Atendente vago; ações de especialista do Hermes desligadas, as outras iguais.
    const settings = json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile)).settings);
    expect(settings.attendant_bot).toBeUndefined();
    expect(settings.capabilities.map((c: any) => [c.id, c.enabled])).toEqual([
      ["boleto", false],
      ["agenda", true],
    ]);
    expect((await one(env, "SELECT assigned_bot_id FROM conversations WHERE id=?", f.conversation)).assigned_bot_id).toBeNull();
    // O que não é Hermes não muda.
    expect((await conn(f.ai)).status).toBe("active");
    expect(json((await conn(f.ai)).config).retired).toBeUndefined();
    expect((await one(env, "SELECT enabled FROM bots WHERE id=?", f.aiBot)).enabled).toBe(1);
    expect(json((await conn(f.lineAi)).config).service).toMatchObject({ mode: "bot", bot_id: f.aiBot });
    expect((await one(env, "SELECT assigned_bot_id FROM conversations WHERE id=?", f.other)).assigned_bot_id).toBe(f.aiBot);
    // Rodar de novo não muda nada (a migração é aplicada uma vez, mas não quebra se repetida).
    await migrate();
    expect(json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile)).settings).capabilities).toEqual(settings.capabilities);
  });
});
