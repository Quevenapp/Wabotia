import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { digest, RELEASE_ORIGIN } from "../src/release";
import { installStep, webInstallerEnabled } from "../src/web-install";
import { type Env } from "../src/types";
import { all } from "../src/db";

const account = "a".repeat(32),
  name = "wabotia-teste",
  token = "cf-test-token-0123456789abcdef",
  commit = "c".repeat(40),
  database = "11111111-2222-4333-8444-555555555555",
  keys = { MASTER_KEY: "1".repeat(64), SETUP_TOKEN: "2".repeat(64) };
const e: Env = { ...env, WABOTIA_WEB_INSTALLER: "1" };
const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;

let index: any, bytes: Buffer, calls: any[], cloud: any;
const ok = (result: any) => Response.json({ success: true, result });
const refuse = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ message }] }, { status });

async function file(fileName: string, type: string, body: string) {
  return {
    name: fileName,
    type,
    data: Buffer.from(body).toString("base64"),
    sha256: await digest(body),
  };
}
beforeEach(async () => {
  const pkg = {
    format: 1,
    version: "0.15.0",
    commit,
    main_module: "index.js",
    compatibility_date: "2026-11-04",
    compatibility_flags: ["nodejs_compat"],
    assets_config: {
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/webhooks/*", "/internal/*"],
      _headers: "/*\n  X-Frame-Options: DENY\n",
    },
    durable_migrations: [{ tag: "v1", new_sqlite_classes: ["Coordinator"] }],
    modules: [
      await file(
        "index.js",
        "application/javascript+module",
        "export default {}",
      ),
    ],
    assets: [
      await file("/index.html", "text/html", "<html></html>"),
      await file("/app.js", "application/javascript", "console.log(1)"),
    ],
    migrations: [
      {
        name: "0001_core.sql",
        statements: ["CREATE TABLE a(id TEXT)", "CREATE TABLE b(id TEXT)"],
      },
      { name: "0002_more.sql", statements: ["ALTER TABLE a ADD COLUMN x"] },
    ],
  };
  bytes = Buffer.from(JSON.stringify(pkg));
  index = {
    format: 1,
    version: pkg.version,
    commit,
    package_sha256: await digest(bytes),
    package_size: bytes.length,
  };
  calls = [];
  cloud = {
    worker: false,
    buckets: [] as string[],
    databases: [] as string[],
    queries: [] as string[],
    subdomain: "minhaconta",
    live: true,
  };
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url || input),
      method = init.method || "GET",
      auth = init.headers?.Authorization || "";
    calls.push({ url, method, auth, body: init.body });
    if (url === `${RELEASE_ORIGIN}/releases/latest.json`)
      return Response.json(index);
    if (url === `${RELEASE_ORIGIN}/releases/0.15.0/package.json`)
      return new Response(bytes);
    if (url === `https://${name}.minhaconta.workers.dev/api/health`)
      return cloud.live
        ? Response.json({ commit })
        : new Response("", { status: 404 });
    if (!url.startsWith(api))
      throw new Error("Unexpected outbound request: " + url);
    const path = url.slice(api.length);
    if (path === `/workers/scripts/${name}/settings`)
      return cloud.worker ? ok({ bindings: [] }) : refuse(404, "not found");
    if (path === "/r2/buckets" && method === "GET")
      return ok({ buckets: cloud.buckets.map((n: string) => ({ name: n })) });
    if (path.startsWith("/d1/database?"))
      return ok(cloud.databases.map((n: string) => ({ name: n })));
    if (path === "/d1/database" && method === "POST") {
      cloud.databases.push(JSON.parse(init.body).name);
      return ok({ uuid: database });
    }
    if (path === "/r2/buckets" && method === "POST") {
      cloud.buckets.push(JSON.parse(init.body).name);
      return ok({});
    }
    if (path === `/d1/database/${database}/query`) {
      cloud.queries.push(JSON.parse(init.body).sql);
      return ok([]);
    }
    if (path === `/workers/scripts/${name}/assets-upload-session`)
      return ok({ jwt: "session-jwt", buckets: [["h1"], ["h2"]] });
    if (path === "/workers/assets/upload?base64=true")
      return ok(
        calls.filter((c) => c.url.endsWith("upload?base64=true")).length === 2
          ? { jwt: "completion-jwt" }
          : {},
      );
    if (path === `/workers/scripts/${name}` && method === "PUT") {
      cloud.worker = true;
      cloud.metadata = JSON.parse(await init.body.get("metadata").text());
      cloud.module = await init.body.get("index.js").text();
      return ok({ id: name });
    }
    if (path === `/workers/scripts/${name}/schedules`) {
      cloud.schedules = JSON.parse(init.body);
      return ok({});
    }
    if (path === `/workers/scripts/${name}/subdomain`) {
      cloud.subdomainEnabled = JSON.parse(init.body).enabled;
      return ok({});
    }
    if (path === "/workers/subdomain")
      return ok({ subdomain: cloud.subdomain });
    throw new Error("Unexpected Cloudflare call: " + method + " " + path);
  });
  // The fixture's asset hashes are not the ones the fake session asks for.
  const real = Object.fromEntries(
    pkg.assets.map((f: any) => [f.name, f.sha256.slice(0, 32)]),
  );
  cloud.assetHashes = [[real["/index.html"]], [real["/app.js"]]];
});
afterEach(() => vi.unstubAllGlobals());

/** Runs the installation the way the page does, one step at a time. */
async function run(until = "done") {
  let next = "check",
    cursor: any = {};
  const messages: string[] = [];
  while (next !== "done" && next !== until) {
    const result = await installStep(e, {
      account,
      name,
      token,
      step: next,
      cursor,
      ...(next === "publish" ? { keys } : {}),
    });
    // The fake session returns placeholder buckets; swap in the real hashes.
    if (result.cursor.upload?.buckets?.length)
      result.cursor.upload.buckets = cloud.assetHashes;
    cursor = result.cursor;
    next = result.next;
    messages.push(result.message);
  }
  return { cursor, messages, next };
}

describe("instalador pelo navegador", () => {
  it("instala do zero: banco, bucket, migrações, arquivos, Worker e endereço", async () => {
    const { cursor, messages } = await run();
    expect(cloud.databases).toEqual([name]);
    expect(cloud.buckets).toEqual([name + "-media"]);
    expect(cloud.queries).toHaveLength(2);
    expect(cloud.queries[0]).toContain(
      "CREATE TABLE IF NOT EXISTS d1_migrations",
    );
    expect(cloud.queries[0]).toContain(
      "CREATE TABLE a(id TEXT);\nCREATE TABLE b(id TEXT);\nINSERT INTO d1_migrations(name) VALUES('0001_core.sql');",
    );
    expect(cloud.queries[1]).toBe(
      "ALTER TABLE a ADD COLUMN x;\nINSERT INTO d1_migrations(name) VALUES('0002_more.sql');",
    );
    const m = cloud.metadata;
    expect(m.main_module).toBe("index.js");
    expect(m.migrations).toEqual({
      new_tag: "v1",
      new_sqlite_classes: ["Coordinator"],
    });
    expect(m.assets.jwt).toBe("completion-jwt");
    expect(m.assets.config._headers).toContain("X-Frame-Options");
    const binding = (n: string) => m.bindings.find((b: any) => b.name === n);
    expect(binding("DB")).toEqual({ type: "d1", name: "DB", id: database });
    expect(binding("MEDIA")).toEqual({
      type: "r2_bucket",
      name: "MEDIA",
      bucket_name: name + "-media",
    });
    expect(binding("COORDINATOR")).toMatchObject({
      type: "durable_object_namespace",
      class_name: "Coordinator",
    });
    expect(binding("ASSETS")).toEqual({ type: "assets", name: "ASSETS" });
    expect(binding("MASTER_KEY")).toEqual({
      type: "secret_text",
      name: "MASTER_KEY",
      text: keys.MASTER_KEY,
    });
    expect(binding("SETUP_TOKEN").text).toBe(keys.SETUP_TOKEN);
    expect(binding("WABOTIA_UPDATE_TOKEN").text).toBe(token);
    expect(binding("WABOTIA_ACCOUNT_ID").text).toBe(account);
    expect(binding("WABOTIA_WORKER_NAME").text).toBe(name);
    expect(binding("WABOTIA_INSTALLATION_ID").text).toBe(
      cursor.installation_id,
    );
    expect(cloud.module).toBe("export default {}");
    expect(cloud.schedules).toEqual([{ cron: "*/5 * * * *" }]);
    expect(cloud.subdomainEnabled).toBe(true);
    expect(cursor.url).toBe(`https://${name}.minhaconta.workers.dev`);
    expect(messages.at(-1)).toBe("Instalação no ar e conferida.");
    // Nada do que volta ao navegador carrega o token ou as chaves.
    expect(JSON.stringify(cursor)).not.toContain(token);
    expect(JSON.stringify(cursor)).not.toContain(keys.MASTER_KEY);
    expect(cursor.upload).toBeUndefined();
  });
  it("só envia o token à Cloudflare e não grava nada no servidor", async () => {
    await run();
    for (const call of calls) {
      const cloudflare = call.url.startsWith(api);
      if (call.url.endsWith("upload?base64=true"))
        expect(call.auth).toMatch(/^Bearer (session-jwt)$/);
      else expect(call.auth).toBe(cloudflare ? "Bearer " + token : "");
      if (!cloudflare) expect(String(call.body || "")).not.toContain(token);
    }
    for (const table of ["secrets", "events", "audit", "rate_limits"])
      expect(
        JSON.stringify(await all(env, `SELECT * FROM ${table}`)),
      ).not.toContain(token);
  });
  it("não cria nada quando o nome já está em uso ou os dados são inválidos", async () => {
    for (const taken of ["worker", "bucket", "database"]) {
      cloud.worker = taken === "worker";
      cloud.buckets = taken === "bucket" ? [name + "-media"] : [];
      cloud.databases = taken === "database" ? [name] : [];
      await expect(run()).rejects.toMatchObject({ status: 400 });
    }
    cloud.worker = false;
    cloud.buckets = [];
    cloud.databases = [];
    const base = { account, name, token, step: "check", cursor: {} };
    for (const bad of [
      { account: "curto" },
      { name: "Nome Inválido" },
      { name: "-x" },
      { token: "tem espaço dentro do token aqui" },
      { step: "apagar-tudo" },
    ])
      await expect(installStep(e, { ...base, ...bad })).rejects.toMatchObject({
        status: 400,
      });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
  it("repassa a recusa da Cloudflare sem expor o token e permite repetir o passo", async () => {
    const { cursor } = await run("bucket");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) =>
      String(input).endsWith("/r2/buckets") && init.method === "POST"
        ? refuse(403, "R2 não habilitado nesta conta")
        : real(input, init),
    );
    const failure: any = await installStep(e, {
      account,
      name,
      token,
      step: "bucket",
      cursor,
    }).catch((error) => error);
    expect(failure.status).toBe(400);
    expect(failure.message).toContain("HTTP 403");
    expect(failure.message).toContain("R2 não habilitado");
    expect(failure.message).not.toContain(token);
    vi.stubGlobal("fetch", real);
    const again = await installStep(e, {
      account,
      name,
      token,
      step: "bucket",
      cursor,
    });
    expect(again.next).toBe("migrate");
  });
  it("espera o endereço novo responder antes de concluir", async () => {
    cloud.live = false;
    const { cursor } = await run("verify");
    const waiting = await installStep(e, {
      account,
      name,
      token,
      step: "verify",
      cursor,
    });
    expect(waiting).toMatchObject({ next: "verify", wait: true });
    cloud.live = true;
    expect(
      (await installStep(e, { account, name, token, step: "verify", cursor }))
        .next,
    ).toBe("done");
  });
  it("exige chaves válidas e andamento coerente para publicar", async () => {
    const { cursor } = await run("publish");
    const publish = (extra: any) =>
      installStep(e, {
        account,
        name,
        token,
        step: "publish",
        cursor,
        ...extra,
      });
    await expect(publish({})).rejects.toThrow("Chaves da instalação");
    await expect(
      publish({ keys: { MASTER_KEY: "x", SETUP_TOKEN: keys.SETUP_TOKEN } }),
    ).rejects.toThrow("Chaves da instalação");
    await expect(
      publish({
        keys: { MASTER_KEY: keys.MASTER_KEY, SETUP_TOKEN: keys.MASTER_KEY },
      }),
    ).rejects.toThrow("Chaves da instalação");
    await expect(
      installStep(e, { account, name, token, step: "migrate", cursor: {} }),
    ).rejects.toMatchObject({ status: 400 });
    expect(cloud.worker).toBe(false);
  });
});

describe("rota do instalador", () => {
  const post = (body: any, headers: any = {}) =>
    SELF.fetch("https://test/api/install/step", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://test",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  it("fica desligada fora do site oficial", async () => {
    expect(webInstallerEnabled(env)).toBe(false);
    const status: any = await (
      await SELF.fetch("https://test/api/install/status")
    ).json();
    expect(status.enabled).toBe(false);
    const r = await post({ account, name, token, step: "check" });
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
