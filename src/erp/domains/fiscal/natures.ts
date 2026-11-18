// Naturezas de operação (erp_fiscal_invoices.nature_input, nature_rule_input,
// replace_rules, nature_record e nature_review_record, versões finais no
// oráculo) e as specs dos campos (nature_specs).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { rowJson, rowJsonSelect } from "../../engine/row-json.ts";
import { pgCompareText, pgLower } from "../../engine/text.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { boolInput, ipiSituationAllowed, specObject, textInput, UFS, uuidInput, type Json } from "./core.ts";

type Spec = Record<string, string>;
const CODE = "x:^[A-Z0-9]{8}([A-Z0-9]{2})?$";
/** erp_fiscal_invoices.nature_specs() */
export const NATURE_SPECS: { rules: Record<string, Spec>; others: Spec; retentions: Spec; tax_settings: Spec } = {
  rules: {
    icms_sn: {
      situation: "e:101|102|103|201|202|203|300|400|500|900|02|15|53|61", cfop: "x:^[1-7][0-9]{3}$", bc_mode: "e:0|1|2|3", rate: "d:4:3", base_rate: "d:4:3",
      deferral_rate: "d:4:3", reduction_reason: "e:1|9", taxation: "e:T|I|O", credit_rate: "d:4:3", fcp_rate: "d:4:3", benefit_code: CODE, presumed_credit_code: CODE,
      rbc_benefit_code: CODE, pauta_value: "d:4:11", st_bc_mode: "e:0|1|2|3|4|5|6", st_pauta_value: "d:4:11", st_rate: "d:4:3", st_base_rate: "d:4:3", st_mva: "d:4:3",
      retained_base_rate: "d:4:3", retained_rate: "d:4:3", difal_type: "e:N|I", difal_base_rate: "d:4:3", difal_internal_rate: "d:4:3", difal_fcp_rate: "d:4:3",
    },
    icms_normal: {
      situation: "e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90", cfop: "x:^[1-7][0-9]{3}$", rate: "d:4:3", base_rate: "d:4:3", deferral_rate: "d:4:3",
      presumed_rate: "d:4:3", taxation: "e:T|I|O", fcp_rate: "d:4:3", bc_mode: "e:0|1|2|3", pauta_value: "d:4:11", benefit_code: CODE, presumed_credit_code: CODE,
      rbc_benefit_code: CODE, deson_reason: "e:1|3|4|5|6|7|8|9|10|11|90", deson_deduct: "b", st_bc_mode: "e:0|1|2|3|4|5|6", st_pauta_value: "d:4:11", st_rate: "d:4:3",
      st_base_rate: "d:4:3", st_mva: "d:4:3", st_pis_rate: "d:4:3", st_cofins_rate: "d:4:3", retained_rate: "d:4:3", difal_type: "e:N|I", difal_base_rate: "d:4:3",
      difal_internal_rate: "d:4:3", difal_fcp_rate: "d:4:3",
    },
    ipi: { situation: "e:00|01|02|03|04|05|49|50|51|52|53|54|55|99", rate: "d:4:3", base_rate: "d:4:3", framing_code: "x:^[0-9]{3}$", taxation: "e:T|I|O" },
    pis: {
      situation: "e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99", rate: "d:4:3", base_rate: "d:4:3",
      taxation: "e:T|I|O",
    },
    cofins: {
      situation: "e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99", rate: "d:4:3", base_rate: "d:4:3",
      taxation: "e:T|I|O",
    },
    ii: { situation: "e:T|N", rate: "d:4:3", base_rate: "d:4:3", taxation: "e:T|I|O" },
  },
  others: {
    presumed_pis_cofins: "b", add_icms: "b", add_other_expenses: "b", funrural_rate: "d:4:3", rural_producer_purchase: "b", deduct_funrural: "b",
    approx_tax_type: "e:table|fixed|product", approx_tax_rate: "d:4:3", discount_type: "e:C|I", simples_credit_rate: "d:4:3",
  },
  retentions: { csrf: "b", csrf_rate: "d:4:3", ir: "b", ir_rate: "d:4:3" },
  tax_settings: {
    exclude_icms_pis_cofins: "b", exclude_icms_st_pis_cofins: "b", st_contributor_differentiated: "b", st_retained_from_sale: "b",
    difal_default: "e:inside|goods|none|validated", ipi_in_icms_import: "b",
  },
};

