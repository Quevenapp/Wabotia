import { randomUUID } from "node:crypto";
const base = process.env.WABOTIA_URL,
  key = process.env.WABOTIA_KEY;
if (!base || !key)
  throw Error("Defina WABOTIA_URL e WABOTIA_KEY no ambiente do seu servidor.");
export async function request(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  idempotencyKey = randomUUID(),
) {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(JSON.stringify({ status: r.status, ...value }));
  return value;
}
const profiles = await request("/profiles"),
  profile = process.env.WABOTIA_PROFILE || profiles[0]?.id;
if (!profile) throw Error("Sem perfis autorizados.");
const p = "/profiles/" + profile;
const conversation = await request(p + "/conversations", {
  external_id: "exemplo-" + randomUUID(),
  message_id: randomUUID(),
  text: "Olá! Quero acompanhar uma solicitação.",
});
await request(
  p + "/conversations/" + conversation.conversation_id + "/actions",
  { action: "claim" },
);
await request(
  p + "/conversations/" + conversation.conversation_id + "/actions",
  { action: "reply", text: "Recebemos sua solicitação." },
);
const ticket = await request(p + "/tickets", {
  conversation_id: conversation.conversation_id,
  title: "Solicitação enviada pelo sistema externo",
});
console.log({
  conversation_id: conversation.conversation_id,
  ticket: ticket.number,
});
if (process.env.WABOTIA_BOT) {
  const run = await request("/bot-runs", {
    profile_id: profile,
    bot_id: process.env.WABOTIA_BOT,
    input: "Retorne uma saudação curta, sem usar ferramentas.",
  });
  console.log({ run_id: run.id });
  console.log(await request("/bot-runs/" + run.id));
}
