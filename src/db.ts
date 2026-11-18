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

/** Estado dos módulos de uma área (src/modules/registry.ts, moduleStates). */
export const MODULE_STATES_SQL =
  "SELECT module_id,enabled FROM profile_modules WHERE profile_id=?";

/** O env tem o escopo de cache de leituras aberto. */
export const hasReadCache = (env: Env) => !!cacheOf(env);

/**
 * Põe no escopo um resultado já lido em lote (src/security.ts, firstRows),
 * com a mesma chave de `cachedAll`.
 */
export function seedAll(env: Env, sql: string, args: any[], rows: any[]) {
  cacheOf(env)?.set(
    `*\u0000${sql}\u0000${JSON.stringify(args)}`,
    Promise.resolve(rows),
  );
}

/** Configurações da área com o estado dos módulos (service.ts, settings). */
export const PROFILE_SETTINGS_SQL =
  "SELECT p.*,(SELECT json_group_object(m.module_id,m.enabled) FROM profile_modules m WHERE m.profile_id=p.id) module_states FROM profiles p WHERE p.id=?";
/** Assinaturas de webhook ativas da área (events.ts, event). */
export const WEBHOOK_SUBS_SQL =
  "SELECT s.*,a.scopes FROM webhook_subscriptions s JOIN applications a ON a.id=s.app_id WHERE s.profile_id=? AND s.enabled=1 AND a.disabled=0";
/** Endereço público fixado (web-steps.ts, publicOrigin). */
export const PUBLIC_ORIGIN_SQL =
  "SELECT value FROM instance_settings WHERE key='public_origin'";

/** Uma leitura num lote (`first`: só a primeira linha, ou null). */
export interface Read {
  sql: string;
  args: any[];
  first?: boolean;
}
const readKey = (r: Read) =>
  `${r.first ? "1" : "*"}\u0000${r.sql}\u0000${JSON.stringify(r.args)}`;

/** A leitura já está no cache da requisição (não precisa ir ao banco). */
export const cached = (env: Env, r: Read) => !!cacheOf(env)?.has(readKey(r));

/**
 * Leituras de configuração que o passo seguinte vai fazer, numa ida só ao D1
 * (db.batch), postas no cache da requisição. Só as que ainda não estão lá;
 * sem escopo de cache, não faz nada. Leia depois com cachedOne/cachedAll
 * (mesma instrução e mesmos argumentos).
 */
export async function warm(env: Env, items: Read[]) {
  const cache = cacheOf(env);
  if (!cache) return;
  const missing = items.filter((r) => !cache.has(readKey(r)));
  if (!missing.length) return;
  const results = await batch(
    env,
    missing.map((r) => [r.sql, r.args]),
  );
  missing.forEach((r, i) => seedRead(env, r, results[i].results));
}
/** Põe no cache da requisição o resultado de uma leitura feita em lote. */
export function seedRead(env: Env, r: Read, rows: any[]) {
  cacheOf(env)?.set(
    readKey(r),
    Promise.resolve(r.first ? (rows[0] ?? null) : rows),
  );
}
/**
 * Várias leituras numa ida só, sem cache: o resultado de cada uma (a linha,
 * ou null, com `first`; senão a lista).
 */
export async function reads(env: Env, items: Read[]): Promise<any[]> {
  if (!items.length) return [];
  const results = await batchPrefetched(
    env,
    items.map((r) => [r.sql, r.args]),
  );
  return readValues(items, results);
}

// ---------------------------------------------------------------------------
// Adiantados de um comando (src/coordinator.ts, docs/LIMITES.md): as
// instruções que a operação vai fazer primeiro, feitas no lote da abertura
// do /command. Valem uma vez só, para a mesma instrução com os mesmos
// argumentos: uma segunda tentativa dentro da operação (a chamada que
// perdeu a corrida, por exemplo) vai ao banco de novo.
const PREFETCH = Symbol.for("wabotia.prefetch");
type PrefetchStore = Map<string, D1Result[]>;
const statementKey = (sql: string, args: any[]) =>
  `${sql}\u0000${JSON.stringify(args)}`;

