// Visões do Documentos usadas por uma leitura (sessão L) e por um escritor
// (sessão O): uma versão só, aqui. Combinado com a O (16/11): a L escreve
// junto com a leitura, a O importa nos escritores.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { exact, formatScaled, fromColumn, rescale } from "../../engine/dec.ts";
import { arrow } from "../../engine/json.ts";
import { pgBtrim, pgLeft, pgUpper } from "../../engine/text.ts";
import { rowJson, valueJson } from "../../engine/row-json.ts";
import { ERP_TABLES } from "../../schema/columns.generated.ts";
import { dto as catalogDto } from "../catalog/public.ts";
import { preference } from "./internal.ts";
import { bool, isAdmin, jsonbHas, jsonPathText } from "./rpc/reads-common.ts";

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

/** erp_documents.copy_source_dto(p_id): de onde o documento foi copiado (null se não foi). */
export function copySourceDto(db: SqlDriver, id: string | null) {
  const c = id === null ? null : one(db, 'SELECT source_id, source_kind, source_number, source_version FROM "erp_documents__copy_source" WHERE destination_id=?', id);
  return c ? { id: c.source_id, kind: c.source_kind, number: String(c.source_number), version: Number(c.source_version) } : null;
}

/** erp_documents.checkout_settings(): as preferências do checkout de pedidos. */
export function checkoutSettings(db: SqlDriver) {
  return {
    order: preference(db, "vendas.checkout_ordenar") === "crescente" ? "crescente" : "nao_ordenar",
    split: preference(db, "vendas.checkout_desmembrar") === true,
    picking: preference(db, "vendas.checkout_picking") === true,
    auto_save: preference(db, "vendas.checkout_salvar_auto") === true,
    quantity_input: preference(db, "vendas.checkout_quantidade") === true,
  };
}

/** GTIN legível: btrim, e nem vazio nem "SEM GTIN" (o GTIN tributário de produto sem GTIN). */
const readableGtin = (v: string | null) => (v === null ? null : ["", "SEM GTIN"].includes(pgUpper(pgBtrim(v))) ? null : pgBtrim(v));

/** erp_documents.checkout_lines(p_id, p_split): uma linha por item, ou por componente do item composto quando desmembra. */
export function checkoutLines(db: SqlDriver, id: string, split: boolean) {
  const items = db.exec(
    'SELECT id, position, product_id, data, CAST(quantity AS TEXT) quantity FROM "erp_documents__item" WHERE document_id=?',
    id,
  ).rows;
  const components = (product: unknown) =>
    product === null
      ? []
      : db.exec(
          `SELECT ci.position, ci.component_id, CAST(ci.quantity AS TEXT) quantity, r.name, r.code, cp.unit
             FROM "erp_stock__composition" c JOIN "erp_stock__composition_item" ci ON ci.product_id=c.product_id AND ci.version=c.version
             JOIN "erp_catalog__record" r ON r.id=ci.component_id LEFT JOIN "erp_catalog__product" cp ON cp.record_id=ci.component_id
            WHERE c.product_id=?`,
          product,
        ).rows;
  const composed = (product: unknown) =>
    product !== null &&
    !!one(
      db,
      `SELECT 1 x FROM "erp_stock__composition" c JOIN "erp_stock__composition_item" ci ON ci.product_id=c.product_id AND ci.version=c.version WHERE c.product_id=?`,
      product,
    );
  type Line = { position: number; sub: number; key: string; item_id: unknown; component_id: unknown; product_id: unknown; description: unknown; code: unknown; unit: unknown; quantity: bigint | null; product: Record<string, unknown> | null };
  const lines: Line[] = [];
  for (const i of items) {
    const q = i.quantity === null ? null : fromColumn(i.quantity);
    if (!(split && composed(i.product_id))) {
      const data = JSON.parse(String(i.data));
      lines.push({
        position: Number(i.position), sub: 0, key: String(i.id), item_id: i.id, component_id: null, product_id: i.product_id,
        description: arrow(data, "description"), code: arrow(data, "code"), unit: arrow(data, "unit"),
        quantity: q, product: i.product_id === null ? null : catalogDto(db, String(i.product_id)),
      });
    } else
      for (const c of components(i.product_id))
        lines.push({
          position: Number(i.position), sub: Number(c.position), key: `${i.id}:${c.component_id}`, item_id: i.id, component_id: c.component_id,
          product_id: c.component_id, description: pgLeft(String(c.name), 200), code: c.code === null ? null : pgLeft(String(c.code), 100),
          unit: c.unit === null ? null : pgLeft(String(c.unit), 16),
          // c.quantity*i.quantity (escala 12) → numeric(24,6)
          quantity: q === null ? null : rescale(fromColumn(c.quantity) * q, 12, 6), product: catalogDto(db, String(c.component_id)),
        });
  }
  lines.sort((x, y) => x.position - y.position || x.sub - y.sub);
  return lines.map((l) => ({
    key: l.key, item_id: l.item_id, component_id: l.component_id, product_id: l.product_id, position: l.position,
    description: l.description, code: l.code, unit: l.unit, quantity: l.quantity === null ? null : formatScaled(l.quantity, 6),
    gtin: readableGtin(l.product === null ? null : arrow(l.product, "gtin")),
    gtin_tax: readableGtin(l.product === null ? null : arrow(l.product, "gtin_tax")),
    location: (() => {
      const v = l.product === null ? null : arrow(l.product, "location");
      return v === null || pgBtrim(v) === "" ? null : pgBtrim(v);
    })(),
  }));
}

