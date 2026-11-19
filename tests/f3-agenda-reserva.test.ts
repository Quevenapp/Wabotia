import { persistProviderEvidence } from "./helpers/f3-payment-evidence";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import * as db from "../src/db";
import { ApiError, uid, type Actor, type Conversation } from "../src/types";
import { modulesApi, type ModuleContext } from "../src/modules/api";
import { book, confirm, getAppointment, move } from "../src/modules/agenda/appointments";
import { agendaConfig } from "../src/modules/agenda/config";
import { saveService } from "../src/modules/agenda/catalog";
import { createBooking, cancelBooking, changeBooking, confirmBooking, getBooking } from "../src/modules/reserva/bookings";
import { addDays, atClock, brasiliaDate, reservaConfig } from "../src/modules/reserva/config";
import { hourlyPeriod, ruleRefusal } from "../src/modules/reserva/availability";
import { saveUnit } from "../src/modules/reserva/units";
import { expireBooking, paymentUpdated } from "../src/modules/reserva/deposit";
import { paymentView } from "../src/payments";
import { agendaProducer, agendaTrigger, bookingReceipts, commercialRow, commercialSource, commercialState, installAgendaIntegration, manualBookingReceipt, receiptBalance, titlePlan } from "../src/modules/agenda/integration";
import { installReservaIntegration } from "../src/modules/reserva/integration";
import { reverseCommercialReceipt } from "../src/integrations/receipts";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import { acquireIntegrationLease, persistPreparedRequest, readPreparedRequest } from "../src/integrations/outbox";
import { prepareErpRequest } from "../src/integrations/erp-adapter";
import { validateEvent } from "../src/integrations/privacy";
import { due, f3Fixture, installFakeErp, setParts } from "./helpers/f3-fixtures";

beforeAll(() => { installAgendaIntegration(); installReservaIntegration(); });
afterEach(() => vi.restoreAllMocks());
const agendaRules = agendaConfig({});
const reservaRules = reservaConfig({ deposit_type: "percent", deposit_percent: 30 });
// O horário de execução não pode colocar a reserva fora das 08h–22h.
// Usa o calendário de Brasília, inclusive nas viradas de dia, mês e ano.
const future = (at = Date.now()) => atClock(addDays(brasiliaDate(at), 5), "10:00");

