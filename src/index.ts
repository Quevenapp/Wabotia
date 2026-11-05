import { report } from "./reports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { visibleEvent, visibleConversation } from "./visibility";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  type Bindings,
  type Env,
  type Actor,
  ApiError,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { all, one, exec, batch } from "./db";
import {
  authenticate,
  access,
  admin,
  canProfile,
  sha,
  random,
  passwordHash,
  passwordVerify,
  rate,
  secret,
  setSecret,
  equal,
  hmac,
  hex,
} from "./security";
import { wake } from "./events";
import { settings, scopes, eventTypes, conversation, perform } from "./service";
import {
  discover,
  probe,
  configureTelegram,
  telegramFile,
  storeRemoteMedia,
  telegram,
} from "./integrations";
import { openapi } from "./openapi";
import { buildInfo } from "./build-info.generated";
import { checkUpdate, updatePlan, updateStatus } from "./updates";
import {
  cloudflareJobs,
  cloudflareSettings,
  connectorDownload,
} from "./cloudflare";
export { Coordinator } from "./coordinator";
const app = new Hono<Bindings>();
app.use(
  "*",
  bodyLimit({
    maxSize: 21 * 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "payload_too_large",
            message: "Limite de 20 MB por arquivo.",
          },
        },
        413,
      ),
  }),
);
app.use("*", async (c, next) => {
  c.set("requestId", uid());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  if (c.res.status === 429) c.header("Retry-After", "60");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});
