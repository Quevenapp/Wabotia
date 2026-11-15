// Conta as consultas ao D1 de um trecho de código (plano gratuito do
// Cloudflare: 50 por invocação; pago: 1000). `calls` são idas ao banco
// (um batch conta uma); `statements` são as instruções (cada uma do batch).
import type { Env } from "../src/types";

export interface D1Count {
  calls: number;
  statements: number;
  sql: string[];
}

export function countingEnv(env: Env): { env: Env; count: D1Count } {
  const count: D1Count = { calls: 0, statements: 0, sql: [] };
  const raw = new WeakMap<object, any>();
  const db: any = env.DB;
  const wrap = (stmt: any, sql: string): any => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...args: any[]) => wrap(target.bind(...args), sql);
        if (["first", "all", "run", "raw"].includes(prop as string))
          return (...args: any[]) => {
            count.calls++;
            count.statements++;
            count.sql.push(sql.replace(/\s+/g, " ").slice(0, 120));
            return target[prop](...args);
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    raw.set(proxy, stmt);
    return proxy;
  };
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch")
        return (stmts: any[]) => {
          count.calls++;
          count.statements += stmts.length;
          count.sql.push(`batch(${stmts.length})`);
          return target.batch(stmts.map((s) => raw.get(s) ?? s));
        };
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB } as Env, count };
}

/** Executa `fn` com um env que conta as consultas. */
export async function measure<T>(
  env: Env,
  fn: (env: Env) => Promise<T>,
): Promise<{ result: T; count: D1Count }> {
  const { env: counted, count } = countingEnv(env);
  const result = await fn(counted);
  return { result, count };
}