async function setup(enabled: boolean) {
  const f = await f3Fixture();
  await setParts(f.profile, { agenda: true, reserva: true, erp: enabled, "erp-financeiro": enabled, "erp-produtos": enabled, "erp-vendas": false, "erp-estoque": false }, Date.now() - 1000);
  const context = (module: "agenda" | "reserva"): ModuleContext => ({
    ...modulesApi(f.env, f.profile, module),
    publish: vi.fn(async () => undefined) as any,
    conversation: vi.fn(async () => { throw new ApiError(404, "not_found", "Conversa não encontrada."); }),
    customer: vi.fn(async () => ({ profileId: f.profile, namespace: "team", state: "ready", contactId: f.local, verifiedPhone: null, version: 1, erp: { id: f.customer, version: 1 } })) as any,
  });
  const agenda = context("agenda"), reserva = context("reserva");
  const conversation = { id: uid(), profile_id: f.profile, external_namespace: "channel:test", chat_type: "direct", title: "Cliente", phone: "" } as Conversation;
  const service = await saveService(agenda, f.actor, { name: "Serviço privado", duration_minutes: 30, price_cents: 1000 });
  const pro = uid();
  await exec(f.env, "INSERT INTO agenda_professionals(id,profile_id,name,created,updated) VALUES(?,?,'Equipe',?,?)", pro, f.profile, Date.now(), Date.now());
  const unit = await saveUnit(reserva, f.actor, { name: "Unidade privada", mode: "hourly", kind: "court", price_cents: 1000 });
  return { ...f, agenda, reserva, service, pro, unit, conversation };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function appointment(f: Fixture, price: number | null = 1000) {
  await saveService(f.agenda, f.actor, { id: f.service.id, price_cents: price });
  const result = await book(f.agenda, agendaRules, { id: uid(), service_id: f.service.id, professional_id: f.pro, starts: future(), source: "panel", actor: f.actor.id, conversation: f.conversation, force: true, notify: false, notes: "Prontuário privado que não pode sair" });
  return result.appointment;
}
async function booking(f: Fixture, deposit = true) {
  return (await createBooking(f.reserva, reservaRules, { id: uid(), unit_id: f.unit.id, starts: future(), duration_minutes: 60, source: "panel", actor: f.actor.id, conversation: f.conversation, deposit, staff: true, notify: false, notes: "Respostas privadas de menores" })).booking;
}
const events = async (f: Fixture, module?: string) => (await all(f.env,
  `SELECT payload_json FROM module_erp_events WHERE profile_id=?${module ? " AND module_id=?" : ""} ORDER BY module_id,source_id,source_revision,seq`, f.profile, ...(module ? [module] : []))).map(r => JSON.parse(r.payload_json));
async function providerPayment(f: Fixture, bookingId: string, amount = 300) {
  const id = uid(), at = Date.now();
  await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated)
    VALUES(?,?,?,?, 'mercadopago','pix','reserva',?,'Descrição privada',?,'paid',?,'module','system',?,?,?,?)`, id, f.profile, f.conversation.id, uid(), bookingId, amount, uid(), at + 60000, at, at, at);
  await persistProviderEvidence(f.env, id);
  return paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id))!;
}
async function refund(f: Fixture, payment: NonNullable<ReturnType<typeof paymentView>>) {
  await exec(f.env, "UPDATE payments SET status='refunded',updated=? WHERE id=?", Date.now(), payment.id);
  await persistProviderEvidence(f.env, payment.id);
  return paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", payment.id))!;
}

it("prepara horários válidos em Brasília em qualquer hora de execução", async () => {
  const f = await setup(false);
  for (const date of ["2026-11-19", "2026-12-31", "2028-02-29"]) {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 8, 59]) {
        const at = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:12-03:00`);
        const starts = future(at), period = hourlyPeriod(f.unit, starts, 60);
        expect(starts).toBe(atClock(addDays(date, 5), "10:00"));
        expect(period.ends).toBe(atClock(addDays(date, 5), "11:00"));
        expect(ruleRefusal(reservaRules, f.unit, period, at)).toBeNull();
        expect(ruleRefusal(reservaRules, f.unit, period, at, { staff: true })).toBeNull();
      }
    }
  }
});

