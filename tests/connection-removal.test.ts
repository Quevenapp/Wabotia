import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { removeConnection } from "../src/connection-removal";
import { secret, setSecret } from "../src/security";
import { type Actor, defaults, json, now, uid } from "../src/types";
import { enqueue } from "../src/service";

const admin: Actor = {
  id: "phone-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};

async function fixture(kind = "zernio") {
  const profile = uid(),
    id = uid(),
    conversation = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Telefones",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct','active',?,?)",
    id,
    profile,
    "Telefone",
    kind,
    JSON.stringify({ number: "5511999998888", verified_at: now() }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated,recipient_id,epoch) VALUES(?,?,?,?,'5511888887777','5511888887777','ai',?,?,?,?,?,4)",
    conversation,
    profile,
    id,
    `channel:${id}`,
    uid(),
    now(),
    now(),
    now(),
    "5511888887777",
  );
  await setSecret(env, `connection:${id}`, {
    api_key: "secret-test-key",
    connector_hash: "test-hash",
  });
  return { profile, id, conversation };
}

it("exclui o telefone local e as credenciais, preservando conversas, mensagens e protocolos", async () => {
  const f = await fixture();
  const message = uid(),
    ticket = uid(),
    delivery = uid(),
    incoming = uid(),
    run = uid();
  await exec(
    env,
    "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?)",
    f.id,
    "5511888887777",
    "remote-conversation",
  );
  await exec(
    env,
    "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'inbound','customer','Histórico do cliente',?)",
    message,
    f.profile,
    f.conversation,
    now(),
  );
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,created,updated) VALUES(?,?,?,?,?,?,?)",
    ticket,
    uid(),
    f.profile,
    f.conversation,
    "Protocolo preservado",
    now(),
    now(),
  );
  await exec(
    env,
    "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system','{}','sent',?,?,?)",
    delivery,
    f.profile,
    f.id,
    f.conversation,
    uid(),
    now(),
    now(),
  );
  await exec(
    env,
    "INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
    incoming,
    f.profile,
    uid(),
    f.conversation,
    "{}",
    now(),
  );
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,input,created,updated) VALUES(?,?,?,'system',?,'Teste',?,?)",
    run,
    f.profile,
    uid(),
    f.conversation,
    now(),
    now(),
  );

  expect(await removeConnection(env, admin, f.profile, f.id)).toEqual({
    id: f.id,
    deleted: true,
    conversations_preserved: 1,
  });
  expect(
    await one(env, "SELECT id FROM connections WHERE id=?", f.id),
  ).toBeNull();
  expect(await secret(env, `connection:${f.id}`)).toEqual({});
  expect(
    await one(env, "SELECT * FROM conversations WHERE id=?", f.conversation),
  ).toMatchObject({
    connection_id: null,
    state: "closed",
    epoch: 5,
    phone: "5511888887777",
  });
  expect(
    await one(env, "SELECT text FROM messages WHERE id=?", message),
  ).toEqual({ text: "Histórico do cliente" });
  expect(
    await one(env, "SELECT title,status FROM tickets WHERE id=?", ticket),
  ).toEqual({ title: "Protocolo preservado", status: "open" });
  expect(
    await one(env, "SELECT status FROM outbox WHERE id=?", delivery),
  ).toEqual({ status: "sent" });
  expect(
    await one(env, "SELECT status FROM inbox WHERE id=?", incoming),
  ).toEqual({ status: "done" });
  expect(await one(env, "SELECT status FROM bot_runs WHERE id=?", run)).toEqual(
    { status: "cancelled" },
  );
  expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  expect(
    await one(
      env,
      "SELECT connection_id FROM zernio_conversations WHERE connection_id=?",
      f.id,
    ),
  ).toBeNull();
  const archived = await one(
    env,
    "SELECT * FROM conversations WHERE id=?",
    f.conversation,
  );
  await expect(
    enqueue(env, archived, admin.id, "text", { text: "Não enviar" }, uid()),
  ).rejects.toMatchObject({ status: 410, code: "connection_removed" });
  // App-routed history cannot fall back to a successful local-only delivery.
  await expect(
    enqueue(
      env,
      { ...archived, external_namespace: "app:external" },
      admin.id,
      "text",
      { text: "Não enviar" },
      uid(),
    ),
  ).rejects.toMatchObject({ status: 410, code: "connection_removed" });
});

