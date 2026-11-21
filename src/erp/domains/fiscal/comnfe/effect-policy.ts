/** Hooks estreitos da fatia comercial. Este helper só lê o motor e não importa
 * Documentos, Estoque ou Financeiro, que o chamam (nem registra RPCs).
 *
 * Encaixes para a fase 3: deferredCom1Effect nos automatismos, requireCom1Posting
 * após replay e antes de lançar, guardCom1CommercialSave antes da gravação e
 * guardCom1Transition antes de compensar/mudar situação. O adiamento "só na
 * autorização" se aplica apenas a sales_orders do próprio ERP. As notas da
 * ordem de serviço (NFS-e e NF-e das peças, documento service_orders vindo da
 * fase 3) nunca lançam efeitos (effects.ts): com nota vigente, os estornos
 * diretos do documento recusam como os do pedido; cancelar a nota não desfaz
 * a ordem nem os lançamentos dela.
 */
import { one } from "../../../engine/driver.ts";
import { targetOrigin } from "../../../engine/module-origin.ts";
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
  // "Só na autorização" vale para pedidos de venda do próprio ERP. Fato vindo
  // de módulo (Pedido, Mesas, Entrega...) ainda não emite NF-e por aqui e é
  // venda já acontecida: segue a automação e a intenção manual da fase 3.
  if (targetOrigin(ctx.db, "document", documentId)) return null;
  const settings = one(ctx.db, "SELECT stock_timing,finance_timing FROM erp_fiscal_vault__commercial_settings WHERE id=1");
  if (settings?.[`${axis}_timing`] !== "on_authorization") return null;
  // A NFC-e do balcão (counter_emission) autoriza o mesmo pedido que a NF-e.
  const authorized = [ORDER_EMISSION, COUNTER_EMISSION].some(table => one(ctx.db, `SELECT status FROM ${table}
    WHERE document_id=? ORDER BY fiscal_version DESC LIMIT 1`, documentId)?.status === "autorizada");
  return authorized ? null : { outcome: "deferred", reason: "awaiting_fiscal_authorization" };
}

/** Motivo gravado nos efeitos das notas de documento vindo de módulo (ordem
 * de serviço): estoque e financeiro são os da fase 3, nunca da nota. */
export const COM1_MODULE_EFFECTS = "module_origin_effects";
/** O documento veio de um módulo (fase 3): a nota não lança nem estorna. */
export const com1ModuleDocument = (ctx: RpcContext, documentId: string): boolean => !!targetOrigin(ctx.db, "document", documentId);

/** Somente caminhos de postagem; replay permanece anterior à guarda. */
export function requireCom1Posting(ctx: RpcContext, documentId: string | null, axis: EffectAxis): void {
  if (deferredCom1Effect(ctx, documentId, axis)) raise("40001", "awaiting_fiscal_authorization");
}

const ORDER_EMISSION = "erp_fiscal_vault__order_emission", COUNTER_EMISSION = "erp_fiscal_vault__counter_emission";
/** Nota de serviço (NFS-e) da ordem: trava os estornos diretos como as outras. */
const SERVICE_EMISSION = "erp_fiscal_vault__service_emission";
/** Famílias de tabelas da máquina (NF-e, NFC-e do balcão, NFS-e da ordem). */
const FAMILIES = ["order", "counter", "service"] as const;
/** Emissão vigente do pedido em qualquer modelo (NF-e, NFC-e do balcão ou NFS-e da ordem). */
const protectedEmission = (ctx: RpcContext, documentId: string) => [ORDER_EMISSION, COUNTER_EMISSION, SERVICE_EMISSION].map(table => one(ctx.db, `SELECT id,status FROM ${table}
  WHERE document_id=? AND status IN ('enviando','processando','incerta','autorizada') ORDER BY fiscal_version DESC LIMIT 1`, documentId)).find(row => row) ?? null;

/** O pedido tem nota vigente ou em andamento (NF-e ou NFC-e): o cancelamento
 * comercial direto não substitui o cancelamento fiscal (PDV, sale_cancel). */
export const com1EmissionInForce = (ctx: RpcContext, documentId: string): boolean => !!protectedEmission(ctx, documentId);

/** Capacidade só da compensação Com1 (effects.ts), que já conferiu
 * cancelamento, responsabilidade pelo lançamento e retorno físico. Vale só
 * durante a pilha síncrona e só para o pedido indicado. */
