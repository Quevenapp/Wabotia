// Listagem e exportação de documentos (sessão L, bloco B2):
// public.erp_document_list (filtros, busca, cursor ou página, totais) e
// public.erp_document_export, com os mesmos nomes; erp_documents.list_row,
// list_conditions, list_condition, list_condition_value,
// list_conditions_match, list_totals_visible, address_text, warranty_until e
// order_invoice. O documento espelhado do Origin (authority 'origin') é lido
// como no oráculo: a linha de erp_document_mirror.list_row, o total e o número
// da fonte, a metadata do espelho na exportação (../mirror-reads.ts e o
// mirrorMetadata da O em ../mirror.ts).
// Semântica do Postgres mantida: ORDER BY … DESC põe NULL primeiro; p_kind
// nulo deixa as comparações nulas (três valores) e a validação não recusa.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { compareDec, formatScaled, fromColumn } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { valueJson } from "../../../engine/row-json.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower, pgUpper } from "../../../engine/text.ts";
import { ERP_TABLES } from "../../../schema/columns.generated.ts";
import { contactScope, contactVisibleTo, unitPriceNumeric } from "../../catalog/public.ts";
import { active as receiptActive } from "../../stock/public.ts";
import { originEffects } from "../../sync/public.ts";
import { dateValue, preference, situationAdopted, situationJson, situationKeyValid } from "../internal.ts";
import { mirrorListRow, mirrorSource, mirrorSourceMatches } from "../mirror-reads.ts";
import { mirrorMetadata } from "../mirror.ts";
import { mirrorVisible, requireAccess, transitions } from "../public.ts";
import { pendencies } from "./reads-commerce.ts";
import { jsonPathText } from "./reads-common.ts";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;
const DOC = ERP_TABLES.erp_documents__document.columns;
const I64_MAX = 9223372036854775807n;

// ---------------------------------------------------------------------------
// Ajudantes do documento

/** erp_documents.address_text(v): "rua, nº, compl. - bairro - cidade/UF - CEP …", ou null. */
export function addressText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const g = (k: string) => {
    const t = arrow(v, k);
    return t === null || t === "" ? null : t;
  };
  const join = (sep: string, parts: (string | null)[]) => parts.filter((p) => p !== null).join(sep);
  const street = join(", ", [g("street"), g("number"), g("complement")]);
  const city = join("/", [g("city"), g("state")]);
  const postal = g("postal_code");
  const out = join(" - ", [street === "" ? null : street, g("district"), city === "" ? null : city, postal === null ? null : "CEP " + arrow(v, "postal_code")]);
  return out === "" ? null : out;
}

/** (texto)::date + n dias. */
const plusDays = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);

/** erp_documents.warranty_until(p_body, p_base): fim da garantia, ou null sem dias de garantia. */
export function warrantyUntil(body: Obj, base: string): string | null {
  const days = arrow(body, "warranty_days");
  if (days === null) return null;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = arrow(body, k);
      if (v !== null) return v;
    }
    return null;
  };
  const from =
    base === "data_os" ? arrow(body, "date") : base === "data_prevista" ? pick("expected_date", "date") : base === "data_conclusao" ? pick("finish_date", "date") : pick("ship_date", "date");
  return from === null ? null : plusDays(from, Number(days));
}

/** erp_documents.order_invoice(p_id): a nota mais recente vinculada ao documento, ou null. */
export function orderInvoice(db: SqlDriver, id: string) {
  const n = db
    .exec(
      `SELECT n.model, n.number, n.series, n.issue_date, n.authorized_at, CAST(n.created_at AS TEXT) created_at FROM "erp_fiscal_invoices__invoice_order" o
         JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id WHERE o.document_id=? AND n.deleted_at IS NULL`,
      id,
    )
    .rows.sort((x, y) => pgCompareText(str(y.issue_date), str(x.issue_date)) || (BigInt(String(y.created_at)) > BigInt(String(x.created_at)) ? 1 : BigInt(String(y.created_at)) < BigInt(String(x.created_at)) ? -1 : 0))[0];
  return n ? { model: n.model, number: str(n.number), series: str(n.series), issue_date: str(n.issue_date), authorized: n.authorized_at !== null } : null;
}

/** erp_documents.list_totals_visible(p_user_id, p_kind): as preferências de exibir totais na listagem. */
export function listTotalsVisible(db: SqlDriver, user: string | null, kind: string | null): boolean {
  const notFalse = (key: string) => preference(db, key) !== false;
  if (kind === "sales_orders") {
    if (!notFalse("vendas.exibir_totais")) return false;
    const u = preference(db, "vendas.exibir_totais_usuarios");
    return Array.isArray(u) && u.length > 0 ? user !== null && u.includes(user) : true;
  }
  if (kind === "sales_proposals") return notFalse("propostas.exibir_totais");
  if (kind === "service_orders") return notFalse("os.exibir_totais");
  return true;
}

/** (a1,a2,…) < (b1,b2,…) do Postgres: o primeiro par diferente decide; NULL no par decisivo dá null. */
function rowLess(a: (string | bigint | null)[], b: (string | bigint | null)[], cmp: ((x: never, y: never) => number)[]): boolean | null {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null || b[i] === null) return null;
    const c = cmp[i](a[i] as never, b[i] as never);
    if (c !== 0) return c < 0;
  }
  return false;
}
const cmpBig = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);

