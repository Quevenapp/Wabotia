// Classificação de IBS/CBS da reforma tributária (structural.ts,
// reforma-classificacao): tabelas só do motor, que o Fagoo não tem. A
// natureza guarda o padrão (escopo any) e as exceções por NCM, produto ou
// grupo; o produto guarda a dele (e o NBS do serviço). A resolução segue a
// matchRule do Fagoo (packages/fiscal-core/src/tax-engine.mjs), sem destino:
// produto do cadastro > exceção por produto > por grupo > pelo NCM de prefixo
// mais longo > padrão; empate, a menor posição.
// RPCs só do motor (sem assinatura no oráculo; rota própria do Wabotia em
// src/erp/reforma, /erp-reforma): erp_fiscal_reform_nature_class_get e _save
// e, na versão 26, a configuração, o produto, o contexto dos documentos e o
// relatório (fim do arquivo). O _save troca a lista inteira,
// com o hash da lista lida como versão esperada, recibo e auditoria nas
// tabelas do Fiscal (escopo nature, que o check do comando aceita).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbArg } from "../../engine/args.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { pgCompareText } from "../../engine/text.ts";
import { commandHash, commandReplay, finishCommand, requireRead, requireWrite, uuidInput, type Json } from "./core.ts";
import { reformCst, REFORM_FIRST_YEAR, REFORM_LAST_YEAR, REFORM_TABLE_SOURCE, REFORM_TABLE_VERSION, REFORM_YEAR_RATES, SELECTIVE_CSTS } from "./reform-table.ts";
import { reformRatesFor, regimeOf, validReformRate, type ReformCompanySettings, type ReformSelectiveInput } from "./reform-calc.ts";
import { erpFiscalTaxEstimateContextV2 } from "./rpc/erp_fiscal_tax_settings.ts";
import { readCommercialSettings } from "./comnfe/settings.ts";
import { todaySaoPaulo } from "../../engine/time.ts";

const NATURE_CLASS = "erp_fiscal_reform__nature_class";
const PRODUCT_CLASS = "erp_fiscal_reform__product_class";
const SCOPES = ["any", "ncm", "products", "groups"];
const bad = (m = "erp_fiscal_reform_class_invalid"): never => raise("22023", m);

export interface ReformClass {
  position: number;
  product_scope: string;
  ncms: string[];
  product_ids: string[];
  group_ids: string[];
  cst: string;
  cclasstrib: string;
}

/** CST de IBS/CBS (3 dígitos, da tabela) e cClassTrib (6 dígitos, começando pelo CST). */
function classCodes(v: Json) {
  if (typeof v.cst !== "string" || !/^[0-9]{3}$/.test(v.cst) || !reformCst(v.cst)) bad("erp_fiscal_reform_cst_invalid");
  if (typeof v.cclasstrib !== "string" || !/^[0-9]{6}$/.test(v.cclasstrib) || !v.cclasstrib.startsWith(v.cst as string)) bad("erp_fiscal_reform_cclasstrib_invalid");
  return { cst: v.cst as string, cclasstrib: v.cclasstrib as string };
}

