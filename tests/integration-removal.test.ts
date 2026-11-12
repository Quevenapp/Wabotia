import { env, SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { removeConnection } from "../src/connection-removal";
import { removeIntegration } from "../src/integration-removal";
import { secret, setSecret, sha } from "../src/security";
import { defaults, now, uid, type Actor, type Env } from "../src/types";

const admin: Actor = {
  id: "integration-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};
afterEach(() => vi.restoreAllMocks());

async function fixture(provider: "meta" | "zernio" = "zernio") {
  const profile = uid(),
    id = uid(),
    remote = uid().replaceAll("-", "").slice(0, 24);
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,'Integrações',?,?)",
    profile,
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Integração',?,?,?,?)",
    id,
    profile,
    provider === "zernio" ? `zernio:${remote}` : remote,
    provider,
    provider === "zernio" ? remote : null,
    now(),
  );
  // Both namespaces are cleared, including a credential left by older code.
  await setSecret(env, `meta-account:${id}`, { token: "legacy-test-key" });
  await setSecret(env, `zernio-account:${id}`, {
    api_key: "zernio-test-key",
    webhook_secret: "test-signature-secret",
  });
  return { id, profile, provider, remote };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function phone(f: Fixture, mapped = true, profile = f.profile) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Telefone',?,'direct','paused',?,?)",
    id,
    profile,
    f.provider,
    JSON.stringify({
      number: "5511999990000",
      ...(f.provider === "zernio" ? { zernio_workspace_id: f.id } : {}),
    }),
    now(),
  );
  if (mapped)
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',?)",
      id,
      f.id,
      uid(),
      now(),
    );
  return id;
}

async function savedIntegration(f: Fixture) {
  return {
    account: await one(env, "SELECT * FROM meta_accounts WHERE id=?", f.id),
    keys: await all(
      env,
      "SELECT * FROM secrets WHERE id IN (?,?) ORDER BY id",
      `meta-account:${f.id}`,
      `zernio-account:${f.id}`,
    ),
  };
}

async function pool(f: Fixture) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO number_pools(id,profile_id,account_id,name,enabled,created) VALUES(?,?,?,'Grupo vazio',0,?)",
    id,
    f.profile,
    f.id,
    now(),
  );
  return id;
}

