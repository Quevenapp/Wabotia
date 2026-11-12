import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ensureInstallationArea } from "../src/installation-area";
import { passwordMatches, sha } from "../src/security";
import { defaults, now, uid, type Actor } from "../src/types";

const path = "/api/v1/installation/area/bootstrap";
const password = "senha-de-instalacao-segura";
const admin: Actor = {
  id: "installation-admin",
  kind: "user",
  name: "Administrador",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 10,
};

beforeEach(async () => {
  await exec(env, "DROP TRIGGER IF EXISTS installation_area_test_failure");
  await batch(
    env,
    [
      "messages",
      "conversations",
      "sessions",
      "api_keys",
      "applications",
      "users",
      "profiles",
      "audit",
      "receipts",
      "rate_limits",
    ].map((table) => [`DELETE FROM ${table}`, []]),
  );
});

async function createUser(
  role: "admin" | "operator" = "admin",
  profiles: string[] = [],
  kind = "bearer",
) {
  const id = uid(),
    token = (kind === "bearer" ? "wabu_" : "") + uid();
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Equipe','unused',?,?,?)",
    id,
    `${id}@example.test`,
    role,
    JSON.stringify(profiles),
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,?,?)",
    await sha(token),
    id,
    now() + 600000,
    kind,
    now(),
  );
  return { id, token };
}

async function createApplication(profiles: string[] = []) {
  const id = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Integração',?,'[\"conversations:read\"]','[]',?)",
    id,
    JSON.stringify(profiles),
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    id,
    await sha(token),
    "wab_test",
    now() + 600000,
    now(),
  );
  return { id, token };
}