/** erp_documents.list_row(p_id, p_fiscal, p_stock): a linha da listagem (documento nativo). */
export function listRow(ctx: RpcContext, id: string, fiscal: boolean, stock: boolean) {
  const db = ctx.db;
  const d = one(
    db,
    `SELECT d.*, CAST(d.total AS TEXT) total, CAST(d.created_at AS TEXT) created_at, CAST(d.updated_at AS TEXT) updated_at,
            w.name warehouse_name, p.number source_number, ds.situation_id
       FROM "erp_documents__document" d LEFT JOIN "erp_catalog__record" w ON w.id=d.warehouse_id
       LEFT JOIN "erp_documents__document" p ON p.id=d.source_proposal_id LEFT JOIN "erp_documents__document_situation" ds ON ds.document_id=d.id
      WHERE d.id=?`,
    id,
  );
  if (!d) return null;
  if (d.authority === "origin") return mirrorListRow(db, id);
  const body = JSON.parse(String(d.body)) as Obj;
  const snap = JSON.parse(String(d.contact_snapshot)) as Obj;
  const kind = String(d.kind);
  const nz = (v: string | null) => (v === null || v === "" ? null : v);
  const exists = (sql: string, ...args: unknown[]) => !!one(db, sql, ...args);
  const carrierId = arrow(body, "carrier_id");
  const carrier = carrierId === null ? null : one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', carrierId);
  const label = nz(jsonPathText(body, ["commercial", "transport", "carrier_reference", "label"]));
  const date = arrow(body, "date"),
    number = d.number === null ? null : BigInt(String(d.number));
  let firstSale = false;
  if (kind === "sales_orders" && d.status !== "cancelled") {
    firstSale = !db
      .exec(
        `SELECT o.number, o.body FROM "erp_documents__document" o WHERE o.authority='brufap' AND o.kind='sales_orders' AND o.contact_id=? AND o.status<>'cancelled' AND o.id<>?`,
        d.contact_id,
        id,
      )
      .rows.some(
        (o) =>
          rowLess(
            [arrow(JSON.parse(String(o.body)), "date"), o.number === null ? null : BigInt(String(o.number))],
            [date, number],
            [pgCompareText, cmpBig] as never,
          ) === true,
      );
  }
  const invoice = fiscal && ["sales_orders", "service_orders"].includes(kind) ? orderInvoice(db, id) : null;
  const so = one(
    db,
    'SELECT s.number FROM "erp_documents__sales_service_link" l JOIN "erp_documents__document" s ON s.id=l.service_order_id WHERE l.sales_order_id=?',
    id,
  );
  const sellerId = arrow(body, "seller_id");
  const seller = sellerId === null ? null : one(db, 'SELECT r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', sellerId);
  const version = one(
    db,
    'SELECT b.number, v.version_seq FROM "erp_documents__proposal_version" v JOIN "erp_documents__document" b ON b.id=v.base_id WHERE v.document_id=?',
    id,
  );
  const effects = originEffects(ctx, id);
  const delivery = body.delivery_address === undefined || body.delivery_address === null ? null : body.delivery_address;
  const address = addressText(delivery) ?? addressText(snap);
  return {
    id: d.id,
    kind,
    number: number === null ? null : String(number),
    status: d.status,
    version: Number(d.version),
    date,
    expected_date: arrow(body, "expected_date"),
    next_contact: arrow(body, "next_contact"),
    template: body.template === true,
    total: d.total === null ? null : formatScaled(fromColumn(d.total), 2),
    contact_id: d.contact_id,
    contact_name: arrow(snap, "name"),
    warehouse_id: d.warehouse_id,
    warehouse_name: stock ? d.warehouse_name : null,
    source_proposal_id: d.source_proposal_id,
    source_proposal_number: str(d.source_number),
    finance_active: exists(`SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active'`, id),
    stock_active: exists(`SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, id),
    receipt_active: kind === "purchase_orders" && receiptActive(db, id),
    reservation_active: stock ? kind === "sales_orders" && exists(`SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active'`, id) : null,
    fiscal_draft: fiscal && kind === "sales_orders" ? exists(`SELECT 1 x FROM "erp_fiscal_drafts__draft" WHERE source_document_id=? AND status='draft'`, id) : null,
    internal_notes: (() => {
      const n = arrow(body, "internal_notes");
      return n === null ? null : pgLeft(n, 280);
    })(),
    created_at: valueJson(DOC.created_at, d.created_at),
    updated_at: valueJson(DOC.updated_at, d.updated_at),
    customer_po_number: arrow(body, "customer_po_number"),
    ship_date: arrow(body, "ship_date"),
    contact_email: nz(arrow(snap, "email")),
    contact_phone: nz(arrow(snap, "phone")) ?? nz(arrow(snap, "mobile")),
    contact_document: nz(arrow(snap, "document")),
    address: address === null ? null : pgLeft(address, 500),
    carrier_name: carrier ? pgLeft(String(carrier.name), 200) : label === null ? null : pgLeft(label, 200),
    first_sale: firstSale,
    invoice,
    pendencies: kind === "sales_orders" && d.status !== "cancelled" && pendencies(db, id).length > 0,
    service_order_number: so ? str(so.number) : null,
    template_name: kind === "sales_proposals" ? arrow(body, "template_name") : null,
    situation: situationJson(db, kind, str(d.status), str(d.situation_id)),
    invoice_linked: ["sales_orders", "service_orders"].includes(kind) && orderInvoice(db, id) !== null,
    seller_id: sellerId !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sellerId) ? sellerId : null,
    seller_name: seller ? pgLeft(String(seller.name), 200) : null,
    version_label: version && version.number !== null ? `${version.number}-${version.version_seq}` : null,
    origin: d.origin,
    authority: d.authority,
    readonly: false,
    origin_finance: effects.finance,
    origin_invoice: effects.invoice,
  };
}

