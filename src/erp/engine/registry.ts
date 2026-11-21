import { normalizeErpParts, type ErpParts, type ErpPartsReference } from "../parts.ts";
import { requireRpcParts as requireOrdinaryParts, withErpMaintenance, inspectErpEffects, type ErpMaintenanceRequest } from "./parts-gate.ts";
import { moduleParts, withModuleExecution, originScope, isModuleActor, type ModuleTransportProof } from "./module-origin.ts";
import { guardModuleRpc } from "../domains/documents/module-policy.ts";
export function requireRpcParts(ctx: RpcContext, name: string, args: RpcArgs) {
  if (!moduleParts(ctx, name, args)) requireOrdinaryParts(ctx, name, args);
}
// Registro dos RPCs portados e a execução de um RPC: uma transação por
// chamada (transactionSync no objeto), com o contexto que substitui o
// set_config/current_setting do Postgres.
import type { SqlDriver } from "./driver.ts";
import { ErpError, fromSqlite } from "./errors.ts";
import { Clock } from "./time.ts";
import { NO_IDENTITY, type IdentityPort } from "./identity.ts";
import { prepareArgs } from "./args.ts";
import { flushSequences } from "./sequence.ts";
import type { ErpModuleState } from "./module-state.ts";

/** Objeto já enviado ao armazenamento (o storage.objects do Supabase; no Wabotia, o R2). */
export interface StoredObject {
  size: number;
  mimetype: string;
}
export type ObjectLookup = (key: string) => StoredObject | null;
const noObjects: ObjectLookup = () => null;

export interface RpcContext {
  workEnabled?: boolean;
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
  /** Ativação por requisição; não participa dos argumentos nem do hash do comando. */
  modules?: ErpModuleState;
  readonly parts: Readonly<ErpParts>;
  readonly partsReference?: ErpPartsReference;
  /** Números de identity emitidos nesta chamada (engine/sequence.ts); gravados fora da transação. */
  sequences: Map<string, bigint>;
  /**
   * Gatilhos DEFERRABLE INITIALLY DEFERRED enfileirados (defer): rodam no fim
   * da transação, antes do COMMIT, na ordem da fila; o que eles enfileiram
   * também roda. Sem deduplicar, como o Postgres (um evento por linha escrita).
   */
  deferred: (() => void)[];
}

/** Enfileira um gatilho adiado (roda antes do COMMIT, dentro da transação). */
export function defer(ctx: RpcContext, fn: () => void) {
  ctx.deferred.push(fn);
}

/** Objeto do armazenamento numa listagem: bucket, nome e tamanho em bytes. */
export interface StoredListing {
  bucket: string;
  name: string;
  size: number;
}

/** O que o objeto erp: entrega ao RPC além do banco (lido antes da transação). */
export interface RpcEnvironment {
  workEnabled?: boolean;
  moduleProof?: ModuleTransportProof;
  objects?: ObjectLookup;
  listing?: StoredListing[];
  identity?: IdentityPort;
  modules?: ErpModuleState;
  parts?: Partial<ErpParts>;
  partsReference?: ErpPartsReference;
  maintenance?: ErpMaintenanceRequest;
  /**
   * Portão por requisição (horário de acesso e segundo fator) antes do RPC,
   * na mesma transação: o accessGate da erp-api, sem uma ida a mais ao
   * objeto. A costura pede em toda chamada da erp-api (src/erp/api/local-fetch.ts).
   */
  gate?: boolean;
}

/** Motivo de recusa do portão. */
export type GateDenial = "outside_schedule" | "mfa_required" | "agent_out_of_scope";
/** Recusa do portão: a costura a devolve como 403 ERP_ACCESS_OUTSIDE_SCHEDULE / ERP_MFA_REQUIRED / ERP_AGENT_ACCESS_DENIED. */
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
  /**
   * Chaves de armazenamento ("bucket/nome") que o RPC consulta, a partir dos
   * argumentos e, quando o caminho está gravado no banco, de uma leitura
   * antes da transação (`db`; só leitura). Se o caminho mudar entre essa
   * leitura e a transação, o objeto não está no mapa e a checagem recusa:
   * falha segura, nunca um objeto errado.
   */
  objects?: (args: RpcArgs, db?: SqlDriver) => string[];
  /** O RPC soma ou lista todos os objetos da área (storage.objects inteiro). */
  listing?: boolean;
  /**
   * O RPC cria trabalho para o agendador (tarefa da plataforma): depois de
   * dar certo, a rota /erp-rpc antecipa o alarme do objeto para daqui a 1 s
   * (o mais cedo vence, como o /erp-wake; docs/ERP-AGENDADOR.md).
   */
  wake?: boolean;
}

