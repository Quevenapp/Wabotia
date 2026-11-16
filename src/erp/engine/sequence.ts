// Colunas identity do Postgres (GENERATED … AS IDENTITY) no motor: o número
// vem de uma sequência que NÃO volta com a transação, como o nextval. Um RPC
// que insere e falha consome o número nos dois motores, e o próximo sucesso
// recebe o mesmo número (achado da O, grouped_billing.number).
// - O último número emitido de cada coluna fica em erp_meta
//   ("seq:<tabela>.<coluna>"); sem registro, parte do maior valor da tabela
//   (a semeadura copia os números do oráculo; tests/erp/sequence.test.mjs
//   confere que as sequências do oráculo estão no maior valor).
// - Dentro da chamada, os números saem de ctx.sequences; o inTransaction
//   grava o último emitido em erp_meta DEPOIS da transação, com ou sem erro.
import type { SqlDriver } from "./driver.ts";
import type { RpcContext } from "./registry.ts";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const key = (table: string, column: string) => `seq:${table}.${column}`;

function ensureMeta(db: SqlDriver) {
  db.exec("CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
}

/** nextval da identity de <tabela>.<coluna> (tabela do SQLite, "schema__tabela"). */
export function nextIdentity(ctx: RpcContext, table: string, column: string): number {
  const k = key(table, column);
  let last = ctx.sequences.get(k);
  if (last === undefined) {
    ensureMeta(ctx.db);
    const stored = ctx.db.exec("SELECT value FROM erp_meta WHERE key=?", k).rows[0]?.value;
    const max = ctx.db.exec(`SELECT CAST(coalesce(max(${q(column)}), 0) AS TEXT) m FROM ${q(table)}`).rows[0]?.m;
    const a = stored === undefined ? 0n : BigInt(String(stored)),
      b = BigInt(String(max ?? 0));
    last = a > b ? a : b;
  }
  last += 1n;
  ctx.sequences.set(k, last);
  return Number(last);
}

/** Grava o último número emitido de cada sequência usada (fora da transação do RPC). */
export function flushSequences(db: SqlDriver, sequences: Map<string, bigint>) {
  if (!sequences.size) return;
  ensureMeta(db);
  for (const [k, v] of sequences)
    db.exec(
      "INSERT INTO erp_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER) THEN excluded.value ELSE value END",
      k,
      v.toString(),
    );
  sequences.clear();
}
