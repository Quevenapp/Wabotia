// Núcleo do cadastro de contatos: erp_catalog.contact_input, contact_merge,
// contact_take_code, contact_check_full, contact_required_missing/field,
// contact_field_person_type, document_issue, warnings (ramo de contatos; o de
// produtos é productWarnings), contact_warnings, acknowledged_valid,
// contact_type_slugs, contact_data, contact_dto, contact_write e contact_apply.
// O espelho do Origin: o UPDATE de erp_catalog.origin ('local_modified') do
// contact_apply vai no updateRecord (record.ts); source do dto lê
// erp_catalog.origin (leitura de linha espelhada).
// Categoria financeira e natureza de operação vêm dos public.ts do Financeiro
// e do Fiscal.
import { formatScaled, fromColumn, toParam, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { CUSTOMER_BRIDGE_USER_ID } from "../../engine/identity.ts";
import { customerPhoneVariants, normalizeCustomerPhone } from "../../../customer/phone.ts";
import { jsonbKeys, jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../engine/time.ts";
import { actorLabel } from "../access/public.ts";
import * as finance from "../finance/public.ts";
import * as fiscal from "../fiscal/public.ts";
import * as preferences from "../preferences/public.ts";
import { contactRequireVisible, contactScope, contactSituation, contactSituationOf, contactSourceSituation, contactRequirePrivacy, contactPrivacyVisible } from "./contact.ts";
import { contactCodeCounter, highestContactCode } from "./contact-code.ts";
import {
  SPACES,
  btrim,
  chars,
  compareText,
  contactDate,
  contactEmailList,
  contactText,
  contactUf,
  upper,
  validCnpj,
  validCpf,
} from "./fields.ts";
import { capture, data, insertRecord } from "./internal.ts";
import { paymentConditionValid } from "./payment-method.ts";
import { productWarnings } from "./product-detail.ts";
import { compact, updateRecord } from "./record.ts";

type Json = Record<string, unknown>;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPACE_CLASS = SPACES.source.slice(1, -2); // conteúdo de [ … ] em "[…]+"
const WEBSITE = new RegExp(`^(https?://)?[^${SPACE_CLASS}/?#]+\\.[^${SPACE_CLASS}]+$`, "u");
const MAX_VERSION = 2147483647;

const TEXTS: Record<string, number> = {
  name: 200, code: 100, trade_name: 200, document: 30, ie: 30, email: 254, phone: 40, mobile: 40, postal_code: 20, street: 200,
  number: 30, complement: 200, district: 100, city: 100, municipal_registration: 30, rg: 20, rg_issuer: 20, country: 60,
  foreign_state: 60, fax: 40, nfe_email: 60, website: 200, skype: 100, profession: 100, birthplace: 100, father_name: 200,
  father_cpf: 20, mother_name: 200, mother_cpf: 20, payment_condition: 100, billing_postal_code: 20, billing_city: 100,
  billing_district: 100, billing_street: 200, billing_number: 30, billing_complement: 200, billing_foreign_state: 60, suframa: 9,
};
const ENUMS: Record<string, string[]> = {
  person_type: ["F", "J", "E"],
  situation: ["A", "I", "S"],
  crt: ["1", "2", "3", "4"],
  taxpayer: ["1", "2", "9"],
  carrier_operator: ["claro", "oi", "tim", "vivo", "nextel", "porto_seguro"],
  public_agency: ["municipal", "estadual", "federal"],
  marital_status: ["casado", "solteiro", "viuvo", "separado", "desquitado"],
  gender: ["feminino", "masculino"],
  credit_limit_mode: ["unlimited", "zero", "value"],
};
const invalid = (key: string): never => raise("22023", `erp_catalog_contact_invalid:${key}`);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v));
const empty = (v: unknown) => {
  const s = str(v);
  return s === null || s === "";
};
const unique = (xs: unknown[]) => new Set(xs.map((x) => jsonbText(x))).size === xs.length;

/** Slugs de tipo ativos na ordem do cadastro (position, slug). */
function typeRows(db: SqlDriver) {
  return db
    .exec('SELECT id, slug, role_backed, active, position FROM "erp_catalog__contact_type"')
    .rows.map((t) => ({ id: String(t.id), slug: String(t.slug), roleBacked: !!Number(t.role_backed), active: !!Number(t.active), position: Number(t.position) }))
    .sort((a, b) => a.position - b.position || compareText(a.slug, b.slug));
}