/** erp_documents.checkout_view(p_id): o pedido, as linhas, as leituras salvas (limitadas à quantidade da linha) e as preferências. */
export function checkoutView(db: SqlDriver, id: string) {
  const d = one(db, 'SELECT id, number, version, status, contact_snapshot, body FROM "erp_documents__document" WHERE id=?', id);
  const c = one(db, 'SELECT reads, split, version FROM "erp_documents__checkout" WHERE document_id=?', id);
  const settings = checkoutSettings(db);
  const split = c ? bool(c.split) : settings.split;
  const lines = checkoutLines(db, id, split);
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const reads = (c ? (JSON.parse(String(c.reads)) as unknown[]) : []).flatMap((r) => {
    const key = arrow(r, "key");
    const l = key === null ? undefined : byKey.get(key);
    if (!l) return [];
    const rq = exact(arrow(r, "quantity")!),
      lq = exact(l.quantity!);
    return [{ key, quantity: formatScaled(rescale(rq < lq ? rq : lq, 30, 6), 6) }];
  });
  const snapshot = d ? JSON.parse(String(d.contact_snapshot)) : null;
  const body = d ? JSON.parse(String(d.body)) : null;
  const name = snapshot === null ? null : arrow(snapshot, "name");
  return {
    kind: "sales_orders",
    order: {
      id: d ? d.id : null,
      number: d && d.number !== null ? String(d.number) : null,
      version: d ? Number(d.version) : null,
      status: d ? d.status : null,
      contact_name: name === null ? null : pgLeft(name, 200),
      date: body === null ? null : arrow(body, "date"),
    },
    available: d ? ["open", "checkout_partial"].includes(String(d.status)) : null,
    split,
    lines,
    reads,
    checkout_version: c ? Number(c.version) : 0,
    settings,
    data_mode: "erp_native",
    operational_effects: false,
  };
}

/** (p_body->>'date')::date + n dias, como texto AAAA-MM-DD. */
const addDays = (date: string, days: number) => {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** erp_documents.sale_body_from_proposal(p_body): o corpo do pedido a partir da proposta (data prevista pelo prazo de entrega). */
export function saleBodyFromProposal(db: SqlDriver, body: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...body };
  delete out.other_items;
  delete out.commercial_conditions;
  out.template = false;
  if (preference(db, "propostas.data_prevista_prazo") === true) {
    const days = jsonPathText(body, ["commercial", "transport", "delivery_days"]);
    if (days !== null && /^(0|[1-9][0-9]{0,3})$/.test(days)) {
      const cross = preference(db, "estoque.cross_docking_dias");
      const extra = cross === null || cross === undefined ? 0 : Number(typeof cross === "string" ? cross : JSON.stringify(cross));
      const date = String(body.date);
      const expected = addDays(date, Number(days) + extra);
      if (expected <= "2099-12-31") out.expected_date = expected;
    }
  }
  return out;
}