it("limpa roteador, autorizações, listas de bots e menus sem ampliar permissões", async () => {
  const f = await fixture("meta");
  const account = uid(),
    pool = uid(),
    untouchedPool = uid(),
    app = uid(),
    bot = uid(),
    allLinesBot = uid(),
    hermes = uid();
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,created) VALUES(?,?,'Conta',?,?)",
    account,
    f.profile,
    uid(),
    now(),
  );
  await setSecret(env, `meta-account:${account}`, {
    token: "shared-account-secret",
  });
  await exec(
    env,
    "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',?)",
    f.id,
    account,
    uid(),
    now(),
  );
  for (const poolId of [pool, untouchedPool])
    await exec(
      env,
      "INSERT INTO number_pools(id,profile_id,account_id,name,enabled,public_token,created) VALUES(?,?,?,'Grupo',1,?,?)",
      poolId,
      f.profile,
      account,
      uid(),
      now(),
    );
  await exec(
    env,
    "INSERT INTO number_pool_members(pool_id,connection_id) VALUES(?,?)",
    pool,
    f.id,
  );
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Teste','[]','[]','[]',?)",
    app,
    now(),
  );
  await exec(
    env,
    "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id) VALUES(?,?,'number',?)",
    app,
    f.profile,
    f.id,
  );
  await exec(
    env,
    "INSERT INTO router_affinities(profile_id,actor,external_id,source_type,source_id,conversation_id,connection_id,recipient,created) VALUES(?,?,'teste','number',?,?,?,'5511888887777',?)",
    f.profile,
    `app:${app}`,
    f.id,
    f.conversation,
    f.id,
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,created) VALUES(?,?,'Hermes','hermes','direct',?)",
    hermes,
    f.profile,
    now(),
  );
  for (const [botId, lineIds] of [
    [bot, JSON.stringify([f.id])],
    [allLinesBot, null],
  ])
    await exec(
      env,
      "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled,line_ids) VALUES(?,?,?,?,?,1,?)",
      botId,
      f.profile,
      hermes,
      botId,
      "Especialista",
      lineIds,
    );
  await exec(
    env,
    "UPDATE profiles SET settings=? WHERE id=?",
    JSON.stringify({
      ...defaults,
      menus: [
        { id: "specific", enabled: true, line_ids: [f.id] },
        { id: "shared", enabled: true, line_ids: [f.id, "another-line"] },
        { id: "global", enabled: true, line_ids: [] },
      ],
    }),
    f.profile,
  );

  await removeConnection(env, admin, f.profile, f.id);
  expect(
    await one(
      env,
      "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
      f.id,
    ),
  ).toBeNull();
  expect(
    await one(
      env,
      "SELECT connection_id FROM number_pool_members WHERE connection_id=?",
      f.id,
    ),
  ).toBeNull();
  expect(
    await one(
      env,
      "SELECT source_id FROM number_router_grants WHERE source_id=?",
      f.id,
    ),
  ).toBeNull();
  expect(
    await one(
      env,
      "SELECT connection_id FROM router_affinities WHERE connection_id=?",
      f.id,
    ),
  ).toBeNull();
  expect(
    await one(
      env,
      "SELECT enabled,public_token FROM number_pools WHERE id=?",
      pool,
    ),
  ).toEqual({ enabled: 0, public_token: null });
  expect(
    (
      await one(
        env,
        "SELECT enabled FROM number_pools WHERE id=?",
        untouchedPool,
      )
    ).enabled,
  ).toBe(1);
  expect(await secret(env, `meta-account:${account}`)).toEqual({
    token: "shared-account-secret",
  });
  expect(
    (await one(env, "SELECT line_ids FROM bots WHERE id=?", bot)).line_ids,
  ).toBe("[]");
  expect(
    (await one(env, "SELECT line_ids FROM bots WHERE id=?", allLinesBot))
      .line_ids,
  ).toBeNull();
  expect(
    json(
      (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
        .settings,
    ).menus,
  ).toEqual([
    { id: "specific", enabled: false, line_ids: [] },
    { id: "shared", enabled: true, line_ids: ["another-line"] },
    { id: "global", enabled: true, line_ids: [] },
  ]);
});

