// Dados do estabelecimento da área: nome fantasia, CPF ou CNPJ, endereço,
// telefone e rodapé. Ficam nas configurações da área (chave "establishment"),
// editados em Gestão; módulos leem por ctx.establishment(), as páginas do
// passo web mostram no cabeçalho e no rodapé, e os aplicativos leem em
// GET /api/v1/profiles/:profile/establishment (cupom, comanda, recibo).
import { cachedOne, PROFILE_SETTINGS_SQL } from "./db";
import { ApiError, json, requireValue, type Env } from "./types";

export interface EstablishmentSettings {
  name: string;
  /** Só dígitos (CPF) ou 12 caracteres alfanuméricos + 2 dígitos (CNPJ). */
  document: string;
  address: string;
  phone: string;
  footer: string;
}

export interface Establishment extends EstablishmentSettings {
  document_type: "cpf" | "cnpj" | null;
  /** Documento com pontuação (000.000.000-00, 00.000.000/0000-00). */
  document_display: string;
  /** Falso enquanto ninguém preencheu: `name` vem do nome da área. */
  configured: boolean;
}

const LIMITS = { name: 100, address: 300, phone: 40, footer: 500 } as const;

const empty: EstablishmentSettings = {
  name: "",
  document: "",
  address: "",
  phone: "",
  footer: "",
};

/** CPF com dígitos verificadores. */
export function validCpf(digits: string) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

/**
 * CNPJ numérico ou alfanumérico (Receita Federal, a partir de julho de 2026):
 * 12 caracteres [0-9A-Z] e 2 dígitos verificadores; cada caractere vale o
 * código ASCII menos 48.
 */
export function validCnpj(value: string) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value))
    return false;
  const check = (len: number) => {
    const weights =
      len === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++)
      sum += (value.charCodeAt(i) - 48) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(value[12]) && check(13) === Number(value[13]);
}

export function documentType(document: string): "cpf" | "cnpj" | null {
  return document.length === 11
    ? "cpf"
    : document.length === 14
      ? "cnpj"
      : null;
}

export function formatDocument(document: string) {
  if (document.length === 11)
    return document.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (document.length === 14)
    return document.replace(
      /^(.{2})(.{3})(.{3})(.{4})(.{2})$/,
      "$1.$2.$3/$4-$5",
    );
  return document;
}

/** Validação da chave "establishment" de PUT /settings. */
export function validateEstablishment(value: unknown): EstablishmentSettings {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Dados do estabelecimento inválidos.",
  );
  const data = value as Record<string, unknown>;
  const out = { ...empty };
  for (const key of ["name", "address", "phone", "footer"] as const) {
    const raw = data[key] ?? "";
    requireValue(
      typeof raw === "string",
      `Estabelecimento: ${key} deve ser texto.`,
    );
    const text = (raw as string).replace(/\r\n/g, "\n").trim();
    requireValue(
      Array.from(text).length <= LIMITS[key],
      {
        name: "Nome fantasia: até 100 caracteres.",
        address: "Endereço: até 300 caracteres.",
        phone: "Telefone: até 40 caracteres.",
        footer: "Rodapé: até 500 caracteres.",
      }[key],
    );
    out[key] = text;
  }
  requireValue(
    !/\n/.test(out.name) && !/\n/.test(out.phone),
    "Nome fantasia e telefone ficam numa linha só.",
  );
  const rawDocument = data.document ?? "";
  requireValue(typeof rawDocument === "string", "CPF ou CNPJ inválido.");
  const document = (rawDocument as string)
    .toUpperCase()
    .replace(/[\s./-]/g, "");
  if (document)
    requireValue(
      document.length === 11 ? validCpf(document) : validCnpj(document),
      "CPF ou CNPJ inválido: confira os números.",
    );
  out.document = document;
  return out;
}

/** Dados resolvidos da área, como módulos, páginas e aplicativos os usam. */
export async function establishment(
  env: Env,
  profile: string,
): Promise<Establishment> {
  // A mesma leitura das configurações (service.ts, settings): uma entrada só
  // no cache da requisição.
  const row = await cachedOne(env, PROFILE_SETTINGS_SQL, profile);
  if (!row)
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const saved: Partial<EstablishmentSettings> =
    json(row.settings).establishment || {};
  const data = { ...empty, ...saved };
  const configured = Object.values(data).some(Boolean);
  return {
    ...data,
    name: data.name || row.name,
    document_type: documentType(data.document),
    document_display: formatDocument(data.document),
    configured,
  };
}