/** erp_catalog.contact_input(p_data, p_before): o patch validado. */
export function contactInput(db: SqlDriver, p: unknown, before: Json): Json {
  if (p === null || p === undefined || jsonType(p) !== "object" || new TextEncoder().encode(jsonbText(p)).length > 32768)
    raise("22023", "erp_catalog_contact_invalid_data");
  const d = p as Json;
  const out: Json = {};
  for (const key of jsonbKeys(d)) {
    const value = d[key];
    if (key in TEXTS) {
      const text = contactText(key, value, TEXTS[key]);
      const changed = text !== str(before[key]);
      if (key === "name" && text === null) raise("22023", "erp_catalog_name_required");
      if (changed && key === "email" && !contactEmailList(text, 254)) invalid("email");
      if (key === "nfe_email" && !contactEmailList(text, 60)) invalid("nfe_email");
      if (key === "website" && text !== null && !WEBSITE.test(text)) invalid("website");
      if (key === "payment_condition" && !paymentConditionValid(text)) invalid("payment_condition");
      out[key] = text;
    } else if (key === "state" || key === "billing_state") {
      const raw = contactText(key, value, 2);
      const text = raw === null ? null : upper(raw);
      const prev = str(before[key]);
      const prevUpper = prev === null ? null : upper(prev);
      // UFs antigas copiadas do Origin ficam como estão até o campo mudar.
      if (text !== prevUpper && !contactUf(text)) invalid(key);
      out[key] = text === prevUpper ? prev : text;
    } else if (key === "notes" || key === "contact_info") {
      out[key] = contactText(key, value, key === "notes" ? 4000 : 400, true);
    } else if (key in ENUMS) {
      const text = contactText(key, value, 20);
      if (text !== null && !ENUMS[key].includes(text)) invalid(key);
      if (key === "credit_limit_mode" && text === null) invalid("credit_limit_mode");
      out[key] = text;
    } else if (key === "ie_exempt") {
      if (jsonType(value) !== "boolean") invalid("ie_exempt");
      out[key] = value;
    } else if (key === "client_since" || key === "next_visit" || key === "birth_date") {
      out[key] = contactDate(key, value);
    } else if (key === "avg_tax_load" || key === "credit_limit") {
      const text = contactText(key, value, 20);
      if (
        text !== null &&
        (!(key === "avg_tax_load" ? /^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$/ : /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/).test(text) ||
          (key === "avg_tax_load" && toScaled(text, 2) > 10000n) ||
          (key === "credit_limit" && toScaled(text, 2) <= 0n))
      )
        invalid(key);
      out[key] = text === null ? null : formatScaled(toScaled(text, 2), 2);
    } else if (key === "finance_category_id" || key === "operation_nature_id" || key === "seller_id") {
      const text = contactText(key, value, 36);
      if (text !== null && !UUID_LOWER.test(text)) invalid(key);
      out[key] = text;
    } else if (key === "roles") {
      const a = value as unknown[];
      if (
        jsonType(value) !== "array" || a.length > 3 ||
        a.some((x) => jsonType(x) !== "string" || !["customer", "supplier", "carrier"].includes(x as string)) || !unique(a)
      )
        raise("22023", "erp_catalog_invalid_roles");
      out.roles = value;
    } else if (key === "types") {
      const a = value as unknown[];
      const types = typeRows(db);
      if (
        jsonType(value) !== "array" || a.length > 40 ||
        a.some((x) => jsonType(x) !== "string" || !types.some((t) => t.active && t.slug === x)) || !unique(a)
      )
        invalid("types");
      out.types = types.filter((t) => a.includes(t.slug)).map((t) => t.slug);
    } else if (key === "persons") {
      const a = value as unknown[];
      if (jsonType(value) !== "array" || a.length > 20 || a.some((x) => jsonType(x) !== "string" || !UUID_LOWER.test(x as string)) || !unique(a))
        invalid("persons");
      out.persons = value;
    } else raise("22023", "erp_catalog_unknown_field");
  }
  return out;
}

