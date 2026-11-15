// Mensalidade: parcelas. Geração pelo gancho periódico (uma por período, sem
// duplicar), parcelas vencidas, baixa manual, isenção, lista por mês, resumo
// e inadimplentes. Função pura em relação ao relógio: recebe `at`.
import { all, exec, one } from "../../db";
import { ApiError, now, requireValue, uid } from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";
import { modulesApi, type ModuleContext } from "../api";
import {
  INSTALLMENT_LABELS,
  addDays,
  isDate,
  isInstallmentStatus,
  today,
  dueDates,
  text,
  type InstallmentStatus,
  type Period,
  csv,
  pageLimit,
} from "./model";
import { cancelOpenCharge, installmentView, notFound } from "./store";
import { announcePaid } from "./listeners";

/** Parcelas nascem até este número de dias antes do vencimento. */
export const GENERATE_AHEAD_DAYS = 31;
const BATCH = 200;

/**
 * Gera as parcelas das assinaturas ativas com vencimento até hoje + 31 dias.
 * A chave única (assinatura, competência) impede repetir a parcela em rodadas
 * repetidas ou concorrentes; `checked_until` evita reler as assinaturas já
 * conferidas até o mesmo horizonte. Pausadas e encerradas não geram; ao
 * retomar, `bill_from` pula os períodos da pausa.
 */
export async function generateInstallments(
  ctx: ModuleContext,
  at: number,
  subscriptionId?: string,
) {
  const day = today(at);
  const horizon = addDays(day, GENERATE_AHEAD_DAYS);
  const subs = await all(
    ctx.env,
    // Contratada pelo WhatsApp e com a primeira parcela ainda sem pagar: não
    // gera as seguintes (nem avisos) até o pagamento.
    `SELECT * FROM mensalidade_subscriptions s WHERE profile_id=? AND status='active' AND (checked_until IS NULL OR checked_until<?)${subscriptionId ? " AND id=?" : ""} AND NOT EXISTS(SELECT 1 FROM mensalidade_installments u WHERE u.subscription_id=s.id AND u.upfront=1 AND u.status IN ('open','overdue')) ORDER BY id LIMIT ?`,
    ctx.profile,
    horizon,
    ...(subscriptionId ? [subscriptionId] : []),
    BATCH,
  );
  let created = 0;
  for (const sub of subs) {
    const dues = dueDates(
      {
        start_date: sub.start_date,
        due_day: sub.due_day,
        period: sub.period as Period,
        bill_from: sub.bill_from,
        end_date: sub.end_date,
      },
      horizon,
    ).filter((d) => !sub.checked_until || d.due_date > sub.checked_until);
    for (const due of dues) {
      const id = uid();
      const late = due.due_date < day;
      const result = await exec(
        ctx.env,
        "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,retroactive,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,period_key) DO NOTHING",
        id,
        ctx.profile,
        sub.id,
        due.period_key,
        due.due_date,
        sub.amount_cents - sub.discount_cents,
        late ? "overdue" : "open",
        late ? 1 : 0,
        at,
        at,
      );
      if (!result.meta.changes) continue;
      created++;
      await ctx.publish(
        "mensalidade.installment_created",
        id,
        {
          installment_id: id,
          subscription_id: sub.id,
          period_key: due.period_key,
          due_date: due.due_date,
          amount_cents: sub.amount_cents - sub.discount_cents,
          status: late ? "overdue" : "open",
          retroactive: late,
        },
        { key: id },
      );
    }
    await exec(
      ctx.env,
      "UPDATE mensalidade_subscriptions SET checked_until=? WHERE id=? AND status='active' AND checked_until IS ?",
      horizon,
      sub.id,
      sub.checked_until,
    );
  }
  return created;
}

