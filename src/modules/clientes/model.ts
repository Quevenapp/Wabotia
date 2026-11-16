// Cadastro de clientes: regras puras (validação, máscara, regras da área e
// prazo de guarda fiscal). Sem banco: testável direto.
import { requireValue, type Actor } from "../../types";
import { formatDocument, validCnpj, validCpf } from "../../establishment";
import { isBound } from "../../visibility";

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS",
  "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC",
  "SE", "SP", "TO",
] as const;

/** Campos de endereço da ficha (destinatário da nota). */
export const ADDRESS_FIELDS = [
  "cep",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "city_ibge",
  "uf",
] as const;

// ---------------------------------------------------------------------------
// Regras da área (chave "clientes" de PUT /settings)

export interface ClientesSettings {
  /**
   * Quem da equipe revela dados sem máscara: "admin" (só administradores)
   * ou "team" (qualquer pessoa da área). Sempre com motivo e auditoria.
   * Aplicações: só com contacts:read.
   */
  reveal: "admin" | "team";
  /** Texto do aceite no formulário do cliente. */
  consent_text: string;
  /** Versão do texto do aceite (muda quando o texto muda). */
  terms_version: string;
  /** CPF ou CNPJ obrigatório no autocadastro. */
  require_document: boolean;
  /** Endereço completo obrigatório no autocadastro (NF-e exige). */
  require_address: boolean;
  /** Palavras que pedem a exclusão dos dados pela conversa. */
  erase_keywords: string[];
  /** Palavras que enviam o link do cadastro pela conversa. */
  register_keywords: string[];
  /**
   * Anos de guarda das notas, contados a partir de 1º de janeiro do ano
   * seguinte ao da emissão (CTN, art. 173, I). Mínimo 5.
   */
  fiscal_retention_years: number;
}

export const CLIENTES_DEFAULTS: ClientesSettings = {
  reveal: "admin",
  consent_text:
    "Autorizo o uso destes dados para meu cadastro, emissão de notas fiscais e o meu atendimento. Posso corrigir ou pedir a exclusão a qualquer momento pelo WhatsApp.",
  terms_version: "1",
  require_document: true,
  require_address: false,
  erase_keywords: ["EXCLUIR MEUS DADOS", "APAGAR MEUS DADOS"],
  register_keywords: ["MEU CADASTRO"],
  fiscal_retention_years: 5,
};

export const normalizeKeyword = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

function keywords(value: unknown, what: string) {
  requireValue(
    Array.isArray(value) && value.length <= 10,
    `${what}: lista de até 10 palavras.`,
  );
  const out = (value as unknown[]).map((k) => normalizeKeyword(k));
  requireValue(
    out.every((k) => k.length >= 3 && k.length <= 40),
    `${what}: cada uma de 3 a 40 caracteres.`,
  );
  return [...new Set(out)];
}

export function validateClientesSettings(value: unknown): ClientesSettings {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Regras do cadastro inválidas.",
  );
  const v = { ...CLIENTES_DEFAULTS, ...(value as any) };
  requireValue(
    ["admin", "team"].includes(v.reveal),
    "Quem revela: use admin ou team.",
  );
  const consent = String(v.consent_text ?? "").trim();
  requireValue(
    consent.length >= 20 && consent.length <= 1000,
    "Texto do aceite: de 20 a 1000 caracteres.",
  );
  const version = String(v.terms_version ?? "").trim();
  requireValue(
    /^[\w.-]{1,20}$/.test(version),
    "Versão do aceite: até 20 letras, números, ponto ou hífen.",
  );
  const years = Number(v.fiscal_retention_years);
  requireValue(
    Number.isInteger(years) && years >= 5 && years <= 10,
    "Guarda fiscal: de 5 a 10 anos (o mínimo legal é 5).",
  );
  const erase = keywords(v.erase_keywords, "Palavras de exclusão");
  requireValue(erase.length >= 1, "Informe ao menos uma palavra de exclusão.");
  return {
    reveal: v.reveal,
    consent_text: consent,
    terms_version: version,
    require_document: v.require_document !== false,
    require_address: v.require_address === true,
    erase_keywords: erase,
    register_keywords: keywords(v.register_keywords, "Palavras de cadastro"),
    fiscal_retention_years: years,
  };
}

