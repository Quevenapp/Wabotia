// to_jsonb(linha) do Postgres a partir da linha do SQLite, guiado pelo codec
// de cada coluna (schema/columns.generated.ts). O valor é o que o cliente do
// Postgres entrega depois de ler o jsonb (JSON.parse): numeric vira número,
// timestamptz o texto do to_jsonb em UTC, date e time texto, bool booleano,
// jsonb e arrays o valor. As colunas que só existem no SQLite (__fold e
// calculadas) ficam de fora, como no Postgres. tests/erp/row-json.test.mjs
// confere contra o oráculo.
import { ERP_TABLES, type ColumnSpec } from "../schema/columns.generated.ts";
import { formatScaled } from "./dec.ts";
import { jsonTimestamp } from "./time.ts";

const I64_MAX = "9223372036854775807";
const I64_MIN = "-9223372036854775808";
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Um valor do SQLite na coluna `spec` → o valor do to_jsonb. */
export function valueJson(spec: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (spec.codec) {
    case "bool":
      return value === 1 || value === "1" || value === true;
    case "int":
    case "int53":
      return Number(value);
    case "dec":
    case "dec_i64":
      return Number(formatScaled(BigInt(String(value)), spec.scale!));
    case "dec_text":
      return Number(value);
    case "timestamp_us": {
      const t = String(value);
      if (t === I64_MAX) return "infinity";
      if (t === I64_MIN) return "-infinity";
      return jsonTimestamp(t);
    }
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "bytes": {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      return "\\x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    default:
      if (spec.codec.startsWith("array:")) return typeof value === "string" ? JSON.parse(value) : value;
      return String(value);
  }
}

const SKIP = new Set(["fold", "computed"]);

/** to_jsonb(t) de uma linha da tabela do SQLite ("<schema>__<tabela>"). */
export function rowJson(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const info = ERP_TABLES[table];
  if (!info) throw new Error(`Tabela desconhecida: ${table}`);
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(info.columns)) if (!SKIP.has(spec.codec)) out[name] = valueJson(spec, row[name]);
  return out;
}

/**
 * Lista de colunas para o SELECT que alimenta rowJson: inteiros de 64 bits
 * como texto (o número do driver perde precisão acima de 2^53).
 */
export function rowJsonSelect(table: string): string {
  const info = ERP_TABLES[table];
  if (!info) throw new Error(`Tabela desconhecida: ${table}`);
  return Object.entries(info.columns)
    .filter(([, spec]) => !SKIP.has(spec.codec))
    .map(([name, spec]) =>
      ["dec", "dec_i64", "int53", "timestamp_us"].includes(spec.codec) ? `CAST(${q(name)} AS TEXT) AS ${q(name)}` : q(name),
    )
    .join(", ");
}
