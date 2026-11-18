// Composição: definições finais 222/260; quantidades em escala 6, preços em 10.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { deferForeignKeys } from "../../../engine/fk.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import * as catalog from "../../catalog/public.ts";
import { compositionApplyValues, compositionDto, compositionTotals } from "../composition.ts";
import { ignoredWarehouse } from "../home.ts";
import { commandTaken, requireAccess, reservationWriteAccess, sha256, supplyPart } from "../internal.ts";
import { priceText } from "../ledger.ts";
import { compositionSettings } from "../public.ts";
import { COMPOSITION_CURRENT, virtualQuantity } from "../read.ts";
import { componentProblem, compositionLines } from "./document-stock.ts";
import { post } from "./erp_stock_post.ts";
import { price105 } from "./launch.ts";
const fold = (s: string) => catalog.fold(s)!;
const t6 = (n: bigint) => formatScaled(n, 6);
const price = (v: unknown) => (v === null || v === undefined ? null : priceText(toScaled(String(v), 10)));
const virtualText = (v: bigint | null) => (v === null ? null : t6(rescale(v, 0, 6)));
const qty = (v: unknown) => (v === null || v === undefined ? null : t6(fromColumn(v)));
const cost = (db: SqlDriver, id: unknown) =>
  price(one(db, "SELECT cost_price FROM erp_catalog__product_supplier WHERE record_id=? AND is_default=1", id)?.cost_price);
function stock(db: SqlDriver, id: unknown) {
  return t6(
    db
      .exec("SELECT warehouse_id, CAST(quantity AS TEXT) q FROM erp_stock__balance WHERE product_id=?", id)
      .rows.reduce((s, b) => s + (ignoredWarehouse(db, String(b.warehouse_id)) ? 0n : fromColumn(b.q)), 0n),
  );
}
const nameOrder = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  pgCompareText(fold(String(a.name)), fold(String(b.name))) || pgCompareText(String(a.id), String(b.id));

registerRpc("erp_stock_composition_get", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    id = a.p_product_id as string;
  catalog.requireAccess(db, user, "products", false);
  if (id === null) raise("22023", "erp_stock_invalid_query");
  const p = one(
    db,
    "SELECT r.id,r.name,r.code,r.active,r.version,p.kind,p.format,p.unit,p.price,CAST(p.net_weight AS TEXT) nw,CAST(p.gross_weight AS TEXT) gw FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=? AND r.entity='products'",
    id,
  );
  if (!p) raise("P0002", "erp_stock_product_not_found");
  const visible = catalog.canReadStock(db, user),
    c = compositionDto(db, id);
  const items = db
    .exec(
      `SELECT i.position,i.component_id,CAST(i.quantity AS TEXT) q,r.name,r.code,r.active,p.unit,p.kind,p.format,p.price FROM ${COMPOSITION_CURRENT} i JOIN erp_catalog__record r ON r.id=i.component_id JOIN erp_catalog__product p ON p.record_id=i.component_id WHERE i.product_id=? ORDER BY i.position`,
      id,
    )
    .rows.map((i) => ({
      position: i.position,
      component_id: i.component_id,
      name: i.name,
      code: i.code,
      unit: i.unit,
      kind: i.kind,
      format: i.format,
      active: !!i.active,
      problem: componentProblem(db, String(i.component_id)),
      quantity: qty(i.q),
      price: price(i.price),
      cost_price: cost(db, i.component_id),
      stock: visible ? stock(db, i.component_id) : null,
    }));
  const virtual =
    visible && c?.stock_type === "virtual" && p.format === "E"
      ? {
          quantity: virtualText(virtualQuantity(db, id, null)),
          warehouses: db
            .exec(
              `SELECT w.record_id id,r.name,r.active FROM erp_catalog__warehouse w JOIN erp_catalog__record r ON r.id=w.record_id WHERE r.active=1 OR EXISTS(SELECT 1 FROM erp_stock__balance b JOIN ${COMPOSITION_CURRENT} i ON i.component_id=b.product_id WHERE i.product_id=? AND b.warehouse_id=w.record_id)`,
              id,
            )
            .rows.sort(nameOrder)
            .map((w) => ({
              warehouse_id: w.id,
              name: w.name,
              active: !!w.active,
              ignored: ignoredWarehouse(db, String(w.id)),
              quantity: virtualText(virtualQuantity(db, id, String(w.id))),
            })),
        }
      : null;
  return {
    scope: "stock_composition",
    data_mode: "erp_native",
    product: {
      id: p.id,
      name: p.name,
      code: p.code,
      kind: p.kind,
      format: p.format,
      unit: p.unit,
      active: !!p.active,
      version: p.version,
      price: price(p.price),
      net_weight: qty(p.nw),
      gross_weight: qty(p.gw),
      cost_price: cost(db, id),
      default_supplier: !!one(db, "SELECT 1 FROM erp_catalog__product_supplier WHERE record_id=? AND is_default=1", id),
    },
    stock_visible: visible,
    composition: c ? { stock_type: c.stock_type, post_mode: c.post_mode, version: c.version, updated_at: c.updated_at } : null,
    items,
    totals: compositionTotals(db, id),
    virtual,
    used_in: one(
      db,
      `SELECT count(DISTINCT i.product_id) n FROM ${COMPOSITION_CURRENT} i JOIN erp_catalog__product k ON k.record_id=i.product_id WHERE i.component_id=? AND k.format='E'`,
      id,
    )!.n,
    settings: compositionSettings(db),
  };
});

