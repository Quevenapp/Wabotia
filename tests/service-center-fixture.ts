import { env, SELF } from "cloudflare:test";
import { exec, one, all } from "../src/db";
import { defaults, json, now, uid, type Actor } from "../src/types";
import { conversation, inbound, perform } from "../src/service";
import { processInbox } from "../src/engine";
import { sha, MOBILE_TOKEN_PREFIX } from "../src/security";

// Shared by the 0.14 service-center tests: one enabled area with two Zernio
// lines, one QR line, an administrator and two operators.
export async function fixture() {
  const profile = uid(),
    line = uid(),
    second = uid(),
    qr = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Atendimento",
    JSON.stringify(defaults),
    now(),
  );
  for (const id of [line, second, qr])
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?, 'direct','active','{}',?)",
      id,
      profile,
      id,
      id === qr ? "qr" : "zernio",
      now(),
    );
  const people: Actor[] = [];
  for (const role of ["admin", "operator", "operator"] as const) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      id,
      `${id}@example.test`,
      id,
      "test",
      role,
      JSON.stringify([profile]),
      now(),
    );
    people.push({
      id,
      name: id,
      kind: "user",
      role,
      profiles: [profile],
      scopes: [],
      bots: [],
      rate: 100,
      runLimit: 10,
    });
  }
  return {
    profile,
    line,
    second,
    qr,
    admin: people[0],
    member: people[1],
    other: people[2],
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function receive(
  f: Fixture,
  line: string,
  text: string,
  phone = "5511999998888",
  content: any = {},
  extra: any = {},
) {
  const result = await inbound(
    env,
    f.profile,
    { external_id: phone, phone, message_id: uid(), text, content, ...extra },
    `channel:${line}`,
    line,
  );
  return conversation(env, result.conversation_id, f.profile);
}
export const configure = (f: Fixture, body: any) =>
  perform(env, f.admin, f.profile, "settings", body, uid());
export async function outbox(conversationId: string) {
  return (
    await all(
      env,
      "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid",
      conversationId,
    )
  ).map((row) => json(row.payload));
}
export const latest = async (conversationId: string) =>
  (await outbox(conversationId)).at(-1);
export async function drain(f: Fixture) {
  while (
    await one(
      env,
      "SELECT id FROM inbox WHERE profile_id=? AND status='pending'",
      f.profile,
    )
  )
    await processInbox(env, f.profile);
}
export const tickets = (conversationId: string) =>
  all(
    env,
    "SELECT * FROM tickets WHERE conversation_id=? ORDER BY created,rowid",
    conversationId,
  );
export const claim = (f: Fixture, actor: Actor, id: string) =>
  perform(
    env,
    actor,
    f.profile,
    "conversation.action",
    { id, action: "claim" },
    uid(),
  );

/** Mobile bearer session for HTTP tests, without the rate-limited login. */
export async function bearer(actor: Actor) {
  const token = MOBILE_TOKEN_PREFIX + uid() + uid();
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used) VALUES(?,?,?,'bearer',?,?,?)",
    await sha(token),
    actor.id,
    now() + 3600000,
    now(),
    "teste",
    now(),
  );
  return token;
}
export async function api(
  token: string,
  path: string,
  method = "GET",
  body?: any,
  key = uid(),
) {
  return SELF.fetch("https://test/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined
        ? { "Content-Type": "application/json", "Idempotency-Key": key }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** Application key with the given scopes on the fixture's area. */
export async function application(f: Fixture, scopes: string[]) {
  const id = uid(),
    token = "wab_" + uid();
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    id,
    "App",
    JSON.stringify([f.profile]),
    JSON.stringify(scopes),
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    id,
    await sha(token),
    token.slice(0, 12),
    now() + 600000,
    now(),
  );
  return { id, token };
}
/** Hermes connection plus one bot of the area; `enabled` as given. */
export async function bot(f: Fixture, enabled = true, name = "Atendente") {
  const connection = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'hermes','direct','active',?,?)",
    connection,
    f.profile,
    "Hermes",
    JSON.stringify({
      url: "https://hermes.example.com",
      api_url: "https://hermes.example.com",
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,?,?,?)",
    id,
    f.profile,
    connection,
    "default",
    name,
    enabled ? 1 : 0,
  );
  return id;
}
/** Brasília wall clock (UTC-3) as a Unix timestamp in milliseconds. */
export const brasilia = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
) => Date.UTC(year, month - 1, day, hour + 3, minute);
