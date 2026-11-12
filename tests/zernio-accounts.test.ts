import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { secret } from "../src/security";
import { type Actor, defaults, json, now, uid } from "../src/types";
import {
  zernioAccountCommand,
  zernioAccountIdentity,
} from "../src/zernio-accounts";

const admin: Actor = {
  id: "zernio-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};
const remoteId = () => uid().replaceAll("-", "").slice(0, 24);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const profile = uid(),
    remote = remoteId();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Zernio",
    JSON.stringify(defaults),
    now(),
  );
  const saved = await zernioAccountCommand(
    env,
    admin,
    profile,
    "zernio-account.save",
    {
      name: "Minha conta",
      zernio_profile_id: remote,
      secrets: {
        api_key: "zernio-test-api-key",
        webhook_secret: "zernio-test-webhook-secret",
      },
    },
  );
  return { profile, remote, account: saved.id };
}

function connected(profile: string, id = remoteId(), number = "5511999990000") {
  return {
    _id: id,
    platform: "whatsapp",
    profileId: profile,
    username: `+${number}`,
    displayName: "Atendimento",
    isActive: true,
    accessToken: "must-never-be-stored",
    metadata: {
      displayPhoneNumber: `+${number}`,
      qualityRating: "GREEN",
      appSecret: "must-never-be-stored",
    },
  };
}

async function discover(
  f: Awaited<ReturnType<typeof fixture>>,
  rows = [connected(f.remote)],
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://zernio.com");
    expect(url.pathname).toBe("/api/v1/accounts");
    expect(url.searchParams.get("profileId")).toBe(f.remote);
    expect(request.headers.get("Authorization")).toBe(
      "Bearer zernio-test-api-key",
    );
    return Response.json({ accounts: rows, pagination: { nextCursor: null } });
  });
  return zernioAccountCommand(
    env,
    admin,
    f.profile,
    "zernio-account.discover",
    { id: f.account },
  );
}

it("salva credenciais cifradas separadamente da conta e preserva os segredos omitidos", async () => {
  const f = await fixture();
  const row = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=?",
    f.account,
  );
  expect(row).toMatchObject({
    provider: "zernio",
    zernio_profile_id: f.remote,
    waba_id: `zernio:${f.remote}`,
  });
  expect(JSON.stringify(row)).not.toContain("zernio-test-api-key");
  const sealed = await one(
    env,
    "SELECT value FROM secrets WHERE id=?",
    `zernio-account:${f.account}`,
  );
  expect(sealed.value).not.toContain("zernio-test-api-key");
  await zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
    id: f.account,
    name: "Nome atualizado",
  });
  expect(await secret(env, `zernio-account:${f.account}`)).toEqual({
    api_key: "zernio-test-api-key",
    webhook_secret: "zernio-test-webhook-secret",
  });
});

it("exige administrador e mantém a identidade da conta dentro do perfil", async () => {
  const f = await fixture();
  await expect(
    zernioAccountCommand(
      env,
      { ...admin, role: "operator", profiles: [f.profile] },
      f.profile,
      "zernio-account.discover",
      { id: f.account },
    ),
  ).rejects.toMatchObject({ code: "admin_required" });
  await expect(
    zernioAccountCommand(env, admin, uid(), "zernio-account.discover", {
      id: f.account,
    }),
  ).rejects.toThrow(/não encontrada/);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      id: f.account,
      name: "Troca",
      zernio_profile_id: remoteId(),
    }),
  ).rejects.toThrow(/não pode ser alterado/);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      name: "Duplicada",
      zernio_profile_id: f.remote,
    }),
  ).rejects.toThrow(/já está cadastrada/);
});