it.each(["meta", "zernio"] as const)(
  "exclui a integração %s vazia e suas credenciais somente no Wabotia",
  async (provider) => {
    const f = await fixture(provider),
      other = await fixture();
    const unrelated = await savedIntegration(other);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No provider call permitted"));
    expect(await removeIntegration(env, admin, f.profile, f.id)).toEqual({
      id: f.id,
      deleted: true,
    });
    expect(
      await one(env, "SELECT id FROM meta_accounts WHERE id=?", f.id),
    ).toBeNull();
    expect(await secret(env, `meta-account:${f.id}`)).toEqual({});
    expect(await secret(env, `zernio-account:${f.id}`)).toEqual({});
    expect(await savedIntegration(other)).toEqual(unrelated);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      removeIntegration(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  },
);

it.each(["meta", "zernio"] as const)(
  "preserva todo o histórico ao remover a integração %s depois do último telefone",
  async (provider) => {
    const f = await fixture(provider),
      connection = await phone(f),
      conversation = uid(),
      time = now();
    await batch(env, [
      [
        "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,?,?,'cliente','session',?,?,?)",
        [
          conversation,
          f.profile,
          connection,
          `channel:${connection}`,
          time,
          time,
          time,
        ],
      ],
      [
        "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'inbound','customer','Mensagem preservada',?)",
        [uid(), f.profile, conversation, time],
      ],
      [
        "INSERT INTO tickets(id,number,profile_id,conversation_id,title,created,updated) VALUES(?,?,?,?, 'Protocolo preservado',?,?)",
        [uid(), uid(), f.profile, conversation, time, time],
      ],
      [
        "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system','{}','sent',?,?,?)",
        [uid(), f.profile, connection, conversation, uid(), time, time],
      ],
      [
        "INSERT INTO meta_message_usage(connection_id,external_id,status,category,billable,period,updated) VALUES(?,'provider-message','delivered','service',0,'2026-11',?)",
        [connection, time],
      ],
    ]);
    await removeConnection(env, admin, f.profile, connection);
    const history = async () => ({
      conversations: await all(
        env,
        "SELECT * FROM conversations WHERE profile_id=?",
        f.profile,
      ),
      messages: await all(
        env,
        "SELECT * FROM messages WHERE profile_id=?",
        f.profile,
      ),
      tickets: await all(
        env,
        "SELECT * FROM tickets WHERE profile_id=?",
        f.profile,
      ),
      deliveries: await all(
        env,
        "SELECT * FROM outbox WHERE profile_id=?",
        f.profile,
      ),
      usage: await all(
        env,
        "SELECT * FROM meta_message_usage WHERE connection_id=?",
        connection,
      ),
    });
    const before = await history();
    expect(before.conversations[0].connection_id).toBeNull();
    await removeIntegration(env, admin, f.profile, f.id);
    expect(await history()).toEqual(before);
  },
);

it.each(["meta", "zernio"] as const)(
  "bloqueia uma integração %s com telefone mapeado, mesmo pausado",
  async (provider) => {
    const f = await fixture(provider),
      connection = await phone(f),
      before = await savedIntegration(f);
    await expect(
      removeIntegration(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
    expect(await savedIntegration(f)).toEqual(before);
    expect(
      await one(
        env,
        "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
        connection,
      ),
    ).toBeTruthy();
  },
);

it("bloqueia conexão que ainda usa credenciais da integração mesmo sem registro meta_numbers e em outra área", async () => {
  const f = await fixture(),
    other = await fixture();
  await phone(f, false, other.profile);
  const before = await savedIntegration(f);
  await expect(
    removeIntegration(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  expect(await savedIntegration(f)).toEqual(before);
});

it("não remove grupos vazios/desativados nem suas permissões ao excluir uma integração", async () => {
  const f = await fixture(),
    pool = uid(),
    application = uid();
  await batch(env, [
    [
      "INSERT INTO number_pools(id,profile_id,account_id,name,enabled,created) VALUES(?,?,?,'Grupo sem telefones',0,?)",
      [pool, f.profile, f.id, now()],
    ],
    [
      "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Sistema',?,'[\"routing:send\"]','[]',?)",
      [application, JSON.stringify([f.profile]), now()],
    ],
    [
      "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id) VALUES(?,?,'pool',?)",
      [application, f.profile, pool],
    ],
  ]);
  const before = await savedIntegration(f),
    poolBefore = await one(env, "SELECT * FROM number_pools WHERE id=?", pool),
    grantsBefore = await all(
      env,
      "SELECT * FROM number_router_grants WHERE app_id=?",
      application,
    );
  await expect(
    removeIntegration(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  expect(await savedIntegration(f)).toEqual(before);
  expect(await one(env, "SELECT * FROM number_pools WHERE id=?", pool)).toEqual(
    poolBefore,
  );
  expect(
    await all(
      env,
      "SELECT * FROM number_router_grants WHERE app_id=?",
      application,
    ),
  ).toEqual(grantsBefore);
});

it("remove apenas grupos vazios e desativados sem vínculos junto da integração", async () => {
  const f = await fixture(),
    other = await fixture(),
    first = await pool(f),
    second = await pool(f),
    unrelated = await pool(other);
  expect(await removeIntegration(env, admin, f.profile, f.id)).toEqual({
    id: f.id,
    deleted: true,
  });
  expect(
    await all(
      env,
      "SELECT id FROM number_pools WHERE id IN (?,?)",
      first,
      second,
    ),
  ).toEqual([]);
  expect(
    await one(env, "SELECT id FROM number_pools WHERE id=?", unrelated),
  ).toBeTruthy();
});

it.each(["sent", "cancelled", "unknown"])(
  "preserva grupo citado por envio %s e evita limpeza parcial de outros grupos",
  async (status) => {
    const f = await fixture(),
      unused = await pool(f),
      historical = await pool(f),
      delivery = uid();
    await exec(
      env,
      "INSERT INTO outbox(id,profile_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,'text','system',?,?,?,?,?)",
      delivery,
      f.profile,
      JSON.stringify({ router_source: { type: "pool", id: historical } }),
      status,
      uid(),
      now(),
      now(),
    );
    const before = await savedIntegration(f),
      history = await one(env, "SELECT * FROM outbox WHERE id=?", delivery);
    await expect(
      removeIntegration(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
    expect(await savedIntegration(f)).toEqual(before);
    expect(
      await all(
        env,
        "SELECT id FROM number_pools WHERE id IN (?,?)",
        unused,
        historical,
      ),
    ).toHaveLength(2);
    expect(await one(env, "SELECT * FROM outbox WHERE id=?", delivery)).toEqual(
      history,
    );
  },
);

it("preserva grupo citado em autorização histórica de pareamento", async () => {
  const f = await fixture(),
    group = await pool(f);
  await exec(
    env,
    "INSERT INTO pairing_requests(id,client,instance_name,device_hash,user_hash,status,expires,profile_id,grants,created,updated) VALUES(?,'vinki','Sistema',?,?,'revoked',?,?,?,?,?)",
    uid(),
    uid(),
    uid(),
    now() - 1000,
    f.profile,
    JSON.stringify({ pool_ids: [group] }),
    now(),
    now(),
  );
  await expect(
    removeIntegration(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  expect(
    await one(env, "SELECT id FROM number_pools WHERE id=?", group),
  ).toBeTruthy();
});

it.each(["enabled", "public_token"])(
  "não remove grupo com %s configurado mesmo sem telefones",
  async (field) => {
    const f = await fixture(),
      group = await pool(f);
    await exec(
      env,
      `UPDATE number_pools SET ${field}=? WHERE id=?`,
      field === "enabled" ? 1 : uid(),
      group,
    );
    await expect(
      removeIntegration(env, admin, f.profile, f.id),
    ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  },
);

it("isola áreas e exige administrador humano sem apagar credenciais em falhas de acesso", async () => {
  const f = await fixture(),
    other = await fixture(),
    before = await savedIntegration(f);
  await expect(
    removeIntegration(env, admin, other.profile, f.id),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(
    removeIntegration(
      env,
      { ...admin, role: "operator", profiles: [f.profile] },
      f.profile,
      f.id,
    ),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  await expect(
    removeIntegration(
      env,
      {
        ...admin,
        kind: "app",
        profiles: [f.profile],
        scopes: ["routing:read"],
      },
      f.profile,
      f.id,
    ),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  await expect(
    removeIntegration(env, { ...admin, kind: "connector" }, f.profile, f.id),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  expect(await savedIntegration(f)).toEqual(before);
});

it("revalida vínculos no DELETE atômico e preserva credenciais se surgir uma conexão concorrente", async () => {
  const f = await fixture(),
    before = await savedIntegration(f),
    emptyPool = await pool(f);
  const racingEnv = {
    ...env,
    DB: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await phone(f, false);
        return env.DB.batch(statements);
      },
    },
  } as Env;
  await expect(
    removeIntegration(racingEnv, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  expect(await savedIntegration(f)).toEqual(before);
  expect(
    await one(env, "SELECT id FROM number_pools WHERE id=?", emptyPool),
  ).toBeTruthy();
});

it("reverte a exclusão da integração se a limpeza de credenciais falhar", async () => {
  const f = await fixture(),
    before = await savedIntegration(f),
    emptyPool = await pool(f),
    trigger = "integration_removal_" + uid().replaceAll("-", "");
  await exec(
    env,
    `CREATE TRIGGER ${trigger} BEFORE DELETE ON secrets WHEN OLD.id='zernio-account:${f.id}' BEGIN SELECT RAISE(ABORT, 'cleanup_failure'); END`,
  );
  try {
    await expect(
      removeIntegration(env, admin, f.profile, f.id),
    ).rejects.toThrow("cleanup_failure");
    expect(await savedIntegration(f)).toEqual(before);
    expect(
      await one(env, "SELECT id FROM number_pools WHERE id=?", emptyPool),
    ).toBeTruthy();
  } finally {
    await exec(env, `DROP TRIGGER ${trigger}`);
  }
});

it("não deixa configuração inválida de conexão alheia impedir exclusão de integração vazia", async () => {
  const f = await fixture(),
    other = await fixture(),
    connection = await phone(other, false);
  await exec(
    env,
    "UPDATE connections SET config='invalid-json' WHERE id=?",
    connection,
  );
  expect(await removeIntegration(env, admin, f.profile, f.id)).toEqual({
    id: f.id,
    deleted: true,
  });
});

it("preserva grupo com afinidade histórica mesmo sem telefone cadastrado", async () => {
  const f = await fixture(),
    group = await pool(f),
    conversation = uid();
  await exec(
    env,
    "INSERT INTO conversations(id,profile_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,'manual','cliente','session',?,?,?)",
    conversation,
    f.profile,
    now(),
    now(),
    now(),
  );
  await exec(
    env,
    "INSERT INTO router_affinities(profile_id,actor,external_id,source_type,source_id,conversation_id,connection_id,recipient,created) VALUES(?,'system','historical','pool',?,?,?,'5511999990000',?)",
    f.profile,
    group,
    conversation,
    uid(),
    now(),
  );
  await expect(
    removeIntegration(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 409, code: "integration_in_use" });
  expect(
    await one(env, "SELECT id FROM number_pools WHERE id=?", group),
  ).toBeTruthy();
});

async function user(profile: string, role = "admin") {
  const id = uid(),
    token = "wabu_" + uid();
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Teste','unused',?,?,?)",
    id,
    `${id}@example.test`,
    role,
    JSON.stringify([profile]),
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'bearer',?)",
    await sha(token),
    id,
    now() + 600000,
    now(),
  );
  return { id, token };
}

function removeViaApi(
  f: Fixture,
  token: string | null,
  key: string | null = uid(),
) {
  return SELF.fetch(
    `https://test/api/v1/profiles/${f.profile}/router/accounts/${f.id}`,
    {
      method: "DELETE",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
    },
  );
}

it("exclui pela API com auditoria e replay idempotente do mesmo comando", async () => {
  const f = await fixture("meta"),
    who = await user(f.profile),
    key = uid();
  const first = await removeViaApi(f, who.token, key);
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result).toEqual({ id: f.id, deleted: true });
  const repeated = await removeViaApi(f, who.token, key);
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(result);
  expect(repeated.headers.get("Idempotency-Replayed")).toBe("true");
  const audits = await all(
    env,
    "SELECT * FROM audit WHERE operation='integration.delete' AND resource_id=?",
    f.id,
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actor: who.id, profile_id: f.profile });
  expect((await removeViaApi(f, who.token)).status).toBe(404);
});

it("protege a API contra exclusão por atendente, aplicação, outra área e falta de idempotência", async () => {
  const f = await fixture(),
    who = await user(f.profile),
    operator = await user(f.profile, "operator"),
    application = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Sistema',?,'[\"routing:read\",\"routing:send\"]','[]',?)",
    application,
    JSON.stringify([f.profile]),
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    application,
    await sha(token),
    "wab_test",
    now() + 600000,
    now(),
  );
  const before = await savedIntegration(f);
  expect((await removeViaApi(f, null)).status).toBe(401);
  expect((await removeViaApi(f, operator.token)).status).toBe(403);
  expect((await removeViaApi(f, token)).status).toBe(403);
  expect((await removeViaApi({ ...f, profile: uid() }, who.token)).status).toBe(
    404,
  );
  expect((await removeViaApi(f, who.token, null)).status).toBe(400);
  expect(await savedIntegration(f)).toEqual(before);
});