function request(token: string | null, target = path, method = "POST") {
  return SELF.fetch(`https://test${target}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === "POST" ? { "Idempotency-Key": uid() } : {}),
    },
  });
}

function setup(extra: Record<string, unknown> = {}) {
  return SELF.fetch("https://test/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://test" },
    body: JSON.stringify({
      token: env.SETUP_TOKEN,
      email: "admin@example.test",
      name: "Administrador",
      password,
      ...extra,
    }),
  });
}

it("cria a área compartilhada desativada junto do primeiro administrador, uma única vez", async () => {
  expect((await setup()).status).toBe(201);
  const profiles = await all(env, "SELECT * FROM profiles");
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({
    name: "Área de atendimento",
    enabled: 0,
  });
  expect(JSON.parse(profiles[0].settings)).toEqual(defaults);
  const user = await one(env, "SELECT * FROM users");
  expect(user).toMatchObject({ role: "admin", profiles: "[]" });
  expect(passwordMatches(password, user.password)).toBe(true);
  expect((await setup()).status).toBe(409);
  expect(await all(env, "SELECT * FROM profiles")).toEqual(profiles);
});

it("não cria área nem administrador quando o setup é recusado", async () => {
  expect((await setup({ token: "wrong-token" })).status).toBe(403);
  expect((await setup({ password: "short" })).status).toBe(400);
  expect(await all(env, "SELECT * FROM users")).toEqual([]);
  expect(await all(env, "SELECT * FROM profiles")).toEqual([]);
  expect(await all(env, "SELECT * FROM receipts")).toEqual([]);
});

it("reverte administrador e recibo se a criação da área falhar na mesma transação", async () => {
  await exec(
    env,
    "CREATE TRIGGER installation_area_test_failure BEFORE INSERT ON profiles BEGIN SELECT RAISE(ABORT, 'area_failure'); END",
  );
  try {
    expect((await setup()).status).toBe(500);
    expect(await all(env, "SELECT * FROM users")).toEqual([]);
    expect(await all(env, "SELECT * FROM profiles")).toEqual([]);
    expect(await all(env, "SELECT * FROM receipts")).toEqual([]);
  } finally {
    await exec(env, "DROP TRIGGER installation_area_test_failure");
  }
  expect((await setup()).status).toBe(201);
});

it("inicializa uma instalação existente sob concorrência sem duplicar área, auditoria ou grants", async () => {
  const user = await createUser(),
    operator = await createUser("operator"),
    application = await createApplication();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => request(user.token)),
  );
  expect(results.map((response) => response.status)).toEqual(
    Array(6).fill(200),
  );
  const bodies = await Promise.all(
    results.map((response) => response.json<any>()),
  );
  expect(bodies.filter((body) => body.created)).toHaveLength(1);
  expect(bodies.filter((body) => !body.created)).toEqual(
    Array(5).fill({ created: false, profile_id: null }),
  );
  const profiles = await all(env, "SELECT * FROM profiles");
  expect(profiles).toHaveLength(1);
  expect(bodies.find((body) => body.created).profile_id).toBe(profiles[0].id);
  const audits = await all(env, "SELECT * FROM audit");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor: user.id,
    operation: "installation.area.bootstrap",
    resource_id: profiles[0].id,
    profile_id: profiles[0].id,
  });
  expect(audits[0].request_id).toBeTruthy();
  for (const token of [operator.token, application.token]) {
    const listed = await request(token, "/api/v1/profiles", "GET");
    expect(await listed.json()).toEqual([]);
  }
  expect(
    (await one(env, "SELECT profiles FROM users WHERE id=?", operator.id))
      .profiles,
  ).toBe("[]");
  expect(
    (
      await one(
        env,
        "SELECT profiles FROM applications WHERE id=?",
        application.id,
      )
    ).profiles,
  ).toBe("[]");
});

it("reaproveita áreas legadas sem renomear, mesclar históricos ou ampliar permissões", async () => {
  const first = uid(),
    second = uid(),
    conversation = uid();
  await batch(env, [
    [
      "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Empresa antiga',?,1,?)",
      [
        first,
        JSON.stringify({ instructions: "Configuração preservada" }),
        now() - 100,
      ],
    ],
    [
      "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Área restrita','{}',0,?)",
      [second, now()],
    ],
    [
      "INSERT INTO conversations(id,profile_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,'manual','cliente','session',?,?,?)",
      [conversation, second, now(), now(), now()],
    ],
    [
      "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'in','customer','Histórico preservado',?)",
      [uid(), second, conversation, now()],
    ],
  ]);
  const operator = await createUser("operator", [first]),
    application = await createApplication([second]);
  const before = await Promise.all(
    ["profiles", "users", "applications", "conversations", "messages"].map(
      (table) => all(env, `SELECT * FROM ${table} ORDER BY id`),
    ),
  );
  expect(await ensureInstallationArea(env, admin, uid())).toEqual({
    created: false,
    profile_id: null,
  });
  const after = await Promise.all(
    ["profiles", "users", "applications", "conversations", "messages"].map(
      (table) => all(env, `SELECT * FROM ${table} ORDER BY id`),
    ),
  );
  expect(after).toEqual(before);
  expect(await all(env, "SELECT * FROM audit")).toEqual([]);
  const operatorProfiles = await (
    await request(operator.token, "/api/v1/profiles", "GET")
  ).json<any[]>();
  const appProfiles = await (
    await request(application.token, "/api/v1/profiles", "GET")
  ).json<any[]>();
  expect(operatorProfiles.map((profile) => profile.id)).toEqual([first]);
  expect(appProfiles.map((profile) => profile.id)).toEqual([second]);
});

it("exige administrador humano e mantém proteção de origem nas sessões web", async () => {
  expect((await request(null)).status).toBe(401);
  const operator = await createUser("operator"),
    application = await createApplication(),
    cookieAdmin = await createUser("admin", [], "cookie");
  expect((await request(operator.token)).status).toBe(403);
  expect((await request(application.token)).status).toBe(403);
  for (const origin of [undefined, "https://other.example"]) {
    const response = await SELF.fetch(`https://test${path}`, {
      method: "POST",
      headers: {
        Cookie: `wabotia=${cookieAdmin.token}`,
        ...(origin ? { Origin: origin } : {}),
      },
    });
    expect(response.status).toBe(403);
    expect((await response.json<any>()).error.code).toBe("invalid_origin");
  }
  await expect(
    ensureInstallationArea(env, { ...admin, kind: "connector" }),
  ).rejects.toMatchObject({ code: "admin_required" });
  expect(await all(env, "SELECT * FROM profiles")).toEqual([]);
  const response = await SELF.fetch(`https://test${path}`, {
    method: "POST",
    headers: { Cookie: `wabotia=${cookieAdmin.token}`, Origin: "https://test" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Request-Id")).toBeTruthy();
});

it("consultas de sessão e áreas não inicializam nem concedem acesso à equipe", async () => {
  const user = await createUser(),
    operator = await createUser("operator");
  for (const token of [user.token, operator.token]) {
    expect((await request(token, "/api/v1/me", "GET")).status).toBe(200);
    expect(
      await (await request(token, "/api/v1/profiles", "GET")).json(),
    ).toEqual([]);
  }
  expect(await all(env, "SELECT * FROM profiles")).toEqual([]);
  expect(await all(env, "SELECT * FROM audit")).toEqual([]);
});
