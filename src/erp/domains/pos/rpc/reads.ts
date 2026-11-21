// PDV, bloco P1 (sessão L): as leituras da frente de caixa. public.erp_pos_context,
// erp_pos_favorites, erp_pos_order, erp_pos_sales, erp_pos_sale_get e
// erp_pos_cash_summary (migrações 204 a 206, 242, 267, 289 e 292; versões
// finais no oráculo). Rotas só no bloco erp-pdv (src/erp/blocks.ts).
import { intIn } from "../../../engine/args.ts";
import { one, type Row } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp, saoPauloParts } from "../../../engine/time.ts";
import { actorLabel } from "../../access/public.ts";
import { storeFilter } from "../../stores/public.ts";
import { get as preference } from "../../preferences/public.ts";
import {
  access,
  arrowText,
  bool,
  by,
  certificateState,
  cmpInt,
  cmpLower,
  cmpText,
  dec,
  decAdd,
  decCmp,
  decColumn,
  decDiv,
  decFixed,
  decMul,
  decRound,
  type Dec,
  json,
  jsonbHas,
  left,
  num,
  prefFlag,
  returned,
  returnsView,
  saleView,
  today,
  usableSession,
  type Json,
} from "../internal.ts";

const str = (a: RpcArgs, k: string) => (a[k] === null || a[k] === undefined ? null : String(a[k]));
/** valor da preferência #>> '{}' */
const prefText = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v));

