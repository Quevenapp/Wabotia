// Expedição (motor; structural.ts, expedicao; tabelas erp_shipping__*, versão 25):
// - separação consolidada: vários pedidos de venda numa lista, itens somados
//   por produto e endereço/depósito, marcação do separado (a câmera só acha a
//   linha; o motor grava a quantidade com a versão da lista) e a diferença de
//   quantidade como pendência, também registrada como ocorrência do pedido;
// - embalagens e volumes, com pesos e medidas calculados; com Fiscal ligado,
//   a quantidade de volumes e o peso bruto vão para o transporte do pedido
//   (que a NF-e já lê), pelo mesmo caminho de gravação do pedido;
// - etiquetas, romaneio e a entrega local (o Worker chama o módulo Entrega);
// - devolução física: o que volta ao estoque entra pelo lançamento do Estoque.
// A situação comercial do pedido não muda aqui. Parte erp-expedicao (Vendas e
// Estoque juntos), conferida no portão (engine/parts-gate.ts, grupo shipping).
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { saoPauloParts, todaySaoPaulo, validDate } from "../../engine/time.ts";
import * as documents from "../documents/public.ts";
import { checkoutLines, checkoutSettings } from "../documents/views.ts";
import { recordOccurrence } from "../documents/save-checks.ts";
import * as stock from "../stock/public.ts";
import {
  OWN_DELIVERY_FREIGHT, RETURN_CONDITIONS, RETURN_CONDITION_LABEL, SHIPPING_STATUSES, SHIPPING_STATUS_LABEL, cmToMm, consolidate, consolidatedKey,
  distribute, gramsToKg6, kgToGrams, productMeasureMm, scaled6, shortQuantity, text6, volumeBarcode, volumeWeights,
  type PickLine, type ReturnCondition, type ShippingStatus,
} from "./model.ts";

const PACKAGE = "erp_shipping__package", ORDER = "erp_shipping__order", LIST = "erp_shipping__pick_list", LINE = "erp_shipping__pick_line";
const PENDING = "erp_shipping__pending", VOLUME = "erp_shipping__volume", RETURN = "erp_shipping__return", COMMAND = "erp_shipping__command";
/** Consultar: todos os papéis que veem pedidos de venda. Mexer na expedição: administrador, vendas e estoque. */
const READ_ROLES = ["admin", "consulta", "vendas", "estoque", "financeiro", "fiscal"];
const WRITE_ROLES = ["admin", "vendas", "estoque"];
/** Pedidos de uma consulta da expedição; acima disso, filtre por data. */
export const SHIPPING_ORDER_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const now = (ctx: RpcContext) => ctx.clock.next().toString();
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(BigInt(String(v)) / 1000n)).toISOString());
const spDay = (v: unknown) => (v === null || v === undefined ? null : saoPauloParts(BigInt(String(v))).date);
const left = (v: unknown, n: number) => (v === null || v === undefined ? null : [...String(v)].slice(0, n).join(""));
const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const invalid = (code = "erp_shipping_invalid"): never => raise("22023", code);

