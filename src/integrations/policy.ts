import { batch, one } from "../db";
import { canProfile } from "../security";
import { requireFinancialAal } from "../mfa";
import type { Actor, Env } from "../types";
import { erpIdentity, erpRoleOf } from "../modules/erp/identity";
import { readErpPartsState } from "../modules/erp/parts-state";
import type { CommercialPolicy } from "./contracts";
import { canonical, hash, uuid5, F3_NAMESPACES } from "./keys";
import { exactKeys, integer, IntegrationError, opaque, sanitizedError } from "./privacy";
import { integrationCasGuard } from "./outbox";

export function requireIntegrationHuman(actor: Actor, profile: string): void {
  if (!canProfile(actor, profile)) throw new IntegrationError("not_found", 404);
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential) throw new IntegrationError("forbidden", 403);
}
export function requirePolicyAccess(actor: Actor, profile: string, write = false): void {
  requireIntegrationHuman(actor, profile);
  if (write ? actor.role !== "admin" : !["admin", "financeiro", "estoque"].includes(erpRoleOf(actor) ?? "")) throw new IntegrationError("forbidden", 403);
  if (write) requireFinancialAal(actor);
}
/** DTO de leitura por destino; referências financeiras não saem para Estoque. */
export function commercialPolicyView(policy: CommercialPolicy, actor: Actor) {
  requirePolicyAccess(actor, policy.profile);
  const role = erpRoleOf(actor), stock = role === "admin" || role === "estoque", finance = role === "admin" || role === "financeiro";
  return { profile: policy.profile, version: policy.version, installment_rule: policy.installment_rule,
    auto_post: { ...(stock ? { stock: policy.auto_post.stock } : {}), ...(finance ? { finance: policy.auto_post.finance } : {}) },
    ...(stock ? { warehouse_id: policy.warehouse_id } : {}),
    ...(finance ? { revenue_category_id: policy.revenue_category_id, payment_method_id: policy.payment_method_id,
      settlement_accounts: policy.settlement_accounts, consumer_contact_id: policy.consumer_contact_id } : {}),
  };
}
export async function ensureCommercialPolicy(env: Env, profile: string): Promise<CommercialPolicy> {
  const defaults = { auto_post: { stock: true, finance: true }, warehouse_id: null, revenue_category_id: null, payment_method_id: null, settlement_accounts: {}, consumer_contact_id: null, installment_rule: "single_on_trigger" };
  // Só escreve a política. A referência de leitura a profiles não deve
  // invalidar o cache de configuração da invocação inteira.
  const result = await env.DB.prepare("INSERT INTO module_erp_policy(profile_id,config_json,updated_ms,updated_by) SELECT ?,?,?,'system:integration' WHERE EXISTS(SELECT 1 FROM profiles WHERE id=?) ON CONFLICT(profile_id) DO UPDATE SET profile_id=excluded.profile_id RETURNING *")
    .bind(profile, canonical(defaults), Date.now(), profile).all();
  const row = result.results[0] as any;
  if (!row) throw new IntegrationError("not_found", 404);
  return { ...JSON.parse(row.config_json), profile, version: row.version };
}
// Somente operações humanas enumeradas, nunca nome ou argumentos livres do cliente.
export type PolicyRpc = "erp_document_get" | "erp_stock_warehouse_options" | "erp_finance_category_tree" | "erp_finance_account_page" | "erp_catalog_payment_method_get" | "erp_catalog_product_get" | "erp_stock_warehouse_save" | "erp_finance_execute" | "erp_catalog_payment_method_save";
export async function humanReferenceRpc(env: Env, actor: Actor, profile: string, rpc: PolicyRpc, args: Record<string, unknown>): Promise<any> {
  requireIntegrationHuman(actor, profile);
  const state = await readErpPartsState(env, profile);
  if (!state.snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const identity = await erpIdentity(env, actor, profile, rpc.endsWith("_save") || rpc === "erp_finance_execute" ? "POST" : "GET");
  const { localFetch } = await import("../erp/api/local-fetch");
  try {
    const response = await localFetch(env, profile, actor, identity, { gate: { denied: null } })(`https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, {
      method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }),
    });
    if (!response.ok) throw new IntegrationError(response.status === 403 ? "forbidden" : response.status >= 500 ? "integration_unavailable" : "default_inactive", response.status);
    return await response.json();
  } catch (e) { throw sanitizedError(e); }
}
function rows(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(v => [v, ...rows(v.children ?? [])]);
  return rows(value?.items ?? value?.data ?? value?.categories ?? []);
}
export async function validatePolicyReferences(env: Env, actor: Actor, policy: CommercialPolicy): Promise<void> {
  const { profile } = policy;
  const active = (value: any, id: string) => rows(value).some(r => r.id === id && (r.active === true || r.active === 1));
  if (policy.warehouse_id && !active(await humanReferenceRpc(env, actor, profile, "erp_stock_warehouse_options", {}), policy.warehouse_id)) throw new IntegrationError("default_inactive");
  if (policy.revenue_category_id && !active(await humanReferenceRpc(env, actor, profile, "erp_finance_category_tree", { p_kind: "receivable" }), policy.revenue_category_id)) throw new IntegrationError("default_inactive");
  if (policy.payment_method_id) {
    const response = await humanReferenceRpc(env, actor, profile, "erp_catalog_payment_method_get", { p_id: policy.payment_method_id });
    const record = response.item ?? response.record ?? response;
    if (record.id !== policy.payment_method_id || record.active !== true) throw new IntegrationError("default_inactive");
  }
  const accounts = Object.values(policy.settlement_accounts);
  if (accounts.length) {
    // Paginação explícita: não confundir ausência na primeira página com inatividade.
    const found = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const response = await humanReferenceRpc(env, actor, profile, "erp_finance_account_page", { p_page: page, p_limit: 100, p_active: true });
      for (const record of rows(response)) if (record.active === true || record.active === 1) found.add(record.id);
      if (rows(response).length < 100 || accounts.every(id => found.has(id))) break;
    }
    if (accounts.some(id => !found.has(id))) throw new IntegrationError("default_inactive");
  }
}
export async function patchCommercialPolicy(env: Env, actor: Actor, profile: string, patch: Record<string, any>, command: string): Promise<CommercialPolicy> {
  requirePolicyAccess(actor, profile, true);
  exactKeys(patch, ["version", "auto_post", "warehouse_id", "revenue_category_id", "payment_method_id", "settlement_accounts"]);
  integer(patch.version, 1);
  const before = await ensureCommercialPolicy(env, profile);
  const scope = `f3-policy:${profile}:${actor.id}`, fingerprint = hash(patch);
  const old = await one(env, "SELECT * FROM receipts WHERE scope=? AND key=?", scope, command);
  if (old) {
    if (old.fingerprint !== fingerprint) throw new IntegrationError("idempotency_conflict", 409);
    return JSON.parse(old.response);
  }
  if (before.version !== patch.version) throw new IntegrationError("version_conflict", 409);
  const next: CommercialPolicy = { ...before, ...patch, version: before.version + 1 };
  if (Object.hasOwn(patch, "auto_post")) {
    exactKeys(patch.auto_post, ["stock", "finance"]);
    if (Object.values(patch.auto_post).some(v => typeof v !== "boolean")) throw new IntegrationError("invalid_request", 400);
    next.auto_post = { ...before.auto_post, ...patch.auto_post };
  }
  for (const key of ["warehouse_id", "revenue_category_id", "payment_method_id"] as const) if (next[key] !== null) opaque(next[key]);
  exactKeys(next.settlement_accounts, ["cash", "pix", "card", "other", "unknown"]);
  Object.values(next.settlement_accounts).forEach(opaque);
  // Ligar/desligar automação continua local, inclusive com o ERP desligado.
  if (["warehouse_id", "revenue_category_id", "payment_method_id", "settlement_accounts"].some(k => Object.hasOwn(patch, k))) await validatePolicyReferences(env, actor, next);
  const { profile: _, version: __, ...config } = next;
  await batch(env, [
    [`UPDATE module_erp_policy SET stock_epoch=stock_epoch+CASE WHEN json_extract(config_json,'$.auto_post.stock')<>json_extract(?,'$.auto_post.stock') THEN 1 ELSE 0 END,
      finance_epoch=finance_epoch+CASE WHEN json_extract(config_json,'$.auto_post.finance')<>json_extract(?,'$.auto_post.finance') THEN 1 ELSE 0 END,
      config_json=?,version=?,updated_ms=?,updated_by=? WHERE profile_id=? AND version=?`, [canonical(config), canonical(config), canonical(config), next.version, Date.now(), actor.id, profile, before.version]], integrationCasGuard,
    ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [scope, command, fingerprint, canonical(next), Date.now()]],
  ]);
  return next;
}
export interface PolicyInitialization {
  version: number;
  warehouse?: { name: string; expected_setting_version: number };
  category?: { name: string };
  payment_method?: { name: string; type: string };
  account?: { name: string; kind: "cash" | "bank" | "other"; method: "cash" | "pix" | "card" | "other" | "unknown" };
  consumer?: boolean;
}
export async function initializeCommercialPolicy(env: Env, actor: Actor, profile: string, input: PolicyInitialization, key: string): Promise<CommercialPolicy> {
  requirePolicyAccess(actor, profile, true);
  exactKeys(input, ["version", "warehouse", "category", "payment_method", "account", "consumer"]);
  integer(input.version, 1);
  if (input.consumer !== undefined && typeof input.consumer !== "boolean") throw new IntegrationError("invalid_request", 400);
  const fingerprint = hash(input), scope = `f3-initialize:${profile}:${actor.id}`;
  await batch(env, [["INSERT OR IGNORE INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)", [scope, key, fingerprint, Date.now()]]]);
  const old = await one(env, "SELECT * FROM receipts WHERE scope=? AND key=?", scope, key);
  if (old.fingerprint !== fingerprint) throw new IntegrationError("idempotency_conflict", 409);
  const saved = old.response ? JSON.parse(old.response) : null;
  if (saved?.phase === "done") return saved.value;
  if (!saved) {
    const initial = await ensureCommercialPolicy(env, profile);
    if (initial.version !== input.version) throw new IntegrationError("version_conflict", 409);
    await batch(env, [["UPDATE receipts SET response=? WHERE scope=? AND key=? AND response IS NULL", [canonical({ phase: "preparing", policy: initial }), scope, key]]]);
  }
  const reserved = await one(env, "SELECT response FROM receipts WHERE scope=? AND key=?", scope, key);
  const policy: CommercialPolicy = JSON.parse(reserved.response).policy;
  const patch: Record<string, unknown> = { version: input.version };
  const command = (slot: string) => uuid5(F3_NAMESPACES.internal, canonical([scope, key, slot]));
  if (input.warehouse) {
    exactKeys(input.warehouse, ["name", "expected_setting_version"]); opaque(input.warehouse.name); integer(input.warehouse.expected_setting_version);
    const result = await humanReferenceRpc(env, actor, profile, "erp_stock_warehouse_save", { p_command_id: command("warehouse"), p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: input.warehouse.expected_setting_version, p_name: input.warehouse.name, p_ignore_balance: false });
    patch.warehouse_id = result.warehouse.id;
  }
  if (input.category) {
    exactKeys(input.category, ["name"]); opaque(input.category.name);
    const result = await humanReferenceRpc(env, actor, profile, "erp_finance_execute", { p_command_id: command("category"), p_action: "category_save", p_data: { id: null, expected_version: 0, name: input.category.name, kind: "receivable", active: true } });
    patch.revenue_category_id = result.record.id;
  }
  if (input.payment_method) {
    exactKeys(input.payment_method, ["name", "type"]); opaque(input.payment_method.name); opaque(input.payment_method.type);
    const result = await humanReferenceRpc(env, actor, profile, "erp_catalog_payment_method_save", { p_command_id: command("method"), p_id: null, p_expected_version: 0, p_data: {
      description: input.payment_method.name, payment_type: input.payment_method.type, condition: null,
      destination: "contas", account_id: null, business_days: false, applicable: "recebimentos",
      interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
      auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null,
      fee_fixed: null, settlement_days: null,
    } });
    patch.payment_method_id = (result.item ?? result.record ?? result).id;
  }
  if (input.account) {
    exactKeys(input.account, ["name", "kind", "method"]); opaque(input.account.name);
    if (!["cash", "bank", "other"].includes(input.account.kind) || !["cash", "pix", "card", "other", "unknown"].includes(input.account.method)) throw new IntegrationError("invalid_request", 400);
    const result = await humanReferenceRpc(env, actor, profile, "erp_finance_execute", { p_command_id: command("account"), p_action: "account_save", p_data: { id: null, expected_version: 0, name: input.account.name, kind: input.account.kind, active: true } });
    patch.settlement_accounts = { ...policy.settlement_accounts, [input.account.method]: result.record.id };
  }
  let result = await patchCommercialPolicy(env, actor, profile, patch, `initialize:${key}`);
  if (input.consumer) {
    const { ensureConsumer } = await import("./customer-adapter");
    await ensureConsumer(env, profile, actor);
    result = await ensureCommercialPolicy(env, profile);
  }
  await batch(env, [["UPDATE receipts SET response=?,status=200 WHERE scope=? AND key=? AND fingerprint=?", [canonical({ phase: "done", value: result }), scope, key, fingerprint]]]);
  return result;
}
