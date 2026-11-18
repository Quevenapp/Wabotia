// Ordem de Serviço: banco e regras com efeito (abrir, mudar estado, orçamento,
// resposta do cliente, acompanhamento). Fala com o núcleo pela interface de
// src/modules/api.ts; só lê tabelas do núcleo (usuários, linha da conversa).
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

import type { ExtraValues, WorkTypeSnapshot } from "./contracts";
import { effectiveStage, legacyCustomStatuses, makeSnapshot, snapshotType, workOrderAdditions } from "./work-types";
import { resolveWorkType } from "./public";
import { validateExtra } from "./validation";
import { resumeOrderEffects } from "./motor-routes";
import { atomic, casGuard, checkVersion, commitOrderMutation, mutationHistory } from "./mutations";
import { customerProjection } from "./privacy";
import { customStatus, customMove, customQuotePolicy, cancelApproval } from "./stages";

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
    ...workOrderAdditions(row),
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
    next_statuses: snapshotType(row) ? legacyCustomStatuses(row, snapshotType(row)!) : nextStatuses(status, !!items),
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

type OrderView = ReturnType<typeof orderView>;
/**
 * Visão para o ator (revisão M6): aplicação sem contacts:read não vê o
 * telefone do cliente; sem notes:read, não vê as observações internas nem as
 * notas do histórico. Pessoas da equipe veem tudo.
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
    // Registros antigos guardavam "customer:<telefone>" (conferência N-9).
    const hide = (who: string | null) =>
      who && /^customer:\d+$/.test(who) ? "customer" : who;
    if (out.decision)
      out.decision = { ...out.decision, by: hide(out.decision.by) };
    if (out.history)
      out.history = out.history.map((h: any) => ({
        ...h,
        actor: hide(h.actor),
      }));
  }
  if (!ctx.mayRead(actor, "notes")) {
    delete out.notes;
    if (out.history)
      out.history = out.history.map(({ note: _note, ...h }: any) => h);
  }
  return view.type_id !== "service_order" && (actor.via || actor.id.startsWith("bot:") || actor.module) ? customerProjection(out) : out;
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
  if (query.stage && !query.type_id) throw new ApiError(400, "invalid_filter", "Etapa exige type_id.");
  if (query.type_id) { where.push("type_id=?"); args.push(query.type_id); }
  if (query.stage) { where.push("COALESCE(stage,status)=?"); args.push(query.stage); }
  // Sem repetição: a lista IN fica dentro do limite do D1 (conferência B10).
  const statuses = [
    ...new Set((query.status || "").split(",").filter(Boolean)),
  ];
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
  // Inteiro (revisão B10: LIMIT não inteiro dava erro interno).
  const limit = Math.min(
    Math.max(Math.trunc(Number(query.limit)) || 50, 1),
    200,
  );
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
    ...(query.facets === "1" ? { facets: await orderFacets(ctx, query.type_id) } : {}),
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

/** Uma única mensagem, dentro do teto UTF-16 do transporte, mesmo após expandir campos. */
export function customMessage(template: string, order: any, max = 3800) {
  const expanded = fill(template, publicOrderValues(order));
  if (expanded.length <= max) return expanded;
  const prefix = expanded.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  return prefix + "…";
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
  const type = snapshotType(order);
  const template = type ? textKey === "pickup_reminder" ? type.pickup_reminder_text : type.stages.find(s => s.id === effectiveStage(order))?.message : osSettings(await ctx.settings()).texts[textKey];
  if (!template) return null;
  const c = await conversationOf(ctx, order);
  if (!c || c.chat_type === "group") return null;
  return ctx.sendMessage(
    c,
    { text: type ? customMessage(template, order) : fill(template, publicOrderValues(order)) },
    { key, notification: true },
  );
}

// ---------------------------------------------------------------------------
// Abrir

