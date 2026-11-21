// Lojas: contas puras (sem banco), usadas pelo motor e pelos testes.
import { raise } from "../../engine/errors.ts";

/** Campos do endereço da loja (os mesmos nomes do cadastro da empresa). */
export const ADDRESS_KEYS = ["postal_code", "street", "number", "complement", "district", "city", "state"] as const;
const ADDRESS_MAX: Record<(typeof ADDRESS_KEYS)[number], number> = { postal_code: 8, street: 120, number: 20, complement: 80, district: 80, city: 80, state: 2 };
const UF = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/;

/** Operações que a lista por loja mostra. */
export const OPERATION_KINDS = ["sales_orders", "sales_proposals", "purchase_orders", "titles", "stock_moves", "pos_sales"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

const bad = (code: string): never => raise("22023", code);

/**
 * Endereço limpo: só os campos conhecidos, texto aparado, CEP em dígitos e UF
 * em maiúsculas. `lenient` (dados vindos da empresa) descarta o que não
 * confere em vez de recusar.
 */
export function cleanAddress(value: unknown, lenient = false): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return lenient ? {} : bad("erp_store_address_invalid");
  const v = value as Record<string, unknown>;
  if (!lenient && Object.keys(v).some((k) => !(ADDRESS_KEYS as readonly string[]).includes(k))) bad("erp_store_address_invalid");
  const out: Record<string, string> = {};
  for (const k of ADDRESS_KEYS) {
    const raw = v[k];
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw !== "string") { if (lenient) continue; bad("erp_store_address_invalid"); }
    let t = (raw as string).trim().replace(/\s+/g, " ");
    if (k === "postal_code") t = t.replace(/\D/g, "");
    if (k === "state") t = t.toUpperCase();
    const ok = t !== "" && [...t].length <= ADDRESS_MAX[k] && !/[\u0000-\u001f\u007f]/.test(t) &&
      (k !== "postal_code" || /^\d{8}$/.test(t)) && (k !== "state" || UF.test(t));
    if (!ok) { if (lenient) continue; bad(k === "postal_code" ? "erp_store_postal_code_invalid" : k === "state" ? "erp_store_state_invalid" : "erp_store_address_invalid"); }
    out[k] = t;
  }
  return out;
}

/** Telefone em dígitos (8 a 20); vazio = sem telefone. */
export function cleanPhone(value: unknown, lenient = false): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return lenient ? null : bad("erp_store_phone_invalid");
  const d = String(value).replace(/\D/g, "");
  if (d.length < 8 || d.length > 20) return lenient ? null : bad("erp_store_phone_invalid");
  return d;
}

/** Dígito verificador do CNPJ (também o alfanumérico: cada caractere vale o código ASCII menos 48). */
export function cnpjValid(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const values = [...cnpj].map((c) => c.charCodeAt(0) - 48);
  const digit = (n: number) => {
    const weights = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((t, w, i) => t + w * values[i], 0) % 11;
    return sum < 2 ? 0 : 11 - sum;
  };
  return digit(12) === values[12] && digit(13) === values[13];
}

/** CNPJ da filial: só os caracteres, conferido; vazio = usa o da empresa. */
export function cleanCnpj(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return bad("erp_store_cnpj_invalid");
  const c = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!cnpjValid(c)) bad("erp_store_cnpj_invalid");
  return c;
}
