// O Financeiro sobre o documento (camada de linha do Documentos):
// - as guardas protect_document_finance e protect_document_item_finance
//   (erp_finance.guard_posted_document/_item, com notes_edit_allowed e notes_item_allowed);
// - a operação de comissão do pedido e da OS (erp_finance.commission_operation_sync, o
//   gatilho adiado commission_operation_capture), com commission_confirmed,
//   document_seller, commission_amounts e commission_weighted.
// As escritas do sync só mexem na operação ativa e nunca nas colunas congeladas: o gatilho
// commission_operation_frozen (ainda pendente no motor) passa sempre para elas.
// Aritmética exata em BigInt: centavos inteiros, alíquotas com 4 casas (vendedor) e 6 (operação).
// Linhas: o objeto da linha do SQLite (SELECT *), como nas guardas do Estoque.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { fromSqlite, raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { maintenanceAllows, requireRpcParts } from "../../engine/parts-gate.ts";
import { erpRequirement, erpRequirementMet } from "../../parts.ts";
import { erpEntityRequirement } from "../../parts-requirements.ts";
import { rowJson } from "../../engine/row-json.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { commissionPolicy, operationTitles } from "./commissions.ts";

type Row = Record<string, unknown>;
type Op = "INSERT" | "UPDATE" | "DELETE";
const DOC = "erp_documents__document",
  ITEM = "erp_documents__item";

const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
/** to_jsonb(linha) - chaves, em texto canônico do jsonb */
function without(table: string, row: Row, keys: string[]) {
  const json = rowJson(table, row);
  for (const k of keys) delete json[k];
  return jsonbText(json);
}
const minus = (b: unknown, keys: string[]) => {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const r = { ...(b as Row) };
  for (const k of keys) delete r[k];
  return r;
};

/** erp_documents.effects_transition_allowed (dono: Documentos; função pura, repetida aqui para não haver ciclo de carga). */
export function effectsTransitionAllowed(kind: unknown, from: unknown, to: unknown): boolean {
  if (from === null || to === null || from === undefined || to === undefined) return false;
  if (from === to) return true;
  if (kind === "sales_orders")
    return (
      (from === "verified" && to === "in_progress") || (from === "in_progress" && (to === "partially_fulfilled" || to === "fulfilled")) ||
      (from === "partially_fulfilled" && (to === "fulfilled" || to === "partially_invoiced")) || (from === "partially_invoiced" && to === "partially_fulfilled") ||
      (from === "open" && to === "checkout_partial") || (from === "checkout_partial" && (to === "open" || to === "verified"))
    );
  if (kind === "purchase_orders") return (from === "in_progress" && (to === "partially_fulfilled" || to === "fulfilled")) || (from === "partially_fulfilled" && to === "fulfilled");
  if (kind === "service_orders")
    return (
      (from === "approved" && to === "in_progress") || (from === "in_progress" && (to === "waiting_parts" || to === "service_done")) ||
      (from === "waiting_parts" && to === "in_progress") || (from === "service_done" && to === "finalized")
    );
  return false;
}

/** erp_finance.notes_edit_allowed(o, n): só Observações e Observações internas mudam. */
export function notesEditAllowed(o: Row, n: Row): boolean {
  if (o.status === null || n.status === null || o.status !== n.status) return false;
  const meta = ["version", "updated_at", "updated_by", "body"];
  if (without(DOC, n, meta) !== without(DOC, o, meta)) return false;
  const nb = parse(n.body),
    ob = parse(o.body);
  if (nb === null || ob === null) return false;
  return jsonbText(minus(nb, ["notes", "internal_notes"])) === jsonbText(minus(ob, ["notes", "internal_notes"]));
}

/** erp_finance.notes_item_allowed(op, o, n) */
export function notesItemAllowed(db: SqlDriver, op: Op, o: Row | null, n: Row | null): boolean {
  if (op === "INSERT") return !!one(db, 'SELECT 1 x FROM "erp_documents__item" WHERE id=? AND document_id=?', n!.id, n!.document_id);
  if (op === "UPDATE") return jsonbText(rowJson(ITEM, n!)) === jsonbText(rowJson(ITEM, o!));
  return false;
}

const financeLocked = (db: SqlDriver, ids: unknown[]) =>
  ids.some(
    (id) =>
      id !== null &&
      id !== undefined &&
      (!!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id) ||
        !!one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_document" WHERE document_id=? AND active=1 LIMIT 1', id)),
  );