/** Comando derivado estável (a mesma gravação repetida gera os mesmos comandos internos). */
export function subCommand(command: string, label: string): string {
  const h = sha256(`${command}:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function argsOf(raw: unknown, allowed: readonly string[]) {
  const a = parse(raw ?? {});
  if (!a || typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > 262144 || Object.keys(a).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, any>;
}
const uuidOf = (v: unknown, required = true): string | null => {
  if (v === undefined || v === null || v === "") return required ? invalid() : null;
  if (typeof v !== "string" || !UUID.test(v)) invalid();
  return (v as string).toLowerCase();
};
const dayOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !DAY.test(v) || !validDate(v)) invalid();
  return v as string;
};
const textOf = (v: unknown, max: number, min = 0): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") invalid();
  const t = (v as string).trim();
  if (!t) return null;
  if ([...t].length > max || [...t].length < min || /[\u0000-\u001f\u007f]/.test(t)) invalid();
  return t;
};
const idList = (v: unknown, max = 100): string[] => {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) invalid();
  const ids = [...new Set((v as unknown[]).map((x) => uuidOf(x)!))];
  return ids;
};

/** Papel ativo da pessoa no ERP e o acesso aos pedidos de venda (o cartão do pedido para ver). */
export function requireShipping(db: SqlDriver, user: string, write: boolean): string {
  const r = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r || !READ_ROLES.includes(String(r.role))) raise("42501", "erp_shipping_access_denied");
  documents.requireAccess(db, user, "sales_orders", false);
  if (write && !WRITE_ROLES.includes(String(r!.role))) raise("42501", "erp_shipping_role_denied");
  return String(r!.role);
}

export function replay(db: SqlDriver, command: string, user: string, hash: string) {
  const r = one(db, `SELECT actor, request_hash, result FROM "${COMMAND}" WHERE command_id=?`, command);
  if (!r) return null;
  if (r.actor !== user || r.request_hash !== hash) raise("40001", "erp_shipping_command_conflict");
  return { ...JSON.parse(String(r.result)), replayed: true };
}
export function receipt(ctx: RpcContext, command: string, user: string, hash: string, result: Record<string, unknown>) {
  ctx.db.exec(`INSERT INTO "${COMMAND}"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)`, command, user, hash, JSON.stringify(result), now(ctx));
  return { ...result, replayed: false };
}
export const hashOf = (op: string, user: string, args: unknown) => sha256(JSON.stringify({ op, user, args }));
export function commandOf(a: RpcArgs): string {
  const c = a.p_command_id;
  if (typeof c !== "string" || !UUID.test(c)) invalid("erp_shipping_command_missing");
  return (c as string).toLowerCase();
}

// ---------------------------------------------------------------------------
// Pedido

const ORDER_SELECT = `SELECT d.id, d.number, d.status, d.version, d.contact_id, d.warehouse_id, d.contact_snapshot, d.body, CAST(d.total AS TEXT) total,
  s.status ship_status, s.pick_list_id, s.version ship_version, s.tracking_code, CAST(s.shipped_at AS TEXT) shipped_at, s.delivery_id,
  CAST(s.delivery_at AS TEXT) delivery_at, CAST(s.transport_at AS TEXT) transport_at
  FROM "erp_documents__document" d LEFT JOIN "${ORDER}" s ON s.document_id=d.id`;
const ORDER_WHERE = `d.kind='sales_orders' AND d.deleted_at IS NULL AND d.authority='brufap'`;

export function orderRow(db: SqlDriver, user: string, id: unknown): Row {
  const doc = uuidOf(id)!;
  const r = one(db, `${ORDER_SELECT} WHERE d.id=? AND ${ORDER_WHERE}`, doc);
  if (!r || !documents.contactUsable(db, user, r.contact_id as string | null)) raise("P0002", "erp_shipping_order_not_found");
  return r!;
}
export const shipStatus = (r: Row): ShippingStatus => (r.ship_status ?? "to_pick") as ShippingStatus;

function recordName(db: SqlDriver, id: unknown): string | null {
  if (typeof id !== "string") return null;
  return left(one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name, 200);
}
function defaultWarehouse(db: SqlDriver): string | null {
  return (one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1')?.warehouse_id as string | undefined) ?? null;
}
const orderWarehouse = (db: SqlDriver, r: Row) => (r.warehouse_id as string | null) ?? (obj(parse(r.body)).warehouse_id as string | undefined) ?? defaultWarehouse(db);

/** Destinatário: o endereço de entrega do pedido, senão o do cadastro do cliente (fotografado no pedido). */
export function recipientOf(r: Row) {
  const body = obj(parse(r.body)), snap = obj(parse(r.contact_snapshot)), delivery = obj(body.delivery_address);
  const use = typeof delivery.street === "string" && typeof delivery.city === "string";
  const a = use ? delivery : snap;
  const pick = (k: string, n = 200) => (typeof a[k] === "string" && a[k].trim() ? left(a[k].trim(), n) : null);
  return {
    name: left(use && typeof delivery.name === "string" && delivery.name.trim() ? delivery.name.trim() : snap.name ?? snap.trade_name ?? "", 200) || "Cliente",
    document: typeof snap.document === "string" ? snap.document : null,
    phone: typeof snap.mobile === "string" && snap.mobile ? snap.mobile : typeof snap.phone === "string" ? snap.phone : null,
    street: pick("street"), number: pick("number", 30), complement: pick("complement"), district: pick("district", 100),
    city: pick("city", 100), state: pick("state", 2), postal_code: pick("postal_code", 20), delivery_address: use,
  };
}
const addressLine = (p: ReturnType<typeof recipientOf>) =>
  [[p.street, p.number].filter(Boolean).join(", "), p.complement, p.district, [p.city, p.state].filter(Boolean).join(" - "), p.postal_code ? `CEP ${p.postal_code}` : null]
    .filter(Boolean).join(" · ");

export function transportOf(r: Row) {
  const body = obj(parse(r.body));
  const transport = obj(obj(body.commercial).transport);
  const carrier = typeof body.carrier_id === "string" ? body.carrier_id : null;
  const mode = typeof transport.freight_mode === "string" ? transport.freight_mode : null;
  return {
    carrier_id: carrier, freight_mode: mode, tracking_code: typeof transport.tracking_code === "string" ? transport.tracking_code : null,
    volume_count: transport.volume_count ?? null, gross_weight: transport.gross_weight ?? null,
    /** Entrega própria: frete por transporte próprio (3 ou 4) ou sem transportadora e sem "sem frete" (9). */
    own_delivery: (OWN_DELIVERY_FREIGHT as readonly string[]).includes(mode ?? "") || (carrier === null && mode !== "9"),
  };
}

export function orderSummary(db: SqlDriver, r: Row, warehouses: Map<string, string | null>) {
  const body = obj(parse(r.body)), t = transportOf(r), p = recipientOf(r), status = shipStatus(r);
  const wh = orderWarehouse(db, r);
  if (wh && !warehouses.has(wh)) warehouses.set(wh, recordName(db, wh));
  const counts = one(db, `SELECT (SELECT count(*) FROM "${PENDING}" WHERE document_id=? AND status='open') pending, (SELECT count(*) FROM "${VOLUME}" WHERE document_id=?) volumes`, r.id, r.id)!;
  const list = r.pick_list_id ? one(db, `SELECT number, status FROM "${LIST}" WHERE id=?`, r.pick_list_id) : null;
  return {
    id: String(r.id), number: Number(r.number), date: typeof body.date === "string" ? body.date : null, order_status: String(r.status),
    status, status_label: SHIPPING_STATUS_LABEL[status], version: int(r.ship_version) ?? 0,
    customer: p.name, city: p.city, state: p.state, total_cents: r.total === null ? null : String(r.total),
    carrier: t.carrier_id ? { id: t.carrier_id, name: recordName(db, t.carrier_id) } : null, freight_mode: t.freight_mode, own_delivery: t.own_delivery,
    warehouse: wh ? { id: wh, name: warehouses.get(wh) ?? null } : null,
    pick_list: r.pick_list_id && list ? { id: String(r.pick_list_id), number: Number(list.number), status: String(list.status) } : null,
    pending: Number(counts.pending), volumes: Number(counts.volumes), shipped_on: spDay(r.shipped_at), tracking_code: (r.tracking_code as string | null) ?? null,
    delivery_id: (r.delivery_id as string | null) ?? null,
  };
}

/** erp_shipping_overview: os pedidos na expedição (filtros por situação, data, transportadora e depósito), as listas abertas e as embalagens. */
export function erpShippingOverview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  const role = requireShipping(db, user, false);
  const o = argsOf(a.p_args, ["status", "from", "to", "carrier_id", "warehouse_id", "search"]);
  const status = o.status === undefined || o.status === null || o.status === "" ? null : String(o.status);
  if (status !== null && status !== "all" && !(SHIPPING_STATUSES as readonly string[]).includes(status)) invalid();
  const from = dayOf(o.from), to = dayOf(o.to);
  const carrier = o.carrier_id === "none" ? "none" : uuidOf(o.carrier_id, false);
  const warehouse = uuidOf(o.warehouse_id, false);
  const search = textOf(o.search, 100);
  const rows = db.exec(
    `${ORDER_SELECT} WHERE ${ORDER_WHERE} AND d.status NOT IN ('draft','cancelled')
       AND (? IS NULL OR (d.body ->> 'date')>=?) AND (? IS NULL OR (d.body ->> 'date')<=?)
     ORDER BY (d.body ->> 'date') DESC, d.number DESC LIMIT ${SHIPPING_ORDER_LIMIT * 4 + 1}`,
    from, from, to, to,
  ).rows;
  const warehouses = new Map<string, string | null>();
  const counts: Record<string, number> = Object.fromEntries(SHIPPING_STATUSES.map((s) => [s, 0]));
  const items: ReturnType<typeof orderSummary>[] = [];
  let truncated = rows.length > SHIPPING_ORDER_LIMIT * 4;
  for (const r of rows.slice(0, SHIPPING_ORDER_LIMIT * 4)) {
    if (!documents.contactUsable(db, user, r.contact_id as string | null)) continue;
    const t = transportOf(r);
    if (carrier === "none" ? t.carrier_id !== null : carrier !== null && t.carrier_id !== carrier) continue;
    if (warehouse !== null && orderWarehouse(db, r) !== warehouse) continue;
    const s = shipStatus(r);
    if (search !== null) {
      const p = recipientOf(r);
      if (!String(r.number).includes(search) && !p.name.toLowerCase().includes(search.toLowerCase())) continue;
    }
    counts[s]++;
    if (status !== null && status !== "all" && s !== status) continue;
    if (items.length >= SHIPPING_ORDER_LIMIT) { truncated = true; continue; }
    items.push(orderSummary(db, r, warehouses));
  }
  const lists = db.exec(`SELECT l.id, l.number, l.status, CAST(l.created_at AS TEXT) created_at, (SELECT count(DISTINCT document_id) FROM "${LINE}" WHERE pick_list_id=l.id) orders
    FROM "${LIST}" l WHERE l.status='open' ORDER BY l.number DESC LIMIT 50`).rows
    .map((l) => ({ id: String(l.id), number: Number(l.number), status: String(l.status), created_at: iso(l.created_at), orders: Number(l.orders) }));
  return {
    scope: "shipping_overview", data_mode: "erp_native", role, can_write: WRITE_ROLES.includes(role), fiscal: ctx.parts.fiscal,
    counts, items, truncated, lists, packages: packageRows(db, false), status_labels: SHIPPING_STATUS_LABEL,
  };
}

// ---------------------------------------------------------------------------
// Embalagens

function packageDto(r: Row) {
  return {
    id: String(r.id), name: String(r.name), length_mm: int(r.length_mm), width_mm: int(r.width_mm), height_mm: int(r.height_mm),
    empty_weight_g: int(r.empty_weight_g), active: Number(r.active) === 1, version: Number(r.version),
  };
}
const packageRows = (db: SqlDriver, all: boolean) =>
  db.exec(`SELECT * FROM "${PACKAGE}" ${all ? "" : "WHERE active=1"} ORDER BY lower(name), id LIMIT 500`).rows.map(packageDto);

export function erpShippingPackages(ctx: RpcContext, a: RpcArgs) {
  requireShipping(ctx.db, String(a.p_user_id), false);
  argsOf(a.p_args, []);
  return { scope: "shipping_packages", data_mode: "erp_native", items: packageRows(ctx.db, true) };
}

/** erp_shipping_package_save: cadastra ou altera uma embalagem (medidas em cm e peso vazio em kg). */
export function erpShippingPackageSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["id", "expected_version", "name", "length_cm", "width_cm", "height_cm", "empty_weight_kg", "active"]);
  const hash = hashOf("package_save", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const name = textOf(o.name, 80, 1) ?? invalid("erp_shipping_package_name");
  const dims = ["length_cm", "width_cm", "height_cm"].map((k) => cmToMm(o[k]));
  const weight = kgToGrams(o.empty_weight_kg);
  if (dims.some((d) => d === undefined) || weight === undefined) invalid("erp_shipping_package_measures");
  if (o.active !== undefined && typeof o.active !== "boolean") invalid();
  const id = uuidOf(o.id, false), at = now(ctx);
  let saved: string;
  if (id === null) {
    saved = crypto.randomUUID();
    db.exec(`INSERT INTO "${PACKAGE}"(id, name, length_mm, width_mm, height_mm, empty_weight_g, active, version, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`, saved, name, dims[0], dims[1], dims[2], weight, o.active === false ? 0 : 1, user, user, at, at);
  } else {
    const r = one(db, `SELECT version FROM "${PACKAGE}" WHERE id=?`, id);
    if (!r) raise("P0002", "erp_shipping_package_not_found");
    if (Number(r!.version) !== Number(o.expected_version)) raise("40001", "erp_shipping_version_conflict");
    db.exec(`UPDATE "${PACKAGE}" SET name=?, length_mm=?, width_mm=?, height_mm=?, empty_weight_g=?, active=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      name, dims[0], dims[1], dims[2], weight, o.active === false ? 0 : 1, user, at, id);
    saved = id;
  }
  return receipt(ctx, command, user, hash, { scope: "shipping_package", record: packageDto(one(db, `SELECT * FROM "${PACKAGE}" WHERE id=?`, saved)!) });
}

