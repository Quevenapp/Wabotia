import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { RELEASE_ORIGIN } from "../src/release";
import {
  checkUpdate,
  configureAutomaticUpdates,
  configureUpdates,
  deleteInitialToken,
  enablePerUpdateToken,
  startUpdate,
  processUpdate,
  updateStatus,
  resetUpdate,
  workPrefix,
} from "../src/updates";
import { secret, setSecret } from "../src/security";
import { exec, one } from "../src/db";
import { type Actor, type Env, now } from "../src/types";
import { buildInfo } from "../src/build-info.generated";
import {
  buildRelease,
  serveRelease,
  type BuiltRelease,
  type ReleaseSpec,
} from "./release-v2-fixture";
const account = "d".repeat(32),
  worker = "release-test",
  identity = "test-installation-identity",
  target = "e".repeat(40);
const e: Env = {
  ...env,
  WABOTIA_ACCOUNT_ID: account,
  WABOTIA_WORKER_NAME: worker,
  WABOTIA_INSTALLATION_ID: identity,
  WABOTIA_UPDATE_TOKEN: "test-private-publishing-token",
};
const actor: Actor = {
  id: "release-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 60,
  runLimit: 3,
};
let spec: ReleaseSpec,
  release: BuiltRelease,
  settings: any,
  calls: { url: string; method: string; body: any; auth: string }[],
  uploadError = false,
  wrongIdentity = false;
