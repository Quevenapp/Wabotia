// Caixa: caixas do balcão, sessões (abertura e fechamento), sangria e
// suprimento, e os totais da sessão calculados a partir das vendas e
// devoluções do módulo Vendas (só pela interface de ../vendas/public.ts).
import { all, batch, one } from "../../db";
import { ApiError, type Actor, json, now, requireValue, uid } from "../../types";
import { admin } from "../../security";
import type { ModuleContext } from "../api";
import {
  PAYMENT_LABELS,
  sessionSales,
  type PaymentMethod,
} from "../vendas/public";

const MAX_CENTS = 100_000_000;

const text = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null || value === "") return "";
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what}: até ${max} caracteres.`,
  );
  return (value as string).trim();
};
const cents = (value: unknown, what: string, positive = false) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= (positive ? 1 : 0) &&
      (value as number) <= MAX_CENTS,
    `${what} em centavos (inteiro${positive ? " maior que zero" : " de 0 em diante"}).`,
  );
  return value as number;
};
const money = (value: number) =>
  "R$ " +
  (value / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Pessoas da equipe; aplicações com billing:write (operação financeira). */
export function requireCashier(ctx: ModuleContext, actor: Actor) {
  if (actor.kind === "app") ctx.access(actor, "billing:write");
  else ctx.access(actor, "conversations:write");
}

// ---------------------------------------------------------------------------
// Caixas

export const registerView = (row: any, session: any = null) => ({
  id: row.id,
  name: row.name,
  active: !!row.active,
  position: row.position,
  session: session ? sessionBrief(session) : null,
  created: row.created,
  updated: row.updated,
});

const sessionBrief = (row: any) => ({
  id: row.id,
  number: row.number,
  status: row.status,
  opened_by: row.opened_by,
  opened_at: row.opened_at,
  opening_cents: row.opening_cents,
});

export async function listRegisters(ctx: ModuleContext) {
  const [registers, open] = await Promise.all([
    all(
      ctx.env,
      "SELECT * FROM caixa_registers WHERE profile_id=? ORDER BY active DESC,position,name COLLATE NOCASE",
      ctx.profile,
    ),
    all(
      ctx.env,
      "SELECT * FROM caixa_sessions WHERE profile_id=? AND status='open'",
      ctx.profile,
    ),
  ]);
  return registers.map((r) =>
    registerView(r, open.find((s) => s.register_id === r.id) || null),
  );
}

/** POST caixa/registers, PUT caixa/registers/:id {name, active?, position?}. */
export async function saveRegister(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM caixa_registers WHERE id=? AND profile_id=?",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing)
    throw new ApiError(404, "not_found", "Caixa não encontrado.");
  const name =
    Object.hasOwn(data, "name") || !existing
      ? text(data.name, 40, "Nome do caixa")
      : existing.name;
  requireValue(name, "Informe o nome do caixa (ex.: Caixa 1).");
  let active = existing ? existing.active : 1;
  if (Object.hasOwn(data, "active")) {
    requireValue(typeof data.active === "boolean", "Ativo: verdadeiro ou falso.");
    active = data.active ? 1 : 0;
  }
  const position = Object.hasOwn(data, "position")
    ? data.position
    : (existing?.position ?? 0);
  requireValue(
    Number.isInteger(position) && position >= 0 && position <= 1000,
    "Posição: inteiro de 0 a 1000.",
  );
  if (existing && !active) {
    const open = await one(
      ctx.env,
      "SELECT id FROM caixa_sessions WHERE register_id=? AND status='open'",
      existing.id,
    );
    if (open)
      throw new ApiError(
        409,
        "session_open",
        "Feche o caixa antes de desativá-lo.",
      );
  }
  const at = now();
  const id = existing?.id || uid();
  if (existing)
    await batch(ctx.env, [
      [
        "UPDATE caixa_registers SET name=?,active=?,position=?,updated=? WHERE id=? AND profile_id=?",
        [name, active, position, at, id, ctx.profile],
      ],
    ]);
  else {
    const count = await one<{ n: number }>(
      ctx.env,
      "SELECT count(*) n FROM caixa_registers WHERE profile_id=?",
      ctx.profile,
    );
    requireValue((count?.n || 0) < 50, "Até 50 caixas por área.");
    await batch(ctx.env, [
      [
        "INSERT INTO caixa_registers(id,profile_id,name,active,position,created,updated) VALUES(?,?,?,?,?,?,?)",
        [id, ctx.profile, name, active, position, at, at],
      ],
    ]);
  }
  await ctx.publish("caixa.register_changed", id, { register_id: id, name, active: !!active, actor: actor.id });
  const row = await one(ctx.env, "SELECT * FROM caixa_registers WHERE id=?", id);
  return registerView(row);
}

// ---------------------------------------------------------------------------
// Sessões

export async function loadSession(ctx: ModuleContext, id: unknown) {
  const row = await one(
    ctx.env,
    "SELECT s.*,r.name register_name FROM caixa_sessions s LEFT JOIN caixa_registers r ON r.id=s.register_id WHERE s.id=? AND s.profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Sessão do caixa não encontrada.");
  return row;
}

export function requireOpen(session: any) {
  if (session.status !== "open")
    throw new ApiError(
      409,
      "session_closed",
      `O caixa nº ${session.number} já foi fechado. Abra o caixa de novo para vender.`,
    );
}

export interface Summary {
  opening_cents: number;
  supplies_cents: number;
  withdrawals_cents: number;
  sales: {
    count: number;
    total_cents: number;
    discount_cents: number;
    cancelled_count: number;
    cancelled_cents: number;
    awaiting_count: number;
  };
  by_method: { method: PaymentMethod; label: string; count: number; amount_cents: number }[];
  change_cents: number;
  returns: {
    count: number;
    total_cents: number;
    by_method: { method: PaymentMethod; label: string; amount_cents: number }[];
  };
  cash: {
    sales_cents: number;
    returns_cents: number;
    expected_cents: number;
  };
}

/** Totais da sessão: vendas concluídas (e devolvidas depois), devoluções, sangrias e suprimentos. */
export async function sessionSummary(ctx: ModuleContext, session: any): Promise<Summary> {
  const [{ sales, returns }, moves] = await Promise.all([
    sessionSales(ctx, session.id),
    all(
      ctx.env,
      "SELECT kind,amount_cents FROM caixa_moves WHERE profile_id=? AND session_id=?",
      ctx.profile,
      session.id,
    ),
  ]);
  const methods = new Map<PaymentMethod, { count: number; amount_cents: number }>();
  let total = 0,
    discount = 0,
    change = 0,
    count = 0,
    cancelled = 0,
    cancelledCents = 0,
    awaiting = 0;
  for (const s of sales) {
    if (s.status === "cancelled") {
      cancelled++;
      cancelledCents += s.total_cents;
      continue;
    }
    if (s.status === "awaiting_payment") {
      awaiting++;
      continue;
    }
    count++;
    total += s.total_cents;
    discount += s.discount_cents;
    change += s.change_cents;
    for (const p of s.payments) {
      const m = methods.get(p.method) || { count: 0, amount_cents: 0 };
      m.count++;
      m.amount_cents += p.amount_cents;
      methods.set(p.method, m);
    }
  }
  // Dinheiro: o que entrou menos o troco dado.
  const cash = methods.get("cash");
  if (cash) cash.amount_cents -= change;
  const back = new Map<PaymentMethod, number>();
  let returned = 0;
  for (const r of returns) {
    returned += r.amount_cents;
    back.set(r.method, (back.get(r.method) || 0) + r.amount_cents);
  }
  const supplies = moves.filter((m) => m.kind === "supply").reduce((s, m) => s + m.amount_cents, 0);
  const withdrawals = moves.filter((m) => m.kind === "withdrawal").reduce((s, m) => s + m.amount_cents, 0);
  const cashSales = cash?.amount_cents || 0;
  const cashReturns = back.get("cash") || 0;
  return {
    opening_cents: session.opening_cents,
    supplies_cents: supplies,
    withdrawals_cents: withdrawals,
    sales: {
      count,
      total_cents: total,
      discount_cents: discount,
      cancelled_count: cancelled,
      cancelled_cents: cancelledCents,
      awaiting_count: awaiting,
    },
    by_method: [...methods.entries()].map(([method, m]) => ({
      method,
      label: PAYMENT_LABELS[method] || method,
      ...m,
    })),
    change_cents: change,
    returns: {
      count: returns.length,
      total_cents: returned,
      by_method: [...back.entries()].map(([method, amount]) => ({
        method,
        label: PAYMENT_LABELS[method] || method,
        amount_cents: amount,
      })),
    },
    cash: {
      sales_cents: cashSales,
      returns_cents: cashReturns,
      expected_cents:
        session.opening_cents + supplies - withdrawals + cashSales - cashReturns,
    },
  };
}

export function sessionView(row: any, summary: Summary | null = null) {
  return {
    id: row.id,
    number: row.number,
    register_id: row.register_id,
    register_name: row.register_name ?? null,
    status: row.status as "open" | "closed",
    opened_by: row.opened_by,
    opened_at: row.opened_at,
    opening_cents: row.opening_cents,
    opening_note: row.opening_note,
    closed_by: row.closed_by ?? null,
    closed_at: row.closed_at ?? null,
    counted_cents: row.counted_cents ?? null,
    expected_cash_cents: row.expected_cash_cents ?? null,
    difference_cents: row.difference_cents ?? null,
    closing_note: row.closing_note,
    summary: summary ?? (row.summary ? (json(row.summary, null) as Summary) : null),
    created: row.created,
    updated: row.updated,
  };
}
export type SessionView = ReturnType<typeof sessionView>;

/** POST caixa/registers/:id/open {opening_cents, note?}. */
export async function openSession(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  requireCashier(ctx, actor);
  const sourceKey = `open:${requestId}`;
  const repeated = await one(
    ctx.env,
    "SELECT id FROM caixa_sessions WHERE profile_id=? AND source_key=?",
    ctx.profile,
    sourceKey,
  );
  if (repeated) return sessionView(await loadSession(ctx, repeated.id));
  const register = await one(
    ctx.env,
    "SELECT * FROM caixa_registers WHERE id=? AND profile_id=?",
    data.id,
    ctx.profile,
  );
  if (!register) throw new ApiError(404, "not_found", "Caixa não encontrado.");
  requireValue(register.active, `O ${register.name} está desativado.`);
  const opening = cents(data.opening_cents ?? 0, "Troco inicial");
  const id = uid(),
    at = now();
  try {
    await batch(ctx.env, [
      [
        "INSERT INTO caixa_counters(profile_id,last) VALUES(?,1) ON CONFLICT(profile_id) DO UPDATE SET last=last+1",
        [ctx.profile],
      ],
      [
        "INSERT INTO caixa_sessions(id,profile_id,register_id,number,status,opened_by,opened_at,opening_cents,opening_note,source_key,created,updated) VALUES(?,?,?,(SELECT last FROM caixa_counters WHERE profile_id=?),'open',?,?,?,?,?,?,?)",
        [
          id,
          ctx.profile,
          register.id,
          ctx.profile,
          actor.id,
          at,
          opening,
          text(data.note, 300, "Observação"),
          sourceKey,
          at,
          at,
        ],
      ],
    ]);
  } catch (error) {
    if (/UNIQUE constraint/i.test(String((error as Error)?.message || error))) {
      const open = await one(
        ctx.env,
        "SELECT number,opened_by FROM caixa_sessions WHERE register_id=? AND status='open'",
        register.id,
      );
      throw new ApiError(
        409,
        "session_open",
        `O ${register.name} já está aberto${open ? ` (sessão nº ${open.number})` : ""}.`,
      );
    }
    throw error;
  }
  const session = await loadSession(ctx, id);
  await ctx.publish(
    "caixa.opened",
    id,
    {
      session_id: id,
      number: session.number,
      register_id: register.id,
      opening_cents: opening,
      actor: actor.id,
    },
    { key: `opened:${id}` },
  );
  return sessionView(session);
}

/**
 * POST caixa/sessions/:id/moves {kind: "withdrawal"|"supply", amount_cents, note?}.
 * Sangria até o dinheiro esperado na gaveta.
 */
export async function moveCash(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  requireCashier(ctx, actor);
  const key = `move:${requestId}`;
  const repeated = await one(
    ctx.env,
    "SELECT * FROM caixa_moves WHERE profile_id=? AND key=?",
    ctx.profile,
    key,
  );
  if (repeated) return moveView(repeated);
  const session = await loadSession(ctx, data.id);
  requireOpen(session);
  requireValue(
    data.kind === "withdrawal" || data.kind === "supply",
    "kind: withdrawal (sangria) ou supply (suprimento).",
  );
  const amount = cents(data.amount_cents, "Valor", true);
  if (data.kind === "withdrawal") {
    const summary = await sessionSummary(ctx, session);
    if (amount > summary.cash.expected_cents)
      throw new ApiError(
        409,
        "insufficient_cash",
        `A sangria (${money(amount)}) passa do dinheiro esperado na gaveta (${money(summary.cash.expected_cents)}).`,
      );
  }
  const id = uid(),
    at = now();
  await batch(ctx.env, [
    [
      "INSERT INTO caixa_moves(id,profile_id,session_id,kind,amount_cents,note,key,actor,created) VALUES(?,?,?,?,?,?,?,?,?)",
      [id, ctx.profile, session.id, data.kind, amount, text(data.note, 300, "Observação"), key, actor.id, at],
    ],
  ]);
  await ctx.publish(
    "caixa.moved",
    id,
    { session_id: session.id, kind: data.kind, amount_cents: amount, actor: actor.id },
    { key: `moved:${id}` },
  );
  return moveView(await one(ctx.env, "SELECT * FROM caixa_moves WHERE id=?", id));
}

export const moveView = (row: any) => ({
  id: row.id,
  session_id: row.session_id,
  kind: row.kind as "withdrawal" | "supply",
  kind_label: row.kind === "withdrawal" ? "Sangria" : "Suprimento",
  amount_cents: row.amount_cents,
  note: row.note,
  actor: row.actor,
  created: row.created,
});

/**
 * POST caixa/sessions/:id/close {counted_cents, note?}: quem abriu ou um
 * administrador. Congela o resumo, o dinheiro esperado e a diferença.
 */
export async function closeSession(ctx: ModuleContext, actor: Actor, data: any) {
  requireCashier(ctx, actor);
  const session = await loadSession(ctx, data.id);
  if (session.status === "closed") return sessionView(session);
  requireValue(
    session.opened_by === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      actor.kind === "app",
    "Só quem abriu o caixa ou um administrador pode fechá-lo.",
  );
  const counted = cents(data.counted_cents, "Dinheiro contado");
  const summary = await sessionSummary(ctx, session);
  const at = now();
  await batch(ctx.env, [
    [
      "UPDATE caixa_sessions SET status='closed',closed_by=?,closed_at=?,counted_cents=?,expected_cash_cents=?,difference_cents=?,summary=?,closing_note=?,updated=? WHERE id=? AND profile_id=? AND status='open'",
      [
        actor.id,
        at,
        counted,
        summary.cash.expected_cents,
        counted - summary.cash.expected_cents,
        JSON.stringify(summary),
        text(data.note, 500, "Observação"),
        at,
        session.id,
        ctx.profile,
      ],
    ],
  ]);
  const next = await loadSession(ctx, session.id);
  await ctx.publish(
    "caixa.closed",
    session.id,
    {
      session_id: session.id,
      number: session.number,
      register_id: session.register_id,
      counted_cents: counted,
      expected_cash_cents: summary.cash.expected_cents,
      difference_cents: counted - summary.cash.expected_cents,
      sales_count: summary.sales.count,
      sales_total_cents: summary.sales.total_cents,
      actor: actor.id,
    },
    { key: `closed:${session.id}` },
  );
  return sessionView(next);
}

/** GET caixa/sessions/:id: sessão, resumo (ao vivo se aberta), movimentos e vendas. */
export async function sessionDetail(ctx: ModuleContext, id: unknown) {
  const session = await loadSession(ctx, id);
  const [summary, moves, records] = await Promise.all([
    session.status === "open" ? sessionSummary(ctx, session) : Promise.resolve(null),
    all(
      ctx.env,
      "SELECT * FROM caixa_moves WHERE profile_id=? AND session_id=? ORDER BY created",
      ctx.profile,
      session.id,
    ),
    sessionSales(ctx, session.id),
  ]);
  return {
    ...sessionView(session, summary),
    moves: moves.map(moveView),
    sales: records.sales.map((s) => ({
      id: s.id,
      number: s.number,
      status: s.status,
      status_label: s.status_label,
      total_cents: s.total_cents,
      methods: s.payments.map((p) => p.method),
      created_by: s.created_by,
      created: s.created,
    })),
    returns: records.returns,
  };
}

/** GET caixa/sessions?register_id=&status=&limit=&cursor=. */
export async function listSessions(ctx: ModuleContext, query: Record<string, string>) {
  const where = ["s.profile_id=?"];
  const args: any[] = [ctx.profile];
  if (query.register_id) {
    where.push("s.register_id=?");
    args.push(query.register_id);
  }
  if (query.status) {
    requireValue(["open", "closed"].includes(query.status), "status: open ou closed.");
    where.push("s.status=?");
    args.push(query.status);
  }
  if (query.cursor) {
    where.push("s.number<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
  const rows = await all(
    ctx.env,
    `SELECT s.*,r.name register_name FROM caixa_sessions s LEFT JOIN caixa_registers r ON r.id=s.register_id WHERE ${where.join(" AND ")} ORDER BY s.number DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    data: page.map((r) => sessionView(r)),
    next_cursor: rows.length > limit ? String(page.at(-1)!.number) : null,
  };
}

