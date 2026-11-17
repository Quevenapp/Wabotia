// Caixa / PDV (erp_pos), bloco opcional erp-pdv: os ajudantes do schema erp_pos
// que as RPCs do P1 usam (access, flag, txt, int, uid, keys, pref_flag,
// certificate_state, usable_session, today, sale_view, returns_view, returned,
// nfce), com a semântica do oráculo.
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { formatScaled, fromColumn } from "../../engine/dec.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../engine/time.ts";
import { actorLabel } from "../access/public.ts";
import { get as preference } from "../preferences/public.ts";

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Valores e ordem

/** Booleano lido do SQLite (0/1). */
export const bool = (v: unknown) => v === 1 || v === "1" || v === true;
/** int53/int do SQLite → número; null fica null. */
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** bigint::text */
export const intText = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** timestamptz no jsonb */
export const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));
/** jsonb guardado como texto → valor */
export const json = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
/** left(x, n) com null */
export const left = (v: unknown, n: number) => (v === null || v === undefined ? null : pgLeft(String(v), n));
/** v->>'k' de um objeto jsonb */
export function arrowText(v: unknown, k: string): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const x = (v as Json)[k];
  return x === undefined || x === null ? null : typeof x === "string" ? x : jsonbText(x);
}
/** v->'k' */
export const arrowJson = (v: unknown, k: string): unknown =>
  v === null || typeof v !== "object" || Array.isArray(v) ? null : ((v as Json)[k] ?? null);

/** ORDER BY de texto (collation C), nulos por último no ASC. */
export const cmpText = (a: unknown, b: unknown) =>
  pgCompareText(a === null || a === undefined ? null : String(a), b === null || b === undefined ? null : String(b));
/** ORDER BY lower(x) */
export const cmpLower = (a: unknown, b: unknown) =>
  cmpText(a === null || a === undefined ? null : pgLower(String(a)), b === null || b === undefined ? null : pgLower(String(b)));
/** ORDER BY de inteiros guardados como número ou texto (bigint), nulos por último no ASC. */
export function cmpInt(a: unknown, b: unknown) {
  if (a === null || a === undefined || b === null || b === undefined)
    return (a === null || a === undefined) === (b === null || b === undefined) ? 0 : a === null || a === undefined ? 1 : -1;
  const x = BigInt(String(a)),
    y = BigInt(String(b));
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Junta comparadores (ORDER BY x, y, …). */
export const by =
  <T>(...cmps: ((a: T, b: T) => number)[]) =>
  (a: T, b: T) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r) return r;
    }
    return 0;
  };

/** jsonb ? texto: chave de objeto, elemento texto de array ou o próprio texto escalar. */
export function jsonbHas(v: unknown, key: string): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.some((x) => x === key);
  if (typeof v === "object") return Object.prototype.hasOwnProperty.call(v, key);
  return v === key;
}

// ---------------------------------------------------------------------------
// numeric sem escala fixa: valor × 10^-escala, com a escala de exibição.

export type Dec = { v: bigint; s: number };
const pow10 = (n: number) => 10n ** BigInt(n);
/** texto numeric → Dec (22P02 como o cast do Postgres). */
export function dec(text: string): Dec {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[2] === "" && !m[3])) raise("22P02", `invalid input syntax for type numeric: "${text}"`);
  const frac = m![3] ?? "";
  const v = BigInt((m![2] || "0") + frac);
  return { v: m![1] === "-" ? -v : v, s: frac.length };
}
const align = (a: Dec, s: number) => a.v * pow10(s - a.s);
export const decAdd = (a: Dec, b: Dec): Dec => {
  const s = Math.max(a.s, b.s);
  return { v: align(a, s) + align(b, s), s };
};
export const decCmp = (a: Dec, b: Dec) => {
  const s = Math.max(a.s, b.s);
  const x = align(a, s),
    y = align(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
};
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n,
    b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return neg ? -q : q;
}
/** round(a, s) */
export const decRound = (a: Dec, s: number): Dec =>
  s >= a.s ? { v: align(a, s), s } : { v: divRound(a.v, pow10(a.s - s)), s };
