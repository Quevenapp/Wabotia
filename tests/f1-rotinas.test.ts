import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ApiError, type Actor, type Conversation, type Env, uid } from "../src/types";
import type { CustomerRef, CustomerWrite, IdentityPort, WritePort } from "../src/customer/contracts";
import { enrichCustomer, installIdentityPort, installWritePort, resolveCustomer } from "../src/customer/ports";
import { modulesApi, type ModuleContext } from "../src/modules/api";
import { agendaCustomerProvider, withCustomerConfirmation } from "../src/modules/agenda/customer-provider";
import { pedidoCreationContext, pedidoCustomerProvider } from "../src/modules/pedido/customer-provider";
import { reservaCustomerProvider } from "../src/modules/reserva/customer-provider";
import { book, upcomingFor as appointmentsFor } from "../src/modules/agenda/appointments";
import { defaultAgendaConfig } from "../src/modules/agenda/config";
import { createOrder, openOrdersFor } from "../src/modules/pedido/orders";
import { createBooking, upcomingFor as bookingsFor } from "../src/modules/reserva/bookings";
import { addDays, brasiliaDate, reservaConfig } from "../src/modules/reserva/config";
import { completeCheckin } from "../src/modules/reserva/checkin";

// As outras frentes são portas simuladas. Não carregar implementações paralelas.
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/service", () => ({
  conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(),
  handoff: vi.fn(), handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn(),
}));