/** erp_catalog.contact_merge(p_user_id, p_id, p_data, p_before) */
export function contactMerge(db: SqlDriver, user: string | null, id: string | null, p: unknown, before: Json): Json {
  const patch = contactInput(db, p, before);
  const scope = contactScope(db, user);
  const { roles: _roles, ...rest } = patch;
  const base: Json =
    id === null
      ? {
          situation: "A", types: [], persons: [], ie_exempt: false, credit_limit_mode: "unlimited", taxpayer: "9",
          client_since: todaySaoPaulo(), seller_id: scope,
        }
      : before;
  const v: Json = { ...base, ...rest };
  // Contato novo de um vendedor fica com o vendedor mesmo com Vendedor vazio no formulário.
  if (id === null && scope !== null && (v.seller_id ?? null) === null) v.seller_id = scope;
  // Clientes antigos mandam só roles: os três tipos de papel seguem, os demais ficam.
  if ("roles" in patch && !("types" in patch)) {
    const roles = patch.roles as string[];
    const current = (v.types as string[] | undefined) ?? [];
    v.types = typeRows(db)
      .filter((t) => t.active && ((t.roleBacked && roles.includes(t.slug)) || (!t.roleBacked && current.includes(t.slug))))
      .map((t) => t.slug);
  }
  if (scope !== null && str(v.seller_id) !== scope) raise("42501", "erp_catalog_contact_not_visible");
  return v;
}

/** erp_catalog.contact_take_code(p_user_id): o próximo código sequencial livre. */
export function contactTakeCode(ctx: RpcContext, user: string): string {
  const counter = contactCodeCounter(ctx.db);
  let next = counter?.next ?? highestContactCode(ctx.db) + 1n;
  const used = new Set(
    ctx.db
      .exec(`SELECT code FROM "erp_catalog__record" WHERE entity='contacts' AND length(code) BETWEEN 1 AND 15 AND code NOT GLOB '*[^0-9]*'`)
      .rows.map((r) => BigInt(String(r.code))),
  );
  while (used.has(next)) next++;
  if (next >= 999999999999999n) raise("22023", "erp_catalog_contact_code_exhausted");
  const now = ctx.clock.next().toString();
  if (counter === null)
    ctx.db.exec(
      'INSERT INTO "erp_catalog__contact_code_counter"(id, next_number, version, updated_by, updated_at) VALUES(1,?,1,?,?)',
      (next + 1n).toString(), user, now,
    );
  else
    ctx.db.exec(
      'UPDATE "erp_catalog__contact_code_counter" SET next_number=?, version=version+1, updated_by=?, updated_at=? WHERE id=1',
      (next + 1n).toString(), user, now,
    );
  return next.toString();
}

/** erp_catalog.contact_field_person_type(p_field): o tipo de pessoa do campo. */
export function contactFieldPersonType(field: string): string | null {
  if (["rg", "rg_issuer", "avg_tax_load", "marital_status", "profession", "gender", "birth_date", "birthplace", "father_name", "father_cpf", "mother_name", "mother_cpf"].includes(field))
    return "F";
  if (["crt", "municipal_registration", "public_agency", "suframa", "ie_exempt"].includes(field)) return "J";
  if (["country", "foreign_state", "billing_foreign_state"].includes(field)) return "E";
  return null;
}

const REQUIRED: Record<string, string> = {
  carga_media: "avg_tax_load", bairro: "district", bairro_cobranca: "billing_district", celular: "mobile", cep: "postal_code",
  cep_cobranca: "billing_postal_code", cidade: "city", cidade_cobranca: "billing_city", cliente_desde: "client_since", cnpj: "document",
  complemento: "complement", complemento_cobranca: "billing_complement", condicao_pagamento: "payment_condition",
  informacoes_contato: "contact_info", cpf_mae: "mother_cpf", cpf_pai: "father_cpf", data_nascimento: "birth_date", email: "email",
  email_nfe: "nfe_email", endereco: "street", endereco_cobranca: "billing_street", numero: "number", numero_cobranca: "billing_number",
  fantasia: "trade_name", fax: "fax", fone: "phone", natureza_operacao: "operation_nature_id", inscricao_estadual: "ie",
  inscricao_municipal: "municipal_registration", inscricao_suframa: "suframa", limite_credito: "credit_limit_mode",
  naturalidade: "birthplace", nome_mae: "mother_name", nome_pai: "father_name", pais: "country", observacoes: "notes",
  orgao_emissor: "rg_issuer", profissao: "profession", proxima_visita: "next_visit", rg: "rg", website: "website", skype: "skype",
  uf_exterior_cobranca: "billing_foreign_state", uf_exterior: "foreign_state",
};
/** erp_catalog.contact_required_field(p_option) */
export const contactRequiredField = (option: string | null) => (option === null ? null : (REQUIRED[option] ?? null));

