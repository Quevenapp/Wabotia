// Vendas: a venda. Criar a venda, numerar e baixar o estoque acontecem num
// só lote (transação do D1): sem saldo, nada é gravado (409 out_of_stock);
// repetida (mesma origem), devolve a mesma venda sem baixar de novo.
// Pagamento: dinheiro, cartão, Pix na chave da loja (confirmados pela equipe)
// ou Pix/link do Mercado Pago (ctx.charge, confirmado pelo webhook).
import { all, batch, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
import {
  ONLINE_METHODS,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  SALE_LABELS,
  SALE_STATUSES,
  cents,
  clip,
  customerDocument,
  fromMilli,
  milli,
  money,
  phoneDigits,
  text,
  vendasSettings,
  type PaymentMethod,
  type SaleStatus,
} from "./model";
import { applyTotals, buildLines, lineView, type Line } from "./lines";
import {
  outOfStock,
  stockAlerts,
  stockFailure,
  stockStatements,
  type StockChange,
} from "./stock";

export interface SalePayment {
  method: PaymentMethod;
  amount_cents: number;
}

// ---------------------------------------------------------------------------
// Visão

export function saleView(row: any) {
  const lines: Line[] = json(row.lines, []);
  const payments: SalePayment[] = json(row.payments, []);
  return {
    id: row.id as string,
    number: row.number as number,
    status: row.status as SaleStatus,
    status_label: SALE_LABELS[row.status as SaleStatus] || row.status,
    source: row.source as "panel" | "caixa" | "quote" | "api",
    quote_id: row.quote_id || null,
    session_id: row.session_id || null,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone || null,
      document: row.customer_document || null,
      contact_id: row.contact_id || null,
      conversation_id: row.conversation_id || null,
    },
    lines: lines.map(lineView),
    item_count: lines.length,
    subtotal_cents: row.subtotal_cents as number,
    discount_cents: row.discount_cents as number,
    sale_discount_cents: row.sale_discount_cents as number,
    total_cents: row.total_cents as number,
    payments: payments.map((p) => ({
      ...p,
      method_label: PAYMENT_LABELS[p.method] || p.method,
    })),
    paid_cents: row.paid_cents as number,
    change_cents: row.change_cents as number,
    payment: row.payment_id
      ? {
          id: row.payment_id,
          status: row.payment_status,
          pix_code: row.payment_pix_code || null,
          url: row.payment_url || null,
        }
      : null,
    needs_refund: !!row.needs_refund,
    refunded_cents: row.refunded_cents as number,
    fiscal_status: row.fiscal_status,
    note: row.note,
    notes: row.notes,
    created_by: row.created_by,
    created: row.created as number,
    updated: row.updated as number,
    completed_at: row.completed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    cancelled_by: row.cancelled_by ?? null,
    cancel_reason: row.cancel_reason || "",
  };
}
export type SaleView = ReturnType<typeof saleView>;

/**
 * Visão para o ator: aplicação sem contacts:read não vê telefone nem
 * documento do cliente; sem notes:read, não vê as observações internas.
 */
export function visibleSale<T extends Partial<SaleView>>(
  ctx: ModuleContext,
  actor: Actor,
  view: T,
): T {
  const out: any = { ...view };
  if (out.customer && !ctx.mayRead(actor, "contacts")) {
    const { phone: _p, document: _d, ...customer } = out.customer;
    out.customer = customer;
  }
  if (!ctx.mayRead(actor, "notes")) delete out.notes;
  return out;
}

export async function loadSale(ctx: ModuleContext, id: unknown) {
  const row = await one(
    ctx.env,
    "SELECT * FROM vendas_sales WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Venda não encontrada.");
  return row;
}

// ---------------------------------------------------------------------------
// Regras de quem pode cancelar e devolver; travas de outros módulos

const isAdmin = (actor: Actor) =>
  actor.kind === "user" && actor.role === "admin";

/** Aplicações: billing:write em toda escrita de venda (operação financeira). */
export function requireSeller(ctx: ModuleContext, actor: Actor) {
  if (actor.kind === "app") ctx.access(actor, "billing:write");
  else ctx.access(actor, "conversations:write");
}

export type SaleGuard = (
  ctx: ModuleContext,
  sale: any,
  action: "cancel" | "return",
  options: { session_id?: string | null },
) => Promise<void>;
const guards: SaleGuard[] = [];
/**
 * Trava registrada por um módulo dependente (o Caixa recusa cancelar venda de
 * sessão fechada). Lança ApiError para recusar.
 */
