// FK adiada numa transação do motor. O esquema do SQLite não tem FK
// DEFERRABLE (docs/ERP-PORTE.md); quando o Postgres conta com uma FK adiada
// (a linha aponta para outra que nasce depois na mesma transação), o RPC liga
// o PRAGMA defer_foreign_keys e confere as tabelas antes do COMMIT, pela fila
// de adiados. Violação adiada que chega ao COMMIT sem conferência reinicia o
// objeto no Durable Object (schema/migrate.ts, prova 1); aqui ela vira 23503
// e a transação é desfeita.
import { raise } from "./errors.ts";
import { defer, type RpcContext } from "./registry.ts";

const KEY = "__engine.fk_deferred";

/** Adia as FKs até o fim da transação e confere `tables` antes do COMMIT. */
export function deferForeignKeys(ctx: RpcContext, ...tables: string[]) {
  const first = !ctx.settings.has(KEY);
  const pending = new Set((ctx.settings.get(KEY) ?? "").split(",").filter(Boolean));
  for (const t of tables) pending.add(t);
  ctx.settings.set(KEY, [...pending].join(","));
  if (!first) return;
  ctx.db.exec("PRAGMA defer_foreign_keys = ON");
  defer(ctx, () => {
    for (const t of (ctx.settings.get(KEY) ?? "").split(",").filter(Boolean)) {
      const bad = ctx.db.exec(`PRAGMA foreign_key_check("${t.replace(/"/g, '""')}")`).rows;
      if (bad.length) raise("23503", `foreign_key_violation:${t}`);
    }
  });
}
