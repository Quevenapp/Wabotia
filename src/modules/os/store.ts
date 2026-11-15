// Ordem de Serviço: banco e regras com efeito (abrir, mudar estado, orçamento,
// resposta do cliente, acompanhamento). Fala com o núcleo pela interface de
// src/modules/api.ts; só lê tabelas do núcleo (usuários, linha da conversa).
import { all, batch, exec, one } from "../../db";
import {
  ApiError,
  type Conversation,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import type { InteractiveSpec, ModuleContext } from "../api";
import {
  CLOSED,
  MANUAL_TRANSITIONS,
  QUOTABLE,
  STATUS_LABELS,
  TEXT_KEYS,
  day,
  endOfDayAfter,
  fill,
  isStatus,
  money,
  nextStatuses,
  orderValues,
  osSettings,
  phoneDigits,
  quoteTotal,
  validateQuoteItems,
  type OsStatus,
  type QuoteItem,
  type TextKey,
} from "./model";

export type OrderSource = "agent" | "panel" | "customer" | "api";

const notFound = () =>
  new ApiError(404, "not_found", "Ordem de serviço não encontrada.");

const text = (
  value: unknown,
  max: number,
  what: string,
  required = false,
): string => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
};

const optionalTime = (value: unknown, what: string) => {
  if (value === undefined || value === null || value === "") return null;
  requireValue(
    Number.isInteger(value) && (value as number) > 0,
    `${what}: informe o instante em milissegundos.`,
  );
  return value as number;
};

/** Pessoa responsável: um usuário com acesso à área, ou nenhum. */
async function assignee(ctx: ModuleContext, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  requireValue(typeof value === "string", "Responsável inválido.");
  const user = await one(
    ctx.env,
    "SELECT id,role,profiles FROM users WHERE id=?",
    value,
  );
  requireValue(
    user &&
      (user.role === "admin" ||
        (json(user.profiles, []) as string[]).includes(ctx.profile)),
    "Responsável não encontrado nesta área de atendimento.",
  );
  return user.id as string;
}

// ---------------------------------------------------------------------------
// Leitura

