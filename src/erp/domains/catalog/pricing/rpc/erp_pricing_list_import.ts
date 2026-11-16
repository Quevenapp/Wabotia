// public.erp_pricing_list_import: a planilha modelo (código e preço) liga
// produtos à lista; o preço só vale na lista customizada. Devolve o resumo
// (incluídos, alterados, iguais, repetidos, não achados e ambíguos).
import { one } from "../../../../engine/driver.ts";
import { raise } from "../../../../engine/errors.ts";
import { arrow, jsonbKeys, jsonType } from "../../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../../engine/registry.ts";
import { pgLower } from "../../../../engine/text.ts";
import { intArg, jsonArg, uuidArg } from "../../args.ts";
import { requestHash } from "../../command.ts";
import { CNTRL, btrim, chars, compareText } from "../../fields.ts";
import { unitPrice } from "../../internal.ts";
import { compareNum, num } from "../money.ts";
import { audit, bumpVersion, header, loadList, replay, requirePricing, storeCommand } from "../pricing.ts";

const MAX_VERSION = 2147483647;
const invalid = (): never => raise("22023", "erp_pricing_invalid_data");
/** lower() do Postgres (mapeamento simples, engine/text.ts). */
const lower = pgLower;

export function erpPricingListImport(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const rows = jsonArg(a, "p_rows") as Record<string, unknown>[] | null;
  const db = ctx.db;
  requirePricing(db, user, true);
  const badRow = (x: Record<string, unknown>) => {
    if (jsonType(x) !== "object") return true;
    if (jsonbKeys(x).some((k) => !["code", "price"].includes(k))) return true;
    if (jsonType(x.code) !== "string") return true;
    const code = x.code as string;
    const n = chars(btrim(code));
    if (n < 1 || n > 100 || CNTRL.test(code)) return true;
    if ("price" in x && !["string", "null"].includes(jsonType(x.price)!)) return true;
    const price = arrow(x, "price");
    return price !== null && chars(price) > 80;
  };
  if (
    id === null ||
    expected === null ||
    expected < 1 ||
    rows === null ||
    jsonType(rows) !== "array" ||
    rows.length < 1 ||
    rows.length > 500 ||
    rows.some(badRow)
  )
    invalid();
  const hash = requestHash({ actor: user, action: "import", id, version: expected, rows });
  const replayed = replay(ctx, user!, command, hash);
  if (replayed) return replayed;
  const list = loadList(db, id);
  if (!list) raise("P0002", "erp_pricing_not_found");
  if (list.version !== expected) raise("40001", "erp_pricing_version_conflict");
  const priceOf = (x: Record<string, unknown>) => {
    const p = arrow(x, "price");
    return p === null || btrim(p) === "" ? null : btrim(p);
  };
  // Lista por regra (acréscimo, desconto, período) calcula o preço: preço na planilha só na customizada.
  if (list.list_type !== "custom" && rows!.some((x) => priceOf(x) !== null)) invalid();
  const count = () => Number(one(db, 'SELECT count(*) n FROM "erp_pricing__price_list_item" WHERE list_id=?', id)!.n);
  const before = count();
  // Produtos vivos por código (lower em TS: o do SQLite é só ASCII).
  const byCode = new Map<string, string[]>();
  for (const r of db.exec(
    `SELECT r.id, r.code FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
     WHERE r.entity='products' AND r.code IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)`,
  ).rows) {
    const key = lower(String(r.code));
    byCode.set(key, [...(byCode.get(key) ?? []), String(r.id)]);
  }
  const seen = new Set<string>();
  let added = 0,
    updated = 0,
    unchanged = 0,
    duplicates = 0,
    missingTotal = 0,
    ambiguousTotal = 0;
  const missing: string[] = [],
    ambiguous: string[] = [];
  for (const x of rows!) {
    const code = btrim(x.code as string);
    const key = lower(code);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const raw = priceOf(x);
    const price = raw === null ? null : unitPrice(raw, 14);
    const ids = (byCode.get(key) ?? []).slice().sort(compareText);
    if (ids.length === 0) {
      missingTotal++;
      if (missing.length < 50) missing.push(code);
      continue;
    }
    if (ids.length > 1) {
      ambiguousTotal++;
      if (ambiguous.length < 50) ambiguous.push(code);
      continue;
    }
    const current = one(
      db,
      'SELECT custom_price FROM "erp_pricing__price_list_item" WHERE list_id=? AND product_id=?',
      id,
      ids[0],
    );
    if (current === null) {
      db.exec(
        'INSERT INTO "erp_pricing__price_list_item"(list_id, product_id, custom_price, added_at) VALUES (?,?,?,?)',
        id,
        ids[0],
        price,
        ctx.clock.next().toString(),
      );
      added++;
    } else if (
      price !== null &&
      (current.custom_price === null || compareNum(num(String(current.custom_price)), num(price)) !== 0)
    ) {
      db.exec('UPDATE "erp_pricing__price_list_item" SET custom_price=? WHERE list_id=? AND product_id=?', price, id, ids[0]);
      updated++;
    } else unchanged++;
  }
  if (before + added > 15000) raise("22023", "erp_pricing_item_limit");
  if (added + updated > 0) {
    if (list.version === MAX_VERSION) raise("40001", "erp_pricing_version_exhausted");
    bumpVersion(ctx, id!, user!);
  }
  const head = header(db, id!)!;
  const result = {
    saved: true,
    list: head,
    added,
    updated,
    unchanged,
    duplicates,
    not_found: missing,
    not_found_total: missingTotal,
    ambiguous,
    ambiguous_total: ambiguousTotal,
    replayed: false,
    data_mode: "erp_native",
  };
  if (added + updated > 0)
    audit(ctx, {
      actor: user!,
      command: command!,
      list: id!,
      action: "items",
      before: { products: before },
      after: { import: { rows: rows!.length, added, updated }, products: head.products },
    });
  storeCommand(ctx, user!, command!, hash, result);
  return result;
}

registerRpc("erp_pricing_list_import", erpPricingListImport);
