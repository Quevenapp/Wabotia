// Compras: recebimento por depósito, estorno em lote, sugestão e relatório.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { invokeRpc, registerRpc } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { activeRole, requirePermission } from "../../access/public.ts";
import { fold as catalogFold } from "../../catalog/public.ts";
import * as documents from "../../documents/public.ts";
import * as preferences from "../../preferences/public.ts";
import { countPhysical, ignoredWarehouse } from "../home.ts";
import { commandTaken, requireAccess, sha256, supplyPart } from "../internal.ts";
import { situationReservations } from "../read.ts";
import { dashboardStatuses } from "./dashboards.ts";
import { access, applyWarehouse, lockDocument, preview, received } from "./purchase-receipts.ts";
import { reportPeriod } from "./reports.ts";
const fold = (s: string) => catalogFold(s)!;
const q6 = (v: bigint) => formatScaled(v, 6),
  money = (v: bigint) => formatScaled(v, 2);
const PURCHASE = ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"];
const SALES = ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"];

registerRpc("erp_stock_purchase_receive_preview", (ctx, a) => {
  const user = a.p_user_id as string,
    w = a.p_warehouse_id as string;
  documents.mirrorRequireVisible(ctx.db, user, a.p_document_id as string, true);
  const d = lockDocument(ctx.db, user, a.p_document_id as string, a.p_expected_version as number);
  if (w === null || (d.warehouse_id !== null && d.warehouse_id !== w)) raise("22023", "purchase_receipt_warehouse_conflict");
  return {
    scope: "purchase_receipts",
    data_mode: "erp_native",
    preview: preview(ctx, user, { ...d, warehouse_id: w }, "receive", a.p_occurred_on as string, a.p_reason as string, jsonbArg(a.p_items), null),
  };
});
registerRpc("erp_stock_purchase_receive", (ctx, a) => {
  if (a.p_warehouse_id === null) raise("22023", "purchase_receipt_warehouse_conflict");
  return applyWarehouse(
    ctx,
    a.p_user_id as string,
    a.p_document_id as string,
    a.p_expected_version as number,
    "receive",
    a.p_occurred_on as string,
    a.p_reason as string,
    jsonbArg(a.p_items),
    null,
    a.p_command_id as string,
    a.p_preview_hash as string,
    a.p_confirm as boolean,
    a.p_warehouse_id as string,
  );
});
registerRpc("erp_stock_purchase_reverse_all", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    command = a.p_command_id as string,
    id = a.p_document_id as string,
    version = a.p_expected_version as number;
  documents.mirrorRequireVisible(db, user, id, true);
  access(db, user);
  if (command === null || id === null || version === null || version < 1 || version > 2147483646) raise("22023", "erp_stock_purchase_reverse_invalid");
  const hash = sha256(jsonbText({ profile: "stock-purchase-reverse-all-225", actor: user, document: id, version }));
  const c = one(db, "SELECT * FROM erp_stock__supply_command WHERE id=?", command);
  if (c) {
    if (c.actor !== user || c.action !== "purchase_reverse_all" || c.request_hash !== hash) raise("40001", "erp_stock_purchase_reverse_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_purchase_reverse_conflict");
  const d = lockDocument(db, user, id, version),
    rows = db.exec(
      "SELECT x.id FROM erp_purchase_receipts__receipt x WHERE x.document_id=? AND NOT EXISTS(SELECT 1 FROM erp_purchase_receipts__reversal y WHERE y.receipt_id=x.id) ORDER BY x.created_at DESC,x.id DESC",
      id,
    ).rows;
  if (!rows.length) raise("22023", "erp_stock_purchase_nothing_to_reverse");
  const day = todaySaoPaulo(),
    reason = "Estorno do pedido de compra " + d.number,
    lines = [];
  let currentVersion = version;
  for (const r of rows) {
    const p = invokeRpc(ctx, "erp_purchase_receipts_reverse_preview", {
      p_user_id: user,
      p_document_id: id,
      p_expected_version: currentVersion,
      p_receipt_id: r.id,
      p_occurred_on: day,
      p_reason: reason,
    }) as { preview: { preview_hash: string; positions: unknown[] } };
    const applied = applyWarehouse(
      ctx,
      user,
      id,
      currentVersion,
      "reverse",
      day,
      reason,
      null,
      String(r.id),
      supplyPart(command, "reverse:" + r.id),
      p.preview.preview_hash,
      true,
      null,
    );
    currentVersion = applied.receipt.document_version;
    lines.push({ receipt_id: r.id, movement_id: applied.receipt.reversal.movement_id, positions: p.preview.positions.length });
  }
  const result = {
    scope: "stock_purchase_reverse_all",
    data_mode: "erp_native",
    command_id: command,
    document_id: id,
    document_number: String(d.number),
    document_version: currentVersion,
    occurred_on: day,
    reason,
    reversed: lines,
  };
  db.exec(
    "INSERT INTO erp_stock__supply_command(id,actor,action,request_hash,result,created_at) VALUES(?,?,?,?,?,?)",
    command,
    user,
    "purchase_reverse_all",
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
});

registerRpc("erp_stock_report_purchase_orders", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    from = a.p_date_from as string,
    to = a.p_date_to as string,
    group = a.p_group as string;
  if (!documents.allowed(activeRole(db, user), "purchase_orders", false)) raise("42501", "erp_stock_access_denied");
  reportPeriod(from, to);
  const statuses = dashboardStatuses(jsonbArg(a.p_statuses), PURCHASE, 5);
  if (statuses === null || !["supplier", "product"].includes(group)) raise("22023", "erp_stock_invalid_query");
  const docs = db
    .exec(
      "SELECT d.id,d.contact_id,d.contact_snapshot,d.body,CAST(d.total AS TEXT) total,r.name current_name FROM erp_documents__document d LEFT JOIN erp_catalog__record r ON r.id=d.contact_id WHERE d.authority='brufap' AND d.kind='purchase_orders'",
    )
    .rows.filter((d) => {
      const day = JSON.parse(String(d.body)).date;
      return (
        statuses.includes(String(one(db, "SELECT status FROM erp_documents__document WHERE id=?", d.id)!.status)) &&
        typeof day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        day >= from &&
        day <= to
      );
    });
  const groups = new Map<string, { key: string; label: string; code: string | null; orders: Set<string>; quantity: bigint; value: bigint }>();
  let totalQuantity = 0n,
    totalValue = 0n;
  for (const d of docs) {
    const items = db.exec(
      "SELECT i.document_id,i.product_id,i.data,CAST(i.quantity AS TEXT) q,CAST(i.total AS TEXT) total,r.name,r.code FROM erp_documents__item i LEFT JOIN erp_catalog__record r ON r.id=i.product_id WHERE i.document_id=?",
      d.id,
    ).rows;
    const quantity = items.reduce((s, i) => s + (i.q === null ? 0n : fromColumn(i.q)), 0n);
    totalQuantity += quantity;
    totalValue += fromColumn(d.total);
    const entries =
      group === "supplier"
        ? [
            {
              key: String(d.contact_id ?? "sem-fornecedor"),
              label: String(d.current_name ?? JSON.parse(String(d.contact_snapshot))?.name ?? "Sem fornecedor"),
              code: null,
              quantity,
              value: fromColumn(d.total),
            },
          ]
        : items.map((i) => {
            const name = String(i.name ?? (pgBtrim(JSON.parse(String(i.data))?.description ?? "") || "Item sem descrição"));
            return {
              key: String(i.product_id ?? "item:" + name),
              label: name,
              code: i.code === null ? null : String(i.code),
              quantity: i.q === null ? 0n : fromColumn(i.q),
              value: fromColumn(i.total),
            };
          });
    for (const e of entries) {
      let r = groups.get(e.key);
      if (!r) {
        r = { ...e, orders: new Set(), quantity: 0n, value: 0n };
        groups.set(e.key, r);
      }
      r.orders.add(String(d.id));
      r.quantity += e.quantity;
      r.value += e.value;
      if (pgCompareText(e.label, r.label) < 0) r.label = e.label;
      if (e.code !== null && (r.code === null || pgCompareText(e.code, r.code) < 0)) r.code = e.code;
    }
  }
  const rows = [...groups.values()].sort((x, y) =>
    x.value === y.value ? pgCompareText(fold(x.label), fold(y.label)) || pgCompareText(x.key, y.key) : x.value > y.value ? -1 : 1,
  );
  return {
    scope: "stock_report_purchase_orders",
    data_mode: "erp_native",
    filters: { date_from: from, date_to: to, statuses, group },
    total: rows.length,
    items: rows
      .slice(0, 2000)
      .map((r) => ({ key: r.key, label: r.label, code: r.code, orders: r.orders.size, quantity: q6(r.quantity), value: money(r.value) })),
    totals: { orders: docs.length, quantity: q6(totalQuantity), value: money(totalValue) },
    ...documents.mirrorReportCoverage(db, user, "purchase_orders", from, to),
  };
});