/** Formato da API (docs/API.md, ServiceOrder). */
export function orderView(row: any, history?: any[]) {
  const status = row.status as OsStatus;
  const items: QuoteItem[] | null = row.quote_items
    ? json(row.quote_items, [])
    : null;
  return {
    id: row.id,
    number: row.number,
    status,
    status_label: STATUS_LABELS[status] || status,
    customer: {
      name: row.customer_name,
      phone: row.phone,
      contact_id: row.contact_id,
      conversation_id: row.conversation_id,
    },
    item: row.item,
    problem: row.problem,
    notes: row.notes,
    assignee: row.assignee,
    due_at: row.due_at,
    source: row.source,
    terms: row.terms_accepted_at
      ? { text: row.terms_text, accepted_at: row.terms_accepted_at }
      : null,
    quote: items
      ? {
          items,
          total_cents: row.quote_total_cents,
          note: row.quote_note || "",
          valid_days: row.quote_valid_days,
          valid_until: row.quote_valid_until,
          sent_at: row.quote_sent_at,
          version: row.quote_version,
          expired: !!row.quote_valid_until && row.quote_valid_until <= now(),
        }
      : null,
    decision: row.decision
      ? {
          decision: row.decision,
          at: row.decided_at,
          by: row.decided_by,
          via: row.decided_via,
        }
      : null,
    ready_at: row.ready_at,
    delivered_at: row.delivered_at,
    warranty_until: row.warranty_until,
    next_statuses: nextStatuses(status, !!items),
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

export async function loadOrder(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM os_orders WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  return row;
}

export const orderHistory = (ctx: ModuleContext, id: string) =>
  all(
    ctx.env,
    "SELECT * FROM os_history WHERE order_id=? AND profile_id=? ORDER BY created,rowid",
    id,
    ctx.profile,
  );

/** GET service-orders: filtro por estado, busca e paginação por número. */
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
  } else if (query.open === "1") {
    where.push("status NOT IN ('delivered','cancelled')");
  }
  if (query.conversation_id) {
    where.push("conversation_id=?");
    args.push(query.conversation_id);
  }
  if (query.phone) {
    where.push("phone=?");
    args.push(phoneDigits(query.phone));
  }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like =
      "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    // Só dígitos: número da ordem; a partir de 4 dígitos, também telefone.
    const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, "") : "";
    where.push(
      "(lower(item) LIKE ? ESCAPE '\\' OR lower(customer_name) LIKE ? ESCAPE '\\' OR lower(problem) LIKE ? ESCAPE '\\'" +
        (digits ? " OR number=?" : "") +
        (digits.length >= 4 ? " OR phone LIKE ?" : "") +
        ")",
    );
    args.push(like, like, like);
    if (digits) args.push(Number(digits));
    if (digits.length >= 4) args.push("%" + digits + "%");
  }
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        "SELECT status,count(*) AS n FROM os_orders WHERE profile_id=? GROUP BY status",
        ctx.profile,
      )
    ).map((r) => [r.status, r.n]),
  );
  // Paginação por número: next_cursor volta em `cursor` (ou `before`).
  const before = Number(query.cursor || query.before);
  if (Number.isInteger(before) && before > 0) {
    where.push("number<?");
    args.push(before);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM os_orders WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`,
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

// ---------------------------------------------------------------------------
// Avisos ao cliente

async function conversationOf(ctx: ModuleContext, order: any) {
  if (!order.conversation_id) return null;
  try {
    return await ctx.conversation(order.conversation_id);
  } catch {
    return null;
  }
}

/**
 * Mensagem configurável (Gestão → Ordem de serviço) à conversa da ordem.
 * Fora da janela de 24 horas sai pelo modelo de notificação. Sem conversa ou
 * com o texto vazio, nada é enviado.
 */
export async function notify(
  ctx: ModuleContext,
  order: any,
  textKey: TextKey,
  key: string,
) {
  const template = osSettings(await ctx.settings()).texts[textKey];
  if (!template) return null;
  const c = await conversationOf(ctx, order);
  if (!c || c.chat_type === "group") return null;
  return ctx.sendMessage(
    c,
    { text: fill(template, orderValues(order)) },
    { key, notification: true },
  );
}

// ---------------------------------------------------------------------------
// Abrir

export interface CreateInput {
  conversation?: Conversation | null;
  customer_name?: unknown;
  phone?: unknown;
  item: unknown;
  problem: unknown;
  notes?: unknown;
  assignee?: unknown;
  due_at?: unknown;
  source: OrderSource;
  /** Repetir a mesma chave devolve a ordem já aberta. */
  sourceKey: string;
  actor: string;
  /** Texto dos termos aceitos pelo cliente (abertura pelo passo web). */
  terms?: string | null;
  /** Avisa o cliente na conversa (padrão: sim, quando há conversa). */
  notify?: boolean;
}

/**
 * Abre a ordem com o próximo número da área. O número sai de um UPSERT com
 * RETURNING (atômico no D1), então pedidos simultâneos, dentro ou fora do
 * Coordinator, nunca repetem número.
 */
export async function createOrder(ctx: ModuleContext, input: CreateInput) {
  const existing = await one(
    ctx.env,
    "SELECT * FROM os_orders WHERE source_key=?",
    input.sourceKey,
  );
  if (existing) return { order: existing, created: false };
  const item = text(input.item, 200, "o item ou equipamento", true);
  const problem = text(input.problem, 2000, "o relato do problema", true);
  const notes = text(input.notes, 4000, "as observações internas");
  const owner = await assignee(ctx, input.assignee);
  const due = optionalTime(input.due_at, "Prazo previsto");
  const c = input.conversation || null;
  if (c)
    requireValue(
      c.chat_type !== "group",
      "Abra ordens de serviço só em conversas individuais.",
    );
  const contact = c ? await ctx.contact(c) : null;
  const phone = phoneDigits(
    text(input.phone, 40, "o telefone") || c?.phone || contact?.phone || "",
  );
  requireValue(
    c || phone.length >= 8,
    "Informe a conversa ou o telefone do cliente.",
  );
  const name =
    text(input.customer_name, 120, "o nome do cliente") || contact?.name || "";
  const counter = await one<{ last: number }>(
    ctx.env,
    "INSERT INTO os_counters(profile_id,last) VALUES(?,1) ON CONFLICT(profile_id) DO UPDATE SET last=last+1 RETURNING last",
    ctx.profile,
  );
  const id = uid(),
    at = now();
  const [inserted] = await batch(ctx.env, [
    [
      "INSERT INTO os_orders(id,profile_id,number,status,conversation_id,contact_id,customer_name,phone,item,problem,notes,assignee,due_at,source,source_key,terms_text,terms_accepted_at,created_by,created,updated) VALUES(?,?,?,'received',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING",
      [
        id,
        ctx.profile,
        counter!.last,
        c?.id || null,
        contact?.id || null,
        name,
        phone,
        item,
        problem,
        notes,
        owner,
        due,
        input.source,
        input.sourceKey,
        input.terms || null,
        input.terms ? at : null,
        input.actor,
        at,
        at,
      ],
    ],
    [
      "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'opened',NULL,'received',?,?,? WHERE changes()=1",
      [uid(), ctx.profile, id, input.actor, "", at],
    ],
  ]);
  if (!inserted.meta.changes)
    return {
      order: await one(
        ctx.env,
        "SELECT * FROM os_orders WHERE source_key=?",
        input.sourceKey,
      ),
      created: false,
    };
  const order = await loadOrder(ctx, id);
  await ctx.publish(
    "os.opened",
    id,
    {
      order_id: id,
      number: order.number,
      source: order.source,
      conversation_id: order.conversation_id,
      contact_id: order.contact_id,
      phone: order.phone,
      item: order.item,
      actor: input.actor,
    },
    { key: `opened:${id}` },
  );
  if (input.notify !== false)
    await notify(ctx, order, "opened", `opened:${id}`);
  return { order, created: true };
}

/** PATCH service-orders/:id: dados da ordem (encerrada: só observações). */
export async function updateOrder(
  ctx: ModuleContext,
  order: any,
  data: any,
  actor: string,
) {
  const closed = CLOSED.includes(order.status);
  const sets: Record<string, any> = {};
  const has = (key: string) => Object.hasOwn(data, key);
  if (has("notes"))
    sets.notes = text(data.notes, 4000, "as observações internas");
  for (const key of [
    "item",
    "problem",
    "customer_name",
    "phone",
    "assignee",
    "due_at",
  ])
    if (has(key))
      requireValue(
        !closed,
        "Ordem encerrada: só as observações internas podem mudar.",
      );
  if (has("item"))
    sets.item = text(data.item, 200, "o item ou equipamento", true);
  if (has("problem"))
    sets.problem = text(data.problem, 2000, "o relato do problema", true);
  if (has("customer_name"))
    sets.customer_name = text(data.customer_name, 120, "o nome do cliente");
  if (has("phone"))
    sets.phone = phoneDigits(text(data.phone, 40, "o telefone"));
  if (has("assignee")) sets.assignee = await assignee(ctx, data.assignee);
  if (has("due_at")) sets.due_at = optionalTime(data.due_at, "Prazo previsto");
  const changed = Object.keys(sets).filter((key) => sets[key] !== order[key]);
  if (!changed.length) return order;
  const at = now();
  await batch(ctx.env, [
    [
      `UPDATE os_orders SET ${changed.map((k) => k + "=?").join(",")},updated=?,stale_notified_at=NULL WHERE id=? AND profile_id=?`,
      [...changed.map((k) => sets[k]), at, order.id, ctx.profile],
    ],
    [
      "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) VALUES(?,?,?,'edit',?,?,?,?,?)",
      [
        uid(),
        ctx.profile,
        order.id,
        order.status,
        order.status,
        actor,
        "Alterado: " + changed.join(", "),
        at,
      ],
    ],
  ]);
  return loadOrder(ctx, order.id);
}

// ---------------------------------------------------------------------------
// Estados

/**
 * Muda o estado com o UPDATE condicionado ao estado lido (outra mudança no
 * meio dá 409) e grava o histórico na mesma transação. Publica
 * os.status_changed (e os.delivered) e avisa o cliente com o texto do estado.
 */
export async function moveOrder(
  ctx: ModuleContext,
  order: any,
  to: OsStatus,
  actor: string,
  note = "",
  extra: Record<string, any> = {},
  kind: "status" | "quote" = "status",
) {
  const at = now();
  const cfg = osSettings(await ctx.settings());
  const sets: Record<string, any> = {
    status: to,
    updated: at,
    stale_notified_at: null,
    pickup_reminded_at: null,
    ...extra,
  };
  if (to === "ready") sets.ready_at = at;
  if (to === "delivered") {
    sets.delivered_at = at;
    sets.warranty_until = cfg.warranty_days
      ? endOfDayAfter(at, cfg.warranty_days)
      : null;
  }
  const keys = Object.keys(sets);
  const historyId = uid();
  const [update] = await batch(ctx.env, [
    [
      `UPDATE os_orders SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND profile_id=? AND status=? AND quote_version=?`,
      [
        ...keys.map((k) => sets[k]),
        order.id,
        ctx.profile,
        order.status,
        order.quote_version,
      ],
    ],
    [
      "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
      [
        historyId,
        ctx.profile,
        order.id,
        kind,
        order.status,
        to,
        actor,
        note,
        at,
      ],
    ],
  ]);
  if (!update.meta.changes)
    throw new ApiError(
      409,
      "os_conflict",
      "A ordem de serviço mudou enquanto isso. Atualize e tente de novo.",
    );
  const next = await loadOrder(ctx, order.id);
  if (order.status !== to)
    await ctx.publish("os.status_changed", order.id, {
      order_id: order.id,
      number: next.number,
      from: order.status,
      to,
      actor,
      note,
      conversation_id: next.conversation_id,
    });
  if (to === "delivered")
    await ctx.publish("os.delivered", order.id, {
      order_id: order.id,
      number: next.number,
      delivered_at: next.delivered_at,
      warranty_until: next.warranty_until,
      actor,
    });
  if (order.status !== to && (TEXT_KEYS as readonly string[]).includes(to))
    await notify(ctx, next, to as TextKey, `status:${order.id}:${historyId}`);
  return next;
}

/** POST service-orders/:id/status: transições da equipe (MANUAL_TRANSITIONS). */
export async function changeStatus(
  ctx: ModuleContext,
  order: any,
  to: unknown,
  actor: string,
  note: unknown,
) {
  requireValue(isStatus(to), "Estado desconhecido.");
  const memo = text(note, 500, "a nota");
  if (to === "quoted")
    throw new ApiError(
      409,
      "invalid_transition",
      "Para enviar o orçamento use POST /service-orders/{id}/quote/send.",
    );
  if (to === "approved" || to === "declined")
    throw new ApiError(
      409,
      "invalid_transition",
      "Aprovação e recusa são respostas ao orçamento: use POST /service-orders/{id}/decision.",
    );
  if (!MANUAL_TRANSITIONS[order.status as OsStatus]?.includes(to))
    throw new ApiError(
      409,
      "invalid_transition",
      `Não é possível passar de "${STATUS_LABELS[order.status as OsStatus]}" para "${STATUS_LABELS[to]}".`,
    );
  return moveOrder(ctx, order, to, actor, memo);
}

// ---------------------------------------------------------------------------
// Orçamento

/** PUT service-orders/:id/quote: salva itens, validade e observação. */
export async function saveQuote(
  ctx: ModuleContext,
  order: any,
  data: any,
  actor: string,
) {
  if (!QUOTABLE.includes(order.status))
    throw new ApiError(
      409,
      "invalid_transition",
      `O orçamento não pode mudar com a ordem "${STATUS_LABELS[order.status as OsStatus]}".`,
    );
  const items = validateQuoteItems(data.items);
  const validDays =
    data.valid_days === undefined || data.valid_days === null
      ? null
      : data.valid_days;
  if (validDays !== null)
    requireValue(
      Number.isInteger(validDays) && validDays >= 1 && validDays <= 90,
      "Validade do orçamento de 1 a 90 dias.",
    );
  const note = text(data.note, 600, "a observação do orçamento");
  const total = quoteTotal(items);
  const sets = {
    quote_items: JSON.stringify(items),
    quote_total_cents: total,
    quote_valid_days: validDays,
    quote_note: note,
  };
  const memo = `Orçamento salvo: ${money(total)}`;
  // Orçamento já enviado e alterado: volta para análise até o novo envio,
  // para o cliente nunca aprovar um valor que não viu.
  if (order.status === "quoted")
    return moveOrder(
      ctx,
      order,
      "analyzing",
      actor,
      memo + " (alterado depois do envio: envie de novo)",
      sets,
      "quote",
    );
  const at = now();
  const keys = Object.keys(sets) as (keyof typeof sets)[];
  const [update] = await batch(ctx.env, [
    [
      `UPDATE os_orders SET ${keys.map((k) => k + "=?").join(",")},updated=? WHERE id=? AND profile_id=? AND status=?`,
      [...keys.map((k) => sets[k]), at, order.id, ctx.profile, order.status],
    ],
    [
      "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'quote',?,?,?,?,? WHERE changes()=1",
      [
        uid(),
        ctx.profile,
        order.id,
        order.status,
        order.status,
        actor,
        memo,
        at,
      ],
    ],
  ]);
  if (!update.meta.changes)
    throw new ApiError(
      409,
      "os_conflict",
      "A ordem de serviço mudou enquanto isso. Atualize e tente de novo.",
    );
  return loadOrder(ctx, order.id);
}

/** Linhas do orçamento, sem a instrução de resposta. */
export function quoteSummary(order: any) {
  const items: QuoteItem[] = json(order.quote_items, []);
  const lines = items.map((item) =>
    item.quantity > 1
      ? `• ${item.quantity} x ${item.description}: ${money(item.quantity * item.unit_cents)} (${money(item.unit_cents)} cada)`
      : `• ${item.description}: ${money(item.unit_cents)}`,
  );
  return [
    `Item: ${order.item}`,
    "",
    ...lines,
    `Total: ${money(order.quote_total_cents)}`,
    `Válido até ${day(order.quote_valid_until)}.`,
    ...(order.quote_note ? ["", order.quote_note] : []),
  ].join("\n");
}

export const replyId = (order: any, decision: "approve" | "decline") =>
  `os:${order.id}:${order.quote_version}:${decision}`;

/**
 * Orçamento como lista interativa (ctx.sendInteractive): Aprovar e Recusar na
 * linha oficial; no QR, o texto numerado "1. Aprovar / 2. Recusar"; fora da
 * janela de 24 horas, o mesmo texto pelo modelo de notificação. A resposta
 * volta por onConversationTurn (handleQuoteReply).
 */
export function quoteSpec(order: any): InteractiveSpec {
  return {
    type: "list",
    body: Array.from(
      `Orçamento da ordem de serviço nº ${order.number}\n${quoteSummary(order)}`,
    )
      .slice(0, 4000)
      .join(""),
    button: "Responder",
    sections: [
      {
        rows: [
          { id: replyId(order, "approve"), title: "Aprovar" },
          { id: replyId(order, "decline"), title: "Recusar" },
        ],
      },
    ],
  };
}
/**
 * POST service-orders/:id/quote/send: fixa a validade, sobe a versão (botões
 * antigos deixam de valer), muda para "Orçamento enviado" e envia ao cliente.
 * Com notify=false só registra (orçamento passado por telefone ou balcão).
 */
export async function sendQuote(
  ctx: ModuleContext,
  order: any,
  actor: string,
  options: { notify?: boolean } = {},
) {
  if (!QUOTABLE.includes(order.status))
    throw new ApiError(
      409,
      "invalid_transition",
      `O orçamento não pode ser enviado com a ordem "${STATUS_LABELS[order.status as OsStatus]}".`,
    );
  requireValue(order.quote_items, "Salve o orçamento antes de enviar.");
  const send = options.notify !== false;
  const c = send ? await conversationOf(ctx, order) : null;
  if (send && !c)
    throw new ApiError(
      409,
      "no_conversation",
      "Esta ordem não está ligada a uma conversa do WhatsApp. Registre o orçamento sem envio (notify: false) e a resposta do cliente pela equipe.",
    );
  const cfg = osSettings(await ctx.settings());
  const at = now();
  const days = order.quote_valid_days || cfg.quote_valid_days;
  const next = await moveOrder(
    ctx,
    order,
    "quoted",
    actor,
    `Orçamento enviado: ${money(order.quote_total_cents)}, válido por ${days} ${days === 1 ? "dia" : "dias"}${send ? "" : " (sem envio pelo WhatsApp)"}`,
    {
      quote_sent_at: at,
      quote_valid_until: endOfDayAfter(at, days),
      quote_version: order.quote_version + 1,
      decision: null,
      decided_at: null,
      decided_by: null,
      decided_via: null,
    },
    "quote",
  );
  await ctx.publish("os.quoted", order.id, {
    order_id: order.id,
    number: next.number,
    total_cents: next.quote_total_cents,
    valid_until: next.quote_valid_until,
    version: next.quote_version,
    sent: send,
    actor,
  });
  if (c)
    await ctx.sendInteractive(c, quoteSpec(next), {
      key: `quote:${order.id}:${next.quote_version}`,
      notification: true,
    });
  return next;
}

/**
 * Resposta ao orçamento (cliente pelo WhatsApp ou equipe em nome dele). Só
 * vale com a ordem em "Orçamento enviado" e o orçamento dentro da validade.
 */
export async function decide(
  ctx: ModuleContext,
  order: any,
  decision: unknown,
  by: string,
  via: "whatsapp" | "panel" | "api",
  note: unknown = "",
) {
  requireValue(
    decision === "approve" || decision === "decline",
    "Informe decision como approve ou decline.",
  );
  const memo = text(note, 500, "a nota");
  if (order.status !== "quoted")
    throw new ApiError(
      409,
      "quote_not_pending",
      `A ordem nº ${order.number} não tem orçamento aguardando resposta.`,
    );
  if (!order.quote_valid_until || order.quote_valid_until <= now())
    throw new ApiError(
      409,
      "quote_expired",
      `O orçamento da ordem nº ${order.number} venceu em ${order.quote_valid_until ? day(order.quote_valid_until) : "—"}. Envie um novo orçamento.`,
    );
  const to: OsStatus = decision === "approve" ? "approved" : "declined";
  const at = now();
  const next = await moveOrder(
    ctx,
    order,
    to,
    by,
    memo || (via === "whatsapp" ? "Resposta do cliente pelo WhatsApp" : ""),
    { decision: to, decided_at: at, decided_by: by, decided_via: via },
  );
  await ctx.publish(
    to === "approved" ? "os.approved" : "os.declined",
    order.id,
    {
      order_id: order.id,
      number: next.number,
      total_cents: next.quote_total_cents,
      version: next.quote_version,
      by,
      via,
      at,
    },
  );
  return next;
}

// ---------------------------------------------------------------------------
// Cliente no WhatsApp

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();

const menuOpenSince = (c: Conversation) =>
  c.menu_active &&
  c.menu_token?.startsWith(c.session + ".") &&
  (c.menu_expires_at || 0) > now()
    ? (c.menu_expires_at || 0) - 86_400_000
    : null;

/**
 * Resposta do cliente ao orçamento: botão Aprovar/Recusar (linha oficial),
 * "1"/"2" logo depois do orçamento (QR) ou "APROVAR 12"/"RECUSAR 12".
 * Devolve true quando a mensagem era para a Ordem de Serviço.
 */
export async function handleQuoteReply(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId?: string | null; rowId: string },
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const say = (message: string) =>
    ctx.sendMessage(c, { text: message }, { key: `reply:${turn.rowId}` });
  let order: any = null,
    decision: "approve" | "decline";
  const button = turn.replyId
    ? /^os:([^:]+):(\d+):(approve|decline)$/.exec(turn.replyId)
    : null;
  if (turn.replyId) {
    if (!turn.replyId.startsWith("os:")) return false;
    if (!button) {
      await say("Esta opção não está mais disponível.");
      return true;
    }
    order = await one(
      ctx.env,
      "SELECT * FROM os_orders WHERE id=? AND profile_id=? AND conversation_id=?",
      button[1],
      ctx.profile,
      c.id,
    );
    if (!order) {
      await say("Não encontramos esta ordem de serviço.");
      return true;
    }
    decision = button[3] as "approve" | "decline";
    if (
      order.status === "quoted" &&
      Number(button[2]) !== order.quote_version
    ) {
      await say(
        `O orçamento da ordem nº ${order.number} foi atualizado. Responda à mensagem mais recente.`,
      );
      return true;
    }
  } else {
    const value = normalize(turn.text || "");
    const digit = /^([12])$/.exec(value);
    const word =
      /^(aprovar|aprovo|aprovado|recusar|recuso|recusado)(?:\s+(?:a\s+)?(?:ordem\s+)?(?:n[o°º]?\s*)?(\d{1,9}))?$/.exec(
        value,
      );
    if (!digit && !word) return false;
    decision = digit
      ? digit[1] === "1"
        ? "approve"
        : "decline"
      : word![1].startsWith("aprov")
        ? "approve"
        : "decline";
    const phone = phoneDigits(c.phone || c.external_id);
    if (word?.[2]) {
      order = await one(
        ctx.env,
        "SELECT * FROM os_orders WHERE profile_id=? AND number=? AND (conversation_id=? OR (phone<>'' AND phone=?))",
        ctx.profile,
        Number(word[2]),
        c.id,
        phone,
      );
      if (!order) {
        await say(
          `Não encontramos a ordem de serviço nº ${word[2]} para este número.`,
        );
        return true;
      }
    } else {
      const pending = await all(
        ctx.env,
        "SELECT * FROM os_orders WHERE profile_id=? AND conversation_id=? AND status='quoted' ORDER BY quote_sent_at DESC",
        ctx.profile,
        c.id,
      );
      if (!pending.length) return false;
      // "1"/"2" só logo depois do orçamento: com um menu aberto depois dele,
      // o número é a opção do menu.
      const menuSince = menuOpenSince(c);
      if (digit && menuSince !== null && menuSince > pending[0].quote_sent_at)
        return false;
      if (pending.length > 1 && !digit) {
        await say(
          "Há mais de um orçamento aguardando resposta. Responda com o número da ordem, por exemplo: " +
            pending
              .map((o) => `APROVAR ${o.number} ou RECUSAR ${o.number}`)
              .join("; ") +
            ".",
        );
        return true;
      }
      order = pending[0];
    }
  }
  try {
    await decide(
      ctx,
      order,
      decision,
      `customer:${phoneDigits(c.phone || c.external_id)}`,
      "whatsapp",
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "quote_expired")
      await say(
        `O orçamento da ordem nº ${order.number} venceu em ${day(order.quote_valid_until)}. Peça um novo orçamento à equipe.`,
      );
    else if (error.code === "quote_not_pending")
      await say(
        `A ordem nº ${order.number} não tem orçamento aguardando resposta. Estado atual: ${STATUS_LABELS[order.status as OsStatus]}.`,
      );
    else throw error;
  }
  return true;
}

/** Item de menu "Acompanhar ordem de serviço". */
/**
 * Ordens do cliente da conversa (desta conversa ou do mesmo telefone), como
 * o "Acompanhar" do cliente: para o bot (os_situacao), sem busca por outro
 * telefone ou número. `open` deixa de fora entregues e canceladas.
 */
export async function ordersOfCustomer(
  ctx: ModuleContext,
  c: Conversation,
  open = false,
) {
  const phone = phoneDigits(c.phone || c.external_id);
  const rows = await all(
    ctx.env,
    `SELECT * FROM os_orders WHERE profile_id=? AND (conversation_id=? OR (phone<>'' AND phone=?))${open ? " AND status NOT IN ('delivered','cancelled')" : ""} ORDER BY number DESC LIMIT 20`,
    ctx.profile,
    c.id,
    phone,
  );
  return rows.map((row) => orderView(row));
}

export async function trackText(ctx: ModuleContext, c: Conversation) {
  const phone = phoneDigits(c.phone || c.external_id);
  // Ordens abertas no balcão só com o telefone passam a ser desta conversa.
  if (phone.length >= 8)
    await exec(
      ctx.env,
      "UPDATE os_orders SET conversation_id=? WHERE profile_id=? AND phone=? AND conversation_id IS NULL",
      c.id,
      ctx.profile,
      phone,
    );
  const rows = await all(
    ctx.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND (conversation_id=? OR (phone<>'' AND phone=?)) AND status NOT IN ('delivered','cancelled') ORDER BY number LIMIT 20",
    ctx.profile,
    c.id,
    phone,
  );
  if (!rows.length)
    return "Não encontramos ordens de serviço abertas para este número.";
  const blocks = rows.map((order) => {
    const lines = [
      `Nº ${order.number} — ${order.item}`,
      `Estado: ${STATUS_LABELS[order.status as OsStatus]}`,
    ];
    if (order.status === "quoted") {
      lines.push(
        order.quote_valid_until > now()
          ? `Orçamento: ${money(order.quote_total_cents)}, válido até ${day(order.quote_valid_until)}. Responda APROVAR ${order.number} ou RECUSAR ${order.number}.`
          : `Orçamento vencido em ${day(order.quote_valid_until)}. Peça um novo à equipe.`,
      );
    }
    if (order.status === "ready")
      lines.push(`Pronta para retirada desde ${day(order.ready_at)}.`);
    else if (order.due_at) lines.push(`Previsão: ${day(order.due_at)}.`);
    return lines.join("\n");
  });
  return [
    rows.length === 1
      ? "Sua ordem de serviço:"
      : `Suas ${rows.length} ordens de serviço abertas:`,
    ...blocks,
  ].join("\n\n");
}
