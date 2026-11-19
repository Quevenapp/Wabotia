// Migração 280 e guardas de espelho de 202610220007 (últimas definições).
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcContext } from "../../../engine/registry.ts";
import { requireRpcParts } from "../../../engine/parts-gate.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { activeRole } from "../../access/public.ts";
import * as documents from "../../documents/public.ts";
import { ignoredWarehouse } from "../home.ts";
import { commandTaken, sha256 } from "../internal.ts";
import { COMPOSITION_CURRENT, invoicePostedForDocument, itemComponentRows } from "../read.ts";
import { componentProblem } from "./document-stock.ts";

type Row = Record<string, unknown>;
function numeric(q: bigint, precision: number, scale: number) {
  const limit = 10n ** BigInt(precision);
  if (q <= -limit || q >= limit) raise("22003", "numeric field overflow");
  return formatScaled(q, scale);
}
const t6 = (q: bigint) => numeric(q, 18, 6);

/** erp_stock.item_components_dto: estrutura vigente ou componentes editados deste produto/item. */
export function itemComponentsDto(db: SqlDriver, user: string, document: string, item: string) {
  const d = one(db, "SELECT id,kind,CAST(number AS TEXT) number,version,status,warehouse_id FROM erp_documents__document WHERE id=?", document)!;
  const i = one(db, "SELECT id,position,product_id,data,CAST(quantity AS TEXT) q FROM erp_documents__item WHERE id=? AND document_id=?", item, document);
  if (!i) raise("P0002", "erp_document_item_not_found");
  const p = one(db, "SELECT unit,format FROM erp_catalog__product WHERE record_id=?", i.product_id);
  const r = one(db, "SELECT id,name,code FROM erp_catalog__record WHERE id=?", i.product_id);
  const c = one(db, "SELECT stock_type,post_mode,version FROM erp_stock__composition WHERE product_id=?", i.product_id);
  const k = one(db, "SELECT version FROM erp_stock__item_component WHERE item_id=? AND product_id=?", item, i.product_id);
  const role = activeRole(db, user);
  const visible = role !== null && ["admin", "consulta", "estoque", "vendas", "fiscal"].includes(role);
  const structure = db.exec(
    `SELECT component_id,CAST(quantity AS TEXT) q FROM ${COMPOSITION_CURRENT} WHERE product_id=? ORDER BY position`, i.product_id,
  ).rows.map((x) => ({ component_id: x.component_id, quantity: t6(fromColumn(x.q)) }));
  const reason = !p || p.format !== "E" ? "not_composition"
    : !c || !structure.length ? "no_structure"
    : c.post_mode === "product" ? "product_only"
    : !documents.allowed(role, String(d.kind), true) ? "role"
    : !documents.editable(d.status) ? "locked"
    : one(db, "SELECT 1 FROM erp_stock__document_posting WHERE document_id=? AND state='active'", document) ? "posted"
    : one(db, "SELECT 1 FROM erp_stock__reservation WHERE document_id=? AND state='active'", document) ? "reserved"
    : invoicePostedForDocument(db, document) ? "invoice" : null;
  const components = itemComponentRows(db, item, i.product_id as string).flatMap((x) => {
    const cr = one(db, "SELECT r.name,r.code,r.active,p.unit FROM erp_catalog__record r LEFT JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?", x.component_id);
    if (!cr) return [];
    const balance = visible ? db.exec("SELECT warehouse_id,CAST(quantity AS TEXT) q FROM erp_stock__balance WHERE product_id=?", x.component_id).rows
      .reduce((sum, b) => sum + ((d.warehouse_id === null ? !ignoredWarehouse(db, String(b.warehouse_id)) : b.warehouse_id === d.warehouse_id) ? fromColumn(b.q) : 0n), 0n) : null;
    return [{
      component_id: x.component_id, name: cr.name, code: cr.code, unit: cr.unit, active: !!cr.active,
      problem: componentProblem(db, x.component_id), quantity: t6(rescale(x.quantity, 30, 6)),
      total: i.q === null ? null : numeric(rescale(x.quantity * fromColumn(i.q), 36, 12), 30, 12), stock: balance === null ? null : t6(balance),
    }];
  });
  const data = JSON.parse(String(i.data));
  return {
    document: { id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number), version: d.version, status: d.status, warehouse_id: d.warehouse_id },
    item: { id: i.id, position: i.position, product_id: i.product_id, description: arrow(data, "description"), quantity: i.q === null ? null : t6(fromColumn(i.q)), unit: arrow(data, "unit") },
    product: r ? { ...r, unit: p?.unit ?? null, format: p?.format ?? null } : null,
    composition: c ?? null, structure, edited: !!k, version: k?.version ?? 0, stock_visible: visible, components, editable: reason === null, reason_code: reason,
  };
}