/** public.erp_pos_context(p_user_id): o que a tela da frente de caixa precisa ao abrir. */
function erpPosContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a, "p_user_id");
  const acc = access(db, user, false);
  const role = acc.role;
  const unique = jsonbHas(preference(db, "pdv.usuarios_caixa_unico") ?? [], user!);
  const st = one(db, 'SELECT * FROM "erp_pos__settings" WHERE singleton=1');
  const { role: _r, seller_id: _s, ...permissions } = acc;
  const fontText = prefText(preference(db, "vendas.comprovante_fonte"));
  const free = preference(db, "vendas.produtos_nao_cadastrados");

  const top = <T extends Row>(rows: T[], limit: number, cmp: (a: T, b: T) => number) => rows.sort(cmp).slice(0, limit);
  const byName = by<Row>((x, y) => cmpLower(x.name, y.name), (x, y) => cmpText(x.id, y.id));
  // A subconsulta ordena e corta pelo nome inteiro; o jsonb_agg ordena de novo pelo nome cortado em 200.
  const named = (rows: Row[], limit: number, extra: (r: Row) => Json = () => ({})) =>
    top(rows, limit, byName)
      .map((r) => ({ id: r.id, name: left(r.name, 200), ...extra(r) }))
      .sort(byName);

  // Lojas (versão 27): com duas lojas ou mais, só os caixas e as sessões das lojas que a pessoa vê (ou da loja em uso).
  const inStore = storeFilter(ctx, user);
  const stores = named(db.exec(`SELECT id, name FROM "erp_finance__account" WHERE kind='cash' AND active=1 AND deleted_at IS NULL`).rows
    .filter((r) => inStore === null || inStore.account(r.id)), 100);
  const accounts = named(db.exec(`SELECT id, name, kind FROM "erp_finance__account" WHERE active=1 AND deleted_at IS NULL`).rows, 200, (r) => ({ kind: r.kind }));
  const sessions = db
    .exec(
      `SELECT c.*, CAST(c.opened_at AS TEXT) opened_at, CAST(c.change_cents AS TEXT) change_cents, a.name account_name
       FROM "erp_finance__cash_session" c JOIN "erp_finance__account" a ON a.id=c.account_id WHERE c.state='open' AND c.deleted_at IS NULL`,
    )
    .rows.filter((c) => usableSession(db, user!, c) && (inStore === null || inStore.account(c.account_id)))
    .sort(by<Row>((x, y) => cmpLower(x.account_name, y.account_name), (x, y) => cmpInt(x.opened_at, y.opened_at), (x, y) => cmpText(x.id, y.id)))
    .map((c) => ({
      id: c.id,
      account_id: c.account_id,
      account_name: left(c.account_name, 200),
      operator_id: c.operator_id,
      operator_name: actorLabel(db, String(c.operator_id)),
      opened_at: jsonTimestamp(String(c.opened_at)),
      opened_on: c.opened_on,
      change_cents: c.change_cents,
      version: num(c.version),
      own: c.operator_id === user,
    }));
  const methodOrder = by<Row>((x, y) => Number(bool(y.is_default)) - Number(bool(x.is_default)), (x, y) => cmpLower(x.description, y.description), (x, y) => cmpText(x.id, y.id));
  const methods = top(
    db.exec(`SELECT * FROM "erp_catalog__payment_method" WHERE active=1 AND deleted_at IS NULL AND applicable IN ('recebimentos','ambos')`).rows,
    200,
    methodOrder,
  ).map((m) => ({
    id: m.id,
    description: m.description,
    payment_type: m.payment_type,
    destination: m.destination,
    account_id: m.account_id,
    condition: m.condition,
    is_default: bool(m.is_default),
  }));
  const warehouses = named(
    db.exec(`SELECT r.id, r.name FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.active=1`).rows,
    100,
  );
  const dw = one(
    db,
    `SELECT r.id, r.name FROM "erp_stock__warehouse_default" x JOIN "erp_catalog__record" r ON r.id=x.warehouse_id WHERE r.active=1`,
  );
  const seller = one(db, `SELECT x.id, r.name FROM "erp_catalog__seller" x JOIN "erp_catalog__record" r ON r.id=x.contact_id WHERE x.user_id=?`, user);
  const consumer =
    st?.consumer_contact_id == null ? undefined : one(db, 'SELECT id, name, active FROM "erp_catalog__record" WHERE id=?', st.consumer_contact_id);
  return {
    entity: "pos_context",
    data_mode: "erp_native",
    today: today(ctx),
    role,
    permissions,
    effects: {
      stock: ["admin", "estoque"].includes(role),
      finance: ["admin", "financeiro"].includes(role),
      cash: ["admin", "financeiro"].includes(role),
      fiscal: ["admin", "fiscal"].includes(role),
      settings: role === "admin",
      contacts: ["admin", "vendas", "financeiro"].includes(role),
    },
    settings: {
      tables: prefFlag(db, "pdv.controle_mesas"),
      cash_control: prefFlag(db, "pdv.controle_caixa"),
      cash_check_methods: prefFlag(db, "pdv.dinheiro_cheque"),
      unique_cash: unique,
      default_operation: prefText(preference(db, "pdv.operacao_padrao")) ?? "nenhum",
      default_method: prefText(preference(db, "pdv.metodo_pagamento")) ?? "nenhum",
      receipt_order: prefText(preference(db, "pdv.ordem_comprovante")) ?? "insercao",
      percent_discount: prefFlag(db, "pdv.desconto_percentual"),
      closing_statuses: preference(db, "pdv.situacoes_fechamento") ?? ["atendido", "verificado"],
      negative_stock: prefFlag(db, "pdv.estoque_negativo"),
      block_zero: prefFlag(db, "pdv.bloquear_quantidade_zero"),
      item_discount: prefFlag(db, "pdv.desconto_item"),
      group_items: prefFlag(db, "pdv.agrupar_itens"),
      shortcuts: preference(db, "pdv.teclas_atalho"),
      sales_negative_stock: prefFlag(db, "vendas.estoque_negativo"),
      // coalesce(get(…) <> 'false', true)
      free_items: free === null ? true : free !== false,
      seller_required: prefFlag(db, "vendas.vendedor_obrigatorio"),
    },
    receipt: {
      limit_description: prefFlag(db, "vendas.comprovante_limitar_descricao"),
      code: prefFlag(db, "vendas.comprovante_codigo"),
      notes: prefFlag(db, "vendas.comprovante_observacao"),
      comments: prefFlag(db, "vendas.comprovante_comentario"),
      discount: prefFlag(db, "vendas.comprovante_desconto"),
      footer: pgBtrim(prefText(preference(db, "vendas.comprovante_rodape")) ?? "") || null,
      font_size: fontText === null ? 12 : Number(intIn(fontText, "integer")),
    },
    stores,
    accounts,
    cash_sessions: sessions,
    methods,
    warehouses,
    default_warehouse: dw ? { id: dw.id, name: left(dw.name, 200) } : null,
    seller: seller ? { id: seller.id, name: left(seller.name, 200) } : null,
    consumer: consumer ? { id: consumer.id, name: left(consumer.name, 200), active: bool(consumer.active) } : null,
    pix:
      st == null || st.pix_key === null
        ? null
        : { key_type: st.pix_key_type, key: st.pix_key, merchant_name: st.pix_merchant_name, merchant_city: st.pix_merchant_city },
    certificate: certificateState(),
    settings_version: st == null ? null : num(st.version),
  };
}

