import { ApiError, requireValue } from "../../../types";
import type { CreateEntryRequest } from "../contracts";

export const ENTRY_LIMIT = 10_000;
export const ENTRY_FIELDS = [
  "kind", "text", "quantity_milli", "unit", "occurred_at",
  "client_visible", "sensitive",
] as const;

export function objectInput(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "Corpo inválido.");
  return value as Record<string, unknown>;
}

export function onlyFields(data: Record<string, unknown>, fields: readonly string[]) {
  for (const key of Object.keys(data))
    if (!fields.includes(key))
      throw new ApiError(400, "invalid_entry", "Campo não permitido no lançamento.");
}

function entryText(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== "string")
    throw new ApiError(400, "invalid_entry", `${field}: texto obrigatório.`);
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < min || length > max || text.includes("\u0000"))
    throw new ApiError(400, "invalid_entry", `${field}: tamanho inválido.`);
  return text;
}

export const validInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) &&
  value >= 0 && value <= 8_640_000_000_000_000;

export function entryInput(data: Record<string, unknown>): Required<CreateEntryRequest> {
  const kind = entryText(data.kind, "kind", 64);
  const text = entryText(data.text, "text", 4000);
  const unit = entryText(data.unit === undefined ? "" : data.unit, "unit", 32, 0);
  const quantity = data.quantity_milli ?? null;
  if (quantity !== null &&
      (typeof quantity !== "number" || !Number.isSafeInteger(quantity) ||
       quantity < 0 || quantity > 1_000_000_000_000))
    throw new ApiError(400, "invalid_entry", "quantity_milli: inteiro entre 0 e 1000000000000.");
  if (!validInstant(data.occurred_at))
    throw new ApiError(400, "invalid_entry", "occurred_at: instante inválido em milissegundos.");
  if (typeof data.client_visible !== "boolean" || typeof data.sensitive !== "boolean")
    throw new ApiError(400, "invalid_entry", "client_visible e sensitive: booleanos obrigatórios.");
  if (data.sensitive && data.client_visible)
    throw new ApiError(400, "invalid_entry", "Lançamento sensível não pode ser visível ao cliente.");
  return { kind, text, unit, quantity_milli: quantity, occurred_at: data.occurred_at,
    client_visible: data.client_visible, sensitive: data.sensitive };
}

export function entryVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < 1 || value >= Number.MAX_SAFE_INTEGER)
    throw new ApiError(400, "invalid_entry", "version: inteiro positivo obrigatório.");
  return value;
}

export function entryId(value: unknown): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 200, "ID obrigatório.");
  return value as string;
}

export interface EntryFilters {
  kind: string | null;
  include_archived: boolean;
  limit: number;
}

export function entryFilters(query: Record<string, string>, customer = false): EntryFilters {
  const allowed = customer ? ["cursor", "limit"] : ["kind", "include_archived", "cursor", "limit"];
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    throw new ApiError(400, "invalid_filter", "Filtro de lançamento inválido.");
  let kind: string | null = null;
  if (query.kind !== undefined) {
    try { kind = entryText(query.kind, "kind", 64); }
    catch { throw new ApiError(400, "invalid_filter", "kind: filtro inválido."); }
  }
  if (query.include_archived !== undefined && !["0", "1"].includes(query.include_archived))
    throw new ApiError(400, "invalid_filter", "include_archived: use 0 ou 1.");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((query.limit !== undefined && !/^\d+$/.test(query.limit)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(400, "invalid_filter", "limit: inteiro entre 1 e 100.");
  return { kind, include_archived: query.include_archived === "1", limit };
}

export function encodeCursor(scope: string, occurredAt: number, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([1, scope, occurredAt, id]));
  return btoa(String.fromCharCode(...bytes));
}

export function decodeCursor(value: string | undefined, scope: string): [number, string] | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 4096) throw new Error();
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(data) || data.length !== 4 || data[0] !== 1 || data[1] !== scope ||
        !validInstant(data[2]) || typeof data[3] !== "string" || !data[3] || data[3].length > 200)
      throw new Error();
    return [data[2], data[3]];
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor de lançamentos inválido.");
  }
}
