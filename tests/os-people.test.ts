import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ApiError, now, uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { perform, settingsRevision } from "../src/service";
import * as motor from "../src/modules/os/public";
import type { ChildMutation } from "../src/modules/os/public";
import type { MutationRef } from "../src/modules/os/contracts";
import { peopleExtension } from "../src/modules/os/people/extension";
import { archivePerson, createPerson, listPeople, updatePerson } from "../src/modules/os/people/store";
import { personBody, personValues } from "../src/modules/os/people/model";
import { projectPerson, type PersonRow } from "../src/modules/os/people/privacy";
import { motorFixture, motorOrder, motorWorkType, MOTOR_SENTINEL, type MotorFixture } from "./os-motor-fixture";
import { receive } from "./service-center-fixture";

const realAuthorizedOrder = motor.authorizedOrder;
const values = { role: "Responsável", name: "Pessoa ligada", client_visible: false, sensitive: false };
const sensitiveActor = (f: MotorFixture): Actor => ({ ...f.member, access: ["*", "os:sensitive"] });

beforeEach(async () => {
  // F0 não entrega 0100. Suporte local de FK, sem alterar a fixture ou a migração P.
  await exec(env, "CREATE UNIQUE INDEX IF NOT EXISTS os_people_test_parent ON os_orders(profile_id,id)");
});
afterEach(() => vi.restoreAllMocks());

/** Só a resolução do tipo é substituída. Área, escopo e titular usam F0 real. */
async function setupPeople() {
  const f = await motorFixture();
  const order = await motorOrder(f);
  const customOrders = new Set([order.id]);
  vi.spyOn(motor, "authorizedOrder").mockImplementation(async (...args) => {
    const authorized = await realAuthorizedOrder(...args);
    return customOrders.has(authorized.row.id)
      ? { ...authorized, type: motorWorkType() }
      : authorized;
  });
  return { ...f, order, customOrders };
}

/** Adaptador local de commitChild: exercita SQL/CAS/replay; não simula a entrega de M. */
function localCommit() {
  const mutations: ChildMutation[] = [];
  const receipts = new Map<string, MutationRef>();
  const commit = vi.spyOn(motor, "commitChild").mockImplementation(async (ctx, _actor, order, mutation) => {
    mutations.push(structuredClone(mutation));
    const replay = receipts.get(mutation.mutation_key);
    if (replay) return replay;
    const results = await batch(ctx.env, mutation.statements);
    if (results[0].meta.changes !== 1)
      throw new ApiError(409, "version_conflict", "Versão conflitante no adaptador local.");
    const result = { id: mutation.id, order_id: order.row.id, version: (mutation.expected_version ?? 0) + 1 };
    receipts.set(mutation.mutation_key, result);
    return result;
  });
  return { commit, mutations };
}

