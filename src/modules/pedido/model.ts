// Regras puras do Pedido: configuração da loja (chave "pedido" de PUT
// /settings), horário de funcionamento em Brasília, estados do pedido,
// transições, formas de pagamento e textos. Sem banco, para testar e para os
// apps lerem o contrato.
import { requireValue } from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Formas de pagamento

export const PAYMENT_METHODS = ["pix", "link", "cash", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Pix e link de pagamento saem pela Cobrança do núcleo (ctx.charge). */
export const ONLINE_METHODS: readonly PaymentMethod[] = ["pix", "link"];
export const isOnline = (method: unknown) =>
  ONLINE_METHODS.includes(method as PaymentMethod);

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: "Pix",
  link: "Cartão pelo link de pagamento",
  cash: "Dinheiro na entrega ou retirada",
  card: "Cartão na maquininha",
};
/** Títulos curtos das opções no WhatsApp (até 24 caracteres). */
export const PAYMENT_TITLES: Record<PaymentMethod, string> = {
  pix: "Pix agora",
  link: "Cartão (link)",
  cash: "Dinheiro",
  card: "Cartão na maquininha",
};

// ---------------------------------------------------------------------------
// Estados do pedido

export const ORDER_STATUSES = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: "Aguardando pagamento",
  received: "Recebido",
  preparing: "Em preparo",
  ready: "Pronto para retirada",
  out_for_delivery: "Saiu para entrega",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
];
export const CLOSED_STATUSES: readonly OrderStatus[] = [
  "delivered",
  "cancelled",
];

export const isStatus = (value: unknown): value is OrderStatus =>
  typeof value === "string" &&
  (ORDER_STATUSES as readonly string[]).includes(value);

/**
 * Próximos estados que a equipe pode escolher. "Pronto para retirada" só em
 * retirada e "Saiu para entrega" só em entrega; um passo para trás é
 * permitido para corrigir engano. Aguardando pagamento → Recebido é a equipe
 * mandando para o preparo sem esperar o pagamento (fica no histórico).
 */
