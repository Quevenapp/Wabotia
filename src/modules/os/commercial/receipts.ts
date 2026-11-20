// OS3: cobrança e recebimento da ordem. O recebimento é um fato comercial
// da fase 3 (module_commercial_receipts + alocação por parcela) gravado no
// mesmo lote da ordem; quando já existe a conta a receber no ERP, o mesmo
// lote enfileira o evento "receive" da origem da ordem. Nenhum outro caminho
// de lançamento: o ERP só recebe o que passa pela fila da fase 3.
import { all, one } from "../../../db";
import { ApiError, type Actor, type Conversation, json, now } from "../../../types";
import type { ModuleContext } from "../../api";
import type { IntegrationEvent, Statement } from "../../../integrations/contracts";
import { aliasStatements, commandId, eventKey, integrationStatements, readIntegrationActivation } from "../../../integrations/ports";
import { allocationKey, allocationStatements, commercialReceiptStatements, manualReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../../../integrations/receipts";
import { hash } from "../../../integrations/keys";
import { requireFinancialAal } from "../../../mfa";
import { commercialReceiptFromEvidence, optionalCommercialPaymentEvidence } from "../../../payments-commercial-evidence";
import type { Payment } from "../../../payments";
import { authorizedOrder } from "../public";
import { commitOrderMutation, mutationHistory } from "../mutations";
import { money } from "../model";
import { commercialOf, commercialTitle, readWorkIntegration, workPrivacy, workSource, type WorkIntegration } from "./projection";
import { requireCommercialWriter } from "./routes";
import type { OrderPayments, ReceiptRequest } from "../contracts";

export const RECEIPT_METHODS = ["cash", "pix", "card", "other", "unknown"] as const;
const METHOD_LABELS: Record<string, string> = { cash: "dinheiro", pix: "Pix", card: "cartão", other: "outra forma", unknown: "forma não informada" };
/** Estados em que o orçamento já foi aceito (aprovado ou preço fixo autorizado). */
const PAYABLE = ["approved", "in_progress", "ready", "delivered"];

/** Há conta a receber desta ordem no ERP (primeira execução com Financeiro). */
export function financeObligation(integration: WorkIntegration) {
  return integration.active.finance || integration.events.some(e => {
    const payload = JSON.parse(e.payload_json);
    return payload.operation === "execute" && payload.eligible?.finance === true;
  });
}
function installmentsOf(row: any, integration: WorkIntegration) {
  const saved = integration.snapshot?.installments;
  if (saved?.length) return saved.map(i => ({ amount_cents: i.amount_cents }));
  const local = commercialOf(row).installments;
  if (local?.length) return local.map(i => ({ amount_cents: i.amount_cents }));
  const total = integration.snapshot?.total_cents ?? Number(row.quote_total_cents ?? 0);
  return total > 0 ? [{ amount_cents: total }] : [];
}
/** Recebido líquido (recebimentos menos estornos) da ordem. */
export async function receivedCents(ctx: ModuleContext, id: string) {
  const row = await one(ctx.env, `SELECT coalesce(sum(CASE WHEN kind='receive' THEN amount_cents ELSE -amount_cents END),0) cents
    FROM module_commercial_receipts WHERE profile_id=? AND owner_module='os' AND source_id=?`, ctx.profile, id);
  return Number(row?.cents ?? 0);
}

/** Evento "receive"/"reverse" da origem da ordem, quando há conta a receber. */
function receiptEvent(ctx: ModuleContext, integration: WorkIntegration, receipt: CommercialReceipt, offset: number, epochs: IntegrationEvent["epochs"]): IntegrationEvent | null {
  if (!integration.source || !integration.snapshot) return null;
  const source = workSource(ctx.profile, receipt.source_id);
  const revision = integration.source.revision + 1, seq = integration.source.enqueued_seq + offset + 1;
  const operation = receipt.kind === "reverse" ? "reverse" : "receive";
  return { id: commandId(source, seq), command_id: commandId(source, seq),
    event_key: `${eventKey(source, operation, revision)}:${hash(receipt.receipt_key).slice(0, 16)}`,
    source, seq, source_revision: revision, operation, occurred_ms: receipt.occurred_ms, epochs,
    eligible: { document: false, stock: false, finance: true },
    snapshot: { ...integration.snapshot, source_revision: revision },
    receipt_key: receipt.receipt_key, reverses_receipt_key: receipt.reverses_key, reason_code: null,
    actor_id: receipt.actor_id && /^[0-9a-f-]{36}$/i.test(receipt.actor_id) ? receipt.actor_id : null };
}

/**
 * Plano do recebimento: fato imutável, alocação por parcela (o excedente não
 * vira receita), marcador de aplicação e, com conta a receber no ERP, o
 * evento da fila. Sem conta a receber o recebimento fica na ordem e segue
 * para o ERP na primeira execução (receiptCatchUp).
 */
export async function receiptPlan(ctx: ModuleContext, row: any, receipt: CommercialReceipt) {
  const source = workSource(ctx.profile, row.id);
  const applied = await one(ctx.env, "SELECT source_id FROM module_erp_aliases WHERE profile_id=? AND module_id='os' AND record_kind='commercial_receipt' AND record_id=?", ctx.profile, receipt.receipt_key);
  if (applied) {
    if (applied.source_id !== row.id) throw new ApiError(409, "idempotency_conflict", "Este recebimento pertence a outra ordem.");
    return null;
  }
  const integration = await readWorkIntegration(ctx, row);
  const installments = installmentsOf(row, integration);
  let allocations: { allocation_key: string; amount_cents: number }[] = [];
  if (receipt.kind === "reverse") {
    const originals = await all(ctx.env, "SELECT allocation_key,amount_cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND module_id='os' AND source_id=? AND component='main'", ctx.profile, receipt.reverses_key, row.id);
    allocations = originals.map(a => {
      const ordinal = installments.findIndex((_, i) => a.allocation_key === allocationKey(receipt.reverses_key!, source, i));
      if (ordinal < 0) throw new ApiError(409, "version_conflict", "As parcelas mudaram. Atualize e tente de novo.");
      return { allocation_key: allocationKey(receipt.receipt_key, source, ordinal), amount_cents: a.amount_cents };
    });
  } else {
    const previous = await all(ctx.env, `SELECT a.allocation_key,a.amount_cents,r.receipt_key,r.kind FROM module_erp_allocations a
      JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key
      WHERE a.profile_id=? AND a.module_id='os' AND a.source_id=? AND a.component='main'`, ctx.profile, row.id);
    let remaining = receipt.amount_cents;
    for (const [ordinal, installment] of installments.entries()) {
      const used = previous.reduce((sum, a) => a.allocation_key === allocationKey(a.receipt_key, source, ordinal) ? sum + (a.kind === "receive" ? 1 : -1) * a.amount_cents : sum, 0);
      const amount = Math.min(remaining, Math.max(0, installment.amount_cents - used));
      if (amount > 0) allocations.push({ allocation_key: allocationKey(receipt.receipt_key, source, ordinal), amount_cents: amount });
      remaining -= amount;
    }
  }
  const allocated = allocations.reduce((sum, a) => sum + a.amount_cents, 0);
  const state = await readIntegrationActivation(ctx.env, ctx.profile, "os");
  const event = allocated > 0 && financeObligation(integration) ? receiptEvent(ctx, integration, receipt, 0, state.epochs) : null;
  const statements: Statement[] = [
    ...commercialReceiptStatements(receipt),
    ...allocations.flatMap(a => allocationStatements(source, receipt.receipt_key, a.allocation_key, a.amount_cents)),
    ...aliasStatements(source, "commercial_receipt", receipt.receipt_key),
    ...(event ? integrationStatements({ source, expected_revision: integration.source!.revision, events: [event], next_state: { snapshot: event.snapshot } }) : []),
  ];
  return { statements, allocated, excess: receipt.kind === "receive" ? receipt.amount_cents - allocated : 0, queued: !!event };
}

/**
 * Primeira execução com Financeiro: recebimentos registrados antes da conta
 * a receber seguem a execução na mesma fila, na ordem em que aconteceram.
 */
export async function receiptCatchUp(ctx: ModuleContext, row: any, integration: WorkIntegration, epochs: IntegrationEvent["epochs"], after: number, snapshot: IntegrationEvent["snapshot"]) {
  const pending = await all<CommercialReceipt>(ctx.env, `SELECT * FROM module_commercial_receipts r WHERE r.profile_id=? AND r.owner_module='os' AND r.source_id=?
    AND EXISTS(SELECT 1 FROM module_erp_allocations a WHERE a.profile_id=r.profile_id AND a.receipt_key=r.receipt_key)
    AND NOT EXISTS(SELECT 1 FROM module_erp_events e WHERE e.profile_id=r.profile_id AND e.module_id='os' AND e.source_id=r.source_id
      AND json_extract(e.payload_json,'$.receipt_key')=r.receipt_key) ORDER BY r.occurred_ms,r.receipt_key LIMIT 20`, ctx.profile, row.id);
  const base = { ...integration, snapshot, source: { ...(integration.source ?? { revision: 0, enqueued_seq: 0 }), revision: snapshot.source_revision - 1, enqueued_seq: after } } as WorkIntegration;
  return pending.map((receipt, index) => receiptEvent(ctx, base, receipt, index, epochs)!).filter(Boolean);
}

function authorizedForPayment(row: any) {
  if (!PAYABLE.includes(row.status) || row.decision === "declined")
    throw new ApiError(409, "quote_not_approved", "Registre a aprovação do orçamento (ou autorize o preço fixo) antes de cobrar ou receber.");
}
async function commitReceipt(ctx: ModuleContext, row: any, receipt: CommercialReceipt, actor: string, key: string, note: string) {
  const plan = await receiptPlan(ctx, row, receipt);
  if (!plan) return { row, plan: null };
  const label = `${receipt.kind === "reverse" ? "Estorno" : "Recebimento"} de ${money(receipt.amount_cents)} (${METHOD_LABELS[receipt.method] ?? receipt.method})`;
  const extra = plan.excess > 0 ? ` · ${money(plan.excess)} acima do combinado, fora das parcelas` : "";
  const next = await commitOrderMutation(ctx, row, {}, actor, "os.receipt_recorded", ["receipt"], key,
    `${label}${extra}${note ? " · " + note : ""}`.slice(0, 500), plan.statements);
  return { row: next, plan };
}

/** POST service-orders/:id/receipts: recebimento à mão (sem provedor). */
export async function recordManualReceipt(ctx: ModuleContext, actor: Actor, id: string, data: ReceiptRequest & { version?: number }, requestId: string) {
  requireCommercialWriter(actor);
  requireFinancialAal(actor);
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  const key = `os-receipt:${actor.id}:${requestId}`;
  const done = await mutationHistory(ctx, key);
  if (done) {
    if (done.order_id !== id) throw new ApiError(409, "idempotency_conflict", "Esta chave já identifica outro comando.");
    return paymentsView(ctx, actor, id);
  }
  authorizedForPayment(row);
  if (!Number.isSafeInteger(data.amount_cents) || data.amount_cents < 1 || data.amount_cents > 100_000_000_00)
    throw new ApiError(400, "invalid_request", "Informe o valor recebido em centavos, maior que zero.");
  if (!(RECEIPT_METHODS as readonly string[]).includes(data.method))
    throw new ApiError(400, "invalid_request", "Forma de recebimento: cash, pix, card, other ou unknown.");
  const at = data.occurred_at ?? now();
  if (!Number.isSafeInteger(at) || at <= 0 || at > now() + 5 * 60_000)
    throw new ApiError(400, "invalid_request", "A data do recebimento não pode estar no futuro.");
  const note = typeof data.note === "string" ? data.note.trim().slice(0, 200) : "";
  const receipt: CommercialReceipt = { profile_id: ctx.profile, receipt_key: manualReceiptKey(ctx.profile, "os", key), owner_module: "os", source_id: id,
    kind: "receive", evidence: "manual", reverses_key: null, amount_cents: data.amount_cents, method: data.method, occurred_ms: at, actor_id: actor.id,
    evidence_hash: hash(["os", id, actor.id, data.amount_cents, data.method, at]) };
  await commitReceipt(ctx, row, receipt, actor.id, key, (await workPrivacy(ctx, row)) === "adult_payer_only" ? "" : note);
  return paymentsView(ctx, actor, id);
}

/** POST service-orders/:id/charges: Pix ou link de pagamento pela Cobrança da área. */
export async function createOrderCharge(ctx: ModuleContext, actor: Actor, id: string, data: { method?: unknown; amount_cents?: unknown }, requestId: string) {
  requireCommercialWriter(actor);
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  authorizedForPayment(row);
  if (data.method !== "pix" && data.method !== "link") throw new ApiError(400, "invalid_request", "Escolha pix ou link.");
  const ready = await ctx.paymentsReady();
  if (!ready.ready) throw new ApiError(409, ready.reason ?? "payments_not_configured", ready.message ?? "Configure a Cobrança da área para gerar Pix ou link.");
  if (!ready.methods.includes(data.method)) throw new ApiError(409, "payment_method_unavailable", data.method === "pix" ? "A conta de cobrança da área não oferece Pix." : "A conta de cobrança da área não oferece link de pagamento.");
  if (!row.conversation_id) throw new ApiError(409, "no_conversation", "Esta ordem não está ligada a uma conversa do WhatsApp. Registre o recebimento à mão.");
  const c = await ctx.conversation(row.conversation_id, actor) as Conversation;
  const total = Number(row.quote_total_cents ?? 0), balance = total - await receivedCents(ctx, id);
  const amount = data.amount_cents === undefined ? balance : data.amount_cents;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1)
    throw new ApiError(409, "nothing_to_charge", "Não há saldo a cobrar nesta ordem.");
  const reserved = (await workPrivacy(ctx, row)) === "adult_payer_only";
  const payment = await ctx.charge(c, {
    method: data.method, amount_cents: amount, ref: id,
    description: reserved ? "Serviço contratado" : commercialTitle(row),
    sourceKey: `os-charge:${id}:${actor.id}:${requestId}`, trigger: "agent", actor: actor.id,
  });
  return { charge: chargeView(payment as any), payments: await paymentsView(ctx, actor, id) };
}

