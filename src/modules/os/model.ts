// Regras puras da Ordem de Serviço: estados, transições, configurações,
// orçamento e textos. Sem banco, para testar e para os apps lerem o contrato.
import { requireValue } from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";
import type { QuoteItem, QuoteTerms } from "./contracts";
export type { QuoteItem } from "./contracts";

export const OS_STATUSES = [
  "received",
  "analyzing",
  "quoted",
  "approved",
  "declined",
  "in_progress",
  "ready",
  "delivered",
  "cancelled",
] as const;
export type OsStatus = (typeof OS_STATUSES)[number];

export const STATUS_LABELS: Record<OsStatus, string> = {
  received: "Recebida",
  analyzing: "Em análise",
  quoted: "Orçamento enviado",
  approved: "Aprovada",
  declined: "Recusada",
  in_progress: "Em execução",
  ready: "Pronta",
  delivered: "Entregue",
  cancelled: "Cancelada",
};

/** Estados encerrados: não aparecem no acompanhamento nem nos avisos. */
export const CLOSED: readonly OsStatus[] = ["delivered", "cancelled"];

/**
 * Transições feitas pela mudança de estado (POST …/status). "quoted" só pelo
 * envio do orçamento; "approved" e "declined" só pela resposta ao orçamento
 * (cliente no WhatsApp ou equipe em nome dele), para registrar quem decidiu.
 * Serviço sem orçamento (lavanderia, preço fixo): recebida/em análise →
 * em execução.
 */