/** erp_finance.guard_posted_document (protect_document_finance, BEFORE UPDATE OR DELETE) */
export function guardPostedDocument(db: SqlDriver, op: Op, o: Row, n: Row | null) {
  if (!financeLocked(db, [o.id])) return;
  if (op === "DELETE") raise("40001", "erp_document_active_finance");
  // 303: só as observações passam (erp_document_notes_save).
  if (notesEditAllowed(o, n!)) return;
  const meta = ["status", "version", "updated_at", "updated_by"];
  if (
    without(DOC, n!, meta) !== without(DOC, o, meta) ||
    !(effectsTransitionAllowed(o.kind, o.status, n!.status) || (o.kind === "purchase_orders" && o.status === "open" && ["in_progress", "partially_fulfilled", "fulfilled"].includes(String(n!.status))))
  )
    raise("40001", "erp_document_active_finance");
}

/** erp_finance.guard_posted_item (protect_document_item_finance, BEFORE INSERT OR UPDATE OR DELETE) */
export function guardPostedItem(db: SqlDriver, op: Op, o: Row | null, n: Row | null) {
  const d = op === "INSERT" ? n!.document_id : o!.document_id;
  const ids = op === "UPDATE" ? [d, n!.document_id] : [d];
  if (financeLocked(db, ids) && !notesItemAllowed(db, op, o, n)) raise("40001", "erp_document_active_finance");
}

/** erp_finance.commission_confirmed(kind, status) */
export const commissionConfirmed = (kind: unknown, status: unknown) =>
  kind === "sales_orders"
    ? ["verified", "in_progress", "partially_fulfilled", "fulfilled", "partially_invoiced"].includes(String(status))
    : kind === "service_orders"
      ? ["approved", "in_progress", "waiting_parts", "service_done", "finalized"].includes(String(status))
      : false;

/** round(n/d) do numeric (meio para longe do zero) */
const roundDiv = (n: bigint, d: bigint) => {
  if (d < 0n) (n = -n), (d = -d);
  return n >= 0n ? (2n * n + d) / (2n * d) : -((2n * -n + d) / (2n * d));
};
/** texto decimal → inteiro escalado, sem arredondar */
const scaledText = (text: string, scale: number) => {
  const neg = text.startsWith("-");
  const [i, f = ""] = (neg ? text.slice(1) : text).split(".");
  const v = BigInt(i || "0") * 10n ** BigInt(scale) + BigInt((f + "0".repeat(scale)).slice(0, scale) || "0");
  return neg ? -v : v;
};
/** valor jsonb numérico ou texto → (inteiro escalado, casas) exato */
const exact = (v: unknown): { n: bigint; s: number } | null => {
  if (v === null || v === undefined) return null;
  const t = typeof v === "string" ? v : jsonbText(v);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const s = t.includes(".") ? t.length - t.indexOf(".") - 1 : 0;
  return { n: scaledText(t, s), s };
};

/** erp_finance.cents_of(texto): round(valor*100) quando é decimal simples; senão 0. */
export function centsOf(text: string | null): bigint {
  if (text === null || !/^-?\d{1,15}(\.\d+)?$/.test(text)) return 0n;
  const e = exact(text)!;
  return e.s <= 2 ? e.n * 10n ** BigInt(2 - e.s) : roundDiv(e.n, 10n ** BigInt(e.s - 2));
}
const pathText = (o: unknown, path: string[]): string | null => {
  let v: unknown = o;
  for (const p of path) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Row)[p];
  }
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};

/** erp_finance.document_seller(documento): o vendedor do corpo, senão o do Origin pela referência comercial. */
export function documentSeller(db: SqlDriver, d: Row): string | null {
  const ref = pathText(parse(d.body), ["seller_id"]);
  if (ref !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)) {
    const s = one(db, 'SELECT id FROM "erp_catalog__seller" WHERE id=?', ref);
    if (s) return String(s.id);
  }
  return commissionSeller(db, (parse(d.body) as Row | null)?.commercial);
}

/**
 * erp_finance.commission_seller(referência): o vendedor do Origin pela referência comercial
 * (system 'origin'): o contato do vendedor no raw_record, o contato do catálogo por
 * erp_catalog.origin e o vendedor desse contato, o menor id.
 */
function commissionSeller(db: SqlDriver, commercial: unknown): string | null {
  const ref = commercial !== null && typeof commercial === "object" && !Array.isArray(commercial) ? (commercial as Row).seller_reference : undefined;
  if (ref === null || ref === undefined || typeof ref !== "object" || Array.isArray(ref)) return null;
  if (pathText(ref, ["system"]) !== "origin") return null;
  const source = pathText(ref, ["source_id"]);
  if (source === null) return null;
  const rows = db.exec(
    `SELECT s.id FROM "origin_sync__raw_record" r
       JOIN "erp_catalog__origin" o ON o.entity='contacts' AND o.source_id=json_extract(r.payload,'$.contato.id')
       JOIN "erp_catalog__seller" s ON s.contact_id=o.record_id
      WHERE r.entity='sellers' AND r.source_id=? ORDER BY s.id LIMIT 1`,
    source,
  ).rows;
  return rows.length ? String(rows[0].id) : null;
}

