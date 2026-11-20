// Uma linha da planilha pelas operações dos respectivos domínios. Definições
// finais: 228 (lookups), 265 (custom_value), 283 (item_e) e 300 (item/lot).
import { boolIn } from "../../engine/args.ts";
import { formatScaled, fromColumn, rescale } from "../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { notPorted, raise } from "../../engine/errors.ts";
import { arrow, jsonbText } from "../../engine/json.ts";
import { invokeRpc, type RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgLeft, pgLower } from "../../engine/text.ts";
import { saoPauloParts } from "../../engine/time.ts";
import { compact, compositionKits, compositionSync, compositionSyncOn, unitPriceNumeric } from "../catalog/public.ts";
import { get } from "./public.ts";

type Data = Record<string, unknown>;
export interface ImportItemResult {
  action: "create" | "update";
  record_id: string | null;
  reference: string | null;
  unchanged: boolean;
}
const value = (v: unknown) => v === null || v === undefined ? null : String(v);
const lowerName = (v: unknown) => v === null || v === undefined ? null : pgLower(pgBtrim(String(v)));
function stripNulls(v: Data): Data {
  const nested = (x: unknown): unknown => Array.isArray(x) ? x.map(nested) : x !== null && typeof x === "object" ? stripNulls(x as Data) : x;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([key, x]) => [key, nested(x)]));
}
const short = (v: string | null, n = 120) => v === null ? null : pgLeft(v, n);
const reference = (...parts: (string | null)[]) => parts.some((p) => p === null) ? null : parts.join("");
export const importFail = (reason: string, state = "22023"): never => raise(state, reason);

/** SQL NULL não produz elementos; JSON null e outros escalares recusam. */
function elements(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) raise("22023", `cannot extract elements from ${value !== null && typeof value === "object" ? "an object" : "a scalar"}`);
  return value as unknown[];
}
const jsonValue = (v: unknown, key: string) => v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Data)[key] : undefined;
const jsonHas = (v: unknown, key: string) => Array.isArray(v) ? v.includes(key) : typeof v === "string" ? v === key : v !== null && typeof v === "object" && key in v;

/** Cast numeric antes do RPC do domínio; mantém escala até o cast final. */
function numeric(text: string | null): { n: bigint; scale: number; special?: string } | null {
  if (text === null) return null;
  const raw = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
  if (/^[+-]?(inf(inity)?|nan)$/i.test(raw)) return { n: 0n, scale: 0, special: /nan/i.test(raw) ? "NaN" : raw.startsWith("-") ? "-Infinity" : "Infinity" };
  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m) return raise("22P02", `invalid input syntax for type numeric: "${text}"`);
  const exponent = Number(m[5] ?? 0), fraction = m[3] ?? m[4] ?? "", digits = (m[2] ?? "0") + fraction;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 131072 || digits.length - fraction.length + exponent > 131072 || fraction.length - exponent > 16383)
    return raise("22003", "value overflows numeric format");
  const scale = fraction.length - exponent, n = BigInt(digits) * (m[1] === "-" ? -1n : 1n);
  return scale < 0 ? { n: n * 10n ** BigInt(-scale), scale: 0 } : { n, scale };
}

function unique(rows: Row[], field: string, required = true): string | null {
  if (rows.length > 1) importFail(`erp_preferences_import_ambiguous:${field}`);
  if (rows.length === 0 && required) importFail(`erp_preferences_import_not_found:${field}`);
  return rows.length ? String(rows[0].id) : null;
}

export function importProduct(db: SqlDriver, code: string | null, field: string, required: boolean): string | null {
  return unique(db.exec(`SELECT r.id FROM erp_catalog__record r WHERE r.entity='products' AND r.code=?
    AND NOT EXISTS(SELECT 1 FROM erp_catalog__product_detail d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL) ORDER BY r.id`, code).rows, field, required);
}

function contacts(db: SqlDriver) {
  return db.exec(`SELECT r.id,r.name,c.document FROM erp_catalog__record r
    LEFT JOIN erp_catalog__contact c ON c.record_id=r.id LEFT JOIN erp_catalog__contact_profile p ON p.record_id=r.id
    WHERE r.entity='contacts' AND coalesce(p.situation,'A')<>'E' ORDER BY r.id`).rows;
}

