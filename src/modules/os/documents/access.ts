import { one } from "../../../db";
import type { Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import { authorizedOrder, workCustomerAllows } from "../public";
import { mayReadSensitive } from "../privacy";
import { fail, type DocumentRow } from "./model";

export interface DocumentAccess {
  private?: boolean;
  conversation_id?: string;
  write?: boolean;
  archived?: boolean;
}
export const customerCeiling = (actor: Actor) =>
  actor.kind !== "user" ||
  !!actor.via ||
  actor.id.startsWith("bot:") ||
  !!actor.module ||
  !!actor.credential;

export async function documentOrder(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
  access: DocumentAccess = {},
) {
  const order = await authorizedOrder(ctx, actor, id, access);
  if (access.conversation_id) {
    const c = await ctx.conversation(access.conversation_id, actor);
    if (!(await workCustomerAllows(ctx, c, order.row, true)))
      fail(404, "not_found");
  }
  if (access.private && !(await mayReadSensitive(ctx, actor)))
    fail(403, "sensitive_forbidden");
  if (!order.type.features.documents) fail(409, "feature_disabled");
  return order;
}

export async function loadDocument(
  ctx: ModuleContext,
  orderId: string,
  id: string,
) {
  const row = await one<DocumentRow>(
    ctx.env,
    "SELECT * FROM os_documents WHERE profile_id=? AND order_id=? AND id=?",
    ctx.profile,
    orderId,
    id,
  );
  if (!row) fail(404, "not_found");
  return row;
}

export async function authorizedDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  access: DocumentAccess = {},
) {
  const order = await documentOrder(ctx, actor, orderId, access);
  const row = await loadDocument(ctx, orderId, id);
  // Até um humano com papel usa a rota privada; a rota comum nunca revela sigilo.
  if (
    !!row.sensitive !== !!access.private ||
    (!access.archived && row.archived_at !== null)
  )
    fail(404, "not_found");
  if (
    (access.conversation_id || customerCeiling(actor)) &&
    (row.sensitive || !row.client_visible)
  )
    fail(404, "not_found");
  return { order, row };
}