/** erp_finance.commission_amounts(documento, política) */
export function commissionAmounts(db: SqlDriver, document: string, policy: unknown) {
  const d = one(db, 'SELECT body FROM "erp_documents__document" WHERE id=?', document);
  const body = d ? parse(d.body) : null;
  const add = (policy as Row | null)?.additions;
  const has = (k: string) => Array.isArray(add) && add.includes(k);
  let items = 0n;
  for (const i of db.exec('SELECT total FROM "erp_documents__item" WHERE document_id=?', document).rows) if (i.total !== null) items += BigInt(String(i.total));
  const discount = centsOf(pathText(body, ["totals", "discount"])),
    freight = centsOf(pathText(body, ["totals", "freight"])),
    ipi = centsOf(pathText(body, ["totals", "ipi"])),
    st = centsOf(pathText(body, ["totals", "icms_st"]));
  let fee = 0n;
  const inst = (body as Row | null)?.installments;
  if (Array.isArray(inst)) for (const x of inst) fee += centsOf(pathText(x, ["details", "commission_fee_amount"]));
  let base = items - (has("desconto") ? discount : 0n) + (has("frete") ? freight : 0n) + (has("icms_st") ? st : 0n) + (has("ipi") ? ipi : 0n) - (has("taxas_pagamento") ? fee : 0n);
  if (base < 0n) base = 0n;
  return { items_cents: items, discount_cents: discount, freight_cents: freight, ipi_cents: ipi, icms_st_cents: st, fee_cents: fee, base_cents: base };
}

/** erp_finance.commission_weighted(documento, vendedor): soma dos itens e a soma ponderada pela alíquota (escala 4). */
export function commissionWeighted(db: SqlDriver, document: string, seller: string) {
  const s = one(db, 'SELECT commission_mode, commission_rate, commission_bands FROM "erp_catalog__seller" WHERE id=?', seller);
  if (!s) return null;
  const bands = ((parse(s.commission_bands) as Row[] | null) ?? [])
    .map((b) => ({ upTo: exact(b.discount_up_to), rate: exact(b.rate) }))
    .filter((b) => b.upTo !== null)
    .map((b) => ({ upTo: b.upTo!.n * 10n ** BigInt(10 - b.upTo!.s), rate: b.rate === null ? null : b.rate.n * 10n ** BigInt(10 - b.rate.s) })) // escala 10
    .sort((x, y) => (x.upTo < y.upTo ? -1 : x.upTo > y.upTo ? 1 : 0));
  let items = 0n,
    weighted = 0n; // weighted: centavos × alíquota na escala 10
  for (const i of db.exec('SELECT total, discount_percent FROM "erp_documents__item" WHERE document_id=?', document).rows) {
    if (i.total === null) continue;
    const cents = BigInt(String(i.total));
    items += cents;
    let rate10: bigint;
    if (s.commission_mode === "fixa") rate10 = s.commission_rate === null ? 0n : BigInt(String(s.commission_rate)) * 10n ** 6n; // commission_rate na escala 4
    else {
      const pct = i.discount_percent === null ? null : BigInt(String(i.discount_percent)) * 10n ** 6n; // escala 4 → 10
      rate10 = pct === null ? 0n : (bands.find((b) => pct <= b.upTo)?.rate ?? 0n);
    }
    weighted += cents * rate10;
  }
  return { items_cents: items, weighted10: weighted };
}

