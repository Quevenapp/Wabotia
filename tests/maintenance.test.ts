import { env, SELF } from "cloudflare:test";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { secret, setSecret, sha } from "../src/security";
import { now, uid, type Actor } from "../src/types";
import { checkUpdate, updateStatus } from "../src/updates";

let calls: { path: string; method: string }[];
beforeEach(async () => {
  calls = [];
  await exec(env, "DELETE FROM secrets WHERE id LIKE 'system:release-%'");
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    new Request(input, init);
    const url = new URL(
      typeof input === "string" ? input : input.url || String(input),
    );
    calls.push({ path: url.pathname, method: init.method || "GET" });
    throw Error("Unexpected request " + url.href);
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
      await request(op, "/updates/configure", { token: "t".repeat(40) })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        user,
        "/updates/configure",
        { token: "t".repeat(40) },
        uid(),
        "https://attacker.example",
      )
    ).status,
  ).toBe(403);
});
it("recusa redirecionamento da publicação oficial sem registrar uma versão", async () => {
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
