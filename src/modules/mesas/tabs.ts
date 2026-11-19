import { hash } from "../../integrations/keys";
import { aliasStatements, compactReceiptWrites } from "../../integrations/outbox";
import { requireReceiptPerson, tablePaymentPlan, tableReceipt, tableReceiptData, serviceComponents, touchTableOrigin } from "./integration";
import { commerceGuard, CommercePlan, commercialId, reverseReceiptStatements } from "../pedido/public";
import { registerReceiptReverser, type CommercialReceipt } from "../../integrations/receipts";
import { modulesApi } from "../api";
// Mesas: a conta da mesa. Abrir, lançar pedidos para a cozinha (pedidos do
// Pedido, pelo public.ts dele), transferir, juntar, pedir a conta, reabrir,
// pagamentos parciais, fechar e cancelar. Escritas rodam como comandos
// (Coordinator, Idempotency-Key), uma de cada vez por área; ainda assim cada
// mudança de estado é um UPDATE condicionado ao estado e à versão lidos.
import { all, batch, one } from "../../db";
import { ApiError, type Actor, now, requireValue, uid } from "../../types";
import type { ModuleContext } from "../api";
import * as pedido from "../pedido/public";
import {
  LIVE_STATUSES,
  PAY_LABELS,
  PAY_METHODS,
  TAB_STATUSES,
  TAB_STATUS_LABELS,
  TABLE_STATE_LABELS,
  billTotals,
  clip,
  intIn,
  isLive,
  mesasConfig,
  text,
  type BillTotals,
  type MesasConfig,
  type PayMethod,
  type TabStatus,
  type TableState,
} from "./model";
import { listTables, loadTable, tableView } from "./tables";

const LIVE_SQL = "status IN ('open','closing')";

const notFound = () => new ApiError(404, "not_found", "Conta não encontrada.");
const conflict = () =>
  new ApiError(
    409,
    "tab_conflict",
    "A conta mudou enquanto isso. Atualize e tente de novo.",
  );
const closedTab = (tab: any) =>
  new ApiError(
    409,
    "tab_closed",
    `A conta nº ${tab.number} (${tab.table_name}) está ${TAB_STATUS_LABELS[tab.status as TabStatus].toLowerCase()}.`,
  );

export async function config(ctx: ModuleContext): Promise<MesasConfig> {
  return mesasConfig(await ctx.settings());
}

/**
 * Quem opera as mesas (abrir, lançar, transferir, juntar, conta, pagamentos,
 * fechar): pessoas com o papel Garçom (`mesas:waiter`, Gestão → Pessoas e
 * acessos) e administradores. Atendente sem o papel só vê o mapa e as contas.
 * Aplicações (PDV, totem) seguem o escopo conversations:write; não têm papel.
 */
export async function mayOperate(ctx: ModuleContext, actor: Actor) {
  if (actor.kind !== "user") return true;
  if (actor.role === "admin") return true;
  return ctx.granted(actor, "waiter");
}

async function requireWaiter(ctx: ModuleContext, actor: Actor) {
  ctx.access(actor, "conversations:write");
  if (!(await mayOperate(ctx, actor)))
    throw new ApiError(
      403,
      "role_required",
      "Só quem tem o papel Garçom (Gestão → Pessoas e acessos) ou é administrador opera as mesas.",
    );
}

// ---------------------------------------------------------------------------
// Leitura

export async function loadTab(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw notFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM mesas_tabs WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw notFound();
  return row;
}

async function liveTab(ctx: ModuleContext, id: unknown) {
  const tab = await loadTab(ctx, id);
  if (!isLive(tab.status)) throw closedTab(tab);
  return tab;
}

export function paymentView(row: any) {
  return {
    id: row.id as string,
    tab_id: row.tab_id as string,
    method: row.method as PayMethod,
    method_label: PAY_LABELS[row.method as PayMethod] || row.method,
    amount_cents: row.amount_cents as number,
    tendered_cents: row.tendered_cents as number | null,
    change_cents: row.change_cents as number | null,
    note: row.note as string,
    status: row.status as "ok" | "void",
    created_by: row.created_by as string,
    created: row.created as number,
    voided_by: row.voided_by as string | null,
    voided_at: row.voided_at as number | null,
    void_reason: row.void_reason as string | null,
  };
}

const paidOf = (payments: any[]) =>
  payments
    .filter((p) => p.status === "ok")
    .reduce((sum, p) => sum + p.amount_cents, 0);

interface Counts {
  item_count: number;
  orders: number;
  kitchen: number;
  ready: number;
}

/** Totais e contagens a partir dos pedidos da conta (do Pedido). */
function countOrders(orders: pedido.OrderView[]) {
  const live = orders.filter((o) => o.status !== "cancelled");
  return {
    subtotal: live.reduce((sum, o) => sum + o.total_cents, 0),
    counts: {
      item_count: live.reduce((sum, o) => sum + o.item_count, 0),
      orders: live.length,
      kitchen: live.filter((o) => ["received", "preparing"].includes(o.status))
        .length,
      ready: live.filter((o) => o.status === "ready").length,
    } satisfies Counts,
  };
}

/**
 * Formato da API (docs/API.md, Mesas). `bill` traz subtotal, serviço,
 * total, pago e a pagar; na conta fechada, os valores gravados no
 * fechamento.
 */