function chargeView(p: any) {
  return { id: p.id, method: p.method, status: p.status, amount_cents: p.amount_cents, url: p.url ?? null,
    pix_code: p.pix_code ?? null, expires_at: p.expires_at ?? null, created: p.created };
}

/** GET service-orders/:id/payments: recebido, saldo, recebimentos e cobranças. */
export async function paymentsView(ctx: ModuleContext, actor: Actor, id: string): Promise<OrderPayments> {
  const { row } = await authorizedOrder(ctx, actor, id);
  const integration = await readWorkIntegration(ctx, row);
  const [receipts, charges, links, state, provider, privacy] = await Promise.all([
    all(ctx.env, "SELECT receipt_key,kind,evidence,amount_cents,method,occurred_ms,actor_id FROM module_commercial_receipts WHERE profile_id=? AND owner_module='os' AND source_id=? ORDER BY occurred_ms,receipt_key", ctx.profile, id),
    all(ctx.env, "SELECT id,method,status,amount_cents,url,pix_code,expires_at,created FROM payments WHERE profile_id=? AND module_id='os' AND ref_id=? ORDER BY created DESC LIMIT 20", ctx.profile, id),
    all(ctx.env, "SELECT component,erp_item_id,version FROM module_erp_catalog_links WHERE profile_id=? AND module_id='os' AND record_kind='quote_item' AND record_id=?", ctx.profile, id),
    readIntegrationActivation(ctx.env, ctx.profile, "os"),
    ctx.paymentsReady(),
    workPrivacy(ctx, row),
  ]);
  const total = Number(row.quote_total_cents ?? 0);
  const received = receipts.reduce((sum, r) => sum + (r.kind === "receive" ? 1 : -1) * r.amount_cents, 0);
  const parts = state.snapshot.parts, base = !!(state.states.os && parts.customers);
  return { id, version: row.row_version ?? 1, total_cents: total, received_cents: received, balance_cents: Math.max(0, total - received),
    receipts: receipts as OrderPayments["receipts"], charges: charges.map(chargeView),
    provider: { ready: provider.ready, message: provider.message ?? "", methods: [...provider.methods] },
    finance: { enabled: base && !!parts.finance, obligation: financeObligation(integration) },
    parts: { products: base && !!parts.products, finance: base && !!parts.finance },
    catalog_links: Object.fromEntries(links.map(l => [l.component, { erp_item_id: l.erp_item_id, version: Number(l.version ?? 1) }])),
    privacy: privacy === "adult_payer_only" ? "reserved" : "commercial" };
}

