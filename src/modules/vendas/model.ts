// Vendas: regras puras (sem banco): validação de textos, valores, quantidades,
// códigos de barras e dados fiscais; configurações da área (chave "vendas");
// rótulos e formatos. Testável sem o Worker.
import { ApiError, requireValue } from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";
import { validCnpj, validCpf } from "../../establishment";

// ---------------------------------------------------------------------------
// Textos, valores e quantidades

export const text = (
  value: unknown,
  max: number,
  what: string,
  required = false,
): string => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
};

export const clip = (value: unknown, max: number) =>
  Array.from(String(value ?? "").trim())
    .slice(0, max)
    .join("");

export const MAX_CENTS = 100_000_000; // R$ 1.000.000,00

export const cents = (value: unknown, what: string, max = MAX_CENTS) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= max,
    `${what[0].toUpperCase()}${what.slice(1)} em centavos (inteiro de 0 a ${max.toLocaleString("pt-BR")}).`,
  );
  return value as number;
};

export const flag = (value: unknown, what: string) => {
  requireValue(typeof value === "boolean", `${what}: verdadeiro ou falso.`);
  return value as boolean;
};

export const MAX_QUANTITY = 1_000_000;

/**
 * Quantidade em milésimos: 1,5 kg → 1500. Até 3 casas decimais; inteira
 * quando o produto não é fracionado. `allowZero` para estoque mínimo.
 */
export function milli(
  value: unknown,
  what: string,
  options: { fractional?: boolean; allowZero?: boolean; signed?: boolean } = {},
) {
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  requireValue(
    typeof number === "number" && Number.isFinite(number),
    `${what}: informe um número.`,
  );
  const n = number as number;
  const scaled = Math.round(n * 1000);
  requireValue(
    Math.abs(n * 1000 - scaled) < 1e-6,
    `${what}: até 3 casas decimais.`,
  );
  requireValue(
    options.fractional !== false || scaled % 1000 === 0,
    `${what}: este produto é vendido só em quantidades inteiras.`,
  );
  requireValue(
    Math.abs(n) <= MAX_QUANTITY,
    `${what}: até ${MAX_QUANTITY.toLocaleString("pt-BR")}.`,
  );
  if (!options.signed)
    requireValue(
      options.allowZero ? scaled >= 0 : scaled > 0,
      `${what}: ${options.allowZero ? "zero ou mais" : "maior que zero"}.`,
    );
  return scaled;
}

/** 1500 → 1.5 (como a API devolve). */
export const fromMilli = (value: number) => value / 1000;

/** Preço × quantidade em milésimos, arredondado ao centavo. */
export const lineCents = (unitCents: number, quantityMilli: number) =>
  Math.round((unitCents * quantityMilli) / 1000);

export const money = (value: number) =>
  "R$ " +
  (value / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** 1500 em KG → "1,5"; 2000 em UN → "2". */
export const quantityLabel = (quantityMilli: number) =>
  (quantityMilli / 1000).toLocaleString("pt-BR", {
    maximumFractionDigits: 3,
  });

export function day(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS),
    two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}