// ---------------------------------------------------------------------------
// Separação

/** Linhas do pedido para separar: as da conferência do pedido (com o desmembramento de kit dela), sem serviço. */
export function orderPickLines(ctx: RpcContext, documentId: string) {
  const db = ctx.db;
  const lines = checkoutLines(db, documentId, checkoutSettings(db, ctx.parts).split, ctx.parts);
  const kinds = new Map<string, string | null>();
  for (const l of lines) if (typeof l.product_id === "string" && !kinds.has(l.product_id))
    kinds.set(l.product_id, (one(db, 'SELECT kind FROM "erp_catalog__product" WHERE record_id=?', l.product_id)?.kind as string | null) ?? null);
  return lines.filter((l) => l.quantity !== null && (scaled6(l.quantity) ?? 0n) > 0n && !(typeof l.product_id === "string" && kinds.get(l.product_id) === "S"));
}

function listRow(db: SqlDriver, id: unknown): Row {
  const r = one(db, `SELECT * FROM "${LIST}" WHERE id=?`, uuidOf(id));
  if (!r) raise("P0002", "erp_shipping_list_not_found");
  return r!;
}
function listLines(db: SqlDriver, list: string): (PickLine & { line_key: string; position: number })[] {
  return db.exec(`SELECT l.*, CAST(l.quantity AS TEXT) q, CAST(l.picked AS TEXT) p, d.number FROM "${LINE}" l JOIN "erp_documents__document" d ON d.id=l.document_id
    WHERE l.pick_list_id=? ORDER BY d.number, l.position, l.line_key`, list).rows.map((r) => ({
    id: String(r.id), document_id: String(r.document_id), number: Number(r.number), line_key: String(r.line_key), position: Number(r.position),
    product_id: (r.product_id as string | null) ?? null, warehouse_id: (r.warehouse_id as string | null) ?? null, location: (r.location as string | null) ?? null,
    description: String(r.description), code: (r.code as string | null) ?? null, gtin: (r.gtin as string | null) ?? null, unit: (r.unit as string | null) ?? null,
    quantity: BigInt(String(r.q)), picked: BigInt(String(r.p)),
  }));
}
function listView(ctx: RpcContext, user: string, list: Row) {
  const db = ctx.db;
  const lines = listLines(db, String(list.id));
  const warehouses = new Map<string, string | null>();
  for (const l of lines) if (l.warehouse_id && !warehouses.has(l.warehouse_id)) warehouses.set(l.warehouse_id, recordName(db, l.warehouse_id));
  const docs = [...new Set(lines.map((l) => l.document_id))];
  const orders = docs.map((id) => {
    const r = one(db, `${ORDER_SELECT} WHERE d.id=?`, id)!;
    const mine = lines.filter((l) => l.document_id === id);
    return { id, number: Number(r.number), customer: recipientOf(r).name, status: shipStatus(r), status_label: SHIPPING_STATUS_LABEL[shipStatus(r)],
      quantity: text6(mine.reduce((s, l) => s + l.quantity, 0n)), picked: text6(mine.reduce((s, l) => s + l.picked, 0n)),
      visible: documents.contactUsable(db, user, r.contact_id as string | null) };
  });
  return {
    scope: "shipping_pick_list", data_mode: "erp_native",
    list: { id: String(list.id), number: Number(list.number), status: String(list.status), version: Number(list.version), filters: obj(parse(list.filters)),
      created_at: iso(list.created_at), finished_at: iso(list.finished_at) },
    rows: consolidate(lines).map((r) => ({
      key: r.key, product_id: r.product_id, warehouse: r.warehouse_id ? { id: r.warehouse_id, name: warehouses.get(r.warehouse_id) ?? null } : null,
      location: r.location, description: r.description, code: r.code, gtin: r.gtin, unit: r.unit, quantity: text6(r.quantity), picked: text6(r.picked),
      done: r.picked >= r.quantity, orders: r.orders.map((o) => ({ document_id: o.document_id, number: o.number, quantity: text6(o.quantity), picked: text6(o.picked) })),
    })),
    orders,
  };
}