export const decMul = (a: Dec, b: Dec): Dec => ({ v: a.v * b.v, s: a.s + b.s });
function nbase(a: Dec): [number, bigint] {
  if (a.v === 0n) return [0, 0n];
  const abs = a.v < 0n ? -a.v : a.v;
  const w = Math.floor((abs.toString().length - 1 - a.s) / 4);
  const shift = a.s + 4 * w;
  return [w, shift >= 0 ? abs / pow10(shift) : abs * pow10(-shift)];
}
/** a / b do numeric: a escala de select_div_scale do Postgres, arredondada. */
export function decDiv(a: Dec, b: Dec): Dec {
  if (b.v === 0n) raise("22012", "division by zero");
  const [w1, f1] = nbase(a);
  const [w2, f2] = nbase(b);
  let qweight = w1 - w2;
  if (f1 <= f2) qweight--;
  const s = Math.min(Math.max(16 - qweight * 4, a.s, b.s, 0), 1000);
  return { v: divRound(a.v * pow10(b.s + s), b.v * pow10(a.s)), s };
}
/** numeric::text (escala de exibição) */
export const decText = (a: Dec) => formatScaled(a.v, a.s);
/** ::numeric(p,s)::text */
export const decFixed = (a: Dec, s: number) => formatScaled(decRound(a, s).v, s);
/** coluna dec_i64 escalada → Dec */
export const decColumn = (v: unknown, scale: number): Dec => ({ v: fromColumn(v), s: scale });

// ---------------------------------------------------------------------------
// erp_pos.*

/** erp_pos.today(): a data de hoje em São Paulo pelo relógio da transação. */
export const today = (ctx: RpcContext) => todaySaoPaulo(Number(ctx.clock.next() / 1000n));

/** erp_pos.flag(p, k): p->k = true */
export const flag = (p: unknown, k: string) => arrowJson(p, k) === true;

/** erp_pos.pref_flag(chave): a preferência é true */
export const prefFlag = (db: SqlDriver, key: string) => preference(db, key) === true;

/** erp_pos.keys(p, permitidas, obrigatórias) */
export function keys(p: unknown, allowed: string[], required: string[] = []) {
  if (jsonType(p) !== "object" || Object.keys(p as Json).some((k) => !allowed.includes(k)) || !required.every((k) => k in (p as Json)))
    raise("22023", "erp_pos_invalid_data");
}

/** erp_pos.txt(p, k, máx, obrigatório, multilinha) */
export function txt(p: unknown, k: string, max: number, required = false, multiline = false): string | null {
  const x = arrowJson(p, k);
  let v: string | null;
  if (x === null) v = null;
  else if (jsonType(x) !== "string") raise("22023", "erp_pos_invalid_text");
  else v = pgBtrim(x as string) || null;
  if ((required && v! === null) || (v! !== null && (pgLength(v!) > max || pgHasCntrl.test(multiline ? v!.replace(/\n/g, "") : v!))))
    raise("22023", "erp_pos_invalid_text");
  return v!;
}

/** erp_pos.int(p, k, mín, máx, obrigatório=true) */
export function int(p: unknown, k: string, min: number, max: number, required = true): number | null {
  const x = arrowJson(p, k);
  if (x === null) {
    if (required) raise("22023", "erp_pos_invalid_number");
    return null;
  }
  const t = jsonType(x) === "number" ? jsonbText(x) : null;
  if (t === null || !/^-?[0-9]{1,10}$/.test(t) || Number(t) < min || Number(t) > max) raise("22023", "erp_pos_invalid_number");
  return Number(t);
}

/** erp_pos.uid(p, k, obrigatório=false) */
export function uid(p: unknown, k: string, required = false): string | null {
  const x = arrowJson(p, k);
  if (x === null) {
    if (required) raise("22023", "erp_pos_invalid_id");
    return null;
  }
  if (jsonType(x) !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x as string))
    raise("22023", "erp_pos_invalid_id");
  return (x as string).toLowerCase();
}

export interface Access {
  role: string;
  seller_id: string | null;
  operate: boolean;
  items: boolean;
  payments: boolean;
  finish: boolean;
  edit_price: boolean;
  remove_items: boolean;
  change_method: boolean;
}

/** erp_pos.access(usuário, escrita): papel e módulos do vendedor na frente de caixa. */
export function access(db: SqlDriver, user: string | null, write: boolean): Access {
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const role = (m?.role as string | undefined) ?? null;
  if (user === null || role === null || !(write ? ["admin", "vendas"] : ["admin", "vendas", "consulta", "financeiro"]).includes(role))
    raise("42501", "erp_pos_access_denied");
  const s = role === "vendas" ? one(db, 'SELECT id, modules FROM "erp_catalog__seller" WHERE user_id=?', user) : undefined;
  const modules = s ? (json(s.modules) ?? {}) : null;
  const pdv = !s || flag(modules, "frente_caixa");
  if (write && !pdv) raise("42501", "erp_pos_access_denied");
  const op = ["admin", "vendas"].includes(role!) && pdv;
  const mod = (k: string) => op && (!s || flag(modules, k));
  return {
    role: role!,
    seller_id: s ? String(s.id) : null,
    operate: op,
    items: mod("pdv_registro_itens"),
    payments: mod("pdv_registro_pagamento"),
    finish: mod("pdv_fechamento"),
    edit_price: mod("pdv_editar_preco"),
    remove_items: mod("pdv_exclusao_itens"),
    change_method: mod("pdv_alterar_forma_pagamento"),
  };
}

