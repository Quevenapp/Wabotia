// Listas de preço (erp_pricing): as funções internas que os RPCs usam.
// Portado de erp_pricing.require, hash, replay, header, rule_text,
// valid_now, list_price, contact_uf e list_applies (versões finais no
// oráculo; fecho por scripts/erp/call-graph.mjs).
//
// Ordem "fold(nome), id": collation C do oráculo = bytes UTF-8, em TS
// (compareText), porque a coluna __fold das linhas copiadas pelo harness vem
// nula e a ordem precisa valer sem ela.
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { compareText } from "../fields.ts";
import { fold } from "../internal.ts";
import { requireAccess } from "./deps.ts";
import { add, atLeastZero, mul, neg, num, numeric18_2, round, shift, type Num } from "./money.ts";

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

export interface PriceList {
  id: string;
  name: string;
  category: string;
  list_type: string;
  /** numeric(…,4)::text ou null */
  factor: string | null;
  factor_unit: string;
  direction: string;
  considers_datetime: boolean;
  starts_on: string | null;
  ends_on: string | null;
  /** time::text "HH:MM:SS" */
  start_time: string | null;
  end_time: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const LIST_COLUMNS = `id, name, category, list_type, CAST(factor AS TEXT) factor, factor_unit, direction, considers_datetime,
  starts_on, ends_on, start_time, end_time, CAST(version AS TEXT) version, CAST(created_at AS TEXT) created_at,
  CAST(updated_at AS TEXT) updated_at`;

function toList(r: Record<string, unknown>): PriceList {
  return {
    id: String(r.id),
    name: String(r.name),
    category: String(r.category),
    list_type: String(r.list_type),
    factor: r.factor === null ? null : formatScaled(fromColumn(r.factor), 4),
    factor_unit: String(r.factor_unit),
    direction: String(r.direction),
    considers_datetime: Number(r.considers_datetime) === 1,
    starts_on: (r.starts_on as string | null) ?? null,
    ends_on: (r.ends_on as string | null) ?? null,
    start_time: (r.start_time as string | null) ?? null,
    end_time: (r.end_time as string | null) ?? null,
    version: Number(r.version),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function loadList(db: SqlDriver, id: string | null): PriceList | null {
  if (id === null) return null;
  const r = one(db, `SELECT ${LIST_COLUMNS} FROM "erp_pricing__price_list" WHERE id=?`, id);
  return r ? toList(r) : null;
}

export const allLists = (db: SqlDriver): PriceList[] =>
  db.exec(`SELECT ${LIST_COLUMNS} FROM "erp_pricing__price_list"`).rows.map(toList);

/** Ordem fold(nome), id (collation C). */
export const byFoldedName = <T>(name: (x: T) => string, id: (x: T) => string) => (a: T, b: T) =>
  compareText(fold(name(a))!, fold(name(b))!) || compareText(id(a), id(b));

/**
 * CHECK pendente na paridade (report.generated.json), garantido aqui com o
 * erro do Postgres: price_list_factor_check (factor > 0; a validação do RPC
 * deixa fator 0 na lista customizada) e price_list_item_custom_price_check
 * (0 ≤ preço < 10^14; o reajuste em massa pode passar). price_list_check1 e
 * price_list_name_check já são garantidos pela validação do RPC.
 */
export function checkViolation(table: string, constraint: string): never {
  raise("23514", `new row for relation "${table}" violates check constraint "${constraint}"`);
}

/** erp_pricing.require: erp_catalog.require_access(p_user_id,'products',p_write). */
export const requirePricing = (db: SqlDriver, user: string | null, write: boolean) =>
  requireAccess(db, user, "products", write);

// ---------------------------------------------------------------------------
// Recibo do comando (erp_pricing.command)

/** erp_pricing.replay: null sem recibo; outro ator ou pedido → 40001. */
export function replay(ctx: RpcContext, user: string, command: string | null, hash: string) {
  if (command === null) raise("22023", "erp_pricing_invalid_command");
  const row = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_pricing__command" WHERE command_id=?', command);
  if (!row) return null;
  if (row.actor !== user || row.request_hash !== hash) raise("40001", "erp_pricing_command_conflict");
  return { ...(JSON.parse(String(row.result)) as Record<string, unknown>), replayed: true };
}

export function storeCommand(ctx: RpcContext, user: string, command: string, hash: string, result: unknown) {
  ctx.db.exec(
    'INSERT INTO "erp_pricing__command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)',
    command,
    user,
    hash,
    jsonbText(result),
    ctx.clock.next().toString(),
  );
}

export function audit(
  ctx: RpcContext,
  row: { actor: string; command: string; list: string; action: string; before: unknown; after: unknown },
) {
  ctx.db.exec(
    `INSERT INTO "erp_pricing__audit"(actor, command_id, list_id, action, before_data, after_data, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    row.actor,
    row.command,
    row.list,
    row.action,
    row.before === null ? null : jsonbText(row.before),
    row.after === null ? null : jsonbText(row.after),
    ctx.clock.next().toString(),
  );
}

/** Versão +1 com quem e quando (version_exhausted conferido por quem chama). */
export function bumpVersion(ctx: RpcContext, id: string, user: string) {
  ctx.db.exec(
    'UPDATE "erp_pricing__price_list" SET version=version+1, updated_by=?, updated_at=? WHERE id=?',
    user,
    ctx.clock.next().toString(),
    id,
  );
}

// ---------------------------------------------------------------------------
// Regra, vigência e preço

/** trim_scale(numeric)::text */
const trimScale = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);

/** erp_pricing.rule_text */
export function ruleText(l: PriceList): string | null {
  if (l.list_type === "custom") return "Customizada";
  if (l.factor === null) return null;
  const head = l.direction === "increase" ? "Acréscimo " : "Desconto ";
  if (l.factor_unit === "percent") return `${head}${trimScale(l.factor).replace(".", ",")} %`;
  // to_char(factor,'FM999999999990.00'): arredonda a 2 casas.
  const r = round(num(l.factor), 2);
  const digits = r.v.toString().padStart(3, "0");
  return `${head}R$ ${digits.slice(0, -2)},${digits.slice(-2)}`;
}

const localFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** clock_timestamp() at time zone 'America/Sao_Paulo': "AAAA-MM-DD HH:MM:SS.mmm". */
export function nowSaoPaulo(at = Date.now()) {
  const p = Object.fromEntries(localFormat.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, stamp: `${date} ${p.hour}:${p.minute}:${p.second}.${String(at % 1000).padStart(3, "0")}` };
}

const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", timeZoneName: "longOffset" });

/** Deslocamento de São Paulo no instante, em ms ("GMT-03:00" → -3 h). */
function offsetAt(ms: number) {
  const name = offsetFormat.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/**
 * (data)::timestamp at time zone 'America/Sao_Paulo' em microssegundos UTC.
 * Meia-noite que não existe (início do horário de verão até 2019) usa o
 * deslocamento de antes da virada, como o Postgres.
 */
export function saoPauloMidnight(date: string): bigint {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const before = offsetAt(utc + 3 * 3_600_000 - 1);
  return BigInt(utc - before) * 1000n;
}

/** erp_pricing.valid_now */
export function validNow(l: PriceList, at = Date.now()): boolean {
  const now = nowSaoPaulo(at);
  if (l.starts_on !== null && l.starts_on > now.date) return false;
  if (l.ends_on !== null && l.ends_on < now.date) return false;
  if (!l.considers_datetime) return true;
  if (l.start_time !== null && l.starts_on !== null && now.stamp < `${l.starts_on} ${l.start_time}`) return false;
  if (l.end_time !== null && l.ends_on !== null && now.stamp > `${l.ends_on} ${l.end_time}`) return false;
  return true;
}

/** base·(100 ± fator)/100 ou base ± fator, conforme a lista. */
function applyFactor(base: Num, unit: string, increase: boolean, factor: Num): Num {
  const signed = increase ? factor : neg(factor);
  return unit === "percent" ? add(base, shift(mul(base, signed), 2)) : add(base, signed);
}

/** erp_pricing.list_price(…)::numeric(18,2)::text */
export function listPrice(l: PriceList, base: string | null, custom: string | null): string | null {
  if (l.list_type === "custom") {
    const v = custom ?? base;
    return v === null ? null : numeric18_2(num(v));
  }
  if (base === null || l.factor === null) return null;
  return numeric18_2(atLeastZero(round(applyFactor(num(base), l.factor_unit, l.direction === "increase", num(l.factor)), 2)));
}

/** greatest(0, round(…, 2)) do reajuste em massa (preço da lista customizada). */
export function adjusted(base: Num, action: string, unit: string, value: Num): Num {
  const r = action === "fix" ? round(value, 2) : round(applyFactor(base, unit, action === "increase", value), 2);
  return atLeastZero(r);
}

// ---------------------------------------------------------------------------
// Cabeçalho

/** erp_pricing.header(p_id) */
export function header(db: SqlDriver, id: string): Record<string, unknown> | null {
  const l = loadList(db, id);
  if (!l) return null;
  const named = (sql: string) =>
    db
      .exec(sql, id)
      .rows.map((r) => ({ id: String(r.id), name: String(r.name) }))
      .sort(byFoldedName((x) => x.name, (x) => x.id));
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    list_type: l.list_type,
    factor: l.factor,
    factor_unit: l.factor_unit,
    direction: l.direction,
    considers_datetime: l.considers_datetime,
    starts_on: l.starts_on,
    ends_on: l.ends_on,
    start_time: l.start_time === null ? null : l.start_time.slice(0, 5),
    end_time: l.end_time === null ? null : l.end_time.slice(0, 5),
    version: l.version,
    created_at: jsonTimestamp(l.created_at),
    updated_at: jsonTimestamp(l.updated_at),
    rule: ruleText(l),
    products: Number(one(db, 'SELECT count(*) n FROM "erp_pricing__price_list_item" WHERE list_id=?', id)!.n),
    contacts: named(
      `SELECT c.contact_id id, r.name FROM "erp_pricing__price_list_contact" c JOIN "erp_catalog__record" r ON r.id=c.contact_id WHERE c.list_id=?`,
    ),
    sellers: named(
      `SELECT s.seller_id id, r.name FROM "erp_pricing__price_list_seller" s JOIN "erp_catalog__seller" x ON x.id=s.seller_id
       JOIN "erp_catalog__record" r ON r.id=x.contact_id WHERE s.list_id=?`,
    ),
    payment_methods: named(
      `SELECT m.payment_method_id id, p.description name FROM "erp_pricing__price_list_payment_method" m
       JOIN "erp_catalog__payment_method" p ON p.id=m.payment_method_id WHERE m.list_id=?`,
    ),
    regions: db
      .exec('SELECT state FROM "erp_pricing__price_list_region" WHERE list_id=?', id)
      .rows.map((r) => String(r.state))
      .sort(compareText),
  };
}

/** header(l.id) - 'contacts' - 'sellers' - 'payment_methods' - 'regions' (listagens). */
export function leanHeader(db: SqlDriver, id: string) {
  const { contacts: _c, sellers: _s, payment_methods: _m, regions: _r, ...rest } = header(db, id)!;
  return rest;
}

/** Produto que existe e não está excluído (pode entrar numa lista). */
export const liveProduct = (db: SqlDriver, id: string) =>
  one(
    db,
    `SELECT 1 x FROM "erp_catalog__product" p WHERE p.record_id=?
     AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=p.record_id AND d.deleted_at IS NOT NULL)`,
    id,
  ) !== null;

// ---------------------------------------------------------------------------
// Listas aplicáveis

/** erp_pricing.contact_uf: upper(state) do contato, se for uma UF. */
export function contactUf(db: SqlDriver, contact: string | null): string | null {
  if (contact === null) return null;
  const r = one(db, 'SELECT state FROM "erp_catalog__contact" WHERE record_id=?', contact);
  if (!r || r.state === null) return null;
  const uf = String(r.state).toUpperCase();
  return UFS.includes(uf) ? uf : null;
}

const linked = (db: SqlDriver, table: string, column: string, list: string, value: string) =>
  one(db, `SELECT 1 x FROM "${table}" WHERE list_id=? AND ${column}=?`, list, value) !== null;

/** O caso de cada categoria (contato, região, vendedor, forma de pagamento). */
export function categoryApplies(
  db: SqlDriver,
  l: PriceList,
  contact: string | null,
  seller: string | null,
  methods: string[],
  state: string | null,
): boolean {
  switch (l.category) {
    case "other":
      return true;
    case "contact":
      return contact !== null && linked(db, "erp_pricing__price_list_contact", "contact_id", l.id, contact);
    case "region":
      return state !== null && linked(db, "erp_pricing__price_list_region", "state", l.id, state);
    case "seller":
      return seller !== null && linked(db, "erp_pricing__price_list_seller", "seller_id", l.id, seller);
    case "payment_method":
      return methods.some((m) => linked(db, "erp_pricing__price_list_payment_method", "payment_method_id", l.id, m));
    default:
      return false;
  }
}