/** BEFORE INSERT/UPDATE: aa_mirror_authority, guard_stock_item_component. */
export function guardItemComponent(db: SqlDriver, old: Row | null, row: Row) {
  documents.mirrorGuardEffect(db, old?.document_id, row.document_id);
  if (old === null ? row.version !== 1 : row.item_id !== old.item_id || row.document_id !== old.document_id || row.product_id !== old.product_id ||
    row.version !== Number(old.version) + 1 || row.command_id === old.command_id)
    raise("40001", "erp_stock_item_component_immutable");
}

function deleteComponents(db: SqlDriver, item: string) {
  const old = one(db, "SELECT document_id FROM erp_stock__item_component WHERE item_id=?", item);
  if (old) documents.mirrorGuardEffect(db, old.document_id);
  db.exec("DELETE FROM erp_stock__item_component WHERE item_id=?", item);
}

/** Auditoria e recibo: ambos append-only, com aa_mirror_authority antes da inserção. */
export function itemComponentsReceipt(ctx: RpcContext, user: string, command: string, document: string, item: string, hash: string, before: unknown, result: ReturnType<typeof itemComponentsDto> & Row) {
  requireRpcParts(ctx, "erp_stock_item_components_save", { p_document_id: document, p_item_id: item });
  const db = ctx.db;
  const auditId = nextIdentity(ctx, "erp_documents__audit", "id");
  documents.mirrorGuardEffect(db, document);
  db.exec("INSERT INTO erp_documents__audit(id,actor,command_id,document_id,action,reason,before_data,after_data,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    auditId, user, command, document, "kit_components", "Componentes do item (kit)", JSON.stringify({ item_id: item, components: before }),
    JSON.stringify({ item_id: item, components: result.components }), ctx.clock.next().toString());
  documents.mirrorGuardEffect(db, document);
  db.exec("INSERT INTO erp_stock__item_component_command(id,actor,document_id,item_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)",
    command, user, document, item, hash, JSON.stringify(result), ctx.clock.next().toString());
}