export function tabView(
  row: any,
  live: { subtotal: number; paid: number; counts: Counts | null },
  at = now(),
) {
  const bill: BillTotals = isLive(row.status)
    ? billTotals(live.subtotal, !!row.service, row.service_permille, live.paid)
    : {
        subtotal_cents: row.subtotal_cents ?? live.subtotal,
        service_on: !!row.service,
        service_percent: row.service_permille / 10,
        service_cents: row.service_cents ?? 0,
        total_cents: row.total_cents ?? live.subtotal,
        paid_cents: row.paid_cents ?? live.paid,
        due_cents: 0,
        overpaid_cents: Math.max(
          0,
          (row.paid_cents ?? 0) - (row.total_cents ?? 0),
        ),
      };
  return {
    id: row.id as string,
    number: row.number as number,
    status: row.status as TabStatus,
    status_label: TAB_STATUS_LABELS[row.status as TabStatus] || row.status,
    table: { id: row.table_id as string, name: row.table_name as string },
    guests: row.guests as number,
    customer_name: row.customer_name as string,
    note: row.note as string,
    waiter_id: row.waiter_id as string | null,
    bill,
    item_count: live.counts?.item_count ?? null,
    orders_count: live.counts?.orders ?? null,
    /** Pedidos ainda na cozinha (recebido, em preparo). */
    kitchen_count: live.counts?.kitchen ?? null,
    /** Pedidos prontos para servir. */
    ready_count: live.counts?.ready ?? null,
    opened_by: row.opened_by as string,
    opened_at: row.opened_at as number,
    minutes_open: Math.max(
      0,
      Math.floor(((row.closed_at ?? at) - row.opened_at) / 60_000),
    ),
    bill_requested_at: row.bill_requested_at as number | null,
    closed_by: row.closed_by as string | null,
    closed_at: row.closed_at as number | null,
    merged_into: row.merged_into as string | null,
    cancel_reason: row.cancel_reason as string | null,
    created: row.created as number,
    updated: row.updated as number,
  };
}
export type TabView = ReturnType<typeof tabView>;

/** Conta com os totais atuais (pedidos do Pedido e pagamentos). */
function stateRead(ctx: ModuleContext, id: string, withTab: boolean): [string, any[]] {
  const [orders, args] = pedido.tabOrdersSnapshotSql(ctx.profile, id);
  return [`SELECT ${withTab ? "t.*," : ""} (${orders}) orders_json,
    (SELECT json_group_array(json_object('id',id,'profile_id',profile_id,'tab_id',tab_id,'method',method,
      'amount_cents',amount_cents,'tendered_cents',tendered_cents,'change_cents',change_cents,'note',note,
      'status',status,'created_by',created_by,'created',created,'voided_by',voided_by,'voided_at',voided_at,'void_reason',void_reason))
      FROM (SELECT * FROM mesas_payments WHERE tab_id=? AND profile_id=? ORDER BY created,rowid LIMIT 200)) payments_json
    ${withTab ? "FROM mesas_tabs t WHERE t.id=? AND t.profile_id=?" : ""}`,
    [...args, id, ctx.profile, ...(withTab ? [id, ctx.profile] : [])]];
}
function stateOf(tab: any, row: any) {
  const orders = (JSON.parse(row.orders_json) as any[]).map(order => pedido.orderView(order));
  const payments = JSON.parse(row.payments_json) as any[];
  const { subtotal, counts } = countOrders(orders);
  return { tab: tabView(tab, { subtotal, paid: paidOf(payments), counts }), orders, payments };
}
export async function tabState(ctx: ModuleContext, tab: any) {
  const [sql, args] = stateRead(ctx, tab.id, false);
  return stateOf(tab, await one(ctx.env, sql, ...args));
}
async function currentTabState(ctx: ModuleContext, id: string, command?: { scope: string; key: string }) {
  const [sql, args] = stateRead(ctx, id, true);
  const row = await one(ctx.env, command
    ? sql.replace("SELECT t.*,", "SELECT t.*,(SELECT fingerprint FROM receipts WHERE scope=? AND key=?) close_fingerprint,") : sql,
    ...(command ? [command.scope, command.key] : []), ...args);
  if (!row) throw notFound();
  return { ...stateOf(row, row), record: row };
}

/** Pagamentos já feitos nas contas abertas, numa consulta. */
async function livePaid(ctx: ModuleContext) {
  const rows = await all(
    ctx.env,
    `SELECT p.tab_id,sum(p.amount_cents) paid FROM mesas_payments p JOIN mesas_tabs t ON t.id=p.tab_id WHERE t.profile_id=? AND t.${LIVE_SQL} AND p.status='ok' GROUP BY p.tab_id`,
    ctx.profile,
  );
  return new Map(rows.map((r) => [r.tab_id as string, r.paid as number]));
}

const history = (
  ctx: ModuleContext,
  tabId: string,
  kind: string,
  actor: string,
  note: string,
  at = now(),
): [string, any[]] => [
  "INSERT INTO mesas_history(id,profile_id,tab_id,kind,actor,note,created) VALUES(?,?,?,?,?,?,?)",
  [uid(), ctx.profile, tabId, kind, actor, clip(note, 500), at],
];

/**
 * GET mesas: o mapa das mesas para o garçom. Cada mesa com o estado (livre,
 * ocupada, fechando) e o resumo da conta aberta; contagens e a configuração.
 */
