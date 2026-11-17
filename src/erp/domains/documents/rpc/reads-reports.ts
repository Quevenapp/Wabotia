// Relatórios do Documentos (sessão L, bloco B0): curva ABC de vendas,
// romaneio de entrega, relatório de ordens de serviço e de ocorrências da
// OS. Portado de public.erp_document_sales_abc, _sales_romaneio,
// _service_report e _service_occurrence_report com os mesmos nomes.
// erp_document_mirror.report_coverage é lido como no oráculo: quantos
// documentos espelhados o relatório deixou de fora (../mirror-reads.ts).
// A ordem segue o Postgres: DESC põe NULL primeiro, ASC por último.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { decText, formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { contactScope, contactVisibleTo } from "../../catalog/public.ts";
import { dateValue, uuidValue } from "../internal.ts";
import { reportCoverage } from "../mirror-reads.ts";
import { requireAccess, transitions } from "../public.ts";
import { jsonPathText } from "./reads-common.ts";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;
const days = (a: string, b: string) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000;
/** ASC com NULL por último (padrão do Postgres). */
const ascText = (x: string | null, y: string | null) => pgCompareText(x, y);
/** DESC com NULL primeiro (padrão do Postgres). */
const descText = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? -1 : y === null ? 1 : -pgCompareText(x, y));
const descNum = (x: bigint | number | null, y: bigint | number | null) => (x === y ? 0 : x === null ? -1 : y === null ? 1 : x > y ? -1 : x < y ? 1 : 0);
const cmpUuid = (x: unknown, y: unknown) => pgCompareText(str(x), str(y));
const statusKeys = (kind: string) => Object.keys((transitions() as Record<string, object>)[kind] ?? {});

/** Período obrigatório de até 366 dias (date_value dos dois lados). */
function period(from: unknown, to: unknown) {
  const f = dateValue(from, true)!,
    t = dateValue(to, true)!;
  return { from: f, to: t, bad: f > t || days(f, t) > 366 };
}

/** round(n/d, s) do numeric: metade para longe do zero, n e d inteiros. */
function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n,
    ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return neg ? -q : q;
}