app.onError((error, c) => {
  const known = error instanceof ApiError;
  if (known && error.status === 429) c.header("Retry-After", "60");
  if (!known)
    console.error(
      JSON.stringify({
        request_id: c.get("requestId"),
        error: error instanceof SyntaxError ? "invalid_json" : "internal_error",
      }),
    );
  return c.json(
    {
      error: {
        code: known ? error.code : "internal_error",
        message: known
          ? error.message
          : "Não foi possível concluir a operação.",
        request_id: c.get("requestId"),
      },
    },
    (known ? error.status : 500) as any,
  );
});
app.get("/api/health", (c) =>
  c.json({
    service: "wabotia",
    ...buildInfo,
    runtime: "cloudflare-workers",
  }),
);
app.get("/api/system/update-plan", async (c) =>
  c.json(await updatePlan(c.env)),
);
app.get("/api/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));
app.get("/api/auth/status", async (c) => {
  const count = await one(c.env, "SELECT count(*) n FROM users");
  return c.json({
    initialized: count.n > 0,
    configured: !!c.env.MASTER_KEY && !!c.env.SETUP_TOKEN,
  });
});
app.use("/api/auth/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (c.req.method === "POST" && origin && origin !== new URL(c.req.url).origin)
    throw new ApiError(403, "invalid_origin", "Origem inválida.");
  await next();
});
app.post("/api/auth/setup", async (c) => {
  await rate(
    c.env,
    `setup:${c.req.header("CF-Connecting-IP") || "local"}`,
    5,
    600000,
  );
  requireValue(
    c.env.SETUP_TOKEN && c.env.MASTER_KEY,
    "Configure SETUP_TOKEN e MASTER_KEY antes de continuar.",
  );
  const data = await c.req.json();
  if (!equal(data.token || "", c.env.SETUP_TOKEN))
    throw new ApiError(
      403,
      "invalid_setup_token",
      "Código de instalação inválido.",
    );
  if ((await one(c.env, "SELECT count(*) n FROM users")).n)
    throw new ApiError(
      409,
      "already_initialized",
      "Instalação já configurada.",
    );
  requireValue(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""),
    "E-mail inválido.",
  );
  const id = uid();
  await batch(c.env, [
    [
      "INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,?,?)",
      ["installation", "bootstrap", "bootstrap", "{}", 200, now()],
    ],
    [
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        String(data.email || "")
          .trim()
          .toLowerCase(),
        String(data.name || "Administrador").slice(0, 100),
        passwordHash(data.password),
        "admin",
        "[]",
        now(),
      ],
    ],
  ]);
  return c.json({ created: true }, 201);
});
app.post("/api/auth/login", async (c) => {
  await rate(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    10,
    600000,
  );
  const data = await c.req.json();
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE email=? AND disabled=0",
    String(data.email || "").toLowerCase(),
  );
  if (!user || !passwordVerify(String(data.password || ""), user.password))
    throw new ApiError(
      401,
      "invalid_credentials",
      "E-mail ou senha inválidos.",
    );
  const token = random();
  await exec(
    c.env,
    "INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)",
    await sha(token),
    user.id,
    now() + 43200000,
  );
  setCookie(c, "wabotia", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 43200,
  });
  return c.json({ ok: true });
});
app.use("/api/v1/*", async (c, next) => {
  c.set("actor", await authenticate(c.env, c.req.raw));
  await next();
});
app.get("/api/v1/me", (c) => c.json(c.get("actor")));
app.post("/api/v1/logout", async (c) => {
  const cookie = c.req.header("Cookie")?.match(/wabotia=([^;]+)/)?.[1];
  if (cookie)
    await exec(c.env, "DELETE FROM sessions WHERE hash=?", await sha(cookie));
  deleteCookie(c, "wabotia", { path: "/" });
  return c.json({ ok: true });
});
app.get("/api/v1/profiles", async (c) =>
  c.json(
    (await all(c.env, "SELECT * FROM profiles ORDER BY created"))
      .filter((p) => canProfile(c.get("actor"), p.id))
      .map((p) =>
        c.get("actor").kind === "app"
          ? { id: p.id, name: p.name, enabled: p.enabled }
          : { ...p, settings: json(p.settings) },
      ),
  ),
);
app.get("/api/v1/users", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT id,email,name,role,profiles,telegram_id,disabled FROM users ORDER BY created",
    ),
  );
});
app.get("/api/v1/applications", async (c) => {
  admin(c.get("actor"));
  return c.json({
    applications: await all(
      c.env,
      "SELECT * FROM applications ORDER BY created DESC",
    ),
    keys: await all(
      c.env,
      "SELECT id,app_id,prefix,expires,revoked,created FROM api_keys",
    ),
    scopes,
    event_types: eventTypes,
  });
});
async function mutate(c: any, op: string, profile: string, data: any) {
  const key = c.req.header("Idempotency-Key");
  requireValue(
    key && key.length <= 200 && /^[\x21-\x7e]+$/.test(key),
    "Envie Idempotency-Key (até 200 caracteres ASCII).",
  );
  if (profile !== "_admin" && !canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  return c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(profile)).fetch(
    "https://coordinator/command",
    {
      method: "POST",
      body: JSON.stringify({
        profile,
        operation: op,
        actor: c.get("actor"),
        data,
        key,
        requestId: c.get("requestId"),
      }),
    },
  );
}
app.get("/api/v1/system", async (c) => {
  admin(c.get("actor"));
  return c.json({
    updates: await updateStatus(c.env),
    cloudflare: await cloudflareSettings(c.env),
    deployments: await cloudflareJobs(c.env),
  });
});
app.get("/api/v1/system/updates/check", async (c) => {
  admin(c.get("actor"));
  await rate(c.env, `updates:${c.get("actor").id}`, 5);
  await checkUpdate(c.env);
  return c.json(await updateStatus(c.env));
});
app.get("/api/v1/system/cloudflare/:id/connector", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await connectorDownload(c.env, c.get("actor"), c.req.param("id")),
  );
});
for (const [path, operation] of [
  ["cloudflare/configure", "cloudflare.save"],
  ["cloudflare/deploy", "cloudflare.create"],
  ["cloudflare/retry", "cloudflare.retry"],
  ["updates/configure", "updates.configure"],
  ["updates/start", "updates.start"],
  ["updates/reset", "updates.reset"],
])
  app.post("/api/v1/system/" + path, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "system." + operation, "_admin", await c.req.json());
  });
