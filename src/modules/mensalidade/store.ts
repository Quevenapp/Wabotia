// Mensalidade: cadastros (planos e assinaturas) e importação. Fala com o
// núcleo pela interface de src/modules/api.ts; só lê tabelas do núcleo
// (conversas pelo telefone, para avisar o cliente).
import { all, exec, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  now,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import {
  INSTALLMENT_LABELS,
  PERIOD_LABELS,
  SUBSCRIPTION_LABELS,
  cents,
  isDate,
  isPeriod,
  money,
  periodLabel,
  phoneDigits,
  text,
  today,
  type InstallmentStatus,
  type Period,
  type SubscriptionStatus,
} from "./model";
import { ensurePayer, loadPayer } from "./payers";
import { formatDocument } from "../../establishment";

export const notFound = (what = "Assinatura") =>
  new ApiError(404, "not_found", `${what} não encontrada.`);

/**
 * Cancela no provedor a cobrança ainda aberta de uma parcela que deixou de
 * ser cobrada (baixa manual, isenção, pausa, encerramento). Já paga ou
 * vencida: nada a fazer (um pagamento que entrar depois vira duplicado).
 */
export async function cancelOpenCharge(
  ctx: ModuleContext,
  inst: {
    id: string;
    payment_id?: string | null;
    payment_status?: string | null;
  },
) {
  if (!inst.payment_id || inst.payment_status !== "created") return;
  try {
    const payment = await ctx.cancelCharge(inst.payment_id);
    await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET payment_status=?,updated=? WHERE id=? AND payment_id=?",
      payment.status,
      now(),
      inst.id,
      payment.id,
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
}

/** Administrador (pessoa) ou integração com a permissão de escrita. */
export const isManager = (actor: Actor) =>
  actor.kind === "app" || (actor.kind === "user" && actor.role === "admin");

export function manager(actor: Actor, message?: string) {
  if (!isManager(actor))
    throw new ApiError(
      403,
      "admin_required",
      message || "Somente administradores podem fazer isto.",
    );
}

// ---------------------------------------------------------------------------
// Planos

export function planView(row: any) {
  return {
    id: row.id,
    name: row.name,
    amount_cents: row.amount_cents,
    period: row.period as Period,
    period_label: PERIOD_LABELS[row.period as Period] || row.period,
    due_day: row.due_day,
    active: !!row.active,
    sellable: !!row.sellable,
    description: row.description ?? "",
    ...(row.subscriptions !== undefined
      ? { subscriptions: row.subscriptions }
      : {}),
    created: row.created,
    updated: row.updated,
  };
}

export async function loadPlan(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound("Plano");
  const row = await one(
    ctx.env,
    "SELECT * FROM mensalidade_plans WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Plano");
  return row;
}

export async function listPlans(ctx: ModuleContext) {
  const rows = await all(
    ctx.env,
    "SELECT p.*,(SELECT count(*) FROM mensalidade_subscriptions s WHERE s.plan_id=p.id AND s.status<>'ended') AS subscriptions FROM mensalidade_plans p WHERE p.profile_id=? ORDER BY p.active DESC,p.name",
    ctx.profile,
  );
  return { data: rows.map(planView) };
}

const dueDay = (value: unknown) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= 31,
    "Dia de vencimento de 1 a 31 (no mês curto vale o último dia).",
  );
  return value as number;
};

function planFields(data: any, partial: boolean) {
  const out: Record<string, any> = {};
  const has = (key: string) => !partial || Object.hasOwn(data, key);
  if (has("name")) out.name = text(data.name, 80, "o nome do plano", true);
  if (has("amount_cents"))
    out.amount_cents = cents(data.amount_cents, "Valor do plano", 1);
  if (has("period") || (!partial && data.period === undefined)) {
    const period = data.period ?? "monthly";
    requireValue(
      isPeriod(period),
      "Periodicidade: monthly, quarterly ou yearly.",
    );
    out.period = period;
  }
  if (has("due_day") || (!partial && data.due_day === undefined))
    out.due_day = dueDay(data.due_day ?? 10);
  if (Object.hasOwn(data, "active")) {
    requireValue(
      typeof data.active === "boolean",
      "Informe active como verdadeiro ou falso.",
    );
    out.active = data.active ? 1 : 0;
  }
  if (Object.hasOwn(data, "sellable")) {
    requireValue(
      typeof data.sellable === "boolean",
      "Informe sellable como verdadeiro ou falso.",
    );
    out.sellable = data.sellable ? 1 : 0;
  }
  if (Object.hasOwn(data, "description"))
    out.description = text(data.description, 200, "a descrição do plano");
  return out;
}