// ---------------------------------------------------------------------------
// Busca customizada (Adicionar filtros)

type Condition = { field: string; type: string; op: string; value: string | null };
const OPS = ["contains", "not_contains", "eq", "ne", "starts_with", "gt", "ge", "lt", "le", "empty", "not_empty"];

/** erp_documents.list_conditions(p_kind, p_custom): as condições validadas, ou null sem busca customizada. */
export function listConditions(db: SqlDriver, kind: string | null, custom: unknown): Condition[] | null {
  if (custom === null || custom === undefined) return null;
  const bad = () => raise("22023", "erp_document_query_invalid");
  if (jsonType(custom) !== "array" || (custom as unknown[]).length < 1 || (custom as unknown[]).length > 10) bad();
  const out: Condition[] = [];
  for (const c of custom as unknown[]) {
    const o = c as Obj;
    if (
      jsonType(c) !== "object" ||
      Object.keys(o).length !== 3 ||
      !("field" in o && "op" in o && "value" in o) ||
      jsonType(o.field) !== "string" ||
      jsonType(o.op) !== "string" ||
      (o.value !== null && jsonType(o.value) !== "string")
    )
      bad();
    const field = String(o.field),
      op = String(o.op),
      value = o.value === null ? null : String(o.value);
    let type: string | null = null,
      money = false,
      options: unknown[] = [];
    if (["contact_name", "contact_document", "contact_email", "contact_city", "contact_state", "notes", "internal_notes"].includes(field)) type = "text";
    else if (["date", "expected_date"].includes(field)) type = "date";
    else if (field === "number") type = "number";
    else if (["total", "discount", "freight"].includes(field)) (type = "number"), (money = true);
    else if (field === "ship_date" && (kind === "sales_orders" || kind === "service_orders")) type = "date";
    else if (field === "customer_po_number" && kind === "sales_orders") type = "text";
    else if (["valid_until", "next_contact"].includes(field) && kind === "sales_proposals") type = "date";
    else if (field === "order_reference" && kind === "purchase_orders") type = "text";
    else if (field === "finish_date" && kind === "service_orders") type = "date";
    else if (["equipment", "serial_number", "technician"].includes(field) && kind === "service_orders") type = "text";
    else if (kind === "service_orders" && /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(field)) {
      const f = one(db, 'SELECT field_type, options FROM "erp_documents__custom_field" WHERE id=? AND kind=?', field.slice(7), kind);
      if (!f) bad();
      const t = String(f!.field_type);
      type = t === "integer" || t === "decimal" ? "number" : t === "date" ? "date" : t === "boolean" ? "boolean" : t === "list" ? "option" : "text";
      options = JSON.parse(String(f!.options));
    }
    if (
      type === null ||
      !OPS.includes(op) ||
      (type === "text" && ["gt", "ge", "lt", "le"].includes(op)) ||
      (["number", "date"].includes(type) && ["contains", "not_contains", "starts_with"].includes(op)) ||
      (["boolean", "option"].includes(type) && !["eq", "ne", "empty", "not_empty"].includes(op)) ||
      (field === "number" && ["empty", "not_empty"].includes(op)) ||
      ["empty", "not_empty"].includes(op) !== (value === null)
    )
      bad();
    if (value !== null) {
      let ok: boolean;
      if (type === "text") ok = pgLength(pgBtrim(value)) >= 1 && pgLength(pgBtrim(value)) <= 120 && !pgHasCntrl.test(value);
      else if (type === "number")
        ok =
          field === "number"
            ? /^[1-9][0-9]{0,9}$/.test(value)
            : money
              ? /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(value)
              : /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/.test(value);
      else if (type === "date") ok = /^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value) && dateValue(value) === value;
      else if (type === "boolean") ok = value === "true" || value === "false";
      else ok = options.some((x) => arrow(x, "id") === value);
      if (!ok) bad();
    }
    out.push({ field, type: type!, op, value: type === "text" && value !== null ? pgBtrim(value) : value });
  }
  return out;
}

/** erp_documents.list_condition_value(d, p_field) */
function listConditionValue(d: { number: bigint | null; total: bigint | null; body: Obj; snap: Obj }, field: string): string | null {
  switch (field) {
    case "number":
      return d.number === null ? null : String(d.number);
    case "total":
      return d.total === null ? null : formatScaled(d.total, 2);
    case "discount":
      return jsonPathText(d.body, ["totals", "discount"]);
    case "freight":
      return jsonPathText(d.body, ["totals", "freight"]);
    case "contact_name":
      return arrow(d.snap, "name");
    case "contact_document":
      return arrow(d.snap, "document");
    case "contact_email":
      return arrow(d.snap, "email");
    case "contact_city":
      return arrow(d.snap, "city");
    case "contact_state":
      return arrow(d.snap, "state");
    default:
      return field.startsWith("custom:") ? jsonPathText(d.body, ["custom_fields", field.slice(7)]) : arrow(d.body, field);
  }
}

