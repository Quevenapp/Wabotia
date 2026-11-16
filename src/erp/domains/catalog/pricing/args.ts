// Leitura dos argumentos dos RPCs de produto e preço. O motor
// (engine/args.ts, no callRpc) já resolveu nomes, tipos (uuid canônico,
// inteiro, booleano, data, vetores) e DEFAULTs antes do corpo; aqui só se lê.
// O valor padrão vale para chamadas diretas entre RPCs (sem o callRpc).
import type { RpcArgs } from "../../../engine/registry.ts";

const read = (a: RpcArgs, name: string, fallback: unknown) =>
  Object.prototype.hasOwnProperty.call(a, name) && a[name] !== undefined ? a[name] : fallback;

export const uuidArg = (a: RpcArgs, name: string, fallback: string | null = null) => read(a, name, fallback) as string | null;
export const textArg = (a: RpcArgs, name: string, fallback: string | null = null) => read(a, name, fallback) as string | null;
export const intArg = (a: RpcArgs, name: string, fallback: number | null = null) => {
  const v = read(a, name, fallback);
  return v === null ? null : Number(v);
};
export const boolArg = (a: RpcArgs, name: string, fallback: boolean | null = null) => read(a, name, fallback) as boolean | null;

/** uuid[] (o motor já converteu cada elemento). */
export const uuidArrayArg = (a: RpcArgs, name: string) => read(a, name, null) as (string | null)[] | null;

/** date (o motor já validou o formato). */
export const dateOrInfinity = (a: RpcArgs, name: string) => read(a, name, null) as string | null;
