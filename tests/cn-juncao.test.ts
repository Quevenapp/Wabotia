import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one, withReadCache } from "../src/db";
import { now, uid } from "../src/types";
import { canonical, unseal } from "../src/security";
import { mergeContacts, previewContactMerge, undoContactMerge } from "../src/customer/merge";
import { createProfilePort } from "../src/customer/profile";
import { CONTACT_TASK, customerIdentity } from "../src/customer/identity";
import { MERGE_RELATIONS, assertManifest, cloneManifest, manifestRows, planRelationMerge, readMergeManifest, relationStatements, resolveContactAlias, type MergeManifest } from "../src/customer/merge-relations";
import { fixture, type Fixture } from "./service-center-fixture";

beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Rede inesperada no teste de junção"); }); });
afterEach(() => vi.restoreAllMocks());
async function contact(f: Fixture, name = "Pessoa", phone = "", erp: string | null = null) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated,erp_contact_id,erp_version) VALUES(?,?,'team',?,?,?,'automatic','test','test',?,?,?,?)", id, f.profile, name, phone, name, now(), now(), erp, erp ? 1 : null);
  return id;
}
async function whatsapp(f: Fixture, id: string, phone: string) {
  const c = uid(), session = uid(), at = now();
  await batch(env, [
    ["INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) VALUES(?,'team',?,?,'observed')", [f.profile, phone, id]],
    ["INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')", [f.profile, phone, id]],
    ["INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_identity_proof,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,?,'ready',?,?,?,?)", [c, f.profile, f.line, `channel:${f.line}`, phone, phone, phone, id, session, at, at, at]],
    ["INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created) VALUES(?,'team',?,?,?,?)", [f.profile, phone, id, c, at]],
    ["INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'identity',?)", [c, f.profile, id, at]],
    ["INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'conversations','session',?,?,?,'identity',?)", [f.profile, `${c}:${session}`, id, c, at]],
  ]);
  return c;
}
async function merge(f: Fixture, source: string, target: string, command = uid()) {
  const preview = await previewContactMerge(env, f.admin, f.profile, source, { targetId: target });
  const input = { targetId: target, sourceVersion: preview.source.version, targetVersion: preview.target.version, previewToken: preview.previewToken, fieldChoices: {} };
  return { result: await mergeContacts(env, f.admin, f.profile, source, command, input), input, command, preview };
}
async function insert(table: string, values: Record<string, unknown>) {
  const keys = Object.keys(values);
  await exec(env, `INSERT INTO ${table}(${keys.map(k => `"${k}"`).join(",")}) VALUES(${keys.map(() => "?").join(",")})`, ...keys.map(k => values[k]));
}