export function registerSaleGuard(guard: SaleGuard) {
  guards.push(guard);
}

async function mayUndo(
  ctx: ModuleContext,
  actor: Actor,
  sale: any,
  action: "cancel" | "return",
  options: { session_id?: string | null } = {},
) {
  requireSeller(ctx, actor);
  const cfg = vendasSettings(await ctx.settings());
  const own =
    action === "cancel" &&
    sale.status === "awaiting_payment" &&
    sale.created_by === actor.id;
  if (!isAdmin(actor) && actor.kind === "user" && !own)
    requireValue(
      cfg.operator_can_cancel,
      action === "cancel"
        ? "Só administradores cancelam vendas. Um administrador pode liberar a equipe em Regras e nota fiscal."
        : "Só administradores registram devoluções. Um administrador pode liberar a equipe em Regras e nota fiscal.",
    );
  for (const guard of guards) await guard(ctx, sale, action, options);
}

// ---------------------------------------------------------------------------
// Pagamentos

function validatePayments(
  cfg: ReturnType<typeof vendasSettings>,
  value: unknown,
  total: number,
): { payments: SalePayment[]; paid: number; change: number; online: SalePayment | null } {
  if ((value === undefined || value === null) && total === 0)
    return { payments: [], paid: 0, change: 0, online: null };
  requireValue(
    Array.isArray(value) && value.length >= 1 && value.length <= 6,
    "Informe as formas de pagamento (payments: de 1 a 6).",
  );
  const payments = (value as any[]).map((raw) => {
    requireValue(
      raw && (PAYMENT_METHODS as readonly string[]).includes(raw.method),
      `Forma de pagamento: ${PAYMENT_METHODS.join(", ")}.`,
    );
    const method = raw.method as PaymentMethod;
    requireValue(
      cfg.payment_methods[method],
      `A forma "${PAYMENT_LABELS[method]}" está desligada nas regras de vendas.`,
    );
    const amount = cents(raw.amount_cents, `o valor em ${PAYMENT_LABELS[method]}`);
    requireValue(amount > 0, "Cada forma de pagamento precisa de um valor.");
    return { method, amount_cents: amount };
  });
  const online = payments.find((p) => ONLINE_METHODS.includes(p.method)) || null;
  if (online)
    requireValue(
      payments.length === 1 && online.amount_cents === total,
      "Pix ou link do Mercado Pago cobram o total da venda, sem outra forma junto.",
    );
  const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
  if (paid < total)
    throw new ApiError(
      400,
      "payment_short",
      `Faltam ${money(total - paid)} para fechar a venda de ${money(total)}.`,
    );
  const change = paid - total;
  const cash = payments
    .filter((p) => p.method === "cash")
    .reduce((s, p) => s + p.amount_cents, 0);
  requireValue(
    change <= cash,
    "Troco só existe em dinheiro: os valores das outras formas passam do total.",
  );
  return { payments, paid, change, online };
}

// ---------------------------------------------------------------------------
// Criar

export interface CreateSaleInput {
  lines: any;
  discount_cents?: unknown;
  discount_percent?: unknown;
  payments?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  customer_document?: unknown;
  conversation_id?: unknown;
  note?: unknown;
  notes?: unknown;
  source: "panel" | "caixa" | "quote" | "api";
  session_id?: string | null;
  quote_id?: string | null;
  /** Repetir a mesma origem devolve a mesma venda. */
  sourceKey: string;
  /** Linhas já precificadas (orçamento aprovado). */
  fixedLines?: Line[];
  fixedTotals?: { discount_cents: number };
}

async function bySource(ctx: ModuleContext, sourceKey: string) {
  return one(
    ctx.env,
    "SELECT * FROM vendas_sales WHERE profile_id=? AND source_key=?",
    ctx.profile,
    sourceKey,
  );
}

