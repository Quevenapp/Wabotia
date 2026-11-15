// Pedido pela equipe e pelas integrações: lista, quadro da cozinha, detalhe,
// pedido de balcão, dados internos, baixa de pagamento na hora e a forma de
// pagamento escolhida pela equipe. Escritas rodam como comandos (Coordinator,
// Idempotency-Key) registrados em ./pedido.ts.
import { all, exec, one } from "../../db";
import { ApiError, type Actor, json, now, requireValue } from "../../types";
import type { ModuleContext } from "../api";
import {
  addCartSlot,
  validateCartOrder,
  validateCatalog,
  type CartInput,
} from "../../web-cart";
import {
  ACTIVE_STATUSES,
  ALERT_STATUSES,
  PAYMENT_METHODS,
  STATUS_LABELS,
  isOnline,
  isStatus,
  money,
  phoneDigits,
  type AlertStatus,
  type OrderStatus,
  type PaymentMethod,
} from "./model";
import { cartCategories, loadMenu } from "./menu";
import { config, storeSituation } from "./store";
import {
  applyMethod,
  conversationOf,
  createOrder,
  loadOrder,
  orderHistory,
  orderView,
  sendSummary,
  type OrderSource,
} from "./orders";

const DAY_MS = 86_400_000;
const BRASILIA = 3 * 3_600_000;

