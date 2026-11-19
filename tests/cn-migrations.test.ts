import { env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

type Migration = { name: string; queries: string[] };
const env = testEnv as unknown as Env & { TEST_MIGRATIONS: Migration[] };
const additions = env.TEST_MIGRATIONS.filter((m) => /^014[0-3]_/.test(m.name));

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Rede inesperada no teste de migrações de canais.");
  });
});
afterEach(() => vi.restoreAllMocks());

/** Migrações reais, em tabelas isoladas no D1 existente, sem novo binding. */
async function legacyFixture() {
  const prefix = `cn_${crypto.randomUUID().replaceAll("-", "")}_`;
  const names = new Map<string, string>();
  for (const migration of env.TEST_MIGRATIONS)
    for (const query of migration.queries)
      for (const match of query.matchAll(/\bCREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)/gi))
        names.set(match[1], `${prefix}${match[1]}`);
  // Preserva literais e comentários; renomeia referências também nos triggers.
  const sql = (query: string) => query.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*/gi,
    (token) => names.get(token) ?? token,
  );
  const statement = (query: string, params: unknown[] = []) => env.DB.prepare(sql(query)).bind(...params);
  const run = (query: string, ...params: unknown[]) => statement(query, params).run();
  const rows = async (query: string, ...params: unknown[]) =>
    (await statement(query, params).all<Record<string, unknown>>()).results;
  for (const migration of env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) < 140))
    for (const query of migration.queries) await run(query);
  return { prefix, run, rows, statement };
}
type Fixture = Awaited<ReturnType<typeof legacyFixture>>;

async function seed(f: Fixture) {
  for (const id of ["area", "other"])
    await f.run("INSERT INTO profiles(id,name,created) VALUES(?,?,1)", id, id);
  for (const [id, profile, kind] of [
    ["official", "area", "zernio"], ["qr", "area", "qr"], ["ai", "area", "ai"],
    ["social", "area", "zernio"], ["second-social", "area", "zernio"],
    ["third-social", "area", "zernio"], ["other-line", "other", "zernio"],
  ]) await f.run("INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct','active','{}',1)", id, profile, id, kind);
  for (const [id, profile] of [["integration", "area"], ["second-integration", "area"], ["other-integration", "other"]])
    await f.run("INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,?,?,'zernio',1)", id, profile, id, id);
  await f.run("INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES('official','integration','phone-id','2026-11',1)");
  for (const [id, profile, namespace] of [
    ["contact", "area", "team"], ["target", "area", "team"],
    ["app-contact", "area", "app:integration"], ["other-contact", "other", "team"],
  ]) await f.run("INSERT INTO contacts(id,profile_id,namespace,name,phone,email,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,?,'Pessoa','5511987654321','pessoa@example.test','Pessoa','manual','actor','actor',1,2)", id, profile, namespace);
  for (const [id, profile, connection, namespace] of [
    ["official-conversation", "area", "official", "channel:official"],
    ["qr-conversation", "area", "qr", "channel:qr"],
    ["app-conversation", "area", null, "app:integration"],
    ["other-conversation", "other", "other-line", "channel:other-line"],
  ]) await f.run("INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,'5511987654321','5511987654321','session',1,1,2)", id, profile, connection, namespace);
  await f.run("INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES('area','team','5511987654321','contact','ready')");
  await f.run("INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created) VALUES('area','team','5511987654321','contact','official-conversation',1)");
  await f.run("INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES('official-conversation','area','contact','identity',1)");
  await f.run("INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,source_key,created) VALUES('legacy-message','area','official-conversation','customer','customer','Histórico preservado','legacy-event',1)");
  await f.run("INSERT INTO email_log(id,profile_id,module_id,user_id,purpose,to_masked,to_hash,status,key,created) VALUES('legacy-email','area','orders','actor','module.notice','p***@example.test','hash','sent','legacy-key',1)");
}

const preservedTables = [
  "profiles", "connections", "conversations", "contacts", "meta_accounts", "meta_numbers",
  "customer_phones", "customer_phone_proofs", "conversation_contacts", "messages", "email_log",
];

