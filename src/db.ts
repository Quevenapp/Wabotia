import type { Env } from "./types";

// Leituras de configuração repetidas numa mesma invocação (docs/LIMITES.md).
// O plano gratuito do Cloudflare aceita 50 consultas ao D1 por invocação;
// o motor e os módulos releem o estado dos módulos, as configurações da área
// e a conexão a cada gancho. `withReadCache` abre um escopo (um env derivado
// que passa adiante pelas chamadas) em que `cachedOne`/`cachedAll` lembram o
// resultado. Qualquer escrita, no mesmo escopo, que cite uma tabela de
// CACHED_TABLES esvazia o escopo inteiro. Use os cacheados só em consultas
// que leem exclusivamente essas tabelas.
const READ_CACHE = Symbol.for("wabotia.readCache");
const CACHED_TABLES =
  /\b(profiles|profile_modules|connections|meta_numbers|meta_accounts|payment_accounts|instance_settings|webhook_subscriptions|applications|pedido_store|pedido_categories|pedido_items|pedido_groups|pedido_item_groups|pedido_menu_images|media)\b/i;
type ReadCache = Map<string, Promise<any>>;
const cacheOf = (env: Env): ReadCache | undefined => (env as any)[READ_CACHE];

/** Env com cache de leituras de configuração (reaproveita o escopo aberto). */
export function withReadCache(env: Env): Env {
  return cacheOf(env)
    ? env
    : ({ ...env, [READ_CACHE]: new Map() as ReadCache } as Env);
}
function invalidate(env: Env, sql: string) {
  const cache = cacheOf(env);
  if (cache?.size && !/^\s*select\b/i.test(sql) && CACHED_TABLES.test(sql))
    cache.clear();
}
function remember<T>(env: Env, key: string, load: () => Promise<T>) {
  const cache = cacheOf(env);
  if (!cache) return load();
  let hit = cache.get(key);
  if (!hit) {
    hit = load();
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit as Promise<T>;
}

export async function one<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T | null> {
  invalidate(env, sql);
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}
export async function all<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T[]> {
  invalidate(env, sql);
  return (
    await env.DB.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export async function exec(env: Env, sql: string, ...args: any[]) {
  invalidate(env, sql);
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
export async function batch(env: Env, items: [string, any[]][]) {
  for (const [sql] of items) invalidate(env, sql);
  return env.DB.batch(
    items.map(([sql, args]) => env.DB.prepare(sql).bind(...args)),
  );
}

/** `one` lembrado no escopo de `withReadCache` (cópia rasa da linha). */
export async function cachedOne<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T | null> {
  const row = await remember(
    env,
    `1\u0000${sql}\u0000${JSON.stringify(args)}`,
    () => one<T>(env, sql, ...args),
  );
  return row ? ({ ...row } as T) : row;
}
/** `all` lembrado no escopo de `withReadCache` (cópias rasas das linhas). */
export async function cachedAll<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T[]> {
  const rows = await remember(
    env,
    `*\u0000${sql}\u0000${JSON.stringify(args)}`,
    () => all<T>(env, sql, ...args),
  );
  return rows.map((row) => ({ ...row }) as T);
}
