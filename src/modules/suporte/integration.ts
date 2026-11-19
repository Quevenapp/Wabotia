// Produtor D1 do Suporte avulso. Nenhuma função deste arquivo chama o ERP.
import { all, one } from "../../db";
import { resolveCustomer } from "../../customer/ports";
import type { Conversation } from "../../types";
import type { Payment } from "../../payments";
import type { ModuleContext } from "../api";
import { payerForReview } from "../mensalidade/public";
import { canProfile } from "../../security";
import { requireAccess } from "../../access";
import type { CommercialSnapshot, IntegrationEvent, IntegrationOperation, SourceRef, Statement } from "../../integrations/contracts";
import type { IntegrationProducer } from "../../integrations/ports";
import { readIntegrationActivation } from "../../integrations/activation";
import { ensureCommercialPolicy, requireIntegrationHuman } from "../../integrations/policy";
import { catalogLink } from "../../integrations/catalog";
import { aliasStatements, integrationStatements } from "../../integrations/outbox";
import { allocationKey, allocationStatements, commercialReceiptStatements, providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../../integrations/receipts";
import { canonical, commandId, eventKey, F3_NAMESPACES, hash, uuid5 } from "../../integrations/keys";
import { IntegrationError } from "../../integrations/privacy";
import { suporteSettings, type SupportCommercialPurchase } from "./model";

export const supportSource = (profile: string, id: string): SourceRef => ({
  profile, module: "suporte", source_id: id, component: "main",
});

export async function supportCommercialContext(ctx: ModuleContext) {
  const activation = await readIntegrationActivation(ctx.env, ctx.profile, "suporte");
  const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
  return { activation, policy };
}
type CommercialContext = Awaited<ReturnType<typeof supportCommercialContext>>;
const day = (at: number) => new Date(at - 3 * 3_600_000).toISOString().slice(0, 10);
const eligibleAt = ({ activation }: CommercialContext, at: number) =>
  activation.snapshot.parts.finance && ["suporte", "erp", "erp-financeiro"].every(id => {
    const a = activation.activations[id];
    return a?.enabled === 1 && a.enabled_since_ms !== null && at >= a.enabled_since_ms;
  });

/** Nunca confunde interlocutor de Saúde/Ensino com o responsável financeiro.
 * Sem pagador confirmado, conserva pendência; não troca por Consumidor.
 */
async function buyer(ctx: ModuleContext, purchase: SupportCommercialPurchase, setup: CommercialContext, c?: Conversation) {
  const sensitive = setup.activation.states.saude || setup.activation.states.ensino;
  let local: string | null = null;
  const session = purchase.session_id && await one(ctx.env,
    "SELECT phone_linked FROM suporte_sessions WHERE profile_id=? AND id=?", ctx.profile, purchase.session_id);
  if (purchase.payer_id && (!purchase.session_id || session && session.phone_linked === 1)) {
    const payer = await payerForReview(ctx.env, ctx.profile, purchase.payer_id);
    local = payer?.contact_id ?? null;
  }
  if (!local && !sensitive) {
    const historical = await one(ctx.env, `SELECT contact_id FROM customer_records
      WHERE profile_id=? AND module_id='suporte' AND kind=? AND record_id=?`,
    ctx.profile, c && purchase.session_id ? "sessions" : "purchases",
    c && purchase.session_id ? `${purchase.conversation_id}:${purchase.session_id}` : purchase.id);
    if (c) {
      const ref = await resolveCustomer(ctx.env, c);
      if (ref.profileId === ctx.profile && ref.namespace === "team" && ref.state === "ready" &&
          (!purchase.session_id || historical?.contact_id === ref.contactId)) local = ref.contactId;
    } else local = historical?.contact_id ?? null;
  }
  const contact = local && await one(ctx.env, `SELECT id,erp_contact_id FROM contacts
    WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'`, ctx.profile, local);
  return { customer_ref: contact ? contact.id as string : null, contact_id: contact?.erp_contact_id ?? null };
}

async function initialSnapshot(ctx: ModuleContext, purchase: SupportCommercialPurchase, setup: CommercialContext, c?: Conversation): Promise<CommercialSnapshot> {
  const source = supportSource(ctx.profile, purchase.id);
  const product = await catalogLink(ctx.env, source, "package", purchase.package_id, "main");
  return {
    schema: 1, source, source_revision: 1, ...await buyer(ctx, purchase, setup, c),
    privacy: "adult_payer_only", description: "Serviço contratado", issued_on: day(purchase.created),
    items: [{ id: uuid5(F3_NAMESPACES.internal, canonical(["support-item", source])),
      description: "Serviço contratado", quantity: "1", unit_cents: purchase.price_cents,
      unit: "UN", kind: product ? "service" : "free", product_id: product }],
    total_cents: purchase.price_cents, freight_cents: 0, discount_cents: 0,
    installments: [{ key: "main", due_on: day(purchase.created), amount_cents: purchase.price_cents,
      payment_method_id: setup.policy.payment_method_id }],
    policy_version: setup.policy.version,
    lifecycle: { base_status: purchase.status, stage_id: null, quote_version: null,
      authorization: "fixed_price", authorized_at: purchase.created, first_execution_at: null,
      delivered_at: null, warranty_until: null }, technical: null,
  };
}

/** Só aceita evidência do núcleo persistida, nunca o texto do cliente ou da IA.
 * O gancho pode ser antigo: paid seguido de refunded permanece evidência de ambos.
 */
export async function supportPaymentEvidence(ctx: ModuleContext, purchase: SupportCommercialPurchase, payment: Payment) {
  const row = await one(ctx.env, `SELECT id,profile_id,module_id,ref_id,conversation_id,provider,account_id,
    provider_payment_id,amount_cents,currency,method,status,paid_at,updated
    FROM payments WHERE id=? AND profile_id=? AND module_id='suporte' AND ref_id=?`,
  payment.id, ctx.profile, purchase.id);
  if (!row || payment.module_id !== "suporte" || row.ref_id !== payment.ref_id ||
      row.conversation_id !== purchase.conversation_id || row.amount_cents !== payment.amount_cents ||
      row.currency !== "BRL" || row.method !== payment.method ||
      (payment.status === "paid" && !["paid", "refunded"].includes(row.status)) ||
      (payment.status === "refunded" && row.status !== "refunded"))
    throw new IntegrationError("invalid_request", 422);
  const key = supportReceiptKey(row);
  if (key && ["paid", "refunded"].includes(payment.status)) {
    const existing = await one<CommercialReceipt>(ctx.env,
      "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, key);
    if (existing && (existing.owner_module !== "suporte" || existing.source_id !== purchase.id ||
        existing.kind !== "receive" || existing.amount_cents !== row.amount_cents))
      throw new IntegrationError("idempotency_conflict", 409);
  }
  return row;
}

export const supportReceiptKey = (row: Record<string, any>) =>
  row.provider && row.account_id && row.provider_payment_id
    ? providerReceiptKey(row.profile_id, row.provider, row.account_id, String(row.provider_payment_id)) : null;

async function receipt(ctx: ModuleContext, purchase: SupportCommercialPurchase, row: Record<string, any>, kind: "receive" | "reverse"): Promise<CommercialReceipt | null> {
  const key = supportReceiptKey(row);
  if (!key || !Number.isSafeInteger(row.paid_at) || row.paid_at <= 0) return null;
  const receiptKey = kind === "receive" ? key : reverseReceiptKey(key);
  const method = row.method === "pix" ? "pix" : "unknown"; // Link não comprova cartão.
  const old = await one<CommercialReceipt>(ctx.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, receiptKey);
  // B8 pode já ter gravado a evidência comum: reutilizar seu hash e instante.
  if (old) {
    if (old.owner_module !== "suporte" || old.source_id !== purchase.id || old.kind !== kind ||
        old.amount_cents !== row.amount_cents || old.evidence !== "provider" ||
        old.reverses_key !== (kind === "reverse" ? key : null)) throw new IntegrationError("idempotency_conflict", 409);
    return old;
  }
  return { profile_id: ctx.profile, receipt_key: receiptKey, owner_module: "suporte", source_id: purchase.id,
    kind, evidence: "provider", reverses_key: kind === "reverse" ? key : null,
    amount_cents: row.amount_cents, method, occurred_ms: kind === "receive" ? row.paid_at : row.updated,
    actor_id: null, evidence_hash: hash([ctx.profile, row.provider, row.account_id, String(row.provider_payment_id), kind, row.amount_cents, method, row.paid_at]) };
}

/** Incluir após a mutação operacional e sua guarda no MESMO batch D1.
 * Não reconhece passado: compra feita com Financeiro desligado só guarda a
 * fotografia. Um pagamento posterior sem obrigação vinculada vira pendência.
 */
export async function supportIntegrationStatements(
  ctx: ModuleContext, purchase: SupportCommercialPurchase, operation: "recognize" | "receive" | "cancel" | "reverse" | null,
  at: number, options: { setup?: CommercialContext; conversation?: Conversation; payment?: Record<string, any>; reason?: string } = {},
): Promise<Statement[]> {
  if (purchase.profile_id !== ctx.profile) throw new IntegrationError("not_found", 404);
  const source = supportSource(ctx.profile, purchase.id);
  const stored = await one(ctx.env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id='suporte' AND source_id=?", ctx.profile, purchase.id);
  const setup = options.setup ?? await supportCommercialContext(ctx);
  const previous: CommercialSnapshot | undefined = stored && JSON.parse(stored.state_json).snapshot;
  const revision = (stored?.revision ?? 0) + 1;
  const base = previous ?? await initialSnapshot(ctx, purchase, setup, options.conversation);
  const snapshot: CommercialSnapshot = { ...base, source_revision: revision,
    lifecycle: { ...base.lifecycle, base_status: purchase.status } };
  const recognized = await one(ctx.env, `SELECT id FROM module_erp_events WHERE profile_id=? AND module_id='suporte'
    AND source_id=? AND json_extract(payload_json,'$.operation')='recognize' LIMIT 1`, ctx.profile, purchase.id);
  const events: IntegrationEvent[] = [], extra: Statement[] = [];
  let blocked: string | null = null;
  const append = (op: IntegrationOperation, evidence: CommercialReceipt | null = null) => {
    const seq = (stored?.enqueued_seq ?? 0) + events.length + 1;
    const key = eventKey(source, op, revision);
    events.push({ id: uuid5(F3_NAMESPACES.internal, key), command_id: commandId(source, seq), event_key: key,
      source, seq, source_revision: revision, operation: op, occurred_ms: evidence?.occurred_ms ?? at,
      epochs: setup.activation.epochs, eligible: { document: false, stock: false,
        finance: op === "cancel" || op === "reverse" ? !!recognized : eligibleAt(setup, evidence?.occurred_ms ?? at) },
      snapshot, receipt_key: evidence?.receipt_key ?? null, reverses_receipt_key: evidence?.reverses_key ?? null,
      // O adaptador da base também consulta auto_post na manutenção. Conservar
      // ação humana explícita evita confirmar cancelamento/estorno sem efeito.
      reason_code: !setup.policy.auto_post.finance ? "manual_requested" : options.reason ?? null, actor_id: null });
    if (evidence) extra.push(...commercialReceiptStatements(evidence),
      ...allocationStatements(source, evidence.receipt_key, allocationKey(evidence.receipt_key, source, 0), evidence.amount_cents));
  };
  if (operation === "recognize" && !stored && eligibleAt(setup, purchase.created)) append("recognize");
  if (operation === "cancel" && recognized) append("cancel");
  if (operation === "receive" || operation === "reverse") {
    const paid = options.payment && await receipt(ctx, purchase, options.payment, "receive");
    const received = paid && await one(ctx.env, `SELECT id FROM module_erp_events WHERE profile_id=? AND module_id='suporte'
      AND source_id=? AND json_extract(payload_json,'$.receipt_key')=?`, ctx.profile, purchase.id, paid.receipt_key);
    if (!recognized) blocked = "historical_origin_unlinked";
    if (!paid) blocked = "invalid_request";
    if (options.payment?.amount_cents !== purchase.price_cents) blocked = "total_mismatch";
    // Excesso não é receita: conserva a compra e uma pendência, sem alocá-lo.
    if (!received) append("receive", blocked === "total_mismatch" ? null : paid || null);
    if (operation === "reverse") {
      const reversed = options.payment && await receipt(ctx, purchase, options.payment, "reverse");
      append("reverse", blocked === "total_mismatch" ? null : reversed || null);
    }
  }
  const statements = [
    ...integrationStatements({ source, expected_revision: stored?.revision ?? 0, events, next_state: { snapshot } }),
    ...aliasStatements(source, "purchase", purchase.id), ...extra,
  ];
  if (blocked) for (const event of events) statements.push([
    "UPDATE module_erp_delivery SET state='blocked',error_code=?,error_message=? WHERE event_id=?",
    [blocked, new IntegrationError(blocked).message, event.id],
  ]);
  else for (const event of events) if (event.reason_code === "manual_requested") statements.push([
    "UPDATE module_erp_delivery SET state='waiting_manual',error_code='waiting_manual',error_message=? WHERE event_id=?",
    [new IntegrationError("waiting_manual").message, event.id],
  ]);
  return statements;
}

/** Apenas existência/estado, sem títulos, contas ou erros livres para o atendimento. */
export async function supportIntegrationStatus(ctx: ModuleContext, purchaseId: string) {
  return (await supportIntegrationStatuses(ctx, [purchaseId]))[purchaseId];
}
export async function supportIntegrationStatuses(ctx: ModuleContext, purchaseIds: string[]) {
  if (!purchaseIds.length) return {};
  const rows = await all(ctx.env, `SELECT e.source_id,d.state,d.receipt_json FROM module_erp_events e
    JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND e.module_id='suporte'
    AND e.source_id IN (SELECT value FROM json_each(?)) ORDER BY e.seq`, ctx.profile, JSON.stringify(purchaseIds));
  return Object.fromEntries(purchaseIds.map(id => {
    const own = rows.filter(row => row.source_id === id);
    const pending = own.find(row => row.state !== "done") ??
      (own.at(-1)?.receipt_json && JSON.parse(own.at(-1)!.receipt_json).outcome === "closed" ? { state: "blocked" } : null);
    return [id, { pending: !!pending, state: pending?.state ?? (own.length ? "done" : "off"),
      message: pending?.state === "waiting_manual" ? "Aguardando lançamento manual" : pending ? "Pendente no ERP" : null }];
  }));
}

export const supportIntegrationProducer: IntegrationProducer = {
  module: "suporte",
  async authorizeSource(ctx, actor, source, write) {
    if (source.profile !== ctx.profile || source.module !== "suporte" || !canProfile(actor, ctx.profile))
      throw new IntegrationError("not_found", 404);
    requireAccess(actor, "suporte");
    if (write) requireIntegrationHuman(actor, ctx.profile);
    if (source.component === "catalog:package:main") {
      requireIntegrationHuman(actor, ctx.profile);
      if (actor.role !== "admin") throw new IntegrationError("forbidden", 403);
      if (!suporteSettings(await ctx.settings()).packages.some(pkg => pkg.id === source.source_id))
        throw new IntegrationError("not_found", 404);
      return;
    }
    if (source.component !== "main") throw new IntegrationError("not_found", 404);
    ctx.access(actor, "conversations:read");
    const purchase = await one(ctx.env, "SELECT conversation_id FROM suporte_purchases WHERE profile_id=? AND id=?", ctx.profile, source.source_id);
    if (!purchase) throw new IntegrationError("not_found", 404);
    await ctx.conversation(purchase.conversation_id, actor);
  },
  async project(ctx, source) {
    if (source.profile !== ctx.profile || source.module !== "suporte" || source.component !== "main")
      throw new IntegrationError("not_found", 404);
    const row = await one(ctx.env, `SELECT s.state_json,s.links_json,p.* FROM module_erp_sources s
      JOIN suporte_purchases p ON p.profile_id=s.profile_id AND p.id=s.source_id
      WHERE s.profile_id=? AND s.module_id='suporte' AND s.source_id=?`, ctx.profile, source.source_id);
    if (!row) throw new IntegrationError("not_found", 404);
    // Correção explícita antes dos efeitos pode completar o pagador histórico.
    // Preço e catálogo contratados sobrevivem à remoção/renomeação do pacote.
    const snapshot: CommercialSnapshot = JSON.parse(row.state_json).snapshot;
    if (!snapshot.customer_ref && !snapshot.contact_id && JSON.parse(row.links_json).length === 0)
      return { ...snapshot, ...await buyer(ctx, row, await supportCommercialContext(ctx)) };
    return snapshot;
  },
};