registerRpc("erp_stock_composition_components", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    q = a.p_query as string;
  catalog.requireAccess(db, user, "products", false);
  if (q === null || pgLength(pgBtrim(q)) < 1 || pgLength(pgBtrim(q)) > 120 || pgHasCntrl.test(q)) raise("22023", "erp_stock_invalid_query");
  const visible = catalog.canReadStock(db, user),
    key = fold(pgBtrim(q));
  const rows = db
    .exec(
      "SELECT r.id,r.name,r.code,p.unit,p.price,p.gtin FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.entity='products' AND r.active=1 AND p.kind='P' AND p.format='S' AND p.unit IS NOT NULL AND (? IS NULL OR r.id<>?) AND NOT EXISTS(SELECT 1 FROM erp_catalog__product_detail d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)",
      a.p_exclude,
      a.p_exclude,
    )
    .rows.filter((r) => fold(String(r.name)).includes(key) || fold(String(r.code ?? "")).includes(key) || r.gtin === pgBtrim(q))
    .sort(nameOrder);
  return {
    scope: "stock_composition_components",
    data_mode: "erp_native",
    query: q,
    stock_visible: visible,
    total: rows.length,
    items: rows
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        unit: r.unit,
        price: price(r.price),
        cost_price: cost(db, r.id),
        stock: visible ? stock(db, r.id) : null,
      })),
  };
});

registerRpc("erp_stock_composition_export", (ctx, a) => {
  const db = ctx.db,
    offset = a.p_offset as number,
    limit = a.p_limit as number,
    deleted = a.p_include_deleted as boolean;
  catalog.requireAccess(db, a.p_user_id as string, "products", false);
  if (offset === null || offset < 0 || offset > 10000000 || limit === null || limit < 1 || limit > 500 || deleted === null)
    raise("22023", "erp_stock_invalid_query");
  const rows = db
    .exec(
      `SELECT i.product_id,i.position,i.component_id,CAST(i.quantity AS TEXT) q,i.stock_type,i.post_mode,k.name kit_name,k.code kit_code,d.deleted_at,x.name component_name,x.code component_code,p.unit component_unit FROM ${COMPOSITION_CURRENT} i JOIN erp_catalog__product kp ON kp.record_id=i.product_id AND kp.format='E' JOIN erp_catalog__record k ON k.id=i.product_id LEFT JOIN erp_catalog__product_detail d ON d.record_id=i.product_id JOIN erp_catalog__record x ON x.id=i.component_id JOIN erp_catalog__product p ON p.record_id=i.component_id WHERE ? OR d.deleted_at IS NULL`,
      deleted ? 1 : 0,
    )
    .rows.sort(
      (x, y) => nameOrder({ name: x.kit_name, id: x.product_id }, { name: y.kit_name, id: y.product_id }) || (x.position as number) - (y.position as number),
    );
  return {
    scope: "stock_composition_export",
    data_mode: "erp_native",
    offset,
    limit,
    include_deleted: deleted,
    total: rows.length,
    items: rows
      .slice(offset, offset + limit)
      .map((r) => ({
        product_id: r.product_id,
        product_code: r.kit_code,
        product_name: r.kit_name,
        product_deleted: r.deleted_at !== null,
        stock_type: r.stock_type,
        post_mode: r.post_mode,
        position: r.position,
        component_id: r.component_id,
        component_code: r.component_code,
        component_name: r.component_name,
        component_unit: r.component_unit,
        quantity: qty(r.q),
      })),
  };
});