async function seedPerson(f: MotorFixture, orderId: string, overrides: Partial<PersonRow> = {}) {
  const at = now();
  const row: PersonRow = {
    id: uid(), order_id: orderId, role: "Tutor", name: "Pessoa",
    contact_id: null, phone: "5511987654321", email: "pessoa@example.test", note: "Nota interna",
    client_visible: 0, sensitive: 0, version: 1, created_by: f.member.id,
    created: at, updated: at, archived_at: null, ...overrides,
  };
  await exec(env,
    `INSERT INTO os_people(id,profile_id,order_id,role,name,contact_id,phone,email,note,
     client_visible,sensitive,version,created_by,created,updated,archived_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id, f.profile, orderId, row.role, row.name, row.contact_id, row.phone, row.email, row.note,
    row.client_visible, row.sensitive, row.version, row.created_by, row.created, row.updated, row.archived_at);
  return row;
}

async function seedContact(f: MotorFixture, namespace = "team") {
  const id = uid();
  await exec(env,
    `INSERT INTO contacts(id,profile_id,namespace,name,phone,email,notes,search_text,source,created_by,updated_by,created,updated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, f.profile, namespace, "Contato", "5511912345678", "contato@example.test", MOTOR_SENTINEL,
    "contato", "manual", f.member.id, f.member.id, now(), now());
  return id;
}

describe("P: contrato congelado e embutido", () => {
  it("exporta descritor sem registrar rotas nem um segundo agendador", () => {
    expect(peopleExtension.id).toBe("people");
    expect(peopleExtension.reads.map((r) => r.path)).toEqual(["service-orders/:id/people"]);
    expect(peopleExtension.writes).toEqual([
      { method: "POST", path: "service-orders/:id/people", op: "os.person.create" },
      { method: "PATCH", path: "service-orders/:id/people/:person_id", op: "os.person.update" },
      { method: "POST", path: "service-orders/:id/people/:person_id/archive", op: "os.person.archive" },
    ]);
    expect(peopleExtension.commands.map((c) => c.op)).toEqual(peopleExtension.writes.map((r) => r.op));
    expect(peopleExtension.runDue).toBeUndefined();
  });

  it("preserva filhos desligados no embutido e não escreve", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    for (const action of [
      () => listPeople(f.ctx, f.member, order.id),
      () => createPerson(f.ctx, f.member, { id: order.id, ...values }, uid()),
      () => updatePerson(f.ctx, f.member, { id: order.id, person_id: uid(), version: 1, name: "X" }, uid()),
      () => archivePerson(f.ctx, f.member, { id: order.id, person_id: uid(), version: 1 }, uid()),
    ]) await expect(action()).rejects.toMatchObject({ status: 409, code: "feature_disabled" });
    expect(await all(env, "SELECT id FROM os_people WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await one(env, "SELECT status,phone FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id))
      .toEqual({ status: "received", phone: "5511960010203" });
  });

  it("propaga erro da fronteira commitChild (sem provar atomicidade)", async () => {
    const f = await setupPeople();
    // Falha explícita da fronteira, válida também depois que M for integrado.
    vi.spyOn(motor, "commitChild").mockRejectedValue(
      new ApiError(501, "not_implemented", "Tarefa M: commitChild."),
    );
    await expect(createPerson(f.ctx, f.member, { id: f.order.id, ...values }, uid()))
      .rejects.toMatchObject({ status: 501, code: "not_implemented" });
    expect(await all(env, "SELECT id FROM os_people WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("reverte filho, histórico e atividade quando o lote real falha depois da escrita", async () => {
    const f = await motorFixture();
    await perform(env, f.admin, f.profile, "settings", {
      os_work_types: [motorWorkType()], settings_revision: await settingsRevision(env, f.profile),
    }, uid());
    const order = await motorOrder(f, { type_id: motorWorkType().id });
    await exec(env, "UPDATE os_orders SET updated=1,stale_notified_at=1 WHERE profile_id=? AND id=?", f.profile, order.id);
    const before = await one(env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id);
    const history = await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=? ORDER BY id", f.profile, order.id);
    // O gatilho falha no fim do lote, após INSERT do filho e do histórico e
    // UPDATE do pai. Nenhum mock de commitChild, batch ou persistência.
    const trigger = `os_people_rollback_${uid().replaceAll("-", "")}`;
    const orderLiteral = order.id.replaceAll("'", "''");
    await exec(env, `CREATE TRIGGER ${trigger} AFTER UPDATE OF updated ON os_orders
      WHEN NEW.id='${orderLiteral}' AND EXISTS (
        SELECT 1 FROM os_people p WHERE p.profile_id=NEW.profile_id AND p.order_id=NEW.id
      ) BEGIN SELECT RAISE(ABORT,'P_ROLLBACK_AFTER_PARENT'); END`);
    const requestId = uid();
    const data = { id: order.id, ...values };
    try {
      await expect(createPerson(f.ctx, f.member, data, requestId)).rejects.toThrow("P_ROLLBACK_AFTER_PARENT");
      expect(await all(env, "SELECT id FROM os_people WHERE profile_id=? AND order_id=?", f.profile, order.id)).toEqual([]);
      expect(await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=? ORDER BY id", f.profile, order.id)).toEqual(history);
      expect(await one(env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id)).toEqual(before);
      expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.person.created'", f.profile)).toEqual([]);
    } finally {
      await exec(env, `DROP TRIGGER ${trigger}`);
    }
    const person = await createPerson(f.ctx, f.member, data, requestId);
    expect(await createPerson(f.ctx, f.member, data, requestId)).toEqual(person);
    expect(await all(env, "SELECT id FROM os_people WHERE profile_id=? AND order_id=?", f.profile, order.id)).toHaveLength(1);
    expect(await all(env, "SELECT entity_id FROM os_history WHERE profile_id=? AND order_id=? AND kind='os.person.created'", f.profile, order.id))
      .toEqual([{ entity_id: person.id }]);
    expect(await one(env, "SELECT stale_notified_at FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id)).toEqual({ stale_notified_at: null });
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.person.created'", f.profile)).toHaveLength(1);
  });
});

describe("P: cadastro, vínculo e versões", () => {
  it("cadastra e normaliza contato; SQL, referência e histórico proposto não concedem acesso", async () => {
    const f = await setupPeople();
    const contactId = await seedContact(f);
    const { mutations } = localCommit();
    const before = await one(env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", f.profile, f.order.id);
    const key = uid();
    const input = { id: f.order.id, ...values, role: "  Advogado da parte  ", name: "  José  ",
      contact_id: contactId, phone: "(11) 98765-4321", email: "jose@example.test", note: MOTOR_SENTINEL };
    const person = await createPerson(f.ctx, f.member, input, key);
    expect(Object.keys(person).sort()).toEqual(["id", "order_id", "version"]);
    expect(person).toMatchObject({ order_id: f.order.id, version: 1 });
    expect(await createPerson(f.ctx, f.member, input, key)).toEqual(person);
    const page = await listPeople(f.ctx, f.member, f.order.id);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ role: "Advogado da parte", name: "José", phone: "5511987654321", contact_id: contactId });
    expect(page.data[0]).not.toHaveProperty("profile_id");
    const mutation = mutations[0];
    expect(mutation).toMatchObject({ entity_kind: "person", id: person.id, expected_version: null, event: "os.person.created" });
    expect(mutation.statements).toHaveLength(1);
    expect(mutation.statements[0][0]).not.toMatch(/INSERT INTO (users|conversation_contacts)|UPDATE os_orders/i);
    const { statements: _sql, ...metadata } = mutation;
    expect(JSON.stringify(metadata)).not.toContain(MOTOR_SENTINEL);
    expect(JSON.stringify(person)).not.toContain(MOTOR_SENTINEL);
    expect(await one(env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", f.profile, f.order.id)).toEqual(before);
    expect(await all(env, "SELECT * FROM conversation_contacts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("recusa contato de outra área, inexistente ou namespace alheio", async () => {
    const f = await setupPeople();
    const other = await motorFixture();
    const foreign = await seedContact(other);
    const { commit } = localCommit();
    for (const contact_id of [foreign, uid()])
      await expect(createPerson(f.ctx, f.member, { id: f.order.id, ...values, contact_id }, uid()))
        .rejects.toMatchObject({ status: 404, code: "contact_not_found" });
    const contact_id = await seedContact(f, "app:outra");
    const person = await seedPerson(f, f.order.id);
    await expect(updatePerson(f.ctx, f.member,
      { id: f.order.id, person_id: person.id, version: 1, contact_id: foreign }, uid()))
      .rejects.toMatchObject({ code: "contact_not_found" });
    const app: Actor = { ...f.member, kind: "app", scopes: ["conversations:write", "contacts:read"] };
    await expect(createPerson(f.ctx, app, { id: f.order.id, ...values, contact_id }, uid()))
      .rejects.toMatchObject({ code: "contact_not_found" });
    await expect(createPerson(f.ctx, { ...app, scopes: ["conversations:write"] },
      { id: f.order.id, ...values, contact_id }, uid())).rejects.toMatchObject({ status: 403 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("edita e arquiva por versão do filho, com replay estável", async () => {
    const f = await setupPeople();
    const { mutations } = localCommit();
    const person = await createPerson(f.ctx, f.member, { id: f.order.id, ...values }, uid());
    const input = { id: f.order.id, person_id: person.id, version: 1, phone: "11912345678", name: "Novo nome", contact_id: null };
    const key = uid();
    const updated = await updatePerson(f.ctx, f.member, input, key);
    expect(updated.version).toBe(2);
    expect(await updatePerson(f.ctx, f.member, input, key)).toEqual(updated);
    await expect(updatePerson(f.ctx, f.member, { ...input, name: "Concorrente" }, uid()))
      .rejects.toMatchObject({ code: "version_conflict" });
    const archivedInput = { id: f.order.id, person_id: person.id, version: 2 };
    const archiveKey = uid();
    const archived = await archivePerson(f.ctx, f.member, archivedInput, archiveKey);
    expect(archived.version).toBe(3);
    expect(await archivePerson(f.ctx, f.member, archivedInput, archiveKey)).toEqual(archived);
    expect(await listPeople(f.ctx, f.member, f.order.id)).toEqual({ data: [], next_cursor: null });
    await expect(updatePerson(f.ctx, f.member, { ...input, version: 3 }, uid()))
      .rejects.toMatchObject({ code: "version_conflict" });
    const row = await one(env, "SELECT * FROM os_people WHERE profile_id=? AND order_id=? AND id=?", f.profile, f.order.id, person.id);
    expect(row).toMatchObject({ version: 3, name: "Novo nome", phone: "5511912345678" });
    expect(row.archived_at).toBeGreaterThan(0);
    expect(mutations[1].statements[0][0]).toContain("AND version=?");
    expect(mutations[1].statements[0][0]).not.toContain("row_version");
  });

  it("conta arquivados no teto de 200 e conserva replay no limite", async () => {
    const f = await setupPeople();
    const { commit } = localCommit();
    const key = uid();
    const input = { id: f.order.id, ...values };
    const first = await createPerson(f.ctx, f.member, input, key);
    await batch(env, Array.from({ length: 199 }, () => [
      `INSERT INTO os_people(id,profile_id,order_id,role,name,created_by,created,updated,archived_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [uid(), f.profile, f.order.id, "Tutor", "Pessoa", f.member.id, now(), now(), now()],
    ] as [string, unknown[]]));
    expect(await createPerson(f.ctx, f.member, input, key)).toEqual(first);
    await expect(createPerson(f.ctx, f.member, input, uid())).rejects.toMatchObject({ status: 409, code: "collection_limit" });
    expect(commit).toHaveBeenCalledTimes(2);
    expect((await listPeople(f.ctx, f.member, f.order.id)).data).toHaveLength(1);
  });
});

describe("P: isolamento e privacidade", () => {
  it("telefone e contact_id ligados não tornam a pessoa titular nem concedem credencial", async () => {
    const f = await setupPeople();
    const phone = "5511976543210";
    const c = await receive(f, f.line, "oi", phone);
    const contact_id = await seedContact(f);
    localCommit();
    await createPerson(f.ctx, f.member, { id: f.order.id, ...values, phone, contact_id, client_visible: true }, uid());
    await expect(realAuthorizedOrder(f.ctx, f.member, f.order.id, { conversation_id: c.id }))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
    const bound: Actor = { ...f.member, kind: "app", scopes: ["conversations:read", "conversations:bound"] };
    await expect(listPeople(f.ctx, bound, f.order.id)).rejects.toMatchObject({ code: "not_found" });
    const credential = { ...f.member, credential: { id: uid(), module: "os", subject: contact_id } };
    await expect(listPeople(f.ctx, credential, f.order.id)).rejects.toMatchObject({ code: "not_found" });
    const owner = await receive(f, f.line, "oi", "5511960010203");
    expect((await realAuthorizedOrder(f.ctx, f.member, f.order.id, { conversation_id: owner.id })).row.id).toBe(f.order.id);
  });

  it("confere módulo, escopos, área e pai também nas escritas", async () => {
    const f = await setupPeople();
    const other = await motorFixture();
    const otherOrder = await motorOrder(f);
    f.customOrders.add(otherOrder.id);
    const person = await seedPerson(f, f.order.id);
    const { commit } = localCommit();
    await expect(listPeople(modulesApi(env, other.profile, "os"), other.member, f.order.id))
      .rejects.toMatchObject({ status: 404 });
    await expect(updatePerson(f.ctx, f.member, { id: otherOrder.id, person_id: person.id, version: 1, name: "X" }, uid()))
      .rejects.toMatchObject({ status: 404 });
    await expect(archivePerson(f.ctx, f.member, { id: otherOrder.id, person_id: person.id, version: 1 }, uid()))
      .rejects.toMatchObject({ status: 404 });
    const app: Actor = { ...f.member, kind: "app", scopes: [] };
    await expect(listPeople(f.ctx, app, f.order.id)).rejects.toMatchObject({ status: 403 });
    await expect(createPerson(f.ctx, app, { id: f.order.id, ...values }, uid())).rejects.toMatchObject({ status: 403 });
    await perform(env, f.admin, f.profile, "module.set", { id: "os", enabled: false }, uid());
    await expect(listPeople(f.ctx, f.member, f.order.id)).rejects.toMatchObject({ code: "module_disabled" });
    await expect(createPerson(f.ctx, f.member, { id: f.order.id, ...values }, uid())).rejects.toMatchObject({ code: "module_disabled" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("filtra contato e nota por escopo; documento não atravessa o DTO nem entra disfarçado", async () => {
    const f = await setupPeople();
    const row = await seedPerson(f, f.order.id, { contact_id: uid(), note: MOTOR_SENTINEL });
    const app: Actor = { ...f.member, kind: "app", scopes: ["conversations:read"] };
    const restricted = (await listPeople(f.ctx, app, f.order.id)).data[0];
    for (const field of ["phone", "email", "contact_id", "note", "document", "profile_id"])
      expect(restricted).not.toHaveProperty(field);
    const readable = (await listPeople(f.ctx, { ...app, scopes: [...app.scopes, "contacts:read", "notes:read"] }, f.order.id)).data[0];
    expect(readable).toMatchObject({ phone: row.phone, email: row.email, contact_id: row.contact_id, note: MOTOR_SENTINEL });
    const injected = { ...row, document: MOTOR_SENTINEL, profile_id: f.profile };
    expect(await projectPerson(f.ctx, f.member, injected)).not.toHaveProperty("document");
    expect(() => personBody({ ...values, document: MOTOR_SENTINEL }, "create")).toThrowError(ApiError);
    expect(() => personBody({ ...values, cpf: MOTOR_SENTINEL }, "create")).toThrowError(ApiError);
  });

  it("sensível é invisível para bot, via sem máscara, app e administrador sem papel", async () => {
    const f = await setupPeople();
    localCommit();
    const person = await createPerson(f.ctx, sensitiveActor(f), {
      id: f.order.id, ...values, sensitive: true, name: MOTOR_SENTINEL, note: MOTOR_SENTINEL,
    }, uid());
    const publicPerson = await seedPerson(f, f.order.id, { client_visible: 1 });
    await seedPerson(f, f.order.id, { name: "Interna" });
    const bot: Actor = { ...sensitiveActor(f), id: "bot:teste" };
    const via: Actor = { ...sensitiveActor(f), via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } };
    const app: Actor = { ...f.member, kind: "app", scopes: ["conversations:read", "conversations:write", "contacts:read", "notes:read"] };
    for (const actor of [f.member, f.admin, bot, via, app]) {
      const page = await listPeople(f.ctx, actor, f.order.id, { limit: "100" });
      expect(JSON.stringify(page)).not.toContain(MOTOR_SENTINEL);
      expect(page.data.map((p) => p.id)).not.toContain(person.id);
      expect(page.next_cursor).toBeNull();
      await expect(updatePerson(f.ctx, actor, { id: f.order.id, person_id: person.id, version: 1, name: "X" }, uid()))
        .rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(archivePerson(f.ctx, actor, { id: f.order.id, person_id: person.id, version: 1 }, uid()))
        .rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(createPerson(f.ctx, actor, { id: f.order.id, ...values, sensitive: true }, uid()))
        .rejects.toMatchObject({ code: "sensitive_forbidden" });
    }
    for (const actor of [bot, via]) {
      const page = await listPeople(f.ctx, actor, f.order.id);
      expect(page.data.map((p) => p.id)).toEqual([publicPerson.id]);
      for (const field of ["phone", "email", "contact_id", "note", "created_by"])
        expect(page.data[0]).not.toHaveProperty(field);
    }
    expect((await listPeople(f.ctx, sensitiveActor(f), f.order.id)).data.map((p) => p.id)).toContain(person.id);
  });
});

describe("P: paginação e validação", () => {
  it("pagina por chave e id, sem expor existência de pessoas ocultas", async () => {
    const f = await setupPeople();
    const at = now();
    const publicRows = [];
    for (let i = 0; i < 5; i++) publicRows.push(await seedPerson(f, f.order.id, { created: at }));
    await seedPerson(f, f.order.id, { sensitive: 1, name: MOTOR_SENTINEL, created: at + 1 });
    await seedPerson(f, f.order.id, { archived_at: at, created: at + 2 });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listPeople(f.ctx, f.member, f.order.id, { limit: "2", ...(cursor ? { cursor } : {}) });
      ids.push(...page.data.map((p) => p.id));
      expect(JSON.stringify(page)).not.toContain(MOTOR_SENTINEL);
      cursor = page.next_cursor;
      if (cursor) expect(typeof cursor).toBe("string");
    } while (cursor);
    expect(ids).toEqual(publicRows.map((p) => p.id).sort());
    const first = await listPeople(f.ctx, f.member, f.order.id, { limit: "2" });
    const otherOrder = await motorOrder(f);
    f.customOrders.add(otherOrder.id);
    await expect(listPeople(f.ctx, f.member, otherOrder.id, { cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(listPeople(f.ctx, sensitiveActor(f), f.order.id, { cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    const other = await motorFixture();
    const foreignOrder = await motorOrder(other);
    f.customOrders.add(foreignOrder.id);
    await expect(listPeople(other.ctx, other.member, foreignOrder.id, { cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    const decoded = JSON.parse(atob(first.next_cursor!));
    decoded[0][3] = "tasks";
    await expect(listPeople(f.ctx, f.member, f.order.id, { cursor: btoa(JSON.stringify(decoded)) }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    for (const bad of ["", "%%%", btoa("{}"), "x".repeat(2049)])
      await expect(listPeople(f.ctx, f.member, f.order.id, { cursor: bad })).rejects.toMatchObject({ code: "invalid_cursor" });
    const invalidQueries: Record<string, string>[] = [
      { limit: "0" }, { limit: "2.5" }, { limit: "no" }, { include_archived: "1" },
    ];
    for (const query of invalidQueries)
      await expect(listPeople(f.ctx, f.member, f.order.id, query)).rejects.toMatchObject({ code: "invalid_filter" });
  });

  it("aplica limite padrão 50 e máximo 100", async () => {
    const f = await setupPeople();
    await batch(env, Array.from({ length: 101 }, () => [
      "INSERT INTO os_people(id,profile_id,order_id,role,name,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      [uid(), f.profile, f.order.id, "Tutor", "Pessoa", f.member.id, now(), now()],
    ] as [string, unknown[]]));
    expect((await listPeople(f.ctx, f.member, f.order.id)).data).toHaveLength(50);
    const page = await listPeople(f.ctx, f.member, f.order.id, { limit: "500" });
    expect(page.data).toHaveLength(100);
    expect((await listPeople(f.ctx, f.member, f.order.id, { cursor: page.next_cursor! })).data).toHaveLength(1);
  });

  it("valida papéis livres, limites Unicode, tipos e classificação sem repetir valores no erro", async () => {
    expect(personValues({ ...values, role: "🧑".repeat(64), name: "😀".repeat(120) }).name).toBe("😀".repeat(120));
    expect(personValues({ ...values, phone: "+55 (11) 98765-4321" }).phone).toBe("5511987654321");
    for (const patch of [
      { role: " " }, { role: "🧑".repeat(65) }, { name: "😀".repeat(121) },
      { phone: "123" }, { phone: MOTOR_SENTINEL }, { email: "sem-arroba" },
      { note: "x".repeat(2001) }, { contact_id: "" }, { phone: null },
      { client_visible: "true" }, { sensitive: 1 }, { sensitive: true, client_visible: true },
    ]) {
      try {
        personValues({ ...values, ...patch });
        expect.fail("Entrada inválida foi aceita.");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_person" });
        expect(String(error)).not.toContain(MOTOR_SENTINEL);
      }
    }
    for (const body of [null, [], "texto", { ...values, document: MOTOR_SENTINEL }])
      expect(() => personBody(body, "create")).toThrowError(ApiError);
    const f = await setupPeople();
    const { commit } = localCommit();
    const person = await seedPerson(f, f.order.id);
    for (const version of [0, -1, 1.1, "1", null, Number.MAX_SAFE_INTEGER])
      await expect(updatePerson(f.ctx, f.member, { id: f.order.id, person_id: person.id, version, name: "X" }, uid()))
        .rejects.toMatchObject({ code: "invalid_person" });
    expect(commit).not.toHaveBeenCalled();
  });
});
