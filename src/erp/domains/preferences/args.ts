// Argumentos dos RPCs de preferências, plataforma, home e anexos. O motor
// (engine/args.ts, no callRpc) já resolveu nomes, tipos e DEFAULTs; aqui só
// se lê. O jsonb chega decodificado ou como texto JSON (pela rota).
import { raise } from "../../engine/errors.ts";
import type { RpcArgs } from "../../engine/registry.ts";

const read = (a: RpcArgs, name: string) => (a[name] === undefined ? null : a[name]);

export const uuid = (a: RpcArgs, name: string) => read(a, name) as string | null;
export const text = (a: RpcArgs, name: string) => read(a, name) as string | null;
export const int = (a: RpcArgs, name: string) => {
  const v = read(a, name);
  return v === null ? null : Number(v);
};
export const bool = (a: RpcArgs, name: string) => read(a, name) as boolean | null;
export const date = (a: RpcArgs, name: string) => read(a, name) as string | null;

/** jsonb: objeto decodificado ou texto JSON; null do JSON fica como o valor null. */
export function json(a: RpcArgs, name: string): unknown {
  const v = a[name];
  if (v === undefined || v === null) return v === null ? null : null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      raise("22P02", "invalid input syntax for type json");
    }
  }
  return v;
}

/** O argumento jsonb veio (mesmo que seja o null do JSON)? SQL NULL e ausente: não. */
export const jsonGiven = (a: RpcArgs, name: string) => a[name] !== undefined && a[name] !== null;
