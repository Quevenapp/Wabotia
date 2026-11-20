import { all, one } from "../../../db";
import { ApiError, json } from "../../../types";
import type { ModuleContext } from "../../api";
import type { CommercialSnapshot, Installment, SourceRef } from "../../../integrations/contracts";
import type { IntegrationProducer } from "../../../integrations/ports";
import { commercialCustomerRef, ensureCommercialPolicy, readIntegrationActivation } from "../../../integrations/ports";
import { canonical, hash, uuid5 } from "../../../integrations/keys";
import { validateSnapshot } from "../../../integrations/privacy";
import { authorizedOrder } from "../public";
import type { BaseStatus, QuoteItem, QuoteTerms } from "../contracts";
import { itemsDiscount, quoteTotal } from "../model";
import { snapshotType } from "../work-types";
import { getWorkObjectContext } from "../os2-ports";

const LINE_NAMESPACE = "844ce56a-4066-5640-8c46-a03586ff75cb";
export const workSource = (profile: string, id: string): SourceRef => ({ profile, module: "os", source_id: id, component: "main" });
export const documentStatus: Record<BaseStatus, string> = {
  received: "open", analyzing: "open", quoted: "quoted", approved: "approved", declined: "rejected",
  in_progress: "in_progress", ready: "service_done", delivered: "finalized", cancelled: "cancelled",
};
export interface WorkCommercial {
  schema?: 1;
  privacy?: CommercialSnapshot["privacy"];
  customer_ref?: string | null;
  adult_payer_confirmed?: boolean;
  installments?: Installment[];
  /** OS3: "quote" quando as parcelas vieram das condições do orçamento. */
  installments_source?: "quote" | null;
  technical?: CommercialSnapshot["technical"];
  authorization?: { kind: "approved_quote" | "fixed_price"; quote_version: number; at: number; actor_id: string | null; channel: string; content_hash: string } | null;
  first_execution_at?: number | null;
  historical_execution?: boolean;
  cancellation_pending?: boolean;
}
export const commercialOf = (row: any): WorkCommercial => json(row.commercial_json, {});
const signature = (i: QuoteItem) => canonical([i.description, i.quantity, i.unit_cents, i.unit ?? "UN", i.kind ?? "free"]);
/** Migração preguiçosa: conteúdo + ocorrência entre iguais, nunca posição da lista.
 * Depois da primeira gravação o UUID acompanha a linha, inclusive na reordenação. */
export function stableQuoteItems(row: any, input: readonly QuoteItem[] = json(row.quote_items, [])): QuoteItem[] {
  const occurrences = new Map<string, number>();
  const previous = (json(row.quote_items, []) as QuoteItem[]).map(i => {
    const key = signature(i), n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return { ...i, id: i.id ?? uuid5(LINE_NAMESPACE, canonical([row.profile_id, row.id, key, n])) };
  });
  const used = new Set<string>();
  // OS3: cliente que não conhece id/kind/unit (tela clássica antiga, apps)
  // reencontra a linha pelo texto e valores e herda a classificação: o
  // vínculo de catálogo, preso ao id da linha, não se perde na edição.
  const loose = (i: QuoteItem) => canonical([i.description, i.quantity, i.unit_cents]);
  const legacy = (i: QuoteItem) => i.id === undefined && i.kind === undefined && i.unit === undefined;
  const matches = input.map(i => previous.find(p => signature(p) === signature(i)) ? null : legacy(i) ? loose(i) : null);
  return input.map((i, index) => {
    const matching = previous.find(p => !used.has(p.id) && signature(p) === signature(i))
      ?? (matches[index] ? previous.find(p => !used.has(p.id) && loose(p) === matches[index] && !input.some(x => x.id === p.id)) : undefined);
    const id = i.id ?? matching?.id ?? crypto.randomUUID();
    if (used.has(id)) throw new ApiError(400, "invalid_request", "Identificador de item repetido.");
    used.add(id);
    const before = previous.find(p => p.id === id);
    return { ...i, id, unit: i.unit ?? before?.unit ?? "UN", kind: i.kind ?? before?.kind ?? "free" };
  });
}
export const commercialFingerprint = (row: any) => hash({
  items: stableQuoteItems(row).map(({ product_id: _, ...item }) => item),
  total: row.quote_total_cents ?? 0,
  customer: commercialOf(row).customer_ref ?? row.contact_id ?? null,
  installments: commercialOf(row).installments ?? [],
});
export const saoPauloDate = (at: number) => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
};

