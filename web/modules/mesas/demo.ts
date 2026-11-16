// Mesas na demonstração (/app?demo=1, web/lib/demo.ts): o salão da
// Lanchonete da Ana com mesas livres, ocupadas e uma fechando, os pedidos na
// cozinha (do demo do Pedido) e uma conta com pagamento parcial. Mesmos
// formatos de GET /mesas, /mesas/tabs, /mesas/tabs/:id e /mesas/tabs/:id/bill.
import type { Row } from "../../lib/api";
import { tableOrders } from "../pedido/demo";

const M = 60_000;
const t = (ago: number) => Date.now() - ago;

export const mesasDemoModule: Row = {
  id: "mesas",
  name: "Mesas",
  version: "1.0.0",
  description:
    "Mesas e comandas com conta aberta pelo garçom no celular: lança os itens do cardápio para o quadro da cozinha, transfere e junta mesas, divide a conta, cobra a taxa de serviço e fecha com a forma de pagamento.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  requires: ["pedido"],
  navigation: [{ id: "mesas", label: "Mesas", place: "admin", admin: false }],
  menu_item_types: [],
};

export const mesasDemoConfig: Row = {
  service_percent: 10,
  service_default: true,
  split_max: 20,
};

const tables: Row[] = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    id: `mesa-${n}`,
    name: `Mesa ${n}`,
    kind: "table",
    section: "Salão",
    seats: 4,
    position: n,
  })),
  ...[7, 8].map((n) => ({
    id: `mesa-${n}`,
    name: `Mesa ${n}`,
    kind: "table",
    section: "Varanda",
    seats: 2,
    position: n,
  })),
  ...[10, 11].map((n) => ({
    id: `comanda-${n}`,
    name: `Comanda ${n}`,
    kind: "card",
    section: "Bar",
    seats: 0,
    position: n,
  })),
];

const payments: Row[] = [
  {
    id: "pag-1",
    tab_id: "conta-13",
    method: "pix",
    method_label: "Pix",
    amount_cents: 3900,
    tendered_cents: null,
    change_cents: null,
    note: "",
    status: "ok",
    created_by: "demo-ana",
    created: t(4 * M),
    voided_by: null,
    voided_at: null,
    void_reason: null,
  },
];

function tab(
  id: string,
  number: number,
  tableId: string,
  status: "open" | "closing",
  guests: number,
  minutes: number,
): Row {
  const table = tables.find((x) => x.id === tableId)!;
  const orders = tableOrders.filter((o) => o.table.tab_id === id);
  const live = orders.filter((o) => o.status !== "cancelled");
  const subtotal = live.reduce((s, o) => s + o.total_cents, 0);
  const service = Math.round(subtotal / 10);
  const paid = payments
    .filter((p) => p.tab_id === id && p.status === "ok")
    .reduce((s, p) => s + p.amount_cents, 0);
  return {
    id,
    number,
    status,
    status_label: status === "closing" ? "Conta pedida" : "Aberta",
    table: { id: table.id, name: table.name },
    guests,
    customer_name: "",
    note: "",
    waiter_id: "demo-ana",
    bill: {
      subtotal_cents: subtotal,
      service_on: true,
      service_percent: 10,
      service_cents: service,
      total_cents: subtotal + service,
      paid_cents: paid,
      due_cents: Math.max(0, subtotal + service - paid),
      overpaid_cents: 0,
    },
    item_count: live.reduce((s, o) => s + o.item_count, 0),
    orders_count: live.length,
    kitchen_count: live.filter((o) =>
      ["received", "preparing"].includes(o.status),
    ).length,
    ready_count: live.filter((o) => o.status === "ready").length,
    opened_by: "demo-ana",
    opened_at: t(minutes * M),
    minutes_open: minutes,
    bill_requested_at: status === "closing" ? t(6 * M) : null,
    closed_by: null,
    closed_at: null,
    merged_into: null,
    cancel_reason: null,
    created: t(minutes * M),
    updated: t(2 * M),
  };
}

const tabs: Row[] = [
  tab("conta-12", 12, "mesa-2", "open", 3, 48),
  tab("conta-13", 13, "mesa-5", "closing", 3, 70),
  tab("conta-14", 14, "comanda-10", "open", 1, 15),
];

const lines = (orders: Row[]) => {
  const out = new Map<string, Row>();
  for (const o of orders)
    for (const l of o.lines) {
      const options = l.options.map((x: Row) => x.name);
      const key = JSON.stringify([l.name, options, l.note]);
      const cur = out.get(key);
      if (cur) {
        cur.quantity += l.quantity;
        cur.total_cents += l.total_cents;
      } else
        out.set(key, {
          name: l.name,
          options,
          note: l.note,
          quantity: l.quantity,
          unit_cents: l.unit_cents,
          total_cents: l.total_cents,
        });
    }
  return [...out.values()];
};

