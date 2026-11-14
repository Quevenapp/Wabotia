import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { exec, one } from "../src/db";
import { removeConnection } from "../src/connection-removal";
import { secret, setSecret } from "../src/security";
import { type Actor, defaults, json, now, uid } from "../src/types";

const admin: Actor = {
  id: "bot-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};

/** Área com uma linha WhatsApp e uma conexão de bots pausada, com um bot. */
async function fixture(kind: "ai" | "hermes" = "ai", settings: any = {}) {
  const profile = uid(),
    id = uid(),
    line = uid(),
    bot = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Bots",
    JSON.stringify({ ...defaults, ...settings }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    line,
    profile,
    "Linha principal",
    JSON.stringify({ number: "5511999990000" }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct','paused',?,?)",
    id,
    profile,
    "Bia",
    kind,
    JSON.stringify(
      kind === "ai"
        ? { provider: "openai", model: "gpt-test", verified_at: now() }
        : { transport: "link" },
    ),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bia',1)",
    bot,
    profile,
    id,
  );
  await setSecret(env, `connection:${id}`, { api_key: "sk-test-123456" });
  return { profile, id, line, bot };
}
async function conversation(f: { profile: string; line: string }, state: string, bot: string) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated,epoch,assigned_bot_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)",
    id,
    f.profile,
    f.line,
    `channel:${f.line}`,
    id,
    "5511888880000",
    state,
    uid(),
    now(),
    now(),
    now(),
    bot,
  );
  return id;
}
async function run(f: { profile: string; bot: string }, status: string) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,status,input,created,updated) VALUES(?,?,?,?,?,?,?,?)",
    id,
    f.profile,
    f.bot,
    "system",
    status,
    "Oi",
    now(),
    now(),
  );
  return id;
}

it("exige a conexão pausada", async () => {
  const f = await fixture();
  await exec(env, "UPDATE connections SET status='active' WHERE id=?", f.id);
  await expect(removeConnection(env, admin, f.profile, f.id)).rejects.toThrow(
    "Pause a conexão antes de excluir.",
  );
});

it("recusa enquanto o bot atende e diz onde trocar", async () => {
  const f = await fixture("ai");
  await exec(
    env,
    "UPDATE profiles SET settings=? WHERE id=?",
    JSON.stringify({
      ...defaults,
      attendant_bot: f.bot,
      capabilities: [{ id: "c1", name: "Boleto", bot_id: f.bot }],
      menus: [{ id: "m1", label: "Financeiro", type: "bot", bot_id: f.bot }],
    }),
    f.profile,
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({
      number: "5511999990000",
      service: { mode: "bot", bot_id: f.bot },
    }),
    f.line,
  );
  const error: any = await removeConnection(env, admin, f.profile, f.id).catch(
    (e) => e,
  );
  expect(error).toMatchObject({ status: 409, code: "connection_in_use" });
  expect(error.message).toContain("Bia é o Bot Atendente");
  expect(error.message).toContain('especialista da ação "Boleto"');
  expect(error.message).toContain('item de menu "Financeiro"');
  expect(error.message).toContain("atende a linha Linha principal");
  expect(await one(env, "SELECT id FROM connections WHERE id=?", f.id)).toBeTruthy();
});

it("recusa com conversa em atendimento pelo bot ou execução em andamento", async () => {
  const f = await fixture("ai");
  const open = await conversation(f, "ai", f.bot);
  await expect(removeConnection(env, admin, f.profile, f.id)).rejects.toMatchObject({
    status: 409,
    code: "connection_in_use",
  });
  await exec(env, "UPDATE conversations SET state='closed' WHERE id=?", open);
  const running = await run(f, "running");
  await expect(removeConnection(env, admin, f.profile, f.id)).rejects.toMatchObject({
    status: 409,
    code: "connection_busy",
  });
  await exec(env, "UPDATE bot_runs SET status='completed' WHERE id=?", running);
});

for (const kind of ["ai", "hermes"] as const)
  it(`exclui a conexão ${kind}, os bots e a chave, preservando o histórico`, async () => {
    const f = await fixture(kind);
    const closed = await conversation(f, "closed", f.bot);
    const queued = await run(f, "queued");
    const done = await run(f, "completed");
    const appId = uid(),
      otherBot = uid();
    await exec(
      env,
      "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
      appId,
      "Vinki",
      JSON.stringify([f.profile]),
      JSON.stringify(["bots:invoke"]),
      JSON.stringify([f.bot, otherBot]),
      now(),
    );
    await exec(
      env,
      "INSERT INTO team_connection_presence(connection_id,checked_at,online) VALUES(?,?,1)",
      f.id,
      now(),
    );
    const result: any = await removeConnection(env, admin, f.profile, f.id);
    expect(result).toEqual({ id: f.id, deleted: true, bots_removed: 1 });
    expect(await one(env, "SELECT id FROM connections WHERE id=?", f.id)).toBeNull();
    expect(await one(env, "SELECT id FROM bots WHERE id=?", f.bot)).toBeNull();
    expect(await secret(env, `connection:${f.id}`)).toEqual({});
    expect(
      await one(env, "SELECT * FROM team_connection_presence WHERE connection_id=?", f.id),
    ).toBeNull();
    expect((await one(env, "SELECT status FROM bot_runs WHERE id=?", queued)).status).toBe(
      "cancelled",
    );
    expect((await one(env, "SELECT status FROM bot_runs WHERE id=?", done)).status).toBe(
      "completed",
    );
    const kept = await one(env, "SELECT * FROM conversations WHERE id=?", closed);
    expect(kept.assigned_bot_id).toBeNull();
    expect(
      json((await one(env, "SELECT bots FROM applications WHERE id=?", appId)).bots),
    ).toEqual([otherBot]);
    // A linha de telefone não é afetada.
    expect(await one(env, "SELECT id FROM connections WHERE id=?", f.line)).toBeTruthy();
  });