export async function createSale(
  ctx: ModuleContext,
  actor: Actor,
  input: CreateSaleInput,
): Promise<SaleView> {
  requireSeller(ctx, actor);
  const repeated = await bySource(ctx, input.sourceKey);
  if (repeated) return saleView(repeated);
  const cfg = vendasSettings(await ctx.settings());
  const totals = input.fixedLines
    ? await applyTotals(
        ctx,
        actor,
        input.fixedLines.map((l) => ({ ...l })),
        { discount_cents: input.fixedTotals?.discount_cents ?? 0 },
        { skipLimit: true },
      )
    : await applyTotals(
        ctx,
        actor,
        await buildLines(ctx, actor, input.lines),
        input,
      );
  const pay = validatePayments(cfg, input.payments, totals.total_cents);
  let c: Conversation | null = null;
  if (input.conversation_id !== undefined && input.conversation_id !== null)
    c = await ctx.conversation(String(input.conversation_id), actor);
  if (pay.online) {
    requireValue(
      c,
      "Pix ou link do Mercado Pago saem pelo WhatsApp: informe a conversa do cliente (conversation_id).",
    );
    requireValue(
      ctx.mayMessage(actor, c!),
      "Assuma a conversa antes de cobrar o cliente pelo WhatsApp.",
    );
    const ready = await ctx.paymentsReady();
    if (!ready.ready)
      throw new ApiError(409, ready.reason!, ready.message!);
  }
  const contact = c ? await ctx.contact(c) : null;
  const phone = phoneDigits(
    input.customer_phone || (c && ctx.verifiedPhone(c)) || contact?.phone || "",
  );
  const name =
    text(input.customer_name, 80, "o nome do cliente") ||
    clip(contact?.name || "", 80);
  const document = customerDocument(input.customer_document);
  const status: SaleStatus = pay.online ? "awaiting_payment" : "completed";
  const id = uid(),
    at = now();
  const changes: StockChange[] = totals.lines
    .filter((l) => l.track_stock && l.product_id)
    .map((l) => ({
      product_id: l.product_id!,
      delta_milli: -l.quantity_milli,
      type: "venda",
      key: `sale:${id}:${l.index}`,
      ref_type: "sale",
      ref_id: id,
    }));
  const statements: [string, any[]][] = [
    [
      "INSERT INTO vendas_counters(profile_id,kind,last) VALUES(?,'sale',1) ON CONFLICT(profile_id,kind) DO UPDATE SET last=last+1",
      [ctx.profile],
    ],
    [
      "INSERT INTO vendas_sales(id,profile_id,number,status,source,quote_id,session_id,conversation_id,contact_id,customer_name,customer_phone,customer_document,lines,item_count,subtotal_cents,discount_cents,sale_discount_cents,total_cents,payments,paid_cents,change_cents,payment_status,note,notes,source_key,created_by,created,updated,completed_at) VALUES(?,?,(SELECT last FROM vendas_counters WHERE profile_id=? AND kind='sale'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        ctx.profile,
        ctx.profile,
        status,
        input.source,
        input.quote_id ?? null,
        input.session_id ?? null,
        c?.id ?? null,
        contact?.id ?? null,
        name,
        phone,
        document,
        JSON.stringify(totals.lines),
        totals.lines.length,
        totals.subtotal_cents,
        totals.discount_cents,
        totals.sale_discount_cents,
        totals.total_cents,
        JSON.stringify(pay.payments),
        pay.online ? 0 : pay.paid,
        pay.change,
        pay.online ? "pending" : null,
        text(input.note, 500, "a observação ao cliente"),
        text(input.notes, 2000, "as observações internas"),
        input.sourceKey,
        actor.id,
        at,
        at,
        status === "completed" ? at : null,
      ],
    ],
    ...stockStatements(ctx, changes, actor.id, at),
  ];
  try {
    await batch(ctx.env, statements);
  } catch (error) {
    const failure = stockFailure(error);
    if (failure === "insufficient")
      throw await outOfStock(
        ctx,
        changes.map((c) => ({
          product_id: c.product_id,
          quantity_milli: -c.delta_milli,
        })),
      );
    if (failure === "duplicate") {
      const existing = await bySource(ctx, input.sourceKey);
      if (existing) return saleView(existing);
      if (input.quote_id)
        throw new ApiError(
          409,
          "quote_converted",
          "Este orçamento já virou venda.",
        );
    }
    throw error;
  }
  let sale = await loadSale(ctx, id);
  await ctx.publish(
    "vendas.sale_created",
    id,
    {
      sale_id: id,
      number: sale.number,
      status,
      source: input.source,
      session_id: input.session_id ?? null,
      quote_id: input.quote_id ?? null,
      conversation_id: c?.id ?? null,
      total_cents: totals.total_cents,
      methods: pay.payments.map((p) => p.method),
      actor: actor.id,
    },
    { key: `created:${id}` },
  );
  await stockAlerts(ctx, changes);
  if (pay.online) {
    let payment: Payment;
    try {
      payment = await ctx.charge(c!, {
        method: pay.online.method as "pix" | "link",
        amount_cents: totals.total_cents,
        description: `Venda nº ${sale.number}`,
        ref: id,
        sourceKey: `venda:${id}`,
        trigger: actor.id.startsWith("bot:") ? "bot" : "agent",
        actor: actor.id,
      });
    } catch (error) {
      // Sem cobrança, a venda não fica presa segurando o estoque.
      await undoSale(ctx, sale, "system", "cancelled", "A cobrança não pôde ser criada.");
      throw error;
    }
    await batch(ctx.env, [
      [
        "UPDATE vendas_sales SET payment_id=?,payment_status=?,payment_pix_code=?,payment_url=?,updated=? WHERE id=? AND profile_id=?",
        [
          payment.id,
          payment.status,
          payment.pix_code || null,
          payment.url || null,
          now(),
          id,
          ctx.profile,
        ],
      ],
    ]);
    sale = await loadSale(ctx, id);
  }
  return saleView(sale);
}

