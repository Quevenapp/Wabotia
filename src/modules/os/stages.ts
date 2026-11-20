import { ApiError, json, now } from "../../types";
import type { ModuleContext } from "../api";
import type { PendingStageApproval } from "./contracts";
import { endOfDayAfter, type OsStatus } from "./model";
import { checkVersion, commitOrderMutation } from "./mutations";
import { builtinWorkType, effectiveStage, snapshotType } from "./work-types";
import { changeStatus, customMessage, notify, conversationOf } from "./store";
import { replayWorkWrite, workWriteReceipt } from "./commercial/mutations";
import { prepareOrderRulesMutation } from "./os2-ports";

function stageNote(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Array.from(value.trim()).length > 500)
    throw new ApiError(400, "invalid_request", "Nota: até 500 caracteres.");
  return value.trim();
}
export const stageError = (code = "invalid_transition") => new ApiError(409, code, "Ação indisponível nesta etapa. Atualize o trabalho.");
export function cancelApproval(row: any) {
  const pending = json(row.stage_approval_json, null) as PendingStageApproval | null;
  return pending?.state === "pending" ? JSON.stringify({ ...pending, state: "cancelled", decided_at: now() }) : row.stage_approval_json ?? null;
}
export function customQuotePolicy(row: any) {
  const type = snapshotType(row);
  if (type && !type.features.quote) throw stageError("feature_disabled");
  return type?.features.quote ?? null;
}
export async function customStatus(ctx: ModuleContext, row: any, status: OsStatus, actor: string, options: { notify?: boolean; mutationKey?: string; note?: string; writeIntent?: unknown }) {
  const type = snapshotType(row)!;
  const choices = type.transitions.filter(t => t.from === effectiveStage(row) && type.stages.find(s => s.id === t.to)?.base_status === status);
  if (!choices.length) throw stageError();
  if (choices.length !== 1 || status === row.status || choices[0].kind !== "manual") throw stageError("stage_required");
  return customMove(ctx, row, status, actor, {}, "status", { ...options, stage: choices[0].to });
}
export async function customMove(ctx: ModuleContext, row: any, to: OsStatus, actor: string, extra: Record<string, any>, kind: "status" | "quote", options: { notify?: boolean; mutationKey?: string; stage?: string; note?: string; writeIntent?: unknown }) {
  const intent = options.writeIntent ?? ["custom_move", to, extra, kind, options.stage ?? null, options.note ?? null];
  const replay = await replayWorkWrite(ctx, row, options.mutationKey, intent);
  if (replay) return replay;
  const type = snapshotType(row)!;
  const policy = type.features.quote;
  const dest = options.stage ?? (kind === "quote" && to === "analyzing" ? policy?.edited_stage : to === "quoted" ? policy?.sent_stage : to === "approved" ? policy?.approved_stage : to === "declined" ? policy?.declined_stage : undefined);
  const stage = type.stages.find(s => s.id === dest && s.base_status === to);
  if (!stage) throw stageError("stage_required");
  const at = now();
  const sets: Record<string, unknown> = { ...extra, status: to, stage: stage.id, stage_approval_json: extra.stage_approval_json ?? cancelApproval(row) };
  if (to !== row.status) {
    sets.pickup_reminded_at = null;
    if (to === "ready") sets.ready_at = at;
    if (to === "delivered") {
      sets.delivered_at = at;
      sets.warranty_until = type.features.warranty_days ? endOfDayAfter(at, type.features.warranty_days) : null;
    }
  }
  const next = await commitOrderMutation(ctx, row, sets, actor, kind === "quote" ? "os.quote_saved" : "os.stage_changed", ["stage", ...Object.keys(extra).filter(k => k !== "stage_approval_json")], options.mutationKey, stageNote(options.note), workWriteReceipt(ctx, row, options.mutationKey, intent, at));
  if (row.status !== to)
    await ctx.publish("os.status_changed", row.id, { order_id: row.id, version: next.row_version, from: row.status, to }, { key: `status:${row.id}:${next.row_version}` });
  // O protocolo de orçamento produz a sua própria notificação.
  if (options.notify !== false && (kind !== "quote" || to !== "quoted") && effectiveStage(row) !== stage.id)
    await notify(ctx, next, "opened", `stage:${row.id}:${next.row_version}`);
  if (to === "delivered" && row.status !== to)
    await ctx.publish("os.delivered", row.id, { order_id: row.id, version: next.row_version }, { key: `delivered:${row.id}:${next.row_version}` });
  return next;
}
export async function changeStage(ctx: ModuleContext, row: any, data: any, actor: string, options: { notify?: boolean; mutationKey?: string } = {}) {
  const intent = ["stage", data];
  const replay = await replayWorkWrite(ctx, row, options.mutationKey, intent);
  if (replay) return replay;
  checkVersion(row, data.version);
  const type = snapshotType(row);
  if (!type) {
    const transition = builtinWorkType().transitions.find(t => t.id === data.transition_id && t.from === effectiveStage(row));
    if (!transition) throw stageError();
    return changeStatus(ctx, row, transition.to, actor, data.note, { ...options, stage: transition.to, writeIntent: intent });
  }
  const transition = type.transitions.find(t => t.id === data.transition_id && t.from === effectiveStage(row));
  if (!transition) throw stageError();
  if (transition.kind !== "manual") throw stageError("approval_required");
  return customMove(ctx, row, type.stages.find(s => s.id === transition.to)!.base_status, actor, {}, "status", { ...options, stage: transition.to, note: stageNote(data.note), writeIntent: intent });
}
export async function requestStageApproval(ctx: ModuleContext, row: any, data: any, actor: string, key?: string) {
  checkVersion(row, data.version);
  const type = snapshotType(row);
  const transition = type?.transitions.find(t => t.id === data.transition_id && t.from === effectiveStage(row));
  if (!transition || transition.kind !== "customer_approval") throw stageError();
  const target = type!.stages.find(s => s.id === transition.to)!;
  await prepareOrderRulesMutation(ctx, { row, type: type!, sets: { stage: target.id, status: target.base_status }, actor, preview: true });
  const old = json(row.stage_approval_json, null) as PendingStageApproval | null;
  if (old?.state === "pending" && old.expires_at > now()) throw stageError("approval_pending");
  if (!row.conversation_id) throw stageError("no_conversation");
  const c = await conversationOf(ctx, row);
  if (!c || c.chat_type === "group") throw stageError("no_conversation");
  const at = now();
  const approval: PendingStageApproval = { version: (row.row_version ?? 1) + 1, transition_id: transition.id, from_stage: transition.from, to_stage: transition.to, state: "pending", requested_at: at, expires_at: at + transition.valid_hours * 3600000, decided_at: null, decided_by: null };
  const next = await commitOrderMutation(ctx, row, { stage_approval_json: JSON.stringify(approval) }, actor, "os.stage_approval_requested", ["stage_approval"], key);
  await sendStageApproval(ctx, next);
  return next;
}
export async function sendStageApproval(ctx: ModuleContext, row: any) {
  const approval = json(row.stage_approval_json, null) as PendingStageApproval | null;
  if (approval?.state !== "pending" || !row.conversation_id || approval.expires_at <= now()) return;
  const transition = snapshotType(row)?.transitions.find(t => t.id === approval.transition_id);
  if (transition?.kind !== "customer_approval") return;
  const c = await conversationOf(ctx, row);
  if (!c || c.chat_type === "group") return;
  await ctx.sendInteractive(c, {
    type: "list", body: customMessage(transition.request_text, row, 1024) || `Autoriza a etapa ${transition.label}?`, button: "Responder",
    sections: [{ rows: (["approve", "decline"] as const).map(decision => ({ id: `os:stage:${row.id}:${approval.version}:${decision}`, title: decision === "approve" ? "Aprovar" : "Recusar" })) }],
  }, { key: `stage-approval:${row.id}:${approval.version}`, notification: true });
}
export async function decideStageApproval(ctx: ModuleContext, row: any, data: any, actor: string, key?: string, options: { notify?: boolean } = {}) {
  checkVersion(row, data.version);
  if (!["approve", "decline"].includes(data.decision)) throw new ApiError(400, "invalid_request", "Decisão inválida.");
  const approval = json(row.stage_approval_json, null) as PendingStageApproval | null;
  if (!approval || approval.version !== data.approval_version || approval.state !== "pending" || effectiveStage(row) !== approval.from_stage) throw stageError("approval_not_pending");
  if (approval.expires_at <= now()) {
    await commitOrderMutation(ctx, row, { stage_approval_json: JSON.stringify({ ...approval, state: "expired" }) }, actor, "os.stage_approval_decided", ["stage_approval"], key);
    throw stageError("approval_expired");
  }
  const decided = { ...approval, state: data.decision === "approve" ? "approved" : "declined", decided_at: now(), decided_by: actor };
  if (data.decision === "decline") return commitOrderMutation(ctx, row, { stage_approval_json: JSON.stringify(decided) }, actor, "os.stage_approval_decided", ["stage_approval"], key);
  const type = snapshotType(row)!;
  const target = type.stages.find(s => s.id === approval.to_stage)!;
  return customMove(ctx, row, target.base_status, actor, { stage_approval_json: JSON.stringify(decided) }, "status", { ...options, stage: target.id, mutationKey: key });
}
