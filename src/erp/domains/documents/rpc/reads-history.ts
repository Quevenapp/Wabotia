// Histórico de vendas e compras do contato ou do produto (sessão L, bloco
// B0): public.erp_document_history, com o mesmo nome. Junta as linhas dos
// documentos, das notas fiscais autorizadas (só para admin e fiscal) e das
// entradas manuais de estoque (compras de um produto), e o resumo financeiro
// do contato. A linha de documento espelhado (authority='origin') é lida como
// no oráculo: origin='origin', com a quantidade e o preço observados do item
// (ERP-PORTE.md, "Origin fora não é sem efeito").
import { one } from "../../../engine/driver.ts";
import { formatScaled, fromColumn, rescale } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { contactScope, contactVisibleTo, unitPriceNumeric } from "../../catalog/public.ts";
import { osPermitted, requireAccess } from "../public.ts";
import { unavailableParts } from "../internal.ts";
import { erpEntityRequirement, erpRequirementMet } from "../../../parts-requirements.ts";

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
type Line = {
  type: string;
  /** d.authority das linhas de documento; 'brufap' nas notas e no estoque. */
  origin: string;
  /** i.data->>'quantity' e i.data->>'unit_price' (o que a linha espelhada mostra). */
  observed_quantity: string | null;
  observed_price: string | null;
  document_id: unknown;
  num: number | null;
  day: string | null;
  position: number;
  description: string;
  code: string | null;
  product_id: unknown;
  unit: string;
  quantity: bigint | null; // escala 6
  unit_price: unknown; // texto numeric (dec_text) ou 0
};
const cents2 = (c: bigint) => formatScaled(c, 2);

