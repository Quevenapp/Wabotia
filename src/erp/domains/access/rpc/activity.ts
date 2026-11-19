import { ErpPartDisabled } from "../../../engine/parts-gate.ts";
import { erpRequirement, erpRequirementMet, type ErpModuleId, type ErpRequirement } from "../../../parts.ts";
import { erpEntityRequirement, erpListRequirement, erpFieldRequirement, erpPreferenceFieldRequirement, erpReportRequirement, erpDestinationRequirement, erpOperationRequirement } from "../../../parts-requirements.ts";
import { projectCatalogRecord, CONTACT_FINANCE_FIELDS, PAYMENT_FINANCE_FIELDS, SELLER_FINANCE_FIELDS, PRODUCT_STOCK_FIELDS } from "../../catalog/part-projection.ts";
import { projectDocument } from "../../documents/internal.ts";
// Atividade: public.erp_activity_list e erp_activity_detail.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { activityRequireAdmin, actorLabel, clean, period } from "../public.ts";
import { ENTRIES_SQL } from "../activity.ts";
import { pgLower } from "../../../engine/text.ts";

const s = (v: unknown) => (v === undefined ? null : (v as string | null));
const MODULES = [
  "campos_customizados", "certificado_digital", "caixa", "comissao", "financas", "clientes_fornecedores", "estoque", "frente_caixa",
  "cobranca", "notas_fiscais", "ordens_servico", "pagamento_recebimento", "pedidos_compra", "pedidos_venda", "produtos", "propostas",
  "anexos", "depositos", "documentos", "empresa", "meu_negocio", "pagina_inicial", "preferencias", "usuarios",
];
const OPERATIONS = ["atualizacao", "atualizacao_situacao", "criacao", "envio", "estorno", "exclusao", "lancamento", "transferencia"];
const btrim = (t: string) => t.replace(/^ +| +$/g, "");

registerRpc("erp_activity_list", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  activityRequireAdmin(db, s(a.p_user_id));
  const from = s(a.p_from),
    to = s(a.p_to);
  const range = period(from, to);
  const limit = a.p_limit === undefined || a.p_limit === null ? null : Number(a.p_limit);
  const offset = a.p_offset === undefined || a.p_offset === null ? null : Number(a.p_offset);
  const module = s(a.p_module),
    operation = s(a.p_operation),
    actor = s(a.p_actor),
    query = s(a.p_query);
  if (
    limit === null || limit < 1 || limit > 100 || offset === null || offset < 0 || offset > 100000 ||
    (module !== null && !MODULES.includes(module)) || (operation !== null && !OPERATIONS.includes(operation)) ||
    (query !== null && ([...query].length > 120 || /[\u0001-\u001f\u007f]/.test(query)))
  )
    raise("22023", "erp_activity_input_invalid");
  const q = query === null ? null : pgLower(btrim(query)) || null;
  const rows = db
    .exec(
      `SELECT * FROM (${ENTRIES_SQL}) WHERE (?3 IS NULL OR module=?3) AND (?4 IS NULL OR operation=?4) AND (?5 IS NULL OR actor=?5)`,
      range.from.toString(),
      range.to.toString(),
      module,
      operation,
      actor,
    )
    .rows.filter(r => activityVisible(ctx, r)).map((r) => {
      // Ramo "users": o rótulo do usuário-alvo vem de erp_activity.actor_label.
      const d = r.description as string | null;
      if (d !== null && d.startsWith("@users:")) {
        const [prefix, target] = d.slice("@users:".length).split("|");
        r.description = [...(prefix + actorLabel(db, target))].slice(0, 200).join("");
      }
      return r;
    })
    .filter(
      (r) =>
        q === null ||
        pgLower(String(r.code ?? "")).includes(q) ||
        pgLower(String(r.description ?? "")).includes(q),
    );
  rows.sort((x, y) => {
    const t = BigInt(y.created_at as number) - BigInt(x.created_at as number);
    if (t !== 0n) return t > 0n ? 1 : -1;
    const sx = String(x.source),
      sy = String(y.source);
    if (sx !== sy) return sx < sy ? -1 : 1;
    const ex = String(x.entry_id),
      ey = String(y.entry_id);
    return ex < ey ? -1 : ex > ey ? 1 : 0;
  });
  const items = rows.slice(offset, offset + limit).map((x) => ({
    source: x.source,
    id: x.entry_id,
    created_at: jsonTimestamp(x.created_at as number),
    actor: { user_id: x.actor, label: actorLabel(db, String(x.actor)) },
    module: x.module,
    operation: x.operation,
    code: clean((x.code as string | null) ?? null, 120),
    description: clean((x.description as string | null) ?? null, 200),
  }));
  return {
    scope: "activity",
    data_mode: "erp_native",
    from,
    to,
    module,
    operation,
    actor,
    query: q,
    limit,
    offset,
    total: rows.length,
    has_more: offset + items.length < rows.length,
    items,
  };
});