export interface CreateInput {
  conversation?: Conversation | null;
  type_id?: string;
  extra?: unknown;
  /** Somente o passo web autenticado fornece a definição fixada. */
  snapshot?: WorkTypeSnapshot;
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
  const sourceKey = `motor:${ctx.profile}:${input.sourceKey}`;
  const existing = await one(
    ctx.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND source_key IN (?,?)",
    ctx.profile, sourceKey, input.sourceKey,
  );
  if (existing) {
    await publishOpened(ctx, existing, input);
    return { order: existing, created: false };
  }
  const current = await resolveWorkType(ctx, input.type_id);
  if (current.archived) throw new ApiError(409, "type_archived", "Tipo arquivado para novas aberturas.");
  const type = input.snapshot ? await resolveWorkType(ctx, current.id, input.snapshot) : current;
  if (input.source === "customer" && !type.features.customer_open) throw new ApiError(409, "feature_disabled", "Abertura pelo cliente desativada.");
  const extra = validateExtra(type.fields, input.extra ?? {}, { mode: input.source === "customer" ? "customer" : "staff" });
  const snapshot = type.kind === "custom" ? JSON.stringify(makeSnapshot(type)) : null;
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
  const id = uid(), at = now();
  // Inicializa o embutido antes de qualquer incremento, inclusive se o
  // primeiro trabalho novo for personalizado. Todos os efeitos são atômicos.
  let inserted: D1Result;
  try {
    const results = await batch(ctx.env, [
      ["INSERT INTO os_type_counters(profile_id,type_id,last) SELECT ?,'service_order',COALESCE((SELECT last FROM os_counters WHERE profile_id=?),0) WHERE true ON CONFLICT(profile_id,type_id) DO NOTHING", [ctx.profile, ctx.profile]],
      ["INSERT INTO os_counters(profile_id,last) SELECT ?,1 WHERE NOT EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND source_key=?) ON CONFLICT(profile_id) DO UPDATE SET last=last+1", [ctx.profile, ctx.profile, sourceKey]],
      ["INSERT INTO os_type_counters(profile_id,type_id,last) SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND source_key=?) ON CONFLICT(profile_id,type_id) DO UPDATE SET last=last+1", [ctx.profile, type.id, ctx.profile, sourceKey]],
      ["SELECT CASE WHEN (SELECT last FROM os_counters WHERE profile_id=?)<=2147483647 THEN 1 ELSE json('sequence_exhausted') END", [ctx.profile]],
      ["INSERT INTO os_orders(id,profile_id,number,status,conversation_id,contact_id,customer_name,phone,item,problem,notes,assignee,due_at,source,source_key,terms_text,terms_accepted_at,created_by,created,updated,type_id,stage,type_number,extra_json,type_snapshot_json) SELECT ?,?,(SELECT last FROM os_counters WHERE profile_id=?),'received',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT last FROM os_type_counters WHERE profile_id=? AND type_id=?),?,? WHERE NOT EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND source_key=?)",
        [id, ctx.profile, ctx.profile, c?.id || null, contact?.id || null, name, phone, item, problem, notes, owner, due, input.source, sourceKey, input.terms || null, input.terms ? at : null, input.actor, at, at, type.id, type.initial_stage, ctx.profile, type.id, JSON.stringify(extra), snapshot, ctx.profile, sourceKey]],
      ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created,from_stage,to_stage,entity_version,mutation_key) SELECT ?,?,?,'opened',NULL,'received',?,?,?,NULL,?,1,? WHERE changes()=1", [uid(), ctx.profile, id, input.actor, "", at, type.kind === "custom" ? type.initial_stage : null, `open:${sourceKey}`]],
    ]);
    inserted = results[4];
  } catch (error) {
    if (/sequence_exhausted|malformed JSON|last BETWEEN 0 AND 2147483647/i.test(String(error))) throw new ApiError(409, "sequence_exhausted", "Sequência de trabalhos esgotada.");
    throw error;
  }
  if (!inserted.meta.changes) {
    const order = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND source_key=?", ctx.profile, sourceKey);
    if (!order) throw new ApiError(409, "os_conflict", "Chave de abertura indisponível.");
    await publishOpened(ctx, order, input);
    return { order, created: false };
  }
  const order = await loadOrder(ctx, id);
  await publishOpened(ctx, order, input);
  return { order, created: true };
}
async function publishOpened(ctx: ModuleContext, order: any, input: CreateInput) {
  await ctx.publish(
    "os.opened",
    order.id,
    snapshotType(order) ? { order_id: order.id, id: order.id, version: 1, type_id: order.type_id } : {
      order_id: order.id,
      number: order.number,
      source: order.source,
      conversation_id: order.conversation_id,
      contact_id: order.contact_id,
      phone: order.phone,
      item: order.item,
      actor: input.actor,
    },
    { key: `opened:${order.id}` },
  );
  if (input.notify !== false && (!snapshotType(order) || order.row_version === 1))
    await notify(ctx, order, "opened", snapshotType(order) ? `stage:${order.id}:1:opened` : `opened:${order.id}`);
}