/** erp_documents.list_condition(p_type, p_op, p_actual, p_value) */
function listCondition(type: string, op: string, actual: string | null, value: string | null): boolean | null {
  const a = actual === null || pgBtrim(actual) === "" ? null : pgBtrim(actual);
  if (op === "empty") return a === null;
  if (op === "not_empty") return a !== null;
  if (a === null) return op === "ne" || op === "not_contains";
  const v = value!;
  if (type === "text") {
    const la = pgLower(a),
      lv = pgLower(v);
    switch (op) {
      case "contains":
        return la.includes(lv);
      case "not_contains":
        return !la.includes(lv);
      case "eq":
        return la === lv;
      case "ne":
        return la !== lv;
      case "starts_with":
        return pgLeft(la, pgLength(v)) === lv;
    }
    return null;
  }
  if (type === "number") {
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(a)) return op === "ne";
    const c = compareDec(a, v);
    return op === "eq" ? c === 0 : op === "ne" ? c !== 0 : op === "gt" ? c > 0 : op === "ge" ? c >= 0 : op === "lt" ? c < 0 : op === "le" ? c <= 0 : null;
  }
  if (type === "date") {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(a)) return op === "ne";
    const c = pgCompareText(a, v);
    return op === "eq" ? c === 0 : op === "ne" ? c !== 0 : op === "gt" ? c > 0 : op === "ge" ? c >= 0 : op === "lt" ? c < 0 : op === "le" ? c <= 0 : null;
  }
  return op === "eq" ? a === v : op === "ne" ? a !== v : null;
}

// ---------------------------------------------------------------------------
// Listagem

const ORDERS = ["date_desc", "date_asc", "number_desc", "number_asc", "id"];
const DATE_TYPES = ["date", "expected_date", "next_contact", "ship_date", "finish_date", "warranty_until"];
const UFS = /^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;
const DATE_TEXT = /^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/;

/** k in (lista) com k possivelmente nulo: null quando k é nulo (três valores). */
const kindIn = (kind: string | null, list: string[]): boolean | null => (kind === null ? null : list.includes(kind));
const not = (b: boolean | null) => (b === null ? null : !b);
/** a AND b em três valores. */
const and = (...xs: (boolean | null)[]) => (xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true);

/** numeric com a escala de exibição: o total da linha (coluna numeric(…,2) ou o source_total da fonte). */
type Num = { v: bigint; s: number };
type Filtered = { id: string; number: bigint | null; origin: string; day: string | null; total: Num | null };
/** (texto)::numeric, com a escala digitada; texto inválido dá o 22P02 do Postgres. */
function numericOf(text: string): Num {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[2] === "" && !m[3])) raise("22P02", `invalid input syntax for type numeric: "${text}"`);
  const frac = m![3] ?? "";
  const v = BigInt((m![2] || "0") + frac);
  return { v: m![1] === "-" ? -v : v, s: frac.length };
}
/** sum(numeric): a escala é a maior das parcelas. */
function sumNum(list: Num[]): Num {
  const s = list.reduce((m, x) => Math.max(m, x.s), 0);
  return { v: list.reduce((t, x) => t + x.v * 10n ** BigInt(s - x.s), 0n), s };
}