export function importContact(db: SqlDriver, name: string | null, document: string | null, fieldName: string, fieldDocument: string): string {
  return unique(contacts(db).filter((r) => document !== null ? compact(value(r.document)) === document : lowerName(r.name) === lowerName(name) && name !== null),
    document === null ? fieldName : fieldDocument)!;
}

export function importNamed(db: SqlDriver, kind: string, name: string | null, field: string, titleKind: string | null = null): string | null {
  if (name === null) return null;
  let rows: Row[] = [];
  if (kind === "categories" || kind === "product_groups") rows = db.exec("SELECT id,name FROM erp_catalog__taxonomy WHERE kind=?", kind).rows;
  else if (kind === "warehouses") rows = db.exec("SELECT id,name FROM erp_catalog__record WHERE entity='warehouses' AND active=1").rows;
  else if (kind === "finance_categories") rows = db.exec("SELECT id,name FROM erp_finance__category WHERE active=1 AND deleted_at IS NULL AND kind IN(?,'both')", titleKind).rows;
  else if (kind === "accounts") rows = db.exec("SELECT id,name FROM erp_finance__account WHERE active=1 AND deleted_at IS NULL").rows;
  else if (kind === "payment_methods") rows = db.exec("SELECT id,description name FROM erp_catalog__payment_method WHERE active=1 AND deleted_at IS NULL AND applicable IN('ambos',?)", titleKind === "receivable" ? "recebimentos" : "pagamentos").rows;
  return unique(rows.filter((r) => lowerName(r.name) === lowerName(name)), field);
}

export function importCustomValue(db: SqlDriver, field: Row, text: string | null): string {
  const v = pgBtrim(text ?? "");
  if (!v) importFail("erp_preferences_import_required:item_value");
  if (field.field_type === "list") return unique(db.exec("SELECT id,label FROM erp_catalog__custom_field_option WHERE field_id=? ORDER BY position", field.id).rows
    .filter((r) => pgLower(String(r.label)) === pgLower(v)), "item_value")!;
  if (field.field_type === "boolean") {
    if (["sim", "s", "true", "1", "x", "verdadeiro"].includes(pgLower(v))) return "true";
    if (["não", "nao", "n", "false", "0", "falso"].includes(pgLower(v))) return "false";
    importFail("erp_preferences_import_invalid:item_value");
  }
  if (field.field_type === "date") {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
  }
  return field.field_type === "decimal" && v.includes(",") ? v.replaceAll(".", "").replaceAll(",", ".") : v;
}

function saveProduct(ctx: RpcContext, user: string, id: string | null, version: number, command: string, patch: Data | null) {
  return invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: patch, p_acknowledged: null }) as { record: Data };
}
const versionOf = (db: SqlDriver, id: string) => Number(one(db, "SELECT version FROM erp_catalog__record WHERE id=?", id)!.version);
const result = (action: ImportItemResult["action"], id: unknown, ref: string | null, unchanged = false): ImportItemResult => ({ action, record_id: value(id), reference: short(ref), unchanged });