export function erpShippingPickGet(ctx: RpcContext, a: RpcArgs) {
  const user = String(a.p_user_id);
  requireShipping(ctx.db, user, false);
  const o = argsOf(a.p_args, ["id"]);
  return listView(ctx, user, listRow(ctx.db, o.id));
}

/** erp_shipping_pick_create: a lista de separação dos pedidos escolhidos (todos a separar). */
export function erpShippingPickCreate(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_ids", "filters"]);
  const hash = hashOf("pick_create", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const ids = idList(o.document_ids);
  const filters = o.filters === undefined || o.filters === null ? {} : o.filters;
  if (typeof filters !== "object" || Array.isArray(filters) || JSON.stringify(filters).length > 2000) invalid();
  const busy: number[] = [];
  const orders = ids.map((id) => {
    const r = orderRow(db, user, id);
    if (["draft", "cancelled"].includes(String(r.status)) || shipStatus(r) !== "to_pick") busy.push(Number(r.number));
    return r;
  });
  if (busy.length) raise("40001", `erp_shipping_orders_unavailable:${busy.sort((x, y) => x - y).join(",")}`);
  const listId = crypto.randomUUID(), at = now(ctx);
  const number = Number(one(db, `SELECT coalesce(max(number),0)+1 n FROM "${LIST}"`)!.n);
  db.exec(`INSERT INTO "${LIST}"(id, number, status, filters, version, created_by, created_at) VALUES(?,?,'open',?,1,?,?)`, listId, number, JSON.stringify(filters), user, at);
  let total = 0;
  for (const r of orders) {
    const wh = orderWarehouse(db, r);
    const lines = orderPickLines(ctx, String(r.id));
    total += lines.length;
    if (total > 5000) raise("54000", "erp_shipping_limit");
    for (const l of lines)
      db.exec(`INSERT INTO "${LINE}"(id, pick_list_id, document_id, line_key, position, product_id, warehouse_id, location, description, code, gtin, unit, quantity, picked)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, crypto.randomUUID(), listId, r.id, String(l.key), Number(l.position), l.product_id ?? null, wh, l.location ?? null,
        left(l.description ?? "Item sem descrição", 200) || "Item sem descrição", left(l.code, 100), left(l.gtin, 14), left(l.unit, 16), scaled6(l.quantity)!.toString());
    setOrder(ctx, user, String(r.id), "picking", { pick_list_id: listId });
  }
  if (total === 0) raise("22023", "erp_shipping_nothing_to_pick");
  return receipt(ctx, command, user, hash, listView(ctx, user, listRow(db, listId)));
}

/** Grava a situação do pedido na expedição (cria a linha na primeira vez). */
export function setOrder(ctx: RpcContext, user: string, document: string, status: ShippingStatus, extra: Record<string, unknown> = {}) {
  const db = ctx.db, at = now(ctx);
  const cur = one(db, `SELECT * FROM "${ORDER}" WHERE document_id=?`, document);
  const values = { status, updated_by: user, updated_at: at, ...extra };
  if (!cur) {
    const row = { document_id: document, pick_list_id: null, version: 1, created_at: at, ...values };
    const keys = Object.keys(row);
    db.exec(`INSERT INTO "${ORDER}"(${keys.join(", ")}) VALUES(${keys.map(() => "?").join(", ")})`, ...Object.values(row));
  } else {
    const keys = Object.keys(values);
    db.exec(`UPDATE "${ORDER}" SET ${keys.map((k) => `${k}=?`).join(", ")}, version=version+1 WHERE document_id=?`, ...Object.values(values), document);
  }
}

function openList(db: SqlDriver, o: Record<string, any>) {
  const list = listRow(db, o.list_id);
  if (list.status !== "open") raise("40001", "erp_shipping_list_closed");
  if (Number(list.version) !== Number(o.expected_version)) raise("40001", "erp_shipping_version_conflict");
  return list;
}

/** erp_shipping_pick_mark: quanto já foi separado de uma linha consolidada (dividido entre os pedidos, do mais antigo). */
export function erpShippingPickMark(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["list_id", "expected_version", "key", "picked"]);
  const list = openList(db, o);
  if (typeof o.key !== "string" || o.key.length > 400) invalid();
  const picked = scaled6(o.picked);
  if (picked === null || picked === undefined || picked < 0n) invalid("erp_shipping_quantity_invalid");
  const lines = listLines(db, String(list.id)).filter((l) => consolidatedKey(l) === o.key);
  if (!lines.length) raise("P0002", "erp_shipping_row_not_found");
  const total = lines.reduce((s, l) => s + l.quantity, 0n);
  if (picked! > total) raise("22023", "erp_shipping_pick_over");
  const split = distribute(lines, picked!);
  const at = now(ctx);
  lines.forEach((l, i) => db.exec(`UPDATE "${LINE}" SET picked=?, updated_by=?, updated_at=? WHERE id=?`, split[i].toString(), user, at, l.id));
  db.exec(`UPDATE "${LIST}" SET version=version+1 WHERE id=?`, list.id);
  return listView(ctx, user, listRow(db, list.id));
}

/** erp_shipping_pick_finish: encerra a lista; o que faltou vira pendência e ocorrência no pedido; os pedidos ficam separados. */
export function erpShippingPickFinish(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["list_id", "expected_version"]);
  const hash = hashOf("pick_finish", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const list = openList(db, o);
  const lines = listLines(db, String(list.id));
  const at = now(ctx);
  const pending: { document_id: string; number: number; description: string; missing: string }[] = [];
  for (const doc of [...new Set(lines.map((l) => l.document_id))]) {
    const mine = lines.filter((l) => l.document_id === doc);
    const short = mine.filter((l) => l.picked < l.quantity);
    for (const l of short) {
      db.exec(`INSERT INTO "${PENDING}"(id, document_id, pick_list_id, line_key, product_id, description, quantity, picked, status, created_by, created_at)
        VALUES(?,?,?,?,?,?,?,?,'open',?,?)`, crypto.randomUUID(), doc, list.id, l.line_key, l.product_id, l.description, l.quantity.toString(), l.picked.toString(), user, at);
      pending.push({ document_id: doc, number: l.number, description: l.description, missing: text6(l.quantity - l.picked) });
    }
    const d = one(db, 'SELECT status, version FROM "erp_documents__document" WHERE id=?', doc)!;
    if (short.length) {
      const text = left(`Expedição, lista de separação ${list.number}: faltou ${short.map((l) => `${shortQuantity(l.quantity - l.picked)} ${l.unit ?? ""} de ${l.description}`.replace(/\s+/g, " ")).join("; ")}.`, 1000)!;
      recordOccurrence(ctx, { document: doc, actor: user, command: subCommand(command, `occurrence:${doc}`), version: Number(d.version), before: d.status, after: null, text },
        { on: null, time: null, text: null, next_contact: null });
    }
    setOrder(ctx, user, doc, "picked");
  }
  db.exec(`UPDATE "${LIST}" SET status='done', version=version+1, finished_by=?, finished_at=? WHERE id=?`, user, at, list.id);
  return receipt(ctx, command, user, hash, { ...listView(ctx, user, listRow(db, list.id)), pending });
}

/** erp_shipping_pick_cancel: desfaz a lista aberta; os pedidos voltam para a separar. */
export function erpShippingPickCancel(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["list_id", "expected_version"]);
  const hash = hashOf("pick_cancel", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const list = openList(db, o);
  for (const r of db.exec(`SELECT document_id FROM "${ORDER}" WHERE pick_list_id=? AND status='picking'`, list.id).rows)
    setOrder(ctx, user, String(r.document_id), "to_pick", { pick_list_id: null });
  db.exec(`UPDATE "${LIST}" SET status='cancelled', version=version+1, finished_by=?, finished_at=? WHERE id=?`, user, now(ctx), list.id);
  return receipt(ctx, command, user, hash, listView(ctx, user, listRow(db, list.id)));
}

/** erp_shipping_pending_resolve: dá a pendência por resolvida (com uma observação). */
export function erpShippingPendingResolve(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["id", "note"]);
  const hash = hashOf("pending_resolve", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const p = one(db, `SELECT * FROM "${PENDING}" WHERE id=?`, uuidOf(o.id));
  if (!p) raise("P0002", "erp_shipping_pending_not_found");
  orderRow(db, user, p!.document_id);
  if (p!.status !== "open") raise("40001", "erp_shipping_pending_resolved");
  db.exec(`UPDATE "${PENDING}" SET status='resolved', note=?, resolved_by=?, resolved_at=? WHERE id=?`, textOf(o.note, 500), user, now(ctx), p!.id);
  return receipt(ctx, command, user, hash, { scope: "shipping_pending", id: String(p!.id), status: "resolved" });
}

// ---------------------------------------------------------------------------
// Pedido: detalhe, volumes, expedição e entrega

interface ProductMeasures { net: bigint | null; gross: bigint | null; width: bigint | null; height: bigint | null; depth: bigint | null; unit: string | null }
function productMeasures(db: SqlDriver, id: unknown, cache: Map<string, ProductMeasures>): ProductMeasures | null {
  if (typeof id !== "string") return null;
  if (cache.has(id)) return cache.get(id)!;
  const r = one(db, `SELECT CAST(net_weight AS TEXT) net, CAST(gross_weight AS TEXT) gross, CAST(width AS TEXT) width, CAST(height AS TEXT) height,
    CAST(depth AS TEXT) depth, dimension_unit FROM "erp_catalog__product" WHERE record_id=?`, id);
  const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(String(v)));
  const m = r ? { net: big(r.net), gross: big(r.gross), width: big(r.width), height: big(r.height), depth: big(r.depth), unit: (r.dimension_unit as string | null) ?? null } : null;
  if (m) cache.set(id, m);
  return m;
}

function emissionOf(ctx: RpcContext, document: string) {
  if (!ctx.parts.fiscal) return null;
  const r = one(ctx.db, `SELECT id, status, number, series FROM "erp_fiscal_vault__order_emission" WHERE document_id=? ORDER BY fiscal_version DESC LIMIT 1`, document);
  if (!r) return null;
  return { id: String(r.id), status: String(r.status), number: int(r.number), series: int(r.series), authorized: r.status === "autorizada",
    /** Atalho para a devolução fiscal que já existe (a tela da nota, onde a pessoa emite; nada é emitido daqui). */
    return_path: r.status === "autorizada" ? `/historico-fiscal?modelo=55&emissao=${r.id}` : null };
}

export function volumeRows(db: SqlDriver, document: string) {
  return db.exec(`SELECT v.*, p.name package_name FROM "${VOLUME}" v LEFT JOIN "${PACKAGE}" p ON p.id=v.package_id WHERE v.document_id=? ORDER BY v.number`, document).rows.map((v) => ({
    id: String(v.id), number: Number(v.number), package: v.package_id ? { id: String(v.package_id), name: (v.package_name as string | null) ?? null } : null,
    length_mm: int(v.length_mm), width_mm: int(v.width_mm), height_mm: int(v.height_mm), net_weight_g: int(v.net_weight_g), gross_weight_g: int(v.gross_weight_g),
    items: parse(v.items) as { key: string; description: string; quantity: string }[],
  }));
}
function returnedByKey(db: SqlDriver, document: string) {
  const out = new Map<string, bigint>();
  for (const r of db.exec(`SELECT items FROM "${RETURN}" WHERE document_id=?`, document).rows)
    for (const i of parse(r.items) as { key: string; quantity: string }[]) out.set(i.key, (out.get(i.key) ?? 0n) + scaled6(i.quantity)!);
  return out;
}

function orderView(ctx: RpcContext, user: string, r: Row) {
  const db = ctx.db, id = String(r.id);
  const cache = new Map<string, ProductMeasures>();
  const returned = returnedByKey(db, id);
  const lines = orderPickLines(ctx, id).map((l) => {
    const m = productMeasures(db, l.product_id, cache);
    return {
      key: String(l.key), product_id: (l.product_id as string | null) ?? null, description: String(l.description ?? ""), code: (l.code as string | null) ?? null,
      gtin: l.gtin ?? null, unit: (l.unit as string | null) ?? null, location: l.location ?? null, quantity: l.quantity!,
      returned: text6(returned.get(String(l.key)) ?? 0n),
      net_weight_g: m ? (m.net === null ? null : Number(m.net / 1000n)) : null, gross_weight_g: m ? (m.gross === null ? null : Number(m.gross / 1000n)) : null,
      measures_mm: m ? [productMeasureMm(m.depth, m.unit), productMeasureMm(m.width, m.unit), productMeasureMm(m.height, m.unit)] : null,
    };
  });
  const warehouses = new Map<string, string | null>();
  const pending = db.exec(`SELECT p.*, CAST(p.quantity AS TEXT) q, CAST(p.picked AS TEXT) pk, l.number list_number FROM "${PENDING}" p JOIN "${LIST}" l ON l.id=p.pick_list_id
    WHERE p.document_id=? ORDER BY p.created_at, p.id`, id).rows.map((p) => ({
    id: String(p.id), list_number: Number(p.list_number), description: String(p.description), quantity: text6(BigInt(String(p.q))), picked: text6(BigInt(String(p.pk))),
    missing: text6(BigInt(String(p.q)) - BigInt(String(p.pk))), status: String(p.status), note: (p.note as string | null) ?? null,
  }));
  const returns = db.exec(`SELECT * FROM "${RETURN}" WHERE document_id=? ORDER BY created_at, id`, id).rows.map((x) => ({
    id: String(x.id), number: Number(x.number), reason: String(x.reason), created_at: iso(x.created_at), movement_id: (x.movement_id as string | null) ?? null,
    warehouse: x.warehouse_id ? { id: String(x.warehouse_id), name: recordName(db, x.warehouse_id) } : null, items: parse(x.items),
  }));
  const p = recipientOf(r), t = transportOf(r);
  return {
    scope: "shipping_order", data_mode: "erp_native", fiscal: ctx.parts.fiscal,
    order: { ...orderSummary(db, r, warehouses), recipient: p, address: addressLine(p), transport: t, transport_synced_at: iso(r.transport_at), delivery_at: iso(r.delivery_at) },
    lines, pending, volumes: volumeRows(db, id), returns, emission: emissionOf(ctx, id), packages: packageRows(db, false),
  };
}

export function erpShippingOrderGet(ctx: RpcContext, a: RpcArgs) {
  const user = String(a.p_user_id);
  requireShipping(ctx.db, user, false);
  const o = argsOf(a.p_args, ["id"]);
  return orderView(ctx, user, orderRow(ctx.db, user, o.id));
}

/** Escreve volumes e peso bruto no transporte do pedido (o que a NF-e já lê), pela mesma gravação das observações do pedido. */
function writeTransport(ctx: RpcContext, user: string, document: string, volumes: number, grossGrams: number) {
  const db = ctx.db;
  const d = one(db, 'SELECT status, version, body FROM "erp_documents__document" WHERE id=?', document)!;
  if (d.status === "cancelled") return { written: false, reason: "order_cancelled" };
  const emission = emissionOf(ctx, document);
  // Nota já enviada ou autorizada: o transporte dela não muda mais pelo pedido.
  if (emission && ["enviando", "processando", "incerta", "autorizada", "denegada", "cancelada", "arquivada"].includes(emission.status)) return { written: false, reason: "invoice_exists" };
  const body = obj(parse(d.body));
  const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport: null, ...obj(body.commercial) };
  const transport: Record<string, unknown> = { freight_mode: null, volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null, ...obj(commercial.transport) };
  if (transport.freight_mode === "9") return { written: false, reason: "no_freight" };
  transport.volume_count = text6(BigInt(volumes) * 1_000_000n);
  transport.gross_weight = gramsToKg6(grossGrams);
  documents.updateDocument(ctx, document, { body: JSON.stringify({ ...body, commercial: { ...commercial, transport } }), version: Number(d.version) + 1, updated_by: user, updated_at: now(ctx) });
  return { written: true, reason: null };
}

/** erp_shipping_pack: os volumes do pedido separado (itens em cada embalagem, medidas e pesos); o pedido fica embalado. */
export function erpShippingPack(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_id", "expected_version", "volumes"]);
  const hash = hashOf("pack", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const r = orderRow(db, user, o.document_id);
  const id = String(r.id);
  if (!["picked", "packed"].includes(shipStatus(r))) raise("40001", `erp_shipping_status_conflict:${shipStatus(r)}`);
  if ((int(r.ship_version) ?? 0) !== Number(o.expected_version)) raise("40001", "erp_shipping_version_conflict");
  if (!Array.isArray(o.volumes) || o.volumes.length < 1 || o.volumes.length > 999) invalid("erp_shipping_volumes_invalid");
  const lines = new Map(orderPickLines(ctx, id).map((l) => [String(l.key), l]));
  const packed = new Map<string, bigint>();
  const cache = new Map<string, ProductMeasures>();
  const at = now(ctx);
  const built = (o.volumes as unknown[]).map((raw, index) => {
    const v = obj(raw);
    if (Object.keys(v).some((k) => !["package_id", "length_cm", "width_cm", "height_cm", "gross_kg", "items"].includes(k))) invalid("erp_shipping_volumes_invalid");
    const pkgId = uuidOf(v.package_id, false);
    const pkg = pkgId ? one(db, `SELECT * FROM "${PACKAGE}" WHERE id=?`, pkgId) : null;
    if (pkgId && !pkg) raise("P0002", "erp_shipping_package_not_found");
    const typed = ["length_cm", "width_cm", "height_cm"].map((k) => cmToMm(v[k]));
    const gross = kgToGrams(v.gross_kg);
    if (typed.some((d) => d === undefined) || gross === undefined) invalid("erp_shipping_volume_measures");
    if (!Array.isArray(v.items) || v.items.length > 250) invalid("erp_shipping_volume_items");
    const items = (v.items as unknown[]).map((x) => {
      const i = obj(x);
      const line = typeof i.key === "string" ? lines.get(i.key) : undefined;
      const q = scaled6(i.quantity);
      if (!line || q === null || q === undefined || q <= 0n) invalid("erp_shipping_volume_items");
      packed.set(i.key, (packed.get(i.key) ?? 0n) + q!);
      const m = productMeasures(db, line!.product_id, cache);
      return { key: String(i.key), product_id: (line!.product_id as string | null) ?? null, description: String(line!.description ?? ""), quantity: text6(q!), unit: (line!.unit as string | null) ?? null,
        weight: { quantity: q!, net_kg6: m?.net ?? null, gross_kg6: m?.gross ?? null } };
    });
    const w = volumeWeights(items.map((i) => i.weight), pkg ? int(pkg.empty_weight_g) : null, gross ?? null);
    const dims = [0, 1, 2].map((k) => typed[k] ?? (pkg ? int(pkg[["length_mm", "width_mm", "height_mm"][k]]) : null));
    return { number: index + 1, package_id: pkgId, dims, weights: w, items: items.map(({ weight: _w, ...rest }) => rest) };
  });
  for (const [key, q] of packed) if (q > scaled6(lines.get(key)!.quantity)!) raise("22023", "erp_shipping_volume_exceeds");
  db.exec(`DELETE FROM "${VOLUME}" WHERE document_id=?`, id);
  for (const v of built)
    db.exec(`INSERT INTO "${VOLUME}"(id, document_id, number, package_id, length_mm, width_mm, height_mm, net_weight_g, gross_weight_g, items, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), id, v.number, v.package_id, v.dims[0], v.dims[1], v.dims[2], v.weights.net_g, v.weights.gross_g, JSON.stringify(v.items), user, at);
  const net = built.reduce((s, v) => s + v.weights.net_g, 0), gross = built.reduce((s, v) => s + v.weights.gross_g, 0);
  const unpacked = [...lines.values()].filter((l) => (packed.get(String(l.key)) ?? 0n) < scaled6(l.quantity)!)
    .map((l) => ({ key: String(l.key), description: String(l.description ?? ""), missing: text6(scaled6(l.quantity)! - (packed.get(String(l.key)) ?? 0n)) }));
  // Com Fiscal ligado, a quantidade de volumes e o peso bruto vão para o transporte do pedido (o peso líquido o pedido ainda não guarda).
  const transport = ctx.parts.fiscal ? writeTransport(ctx, user, id, built.length, gross) : { written: false, reason: "fiscal_off" };
  setOrder(ctx, user, id, "packed", transport.written ? { transport_at: now(ctx) } : {});
  return receipt(ctx, command, user, hash, {
    ...orderView(ctx, user, orderRow(db, user, id)), totals: { volumes: built.length, net_weight_g: net, gross_weight_g: gross },
    unpacked, transport, items_without_weight: built.reduce((s, v) => s + v.weights.items_without_weight, 0),
  });
}

/** erp_shipping_ship: marca expedidos os pedidos embalados (com o código de rastreio, se houver). */
export function erpShippingShip(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_ids", "tracking_code"]);
  const hash = hashOf("ship", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const ids = idList(o.document_ids);
  const tracking = textOf(o.tracking_code, 200);
  if (tracking !== null && ids.length > 1) invalid("erp_shipping_tracking_single");
  const orders = ids.map((id) => orderRow(db, user, id));
  const wrong = orders.filter((r) => !["packed", "shipped"].includes(shipStatus(r))).map((r) => Number(r.number));
  if (wrong.length) raise("40001", `erp_shipping_not_packed:${wrong.sort((x, y) => x - y).join(",")}`);
  const at = now(ctx), shipped: number[] = [];
  for (const r of orders) {
    if (shipStatus(r) === "shipped") continue;
    setOrder(ctx, user, String(r.id), "shipped", { shipped_by: user, shipped_at: at, ...(tracking !== null ? { tracking_code: tracking } : {}) });
    shipped.push(Number(r.number));
  }
  const warehouses = new Map<string, string | null>();
  return receipt(ctx, command, user, hash, { scope: "shipping_ship", shipped, items: orders.map((r) => orderSummary(db, orderRow(db, user, r.id), warehouses)) });
}

/** Dados de remetente (empresa) para etiqueta e romaneio. */
export function companyOf(db: SqlDriver) {
  const d = obj(parse(one(db, 'SELECT data FROM "erp_company__identity" WHERE singleton=1')?.data));
  const s = (k: string) => (typeof d[k] === "string" && d[k].trim() ? d[k].trim() : null);
  return { name: s("trade_name") ?? s("legal_name") ?? "Empresa", legal_name: s("legal_name"), cnpj: s("cnpj"), street: s("street"), number: s("number"), complement: s("complement"),
    district: s("district"), city: s("city"), state: s("state"), postal_code: s("postal_code"), phone: s("phone") };
}

/** erp_shipping_labels: etiquetas de volume dos pedidos (destinatário, endereço, pedido, volume N de M e código de barras). */
export function erpShippingLabels(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  requireShipping(db, user, false);
  const o = argsOf(a.p_args, ["document_ids"]);
  const ids = idList(o.document_ids);
  const sender = companyOf(db);
  const labels = ids.flatMap((id) => {
    const r = orderRow(db, user, id), p = recipientOf(r), t = transportOf(r);
    const volumes = volumeRows(db, String(r.id));
    const list = volumes.length ? volumes : [{ number: 1, gross_weight_g: null, net_weight_g: null }];
    return list.map((v) => ({
      document_id: String(r.id), order_number: Number(r.number), volume: v.number, volumes: list.length, barcode: volumeBarcode(Number(r.number), v.number),
      recipient: p, address: addressLine(p), carrier: t.carrier_id ? recordName(db, t.carrier_id) : null, gross_weight_g: v.gross_weight_g,
      tracking_code: (r.tracking_code as string | null) ?? t.tracking_code,
    }));
  });
  return { scope: "shipping_labels", data_mode: "erp_native", sender, labels };
}

/** erp_shipping_manifest: romaneio de expedição por transportadora (pedidos expedidos no período e os volumes). */
export function erpShippingManifest(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  requireShipping(db, user, false);
  const o = argsOf(a.p_args, ["from", "to", "carrier_id"]);
  const from = dayOf(o.from) ?? todaySaoPaulo(), to = dayOf(o.to) ?? from;
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 92) invalid("erp_shipping_period_invalid");
  const carrier = o.carrier_id === "none" ? "none" : uuidOf(o.carrier_id, false);
  const rows = db.exec(`${ORDER_SELECT} WHERE ${ORDER_WHERE} AND s.status='shipped' ORDER BY s.shipped_at, d.number LIMIT 5001`).rows;
  if (rows.length > 5000) raise("54000", "erp_shipping_limit");
  const groups = new Map<string, { carrier: { id: string | null; name: string | null }; orders: Record<string, unknown>[]; volumes: number; gross_weight_g: number; net_weight_g: number }>();
  for (const r of rows) {
    const day = spDay(r.shipped_at)!;
    if (day < from || day > to || !documents.contactUsable(db, user, r.contact_id as string | null)) continue;
    const t = transportOf(r);
    if (carrier === "none" ? t.carrier_id !== null : carrier !== null && t.carrier_id !== carrier) continue;
    const key = t.carrier_id ?? "none";
    const g = groups.get(key) ?? { carrier: { id: t.carrier_id, name: t.carrier_id ? recordName(db, t.carrier_id) : null }, orders: [], volumes: 0, gross_weight_g: 0, net_weight_g: 0 };
    const v = volumeRows(db, String(r.id));
    const p = recipientOf(r);
    const gross = v.reduce((s, x) => s + (x.gross_weight_g ?? 0), 0), net = v.reduce((s, x) => s + (x.net_weight_g ?? 0), 0);
    g.orders.push({ id: String(r.id), number: Number(r.number), customer: p.name, city: p.city, state: p.state, shipped_on: day, volumes: v.length,
      gross_weight_g: gross, net_weight_g: net, tracking_code: (r.tracking_code as string | null) ?? t.tracking_code });
    g.volumes += v.length; g.gross_weight_g += gross; g.net_weight_g += net;
    groups.set(key, g);
  }
  return { scope: "shipping_manifest", data_mode: "erp_native", from, to, sender: companyOf(db),
    carriers: [...groups.values()].sort((x, y) => (x.carrier.name ?? "~").localeCompare(y.carrier.name ?? "~", "pt-BR")) };
}

/** erp_shipping_delivery_prepare: o que vai para o módulo Entrega (pedido expedido com entrega própria e sem entrega ainda). */
export function erpShippingDeliveryPrepare(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_id"]);
  const r = orderRow(db, user, o.document_id);
  if (shipStatus(r) !== "shipped") raise("40001", "erp_shipping_delivery_not_shipped");
  const t = transportOf(r);
  if (!t.own_delivery) raise("40001", "erp_shipping_delivery_not_own");
  const p = recipientOf(r), volumes = volumeRows(db, String(r.id));
  const cep = (p.postal_code ?? "").replace(/\D/g, "");
  return {
    scope: "shipping_delivery", document_id: String(r.id), order_number: Number(r.number), delivery_id: (r.delivery_id as string | null) ?? null,
    entrega: {
      source: "manual", label: left(`Pedido ${r.number}`, 80), customer_name: left(p.name, 120), address_text: left(addressLine(p), 300),
      address: p.street && p.city ? { street: p.street, number: p.number, complement: p.complement, district: p.district, city: p.city, state: p.state,
        postal_code: cep.length === 8 ? cep : null, reference: null } : null,
      note: left(`Pedido de venda ${r.number}${volumes.length ? `: ${volumes.length} volume${volumes.length > 1 ? "s" : ""}` : ""}${p.phone ? `. Telefone do cliente: ${p.phone}` : ""}.`, 500),
    },
  };
}

/** erp_shipping_delivery_record: guarda a entrega criada no módulo Entrega para o pedido. */
export function erpShippingDeliveryRecord(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_id", "delivery_id"]);
  const r = orderRow(db, user, o.document_id);
  const delivery = textOf(o.delivery_id, 100, 1) ?? invalid();
  if (r.delivery_id && r.delivery_id !== delivery) raise("40001", "erp_shipping_delivery_exists");
  if (!r.delivery_id) setOrder(ctx, user, String(r.id), shipStatus(r), { delivery_id: delivery, delivery_at: now(ctx) });
  return { scope: "shipping_delivery", document_id: String(r.id), delivery_id: delivery };
}

// ---------------------------------------------------------------------------
// Devolução física

/** erp_shipping_return_create: a volta de mercadoria do pedido; o que volta ao estoque entra pelo Estoque (um recebimento). */
export function erpShippingReturnCreate(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_id", "reason", "warehouse_id", "items"]);
  const hash = hashOf("return_create", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const r = orderRow(db, user, o.document_id);
  const id = String(r.id);
  if (["draft", "cancelled"].includes(String(r.status))) raise("40001", "erp_shipping_return_order_status");
  const reason = textOf(o.reason, 500, 3) ?? invalid("erp_shipping_return_reason");
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 250) invalid("erp_shipping_return_items");
  const lines = new Map(orderPickLines(ctx, id).map((l) => [String(l.key), l]));
  const returned = returnedByKey(db, id);
  const asked = new Map<string, bigint>();
  const items = (o.items as unknown[]).map((x) => {
    const i = obj(x);
    if (Object.keys(i).some((k) => !["key", "quantity", "condition"].includes(k))) invalid("erp_shipping_return_items");
    const line = typeof i.key === "string" ? lines.get(i.key) : undefined;
    const q = scaled6(i.quantity);
    if (!line || q === null || q === undefined || q <= 0n || !(RETURN_CONDITIONS as readonly string[]).includes(i.condition)) invalid("erp_shipping_return_items");
    asked.set(i.key, (asked.get(i.key) ?? 0n) + q!);
    return { key: String(i.key), product_id: (line!.product_id as string | null) ?? null, description: String(line!.description ?? ""), unit: (line!.unit as string | null) ?? null,
      quantity: text6(q!), condition: i.condition as ReturnCondition, condition_label: RETURN_CONDITION_LABEL[i.condition as ReturnCondition] };
  });
  for (const [key, q] of asked) if (q + (returned.get(key) ?? 0n) > scaled6(lines.get(key)!.quantity)!) raise("22023", "erp_shipping_return_exceeds");
  const restock = items.filter((i) => i.condition === "restock");
  if (restock.some((i) => i.product_id === null)) raise("22023", "erp_shipping_return_product_missing");
  const number = Number(one(db, `SELECT coalesce(max(number),0)+1 n FROM "${RETURN}"`)!.n);
  let warehouse: string | null = null, movement: string | null = null;
  if (restock.length) {
    warehouse = uuidOf(o.warehouse_id, false) ?? orderWarehouse(db, r);
    if (!warehouse) raise("22023", "erp_shipping_return_warehouse_missing");
    const merged = new Map<string, bigint>();
    for (const i of restock) merged.set(i.product_id!, (merged.get(i.product_id!) ?? 0n) + scaled6(i.quantity)!);
    const version = (product: string) => Number(one(db, 'SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse)?.version ?? 0);
    const posted = stock.post(ctx, {
      user, command: subCommand(command, "stock"), kind: "receipt", occurredOn: todaySaoPaulo(), reference: left(`Pedido ${r.number}`, 100),
      reason: left(`Devolução ${number} do pedido ${r.number}: ${reason}`, 500)!,
      items: [...merged].map(([product, q]) => ({ product_id: product, warehouse_id: warehouse, quantity: text6(q).replace(/\.?0+$/, ""), expected_version: version(product) })),
    }) as { movement: { id: string } };
    movement = String(posted.movement.id);
  }
  const returnId = crypto.randomUUID();
  db.exec(`INSERT INTO "${RETURN}"(id, number, document_id, reason, warehouse_id, items, movement_id, command_id, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    returnId, number, id, reason, warehouse, JSON.stringify(items), movement, command, user, now(ctx));
  return receipt(ctx, command, user, hash, {
    scope: "shipping_return", return: { id: returnId, number, reason, warehouse_id: warehouse, movement_id: movement, items },
    emission: emissionOf(ctx, id), order: orderView(ctx, user, orderRow(db, user, id)).order,
  });
}

registerRpc("erp_shipping_overview", erpShippingOverview);
registerRpc("erp_shipping_packages", erpShippingPackages);
registerRpc("erp_shipping_package_save", erpShippingPackageSave);
registerRpc("erp_shipping_pick_get", erpShippingPickGet);
registerRpc("erp_shipping_pick_create", erpShippingPickCreate);
registerRpc("erp_shipping_pick_mark", erpShippingPickMark);
registerRpc("erp_shipping_pick_finish", erpShippingPickFinish);
registerRpc("erp_shipping_pick_cancel", erpShippingPickCancel);
registerRpc("erp_shipping_pending_resolve", erpShippingPendingResolve);
registerRpc("erp_shipping_order_get", erpShippingOrderGet);
registerRpc("erp_shipping_pack", erpShippingPack);
registerRpc("erp_shipping_ship", erpShippingShip);
registerRpc("erp_shipping_labels", erpShippingLabels);
registerRpc("erp_shipping_manifest", erpShippingManifest);
registerRpc("erp_shipping_delivery_prepare", erpShippingDeliveryPrepare);
registerRpc("erp_shipping_delivery_record", erpShippingDeliveryRecord);
registerRpc("erp_shipping_return_create", erpShippingReturnCreate);
