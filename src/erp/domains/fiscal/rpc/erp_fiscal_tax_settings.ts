// Fiscal, bloco F1: configuração tributária e o contexto da estimativa de
// impostos no pedido (versões finais no oráculo). public.erp_fiscal_tax_settings_get,
// _save, erp_fiscal_tax_estimate_context e _v2, com
// erp_fiscal_invoices.tax_settings_input.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { jsonbKeys, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgCompareText, pgUpper } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { allowed as documentsAllowed } from "../../documents/public.ts";
import { commandHash, commandReplay, finishCommand, preference, requireRead, requireWrite, roleOf, specObject, UFS, uuidInput, type Json } from "../core.ts";
import { NATURE_SPECS, natureRecord } from "../natures.ts";

const str = (v: unknown) => (typeof v === "string" ? v : null);
const ALLOWED: Record<string, string[] | null> = { inside: null, goods: null, none: null, validated: null, double_base: ["MT", "PA", "PB"], single_base: ["PB"] };

/** erp_fiscal_invoices.tax_settings_input(configuração, difal por UF) */
export function taxSettingsInput(settings: unknown, states: unknown): { settings: Json; difal_by_state: Json } {
  const s = specObject(settings, NATURE_SPECS.tax_settings);
  const merged = {
    exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: "inside",
    ipi_in_icms_import: false, ...s,
  };
  if (states === null || states === undefined || jsonType(states) !== "object") raise("22023", "erp_fiscal_value_invalid");
  const out: Json = {};
  for (const key of jsonbKeys(states as object)) {
    const value: unknown = (states as Json)[key];
    const v = typeof value === "string" ? value : null;
    if (
      !UFS.includes(key) || v === null || !(v === "default" || Object.prototype.hasOwnProperty.call(ALLOWED, v)) ||
      (v !== "default" && ALLOWED[v] !== null && !ALLOWED[v]!.includes(key))
    )
      raise("22023", "erp_fiscal_value_invalid");
    if (v !== "default") out[key] = v;
  }
  return { settings: merged, difal_by_state: out };
}

function settingsRow(db: SqlDriver) {
  const t = one(db, 'SELECT settings, difal_by_state, version, CAST(updated_at AS TEXT) updated_at FROM "erp_fiscal_invoices__tax_settings" WHERE singleton=1');
  return t
    ? { settings: JSON.parse(String(t.settings)) as Json, difal_by_state: JSON.parse(String(t.difal_by_state)) as Json, version: Number(t.version), updated_at: jsonTimestamp(String(t.updated_at)) }
    : null;
}

export function erpFiscalTaxSettingsGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireRead(db, str(a.p_user_id));
  const d = taxSettingsInput({}, {});
  const t = settingsRow(db);
  return {
    settings: t?.settings ?? d.settings, difal_by_state: t?.difal_by_state ?? {}, version: t?.version ?? 0, updated_at: t?.updated_at ?? null,
    writable: ["admin", "fiscal"].includes(role), data_mode: "erp_native",
  };
}

export function erpFiscalTaxSettingsSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const commandId = str(a.p_command_id);
  const expected = a.p_expected_version as number | null;
  const settings = jsonbArg(a.p_settings);
  const states = jsonbArg(a.p_difal_by_state);
  requireWrite(db, user);
  if (commandId === null || expected === null || expected < 0 || expected > 2147483646) raise("22023", "erp_fiscal_command_invalid");
  const input = taxSettingsInput(settings, states);
  const hash = commandHash(user, "tax_settings", "save", { expected_version: expected, settings, difal_by_state: states });
  const replay = commandReplay(db, commandId!, user!, "tax_settings", hash);
  if (replay) return replay;
  const t = settingsRow(db);
  if ((t?.version ?? 0) !== expected) raise("40001", "erp_fiscal_tax_settings_version_conflict");
  const version = (t?.version ?? 0) + 1;
  const now = ctx.clock.next();
  db.exec(
    `INSERT INTO "erp_fiscal_invoices__tax_settings"(singleton, settings, difal_by_state, version, updated_by, updated_at) VALUES(1,?,?,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET settings=excluded.settings, difal_by_state=excluded.difal_by_state, version=excluded.version,
         updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    JSON.stringify(input.settings), JSON.stringify(input.difal_by_state), version, user, now.toString(),
  );
  const result = {
    settings: input.settings, difal_by_state: input.difal_by_state, version, updated_at: jsonTimestamp(ctx.clock.next().toString()), writable: true, replayed: false,
    data_mode: "erp_native",
  };
  return finishCommand(ctx, { commandId: commandId!, actor: user!, scope: "tax_settings", hash, result, entity: null, version, action: "save" });
}

/** public.erp_fiscal_tax_estimate_context */
export function erpFiscalTaxEstimateContext(ctx: RpcContext, a: RpcArgs): Json {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const role = roleOf(db, user);
  const kind = str(a.p_kind);
  const contact = str(a.p_contact_id);
  const productIds = jsonbArg(a.p_product_ids);
  if (kind === null || !["sales_orders", "sales_proposals"].includes(kind) || jsonType(productIds) !== "array" || (productIds as unknown[]).length > 250)
    raise("22023", "erp_fiscal_query_invalid");
  const ids = (productIds as unknown[]).map((x) => uuidInput(x));
  if (!documentsAllowed(role, kind, false)) raise("42501", "erp_fiscal_invoice_forbidden");
  const company = one(
    db,
    `SELECT f.crt, json_extract(i.data,'$.state') state FROM "erp_company__identity" i LEFT JOIN "erp_company__fiscal" f ON f.singleton=i.singleton WHERE i.singleton=1`,
  );
  const crt = (company?.crt as string | null) ?? null;
  const state = company?.state === null || company?.state === undefined ? null : pgUpper(String(company.state));
  let recipient: Json | null = null;
  let nature: string | null = null;
  if (contact !== null) {
    const c = one(
      db,
      `SELECT c.person_type, c.state, c.ie FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.entity='contacts'`,
      contact,
    );
    if (!c) raise("22023", "erp_fiscal_invoice_contact_not_found");
    const p = one(db, 'SELECT taxpayer, operation_nature_id FROM "erp_catalog__contact_profile" WHERE record_id=?', contact);
    recipient = { person_type: c!.person_type ?? null, state: c!.state === null ? null : pgUpper(String(c!.state)), ie: c!.ie ?? null, taxpayer: (p?.taxpayer as string | null) ?? null };
    nature = (p?.operation_nature_id as string | null) ?? null;
    if (
      !one(db, `SELECT 1 x FROM "erp_fiscal_invoices__nature" WHERE id=? AND direction='1' AND active=1 AND deleted_at IS NULL AND crt=?`, nature, crt)
    )
      nature = null;
  }
  if (nature === null) {
    const first = recipient?.person_type === "F" ? "VF" : recipient?.person_type === "J" ? "VJ" : "S";
    const d = db
      .exec(
        `SELECT d.code, d.nature_id FROM "erp_fiscal_invoices__nature_default" d JOIN "erp_fiscal_invoices__nature" n ON n.id=d.nature_id
          WHERE n.active=1 AND n.deleted_at IS NULL AND d.code IN (?, 'S')`,
        first,
      )
      .rows.sort((x, y) => Number(x.code === "S") - Number(y.code === "S") || pgCompareText(String(x.code), String(y.code)));
    nature = d.length ? String(d[0].nature_id) : null;
  }
  const t = one(db, 'SELECT settings, difal_by_state FROM "erp_fiscal_invoices__tax_settings" WHERE singleton=1');
  const products = db
    .exec(
      `SELECT r.id, p.ncm, p.kind FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    )
    .rows.map((r) => ({ id: String(r.id), ncm: (r.ncm as string | null) ?? null, kind: (r.kind as string | null) ?? null }))
    .sort((x, y) => pgCompareText(x.id, y.id));
  return {
    enabled: preference(db, "propostas.exibir_ipi_st", "boolean", false), company: { crt, state }, recipient, nature: nature === null ? null : natureRecord(db, nature),
    settings: t ? JSON.parse(String(t.settings)) : taxSettingsInput({}, {}).settings, difal_by_state: t ? JSON.parse(String(t.difal_by_state)) : {}, products,
    data_mode: "erp_native",
  };
}

/** public.erp_fiscal_tax_estimate_context_v2: os produtos com o grupo. */
export function erpFiscalTaxEstimateContextV2(ctx: RpcContext, a: RpcArgs) {
  const v = erpFiscalTaxEstimateContext(ctx, a);
  const products = (v.products as Json[])
    .map((p): Json => {
      const d = one(ctx.db, 'SELECT product_group_id FROM "erp_catalog__product_detail" WHERE record_id=?', p.id);
      return { ...p, group_id: (d?.product_group_id as string | null) ?? null };
    })
    .sort((x, y) => pgCompareText(String(x.id), String(y.id)));
  return { ...v, products };
}

registerRpc("erp_fiscal_tax_settings_get", erpFiscalTaxSettingsGet);
registerRpc("erp_fiscal_tax_settings_save", erpFiscalTaxSettingsSave);
registerRpc("erp_fiscal_tax_estimate_context", erpFiscalTaxEstimateContext);
registerRpc("erp_fiscal_tax_estimate_context_v2", erpFiscalTaxEstimateContextV2);