for (const enabled of [false, true]) describe(`Agenda e Reserva: Financeiro ${enabled ? "ligado" : "desligado"}`, () => {
  it("agendar, confirmar e remarcar não criam dívida; preço nulo só cobra após definição humana", async () => {
    const f = await setup(enabled), a = await appointment(f, null);
    await confirm(f.agenda, { id: a.id, actor: f.actor.id });
    await move(f.agenda, agendaRules, { id: a.id, starts: a.starts + 3600000, professional_id: f.pro, actor: f.actor.id, force: true, notify: false });
    expect(await events(f)).toEqual([]);
    const completed = await agendaTrigger(f.agenda, f.actor, a.id, "complete", {}, "complete");
    expect(completed.commercial).toMatchObject({ recognized_at: null });
    expect(completed.commercial.completed_at).toBeGreaterThan(0);
    await expect(agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge-empty")).rejects.toMatchObject({ status: 422 });
    await agendaTrigger(f.agenda, f.actor, a.id, "charge", { price_cents: 700 }, "charge-price");
    expect((await events(f)).filter(e => e.operation === "recognize")).toHaveLength(enabled ? 1 : 0);
    expect((await getAppointment(f.agenda, a.id)).price_cents).toBe(700);
  });

  for (const first of ["charge", "complete"] as const) it(`${first} seguido do outro gatilho reconhece uma vez e repete resultado`, async () => {
    const f = await setup(enabled), a = await appointment(f);
    const result = await agendaTrigger(f.agenda, f.actor, a.id, first, {}, "first");
    expect(await agendaTrigger(f.agenda, f.actor, a.id, first, {}, "first")).toEqual(result);
    await agendaTrigger(f.agenda, f.actor, a.id, first === "charge" ? "complete" : "charge", {}, "second");
    await agendaTrigger(f.agenda, f.actor, a.id, "complete", {}, "third");
    expect((await events(f)).filter(e => e.operation === "recognize")).toHaveLength(enabled ? 1 : 0);
    await expect(agendaTrigger(f.agenda, f.actor, a.id, first, { price_cents: 2000 }, "first")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(agendaTrigger(f.agenda, f.actor, a.id, "charge", { price_cents: 2000 }, "new-body")).rejects.toMatchObject({ status: 409 });
  });

  for (const module of ["agenda", "reserva"] as const) it(`${module}: parcial, excesso, repetição e reversão autorizada locais`, async () => {
    const f = await setup(enabled), ctx = f[module], row = module === "agenda" ? await appointment(f) : await booking(f);
    if (module === "agenda") await agendaTrigger(ctx, f.actor, row.id, "charge", {}, "charge");
    const first = await manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 300, method: "cash" }, "receipt-1");
    expect(await manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 300, method: "cash" }, "receipt-1")).toEqual(first);
    await expect(manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 301, method: "cash" }, "receipt-1")).rejects.toMatchObject({ code: "idempotency_conflict" });
    const excess = await manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 800, method: "pix" }, "receipt-2");
    expect(excess).toMatchObject({ allocated_cents: 700, excess_cents: 100 });
    expect(await receiptBalance(ctx, commercialSource(ctx, module, row.id))).toEqual({ received_cents: 1100, allocated_cents: 1000, excess_cents: 100 });
    const reversed = await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: first.receipt_key, reason_code: "manual_void" }, "reverse");
    expect(await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: first.receipt_key, reason_code: "manual_void" }, "reverse")).toEqual(reversed);
    expect(await receiptBalance(ctx, commercialSource(ctx, module, row.id))).toEqual({ received_cents: 800, allocated_cents: 700, excess_cents: 100 });
    // Dinheiro a mais continua pendente; a anulação não o realoca silenciosamente.
    expect((await events(f, module)).filter(e => e.operation === "recognize")).toHaveLength(enabled ? 1 : 0);
    if (module === "reserva") expect((await getBooking(ctx, row.id)).status).toBe("pending_payment");
  });

  it("Reserva: sinal e saldo somam o total; confirmação e check-in não liquidam saldo", async () => {
    const f = await setup(enabled), b = await booking(f), source = commercialSource(f.reserva, "reserva", b.id);
    const snapshot = (await commercialState(f.reserva, source)).snapshot!;
    expect(snapshot.total_cents).toBe(1000);
    expect(snapshot.installments.map(i => [i.key, i.amount_cents])).toEqual([["deposit", 300], ["balance", 700]]);
    expect(snapshot.installments[0].due_on <= snapshot.installments[1].due_on).toBe(true);
    await confirmBooking(f.reserva, reservaRules, { id: b.id, actor: f.actor.id, notify: false });
    expect(await receiptBalance(f.reserva, source)).toMatchObject({ allocated_cents: 0 });
    const payment = await providerPayment(f, b.id);
    await paymentUpdated(f.reserva, reservaRules, payment, "created");
    await paymentUpdated(f.reserva, reservaRules, payment, "created");
    expect(await receiptBalance(f.reserva, source)).toMatchObject({ allocated_cents: 300 });
    expect((await bookingReceipts(f.reserva, f.actor, "reserva", b.id)).installments.map(i => [i.key, i.received_cents])).toEqual([["deposit", 300], ["balance", 0]]);
    await exec(f.env, "UPDATE reserva_bookings SET checkin_status='completed' WHERE id=?", b.id);
    expect(await receiptBalance(f.reserva, source)).toMatchObject({ allocated_cents: 300 });
    await manualBookingReceipt(f.reserva, f.actor, "reserva", b.id, { amount_cents: 700, method: "cash" }, "balance");
    expect(await receiptBalance(f.reserva, source)).toMatchObject({ allocated_cents: 1000 });
    expect((await bookingReceipts(f.reserva, f.actor, "reserva", b.id)).installments.map(i => [i.key, i.received_cents])).toEqual([["deposit", 300], ["balance", 700]]);
    expect((await events(f)).filter(e => e.operation === "recognize")).toHaveLength(enabled ? 1 : 0);
  });

  it("expiração/cancelamento cancelam saldo sem fabricar devolução", async () => {
    const f = await setup(enabled), b = await booking(f);
    await manualBookingReceipt(f.reserva, f.actor, "reserva", b.id, { amount_cents: 100, method: "cash" }, "partial");
    await expireBooking(f.reserva, reservaRules, b.id, { reason: "deadline" });
    await expireBooking(f.reserva, reservaRules, b.id, { reason: "deadline", repeat: true });
    expect((await getBooking(f.reserva, b.id)).status).toBe("expired");
    expect((await events(f)).filter(e => e.operation === "cancel")).toHaveLength(enabled ? 1 : 0);
    expect((await events(f)).filter(e => e.operation === "reverse")).toHaveLength(0);
    expect(await receiptBalance(f.reserva, commercialSource(f.reserva, "reserva", b.id))).toMatchObject({ received_cents: 100 });
    expect(await bookingReceipts(f.reserva, f.actor, "reserva", b.id)).toMatchObject({ outstanding_cents: 0, cancelled_cents: 900 });
  });

  it("sinal manual sustenta a reserva sem confundir confirmação com quitação", async () => {
    const f = await setup(enabled), b = await booking(f);
    await manualBookingReceipt(f.reserva, f.actor, "reserva", b.id, { amount_cents: 300, method: "cash" }, "signal");
    expect(await expireBooking(f.reserva, reservaRules, b.id, { reason: "deadline" })).toBeNull();
    expect((await getBooking(f.reserva, b.id)).status).toBe("pending_payment");
    await confirmBooking(f.reserva, reservaRules, { id: b.id, actor: f.actor.id, notify: false });
    expect(await bookingReceipts(f.reserva, f.actor, "reserva", b.id)).toMatchObject({ outstanding_cents: 700, received_cents: 300 });
    expect((await events(f)).filter(e => e.operation === "cancel")).toHaveLength(0);
  });

  for (const started of [false, true]) it(`estorno do sinal ${started ? "após" : "antes do"} início é atômico e não duplica`, async () => {
    const f = await setup(enabled), b = await booking(f), payment = await providerPayment(f, b.id);
    await paymentUpdated(f.reserva, reservaRules, payment, "created");
    if (started) await exec(f.env, "UPDATE reserva_bookings SET checkin_status='completed',arrival_at=? WHERE id=?", Date.now() - 1000, b.id);
    const reversed = await refund(f, payment);
    await paymentUpdated(f.reserva, reservaRules, reversed, "paid");
    await paymentUpdated(f.reserva, reservaRules, reversed, "paid");
    expect((await getBooking(f.reserva, b.id)).status).toBe(started ? "confirmed" : "cancelled");
    expect(await receiptBalance(f.reserva, commercialSource(f.reserva, "reserva", b.id))).toMatchObject({ received_cents: 0, allocated_cents: 0 });
    expect((await events(f)).filter(e => e.operation === "reverse")).toHaveLength(enabled ? 1 : 0);
    expect((await events(f)).filter(e => e.operation === "cancel")).toHaveLength(enabled && !started ? 1 : 0);
  });

  it("queda no lote e depois do commit local preserva recibos e sequência", async () => {
    const f = await setup(enabled), a = await appointment(f);
    const original = db.batch;
    let fail = true;
    vi.spyOn(db, "batch").mockImplementation(async (env, statements, options) => {
      if (fail && statements.some(([sql]) => sql.includes("UPDATE agenda_appointments SET price_cents"))) {
        fail = false;
        // Falha D1 no fim do lote precisa desfazer também a mutação nativa.
        return original(env, [...statements, ["SELECT json('f3_failure')", []]], options);
      }
      return original(env, statements, options);
    });
    await expect(agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge")).rejects.toThrow();
    expect((await getAppointment(f.agenda, a.id)).commercial?.recognized_at).toBeNull();
    expect(await events(f)).toHaveLength(0);
    const result = await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge");
    expect(await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge")).toEqual(result);
    // Publicação cai depois do lote do sinal: o gancho repete sem realocar.
    const b = await booking(f), payment = await providerPayment(f, b.id);
    vi.mocked(f.reserva.publish).mockRejectedValueOnce(new Error("queda após o lote"));
    await expect(paymentUpdated(f.reserva, reservaRules, payment, "created")).rejects.toThrow("queda após o lote");
    await paymentUpdated(f.reserva, reservaRules, payment, "created");
    expect(await receiptBalance(f.reserva, commercialSource(f.reserva, "reserva", b.id))).toMatchObject({ allocated_cents: 300 });
  });
});

