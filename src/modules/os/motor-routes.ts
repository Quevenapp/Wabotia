import { all } from "../../db";
import { ApiError, json, type Actor } from "../../types";
import { settingsRevision } from "../../service";
import { onCommand, onRead, onRoute, type ModuleContext } from "../api";
import { authorizedOrder, resolveWorkType } from "./public";
import { mayReadSensitive, projectOrderForCustomer, projectOrderForStaff, projectPrivateFields } from "./privacy";
import { checkVersion, commitOrderMutation, mutationHistory, publishMutation, versionConflict } from "./mutations";
import { cancelApproval, changeStage, decideStageApproval, requestStageApproval, sendStageApproval } from "./stages";
import { notify, quoteSpec, resumeBuiltinStatus, conversationOf, orderViewForActor } from "./store";
import { validateExtra } from "./validation";
import type { WorkTypeView } from "./contracts";
import { os2Read, os2Command, type Os2ReadOperation, type Os2CommandOperation } from "./os2-ports";

// I acrescenta estes códigos a definition.ts; o núcleo valida publicações.
export const MOTOR_EVENTS = ["os.updated", "os.stage_changed", "os.quote_saved", "os.stage_approval_requested", "os.stage_approval_decided", "os.private_fields_changed"] as const;
export const motorMutationKey = (actor: Actor, op: string, requestId: string) => `motor:${actor.id}:${op}:${requestId}`;

