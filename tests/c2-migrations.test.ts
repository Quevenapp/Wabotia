import { env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

type Migration = { name: string; queries: string[] };
const env = testEnv as unknown as Env & { TEST_MIGRATIONS: Migration[] };
const additions = env.TEST_MIGRATIONS.filter(migration => /^014[4-7]_/.test(migration.name));
const tables = [
  "channel_delivery_state", "channel_public_grants", "channel_comments", "telegram_callbacks",
  "tiktok_send_slots", "reviews", "channel_sync_state", "email_channel_addresses", "email_channel_inbox",
  "email_channel_blocks", "email_channel_probes",
];
const preserved = ["users", "profiles", "connections", "conversations", "contacts", "messages", "inbox", "outbox", "receipts", "email_log"];

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Rede inesperada no teste de migrações da segunda leva."); });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** Aplica os SQL reais em nomes isolados no mesmo D1 de teste, sem novo binding. */
async function baseline() {
  const prefix = `c2_${crypto.randomUUID().replaceAll("-", "")}_`;
  const names = new Map<string, string>();
  for (const migration of env.TEST_MIGRATIONS) for (const query of migration.queries)
    for (const match of query.matchAll(/\bCREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)/gi))
      names.set(match[1], `${prefix}${match[1]}`);
  const sql = (query: string) => query.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*/gi,
    token => names.get(token) ?? token,
  );
  const statement = (query: string, ...params: unknown[]) => env.DB.prepare(sql(query)).bind(...params);
  const run = (query: string, ...params: unknown[]) => statement(query, ...params).run();
  const rows = async (query: string, ...params: unknown[]) => (await statement(query, ...params).all<Record<string, unknown>>()).results;
  for (const migration of env.TEST_MIGRATIONS.filter(item => Number(item.name.slice(0, 4)) < 144))
    for (const query of migration.queries) await run(query);
  return { prefix, run, rows, statement };
}
type Fixture = Awaited<ReturnType<typeof baseline>>;

async function seed(f: Fixture) {
  for (const area of ["area", "other"])
    await f.run("INSERT INTO profiles(id,name,created) VALUES(?,?,1)", area, area);
  await f.run("INSERT INTO users(id,email,name,password,role,created) VALUES('operator','operator@example.test','Pessoa','hash','admin',1)");
  for (const [id, profile, channel] of [["wa", "area", "whatsapp"], ["ig", "area", "instagram"], ["fb", "area", "facebook"], ["other", "other", "whatsapp"], ["new", "area", "whatsapp"], ["new-2", "area", "whatsapp"]])
    await f.run("INSERT INTO connections(id,profile_id,name,kind,mode,status,channel,config,created) VALUES(?,?,?,'zernio','direct','active',?,'{}',1)", id, profile, id, channel);
  for (const [id, profile, connection, channel] of [["wa-conversation", "area", "wa", "whatsapp"], ["ig-conversation", "area", "ig", "instagram"], ["fb-conversation", "area", "fb", "facebook"], ["other-conversation", "other", "other", "whatsapp"]]) {
    await f.run("INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,channel) VALUES(?,?,?,?,'subject','session',1,1,1,?)", id, profile, connection, `channel:${connection}`, channel);
    await f.run("INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,source_key,created) VALUES(?,?,?,'customer','customer','Histórico com acentos',?,1)", `${id}-message`, profile, id, `${id}-event`);
  }
  await f.run("INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES('contact','area','team','Pessoa','','pessoa','manual','operator','operator',1,1)");
  await f.run("INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES('legacy-inbox','area','legacy-event','wa-conversation','{}',1)");
  await f.run("INSERT INTO outbox(id,profile_id,conversation_id,connection_id,kind,actor,payload,dedupe,created,updated) VALUES('legacy-outbox','area','wa-conversation','wa','text','operator','{}','legacy-command',1,1)");
  await f.run("INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES('legacy','legacy-command','hash','{}',200,1)");
  await f.run("INSERT INTO email_log(id,profile_id,module_id,user_id,purpose,to_masked,to_hash,status,key,created) VALUES('legacy-email','area','orders','operator','module.notice','p***@example.test','hash','sent','legacy-email',1)");
}

