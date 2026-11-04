#!/usr/bin/env node
// Only use on a dedicated staging installation: creates synthetic, channel-free data.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
const base = process.argv[2];
if (!base || !base.includes("staging"))
  throw Error("Informe a URL do ambiente staging.");
const secrets = JSON.parse(
  await readFile(".secrets.staging.local.json", "utf8"),
);
let credentials;
try {
  credentials = JSON.parse(await readFile(".smoke.local.json", "utf8"));
} catch {
  credentials = {
    email: "teste@wabotia.example",
    password: randomBytes(24).toString("hex"),
    name: "Validação técnica",
  };
  await writeFile(".smoke.local.json", JSON.stringify(credentials), {
    mode: 0o600,
  });
}
let cookie = "",
  bearer = "";
const evidence = [];
async function req(
  route,
  body,
  method = body === undefined ? "GET" : "POST",
  expected = 200,
  key = randomUUID(),
) {
  const r = await fetch(base + "/api/" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(bearer
        ? { Authorization: "Bearer " + bearer }
        : cookie
          ? { Cookie: cookie }
          : {}),
      ...(method !== "GET" ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await r.json();
  if (r.status !== expected)
    throw Error(
      route +
        " returned " +
        r.status +
        " (" +
        (parsed.error?.code || "unknown") +
        ")",
    );
  if (r.headers.has("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  evidence.push({ route, status: r.status });
  return parsed;
}
const state = await req("auth/status");
if (!state.initialized)
  await req(
    "auth/setup",
    { ...credentials, token: secrets.SETUP_TOKEN },
    "POST",
    201,
  );
await req("auth/login", credentials);
const profile = await req("v1/profiles", {
  name: "Homologação " + new Date().toISOString(),
});
const p = "v1/profiles/" + profile.id;
const app = await req("v1/applications", {
  name: "Integração de teste",
  profiles: [profile.id],
  scopes: [
    "conversations:read",
    "conversations:write",
    "tickets:read",
    "tickets:write",
    "events:read",
    "media:read",
    "media:write",
    "knowledge:write",
    "knowledge:read",
    "reports:read",
  ],
  bots: [],
});
const key = await req("v1/applications/" + app.id + "/keys", { days: 1 });
bearer = key.token;
const idem = randomUUID(),
  data = {
    external_id: "cliente-ficticio",
    message_id: "mensagem-1",
    text: "Mensagem sintética de homologação",
  };
const conv = await req(p + "/conversations", data, "POST", 200, idem);
const repeated = await req(p + "/conversations", data, "POST", 200, idem);
if (conv.conversation_id !== repeated.conversation_id)
  throw Error("Idempotence failed");
await req(
  p + "/conversations",
  { ...data, text: "corpo diferente" },
  "POST",
  409,
  idem,
);
await req(p + "/conversations/" + conv.conversation_id + "/actions", {
  action: "claim",
  actor: "nao-pode-substituir-aplicacao",
});
const ticket = await req(p + "/tickets", {
  conversation_id: conv.conversation_id,
  title: "Protocolo de teste",
});
await req(
  p + "/tickets/" + ticket.id,
  { status: "in_progress", text: "Andamento fictício" },
  "PATCH",
);
await req(p + "/conversations/" + conv.conversation_id + "/actions", {
  action: "reply",
  text: "Resposta sintética",
});
await req(p + "/conversations/" + conv.conversation_id);
await req(p + "/events");
await req(p + "/reports");
await req(p + "/knowledge", {
  title: "Conhecimento de teste",
  kind: "text",
  text: "Atendimento em horário comercial.",
});
const form = new FormData();
form.set(
  "file",
  new File(
    ["Arquivo fictício para validar backup e restauração."],
    "validacao.txt",
    { type: "text/plain" },
  ),
);
const upload = await fetch(base + "/api/" + p + "/media", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + bearer,
    "Idempotency-Key": randomUUID(),
  },
  body: form,
});
if (!upload.ok) throw Error("Upload falhou");
const uploaded = await upload.json();
const download = await fetch(
  base + "/api/" + p + "/media/" + uploaded.id + "/content",
  { headers: { Authorization: "Bearer " + bearer } },
);
if (!download.ok || !(await download.text()).includes("backup"))
  throw Error("Mídia inválida");
evidence.push(
  { route: p + "/media", status: upload.status },
  { route: p + "/media/" + uploaded.id + "/content", status: download.status },
);
bearer = "";
await req("v1/keys/" + key.id, undefined, "DELETE");
bearer = key.token;
await req("v1/profiles", undefined, "GET", 401);
await writeFile(
  "docs/reference/live-validation.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      environment: base,
      external_channels: false,
      checks: evidence,
    },
    null,
    2,
  ),
);
console.log(
  "Homologação sintética concluída: " +
    evidence.length +
    " verificações HTTP. Nenhum canal externo foi conectado.",
);