export const MANUAL_TRANSITIONS: Record<OsStatus, readonly OsStatus[]> = {
  received: ["analyzing", "in_progress", "cancelled"],
  analyzing: ["in_progress", "cancelled"],
  quoted: ["analyzing", "cancelled"],
  approved: ["in_progress", "cancelled"],
  declined: ["analyzing", "ready", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready: ["delivered", "in_progress", "cancelled"],
  delivered: [],
  cancelled: [],
};
/** Estados de onde o orçamento pode ser salvo e enviado. */
export const QUOTABLE: readonly OsStatus[] = [
  "received",
  "analyzing",
  "quoted",
  "declined",
];

export const isStatus = (value: unknown): value is OsStatus =>
  typeof value === "string" &&
  (OS_STATUSES as readonly string[]).includes(value);

/** Próximos estados possíveis, como o painel e os apps mostram. */
export function nextStatuses(status: OsStatus, quoteReady: boolean) {
  const out: OsStatus[] = [...MANUAL_TRANSITIONS[status]];
  if (quoteReady && QUOTABLE.includes(status)) out.push("quoted");
  if (status === "quoted") out.push("approved", "declined");
  return out;
}

// ---------------------------------------------------------------------------
// Configurações (chave "service_orders" de PUT /settings)

export const TEXT_KEYS = [
  "opened",
  "approved",
  "declined",
  "in_progress",
  "ready",
  "delivered",
  "cancelled",
  "pickup_reminder",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

export interface OsSettings {
  /** Termos que o cliente aceita ao abrir pelo WhatsApp. */
  terms: string;
  /** Validade padrão do orçamento, em dias. */
  quote_valid_days: number;
  /** Garantia contada da entrega, em dias (0: sem garantia). */
  warranty_days: number;
  /** Ordem aberta sem mudança há este número de dias: aviso à equipe (os.stale). */
  stale_days: number;
  /** Pronta e não retirada há este número de dias: lembrete ao cliente (0: nunca). */
  pickup_reminder_days: number;
  /** Mensagens ao cliente. Vazia: não envia. Marcadores em docs/ORDEM-DE-SERVICO.md. */
  texts: Record<TextKey, string>;
}

export const OS_DEFAULTS: OsSettings = {
  terms:
    "Autorizo a análise do item informado. O orçamento será enviado por este WhatsApp e nenhum serviço será feito sem a minha aprovação.",
  quote_valid_days: 7,
  warranty_days: 90,
  stale_days: 7,
  pickup_reminder_days: 3,
  texts: {
    opened:
      "Ordem de serviço nº {numero} aberta para {item}. Vamos analisar e enviar o orçamento por aqui.",
    approved:
      "Orçamento da ordem nº {numero} aprovado. Avisaremos quando o serviço estiver pronto.",
    declined:
      "Orçamento da ordem nº {numero} recusado. Avisaremos quando {item} estiver disponível para retirada.",
    in_progress: "",
    ready: "Ordem de serviço nº {numero}: {item} está pronto para retirada.",
    delivered:
      "Ordem de serviço nº {numero} entregue. Garantia: {garantia}. Obrigado pela preferência!",
    cancelled: "Ordem de serviço nº {numero} cancelada.",
    pickup_reminder:
      "Lembrete: {item} (ordem de serviço nº {numero}) está pronto para retirada desde {pronto}.",
  },
};

const intIn = (value: unknown, min: number, max: number, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max,
    `Ordem de serviço: ${what} de ${min} a ${max}.`,
  );
  return value as number;
};

/** Configuração salva, já mesclada com os padrões. */
export function osSettings(cfg: any): OsSettings {
  const raw =
    cfg?.service_orders && typeof cfg.service_orders === "object"
      ? cfg.service_orders
      : {};
  return {
    ...OS_DEFAULTS,
    ...raw,
    texts: { ...OS_DEFAULTS.texts, ...(raw.texts || {}) },
  };
}

/** Validação estrita da chave "service_orders" em PUT /settings. */
export function validateOsSettings(value: unknown): Partial<OsSettings> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Ordem de serviço: configuração inválida.",
  );
  const raw = value as any;
  const allowed = new Set([
    "terms",
    "quote_valid_days",
    "warranty_days",
    "stale_days",
    "pickup_reminder_days",
    "texts",
  ]);
  for (const key of Object.keys(raw))
    requireValue(
      allowed.has(key),
      `Ordem de serviço: chave desconhecida ${key}.`,
    );
  const out: Partial<OsSettings> = {};
  if (raw.terms !== undefined) {
    requireValue(
      typeof raw.terms === "string" &&
        raw.terms.trim() &&
        Array.from(raw.terms).length <= 1400,
      "Ordem de serviço: termos de 1 a 1400 caracteres.",
    );
    out.terms = raw.terms.trim();
  }
  if (raw.quote_valid_days !== undefined)
    out.quote_valid_days = intIn(
      raw.quote_valid_days,
      1,
      90,
      "validade do orçamento",
    );
  if (raw.warranty_days !== undefined)
    out.warranty_days = intIn(raw.warranty_days, 0, 3650, "dias de garantia");
  if (raw.stale_days !== undefined)
    out.stale_days = intIn(raw.stale_days, 1, 365, "dias para ordem parada");
  if (raw.pickup_reminder_days !== undefined)
    out.pickup_reminder_days = intIn(
      raw.pickup_reminder_days,
      0,
      365,
      "dias para lembrar a retirada",
    );
  if (raw.texts !== undefined) {
    requireValue(
      raw.texts && typeof raw.texts === "object" && !Array.isArray(raw.texts),
      "Ordem de serviço: mensagens inválidas.",
    );
    const texts: Partial<Record<TextKey, string>> = {};
    for (const [key, text] of Object.entries(raw.texts)) {
      requireValue(
        (TEXT_KEYS as readonly string[]).includes(key),
        `Ordem de serviço: mensagem desconhecida ${key}.`,
      );
      requireValue(
        typeof text === "string" && Array.from(text).length <= 900,
        "Ordem de serviço: mensagens com até 900 caracteres.",
      );
      texts[key as TextKey] = text.trim();
    }
    out.texts = texts as Record<TextKey, string>;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orçamento

export const QUOTE_ITEMS_LIMIT = 50;

export function validateQuoteItems(value: unknown): QuoteItem[] {
  requireValue(
    Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= QUOTE_ITEMS_LIMIT,
    `Orçamento: informe de 1 a ${QUOTE_ITEMS_LIMIT} itens.`,
  );
  const ids = new Set<string>();
  return (value as any[]).map((raw, index) => {
    requireValue(raw && typeof raw === "object", "Orçamento: item inválido.");
    const description =
      typeof raw.description === "string" ? raw.description.trim() : "";
    requireValue(
      description && Array.from(description).length <= 200,
      `Orçamento: descrição do item ${index + 1} de 1 a 200 caracteres.`,
    );
    const quantity = raw.quantity === undefined ? 1 : raw.quantity;
    requireValue(
      typeof quantity === "number" && quantity > 0 && quantity <= 999 && /^\d+(\.\d{1,6})?$/.test(String(quantity)),
      `Orçamento: quantidade do item ${index + 1} maior que zero, até 999 e até seis casas decimais.`,
    );
    requireValue(
      Number.isInteger(raw.unit_cents) &&
        raw.unit_cents >= 0 &&
        raw.unit_cents <= 100_000_000,
      `Orçamento: valor do item ${index + 1} em centavos (inteiro, até R$ 1.000.000,00).`,
    );
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (raw.id !== undefined) {
      requireValue(typeof raw.id === "string" && uuid.test(raw.id) && !ids.has(raw.id.toLowerCase()), "Orçamento: identificador de linha inválido ou repetido.");
      ids.add(raw.id.toLowerCase());
    }
    if (raw.kind !== undefined) requireValue(["material", "service", "free"].includes(raw.kind), "Orçamento: classificação inválida.");
    if (raw.unit !== undefined) requireValue(typeof raw.unit === "string" && /^[A-Za-z0-9²³%./_-]{1,12}$/.test(raw.unit), "Orçamento: unidade inválida.");
    if (raw.product_id != null) requireValue(typeof raw.product_id === "string" && uuid.test(raw.product_id) && ["material", "service"].includes(raw.kind), "Orçamento: vínculo de produto inválido.");
    if (raw.discount_cents != null && raw.discount_cents !== 0) {
      requireValue(Number.isInteger(raw.discount_cents) && raw.discount_cents > 0,
        `Orçamento: desconto do item ${index + 1} em centavos (inteiro, maior ou igual a zero).`);
      requireValue(raw.discount_cents <= lineGross({ quantity, unit_cents: raw.unit_cents }),
        `Orçamento: o desconto do item ${index + 1} passa do valor do item.`);
    }
    if (raw.code !== undefined && raw.code !== null)
      requireValue(typeof raw.code === "string" && Array.from(raw.code).length <= 60 && !/[\u0000-\u001f]/.test(raw.code), `Orçamento: código do item ${index + 1} com até 60 caracteres.`);
    return { description, quantity, unit_cents: raw.unit_cents,
      ...(raw.id !== undefined ? { id: raw.id.toLowerCase() } : {}),
      ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
      ...(raw.unit !== undefined ? { unit: raw.unit } : {}),
      ...(raw.product_id !== undefined ? { product_id: raw.product_id } : {}),
      ...(raw.discount_cents ? { discount_cents: raw.discount_cents } : {}),
      ...(typeof raw.code === "string" && raw.code.trim() ? { code: raw.code.trim() } : {}),
    };
  });
}

/** Valor bruto da linha: quantidade decimal × unitário, arredondado por linha. */
export function lineGross(item: Pick<QuoteItem, "quantity" | "unit_cents">) {
  const [whole, fraction = ""] = String(item.quantity).split(".");
  const scale = 10n ** BigInt(fraction.length);
  return Number((BigInt(whole + fraction) * BigInt(item.unit_cents) + scale / 2n) / scale);
}
/** Soma bruta das linhas, sem nenhum desconto (é o que o ERP chama de itens). */
export function quoteSubtotal(items: QuoteItem[]) {
  const total = items.reduce((sum, item) => sum + BigInt(lineGross(item)), 0n);
  requireValue(total <= BigInt(Number.MAX_SAFE_INTEGER), "Orçamento: total fora do limite.");
  return Number(total);
}
export const itemsDiscount = (items: QuoteItem[]) => items.reduce((sum, item) => sum + (item.discount_cents ?? 0), 0);
/**
 * Total líquido do orçamento: soma das linhas, menos os descontos das linhas
 * e o desconto no total. Sem descontos é exatamente o total de antes.
 */
export const quoteTotal = (items: QuoteItem[], discount = 0) => {
  const total = quoteSubtotal(items) - itemsDiscount(items) - discount;
  requireValue(total >= 0, "Orçamento: o desconto passa do valor dos itens.");
  return total;
};

// ---------------------------------------------------------------------------
// Condições de pagamento (OS3)

export const PAYMENT_METHODS = ["cash", "pix", "card", "boleto", "transfer", "other"] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  cash: "Dinheiro", pix: "Pix", card: "Cartão", boleto: "Boleto", transfer: "Transferência", other: "Outra forma",
};
const civilDate = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

