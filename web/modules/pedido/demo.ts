// Pedido na demonstração (/app?demo=1, web/lib/demo.ts): uma lanchonete com
// cardápio, adicionais e pedidos em todos os estados do quadro da cozinha.
// Mesmos formatos de GET /pedido, /pedido/menu, /pedido/board,
// /pedido/orders e /pedido/orders/:id(/ticket).
import type { Row } from "../../lib/api";

const M = 60_000;
const t = (ago: number) => Date.now() - ago;

export const pedidoDemoModule: Row = {
  id: "pedido",
  name: "Pedido",
  version: "1.0.0",
  description:
    "Cardápio com fotos e adicionais, carrinho por link, pagamento por Pix, cartão ou na entrega, e o pedido acompanhado pelo WhatsApp e pelo quadro da cozinha.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  navigation: [
    { id: "pedidos", label: "Pedidos", place: "admin", admin: false },
    {
      id: "pedidos-cardapio",
      label: "Cardápio e loja",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    { type: "pedido_cardapio", label: "Cardápio" },
    { type: "pedido_acompanhar", label: "Acompanhar pedido" },
  ],
};

/** Regras da loja (chave "pedido" das configurações) na demonstração. */
export const pedidoDemoConfig: Row = {
  store_name: "Lanchonete da Ana",
  hours: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
    weekday,
    start: "11:00",
    end: "23:30",
  })),
  pickup: true,
  delivery: true,
  delivery_fee_cents: 700,
  minimum_cents: 2000,
  pickup_minutes: 20,
  delivery_minutes: 45,
  pickup_address: "Rua das Flores, 100 — Centro",
  payments: { pix: true, link: true, cash: true, card: true },
  pay_before_prepare: true,
  payment_minutes: 30,
  cart_minutes: 60,
  alerts: { received: 10, preparing: 40, ready: 60, out_for_delivery: 90 },
  texts: {},
};

const groups: Row[] = [
  {
    id: "ponto",
    name: "Ponto da carne",
    min: 1,
    max: 1,
    options: [
      { id: "mal", name: "Mal passada", price_cents: 0, available: true },
      { id: "ponto", name: "Ao ponto", price_cents: 0, available: true },
      { id: "bem", name: "Bem passada", price_cents: 0, available: true },
    ],
  },
  {
    id: "adicionais",
    name: "Adicionais",
    min: 0,
    max: 3,
    options: [
      { id: "bacon", name: "Bacon", price_cents: 500, available: true },
      { id: "ovo", name: "Ovo", price_cents: 300, available: true },
      { id: "cheddar", name: "Cheddar", price_cents: 400, available: false },
    ],
  },
  {
    id: "acai-tamanho",
    name: "Tamanho",
    min: 1,
    max: 1,
    options: [
      { id: "300", name: "300 ml", price_cents: 0, available: true },
      { id: "500", name: "500 ml", price_cents: 600, available: true },
    ],
  },
].map((g) => ({ ...g, created: t(30 * 24 * 60 * M), updated: t(60 * M) }));

const item = (
  id: string,
  category_id: string,
  name: string,
  price_cents: number,
  position: number,
  extra: Row = {},
): Row => ({
  id,
  category_id,
  name,
  description: "",
  price_cents,
  photo_media_id: null,
  image_url: null,
  available: true,
  max_quantity: 20,
  retailer_id: null,
  position,
  group_ids: [],
  created: t(30 * 24 * 60 * M),
  updated: t(60 * M),
  ...extra,
});

const categories: Row[] = [
  {
    id: "lanches",
    name: "Lanches",
    description: "Pão brioche e carne de 150 g",
    position: 0,
    items: [
      item("xburger", "lanches", "X-Burger", 2500, 0, {
        description: "Carne, queijo e molho da casa",
        group_ids: ["ponto", "adicionais"],
        retailer_id: "XB-01",
      }),
      item("xsalada", "lanches", "X-Salada", 2700, 1, {
        description: "Carne, queijo, alface e tomate",
        group_ids: ["ponto", "adicionais"],
      }),
      item("misto", "lanches", "Misto quente", 1200, 2, { available: false }),
    ],
  },
  {
    id: "acai",
    name: "Açaí",
    description: "",
    position: 1,
    items: [
      item("acai", "acai", "Açaí na tigela", 1800, 0, {
        description: "Com granola e banana",
        group_ids: ["acai-tamanho"],
      }),
    ],
  },
  {
    id: "bebidas",
    name: "Bebidas",
    description: "",
    position: 2,
    items: [
      item("suco", "bebidas", "Suco de laranja", 800, 0, {
        max_quantity: 5,
        retailer_id: "SUCO-500",
      }),
      item("refri", "bebidas", "Refrigerante lata", 600, 1),
    ],
  },
].map((c) => ({ ...c, created: t(30 * 24 * 60 * M), updated: t(60 * M) }));