it("cancela a fila não enviada no mesmo passo e preserva os registros de outras linhas", async () => {
  const f = await fixture("qr"),
    other = await fixture("qr");
  const queued = uid(),
    group = uid(),
    sent = uid(),
    otherQueued = uid(),
    otherGroup = uid();
  for (const [id, line, status] of [
    [queued, f, "pending"],
    [sent, f, "sent"],
    [otherQueued, other, "pending"],
  ] as const)
    await exec(
      env,
      "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system','{}',?,?,?,?)",
      id,
      line.profile,
      line.id,
      line.conversation,
      status,
      uid(),
      now(),
      now(),
    );
  for (const [id, line] of [
    [group, f],
    [otherGroup, other],
  ] as const)
    await exec(
      env,
      "INSERT INTO group_operations(id,profile_id,connection_id,conversation_id,actor,operation,payload,status,created,updated) VALUES(?,?,?,?,'system','create','{}','pending',?,?)",
      id,
      line.profile,
      line.id,
      line.conversation,
      now(),
      now(),
    );

  await removeConnection(env, admin, f.profile, f.id);
  expect(
    await one(
      env,
      "SELECT status,error,conversation_id FROM outbox WHERE id=?",
      queued,
    ),
  ).toEqual({
    status: "cancelled",
    error: "Telefone excluído antes do envio.",
    conversation_id: f.conversation,
  });
  expect(
    await one(
      env,
      "SELECT status,error,conversation_id FROM group_operations WHERE id=?",
      group,
    ),
  ).toEqual({
    status: "cancelled",
    error: "Telefone excluído antes da execução.",
    conversation_id: f.conversation,
  });
  expect(await one(env, "SELECT status FROM outbox WHERE id=?", sent)).toEqual({
    status: "sent",
  });
  expect(
    await one(env, "SELECT status FROM outbox WHERE id=?", otherQueued),
  ).toEqual({ status: "pending" });
  expect(
    await one(
      env,
      "SELECT status FROM group_operations WHERE id=?",
      otherGroup,
    ),
  ).toEqual({ status: "pending" });
  expect(
    await one(
      env,
      "SELECT connection_id,state FROM conversations WHERE id=?",
      f.conversation,
    ),
  ).toEqual({ connection_id: null, state: "closed" });
  expect(
    await one(env, "SELECT id FROM connections WHERE id=?", other.id),
  ).toEqual({ id: other.id });
  expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
});

it.each(["sending", "unknown"])(
  "bloqueia exclusão com mensagem %s sem alterar dados",
  async (status) => {
    const f = await fixture();
    const queued = uid();
    await exec(
      env,
      "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system','{}','pending',?,?,?)",
      queued,
      f.profile,
      f.id,
      f.conversation,
      uid(),
      now(),
      now(),
    );
    await exec(
      env,
      "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system','{}',?,?,?,?)",
      uid(),
      f.profile,
      f.id,
      f.conversation,
      status,
      uid(),
      now(),
      now(),
    );
    await expect(
      removeConnection(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "connection_busy" });
    expect(
      (await one(env, "SELECT status FROM connections WHERE id=?", f.id))
        .status,
    ).toBe("active");
    expect((await secret(env, `connection:${f.id}`)).api_key).toBe(
      "secret-test-key",
    );
    expect(
      await one(env, "SELECT status FROM outbox WHERE id=?", queued),
    ).toEqual({ status: "pending" });
  },
);

it.each(["ringing", "active", "unknown"])(
  "bloqueia exclusão durante ligação %s",
  async (status) => {
    const f = await fixture();
    await exec(
      env,
      "INSERT INTO calls(id,profile_id,connection_id,conversation_id,direction,status,created,updated) VALUES(?,?,?,?,'inbound',?,?,?)",
      uid(),
      f.profile,
      f.id,
      f.conversation,
      status,
      now(),
      now(),
    );
    await expect(
      removeConnection(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "connection_busy" });
  },
);

it("bloqueia usuários sem administração e acessos a outro perfil", async () => {
  const f = await fixture("qr");
  await expect(
    removeConnection(
      env,
      { ...admin, role: "operator", profiles: [f.profile] },
      f.profile,
      f.id,
    ),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  await expect(removeConnection(env, admin, uid(), f.id)).rejects.toMatchObject(
    { status: 404, code: "not_found" },
  );
});

it.each(["sending", "unknown"])(
  "bloqueia exclusão durante operação de grupo %s sem cancelar a fila",
  async (status) => {
    const f = await fixture("qr"),
      queued = uid();
    await exec(
      env,
      "INSERT INTO group_operations(id,profile_id,connection_id,actor,operation,payload,status,created,updated) VALUES(?,?,?,'system','create','{}','pending',?,?)",
      queued,
      f.profile,
      f.id,
      now(),
      now(),
    );
    await exec(
      env,
      "INSERT INTO group_operations(id,profile_id,connection_id,actor,operation,payload,status,created,updated) VALUES(?,?,?,'system','create','{}',?,?,?)",
      uid(),
      f.profile,
      f.id,
      status,
      now(),
      now(),
    );
    await expect(
      removeConnection(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "connection_busy" });
    expect(
      await one(env, "SELECT status FROM group_operations WHERE id=?", queued),
    ).toEqual({ status: "pending" });
    expect(
      await one(env, "SELECT id FROM connections WHERE id=?", f.id),
    ).toEqual({ id: f.id });
  },
);

it("exige pausar a conexão Hermes antes de excluir", async () => {
  const f = await fixture("hermes");
  await expect(
    removeConnection(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
    message: "Pause a conexão antes de excluir.",
  });
});
