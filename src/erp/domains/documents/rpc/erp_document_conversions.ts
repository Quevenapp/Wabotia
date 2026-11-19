// Conversões e cópia de documento: public.erp_proposal_convert (Gerar venda), _to_service (Gerar
// ordem de serviço), erp_sales_order_convert_to_service e erp_document_copy (Copiar).
// As escritas passam pela camada de linha (documents/rows.ts).
import { createHash } from "node:crypto";
import { linkedDocumentGuard } from "../module-policy.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { decText, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { dto as catalogDto } from "../../catalog/public.ts";
import { documentDto } from "../internal.ts";
import { guardEffect, requireVisible } from "../mirror.ts";
import { checkCustomFields, normalize } from "../normalize.ts";
import { contactUsable, requireAccess } from "../reads-g.ts";
import { insertDocument, insertItem, updateDocument } from "../rows.ts";
import {
  checkCreditLimit,
  checkLinks,
  checkPaymentLinks,
  checkPreferenceRules,
  commandReplay,
  elements,
  fieldText,
  initialStatus,
  nextNumber,
  pathText,
  recordOccurrence,
  requireSeller,
} from "../save-checks.ts";
import { copySourceDto, saleBodyFromProposal } from "../views.ts";
import { replaceItems, requireCommercialInput } from "./erp_document_save.ts";

type Data = Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const without = (o: Data, ...keys: string[]) => {
  const r = { ...o };
  for (const k of keys) delete r[k];
  return r;
};

function audit(ctx: RpcContext, a: { actor: string; command: string; document: unknown; action: string; before: unknown; after: unknown }) {
  guardEffect(ctx.db, a.document); // aa_mirror_authority
  ctx.db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), a.actor, a.command, a.document, a.action, null,
    a.before === null || a.before === undefined ? null : JSON.stringify(a.before), a.after === null || a.after === undefined ? null : JSON.stringify(a.after),
    ctx.clock.next().toString(),
  );
}
const receipt = (ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) =>
  ctx.db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, actor, hash, JSON.stringify(result), ctx.clock.next().toString());

/** erp_documents.stored_rules_data(documento): o que check_preference_rules lê de um documento gravado. */
function storedRulesData(db: SqlDriver, id: string): Data {
  const d = one(db, 'SELECT body FROM "erp_documents__document" WHERE id=?', id)!;
  const body = JSON.parse(String(d.body));
  const items = db.exec('SELECT product_id, data FROM "erp_documents__item" WHERE document_id=? ORDER BY position', id).rows.map((i) => {
    const data = i.data === null ? null : JSON.parse(String(i.data));
    return { product_id: i.product_id, unit_price: fieldText(data, "unit_price"), discount_percent: fieldText(data, "discount_percent") };
  });
  return { items, seller_id: fieldText(body, "seller_id"), template: false, next_contact: fieldText(body, "next_contact") };
}

/** Novo documento a partir de outro, com os itens copiados (id novo em cada item). */
function copyDocument(ctx: RpcContext, source: Data, kind: string, status: string, body: Data, user: string, sourceProposal: string | null) {
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  insertDocument(ctx, {
    id, kind, number: nextNumber(ctx.db, kind), version: 1, status, contact_id: source.contact_id, warehouse_id: source.warehouse_id, contact_snapshot: source.contact_snapshot,
    body: JSON.stringify(body), total: source.total, source_proposal_id: sourceProposal, created_by: user, updated_by: user, created_at: now, updated_at: now,
    deleted_at: null, deleted_by: null, delete_reason: null, origin: "brufap", authority: "brufap",
  });
  for (const i of ctx.db.exec('SELECT * FROM "erp_documents__item" WHERE document_id=?', source.id).rows) {
    const itemId = crypto.randomUUID();
    const data = i.data === null ? null : { ...(JSON.parse(String(i.data)) as Data), id: itemId };
    insertItem(ctx, {
      id: itemId, document_id: id, position: i.position, product_id: i.product_id, product_snapshot: i.product_snapshot, quantity: i.quantity, unit_price: i.unit_price,
      discount_percent: i.discount_percent, total: i.total, data: data === null ? null : JSON.stringify(data),
    });
  }
  return id;
}