const compensation = new WeakMap<RpcContext, string>();
export function withCom1Compensation<T>(ctx: RpcContext, documentId: string, run: () => T): T {
  if (compensation.has(ctx)) raise("42501", "erp_maintenance_scope_denied");
  compensation.set(ctx, documentId);
  try { return run(); } finally { compensation.delete(ctx); }
}

/** Compensação da nota que ainda responde pelo lançamento ativo do pedido:
 * emissão cancelada cujo efeito no eixo aponta para um lançamento ativo
 * (próprio ou de nota legada) e não foi revertido nem transferido para outra
 * versão. Compensação concluída ou transferida não trava nada. Faturamento
 * agrupado não entra: a compensação da nota manda revisá-lo manualmente. */
function openCompensation(ctx: RpcContext, documentId: string, axis: EffectAxis): boolean {
  const active = new Set(ctx.db.exec(`SELECT id FROM erp_${axis}__document_posting WHERE document_id=? AND state='active'
    UNION SELECT p.id FROM erp_${axis}__invoice_posting p JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=p.invoice_id
      WHERE o.document_id=? AND p.state='active'`, documentId, documentId).rows.map(row => String(row.id)));
  if (!active.size) return false;
  return FAMILIES.flatMap(family => ctx.db.exec(`SELECT json_extract(f.ids,'$.posting_id') AS posting_id,f.compensation_state,
      json_extract(f.compensation_result,'$.reason') AS reason FROM erp_fiscal_vault__${family}_effect f
    JOIN erp_fiscal_vault__${family}_emission e ON e.id=f.emission_id
    WHERE e.document_id=? AND e.status='cancelada' AND f.axis=? AND f.fingerprint IS NOT NULL
      AND COALESCE(f.compensation_state,'')<>'revertido'
      AND COALESCE(json_extract(f.compensation_result,'$.state'),'')<>'transferido'`, documentId, axis).rows)
    .some(row => active.has(String(row.posting_id)) &&
      !(axis === "finance" && row.compensation_state === "compensacao_pendente" && FINANCE_MANUAL_REVIEW.has(String(row.reason))));
}
/** Títulos podem ser editados depois do lançamento (vencimento, conta): a
 * compensação financeira então manda conferir na área, e o estorno direto é
 * a saída, que não pode ficar travada. O estoque não muda depois de lançado e
 * continua exigindo a compensação com retorno físico. */
const FINANCE_MANUAL_REVIEW = new Set(["com1_effect_reconciliation_required", "com1_effect_finance_content_mismatch",
  "com1_effect_multiple_origins", "com1_effect_legacy_grouped"]);

/** Desligar a parte Fiscal não desfaz a nota nem dispensa a compensação, mas
 * a compensação só roda com a Fiscal ligada: a recusa diz o que fazer. */
export const FISCAL_PART_REQUIRED = "fiscal_compensation_requires_fiscal_part";
export const FISCAL_PART_REQUIRED_MESSAGE = "Ligue a parte Fiscal para compensar a nota cancelada deste pedido (ou concluir a emissão em andamento). Desligar a Fiscal não desfaz a nota.";

export const COM1_REVERSE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  fiscal_order_effect_locked: "A NF-e deste pedido está vigente ou em andamento: cancele a nota e use a compensação dela.",
  fiscal_order_compensation_required: "A NF-e cancelada deste pedido ainda responde por este lançamento: conclua a compensação da nota.",
  [FISCAL_PART_REQUIRED]: FISCAL_PART_REQUIRED_MESSAGE,
});

/** Motivo da recusa do estorno direto (null quando permitido). A inspeção de
 * manutenção usa o mesmo motivo para não oferecer estorno que vai falhar. */
export function com1DirectReverseBlocker(ctx: RpcContext, documentId: unknown, axis: EffectAxis): string | null {
  if (typeof documentId !== "string" || compensation.get(ctx) === documentId) return null;
  const code = protectedEmission(ctx, documentId) ? "fiscal_order_effect_locked"
    : openCompensation(ctx, documentId, axis) ? "fiscal_order_compensation_required" : null;
  return code && !ctx.parts.fiscal ? FISCAL_PART_REQUIRED : code;
}

/** Estorno ou cancelamento direto de um efeito do pedido (estoque, títulos,
 * nota legada vinculada). Com emissão vigente, o caminho é a compensação da
 * nota depois do cancelamento fiscal; depois dele, enquanto a compensação de
 * uma emissão cancelada responder pelo lançamento ativo, só ela o estorna
 * (o estoque com a confirmação de retorno físico). Não depende de partes:
 * com a Fiscal desligada a recusa pede para religá-la.
 * Chamar após o replay e antes de alterar dados. */
