// Importações por planilha da versão 28: dados fiscais dos produtos, naturezas
// de operação com as regras fiscais e saldos iniciais das contas financeiras.
// Cada linha grava pelas RPCs dos domínios (cadastro do produto, natureza de
// operação e lançamento de caixa do Financeiro), com as regras das telas; a
// validação roda a mesma linha e devolve em reference o que ela muda (a prévia).
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { jsonbText } from "../../engine/json.ts";
import { invokeRpc, type RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgLeft, pgLower } from "../../engine/text.ts";
import { ipiSituationAllowed, type Json } from "../fiscal/core.ts";
import { natureRecord } from "../fiscal/natures.ts";
import { importFail, importNamed, importProduct, type ImportItemResult } from "./import-items.ts";

type Data = Record<string, unknown>;
type Rule = { tax: string; destinations: string[]; product_scope: string; ncms: string[]; product_ids: string[]; group_ids?: string[]; data: Json; additional_info: unknown; fiscal_info: unknown };

/** Começo da prévia da natureza que tira o padrão de outra (IMPORT_DEFAULT_CHANGE do contrato da planilha). */
export const IMPORT_DEFAULT_CHANGE = "Troca a natureza padrão";
const DEFAULT_LABELS: Record<string, string> = {
  S: "Padrão venda", E: "Padrão compra", VF: "Padrão venda física", VJ: "Padrão venda jurídica", CF: "Padrão compra física",
  CJ: "Padrão compra jurídica", C: "Padrão venda cupom", DE: "Padrão devolução (entrada)", DS: "Padrão devolução (saída)",
};
const TAXES = ["icms", "ipi", "pis", "cofins", "ii"];
const CST = /^(00|02|10|15|20|30|40|41|50|51|53|60|61|70|90)$/, CSOSN = /^(101|102|103|201|202|203|300|400|500|900|02|15|53|61)$/;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const fold = (v: unknown) => pgLower(pgBtrim(String(v ?? "")));
/** Comando de cada RPC da linha, derivado do comando da linha (a mesma linha reenviada repete os mesmos). */
function sub(command: string, tag: string): string {
  const h = createHash("md5").update(`erp-import-sub:${command}:${tag}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Decimal da planilha na escala das regras (d:4:3 de nature_specs): "18" vira "18.0000". */
const rate = (v: unknown) => {
  const [whole, frac = ""] = String(v).split(".");
  return `${whole}.${frac.padEnd(4, "0")}`;
};
const same = (a: unknown, b: unknown) => jsonbText(a) === jsonbText(b);
const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
function money(cents: bigint): string {
  const negative = cents < 0n, abs = negative ? -cents : cents, whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${whole},${(abs % 100n).toString().padStart(2, "0")}`;
}
const done = (action: ImportItemResult["action"], id: unknown, reference: string, unchanged = false): ImportItemResult =>
  ({ action, record_id: str(id), reference: pgLeft(reference, 120), unchanged });

// ---- Naturezas: leitura para regravar pelo erp_fiscal_nature_execute ----
function ruleInput(r: Json): Rule {
  return {
    tax: String(r.tax), destinations: [...(r.destinations as string[])], product_scope: String(r.product_scope), ncms: [...(r.ncms as string[])],
    product_ids: [...(r.product_ids as string[])], ...(r.product_scope === "groups" ? { group_ids: [...(r.group_ids as string[])] } : {}),
    data: { ...(r.data as Json) }, additional_info: r.additional_info ?? null, fiscal_info: r.fiscal_info ?? null,
  };
}
function natureBody(rec: Json, rules: Rule[]): Json {
  return {
    description: rec.description, series: rec.series === null || rec.series === undefined ? null : String(rec.series), direction: rec.direction, crt: rec.crt,
    presence: rec.presence, invoiced: rec.invoiced, final_consumer: rec.final_consumer, return_operation: rec.return_operation,
    update_last_purchase_price: rec.update_last_purchase_price, include_freight_ipi_base: rec.include_freight_ipi_base, others: rec.others,
    retentions: rec.retentions, additional_info: rec.additional_info, fiscal_info: rec.fiscal_info, rules,
  };
}
const byTax = (rules: Rule[]) => [...rules].sort((a, b) => TAXES.indexOf(a.tax) - TAXES.indexOf(b.tax));
/** A situação do imposto cabe no regime (CST no Regime normal, CSOSN no Simples) e na direção (IPI) da natureza. */
function situationFits(tax: string, situation: string, crt: unknown, direction: unknown, field: string) {
  if (tax === "icms" && !(crt === "3" ? CST : CSOSN).test(situation)) importFail(`erp_preferences_import_icms_regime:${field}`);
  if (tax === "ipi" && !ipiSituationAllowed(String(direction), situation)) importFail(`erp_preferences_import_ipi_direction:${field}`);
}
function natureByName(db: SqlDriver, name: string | null): string {
  if (name === null) {
    const d = one(db, `SELECT nature_id FROM "erp_fiscal_invoices__nature_default" WHERE code='S'`);
    if (!d) importFail("erp_preferences_import_required:nature");
    return String(d!.nature_id);
  }
  const rows = db.exec(`SELECT id, description FROM "erp_fiscal_invoices__nature" WHERE deleted_at IS NULL AND active=1`).rows.filter((r) => fold(r.description) === fold(name));
  if (rows.length > 1) importFail("erp_preferences_import_ambiguous:nature");
  if (!rows.length) importFail("erp_preferences_import_not_found:nature");
  return String(rows[0].id);
}
function saveNature(ctx: RpcContext, user: string, command: string, id: string | null, version: unknown, nature: Json): string {
  const out = invokeRpc(ctx, "erp_fiscal_nature_execute", {
    p_user_id: user, p_command_id: command, p_action: id === null ? "create" : "update",
    p_data: id === null ? { nature } : { id, expected_version: version, nature },
  }) as { nature: Json };
  return String(out.nature.id);
}

// ---- Dados fiscais dos produtos ----
const PRODUCT_FIELDS: [string, string][] = [["ncm", "NCM"], ["cest", "CEST"], ["origin", "Origem"], ["gtin_tax", "GTIN tributável"]];
function productByGtin(db: SqlDriver, gtin: string | null): string {
  const rows = db.exec(`SELECT r.id FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.entity='products' AND p.gtin=?
    AND NOT EXISTS(SELECT 1 FROM erp_catalog__product_detail d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL) ORDER BY r.id`, gtin).rows;
  if (rows.length > 1) importFail("erp_preferences_import_ambiguous:gtin");
  if (!rows.length) importFail("erp_preferences_import_not_found:gtin");
  return String(rows[0].id);
}
/** A regra só deste produto no imposto: sai da regra em que estava e entra numa com os mesmos dados (até 10 produtos) ou numa nova. */
function placeProduct(rules: Rule[], tax: string, product: string, sheet: Json): boolean {
  const own = (r: Rule) => r.tax === tax && r.product_scope === "products" && r.destinations.length === 0;
  const mine = rules.findIndex((r) => own(r) && r.product_ids.includes(product));
  const data = { ...(mine >= 0 ? rules[mine].data : {}), ...sheet };
  if (mine >= 0 && same(rules[mine].data, data)) return false;
  if (mine >= 0) {
    const r = rules[mine];
    r.product_ids = r.product_ids.filter((p) => p !== product);
    if (!r.product_ids.length) rules.splice(mine, 1);
  }
  const target = rules.find((r) => own(r) && r.product_ids.length < 10 && same(r.data, data) && r.additional_info === null && r.fiscal_info === null);
  if (target) target.product_ids = [...target.product_ids, product].sort();
  else {
    if (rules.filter((r) => r.tax === tax).length >= 50) importFail(`erp_preferences_import_rules_full:${tax}_situation`);
    if (rules.length >= 250) importFail(`erp_preferences_import_rules_full:${tax}_situation`);
    rules.push({ tax, destinations: [], product_scope: "products", ncms: [], product_ids: [product], data, additional_info: null, fiscal_info: null });
  }
  return true;
}

export function importProductTaxes(ctx: RpcContext, user: string, command: string, data: Data): ImportItemResult {
  const db = ctx.db;
  const id = data.code !== undefined ? importProduct(db, str(data.code), "code", true)! : productByGtin(db, str(data.gtin));
  const product = one(db, `SELECT r.code, r.name, r.version, p.unit, p.ncm, p.cest, p.origin, p.gtin_tax FROM erp_catalog__record r
    JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?`, id)!;
  const label = String(product.code ?? product.name);
  const changes: string[] = [], patch: Record<string, string> = {};
  for (const [key, name] of PRODUCT_FIELDS) {
    const value = str(data[key]);
    if (value === null) continue;
    const old = str(product[key]);
    if (old !== value) { patch[key] = value; changes.push(old === null ? `${name} ${value}` : `${name} ${old}→${value}`); }
  }
  if ((patch.cest ?? str(product.cest)) !== null && (patch.ncm ?? str(product.ncm)) === null) importFail("erp_preferences_import_cest_without_ncm:cest");
  // O ERP não guarda unidade tributável à parte: a NF-e usa a unidade do produto.
  if (data.tax_unit !== undefined && fold(data.tax_unit) !== fold(product.unit)) importFail("erp_preferences_import_tax_unit:tax_unit");
  if (Object.keys(patch).length)
    invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: user, p_id: id, p_expected_version: Number(product.version), p_command_id: sub(command, "product"), p_data: patch, p_acknowledged: null });
  const taxes = ["icms", "ipi", "pis", "cofins"].filter((tax) => data[`${tax}_situation`] !== undefined);
  if (taxes.length) {
    const nature = natureByName(db, str(data.nature));
    const rec = natureRecord(db, nature)!;
    const before = (rec.rules as Json[]).map(ruleInput), rules = before.map((r) => ({ ...r, product_ids: [...r.product_ids], data: { ...r.data } }));
    const touched: string[] = [];
    for (const tax of taxes) {
      const situation = String(data[`${tax}_situation`]);
      situationFits(tax, situation, rec.crt, rec.direction, `${tax}_situation`);
      const sheet: Json = { situation };
      if (data[`${tax}_rate`] !== undefined) sheet.rate = rate(data[`${tax}_rate`]);
      if (tax === "icms" && data.icms_cfop !== undefined) sheet.cfop = String(data.icms_cfop);
      if (tax === "icms" && data.benefit_code !== undefined) sheet.benefit_code = String(data.benefit_code);
      if (placeProduct(rules, tax, id, sheet)) touched.push(tax.toUpperCase());
    }
    if (touched.length) {
      saveNature(ctx, user, sub(command, "nature"), nature, rec.version, natureBody(rec, byTax(rules)));
      changes.push(`${touched.join(", ")} em ${String(rec.description)}`);
    }
  }
  if (!changes.length) return done("update", id, `${label}: sem alteração`, true);
  return done("update", id, `${label}: ${changes.join(" · ")}`);
}

