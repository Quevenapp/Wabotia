import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one, withReadCache } from "../src/db";
import { now, uid, type Actor, type Conversation, type Env } from "../src/types";
import type { SocialInboundEvidence, Statement } from "../src/customer/contracts";
import { prepareChannelInbound, readCustomerChannels, resolveChannelCustomer } from "../src/customer/channel-identity";
import { conversationIdentityStatements, customerIdentity, evidencePhone, inboundConnection } from "../src/customer/identity";
import { customerHistory, customerTextHistory, customerTextScope } from "../src/customer/history";
import { validateCustomerSelfActor } from "../src/customer/local";
import { eraseContact } from "../src/customer/http";
import { lookupProtocols } from "../src/protocol-lookup";
import { previewContactMerge, mergeContacts, undoContactMerge } from "../src/customer/merge";
import { listContacts } from "../src/contacts";
import { parseContactCsv, serializeContactCsv } from "../src/contact-csv";
import { conversation, conversationByPhone, inbound } from "../src/service";
import { fixture, type Fixture } from "./service-center-fixture";
import { measure } from "./d1-counter";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada no teste de identidade."); })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function socialLine(f: Fixture, line = f.line, account = uid(), channel: "instagram" | "facebook" = "instagram") {
  const integration = uid();
  await batch(env, [
    ["UPDATE connections SET channel=?,account_label='@loja' WHERE id=? AND profile_id=?", [channel, line, f.profile]],
    ["INSERT INTO meta_accounts(id,profile_id,name,waba_id,created) VALUES(?,?,'Social',?,?)", [integration, f.profile, uid(), now()]],
    ["INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,created,updated) VALUES(?,?,?,?,?,?,?)", [line, f.profile, integration, channel, account, now(), now()]],
  ]);
  return { line, account, channel };
}
async function socialConversation(f: Fixture, line: Awaited<ReturnType<typeof socialLine>>, subject: string = uid(), persist = true) {
  const at = now(), id = uid();
  const c = { id, profile_id: f.profile, connection_id: line.line, external_namespace: `channel:${line.line}`,
    external_id: uid(), channel: line.channel, channel_account_id: line.account, channel_subject_id: subject,
    customer_link_state: "pending", phone: null, verified_phone: null, chat_type: "direct", session: uid(),
    title: "", bot_policy: "mentions", state: "ai", owner: null, epoch: 0, topic: null, tags: "[]", last_customer: at, created: at, updated: at } satisfies Conversation;
  const insert: Statement = [
    `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,channel,channel_account_id,channel_subject_id,session,last_customer,created,updated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, f.profile, line.line, c.external_namespace, c.external_id, line.channel, line.account, subject, c.session, at, at, at],
  ];
  if (persist) await batch(env, [insert]);
  const evidence: SocialInboundEvidence = { provider: "zernio", channel: line.channel, accountId: line.account, subjectNamespace: "dm", subjectId: subject, displayName: "Maria", username: "@maria" };
  return { c, evidence, insert };
}
async function receiveSocial(c: Conversation, evidence: SocialInboundEvidence, event = uid()) {
  const plan = await prepareChannelInbound(env, c, evidence);
  await batch(env, [...plan.statements,
    ["INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,'{}',?) ON CONFLICT(event_key) DO NOTHING", [event, c.profile_id, event, c.id, now()]],
    ["INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','Olá',?) ON CONFLICT(id) DO NOTHING", [event, c.profile_id, c.id, now()]],
  ]);
  return plan.customer;
}

describe("identidade por canal", () => {
  it("índice de aliases preserva a busca telefônica do snapshot e da assertion", async () => {
    const f = await fixture(), phone = "5511987654321";
    const c = await conversationByPhone(env, f.profile, phone, { open: true, connectionId: f.line });
    const queries: string[] = [];
    const DB = new Proxy(env.DB, { get(db, key) {
      if (key === "prepare") return (sql: string) => { queries.push(sql); return db.prepare(sql); };
      const value = Reflect.get(db, key);
      return typeof value === "function" ? value.bind(db) : value;
    } });
    const plan = await customerIdentity.prepareInbound({ ...env, DB } as Env, c!, { provider: "zernio", phone });
    const snapshot = queries.find(sql => sql.startsWith("WITH progress AS"));
    expect(snapshot).toBeDefined();
    const guard = plan.statements.find(([sql]) => sql.startsWith("INSERT INTO customer_assert"));
    expect(guard).toBeDefined();
    for (const sql of [snapshot!, guard![0]]) {
      const queryPlan = await all(env, `EXPLAIN QUERY PLAN ${sql}`, ...(sql.match(/\?/g) ?? []).map(() => null));
      const details = queryPlan.map(row => row.detail).join("\n");
      expect(details).toMatch(/USING INDEX contacts_legacy_phone .*<expr>=\?/);
      expect(details).not.toContain("contacts_merge_target");
    }
  });

  it.each([null, "whatsapp"] as const)("guarda de canal não acrescenta leitura à atualização ambígua com channel=%s", async channel => {
    const f = await fixture(), phone = "5511987654321";
    const c = await conversationByPhone(env, f.profile, phone, { open: true, connectionId: f.line });
    await batch(env, [
      ["INSERT INTO customer_phones(profile_id,namespace,phone,state) VALUES(?,'team',?,'ambiguous')", [f.profile, phone]],
      ["UPDATE conversations SET channel=?,verified_phone=?,customer_link_state='ambiguous',customer_identity_proof=NULL WHERE id=?", [channel, phone, c!.id]],
    ]);
    const [sql, args] = conversationIdentityStatements(f.profile, [c!.id], { phone, invalidate: true, state: "ambiguous", session: false })[0];
    // Controle sem a guarda social: mesmo banco, argumentos e estado. As duas
    // atualizações são idempotentes, sem transição de estado nos gatilhos.
    const controlSql = sql.replace(" AND (channel IS NULL OR channel='whatsapp')", "");
    expect(controlSql).not.toBe(sql);
    const control = await env.DB.prepare(controlSql).bind(...args).run();
    const guarded = await env.DB.prepare(sql).bind(...args).run();
    expect(control.meta.rows_read).toBeGreaterThan(0);
    expect(guarded.meta.rows_read).toBeLessThanOrEqual(control.meta.rows_read);
    expect(guarded.meta.rows_written).toBe(control.meta.rows_written);
    expect(await one(env, "SELECT channel,phone,verified_phone,customer_link_state,customer_identity_proof FROM conversations WHERE id=?", c!.id))
      .toEqual({ channel, phone, verified_phone: phone, customer_link_state: "ambiguous", customer_identity_proof: null });
  });

  it("atualização telefônica preserva canal social e outra área em alvo unitário e lote", async () => {
    const f = await fixture(), other = await fixture(), phone = "5511987654321";
    const own = await conversationByPhone(env, f.profile, phone, { open: true, connectionId: f.second });
    const foreign = await conversationByPhone(env, other.profile, phone, { open: true, connectionId: other.line });
    const social = await socialConversation(f, await socialLine(f));
    const beforeSocial = await one(env, "SELECT * FROM conversations WHERE id=?", social.c.id);
    const beforeForeign = await one(env, "SELECT * FROM conversations WHERE id=?", foreign!.id);
    for (const ids of [[social.c.id], [foreign!.id], [own!.id, social.c.id, foreign!.id]]) {
      const [sql, args] = conversationIdentityStatements(f.profile, ids, { phone, invalidate: true, state: "ambiguous", session: false })[0];
      await env.DB.prepare(sql).bind(...args).run();
      expect(await one(env, "SELECT * FROM conversations WHERE id=?", social.c.id)).toEqual(beforeSocial);
      expect(await one(env, "SELECT * FROM conversations WHERE id=?", foreign!.id)).toEqual(beforeForeign);
    }
    expect(await one(env, "SELECT verified_phone,customer_link_state FROM conversations WHERE id=?", own!.id))
      .toEqual({ verified_phone: phone, customer_link_state: "ambiguous" });
  });

  it("só WhatsApp conserva prova telefônica e caminho pronto sem instrução adicional", async () => {
    const f = await fixture(), phone = "5511987654321";
    const received = await inbound(env, f.profile, { external_id: phone, phone, text: "Oi", message_id: uid() }, `channel:${f.line}`, f.line);
    const c = await conversation(env, received.conversation_id, f.profile), invocation = withReadCache(env);
    await inboundConnection(invocation, f.line);
    const measured = await measure(invocation, e => customerIdentity.prepareInbound(e, c, { provider: "zernio", phone }));
    expect(measured.result).toEqual({ state: "ready", verifiedPhone: phone, statements: [] });
    expect(measured.count).toMatchObject({ statements: 0, calls: 0 });
    expect(await all(env, "SELECT id FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("duas preparações simultâneas do mesmo webhook salvam um contato, identidade e mensagem", async () => {
    const f = await fixture(), line = await socialLine(f), { c, evidence } = await socialConversation(f, line), event = uid();
    const refs = await Promise.all([receiveSocial(c, evidence, event), receiveSocial(c, evidence, event)]);
    expect((await receiveSocial(c, evidence, event)).contactId).toBe(refs[0].contactId);
    expect(refs[0].contactId).toBe(refs[1].contactId);
    for (const table of ["contacts", "customer_channel_ids", "messages", "inbox"]) expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile)).toHaveLength(1);
    expect(refs[0]).toMatchObject({ state: "ready", verifiedPhone: null, verifiedChannel: { channel: "instagram", accountId: line.account, subjectId: evidence.subjectId } });
    expect(await one(env, "SELECT phone,erp_contact_id FROM contacts WHERE id=?", refs[0].contactId)).toEqual({ phone: "", erp_contact_id: null });
  });

  it("falha no lote da mensagem também desfaz conversa, identidade, ficha e vínculo", async () => {
    const f = await fixture(), line = await socialLine(f), { c, evidence, insert } = await socialConversation(f, line, uid(), false);
    const plan = await prepareChannelInbound(env, c, evidence);
    expect(await one(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toBeNull();
    await expect(batch(env, [insert, ...plan.statements, ["INSERT INTO customer_assert(id,ok) VALUES(?,0)", [uid()]]])).rejects.toThrow();
    for (const table of ["contacts", "customer_channel_ids", "conversation_contacts", "conversations"]) expect(await all(env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).toEqual([]);
  });

  it("mesmo nome não junta e o mesmo sujeito em contas diferentes tem identidades diferentes", async () => {
    const f = await fixture(), a = await socialLine(f), b = await socialLine(f, f.second);
    const entries = [await socialConversation(f, a, "mesmo-id"), await socialConversation(f, a, "outro-id"), await socialConversation(f, b, "mesmo-id")];
    const refs = [];
    for (const entry of entries) refs.push(await receiveSocial(entry.c, entry.evidence));
    expect(new Set(refs.map(r => r.contactId)).size).toBe(3);
    expect(await all(env, "SELECT * FROM customer_phone_proofs WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("reusa a identidade exata em outro thread e username não é chave", async () => {
    const f = await fixture(), line = await socialLine(f), a = await socialConversation(f, line, "sujeito"), b = await socialConversation(f, line, "sujeito");
    const first = await receiveSocial(a.c, a.evidence), second = await receiveSocial(b.c, { ...b.evidence, username: "@novo" });
    expect(second.contactId).toBe(first.contactId);
    expect(await one(env, "SELECT username FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual({ username: "@novo" });
    const next = await socialConversation(f, line, "sujeito");
    await receiveSocial(next.c, { ...next.evidence, displayName: undefined, username: undefined });
    expect(await one(env, "SELECT display_name,username FROM customer_channel_ids WHERE profile_id=?", f.profile)).toEqual({ display_name: "Maria", username: "@novo" });
  });

  it("recusa prova forjada, namespace de comentário e conta divergente sem escrita", async () => {
    const f = await fixture(), line = await socialLine(f), { c, evidence } = await socialConversation(f, line);
    for (const forged of [{ ...evidence, phone: "5511999999999" }, { ...evidence, subjectNamespace: "comment-author" }, { ...evidence, accountId: "outra" }, { ...evidence, subjectId: "outro" }])
      await expect(prepareChannelInbound(env, c, forged as SocialInboundEvidence)).rejects.toMatchObject({ code: "invalid_channel_evidence" });
    expect(evidencePhone({ ...evidence, phone: "5511999999999" } as any)).toBeNull();
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("restrição concorrente invalida o plano e entrada posterior não recria a pessoa", async () => {
    const f = await fixture(), line = await socialLine(f), a = await socialConversation(f, line), ref = await receiveSocial(a.c, a.evidence);
    const b = await socialConversation(f, line, a.evidence.subjectId), plan = await prepareChannelInbound(env, b.c, b.evidence);
    await exec(env, "UPDATE contacts SET identity_state='restricted',version=version+1 WHERE id=?", ref.contactId);
    await expect(batch(env, plan.statements)).rejects.toThrow();
    const excluded = await receiveSocial(b.c, b.evidence);
    expect(excluded).toMatchObject({ state: "excluded", contactId: null, verifiedPhone: null });
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await resolveChannelCustomer(env, a.c)).toMatchObject({ state: "excluded", contactId: null });
  });

  it("ficha humana mascara sujeitos e filtro incompleto conserva alias legado", async () => {
    const f = await fixture(), line = await socialLine(f), entry = await socialConversation(f, line, "id-privado-123"), ref = await receiveSocial(entry.c, entry.evidence);
    const view = await readCustomerChannels(env, f.admin, f.profile, ref.contactId!);
    expect(view.channels[0]).toMatchObject({ channel: "instagram", username: "@maria", state: "ready", account_label: "@loja" });
    expect(JSON.stringify(view)).not.toContain("id-privado-123");
    expect(JSON.stringify(view)).not.toContain(line.account);
    const modern = await listContacts(env, f.admin, f.profile, { identity: "no_personal_data" });
    const legacy = await listContacts(env, f.admin, f.profile, { identity: "phone_only" });
    expect(modern.data.map(c => c!.id)).toEqual(legacy.data.map(c => c!.id));
    expect(modern.data.map(c => c!.id)).toContain(ref.contactId);
  });

  it("junção social com WhatsApp/ERP não concede telefone, protocolos nem memória da outra origem", async () => {
    const f = await fixture(), line = await socialLine(f), entry = await socialConversation(f, line), social = await receiveSocial(entry.c, entry.evidence);
    const phone = "5511987654321", result = await inbound(env, f.profile, { external_id: phone, phone, text: "Segredo WhatsApp", message_id: uid() }, `channel:${f.second}`, f.second);
    const wa = await conversation(env, result.conversation_id, f.profile), phoneRef = await customerIdentity.resolve(env, wa);
    await exec(env, "UPDATE contacts SET erp_contact_id=?,erp_version=1 WHERE id=?", uid(), phoneRef.contactId);
    const ticket = uid(), at = now();
    await batch(env, [
      ["INSERT INTO tickets(id,number,profile_id,conversation_id,title,created,updated) VALUES(?,'10001',?,?,'Privado WhatsApp',?,?)", [ticket, f.profile, wa.id, at, at]],
      ["INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'tickets','ticket',?,?,?,'test',?)", [f.profile, ticket, phoneRef.contactId, wa.id, at]],
    ]);
    const preview = await previewContactMerge(env, f.admin, f.profile, social.contactId!, { targetId: phoneRef.contactId! });
    expect(preview.survivorId).toBe(phoneRef.contactId);
    const merged = await mergeContacts(env, f.admin, f.profile, social.contactId!, uid(), { targetId: phoneRef.contactId!, sourceVersion: preview.source.version, targetVersion: preview.target.version, previewToken: preview.previewToken, fieldChoices: {} });
    const current = await conversation(env, entry.c.id, f.profile), ref = await resolveChannelCustomer(env, current);
    expect(ref).toMatchObject({ contactId: phoneRef.contactId, verifiedPhone: null, verifiedChannel: { subjectId: entry.evidence.subjectId } });
    expect(await lookupProtocols(env, current)).toEqual([]);
    const scope = await customerTextScope(env, current, ref);
    expect(scope?.allowed).toBe(true);
    await exec(env, "UPDATE messages SET content=? WHERE conversation_id=?", JSON.stringify({ customerSession: current.session }), current.id);
    expect(await customerTextHistory(env, current, scope)).toEqual([{ direction: "customer", text: "Olá" }]);
    const runId = uid(), botId = uid();
    await exec(env, "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,'test',?,?,'running','{}','attendant',?,?,?)",
      runId, f.profile, botId, current.id, current.epoch, JSON.stringify({ session: current.session }), now(), now());
    const bot: Actor = { ...f.admin, kind: "app", role: "service", id: "bot", scopes: ["conversations:read", "conversations:bound"], bots: [botId], via: { kind: "bot", masked: true, run_id: runId, bot_id: botId } };
    expect(await customerHistory.memory(env, bot, current)).toMatchObject({ previousInteractions: 1, pendingActions: 0 });
    await expect(customerHistory.memory(env, bot, wa)).rejects.toMatchObject({ status: 404 });
    expect(await lookupProtocols(env, wa, "10001")).toHaveLength(1);
    const self: Actor = { ...f.admin, id: `customer:${current.id}:${current.session}`, kind: "connector", role: "service", scopes: ["contacts:self"], profiles: [f.profile] };
    await expect(validateCustomerSelfActor(env, self, f.profile, ref.contactId!)).rejects.toMatchObject({ status: 403 });
    await eraseContact(env, f.admin, f.profile, phoneRef.contactId!, { expectedVersion: merged.targetVersion, confirm: true, reason: "Pedido de exclusão do cliente" }, uid());
    expect((await one(env, "SELECT before_cipher FROM customer_merges WHERE profile_id=? AND id=?", f.profile, merged.id)).before_cipher).toBe("");
    await expect(undoContactMerge(env, f.admin, f.profile, social.contactId!, uid(), { mergeId: merged.id })).rejects.toMatchObject({ code: "merge_restricted" });
  });
});

describe("CSV de contatos", () => {
  const contact = { name: "Maria", phone: "5511987654321", email: "", company: "", notes: "" };
  it("só WhatsApp mantém as cinco colunas e não cria credenciais", () => {
    const csv = serializeContactCsv([contact]);
    expect(csv.split("\n")[0]).toBe('"nome";"telefone";"email";"empresa";"observacoes"');
    expect(parseContactCsv(csv).rows[0].values).toEqual(contact);
  });
  it("exporta apresentação social, protege fórmulas e recusa identidade digitada na importação", () => {
    const csv = serializeContactCsv([{ ...contact, name: "=1+1", channels: [{ channel: "instagram", account_label: "Loja", username: "@maria", state: "ready" }] }]);
    expect(csv).toContain("instagram · Loja · @maria · ready");
    expect(csv).toContain("'=1+1");
    expect(() => parseContactCsv(csv)).toThrow("entrada autenticada");
    for (const field of ["subject_id", "account_id", "instagram", "verified_channel"]) expect(() => parseContactCsv(`nome;${field}\nMaria;valor`)).toThrow("entrada autenticada");
  });
});
