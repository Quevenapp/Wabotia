// Linha do tempo única da ficha: histórico de atendimento (conversas,
// protocolos, fila, formulários, check-in) mais ordens de serviço, agenda,
// pedidos, mensalidades, cobranças e vendas do ERP, em ordem de data.
// Cada fonte: uma consulta, corte (data, chave) aplicado ANTES do LIMIT e
// a mesma barreira de módulo/permissão do cartão separado correspondente.
// A falha de uma fonte vira aviso; as demais continuam.
import { all } from "../db";
import { allows } from "../access";
import { ApiError, now, type Actor, type Env } from "../types";
import { modulesApi, type ModuleContext } from "../modules/api";
import { moduleEnabled } from "../modules/registry";
import { erpRoleOf } from "../modules/erp/identity";
import { resourcesForRole } from "../erp/role-resources";
import { STATUS_LABELS } from "../modules/os/model";
import { projectOrderForStaff } from "../modules/os/privacy";
import { resolveWorkType, type WorkOrderRow } from "../modules/os/public";
import { snapshotType } from "../modules/os/work-types";
import type { HistoryItem } from "./contracts";
import type { TimelineFailureSource, TimelineItem, TimelinePage, TimelineSource } from "./profile-contracts";
import { historyTimelineSlice } from "./history";
import { contributionReadable } from "./profile";
import { customerProvider } from "./ports";
import { isFullCustomerEnabled } from "./feature";

export type { TimelineFailureSource, TimelineItem, TimelinePage, TimelineSource };

const MAX_LIMIT = 50;
const KEY = /^[a-z_]+:[\x21-\x7e]{1,400}$/;
/** Recusas que só significam "esta fonte não é para você agora". */
const silent = (e: unknown) => e instanceof ApiError &&
  (e.status === 403 || e.code === "module_disabled" || (e.status === 404 && e.code === "not_found"));