const labels: Row = {
  awaiting_payment: "Aguardando pagamento",
  received: "Recebido",
  preparing: "Em preparo",
  ready: "Pronto para retirada",
  out_for_delivery: "Saiu para entrega",
  delivered: "Entregue",
  cancelled: "Cancelado",
};
const next = (status: string, fulfillment: string): string[] => {
  const done = fulfillment === "delivery" ? "out_for_delivery" : "ready";
  return (
    (
      {
        awaiting_payment: ["received", "cancelled"],
        received: ["preparing", done, "cancelled"],
        preparing: [done, "received", "cancelled"],
        ready: ["delivered", "preparing", "cancelled"],
        out_for_delivery: ["delivered", "preparing", "cancelled"],
      } as Row
    )[status] || []
  );
};
const paymentText: Row = {
  pix: "Pix",
  link: "Cartão pelo link de pagamento",
  cash: "Dinheiro na entrega ou retirada",
  card: "Cartão na maquininha",
};
const paymentStatus: Row = {
  choosing: "Cliente escolhendo a forma de pagamento",
  awaiting: "Aguardando pagamento online",
  paid: "Pago",
};

const line = (
  name: string,
  quantity: number,
  unit: number,
  options: [string, string, number][] = [],
  note = "",
  slot = 0,
) => ({
  item_id: name.toLowerCase().replace(/\W+/g, "-"),
  slot,
  name,
  quantity,
  unit_cents: unit + options.reduce((s, [, , p]) => s + p, 0),
  options: options.map(([group, optionName, price]) => ({
    group_id: group.toLowerCase(),
    group,
    id: optionName.toLowerCase(),
    name: optionName,
    price_cents: price,
  })),
  note,
  total_cents: (unit + options.reduce((s, [, , p]) => s + p, 0)) * quantity,
});

function order(
  number: number,
  status: string,
  minutes: number,
  customer: string,
  phone: string,
  fulfillment: "pickup" | "delivery",
  method: string | null,
  payment: string,
  lines: Row[],
  extra: Row = {},
): Row {
  const subtotal = lines.reduce((s, l) => s + l.total_cents, 0);
  const fee = fulfillment === "delivery" ? 700 : 0;
  const address =
    fulfillment === "delivery"
      ? {
          street: "Rua A, 10",
          district: "Centro",
          complement: "Apto 2",
          reference: "",
        }
      : null;
  return {
    id: "pedido-" + number,
    number,
    status,
    status_label: labels[status],
    status_at: t(minutes * M),
    customer: {
      name: customer,
      phone,
      contact_id: null,
      conversation_id: number === 42 ? "demo-1" : null,
    },
    source: "cart",
    web_step_id: null,
    fulfillment,
    fulfillment_label: fulfillment === "delivery" ? "Entrega" : "Retirada",
    address,
    address_text: address ? "Rua A, 10 - Centro, Apto 2" : "",
    // Quadro e detalhe: entregador e previsão (módulo Entrega).
    delivery:
      status === "out_for_delivery"
        ? {
            status: "en_route",
            status_label: "A caminho",
            courier_id: "demo-carlos",
            courier_name: "Carlos",
            eta_at: t(-12 * M),
            eta_minutes: 12,
            position_at: t(M),
          }
        : null,
    lines,
    item_count: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal_cents: subtotal,
    delivery_fee_cents: fee,
    total_cents: subtotal + fee,
    discount_cents: 0,
    note: "",
    notes: "",
    eta_minutes: fulfillment === "delivery" ? 45 : 20,
    eta_at:
      status === "awaiting_payment"
        ? null
        : t((minutes + 10) * M) + (fulfillment === "delivery" ? 45 : 20) * M,
    payment: {
      method,
      method_label: method ? paymentText[method] : null,
      online: method === "pix" || method === "link",
      status: payment,
      status_label:
        payment === "pending"
          ? fulfillment === "delivery"
            ? "Pagar na entrega"
            : "Pagar na retirada"
          : paymentStatus[payment] || payment,
      payment_id: null,
      due_at: payment === "awaiting" ? t(-20 * M) : null,
      paid_at: payment === "paid" ? t(minutes * M) : null,
      paid_by: payment === "paid" ? "provider" : null,
      error: null,
      change_for_cents: null,
      needs_refund: false,
    },
    next_statuses: next(status, fulfillment),
    cancel_reason:
      status === "cancelled" ? "Cliente desistiu pelo telefone." : null,
    cancelled_by: status === "cancelled" ? "demo-user" : null,
    confirmed_at: status === "awaiting_payment" ? null : t((minutes + 10) * M),
    preparing_at: null,
    ready_at: null,
    dispatched_at: null,
    delivered_at: status === "delivered" ? t(minutes * M) : null,
    cancelled_at: status === "cancelled" ? t(minutes * M) : null,
    created_by: "customer",
    created: t((minutes + 12) * M),
    updated: t(minutes * M),
    ...extra,
  };
}

