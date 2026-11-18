// public.erp_catalog_custom_field_save: cria ou altera a definição de um
// campo customizado de produtos (até 60), com as opções da lista e as
// categorias do Agrupador. Categoria que ganha ou perde o campo recebe versão
// nova e auditoria (o formulário dela mostra os campos). Nome repetido, limite
// e opção em uso respondem saved=false sem gravar recibo.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// Diferença de mecânica, mesmo resultado: no Postgres a posição da opção é
// UNIQUE DEFERRABLE INITIALLY DEFERRED e o UPDATE reordena em lugar; no
// SQLite o UNIQUE é imediato e a posição é NOT NULL entre 1 e 50, então as
// opções mantidas saem e voltam com o mesmo id, já na ordem final. Nenhuma
// tabela referencia erp_catalog.custom_field_option.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { customFieldItem, requireCustomFieldPermission } from "../custom-fields.ts";
import { btrim, CNTRL, chars, compareText } from "../fields.ts";
import { fold } from "../internal.ts";
import { taxonomyItem, taxonomyTypeGuard } from "../taxonomy.ts";

const MAX_VERSION = 2147483647;
const KEYS = ["field_type", "name", "hint", "info", "required", "min_length", "max_length", "width", "grouped", "category_ids", "options", "active"];
const TYPES = ["integer", "decimal", "list", "text", "long_text", "boolean", "date"];
const WIDTHS = ["small", "medium", "large", "extra_large"];
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAP: Record<string, number> = { integer: 19, decimal: 22, text: 255, long_text: 4000 };

type Json = Record<string, unknown>;
const typeOf = (v: unknown) =>
  v === undefined ? null : v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
