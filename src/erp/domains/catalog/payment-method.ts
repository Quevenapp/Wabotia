// Formas de pagamento (erp_catalog.payment_method): payment_method_access,
// payment_method_input, payment_method_dto, payment_method_accounts,
// payment_condition_valid e o gatilho payment_method_defaults_fit (camada de
// tabela: toda escrita passa por writeRow, que aplica a regra antes do SQL).
// A conta vem de finance/public.ts (leituras de erp_finance.account).
import { formatScaled, fromColumn, toParam, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { activeRole } from "../access/public.ts";
import * as finance from "../finance/public.ts";
import { catalogParts, catalogUnavailable, preserveCatalogFields } from "./cost.ts";
import { btrim, chars, collapseSpaces, contactText, lower, percentValid, upper, validCnpj } from "./fields.ts";

export const PAYMENT_FINANCE_DEFAULTS = {
  account_id: null, interest_rate: null, fine_rate: null, auto_settle: false,
  fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null,
};

/** erp_catalog.payment_method_access(p_user_id, p_write): o papel. */
export function paymentMethodAccess(db: SqlDriver, user: string | null, write: boolean): string {
  const role = user ? activeRole(db, user) : null;
  if (
    role === null ||
    !(write ? ["admin", "financeiro"] : ["admin", "consulta", "financeiro", "vendas"]).includes(role)
  )
    raise("42501", "erp_catalog_access_denied");
  return role;
}

/** erp_catalog.payment_condition_valid: "30 60 90", "3x", "15 + 2x". */
export function paymentConditionValid(value: string | null): boolean {
  const v = collapseSpaces(lower(btrim(value ?? "")));
  if (v === "") return true;
  if (chars(v) > 100) return false;
  if (/^[0-9]{1,4} ?\+ ?[0-9]{1,3} ?x$/.test(v)) {
    const n = Number(/([0-9]{1,3}) ?x$/.exec(v)![1]);
    return n >= 1 && n <= 119 && Number(/^([0-9]{1,4})/.exec(v)![1]) <= 3650;
  }
  if (/^[0-9]{1,3} ?x$/.test(v)) {
    const n = Number(/^([0-9]{1,3})/.exec(v)![1]);
    return n >= 1 && n <= 120;
  }
  if (!/^[0-9]{1,4}(( ?[,;/] ?| )[0-9]{1,4})*$/.test(v)) return false;
  const days = v.split(/ ?[,;/] ?| /).map(Number);
  if (days.length > 120) return false;
  return days.every((d, i) => d <= 3650 && (i === 0 || d >= days[i - 1]));
}

const KEYS = [
  "description", "payment_type", "condition", "destination", "account_id", "business_days", "applicable",
  "interest_rate", "fine_rate", "card_brand", "card_integration", "card_cnpj", "auto_settle", "pix_integration",
  "pix_cnpj", "fee_type", "fee_rate", "fee_fixed", "settlement_days",
];
const STRINGS = [
  "description", "payment_type", "condition", "destination", "account_id", "applicable", "interest_rate",
  "fine_rate", "card_brand", "card_integration", "card_cnpj", "pix_integration", "pix_cnpj", "fee_type", "fee_rate",
  "fee_fixed",
];
const TYPES = ["01", "02", "03", "04", "05", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "90", "91", "99"];
const BRANDS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "99"];
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PaymentMethodInput {
  description: string;
  payment_type: string;
  condition: string | null;
  destination: string;
  account_id: string | null;
  business_days: boolean;
  applicable: string;
  interest_rate: string | null;
  fine_rate: string | null;
  card_brand: string | null;
  card_integration: string | null;
  card_cnpj: string | null;
  auto_settle: boolean;
  pix_integration: string | null;
  pix_cnpj: string | null;
  fee_type: string;
  fee_rate: string | null;
  fee_fixed: string | null;
  settlement_days: number | null;
}

const invalid = (what?: string): never =>
  raise("22023", what ? `erp_catalog_payment_method_invalid:${what}` : "erp_catalog_payment_method_invalid");
const rate = (v: string | null) => (v === null ? null : formatScaled(toScaled(v, 4), 4));
const cnpjText = (v: string | null) => (v === null ? null : upper(v.replace(/[ ./-]/g, "")));