const registry = new Map<string, RpcFn>();
const options = new Map<string, RpcOptions>();
const before: ((ctx: RpcContext) => void)[] = [];

/** Passo comum a todo RPC, dentro da transação e antes do corpo (ex.: projeção da identidade). */
export function registerBeforeRpc(fn: (ctx: RpcContext) => void) {
  before.push(fn);
}

/**
 * Guarda de um RPC chamado de fora (não roda nos aninhados de invokeRpc), na
 * mesma transação, depois das partes e antes do corpo: pode recusar ou acertar
 * os argumentos e devolver o que roda logo depois do corpo. As lojas usam
 * (domains/stores/guard.ts): sem duas lojas, não faz nada.
 */
export type RpcGuard = (ctx: RpcContext, name: string, args: RpcArgs) => (() => void) | void;
const guards: RpcGuard[] = [];
export function registerRpcGuard(fn: RpcGuard) {
  guards.push(fn);
}

/** O RPC pede a listagem de todos os objetos da área? */
export const rpcWantsListing = (name: string) => options.get(name)?.listing === true;
/** O RPC acorda o agendador quando dá certo? */
export const rpcWakes = (name: string) => options.get(name)?.wake === true;

/** Domínios registram as funções públicas (o nome do Postgres, sem schema). */
export function registerRpc(name: string, fn: RpcFn, opts: RpcOptions = {}) {
  if (registry.has(name)) throw new Error(`RPC ${name} registrado duas vezes.`);
  registry.set(name, fn);
  options.set(name, opts);
}

/** Chaves de armazenamento que o RPC vai consultar (lidas antes da transação). */
export function rpcObjectKeys(name: string, args: RpcArgs, db?: SqlDriver): string[] {
  try {
    return options.get(name)?.objects?.(args, db) ?? [];
  } catch {
    return [];
  }
}
/**
 * Um RPC público chamado de dentro de outro, na mesma transação (o PL/pgSQL
 * chamando public.erp_*): argumentos preparados como no callRpc, sem o
 * portão e sem os passos de antes do RPC. Não portado: 0A000.
 */
export function invokeRpc(ctx: RpcContext, name: string, args: RpcArgs): unknown {
  if (!originScope(ctx) && (ctx.identity.module_execution || isModuleActor(ctx.identity))) throw new ErpError("42501", "module_origin_denied");
  const fn = registry.get(name);
  if (!fn) throw new ErpError("0A000", `rpc_not_ported:${name}`);
  const prepared = prepareArgs(name, args);
  guardModuleRpc(ctx, name, prepared);
  requireRpcParts(ctx, name, prepared);
  return fn(ctx, prepared);
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
      return withModuleExecution(ctx, name, prepared, typeof env === "object" ? env.moduleProof : undefined, () => {
      guardModuleRpc(ctx, name, prepared);
      if (typeof env === "object" && env.gate && gate) {
        const denied = gate(ctx);
        if (denied) throw new ErpGateDenied(denied);
      }
      const run = () => {
        requireRpcParts(ctx, name, prepared);
        const after: (() => void)[] = [];
        for (const guard of guards) {
          const next = guard(ctx, name, prepared);
          if (next) after.push(next);
        }
        const value = fn(ctx, prepared);
        for (const next of after) next();
        return typeof env === "object" && env.maintenance?.action === "inspect" ? inspectErpEffects(ctx) : value;
      };
      return typeof env === "object" && env.maintenance ? withErpMaintenance(ctx, env.maintenance, run) : run();
      });
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
    modules: e.modules,
    workEnabled: e.workEnabled,
    parts: normalizeErpParts(e.parts),
    partsReference: e.partsReference ? Object.freeze({ ...e.partsReference }) : undefined,
    sequences: new Map(),
    deferred: [],
  };
  Object.defineProperty(ctx, "parts", { value: ctx.parts, writable: false, configurable: false });
  try {
    return db.transaction(() => {
      const result = fn(ctx);
      for (let i = 0; i < ctx.deferred.length; i++) ctx.deferred[i]();
      return result;
    });
  } catch (error) {
    throw fromSqlite(error);
  } finally {
    // nextval não volta com a transação: o número emitido fica gravado mesmo
    // quando o RPC falhou (engine/sequence.ts).
    flushSequences(db, ctx.sequences);
  }
}