export function importItemE(ctx: RpcContext, user: string, kind: string, command: string, data: Data): ImportItemResult {
  const db = ctx.db, code = arrow(data, "code"), id = importProduct(db, code, "code", true)!, version = versionOf(db, id);
  if (kind === "compositions") {
    const items = elements(data.items).map((item) => ({ component_id: importProduct(db, arrow(item, "code"), "item_code", true), quantity: arrow(item, "quantity") }));
    const stockType = arrow(data, "stock_type"), post = arrow(data, "post_mode") ?? (stockType === "virtual" ? "components" : null);
    if (post === null) importFail("erp_preferences_import_required:post_mode");
    if (stockType === "virtual" && post !== "components") importFail("erp_preferences_import_invalid:post_mode");
    const composition = one(db, "SELECT version FROM erp_stock__composition WHERE product_id=?", id);
    invokeRpc(ctx, "erp_stock_product_compose", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command,
      p_data: { format: "E" }, p_acknowledged: null, p_composition: { expected_version: composition?.version ?? 0, stock_type: data.stock_type ?? null, post_mode: post, items } });
    return result(composition ? "update" : "create", id, reference("Composição ", code, ` · ${items.length} componente(s)`));
  }
  if (kind === "custom_fields") {
    const values: Data = {};
    for (const item of elements(data.items)) {
      const name = arrow(item, "field");
      const fields = db.exec("SELECT * FROM erp_catalog__custom_field WHERE module='products'").rows
        .filter((r) => name !== null && pgLower(String(r.name)) === pgLower(pgBtrim(name)));
      const fieldId = unique(fields, "item_field")!;
      if (fieldId in values) importFail("erp_preferences_import_duplicate:item_field");
      values[fieldId] = importCustomValue(db, fields[0], arrow(item, "value"));
    }
    const out = saveProduct(ctx, user, id, version, command, { custom_values: values });
    return result("update", id, code, Number(out.record.version) === version);
  }
  if (kind === "product_suppliers") {
    const supplier = importContact(db, arrow(data, "supplier_name"), arrow(data, "supplier_document"), "supplier_name", "supplier_document");
    const old = db.exec("SELECT * FROM erp_catalog__product_supplier WHERE record_id=? ORDER BY position", id).rows.map((s) => ({
      supplier_id: s.supplier_id, description: s.description ?? null, code: s.code ?? null,
      purchase_price: unitPriceNumeric(s.purchase_price, 14), cost_price: unitPriceNumeric(s.cost_price, 14),
      warranty_months: value(s.warranty_months), is_default: !!s.is_default,
    }));
    const rawDefault = arrow(data, "is_default"), isDefault = rawDefault === null ? null : boolIn(rawDefault);
    let found = false;
    const list = old.map((entry) => {
      if (entry.supplier_id === supplier) {
        found = true;
        return { ...entry, ...stripNulls({ code: data.supplier_code, description: data.description, purchase_price: data.purchase_price,
          cost_price: data.cost_price, warranty_months: data.warranty_months }), ...(isDefault === null ? {} : { is_default: isDefault }) };
      }
      return isDefault ? { ...entry, is_default: false } : entry;
    });
    if (!found) list.push({ supplier_id: supplier, description: data.description ?? null, code: data.supplier_code ?? null,
      purchase_price: data.purchase_price ?? null, cost_price: data.cost_price ?? null, warranty_months: data.warranty_months ?? null,
      is_default: isDefault ?? old.length === 0 } as (typeof list)[number]);
    if (found && jsonbText(list) === jsonbText(old)) return result("update", id, code, true);
    const kits = compositionSyncOn(ctx) ? compositionKits(db, [id]) : [];
    const out = saveProduct(ctx, user, id, version, command, { suppliers: list });
    if (kits.length && Number(out.record.version) !== version) compositionSync(ctx, user, command, compositionKits(db, [id]));
    return result(found ? "update" : "create", id, reference(code, " · ", arrow(data, "supplier_name") ?? arrow(data, "supplier_document")), Number(out.record.version) === version);
  }
  return importFail("erp_preferences_import_kind_invalid");
}

export function importItemLot(ctx: RpcContext, user: string, command: string, data: Data): ImportItemResult {
  const id = importProduct(ctx.db, arrow(data, "code"), "code", true);
  const out = invokeRpc(ctx, "erp_stock_lot_import", { p_user_id: user, p_command_id: command, p_product_id: id, p_code: arrow(data, "lot"),
    p_manufactured_on: arrow(data, "manufactured_on"), p_expires_on: arrow(data, "expires_on"), p_note: arrow(data, "note") }) as { outcome: string; lot: Data };
  return result(out.outcome === "created" ? "create" : "update", out.lot.id, reference("Lote ", arrow(data, "lot"), " · ", arrow(data, "code")), out.outcome === "unchanged");
}