/** As regras comuns das duas conversões da proposta. */
function proposalSource(ctx: RpcContext, user: string, id: string, expected: number, target: string) {
  const db = ctx.db;
  const s = one(db, `SELECT * FROM "erp_documents__document" WHERE id=? AND kind='sales_proposals'`, id);
  if (!s) raise("P0002", "erp_document_not_found");
  // 267: documento de contato que o usuário não vê não existe para ele.
  if (!contactUsable(db, user, s.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (s.version !== expected || s.version === 2147483647) raise("40001", "erp_document_version_conflict");
  if (one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE source_proposal_id=? LIMIT 1', id)) raise("40001", "erp_proposal_already_converted");
  const body = JSON.parse(String(s.body)) as Data;
  if (["cancelled", "completed"].includes(String(s.status)) || fieldText(body, "template") === "true") raise("22023", "erp_proposal_not_approved");
  // 270: proposta com Outros itens se converte pelo documento preenchido (o item livre guarda o total).
  const other = pathText(body, ["other_items", "total"]);
  if (other !== null && toScaled(decText(other, 30, false), 30) > 0n) raise("22023", "erp_proposal_other_items");
  checkPreferenceRules(db, target, storedRulesData(db, id));
  return { s, body };
}

function convertProposal(ctx: RpcContext, a: RpcArgs, target: "sales_orders" | "service_orders") {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  requireVisible(db, user, id, true);
  requireAccess(db, user, "sales_proposals", true);
  requireAccess(db, user, target, true);
  if (id === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  const op = target === "sales_orders" ? "convert" : "convert_to_service";
  const hash = sha256(jsonbText({ op, actor: user, id, version: expected }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const { s, body } = proposalSource(ctx, user, id, expected, target);
  const before = documentDto(ctx, id);
  const newBody = target === "sales_orders" ? (saleBodyFromProposal(db, body) as Data) : { ...without(body, "other_items", "commercial_conditions"), template: false };
  const created = copyDocument(ctx, s, target, target === "sales_orders" ? initialStatus("sales_orders") : "open", newBody, user, id);
  updateDocument(ctx, id, { status: "completed", version: Number(s.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
  recordOccurrence(ctx, { document: id, actor: user, command: command!, version: Number(s.version) + 1, before: s.status, after: "completed", text: null });
  const result = {
    proposal: documentDto(ctx, id), [target === "sales_orders" ? "sale" : "service_order"]: documentDto(ctx, created), replayed: false, data_mode: "erp_native", operational_effects: false,
  };
  audit(ctx, { actor: user, command: command!, document: id, action: target === "sales_orders" ? "convert_to_sale" : "convert_to_service", before, after: documentDto(ctx, id) });
  audit(ctx, { actor: user, command: command!, document: created, action: "create_from_proposal", before: null, after: documentDto(ctx, created) });
  receipt(ctx, command!, user, hash, result);
  return result;
}

export const erpProposalConvert = (ctx: RpcContext, a: RpcArgs) => convertProposal(ctx, a, "sales_orders");
export const erpProposalConvertToService = (ctx: RpcContext, a: RpcArgs) => convertProposal(ctx, a, "service_orders");

/** erp_documents.order_invoice(pedido): a nota mais recente do pedido, ou null. */
function orderInvoice(db: SqlDriver, id: string) {
  return one(
    db,
    'SELECT n.id FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id WHERE o.document_id=? AND n.deleted_at IS NULL LIMIT 1',
    id,
  )
    ? true
    : null;
}

export function erpSalesOrderConvertToService(ctx: RpcContext, a: RpcArgs) {
  if (ctx.workEnabled) raise("work_required", "Crie o trabalho para gerar sua parte comercial.");
  linkedDocumentGuard(ctx.db, a.p_id);
  linkedDocumentGuard(ctx.db, a.p_document_id);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  requireVisible(db, user, id, true);
  requireAccess(db, user, "sales_orders", true);
  requireAccess(db, user, "service_orders", true);
  if (id === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "sales_to_service", actor: user, id, version: expected }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const s = one(db, `SELECT * FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, id);
  if (!s) raise("P0002", "erp_document_not_found");
  if (!contactUsable(db, user, s.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (s.version !== expected) raise("40001", "erp_document_version_conflict");
  if (one(db, 'SELECT 1 x FROM "erp_documents__sales_service_link" WHERE sales_order_id=? LIMIT 1', id)) raise("40001", "erp_sales_order_already_converted");
  if (s.status === "cancelled" || orderInvoice(db, id) !== null) raise("22023", "erp_sales_order_not_convertible");
  checkPreferenceRules(db, "service_orders", storedRulesData(db, id));
  const body = JSON.parse(String(s.body)) as Data;
  const created = copyDocument(ctx, s, "service_orders", "open", { ...without(body, "ship_date", "customer_po_number", "delivery_address", "payment_means", "payment_indicator"), template: false }, user, null);
  db.exec(
    'INSERT INTO "erp_documents__sales_service_link"(sales_order_id, service_order_id, actor, command_id, created_at) VALUES(?,?,?,?,?)',
    id, created, user, command, ctx.clock.next().toString(),
  );
  const number = one(db, 'SELECT number FROM "erp_documents__document" WHERE id=?', created)!.number;
  recordOccurrence(ctx, {
    document: id, actor: user, command: command!, version: Number(s.version), before: s.status, after: null,
    text: number === null ? null : `Ordem de serviço ${String(number)} gerada a partir deste pedido`,
  });
  const result = { sale: documentDto(ctx, id), service_order: documentDto(ctx, created), replayed: false, data_mode: "erp_native", operational_effects: false };
  audit(ctx, {
    actor: user, command: command!, document: created, action: "create_from_sales_order",
    before: { sales_order_id: id, sales_order_number: s.number === null ? null : String(s.number) }, after: documentDto(ctx, created),
  });
  receipt(ctx, command!, user, hash, result);
  return result;
}

/** erp_documents.check_seller_rules: as regras do vendedor na cópia (sem a situação de aprovação). */
function checkSellerRules(db: SqlDriver, user: string, kind: string, data: Data) {
  if (!["sales_orders", "sales_proposals", "service_orders"].includes(kind)) return;
  const s = one(db, 'SELECT allow_unregistered_products, discount_limit FROM "erp_catalog__seller" WHERE user_id=?', user);
  if (!s) return;
  const list = elements(data.items ?? null);
  if (kind === "sales_orders" && Number(s.allow_unregistered_products) !== 1 && list.some((i) => fieldText(i, "product_id") === null))
    raise("22023", "erp_document_seller_product_required");
  const limit = BigInt(String(s.discount_limit)) * 10n ** 26n;
  if (limit > 0n) {
    const num = (t: string | null) => (t === null ? null : toScaled(decText(t, 30, false), 30));
    const gross = num(pathText(data, ["totals", "gross"]));
    const ld = num(pathText(data, ["totals", "line_discount"])),
      dd = num(pathText(data, ["totals", "discount"]));
    const v = ld === null || dd === null ? null : ld + dd;
    if (
      list.some((i) => {
        const d = num(fieldText(i, "discount_percent"));
        return d !== null && d > limit;
      }) ||
      (gross !== null && v !== null && gross > 0n && v * 100n * 10n ** 30n > limit * gross)
    )
      raise("22023", "erp_document_seller_discount_limit");
  }
}

export function erpDocumentCopy(ctx: RpcContext, a: RpcArgs) {
  linkedDocumentGuard(ctx.db, a.p_source_id);
  linkedDocumentGuard(ctx.db, a.p_id);
  linkedDocumentGuard(ctx.db, a.p_document_id);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const sourceId = (a.p_source_id as string | null) ?? null;
  const expected = (a.p_expected_source_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const body = a.p_body === undefined ? null : jsonbArg(a.p_body);
  requireVisible(db, user, sourceId, true);
  requireAccess(db, user, kind, false);
  requireAccess(db, user, kind, true);
  if (sourceId === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  if (body === null || jsonType(body) !== "object" || Buffer.byteLength(jsonbText(body), "utf8") > 262144) raise("22023", "erp_document_body_invalid");
  const hash = sha256(jsonbText({ op: "copy_document", actor: user, kind, source: sourceId, source_version: expected, body }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const s = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', sourceId, kind);
  if (!s) raise("P0002", "erp_document_not_found");
  if (!contactUsable(db, user, s.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  if (s.version !== expected) raise("40001", "erp_document_version_conflict");
  const data = normalize(kind, body) as Data;
  requireCommercialInput(documentDto(ctx, sourceId)!, body as Data);
  checkPreferenceRules(db, kind!, data);
  checkSellerRules(db, user, kind!, data);
  requireSeller(db, fieldText(data, "seller_id"));
  checkLinks(db, kind!, data, null);
  if (kind === "service_orders") checkCustomFieldsFor(db, kind, data);
  checkPaymentLinks(db, kind!, data, null);
  checkCreditLimit(db, user, kind!, data, null);
  const contact = fieldText(data, "contact_id"),
    warehouse = fieldText(data, "warehouse_id");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.active=1', contact)) raise("22023", "erp_document_contact_unavailable");
  const snapshot = catalogDto(db, contact!);
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=? AND r.active=1', warehouse))
    raise("22023", "erp_document_warehouse_unavailable");
  for (const i of elements(data.items ?? null)) {
    const p = fieldText(i, "product_id");
    if (p !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=? AND r.active=1', p))
      raise("22023", "erp_document_product_unavailable");
  }
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  const total = pathText(data, ["totals", "total"]);
  insertDocument(ctx, {
    id, kind, number: nextNumber(db, kind!), version: 1, status: initialStatus(kind!), contact_id: contact, warehouse_id: warehouse,
    contact_snapshot: snapshot === null ? null : JSON.stringify(snapshot), body: JSON.stringify(without(data, "items")),
    total: total === null ? null : toScaled(decText(total, 30, false), 2).toString(), source_proposal_id: null, created_by: user, updated_by: user, created_at: now, updated_at: now,
    deleted_at: null, deleted_by: null, delete_reason: null, origin: "brufap", authority: "brufap",
  });
  replaceItems(ctx, id, elements(data.items ?? null).map((v) => ({ ...(v as Data), id: null })));
  db.exec(
    'INSERT INTO "erp_documents__copy_source"(destination_id, source_id, source_kind, source_number, source_version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, sourceId, kind, s.number, expected, user, command, ctx.clock.next().toString(),
  );
  const result = { kind, document: documentDto(ctx, id), copy_source: copySourceDto(db, id), replayed: false, data_mode: "erp_native", operational_effects: false };
  audit(ctx, { actor: user, command: command!, document: id, action: "create_from_copy", before: { copy_source: copySourceDto(db, id) }, after: documentDto(ctx, id) });
  receipt(ctx, command!, user, hash, result);
  return result;
}

/** O check_custom_fields do fim do check_links (OS), sem documento anterior. */
const checkCustomFieldsFor = (db: SqlDriver, kind: string, data: Data) => checkCustomFields(db, kind, data.custom_fields, undefined);

registerRpc("erp_proposal_convert", erpProposalConvert);
registerRpc("erp_proposal_convert_to_service", erpProposalConvertToService);
registerRpc("erp_sales_order_convert_to_service", erpSalesOrderConvertToService);
registerRpc("erp_document_copy", erpDocumentCopy);