/**
 * Gancho da Cobrança: pagamento confirmado pelo provedor vira recebimento da
 * ordem; estorno vira o estorno do mesmo recebimento. Sem evidência
 * comprovada, nada é lançado (o histórico registra a espera).
 */
export async function orderPaymentUpdated(ctx: ModuleContext, payment: Payment) {
  const p = payment as any;
  if (!p.ref_id || !["paid", "refunded"].includes(p.status)) return;
  const row = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, p.ref_id);
  if (!row) return;
  const key = `os-payment:${p.id}:${p.status}`;
  if (await mutationHistory(ctx, key)) return;
  const paid = await optionalCommercialPaymentEvidence(ctx.env, ctx.profile, "os", p.id, row.id, "paid", p.evidence ?? null);
  if (!paid) {
    await commitOrderMutation(ctx, row, {}, "system", "os.receipt_recorded", ["receipt"], key,
      `Pagamento ${p.status === "paid" ? "confirmado" : "estornado"} pela Cobrança (${money(p.amount_cents)}); aguardando a evidência do provedor para lançar no Financeiro.`);
    return;
  }
  if (p.status === "paid") {
    await commitReceipt(ctx, row, commercialReceiptFromEvidence(paid, row.id), "system", key, "Cobrança paga");
    return;
  }
  const reversed = await optionalCommercialPaymentEvidence(ctx.env, ctx.profile, "os", p.id, row.id, "refunded", p.evidence ?? null);
  const original = commercialReceiptFromEvidence(paid, row.id);
  const receipt: CommercialReceipt = reversed ? commercialReceiptFromEvidence(reversed, row.id)
    : { ...original, receipt_key: reverseReceiptKey(original.receipt_key), kind: "reverse", reverses_key: original.receipt_key, occurred_ms: now(), evidence_hash: hash([original.receipt_key, "refunded"]) };
  await commitReceipt(ctx, row, receipt, "system", key, "Cobrança estornada");
}

/** Leitura usada pela impressão e pelo detalhe. */
export const orderTermsOf = (row: any) => json(row.quote_terms_json, null);
