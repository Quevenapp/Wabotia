// Empresa (erp_company): validação, normalização, DTOs e camada de tabela.
// Portado das migrações do Fagoo (fecho em docs/erp-closure-map.json).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { activeRole } from "../access/public.ts";

export const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
export const btrim = (s: string) => s.replace(/^ +| +$/g, "");
export const chars = (s: string) => [...s].length;
export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as number));
/** jsonb igual (forma canônica). */
export const sameJson = (a: unknown, b: unknown) => jsonbText(a) === jsonbText(b);
const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

/** erp_company.require_access(p_user, p_operation): read, identity (admin) ou fiscal (admin, fiscal). */
export function requireAccess(db: SqlDriver, user: string, operation: string | null): string {
  const role = activeRole(db, user);
  if (
    !role ||
    operation === null ||
    !["read", "identity", "fiscal"].includes(operation) ||
    (operation === "identity" && role !== "admin") ||
    (operation === "fiscal" && !["admin", "fiscal"].includes(role))
  )
    raise("42501", "erp_company_forbidden");
  return role;
}

// ---------------------------------------------------------------------------
// Documentos

/** erp_company.cpf_valid */
export function cpfValid(p: string | null): boolean {
  if (p === null || !/^[0-9]{11}$/.test(p) || /^([0-9])\1{10}$/.test(p)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 1; i <= n; i++) s += Number(p[i - 1]) * (n + 2 - i);
    let d = (s * 10) % 11;
    if (d === 10) d = 0;
    if (d !== Number(p[n])) return false;
  }
  return true;
}

/** erp_company.cpf: 11 dígitos, com ou sem máscara. */
export function cpf(input: string | null): string {
  const v = input === null ? null : btrim(input);
  if (v === null || !/^([0-9]{11}|[0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2})$/.test(v)) raise("22023", "erp_company_cpf_invalid");
  const digits = v.replace(/[.-]/g, "");
  if (!cpfValid(digits)) raise("22023", "erp_company_cpf_invalid");
  return digits;
}