const clipText = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return "";
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what}: até ${max} caracteres.`,
  );
  return (value as string).trim();
};

const sourceOf = (actor: Actor): OrderSource =>
  actor.kind === "user" && !actor.id.startsWith("bot:") ? "panel" : "api";

// ---------------------------------------------------------------------------
// Leitura

/** GET pedido/orders: filtros, busca e paginação pelo número. */
export async function listOrders(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  const statuses = (query.status || "").split(",").filter(Boolean);
  for (const s of statuses)
    requireValue(isStatus(s), `Estado desconhecido: ${s}.`);
  if (statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  } else if (query.open === "1" || query.open === "true") {
    where.push(`status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`);
    args.push(...ACTIVE_STATUSES);
  }
  if (query.conversation_id) {
    where.push("conversation_id=?");
    args.push(query.conversation_id);
  }
  if (query.phone) {
    where.push("phone=?");
    args.push(phoneDigits(query.phone));
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<"],
  ] as const)
    if (query[key]) {
      const at = Number(query[key]);
      requireValue(Number.isFinite(at), `${key} em milissegundos.`);
      where.push(`created${op}?`);
      args.push(at);
    }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like =
      "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const digits = /^[\d\s()+#º°nN.-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    where.push(
      "(lower(customer_name) LIKE ? ESCAPE '\\'" +
        (digits ? " OR number=?" : "") +
        (digits.length >= 4 ? " OR phone LIKE ?" : "") +
        ")",
    );
    args.push(like);
    if (digits) args.push(Number(digits));
    if (digits.length >= 4) args.push("%" + digits + "%");
  }
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        "SELECT status,count(*) AS n FROM pedido_orders WHERE profile_id=? GROUP BY status",
        ctx.profile,
      )
    ).map((r) => [r.status, r.n]),
  );
  const before = Number(query.cursor || query.before);
  if (Number.isInteger(before) && before > 0) {
    where.push("number<?");
    args.push(before);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM pedido_orders WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => orderView(row)),
    next_cursor: more ? String(page.at(-1)!.number) : null,
    counts,
  };
}

export async function orderDetail(ctx: ModuleContext, id: unknown) {
  const order = await loadOrder(ctx, id);
  return orderView(order, await orderHistory(ctx, order.id));
}

/** Início do dia em Brasília. */
const dayStart = (at: number) =>
  Math.floor((at - BRASILIA) / DAY_MS) * DAY_MS + BRASILIA;

/**
 * GET pedido/board: quadro da cozinha. Uma coluna por estado em andamento,
 * do mais antigo para o mais novo, com os minutos no estado e `late` quando
 * passou do alerta configurado; mais a situação da loja e o resumo do dia.
 */
export async function board(ctx: ModuleContext, at: number) {
  const cfg = await config(ctx);
  const rows = await all(
    ctx.env,
    `SELECT * FROM pedido_orders WHERE profile_id=? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ORDER BY status_at,number LIMIT 300`,
    ctx.profile,
    ...ACTIVE_STATUSES,
  );
  const since = dayStart(at);
  const today = await one(
    ctx.env,
    "SELECT count(*) orders,coalesce(sum(status='delivered'),0) delivered,coalesce(sum(status='cancelled'),0) cancelled,coalesce(sum(CASE WHEN status<>'cancelled' THEN total_cents ELSE 0 END),0) total_cents FROM pedido_orders WHERE profile_id=? AND created>=?",
    ctx.profile,
    since,
  );
  const store = await storeSituation(ctx, cfg, at);
  const card = (row: any) => {
    const minutes = Math.max(0, Math.floor((at - row.status_at) / 60_000));
    const alert = (ALERT_STATUSES as readonly string[]).includes(row.status)
      ? cfg.alerts[row.status as AlertStatus]
      : 0;
    return {
      ...orderView(row),
      minutes_in_status: minutes,
      // Atrasado: passou do alerta do estado ou, esperando pagamento, do prazo.
      late:
        row.status === "awaiting_payment"
          ? !!row.payment_due_at && row.payment_due_at <= at
          : !!alert && minutes >= alert,
    };
  };
  return {
    generated_at: at,
    store: {
      open: store.open,
      reason: store.reason,
      paused: store.paused,
      message: store.message,
    },
    columns: ACTIVE_STATUSES.map((status) => ({
      status,
      label: STATUS_LABELS[status],
      orders: rows.filter((r) => r.status === status).map(card),
    })),
    today: {
      since,
      orders: today?.orders || 0,
      delivered: today?.delivered || 0,
      cancelled: today?.cancelled || 0,
      total_cents: today?.total_cents || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Escritas da equipe

/** PATCH pedido/orders/:id: observações internas, nome e tempo estimado. */
export async function updateOrder(ctx: ModuleContext, actor: Actor, data: any) {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  const sets: Record<string, any> = {};
  if (Object.hasOwn(data, "notes"))
    sets.notes = clipText(data.notes, 2000, "Observações internas");
  if (Object.hasOwn(data, "customer_name"))
    sets.customer_name = clipText(data.customer_name, 80, "Nome do cliente");
  if (Object.hasOwn(data, "eta_minutes")) {
    requireValue(
      data.eta_minutes === null ||
        (Number.isInteger(data.eta_minutes) &&
          data.eta_minutes >= 0 &&
          data.eta_minutes <= 1440),
      "Tempo estimado: minutos de 0 a 1440.",
    );
    sets.eta_minutes = data.eta_minutes || null;
  }
  const changed = Object.keys(sets).filter((k) => sets[k] !== order[k]);
  if (!changed.length) return orderView(order);
  const at = now();
  await exec(
    ctx.env,
    `UPDATE pedido_orders SET ${changed.map((k) => k + "=?").join(",")},updated=? WHERE id=? AND profile_id=?`,
    ...changed.map((k) => sets[k]),
    at,
    order.id,
    ctx.profile,
  );
  await exec(
    ctx.env,
    "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) VALUES(?,?,?,'edit',?,?,?,?,?)",
    crypto.randomUUID(),
    ctx.profile,
    order.id,
    order.status,
    order.status,
    actor.id,
    "Alterado: " + changed.join(", "),
    at,
  );
  return orderView(await loadOrder(ctx, order.id));
}

/**
 * POST pedido/orders/:id/paid {note?}: a equipe registra o pagamento feito na
 * hora (dinheiro, maquininha) ou por fora depois de uma cobrança vencida ou
 * não gerada. Cobrança online aberta só é confirmada pelo provedor.
 */
export async function markPaid(ctx: ModuleContext, actor: Actor, data: any) {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  if (order.payment_status === "paid")
    throw new ApiError(
      409,
      "already_paid",
      `O pedido nº ${order.number} já está pago.`,
    );
  if (order.payment_status === "awaiting")
    throw new ApiError(
      409,
      "payment_online",
      `O pedido nº ${order.number} tem uma cobrança online aberta: o pagamento é confirmado pelo provedor.`,
    );
  if (order.status === "cancelled")
    throw new ApiError(409, "order_closed", "Pedido cancelado.");
  const note = clipText(data.note, 300, "Nota");
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE pedido_orders SET payment_status='paid',paid_at=?,paid_by=?,updated=? WHERE id=? AND profile_id=? AND updated=?",
    at,
    actor.id,
    at,
    order.id,
    ctx.profile,
    order.updated,
  );
  if (!result.meta.changes)
    throw new ApiError(
      409,
      "pedido_conflict",
      "O pedido mudou enquanto isso. Atualize e tente de novo.",
    );
  await exec(
    ctx.env,
    "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) VALUES(?,?,?,'payment',?,?,?,?,?)",
    crypto.randomUUID(),
    ctx.profile,
    order.id,
    order.status,
    order.status,
    actor.id,
    `Pagamento registrado pela equipe: ${money(order.total_cents)}${note ? ` (${note})` : ""}.`,
    at,
  );
  await ctx.publish(
    "pedido.paid",
    order.id,
    {
      order_id: order.id,
      number: order.number,
      payment_id: order.payment_id,
      amount_cents: order.total_cents,
      method: order.payment_method,
      manual: true,
      actor: actor.id,
      conversation_id: order.conversation_id,
    },
    { key: `paid:${order.id}` },
  );
  return orderView(await loadOrder(ctx, order.id));
}

/**
 * POST pedido/orders/:id/payment {method}: a equipe define a forma de
 * pagamento de um pedido que espera a escolha (cliente respondeu por
 * telefone, pedido de balcão). Online envia a cobrança na conversa.
 */
export async function setMethod(ctx: ModuleContext, actor: Actor, data: any) {
  ctx.access(actor, "conversations:write");
  requireValue(
    (PAYMENT_METHODS as readonly string[]).includes(data.method),
    "Forma de pagamento: pix, link, cash ou card.",
  );
  const order = await loadOrder(ctx, data.id);
  const c = await conversationOf(ctx, order);
  return orderView(
    await applyMethod(ctx, order, c, data.method as PaymentMethod, actor.id),
  );
}

// ---------------------------------------------------------------------------
// Pedido de balcão (POST pedido/orders)

/**
 * Linhas da API → campos da página de carrinho, para validar e calcular com a
 * mesma regra do núcleo (validateCartOrder): o mesmo item pode vir em várias
 * linhas, cada uma vira uma montagem (slot).
 */
export function linesToCartInput(
  catalog: ReturnType<typeof validateCatalog>,
  lines: any[],
): CartInput {
  requireValue(
    Array.isArray(lines) && lines.length >= 1 && lines.length <= 100,
    "Informe de 1 a 100 linhas (items).",
  );
  let input: CartInput = {};
  const slots = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    requireValue(
      line && typeof line.item_id === "string",
      `Linha ${index + 1}: informe item_id.`,
    );
    const item = catalog.categories
      .flatMap((c) => c.items)
      .find((i) => i.id === line.item_id);
    if (!item)
      throw new ApiError(
        404,
        "not_found",
        `Linha ${index + 1}: item não encontrado no cardápio.`,
      );
    const slot = slots.get(item.id) ?? 0;
    requireValue(slot < 10, `${item.name}: até 10 montagens por pedido.`);
    if (slot) input = addCartSlot(catalog, input, item.id);
    slots.set(item.id, slot + 1);
    const key = slot ? `${item.id}.${slot}` : item.id;
    requireValue(
      Number.isInteger(line.quantity) && line.quantity >= 1,
      `Linha ${index + 1}: quantidade inteira a partir de 1.`,
    );
    input[`q_${key}`] = [String(line.quantity)];
    const options = line.options ?? {};
    requireValue(
      options && typeof options === "object" && !Array.isArray(options),
      `Linha ${index + 1}: options no formato {"<group_id>": ["<option_id>"]}.`,
    );
    for (const [groupId, ids] of Object.entries(options))
      input[`o_${key}_${groupId}`] = (Array.isArray(ids) ? ids : [ids]).map(
        String,
      );
    if (line.note) input[`n_${key}`] = [String(line.note)];
  }
  return input;
}

/**
 * Pedido feito pela equipe ou por integração: itens do cardápio atual
 * (esgotado é recusado), valores calculados no servidor, sem pedido mínimo e
 * sem conferir o horário. Com conversa e forma online, a cobrança vai ao
 * cliente; na hora, vai para o preparo.
 */
export async function createFromApi(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  ctx.access(actor, "conversations:write");
  const cfg = await config(ctx);
  const categories = cartCategories(await loadMenu(ctx));
  if (!categories)
    throw new ApiError(
      409,
      "empty_menu",
      "Cadastre o cardápio antes de registrar pedidos.",
    );
  const fulfillment = data.fulfillment ?? (cfg.pickup ? "pickup" : "delivery");
  requireValue(
    fulfillment === "pickup" || fulfillment === "delivery",
    "fulfillment: pickup ou delivery.",
  );
  const catalog = validateCatalog({
    categories,
    fulfillment: {
      pickup: fulfillment === "pickup",
      delivery: fulfillment === "delivery",
      delivery_fee_cents:
        data.delivery_fee_cents === undefined
          ? cfg.delivery_fee_cents
          : data.delivery_fee_cents,
      minimum_cents: 0,
    },
  });
  const input = linesToCartInput(catalog, data.items);
  const address = data.address || {};
  Object.assign(input, {
    fulfillment: [fulfillment],
    name: [String(data.customer_name ?? "").trim() || "Cliente no balcão"],
    street: [String(address.street ?? "")],
    district: [String(address.district ?? "")],
    complement: [String(address.complement ?? "")],
    reference: [String(address.reference ?? "")],
    note: [String(data.note ?? "")],
  });
  const checked = validateCartOrder(catalog, input);
  if (!checked.ok)
    throw new ApiError(
      400,
      "invalid_request",
      Object.values(checked.errors).join(" "),
    );
  const c =
    data.conversation_id !== undefined && data.conversation_id !== null
      ? await ctx.conversation(String(data.conversation_id), actor)
      : null;
  const phone = clipText(data.phone, 40, "Telefone");
  requireValue(
    c || phoneDigits(phone).length >= 8 || data.customer_name,
    "Informe a conversa, o telefone ou o nome do cliente.",
  );
  const method = data.payment_method ?? null;
  requireValue(
    method === null || (PAYMENT_METHODS as readonly string[]).includes(method),
    "payment_method: pix, link, cash ou card.",
  );
  if (isOnline(method))
    requireValue(c, "Pagamento online precisa da conversa (conversation_id).");
  const order = checked.order;
  const { order: created, created: fresh } = await createOrder(ctx, {
    conversation: c,
    customer_name: order.customer_name,
    phone,
    source: sourceOf(actor),
    sourceKey: `command:${actor.id}:${requestId}`,
    lines: order.lines,
    item_count: order.item_count,
    subtotal_cents: order.subtotal_cents,
    delivery_fee_cents: order.delivery_fee_cents,
    total_cents: order.total_cents,
    fulfillment: order.fulfillment,
    address: order.address,
    note: order.note,
    notes: clipText(data.notes, 2000, "Observações internas"),
    actor: actor.id,
  });
  if (!fresh) return orderView(created);
  if (c && data.notify !== false) await sendSummary(ctx, c, created);
  const next = method
    ? await applyMethod(ctx, created, c, method as PaymentMethod, actor.id)
    : created;
  return orderView(await loadOrder(ctx, next.id));
}

export type { OrderStatus };