describe("Cortes, transporte, autorização e privacidade", () => {
  it("obrigação local antiga não é reconhecida ao ligar; novo recebimento fica histórico sem vínculo", async () => {
    const f = await setup(false), b = await booking(f), a = await appointment(f);
    await agendaTrigger(f.agenda, f.actor, a.id, "complete", {}, "complete-off");
    await setParts(f.profile, { erp: true, "erp-financeiro": true }, Date.now() - 1);
    await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge-on");
    await manualBookingReceipt(f.reserva, f.actor, "reserva", b.id, { amount_cents: 100, method: "cash" }, "new-payment");
    expect((await events(f)).filter(e => e.operation === "recognize")).toHaveLength(0);
    const receive = (await events(f)).find(e => e.operation === "receive");
    await expect(prepareErpRequest(f.env, receive)).rejects.toMatchObject({ code: "historical_origin_unlinked" });
  });

  for (const module of ["agenda", "reserva"] as const) it(`${module}: perda de resposta ERP, dois consumidores e religamento não duplicam`, async () => {
    const f = await setup(true), remote = installFakeErp();
    const row = module === "agenda" ? await appointment(f) : await booking(f);
    if (module === "agenda") await agendaTrigger(f.agenda, f.actor, row.id, "charge", {}, "charge");
    const event = (await events(f, module))[0];
    remote.loseNextReply();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all([drainIntegrationOutbox(f.env, f.profile), drainIntegrationOutbox(f.env, f.profile)]);
    expect(remote.mutations).toHaveLength(1);
    const request = await readPreparedRequest(f.env, event);
    await setParts(f.profile, { "erp-financeiro": false });
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(await readPreparedRequest(f.env, event)).toEqual(request);
    await setParts(f.profile, { "erp-financeiro": true });
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(1);
    expect((await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", event.id)).state).toBe("done");
  });

  it("época encerrada fecha comando preparado; sequência seguinte não passa na frente", async () => {
    const f = await setup(true), remote = installFakeErp(), a = await appointment(f);
    await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge");
    await manualBookingReceipt(f.agenda, f.actor, "agenda", a.id, { amount_cents: 100, method: "cash" }, "paid");
    const [first, second] = await events(f);
    expect(await acquireIntegrationLease(f.env, second.id)).toBeNull();
    const token = (await acquireIntegrationLease(f.env, first.id))!;
    await persistPreparedRequest(f.env, first, await prepareErpRequest(f.env, first), token);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", first.id);
    await setParts(f.profile, { "erp-financeiro": false });
    await setParts(f.profile, { "erp-financeiro": true });
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toEqual([]);
    expect(remote.close).toHaveBeenCalled();
  });

  it("CAS comercial reverte mudança operacional quando dois planos usam a mesma revisão", async () => {
    const f = await setup(true), a = await appointment(f), row = await commercialRow(f.agenda, "agenda", a.id);
    const p1 = await titlePlan(f.agenda, "agenda", row, { recognize: true, actor: f.actor.id });
    const p2 = await titlePlan(f.agenda, "agenda", row, { recognize: true, actor: f.actor.id });
    await batch(f.env, p1.statements);
    await expect(batch(f.env, [["UPDATE agenda_appointments SET notes='não deve ficar' WHERE id=?", [a.id]], ...p2.statements])).rejects.toThrow();
    expect((await getAppointment(f.agenda, a.id)).notes).not.toBe("não deve ficar");
    expect(await events(f)).toHaveLength(1);
  });

  it("catálogo é opcional, não muda preço contratado e não é consultado com Produtos desligado", async () => {
    const f = await setup(true), product = uid();
    for (const [module, kind, id] of [["agenda", "service", f.service.id], ["reserva", "unit", f.unit.id]])
      await exec(f.env, "INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,?,?,?,'main',?,?,?)", f.profile, module, kind, id, product, Date.now(), f.actor.id);
    const a = await appointment(f); await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge");
    expect((await events(f))[0].snapshot.items[0]).toMatchObject({ product_id: product, unit_cents: 1000 });
    await saveService(f.agenda, f.actor, { id: f.service.id, price_cents: 9999 });
    expect((await getAppointment(f.agenda, a.id)).price_cents).toBe(1000);
    await setParts(f.profile, { "erp-produtos": false });
    const b = await booking(f);
    expect((await commercialState(f.reserva, commercialSource(f.reserva, "reserva", b.id))).snapshot!.items[0]).toMatchObject({ product_id: null, kind: "free", unit_cents: 1000 });
    await agendaProducer.authorizeSource(f.agenda, f.actor, { ...commercialSource(f.agenda, "agenda", f.service.id), component: "catalog:service:main" }, true);
  });

  it("outra área, bot e pessoa sem acesso ao módulo não recebem nem anulam", async () => {
    const f = await setup(true), a = await appointment(f);
    const another = { ...f.actor, role: "agent", profiles: [uid()] } as Actor;
    await expect(agendaProducer.authorizeSource(f.agenda, another, commercialSource(f.agenda, "agenda", a.id), true)).rejects.toMatchObject({ status: 404 });
    const bot = { ...f.actor, kind: "app", id: "bot:test" } as Actor;
    await expect(agendaTrigger(f.agenda, bot, a.id, "charge", { price_cents: 1 }, "bot")).rejects.toMatchObject({ status: 403 });
    const denied = { ...f.actor, role: "agent", access: ["reserva"] } as Actor;
    await expect(manualBookingReceipt(f.agenda, denied, "agenda", a.id, { amount_cents: 100, method: "cash" }, "denied")).rejects.toMatchObject({ status: 403 });
  });

  it("Saúde/Ensino: fila genérica, sem paciente/menor, notas, respostas ou descrição do provedor", async () => {
    const f = await setup(true);
    await setParts(f.profile, { saude: true, ensino: true });
    const a = await appointment(f), b = await booking(f);
    await agendaTrigger(f.agenda, f.actor, a.id, "charge", {}, "charge");
    await paymentUpdated(f.reserva, reservaRules, await providerPayment(f, b.id), "created");
    const output = await events(f);
    for (const event of output) {
      validateEvent(event);
      expect(event.snapshot).toMatchObject({ customer_ref: null, contact_id: null, privacy: "adult_payer_only", technical: null, description: "Serviço contratado" });
    }
    const serialized = JSON.stringify(output);
    for (const forbidden of [f.local, f.customer, "Prontuário", "Respostas privadas", "Serviço privado", "Unidade privada", "Descrição privada"])
      expect(serialized).not.toContain(forbidden);
    await expect(prepareErpRequest(f.env, output.find(e => e.operation === "recognize")) ).rejects.toMatchObject({ code: "customer_required" });
  });

  it("padrão ausente e cliente sem nome bloqueiam só ERP; contrato reconhecido não é sobrescrito", async () => {
    const f = await setup(true), b = await booking(f);
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',NULL) WHERE profile_id=?", f.profile);
    const [event] = await events(f);
    await expect(prepareErpRequest(f.env, event)).rejects.toMatchObject({ code: "category_required" });
    await exec(f.env, "UPDATE contacts SET name='' WHERE id=?", f.local);
    await expect(prepareErpRequest(f.env, event)).rejects.toMatchObject({ code: "customer_required" });
    expect((await getBooking(f.reserva, b.id)).status).toBe("pending_payment");
    await expect(changeBooking(f.reserva, reservaRules, { id: b.id, duration_minutes: 120, actor: f.actor.id, staff: true, notify: false })).rejects.toMatchObject({ code: "commercial_correction_required" });
    expect((await getBooking(f.reserva, b.id)).price_cents).toBe(1000);
    await cancelBooking(f.reserva, reservaRules, { id: b.id, actor: f.actor.id, notify: false });
    expect((await events(f)).map(e => e.operation)).toEqual(["recognize", "cancel"]);
  });

  it("evidência remota é deduplicada entre tentativas locais e valor divergente é recusado", async () => {
    const f = await setup(true), b = await booking(f), payment = await providerPayment(f, b.id);
    await paymentUpdated(f.reserva, reservaRules, payment, "created");
    const another = uid();
    await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated)
      SELECT ?,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated FROM payments WHERE id=?`, another, payment.id);
    await paymentUpdated(f.reserva, reservaRules, paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", another))!, "created");
    expect(await receiptBalance(f.reserva, commercialSource(f.reserva, "reserva", b.id))).toMatchObject({ received_cents: 300, allocated_cents: 300 });
    await expect(paymentUpdated(f.reserva, reservaRules, { ...payment, amount_cents: 301 }, "created")).rejects.toMatchObject({ status: 422 });
    expect((await events(f)).filter(e => e.operation === "receive")).toHaveLength(1);
  });
});