/** erp_catalog.payment_method_input */
export function paymentMethodInput(p: unknown): PaymentMethodInput {
  if (p === null || p === undefined || jsonType(p) !== "object") invalid();
  const keys = Object.keys(p as object);
  if (keys.some((k) => !KEYS.includes(k)) || keys.length !== KEYS.length) invalid();
  const d = p as Record<string, unknown>;
  for (const k of STRINGS) if (d[k] !== null && jsonType(d[k]) !== "string") invalid(k);
  for (const k of ["business_days", "auto_settle"]) if (jsonType(d[k]) !== "boolean") invalid(k);
  const s = (k: string) => (d[k] as string | null) ?? null;
  const description = contactText("description", d.description, 100);
  if (description === null) invalid("description");
  const type = s("payment_type");
  if (type === null || !TYPES.includes(type)) invalid("payment_type");
  const card = type === "03" || type === "04",
    pix = type === "17" || type === "20",
    boleto = type === "15";
  if (!paymentConditionValid(s("condition"))) invalid("condition");
  if (
    s("destination") === null || !["contas", "ficha", "caixa"].includes(s("destination")!) ||
    s("applicable") === null || !["pagamentos", "recebimentos", "ambos"].includes(s("applicable")!) ||
    s("fee_type") === null || !["aliquota", "fixa", "aliquota_fixa"].includes(s("fee_type")!)
  )
    invalid("choice");
  if (s("account_id") !== null && (!UUID_LOWER.test(s("account_id")!) || s("destination") === "ficha")) invalid("account_id");
  for (const k of ["interest_rate", "fine_rate", "fee_rate"]) if (!percentValid(d[k], true)) invalid(k);
  if (s("fee_fixed") !== null && !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(s("fee_fixed")!)) invalid("fee_fixed");
  const days = d.settlement_days;
  if (days !== null && (jsonType(days) !== "number" || !/^(0|[1-9][0-9]{0,2})$/.test(String(days)) || Number(days) > 365))
    invalid("settlement_days");
  const some = (...ks: string[]) => ks.some((k) => s(k) !== null);
  if (
    (!boleto && some("interest_rate", "fine_rate")) ||
    (!card && (some("card_brand", "card_integration", "card_cnpj") || d.auto_settle === true)) ||
    (!pix && some("pix_integration", "pix_cnpj"))
  )
    invalid("section");
  if (
    (s("card_brand") !== null && !BRANDS.includes(s("card_brand")!)) ||
    (s("card_integration") !== null && !["1", "2"].includes(s("card_integration")!)) ||
    (s("pix_integration") !== null && s("pix_integration") !== "sem")
  )
    invalid("choice");
  if (s("card_cnpj") !== null && !validCnpj(cnpjText(s("card_cnpj")))) invalid("card_cnpj");
  if (s("pix_cnpj") !== null && !validCnpj(cnpjText(s("pix_cnpj")))) invalid("pix_cnpj");
  if ((s("fee_type") === "aliquota" && s("fee_fixed") !== null) || (s("fee_type") === "fixa" && s("fee_rate") !== null))
    invalid("fee");
  const condition = s("condition") === null ? null : btrim(collapseSpaces(s("condition")!)) || null;
  return {
    description: description!,
    payment_type: type!,
    condition,
    destination: s("destination")!,
    account_id: s("account_id"),
    business_days: d.business_days as boolean,
    applicable: s("applicable")!,
    interest_rate: rate(s("interest_rate")),
    fine_rate: rate(s("fine_rate")),
    card_brand: s("card_brand"),
    card_integration: s("card_integration"),
    card_cnpj: cnpjText(s("card_cnpj")),
    auto_settle: d.auto_settle as boolean,
    pix_integration: s("pix_integration"),
    pix_cnpj: cnpjText(s("pix_cnpj")),
    fee_type: s("fee_type")!,
    fee_rate: rate(s("fee_rate")),
    fee_fixed: s("fee_fixed") === null ? null : formatScaled(toScaled(s("fee_fixed")!, 2), 2),
    settlement_days: days === null ? null : Number(days),
  };
}

// ---------------------------------------------------------------------------
// Camada de tabela

const BOOLS = ["business_days", "auto_settle", "active", "is_default", "default_receipt", "default_payment", "default_return"];
const RATES = ["interest_rate", "fine_rate", "fee_rate"];
/** Colunas gravadas por writeRow (tudo menos id e created_*). */
const WRITABLE = [
  ...KEYS, "active", "is_default", "default_receipt", "default_payment", "default_return", "version",
  "updated_by", "updated_at", "deleted_by", "deleted_at",
];

/** Linha crua: decimais escalados e carimbos como texto, booleanos como 0/1. */
export type Row = Record<string, string | number | null>;

export function readRow(db: SqlDriver, id: string, live = true): Row | null {
  return one(
    db,
    `SELECT id, description, payment_type, condition, destination, account_id, business_days, applicable,
     CAST(interest_rate AS TEXT) interest_rate, CAST(fine_rate AS TEXT) fine_rate, card_brand, card_integration,
     card_cnpj, auto_settle, pix_integration, pix_cnpj, fee_type, CAST(fee_rate AS TEXT) fee_rate,
     CAST(fee_fixed AS TEXT) fee_fixed, settlement_days, active, is_default, CAST(version AS TEXT) version,
     created_by, updated_by, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at, deleted_by,
     CAST(deleted_at AS TEXT) deleted_at, default_receipt, default_payment, default_return
     FROM "erp_catalog__payment_method" WHERE id=?${live ? " AND deleted_at IS NULL" : ""}`,
    id,
  ) as Row | null;
}