const TAXES = ["icms", "ipi", "pis", "cofins", "ii"];
const has = (o: Json, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** p_data->'k' com coalesce(…, '[]'): ausente vira lista vazia; null do JSON fica null. */
const listOr = (o: Json, k: string) => (has(o, k) ? o[k] : []);
/** jsonb_array_elements_text: texto como está, o resto como jsonb::text, null do JSON vira NULL. */
const elementText = (v: unknown) => (v === null ? null : typeof v === "string" ? v : jsonbText(v));
const distinctCount = (xs: (string | null)[]) => new Set(xs.filter((x) => x !== null)).size;
const sortText = (xs: (string | null)[]) => [...xs].sort(pgCompareText);

/** erp_fiscal_invoices.nature_rule_input(regra, crt, direção) */
export function natureRuleInput(db: SqlDriver, rule: unknown, crt: string, direction: string): Json {
  const bad = (m = "erp_fiscal_rule_invalid"): never => raise("22023", m);
  const allowed = ["tax", "destinations", "product_scope", "ncms", "product_ids", "group_ids", "data", "additional_info", "fiscal_info"];
  if (jsonType(rule) !== "object" || Object.keys(rule as Json).some((k) => !allowed.includes(k))) bad();
  const r = rule as Json;
  const tax = r.tax;
  if (typeof tax !== "string" || !TAXES.includes(tax)) bad();
  const spec = NATURE_SPECS.rules[tax === "icms" ? (crt === "3" ? "icms_normal" : "icms_sn") : (tax as string)];
  const data = specObject(has(r, "data") ? r.data : null, spec);
  if (!has(data, "situation")) bad("erp_fiscal_rule_situation_required");
  if (tax === "ipi" && !ipiSituationAllowed(direction, data.situation as string)) bad("erp_fiscal_rule_situation_invalid");
  const destinations = listOr(r, "destinations");
  if (jsonType(destinations) !== "array" || (destinations as unknown[]).length > 28) bad();
  const dest = sortText((destinations as unknown[]).map(elementText));
  if ((destinations as unknown[]).some((x) => jsonType(x) !== "string") || dest.some((d) => d !== null && ![...UFS, "EX"].includes(d)) || dest.length !== distinctCount(dest))
    bad("erp_fiscal_rule_destination_invalid");
  const scope = has(r, "product_scope") && r.product_scope !== null ? elementText(r.product_scope)! : "any";
  if (!["any", "ncm", "products", "groups"].includes(scope)) bad();
  const ncmsIn = listOr(r, "ncms"),
    productsIn = listOr(r, "product_ids"),
    groupsIn = listOr(r, "group_ids");
  if (
    jsonType(ncmsIn) !== "array" || jsonType(productsIn) !== "array" || jsonType(groupsIn) !== "array" ||
    (ncmsIn as unknown[]).length > 10 || (productsIn as unknown[]).length > 10 || (groupsIn as unknown[]).length > 10
  )
    bad("erp_fiscal_rule_product_invalid");
  const ncms = sortText((ncmsIn as unknown[]).map(elementText));
  if (ncms.some((n) => n !== null && !/^[0-9]{2}([0-9]{2}){0,3}$/.test(n)) || ncms.length !== distinctCount(ncms)) bad("erp_fiscal_rule_product_invalid");
  // array_agg(uuid_input(x) order by x::text): a conversão na ordem da lista, a ordem pelo texto jsonb do elemento.
  const byJson = (xs: unknown[]) => xs.map((x) => ({ id: uuidInput(x), key: jsonbText(x) })).sort((p, q) => pgCompareText(p.key, q.key)).map((p) => p.id!);
  const products = byJson(productsIn as unknown[]);
  if (
    products.length !== new Set(products).size ||
    products.some((p) => !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='products'`, p))
  )
    bad("erp_fiscal_rule_product_invalid");
  const groups = byJson(groupsIn as unknown[]);
  if (groups.length !== new Set(groups).size || groups.some((g) => !one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind='product_groups'`, g)))
    bad("erp_fiscal_rule_group_invalid");
  const counts = [ncms.length, products.length, groups.length];
  const only = (i: number) => counts.every((c, j) => (j === i ? c > 0 : c === 0));
  if ((scope === "any" && counts.some((c) => c > 0)) || (scope === "ncm" && !only(0)) || (scope === "products" && !only(1)) || (scope === "groups" && !only(2)))
    bad("erp_fiscal_rule_product_invalid");
  return {
    tax, destinations: dest, product_scope: scope, ncms, product_ids: products, data,
    additional_info: textInput(r.additional_info, 2000, false, true), fiscal_info: textInput(r.fiscal_info, 2000, false, true),
    ...(scope === "groups" ? { group_ids: groups } : {}),
  };
}

