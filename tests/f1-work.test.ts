import { env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, defaults, now, uid, type Actor, type Conversation, type Env } from "../src/types";
import type { ModuleContext } from "../src/modules/api";
import type { CustomerRef, IdentityPort, WritePort } from "../src/customer/contracts";
import { installIdentityPort, installWritePort, resolveCustomer, enrichCustomer } from "../src/customer/ports";
import { createOrder, handleQuoteReply, notify, ordersOfCustomer, trackText } from "../src/modules/os/store";
import { authorizedOrder, type WorkOrderRow } from "../src/modules/os/public";
import { documentOrder } from "../src/modules/os/documents/access";
import { sendDocument } from "../src/modules/os/documents/delivery";
import { handleStageReply } from "../src/modules/os/stage-replies";
import { runTaskDue } from "../src/modules/os/tasks/reminders";
import { workCustomerProvider, enrichConfirmedWorkCustomer } from "../src/modules/os/customer-provider";
import type { CustomWorkType } from "../src/modules/os/contracts";

const env = testEnv as unknown as Env;
const MOTOR_SENTINEL = "SIGILO_NAO_EXPORTAR_F1";
const motorWorkType = (): CustomWorkType => ({
  schema_version: 1, kind: "custom", id: "projeto", revision: 1, archived: false,
  labels: { singular: "Projeto", plural: "Projetos", item: "Objeto", problem: "Escopo", customer_singular: "Cliente", customer_plural: "Clientes" },
  number_prefix: "PROJ", terms: null,
  fields: [{ id: "segredo", label: "Restrito", help: "", required: false, client_visible: false, sensitive: true, kind: "text", multiline: true, max_length: 200 }],
  retired_field_ids: [], retired_stage_ids: [], initial_stage: "entrada",
  stages: [
    { id: "entrada", label: "Entrada", base_status: "received", message: "" },
    { id: "entregue", label: "Entregue", base_status: "delivered", message: "" },
    { id: "cancelado", label: "Cancelado", base_status: "cancelled", message: "" },
  ],
  transitions: [
    { id: "entregar", from: "entrada", to: "entregue", label: "Entregar", kind: "manual" },
    { id: "cancelar", from: "entrada", to: "cancelado", label: "Cancelar", kind: "manual" },
  ],
  features: { customer_open: true, tasks: true, people: true, documents: true, entries: true, quote: null, warranty_days: 0, pickup_reminder_days: 0, stale_days: 0 },
  pickup_reminder_text: "Lembrete do trabalho {identificador}",
});