const SOURCES = [
  "catalog", "documents", "finance", "stock", "cnab", "fiscal_drafts", "company", "attachments", "preferences", "list_preferences", "home",
  "users", "frameworks", "taxonomy", "pricing", "auxiliary", "numbering", "fiscal_invoices", "a1", "stock_count", "warehouse_settings",
  "checkin", "goals", "custom_fields", "contact_files", "imports", "pos", "compositions", "product_images", "finance_files", "company_logo",
  "user_signatures", "invoice_tags", "lots", "invoice_stock", "company_files",
];
const NO_DETAIL = [
  "stock", "cnab", "fiscal_drafts", "attachments", "fiscal_invoices", "a1", "stock_count", "warehouse_settings", "checkin", "contact_files",
  "imports", "compositions", "product_images", "finance_files", "company_logo", "lots", "invoice_stock", "company_files",
];
const AUDIT: Record<string, string> = {
  catalog: "erp_catalog__audit", documents: "erp_documents__audit", finance: "erp_finance__audit", company: "erp_company__audit",
  list_preferences: "erp_list_preferences__audit", home: "erp_home__shortcut_audit", users: "erp_access__user_audit",
  taxonomy: "erp_catalog__taxonomy_audit", pricing: "erp_pricing__audit", auxiliary: "erp_catalog__auxiliary_audit",
  goals: "erp_home__goal_audit", custom_fields: "erp_catalog__custom_field_audit", pos: "erp_pos__audit",
  user_signatures: "erp_documents__user_signature_audit", invoice_tags: "erp_catalog__invoice_tag_audit",
};
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

registerRpc("erp_activity_detail", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  activityRequireAdmin(db, s(a.p_user_id));
  const source = s(a.p_source),
    entry = s(a.p_entry_id);
  if (source === null || !SOURCES.includes(source) || entry === null || !/^[0-9a-f-]{1,40}$/.test(entry)) raise("22023", "erp_activity_input_invalid");
  let entryRow: Record<string, unknown> | undefined;
  if (Object.values(ctx.parts).some(on => !on)) {
    entryRow = one(db, `SELECT * FROM (${ENTRIES_SQL}) WHERE source=?3 AND entry_id=?4`, "-9223372036854775808", "9223372036854775807", source, entry);
    if (entryRow && !activityVisible(ctx, entryRow)) throw new ErpPartDisabled();
  }
  if (NO_DETAIL.includes(source))
    return { scope: "activity_detail", data_mode: "erp_native", source, id: entry, available: false, truncated: false, before: null, after: null };
  if (!/^[1-9][0-9]{0,17}$/.test(entry)) raise("22023", "erp_activity_input_invalid");
  let found: { before: unknown; after: unknown } | null = null;
  if (source === "preferences") {
    const r = one(db, 'SELECT key, before_value, after_value FROM "erp_preferences__audit" WHERE id=?', entry);
    if (r) found = { before: { [String(r.key)]: json(r.before_value) }, after: { [String(r.key)]: json(r.after_value) } };
  } else if (source === "numbering") {
    const r = one(db, 'SELECT before_last, after_last FROM "erp_documents__numbering_audit" WHERE id=?', entry);
    if (r) found = { before: { proximo_numero: Number(r.before_last) + 1 }, after: { proximo_numero: Number(r.after_last) + 1 } };
  } else {
    const table = AUDIT[source] ?? "erp_preferences__framework_audit";
    const r = one(db, `SELECT before_data, after_data FROM "${table}" WHERE id=?`, entry);
    if (r) found = { before: json(r.before_data), after: json(r.after_data) };
  }
  if (!found) raise("P0002", "erp_activity_entry_not_found");
  if (entryRow) found = {
    before: projectActivity(ctx, entryRow, found.before),
    after: projectActivity(ctx, entryRow, found.after),
  };
  const bytes = (v: unknown) => (v === null || v === undefined ? 0 : new TextEncoder().encode(jsonbText(v)).length);
  const truncated = bytes(found.before) + bytes(found.after) > 200000;
  return {
    scope: "activity_detail",
    data_mode: "erp_native",
    source,
    id: entry,
    available: true,
    truncated,
    before: truncated ? null : found.before,
    after: truncated ? null : found.after,
  };
});


