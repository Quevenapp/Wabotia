// Listagem de contatos: erp_catalog.page_valid, contact_filter_valid,
// sale_statuses_valid, digits, contact_where (filtros), page_order (ordem em
// collation C) e contact_list_item. O SQL dinâmico do Fagoo (page_sql) vira
// filtro e ordem em TS sobre as linhas de contato (o mesmo resultado).
// "Sem compras no período" lê os pedidos de venda pelo public.ts de Documentos.
import type { SqlDriver } from "../../engine/driver.ts";
import { jsonTimestamp, saoPauloMidnight } from "../../engine/time.ts";
import * as documents from "../documents/public.ts";
import { SOURCE_SITUATION_SQL, contactSituation, contactSourceSituation } from "./contact.ts";
import { contactTypeSlugs } from "./contact-core.ts";
import { CNTRL, btrim, chars, lower, matches, upper } from "./fields.ts";
import { fold } from "./internal.ts";

type Row = Record<string, unknown>;
const SORTS = ["created_desc", "name_asc", "name_desc", "code_asc", "code_desc"];
const SALE_STATUSES = ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"];
const inRange = (d: string) => d >= "1900-01-01" && d <= "2100-12-31";

/** erp_catalog.digits */
export const digits = (v: string | null) => (v ?? "").replace(/[^0-9]/g, "");

/** erp_catalog.page_valid(p_page, p_size, p_sort, p_query, p_period, p_from, p_to) */
export function pageValid(
  page: number | null, size: number | null, sort: string | null, query: string | null,
  period: string | null, from: string | null, to: string | null,
): boolean {
  if (page === null || page < 1 || page > 100000 || size === null || size < 1 || size > 100) return false;
  if (sort === null || !SORTS.includes(sort)) return false;
  if (query !== null && (chars(query) > 120 || CNTRL.test(query))) return false;
  return periodValid(period, from, to, ["created", "updated"]);
}

function periodValid(period: string | null, from: string | null, to: string | null, kinds: string[]): boolean {
  const none = period === null && from === null && to === null;
  if (!none && !(period !== null && kinds.includes(period) && (from !== null || to !== null))) return false;
  if (from !== null && !inRange(from)) return false;
  if (to !== null && !inRange(to)) return false;
  return from === null || to === null || from <= to;
}

/** erp_catalog.sale_statuses_valid(p_statuses) */
export function saleStatusesValid(statuses: (string | null)[] | null): boolean {
  if (statuses === null) return true;
  return (
    statuses.length >= 1 && statuses.length <= 7 && statuses.every((s) => s !== null && SALE_STATUSES.includes(s)) &&
    new Set(statuses).size === statuses.length
  );
}

/** erp_catalog.contact_filter_valid(…) */
export function contactFilterValid(
  db: SqlDriver,
  f: {
    situation: string | null; type: string | null; personType: string | null; state: string | null; city: string | null;
    phone: string | null; email: string | null; period: string | null; from: string | null; to: string | null;
    statuses: (string | null)[] | null;
  },
): boolean {
  if (f.situation === null || !["latest", "all", "A", "I", "S", "E"].includes(f.situation)) return false;
  if (
    f.type !== null && f.type !== "none" &&
    !db.exec('SELECT 1 x FROM "erp_catalog__contact_type" WHERE slug=? AND active=1', f.type).rows.length
  )
    return false;
  if (f.personType !== null && !["F", "J", "E"].includes(f.personType)) return false;
  if (f.state !== null && !/^[A-Z]{2}$/.test(f.state)) return false;
  if (f.city !== null && (chars(f.city) > 100 || CNTRL.test(f.city))) return false;
  if (f.phone !== null && (chars(f.phone) > 40 || CNTRL.test(f.phone) || !/[0-9]/.test(f.phone))) return false;
  if (f.email !== null && (chars(f.email) > 254 || CNTRL.test(f.email))) return false;
  if (!periodValid(f.period, f.from, f.to, ["created", "updated", "next_visit", "no_purchases"])) return false;
  if (f.statuses !== null && f.period !== "no_purchases") return false;
  return saleStatusesValid(f.statuses);
}

/** (p_day + 1) para date AAAA-MM-DD. */
function nextDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface ContactFilter {
  situation: string;
  terms: string[] | null;
  type: string | null;
  personType: string | null;
  state: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  seller: string | null;
  scope: string | null;
  period: string | null;
  from: string | null;
  to: string | null;
  statuses: string[] | null;
  /**
   * Condição a mais no WHERE (aliases r, c, cp), com os parâmetros: o
   * seller_page acrescenta "é vendedor", como o Fagoo faz sobre o contact_where.
   */
  extra?: { sql: string; params: unknown[] } | null;
  /** ORDER BY no lugar do page_order (aniversariantes: mês/dia, nome, id). */
  order?: string | null;
}