// Dependências paralelas só pelas portas. Nenhuma implementação de identidade,
// cadastro ou ERP é carregada por estes testes.
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/service", () => ({
  conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(),
  handoff: vi.fn(), handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn(), settingsRevision: vi.fn(),
}));
const refs = new Map<string, CustomerRef>();
const identity: IdentityPort = {
  resolve: vi.fn<IdentityPort["resolve"]>(async (_env, c) => refs.get(c.id) ?? {
    profileId: c.profile_id, namespace: c.external_namespace.startsWith("app:") ? c.external_namespace as `app:${string}` : "team",
    state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null,
  }),
  prepareInbound: vi.fn<IdentityPort["prepareInbound"]>(async () => ({ statements: [], state: "pending", verifiedPhone: null })),
  indexContact: vi.fn(async () => []),
  maintain: vi.fn(async () => ({ pending: false, statements: 0, items: 0 })),
};
const writer: WritePort = {
  enrich: vi.fn<WritePort["enrich"]>(async (_env, _actor, _profile, contactId) => ({ contactId, version: 2, jobId: null, state: "done", pending: false })),
  maintain: vi.fn(async () => ({ pending: false, statements: 0, items: 0 })),
};
installIdentityPort(identity);
installWritePort(writer);
afterEach(() => { refs.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const phone = "5511987654321";

async function setup() {
  const profile = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)", profile, "Trabalhos", JSON.stringify(defaults), now());
  const actor: Actor = { id: uid(), kind: "user", name: "Equipe", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 1, runLimit: 1 };
  const settings = { ...defaults, os_work_types: [motorWorkType()] };
  const ctx = {
    env, profile, settings: async () => settings,
    access: (a: Actor) => { if (!a.profiles.includes(profile)) throw new ApiError(403, "forbidden", "Área não autorizada."); },
    requireEnabled: vi.fn(async () => {}),
    mayRead: () => true, mayMessage: () => true,
    publish: vi.fn(async () => {}), sendMessage: vi.fn(async () => "sent"),
    customer: (c: Conversation) => resolveCustomer(env, c),
    enrichCustomer: (a: Actor, c: Conversation, input: Parameters<ModuleContext["enrichCustomer"]>[2]) => enrichCustomer(env, a, c, input),
    conversation: async (id: string) => {
      const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, id);
      if (!c) throw new ApiError(404, "not_found", "Conversa não encontrada.");
      return c;
    },
  } as unknown as ModuleContext;
  async function contact(namespace = "team", value = phone) {
    const id = uid();
    await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
      VALUES(?,?,?,'Ana',?,'','manual','user','user',?,?)`, id, profile, namespace, value, now(), now());
    return id;
  }
  async function conversation(namespace = `channel:${uid()}`) {
    const id = uid();
    await exec(env, `INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, profile, namespace, uid(), phone, uid(), now(), now(), now());
    return ctx.conversation(id);
  }
  function ready(c: Conversation, contactId: string, extra: Partial<CustomerRef> = {}) {
    refs.set(c.id, { profileId: profile, namespace: c.external_namespace.startsWith("app:") ? c.external_namespace as `app:${string}` : "team",
      state: "ready", contactId, verifiedPhone: phone, version: 1, erp: null, ...extra });
  }
  async function open(c?: Conversation, custom = false, extra: Record<string, unknown> = {}) {
    return (await createOrder(ctx, { conversation: c, type_id: custom ? "projeto" : undefined,
      phone, item: "Equipamento", problem: "Revisão", source: "panel", sourceKey: uid(), actor: actor.id, notify: false, ...extra })).order as WorkOrderRow;
  }
  return { ctx, actor, profile, contact, conversation, ready, open };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function indexed(f: Fixture, id: string, version = 1, value = phone) {
  await exec(env, "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state,version) VALUES(?,'team',?,?,'ready',?)", f.profile, value, id, version);
}
const maintain = (f: Fixture, budget = { remainingStatements: 40, remainingItems: 20 }) => workCustomerProvider.maintain!(env, f.profile, budget);

