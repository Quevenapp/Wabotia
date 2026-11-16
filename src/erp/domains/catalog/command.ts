// Recibo de comando do catálogo (erp_catalog.command, chave command_id) e a
// trilha dos cadastros auxiliares (erp_catalog.auxiliary_audit).
import { createHash } from "node:crypto";
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";

/** encode(sha256(convert_to(jsonb_build_object(…)::text,'UTF8')),'hex') */
export const requestHash = (request: Record<string, unknown>) =>
  createHash("sha256").update(jsonbText(request), "utf8").digest("hex");

/**
 * Comando já gravado: mesmo ator e mesmo pedido devolve o resultado com
 * "replayed": true; outro → 40001 erp_catalog_command_conflict.
 */
export function replayCommand(ctx: RpcContext, command: string, actor: string, hash: string) {
  const row = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_catalog__command" WHERE command_id=?', command);
  if (!row) return null;
  if (row.actor !== actor || row.request_hash !== hash) raise("40001", "erp_catalog_command_conflict");
  return { ...JSON.parse(String(row.result)), replayed: true } as Record<string, unknown>;
}

export function storeCommand(ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) {
  ctx.db.exec(
    'INSERT INTO "erp_catalog__command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)',
    command,
    actor,
    hash,
    jsonbText(result),
    ctx.clock.next().toString(),
  );
}

export function auxiliaryAudit(
  ctx: RpcContext,
  row: {
    actor: string;
    command: string | null;
    subject: string;
    subjectId: string | null;
    action: string;
    before?: unknown;
    after?: unknown;
  },
) {
  ctx.db.exec(
    `INSERT INTO "erp_catalog__auxiliary_audit"(actor, command_id, subject, subject_id, action, before_data, after_data, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    row.actor,
    row.command,
    row.subject,
    row.subjectId,
    row.action,
    // jsonb 'null' e NULL saem iguais do codec json: o motor grava NULL.
    row.before === undefined || row.before === null ? null : jsonbText(row.before),
    row.after === undefined || row.after === null ? null : jsonbText(row.after),
    ctx.clock.next().toString(),
  );
}