export async function createPlan(ctx: ModuleContext, data: any, actor: string) {
  const fields = planFields(data, false);
  const id = uid(),
    at = now();
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_plans(id,profile_id,name,amount_cents,period,due_day,active,sellable,description,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    ctx.profile,
    fields.name,
    fields.amount_cents,
    fields.period,
    fields.due_day,
    fields.active ?? 1,
    fields.sellable ?? 0,
    fields.description ?? "",
    actor,
    at,
    at,
  );
  return planView(await loadPlan(ctx, id));
}

/** Mudar o plano não muda assinaturas existentes (valor e período copiados). */
export async function updatePlan(ctx: ModuleContext, id: unknown, data: any) {
  const plan = await loadPlan(ctx, id);
  const fields = planFields(data, true);
  const keys = Object.keys(fields);
  if (keys.length)
    await exec(
      ctx.env,
      `UPDATE mensalidade_plans SET ${keys.map((k) => k + "=?").join(",")},updated=? WHERE id=? AND profile_id=?`,
      ...keys.map((k) => fields[k]),
      now(),
      plan.id,
      ctx.profile,
    );
  return planView(await loadPlan(ctx, plan.id));
}

/** Exclui um plano sem assinaturas; com assinaturas, desative-o. */
export async function deletePlan(ctx: ModuleContext, id: unknown) {
  const plan = await loadPlan(ctx, id);
  const used = await one(
    ctx.env,
    "SELECT id FROM mensalidade_subscriptions WHERE plan_id=? LIMIT 1",
    plan.id,
  );
  if (used)
    throw new ApiError(
      409,
      "plan_in_use",
      `O plano "${plan.name}" tem assinaturas. Desative-o em vez de excluir.`,
    );
  await exec(
    ctx.env,
    "DELETE FROM mensalidade_plans WHERE id=? AND profile_id=?",
    plan.id,
    ctx.profile,
  );
  return { id: plan.id, deleted: true };
}

// ---------------------------------------------------------------------------
// Assinaturas

const PAYER_COLUMNS = "y.name AS payer_name,y.document AS payer_document";

export function subscriptionView(row: any, extra: Record<string, any> = {}) {
  const status = row.status as SubscriptionStatus;
  return {
    id: row.id,
    plan_id: row.plan_id,
    plan_name: row.plan_name ?? null,
    customer: {
      name: row.customer_name,
      phone: row.phone,
      contact_id: row.contact_id,
      conversation_id: row.conversation_id,
    },
    payer: row.payer_id
      ? {
          id: row.payer_id,
          name: row.payer_name ?? null,
          document_display: row.payer_document
            ? formatDocument(row.payer_document)
            : null,
        }
      : null,
    period: row.period as Period,
    period_label: PERIOD_LABELS[row.period as Period] || row.period,
    amount_cents: row.amount_cents,
    discount_cents: row.discount_cents,
    /** Valor de cada parcela (valor menos desconto). */
    charge_cents: row.amount_cents - row.discount_cents,
    due_day: row.due_day,
    start_date: row.start_date,
    end_date: row.end_date,
    status,
    status_label: SUBSCRIPTION_LABELS[status] || status,
    notes: row.notes,
    paused_at: row.paused_at,
    ended_at: row.ended_at,
    ...(row.open_count !== undefined
      ? {
          open_count: row.open_count,
          overdue_count: row.overdue_count,
          overdue_cents: row.overdue_cents || 0,
        }
      : {}),
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
    ...extra,
  };
}

