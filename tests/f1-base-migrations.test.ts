import { env as testEnv } from "cloudflare:test";
import { expect, it } from "vitest";
import { customerRecordStatements } from "../src/customer/ports";
import type { CustomerRecordLink, Statement } from "../src/customer/contracts";
import type { Env } from "../src/types";

type Migration = { name: string; queries: string[] };
const env = testEnv as unknown as Env & { TEST_MIGRATIONS: Migration[] };
const migrations = env.TEST_MIGRATIONS;

/**
 * Reconstrói a 0.22.0 pelas migrações reais, com nomes isolados na mesma conexão
 * D1 do teste. Não usa DO, binding extra nem desfaz o schema do setup global.
 * Preserva literais, comentários, SQL, constraints e triggers das migrações.
 */
async function legacyFixture() {
  const prefix = `f1_${crypto.randomUUID().replaceAll("-", "")}_`;
  const names = new Map<string, string>();
  for (const migration of migrations) {
    for (const query of migration.queries) {
      for (const match of query.matchAll(/\bCREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)/gi))
        names.set(match[1], `${prefix}${match[1]}`);
    }
  }
  const sql = (query: string) => query.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*/gi,
    (token) => names.get(token) ?? token,
  );
  const run = (query: string, ...params: unknown[]) => env.DB.prepare(sql(query)).bind(...params).run();
  const rows = async (query: string, ...params: unknown[]) =>
    (await env.DB.prepare(sql(query)).bind(...params).all<Record<string, unknown>>()).results;
  const batch = (statements: Statement[]) => env.DB.batch(
    statements.map(([query, params]) => env.DB.prepare(sql(query)).bind(...params)),
  );
  const legacy = migrations.filter((m) => Number(m.name.slice(0, 4)) < 120);
  expect(legacy.at(-1)?.name).toBe("0119_os_task_reminder_cursors.sql");
  for (const migration of legacy)
    for (const query of migration.queries) await run(query);
  return { prefix, names, sql, run, rows, batch };
}

async function seed(f: Awaited<ReturnType<typeof legacyFixture>>) {
  for (const id of ["area", "other"])
    await f.run("INSERT INTO profiles(id,name,created) VALUES(?,?,1)", id, id);
  for (const [id, area, namespace, phone] of [
    ["first", "area", "team", "5511987654321"],
    ["duplicate", "area", "team", "5511987654321"],
    ["app", "area", "app:integration", "5511987654321"],
    ["formatted", "area", "team", "+55 (11) 8765-4321"],
    ["short", "area", "team", "123"], ["empty", "area", "team", ""],
    ["international", "area", "team", "12125550199"],
    ["other-contact", "other", "team", "5511987654321"],
    ["legacy-zero", "area", "team", "0123456789"],
  ]) await f.run(
    "INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,created_by,updated_by,version,created,updated) VALUES(?,?,?,?,?,'a@example.test','Empresa','Local','legado','manual','actor','actor',7,1,2)",
    id, area, namespace, `Nome ${id}`, phone,
  );
  for (const [id, area, namespace, contact] of [
    ["conversation", "area", "channel:old", "first"],
    ["app-conversation", "area", "app:integration", "app"],
    ["other-conversation", "other", "channel:other", "other-contact"],
  ]) {
    await f.run("INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,'5511987654321','session',1,1,2)", id, area, namespace, id);
    await f.run("INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'human',1)", id, area, contact);
  }
  await f.run("INSERT INTO mensalidade_payers(id,profile_id,name,created_by,created,updated) VALUES('payer','area','Pagador','human',1,2)");
  await f.run("INSERT INTO mensalidade_payer_phones(payer_id,profile_id,phone,created_by,created) VALUES('payer','area','5511987654321','human',1)");
  await f.run("INSERT INTO mensalidade_plans(id,profile_id,name,amount_cents,created_by,created,updated) VALUES('plan','area','Plano',1000,'human',1,2)");
  await f.run("INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,contact_id,conversation_id,period,amount_cents,due_day,start_date,bill_from,checked_until,created_by,created,updated,payer_id) VALUES('subscription','area','plan','first','conversation','monthly',1000,10,'2026-01-01','2026-01','2026-11','human',1,2,'payer')");
  await f.run("INSERT INTO cond_blocks(profile_id,id,name) VALUES('area','block','Bloco')");
  await f.run("INSERT INTO cond_units(profile_id,id,block_id,number) VALUES('area','unit','block','101')");
  await f.run("INSERT INTO cond_people(profile_id,id,name) VALUES('area','person','Adulto')");
  await f.run("INSERT INTO cond_memberships(profile_id,id,person_id,unit_id,role,starts_at,verified_by) VALUES('area','membership','person','unit','funcionario',1,'human')");
  await f.run("INSERT INTO cond_works(profile_id,id,unit_id,person_id,membership_id,kind,created_at,source_key) VALUES('area','work','unit','person','membership','encomenda',1,'source')");
  await f.run("INSERT INTO saude_subjects(profile_id,id,kind,payload_enc,created,last_activity) VALUES('area','subject','human','synthetic-cipher',1,2)");
  await f.run("INSERT INTO os_orders(id,profile_id,number,contact_id,conversation_id,item,problem,source,created_by,created,updated) VALUES('order','area',1,'first','conversation','Administrativo','','panel','human',1,2)");
  await f.run("INSERT INTO os_people(id,profile_id,order_id,role,name,created_by,created,updated) VALUES('guardian-person','area','order','responsible','Adulto','human',1,2)");
  await f.run("INSERT INTO ensino_classes(profile_id,id,name,school_year,start_date,end_date,teacher_id,type_id,capacity,schedule_json,periods_json,rule_json,justified_counts,created) VALUES('area','class','Turma','2026','2026-01-01','2026-12-31','teacher','type',10,'{}','{}','{}',0,1)");
  await f.run("INSERT INTO ensino_enrollments(profile_id,id,class_id,order_id,start_date,end_date) VALUES('area','enrollment','class','order','2026-01-01','2026-12-31')");
  await f.run("INSERT INTO ensino_guardians(profile_id,id,order_id,person_id,person_version,phone_hash,valid_until,verified_by,created) VALUES('area','guardian','order','guardian-person',1,'hash','2026-12-31','human',1)");
}

