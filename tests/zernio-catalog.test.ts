import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec } from "../src/db";
import worker from "../src/index";
import { templateCatalog } from "../src/router-templates";
import { setSecret, sha } from "../src/security";
import { type Actor, now, uid } from "../src/types";

afterEach(() => vi.restoreAllMocks());
const admin: Actor = {
  id: "catalog-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};
async function fixture() {
  const profile = uid(),
    id = uid(),
    workspace = uid(),
    remote = uid().replaceAll("-", "").slice(0, 24);
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,'Catálogo',1)",
    profile,
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,zernio_profile_id,created) VALUES(?,?,'Integração',?,'zernio',?,1)",
    workspace,
    profile,
    `zernio:${remote}`,
    remote,
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Telefone','zernio','direct','paused',?,1)",
    id,
    profile,
    JSON.stringify({ account_id: remote, zernio_workspace_id: workspace }),
  );
  await exec(
    env,
    "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',1)",
    id,
    workspace,
    remote,
  );
  await setSecret(env, `zernio-account:${workspace}`, {
    api_key: "catalog-test-key",
    webhook_secret: "catalog-webhook-key",
  });
  return { profile, id, workspace, remote };
}
const templates = [
  {
    id: "101",
    name: "pedido_confirmado",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    api_key: "private",
    components: [
      { type: "BODY", text: "Pedido {{1}} confirmado", secret: "private" },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: "Consultar",
            url: "https://example.com/{{1}}",
            token: "private",
          },
        ],
      },
    ],
  },
  {
    id: "102",
    name: "pedido_confirmado",
    language: "en_US",
    status: "PENDING",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Order {{1}} confirmed" }],
  },
  {
    id: "103",
    name: "oferta",
    language: "pt_BR",
    status: "PAUSED",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Oferta da semana" }],
  },
];
function mock(f: Awaited<ReturnType<typeof fixture>>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.origin).toBe("https://zernio.com");
      expect(url.pathname).toBe("/api/v1/whatsapp/templates");
      expect([...url.searchParams]).toEqual([["accountId", f.remote]]);
      expect(request.headers.get("Authorization")).toBe(
        "Bearer catalog-test-key",
      );
      return Response.json({ templates, token: "private" });
    });
}

it("consulta catálogo completo por telefone pausado sem enviar mensagens nem expor metadados", async () => {
  const f = await fixture(),
    fetch = mock(f);
  const result = await templateCatalog(env, admin, f.profile, f.id);
  expect(result.data).toHaveLength(3);
  expect(result.data[0]).toEqual({
    id: "101",
    name: "pedido_confirmado",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "BODY", text: "Pedido {{1}} confirmado" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Consultar", url: "https://example.com/{{1}}" },
        ],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private|catalog-test-key|catalog-webhook-key|api_key/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile),
  ).toEqual([]);
});

it.each([
  [{ name: "PEDIDO" }, ["101", "102"]],
  [{ category: "marketing" }, ["103"]],
  [{ language: "PT_br", status: "approved" }, ["101"]],
  [{ name: "inexistente" }, []],
])(
  "aplica filtros locais sem inventar parâmetros Zernio (%j)",
  async (filters, ids) => {
    const f = await fixture();
    mock(f);
    expect(
      (
        await templateCatalog(env, admin, f.profile, f.id, filters as any)
      ).data.map((t: any) => t.id),
    ).toEqual(ids);
  },
);

it("permite atendente da área e recusa outra área, outro tipo de canal e filtros inválidos antes de fetch", async () => {
  const f = await fixture(),
    fetch = mock(f),
    operator = { ...admin, role: "operator", profiles: [f.profile] };
  expect(
    (await templateCatalog(env, operator, f.profile, f.id)).data,
  ).toHaveLength(3);
  fetch.mockClear();
  await expect(
    templateCatalog(env, operator, uid(), f.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(templateCatalog(env, admin, uid(), f.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    templateCatalog(env, admin, f.profile, f.id, { name: "x".repeat(513) }),
  ).rejects.toMatchObject({ status: 400 });
  await exec(env, "UPDATE connections SET kind='telegram' WHERE id=?", f.id);
  await expect(
    templateCatalog(env, admin, f.profile, f.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["number", "pool"])(
  "aplicação exige escopo e grant %s como a visualização do roteador",
  async (source) => {
    const f = await fixture(),
      app = uid(),
      pool = uid(),
      actor: Actor = {
        ...admin,
        id: `app:${app}`,
        kind: "app",
        role: "service",
        profiles: [f.profile],
        scopes: [],
      },
      fetch = mock(f);
    await exec(
      env,
      "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,'Sistema',?,'[\"routing:read\"]','[]',1)",
      app,
      JSON.stringify([f.profile]),
    );
    await expect(
      templateCatalog(env, actor, f.profile, f.id),
    ).rejects.toMatchObject({ status: 403, code: "missing_scope" });
    actor.scopes = ["routing:read"];
    await expect(
      templateCatalog(env, actor, f.profile, f.id),
    ).rejects.toMatchObject({ status: 404 });
    if (source === "pool") {
      await exec(
        env,
        "INSERT INTO number_pools(id,profile_id,account_id,name,enabled,created) VALUES(?,?,?,'Grupo',0,1)",
        pool,
        f.profile,
        f.workspace,
      );
      await exec(
        env,
        "INSERT INTO number_pool_members(pool_id,connection_id) VALUES(?,?)",
        pool,
        f.id,
      );
    }
    await exec(
      env,
      "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id) VALUES(?,?,?,?)",
      app,
      f.profile,
      source,
      source === "pool" ? pool : f.id,
    );
    expect(
      (await templateCatalog(env, actor, f.profile, f.id)).data,
    ).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("a rota HTTP protege autenticação e consulta os mesmos filtros sem Coordinator", async () => {
  const f = await fixture(),
    who = uid(),
    token = "wabu_" + uid(),
    url = `https://test/api/v1/profiles/${f.profile}/router/numbers/${f.id}/templates?name=PEDIDO&status=approved`;
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Atendente','unused','operator',?,1)",
    who,
    `${who}@example.test`,
    JSON.stringify([f.profile]),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'bearer',1)",
    await sha(token),
    who,
    now() + 600000,
  );
  const fetch = mock(f);
  expect((await worker.fetch(new Request(url), env)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
  const response = await worker.fetch(
    new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
    env,
  );
  expect(response.status).toBe(200);
  expect((await response.json<any>()).data.map((t: any) => t.id)).toEqual([
    "101",
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    await all(env, "SELECT id FROM audit WHERE profile_id=?", f.profile),
  ).toEqual([]);
});
