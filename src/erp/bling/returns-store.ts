/** Volta ao Bling (versão 32), parte leve: interruptores e horários, só SQL.
 * A montagem (assembly.ts, também carregada pelo Worker) usa só isto; o motor
 * (returns.ts) entra por import dinâmico, como o da adoção. */
import type { Row, SqlDriver } from "../engine/driver.ts";
import type { BlingReturnKind } from "./two-way-contracts.ts";

type Json = Record<string, unknown>;
const one = (db: SqlDriver, sql: string, ...params: unknown[]): Row | undefined => db.exec(sql, ...params).rows[0];
const parse = (value: unknown): Json => { try { const v = JSON.parse(String(value ?? "{}")); return v && typeof v === "object" && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };

export function returnsTables(db: SqlDriver): boolean {
  try { db.exec("SELECT 1 AS x FROM wb_bling_return_setting LIMIT 1"); return true; } catch { return false; }
}
export interface ReturnSetting { kind: BlingReturnKind; enabled: boolean; since: number | null; options: Json; scan: Json; by: string }
export function returnSettings(db: SqlDriver): Record<BlingReturnKind, ReturnSetting | null> {
  const result = { invoice: null, status: null, webhook: null } as Record<BlingReturnKind, ReturnSetting | null>;
  if (!returnsTables(db)) return result;
  for (const r of db.exec("SELECT kind, enabled, enabled_since, options, scan, updated_by FROM wb_bling_return_setting").rows)
    result[r.kind as BlingReturnKind] = { kind: r.kind as BlingReturnKind, enabled: Number(r.enabled) === 1, since: r.enabled_since == null ? null : Number(r.enabled_since),
      options: parse(r.options), scan: parse(r.scan), by: String(r.updated_by) };
  return result;
}
export function cutoverConfirmed(db: SqlDriver): boolean {
  try { return !!one(db, "SELECT 1 AS x FROM wb_bling_cutover WHERE id=1"); } catch { return false; }
}
/** Próxima varredura local (só com a nota ou a situação ligada e o corte confirmado). */
export function returnsLocalDue(db: SqlDriver): number | null {
  if (!cutoverConfirmed(db)) return null;
  const list = returnSettings(db);
  const on = (["invoice", "status"] as const).map(kind => list[kind]).filter(s => s?.enabled) as ReturnSetting[];
  return on.length ? Math.min(...on.map(s => Number(s.scan.next_at ?? 0))) : null;
}
/** Próximo envio ou conferência da fila da volta. Desligado, pendente não conta. */
export function returnsOutboxDue(db: SqlDriver): number | null {
  try {
    const r = one(db, `SELECT min(o.not_before) AS due FROM wb_bling_return_outbox o WHERE o.state IN ('sending','uncertain')
      OR (o.state='pending' AND EXISTS(SELECT 1 FROM wb_bling_return_setting s WHERE s.enabled=1 AND s.kind=(CASE o.kind WHEN 'invoice' THEN 'invoice' ELSE 'status' END)))`);
    return r?.due == null ? null : Number(r.due);
  } catch { return null; }
}
