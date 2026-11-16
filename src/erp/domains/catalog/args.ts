// Argumentos dos RPCs do catálogo: o motor (engine/args.ts) já resolve nomes,
// tipos e DEFAULT antes do corpo. Só o jsonb passa como veio: objeto já
// decodificado ou texto JSON (como chega pela rota).
import { raise } from "../../engine/errors.ts";
import type { RpcArgs } from "../../engine/registry.ts";

/** jsonb: objeto decodificado ou texto JSON. */
export function jsonArg(a: RpcArgs, name: string): unknown {
  const value = a[name];
  if (value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      raise("22P02", "invalid input syntax for type json");
    }
  }
  return value;
}
