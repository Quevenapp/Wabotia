// Etiquetas personalizadas (migração 149 e evoluções): public.erp_preferences_labels,
// _label_save, _label_invoice_products e _label_records.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { accessRequireAdmin } from "../../access/public.ts";
import { allowed as catalogAllowed } from "../../catalog/public.ts";
import { allowed as documentsAllowed, mirrorVisible } from "../../documents/public.ts";
import { int, json, text, uuid } from "../args.ts";
import { readerRole } from "../center.ts";
import { frameworkHash, frameworkKeys, frameworkReplay, frameworkText } from "../framework.ts";
import { compareText } from "../order.ts";
import { reportClean } from "../report-text.ts";

const mmDefault = (w: string, h: string, font: string, barcode: string, currency: boolean, showLabels: boolean, columnsGap: string, rowsGap: string) => ({
  width: w,
  height: h,
  font: "helvetica",
  font_size: font,
  barcode,
  barcode_text: true,
  currency,
  show_labels: showLabels,
  columns_gap: columnsGap,
  rows_gap: rowsGap,
});
const PAGE = { size: "A4", width: null, height: null, orientation: "portrait", margin_left: "5", margin_top: "10" };
const field = (f: string, x: string, y: string, size: string, bold: boolean, barcode: boolean) => ({ field: f, x, y, size, bold, barcode });