/** erp_finance.commission_operation_sync(documento): a operação de comissão do pedido e da OS. */
export function commissionOperationSync(ctx: RpcContext, document: string): string | null {
  const db = ctx.db;
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', document);
  if (!d || !["sales_orders", "service_orders"].includes(String(d.kind))) return null;
  let o: Row | null = one(db, `SELECT * FROM "erp_finance__commission_operation" WHERE document_id=? AND state='active'`, d.id) ?? null;
  const owner = erpEntityRequirement(d.kind)!;
  const enabled = erpRequirementMet(ctx.parts, erpRequirement("erp-financeiro", ...owner.all));
  if (!enabled) {
    // Uma edição ou troca de vendedor não encerra nem recalcula a estimativa congelada.
    if (!o || d.status !== "cancelled") return o ? String(o.id) : null;
    // Cancelamento comercial explícito, ou a cadeia restrita do cancelamento do PDV.
    if (!erpRequirementMet(ctx.parts, owner) && !maintenanceAllows(ctx, "erp_document_transition", {
      p_id: d.id, p_kind: d.kind, p_status: "cancelled",
    })) return String(o.id);
  } else if (d.status !== "cancelled") {
    requireRpcParts(ctx, "erp_document_commission_operation", { p_document_id: d.id, p_kind: d.kind });
  }
  if (o && d.status === "cancelled") requireRpcParts(ctx, "erp_document_transition", {
    p_id: d.id, p_kind: d.kind, p_status: "cancelled",
  });
  const seller = documentSeller(db, d);
  const confirmed = commissionConfirmed(d.kind, d.status);
  if (!confirmed || seller === null || (o !== null && o.seller_id !== seller)) {
    if (o !== null) {
      const now = ctx.clock.next().toString();
      if (d.status === "cancelled") {
        let net = BigInt(String(o.estimated_cents));
        for (const a of db.exec('SELECT amount_cents FROM "erp_finance__commission_adjustment" WHERE operation_id=?', o.id).rows) net += BigInt(String(a.amount_cents));
        if (net > 0n && !one(db, 'SELECT 1 x FROM "erp_finance__commission_adjustment" WHERE source_key=?', `cancel:${o.id}`))
          db.exec(
            `INSERT INTO "erp_finance__commission_adjustment"(id, operation_id, kind, source_key, amount_cents, occurred_on, note, created_at) VALUES(?,?,'cancel',?,?,?,'Venda cancelada',?)`,
            crypto.randomUUID(), o.id, `cancel:${o.id}`, Number(-net), todaySaoPaulo(), ctx.clock.next().toString(),
          );
        db.exec(`UPDATE "erp_finance__commission_operation" SET state='cancelled', ended_at=?, ended_reason='Venda cancelada' WHERE id=?`, now, o.id);
      } else
        db.exec(
          `UPDATE "erp_finance__commission_operation" SET state='superseded', ended_at=?, ended_reason=? WHERE id=?`,
          now, seller !== o.seller_id ? "Vendedor alterado" : "Confirmação desfeita", o.id,
        );
      o = null;
    }
    if (!confirmed || seller === null) return null;
  }
  const total = d.total === null ? 0n : BigInt(String(d.total)); // numeric(…,2) em centavos
  if (o !== null) {
    // A mesma operação: a base acompanha os itens enquanto nenhuma conta foi lançada, com a política e o percentual congelados.
    if (BigInt(String(o.total_cents)) === total || operationTitles(db, String(d.id)).length > 0) return String(o.id);
    const a = commissionAmounts(db, String(d.id), parse(o.policy));
    db.exec(
      `UPDATE "erp_finance__commission_operation" SET items_cents=?, discount_cents=?, freight_cents=?, ipi_cents=?, icms_st_cents=?, fee_cents=?, base_cents=?,
         estimated_cents=?, total_cents=?, version=version+1 WHERE id=?`,
      Number(a.items_cents), Number(a.discount_cents), Number(a.freight_cents), Number(a.ipi_cents), Number(a.icms_st_cents), Number(a.fee_cents), Number(a.base_cents),
      Number(roundDiv(a.base_cents * BigInt(String(o.rate)), 10n ** 8n)), Number(total), o.id,
    );
    return String(o.id);
  }
  const s = one(db, 'SELECT commission_rule FROM "erp_catalog__seller" WHERE id=?', seller)!;
  const w = commissionWeighted(db, String(d.id), seller!);
  const policy = commissionPolicy(db);
  const a = commissionAmounts(db, String(d.id), policy);
  if (w === null || w.items_cents <= 0n) return null;
  // round(weighted/items, 6): weighted na escala 10.
  const rate6 = roundDiv(w.weighted10, w.items_cents * 10n ** 4n);
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__commission_operation"(id, document_id, kind, seller_id, state, rule, policy, items_cents, discount_cents, freight_cents, ipi_cents, icms_st_cents,
       fee_cents, base_cents, rate, estimated_cents, total_cents, confirmed_status, confirmed_on, version, created_at)
     VALUES(?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    id, d.id, d.kind, seller, s.commission_rule ?? "parcial", JSON.stringify(policy), Number(a.items_cents), Number(a.discount_cents), Number(a.freight_cents),
    Number(a.ipi_cents), Number(a.icms_st_cents), Number(a.fee_cents), Number(a.base_cents), Number(rate6), Number(roundDiv(a.base_cents * rate6, 10n ** 8n)),
    Number(total), d.status, todaySaoPaulo(), ctx.clock.next().toString(),
  );
  return id;
}

/**
 * Gatilho adiado commission_operation_capture: commission_operation_sync num
 * subtransação (savepoint), que engole data_exception e check_violation como o
 * "exception when ... then null" do original, desfazendo o que a tentativa escreveu.
 */
export function commissionOperationCapture(ctx: RpcContext, document: string) {
  try {
    ctx.db.transaction(() => commissionOperationSync(ctx, document));
  } catch (e) {
    const err = fromSqlite(e);
    if (err.code.startsWith("22") || err.code === "23514") return;
    throw err;
  }
}
