import { all, one } from "../../../db";
import { seal, unseal } from "../../../security";
import { settingsRevision } from "../../../service";
import { ApiError, json, now, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { ExtraValues, ObjectPrivateFields, Order, Page, ServiceObjectView } from "../contracts";
import type { ObjectAudience, Os2Adapters } from "../os2-ports";
import { customerProjection } from "../privacy";
import { authorizedOrder, type ServiceObjectRow, type WorkOrderRow } from "../public";
import { orderView, visibleOrder } from "../store";
import { validateObjectType } from "../validation";
import { snapshotType } from "../work-types";
import {
  authorizeObjectAccess, authorizeObjectContact, authorizeObjectConversation,
  objectMissing, requireObjectPrivateAccess,
} from "./access";
import {
  objectFieldAllowed, projectObjectSnapshot, projectObjectType, projectServiceObject,
} from "./projection";
import { objectCommand } from "./store";

const invalid = (message: string) => new ApiError(400, "invalid_fields", message);
const invalidCursor = () => new ApiError(400, "invalid_cursor", "Esta página não pertence à consulta atual. Reabra a lista.");

export function objectPageLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw invalid("Informe uma página de 1 a 50 registros.");
  if (typeof value === "string" && !/^\d{1,3}$/.test(value)) throw invalid("Informe uma página de 1 a 50 registros.");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid("Informe uma página de 1 a 50 registros.");
  return limit;
}

function archiveFlag(value: string | undefined): boolean {
  if (value !== undefined && value !== "0" && value !== "1") throw invalid("Informe 1 ou 0 para incluir cadastros arquivados.");
  return value === "1";
}

function actorScope(actor: Actor, audience: ObjectAudience) {
  return [actor.kind, actor.id, actor.sessionId ?? null, actor.keyId ?? null,
    actor.role, actor.profiles, actor.scopes, actor.access ?? null, actor.bots,
    actor.via ?? null, actor.module ?? null, actor.credential ?? null, audience];
}

interface PagePosition { cut: number; last: [number, string] | null }
async function pagePosition(ctx: ModuleContext, scope: string, cursor?: string): Promise<PagePosition> {
  const current = now();
  if (!cursor) return { cut: current, last: null };
  try {
    if (cursor.length > 16000) throw invalidCursor();
    const value = await unseal(ctx.env, atob(cursor));
    if (value.kind !== "os.objects.page.v1" || value.scope !== scope ||
        !Number.isSafeInteger(value.cut) || value.cut < 0 || value.cut > current ||
        !Array.isArray(value.last) || value.last.length !== 2 ||
        !Number.isSafeInteger(value.last[0]) || value.last[0] < 0 || value.last[0] > value.cut ||
        typeof value.last[1] !== "string" || !value.last[1] || value.last[1].length > 200) throw invalidCursor();
    return { cut: value.cut, last: value.last };
  } catch { throw invalidCursor(); }
}

async function nextCursor(ctx: ModuleContext, scope: string, cut: number, last: [number, string] | null) {
  return last ? btoa(await seal(ctx.env, { kind: "os.objects.page.v1", scope, cut, last })) : null;
}

export interface AuthorizedObjectOwner { contact_id: string; audience: ObjectAudience }
export interface ObjectPageInput {
  limit?: number | string;
  cursor?: string;
  type_id?: string;
  include_archived?: boolean;
  /** Distingue a ficha agregada da lista de seleção, inclusive seus cursores. */
  collection?: "objects" | "contact-profile" | "conversation";
}

/** O chamador autoriza o contato antes desta única consulta paginada. */
export async function listAuthorizedObjects(
  ctx: ModuleContext, actor: Actor, owner: AuthorizedObjectOwner, input: ObjectPageInput,
): Promise<Page<ServiceObjectView>> {
  const limit = objectPageLimit(input.limit);
  const typeId = input.type_id;
  if (typeId !== undefined && (!typeId || typeId.length > 64)) throw invalid("Informe um tipo de objeto válido.");
  const scope = JSON.stringify(["objects", ctx.profile, "team", owner.contact_id,
    actorScope(actor, owner.audience), input.collection ?? "objects", typeId ?? null,
    !!input.include_archived, limit]);
  const { cut, last } = await pagePosition(ctx, scope, input.cursor);
  const rows = await all<ServiceObjectRow>(ctx.env,
    `SELECT o.* FROM os_objects o WHERE o.profile_id=? AND o.contact_id=?
       ${typeId ? "AND o.type_id=?" : ""} ${input.include_archived ? "" : "AND o.archived=0"}
       AND o.created<=? ${last ? "AND (o.created<? OR (o.created=? AND o.id<?))" : ""}
       ORDER BY o.created DESC,o.id DESC LIMIT ?`,
    ctx.profile, owner.contact_id, ...(typeId ? [typeId] : []), cut,
    ...(last ? [last[0], last[0], last[1]] : []), limit + 1);
  const page = rows.slice(0, limit), tail = page.at(-1);
  return { data: page.map(row => projectServiceObject(row, owner.audience)),
    next_cursor: await nextCursor(ctx, scope, cut,
      rows.length > limit && tail ? [tail.created, tail.id] : null) };
}

