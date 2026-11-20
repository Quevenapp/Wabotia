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
  // O UPSERT compara todo o fato e falha dentro da própria escrita. Mesmo
  // número de linhas não é prova de replay: nenhum campo pode divergir.
  // Replay usa WHERE falso: os triggers imutáveis nunca recebem UPDATE.
  const reverse = receipt.kind === "reverse";
  return [[
    `INSERT INTO module_commercial_receipts(${fields.join(",")})
     SELECT ${fields.map(f => reverse && f === "amount_cents"
       ? "CASE WHEN EXISTS(SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=? AND kind='receive' AND owner_module=? AND source_id=? AND amount_cents=?) THEN ? ELSE json('integration_receipt_conflict') END" : "?").join(",")} WHERE 1
     ON CONFLICT(profile_id,receipt_key) DO UPDATE SET evidence_hash=excluded.evidence_hash
       WHERE CASE WHEN ${fields.map(f => `module_commercial_receipts.${f} IS excluded.${f}`).join(" AND ")}
       THEN 0 ELSE json('integration_receipt_conflict') END`,
    fields.flatMap((f, i) => reverse && f === "amount_cents"
      ? [receipt.profile_id, receipt.reverses_key, receipt.owner_module, receipt.source_id, receipt.amount_cents, receipt.amount_cents] : [values[i]]),
  ]];
}
export function allocationStatements(source: SourceRef, receiptKey: string, allocationKey: string, cents: number): Statement[] {
  integer(cents, 1);
  return [[
    `INSERT INTO module_erp_allocations(profile_id,receipt_key,allocation_key,module_id,source_id,component,amount_cents)
     VALUES(?,?,?,?,?,?,CASE WHEN
       ?+(SELECT COALESCE(sum(amount_cents),0) FROM module_erp_allocations WHERE profile_id=? AND receipt_key=? AND allocation_key<>?)
       <=(SELECT amount_cents FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?)
       THEN ? ELSE json('integration_allocation_excess') END)
     ON CONFLICT(profile_id,receipt_key,allocation_key) DO UPDATE SET amount_cents=excluded.amount_cents
       WHERE CASE WHEN module_erp_allocations.module_id=excluded.module_id AND module_erp_allocations.source_id=excluded.source_id
         AND module_erp_allocations.component=excluded.component AND module_erp_allocations.amount_cents=excluded.amount_cents
       THEN 0 ELSE json('integration_allocation_conflict') END`,
    [source.profile, receiptKey, allocationKey, source.module, source.source_id, source.component,
      cents, source.profile, receiptKey, allocationKey, source.profile, receiptKey, cents],
  ]];
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
