// Medição das idas ao D1 de um trecho (o comando no Coordinator): quantas e
// quanto tempo somaram. Vai no cabeçalho Server-Timing da resposta
// (d1;desc="calls=N";dur=ms), para medir na instalação de verdade onde o
// tempo vai (docs/LIMITES.md). Uma ida = um first/all/run/raw ou um batch.
import type { Env } from "./types";

export interface D1Timing {
  calls: number;
  ms: number;
}

export function timedEnv(env: Env): { env: Env; timing: D1Timing } {
  const timing: D1Timing = { calls: 0, ms: 0 };
  const raw = new WeakMap<object, any>();
  const db: any = env.DB;
  const time = async <T>(run: () => Promise<T>) => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      timing.calls++;
      timing.ms += Date.now() - started;
    }
  };
  const wrap = (stmt: any): any => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...args: any[]) => wrap(target.bind(...args));
        if (["first", "all", "run", "raw"].includes(prop as string))
          return (...args: any[]) => time(() => target[prop](...args));
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    raw.set(proxy, stmt);
    return proxy;
  };
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (prop === "batch")
        return (stmts: any[]) =>
          time(() => target.batch(stmts.map((s) => raw.get(s) ?? s)));
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB } as Env, timing };
}

export const serverTiming = (t: D1Timing) =>
  `d1;desc="calls=${t.calls}";dur=${t.ms}`;