/** public.erp_pos_favorites(p_user_id, p_warehouse_id): os produtos favoritos, com o saldo. */
function erpPosFavorites(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, str(a, "p_user_id"), false);
  const warehouse = str(a, "p_warehouse_id");
  const rows = db
    .exec(
      `SELECT r.id, r.name, r.code, r.active, p.unit, p.price, p.gtin, p.kind FROM "erp_pos__favorite" f
       JOIN "erp_catalog__record" r ON r.id=f.product_id JOIN "erp_catalog__product" p ON p.record_id=r.id`,
    )
    .rows.sort(by<Row>((x, y) => cmpLower(x.name, y.name), (x, y) => cmpText(x.id, y.id)));
  const stock = (product: unknown): string | null => {
    if (warehouse === null) {
      const list = db.exec('SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product).rows;
      if (!list.length) return null;
      return decFixed(list.map((b) => decColumn(b.q, 6)).reduce(decAdd), 6);
    }
    const b = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
    return b ? decFixed(decColumn(b.q, 6), 6) : null;
  };
  return {
    entity: "pos_favorites",
    data_mode: "erp_native",
    warehouse_id: warehouse,
    items: rows.map((r) => ({
      product_id: r.id,
      name: left(r.name, 200),
      code: left(r.code, 60),
      unit: left(r.unit, 16),
      price: r.price === null ? null : String(r.price),
      gtin: left(r.gtin, 14),
      active: bool(r.active),
      kind: r.kind,
      stock: stock(r.id),
    })),
  };
}

/** public.erp_pos_order(p_user_id, p_document_id): a origem do pedido na frente de caixa (mesa ou balcão). */
function erpPosOrder(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, str(a, "p_user_id"), false);
  const document = str(a, "p_document_id");
  if (document === null) raise("22023", "erp_pos_invalid_query");
  const s = one(db, 'SELECT s.id, s.kind, s.table_number, s.state, s.account_id FROM "erp_pos__sale" s WHERE s.document_id=?', document);
  const account = s?.account_id == null ? undefined : one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', s.account_id);
  return {
    entity: "pos_order",
    data_mode: "erp_native",
    document_id: document,
    record: s ? { sale_id: s.id, kind: s.kind, table_number: num(s.table_number), state: s.state, account_name: left(account?.name, 200) } : null,
  };
}

/** public.erp_pos_sales(…): a lista de vendas (por caixa, situação, período, forma e busca). */
function erpPosSales(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, str(a, "p_user_id"), false);
  const session = str(a, "p_session");
  const state = str(a, "p_state");
  const query = str(a, "p_query");
  const from = str(a, "p_from");
  const to = str(a, "p_to");
  const method = str(a, "p_method");
  const page = a.p_page === null || a.p_page === undefined ? null : Number(a.p_page);
  const limit = a.p_limit === null || a.p_limit === undefined ? null : Number(a.p_limit);
  if (
    state === null ||
    !["all", "open", "finished", "cancelled"].includes(state) ||
    page === null ||
    page < 1 ||
    page > 10000 ||
    limit === null ||
    limit < 1 ||
    limit > 50 ||
    (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query))) ||
    (from !== null && to !== null && from > to) ||
    (from !== null && from < "1900-01-01") ||
    (to !== null && to > "2100-12-31")
  )
    raise("22023", "erp_pos_invalid_query");
  const q = query === null || pgBtrim(query) === "" ? null : pgLower(pgBtrim(query));
  // Lojas (versão 27): as vendas das lojas que a pessoa vê (ou da loja em uso).
  const inStore = storeFilter(ctx, str(a, "p_user_id"));
  const rows = db
    .exec(
      `SELECT s.id, CAST(s.created_at AS TEXT) created_at, s.cash_session_id, s.state, s.table_number, CAST(d.number AS TEXT) number, d.contact_snapshot, d.id document_id, d.warehouse_id
       FROM "erp_pos__sale" s JOIN "erp_documents__document" d ON d.id=s.document_id`,
    )
    .rows.filter((s) => {
      if (inStore !== null && !inStore.document(s.document_id, s.warehouse_id)) return false;
      if (session !== null && s.cash_session_id !== session) return false;
      if (state !== "all" && s.state !== state) return false;
      const day = saoPauloParts(BigInt(String(s.created_at))).date;
      if (from !== null && day < from) return false;
      if (to !== null && day > to) return false;
      if (method !== null && !one(db, 'SELECT 1 x FROM "erp_pos__sale_payment" WHERE sale_id=? AND payment_method_id=?', s.id, method)) return false;
      if (q !== null) {
        // d.number::text=q or strpos(lower(coalesce(snapshot->>'name','')),q)>0 or s.table_number::text=q
        const name = arrowText(json(s.contact_snapshot), "name") ?? "";
        if (s.number !== q && !pgLower(name).includes(q) && (s.table_number === null ? null : String(s.table_number)) !== q) return false;
      }
      return true;
    })
    .sort(by<Row>((x, y) => cmpInt(y.created_at, x.created_at), (x, y) => cmpText(x.id, y.id)));
  return {
    entity: "pos_sales",
    data_mode: "erp_native",
    session_id: session,
    state,
    from,
    to,
    method_id: method,
    page,
    limit,
    total: rows.length,
    items: rows.slice((page! - 1) * limit!, page! * limit!).map((s) => saleView(db, String(s.id), false)),
  };
}