/** erp_preferences.label_defaults() */
export const labelDefaults = () => [
  {
    id: "padrao-contato",
    type: "contato",
    description: "Etiqueta de contato",
    config: {
      label: mmDefault("100", "40", "9", "c128", false, false, "3", "0"),
      page: PAGE,
      fields: [
        field("nome", "4", "4", "10", true, false),
        field("endereco", "4", "11", "9", false, false),
        field("bairro", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("cep", "4", "29", "9", true, false),
      ],
    },
  },
  {
    id: "padrao-produto",
    type: "produto",
    description: "Etiqueta de produto",
    config: {
      label: mmDefault("50", "30", "8", "ean13", true, false, "2", "2"),
      page: PAGE,
      fields: [field("descricao", "2", "2", "8", true, false), field("preco", "2", "8", "11", true, false), field("gtin", "2", "14", "8", false, true)],
    },
  },
  {
    id: "padrao-nota-fiscal",
    type: "nota_fiscal",
    description: "Etiqueta de nota fiscal",
    config: {
      label: mmDefault("100", "50", "9", "c128", false, true, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("serie", "60", "4", "10", false, false),
        field("cliente", "4", "11", "9", false, false),
        field("endereco_cliente", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("chave", "4", "30", "7", false, true),
      ],
    },
  },
  {
    id: "padrao-ordem-servico",
    type: "ordem_servico",
    description: "Etiqueta de ordem de serviço",
    config: {
      label: mmDefault("100", "30", "9", "c128", true, true, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("data", "60", "4", "9", false, false),
        field("cliente", "4", "12", "9", false, false),
        field("total", "4", "20", "9", true, false),
      ],
    },
  },
  {
    id: "padrao-pedido-venda",
    type: "pedido_venda",
    description: "Etiqueta de pedido de venda",
    config: {
      label: mmDefault("100", "50", "9", "c128", true, false, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("cliente", "4", "11", "9", false, false),
        field("endereco_cliente", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("cep", "4", "29", "9", true, false),
        field("numero", "4", "36", "8", false, true),
      ],
    },
  },
];

/** erp_preferences.label_fields(type) */
const LABEL_FIELDS: Record<string, string[]> = {
  produto: ["codigo", "descricao", "preco", "unidade", "gtin", "ncm"],
  contato: ["nome", "fantasia", "documento", "endereco", "bairro", "cidade_uf", "cep", "telefone"],
  pedido_venda: ["numero", "data", "cliente", "endereco_cliente", "cidade_uf", "cep", "total"],
  ordem_servico: ["numero", "data", "cliente", "total"],
  nota_fiscal: ["numero", "serie", "cliente", "endereco_cliente", "cidade_uf", "chave"],
};

const configInvalid = (): never => raise("22023", "erp_preferences_label_config_invalid");

/** erp_preferences.label_mm(p, min, max): milímetros em texto, até uma casa. */
function labelMm(p: unknown, min: number, max: number): number {
  if (p === null || p === undefined || jsonType(p) !== "string" || !/^(0|[1-9][0-9]{0,2})(\.[0-9])?$/.test(p as string)) configInvalid();
  const v = Number(p);
  if (v < min || v > max) configInvalid();
  return v;
}

const typed = (o: Record<string, unknown>, key: string, type: string) => jsonType(o[key]) === type;

/** erp_preferences.label_check(type, config) */
function labelCheck(type: string, config: unknown) {
  const fields = LABEL_FIELDS[type];
  const c = config as Record<string, unknown>;
  if (!fields || !frameworkKeys(config, ["fields", "label", "page"])) configInvalid();
  const l = c.label as Record<string, unknown>;
  const g = c.page as Record<string, unknown>;
  if (
    !frameworkKeys(l, ["barcode", "barcode_text", "columns_gap", "currency", "font", "font_size", "height", "rows_gap", "show_labels", "width"]) ||
    !frameworkKeys(g, ["height", "margin_left", "margin_top", "orientation", "size", "width"]) ||
    !typed(l, "font", "string") ||
    !["helvetica", "courier", "monospace", "times"].includes(l.font as string) ||
    !typed(l, "barcode", "string") ||
    !["c128", "ean13", "upca", "msi", "upce", "c93", "qr", "datamatrix"].includes(l.barcode as string) ||
    !typed(l, "barcode_text", "boolean") ||
    !typed(l, "currency", "boolean") ||
    !typed(l, "show_labels", "boolean") ||
    !typed(g, "size", "string") ||
    !["A2", "A3", "A4", "A5", "custom"].includes(g.size as string) ||
    !typed(g, "orientation", "string") ||
    !["portrait", "landscape"].includes(g.orientation as string) ||
    !typed(c, "fields", "array") ||
    (c.fields as unknown[]).length < 1 ||
    (c.fields as unknown[]).length > 20
  )
    configInvalid();
  const width = labelMm(l.width, 5, 300);
  const height = labelMm(l.height, 5, 300);
  labelMm(l.font_size, 4, 72);
  labelMm(l.columns_gap, 0, 100);
  labelMm(l.rows_gap, 0, 100);
  labelMm(g.margin_left, 0, 100);
  labelMm(g.margin_top, 0, 100);
  if (g.size === "custom") {
    labelMm(g.width, 20, 999);
    labelMm(g.height, 20, 999);
  } else if (jsonType(g.width) !== "null" || jsonType(g.height) !== "null") configInvalid();
  for (const f of c.fields as Record<string, unknown>[]) {
    if (
      !frameworkKeys(f, ["barcode", "bold", "field", "size", "x", "y"]) ||
      !typed(f, "field", "string") ||
      !fields.includes(f.field as string) ||
      !typed(f, "bold", "boolean") ||
      !typed(f, "barcode", "boolean")
    )
      configInvalid();
    labelMm(f.x, 0, width);
    labelMm(f.y, 0, height);
    labelMm(f.size, 4, 72);
  }
}

/** erp_preferences.label_dto(t) */
export const labelDto = (t: Record<string, unknown>) => ({
  id: t.id,
  type: t.type,
  description: t.description,
  default: false,
  config: JSON.parse(String(t.config)),
  version: Number(t.version),
  updated_at: jsonTimestamp(String(t.updated_at)),
});

export function erpPreferencesLabels(ctx: RpcContext, a: RpcArgs) {
  const role = readerRole(ctx.db, uuid(a, "p_user_id"));
  if (role !== "admin") raise("42501", "erp_preferences_labels_access_denied");
  const stored = ctx.db
    .exec('SELECT * FROM "erp_preferences__label_template"')
    .rows.sort((x, y) => compareText(pgLower(String(x.description)), pgLower(String(y.description))) || compareText(String(x.id), String(y.id)))
    .map(labelDto);
  return {
    scope: "labels",
    data_mode: "erp_native",
    items: [...labelDefaults().map((d) => ({ ...d, default: true, version: 0, updated_at: null })), ...stored],
  };
}

export function erpPreferencesLabelSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const label = uuid(a, "p_label");
  const expected = int(a, "p_expected_version");
  const data = json(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  if (
    command === null ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    (label === null) !== (expected === 0) ||
    !frameworkKeys(data, ["config", "description", "type"]) ||
    jsonType(data!.type) !== "string"
  )
    raise("22023", "erp_preferences_label_input_invalid");
  const type = data!.type as string;
  labelCheck(type, data!.config);
  const description = frameworkText(data!.description, 80);
  const hash = frameworkHash({ op: "label_save", actor: user, id: label, version: expected, data });
  const replay = frameworkReplay(db, command!, user!, "labels", hash);
  if (replay) return replay;
  if (
    db
      .exec('SELECT id, description FROM "erp_preferences__label_template" WHERE type=?', type)
      .rows.some((t) => pgLower(String(t.description)) === pgLower(description) && t.id !== label) ||
    labelDefaults().some((d) => d.type === type && pgLower(d.description) === pgLower(description))
  )
    raise("23505", "erp_preferences_label_description_taken");
  let id: string;
  let before: unknown = null;
  if (label === null) {
    if (Number(one(db, 'SELECT count(*) n FROM "erp_preferences__label_template"')!.n) >= 100) raise("22023", "erp_preferences_label_limit");
    id = crypto.randomUUID();
  } else {
    const row = one(db, 'SELECT * FROM "erp_preferences__label_template" WHERE id=?', label);
    if (!row) raise("P0002", "erp_preferences_label_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_preferences_label_version_conflict");
    if (row.type !== type) raise("22023", "erp_preferences_label_type_fixed");
    if (row.description === description && jsonbText(JSON.parse(String(row.config))) === jsonbText(data!.config)) raise("22023", "erp_preferences_label_unchanged");
    id = label;
    before = labelDto(row);
  }
  const at = ctx.clock.next();
  const result = {
    scope: "labels_command",
    data_mode: "erp_native",
    receipt: {
      command_id: command,
      action: label === null ? "label_create" : "label_update",
      target: id,
      count: 1,
      changed_at: jsonTimestamp(at.toString()),
    },
  };
  db.exec(
    'INSERT INTO "erp_preferences__framework_command"(id, actor, area, request_hash, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    "labels",
    hash,
    jsonbText(result),
    at.toString(),
  );
  const config = jsonbText(data!.config);
  if (label === null)
    db.exec(
      `INSERT INTO "erp_preferences__label_template"(id, type, description, config, version, created_at, created_by, updated_at, updated_by, command_id, description__fold)
       VALUES (?,?,?,?,1,?,?,?,?,?,?)`,
      id,
      type,
      description,
      config,
      at.toString(),
      user,
      at.toString(),
      user,
      command,
      pgLower(description),
    );
  else
    db.exec(
      'UPDATE "erp_preferences__label_template" SET description=?, config=?, version=version+1, updated_at=?, updated_by=?, command_id=?, description__fold=? WHERE id=?',
      description,
      config,
      at.toString(),
      user,
      command,
      pgLower(description),
      id,
    );
  const after = one(db, 'SELECT * FROM "erp_preferences__label_template" WHERE id=?', id)!;
  db.exec(
    `INSERT INTO "erp_preferences__framework_audit"(created_at, actor, command_id, area, action, target, before_data, after_data)
     VALUES (?,?,?,?,?,?,?,?)`,
    at.toString(),
    user,
    command,
    "labels",
    result.receipt.action,
    id,
    before === null ? null : jsonbText(before),
    jsonbText(labelDto(after)),
  );
  return { ...result, replayed: false };
}

/** trim_scale(x)::text de um decimal já em texto. */
const trimScale = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
const dataText = (d: Record<string, unknown>, key: string) => {
  const v = d[key];
  return v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v);
};

export function erpPreferencesLabelInvoiceProducts(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = readerRole(db, uuid(a, "p_user_id"));
  const invoiceId = uuid(a, "p_invoice_id");
  if (!["admin", "consulta", "fiscal"].includes(role) || !catalogAllowed(role, "products", false)) raise("42501", "erp_preferences_label_access_denied");
  if (invoiceId === null) raise("22023", "erp_preferences_label_type_invalid");
  const v = one(db, 'SELECT id, model, number, series FROM "erp_fiscal_invoices__invoice" WHERE id=? AND deleted_at IS NULL', invoiceId);
  if (!v) raise("P0002", "erp_preferences_label_invoice_not_found");
  const items = db
    .exec(
      `SELECT i.position, i.product_id, i.quantity, i.unit_price, i.data, r.code, r.name, p.price, p.unit, p.gtin, p.ncm
       FROM (SELECT * FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? ORDER BY position LIMIT 990) i
       LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
       ORDER BY i.position`,
      v.id,
    )
    .rows.map((i) => {
      const d = JSON.parse(String(i.data)) as Record<string, unknown>;
      const pick = (col: unknown, key: string) => (col === null || col === undefined ? dataText(d, key) : String(col));
      return {
        position: Number(i.position),
        product_id: i.product_id,
        quantity: trimScale(formatScaled(fromColumn(i.quantity), 4)),
        values: {
          codigo: reportClean(pick(i.code, "code"), 100),
          descricao: reportClean(pick(i.name, "description"), 200),
          preco: i.price === null ? String(i.unit_price) : String(i.price),
          unidade: reportClean(pick(i.unit, "unit"), 20),
          gtin: reportClean(pick(i.gtin, "gtin"), 20),
          ncm: reportClean(pick(i.ncm, "ncm"), 10),
        },
      };
    });
  return {
    scope: "label_invoice_products",
    data_mode: "erp_native",
    invoice: { id: v.id, model: v.model, number: v.number === null ? null : String(v.number), series: String(v.series) },
    items,
  };
}

/** erp_preferences.label_query(q): o texto da busca (literal: % e _ não são curingas), em minúsculas, ou null. */
function labelQuery(q: string | null): string | null {
  if (q === null) return null;
  if (pgLength(q) < 1 || pgLength(q) > 60 || pgHasCntrl.test(q) || q !== pgBtrim(q)) raise("22023", "erp_preferences_label_query_invalid");
  return pgLower(q);
}
/** concat_ws(sep, …): junta os não nulos. */
const concatWs = (sep: string, ...parts: (string | null)[]) => parts.filter((p) => p !== null).join(sep);
/** jsonb->>key */
const jsonField = (o: unknown, key: string): string | null => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const v = (o as Record<string, unknown>)[key];
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
/** lpad(s, 12, '0'): completa ou corta em 12. */
const lpad12 = (s: string) => ([...s].length >= 12 ? [...s].slice(0, 12).join("") : s.padStart(12, "0"));

const LABEL_TYPES = ["produto", "contato", "pedido_venda", "ordem_servico", "nota_fiscal"];

export function erpPreferencesLabelRecords(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const role = readerRole(db, user);
  const type = text(a, "p_type");
  if (type === null || !LABEL_TYPES.includes(type)) raise("22023", "erp_preferences_label_type_invalid");
  const kind = type === "pedido_venda" ? "sales_orders" : type === "ordem_servico" ? "service_orders" : null;
  const ok =
    type === "produto"
      ? catalogAllowed(role, "products", false)
      : type === "contato"
        ? catalogAllowed(role, "contacts", false)
        : type === "nota_fiscal"
          ? ["admin", "consulta", "fiscal"].includes(role)
          : documentsAllowed(role, kind, false);
  if (!ok) raise("42501", "erp_preferences_label_access_denied");
  const q = labelQuery(text(a, "p_query"));
  const has = (s: string | null) => q === null || (s !== null && s.includes(q));
  const rows: { sort: string; item: unknown }[] = [];
  if (type === "produto")
    for (const r of db.exec(
      `SELECT r.id, r.code, r.name, p.price, p.unit, p.gtin, p.ncm FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.active=1`,
    ).rows) {
      const name = String(r.name);
      if (!(has(pgLower(name)) || has(pgLower((r.code as string | null) ?? "")))) continue;
      rows.push({
        sort: pgLower(name) + r.id,
        item: {
          id: r.id,
          values: {
            codigo: reportClean(r.code as string | null, 100),
            descricao: reportClean(name, 200),
            preco: r.price === null ? null : String(r.price),
            unidade: reportClean(r.unit as string | null, 20),
            gtin: reportClean(r.gtin as string | null, 20),
            ncm: reportClean(r.ncm as string | null, 10),
          },
        },
      });
    }
  else if (type === "contato")
    for (const r of db.exec(
      `SELECT r.id, r.name, c.trade_name, c.document, c.street, c.number, c.complement, c.district, c.city, c.state, c.postal_code, c.phone
       FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.active=1`,
    ).rows) {
      const name = String(r.name);
      if (!has(pgLower(name))) continue;
      const s = (k: string) => (r[k] as string | null) ?? null;
      const complement = s("complement") === null ? null : pgBtrim(s("complement")!);
      rows.push({
        sort: pgLower(name) + r.id,
        item: {
          id: r.id,
          values: {
            nome: reportClean(name, 200),
            fantasia: reportClean(s("trade_name"), 200),
            documento: reportClean(s("document"), 20),
            endereco: reportClean(concatWs(", ", s("street"), s("number")) + (complement === null || complement === "" ? "" : " - " + complement), 200),
            bairro: reportClean(s("district"), 100),
            cidade_uf: reportClean(concatWs("/", s("city"), s("state")), 110),
            cep: reportClean(s("postal_code"), 9),
            telefone: reportClean(s("phone"), 40),
          },
        },
      });
    }
  else if (kind !== null)
    for (const d of db.exec(
      `SELECT id, origin, authority, number, body, contact_snapshot, CAST(total AS TEXT) total FROM "erp_documents__document" WHERE kind=?`,
      kind,
    ).rows) {
      // Sem o espelho do Origin, o documento nativo é visível pelo contato (documents/reads-g.ts).
      if (!mirrorVisible(db, user, String(d.id))) continue;
      const snap = JSON.parse(String(d.contact_snapshot));
      const number = String(d.number);
      if (!(has(number) || has(pgLower(jsonField(snap, "name") ?? "")))) continue;
      const date = jsonField(JSON.parse(String(d.body)), "date");
      const values: Record<string, unknown> = {
        numero: number,
        data: date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        cliente: reportClean(jsonField(snap, "name"), 200),
        endereco_cliente: reportClean(concatWs(", ", jsonField(snap, "street"), jsonField(snap, "number")), 200),
        cidade_uf: reportClean(concatWs("/", jsonField(snap, "city"), jsonField(snap, "state")), 110),
        cep: reportClean(jsonField(snap, "postal_code"), 9),
        total: formatScaled(fromColumn(d.total), 2),
      };
      if (type === "ordem_servico") for (const k of ["endereco_cliente", "cidade_uf", "cep"]) delete values[k];
      rows.push({ sort: lpad12(number), item: { id: d.id, origin: d.origin, authority: d.authority, values } });
    }
  else
    for (const i of db.exec(
      `SELECT id, number, series, recipient, access_key FROM "erp_fiscal_invoices__invoice" WHERE model='55' AND deleted_at IS NULL`,
    ).rows) {
      const rec = JSON.parse(String(i.recipient));
      const number = i.number === null ? null : String(i.number);
      if (!(has(number ?? "") || has(pgLower(jsonField(rec, "name") ?? "")))) continue;
      rows.push({
        sort: lpad12(number ?? "0") + i.id,
        item: {
          id: i.id,
          values: {
            numero: number,
            serie: String(i.series),
            cliente: reportClean(jsonField(rec, "name"), 200),
            endereco_cliente: reportClean(concatWs(", ", jsonField(rec, "street"), jsonField(rec, "number")), 200),
            cidade_uf: reportClean(concatWs("/", jsonField(rec, "city"), jsonField(rec, "state")), 110),
            chave: i.access_key,
          },
        },
      });
    }
  rows.sort((x, y) => compareText(x.sort, y.sort));
  return { scope: "label_records", data_mode: "erp_native", type, items: rows.slice(0, 100).map((r) => r.item) };
}

registerRpc("erp_preferences_label_records", erpPreferencesLabelRecords);
registerRpc("erp_preferences_labels", erpPreferencesLabels);
registerRpc("erp_preferences_label_save", erpPreferencesLabelSave);
registerRpc("erp_preferences_label_invoice_products", erpPreferencesLabelInvoiceProducts);