export const clientesSettings = (all: any): ClientesSettings => ({
  ...CLIENTES_DEFAULTS,
  ...(all?.clientes || {}),
});

// ---------------------------------------------------------------------------
// Campos

export function text(
  value: unknown,
  max: number,
  what: string,
  required = false,
): string {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).replace(/\s+/g, " ").trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
}

/** CPF ou CNPJ (numérico ou alfanumérico) normalizado, ou null. */
export function parseDocument(value: unknown) {
  if (typeof value !== "string") return null;
  const document = value.toUpperCase().replace(/[\s./-]/g, "");
  if (document.length === 11 && validCpf(document))
    return { document, type: "cpf" as const };
  if (document.length === 14 && validCnpj(document))
    return { document, type: "cnpj" as const };
  return null;
}

export function requireDocument(value: unknown) {
  const parsed = parseDocument(value);
  requireValue(parsed, "CPF ou CNPJ inválido: confira os números.");
  return parsed!;
}

/** Só dígitos; com DDD e sem DDI (10 ou 11 dígitos), recebe o 55. */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}

export function validPhone(value: unknown) {
  const phone = phoneDigits(text(value, 40, "o telefone", true));
  requireValue(
    phone.length >= 12 && phone.length <= 15,
    "Telefone inválido: informe com DDD.",
  );
  return phone;
}

export function validEmail(value: unknown) {
  const email = text(value, 200, "o e-mail").toLowerCase();
  requireValue(
    !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    "E-mail inválido.",
  );
  return email;
}

export function validCep(value: unknown) {
  const cep = String(value ?? "").replace(/\D/g, "");
  requireValue(!cep || cep.length === 8, "CEP: 8 dígitos.");
  return cep;
}

export function validUf(value: unknown) {
  const uf = String(value ?? "")
    .trim()
    .toUpperCase();
  requireValue(
    !uf || (UFS as readonly string[]).includes(uf),
    "UF inválida: use a sigla do estado (SP, RJ…).",
  );
  return uf;
}

export function validIbge(value: unknown) {
  const code = String(value ?? "").replace(/\D/g, "");
  requireValue(
    !code || /^[1-5]\d{6}$/.test(code),
    "Código IBGE do município: 7 dígitos.",
  );
  return code;
}

/** Inscrição estadual: dígitos (ou ISENTO, que vira indicador 2). */
export function validIe(value: unknown) {
  const raw = text(value, 20, "a inscrição estadual").toUpperCase();
  if (raw === "ISENTO" || raw === "ISENTA") return { ie: "", isento: true };
  const ie = raw.replace(/[\s./-]/g, "");
  requireValue(
    !ie || /^[0-9A-Z]{2,14}$/.test(ie),
    "Inscrição estadual inválida.",
  );
  return { ie, isento: false };
}

export function validIeIndicator(value: unknown) {
  const v = String(value ?? "9");
  requireValue(
    ["1", "2", "9"].includes(v),
    "Indicador da IE: 1 (contribuinte), 2 (isento) ou 9 (não contribuinte).",
  );
  return v;
}

export function searchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Máscara

const STAR = "•";
const stars = (n: number) => STAR.repeat(Math.max(1, n));

