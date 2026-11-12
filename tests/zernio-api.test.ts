import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { hmac, setSecret, sha } from "../src/security";
import { defaults, json, now, uid } from "../src/types";

const objectId = () => uid().replaceAll("-", "").slice(0, 24);
const webhookSecret = "test-zernio-signature-secret";

async function fixture() {
  const profile = uid(),
    remoteProfile = objectId(),
    account = objectId(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Zernio API",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Zernio','zernio','direct','active',?,?)",
    id,
    profile,
    JSON.stringify({
      account_id: account,
      zernio_profile_id: remoteProfile,
      number: "5511999991234",
      verified_at: now(),
    }),
    now(),
  );
  await setSecret(env, `connection:${id}`, {
    api_key: "zernio-api-test",
    webhook_secret: webhookSecret,
  });
  return { profile, remoteProfile, account, id };
}

async function user(profile: string, role = "admin") {
  const id = uid(),
    token = "wabu_" + uid();
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Teste','unused',?,?,?)",
    id,
    `${id}@test.example`,
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

function incoming(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    id: uid(),
    event: "message.received",
    timestamp: new Date().toISOString(),
    account: {
      accountId: f.account,
      profileId: f.remoteProfile,
      platform: "whatsapp",
    },
    conversation: { id: objectId(), participantId: "5511888881234" },
    message: {
      id: objectId(),
      platform: "whatsapp",
      platformMessageId: `wamid.${uid()}`,
      direction: "incoming",
      sentAt: new Date().toISOString(),
      text: "Olá pela Zernio",
      sender: {
        id: "5511888881234",
        phoneNumber: "+5511888881234",
        name: "Cliente",
      },
    },
  };
}

async function webhook(path: string, body: any, signature?: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return SELF.fetch(`https://test${path}`, {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Zernio-Signature": signature ?? (await hmac(webhookSecret, raw)),
    },
  });
}

async function command(
  profile: string,
  token: string | null,
  path: string,
  method: string,
  body?: any,
  key = uid(),
) {
  return SELF.fetch(`https://test/api/v1/profiles/${profile}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("recebe webhook assinado, preserva telefone/identidade remota e deduplica reentregas HTTP", async () => {
  const f = await fixture(),
    body = incoming(f),
    path = `/webhooks/zernio/${f.id}`;
  const response = await webhook(path, body);
  expect(response.status).toBe(202);
  const received = await response.json<any>();
  const conversation = await one(
    env,
    "SELECT * FROM conversations WHERE id=?",
    received.conversation_id,
  );
  expect(conversation).toMatchObject({
    profile_id: f.profile,
    connection_id: f.id,
    phone: "5511888881234",
    external_namespace: `channel:${f.id}`,
  });
  expect(
    await one(
      env,
      "SELECT conversation_id FROM zernio_conversations WHERE connection_id=? AND external_id=?",
      f.id,
      "5511888881234",
    ),
  ).toEqual({ conversation_id: body.conversation.id });
  const duplicate = await webhook(path, body);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ duplicate: true });
  expect(
    (
      await one(
        env,
        "SELECT count(*) AS n FROM messages WHERE conversation_id=? AND external_id=?",
        received.conversation_id,
        body.message.platformMessageId,
      )
    ).n,
  ).toBe(1);
});

it.each(["", "0".repeat(64), "sha256=" + "0".repeat(64)])(
  "rejeita assinatura inválida sem gravar dados (%s)",
  async (signature) => {
    const f = await fixture();
    const response = await webhook(
      `/webhooks/zernio/${f.id}`,
      incoming(f),
      signature,
    );
    expect(response.status).toBe(403);
    expect((await response.json<any>()).error.code).toBe("invalid_signature");
    expect(
      await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile),
    ).toEqual([]);
    expect(
      await all(
        env,
        "SELECT connection_id FROM zernio_conversations WHERE connection_id=?",
        f.id,
      ),
    ).toEqual([]);
  },
);

it.each(["accountId", "profileId", "platform"])(
  "ignora evento assinado de outra identidade %s",
  async (field) => {
    const f = await fixture(),
      body = incoming(f);
    (body.account as any)[field] =
      field === "platform" ? "instagram" : objectId();
    const response = await webhook(`/webhooks/zernio/${f.id}`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(
      await all(env, "SELECT id FROM inbox WHERE profile_id=?", f.profile),
    ).toEqual([]);
  },
);

it("roteia o webhook compartilhado somente ao número da conta e do perfil correspondentes", async () => {
  const f = await fixture(),
    second = uid(),
    secondAccount = objectId(),
    workspace = uid();
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Zernio',?,'zernio',?,?)",
    workspace,
    f.profile,
    `zernio:${f.remoteProfile}`,
    f.remoteProfile,
    now(),
  );
  await setSecret(env, `zernio-account:${workspace}`, {
    api_key: "shared-zernio-api-key",
    webhook_secret: webhookSecret,
  });
  await exec(
    env,
    "UPDATE connections SET config=json_set(config,'$.zernio_workspace_id',?) WHERE id=?",
    workspace,
    f.id,
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Segundo','zernio','direct','active',?,?)",
    second,
    f.profile,
    JSON.stringify({
      account_id: secondAccount,
      zernio_profile_id: f.remoteProfile,
      zernio_workspace_id: workspace,
      number: "5511999995678",
    }),
    now(),
  );
  for (const [connection, remote] of [
    [f.id, f.account],
    [second, secondAccount],
  ])
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',?)",
      connection,
      workspace,
      remote,
      now(),
    );
  const response = await webhook(
    `/webhooks/zernio-accounts/${workspace}`,
    incoming({ ...f, id: second, account: secondAccount }),
  );
  expect(response.status).toBe(200);
  expect(
    await all(
      env,
      "SELECT connection_id FROM conversations WHERE profile_id=?",
      f.profile,
    ),
  ).toEqual([{ connection_id: second }]);
  expect(
    (
      await webhook(
        `/webhooks/zernio-accounts/${workspace}`,
        incoming(f),
        "0".repeat(64),
      )
    ).status,
  ).toBe(403);
  const wrong = incoming(f);
  wrong.account.profileId = objectId();
  expect(
    (await webhook(`/webhooks/zernio-accounts/${workspace}`, wrong)).status,
  ).toBe(200);
  expect(
    (
      await one(
        env,
        "SELECT count(*) AS n FROM conversations WHERE profile_id=?",
        f.profile,
      )
    ).n,
  ).toBe(1);
});

it.each(["/webhooks/meta/old", "/webhooks/meta-accounts/old"])(
  "retira a rota antiga %s com HTTP 410",
  async (path) => {
    for (const method of ["GET", "POST"]) {
      const response = await SELF.fetch(`https://test${path}`, { method });
      expect(response.status).toBe(410);
      expect((await response.json<any>()).error.code).toBe("meta_removed");
    }
  },
);

