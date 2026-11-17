// Argumentos dos RPCs do CNAB. O motor (engine/args.ts, no callRpc) já
// resolveu nomes, tipos e DEFAULTs; aqui só se lê.
import type { RpcArgs } from "../../engine/registry.ts";

const read = (a: RpcArgs, name: string) => (a[name] === undefined ? null : a[name]);
export const uuid = (a: RpcArgs, name: string) => read(a, name) as string | null;
export const text = (a: RpcArgs, name: string) => read(a, name) as string | null;
export const date = (a: RpcArgs, name: string) => read(a, name) as string | null;
export const bool = (a: RpcArgs, name: string) => read(a, name) as boolean | null;
export const int = (a: RpcArgs, name: string) => {
  const v = read(a, name);
  return v === null ? null : Number(v);
};
export const textArray = (a: RpcArgs, name: string) => read(a, name) as (string | null)[] | null;