/** Áreas sensíveis por natureza (saúde, ensino, jurídico): comercial reservado. */
// "advoca" cobre escritorio_advocacia, que a regra anterior (só "advog") deixava de fora.
export const RESERVED_AREAS = /clinica_medica|escolas|professores|advog|advoca/;
/** Modelo aplicado de um modelo de área: area_<modelo>__<id local>. */
export const areaOfType = (typeId: string | null | undefined) => /^area_([a-z0-9_]+?)__/.exec(typeId ?? "")?.[1] ?? null;
/**
 * OS3: o dado da ordem não é segredo por padrão. O documento comercial leva
 * os itens do orçamento como a pessoa escreveu; campos marcados sensíveis
 * no modelo nunca entram na projeção comercial. Ficam reservados (só
 * "Serviço contratado" e pagador adulto confirmado) os modelos das áreas
 * sensíveis por natureza e toda a área que aplicou um desses modelos.
 */
export async function workPrivacy(ctx: ModuleContext, row: any): Promise<CommercialSnapshot["privacy"]> {
  // type_id é o mesmo id da definição fixada na ordem (conferido em snapshotType).
  const area = areaOfType(row.type_id);
  if (area && RESERVED_AREAS.test(area)) return "adult_payer_only";
  const settings = await ctx.settings();
  const sensitiveArea = (settings.os_area_setup ?? []).some((s: any) => RESERVED_AREAS.test(s.template_id));
  return sensitiveArea ? "adult_payer_only" : "commercial";
}
/**
 * Equipamento do documento: com objeto do serviço, a cópia desta ordem só
 * com campos que o cliente pode ver (nunca os sensíveis); sem objeto, o item.
 */
