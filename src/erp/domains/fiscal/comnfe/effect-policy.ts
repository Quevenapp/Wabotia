/** Hooks estreitos da fatia comercial. Este helper só lê o motor e não importa
 * Documentos, Estoque ou Financeiro, que o chamam (nem registra RPCs).
 *
 * Encaixes para a fase 3: deferredCom1Effect nos automatismos, requireCom1Posting
 * após replay e antes de lançar, guardCom1CommercialSave antes da gravação e
 * guardCom1Transition antes de compensar/mudar situação. A política desta fatia
 * se aplica apenas a sales_orders; OS/NFS-e exigem política e vínculo próprios.
 */
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import type { EffectAxis } from "../../../commercial-nfe/contracts.ts";

type Data = Record<string, unknown>;
export interface DeferredCom1Effect {
  outcome: "deferred";
  reason: "awaiting_fiscal_authorization";
}

/** A política por área alcança também o pedido ainda não preparado: exigir um
 * vínculo prévio permitiria lançar antes de preparar uma nota bloqueada.
 * Existing (inclusive configuração ausente) e Fiscal desligada preservam o
 * comportamento comercial anterior. Reservar não passa por este hook.
 */
export function deferredCom1Effect(ctx: RpcContext, documentId: string | null, axis: EffectAxis): DeferredCom1Effect | null {
  if (!ctx.parts.fiscal || !documentId) return null;
  const document = one(ctx.db, "SELECT kind FROM erp_documents__document WHERE id=?", documentId);
  if (document?.kind !== "sales_orders") return null;
  const settings = one(ctx.db, "SELECT stock_timing,finance_timing FROM erp_fiscal_vault__commercial_settings WHERE id=1");
  if (settings?.[`${axis}_timing`] !== "on_authorization") return null;
  const emission = one(ctx.db, `SELECT status FROM erp_fiscal_vault__order_emission
    WHERE document_id=? ORDER BY fiscal_version DESC LIMIT 1`, documentId);
  return emission?.status === "autorizada" ? null : { outcome: "deferred", reason: "awaiting_fiscal_authorization" };
}

/** Somente caminhos de postagem; replay permanece anterior à guarda. */
export function requireCom1Posting(ctx: RpcContext, documentId: string | null, axis: EffectAxis): void {
  if (deferredCom1Effect(ctx, documentId, axis)) raise("40001", "awaiting_fiscal_authorization");
}

const protectedEmission = (ctx: RpcContext, documentId: string) => one(ctx.db, `SELECT id,status FROM erp_fiscal_vault__order_emission
  WHERE document_id=? AND status IN ('enviando','processando','incerta','autorizada') ORDER BY fiscal_version DESC LIMIT 1`, documentId);

// Não são campos fiscais/comerciais: IDs e versões de leitura, saldos técnicos,
// seleção de depósito/lote e classificação/conta local para resolver pendências.
const technicalFields = new Set([
  "id", "kind", "number", "version", "status", "created_at", "updated_at", "created_by", "updated_by",
  "effect_flags", "contact_snapshot", "source_proposal_id", "origin", "authority", "readonly", "unavailable_parts",
  "warehouse_id", "category_id", "payment_account_id",
]);
const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
/** Exportado para conferência de conteúdo, sem versão técnica ou dados de UI. */
export function com1CommercialContent(value: Data): string {
  const result: Data = {};
  for (const [key, field] of Object.entries(value)) {
    if (technicalFields.has(key)) continue;
    result[key] = key === "items" && Array.isArray(field) ? field.map(item => object(item)
      ? Object.fromEntries(Object.entries(item).filter(([name]) => !["product_snapshot", "lots"].includes(name))) : item) : field;
  }
  return JSON.stringify(canonical(result));
}

/** Só uma alteração comercial é bloqueada: bumps dos efeitos nem passam aqui.
 * Ler o corpo bruto evita apagar campos ocultados pela projeção de partes.
 */
export function guardCom1CommercialSave(ctx: RpcContext, documentId: string, next: Data,
  options: { refreshContact?: boolean; numberChanged?: boolean } = {}): void {
  if (!protectedEmission(ctx, documentId)) return;
  const row = one(ctx.db, "SELECT body FROM erp_documents__document WHERE id=?", documentId);
  if (!row) return;
  const current = {
    ...JSON.parse(String(row.body)),
    items: ctx.db.exec("SELECT data FROM erp_documents__item WHERE document_id=? ORDER BY position", documentId).rows.map(item => JSON.parse(String(item.data))),
  } as Data;
  if (options.refreshContact || options.numberChanged || com1CommercialContent(current) !== com1CommercialContent(next))
    raise("40001", "fiscal_order_commercial_locked");
}

/** A guarda independe da ativação Fiscal: desligar não desfaz nota enviada.
 * Após cancelar no cofre, a compensação tem de ser tratada pelo seu comando,
 * inclusive confirmação física; transição comercial não substitui essa prova.
 */
export function guardCom1Transition(ctx: RpcContext, documentId: string, toStatus: string | null, actions: readonly string[] = []): void {
  const reverses = actions.filter(action => action === "reverse_stock" || action === "reverse_finance");
  if (protectedEmission(ctx, documentId)) {
    if (toStatus === "cancelled" || toStatus === "draft" || reverses.length) raise("40001", "fiscal_order_transition_locked");
    return;
  }
  if (!reverses.length) return;
  const cancelled = one(ctx.db, `SELECT id FROM erp_fiscal_vault__order_emission
    WHERE document_id=? AND status='cancelada' ORDER BY fiscal_version DESC LIMIT 1`, documentId);
  if (!cancelled) return;
  for (const action of reverses) {
    const axis = action === "reverse_stock" ? "stock" : "finance";
    const active = one(ctx.db, `SELECT 1 FROM erp_${axis}__document_posting WHERE document_id=? AND state='active' LIMIT 1`, documentId);
    if (active) raise("40001", "fiscal_order_compensation_required");
  }
}