type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const SOURCE_PARTS: Record<string, ErpModuleId[]> = {
  finance: ["erp-financeiro"], finance_files: ["erp-financeiro"], cnab: ["erp-cobranca"],
  stock: ["erp-estoque"], stock_count: ["erp-estoque"], warehouse_settings: ["erp-estoque"], lots: ["erp-estoque"],
  checkin: ["erp-estoque", "erp-fiscal"], invoice_stock: ["erp-estoque", "erp-fiscal"],
  fiscal_drafts: ["erp-fiscal"], fiscal_invoices: ["erp-fiscal"], a1: ["erp-fiscal"], invoice_tags: ["erp-fiscal"],
  pricing: ["erp-produtos"], custom_fields: ["erp-produtos"], product_images: ["erp-produtos"],
  compositions: ["erp-produtos", "erp-estoque"], pos: ["erp-pdv"], goals: ["erp-vendas"], user_signatures: ["erp-vendas"],
};
const DOCUMENT_MODULES: Record<string, string> = { propostas: "sales_proposals", pedidos_venda: "sales_orders", pedidos_compra: "purchase_orders", ordens_servico: "service_orders" };
function eventAudit(ctx: RpcContext, entry: Row): Row {
  const source = String(entry.source);
  const table = AUDIT[source] ?? ({ preferences: "erp_preferences__audit", numbering: "erp_documents__numbering_audit", frameworks: "erp_preferences__framework_audit" } as Record<string, string>)[source];
  return table ? one(ctx.db, `SELECT * FROM "${table}" WHERE id=?`, entry.entry_id) ?? {} : {};
}
function eventRequirement(ctx: RpcContext, entry: Row, audit: Row): ErpRequirement | null {
  const source = String(entry.source), after = record(json(audit.after_data)), before = record(json(audit.before_data));
  const entity = (value: unknown) => erpEntityRequirement(value);
  if (SOURCE_PARTS[source]) return erpRequirement(...SOURCE_PARTS[source]);
  if (source === "catalog") return entity(audit.entity);
  if (source === "documents" || source === "numbering") {
    const owner = entity(DOCUMENT_MODULES[String(entry.module)]);
    const action = String(audit.action ?? "");
    return owner ? erpRequirement(...owner.all, ...(/finance/.test(action) ? ["erp-financeiro"] : /stock/.test(action) ? ["erp-estoque"] : []) as ErpModuleId[]) : null;
  }
  if (source === "preferences") {
    const definition = one(ctx.db, 'SELECT page_id FROM "erp_preferences__definition" WHERE key=?', audit.key);
    return definition ? erpPreferenceFieldRequirement(String(definition.page_id), String(audit.key)) : null;
  }
  if (source === "list_preferences") return erpListRequirement(audit.list_id);
  if (source === "taxonomy") {
    const current = one(ctx.db, 'SELECT tag_type FROM "erp_catalog__taxonomy" WHERE id=?', audit.item_id);
    const type = current?.tag_type ?? after.tag_type ?? before.tag_type;
    return entity(type === "invoices" ? "invoices" : type === "contacts" ? "contacts" : "products");
  }
  if (source === "frameworks") {
    const value = Object.keys(after).length ? after : before;
    if (audit.area === "reports") return erpReportRequirement(value.base, value.columns as unknown[] ?? [], value.filters as unknown[] ?? []);
    if (audit.area === "labels") return entity(value.type);
    if (audit.area === "situations") return entity(value.kind ?? String(audit.target).split(":")[0]);
    if (audit.area === "tags") return entity(value.tag_type === "invoices" ? "invoices" : value.tag_type === "products" ? "products" : "contacts");
    return null;
  }
  if (source === "attachments") {
    const d = one(ctx.db, `SELECT d.kind FROM erp_attachments__audit a JOIN erp_attachments__attachment t ON t.id=a.attachment_id
      JOIN erp_documents__document d ON d.id=t.document_id WHERE a.id=?`, entry.entry_id);
    return entity(d?.kind);
  }
  if (source === "imports") {
    const row = one(ctx.db, 'SELECT kind FROM erp_preferences__import_job WHERE id=?', entry.entry_id);
    if (row?.kind === "compositions") return erpOperationRequirement("composition");
    if (row?.kind === "product_suppliers") return erpRequirement("erp-produtos", "erp-compras", "erp-estoque");
    return entity(row?.kind);
  }
  if (source === "company" && /fiscal/.test(String(audit.action))) return erpRequirement("erp-fiscal");
  return erpRequirement("erp");
}

