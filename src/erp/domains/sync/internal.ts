// Sincronização com o Origin (erp_sync): o mínimo que o estoque usa.
// Portado de erp_sync.enabled, erp_sync.applying, erp_sync.actor e
// erp_sync.enqueue (a fila de saída do espelho).
import { one } from "../../engine/driver.ts";
import type { RpcContext } from "../../engine/registry.ts";

export const enabled = (ctx: RpcContext) =>
  !!one(ctx.db, 'SELECT enabled FROM "erp_sync__settings" WHERE singleton=1')?.enabled;

/** current_setting('erp_sync.applying') = 'on' */
export const applying = (ctx: RpcContext) => ctx.settings.get("erp_sync.applying") === "on";

export const actor = (ctx: RpcContext): string | null =>
  (one(ctx.db, 'SELECT actor_id FROM "erp_sync__settings" WHERE singleton=1')?.actor_id as string) ?? null;

/** erp_sync.enqueue(entity, record, op, item, detail) */
export function enqueue(
  ctx: RpcContext,
  entity: string,
  record: string | null,
  op: string,
  item: number | null,
  detail: unknown,
) {
  if (record === null || !enabled(ctx) || applying(ctx)) return;
  const now = ctx.clock.next().toString();
  if (op === "upsert" || op === "delete")
    ctx.db.exec(
      `UPDATE "erp_sync__outbox" SET state='superseded', finished_at=? WHERE entity=? AND record_id=? AND state='pending' AND op=?`,
      now,
      entity,
      record,
      op === "upsert" ? "delete" : "upsert",
    );
  const json = detail === null || detail === undefined ? null : JSON.stringify(detail);
  const pending = one(
    ctx.db,
    `SELECT id, state FROM "erp_sync__outbox" WHERE entity=? AND record_id=? AND item=? AND op=? AND state IN ('pending','sending')`,
    entity,
    record,
    item ?? 0,
    op,
  );
  if (pending)
    ctx.db.exec(
      `UPDATE "erp_sync__outbox" SET changed_at=?, detail=coalesce(?, detail), dirty=(state='sending'), next_attempt_at=CASE WHEN state='pending' THEN -9223372036854775808 ELSE next_attempt_at END WHERE id=?`,
      now,
      json,
      pending.id,
    );
  else
    ctx.db.exec(
      `INSERT INTO "erp_sync__outbox"(entity, record_id, item, op, detail, changed_at, enqueued_at, next_attempt_at) VALUES(?,?,?,?,?,?,?,-9223372036854775808)`,
      entity,
      record,
      item ?? 0,
      op,
      json,
      now,
      now,
    );
}