describe("c2-base: migrações aditivas", () => {
  it.each([false, true])("preserva o banco anterior preenchido=%s e não ativa canal não usado", async populated => {
    const f = await baseline();
    if (populated) await seed(f);
    const before = new Map<string, Record<string, unknown>[]>();
    for (const table of preserved) before.set(table, await f.rows(`SELECT * FROM ${table} ORDER BY rowid`));
    const beforeIndexes = await f.rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name GLOB ? ORDER BY name", `${f.prefix}*`);
    expect(additions.map(item => item.name)).toEqual([
      "0144_channel_extensions.sql", "0145_comments_telegram_tiktok.sql", "0146_google_reviews.sql", "0147_email_channel.sql",
    ]);
    for (const migration of additions) {
      expect(migration.queries.join("\n")).not.toMatch(/\b(?:ALTER|DROP|RENAME|DELETE|UPDATE|INSERT)\b/i);
      for (const query of migration.queries) await f.run(query);
    }
    for (const table of preserved)
      expect(await f.rows(`SELECT * FROM ${table} ORDER BY rowid`)).toEqual(before.get(table));
    for (const table of tables) expect(await f.rows(`SELECT * FROM ${table}`)).toEqual([]);
    const afterIndexes = await f.rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name GLOB ? ORDER BY name", `${f.prefix}*`);
    for (const index of beforeIndexes) expect(afterIndexes).toContainEqual(index);
    // Nenhum índice novo toca as tabelas usadas por WhatsApp ou DMs da primeira leva.
    const newIndexes = afterIndexes.filter(index => !beforeIndexes.some(old => old.name === index.name));
    for (const index of newIndexes) expect(String(index.sql)).not.toMatch(new RegExp(`ON\\s+${f.prefix}(?:messages|conversations|inbox|outbox|contacts|connections)\\s*\\(`, "i"));
    if (!populated) await seed(f);
    await assertConstraints(f);
    for (const table of [...preserved, ...tables]) expect(await f.rows(`PRAGMA foreign_key_check(${table})`)).toEqual([]);
  }, 120_000);
});