/**
 * erp_catalog.contact_tag_where (etiqueta, "none" = sem etiqueta; lista de
 * preço por contato ou por UF) como condição extra do contactPage.
 */
export function contactTagCondition(tag: string | null, priceList: string | null): { sql: string; params: unknown[] } {
  return {
    sql: `(? IS NULL OR CASE WHEN ?='none' THEN NOT EXISTS(SELECT 1 FROM "erp_catalog__contact_tag" x WHERE x.record_id=r.id)
        ELSE EXISTS(SELECT 1 FROM "erp_catalog__contact_tag" x WHERE x.record_id=r.id AND x.tag_id=?) END)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM "erp_pricing__price_list_contact" pc WHERE pc.list_id=? AND pc.contact_id=r.id)
        OR EXISTS(SELECT 1 FROM "erp_pricing__price_list_region" pg WHERE pg.list_id=? AND pg.state=upper(trim(c.state,' '))))`,
    params: [tag, tag, tag, priceList, priceList, priceList],
  };
}

/** erp_catalog.contact_tag_filter_valid(p_tag) */
export const contactTagFilterValid = (tag: string | null) =>
  tag === null || tag === "none" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tag);

/** erp_catalog.contact_situation(r.active, coalesce(cp.situation, contact_source_situation(r.id))) em SQL. */
const SITUATION_SQL = `(CASE WHEN r.active=1
  THEN (CASE WHEN coalesce(cp.situation, ${SOURCE_SITUATION_SQL("r.id")})='S' THEN 'S' ELSE 'A' END)
  ELSE (CASE WHEN coalesce(cp.situation, ${SOURCE_SITUATION_SQL("r.id")})='E' THEN 'E' ELSE 'I' END) END)`;
/** page_order em SQL: __fold e id em BINARY (a collation C do oráculo). */
const ORDER_SQL: Record<string, string> = {
  created_desc: "r.created_at DESC, r.id DESC",
  name_asc: "r.name__fold, r.id",
  name_desc: "r.name__fold DESC, r.id DESC",
  code_asc: "r.code__fold IS NULL, r.code__fold, r.id",
  code_desc: "r.code__fold IS NULL, r.code__fold DESC, r.id DESC",
};

/**
 * erp_catalog.contact_where + page_sql: total e a página de ids. O que tem
 * semântica exata no SQLite (situação, tipo, pessoa, vendedor, carteira,
 * períodos, sem compras) filtra no SQL, com a ordem e a paginação lá. Busca,
 * UF, cidade, telefone e e-mail usam fold/upper/\s do Postgres: quando algum
 * deles vem, o SQL devolve as linhas já ordenadas e o filtro e a página
 * acontecem em TS.
 */