it("API recusa criar Meta direto ou reativar número legado", async () => {
  const f = await fixture(),
    admin = await user(f.profile);
  const create = await command(f.profile, admin.token, "/connections", "POST", {
    name: "Meta antiga",
    kind: "meta",
    config: { phone_id: "12345", number: "5511999991234" },
  });
  expect(create.status).toBe(400);
  await exec(
    env,
    "UPDATE connections SET kind='meta',status='paused' WHERE id=?",
    f.id,
  );
  const activate = await command(
    f.profile,
    admin.token,
    `/connections/${f.id}/state`,
    "PUT",
    { status: "active" },
  );
  expect(activate.status).toBe(410);
  expect((await activate.json<any>()).error.code).toBe("meta_removed");
  expect(
    (await one(env, "SELECT status FROM connections WHERE id=?", f.id)).status,
  ).toBe("paused");
});

it("DELETE exige administrador, respeita perfil e repete o recibo idempotente após remover", async () => {
  const f = await fixture(),
    admin = await user(f.profile),
    operator = await user(f.profile, "operator");
  expect(
    (await command(f.profile, null, `/connections/${f.id}`, "DELETE")).status,
  ).toBe(401);
  expect(
    (await command(f.profile, operator.token, `/connections/${f.id}`, "DELETE"))
      .status,
  ).toBe(403);
  expect(
    (await command(uid(), admin.token, `/connections/${f.id}`, "DELETE"))
      .status,
  ).toBe(404);
  const key = uid();
  const first = await command(
    f.profile,
    admin.token,
    `/connections/${f.id}`,
    "DELETE",
    undefined,
    key,
  );
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result).toEqual({
    id: f.id,
    deleted: true,
    conversations_preserved: 0,
  });
  const repeat = await command(
    f.profile,
    admin.token,
    `/connections/${f.id}`,
    "DELETE",
    undefined,
    key,
  );
  expect(repeat.status).toBe(200);
  expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await repeat.json()).toEqual(result);
  expect(
    await one(env, "SELECT id FROM connections WHERE id=?", f.id),
  ).toBeNull();
  expect(
    (
      await one(
        env,
        "SELECT count(*) AS n FROM audit WHERE operation='connection.delete' AND resource_id=?",
        f.id,
      )
    ).n,
  ).toBe(1);
});

it("publica contrato Zernio e exclusão sem parâmetros de autenticação Meta", async () => {
  const response = await SELF.fetch("https://test/api/openapi.json");
  expect(response.status).toBe(200);
  const spec = await response.json<any>();
  const account = spec.components.schemas.RouterAccount;
  expect(account.properties.zernio_profile_id).toBeDefined();
  expect(account.properties.waba_id).toBeUndefined();
  expect(Object.keys(account.properties.secrets.properties)).toEqual([
    "api_key",
    "webhook_secret",
  ]);
  expect(
    spec.paths["/profiles/{profile}/router/accounts/{id}/connect"].post,
  ).toBeDefined();
  expect(
    spec.paths["/profiles/{profile}/connections/{id}"].delete.parameters,
  ).toContainEqual(
    expect.objectContaining({ name: "Idempotency-Key", required: true }),
  );
  const webhook = spec.paths["/webhooks/zernio/{id}"].post;
  expect(webhook.security).toEqual([]);
  expect(webhook.servers).toEqual([{ url: "https://test" }]);
});