for (const [method, path, op] of [
  ["post", "profiles", "profile.create"],
  ["post", "users", "user.create"],
  ["patch", "users/:id", "user.update"],
  ["post", "applications", "application.create"],
  ["patch", "applications/:id", "application.update"],
  ["post", "applications/:id/keys", "key.create"],
  ["delete", "keys/:id", "key.revoke"],
] as const) {
  app.on(method.toUpperCase(), `/api/v1/${path}`, async (c) => {
    admin(c.get("actor"));
    const data = method === "delete" ? {} : await c.req.json();
    return mutate(c, op, "_admin", {
      ...data,
      id: c.req.param("id"),
      ...(op === "key.create" ? { app_id: c.req.param("id") } : {}),
    });
  });
}
const commands = [
  ["PUT", "settings", "settings"],
  ["POST", "activate", "activate"],
  ["POST", "pause", "pause"],
  ["POST", "connections", "connection.save"],
  ["PUT", "connections/:id/state", "connection.state"],
  ["PATCH", "bots/:id", "bot.update"],
  ["POST", "conversations", "conversation.create"],
  ["POST", "inbound", "inbound"],
  ["POST", "conversations/:id/actions", "conversation.action"],
  ["PUT", "presence", "presence"],
  ["POST", "tickets", "ticket.create"],
  ["PATCH", "tickets/:id", "ticket.update"],
  ["POST", "consents/request", "consent.request"],
  ["POST", "bot-runs", "run.create"],
  ["POST", "bot-runs/:id/cancel", "run.cancel"],
  ["POST", "knowledge", "knowledge.create"],
  ["DELETE", "knowledge/:id", "knowledge.delete"],
  ["POST", "webhook-subscriptions", "webhook.create"],
  ["DELETE", "webhook-subscriptions/:id", "webhook.disable"],
  ["POST", "webhook-deliveries/:id/retry", "webhook.retry"],
  ["POST", "deliveries/:id/reconcile", "delivery.reconcile"],
  ["POST", "bot-runs/:id/reconcile", "run.reconcile"],
];
for (const [method, path, op] of commands)
  app.on(method, `/api/v1/profiles/:profile/${path}`, async (c) =>
    mutate(c, op, c.req.param("profile")!, {
      ...(method === "DELETE" ? {} : await c.req.json().catch(() => ({}))),
      ...(c.req.param("id") ? { id: c.req.param("id") } : {}),
    }),
  );
app.post("/api/v1/bot-runs", async (c) => {
  const data = await c.req.json();
  requireValue(typeof data.profile_id === "string", "Informe profile_id.");
  return mutate(c, "run.create", data.profile_id, data);
});
app.get("/api/v1/bot-runs/:id", async (c) => {
  const run = await one(
    c.env,
    "SELECT * FROM bot_runs WHERE id=?",
    c.req.param("id"),
  );
  if (!run) throw new ApiError(404, "not_found", "Execução não encontrada.");
  access(c.get("actor"), run.profile_id, "bots:invoke");
  if (c.get("actor").kind === "app" && run.actor !== c.get("actor").id)
    throw new ApiError(404, "not_found", "Execução não encontrada.");
  run.attachments = json(run.result, {}).attachments || [];
  delete run.context;
  delete run.request_body;
  return c.json(run);
});
app.use("/api/v1/profiles/:profile/*", async (c, next) => {
  if (!canProfile(c.get("actor"), c.req.param("profile")!))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  await next();
});
app.get("/api/v1/profiles/:profile/status", async (c) => {
  const p = c.req.param("profile");
  if (c.get("actor").kind === "app")
    throw new ApiError(
      403,
      "panel_only",
      "Use os recursos autorizados da API.",
    );
  return c.json({
    settings: await settings(c.env, p),
    enabled: (await one(c.env, "SELECT enabled FROM profiles WHERE id=?", p))
      ?.enabled,
    conversations: await all(
      c.env,
      "SELECT state,count(*) count FROM conversations WHERE profile_id=? GROUP BY state",
      p,
    ),
    deliveries: await all(
      c.env,
      "SELECT status,count(*) count FROM outbox WHERE profile_id=? GROUP BY status",
      p,
    ),
    connections: await all(
      c.env,
      "SELECT id,name,kind,status,last_seen FROM connections WHERE profile_id=?",
      p,
    ),
  });
});
app.get("/api/v1/profiles/:profile/connections", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT * FROM connections WHERE profile_id=?",
      c.req.param("profile"),
    ),
  );
});
for (const op of ["test", "discover", "telegram-webhook", "connector-token"])
  app.post("/api/v1/profiles/:profile/connections/:id/" + op, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "connection." + op, c.req.param("profile")!, {
      id: c.req.param("id"),
      origin: new URL(c.req.url).origin,
    });
  });