const brl = (cents: number) =>
  "R$ " + (cents / 100).toFixed(2).replace(".", ",");
const pair = (left: string, right: string) =>
  left + " ".repeat(Math.max(1, 32 - left.length - right.length)) + right;

function billText(x: Row, people: number) {
  const b = x.bill;
  const items = lines(tableOrders.filter((o) => o.table.tab_id === x.id));
  const out = [
    "       LANCHONETE DA ANA",
    "  Rua das Flores, 100 — Centro",
    "-".repeat(32),
    pair(`CONTA Nº ${x.number}`, ""),
    `${x.table.name.toUpperCase()} · ${x.guests} pessoas`,
    "-".repeat(32),
    ...items.flatMap((l) => [
      pair(`${l.quantity}x ${l.name}`, brl(l.total_cents)),
      ...l.options.map((o: string) => `   + ${o}`),
      ...(l.note ? [`   Obs: ${l.note}`] : []),
    ]),
    "-".repeat(32),
    pair("Subtotal", brl(b.subtotal_cents)),
    pair("Serviço (10%)", brl(b.service_cents)),
    pair("TOTAL", brl(b.total_cents)),
    ...(b.paid_cents
      ? [
          pair("Pago (Pix)", brl(b.paid_cents)),
          pair("A PAGAR", brl(b.due_cents)),
        ]
      : []),
  ];
  if (people >= 2) {
    const base = b.paid_cents ? b.due_cents : b.total_cents;
    const share = Math.floor(base / people);
    const rest = base - share * people;
    out.push("-".repeat(32), `Dividido por ${people}:`);
    if (rest) out.push(pair(`${rest} pessoas`, `${brl(share + 1)} cada`));
    out.push(pair(`${people - rest} pessoas`, `${brl(share)} cada`));
  }
  out.push("-".repeat(32), "     Não é documento fiscal");
  return out.join("\n");
}

/** Leituras do módulo Mesas na demonstração (`rest` sem /profiles/{p}/). */
export function mesasDemo(rest: string, query: URLSearchParams): any {
  if (rest === "mesas") {
    const view = tables.map((table) => {
      const open = tabs.find((x) => x.table.id === table.id);
      const state = !open
        ? "free"
        : open.status === "closing"
          ? "closing"
          : "occupied";
      return {
        ...table,
        state,
        state_label: {
          free: "Livre",
          occupied: "Ocupada",
          closing: "Fechando",
        }[state],
        tab: open || null,
      };
    });
    return {
      generated_at: Date.now(),
      config: mesasDemoConfig,
      counts: {
        free: view.filter((x) => x.state === "free").length,
        occupied: view.filter((x) => x.state === "occupied").length,
        closing: view.filter((x) => x.state === "closing").length,
      },
      sections: ["Salão", "Varanda", "Bar"],
      tables: view,
    };
  }
  if (rest === "mesas/tabs") return { data: tabs, next_cursor: null };
  const bill = rest.match(/^mesas\/tabs\/([^/]+)\/bill$/);
  if (bill) {
    const x = tabs.find((y) => y.id === bill[1]) || tabs[0];
    const people = Number(query.get("split")) || 0;
    return {
      tab: x,
      lines: lines(tableOrders.filter((o) => o.table.tab_id === x.id)),
      payments: payments.filter((p) => p.tab_id === x.id),
      split: null,
      establishment: null,
      columns: 32,
      text: billText(x, people),
    };
  }
  const match = rest.match(/^mesas\/tabs\/([^/]+)$/);
  if (match) {
    const x = tabs.find((y) => y.id === match[1]) || tabs[0];
    return {
      ...x,
      orders: tableOrders.filter((o) => o.table.tab_id === x.id),
      payments: payments.filter((p) => p.tab_id === x.id),
      history: [
        {
          id: x.id + "-h1",
          kind: "opened",
          actor: "demo-ana",
          note: `Conta aberta para ${x.guests} pessoas.`,
          created: x.opened_at,
        },
        ...tableOrders
          .filter((o) => o.table.tab_id === x.id)
          .map((o) => ({
            id: o.id + "-h",
            kind: "order",
            actor: "demo-ana",
            note: `Pedido nº ${o.number} para a cozinha.`,
            created: o.created,
          })),
      ],
    };
  }
  return { data: [], next_cursor: null };
}