// ---------------------------------------------------------------------------
// Cancelar (devolve todo o estoque que ainda não voltou)

/**
 * Muda a venda para cancelada e devolve o estoque restante, num lote. A chave
 * dos movimentos (`cancel:<venda>:<linha>`) impede devolver duas vezes.
 */
async function undoSale(
  ctx: ModuleContext,
  sale: any,
  actor: string,
  status: "cancelled",
  reason: string,
  extra: { needs_refund?: boolean; payment_status?: string | null } = {},
) {
  const lines: Line[] = json(sale.lines, []);
  const at = now();
  const changes: StockChange[] = lines
    .filter(
      (l) =>
        l.track_stock && l.product_id && l.quantity_milli > (l.returned_milli || 0),
    )
    .map((l) => ({
      product_id: l.product_id!,
      delta_milli: l.quantity_milli - (l.returned_milli || 0),
      type: "cancelamento",
      key: `cancel:${sale.id}:${l.index}`,
      ref_type: "sale",
      ref_id: sale.id,
      note: reason,
    }));
  try {
    await batch(ctx.env, [
      [
        "UPDATE vendas_sales SET status=?,cancelled_at=?,cancelled_by=?,cancel_reason=?,needs_refund=?,payment_status=coalesce(?,payment_status),updated=? WHERE id=? AND profile_id=? AND status IN ('awaiting_payment','completed')",
        [
          status,
          at,
          actor,
          clip(reason, 300),
          extra.needs_refund ? 1 : sale.needs_refund,
          extra.payment_status ?? null,
          at,
          sale.id,
          ctx.profile,
        ],
      ],
      ...stockStatements(ctx, changes, actor, at),
    ]);
  } catch (error) {
    if (stockFailure(error) !== "duplicate") throw error;
  }
  return loadSale(ctx, sale.id);
}

/** POST vendas/sales/:id/cancel {reason}. */
export async function cancelSale(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  const sale = await loadSale(ctx, data.id);
  if (sale.status === "cancelled") return saleView(sale);
  if (!["awaiting_payment", "completed"].includes(sale.status))
    throw new ApiError(
      409,
      "invalid_transition",
      `A venda nº ${sale.number} está "${SALE_LABELS[sale.status as SaleStatus]}" e não pode ser cancelada.`,
    );
  if (sale.refunded_cents > 0)
    throw new ApiError(
      409,
      "sale_partially_returned",
      `A venda nº ${sale.number} já tem devolução. Registre a devolução do restante.`,
    );
  await mayUndo(ctx, actor, sale, "cancel");
  const reason = text(data.reason, 300, "o motivo");
  let paymentStatus: string | null = null;
  let needsRefund = false;
  if (sale.payment_id && sale.status === "awaiting_payment") {
    try {
      paymentStatus = (await ctx.cancelCharge(sale.payment_id)).status;
    } catch (error) {
      // Já pago no provedor: cancela e marca para estornar.
      if (!(error instanceof ApiError) || error.code !== "payment_closed")
        throw error;
      needsRefund = true;
    }
  } else if (sale.payment_id && sale.payment_status === "paid")
    needsRefund = true;
  const next = await undoSale(
    ctx,
    sale,
    actor.id,
    "cancelled",
    reason || "Cancelada pela equipe",
    { needs_refund: needsRefund, payment_status: paymentStatus },
  );
  await ctx.publish(
    "vendas.sale_cancelled",
    sale.id,
    {
      sale_id: sale.id,
      number: sale.number,
      reason,
      needs_refund: !!next.needs_refund,
      actor: actor.id,
    },
    { key: `cancelled:${sale.id}` },
  );
  return saleView(next);
}

