// Argumentos dos RPCs do catálogo como o Postgres os recebe: o tipo do
// parâmetro falha antes do corpo da função (22P02, 22003, 22007, 22008) e o
// argumento omitido toma o DEFAULT da assinatura.
import { raise } from "../../engine/errors.ts";
import type { RpcArgs } from "../../engine/registry.ts";
import { dateArgError } from "../../engine/time.ts";

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const INT = /^\s*[-+]?\d+\s*$/;

const given = (a: RpcArgs, name: string) => Object.prototype.hasOwnProperty.call(a, name);

/** uuid: canônico em minúsculas com hífens; inválido → 22P02. */
export function uuidArg(a: RpcArgs, name: string, fallback: string | null = null): string | null {
  const value = given(a, name) ? a[name] : fallback;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (typeof value !== "string" || !UUID.test(text)) raise("22P02", `invalid input syntax for type uuid: "${String(value)}"`);
  const hex = text.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** integer (int4): fora do formato → 22P02; fora da faixa → 22003. */
export function intArg(a: RpcArgs, name: string, fallback: number | null = null): number | null {
  const value = given(a, name) ? a[name] : fallback;
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!(typeof value === "number" || typeof value === "string") || !INT.test(text))
    raise("22P02", `invalid input syntax for type integer: "${text}"`);
  const n = BigInt(text.trim());
  if (n < -2147483648n || n > 2147483647n) raise("22003", `value "${text}" is out of range for type integer`);
  return Number(n);
}

/** text */
export function textArg(a: RpcArgs, name: string, fallback: string | null = null): string | null {
  const value = given(a, name) ? a[name] : fallback;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** boolean */
export function boolArg(a: RpcArgs, name: string, fallback: boolean | null = null): boolean | null {
  const value = given(a, name) ? a[name] : fallback;
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const t = String(value).trim().toLowerCase();
  if (["t", "true", "y", "yes", "on", "1"].includes(t)) return true;
  if (["f", "false", "n", "no", "off", "0"].includes(t)) return false;
  raise("22P02", `invalid input syntax for type boolean: "${String(value)}"`);
}

/** date: AAAA-MM-DD; formato errado → 22007; data inexistente → 22008. */
export function dateArg(a: RpcArgs, name: string, fallback: string | null = null): string | null {
  const value = given(a, name) ? a[name] : fallback;
  if (value === null || value === undefined) return null;
  const bad = dateArgError(String(value));
  if (bad) raise(bad.code, bad.message);
  return String(value);
}

/** jsonb: objeto já decodificado ou texto JSON (como chega pela rota). */
export function jsonArg(a: RpcArgs, name: string, fallback: unknown = null): unknown {
  const value = given(a, name) ? a[name] : fallback;
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