/** public.erp_document_sales_abc(p_user_id, p_from, p_to): curva ABC dos produtos vendidos no período. */
export function erpDocumentSalesAbc(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const scope = contactScope(db, user);
  requireAccess(db, user, "sales_orders", false);
  const p = period(a.p_from ?? null, a.p_to ?? null);
  if (p.bad) raise("22023", "erp_document_report_invalid");
  type G = { key: string | null; product_id: unknown; description: string | null; code: string | null; quantity: bigint | null; amount: bigint | null };
  const groups = new Map<string | null, G>();
  for (const r of db.exec(
    `SELECT d.contact_id, d.body, i.product_id, i.data, CAST(i.quantity AS TEXT) quantity, CAST(i.total AS TEXT) total
       FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id
      WHERE d.authority='brufap' AND d.kind='sales_orders' AND d.status<>'cancelled'`,
  ).rows) {
    const day = arrow(JSON.parse(String(r.body)), "date");
    if (day === null || day < p.from || day > p.to) continue;
    if (!contactVisibleTo(db, scope, str(r.contact_id))) continue;
    const data = JSON.parse(String(r.data));
    const description = arrow(data, "description");
    const key = r.product_id !== null ? String(r.product_id) : description === null ? null : "livre:" + pgLower(description);
    const g = groups.get(key) ?? { key, product_id: r.product_id, description: null, code: null, quantity: null, amount: null };
    const code = arrow(data, "code");
    if (description !== null && (g.description === null || pgCompareText(description, g.description) < 0)) g.description = description;
    if (code !== null && (g.code === null || pgCompareText(code, g.code) < 0)) g.code = code;
    if (r.quantity !== null) g.quantity = (g.quantity ?? 0n) + fromColumn(r.quantity);
    if (r.total !== null) g.amount = (g.amount ?? 0n) + fromColumn(r.total);
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort(
    (x, y) =>
      descNum(x.amount, y.amount) ||
      ascText(x.description === null ? null : pgLower(x.description), y.description === null ? null : pgLower(y.description)) ||
      ascText(x.key, y.key),
  );
  const amounts = ranked.filter((g) => g.amount !== null).map((g) => g.amount!);
  const total = amounts.length ? amounts.reduce((s, x) => s + x, 0n) : null;
  let acc: bigint | null = null;
  const items = ranked.map((g, i) => {
    if (g.amount !== null) acc = (acc ?? 0n) + g.amount;
    const pct = (v: bigint | null) =>
      // case when total>0 then round(v*100/total,2) else 0 end: total nulo ou zero dá 0.
      total !== null && total > 0n ? (v === null ? null : formatScaled(roundDiv(v * 100n * 100n, total), 2)) : "0.00";
    const before = acc === null || g.amount === null ? null : acc - g.amount;
    const cls =
      total !== null && (total === 0n || (before !== null && before * 100n < 80n * total))
        ? "A"
        : total !== null && before !== null && before * 100n < 95n * total
          ? "B"
          : "C";
    return {
      position: i + 1,
      product_id: g.product_id,
      description: g.description,
      code: g.code,
      quantity: g.quantity === null ? null : formatScaled(g.quantity, 6),
      amount: g.amount === null ? null : formatScaled(g.amount, 2),
      percent: pct(g.amount),
      accumulated: pct(acc),
      class: cls,
    };
  });
  return {
    report: "abc",
    from: p.from,
    to: p.to,
    items: items.slice(0, 5000),
    item_count: items.length,
    truncated: items.length > 5000,
    total: formatScaled(total ?? 0n, 2),
    ...NATIVE,
    ...reportCoverage(db, user, "sales_orders", p.from, p.to),
  };
}

/** Soma de numeric em texto (sum(x::numeric)): escala da maior entrada; null sem valores. */
function numericSum(values: string[]): string | null {
  if (!values.length) return null;
  const norm = values.map((v) => decText(v, 0, false));
  const scale = Math.max(...norm.map((v) => (v.split(".")[1] ?? "").length));
  return formatScaled(
    norm.reduce((s, v) => s + toScaled(v, scale), 0n),
    scale,
  );
}

/** erp_documents.romaneio_address(p_body, p_contact): o endereço de entrega do pedido, ou o do contato. */
function romaneioAddress(body: unknown, contact: unknown) {
  const field = (v: string | null, n: number) => {
    if (v === null) return null;
    const t = pgBtrim(v);
    return t === "" ? null : pgLeft(t, n);
  };
  const d = (k: string) => jsonPathText(body, ["delivery_address", k]);
  if (pgBtrim(d("street") ?? "") !== "" || pgBtrim(d("city") ?? "") !== "")
    return {
      source: "delivery",
      name: field(d("name"), 200),
      street: field(d("street"), 200),
      number: field(d("number"), 60),
      complement: field(d("complement"), 200),
      district: field(d("district"), 120),
      city: field(d("city"), 120),
      state: field(d("state"), 2),
      postal_code: field(d("postal_code"), 9),
    };
  const c = (k: string) => arrow(contact, k);
  return {
    source: "contact",
    name: null,
    street: field(c("street"), 200),
    number: field(c("number"), 60),
    complement: field(c("complement"), 200),
    district: field(c("district"), 120),
    city: field(c("city"), 120),
    state: field(c("state"), 2),
    postal_code: field(c("postal_code"), 9),
  };
}

const UUID_I = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** public.erp_document_sales_romaneio(p_user_id, p_filters): pedidos de venda para a entrega, com itens, volumes e peso. */
export function erpDocumentSalesRomaneio(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const filters = a.p_filters as Obj | null | undefined;
  const scope = contactScope(db, user);
  requireAccess(db, user, "sales_orders", false);
  const ALLOWED = ["from", "to", "date_type", "statuses", "carrier_id", "contact_id"];
  if (
    filters === null ||
    filters === undefined ||
    jsonType(filters) !== "object" ||
    Object.keys(filters).some((k) => !ALLOWED.includes(k)) ||
    ("date_type" in filters && jsonType(filters.date_type) !== "string")
  )
    raise("22023", "erp_document_report_invalid");
  const from = dateValue(filters.from ?? null, true)!,
    to = dateValue(filters.to ?? null, true)!;
  const dateType = arrow(filters, "date_type") ?? "date";
  const carrier = uuidValue(filters.carrier_id ?? null),
    contact = uuidValue(filters.contact_id ?? null);
  let statuses: Set<string> | null = null;
  if ("statuses" in filters && filters.statuses !== null) {
    const s = filters.statuses;
    const keys = statusKeys("sales_orders");
    if (!Array.isArray(s) || s.length < 1 || s.length > 20 || s.some((x) => typeof x !== "string" || !keys.includes(x)))
      raise("22023", "erp_document_report_invalid");
    statuses = new Set(s as string[]);
  }
  if (from > to || days(from, to) > 366 || !["date", "expected_date", "ship_date"].includes(dateType)) raise("22023", "erp_document_report_invalid");
  const orders = db
    .exec(`SELECT id, number, status, contact_id, contact_snapshot, body FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`)
    .rows.map((d): Row & { c: unknown; b: Obj } => ({ ...(d as Row), c: JSON.parse(String(d.contact_snapshot)), b: JSON.parse(String(d.body)) as Obj }))
    .filter((d) => {
      if (statuses === null ? d.status === "cancelled" : !statuses.has(String(d.status))) return false;
      if (!contactVisibleTo(db, scope, str(d.contact_id))) return false;
      const day = arrow(d.b, dateType === "expected_date" ? "expected_date" : dateType === "ship_date" ? "ship_date" : "date");
      if (day === null || day < from || day > to) return false;
      if (contact !== null && d.contact_id !== contact) return false;
      if (carrier !== null) {
        const c = arrow(d.b, "carrier_id");
        if (c === null || pgLower(c) !== carrier) return false;
      }
      return true;
    })
    .sort((x, y) => ascText(arrow(x.b, "date"), arrow(y.b, "date")) || Number(x.number) - Number(y.number) || cmpUuid(x.id, y.id));
  const transport = (b: Obj, k: string) => jsonPathText(b, ["commercial", "transport", k]);
  const num = (v: string | null) => (v === null ? null : decText(v, 0, false));
  const rows = orders.slice(0, 100).map((r) => {
    const carrierId = arrow(r.b, "carrier_id");
    const record = carrierId !== null && UUID_I.test(carrierId) ? one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', carrierId.toLowerCase()) : null;
    const label = jsonPathText(r.b, ["commercial", "transport", "carrier_reference", "label"]);
    const phone = arrow(r.c, "phone");
    return {
      id: r.id,
      number: r.number === null ? null : String(r.number),
      status: r.status,
      date: arrow(r.b, "date"),
      expected_date: arrow(r.b, "expected_date"),
      ship_date: arrow(r.b, "ship_date"),
      contact_name: pgLeft(arrow(r.c, "name") ?? "", 200),
      phone: phone === null || pgBtrim(phone) === "" ? null : pgLeft(pgBtrim(phone), 60),
      address: romaneioAddress(r.b, r.c),
      carrier: record ? pgLeft(String(record.name), 200) : label === null || pgBtrim(label) === "" ? null : pgLeft(pgBtrim(label), 200),
      freight_mode: transport(r.b, "freight_mode"),
      volumes: num(transport(r.b, "volume_count")),
      gross_weight: num(transport(r.b, "gross_weight")),
      items: db
        .exec('SELECT position, data, CAST(quantity AS TEXT) quantity FROM "erp_documents__item" WHERE document_id=?', r.id)
        .rows.sort((x, y) => Number(x.position) - Number(y.position))
        .map((i) => {
          const data = JSON.parse(String(i.data));
          const code = arrow(data, "code"),
            unit = arrow(data, "unit");
          return {
            code: code === null || pgBtrim(code) === "" ? null : pgLeft(pgBtrim(code), 100),
            description: pgLeft(arrow(data, "description") ?? "", 300),
            unit: unit === null || pgBtrim(unit) === "" ? null : pgLeft(pgBtrim(unit), 20),
            quantity: i.quantity === null ? null : formatScaled(fromColumn(i.quantity), 6),
          };
        }),
    };
  });
  const sum = (k: string) => numericSum(orders.map((r) => transport(r.b, k)).filter((v): v is string => v !== null)) ?? "0";
  return {
    report: "romaneio",
    from,
    to,
    date_type: dateType,
    rows,
    row_count: orders.length,
    truncated: orders.length > 100,
    totals: { orders: orders.length, volumes: sum("volume_count"), gross_weight: sum("gross_weight") },
    ...NATIVE,
    ...reportCoverage(db, user, "sales_orders", from, to),
  };
}

const SERVICE_COLUMNS = ["number", "name", "date", "parts", "services", "total", "status"];
const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

/** public.erp_document_service_report(p_user_id, p_conditions): ordens de serviço filtradas (até 10 condições, todas juntas). */
export function erpDocumentServiceReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const conditions = a.p_conditions;
  const scope = contactScope(db, user);
  requireAccess(db, user, "service_orders", false);
  if (conditions === null || conditions === undefined || jsonType(conditions) !== "array" || (conditions as unknown[]).length > 10)
    raise("22023", "erp_document_report_invalid");
  const keys = statusKeys("service_orders");
  for (const c of conditions as unknown[]) {
    const o = c as Obj;
    const column = jsonType(c) === "object" ? arrow(o, "column") : null;
    const value = jsonType(c) === "object" ? arrow(o, "value") : null;
    if (
      jsonType(c) !== "object" ||
      Object.keys(o).length !== 2 ||
      !("column" in o && "value" in o) ||
      jsonType(o.value) !== "string" ||
      // coluna JSON null: o "not in" fica nulo e não recusa (três valores); o filtro cai no else (situação).
      (column !== null && !SERVICE_COLUMNS.includes(column)) ||
      pgLength(value!) < 1 ||
      pgLength(value!) > 120 ||
      pgHasCntrl.test(value!) ||
      (column === "number" && !/^[1-9][0-9]{0,9}$/.test(value!)) ||
      (column === "date" && !/^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value!)) ||
      (column !== null && ["parts", "services", "total"].includes(column) && !MONEY.test(value!)) ||
      (column === "status" && !keys.includes(value!))
    )
      raise("22023", "erp_document_report_invalid");
    if (column === "date") dateValue(o.value, true);
  }
  const conds = (conditions as Obj[]).map((c) => ({ column: arrow(c, "column"), value: arrow(c, "value")! }));
  const groupTotals = (id: unknown) => {
    let services = 0n,
      parts = 0n;
    for (const i of db.exec('SELECT data, product_snapshot, CAST(total AS TEXT) total FROM "erp_documents__item" WHERE document_id=?', id).rows) {
      if (i.total === null) continue;
      const data = JSON.parse(String(i.data)) as Obj;
      const snapKind = i.product_snapshot === null ? null : arrow(JSON.parse(String(i.product_snapshot)), "kind");
      const group = "group" in data ? arrow(data, "group") : undefined;
      const isService = group !== undefined ? group === "service" : (snapKind ?? "") === "S";
      const isPart = group !== undefined ? group === "part" : (snapKind ?? "") !== "S";
      if (isService) services += fromColumn(i.total);
      if (isPart) parts += fromColumn(i.total);
    }
    return { services, parts };
  };
  const rows = db
    .exec(`SELECT id, number, contact_id, contact_snapshot, body, status, CAST(total AS TEXT) total FROM "erp_documents__document" WHERE authority='brufap' AND kind='service_orders'`)
    .rows.filter((d) => contactVisibleTo(db, scope, str(d.contact_id)))
    .map((d) => {
      const g = groupTotals(d.id);
      return {
        id: d.id,
        number: d.number === null ? null : Number(d.number),
        name: arrow(JSON.parse(String(d.contact_snapshot)), "name"),
        day: arrow(JSON.parse(String(d.body)), "date"),
        status: String(d.status),
        total: d.total === null ? null : fromColumn(d.total),
        ...g,
      };
    })
    .filter((o) =>
      conds.every(({ column, value }) => {
        switch (column) {
          case "number":
            return o.number === Number(value);
          case "name":
            return pgLower(o.name ?? "").includes(pgLower(pgBtrim(value)));
          case "date":
            return o.day === value;
          case "parts":
            return o.parts === toScaled(value, 2);
          case "services":
            return o.services === toScaled(value, 2);
          case "total":
            return o.total !== null && o.total === toScaled(value, 2);
          default:
            return o.status === value;
        }
      }),
    )
    .sort((x, y) => descText(x.day, y.day) || descNum(x.number, y.number));
  return {
    report: "service_orders",
    rows: rows.slice(0, 5000).map((f) => ({
      id: f.id,
      number: f.number === null ? null : String(f.number),
      name: f.name,
      date: f.day,
      parts: formatScaled(f.parts, 2),
      services: formatScaled(f.services, 2),
      total: f.total === null ? null : formatScaled(f.total, 2),
      status: f.status,
    })),
    row_count: rows.length,
    truncated: rows.length > 5000,
    ...NATIVE,
    ...reportCoverage(db, user, "service_orders"),
  };
}