export async function overview(ctx: ModuleContext, at: number, actor?: Actor) {
  const [cfg, tables, tabs, totals, paid, waiters, operate] = await Promise.all(
    [
      config(ctx),
      listTables(ctx),
      all(
        ctx.env,
        `SELECT * FROM mesas_tabs WHERE profile_id=? AND ${LIVE_SQL} LIMIT 500`,
        ctx.profile,
      ),
      pedido.openTabTotals(ctx.env, ctx.profile),
      livePaid(ctx),
      ctx.grantees("waiter"),
      actor ? mayOperate(ctx, actor) : Promise.resolve(false),
    ],
  );
  const summary = (tab: any) => {
    const t = totals.get(tab.id);
    return tabView(
      tab,
      {
        subtotal: t?.subtotal_cents || 0,
        paid: paid.get(tab.id) || 0,
        counts: {
          item_count: t?.item_count || 0,
          orders: t?.orders || 0,
          kitchen: t?.kitchen || 0,
          ready: t?.ready || 0,
        },
      },
      at,
    );
  };
  const byTable = new Map(tabs.map((tab) => [tab.table_id as string, tab]));
  const counts: Record<TableState, number> = {
    free: 0,
    occupied: 0,
    closing: 0,
  };
  const out = tables.map((row) => {
    const tab = byTable.get(row.id);
    const state: TableState = !tab
      ? "free"
      : tab.status === "closing"
        ? "closing"
        : "occupied";
    counts[state]++;
    return {
      ...tableView(row),
      state,
      state_label: TABLE_STATE_LABELS[state],
      tab: tab ? summary(tab) : null,
    };
  });
  return {
    generated_at: at,
    config: cfg,
    /** Quem lê pode operar as mesas (papel Garçom, administrador, aplicação). */
    can_operate: operate,
    /** Pessoas com o papel Garçom (para escolher o garçom da mesa). */
    waiters,
    counts,
    sections: [...new Set(out.map((t) => t.section))],
    tables: out,
  };
}

/** GET mesas/tabs/:id: conta, pedidos da cozinha, pagamentos e histórico. */
export async function tabDetail(ctx: ModuleContext, actor: Actor, id: unknown) {
  const tab = await loadTab(ctx, id);
  const [state, events] = await Promise.all([
    tabState(ctx, tab),
    all(
      ctx.env,
      "SELECT * FROM mesas_history WHERE tab_id=? AND profile_id=? ORDER BY created,rowid LIMIT 300",
      tab.id,
      ctx.profile,
    ),
  ]);
  const notes = ctx.mayRead(actor, "notes");
  return {
    ...state.tab,
    orders: state.orders.map((o) => pedido.orderForActor(ctx, actor, o)),
    payments: state.payments.map(paymentView),
    history: events.map((h) => ({
      id: h.id,
      kind: h.kind,
      actor: h.actor,
      ...(notes ? { note: h.note } : {}),
      created: h.created,
    })),
  };
}

/**
 * GET mesas/tabs: contas por estado (padrão: as abertas), período de
 * abertura e mesa, da mais nova para a mais antiga, paginadas pelo número.
 */
