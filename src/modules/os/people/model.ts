import { ApiError } from "../../../types";
import { phoneDigits } from "../model";
import type { CreatePersonRequest } from "../contracts";

export const PERSON_FIELDS = [
  "role", "name", "contact_id", "phone", "email", "note",
  "client_visible", "sensitive",
] as const;
export type PersonValues = Required<CreatePersonRequest>;

// F0 não declara catálogo de papéis no WorkTypeView nem documento em pessoa.
// O papel é texto validado (seção 9); documento permanece campo desconhecido.

function invalid(field: string): never {
  throw new ApiError(400, "invalid_person", `Pessoa: campo ${field} inválido.`);
}

export function personBody(value: unknown, operation: "create" | "update" | "archive") {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body");
  const data = value as Record<string, unknown>;
  const allowed: readonly string[] = operation === "create"
    ? ["id", ...PERSON_FIELDS]
    : operation === "update"
      ? ["id", "person_id", "version", ...PERSON_FIELDS]
      : ["id", "person_id", "version"];
  // Nunca repetir chaves arbitrárias: também podem carregar dados pessoais.
  if (Object.keys(data).some((key) => !allowed.includes(key))) invalid("body");
  return data;
}

export function personText(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== "string") invalid(field);
  const text = value.trim();
  if ([...text].length > max || (required && !text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    invalid(field);
  return text;
}

export function personVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)
    invalid("version");
  return value;
}

export function personValues(data: Record<string, unknown>, previous?: PersonValues): PersonValues {
  const next: PersonValues = previous ? { ...previous } : {
    role: "", name: "", contact_id: null, phone: "", email: "", note: "",
    client_visible: false, sensitive: false,
  };
  for (const [field, max, required] of [
    ["role", 64, true], ["name", 120, true], ["phone", 40, false],
    ["email", 254, false], ["note", 2000, false],
  ] as const) {
    if (Object.hasOwn(data, field) || (!previous && required))
      next[field] = personText(data[field], field, max, required);
  }
  if (Object.hasOwn(data, "contact_id"))
    next.contact_id = data.contact_id === null ? null : personText(data.contact_id, "contact_id", 100, true);
  for (const field of ["client_visible", "sensitive"] as const) {
    if (Object.hasOwn(data, field) || !previous) {
      if (typeof data[field] !== "boolean") invalid(field);
      next[field] = data[field];
    }
  }
  if (next.phone) {
    if (!/^[+\d\s().-]+$/u.test(next.phone)) invalid("phone");
    next.phone = phoneDigits(next.phone);
    if (!/^\d{10,15}$/.test(next.phone)) invalid("phone");
  }
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(next.email)) invalid("email");
  if (next.sensitive && next.client_visible) invalid("client_visible");
  return next;
}
