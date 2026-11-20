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
import { resolveWorkType, workCustomerScope, workCustomerAllows } from "./public";
import { resolveCustomer } from "../../customer/ports";
import { normalizeCustomerPhone } from "../../customer/phone";
import { validateExtra } from "./validation";
import { resumeOrderEffects } from "./motor-routes";
import { atomic, casGuard, checkVersion, commitOrderMutation, mutationHistory, versionConflict } from "./mutations";
import { customerProjection, mayReadSensitive } from "./privacy";
import { customStatus, customMove, customQuotePolicy, cancelApproval } from "./stages";
import { prepareWorkMutation, replayWorkWrite, workWriteReceipt } from "./commercial/mutations";
import { commercialOf, readWorkIntegration, stableQuoteItems } from "./commercial/projection";
import { hash as commercialHash } from "../../integrations/keys";

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
    ? stableQuoteItems(row)
    : null;
  return {
    ...workOrderAdditions(row),
    id: row.id,
    number: row.number,
    status,
    status_label: STATUS_LABELS[status] || status,
    ...(row.notification ? { notification: row.notification } : {}),
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
    `SELECT o.*,(SELECT cursor_json FROM customer_progress p WHERE p.profile_id=o.profile_id
      AND p.namespace='team' AND p.task LIKE 'os:notice:%' AND p.complete=0
      AND json_extract(p.cursor_json,'$.orderId')=o.id AND json_extract(p.cursor_json,'$.version')=o.row_version
      ORDER BY p.updated DESC LIMIT 1) notice_pending FROM os_orders o WHERE o.id=? AND o.profile_id=?`,
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  if (row.notice_pending) row.notification = { state: json(row.notice_pending, {}).state || "pending", reason: "Aviso pendente de entrega." };
  delete row.notice_pending;
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
  actor?: Actor,
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  if (query.stage && !query.type_id) throw new ApiError(400, "invalid_filter", "Etapa exige type_id.");
  if (query.type_id) { where.push("type_id=?"); args.push(query.type_id); }
  if (query.type_ids) {
    const ids = [...new Set(query.type_ids.split(","))];
    requireValue(ids.length <= 21 && ids.every(id => /^[a-z][a-z0-9_]{0,63}$/.test(id)), "Modelos inválidos.");
    where.push(`type_id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  if (query.stage) { where.push("COALESCE(stage,status)=?"); args.push(query.stage); }
  if (query.assignee) {
    where.push(query.assignee === "unassigned" ? "assignee IS NULL" : "assignee=?");
    if (query.assignee !== "unassigned") args.push(query.assignee === "me" && actor ? actor.id : query.assignee);
  }
  for (const [key, comparison] of [["due_from", ">="], ["due_to", "<="]] as const) {
    if (!query[key]) continue;
    const at = Number(query[key]);
    if (!Number.isSafeInteger(at) || at < 0) throw new ApiError(400, "invalid_filter", "Prazo inválido; use milissegundos Unix.");
    where.push(`due_at${comparison}?`); args.push(at);
  }
  if (query.due_from && query.due_to && Number(query.due_from) > Number(query.due_to)) throw new ApiError(400, "invalid_filter", "Intervalo de prazo inválido.");
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
  // Uma consulta para a página inteira, filtrando antes de eleger o próximo filho.
  // A projeção nunca revela a existência de uma tarefa não autorizada.
  const custom = page.filter(row => row.type_id !== "service_order" && snapshotType(row)?.features.tasks);
  const human = actor?.kind === "user" && !actor.via && !actor.module && !actor.credential && !actor.id.startsWith("bot:");
  const sensitive = actor && await mayReadSensitive(ctx, actor);
  const tasks = custom.length ? await all(ctx.env, `SELECT order_id,id,title,due_at FROM (
    SELECT order_id,id,title,due_at,row_number() OVER (PARTITION BY order_id ORDER BY due_at IS NULL,due_at,id) AS position
    FROM os_tasks WHERE profile_id=? AND order_id IN (SELECT value FROM json_each(?)) AND state='open' AND archived_at IS NULL
    ${sensitive ? "" : "AND sensitive=0"} ${human ? "" : "AND client_visible=1"}
  ) WHERE position=1`, ctx.profile, JSON.stringify(custom.map(row => row.id))) : [];
  const nextTasks = new Map(tasks.map(task => [task.order_id, { id: task.id, title: task.title, due_at: task.due_at }]));
  return {
    data: page.map(row => ({
      ...orderView(row),
      ...(row.type_id !== "service_order" ? { next_task: nextTasks.get(row.id) ?? null } : {}),
    })),
    next_cursor: more ? String(page.at(-1)!.number) : null,
    counts,
    ...(query.facets === "1" ? { facets: await orderFacets(ctx, query.type_id) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Avisos ao cliente

export async function conversationOf(ctx: ModuleContext, order: any) {
  if (!order.conversation_id) return null;
  try {
    const c = await ctx.conversation(order.conversation_id);
    // O vínculo histórico e o destinatário atual precisam concordar em cada envio.
    return await workCustomerAllows(ctx, c, order, "notice") ? c : null;
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
  const task = noticeTask(order.id, key);
  await batch(ctx.env, [noticeStatement(ctx.profile, order, textKey, key)]);
  const saved = await one(ctx.env, "SELECT complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?", ctx.profile, task);
  // O marcador da própria OS controla o lembrete periódico. Se foi limpo,
  // revalide e repita a chave idempotente do transporte antes de marcá-lo.
  if (saved?.complete && textKey !== "pickup_reminder") { order.notification = { state: "sent" }; return null; }
  const fresh = await loadOrder(ctx, order.id);
  const c = fresh.row_version === order.row_version ? await conversationOf(ctx, fresh) : null;
  if (!c || c.chat_type === "group") {
    order.notification = { state: "pending", reason: "Destinatário não confirmado." };
    if (textKey === "pickup_reminder") throw new ApiError(409, "contact_conflict", "Destinatário do lembrete não confirmado.");
    return null;
  }
  try {
    const sent = await ctx.sendMessage(c,
      { text: type ? customMessage(template, fresh) : fill(template, publicOrderValues(fresh)) },
      { key, notification: true });
    if (sent === null) { order.notification = { state: "pending" }; return null; }
    await exec(ctx.env, "UPDATE customer_progress SET complete=1,updated=? WHERE profile_id=? AND namespace='team' AND task=?", now(), ctx.profile, task);
    order.notification = { state: "sent" };
    return sent;
  } catch (error) {
    order.notification = { state: "failed", reason: "Aviso pendente de nova tentativa." };
    await exec(ctx.env, "UPDATE customer_progress SET cursor_json=json_set(cursor_json,'$.state','failed'),updated=? WHERE profile_id=? AND namespace='team' AND task=?", now(), ctx.profile, task);
    throw error;
  }
}

const noticeTask = (id: string, key: string) => `os:notice:${JSON.stringify([id, key])}`;
function noticeStatement(profile: string, row: any, textKey: TextKey, key: string, historyId?: string): [string, unknown[]] {
  return [`INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
    SELECT ?,'team',?,?,0,? WHERE EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=? AND row_version=?)
    ${historyId ? "AND EXISTS(SELECT 1 FROM os_history WHERE id=? AND profile_id=? AND order_id=?)" : ""}
    ON CONFLICT(profile_id,namespace,task) DO NOTHING`,
  [profile, noticeTask(row.id, key), JSON.stringify({ orderId: row.id, version: row.row_version, textKey, key }), now(), profile, row.id, row.row_version, ...(historyId ? [historyId, profile, row.id] : [])]];
}

/** Recuperação limitada, com a mesma chave do transporte após resposta perdida. */
export async function resumePendingNotices(ctx: ModuleContext, row: any) {
  const pending = await all(ctx.env, `SELECT task,cursor_json FROM customer_progress
    WHERE profile_id=? AND namespace='team' AND task LIKE 'os:notice:%' AND complete=0
      AND json_extract(cursor_json,'$.orderId')=? AND json_extract(cursor_json,'$.version')=?
    ORDER BY updated,task LIMIT 5`, ctx.profile, row.id, row.row_version);
  for (const item of pending) {
    const notice = JSON.parse(item.cursor_json);
    if (notice.version !== row.row_version) continue;
    await notify(ctx, row, notice.textKey, notice.key);
  }
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
  const openingScope = `os-open:${ctx.profile}`;
  const openingHash = commercialHash({ conversation_id: input.conversation?.id ?? null, type_id: input.type_id ?? "service_order",
    snapshot: input.snapshot ?? null, extra: input.extra ?? null, customer_name: input.customer_name ?? null,
    phone: input.phone ?? null, item: input.item ?? null, problem: input.problem ?? null, notes: input.notes ?? null,
    assignee: input.assignee ?? null, due_at: input.due_at ?? null, source: input.source, actor: input.actor,
    terms: input.terms ?? null, notify: input.notify ?? true });
  const checkOpeningReplay = async () => {
    const receipt = await one(ctx.env, "SELECT fingerprint FROM receipts WHERE scope=? AND key=?", openingScope, sourceKey);
    if (receipt && receipt.fingerprint !== openingHash) throw new ApiError(409, "idempotency_conflict", "Esta chave já identifica outra abertura.");
  };
  const existing = await one(
    ctx.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND source_key IN (?,?)",
    ctx.profile, sourceKey, input.sourceKey,
  );
  if (existing) {
    await checkOpeningReplay();
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
  if (c && c.profile_id !== ctx.profile) throw notFound();
  const ref = c ? await resolveCustomer(ctx.env, c) : null;
  const namespace = c?.external_namespace.startsWith("app:") ? c.external_namespace : "team";
  const contactId = ref?.state === "ready" && ref.profileId === ctx.profile && ref.namespace === namespace
    ? ref.contactId : null;
  const contact = contactId ? await one<{ name: string; phone: string }>(ctx.env,
    "SELECT name,phone FROM contacts WHERE id=? AND profile_id=? AND namespace=? AND identity_state='active'",
    contactId, ctx.profile, namespace) : null;
  const suppliedPhone = text(input.phone, 40, "o telefone");
  const phone = suppliedPhone ? normalizeCustomerPhone(suppliedPhone, "human_br") || ""
    : ref?.verifiedPhone || (namespace.startsWith("app:") ? contact?.phone : null) || (c ? ctx.verifiedPhone(c) : null) || "";
  requireValue(!suppliedPhone || normalizeCustomerPhone(phone, "international"), "Informe um telefone válido com DDD ou com + e o código do país.");
  requireValue(c || phone, "Informe a conversa ou o telefone do cliente.");
  const name = text(input.customer_name, 120, "o nome do cliente") || contact?.name || "";
  const id = uid(), at = now();
  const commercial = await prepareWorkMutation(ctx, { id, profile_id: ctx.profile, number: null, status: "received",
    stage: type.initial_stage, type_id: type.id, type_snapshot_json: snapshot, contact_id: contact ? contactId : null,
    conversation_id: c?.id ?? null, item, created: at, updated: at, quote_items: null, quote_version: 0 }, {}, input.actor, at, "", true);
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
        [id, ctx.profile, ctx.profile, c?.id || null, contact ? contactId : null, name, phone, item, problem, notes, owner, due, input.source, sourceKey, input.terms || null, input.terms ? at : null, input.actor, at, at, type.id, type.initial_stage, ctx.profile, type.id, JSON.stringify(extra), snapshot, ctx.profile, sourceKey]],
      casGuard,
      ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created,from_stage,to_stage,entity_version,mutation_key) SELECT ?,?,?,'opened',NULL,'received',?,?,?,NULL,?,1,? WHERE changes()=1", [uid(), ctx.profile, id, input.actor, "", at, type.kind === "custom" ? type.initial_stage : null, `open:${sourceKey}`]],
      ["UPDATE os_orders SET commercial_json=? WHERE profile_id=? AND id=?", [commercial.sets.commercial_json, ctx.profile, id]], casGuard,
      ...commercial.statements,
      ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [openingScope, sourceKey, openingHash, JSON.stringify({ id, version: 1 }), at]],
    ]);
    inserted = results[4];
  } catch (error) {
    const concurrent = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND source_key=?", ctx.profile, sourceKey);
    if (concurrent) { await checkOpeningReplay(); await publishOpened(ctx, concurrent, input); return { order: concurrent, created: false }; }
    const counter = await one(ctx.env, "SELECT last FROM os_counters WHERE profile_id=?", ctx.profile);
    if (/sequence_exhausted|last BETWEEN 0 AND 2147483647/i.test(String(error)) || counter?.last >= 2147483647) throw new ApiError(409, "sequence_exhausted", "Sequência de trabalhos esgotada.");
    if (/malformed JSON|os_version_conflict/i.test(String(error))) throw versionConflict();
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
    snapshotType(order) || commercialOf(order).privacy === "adult_payer_only" ? { order_id: order.id, id: order.id, version: 1, type_id: order.type_id } : {
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
  const intent = ["update", data];
  const replay = await replayWorkWrite(ctx, order, mutationKey, intent);
  if (replay) return replay;
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
  if (snapshotType(order)) return commitOrderMutation(ctx, order, { ...sets, stage_approval_json: cancelApproval(order) }, actor, "os.updated", changed.flatMap(k => k === "extra_json" ? Object.keys(data.extra) : [k]), mutationKey, "", workWriteReceipt(ctx, order, mutationKey, intent, now()));
  const at = now();
  const commercial = await prepareWorkMutation(ctx, order, sets, actor, at);
  const fields = Object.keys(commercial.sets);
  await atomic(ctx, [
    [
      `UPDATE os_orders SET ${fields.map((k) => k + "=?").join(",")},updated=?,stale_notified_at=NULL,row_version=row_version+1 WHERE id=? AND profile_id=? AND row_version=?`,
      [...Object.values(commercial.sets), at, order.id, ctx.profile, order.row_version ?? 1],
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
    ...commercial.statements, ...workWriteReceipt(ctx, order, mutationKey, intent, at),
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
  options: { notify?: boolean; mutationKey?: string; stage?: string; writeIntent?: unknown } = {},
) {
  const intent = options.writeIntent ?? ["move", to, note, extra, kind, options.stage ?? null];
  const replay = await replayWorkWrite(ctx, order, options.mutationKey, intent);
  if (replay) return replay;
  if (snapshotType(order)) return customMove(ctx, order, to, actor, extra, kind, { ...options, note, writeIntent: intent });
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
  const commercial = await prepareWorkMutation(ctx, order, sets, actor, at, note);
  Object.assign(sets, commercial.sets);
  note = commercial.note;
  const keys = Object.keys(sets);
  const historyId = uid();
  const mutationKey = options.mutationKey;
  const [update] = await atomic(ctx, [
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
    ], casGuard,
    [
      mutationKey
        ? "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created,from_stage,to_stage,entity_version,mutation_key,changed_fields_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1"
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
        ...(mutationKey ? [effectiveStage(order), to, sets.row_version, mutationKey, JSON.stringify(Object.keys(extra))] : []),
      ],
    ],
    ...(options.notify !== false && order.status !== to && (TEXT_KEYS as readonly string[]).includes(to) && cfg.texts[to as TextKey]
      ? [noticeStatement(ctx.profile, { ...order, row_version: sets.row_version }, to as TextKey, `status:${order.id}:${historyId}`, historyId)] : []),
    ...commercial.statements, ...workWriteReceipt(ctx, order, mutationKey, intent, at),
  ]).catch(error => {
    if (error instanceof ApiError && error.code === "version_conflict")
      throw new ApiError(409, "os_conflict", "A ordem de serviço mudou enquanto isso. Atualize e tente de novo.");
    throw error;
  });
  if (!update.meta.changes)
    throw new ApiError(
      409,
      "os_conflict",
      "A ordem de serviço mudou enquanto isso. Atualize e tente de novo.",
    );
  const next = await loadOrder(ctx, order.id);
  await resumeBuiltinStatus(ctx, { id: historyId, from_status: order.status, to_status: to, actor, note, mutation_key: mutationKey, entity_version: sets.row_version, changed_fields_json: JSON.stringify(Object.keys(extra)) }, next, options.notify !== false);
  return next;
}

/** Efeitos legados também usados pela retomada da rota de etapa virtual. */
export async function resumeBuiltinStatus(ctx: ModuleContext, history: any, row: any, notifyCustomer = true) {
  const to = history.to_status, actor = history.actor, note = history.note;
  if ((json(history.changed_fields_json, []) as string[]).includes("decision") && ["approved", "declined"].includes(to))
    await ctx.publish(to === "approved" ? "os.approved" : "os.declined", row.id, {
      order_id: row.id, number: row.number, total_cents: row.quote_total_cents, version: row.quote_version,
      by: row.decided_by, via: row.decided_via, at: row.decided_at,
    }, { key: `decision:${row.id}:${history.entity_version}` });
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
  options: { notify?: boolean; mutationKey?: string; stage?: string; writeIntent?: unknown } = {},
) {
  const intent = options.writeIntent ?? ["status", to, note ?? null, options.stage ?? null];
  const replay = await replayWorkWrite(ctx, order, options.mutationKey, intent);
  if (replay) return replay;
  requireValue(isStatus(to), "Estado desconhecido.");
  const memo = text(note, 500, "a nota");
  if (snapshotType(order)) return customStatus(ctx, order, to, actor, { ...options, note: memo, writeIntent: intent });
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
  return moveOrder(ctx, order, to, actor, memo, {}, "status", { ...options, writeIntent: intent });
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
  const intent = ["quote", data];
  const replay = await replayWorkWrite(ctx, order, mutationKey, intent);
  if (replay) return replay;
  checkVersion(order, data.version, false);
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
  const sets: Record<string, any> = {
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
      { ...options, mutationKey, writeIntent: intent },
    );
  if (snapshotType(order)) return commitOrderMutation(ctx, order, { ...sets, stage_approval_json: cancelApproval(order) }, actor, "os.quote_saved", ["quote"], mutationKey, "", workWriteReceipt(ctx, order, mutationKey, intent, now()));
  const at = now();
  const commercial = await prepareWorkMutation(ctx, order, sets, actor, at);
  Object.assign(sets, commercial.sets);
  const keys = Object.keys(sets) as (keyof typeof sets)[];
  const [update] = await atomic(ctx, [
    [
      `UPDATE os_orders SET ${keys.map((k) => k + "=?").join(",")},updated=?,row_version=row_version+1 WHERE id=? AND profile_id=? AND status=? AND row_version=?`,
      [...keys.map((k) => sets[k]), at, order.id, ctx.profile, order.status, order.row_version ?? 1],
    ], casGuard,
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
    ...commercial.statements, ...workWriteReceipt(ctx, order, mutationKey, intent, at),
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
    item.quantity !== 1
      ? `• ${item.quantity} x ${item.description}: ${money(quoteTotal([item]))} (${money(item.unit_cents)} cada)`
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
  const intent = ["send_quote", options.notify !== false];
  const replay = await replayWorkWrite(ctx, order, options.mutationKey, intent);
  if (replay) {
    const history = await mutationHistory(ctx, options.mutationKey);
    if (history) await resumeOrderEffects(ctx, history, replay, options.notify !== false);
    return replay;
  }
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
    { ...options, notify: false, writeIntent: intent },
  );
  await ctx.publish("os.quoted", order.id, snapshotType(order) ? { order_id: order.id, version: next.row_version } : {
    order_id: order.id,
    number: next.number,
    total_cents: next.quote_total_cents,
    valid_until: next.quote_valid_until,
    version: next.quote_version,
    sent: send,
    actor,
  }, { key: `quoted:${order.id}:${next.row_version}` });
  const recipient = c ? await conversationOf(ctx, next) : null;
  if (recipient)
    await ctx.sendInteractive(recipient, quoteSpec(next), {
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
  options: { mutationKey?: string; notify?: boolean; quote_version?: number } = {},
) {
  const intent = ["decide", decision, via, note, options.quote_version ?? null];
  const replay = await replayWorkWrite(ctx, order, options.mutationKey, intent);
  if (replay) {
    const history = await mutationHistory(ctx, options.mutationKey);
    if (history) await resumeOrderEffects(ctx, history, replay, options.notify !== false);
    return replay;
  }
  if (options.quote_version !== undefined && options.quote_version !== order.quote_version) throw new ApiError(409, "quote_version_conflict", "Esta resposta pertence a uma versão anterior do orçamento.");
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
    { ...options, writeIntent: intent },
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
    { key: `decision:${order.id}:${next.row_version}` },
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
    const scope = await workCustomerScope(ctx, c);
    order = await one(
      ctx.env,
      `SELECT * FROM os_orders WHERE id=? AND profile_id=? AND ${scope.sql}`,
      button[1],
      ctx.profile,
      ...scope.params,
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
    const scope = await workCustomerScope(ctx, c);
    decision = digit
      ? digit[1] === "1"
        ? "approve"
        : "decline"
      : word![1].startsWith("aprov")
        ? "approve"
        : "decline";
    if (word?.[2]) {
      order = await one(
        ctx.env,
        `SELECT * FROM os_orders WHERE profile_id=? AND number=? AND ${scope.sql}`,
        ctx.profile,
        Number(word[2]),
        ...scope.params,
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
        `SELECT * FROM os_orders WHERE profile_id=? AND ${scope.sql} AND status='quoted' ORDER BY quote_sent_at DESC`,
        ctx.profile,
        ...scope.params,
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
  const mutationKey = `quote-reply:${c.id}:${turn.rowId}`;
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
      { mutationKey, quote_version: button ? Number(button[2]) : order.quote_version },
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
 * Ordens do contato canônico (legado somente na conversa de origem), como
 * o "Acompanhar" do cliente: para o bot (os_situacao), sem busca por outro
 * telefone ou número. `open` deixa de fora entregues e canceladas.
 */
export async function ordersOfCustomer(
  ctx: ModuleContext,
  c: Conversation,
  open = false,
  typeId?: string,
) {
  const rows = await customerOrders(ctx, c, open, typeId, "DESC");
  return rows.map((row) => orderView(row));
}

async function customerOrders(ctx: ModuleContext, c: Conversation, open: boolean, typeId: string | undefined, direction: "ASC" | "DESC") {
  const scope = await workCustomerScope(ctx, c);
  return all(ctx.env,
    `SELECT * FROM os_orders WHERE profile_id=? AND ${scope.sql}${open ? " AND status NOT IN ('delivered','cancelled')" : ""}${typeId ? " AND type_id=?" : ""} ORDER BY number ${direction} LIMIT 20`,
    ctx.profile, ...scope.params, ...(typeId ? [typeId] : []));
}

export async function trackText(ctx: ModuleContext, c: Conversation, typeId?: string) {
  const authorized = await customerOrders(ctx, c, false, typeId, "ASC");
  for (const row of authorized) {
    if (!row.conversation_id && await workCustomerAllows(ctx, c, row, true)) {
      const scope = await workCustomerScope(ctx, c);
      // Vinculação legada também altera o cliente comercial. Se já há efeito,
      // o acompanhamento continua, preservando o proprietário congelado.
      if (!(await readWorkIntegration(ctx, row)).frozen) {
        const at = now();
        const commercial = await prepareWorkMutation(ctx, row, { conversation_id: c.id, contact_id: row.contact_id ?? scope.contactId }, "customer", at);
        try {
          await atomic(ctx, [[`UPDATE os_orders SET conversation_id=?,contact_id=coalesce(contact_id,?),commercial_json=?,row_version=row_version+1
            WHERE profile_id=? AND id=? AND conversation_id IS NULL AND contact_id IS ? AND row_version=? AND ${scope.sql}
              AND (? IS NULL OR EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND version=? AND identity_state='active'))
              AND NOT EXISTS(SELECT 1 FROM conversations WHERE profile_id=? AND id=? AND customer_link_state IN ('blocked','excluded','ambiguous'))`,
            [c.id, scope.contactId, commercial.sets.commercial_json, ctx.profile, row.id, row.contact_id, row.row_version, ...scope.params,
            scope.contactId, ctx.profile, scope.contactId, 'ref' in scope ? scope.ref.version : null, ctx.profile, c.id]], casGuard,
            ["INSERT INTO os_history(id,profile_id,order_id,kind,actor,created,entity_version,changed_fields_json) VALUES(?,?,?,'os.updated','customer',?,?,?)", [uid(), ctx.profile, row.id, at, row.row_version + 1, JSON.stringify(["customer_link"])]],
            // A vinculação não muda o conteúdo do aviso. Move apenas a
            // intenção da versão corrente, no mesmo CAS do proprietário.
            ["UPDATE customer_progress SET cursor_json=json_set(cursor_json,'$.version',?) WHERE profile_id=? AND namespace='team' AND task LIKE 'os:notice:%' AND complete=0 AND json_extract(cursor_json,'$.orderId')=? AND json_extract(cursor_json,'$.version')=?", [row.row_version + 1, ctx.profile, row.id, row.row_version]],
            ...commercial.statements,
          ]);
        } catch (error) { if (!(error instanceof ApiError) || error.code !== "version_conflict") throw error; }
        const fresh = await loadOrder(ctx, row.id);
        Object.assign(row, fresh);
      }
    }
    try { await resumePendingNotices(ctx, row); }
    catch { row.notification = { state: "failed", reason: "Aviso pendente de nova tentativa." }; }
  }
  const rows = authorized.filter(row => !["delivered", "cancelled"].includes(row.status));
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
