// Registro dos RPCs portados e a execução de um RPC: uma transação por
// chamada (transactionSync no objeto), com o contexto que substitui o
// set_config/current_setting do Postgres.
import type { SqlDriver } from "./driver.ts";
import { ErpError, fromSqlite } from "./errors.ts";
import { Clock } from "./time.ts";

export interface RpcContext {
  db: SqlDriver;
  clock: Clock;
  /** set_config(nome, valor, true): vale até o fim da transação. */
  settings: Map<string, string>;
}

export type RpcArgs = Record<string, unknown>;
export type RpcFn = (ctx: RpcContext, args: RpcArgs) => unknown;

const registry = new Map<string, RpcFn>();

/** Domínios registram as funções públicas (o nome do Postgres, sem schema). */
export function registerRpc(name: string, fn: RpcFn) {
  if (registry.has(name)) throw new Error(`RPC ${name} registrado duas vezes.`);
  registry.set(name, fn);
}
export const portedRpcs = () => [...registry.keys()].sort();
export const isPorted = (name: string) => registry.has(name);

/**
 * Executa o RPC numa transação. Erro desfaz tudo e sai como ErpError
 * (código e mensagem do Postgres). RPC não portado: 0A000.
 */
export function callRpc(db: SqlDriver, name: string, args: RpcArgs, clock = new Clock()) {
  const fn = registry.get(name);
  if (!fn) throw new ErpError("0A000", `rpc_not_ported:${name}`);
  return inTransaction(db, (ctx) => fn(ctx, args), clock);
}

/** Uma função qualquer do motor numa transação, com o contexto (testes de funções internas). */
export function inTransaction<T>(db: SqlDriver, fn: (ctx: RpcContext) => T, clock = new Clock()): T {
  const ctx: RpcContext = { db, clock, settings: new Map() };
  try {
    return db.transaction(() => fn(ctx));
  } catch (error) {
    throw fromSqlite(error);
  }
}
