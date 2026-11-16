// Campos de cadastro de pessoas (contatos, vendedores, funcionários):
// erp_catalog.contact_text, contact_date, contact_email_list, contact_uf,
// valid_cpf, valid_pis, search_terms e matches. Fonte: migrações do Fagoo
// (versões finais no oráculo).
import { raise } from "../../engine/errors.ts";
import { jsonType } from "../../engine/json.ts";
import { validDate } from "../../engine/time.ts";
import { fold } from "./internal.ts";

/** [[:cntrl:]] do Postgres (C0, DEL e C1). */
export const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * \s das expressões regulares do Postgres no oráculo (conferido caractere a
 * caractere): sem U+00A0, U+1680, U+2007, U+200B, U+202F nem U+FEFF.
 */
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000";
const SPACES = new RegExp(`[${SPACE}]+`);
const LIST_SEPARATOR = new RegExp(`[${SPACE}]*[;,][${SPACE}]*`);
const EMAIL = new RegExp(`^[^@${SPACE};,]+@[^@${SPACE};,]+\\.[^@${SPACE};,]+$`);

/** btrim(text): só espaços. */
export const btrim = (s: string) => s.replace(/^ +| +$/g, "");
/** length(text): caracteres, não unidades UTF-16. */
export const chars = (s: string) => [...s].length;

/** erp_catalog.contact_text(p_key, p_value jsonb, p_max, p_multiline) */
export function contactText(key: string, value: unknown, max: number, multiline = false): string | null {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "string") raise("22023", `erp_catalog_contact_invalid:${key}`);
  const v = btrim(value as string);
  if (v === "") return null;
  if (chars(v) > max || CNTRL.test(multiline ? v.replace(/[\n\r\t]/g, "") : v))
    raise("22023", `erp_catalog_contact_invalid:${key}`);
  return v;
}

/** erp_catalog.contact_date(p_key, p_value jsonb): AAAA-MM-DD entre 1900 e 2100. */
export function contactDate(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "string") raise("22023", `erp_catalog_contact_invalid:${key}`);
  const v = btrim(value as string);
  if (v === "") return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) || !validDate(v) || v < "1900-01-01" || v > "2100-12-31")
    raise("22023", `erp_catalog_contact_invalid:${key}`);
  return v;
}

/** erp_catalog.contact_email_list(p_value, p_max): e-mails separados por ; ou , */
export const contactEmailList = (value: string | null, max: number) =>
  value === null || (chars(value) <= max && value.split(LIST_SEPARATOR).every((e) => EMAIL.test(e)));

const UF = new Set(
  "AC AL AM AP BA CE DF ES EX GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split(" "),
);
/** erp_catalog.contact_uf */
export const contactUf = (value: string | null) => value === null || UF.has(value);

const sameDigit = (v: string) => /^([0-9])\1{10}$/.test(v);

/** erp_catalog.valid_cpf */
export function validCpf(value: string | null): boolean {
  if (value === null || !/^[0-9]{11}$/.test(value) || sameDigit(value)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += Number(value[i - 1]) * (n + 2 - i);
    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;
    if (digit !== Number(value[n])) return false;
  }
  return true;
}

const PIS_WEIGHTS = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
/** erp_catalog.valid_pis */
export function validPis(value: string | null): boolean {
  if (value === null || !/^[0-9]{11}$/.test(value) || sameDigit(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(value[i]) * PIS_WEIGHTS[i];
  let digit = 11 - (sum % 11);
  if (digit >= 10) digit = 0;
  return digit === Number(value[10]);
}

/** erp_catalog.search_terms: termos da busca (sem acento, minúsculos) ou nulo. */
export function searchTerms(query: string | null): string[] | null {
  if (query === null || btrim(query) === "") return null;
  return fold(btrim(query))!.split(SPACES).filter((t) => t !== "");
}

/** erp_catalog.matches(p_terms, p_text, p_compact, p_digits): todo termo aparece. */
export function matches(terms: string[], text: string | null, compact: string | null, digits: string | null) {
  return terms.every((t) => {
    if ((text ?? "").includes(t)) return true;
    if (!/[0-9]/.test(t)) return false;
    const alnum = t.replace(/[^0-9a-z]/g, "");
    if (alnum !== "" && (compact ?? "").includes(alnum)) return true;
    const only = t.replace(/[^0-9]/g, "");
    return !/[a-z]/.test(t) && only !== "" && (digits ?? "").includes(only);
  });
}

/** Ordem do texto no Postgres do oráculo (collation C): bytes UTF-8. */
const encoder = new TextEncoder();
export function compareText(a: string, b: string) {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