registerRpc("erp_stock_composition_launches", (ctx, a) => {
  const db = ctx.db,
    id = a.p_product_id as string,
    limit = a.p_limit as number;
  requireAccess(db, a.p_user_id as string, false);
  if (id === null || limit === null || limit < 1 || limit > 20) raise("22023", "erp_stock_invalid_query");
  if (!one(db, "SELECT 1 FROM erp_catalog__product WHERE record_id=?", id)) raise("P0002", "erp_stock_product_not_found");
  const rows = db.exec(
    "SELECT c.movement_id,m.kind,m.occurred_on,m.created_at,m.reason,(SELECT r.id FROM erp_stock__movement r WHERE r.reverses_id=m.id) reversed_by FROM erp_stock__ledger_command c JOIN erp_stock__movement m ON m.id=c.movement_id WHERE c.action='launch' AND json_extract(c.result,'$.scope')='stock_composition_launch' AND json_extract(c.result,'$.composition.product_id')=? ORDER BY m.created_at DESC,c.movement_id DESC",
    id,
  ).rows;
  return {
    scope: "stock_composition_launches",
    data_mode: "erp_native",
    product_id: id,
    limit,
    total: rows.length,
    items: rows
      .slice(0, limit)
      .map((r) => ({
        movement_id: r.movement_id,
        kind: r.kind,
        occurred_on: r.occurred_on,
        created_at: jsonTimestamp(r.created_at as number),
        note: r.reason,
        reversed_by: r.reversed_by,
        lines: db
          .exec(
            "SELECT e.product_id,r.name,r.code,e.warehouse_id,CAST(e.quantity AS TEXT) q,coalesce(b.version,0) expected_version FROM erp_stock__entry e JOIN erp_catalog__record r ON r.id=e.product_id LEFT JOIN erp_stock__balance b ON b.product_id=e.product_id AND b.warehouse_id=e.warehouse_id WHERE e.movement_id=? ORDER BY e.ordinal",
            r.movement_id,
          )
          .rows.map((i) => ({
            product_id: i.product_id,
            name: i.name,
            code: i.code,
            warehouse_id: i.warehouse_id,
            quantity: qty(i.q),
            expected_version: i.expected_version,
          })),
      })),
  };
});