const orders: Row[] = [
  order(
    47,
    "awaiting_payment",
    3,
    "Bruna Lima",
    "5511987650047",
    "delivery",
    "pix",
    "awaiting",
    [
      line("X-Salada", 2, 2700, [["Ponto da carne", "Ao ponto", 0]]),
      line("Refrigerante lata", 2, 600),
    ],
  ),
  order(
    46,
    "received",
    4,
    "Caio Martins",
    "5511987650046",
    "pickup",
    "card",
    "pending",
    [
      line(
        "Açaí na tigela",
        1,
        1800,
        [["Tamanho", "500 ml", 600]],
        "sem banana",
      ),
    ],
  ),
  order(
    45,
    "received",
    14,
    "Daniela Rocha",
    "5511987650045",
    "delivery",
    "cash",
    "pending",
    [
      line(
        "X-Burger",
        1,
        2500,
        [["Ponto da carne", "Mal passada", 0]],
        "sem cebola",
      ),
      line(
        "X-Burger",
        1,
        2500,
        [
          ["Ponto da carne", "Bem passada", 0],
          ["Adicionais", "Bacon", 500],
        ],
        "",
        1,
      ),
    ],
  ),
  order(
    44,
    "preparing",
    18,
    "Eduardo Alves",
    "5511987650044",
    "delivery",
    "link",
    "paid",
    [
      line("X-Salada", 1, 2700, [
        ["Ponto da carne", "Bem passada", 0],
        ["Adicionais", "Ovo", 300],
      ]),
      line("Suco de laranja", 1, 800),
    ],
  ),
  order(
    43,
    "ready",
    6,
    "Fernanda Souza",
    "5511987650043",
    "pickup",
    "pix",
    "paid",
    [line("Misto quente", 2, 1200)],
  ),
  order(
    42,
    "out_for_delivery",
    12,
    "Mariana Albuquerque",
    "5511987650001",
    "delivery",
    "cash",
    "pending",
    [
      line("X-Burger", 2, 2500, [
        ["Ponto da carne", "Ao ponto", 0],
        ["Adicionais", "Bacon", 500],
      ]),
      line("Refrigerante lata", 2, 600),
    ],
  ),
  order(
    41,
    "delivered",
    70,
    "Gustavo Reis",
    "5511987650041",
    "pickup",
    "card",
    "paid",
    [line("Açaí na tigela", 2, 1800, [["Tamanho", "300 ml", 0]])],
  ),
  order(
    40,
    "cancelled",
    95,
    "Helena Prado",
    "5511987650040",
    "delivery",
    "pix",
    "expired",
    [line("X-Burger", 1, 2500, [["Ponto da carne", "Ao ponto", 0]])],
  ),
];
// Pedido 45: dinheiro com troco para R$ 100,00.
orders[2].payment.change_for_cents = 10000;

const active = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
];
const alertMinutes: Row = pedidoDemoConfig.alerts;

