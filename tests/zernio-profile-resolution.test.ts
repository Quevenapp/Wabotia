import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { setSecret } from "../src/security";
import { now, uid, type Actor, type Env } from "../src/types";
import { resolveZernioProfile } from "../src/zernio-profile-resolution";

const admin: Actor = {
  id: "resolution-admin",
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

async function fixture(remote: string | null = remoteId()) {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,'Área',?)",
    profile,
    now(),
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,discovered,discovered_at,created) VALUES(?,?,'Integração',?,'zernio',?,'[{\"old\":true}]',123,?)",
    id,
    profile,
    remote ? `zernio:${remote}` : `zernio-pending:${id}`,
    remote,
    now(),
  );
  await setSecret(env, `zernio-account:${id}`, {
    api_key: "profile-resolution-key",
    webhook_secret: "profile-resolution-webhook",
  });
  return { id, profile, remote };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const snapshot = async (f: Fixture) => ({
  account: await one(env, "SELECT * FROM meta_accounts WHERE id=?", f.id),
  keys: await one(
    env,
    "SELECT * FROM secrets WHERE id=?",
    `zernio-account:${f.id}`,
  ),
});
function responses(profiles: any[], accounts: any[] = []) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.origin).toBe("https://zernio.com");
      expect(request.headers.get("Authorization")).toBe(
        "Bearer profile-resolution-key",
      );
      if (url.pathname === "/api/v1/profiles") {
        expect(url.search).toBe("");
        return Response.json({ profiles });
      }
      expect(url.pathname).toBe("/api/v1/accounts");
      expect(url.searchParams.get("platform")).toBe("whatsapp");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.has("status")).toBe(false);
      expect(url.searchParams.has("profileId")).toBe(false);
      return Response.json({ accounts, pagination: { nextCursor: null } });
    });
}
const resolve = (f: Fixture, selected?: string) =>
  resolveZernioProfile(env, admin, f.profile, {
    id: f.id,
    ...(selected === undefined ? {} : { zernio_profile_id: selected }),
  });

