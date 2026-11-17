// Leituras de configuração do Documentos (sessão L, bloco B0): categorias,
// campos customizados, colunas da listagem, numeração, cabeçalho de
// impressão, assinatura, formas de pagamento, códigos do fornecedor, lote dos
// produtos e aprovação de desconto. Portado de public.erp_document_* com os
// mesmos nomes; os ajudantes da O vêm de ../internal.ts, as visões
// compartilhadas de ../views.ts.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgLeft, pgLower } from "../../../engine/text.ts";
import { approvalSituations } from "../internal.ts";
import { requireAccess } from "../public.ts";
import { customFieldItem, listViewDto, numberingDto, printHeaderView, signatureView } from "../views.ts";
import { bool, by, cmpTextArray, cmpUuid, isAdmin, validIdList } from "./reads-common.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;

/** public.erp_document_categories(p_user_id, p_kind): árvore de categorias financeiras do tipo do documento. */
export function erpDocumentCategories(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind);
  requireAccess(ctx.db, user, kind, false);
  if (kind !== null && !["sales_orders", "purchase_orders", "service_orders"].includes(kind)) raise("22023", "erp_document_category_invalid");
  const catKind = kind === "purchase_orders" ? "payable" : "receivable";
  const rows = ctx.db.exec('SELECT id, parent_id, name, active, deleted_at FROM "erp_finance__category" WHERE kind=?', catKind).rows;
  type Node = { id: string; parent_id: string | null; name: string; path: string[]; depth: number; visible: boolean };
  const tree: Node[] = [];
  const walk = (parent: Node | null) => {
    if (parent && parent.depth >= 5) return;
    for (const c of rows.filter((r) => (parent ? r.parent_id === parent.id : r.parent_id === null))) {
      const n: Node = {
        id: String(c.id),
        parent_id: str(c.parent_id),
        name: String(c.name),
        path: [...(parent?.path ?? []), pgLower(String(c.name)), String(c.id)],
        depth: (parent?.depth ?? 0) + 1,
        visible: bool(c.active) && c.deleted_at === null,
      };
      tree.push(n);
      walk(n);
    }
  };
  walk(null);
  const shown = tree.filter((n) => n.visible).sort((x, y) => cmpTextArray(x.path, y.path));
  const key = kind === "sales_orders" ? "sale" : kind === "service_orders" ? "service" : "purchase";
  const d = one(
    ctx.db,
    `SELECT c.id, c.name FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id
      WHERE d.key=? AND c.active=1 AND c.deleted_at IS NULL AND c.kind=?`,
    key,
    catKind,
  );
  return {
    kind,
    category_kind: catKind,
    items: shown.slice(0, 500).map((s) => ({ id: s.id, name: pgLeft(s.name, 200), parent_id: s.parent_id, depth: s.depth })),
    total_count: shown.length,
    default: d ? { id: d.id, name: pgLeft(String(d.name), 200) } : null,
    ...NATIVE,
  };
}

/** public.erp_document_custom_fields(p_user_id, p_kind): campos customizados da ordem de serviço. */
export function erpDocumentCustomFields(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind);
  if (kind !== "service_orders") raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, false);
  const admin = isAdmin(ctx.db, user);
  const fields = ctx.db
    .exec('SELECT id, name FROM "erp_documents__custom_field" WHERE kind=?', kind)
    .rows.sort(by<Row>((x, y) => pgCompareText(pgLower(String(x.name)), pgLower(String(y.name))), (x, y) => cmpUuid(x.id, y.id)));
  return { kind, can_manage: admin, items: fields.map((f) => customFieldItem(ctx.db, String(f.id), admin)), ...NATIVE };
}

/** public.erp_document_list_view_get(p_user_id, p_kind) */
export function erpDocumentListViewGet(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind);
  requireAccess(ctx.db, user, kind, false);
  if (kind !== null && !["sales_proposals", "sales_orders", "service_orders"].includes(kind)) raise("22023", "erp_document_query_invalid");
  return listViewDto(ctx.db, user, kind);
}

/** public.erp_document_next_number(p_user_id, p_kind) */
export function erpDocumentNextNumber(ctx: RpcContext, a: RpcArgs) {
  const kind = str(a.p_kind);
  requireAccess(ctx.db, str(a.p_user_id), kind, true);
  const v = numberingDto(ctx.db, kind);
  if (v === null) raise("22023", "erp_document_query_invalid");
  return v;
}

/** public.erp_document_print_header(p_user_id, p_kind) */
export function erpDocumentPrintHeader(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind);
  requireAccess(ctx.db, user, kind, false);
  return printHeaderView(ctx.db, kind, user);
}

/** public.erp_document_signature(p_user_id) */
export function erpDocumentSignature(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id);
  requireAccess(ctx.db, user, "sales_proposals", false);
  return signatureView(ctx.db, user);
}

