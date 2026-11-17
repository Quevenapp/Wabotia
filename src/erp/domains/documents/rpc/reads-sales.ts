// Sacola de vendas, origem da cópia e checkout de pedidos (sessão L, bloco
// B0). Portado de public.erp_document_sales_bag, _sales_bag_change,
// _copy_origin, _checkout_get e _checkout_lookup com os mesmos nomes.
// erp_document_mirror.require_visible abre _copy_origin e _checkout_get, e o
// _checkout_lookup filtra por erp_document_mirror.visible, como no oráculo
// (mirrorRequireVisible e mirrorVisible, com o ramo do espelho).
// O sales_bag_change é escritor (comando com recibo próprio,
// erp_documents.sales_bag_command): o lock consultivo por usuário não tem
// equivalente nem necessidade no objeto (uma transação por vez).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { formatScaled, fromColumn, toParam, toScaled } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLeft } from "../../../engine/text.ts";
import { unitPriceNumeric } from "../../catalog/public.ts";
import { decimalValue } from "../internal.ts";
import { contactUsable, mirrorRequireVisible, mirrorVisible, requireAccess } from "../public.ts";
import { checkoutView, copySourceDto } from "../views.ts";
import { bool, cmpUuid } from "./reads-common.ts";

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;

/** erp_documents.sales_bag_view(p_user_id): os itens da sacola do usuário, na ordem em que entraram. */
export function salesBagView(db: SqlDriver, user: string | null) {
  const rows =
    user === null
      ? []
      : db.exec(
          `SELECT b.product_id, CAST(b.quantity AS TEXT) quantity, CAST(b.added_at AS TEXT) added_at, r.name, r.code, r.active, p.unit, p.price, p.kind
             FROM "erp_documents__sales_bag_item" b JOIN "erp_catalog__record" r ON r.id=b.product_id JOIN "erp_catalog__product" p ON p.record_id=b.product_id
            WHERE b.user_id=?`,
          user,
        ).rows;
  rows.sort((x, y) => {
    const a = BigInt(String(x.added_at)),
      b = BigInt(String(y.added_at));
    return a < b ? -1 : a > b ? 1 : cmpUuid(x.product_id, y.product_id);
  });
  return {
    items: rows.map((b) => ({
      product_id: b.product_id,
      name: pgLeft(String(b.name), 200),
      code: b.code === null ? null : pgLeft(String(b.code), 100),
      unit: b.unit === null ? null : pgLeft(String(b.unit), 16),
      price: unitPriceNumeric(b.price, 10),
      quantity: formatScaled(fromColumn(b.quantity), 6),
      active: bool(b.active),
      kind: b.kind,
    })),
    count: rows.length,
    limit: 250,
    ...NATIVE,
  };
}

/** public.erp_document_sales_bag(p_user_id) */
export function erpDocumentSalesBag(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id);
  requireAccess(ctx.db, user, "sales_orders", true);
  return salesBagView(ctx.db, user);
}

const BAG_MAX = toScaled("999999999.999999", 6);