it("lista somente ID/nome e sugere o ID atual sem alterar cadastro, descoberta ou segredo", async () => {
  const f = await fixture(),
    other = remoteId(),
    before = await snapshot(f);
  const fetch = responses([
    {
      _id: f.remote,
      name: "  Atendimento\nprincipal  ",
      api_key: "not-public",
      userId: "not-public",
    },
    { _id: other, name: "Outra", description: "not-public" },
  ]);
  expect(await resolve(f)).toEqual({
    options: [
      { id: f.remote, name: "Atendimento principal" },
      { id: other, name: "Outra" },
    ],
    current_id: f.remote,
    suggested_id: f.remote,
    matched_by: "current",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await snapshot(f)).toEqual(before);
});

it.each(["string", "object"])(
  "reconhece Account ID exato com profileId %s, inclusive desconectado",
  async (shape) => {
    const f = await fixture(),
      remote = remoteId(),
      other = remoteId(),
      before = await snapshot(f);
    responses(
      [
        { _id: other, name: "Mesmo nome" },
        { _id: remote, name: "Mesmo nome" },
      ],
      [
        {
          _id: f.remote,
          platform: "whatsapp",
          isActive: false,
          profileId:
            shape === "string"
              ? remote
              : { _id: remote, name: "Não usar o nome" },
          accessToken: "not-public",
        },
      ],
    );
    expect(await resolve(f)).toMatchObject({
      current_id: f.remote,
      suggested_id: remote,
      matched_by: "account",
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it("percorre todas as páginas até reconhecer o Account ID", async () => {
  const f = await fixture(),
    remote = remoteId();
  const fetch = responses([{ _id: remote, name: "Integração" }]);
  fetch
    .mockResolvedValueOnce(
      Response.json({ profiles: [{ _id: remote, name: "Integração" }] }),
    )
    .mockResolvedValueOnce(
      Response.json({ accounts: [], pagination: { nextCursor: "next-page" } }),
    )
    .mockImplementationOnce(async (input) => {
      expect(new URL(String(input)).searchParams.get("cursor")).toBe(
        "next-page",
      );
      return Response.json({
        accounts: [{ _id: f.remote, platform: "whatsapp", profileId: remote }],
      });
    });
  expect(await resolve(f)).toMatchObject({
    suggested_id: remote,
    matched_by: "account",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([null, "130123456789", "../../connect/whatsapp"])(
  "sugere opção única com ID atual inválido %s sem construir caminho de conta",
  async (current) => {
    const f = await fixture(current),
      remote = remoteId(),
      before = await snapshot(f);
    const fetch = responses([{ _id: remote, name: "Única" }]);
    expect(await resolve(f)).toEqual({
      options: [{ id: remote, name: "Única" }],
      current_id: current || "",
      suggested_id: remote,
      matched_by: "single",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await snapshot(f)).toEqual(before);
  },
);

it("sugere opção única depois de confirmar que o ID atual não é uma conta acessível", async () => {
  const f = await fixture(),
    remote = remoteId();
  const fetch = responses([{ _id: remote, name: "Única" }]);
  expect(await resolve(f)).toMatchObject({
    suggested_id: remote,
    matched_by: "single",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("não associa por nome, nem pelo ID de uma conta de outra plataforma", async () => {
  const f = await fixture(),
    first = remoteId(),
    second = remoteId();
  responses(
    [
      { _id: first, name: "Integração" },
      { _id: second, name: "Integração" },
    ],
    [
      { _id: f.remote, platform: "instagram", profileId: first },
      {
        _id: remoteId(),
        platform: "whatsapp",
        profileId: second,
        name: "Integração",
      },
    ],
  );
  expect(await resolve(f)).toMatchObject({
    suggested_id: null,
    matched_by: null,
  });
});

it("não sugere integração invisível nem a opção única errada quando reconhece outra conta", async () => {
  const f = await fixture(),
    visible = remoteId();
  responses(
    [{ _id: visible, name: "Única visível" }],
    [{ _id: f.remote, platform: "whatsapp", profileId: remoteId() }],
  );
  expect(await resolve(f)).toMatchObject({
    suggested_id: null,
    matched_by: null,
  });
});

it("lista vazia não cria nem sugere integração", async () => {
  const f = await fixture(null);
  responses([]);
  expect(await resolve(f)).toEqual({
    options: [],
    current_id: "",
    suggested_id: null,
    matched_by: null,
  });
});

it.each([401, 403, 404, 500])(
  "propaga erro HTTP %s na leitura das contas sem substituí-lo por sugestão única",
  async (status) => {
    const f = await fixture(),
      before = await snapshot(f);
    const fetch = responses([{ _id: remoteId(), name: "Única" }]);
    fetch
      .mockResolvedValueOnce(
        Response.json({ profiles: [{ _id: remoteId(), name: "Única" }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "provider failure" }, { status }),
      );
    await expect(resolve(f)).rejects.toMatchObject({
      code: status >= 500 ? "zernio_unknown" : "zernio_rejected",
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each([
  { profiles: null },
  { profiles: [{ id: remoteId(), name: "Alias não documentado" }] },
  { profiles: [{ _id: "bad" }] },
])(
  "rejeita resposta fora do schema oficial sem alterar dados (%j)",
  async (body) => {
    const f = await fixture(),
      before = await snapshot(f);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(resolve(f)).rejects.toMatchObject({
      status: 502,
      code: "zernio_response_invalid",
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it("interrompe paginação repetida sem sugerir por lista incompleta", async () => {
  const f = await fixture();
  const fetch = responses([]);
  fetch
    .mockResolvedValueOnce(
      Response.json({ profiles: [{ _id: remoteId(), name: "Única" }] }),
    )
    .mockImplementation(async () =>
      Response.json({ accounts: [], pagination: { nextCursor: "same" } }),
    );
  await expect(resolve(f)).rejects.toThrow(/Paginação Zernio inválida/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["operator", "app", "outside", "meta"])(
  "recusa acesso %s antes de usar credenciais",
  async (scenario) => {
    const f = await fixture(),
      fetch = vi.spyOn(globalThis, "fetch");
    let actor = admin,
      profile = f.profile;
    if (scenario === "operator")
      actor = { ...admin, role: "operator", profiles: [profile] };
    if (scenario === "app")
      actor = {
        ...admin,
        kind: "app",
        scopes: ["routing:read"],
        profiles: [profile],
      };
    if (scenario === "outside") profile = uid();
    if (scenario === "meta")
      await exec(
        env,
        "UPDATE meta_accounts SET provider='meta' WHERE id=?",
        f.id,
      );
    await expect(
      resolveZernioProfile(env, actor, profile, { id: f.id }),
    ).rejects.toMatchObject({
      status: scenario === "operator" || scenario === "app" ? 403 : 404,
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([null, "account"])(
  "aplica ID confirmado a cadastro %s preservando segredo, identidade local e histórico",
  async (kind) => {
    const f = await fixture(kind === null ? null : remoteId()),
      selected = remoteId(),
      conversation = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,'retired-phone','customer','session',1,1,1)",
      conversation,
      f.profile,
    );
    await exec(
      env,
      "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'inbound','customer','Histórico',1)",
      uid(),
      f.profile,
      conversation,
    );
    const before = await snapshot(f),
      history = await all(
        env,
        "SELECT * FROM messages WHERE profile_id=?",
        f.profile,
      );
    const fetch = responses([{ _id: selected, name: "Corrigida" }]);
    expect(await resolve(f, selected)).toEqual({
      id: f.id,
      zernio_profile_id: selected,
      changed: true,
    });
    expect(await snapshot(f)).toEqual({
      keys: before.keys,
      account: {
        ...before.account,
        zernio_profile_id: selected,
        waba_id: `zernio:${selected}`,
        discovered: "[]",
        discovered_at: 0,
      },
    });
    expect(
      await all(env, "SELECT * FROM messages WHERE profile_id=?", f.profile),
    ).toEqual(history);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await resolve(f, selected)).toEqual({
      id: f.id,
      zernio_profile_id: selected,
      changed: false,
    });
  },
);

it("revalida a seleção na Zernio e recusa ID que não aparece na lista", async () => {
  const f = await fixture(),
    selected = remoteId(),
    before = await snapshot(f);
  responses([{ _id: remoteId(), name: "Outra" }]);
  await expect(resolve(f, selected)).rejects.toThrow(/não está acessível/);
  expect(await snapshot(f)).toEqual(before);
});

async function dependency(f: Fixture, kind: string) {
  if (kind === "pool") {
    await exec(
      env,
      "INSERT INTO number_pools(id,profile_id,account_id,name,created) VALUES(?,?,?,'Vazio e desativado',1)",
      uid(),
      f.profile,
      f.id,
    );
    return;
  }
  const id = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,config,created) VALUES(?,?,'Telefone','zernio','direct',?,1)",
    id,
    f.profile,
    kind === "config" ? JSON.stringify({ zernio_workspace_id: f.id }) : "{}",
  );
  if (kind === "number")
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',1)",
      id,
      f.id,
      remoteId(),
    );
}

it.each(["number", "config", "pool"])(
  "bloqueia correção com vínculo %s, sem apagar descoberta ou segredos",
  async (kind) => {
    const f = await fixture(),
      selected = remoteId();
    await dependency(f, kind);
    const before = await snapshot(f);
    responses([
      { _id: selected, name: "Corrigida" },
      { _id: f.remote, name: "Atual" },
    ]);
    await expect(resolve(f, selected)).rejects.toMatchObject({
      status: 409,
      code: "integration_in_use",
    });
    expect(await snapshot(f)).toEqual(before);
    expect(await resolve(f, f.remote!)).toEqual({
      id: f.id,
      zernio_profile_id: f.remote,
      changed: false,
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it("impede identidade Zernio duplicada em outra área inclusive com caixa diferente", async () => {
  const other = await fixture("abcdefabcdefabcdefabcdef"),
    f = await fixture(),
    before = await snapshot(f);
  const selected = other.remote!.toUpperCase();
  responses([{ _id: selected, name: "Duplicada" }]);
  await expect(resolve(f, selected)).rejects.toMatchObject({
    status: 409,
    code: "integration_already_registered",
  });
  expect(await snapshot(f)).toEqual(before);
});

it.each(["dependency", "identity", "concurrent"])(
  "o UPDATE atômico recusa corrida %s surgida imediatamente antes da escrita",
  async (race) => {
    const f = await fixture(),
      selected = remoteId(),
      concurrent = remoteId(),
      before = await snapshot(f);
    responses([{ _id: selected, name: "Corrigida" }]);
    let guarded = false;
    const racedEnv = {
      ...env,
      DB: {
        prepare(sql: string) {
          const statement = env.DB.prepare(sql);
          if (!sql.startsWith("UPDATE meta_accounts SET zernio_profile_id="))
            return statement;
          return {
            bind(...args: unknown[]) {
              const bound = statement.bind(...args);
              return {
                async run() {
                  guarded = true;
                  if (race === "dependency") await dependency(f, "config");
                  if (race === "identity") await fixture(selected);
                  if (race === "concurrent")
                    await exec(
                      env,
                      "UPDATE meta_accounts SET zernio_profile_id=?,waba_id=? WHERE id=?",
                      concurrent,
                      `zernio:${concurrent}`,
                      f.id,
                    );
                  return bound.run();
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    await expect(
      resolveZernioProfile(racedEnv, admin, f.profile, {
        id: f.id,
        zernio_profile_id: selected,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code:
        race === "dependency"
          ? "integration_in_use"
          : race === "identity"
            ? "integration_already_registered"
            : "integration_changed",
    });
    expect(guarded).toBe(true);
    expect(await snapshot(f)).toEqual(
      race === "concurrent"
        ? {
            ...before,
            account: {
              ...before.account,
              zernio_profile_id: concurrent,
              waba_id: `zernio:${concurrent}`,
            },
          }
        : before,
    );
  },
);
