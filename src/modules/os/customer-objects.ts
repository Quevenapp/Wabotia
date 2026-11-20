// Leituras de conversa e escolhas explícitas do formulário. Não há inventário
// automático por mensagem nem autorização por placa, telefone ou nome enviado.
import { all, one } from "../../db";
import { seal, unseal } from "../../security";
import { ApiError, now, type Actor, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import type { Page, Order, ServiceObjectView } from "./contracts";
import type { Os2ReadOperation, Os2RouteInput } from "./os2-ports";
import { workCustomerScope, type ServiceObjectRow, type WorkOrderRow } from "./public";
import { customerProjection } from "./privacy";
import { orderView } from "./store";
import { projectChannelObjectSnapshot, publicObjectView } from "./object-messages";

const notFound = () => new ApiError(404, "not_found", "Objeto não encontrado ou não acessível.");
const customerRequired = () => new ApiError(409, "customer_required", "A equipe precisa confirmar o titular da conversa. Solicite atendimento para continuar.");
const invalidCursor = () => new ApiError(400, "invalid_cursor", "Cursor inválido para esta consulta.");

export async function requireObjectCustomer(ctx: ModuleContext, conversation: Conversation) {
  if (conversation.profile_id !== ctx.profile || conversation.chat_type === "group") throw customerRequired();
  const scope = await workCustomerScope(ctx, conversation);
  if (!scope.contactId || !scope.verified || scope.sql === "0") throw customerRequired();
  const contact = await one<{ id: string }>(ctx.env,
    "SELECT id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active' AND merged_into IS NULL",
    ctx.profile, scope.contactId);
  if (!contact) throw customerRequired();
  return { contactId: contact.id, conversation };
}

export interface ObjectFormChoice { id: string; version: number; label: string }

/** Uma consulta de dados, limitada aos 30 ativos do tipo e titular comprovado. */
export async function objectFormChoices(ctx: ModuleContext, conversation: Conversation, typeId: string) {
  const { contactId } = await requireObjectCustomer(ctx, conversation);
  const rows = await all<ServiceObjectRow>(ctx.env,
    "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND type_id=? AND archived=0 ORDER BY created DESC,id DESC LIMIT 30",
    ctx.profile, contactId, typeId);
  return { contactId, choices: rows.map(row => {
    const view = publicObjectView(row);
    return { id: row.id, version: row.row_version, label: view.identifier };
  }) };
}

/** O mapa congelado indica o ID; esta leitura revalida o cadastro atual.
 * A abertura ainda precisa da guarda transacional no lote da ordem. */
export async function revalidateObjectChoice(ctx: ModuleContext, conversation: Conversation,
  selection: { contactId: string; typeId: string; id: string; version: number }): Promise<ServiceObjectRow> {
  const { contactId } = await requireObjectCustomer(ctx, conversation);
  if (contactId !== selection.contactId) throw notFound();
  const row = await one<ServiceObjectRow>(ctx.env,
    "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND type_id=? AND id=?",
    ctx.profile, contactId, selection.typeId, selection.id);
  if (!row) throw notFound();
  if (row.archived) throw new ApiError(409, "object_archived", "Este objeto foi arquivado. Peça à equipe para atualizar a seleção.");
  if (row.row_version !== selection.version) throw new ApiError(409, "version_conflict", "O cadastro mudou depois da emissão do link. Solicite um novo formulário.");
  return row;
}

type Position = { cut: number; last: [number, string] | null };
async function position(ctx: ModuleContext, scope: string, cursor?: string): Promise<Position> {
  const cut = now();
  if (!cursor) return { cut, last: null };
  try {
    if (cursor.length > 16000) throw invalidCursor();
    const value = await unseal(ctx.env, atob(cursor));
    if (value.scope !== scope || !Number.isSafeInteger(value.cut) || value.cut < 0 || value.cut > cut ||
        !Array.isArray(value.last) || value.last.length !== 2 ||
        !Number.isSafeInteger(value.last[0]) || value.last[0] < 0 || value.last[0] > value.cut ||
        typeof value.last[1] !== "string" || !value.last[1]) throw invalidCursor();
    return { cut: value.cut, last: value.last };
  } catch { throw invalidCursor(); }
}

async function nextCursor(ctx: ModuleContext, scope: string, cut: number, tail: { created: number; id: string } | undefined, more: boolean) {
  return more && tail ? btoa(await seal(ctx.env, { scope, cut, last: [tail.created, tail.id] })) : null;
}

/** Também é o adaptador de consulta os_objetos; o ator continua sujeito à
 * autorização de conversa do núcleo, inclusive bots presos à execução. */
export async function customerObjectsRead(ctx: ModuleContext, actor: Actor, operation: Os2ReadOperation, input: Os2RouteInput): Promise<unknown> {
  if (operation !== "os.conversation.objects.list" && operation !== "os.conversation.objects.get")
    throw new ApiError(501, "not_implemented", "Esta consulta não pertence ao canal de objetos.");
  ctx.access(actor, "conversations:read");
  ctx.access(actor, "contacts:read");
  await ctx.requireEnabled();
  const conversation = await ctx.conversation(input.params.id, actor);
  const { contactId } = await requireObjectCustomer(ctx, conversation);
  const { query } = input;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new ApiError(400, "invalid_request", "Informe um limite de 1 a 50 objetos ou ordens.");
  // Nenhum filtro enviado pode substituir o titular resolvido da conversa.
  if (Object.keys(query).some(key => !["type_id", "limit", "cursor"].includes(key)))
    throw new ApiError(400, "invalid_fields", "Use somente o tipo, limite e cursor desta consulta.");
  const scope = JSON.stringify(["os.channel.objects.v1", ctx.profile, contactId, conversation.id, conversation.session,
    actor.id, actor.sessionId, actor.role, actor.access, actor.profiles, actor.scopes, actor.via,
    operation, input.params.object_id ?? null, query.type_id ?? null, limit]);
  const { cut, last } = await position(ctx, scope, query.cursor);
  if (operation === "os.conversation.objects.list") {
    const rows = await all<ServiceObjectRow>(ctx.env,
      `SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND archived=0 AND created<=?
       ${query.type_id ? "AND type_id=?" : ""}
       ${last ? "AND (created<? OR (created=? AND id<?))" : ""}
       ORDER BY created DESC,id DESC LIMIT ?`,
      ctx.profile, contactId, cut, ...(query.type_id ? [query.type_id] : []), ...(last ? [last[0], last[0], last[1]] : []), limit + 1);
    const page = rows.slice(0, limit);
    const result: Page<ServiceObjectView> = { data: page.map(publicObjectView), next_cursor: await nextCursor(ctx, scope, cut, page.at(-1), rows.length > limit) };
    return result;
  }
  const row = await one<ServiceObjectRow>(ctx.env,
    "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND id=?",
    ctx.profile, contactId, input.params.object_id);
  if (!row) throw notFound();
  const object = publicObjectView(row);
  const completed = await one<{ id: string; number: number; delivered_at: number | null }>(ctx.env,
    "SELECT id,number,delivered_at FROM os_orders WHERE profile_id=? AND object_id=? AND contact_id=? AND status='delivered' ORDER BY delivered_at DESC,number DESC,id DESC LIMIT 1",
    ctx.profile, row.id, contactId);
  object.latest_completed = completed ?? null;
  const rows = await all<WorkOrderRow & { created: number }>(ctx.env,
    `SELECT * FROM os_orders WHERE profile_id=? AND object_id=? AND contact_id=? AND created<=?
     ${last ? "AND (created<? OR (created=? AND id<?))" : ""}
     ORDER BY created DESC,id DESC LIMIT ?`,
    ctx.profile, row.id, contactId, cut, ...(last ? [last[0], last[0], last[1]] : []), limit + 1);
  const page = rows.slice(0, limit);
  const orders: Page<Order> = {
    data: page.map(order => customerOrderFromRow(order)),
    next_cursor: await nextCursor(ctx, scope, cut, page.at(-1), rows.length > limit),
  };
  return { object, orders };
}

/** Compartilhável com os_situacao: aplica a máscara pública à cópia já lida,
 * sem buscar a ficha atual e sem adicionar consultas por ordem. */
export function customerOrderFromRow(row: WorkOrderRow): Order {
  const view = customerProjection(orderView({ ...row, object_id: null, object_snapshot_json: null }));
  const object = projectChannelObjectSnapshot(row, { kind: "customer" });
  if (object) view.object = object;
  return view;
}
