import { env as cloudEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ApiError, defaults, now, uid, type Actor, type Conversation, type Env } from "../src/types";
import type { CustomerRef, IdentityPort } from "../src/customer/contracts";
import { installIdentityPort, resolveCustomer } from "../src/customer/ports";
import { modulesApi, type ModuleContext } from "../src/modules/api";
import { agendaCustomerProvider, routineCustomer } from "../src/modules/agenda/customer-provider";
import { pedidoCustomerProvider, pedidoCreationContext } from "../src/modules/pedido/customer-provider";
import { reservaCustomerProvider } from "../src/modules/reserva/customer-provider";
import { book, upcomingFor as appointmentsFor, notifyCustomer as notifyAppointment } from "../src/modules/agenda/appointments";
import { defaultAgendaConfig } from "../src/modules/agenda/config";
import { createOrder as createPedido, openOrdersFor, conversationOf as pedidoRecipient } from "../src/modules/pedido/orders";
import { createFromApi } from "../src/modules/pedido/manage";
import { createBooking, upcomingFor as bookingsFor, notifyCustomer as notifyBooking } from "../src/modules/reserva/bookings";
import { addDays, brasiliaDate, reservaConfig } from "../src/modules/reserva/config";
import { createOrder as createWork, trackText, loadOrder, moveOrder, saveQuote, sendQuote, resumePendingNotices, updateOrder as updateWork } from "../src/modules/os/store";
import { workCustomerProvider } from "../src/modules/os/customer-provider";
import { workCustomerAllows } from "../src/modules/os/public";
import { resumeOrderEffects } from "../src/modules/os/motor-routes";
import { sendStageApproval } from "../src/modules/os/stages";
import type { CustomWorkType } from "../src/modules/os/contracts";
const motorWorkType = (): CustomWorkType => ({
  schema_version: 1, kind: "custom", id: "projeto", revision: 1, archived: false,
  labels: { singular: "Projeto", plural: "Projetos", item: "Objeto", problem: "Escopo", customer_singular: "Cliente", customer_plural: "Clientes" },
  number_prefix: "PROJ", terms: null, fields: [], retired_field_ids: [], retired_stage_ids: [], initial_stage: "entrada",
  stages: [{ id: "entrada", label: "Entrada", base_status: "received", message: "" },
    { id: "execucao", label: "Execução", base_status: "in_progress", message: "" },
    { id: "entregue", label: "Entregue", base_status: "delivered", message: "" },
    { id: "cancelado", label: "Cancelado", base_status: "cancelled", message: "" }],
  transitions: [{ id: "iniciar", from: "entrada", to: "execucao", label: "Iniciar", kind: "manual" },
    { id: "entregar", from: "execucao", to: "entregue", label: "Entregar", kind: "manual" },
    { id: "cancelar_execucao", from: "execucao", to: "cancelado", label: "Cancelar", kind: "manual" },
    { id: "cancelar", from: "entrada", to: "cancelado", label: "Cancelar", kind: "manual" }],
  features: { customer_open: true, tasks: true, people: true, documents: true, entries: true, quote: null,
    warranty_days: 0, pickup_reminder_days: 0, stale_days: 0 }, pickup_reminder_text: "",
});
import { createPlan, createSubscription } from "../src/modules/mensalidade/store";
import { openInstallments, statementText } from "../src/modules/mensalidade/chat";
import { conversationFor } from "../src/modules/mensalidade/billing";
import { mensalidadeCustomerProvider } from "../src/modules/mensalidade/customer-provider";
import { createPayer, updatePayer } from "../src/modules/mensalidade/payers";
import { activeTicketForConversation, issueTicket } from "../src/queue";