/**
 * Valida as condições do orçamento. `finance` indica a parte Financeiro do
 * ERP ligada: sem ela não há parcelas (só o total combinado).
 */
export function validateQuoteTerms(value: unknown, finance: boolean): QuoteTerms | null {
  if (value === null || value === undefined) return null;
  requireValue(typeof value === "object" && !Array.isArray(value), "Condições de pagamento inválidas.");
  const raw = value as Record<string, any>;
  for (const key of Object.keys(raw))
    requireValue(["payer_contact_id", "payer_name", "method", "payment_method_id", "method_label", "installments"].includes(key),
      `Condições de pagamento: campo desconhecido ${key}.`);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const payer = raw.payer_contact_id ?? null;
  requireValue(payer === null || (typeof payer === "string" && payer.length > 0 && payer.length <= 80 && !/[\u0000-\u001f]/.test(payer)), "Pagador inválido.");
  const payerName = typeof raw.payer_name === "string" ? raw.payer_name.trim() : "";
  requireValue(Array.from(payerName).length <= 120, "Nome do pagador: até 120 caracteres.");
  const method = raw.method ?? null;
  requireValue(method === null || (PAYMENT_METHODS as readonly string[]).includes(method), "Forma de pagamento inválida.");
  const methodId = raw.payment_method_id ?? null;
  requireValue(methodId === null || (typeof methodId === "string" && uuid.test(methodId)), "Forma de pagamento do ERP inválida.");
  const label = typeof raw.method_label === "string" ? raw.method_label.trim() : "";
  requireValue(Array.from(label).length <= 80, "Nome da forma de pagamento: até 80 caracteres.");
  let installments: QuoteTerms["installments"] = null;
  if (finance && raw.installments != null) {
    const i = raw.installments;
    requireValue(i && typeof i === "object" && !Array.isArray(i), "Parcelas inválidas.");
    requireValue(Number.isInteger(i.count) && i.count >= 1 && i.count <= 24, "Parcelas: de 1 a 24.");
    requireValue(civilDate(i.first_due_on), "Parcelas: informe a data da primeira parcela.");
    const interval = i.interval_days ?? 30;
    requireValue(Number.isInteger(interval) && interval >= 1 && interval <= 365, "Parcelas: intervalo de 1 a 365 dias.");
    installments = { count: i.count, first_due_on: i.first_due_on, interval_days: interval };
  }
  return {
    payer_contact_id: payer, payer_name: payerName,
    method, payment_method_id: methodId,
    method_label: label || (method ? PAYMENT_METHOD_LABELS[method as keyof typeof PAYMENT_METHOD_LABELS] : ""),
    installments,
  };
}