/** Fixtures sintéticas mínimas, mantendo todas as FKs e os CHECKs dos módulos. */
async function everyRelation(f: Fixture, owner: string, c: string) {
  const at = now(), common = { profile_id: f.profile, contact_id: owner, created_by: "test", created: at, updated: at };
  const order = uid(), person = uid(), schoolClass = uid(), subject = uid();
  await insert("web_steps", { id: uid(), profile_id: f.profile, conversation_id: c, contact_id: owner, module_id: "forms", kind: "form", code_hash: uid(), title: "Formulário", spec: '{"private":"SEGREDO DO MÓDULO"}', trigger: "agent", actor: "test", expires_at: at + 100000, created: at, updated: at });
  await insert("agenda_appointments", { ...common, id: uid(), service_id: uid(), professional_id: uid(), starts: at, ends: at + 60000, source: "panel", service_name: "Atendimento", booked_at: at, notes: "SEGREDO DO MÓDULO" });
  await insert("os_orders", { ...common, id: order, number: 1, item: "Item", problem: "Problema", source: "panel", notes: "SEGREDO DO MÓDULO" });
  await insert("pedido_orders", { ...common, id: uid(), number: 1, status: "received", status_at: at, source: "panel", lines: "[]", item_count: 0, subtotal_cents: 0, total_cents: 0, fulfillment: "pickup", payment_status: "pending", notes: "SEGREDO DO MÓDULO" });
  await insert("reserva_bookings", { ...common, id: uid(), number: 1, unit_id: uid(), unit_name: "Unidade", mode: "hourly", starts: at, ends: at + 60000, arrival_at: at, departure_at: at + 60000, status: "confirmed", source: "panel", price_cents: 0, notes: "SEGREDO DO MÓDULO" });
  await insert("mensalidade_subscriptions", { ...common, id: uid(), plan_id: uid(), period: "monthly", amount_cents: 100, due_day: 10, start_date: "2026-01-01", bill_from: "2026-01-01", notes: "SEGREDO DO MÓDULO" });
  await insert("os_people", { ...common, id: person, order_id: order, role: "responsible", name: "Pessoa privada", note: "SEGREDO DO MÓDULO", sensitive: 1 });
  await insert("mensalidade_payers", { ...common, id: uid(), name: "Pagador", notes: "SEGREDO DO MÓDULO" });
  await insert("cond_people", { profile_id: f.profile, id: uid(), contact_id: owner, name: "Morador" });
  await insert("ensino_classes", { profile_id: f.profile, id: schoolClass, name: "Turma", school_year: "2026", start_date: "2026-01-01", end_date: "2026-12-31", teacher_id: uid(), type_id: "school", capacity: 10, schedule_json: "[]", periods_json: "[]", rule_json: "{}", justified_counts: 0, created: at });
  await insert("ensino_guardians", { profile_id: f.profile, id: uid(), contact_id: owner, order_id: order, person_id: person, person_version: 1, phone_hash: "hash-autenticado", valid_until: "2026-12-31", verified_by: "test", created: at });
  await insert("ensino_enrollments", { profile_id: f.profile, id: uid(), billing_contact_id: owner, class_id: schoolClass, order_id: order, start_date: "2026-01-01", end_date: "2026-12-31" });
  await insert("saude_subjects", { profile_id: f.profile, id: subject, kind: "human", payload_enc: "SEGREDO DO MÓDULO", created: at, last_activity: at });
  await insert("saude_contact_links", { profile_id: f.profile, subject_id: subject, contact_id: owner, relation: "self" });
  await insert("customer_sections", { profile_id: f.profile, contact_id: owner, module_id: "condominio", section_id: "units" });
  const social = uid(), identity = uid();
  await insert("conversations", { id: social, profile_id: f.profile, connection_id: f.second, external_namespace: `channel:${f.second}`, external_id: uid(), channel: "instagram", channel_account_id: "conta", channel_subject_id: "perfil-opaco", session: uid(), last_customer: at, created: at, updated: at });
  await insert("customer_channel_ids", { id: identity, profile_id: f.profile, namespace: "team", channel: "instagram", account_id: "conta", subject_namespace: "dm", subject_id: "perfil-opaco", contact_id: owner, connection_id: f.second, proof_conversation_id: social, state: "ready", created: at, updated: at });
  await exec(env, "UPDATE conversations SET channel_identity_id=?,customer_link_state='ready' WHERE id=?", identity, social);
  await insert("conversation_contacts", { profile_id: f.profile, conversation_id: social, contact_id: owner, linked_by: "channel_identity", created: at });
}