/** public.erp_document_list(…): a listagem de documentos com filtros, busca, ordem, cursor ou página e totais. */
export function erpDocumentList(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const s = (k: string) => str(a[k]);
  const user = s("p_user_id"),
    kind = s("p_kind"),
    after = s("p_after"),
    status = s("p_status"),
    query = s("p_query"),
    dateFrom = s("p_date_from"),
    dateTo = s("p_date_to"),
    order = s("p_order"),
    dateType = s("p_date_type"),
    warehouse = s("p_warehouse_id"),
    product = s("p_product_id"),
    city = s("p_city"),
    state = s("p_state"),
    technician = s("p_technician"),
    equipment = s("p_equipment"),
    serial = s("p_serial_number"),
    internalNote = s("p_internal_note"),
    postal = s("p_postal_code"),
    district = s("p_district"),
    tracking = s("p_tracking_code"),
    po = s("p_customer_po_number"),
    carrier = s("p_carrier"),
    email = s("p_contact_email"),
    seller = s("p_seller_id"),
    component = s("p_component_id"),
    service = s("p_service_id"),
    origin = s("p_origin");
  const limit = a.p_limit === null || a.p_limit === undefined ? null : Number(a.p_limit);
  const page = a.p_page === null || a.p_page === undefined ? null : Number(a.p_page);
  const template = a.p_template === null || a.p_template === undefined ? null : Boolean(a.p_template);
  const statusesArg = (a.p_statuses ?? null) as (string | null)[] | null;
  const situations = (a.p_situations ?? null) as (string | null)[] | null;
  const lots = (a.p_lots ?? null) as (string | null)[] | null;
  const warrantyPref = preference(db, "os.garantia_base");
  const warranty = warrantyPref === null || warrantyPref === undefined ? "nao_utilizar" : typeof warrantyPref === "string" ? warrantyPref : JSON.stringify(warrantyPref);
  const scope = contactScope(db, user);
  requireAccess(db, user, kind, false);
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const role = m ? String(m.role) : null;
  const fiscal = role !== null && ["admin", "fiscal"].includes(role);
  const stock = role !== null && ["admin", "consulta", "estoque", "vendas", "fiscal"].includes(role);
  const statuses = statusesArg !== null ? statusesArg : status !== null ? [status] : null;
  const kindMap = kind === null ? undefined : (transitions() as Record<string, object>)[kind];
  const distinctOk = (xs: (string | null)[]) => new Set(xs).size === xs.length;
  const len = (v: string | null, n: number) => v !== null && pgLength(v) > n;
  // Cada termo do OR do Postgres: só recusa o que é verdadeiro (nulo não recusa).
  const terms: (boolean | null)[] = [
    origin === null || !["all", "origin", "brufap"].includes(origin),
    limit === null || limit < 1 || limit > 100,
    status !== null && statusesArg !== null,
    statuses !== null &&
      (statuses.length < 1 ||
        statuses.length > 20 ||
        statuses.includes(null) ||
        // (transitions()->p_kind)?s: sem o tipo no mapa (p_kind nulo) o ? dá NULL e não recusa.
        statuses.some((x) => x !== null && !["deleted", "source_unknown"].includes(x) && kindMap !== undefined && !Object.prototype.hasOwnProperty.call(kindMap, x)) ||
        !distinctOk(statuses)),
    situations !== null &&
      (statuses !== null ||
        !situationAdopted(db, kind) ||
        situations.length < 1 ||
        situations.length > 50 ||
        situations.includes(null) ||
        situations.some((x) => !situationKeyValid(db, kind, x)) ||
        !distinctOk(situations)),
    query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query)),
    dateFrom !== null && !DATE_TEXT.test(dateFrom),
    dateTo !== null && !DATE_TEXT.test(dateTo),
    page !== null && (page < 1 || page > 100000 || after !== null),
    order === null || !ORDERS.includes(order),
    dateType === null || !DATE_TYPES.includes(dateType),
    and(dateType === "next_contact", not(kindIn(kind, ["sales_proposals"]))),
    and(dateType === "ship_date", not(kindIn(kind, ["sales_orders", "service_orders"]))),
    and(dateType === "finish_date" || dateType === "warranty_until", not(kindIn(kind, ["service_orders"]))),
    and(city !== null || state !== null, not(kindIn(kind, ["sales_orders", "sales_proposals"]))),
    and(technician !== null || equipment !== null || serial !== null, not(kindIn(kind, ["service_orders"]))),
    and(internalNote !== null, not(kindIn(kind, ["purchase_orders"]))),
    and(postal !== null || district !== null || tracking !== null || po !== null || carrier !== null, not(kindIn(kind, ["sales_orders"]))),
    and(email !== null || template !== null, not(kindIn(kind, ["sales_proposals"]))),
    and(seller !== null, not(kindIn(kind, ["sales_orders", "sales_proposals", "service_orders"]))),
    and(component !== null, not(kindIn(kind, ["sales_orders"]))),
    and(service !== null, not(kindIn(kind, ["service_orders"]))),
    lots === null
      ? false
      : (() => {
          const rest =
            lots.length < 1 ||
            lots.length > 50 ||
            lots.includes(null) ||
            lots.some((x) => x !== null && (pgLength(pgBtrim(x)) < 1 || pgLength(pgBtrim(x)) > 60 || pgHasCntrl.test(x)));
          const k = not(kindIn(kind, ["sales_orders", "service_orders"]));
          return k === true || rest ? true : k === null ? null : false;
        })(),
    len(city, 100) || len(technician, 200) || len(equipment, 200) || len(serial, 100) || len(internalNote, 200),
    len(district, 100) || len(tracking, 200) || len(po, 60) || len(carrier, 200) || len(email, 254),
    postal !== null && !/^[0-9]{1,8}$/.test(postal),
    pgHasCntrl.test([city, technician, equipment, serial, internalNote, district, tracking, po, carrier, email].map((x) => x ?? "").join("")),
    state !== null && !UFS.test(state),
  ];
  if (terms.some((t) => t === true)) raise("22023", "erp_document_query_invalid");
  const low = (v: string | null) => (v === null || pgBtrim(v) === "" ? null : pgLower(pgBtrim(v)));
  const vCity = low(city),
    vTech = low(technician),
    vEquip = low(equipment),
    vSerial = low(serial),
    vNote = low(internalNote),
    vDistrict = low(district),
    vTracking = low(tracking),
    vPo = low(po),
    vCarrier = low(carrier),
    vEmail = low(email);
  if (
    (city !== null && vCity === null) ||
    (technician !== null && vTech === null) ||
    (equipment !== null && vEquip === null) ||
    (serial !== null && vSerial === null) ||
    (internalNote !== null && vNote === null) ||
    (district !== null && vDistrict === null) ||
    (tracking !== null && vTracking === null) ||
    (po !== null && vPo === null) ||
    (carrier !== null && vCarrier === null) ||
    (email !== null && vEmail === null)
  )
    raise("22023", "erp_document_query_invalid");
  const vLots = lots === null ? null : new Set(lots.map((x) => pgLower(pgBtrim(x!))));
  const conditions = listConditions(db, kind, a.p_custom ?? null);
  const vFrom = dateValue(dateFrom),
    vTo = dateValue(dateTo);
  if (vFrom !== null && vTo !== null && vFrom > vTo) raise("22023", "erp_document_period_invalid");
  const q = query === null || pgBtrim(query) === "" ? null : pgLower(pgBtrim(query));
  let digits = q !== null && /^[0-9./ -]+$/.test(q) ? q.replace(/[^0-9]/g, "") : null;
  if (digits !== null && digits.length < 5) digits = null;
  let cursor: { day: string | null; number: bigint | null } | null = null;
  if (after !== null && order !== "id") {
    const c = one(db, 'SELECT number, body, contact_id, origin FROM "erp_documents__document" WHERE id=? AND kind=?', after, kind);
    if (!c || !mirrorVisible(db, user, after) || !(origin === "all" || c.origin === origin)) raise("22023", "erp_document_cursor_invalid");
    cursor = { day: arrow(JSON.parse(String(c!.body)), "date"), number: c!.number === null ? null : BigInt(String(c!.number)) };
  }
  const offset = page === null ? 0 : (page - 1) * limit!;

  const filtered: Filtered[] = [];
  const has = (hay: string | null, needle: string) => pgLower(hay ?? "").includes(needle);
  for (const d of db.exec(
    `SELECT d.id, d.number, d.origin, d.authority, d.status, d.deleted_at, d.contact_id, d.warehouse_id, d.body, d.contact_snapshot, CAST(d.total AS TEXT) total, ds.situation_id
       FROM "erp_documents__document" d LEFT JOIN "erp_documents__document_situation" ds ON ds.document_id=d.id
      WHERE d.kind=? AND NOT EXISTS(SELECT 1 FROM "erp_documents__origin_mirror" bm WHERE bm.document_id=d.id AND bm.source_deleted=1)`,
    kind,
  ).rows) {
    if (!(origin === "all" || d.origin === origin)) continue;
    if (statuses !== null && statuses.includes("deleted")) {
      if (d.deleted_at === null) continue;
    } else if (d.deleted_at !== null || (statuses !== null && !statuses.includes(String(d.status)))) continue;
    if (situations !== null && !situations.includes(str(d.situation_id) ?? String(d.status))) continue;
    const body = JSON.parse(String(d.body)) as Obj;
    const snap = JSON.parse(String(d.contact_snapshot)) as Obj;
    if (seller !== null && arrow(body, "seller_id") !== seller) continue;
    if (scope !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" cp WHERE cp.record_id=? AND cp.seller_id=?', d.contact_id, scope)) continue;
    if (
      component !== null &&
      !one(
        db,
        `SELECT 1 x FROM "erp_documents__item" i JOIN "erp_stock__composition" c ON c.product_id=i.product_id
           JOIN "erp_stock__composition_item" ci ON ci.product_id=c.product_id AND ci.version=c.version WHERE i.document_id=? AND ci.component_id=?`,
        d.id,
        component,
      )
    )
      continue;
    if (vFrom !== null || vTo !== null) {
      const inRange = (v: string | null) => (vFrom === null || (v !== null && v >= dateFrom!)) && (vTo === null || (v !== null && v <= dateTo!));
      let ok = false;
      if (dateType === "warranty_until") {
        if (arrow(body, "warranty_days") !== null) {
          const w = warrantyUntil(body, warranty);
          ok = (vFrom === null || (w !== null && w >= vFrom)) && (vTo === null || (w !== null && w <= vTo));
        }
      } else ok = inRange(arrow(body, dateType!));
      if (!ok) continue;
    }
    if (warehouse !== null && d.warehouse_id !== warehouse) continue;
    if (product !== null && !one(db, 'SELECT 1 x FROM "erp_documents__item" WHERE document_id=? AND product_id=?', d.id, product)) continue;
    if (service !== null && !one(db, 'SELECT 1 x FROM "erp_documents__item" WHERE document_id=? AND product_id=?', d.id, service)) continue;
    if (vLots !== null) {
      let hit = false;
      for (const i of db.exec('SELECT data FROM "erp_documents__item" WHERE document_id=?', d.id).rows) {
        const lotsOf = (JSON.parse(String(i.data)) as Obj).lots;
        if (!Array.isArray(lotsOf)) continue;
        for (const l of lotsOf) {
          const lotId = arrow(l, "lot_id");
          const x = lotId === null ? null : one(db, 'SELECT code FROM "erp_stock__lot" WHERE id=?', lotId);
          if (x && vLots.has(pgLower(String(x.code)))) hit = true;
        }
      }
      if (!hit)
        for (const x of db.exec(
          `SELECT x.code FROM "erp_stock__document_posting" sp JOIN "erp_stock__lot_entry" e ON e.movement_id=sp.movement_id JOIN "erp_stock__lot" x ON x.id=e.lot_id
            WHERE sp.document_id=? AND sp.state='active'`,
          d.id,
        ).rows)
          if (vLots.has(pgLower(String(x.code)))) hit = true;
      if (!hit) continue;
    }
    const number = d.number === null ? null : BigInt(String(d.number));
    const total = d.total === null ? null : fromColumn(d.total);
    if (conditions !== null && !conditions.every((c) => listCondition(c.type, c.op, listConditionValue({ number, total, body, snap }, c.field), c.value) === true)) continue;
    if (vCity !== null && !has(arrow(snap, "city"), vCity)) continue;
    if (state !== null && pgUpper(arrow(snap, "state") ?? "") !== state) continue;
    if (vTech !== null && !has(arrow(body, "technician"), vTech)) continue;
    if (vEquip !== null && !has(arrow(body, "equipment"), vEquip)) continue;
    if (vSerial !== null && !has(arrow(body, "serial_number"), vSerial)) continue;
    if (vNote !== null && !has(arrow(body, "internal_notes"), vNote)) continue;
    if (
      postal !== null &&
      !(
        (arrow(snap, "postal_code") ?? "").replace(/[^0-9]/g, "").startsWith(postal) ||
        (jsonPathText(body, ["delivery_address", "postal_code"]) ?? "").startsWith(postal)
      )
    )
      continue;
    if (vDistrict !== null && !(has(arrow(snap, "district"), vDistrict) || has(jsonPathText(body, ["delivery_address", "district"]), vDistrict))) continue;
    if (vTracking !== null && !has(jsonPathText(body, ["commercial", "transport", "tracking_code"]), vTracking)) continue;
    if (vPo !== null && !has(arrow(body, "customer_po_number"), vPo)) continue;
    if (vCarrier !== null) {
      const label = jsonPathText(body, ["commercial", "transport", "carrier_reference", "label"]);
      const cid = arrow(body, "carrier_id");
      const r = cid === null ? null : one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', cid);
      if (!(has(label, vCarrier) || (r !== null && pgLower(String(r.name)).includes(vCarrier)))) continue;
    }
    if (vEmail !== null && !has(arrow(snap, "email"), vEmail)) continue;
    if (template !== null && (body.template === true) !== template) continue;
    if (q !== null) {
      const hit =
        (number !== null && String(number).includes(q)) ||
        String(d.id) === q ||
        has(arrow(snap, "name"), q) ||
        has(arrow(snap, "trade_name"), q) ||
        has(arrow(snap, "code"), q) ||
        has(arrow(snap, "email"), q) ||
        mirrorSourceMatches(mirrorSource(db, String(d.id)), q) ||
        (kind === "purchase_orders" && has(arrow(body, "order_reference"), q)) ||
        (digits !== null && (arrow(snap, "document") ?? "").replace(/[^0-9]/g, "").includes(digits)) ||
        (digits !== null && kind === "service_orders" && (arrow(snap, "postal_code") ?? "").replace(/[^0-9]/g, "").includes(digits));
      if (!hit) continue;
    }
    // O total da linha: o da fonte (reconciliation->>'source_total') no documento espelhado, senão a coluna.
    let rowTotal: Num | null;
    if (d.authority === "origin") {
      const source = mirrorSource(db, String(d.id));
      rowTotal = source === null || source.source_total === null ? null : numericOf(source.source_total);
    } else rowTotal = total === null ? null : { v: total, s: 2 };
    filtered.push({ id: String(d.id), number, origin: String(d.origin), day: arrow(body, "date"), total: rowTotal });
  }

  // ORDER BY: id asc; date_desc: day desc (NULL primeiro), number desc (NULL primeiro), id desc; date_asc: day, number (NULL por último), id.
  const descNull = <T>(x: T | null, y: T | null, c: (a: T, b: T) => number) => (x === y ? 0 : x === null ? -1 : y === null ? 1 : -c(x, y));
  const ascNull = <T>(x: T | null, y: T | null, c: (a: T, b: T) => number) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : c(x, y));
  const sortKey = (x: Filtered, y: Filtered) => {
    switch (order) {
      case "date_desc":
        return descNull(x.day, y.day, pgCompareText) || descNull(x.number, y.number, cmpBig) || -pgCompareText(x.id, y.id);
      case "date_asc":
        return ascNull(x.day, y.day, pgCompareText) || ascNull(x.number, y.number, cmpBig) || pgCompareText(x.id, y.id);
      case "number_desc":
        return descNull(x.number, y.number, cmpBig) || -pgCompareText(x.id, y.id);
      case "number_asc":
        return ascNull(x.number, y.number, cmpBig) || pgCompareText(x.id, y.id);
      default:
        return pgCompareText(x.id, y.id);
    }
  };
  const tuple = (day: string | null, number: bigint | null, id: string, withDay: boolean) =>
    withDay ? [day ?? "9999-12-31", number ?? I64_MAX, id] : [number ?? I64_MAX, id];
  const cmpTuple = (x: (string | bigint)[], y: (string | bigint)[]) => {
    for (let i = 0; i < x.length; i++) {
      const c = typeof x[i] === "bigint" ? cmpBig(x[i] as bigint, y[i] as bigint) : pgCompareText(x[i] as string, y[i] as string);
      if (c) return c;
    }
    return 0;
  };
  const afterCursor = (f: Filtered) => {
    if (after === null) return true;
    if (order === "id") return pgCompareText(f.id, after) > 0;
    const withDay = order === "date_desc" || order === "date_asc";
    const c = cmpTuple(tuple(f.day, f.number, f.id, withDay), tuple(cursor!.day, cursor!.number, after, withDay));
    return order === "date_desc" || order === "number_desc" ? c < 0 : c > 0;
  };
  const ordered = filtered.filter(afterCursor).sort(sortKey);
  const pageRows = ordered.slice(offset, offset + limit! + 1);
  const shown = pageRows.slice(0, limit!);
  const more = pageRows.length > limit!;
  const totals = listTotalsVisible(db, user, kind);
  const known = filtered.filter((f) => f.total !== null);
  const sum = sumNum(known.map((f) => f.total!));
  const originTotals: Record<string, unknown> = {};
  for (const o of ["brufap", "origin"]) {
    const rows = filtered.filter((f) => f.origin === o);
    const k = rows.filter((f) => f.total !== null);
    const s2 = sumNum(k.map((f) => f.total!));
    // coalesce(sum(total),0)::text: sem parcela, "0"; com parcelas, a maior escala delas.
    originTotals[o] = { count: rows.length, known_total_count: k.length, total: rows.length === k.length ? (k.length ? formatScaled(s2.v, s2.s) : "0") : null };
  }
  // v_amount::numeric(20,2): só sem linha do espelho, então a soma está na escala 2 da coluna.
  const amount = filtered.every((f) => f.origin !== "origin") && known.length === filtered.length ? sum.v * 10n ** BigInt(2 - Math.min(sum.s, 2)) : null;
  return {
    kind,
    items: shown.map((f) => listRow(ctx, f.id, fiscal, stock)),
    limit,
    page,
    order,
    has_more: more,
    next_cursor: more ? shown[shown.length - 1].id : null,
    total_count: filtered.length,
    origin,
    origin_totals: totals ? originTotals : null,
    total_amount: totals && amount !== null ? formatScaled(amount, 2) : null,
    ...NATIVE,
  };
}