/** public.erp_document_history(p_user_id, p_kind, p_contact_id, p_product_id, p_query, p_limit) */
export function erpDocumentHistory(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    contact = str(a.p_contact_id),
    product = str(a.p_product_id),
    query = str(a.p_query),
    limit = a.p_limit === null || a.p_limit === undefined ? null : Number(a.p_limit);
  const today = todaySaoPaulo();
  const scope = contactScope(db, user);
  requireAccess(db, user, kind, false);
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const fiscal = ctx.parts.fiscal && m !== null && ["admin", "fiscal"].includes(String(m.role));
  // v_purchase em três valores: p_kind nulo deixa nulo (venda nas linhas, sem estoque, sem financeiro).
  const purchase: boolean | null = kind === null ? null : kind === "purchase_orders";
  const bad =
    limit === null ||
    limit < 1 ||
    limit > 50 ||
    (purchase === false && contact === null) ||
    (purchase === true && product === null) ||
    (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query)));
  if (bad) raise("22023", "erp_document_history_invalid");
  if (contact !== null && !contactVisibleTo(db, scope, contact)) raise("P0002", "erp_document_not_found");
  const q = query === null || pgBtrim(query) === "" ? null : pgLower(pgBtrim(query));
  const lines: Line[] = [];
  const docKind = purchase === true ? "purchase_orders" : "sales_orders";
  if (erpRequirementMet(ctx.parts, erpEntityRequirement(docKind)!)) for (const r of db.exec(
    `SELECT d.id, d.number, d.body, d.contact_id, d.authority, i.position, i.data, i.product_id, CAST(i.quantity AS TEXT) quantity, i.unit_price
       FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id
      WHERE d.kind=? AND d.status<>'cancelled'
        AND NOT EXISTS(SELECT 1 FROM "erp_documents__origin_mirror" bm WHERE bm.document_id=d.id AND bm.source_deleted=1)`,
    docKind,
  ).rows) {
    if (contact !== null && r.contact_id !== contact) continue;
    if (product !== null && r.product_id !== product) continue;
    if (!contactVisibleTo(db, scope, str(r.contact_id))) continue;
    const data = JSON.parse(String(r.data));
    const code = arrow(data, "code");
    lines.push({
      type: purchase === true ? "purchase" : "sale",
      origin: String(r.authority),
      observed_quantity: arrow(data, "quantity"),
      observed_price: arrow(data, "unit_price"),
      document_id: r.id,
      num: r.number === null ? null : Number(r.number),
      day: arrow(JSON.parse(String(r.body)), "date"),
      position: Number(r.position),
      description: arrow(data, "description") ?? "",
      code: code === "" ? null : code,
      product_id: r.product_id,
      unit: arrow(data, "unit") ?? "",
      quantity: r.quantity === null ? null : fromColumn(r.quantity),
      unit_price: r.unit_price,
    });
  }
  if (fiscal)
    for (const r of db.exec(
      `SELECT v.id, v.number, v.issue_date, v.status, v.recipient, t.position, t.data, t.product_id, t.quantity, t.unit_price
         FROM "erp_fiscal_invoices__invoice" v JOIN "erp_fiscal_invoices__invoice_item" t ON t.invoice_id=v.id
        WHERE v.deleted_at IS NULL AND v.number IS NOT NULL AND v.direction=? AND v.status IN (6,7,8)`,
      purchase === true ? "0" : "1",
    ).rows) {
      if (!(purchase === true || [6, 7].includes(Number(r.status)))) continue;
      const recipient = arrow(JSON.parse(String(r.recipient)), "contact_id");
      if (contact !== null && recipient !== contact) continue;
      if (product !== null && r.product_id !== product) continue;
      if (scope !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" cp WHERE cp.record_id=? AND cp.seller_id=?', recipient, scope)) continue;
      const data = JSON.parse(String(r.data));
      const code = arrow(data, "code");
      lines.push({
        type: "invoice",
        origin: "brufap",
        observed_quantity: null,
        observed_price: null,
        document_id: r.id,
        num: Number(r.number),
        day: str(r.issue_date),
        position: Number(r.position),
        description: arrow(data, "description") ?? "",
        code: code === "" ? null : code,
        product_id: r.product_id,
        unit: arrow(data, "unit") ?? "",
        quantity: rescale(fromColumn(r.quantity), 4, 6),
        unit_price: r.unit_price,
      });
    }
  if (purchase === true && contact === null && ctx.parts.stock)
    for (const r of db.exec(
      `SELECT m.id, m.occurred_on, e.ordinal, r.name, r.code, e.product_id, e.unit, CAST(e.quantity AS TEXT) quantity,
          (SELECT coalesce(md.unit_price, md.unit_cost) FROM "erp_stock__movement_detail" md WHERE md.movement_id=m.id AND md.product_id=e.product_id ORDER BY md.revision DESC LIMIT 1) price
         FROM "erp_stock__movement" m JOIN "erp_stock__entry" e ON e.movement_id=m.id JOIN "erp_catalog__record" r ON r.id=e.product_id
        WHERE m.kind='receipt' AND e.product_id=? AND e.quantity>0
          AND EXISTS(SELECT 1 FROM "erp_stock__ledger_command" c WHERE c.movement_id=m.id AND c.action='launch')
          AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" x WHERE x.reverses_id=m.id)`,
      product,
    ).rows) {
      const code = r.code === null ? null : String(r.code);
      lines.push({
        type: "stock",
        origin: "brufap",
        observed_quantity: null,
        observed_price: null,
        document_id: r.id,
        num: null,
        day: str(r.occurred_on),
        position: Number(r.ordinal),
        description: pgLeft(r.name === null ? "" : String(r.name), 200),
        code: code === "" ? null : code,
        product_id: r.product_id,
        unit: r.unit === null ? "" : String(r.unit),
        quantity: fromColumn(r.quantity),
        unit_price: r.price ?? "0",
      });
    }
  const found = q === null ? lines : lines.filter((l) => pgLower(l.description).includes(q) || pgLower(l.code ?? "").includes(q));
  // ORDER BY day DESC (NULL primeiro no DESC), num DESC NULLS LAST, position
  found.sort(
    (x, y) =>
      (x.day === y.day ? 0 : x.day === null ? -1 : y.day === null ? 1 : -pgCompareText(x.day, y.day)) ||
      (x.num === y.num ? 0 : x.num === null ? 1 : y.num === null ? -1 : y.num - x.num) ||
      x.position - y.position,
  );
  const page = found.slice(0, limit! + 1);
  const items = page.slice(0, limit!).map((l) => ({
    type: l.type,
    origin: l.origin,
    document_id: l.document_id,
    number: l.num === null ? null : String(l.num),
    date: l.day,
    position: l.position,
    description: pgLeft(l.description, 200),
    code: l.code === null ? null : pgLeft(l.code, 100),
    product_id: l.product_id,
    unit: pgLeft(l.unit, 16),
    quantity: l.origin === "origin" ? l.observed_quantity : l.quantity === null ? null : formatScaled(l.quantity, 6),
    unit_price: l.origin === "origin" ? l.observed_price : unitPriceNumeric(l.unit_price, 14),
  }));
  let finance: Record<string, unknown> | null = null;
  if (ctx.parts.finance && purchase === false && product === null && (kind !== "service_orders" || osPermitted(db, user!, "historico_financeiro"))) {
    const titles = db
      .exec(
        `SELECT id, due_on, description, installment, installments, CAST(amount_cents AS TEXT) amount_cents, CAST(settled_cents AS TEXT) settled_cents
           FROM "erp_finance__title" WHERE kind='receivable' AND contact_id=? AND cancelled=0 AND deleted_at IS NULL AND settled_cents<amount_cents`,
        contact,
      )
      .rows.sort((x, y) => pgCompareText(str(x.due_on), str(y.due_on)) || pgCompareText(str(x.id), str(y.id)));
    let open = 0n,
      overdue = 0n;
    for (const t of titles) {
      const o = BigInt(String(t.amount_cents)) - BigInt(String(t.settled_cents));
      open += o;
      if (String(t.due_on) < today) overdue += o;
    }
    finance = {
      open_count: titles.length,
      open_amount: cents2(open),
      overdue_amount: cents2(overdue),
      titles: titles.slice(0, 20).map((o) => ({
        id: o.id,
        due_on: str(o.due_on),
        description: pgLeft(String(o.description), 200),
        installment: Number(o.installment),
        installments: Number(o.installments),
        amount: cents2(BigInt(String(o.amount_cents))),
        open_amount: cents2(BigInt(String(o.amount_cents)) - BigInt(String(o.settled_cents))),
      })),
    };
  }
  return {
    kind,
    contact_id: contact,
    product_id: product,
    items,
    has_more: page.length > limit!,
    invoices_included: fiscal,
    ...unavailableParts(ctx, ["sales", "purchases", "stock", "finance", "fiscal"]),
    finance,
    data_mode: "erp_native",
    operational_effects: false,
    ...(kind === "service_orders" && product === null && finance === null ? { finance_hidden: true } : {}),
  };
}

registerRpc("erp_document_history", erpDocumentHistory);

