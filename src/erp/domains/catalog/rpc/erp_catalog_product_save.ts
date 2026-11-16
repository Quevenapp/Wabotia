// public.erp_catalog_product_save: inclui ou altera um produto (cadastro
// base, detalhe, listas e Ativado num comando só), com os avisos confirmados
// (código e GTIN repetidos) e o código sequencial da preferência.
// Fora (Origin desligado): o UPDATE de erp_catalog.origin (tabela vazia).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import * as preferences from "../../preferences/public.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { intArg, uuidArg } from "../pricing/args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import {
  data,
  insertRecord,
  nextProductCode,
  productDetailData,
  productFull,
  validateData,
  validateProductIdentifiers,
} from "../internal.ts";
import {
  PRODUCT_DETAIL_KEYS,
  productCustomResolve,
  productDetailReferences,
  productDetailValidate,
  productDetailWrite,
  productWarnings,
} from "../product-detail.ts";
import { updateRecord, writeFields } from "../record.ts";

const MAX_VERSION = 2147483647;
const invalidCommand = (): never => raise("22023", "erp_catalog_invalid_command");
const isEmpty = (o: object) => Object.keys(o).length === 0;
const asBool = (v: unknown) => (v === undefined || v === null ? null : v === true || v === "true");

export function erpCatalogProductSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const input = jsonArg(a, "p_data") as Record<string, unknown> | null;
  const acknowledged = jsonArg(a, "p_acknowledged");
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  if (
    command === null ||
    expected === null ||
    (id === null && expected !== 0) ||
    (id !== null && expected < 1) ||
    input === null ||
    jsonType(input) !== "object" ||
    new TextEncoder().encode(jsonbText(input)).length > 65536 ||
    ("active" in input && jsonType(input.active) !== "boolean")
  )
    invalidCommand();
  if (acknowledged !== null) {
    const list = acknowledged as unknown[];
    if (
      jsonType(acknowledged) !== "array" ||
      list.length > 2 ||
      list.some((x) => jsonType(x) !== "string" || !["duplicate_code", "duplicate_gtin"].includes(x as string)) ||
      new Set(list).size !== list.length
    )
      invalidCommand();
  }
  const keys = jsonbKeys(input!);
  const base = Object.fromEntries(keys.filter((k) => k !== "active" && !PRODUCT_DETAIL_KEYS.includes(k)).map((k) => [k, input![k]]));
  let detail = productDetailValidate(Object.fromEntries(keys.filter((k) => PRODUCT_DETAIL_KEYS.includes(k)).map((k) => [k, input![k]])));
  let v: Record<string, unknown> = isEmpty(base) ? {} : validateData("products", base, false);
  if (isEmpty(v) && isEmpty(detail) && !("active" in input!)) raise("22023", "erp_catalog_empty_patch");
  const active = asBool(input!.active);
  const hash = requestHash({ actor: user, entity: "products", id, version: expected, data: input, set_active: false, active: null });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  const accepted = acknowledged as string[] | null;
  const confirm = (patch: Record<string, unknown>, target: string | null) => {
    if (accepted === null) return [];
    const codes = productWarnings(db, target, patch).map((w) => w.code as string);
    if (codes.some((c) => !accepted.includes(c))) raise("40001", "erp_catalog_warning_unacknowledged");
    return codes;
  };
  let target: string;
  let before: Record<string, unknown> | null = null;
  let changed = false;
  let baseChanged = false;
  let detailChanged = false;
  let codes: string[] = [];
  if (id === null) {
    // Preferências › Código do produto: Sequencial ou Sequencial EAN numera o produto novo sem código.
    if (v.code === undefined || v.code === null || v.code === "") {
      const next = nextProductCode(db, true);
      if (next !== null) v = { ...v, code: next };
    }
    // Origem padrão de tributação: um corpo sem a chave Origem recebe a da preferência.
    const origin = preferences.get(db, "produtos.origem_padrao");
    if (!("origin" in input!) && typeof origin === "string" && /^[0-8]$/.test(origin)) v = { ...v, origin };
    validateProductIdentifiers(v, null);
    v = validateData("products", v, true);
    productDetailReferences(db, detail);
    if (v.format === "V" && asBool(detail.lot_control) === true) raise("22023", "erp_catalog_lot_control_variations");
    detail = productCustomResolve(db, null, detail);
    codes = confirm(v, null);
    target = insertRecord(ctx, {
      entity: "products",
      name: v.name as string,
      code: (v.code as string | null) ?? null,
      active: active ?? true,
      actor: user!,
      humanEdited: true,
    });
    writeFields(ctx, target, "products", v);
    productDetailWrite(ctx, target, detail);
    changed = true;
  } else {
    const row = one(
      db,
      `SELECT name, code, active, CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity='products'`,
      id,
    );
    if (!row) raise("P0002", "erp_catalog_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
    if (one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', id))
      raise("40001", "erp_catalog_product_deleted");
    codes = confirm(v, id);
    target = id;
    before = productFull(db, id);
    if (!isEmpty(v)) {
      const current = data(db, id);
      validateProductIdentifiers(v, current);
      v = validateData("products", current === null ? null : { ...current, ...v }, true);
      baseChanged = jsonbText(v) !== jsonbText(data(db, id));
    }
    productDetailReferences(db, detail);
    const product = one(db, 'SELECT format FROM "erp_catalog__product" WHERE record_id=?', id);
    const lot = one(db, 'SELECT lot_control FROM "erp_catalog__product_detail" WHERE record_id=?', id);
    const format = (!isEmpty(v) ? ((v.format as string | null) ?? null) : null) ?? ((product?.format as string | null) ?? null);
    const lotControl = asBool(detail.lot_control) ?? (lot && lot.lot_control !== null ? Number(lot.lot_control) === 1 : null) ?? false;
    if (format === "V" && lotControl) raise("22023", "erp_catalog_lot_control_variations");
    detail = productCustomResolve(db, id, detail);
    const currentDetail = productDetailData(db, id, false)!;
    detailChanged = jsonbText({ ...currentDetail, ...detail }) !== jsonbText(currentDetail);
    const rowActive = Number(row.active) === 1;
    changed = baseChanged || detailChanged || (active !== null && active !== rowActive);
    if (changed) {
      if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
      updateRecord(
        ctx,
        id,
        { entity: "products", active: rowActive },
        {
          name: baseChanged ? (v.name as string) : String(row.name),
          code: baseChanged ? ((v.code as string | null) ?? null) : ((row.code as string | null) ?? null),
          active: active ?? rowActive,
        },
        user!,
      );
      if (baseChanged) writeFields(ctx, id, "products", v);
      if (!isEmpty(detail)) productDetailWrite(ctx, id, detail);
    }
  }
  const result = { entity: "products", record: productFull(db, target), replayed: false, data_mode: "erp_native" };
  const audit = (action: string, beforeData: unknown, afterData: unknown) =>
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      user,
      command,
      "products",
      target,
      action,
      beforeData === null ? null : jsonbText(beforeData),
      jsonbText(afterData),
      ctx.clock.next().toString(),
    );
  if (changed)
    audit(
      id === null ? "create" : !baseChanged && !detailChanged ? (active ? "restore" : "archive") : "update",
      before,
      productFull(db, target),
    );
  if (codes.length > 0) audit("warnings_acknowledged", null, { warnings: codes });
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_product_save", erpCatalogProductSave);
