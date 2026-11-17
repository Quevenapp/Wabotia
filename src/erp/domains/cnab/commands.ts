// Comandos e auditoria do CNAB (migrações 014, 042 e 213, versões finais no
// oráculo): erp_cnab.start_command, finish_command, operational_finish, o
// gatilho audit_permission (permissão por ação no insert da auditoria) e
// erp_cnab.storage_check (o storage.objects do Supabase é o R2: ctx.objects).
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { permitted } from "../access/public.ts";
import { operationalSafety, parse, sha256, type Json } from "./core.ts";

/** sha256(jsonb_build_object('actor','action','data')::text) */
export const requestHash = (actor: string, action: string, data: unknown) => sha256({ actor, action, data });

/** erp_cnab.start_command: recibo existente (mesmo ator e pedido) devolve o resultado com replayed. */
export function startCommand(ctx: RpcContext, actor: string, id: string | null, action: string, data: unknown): Json | null {
  if (id === null) raise("22023", "erp_cnab_command_required");
  const c = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_cnab__command" WHERE id=?', id);
  if (!c) return null;
  if (c.actor !== actor || c.request_hash !== requestHash(actor, action, data)) raise("40001", "erp_cnab_command_conflict");
  return { ...(parse(c.result) as Json), replayed: true };
}

/** erp_cnab.permission_key(action) */
export function permissionKey(action: string): string | null {
  if (["reserve", "operational_reserve", "operational_reserve_v2"].includes(action)) return "financas.remessas.ie";
  if (["finalize", "operational_finalize", "operational_finalize_v2"].includes(action)) return "financas.remessas.gerar";
  if (action === "remittance_exclude") return "financas.remessas.ex";
  if (action === "return_exclude") return "financas.retornos.ex";
  if (["return_commit", "operational_return", "operational_bind", "operational_settle", "itau_net_credit_settle", "human_review"].includes(action))
    return "financas.retornos.ie";
  return null;
}

/** insert into erp_cnab.audit, com o gatilho audit_permission (BEFORE INSERT). */
export function audit(ctx: RpcContext, actor: string, command: string, action: string, record: string) {
  const key = permissionKey(action);
  if (key !== null && !permitted(ctx.db, actor, key)) raise("42501", "erp_finance_permission_denied");
  ctx.db.exec(
    'INSERT INTO "erp_cnab__audit"(actor, command_id, action, record_id, created_at) VALUES(?,?,?,?,?)',
    actor,
    command,
    action,
    record,
    ctx.clock.next().toString(),
  );
}

/** Grava o recibo e a auditoria (o corpo comum de finish_command e operational_finish). */
export function recordCommand(ctx: RpcContext, actor: string, id: string, action: string, data: unknown, record: string, result: Json) {
  ctx.db.exec(
    'INSERT INTO "erp_cnab__command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    requestHash(actor, action, data),
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  audit(ctx, actor, id, action, record);
  return result;
}

/** erp_cnab.finish_command (homologação) */
export const finishCommand = (ctx: RpcContext, actor: string, id: string, action: string, data: unknown, record: string, result: Json) =>
  recordCommand(ctx, actor, id, action, data, record, {
    ...result,
    replayed: false,
    purpose: "homologation",
    productionReady: false,
    financialMutationPerformed: false,
  });

/** erp_cnab.operational_finish */
export const operationalFinish = (ctx: RpcContext, actor: string, id: string, action: string, data: unknown, record: string, result: Json) =>
  recordCommand(ctx, actor, id, action, data, record, { ...result, ...operationalSafety(), replayed: false });

/**
 * Bucket do Fagoo para os arquivos do CNAB. Só por dentro: a chave no R2 é
 * erp-storage/<área>/<bucket>/<caminho> (src/erp-storage.ts da sessão A), e o
 * endereço público usa um apelido.
 */
export const CNAB_BUCKET = "brufap-cnab";
export const cnabObjectKey = (path: string) => `${CNAB_BUCKET}/${path}`;

/** erp_cnab.storage_check(profile, kind, hash, size, path) */
export function storageCheck(ctx: RpcContext, profile: string, kind: string, hash: string | null, size: number | null, path: string | null) {
  // Hash ou tamanho nulos dão nulo nesta conferência (não recusa aqui); o caminho esperado também
  // fica nulo, e a recusa vem do objeto ausente (40001), como no Postgres.
  if (!["remittances", "returns"].includes(kind) || (hash !== null && !/^[a-f0-9]{64}$/.test(hash)) || (size !== null && (size < 1 || size > 4020000)))
    raise("22023", "erp_cnab_invalid_file");
  const expected = hash === null ? null : `profiles/${profile}/${kind}/${hash}${kind === "returns" ? ".ret" : ".rem"}`;
  const stored = expected !== null && size !== null && path === expected ? ctx.objects(cnabObjectKey(expected)) : null;
  if (!stored || stored.size !== size || stored.mimetype !== "application/octet-stream") raise("40001", "erp_cnab_private_object_required");
}