/** Eventos compartilhados usam a mesma projeção das fichas e dos documentos. */
function projectActivity(ctx: RpcContext, entry: Row, value: unknown, audit = eventAudit(ctx, entry)): unknown {
  if (value === null || value === undefined) return value;
  const source = String(entry.source), data = record(value);
  if (source === "catalog") return projectCatalogRecord(ctx.parts, String(audit.entity), data);
  if (source === "auxiliary") {
    const entity = ({ seller: "sellers", payment_method: "payment_methods", contact: "contacts" } as Record<string, string>)[String(audit.subject)];
    if (entity) return projectCatalogRecord(ctx.parts, entity, data);
  }
  if (source === "documents") return projectDocument(ctx, data);
  if (source === "list_preferences") {
    const out = { ...data }, owner = erpListRequirement(audit.list_id)?.all[0];
    const available = (field: unknown) => {
      if (typeof field !== "string") return false;
      if ([...CONTACT_FINANCE_FIELDS, ...PAYMENT_FINANCE_FIELDS, ...SELLER_FINANCE_FIELDS, "payment_account_id", "fee_amount", "commission_fee_amount"].includes(field) && !ctx.parts.finance) return false;
      if (PRODUCT_STOCK_FIELDS.includes(field) && !ctx.parts.stock) return false;
      if (["suppliers", "supplier_id", "cost_price", "purchase_price"].includes(field) && (!ctx.parts.purchases || !ctx.parts.stock)) return false;
      return erpRequirementMet(ctx.parts, erpFieldRequirement(field, owner));
    };
    if (Array.isArray(out.columns)) out.columns = out.columns.filter(available);
    if (out.filters && typeof out.filters === "object") out.filters = Object.fromEntries(Object.entries(record(out.filters)).filter(([field]) => available(field)));
    return out;
  }
  if (source === "home") {
    const out = { ...data }, available = (path: unknown) => typeof path === "string" && !!erpDestinationRequirement(path) && erpRequirementMet(ctx.parts, erpDestinationRequirement(path)!.requirement);
    if (Array.isArray(out.shortcuts)) out.shortcuts = out.shortcuts.filter(available);
    if (out.labels && typeof out.labels === "object") out.labels = Object.fromEntries(Object.entries(record(out.labels)).filter(([path]) => available(path)));
    if (Array.isArray(out.charts)) out.charts = out.charts.filter(chart => chart === "resumo" || erpRequirementMet(ctx.parts, erpRequirement("erp-vendas")));
    return out;
  }
  if (source === "frameworks" && Array.isArray(data.actions)) return { ...data, actions: data.actions.filter(action =>
    typeof action === "string" && (action.endsWith("stock") ? ctx.parts.stock : action.endsWith("finance") ? ctx.parts.finance : true)) };
  return value;
}
function visibleContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(visibleContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["version", "created_at", "updated_at", "updated_by", "updated_by_name", "unavailable_parts"].includes(key)).map(([key, v]) => [key, visibleContent(v)]));
}
function activityVisible(ctx: RpcContext, entry: Row): boolean {
  if (Object.values(ctx.parts).every(Boolean)) return true;
  const audit = eventAudit(ctx, entry), requirement = eventRequirement(ctx, entry, audit);
  if (!requirement || !erpRequirementMet(ctx.parts, requirement)) return false;
  // Uma edição apenas de campos suspensos não vira uma linha vazia na Base.
  if (audit.before_data != null && audit.after_data != null) {
    const before = json(audit.before_data), after = json(audit.after_data);
    const projectedBefore = projectActivity(ctx, entry, before, audit), projectedAfter = projectActivity(ctx, entry, after, audit);
    if (jsonbText(visibleContent(before)) !== jsonbText(visibleContent(after)) &&
        jsonbText(visibleContent(projectedBefore)) === jsonbText(visibleContent(projectedAfter))) return false;
  }
  return true;
}