/** Retomada após confirmação D1 e falha de publicação/resposta. */
export async function replayOrderMutation(ctx: ModuleContext, actor: Actor, id: string, key: string, notifyCustomer = true) {
  const history = await mutationHistory(ctx, key);
  if (!history) return null;
  if (history.order_id !== id || history.entity_kind) throw versionConflict();
  const order = await authorizedOrder(ctx, actor, id, { write: true });
  await resumeOrderEffects(ctx, history, order.row, notifyCustomer);
  return order;
}
export async function resumeOrderEffects(ctx: ModuleContext, history: any, row: any, notifyCustomer = true) {
  if (history.kind === "status" && history.mutation_key) {
    await resumeBuiltinStatus(ctx, history, row, notifyCustomer);
    return;
  }
  const id = row.id;
  await publishMutation(ctx, history);
  if (history.from_status !== history.to_status)
    await ctx.publish("os.status_changed", id, { order_id: id, version: history.entity_version, from: history.from_status, to: history.to_status }, { key: `status:${id}:${history.entity_version}` });
  const changed: string[] = json(history.changed_fields_json, []);
  if (changed.includes("quote_version"))
    await ctx.publish("os.quoted", id, { order_id: id, version: history.entity_version }, { key: `quoted:${id}:${history.entity_version}` });
  if (changed.includes("decision") && ["approved", "declined"].includes(history.to_status))
    await ctx.publish(history.to_status === "approved" ? "os.approved" : "os.declined", id, { order_id: id, version: history.entity_version }, { key: `decision:${id}:${history.entity_version}` });
  if (row.row_version === history.entity_version && notifyCustomer) {
    if (history.kind === "os.stage_approval_requested") await sendStageApproval(ctx, row);
    else if ((history.kind === "os.stage_changed" || (history.kind === "os.quote_saved" && !changed.includes("quote_version"))) && history.from_stage !== history.to_stage) {
      await notify(ctx, row, "opened", `stage:${id}:${history.entity_version}`);
    }
    if (changed.includes("quote_version") && row.conversation_id) {
      const c = await conversationOf(ctx, row);
      if (c && c.chat_type !== "group") await ctx.sendInteractive(c, quoteSpec(row), { key: `quote:${id}:${row.quote_version}`, notification: true });
    }
  }
  if (history.to_status === "delivered" && history.from_status !== "delivered")
    await ctx.publish("os.delivered", id, { order_id: id, version: history.entity_version }, { key: `delivered:${id}:${history.entity_version}` });
}
async function typeView(ctx: ModuleContext, actor: Actor, type: WorkTypeView) {
  const bot = !!actor.via || actor.id.startsWith("bot:") || !!actor.module;
  const sensitive = !bot && await mayReadSensitive(ctx, actor);
  return { ...type, fields: type.fields.filter(f => f.sensitive ? sensitive : !bot || f.client_visible) };
}
export function registerMotorRoutes() {
  // Rotas estáveis, com autorização final de contato/objeto no adaptador.
  // Até sua instalação, toda funcionalidade nova falha fechada (501).
  const reads: Array<[string, Os2ReadOperation]> = [
    ["service-orders/object-types", "os.object_types.list"],
    ["service-orders/objects", "os.objects.list"],
    ["service-orders/objects/:object_id", "os.objects.get"],
    ["service-orders/objects/:object_id/private-fields", "os.objects.private.read"],
    ["service-orders/objects/:object_id/orders", "os.objects.orders"],
    ["service-orders/:id/requirements", "os.requirements"],
    ["service-orders/types/:type_id/field-index", "os.field_index.get"],
    ["service-orders/conversation/:id/objects", "os.conversation.objects.list"],
    ["service-orders/conversation/:id/objects/:object_id", "os.conversation.objects.get"],
  ];
  for (const [path, operation] of reads) onRead("os", path, async (ctx, actor, input) => {
    ctx.access(actor, "conversations:read");
    await ctx.requireEnabled();
    return os2Read(ctx, actor, operation, input);
  });
  const writes: Array<["POST" | "PATCH", string, Os2CommandOperation]> = [
    ["POST", "service-orders/objects", "os.objects.create"],
    ["PATCH", "service-orders/objects/:object_id", "os.objects.update"],
    ["POST", "service-orders/objects/:object_id/archive", "os.objects.archive"],
    ["PATCH", "service-orders/objects/:object_id/private-fields", "os.objects.private.update"],
    ["POST", "service-orders/:id/object-link", "os.object.link"],
    ["POST", "service-orders/types/:type_id/field-index/rebuild", "os.field_index.rebuild"],
  ];
  for (const [method, path, op] of writes) {
    onRoute("os", { method, path, op });
    onCommand("os", op, async (ctx, actor, data, meta) => {
      ctx.access(actor, "conversations:write");
      await ctx.requireEnabled();
      return os2Command(ctx, actor, op, data, meta);
    });
  }
  onRead("os", "service-orders/types", async (ctx, actor, { query }) => {
    ctx.access(actor, "conversations:read");
    if (query.include_archived === "1" && (actor.kind !== "user" || actor.via || actor.id.startsWith("bot:") || actor.module)) throw new ApiError(403, "forbidden", "Catálogo arquivado restrito à equipe.");
    const settings = await ctx.settings();
    const types: WorkTypeView[] = [await resolveWorkType(ctx), ...(settings.os_work_types ?? [])];
    return { data: await Promise.all(types.filter(t => !t.archived || query.include_archived === "1").map(t => typeView(ctx, actor, t))), settings_revision: await settingsRevision(ctx.env, ctx.profile) };
  });
  onRead("os", "service-orders/types/:type_id", async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    return typeView(ctx, actor, await resolveWorkType(ctx, params.type_id));
  });
  onRead("os", "service-orders/conversation/:id/orders/:order_id", async (ctx, actor, { params }) =>
    projectOrderForCustomer(ctx, actor, await authorizedOrder(ctx, actor, params.order_id, { conversation_id: params.id })));
  onRead("os", "service-orders/:id/private-fields", async (ctx, actor, { params }) =>
    projectPrivateFields(ctx, actor, await authorizedOrder(ctx, actor, params.id)));
  onRead("os", "service-orders/:id/history", async (ctx, actor, { params, query }) => {
    await authorizedOrder(ctx, actor, params.id);
    let cursor: any = null;
    if (query.cursor) {
      try { cursor = JSON.parse(atob(query.cursor)); } catch { throw new ApiError(400, "invalid_cursor", "Cursor inválido."); }
      if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== ctx.profile || cursor[1] !== params.id || !Number.isSafeInteger(cursor[2]) || typeof cursor[3] !== "string") throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit)) || 50));
    const rows = await all(ctx.env, `SELECT * FROM os_history WHERE profile_id=? AND order_id=?${cursor ? " AND (created>? OR (created=? AND id>?))" : ""} ORDER BY created,id LIMIT ?`, ctx.profile, params.id, ...(cursor ? [cursor[2], cursor[2], cursor[3]] : []), limit + 1);
    const page = rows.slice(0, limit);
    const bot = !!actor.via || actor.id.startsWith("bot:") || !!actor.module;
    return { data: page.map(h => ({ id: h.id, kind: h.kind, from_status: h.from_status, to_status: h.to_status, actor: !ctx.mayRead(actor, "contacts") && /^customer:\d+$/.test(h.actor) ? "customer" : h.actor, ...(ctx.mayRead(actor, "notes") && !bot ? { note: h.note } : {}), created: h.created, from_stage: h.from_stage, to_stage: h.to_stage, entity_kind: h.entity_kind, entity_id: h.entity_id, entity_version: h.entity_version, mutation_key: h.mutation_key, changed_fields: json(h.changed_fields_json, []) })), next_cursor: rows.length > limit ? btoa(JSON.stringify([ctx.profile, params.id, page.at(-1)!.created, page.at(-1)!.id])) : null };
  });
  for (const [path, op] of [["stage", "os.stage"], ["stage-approval", "os.stage.approval"], ["stage-approval/decision", "os.stage.decision"], ["private-fields", "os.private.update"]]) {
    onRoute("os", { method: path === "private-fields" ? "PATCH" : "POST", path: `service-orders/:id/${path}`, op });
    onCommand("os", op, async (ctx, actor, data, { requestId }) => {
      const order = await authorizedOrder(ctx, actor, data.id, { write: true });
      if (path === "private-fields" && !(await mayReadSensitive(ctx, actor))) throw new ApiError(403, "sensitive_forbidden", "Acesso sensível não autorizado.");
      const notifyCustomer = await ctx.mayNotify(actor, order.row.conversation_id);
      const key = motorMutationKey(actor, op, requestId);
      const replay = await replayOrderMutation(ctx, actor, data.id, key, notifyCustomer);
      if (replay) {
        if (path !== "private-fields") return orderViewForActor(ctx, actor, replay.row);
        const history = (await mutationHistory(ctx, key))!;
        return { id: data.id, version: history.entity_version, changed_fields: json(history.changed_fields_json, []) };
      }
      let row: any;
      if (path === "stage") row = await changeStage(ctx, order.row, data, actor.id, { notify: notifyCustomer, mutationKey: key });
      else if (path === "stage-approval") {
        if (!notifyCustomer) throw new ApiError(403, "forbidden", "Assuma a conversa antes de solicitar aprovação.");
        row = await requestStageApproval(ctx, order.row, data, actor.id, key);
      } else if (path === "stage-approval/decision") row = await decideStageApproval(ctx, order.row, data, actor.id, key, { notify: notifyCustomer });
      else {
        checkVersion(order.row, data.version);
        if (["delivered", "cancelled"].includes(order.row.status)) throw new ApiError(400, "immutable_field", "Trabalho encerrado: somente observações internas.");
        const values = validateExtra(order.type.fields, data.extra, { mode: "private", partial: true, previous: json(order.row.extra_json, {}) });
        const changed = Object.keys(data.extra);
        row = await commitOrderMutation(ctx, order.row, { extra_json: JSON.stringify(values), stage_approval_json: cancelApproval(order.row) }, actor.id, "os.private_fields_changed", changed, key);
        return { id: row.id, version: row.row_version, changed_fields: changed };
      }
      return orderViewForActor(ctx, actor, row);
    });
  }
}
