// Leituras do cadastro genérico: erp_catalog.list_item e a página de
// erp_catalog_page (contatos e depósitos). Filtros exatos, ordem (__fold) e
// página no SQL; busca, UF, cidade, telefone e e-mail com a semântica do
// Postgres em TS, como em contact-list.ts.
import type { SqlDriver } from "../../engine/driver.ts";
import { jsonTimestamp, saoPauloMidnight } from "../../engine/time.ts";
import { btrim, lower, matches, upper } from "./fields.ts";
import { fold, unitPriceNumeric } from "./internal.ts";

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** erp_catalog.list_item(p_id) */
export function listItem(db: SqlDriver, id: string): Row | null {
  const r = db.exec(
    `SELECT id, entity, active, CAST(version AS TEXT) version, name, code, CAST(created_at AS TEXT) created_at,
     CAST(updated_at AS TEXT) updated_at FROM "erp_catalog__record" WHERE id=?`,
    id,
  ).rows[0];
  if (!r) return null;
  const origin = db.exec('SELECT source_id, state FROM "erp_catalog__origin" WHERE record_id=?', id).rows[0];
  const base: Row = {
    id: r.id,
    entity: r.entity,
    active: !!Number(r.active),
    version: Number(r.version),
    name: r.name,
    code: r.code ?? null,
    created_at: jsonTimestamp(String(r.created_at)),
    updated_at: jsonTimestamp(String(r.updated_at)),
    source: origin ? { system: "origin", source_id: origin.source_id, state: origin.state } : null,
  };
  if (r.entity === "contacts") {
    const c = db.exec(
      'SELECT trade_name, person_type, document, email, phone, mobile, city, state, roles FROM "erp_catalog__contact" WHERE record_id=?',
      id,
    ).rows[0];
    return c
      ? {
          ...base, trade_name: c.trade_name ?? null, person_type: c.person_type ?? null, document: c.document ?? null,
          email: c.email ?? null, phone: c.phone ?? null, mobile: c.mobile ?? null, city: c.city ?? null, state: c.state ?? null,
          roles: JSON.parse(String(c.roles)),
        }
      : { ...base, roles: [] };
  }
  if (r.entity === "products") {
    const p = db.exec('SELECT unit, price, kind, format, gtin, brand, ncm FROM "erp_catalog__product" WHERE record_id=?', id).rows[0];
    return p
      ? {
          ...base, unit: p.unit ?? null, price: unitPriceNumeric(p.price, 14), kind: p.kind ?? null, format: p.format ?? null,
          gtin: p.gtin ?? null, brand: p.brand ?? null, ncm: p.ncm ?? null,
        }
      : base;
  }
  return base;
}

const ORDER_SQL: Record<string, string> = {
  created_desc: "r.created_at DESC, r.id DESC",
  name_asc: "r.name__fold, r.id",
  name_desc: "r.name__fold DESC, r.id DESC",
  code_asc: "r.code__fold IS NULL, r.code__fold, r.id",
  code_desc: "r.code__fold IS NULL, r.code__fold DESC, r.id DESC",
};

function nextDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface RecordFilter {
  entity: string;
  active: boolean | null;
  terms: string[] | null;
  role: string | null;
  personType: string | null;
  state: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  period: string | null;
  from: string | null;
  to: string | null;
}

/** O WHERE de erp_catalog_page + page_sql: total e a página de ids. */
export function recordPage(db: SqlDriver, f: RecordFilter, sort: string, offset: number, limit: number): { total: number; ids: string[] } {
  const where = ["r.entity=?"];
  const params: unknown[] = [f.entity];
  if (f.active !== null) (where.push("r.active=?"), params.push(f.active ? 1 : 0));
  if (f.role === "none") where.push("json_array_length(c.roles)=0");
  else if (f.role !== null) (where.push("EXISTS(SELECT 1 FROM json_each(c.roles) x WHERE x.value=?)"), params.push(f.role));
  if (f.personType !== null) (where.push("c.person_type=?"), params.push(f.personType));
  const col = f.period === "updated" ? "r.updated_at" : "r.created_at";
  if (f.from !== null) (where.push(`${col}>=?`), params.push(saoPauloMidnight(f.from).toString()));
  if (f.to !== null) (where.push(`${col}<?`), params.push(saoPauloMidnight(nextDay(f.to)).toString()));
  const from = `FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE ${where.join(" AND ")}`;
  const order = ORDER_SQL[sort];
  if (f.terms === null && f.state === null && f.city === null && f.phone === null && f.email === null) {
    const total = Number(db.exec(`SELECT count(*) n ${from}`, ...params).rows[0].n);
    const ids = db.exec(`SELECT r.id ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).rows.map((r) => String(r.id));
    return { total, ids };
  }
  const rows = db.exec(
    `SELECT r.id, r.name, r.code, c.trade_name, c.email, c.document, c.phone, c.mobile, c.state, c.city ${from} ORDER BY ${order}`,
    ...params,
  ).rows;
  const city = f.city === null ? null : fold(f.city)!;
  const email = f.email === null ? null : fold(f.email)!;
  const kept = rows.filter((r) => {
    if (f.terms !== null) {
      const text = fold([r.name, r.code, r.trade_name, r.email, r.document, r.phone, r.mobile].map(s).filter((x) => x !== null).join(" "));
      const compactDoc = lower(s(r.document) ?? "").replace(/[^0-9a-z]/g, "");
      const digitText = [r.document, r.phone, r.mobile].map(s).filter((x) => x !== null).join("|").replace(/[^0-9|]/g, "");
      if (!matches(f.terms, text, compactDoc, digitText)) return false;
    }
    if (f.state !== null && (r.state === null || upper(btrim(String(r.state))) !== f.state)) return false;
    if (city !== null && !fold(s(r.city) ?? "")!.includes(city)) return false;
    if (f.phone !== null) {
      const phones = [r.phone, r.mobile].map(s).filter((x) => x !== null).join("|").replace(/[^0-9|]/g, "");
      if (!phones.includes(f.phone)) return false;
    }
    if (email !== null && !fold(s(r.email) ?? "")!.includes(email)) return false;
    return true;
  });
  return { total: kept.length, ids: kept.slice(offset, offset + limit).map((r) => String(r.id)) };
}