export function contactPage(db: SqlDriver, f: ContactFilter, sort: string, offset: number, limit: number): { total: number; ids: string[] } {
  const where: string[] = ["r.entity='contacts'"];
  const params: unknown[] = [];
  if (f.situation === "latest") where.push(`${SITUATION_SQL}<>'E'`);
  else if (f.situation !== "all") (where.push(`${SITUATION_SQL}=?`), params.push(f.situation));
  if (f.type === "none")
    where.push(`json_array_length(c.roles)=0 AND NOT EXISTS(SELECT 1 FROM "erp_catalog__contact_type_link" l
      JOIN "erp_catalog__contact_type" t ON t.id=l.type_id WHERE l.contact_id=r.id AND t.active=1)`);
  else if (f.type !== null && ["customer", "supplier", "carrier"].includes(f.type))
    (where.push("EXISTS(SELECT 1 FROM json_each(c.roles) x WHERE x.value=?)"), params.push(f.type));
  else if (f.type !== null)
    (where.push(`EXISTS(SELECT 1 FROM "erp_catalog__contact_type_link" l JOIN "erp_catalog__contact_type" t ON t.id=l.type_id
      WHERE l.contact_id=r.id AND t.slug=?)`), params.push(f.type));
  if (f.personType !== null) (where.push("c.person_type=?"), params.push(f.personType));
  if (f.seller !== null) (where.push("cp.seller_id=?"), params.push(f.seller));
  if (f.scope !== null) (where.push("cp.seller_id=?"), params.push(f.scope));
  if (f.period === "created" || f.period === "updated") {
    const col = f.period === "created" ? "r.created_at" : "r.updated_at";
    if (f.from !== null) (where.push(`${col}>=?`), params.push(saoPauloMidnight(f.from).toString()));
    if (f.to !== null) (where.push(`${col}<?`), params.push(saoPauloMidnight(nextDay(f.to)).toString()));
  } else if (f.period === "next_visit") {
    where.push("cp.next_visit IS NOT NULL");
    if (f.from !== null) (where.push("cp.next_visit>=?"), params.push(f.from));
    if (f.to !== null) (where.push("cp.next_visit<=?"), params.push(f.to));
  } else if (f.period === "no_purchases") {
    const c = documents.salesInPeriodCondition("r.id", f.from, f.to, f.statuses);
    where.push(`NOT ${c.sql}`);
    params.push(...c.params);
  }
  if (f.extra) (where.push(`(${f.extra.sql})`), params.push(...f.extra.params));
  const from = `FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
    LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE ${where.join(" AND ")}`;
  const order = f.order ?? ORDER_SQL[sort];
  const inTs = f.terms !== null || f.state !== null || f.city !== null || f.phone !== null || f.email !== null;
  if (!inTs) {
    const total = Number(db.exec(`SELECT count(*) n ${from}`, ...params).rows[0].n);
    const ids = db.exec(`SELECT r.id ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).rows.map((r) => String(r.id));
    return { total, ids };
  }
  const rows = db.exec(
    `SELECT r.id, r.name, r.code, c.trade_name, c.email, c.document, c.phone, c.mobile, c.state, c.city, cp.fax ${from} ORDER BY ${order}`,
    ...params,
  ).rows;
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const city = f.city === null ? null : fold(f.city)!;
  const email = f.email === null ? null : fold(f.email)!;
  const kept = rows.filter((r) => {
    if (f.terms !== null) {
      const text = fold([r.name, r.code, r.trade_name, r.email, r.document, r.phone, r.mobile].map(s).filter((x) => x !== null).join(" "));
      const compactDoc = lower(s(r.document) ?? "").replace(/[^0-9a-z]/g, "");
      const digitText = [r.document, r.phone, r.mobile, r.fax].map(s).filter((x) => x !== null).join("|").replace(/[^0-9|]/g, "");
      if (!matches(f.terms, text, compactDoc, digitText)) return false;
    }
    if (f.state !== null && (r.state === null || upper(btrim(String(r.state))) !== f.state)) return false;
    if (city !== null && !fold(s(r.city) ?? "")!.includes(city)) return false;
    if (f.phone !== null) {
      const phones = [r.phone, r.mobile, r.fax].map(s).filter((x) => x !== null).join("|").replace(/[^0-9|]/g, "");
      if (!phones.includes(f.phone)) return false;
    }
    if (email !== null && !fold(s(r.email) ?? "")!.includes(email)) return false;
    return true;
  });
  return { total: kept.length, ids: kept.slice(offset, offset + limit).map((r) => String(r.id)) };
}
/** erp_catalog.contact_list_item(p_id) */
export function contactListItem(db: SqlDriver, id: string): Row | null {
  const r = db.exec(
    `SELECT r.id, r.active, CAST(r.version AS TEXT) version, r.name, r.code, CAST(r.created_at AS TEXT) created_at,
     CAST(r.updated_at AS TEXT) updated_at, c.trade_name, c.person_type, c.document, c.email, c.phone, c.mobile, c.city, c.state, c.roles,
     cp.situation, cp.crt, cp.seller_id, cp.next_visit
     FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
     LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE r.id=?`,
    id,
  ).rows[0];
  if (!r) return null;
  const origin = db.exec('SELECT source_id, state FROM "erp_catalog__origin" WHERE record_id=?', id).rows[0];
  const seller =
    r.seller_id === null || r.seller_id === undefined
      ? null
      : db.exec('SELECT sr.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" sr ON sr.id=s.contact_id WHERE s.id=?', r.seller_id).rows[0];
  return {
    id: r.id,
    entity: "contacts",
    active: !!Number(r.active),
    version: Number(r.version),
    name: r.name,
    code: r.code ?? null,
    created_at: jsonTimestamp(String(r.created_at)),
    updated_at: jsonTimestamp(String(r.updated_at)),
    situation: contactSituation(!!Number(r.active), (r.situation as string | null) ?? contactSourceSituation(db, id)),
    source: origin ? { system: "origin", source_id: origin.source_id, state: origin.state } : null,
    trade_name: r.trade_name ?? null,
    person_type: r.person_type ?? null,
    document: r.document ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    mobile: r.mobile ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    roles: JSON.parse(String(r.roles)),
    types: contactTypeSlugs(db, id),
    crt: r.crt ?? null,
    seller_id: r.seller_id ?? null,
    seller_name: seller ? seller.name : null,
    next_visit: r.next_visit ?? null,
    is_seller: db.exec('SELECT 1 x FROM "erp_catalog__seller" WHERE contact_id=?', id).rows.length > 0,
  };
}