/** Guarda os resultados adiantados (instruções e resultados na mesma ordem). */
export function seedPrefetch(
  env: Env,
  items: [string, any[]][],
  results: D1Result[],
) {
  const target = env as any;
  const store: PrefetchStore = (target[PREFETCH] ??= new Map());
  items.forEach(([sql, args], i) => {
    const key = statementKey(sql, args);
    store.set(key, [...(store.get(key) ?? []), results[i]]);
  });
}
function takePrefetched(env: Env, sql: string, args: any[]) {
  const store: PrefetchStore | undefined = (env as any)[PREFETCH];
  const list = store?.get(statementKey(sql, args));
  return list?.shift();
}
/**
 * Como `batch`, mas o que já veio adiantado no lote da abertura não vai ao
 * banco: só o resto (se sobrar) faz uma ida.
 */
export async function batchPrefetched(
  env: Env,
  items: [string, any[]][],
  options: { retry?: boolean } = {},
): Promise<D1Result[]> {
  const out = items.map(([sql, args]) => takePrefetched(env, sql, args));
  const missing = items.filter((_, i) => !out[i]);
  if (missing.length) {
    const got = await batch(env, missing, options);
    let next = 0;
    out.forEach((r, i) => {
      if (!r) out[i] = got[next++];
    });
  }
  return out as D1Result[];
}
/**
 * O valor de cada leitura (como `reads`) a partir dos resultados de um lote
 * em que elas foram por último, depois de outras instruções.
 */
export function readValues(items: Read[], results: D1Result[]): any[] {
  const tail = results.slice(results.length - items.length);
  return items.map((r, i) =>
    r.first ? (tail[i].results[0] ?? null) : tail[i].results,
  );
}

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

// ---------------------------------------------------------------------------
// Nova tentativa em erro transitório do D1 (docs/LIMITES.md). Os erros são os
// que a documentação da Cloudflare manda repetir ("Retry the operation",
// d1/observability/debug-d1). O D1 já repete sozinho uma leitura até duas
// vezes do lado dele; esta repetição cobre a ida e volta entre o Worker e o
// banco ("Network connection lost"). Uma vez só, só leitura: escrita nunca é
// repetida aqui, porque pode ter sido gravada antes do erro.
const TRANSIENT_D1 =
  /Network connection lost|storage caused object to be reset|reset because its code was updated|Replica disconnected from primary|Cannot resolve D1 DB due to transient issue|client disconnected/i;
const READ_ONLY = /^\s*(select|with)\b/i;
const WRITES =
  /\b(insert|update|delete|replace|create|drop|alter|pragma|vacuum|attach)\b/i;
/** Só SELECT/WITH, sem palavra de escrita (WITH … INSERT não conta). */
export const readOnlySql = (sql: string) =>
  READ_ONLY.test(sql) && !WRITES.test(sql);
export const transientD1Error = (error: unknown) =>
  TRANSIENT_D1.test(String((error as any)?.message ?? error));

async function retryRead<T>(
  repeat: boolean,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!repeat || !transientD1Error(error)) throw error;
    console.warn(
      JSON.stringify({
        component: "d1",
        retry: what.replace(/\s+/g, " ").slice(0, 120),
        error: String((error as any)?.message ?? error).slice(0, 200),
      }),
    );
    return run();
  }
}

export async function one<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T | null> {
  invalidate(env, sql);
  return retryRead(readOnlySql(sql), sql, () =>
    env.DB.prepare(sql)
      .bind(...args)
      .first<T>(),
  );
}
export async function all<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T[]> {
  invalidate(env, sql);
  return retryRead(
    readOnlySql(sql),
    sql,
    async () =>
      (
        await env.DB.prepare(sql)
          .bind(...args)
          .all<T>()
      ).results,
  );
}
export async function exec(env: Env, sql: string, ...args: any[]) {
  invalidate(env, sql);
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
/**
 * Várias instruções numa ida ao D1 (transação). Repete uma vez em erro
 * transitório só se todas forem leitura, ou com `retry: true` quando quem
 * chama aceita repetir a escrita (src/security.ts: o +1 do contador de
 * requisições por minuto).
 */
export async function batch(
  env: Env,
  items: [string, any[]][],
  options: { retry?: boolean } = {},
) {
  for (const [sql] of items) invalidate(env, sql);
  return retryRead(
    options.retry === true || items.every(([sql]) => readOnlySql(sql)),
    `batch(${items.length}): ${items[0]?.[0] ?? ""}`,
    () =>
      env.DB.batch(
        items.map(([sql, args]) => env.DB.prepare(sql).bind(...args)),
      ),
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
