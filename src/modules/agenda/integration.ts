import { all, batch, one } from "../../db";
import { canProfile } from "../../security";
import { requireAccess } from "../../access";
import { requireFinancialAal } from "../../mfa";
import { ApiError, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { erpRoleOf } from "../erp/identity";
import { resolveCustomer } from "../../customer/ports";
import type { CommercialSnapshot, IntegrationEvent, IntegrationOperation, SourceRef, Statement } from "../../integrations/contracts";
import type { IntegrationProducer } from "../../integrations/ports";
import { readIntegrationActivation, ensureCommercialPolicy, integrationStatements, aliasStatements, registerIntegrationProducer, registerReceiptReverser } from "../../integrations/ports";
import { integrationCasGuard } from "../../integrations/outbox";
import { requireIntegrationHuman } from "../../integrations/policy";
import { canonical, commandId, eventKey, hash, uuid5, F3_NAMESPACES } from "../../integrations/keys";
import { IntegrationError, integer, opaque } from "../../integrations/privacy";
import { commercialReceiptStatements, allocationStatements, allocationKey, manualReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../../integrations/receipts";
import { brasiliaDate } from "./config";

// Utilitários estreitos compartilhados somente pelos dois produtores B6.
export type BookingModule = "agenda" | "reserva";
const tables = { agenda: "agenda_appointments", reserva: "reserva_bookings" } as const;
export const commercialSource = (ctx: ModuleContext, module: BookingModule, id: string): SourceRef => ({ profile: ctx.profile, module, source_id: id, component: "main" });
export async function commercialRow(ctx: ModuleContext, module: BookingModule, id: string) {
  const row = await one(ctx.env, `SELECT * FROM ${tables[module]} WHERE profile_id=? AND id=?`, ctx.profile, opaque(id));
  if (!row) throw new IntegrationError("not_found", 404);
  return row;
}
export async function commercialState(ctx: ModuleContext, source: SourceRef) {
  const row = await one(ctx.env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", source.profile, source.module, source.source_id);
  return { revision: row?.revision ?? 0, seq: row?.enqueued_seq ?? 0, snapshot: (row ? JSON.parse(row.state_json).snapshot : null) as CommercialSnapshot | null };
}
export async function authorizeBooking(ctx: ModuleContext, actor: Actor, source: SourceRef, write: boolean, module: BookingModule) {
  if (source.profile !== ctx.profile || source.module !== module || !canProfile(actor, ctx.profile)) throw new IntegrationError("not_found", 404);
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  requireAccess(actor, module);
  if (source.component.startsWith("catalog:")) {
    const kind = module === "agenda" ? "service" : "unit";
    if (source.component !== `catalog:${kind}:main` || write && actor.role !== "admin") throw new IntegrationError("forbidden", 403);
    const table = module === "agenda" ? "agenda_services" : "reserva_units";
    if (!await one(ctx.env, `SELECT id FROM ${table} WHERE profile_id=? AND id=? AND archived=0`, ctx.profile, source.source_id)) throw new IntegrationError("not_found", 404);
  } else {
    if (source.component !== "main") throw new IntegrationError("not_found", 404);
    await commercialRow(ctx, module, source.source_id);
  }
}
export async function requireBookingHuman(ctx: ModuleContext, actor: Actor, module: BookingModule, id: string) {
  requireIntegrationHuman(actor, ctx.profile);
  await authorizeBooking(ctx, actor, commercialSource(ctx, module, id), true, module);
}
export async function commercialAtomic(ctx: ModuleContext, statements: Statement[]) {
  try { return await batch(ctx.env, statements); }
  catch (error) {
    // Nenhum SQL/valor operacional em erro público ou log.
    if (/malformed JSON|integration_.*conflict|UNIQUE constraint/i.test(String(error))) throw new IntegrationError("version_conflict", 409);
    throw new IntegrationError("integration_unavailable", 503);
  }
}
/** Guarda os campos lidos, além do CAS comercial: timestamp sozinho não é versão. */
export function bookingGuard(ctx: ModuleContext, module: BookingModule, row: any): Statement {
  const fields = module === "agenda"
    ? ["status", "starts", "ends", "professional_id", "moves", "price_cents", "contact_id", "commercial_json"]
    : ["status", "starts", "ends", "unit_id", "changes", "price_cents", "deposit_cents", "contact_id", "payment_id", "payment_status", "checkin_status"];
  return [`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${tables[module]} WHERE profile_id=? AND id=? AND ${fields.map(k => `${k} IS ?`).join(" AND ")}) THEN 1 ELSE json('integration_version_conflict') END`, [ctx.profile, row.id, ...fields.map(k => row[k] ?? null)]];
}
export interface AgendaCommercial {
  schema: 1; completed_at: number | null; charged_at: number | null; recognized_at: number | null;
}
export function agendaCommercial(row: any): AgendaCommercial {
  const data = JSON.parse(row.commercial_json || "{}");
  return { schema: 1, completed_at: data.completed_at ?? null, charged_at: data.charged_at ?? null, recognized_at: data.recognized_at ?? null };
}

/** Nunca resolve por telefone. Em áreas sensíveis só exporta pagador adulto confirmado. */
async function payer(ctx: ModuleContext, row: any, sensitive: boolean) {
  let local: string | null = row.contact_id ?? null;
  if (row.conversation_id) {
    const conversation = await one(ctx.env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", ctx.profile, row.conversation_id);
    if (conversation) {
      const ref = await resolveCustomer(ctx.env, conversation);
      local = ref.profileId === ctx.profile && ref.namespace === "team" && ref.state === "ready" && (!local || local === ref.contactId) ? ref.contactId : null;
    }
  }
  if (!local) return { customer_ref: null, contact_id: null };
  // Cadastro único: sem nome não substitui a pessoa identificada por Consumidor.
  const contact = await one(ctx.env, "SELECT id,erp_contact_id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'", ctx.profile, local);
  if (!contact) return { customer_ref: null, contact_id: null };
  const restricted = await one(ctx.env, `SELECT 1 WHERE EXISTS(SELECT 1 FROM saude_contact_links WHERE profile_id=? AND contact_id=? AND relation='self')
    OR EXISTS(SELECT 1 FROM cond_people p JOIN cond_memberships m ON m.profile_id=p.profile_id AND m.person_id=p.id WHERE p.profile_id=? AND p.contact_id=? AND m.role='dependente')`, ctx.profile, local, ctx.profile, local);
  if (restricted) return { customer_ref: null, contact_id: null };
  if (sensitive) {
    const adult = await one(ctx.env, `SELECT 1 WHERE EXISTS(SELECT 1 FROM ensino_guardians WHERE profile_id=? AND contact_id=? AND revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM saude_contact_links WHERE profile_id=? AND contact_id=? AND relation IN ('responsible','tutor'))`, ctx.profile, local, ctx.profile, local);
    if (!adult) return { customer_ref: null, contact_id: null };
  }
  return { customer_ref: contact.id as string, contact_id: (contact.erp_contact_id ?? null) as string | null };
}

export interface TitleFact {
  operation: IntegrationOperation; receipt_key?: string; reverses_receipt_key?: string; reason_code?: string;
}
/** Plano local. Não promove cliente, consulta catálogo remoto nem chama ERP. */
export async function titlePlan(ctx: ModuleContext, module: BookingModule, row: any, options: {
  recognize?: boolean; facts?: TitleFact[]; actor: string | null; completed_at?: number | null;
}) {
  const source = commercialSource(ctx, module, row.id);
  const previous = await commercialState(ctx, source);
  const activation = await readIntegrationActivation(ctx.env, ctx.profile, module);
  const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
  const at = Date.now(), revision = previous.revision + 1;
  const recognized = previous.snapshot?.lifecycle.authorized_at != null;
  const hasReceipt = recognized && !previous.seq ? await one(ctx.env,
    "SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND owner_module=? AND source_id=? LIMIT 1", ctx.profile, module, row.id) : null;
  const frozen = recognized && (!!previous.seq || !!hasReceipt);
  const recognize = !!options.recognize && !recognized && integer(row.price_cents ?? 0) > 0;
  const sensitive = !!(activation.states.saude || activation.states.ensino || activation.states.juridico);
  const customer = frozen ? { customer_ref: previous.snapshot!.customer_ref, contact_id: previous.snapshot!.contact_id } : await payer(ctx, row, sensitive);
  const total = frozen ? previous.snapshot!.total_cents : integer(row.price_cents ?? 0);
  const deposit = module === "reserva" ? integer(row.deposit_cents ?? 0) : 0;
  if (deposit > total) throw new IntegrationError("total_mismatch");
  const kind = module === "agenda" ? "service" : "unit";
  const link = !frozen && activation.snapshot.parts.products ? await one(ctx.env,
    "SELECT erp_item_id FROM module_erp_catalog_links WHERE profile_id=? AND module_id=? AND record_kind=? AND record_id=? AND component='main'", ctx.profile, module, kind, module === "agenda" ? row.service_id : row.unit_id) : null;
  const issued = recognize ? at : previous.snapshot?.lifecycle.authorized_at ?? row.created ?? at;
  const snapshot: CommercialSnapshot = {
    schema: 1, source, source_revision: revision, ...customer,
    // Identificado sem vínculo promovível também fica pendente; nunca Consumidor.
    privacy: sensitive || row.contact_id || row.customer_name || row.customer_phone ? "adult_payer_only" : "commercial",
    description: "Serviço contratado", issued_on: recognized ? previous.snapshot!.issued_on : brasiliaDate(issued),
    items: frozen ? previous.snapshot!.items : [{ id: uuid5(F3_NAMESPACES.internal, canonical([source, "item"])), description: "Serviço contratado", quantity: "1", unit_cents: total, unit: "UN", kind: link ? "service" : "free", product_id: link?.erp_item_id ?? null }],
    total_cents: total, freight_cents: 0, discount_cents: 0,
    installments: frozen ? previous.snapshot!.installments : total > 0 ? module === "reserva" ? [
      ...(deposit ? [{ key: "deposit", due_on: brasiliaDate(row.payment_due_at ?? at), amount_cents: deposit, payment_method_id: policy.payment_method_id }] : []),
      ...(total > deposit ? [{ key: "balance", due_on: brasiliaDate(row.arrival_at), amount_cents: total - deposit, payment_method_id: policy.payment_method_id }] : []),
    ] : [{ key: "main", due_on: brasiliaDate(at), amount_cents: total, payment_method_id: policy.payment_method_id }] : [],
    policy_version: recognized ? previous.snapshot!.policy_version : policy.version,
    lifecycle: { base_status: row.status, stage_id: null, quote_version: null,
      authorization: recognize || recognized ? "fixed_price" : null,
      authorized_at: recognized ? previous.snapshot!.lifecycle.authorized_at : recognize ? at : null,
      first_execution_at: previous.snapshot?.lifecycle.first_execution_at ?? options.completed_at ?? null,
      delivered_at: options.completed_at ?? previous.snapshot?.lifecycle.delivered_at ?? null, warranty_until: null }, technical: null,
  };
  if (recognized) snapshot.privacy = previous.snapshot!.privacy;
  const finance = [module, "erp", "erp-financeiro"].every(id => {
    const a = activation.activations[id];
    return a?.enabled === 1 && a.enabled_since_ms !== null && a.enabled_since_ms <= at;
  }) && activation.snapshot.parts.finance;
  const obligation = previous.seq > 0 && await one(ctx.env, `SELECT 1 FROM module_erp_events WHERE profile_id=? AND module_id=? AND source_id=?
    AND json_extract(payload_json,'$.operation')='recognize' AND json_extract(payload_json,'$.eligible.finance')=1 LIMIT 1`, ctx.profile, module, row.id);
  const balance = options.facts?.some(f => f.operation === "cancel") ? await receiptBalance(ctx, source) : null;
  const reversing = (options.facts ?? []).filter(f => f.operation === "reverse");
  let reversed = 0;
  for (const fact of reversing) reversed += (await one(ctx.env, "SELECT coalesce(sum(amount_cents),0) amount FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND module_id=? AND source_id=?", ctx.profile, fact.reverses_receipt_key, module, row.id)).amount;
  const facts = [...(recognize && finance ? [{ operation: "recognize" as const }] : []), ...(options.facts ?? []).filter(fact =>
    fact.operation === "receive" ? !!obligation : fact.operation === "cancel" ? !!obligation && (balance?.allocated_cents ?? 0) <= reversed : fact.operation === "reverse" ? !!obligation : true)];
  const events: IntegrationEvent[] = facts.map((fact, index) => {
    const seq = previous.seq + index + 1;
    return { id: commandId(source, seq), command_id: commandId(source, seq), event_key: eventKey(source, fact.operation, revision), source, seq, source_revision: revision,
      operation: fact.operation, occurred_ms: at, epochs: activation.epochs,
      // Manutenção de efeito anterior permanece elegível após desligamento.
      eligible: { document: false, stock: false, finance: !!obligation || finance },
      snapshot, receipt_key: fact.receipt_key ?? null, reverses_receipt_key: fact.reverses_receipt_key ?? null,
      reason_code: fact.reason_code ?? null, actor_id: options.actor };
  });
  return { source, snapshot, previous, at, recognized: recognized || recognize, statements: [
    ...Object.values(activation.activations).map((a): Statement => [
      "SELECT CASE WHEN EXISTS(SELECT 1 FROM module_erp_activation WHERE profile_id=? AND module_id=? AND epoch=? AND enabled=?) THEN 1 ELSE json('integration_version_conflict') END",
      [ctx.profile, a.module_id, a.epoch, a.enabled],
    ]),
    ...integrationStatements({ source, expected_revision: previous.revision, events, next_state: { snapshot } }),
    ...aliasStatements(source, module === "agenda" ? "appointment" : "booking", row.id),
  ] };
}

export async function sourceProjection(ctx: ModuleContext, source: SourceRef, module: BookingModule) {
  if (source.profile !== ctx.profile || source.module !== module || source.component !== "main") throw new IntegrationError("not_found", 404);
  const row = await commercialRow(ctx, module, source.source_id);
  const state = await commercialState(ctx, source);
  if (!state.snapshot) throw new IntegrationError("historical_origin_unlinked");
  // A correção da base fecha primeiro o comando incerto. Somente um pagador
  // antes ausente pode ser completado; cliente contratado existente é fixo.
  if (!state.snapshot.customer_ref && !state.snapshot.contact_id) {
    const activation = await readIntegrationActivation(ctx.env, ctx.profile, module);
    return { ...state.snapshot, ...await payer(ctx, row, state.snapshot.privacy === "adult_payer_only" || !!(activation.states.saude || activation.states.ensino || activation.states.juridico)) };
  }
  return state.snapshot;
}
/** Agenda operacional: inclusive a criação não emite reconhecimento. */
export async function agendaNative(ctx: ModuleContext, before: any | null, after: any, sql: string, ...bindings: unknown[]) {
  const state = await commercialState(ctx, commercialSource(ctx, "agenda", after.id));
  const facts: TitleFact[] = after.status === "cancelled" && state.snapshot?.lifecycle.authorized_at != null
    ? [{ operation: "cancel", reason_code: "appointment_cancelled" }] : [];
  const plan = await titlePlan(ctx, "agenda", after, { actor: after.cancelled_by ?? after.created_by ?? null, facts });
  try {
    const results = await commercialAtomic(ctx, [
      ...(before ? [bookingGuard(ctx, "agenda", before)] : []), [sql, bindings], integrationCasGuard, ...plan.statements,
    ]);
    return results[before ? 1 : 0];
  } catch (error) {
    if (error instanceof IntegrationError && error.code === "version_conflict") {
      if (!before || sql.startsWith("UPDATE agenda_appointments SET professional_id"))
        throw new ApiError(409, "slot_taken", "Este horário acabou de ser ocupado. Escolha outro.");
      const current = await commercialRow(ctx, "agenda", before.id);
      if (!["booked", "confirmed"].includes(current.status))
        throw new ApiError(409, "appointment_closed", "Este agendamento já foi encerrado.");
      throw new ApiError(409, "appointment_changed", "Este agendamento acabou de mudar. Atualize e tente de novo.");
    }
    throw error;
  }
}
export const agendaProducer: IntegrationProducer = {
  module: "agenda",
  authorizeSource: (ctx, actor, source, write) => authorizeBooking(ctx, actor, source, write, "agenda"),
  project: (ctx, source) => sourceProjection(ctx, source, "agenda"),
};

/** Resultado e corpo idempotentes locais, sem dados pessoais. */
async function replay(ctx: ModuleContext, module: BookingModule, request: string, fingerprint: string) {
  const scope = `f3-${module}:${ctx.profile}`;
  const old = await one(ctx.env, "SELECT fingerprint,response FROM receipts WHERE scope=? AND key=?", scope, request);
  if (old && old.fingerprint !== fingerprint) throw new IntegrationError("idempotency_conflict", 409);
  return { scope, result: old ? JSON.parse(old.response) : null };
}
function replayStatement(scope: string, request: string, fingerprint: string, result: unknown): Statement {
  return ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [scope, request, fingerprint, canonical(result), Date.now()]];
}
export async function agendaTrigger(ctx: ModuleContext, actor: Actor, id: string, operation: "charge" | "complete", data: { price_cents?: number }, requestId: string) {
  await requireBookingHuman(ctx, actor, "agenda", id);
  await ctx.requireEnabled();
  const fingerprint = hash([id, operation, data.price_cents === undefined ? ["unset"] : ["set", data.price_cents], actor.id]);
  const saved = await replay(ctx, "agenda", opaque(requestId), fingerprint);
  if (saved.result) return saved.result;
  const before = await commercialRow(ctx, "agenda", id), commercial = agendaCommercial(before);
  if (["cancelled", "no_show"].includes(before.status)) throw new IntegrationError("version_conflict", 409);
  let price = before.price_cents;
  if (data.price_cents !== undefined) {
    integer(data.price_cents);
    if (commercial.recognized_at !== null && data.price_cents !== price) throw new IntegrationError("version_conflict", 409);
    price = data.price_cents;
  }
  if (operation === "charge" && !(price > 0)) throw new IntegrationError("price_required", 422);
  const at = Date.now();
  if (operation === "complete") commercial.completed_at ??= at;
  if (operation === "charge") commercial.charged_at ??= at;
  const plan = await titlePlan(ctx, "agenda", { ...before, price_cents: price }, { recognize: price > 0, actor: actor.id, completed_at: commercial.completed_at });
  commercial.recognized_at = plan.snapshot.lifecycle.authorized_at;
  const result = { id, price_cents: price, commercial };
  await commercialAtomic(ctx, [bookingGuard(ctx, "agenda", before),
    ["UPDATE agenda_appointments SET price_cents=?,commercial_json=?,updated=? WHERE profile_id=? AND id=?", [price, canonical(commercial), at, ctx.profile, id]], integrationCasGuard,
    ...plan.statements, replayStatement(saved.scope, requestId, fingerprint, result)]);
  return result;
}

/** Valores aplicados, sem confundir dinheiro recebido a mais com receita. */
export async function receiptBalance(ctx: ModuleContext, source: SourceRef) {
  const rows = await all(ctx.env, `SELECT r.receipt_key,r.kind,r.amount_cents,r.reverses_key,coalesce(sum(a.amount_cents),0) allocated
    FROM module_commercial_receipts r LEFT JOIN module_erp_allocations a ON a.profile_id=r.profile_id AND a.receipt_key=r.receipt_key
    WHERE r.profile_id=? AND r.owner_module=? AND r.source_id=? GROUP BY r.receipt_key`, ctx.profile, source.module, source.source_id);
  let received = 0, allocated = 0;
  for (const r of rows) { const sign = r.kind === "receive" ? 1 : -1; received += sign * r.amount_cents; allocated += sign * r.allocated; }
  integer(received); integer(allocated);
  return { received_cents: received, allocated_cents: allocated, excess_cents: received - allocated };
}
/** Consulta financeira local; a identidade técnica nunca amplia a leitura. */
export async function bookingReceipts(ctx: ModuleContext, actor: Actor, module: BookingModule, id: string) {
  requireIntegrationHuman(actor, ctx.profile);
  await authorizeBooking(ctx, actor, commercialSource(ctx, module, id), false, module);
  if (!["admin", "financeiro"].includes(erpRoleOf(actor) ?? "")) throw new IntegrationError("forbidden", 403);
  const row = await commercialRow(ctx, module, id), source = commercialSource(ctx, module, id);
  const state = await commercialState(ctx, source), balance = await receiptBalance(ctx, source);
  const total = state.snapshot?.lifecycle.authorized_at != null ? state.snapshot.total_cents : module === "reserva" ? row.price_cents : 0;
  const remaining = Math.max(0, total - balance.allocated_cents), cancelled = ["cancelled", "expired"].includes(row.status);
  const receipts = await all(ctx.env, "SELECT receipt_key,kind,reverses_key,amount_cents,method,occurred_ms,actor_id FROM module_commercial_receipts WHERE profile_id=? AND owner_module=? AND source_id=? ORDER BY occurred_ms,receipt_key", ctx.profile, module, id);
  const allocations = await all(ctx.env, `SELECT a.receipt_key,a.allocation_key,a.amount_cents,r.kind FROM module_erp_allocations a
    JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key
    WHERE a.profile_id=? AND a.module_id=? AND a.source_id=? AND a.component='main'`, ctx.profile, module, id);
  const installments = (state.snapshot?.installments ?? []).map((installment, ordinal) => ({ ...installment,
    received_cents: allocations.reduce((sum, a) => a.allocation_key === allocationKey(a.receipt_key, source, ordinal) ? sum + (a.kind === "receive" ? 1 : -1) * a.amount_cents : sum, 0),
  }));
  return { total_cents: total, ...balance, outstanding_cents: cancelled ? 0 : remaining, cancelled_cents: cancelled ? remaining : 0,
    review_required: balance.excess_cents > 0, installments, receipts };
}
export async function receiptPlan(ctx: ModuleContext, module: BookingModule, row: any, receipt: CommercialReceipt, options: { limit?: number; reason?: string; cancel?: boolean } = {}) {
  const source = commercialSource(ctx, module, row.id);
  const old = await one<CommercialReceipt>(ctx.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, receipt.receipt_key);
  if (old) {
    if (old.owner_module !== module || old.source_id !== row.id || old.amount_cents !== receipt.amount_cents || old.kind !== receipt.kind || old.evidence !== receipt.evidence || old.reverses_key !== receipt.reverses_key ||
      receipt.evidence === "manual" && old.evidence_hash !== receipt.evidence_hash || receipt.method === "pix" && old.method !== "pix") throw new IntegrationError("idempotency_conflict", 409);
    // O núcleo pode ter persistido a evidência antes de entregar o gancho.
    // Só o marcador no lote do produtor prova que a mutação local foi aplicada.
    receipt = old;
  }
  const applied = await one(ctx.env, "SELECT source_id,component FROM module_erp_aliases WHERE profile_id=? AND module_id=? AND record_kind='commercial_receipt' AND record_id=?", ctx.profile, module, receipt.receipt_key);
  if (applied) {
    if (!old || applied.source_id !== row.id || applied.component !== "main") throw new IntegrationError("idempotency_conflict", 409);
    return null;
  }
  const state = await commercialState(ctx, source), balance = await receiptBalance(ctx, source);
  integer(balance.received_cents + (receipt.kind === "receive" && !old ? receipt.amount_cents : receipt.kind === "reverse" && !old ? -receipt.amount_cents : 0));
  const total = state.snapshot?.total_cents ?? integer(row.price_cents ?? 0);
  let allocated: number;
  let allocations: { allocation_key: string; amount_cents: number }[];
  const installments = state.snapshot?.installments.length ? state.snapshot.installments : [{ key: "main", amount_cents: total }];
  if (receipt.kind === "reverse") {
    const originals = await all(ctx.env, "SELECT allocation_key,amount_cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND module_id=? AND source_id=? AND component='main' ORDER BY allocation_key", ctx.profile, receipt.reverses_key, module, row.id);
    allocations = originals.map(a => {
      const ordinal = installments.findIndex((_, i) => a.allocation_key === allocationKey(receipt.reverses_key!, source, i));
      if (ordinal < 0) throw new IntegrationError("version_conflict", 409);
      return { allocation_key: allocationKey(receipt.receipt_key, source, ordinal), amount_cents: a.amount_cents };
    });
    allocated = allocations.reduce((sum, a) => sum + a.amount_cents, 0);
  } else {
    allocated = Math.min(receipt.amount_cents, Math.max(0, total - balance.allocated_cents), options.limit ?? Number.MAX_SAFE_INTEGER);
    const previous = await all(ctx.env, `SELECT a.allocation_key,a.amount_cents,r.receipt_key,r.kind FROM module_erp_allocations a
      JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key
      WHERE a.profile_id=? AND a.module_id=? AND a.source_id=? AND a.component='main'`, ctx.profile, module, row.id);
    let remaining = allocated;
    allocations = [];
    for (const [ordinal, installment] of installments.entries()) {
      const used = previous.reduce((sum, a) => a.allocation_key === allocationKey(a.receipt_key, source, ordinal) ? sum + (a.kind === "receive" ? 1 : -1) * a.amount_cents : sum, 0);
      const amount = Math.min(remaining, Math.max(0, installment.amount_cents - used));
      if (amount) allocations.push({ allocation_key: allocationKey(receipt.receipt_key, source, ordinal), amount_cents: amount });
      remaining -= amount;
    }
    if (remaining !== 0) throw new IntegrationError("total_mismatch");
  }
  const facts: TitleFact[] = allocated ? [{ operation: receipt.kind, receipt_key: receipt.receipt_key, reverses_receipt_key: receipt.reverses_key ?? undefined, reason_code: options.reason }] : [];
  if ((options.cancel || receipt.kind === "reverse" && ["cancelled", "expired"].includes(row.status)) && state.snapshot?.lifecycle.authorized_at != null && balance.allocated_cents - allocated <= 0) {
    const cancelled = await one(ctx.env, `SELECT 1 FROM module_erp_events WHERE profile_id=? AND module_id=? AND source_id=? AND json_extract(payload_json,'$.operation')='cancel' LIMIT 1`, ctx.profile, module, row.id);
    if (!cancelled) facts.push({ operation: "cancel", reason_code: "payment_reversed" });
  }
  const plan = await titlePlan(ctx, module, row, { actor: receipt.actor_id, facts });
  return { ...plan, allocated, statements: [...plan.statements, ...commercialReceiptStatements(receipt), ...allocations.flatMap(a => allocationStatements(source, receipt.receipt_key, a.allocation_key, a.amount_cents)),
    ...aliasStatements(source, "commercial_receipt", receipt.receipt_key)] };
}
export async function manualBookingReceipt(ctx: ModuleContext, actor: Actor, module: BookingModule, id: string, data: { amount_cents: number; method: CommercialReceipt["method"] }, requestId: string) {
  await requireBookingHuman(ctx, actor, module, id); requireFinancialAal(actor);
  await ctx.requireEnabled();
  integer(data.amount_cents, 1);
  if (!["cash", "pix", "card", "other", "unknown"].includes(data.method)) throw new IntegrationError("invalid_request", 400);
  const receipt: CommercialReceipt = { profile_id: ctx.profile, receipt_key: manualReceiptKey(ctx.profile, module, opaque(requestId)), owner_module: module, source_id: id,
    kind: "receive", evidence: "manual", reverses_key: null, amount_cents: data.amount_cents, method: data.method, occurred_ms: Date.now(), actor_id: actor.id,
    evidence_hash: hash([module, id, actor.id, data.amount_cents, data.method]) };
  const before = await commercialRow(ctx, module, id);
  // Repetição continua válida depois de encerramento/estorno.
  const existing = await one(ctx.env, "SELECT evidence_hash FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, receipt.receipt_key);
  if (!existing && (["cancelled", "expired", "no_show"].includes(before.status) || module === "agenda" && !agendaCommercial(before).recognized_at)) throw new IntegrationError("version_conflict", 409);
  const plan = await receiptPlan(ctx, module, before, receipt);
  if (plan) await commercialAtomic(ctx, [bookingGuard(ctx, module, before), ...plan.statements]);
  const applied = await one(ctx.env, "SELECT coalesce(sum(amount_cents),0) cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=?", ctx.profile, receipt.receipt_key);
  return { receipt_key: receipt.receipt_key, amount_cents: receipt.amount_cents, allocated_cents: applied.cents, excess_cents: receipt.amount_cents - applied.cents };
}
export async function reverseBookingReceipt(ctx: ModuleContext, actor: Actor, original: CommercialReceipt, input: { reason_code: string; command: string }) {
  const module = original.owner_module as BookingModule;
  await requireBookingHuman(ctx, actor, module, original.source_id); requireFinancialAal(actor);
  const before = await commercialRow(ctx, module, original.source_id);
  const receipt: CommercialReceipt = { ...original, receipt_key: reverseReceiptKey(original.receipt_key), kind: "reverse", reverses_key: original.receipt_key, occurred_ms: Date.now(), actor_id: actor.id,
    evidence_hash: hash([original.receipt_key, input.reason_code, actor.id]) };
  const plan = await receiptPlan(ctx, module, before, receipt, { reason: input.reason_code });
  if (plan) await commercialAtomic(ctx, [bookingGuard(ctx, module, before), ...plan.statements]);
  return { receipt_key: receipt.receipt_key, reverses_receipt_key: original.receipt_key, amount_cents: original.amount_cents };
}
async function reverseAgenda(env: ModuleContext["env"], actor: Actor, original: CommercialReceipt, input: { reason_code: string; command: string }) {
  const { modulesApi } = await import("../api");
  return reverseBookingReceipt(modulesApi(env, original.profile_id, "agenda"), actor, original, input);
}
export function installAgendaIntegration() {
  registerIntegrationProducer(agendaProducer);
  registerReceiptReverser("agenda", reverseAgenda);
}
