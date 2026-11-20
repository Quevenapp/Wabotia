// Contador próprio de OS2: não modifica o contador compartilhado de orçamento.
import type { Env } from "../src/types";

export interface Os2D1Statement {
  sql: string;
  rows_read: number;
  rows_written: number;
  metadata: boolean;
  domain: "os2" | "existing";
}
export interface Os2D1Count {
  calls: number;
  statements: number;
  sql: string[];
  rows_read: number;
  rows_written: number;
  metadata_missing: number;
  queries: Os2D1Statement[];
}
export const emptyOs2Count = (): Os2D1Count => ({ calls: 0, statements: 0, sql: [], rows_read: 0, rows_written: 0, metadata_missing: 0, queries: [] });
export const os2DomainSql = (sql: string) => /\b(?:os_objects|os_object_history|os2_receipts|os_field_index_state|os_order_field_index)\b/i.test(sql);

export function os2CountingEnv(env: Env): { env: Env; count: Os2D1Count } {
  const count = emptyOs2Count();
  const originals = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  const record = (sql: string, result?: { meta?: { rows_read?: number; rows_written?: number } }) => {
    const metadata = Number.isFinite(result?.meta?.rows_read) && Number.isFinite(result?.meta?.rows_written);
    const read = result?.meta?.rows_read ?? 0, written = result?.meta?.rows_written ?? 0;
    count.rows_read += read; count.rows_written += written;
    if (!metadata) count.metadata_missing++;
    count.queries.push({ sql, rows_read: read, rows_written: written, metadata, domain: os2DomainSql(sql) ? "os2" : "existing" });
  };
  const begin = (sql: string) => { count.statements++; count.sql.push(sql.replace(/\s+/g, " ").trim()); };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (["first", "all", "run", "raw"].includes(String(property))) return async (...args: unknown[]) => {
          count.calls++; begin(sql);
          let result: D1Result;
          try {
            // first/raw não expõem meta. all executa a mesma instrução uma vez.
            result = property === "run" ? await target.run() : await target.all();
          } catch (error) { record(sql); throw error; }
          record(sql, result);
          if (property === "first") {
            const row = result.results[0] as Record<string, unknown> | undefined;
            if (!row) return null;
            if (args[0] === undefined) return row;
            if (!Object.hasOwn(row, String(args[0]))) throw new Error(`D1_COLUMN_NOTFOUND: ${String(args[0])}`);
            return row[String(args[0])];
          }
          if (property === "raw") {
            const rows = result.results as Record<string, unknown>[];
            const values = rows.map(row => Object.values(row));
            return (args[0] as { columnNames?: boolean } | undefined)?.columnNames && rows.length
              ? [Object.keys(rows[0]), ...values] : values;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, { statement, sql });
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        count.calls++;
        const entries = statements.map(statement => originals.get(statement) ?? { statement, sql: "[unwrapped statement]" });
        for (const entry of entries) begin(entry.sql);
        let results: D1Result[];
        try { results = await target.batch(entries.map(entry => entry.statement)); }
        catch (error) { for (const entry of entries) record(entry.sql); throw error; }
        for (const [index, entry] of entries.entries()) record(entry.sql, results[index]);
        return results;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, count };
}

export function os2DomainBudget(count: Os2D1Count) {
  const statements = count.queries.filter(query => query.domain === "os2");
  return { statements: statements.length, rows_read: statements.reduce((total, query) => total + query.rows_read, 0), rows_written: statements.reduce((total, query) => total + query.rows_written, 0) };
}