export function guardCom1DirectReverse(ctx: RpcContext, documentId: unknown, axis: EffectAxis): void {
  const code = com1DirectReverseBlocker(ctx, documentId, axis);
  if (code) raise("40001", code);
}
/** Mesma guarda para a nota legada: alcança os pedidos vinculados a ela. */
export function guardCom1InvoiceReverse(ctx: RpcContext, invoiceId: unknown, axis: EffectAxis): void {
  if (typeof invoiceId !== "string") return;
  for (const row of ctx.db.exec("SELECT document_id FROM erp_fiscal_invoices__invoice_order WHERE invoice_id=?", invoiceId.toLowerCase()).rows)
    guardCom1DirectReverse(ctx, row.document_id, axis);
}
/** Ponto único de cancelamento de título: o pedido de origem (lançamento do
 * pedido, nota legada ou faturamento agrupado ativo) recebe a mesma guarda. */
export function guardCom1TitleCancel(ctx: RpcContext, titleId: string): void {
  const rows = ctx.db.exec(`SELECT p.document_id FROM erp_finance__document_title t JOIN erp_finance__document_posting p ON p.id=t.posting_id WHERE t.title_id=?
    UNION SELECT o.document_id FROM erp_finance__invoice_title t JOIN erp_finance__invoice_posting p ON p.id=t.posting_id
      JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=p.invoice_id WHERE t.title_id=?
    UNION SELECT g.document_id FROM erp_finance__grouped_billing_title t JOIN erp_finance__grouped_billing_document g ON g.billing_id=t.billing_id AND g.active=1 WHERE t.title_id=?
    UNION SELECT o.document_id FROM erp_finance__grouped_billing_title t JOIN erp_finance__grouped_billing_invoice g ON g.billing_id=t.billing_id AND g.active=1
      JOIN erp_fiscal_invoices__invoice_order o ON o.invoice_id=g.invoice_id WHERE t.title_id=?`, titleId, titleId, titleId, titleId).rows;
  // Título a título só a nota vigente trava: depois do cancelamento fiscal é
  // por aqui a revisão manual que a compensação pede (faturamento agrupado,
  // boleto baixado no banco).
  for (const row of rows)
    if (typeof row.document_id === "string" && compensation.get(ctx) !== row.document_id && protectedEmission(ctx, row.document_id))
      raise("40001", ctx.parts.fiscal ? "fiscal_order_effect_locked" : FISCAL_PART_REQUIRED);
}

/** Observações públicas compõem informacoesComplementares no PedidoNfe.
 * Anotações internas não são enviadas ao cofre e continuam operacionais. */
export function guardCom1NotesSave(ctx: RpcContext, documentId: string, currentNotes: string | null, nextNotes: string | null): void {
  if (currentNotes !== nextNotes && protectedEmission(ctx, documentId)) raise("40001", "fiscal_order_commercial_locked");
}

/** A lixeira não pode ocultar um pedido com emissão enviada ou histórica,
 * inclusive quando Estoque/Financeiro foram pulados. Não depende de partes. */
export function com1TrashBlocker(ctx: RpcContext, documentId: string): "invoice_linked" | null {
  return FAMILIES.some(family => one(ctx.db, `SELECT 1 FROM erp_fiscal_vault__${family}_emission e WHERE e.document_id=? AND
    (e.status NOT IN ('bloqueada','preparada','arquivada') OR e.provider_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM erp_fiscal_vault__${family}_command c WHERE c.emission_id=e.id
      AND c.action IN ('emit','resume') AND c.token IS NOT NULL)) LIMIT 1`, documentId)) ? "invoice_linked" : null;
}

// Não são campos fiscais/comerciais: IDs e versões de leitura, saldos técnicos,
// seleção de depósito/lote e classificação/conta local para resolver pendências.
const technicalFields = new Set([
  "id", "kind", "number", "version", "status", "created_at", "updated_at", "created_by", "updated_by",
  "effect_flags", "contact_snapshot", "source_proposal_id", "origin", "authority", "readonly", "unavailable_parts",
  "warehouse_id", "category_id", "payment_account_id", "internal_notes",
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
  // Mesmo critério do estorno direto: só trava a compensação aberta que
  // responde pelo lançamento ativo.
  for (const action of reverses)
    if (openCompensation(ctx, documentId, action === "reverse_stock" ? "stock" : "finance"))
      raise("40001", ctx.parts.fiscal ? "fiscal_order_compensation_required" : FISCAL_PART_REQUIRED);
}
