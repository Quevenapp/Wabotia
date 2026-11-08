import { SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import app, { resetRate, RATE_LIMIT, type Env } from "../src/index";
import pkg from "../package.json";

interface Call {
  url: URL;
  headers: Headers;
  body: any;
}
let calls: Call[] = [];
async function serviceAccount() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  return {
    client_email: `push-${crypto.randomUUID().slice(0, 8)}@proj.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    project_id: "proj-teste",
    token_uri: "https://oauth2.googleapis.com/token",
  };
}
let envWithAccount: Env;
beforeEach(async () => {
  calls = [];
  resetRate();
  envWithAccount = { FCM_SERVICE_ACCOUNT: JSON.stringify(await serviceAccount()) };
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const raw = new TextDecoder().decode(await request.arrayBuffer());
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    calls.push({ url, headers: request.headers, body });
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "acesso-fcm", expires_in: 3600 });
    if (url.hostname === "fcm.googleapis.com") {
      const token: string = body.message.token;
      if (token.startsWith("morto"))
        return Response.json(
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              message: "Requested entity was not found.",
              details: [{ errorCode: "UNREGISTERED" }],
            },
          },
          { status: 404 },
        );
      if (token.startsWith("ruim"))
        return Response.json(
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "The registration token is not a valid FCM registration token",
              details: [{ errorCode: "INVALID_ARGUMENT" }],
            },
          },
          { status: 400 },
        );
      if (token.startsWith("falha"))
        return Response.json(
          { error: { code: 500, status: "INTERNAL" } },
          { status: 500 },
        );
      if (token.startsWith("projeto"))
        return Response.json(
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              message: "Requested entity was not found.",
            },
          },
          { status: 404 },
        );
      return Response.json({ name: `projects/proj-teste/messages/${crypto.randomUUID()}` });
    }
    throw new Error("fetch inesperado: " + url.href);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const TOKEN = "token-de-aparelho-0123456789abcdef";
const valid = (over: Record<string, unknown> = {}) => ({
  token: TOKEN,
  platform: "android",
  title: "Maria",
  body: "Preciso de ajuda com o pedido",
  data: { type: "message", profile_id: "p1", server: "https://wabotia.exemplo.com.br" },
  priority: "high",
  collapse_key: "conversa-1",
  channel: "messages",
  category: "MESSAGE",
  time_sensitive: false,
  ...over,
});
async function push(
  body: unknown,
  env: Env = envWithAccount,
  headers: Record<string, string> = {},
) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request("https://gateway.test/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const json: any = await response.json();
  return { status: response.status, headers: response.headers, json };
}

it("GET /health identifica o gateway e a versão", async () => {
  const response = await SELF.fetch("https://gateway.test/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    service: "wabotia-push-gateway",
    version: pkg.version,
  });
  const missing = await SELF.fetch("https://gateway.test/nada");
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as any).error.code).toBe("not_found");
});

it("responde 503 setup_required sem conta de serviço ou com JSON inválido", async () => {
  for (const env of [{}, { FCM_SERVICE_ACCOUNT: "   " }, { FCM_SERVICE_ACCOUNT: "{nao é json" }, { FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "x" }) }] as Env[]) {
    const r = await push({ messages: [valid()] }, env);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("setup_required");
  }
  expect(calls).toHaveLength(0);
});

it("exige o segredo compartilhado quando GATEWAY_SHARED_SECRET está definido", async () => {
  const env: Env = { ...envWithAccount, GATEWAY_SHARED_SECRET: "segredo-forte" };
  let r = await push({ messages: [valid()] }, env);
  expect(r.status).toBe(401);
  expect(r.json.error.code).toBe("unauthorized");
  r = await push({ messages: [valid()] }, env, { Authorization: "Bearer segredo-errado" });
  expect(r.status).toBe(401);
  r = await push({ messages: [valid()] }, env, { Authorization: "Bearer segredo-fort" });
  expect(r.status).toBe(401);
  r = await push({ messages: [valid()] }, env, { Authorization: "Basic segredo-forte" });
  expect(r.status).toBe(401);
  expect(calls).toHaveLength(0);
  r = await push({ messages: [valid()] }, env, { Authorization: "Bearer segredo-forte" });
  expect(r.status).toBe(200);
  expect(r.json.results).toEqual([{ token: TOKEN, status: "ok" }]);
  // Sem segredo configurado, qualquer Authorization é aceito.
  r = await push({ messages: [valid()] }, envWithAccount, { Authorization: "Bearer qualquer" });
  expect(r.status).toBe(200);
});

it("valida o corpo e cada mensagem, apontando o índice", async () => {
  const bad = async (body: unknown, code: string, index?: number) => {
    const r = await push(body);
    expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect(r.json.error.code).toBe(code);
    if (index !== undefined) expect(r.json.error.index).toBe(index);
    expect(typeof r.json.error.message).toBe("string");
  };
  await bad("{quebrado", "invalid_json");
  await bad({ mensagens: [] }, "invalid_request");
  await bad({ messages: {} }, "invalid_request");
  await bad({ messages: Array.from({ length: 101 }, () => valid()) }, "invalid_request");
  await bad({ messages: [valid(), "texto"] }, "invalid_message", 1);
  await bad({ messages: [valid({ token: "curto" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ token: "a".repeat(4097) })] }, "invalid_message", 0);
  await bad({ messages: [valid({ token: "token com espaco 0123456789" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ platform: "web" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ title: "x".repeat(201) })] }, "invalid_message", 0);
  await bad({ messages: [valid({ body: "x".repeat(501) })] }, "invalid_message", 0);
  await bad({ messages: [valid({ title: 5 })] }, "invalid_message", 0);
  await bad({ messages: [valid({ title: " ", body: "" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ data: ["a"] })] }, "invalid_message", 0);
  await bad({ messages: [valid({ data: { n: 1 } })] }, "invalid_message", 0);
  await bad(
    {
      messages: [
        valid({
          data: Object.fromEntries(Array.from({ length: 21 }, (_, i) => ["k" + i, "v"])),
        }),
      ],
    },
    "invalid_message",
    0,
  );
  await bad({ messages: [valid({ priority: "urgent" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ time_sensitive: "sim" })] }, "invalid_message", 0);
  await bad({ messages: [valid({ collapse_key: "c".repeat(101) })] }, "invalid_message", 0);
  await bad({ messages: [valid(), valid({ channel: 7 })] }, "invalid_message", 1);
  expect(calls).toHaveLength(0);
  // Lista vazia é aceita sem chamar o FCM.
  const empty = await push({ messages: [] });
  expect(empty.status).toBe(200);
  expect(empty.json).toEqual({ results: [] });
  expect(calls).toHaveLength(0);
});

it("repassa ao FCM e devolve ok, unregistered e error na ordem recebida", async () => {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const messages = [
    valid(),
    valid({ token: "morto-0123456789abcdef0123", platform: "ios", time_sensitive: true }),
    valid({ token: "ruim-0123456789abcdef0123456", priority: undefined, data: undefined }),
    valid({ token: "falha-0123456789abcdef012345", collapse_key: "", channel: null }),
    // 404 sem errorCode UNREGISTERED (projeto errado) não desativa o token.
    valid({ token: "projeto-0123456789abcdef0123" }),
  ];
  const r = await push({ messages }, envWithAccount, { "CF-Connecting-IP": "198.51.100.7" });
  expect(r.status).toBe(200);
  expect(r.json.results).toEqual([
    { token: TOKEN, status: "ok" },
    { token: messages[1].token, status: "unregistered", error: "UNREGISTERED" },
    { token: messages[2].token, status: "unregistered", error: "INVALID_ARGUMENT" },
    { token: messages[3].token, status: "error", error: "HTTP 500 INTERNAL" },
    { token: messages[4].token, status: "error", error: "HTTP 404 NOT_FOUND" },
  ]);
  const oauth = calls.filter((c) => c.url.hostname === "oauth2.googleapis.com");
  expect(oauth).toHaveLength(1);
  expect(new URLSearchParams(oauth[0].body).get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const sent = calls.filter((c) => c.url.hostname === "fcm.googleapis.com");
  expect(sent).toHaveLength(5);
  for (const call of sent) {
    expect(call.url.pathname).toBe("/v1/projects/proj-teste/messages:send");
    expect(call.headers.get("Authorization")).toBe("Bearer acesso-fcm");
  }
  // Android: mensagem só de dados (título/corpo em data), prioridade alta, sem notification/apns.
  const first = sent.find((c) => c.body.message.token === TOKEN)!.body.message;
  expect(first.notification).toBeUndefined();
  expect(first.apns).toBeUndefined();
  expect(first.data).toEqual({ title: "Maria", body: "Preciso de ajuda com o pedido", ...messages[0].data });
  expect(first.android).toEqual({ priority: "high", collapse_key: "conversa-1" });
  const ios = sent.find((c) => c.body.message.token === messages[1].token)!.body.message;
  expect(ios.notification).toEqual({ title: "Maria", body: "Preciso de ajuda com o pedido" });
  expect(ios.android.notification.channel_id).toBe("messages");
  expect(ios.apns.payload.aps.category).toBe("MESSAGE");
  expect(ios.apns.payload.aps["interruption-level"]).toBe("time-sensitive");
  const third = sent.find((c) => c.body.message.token === messages[2].token)!.body.message;
  expect(third.android.priority).toBe("high");
  expect(third.data).toEqual({ title: "Maria", body: "Preciso de ajuda com o pedido" });
  // Registro só com contagens: nada de tokens, títulos ou corpos.
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("5 mensagem(ns) ok=1 unregistered=2 error=2");
  for (const secret of [TOKEN, "Maria", "Preciso", "wabotia.exemplo", "198.51.100.7"])
    expect(logs[0]).not.toContain(secret);
});

it("limita mensagens por minuto por IP com 429 e Retry-After", async () => {
  const ip = { "CF-Connecting-IP": "203.0.113.9" };
  const batch = Array.from({ length: 100 }, (_, i) =>
    valid({ token: `token-${String(i).padStart(3, "0")}-0123456789abcdef` }),
  );
  for (let i = 0; i < RATE_LIMIT / 100; i++) {
    const r = await push({ messages: batch }, envWithAccount, ip);
    expect(r.status).toBe(200);
  }
  const blocked = await push({ messages: [valid()] }, envWithAccount, ip);
  expect(blocked.status).toBe(429);
  expect(blocked.json.error.code).toBe("rate_limited");
  const retry = Number(blocked.headers.get("Retry-After"));
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(60);
  // Outro IP não é afetado.
  const other = await push({ messages: [valid()] }, envWithAccount, {
    "CF-Connecting-IP": "203.0.113.10",
  });
  expect(other.status).toBe(200);
  const sent = calls.filter((c) => c.url.hostname === "fcm.googleapis.com");
  expect(sent).toHaveLength(RATE_LIMIT + 1);
});
