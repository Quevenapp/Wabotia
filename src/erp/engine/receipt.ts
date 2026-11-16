// Recibo de comando (idempotência dos RPCs de escrita), sobre a tabela de
// comando do próprio domínio (erp_stock.command, …): mesmo comando com o
// mesmo ator e o mesmo hash devolve o resultado gravado; com outro, 40001.
// Na fase 2 as 59 tabelas *command podem convergir para command_receipt
// (scope, command_id); a regra é a mesma.
import type { SqlDriver } from "./driver.ts";
import { one } from "./driver.ts";
import { raise } from "./errors.ts";

export function replay(
  db: SqlDriver,
  table: string,
  commandId: string,
  actor: string,
  hash: string,
  conflict: string,
): Record<string, unknown> | null {
  const row = one(db, `SELECT actor, request_hash, result FROM "${table}" WHERE id=?`, commandId);
  if (!row) return null;
  if (row.actor !== actor || row.request_hash !== hash) raise("40001", conflict);
  return JSON.parse(String(row.result));
}