/** erp_catalog.contact_required_missing(p, p_fields): o primeiro campo obrigatório vazio. */
export function contactRequiredMissing(db: SqlDriver, p: Json, fields: string[] | null): string | null {
  const options = (preferences.get(db, "contatos.campos_obrigatorios") as unknown[] | null) ?? [];
  for (const option of options) {
    const field = contactRequiredField(str(option));
    if (field === null || (fields !== null && !fields.includes(field))) continue;
    const only = contactFieldPersonType(field);
    if (only !== null && only !== str(p.person_type)) continue;
    if (field === "ie" && p.ie_exempt === true) continue;
    if (field === "credit_limit_mode" ? (str(p[field]) ?? "unlimited") === "unlimited" : empty(p[field])) return field;
  }
  return null;
}

/** erp_catalog.contact_check_full(p_id, p, p_before, p_required) */
export function contactCheckFull(db: SqlDriver, id: string | null, p: Json, before: Json, required: string[] | null) {
  if (empty(p.name)) raise("22023", "erp_catalog_name_required");
  for (const key of jsonbKeys(p)) {
    const only = contactFieldPersonType(key);
    if (only !== null && only !== str(p.person_type) && (key === "ie_exempt" ? p.ie_exempt === true : !empty(p[key]))) invalid(key);
  }
  if (p.ie_exempt === true && !empty(p.ie)) invalid("ie");
  const mode = str(p.credit_limit_mode);
  if (mode !== null && (mode === "value") !== ((p.credit_limit ?? null) !== null)) invalid("credit_limit");
  const suframa = str(p.suframa);
  if (suframa !== null && !/^[0-9]{8,9}$/.test(suframa)) invalid("suframa");
  const birth = str(p.birth_date);
  if (birth !== null && birth !== str(before.birth_date) && birth > todaySaoPaulo()) invalid("birth_date");
  const category = str(p.finance_category_id);
  if (category !== str(before.finance_category_id) && category !== null && !finance.categoryActive(db, category)) invalid("finance_category_id");
  const nature = str(p.operation_nature_id);
  if (nature !== str(before.operation_nature_id) && nature !== null && !fiscal.natureActive(db, nature)) invalid("operation_nature_id");
  const seller = str(p.seller_id);
  if (
    seller !== str(before.seller_id) && seller !== null &&
    !one(db, 'SELECT 1 x FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=? AND r.active=1', seller)
  )
    invalid("seller_id");
  const previous = (before.persons as string[] | undefined) ?? [];
  for (const x of ((p.persons as string[] | null | undefined) ?? []) as string[])
    if (x === id || (!previous.includes(x) && !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, x)))
      invalid("persons");
  const missing = contactRequiredMissing(db, p, required);
  if (missing !== null) raise("22023", `erp_catalog_contact_required:${missing}`);
}

/** erp_catalog.document_issue(p_person_type, p_document): cpf, cnpj, document ou null. */
export function documentIssue(type: string | null, document: string | null): string | null {
  const v = upper(btrim(document ?? "").replace(/[ ./-]/g, ""));
  if (v === "" || type === "E") return null;
  if (type === "F" || (type === null && /^[0-9]{11}$/.test(v))) return validCpf(v) ? null : "cpf";
  if (type === "J" || (type === null && chars(v) === 14)) return validCnpj(v) ? null : "cnpj";
  return "document";
}

/** Contatos com o mesmo documento (compact), do mais novo ao mais velho; total e os 5 primeiros. */
function sameDocument(db: SqlDriver, document: string, except: string | null) {
  const key = compact(document);
  const rows = db
    .exec(
      `SELECT r.id, r.name, r.code, r.active, CAST(r.created_at AS TEXT) created_at, c.document FROM "erp_catalog__contact" c
       JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE c.document IS NOT NULL`,
    )
    .rows.filter((r) => compact(String(r.document)) === key && r.id !== except)
    .sort((a, b) => {
      const x = BigInt(String(a.created_at)),
        y = BigInt(String(b.created_at));
      return x > y ? -1 : x < y ? 1 : compareText(String(a.id), String(b.id));
    });
  return rows;
}