function equipmentText(row: any): string | null {
  let text = "";
  if (row.object_id) {
    try { text = getWorkObjectContext(row, { kind: "customer" })?.equipment_text ?? ""; }
    catch { text = ""; }
  }
  return Array.from(String(text || row.item || "")).slice(0, 200).join("") || null;
}
/** Título do documento comercial: número da ordem no vocabulário do modelo. */
export function commercialTitle(row: any) {
  const type = snapshotType(row);
  if (!type) return `Ordem de serviço ${row.number ?? ""}`.trim();
  const display = `${type.number_prefix ? type.number_prefix + "-" : ""}${row.type_number ?? row.number ?? ""}`;
  return Array.from(`${type.labels.singular} ${display}`.trim()).slice(0, 200).join("");
}
export async function readWorkIntegration(ctx: ModuleContext, row: any) {
  const stored = await one(ctx.env, `SELECT s.*,(SELECT json_group_array(json_object('seq',seq,'payload_json',payload_json,
    'state',state,'unresolved',unresolved,'error_code',error_code,'receipt_json',receipt_json,'body_json',body_json)) FROM (
      SELECT e.seq,e.payload_json,d.state,d.unresolved,d.error_code,d.receipt_json,r.body_json FROM module_erp_events e
      JOIN module_erp_delivery d ON d.event_id=e.id LEFT JOIN module_erp_requests r ON r.event_id=e.id
      WHERE e.profile_id=s.profile_id AND e.module_id=s.module_id AND e.source_id=s.source_id ORDER BY e.source_revision,e.seq
    )) events_json FROM module_erp_sources s WHERE s.profile_id=? AND s.module_id='os' AND s.source_id=?`, ctx.profile, row.id);
  const { events_json, ...sourceData } = stored ?? {};
  const source = stored ? sourceData : null;
  const events: any[] = JSON.parse(events_json ?? "[]");
  const active = { stock: false, finance: false };
  let uncertain = false;
  for (const event of events) {
    const payload = JSON.parse(event.payload_json);
    const result = json(event.receipt_json, null);
    for (const destination of ["stock", "finance"] as const) {
      if (["posted", "settled"].includes(result?.effects[destination])) active[destination] = true;
      if (result?.effects[destination] === "reversed") active[destination] = false;
    }
    if (event.state !== "done" && payload.operation === "execute" && (payload.eligible.stock || payload.eligible.finance)) uncertain = true;
  }
  return { source, events, active, frozen: active.stock || active.finance || uncertain,
    snapshot: json(source?.state_json, {}).snapshot as CommercialSnapshot | undefined,
    linked: (json(source?.links_json, []) as any[]).some(l => l.kind === "document"),
  };
}
export type WorkIntegration = Awaited<ReturnType<typeof readWorkIntegration>>;
export interface WorkCatalogChange { component: string; product_id: string | null }
export async function projectWork(ctx: ModuleContext, row: any, revision: number,
  options: { products: boolean; policy: Awaited<ReturnType<typeof ensureCommercialPolicy>>; integration: WorkIntegration; privacy: CommercialSnapshot["privacy"]; catalogChange?: WorkCatalogChange },
): Promise<CommercialSnapshot> {
  const local = commercialOf(row), { policy, integration, privacy } = options;
  const sensitive = privacy === "adult_payer_only", items = stableQuoteItems(row);
  const links = items.length && options.products && !integration.frozen ? await all(ctx.env,
    "SELECT component,erp_item_id FROM module_erp_catalog_links WHERE profile_id=? AND module_id='os' AND record_kind='quote_item' AND record_id=?", ctx.profile, row.id) : [];
  let customer_ref: string | null = local.customer_ref ?? row.contact_id ?? null, contact_id: string | null = null;
  if (sensitive) customer_ref = local.adult_payer_confirmed ? local.customer_ref ?? null : null;
  else if (!customer_ref && row.conversation_id) {
    const conversation = await one(ctx.env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", ctx.profile, row.conversation_id);
    if (conversation) {
      try { customer_ref = (await commercialCustomerRef(ctx.env, conversation)).customer_ref; }
      catch (error) { if (!(error instanceof ApiError) || error.code !== "customer_required") throw error; }
    }
  }
  if (customer_ref) {
    const contact = await one(ctx.env, "SELECT erp_contact_id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active' AND trim(name)<>''", ctx.profile, customer_ref);
    contact_id = contact?.erp_contact_id ?? null;
  }
  // Identificado incompleto nunca vira Consumidor. A preparação fica pendente.
  if (!sensitive && !customer_ref) customer_ref = `unresolved:${row.id}`;
  // OS3: descontos da linha e do total viram o desconto do documento; cada
  // linha conserva o preço de lista e o ERP confere bruto - desconto = total.
  const orderDiscount = Number(row.quote_discount_cents ?? 0) || 0;
  const total = items.length ? quoteTotal(items, orderDiscount) : 0;
  if (items.length && total !== row.quote_total_cents) throw new ApiError(422, "total_mismatch", "Os valores comerciais não conferem.");
  const first = local.first_execution_at ?? null;
  const terms = json(row.quote_terms_json, null) as QuoteTerms | null;
  const snapshot: CommercialSnapshot = {
    schema: 1, source: workSource(ctx.profile, row.id), source_revision: revision,
    privacy, contact_id, customer_ref, description: sensitive ? "Serviço contratado" : commercialTitle(row),
    issued_on: saoPauloDate(row.created),
    items: items.map(i => ({ id: i.id!, description: sensitive ? "Serviço contratado" : i.description,
      quantity: String(i.quantity), unit_cents: i.unit_cents, unit: sensitive ? "UN" : i.unit!,
      kind: options.products ? i.kind! : "free", product_id: options.products && i.kind !== "free"
        ? options.catalogChange && options.catalogChange.component === i.id ? options.catalogChange.product_id : links.find(l => l.component === i.id)?.erp_item_id ?? null : null })),
    total_cents: total, freight_cents: 0, discount_cents: items.length ? itemsDiscount(items) + orderDiscount : 0,
    installments: local.installments?.length ? local.installments.map(i => ({ ...i,
      key: sensitive ? uuid5(LINE_NAMESPACE, canonical([row.id, "installment", i.key])) : i.key,
    })) : total > 0 ? [{ key: "main", due_on: saoPauloDate(first ?? row.created), amount_cents: total, payment_method_id: terms?.payment_method_id ?? policy.payment_method_id }] : [],
    policy_version: policy.version,
    lifecycle: { base_status: row.status, stage_id: row.stage ?? row.status, quote_version: row.quote_items ? row.quote_version ?? 0 : null,
      authorization: local.authorization?.kind ?? null, authorized_at: local.authorization?.at ?? null,
      first_execution_at: first, delivered_at: row.delivered_at ?? null, warranty_until: row.warranty_until ?? null },
    technical: sensitive ? null : local.technical ?? { equipment: equipmentText(row), serial_number: null, technician: null, defect: null, solution: null },
  };
  if (integration.frozen && integration.snapshot) {
    const saved = integration.snapshot;
    // Depois de efeitos, nada do conteúdo comercial muda, nem a reserva:
    // título, desconto e classificação vêm da fotografia já enviada.
    Object.assign(snapshot, { contact_id: saved.contact_id, customer_ref: saved.customer_ref, items: saved.items,
      total_cents: saved.total_cents, installments: saved.installments, policy_version: saved.policy_version, technical: saved.technical,
      description: saved.description, privacy: saved.privacy, discount_cents: saved.discount_cents ?? 0 });
  }
  validateSnapshot(snapshot);
  return snapshot;
}
// Função e armazenamento hoistados: o runtime registra módulos durante os
// ciclos de importação já existentes entre service, api e store.
var installedProducer: IntegrationProducer | undefined;
export function getWorkProducer(): IntegrationProducer {
  return installedProducer ??= {
  module: "os",
  async authorizeSource(ctx, actor, source, write) {
    if (source.profile !== ctx.profile || source.module !== "os") throw new ApiError(404, "not_found", "Trabalho não encontrado.");
    const { row } = await authorizedOrder(ctx, actor, source.source_id, { write });
    if (source.component !== "main") {
      const match = /^catalog:quote_item:([0-9a-f-]{36})$/.exec(source.component);
      if (!match || !stableQuoteItems(row).some(i => i.id === match[1])) throw new ApiError(404, "not_found", "Item não encontrado.");
      if (write && (await readWorkIntegration(ctx, row)).frozen) throw new ApiError(409, "commercial_frozen", "O documento já possui efeitos. Os itens comerciais estão congelados.");
    }
  },
  async project(ctx, source) {
    if (source.profile !== ctx.profile || source.module !== "os" || source.component !== "main") throw new ApiError(404, "not_found", "Trabalho não encontrado.");
    const row = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, source.source_id);
    if (!row) throw new ApiError(404, "not_found", "Trabalho não encontrado.");
    const integration = await readWorkIntegration(ctx, row);
    const state = await readIntegrationActivation(ctx.env, ctx.profile, "os");
    return projectWork(ctx, row, (integration.source?.revision ?? 0) + 1, { products: state.snapshot.parts.products,
      policy: await ensureCommercialPolicy(ctx.env, ctx.profile), integration, privacy: await workPrivacy(ctx, row) });
  },
  };
}
export const workProducer = getWorkProducer();