export function dateTime(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS),
    two = (n: number) => String(n).padStart(2, "0");
  return `${day(at)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** Fim do dia (23:59:59,999 em Brasília) `days` dias depois de `at`. */
export function endOfDayAfter(at: number, days: number) {
  const DAY = 86_400_000;
  const local = at - BRASILIA_OFFSET_MS;
  return (Math.floor(local / DAY) + days + 1) * DAY - 1 + BRASILIA_OFFSET_MS;
}

/** Só dígitos, com 55 quando o número veio sem DDI (10 ou 11 dígitos). */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}

/** CPF ou CNPJ do cliente (para a nota): só dígitos/letras, validado. */
export function customerDocument(value: unknown) {
  const raw = text(value, 20, "o CPF ou CNPJ do cliente");
  if (!raw) return "";
  const clean = raw.toUpperCase().replace(/[.\-/\s]/g, "");
  requireValue(
    (clean.length === 11 && validCpf(clean)) ||
      (clean.length === 14 && validCnpj(clean)),
    "CPF ou CNPJ do cliente inválido.",
  );
  return clean;
}

// ---------------------------------------------------------------------------
// Códigos de barras (GTIN/EAN)

/** GTIN-8, 12, 13 ou 14 com dígito verificador (módulo 10, pesos 3 e 1). */
export function validGtin(value: string) {
  if (!/^(\d{8}|\d{12,14})$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

export function ean(value: unknown, what = "Código de barras (EAN)") {
  if (value === undefined || value === null || value === "") return null;
  requireValue(typeof value === "string", `${what} inválido.`);
  const clean = (value as string).replace(/\s/g, "");
  requireValue(
    validGtin(clean),
    `${what}: use 8, 12, 13 ou 14 dígitos com o dígito verificador correto.`,
  );
  return clean;
}

export function sku(value: unknown) {
  const out = text(value, 60, "o código interno (SKU)");
  requireValue(
    !out || /^[\w.\-/]+$/u.test(out),
    "Código interno (SKU): letras, números, ponto, hífen, barra e sublinhado.",
  );
  return out || null;
}

export function unit(value: unknown) {
  const out = text(value ?? "UN", 6, "a unidade", true).toUpperCase();
  requireValue(
    /^[A-Z0-9]{1,6}$/.test(out),
    "Unidade: até 6 letras ou números (UN, KG, L, M, CX…).",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Dados fiscais do produto (NF-e/NFC-e, leiaute 4.00)

export const ICMS_CST = [
  "00",
  "02",
  "10",
  "15",
  "20",
  "30",
  "40",
  "41",
  "50",
  "51",
  "53",
  "60",
  "61",
  "70",
  "90",
];
export const ICMS_CSOSN = [
  "101",
  "102",
  "103",
  "201",
  "202",
  "203",
  "300",
  "400",
  "500",
  "900",
];
const PIS_COFINS_CST = /^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$/;
const IPI_CST = /^(0[0-5]|49|5[0-5]|99)$/;

export interface ProductFiscal {
  /** Nomenclatura Comum do Mercosul, 8 dígitos. */
  ncm?: string;
  /** Código Especificador da Substituição Tributária, 7 dígitos. */
  cest?: string;
  /** CFOP de saída (5xxx dentro do estado, 6xxx fora, 7xxx exterior). */
  cfop?: string;
  /** Origem da mercadoria, 0 a 8 (0 = nacional). */
  origin?: number;
  /** CST do ICMS (regime normal). */
  icms_cst?: string;
  /** CSOSN (Simples Nacional). */
  icms_csosn?: string;
  icms_rate?: number;
  /** Percentual de redução da base de cálculo do ICMS. */
  icms_base_reduction?: number;
  fcp_rate?: number;
  pis_cst?: string;
  pis_rate?: number;
  cofins_cst?: string;
  cofins_rate?: number;
  ipi_cst?: string;
  ipi_rate?: number;
  /** Unidade tributável (uTrib) e fator: quantidade tributável = qtd × fator. */
  tax_unit?: string;
  tax_factor?: number;
  /** GTIN da unidade tributável (cEANTrib) ou "SEM GTIN". */
  tax_ean?: string;
  /** Código de benefício fiscal da UF (cBenef). */
  cbenef?: string;
  /** Reforma tributária (IBS/CBS, a partir de 2026): CST e classificação. */
  ibs_cbs_cst?: string;
  cclasstrib?: string;
}

const rate = (value: unknown, what: string) => {
  requireValue(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100 &&
      Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-6,
    `${what}: percentual de 0 a 100, até 4 casas decimais.`,
  );
  return value as number;
};

/** Valida e normaliza os campos fiscais (todos opcionais ao salvar). */
export function validateFiscal(value: unknown): ProductFiscal {
  if (value === undefined || value === null) return {};
  requireValue(
    typeof value === "object" && !Array.isArray(value),
    "Dados fiscais: envie um objeto.",
  );
  const v = value as Record<string, unknown>;
  const out: ProductFiscal = {};
  const has = (k: string) =>
    v[k] !== undefined && v[k] !== null && v[k] !== "";
  const code = (k: keyof ProductFiscal, re: RegExp, message: string) => {
    if (!has(k)) return;
    const raw = String(v[k]).replace(/[.\s]/g, "");
    requireValue(re.test(raw), message);
    (out as any)[k] = raw;
  };
  code("ncm", /^\d{8}$/, "NCM: 8 dígitos.");
  code("cest", /^\d{7}$/, "CEST: 7 dígitos.");
  code("cfop", /^[1-7]\d{3}$/, "CFOP: 4 dígitos (ex.: 5102).");
  if (has("origin")) {
    requireValue(
      Number.isInteger(v.origin) &&
        (v.origin as number) >= 0 &&
        (v.origin as number) <= 8,
      "Origem da mercadoria: de 0 a 8.",
    );
    out.origin = v.origin as number;
  }
  if (has("icms_cst")) {
    const cst = String(v.icms_cst).padStart(2, "0");
    requireValue(
      ICMS_CST.includes(cst),
      `CST do ICMS: use ${ICMS_CST.join(", ")}.`,
    );
    out.icms_cst = cst;
  }
  if (has("icms_csosn")) {
    const csosn = String(v.icms_csosn);
    requireValue(
      ICMS_CSOSN.includes(csosn),
      `CSOSN: use ${ICMS_CSOSN.join(", ")}.`,
    );
    out.icms_csosn = csosn;
  }
  for (const [k, what] of [
    ["icms_rate", "Alíquota do ICMS"],
    ["icms_base_reduction", "Redução da base do ICMS"],
    ["fcp_rate", "Alíquota do FCP"],
    ["pis_rate", "Alíquota do PIS"],
    ["cofins_rate", "Alíquota da COFINS"],
    ["ipi_rate", "Alíquota do IPI"],
  ] as const)
    if (has(k)) out[k] = rate(v[k], what);
  code("pis_cst", PIS_COFINS_CST, "CST do PIS inválido (ex.: 01, 49, 99).");
  code(
    "cofins_cst",
    PIS_COFINS_CST,
    "CST da COFINS inválido (ex.: 01, 49, 99).",
  );
  code("ipi_cst", IPI_CST, "CST do IPI inválido (ex.: 50, 53, 99).");
  if (has("tax_unit")) out.tax_unit = unit(v.tax_unit);
  if (has("tax_factor")) {
    requireValue(
      typeof v.tax_factor === "number" &&
        v.tax_factor > 0 &&
        v.tax_factor <= 100000,
      "Fator da unidade tributável: número maior que zero.",
    );
    out.tax_factor = v.tax_factor as number;
  }
  if (has("tax_ean"))
    out.tax_ean =
      String(v.tax_ean).toUpperCase() === "SEM GTIN"
        ? "SEM GTIN"
        : ean(v.tax_ean, "GTIN da unidade tributável")!;
  code(
    "cbenef",
    /^[A-Z0-9]{8}([A-Z0-9]{2})?$/,
    "Código de benefício fiscal (cBenef): 8 ou 10 letras e números.",
  );
  code("ibs_cbs_cst", /^\d{3}$/, "CST do IBS/CBS: 3 dígitos.");
  code("cclasstrib", /^\d{6}$/, "Classificação tributária (cClassTrib): 6 dígitos.");
  if (out.icms_cst && out.icms_csosn)
    throw new ApiError(
      400,
      "invalid_request",
      "Informe CST do ICMS (regime normal) ou CSOSN (Simples Nacional), não os dois.",
    );
  const known = new Set([
    "ncm",
    "cest",
    "cfop",
    "origin",
    "icms_cst",
    "icms_csosn",
    "icms_rate",
    "icms_base_reduction",
    "fcp_rate",
    "pis_cst",
    "pis_rate",
    "cofins_cst",
    "cofins_rate",
    "ipi_cst",
    "ipi_rate",
    "tax_unit",
    "tax_factor",
    "tax_ean",
    "cbenef",
    "ibs_cbs_cst",
    "cclasstrib",
  ]);
  const unknown = Object.keys(v).filter((k) => !known.has(k));
  requireValue(
    !unknown.length,
    `Dados fiscais: campo desconhecido (${unknown.slice(0, 3).join(", ")}).`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Formas de pagamento

export const PAYMENT_METHODS = [
  "cash",
  "card_credit",
  "card_debit",
  "pix_manual",
  "pix",
  "link",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: "Dinheiro",
  card_credit: "Cartão de crédito",
  card_debit: "Cartão de débito",
  pix_manual: "Pix (chave da loja)",
  pix: "Pix (cobrança pelo WhatsApp)",
  link: "Link de pagamento",
  other: "Outra",
};

/** Formas confirmadas pelo provedor (Mercado Pago, pelo módulo Cobrança). */
export const ONLINE_METHODS: readonly PaymentMethod[] = ["pix", "link"];

/** Meio de pagamento da nota (tPag, NT 2023.004). */
export const FISCAL_PAYMENT: Record<PaymentMethod, string> = {
  cash: "01",
  card_credit: "03",
  card_debit: "04",
  pix: "17",
  pix_manual: "20",
  link: "99",
  other: "99",
};

// ---------------------------------------------------------------------------
// Configurações da área (chave "vendas" de PUT /settings)

export const REGIMES = ["simples", "simples_excesso", "normal", "mei"] as const;
export type Regime = (typeof REGIMES)[number];
/** Código de regime tributário (CRT) da nota. */
export const CRT: Record<Regime, number> = {
  simples: 1,
  simples_excesso: 2,
  normal: 3,
  mei: 4,
};
export const UFS = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
];

export interface FiscalSettings {
  regime: Regime | null;
  legal_name: string;
  ie: string;
  im: string;
  cnae: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  /** Código do município no IBGE, 7 dígitos. */
  city_code: string;
  uf: string;
  cep: string;
  environment: "homologacao" | "producao";
  nfce_series: number;
  nfe_series: number;
  /** Padrões para produtos sem o campo. */
  default_cfop: string;
  default_origin: number;
  default_csosn: string;
  default_icms_cst: string;
  default_pis_cst: string;
  default_cofins_cst: string;
  /** Emissor escolhido (fiscal.ts); null: nenhum. */
  provider: string | null;
  /** Emitir a NFC-e sozinho ao concluir a venda (quando houver emissor). */
  auto_emit: boolean;
}

export interface VendasSettings {
  quote_valid_days: number;
  payment_methods: Record<PaymentMethod, boolean>;
  pix_key: string;
  /** Desconto máximo (% do bruto) sem ser administrador. */
  max_discount_percent: number;
  /** Equipe (não administradores) pode cancelar e devolver vendas. */
  operator_can_cancel: boolean;
  /** Aviso de estoque baixo (evento vendas.stock_low). */
  low_stock_alert: boolean;
  receipt_footer: string;
  quote_intro: string;
  quote_footer: string;
  fiscal: FiscalSettings;
}

export const FISCAL_DEFAULTS: FiscalSettings = {
  regime: null,
  legal_name: "",
  ie: "",
  im: "",
  cnae: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  city_code: "",
  uf: "",
  cep: "",
  environment: "homologacao",
  nfce_series: 1,
  nfe_series: 1,
  default_cfop: "5102",
  default_origin: 0,
  default_csosn: "102",
  default_icms_cst: "00",
  default_pis_cst: "49",
  default_cofins_cst: "49",
  provider: null,
  auto_emit: false,
};

export const VENDAS_DEFAULTS: VendasSettings = {
  quote_valid_days: 7,
  payment_methods: {
    cash: true,
    card_credit: true,
    card_debit: true,
    pix_manual: true,
    pix: false,
    link: false,
    other: false,
  },
  pix_key: "",
  max_discount_percent: 10,
  operator_can_cancel: false,
  low_stock_alert: true,
  receipt_footer: "",
  quote_intro: "",
  quote_footer: "",
  fiscal: FISCAL_DEFAULTS,
};

/** Configurações salvas mescladas com os padrões. */
export function vendasSettings(settings: any): VendasSettings {
  const saved = (settings?.vendas || {}) as Partial<VendasSettings>;
  return {
    ...VENDAS_DEFAULTS,
    ...saved,
    payment_methods: {
      ...VENDAS_DEFAULTS.payment_methods,
      ...(saved.payment_methods || {}),
    },
    fiscal: { ...FISCAL_DEFAULTS, ...(saved.fiscal || {}) },
  };
}

function validateFiscalSettings(value: unknown): FiscalSettings {
  if (value === undefined || value === null) return FISCAL_DEFAULTS;
  requireValue(typeof value === "object", "Dados fiscais: envie um objeto.");
  const v = { ...FISCAL_DEFAULTS, ...(value as any) };
  const digits = (k: string, re: RegExp, message: string) => {
    const raw = String(v[k] ?? "").replace(/\D/g, "");
    requireValue(!raw || re.test(raw), message);
    return raw;
  };
  requireValue(
    v.regime === null || REGIMES.includes(v.regime),
    `Regime tributário: ${REGIMES.join(", ")} ou nulo.`,
  );
  const ie = text(v.ie, 20, "a inscrição estadual").toUpperCase();
  requireValue(
    !ie || ie === "ISENTO" || /^\d{2,14}$/.test(ie.replace(/[.\-/]/g, "")),
    "Inscrição estadual: só números ou ISENTO.",
  );
  const uf = text(v.uf, 2, "a UF").toUpperCase();
  requireValue(!uf || UFS.includes(uf), "UF inválida.");
  requireValue(
    v.environment === "homologacao" || v.environment === "producao",
    "Ambiente: homologacao ou producao.",
  );
  const series = (k: string) => {
    requireValue(
      Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= 999,
      "Série: inteiro de 0 a 999.",
    );
    return v[k] as number;
  };
  const defaults = validateFiscal({
    cfop: v.default_cfop,
    origin: v.default_origin,
    icms_csosn: v.default_csosn,
  });
  const cst = validateFiscal({
    icms_cst: v.default_icms_cst,
    pis_cst: v.default_pis_cst,
    cofins_cst: v.default_cofins_cst,
  });
  requireValue(
    v.provider === null ||
      (typeof v.provider === "string" && /^[a-z0-9_-]{1,40}$/.test(v.provider)),
    "Emissor fiscal inválido.",
  );
  return {
    regime: v.regime,
    legal_name: text(v.legal_name, 60, "a razão social"),
    ie: ie.replace(/[.\-/]/g, ""),
    im: text(v.im, 20, "a inscrição municipal"),
    cnae: digits("cnae", /^\d{7}$/, "CNAE: 7 dígitos."),
    street: text(v.street, 60, "o logradouro"),
    number: text(v.number, 10, "o número"),
    complement: text(v.complement, 60, "o complemento"),
    district: text(v.district, 60, "o bairro"),
    city: text(v.city, 60, "o município"),
    city_code: digits(
      "city_code",
      /^\d{7}$/,
      "Código do município (IBGE): 7 dígitos.",
    ),
    uf,
    cep: digits("cep", /^\d{8}$/, "CEP: 8 dígitos."),
    environment: v.environment,
    nfce_series: series("nfce_series"),
    nfe_series: series("nfe_series"),
    default_cfop: defaults.cfop || "5102",
    default_origin: defaults.origin ?? 0,
    default_csosn: defaults.icms_csosn || "102",
    default_icms_cst: cst.icms_cst || "00",
    default_pis_cst: cst.pis_cst || "49",
    default_cofins_cst: cst.cofins_cst || "49",
    provider: v.provider,
    auto_emit: flag(v.auto_emit, "Emitir automaticamente"),
  };
}

/** onSettingsSave("vendas", "vendas"): objeto parcial já mesclado com o salvo. */
export function validateVendasSettings(value: unknown): VendasSettings {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Configurações de vendas: envie um objeto.",
  );
  const v = { ...VENDAS_DEFAULTS, ...(value as any) };
  requireValue(
    Number.isInteger(v.quote_valid_days) &&
      v.quote_valid_days >= 1 &&
      v.quote_valid_days <= 90,
    "Validade do orçamento: de 1 a 90 dias.",
  );
  const methods = { ...VENDAS_DEFAULTS.payment_methods };
  requireValue(
    v.payment_methods && typeof v.payment_methods === "object",
    "Formas de pagamento: envie um objeto.",
  );
  for (const [k, on] of Object.entries(v.payment_methods)) {
    requireValue(
      (PAYMENT_METHODS as readonly string[]).includes(k),
      `Forma de pagamento desconhecida: ${k}.`,
    );
    methods[k as PaymentMethod] = flag(on, PAYMENT_LABELS[k as PaymentMethod]);
  }
  requireValue(
    Object.values(methods).some(Boolean),
    "Ligue ao menos uma forma de pagamento.",
  );
  requireValue(
    typeof v.max_discount_percent === "number" &&
      v.max_discount_percent >= 0 &&
      v.max_discount_percent <= 100,
    "Desconto máximo da equipe: de 0 a 100%.",
  );
  return {
    quote_valid_days: v.quote_valid_days,
    payment_methods: methods,
    pix_key: text(v.pix_key, 77, "a chave Pix"),
    max_discount_percent: v.max_discount_percent,
    operator_can_cancel: flag(
      v.operator_can_cancel,
      "Equipe pode cancelar vendas",
    ),
    low_stock_alert: flag(v.low_stock_alert, "Aviso de estoque baixo"),
    receipt_footer: text(v.receipt_footer, 300, "o rodapé do comprovante"),
    quote_intro: text(v.quote_intro, 300, "a abertura do orçamento"),
    quote_footer: text(v.quote_footer, 500, "o rodapé do orçamento"),
    fiscal: validateFiscalSettings(v.fiscal),
  };
}

// ---------------------------------------------------------------------------
// Estados

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "approved",
  "declined",
  "expired",
  "converted",
  "cancelled",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_LABELS: Record<QuoteStatus, string> = {
  draft: "Rascunho",
  sent: "Enviado",
  approved: "Aprovado",
  declined: "Recusado",
  expired: "Vencido",
  converted: "Virou venda",
  cancelled: "Cancelado",
};

export const SALE_STATUSES = [
  "awaiting_payment",
  "completed",
  "cancelled",
  "returned",
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export const SALE_LABELS: Record<SaleStatus, string> = {
  awaiting_payment: "Aguardando pagamento",
  completed: "Concluída",
  cancelled: "Cancelada",
  returned: "Devolvida",
};

export const MOVE_TYPES = [
  "entrada",
  "saida",
  "ajuste",
  "venda",
  "devolucao",
  "cancelamento",
] as const;
export type MoveType = (typeof MOVE_TYPES)[number];
export const MOVE_LABELS: Record<MoveType, string> = {
  entrada: "Entrada",
  saida: "Saída",
  ajuste: "Ajuste de inventário",
  venda: "Venda",
  devolucao: "Devolução",
  cancelamento: "Venda cancelada",
};
