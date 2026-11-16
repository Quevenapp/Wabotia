// public.erp_catalog_product_variation_add: cria a variação (SKU filho,
// vendável, com código e preço próprios) de um pai com formato V, pela
// gravação do cadastro (erp_catalog_save) com o mesmo comando. A combinação
// de atributos é única por pai.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLeft, pgLower } from "../../../engine/text.ts";
import { permitted } from "../../access/public.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { uuidArg } from "../pricing/args.ts";
import { CNTRL, btrim, chars, compareText } from "../fields.ts";
import { dto } from "../internal.ts";
import { variationDto } from "../product-variations.ts";
import { erpCatalogSave } from "./erp_catalog_save.ts";

const invalid = (): never => raise("22023", "erp_catalog_variation_invalid");
const PARENT_KEYS = [
  "unit", "kind", "ncm", "brand", "condition", "production", "net_weight", "gross_weight", "width", "height", "depth",
  "dimension_unit", "volumes", "items_per_box", "cest", "origin",
];

export function erpCatalogProductVariationAdd(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const command = uuidArg(a, "p_command_id");
  const parent = uuidArg(a, "p_parent");
  const input = jsonArg(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  if (!permitted(db, user!, "cadastros.produtos.variacoes")) raise("42501", "erp_catalog_access_denied");
  if (
    command === null ||
    parent === null ||
    input === null ||
    jsonType(input) !== "object" ||
    jsonbKeys(input).some((k) => !["attributes", "code", "gtin", "price"].includes(k)) ||
    !("attributes" in input) ||
    !("code" in input) ||
    jsonType(input.attributes) !== "object" ||
    Object.keys(input.attributes as object).length < 1 ||
    Object.keys(input.attributes as object).length > 5
  )
    invalid();
  const raw = input!.attributes as Record<string, unknown>;
  for (const k of jsonbKeys(raw)) {
    const v = raw[k];
    if (
      chars(btrim(k)) < 1 ||
      chars(btrim(k)) > 60 ||
      CNTRL.test(k) ||
      jsonType(v) !== "string" ||
      chars(btrim(v as string)) < 1 ||
      chars(btrim(v as string)) > 60 ||
      CNTRL.test(v as string)
    )
      invalid();
  }
  // jsonb_object_agg(btrim(key), btrim(value)) na ordem do jsonb: a última chave repetida vence.
  const attrs: Record<string, string> = {};
  for (const k of jsonbKeys(raw)) attrs[btrim(k)] = btrim(raw[k] as string);
  const key = Object.entries(attrs)
    .map(([k, v]) => [pgLower(k), `${pgLower(k)}=${pgLower(v)}`])
    .sort((x, y) => compareText(x[0], y[0]))
    .map((x) => x[1])
    .join("|");
  const prior = one(db, 'SELECT parent_id, child_id FROM "erp_catalog__product_variation" WHERE command_id=?', command);
  if (prior) {
    if (!one(db, 'SELECT 1 x FROM "erp_catalog__product_variation" WHERE command_id=? AND parent_id=? AND attributes_key=?', command, parent, key))
      raise("40001", "erp_catalog_command_conflict");
    return {
      ...(variationDto(db, String(prior.parent_id)) ?? {}),
      scope: "product_variation_command",
      data_mode: "erp_native",
      replayed: true,
      child_id: prior.child_id,
    };
  }
  const p = dto(db, parent!);
  if (p === null || p.entity !== "products" || p.format !== "V" || p.active !== true) raise("22023", "erp_catalog_variation_parent_invalid");
  if (one(db, 'SELECT 1 x FROM "erp_catalog__product_variation" WHERE child_id=?', parent)) raise("22023", "erp_catalog_variation_parent_invalid");
  if (one(db, 'SELECT 1 x FROM "erp_catalog__product_variation" WHERE parent_id=? AND attributes_key=?', parent, key))
    raise("23505", "erp_catalog_variation_duplicate");
  const suffix = Object.keys(attrs)
    .sort(compareText)
    .map((k) => attrs[k])
    .join(" ");
  const name = pgLeft(`${p.name} ${suffix}`, 200);
  const inherited = Object.fromEntries(PARENT_KEYS.filter((k) => p[k] !== null && p[k] !== undefined).map((k) => [k, p[k]]));
  const price = input!.price === undefined || input!.price === null ? null : typeof input!.price === "string" ? input!.price : jsonbText(input!.price);
  const code = input!.code === null ? null : typeof input!.code === "string" ? input!.code : jsonbText(input!.code);
  const childData: Record<string, unknown> = {
    ...inherited,
    name,
    code,
    format: "S",
    price: price ?? (p.price as string | null) ?? "0",
    ...("gtin" in input! && input!.gtin !== null ? { gtin: typeof input!.gtin === "string" ? input!.gtin : jsonbText(input!.gtin) } : {}),
  };
  const child = erpCatalogSave(ctx, {
    p_user_id: user, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: command, p_data: childData,
  }) as { record: { id: string } };
  const position =
    Number(one(db, 'SELECT coalesce(max(position),0) p FROM "erp_catalog__product_variation" WHERE parent_id=?', parent)!.p) + 1;
  db.exec(
    `INSERT INTO "erp_catalog__product_variation"(child_id, parent_id, attributes, attributes_key, position, command_id, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    child.record.id,
    parent,
    jsonbText(attrs),
    key,
    position,
    command,
    user,
    ctx.clock.next().toString(),
  );
  return { scope: "product_variation_command", data_mode: "erp_native", replayed: false, child_id: child.record.id, ...variationDto(db, parent!) };
}

registerRpc("erp_catalog_product_variation_add", erpCatalogProductVariationAdd);