// ---------------------------------------------------------------------------
// Devolver (parcial ou total)

export const returnView = (row: any) => ({
  id: row.id,
  sale_id: row.sale_id,
  session_id: row.session_id || null,
  lines: json(row.lines, []) as {
    index: number;
    name: string;
    quantity: number;
    amount_cents: number;
  }[],
  amount_cents: row.amount_cents,
  method: row.method as PaymentMethod,
  method_label: PAYMENT_LABELS[row.method as PaymentMethod] || row.method,
  reason: row.reason,
  actor: row.actor,
  created: row.created,
});

/**
 * POST vendas/sales/:id/return {items?:[{index, quantity}], method?, reason?}.
 * Sem items, devolve tudo o que falta. O estoque volta (devolução) e o valor
 * devolvido sai pela forma escolhida; com session_id (Caixa), sai do caixa
 * daquela sessão.
 */
export async function returnSale(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
  options: { session_id?: string | null } = {},
) {
  const sourceKey = `return:${requestId}`;
  const repeated = await one(
    ctx.env,
    "SELECT * FROM vendas_returns WHERE profile_id=? AND source_key=?",
    ctx.profile,
    sourceKey,
  );
  if (repeated)
    return {
      sale: saleView(await loadSale(ctx, repeated.sale_id)),
      return: returnView(repeated),
    };
  const sale = await loadSale(ctx, data.id);
  if (sale.status !== "completed")
    throw new ApiError(
      409,
      "invalid_transition",
      `Só vendas concluídas têm devolução (a nº ${sale.number} está "${SALE_LABELS[sale.status as SaleStatus]}").`,
    );
  await mayUndo(ctx, actor, sale, "return", options);
  const lines: Line[] = json(sale.lines, []);
  const asked: { index: number; quantity: number }[] = data.items
    ? (() => {
        requireValue(
          Array.isArray(data.items) &&
            data.items.length >= 1 &&
            data.items.length <= lines.length,
          "Itens da devolução inválidos.",
        );
        const seen = new Set<number>();
        return data.items.map((raw: any) => {
          const line = lines.find((l) => l.index === raw?.index);
          requireValue(line, "Item da devolução não encontrado na venda.");
          requireValue(!seen.has(line!.index), "Item repetido na devolução.");
          seen.add(line!.index);
          return {
            index: line!.index,
            quantity: milli(raw.quantity, `Quantidade de "${line!.name}"`),
          };
        });
      })()
    : lines
        .filter((l) => l.quantity_milli > (l.returned_milli || 0))
        .map((l) => ({
          index: l.index,
          quantity: l.quantity_milli - (l.returned_milli || 0),
        }));
  requireValue(asked.length, "Não há itens para devolver nesta venda.");
  const payments: SalePayment[] = json(sale.payments, []);
  const method = (data.method ||
    (payments.length === 1 ? payments[0].method : "cash")) as PaymentMethod;
  requireValue(
    (PAYMENT_METHODS as readonly string[]).includes(method),
    `Forma da devolução: ${PAYMENT_METHODS.join(", ")}.`,
  );
  const reason = text(data.reason, 300, "o motivo");
  const id = uid(),
    at = now();
  const detail: { index: number; name: string; quantity: number; amount_cents: number }[] = [];
  const changes: StockChange[] = [];
  let amount = 0;
  for (const a of asked) {
    const line = lines.find((l) => l.index === a.index)!;
    const left = line.quantity_milli - (line.returned_milli || 0);
    requireValue(
      a.quantity <= left,
      `"${line.name}": só restam ${fromMilli(left)} ${line.unit} para devolver.`,
    );
    const value =
      a.quantity === left
        ? line.net_cents - (line.returned_cents || 0)
        : Math.round((line.net_cents * a.quantity) / line.quantity_milli);
    line.returned_milli = (line.returned_milli || 0) + a.quantity;
    line.returned_cents = (line.returned_cents || 0) + value;
    amount += value;
    detail.push({
      index: line.index,
      name: line.name,
      quantity: fromMilli(a.quantity),
      amount_cents: value,
    });
    if (line.track_stock && line.product_id)
      changes.push({
        product_id: line.product_id,
        delta_milli: a.quantity,
        type: "devolucao",
        key: `return:${id}:${line.index}`,
        ref_type: "return",
        ref_id: id,
        note: reason,
      });
  }
  const all = lines.every((l) => (l.returned_milli || 0) >= l.quantity_milli);
  const online = payments.some((p) => ONLINE_METHODS.includes(p.method));
  try {
    await batch(ctx.env, [
      [
        "INSERT INTO vendas_returns(id,profile_id,sale_id,session_id,lines,amount_cents,method,reason,source_key,actor,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          ctx.profile,
          sale.id,
          options.session_id ?? null,
          JSON.stringify(detail),
          amount,
          method,
          reason,
          sourceKey,
          actor.id,
          at,
        ],
      ],
      [
        "UPDATE vendas_sales SET lines=?,refunded_cents=refunded_cents+?,status=?,needs_refund=?,updated=? WHERE id=? AND profile_id=? AND updated=?",
        [
          JSON.stringify(lines),
          amount,
          all ? "returned" : "completed",
          online && ONLINE_METHODS.includes(method) ? 1 : sale.needs_refund,
          at,
          sale.id,
          ctx.profile,
          sale.updated,
        ],
      ],
      ...stockStatements(ctx, changes, actor.id, at),
    ]);
  } catch (error) {
    if (stockFailure(error) === "duplicate")
      throw new ApiError(
        409,
        "sale_conflict",
        "A venda mudou enquanto isso. Atualize e tente de novo.",
      );
    throw error;
  }
  const next = await loadSale(ctx, sale.id);
  if (next.updated !== at)
    throw new ApiError(
      409,
      "sale_conflict",
      "A venda mudou enquanto isso. Atualize e tente de novo.",
    );
  await ctx.publish(
    "vendas.sale_returned",
    id,
    {
      sale_id: sale.id,
      number: sale.number,
      return_id: id,
      amount_cents: amount,
      method,
      complete: all,
      session_id: options.session_id ?? null,
      actor: actor.id,
    },
    { key: `returned:${id}` },
  );
  return {
    sale: saleView(next),
    return: returnView(
      await one(ctx.env, "SELECT * FROM vendas_returns WHERE id=?", id),
    ),
  };
}

