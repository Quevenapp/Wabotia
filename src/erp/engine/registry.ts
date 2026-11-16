// Registro dos RPCs portados e a execução de um RPC: uma transação por
// chamada (transactionSync no objeto), com o contexto que substitui o
// set_config/current_setting do Postgres.
import type { SqlDriver } from "./driver.ts";
import { ErpError, fromSqlite } from "./errors.ts";
import { Clock } from "./time.ts";

/** Objeto já enviado ao armazenamento (o storage.objects do Supabase; no Wabotia, o R2). */
export interface StoredObject {
  size: number;
  mimetype: string;
}
export type ObjectLookup = (key: string) => StoredObject | null;
const noObjects: ObjectLookup = () => null;

export interface RpcContext {
  db: SqlDriver;
  clock: Clock;
  /** set_config(nome, valor, true): vale até o fim da transação. */
  settings: Map<string, string>;
  /**
   * Objetos do armazenamento consultados pelo RPC ("bucket/nome"). A
   * transação é síncrona: o objeto lê do R2, antes, as chaves que o RPC
   * declarou em registerRpc(…, { objects }).
   */
  objects: ObjectLookup;
}

export type RpcArgs = Record<string, unknown>;
export type RpcFn = (ctx: RpcContext, args: RpcArgs) => unknown;
export interface RpcOptions {
  /** Chaves de armazenamento ("bucket/nome") que o RPC consulta, a partir dos argumentos. */
  objects?: (args: RpcArgs) => string[];
}

const registry = new Map<string, RpcFn>();
const options = new Map<string, RpcOptions>();

/** Domínios registram as funções públicas (o nome do Postgres, sem schema). */
export function registerRpc(name: string, fn: RpcFn, opts: RpcOptions = {}) {
  if (registry.has(name)) throw new Error(`RPC ${name} registrado duas vezes.`);
  registry.set(name, fn);
  options.set(name, opts);
}

/** Chaves de armazenamento que o RPC vai consultar (lidas antes da transação). */
export function rpcObjectKeys(name: string, args: RpcArgs): string[] {
  try {
    return options.get(name)?.objects?.(args) ?? [];
  } catch {
    return [];
  }
}
export const portedRpcs = () => [...registry.keys()].sort();
export const isPorted = (name: string) => registry.has(name);

/**
 * Executa o RPC numa transação. Erro desfaz tudo e sai como ErpError
 * (código e mensagem do Postgres). RPC não portado: 0A000.
 */
export function callRpc(db: SqlDriver, name: string, args: RpcArgs, clock = new Clock(), objects: ObjectLookup = noObjects) {
  const fn = registry.get(name);
  if (!fn) throw new ErpError("0A000", `rpc_not_ported:${name}`);
  return inTransaction(db, (ctx) => fn(ctx, args), clock, objects);
}

/** Uma função qualquer do motor numa transação, com o contexto (testes de funções internas). */
export function inTransaction<T>(db: SqlDriver, fn: (ctx: RpcContext) => T, clock = new Clock(), objects: ObjectLookup = noObjects): T {
  const ctx: RpcContext = { db, clock, settings: new Map(), objects };
  try {
    return db.transaction(() => fn(ctx));
  } catch (error) {
    throw fromSqlite(error);
  }
}
