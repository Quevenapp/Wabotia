// Os gatilhos do Financeiro sobre a nota do Fiscal (pedido da G, F2 do Fiscal), chamados pelo
// erp_fiscal_* no ponto do gatilho, com as linhas na forma do SQLite (SELECT *):
// - finance_posted_invoice (BEFORE UPDATE OR DELETE em invoice): guardFinanceInvoice;
// - finance_invoice_auto_finance (AFTER INSERT em invoice, adiado): invoiceAutoFinance, que põe
//   o lançamento automático da nota de entrada no ctx.defer;
// - finance_invoice_order_effect (AFTER INSERT OR UPDATE em invoice_order, adiado):
//   guardInvoiceOrderEffect, que põe a conferência no ctx.defer.
import { createHash } from "node:crypto";
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { defer, type RpcContext } from "../../engine/registry.ts";
import { requireRpcParts, rpcPartsRequirement } from "../../engine/parts-gate.ts";
import { erpRequirement, erpRequirementMet } from "../../parts.ts";
import * as preferences from "../preferences/public.ts";
import { invoiceBlockedReason, invoiceContact, invoiceEffectActive } from "./invoices.ts";
import { invoicePost, invoicePreviewData } from "./rpc/erp_finance_invoice_finance.ts";

type Row = Record<string, unknown>;
type Op = "INSERT" | "UPDATE" | "DELETE";
const canon = (v: unknown) => (v === null || v === undefined ? "null" : jsonbText(typeof v === "string" ? JSON.parse(v) : v));
const md5Uuid = (text: string) => {
  const h = createHash("md5").update(text, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** erp_finance.guard_finance_invoice: a nota com contas lançadas não muda o que as contas usaram, nem sai. */
export function guardFinanceInvoice(ctx: RpcContext, op: Op, o: Row | null, n: Row | null) {
  if (op === "INSERT" || !o || !invoiceEffectActive(ctx.db, String(o.id))) return;
  if (
    op === "DELETE" ||
    (n!.deleted_at !== null && o.deleted_at === null) ||
    canon(n!.payment) !== canon(o.payment) || canon(n!.totals) !== canon(o.totals) ||
    invoiceContact(n!.recipient) !== invoiceContact(o.recipient) ||
    n!.direction !== o.direction || n!.model !== o.model || n!.issue_date !== o.issue_date
  )
    raise("40001", "erp_fiscal_invoice_active_finance");
}

/**
 * erp_finance.invoice_auto_finance (adiado): a nota de entrada lança as contas a pagar pela
 * preferência nfe.contas_pagar_entrada. Qualquer recusa deixa a nota sem contas
 * (exception when others then null): a tentativa roda num savepoint e é desfeita.
 */
export function invoiceAutoFinance(ctx: RpcContext, op: Op, _o: Row | null, n: Row | null) {
  if (op !== "INSERT" || !n) return;
  if (!erpRequirementMet(ctx.parts, erpRequirement("erp-financeiro", "erp-fiscal"))) return;
  const id = String(n.id);
  const args = { p_invoice_id: id };
  const requirement = rpcPartsRequirement(ctx, "erp_finance_invoice_finance_post", args);
  if (!requirement || requirement === "externo" || !erpRequirementMet(ctx.parts, requirement)) return;
  // A capacidade de manutenção termina antes de drenar os gatilhos adiados.
  // Validar também no agendamento impede usá-la para deixar uma criação futura.
  requireRpcParts(ctx, "erp_finance_invoice_finance_post", args);
  const direction = n.direction;
  defer(ctx, () => {
    const db = ctx.db;
    const requirement = rpcPartsRequirement(ctx, "erp_finance_invoice_finance_post", args);
    if (!requirement || requirement === "externo" || !erpRequirementMet(ctx.parts, requirement)) return;
    if (direction !== "0" || preferences.get(db, "nfe.contas_pagar_entrada") !== true) return;
    const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', id);
    if (!v || v.deleted_at !== null || invoiceBlockedReason(db, v) !== null) return;
    if (!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role IN ('admin','financeiro')`, v.created_by)) return;
    try {
      db.transaction(() => {
        requireRpcParts(ctx, "erp_finance_invoice_finance_post", args);
        const preview = invoicePreviewData(db, v, null, null);
        invoicePost(ctx, String(v.created_by), md5Uuid(`invoice-auto-finance:${id}`), { invoice_id: id, expected_version: v.version, preview_hash: preview.preview_hash }, "automatic");
      });
    } catch {
      // A gravação da nota nunca falha pela automação.
    }
  });
}

/** erp_finance.guard_invoice_order_effect (adiado): o pedido da nota com contas não pode ter contas próprias. */
export function guardInvoiceOrderEffect(ctx: RpcContext, op: Op, _o: Row | null, n: Row | null) {
  if (op === "DELETE" || !n) return;
  const invoice = String(n.invoice_id),
    document = String(n.document_id);
  defer(ctx, () => {
    const db = ctx.db;
    if (
      one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice_order" WHERE invoice_id=? AND document_id=?', invoice, document) &&
      invoiceEffectActive(db, invoice) &&
      (one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, document) ||
        one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', document))
    )
      raise("40001", "erp_finance_invoice_order_posted");
  });
}