// ---------------------------------------------------------------------------
// Pagamento online (onPaymentUpdated)

export async function paymentUpdated(
  ctx: ModuleContext,
  payment: Payment,
  previous: string,
) {
  if (!payment.ref_id) return;
  const sale = await one(
    ctx.env,
    "SELECT * FROM vendas_sales WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!sale || sale.payment_id !== payment.id) return;
  const at = now();
  const c = sale.conversation_id
    ? await ctx.conversation(sale.conversation_id).catch(() => null)
    : null;
  if (payment.status === "paid") {
    if (sale.status === "awaiting_payment") {
      await batch(ctx.env, [
        [
          "UPDATE vendas_sales SET status='completed',payment_status='paid',paid_cents=?,completed_at=?,updated=? WHERE id=? AND profile_id=? AND status='awaiting_payment'",
          [payment.amount_cents, at, at, sale.id, ctx.profile],
        ],
      ]);
      await ctx.publish(
        "vendas.sale_paid",
        sale.id,
        {
          sale_id: sale.id,
          number: sale.number,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
          late: false,
        },
        { key: `paid:${sale.id}` },
      );
    } else if (sale.status === "cancelled" && sale.payment_status !== "paid") {
      // Pago depois de vencida ou cancelada: o estoque já voltou.
      await batch(ctx.env, [
        [
          "UPDATE vendas_sales SET payment_status='paid',paid_cents=?,needs_refund=1,updated=? WHERE id=? AND profile_id=?",
          [payment.amount_cents, at, sale.id, ctx.profile],
        ],
      ]);
      if (c)
        await ctx.note(
          c,
          `Pagamento da venda nº ${sale.number} (${money(payment.amount_cents)}) chegou depois do cancelamento (${previous}). Estorne pelo Mercado Pago ou refaça a venda.`,
          { key: `late:${sale.id}` },
        );
      await ctx.publish(
        "vendas.sale_paid",
        sale.id,
        {
          sale_id: sale.id,
          number: sale.number,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
          late: true,
          needs_refund: true,
        },
        { key: `paid-late:${sale.id}` },
      );
    }
    return;
  }
  if (payment.status === "expired" || payment.status === "cancelled") {
    if (sale.status !== "awaiting_payment") return;
    await undoSale(
      ctx,
      sale,
      "system",
      "cancelled",
      payment.status === "expired"
        ? "Pagamento não confirmado no prazo"
        : "Cobrança cancelada",
      { payment_status: payment.status },
    );
    await ctx.publish(
      "vendas.sale_cancelled",
      sale.id,
      {
        sale_id: sale.id,
        number: sale.number,
        reason: payment.status,
        needs_refund: false,
        actor: "system",
      },
      { key: `cancelled:${sale.id}` },
    );
    return;
  }
  if (payment.status === "refunded") {
    await batch(ctx.env, [
      [
        "UPDATE vendas_sales SET payment_status='refunded',needs_refund=0,updated=? WHERE id=? AND profile_id=?",
        [at, sale.id, ctx.profile],
      ],
    ]);
    if (c && sale.status === "completed")
      await ctx.note(
        c,
        `O pagamento da venda nº ${sale.number} foi estornado no Mercado Pago. Se a mercadoria voltou, registre a devolução para o estoque.`,
        { key: `refunded:${sale.id}` },
      );
  }
}

// ---------------------------------------------------------------------------
// Listas

/**
 * GET vendas/sales?status=&source=&session_id=&conversation_id=&q=&from=&to=&limit=&cursor=.
 * Ordem: número decrescente; cursor é o número da última venda da página.
 */
export async function listSales(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"];
  const args: any[] = [ctx.profile];
  if (query.status) {
    const list = query.status.split(",");
    requireValue(
      list.every((s) => (SALE_STATUSES as readonly string[]).includes(s)),
      `status: ${SALE_STATUSES.join(", ")}.`,
    );
    where.push(`status IN (${list.map(() => "?").join(",")})`);
    args.push(...list);
  }
  for (const k of ["source", "session_id", "conversation_id"] as const)
    if (query[k]) {
      where.push(`${k}=?`);
      args.push(query[k]);
    }
  if (query.from) {
    where.push("created>=?");
    args.push(Number(query.from) || 0);
  }
  if (query.to) {
    where.push("created<?");
    args.push(Number(query.to) || 0);
  }
  if (query.q) {
    const q = query.q.trim();
    if (/^\d{1,9}$/.test(q)) {
      where.push("(number=? OR customer_phone LIKE ? OR customer_document LIKE ?)");
      args.push(Number(q), `%${q}%`, `%${q}%`);
    } else {
      where.push("customer_name LIKE ? COLLATE NOCASE");
      args.push(`%${q.slice(0, 60)}%`);
    }
  }
  if (query.cursor) {
    where.push("number<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM vendas_sales WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    data: page.map(saleView),
    next_cursor:
      rows.length > limit ? String(page.at(-1)!.number) : null,
  };
}

export async function saleDetail(ctx: ModuleContext, id: unknown) {
  const sale = await loadSale(ctx, id);
  const [returns, fiscal] = await Promise.all([
    all(
      ctx.env,
      "SELECT * FROM vendas_returns WHERE profile_id=? AND sale_id=? ORDER BY created",
      ctx.profile,
      sale.id,
    ),
    all(
      ctx.env,
      "SELECT id,model,environment,series,number,status,provider,access_key,protocol,pdf_url,xml_url,message,created,updated FROM vendas_fiscal_documents WHERE profile_id=? AND sale_id=? ORDER BY created",
      ctx.profile,
      sale.id,
    ),
  ]);
  return {
    ...saleView(sale),
    returns: returns.map(returnView),
    fiscal_documents: fiscal,
  };
}

/** Vendas e devoluções de uma sessão do Caixa (public.ts). */
export async function sessionRecords(ctx: ModuleContext, sessionId: string) {
  const [sales, returns] = await Promise.all([
    all(
      ctx.env,
      "SELECT * FROM vendas_sales WHERE profile_id=? AND session_id=? ORDER BY number",
      ctx.profile,
      sessionId,
    ),
    all(
      ctx.env,
      "SELECT * FROM vendas_returns WHERE profile_id=? AND session_id=? ORDER BY created",
      ctx.profile,
      sessionId,
    ),
  ]);
  return { sales: sales.map(saleView), returns: returns.map(returnView) };
}