/** PATCH service-orders/:id: dados da ordem (encerrada: só observações). */
export async function updateOrder(
  ctx: ModuleContext,
  order: any,
  data: any,
  actor: string,
  mutationKey?: string,
) {
  checkVersion(order, data.version, false);
  for (const key of ["type_id", "stage", "status", "type_snapshot_json", "type_number"]) if (Object.hasOwn(data, key)) throw new ApiError(400, "immutable_field", "Campo imutável: " + key);
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
    "extra",
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
  if (has("extra")) sets.extra_json = JSON.stringify(validateExtra((snapshotType(order)?.fields ?? []), data.extra, { previous: json(order.extra_json, {}) }));
  const changed = Object.keys(sets).filter((key) => sets[key] !== order[key]);
  if (!changed.length) return order;
  if (snapshotType(order)) return commitOrderMutation(ctx, order, { ...sets, stage_approval_json: cancelApproval(order) }, actor, "os.updated", changed.flatMap(k => k === "extra_json" ? Object.keys(data.extra) : [k]), mutationKey);
  const at = now();
  await atomic(ctx, [
    [
      `UPDATE os_orders SET ${changed.map((k) => k + "=?").join(",")},updated=?,stale_notified_at=NULL,row_version=row_version+1 WHERE id=? AND profile_id=? AND row_version=?`,
      [...changed.map((k) => sets[k]), at, order.id, ctx.profile, order.row_version ?? 1],
    ], casGuard,
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
  options: { notify?: boolean; mutationKey?: string; stage?: string } = {},
) {
  if (snapshotType(order)) return customMove(ctx, order, to, actor, extra, kind, { ...options, note });
  const at = now();
  const cfg = osSettings(await ctx.settings());
  const sets: Record<string, any> = {
    status: to,
    stage: to,
    row_version: (order.row_version ?? 1) + 1,
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
  // Apenas /stage acrescenta a marca recuperável; os comandos legados
  // conservam o histórico e os efeitos anteriores.
  const mutationKey = options.stage ? options.mutationKey : undefined;
  const [update] = await batch(ctx.env, [
    [
      `UPDATE os_orders SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND profile_id=? AND status=? AND quote_version=? AND row_version=?`,
      [
        ...keys.map((k) => sets[k]),
        order.id,
        ctx.profile,
        order.status,
        order.quote_version,
        order.row_version ?? 1,
      ],
    ],
    [
      mutationKey
        ? "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created,from_stage,to_stage,entity_version,mutation_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1"
        : "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
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
        ...(mutationKey ? [effectiveStage(order), to, sets.row_version, mutationKey] : []),
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
  await resumeBuiltinStatus(ctx, { id: historyId, from_status: order.status, to_status: to, actor, note, mutation_key: mutationKey, entity_version: sets.row_version }, next, options.notify !== false);
  return next;
}

/** Efeitos legados também usados pela retomada da rota de etapa virtual. */
export async function resumeBuiltinStatus(ctx: ModuleContext, history: any, row: any, notifyCustomer = true) {
  const to = history.to_status, actor = history.actor, note = history.note;
  if (history.from_status !== to)
    await ctx.publish("os.status_changed", row.id, {
      order_id: row.id,
      number: row.number,
      from: history.from_status,
      to,
      actor,
      note,
      conversation_id: row.conversation_id,
    }, history.mutation_key ? { key: `status:${row.id}:${history.entity_version}` } : undefined);
  if (to === "delivered")
    await ctx.publish("os.delivered", row.id, {
      order_id: row.id,
      number: row.number,
      delivered_at: row.delivered_at,
      warranty_until: row.warranty_until,
      actor,
    }, history.mutation_key ? { key: `delivered:${row.id}:${history.entity_version}` } : undefined);
  if (
    notifyCustomer &&
    (!history.mutation_key || row.row_version === history.entity_version) &&
    history.from_status !== to &&
    (TEXT_KEYS as readonly string[]).includes(to)
  )
    await notify(ctx, row, to as TextKey, `status:${row.id}:${history.id}`);
}

/** POST service-orders/:id/status: transições da equipe (MANUAL_TRANSITIONS). */
export async function changeStatus(
  ctx: ModuleContext,
  order: any,
  to: unknown,
  actor: string,
  note: unknown,
  options: { notify?: boolean; mutationKey?: string; stage?: string } = {},
) {
  requireValue(isStatus(to), "Estado desconhecido.");
  const memo = text(note, 500, "a nota");
  if (snapshotType(order)) return customStatus(ctx, order, to, actor, { ...options, note: memo });
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
  return moveOrder(ctx, order, to, actor, memo, {}, "status", options);
}

// ---------------------------------------------------------------------------
// Orçamento

/** PUT service-orders/:id/quote: salva itens, validade e observação. */
export async function saveQuote(
  ctx: ModuleContext,
  order: any,
  data: any,
  actor: string,
  mutationKey?: string,
  options: { notify?: boolean } = {},
) {
  const policy = customQuotePolicy(order);
  if (policy && effectiveStage(order) !== policy.sent_stage && !policy.source_stages.includes(effectiveStage(order))) throw new ApiError(409, "invalid_transition", "Etapa não permite orçamento.");
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
      { ...options, mutationKey },
    );
  if (snapshotType(order)) return commitOrderMutation(ctx, order, { ...sets, stage_approval_json: cancelApproval(order) }, actor, "os.quote_saved", ["quote"], mutationKey);
  const at = now();
  const keys = Object.keys(sets) as (keyof typeof sets)[];
  const [update] = await batch(ctx.env, [
    [
      `UPDATE os_orders SET ${keys.map((k) => k + "=?").join(",")},updated=?,row_version=row_version+1 WHERE id=? AND profile_id=? AND status=? AND row_version=?`,
      [...keys.map((k) => sets[k]), at, order.id, ctx.profile, order.status, order.row_version ?? 1],
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
    `${snapshotType(order)?.labels.item ?? "Item"}: ${order.item}`,
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
      `${snapshotType(order) ? `Orçamento de ${snapshotType(order)!.labels.singular} ${workOrderAdditions(order).display_number}` : `Orçamento da ordem de serviço nº ${order.number}`}\n${quoteSummary(order)}`,
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
  options: { notify?: boolean; mutationKey?: string; stage?: string } = {},
) {
  const policy = customQuotePolicy(order);
  if (policy && !policy.source_stages.includes(effectiveStage(order))) throw new ApiError(409, "invalid_transition", "Etapa não permite orçamento.");
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
  const days = order.quote_valid_days || policy?.default_valid_days || cfg.quote_valid_days;
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
    { ...options, notify: false },
  );
  await ctx.publish("os.quoted", order.id, snapshotType(order) ? { order_id: order.id, version: next.row_version } : {
    order_id: order.id,
    number: next.number,
    total_cents: next.quote_total_cents,
    valid_until: next.quote_valid_until,
    version: next.quote_version,
    sent: send,
    actor,
  }, snapshotType(order) ? { key: `quoted:${order.id}:${next.row_version}` } : undefined);
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
  options: { mutationKey?: string; notify?: boolean } = {},
) {
  requireValue(
    decision === "approve" || decision === "decline",
    "Informe decision como approve ou decline.",
  );
  customQuotePolicy(order);
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
    "status",
    snapshotType(order) ? options : {},
  );
  await ctx.publish(
    to === "approved" ? "os.approved" : "os.declined",
    order.id,
    snapshotType(order) ? { order_id: order.id, version: next.row_version } : {
      order_id: order.id,
      number: next.number,
      total_cents: next.quote_total_cents,
      version: next.quote_version,
      by,
      via,
      at,
    },
    snapshotType(order) ? { key: `decision:${order.id}:${next.row_version}` } : undefined,
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

export const menuOpenSince = (c: Conversation) =>
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
    const phone = phoneDigits(ctx.verifiedPhone(c) || "");
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
  const mutationKey = snapshotType(order) ? `quote-reply:${c.id}:${turn.rowId}` : undefined;
  const previous = await mutationHistory(ctx, mutationKey);
  if (previous) { await resumeOrderEffects(ctx, previous, order); return true; }
  try {
    await decide(
      ctx,
      order,
      decision,
      // A conversa, não o telefone (conferência N-9).
      `customer:${c.id}`,
      "whatsapp",
      "",
      { mutationKey },
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
  typeId?: string,
) {
  const phone = phoneDigits(ctx.verifiedPhone(c) || "");
  const rows = await all(
    ctx.env,
    `SELECT * FROM os_orders WHERE profile_id=? AND (conversation_id=? OR (phone<>'' AND phone=?))${open ? " AND status NOT IN ('delivered','cancelled')" : ""}${typeId ? " AND type_id=?" : ""} ORDER BY number DESC LIMIT 20`,
    ctx.profile,
    c.id,
    phone,
    ...(typeId ? [typeId] : []),
  );
  return rows.map((row) => orderView(row));
}

export async function trackText(ctx: ModuleContext, c: Conversation, typeId?: string) {
  const phone = phoneDigits(ctx.verifiedPhone(c) || "");
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
    `SELECT * FROM os_orders WHERE profile_id=? AND (conversation_id=? OR (phone<>'' AND phone=?)) AND status NOT IN ('delivered','cancelled')${typeId ? " AND type_id=?" : ""} ORDER BY number LIMIT 20`,
    ctx.profile,
    c.id,
    phone,
    ...(typeId ? [typeId] : []),
  );
  if (!rows.length) {
    if (typeId && typeId !== "service_order") {
      const type = await resolveWorkType(ctx, typeId);
      return `Não encontramos ${type.labels.plural.toLowerCase()} em aberto para este número.`;
    }
    return "Não encontramos ordens de serviço abertas para este número.";
  }
  const custom = rows.some(row => snapshotType(row));
  const blocks = rows.map((order) => {
    const type = snapshotType(order), view = workOrderAdditions(order);
    const lines = [
      type ? `${view.type_label} ${view.display_number} — ${order.item}` : `Nº ${order.number} — ${order.item}`,
      type ? `Etapa: ${view.stage_label}` : `Estado: ${STATUS_LABELS[order.status as OsStatus]}`,
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
    custom ? "Seus trabalhos em aberto:" : rows.length === 1
      ? "Sua ordem de serviço:"
      : `Suas ${rows.length} ordens de serviço abertas:`,
    ...blocks,
  ].join("\n\n");
}

/** Lista explícita de substituições; extras privados nunca entram no texto. */
export function publicOrderValues(row: any): Record<string, string> {
  const values = orderValues(row);
  const type = snapshotType(row);
  if (!type) return values;
  const view = workOrderAdditions(row, type);
  const extra: ExtraValues = json(row.extra_json, {});
  return { ...values, tipo: type.labels.singular, etapa: view.stage_label,
    numero_tipo: String(view.type_number), identificador: view.display_number,
    ...Object.fromEntries(type.fields.filter(f => f.client_visible && !f.sensitive).map(f => {
      const value = extra[f.id];
      return [`campo_${f.id}`, value == null ? "" : f.kind === "boolean" ? value ? "Sim" : "Não" : f.kind === "choice" ? f.options.find(o => o.id === value)?.label ?? "" : String(value)];
    })),
  };
}
async function orderFacets(ctx: ModuleContext, typeId?: string) {
  const rows = await all(ctx.env, "SELECT type_id,COALESCE(stage,status) AS stage,count(*) AS n FROM os_orders WHERE profile_id=? GROUP BY type_id,COALESCE(stage,status)", ctx.profile);
  const types: Record<string, number> = Object.create(null), stages: Record<string, number> = Object.create(null);
  for (const r of rows) { types[r.type_id] = (types[r.type_id] ?? 0) + r.n; if (r.type_id === typeId) stages[r.stage] = r.n; }
  return { types, ...(typeId ? { stages } : {}) };
}