/** erp_catalog.warnings(p_entity, p_id, p_data): avisos de duplicidade e documento. */
export function warnings(db: SqlDriver, entity: string | null, id: string | null, p: Json): Json[] {
  if (entity === "products") return productWarnings(db, id, p);
  if (entity !== "contacts") return [];
  const previous = id === null ? {} : (data(db, id) ?? {});
  const out: Json[] = [];
  const value = "document" in p ? str(p.document) : str(previous.document);
  const type = "person_type" in p ? str(p.person_type) : str(previous.person_type);
  if (value !== null && (value !== str(previous.document) || type !== str(previous.person_type))) {
    const issue = documentIssue(type, value);
    if (issue !== null) out.push({ code: "invalid_document", field: "document", expected: issue });
  }
  if (value !== null && chars(compact(value)) >= 5 && compact(value) !== compact(str(previous.document))) {
    const rows = sameDocument(db, value, id);
    if (rows.length > 0)
      out.push({
        code: "duplicate_document", field: "document", total: rows.length,
        matches: rows.slice(0, 5).map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, active: !!Number(r.active) })),
      });
  }
  return out;
}

/** erp_catalog.contact_warnings(p_id, p_full, p_before) */
export function contactWarnings(db: SqlDriver, id: string | null, full: Json, before: Json): Json[] {
  let v = warnings(db, "contacts", id, { document: full.document ?? null, person_type: full.person_type ?? null });
  const allow = (preferences.get(db, "contatos.permite_documento_duplicado") ?? true) === true;
  if (!allow && v.some((w) => w.code === "duplicate_document")) {
    const blocked = sameDocument(db, str(full.document) ?? "", id).some((r) => contactSituationOf(db, String(r.id)) !== "E");
    v = v.map((w) => (w.code === "duplicate_document" ? { ...w, blocked } : w));
  }
  for (const key of ["father_cpf", "mother_cpf"]) {
    const cpf = str(full[key]);
    if (cpf !== null && cpf !== "" && cpf !== str(before[key]) && !validCpf(cpf.replace(/[ ./-]/g, "")))
      v.push({ code: `invalid_${key}`, field: key, expected: "cpf" });
  }
  return v;
}

const ACK = ["invalid_document", "duplicate_document", "invalid_father_cpf", "invalid_mother_cpf"];
/** erp_catalog.acknowledged_valid(p_acknowledged) */
export function acknowledgedValid(a: unknown): boolean {
  if (a === null || a === undefined) return true;
  if (jsonType(a) !== "array") return false;
  const xs = a as unknown[];
  return xs.length <= 6 && xs.every((x) => jsonType(x) === "string" && ACK.includes(x as string)) && unique(xs);
}

/** erp_catalog.contact_type_slugs(p_id) */
export function contactTypeSlugs(db: SqlDriver, id: string): string[] {
  const c = one(db, 'SELECT roles FROM "erp_catalog__contact" WHERE record_id=?', id);
  const roles: string[] = c ? JSON.parse(String(c.roles)) : [];
  const links = new Set(db.exec('SELECT type_id FROM "erp_catalog__contact_type_link" WHERE contact_id=?', id).rows.map((l) => String(l.type_id)));
  return typeRows(db)
    .filter((t) => t.active && ((t.roleBacked && roles.includes(t.slug)) || (!t.roleBacked && links.has(t.id))))
    .map((t) => t.slug);
}

const PROFILE_TEXT = [
  "crt", "taxpayer", "municipal_registration", "rg", "rg_issuer", "country", "foreign_state", "contact_info", "fax",
  "carrier_operator", "public_agency", "nfe_email", "website", "skype", "marital_status", "profession", "gender", "birthplace",
  "father_name", "father_cpf", "mother_name", "mother_cpf", "suframa",
];
const BILLING = [
  "billing_postal_code", "billing_state", "billing_city", "billing_district", "billing_street", "billing_number",
  "billing_complement", "billing_foreign_state",
];
const scaled2 = (v: unknown) => (v === null || v === undefined ? null : formatScaled(fromColumn(v), 2));