export async function loadSubscription(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound();
  const row = await one(
    ctx.env,
    `SELECT s.*,p.name AS plan_name,${PAYER_COLUMNS} FROM mensalidade_subscriptions s LEFT JOIN mensalidade_plans p ON p.id=s.plan_id LEFT JOIN mensalidade_payers y ON y.id=s.payer_id WHERE s.id=? AND s.profile_id=?`,
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  return row;
}

export function installmentView(row: any) {
  const status = row.status as InstallmentStatus;
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    period_key: row.period_key,
    period_label: periodLabel(row.period_key),
    due_date: row.due_date,
    /** Primeira parcela cobrada na contratação pelo WhatsApp. */
    upfront: !!row.upfront,
    amount_cents: row.amount_cents,
    status,
    status_label: INSTALLMENT_LABELS[status] || status,
    ...(row.customer_name !== undefined
      ? {
          customer: { name: row.customer_name, phone: row.phone },
          plan_name: row.plan_name ?? null,
        }
      : {}),
    payment: row.payment_id
      ? {
          id: row.payment_id,
          status: row.payment_status,
          expires_at: row.payment_expires_at,
          pix_code: row.pix_code,
          url: row.pay_url,
          charged_at: row.charged_at,
        }
      : null,
    notices: {
      before_at: row.notice_before_at,
      due_at: row.notice_due_at,
      overdue: row.overdue_notices,
      overdue_at: row.overdue_notice_at,
      error: row.notice_error,
    },
    paid_at: row.paid_at,
    paid_via: row.paid_via,
    paid_by: row.paid_by,
    paid_note: row.paid_note,
    waived_at: row.waived_at,
    waived_by: row.waived_by,
    cancelled_at: row.cancelled_at,
    created: row.created,
    updated: row.updated,
  };
}

const subscriptionCounts =
  "(SELECT count(*) FROM mensalidade_installments i WHERE i.subscription_id=s.id AND i.status='open') AS open_count," +
  "(SELECT count(*) FROM mensalidade_installments i WHERE i.subscription_id=s.id AND i.status='overdue') AS overdue_count," +
  "(SELECT sum(amount_cents) FROM mensalidade_installments i WHERE i.subscription_id=s.id AND i.status='overdue') AS overdue_cents";