async function assertConstraints(f: Fixture) {
  const review = (id: string, profile = "area", rating = 5) => f.run(
    "INSERT INTO reviews(id,profile_id,connection_id,account_id,remote_id,rating,last_event_key,created,updated) VALUES(?,?,'new','account','review-remote',?,'review-event',1,1)", id, profile, rating);
  await review("review");
  await expect(review("review-duplicate")).rejects.toThrow(/UNIQUE/i);
  await expect(review("review-wrong-rating", "area", 6)).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE reviews SET version=0 WHERE id='review'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE reviews SET state='absent' WHERE id='review'")).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT id FROM conversations ORDER BY id")).toHaveLength(4);
  expect(await f.rows("SELECT id FROM contacts")).toEqual([{ id: "contact" }]);
  await f.run("INSERT INTO channel_sync_state(profile_id,connection_id,kind,activation_at,next_at,updated) VALUES('area','new','google.reviews',1,1,1)");
  await expect(f.run("INSERT INTO channel_sync_state(profile_id,connection_id,kind,activation_at,next_at,updated) VALUES('area','new','other',1,1,1)")).rejects.toThrow(/CHECK/i);

  await f.run("INSERT INTO outbox(id,profile_id,conversation_id,connection_id,kind,actor,payload,dedupe,created,updated) VALUES('review-outbox','area',NULL,'new','channel','operator','{}','review-command',1,1)");
  const delivery = (id: string, context = "{}") => f.run(
    "INSERT INTO channel_delivery_state(outbox_id,profile_id,connection_id,resource_key,operation,request_hash,result_context,created,updated) VALUES(?,'area','new','review:review','google.reply','hash',?,1,1)", id, context);
  await delivery("review-outbox");
  await expect(delivery("review-outbox")).rejects.toThrow(/UNIQUE/i);
  await expect(delivery("missing")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE channel_delivery_state SET result_context='not-json'")).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT conversation_id FROM outbox WHERE id='review-outbox'")).toEqual([{ conversation_id: null }]);
  await f.run("INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES('area','operator','google.reply','operator',1)");
  await expect(f.run("INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES('area','operator','google.reply','operator',1)")).rejects.toThrow(/UNIQUE/i);
  await expect(f.run("INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES('area','operator','reports.read','operator',1)")).rejects.toThrow(/CHECK/i);
  await expect(f.run("INSERT INTO channel_public_grants(profile_id,user_id,permission,granted_by,created) VALUES('area','missing','google.reply','operator',1)")).rejects.toThrow(/FOREIGN KEY/i);

  const comment = (id: string, conversation = "ig-conversation", remote = id, message = "ig-conversation-message") => f.run(
    "INSERT INTO channel_comments(id,profile_id,connection_id,channel,account_id,post_id,remote_id,author_id,conversation_id,message_id,created,updated) VALUES(?,'area','new','instagram','account','post',?,'author',?,?,1,1)", id, remote, conversation, message);
  await comment("comment");
  await expect(comment("comment-duplicate", "ig-conversation", "comment")).rejects.toThrow(/UNIQUE/i);
  await expect(comment("comment-wrong-area", "other-conversation")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(comment("comment-missing-message", "ig-conversation", "missing", "missing")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE channel_comments SET private_state='reserved' WHERE id='comment'")).rejects.toThrow(/CHECK/i);
  await f.run("UPDATE channel_comments SET private_state='reserved',private_command_id='private-command' WHERE id='comment'");
  await expect(f.run("UPDATE channel_comments SET private_conversation_id='other-conversation' WHERE id='comment'")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE channel_comments SET hidden=2 WHERE id='comment'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE channel_comments SET post_context='not-json' WHERE id='comment'")).rejects.toThrow(/CHECK/i);
  await f.run("INSERT INTO telegram_callbacks(token_hash,profile_id,connection_id,conversation_id,subject_id,menu_token,option_id,epoch,expires,created) VALUES('callback','area','new','ig-conversation','subject','menu','option',1,100,1)");
  await expect(f.run("UPDATE telegram_callbacks SET conversation_id='other-conversation'")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,outbox_id,provider_message_id,state,counted_at,created,updated) VALUES('slot','area','new','ig-conversation','review-outbox','remote-send','sent',1,1,1)");
  await expect(f.run("INSERT INTO tiktok_send_slots(id,profile_id,connection_id,conversation_id,provider_message_id,state,counted_at,created,updated) VALUES('duplicate-slot','area','new','ig-conversation','remote-send','external',1,1,1)")).rejects.toThrow(/UNIQUE/i);
  await expect(f.run("UPDATE tiktok_send_slots SET conversation_id='other-conversation'")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE tiktok_send_slots SET state='pending'")).rejects.toThrow(/CHECK/i);

  await f.run("INSERT INTO email_channel_addresses(connection_id,profile_id,address,created,updated) VALUES('new','area','support@example.test',1,1)");
  expect(await f.rows("SELECT active,verified_at FROM email_channel_addresses")).toEqual([{ active: 0, verified_at: null }]);
  await expect(f.run("INSERT INTO email_channel_addresses(connection_id,profile_id,address,created,updated) VALUES('new-2','area','support@example.test',1,1)")).rejects.toThrow(/UNIQUE/i);
  await expect(f.run("INSERT INTO email_channel_addresses(connection_id,profile_id,address,created,updated) VALUES('other','area','other@example.test',1,1)")).rejects.toThrow(/FOREIGN KEY/i);
  const email = (id: string, overrides: { event?: string; messageId?: string | null; state?: string; size?: number; sender?: string } = {}) => f.run(
    "INSERT INTO email_channel_inbox(id,profile_id,connection_id,event_key,sender,recipient,rfc_message_id,raw_hash,raw_size,state,next_at,created,updated) VALUES(?,'area','new',?,?,'support@example.test',?,'raw-hash',?,?,1,1,1)",
    id, overrides.event ?? id, overrides.sender ?? "person@example.test", overrides.messageId === undefined ? "<message@example.test>" : overrides.messageId, overrides.size ?? 1, overrides.state ?? "pending");
  await email("email");
  await expect(email("duplicate-event", { event: "email", messageId: null })).rejects.toThrow(/UNIQUE/i);
  await expect(email("duplicate-message")).rejects.toThrow(/UNIQUE/i);
  await email("quarantine", { state: "quarantine" });
  await email("other-sender", { sender: "other@example.test" });
  await email("no-message-id", { messageId: null });
  await email("second-no-message-id", { messageId: null });
  await expect(email("too-large", { messageId: null, size: 26_214_401 })).rejects.toThrow(/CHECK/i);
  await expect(email("negative-size", { messageId: null, size: -1 })).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE email_channel_inbox SET conversation_id='other-conversation' WHERE id='email'")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE email_channel_inbox SET attempts=-1 WHERE id='email'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE email_channel_inbox SET metadata='not-json' WHERE id='email'")).rejects.toThrow(/CHECK/i);
  await f.run("INSERT INTO email_channel_blocks(profile_id,connection_id,kind,value,actor_id,created) VALUES('area','new','domain','example.test','operator',1)");
  await expect(f.run("INSERT INTO email_channel_blocks(profile_id,connection_id,kind,value,actor_id,created) VALUES('area','new','domain','example.test','operator',1)")).rejects.toThrow(/UNIQUE/i);
  await f.run("INSERT INTO email_channel_probes(id,profile_id,connection_id,command_id,token_hash,expires,state,created) VALUES('probe','area','new','probe-command','hash',600001,'pending',1)");
  await expect(f.run("INSERT INTO email_channel_probes(id,profile_id,connection_id,command_id,token_hash,expires,state,created) VALUES('duplicate-probe','area','new','probe-command','hash',600001,'pending',1)")).rejects.toThrow(/UNIQUE/i);

  await expect(env.DB.batch([
    f.statement("INSERT INTO outbox(id,profile_id,kind,actor,payload,dedupe,created,updated) VALUES('rolled-back','area','channel','operator','{}','rollback',1,1)"),
    f.statement("INSERT INTO channel_delivery_state(outbox_id,profile_id,connection_id,resource_key,operation,request_hash,result_context,created,updated) VALUES('rolled-back','area','new','review:review','google.reply','hash','not-json',1,1)"),
  ])).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT id FROM outbox WHERE id='rolled-back'")).toEqual([]);
  expect(await f.rows("SELECT outbox_id FROM channel_delivery_state WHERE outbox_id='rolled-back'")).toEqual([]);

  // O hook de remoção limpa os registros operacionais. O schema conserva os
  // escopos históricos, inclusive a outbox sem conversa, após apagar a conexão.
  await expect(f.run("DELETE FROM connections WHERE id='new'")).rejects.toThrow(/FOREIGN KEY/i);
  for (const table of ["email_channel_addresses", "telegram_callbacks", "email_channel_probes"])
    await f.run(`DELETE FROM ${table} WHERE connection_id='new'`);
  await f.run("DELETE FROM connections WHERE id='new'");
  for (const table of ["reviews", "channel_comments", "tiktok_send_slots", "channel_delivery_state", "email_channel_inbox"])
    expect((await f.rows(`SELECT connection_id FROM ${table} WHERE connection_id='new'`)).length).toBeGreaterThan(0);
}