export function nextStatuses(
  status: OrderStatus,
  fulfillment: "pickup" | "delivery",
): OrderStatus[] {
  const done: OrderStatus =
    fulfillment === "delivery" ? "out_for_delivery" : "ready";
  switch (status) {
    case "awaiting_payment":
      return ["received", "cancelled"];
    case "received":
      return ["preparing", done, "cancelled"];
    case "preparing":
      return [done, "received", "cancelled"];
    case "ready":
    case "out_for_delivery":
      return ["delivered", "preparing", "cancelled"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Configuração da loja (chave "pedido")

export interface StoreHours {
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
  /** "HH:MM" em Brasília. */
  start: string;
  /** "HH:MM"; "00:00" é meia-noite; antes do início, vira o dia seguinte. */
  end: string;
}

export const TEXT_KEYS = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "closed",
  "paused",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

export const ALERT_STATUSES = [
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface PedidoConfig {
  /** Título da página do carrinho e das mensagens; vazio: "Cardápio". */
  store_name: string;
  /** Vazio: sem horário (aberta sempre que não estiver pausada). */
  hours: StoreHours[];
  pickup: boolean;
  delivery: boolean;
  delivery_fee_cents: number;
  /** Subtotal mínimo, sem a entrega (0: sem mínimo). */
  minimum_cents: number;
  /** Tempo estimado, em minutos (0: não informar). */
  pickup_minutes: number;
  delivery_minutes: number;
  pickup_address: string;
  /** Formas aceitas: Pix e link pela Cobrança; dinheiro e maquininha na hora. */
  payments: Record<PaymentMethod, boolean>;
  /** Pedido pago online só vai para o preparo depois do pagamento confirmado. */
  pay_before_prepare: boolean;
  /** Validade da cobrança online e do prazo para escolher como pagar. */
  payment_minutes: number;
  /** Validade do link do carrinho. */
  cart_minutes: number;
  /** Minutos parado em cada estado até avisar a equipe (0: sem aviso). */
  alerts: Record<AlertStatus, number>;
  /** Mensagens ao cliente; vazia não envia. Marcadores em docs/PEDIDO.md. */
  texts: Record<TextKey, string>;
  /**
   * Desconto pedido pelo cliente ao bot (pedido_pedir_desconto), aprovado
   * pela equipe: quem aprova (`admin` ou `team`, quem acessa o Pedido) e o
   * limite em % do subtotal; com `team`, a pessoa que não é administradora vai
   * até `team_max_percent`. `max_percent` 0 desliga o pedido de desconto.
   */
  discount: {
    approvers: "admin" | "team";
    max_percent: number;
    team_max_percent: number;
  };
}

export const PEDIDO_DEFAULTS: PedidoConfig = {
  store_name: "",
  hours: [],
  pickup: true,
  delivery: false,
  delivery_fee_cents: 0,
  minimum_cents: 0,
  pickup_minutes: 20,
  delivery_minutes: 45,
  pickup_address: "",
  payments: { pix: false, link: false, cash: true, card: true },
  pay_before_prepare: true,
  payment_minutes: 30,
  cart_minutes: 60,
  alerts: { received: 10, preparing: 40, ready: 60, out_for_delivery: 90 },
  discount: { approvers: "admin", max_percent: 10, team_max_percent: 5 },
  texts: {
    awaiting_payment:
      "Pedido nº {numero} registrado. Ele vai para o preparo assim que o pagamento for confirmado.",
    received: "Pedido nº {numero} recebido! {previsao}",
    preparing: "Pedido nº {numero} em preparo.",
    ready: "Pedido nº {numero} pronto para retirada! {endereco}",
    out_for_delivery: "Pedido nº {numero} saiu para entrega.",
    delivered: "Pedido nº {numero} entregue. Obrigado pela preferência!",
    cancelled: "Pedido nº {numero} cancelado. {motivo}",
    closed:
      "Estamos fechados agora. {abre}\n\nHorário de funcionamento:\n{horario}",
    paused:
      "No momento não estamos recebendo pedidos. Tente de novo mais tarde.",
  },
};

const intIn = (value: unknown, min: number, max: number, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max,
    `Pedido: ${what} de ${min} a ${max}.`,
  );
  return value as number;
};
const centsIn = (value: unknown, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 10_000_000,
    `Pedido: ${what} em centavos (inteiro de 0 a 10.000.000).`,
  );
  return value as number;
};
const bool = (value: unknown, what: string) => {
  requireValue(typeof value === "boolean", `Pedido: ${what}: sim ou não.`);
  return value as boolean;
};

/** Minutos desde a meia-noite de "HH:MM", ou null. */
export function clockMinutes(value: unknown) {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function validateHours(value: unknown): StoreHours[] {
  requireValue(
    Array.isArray(value) && value.length <= 21,
    "Pedido: horário de funcionamento com até 21 faixas (3 por dia).",
  );
  const hours = (value as any[]).map((raw) => {
    requireValue(
      raw && typeof raw === "object",
      "Pedido: faixa de horário inválida.",
    );
    const weekday = intIn(raw.weekday, 0, 6, "dia da semana (0 = domingo)");
    const start = clockMinutes(raw.start),
      end = clockMinutes(raw.end);
    requireValue(
      start !== null && end !== null && start !== end,
      "Pedido: horário no formato HH:MM, com início diferente do fim.",
    );
    return { weekday, start: raw.start as string, end: raw.end as string };
  });
  for (let day = 0; day < 7; day++)
    requireValue(
      hours.filter((h) => h.weekday === day).length <= 3,
      "Pedido: até 3 faixas de horário por dia.",
    );
  return hours.sort(
    (a, b) =>
      a.weekday - b.weekday ||
      (clockMinutes(a.start) as number) - (clockMinutes(b.start) as number),
  );
}

/** Configuração salva, já mesclada com os padrões. */
export function pedidoConfig(settings: any): PedidoConfig {
  const raw =
    settings?.pedido && typeof settings.pedido === "object"
      ? settings.pedido
      : {};
  return {
    ...PEDIDO_DEFAULTS,
    ...raw,
    payments: { ...PEDIDO_DEFAULTS.payments, ...(raw.payments || {}) },
    alerts: { ...PEDIDO_DEFAULTS.alerts, ...(raw.alerts || {}) },
    texts: { ...PEDIDO_DEFAULTS.texts, ...(raw.texts || {}) },
    discount: { ...PEDIDO_DEFAULTS.discount, ...(raw.discount || {}) },
  };
}

/**
 * Validação estrita da chave "pedido" em PUT /settings. Campos ausentes
 * continuam com o valor salvo (o núcleo troca a chave inteira: o painel manda
 * a configuração completa).
 */
export function validatePedidoConfig(value: unknown): Partial<PedidoConfig> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Pedido: configuração inválida.",
  );
  const raw = value as any;
  const allowed = new Set([...Object.keys(PEDIDO_DEFAULTS)]);
  for (const key of Object.keys(raw))
    requireValue(allowed.has(key), `Pedido: chave desconhecida ${key}.`);
  const out: Partial<PedidoConfig> = {};
  if (raw.store_name !== undefined) {
    requireValue(
      typeof raw.store_name === "string" &&
        Array.from(raw.store_name.trim()).length <= 80,
      "Pedido: nome da loja com até 80 caracteres.",
    );
    out.store_name = raw.store_name.trim();
  }
  if (raw.hours !== undefined) out.hours = validateHours(raw.hours);
  if (raw.pickup !== undefined) out.pickup = bool(raw.pickup, "retirada");
  if (raw.delivery !== undefined) out.delivery = bool(raw.delivery, "entrega");
  if (raw.delivery_fee_cents !== undefined)
    out.delivery_fee_cents = centsIn(raw.delivery_fee_cents, "taxa de entrega");
  if (raw.minimum_cents !== undefined)
    out.minimum_cents = centsIn(raw.minimum_cents, "pedido mínimo");
  if (raw.pickup_minutes !== undefined)
    out.pickup_minutes = intIn(
      raw.pickup_minutes,
      0,
      1440,
      "tempo da retirada (minutos)",
    );
  if (raw.delivery_minutes !== undefined)
    out.delivery_minutes = intIn(
      raw.delivery_minutes,
      0,
      1440,
      "tempo da entrega (minutos)",
    );
  if (raw.pickup_address !== undefined) {
    requireValue(
      typeof raw.pickup_address === "string" &&
        Array.from(raw.pickup_address.trim()).length <= 200,
      "Pedido: endereço de retirada com até 200 caracteres.",
    );
    out.pickup_address = raw.pickup_address.trim();
  }
  if (raw.payments !== undefined) {
    requireValue(
      raw.payments &&
        typeof raw.payments === "object" &&
        !Array.isArray(raw.payments),
      "Pedido: formas de pagamento inválidas.",
    );
    const payments = { ...PEDIDO_DEFAULTS.payments };
    for (const [key, enabled] of Object.entries(raw.payments)) {
      requireValue(
        (PAYMENT_METHODS as readonly string[]).includes(key),
        `Pedido: forma de pagamento desconhecida ${key} (use pix, link, cash ou card).`,
      );
      payments[key as PaymentMethod] = bool(enabled, `pagamento ${key}`);
    }
    requireValue(
      Object.values(payments).some(Boolean),
      "Pedido: aceite ao menos uma forma de pagamento.",
    );
    out.payments = payments;
  }
  if (raw.pay_before_prepare !== undefined)
    out.pay_before_prepare = bool(
      raw.pay_before_prepare,
      "preparo só depois de pago",
    );
  if (raw.payment_minutes !== undefined)
    out.payment_minutes = intIn(
      raw.payment_minutes,
      30,
      1440,
      "prazo para pagar (minutos)",
    );
  if (raw.cart_minutes !== undefined)
    out.cart_minutes = intIn(
      raw.cart_minutes,
      15,
      1440,
      "validade do link do carrinho (minutos)",
    );
  if (raw.alerts !== undefined) {
    requireValue(
      raw.alerts &&
        typeof raw.alerts === "object" &&
        !Array.isArray(raw.alerts),
      "Pedido: alertas inválidos.",
    );
    const alerts = { ...PEDIDO_DEFAULTS.alerts };
    for (const [key, minutes] of Object.entries(raw.alerts)) {
      requireValue(
        (ALERT_STATUSES as readonly string[]).includes(key),
        `Pedido: alerta desconhecido ${key}.`,
      );
      alerts[key as AlertStatus] = intIn(
        minutes,
        0,
        1440,
        `alerta de ${key} (minutos)`,
      );
    }
    out.alerts = alerts;
  }
  if (raw.texts !== undefined) {
    requireValue(
      raw.texts && typeof raw.texts === "object" && !Array.isArray(raw.texts),
      "Pedido: mensagens inválidas.",
    );
    const texts: Partial<Record<TextKey, string>> = {};
    for (const [key, text] of Object.entries(raw.texts)) {
      requireValue(
        (TEXT_KEYS as readonly string[]).includes(key),
        `Pedido: mensagem desconhecida ${key}.`,
      );
      requireValue(
        typeof text === "string" && Array.from(text).length <= 900,
        "Pedido: mensagens com até 900 caracteres.",
      );
      texts[key as TextKey] = text.trim();
    }
    out.texts = texts as Record<TextKey, string>;
  }
  if (raw.discount !== undefined) {
    const d = raw.discount;
    requireValue(
      d && typeof d === "object" && !Array.isArray(d),
      "Pedido: desconto inválido.",
    );
    for (const key of Object.keys(d))
      requireValue(
        Object.hasOwn(PEDIDO_DEFAULTS.discount, key),
        `Pedido: chave desconhecida discount.${key}.`,
      );
    const discount = { ...PEDIDO_DEFAULTS.discount };
    if (d.approvers !== undefined) {
      requireValue(
        d.approvers === "admin" || d.approvers === "team",
        "Pedido: quem aprova desconto é admin ou team.",
      );
      discount.approvers = d.approvers;
    }
    for (const key of ["max_percent", "team_max_percent"] as const)
      if (d[key] !== undefined) {
        requireValue(
          Number.isInteger(d[key]) && d[key] >= 0 && d[key] <= 50,
          "Pedido: limite de desconto em % inteiro de 0 a 50.",
        );
        discount[key] = d[key];
      }
    requireValue(
      discount.team_max_percent <= discount.max_percent,
      "Pedido: o limite da equipe não passa do limite geral do desconto.",
    );
    out.discount = discount;
  }
  const merged = pedidoConfig({ pedido: out });
  requireValue(
    merged.pickup || merged.delivery,
    "Pedido: ofereça retirada, entrega ou as duas.",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Horário de funcionamento (Brasília)

const WEEKDAYS = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];
const SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const two = (n: number) => String(n).padStart(2, "0");
/** "HH:MM" em Brasília. */
export function clockOf(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
/** "15/11/2026 às 19:40" em Brasília. */
export function dateTimeOf(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} às ${clockOf(at)}`;
}

/** Faixas absolutas (ms) que cobrem o dia local de `dayStart` e vizinhos. */
function windows(hours: StoreHours[], dayStart: number, weekday: number) {
  const out: { start: number; end: number }[] = [];
  // Faixas que começam no dia anterior e passam da meia-noite também contam.
  for (const offset of [-1, 0]) {
    const day = (weekday + offset + 7) % 7;
    const base = dayStart + offset * DAY_MS;
    for (const h of hours.filter((x) => x.weekday === day)) {
      const start = clockMinutes(h.start)!;
      const endRaw = clockMinutes(h.end)!;
      const end =
        endRaw === 0 ? 1440 : endRaw <= start ? endRaw + 1440 : endRaw;
      out.push({
        start: base + start * MINUTE_MS,
        end: base + end * MINUTE_MS,
      });
    }
  }
  return out;
}

const localDayStart = (at: number) =>
  Math.floor((at - BRASILIA_OFFSET_MS) / DAY_MS) * DAY_MS + BRASILIA_OFFSET_MS;
const localWeekday = (at: number) =>
  new Date(at - BRASILIA_OFFSET_MS).getUTCDay();

export interface StoreState {
  open: boolean;
  /** open | paused | closed (fora do horário). */
  reason: "open" | "paused" | "closed";
  /** Fim da faixa atual (aberta) ou null. */
  closes_at: number | null;
  /** Próxima abertura (fechada pelo horário) ou null. */
  opens_at: number | null;
}

/** Loja aberta em `at`? Pausa manual vence o horário. */
export function storeState(
  cfg: PedidoConfig,
  at: number,
  paused = false,
): StoreState {
  if (paused)
    return { open: false, reason: "paused", closes_at: null, opens_at: null };
  if (!cfg.hours.length)
    return { open: true, reason: "open", closes_at: null, opens_at: null };
  const today = localDayStart(at),
    weekday = localWeekday(at);
  const current = windows(cfg.hours, today, weekday).filter(
    (w) => w.start <= at && at < w.end,
  );
  if (current.length)
    return {
      open: true,
      reason: "open",
      closes_at: Math.max(...current.map((w) => w.end)),
      opens_at: null,
    };
  let opens: number | null = null;
  for (let i = 0; i <= 7 && opens === null; i++) {
    const day = today + i * DAY_MS;
    const starts = windows(cfg.hours, day, (weekday + i) % 7)
      .map((w) => w.start)
      .filter((s) => s > at);
    if (starts.length) opens = Math.min(...starts);
  }
  return { open: false, reason: "closed", closes_at: null, opens_at: opens };
}

/** "hoje às 18:00", "amanhã às 11:00" ou "sábado às 17:00". */
export function whenLabel(target: number, at: number) {
  const days = Math.round((localDayStart(target) - localDayStart(at)) / DAY_MS);
  const day =
    days === 0
      ? "hoje"
      : days === 1
        ? "amanhã"
        : WEEKDAYS[localWeekday(target)];
  return `${day} às ${clockOf(target)}`;
}

/** Horário em texto, dias seguidos com as mesmas faixas juntos. */
export function hoursText(cfg: PedidoConfig) {
  if (!cfg.hours.length) return "Sem horário definido.";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const label = (day: number) =>
    cfg.hours
      .filter((h) => h.weekday === day)
      .map((h) => `${h.start} às ${h.end}`)
      .join(" e ");
  const lines: string[] = [];
  let i = 0;
  while (i < order.length) {
    const ranges = label(order[i]);
    let j = i;
    while (j + 1 < order.length && label(order[j + 1]) === ranges) j++;
    const days =
      i === j
        ? SHORT[order[i]]
        : j === i + 1
          ? `${SHORT[order[i]]} e ${SHORT[order[j]].toLowerCase()}`
          : `${SHORT[order[i]]} a ${SHORT[order[j]].toLowerCase()}`;
    lines.push(`${days}: ${ranges || "fechado"}`);
    i = j + 1;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Valores e textos

/** "R$ 1.234,56" */
export function money(cents: number) {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

export function fill(template: string, values: Record<string, string>) {
  return template
    .replace(/\{(\w+)\}/g, (all, key) =>
      Object.hasOwn(values, key) ? values[key] : all,
    )
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Prazo da retirada e da entrega para a página do carrinho. */
export function etaText(cfg: PedidoConfig) {
  const parts: string[] = [];
  if (cfg.pickup && cfg.pickup_minutes)
    parts.push(`Retirada em cerca de ${cfg.pickup_minutes} min`);
  if (cfg.delivery && cfg.delivery_minutes)
    parts.push(`Entrega em cerca de ${cfg.delivery_minutes} min`);
  return parts.join(" · ");
}

/** Só dígitos, com 55 quando o número veio sem DDI (10 ou 11 dígitos). */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}