/** Abertas com vencimento antes de hoje passam a vencidas (evento por parcela). */
export async function markOverdue(ctx: ModuleContext, at: number) {
  const rows = await all(
    ctx.env,
    "UPDATE mensalidade_installments SET status='overdue',updated=? WHERE profile_id=? AND status='open' AND due_date<? RETURNING *",
    at,
    ctx.profile,
    today(at),
  );
  for (const row of rows)
    await ctx.publish(
      "mensalidade.overdue",
      row.id,
      {
        installment_id: row.id,
        subscription_id: row.subscription_id,
        period_key: row.period_key,
        due_date: row.due_date,
        amount_cents: row.amount_cents,
      },
      { key: `${row.id}:${row.updated}` },
    );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Leitura

export async function loadInstallment(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound("Parcela");
  const row = await one(
    ctx.env,
    "SELECT i.*,s.customer_name,s.phone,s.conversation_id,s.status AS subscription_status,p.name AS plan_name FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE i.id=? AND i.profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound("Parcela");
  return row;
}

const month = (value: unknown) => {
  requireValue(
    typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
    "Mês no formato AAAA-MM.",
  );
  return value;
};

/**
 * GET mensalidade/installments: por competência (`month=AAAA-MM`, padrão o
 * mês atual), estado (`status=a,b`), assinatura, busca e paginação.
 */
export async function listInstallments(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["i.profile_id=?"],
    args: any[] = [ctx.profile];
  if (query.subscription_id) {
    where.push("i.subscription_id=?");
    args.push(query.subscription_id);
  }
  const competence = query.subscription_id
    ? query.month
      ? month(query.month)
      : null
    : month(query.month || today(now()).slice(0, 7));
  if (competence) {
    where.push("i.period_key=?");
    args.push(competence);
  }
  const countsWhere = where.join(" AND "),
    countsArgs = [...args];
  const statuses = csv(query.status);
  for (const s of statuses)
    requireValue(isInstallmentStatus(s), `Estado desconhecido: ${s}.`);
  if (statuses.length) {
    where.push(`i.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like =
      "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    where.push(
      "(lower(s.customer_name) LIKE ? ESCAPE '\\'" +
        (digits.length >= 4 ? " OR s.phone LIKE ?" : "") +
        ")",
    );
    args.push(like);
    if (digits.length >= 4) args.push("%" + digits + "%");
  }
  if (query.cursor) {
    const [due, id] = String(query.cursor).split("|");
    where.push("(i.due_date>? OR (i.due_date=? AND i.id>?))");
    args.push(due, due, id || "");
  }
  const limit = pageLimit(query.limit, 100, 300);
  const rows = await all(
    ctx.env,
    `SELECT i.*,s.customer_name,s.phone,p.name AS plan_name FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE ${where.join(" AND ")} ORDER BY i.due_date,i.id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        `SELECT i.status,count(*) AS n FROM mensalidade_installments i WHERE ${countsWhere} GROUP BY i.status`,
        ...countsArgs,
      )
    ).map((r) => [r.status, r.n]),
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    month: competence,
    data: page.map(installmentView),
    next_cursor: more ? `${page.at(-1)!.due_date}|${page.at(-1)!.id}` : null,
    counts,
  };
}

/** Cobrança configurada na área (módulo Cobrança ligado e conta ativa). */
export async function paymentsReady(ctx: ModuleContext) {
  return (await ctx.paymentsReady()).ready;
}

/**
 * GET mensalidade/summary?month=AAAA-MM: previsto (parcelas da competência,
 * sem canceladas e isentas), recebido, em atraso e em aberto; e o que entrou
 * no mês pela data do pagamento, de qualquer competência.
 */
export async function summary(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const competence = month(query.month || today(now()).slice(0, 7));
  const rows = await all(
    ctx.env,
    "SELECT status,count(*) AS n,coalesce(sum(amount_cents),0) AS cents FROM mensalidade_installments WHERE profile_id=? AND period_key=? GROUP BY status",
    ctx.profile,
    competence,
  );
  const by = (status: InstallmentStatus) =>
    rows.find((r) => r.status === status) || { n: 0, cents: 0 };
  const [y, m] = competence.split("-").map(Number);
  // Pagamentos do mês pela data, em Brasília (paid_at em ms).
  const from = Date.UTC(y, m - 1, 1) + BRASILIA_OFFSET_MS,
    to = Date.UTC(y, m, 1) + BRASILIA_OFFSET_MS;
  const inMonth = await one(
    ctx.env,
    "SELECT count(*) AS n,coalesce(sum(amount_cents),0) AS cents FROM mensalidade_installments WHERE profile_id=? AND status='paid' AND paid_at>=? AND paid_at<?",
    ctx.profile,
    from,
    to,
  );
  const overdueAll = await one(
    ctx.env,
    "SELECT count(*) AS n,coalesce(sum(amount_cents),0) AS cents,count(DISTINCT subscription_id) AS subs FROM mensalidade_installments WHERE profile_id=? AND status='overdue'",
    ctx.profile,
  );
  const expected = ["open", "paid", "overdue"].reduce(
    (sum, s) => sum + by(s as InstallmentStatus).cents,
    0,
  );
  return {
    month: competence,
    expected_cents: expected,
    received_cents: by("paid").cents,
    overdue_cents: by("overdue").cents,
    open_cents: by("open").cents,
    waived_cents: by("waived").cents,
    counts: Object.fromEntries(
      (Object.keys(INSTALLMENT_LABELS) as InstallmentStatus[]).map((s) => [
        s,
        by(s).n,
      ]),
    ),
    received_in_month: { count: inMonth?.n || 0, cents: inMonth?.cents || 0 },
    overdue_total: {
      count: overdueAll?.n || 0,
      cents: overdueAll?.cents || 0,
      subscriptions: overdueAll?.subs || 0,
    },
    payments_ready: await paymentsReady(ctx),
  };
}

/** GET mensalidade/delinquents: assinaturas com parcelas vencidas. */
export async function delinquents(ctx: ModuleContext) {
  const rows = await all(
    ctx.env,
    "SELECT s.id,s.customer_name,s.phone,s.conversation_id,s.status,p.name AS plan_name,count(*) AS overdue_count,sum(i.amount_cents) AS overdue_cents,min(i.due_date) AS oldest_due_date,max(i.overdue_notices) AS notices FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE i.profile_id=? AND i.status='overdue' GROUP BY s.id ORDER BY oldest_due_date,s.id LIMIT 500",
    ctx.profile,
  );
  return {
    data: rows.map((r) => ({
      subscription_id: r.id,
      customer: {
        name: r.customer_name,
        phone: r.phone,
        conversation_id: r.conversation_id,
      },
      plan_name: r.plan_name,
      subscription_status: r.status,
      overdue_count: r.overdue_count,
      overdue_cents: r.overdue_cents,
      oldest_due_date: r.oldest_due_date,
      notices_sent: r.notices,
    })),
  };
}

// ---------------------------------------------------------------------------
// Baixa manual e isenção (equipe)

/**
 * Baixa manual: o cliente pagou em dinheiro, transferência ou outra forma
 * fora da cobrança. Registra quem deu baixa, quando e a observação. Só a
 * equipe chama (nunca uma mensagem do cliente).
 */
export async function payManually(
  ctx: ModuleContext,
  inst: any,
  actor: string,
  data: { note?: unknown; paid_at?: unknown },
) {
  const note = text(data.note, 300, "a observação");
  let paidAt = now();
  if (
    data.paid_at !== undefined &&
    data.paid_at !== null &&
    data.paid_at !== ""
  ) {
    if (isDate(data.paid_at))
      paidAt = Date.parse(data.paid_at + "T12:00:00-03:00");
    else {
      requireValue(
        Number.isInteger(data.paid_at) && (data.paid_at as number) > 0,
        "Data do pagamento: AAAA-MM-DD ou milissegundos.",
      );
      paidAt = data.paid_at as number;
    }
    requireValue(
      paidAt <= now() + 60000,
      "A data do pagamento não pode ser futura.",
    );
  }
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE mensalidade_installments SET status='paid',paid_at=?,paid_via='manual',paid_by=?,paid_note=?,updated=? WHERE id=? AND profile_id=? AND status IN ('open','overdue')",
    paidAt,
    actor,
    note,
    at,
    inst.id,
    ctx.profile,
  );
  if (!result.meta.changes)
    throw new ApiError(
      409,
      "installment_not_payable",
      `A parcela de ${inst.period_key} está "${INSTALLMENT_LABELS[inst.status as InstallmentStatus]}" e não pode receber baixa.`,
    );
  // O Pix ou link que ainda estava aberto deixa de valer.
  await cancelOpenCharge(ctx, inst);
  const fresh = await loadInstallment(ctx, inst.id);
  await ctx.publish(
    "mensalidade.paid",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      period_key: inst.period_key,
      amount_cents: inst.amount_cents,
      via: "manual",
      by: actor,
      paid_at: paidAt,
      note,
      payment_id: inst.payment_id,
    },
    { key: `${inst.id}:manual:${paidAt}` },
  );
  await announcePaid(ctx.env, ctx.profile, inst.id);
  return fresh;
}

/** Isentar: a parcela não será cobrada (bolsa, cortesia, acordo). */
export async function waive(
  ctx: ModuleContext,
  inst: any,
  actor: string,
  data: { note?: unknown },
) {
  const note = text(data.note, 300, "o motivo");
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE mensalidade_installments SET status='waived',waived_at=?,waived_by=?,paid_note=?,updated=? WHERE id=? AND profile_id=? AND status IN ('open','overdue','cancelled')",
    at,
    actor,
    note,
    at,
    inst.id,
    ctx.profile,
  );
  if (!result.meta.changes)
    throw new ApiError(
      409,
      "installment_not_payable",
      `A parcela de ${inst.period_key} está "${INSTALLMENT_LABELS[inst.status as InstallmentStatus]}" e não pode ser isentada.`,
    );
  await cancelOpenCharge(ctx, inst);
  await ctx.publish(
    "mensalidade.waived",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      period_key: inst.period_key,
      amount_cents: inst.amount_cents,
      by: actor,
      note,
    },
    { key: `${inst.id}:waived:${at}` },
  );
  return loadInstallment(ctx, inst.id);
}