it("salva integração pendente sem ID remoto e permite editar nome e segredos antes da identificação", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch");
  const create = () =>
    zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      name: "Pendente",
      secrets: { api_key: "pending-key", webhook_secret: "pending-webhook" },
    });
  const saved = await create(),
    other = await create();
  expect(saved.id).not.toBe(other.id);
  const before = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=?",
    saved.id,
  );
  expect(before.zernio_profile_id).toBeNull();
  expect(before.waba_id).toBe(`zernio-pending:${saved.id}`);
  expect(saved.webhook_path).toBe(`/webhooks/zernio-accounts/${saved.id}`);
  await zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
    id: saved.id,
    name: "Nome editado",
    secrets: { api_key: "replacement-key" },
  });
  expect(
    await one(env, "SELECT * FROM meta_accounts WHERE id=?", saved.id),
  ).toMatchObject({
    id: saved.id,
    name: "Nome editado",
    zernio_profile_id: null,
    waba_id: before.waba_id,
  });
  expect(await secret(env, `zernio-account:${saved.id}`)).toEqual({
    api_key: "replacement-key",
    webhook_secret: "pending-webhook",
  });
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      id: saved.id,
      name: "Não aplicar pelo save",
      zernio_profile_id: remoteId(),
    }),
  ).rejects.toThrow(/não pode ser alterado/);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.discover", {
      id: saved.id,
    }),
  ).rejects.toThrow(/Use Encontrar ID na Zernio primeiro/);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.connect", {
      id: saved.id,
    }),
  ).rejects.toMatchObject({ status: 410, code: "zernio_connect_removed" });
  expect(fetch).not.toHaveBeenCalled();
});

it("continua exigindo os dois segredos para cadastrar integração sem ID", async () => {
  const f = await fixture(),
    id = uid();
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      id,
      name: "Pendente inválida",
      secrets: { api_key: "key" },
    }),
  ).rejects.toThrow(/chave API e o segredo/);
  expect(
    await one(env, "SELECT id FROM meta_accounts WHERE id=?", id),
  ).toBeNull();
});

it.each([
  {
    zernio_profile_id: "123",
    secrets: { api_key: "key", webhook_secret: "secret" },
  },
  { secrets: { api_key: "key" } },
  { secrets: { api_key: "key\nheader", webhook_secret: "secret" } },
  { secrets: { api_key: 123, webhook_secret: "secret" } },
  {
    timezone: "Invalid/Timezone",
    secrets: { api_key: "key", webhook_secret: "secret" },
  },
])(
  "rejeita configuração incompleta ou inválida antes de salvar (%j)",
  async (data) => {
    const f = await fixture();
    const id = uid();
    await expect(
      zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
        id,
        name: "Inválida",
        zernio_profile_id: remoteId(),
        ...data,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await one(env, "SELECT id FROM meta_accounts WHERE id=?", id),
    ).toBeNull();
  },
);

it("descobre todas as páginas, filtra perfil/plataforma/estado e nunca persiste credenciais remotas", async () => {
  const f = await fixture();
  const first = connected(f.remote),
    second = connected(f.remote, remoteId(), "5511999991111");
  second.profileId = { _id: f.remote } as any;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/accounts");
      expect(url.searchParams.get("profileId")).toBe(f.remote);
      expect(url.searchParams.get("status")).toBe("connected");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(request.headers.get("Authorization")).toBe(
        "Bearer zernio-test-api-key",
      );
      if (!url.searchParams.has("cursor"))
        return Response.json({
          accounts: [
            first,
            { ...first, platform: "instagram" },
            { ...first, profileId: remoteId() },
            { ...first, isActive: false },
            { ...first, needsReconnect: true },
          ],
          pagination: { nextCursor: "next&opaque" },
        });
      expect(url.searchParams.get("cursor")).toBe("next&opaque");
      return Response.json({
        accounts: [first, second],
        pagination: { nextCursor: null },
      });
    });
  const result = await zernioAccountCommand(
    env,
    admin,
    f.profile,
    "zernio-account.discover",
    { id: f.account },
  );
  expect(result.data).toHaveLength(2);
  expect(mock).toHaveBeenCalledTimes(2);
  const saved = await one(
    env,
    "SELECT discovered,discovered_at FROM meta_accounts WHERE id=?",
    f.account,
  );
  expect(saved.discovered_at).toBeGreaterThan(0);
  expect(saved.discovered).not.toContain("must-never-be-stored");
  expect(json(saved.discovered, [])[0]).toEqual({
    account_id: first._id,
    phone_id: first._id,
    number: "5511999990000",
    name: "Atendimento",
    quality: "GREEN",
  });
});

