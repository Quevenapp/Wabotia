import { one } from "../../../db";
import { ApiError, json } from "../../../types";
import type { ModuleContext } from "../../api";
import type { IntegrationEvent, IntegrationOperation, Statement } from "../../../integrations/contracts";
import { aliasStatements, commandId, ensureCommercialPolicy, eventKey, integrationStatements, readIntegrationActivation } from "../../../integrations/ports";
import { canonical, hash } from "../../../integrations/keys";
import { commercialFingerprint, commercialOf, projectWork, readWorkIntegration, saoPauloDate, stableQuoteItems, workPrivacy, workSource, type WorkCatalogChange } from "./projection";
import { mutationHistory, publishMutation } from "../mutations";

const relevant = new Set(["status", "stage", "quote_items", "quote_total_cents", "quote_version", "quote_valid_until", "quote_valid_days", "decision", "stage_approval_json", "commercial_json", "customer_name", "phone", "contact_id", "conversation_id", "item", "problem", "assignee", "due_at", "delivered_at", "warranty_until"]);
const protectedFields = ["quote_items", "quote_total_cents", "quote_valid_days", "customer_name", "phone", "contact_id", "conversation_id", "item", "problem", "assignee", "due_at"];
const conflict = () => new ApiError(409, "idempotency_conflict", "Esta chave já identifica outro comando.");
export async function replayWorkWrite(ctx: ModuleContext, row: any, key: string | undefined, intent: unknown) {
  if (!key) return null;
  const receipt = await one(ctx.env, "SELECT fingerprint FROM receipts WHERE scope=? AND key=?", `os-commercial:${ctx.profile}:${row.id}`, key);
  if (!receipt) return null;
  if (receipt.fingerprint !== hash(intent)) throw conflict();
  const history = await mutationHistory(ctx, key);
  if (history?.order_id === row.id) await publishMutation(ctx, history);
  return one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, row.id);
}
export function workWriteReceipt(ctx: ModuleContext, row: any, key: string | undefined, intent: unknown, at: number): Statement[] {
  return key ? [["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [`os-commercial:${ctx.profile}:${row.id}`, key, hash(intent), canonical({ id: row.id, version: (row.row_version ?? 1) + 1 }), at]]] : [];
}
export function requireCommercialReason(note: string) {
  if (!note.trim()) throw new ApiError(422, "reason_required", "Informe o motivo da mudança comercial.");
}
/** Só monta SQL. Nenhuma chamada ao ERP: o chamador junta o plano ao lote nativo. */
export async function prepareWorkMutation(ctx: ModuleContext, row: any, input: Record<string, unknown>, actor: string, at: number, note = "", opening = false, catalogChange?: WorkCatalogChange) {
  const sets = { ...input };
  if (!opening && !Object.keys(sets).some(k => relevant.has(k))) return { sets, statements: [] as Statement[], note };
  const integration = await readWorkIntegration(ctx, row);
  const current = commercialOf(row), local = { ...current, ...json(sets.commercial_json, {}) };
  const privacy = await workPrivacy(ctx, row);
  const sensitive = privacy === "adult_payer_only";
  local.schema = 1; local.privacy = privacy;
  const next: any = { ...row, ...sets };
  if (sets.quote_items !== undefined) {
    const normalized = stableQuoteItems(row, JSON.parse(String(sets.quote_items)));
    // Vínculos ficam exclusivamente na tabela auxiliar. Uma indicação no
    // orçamento só confirma um vínculo explícito já validado pela rota comum.
    for (const item of normalized) if (item.product_id != null) {
      const saved = await one(ctx.env, "SELECT erp_item_id FROM module_erp_catalog_links WHERE profile_id=? AND module_id='os' AND record_kind='quote_item' AND record_id=? AND component=?", ctx.profile, row.id, item.id);
      if (saved?.erp_item_id !== item.product_id) throw new ApiError(409, "catalog_link_required", "Associe o item ao catálogo antes de confirmar o vínculo.");
    }
    sets.quote_items = next.quote_items = JSON.stringify(normalized.map(({ product_id: _, ...i }) => i));
    if (!json(sets.commercial_json, {}).authorization) local.authorization = null;
    if (current.installments?.length && sets.commercial_json === undefined && next.quote_total_cents !== row.quote_total_cents) local.installments = [];
  }
  if (integration.frozen) {
    const changed = protectedFields.some(k => sets[k] !== undefined && canonical(sets[k]) !== canonical(row[k] ?? null));
    const configChanged = ["customer_ref", "adult_payer_confirmed", "installments", "technical"].some(k =>
      canonical((local as any)[k] ?? null) !== canonical((current as any)[k] ?? null));
    if (changed || configChanged || catalogChange) throw new ApiError(409, "commercial_frozen", "O documento possui efeitos confirmados ou em envio. Os dados comerciais estão congelados.");
  }
  // Detecta execução anterior inclusive em registros legados ainda sem JSON.
  if (!current.first_execution_at && !opening) {
    const old = await one(ctx.env, "SELECT MIN(created) first_at FROM os_history WHERE profile_id=? AND order_id=? AND to_status='in_progress'", ctx.profile, row.id);
    if (old?.first_at != null || ["in_progress", "ready", "delivered"].includes(row.status) && row.decision !== "declined") {
      local.first_execution_at = old?.first_at ?? row.ready_at ?? row.delivered_at ?? row.updated;
      local.historical_execution = true;
    }
  }
  next.commercial_json = JSON.stringify(local);
  const fingerprint = commercialFingerprint(next);
  // Aprovação antiga é aceita apenas se precedeu a validade da versão atual.
  if (!local.authorization && next.decision === "approved" && next.quote_version > 0 && next.decided_at >= next.quote_sent_at && next.decided_at < next.quote_valid_until) {
    local.authorization = { kind: "approved_quote", quote_version: next.quote_version, at: next.decided_at,
      actor_id: sensitive || !/^[0-9a-f-]{36}$/i.test(next.decided_by ?? "") ? null : next.decided_by,
      channel: ["whatsapp", "panel", "api"].includes(next.decided_via) ? next.decided_via : "api", content_hash: fingerprint };
  }
  if (sets.quote_version !== undefined || next.decision === "declined" || local.authorization && (local.authorization.quote_version !== (next.quote_version ?? 0) || local.authorization.content_hash !== fingerprint)) local.authorization = null;
  const state = await readIntegrationActivation(ctx.env, ctx.profile, "os");
  const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
  const parts = state.snapshot.parts;
  const occurred = Math.max(at, ...Object.values(state.activations).map(a => a.updated_ms));
  const live = state.states.os && parts.customers;
  const integrated = live && (parts.sales || parts.stock || parts.finance) || integration.linked || integration.frozen;
  const regressing = (row.status === "ready" && next.status === "in_progress") || (["quoted", "approved", "declined"].includes(row.status) && next.status === "analyzing");
  if (integrated && (next.status === "cancelled" && row.status !== "cancelled" || regressing)) requireCommercialReason(note);
  const firstExecution = next.status === "in_progress" && !local.first_execution_at;
  const hasContent = !!next.quote_items;
  if (firstExecution) {
    if (hasContent && !local.authorization) throw new ApiError(422, "commercial_authorization_required", "Aprove a versão atual do orçamento ou autorize expressamente o preço fixo.");
    local.first_execution_at = occurred; // Inclusive sem ERP e em trabalho sem preço.
    local.historical_execution = false;
    if (local.installments?.length && local.installments[0].due_on !== saoPauloDate(at))
      throw new ApiError(422, "installment_trigger_date", "A primeira parcela deve vencer na data de início da execução.");
  }
  let operation: IntegrationOperation = opening || sets.quote_items !== undefined || sets.commercial_json !== undefined || ["customer_name", "phone", "item", "problem", "due_at"].some(k => k in sets) ? "prepare" : "lifecycle";
  if (firstExecution && local.authorization) operation = "execute";
  if (next.status === "cancelled" && row.status !== "cancelled") operation = "cancel";
  const pendingDocument = integration.events.some(e => JSON.parse(e.payload_json).eligible.document);
  const historicalUnlinked = !!local.first_execution_at && !firstExecution && !integration.linked && !pendingDocument;
  const canDocument = !historicalUnlinked && hasContent && live && (parts.sales || parts.stock || parts.finance);
  const maintenance = operation === "cancel" && (integration.linked || pendingDocument);
  const eligible = {
    document: !!(canDocument || maintenance),
    stock: !!(operation === "execute" && live && parts.stock && parts.products || maintenance && (integration.active.stock || integration.events.some(e => JSON.parse(e.payload_json).eligible.stock))),
    finance: !!(operation === "execute" && live && parts.finance || maintenance && (integration.active.finance || integration.events.some(e => JSON.parse(e.payload_json).eligible.finance))),
  };
  if (operation === "cancel") local.cancellation_pending = !!(maintenance || integration.frozen);
  sets.commercial_json = next.commercial_json = JSON.stringify(local);
  const source = workSource(ctx.profile, row.id), revision = (integration.source?.revision ?? 0) + 1, seq = (integration.source?.enqueued_seq ?? 0) + 1;
  const snapshot = await projectWork(ctx, next, revision, { integration, privacy, policy, products: parts.products, catalogChange });
  const event: IntegrationEvent = { id: commandId(source, seq), command_id: commandId(source, seq), event_key: eventKey(source, operation, revision),
    source, seq, source_revision: revision, operation, occurred_ms: occurred,
    epochs: state.epochs, eligible, snapshot, receipt_key: null, reverses_receipt_key: null,
    reason_code: operation === "cancel" ? "work_cancelled" : regressing ? "work_regression" : null,
    actor_id: /^[0-9a-f-]{36}$/i.test(actor) ? actor : null };
  const statements: Statement[] = [
    // Nenhuma confirmação concorrente pode passar entre a comparação e o lote.
    [`SELECT CASE WHEN COALESCE((SELECT applied_seq FROM module_erp_sources WHERE profile_id=? AND module_id='os' AND source_id=?),0)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN module_erp_activation a ON a.profile_id=? AND a.module_id=j.key WHERE a.epoch IS NULL OR a.epoch<>j.value)
      AND (SELECT version FROM module_erp_policy WHERE profile_id=?)=? THEN 1 ELSE json('os_version_conflict') END`,
      [ctx.profile, row.id, integration.source?.applied_seq ?? 0, canonical(state.epochs), ctx.profile, ctx.profile, policy.version]],
    ...(parts.products && !integration.frozen ? [[`SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM json_each(?) i LEFT JOIN module_erp_catalog_links l ON l.profile_id=? AND l.module_id='os'
        AND l.record_kind='quote_item' AND l.record_id=? AND l.component=json_extract(i.value,'$.id')
      WHERE json_extract(i.value,'$.kind')<>'free' AND l.erp_item_id IS NOT json_extract(i.value,'$.product_id')
    ) THEN 1 ELSE json('os_version_conflict') END`, [canonical(snapshot.items.map(({ id, kind, product_id }) => ({ id, kind, product_id }))), ctx.profile, row.id]]] as Statement[] : []),
    ...integrationStatements({ source, expected_revision: revision - 1, events: [event], next_state: { snapshot } }),
    ...aliasStatements(source, "work", row.id),
  ];
  return { sets, statements, note: sensitive && note ? (operation === "cancel" ? "Cancelamento operacional" : "Atualização operacional") : note };
}
