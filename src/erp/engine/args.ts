// O que o Postgres faz com os argumentos antes do corpo de um RPC, a partir
// das assinaturas do oráculo (signatures.generated.ts):
// - resolução por nome: argumento desconhecido ou obrigatório faltando → 42883;
// - conversão de tipo, na ordem em que os argumentos vieram (a ordem dos $n
//   da chamada): uuid, integer, bigint, boolean, date e os vetores;
// - DEFAULT do argumento omitido (null explícito continua null).
// O corpo recebe os valores já convertidos: uuid canônico em minúsculas,
// integer como number, bigint como number (ou bigint além de 2^53), boolean
// como boolean. text, jsonb e timestamptz passam como vieram (text de valor
// não texto vira o texto do valor, como o cliente do Postgres manda).
import { ErpError } from "./errors.ts";
import { dateArgError } from "./time.ts";
import { SIGNATURES, type ArgSpec } from "./signatures.generated.ts";
import type { RpcArgs } from "./registry.ts";

/** Texto com que o valor chega ao Postgres (o cliente serializa assim). */
function asText(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

const invalid = (type: string, text: string): never => {
  throw new ErpError("22P02", `invalid input syntax for type ${type}: "${text}"`);
};

const HEX = /^[0-9a-fA-F]{2}$/;
/** uuid_in: chaves opcionais em volta, hífen opcional depois de cada grupo de 4 dígitos (menos o último). */
export function uuidIn(text: string): string {
  let i = 0;
  const braces = text[0] === "{";
  if (braces) i++;
  let hex = "";
  for (let byte = 0; byte < 16; byte++) {
    const pair = text.slice(i, i + 2);
    if (!HEX.test(pair)) invalid("uuid", text);
    hex += pair;
    i += 2;
    if (text[i] === "-" && byte % 2 === 1 && byte < 15) i++;
  }
  if (braces) {
    if (text[i] !== "}") invalid("uuid", text);
    i++;
  }
  if (i !== text.length) invalid("uuid", text);
  hex = hex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// isspace do C: espaço, \t, \n, \v, \f, \r.
const INT_SYNTAX = /^[ \t\n\v\f\r]*([+-]?)(0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|[0-9](?:_?[0-9])*)[ \t\n\v\f\r]*$/;
const INT_RANGE = {
  integer: [-(2n ** 31n), 2n ** 31n - 1n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
} as const;
/** int4in/int8in do Postgres 17: sinal, decimal, 0x/0o/0b e sublinhado entre dígitos. */
export function intIn(text: string, type: "integer" | "bigint"): number | bigint {
  const m = INT_SYNTAX.exec(text);
  if (!m) invalid(type, text);
  // BigInt lê decimal com zeros à esquerda e os prefixos 0x/0o/0b (em qualquer caixa).
  const magnitude = BigInt(m![2].replace(/_/g, ""));
  const value = m![1] === "-" ? -magnitude : magnitude;
  const [min, max] = INT_RANGE[type];
  if (value < min || value > max) throw new ErpError("22003", `value "${text}" is out of range for type ${type}`);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

const TRUE_WORDS = ["true", "yes", "on", "1"],
  FALSE_WORDS = ["false", "no", "off", "0"];
/** boolin: sem espaço nas pontas, sem caixa; prefixo de true/false/yes/no, on, off (≥ "of"), 1, 0. */
export function boolIn(text: string): boolean {
  const s = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "").toLowerCase();
  const prefix = (words: string[]) =>
    words.some((w) => (w === "on" || w === "1" || w === "0" ? s === w : w === "off" ? s.length >= 2 && w.startsWith(s) : s.length >= 1 && w.startsWith(s)));
  if (s && prefix(TRUE_WORDS)) return true;
  if (s && prefix(FALSE_WORDS)) return false;
  return invalid("boolean", text);
}

function convert(type: ArgSpec[1], value: unknown): unknown {
  if (value === null) return null;
  switch (type) {
    case "u":
      return uuidIn(asText(value));
    case "i":
      return intIn(asText(value), "integer");
    case "b":
      return intIn(asText(value), "bigint");
    case "o":
      return typeof value === "boolean" ? value : boolIn(asText(value));
    case "d": {
      const text = asText(value);
      const bad = dateArgError(text);
      if (bad) throw new ErpError(bad.code, bad.message);
      return text;
    }
    case "t":
      return typeof value === "string" ? value : asText(value);
    case "U":
    case "T": {
      if (!Array.isArray(value)) throw new ErpError("22P02", `malformed array literal: "${asText(value)}"`);
      return value.map((v) => (v === null ? null : type === "U" ? uuidIn(asText(v)) : typeof v === "string" ? v : asText(v)));
    }
    default:
      return value;
  }
}

const notFound = (name: string, keys: string[]): never => {
  throw new ErpError("42883", `function public.${name}(${keys.map((k) => `${k} => unknown`).join(", ")}) does not exist`);
};

/**
 * Argumentos como o corpo do RPC os veria no Postgres. RPC sem assinatura no
 * oráculo (não deveria haver: tests/erp/signatures.test.mjs) passa como veio.
 */
export function prepareArgs(name: string, args: RpcArgs): RpcArgs {
  const signature = SIGNATURES[name];
  if (!signature) return args;
  const given = Object.keys(args).filter((k) => args[k] !== undefined);
  const specs = new Map(signature.map((s) => [s[0], s]));
  if (given.some((k) => !specs.has(k)) || signature.some((s) => s.length < 3 && !given.includes(s[0]))) notFound(name, given);
  const out: RpcArgs = {};
  for (const key of given) out[key] = convert(specs.get(key)![1], args[key]);
  for (const [key, , fallback] of signature) if (!(key in out)) out[key] = fallback;
  return out;
}
