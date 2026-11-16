// Regras puras das Mesas: configuração (chave "mesas" de PUT /settings),
// estados da conta, formas de pagamento e o cálculo da conta (subtotal, taxa
// de serviço, pago, a pagar e a divisão por pessoa). Sem banco.
import { requireValue } from "../../types";

export const TAB_STATUSES = [
  "open",
  "closing",
  "closed",
  "cancelled",
  "merged",
] as const;
export type TabStatus = (typeof TAB_STATUSES)[number];
/** Conta que ainda ocupa a mesa. */
export const LIVE_STATUSES: readonly TabStatus[] = ["open", "closing"];
export const isLive = (status: string) =>
  (LIVE_STATUSES as readonly string[]).includes(status);

export const TAB_STATUS_LABELS: Record<TabStatus, string> = {
  open: "Aberta",
  closing: "Conta pedida",
  closed: "Fechada",
  cancelled: "Cancelada",
  merged: "Juntada a outra mesa",
};

/** Estado da mesa no mapa: vem da conta aberta. */
export type TableState = "free" | "occupied" | "closing";
export const TABLE_STATE_LABELS: Record<TableState, string> = {
  free: "Livre",
  occupied: "Ocupada",
  closing: "Fechando",
};

export const TABLE_KINDS = ["table", "card"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

/** Pagamentos registrados pela equipe na mesa (nada é cobrado online aqui). */
export const PAY_METHODS = ["cash", "card", "pix", "other"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_LABELS: Record<PayMethod, string> = {
  cash: "Dinheiro",
  card: "Cartão",
  pix: "Pix",
  other: "Outro",
};

// ---------------------------------------------------------------------------
// Configuração

export interface MesasConfig {
  /** Taxa de serviço em %, com até uma casa (0 a 20). 0 desliga. */
  service_percent: number;
  /** As contas novas já saem com a taxa (o garçom tira se o cliente pedir). */
  service_default: boolean;
  /** Máximo de pessoas para dividir a conta. */
  split_max: number;
}

export const MESAS_DEFAULTS: MesasConfig = {
  service_percent: 10,
  service_default: true,
  split_max: 20,
};

export function mesasConfig(settings: any): MesasConfig {
  const raw =
    settings?.mesas && typeof settings.mesas === "object" ? settings.mesas : {};
  return { ...MESAS_DEFAULTS, ...raw };
}

/** Validação estrita da chave "mesas" (campos ausentes ficam como estão). */
export function validateMesasConfig(value: unknown): Partial<MesasConfig> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Mesas: configuração inválida.",
  );
  const raw = value as any;
  for (const key of Object.keys(raw))
    requireValue(
      Object.hasOwn(MESAS_DEFAULTS, key),
      `Mesas: chave desconhecida ${key}.`,
    );
  const out: Partial<MesasConfig> = {};
  if (raw.service_percent !== undefined) {
    const p = raw.service_percent;
    requireValue(
      typeof p === "number" &&
        Number.isFinite(p) &&
        p >= 0 &&
        p <= 20 &&
        Math.round(p * 10) === p * 10,
      "Mesas: taxa de serviço de 0 a 20%, com até uma casa decimal.",
    );
    out.service_percent = p;
  }
  if (raw.service_default !== undefined) {
    requireValue(
      typeof raw.service_default === "boolean",
      "Mesas: service_default verdadeiro ou falso.",
    );
    out.service_default = raw.service_default;
  }
  if (raw.split_max !== undefined) {
    requireValue(
      Number.isInteger(raw.split_max) &&
        raw.split_max >= 2 &&
        raw.split_max <= 50,
      "Mesas: dividir por até 2 a 50 pessoas.",
    );
    out.split_max = raw.split_max;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conta

export interface BillTotals {
  subtotal_cents: number;
  service_on: boolean;
  /** Em %, como na configuração no momento em que a conta abriu. */
  service_percent: number;
  service_cents: number;
  total_cents: number;
  paid_cents: number;
  /** Quanto falta (nunca negativo). */
  due_cents: number;
  /** Pago a mais (um pedido cancelado depois do pagamento parcial). */
  overpaid_cents: number;
}

/**
 * Taxa sobre o subtotal, arredondada ao centavo (meio centavo para cima);
 * `permille` é o percentual em décimos (100 = 10%).
 */
export function billTotals(
  subtotal: number,
  serviceOn: boolean,
  permille: number,
  paid: number,
): BillTotals {
  const service = serviceOn ? Math.round((subtotal * permille) / 1000) : 0;
  const total = subtotal + service;
  return {
    subtotal_cents: subtotal,
    service_on: serviceOn,
    service_percent: permille / 10,
    service_cents: service,
    total_cents: total,
    paid_cents: paid,
    due_cents: Math.max(0, total - paid),
    overpaid_cents: Math.max(0, paid - total),
  };
}

/**
 * Divide `cents` entre `people`: partes inteiras, os centavos que sobram vão
 * para as primeiras pessoas (a soma bate sempre).
 */
export function splitShares(cents: number, people: number) {
  const base = Math.floor(cents / people);
  const rest = cents - base * people;
  return Array.from({ length: people }, (_, i) => base + (i < rest ? 1 : 0));
}

export const clip = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");

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

export const intIn = (
  value: unknown,
  min: number,
  max: number,
  message: string,
) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max,
    message,
  );
  return value as number;
};