registerRpc("erp_stock_composition_launch", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    command = a.p_command_id as string,
    kind = a.p_kind as string,
    id = a.p_product_id as string,
    w = a.p_warehouse_id as string,
    q = a.p_quantity as string,
    version = a.p_expected_version as number,
    note = a.p_note as string | null,
    unitPrice = a.p_unit_price as string | null,
    unitCost = a.p_unit_cost as string | null;
  requireAccess(db, user, true);
  if (
    command === null ||
    !["receipt", "issue"].includes(kind) ||
    id === null ||
    w === null ||
    q === null ||
    !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(q) ||
    toScaled(q, 6) === 0n ||
    (version !== null && (version < 0 || version > 2147483646)) ||
    (kind === "issue" && unitCost !== null) ||
    (note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note)))
  )
    raise("22023", "erp_stock_launch_invalid");
  const priceValue = price105(unitPrice),
    costValue = price105(unitCost),
    finalNote = pgBtrim(note ?? "") || "Lançamento manual",
    reason = pgLength(finalNote) >= 3 ? finalNote : "Lançamento manual";
  const hash = sha256(
    jsonbText({
      profile: "stock-composition-launch-222",
      actor: user,
      kind,
      product_id: id,
      warehouse_id: w,
      quantity: q,
      expected_version: version,
      unit_price: unitPrice,
      unit_cost: unitCost,
      note,
    }),
  );
  const c = one(db, "SELECT * FROM erp_stock__ledger_command WHERE id=?", command);
  if (c) {
    if (c.actor !== user || c.action !== "launch" || c.request_hash !== hash) raise("40001", "erp_stock_launch_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_launch_conflict");
  const k = one(db, "SELECT * FROM erp_stock__composition WHERE product_id=?", id);
  if (
    !one(
      db,
      "SELECT 1 FROM erp_catalog__product p JOIN erp_catalog__record r ON r.id=p.record_id WHERE p.record_id=? AND p.kind='P' AND p.format='E' AND r.active=1 AND p.unit IS NOT NULL",
      id,
    )
  )
    raise("22023", "erp_stock_product_unavailable");
  const day = todaySaoPaulo(),
    lines = compositionLines(db, id, toScaled(q, 6)),
    own = lines.some((l) => l.role === "composition");
  const items = lines.map((l) => ({
    product_id: l.product_id,
    warehouse_id: w,
    quantity: (kind === "issue" ? "-" : "") + t6(l.quantity!),
    expected_version:
      l.role === "composition"
        ? version
        : (one(db, "SELECT version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", l.product_id, w)?.version ?? 0),
  }));
  if (!own && (priceValue !== null || costValue !== null)) raise("22023", "erp_stock_launch_invalid");
  const r = one(db, "SELECT code,name FROM erp_catalog__record WHERE id=?", id)!;
  const posted = post(ctx, { user, command, kind, occurredOn: day, reason, reference: pgLeft("Composição " + (r.code || r.name), 100), items }) as {
    movement: { id: string };
    replayed: boolean;
  };
  if (posted.replayed !== false) raise("40001", "erp_stock_launch_conflict");
  const result = {
    scope: "stock_composition_launch",
    data_mode: "erp_native",
    kind,
    occurred_on: day,
    movement: posted.movement,
    composition: { product_id: id, stock_type: k?.stock_type ?? null, post_mode: k?.post_mode ?? null, version: k?.version ?? null },
    lines: lines.map((l) => ({
      product_id: l.product_id,
      role: l.role,
      per_kit: t6(rescale(l.per_kit, 30, 6)),
      quantity: (kind === "issue" ? "-" : "") + t6(l.quantity!),
    })),
    detail: own ? { revision: 1, unit_price: priceText(priceValue), unit_cost: priceText(costValue), note: finalNote } : null,
  };
  db.exec(
    "INSERT INTO erp_stock__ledger_command(id,actor,action,movement_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)",
    command,
    user,
    "launch",
    posted.movement.id,
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  if (own)
    db.exec(
      "INSERT INTO erp_stock__movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) VALUES(?,?,1,?,?,?,?,?,?)",
      posted.movement.id,
      id,
      unitPrice,
      unitCost,
      finalNote,
      user,
      command,
      ctx.clock.next().toString(),
    );
  reservationWriteAccess(db, user);
  return { ...result, replayed: false };
});