/** public.erp_document_service_occurrence_report(p_user_id, p_from, p_to, p_status): ocorrências das OS no período. */
export function erpDocumentServiceOccurrenceReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    status = str(a.p_status);
  const scope = contactScope(db, user);
  requireAccess(db, user, "service_orders", false);
  const p = period(a.p_from ?? null, a.p_to ?? null);
  if (p.bad || (status !== null && !statusKeys("service_orders").includes(status))) raise("22023", "erp_document_report_invalid");
  const rows = db
    .exec(
      `SELECT o.document_id, o.occurred_on, o.occurred_time, o.text, o.status_before, o.status_after, o.actor_id, o.actor_role, o.sequence,
              d.number, d.contact_id, d.contact_snapshot
         FROM "erp_documents__occurrence" o JOIN "erp_documents__document" d ON d.id=o.document_id
        WHERE d.authority='brufap' AND d.kind='service_orders' AND o.occurred_on BETWEEN ? AND ?
          AND NOT EXISTS(SELECT 1 FROM "erp_documents__occurrence_removal" r WHERE r.occurrence_id=o.id)`,
      p.from,
      p.to,
    )
    .rows.filter((o) => contactVisibleTo(db, scope, str(o.contact_id)) && (status === null || (str(o.status_after) ?? str(o.status_before)) === status))
    .sort(
      (x, y) =>
        descText(str(x.occurred_on), str(y.occurred_on)) ||
        descText(str(x.occurred_time), str(y.occurred_time)) ||
        descNum(x.number === null ? null : Number(x.number), y.number === null ? null : Number(y.number)) ||
        descNum(Number(x.sequence), Number(y.sequence)),
    );
  return {
    report: "service_occurrences",
    from: p.from,
    to: p.to,
    rows: rows.slice(0, 5000).map((x) => {
      const actor = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', x.actor_id);
      return {
        document_id: x.document_id,
        number: x.number === null ? null : String(x.number),
        name: arrow(JSON.parse(String(x.contact_snapshot)), "name"),
        occurred_on: str(x.occurred_on),
        occurred_time: x.occurred_time,
        text: x.text,
        status_before: x.status_before,
        status_after: x.status_after,
        actor_name: actor ? pgLeft(String(actor.name), 120) : null,
        actor_role: x.actor_role,
      };
    }),
    row_count: rows.length,
    truncated: rows.length > 5000,
    ...NATIVE,
    ...reportCoverage(db, user, "service_orders", p.from, p.to),
  };
}

registerRpc("erp_document_sales_abc", erpDocumentSalesAbc);
registerRpc("erp_document_sales_romaneio", erpDocumentSalesRomaneio);
registerRpc("erp_document_service_report", erpDocumentServiceReport);
registerRpc("erp_document_service_occurrence_report", erpDocumentServiceOccurrenceReport);

