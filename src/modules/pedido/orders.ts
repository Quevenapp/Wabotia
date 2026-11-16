// Pedido: pedidos (criar com número sequencial, ler, mudar estado), forma de
// pagamento, cobrança online pela Cobrança do núcleo e avisos ao cliente.
// Fala com o núcleo pela interface de src/modules/api.ts.
import { all, batch, exec, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import type { InteractiveSpec, ModuleContext } from "../api";
import type { Payment } from "../../payments";
import {
  ACTIVE_STATUSES,
  PAYMENT_LABELS,
  PAYMENT_TITLES,
  STATUS_LABELS,
  clockOf,
  fill,
  statusLabel,
  isOnline,
  isStatus,
  money,
  nextStatuses,
  phoneDigits,
  type Fulfillment,
  type OrderStatus,
  type PaymentMethod,
  type PedidoConfig,
  type TextKey,
} from "./model";
import { config, offeredMethods, paymentsReady } from "./store";
import { emitStatusChange, noticeHandled } from "./listeners";

/**
 * table: lançado pelo garçom numa conta de mesa (Mesas). bot: montado pelo
 * bot na conversa e confirmado pelo cliente no botão.
 */
export type OrderSource = "cart" | "catalog" | "panel" | "api" | "table" | "bot";

export interface OrderLine {
  item_id: string;
  slot: number;
  name: string;
  quantity: number;
  unit_cents: number;
  options: {
    group_id: string;
    group: string;
    id: string;
    name: string;
    price_cents: number;
  }[];
  note: string;
  total_cents: number;
}

export interface OrderAddress {
  street: string;
  district: string;
  complement: string;
  reference: string;
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  choosing: "Cliente escolhendo a forma de pagamento",
  pending: "Pagar na hora",
  awaiting: "Aguardando pagamento online",
  paid: "Pago",
  expired: "Cobrança vencida",
  failed: "Cobrança não gerada",
  refunded: "Estornado",
  cancelled: "Cobrança cancelada",
  // Pedido de mesa: pago no fechamento da conta (módulo Mesas).
  tab: "Na conta da mesa",
};

const notFound = () => new ApiError(404, "not_found", "Pedido não encontrado.");
const conflict = () =>
  new ApiError(
    409,
    "pedido_conflict",
    "O pedido mudou enquanto isso. Atualize e tente de novo.",
  );

const clip = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");

// ---------------------------------------------------------------------------
// Leitura

export function addressText(address: OrderAddress | null) {
  if (!address) return "";
  return [
    [address.street, address.district].filter(Boolean).join(" - "),
    address.complement,
  ]
    .filter(Boolean)
    .join(", ")
    .concat(address.reference ? ` (${address.reference})` : "");
}

/** Formato da API (docs/API.md, Pedido). */
export function orderView(row: any, history?: any[]) {
  const status = row.status as OrderStatus;
  const address: OrderAddress | null = row.address
    ? json(row.address, null)
    : null;
  const method = row.payment_method as PaymentMethod | null;
  return {
    id: row.id,
    number: row.number,
    status,
    status_label: statusLabel(status, row.fulfillment),
    status_at: row.status_at,
    customer: {
      name: row.customer_name,
      phone: row.phone,
      contact_id: row.contact_id,
      conversation_id: row.conversation_id,
    },
    source: row.source,
    web_step_id: row.web_step_id,
    fulfillment: row.fulfillment as Fulfillment,
    fulfillment_label:
      row.fulfillment === "delivery"
        ? "Entrega"
        : row.fulfillment === "table"
          ? row.table_label || "Mesa"
          : "Retirada",
    /** Pedido lançado numa conta de mesa (módulo Mesas); senão null. */
    table: row.tab_id
      ? {
          tab_id: row.tab_id as string,
          label: (row.table_label as string) || "",
        }
      : null,
    address,
    address_text: addressText(address),
    lines: json(row.lines, []) as OrderLine[],
    item_count: row.item_count,
    subtotal_cents: row.subtotal_cents,
    delivery_fee_cents: row.delivery_fee_cents,
    /** Desconto aprovado pela equipe (já descontado do total). */
    discount_cents: row.discount_cents || 0,
    total_cents: row.total_cents,
    note: row.note,
    notes: row.notes,
    eta_minutes: row.eta_minutes,
    /** Previsão: quando foi para o preparo + o tempo estimado. */
    eta_at:
      row.eta_minutes && row.confirmed_at
        ? row.confirmed_at + row.eta_minutes * 60_000
        : null,
    payment: {
      method,
      method_label: method ? PAYMENT_LABELS[method] : null,
      online: isOnline(method),
      status: row.payment_status,
      status_label:
        row.payment_status === "pending"
          ? row.fulfillment === "delivery"
            ? "Pagar na entrega"
            : "Pagar na retirada"
          : PAYMENT_STATUS_LABELS[row.payment_status] || row.payment_status,
      payment_id: row.payment_id,
      due_at: row.payment_due_at,
      paid_at: row.paid_at,
      paid_by: row.paid_by,
      error: row.payment_error,
      change_for_cents: row.change_for_cents,
      needs_refund: !!row.needs_refund,
    },
    next_statuses: nextStatuses(status, row.fulfillment),
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    confirmed_at: row.confirmed_at,
    preparing_at: row.preparing_at,
    ready_at: row.ready_at,
    dispatched_at: row.dispatched_at,
    delivered_at: row.delivered_at,
    cancelled_at: row.cancelled_at,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
    ...(history
      ? {
          history: history.map((h) => ({
            id: h.id,
            kind: h.kind,
            from_status: h.from_status,
            to_status: h.to_status,
            actor: h.actor,
            note: h.note,
            created: h.created,
          })),
        }
      : {}),
  };
}
export type OrderView = ReturnType<typeof orderView>;

/**
 * Visão para o ator (revisão M6): aplicação sem contacts:read não vê
 * telefone nem endereço; sem notes:read, não vê as notas internas nem as
 * notas do histórico. A observação do cliente (`note`, "sem cebola") fica.
 * Pessoas da equipe veem tudo.
 */
export function visibleOrder(
  ctx: ModuleContext,
  actor: Actor,
  view: OrderView,
): OrderView {
  const out: any = { ...view };
  if (!ctx.mayRead(actor, "contacts")) {
    const { phone: _phone, ...customer } = view.customer;
    out.customer = customer;
    delete out.address;
    delete out.address_text;
  }
  if (!ctx.mayRead(actor, "notes")) {
    delete out.notes;
    if (out.history)
      out.history = out.history.map(({ note: _note, ...h }: any) => h);
  }
  return out;
}

const isOrderView = (value: any) =>
  value &&
  typeof value === "object" &&
  typeof value.number === "number" &&
  value.customer &&
  typeof value.customer === "object" &&
  value.payment &&
  Array.isArray(value.lines);
/**
 * Aplica visibleOrder a toda visão de pedido dentro da resposta (quadro,
 * lista, detalhe, comanda e respostas dos comandos).
 */
export function visibleOrders<T>(
  ctx: ModuleContext,
  actor: Actor,
  value: T,
): T {
  if (ctx.mayRead(actor, "contacts") && ctx.mayRead(actor, "notes"))
    return value;
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (isOrderView(v)) return visibleOrder(ctx, actor, v);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}

export async function loadOrder(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  return row;
}

export const orderHistory = (ctx: ModuleContext, id: string) =>
  all(
    ctx.env,
    "SELECT * FROM pedido_history WHERE order_id=? AND profile_id=? ORDER BY created,rowid",
    id,
    ctx.profile,
  );

async function history(
  ctx: ModuleContext,
  order: any,
  kind: "created" | "status" | "payment" | "edit",
  actor: string,
  note: string,
  to: string | null = order.status,
) {
  await exec(
    ctx.env,
    "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) VALUES(?,?,?,?,?,?,?,?,?)",
    uid(),
    ctx.profile,
    order.id,
    kind,
    order.status,
    to,
    actor,
    note,
    now(),
  );
}

// ---------------------------------------------------------------------------
// Mensagens ao cliente

export async function conversationOf(ctx: ModuleContext, order: any) {
  if (!order.conversation_id) return null;
  try {
    const c = await ctx.conversation(order.conversation_id);
    return c.chat_type === "group" ? null : c;
  } catch {
    return null;
  }
}

export async function storeName(ctx: ModuleContext, cfg: PedidoConfig) {
  return cfg.store_name || (await ctx.establishment()).name || "Cardápio";
}
export async function pickupAddress(ctx: ModuleContext, cfg: PedidoConfig) {
  return cfg.pickup_address || (await ctx.establishment()).address || "";
}

async function values(
  ctx: ModuleContext,
  cfg: PedidoConfig,
  order: any,
  extra: Record<string, string> = {},
) {
  const address = await pickupAddress(ctx, cfg);
  return {
    numero: String(order.number),
    total: money(order.total_cents),
    estado: STATUS_LABELS[order.status as OrderStatus] || order.status,
    previsao: order.eta_minutes
      ? `Previsão: cerca de ${order.eta_minutes} min.`
      : "",
    endereco: address ? `Retire em ${address}.` : "",
    loja: await storeName(ctx, cfg),
    cliente: order.customer_name || "",
    motivo: order.cancel_reason || "",
    ...extra,
  };
}

/** Envia ao cliente, sem derrubar o fluxo quando a linha não aceita. */
async function say(
  ctx: ModuleContext,
  c: Conversation | null,
  text: string,
  key: string,
) {
  if (!c || !text.trim()) return null;
  try {
    return await ctx.sendMessage(
      c,
      { text: clip(text, 3800) },
      // Fora da janela, exige o consentimento de pedido (createOrder).
      { key, notification: true, purpose: "order" },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return null;
  }
}

/**
 * Mensagem configurável (Gestão → Cardápio e loja) ao cliente. Fora da
 * janela de 24 horas sai pelo modelo de notificação; vazia não envia.
 */
export async function notify(
  ctx: ModuleContext,
  order: any,
  textKey: TextKey,
  key: string,
  extra: Record<string, string> = {},
  /** Aviso de mudança de estado: outro módulo pode mandá-lo no lugar. */
  status?: OrderStatus,
) {
  const cfg = await config(ctx);
  const template = cfg.texts[textKey];
  if (!template) return null;
  const c = await conversationOf(ctx, order);
  const text = fill(template, await values(ctx, cfg, order, extra));
  if (
    status &&
    c &&
    (await noticeHandled(ctx.env, ctx.profile, {
      order: orderView(order),
      status,
      text,
      conversation_id: c.id,
      key,
    }))
  )
    return null;
  return say(ctx, c, text, key);
}

/** Pedido em texto: linhas, valores, entrega ou retirada (cliente e comanda). */
export function orderSummary(order: any) {
  const view = orderView(order);
  const lines = view.lines.map((line) => {
    const options = line.options.length
      ? ` (${line.options.map((o) => o.name).join(", ")})`
      : "";
    const note = line.note ? ` — ${line.note}` : "";
    return `${line.quantity}x ${line.name}${options}${note}: ${money(line.total_cents)}`;
  });
  return [
    ...lines,
    "",
    `Subtotal: ${money(view.subtotal_cents)}`,
    ...(view.fulfillment === "delivery"
      ? [`Entrega: ${money(view.delivery_fee_cents)}`]
      : []),
    ...(view.discount_cents
      ? [`Desconto: -${money(view.discount_cents)}`]
      : []),
    `Total: ${money(view.total_cents)}`,
    view.fulfillment === "delivery"
      ? `Entregar em: ${view.address_text}`
      : "Retirada no local",
    ...(view.note ? [`Observação: ${view.note}`] : []),
  ].join("\n");
}

export async function sendSummary(
  ctx: ModuleContext,
  c: Conversation,
  order: any,
) {
  const name = await storeName(ctx, await config(ctx));
  return say(
    ctx,
    c,
    `Pedido nº ${order.number} · ${name}\n\n${orderSummary(order)}`,
    `summary:${order.id}`,
  );
}

// ---------------------------------------------------------------------------
// Criar

export interface NewOrder {
  conversation: Conversation | null;
  customer_name: string;
  phone?: string;
  source: OrderSource;
  /** Repetir a mesma chave devolve o pedido já criado. */
  sourceKey: string;
  web_step_id?: string | null;
  lines: OrderLine[];
  item_count: number;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  fulfillment: Fulfillment;
  address: OrderAddress | null;
  note: string;
  notes?: string;
  actor: string;
  /**
   * Conta de mesa (módulo Mesas): o pedido nasce "Recebido", direto para a
   * cozinha, com o pagamento na conta da mesa (payment_status "tab").
   */
  tab?: { id: string; label: string };
}

/**
 * Cria o pedido em "Aguardando pagamento" com o próximo número da área (um
 * UPSERT com RETURNING, atômico no D1: pedidos simultâneos nunca repetem
 * número). A forma de pagamento vem depois (startPayment).
 */
export async function createOrder(ctx: ModuleContext, input: NewOrder) {
  const existing = await one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE source_key=?",
    input.sourceKey,
  );
  if (existing) return { order: existing, created: false };
  const c = input.conversation;
  if (c)
    requireValue(
      c.chat_type !== "group",
      "Pedidos só em conversas individuais.",
    );
  const contact = c ? await ctx.contact(c) : null;
  // Da conversa, só o telefone autenticado pelo canal (revisão M7).
  const phone = phoneDigits(
    input.phone || (c && ctx.verifiedPhone(c)) || contact?.phone || "",
  );
  const cfg = await config(ctx);
  const eta =
    input.fulfillment === "delivery"
      ? cfg.delivery_minutes
      : cfg.pickup_minutes;
  const tab = input.tab || null;
  const status: OrderStatus = tab ? "received" : "awaiting_payment";
  const counter = await one<{ last: number }>(
    ctx.env,
    "INSERT INTO pedido_counters(profile_id,last) VALUES(?,1) ON CONFLICT(profile_id) DO UPDATE SET last=last+1 RETURNING last",
    ctx.profile,
  );
  const id = uid(),
    at = now();
  const [inserted] = await batch(ctx.env, [
    [
      "INSERT INTO pedido_orders(id,profile_id,number,status,status_at,conversation_id,contact_id,customer_name,phone,source,source_key,web_step_id,lines,item_count,subtotal_cents,delivery_fee_cents,total_cents,fulfillment,address,note,notes,eta_minutes,payment_status,tab_id,table_label,confirmed_at,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING",
      [
        id,
        ctx.profile,
        counter!.last,
        status,
        at,
        c?.id || null,
        contact?.id || null,
        clip(input.customer_name || contact?.name || "", 80),
        phone,
        input.source,
        input.sourceKey,
        input.web_step_id || null,
        JSON.stringify(input.lines),
        input.item_count,
        input.subtotal_cents,
        input.delivery_fee_cents,
        input.total_cents,
        input.fulfillment,
        input.address ? JSON.stringify(input.address) : null,
        input.note || "",
        input.notes || "",
        eta || null,
        tab ? "tab" : "choosing",
        tab?.id || null,
        tab?.label || null,
        tab ? at : null,
        input.actor,
        at,
        at,
      ],
    ],
    [
      "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'created',NULL,?,?,?,? WHERE changes()=1",
      [
        uid(),
        ctx.profile,
        id,
        status,
        input.actor,
        tab
          ? `Pedido da ${tab.label} enviado para a cozinha.`
          : `Pedido criado (${input.source}).`,
        at,
      ],
    ],
  ]);
  if (!inserted.meta.changes)
    return {
      order: await one(
        ctx.env,
        "SELECT * FROM pedido_orders WHERE source_key=?",
        input.sourceKey,
      ),
      created: false,
    };
  const order = await loadOrder(ctx, id);
  // O cliente pediu pelo WhatsApp (carrinho ou catálogo): consentimento para
  // os avisos deste pedido fora da janela de 24 horas.
  if (
    c &&
    (input.source === "cart" ||
      input.source === "catalog" ||
      input.source === "bot")
  )
    await ctx.recordConsent(c, {
      purpose: "order",
      source: "whatsapp",
      evidence: { order_id: id, number: order.number, via: input.source },
      key: `order:${id}`,
    });
  await ctx.publish(
    "pedido.created",
    id,
    {
      order_id: id,
      number: order.number,
      source: order.source,
      fulfillment: order.fulfillment,
      total_cents: order.total_cents,
      item_count: order.item_count,
      conversation_id: order.conversation_id,
      contact_id: order.contact_id,
      phone: order.phone,
      tab_id: order.tab_id || null,
      table_label: order.table_label || null,
      actor: input.actor,
    },
    { key: `created:${id}` },
  );
  return { order, created: true };
}

// ---------------------------------------------------------------------------
// Estados

const STAMP: Partial<Record<OrderStatus, string>> = {
  preparing: "preparing_at",
  ready: "ready_at",
  out_for_delivery: "dispatched_at",
  delivered: "delivered_at",
  cancelled: "cancelled_at",
};

/**
 * Muda o estado com UPDATE condicionado ao estado e à versão lidos (outra
 * mudança no meio dá 409) e grava o histórico na mesma transação. Publica
 * pedido.status_changed e avisa o cliente com o texto do novo estado.
 */
export async function moveOrder(
  ctx: ModuleContext,
  order: any,
  to: OrderStatus,
  actor: string,
  note = "",
  extra: Record<string, any> = {},
  options: { notify?: boolean } = {},
) {
  const at = now();
  const sets: Record<string, any> = {
    status: to,
    status_at: at,
    updated: at,
    stale_notified_at: null,
    ...extra,
  };
  if (to === "received" && !order.confirmed_at) sets.confirmed_at = at;
  const stamp = STAMP[to];
  if (stamp) sets[stamp] = at;
  if (to === "cancelled") {
    sets.cancelled_by = actor;
    // Pago: a loja estorna pelo painel do provedor. Cobrança online aberta é
    // cancelada logo abaixo (ctx.cancelCharge); se o cliente pagar mesmo
    // assim, vira pedido.payment_late.
    if (order.payment_status === "paid") sets.needs_refund = 1;
    if (["choosing", "pending", "failed"].includes(order.payment_status))
      sets.payment_status = "cancelled";
  }
  const keys = Object.keys(sets);
  const historyId = uid();
  const [update] = await batch(ctx.env, [
    [
      `UPDATE pedido_orders SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND profile_id=? AND status=? AND updated=?`,
      [
        ...keys.map((k) => sets[k]),
        order.id,
        ctx.profile,
        order.status,
        order.updated,
      ],
    ],
    [
      "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'status',?,?,?,?,? WHERE changes()=1",
      [historyId, ctx.profile, order.id, order.status, to, actor, note, at],
    ],
  ]);
  if (!update.meta.changes) throw conflict();
  if (
    to === "cancelled" &&
    order.payment_status === "awaiting" &&
    order.payment_id
  )
    try {
      await ctx.cancelCharge(order.payment_id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  return announceMove(
    ctx,
    order.id,
    order.status,
    to,
    actor,
    note,
    historyId,
    options,
  );
}

/**
 * Evento e aviso de uma mudança de estado já gravada, com chave pelo
 * histórico: repetir não duplica.
 */
async function announceMove(
  ctx: ModuleContext,
  orderId: string,
  from: string,
  to: OrderStatus,
  actor: string,
  note: string,
  historyId: string,
  options: { notify?: boolean } = {},
) {
  const next = await loadOrder(ctx, orderId);
  await ctx.publish(
    "pedido.status_changed",
    orderId,
    {
      order_id: orderId,
      number: next.number,
      from,
      to,
      actor,
      note,
      conversation_id: next.conversation_id,
      fulfillment: next.fulfillment,
      tab_id: next.tab_id || null,
    },
    { key: `status:${historyId}` },
  );
  if (options.notify !== false)
    await notify(
      ctx,
      next,
      to as TextKey,
      `status:${orderId}:${historyId}`,
      {},
      to,
    );
  // Outros módulos (Entrega) acompanham a mudança: com a chave do histórico
  // na mão, um anúncio repetido chega de novo e o gancho ignora.
  await emitStatusChange(ctx.env, ctx.profile, {
    order: orderView(next),
    from: from as OrderStatus,
    to,
    actor,
    note,
  });
  return next;
}

/**
 * Gancho de pagamento repetido (segunda conferência, A3): a mudança de
 * estado já foi gravada pela primeira vez, mas o evento ou o aviso podem ter
 * se perdido numa falha depois da gravação. Refaz os dois pelo histórico.
 */
async function reannounceMove(
  ctx: ModuleContext,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
) {
  const row = await one(
    ctx.env,
    "SELECT id,actor,note FROM pedido_history WHERE order_id=? AND profile_id=? AND kind='status' AND from_status=? AND to_status=? ORDER BY created DESC LIMIT 1",
    orderId,
    ctx.profile,
    from,
    to,
  );
  if (row)
    await announceMove(ctx, orderId, from, to, row.actor, row.note, row.id);
}

/** POST pedido/orders/:id/status {status, note?, reason?}: transições da equipe. */
export async function changeStatus(
  ctx: ModuleContext,
  order: any,
  to: unknown,
  actor: string,
  data: { note?: unknown; reason?: unknown; notify?: unknown } = {},
) {
  requireValue(isStatus(to), "Estado desconhecido.");
  const note = typeof data.note === "string" ? clip(data.note.trim(), 500) : "";
  if (!nextStatuses(order.status, order.fulfillment).includes(to))
    throw new ApiError(
      409,
      "invalid_transition",
      `Não é possível passar de "${STATUS_LABELS[order.status as OrderStatus]}" para "${STATUS_LABELS[to]}".`,
    );
  const extra: Record<string, any> = {};
  if (to === "cancelled") {
    const reason =
      typeof data.reason === "string" ? clip(data.reason.trim(), 300) : "";
    extra.cancel_reason = reason || "Cancelado pela loja.";
  }
  return moveOrder(
    ctx,
    order,
    to,
    actor,
    note || extra.cancel_reason || "",
    extra,
    {
      notify: data.notify !== false,
    },
  );
}

// ---------------------------------------------------------------------------
// Forma de pagamento e cobrança

/** Pergunta "Como você quer pagar?" com as formas oferecidas. */
export function paymentSpec(
  order: any,
  methods: PaymentMethod[],
): InteractiveSpec {
  const body = `Como você quer pagar o pedido nº ${order.number} (${money(order.total_cents)})?`;
  const id = (method: PaymentMethod) => `pedido:pay:${order.id}:${method}`;
  return methods.length <= 3
    ? {
        type: "button",
        body,
        buttons: methods.map((method) => ({
          id: id(method),
          title: PAYMENT_TITLES[method],
          description: PAYMENT_LABELS[method],
        })),
      }
    : {
        type: "list",
        body,
        button: "Escolher",
        sections: [
          {
            rows: methods.map((method) => ({
              id: id(method),
              title: PAYMENT_TITLES[method],
              description: PAYMENT_LABELS[method],
            })),
          },
        ],
      };
}

export async function saveChat(
  ctx: ModuleContext,
  c: Conversation,
  step: "payment" | "change" | "fulfillment" | "address" | "confirm",
  orderId: string | null,
  data: Record<string, unknown>,
  ttlMinutes: number,
) {
  await exec(
    ctx.env,
    "INSERT INTO pedido_chats(conversation_id,profile_id,step,order_id,data,expires_at,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET profile_id=excluded.profile_id,step=excluded.step,order_id=excluded.order_id,data=excluded.data,expires_at=excluded.expires_at,updated=excluded.updated",
    c.id,
    ctx.profile,
    step,
    orderId,
    JSON.stringify(data),
    now() + ttlMinutes * 60_000,
    now(),
  );
}
export const clearChat = (ctx: ModuleContext, conversationId: string) =>
  exec(
    ctx.env,
    "DELETE FROM pedido_chats WHERE conversation_id=? AND profile_id=?",
    conversationId,
    ctx.profile,
  );

/**
 * Pergunta de novo como pagar, com o total atual do pedido (depois de um
 * desconto aprovado, por exemplo): escolher a forma é o cliente confirmar o
 * novo total.
 */
export async function askPaymentAgain(
  ctx: ModuleContext,
  c: Conversation,
  order: any,
  key: string,
) {
  const cfg = await config(ctx);
  const methods = await offeredMethods(ctx, cfg);
  if (!methods.length) return;
  await askPayment(ctx, c, order, methods, cfg, key);
}

async function askPayment(
  ctx: ModuleContext,
  c: Conversation,
  order: any,
  methods: PaymentMethod[],
  cfg: PedidoConfig,
  key: string,
) {
  await saveChat(ctx, c, "payment", order.id, { methods }, cfg.payment_minutes);
  try {
    await ctx.sendInteractive(c, paymentSpec(order, methods), {
      key,
      notification: true,
      purpose: "order",
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
}

/**
 * Depois de criar o pedido: com uma forma só, aplica direto; com várias,
 * pergunta ao cliente no WhatsApp. Sem conversa (pedido de balcão), fica para
 * a equipe escolher.
 */
export async function startPayment(
  ctx: ModuleContext,
  order: any,
  c: Conversation | null,
  options: {
    actor: string;
    method?: PaymentMethod | null;
    /** Troco já informado na página (null = sem troco); ausente: pergunta. */
    change?: number | null;
  } = {
    actor: "system",
  },
) {
  const cfg = await config(ctx);
  if (options.method)
    return applyMethod(
      ctx,
      order,
      c,
      options.method,
      options.actor,
      options.change,
    );
  if (!c) return order;
  const methods = await offeredMethods(ctx, cfg);
  if (methods.length === 1)
    return applyMethod(ctx, order, c, methods[0], options.actor);
  if (!methods.length)
    return paymentFailed(
      ctx,
      order,
      c,
      null,
      "Nenhuma forma de pagamento disponível (a Cobrança não está configurada).",
    );
  await askPayment(ctx, c, order, methods, cfg, `pay-question:${order.id}`);
  return order;
}

async function paymentFailed(
  ctx: ModuleContext,
  order: any,
  c: Conversation | null,
  method: PaymentMethod | null,
  reason: string,
) {
  const cfg = await config(ctx);
  // Pagamento que chegou no meio não volta a "falhou" (conferência N-12).
  const failed = await exec(
    ctx.env,
    "UPDATE pedido_orders SET payment_status='failed',payment_error=?,updated=? WHERE id=? AND profile_id=? AND payment_status NOT IN ('paid','refunded')",
    clip(reason, 300),
    now(),
    order.id,
    ctx.profile,
  );
  if (!failed.meta?.changes) return loadOrder(ctx, order.id);
  await history(
    ctx,
    order,
    "payment",
    "system",
    `Cobrança não gerada: ${reason}`,
  );
  await ctx.publish(
    "pedido.payment_failed",
    order.id,
    {
      order_id: order.id,
      number: order.number,
      method,
      reason,
      conversation_id: order.conversation_id,
    },
    { key: `payment_failed:${order.id}:${method || "none"}` },
  );
  const fresh = await loadOrder(ctx, order.id);
  if (!c) return fresh;
  const offline = (await offeredMethods(ctx, cfg)).filter((m) => !isOnline(m));
  if (offline.length) {
    await say(
      ctx,
      c,
      "Não foi possível gerar o pagamento online agora. Escolha outra forma de pagar:",
      `pay-failed:${order.id}:${method || "none"}`,
    );
    await askPayment(
      ctx,
      c,
      fresh,
      offline,
      cfg,
      `pay-question:${order.id}:retry`,
    );
  } else
    await say(
      ctx,
      c,
      `Não foi possível gerar o pagamento do pedido nº ${order.number} agora. A equipe vai falar com você por aqui.`,
      `pay-failed:${order.id}:${method || "none"}`,
    );
  return fresh;
}

/** Forma de pagamento ainda pode ser escolhida (cliente ou equipe). */
export const choosable = (order: any) =>
  (ACTIVE_STATUSES as readonly string[]).includes(order.status) &&
  ["choosing", "failed"].includes(order.payment_status);

/**
 * Aplica a forma de pagamento escolhida. Na hora (dinheiro, maquininha): vai
 * para o preparo. Online (Pix, link): cobra pela Cobrança do núcleo; com
 * "preparo só depois de pago", espera o webhook confirmar.
 */
export async function applyMethod(
  ctx: ModuleContext,
  input: any,
  c: Conversation | null,
  method: PaymentMethod,
  actor: string,
  /** Troco informado na página do carrinho; undefined pergunta no chat. */
  change?: number | null,
) {
  const order = await loadOrder(ctx, input.id);
  // Pedido em andamento esperando a escolha, ou com a cobrança online não
  // gerada (pode já estar no preparo, sem "preparo só depois de pago").
  if (!choosable(order))
    throw new ApiError(
      409,
      "payment_chosen",
      `A forma de pagamento do pedido nº ${order.number} já foi definida.`,
    );
  const cfg = await config(ctx);
  if (c) await clearChat(ctx, c.id);
  if (!isOnline(method)) {
    const at = now();
    const result = await exec(
      ctx.env,
      "UPDATE pedido_orders SET payment_method=?,payment_status='pending',payment_error=NULL,payment_due_at=NULL,updated=? WHERE id=? AND profile_id=? AND updated=?",
      method,
      at,
      order.id,
      ctx.profile,
      order.updated,
    );
    if (!result.meta.changes) throw conflict();
    await history(
      ctx,
      order,
      "payment",
      actor,
      `Pagamento: ${PAYMENT_LABELS[method]}.`,
    );
    let next = await loadOrder(ctx, order.id);
    // Sem conversa para falar (ou quem pediu não atende a conversa, B9):
    // muda o estado sem avisar o cliente.
    if (next.status === "awaiting_payment")
      next = await moveOrder(
        ctx,
        next,
        "received",
        actor,
        `Pagamento na ${order.fulfillment === "delivery" ? "entrega" : "retirada"}.`,
        {},
        c ? {} : { notify: false },
      );
    if (method === "cash" && change !== undefined) {
      // Já respondido na página do carrinho.
      if (change)
        await exec(
          ctx.env,
          "UPDATE pedido_orders SET change_for_cents=?,updated=? WHERE id=? AND profile_id=?",
          change,
          now(),
          order.id,
          ctx.profile,
        );
      next = await loadOrder(ctx, order.id);
    } else if (method === "cash" && c) {
      await saveChat(ctx, c, "change", order.id, {}, 30);
      await say(
        ctx,
        c,
        `Vai precisar de troco? Responda com o valor que vai pagar (por exemplo, 100) ou NÃO.`,
        `change-question:${order.id}`,
      );
    }
    return next;
  }
  // Online: Cobrança pronta (o que a equipe resolve no painel) antes da
  // conversa, que é onde o cliente recebe a cobrança.
  if (!(await paymentsReady(ctx))) {
    if (!c)
      throw new ApiError(
        409,
        "payments_not_configured",
        "Configure a conta de pagamento em Gestão → Cobrança para cobrar Pix ou link.",
      );
    return paymentFailed(
      ctx,
      order,
      c,
      method,
      "A Cobrança não está configurada nesta área.",
    );
  }
  if (!c)
    throw new ApiError(
      409,
      "no_conversation",
      "Pagamento online precisa de uma conversa do WhatsApp para enviar a cobrança.",
    );
  const due = now() + cfg.payment_minutes * 60_000;
  const result = await exec(
    ctx.env,
    "UPDATE pedido_orders SET payment_method=?,payment_status='awaiting',payment_error=NULL,payment_due_at=?,updated=? WHERE id=? AND profile_id=? AND updated=?",
    method,
    due,
    now(),
    order.id,
    ctx.profile,
    order.updated,
  );
  if (!result.meta.changes) throw conflict();
  let current = await loadOrder(ctx, order.id);
  if (current.status !== "awaiting_payment") {
    // Já no preparo: só a cobrança.
  } else if (cfg.pay_before_prepare)
    await notify(ctx, current, "awaiting_payment", `awaiting:${order.id}`);
  else
    current = await moveOrder(
      ctx,
      current,
      "received",
      actor,
      "Para o preparo sem esperar o pagamento online.",
    );
  let payment: Payment;
  try {
    payment = await ctx.charge(c, {
      method: method as "pix" | "link",
      amount_cents: order.total_cents,
      description: clip(
        `Pedido nº ${order.number} · ${await storeName(ctx, cfg)}`,
        120,
      ),
      ref: order.id,
      sourceKey: `order:${order.id}:${method}`,
      expiresMinutes: cfg.payment_minutes,
      notification: true,
      actor: "system",
      // Pagar antes do preparo: o aviso "pedido recebido" do módulo já é o
      // comprovante. Sem isso, o "Pagamento recebido" do núcleo é o único.
      receipt: !cfg.pay_before_prepare,
    });
  } catch (error) {
    const reason =
      error instanceof ApiError
        ? error.message
        : "Falha ao falar com o provedor de pagamento.";
    if (!(error instanceof ApiError))
      console.error(
        JSON.stringify({
          component: "pedido",
          order: order.id,
          error: String((error as Error)?.message || error).slice(0, 300),
        }),
      );
    return paymentFailed(ctx, current, c, method, reason);
  }
  await exec(
    ctx.env,
    "UPDATE pedido_orders SET payment_id=?,payment_due_at=?,updated=? WHERE id=? AND profile_id=?",
    payment.id,
    payment.expires_at || due,
    now(),
    order.id,
    ctx.profile,
  );
  await history(
    ctx,
    current,
    "payment",
    actor,
    `Cobrança enviada: ${PAYMENT_LABELS[method]} · ${money(order.total_cents)}.`,
  );
  return loadOrder(ctx, order.id);
}

/**
 * Cobrança do pedido mudou (webhook do provedor já conferido pelo núcleo):
 * pago vai para o preparo; vencido ou cancelado cancela o pedido que esperava
 * o pagamento; estorno fica registrado. Repetições não fazem nada.
 */
export async function paymentUpdated(
  ctx: ModuleContext,
  payment: Payment,
  previous: string,
) {
  if (!payment.ref_id) return;
  const order = await one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!order) return;
  // Cobrança substituída e paga depois (conferência N-11): pendência para a
  // equipe estornar o valor a mais, em vez de ignorar.
  if (order.payment_id && order.payment_id !== payment.id) {
    if (payment.status === "paid") {
      await ctx.publish(
        "pedido.payment_late",
        order.id,
        {
          order_id: order.id,
          number: order.number,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
          needs_refund: true,
          reason: "replaced",
          conversation_id: order.conversation_id,
        },
        { key: `replaced:${payment.id}` },
      );
      if (order.conversation_id)
        try {
          await ctx.note(
            await ctx.conversation(order.conversation_id),
            `Uma cobrança antiga do pedido nº ${order.number} foi paga depois de substituída (${money(payment.amount_cents)}). Confira e estorne o valor a mais pelo Mercado Pago.`,
            { key: `replaced:${payment.id}` },
          );
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
    }
    return;
  }
  const at = now();
  if (payment.status === "paid") {
    const claimed = await exec(
      ctx.env,
      "UPDATE pedido_orders SET payment_status='paid',paid_at=?,paid_by='provider',payment_id=coalesce(payment_id,?),payment_error=NULL,needs_refund=CASE WHEN status='cancelled' THEN 1 ELSE needs_refund END,updated=? WHERE id=? AND payment_status<>'paid'",
      payment.paid_at || at,
      payment.id,
      at,
      order.id,
    );
    // Repetição do gancho (conferência A3): já marcado pago por este
    // pagamento, refaz os passos seguintes (todos com chave) em vez de sair;
    // uma falha no meio da primeira vez não deixa o pedido parado.
    // Pago à mão pela equipe e depois online (segunda conferência, N2-2): o
    // cliente pagou duas vezes. Não é repetição: vira pendência de estorno.
    if (
      !claimed.meta.changes &&
      order.payment_status === "paid" &&
      order.paid_by !== "provider"
    ) {
      await exec(
        ctx.env,
        "UPDATE pedido_orders SET needs_refund=1,updated=? WHERE id=? AND profile_id=?",
        at,
        order.id,
        ctx.profile,
      );
      await ctx.publish(
        "pedido.payment_late",
        order.id,
        {
          order_id: order.id,
          number: order.number,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
          needs_refund: true,
          reason: "paid_manually",
          conversation_id: order.conversation_id,
        },
        { key: `double:${payment.id}` },
      );
      if (order.conversation_id)
        try {
          await ctx.note(
            await ctx.conversation(order.conversation_id),
            `O pedido nº ${order.number} já tinha baixa manual e o cliente também pagou online (${money(payment.amount_cents)}). Confira e estorne um dos pagamentos pelo Mercado Pago.`,
            { key: `double:${payment.id}` },
          );
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
      return;
    }
    const repeat =
      !claimed.meta.changes &&
      order.payment_status === "paid" &&
      (!order.payment_id || order.payment_id === payment.id);
    if (!claimed.meta.changes && !repeat) return;
    if (claimed.meta.changes)
      await history(
        ctx,
        order,
        "payment",
        "provider",
        `Pagamento confirmado pelo provedor: ${money(payment.amount_cents)}.`,
      );
    await ctx.publish(
      "pedido.paid",
      order.id,
      {
        order_id: order.id,
        number: order.number,
        payment_id: payment.id,
        amount_cents: payment.amount_cents,
        method: order.payment_method,
        previous_payment_status: previous,
        conversation_id: order.conversation_id,
      },
      { key: `paid:${order.id}` },
    );
    const fresh = await loadOrder(ctx, order.id);
    if (fresh.status === "awaiting_payment")
      await moveOrder(
        ctx,
        fresh,
        "received",
        "provider",
        "Pagamento confirmado.",
      );
    else if (repeat && fresh.status === "received")
      await reannounceMove(ctx, order.id, "awaiting_payment", "received");
    else if (fresh.status === "cancelled") {
      await ctx.publish(
        "pedido.payment_late",
        order.id,
        {
          order_id: order.id,
          number: order.number,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
          needs_refund: true,
          conversation_id: order.conversation_id,
        },
        { key: `late:${order.id}` },
      );
      await say(
        ctx,
        await conversationOf(ctx, fresh),
        `O pagamento do pedido nº ${order.number} chegou depois que ele foi cancelado. A loja vai devolver o valor.`,
        `late:${order.id}`,
      );
    }
    return;
  }
  if (payment.status === "expired" || payment.status === "cancelled") {
    const claimed = await exec(
      ctx.env,
      "UPDATE pedido_orders SET payment_status=?,updated=? WHERE id=? AND payment_status='awaiting'",
      payment.status,
      at,
      order.id,
    );
    // Repetição do gancho (segunda conferência, A3): já marcada por esta
    // cobrança, refaz os passos seguintes em vez de sair; antes, uma falha
    // no meio deixava o pedido parado em awaiting_payment.
    const repeat =
      !claimed.meta.changes &&
      order.payment_status === payment.status &&
      (!order.payment_id || order.payment_id === payment.id);
    if (!claimed.meta.changes && !repeat) return;
    if (claimed.meta.changes)
      await history(
        ctx,
        order,
        "payment",
        "provider",
        payment.status === "expired"
          ? "Cobrança vencida sem pagamento."
          : "Cobrança cancelada.",
      );
    await ctx.publish(
      "pedido.payment_expired",
      order.id,
      {
        order_id: order.id,
        number: order.number,
        payment_id: payment.id,
        status: payment.status,
        order_status: order.status,
        conversation_id: order.conversation_id,
      },
      { key: `expired:${order.id}:${payment.id}` },
    );
    const fresh = await loadOrder(ctx, order.id);
    if (fresh.status === "awaiting_payment")
      await moveOrder(
        ctx,
        fresh,
        "cancelled",
        "system",
        "Pagamento não confirmado no prazo.",
        { cancel_reason: "Pagamento não confirmado no prazo." },
      );
    else if (repeat && fresh.status === "cancelled")
      await reannounceMove(ctx, order.id, "awaiting_payment", "cancelled");
    return;
  }
  if (payment.status === "refunded") {
    const claimed = await exec(
      ctx.env,
      "UPDATE pedido_orders SET payment_status='refunded',needs_refund=0,updated=? WHERE id=? AND payment_status<>'refunded'",
      at,
      order.id,
    );
    // Repetição (conferência A3): refaz cancelamento, evento e nota (com
    // chave) se a primeira vez falhou no meio.
    if (!claimed.meta.changes && order.payment_status !== "refunded") return;
    if (claimed.meta.changes)
      await history(ctx, order, "payment", "provider", "Pagamento estornado.");
    // Estorno ou contestação (revisão M8): pedido que ainda não foi para o
    // preparo é cancelado; já em preparo ou entregue, vira pendência para a
    // equipe (nota interna e needs_review no evento).
    const fresh = await loadOrder(ctx, order.id);
    const cancel = ["awaiting_payment", "received"].includes(fresh.status);
    const review = !cancel && fresh.status !== "cancelled";
    await ctx.publish(
      "pedido.refunded",
      order.id,
      {
        order_id: order.id,
        number: order.number,
        payment_id: payment.id,
        amount_cents: payment.amount_cents,
        conversation_id: order.conversation_id,
        order_status: fresh.status,
        needs_review: review,
      },
      { key: `refunded:${order.id}` },
    );
    if (cancel)
      await moveOrder(
        ctx,
        fresh,
        "cancelled",
        "provider",
        "Pagamento estornado.",
        { cancel_reason: "Pagamento estornado pelo provedor de pagamento." },
      );
    else if (review && fresh.conversation_id)
      try {
        await ctx.note(
          await ctx.conversation(fresh.conversation_id),
          `Pagamento do pedido nº ${fresh.number} estornado ou contestado com o pedido em "${STATUS_LABELS[fresh.status as OrderStatus] || fresh.status}". Confira com o cliente e com o Mercado Pago.`,
          { key: `refunded:${order.id}` },
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
  }
}

// ---------------------------------------------------------------------------
// Acompanhamento pelo cliente

/** Pedidos em andamento do cliente (conversa ou telefone). */
export async function openOrdersFor(ctx: ModuleContext, c: Conversation) {
  // Telefone só o autenticado pelo canal (revisão M7): em conversa de
  // integração, só os pedidos desta conversa.
  const phone = phoneDigits(ctx.verifiedPhone(c) || "");
  return all(
    ctx.env,
    `SELECT * FROM pedido_orders WHERE profile_id=? AND (conversation_id=? OR (phone<>'' AND phone=?)) AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ORDER BY number DESC LIMIT 5`,
    ctx.profile,
    c.id,
    phone,
    ...ACTIVE_STATUSES,
  );
}

export function trackLines(order: any) {
  const view = orderView(order);
  const lines = [
    `Pedido nº ${view.number} · ${view.status_label}`,
    `${view.item_count} ${view.item_count === 1 ? "item" : "itens"} · ${money(view.total_cents)} · ${view.fulfillment_label}`,
  ];
  if (view.payment.method)
    lines.push(
      `Pagamento: ${view.payment.method_label} (${view.payment.status_label.toLowerCase()})`,
    );
  else lines.push("Pagamento: aguardando a sua escolha");
  if (view.eta_at && ["received", "preparing"].includes(view.status))
    lines.push(`Previsão: ${clockOf(view.eta_at)}`);
  return lines.join("\n");
}
