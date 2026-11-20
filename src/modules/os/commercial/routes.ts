import { effectiveSourceState } from "../../../integrations/state";
import { erpRoleOf } from "../../erp/identity";
import { one } from "../../../db";
import { ApiError, type Actor, now } from "../../../types";
import { onCommand, onRead, onRoute, type ModuleContext } from "../../api";
import { registerIntegrationProducer } from "../../../integrations/ports";
import { exactKeys, integer, opaque } from "../../../integrations/privacy";
import { authorizedOrder } from "../public";
import { checkVersion, commitOrderMutation } from "../mutations";
import { quoteTotal, validateQuoteItems } from "../model";
import { commercialFingerprint, commercialOf, documentStatus, getWorkProducer, readWorkIntegration, stableQuoteItems, workPrivacy, type WorkCommercial } from "./projection";
import { replayWorkWrite, workWriteReceipt } from "./mutations";
import type { Statement } from "../../../integrations/contracts";

export function requireCommercialWriter(actor: Actor) {
  if (actor.via || actor.module || actor.credential || actor.id.startsWith("bot:")) throw new ApiError(403, "forbidden", "Dados comerciais exigem autoria explícita da equipe ou de uma aplicação autorizada.");
}
/** O vínculo, o recibo, a revisão da OS e sua projeção são um único lote. */
export async function commitWorkCatalogLink(ctx: ModuleContext, actor: Actor, id: string, component: string, product_id: string | null, statements: Statement[]) {
  requireCommercialWriter(actor);
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  if (["delivered", "cancelled"].includes(row.status)) throw new ApiError(409, "commercial_closed", "Trabalho encerrado.");
  if (!stableQuoteItems(row).some(item => item.id === component)) throw new ApiError(404, "not_found", "Item não encontrado.");
  await commitOrderMutation(ctx, row, { commercial_json: row.commercial_json }, actor.id, "os.updated", ["catalog"], undefined, "", [],
    { change: { component, product_id }, statements });
}
export async function workCommercialView(ctx: ModuleContext, actor: Actor, id: string) {
  const { row } = await authorizedOrder(ctx, actor, id);
  const state = await readWorkIntegration(ctx, row), local = commercialOf(row);
  const pending = state.events.find(e => e.state !== "done");
  const role = erpRoleOf(actor), finance = role === "admin" || role === "financeiro", stock = role === "admin" || role === "estoque";
  const { manual, ...status } = effectiveSourceState(state.events, !!state.source?.replacement_key);
  return { id, version: row.row_version ?? 1, revision: state.source?.revision ?? 0,
    document_status: documentStatus[row.status], frozen: state.frozen,
    privacy: local.privacy ?? "commercial", first_execution_at: local.first_execution_at ?? null,
    authorization: local.authorization ? { kind: local.authorization.kind, quote_version: local.authorization.quote_version, at: local.authorization.at, channel: local.authorization.channel } : null,
    customer_ref: ctx.mayRead(actor, "contacts") ? state.snapshot?.customer_ref ?? null : null,
    items: (state.snapshot?.items ?? []).map(item => finance ? item : (({ unit_cents, ...visible }) => visible)(item)),
    ...(finance ? { installments: state.snapshot?.installments ?? [], total_cents: state.snapshot?.total_cents ?? 0 } : {}),
    technical: state.snapshot?.technical ?? null,
    ...status, applied: status.applied.filter(d => d !== "finance" || finance),
    manual_destinations: [...manual].filter(d => d === "finance" ? finance : stock),
    ...(!finance ? { reason_code: null, blocked_reason: status.pending ? "Há uma pendência na origem." : null, skipped_reason: null } : {}),
    confirmed_ms: state.source?.confirmed_ms ?? null,
    cancellation_pending: row.status === "cancelled" && !!(pending || state.active.stock || state.active.finance),
    warnings: state.snapshot?.items.some(i => i.kind === "material" && !i.product_id) ? ["Material sem vínculo não baixa estoque."] : [],
  };
}
export async function patchWorkCommercial(ctx: ModuleContext, actor: Actor, id: string, data: any, key: string) {
  requireCommercialWriter(actor);
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  exactKeys(data, ["id", "version", "items", "installments", "customer_ref", "adult_payer_confirmed", "authorize_fixed_price", "technical"]);
  const intent = ["commercial", data];
  const replay = await replayWorkWrite(ctx, row, key, intent);
  if (replay) {
    const receipt = await one(ctx.env, "SELECT response FROM receipts WHERE scope=? AND key=?", `os-commercial:${ctx.profile}:${id}`, key);
    return JSON.parse(receipt.response);
  }
  checkVersion(row, data.version);
  if (["delivered", "cancelled"].includes(row.status)) throw new ApiError(409, "commercial_closed", "Trabalho encerrado.");
  if ((await readWorkIntegration(ctx, row)).frozen) throw new ApiError(409, "commercial_frozen", "Os dados comerciais estão congelados após efeitos ou durante o envio.");
  const local: WorkCommercial = { ...commercialOf(row) }, sets: Record<string, unknown> = {};
  if (data.items !== undefined) {
    if (!["received", "analyzing", "declined"].includes(row.status)) throw new ApiError(409, "invalid_transition", "Altere os itens pelo orçamento antes da aprovação.");
    const items = stableQuoteItems(row, validateQuoteItems(data.items));
    sets.quote_items = JSON.stringify(items);
    sets.quote_total_cents = quoteTotal(items);
    local.authorization = null;
  }
  if (Object.hasOwn(data, "customer_ref")) {
    if (data.customer_ref !== null) {
      opaque(data.customer_ref);
      const customer = await one(ctx.env, "SELECT id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active' AND trim(name)<>''", ctx.profile, data.customer_ref);
      if (!customer) throw new ApiError(422, "customer_required", "Selecione um cliente válido no cadastro único.");
    }
    local.customer_ref = data.customer_ref === null ? null : opaque(data.customer_ref);
    local.adult_payer_confirmed = false;
  }
  if (data.adult_payer_confirmed !== undefined) {
    if (actor.kind !== "user" || typeof data.adult_payer_confirmed !== "boolean" || !local.customer_ref) throw new ApiError(422, "adult_payer_required", "Uma pessoa deve confirmar o responsável financeiro adulto.");
    local.adult_payer_confirmed = data.adult_payer_confirmed;
  }
  if (data.installments !== undefined) {
    if (!Array.isArray(data.installments) || data.installments.length > 120) throw new ApiError(400, "invalid_request", "Plano de parcelas inválido.");
    local.installments = data.installments.map((i: any) => {
      exactKeys(i, ["key", "due_on", "amount_cents", "payment_method_id"]);
      opaque(i.key); opaque(i.due_on); integer(i.amount_cents, 1);
      if (i.payment_method_id !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(i.payment_method_id))) throw new ApiError(400, "invalid_request", "Forma de pagamento inválida.");
      return { key: opaque(i.key), due_on: opaque(i.due_on), amount_cents: integer(i.amount_cents, 1), payment_method_id: i.payment_method_id === null ? null : opaque(i.payment_method_id) };
    });
  }
  if (data.technical !== undefined) {
    if (await workPrivacy(ctx, row) === "adult_payer_only") throw new ApiError(422, "technical_not_allowed", "Este tipo permite somente dados comerciais genéricos.");
    if (data.technical === null) local.technical = null;
    else {
      exactKeys(data.technical, ["equipment", "serial_number", "technician", "defect", "solution"]);
      local.technical = { equipment: null, serial_number: null, technician: null, defect: null, solution: null };
      for (const k of Object.keys(local.technical) as (keyof NonNullable<WorkCommercial["technical"]>)[]) {
        const value = data.technical[k] ?? null;
        if (value !== null) opaque(value);
        local.technical[k] = value === null ? null : opaque(value);
      }
    }
  }
  const at = now();
  if (data.authorize_fixed_price !== undefined) {
    if (actor.kind !== "user" || data.authorize_fixed_price !== true || !((sets.quote_items ?? row.quote_items)) || ["quoted", "declined"].includes(row.status))
      throw new ApiError(422, "fixed_price_authorization_required", "A equipe deve autorizar expressamente o preço fixo vigente antes da execução.");
    local.authorization = { kind: "fixed_price", quote_version: Number(row.quote_version ?? 0), at, actor_id: actor.id, channel: "panel",
      content_hash: commercialFingerprint({ ...row, ...sets, commercial_json: JSON.stringify(local) }) };
  }
  sets.commercial_json = JSON.stringify(local);
  const next = await commitOrderMutation(ctx, row, sets, actor.id, "os.updated", ["commercial"], key, "", workWriteReceipt(ctx, row, key, intent, at));
  return { id, version: next.row_version };
}
export function registerWorkCommercial() {
  registerIntegrationProducer(getWorkProducer());
  onRead("os", "service-orders/:id/commercial", (ctx, actor, { params }) => workCommercialView(ctx, actor, params.id));
  onRoute("os", { method: "PATCH", path: "service-orders/:id/commercial", op: "os.commercial.update" });
  onCommand("os", "os.commercial.update", (ctx, actor, data, { requestId }) => patchWorkCommercial(ctx, actor, data.id, data, `commercial:${actor.id}:${requestId}`));
}
