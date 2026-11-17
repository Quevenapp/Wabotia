// Classificação de IBS/CBS da reforma tributária (structural.ts,
// reforma-classificacao): tabelas só do motor, que o Fagoo não tem. A
// natureza guarda o padrão (escopo any) e as exceções por NCM, produto ou
// grupo; o produto guarda a dele (e o NBS do serviço). A resolução segue a
// matchRule do Fagoo (packages/fiscal-core/src/tax-engine.mjs), sem destino:
// produto do cadastro > exceção por produto > por grupo > pelo NCM de prefixo
// mais longo > padrão; empate, a menor posição.
// RPCs só do motor (sem assinatura no oráculo nem rota na erp-api ainda):
// erp_fiscal_reform_nature_class_get e _save. O _save troca a lista inteira,
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

/** CST de IBS/CBS (3 dígitos) e cClassTrib (6 dígitos). */
function classCodes(v: Json) {
  if (typeof v.cst !== "string" || !/^[0-9]{3}$/.test(v.cst)) bad("erp_fiscal_reform_cst_invalid");
  if (typeof v.cclasstrib !== "string" || !/^[0-9]{6}$/.test(v.cclasstrib)) bad("erp_fiscal_reform_cclasstrib_invalid");
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

registerRpc("erp_fiscal_reform_nature_class_get", erpFiscalReformNatureClassGet);
registerRpc("erp_fiscal_reform_nature_class_save", erpFiscalReformNatureClassSave);
