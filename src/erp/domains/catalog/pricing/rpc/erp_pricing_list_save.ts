// public.erp_pricing_list_save: inclui ou altera uma lista de preço (tipo
// fixo depois de incluída), com os vínculos da categoria e, na inclusão, os
// produtos selecionados. Nome repetido (sem acento e sem caixa) não grava.
import { toParam, toScaled } from "../../../../engine/dec.ts";
import { one } from "../../../../engine/driver.ts";
import { raise } from "../../../../engine/errors.ts";
import { arrow, jsonbText, jsonbKeys, jsonType } from "../../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { validDate } from "../../../../engine/time.ts";
import { jsonArg } from "../../args.ts";
import { intArg, uuidArg } from "../args.ts";
import { requestHash } from "../../command.ts";
import { CNTRL, btrim, chars, compareText } from "../../fields.ts";
import { fold } from "../../internal.ts";
import { detailUuid } from "../deps.ts";
import { compareNum, num } from "../money.ts";
import {
  allLists,
  audit,
  header,
  loadList,
  replay,
  requirePricing,
  storeCommand,
  UFS,
  bumpVersion,
  checkViolation,
  liveProduct,
  type PriceList,
} from "../pricing.ts";

const KEYS = [
  "name", "category", "list_type", "factor", "factor_unit", "direction", "considers_datetime", "starts_on", "ends_on",
  "start_time", "end_time", "contacts", "regions", "sellers", "payment_methods", "add_products",
];
const FACTOR = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAX_VERSION = 2147483647;

const invalid = (): never => raise("22023", "erp_pricing_invalid_data");
const length = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** array_agg(distinct detail_uuid(c)): ids distintos (null conta como um). */
function uuids(values: unknown[]) {
  const out = new Set<string | null>();
  for (const v of values) out.add(detailUuid(v));
  return [...out];
}

/** (texto)::date dentro do bloco com exception: data inexistente → invalid_data. */
function date(value: string | null) {
  if (value === null) return null;
  if (!validDate(value)) invalid();
  return value;
}