// Simulam apenas as portas de outras frentes; regras e SQL das rotinas são reais.
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/service", () => ({
  conversation: vi.fn(async (e: Env, id: string, profile: string) => one(e, "SELECT * FROM conversations WHERE id=? AND profile_id=?", id, profile)),
  settings: vi.fn(async () => defaults), conversationByPhone: vi.fn(), enqueue: vi.fn(),
  handoff: vi.fn(), handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settingsRevision: vi.fn(),
}));
const env = cloudEnv as unknown as Env;
const phone = "5511987654321";
const refs = new Map<string, CustomerRef>();
const identity: IdentityPort = {
  resolve: async (_env, c) => refs.get(c.id) ?? { profileId: c.profile_id,
    namespace: c.external_namespace.startsWith("app:") ? c.external_namespace as `app:${string}` : "team",
    state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null },
  prepareInbound: async () => ({ statements: [], state: "pending", verifiedPhone: null }),
  indexContact: async () => [], maintain: async () => ({ pending: false, statements: 0, items: 0 }),
};
beforeEach(() => { refs.clear(); installIdentityPort(identity); });
const tables = { agenda: "agenda_appointments", pedido: "pedido_orders", reserva: "reserva_bookings" };
const providers = { agenda: agendaCustomerProvider, pedido: pedidoCustomerProvider, reserva: reservaCustomerProvider };
type Routine = keyof typeof tables;
const budget = { remainingItems: 20, remainingStatements: 40 };