const NATURE_KEYS = [
  "description", "series", "direction", "crt", "presence", "invoiced", "final_consumer", "return_operation", "update_last_purchase_price", "include_freight_ipi_base",
  "others", "retentions", "additional_info", "fiscal_info", "rules",
];
/** erp_fiscal_invoices.nature_input(dados) */
export function natureInput(db: SqlDriver, value: unknown): Json {
  const bad = (): never => raise("22023", "erp_fiscal_nature_invalid");
  if (jsonType(value) !== "object" || Object.keys(value as Json).some((k) => !NATURE_KEYS.includes(k))) bad();
  const p = value as Json;
  const direction = elementText(p.direction ?? null);
  const crt = elementText(p.crt ?? null);
  const presence = p.presence === undefined || p.presence === null ? "9" : elementText(p.presence)!;
  if (
    typeof p.direction !== "string" || !["0", "1"].includes(direction!) || typeof p.crt !== "string" || !["1", "2", "3", "4"].includes(crt!) ||
    !["0", "1", "2", "3", "4", "5", "9"].includes(presence) || (has(p, "presence") && jsonType(p.presence) !== "string")
  )
    bad();
  let series: number | null = null;
  if (p.series !== undefined && p.series !== null) {
    if (typeof p.series !== "string" || !/^(0|[1-9][0-9]{0,2})$/.test(p.series)) bad();
    series = Number(p.series);
  }
  const rulesIn = listOr(p, "rules");
  if (jsonType(rulesIn) !== "array" || (rulesIn as unknown[]).length > 250) bad();
  const rules: Json[] = [];
  for (const r of rulesIn as unknown[]) {
    const n = natureRuleInput(db, r, crt!, direction!);
    if (rules.filter((x) => x.tax === n.tax).length >= 50) bad();
    rules.push(n);
  }
  if (direction === "1" && boolInput(p.update_last_purchase_price, false)) bad();
  return {
    description: textInput(p.description, 60, true), series, direction, crt, presence,
    invoiced: boolInput(p.invoiced, true), final_consumer: boolInput(p.final_consumer, false), return_operation: boolInput(p.return_operation, false),
    update_last_purchase_price: boolInput(p.update_last_purchase_price, false), include_freight_ipi_base: boolInput(p.include_freight_ipi_base, false),
    others: specObject(p.others, NATURE_SPECS.others), retentions: specObject(p.retentions, NATURE_SPECS.retentions),
    additional_info: textInput(p.additional_info, 5000, false, true), fiscal_info: textInput(p.fiscal_info, 2000, false, true), rules,
  };
}

