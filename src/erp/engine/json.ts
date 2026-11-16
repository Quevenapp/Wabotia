// Texto canônico do jsonb do Postgres (jsonb::text), para hashes de pedido
// iguais aos do Fagoo (sha256(jsonb_build_object(…)::text)):
// - chaves ordenadas por tamanho e depois por bytes (UTF-8), sem repetição;
// - separadores ", " e ": ";
// - texto com os escapes do Postgres (\" \\ \b \f \n \r \t e \u00XX).

const encoder = new TextEncoder();

function compareKeys(a: string, b: string) {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function text(value: string) {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** Número JSON como o numeric do jsonb o imprime (inteiros e decimais simples). */
function number(value: number) {
  if (!Number.isFinite(value)) throw new RangeError("Número inválido no JSON.");
  return Number.isInteger(value) ? BigInt(value).toString() : String(value);
}

export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return number(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(jsonbText).join(", ") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort(compareKeys);
    return (
      "{" +
      keys.map((k) => `${text(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`).join(", ") +
      "}"
    );
  }
  throw new TypeError(`Valor sem tradução para jsonb: ${typeof value}`);
}

/** jsonb_typeof */
export function jsonType(value: unknown) {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}
