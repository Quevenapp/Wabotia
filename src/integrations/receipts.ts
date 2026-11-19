import { one } from "../db";
import type { Env } from "../types";
import type { IntegrationModule, SourceRef, Statement } from "./contracts";
import { canonical, hash } from "./keys";
import { exactKeys, integer, opaque, IntegrationError } from "./privacy";
export interface CommercialReceipt {
  profile_id: string; receipt_key: string; owner_module: IntegrationModule; source_id: string;
  kind: "receive" | "reverse"; evidence: "provider" | "manual"; reverses_key: string | null;
  amount_cents: number; method: "cash" | "pix" | "card" | "other" | "unknown";
  occurred_ms: number; actor_id: string | null; evidence_hash: string;
}
/** Incluir no lote local, nunca depois do commit do produtor. */
export function commercialReceiptStatements(receipt: CommercialReceipt): Statement[] {
  exactKeys(receipt, ["profile_id", "receipt_key", "owner_module", "source_id", "kind", "evidence", "reverses_key", "amount_cents", "method", "occurred_ms", "actor_id", "evidence_hash"]);
  if (!/^[0-9a-f]{64}$/.test(receipt.evidence_hash)) throw new IntegrationError("invalid_request", 400);
  integer(receipt.amount_cents, 1); integer(receipt.occurred_ms);
  [receipt.profile_id, receipt.receipt_key, receipt.source_id, receipt.evidence_hash].forEach(opaque);
  if ((receipt.kind === "reverse") !== !!receipt.reverses_key || (receipt.evidence === "manual" && !receipt.actor_id)) throw new IntegrationError("invalid_request", 400);
  const fields = Object.keys(receipt), values = Object.values(receipt);
  const statements: Statement[] = [];
  if (receipt.kind === "reverse") statements.push([
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=? AND kind='receive' AND owner_module=? AND source_id=? AND amount_cents=?) THEN 1 ELSE json('integration_receipt_conflict') END`,
    [receipt.profile_id, receipt.reverses_key, receipt.owner_module, receipt.source_id, receipt.amount_cents],
  ]);
  statements.push([
    `INSERT INTO module_commercial_receipts(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) ON CONFLICT(profile_id,receipt_key) DO NOTHING`, values,
  ], [
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM module_commercial_receipts WHERE ${fields.map(f => `${f} IS ?`).join(" AND ")}) THEN 1 ELSE json('integration_receipt_conflict') END`, values,
  ]);
  return statements;
}
export function allocationStatements(source: SourceRef, receiptKey: string, allocationKey: string, cents: number): Statement[] {
  integer(cents, 1);
  const values = [source.profile, receiptKey, allocationKey, source.module, source.source_id, source.component, cents];
  return [
    [`INSERT INTO module_erp_allocations(profile_id,receipt_key,allocation_key,module_id,source_id,component,amount_cents) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id,receipt_key,allocation_key) DO NOTHING`, values],
    [`SELECT CASE WHEN EXISTS(SELECT 1 FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND allocation_key=? AND module_id=? AND source_id=? AND component=? AND amount_cents=?) THEN 1 ELSE json('integration_allocation_conflict') END`, values],
    [`SELECT CASE WHEN (SELECT COALESCE(sum(amount_cents),0) FROM module_erp_allocations WHERE profile_id=? AND receipt_key=?) <= (SELECT amount_cents FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?) THEN 1 ELSE json('integration_allocation_excess') END`, [source.profile, receiptKey, source.profile, receiptKey]],
  ];
}
export async function allocatedReceipt(env: Env, source: SourceRef, key: string) {
  const receipt = await one<CommercialReceipt>(env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", source.profile, key);
  const allocated = await one(env, "SELECT sum(amount_cents) amount_cents FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND module_id=? AND source_id=? AND component=?", source.profile, key, source.module, source.source_id, source.component);
  if (!receipt || !allocated?.amount_cents || allocated.amount_cents > receipt.amount_cents) throw new IntegrationError("invalid_request", 422);
  return { receipt, amount_cents: allocated.amount_cents as number };
}
export const manualReceiptKey = (profile: string, module: IntegrationModule, requestId: string) => `manual:${hash([profile, module, requestId])}`;
export const providerReceiptKey = (profile: string, provider: string, account: string, paymentId: string) => `provider:${hash([profile, provider, account, paymentId, "paid"])}`;
export const reverseReceiptKey = (key: string) => `${key}:reverse`;
export const allocationKey = (key: string, source: SourceRef, ordinal: number) => hash([key, canonical(source), integer(ordinal)]);

// A reversão também deve mudar a autoridade operacional no MESMO lote. A base
// não inventa essa mutação: o dono do recebimento instala este gancho estreito.
export type ReceiptReverser = (env: Env, actor: import("../types").Actor, original: CommercialReceipt, input: { reason_code: string; command: string }) => Promise<unknown>;
const reversers = new Map<IntegrationModule, ReceiptReverser>();
export function registerReceiptReverser(module: IntegrationModule, handler: ReceiptReverser): void {
  if (reversers.has(module) && reversers.get(module) !== handler) throw new IntegrationError("producer_conflict", 409);
  reversers.set(module, handler);
}
export async function reverseCommercialReceipt(env: Env, actor: import("../types").Actor, profile: string, data: any, command: string) {
  const { requireIntegrationHuman } = await import("./policy");
  const { requireFinancialAal } = await import("../mfa");
  const { authorizeIntegrationSource } = await import("./routes");
  requireIntegrationHuman(actor, profile); requireFinancialAal(actor);
  if (typeof data.reason_code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(data.reason_code)) throw new IntegrationError("invalid_request", 400);
  const original = await one<CommercialReceipt>(env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=? AND kind='receive' AND evidence='manual'", profile, opaque(data.id));
  if (!original) throw new IntegrationError("not_found", 404);
  await authorizeIntegrationSource(env, actor, { profile, module: original.owner_module, source_id: original.source_id, component: "main" }, true);
  const handler = reversers.get(original.owner_module);
  if (!handler) throw new IntegrationError("integration_not_implemented");
  return handler(env, actor, original, { reason_code: data.reason_code, command });
}