/** ID opaco nunca substitui autorização de área e contato. */
export async function readAuthorizedObject(
  ctx: ModuleContext, actor: Actor, id: string, owner?: AuthorizedObjectOwner,
): Promise<{ row: ServiceObjectRow; owner: AuthorizedObjectOwner }> {
  if (!owner) await authorizeObjectAccess(ctx, actor);
  if (typeof id !== "string" || !id || id.length > 200) throw objectMissing();
  const row = await one<ServiceObjectRow>(ctx.env,
    `SELECT * FROM os_objects WHERE profile_id=? AND id=?${owner ? " AND contact_id=?" : ""}`,
    ctx.profile, id, ...(owner ? [owner.contact_id] : []));
  if (!row) throw objectMissing();
  const authorized = owner ?? await authorizeObjectContact(ctx, actor, row.contact_id);
  if (row.contact_id !== authorized.contact_id) throw objectMissing();
  return { row, owner: authorized };
}

/** Índice parcial de conclusão: uma etapa com rótulo parecido não é conclusão. */
export async function latestObjectCompletion(ctx: ModuleContext, row: ServiceObjectRow) {
  return one<{ id: string; number: number; delivered_at: number | null }>(ctx.env,
    `SELECT o.id,o.number,o.delivered_at FROM os_orders o
     WHERE o.profile_id=? AND o.object_id=? AND o.status='delivered' AND o.contact_id=?
       AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.profile_id=o.profile_id
         AND c.id=o.conversation_id AND c.external_namespace LIKE 'app:%')
     ORDER BY o.delivered_at DESC,o.number DESC,o.id DESC LIMIT 1`,
    ctx.profile, row.id, row.contact_id);
}

function historyOrder(ctx: ModuleContext, actor: Actor, row: WorkOrderRow, audience: ObjectAudience): Order {
  const type = snapshotType(row);
  let view: Order = visibleOrder(ctx, actor, orderView(row));
  if (audience.kind === "customer") view = customerProjection(view);
  // A política da IA é explícita e não muda os campos internos da ordem.
  // Os valores são sempre os persistidos naquela visita, nunca os atuais.
  if (type) {
    const fields = type.fields.filter(field => objectFieldAllowed(field, audience));
    const values = json(row.extra_json, {}) as ExtraValues;
    view.fields = structuredClone(fields);
    view.extra = Object.fromEntries(fields.filter(field => Object.hasOwn(values, field.id))
      .map(field => [field.id, values[field.id]]));
  }
  const object = projectObjectSnapshot(row, audience);
  if (object) view.object = object;
  else delete view.object;
  return view;
}

export async function listObjectOrders(
  ctx: ModuleContext, actor: Actor, row: ServiceObjectRow, audience: ObjectAudience,
  query: { limit?: number | string; cursor?: string },
): Promise<Page<Order>> {
  const limit = objectPageLimit(query.limit);
  const scope = JSON.stringify(["object-orders", ctx.profile, "team", row.contact_id,
    row.id, actorScope(actor, audience), limit]);
  const { cut, last } = await pagePosition(ctx, scope, query.cursor);
  const rows = await all<WorkOrderRow>(ctx.env,
    `SELECT o.* FROM os_orders o WHERE o.profile_id=? AND o.object_id=? AND o.contact_id=?
       AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.profile_id=o.profile_id
         AND c.id=o.conversation_id AND c.external_namespace LIKE 'app:%')
       AND o.created<=? ${last ? "AND (o.created<? OR (o.created=? AND o.id<?))" : ""}
       ORDER BY o.created DESC,o.id DESC LIMIT ?`,
    ctx.profile, row.id, row.contact_id, cut,
    ...(last ? [last[0], last[0], last[1]] : []), limit + 1);
  const page = rows.slice(0, limit), tail = page.at(-1);
  return { data: page.map(order => historyOrder(ctx, actor, order, audience)),
    next_cursor: await nextCursor(ctx, scope, cut,
      rows.length > limit && tail ? [Number(tail.created), tail.id] : null) };
}