/** Uma exceção ou o padrão: o escopo e as listas como nas regras da natureza. */
export function natureClassInput(db: SqlDriver, value: unknown, position: number): ReformClass {
  const allowed = ["product_scope", "ncms", "product_ids", "group_ids", "cst", "cclasstrib"];
  if (jsonType(value) !== "object" || Object.keys(value as Json).some((k) => !allowed.includes(k))) bad();
  const v = value as Json;
  const raw = v.product_scope === undefined ? "any" : v.product_scope;
  if (typeof raw !== "string" || !SCOPES.includes(raw)) bad();
  const scope = raw as string;
  const list = (k: string) => {
    const x = v[k] === undefined ? [] : v[k];
    if (!Array.isArray(x) || x.length > 10) bad();
    return x as unknown[];
  };
  const ncms = list("ncms");
  if (ncms.some((n) => typeof n !== "string" || !/^[0-9]{2}([0-9]{2}){0,3}$/.test(n)) || new Set(ncms).size !== ncms.length) bad();
  const products = list("product_ids").map((x) => uuidInput(x)!);
  if (new Set(products).size !== products.length || products.some((p) => !one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', p)))
    bad("erp_fiscal_reform_product_invalid");
  const groups = list("group_ids").map((x) => uuidInput(x)!);
  if (new Set(groups).size !== groups.length || groups.some((g) => !one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind='product_groups'`, g)))
    bad("erp_fiscal_reform_group_invalid");
  const counts = { ncm: ncms.length, products: products.length, groups: groups.length };
  const fits = Object.entries(counts).every(([k, c]) => (k === scope ? c > 0 : c === 0));
  if (scope === "any" ? Object.values(counts).some((c) => c > 0) : !fits) bad();
  return {
    position, product_scope: scope, ncms: [...(ncms as string[])].sort(pgCompareText), product_ids: [...products].sort(pgCompareText), group_ids: [...groups].sort(pgCompareText),
    ...classCodes(v),
  };
}

/** A lista da natureza, na ordem da posição. */
export function natureClasses(db: SqlDriver, nature: string): ReformClass[] {
  return db
    .exec(`SELECT position, product_scope, ncms, product_ids, group_ids, cst, cclasstrib FROM "${NATURE_CLASS}" WHERE nature_id=? ORDER BY position`, nature)
    .rows.map((r) => ({
      position: Number(r.position), product_scope: String(r.product_scope), ncms: JSON.parse(String(r.ncms)), product_ids: JSON.parse(String(r.product_ids)),
      group_ids: JSON.parse(String(r.group_ids)), cst: String(r.cst), cclasstrib: String(r.cclasstrib),
    }));
}

/** Versão esperada da lista: o sha256 do texto jsonb dela (a lista vazia também tem hash). */
export const classesHash = (rows: ReformClass[]) => createHash("sha256").update(jsonbText(rows), "utf8").digest("hex");

function activeNature(db: SqlDriver, id: string | null) {
  const n = one(db, 'SELECT id FROM "erp_fiscal_invoices__nature" WHERE id=? AND deleted_at IS NULL', id);
  if (!n) raise("P0002", "erp_fiscal_nature_not_found");
  return String(n!.id);
}

export function erpFiscalReformNatureClassGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireRead(db, (a.p_user_id as string | null) ?? null);
  const nature = activeNature(db, uuidInput(a.p_nature_id ?? null));
  const rules = natureClasses(db, nature);
  return { nature_id: nature, rules, expected_hash: classesHash(rules), writable: ["admin", "fiscal"].includes(role), data_mode: "erp_native" };
}

export function erpFiscalReformNatureClassSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = (a.p_user_id as string | null) ?? null;
  requireWrite(db, user);
  const commandId = uuidInput(a.p_command_id ?? null);
  const nature = uuidInput(a.p_nature_id ?? null)!;
  const expected = a.p_expected_hash;
  const input = jsonbArg(a.p_rules ?? null);
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected) || !Array.isArray(input) || input.length > 50) bad("erp_fiscal_command_invalid");
  const rules = (input as unknown[]).map((r, i) => natureClassInput(db, r, i + 1));
  if (rules.filter((r) => r.product_scope === "any").length > 1) bad("erp_fiscal_reform_default_repeated");
  const data = { nature_id: nature, expected_hash: expected, rules: input };
  const hash = commandHash(user, "nature", "reform_class", data);
  const replay = commandReplay(db, commandId!, user!, "nature", hash);
  if (replay) return replay;
  activeNature(db, nature);
  if (classesHash(natureClasses(db, nature)) !== expected) raise("40001", "erp_fiscal_reform_class_changed");
  db.exec(`DELETE FROM "${NATURE_CLASS}" WHERE nature_id=?`, nature);
  const now = ctx.clock.next().toString();
  for (const r of rules)
    db.exec(
      `INSERT INTO "${NATURE_CLASS}"(nature_id, position, product_scope, ncms, product_ids, group_ids, cst, cclasstrib, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      nature, r.position, r.product_scope, JSON.stringify(r.ncms), JSON.stringify(r.product_ids), JSON.stringify(r.group_ids), r.cst, r.cclasstrib, user, now,
    );
  const saved = natureClasses(db, nature);
  const result = { nature_id: nature, rules: saved, expected_hash: classesHash(saved), replayed: false, data_mode: "erp_native" };
  return finishCommand(ctx, { commandId: commandId!, actor: user!, scope: "nature", hash, result, entity: nature, version: null, action: "reform_class" });
}

/**
 * A classificação de IBS/CBS de um item: a do produto, senão a melhor da
 * natureza (matchRule do Fagoo sem destino), senão nada.
 */
export function resolveReformClass(
  db: SqlDriver,
  p: { productId: string | null; natureId: string | null; ncm?: string | null; groupId?: string | null },
): { cst: string; cclasstrib: string; nbs: string | null; source: "product" | "nature" } | null {
  const own = p.productId === null ? undefined : one(db, `SELECT cst, cclasstrib, nbs FROM "${PRODUCT_CLASS}" WHERE product_id=?`, p.productId);
  if (own) return { cst: String(own.cst), cclasstrib: String(own.cclasstrib), nbs: (own.nbs as string | null) ?? null, source: "product" };
  if (p.natureId === null) return null;
  let best: ReformClass | null = null;
  let bestScore = -1;
  for (const r of natureClasses(db, p.natureId)) {
    let score: number;
    if (r.product_scope === "products") {
      if (!p.productId || !r.product_ids.includes(p.productId)) continue;
      score = 300;
    } else if (r.product_scope === "groups") {
      if (!p.groupId || !r.group_ids.includes(p.groupId)) continue;
      score = 250;
    } else if (r.product_scope === "ncm") {
      const prefix = r.ncms.filter((n) => p.ncm && p.ncm.startsWith(n)).sort((x, y) => y.length - x.length)[0];
      if (!prefix) continue;
      score = 200 + prefix.length;
    } else score = 100;
    if (score > bestScore || (score === bestScore && r.position < best!.position)) {
      best = r;
      bestScore = score;
    }
  }
  return best ? { cst: best.cst, cclasstrib: best.cclasstrib, nbs: null, source: "nature" } : null;
}

// ---------------------------------------------------------------------------
// Versão 26 (structural.ts, reforma-calculo): configuração da empresa,
// classificação e Imposto Seletivo do produto, contexto das propostas e
// pedidos e o relatório do período. RPCs só do motor, pela rota erp-reforma.

const SETTINGS = "erp_fiscal_reform__settings";
const SELECTIVE = "erp_fiscal_reform__product_selective";

export interface ReformSettingsRow extends ReformCompanySettings {
  version: number;
  updated_at: string | null;
}

/** A configuração gravada, ou null quando a empresa nunca configurou. */
export function reformSettingsRow(db: SqlDriver): ReformSettingsRow | null {
  const r = one(db, `SELECT version, simples_regular, rates, CAST(updated_at AS TEXT) updated_at FROM "${SETTINGS}" WHERE id=1`);
  if (!r) return null;
  return { version: Number(r.version), simples_regular: Number(r.simples_regular) === 1, rates: JSON.parse(String(r.rates)), updated_at: (r.updated_at as string | null) ?? null };
}

/** A configuração para o cálculo (o padrão quando não há linha). */
export function reformSettings(db: SqlDriver): ReformCompanySettings {
  const r = reformSettingsRow(db);
  return r ? { simples_regular: r.simples_regular, rates: r.rates } : { simples_regular: false, rates: {} };
}

/** Imposto Seletivo do produto, ou null. */
export function productSelective(db: SqlDriver, productId: string): ReformSelectiveInput | null {
  const r = one(db, `SELECT cst, cclasstrib, rate FROM "${SELECTIVE}" WHERE product_id=?`, productId);
  return r ? { cst: String(r.cst), cclasstrib: String(r.cclasstrib), rate: String(r.rate) } : null;
}

function companyCrt(db: SqlDriver): string | null {
  const r = one(db, 'SELECT crt FROM "erp_company__fiscal" WHERE singleton=1');
  return (r?.crt as string | null) ?? null;
}

/**
 * O que o cofre aceita da reforma, como o preparo da NF-e vê: a leitura do
 * contrato guardada na configuração da NF-e (connection_public.reform).
 * known=false: o teste de conexão é anterior a esta leitura (ou nunca houve).
 */
export function reformVaultView(ctx: RpcContext) {
  const connection = readCommercialSettings(ctx).connection_public;
  const known = !!connection && Object.hasOwn(connection, "reform");
  const capability = known ? (connection!.reform as Json | null) : null;
  return {
    known, ibs_cbs: capability?.ibs_cbs === true, selective: capability?.selective === true, credit_debit: capability?.credit_debit === true,
    purposes: Array.isArray(capability?.purposes) ? (capability!.purposes as unknown[]).filter((p): p is string => typeof p === "string") : [],
  };
}

const settingsView = (ctx: RpcContext, role: string) => ({ ...settingsData(ctx.db, role), vault: reformVaultView(ctx) });

const settingsData = (db: SqlDriver, role: string) => {
  const row = reformSettingsRow(db);
  const settings = row ? { simples_regular: row.simples_regular, rates: row.rates } : { simples_regular: false, rates: {} };
  const crt = companyCrt(db);
  return {
    settings, version: row?.version ?? 0, updated_at: row?.updated_at ?? null, writable: ["admin", "fiscal"].includes(role), crt, regime: regimeOf(crt, settings),
    table: { version: REFORM_TABLE_VERSION, source: REFORM_TABLE_SOURCE },
    years: REFORM_YEAR_RATES.map((y) => reformRatesFor(y.year, settings)), data_mode: "erp_native",
  };
};

/** Alíquotas informadas pela empresa: só anos da transição, só as três chaves, em % (até 4 casas). */
function ratesInput(value: unknown): Record<string, Record<string, string>> {
  if (value === undefined) return {};
  if (jsonType(value) !== "object") bad("erp_fiscal_reform_rates_invalid");
  const out: Record<string, Record<string, string>> = {};
  for (const [year, raw] of Object.entries(value as Json)) {
    const y = Number(year);
    if (!/^\d{4}$/.test(year) || y < REFORM_FIRST_YEAR || y > REFORM_LAST_YEAR || jsonType(raw) !== "object") bad("erp_fiscal_reform_rates_invalid");
    const entry: Record<string, string> = {};
    for (const [key, rate] of Object.entries(raw as Json)) {
      if (!["cbs", "ibs_uf", "ibs_mun"].includes(key)) bad("erp_fiscal_reform_rates_invalid");
      if (rate === null || rate === "") continue;
      if (!validReformRate(rate)) bad("erp_fiscal_reform_rates_invalid");
      entry[key] = rate as string;
    }
    if (Object.keys(entry).length) out[year] = entry;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => pgCompareText(a, b)));
}

export function erpFiscalReformSettingsGet(ctx: RpcContext, a: RpcArgs) {
  const role = requireRead(ctx.db, (a.p_user_id as string | null) ?? null);
  return settingsView(ctx, role);
}

export function erpFiscalReformSettingsSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = (a.p_user_id as string | null) ?? null;
  const role = requireWrite(db, user);
  const commandId = uuidInput(a.p_command_id ?? null)!;
  const expected = a.p_expected_version;
  const input = jsonbArg(a.p_data ?? null);
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || jsonType(input) !== "object") bad("erp_fiscal_command_invalid");
  const data = input as Json;
  if (Object.keys(data).some((k) => !["simples_regular", "rates"].includes(k)) || typeof data.simples_regular !== "boolean") bad("erp_fiscal_reform_settings_invalid");
  const rates = ratesInput(data.rates);
  const hash = commandHash(user, "tax_settings", "reform_settings", { expected_version: expected, data: { simples_regular: data.simples_regular, rates } });
  const replay = commandReplay(db, commandId, user!, "tax_settings", hash);
  if (replay) return replay;
  const current = reformSettingsRow(db);
  if ((current?.version ?? 0) !== expected) raise("40001", "erp_fiscal_reform_settings_changed");
  const version = expected + 1;
  const now = ctx.clock.next().toString();
  db.exec(
    `INSERT INTO "${SETTINGS}"(id, version, simples_regular, rates, updated_by, updated_at) VALUES(1,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET version=excluded.version, simples_regular=excluded.simples_regular, rates=excluded.rates, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    version, data.simples_regular ? 1 : 0, JSON.stringify(rates), user, now,
  );
  const result = { ...settingsView(ctx, role), replayed: false };
  return finishCommand(ctx, { commandId, actor: user!, scope: "tax_settings", hash, result, entity: null, version, action: "reform_settings" });
}

interface ProductReform {
  classification: { cst: string; cclasstrib: string; nbs: string | null } | null;
  selective: ReformSelectiveInput | null;
}

function productReform(db: SqlDriver, productId: string): ProductReform {
  const own = one(db, `SELECT cst, cclasstrib, nbs FROM "${PRODUCT_CLASS}" WHERE product_id=?`, productId);
  return {
    classification: own ? { cst: String(own.cst), cclasstrib: String(own.cclasstrib), nbs: (own.nbs as string | null) ?? null } : null,
    selective: productSelective(db, productId),
  };
}

const productHash = (value: ProductReform) => createHash("sha256").update(jsonbText(value), "utf8").digest("hex");

function existingProduct(db: SqlDriver, id: string | null) {
  const p = one(db, `SELECT r.id FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=? AND r.entity='products'`, id);
  if (!p) raise("P0002", "erp_fiscal_reform_product_not_found");
  return String(p!.id);
}

export function erpFiscalReformProductGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireRead(db, (a.p_user_id as string | null) ?? null);
  const product = existingProduct(db, uuidInput(a.p_product_id ?? null));
  const current = productReform(db, product);
  return { product_id: product, ...current, expected_hash: productHash(current), writable: ["admin", "fiscal"].includes(role), data_mode: "erp_native" };
}

function productClassInput(value: unknown): ProductReform["classification"] {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "object" || Object.keys(value as Json).some((k) => !["cst", "cclasstrib", "nbs"].includes(k))) bad();
  const v = value as Json;
  const nbs = v.nbs === undefined || v.nbs === null || v.nbs === "" ? null : v.nbs;
  if (nbs !== null && (typeof nbs !== "string" || !/^[0-9]{9}$/.test(nbs))) bad("erp_fiscal_reform_nbs_invalid");
  return { ...classCodes(v), nbs: nbs as string | null };
}

function selectiveInput(value: unknown): ReformSelectiveInput | null {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "object" || Object.keys(value as Json).some((k) => !["cst", "cclasstrib", "rate"].includes(k))) bad("erp_fiscal_reform_selective_invalid");
  const v = value as Json;
  if (typeof v.cst !== "string" || !SELECTIVE_CSTS.some((c) => c.cst === v.cst)) bad("erp_fiscal_reform_selective_invalid");
  if (typeof v.cclasstrib !== "string" || !/^[0-9]{6}$/.test(v.cclasstrib) || !v.cclasstrib.startsWith(v.cst as string)) bad("erp_fiscal_reform_selective_invalid");
  if (!validReformRate(v.rate)) bad("erp_fiscal_reform_selective_invalid");
  return { cst: v.cst as string, cclasstrib: v.cclasstrib as string, rate: v.rate as string };
}

export function erpFiscalReformProductSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = (a.p_user_id as string | null) ?? null;
  const role = requireWrite(db, user);
  const commandId = uuidInput(a.p_command_id ?? null)!;
  const productId = uuidInput(a.p_product_id ?? null)!;
  const expected = a.p_expected_hash;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) bad("erp_fiscal_command_invalid");
  const classification = productClassInput(jsonbArg(a.p_classification ?? null));
  const selective = selectiveInput(jsonbArg(a.p_selective ?? null));
  const next: ProductReform = { classification, selective };
  const hash = commandHash(user, "tax_settings", "reform_product", { product_id: productId, expected_hash: expected, ...next });
  const replay = commandReplay(db, commandId, user!, "tax_settings", hash);
  if (replay) return replay;
  existingProduct(db, productId);
  const before = productReform(db, productId);
  if (productHash(before) !== expected) raise("40001", "erp_fiscal_reform_product_changed");
  const now = ctx.clock.next().toString();
  if (!classification) db.exec(`DELETE FROM "${PRODUCT_CLASS}" WHERE product_id=?`, productId);
  else
    db.exec(
      `INSERT INTO "${PRODUCT_CLASS}"(product_id, cst, cclasstrib, nbs, version, updated_by, updated_at) VALUES(?,?,?,?,1,?,?)
       ON CONFLICT(product_id) DO UPDATE SET cst=excluded.cst, cclasstrib=excluded.cclasstrib, nbs=excluded.nbs, version=version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      productId, classification.cst, classification.cclasstrib, classification.nbs, user, now,
    );
  if (!selective) db.exec(`DELETE FROM "${SELECTIVE}" WHERE product_id=?`, productId);
  else
    db.exec(
      `INSERT INTO "${SELECTIVE}"(product_id, cst, cclasstrib, rate, version, updated_by, updated_at) VALUES(?,?,?,?,1,?,?)
       ON CONFLICT(product_id) DO UPDATE SET cst=excluded.cst, cclasstrib=excluded.cclasstrib, rate=excluded.rate, version=version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      productId, selective.cst, selective.cclasstrib, selective.rate, user, now,
    );
  const saved = productReform(db, productId);
  const result = { product_id: productId, ...saved, expected_hash: productHash(saved), writable: ["admin", "fiscal"].includes(role), replayed: false, data_mode: "erp_native" };
  return finishCommand(ctx, { commandId, actor: user!, scope: "tax_settings", hash, result, entity: productId, version: null, action: "reform_product" });
}

/**
 * Contexto do bloco da reforma em propostas e pedidos: CRT, configuração,
 * natureza usada (a do cliente ou a padrão, como a estimativa de IPI e ST) e,
 * por produto, a classificação resolvida e o Imposto Seletivo. O painel
 * calcula com reform-calc.ts, o mesmo cálculo da NF-e. Mesmo acesso da
 * estimativa (papel que vê o documento).
 */
export function erpFiscalReformDocumentContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const estimate = erpFiscalTaxEstimateContextV2(ctx, a) as Json;
  const nature = (estimate.nature as Json | null) ?? null;
  const natureId = nature ? String(nature.id) : null;
  const settings = reformSettings(db);
  const crt = ((estimate.company as Json | null)?.crt as string | null) ?? null;
  const products = (estimate.products as Json[]).map((p) => {
    const id = String(p.id);
    return {
      id, ncm: (p.ncm as string | null) ?? null,
      classification: resolveReformClass(db, { productId: id, natureId, ncm: (p.ncm as string | null) ?? null, groupId: (p.group_id as string | null) ?? null }),
      selective: productSelective(db, id),
    };
  });
  return {
    crt, regime: regimeOf(crt, settings), settings, nature: nature ? { id: natureId, description: (nature.description as string | null) ?? null } : null,
    products, vault: reformVaultView(ctx), year: Number(todaySaoPaulo().slice(0, 4)), table: { version: REFORM_TABLE_VERSION }, data_mode: "erp_native",
  };
}

const DATE = /^(20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
/** Início do dia em São Paulo (UTC−3, sem horário de verão desde 2019), em microssegundos. */
const dayStart = (date: string) => BigInt(Date.parse(`${date}T00:00:00-03:00`)) * 1000n;

/**
 * IBS, CBS e IS das NF-e autorizadas no período, por mês e classificação,
 * do cálculo guardado na revisão enviada (calculation.reform). Notas de
 * antes do cálculo, ou sem o bloco, entram em "sem cálculo da reforma".
 */
export function erpFiscalReformReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireRead(db, (a.p_user_id as string | null) ?? null);
  const from = a.p_from, to = a.p_to;
  const environment = a.p_environment === undefined || a.p_environment === null ? "producao" : a.p_environment;
  if (typeof from !== "string" || typeof to !== "string" || !DATE.test(from) || !DATE.test(to) || from > to || !["producao", "homologacao"].includes(String(environment)))
    raise("22023", "erp_fiscal_reform_report_invalid");
  const start = dayStart(from as string), end = dayStart(to as string) + 86_400_000_000n;
  if (!Number.isFinite(Number(start)) || end - start > 400n * 86_400_000_000n) raise("22023", "erp_fiscal_reform_report_invalid");
  const rows = db.exec(
    `SELECT e.id, e.number, e.series, CAST(e.authorized_at AS TEXT) authorized_at, r.calculation
       FROM "erp_fiscal_vault__order_emission" e
       JOIN "erp_fiscal_vault__order_revision" r ON r.emission_id=e.id AND r.body_revision=e.current_body_revision
      WHERE e.status='autorizada' AND e.environment=? AND e.authorized_at>=? AND e.authorized_at<? ORDER BY e.authorized_at, e.id`,
    environment, start.toString(), end.toString(),
  ).rows;
  type Group = { month: string; cst: string; cclasstrib: string; description: string; notes: Set<string>; items: number; base: bigint; cbs: bigint; ibs_uf: bigint; ibs_mun: bigint; selective: bigint };
  const groups = new Map<string, Group>();
  const cents = (v: unknown) => {
    const m = typeof v === "string" ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(v) : null;
    return m ? BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0")) : 0n;
  };
  let without = 0;
  const month = (micros: string) => new Date(Number(BigInt(micros) / 1000n) - 3 * 3_600_000).toISOString().slice(0, 7);
  for (const row of rows) {
    const calculation = JSON.parse(String(row.calculation)) as Json;
    const reform = calculation.reform as Json | undefined;
    const items = Array.isArray(reform?.items) ? (reform!.items as Json[]) : null;
    if (!items) { without++; continue; }
    for (const item of items) {
      const cst = typeof item.cst === "string" ? item.cst : "";
      const code = typeof item.cclasstrib === "string" ? item.cclasstrib : "";
      const m = month(String(row.authorized_at));
      const key = `${m}|${cst}|${code}`;
      let g = groups.get(key);
      if (!g) {
        g = { month: m, cst, cclasstrib: code, description: typeof item.class_description === "string" ? item.class_description : code ? "Fora da tabela embutida" : "Sem classificação",
          notes: new Set(), items: 0, base: 0n, cbs: 0n, ibs_uf: 0n, ibs_mun: 0n, selective: 0n };
        groups.set(key, g);
      }
      g.notes.add(String(row.id));
      g.items++;
      g.base += cents(item.base);
      g.cbs += cents((item.cbs as Json | null)?.value);
      g.ibs_uf += cents((item.ibs_uf as Json | null)?.value);
      g.ibs_mun += cents((item.ibs_mun as Json | null)?.value);
      g.selective += cents((item.selective as Json | null)?.value);
    }
  }
  const money = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
  const lines = [...groups.values()]
    .sort((x, y) => pgCompareText(x.month, y.month) || pgCompareText(x.cst, y.cst) || pgCompareText(x.cclasstrib, y.cclasstrib))
    .map((g) => ({ month: g.month, cst: g.cst, cclasstrib: g.cclasstrib, description: g.description, notes: g.notes.size, items: g.items,
      base: money(g.base), cbs: money(g.cbs), ibs_uf: money(g.ibs_uf), ibs_mun: money(g.ibs_mun), ibs: money(g.ibs_uf + g.ibs_mun), selective: money(g.selective) }));
  const sum = (k: "base" | "cbs" | "ibs_uf" | "ibs_mun" | "selective") => [...groups.values()].reduce((acc, g) => acc + g[k], 0n);
  const totals = { notes: rows.length - without, base: money(sum("base")), cbs: money(sum("cbs")), ibs_uf: money(sum("ibs_uf")), ibs_mun: money(sum("ibs_mun")),
    ibs: money(sum("ibs_uf") + sum("ibs_mun")), selective: money(sum("selective")) };
  return { from, to, environment, lines, totals, without_reform: without, table: { version: REFORM_TABLE_VERSION }, data_mode: "erp_native" };
}

registerRpc("erp_fiscal_reform_nature_class_get", erpFiscalReformNatureClassGet);
registerRpc("erp_fiscal_reform_nature_class_save", erpFiscalReformNatureClassSave);
registerRpc("erp_fiscal_reform_settings_get", erpFiscalReformSettingsGet);
registerRpc("erp_fiscal_reform_settings_save", erpFiscalReformSettingsSave);
registerRpc("erp_fiscal_reform_product_get", erpFiscalReformProductGet);
registerRpc("erp_fiscal_reform_product_save", erpFiscalReformProductSave);
registerRpc("erp_fiscal_reform_document_context", erpFiscalReformDocumentContext);
registerRpc("erp_fiscal_reform_report", erpFiscalReformReport);
