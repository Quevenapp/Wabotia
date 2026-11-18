import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { all, batch, exec } from "../src/db";
import { ApiError, uid, type Actor, type Env as WorkerEnv } from "../src/types";
import { onCommand, onRead, onRoute } from "../src/modules/api";
import type { MutationRef } from "../src/modules/os/contracts";
import * as motor from "../src/modules/os/public";
import { entriesExtension } from "../src/modules/os/entries/extension";
import { entryInput } from "../src/modules/os/entries/model";
import { archiveEntry, createEntry, listEntries, reviseEntry, summarizeEntries } from "../src/modules/os/entries/store";
import { api, receive } from "./service-center-fixture";
import { perform, settingsRevision } from "../src/service";
import { MOTOR_SENTINEL, motorFixture, motorOrder, motorWorkType } from "./os-motor-fixture";

// Tipagem local para a checagem isolada deste teste, fora do tsconfig de produção.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

// Registro somente neste isolado. Produção é registrada por I.
for (const route of entriesExtension.reads) onRead("os", route.path, route.handler);
for (const route of entriesExtension.writes) onRoute("os", route);
for (const command of entriesExtension.commands) onCommand("os", command.op, command.handler);

beforeAll(async () => {
  // Em F0 ainda não há 0100. Simula apenas sua chave referenciada pelo DDL
  // exato de 0104; não muda a fixture compartilhada nem a migração de M.
  await exec(env, "CREATE UNIQUE INDEX IF NOT EXISTS os_orders_profile_id ON os_orders(profile_id,id)");
});
afterEach(() => vi.restoreAllMocks());

const realAuthorizedOrder = motor.authorizedOrder;
const payload = (overrides: Record<string, unknown> = {}) => ({
  kind: "horas", text: "Trabalho realizado", quantity_milli: 1250, unit: "h",
  occurred_at: 1_800_000_000_000, client_visible: true, sensitive: false, ...overrides,
});

async function setup(options: { commit?: boolean } = {}) {
  const f = await motorFixture();
  const order = await motorOrder(f);
  // Mock explícito da resolução de M: conserva toda a autorização real de F0.
  vi.spyOn(motor, "authorizedOrder").mockImplementation(async (...args) => ({
    ...await realAuthorizedOrder(...args), type: motorWorkType(),
  }));
  const mutations: motor.ChildMutation[] = [];
  const published: MutationRef[] = [];
  const committed = new Map<string, MutationRef>();
  let failPublish = false;
  let tail: Promise<unknown> = Promise.resolve();
  if (options.commit !== false) vi.spyOn(motor, "commitChild").mockImplementation((ctx, actor, parent, mutation) => {
    // Dublê local do contrato de M, serializado como o Coordinator. Executa
    // SQL real e guarda histórico sem valores. Não prova a implementação de M.
    const run = tail.then(async () => {
      mutations.push(mutation);
      let ref = committed.get(mutation.mutation_key);
      if (!ref) {
        const [first, ...rest] = mutation.statements;
        const statements: motor.ChildStatement[] = [first,
          ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('L_CAS_FAILED') END", []],
          ...rest,
          ["INSERT INTO os_history (id,profile_id,order_id,kind,actor,note,created) VALUES (?,?,?,?,?,?,?)",
            [uid(), ctx.profile, parent.row.id, mutation.event, actor.id,
              JSON.stringify({ entity_kind: mutation.entity_kind, entity_id: mutation.id,
                entity_version: (mutation.expected_version ?? 0) + 1,
                mutation_key: mutation.mutation_key, changed_fields: mutation.changed_fields }), Date.now()]],
          ["UPDATE os_orders SET updated=?,stale_notified_at=NULL WHERE profile_id=? AND id=?",
            [Date.now(), ctx.profile, parent.row.id]],
        ];
        try { await batch(ctx.env, statements); }
        catch (error) {
          if (String(error).includes("malformed JSON"))
            throw new ApiError(409, "version_conflict", "Conflito de teste.");
          throw error;
        }
        ref = { id: mutation.id, order_id: parent.row.id, version: (mutation.expected_version ?? 0) + 1 };
        committed.set(mutation.mutation_key, ref);
      }
      if (failPublish) { failPublish = false; throw new Error("L_PUBLICATION_INTERRUPTED"); }
      if (!published.some((item) => item.id === ref!.id && item.version === ref!.version)) published.push(ref);
      return ref;
    });
    tail = run.catch(() => undefined);
    return run;
  });
  return { f, order, mutations, published, failPublication: () => { failPublish = true; } };
}