/** Único escritor da estrutura: versão +1, itens imutáveis por versão e recibo próprio. */
export function erpStockProductCompose(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db,
    user = a.p_user_id as string,
    id = a.p_id as string | null,
    version = a.p_expected_version as number,
    command = a.p_command_id as string,
    data = jsonbArg(a.p_data),
    acknowledged = jsonbArg(a.p_acknowledged),
    composition = jsonbArg(a.p_composition) as Record<string, unknown> | null;
  catalog.requireAccess(db, user, "products", true);
  const validItems = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every(
      (j) =>
        jsonType(j) === "object" &&
        Object.keys(j).every((k) => ["component_id", "quantity"].includes(k)) &&
        typeof j.component_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(j.component_id) &&
        typeof j.quantity === "string" &&
        /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(j.quantity) &&
        toScaled(j.quantity, 6) > 0n,
    ) &&
    new Set(v.map((j) => j.component_id)).size === v.length;
  if (
    command === null ||
    jsonType(data) !== "object" ||
    version === null ||
    (composition !== null &&
      (jsonType(composition) !== "object" ||
        Object.keys(composition).some((k) => !["expected_version", "stock_type", "post_mode", "items"].includes(k)) ||
        typeof composition.expected_version !== "number" ||
        !/^[0-9]{1,10}$/.test(String(composition.expected_version)) ||
        composition.expected_version > 2147483646 ||
        !["physical", "virtual"].includes(String(composition.stock_type)) ||
        !["product", "components", "both"].includes(String(composition.post_mode)) ||
        (composition.stock_type === "virtual" && composition.post_mode !== "components") ||
        !validItems(composition.items)))
  )
    raise("22023", "erp_stock_composition_invalid");
  const hash = sha256(jsonbText({ profile: "stock-composition-222", actor: user, id, version, data, acknowledged, composition }));
  const prior = one(db, "SELECT * FROM erp_stock__composition_command WHERE id=?", command);
  if (prior) {
    if (prior.actor !== user || prior.request_hash !== hash) raise("40001", "erp_stock_composition_conflict");
    return { ...JSON.parse(String(prior.result)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, "SELECT 1 FROM erp_catalog__command WHERE command_id=?", command)) raise("40001", "erp_stock_composition_conflict");
  const settings = compositionSettings(db),
    applied: Record<string, unknown> = {},
    synced: unknown[] = [];
  let input = { ...(data as Record<string, unknown>) };
  const items = composition
    ? (composition.items as { component_id: string; quantity: string }[]).map((j) => ({ ...j, quantity: t6(toScaled(j.quantity, 6)) }))
    : [];
  if (composition) {
    if (items.some((j) => j.component_id === id)) raise("22023", "erp_stock_composition_invalid");
    if (items.some((j) => componentProblem(db, j.component_id) !== null)) raise("22023", "erp_stock_composition_component_unavailable");
    const totals = compositionTotals(db, id!, items);
    if (items.length) {
      if (settings.update_price) applied.price = totals.sale;
      if (settings.update_weight && totals.weighted > 0) {
        applied.net_weight = totals.net_weight;
        applied.gross_weight = totals.gross_weight;
      }
      input = { ...input, ...applied };
    }
  }
  const saved = catalog.erpCatalogProductSave(ctx, {
    p_user_id: user,
    p_id: id,
    p_expected_version: version,
    p_command_id: supplyPart(command, "product"),
    p_data: input,
    p_acknowledged: acknowledged,
  }) as { record: { id: string }; replayed: boolean };
  if (saved.replayed !== false) raise("40001", "erp_stock_composition_conflict");
  const product = saved.record.id;
  if (composition) {
    if (!one(db, "SELECT 1 FROM erp_catalog__product WHERE record_id=? AND format='E' AND kind='P'", product))
      raise("22023", "erp_stock_composition_format_required");
    const cur = one(db, "SELECT * FROM erp_stock__composition WHERE product_id=?", product);
    if ((cur?.version ?? 0) !== composition.expected_version) raise("40001", "erp_stock_composition_version_conflict");
    if (composition.stock_type === "virtual" && one(db, "SELECT 1 FROM erp_stock__balance WHERE product_id=? AND quantity<>0", product))
      raise("22023", "erp_stock_composition_has_stock");
    deferForeignKeys(ctx, "erp_stock__composition");
    const next = ((cur?.version as number) ?? 0) + 1;
    if (cur)
      db.exec(
        "UPDATE erp_stock__composition SET stock_type=?,post_mode=?,version=?,updated_at=?,updated_by=?,command_id=? WHERE product_id=?",
        composition.stock_type,
        composition.post_mode,
        next,
        ctx.clock.next().toString(),
        user,
        command,
        product,
      );
    else
      db.exec(
        "INSERT INTO erp_stock__composition(product_id,stock_type,post_mode,version,updated_by,command_id,updated_at) VALUES(?,?,?,1,?,?,?)",
        product,
        composition.stock_type,
        composition.post_mode,
        user,
        command,
        ctx.clock.next().toString(),
      );
    for (const [i, j] of items.entries())
      db.exec(
        "INSERT INTO erp_stock__composition_item(product_id,version,position,component_id,quantity) VALUES(?,?,?,?,?)",
        product,
        next,
        i + 1,
        j.component_id,
        toScaled(j.quantity, 6).toString(),
      );
    if (items.length) Object.assign(applied, compositionApplyValues(ctx, user, command, product, true));
  } else
    for (const k of db.exec(
      `SELECT DISTINCT i.product_id FROM ${COMPOSITION_CURRENT} i JOIN erp_catalog__product k ON k.record_id=i.product_id WHERE i.component_id=? AND k.format='E' ORDER BY i.product_id`,
      product,
    ).rows)
      synced.push({ product_id: k.product_id, applied: compositionApplyValues(ctx, user, command, String(k.product_id)) });
  const result = {
    entity: "products",
    record: catalog.productFull(db, product),
    data_mode: "erp_native",
    command_id: command,
    composition: compositionDto(db, product),
    applied,
    synced,
    settings,
  };
  db.exec(
    "INSERT INTO erp_stock__composition_command(id,actor,action,product_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)",
    command,
    user,
    composition ? "save" : "sync",
    product,
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
}
registerRpc("erp_stock_product_compose", erpStockProductCompose);