const has = (o: Json, k: string) => Object.hasOwn(o, k);
/** ->> do jsonb: texto, ou o jsonb como texto; null para ausente e null. */
const arrowText = (o: Json, k: string): string | null => {
  const v = o[k];
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
/** btrim(texto, E' \t\r\n') */
const trimInfo = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const bytes = (s: string) => new TextEncoder().encode(s).length;

interface Field {
  field_type: string;
  name: string | null;
  hint: string | null;
  info: string | null;
  required: boolean;
  min_length: number | null;
  max_length: number | null;
  width: string;
  grouped: boolean;
  active: boolean;
}

function invalidData(id: string | null, d: unknown): boolean {
  if (d === null || typeOf(d) !== "object") return true;
  const data = d as Json;
  if (bytes(jsonbText(data)) > 32768 || Object.keys(data).length === 0) return true;
  if (Object.keys(data).some((k) => !KEYS.includes(k))) return true;
  if (id === null && (typeOf(data.field_type) !== "string" || typeOf(data.name) !== "string")) return true;
  if (has(data, "field_type") && (typeOf(data.field_type) !== "string" || !TYPES.includes(data.field_type as string))) return true;
  if (has(data, "name") && typeOf(data.name) !== "string") return true;
  for (const k of ["hint", "info"]) if (has(data, k) && !["string", "null"].includes(typeOf(data[k])!)) return true;
  for (const k of ["required", "grouped", "active"]) if (has(data, k) && typeOf(data[k]) !== "boolean") return true;
  for (const k of ["min_length", "max_length"])
    if (has(data, k) && data[k] !== null && (typeOf(data[k]) !== "number" || !/^[1-9][0-9]{0,3}$/.test(jsonbText(data[k])))) return true;
  if (has(data, "width") && (typeOf(data.width) !== "string" || !WIDTHS.includes(data.width as string))) return true;
  if (has(data, "category_ids")) {
    const c = data.category_ids;
    if (typeOf(c) !== "array") return true;
    const list = c as unknown[];
    if (list.length > 100 || list.some((x) => typeOf(x) !== "string" || !LOWER_UUID.test(x as string))) return true;
    if (new Set(list as string[]).size !== list.length) return true;
  }
  if (has(data, "options")) {
    const o = data.options;
    if (typeOf(o) !== "array") return true;
    const list = o as unknown[];
    if (list.length > 50) return true;
    for (const x of list) {
      if (typeOf(x) !== "object") return true;
      const opt = x as Json;
      if (Object.keys(opt).some((k) => k !== "id" && k !== "label") || typeOf(opt.label) !== "string") return true;
      if (has(opt, "id") && opt.id !== null && (typeOf(opt.id) !== "string" || !LOWER_UUID.test(opt.id as string))) return true;
    }
  }
  return false;
}

export function erpCatalogCustomFieldSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const data = jsonArg(a, "p_data");
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  requireCustomFieldPermission(db, user, "ie");
  if (
    command === null ||
    expected === null ||
    (id === null && expected !== 0) ||
    (id !== null && (expected < 1 || expected > MAX_VERSION)) ||
    invalidData(id, data)
  )
    raise("22023", "erp_catalog_invalid_command");
  const d = data as Json;
  const hash = requestHash({ actor: user, action: "custom_field_save", id, version: expected, data: d });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  const not = (reason: string, extra: Json = {}) => ({ saved: false, reason, ...extra, replayed: false, data_mode: "erp_native" });

  let v: Field;
  let rowVersion = 0;
  let before: Json | null = null;
  if (id !== null) {
    const row = one(
      db,
      `SELECT field_type, name, hint, info, required, min_length, max_length, width, grouped, active, CAST(version AS TEXT) version
       FROM "erp_catalog__custom_field" WHERE id=?`,
      id,
    );
    if (!row) raise("P0002", "erp_catalog_not_found");
    rowVersion = Number(row.version);
    if (rowVersion !== expected) raise("40001", "erp_catalog_version_conflict");
    if (has(d, "field_type") && d.field_type !== row.field_type) raise("22023", "erp_catalog_custom_field_type_fixed");
    v = {
      field_type: String(row.field_type),
      name: row.name as string,
      hint: row.hint as string | null,
      info: row.info as string | null,
      required: !!Number(row.required),
      min_length: row.min_length === null ? null : Number(row.min_length),
      max_length: row.max_length === null ? null : Number(row.max_length),
      width: String(row.width),
      grouped: !!Number(row.grouped),
      active: !!Number(row.active),
    };
    before = customFieldItem(db, id);
  } else {
    const total = Number(one(db, `SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__custom_field" WHERE module='products'`)!.n);
    if (total >= 60) return not("limit");
    v = {
      field_type: d.field_type as string, name: null, hint: null, info: null, required: false, min_length: null, max_length: null,
      width: "medium", grouped: false, active: true,
    };
  }
  if (has(d, "name")) v.name = btrim(d.name as string);
  if (has(d, "hint")) v.hint = d.hint === null ? null : btrim(d.hint as string) || null;
  if (has(d, "info")) v.info = d.info === null ? null : trimInfo(d.info as string) || null;
  if (has(d, "required")) v.required = d.required as boolean;
  if (has(d, "min_length")) v.min_length = arrowText(d, "min_length") === null ? null : Number(arrowText(d, "min_length"));
  if (has(d, "max_length")) v.max_length = arrowText(d, "max_length") === null ? null : Number(arrowText(d, "max_length"));
  if (has(d, "width")) v.width = d.width as string;
  if (has(d, "grouped")) v.grouped = d.grouped as boolean;
  if (has(d, "active")) v.active = d.active as boolean;
  const cap = CAP[v.field_type] ?? null;
  const gt = (x: number | null, y: number | null) => x !== null && y !== null && x > y;
  if (
    v.name === null ||
    v.name === "" ||
    chars(v.name) > 60 ||
    CNTRL.test(v.name) ||
    (v.hint !== null && (chars(v.hint) > 100 || CNTRL.test(v.hint))) ||
    (v.info !== null && (chars(v.info) > 300 || CNTRL.test(v.info.replace(/[\n\r\t]/g, "")))) ||
    ((v.min_length !== null || v.max_length !== null) && cap === null) ||
    gt(v.min_length, cap) ||
    gt(v.max_length, cap) ||
    gt(v.min_length, v.max_length) ||
    (has(d, "options") && v.field_type !== "list") ||
    (has(d, "category_ids") && !v.grouped && (d.category_ids as unknown[]).length > 0)
  )
    raise("22023", "erp_catalog_invalid_command");

  // Lista: as opções informadas (com id = opção existente deste campo) substituem as atuais, na ordem enviada.
  let options: { id: string | null; label: string }[] = [];
  if (v.field_type === "list") {
    options = has(d, "options")
      ? (d.options as Json[]).map((o) => ({ id: (o.id ?? null) as string | null, label: o.label as string }))
      : db
          .exec('SELECT id, label FROM "erp_catalog__custom_field_option" WHERE field_id=? ORDER BY position', id)
          .rows.map((o) => ({ id: String(o.id), label: String(o.label) }));
    const ids = options.filter((o) => o.id !== null).map((o) => o.id!);
    if (
      options.length === 0 ||
      options.some((o) => btrim(o.label) === "" || chars(btrim(o.label)) > 60 || CNTRL.test(o.label)) ||
      new Set(options.map((o) => fold(btrim(o.label)))).size !== options.length ||
      new Set(ids).size !== ids.length ||
      ids.some((oid) => id === null || !one(db, 'SELECT 1 x FROM "erp_catalog__custom_field_option" WHERE id=? AND field_id=?', oid, id))
    )
      raise("22023", "erp_catalog_invalid_command");
  }
  const key = fold(v.name)!;
  const same = db
    .exec(`SELECT id, name FROM "erp_catalog__custom_field" WHERE module='products'`)
    .rows.some((f) => fold(String(f.name)) === key && f.id !== id);
  if (same) return not("duplicate_name");

  // Agrupador: categorias de produtos existentes; as que ganham ou perdem o campo ganham versão nova.
  const old =
    id === null
      ? []
      : db.exec('SELECT category_id FROM "erp_catalog__custom_field_category" WHERE field_id=?', id).rows.map((c) => String(c.category_id));
  const categories = !v.grouped ? [] : has(d, "category_ids") ? (d.category_ids as string[]) : old;
  const touched = [...categories.filter((c) => !old.includes(c)), ...old.filter((c) => !categories.includes(c))].sort(compareText);
  const valid = categories.filter((c) => one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind='categories'`, c)).length;
  if (valid !== categories.length) raise("22023", "erp_catalog_invalid_reference");

  // Opções removidas: em uso por algum produto, nada muda.
  if (id !== null && v.field_type === "list") {
    const kept = new Set(options.filter((o) => o.id !== null).map((o) => o.id));
    const removed = db
      .exec('SELECT id FROM "erp_catalog__custom_field_option" WHERE field_id=?', id)
      .rows.map((o) => String(o.id))
      .filter((o) => !kept.has(o));
    if (removed.length) {
      const used = Number(
        one(
          db,
          `SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__product_custom_value" WHERE field_id=? AND value IN (${removed.map(() => "?").join(",")})`,
          id,
          ...removed,
        )!.n,
      );
      if (used > 0) return not("option_in_use", { products: used });
    }
  }

  const now = ctx.clock.next().toString();
  const fieldId = id ?? crypto.randomUUID();
  if (id === null)
    db.exec(
      `INSERT INTO "erp_catalog__custom_field"(id, module, field_type, name, hint, info, required, min_length, max_length, width, grouped,
       active, version, created_by, updated_by, created_at, updated_at, name__fold) VALUES (?,'products',?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      fieldId, v.field_type, v.name, v.hint, v.info, v.required ? 1 : 0, v.min_length, v.max_length, v.width, v.grouped ? 1 : 0,
      v.active ? 1 : 0, user, user, now, now, key,
    );
  else
    db.exec(
      `UPDATE "erp_catalog__custom_field" SET name=?, hint=?, info=?, required=?, min_length=?, max_length=?, width=?, grouped=?, active=?,
       name__fold=? WHERE id=?`,
      v.name, v.hint, v.info, v.required ? 1 : 0, v.min_length, v.max_length, v.width, v.grouped ? 1 : 0, v.active ? 1 : 0, key, fieldId,
    );
  if (v.field_type === "list") {
    db.exec('DELETE FROM "erp_catalog__custom_field_option" WHERE field_id=?', fieldId);
    options.forEach((o, n) =>
      db.exec(
        'INSERT INTO "erp_catalog__custom_field_option"(id, field_id, position, label) VALUES (?,?,?,?)',
        o.id ?? crypto.randomUUID(),
        fieldId,
        n + 1,
        btrim(o.label),
      ),
    );
  }
  for (const c of old) if (!categories.includes(c)) db.exec('DELETE FROM "erp_catalog__custom_field_category" WHERE field_id=? AND category_id=?', fieldId, c);
  for (const c of categories)
    db.exec('INSERT INTO "erp_catalog__custom_field_category"(field_id, category_id) VALUES (?,?) ON CONFLICT DO NOTHING', fieldId, c);
  // Cada categoria que ganhou ou perdeu o campo: versão nova e auditoria.
  for (const c of touched) {
    const row = one(db, `SELECT kind, parent_id, tag_type FROM "erp_catalog__taxonomy" WHERE id=? AND kind='categories'`, c);
    if (!row) continue;
    const catBefore = taxonomyItem(db, c)!;
    if (catBefore.version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    const shape = { kind: String(row.kind), parent_id: row.parent_id as string | null, tag_type: row.tag_type as string | null };
    taxonomyTypeGuard(db, shape, shape);
    db.exec('UPDATE "erp_catalog__taxonomy" SET version=version+1, updated_by=?, updated_at=? WHERE id=?', user, ctx.clock.next().toString(), c);
    db.exec(
      `INSERT INTO "erp_catalog__taxonomy_audit"(actor, command_id, kind, item_id, action, before_data, after_data, created_at)
       VALUES (?,?,'categories',?,'update',?,?,?)`,
      user, command, c, jsonbText(catBefore),
      jsonbText({ ...taxonomyItem(db, c), custom_field_id: fieldId, linked: categories.includes(c) }), ctx.clock.next().toString(),
    );
  }
  let after = customFieldItem(db, fieldId)!;
  const audit = (action: string, b: Json | null, x: Json) =>
    db.exec(
      `INSERT INTO "erp_catalog__custom_field_audit"(actor, command_id, field_id, action, before_data, after_data, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      user, command, fieldId, action, b === null ? null : jsonbText(b), jsonbText(x), ctx.clock.next().toString(),
    );
  const strip = (x: Json) => {
    const { products: _p, version: _v, updated_at: _u, ...rest } = x;
    return jsonbText(rest);
  };
  if (id === null) audit("create", null, after);
  else if (strip(after) !== strip(before!)) {
    if (rowVersion === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    db.exec('UPDATE "erp_catalog__custom_field" SET version=version+1, updated_by=?, updated_at=? WHERE id=?', user, ctx.clock.next().toString(), fieldId);
    after = customFieldItem(db, fieldId)!;
    audit("update", before, after);
  }
  const result = { saved: true, field: after, replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_custom_field_save", erpCatalogCustomFieldSave);
