// Backup do ERP pelo painel e pela API: rotas de administrador em
// /api/v1/profiles/:profile/erp-backup (operações em
// src/erp/engine/backup-operations.ts). Encaminham ao objeto erp:<área>
// (/erp-backup, /erp-restore, /erp-backup-status, src/erp/hub.ts); a lista e
// a exclusão de backups guardados leem o R2 (erp-backups/<área>/) direto.
//
// Conferências: pessoa da área, administrador, módulo ERP ligado (o
// middleware de módulo já recusa com 409 module_disabled; confere de novo
// aqui) e, nas que mudam algo, o segundo fator (requireStepUp, o mesmo das
// outras ações administrativas). Pelo bot: só a operação concedida e, nas
// sensíveis, a proposta confirmada pela pessoa (erpBotDelegation).
import { one } from "../../db";
import { ApiError, type Actor, type Env } from "../../types";
import { admin, canProfile } from "../../security";
import { requireStepUp } from "../../mfa";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpFetch } from "../hub.ts";
import { ErpUnavailable, withStubRetry } from "./retry.ts";
import { ERP_BACKUP_ROUTE, erpBackupOperationFor, type ErpBackupOperation } from "../engine/backup-operations.ts";

/** Diretório dos registros de restauração que voltaram à marca (backup-pages.ts): não é backup. */
const ROLLBACK_DIR = "_restauracoes/";
const MAX_LISTED = 100;

export interface ErpBackupListItem {
  prefix: string;
  created_at: string | null;
  format: number | null;
  rows: number | null;
  /** Bytes guardados (comprimidos). */
  bytes: number | null;
  /** Bytes dos dados exportados (antes da compressão). */
  text_bytes: number | null;
  tables: number | null;
}

const areaPrefix = (profile: string) => `erp-backups/${profile}/`;
const number = (value: unknown) => {
  const n = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(n) ? null : n;
};