app.post("/api/v1/profiles/:profile/jev", async (c) =>
  mutate(c, "jev", c.req.param("profile"), await c.req.json()),
);
const readLists: Record<string, [string, string]> = {
  bots: ["bots", "bots:read"],
  tickets: ["tickets", "tickets:read"],
  knowledge: ["documents", "knowledge:read"],
  surveys: ["surveys", "reports:read"],
  consents: ["consents", "conversations:read"],
  deliveries: ["outbox", "conversations:read"],
  "bot-runs": ["bot_runs", "bots:invoke"],
  media: ["media", "media:read"],
};
for (const [path, [table, scope]] of Object.entries(readLists))
  app.get(`/api/v1/profiles/:profile/${path}`, async (c) => {
    const p = c.req.param("profile")!;
    access(c.get("actor"), p, scope);
    const actor = c.get("actor"),
      limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100)),
      cursor = c.req.query("cursor") || "";
    let filter = "",
      params: any[] = [p, cursor];
    if (actor.kind === "app") {
      if (table === "bots") {
        filter += " AND id IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(actor.bots));
      }
      if (table === "bot_runs" || table === "media") {
        filter += " AND actor=?";
        params.push(actor.id);
      }
      if (["tickets", "surveys", "consents", "outbox"].includes(table)) {
        filter += ` AND conversation_id IN (SELECT id FROM conversations WHERE external_namespace NOT LIKE 'app:%' OR external_namespace=?)`;
        params.push("app:" + actor.id);
      }
    }
    const rows = await all(
      c.env,
      `SELECT * FROM ${table} WHERE profile_id=? AND id>? ${filter} ORDER BY id LIMIT ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    rows.splice(limit);
    for (const row of rows) {
      delete row.object_key;
      delete row.context;
      delete row.request_body;
    }
    return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
  });
app.get("/api/v1/profiles/:profile/conversations", async (c) => {
  const p = c.req.param("profile");
  access(c.get("actor"), p, "conversations:read");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  let after: any = null;
  try {
    after = c.req.query("cursor")
      ? JSON.parse(atob(c.req.query("cursor")!))
      : null;
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
  }
  const state = c.req.query("state") || "",
    q = (c.req.query("q") || "").slice(0, 200);
  const rows = await all(
    c.env,
    "SELECT * FROM conversations WHERE profile_id=? AND (?='' OR state=?) AND (external_id LIKE ? OR phone LIKE ?) AND (?=1 OR external_namespace NOT LIKE 'app:%' OR external_namespace=?) AND (? IS NULL OR updated<? OR (updated=? AND id<?)) ORDER BY updated DESC,id DESC LIMIT ?",
    p,
    state,
    state,
    `%${q}%`,
    `%${q}%`,
    c.get("actor").kind !== "app" ? 1 : 0,
    "app:" + c.get("actor").id,
    after?.[0] ?? null,
    after?.[0] ?? 0,
    after?.[0] ?? 0,
    after?.[1] ?? "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  const last = rows.at(-1);
  return c.json({
    data: rows,
    next_cursor:
      more && last ? btoa(JSON.stringify([last.updated, last.id])) : null,
  });
});
app.get("/api/v1/profiles/:profile/conversations/:id", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "conversations:read");
  const conv = await conversation(c.env, c.req.param("id"), p, actor);
  const notes = actor.kind !== "app" || actor.scopes.includes("notes:read");
  return c.json({
    conversation: conv,
    messages: await all(
      c.env,
      "SELECT * FROM messages WHERE conversation_id=? AND (?=1 OR direction!='note') ORDER BY created,id",
      conv.id,
      notes ? 1 : 0,
    ),
    deliveries: await all(
      c.env,
      "SELECT id,status,error,created FROM outbox WHERE conversation_id=? ORDER BY created",
      conv.id,
    ),
  });
});
app.get("/api/v1/profiles/:profile/presence", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "presence:read");
  return c.json(
    await all(
      c.env,
      "SELECT u.id actor,u.name,coalesce(p.present,0) present,u.telegram_id FROM users u LEFT JOIN presence p ON p.actor=u.id AND p.profile_id=? WHERE u.disabled=0 AND (u.role='admin' OR EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?))",
      c.req.param("profile"),
      c.req.param("profile"),
    ),
  );
});
app.get("/api/v1/profiles/:profile/events", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "events:read");
  const after = Number(c.req.query("after")) || 0;
  const rows = await all(
    c.env,
    "SELECT * FROM events WHERE profile_id=? AND id>? ORDER BY id LIMIT 100",
    c.req.param("profile"),
    after,
  );
  return c.json({
    data: (
      await Promise.all(
        rows.map(async (e) =>
          (await visibleEvent(c.env, c.get("actor"), e))
            ? { ...e, payload: json(e.payload) }
            : null,
        ),
      )
    ).filter(Boolean),
    cursor: rows.at(-1)?.id || after,
  });
});
app.get("/api/v1/profiles/:profile/webhook-subscriptions", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  return c.json(
    await all(
      c.env,
      "SELECT * FROM webhook_subscriptions WHERE profile_id=? AND (?=1 OR app_id=?)",
      c.req.param("profile"),
      c.get("actor").role === "admin" ? 1 : 0,
      c.get("actor").id.slice(4),
    ),
  );
});
app.get("/api/v1/profiles/:profile/webhook-deliveries", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100));
  const rows = await all(
    c.env,
    "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND (?=1 OR s.app_id=?) AND d.id>? ORDER BY d.id LIMIT ?",
    c.req.param("profile"),
    c.get("actor").role === "admin" ? 1 : 0,
    c.get("actor").id.slice(4),
    c.req.query("cursor") || "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
});
app.get("/api/v1/profiles/:profile/reports", (c) =>
  report(
    c.env,
    c.get("actor"),
    c.req.param("profile"),
    new URL(c.req.url).searchParams,
  ),
);
app.post("/api/v1/profiles/:profile/media", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "media:write");
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size > 0 && file.size <= 20 * 1024 * 1024,
    "Envie um arquivo de até 20 MB.",
  );
  const idem = c.req.header("Idempotency-Key");
  requireValue(idem && idem.length <= 200, "Envie Idempotency-Key.");
  const bytes = await file.arrayBuffer(),
    digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = (await sha(actor.id + ":" + p + ":" + idem)).slice(0, 32),
    key = `${p}/${id}/${digest}`;
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const result = await mutate(c, "media.register", p, {
    id,
    object_key: key,
    name: file.name.slice(0, 200),
    type: file.type || "application/octet-stream",
    size: file.size,
    digest,
  });
  if (
    !result.ok &&
    !(await one(c.env, "SELECT id FROM media WHERE object_key=?", key))
  )
    await c.env.MEDIA.delete(key);
  return result;
});
app.get("/api/v1/profiles/:profile/media/:id/content", async (c) => {
  const p = c.req.param("profile");
  access(c.get("actor"), p, "media:read");
  const row = await one(
    c.env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    c.req.param("id"),
    p,
  );
  if (
    !row ||
    (c.get("actor").kind === "app" && row.actor !== c.get("actor").id)
  )
    throw new ApiError(404, "not_found", "Arquivo não encontrado.");
  const obj = await c.env.MEDIA.get(row.object_key);
  if (!obj) throw new ApiError(404, "not_found", "Arquivo ausente.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.type,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "no-store",
    },
  });
});
async function ingest(env: Env, conn: any, data: any) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(conn.profile_id)).fetch(
    "https://coordinator/inbound",
    {
      method: "POST",
      body: JSON.stringify({
        profile: conn.profile_id,
        data,
        namespace: `channel:${conn.id}`,
        connectionId: conn.id,
      }),
    },
  );
}
app.get("/webhooks/meta/:id", async (c) => {
  const keys = await secret(c.env, `connection:${c.req.param("id")}`);
  if (
    c.req.query("hub.mode") !== "subscribe" ||
    !keys.verify_token ||
    !equal(keys.verify_token, c.req.query("hub.verify_token") || "")
  )
    throw new ApiError(403, "verification_failed", "Verificação recusada.");
  return c.text(c.req.query("hub.challenge") || "");
});
app.post("/webhooks/meta/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='meta'",
    c.req.param("id"),
  );
  requireValue(conn, "Canal não encontrado.");
  const keys = await secret(c.env, `connection:${conn.id}`),
    raw = await c.req.text();
  if (
    !keys.app_secret ||
    !equal(
      c.req.header("X-Hub-Signature-256") || "",
      `sha256=${await hmac(keys.app_secret, raw)}`,
    )
  )
    throw new ApiError(403, "invalid_signature", "Assinatura inválida.");
  const body = JSON.parse(raw);
  for (const entry of body.entry || [])
    for (const change of entry.changes || []) {
      const v = change.value;
      if (v?.metadata?.phone_number_id !== json(conn.config).phone_id) continue;
      for (const m of v.messages || []) {
        const attachments: string[] = [];
        let value =
          m.text?.body ||
          m.interactive?.button_reply?.title ||
          m.interactive?.list_reply?.title ||
          "";
        const media = m.image || m.audio || m.document || m.video;
        if (media) {
          try {
            const meta = await fetch(
              `https://graph.facebook.com/v23.0/${media.id}`,
              { headers: { Authorization: `Bearer ${keys.token}` } },
            );
            const info = await meta.json<any>();
            const resource = await fetch(info.url, {
              headers: { Authorization: `Bearer ${keys.token}` },
            });
            attachments.push(
              await storeRemoteMedia(
                c.env,
                conn.profile_id,
                media.filename || m.type,
                info.mime_type || "application/octet-stream",
                resource,
              ),
            );
          } catch {
            value += "\n[Anexo indisponível; atendimento humano necessário]";
          }
        }
        const r = await ingest(c.env, conn, {
          external_id: m.from,
          phone: m.from,
          message_id: m.id,
          text: value,
          attachments,
        });
        if (!r.ok) return r;
      }
    }
  return c.json({ received: true });
});
app.post("/webhooks/telegram/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='telegram'",
    c.req.param("id"),
  );
  requireValue(conn, "Canal não encontrado.");
  const keys = await secret(c.env, `connection:${conn.id}`);
  if (
    !keys.webhook_secret ||
    !equal(
      keys.webhook_secret,
      c.req.header("X-Telegram-Bot-Api-Secret-Token") || "",
    )
  )
    throw new ApiError(403, "invalid_signature", "Segredo inválido.");
  const update = await c.req.json(),
    m = update.message;
  if (
    !m ||
    String(m.chat.id) !== String(json(conn.config).group) ||
    m.from?.is_bot ||
    m.sender_chat
  )
    return c.json({ ignored: true });
  if (conn.status !== "active") return c.json({ paused: true });
  if (/^\/identificar(?:@\S+)?\s*$/.test(m.text || "")) {
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: `Seu ID Telegram: ${m.from.id}. Solicite ao administrador o vínculo em Pessoas.`,
    });
    return c.json({ received: true });
  }
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE telegram_id=? AND disabled=0",
    String(m.from.id),
  );
  if (
    !user ||
    !(
      user.role === "admin" || json(user.profiles, []).includes(conn.profile_id)
    )
  )
    return c.json({ ignored: true });
  const actor: Actor = {
    id: user.id,
    kind: "user",
    name: user.name,
    role: user.role,
    profiles: json(user.profiles, []),
    scopes: [],
    bots: [],
    rate: 60,
    runLimit: 3,
  };
  const match = (m.text || m.caption || "").match(
      /^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/,
    ),
    cmd = match?.[1],
    value = match?.[2] || m.text || m.caption || "";
  const conv = await one(
    c.env,
    "SELECT id,owner FROM conversations WHERE profile_id=? AND topic=?",
    conn.profile_id,
    String(m.message_thread_id),
  );
  let operation = "",
    data: any = {};
  if (cmd === "ajuda") {
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: "/presente /ausente · No tópico: /assumir /responder texto /nota texto /transferir ID /encerrar /retomar. /identificar mostra seu ID.",
    });
    return c.json({ received: true });
  }
  if (cmd === "presente" || cmd === "ausente") {
    operation = "presence";
    data = { present: cmd === "presente" };
  } else if (conv) {
    const actions: Record<string, string> = {
      assumir: "claim",
      responder: "reply",
      nota: "note",
      encerrar: "resolve",
      retomar: "resume",
      transferir: "transfer",
    };
    const cfg = await settings(c.env, conn.profile_id);
    operation = "conversation.action";
    data = {
      id: conv.id,
      action:
        actions[cmd || ""] ||
        (cfg.reply_mode === "direct" &&
        conv.owner === actor.id &&
        !cmd &&
        (!m.reply_to_message ||
          (m.reply_to_message.from?.is_bot &&
            !m.reply_to_message.forum_topic_created))
          ? "reply"
          : "note"),
      text: value,
      target: value,
    };
    if (cmd === "transferir") {
      const target = await one(
        c.env,
        "SELECT id FROM users WHERE id=? OR telegram_id=?",
        value,
        value,
      );
      data.target = target?.id || value;
    }
    const file = m.document || m.audio || m.voice || m.photo?.at(-1);
    if (file) {
      data.attachments = [
        await telegramFile(
          c.env,
          conn,
          file.file_id,
          file.file_name || "telegram-file",
          file.mime_type || "image/jpeg",
        ),
      ];
      if (!data.text) data.text = "Anexo";
    }
  } else return c.json({ ignored: true });
  const result = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(conn.profile_id),
  ).fetch("https://coordinator/command", {
    method: "POST",
    body: JSON.stringify({
      profile: conn.profile_id,
      operation,
      data,
      actor,
      key: `telegram:${conn.id}:${update.update_id}`,
      requestId: c.get("requestId"),
    }),
  });
  if (result.status >= 500) return result;
  if (!result.headers.has("Idempotency-Replayed")) {
    const response = await result.clone().json<any>();
    await telegram(c.env, conn.id, "sendMessage", {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: result.ok
        ? operation === "presence"
          ? data.present
            ? "Presença registrada."
            : "Ausência registrada."
          : "Comando registrado."
        : response.error?.message || "Comando recusado.",
    }).catch(() => {});
  }
  return c.json({ received: true });
});
app.use("/internal/v1/connectors/:id/*", async (c, next) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind IN ('qr','hermes-whatsapp')",
    c.req.param("id"),
  );
  if (!conn) throw new ApiError(401, "unauthenticated", "Conector inválido.");
  const keys = await secret(c.env, `connection:${conn.id}`),
    token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  if (!keys.connector_hash || !equal(await sha(token), keys.connector_hash))
    throw new ApiError(401, "unauthenticated", "Token inválido.");
  await exec(
    c.env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
  await next();
});
app.post("/internal/v1/connectors/:id/events", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return ingest(c.env, conn, await c.req.json());
});
async function transportCommand(c: any, operation: string, data: any = {}) {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(conn.profile_id),
  ).fetch("https://coordinator/transport", {
    method: "POST",
    body: JSON.stringify({
      profile: conn.profile_id,
      connectionId: conn.id,
      operation,
      data,
    }),
  });
}
app.get("/internal/v1/connectors/:id/commands", (c) =>
  transportCommand(c, "commands"),
);
app.post("/internal/v1/connectors/:id/commands/:command/check", (c) =>
  transportCommand(c, "check", { id: c.req.param("command") }),
);
app.post("/internal/v1/connectors/:id/receipts", async (c) =>
  transportCommand(c, "receipt", await c.req.json()),
);
app.get("/internal/v1/connectors/:id/media/:media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const m = await one(
    c.env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    c.req.param("media"),
    conn.profile_id,
  );
  requireValue(m, "Arquivo não encontrado.");
  const obj = await c.env.MEDIA.get(m.object_key);
  requireValue(obj, "Arquivo ausente.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": m.type,
      "X-Filename": encodeURIComponent(m.name),
    },
  });
});
app.post("/internal/v1/connectors/:id/media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size <= 20 * 1024 * 1024,
    "Arquivo inválido.",
  );
  const id = await storeRemoteMedia(
    c.env,
    conn.profile_id,
    file.name,
    file.type,
    new Response(file.stream(), {
      headers: { "Content-Length": String(file.size) },
    }),
  );
  return c.json({ id });
});
app.get("/internal/v1/connectors/:id/policy", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.json({
    notifications: (await settings(c.env, conn.profile_id)).notifications,
  });
});
app.post("/internal/v1/connectors/:id/status", async (c) => {
  const data = await c.req.json(),
    conn = await one(
      c.env,
      "SELECT * FROM connections WHERE id=?",
      c.req.param("id"),
    );
  await exec(
    c.env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({
      ...json(conn.config),
      qr: data.qr || null,
      ...(data.approved_template
        ? {
            approved_template: data.approved_template,
            template_checked_at: now(),
          }
        : {}),
      ...(data.platform &&
      ["whatsapp", "whatsapp_cloud"].includes(data.platform)
        ? { platform: data.platform }
        : {}),
      transport_state: String(data.state || "unknown").slice(0, 40),
    }),
    conn.id,
  );
  return c.json({ ok: true });
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(wake(env, "_admin"));
    for (const profile of await all(env, "SELECT id FROM profiles"))
      ctx.waitUntil(wake(env, profile.id));
    ctx.waitUntil(
      exec(env, "DELETE FROM rate_limits WHERE expires<?", now() - 600000),
    );
    ctx.waitUntil(exec(env, "DELETE FROM sessions WHERE expires<?", now()));
  },
};