registerRpc("erp_stock_item_components", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, document = a.p_document_id as string, item = a.p_item_id as string;
  documents.mirrorRequireVisible(db, user, document, false);
  if (document === null || item === null) raise("22023", "erp_stock_invalid_query");
  const d = one(db, "SELECT kind,contact_id FROM erp_documents__document WHERE id=? AND kind IN ('sales_orders','service_orders')", document);
  if (!d) raise("P0002", "erp_document_not_found");
  documents.requireAccess(db, user, String(d.kind), false);
  if (!documents.contactUsable(db, user, d.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  return { scope: "stock_item_components", data_mode: "erp_native", ...itemComponentsDto(db, user, document, item) };
});

registerRpc("erp_stock_item_components_save", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string, document = a.p_document_id as string,
    item = a.p_item_id as string, documentVersion = a.p_expected_document_version as number, version = a.p_expected_version as number;
  const components = jsonbArg(a.p_components);
  documents.mirrorRequireVisible(db, user, document, true);
  if (command === null || document === null || item === null || documentVersion === null || documentVersion < 1 || documentVersion > 2147483646 ||
    version === null || version < 0 || version > 2147483646 ||
    (components !== null && (!Array.isArray(components) || components.length < 1 || components.length > 100 || components.some((j) =>
      jsonType(j) !== "object" || Object.keys(j).some((k) => !["component_id", "quantity"].includes(k)) ||
      typeof j.component_id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(j.component_id) ||
      typeof j.quantity !== "string" || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(j.quantity) || toScaled(j.quantity, 6) === 0n) ||
      new Set(components.map((j) => j.component_id)).size !== components.length))) raise("22023", "erp_stock_item_components_invalid");
  const d = one(db, "SELECT kind,contact_id,version FROM erp_documents__document WHERE id=? AND kind IN ('sales_orders','service_orders')", document);
  if (!d) raise("P0002", "erp_document_not_found");
  documents.requireAccess(db, user, String(d.kind), true);
  const hash = sha256(jsonbText({ profile: "stock-item-components-280", actor: user, document_id: document, document_version: documentVersion,
    item_id: item, expected_version: version, components }));
  const prior = one(db, "SELECT * FROM erp_stock__item_component_command WHERE id=?", command);
  if (prior) {
    if (prior.actor !== user || prior.request_hash !== hash) raise("40001", "erp_stock_item_components_conflict");
    return { ...JSON.parse(String(prior.result)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, "SELECT 1 FROM erp_documents__command WHERE command_id=?", command)) raise("40001", "erp_stock_item_components_conflict");
  if (!documents.contactUsable(db, user, d.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (d.version !== documentVersion || d.version === 2147483647) raise("40001", "erp_document_version_conflict");
  const view = itemComponentsDto(db, user, document, item);
  if (!view.editable) raise("40001", "erp_stock_item_components_locked");
  let old: Row | null = one(db, "SELECT * FROM erp_stock__item_component WHERE item_id=?", item);
  if (old && old.product_id !== view.item.product_id) { deleteComponents(db, item); old = null; }
  if ((old?.version ?? 0) !== version) raise("40001", "erp_stock_item_components_version_conflict");
  if (components === null) {
    if (!old) raise("22023", "erp_stock_item_components_unchanged");
    deleteComponents(db, item);
  } else {
    const list = components as { component_id: string; quantity: string }[];
    if (list.some((j) => componentProblem(db, j.component_id) !== null || j.component_id === view.item.product_id))
      raise("22023", "erp_stock_composition_component_unavailable");
    const clean = list.map((j) => ({ component_id: j.component_id, quantity: t6(toScaled(j.quantity, 6)) }));
    if (jsonbText(clean) === jsonbText(view.components.map((x) => ({ component_id: x.component_id, quantity: x.quantity }))))
      raise("22023", "erp_stock_item_components_unchanged");
    const row = { item_id: item, document_id: old?.document_id ?? document, product_id: view.item.product_id, version: version + 1, command_id: command };
    guardItemComponent(db, old ?? null, row);
    if (!old) db.exec("INSERT INTO erp_stock__item_component(item_id,document_id,product_id,components,version,updated_at,updated_by,command_id) VALUES(?,?,?,?,1,?,?,?)",
      item, document, view.item.product_id, JSON.stringify(clean), ctx.clock.next().toString(), user, command);
    else db.exec("UPDATE erp_stock__item_component SET components=?,version=version+1,updated_at=?,updated_by=?,command_id=? WHERE item_id=?",
      JSON.stringify(clean), ctx.clock.next().toString(), user, command, item);
  }
  // Todos os gatilhos de UPDATE (inclusive os adiados) ficam na camada pública do dono.
  documents.updateDocument(ctx, document, { version: documentVersion + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
  const result = { scope: "stock_item_components_save", data_mode: "erp_native", restored: components === null, ...itemComponentsDto(db, user, document, item) };
  itemComponentsReceipt(ctx, user, command, document, item, hash, view.components, result);
  return { ...result, replayed: false };
});