/** CPF: •••.982.247-•• (meio visível, como no Portal da Transparência). */
export function maskCpf(document: string) {
  return `${stars(3)}.${document.slice(3, 6)}.${document.slice(6, 9)}-${stars(2)}`;
}
/** CNPJ de pessoa física: só filial e verificadores visíveis. */
export function maskCnpj(document: string) {
  return `${stars(2)}.${stars(3)}.${stars(3)}/${document.slice(8, 12)}-${document.slice(12)}`;
}
export function maskPhone(phone: string) {
  if (phone.length < 6) return stars(phone.length);
  const ddi = phone.startsWith("55") ? "+55 " : "+";
  const rest = phone.startsWith("55") ? phone.slice(2) : phone;
  return `${ddi}(${rest.slice(0, 2)}) ${stars(rest.length - 6)}-${rest.slice(-4)}`;
}
export function maskEmail(email: string) {
  if (!email) return "";
  const [user, domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${user.slice(0, 1)}${stars(3)}@${host.slice(0, 1)}${stars(3)}${tld}`;
}
const maskText = (value: string) => (value ? stars(3) : "");

/** Quem é pessoa natural na ficha: CPF e IE/CNPJ de empresário individual. */
export const personal = (row: any) =>
  row.kind === "pf" || !!row.individual_business;

export function documentDisplay(row: any, masked: boolean) {
  if (!row.document) return null;
  if (!masked) return formatDocument(row.document);
  if (row.document_type === "cpf") return maskCpf(row.document);
  return row.individual_business
    ? maskCnpj(row.document)
    : formatDocument(row.document);
}

export function addressView(row: any, masked: boolean) {
  const address: Record<string, string> = {};
  for (const key of ADDRESS_FIELDS) address[key] = row[key] || "";
  if (!masked) return address;
  return {
    ...address,
    cep: address.cep ? address.cep.slice(0, 2) + stars(3) + "-" + stars(3) : "",
    street: maskText(address.street),
    number: maskText(address.number),
    complement: maskText(address.complement),
    district: maskText(address.district),
  };
}

/** Campos que a revelação mostra (e que a máscara esconde). */
export const REVEAL_FIELDS = [
  "document",
  "email",
  "phones",
  "address",
  "ie",
  "im",
] as const;
export type RevealField = (typeof REVEAL_FIELDS)[number];

/**
 * Quem pode revelar: administrador; pessoa da equipe se a regra da área for
 * "team"; aplicação com contacts:read (chave presa à conversa, nunca).
 */
export function canReveal(actor: Actor, settings: ClientesSettings) {
  if (actor.kind === "app")
    return actor.scopes.includes("contacts:read") && !isBound(actor);
  if (actor.kind !== "user") return false;
  return actor.role === "admin" || settings.reveal === "team";
}

// ---------------------------------------------------------------------------
// Guarda fiscal

const BRASILIA_OFFSET = 3 * 3600000;

/**
 * Fim da guarda de uma nota emitida em `issuedAt`: 1º de janeiro do ano
 * seguinte ao da emissão mais `years` anos (CTN, art. 173, I, e art. 195,
 * parágrafo único), à meia-noite de Brasília.
 */
export function fiscalRetentionUntil(issuedAt: number, years = 5) {
  const year = new Date(issuedAt - BRASILIA_OFFSET).getUTCFullYear();
  return Date.UTC(year + 1 + years, 0, 1) + BRASILIA_OFFSET;
}

/** Destinatário no formato do FiscalProvider de Vendas (recipient). */
export function fiscalRecipient(row: any) {
  const hasAddress = !!(row.street && row.city_ibge && row.uf && row.cep);
  return {
    document: row.document || "",
    document_type: row.document_type || null,
    name: row.name,
    trade_name: row.trade_name || "",
    ie: row.ie || "",
    ie_indicator: row.ie_indicator || "9",
    im: row.im || "",
    email: row.email || "",
    address: hasAddress
      ? {
          street: row.street,
          number: row.number || "S/N",
          complement: row.complement || "",
          district: row.district || "",
          city: row.city || "",
          city_code: row.city_ibge,
          uf: row.uf,
          cep: row.cep,
          country_code: row.country_code || "1058",
        }
      : null,
  };
}