/** erp_company.cnpj: alfanumérico (regra de 2026), dígitos verificadores pelo código ASCII − 48. */
export function cnpj(input: string | null): string {
  const raw = input === null ? null : btrim(input).toUpperCase();
  if (raw === null || !/^([A-Z0-9]{12}[0-9]{2}|[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-[0-9]{2})$/.test(raw))
    raise("22023", "erp_company_cnpj_invalid");
  const v = raw.replace(/[./-]/g, "");
  if (/^([0-9])\1{13}$/.test(v)) raise("22023", "erp_company_cnpj_invalid");
  let base = v.slice(0, 12);
  for (let j = 0; j < 2; j++) {
    let sum = 0,
      weight = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += (base.charCodeAt(i) - 48) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const r = sum % 11;
    base += String(r < 2 ? 0 : 11 - r);
  }
  if (base !== v) raise("22023", "erp_company_cnpj_invalid");
  return v;
}

/** erp_company.document(p_input, p_kind): cpf, cnpj ou any (CPF pela forma). */
export function document(input: string | null, kind: string): string {
  if (kind === "cpf" || (kind === "any" && input !== null && /^([0-9]{11}|[0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2})$/.test(btrim(input))))
    return cpf(input);
  if (!["cnpj", "any"].includes(kind)) raise("22023", "erp_company_data_invalid");
  return cnpj(input);
}

// ---------------------------------------------------------------------------
// Identidade

const FIELDS: Record<string, number> = {
  legal_name: 200, trade_name: 200, cnpj: 18, ie: 30, postal_code: 9, street: 200, number: 30, complement: 200,
  district: 100, city: 100, municipality_code: 7, state: 2, phone: 40, email: 254,
};
const REQUIRED = ["legal_name", "cnpj", "postal_code", "street", "number", "district", "city", "municipality_code", "state"];
const STATES: Record<string, string> = {
  RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24", PB: "25",
  PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50",
  MT: "51", GO: "52", DF: "53",
};

/** erp_company.normalize_identity(p_data, p_document) */
export function normalizeIdentity(data: unknown, kind: string): Record<string, string | null> {
  if (
    data === null ||
    data === undefined ||
    jsonType(data) !== "object" ||
    new TextEncoder().encode(jsonbText(data)).length > 16384 ||
    Object.keys(data as object).some((k) => !(k in FIELDS))
  )
    raise("22023", "erp_company_data_invalid");
  const input = data as Record<string, unknown>;
  const v: Record<string, string | null> = {};
  for (const k of jsonbKeys(FIELDS)) {
    let t: string | null = null;
    if (k in input && input[k] !== null) {
      if (jsonType(input[k]) !== "string") raise("22023", "erp_company_field_invalid");
      const raw = input[k] as string;
      if (chars(raw) > FIELDS[k] || CNTRL.test(raw)) raise("22023", "erp_company_field_invalid");
      t = btrim(raw) || null;
    }
    if (REQUIRED.includes(k) && t === null) raise("22023", "erp_company_field_required");
    v[k] = t;
  }
  v.cnpj = document(v.cnpj, kind);
  const state = (v.state ?? "").toUpperCase();
  if (!(state in STATES)) raise("22023", "erp_company_state_invalid");
  const postal = v.postal_code!;
  if (!/^[0-9]{5}-?[0-9]{3}$/.test(postal) || postal.replace("-", "") === "00000000") raise("22023", "erp_company_address_invalid");
  v.state = state;
  v.postal_code = postal.replace(/-/g, "");
  if (!/^[0-9]{7}$/.test(v.municipality_code!) || v.municipality_code!.slice(0, 2) !== STATES[state])
    raise("22023", "erp_company_address_invalid");
  if (v.email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) raise("22023", "erp_company_email_invalid");
  if (v.phone !== null) {
    const phone = v.phone.replace(/[ ()\-.]/g, "");
    if (!/^\+?[0-9]{8,15}$/.test(phone)) raise("22023", "erp_company_phone_invalid");
    v.phone = phone;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Dados complementares e sócios

/** erp_company.extra_text(p, p_max, p_pattern) */
export function extraText(p: unknown, max: number, pattern?: RegExp): string | null {
  if (p === null || p === undefined) return null;
  if (jsonType(p) !== "string") raise("22023", "erp_company_extra_invalid");
  const v = p as string;
  if (v === "") return null;
  if (chars(v) > max || v !== btrim(v) || CNTRL.test(v) || (pattern && !pattern.test(v))) raise("22023", "erp_company_extra_invalid");
  return v;
}

/** erp_company.extra_choice(p, p_options) */
export function extraChoice(p: unknown, options: string[]): string | null {
  if (p === null || p === undefined) return null;
  if (jsonType(p) !== "string" || !options.includes(p as string)) raise("22023", "erp_company_extra_invalid");
  return p as string;
}

const EXTRA_KEYS = [
  "billing_email", "cnae", "company_size", "contacts", "employees", "ie_exempt", "mobile", "municipal_registration",
  "person_type", "revenue", "segments", "site", "substitute_ies", "suframa",
];
const SEGMENTS = ["comercio", "ecommerce", "industria", "servicos"];
const UF = /^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;
const sortedKeys = (o: object) => Object.keys(o).sort();

/** erp_company.extra_normalize */
export function extraNormalize(p: unknown): Record<string, unknown> {
  const o = p as Record<string, any>;
  if (
    p === null ||
    p === undefined ||
    jsonType(p) !== "object" ||
    new TextEncoder().encode(jsonbText(p)).length > 16384 ||
    sortedKeys(o).join(",") !== EXTRA_KEYS.join(",") ||
    jsonType(o.ie_exempt) !== "boolean" ||
    jsonType(o.segments) !== "array" ||
    jsonType(o.substitute_ies) !== "array" ||
    o.substitute_ies.length > 27 ||
    o.segments.some((x: unknown) => jsonType(x) !== "string" || !SEGMENTS.includes(x as string)) ||
    new Set(o.segments).size !== o.segments.length ||
    o.segments.length === 0
  )
    raise("22023", "erp_company_extra_invalid");
  const segments = SEGMENTS.filter((s) => o.segments.includes(s));
  const ies: { uf: string; ie: string }[] = [];
  for (const e of o.substitute_ies) {
    if (
      jsonType(e) !== "object" ||
      sortedKeys(e).join(",") !== "ie,uf" ||
      jsonType(e.uf) !== "string" ||
      jsonType(e.ie) !== "string" ||
      !UF.test(e.uf) ||
      ies.some((x) => x.uf === e.uf) ||
      !/^[0-9A-Za-z./-]{2,20}$/.test(e.ie)
    )
      raise("22023", "erp_company_extra_invalid");
    ies.push({ uf: e.uf, ie: e.ie });
  }
  let cnae = extraText(o.cnae, 9, /^[0-9]{4}-?[0-9]\/?[0-9]{2}$/);
  if (cnae !== null) {
    const d = cnae.replace(/[-/]/g, "");
    cnae = `${d.slice(0, 4)}-${d.slice(4, 5)}/${d.slice(-2)}`;
  }
  return {
    person_type: extraChoice(o.person_type, ["juridica", "fisica"]) ?? "juridica",
    ie_exempt: o.ie_exempt,
    municipal_registration: extraText(o.municipal_registration, 30, /^[0-9A-Za-z./-]+$/),
    suframa: extraText(o.suframa, 12, /^[0-9]{8,12}$/),
    cnae,
    company_size: extraChoice(o.company_size, ["mei", "micro", "pequena", "media", "grande"]),
    segments,
    revenue: extraChoice(o.revenue, ["ate_60k", "de_60k_360k", "acima_360k"]),
    employees: extraChoice(o.employees, ["ate_5", "de_5_10", "mais_10"]),
    contacts: extraText(o.contacts, 120),
    mobile: extraText(o.mobile, 20, /^\+?[0-9() -]{8,20}$/),
    billing_email: extraText(o.billing_email, 254, /^[^@ ]+@[^@ ]+\.[^@ ]+$/),
    site: extraText(o.site, 200, /^[^ ]+\.[^ ]+$/),
    substitute_ies: ies,
  };
}

/** erp_company.partners_normalize */
export function partnersNormalize(p: unknown): Record<string, unknown>[] {
  if (p === null || p === undefined || jsonType(p) !== "array" || (p as unknown[]).length > 20 || new TextEncoder().encode(jsonbText(p)).length > 16384)
    raise("22023", "erp_company_partners_invalid");
  const out: Record<string, unknown>[] = [];
  const cpfs: string[] = [];
  let total = 0n;
  for (const e of p as any[]) {
    if (jsonType(e) !== "object" || sortedKeys(e).join(",") !== "cpf,email,name,phone,role,share") raise("22023", "erp_company_partners_invalid");
    const raw = typeof e.cpf === "string" ? e.cpf : e.cpf === null || e.cpf === undefined ? "" : jsonbText(e.cpf);
    const c = raw.replace(/[.-]/g, "");
    if (jsonType(e.cpf) !== "string" || !cpfValid(c) || cpfs.includes(c)) raise("22023", "erp_company_partners_invalid");
    const share = extraText(e.share, 6, /^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$/);
    const cents = share === null ? null : BigInt(share.split(".")[0]) * 100n + BigInt(((share.split(".")[1] ?? "") + "00").slice(0, 2));
    if (cents !== null && cents > 10000n) raise("22023", "erp_company_partners_invalid");
    total += cents ?? 0n;
    cpfs.push(c);
    // Na ordem dos argumentos do jsonb_build_object (o primeiro erro é o mesmo).
    const name = extraText(e.name, 120);
    const role = extraText(e.role, 60);
    const email = extraText(e.email, 254, /^[^@ ]+@[^@ ]+\.[^@ ]+$/);
    const phone = extraText(e.phone, 20, /^\+?[0-9() -]{8,20}$/);
    const row = {
      name,
      cpf: c,
      share: cents === null ? null : `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`,
      role,
      email: email === null ? null : email.toLowerCase(),
      phone,
    };
    out.push(row);
    if (row.name === null) raise("22023", "erp_company_partners_invalid");
  }
  if (total > 10000n) raise("22023", "erp_company_partners_invalid");
  return out;
}

/** erp_company.person_type: fisica só quando os dados complementares dizem. */
export function personType(db: SqlDriver): "fisica" | "juridica" {
  const row = one(db, 'SELECT data FROM "erp_company__extra" WHERE singleton=1');
  return row && parse(row.data)?.person_type === "fisica" ? "fisica" : "juridica";
}

// ---------------------------------------------------------------------------
// DTOs

export function identityDto(db: SqlDriver) {
  const r = one(db, 'SELECT version, data, created_at, updated_at FROM "erp_company__identity" WHERE singleton=1');
  return r ? { version: r.version, data: parse(r.data), created_at: ts(r.created_at), updated_at: ts(r.updated_at) } : null;
}

export function fiscalDto(db: SqlDriver) {
  const r = one(
    db,
    'SELECT f.version, i.version identity_version, f.crt, f.confirmed_at, f.reason, f.updated_at FROM "erp_company__fiscal" f JOIN "erp_company__identity" i ON i.singleton=f.singleton WHERE f.singleton=1',
  );
  return r
    ? {
        version: r.version,
        identity_version: r.identity_version,
        crt: r.crt,
        confirmed: r.crt !== null,
        confirmed_at: ts(r.confirmed_at),
        reason: r.reason,
        updated_at: ts(r.updated_at),
      }
    : null;
}

export function extraDto(db: SqlDriver) {
  const r = one(db, 'SELECT version, data, updated_at FROM "erp_company__extra" WHERE singleton=1');
  return r ? { version: r.version, data: parse(r.data), updated_at: ts(r.updated_at) } : null;
}

export function partnersDto(db: SqlDriver) {
  const r = one(db, 'SELECT version, data, updated_at FROM "erp_company__partners" WHERE singleton=1');
  return r ? { version: r.version, partners: parse(r.data), updated_at: ts(r.updated_at) } : null;
}

/** Auditoria da empresa (erp_company.audit). */
export function audit(ctx: RpcContext, actor: string, command: string, action: string, before: unknown, after: unknown) {
  ctx.db.exec(
    'INSERT INTO "erp_company__audit"(actor, command_id, action, before_data, after_data, created_at) VALUES(?,?,?,?,?,?)',
    actor,
    command,
    action,
    before === null || before === undefined ? null : JSON.stringify(before),
    after === null || after === undefined ? null : JSON.stringify(after),
    ctx.clock.next().toString(),
  );
}

/** Recibo de comando da empresa (erp_company.command). */
export function command(db: SqlDriver, id: string) {
  const r = one(db, 'SELECT actor, request_hash, result FROM "erp_company__command" WHERE command_id=?', id);
  return r ? { actor: r.actor as string, hash: r.request_hash as string, result: JSON.parse(String(r.result)) } : null;
}
export function saveCommand(ctx: RpcContext, id: string, actor: string, hash: string, result: unknown, at?: bigint) {
  ctx.db.exec(
    'INSERT INTO "erp_company__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    hash,
    JSON.stringify(result),
    (at ?? ctx.clock.next()).toString(),
  );
}