async function call(env: Env, profile: string, operation: ErpBackupOperation, body?: unknown): Promise<Response> {
  const route = operation.route!;
  const response = await withStubRetry(
    () => erpFetch(env, profile, route, operation.method === "GET" ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
    // Abrir de novo devolve o mesmo trabalho (um por área): repetir não duplica.
    { idempotent: true, route },
  ).catch(error => {
    if (error instanceof ErpUnavailable) throw new ApiError(503, error.code, error.message);
    throw error;
  });
  const result = await response.json().catch(() => ({ error: { code: "erp_unavailable", message: "O ERP respondeu sem conteúdo. Tente de novo em instantes." } }));
  return Response.json(result, { status: response.status, headers: { "Cache-Control": "no-store" } });
}

async function currentJob(env: Env, profile: string, operation: ErpBackupOperation) {
  const response = await call(env, profile, operation);
  return response.ok ? ((await response.json()) as { job?: { prefix?: string; kind?: string; phase?: string } | null }).job ?? null : null;
}

/** Os backups guardados da área, do mais novo ao mais antigo; lê só o cabeçalho do manifesto quando dá. */
export async function listErpBackups(env: Env, profile: string): Promise<ErpBackupListItem[]> {
  const root = areaPrefix(profile), prefixes: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await env.MEDIA.list({ prefix: root, delimiter: "/", cursor, limit: 1000 });
    prefixes.push(...(listed.delimitedPrefixes ?? []).filter(p => p !== root + ROLLBACK_DIR));
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const items: ErpBackupListItem[] = [];
  for (const prefix of prefixes.sort().reverse().slice(0, MAX_LISTED)) {
    const head = await env.MEDIA.head(prefix + "manifest.json");
    // Sem manifesto: backup em andamento ou interrompido (as partes são limpas sozinhas).
    if (!head) continue;
    const meta = head.customMetadata ?? {};
    if (meta.rows !== undefined) {
      items.push({ prefix, created_at: meta.created_at ?? null, format: number(meta.format), rows: number(meta.rows), bytes: number(meta.bytes),
        text_bytes: number(meta.text_bytes), tables: number(meta.tables) });
      continue;
    }
    // Backup antigo, sem os totais nos metadados: lê o manifesto.
    const manifest = await (await env.MEDIA.get(prefix + "manifest.json"))?.json<Record<string, any>>().catch(() => null);
    if (!manifest) continue;
    const tables = Array.isArray(manifest.tables) ? manifest.tables as { rows?: unknown }[] : [];
    items.push({ prefix, created_at: typeof manifest.created_at === "string" ? manifest.created_at : null, format: number(manifest.format),
      rows: number(manifest.totals?.rows) ?? tables.reduce((sum, t) => sum + (number(t.rows) ?? 0), 0),
      bytes: number(manifest.totals?.bytes), text_bytes: number(manifest.totals?.text_bytes), tables: number(manifest.totals?.tables) ?? tables.length });
  }
  return items;
}

function ownPrefix(profile: string, value: unknown): string {
  const root = areaPrefix(profile);
  if (typeof value !== "string" || !value.startsWith(root) || !/^[^/?#\\]+\/$/.test(value.slice(root.length)) || value === root + ROLLBACK_DIR)
    throw new ApiError(400, "erp_backup_invalid", "Escolha um backup desta área na lista.");
  return value;
}

const fold = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");

/** POST/GET /api/v1/profiles/:profile/erp-backup[/progresso|/restaurar|/apagar]. */
export async function erpBackupRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const operation = path.startsWith(ERP_BACKUP_ROUTE) ? erpBackupOperationFor(request.method, path) : null;
  if (!operation) throw new ApiError(404, "not_found", "Rota não encontrada.");
  admin(actor);
  await requireModule(env, profile, "erp");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => {
    throw new ApiError(400, "invalid_request", "Corpo do pedido inválido.");
  });
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !operation.body.includes(key))))
    throw new ApiError(400, "invalid_request", `Informe só: ${operation.body.join(", ") || "nada"}.`);
  // Pelo bot: a operação concedida a ele e, se sensível, a proposta que a pessoa confirmou.
  if (actor.via && !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação do backup do ERP não foi liberada para este bot, ou falta a confirmação da pessoa.");
  if (operation.method !== "GET") requireStepUp(actor);
  const status = erpBackupOperationFor("GET", `${ERP_BACKUP_ROUTE}/progresso`)!;

  switch (operation.name) {
    case "erp.backup.list":
      return Response.json({ backups: await listErpBackups(env, profile), job: await currentJob(env, profile, status) }, { headers: { "Cache-Control": "no-store" } });
    case "erp.backup.status":
      return call(env, profile, operation);
    case "erp.backup.start":
      return call(env, profile, operation);
    case "erp.backup.restore": {
      const prefix = ownPrefix(profile, body!.prefix);
      const area = await one(env, "SELECT name FROM profiles WHERE id=?", profile) as { name?: string } | null;
      const name = String(area?.name ?? profile);
      if (typeof body!.confirmacao !== "string" || fold(body!.confirmacao) !== fold(name))
        throw new ApiError(400, "erp_restore_confirmation", `Para confirmar, digite o nome da área exatamente como aparece: ${name}.`);
      return call(env, profile, operation, { prefix });
    }
    case "erp.backup.delete": {
      const prefix = ownPrefix(profile, body!.prefix);
      if (body!.confirmado !== true) throw new ApiError(400, "erp_backup_delete_confirmation", "Confirme que quer apagar este backup.");
      const job = await currentJob(env, profile, status);
      if (job?.prefix === prefix && job.phase && !["done", "failed"].includes(job.phase))
        throw new ApiError(409, "erp_backup_job_running", job.kind === "restore"
          ? "Este backup está sendo restaurado agora. Espere a restauração terminar para apagá-lo."
          : "Este backup ainda está sendo feito. Espere terminar para apagá-lo.");
      let deleted = 0;
      for (let round = 0; round < 1000; round++) {
        const listed = await env.MEDIA.list({ prefix, limit: 1000 });
        const keys = listed.objects.map(object => object.key);
        if (!keys.length) break;
        await env.MEDIA.delete(keys);
        deleted += keys.length;
      }
      if (!deleted) throw new ApiError(404, "erp_backup_not_found", "Este backup não existe mais.");
      return Response.json({ prefix, deleted });
    }
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