const ok = (result: any) => Response.json({ success: true, result });
beforeEach(async () => {
  calls = [];
  uploadError = false;
  wrongIdentity = false;
  await exec(env, "DELETE FROM secrets WHERE id LIKE 'system:release-%'");
  await exec(env, "DROP TABLE IF EXISTS release_probe");
  await exec(env, "DROP TABLE IF EXISTS d1_migrations");
  spec = {
    version: "99.3.1",
    commit: target,
    modules: [
      {
        name: "index.js",
        body: "export default {fetch(){return new Response('test')}}",
      },
    ],
    assets: [{ name: "/index.html", body: "<html>test</html>" }],
    migrations: [
      {
        name: "0001_probe.sql",
        statements: [
          "CREATE TABLE release_probe(id TEXT PRIMARY KEY)",
          "INSERT INTO release_probe VALUES('kept')",
        ],
      },
    ],
    assets_config: {
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/webhooks/*", "/internal/*"],
      _headers:
        "/*\n  Permissions-Policy: microphone=(self), camera=()\n  Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'; media-src 'self' blob:\n",
    },
  };
  release = await buildRelease(spec);
  settings = {
    observability: { enabled: true },
    limits: { cpu_ms: 30000 },
    bindings: [
      { name: "WABOTIA_INSTALLATION_ID", type: "plain_text", text: identity },
      { name: "CUSTOM", type: "plain_text", text: "keep" },
      { name: "MASTER_KEY", type: "secret_text" },
      { name: "WABOTIA_UPDATE_TOKEN", type: "secret_text" },
      { name: "DB", type: "d1", id: "existing-database" },
      { name: "MEDIA", type: "r2_bucket", bucket_name: "existing-media" },
      {
        name: "COORDINATOR",
        type: "durable_object_namespace",
        class_name: "Coordinator",
        namespace_id: "existing-namespace",
      },
      { name: "ASSETS", type: "assets" },
    ],
  };
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      method = request.method;
    const body =
      init.body instanceof FormData
        ? init.body
        : init.body
          ? JSON.parse(init.body)
          : null;
    const auth = request.headers.get("Authorization") || "";
    calls.push({ url: request.url, method, body, auth });
    if (url.origin === RELEASE_ORIGIN) {
      expect(auth).toBe("");
      return serveRelease(url, release)!;
    }
    expect(url.origin).toBe("https://api.cloudflare.com");
    if (url.pathname.includes("/workers/services/"))
      return ok({ default_environment: { script: { migration_tag: "v1" } } });
    if (url.pathname.endsWith("/settings"))
      return ok(wrongIdentity ? { ...settings, bindings: [] } : settings);
    if (url.pathname.endsWith("/assets-upload-session"))
      return ok({
        jwt: "temporary-upload-token",
        buckets: [[release.manifest.assets[0].sha256.slice(0, 32)]],
      });
    if (url.pathname.endsWith("/assets/upload")) {
      expect(auth).toBe("Bearer temporary-upload-token");
      return ok({ jwt: "temporary-completion-token" });
    }
    if (
      method === "DELETE" &&
      url.pathname.endsWith("/secrets/WABOTIA_UPDATE_TOKEN")
    )
      return ok(null);
    if (method === "PUT") {
      expect((await secret(env, "system:release-state")).status).toBe(
        "sending",
      );
      if (uploadError) throw Error("confirmation lost");
      return ok({ id: worker, etag: "version-etag" });
    }
    throw Error("Unexpected request");
  });
});
afterEach(() => vi.unstubAllGlobals());
async function runToEnd() {
  for (let i = 0; i < 12; i++) await processUpdate(e);
}
it("publica sem GitHub/Builds preservando ligações e migrações, e só confirma o código ativo", async () => {
  await configureUpdates(e, actor, { token: "new-private-token-000000000000" });
  const latest = await checkUpdate(e);
  const first = await startUpdate(e, actor, { commit: latest.commit });
  expect((await startUpdate(e, actor, { commit: latest.commit }))?.id).toBe(
    first?.id,
  );
  await runToEnd();
  expect((await updateStatus(e)).state?.status).toBe("requested");
  expect((await one(env, "SELECT id FROM release_probe")).id).toBe("kept");
  const publication = calls.filter((call) => call.method === "PUT");
  expect(publication).toHaveLength(1);
  const metadata = JSON.parse(await publication[0].body.get("metadata").text());
  expect(metadata.keep_bindings).toEqual(
    expect.arrayContaining([
      "d1",
      "r2_bucket",
      "durable_object_namespace",
      "secret_text",
      "plain_text",
    ]),
  );
  expect(metadata.bindings).toEqual([{ name: "ASSETS", type: "assets" }]);
  expect(metadata.observability).toEqual(settings.observability);
  expect(metadata.limits).toEqual(settings.limits);
  expect(metadata.assets.jwt).toBe("temporary-completion-token");
  expect(metadata.assets.config._headers).toBe(spec.assets_config!._headers);
  // O módulo publicado é o blob baixado e conferido.
  expect(await publication[0].body.get("index.js").text()).toBe(
    spec.modules[0].body,
  );
  // O estático foi enviado em base64, como a Cloudflare espera.
  const upload = calls.find((call) => call.url.includes("/assets/upload"))!;
  const sent = upload.body.get(release.manifest.assets[0].sha256.slice(0, 32));
  expect(Buffer.from(await sent.text(), "base64").toString()).toBe(
    "<html>test</html>",
  );
  expect(
    calls.some(
      (call) =>
        call.url.includes("github.com") || call.url.includes("deploy_hooks"),
    ),
  ).toBe(false);
  expect(JSON.stringify(await updateStatus(e))).not.toMatch(
    /private-token|temporary-upload|temporary-completion|package_key/,
  );
  const state = await secret(e, "system:release-state");
  expect(
    (await env.MEDIA.list({ prefix: workPrefix(state.id) })).objects.length,
  ).toBeGreaterThan(0);
  await setSecret(e, "system:release-state", {
    ...state,
    target: buildInfo.commit,
  });
  expect((await updateStatus(e)).state?.status).toBe("completed");
  expect(
    (await env.MEDIA.list({ prefix: workPrefix(state.id) })).objects,
  ).toHaveLength(0);
});
it("recusa troca de identidade e token de aplicação antes da publicação", async () => {
  await expect(
    configureUpdates(
      e,
      { ...actor, kind: "app", role: "service" },
      { token: "valid-looking-token-000000" },
    ),
  ).rejects.toMatchObject({ status: 403 });
  wrongIdentity = true;
  await expect(
    configureUpdates(e, actor, { token: "valid-looking-token-000000" }),
  ).rejects.toMatchObject({ status: 502 });
  await startUpdate(e, actor, { commit: target });
  await runToEnd();
  expect((await updateStatus(e)).state?.status).toBe("failed");
  expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
it("token da Cloudflare só pela pessoa, na própria sessão; ligar a automática segue liberável", async () => {
  const before = await secret(e, "system:release-config");
  const via = {
    kind: "bot" as const,
    bot_id: "bot-admin",
    run_id: "run-1",
    masked: true,
  };
  // Bot agindo pela pessoa administradora, e o próprio ator de bot.
  for (const who of [
    { ...actor, via },
    { ...actor, id: "bot:bot-admin" },
  ])
    await expect(
      configureUpdates(e, who, { token: "valid-looking-token-000000" }),
    ).rejects.toMatchObject({ status: 403, code: "secret_requires_person" });
  // Recusa antes de qualquer chamada à Cloudflare e sem gravar nada.
  expect(calls).toHaveLength(0);
  expect(await secret(e, "system:release-config")).toEqual(before);
  // Ligar e desligar a automática não leva segredo: o bot pode.
  await configureAutomaticUpdates(
    e,
    { ...actor, via },
    { enabled: false, hour: 3, window_hours: 2 },
  );
});
it("token inicial: aviso por onde está o token e apagar só com o do painel", async () => {
  // Só o segredo do instalador: em uso, com o aviso.
  expect(await updateStatus(e)).toMatchObject({
    token_source: "initial",
    initial_token_stored: true,
  });
  // Sem token do painel não apaga: a instalação ficaria sem atualização.
  await expect(
    deleteInitialToken(e, actor, { confirmed: true }),
  ).rejects.toThrow(/Salve antes um token/);
  await configureUpdates(e, actor, { token: "workers-only-token-0000000000" });
  expect(await updateStatus(e)).toMatchObject({
    token_source: "panel",
    initial_token_stored: true,
  });
  // Pede a confirmação de que não há reserva depois.
  await expect(deleteInitialToken(e, actor, {})).rejects.toThrow(/sem reserva/);
  // Bot pela pessoa e ator de bot: recusados, sem chamar a Cloudflare.
  const via = { kind: "bot" as const, bot_id: "b", run_id: "r", masked: true };
  const before = calls.length;
  for (const who of [
    { ...actor, via },
    { ...actor, id: "bot:b" },
  ])
    await expect(
      deleteInitialToken(e, who, { confirmed: true }),
    ).rejects.toMatchObject({ code: "secret_requires_person" });
  // Pessoa com fator e sessão aal1: pede o código.
  await expect(
    deleteInitialToken(
      e,
      { ...actor, aal: 1, mfa: { factor: true, policy: "off" } } as Actor,
      { confirmed: true },
    ),
  ).rejects.toMatchObject({ code: "mfa_required" });
  expect(calls.length).toBe(before);
  // Atualização em andamento: espera terminar.
  await startUpdate(e, actor, { commit: target });
  await expect(
    deleteInitialToken(e, actor, { confirmed: true }),
  ).rejects.toThrow(/em andamento/);
  await runToEnd();
  // Apaga o segredo do Worker com o token do painel, não com o inicial.
  expect(await deleteInitialToken(e, actor, { confirmed: true })).toEqual({
    deleted: true,
  });
  const del = calls.filter((c) => c.method === "DELETE");
  expect(del).toHaveLength(1);
  expect(del[0].url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets/WABOTIA_UPDATE_TOKEN`,
  );
  expect(del[0].auth).toBe("Bearer workers-only-token-0000000000");
  // Já apagado (o Worker novo sobe sem o segredo): nada a fazer.
  const gone = { ...e, WABOTIA_UPDATE_TOKEN: undefined } as Env;
  expect(await updateStatus(gone)).toMatchObject({
    token_source: "panel",
    initial_token_stored: false,
  });
  expect(
    await deleteInitialToken(gone, actor, { confirmed: true }),
  ).toMatchObject({ deleted: false, absent: true });
});
describe("modo colar o token a cada atualização", () => {
  const pasted = "pasted-per-update-token-00000000";
  const jobTokenRow = () =>
    one(env, "SELECT id FROM secrets WHERE id='system:release-job-token'");
  const via = { kind: "bot" as const, bot_id: "b", run_id: "r", masked: true };
  async function enable() {
    await configureAutomaticUpdates(e, actor, {
      enabled: true,
      hour: 3,
      window_hours: 2,
    });
    return enablePerUpdateToken(e, actor, { token: pasted, confirmed: true });
  }

  it("ligar: só pessoa, confere o token, apaga o inicial e o do painel e desliga a automática", async () => {
    await configureUpdates(e, actor, { token: "panel-token-000000000000000" });
    for (const who of [
      { ...actor, via },
      { ...actor, id: "bot:b" },
    ])
      await expect(
        enablePerUpdateToken(e, who, { token: pasted, confirmed: true }),
      ).rejects.toMatchObject({ code: "secret_requires_person" });
    await expect(
      enablePerUpdateToken(e, actor, { token: pasted }),
    ).rejects.toThrow(/Confirme/);
    wrongIdentity = true;
    await expect(
      enablePerUpdateToken(e, actor, { token: pasted, confirmed: true }),
    ).rejects.toMatchObject({ status: 502 });
    wrongIdentity = false;
    expect(await enable()).toEqual({
      mode: "per_update",
      initial_deleted: true,
      automatic_disabled: true,
    });
    const del = calls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0].url).toMatch(/\/secrets\/WABOTIA_UPDATE_TOKEN$/);
    expect(del[0].auth).toBe(`Bearer ${pasted}`);
    const config = await secret(e, "system:release-config");
    expect(config).toMatchObject({ mode: "per_update" });
    expect(config.token).toBeUndefined();
    const status = await updateStatus(e);
    expect(status).toMatchObject({
      token_source: "per_update",
      configured: true,
    });
    expect(status.automatic.enabled).toBe(false);
    // A automática não liga sem token guardado.
    await expect(
      configureAutomaticUpdates(e, actor, {
        enabled: true,
        hour: 3,
        window_hours: 2,
      }),
    ).rejects.toThrow(/não há token guardado/);
    // Salvar um token no painel volta ao modo guardado.
    await configureUpdates(e, actor, { token: "panel-token-000000000000000" });
    expect((await updateStatus(e)).token_source).toBe("panel");
  });

  it("iniciar pede o token colado, só da pessoa, e nunca usa o inicial", async () => {
    await enable();
    await expect(startUpdate(e, actor, { commit: target })).rejects.toThrow(
      /Informe um token/,
    );
    await expect(
      startUpdate(e, { ...actor, via }, { commit: target, token: pasted }),
    ).rejects.toMatchObject({ code: "secret_requires_person" });
    calls = [];
    await startUpdate(e, actor, { commit: target, token: pasted });
    const stored = await secret(e, "system:release-job-token");
    expect(stored.job_id).toBe((await secret(e, "system:release-state")).id);
    expect(stored.expires_at - now()).toBeGreaterThan(59 * 60000);
    // O token do trabalho não aparece no estado público.
    expect(JSON.stringify(await updateStatus(e))).not.toContain(pasted);
    await runToEnd();
    expect((await updateStatus(e)).state?.status).toBe("requested");
    // Toda chamada à Cloudflare usou o token colado (o env ainda tem o
    // inicial neste teste: o modo não cai nele).
    // (O envio dos estáticos usa o JWT da sessão, não o token.)
    const cloudflare = calls.filter(
      (c) =>
        c.url.startsWith("https://api.cloudflare.com/client/v4/accounts/") &&
        !c.url.includes("/assets/upload"),
    );
    expect(cloudflare.length).toBeGreaterThan(0);
    for (const c of cloudflare) expect(c.auth).toBe(`Bearer ${pasted}`);
  });

  it("(a) não sobra token do trabalho em nenhum estado final", async () => {
    await enable();
    const ends: [string, () => Promise<void>, string][] = [
      ["requested", async () => {}, "requested"],
      [
        "failed",
        async () => {
          wrongIdentity = true;
        },
        "failed",
      ],
      [
        "unknown",
        async () => {
          uploadError = true;
        },
        "unknown",
      ],
    ];
    for (const [name, arrange, expected] of ends) {
      wrongIdentity = false;
      uploadError = false;
      await exec(env, "DELETE FROM secrets WHERE id='system:release-state'");
      await startUpdate(e, actor, { commit: target, token: pasted });
      expect([name, !!(await jobTokenRow())]).toEqual([name, true]);
      await arrange();
      await runToEnd();
      expect([name, (await secret(e, "system:release-state")).status]).toEqual([
        name,
        expected,
      ]);
      expect([name, await jobTokenRow()]).toEqual([name, null]);
    }
    // Concluída: o código novo no ar.
    const done = await secret(e, "system:release-state");
    await setSecret(e, "system:release-state", {
      ...done,
      status: "requested",
      target: buildInfo.commit,
    });
    expect((await updateStatus(e)).state?.status).toBe("completed");
    expect(await jobTokenRow()).toBeNull();
    // Cancelada pela pessoa ("Liberar nova tentativa").
    wrongIdentity = false;
    uploadError = false;
    await exec(env, "DELETE FROM secrets WHERE id='system:release-state'");
    await startUpdate(e, actor, { commit: target, token: pasted });
    wrongIdentity = true;
    await runToEnd();
    wrongIdentity = false;
    await resetUpdate(e, actor, { confirmed_build_stopped: true });
    expect((await secret(e, "system:release-state")).status).toBe("cancelled");
    expect(await jobTokenRow()).toBeNull();
    // Prazo vencido com o trabalho ainda em andamento.
    await startUpdate(e, actor, { commit: target, token: pasted });
    const record = await secret(e, "system:release-job-token");
    await setSecret(e, "system:release-job-token", {
      ...record,
      expires_at: now() - 1,
    });
    await processUpdate(e);
    expect(await secret(e, "system:release-state")).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/prazo do token venceu/),
    });
    expect(await jobTokenRow()).toBeNull();
    // E nada além da configuração do modo, sem token.
    expect((await secret(e, "system:release-config")).token).toBeUndefined();
  });
});
it("não repete publicação com confirmação perdida", async () => {
  uploadError = true;
  await startUpdate(e, actor, { commit: target });
  await runToEnd();
  await runToEnd();
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect((await updateStatus(e)).state?.status).toBe("unknown");
  await expect(
    resetUpdate(e, actor, { confirmed_build_stopped: true }),
  ).rejects.toMatchObject({ status: 400 });
  const state = await secret(e, "system:release-state");
  await setSecret(e, "system:release-state", {
    ...state,
    created: now() - 1000000,
  });
  expect(
    (await resetUpdate(e, actor, { confirmed_build_stopped: true }))?.status,
  ).toBe("cancelled");
  expect(
    (await env.MEDIA.list({ prefix: workPrefix(state.id) })).objects,
  ).toHaveLength(0);
});
it("rollback da migração preserva o recibo e impede ativar código", async () => {
  spec.migrations[0].statements.push(
    "INSERT INTO missing_table VALUES('fail')",
  );
  release = await buildRelease(spec);
  await startUpdate(e, actor, { commit: target });
  await runToEnd();
  expect((await updateStatus(e)).state?.status).toBe("failed");
  expect(
    await one(env, "SELECT name FROM sqlite_master WHERE name='release_probe'"),
  ).toBeNull();
  expect(await one(env, "SELECT name FROM d1_migrations")).toBeNull();
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
});