export function importItem(ctx: RpcContext, user: string, kind: string, command: string, file: string, input: Data | undefined): ImportItemResult {
  // A ausência de data no envelope é SQL NULL, não um objeto vazio. Os
  // cadastros recusam esse argumento; os demais ramos falham em seus lookups.
  if (input === undefined && (kind === "products" || kind === "contacts")) {
    invokeRpc(ctx, kind === "products" ? "erp_catalog_product_save" : "erp_catalog_contact_save", {
      p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: command, p_data: null, p_acknowledged: null,
    });
  }
  const data = input ?? {};
  const db = ctx.db;
  if (kind === "products") {
    const id = "code" in data ? importProduct(db, arrow(data, "code"), "code", false) : null;
    const patch = { ...data };
    delete patch.category; delete patch.product_group;
    if ("category" in data) patch.category_id = importNamed(db, "categories", arrow(data, "category"), "category");
    if ("product_group" in data) patch.product_group_id = importNamed(db, "product_groups", arrow(data, "product_group"), "product_group");
    if (id === null) {
      const origin = get(db, "produtos.origem_padrao");
      if (!("origin" in patch) && typeof origin === "string" && /^[0-8]$/.test(origin)) patch.origin = origin;
      const out = saveProduct(ctx, user, null, 0, command, patch);
      return result("create", out.record.id, value(out.record.code ?? out.record.name));
    }
    const version = versionOf(db, id);
    delete patch.code;
    if (!Object.keys(patch).length) return result("update", id, arrow(data, "code"), true);
    const kits = ["price", "net_weight", "gross_weight"].some((k) => k in patch) && compositionSyncOn(ctx) ? compositionKits(db, [id]) : [];
    const out = saveProduct(ctx, user, id, version, command, patch);
    if (kits.length && Number(out.record.version) !== version) compositionSync(ctx, user, command, compositionKits(db, [id]));
    return result("update", id, arrow(data, "code"), Number(out.record.version) === version);
  }
  if (kind === "contacts") {
    const document = compact(arrow(data, "document")) || null;
    const id = document === null ? null : unique(contacts(db).filter((r) => compact(value(r.document)) === document), "document", false);
    const version = id === null ? 0 : versionOf(db, id);
    const out = invokeRpc(ctx, "erp_catalog_contact_save", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data, p_acknowledged: null }) as { record: Data };
    return result(id === null ? "create" : "update", out.record.id, value(id === null ? out.record.code ?? out.record.name : out.record.name ?? document), id !== null && Number(out.record.version) === version);
  }
  if (kind === "purchase_orders" || kind === "sales_orders") {
    const contact = importContact(db, arrow(data, "contact_name"), arrow(data, "contact_document"), "contact_name", "contact_document");
    const items = elements(data.items).map((item) => {
      const id = jsonHas(item, "code") ? importProduct(db, arrow(item, "code"), "item_code", true) : null;
      const product = id === null ? null : one(db, "SELECT r.name,r.code,p.unit,p.price FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?", id);
      return stripNulls({ product_id: id, description: arrow(item, "description") ?? product?.name, code: product?.code,
        unit: arrow(item, "unit") ?? product?.unit ?? "UN", quantity: jsonValue(item, "quantity"),
        unit_price: arrow(item, "unit_price") ?? unitPriceNumeric(product?.price, 10) ?? "0", discount_percent: jsonValue(item, "discount_percent") });
    });
    const body = { date: data.date ?? null, contact_id: contact, items, ...stripNulls({ expected_date: data.expected_date, freight: data.freight, notes: data.notes, internal_notes: data.internal_notes }) };
    const out = invokeRpc(ctx, "erp_document_save", { p_user_id: user, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: command, p_body: body }) as { document: Data };
    return result("create", out.document.id, reference("nº ", value(out.document.number), " (planilha ", arrow(data, "number"), ")"));
  }
  if (kind === "stock_movements") {
    const product = importProduct(db, arrow(data, "code"), "code", true);
    const warehouse = "warehouse" in data ? importNamed(db, "warehouses", arrow(data, "warehouse"), "warehouse") : value(one(db, "SELECT warehouse_id FROM erp_stock__warehouse_default")?.warehouse_id);
    if (!("warehouse" in data) && warehouse === null) importFail("erp_preferences_import_required:warehouse");
    const balance = one(db, "SELECT CAST(quantity AS TEXT) quantity,version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse);
    const movement = arrow(data, "movement"), rawQuantity = arrow(data, "quantity");
    const quantity = numeric(rawQuantity);
    if ((movement === "receipt" || movement === "issue") && quantity !== null && (quantity.special === "-Infinity" || !quantity.special && quantity.n <= 0n)) importFail("erp_preferences_import_invalid:quantity");
    const stockKind = movement === "balance" ? "adjustment" : movement;
    if (quantity !== null && !quantity.special) {
      if (movement === "issue") quantity.n = -quantity.n;
      else if (movement !== "receipt") {
        const scale = Math.max(quantity.scale, 6);
        quantity.n = rescale(quantity.n, quantity.scale, scale) - rescale(fromColumn(balance?.quantity ?? 0), 6, scale);
        quantity.scale = scale;
      }
      if (quantity.n === 0n) return result("update", null, "Saldo já igual à quantidade", true);
    }
    let reason = pgBtrim(arrow(data, "note") ?? "") || "Importação de movimentações de estoque";
    if ([...reason].length < 3) reason = "Importação: " + reason;
    if (quantity?.special && quantity.special !== "NaN") raise("22003", "numeric field overflow");
    const scaled = quantity === null || quantity.special ? null : rescale(quantity.n, quantity.scale, 6);
    if (scaled !== null && (scaled >= 1000000000000000000n || scaled <= -1000000000000000000n)) raise("22003", "numeric field overflow");
    const formatted = quantity === null ? null : quantity.special ?? formatScaled(scaled!, 6);
    const out = invokeRpc(ctx, "erp_stock_post", { p_user_id: user, p_command_id: command, p_kind: stockKind,
      p_occurred_on: arrow(data, "date") ?? saoPauloParts(ctx.clock.next()).date, p_reason: reason,
      p_items: [{ product_id: product, warehouse_id: warehouse, quantity: formatted, expected_version: balance?.version ?? 0 }], p_reference: short("Importação " + file, 100) }) as { movement: Data };
    return result("create", out.movement.id, `${stockKind === "receipt" ? "Entrada" : stockKind === "issue" ? "Saída" : "Balanço"} ${formatted}`);
  }
  if (kind === "receivables" || kind === "payables") {
    const titleKind = kind === "receivables" ? "receivable" : "payable";
    const amount = arrow(data, "amount");
    const parsed = numeric(amount);
    if (parsed?.special) raise("22003", "bigint out of range");
    const total = parsed === null ? null : rescale(parsed.n, parsed.scale, 2);
    if (total !== null && (total < -(2n ** 63n) || total > 2n ** 63n - 1n)) raise("22003", "bigint out of range");
    const cents = total?.toString() ?? null;
    const out = invokeRpc(ctx, "erp_finance_title_execute", { p_user_id: user, p_command_id: command, p_action: "title_create", p_data: stripNulls({ kind: titleKind,
      contact_id: importContact(db, arrow(data, "contact_name"), arrow(data, "contact_document"), "contact_name", "contact_document"),
      category_id: importNamed(db, "finance_categories", arrow(data, "category"), "category", titleKind), account_id: importNamed(db, "accounts", arrow(data, "account"), "account"),
      payment_method_id: importNamed(db, "payment_methods", arrow(data, "payment_method"), "payment_method", titleKind), description: data.description, source_reference: data.source_reference,
      issued_on: data.issued_on, competence_on: "competence_on" in data ? data.competence_on : data.issued_on,
      total_cents: cents, installments: [{ amount_cents: cents, due_on: data.due_on ?? null }] }) }) as { items: Data[] };
    return result("create", out.items[0]?.id, arrow(data, "description"));
  }
  if (["compositions", "custom_fields", "product_suppliers"].includes(kind)) return importItemE(ctx, user, kind, command, data);
  if (kind === "lots") return importItemLot(ctx, user, command, data);
  // A importação fiscal continua na frente fiscal e na lista de telas pendentes.
  if (kind === "nfe") return notPorted("erp_preferences.import_item:nfe");
  return importFail("erp_preferences_import_kind_invalid");
}
