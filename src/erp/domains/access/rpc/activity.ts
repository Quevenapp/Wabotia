// Atividade: public.erp_activity_list e erp_activity_detail.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { activityRequireAdmin, actorLabel, clean, period } from "../public.ts";
import { ENTRIES_SQL } from "../activity.ts";

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
  const q = query === null ? null : btrim(query).toLowerCase() || null;
  const rows = db
    .exec(
      `SELECT * FROM (${ENTRIES_SQL}) WHERE (?3 IS NULL OR module=?3) AND (?4 IS NULL OR operation=?4) AND (?5 IS NULL OR actor=?5)`,
      range.from.toString(),
      range.to.toString(),
      module,
      operation,
      actor,
    )
    .rows.map((r) => {
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
        String(r.code ?? "").toLowerCase().includes(q) ||
        String(r.description ?? "").toLowerCase().includes(q),
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