describe("trabalhos e identidade canônica", () => {
  it("criação ambígua não inventa contato e repetição preserva o vínculo original", async () => {
    const f = await setup(), id = await f.contact(), other = await f.contact(), c = await f.conversation();
    f.ready(c, id, { state: "ambiguous", contactId: null });
    expect((await f.open(c)).contact_id).toBeNull();
    expect((await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).length).toBe(2);
    f.ready(c, id);
    const input = { conversation: c, item: "Equipamento", problem: "Revisão", source: "panel" as const, sourceKey: uid(), actor: f.actor.id, notify: false };
    const first = await createOrder(f.ctx, input);
    f.ready(c, other, { version: 2 });
    const repeated = await createOrder(f.ctx, input);
    expect(repeated.created).toBe(false);
    expect(repeated.order.id).toBe(first.order.id);
    expect(repeated.order.contact_id).toBe(id);
  });

  it("mensagem sem decisão não provoca leitura de identidade", async () => {
    const f = await setup(), c = await f.conversation();
    expect(await handleQuoteReply(f.ctx, c, { text: "Bom dia", rowId: uid() })).toBe(false);
    expect(identity.resolve).not.toHaveBeenCalled();
  });

  it("cria com o contato resolvido e acompanha em outro canal sem alterar o histórico", async () => {
    const f = await setup(), id = await f.contact(), a = await f.conversation(), b = await f.conversation();
    f.ready(a, id); f.ready(b, id, { verifiedPhone: "5511976543210" });
    const row = await f.open(a);
    expect(row.contact_id).toBe(id);
    expect((await ordersOfCustomer(f.ctx, b)).map(o => o.id)).toEqual([row.id]);
    expect(await trackText(f.ctx, b)).toContain("Equipamento");
    expect((await authorizedOrder(f.ctx, f.actor, row.id, { conversation_id: b.id })).row.id).toBe(row.id);
    expect(await one(env, "SELECT contact_id,conversation_id,phone,customer_name FROM os_orders WHERE id=?", row.id))
      .toEqual({ contact_id: id, conversation_id: a.id, phone, customer_name: "Ana" });
  });

  it.each(["pending", "ambiguous", "blocked", "excluded"] as const)("%s não libera busca por telefone", async state => {
    const f = await setup(), id = await f.contact(), a = await f.conversation(), b = await f.conversation();
    f.ready(a, id); const row = await f.open(a);
    f.ready(b, id, { state, contactId: null });
    expect(await ordersOfCustomer(f.ctx, b)).toEqual([]);
    await expect(authorizedOrder(f.ctx, f.actor, row.id, { conversation_id: b.id })).rejects.toMatchObject({ code: "not_found" });
    f.ready(a, id, { state, contactId: null });
    expect(await ordersOfCustomer(f.ctx, a)).toEqual([]);
  });

  it("legado pendente só aparece na conversa original; app com telefone igual fica isolado", async () => {
    const f = await setup(), a = await f.conversation(), b = await f.conversation("app:external");
    const row = await f.open(a), appId = await f.contact("app:external");
    f.ready(b, appId, { verifiedPhone: null });
    expect((await ordersOfCustomer(f.ctx, a)).map(o => o.id)).toEqual([row.id]);
    expect(await ordersOfCustomer(f.ctx, b)).toEqual([]);
    const appRow = await f.open(b);
    expect(appRow.contact_id).toBe(appId);
    expect((await ordersOfCustomer(f.ctx, a)).map(o => o.id)).toEqual([row.id]);
    const app = { ...f.actor, id: "external", kind: "app" as const };
    await expect(workCustomerProvider.list!(f.ctx, app, appId, "works", { limit: 25 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("troca manual não reaponta a ordem e bloqueia decisões antigas", async () => {
    const f = await setup(), old = await f.contact(), next = await f.contact(), c = await f.conversation();
    f.ready(c, old); const row = await f.open(c, true);
    await exec(env, "UPDATE os_orders SET stage_approval_json=? WHERE id=?", JSON.stringify({ state: "pending", version: 1, requested_at: now(), expires_at: now() + 60000 }), row.id);
    f.ready(c, next, { version: 2 });
    expect(await handleStageReply(f.ctx, c, { text: "", replyId: `os:stage:${row.id}:1:approve`, rowId: uid() })).toBe(true);
    expect(await handleQuoteReply(f.ctx, c, { text: "", replyId: `os:${row.id}:1:approve`, rowId: uid() })).toBe(true);
    const saved = await one(env, "SELECT contact_id,status,stage_approval_json FROM os_orders WHERE id=?", row.id);
    expect(saved.contact_id).toBe(old); expect(saved.status).toBe("received");
    expect(JSON.parse(saved.stage_approval_json).state).toBe("pending");
    expect(await ordersOfCustomer(f.ctx, c)).toEqual([]);
  });

  it("documento exige o mesmo contato, permite outro canal e preserva barreira privada", async () => {
    const f = await setup(), id = await f.contact(), other = await f.contact(), a = await f.conversation(), b = await f.conversation();
    f.ready(a, id); f.ready(b, id, { verifiedPhone: "5511976543210" });
    const row = await f.open(a, true);
    expect((await documentOrder(f.ctx, f.actor, row.id, { conversation_id: b.id })).row.id).toBe(row.id);
    const legacy = await f.open(undefined, true);
    await exec(env, "UPDATE os_orders SET conversation_id=? WHERE id=?", a.id, legacy.id);
    await expect(documentOrder(f.ctx, f.actor, legacy.id, { conversation_id: a.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(documentOrder(f.ctx, f.actor, row.id, { private: true })).rejects.toMatchObject({ code: "sensitive_forbidden" });
    f.ready(a, other, { version: 2 });
    await expect(documentOrder(f.ctx, f.actor, row.id, { conversation_id: a.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(sendDocument(f.ctx, f.actor, row.id, "document", { version: 1 }, a.id)).rejects.toMatchObject({ code: "not_found" });
    expect(f.ctx.sendMessage).not.toHaveBeenCalled();
  });

  it("não envia lembrete nem aviso após troca da identidade", async () => {
    const f = await setup(), id = await f.contact(), other = await f.contact(), c = await f.conversation();
    f.ready(c, id); const row = await f.open(c, true), at = now();
    await exec(env, `INSERT INTO os_tasks(id,profile_id,order_id,title,audience,due_at,remind_at,client_visible,sensitive,created_by,created,updated)
      VALUES(?,?,?,'Prazo','customer',?,?,1,0,?,?,?)`, uid(), f.profile, row.id, at + 1000, at - 1, f.actor.id, at, at);
    const run = async () => {
      const budget = { remaining: 100, consume(n: number) { this.remaining -= n; } };
      return runTaskDue(f.ctx, { now: at, limit: 10, budget }, ((e: Env) => ({ ...f.ctx, env: e })) as any);
    };
    f.ready(c, other, { version: 2 });
    expect((await run()).processed).toBe(0);
    await expect(notify(f.ctx, row, "pickup_reminder", "pickup")).rejects.toMatchObject({ code: "contact_conflict" });
    expect(f.ctx.sendMessage).not.toHaveBeenCalled();
    expect((await one(env, "SELECT notified_at FROM os_tasks WHERE order_id=?", row.id)).notified_at).toBeNull();
    f.ready(c, id);
    expect((await run()).processed).toBe(1);
    expect(f.ctx.sendMessage).toHaveBeenCalledTimes(1);
    expect((await run()).processed).toBe(0);
  });
});

describe("preenchimento e coleção de trabalhos", () => {
  it("legado da conversa exige índice original, marcador pronto e vínculo coincidente", async () => {
    const f = await setup(), id = await f.contact(), c = await f.conversation(), row = await f.open(c);
    await indexed(f, id);
    await maintain(f);
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBeNull();
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'automatic',?)", c.id, f.profile, id, now());
    await exec(env, "UPDATE conversations SET verified_phone=?,customer_link_state='ready' WHERE id=?", phone, c.id);
    await maintain(f);
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBe(id);
  });

  it("preenche em lotes atômicos, sem reescrever nome/telefone nem vínculos existentes", async () => {
    const f = await setup(), id = await f.contact(); await indexed(f, id);
    const rows = [];
    for (let i = 0; i < 21; i++) rows.push(await f.open(undefined, false, { customer_name: "Nome histórico", phone: "+55 (11) 98765-4321" }));
    await exec(env, "UPDATE os_orders SET phone=? WHERE profile_id=?", "+55 (11) 98765-4321", f.profile);
    const first = await maintain(f);
    expect(first.items).toBe(20); expect(first.statements).toBeLessThanOrEqual(40);
    expect((await all(env, "SELECT id FROM os_orders WHERE profile_id=? AND contact_id=?", f.profile, id)).length).toBe(20);
    await maintain(f); await maintain(f);
    expect((await all(env, "SELECT id FROM os_orders WHERE profile_id=? AND contact_id=?", f.profile, id)).length).toBe(21);
    const other = await f.contact();
    await exec(env, "UPDATE customer_phones SET contact_id=?,version=2 WHERE profile_id=?", other, f.profile);
    await maintain(f);
    expect(await one(env, "SELECT contact_id,customer_name,phone FROM os_orders WHERE id=?", rows[0].id))
      .toEqual({ contact_id: id, customer_name: "Nome histórico", phone: "+55 (11) 98765-4321" });
  });

  it("recusa ambiguidade legada normalizada, índice revisado e app", async () => {
    const f = await setup(), id = await f.contact(); await indexed(f, id);
    await f.contact("team", "+55 (11) 98765-4321");
    const row = await f.open();
    const app = await f.conversation("app:external"), appRow = await f.open(app);
    await maintain(f);
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBeNull();
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", appRow.id)).contact_id).toBeNull();
    await exec(env, "DELETE FROM contacts WHERE profile_id=? AND id<>?", f.profile, id);
    await exec(env, "UPDATE customer_phones SET version=2 WHERE profile_id=?", f.profile);
    await maintain(f);
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBeNull();
  });

  it("rollback do lote mantém checkpoint; queda após commit é repetível", async () => {
    const f = await setup(), id = await f.contact(); await indexed(f, id); const row = await f.open();
    const original = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, "batch");
    spy.mockImplementationOnce(async statements => original([
      ...statements, env.DB.prepare("INSERT INTO customer_assert(id,ok) VALUES('f1-work-rollback',0)"),
    ]));
    await expect(maintain(f)).rejects.toThrow();
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBeNull();
    expect(await one(env, "SELECT * FROM customer_progress WHERE profile_id=?", f.profile)).toBeNull();
    spy.mockImplementationOnce(async statements => { await original(statements); throw new Error("queda após commit"); });
    await expect(maintain(f)).rejects.toThrow("queda após commit");
    await maintain(f);
    expect((await one(env, "SELECT contact_id FROM os_orders WHERE id=?", row.id)).contact_id).toBe(id);
    expect((await maintain(f, { remainingStatements: 3, remainingItems: 20 })).statements).toBe(0);
  });

  it("projeta os tipos existentes e pagina sem conteúdo privado, com cursor autenticado", async () => {
    const f = await setup(), id = await f.contact(), c = await f.conversation(); f.ready(c, id);
    // A criação comum deve continuar recusando campos sensíveis.
    await expect(f.open(c, true, { extra: { segredo: MOTOR_SENTINEL } }))
      .rejects.toMatchObject({ code: "invalid_fields" });
    const builtin = await f.open(c), custom = await f.open(c, true, { notes: MOTOR_SENTINEL });
    // Fixture de conteúdo privado já persistido: a coleção deve omiti-lo sem
    // apagá-lo. Não usar a criação comum como atalho para a escrita privada.
    await exec(env, "UPDATE os_orders SET extra_json=? WHERE profile_id=? AND id=?",
      JSON.stringify({ segredo: MOTOR_SENTINEL }), f.profile, custom.id);
    const original = await one(env, "SELECT type_snapshot_json,extra_json,stage FROM os_orders WHERE id=?", custom.id);
    expect(JSON.parse(original.extra_json)).toEqual({ segredo: MOTOR_SENTINEL });
    await exec(env, "UPDATE os_orders SET created=? WHERE id IN (?,?)", now() - 100, builtin.id, custom.id);
    const list = (cursor?: string) => workCustomerProvider.list!(f.ctx, f.actor, id, "works", { limit: 1, cursor });
    const first = await list(), second = await list(first.nextCursor!);
    expect(new Set([...first.items, ...second.items].map(i => i.id))).toEqual(new Set([builtin.id, custom.id]));
    expect(new Set([...first.items, ...second.items].map(i => i.cells.typeId))).toEqual(new Set(["service_order", "projeto"]));
    expect(JSON.stringify([first, second])).not.toContain(MOTOR_SENTINEL);
    expect(JSON.stringify([first, second])).not.toContain("Equipamento");
    expect(second.nextCursor).toBeNull();
    await expect(list(first.nextCursor! + "tamper")).rejects.toMatchObject({ code: "invalid_cursor" });
    const other = await f.contact();
    await expect(workCustomerProvider.list!(f.ctx, f.actor, other, "works", { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(await one(env, "SELECT type_snapshot_json,extra_json,stage FROM os_orders WHERE id=?", custom.id)).toEqual(original);
    vi.mocked(f.ctx.requireEnabled).mockRejectedValueOnce(new ApiError(409, "module_disabled", "Desativado."));
    await expect(list()).rejects.toMatchObject({ code: "module_disabled" });
  });

  it("enriquece só confirmação administrativa explícita e nunca extras de tipos privados", async () => {
    const f = await setup(), id = await f.contact(), c = await f.conversation(); f.ready(c, id);
    const row = await f.open(c);
    expect(writer.enrich).not.toHaveBeenCalled();
    const data = { expectedVersion: 1, expectedErpVersion: null, mode: "fill_empty", patch: { name: "Ana Maria" } };
    await enrichConfirmedWorkCustomer(f.ctx, f.actor, row, data, "stable-command");
    expect(writer.enrich).toHaveBeenCalledWith(env, f.actor, f.profile, id, { ...data, commandId: "stable-command" });
    await expect(enrichConfirmedWorkCustomer(f.ctx, f.actor, row, { ...data, patch: { notes: MOTOR_SENTINEL } }, "bad"))
      .rejects.toMatchObject({ code: "invalid_customer_patch" });
    const custom = await f.open(c, true);
    await expect(enrichConfirmedWorkCustomer(f.ctx, f.actor, custom, data, "private"))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(writer.enrich).toHaveBeenCalledTimes(1);
  });
});
