import { ApiError, type Actor } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import { authorizedOrder } from "../os/public";
import { mayReadSensitive } from "../os/privacy";

export const motorContext = (ctx: ModuleContext) => modulesApi(ctx.env, ctx.profile, "os");
export async function staff(ctx: ModuleContext, actor: Actor, write = false, role: "lawyer" | "curator" | "either" = "lawyer") {
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  await ctx.requireEnabled();
  await motorContext(ctx).requireEnabled();
  if (!(await mayReadSensitive(ctx, actor))) throw new ApiError(403, "sensitive_forbidden", "Acesso jurídico exige pessoa autenticada e o papel os:sensitive.");
  const allowed = role === "either"
    ? (await ctx.granted(actor, "lawyer")) || (await ctx.granted(actor, "curator"))
    : await ctx.granted(actor, role);
  if (!allowed) throw new ApiError(403, "forbidden", "Papel jurídico necessário para esta operação.");
}
export async function parent(ctx: ModuleContext, actor: Actor, id: string, write = false) {
  const order = await authorizedOrder(motorContext(ctx), actor, id, { write });
  if (!order.type.features.tasks) throw new ApiError(409, "feature_disabled", "Ative tarefas no tipo de trabalho antes de controlar prazos.");
  return order;
}
export async function assignees(ctx: ModuleContext, actor: Actor) {
  await staff(ctx, actor);
  const sensitive = new Set((await motorContext(ctx).grantees("sensitive")).map(p => p.id));
  return { data: (await ctx.grantees("lawyer")).filter(p => sensitive.has(p.id)) };
}