export async function listTabs(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  const statuses = [
    ...new Set((query.status || "open,closing").split(",").filter(Boolean)),
  ];
  for (const s of statuses)
    requireValue(
      (TAB_STATUSES as readonly string[]).includes(s),
      `Estado desconhecido: ${s}.`,
    );
  where.push(`status IN (${statuses.map(() => "?").join(",")})`);
  args.push(...statuses);
  if (query.table_id) {
    where.push("table_id=?");
    args.push(query.table_id);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<"],
  ] as const)
    if (query[key]) {
      const at = Number(query[key]);
      requireValue(Number.isFinite(at), `${key} em milissegundos.`);
      where.push(`opened_at${op}?`);
      args.push(at);
    }
  const before = Number(query.cursor);
  if (Number.isInteger(before) && before > 0) {
    where.push("number<?");
    args.push(before);
  }
  const limit = Math.min(
    Math.max(Math.trunc(Number(query.limit)) || 50, 1),
    200,
  );
  const rows = await all(
    ctx.env,
    `SELECT * FROM mesas_tabs WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const anyLive = page.some((r) => isLive(r.status));
  const [totals, paid] = anyLive
    ? await Promise.all([
        pedido.openTabTotals(ctx.env, ctx.profile),
        livePaid(ctx),
      ])
    : [new Map(), new Map()];
  return {
    data: page.map((row) => {
      const t = totals.get(row.id);
      return tabView(row, {
        subtotal: t?.subtotal_cents || 0,
        paid: paid.get(row.id) || 0,
        counts: t
          ? {
              item_count: t.item_count,
              orders: t.orders,
              kitchen: t.kitchen,
              ready: t.ready,
            }
          : null,
      });
    }),
    next_cursor: rows.length > limit ? String(page.at(-1)!.number) : null,
  };
}

/** Guarda do UPDATE anterior dentro da escrita do histórico. */
function guardedHistory(...args: Parameters<typeof history>): [string, any[]] {
  const [sql, values] = history(...args);
  return [sql.replace("VALUES(?", "VALUES(CASE WHEN changes()=1 THEN ? ELSE json('integration_version_conflict') END"), values];
}

// ---------------------------------------------------------------------------
// Escritas

async function publish(
  ctx: ModuleContext,
  kind: string,
  tab: any,
  payload: Record<string, unknown>,
  key: string,
) {
  await ctx.publish(
    kind,
    tab.id,
    {
      tab_id: tab.id,
      number: tab.number,
      table_id: tab.table_id,
      table_name: tab.table_name,
      ...payload,
    },
    { key },
  );
}

/** UPDATE da conta condicionado ao estado e à versão lidos. */
function guardedUpdate(
  ctx: ModuleContext,
  tab: any,
  sets: Record<string, any>,
): [string, any[]] {
  const keys = Object.keys(sets);
  return [
    `UPDATE mesas_tabs SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND profile_id=? AND status=? AND updated=?`,
    [...keys.map((k) => sets[k]), tab.id, ctx.profile, tab.status, tab.updated],
  ];
}

// O núcleo não leva campos extras no erro: a conta aberta vem em GET mesas.
const occupied = (table: any) =>
  new ApiError(
    409,
    "table_occupied",
    `${table.name} já está com a conta aberta.`,
  );

/**
 * POST mesas/tabs {table_id, guests?, customer_name?, note?}: abre a conta
 * na mesa livre. A mesma mesa não abre duas contas (409 table_occupied, com
 * a conta que está aberta).
 */
export async function openTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const table = await loadTable(ctx, data.table_id);
  const guests = intIn(
    data.guests ?? 0,
    0,
    99,
    "Pessoas na mesa: inteiro de 0 a 99.",
  );
  const customer = text(data.customer_name, 80, "o nome do cliente");
  const note = text(data.note, 300, "a observação");
  const open = await one(
    ctx.env,
    `SELECT id FROM mesas_tabs WHERE table_id=? AND profile_id=? AND ${LIVE_SQL}`,
    table.id,
    ctx.profile,
  );
  if (open) throw occupied(table);
  const cfg = await config(ctx);
  const counter = await one<{ last: number }>(
    ctx.env,
    "INSERT INTO mesas_counters(profile_id,last) VALUES(?,1) ON CONFLICT(profile_id) DO UPDATE SET last=last+1 RETURNING last",
    ctx.profile,
  );
  const id = uid(),
    at = now();
  const service = cfg.service_default && cfg.service_percent > 0;
  await batch(ctx.env, [
    [
      "INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,guests,customer_name,note,waiter_id,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        ctx.profile,
        counter!.last,
        table.id,
        table.name,
        guests,
        customer,
        note,
        actor.id,
        service ? 1 : 0,
        Math.round(cfg.service_percent * 10),
        actor.id,
        at,
        at,
        at,
      ],
    ],
    history(
      ctx,
      id,
      "opened",
      actor.id,
      `Conta aberta${guests ? ` para ${guests} ${guests === 1 ? "pessoa" : "pessoas"}` : ""}.`,
      at,
    ),
  ]);
  const tab = await loadTab(ctx, id);
  await publish(
    ctx,
    "mesas.tab_opened",
    tab,
    { guests, actor: actor.id },
    `opened:${id}`,
  );
  return tabView(tab, { subtotal: 0, paid: 0, counts: null });
}

/**
 * POST mesas/tabs/:id/orders {items, note?}: lança os itens na conta e manda
 * para o quadro da cozinha do Pedido (um pedido numerado por envio). Conta
 * com a conta pedida volta a "aberta". Repetir a mesma Idempotency-Key não
 * duplica o pedido.
 */
export async function sendOrder(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  await requireWaiter(ctx, actor);
  const tab = await loadTab(ctx, data.id);
  const note = text(data.note, 300, "a observação do pedido");
  const { order } = await pedido.createTableOrder(
    ctx.env,
    ctx.profile,
    {
      tab_id: tab.id,
      table_label: tab.table_name,
      items: data.items,
      note,
      customer_name: tab.customer_name || undefined,
      sourceKey: `mesas:${tab.id}:${requestId}`,
      actor: actor.id,
      commit: async (createdOrder, commerce) => {
        if (!isLive(tab.status)) throw closedTab(tab);
        const at = now();
        if (commerce && tab.service) {
          const state = await tabState(ctx, tab);
          // Materializa o saldo anterior sem reconhecer passado; o acréscimo
          // do novo pedido recebe sua própria revisão e data de aceite.
          const before = billTotals(state.tab.bill.subtotal_cents, true, tab.service_permille, 0).service_cents;
          const desired = billTotals(state.tab.bill.subtotal_cents + createdOrder.total_cents, true, tab.service_permille, 0).service_cents;
          await serviceComponents(ctx, tab, desired, commerce, before);
        }
        return [guardedUpdate(ctx, tab, { updated: at, ...(tab.status === "closing" ? { status: "open", bill_requested_at: null } : {}) }),
          guardedHistory(ctx, tab.id, "order", actor.id, `Pedido nº ${createdOrder.number} para a cozinha: ${createdOrder.item_count} ${createdOrder.item_count === 1 ? "item" : "itens"}, ${pedido.money(createdOrder.total_cents)}.`, at),
          ...(tab.status === "closing" ? [history(ctx, tab.id, "reopened", actor.id, "Conta reaberta: novo pedido.", at)] : [])];
      },
    },
  );
  {
    await publish(
      ctx,
      "mesas.order_sent",
      tab,
      {
        order_id: order.id,
        order_number: order.number,
        item_count: order.item_count,
        total_cents: order.total_cents,
        actor: actor.id,
      },
      `order:${order.id}`,
    );
  }
  const state = await currentTabState(ctx, tab.id);
  return {
    tab: state.tab,
    order: pedido.orderForActor(ctx, actor, order),
  };
}

/**
 * PATCH mesas/tabs/:id {guests?, customer_name?, note?, service?,
 * waiter_id?}: pessoas, nome, observação, taxa de serviço desta conta e o
 * garçom ("me" assume a mesa; outra pessoa, só administrador).
 */
export async function updateTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const tab = await liveTab(ctx, data.id);
  const sets: Record<string, any> = {};
  if (data.guests !== undefined)
    sets.guests = intIn(data.guests, 0, 99, "Pessoas: inteiro de 0 a 99.");
  if (data.customer_name !== undefined)
    sets.customer_name = text(data.customer_name, 80, "o nome do cliente");
  if (data.note !== undefined) sets.note = text(data.note, 300, "a observação");
  if (data.service !== undefined) {
    requireValue(
      typeof data.service === "boolean",
      "service: verdadeiro ou falso.",
    );
    requireValue(
      !data.service || tab.service_permille > 0,
      "A taxa de serviço está desligada nas configurações das Mesas.",
    );
    sets.service = data.service ? 1 : 0;
  }
  if (data.waiter_id !== undefined) {
    const me = data.waiter_id === "me" || data.waiter_id === actor.id;
    const admin = actor.kind === "user" && actor.role === "admin";
    if (me)
      requireValue(
        actor.kind === "user",
        "Aplicação não assume mesa: informe o id do garçom.",
      );
    else {
      // Passar a mesa a outra pessoa: administrador ou aplicação, e só para
      // quem tem o papel Garçom.
      requireValue(
        admin || actor.kind !== "user",
        'Para assumir a mesa, envie waiter_id "me". Passar a outra pessoa é só para administradores.',
      );
      const waiters = await ctx.grantees("waiter");
      requireValue(
        waiters.some((w) => w.id === data.waiter_id),
        "Escolha uma pessoa com o papel Garçom.",
      );
    }
    sets.waiter_id = me ? actor.id : data.waiter_id;
  }
  const changed = Object.keys(sets).filter((k) => sets[k] !== tab[k]);
  if (!changed.length) return (await tabState(ctx, tab)).tab;
  const at = now();
  const patch = Object.fromEntries(changed.map((k) => [k, sets[k]]));
  const commerce = new CommercePlan(ctx, actor.id, at);
  if (changed.includes("service")) {
    const state = await tabState(ctx, tab);
    const desired = billTotals(state.tab.bill.subtotal_cents, !!sets.service, tab.service_permille, state.tab.bill.paid_cents).service_cents;
    await serviceComponents(ctx, tab, desired, commerce, 0);
  }
  const [update] = await batch(ctx.env, [
    guardedUpdate(ctx, tab, { ...patch, updated: at }), commerceGuard,
    ...commerce.statements(),
    history(
      ctx,
      tab.id,
      changed.includes("service") ? "service" : "edit",
      actor.id,
      changed.includes("service")
        ? sets.service
          ? "Taxa de serviço incluída."
          : "Taxa de serviço retirada."
        : "Alterado: " + changed.join(", "),
      at,
    ),
  ]);
  if (!update.meta.changes) throw conflict();
  const fresh = await loadTab(ctx, tab.id);
  await publish(
    ctx,
    "mesas.tab_updated",
    fresh,
    { changed, actor: actor.id },
    `updated:${tab.id}:${at}`,
  );
  return (await tabState(ctx, fresh)).tab;
}

/** POST mesas/tabs/:id/bill: o cliente pediu a conta (mesa "fechando"). */
export async function requestBill(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const tab = await liveTab(ctx, data.id);
  if (tab.status === "open") {
    const at = now();
    const [update] = await batch(ctx.env, [
      guardedUpdate(ctx, tab, {
        status: "closing",
        bill_requested_at: at,
        updated: at,
      }),
      history(ctx, tab.id, "bill", actor.id, "Conta pedida.", at),
    ]);
    if (!update.meta.changes) throw conflict();
    await publish(
      ctx,
      "mesas.bill_requested",
      tab,
      { actor: actor.id },
      `bill:${tab.id}:${at}`,
    );
  }
  return (await currentTabState(ctx, tab.id)).tab;
}

/** POST mesas/tabs/:id/reopen: volta a "aberta" depois de pedir a conta. */
export async function reopenTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const tab = await liveTab(ctx, data.id);
  if (tab.status === "closing") {
    const at = now();
    const [update] = await batch(ctx.env, [
      guardedUpdate(ctx, tab, {
        status: "open",
        bill_requested_at: null,
        updated: at,
      }),
      history(ctx, tab.id, "reopened", actor.id, "Conta reaberta.", at),
    ]);
    if (!update.meta.changes) throw conflict();
    await publish(
      ctx,
      "mesas.tab_reopened",
      tab,
      { actor: actor.id },
      `reopened:${tab.id}:${at}`,
    );
  }
  return (await currentTabState(ctx, tab.id)).tab;
}

/**
 * POST mesas/tabs/:id/transfer {table_id}: a conta (com os pedidos e
 * pagamentos) passa para uma mesa livre.
 */
export async function transferTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const tab = await liveTab(ctx, data.id);
  const target = await loadTable(ctx, data.table_id);
  if (target.id === tab.table_id) return (await tabState(ctx, tab)).tab;
  const busy = await one(
    ctx.env,
    `SELECT id FROM mesas_tabs WHERE table_id=? AND profile_id=? AND ${LIVE_SQL}`,
    target.id,
    ctx.profile,
  );
  if (busy)
    throw new ApiError(
      409,
      "table_occupied",
      `${target.name} está ocupada. Para somar as contas, use juntar mesas.`,
    );
  const at = now();
  const commerce = new CommercePlan(ctx, actor.id, at);
  await touchTableOrigin(ctx, tab, commerce);
  const [update] = await batch(ctx.env, [
    guardedUpdate(ctx, tab, {
      table_id: target.id,
      table_name: target.name,
      updated: at,
    }),
    commerceGuard,
    ...pedido.moveTabOrderStatements(ctx.profile, tab.id, tab.id, target.name),
    ...commerce.statements(),
    history(
      ctx,
      tab.id,
      "transfer",
      actor.id,
      `Transferida de ${tab.table_name} para ${target.name}.`,
      at,
    ),
  ]);
  if (!update.meta.changes) throw conflict();
  // Quadro da cozinha e comanda com o nome da mesa nova.

  await publish(
    ctx,
    "mesas.tab_transferred",
    { ...tab, table_id: target.id, table_name: target.name },
    { from_table_id: tab.table_id, from_table_name: tab.table_name },
    `transfer:${tab.id}:${at}`,
  );
  return (await currentTabState(ctx, tab.id)).tab;
}

/**
 * POST mesas/tabs/:id/merge {tab_id | table_id}: junta a outra conta nesta.
 * Pedidos e pagamentos passam para esta conta, as pessoas somam e a outra
 * mesa fica livre (a conta dela fica "juntada", com `merged_into`).
 */
export async function mergeTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const target = await liveTab(ctx, data.id);
  let sourceId = data.tab_id;
  if (sourceId === undefined && data.table_id !== undefined) {
    const table = await loadTable(ctx, data.table_id);
    const open = await one(
      ctx.env,
      `SELECT id FROM mesas_tabs WHERE table_id=? AND profile_id=? AND ${LIVE_SQL}`,
      table.id,
      ctx.profile,
    );
    if (!open)
      throw new ApiError(
        409,
        "table_free",
        `${table.name} está livre: não há conta para juntar.`,
      );
    sourceId = open.id;
  }
  requireValue(
    typeof sourceId === "string",
    "Informe tab_id (ou table_id) da conta a juntar.",
  );
  requireValue(sourceId !== target.id, "Escolha outra mesa para juntar.");
  const source = await loadTab(ctx, sourceId);
  if (source.status === "merged" && source.merged_into === target.id) return (await tabState(ctx, target)).tab;
  if (!isLive(source.status)) throw closedTab(source);
  const at = now();
  const commerce = new CommercePlan(ctx, actor.id, at);
  await touchTableOrigin(ctx, source, commerce);
  await touchTableOrigin(ctx, target, commerce);
  const [closeSource] = await batch(ctx.env, [
    guardedUpdate(ctx, source, {
      status: "merged",
      merged_into: target.id,
      closed_by: actor.id,
      closed_at: at,
      updated: at,
    }),
    commerceGuard,
    ...pedido.moveTabOrderStatements(ctx.profile, source.id, target.id, target.table_name),
    ...commerce.statements(),
    [
      "UPDATE mesas_payments SET tab_id=? WHERE tab_id=? AND profile_id=?",
      [target.id, source.id, ctx.profile],
    ],
    guardedUpdate(ctx, target, {
      guests: Math.min(99, target.guests + source.guests),
      status: "open",
      bill_requested_at: null,
      updated: at,
    }),
    commerceGuard,
    history(
      ctx,
      source.id,
      "merged",
      actor.id,
      `Juntada à conta nº ${target.number} (${target.table_name}).`,
      at,
    ),
    history(
      ctx,
      target.id,
      "merge",
      actor.id,
      `Conta nº ${source.number} (${source.table_name}) juntada a esta.`,
      at,
    ),
  ]);
  if (!closeSource.meta.changes) throw conflict();
  await publish(
    ctx,
    "mesas.tab_merged",
    target,
    {
      from_tab_id: source.id,
      from_number: source.number,
      from_table_id: source.table_id,
      from_table_name: source.table_name,
      actor: actor.id,
    },
    `merge:${source.id}`,
  );
  return (await tabState(ctx, await loadTab(ctx, target.id))).tab;
}

interface NewPayment {
  method: PayMethod;
  amount_cents: number;
  tendered_cents: number | null;
  change_cents: number | null;
  note: string;
}

function parsePayment(raw: any, due: number, index?: number): NewPayment {
  const where = index === undefined ? "" : `Pagamento ${index + 1}: `;
  requireValue(
    raw && typeof raw === "object",
    `${where}informe method e amount_cents.`,
  );
  requireValue(
    (PAY_METHODS as readonly string[]).includes(raw.method),
    `${where}forma de pagamento: cash, card, pix ou other.`,
  );
  const amount = intIn(
    raw.amount_cents,
    1,
    10_000_000,
    `${where}valor em centavos, inteiro a partir de 1.`,
  );
  if (amount > due)
    throw new ApiError(
      409,
      "amount_exceeds_due",
      `${where}o valor (${pedido.money(amount)}) passa do que falta pagar (${pedido.money(due)}).`,
    );
  let tendered: number | null = null;
  if (raw.tendered_cents !== undefined && raw.tendered_cents !== null) {
    requireValue(
      raw.method === "cash",
      `${where}valor entregue (troco) só em dinheiro.`,
    );
    tendered = intIn(
      raw.tendered_cents,
      amount,
      10_000_000,
      `${where}valor entregue em centavos, pelo menos o valor pago.`,
    );
  }
  return {
    method: raw.method,
    amount_cents: amount,
    tendered_cents: tendered,
    change_cents: tendered === null ? null : tendered - amount,
    note: text(raw.note, 120, "a nota do pagamento"),
  };
}

function insertPayment(
  ctx: ModuleContext,
  tabId: string,
  p: NewPayment,
  actor: string,
  at: number,
  id: string = uid(),
): [string, any[]][] {
  return [
    [
      "INSERT INTO mesas_payments(id,profile_id,tab_id,method,amount_cents,tendered_cents,change_cents,note,status,created_by,created) VALUES(?,?,?,?,?,?,?,?,'ok',?,?)",
      [
        id,
        ctx.profile,
        tabId,
        p.method,
        p.amount_cents,
        p.tendered_cents,
        p.change_cents,
        p.note,
        actor,
        at,
      ],
    ],
    history(
      ctx,
      tabId,
      "payment",
      actor,
      `Pagamento: ${PAY_LABELS[p.method]} ${pedido.money(p.amount_cents)}${p.change_cents ? ` (troco ${pedido.money(p.change_cents)})` : ""}.`,
      at,
    ),
  ];
}

/**
 * POST mesas/tabs/:id/payments {method, amount_cents, tendered_cents?,
 * note?}: pagamento parcial (uma pessoa paga a parte dela). Nunca passa do
 * que falta (409 amount_exceeds_due); em dinheiro, `tendered_cents` calcula o
 * troco.
 */
export async function addPayment(ctx: ModuleContext, actor: Actor, data: any, requestId: string = uid()) {
  await requireWaiter(ctx, actor);
  const tab = await loadTab(ctx, data.id);
  const receiptResult = await tableReceipt(ctx, tab.id, data, requestId, actor);
  const paymentId = commercialId(ctx.profile, "mesas-payment", requestId);
  if (receiptResult.repeated) {
    const old = await one(ctx.env, "SELECT * FROM mesas_payments WHERE id=? AND profile_id=?", paymentId, ctx.profile);
    return { payment: paymentView(old), tab: (await tabState(ctx, tab)).tab };
  }
  if (!isLive(tab.status)) throw closedTab(tab);
  const before = await tabState(ctx, tab);
  if (!before.tab.bill.due_cents)
    throw new ApiError(409, "nothing_due", "Não há valor a pagar nesta conta.");
  const payment = parsePayment(data, before.tab.bill.due_cents);
  const at = now();
  const commerce = await tablePaymentPlan(ctx, tab, before.tab.bill.service_cents, [receiptResult.receipt], actor.id);
  commerce.append(...paymentAlias(ctx.profile, receiptResult.receipt, paymentId));
  await batch(ctx.env, [guardedUpdate(ctx, tab, { updated: at }), commerceGuard,
    ...insertPayment(ctx, tab.id, payment, actor.id, at, paymentId), ...commerce.statements()]);
  await publish(
    ctx,
    "mesas.payment_added",
    tab,
    {
      payment_id: paymentId,
      method: payment.method,
      amount_cents: payment.amount_cents,
      actor: actor.id,
    },
    `payment:${paymentId}`,
  );
  const after = await currentTabState(ctx, tab.id);
  return {
    payment: paymentView(after.payments.find((p) => p.id === paymentId) || {}),
    tab: after.tab,
  };
}

/** POST mesas/payments/:id/void {reason}: desfaz um pagamento lançado errado. */
export async function voidPayment(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  requireReceiptPerson(actor);
  const row = await one(
    ctx.env,
    "SELECT * FROM mesas_payments WHERE id=? AND profile_id=?",
    typeof data.id === "string" ? data.id : "",
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Pagamento não encontrado.");
  const tab = await loadTab(ctx, row.tab_id);
  if (row.status === "void")
    return { payment: paymentView(row), tab: (await tabState(ctx, tab)).tab };
  if (!isLive(tab.status)) throw closedTab(tab);
  const reason = text(data.reason, 200, "o motivo", true);
  const at = now();
  const original = await one<CommercialReceipt>(ctx.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=(SELECT record_id FROM module_erp_aliases WHERE profile_id=? AND module_id='mesas' AND record_kind='payment' AND component=?)", ctx.profile, ctx.profile, `payment:${row.id}`);
  const reversal = original ? await reverseReceiptStatements(ctx, original, actor.id, "manual_void", at) : [];
  const [update] = await batch(ctx.env, [
    [
      "UPDATE mesas_payments SET status='void',voided_by=?,voided_at=?,void_reason=? WHERE id=? AND profile_id=? AND status='ok'",
      [actor.id, at, reason, row.id, ctx.profile],
    ], commerceGuard,
    ...reversal,
    history(
      ctx,
      tab.id,
      "payment_void",
      actor.id,
      `Pagamento desfeito: ${PAY_LABELS[row.method as PayMethod]} ${pedido.money(row.amount_cents)} (${reason}).`,
      at,
    ),
    [
      "UPDATE mesas_tabs SET updated=? WHERE id=? AND profile_id=?",
      [at, tab.id, ctx.profile],
    ],
  ]);
  if (!update.meta.changes) throw conflict();
  await publish(
    ctx,
    "mesas.payment_voided",
    tab,
    {
      payment_id: row.id,
      method: row.method,
      amount_cents: row.amount_cents,
      reason,
      actor: actor.id,
    },
    `void:${row.id}`,
  );
  const after = await currentTabState(ctx, tab.id);
  return {
    payment: paymentView(after.payments.find((p) => p.id === row.id)),
    tab: after.tab,
  };
}

/**
 * POST mesas/tabs/:id/close {payments?: [{method, amount_cents,
 * tendered_cents?, note?}]}: registra os pagamentos que faltam e fecha a
 * conta. Só fecha pago (409 tab_unpaid com o que falta, sem gravar nada); a
 * mesa fica livre e os pedidos da cozinha ficam pagos.
 */
export async function closeTab(ctx: ModuleContext, actor: Actor, data: any, requestId: string = uid()) {
  await requireWaiter(ctx, actor);
  const closeScope = `f3-mesas-close:${ctx.profile}:${actor.id}`;
  const closeFingerprint = hash(data);
  const state = await currentTabState(ctx, data.id, { scope: closeScope, key: requestId });
  const tab = state.record;
  if (tab.close_fingerprint) {
    if (tab.close_fingerprint !== closeFingerprint) throw new ApiError(409, "idempotency_conflict", "Esta chave já identifica outro fechamento.");
    return { ...state.tab, payments: state.payments.map(paymentView) };
  }
  if (!isLive(tab.status)) throw closedTab(tab);
  const list = data.payments ?? [];
  requireValue(
    Array.isArray(list) && list.length <= 10,
    "payments: lista com até 10 pagamentos.",
  );
  let due = state.tab.bill.due_cents;
  const fresh: NewPayment[] = [];
  for (const [index, raw] of list.entries()) {
    const p = parsePayment(raw, due, list.length > 1 ? index : undefined);
    due -= p.amount_cents;
    fresh.push(p);
  }
  if (due > 0)
    throw new ApiError(
      409,
      "tab_unpaid",
      `Falta ${pedido.money(due)} para fechar a conta.`,
    );
  const bill = state.tab.bill;
  const paid =
    bill.paid_cents + fresh.reduce((sum, p) => sum + p.amount_cents, 0);
  const at = now();
  const receipts: CommercialReceipt[] = [];
  for (const [i, p] of fresh.entries()) receipts.push(tableReceiptData(ctx, tab.id, p, `${requestId}:${i}`, actor));
  const commerce = await tablePaymentPlan(ctx, tab, bill.service_cents, receipts, actor.id, state.orders);
  for (const [i, receipt] of receipts.entries()) commerce.append(...paymentAlias(ctx.profile, receipt, commercialId(ctx.profile, "mesas-payment", `${requestId}:${i}`)));
  const payments = fresh.map((p, i) => insertPayment(ctx, tab.id, p, actor.id, at, commercialId(ctx.profile, "mesas-payment", `${requestId}:${i}`)));
  const closingHistory = guardedHistory(ctx, tab.id, "closed", actor.id, `Conta fechada: ${pedido.money(bill.total_cents)}.`, at);
  // Históricos de cada recebimento e do fechamento permanecem distintos.
  // O primeiro ID valida o CAS; todos gravam no mesmo statement (até 10 pagamentos).
  closingHistory[0] += payments.map(() => ",(?,?,?,?,?,?,?)").join("");
  closingHistory[1].push(...payments.flatMap(rows => rows[1][1]));
  const [update] = await batch(ctx.env, compactReceiptWrites([
    guardedUpdate(ctx, tab, {
      status: "closed",
      subtotal_cents: bill.subtotal_cents,
      service_cents: bill.service_cents,
      total_cents: bill.total_cents,
      paid_cents: paid,
      closed_by: actor.id,
      closed_at: at,
      updated: at,
    }),
    closingHistory,
    ...payments.map(rows => rows[0]),
    ...commerce.statements(),
    ...pedido.settleTabOrderStatements(ctx.profile, tab.id, actor.id, at),
    ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [closeScope, requestId, closeFingerprint, JSON.stringify({ id: tab.id }), at]],
  ]));
  if (!update.meta.changes) throw conflict();

  const closed = await currentTabState(ctx, tab.id);
  const byMethod: Record<string, number> = {};
  for (const p of closed.payments.filter((x) => x.status === "ok"))
    byMethod[p.method] = (byMethod[p.method] || 0) + p.amount_cents;
  await publish(
    ctx,
    "mesas.tab_closed",
    tab,
    {
      subtotal_cents: bill.subtotal_cents,
      service_cents: bill.service_cents,
      total_cents: bill.total_cents,
      paid_cents: paid,
      payments: byMethod,
      order_ids: closed.orders
        .filter((o) => o.status !== "cancelled")
        .map((o) => o.id),
      guests: tab.guests,
      actor: actor.id,
    },
    `closed:${tab.id}`,
  );
  return {
    ...closed.tab,
    payments: closed.payments.map(paymentView),
  };
}

/**
 * POST mesas/tabs/:id/cancel {reason?}: cancela a conta aberta por engano.
 * Só sem pedido valendo e sem pagamento (409 tab_not_empty).
 */
export async function cancelTab(ctx: ModuleContext, actor: Actor, data: any) {
  await requireWaiter(ctx, actor);
  const tab = await liveTab(ctx, data.id);
  const state = await tabState(ctx, tab);
  if (state.tab.orders_count || state.tab.bill.paid_cents)
    throw new ApiError(
      409,
      "tab_not_empty",
      "A conta tem pedidos ou pagamentos. Cancele os pedidos na cozinha e desfaça os pagamentos antes, ou feche a conta.",
    );
  const reason =
    text(data.reason, 200, "o motivo") || "Conta aberta por engano.";
  const at = now();
  const commercial = new CommercePlan(ctx, actor.id, at);
  await serviceComponents(ctx, tab, 0, commercial);
  const [update] = await batch(ctx.env, [
    guardedUpdate(ctx, tab, {
      status: "cancelled",
      cancel_reason: reason,
      subtotal_cents: 0,
      service_cents: 0,
      total_cents: 0,
      paid_cents: 0,
      closed_by: actor.id,
      closed_at: at,
      updated: at,
    }),
    commerceGuard,
    history(ctx, tab.id, "cancelled", actor.id, reason, at),
    ...commercial.statements(),
  ]);
  if (!update.meta.changes) throw conflict();

  await publish(
    ctx,
    "mesas.tab_cancelled",
    tab,
    { reason, actor: actor.id },
    `cancelled:${tab.id}`,
  );
  return (await currentTabState(ctx, tab.id)).tab;
}

export { LIVE_STATUSES };

// Alias do recibo ao pagamento local, preservado ao juntar contas.
function paymentAlias(profile: string, receipt: CommercialReceipt, paymentId: string) {
  return aliasStatements(pedido.saleSource(profile, "mesas", receipt.source_id, `payment:${paymentId}`), "payment", receipt.receipt_key);
}
registerReceiptReverser("mesas", async (env, actor, original) => {
  const alias = await one(env, "SELECT component FROM module_erp_aliases WHERE profile_id=? AND module_id='mesas' AND record_kind='payment' AND record_id=?", original.profile_id, original.receipt_key);
  if (!alias) throw new ApiError(404, "not_found", "Pagamento não encontrado.");
  return voidPayment(modulesApi(env, original.profile_id, "mesas"), actor, { id: alias.component.slice("payment:".length), reason: "Anulação manual confirmada." });
});
