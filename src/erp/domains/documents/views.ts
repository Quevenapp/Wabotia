// Visões do Documentos usadas por uma leitura (sessão L) e por um escritor
// (sessão O): uma versão só, aqui. Combinado com a O (16/11): a L escreve
// junto com a leitura, a O importa nos escritores.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { pgLeft } from "../../engine/text.ts";
import { rowJson, valueJson } from "../../engine/row-json.ts";
import { ERP_TABLES } from "../../schema/columns.generated.ts";
import { isAdmin, jsonbHas } from "./rpc/reads-common.ts";

const col = (table: string, column: string) => ERP_TABLES[table].columns[column];
const ts = (table: string, column: string, v: unknown) => valueJson(col(table, column), v);

/** erp_documents.custom_field_item(p_id, p_counts): o campo customizado e, com p_counts, quantos documentos o usam. */
export function customFieldItem(db: SqlDriver, id: string, counts: boolean): Record<string, unknown> | null {
  const f = one(db, 'SELECT * FROM "erp_documents__custom_field" WHERE id=?', id);
  if (!f) return null;
  const r = rowJson("erp_documents__custom_field", f);
  let documents: number | null = null;
  if (counts) {
    documents = 0;
    for (const d of db.exec('SELECT body FROM "erp_documents__document" WHERE kind=?', f.kind).rows) {
      const body = JSON.parse(String(d.body));
      const cf = body !== null && typeof body === "object" && !Array.isArray(body) ? body.custom_fields : undefined;
      if (jsonbHas(cf, String(f.id))) documents++;
    }
  }
  return {
    id: r.id, kind: r.kind, field_type: r.field_type, name: r.name, hint: r.hint, info: r.info, required: r.required,
    min_length: r.min_length, max_length: r.max_length, width: r.width, options: r.options, active: r.active, version: r.version,
    created_at: r.created_at, updated_at: r.updated_at, documents,
  };
}

/** erp_documents.list_view_columns(p_kind) */
export const listViewColumns = (kind: string | null): string[] =>
  kind === "sales_orders"
    ? ["date", "contact", "total", "customer_po_number", "address", "ship_date", "contact_email", "contact_phone", "contact_document", "carrier_name"]
    : [];

/** erp_documents.list_view_default_statuses(p_kind) */
export const listViewDefaultStatuses = (kind: string | null): string[] =>
  kind === "sales_proposals" ? ["draft", "open", "pending", "waiting"] : ["open"];

/** erp_documents.list_view_dto(p_user_id, p_kind) */
export function listViewDto(db: SqlDriver, user: string | null, kind: string | null) {
  const v = user === null || kind === null ? null : one(db, 'SELECT * FROM "erp_documents__list_view" WHERE user_id=? AND kind=?', user, kind);
  const columns = v && v.columns !== null ? (JSON.parse(String(v.columns)) as string[]) : null;
  const statuses = v && v.default_statuses !== null ? (JSON.parse(String(v.default_statuses)) as string[]) : null;
  return {
    kind,
    custom_view: v ? v.custom_view === 1 : false,
    columns: columns ?? (kind === "sales_orders" ? ["date", "contact", "total"] : []),
    default_statuses: statuses ?? listViewDefaultStatuses(kind),
    statuses_saved: statuses !== null,
    available_columns: listViewColumns(kind),
    column_limit: 8,
    version: v ? Number(v.version) : 0,
    data_mode: "erp_native",
    operational_effects: false,
  };
}

/** erp_documents.numbering_dto(p_kind): null quando o tipo não tem numeração. */
export function numberingDto(db: SqlDriver, kind: string | null) {
  const n = kind === null ? null : one(db, 'SELECT kind, last_number FROM "erp_documents__numbering" WHERE kind=?', kind);
  if (!n) return null;
  const last = Number(n.last_number);
  const max = Number(one(db, 'SELECT coalesce(max(number),0) m FROM "erp_documents__document" WHERE kind=?', n.kind)!.m);
  return {
    kind: n.kind,
    next_number: last < 9999999999 ? String(last + 1) : null,
    reserved: false,
    minimum_next_number: max < 9999999999 ? String(max + 1) : null,
    data_mode: "erp_native",
    operational_effects: false,
  };
}

/** erp_documents.print_header_view(p_kind, p_user_id) */
export function printHeaderView(db: SqlDriver, kind: string | null, user: string | null) {
  const h = kind === null ? null : one(db, 'SELECT content, version, updated_at FROM "erp_documents__print_header" WHERE kind=?', kind);
  return {
    kind,
    content: h ? ts("erp_documents__print_header", "content", h.content) : null,
    version: h ? Number(h.version) : 0,
    updated_at: h ? ts("erp_documents__print_header", "updated_at", h.updated_at) : null,
    can_manage: isAdmin(db, user),
    data_mode: "erp_native",
    operational_effects: false,
  };
}

/** erp_documents.signature_view(p_user_id) */
export function signatureView(db: SqlDriver, user: string | null) {
  const s = user === null ? null : one(db, 'SELECT greeting, department, version FROM "erp_documents__user_signature" WHERE user_id=?', user);
  const p = user === null ? null : one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', user);
  return {
    greeting: s ? s.greeting : null,
    department: s ? s.department : null,
    version: s ? Number(s.version) : 0,
    name: p && p.name !== null ? pgLeft(String(p.name), 200) : null,
    data_mode: "erp_native",
    operational_effects: false,
  };
}
