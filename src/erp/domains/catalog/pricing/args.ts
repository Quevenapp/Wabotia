// Argumentos das listas de preço que o args.ts do catálogo não cobre: uuid[]
// e date com 'infinity' (o Postgres aceita; o RPC recusa com 22023).
import { raise } from "../../../engine/errors.ts";
import type { RpcArgs } from "../../../engine/registry.ts";
import { dateArgError } from "../../../engine/time.ts";
import { uuidArg } from "../args.ts";

const given = (a: RpcArgs, name: string) => Object.prototype.hasOwnProperty.call(a, name);

/** uuid[]: cada elemento como uuid (22P02); null fica null. */
export function uuidArrayArg(a: RpcArgs, name: string): (string | null)[] | null {
  const value = given(a, name) ? a[name] : null;
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) raise("22P02", `malformed array literal: "${String(value)}"`);
  return value.map((v, i) => uuidArg({ [String(i)]: v }, String(i)));
}

/** date que aceita ±infinity (devolve o texto; quem chama recusa). */
export function dateOrInfinity(a: RpcArgs, name: string): string | null {
  const value = given(a, name) ? a[name] : null;
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (text === "infinity" || text === "-infinity") return text;
  const bad = dateArgError(String(value));
  if (bad) raise(bad.code, bad.message);
  return String(value);
}