it("aplica 0130–0132 sobre 0.22.0 com duplicados, aplicação e vínculos preservados", async () => {
  const f = await legacyFixture();
  await seed(f);
  const tables = [
    "contacts", "conversations", "conversation_contacts", "mensalidade_payers",
    "mensalidade_payer_phones", "mensalidade_subscriptions", "cond_people", "cond_memberships",
    "cond_units", "cond_works", "saude_subjects", "os_orders", "os_people", "ensino_guardians", "ensino_enrollments",
  ];
  const before = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) before.set(table, await f.rows(`SELECT * FROM ${table} ORDER BY rowid`));
  const added = migrations.filter((m) => /^013[012]_/.test(m.name));
  expect(added.map((m) => m.name)).toEqual([
    "0130_customer_identity.sql", "0131_customer_workflow.sql", "0132_customer_relations.sql",
  ]);
  for (const migration of added) {
    expect(migration.queries.join("\n")).not.toMatch(/\b(?:DROP|RENAME|DELETE|UPDATE)\b/i);
    for (const query of migration.queries) await f.run(query);
  }
  for (const table of tables) {
    const previous = before.get(table)!;
    const after = await f.rows(`SELECT * FROM ${table} ORDER BY rowid`);
    expect(after).toHaveLength(previous.length);
    expect(after.map((row, i) => Object.fromEntries(Object.keys(previous[i]).map((key) => [key, row[key]])))).toEqual(previous);
  }
  expect(await f.rows("SELECT phone,contact_id,state,version FROM customer_phones WHERE profile_id='area' AND namespace='team' AND phone='5511987654321'"))
    .toEqual([{ phone: "5511987654321", contact_id: null, state: "ambiguous", version: 1 }]);
  expect(await f.rows("SELECT contact_id,state FROM customer_phones WHERE namespace='app:integration'"))
    .toEqual([{ contact_id: "app", state: "ready" }]);
  expect(await f.rows("SELECT contact_id,state FROM customer_phones WHERE profile_id='other'"))
    .toEqual([{ contact_id: "other-contact", state: "ready" }]);
  expect(await f.rows("SELECT contact_id,origin FROM customer_phone_candidates ORDER BY contact_id")).toEqual([
    { contact_id: "app", origin: "legacy" }, { contact_id: "duplicate", origin: "legacy" },
    { contact_id: "first", origin: "legacy" }, { contact_id: "international", origin: "legacy" },
    { contact_id: "legacy-zero", origin: "legacy" }, { contact_id: "other-contact", origin: "legacy" },
  ]);
  expect(await f.rows("SELECT DISTINCT identity_state,erp_contact_id,erp_version,mirror_json,local_patch_cipher,document,person_type FROM contacts"))
    .toEqual([{ identity_state: "active", erp_contact_id: null, erp_version: null, mirror_json: null, local_patch_cipher: null, document: null, person_type: null }]);
  expect(await f.rows("SELECT DISTINCT verified_phone,customer_link_state FROM conversations"))
    .toEqual([{ verified_phone: null, customer_link_state: "pending" }]);
  for (const table of ["mensalidade_payers", "cond_people", "ensino_guardians"])
    expect(await f.rows(`SELECT contact_id FROM ${table}`)).toEqual([{ contact_id: null }]);
  expect(await f.rows("SELECT billing_contact_id FROM ensino_enrollments")).toEqual([{ billing_contact_id: null }]);

  // ID ERP é único por área, inclusive entre namespaces, sem exigir IDs iguais.
  await f.run("UPDATE contacts SET erp_contact_id='erp-uuid',erp_version=9,mirror_json='{}' WHERE id='first'");
  for (const id of ["duplicate", "app"])
    await expect(f.run("UPDATE contacts SET erp_contact_id='erp-uuid' WHERE id=?", id)).rejects.toThrow(/UNIQUE/i);
  await f.run("UPDATE contacts SET erp_contact_id='erp-uuid' WHERE id='other-contact'");
  expect(await f.rows("SELECT id FROM contacts WHERE erp_contact_id='erp-uuid' ORDER BY id"))
    .toEqual([{ id: "first" }, { id: "other-contact" }]);

  // FKs compostas impedem atravessar a área ou o namespace.
  for (const [area, namespace, contact] of [
    ["area", "team", "app"], ["other", "team", "first"], ["area", "app:integration", "first"],
  ]) {
    await expect(f.run("INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,?,'5511999999999',?,'ready')", area, namespace, contact)).rejects.toThrow(/FOREIGN KEY/i);
    await expect(f.run("INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) VALUES(?,?,'5511999999999',?,'local')", area, namespace, contact)).rejects.toThrow(/FOREIGN KEY/i);
    await expect(f.run("INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,command_id,request_hash,retry_at,created,updated) VALUES(?,'bad-job',?,?,'enrich','bad-command','hash',1,1,1)", area, namespace, contact)).rejects.toThrow(/FOREIGN KEY/i);
  }
  for (const query of [
    "UPDATE contacts SET person_type='unknown' WHERE id='first'",
    "UPDATE contacts SET mirror_json='invalid-json' WHERE id='first'",
    "UPDATE contacts SET identity_state='unknown' WHERE id='first'",
    "UPDATE conversations SET customer_link_state='unknown' WHERE id='conversation'",
    "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES('area','team','5511999999999',NULL,'ready')",
    "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES('area','team','5511999999999','first','pending')",
    "INSERT INTO customer_phones(profile_id,namespace,phone,state) VALUES('area','team','55x9999999999','pending')",
    "INSERT INTO customer_phones(profile_id,namespace,phone,state,version) VALUES('area','team','5511999999999','pending',0)",
    "INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,updated) VALUES('area','team','backfill','invalid',1)",
    "INSERT INTO customer_assert(id,ok) VALUES('guard',0)",
  ]) await expect(f.run(query)).rejects.toThrow(/CHECK/i);
  await expect(f.run("INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id) VALUES('other','first','condominio','units')")).rejects.toThrow(/FOREIGN KEY/i);

  // Fila única por contato, comando idempotente por área e leases/versões disponíveis.
  const job = (id: string, command: string, state: string) => f.run(
    "INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,state,command_id,request_hash,retry_at,created,updated) VALUES('area',?,'team','first','enrich',?,?,'hash',1,1,1)", id, state, command,
  );
  await job("job-1", "command-1", "running");
  await expect(job("job-2", "command-2", "running")).rejects.toThrow(/UNIQUE/i);
  await job("job-2", "command-2", "pending");
  await expect(job("job-3", "command-1", "pending")).rejects.toThrow(/UNIQUE/i);
  await f.run("UPDATE customer_jobs SET state='done' WHERE id='job-1'");
  await f.run("UPDATE customer_jobs SET state='running',lease_until=99 WHERE id='job-2'");

  // Relações aditivas: o comando ainda deve conferir área nas FKs simples.
  for (const table of ["mensalidade_payers", "cond_people", "ensino_guardians"]) {
    await expect(f.run(`UPDATE ${table} SET contact_id='missing'`)).rejects.toThrow(/FOREIGN KEY/i);
    await f.run(`UPDATE ${table} SET contact_id='first' WHERE profile_id='area'`);
  }
  await expect(f.run("UPDATE ensino_enrollments SET billing_contact_id='missing'")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("UPDATE ensino_enrollments SET billing_contact_id='first' WHERE profile_id='area'");
  await f.run("INSERT INTO saude_contact_links(profile_id,subject_id,contact_id,relation) VALUES('area','subject','first','responsible')");
  await expect(f.run("INSERT INTO saude_contact_links(profile_id,subject_id,contact_id,relation) VALUES('area','subject','other-contact','self')")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("INSERT INTO saude_contact_links(profile_id,subject_id,contact_id,relation) VALUES('other','subject','other-contact','self')")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("INSERT INTO cond_person_functions(profile_id,id,person_id,role,starts_at,verified_by) VALUES('area','function','person','sindico',1,'human')");
  await expect(f.run("INSERT INTO cond_person_functions(profile_id,id,person_id,role,starts_at,verified_by) VALUES('area','visitor','person','visitante_recorrente',1,'human')")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE cond_person_functions SET ends_at=starts_at")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE cond_person_functions SET person_id='missing'")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("INSERT INTO cond_portaria_details(profile_id,work_id,visitor_person_id,delivery_source) VALUES('area','work','person','correios')");
  await expect(f.run("UPDATE cond_portaria_details SET delivery_source='unknown'")).rejects.toThrow(/CHECK/i);
  await expect(f.run("UPDATE cond_portaria_details SET work_id='missing'")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE cond_portaria_details SET visitor_person_id='missing'")).rejects.toThrow(/FOREIGN KEY/i);
  await f.run("INSERT INTO cond_unit_subscriptions(profile_id,unit_id,subscription_id) VALUES('area','unit','subscription')");
  await expect(f.run("INSERT INTO cond_unit_subscriptions(profile_id,unit_id,subscription_id) VALUES('other','unit','subscription')")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("INSERT INTO cond_unit_subscriptions(profile_id,unit_id,subscription_id) VALUES('area','unit','missing')")).rejects.toThrow(/FOREIGN KEY/i);
  await expect(f.run("UPDATE cond_memberships SET role='sindico'")).rejects.toThrow(/CHECK/i);
  expect(await f.rows("SELECT role FROM cond_memberships")).toEqual([{ role: "funcionario" }]);
  for (const table of [...tables, "customer_phones", "customer_phone_candidates", "customer_jobs", "customer_sections", "saude_contact_links", "cond_person_functions", "cond_portaria_details", "cond_unit_subscriptions"])
    expect(await f.rows(`PRAGMA foreign_key_check(${table})`)).toEqual([]);
}, 60_000);

it("vínculo de origem repete sem duplicar e troca de contato reverte todo o lote", async () => {
  // Usa o schema real já migrado pelo setup, sem reconstrução.
  const area = crypto.randomUUID(), other = crypto.randomUUID();
  const first = crypto.randomUUID(), second = crypto.randomUUID(), foreign = crypto.randomUUID();
  const conv = crypto.randomUUID(), foreignConv = crypto.randomUUID();
  for (const profile of [area, other])
    await env.DB.prepare("INSERT INTO profiles(id,name,created) VALUES(?,'Área',1)").bind(profile).run();
  for (const [id, profile] of [[first, area], [second, area], [foreign, other]])
    await env.DB.prepare("INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','','','automatic','actor','actor',1,1)").bind(id, profile).run();
  for (const [id, profile] of [[conv, area], [foreignConv, other]])
    await env.DB.prepare("INSERT INTO conversations(id,profile_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,'channel:test',?,'session',1,1,1)").bind(id, profile, id).run();
  const link: CustomerRecordLink = {
    profileId: area, contactId: first, moduleId: "conversation", kind: "conversation",
    recordId: `${conv}:session`, conversationId: conv, linkedBy: "human", occurredAt: 10,
  };
  const batch = (statements: Statement[]) => env.DB.batch(statements.map(([sql, params]) => env.DB.prepare(sql).bind(...params)));
  const read = () => env.DB.prepare("SELECT * FROM customer_records WHERE profile_id=?").bind(area).all();
  await batch(customerRecordStatements(link));
  const before = (await read()).results;
  await batch(customerRecordStatements(link));
  await batch(customerRecordStatements({ ...link, linkedBy: "new", occurredAt: 999 }));
  expect((await read()).results).toEqual(before);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ contact_id: first, linked_by: "human", occurred_at: 10 });
  // Atualizar o vínculo da conversa não reatribui sessões passadas.
  await env.DB.prepare("INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'human',1)").bind(conv, area, second).run();
  await expect(batch([
    ["UPDATE contacts SET name='não deve persistir' WHERE id=?", [second]],
    ...customerRecordStatements({ ...link, contactId: second }),
  ])).rejects.toThrow(/CHECK/i);
  expect((await read()).results).toEqual(before);
  expect(await env.DB.prepare("SELECT name FROM contacts WHERE id=?").bind(second).first("name")).toBe("");
  expect(await env.DB.prepare("SELECT count(*) n FROM customer_assert").first("n")).toBe(0);
  await expect(batch(customerRecordStatements({ ...link, recordId: "foreign-contact", contactId: foreign }))).rejects.toThrow(/FOREIGN KEY/i);
  await expect(batch(customerRecordStatements({ ...link, recordId: "foreign-conversation", conversationId: foreignConv }))).rejects.toThrow(/FOREIGN KEY/i);
  await batch(customerRecordStatements({ ...link, recordId: `${conv}:new-session`, contactId: second, occurredAt: 20 }));
  expect((await read()).results).toHaveLength(2);
  expect((await env.DB.prepare("PRAGMA foreign_key_check(customer_records)").all()).results).toEqual([]);
});