/**
 * erp_pos.certificate_state(): no Fagoo lê erp_a1.head/credential. No Wabotia o
 * A1 fica no cofre da NFapi e o motor não o lê: 'missing' até o Worker levar o
 * estado do cofre num envelope (schema/structural.ts, "certificado-a1-cofre").
 */
export const certificateState = (): string => "missing";

/** erp_pos.usable_session(usuário, caixa): aberto, não excluído, do usuário ou compartilhado. */
export function usableSession(db: SqlDriver, user: string, session: Row): boolean {
  if (session.state !== "open" || session.deleted_at !== null) return false;
  if (session.operator_id === user) return true;
  const unique = preference(db, "pdv.usuarios_caixa_unico") ?? [];
  return !jsonbHas(unique, user) && !jsonbHas(unique, String(session.operator_id));
}

/** erp_pos.nfce(documento): a nota vinculada ao pedido (modelo 65 primeiro, a mais nova). */
export function nfce(db: SqlDriver, document: string): Json | null {
  const rows = db.exec(
    `SELECT i.id, i.model, i.number, i.series, i.status, CAST(i.created_at AS TEXT) created_at FROM "erp_fiscal_invoices__invoice_order" o
     JOIN "erp_fiscal_invoices__invoice" i ON i.id=o.invoice_id WHERE o.document_id=? AND i.deleted_at IS NULL`,
    document,
  ).rows;
  if (!rows.length) return null;
  rows.sort(
    by<Row>(
      (a, b) => Number(b.model === "65") - Number(a.model === "65"),
      (a, b) => cmpInt(b.created_at, a.created_at),
      (a, b) => cmpText(a.id, b.id),
    ),
  );
  const i = rows[0];
  return { id: i.id, model: i.model, number: intText(i.number), series: intText(i.series), status: num(i.status) };
}