it("interrompe cursor repetido sem salvar uma descoberta parcial", async () => {
  const f = await fixture();
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      accounts: [connected(f.remote)],
      pagination: { nextCursor: "repeat" },
    }),
  );
  // A real fetch has a fresh response body each time.
  mock.mockImplementation(async () =>
    Response.json({
      accounts: [connected(f.remote)],
      pagination: { nextCursor: "repeat" },
    }),
  );
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.discover", {
      id: f.account,
    }),
  ).rejects.toThrow(/Paginação/);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(
    (
      await one(
        env,
        "SELECT discovered_at FROM meta_accounts WHERE id=?",
        f.account,
      )
    ).discovered_at,
  ).toBe(0);
});

it("cadastra somente número descoberto, com contador confirmado, e impede duplicatas", async () => {
  const f = await fixture(),
    number = connected(f.remote);
  const data = {
    account_id: f.account,
    accountId: number._id,
    baseline_used: 10,
    service_limit: 100,
    baseline_confirmed: true,
  };
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-number.save", data),
  ).rejects.toThrow(/Buscar números/);
  await discover(f, [number]);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-number.save", {
      ...data,
      accountId: remoteId(),
    }),
  ).rejects.toThrow(/não encontrado/);
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-number.save", {
      ...data,
      baseline_confirmed: false,
    }),
  ).rejects.toThrow(/contador/);
  const result = await zernioAccountCommand(
    env,
    admin,
    f.profile,
    "zernio-number.save",
    data,
  );
  expect(result).toMatchObject({
    status: "paused",
    usage: { baseline: 10, limit: 100, remaining: 90 },
  });
  const line = await one(
    env,
    "SELECT * FROM connections WHERE id=?",
    result.id,
  );
  expect(line).toMatchObject({
    kind: "zernio",
    profile_id: f.profile,
    status: "paused",
  });
  expect(json(line.config)).toMatchObject({
    account_id: number._id,
    zernio_workspace_id: f.account,
    number: "5511999990000",
  });
  expect(
    await one(
      env,
      "SELECT id FROM secrets WHERE id=?",
      `connection:${result.id}`,
    ),
  ).toBeNull();
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-number.save", data),
  ).rejects.toThrow(/já está cadastrado/);
});

it("recusa o comando legado de conexão com orientação de importar e sem chamar o provedor", async () => {
  const f = await fixture();
  const before = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=?",
    f.account,
  );
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(
    zernioAccountCommand(env, admin, f.profile, "zernio-account.connect", {
      id: f.account,
      origin: "https://wabotia.example",
    }),
  ).rejects.toMatchObject({
    status: 410,
    code: "zernio_connect_removed",
    message: expect.stringContaining("Buscar telefones"),
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await one(env, "SELECT * FROM meta_accounts WHERE id=?", f.account),
  ).toEqual(before);
});

it("mantém a autorização e o isolamento da integração no comando legado", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(
    zernioAccountCommand(
      env,
      { ...admin, role: "operator", profiles: [f.profile] },
      f.profile,
      "zernio-account.connect",
      { id: f.account },
    ),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  await expect(
    zernioAccountCommand(env, admin, uid(), "zernio-account.connect", {
      id: f.account,
    }),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(fetch).not.toHaveBeenCalled();
});

it("não aceita uma identidade WhatsApp sem telefone válido", () => {
  expect(
    zernioAccountIdentity(
      { ...connected("profile"), metadata: { displayPhoneNumber: "invalid" } },
      "profile",
    ),
  ).toBeNull();
});