/** erp_catalog.contact_data(p_id): o formulário do contato (null se não é contato). */
export function contactData(db: SqlDriver, id: string): Json | null {
  const r = one(
    db,
    `SELECT r.id, r.name, r.code, r.active, c.trade_name, c.person_type, c.document, c.ie, c.email, c.phone, c.mobile, c.postal_code,
     c.street, c.number, c.complement, c.district, c.city, c.state, cp.record_id cp_id, cp.situation, cp.client_since, cp.ie_exempt,
     ${PROFILE_TEXT.map((k) => `cp.${k}`).join(", ")}, cp.next_visit, CAST(cp.avg_tax_load AS TEXT) avg_tax_load, cp.birth_date,
     cp.credit_limit_mode, CAST(cp.credit_limit AS TEXT) credit_limit, cp.payment_condition, cp.finance_category_id,
     cp.operation_nature_id, cp.seller_id, cp.notes, ${BILLING.map((k) => `cp.${k}`).join(", ")}
     FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
     LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE r.id=? AND r.entity='contacts'`,
    id,
  );
  if (!r) return null;
  const out: Json = {
    name: r.name, code: r.code ?? null, trade_name: r.trade_name ?? null, person_type: r.person_type ?? null, document: r.document ?? null,
    ie: r.ie ?? null, email: r.email ?? null, phone: r.phone ?? null, mobile: r.mobile ?? null, postal_code: r.postal_code ?? null,
    street: r.street ?? null, number: r.number ?? null, complement: r.complement ?? null, district: r.district ?? null, city: r.city ?? null,
    state: r.state ?? null,
    situation: contactSituation(!!Number(r.active), (r.situation as string | null) ?? contactSourceSituation(db, id)),
    types: contactTypeSlugs(db, id),
    client_since: r.client_since ?? null,
    ie_exempt: r.ie_exempt === null || r.ie_exempt === undefined ? false : !!Number(r.ie_exempt),
    next_visit: r.next_visit ?? null,
    avg_tax_load: scaled2(r.avg_tax_load),
    birth_date: r.birth_date ?? null,
    credit_limit_mode: r.credit_limit_mode ?? "unlimited",
    credit_limit: scaled2(r.credit_limit),
    payment_condition: r.payment_condition ?? null,
    finance_category_id: r.finance_category_id ?? null,
    operation_nature_id: r.operation_nature_id ?? null,
    seller_id: r.seller_id ?? null,
    notes: r.notes ?? null,
    persons: db
      .exec('SELECT person_id FROM "erp_catalog__contact_person" WHERE contact_id=? ORDER BY position', id)
      .rows.map((p) => String(p.person_id)),
  };
  for (const k of [...PROFILE_TEXT, ...BILLING]) out[k] = r[k] ?? null;
  return out;
}

/** erp_catalog.contact_dto(p_id): o contato para a tela (null se não é contato). */
export function contactDto(db: SqlDriver, id: string): Json | null {
  contactRequirePrivacy(db, id);
  const rec = one(
    db,
    `SELECT id, active, CAST(version AS TEXT) version, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at, updated_by
     FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`,
    id,
  );
  if (!rec) return null;
  const v = contactData(db, id);
  if (v === null) return null; // contact_data null || … = null
  const profile = one(db, 'SELECT finance_category_id, operation_nature_id, seller_id FROM "erp_catalog__contact_profile" WHERE record_id=?', id);
  const roles = one(db, 'SELECT roles FROM "erp_catalog__contact" WHERE record_id=?', id);
  const origin = one(db, 'SELECT source_id, state, applied_hash, latest_hash FROM "erp_catalog__origin" WHERE record_id=?', id);
  const seller = profile?.seller_id
    ? one(db, 'SELECT r.id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', profile.seller_id)
    : null;
  const own = one(db, 'SELECT id FROM "erp_catalog__seller" WHERE contact_id=?', id);
  return {
    ...v,
    id: rec.id,
    entity: "contacts",
    active: !!Number(rec.active),
    version: Number(rec.version),
    created_at: jsonTimestamp(String(rec.created_at)),
    updated_at: jsonTimestamp(String(rec.updated_at)),
    roles: roles ? JSON.parse(String(roles.roles)) : null,
    source: origin
      ? { system: "origin", source_id: origin.source_id, state: origin.state, applied_hash: origin.applied_hash, latest_hash: origin.latest_hash }
      : null,
    finance_category_name: profile?.finance_category_id ? finance.categoryLabel(db, String(profile.finance_category_id)) : null,
    operation_nature_name: profile?.operation_nature_id ? fiscal.natureDescription(db, String(profile.operation_nature_id)) : null,
    seller_name: seller && contactPrivacyVisible(db, String(seller.id)) ? seller.name : null,
    seller_record_id: own ? own.id : null,
    persons: db
      .exec(
        `SELECT r.id, r.name, r.code FROM "erp_catalog__contact_person" p JOIN "erp_catalog__record" r ON r.id=p.person_id
         WHERE p.contact_id=? ORDER BY p.position`,
        id,
      )
      .rows.filter((r) => contactPrivacyVisible(db, String(r.id)))
      .map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, situation: contactSituationOf(db, String(r.id)) })),
    updated_by_name: rec.updated_by === null ? null : actorLabel(db, String(rec.updated_by)),
  };
}