// ---------------------------------------------------------------------------
// Relatório de fechamento em texto (impressora térmica)

const width = (v: string) => Array.from(v).length;
function pair(left: string, right: string, columns: number) {
  const l = Array.from(left).slice(0, Math.max(1, columns - width(right) - 1)).join("");
  return l + " ".repeat(Math.max(1, columns - width(l) - width(right))) + right;
}
const center = (v: string, columns: number) =>
  " ".repeat(Math.max(0, Math.floor((columns - width(v)) / 2))) + v;

const BRT = 3 * 3600000;
const stamp = (at: number) => {
  const d = new Date(at - BRT),
    two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

export function reportText(name: string, s: SessionView, columns: number) {
  const sum = s.summary!;
  const rule = "-".repeat(columns);
  const out = [
    center(name.toUpperCase().slice(0, columns), columns),
    center(
      s.status === "open" ? "PARCIAL DO CAIXA" : "FECHAMENTO DO CAIXA",
      columns,
    ),
    rule,
    pair(`${s.register_name || "Caixa"} · sessão ${s.number}`, "", columns).trimEnd(),
    pair("Abertura", stamp(s.opened_at), columns),
    ...(s.closed_at ? [pair("Fechamento", stamp(s.closed_at), columns)] : []),
    rule,
    pair(`Vendas (${sum.sales.count})`, money(sum.sales.total_cents), columns),
    ...(sum.sales.discount_cents ? [pair("Descontos", money(sum.sales.discount_cents), columns)] : []),
    ...(sum.sales.cancelled_count
      ? [pair(`Canceladas (${sum.sales.cancelled_count})`, money(sum.sales.cancelled_cents), columns)]
      : []),
    ...sum.by_method.map((m) => pair(`  ${m.label}`, money(m.amount_cents), columns)),
    ...(sum.returns.count
      ? [pair(`Devoluções (${sum.returns.count})`, `-${money(sum.returns.total_cents)}`, columns)]
      : []),
    rule,
    pair("Troco inicial", money(sum.opening_cents), columns),
    pair("Suprimentos", money(sum.supplies_cents), columns),
    pair("Sangrias", `-${money(sum.withdrawals_cents)}`, columns),
    pair("Dinheiro de vendas", money(sum.cash.sales_cents), columns),
    ...(sum.cash.returns_cents ? [pair("Devolvido em dinheiro", `-${money(sum.cash.returns_cents)}`, columns)] : []),
    pair("ESPERADO NA GAVETA", money(sum.cash.expected_cents), columns),
  ];
  if (s.counted_cents !== null) {
    out.push(pair("CONTADO", money(s.counted_cents), columns));
    const diff = s.difference_cents || 0;
    out.push(
      pair(
        diff === 0 ? "Diferença" : diff > 0 ? "Sobra" : "Falta",
        money(Math.abs(diff)),
        columns,
      ),
    );
  }
  return out.join("\n");
}
