// Registro dos RPCs portados e a execução de um RPC: uma transação por
// chamada (transactionSync no objeto), com o contexto que substitui o
// set_config/current_setting do Postgres.
import type { SqlDriver } from "./driver.ts";
import { ErpError, fromSqlite } from "./errors.ts";
import { Clock } from "./time.ts";
import { NO_IDENTITY, type IdentityPort } from "./identity.ts";
import { prepareArgs } from "./args.ts";

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
  /** Todos os objetos do armazenamento da área (só para RPC registrado com { listing: true }). */
  listing: () => StoredListing[];
  /** Quem chama e as pessoas da área (porta de identidade, engine/identity.ts). */
  identity: IdentityPort;
}

/** Objeto do armazenamento numa listagem: bucket, nome e tamanho em bytes. */
export interface StoredListing {
  bucket: string;
  name: string;
  size: number;
}

/** O que o objeto erp: entrega ao RPC além do banco (lido antes da transação). */
export interface RpcEnvironment {
  objects?: ObjectLookup;
  listing?: StoredListing[];
  identity?: IdentityPort;
  /**
   * Portão por requisição (horário de acesso e segundo fator) antes do RPC,
   * na mesma transação: o accessGate da erp-api, sem uma ida a mais ao
   * objeto. A costura pede em toda chamada da erp-api (src/erp/api/local-fetch.ts).
   */
  gate?: boolean;
}

/** Motivo de recusa do portão. */
export type GateDenial = "outside_schedule" | "mfa_required";
/** Recusa do portão: a costura a devolve como 403 ERP_ACCESS_OUTSIDE_SCHEDULE / ERP_MFA_REQUIRED. */
export class ErpGateDenied extends ErpError {
  readonly reason: GateDenial;
  constructor(reason: GateDenial) {
    super("28000", `erp_gate_${reason}`);
    this.reason = reason;
  }
}
let gate: ((ctx: RpcContext) => GateDenial | null) | null = null;
/** O Acesso registra o portão (access/rpc/security.ts). */
export function registerGate(fn: (ctx: RpcContext) => GateDenial | null) {
  gate = fn;
}

export type RpcArgs = Record<string, unknown>;
export type RpcFn = (ctx: RpcContext, args: RpcArgs) => unknown;
export interface RpcOptions {
  /** Chaves de armazenamento ("bucket/nome") que o RPC consulta, a partir dos argumentos. */
  objects?: (args: RpcArgs) => string[];
  /** O RPC soma ou lista todos os objetos da área (storage.objects inteiro). */
  listing?: boolean;
}

const registry = new Map<string, RpcFn>();
const options = new Map<string, RpcOptions>();
const before: ((ctx: RpcContext) => void)[] = [];

/** Passo comum a todo RPC, dentro da transação e antes do corpo (ex.: projeção da identidade). */
export function registerBeforeRpc(fn: (ctx: RpcContext) => void) {
  before.push(fn);
}

/** O RPC pede a listagem de todos os objetos da área? */
export const rpcWantsListing = (name: string) => options.get(name)?.listing === true;

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
export function callRpc(db: SqlDriver, name: string, args: RpcArgs, clock = new Clock(), env: ObjectLookup | RpcEnvironment = {}) {
  const fn = registry.get(name);
  if (!fn) throw new ErpError("0A000", `rpc_not_ported:${name}`);
  // Resolução, tipos e DEFAULTs dos argumentos (engine/args.ts): no Postgres,
  // antes do corpo e antes de qualquer escrita.
  const prepared = prepareArgs(name, args);
  return inTransaction(
    db,
    (ctx) => {
      for (const step of before) step(ctx);
      if (typeof env === "object" && env.gate && gate) {
        const denied = gate(ctx);
        if (denied) throw new ErpGateDenied(denied);
      }
      return fn(ctx, prepared);
    },
    clock,
    env,
  );
}

/**
 * Uma função qualquer do motor numa transação, com o contexto (testes de
 * funções internas). `env` aceita a consulta de objetos (forma antiga) ou o
 * ambiente completo.
 */
export function inTransaction<T>(db: SqlDriver, fn: (ctx: RpcContext) => T, clock = new Clock(), env: ObjectLookup | RpcEnvironment = {}): T {
  const e: RpcEnvironment = typeof env === "function" ? { objects: env } : env;
  const listing = e.listing ?? [];
  const ctx: RpcContext = {
    db,
    clock,
    settings: new Map(),
    objects: e.objects ?? noObjects,
    listing: () => listing,
    identity: e.identity ?? NO_IDENTITY,
  };
  try {
    return db.transaction(() => fn(ctx));
  } catch (error) {
    throw fromSqlite(error);
  }
}
