// Guarda das lojas nos RPCs de sempre (engine/registry.ts, registerRpcGuard).
// Só age com duas lojas ativas ou mais; com uma loja, nem lê as tabelas além
// da contagem. Faz três coisas:
// 1. recusa a pessoa limitada que opera em loja alheia (erp_store_denied):
//    documento, depósito, conta financeira (caixa) e conta a pagar/receber;
// 2. documento novo sem depósito recebe o depósito padrão da loja em uso da
//    pessoa (com Estoque ligado), como se ela o tivesse escolhido;
// 3. o documento e a conta a pagar/receber criados na gravação ganham o
//    vínculo com a loja na mesma transação (depósito, caixa, documento de
//    origem ou a loja padrão da pessoa), para não mudarem de loja depois.
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { registerRpcGuard, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import {
  STORE, STORE_DOCUMENT, STORE_TITLE, StoreResolver, allowedStores, defaultStore, multiStore, storeAllowed,
} from "./public.ts";

type Obj = Record<string, unknown>;
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
export const denied = (): never => raise("42501", "erp_store_denied");

/** Tipos de documento que levam loja (pedido de venda, proposta e compra; a ordem de serviço também, pelo depósito). */
const STORE_KINDS = ["sales_orders", "sales_proposals", "purchase_orders", "service_orders"];

function defaultWarehouse(ctx: RpcContext, user: string | null): string | null {
  const store = defaultStore(ctx, user);
  if (!store) return null;
  const w = one(ctx.db, `SELECT s.default_warehouse_id w FROM "${STORE}" s JOIN "erp_catalog__record" r ON r.id=s.default_warehouse_id AND r.active=1 WHERE s.id=?`, store)?.w;
  return (w as string | undefined) ?? null;
}

function check(ctx: RpcContext, name: string, a: RpcArgs, user: string | null) {
  const allowed = allowedStores(ctx, user);
  const r = new StoreResolver(ctx.db);
  const need = (store: string | null) => { if (!storeAllowed(allowed, store)) denied(); };
  const documentId = str(a.p_document_id) ?? (name.startsWith("erp_document_") ? str(a.p_id) : null);
  const writes = a.p_command_id !== undefined;

  // Documento de outra loja não existe para quem não a vê (ler) e não se mexe (gravar).
  if (documentId && one(ctx.db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=?', documentId) && !storeAllowed(allowed, r.document(documentId))) {
    if (!writes && name === "erp_document_get") raise("P0002", "erp_document_not_found");
    if (writes) denied();
  }
  if (name === "erp_document_save") {
    const body = obj(parse(a.p_body));
    if (body && str(body.warehouse_id)) need(r.warehouse(body.warehouse_id));
    const kind = str(a.p_kind);
    if (body && a.p_id == null && kind && STORE_KINDS.includes(kind) && body.warehouse_id === undefined && ctx.parts.stock) {
      const w = defaultWarehouse(ctx, user);
      if (w) a.p_body = { ...body, warehouse_id: w };
    }
  }
  if (name === "erp_pos_sale_execute") {
    const data = obj(parse(a.p_data));
    if (data) {
      if (str(data.account_id)) need(r.account(data.account_id));
      const doc = obj(data.document);
      if (doc && str(doc.warehouse_id)) need(r.warehouse(doc.warehouse_id));
      if (doc && doc.warehouse_id === undefined && ctx.parts.stock) {
        // O depósito da loja do caixa; sem ele, o da loja em uso da pessoa.
        const store = str(data.account_id) ? r.account(data.account_id) : null;
        const fromStore = store ? one(ctx.db, `SELECT s.default_warehouse_id w FROM "${STORE}" s JOIN "erp_catalog__record" r ON r.id=s.default_warehouse_id AND r.active=1 WHERE s.id=?`, store)?.w as string | undefined : undefined;
        const w = fromStore ?? defaultWarehouse(ctx, user);
        if (w) a.p_data = { ...data, document: { ...doc, warehouse_id: w } };
      }
    }
  }
  if (name === "erp_stock_post" || name === "erp_stock_launch" || name === "erp_stock_lot_launch") {
    const items = parse(a.p_items);
    if (Array.isArray(items)) for (const i of items) { const w = obj(i)?.warehouse_id; if (str(w)) need(r.warehouse(w)); }
    const data = obj(parse(a.p_data));
    if (data && str(data.warehouse_id)) need(r.warehouse(data.warehouse_id));
  }
  // Transferência entre lojas: a pessoa manda do depósito de uma loja dela para qualquer loja.
  if (name === "erp_stock_transfer_batch" && str(a.p_source_id)) need(r.warehouse(a.p_source_id));
  if (/^erp_finance_(title|cash|cash_session|account|transfer)_?/.test(name) && writes) {
    const data = obj(parse(a.p_data));
    if (data) {
      if (str(data.account_id)) need(r.account(data.account_id));
      if (name === "erp_finance_title_execute" && str(data.id)) need(r.title(data.id));
      if (name === "erp_finance_account_execute" && str(data.id)) need(r.account(data.id));
    }
  }
}

const maxRowid = (ctx: RpcContext, table: string) => Number(one(ctx.db, `SELECT coalesce(max(rowid), 0) n FROM "${table}"`)?.n ?? 0);

/** Depois do corpo: vincula à loja o que a gravação criou. */
function linker(ctx: RpcContext, user: string | null) {
  const docs = maxRowid(ctx, "erp_documents__document"), titles = maxRowid(ctx, "erp_finance__title");
  return () => {
    const db = ctx.db;
    const fresh = (table: string, from: number, cols: string) => db.exec(`SELECT ${cols} FROM "${table}" WHERE rowid > ?`, from).rows;
    const newDocs = fresh("erp_documents__document", docs, "id, warehouse_id");
    const newTitles = fresh("erp_finance__title", titles, "id, group_id, account_id");
    if (!newDocs.length && !newTitles.length) return;
    const r = new StoreResolver(db);
    const fallback = defaultStore(ctx, user) ?? r.main;
    const at = ctx.clock.next().toString();
    const actor = user ?? "system";
    for (const d of newDocs) {
      if (one(db, `SELECT 1 x FROM "${STORE_DOCUMENT}" WHERE document_id=?`, d.id)) continue;
      const sale = one(db, 'SELECT account_id FROM "erp_pos__sale" WHERE document_id=? LIMIT 1', d.id);
      const [store, source] = sale ? [r.account(sale.account_id), "account"] : d.warehouse_id ? [r.warehouse(d.warehouse_id), "warehouse"] : [fallback, "default"];
      if (store) db.exec(`INSERT INTO "${STORE_DOCUMENT}"(document_id, store_id, source, updated_by, updated_at) VALUES(?,?,?,?,?)`, d.id, store, source, actor, at);
    }
    for (const t of newTitles) {
      if (one(db, `SELECT 1 x FROM "${STORE_TITLE}" WHERE title_id=?`, t.id)) continue;
      const doc = typeof t.group_id === "string" ? one(db, 'SELECT document_id FROM "erp_finance__document_posting" WHERE group_id=? LIMIT 1', t.group_id)?.document_id : undefined;
      const sale = one(db, 'SELECT s.account_id FROM "erp_pos__sale_payment" p JOIN "erp_pos__sale" s ON s.id=p.sale_id WHERE p.title_id=? LIMIT 1', t.id);
      const [store, source] = typeof doc === "string" ? [r.document(doc), "document"] : sale ? [r.account(sale.account_id), "account"]
        : t.account_id ? [r.account(t.account_id), "account"] : [fallback, "default"];
      if (store) db.exec(`INSERT INTO "${STORE_TITLE}"(title_id, store_id, source, updated_by, updated_at) VALUES(?,?,?,?,?)`, t.id, store, source, actor, at);
    }
  };
}

/** A guarda registrada: nada com uma loja só; RPCs das próprias lojas se cuidam sozinhos. */
export function storeGuard(ctx: RpcContext, name: string, a: RpcArgs) {
  if (name.startsWith("erp_store_")) return;
  if (!multiStore(ctx.db)) return;
  const user = str(a.p_user_id);
  check(ctx, name, a, user);
  if (a.p_command_id !== undefined) return linker(ctx, user);
}

registerRpcGuard(storeGuard);