/** erp_fiscal_invoices.replace_rules(natureza, regras): posição contada por imposto. */
export function replaceRules(db: SqlDriver, id: string, rules: Json[]) {
  db.exec('DELETE FROM "erp_fiscal_invoices__nature_rule" WHERE nature_id=?', id);
  const positions = new Map<string, number>();
  for (const r of rules) {
    const pos = (positions.get(r.tax as string) ?? 0) + 1;
    positions.set(r.tax as string, pos);
    db.exec(
      `INSERT INTO "erp_fiscal_invoices__nature_rule"(nature_id, tax, position, destinations, product_scope, ncms, product_ids, group_ids, data, additional_info, fiscal_info)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, r.tax, pos, JSON.stringify(r.destinations), r.product_scope, JSON.stringify(r.ncms), JSON.stringify(r.product_ids), JSON.stringify(r.group_ids ?? []),
      JSON.stringify(r.data), r.additional_info, r.fiscal_info,
    );
  }
}

const NATURE = "erp_fiscal_invoices__nature";
const RULE = "erp_fiscal_invoices__nature_rule";
/** A linha da natureza como to_jsonb, ou nada. */
export function natureRow(db: SqlDriver, id: string | null): Json | null {
  const r = one(db, `SELECT ${rowJsonSelect(NATURE)} FROM "${NATURE}" WHERE id=?`, id);
  return r ? rowJson(NATURE, r) : null;
}

/** erp_fiscal_invoices.nature_record(id) */
export function natureRecord(db: SqlDriver, id: string | null): Json | null {
  const n = natureRow(db, id);
  if (!n) return null;
  const rules = db
    .exec(`SELECT ${rowJsonSelect(RULE)} FROM "${RULE}" WHERE nature_id=?`, id)
    .rows.map((x) => rowJson(RULE, x))
    .sort((a, b) => TAXES.indexOf(a.tax as string) - TAXES.indexOf(b.tax as string) || Number(a.position) - Number(b.position))
    .map((r) => {
      const ids = r.product_ids as string[];
      const products = db
        .exec(`SELECT id, name, code FROM "erp_catalog__record" WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
        .rows.map((c) => ({ id: String(c.id), name: c.name as string, code: (c.code as string | null) ?? null }))
        .sort((a, b) => pgCompareText(a.name, b.name) || pgCompareText(a.id, b.id));
      const out: Json = {
        tax: r.tax, position: r.position, destinations: r.destinations, product_scope: r.product_scope, ncms: r.ncms, product_ids: r.product_ids, products,
        data: r.data, additional_info: r.additional_info, fiscal_info: r.fiscal_info,
      };
      if (r.product_scope === "groups") {
        out.group_ids = r.group_ids;
        out.groups = db
          .exec(`SELECT id, name FROM "erp_catalog__taxonomy" WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(r.group_ids))
          .rows.map((t) => ({ id: String(t.id), name: t.name as string }))
          .sort((a, b) => pgCompareText(a.name, b.name) || pgCompareText(a.id, b.id));
      }
      return out;
    });
  return {
    id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced,
    final_consumer: n.final_consumer, return_operation: n.return_operation, update_last_purchase_price: n.update_last_purchase_price,
    include_freight_ipi_base: n.include_freight_ipi_base, others: n.others, retentions: n.retentions, additional_info: n.additional_info, fiscal_info: n.fiscal_info,
    active: n.active, version: n.version, created_at: n.created_at, updated_at: n.updated_at, rules, defaults: natureDefaults(db, id!),
  };
}

/** Códigos de padrão da natureza, em ordem. */
export const natureDefaults = (db: SqlDriver, id: string) =>
  db.exec('SELECT code FROM "erp_fiscal_invoices__nature_default" WHERE nature_id=?', id).rows.map((d) => String(d.code)).sort(pgCompareText);

/** erp_fiscal_invoices.nature_review_record() */
export function natureReviewRecord(db: SqlDriver): Json {
  const r = one(db, 'SELECT version, CAST(confirmed_at AS TEXT) confirmed_at FROM "erp_fiscal_invoices__nature_review" WHERE singleton=1');
  return r ? { confirmed: true, version: Number(r.version), confirmed_at: jsonTimestamp(String(r.confirmed_at)) } : { confirmed: false, version: 0, confirmed_at: null };
}

type NatureIdentity = { id: unknown; direction: unknown; created_at: unknown; created_by: unknown; version: unknown; deleted_at: unknown };
/**
 * Gatilho guard_nature (BEFORE UPDATE OR DELETE de erp_fiscal_invoices.nature):
 * a natureza nunca é apagada; o id, a direção, a criação e o autor não mudam;
 * a versão sobe de um em um; a natureza excluída (deleted_at) não muda mais.
 * Chamado antes de cada UPDATE que o motor faz na natureza.
 */
export function guardNature(op: "UPDATE" | "DELETE", old: NatureIdentity, next: NatureIdentity | null) {
  if (op === "DELETE") raise("42501", "erp_fiscal_nature_no_delete");
  const n = next!;
  if (
    n.id !== old.id || n.direction !== old.direction || String(n.created_at) !== String(old.created_at) || n.created_by !== old.created_by ||
    Number(old.version) === 2147483647 || Number(n.version) !== Number(old.version) + 1
  )
    raise("40001", "erp_fiscal_nature_immutable_identity");
  if (old.deleted_at !== null && old.deleted_at !== undefined) raise("40001", "erp_fiscal_nature_deleted");
}

/** A identidade da natureza como o gatilho a vê (linha do SQLite). */
export const natureIdentity = (db: SqlDriver, id: string | null): NatureIdentity | undefined =>
  one(db, `SELECT id, direction, CAST(created_at AS TEXT) created_at, created_by, version, deleted_at FROM "${NATURE}" WHERE id=?`, id) as NatureIdentity | undefined;

/** INSERT da natureza (create e clone); devolve o id. */
export function insertNature(ctx: RpcContext, n: Json, actor: string): string {
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  ctx.db.exec(
    `INSERT INTO "${NATURE}"(id, description, series, direction, crt, presence, invoiced, final_consumer, return_operation, update_last_purchase_price, include_freight_ipi_base,
       others, retentions, additional_info, fiscal_info, active, version, created_by, updated_by, created_at, updated_at, description__fold)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)`,
    id, n.description, n.series, n.direction, n.crt, n.presence, n.invoiced ? 1 : 0, n.final_consumer ? 1 : 0, n.return_operation ? 1 : 0,
    n.update_last_purchase_price ? 1 : 0, n.include_freight_ipi_base ? 1 : 0, JSON.stringify(n.others), JSON.stringify(n.retentions), n.additional_info, n.fiscal_info,
    actor, actor, now, now, pgLower(String(n.description)),
  );
  return id;
}
