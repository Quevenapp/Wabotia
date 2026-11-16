// Funcionários (erp_catalog.employee): erp_catalog.employee_admin,
// employee_dto e employee_input. Dados pessoais (CPF, PIS, salário) nunca vão
// para o recibo do comando nem para a trilha; só o fato e a situação.
import { formatScaled, fromColumn, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbKeys, jsonType } from "../../engine/json.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../engine/time.ts";
import { activeRole } from "../access/public.ts";
import { contactDate, contactEmailList, contactText, contactUf, upper, validCpf, validPis } from "./fields.ts";

/** erp_catalog.employee_admin: só o administrador ativo. */
export function employeeAdmin(db: SqlDriver, user: string | null) {
  if (!user || activeRole(db, user) !== "admin") raise("42501", "erp_catalog_access_denied");
}

/** Colunas de texto e o tamanho máximo (employee_input.v_texts). */
const TEXTS: Record<string, number> = {
  name: 200,
  cpf: 14,
  rg: 20,
  job_title: 100,
  pis: 14,
  ctps: 30,
  code: 30,
  phone: 40,
  mobile: 40,
  email: 254,
  emergency_phone: 40,
  postal_code: 20,
  state: 2,
  city: 100,
  district: 100,
  street: 200,
  number: 30,
  complement: 200,
};
const TEXT_KEYS = jsonbKeys(TEXTS);
const KEYS = new Set([...TEXT_KEYS, "birth_date", "admission_date", "salary", "notes"]);

export type EmployeeData = Record<string, string | null>;

/** erp_catalog.employee_input: o formulário inteiro, validado e normalizado. */
export function employeeInput(p: unknown): EmployeeData {
  if (p === null || p === undefined || jsonType(p) !== "object") raise("22023", "erp_catalog_employee_invalid");
  const keys = Object.keys(p as object);
  if (keys.some((k) => !KEYS.has(k)) || keys.length !== KEYS.size) raise("22023", "erp_catalog_employee_invalid");
  const data = p as Record<string, unknown>;
  const v: EmployeeData = {};
  for (const key of TEXT_KEYS) {
    let text = contactText(key, data[key], TEXTS[key]);
    if (key === "cpf" || key === "pis") text = (text ?? "").replace(/[ ./-]/g, "") || null;
    if (key === "state" && text !== null) text = upper(text);
    v[key] = text;
  }
  if (v.name === null) raise("22023", "erp_catalog_employee_invalid:name");
  if (v.cpf === null || !validCpf(v.cpf)) raise("22023", "erp_catalog_employee_invalid:cpf");
  if (v.pis !== null && !validPis(v.pis)) raise("22023", "erp_catalog_employee_invalid:pis");
  if (!contactEmailList(v.email, 254)) raise("22023", "erp_catalog_employee_invalid:email");
  if (!contactUf(v.state)) raise("22023", "erp_catalog_employee_invalid:state");
  v.birth_date = contactDate("birth_date", data.birth_date);
  v.admission_date = contactDate("admission_date", data.admission_date);
  v.notes = contactText("notes", data.notes, 4000, true);
  if (v.birth_date !== null && v.birth_date > todaySaoPaulo()) raise("22023", "erp_catalog_employee_invalid:birth_date");
  const salary = contactText("salary", data.salary, 20);
  if (salary !== null && !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(salary))
    raise("22023", "erp_catalog_employee_invalid:salary");
  // numeric(18,2)::text
  v.salary = salary === null ? null : formatScaled(toScaled(salary, 2), 2);
  return v;
}

/** Os campos do formulário (employee_dto sem id, versão, situação e carimbos). */
export const FORM_KEYS = [...KEYS];

/** erp_catalog.employee_dto */
export function employeeDto(db: SqlDriver, id: string): Record<string, unknown> | null {
  const e = one(
    db,
    `SELECT id, CAST(version AS TEXT) version, name, cpf, rg, birth_date, job_title, admission_date, pis, ctps, code,
     CAST(salary AS TEXT) salary, phone, mobile, email, emergency_phone, postal_code, state, city, district, street,
     number, complement, notes, situation, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at
     FROM "erp_catalog__employee" WHERE id=?`,
    id,
  );
  if (!e) return null;
  return {
    id: e.id,
    version: Number(e.version),
    name: e.name,
    cpf: e.cpf,
    rg: e.rg,
    birth_date: e.birth_date,
    job_title: e.job_title,
    admission_date: e.admission_date,
    pis: e.pis,
    ctps: e.ctps,
    code: e.code,
    salary: e.salary === null ? null : formatScaled(fromColumn(e.salary), 2),
    phone: e.phone,
    mobile: e.mobile,
    email: e.email,
    emergency_phone: e.emergency_phone,
    postal_code: e.postal_code,
    state: e.state,
    city: e.city,
    district: e.district,
    street: e.street,
    number: e.number,
    complement: e.complement,
    notes: e.notes,
    situation: e.situation,
    created_at: jsonTimestamp(String(e.created_at)),
    updated_at: jsonTimestamp(String(e.updated_at)),
  };
}

/** dto - 'id' - 'version' - 'situation' - 'created_at' - 'updated_at' */
export function employeeForm(dto: Record<string, unknown>): EmployeeData {
  return Object.fromEntries(FORM_KEYS.map((k) => [k, (dto[k] as string | null) ?? null]));
}