describe("base aditiva dos canais — migrações D1", () => {
  it.each([false, true])("aplica 0140–0143 com banco anterior preenchido=%s e preserva só WhatsApp", async (populated) => {
    const f = await legacyFixture();
    if (populated) await seed(f);
    const before = new Map<string, Record<string, unknown>[]>();
    for (const table of preservedTables) before.set(table, await f.rows(`SELECT * FROM ${table} ORDER BY rowid`));
    const indexes = await f.rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name GLOB ? ORDER BY name", `${f.prefix}*`);
    expect(additions.map((m) => m.name)).toEqual([
      "0140_channels.sql", "0141_zernio_channel_accounts.sql",
      "0142_customer_channels_and_merges.sql", "0143_conversation_email.sql",
    ]);
    for (const migration of additions) {
      expect(migration.queries.join("\n")).not.toMatch(/\b(?:DROP|RENAME|DELETE|UPDATE|INSERT)\b/i);
      for (const query of migration.queries) await f.run(query);
    }
    for (const table of preservedTables) {
      const previous = before.get(table)!;
      const after = await f.rows(`SELECT * FROM ${table} ORDER BY rowid`);
      expect(after).toHaveLength(previous.length);
      expect(after.map((row, index) => Object.fromEntries(Object.keys(previous[index]).map((key) => [key, row[key]])))).toEqual(previous);
    }
    const currentIndexes = await f.rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name GLOB ? ORDER BY name", `${f.prefix}*`);
    for (const index of indexes) expect(currentIndexes).toContainEqual(index);
    for (const table of ["zernio_channel_accounts", "customer_channel_ids", "customer_merges"])
      expect(await f.rows(`SELECT * FROM ${table}`)).toEqual([]);
    if (populated) {
      expect(await f.rows("SELECT DISTINCT channel,account_label FROM connections"))
        .toEqual([{ channel: "whatsapp", account_label: "" }]);
      // Inclusive aplicação: nunca preencher o canal de uma conversa legada.
      expect(await f.rows("SELECT DISTINCT channel,account_label,channel_account_id,channel_subject_id,channel_context,channel_identity_id FROM conversations"))
        .toEqual([{ channel: null, account_label: "", channel_account_id: null, channel_subject_id: null, channel_context: "{}", channel_identity_id: null }]);
      expect(await f.rows("SELECT DISTINCT merged_into,merge_id FROM contacts"))
        .toEqual([{ merged_into: null, merge_id: null }]);
      expect(await f.rows("SELECT conversation_id,request_hash,provider_message_id FROM email_log"))
        .toEqual([{ conversation_id: null, request_hash: null, provider_message_id: null }]);
    } else await seed(f);
    await assertConstraints(f);
    for (const table of [...preservedTables, "zernio_channel_accounts", "customer_channel_ids", "customer_merges", "inbox", "channel_events"])
      expect(await f.rows(`PRAGMA foreign_key_check(${table})`)).toEqual([]);
  }, 120_000);
});