const CONTACT_COLUMNS = [
  "trade_name", "person_type", "document", "ie", "email", "phone", "mobile", "postal_code", "street", "number", "complement",
  "district", "city", "state",
];
const PROFILE_COLUMNS = [
  "situation", "crt", "client_since", "taxpayer", "ie_exempt", ...PROFILE_TEXT.filter((k) => !["crt", "taxpayer"].includes(k)),
  "next_visit", "avg_tax_load", "birth_date", "credit_limit_mode", "credit_limit", "payment_condition", "finance_category_id",
  "operation_nature_id", "seller_id", "notes", ...BILLING,
];
function profileValue(k: string, p: Json): unknown {
  const v = p[k];
  if (k === "ie_exempt") return v === true ? 1 : 0;
  if (k === "credit_limit_mode") return str(v) ?? "unlimited";
  if (k === "avg_tax_load" || k === "credit_limit") return v === null || v === undefined ? null : toParam(toScaled(String(v), 2));
  return str(v);
}

/** erp_catalog.contact_write(p_id, p): contato, perfil, tipos e pessoas (gatilhos zz_origin_sync). */
export function contactWrite(ctx: RpcContext, id: string, p: Json) {
  const db = ctx.db;
  const types = (p.types as string[] | undefined) ?? [];
  const all = typeRows(db);
  const roles = all.filter((t) => t.roleBacked && types.includes(t.slug)).map((t) => t.slug).sort(compareText);
  const key = compact(str(p.document));
  if (one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', id))
    db.exec(
      `UPDATE "erp_catalog__contact" SET ${CONTACT_COLUMNS.map((k) => `${k}=?`).join(", ")}, roles=?, erp_catalog_contact_document_key__k0=? WHERE record_id=?`,
      ...CONTACT_COLUMNS.map((k) => str(p[k])), JSON.stringify(roles), key, id,
    );
  else
    db.exec(
      `INSERT INTO "erp_catalog__contact"(record_id, ${CONTACT_COLUMNS.join(", ")}, roles, erp_catalog_contact_document_key__k0)
       VALUES(?, ${CONTACT_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
      id, ...CONTACT_COLUMNS.map((k) => str(p[k])), JSON.stringify(roles), key,
    );
  capture(ctx, id, "upsert"); // zz_origin_sync de contact
  if (one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=?', id))
    db.exec(
      `UPDATE "erp_catalog__contact_profile" SET ${PROFILE_COLUMNS.map((k) => `${k}=?`).join(", ")} WHERE record_id=?`,
      ...PROFILE_COLUMNS.map((k) => profileValue(k, p)), id,
    );
  else
    db.exec(
      `INSERT INTO "erp_catalog__contact_profile"(record_id, ${PROFILE_COLUMNS.join(", ")}) VALUES(?, ${PROFILE_COLUMNS.map(() => "?").join(", ")})`,
      id, ...PROFILE_COLUMNS.map((k) => profileValue(k, p)),
    );
  capture(ctx, id, "upsert"); // zz_origin_sync de contact_profile
  for (const t of all)
    if (!types.includes(t.slug)) db.exec('DELETE FROM "erp_catalog__contact_type_link" WHERE contact_id=? AND type_id=?', id, t.id);
  for (const t of all)
    if (!t.roleBacked && t.active && types.includes(t.slug))
      db.exec('INSERT OR IGNORE INTO "erp_catalog__contact_type_link"(contact_id, type_id) VALUES(?,?)', id, t.id);
  db.exec('DELETE FROM "erp_catalog__contact_person" WHERE contact_id=?', id);
  ((p.persons as string[] | undefined) ?? []).forEach((person, i) =>
    db.exec('INSERT INTO "erp_catalog__contact_person"(contact_id, person_id, position) VALUES(?,?,?)', id, person, i + 1),
  );
}

function audit(ctx: RpcContext, user: string, command: string, id: string, action: string, before: unknown, after: unknown) {
  ctx.db.exec(
    `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
     VALUES(?,?,'contacts',?,?,?,?,?)`,
    user, command, id, action, before === null || before === undefined ? null : jsonbText(before),
    after === null || after === undefined ? null : jsonbText(after), ctx.clock.next().toString(),
  );
}

/**
 * erp_catalog.contact_apply(p_user_id, p_id, p_expected_version, p_command_id,
 * p_data, p_acknowledged, p_audit default 'update', p_required default null)
 */
export function contactApply(
  ctx: RpcContext,
  user: string,
  id: string | null,
  expected: number,
  command: string,
  p: unknown,
  acknowledged: unknown,
  auditAction = "update",
  required: string[] | null = null,
): Json | null {
  const db = ctx.db;
  let row: { version: number; active: boolean } | null = null;
  let before: Json = {};
  let beforeDto: Json | null = null;
  if (id !== null) {
    const r = one(db, `SELECT CAST(version AS TEXT) version, active FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id);
    if (!r) raise("P0002", "erp_catalog_not_found");
    contactRequireVisible(db, user, id);
    row = { version: Number(r.version), active: !!Number(r.active) };
    if (row.version !== expected) raise("40001", "erp_catalog_version_conflict");
    before = contactData(db, id) ?? {};
    beforeDto = contactDto(db, id);
    // Excluído é só leitura: restaure antes de editar.
    if (before.situation === "E") raise("22023", "erp_catalog_contact_deleted");
  }
  let full = contactMerge(db, user, id, p, before);
  if (id === null && empty(full.code) && preferences.get(db, "contatos.codigo") === "sequencial")
    full = { ...full, code: contactTakeCode(ctx, user) };
  contactCheckFull(db, id, full, before, required);
  const found = contactWarnings(db, id, full, before);
  if (found.some((w) => w.blocked === true)) raise("23505", "erp_catalog_duplicate_document");
  const codes = found.map((w) => w.code);
  if (acknowledged !== null && acknowledged !== undefined && codes.some((c) => !(acknowledged as unknown[]).includes(c)))
    raise("40001", "erp_catalog_warning_unacknowledged");
  const active = ["A", "S"].includes(String(full.situation));
  if (id === null && user === CUSTOMER_BRIDGE_USER_ID) {
    // callRpc mantém esta conferência e o INSERT na mesma transactionSync.
    // Telefone só localiza candidatos; não vincula fichas nem limita humanos.
    const variants = (value: unknown) => {
      return [normalizeCustomerPhone(value, "international"), normalizeCustomerPhone(value, "human_br")]
        .flatMap((phone) => phone ? customerPhoneVariants(phone) : []);
    };
    const phones = new Set([full.phone, full.mobile].flatMap(variants));
    if (phones.size && db.exec('SELECT phone,mobile FROM "erp_catalog__contact"').rows
      .some((other) => [other.phone, other.mobile].flatMap(variants).some((phone) => phones.has(phone))))
      raise("40001", "erp_catalog_contact_command_conflict:duplicate_phone");
  }
  let target: string;
  let changed: boolean;
  if (id === null) {
    target = insertRecord(ctx, { entity: "contacts", name: String(full.name), code: str(full.code), active, actor: user, humanEdited: true });
    contactWrite(ctx, target, full);
    changed = true;
  } else {
    target = id;
    changed = jsonbText(full) !== jsonbText(before);
    if (changed) {
      if (row!.version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
      updateRecord(ctx, id, { entity: "contacts", active: row!.active }, { name: String(full.name), code: str(full.code), active }, user);
      contactWrite(ctx, id, full);
    }
  }
  const dto = contactDto(db, target);
  if (changed) {
    audit(ctx, user, command, target, id === null ? "create" : auditAction, beforeDto, dto);
    if (acknowledged !== null && acknowledged !== undefined && codes.length > 0)
      audit(ctx, user, command, target, "warnings_acknowledged", null, { warnings: codes });
  }
  return dto;
}