/** erp_catalog.payment_method_defaults_fit (BEFORE INSERT OR UPDATE). */
function fit(row: Row) {
  if (!Number(row.active) || row.deleted_at !== null) {
    row.default_receipt = 0;
    row.default_payment = 0;
    row.default_return = 0;
  }
  if (!["recebimentos", "ambos"].includes(String(row.applicable))) {
    row.default_receipt = 0;
    row.default_return = 0;
  }
  if (!["pagamentos", "ambos"].includes(String(row.applicable))) row.default_payment = 0;
  row.is_default = row.default_receipt;
}

/** Valores do formulário em colunas (decimais escalados, booleanos 0/1). */
export function inputColumns(v: PaymentMethodInput): Row {
  return {
    ...v,
    business_days: v.business_days ? 1 : 0,
    auto_settle: v.auto_settle ? 1 : 0,
    interest_rate: v.interest_rate === null ? null : toParam(toScaled(v.interest_rate, 4)),
    fine_rate: v.fine_rate === null ? null : toParam(toScaled(v.fine_rate, 4)),
    fee_rate: v.fee_rate === null ? null : toParam(toScaled(v.fee_rate, 4)),
    fee_fixed: v.fee_fixed === null ? null : toParam(toScaled(v.fee_fixed, 2)),
  };
}

export function insertRow(ctx: RpcContext, user: string, v: PaymentMethodInput): string {
  preserveCatalogFields(ctx.parts.finance, { ...v }, {}, PAYMENT_FINANCE_DEFAULTS);
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  const row: Row = {
    ...inputColumns(v), id, active: 1, is_default: 0, default_receipt: 0, default_payment: 0, default_return: 0,
    version: 1, created_by: user, updated_by: user, created_at: now, updated_at: now, deleted_by: null, deleted_at: null,
  };
  fit(row);
  const cols = Object.keys(row);
  ctx.db.exec(
    `INSERT INTO "erp_catalog__payment_method"(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
  return id;
}

/** UPDATE de uma linha: aplica as mudanças, o gatilho e grava. */
export function updateRow(ctx: RpcContext, id: string, changes: Row) {
  const row = readRow(ctx.db, id, false)!;
  changes = preserveCatalogFields(ctx.parts.finance, changes, row,
    { ...PAYMENT_FINANCE_DEFAULTS, auto_settle: 0 }) as Row;
  Object.assign(row, changes);
  fit(row);
  ctx.db.exec(
    `UPDATE "erp_catalog__payment_method" SET ${WRITABLE.map((c) => `${c}=?`).join(", ")} WHERE id=?`,
    ...WRITABLE.map((c) => row[c]),
    id,
  );
}

export const accountActive = (db: SqlDriver, id: string) => finance.accountActive(db, id);

/** erp_catalog.payment_method_dto (null se não existe ou foi excluída). */
export function paymentMethodDto(db: SqlDriver, id: string): Record<string, unknown> | null {
  const m = readRow(db, id);
  if (!m) return null;
  const out: Record<string, unknown> = {
    id: m.id,
    version: Number(m.version),
    description: m.description,
    payment_type: m.payment_type,
    condition: m.condition,
    destination: m.destination,
    account_id: m.account_id,
    account_name: catalogParts(db).finance ? finance.accountName(db, m.account_id as string | null) : null,
    ...catalogUnavailable(catalogParts(db), ["finance"]),
    applicable: m.applicable,
    card_brand: m.card_brand,
    card_integration: m.card_integration,
    card_cnpj: m.card_cnpj,
    pix_integration: m.pix_integration,
    pix_cnpj: m.pix_cnpj,
    fee_type: m.fee_type,
    fee_fixed: m.fee_fixed === null ? null : formatScaled(fromColumn(m.fee_fixed), 2),
    settlement_days: m.settlement_days === null ? null : Number(m.settlement_days),
    created_at: jsonTimestamp(String(m.created_at)),
    updated_at: jsonTimestamp(String(m.updated_at)),
  };
  for (const b of BOOLS) out[b] = !!Number(m[b]);
  for (const r of RATES) out[r] = m[r] === null ? null : formatScaled(fromColumn(m[r]), 4);
  return out;
}

/** erp_catalog.payment_method_accounts */
export const paymentMethodAccounts = (db: SqlDriver) => catalogParts(db).finance ? finance.accountOptions(db) : [];
