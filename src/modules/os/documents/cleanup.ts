import { all, exec, one } from "../../../db";
import type { ModuleContext } from "../../api";
import type { DueRequest, DueResult } from "../extensions";
import {
  documentPrefix,
  UPLOAD_TTL,
  UPLOAD_LEASE,
  type DocumentRow,
} from "./model";

/** Manutenção técnica, sem texto de documentos, sem novas tabelas ou recursos. */
export async function cleanupDocuments(
  ctx: ModuleContext,
  request: DueRequest,
): Promise<DueResult> {
  const { budget, now: at, limit } = request;
  if (limit < 1 || budget.remaining < 2)
    return { processed: 0, has_more: true };
  budget.consume(1);
  const expired = await all<DocumentRow>(
    ctx.env,
    `SELECT * FROM os_documents WHERE profile_id=? AND state='pending'
      AND upload_expires_at<=? ORDER BY upload_expires_at,id LIMIT ?`,
    ctx.profile,
    at,
    Math.min(limit, budget.remaining),
  );
  let processed = 0;
  for (const row of expired) {
    budget.consume(1);
    const changed = await exec(
      ctx.env,
      `UPDATE os_documents SET state='aborted',upload_lease_until=NULL
       WHERE profile_id=? AND order_id=? AND id=? AND state='pending' AND upload_expires_at<=?`,
      ctx.profile,
      row.order_id,
      row.id,
      at,
    );
    if (changed.meta.changes && row.r2_key)
      await ctx.env.MEDIA.delete(row.r2_key);
    processed++;
  }
  if (processed >= limit || budget.remaining < 1)
    return { processed, has_more: true };
  // Cursor durável no R2 existente: a varredura não fica presa à primeira página.
  const checkpointKey = `os-document-maintenance/${encodeURIComponent(ctx.profile)}/cursor`;
  const checkpoint = await ctx.env.MEDIA.get(checkpointKey);
  const saved = checkpoint ? await checkpoint.text() : "";
  const page = await ctx.env.MEDIA.list({
    prefix: documentPrefix(ctx.profile),
    limit: Math.min(limit - processed, budget.remaining),
    ...(saved ? { cursor: saved } : {}),
  });
  for (const object of page.objects) {
    // Folga cobre PUT tardio de uma tentativa perdida; uma rodada futura o recolhe.
    if (object.uploaded.getTime() + UPLOAD_TTL + UPLOAD_LEASE <= at) {
      const parts = object.key
        .slice(documentPrefix(ctx.profile).length)
        .split("/");
      if (parts.length === 4) {
        budget.consume(1);
        const row = await one<DocumentRow>(
          ctx.env,
          "SELECT * FROM os_documents WHERE profile_id=? AND order_id=? AND id=? AND r2_key=?",
          ctx.profile,
          decodeURIComponent(parts[1]),
          decodeURIComponent(parts[2]),
          object.key,
        );
        // Arquivar não elimina um objeto confirmado. Não é política de retenção.
        if (!row || (row.state !== "ready" && row.upload_expires_at <= at))
          await ctx.env.MEDIA.delete(object.key);
      }
    }
    processed++;
  }
  await ctx.env.MEDIA.put(checkpointKey, page.truncated ? page.cursor : "");
  return { processed, has_more: page.truncated };
}