/** public.erp_pos_sale_get(p_user_id, p_id): a venda com itens, pagamentos e devoluções. */
function erpPosSaleGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, str(a, "p_user_id"), false);
  const id = str(a, "p_id");
  if (id === null || !one(db, 'SELECT 1 x FROM "erp_pos__sale" WHERE id=?', id)) raise("P0002", "erp_pos_not_found");
  return {
    entity: "pos_sale",
    data_mode: "erp_native",
    record: { ...saleView(db, id!, true), returns: returnsView(db, id!), returned: returned(db, id!) },
  };
}

const STATUS: Record<string, string> = { atendido: "fulfilled", verificado: "verified" };

/** public.erp_pos_cash_summary(p_user_id, p_session): o resumo da frente de caixa no Controle de caixa. */
function erpPosCashSummary(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, str(a, "p_user_id"), false);
  const session = str(a, "p_session");
  if (session === null || !one(db, 'SELECT 1 x FROM "erp_finance__cash_session" WHERE id=? AND deleted_at IS NULL', session))
    raise("P0002", "erp_pos_not_found");
  const pref = preference(db, "pdv.situacoes_fechamento") ?? ["atendido", "verificado"];
  if (!Array.isArray(pref)) raise("22023", "cannot extract elements from " + (pref !== null && typeof pref === "object" ? "an object" : "a scalar"));
  const statuses = (pref as unknown[]).map((x) => (x === null ? null : STATUS[typeof x === "string" ? x : jsonbText(x)] ?? null));
  const counted = (status: unknown) => statuses.includes(status as string);
  const sales = db
    .exec(
      `SELECT s.id, CAST(s.total_cents AS TEXT) total_cents, d.id document_id, d.status FROM "erp_pos__sale" s
       JOIN "erp_documents__document" d ON d.id=s.document_id WHERE s.cash_session_id=? AND s.state='finished'`,
      session,
    )
    .rows.filter((s) => counted(s.status));
  const total = sales.reduce((t, s) => t + BigInt(String(s.total_cents)), 0n);
  const items = sales.flatMap((s) =>
    db.exec('SELECT product_id, CAST(quantity AS TEXT) quantity, data FROM "erp_documents__item" WHERE document_id=?', s.document_id).rows,
  );
  const itemTotal = (i: Row): Dec | null => {
    const t = (json(i.data) as Json | null)?.total;
    return t === undefined || t === null ? null : dec(typeof t === "string" ? t : jsonbText(t));
  };
  const sumDec = (list: (Dec | null)[]): Dec | null => list.filter((x): x is Dec => x !== null).reduce<Dec | null>((s, x) => (s ? decAdd(s, x) : x), null);
  const value = sumDec(items.map(itemTotal)) ?? dec("0");

  const returnsCents = db
    .exec('SELECT CAST(refund_cents AS TEXT) c FROM "erp_pos__sale_return" WHERE cash_session_id=? AND cash_entry_id IS NOT NULL', session)
    .rows.reduce((t, r) => t + BigInt(String(r.c)), 0n);

  const saleIds = new Set(sales.map((s) => String(s.id)));
  const payments = db
    .exec(
      'SELECT p.sale_id, p.payment_method_id, CAST(p.amount_cents AS TEXT) amount_cents FROM "erp_pos__sale_payment" p JOIN "erp_pos__sale" s ON s.id=p.sale_id WHERE s.cash_session_id=?',
      session,
    )
    .rows.filter((p) => saleIds.has(String(p.sale_id)));
  const cashCheck = prefFlag(db, "pdv.dinheiro_cheque");
  const methodRows = db
    .exec('SELECT id, description, payment_type, active, deleted_at FROM "erp_catalog__payment_method"')
    .rows.map((m) => {
      const mine = payments.filter((p) => p.payment_method_id === m.id);
      return {
        id: m.id,
        description: m.description,
        name: left(m.description, 100),
        payment_type: m.payment_type,
        cents: mine.reduce((t, p) => t + BigInt(String(p.amount_cents)), 0n),
        sales: new Set(mine.map((p) => String(p.sale_id))).size,
        count: mine.length,
        usable: bool(m.active) && m.deleted_at === null,
      };
    })
    .filter((m) => m.count > 0 || (cashCheck && ["01", "02"].includes(String(m.payment_type)) && m.usable))
    .sort(by<{ description: unknown; id: unknown }>((x, y) => cmpLower(x.description, y.description), (x, y) => cmpText(x.id, y.id)))
    .slice(0, 100)
    .sort(by<{ name: unknown; id: unknown }>((x, y) => cmpLower(x.name, y.name), (x, y) => cmpText(x.id, y.id)))
    .map((m) => ({ payment_method_id: m.id, name: m.name, payment_type: m.payment_type, registered_cents: m.cents.toString(), sales: m.sales }));

  // Grupos de produto: item → product_detail → taxonomy (product_groups); sem grupo, "Sem grupo".
  const groups = new Map<string, { group_id: unknown; name: string; qty: Dec | null; value: Dec | null }>();
  for (const i of items) {
    const g =
      i.product_id === null
        ? undefined
        : one(
            db,
            `SELECT t.id, t.name FROM "erp_catalog__product_detail" pd JOIN "erp_catalog__taxonomy" t ON t.id=pd.product_group_id AND t.kind='product_groups' WHERE pd.record_id=?`,
            i.product_id,
          );
    const key = g ? `g:${g.id}` : "none";
    const cur = groups.get(key) ?? { group_id: g ? g.id : null, name: g ? left(g.name, 100)! : "Sem grupo", qty: null, value: null };
    const q = i.quantity === null ? null : decColumn(i.quantity, 6);
    const v = itemTotal(i);
    cur.qty = q === null ? cur.qty : cur.qty ? decAdd(cur.qty, q) : q;
    cur.value = v === null ? cur.value : cur.value ? decAdd(cur.value, v) : v;
    groups.set(key, cur);
  }
  // ORDER BY valor DESC (nulos primeiro no DESC), nome.
  type Group = { group_id: unknown; name: string; qty: Dec | null; value: Dec | null };
  const byValueDesc = (x: Group, y: Group) =>
    x.value === null || y.value === null ? (x.value === y.value ? 0 : x.value === null ? -1 : 1) : decCmp(y.value, x.value);
  const groupList = [...groups.values()]
    .sort(byValueDesc)
    .slice(0, 100)
    .sort(by<Group>(byValueDesc, (x, y) => cmpText(x.name, y.name)))
    .map((g) => ({
      group_id: g.group_id,
      name: g.name,
      quantity: g.qty === null ? null : decFixed(g.qty, 6),
      value: g.value === null ? null : decFixed(g.value, 2),
      percent:
        decCmp(value, dec("0")) > 0
          ? g.value === null
            ? null
            : decFixed(decRound(decDiv(decMul(g.value, dec("100")), value), 2), 2)
          : "0.00",
    }));
  return {
    entity: "pos_cash_summary",
    data_mode: "erp_native",
    session_id: session,
    statuses: statuses.filter((x): x is string => x !== null).sort((x, y) => cmpText(x, y)),
    sales_count: sales.length,
    total_cents: total.toString(),
    returns_cents: returnsCents.toString(),
    methods: methodRows,
    groups: groupList,
  };
}

registerRpc("erp_pos_context", erpPosContext);
registerRpc("erp_pos_favorites", erpPosFavorites);
registerRpc("erp_pos_order", erpPosOrder);
registerRpc("erp_pos_sales", erpPosSales);
registerRpc("erp_pos_sale_get", erpPosSaleGet);
registerRpc("erp_pos_cash_summary", erpPosCashSummary);
