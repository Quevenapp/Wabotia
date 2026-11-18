import { env, SELF } from "cloudflare:test";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { secret, setSecret, sha } from "../src/security";
import { now, uid, type Actor } from "../src/types";
import {
  checkUpdate,
  configureUpdates,
  deployHookUrl,
  resetUpdate,
  startUpdate,
  updatePlan,
  updateStatus,
} from "../src/updates";
import { buildInfo } from "../src/build-info.generated";

const account = "a".repeat(32),
  zone = "b".repeat(32),
  target = "c".repeat(40);
const token = "private-cloudflare-api-token-test";
const hook =
  "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/0123456789abcdef0123456789abcdef";
const admin: Actor = {
  id: "test-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 100,
  runLimit: 10,
};
let calls: { path: string; method: string; body: any; auth: string }[],
  apps: any[],
  policies: any[],
  dns: any[],
  fault: string,
  special: string;
const ok = (result: any, extra = {}) =>
  Response.json({ success: true, result, ...extra });
beforeEach(async () => {
  calls = [];
  apps = [];
  policies = [];
  dns = [];
  fault = "";
  special = "";
  await exec(
    env,
    "DELETE FROM secrets WHERE id LIKE 'system:update-%'",
  );
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    // Validate request options in workerd even when the provider response is simulated.
    new Request(input, init);
    const url = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    const path = url.pathname.replace("/client/v4", ""),
      method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      path,
      method,
      body,
      auth: new Headers(init.headers).get("Authorization") || "",
    });
    if (fault === path) throw new Error("network interrupted");
    if (special === path && method === "POST") return ok({ id: uid() });
    if (url.origin === "https://api.github.com") {
      if (path.endsWith("/commits/main")) return Response.json({ sha: target });
      if (
        path.endsWith("/contents/package.json") &&
        url.search === `?ref=${target}`
      )
        return Response.json({
          content: btoa(JSON.stringify({ version: "0.2.1" })),
        });
    }
    if (url.origin !== "https://api.cloudflare.com")
      throw Error("Unexpected destination");
    if (url.href === hook) return ok({ build_uuid: uid() });
    throw Error("Unexpected request " + path);
  });
});
afterEach(() => vi.unstubAllGlobals());
async function session(role = "admin") {
  const user = uid(),
    cookie = uid();
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)",
    user,
    user + "@example.com",
    "Test",
    "unused",
    role,
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)",
    await sha(cookie),
    user,
    now() + 60000,
  );
  return cookie;
}
async function request(
  cookie: string,
  path: string,
  body?: any,
  key = uid(),
  origin = "https://test",
) {
  return SELF.fetch("https://test/api/v1/system" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: `wabotia=${cookie}`,
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
it("restringe manutenção a administradores e recusa origem cruzada", async () => {
  const op = await session("operator"),
    user = await session();
  expect((await request(op, "")).status).toBe(403);
  expect(
    (
      await request(op, "/updates/configure", {
        hook_url: hook,
        build_configured: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        user,
        "/updates/configure",
        { hook_url: hook, build_configured: true },
        uid(),
        "https://attacker.example",
      )
    ).status,
  ).toBe(403);
  await expect(
    configureUpdates(env, { ...admin, kind: "app" }, {}),
  ).rejects.toMatchObject({ status: 403 });
});
it("mantém idempotência, conflito e sigilo pela API", async () => {
  const user = await session(),
    key = uid(),
    body = { hook_url: hook, build_configured: true };
  expect((await request(user, "/updates/configure", body, key)).status).toBe(
    200,
  );
  const replay = await request(user, "/updates/configure", body, key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    (
      await request(
        user,
        "/updates/configure",
        { ...body, hook_url: hook + "x" },
        key,
      )
    ).status,
  ).toBe(409);
  const visible = await request(user, "");
  expect(visible.headers.get("Cache-Control")).toBe("no-store");
  expect(await visible.text()).not.toContain(hook);
  expect(
    (
      await one(
        env,
        "SELECT value FROM secrets WHERE id='system:update-config'",
      )
    ).value,
  ).not.toContain("deploy_hooks");
});
it("recusa URLs arbitrárias para hooks", async () => {
  for (const value of [
    "https://evil.example/hook",
    hook + "?redirect=evil",
    hook.replace("https:", "http:"),
    "https://user:secret@api.cloudflare.com/client/v4/workers/builds/deploy_hooks/01234567890123456789",
  ])
    expect(() => deployHookUrl(value)).toThrow();
  expect(calls).toHaveLength(0);
});
it("fixa commit oficial antes do hook, deduplica e só confirma o código instalado", async () => {
  await configureUpdates(env, admin, {
    hook_url: hook,
    build_configured: true,
  });
  await checkUpdate(env);
  const first = await startUpdate(env, admin, { commit: target });
  expect(first.status).toBe("requested");
  expect((await updatePlan(env)).commit).toBe(target);
  expect((await startUpdate(env, admin, { commit: target })).id).toBe(first.id);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect((await updateStatus(env)).state.status).toBe("requested");
  await setSecret(env, "system:update-state", {
    ...first,
    target: buildInfo.commit,
  });
  expect((await updateStatus(env)).state.status).toBe("completed");
});
it("recusa redirecionamento do repositório sem registrar uma versão", async () => {
  const redirectedFetch = vi.fn(async (input: any, init: any) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/repository" },
    });
  });
  vi.stubGlobal("fetch", redirectedFetch);
  await expect(checkUpdate(env)).rejects.toMatchObject({
    status: 502,
    code: "update_check_failed",
  });
  expect(redirectedFetch).toHaveBeenCalledTimes(1);
  expect((await updateStatus(env)).latest).toBeNull();
});
it("não repete hook ambíguo e exige revisão antes de liberar outra tentativa", async () => {
  await configureUpdates(env, admin, {
    hook_url: hook,
    build_configured: true,
  });
  fault = new URL(hook).pathname.replace("/client/v4", "");
  const first = await startUpdate(env, admin, { commit: target });
  expect(first.status).toBe("unknown");
  await startUpdate(env, admin, { commit: target });
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  await expect(
    resetUpdate(env, admin, { confirmed_build_stopped: true }),
  ).rejects.toMatchObject({ status: 400 });
  await setSecret(env, "system:update-state", {
    ...first,
    created: now() - 1000000,
  });
  await expect(resetUpdate(env, admin, {})).rejects.toMatchObject({
    status: 400,
  });
  expect(
    (await resetUpdate(env, admin, { confirmed_build_stopped: true })).status,
  ).toBe("cancelled");
  expect((await updatePlan(env)).commit).toBe(buildInfo.commit);
});