const history = (o: Row): Row[] => [
  {
    id: o.id + "-h1",
    kind: "created",
    from_status: null,
    to_status: "awaiting_payment",
    actor: "customer",
    note: "Pedido criado (cart).",
    created: o.created,
  },
  ...(o.status !== "awaiting_payment"
    ? [
        {
          id: o.id + "-h2",
          kind: "status",
          from_status: "awaiting_payment",
          to_status: "received",
          actor: o.payment.status === "paid" ? "provider" : "customer",
          note:
            o.payment.status === "paid"
              ? "Pagamento confirmado."
              : "Pagamento na entrega.",
          created: o.created + 2 * M,
        },
      ]
    : []),
  ...(!["awaiting_payment", "received"].includes(o.status)
    ? [
        {
          id: o.id + "-h3",
          kind: "status",
          from_status: "received",
          to_status: o.status,
          actor: "demo-ana",
          note: "",
          created: o.status_at,
        },
      ]
    : []),
];

const ticket = (o: Row) =>
  [
    "       LANCHONETE DA ANA",
    "  Rua das Flores, 100 — Centro",
    "--------------------------------",
    `PEDIDO Nº ${o.number}`,
    `${o.fulfillment === "delivery" ? "ENTREGA" : "RETIRADA"} · ${o.status_label}`,
    "--------------------------------",
    ...o.lines.flatMap((l: Row) => [
      `${l.quantity}x ${l.name}`,
      ...l.options.map((op: Row) => `   + ${op.name}`),
      ...(l.note ? [`   Obs: ${l.note}`] : []),
    ]),
    "--------------------------------",
    `TOTAL: R$ ${(o.total_cents / 100).toFixed(2).replace(".", ",")}`,
    `Pagamento: ${o.payment.method_label || "a definir"}`,
    `Cliente: ${o.customer.name}`,
  ].join("\n");

/** Leituras do módulo Pedido na demonstração (`rest` já sem /profiles/{p}/). */
export function pedidoDemo(rest: string, query: URLSearchParams): any {
  if (rest === "pedido")
    return {
      config: pedidoDemoConfig,
      store: {
        open: true,
        reason: "open",
        paused: false,
        pause_message: "",
        paused_at: null,
        paused_by: null,
        closes_at: null,
        opens_at: null,
        message: "",
        hours_text: "Seg a dom: 11:00 às 23:30",
        eta: "Retirada em cerca de 20 min · Entrega em cerca de 45 min",
      },
      payments: {
        online_ready: true,
        offered: ["pix", "link", "cash", "card"],
      },
      menu: { categories: 3, items: 6, available_items: 5 },
    };
  if (rest === "pedido/menu") return { categories, groups, images: [] };
  if (rest === "pedido/board") {
    const at = Date.now();
    return {
      generated_at: at,
      store: { open: true, reason: "open", paused: false, message: "" },
      columns: active.map((status) => ({
        status,
        label: labels[status],
        orders: orders
          .filter((o) => o.status === status)
          .map((o) => {
            const minutes = Math.floor((at - o.status_at) / M);
            return {
              ...o,
              minutes_in_status: minutes,
              late: !!alertMinutes[status] && minutes >= alertMinutes[status],
            };
          }),
      })),
      today: {
        since: at - 12 * 60 * M,
        orders: orders.length,
        delivered: 1,
        cancelled: 1,
        total_cents: orders
          .filter((o) => o.status !== "cancelled")
          .reduce((s, o) => s + o.total_cents, 0),
      },
    };
  }
  if (rest === "pedido/orders") {
    const status = (query.get("status") || "").split(",").filter(Boolean),
      q = (query.get("q") || "").toLowerCase(),
      conversation = query.get("conversation_id");
    const counts: Row = {};
    for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
    return {
      data: orders.filter(
        (o) =>
          (!status.length || status.includes(o.status)) &&
          (query.get("open") !== "1" || active.includes(o.status)) &&
          (!conversation || o.customer.conversation_id === conversation) &&
          (!q ||
            String(o.number) === q ||
            `${o.customer.name} ${o.customer.phone}`.toLowerCase().includes(q)),
      ),
      next_cursor: null,
      counts,
    };
  }
  const ticketMatch = rest.match(/^pedido\/orders\/([^/]+)\/ticket$/);
  if (ticketMatch) {
    const o = orders.find((x) => x.id === ticketMatch[1]) || orders[0];
    return { columns: 32, establishment: null, order: o, text: ticket(o) };
  }
  const match = rest.match(/^pedido\/orders\/([^/]+)$/);
  if (match) {
    const o = orders.find((x) => x.id === match[1]) || orders[0];
    return { ...o, history: history(o) };
  }
  return { data: [], next_cursor: null };
}