async function assertConstraints(f: Fixture) {
  const account = (connection: string, profile = "area", integration = "integration", channel = "instagram", accountId = "opaque-account") =>
    f.run("INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,created,updated) VALUES(?,?,?,?,?,1,1)", connection, profile, integration, channel, accountId);
  await account("social");
  await expect(account("second-social")).rejects.toThrow(/UNIQUE/i);
  await expect(account("second-social", "area", "second-integration")).rejects.toThrow(/UNIQUE/i);
  await account("second-social", "area", "integration", "instagram", "second-account");
  await account("third-social", "area", "integration", "facebook");
  await account("other-line", "other", "other-integration");
  await expect(account("qr", "other", "other-integration", "instagram", "bad-profile")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(account("qr", "area", "other-integration", "instagram", "bad-integration")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(account("qr", "area", "integration", "whatsapp", "bad-platform")).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT connection_id FROM meta_numbers")).toEqual([{ connection_id: "official" }]);

  for (const [id, line] of [["social-conversation", "social"], ["second-conversation", "second-social"]])
    await f.run("INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,channel,channel_account_id,channel_subject_id) VALUES(?,'area',?,?,'opaque-subject','session',1,1,2,'instagram',?,'opaque-subject')", id, line, `channel:${line}`, line === "social" ? "opaque-account" : "second-account");
  await expect(f.run("INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated) VALUES('duplicate-conversation','area','social','channel:social','opaque-subject','session',1,1,2)")).rejects.toThrow(/UNIQUE/i);

  const identity = (id: string, overrides: Record<string, string | null> = {}) => {
    const row = { profile: "area", namespace: "team", channel: "instagram", account: "opaque-account", subjectNamespace: "dm", subject: "opaque-subject", contact: "contact", connection: "social", proof: "social-conversation", state: "ready", ...overrides };
    return f.run("INSERT INTO customer_channel_ids(id,profile_id,namespace,channel,account_id,subject_namespace,subject_id,contact_id,connection_id,proof_conversation_id,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1)", id, row.profile, row.namespace, row.channel, row.account, row.subjectNamespace, row.subject, row.contact, row.connection, row.proof, row.state);
  };
  await identity("identity");
  await expect(identity("duplicate-identity")).rejects.toThrow(/UNIQUE/i);
  expect(await f.rows("SELECT id FROM customer_channel_ids")).toEqual([{ id: "identity" }]);
  await identity("other-account", { account: "second-account", connection: "second-social", proof: "second-conversation" });
  await identity("comment-subject", { subjectNamespace: "comment-author" });
  await identity("other-channel", { channel: "facebook", connection: "third-social" });
  await identity("other-area", { profile: "other", contact: "other-contact", connection: "other-line", proof: "other-conversation" });
  await identity("other-namespace", { namespace: "app:integration", contact: "app-contact" });
  for (const [id, overrides] of [
    ["bad-contact", { contact: "other-contact" }], ["bad-namespace", { namespace: "app:integration" }],
    ["bad-connection", { connection: "other-line" }], ["bad-proof", { proof: "other-conversation" }],
  ] as const) await expect(identity(id, { subject: id, ...overrides })).rejects.toThrow(/FOREIGN KEY/i);
  for (const [id, overrides] of [
    ["no-contact", { contact: null }], ["no-proof", { proof: null }],
    ["unknown-channel", { channel: "unknown" }], ["unknown-state", { state: "unknown" }],
  ] as const) await expect(identity(id, { subject: id, ...overrides })).rejects.toThrow(/CHECK/i);
  await expect(identity("no-subject-namespace", { subject: "missing", subjectNamespace: null })).rejects.toThrow(/NOT NULL/i);
  await expect(f.run("UPDATE customer_channel_ids SET version=0 WHERE id='identity'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE conversations SET channel_identity_id='missing' WHERE id='social-conversation'")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("UPDATE conversations SET channel_identity_id='identity' WHERE id='social-conversation'");
  await expect(f.run("UPDATE conversations SET channel='unknown' WHERE id='social-conversation'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE conversations SET channel_context='invalid' WHERE id='social-conversation'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE connections SET channel='unknown' WHERE id='social'")).rejects.toThrow(/CHECK/i);
  await f.run("UPDATE conversations SET chat_type='comment',channel_context=? WHERE id='second-conversation'", JSON.stringify({ version: 1, context: "comment" }));

  // São as chaves estruturais existentes; o parser/serviço fará a deduplicação.
  const event = "channel:social:event-1";
  const inbox = (id: string) => f.run("INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,'area',?,'social-conversation','{}',1)", id, event);
  await inbox("first-inbox");
  await expect(inbox("second-inbox")).rejects.toThrow(/UNIQUE/i);
  const channelEvent = () => f.run("INSERT INTO channel_events(event_key,connection_id,chat,external_id,kind,payload,created) VALUES(?,'social','opaque-subject','provider-message','message.received','{}',1)", event);
  await channelEvent();
  await expect(channelEvent()).rejects.toThrow(/UNIQUE/i);
  const message = (id: string) => f.run("INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,source_key,created) VALUES(?,'area','social-conversation','customer','customer','Olá',?,1)", id, event);
  await message("social-message");
  await expect(message("duplicate-message")).rejects.toThrow(/UNIQUE/i);
  const delivery = (id: string) => f.run("INSERT INTO outbox(id,profile_id,conversation_id,connection_id,kind,actor,payload,dedupe,created,updated) VALUES(?,'area','social-conversation','social','text','actor','{}','social-command',1,1)", id);
  await delivery("delivery");
  await expect(delivery("duplicate-delivery")).rejects.toThrow(/UNIQUE/i);
  expect(await f.rows("SELECT id FROM inbox WHERE event_key=?", event)).toEqual([{ id: "first-inbox" }]);
  expect(await f.rows("SELECT event_key FROM channel_events WHERE event_key=?", event)).toEqual([{ event_key: event }]);
  expect(await f.rows("SELECT id FROM messages WHERE source_key=?", event)).toEqual([{ id: "social-message" }]);
  expect(await f.rows("SELECT id FROM outbox WHERE dedupe='social-command'")).toEqual([{ id: "delivery" }]);
  await expect(env.DB.batch([
    f.statement("INSERT INTO inbox(id,profile_id,event_key,payload,created) VALUES('rollback-inbox','area','rollback-event','{}',1)"),
    f.statement("INSERT INTO customer_channel_ids(id,profile_id,namespace,channel,account_id,subject_namespace,subject_id,state,created,updated) VALUES('invalid-identity','area','team','instagram','opaque-account','dm','invalid','ready',1,1)"),
  ])).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT id FROM inbox WHERE event_key='rollback-event'")).toEqual([]);

  const merge = (id: string, command: string, source = "contact", target = "target") =>
    f.run("INSERT INTO customer_merges(profile_id,id,namespace,source_id,target_id,command_id,request_hash,actor_id,state,before_cipher,after_hash,source_version,target_version,created) VALUES('area',?,'team',?,?,?,'hash','actor','applied','cipher','after',1,1,1)", id, source, target, command);
  await merge("merge", "merge-command");
  await expect(merge("duplicate-merge", "merge-command")).rejects.toThrow(/UNIQUE/i);
  await expect(merge("self-merge", "self-command", "contact", "contact")).rejects.toThrow(/CHECK/i);
  await expect(merge("cross-area", "cross-command", "contact", "other-contact")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(merge("cross-namespace", "namespace-command", "contact", "app-contact")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE customer_merges SET state='undone' WHERE id='merge'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE customer_merges SET undone_at=2 WHERE id='merge'")).rejects.toThrow(/CHECK/i);
  await f.run("UPDATE customer_merges SET state='undone',undone_at=2,undone_by='actor',undo_command_id='undo-command',undo_request_hash='undo-hash' WHERE id='merge'");
  await merge("second-merge", "second-command");
  await expect(f.run("UPDATE customer_merges SET state='undone',undone_at=2,undo_command_id='undo-command' WHERE id='second-merge'")).rejects.toThrow(/UNIQUE/i);
  await expect(f.run("INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,command_id,request_hash,retry_at,created,updated) VALUES('area','merge-job','team','contact','merge','job-command','hash',1,1,1)")).rejects.toThrow(/CHECK/i);
  const email = (id: string) => f.run("INSERT INTO email_log(id,profile_id,user_id,purpose,to_masked,to_hash,status,key,conversation_id,request_hash,created) VALUES(?,'area','actor','conversation.email','p***@example.test','hash','reserved','transcript-key','social-conversation','approved-hash',1)", id);
  await email("transcript");
  await expect(email("duplicate-transcript")).rejects.toThrow(/UNIQUE/i);
  expect(await f.rows("SELECT id,provider_message_id FROM email_log WHERE key='transcript-key'"))
    .toEqual([{ id: "transcript", provider_message_id: null }]);
  expect(await f.rows("SELECT phone,contact_id,state FROM customer_phones"))
    .toEqual([{ phone: "5511987654321", contact_id: "contact", state: "ready" }]);
}