async function rows(profile: string, orderId: string) {
  return all(env, "SELECT * FROM os_entries WHERE profile_id=? AND order_id=? ORDER BY created,id", profile, orderId);
}

describe("lançamentos: contrato F0 e descritor", () => {
  it("mantém embutido desativado, módulo desligado e rotas sem efeito", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    const history = await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, order.id);
    for (const method of ["GET", "POST"]) {
      const response = await api(f.token, `/profiles/${f.profile}/service-orders/${order.id}/entries`, method, method === "POST" ? payload() : undefined);
      expect(response.status).toBe(409);
      expect((await response.json<any>()).error.code).toBe("feature_disabled");
    }
    expect(await rows(f.profile, order.id)).toEqual([]);
    expect(await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, order.id)).toEqual(history);
    const disabled = await motorFixture({ enabled: false });
    await expect(listEntries(disabled.ctx, disabled.member, uid())).rejects.toMatchObject({ code: "module_disabled" });
    expect(entriesExtension.id).toBe("entries");
    expect(entriesExtension).not.toHaveProperty("runDue");
    expect(entriesExtension.writes.map((r) => r.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("confirma lançamento, histórico e publicação com commitChild real e recupera repetição", async () => {
    const { f, order } = await setup({ commit: false });
    const key = uid();
    const created = await createEntry(f.ctx, f.member, { id: order.id, ...payload() }, key);
    expect(created).toMatchObject({ order_id: order.id, version: 1 });
    expect(await createEntry(f.ctx, f.member, { id: order.id, ...payload() }, key)).toEqual(created);
    expect(await rows(f.profile, order.id)).toHaveLength(1);
    expect(await all(env, "SELECT entity_id,entity_version FROM os_history WHERE profile_id=? AND order_id=? AND kind='os.entry.created'", f.profile, order.id))
      .toEqual([{ entity_id: created.id, entity_version: 1 }]);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.entry.created'", f.profile)).toHaveLength(1);
  });

  it("resolve somente tipos personalizados salvos ou fixados na ordem", async () => {
    const f = await motorFixture();
    await expect(motor.resolveWorkType(f.ctx, motorWorkType().id))
      .rejects.toMatchObject({ status: 404, code: "type_not_found" });
    await perform(env, f.admin, f.profile, "settings", {
      os_work_types: [motorWorkType()], settings_revision: await settingsRevision(env, f.profile),
    }, uid());
    expect(await motor.resolveWorkType(f.ctx, motorWorkType().id)).toEqual(motorWorkType());
  });
});

describe("lançamentos: quantidade, texto e instante", () => {
  it("preserva milésimos, zero, nulo e Unicode; não arredonda ou converte strings", () => {
    for (const quantity of [null, 0, 1, 1000, 1_000_000_000_000])
      expect(entryInput(payload({ quantity_milli: quantity })).quantity_milli).toBe(quantity);
    expect(entryInput(payload({ text: `  ${"😀".repeat(4000)}  ` })).text).toBe("😀".repeat(4000));
    for (const quantity of [-1, 0.1, "1000", NaN, Infinity, 1_000_000_000_001])
      expect(() => entryInput(payload({ quantity_milli: quantity }))).toThrow(ApiError);
    for (const occurred_at of [-1, 0.5, "2026-02-30", "2026-11-18", NaN, Infinity, 8_640_000_000_000_001])
      expect(() => entryInput(payload({ occurred_at }))).toThrow(ApiError);
    expect(entryInput(payload({ occurred_at: 0 })).occurred_at).toBe(0);
    expect(entryInput(payload({ occurred_at: 8_640_000_000_000_000 })).occurred_at).toBe(8_640_000_000_000_000);
    for (const invalid of [{ text: " " }, { kind: "" }, { kind: "x".repeat(65) },
      { text: "x".repeat(4001) }, { unit: "x".repeat(33) }, { unit: null },
      { text: "a\u0000b" }, { client_visible: 1 }, { sensitive: true }])
      expect(() => entryInput(payload(invalid))).toThrow(ApiError);
  });

  it("cria com campos completos; rejeita valor financeiro e propriedades desconhecidas", async () => {
    const { f, order, mutations } = await setup();
    const ref = await createEntry(f.ctx, f.member, { id: order.id, ...payload() }, uid());
    expect(ref).toEqual({ id: expect.any(String), order_id: order.id, version: 1 });
    expect((await rows(f.profile, order.id))[0]).toMatchObject({ quantity_milli: 1250, text: "Trabalho realizado", replaces_id: null });
    for (const extra of [{ value: 50 }, { value_cents: 5000 }, { profile: f.profile }, { replaces_id: ref.id }])
      await expect(createEntry(f.ctx, f.member, { id: order.id, ...payload(), ...extra }, uid()))
        .rejects.toMatchObject({ code: "invalid_entry" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].expected_version).toBeNull();
    expect(mutations[0].statements.every(([sql]) => !/payment|finance|erp|ledger/i.test(sql))).toBe(true);
  });
});

describe("lançamentos: correção, CAS, histórico e repetição", () => {
  it("preserva original e cadeia; arquiva com versão e histórico sem textos", async () => {
    const { f, order, mutations } = await setup();
    const first = await createEntry(f.ctx, f.member, { id: order.id, ...payload({ text: "Original" }) }, uid());
    const second = await reviseEntry(f.ctx, f.member, { id: order.id, entry_id: first.id, version: 1, ...payload({ text: "Correção", quantity_milli: 2500 }) }, uid());
    const third = await reviseEntry(f.ctx, f.member, { id: order.id, entry_id: second.id, version: 1, ...payload({ text: "Final", quantity_milli: 3000 }) }, uid());
    const saved = await rows(f.profile, order.id);
    expect(saved.find((r) => r.id === first.id)).toMatchObject({ text: "Original", quantity_milli: 1250, version: 2, archived_at: expect.any(Number) });
    expect(saved.find((r) => r.id === second.id)).toMatchObject({ text: "Correção", replaces_id: first.id, version: 2 });
    expect(saved.find((r) => r.id === third.id)).toMatchObject({ text: "Final", replaces_id: second.id, version: 1, archived_at: null });
    expect((await listEntries(f.ctx, f.member, order.id)).data.map((r) => r.id)).toEqual([third.id]);
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data).toEqual([
      { kind: "horas", unit: "h", count: 1, quantity_milli: "3000" },
    ]);
    expect((await listEntries(f.ctx, f.member, order.id, { include_archived: "1" })).data).toHaveLength(3);
    await expect(archiveEntry(f.ctx, f.member, { id: order.id, entry_id: third.id, version: 2 }, uid()))
      .rejects.toMatchObject({ code: "version_conflict" });
    const archived = await archiveEntry(f.ctx, f.member, { id: order.id, entry_id: third.id, version: 1 }, uid());
    expect(archived.version).toBe(2);
    expect((await listEntries(f.ctx, f.member, order.id)).data).toEqual([]);
    const history = await all(env, "SELECT kind,note FROM os_history WHERE profile_id=? AND order_id=? AND kind LIKE 'os.entry.%'", f.profile, order.id);
    expect(history).toHaveLength(4);
    expect(JSON.stringify(history)).not.toMatch(/Original|Correção|Final/);
    expect(mutations.filter((m) => m.event === "os.entry.revised").every((m) => m.statements.length === 2 && m.expected_version === null)).toBe(true);
  });

  it("recusa correção obsoleta e duas correções simultâneas sem bifurcar", async () => {
    const { f, order } = await setup();
    const first = await createEntry(f.ctx, f.member, { id: order.id, ...payload() }, uid());
    await expect(reviseEntry(f.ctx, f.member, { id: order.id, entry_id: first.id, version: 2, ...payload() }, uid()))
      .rejects.toMatchObject({ code: "version_conflict" });
    const results = await Promise.allSettled(["A", "B"].map((text) => reviseEntry(f.ctx, f.member,
      { id: order.id, entry_id: first.id, version: 1, ...payload({ text }) }, uid())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["version_conflict", "entry_replaced"]).toContain(failure.reason.code);
    expect(await rows(f.profile, order.id)).toHaveLength(2);
    await expect(reviseEntry(f.ctx, f.member, { id: order.id, entry_id: first.id, version: 2, ...payload() }, uid()))
      .rejects.toMatchObject({ code: "entry_replaced" });
  });

  it("reentra em commitChild para recuperar publicação depois de falha, sem duplicar", async () => {
    const { f, order, published, failPublication } = await setup();
    const key = uid();
    const body = { id: order.id, ...payload() };
    failPublication();
    await expect(createEntry(f.ctx, f.member, body, key)).rejects.toThrow("L_PUBLICATION_INTERRUPTED");
    const first = await createEntry(f.ctx, f.member, body, key);
    expect(await createEntry(f.ctx, f.member, body, key)).toEqual(first);
    const revisionKey = uid();
    const revision = { ...body, entry_id: first.id, version: 1, text: "Revisado" };
    failPublication();
    await expect(reviseEntry(f.ctx, f.member, revision, revisionKey)).rejects.toThrow("L_PUBLICATION_INTERRUPTED");
    const second = await reviseEntry(f.ctx, f.member, revision, revisionKey);
    const archiveKey = uid();
    const archive = { id: order.id, entry_id: second.id, version: 1 };
    failPublication();
    await expect(archiveEntry(f.ctx, f.member, archive, archiveKey)).rejects.toThrow("L_PUBLICATION_INTERRUPTED");
    expect(await archiveEntry(f.ctx, f.member, archive, archiveKey)).toMatchObject({ id: second.id, version: 2 });
    expect(await rows(f.profile, order.id)).toHaveLength(2);
    expect(published).toHaveLength(3);
    await expect(createEntry(f.ctx, f.member, { ...body, text: "Outro" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("reverte todo o lote quando o arquivamento da correção falha", async () => {
    const { f, order } = await setup();
    const first = await createEntry(f.ctx, f.member, { id: order.id, ...payload() }, uid());
    const commit = vi.mocked(motor.commitChild).getMockImplementation()!;
    vi.spyOn(motor, "commitChild").mockImplementation(async (ctx, actor, parent, mutation) => {
      const broken = structuredClone(mutation);
      broken.statements[1] = ["UPDATE os_entries SET text=NULL WHERE profile_id=? AND order_id=? AND id=?", [ctx.profile, parent.row.id, first.id]];
      return commit(ctx, actor, parent, broken);
    });
    await expect(reviseEntry(f.ctx, f.member, { id: order.id, entry_id: first.id, version: 1, ...payload() }, uid())).rejects.toThrow();
    expect(await rows(f.profile, order.id)).toEqual([expect.objectContaining({ id: first.id, version: 1, archived_at: null })]);
  });
});

describe("lançamentos: listas, somas e isolamento", () => {
  it("pagina por data e ID, valida cursor por área/pai/filtros e separa unidades", async () => {
    const { f, order } = await setup();
    for (const item of [payload(), payload({ quantity_milli: 0 }), payload({ unit: "min", quantity_milli: 500 }), payload({ kind: "diário", quantity_milli: null, unit: "" })])
      await createEntry(f.ctx, f.member, { id: order.id, ...item }, uid());
    const first = await listEntries(f.ctx, f.member, order.id, { limit: "2" });
    const second = await listEntries(f.ctx, f.member, order.id, { limit: "2", cursor: first.next_cursor! });
    expect(new Set([...first.data, ...second.data].map((r) => r.id)).size).toBe(4);
    expect(second.next_cursor).toBeNull();
    expect(first.data[0]).not.toHaveProperty("profile_id");
    const changedFilters: Record<string, string>[] = [{ kind: "horas" }, { include_archived: "1" }];
    for (const query of changedFilters)
      await expect(listEntries(f.ctx, f.member, order.id, { ...query, cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    const other = await motorOrder(f);
    await expect(listEntries(f.ctx, f.member, other.id, { cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    for (const cursor of ["", "!", btoa("{}"), "x".repeat(5000)])
      await expect(listEntries(f.ctx, f.member, order.id, { cursor })).rejects.toMatchObject({ code: "invalid_cursor" });
    const invalidFilters: Record<string, string>[] = [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { include_archived: "true" }, { phone: "5511960010203" }];
    for (const query of invalidFilters)
      await expect(listEntries(f.ctx, f.member, order.id, query)).rejects.toMatchObject({ code: "invalid_filter" });
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data).toEqual([
      { kind: "diário", unit: "", count: 1, quantity_milli: null },
      { kind: "horas", unit: "h", count: 2, quantity_milli: "1250" },
      { kind: "horas", unit: "min", count: 1, quantity_milli: "500" },
    ]);
    const foreign = await motorFixture();
    await expect(listEntries(foreign.ctx, foreign.member, order.id)).rejects.toMatchObject({ code: "not_found" });
    const foreignOrder = await motorOrder(foreign);
    await expect(listEntries(foreign.ctx, foreign.member, foreignOrder.id, { cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(archiveEntry(f.ctx, f.member, { id: other.id, entry_id: first.data[0].id, version: 1 }, uid())).rejects.toMatchObject({ code: "not_found" });
    await expect(reviseEntry(f.ctx, f.member, { id: other.id, entry_id: first.data[0].id, version: 1, ...payload() }, uid())).rejects.toMatchObject({ code: "not_found" });
  });

  it("limita a 10.000 incluindo arquivados e soma sem perder precisão", async () => {
    const { f, order } = await setup();
    await exec(env, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO os_entries (id,profile_id,order_id,kind,text,quantity_milli,occurred_at,created_by,created,updated)
      SELECT ? || i,?,?,'medição','Limite',1000000000000,0,?,0,0 FROM n`, uid(), f.profile, order.id, f.member.id);
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data[0].quantity_milli).toBe("10000000000000000");
    const page = await listEntries(f.ctx, f.member, order.id);
    expect(page.data).toHaveLength(50);
    expect(page.next_cursor).not.toBeNull();
    await expect(reviseEntry(f.ctx, f.member, { id: order.id, entry_id: page.data[0].id, version: 1, ...payload() }, uid()))
      .rejects.toMatchObject({ code: "collection_limit" });
    await exec(env, "UPDATE os_entries SET quantity_milli=999999999999 WHERE profile_id=? AND order_id=? AND id=?",
      f.profile, order.id, page.data[0].id);
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data[0].quantity_milli).toBe("9999999999999999");
    await exec(env, "UPDATE os_entries SET archived_at=1 WHERE profile_id=? AND order_id=?", f.profile, order.id);
    await expect(createEntry(f.ctx, f.member, { id: order.id, ...payload() }, uid())).rejects.toMatchObject({ code: "collection_limit" });
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data).toEqual([]);
    expect((await summarizeEntries(f.ctx, f.member, order.id, { include_archived: "1" })).data[0].count).toBe(10000);
  });

  it("filtra sigilo antes da página/soma e protege cliente e bot sem máscara", async () => {
    const { f, order, mutations, published } = await setup();
    const privileged: Actor = { ...f.member, access: ["*", "os:sensitive"] };
    const secret = await createEntry(f.ctx, privileged, { id: order.id, ...payload({ text: MOTOR_SENTINEL, sensitive: true, client_visible: false }) }, uid());
    await createEntry(f.ctx, f.member, { id: order.id, ...payload({ text: "Interno", client_visible: false }) }, uid());
    await createEntry(f.ctx, f.member, { id: order.id, ...payload({ text: "Público" }) }, uid());
    expect((await listEntries(f.ctx, f.member, order.id)).data).toHaveLength(2);
    expect((await listEntries(f.ctx, privileged, order.id)).data).toHaveLength(3);
    expect((await summarizeEntries(f.ctx, f.member, order.id)).data[0]).toMatchObject({ count: 2, quantity_milli: "2500" });
    const bot: Actor = { ...privileged, via: { kind: "bot", bot_id: "L", run_id: "L", masked: false } };
    const botPage = await listEntries(f.ctx, bot, order.id, { limit: "1" });
    expect(botPage.data.map((e) => e.text)).toEqual(["Público"]);
    expect(botPage.next_cursor).toBeNull();
    expect(botPage.data[0]).not.toHaveProperty("created_by");
    expect((await summarizeEntries(f.ctx, bot, order.id)).data[0].count).toBe(1);
    const c = await receive(f, f.line, "oi", "5511960010203");
    const customer = await listEntries(f.ctx, f.member, order.id, {}, c.id);
    expect(customer.data.map((e) => e.text)).toEqual(["Público"]);
    expect(customer.data[0]).not.toHaveProperty("created_by");
    const stranger = await receive(f, f.line, "oi", "5511960099999");
    await expect(listEntries(f.ctx, f.member, order.id, {}, stranger.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listEntries(f.ctx, f.member, order.id, { include_archived: "1" }, c.id)).rejects.toMatchObject({ code: "invalid_filter" });
    for (const actor of [f.admin, bot, { ...privileged, kind: "app" as const, scopes: ["conversations:read", "conversations:write"] }, { ...privileged, id: "bot:L" }]) {
      await expect(createEntry(f.ctx, actor, { id: order.id, ...payload({ sensitive: true, client_visible: false }) }, uid())).rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(archiveEntry(f.ctx, actor, { id: order.id, entry_id: secret.id, version: 1 }, uid())).rejects.toMatchObject({ code: "sensitive_forbidden" });
    }
    await expect(reviseEntry(f.ctx, privileged, { id: order.id, entry_id: secret.id, version: 1, ...payload() }, uid())).rejects.toMatchObject({ code: "invalid_entry" });
    const history = await all(env, "SELECT note FROM os_history WHERE profile_id=? AND order_id=?", f.profile, order.id);
    expect(JSON.stringify({ botPage, customer, history, published, metadata: mutations.map(({ statements, ...metadata }) => metadata) })).not.toContain(MOTOR_SENTINEL);
  });

  it("exige escopo e conversa autenticada de credenciais limitadas", async () => {
    const { f, order } = await setup();
    const app: Actor = { ...f.member, kind: "app", scopes: [] };
    await expect(listEntries(f.ctx, app, order.id)).rejects.toMatchObject({ code: "missing_scope" });
    await expect(createEntry(f.ctx, app, { id: order.id, ...payload() }, uid())).rejects.toMatchObject({ code: "missing_scope" });
    const bound: Actor = { ...app, scopes: ["conversations:read", "conversations:bound"] };
    await expect(listEntries(f.ctx, bound, order.id)).rejects.toMatchObject({ code: "not_found" });
    const credential: Actor = { ...f.member, credential: { id: "L", module: "os", subject: order.id } };
    await expect(listEntries(f.ctx, credential, order.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
