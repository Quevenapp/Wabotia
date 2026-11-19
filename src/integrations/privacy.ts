import { ApiError } from "../types";
import type { CommercialSnapshot, IntegrationEvent, IntegrationResult, SourceRef } from "./contracts";
import { canonical, commandId, localEventId } from "./keys";

const messages: Record<string, string> = {
  integration_not_implemented: "Integração ainda não disponível para este módulo.",
  version_conflict: "O registro mudou. Atualize e tente novamente.",
  idempotency_conflict: "Esta chave já identifica outro comando.",
  customer_required: "Complete e confirme o cliente no cadastro único.",
  customer_promotion_required: "A promoção cadastral precisa de uma pessoa autorizada.",
  category_required: "Configure uma categoria de receita válida.",
  warehouse_required: "Configure um depósito válido.",
  settlement_account_required: "Configure uma conta de baixa ativa.",
  default_inactive: "O padrão comercial não está ativo.",
  total_mismatch: "Os valores comerciais não conferem.",
  stock_unavailable: "Confira o saldo, os lotes e as quantidades no estoque.",
  part_disabled: "Esta parte está desligada.",
  epoch_closed: "A época deste comando foi encerrada.",
  erp_parts_unavailable: "Estado das partes indisponível.",
  waiting_manual: "Aguardando lançamento manual.",
  historical_origin_unlinked: "A obrigação anterior não possui vínculo no ERP.",
  forbidden: "Acesso não permitido.",
  not_found: "Registro não encontrado.",
  invalid_request: "Dados comerciais inválidos.",
  integration_unavailable: "Integração temporariamente indisponível.",
  integration_divergent: "ERP e fila divergentes (restauração?)",
  replacement_successors: "Há eventos seguintes nesta origem. A correção precisa de revisão manual antes de encerrar o comando.",
  correction_in_progress: "Uma correção está reservada para esta origem. Retome a mesma solicitação.",
  automation_off: "A automação estava desligada neste fato. Aguardando lançamento manual.",
  integration_uncertain: "Envio sem confirmação. Aguardando conferência do mesmo comando no ERP.",
  lease_lost: "Outra execução está tratando este comando.",
};
export class IntegrationError extends ApiError {
  constructor(code: string, status = 422) { super(status, code, messages[code] ?? "A operação comercial não pôde ser concluída."); }
}
/** Nunca transporta mensagens de SQL, provedor ou exceção bruta. */
export function sanitizedError(error: unknown): IntegrationError {
  const status = error instanceof ApiError ? error.status : 503;
  const code = error instanceof ApiError && Object.hasOwn(messages, error.code) ? error.code
    : status === 403 ? "forbidden" : status === 409 ? "version_conflict" : status < 500 && status !== 429 ? "invalid_request" : "integration_unavailable";
  return new IntegrationError(code, status);
}
export function logIntegrationError(error: unknown): void {
  const safe = sanitizedError(error);
  console.error(JSON.stringify({ component: "module-integration", code: safe.code }));
}
export const fail = (code = "invalid_request", status = 400): never => { throw new IntegrationError(code, status); };
export const integer = (v: unknown, min = 0): number => typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : fail();
export const opaque = (v: unknown): string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : fail();
export function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail();
}
export function validateSource(source: SourceRef): void {
  exactKeys(source, ["profile", "module", "source_id", "component"]);
  for (const value of Object.values(source)) opaque(value);
  if (!["os", "pedido", "mesas", "entrega", "mensalidade", "agenda", "reserva", "suporte"].includes(source.module)) fail();
}
const date = (v: string) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail();
};
const nullableText = (v: unknown) => { if (v !== null) opaque(v); };
export function validateSnapshot(s: CommercialSnapshot): void {
  exactKeys(s, ["schema", "source", "source_revision", "contact_id", "customer_ref", "privacy", "description", "issued_on", "items", "total_cents", "freight_cents", "discount_cents", "installments", "policy_version", "lifecycle", "technical"]);
  if (s.schema !== 1 || !["commercial", "adult_payer_only"].includes(s.privacy)) fail();
  validateSource(s.source); integer(s.source_revision, 1); integer(s.policy_version, 1);
  nullableText(s.contact_id); nullableText(s.customer_ref); opaque(s.description); date(s.issued_on);
  integer(s.total_cents); integer(s.freight_cents); integer(s.discount_cents);
  if (!Array.isArray(s.items) || !Array.isArray(s.installments) || s.items.length > 500 || s.installments.length > 120) fail();
  let subtotal = 0n;
  const ids = new Set<string>();
  for (const item of s.items) {
    exactKeys(item, ["id", "description", "quantity", "unit_cents", "unit", "kind", "product_id"]);
    opaque(item.id); opaque(item.description); opaque(item.unit); nullableText(item.product_id);
    if (ids.has(item.id) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.id)) fail();
    ids.add(item.id); integer(item.unit_cents);
    if (!["material", "service", "free"].includes(item.kind) || !/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(item.quantity) || item.quantity.length > 24) fail();
    const [whole, frac = ""] = item.quantity.split(".");
    const scale = 10n ** BigInt(frac.length), units = BigInt(whole + frac);
    if (!units) fail();
    // Arredondamento por linha em centavos, metade para cima, sem float.
    subtotal += (units * BigInt(item.unit_cents) + scale / 2n) / scale;
  }
  if (s.items.length && subtotal + BigInt(s.freight_cents) - BigInt(s.discount_cents) !== BigInt(s.total_cents)) fail("total_mismatch", 422);
  const keys = new Set<string>();
  let total = 0n;
  for (const installment of s.installments) {
    exactKeys(installment, ["key", "due_on", "amount_cents", "payment_method_id"]);
    opaque(installment.key); date(installment.due_on); integer(installment.amount_cents, 1); nullableText(installment.payment_method_id);
    if (keys.has(installment.key)) fail();
    keys.add(installment.key); total += BigInt(installment.amount_cents);
  }
  if (s.installments.length && total !== BigInt(s.total_cents)) fail("total_mismatch", 422);
  exactKeys(s.lifecycle, ["base_status", "stage_id", "quote_version", "authorization", "authorized_at", "first_execution_at", "delivered_at", "warranty_until"]);
  opaque(s.lifecycle.base_status); nullableText(s.lifecycle.stage_id);
  if (![null, "approved_quote", "fixed_price"].includes(s.lifecycle.authorization)) fail();
  for (const k of ["quote_version", "authorized_at", "first_execution_at", "delivered_at", "warranty_until"] as const) if (s.lifecycle[k] !== null) integer(s.lifecycle[k]);
  if (s.technical !== null) {
    exactKeys(s.technical, ["equipment", "serial_number", "technician", "defect", "solution"]);
    for (const v of Object.values(s.technical)) nullableText(v);
  }
  // A projeção sensível deve chegar genérica ANTES da fila. Não mascaramos
  // silenciosamente conteúdo que poderia ter sido persistido pelo produtor.
  if (s.privacy === "adult_payer_only" && (s.technical !== null || s.description !== "Serviço contratado" || s.items.some(i => i.description !== "Serviço contratado"))) fail();
}
export function validateEvent(e: IntegrationEvent): void {
  exactKeys(e, ["id", "command_id", "event_key", "source", "seq", "source_revision", "operation", "occurred_ms", "epochs", "eligible", "snapshot", "receipt_key", "reverses_receipt_key", "reason_code", "actor_id"]);
  validateSource(e.source); if (e.seq !== null) integer(e.seq, 1); integer(e.source_revision, 1); integer(e.occurred_ms);
  opaque(e.id); opaque(e.event_key); nullableText(e.receipt_key); nullableText(e.reverses_receipt_key); nullableText(e.actor_id);
  if (e.reason_code !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(e.reason_code)) fail();
  if (e.seq === null ? Object.values(e.eligible).some(Boolean) || e.command_id !== localEventId(e.source, e.event_key) || e.id !== e.command_id : e.command_id !== commandId(e.source, e.seq)) fail();
  if (!["prepare", "recognize", "execute", "lifecycle", "receive", "cancel", "reverse"].includes(e.operation)) fail();
  exactKeys(e.eligible, ["document", "stock", "finance"]);
  if ([e.eligible.document, e.eligible.stock, e.eligible.finance].some(v => typeof v !== "boolean")) fail();
  exactKeys(e.epochs, [e.source.module, "erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"]);
  Object.values(e.epochs).forEach(v => integer(v, 1));
  validateSnapshot(e.snapshot);
  if (canonical(e.source) !== canonical(e.snapshot.source) || e.source_revision !== e.snapshot.source_revision) fail();
}
export function validateResult(result: IntegrationResult, command: string, seq: number): IntegrationResult {
  exactKeys(result, ["command_id", "replayed", "seq", "outcome", "links", "effects", "reason_code"]);
  if (result.command_id !== command || result.seq !== seq || typeof result.replayed !== "boolean" || !["applied", "skipped", "closed"].includes(result.outcome) || !Array.isArray(result.links)) fail("integration_unavailable", 503);
  for (const link of result.links) {
    exactKeys(link, ["slot", "kind", "id", "version"]); opaque(link.slot); opaque(link.id);
    if (!["document", "title", "settlement", "stock_posting"].includes(link.kind)) fail();
    if (link.version !== null) integer(link.version, 1);
  }
  exactKeys(result.effects, ["stock", "finance"]);
  if (!["posted", "reversed", "skipped", "not_requested"].includes(result.effects.stock) || !["posted", "settled", "reversed", "skipped", "not_requested"].includes(result.effects.finance)) fail();
  if (result.reason_code !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(result.reason_code)) fail();
  return result;
}