export const readObjectRoute: Os2Adapters["read"] = async (ctx, actor, operation, { params, query }) => {
  if (operation === "os.object_types.list") {
    const audience = await authorizeObjectAccess(ctx, actor);
    const includeArchived = archiveFlag(query.include_archived);
    const settings = await ctx.settings();
    const types = (settings.os_object_types ?? []).map(validateObjectType);
    let privateDefinitions = false;
    try { await requireObjectPrivateAccess(ctx, actor); privateDefinitions = true; }
    catch (error) { if (!(error instanceof ApiError) || error.code !== "sensitive_forbidden") throw error; }
    return { data: types.filter((type: ReturnType<typeof validateObjectType>) => !type.archived || includeArchived)
      .map((type: ReturnType<typeof validateObjectType>) => ({
        ...projectObjectType(type, audience), archived: type.archived,
        retired_field_ids: audience.kind === "staff" || (audience.kind === "bot" && audience.ai_access?.enabled)
          ? [...type.retired_field_ids] : [],
        ...(privateDefinitions ? { fields: structuredClone(type.fields.filter(field =>
          field.sensitive || objectFieldAllowed(field, audience))) } : {}),
      })),
    settings_revision: await settingsRevision(ctx.env, ctx.profile) };
  }
  if (operation === "os.objects.list") {
    if (!query.contact_id) throw invalid("Selecione o contato para consultar seus objetos.");
    const owner = await authorizeObjectContact(ctx, actor, query.contact_id);
    return listAuthorizedObjects(ctx, actor, owner, {
      limit: query.limit, cursor: query.cursor, type_id: query.type_id,
      include_archived: archiveFlag(query.include_archived),
    });
  }
  if (operation === "os.conversation.objects.list" || operation === "os.conversation.objects.get") {
    // A seleção do titular vem somente da conversa autorizada.
    const owner = await authorizeObjectConversation(ctx, actor, params.id);
    if (query.contact_id !== undefined || query.phone !== undefined || query.include_archived !== undefined)
      throw invalid("O titular desta consulta é confirmado pela conversa.");
    if (operation === "os.conversation.objects.list") return listAuthorizedObjects(ctx, actor, owner,
      { limit: query.limit, cursor: query.cursor, type_id: query.type_id, collection: "conversation" });
    const { row } = await readAuthorizedObject(ctx, actor, params.object_id, owner);
    return { ...projectServiceObject(row, owner.audience),
      latest_completed: await latestObjectCompletion(ctx, row),
      orders: await listObjectOrders(ctx, actor, row, owner.audience, query) };
  }
  if (operation === "os.objects.get" || operation === "os.objects.private.read" || operation === "os.objects.orders") {
    const { row, owner } = await readAuthorizedObject(ctx, actor, params.object_id);
    if (operation === "os.objects.orders") return listObjectOrders(ctx, actor, row, owner.audience, query);
    if (operation === "os.objects.private.read") {
      await requireObjectPrivateAccess(ctx, actor);
      const type = validateObjectType(json(row.type_snapshot_json, null));
      const fields = type.fields.filter(field => field.sensitive);
      const values = json(row.values_json, {}) as ExtraValues;
      return { id: row.id, version: row.row_version, fields,
        values: Object.fromEntries(fields.filter(field => Object.hasOwn(values, field.id))
          .map(field => [field.id, values[field.id]])) } satisfies ObjectPrivateFields;
    }
    return { ...projectServiceObject(row, owner.audience),
      latest_completed: await latestObjectCompletion(ctx, row),
      orders: await listObjectOrders(ctx, actor, row, owner.audience, query) };
  }
  throw new ApiError(501, "not_implemented", "Esta operação pertence a outro adaptador do módulo.");
};

export const commandObjectRoute: Os2Adapters["command"] = async (ctx, actor, operation, data, meta) => {
  const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : undefined;
  if (operation === "os.objects.private.update" && conversationId) {
    await authorizeObjectConversation(ctx, actor, conversationId, { write: true });
    throw new ApiError(403, "sensitive_forbidden", "Campos privados não podem ser alterados pela conversa do cliente.");
  }
  const result = await objectCommand(ctx, actor, operation, data, meta);
  if (!result || typeof result !== "object" || !("id" in result) || !("version" in result) ||
      ("preview" in result && result.preview) || operation === "os.objects.private.update") return result;
  const id = String(result.id);
  // O recibo mantém a referência aceita. A ficha pode ter sido atualizada
  // depois; sua versão atual nunca recebe o número antigo do recibo.
  const mutation = { id, version: result.version };
  const conversationOwner = conversationId ? await authorizeObjectConversation(ctx, actor, conversationId) : undefined;
  if (operation === "os.object.link") {
    const order = await authorizedOrder(ctx, actor, id, { conversation_id: conversationId });
    if (!order.row.contact_id) throw objectMissing();
    const owner = conversationOwner ?? await authorizeObjectContact(ctx, actor, order.row.contact_id);
    if (owner.contact_id !== order.row.contact_id) throw objectMissing();
    return { ...historyOrder(ctx, actor, order.row, owner.audience), mutation };
  }
  if (["os.objects.create", "os.objects.update", "os.objects.archive"].includes(operation)) {
    const { row, owner } = await readAuthorizedObject(ctx, actor, id, conversationOwner);
    return { ...projectServiceObject(row, owner.audience), mutation };
  }
  return result;
};