const invalid = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
const failures: Record<TimelineFailureSource, string> = {
  history: "Conversas, protocolos e formulários não puderam ser carregados agora. Tente de novo em instantes.",
  os: "Ordens de serviço não puderam ser carregadas agora. Tente de novo em instantes.",
  agenda: "Agendamentos não puderam ser carregados agora. Tente de novo em instantes.",
  pedido: "Pedidos não puderam ser carregados agora. Tente de novo em instantes.",
  mensalidade: "Mensalidades não puderam ser carregadas agora. Tente de novo em instantes.",
  payment: "Cobranças não puderam ser carregadas agora. Tente de novo em instantes.",
  erp: "Vendas e notas do ERP não puderam ser carregadas agora. Tente de novo em instantes.",
};
const historyTitles: Record<HistoryItem["kind"], string> = {
  conversation: "Atendimento", ticket: "Protocolo", queue: "Fila", form: "Formulário concluído", checkin: "Check-in",
};
const statusLabels: Record<string, Record<string, string>> = {
  history: { ai: "Com o assistente", human: "Com a equipe", bot: "Com o assistente", queued: "Na fila", closed: "Encerrado", waiting: "Aguardando",
    open: "Em aberto", pending: "Pendente", in_progress: "Em andamento", waiting_customer: "Aguardando o cliente", waiting_third: "Aguardando terceiros",
    resolved: "Resolvido", cancelled: "Cancelado", called: "Chamado", serving: "Em atendimento", done: "Concluído", no_show: "Não compareceu",
    completed: "Concluído", unknown: "—" },
  agenda: { booked: "Agendado", confirmed: "Confirmado", cancelled: "Cancelado", no_show: "Não compareceu", done: "Concluído", completed: "Concluído" },
  pedido: { awaiting_payment: "Aguardando pagamento", received: "Recebido", preparing: "Em preparo", ready: "Pronto",
    out_for_delivery: "Saiu para entrega", delivered: "Entregue", cancelled: "Cancelado" },
  mensalidade: { active: "Ativa", paused: "Pausada", ended: "Encerrada", open: "Em aberto", paid: "Paga", overdue: "Em atraso",
    cancelled: "Cancelada", waived: "Dispensada" },
  payment: { created: "Aguardando pagamento", paid: "Pago", expired: "Expirada", cancelled: "Cancelada", refunded: "Devolvida" },
  erp: { draft: "Em digitação", open: "Em aberto", confirmed: "Confirmada", approved: "Aprovada", invoiced: "Faturada",
    fulfilled: "Atendida", partially_fulfilled: "Atendida parcialmente", cancelled: "Cancelada", closed: "Encerrada" },
};
const label = (group: string, status: unknown) => typeof status === "string" ? statusLabels[group]?.[status] ?? null : null;
const cents = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const abs = Math.abs(value);
  return `${value < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

type Cursor = { before: number; key: string | null };
/** Corte (data, chave) em SQL, idêntico para todas as fontes. */
const cut = (at: string, key: string, cursor: Cursor) => cursor.key === null
  ? { sql: `${at}<?`, args: [cursor.before] as unknown[] }
  : { sql: `(${at}<? OR (${at}=? AND ${key}<?))`, args: [cursor.before, cursor.before, cursor.key] as unknown[] };
const after = (item: { occurredAt: number; key: string }, cursor: Cursor) => cursor.key === null
  ? item.occurredAt < cursor.before
  : item.occurredAt < cursor.before || (item.occurredAt === cursor.before && item.key < cursor.key);
const newest = (a: TimelineItem, b: TimelineItem) => b.occurredAt - a.occurredAt || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

export function timelineQuery(query: Record<string, string | undefined>) {
  const limit = query.limit === undefined ? 20 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) invalid("Limite inválido: use de 1 a 50 itens.");
  const ceiling = now() + 1;
  const before = query.before === undefined ? ceiling : /^\d{1,16}$/.test(query.before) ? Number(query.before) : NaN;
  if (!Number.isSafeInteger(before) || before < 1 || before > ceiling) invalid("Data de corte inválida. Recarregue o histórico.");
  const key = query.key === undefined || query.key === "" ? null : query.key;
  if (key !== null && !KEY.test(key)) invalid("Posição do histórico inválida. Recarregue o histórico.");
  return { limit, cursor: { before, key } as Cursor };
}

interface Slice { items: TimelineItem[]; incomplete?: boolean }
type Reader = (cursor: Cursor, limit: number) => Promise<Slice>;

function isPerson(actor: Actor) {
  return actor.kind === "user" && !actor.via && !actor.module && !actor.credential && !actor.id.startsWith("bot:") && !actor.bots.length;
}
/** Provedores dos cartões exigem leitura de conversas na área; recusa vira fonte ausente. */
function readsConversations(ctx: ModuleContext, actor: Actor) {
  try { ctx.access(actor, "conversations:read"); return true; }
  catch (e) { if (e instanceof ApiError && [403, 404].includes(e.status)) return false; throw e; }
}
// O cartão de Trabalhos só mostra ordens do namespace do contato.
const sameNamespace = `NOT EXISTS(SELECT 1 FROM conversations c WHERE c.profile_id=o.profile_id AND c.id=o.conversation_id
  AND (CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END)<>'team')`;

function osReader(env: Env, actor: Actor, profile: string, contactId: string): Reader {
  return async (cursor, limit) => {
    const ctx = modulesApi(env, profile, "os", { worker: true });
    const c = cut("t_at", "t_key", cursor);
    // Abertura vem da própria ordem (também as antigas, sem linha "opened");
    // mudanças vêm de os_history quando a etapa ou o estado realmente muda.
    const rows = await all<WorkOrderRow & Record<string, any>>(env, `SELECT * FROM (
        SELECT 'opened' t_event,o.created t_at,'os:o:'||o.id t_key,NULL t_to_status,NULL t_to_stage,o.*
          FROM os_orders o WHERE o.profile_id=? AND o.contact_id=? AND ${sameNamespace}
        UNION ALL
        SELECT CASE WHEN h.to_status='delivered' THEN 'delivered' ELSE 'stage' END,h.created,'os:h:'||h.id,h.to_status,h.to_stage,o.*
          FROM os_history h JOIN os_orders o ON o.id=h.order_id AND o.profile_id=h.profile_id
          WHERE h.profile_id=? AND o.contact_id=? AND ${sameNamespace} AND h.kind<>'opened'
            AND coalesce(h.to_stage,h.to_status) IS NOT NULL
            AND coalesce(h.to_stage,h.to_status) IS NOT coalesce(h.from_stage,h.from_status)
      ) WHERE ${c.sql} ORDER BY t_at DESC,t_key DESC LIMIT ?`,
      profile, contactId, profile, contactId, ...c.args, limit + 1);
    const types = new Map<string, Awaited<ReturnType<typeof resolveWorkType>>>();
    const items: TimelineItem[] = [];
    for (const row of rows) {
      const { t_event, t_at, t_key, t_to_status, t_to_stage, ...order } = row;
      let type = snapshotType(order) ?? types.get(order.type_id ?? "service_order");
      if (!type) { type = await resolveWorkType(ctx, order.type_id ?? "service_order"); types.set(order.type_id ?? "service_order", type); }
      // Mesma projeção do cartão: número e rótulos, sem item, relato ou notas.
      const view = projectOrderForStaff(ctx, actor, { row: order as WorkOrderRow, type });
      const name = `${type.labels.singular} ${view.display_number}`;
      const stage = t_to_stage ?? t_to_status;
      const stageLabel = stage ? type.stages.find(s => s.id === stage)?.label ?? STATUS_LABELS[t_to_status as keyof typeof STATUS_LABELS] ?? null : null;
      items.push({ source: "os", event: t_event, key: t_key, occurredAt: t_at,
        title: t_event === "opened" ? `${name} aberta` : t_event === "delivered" ? `${name} entregue` : `${name}: ${stageLabel ? `etapa ${stageLabel}` : "mudou de etapa"}`,
        status: t_event === "opened" ? null : t_to_status ?? null,
        statusLabel: t_event === "opened" ? null : stageLabel,
        target: { module: "os", resource: "service-orders", id: order.id } });
    }
    return { items };
  };
}

function agendaReader(env: Env, profile: string, contactId: string): Reader {
  return async (cursor, limit) => {
    const c = cut("created", "('agenda:'||id)", cursor);
    // Mesma regra do cartão: vínculo explícito e created (imutável) como data.
    const rows = await all(env, `SELECT id,status,starts,created FROM agenda_appointments
      WHERE profile_id=? AND contact_id=? AND ${c.sql} ORDER BY created DESC,('agenda:'||id) DESC LIMIT ?`,
    profile, contactId, ...c.args, limit + 1);
    return { items: rows.map(row => ({ source: "agenda" as const, event: "appointment", key: `agenda:${row.id}`, occurredAt: row.created,
      title: "Agendamento", scheduledAt: row.starts ?? null, status: row.status, statusLabel: label("agenda", row.status),
      target: { module: "agenda", resource: "appointments", id: row.id } })) };
  };
}

function pedidoReader(env: Env, profile: string, contactId: string): Reader {
  return async (cursor, limit) => {
    const c = cut("created", "('pedido:'||id)", cursor);
    const rows = await all(env, `SELECT id,number,status,total_cents,created FROM pedido_orders
      WHERE profile_id=? AND contact_id=? AND ${c.sql} ORDER BY created DESC,('pedido:'||id) DESC LIMIT ?`,
    profile, contactId, ...c.args, limit + 1);
    return { items: rows.map(row => ({ source: "pedido" as const, event: "order", key: `pedido:${row.id}`, occurredAt: row.created,
      title: `Pedido nº ${row.number}`, amount: cents(row.total_cents), status: row.status, statusLabel: label("pedido", row.status),
      target: { module: "pedido", resource: "orders", id: row.id } })) };
  };
}

function mensalidadeReader(env: Env, profile: string, contactId: string): Reader {
  return async (cursor, limit) => {
    const c = cut("t_at", "t_key", cursor);
    // Titular do pagamento ou interlocutor, como nos cartões de Assinaturas e Parcelas.
    const rows = await all(env, `SELECT * FROM (
        SELECT 'subscription' t_event,r.id,r.status,r.created t_at,'mensalidade:s:'||r.id t_key,NULL period_key,r.amount_cents
          FROM mensalidade_subscriptions r LEFT JOIN mensalidade_payers p ON p.id=r.payer_id AND p.profile_id=r.profile_id
          WHERE r.profile_id=? AND (r.contact_id=? OR p.contact_id=?)
        UNION ALL
        SELECT 'installment_paid',i.id,i.status,i.paid_at,'mensalidade:p:'||i.id,i.period_key,i.amount_cents
          FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id AND s.profile_id=i.profile_id
          LEFT JOIN mensalidade_payers p ON p.id=s.payer_id AND p.profile_id=s.profile_id
          WHERE i.profile_id=? AND i.paid_at IS NOT NULL AND (s.contact_id=? OR p.contact_id=?)
      ) WHERE ${c.sql} ORDER BY t_at DESC,t_key DESC LIMIT ?`,
    profile, contactId, contactId, profile, contactId, contactId, ...c.args, limit + 1);
    return { items: rows.map(row => {
      const period = /^(\d{4})-(\d{2})$/.exec(row.period_key ?? "");
      return { source: "mensalidade" as const, event: row.t_event, key: row.t_key, occurredAt: row.t_at,
        title: row.t_event === "subscription" ? "Assinatura iniciada" : `Mensalidade${period ? ` de ${period[2]}/${period[1]}` : ""} paga`,
        amount: cents(row.amount_cents), status: row.status, statusLabel: label("mensalidade", row.status),
        target: { module: "mensalidade", resource: row.t_event === "subscription" ? "subscriptions" : "installments", id: row.id } };
    }) };
  };
}

function paymentReader(env: Env, profile: string, contactId: string, skipMensalidade: boolean): Reader {
  return async (cursor, limit) => {
    const c = cut("t_at", "t_key", cursor);
    // Cobrança pertence à conversa: só conversas vinculadas a este contato, fora
    // de grupos e integrações. Módulos privados nunca entram; descrição não sai.
    const where = `p.profile_id=? AND l.contact_id=? AND c.chat_type<>'group' AND c.external_namespace NOT LIKE 'app:%'
      AND coalesce(p.module_id,'') NOT IN ('saude','ensino','juridico'${skipMensalidade ? ",'mensalidade'" : ""})`;
    const from = `payments p JOIN conversation_contacts l ON l.conversation_id=p.conversation_id AND l.profile_id=p.profile_id
      JOIN conversations c ON c.id=p.conversation_id AND c.profile_id=p.profile_id`;
    const rows = await all(env, `SELECT * FROM (
        SELECT 'charge' t_event,p.id,p.status,p.amount_cents,p.created t_at,'payment:c:'||p.id t_key FROM ${from} WHERE ${where}
        UNION ALL
        SELECT 'paid',p.id,p.status,p.amount_cents,p.paid_at,'payment:p:'||p.id FROM ${from} WHERE ${where} AND p.paid_at IS NOT NULL
      ) WHERE ${c.sql} ORDER BY t_at DESC,t_key DESC LIMIT ?`,
    profile, contactId, profile, contactId, ...c.args, limit + 1);
    return { items: rows.map(row => ({ source: "payment" as const, event: row.t_event, key: row.t_key, occurredAt: row.t_at,
      title: row.t_event === "paid" ? "Pagamento recebido" : "Cobrança enviada", amount: cents(row.amount_cents),
      status: row.status, statusLabel: label("payment", row.status), target: null })) };
  };
}

function erpReader(env: Env, actor: Actor, profile: string, contactId: string): Reader {
  return async (cursor, limit) => {
    const provider = customerProvider("erp");
    if (!provider?.list) throw new ApiError(503, "dependency_unavailable", "ERP indisponível.");
    // Mesma leitura do cartão Vendas (erp_catalog_contact_history), com carteira
    // e tipo de documento conferidos pelo ERP. A consulta só entrega as dez últimas.
    const page = await provider.list(modulesApi(env, profile, "erp", { worker: true }), actor, contactId, "sales", { limit: 100 });
    if (!Array.isArray(page?.items)) throw new ApiError(503, "dependency_unavailable", "Resposta ERP inválida.");
    const items: TimelineItem[] = [];
    for (const row of page.items) {
      const date = row.cells.occurredAt;
      const dateOnly = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
      // Mesma convenção da tela para datas sem hora (meio-dia UTC).
      const at = dateOnly ? Date.parse(`${date}T12:00:00Z`) : typeof date === "number" ? date : NaN;
      if (!Number.isSafeInteger(at)) continue;
      const total = typeof row.cells.total === "string" && /^-?\d+(\.\d+)?$/.test(row.cells.total) ? row.cells.total
        : typeof row.cells.total === "number" && Number.isFinite(row.cells.total) ? row.cells.total.toFixed(2) : null;
      const item: TimelineItem = { source: "erp", event: "sale", key: `erp:${row.id}`, occurredAt: at, ...(dateOnly ? { dateOnly } : {}),
        title: row.cells.id != null ? `Venda nº ${row.cells.id}` : "Venda", amount: total,
        status: typeof row.cells.status === "string" ? row.cells.status : null, statusLabel: label("erp", row.cells.status),
        target: { module: "erp", resource: "sales_orders", id: row.target.id } };
      if (after(item, cursor)) items.push(item);
    }
    return { items: items.sort(newest).slice(0, limit + 1) };
  };
}

/** Fontes que este ator pode ver nesta área, decididas antes de qualquer leitura. */
async function readers(env: Env, actor: Actor, profile: string, contact: { id: string; namespace: string; erp_contact_id: string | null }) {
  const list: [TimelineFailureSource, Reader][] = [];
  // Módulos agregados só existem na ficha team (os cartões também).
  if (contact.namespace !== "team" || !isPerson(actor)) return list;
  const gate = async (moduleId: string, contributionId: string) =>
    await contributionReadable(env, actor, profile, moduleId, contributionId) &&
    readsConversations(modulesApi(env, profile, moduleId, { worker: true }), actor);
  const [os, agenda, pedido, mensalidade] = await Promise.all([
    gate("os", "works"), gate("agenda", "appointments"), gate("pedido", "orders"), gate("mensalidade", "installments"),
  ]);
  if (os) list.push(["os", osReader(env, actor, profile, contact.id)]);
  if (agenda) list.push(["agenda", agendaReader(env, profile, contact.id)]);
  if (pedido) list.push(["pedido", pedidoReader(env, profile, contact.id)]);
  if (mensalidade) list.push(["mensalidade", mensalidadeReader(env, profile, contact.id)]);
  // Cobrança não tem cartão: módulo ligado, acesso a Cobrança e às conversas.
  if (allows(actor, "payments") && allows(actor, "conversations") && await moduleEnabled(env, profile, "payments"))
    list.push(["payment", paymentReader(env, profile, contact.id, mensalidade)]);
  // ERP: mesma barreira do cartão Vendas (cadastro completo, papel com contatos e pedidos de venda).
  if (contact.erp_contact_id && allows(actor, "erp") && resourcesForRole(erpRoleOf(actor)).includes("contacts") &&
      await isFullCustomerEnabled(env, profile) && await contributionReadable(env, actor, profile, "erp", "sales"))
    list.push(["erp", erpReader(env, actor, profile, contact.id)]);
  return list;
}

/**
 * GET contacts/:id/timeline?limit=20&before=<ms>&key=<chave>.
 * O chamador já autorizou o cadastro (contacts:read) e resolveu o ID canônico.
 */
export async function customerTimeline(env: Env, actor: Actor, profile: string,
  contact: { id: string; namespace: string; erp_contact_id: string | null }, query: Record<string, string | undefined>): Promise<TimelinePage> {
  if (!isPerson(actor)) throw new ApiError(403, "forbidden", "A linha do tempo da ficha exige uma pessoa autenticada.");
  const { limit, cursor } = timelineQuery(query);
  const sources = await readers(env, actor, profile, contact);
  const unavailable: TimelinePage["unavailable"] = [];
  let incomplete = false;
  const run = async (source: TimelineFailureSource, read: () => Promise<Slice>): Promise<TimelineItem[]> => {
    try {
      const slice = await read();
      incomplete ||= !!slice.incomplete;
      return slice.items;
    } catch (e) {
      // Sem permissão, módulo desligado ou registro fora do alcance: a fonte some, sem aviso.
      if (silent(e)) return [];
      unavailable.push({ source, message: failures[source] });
      return [];
    }
  };
  const slices = await Promise.all([
    run("history", async () => {
      const page = await historyTimelineSlice(env, actor, profile, contact.id, cursor, limit);
      return { incomplete: page.incomplete, items: page.items.map(item => ({ source: item.kind, event: item.kind, key: item.sourceKey,
        occurredAt: item.occurredAt, title: historyTitles[item.kind], status: item.status, statusLabel: label("history", item.status),
        target: item.target })) };
    }),
    ...sources.map(([source, read]) => run(source, () => read(cursor, limit))),
  ]);
  // Cada fonte trouxe até limit+1 itens após o corte: os primeiros `limit` da
  // junção estão sempre entre eles, e o excedente indica a próxima página.
  const merged = slices.flat().filter(item => after(item, cursor)).sort(newest);
  const items = merged.slice(0, limit), tail = items.at(-1);
  return { items, incomplete, unavailable,
    nextCursor: merged.length > limit && tail ? { before: tail.occurredAt, key: tail.key } : null };
}