// ---- Naturezas de operação e regras fiscais ----
export function importNature(ctx: RpcContext, user: string, command: string, data: Data, dry: boolean): ImportItemResult {
  const db = ctx.db, description = String(data.description), direction = String(data.direction);
  const found = db.exec(`SELECT id, description FROM "erp_fiscal_invoices__nature" WHERE deleted_at IS NULL AND direction=?`, direction).rows
    .filter((r: Row) => fold(r.description) === fold(description));
  if (found.length > 1) importFail("erp_preferences_import_ambiguous:description");
  const rec = found.length ? natureRecord(db, String(found[0].id))! : null;
  const crt = data.crt !== undefined ? String(data.crt) : rec ? String(rec.crt) : importFail("erp_preferences_import_required:crt");
  const sheet: Rule[] = ((data.items as Data[] | undefined) ?? []).filter((item) => item.tax !== undefined).map((item) => {
    const tax = String(item.tax), situation = String(item.situation);
    situationFits(tax, situation, crt, direction, "item_situation");
    const values: Json = { situation };
    for (const key of ["cfop", "benefit_code"]) if (item[key] !== undefined) values[key] = String(item[key]);
    for (const key of ["rate", "base_rate"]) if (item[key] !== undefined) values[key] = rate(item[key]);
    const ncms = (item.ncms as string[] | undefined) ?? [];
    return { tax, destinations: [...((item.destinations as string[] | undefined) ?? [])].sort(), product_scope: ncms.length ? "ncm" : "any", ncms: [...ncms].sort(),
      product_ids: [], data: values, additional_info: null, fiscal_info: null };
  });
  const taxes = new Set(sheet.map((r) => r.tax));
  const old = rec ? (rec.rules as Json[]).map(ruleInput) : [];
  // As regras da planilha trocam as gerais e por NCM dos impostos que aparecem nela; as por produto ou grupo ficam.
  const kept = old.filter((r) => !taxes.has(r.tax) || r.product_scope === "products" || r.product_scope === "groups");
  const rules = byTax([...kept, ...sheet]);
  if (rules.filter((r) => r.tax === "icms").length > 50 || rules.length > 250) importFail("erp_preferences_import_rules_full:item_tax");
  const head: Json = rec ? natureBody(rec, rules) : { description, direction, crt, rules };
  head.description = description;
  head.crt = crt;
  if (data.series !== undefined) head.series = String(data.series);
  for (const key of ["final_consumer", "additional_info", "fiscal_info"]) if (data[key] !== undefined) head[key] = data[key];
  const changes: string[] = [];
  let id = rec ? String(rec.id) : null;
  if (!rec) {
    id = saveNature(ctx, user, sub(command, "nature"), null, null, head);
    changes.push(`Nova natureza · ${sheet.length} ${sheet.length === 1 ? "regra" : "regras"}`);
  } else if (!same(head, natureBody(rec, old))) {
    saveNature(ctx, user, sub(command, "nature"), id, rec.version, head);
    const removed = old.length - kept.length;
    changes.push(sheet.length || removed ? `${sheet.length} ${sheet.length === 1 ? "regra" : "regras"} da planilha${removed ? `, ${removed} substituída(s)` : ""}` : "dados da natureza");
  }
  const pending: string[] = [];
  for (const code of (data.default_for as string[] | undefined) ?? []) {
    const current = one(db, `SELECT d.nature_id, n.description FROM "erp_fiscal_invoices__nature_default" d JOIN "erp_fiscal_invoices__nature" n ON n.id=d.nature_id WHERE d.code=?`, code);
    if (current && String(current.nature_id) === id) continue;
    // Tirar o padrão de outra natureza só com a confirmação da tela.
    if (current && data.confirm_default !== true) { pending.push(`${DEFAULT_LABELS[code]} (hoje: ${String(current.description)})`); continue; }
    const now = one(db, `SELECT version, active FROM "erp_fiscal_invoices__nature" WHERE id=?`, id)!;
    if (!now.active) importFail("erp_preferences_import_nature_inactive:default_for");
    invokeRpc(ctx, "erp_fiscal_nature_execute", { p_user_id: user, p_command_id: sub(command, `default:${code}`), p_action: "set_default",
      p_data: { id, expected_version: Number(now.version), code } });
    changes.push(`${current ? "passa a ser" : "fica"} ${DEFAULT_LABELS[code]}${current ? ` (era ${String(current.description)})` : ""}`);
  }
  if (pending.length) {
    // Na importação sem confirmação o padrão continua o de hoje; a validação avisa antes.
    const text = dry ?`${IMPORT_DEFAULT_CHANGE}: ${pending.join(", ")}` : `Padrão mantido sem confirmação: ${pending.join(", ")}`;
    changes.unshift(text);
  }
  if (!changes.length) return done("update", id, `${description}: sem alteração`, true);
  return done(rec ? "update" : "create", id, pending.length ? changes.join(" · ") : `${description}: ${changes.join(" · ")}`);
}