async function fixture() {
  const profile = uid(), service = uid(), professional = uid(), unit = uid();
  const actor: Actor = { id: uid(), kind: "user", role: "admin", aal: 2, name: "Equipe", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 1 };
  await batch(env, [
    ["INSERT INTO profiles(id,name,settings,created) VALUES(?,'Rotinas',?,1)", [profile, JSON.stringify(defaults)]],
    ...["agenda", "pedido", "reserva", "os", "mensalidade"].map(id => ["INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,1)", [profile, id]] as [string, unknown[]]),
    ["INSERT INTO agenda_services(id,profile_id,name,duration_minutes,created,updated) VALUES(?,?,'Serviço',30,1,1)", [service, profile]],
    ["INSERT INTO agenda_professionals(id,profile_id,name,created,updated) VALUES(?,?,'Profissional',1,1)", [professional, profile]],
    ["INSERT INTO reserva_units(id,profile_id,name,mode,price_cents,created,updated) VALUES(?,?,'Unidade','daily',10000,1,1)", [unit, profile]],
  ]);
  const contact = async (namespace = "team", value = phone, document: string | null = null) => {
    const id = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,document,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,?,'Pessoa',?,?,'','manual','test','test',1,1)", id, profile, namespace, value, document);
    return id;
  };
  const ctx = (module: string) => ({ ...modulesApi(env, profile, module),
    settings: async () => ({ ...defaults, os_work_types: [motorWorkType()],
      service_orders: { texts: { in_progress: "Ordem nº {numero} em execução." } } }),
    publish: vi.fn(async () => 1), sendMessage: vi.fn(async () => "sent"), sendInteractive: vi.fn(async () => "sent"),
    recordConsent: vi.fn(async () => ({})), mayNotify: vi.fn(async () => true), mayMessage: () => true,
    customer: (c: Conversation) => resolveCustomer(env, c),
    conversation: async (id: string) => {
      const c = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, id);
      if (!c) throw new ApiError(404, "not_found", "Conversa não encontrada.");
      return c;
    },
  }) as unknown as ModuleContext;
  const conversation = async (id: string | null, namespace = "team", value = phone) => {
    const cid = uid(), line = uid();
    const app = namespace.startsWith("app:");
    if (!app) await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Linha','qr','direct','active','{}',1)", line, profile);
    await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated)
      VALUES(?,?,?,?,?,?,?,'ready',?,1,1,1)`, cid, profile, app ? null : line, app ? namespace : `channel:${line}`, value, value, app ? null : value, uid());
    if (id) {
      await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'identity',1)", cid, profile, id);
      if (!app) await exec(env, "INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready') ON CONFLICT DO NOTHING", profile, value, id);
    }
    refs.set(cid, { profileId: profile, namespace: namespace as CustomerRef["namespace"], state: id ? "ready" : "pending", contactId: id,
      verifiedPhone: app ? null : value, version: id ? 1 : null, erp: null });
    return ctx("os").conversation(cid);
  };
  return { profile, actor, service, professional, unit, ctx, contact, conversation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function routine(f: Fixture, module: Routine, c: Conversation | null, day = 3) {
  const ctx = f.ctx(module);
  if (module === "agenda") return (await book(ctx, defaultAgendaConfig, { service_id: f.service, professional_id: f.professional,
    starts: Math.ceil(now() / 60000) * 60000 + day * 86400000, conversation: c, customer_phone: phone,
    source: "panel", actor: f.actor.id, force: true, notify: false })).appointment;
  if (module === "reserva") return (await createBooking(ctx, reservaConfig({}), { unit_id: f.unit,
    start_date: addDays(brasiliaDate(now()), day), nights: 1, conversation: c, customer_phone: phone,
    source: "panel", actor: f.actor.id, staff: true, deposit: false, notify: false })).booking;
  return (await createPedido(ctx, { sourceKey: uid(), conversation: c, phone, customer_name: "Pessoa", source: "panel", actor: f.actor.id,
    lines: [], item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000, fulfillment: "pickup", note: "", address: null })).order;
}
const mine = (f: Fixture, module: Routine, c: Conversation) => module === "agenda" ? appointmentsFor(f.ctx(module), c, now())
  : module === "reserva" ? bookingsFor(f.ctx(module), c, now()) : openOrdersFor(f.ctx(module), c);
const work = (f: Fixture, ctx: ModuleContext, c: Conversation | null = null, extra = {}) => createWork(ctx, {
  conversation: c, phone, item: "Equipamento", problem: "Revisão", source: "panel", sourceKey: uid(), actor: f.actor.id, notify: false, ...extra,
}).then(r => r.order);
async function subscription(f: Fixture, c: Conversation) {
  const ctx = f.ctx("mensalidade"), plan = await createPlan(ctx, { name: "Plano", amount_cents: 9900 }, f.actor.id);
  const sub = await createSubscription(ctx, { conversation: c, plan_id: plan.id }, f.actor.id);
  const installment = uid();
  await exec(env, `INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,created,updated)
    VALUES(?,?,?,'2099-01','2099-01-10',9900,1,1)`, installment, f.profile, sub.id);
  return { ctx, sub, installment };
}

describe.each(["agenda", "pedido", "reserva"] as const)("c-rotinas: %s", module => {
  it("S2/M1: troca A→B e estados restritos não recuperam registros de A nem por ações derivadas", async () => {
    const f = await fixture(), a = await f.contact(), b = await f.contact("team", "5511990000000"), c = await f.conversation(a);
    const row = await routine(f, module, c);
    const notify = async () => module === "agenda" ? notifyAppointment(f.ctx(module), row as any, "Privado", "key")
      : module === "reserva" ? notifyBooking(f.ctx(module), row as any, "Privado", "key") : pedidoRecipient(f.ctx(module), row);
    for (const state of ["pending", "ambiguous", "blocked", "excluded", "ready"] as const) {
      refs.set(c.id, { ...refs.get(c.id)!, state, contactId: state === "ready" ? b : null });
      expect(await mine(f, module, c)).toEqual([]);
      expect(await notify()).toBeNull();
    }
    await exec(env, `UPDATE ${tables[module]} SET contact_id=NULL WHERE id=?`, row.id);
    await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'conversations','session',?,?,?,'identity',1)", f.profile, `${c.id}:old`, a, c.id);
    expect(await mine(f, module, c)).toEqual([]);
    await exec(env, "DELETE FROM customer_records WHERE profile_id=?", f.profile);
    await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'conversations','session',?,?,?,'identity',?)", f.profile, `${c.id}:new`, b, c.id, now() + 1000);
    expect(await mine(f, module, c)).toEqual([]);
    await exec(env, "DELETE FROM customer_records WHERE profile_id=?", f.profile);
    await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,?,'record',?,?,?,'identity',1)", f.profile, module, row.id, a, c.id);
    expect(await mine(f, module, c)).toEqual([]);
  });

  it("M4: balcão e origem comprovada de outra linha são associados sem substituir proprietário", async () => {
    const f = await fixture(), id = await f.contact(), c = await f.conversation(id);
    const counter = await routine(f, module, null), original = await routine(f, module, c, 5);
    await exec(env, `UPDATE ${tables[module]} SET contact_id=NULL WHERE profile_id=?`, f.profile);
    await exec(env, "UPDATE conversations SET customer_link_state='pending' WHERE id=?", c.id);
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,created) VALUES(?,?,?,'inbound','customer','oi',?,1)", uid(), f.profile, c.id, uid());
    const otherLine = await f.conversation(id);
    const result = await providers[module].maintain!(env, f.profile, budget);
    expect(result.statements).toBeLessThanOrEqual(40);
    expect((await mine(f, module, otherLine)).map(r => r.id)).toEqual(expect.arrayContaining([counter.id, original.id]));
    expect((await all(env, `SELECT contact_id FROM ${tables[module]} WHERE profile_id=?`, f.profile)).every(r => r.contact_id === id)).toBe(true);
    const b = await f.contact("team", "5511990000000");
    await exec(env, "UPDATE customer_phones SET contact_id=?,version=2 WHERE profile_id=?", b, f.profile);
    await providers[module].maintain!(env, f.profile, budget);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, counter.id)).contact_id).toBe(id);
  });

  it("M4/E6: colisão e cadastro recente ficam pendentes; app não é credencial team", async () => {
    const f = await fixture(), id = await f.contact(), c = await f.conversation(id), counter = await routine(f, module, null);
    await exec(env, "INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) VALUES(?,'team',?,?,'local')", f.profile, phone, id);
    await providers[module].maintain!(env, f.profile, budget);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, counter.id)).contact_id).toBeNull();
    await exec(env, "DELETE FROM customer_phone_candidates WHERE profile_id=?", f.profile);
    await f.contact("team", "+55 (11) 98765-4321");
    await providers[module].maintain!(env, f.profile, budget);
    expect((await one(env, `SELECT contact_id FROM ${tables[module]} WHERE id=?`, counter.id)).contact_id).toBeNull();
    const appId = await f.contact("app:one"), app = await f.conversation(appId, "app:one");
    const appRow = await routine(f, module, app, 7);
    expect((await routineCustomer(f.ctx(module), app))?.phone).toBe(phone);
    expect((await mine(f, module, app)).map(r => r.id)).toEqual([appRow.id]);
    expect((await mine(f, module, c)).map(r => r.id)).not.toContain(appRow.id);
  });

  it("F4: papel do domínio permite coleção sem lista geral de Contatos", async () => {
    const f = await fixture(), id = await f.contact(), c = await f.conversation(id), row = await routine(f, module, c);
    const actor = { ...f.actor, role: "operator" as const, access: [module] };
    const ctx = f.ctx(module), collection = module === "agenda" ? "appointments" : module === "pedido" ? "orders" : "bookings";
    const page = await providers[module].list!(ctx, actor, id, collection, { limit: 10 });
    expect(page.items.map(r => r.id)).toEqual([row.id]);
    expect(JSON.stringify(page)).not.toContain("customer_phone");
  });
});

it("M6/M9: OS acompanhada recupera aviso uma vez, depois permite orçamento", async () => {
  const f = await fixture(), id = await f.contact(), c = await f.conversation(id), ctx = f.ctx("os");
  const row = await work(f, ctx);
  const moved = await moveOrder(ctx, row, "in_progress", f.actor.id);
  expect(moved.notification.state).toBe("pending");
  expect(ctx.sendMessage).not.toHaveBeenCalled();
  await trackText(ctx, c);
  const linked = await loadOrder(ctx, row.id);
  expect(linked.contact_id).toBe(id); expect(linked.conversation_id).toBe(c.id);
  expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
  await trackText(ctx, c); await resumePendingNotices(ctx, linked);
  expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
  const analyzing = await moveOrder(ctx, linked, "analyzing", f.actor.id, "", {}, "status", { notify: false });
  const quoted = await saveQuote(ctx, analyzing, { items: [{ description: "Reparo", quantity: 1, unit_cents: 1000 }] }, f.actor.id);
  await sendQuote(ctx, quoted, f.actor.id);
  expect(ctx.sendInteractive).toHaveBeenCalledTimes(1);
});

it("M9: falha conserva intenção e retoma com a mesma chave", async () => {
  const f = await fixture(), id = await f.contact(), c = await f.conversation(id), ctx = f.ctx("os"), row = await work(f, ctx, c);
  vi.mocked(ctx.sendMessage).mockRejectedValueOnce(new Error("Resposta perdida"));
  await expect(moveOrder(ctx, row, "in_progress", f.actor.id)).rejects.toThrow("Resposta perdida");
  const saved = await loadOrder(ctx, row.id);
  expect(saved.status).toBe("in_progress"); expect(saved.notification.state).toBe("failed");
  await resumePendingNotices(ctx, saved); await resumePendingNotices(ctx, saved);
  expect(ctx.sendMessage).toHaveBeenCalledTimes(2);
  expect(vi.mocked(ctx.sendMessage).mock.calls[0][2]?.key).toBe(vi.mocked(ctx.sendMessage).mock.calls[1][2]?.key);
});

it("M-AC1: orçamento e aprovação revalidam restrição e proprietário em cada repetição", async () => {
  const f = await fixture(), id = await f.contact(), c = await f.conversation(id), ctx = f.ctx("os");
  const custom = motorWorkType();
  custom.transitions[0] = { id: "iniciar", from: "entrada", to: "execucao", label: "Iniciar",
    kind: "customer_approval", request_text: "Autoriza iniciar?", valid_hours: 24 };
  ctx.settings = async () => ({ ...defaults, os_work_types: [custom] });
  const row = await work(f, ctx, c, { type_id: "projeto" });
  const type = JSON.parse(row.type_snapshot_json);
  const transition = type.type.transitions.find((t: any) => t.kind === "customer_approval");
  row.stage_approval_json = JSON.stringify({ state: "pending", transition_id: transition.id, version: 1, expires_at: now() + 60000 });
  await exec(env, "UPDATE os_orders SET stage_approval_json=? WHERE id=?", row.stage_approval_json, row.id);
  await sendStageApproval(ctx, row);
  expect(ctx.sendInteractive).toHaveBeenCalledTimes(1);
  vi.mocked(ctx.sendInteractive).mockClear();
  const history = { kind: "os.quote_saved", entity_version: row.row_version, changed_fields_json: '["quote_version"]' };
  for (const state of ["blocked", "excluded", "ambiguous"] as const) {
    refs.set(c.id, { ...refs.get(c.id)!, state, contactId: null });
    await resumeOrderEffects(ctx, history, row); await sendStageApproval(ctx, row);
  }
  const b = await f.contact("team", "5511990000000");
  refs.set(c.id, { ...refs.get(c.id)!, state: "ready", contactId: b });
  await resumeOrderEffects(ctx, history, row); await sendStageApproval(ctx, row);
  expect(ctx.sendInteractive).not.toHaveBeenCalled();
  expect(JSON.parse((await loadOrder(ctx, row.id)).stage_approval_json).state).toBe("pending");
});

it("M6/F4: manutenção da OS preenche destinatário vazio sem reapontar e coleção aceita papel específico", async () => {
  const f = await fixture(), id = await f.contact(), c = await f.conversation(id), ctx = f.ctx("os"), row = await work(f, ctx);
  await workCustomerProvider.maintain!(env, f.profile, budget);
  expect(await one(env, "SELECT contact_id,conversation_id FROM os_orders WHERE id=?", row.id)).toEqual({ contact_id: id, conversation_id: c.id });
  await f.conversation(id); await workCustomerProvider.maintain!(env, f.profile, budget);
  expect((await loadOrder(ctx, row.id)).conversation_id).toBe(c.id);
  expect((await workCustomerProvider.list!(ctx, { ...f.actor, role: "operator", access: ["os"] }, id, "works", { limit: 10 })).items).toHaveLength(1);
});

it("M6: manutenção revalida proprietário e versão na escrita sem ultrapassar o orçamento mínimo", async () => {
  const f = await fixture(), id = await f.contact(), c = await f.conversation(id), ctx = f.ctx("os"), row = await work(f, ctx);
  const other = await f.contact("team", "5511990000000");
  const original = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    await exec(env, "UPDATE os_orders SET contact_id=?,row_version=row_version+1 WHERE id=?", other, row.id);
    return original(statements);
  });
  try {
    const result = await workCustomerProvider.maintain!(env, f.profile, { remainingItems: 1, remainingStatements: 4 });
    expect(result.items).toBe(1); expect(result.statements).toBe(4);
  } finally { spy.mockRestore(); }
  const saved = await loadOrder(ctx, row.id);
  expect(saved.contact_id).toBe(other);
  expect(saved.conversation_id).toBeNull();
  expect(saved.row_version).toBe(row.row_version + 1);
  expect(await trackText(ctx, c)).not.toContain("Equipamento");
});

it("M11/E6: telefone humano usa DDI brasileiro, + conserva país; app guarda cadastro sem credencial", async () => {
  const f = await fixture(), ctx = f.ctx("os");
  expect((await work(f, ctx, null, { phone: "(11) 98765-4321" })).phone).toBe(phone);
  expect((await work(f, ctx, null, { phone: "+1 (202) 555-0123" })).phone).toBe("12025550123");
  const id = await f.contact("app:one"), c = await f.conversation(id, "app:one", "");
  const row = await work(f, ctx, c, { phone: undefined });
  expect(row.contact_id).toBe(id); expect(row.phone).toBe(phone);
  expect(await workCustomerAllows(ctx, c, row, true)).toBe(false);
  const billing = await subscription(f, c);
  expect(billing.sub.contact_id).toBe(id); expect(billing.sub.phone).toBe(phone);
});

it("E2/M7/F4: Mensalidade usa proprietário em outra variante/linha e recusa conversa reassociada", async () => {
  const f = await fixture(), id = await f.contact(), a = await f.conversation(id), b = await f.conversation(id, "team", "551187654321");
  const { ctx, sub, installment } = await subscription(f, a);
  expect((await openInstallments(ctx, b)).map(r => r.id)).toContain(installment);
  const other = await f.contact("team", "5511990000000");
  refs.set(a.id, { ...refs.get(a.id)!, contactId: other });
  expect(await openInstallments(ctx, a)).toEqual([]);
  expect((await statementText(ctx, a)).text).toBe("");
  expect((await conversationFor(ctx, sub))?.id).toBe(b.id);
  expect((await one(env, "SELECT contact_id,conversation_id FROM mensalidade_subscriptions WHERE id=?", sub.id))).toEqual({ contact_id: id, conversation_id: a.id });
  refs.set(b.id, { ...refs.get(b.id)!, state: "blocked", contactId: null });
  expect(await conversationFor(ctx, sub)).toBeNull();
  expect((await mensalidadeCustomerProvider.list!(ctx, { ...f.actor, role: "operator", access: ["mensalidade"] }, id, "subscriptions", { limit: 10 })).items).toHaveLength(1);
});

it("M10: duas linhas autorizadas compartilham uma senha sem mudar origem", async () => {
  const f = await fixture(), id = await f.contact(), a = await f.conversation(id), b = await f.conversation(id, "team", "551187654321"), queue = uid();
  await exec(env, "INSERT INTO queues(id,profile_id,name,created,updated) VALUES(?,?,'Fila',1,1)", queue, f.profile);
  const issue = (c: Conversation) => issueTicket(env, f.profile, { queueId: queue, preferential: false, source: "whatsapp", actorId: "customer", conversationId: c.id, sourceKey: uid() });
  const first = await issue(a), second = await issue(b);
  expect(second.created).toBe(false); expect(second.ticket.id).toBe(first.ticket.id);
  expect(second.ticket.conversation_id).toBe(a.id);
  expect((await activeTicketForConversation(env, f.profile, b.id))?.id).toBe(first.ticket.id);
  refs.set(a.id, { ...refs.get(a.id)!, contactId: await f.contact("team", "5511990000000") });
  expect(await activeTicketForConversation(env, f.profile, a.id)).toBeNull();
});

it("M12: completa documento compatível; correção exige revisão auditada e concorrência", async () => {
  const f = await fixture(), id = await f.contact(), ctx = f.ctx("mensalidade");
  let payer = await createPayer(ctx, { name: "Pessoa", contact_id: id }, f.actor.id, f.actor);
  payer = await updatePayer(ctx, payer, { document: "52998224725" }, f.actor.id, f.actor);
  expect(payer.document).toBe("52998224725");
  expect((await one(env, "SELECT document FROM contacts WHERE id=?", id)).document).toBeNull();
  await expect(updatePayer(ctx, payer, { document: "11222333000181" }, f.actor.id, f.actor)).rejects.toMatchObject({ code: "contact_conflict" });
  const review = { document: "11222333000181", contact_id: id, expectedUpdated: payer.updated, contact_review: { expectedVersion: 1, reason: "Documento conferido pela administração" } };
  const changed = await updatePayer(ctx, payer, review, f.actor.id, f.actor);
  expect(changed.document).toBe(review.document);
  expect(await one(env, "SELECT id FROM events WHERE resource_id=? AND json_extract(payload,'$.change')='document_reviewed'", payer.id)).not.toBeNull();
  await expect(updatePayer(ctx, payer, review, f.actor.id, f.actor)).rejects.toMatchObject({ code: "contact_conflict" });
  expect((await one(env, "SELECT document FROM contacts WHERE id=?", id)).document).toBeNull();
});

it("M8 já resolvido: abertura de Pedido encaminha opções, exige consentimento e não prova titularidade", async () => {
  const f = await fixture(), c = await f.conversation(null), base = f.ctx("pedido");
  await exec(env, "UPDATE conversations SET last_customer=0,verified_phone=NULL,customer_link_state='pending' WHERE id=?", c.id);
  const outbound = await base.conversation(c.id);
  refs.set(c.id, { ...refs.get(c.id)!, verifiedPhone: null });
  const lookup = vi.fn(async () => outbound);
  const ctx = pedidoCreationContext({ ...base, conversationByPhone: lookup }, f.actor, undefined);
  await ctx.conversationByPhone(phone, { open: true });
  expect(lookup).toHaveBeenLastCalledWith(phone, { open: true });
  const category = uid(), item = uid();
  await exec(env, "INSERT INTO pedido_categories(id,profile_id,name,created,updated) VALUES(?,?,'Categoria',1,1)", category, f.profile);
  await exec(env, "INSERT INTO pedido_items(id,profile_id,category_id,name,price_cents,created,updated) VALUES(?,?,?,'Item',1000,1,1)", item, f.profile, category);
  const input = { phone, customer_name: "Pessoa", items: [{ item_id: item, quantity: 1 }], whatsapp_notices: true, notices_evidence: "Aceite no balcão", payment_method: "cash" };
  await createFromApi(ctx, f.actor, input, uid());
  expect(base.recordConsent).toHaveBeenCalledWith(outbound, expect.objectContaining({ purpose: "order", source: "panel" }));
  expect((await one(env, "SELECT contact_id FROM pedido_orders WHERE profile_id=?", f.profile)).contact_id).toBeNull();
  expect((await resolveCustomer(env, outbound)).verifiedPhone).toBeNull();
  expect(base.sendMessage).toHaveBeenCalled();
  await expect(createFromApi(ctx, { ...f.actor, role: "operator" }, input, uid())).rejects.toMatchObject({ code: "admin_required" });
  const app = pedidoCreationContext(base, { ...f.actor, kind: "app", scopes: ["contacts:read"] }, undefined);
  expect(await app.conversationByPhone(phone, { open: true })).toBeNull();
});


it("M12: documento vazio incompatível com o contato continua em revisão", async () => {
  const f = await fixture(), id = await f.contact("team", phone, "52998224725"), ctx = f.ctx("mensalidade");
  const payer = await createPayer(ctx, { name: "Pessoa", contact_id: id }, f.actor.id, f.actor);
  await expect(updatePayer(ctx, payer, { document: "11222333000181" }, f.actor.id, f.actor)).rejects.toMatchObject({ code: "contact_conflict" });
  expect((await one(env, "SELECT document FROM mensalidade_payers WHERE id=?", payer.id)).document).toBeNull();
});


it("M4: editar telefone da OS sem proprietário não transfere o registro ao novo número", async () => {
  const f = await fixture(), ctx = f.ctx("os"), row = await work(f, ctx);
  const otherPhone = "5511990000000", id = await f.contact("team", otherPhone), c = await f.conversation(id, "team", otherPhone);
  await updateWork(ctx, row, { phone: otherPhone }, f.actor.id);
  await workCustomerProvider.maintain!(env, f.profile, budget);
  expect((await loadOrder(ctx, row.id)).contact_id).toBeNull();
  expect(await trackText(ctx, c)).not.toContain("Equipamento");
});

it("E2/M7: proprietário em customer_records prevalece sobre telefone editado da mensalidade", async () => {
  const f = await fixture(), id = await f.contact(), a = await f.conversation(id), { ctx, sub } = await subscription(f, a);
  const otherPhone = "5511990000000", b = await f.conversation(null, "team", otherPhone);
  await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'mensalidade','subscription',?,?,?,'identity',1)", f.profile, sub.id, id, a.id);
  await exec(env, "UPDATE mensalidade_subscriptions SET contact_id=NULL,conversation_id=NULL,phone=?,updated=updated+1 WHERE id=?", otherPhone, sub.id);
  ctx.conversationByPhone = vi.fn(async () => b);
  expect((await conversationFor(ctx, sub))?.id).toBe(a.id);
  refs.set(a.id, { ...refs.get(a.id)!, state: "blocked", contactId: null });
  expect(await conversationFor(ctx, sub)).toBeNull();
  expect(ctx.conversationByPhone).not.toHaveBeenCalled();
});


it("M9: conflito de versão não grava intenção de uma alteração recusada", async () => {
  const f = await fixture(), ctx = f.ctx("os"), row = await work(f, ctx);
  await moveOrder(ctx, row, "in_progress", f.actor.id, "", {}, "status", { notify: false });
  await expect(moveOrder(ctx, row, "ready", f.actor.id)).rejects.toMatchObject({ code: "os_conflict" });
  expect(await all(env, "SELECT task FROM customer_progress WHERE profile_id=? AND task LIKE 'os:notice:%'", f.profile)).toEqual([]);
});

it("M9: texto desabilitado conserva a mudança sem criar aviso pendente", async () => {
  const f = await fixture(), ctx = f.ctx("os"), row = await work(f, ctx);
  ctx.settings = async () => defaults;
  const moved = await moveOrder(ctx, row, "in_progress", f.actor.id);
  expect(moved.status).toBe("in_progress");
  expect(moved.notification).toBeUndefined();
  expect((await loadOrder(ctx, row.id)).notification).toBeUndefined();
  expect(await all(env, "SELECT task FROM customer_progress WHERE profile_id=? AND task LIKE 'os:notice:%'", f.profile)).toEqual([]);
  await resumePendingNotices(ctx, moved);
  expect(ctx.sendMessage).not.toHaveBeenCalled();
});