/** Datas civis: a primeira mais `interval_days` a cada parcela. */
export function addDays(date: string, days: number) {
  const at = new Date(date + "T12:00:00Z");
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
/**
 * Divide o total em parcelas iguais em centavos; a diferença do
 * arredondamento fica na primeira. Sem parcelas ou total zero: lista vazia.
 */
export function quoteInstallments(terms: QuoteTerms | null | undefined, total: number) {
  const plan = terms?.installments;
  if (!plan || total <= 0) return [] as { number: number; due_on: string; amount_cents: number }[];
  const count = Math.min(plan.count, total);
  const base = Math.floor(total / count), first = total - base * (count - 1);
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    due_on: addDays(plan.first_due_on, index * plan.interval_days),
    amount_cents: index === 0 ? first : base,
  }));
}

/** "3x de R$ 100,00 a cada 30 dias, a partir de 10/12/2026 · Pix" */
export function termsSummary(terms: QuoteTerms | null | undefined, total: number) {
  const parts: string[] = [];
  const plan = quoteInstallments(terms, total);
  if (plan.length > 1) {
    const [y, m, d] = plan[0].due_on.split("-");
    parts.push(`${plan.length} parcelas (${plan.map(p => money(p.amount_cents)).join(" + ")}), a primeira em ${d}/${m}/${y}, a cada ${terms!.installments!.interval_days} dias`);
  } else if (plan.length === 1) {
    const [y, m, d] = plan[0].due_on.split("-");
    parts.push(`À vista, vencimento em ${d}/${m}/${y}`);
  }
  if (terms?.method_label) parts.push(terms.method_label);
  if (terms?.payer_name) parts.push(`Pagador: ${terms.payer_name}`);
  return parts.join(" · ");
}

/** "R$ 1.234,56" */
export function money(cents: number) {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

/** "22/11/2026", no horário de Brasília. */
export function day(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS),
    two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/**
 * Fim do dia (23:59:59,999 em Brasília) `days` dias depois de `at`: o
 * orçamento enviado hoje com 7 dias vale até o fim do sétimo dia.
 */
export function endOfDayAfter(at: number, days: number) {
  const DAY = 86_400_000;
  const local = at - BRASILIA_OFFSET_MS;
  return (Math.floor(local / DAY) + days + 1) * DAY - 1 + BRASILIA_OFFSET_MS;
}

// ---------------------------------------------------------------------------
// Textos ao cliente

/** Só dígitos, com 55 quando o número veio sem DDI (10 ou 11 dígitos). */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}

export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (all, key) =>
    Object.hasOwn(values, key) ? values[key] : all,
  );
}

export function orderValues(order: any): Record<string, string> {
  return {
    numero: String(order.number),
    item: order.item,
    estado: STATUS_LABELS[order.status as OsStatus] || order.status,
    total:
      order.quote_total_cents === null || order.quote_total_cents === undefined
        ? ""
        : money(order.quote_total_cents),
    validade: order.quote_valid_until ? day(order.quote_valid_until) : "",
    garantia: order.warranty_until
      ? `até ${day(order.warranty_until)}`
      : "sem garantia",
    pronto: order.ready_at ? day(order.ready_at) : "",
    previsao: order.due_at ? day(order.due_at) : "",
  };
}