/** public.erp_document_payment_options(p_user_id, p_kind): formas de pagamento e contas para o documento. */
export function erpDocumentPaymentOptions(ctx: RpcContext, a: RpcArgs) {
  const kind = str(a.p_kind);
  requireAccess(ctx.db, str(a.p_user_id), kind, true);
  const applicable = kind === "purchase_orders" ? "pagamentos" : "recebimentos";
  const methods = ctx.db
    .exec(
      `SELECT id, description, payment_type, condition, destination, account_id, card_brand, card_integration, card_cnpj, is_default
         FROM "erp_catalog__payment_method" WHERE active=1 AND deleted_at IS NULL AND applicable IN ('ambos', ?)`,
      applicable,
    )
    .rows.sort(
      by<Row>(
        (x, y) => Number(bool(y.is_default)) - Number(bool(x.is_default)),
        (x, y) => pgCompareText(pgLower(String(x.description)), pgLower(String(y.description))),
        (x, y) => cmpUuid(x.id, y.id),
      ),
    )
    .slice(0, 200)
    .map((f) => ({
      id: f.id,
      description: pgLeft(String(f.description), 100),
      payment_type: f.payment_type,
      condition: f.condition,
      destination: f.destination,
      account_id: f.destination === "caixa" ? f.account_id : null,
      card_brand: f.card_brand,
      card_integration: f.card_integration,
      card_cnpj: f.card_cnpj,
      is_default: bool(f.is_default),
    }));
  const accounts =
    kind === "sales_proposals"
      ? []
      : ctx.db
          .exec('SELECT id, name, kind FROM "erp_finance__account" WHERE active=1')
          .rows.sort(by<Row>((x, y) => pgCompareText(pgLower(String(x.name)), pgLower(String(y.name))), (x, y) => cmpUuid(x.id, y.id)))
          .slice(0, 200)
          .map((c) => ({ id: c.id, name: pgLeft(String(c.name), 200), kind: c.kind }));
  return { kind, methods, accounts, ...NATIVE };
}

/** public.erp_document_supplier_codes(p_user_id, p_contact_id, p_product_ids): código do produto no fornecedor. */
export function erpDocumentSupplierCodes(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, str(a.p_user_id), "purchase_orders", false);
  const contact = str(a.p_contact_id),
    ids = a.p_product_ids;
  if (contact === null || ids === null || ids === undefined || !validIdList(ids)) raise("22023", "erp_document_query_invalid");
  const wanted = new Set(ids as string[]);
  const items = ctx.db
    .exec('SELECT record_id, code FROM "erp_catalog__product_supplier" WHERE supplier_id=?', contact)
    .rows.filter((s) => wanted.has(String(s.record_id)) && s.code !== null && pgBtrim(String(s.code)) !== "")
    .sort((x, y) => cmpUuid(x.record_id, y.record_id))
    .map((s) => ({ product_id: s.record_id, code: s.code }));
  return { contact_id: contact, items, ...NATIVE };
}

/** public.erp_document_lot_products(p_user_id, p_kind, p_product_ids): quais produtos controlam lote. */
export function erpDocumentLotProducts(ctx: RpcContext, a: RpcArgs) {
  const kind = str(a.p_kind),
    ids = a.p_product_ids;
  if (kind === null || !["sales_orders", "service_orders"].includes(kind) || ids === null || ids === undefined || !validIdList(ids))
    raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, str(a.p_user_id), kind, false);
  const wanted = new Set(ids as string[]);
  const items = ctx.db
    .exec('SELECT p.record_id, d.lot_control FROM "erp_catalog__product" p LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=p.record_id')
    .rows.filter((p) => wanted.has(String(p.record_id)))
    .sort((x, y) => cmpUuid(x.record_id, y.record_id))
    .map((p) => ({ product_id: p.record_id, lot_control: bool(p.lot_control) }));
  return { kind, items, ...NATIVE };
}

/** public.erp_document_discount_approval(p_user_id): situações que pedem aprovação de desconto. */
export function erpDocumentDiscountApproval(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id);
  requireAccess(ctx.db, user, "sales_orders", false);
  const s = one(ctx.db, 'SELECT version FROM "erp_documents__discount_approval" WHERE singleton=1');
  const situations = approvalSituations(ctx.db)
    .map((id) => one(ctx.db, 'SELECT id, name, color, active FROM "erp_preferences__situation" WHERE id=?', id))
    .filter((r): r is Row => r !== null)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, active: bool(r.active) }));
  return { kind: "sales_orders", version: s ? Number(s.version) : null, can_write: isAdmin(ctx.db, user), situations, ...NATIVE };
}

registerRpc("erp_document_categories", erpDocumentCategories);
registerRpc("erp_document_custom_fields", erpDocumentCustomFields);
registerRpc("erp_document_list_view_get", erpDocumentListViewGet);
registerRpc("erp_document_next_number", erpDocumentNextNumber);
registerRpc("erp_document_print_header", erpDocumentPrintHeader);
registerRpc("erp_document_signature", erpDocumentSignature);
registerRpc("erp_document_payment_options", erpDocumentPaymentOptions);
registerRpc("erp_document_supplier_codes", erpDocumentSupplierCodes);
registerRpc("erp_document_lot_products", erpDocumentLotProducts);
registerRpc("erp_document_discount_approval", erpDocumentDiscountApproval);