/** GET mensalidade/subscriptions: filtros por estado, plano, busca e telefone. */
export async function listSubscriptions(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["s.profile_id=?"],
    args: any[] = [ctx.profile];
  const statuses = (query.status || "").split(",").filter(Boolean);
  for (const s of statuses)
    requireValue(
      ["active", "paused", "ended"].includes(s),
      `Estado desconhecido: ${s}.`,
    );
  if (statuses.length) {
    where.push(`s.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (query.plan_id) {
    where.push("s.plan_id=?");
    args.push(query.plan_id);
  }
  if (query.payer_id) {
    where.push("s.payer_id=?");
    args.push(query.payer_id);
  }
  if (query.phone) {
    where.push("s.phone=?");
    args.push(phoneDigits(query.phone));
  }
  if (query.conversation_id) {
    where.push("s.conversation_id=?");
    args.push(query.conversation_id);
  }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like =
      "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    where.push(
      "(lower(s.customer_name) LIKE ? ESCAPE '\\' OR lower(s.notes) LIKE ? ESCAPE '\\' OR lower(y.name) LIKE ? ESCAPE '\\'" +
        (digits.length >= 4 ? " OR s.phone LIKE ? OR y.document LIKE ?" : "") +
        ")",
    );
    args.push(like, like, like);
    if (digits.length >= 4) args.push("%" + digits + "%", "%" + digits + "%");
  }
  if (query.cursor) {
    where.push("s.id>?");
    args.push(query.cursor);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT s.*,p.name AS plan_name,${PAYER_COLUMNS},${subscriptionCounts} FROM mensalidade_subscriptions s LEFT JOIN mensalidade_plans p ON p.id=s.plan_id LEFT JOIN mensalidade_payers y ON y.id=s.payer_id WHERE ${where.join(" AND ")} ORDER BY s.id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        "SELECT status,count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=? GROUP BY status",
        ctx.profile,
      )
    ).map((r) => [r.status, r.n]),
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => subscriptionView(row)),
    next_cursor: more ? page.at(-1)!.id : null,
    counts,
  };
}

export async function subscriptionDetail(ctx: ModuleContext, id: unknown) {
  const sub = await loadSubscription(ctx, id);
  const installments = await all(
    ctx.env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? AND profile_id=? ORDER BY due_date DESC LIMIT 120",
    sub.id,
    ctx.profile,
  );
  return subscriptionView(sub, {
    installments: installments.map(installmentView),
  });
}

export interface SubscriptionInput {
  conversation?: Conversation | null;
  plan_id: unknown;
  customer_name?: unknown;
  phone?: unknown;
  amount_cents?: unknown;
  discount_cents?: unknown;
  due_day?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  notes?: unknown;
  /** Pagador existente; sem ele, `document` (CPF/CNPJ) acha ou cria um. */
  payer_id?: unknown;
  document?: unknown;
  /** Nome do pagador quando difere do cliente (empresa, responsável). */
  payer_name?: unknown;
  /** Repetir a chave devolve a mesma assinatura (contratação pelo WhatsApp). */
  sourceKey?: string;
  /**
   * Interno (nunca do corpo da requisição): contrato já pago pelo WhatsApp;
   * a assinatura nasce mesmo que o plano tenha sido desativado depois.
   */
  paidContract?: boolean;
}

/** Valida e monta a linha da assinatura (sem gravar). */
async function subscriptionRow(
  ctx: ModuleContext,
  input: SubscriptionInput,
  at: number,
) {
  const plan = await loadPlan(ctx, input.plan_id);
  requireValue(
    plan.active || input.paidContract === true,
    `O plano "${plan.name}" está desativado.`,
  );
  const c = input.conversation || null;
  if (c)
    requireValue(
      c.chat_type !== "group",
      "Assinaturas só em conversas individuais.",
    );
  const contact = c ? await ctx.contact(c) : null;
  const phone = phoneDigits(
    text(input.phone, 40, "o telefone") || c?.phone || contact?.phone || "",
  );
  requireValue(
    phone.length >= 10 && phone.length <= 15,
    "Informe o telefone do cliente (WhatsApp, com DDD).",
  );
  const name =
    text(input.customer_name, 120, "o nome do cliente") || contact?.name || "";
  requireValue(name, "Informe o nome do cliente.");
  const amount =
    input.amount_cents === undefined || input.amount_cents === null
      ? plan.amount_cents
      : cents(input.amount_cents, "Valor", 1);
  const discount =
    input.discount_cents === undefined || input.discount_cents === null
      ? 0
      : cents(input.discount_cents, "Desconto");
  requireValue(
    amount - discount >= 1,
    "O desconto precisa ser menor que o valor. Para não cobrar, isente as parcelas.",
  );
  const due =
    input.due_day === undefined ||
    input.due_day === null ||
    input.due_day === ""
      ? plan.due_day
      : dueDay(input.due_day);
  const start =
    input.start_date === undefined ||
    input.start_date === null ||
    input.start_date === ""
      ? today(at)
      : input.start_date;
  requireValue(isDate(start), "Início: data AAAA-MM-DD.");
  const end =
    input.end_date === undefined ||
    input.end_date === null ||
    input.end_date === ""
      ? null
      : input.end_date;
  if (end !== null) {
    requireValue(isDate(end), "Fim: data AAAA-MM-DD.");
    requireValue(end >= start, "O fim precisa ser depois do início.");
  }
  return {
    plan,
    conversation_id: c?.id || null,
    contact_id: contact?.id || null,
    customer_name: name,
    phone,
    period: plan.period as Period,
    amount_cents: amount,
    discount_cents: discount,
    due_day: due,
    start_date: start as string,
    end_date: end as string | null,
    notes: text(input.notes, 1000, "as observações"),
  };
}

export async function createSubscription(
  ctx: ModuleContext,
  input: SubscriptionInput,
  actor: string,
) {
  const at = now();
  if (input.sourceKey) {
    const existing = await one(
      ctx.env,
      "SELECT id FROM mensalidade_subscriptions WHERE source_key=?",
      input.sourceKey,
    );
    if (existing) return loadSubscription(ctx, existing.id);
  }
  const known =
    input.payer_id !== undefined &&
    input.payer_id !== null &&
    input.payer_id !== ""
      ? await loadPayer(ctx, input.payer_id)
      : null;
  const row = await subscriptionRow(
    ctx,
    {
      ...input,
      customer_name:
        input.customer_name || known?.name || input.payer_name || undefined,
    },
    at,
  );
  // Depois de validar a assinatura: o pagador não nasce de um pedido inválido.
  const payer =
    known ||
    (await ensurePayer(
      ctx,
      {
        document: input.document,
        name: input.payer_name || row.customer_name,
        phone: row.phone,
      },
      actor,
    ));
  const id = uid();
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,contact_id,conversation_id,customer_name,phone,period,amount_cents,discount_cents,due_day,start_date,end_date,status,bill_from,notes,payer_id,source_key,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)",
    id,
    ctx.profile,
    row.plan.id,
    row.contact_id,
    row.conversation_id,
    row.customer_name,
    row.phone,
    row.period,
    row.amount_cents,
    row.discount_cents,
    row.due_day,
    row.start_date,
    row.end_date,
    row.start_date,
    row.notes,
    payer.id,
    input.sourceKey ?? null,
    actor,
    at,
    at,
  );
  const sub = await loadSubscription(ctx, id);
  await ctx.publish("mensalidade.subscription_created", id, {
    subscription_id: id,
    payer_id: payer.id,
    plan_id: sub.plan_id,
    phone: sub.phone,
    conversation_id: sub.conversation_id,
    charge_cents: sub.amount_cents - sub.discount_cents,
    actor,
  });
  return sub;
}

/** PATCH: nome, telefone, valor, desconto, dia, fim, observações e plano. */
export async function updateSubscription(
  ctx: ModuleContext,
  sub: any,
  data: any,
  actor: string,
) {
  requireValue(sub.status !== "ended", "Assinatura encerrada não muda.");
  const has = (key: string) => Object.hasOwn(data, key);
  const sets: Record<string, any> = {};
  if (has("customer_name"))
    sets.customer_name = text(
      data.customer_name,
      120,
      "o nome do cliente",
      true,
    );
  if (has("phone")) {
    sets.phone = phoneDigits(text(data.phone, 40, "o telefone", true));
    requireValue(
      sets.phone.length >= 10 && sets.phone.length <= 15,
      "Telefone inválido.",
    );
    // Outro número: a conversa antiga deixa de ser a do cliente.
    if (sets.phone !== sub.phone) sets.conversation_id = null;
  }
  if (has("plan_id")) {
    const plan = await loadPlan(ctx, data.plan_id);
    sets.plan_id = plan.id;
    sets.period = plan.period;
  }
  if (has("amount_cents"))
    sets.amount_cents = cents(data.amount_cents, "Valor", 1);
  if (has("discount_cents"))
    sets.discount_cents = cents(data.discount_cents ?? 0, "Desconto");
  if (has("due_day")) sets.due_day = dueDay(data.due_day);
  if (has("end_date")) {
    const end = data.end_date || null;
    if (end !== null) {
      requireValue(isDate(end), "Fim: data AAAA-MM-DD.");
      requireValue(
        end >= sub.start_date,
        "O fim precisa ser depois do início.",
      );
    }
    sets.end_date = end;
  }
  if (has("notes")) sets.notes = text(data.notes, 1000, "as observações");
  const amount = sets.amount_cents ?? sub.amount_cents,
    discount = sets.discount_cents ?? sub.discount_cents;
  requireValue(
    amount - discount >= 1,
    "O desconto precisa ser menor que o valor. Para não cobrar, isente as parcelas.",
  );
  const changed = Object.keys(sets).filter((key) => sets[key] !== sub[key]);
  if (!changed.length) return sub;
  await exec(
    ctx.env,
    `UPDATE mensalidade_subscriptions SET ${changed.map((k) => k + "=?").join(",")},checked_until=NULL,updated=? WHERE id=? AND profile_id=?`,
    ...changed.map((k) => sets[k]),
    now(),
    sub.id,
    ctx.profile,
  );
  await ctx.publish("mensalidade.subscription_changed", sub.id, {
    subscription_id: sub.id,
    change: "updated",
    fields: changed,
    status: sub.status,
    actor,
  });
  return loadSubscription(ctx, sub.id);
}

/**
 * Pausar, retomar ou encerrar. Pausa e encerramento cancelam as parcelas
 * abertas que ainda não venceram (as vencidas continuam devidas); retomar
 * volta a gerar a partir de hoje, sem cobrar os períodos da pausa.
 */
export async function setSubscriptionStatus(
  ctx: ModuleContext,
  sub: any,
  to: "active" | "paused" | "ended",
  actor: string,
  at = now(),
) {
  const allowed: Record<string, string[]> = {
    active: ["paused"],
    paused: ["active"],
    ended: ["active", "paused"],
  };
  if (!allowed[to].includes(sub.status))
    throw new ApiError(
      409,
      "invalid_transition",
      `Não é possível passar a assinatura de "${SUBSCRIPTION_LABELS[sub.status as SubscriptionStatus]}" para "${SUBSCRIPTION_LABELS[to]}".`,
    );
  const day = today(at);
  const sets: Record<string, any> = {
    status: to,
    updated: at,
    checked_until: null,
  };
  if (to === "paused") sets.paused_at = at;
  if (to === "ended") {
    sets.ended_at = at;
    if (!sub.end_date || sub.end_date > day) sets.end_date = day;
  }
  if (to === "active") {
    sets.paused_at = null;
    sets.bill_from = day > sub.bill_from ? day : sub.bill_from;
  }
  const keys = Object.keys(sets);
  const result = await exec(
    ctx.env,
    `UPDATE mensalidade_subscriptions SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND profile_id=? AND status=?`,
    ...keys.map((k) => sets[k]),
    sub.id,
    ctx.profile,
    sub.status,
  );
  if (!result.meta.changes)
    throw new ApiError(
      409,
      "subscription_conflict",
      "A assinatura mudou enquanto isso. Atualize e tente de novo.",
    );
  let cancelled = 0;
  if (to !== "active") {
    const rows = await all(
      ctx.env,
      "UPDATE mensalidade_installments SET status='cancelled',cancelled_at=?,updated=? WHERE subscription_id=? AND profile_id=? AND status='open' AND due_date>=? RETURNING id,payment_id,payment_status",
      at,
      at,
      sub.id,
      ctx.profile,
      day,
    );
    cancelled = rows.length;
    for (const row of rows) await cancelOpenCharge(ctx, row);
  }
  await ctx.publish("mensalidade.subscription_changed", sub.id, {
    subscription_id: sub.id,
    change: to === "active" ? "resumed" : to,
    from: sub.status,
    status: to,
    cancelled_installments: cancelled,
    actor,
  });
  return loadSubscription(ctx, sub.id);
}

// ---------------------------------------------------------------------------
// Importação

export const IMPORT_LIMIT = 300;

/**
 * Vários clientes de uma vez: cada linha `{customer_name, phone, plan_id ou
 * plan (nome), amount_cents?, discount_cents?, due_day?, start_date?, notes?}`.
 * Linhas com erro voltam em `errors` (número da linha começando em 1) e não
 * impedem as outras. Telefone que já tem assinatura ativa ou pausada no mesmo
 * plano é pulado, para reimportar a mesma planilha sem duplicar.
 */
export async function importSubscriptions(
  ctx: ModuleContext,
  rows: unknown,
  actor: string,
) {
  requireValue(
    Array.isArray(rows) && rows.length >= 1 && rows.length <= IMPORT_LIMIT,
    `Envie de 1 a ${IMPORT_LIMIT} linhas em rows.`,
  );
  const plans = await all(
    ctx.env,
    "SELECT * FROM mensalidade_plans WHERE profile_id=?",
    ctx.profile,
  );
  const byName = new Map(
    plans.map((p) => [String(p.name).trim().toLowerCase(), p.id]),
  );
  const created: any[] = [],
    skipped: { line: number; reason: string }[] = [],
    errors: { line: number; message: string }[] = [];
  for (const [index, raw] of (rows as any[]).entries()) {
    const line = index + 1;
    try {
      requireValue(raw && typeof raw === "object", "Linha inválida.");
      const planId =
        raw.plan_id ||
        (typeof raw.plan === "string"
          ? byName.get(raw.plan.trim().toLowerCase())
          : undefined);
      requireValue(
        planId,
        `Plano não encontrado: ${raw.plan ?? raw.plan_id ?? ""}.`,
      );
      const phone = phoneDigits(raw.phone);
      const duplicate = await one(
        ctx.env,
        "SELECT id FROM mensalidade_subscriptions WHERE profile_id=? AND phone=? AND plan_id=? AND status<>'ended'",
        ctx.profile,
        phone,
        planId,
      );
      if (duplicate) {
        skipped.push({ line, reason: "Já tem assinatura neste plano." });
        continue;
      }
      const sub = await createSubscription(
        ctx,
        {
          plan_id: planId,
          customer_name: raw.customer_name ?? raw.name,
          phone: raw.phone,
          amount_cents: raw.amount_cents,
          discount_cents: raw.discount_cents,
          due_day: raw.due_day,
          start_date: raw.start_date,
          notes: raw.notes,
          document: raw.document,
          payer_name: raw.payer_name,
        },
        actor,
      );
      created.push(subscriptionView(sub));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push({ line, message: error.message });
    }
  }
  return { created, skipped, errors };
}

/** Resumo de uma parcela para mensagens ("Inglês Kids — nov/2026: R$ 180,00"). */
export const installmentTitle = (inst: any, planName?: string | null) =>
  `${planName ? planName + " — " : ""}${periodLabel(inst.period_key)}: ${money(inst.amount_cents)}`;
