// Dados do estabelecimento da área: nome fantasia, CPF ou CNPJ, endereço
// (texto livre e, opcional, os campos separados com a posição da loja),
// telefone e rodapé. Ficam nas configurações da área (chave "establishment"),
// editados em Gestão; módulos leem por ctx.establishment(), as páginas do
// passo web mostram no cabeçalho e no rodapé, e os aplicativos leem em
// GET /api/v1/profiles/:profile/establishment (cupom, comanda, recibo).
import { cachedOne, PROFILE_SETTINGS_SQL } from "./db";
import { ApiError, json, requireValue, type Env } from "./types";

/**
 * Endereço estruturado, opcional, com os nomes e formatos do endereço da
 * Empresa do ERP (erp_company, normalize_identity): a projeção ERP →
 * Estabelecimento copia direto. Vazio ("") onde não há.
 */
export interface EstablishmentAddress {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  /** UF, duas letras maiúsculas. */
  state: string;
  /** CEP, só os 8 dígitos. */
  postal_code: string;
  /** Código IBGE do município (7 dígitos; os 2 primeiros são os da UF). */
  municipality_code: string;
}

export interface EstablishmentSettings extends EstablishmentAddress {
  name: string;
  /** Só dígitos (CPF) ou 12 caracteres alfanuméricos + 2 dígitos (CNPJ). */
  document: string;
  /** Endereço em texto livre (o de sempre). */
  address: string;
  phone: string;
  footer: string;
  /** Posição da loja (os dois ou nenhum): referência para achar endereços perto dela. */
  latitude: number | null;
  longitude: number | null;
}

export interface Establishment extends EstablishmentSettings {
  /**
   * Endereço para ler (cupom, páginas, módulos): montado dos campos quando
   * rua e cidade estão preenchidas; senão, o texto livre gravado.
   */
  address: string;
  /** O texto livre gravado, como está (o que a tela de Gestão edita). */
  address_free: string;
  /** Posição da loja, ou null. */
  position: { lat: number; lng: number } | null;
  document_type: "cpf" | "cnpj" | null;
  /** Documento com pontuação (000.000.000-00, 00.000.000/0000-00). */
  document_display: string;
  /** Falso enquanto ninguém preencheu: `name` vem do nome da área. */
  configured: boolean;
}

const LIMITS = { name: 100, address: 300, phone: 40, footer: 500 } as const;
/** Limites do endereço da Empresa do ERP (erp_company). */
const ADDRESS_LIMITS = {
  street: 200,
  number: 30,
  complement: 200,
  district: 100,
  city: 100,
} as const;

/** UFs e o código IBGE de cada uma (os 2 primeiros dígitos do município). */
export const UF_CODES: Record<string, string> = {
  RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22",
  CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32",
  RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50", MT: "51", GO: "52", DF: "53",
};

const empty: EstablishmentSettings = {
  name: "",
  document: "",
  address: "",
  phone: "",
  footer: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
  postal_code: "",
  municipality_code: "",
  latitude: null,
  longitude: null,
};

/**
 * "Rua X, 200, Apto 2 - Bairro, Cidade/UF, CEP 00000-000": o endereço montado
 * dos campos, ou "" sem rua e cidade.
 */
export function composeAddress(a: Partial<EstablishmentAddress>) {
  if (!a.street || !a.city) return "";
  const head = [a.street, a.number, a.complement].filter(Boolean).join(", ");
  const place = a.state ? `${a.city}/${a.state}` : a.city;
  const cep = a.postal_code ? `CEP ${a.postal_code.slice(0, 5)}-${a.postal_code.slice(5)}` : "";
  return [a.district ? `${head} - ${a.district}` : head, place, cep].filter(Boolean).join(", ");
}

const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

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
  // Endereço estruturado (opcional), nos formatos da Empresa do ERP.
  for (const key of Object.keys(ADDRESS_LIMITS) as (keyof typeof ADDRESS_LIMITS)[]) {
    const raw = data[key] ?? "";
    requireValue(typeof raw === "string", `Estabelecimento: ${key} deve ser texto.`);
    const text = (raw as string).trim();
    requireValue(
      Array.from(text).length <= ADDRESS_LIMITS[key] && !/[\u0000-\u001f]/.test(text),
      `Endereço, ${key}: até ${ADDRESS_LIMITS[key]} caracteres, numa linha.`,
    );
    out[key] = text;
  }
  const text = (key: string) => {
    const raw = data[key] ?? "";
    requireValue(typeof raw === "string", `Estabelecimento: ${key} deve ser texto.`);
    return (raw as string).trim();
  };
  out.state = text("state").toUpperCase();
  requireValue(!out.state || out.state in UF_CODES, "UF: use a sigla do estado (SP, RJ…).");
  out.postal_code = text("postal_code").replace(/[\s.-]/g, "");
  requireValue(
    !out.postal_code || (/^\d{8}$/.test(out.postal_code) && out.postal_code !== "00000000"),
    "CEP: 8 dígitos.",
  );
  out.municipality_code = text("municipality_code");
  if (out.municipality_code)
    requireValue(
      /^\d{7}$/.test(out.municipality_code) &&
        !!out.state &&
        out.municipality_code.slice(0, 2) === UF_CODES[out.state],
      "Código IBGE do município: 7 dígitos, da UF informada.",
    );
  const lat = data.latitude ?? null,
    lng = data.longitude ?? null;
  if (lat !== null || lng !== null) {
    requireValue(
      finite(lat, -90, 90) && finite(lng, -180, 180),
      "Posição da loja: latitude (-90 a 90) e longitude (-180 a 180), as duas.",
    );
    out.latitude = lat;
    out.longitude = lng;
  }
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
  const position =
    finite(data.latitude, -90, 90) && finite(data.longitude, -180, 180)
      ? { lat: data.latitude, lng: data.longitude }
      : null;
  return {
    ...data,
    // O texto livre continua gravado como está; o montado é só leitura.
    address: composeAddress(data) || data.address,
    address_free: data.address,
    position,
    name: data.name || row.name,
    document_type: documentType(data.document),
    document_display: formatDocument(data.document),
    configured,
  };
}