const accountName = (db: SqlDriver, id: unknown) =>
  id === null || id === undefined ? null : left(one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', id)?.name, 200);

/** round(x*100)::bigint::text de um numeric em texto */
const centsText = (text: string) => {
  const d = decRound(dec(text), 2);
  return (d.v * pow10(2 - d.s)).toString();
};

/** erp_pos.sale_view(venda, detalhe): a venda com o pedido, o caixa e a nota. */
export function saleView(db: SqlDriver, id: string, detail: boolean): Json | null {
  const s = one(
    db,
    `SELECT s.*, CAST(s.created_at AS TEXT) created_at, CAST(s.finished_at AS TEXT) finished_at, CAST(s.cancelled_at AS TEXT) cancelled_at,
       CAST(s.total_cents AS TEXT) total_cents, CAST(s.cash_received_cents AS TEXT) cash_received_cents, CAST(s.change_cents AS TEXT) change_cents,
       d.id d_id, CAST(d.number AS TEXT) d_number, d.version d_version, d.status d_status, d.body d_body, d.contact_id d_contact_id,
       d.contact_snapshot d_snapshot, CAST(d.total AS TEXT) d_total, d.warehouse_id d_warehouse_id
     FROM "erp_pos__sale" s JOIN "erp_documents__document" d ON d.id=s.document_id WHERE s.id=?`,
    id,
  );
  if (!s) return null;
  const body = json(s.d_body);
  const snapshot = json(s.d_snapshot);
  const bodyTotal = (() => {
    const t = arrowJson(body, "totals");
    return arrowText(t, "total");
  })();
  const total =
    bodyTotal !== null ? centsText(bodyTotal) : s.d_total === null ? null : (BigInt(String(s.d_total)) as bigint).toString();
  const out: Json = {
    id: s.id,
    document_id: s.d_id,
    number: s.d_number ?? null,
    document_version: num(s.d_version),
    status: s.d_status,
    state: s.state,
    kind: s.kind,
    table_number: num(s.table_number),
    date: arrowText(body, "date"),
    created_at: ts(s.created_at),
    finished_at: ts(s.finished_at),
    cancelled_at: ts(s.cancelled_at),
    operator_id: s.operator_id,
    operator_name: actorLabel(db, String(s.operator_id)),
    account_id: s.account_id,
    account_name: accountName(db, s.account_id),
    cash_session_id: s.cash_session_id,
    contact_id: s.d_contact_id,
    contact_name: pgLeft(arrowText(snapshot, "name") ?? "", 200),
    customer_identified: bool(s.customer_identified),
    total_cents: total,
    cash_received_cents: s.cash_received_cents ?? null,
    change_cents: s.change_cents,
    effects: json(s.effects),
    invoice: nfce(db, String(s.d_id)),
    version: num(s.version),
  };
  if (!detail) return out;
  const sellerId = arrowText(body, "seller_id");
  const seller =
    sellerId === null
      ? undefined
      : one(db, 'SELECT r.name FROM "erp_catalog__seller" x JOIN "erp_catalog__record" r ON r.id=x.contact_id WHERE x.id=?', sellerId);
  const warehouse = s.d_warehouse_id === null ? undefined : one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', s.d_warehouse_id);
  const items = db
    .exec('SELECT id, position, product_id, data FROM "erp_documents__item" WHERE document_id=? ORDER BY position', s.d_id)
    .rows.map((i) => {
      const data = json(i.data);
      return {
        id: i.id,
        position: num(i.position),
        product_id: i.product_id,
        description: arrowText(data, "description"),
        code: arrowText(data, "code"),
        unit: arrowText(data, "unit"),
        quantity: arrowText(data, "quantity"),
        unit_price: arrowText(data, "unit_price"),
        discount_percent: arrowText(data, "discount_percent"),
        gross: arrowText(data, "gross"),
        discount: arrowText(data, "discount"),
        total: arrowText(data, "total"),
        comment: arrowText(data, "detailed_description"),
      };
    });
  const payments = db
    .exec(
      'SELECT position, payment_method_id, method_name, payment_type, days, due_on, CAST(amount_cents AS TEXT) amount_cents, note, title_id, settlement_id FROM "erp_pos__sale_payment" WHERE sale_id=? ORDER BY position',
      s.id,
    )
    .rows.map((p) => ({ ...p, position: num(p.position), days: num(p.days) }));
  return {
    ...out,
    price_list_id: s.price_list_id,
    destination_account_id: s.destination_account_id,
    to_ledger: bool(s.to_ledger),
    cancel_reason: s.cancel_reason,
    warehouse_id: s.d_warehouse_id,
    warehouse_name: left(warehouse?.name, 200),
    seller_id: sellerId,
    seller_name: left(seller?.name, 200),
    category_id: arrowText(body, "category_id"),
    expected_date: arrowText(body, "expected_date"),
    notes: arrowText(body, "notes"),
    internal_notes: arrowText(body, "internal_notes"),
    discount_mode: arrowText(body, "discount_mode"),
    discount_value: arrowText(body, "discount_value"),
    freight: arrowText(body, "freight"),
    other_expenses: arrowText(body, "other_expenses"),
    totals: arrowJson(body, "totals"),
    contact_document: pgLeft(arrowText(snapshot, "document") ?? "", 20),
    items,
    payments,
  };
}

/** erp_pos.returns_view(venda): as devoluções, da mais antiga para a mais nova. */
export function returnsView(db: SqlDriver, sale: string): Json[] {
  const rows = db
    .exec(
      `SELECT id, CAST(created_at AS TEXT) created_at, CAST(value_cents AS TEXT) value_cents, CAST(refund_cents AS TEXT) refund_cents, reason, items,
         actor, stock_movement_id, refund_account_id FROM "erp_pos__sale_return" WHERE sale_id=?`,
      sale,
    )
    .rows.sort(by<Row>((a, b) => cmpInt(a.created_at, b.created_at), (a, b) => cmpText(a.id, b.id)));
  return rows.map((r) => ({
    id: r.id,
    created_at: ts(r.created_at),
    value_cents: r.value_cents,
    refund_cents: r.refund_cents,
    reason: r.reason,
    items: ((json(r.items) ?? []) as unknown[]).map((l) => ({
      item_id: arrowText(l, "item_id"),
      quantity: arrowText(l, "quantity"),
      value_cents: arrowText(l, "value_cents"),
    })),
    actor_name: actorLabel(db, String(r.actor)),
    stock: r.stock_movement_id !== null,
    refund_account_id: r.refund_account_id,
  }));
}

/** erp_pos.returned(venda): quantidade devolvida por item ({item_id: soma}). */
export function returned(db: SqlDriver, sale: string): Json {
  const sums = new Map<string | null, Dec>();
  for (const r of db.exec('SELECT items FROM "erp_pos__sale_return" WHERE sale_id=?', sale).rows)
    for (const l of (json(r.items) ?? []) as unknown[]) {
      const id = arrowText(l, "item_id");
      const q = arrowText(l, "quantity");
      const prev = sums.get(id);
      if (q === null) {
        if (!sums.has(id)) sums.set(id, null as unknown as Dec);
        continue;
      }
      sums.set(id, prev ? decAdd(prev, dec(q)) : dec(q));
    }
  const out: Json = {};
  for (const [id, total] of sums) {
    if (id === null) raise("22023", "field name must not be null");
    out[id!] = total ? decText(total) : null;
  }
  return out;
}