export function erpPricingListSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const data = jsonArg(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  requirePricing(db, user, true);
  const optArray = (k: string) => (data![k] === undefined ? [] : data![k]);
  if (
    data === null ||
    jsonType(data) !== "object" ||
    expected === null ||
    (id === null && expected !== 0) ||
    (id !== null && (expected < 1 || expected > MAX_VERSION)) ||
    jsonbKeys(data).some((k) => !KEYS.includes(k)) ||
    jsonType(data.name) !== "string" ||
    jsonType(data.considers_datetime) !== "boolean" ||
    jsonType(data.contacts) !== "array" ||
    length(data.contacts) > 30 ||
    jsonType(data.regions) !== "array" ||
    jsonType(optArray("sellers")) !== "array" ||
    length(optArray("sellers")) > 30 ||
    jsonType(optArray("payment_methods")) !== "array" ||
    length(optArray("payment_methods")) > 30 ||
    jsonType(optArray("add_products")) !== "array" ||
    length(optArray("add_products")) > 500 ||
    (id !== null && "add_products" in data) ||
    (arrow(data, "factor") !== null && !FACTOR.test(arrow(data, "factor")!)) ||
    (arrow(data, "starts_on") !== null && !DATE.test(arrow(data, "starts_on")!)) ||
    (arrow(data, "ends_on") !== null && !DATE.test(arrow(data, "ends_on")!)) ||
    (arrow(data, "start_time") !== null && !TIME.test(arrow(data, "start_time")!)) ||
    (arrow(data, "end_time") !== null && !TIME.test(arrow(data, "end_time")!))
  )
    invalid();
  const name = btrim(data!.name as string);
  const category = arrow(data, "category");
  const listType = arrow(data, "list_type");
  const factor = arrow(data, "factor");
  const factorUnit = arrow(data, "factor_unit");
  const direction = arrow(data, "direction");
  const considers = data!.considers_datetime as boolean;
  const startsOn = date(arrow(data, "starts_on"));
  const endsOn = date(arrow(data, "ends_on"));
  const startTime = arrow(data, "start_time");
  const endTime = arrow(data, "end_time");
  const contactsIn = data!.contacts as unknown[];
  const regionsIn = data!.regions as unknown[];
  const sellersIn = optArray("sellers") as unknown[];
  const methodsIn = optArray("payment_methods") as unknown[];
  const productsIn = optArray("add_products") as unknown[];
  const contacts = uuids(contactsIn);
  const regions = [...new Set(regionsIn.filter((g) => typeof g === "string") as string[])].sort(compareText);
  const sellers = uuids(sellersIn);
  const methods = uuids(methodsIn);
  const products = uuids(productsIn);
  const f = factor === null ? null : num(factor);
  const missing = (sql: string, ids: (string | null)[]) => ids.some((x) => x === null || one(db, sql, x) === null);
  const inRange = (d: string | null) => d === null || (d >= "1900-01-01" && d <= "2100-12-31");
  if (
    name === "" ||
    chars(name) > 120 ||
    CNTRL.test(name) ||
    category === null ||
    !["other", "contact", "seller", "payment_method", "region"].includes(category) ||
    listType === null ||
    !["rates", "period", "custom"].includes(listType) ||
    factorUnit === null ||
    !["percent", "amount"].includes(factorUnit) ||
    direction === null ||
    !["increase", "discount"].includes(direction) ||
    (listType !== "custom" && (f === null || f.v <= 0n)) ||
    (factorUnit === "percent" && direction === "discount" && f !== null && compareNum(f, num("100")) > 0) ||
    contacts.length !== contactsIn.length ||
    regions.length !== regionsIn.length ||
    sellers.length !== sellersIn.length ||
    methods.length !== methodsIn.length ||
    products.length !== productsIn.length ||
    (category !== "contact" && contacts.length > 0) ||
    (category !== "region" && regions.length > 0) ||
    (category !== "seller" && sellers.length > 0) ||
    (category !== "payment_method" && methods.length > 0) ||
    regions.some((s) => !UFS.includes(s)) ||
    missing('SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', contacts) ||
    missing('SELECT 1 x FROM "erp_catalog__seller" WHERE id=?', sellers) ||
    missing('SELECT 1 x FROM "erp_catalog__payment_method" WHERE id=?', methods) ||
    products.some((p) => p === null || !liveProduct(db, p)) ||
    !inRange(startsOn) ||
    !inRange(endsOn) ||
    (startsOn !== null && endsOn !== null && startsOn > endsOn) ||
    (!considers && (startTime !== null || endTime !== null)) ||
    (listType === "period" && startsOn === null && endsOn === null) ||
    (considers && startsOn !== null && startsOn === endsOn && startTime !== null && endTime !== null && startTime > endTime)
  )
    invalid();
  const hash = requestHash({ actor: user, action: "save", id, version: expected, data });
  const replayed = replay(ctx, user!, command, hash);
  if (replayed) return replayed;
  const folded = fold(name);
  if (allLists(db).some((l) => fold(l.name) === folded && l.id !== id))
    return { saved: false, reason: "duplicate_name", replayed: false, data_mode: "erp_native" };
  const values = [
    name, category, listType, f === null ? null : toParam(toScaled(factor!, 4)), factorUnit, direction, considers ? 1 : 0,
    startsOn, endsOn, startTime === null ? null : `${startTime}:00`, endTime === null ? null : `${endTime}:00`,
  ];
  // CHECK price_list_factor_check (factor > 0): só a lista customizada chega aqui com 0.
  const factorOk = f === null || f.v > 0n;
  let target: string;
  let before: Record<string, unknown> | null = null;
  let changed: boolean;
  let previous: PriceList | null = null;
  if (id === null) {
    if (allLists(db).length >= 1000) raise("22023", "erp_pricing_limit");
    if (!factorOk) checkViolation("price_list", "price_list_factor_check");
    target = crypto.randomUUID();
    const now = ctx.clock.next().toString();
    db.exec(
      `INSERT INTO "erp_pricing__price_list"(id, name, category, list_type, factor, factor_unit, direction, considers_datetime,
       starts_on, ends_on, start_time, end_time, version, created_by, updated_by, created_at, updated_at, name__fold)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      target,
      ...values,
      user,
      user,
      now,
      now,
      folded,
    );
    for (const p of products)
      db.exec(
        'INSERT INTO "erp_pricing__price_list_item"(list_id, product_id, custom_price, added_at) VALUES (?,?,NULL,?)',
        target,
        p,
        ctx.clock.next().toString(),
      );
    changed = true;
  } else {
    previous = loadList(db, id);
    if (!previous) raise("P0002", "erp_pricing_not_found");
    if (previous.version !== expected) raise("40001", "erp_pricing_version_conflict");
    // O tipo é escolhido na inclusão (como no Origin).
    if (listType !== previous.list_type) invalid();
    target = id;
    before = header(db, id);
    if (!factorOk) checkViolation("price_list", "price_list_factor_check");
    db.exec(
      `UPDATE "erp_pricing__price_list" SET name=?, category=?, list_type=?, factor=?, factor_unit=?, direction=?,
       considers_datetime=?, starts_on=?, ends_on=?, start_time=?, end_time=?, name__fold=? WHERE id=?`,
      ...values,
      folded,
      id,
    );
    for (const t of ["contact", "region", "seller", "payment_method"])
      db.exec(`DELETE FROM "erp_pricing__price_list_${t}" WHERE list_id=?`, id);
    changed = false;
  }
  for (const c of contacts) db.exec('INSERT INTO "erp_pricing__price_list_contact"(list_id, contact_id) VALUES (?,?)', target, c);
  for (const s of regions) db.exec('INSERT INTO "erp_pricing__price_list_region"(list_id, state) VALUES (?,?)', target, s);
  for (const s of sellers) db.exec('INSERT INTO "erp_pricing__price_list_seller"(list_id, seller_id) VALUES (?,?)', target, s);
  for (const m of methods)
    db.exec('INSERT INTO "erp_pricing__price_list_payment_method"(list_id, payment_method_id) VALUES (?,?)', target, m);
  if (id !== null) {
    const strip = (h: Record<string, unknown> | null) => {
      const { version: _v, updated_at: _u, ...rest } = h!;
      return jsonbText(rest);
    };
    changed = strip(header(db, target)) !== strip(before);
    if (changed) {
      if (previous!.version === MAX_VERSION) raise("40001", "erp_pricing_version_exhausted");
      bumpVersion(ctx, target, user!);
    }
  }
  const list = header(db, target)!;
  const result = { saved: true, list, replayed: false, data_mode: "erp_native" };
  if (changed)
    audit(ctx, {
      actor: user!,
      command: command!,
      list: target,
      action: id === null ? "create" : "update",
      before,
      after: products.length > 0 ? { ...list, added_products: products.length } : list,
    });
  storeCommand(ctx, user!, command!, hash, result);
  return result;
}

registerRpc("erp_pricing_list_save", erpPricingListSave);