// ---- Saldos iniciais das contas financeiras ----
function cents(value: string): bigint {
  const negative = value.startsWith("-"), [whole, frac = ""] = value.replace(/^-/, "").split(".");
  const n = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -n : n;
}
export function importOpeningBalance(ctx: RpcContext, user: string, command: string, file: string, data: Data): ImportItemResult {
  const db = ctx.db, on = String(data.date), target = cents(String(data.balance));
  const id = importNamed(db, "accounts", str(data.account), "account")!;
  const account = one(db, `SELECT name, start_on FROM "erp_finance__account" WHERE id=?`, id)!;
  if (account.start_on !== null && on < String(account.start_on)) importFail("erp_preferences_import_before_start:date");
  const opening = one(db, `SELECT max(posted_on) d FROM "erp_finance__movement" WHERE account_id=? AND kind='opening'`, id)?.d;
  if (opening !== null && opening !== undefined && on < String(opening)) importFail("erp_preferences_import_before_start:date");
  const before = BigInt(String(one(db, `SELECT CAST(coalesce(sum(delta_cents),0) AS TEXT) b FROM "erp_finance__movement" WHERE account_id=? AND posted_on<=?`, id, on)!.b));
  const name = String(account.name), delta = target - before;
  if (delta === 0n) return done("update", id, `${name}: saldo em ${day(on)} já é ${money(target)}`, true);
  const note = [`Saldo inicial importado da planilha ${file}`, str(data.note)].filter(Boolean).join(" · ");
  // O mesmo lançamento do Financeiro (e do corte do Bling): entrada ou saída de caixa pela diferença no dia.
  const out = invokeRpc(ctx, "erp_finance_cash_execute", { p_user_id: user, p_command_id: sub(command, "opening"), p_action: "entry_save",
    p_data: { expected_version: 0, account_id: id, kind: delta > 0n ? "in" : "out", amount_cents: (delta > 0n ? delta : -delta).toString(), posted_on: on, competence_on: on,
      category_id: null, contact_id: null, note: pgLeft(note, 2000), origin: "manual" } }) as { record: Json };
  return done("create", out.record.id, `${name}: em ${day(on)} ${money(before)} → ${money(target)} (${delta > 0n ? "entrada" : "saída"} de ${money(delta > 0n ? delta : -delta)})`);
}