describe("junção de contatos por canal", () => {
  it("a ficha team preserva o canal social ao seguir alias e não atravessa o namespace de aplicação", async () => {
    const f = await fixture(), source = await contact(f), target = await contact(f), app = await contact(f);
    const port = createProfilePort(), scope = withReadCache(env);
    expect(await port.view(scope, f.admin, f.profile, target)).not.toHaveProperty("channels");
    await exec(env, "UPDATE contacts SET namespace='app:outra' WHERE id=?", app);
    const appView = await port.view(scope, f.admin, f.profile, app);
    expect(appView).toMatchObject({ contactId: app, namespace: "app:outra", depth: "simple", erpContactId: null, contributions: [] });
    expect(appView).not.toHaveProperty("channels");
    expect(appView).not.toHaveProperty("merge");
    const social = uid(), identity = uid(), at = now();
    await insert("conversations", { id: social, profile_id: f.profile, connection_id: f.second,
      external_namespace: `channel:${f.second}`, external_id: uid(), channel: "instagram",
      session: uid(), last_customer: at, created: at, updated: at });
    await insert("customer_channel_ids", { id: identity, profile_id: f.profile, namespace: "team", channel: "instagram",
      account_id: "conta", subject_namespace: "dm", subject_id: "sujeito", contact_id: source,
      connection_id: f.second, proof_conversation_id: social, state: "ready", created: at, updated: at });
    expect(await port.view(scope, f.admin, f.profile, source)).toMatchObject({
      contactId: source, channels: [expect.objectContaining({ id: identity, channel: "instagram" })],
    });
    await merge(f, source, target);
    expect(await port.view(scope, f.admin, f.profile, source)).toMatchObject({
      contactId: target, channels: [expect.objectContaining({ id: identity, channel: "instagram" })],
      merge: { merged_into: target },
    });
    // Mesmo um alias inconsistente não autoriza a ficha de outro namespace.
    await exec(env, "UPDATE contacts SET merged_into=? WHERE id=?", app, target);
    await expect(port.view(scope, f.admin, f.profile, source)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("junta e desfaz toda a allowlist no D1, conservando conteúdo e papéis dos módulos", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f), c = await whatsapp(f, a, "5511987654321");
    await everyRelation(f, a, c);
    const original = await Promise.all(MERGE_RELATIONS.map(r => all(env, `SELECT * FROM ${r.table} WHERE profile_id=? AND ${r.owner}=?`, f.profile, a)));
    expect(original.every(rows => rows.length > 0)).toBe(true);
    const r = await merge(f, a, b);
    for (const [index, spec] of MERGE_RELATIONS.entries()) {
      expect(await all(env, `SELECT * FROM ${spec.table} WHERE profile_id=? AND ${spec.owner}=?`, f.profile, a), spec.table).toEqual([]);
      const moved = await all(env, `SELECT * FROM ${spec.table} WHERE profile_id=? AND ${spec.owner}=?`, f.profile, b);
      expect(moved, spec.table).toHaveLength(original[index].length);
      const omit = (row: any) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== spec.owner && !(spec.table === "customer_phones" && key === "version") && !(spec.table === "customer_channel_ids" && ["version", "updated"].includes(key))));
      expect(moved.map(omit).sort((x, y) => canonical(x).localeCompare(canonical(y))), spec.table).toEqual(original[index].map(omit).sort((x, y) => canonical(x).localeCompare(canonical(y))));
    }
    const saved = await one(env, "SELECT before_cipher FROM customer_merges WHERE profile_id=? AND id=?", f.profile, r.result.id);
    expect(canonical(await unseal(env, saved.before_cipher))).not.toContain("SEGREDO DO MÓDULO");
    await undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id });
    for (const [index, spec] of MERGE_RELATIONS.entries()) {
      const restored = await all(env, `SELECT * FROM ${spec.table} WHERE profile_id=? AND ${spec.owner}=?`, f.profile, a);
      const omit = (row: any) => Object.fromEntries(Object.entries(row).filter(([key]) => !(spec.table === "customer_phones" && key === "version") && !(spec.table === "customer_channel_ids" && ["version", "updated"].includes(key))));
      expect(restored.map(omit).sort((x, y) => canonical(x).localeCompare(canonical(y))), spec.table).toEqual(original[index].map(omit).sort((x, y) => canonical(x).localeCompare(canonical(y))));
      expect(await all(env, `SELECT * FROM ${spec.table} WHERE profile_id=? AND ${spec.owner}=?`, f.profile, b), spec.table).toEqual([]);
    }
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("só WhatsApp: conserva as provas, todas as relações telefônicas e desfaz sem ressuscitar contexto do bot", async () => {
    const f = await fixture(), a = await contact(f, "A", "5511987654321"), b = await contact(f, "B", "5511987654322");
    const ca = await whatsapp(f, a, "5511987654321"), cb = await whatsapp(f, b, "5511987654322");
    await exec(env, "INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id) VALUES(?,?,'condominio','units')", f.profile, a);
    const r = await merge(f, a, b);
    expect(r.result).toMatchObject({ sourceId: a, targetId: b, state: "applied", duplicate: false });
    expect(await resolveContactAlias(env, f.profile, a)).toMatchObject({ id: b });
    expect(await all(env, "SELECT customer_identity_proof,verified_phone FROM conversations WHERE profile_id=? ORDER BY verified_phone", f.profile)).toEqual([
      { customer_identity_proof: b, verified_phone: "5511987654321" }, { customer_identity_proof: b, verified_phone: "5511987654322" },
    ]);
    expect(await one(env, "SELECT count(*) n FROM customer_phone_proofs WHERE profile_id=? AND contact_id=? AND revoked=0", f.profile, b)).toEqual({ n: 2 });
    expect(await one(env, "SELECT identity_state,merged_into FROM contacts WHERE id=?", a)).toEqual({ identity_state: "active", merged_into: b });
    const undo = await undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id });
    expect(undo.state).toBe("undone");
    expect(await all(env, "SELECT contact_id FROM conversation_contacts WHERE profile_id=? ORDER BY contact_id", f.profile)).toEqual([a, b].sort().map(contact_id => ({ contact_id })));
    expect(await one(env, "SELECT customer_identity_proof,epoch FROM conversations WHERE id=?", ca)).toEqual({ customer_identity_proof: a, epoch: 2 });
    expect(await one(env, "SELECT customer_identity_proof,epoch FROM conversations WHERE id=?", cb)).toEqual({ customer_identity_proof: b, epoch: 2 });
    expect(await one(env, "SELECT contact_id FROM customer_sections WHERE profile_id=?", f.profile)).toEqual({ contact_id: a });
  });

  it("o backfill telefônico não recria candidatos da origem arquivada e mantém o desfazer", async () => {
    const f = await fixture(), first = "5511987654321", second = "5511987654322";
    const a = await contact(f, "Origem", first), b = await contact(f, "Destino", second);
    await whatsapp(f, a, first); await whatsapp(f, b, second);
    const mirror = JSON.stringify({ name: "Origem", phones: [first], email: "", document: null, personType: null });
    await exec(env, "UPDATE contacts SET mirror_json=? WHERE id=?", mirror, a);
    const r = await merge(f, a, b);
    await exec(env, "INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated) VALUES(?,'team',?,'{}',0,?) ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json='{}',complete=0", f.profile, CONTACT_TASK, now());
    await customerIdentity.maintain(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(await all(env, "SELECT * FROM customer_phone_candidates WHERE profile_id=? AND contact_id=?", f.profile, a)).toEqual([]);
    expect(await one(env, "SELECT phone,mirror_json,identity_state FROM contacts WHERE id=?", a)).toEqual({ phone: "", mirror_json: JSON.stringify({ ...JSON.parse(mirror), phones: [] }), identity_state: "active" });
    expect(await one(env, "SELECT count(*) n FROM customer_phone_proofs WHERE profile_id=? AND contact_id=? AND revoked=0", f.profile, b)).toEqual({ n: 2 });
    await undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id });
    expect(await one(env, "SELECT phone,mirror_json FROM contacts WHERE id=?", a)).toEqual({ phone: first, mirror_json: mirror });
    expect(await one(env, "SELECT contact_id FROM customer_phone_candidates WHERE profile_id=? AND phone=?", f.profile, first)).toEqual({ contact_id: a });
  });

  it("repete a chave sem efeito e recusa corpo diferente e replay sem permissão", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f), r = await merge(f, a, b);
    expect(await mergeContacts(env, f.admin, f.profile, a, r.command, r.input)).toMatchObject({ duplicate: true, id: r.result.id });
    await expect(mergeContacts(env, f.admin, f.profile, a, r.command, { ...r.input, reason: "outro" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(mergeContacts(env, { ...f.admin, role: "operator", access: ["*"] }, f.profile, a, r.command, r.input)).rejects.toMatchObject({ status: 403 });
    expect(await one(env, "SELECT count(*) n FROM audit WHERE profile_id=? AND operation='contact.merge'", f.profile)).toEqual({ n: 1 });
    const key = uid(), body = { mergeId: r.result.id };
    await undoContactMerge(env, f.admin, f.profile, a, key, body);
    expect(await undoContactMerge(env, f.admin, f.profile, a, key, body)).toMatchObject({ duplicate: true, state: "undone" });
    await expect(undoContactMerge(env, f.admin, f.profile, a, key, { ...body, sourceVersion: 999 })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it.each(["message", "contact", "reference", "conversation"])("bloqueia desfazer após alteração de %s", async kind => {
    const f = await fixture(), a = await contact(f), b = await contact(f), c = await whatsapp(f, a, "5511987654321"), r = await merge(f, a, b);
    if (kind === "message") await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','depois',?)", uid(), f.profile, c, now());
    if (kind === "contact") await exec(env, "UPDATE contacts SET version=version+1,name='Depois' WHERE id=?", b);
    if (kind === "reference") await exec(env, "INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id) VALUES(?,?,'condominio','units')", f.profile, b);
    if (kind === "conversation") await exec(env, "UPDATE conversations SET title='Mudou' WHERE id=?", c);
    await expect(undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id })).rejects.toMatchObject({ code: "merge_changed" });
    expect(await one(env, "SELECT merged_into FROM contacts WHERE id=?", a)).toEqual({ merged_into: b });
  });

  it("bloqueia conflitos de PK e deduplica somente relações iguais, restaurando a duplicata", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f);
    await batch(env, [a, b].map(id => ["INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id,version) VALUES(?,?,'condominio','units',1)", [f.profile, id]]));
    await exec(env, "UPDATE customer_sections SET version=2 WHERE profile_id=? AND contact_id=?", f.profile, b);
    expect((await previewContactMerge(env, f.admin, f.profile, a, { targetId: b })).blockers).toContainEqual(expect.objectContaining({ code: "merge_relation_conflict" }));
    await exec(env, "UPDATE customer_sections SET version=1 WHERE profile_id=? AND contact_id=?", f.profile, b);
    const r = await merge(f, a, b);
    expect(await one(env, "SELECT count(*) n FROM customer_sections WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    await undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id });
    expect(await one(env, "SELECT count(*) n FROM customer_sections WHERE profile_id=?", f.profile)).toEqual({ n: 2 });
  });

  it("faz sobreviver a ficha ERP mesmo na ordem inversa e recusa dois ERP IDs", async () => {
    const f = await fixture(), erp = await contact(f, "ERP", "", "erp-1"), social = await contact(f, "Social");
    const r = await merge(f, erp, social);
    expect(r.preview).toMatchObject({ source: { id: erp }, target: { id: social }, survivorId: erp });
    expect(r.result).toMatchObject({ sourceId: social, targetId: erp });
    const other = await contact(f, "Outro ERP", "", "erp-2");
    expect((await previewContactMerge(env, f.admin, f.profile, erp, { targetId: other })).blockers).toContainEqual(expect.objectContaining({ code: "merge_erp_conflict" }));
  });

  it("confere conjuntos no lote e serializa duas confirmações concorrentes", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f);
    const preview = await previewContactMerge(env, f.admin, f.profile, a, { targetId: b });
    const input = { targetId: b, sourceVersion: 1, targetVersion: 1, previewToken: preview.previewToken, fieldChoices: {} }, command = uid();
    const results = await Promise.all([mergeContacts(env, f.admin, f.profile, a, command, input), mergeContacts(env, f.admin, f.profile, a, command, input)]);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(await one(env, "SELECT count(*) n FROM customer_merges WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
  });

  it("a assertion transacional recusa referência criada depois da leitura e reverte o lote", async () => {
    const f = await fixture(), a = await contact(f, "Antes"), b = await contact(f);
    const manifest = await readMergeManifest(env, f.profile, [a, b]);
    await insert("customer_sections", { profile_id: f.profile, contact_id: a, module_id: "condominio", section_id: "units" });
    await expect(batch(env, [...assertManifest(manifest, uid()), ["UPDATE contacts SET name='Não deve salvar' WHERE id=?", [a]]])).rejects.toThrow();
    expect(await one(env, "SELECT name FROM contacts WHERE id=?", a)).toEqual({ name: "Antes" });
  });

  it("confere 100 colunas sem exceder a profundidade do D1 nem perder alterações do manifesto", async () => {
    const f = await fixture(), contactId = await contact(f, "Antes");
    const table = `cn_merge_manifest_${uid().replace(/-/g, "")}`;
    const fields = Array.from({ length: 98 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const columns = ["id", "profile_id", ...fields];
    // Apenas a fixture tem este schema: nenhuma tabela de produto é alterada.
    await exec(env, `CREATE TABLE ${table}(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,${fields.map((c, i) => `${c} ${i % 3 === 0 ? "REAL" : "TEXT"}`).join(",")})`);
    try {
      const rows = ["one", "two"].map(id => ({
        id, profile_id: f.profile,
        ...Object.fromEntries(fields.map((c, i) => [c, i % 3 === 0 ? 1 : i % 3 === 1 ? `${id} · João, junção e memória` : null])),
      }));
      // Um parâmetro JSON evita confundir profundidade SQL com limite de binds.
      await exec(env, `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map(c => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?)`, JSON.stringify(rows));
      const original = await all(env, `SELECT * FROM ${table} ORDER BY id`);
      const manifest: MergeManifest = { conversationIds: [], tables: [{ table, columns, rows: original, where: "profile_id=?", args: [f.profile] }] };
      expect(columns).toHaveLength(100);
      expect(await one(env, `SELECT typeof(c000) real_type,c095,c097 FROM ${table} WHERE id='one'`)).toEqual({ real_type: "real", c095: null, c097: "one · João, junção e memória" });
      // Precisa passar antes das rejeições: um erro de parser não prova integridade.
      await batch(env, assertManifest(manifest, uid()));
      await batch(env, assertManifest({ conversationIds: [], tables: [{ ...manifest.tables[0], rows: [], args: [uid()] }] }, uid()));

      const mutations = [
        `UPDATE ${table} SET c097='Alteração tardia' WHERE id='one'`,
        `UPDATE ${table} SET c095='' WHERE id='one'`,
        `UPDATE ${table} SET c096=1.25 WHERE id='one'`,
        // Os mesmos valores continuam presentes, mas associados à linha errada.
        `UPDATE ${table} SET c097=CASE id WHEN 'one' THEN 'two · João, junção e memória' ELSE 'one · João, junção e memória' END`,
        `DELETE FROM ${table} WHERE id='one'`,
        `UPDATE ${table} SET id='substituído' WHERE id='one'`,
        `INSERT INTO ${table} SELECT 'extra',profile_id,${fields.join(",")} FROM ${table} WHERE id='one'`,
      ];
      for (const mutation of mutations) {
        const command = uid();
        await expect(batch(env, [
          [mutation, []],
          ["UPDATE contacts SET name='Não deve salvar' WHERE id=?", [contactId]],
          ...assertManifest(manifest, command),
        ])).rejects.toThrow(/CHECK constraint failed/i);
        expect(await all(env, `SELECT * FROM ${table} ORDER BY id`)).toEqual(original);
        expect(await one(env, "SELECT name FROM contacts WHERE id=?", contactId)).toEqual({ name: "Antes" });
        expect(await all(env, "SELECT id FROM customer_assert WHERE id=?", `merge:${command}:${table}`)).toEqual([]);
      }
    } finally {
      await exec(env, `DROP TABLE ${table}`);
    }
  });

  it("preenche apenas campos vazios e exige escolha explícita para substituir divergência", async () => {
    const f = await fixture(), a = await contact(f, "Origem", "5511987654321"), b = await contact(f, "Destino");
    const r = await merge(f, a, b);
    expect(await one(env, "SELECT name,phone FROM contacts WHERE id=?", b)).toEqual({ name: "Destino", phone: "5511987654321" });
    await undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id });
    const preview = await previewContactMerge(env, f.admin, f.profile, a, { targetId: b });
    await mergeContacts(env, f.admin, f.profile, a, uid(), { targetId: b, sourceVersion: preview.source.version, targetVersion: preview.target.version, previewToken: preview.previewToken, fieldChoices: { name: "source" } });
    expect(await one(env, "SELECT name FROM contacts WHERE id=?", b)).toEqual({ name: "Origem" });
  });

  it("recusa intenção cadastral ainda pendente, inclusive endereço cifrado", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f);
    await exec(env, "UPDATE contacts SET local_patch_cipher='intenção pendente' WHERE id=?", a);
    expect((await previewContactMerge(env, f.admin, f.profile, a, { targetId: b })).blockers).toContainEqual(expect.objectContaining({ code: "merge_jobs_pending" }));
  });

  it("não desfaz restrição e guarda snapshot cifrado sem conteúdo privado de módulos", async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f), c = await whatsapp(f, a, "5511987654321");
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','SEGREDO PRIVADO',?)", uid(), f.profile, c, now());
    const r = await merge(f, a, b), row = await one(env, "SELECT before_cipher FROM customer_merges WHERE profile_id=? AND id=?", f.profile, r.result.id);
    expect(row.before_cipher).not.toContain("SEGREDO PRIVADO");
    expect(canonical(await unseal(env, row.before_cipher))).not.toContain("SEGREDO PRIVADO");
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", b);
    await expect(undoContactMerge(env, f.admin, f.profile, a, uid(), { mergeId: r.result.id })).rejects.toMatchObject({ code: "merge_restricted" });
  });

  it.each(MERGE_RELATIONS.map(r => [r.table, r] as const))("reaponta e prepara restauração exclusiva da propriedade de %s", (_name, spec) => {
    const row: Record<string, any> = { profile_id: "area", id: "record", namespace: "team", conversation_id: "conversation", module_id: "module", kind: "kind", record_id: "record", section_id: "section", subject_id: "subject", relation: "self", phone: "5511987654321", version: 2, updated: 10, private_content: "NÃO COPIAR", [spec.owner]: "source" };
    const manifest: MergeManifest = { conversationIds: [], tables: MERGE_RELATIONS.map(r => ({ table: r.table, columns: [], where: "profile_id=?", args: ["area"], rows: r.table === spec.table ? [structuredClone(row)] : [] })) };
    const changes = planRelationMerge(manifest, "source", "target", 20);
    expect(manifestRows(manifest, spec.table)[0]).toMatchObject({ [spec.owner]: "target", private_content: "NÃO COPIAR" });
    expect(canonical(changes)).not.toContain("NÃO COPIAR");
    expect(relationStatements("area", changes)[0][0]).toContain("WHERE profile_id=?");
    const undo = relationStatements("area", changes, true)[0];
    expect(undo[1]).toContain("source");
    expect(undo[0]).not.toContain("private_content");
  });

  it("o inventário inclui alterações sem mudar a versão da ficha e isola a área", async () => {
    const f = await fixture(), other = await fixture(), a = await contact(f), b = await contact(f), x = await contact(other);
    const before = await readMergeManifest(env, f.profile, [a, b]);
    expect(manifestRows(before, "contacts").map(r => r.id).sort()).toEqual([a, b].sort());
    expect(manifestRows(cloneManifest(before), "contacts").some(r => r.id === x)).toBe(false);
    await expect(previewContactMerge(env, f.admin, f.profile, a, { targetId: x })).rejects.toMatchObject({ status: 404 });
  });
});