const env = testEnv as unknown as Env;
const phone = "5511987654321";
const refs = new Map<string, CustomerRef>();
const calls: CustomerWrite[] = [];
let loseWriteReply = false;
const identity: IdentityPort = {
  resolve: async (_env, c) => refs.get(c.id) ?? {
    profileId: c.profile_id, namespace: "team", state: "pending", contactId: null,
    verifiedPhone: null, version: null, erp: null,
  },
  prepareInbound: async () => ({ statements: [], state: "pending", verifiedPhone: null }),
  indexContact: async () => [],
  maintain: async () => ({ pending: false, statements: 0, items: 0 }),
};
// Simula o diário da frente de cadastro, inclusive resposta perdida depois de gravar.
const writer: WritePort = {
  async enrich(e, actor, profile, contactId, input) {
    calls.push(structuredClone(input));
    const hash = JSON.stringify([actor.id, contactId, input]);
    const old = await one(e, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", profile, input.commandId);
    if (old && old.request_hash !== hash) throw new ApiError(409, "idempotency_conflict", "Comando alterado.");
    let contact = await one(e, "SELECT * FROM contacts WHERE profile_id=? AND id=?", profile, contactId);
    if (!old) {
      expect(input.mode).toBe("fill_empty");
      const conflict = !!contact!.name && !!input.patch.name && contact!.name !== input.patch.name;
      await batch(e, [
        ["INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,state,command_id,request_hash,expected_version,expected_erp_version,retry_at,created,updated) VALUES(?,?,'team',?,'enrich',?,?,?,?,?,1,1,1)",
          [profile, uid(), contactId, conflict ? "conflict" : "done", input.commandId, hash, input.expectedVersion, input.expectedErpVersion]],
        ["UPDATE contacts SET name=?,version=version+1 WHERE profile_id=? AND id=? AND name='' AND version=?",
          [input.patch.name || "", profile, contactId, input.expectedVersion]],
      ]);
      contact = await one(e, "SELECT * FROM contacts WHERE profile_id=? AND id=?", profile, contactId);
    }
    if (loseWriteReply) { loseWriteReply = false; throw new Error("Resposta perdida após persistir a intenção"); }
    return { contactId, version: contact!.version, jobId: old?.id ?? null,
      state: old?.state ?? "done", pending: false };
  },
  maintain: async () => ({ pending: false, statements: 0, items: 0 }),
};
installIdentityPort(identity);
installWritePort(writer);
beforeEach(() => { refs.clear(); calls.length = 0; loseWriteReply = false; });

const modules = ["agenda", "pedido", "reserva"] as const;
type Routine = typeof modules[number];
const tables = { agenda: "agenda_appointments", pedido: "pedido_orders", reserva: "reserva_bookings" };
const collections = { agenda: "appointments", pedido: "orders", reserva: "bookings" };
const providers = { agenda: agendaCustomerProvider, pedido: pedidoCustomerProvider, reserva: reservaCustomerProvider };

async function fixture(name = "") {
  const profile = uid(), contact = uid(), service = uid(), professional = uid(), unit = uid();
  const actor: Actor = { id: uid(), kind: "user", role: "operator", name: "Equipe", profiles: [profile],
    scopes: [], bots: [], rate: 100, runLimit: 1, sessionId: uid() };
  await batch(env, [
    ["INSERT INTO profiles(id,name,created) VALUES(?,'Rotinas',1)", [profile]],
    ["INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team',?,?,'','automatic','test','test',1,1)", [contact, profile, name, phone]],
    ["INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')", [profile, phone, contact]],
    ...modules.map((id): [string, unknown[]] => ["INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,1,'test')", [profile, id]]),
    ["INSERT INTO agenda_services(id,profile_id,name,duration_minutes,created,updated) VALUES(?,?,'Serviço',30,1,1)", [service, profile]],
    ["INSERT INTO agenda_professionals(id,profile_id,name,created,updated) VALUES(?,?,'Profissional',1,1)", [professional, profile]],
    ["INSERT INTO reserva_units(id,profile_id,name,mode,price_cents,created,updated) VALUES(?,?,'Unidade','daily',10000,1,1)", [unit, profile]],
  ]);
  const publish = vi.fn(async () => 0);
  const ctx = (module: Routine) => {
    const base = modulesApi(env, profile, module);
    return {
      ...base, publish, settings: async () => ({}), sendMessage: vi.fn(), recordConsent: vi.fn(),
      customer: (c: Conversation) => resolveCustomer(env, c),
      enrichCustomer: (a: Actor, c: Conversation, input: CustomerWrite) => enrichCustomer(env, a, c, input),
      conversation: async (id: string) => {
        const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, id);
        if (!c) throw new ApiError(404, "not_found", "Conversa não encontrada.");
        return c;
      },
    } as ModuleContext;
  };
  const conversation = async (override: Partial<CustomerRef> = {}) => {
    const id = uid();
    await exec(env, "INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated,verified_phone,customer_link_state) VALUES(?,?,?,?,?,?,1,1,1,?,'ready')",
      id, profile, `channel:${id}`, phone, phone, uid(), phone);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',1)", id, profile, contact);
    refs.set(id, { profileId: profile, namespace: "team", state: "ready", contactId: contact,
      verifiedPhone: phone, version: 1, erp: null, ...override });
    return (await one<Conversation>(env, "SELECT * FROM conversations WHERE id=?", id))!;
  };
  return { profile, contact, service, professional, unit, actor, ctx, conversation, publish };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function create(f: Fixture, module: Routine, c: Conversation | null, options: {
  key?: string; day?: number; name?: string; confirmation?: unknown; delivery?: boolean;
} = {}) {
  const key = options.key || uid();
  const ctx = withCustomerConfirmation(f.ctx(module), f.actor, options.confirmation, options.name);
  if (module === "agenda") {
    const result = await book(ctx, defaultAgendaConfig, {
      id: key, service_id: f.service, professional_id: f.professional,
      starts: Math.ceil(Date.now() / 60000) * 60000 + (options.day || 3) * 86400000,
      conversation: c, customer_name: options.name, source: "panel", actor: f.actor.id, force: true, notify: false,
    });
    return { row: result.appointment, created: result.created };
  }
  if (module === "reserva") {
    const result = await createBooking(ctx, reservaConfig({}), {
      id: key, unit_id: f.unit, start_date: addDays(brasiliaDate(Date.now()), options.day || 3), nights: 1,
      conversation: c, customer_name: options.name, source: "panel", actor: f.actor.id, staff: true, deposit: false, notify: false,
    });
    return { row: result.booking, created: result.created };
  }
  const result = await createOrder(ctx, {
    sourceKey: key, conversation: c, customer_name: options.name || "", source: "panel", actor: f.actor.id,
    lines: [], item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000,
    fulfillment: options.delivery ? "delivery" : "pickup", note: "",
    address: options.delivery ? { street: "Rua de terceiro", district: "Centro", complement: "Casa de outra pessoa", reference: "" } : null,
  });
  return { row: result.order, created: result.created };
}

const mine = (f: Fixture, module: Routine, c: Conversation) => module === "agenda"
  ? appointmentsFor(f.ctx(module), c, Date.now()) : module === "reserva"
    ? bookingsFor(f.ctx(module), c, Date.now()) : openOrdersFor(f.ctx(module), c);

describe.each(modules)("f1-rotinas: %s", (module) => {
  it("cria com contactId central, conserva snapshots e atende a mesma pessoa em outro canal sem ERP", async () => {
    const f = await fixture("Nome cadastrado");
    const first = await f.conversation(), another = await f.conversation();
    const result = await create(f, module, first);
    expect(result.row.contact_id).toBe(f.contact);
    expect(result.row.customer_name).toBe("Nome cadastrado");
    expect((await mine(f, module, another)).map((r) => r.id)).toContain(result.row.id);
    await exec(env, "UPDATE contacts SET name='Nome posterior' WHERE id=?", f.contact);
    expect((await one(env, `SELECT customer_name FROM ${tables[module]} WHERE id=?`, result.row.id))!.customer_name).toBe("Nome cadastrado");
    expect(await one(env, "SELECT * FROM profile_modules WHERE profile_id=? AND module_id='erp'", f.profile)).toBeNull();
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,1)", f.profile);
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='erp'", f.profile);
    expect((await mine(f, module, another)).map((r) => r.id)).toContain(result.row.id);
    expect(calls).toHaveLength(0);
  });

  it.each(["pending", "ambiguous", "blocked", "excluded"] as const)("%s preserva a conversa original sem busca por telefone", async (state) => {
    const f = await fixture();
    const original = await f.conversation({ state, contactId: null });
    const another = await f.conversation({ state, contactId: null });
    const result = await create(f, module, original);
    expect(result.row.contact_id).toBeNull();
    expect((await mine(f, module, original)).map((r) => r.id)).toContain(result.row.id);
    expect(await mine(f, module, another)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile))).toHaveLength(1);
  });

  it("rejeita referência de outra área, namespace ou contato restrito", async () => {
    const f = await fixture(), other = await fixture();
    const c = await f.conversation({ profileId: other.profile, contactId: other.contact });
    await expect(create(f, module, c)).rejects.toMatchObject({ code: "not_found" });
    refs.set(c.id, { ...refs.get(c.id)!, profileId: f.profile, namespace: "app:intruso" });
    await expect(mine(f, module, c)).rejects.toMatchObject({ code: "not_found" });
    refs.set(c.id, { ...refs.get(c.id)!, namespace: "team", contactId: f.contact });
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.contact);
    await expect(create(f, module, c)).rejects.toMatchObject({ code: "not_found" });
    expect(await all(env, `SELECT id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).toEqual([]);
  });

  it("nome confirmado usa fill_empty; divergência vai à revisão sem trocar o contato", async () => {
    const f = await fixture("Nome anterior"), c = await f.conversation();
    const result = await create(f, module, c, { name: "Nome divergente" });
    expect(result.row.contact_id).toBe(f.contact);
    expect(result.row.customer_name).toBe("Nome divergente");
    expect((await one(env, "SELECT name FROM contacts WHERE id=?", f.contact))!.name).toBe("Nome anterior");
    expect(calls[0]).toMatchObject({ mode: "fill_empty", patch: { name: "Nome divergente" } });
    expect((await one(env, "SELECT state FROM customer_jobs WHERE profile_id=?", f.profile))!.state).toBe("conflict");
  });

  it("retoma a intenção depois da queda e não duplica ficha, operação nem comando", async () => {
    const f = await fixture(), c = await f.conversation(), key = uid();
    loseWriteReply = true;
    await expect(create(f, module, c, { key, name: "Nome confirmado" })).rejects.toThrow("Resposta perdida");
    refs.set(c.id, { ...refs.get(c.id)!, version: 2 });
    const retry = await create(f, module, c, { key, name: "Nome confirmado" });
    const replay = await create(f, module, c, { key, name: "Nome confirmado" });
    expect(retry.row.id).toBe(replay.row.id);
    expect(replay.created).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(await all(env, `SELECT id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM customer_jobs WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("repetição após gravar a rotina devolve o mesmo registro sem novo enriquecimento efetivo", async () => {
    const f = await fixture(), c = await f.conversation(), key = uid();
    f.publish.mockRejectedValueOnce(new Error("Queda após gravar a rotina"));
    await expect(create(f, module, c, { key, name: "Nome confirmado" })).rejects.toThrow("Queda após gravar");
    const retry = await create(f, module, c, { key, name: "Nome confirmado" });
    expect(retry.created).toBe(false);
    expect(await all(env, `SELECT id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).toHaveLength(1);
    expect((await one(env, "SELECT version FROM contacts WHERE id=?", f.contact))!.version).toBe(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("filtra antes de paginar, vincula o cursor ao contato e aplica autorização e módulo", async () => {
    const f = await fixture(), c = await f.conversation();
    const first = await create(f, module, c, { day: 3 });
    const second = await create(f, module, c, { day: 5 });
    const legacy = await create(f, module, null, { day: 7 });
    await exec(env, `UPDATE ${tables[module]} SET created=100 WHERE profile_id=?`, f.profile);
    const provider = providers[module];
    const list = (cursor?: string) => provider.list!(f.ctx(module), f.actor, f.contact, collections[module], { limit: 1, cursor });
    const page = await list();
    expect(page.items).toHaveLength(1);
    expect(page.incomplete).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    const next = await list(page.nextCursor!);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.items, ...next.items].map((r) => r.id))).toEqual(new Set([first.row.id, second.row.id]));
    expect([...page.items, ...next.items].some((r) => r.id === legacy.row.id)).toBe(false);
    await expect(list(page.nextCursor!.slice(0, -8) + "abcd")).rejects.toMatchObject({ code: "invalid_cursor" });
    const anotherContact = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Outro','','manual','test','test',1,1)", anotherContact, f.profile);
    await expect(provider.list!(f.ctx(module), f.actor, anotherContact, collections[module], { limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    const other = await fixture();
    await expect(provider.list!(f.ctx(module), f.actor, other.contact, collections[module], { limit: 1 })).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.list!(f.ctx(module), { ...f.actor, access: ["contacts"] }, f.contact, collections[module], { limit: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(provider.list!(f.ctx(module), { ...f.actor, kind: "app", scopes: ["contacts:read", "conversations:read"] }, f.contact, collections[module], { limit: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id=?", f.profile, module);
    await expect(list()).rejects.toMatchObject({ code: "module_disabled" });
    expect(await all(env, `SELECT id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).toHaveLength(3);
  });

  it("preenche legado em lote retomável e nunca reaponta vínculo existente", async () => {
    const f = await fixture(), c = await f.conversation();
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push((await create(f, module, c, { day: 3 + i * 2 })).row);
    await exec(env, `UPDATE ${tables[module]} SET contact_id=NULL WHERE profile_id=? AND id<>?`, f.profile, rows[2].id);
    const provider = providers[module];
    const budget = { remainingItems: 1, remainingStatements: 4 };
    expect(await provider.maintain!(env, f.profile, budget)).toMatchObject({ items: 1, statements: 4, pending: true });
    expect(await provider.maintain!(env, f.profile, budget)).toMatchObject({ items: 1, statements: 4 });
    expect((await all(env, `SELECT contact_id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).map((r) => r.contact_id)).toEqual([f.contact, f.contact, f.contact]);
    await exec(env, "UPDATE conversations SET customer_link_state='ambiguous' WHERE id=?", c.id);
    await provider.maintain!(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, rows[2].id))!.contact_id).toBe(f.contact);
    expect(await provider.maintain!(env, f.profile, { remainingItems: 0, remainingStatements: 40 })).toEqual({ items: 0, statements: 0, pending: true });
  });

  it("legado ambíguo fica pendente e é retomado quando a identidade é resolvida", async () => {
    const f = await fixture(), c = await f.conversation();
    const result = await create(f, module, c);
    await exec(env, `UPDATE ${tables[module]} SET contact_id=NULL WHERE id=?`, result.row.id);
    await exec(env, "UPDATE conversations SET customer_link_state='ambiguous' WHERE id=?", c.id);
    const provider = providers[module];
    const budget = { remainingItems: 20, remainingStatements: 40 };
    expect((await provider.maintain!(env, f.profile, budget)).pending).toBe(true);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, result.row.id))!.contact_id).toBeNull();
    await exec(env, "UPDATE conversations SET customer_link_state='ready' WHERE id=?", c.id);
    await provider.maintain!(env, f.profile, budget);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, result.row.id))!.contact_id).toBe(f.contact);
    const anotherContact = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Outro','','manual','test','test',1,1)", anotherContact, f.profile);
    await exec(env, "UPDATE conversation_contacts SET contact_id=? WHERE conversation_id=?", anotherContact, c.id);
    await exec(env, "UPDATE customer_phones SET contact_id=? WHERE profile_id=?", anotherContact, f.profile);
    await provider.maintain!(env, f.profile, budget);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, result.row.id))!.contact_id).toBe(f.contact);
  });
});

it("queda no lote do legado não avança o checkpoint nem deixa vínculo parcial", async () => {
  const f = await fixture(), c = await f.conversation();
  const result = await create(f, "agenda", c);
  await exec(env, "UPDATE agenda_appointments SET contact_id=NULL WHERE id=?", result.row.id);
  const broken = {
    ...env,
    DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => env.DB.batch([
        ...statements, env.DB.prepare("INSERT INTO customer_assert(id,ok) VALUES('fail-backfill-test',0)"),
      ]),
    },
  } as unknown as Env;
  const budget = { remainingItems: 20, remainingStatements: 40 };
  await expect(agendaCustomerProvider.maintain!(broken, f.profile, budget)).rejects.toThrow();
  expect((await one(env, "SELECT contact_id FROM agenda_appointments WHERE id=?", result.row.id))!.contact_id).toBeNull();
  expect(await one(env, "SELECT * FROM customer_progress WHERE profile_id=?", f.profile)).toBeNull();
  await agendaCustomerProvider.maintain!(env, f.profile, budget);
  expect((await one(env, "SELECT contact_id FROM agenda_appointments WHERE id=?", result.row.id))!.contact_id).toBe(f.contact);
});

it("endereço de terceiro fica no Pedido e respostas de check-in ficam na Reserva", async () => {
  const f = await fixture(), c = await f.conversation();
  const order = await create(f, "pedido", c, { name: "Ana", delivery: true });
  expect(JSON.parse(order.row.address).street).toBe("Rua de terceiro");
  expect(calls[0].patch).toEqual({ name: "Ana" });
  const booking = await create(f, "reserva", c);
  const ctx = f.ctx("reserva");
  await completeCheckin(ctx, booking.row.id, "checkin-step", { documento: ["privado"], acompanhantes: ["não exportar"] });
  const page = await reservaCustomerProvider.list!(ctx, f.actor, f.contact, "bookings", { limit: 25 });
  expect(page.items[0].cells.checkinStatus).toBe("completed");
  expect(JSON.stringify(page)).not.toContain("privado");
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain("não exportar");
  expect((await one(env, "SELECT checkin_answers FROM reserva_bookings WHERE id=?", booking.row.id))!.checkin_answers).toContain("privado");
  expect(calls).toHaveLength(1);
  expect(() => withCustomerConfirmation(ctx, f.actor, {
    expectedVersion: 1, expectedErpVersion: null, patch: { address: { street: "Rua de terceiro" } },
  })).toThrow();
});

it("busca do balcão preserva a abertura compatível e não entrega essa credencial a aplicações", async () => {
  const f = await fixture(), c = await f.conversation();
  const lookup = vi.fn(async () => c);
  const original = { ...f.ctx("pedido"), conversationByPhone: lookup };
  const ctx = pedidoCreationContext(original, f.actor, undefined);
  expect((await ctx.conversationByPhone(phone))?.id).toBe(c.id);
  expect((await ctx.conversationByPhone("551187654321", { open: true }))?.id).toBe(c.id);
  expect(lookup).toHaveBeenLastCalledWith("551187654321", { open: true });
  expect(await ctx.conversationByPhone("telefone " + phone)).toBeNull();
  const app = pedidoCreationContext(original, { ...f.actor, kind: "app", scopes: ["contacts:read"] }, undefined);
  expect(await app.conversationByPhone(phone)).toBeNull();
  expect(lookup).toHaveBeenCalledTimes(2);
});