registerRpc("erp_stock_purchase_suggestion", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    from = a.p_date_from as string,
    to = a.p_date_to as string,
    coverage = a.p_coverage as number,
    w = a.p_warehouse_id as string | null,
    reserve = a.p_reserve as boolean,
    brand = a.p_brand as string | null,
    supplier = a.p_supplier_id as string | null;
  requireAccess(db, user, false);
  requirePermission(db, user, "meu_negocio.dashboard");
  requirePermission(db, user, "meu_negocio.dashboard.sugestao_compras");
  if (!documents.allowed(activeRole(db, user), "purchase_orders", false)) raise("42501", "erp_stock_access_denied");
  const purchase = dashboardStatuses(jsonbArg(a.p_purchase_statuses), PURCHASE, 5),
    sales = dashboardStatuses(jsonbArg(a.p_sales_statuses), SALES, 7);
  reportPeriod(from, to);
  if (
    coverage === null ||
    coverage < 1 ||
    coverage > 3650 ||
    reserve === null ||
    purchase === null ||
    sales === null ||
    (brand !== null && (pgLength(brand) > 100 || pgHasCntrl.test(brand)))
  )
    raise("22023", "erp_stock_invalid_query");
  if (w !== null && !one(db, "SELECT 1 FROM erp_catalog__warehouse WHERE record_id=?", w)) raise("P0002", "erp_stock_warehouse_not_found");
  if (supplier !== null && !one(db, "SELECT 1 FROM erp_catalog__contact WHERE record_id=?", supplier)) raise("P0002", "erp_stock_supplier_not_found");
  const mode =
    preferences.get(db, "compras.preco_padrao") === true
      ? preferences.get(db, "compras.preco_padrao_tipo") === "compra"
        ? "compra"
        : "custo"
      : "ultima_compra";
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1,
    period = BigInt(days),
    sold = new Map<string, bigint>();
  const docs = db.exec(
    "SELECT id,kind,status,body,warehouse_id,created_at FROM erp_documents__document WHERE authority='brufap' AND kind IN ('sales_orders','purchase_orders')",
  ).rows;
  for (const d of docs) {
    const day = JSON.parse(String(d.body)).date;
    if (
      d.kind !== "sales_orders" ||
      !sales.includes(String(d.status)) ||
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      day < from ||
      day > to ||
      (w !== null && d.warehouse_id !== w)
    )
      continue;
    for (const i of db.exec(
      "SELECT i.product_id,CAST(i.quantity AS TEXT) q,p.brand FROM erp_documents__item i JOIN erp_catalog__product p ON p.record_id=i.product_id WHERE i.document_id=? AND p.kind='P'",
      d.id,
    ).rows) {
      if (brand !== null && pgBtrim(brand) !== "" && !fold(String(i.brand ?? "")).includes(fold(pgBtrim(brand)))) continue;
      if (supplier !== null && !one(db, "SELECT 1 FROM erp_catalog__product_supplier WHERE record_id=? AND supplier_id=?", i.product_id, supplier)) continue;
      sold.set(String(i.product_id), (sold.get(String(i.product_id)) ?? 0n) + (i.q === null ? 0n : fromColumn(i.q)));
    }
  }
  const rows = [...sold]
    .map(([id, soldQty]) => {
      const p = one(db, "SELECT r.name,r.code,p.unit FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?", id)!;
      let ordered = 0n;
      const last: { date: string | null; created: number; position: number; price: unknown }[] = [];
      for (const d of docs) {
        if (d.kind !== "purchase_orders") continue;
        for (const i of db.exec(
          "SELECT id,position,CAST(quantity AS TEXT) q,unit_price FROM erp_documents__item WHERE document_id=? AND product_id=?",
          d.id,
          id,
        ).rows) {
          if (d.status !== "cancelled")
            last.push({ date: JSON.parse(String(d.body)).date ?? null, created: d.created_at as number, position: i.position as number, price: i.unit_price });
          if (
            purchase.includes(String(d.status)) &&
            (w === null || d.warehouse_id === w) &&
            !one(db, "SELECT 1 FROM erp_stock__document_posting WHERE document_id=? AND state='active'", d.id)
          ) {
            const remaining = (i.q === null ? 0n : fromColumn(i.q)) - received(db, String(d.id), String(i.id));
            if (remaining > 0n) ordered += remaining;
          }
        }
      }
      last.sort((x, y) =>
        x.date === null
          ? y.date === null
            ? y.created - x.created || x.position - y.position
            : 1
          : y.date === null
            ? -1
            : pgCompareText(y.date, x.date) || y.created - x.created || x.position - y.position,
      );
      const sup = one(
        db,
        `SELECT s.supplier_id,r.name,s.purchase_price,s.cost_price FROM erp_catalog__product_supplier s JOIN erp_catalog__record r ON r.id=s.supplier_id WHERE s.record_id=? AND ${supplier === null ? "s.is_default=1" : "s.supplier_id=?"}`,
        id,
        ...(supplier === null ? [] : [supplier]),
      );
      const supplierPrice = mode === "custo" ? sup?.cost_price : mode === "compra" ? sup?.purchase_price : null,
        lastPrice = last[0]?.price ?? null,
        unitPrice = supplierPrice ?? lastPrice;
      let reserved = 0n;
      if (reserve) {
        for (const i of db.exec(
          "SELECT i.warehouse_id,CAST(i.quantity AS TEXT) q FROM erp_stock__reservation_item i JOIN erp_stock__reservation x ON x.id=i.reservation_id WHERE x.state='active' AND i.product_id=?",
          id,
        ).rows)
          if (w === null ? !ignoredWarehouse(db, String(i.warehouse_id)) : i.warehouse_id === w) reserved += rescale(fromColumn(i.q), 6, 30);
        for (const s of situationReservations(db, id))
          if (s.warehouse_id === null || s.warehouse_id === w || (w === null && !ignoredWarehouse(db, s.warehouse_id))) reserved += s.quantity;
      }
      const stock = countPhysical(db, id, w),
        raw = (rescale(soldQty, 6, 30) * BigInt(coverage) - (rescale(stock + ordered, 6, 30) - reserved) * period) / (period * 10n ** 30n),
        suggestion = raw > 0n ? raw : 0n,
        priceValue = unitPrice === null ? null : toScaled(String(unitPrice), 10);
      return {
        sort: suggestion,
        product_id: id,
        code: p.code,
        name: p.name,
        unit: p.unit,
        sold: q6(soldQty),
        stock: q6(stock),
        reserved: q6(rescale(reserved, 30, 6)),
        ordered: q6(ordered),
        suggestion: formatScaled(suggestion, 0),
        unit_price: priceValue === null ? null : formatScaled(priceValue, 10),
        value: priceValue === null ? null : money(rescale(suggestion * priceValue, 10, 2)),
        price_source:
          supplierPrice !== null && supplierPrice !== undefined
            ? mode === "custo"
              ? "supplier_cost"
              : "supplier_purchase"
            : lastPrice !== null
              ? "last_purchase"
              : null,
        supplier_id: sup?.supplier_id ?? null,
        supplier_name: sup?.name ?? null,
      };
    })
    .sort((x, y) =>
      x.sort === y.sort ? pgCompareText(fold(String(x.name)), fold(String(y.name))) || pgCompareText(x.product_id, y.product_id) : x.sort > y.sort ? -1 : 1,
    );
  return {
    scope: "stock_purchase_suggestion",
    data_mode: "erp_native",
    days,
    price_mode: mode,
    filters: {
      date_from: from,
      date_to: to,
      coverage,
      warehouse_id: w,
      reserve,
      purchase_statuses: purchase,
      sales_statuses: sales,
      brand,
      supplier_id: supplier,
    },
    total: rows.length,
    items: rows.slice(0, 2000).map(({ sort: _, ...r }) => r),
    ...documents.mirrorReportCoverage(db, user, null, from, to),
  };
});