/** public.erp_document_sales_bag_change(p_user_id, p_command_id, p_action, p_product_id, p_quantity): incluir, alterar, tirar ou esvaziar. */
export function erpDocumentSalesBagChange(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    command = str(a.p_command_id),
    action = str(a.p_action),
    product = str(a.p_product_id),
    quantity = str(a.p_quantity);
  requireAccess(ctx.db, user, "sales_orders", true);
  if (
    command === null ||
    action === null ||
    !["add", "set", "remove", "clear"].includes(action) ||
    (action === "clear") !== (product === null) ||
    ["add", "set"].includes(action) !== (quantity !== null)
  )
    raise("22023", "erp_document_sales_bag_invalid");
  const hash = createHash("sha256").update(jsonbText({ actor: user, action, product, quantity }), "utf8").digest("hex");
  const done = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_documents__sales_bag_command" WHERE command_id=?', command);
  if (done) {
    if (done.actor !== user || done.request_hash !== hash) raise("40001", "erp_document_sales_bag_command_conflict");
    return { ...JSON.parse(String(done.result)), replayed: true };
  }
  if (action === "add" || action === "set") {
    let q = toScaled(decimalValue(quantity, 6, 9), 6);
    if (q <= 0n) raise("22023", "erp_document_sales_bag_invalid");
    if (!one(ctx.db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=? AND r.active=1', product))
      raise("22023", "erp_document_sales_bag_product_unavailable");
    const current = one(ctx.db, 'SELECT CAST(quantity AS TEXT) quantity FROM "erp_documents__sales_bag_item" WHERE user_id=? AND product_id=?', user, product);
    if (!current) {
      if (Number(one(ctx.db, 'SELECT count(*) n FROM "erp_documents__sales_bag_item" WHERE user_id=?', user)!.n) >= 250)
        raise("22023", "erp_document_sales_bag_full");
      const now = ctx.clock.next().toString();
      ctx.db.exec(
        'INSERT INTO "erp_documents__sales_bag_item"(user_id, product_id, quantity, added_at, updated_at) VALUES (?,?,?,?,?)',
        user,
        product,
        toParam(q),
        now,
        now,
      );
    } else {
      if (action === "add") q += fromColumn(current.quantity);
      if (q > BAG_MAX) raise("22023", "erp_document_sales_bag_invalid");
      ctx.db.exec(
        'UPDATE "erp_documents__sales_bag_item" SET quantity=?, updated_at=? WHERE user_id=? AND product_id=?',
        toParam(q),
        ctx.clock.next().toString(),
        user,
        product,
      );
    }
  } else if (action === "remove") ctx.db.exec('DELETE FROM "erp_documents__sales_bag_item" WHERE user_id=? AND product_id=?', user, product);
  else ctx.db.exec('DELETE FROM "erp_documents__sales_bag_item" WHERE user_id=?', user);
  requireAccess(ctx.db, user, "sales_orders", true);
  const result = { ...salesBagView(ctx.db, user), action, product_id: product, replayed: false };
  ctx.db.exec(
    'INSERT INTO "erp_documents__sales_bag_command"(command_id, actor, request_hash, action, result, created_at) VALUES (?,?,?,?,?,?)',
    command,
    user,
    hash,
    action,
    jsonbText(result),
    ctx.clock.next().toString(),
  );
  return result;
}

/** public.erp_document_copy_origin(p_user_id, p_kind, p_document_id): de que documento este foi copiado. */
export function erpDocumentCopyOrigin(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  mirrorRequireVisible(ctx.db, user, id, false);
  requireAccess(ctx.db, user, kind, false);
  if (id === null || kind === null || !one(ctx.db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind))
    raise("P0002", "erp_document_not_found");
  return { document_id: id, kind, copy_source: copySourceDto(ctx.db, id), ...NATIVE };
}

/** public.erp_document_checkout_get(p_user_id, p_id): o pedido para o checkout. */
export function erpDocumentCheckoutGet(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    id = str(a.p_id);
  mirrorRequireVisible(ctx.db, user, id, false);
  requireAccess(ctx.db, user, "sales_orders", true);
  const d = id === null ? null : one(ctx.db, `SELECT contact_id FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, id);
  if (!d || !contactUsable(ctx.db, user, str(d.contact_id))) raise("P0002", "erp_document_not_found");
  return checkoutView(ctx.db, id!);
}

/** public.erp_document_checkout_lookup(p_user_id, p_number): o pedido pelo número lido no checkout. */
export function erpDocumentCheckoutLookup(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    number = str(a.p_number);
  requireAccess(ctx.db, user, "sales_orders", true);
  if (number === null || !/^[1-9][0-9]{0,9}$/.test(number)) raise("22023", "erp_document_query_invalid");
  const ids = ctx.db
    .exec(
      `SELECT d.id, d.contact_id FROM "erp_documents__document" d
        WHERE d.kind='sales_orders' AND d.number=? AND d.authority='brufap' AND d.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM "erp_documents__origin_mirror" m WHERE m.document_id=d.id AND m.source_deleted=1)`,
      number,
    )
    .rows.filter((d) => mirrorVisible(ctx.db, user, String(d.id)))
    .map((d) => String(d.id))
    .sort(cmpUuid);
  if (ids.length === 0) raise("P0002", "erp_document_not_found");
  if (ids.length > 1) raise("40001", "erp_document_checkout_ambiguous");
  return { kind: "sales_orders", id: ids[0], number, ...NATIVE };
}

registerRpc("erp_document_sales_bag", erpDocumentSalesBag);
registerRpc("erp_document_sales_bag_change", erpDocumentSalesBagChange);
registerRpc("erp_document_copy_origin", erpDocumentCopyOrigin);
registerRpc("erp_document_checkout_get", erpDocumentCheckoutGet);
registerRpc("erp_document_checkout_lookup", erpDocumentCheckoutLookup);