// ---------------------------------------------------------------------------
// Exportação

/** public.erp_document_export(p_user_id, p_kind, p_date_from, p_date_to, p_page): documentos do período com itens, 25 por página. */
export function erpDocumentExport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    from = str(a.p_date_from),
    to = str(a.p_date_to);
  const page = a.p_page === null || a.p_page === undefined ? null : Number(a.p_page);
  const size = 25;
  const scope = contactScope(db, user);
  requireAccess(db, user, kind, false);
  if (page === null || page < 1 || page > 200 || from === null || to === null || !DATE_TEXT.test(from) || !DATE_TEXT.test(to))
    raise("22023", "erp_document_query_invalid");
  const vFrom = dateValue(from, true)!,
    vTo = dateValue(to, true)!;
  if (vFrom > vTo || (Date.parse(vTo + "T00:00:00Z") - Date.parse(vFrom + "T00:00:00Z")) / 86_400_000 > 366) raise("22023", "erp_document_period_invalid");
  const docs = db
    .exec(
      `SELECT d.*, CAST(d.total AS TEXT) total, ds.situation_id FROM "erp_documents__document" d
         LEFT JOIN "erp_documents__document_situation" ds ON ds.document_id=d.id
        WHERE d.kind=? AND NOT EXISTS(SELECT 1 FROM "erp_documents__origin_mirror" bm WHERE bm.document_id=d.id AND bm.source_deleted=1)`,
      kind,
    )
    .rows.map((d): Row & { b: Obj; c: Obj } => ({ ...(d as Row), b: JSON.parse(String(d.body)) as Obj, c: JSON.parse(String(d.contact_snapshot)) as Obj }))
    .filter((d) => {
      const day = arrow(d.b, "date");
      return day !== null && day >= from && day <= to && contactVisibleTo(db, scope, str(d.contact_id));
    });
  if (docs.length > 5000) raise("22023", "erp_document_export_limit");
  docs.sort(
    (x, y) =>
      pgCompareText(arrow(x.b, "date"), arrow(y.b, "date")) ||
      (x.number === y.number ? 0 : x.number === null ? 1 : y.number === null ? -1 : cmpBig(BigInt(String(x.number)), BigInt(String(y.number)))) ||
      pgCompareText(String(x.id), String(y.id)),
  );
  const items = docs.slice((page - 1) * size, page * size).map((p) => {
    // Documento espelhado: só leitura, com a metadata do espelho, o número e o total da fonte e os itens como observados.
    const mirrored = p.authority === "origin";
    const source = mirrored ? mirrorSource(db, String(p.id)) : null;
    const notes = arrow(p.b, "internal_notes");
    const situation = situationJson(db, String(p.kind), str(p.status), str(p.situation_id));
    return {
      id: p.id,
      origin: p.origin,
      authority: p.authority,
      readonly: mirrored,
      mirror: mirrored ? mirrorMetadata(db, String(p.id)) : null,
      number: mirrored ? (source?.source_number ?? null) : p.number === null ? null : String(p.number),
      date: arrow(p.b, "date"),
      expected_date: arrow(p.b, "expected_date"),
      status: p.status,
      situation_name: situation === null ? null : arrow(situation, "name"),
      contact_name: arrow(p.c, "name"),
      contact_document: (() => {
        const v = arrow(p.c, "document");
        return v === "" ? null : v;
      })(),
      order_reference: p.kind === "purchase_orders" ? arrow(p.b, "order_reference") : null,
      internal_notes: notes === null ? null : pgLeft(notes, 4000),
      freight: arrow(p.b, "freight"),
      discount: jsonPathText(p.b, ["totals", "discount"]),
      total: mirrored ? (source?.source_total ?? null) : p.total === null ? null : formatScaled(fromColumn(p.total), 2),
      items: db
        .exec(
          'SELECT position, data, CAST(quantity AS TEXT) quantity, unit_price, discount_percent, CAST(total AS TEXT) total FROM "erp_documents__item" WHERE document_id=?',
          p.id,
        )
        .rows.sort((x, y) => Number(x.position) - Number(y.position))
        .map((i) => {
          const data = JSON.parse(String(i.data));
          return {
            position: Number(i.position),
            code: arrow(data, "code"),
            description: arrow(data, "description"),
            unit: arrow(data, "unit"),
            quantity: mirrored ? arrow(data, "quantity") : i.quantity === null ? null : formatScaled(fromColumn(i.quantity), 6),
            unit_price: mirrored ? arrow(data, "unit_price") : unitPriceNumeric(i.unit_price, 10),
            discount_percent: mirrored
              ? arrow(data, "discount_percent")
              : i.discount_percent === null
                ? null
                : formatScaled(fromColumn(i.discount_percent), 4),
            total: mirrored ? arrow(data, "total") : i.total === null ? null : formatScaled(fromColumn(i.total), 2),
          };
        }),
    };
  });
  return {
    kind,
    date_from: from,
    date_to: to,
    page,
    size,
    total_count: docs.length,
    has_more: page * size < docs.length,
    items,
    ...NATIVE,
  };
}

registerRpc("erp_document_list", erpDocumentList);
registerRpc("erp_document_export", erpDocumentExport);
