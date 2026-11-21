// OS6: checklist por etapa (docs/ORDEM-DE-SERVICO.md, "Checklist por etapa").
// O modelo define os itens de cada etapa (texto, obrigatório, foto
// obrigatória); a ordem guarda as marcações por etapa em checklist_json
// (migração 0190) e cada marcação entra no histórico. A etapa só avança com
// os obrigatórios marcados (e com a foto, quando pedida). Voltar etapa e
// cancelar nunca esperam o checklist.
import { one } from "../../db";
import { ApiError, type Actor, json } from "../../types";
import type { ModuleContext } from "../api";
import type { ChecklistMark, CustomWorkType, OrderChecklistStage } from "./contracts";
import { isBackward, type OsStatus } from "./model";
import { checkVersion, commitOrderMutation } from "./mutations";
import { authorizedOrder } from "./public";
import { effectiveStage, snapshotType } from "./work-types";

type Marks = Record<string, Record<string, ChecklistMark>>;
export const checklistMarks = (row: any): Marks => json(row.checklist_json, {});

/** Checklist das etapas que têm itens, na ordem das etapas do modelo fixado na ordem. */
export function orderChecklist(row: any, type: CustomWorkType | null = snapshotType(row)): OrderChecklistStage[] {
  if (!type) return [];
  const marks = checklistMarks(row), current = effectiveStage(row);
  return type.stages.filter(stage => stage.checklist?.length).map(stage => {
    const items = stage.checklist!.map(item => {
      const mark = marks[stage.id]?.[item.id];
      return { ...item, done: mark?.done === true, photo_document_id: mark?.photo_document_id ?? null, by: mark?.by ?? null, at: mark?.at ?? null };
    });
    const missing = items.filter(item => item.required && (!item.done || (item.photo_required && !item.photo_document_id)))
      .map(item => item.photo_required && item.done ? `${item.label} (falta a foto)` : item.photo_required ? `${item.label} (com foto)` : item.label);
    return { stage_id: stage.id, stage_label: stage.label, current: stage.id === current, items, missing };
  });
}

/**
 * Avançar para outra etapa pede o checklist da etapa atual completo.
 * Cancelar e voltar etapa (estado de base anterior) passam sempre.
 */
export function requireChecklist(row: any, targetStageId: string) {
  const type = snapshotType(row);
  if (!type) return;
  const current = effectiveStage(row);
  const target = type.stages.find(stage => stage.id === targetStageId);
  if (!target || target.id === current || target.base_status === "cancelled" || isBackward(row.status as OsStatus, target.base_status)) return;
  const stage = orderChecklist(row, type).find(entry => entry.stage_id === current);
  if (!stage?.missing.length) return;
  throw new ApiError(409, "checklist_required",
    `Antes de passar para "${target.label}", marque no checklist da etapa "${stage.stage_label}": ${stage.missing.join(", ")}.`);
}

/** Resumo para o cliente no acompanhamento pelo WhatsApp, só se o modelo disser. */
export function checklistCustomerSummary(row: any): string | null {
  const type = snapshotType(row);
  if (!type?.features.checklist_customer_summary) return null;
  const stage = orderChecklist(row, type).find(entry => entry.current);
  if (!stage) return null;
  const done = stage.items.filter(item => item.done);
  const lines = [`Checklist da etapa: ${done.length} de ${stage.items.length} itens feitos.`];
  if (done.length) lines.push(...done.slice(0, 10).map(item => `✓ ${item.label}`));
  return lines.join("\n");
}

/** Texto do checklist para o histórico e a impressão. */
export function checklistLines(row: any): string[] {
  return orderChecklist(row).flatMap(stage => [
    `${stage.stage_label}:`,
    ...stage.items.map(item => `${item.done ? "[x]" : "[ ]"} ${item.label}${item.required ? " (obrigatório)" : ""}${item.photo_document_id ? " · com foto" : ""}`),
  ]);
}

/** POST service-orders/:id/checklist: marca ou desmarca um item da etapa atual. */
export async function markChecklist(ctx: ModuleContext, actor: Actor, id: string, data: any, key: string) {
  ctx.access(actor, "conversations:write");
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  checkVersion(row, data?.version);
  if (["delivered", "cancelled"].includes(row.status)) throw new ApiError(409, "order_closed", "A ordem está encerrada: o checklist não muda mais.");
  const type = snapshotType(row);
  const stageId = effectiveStage(row);
  const stage = type?.stages.find(entry => entry.id === stageId);
  if (!stage?.checklist?.length) throw new ApiError(409, "checklist_unavailable", "A etapa atual desta ordem não tem checklist no modelo.");
  const item = stage.checklist.find(entry => entry.id === data?.item_id);
  if (!item) throw new ApiError(404, "not_found", "Item do checklist não encontrado na etapa atual. Atualize a ordem.");
  if (typeof data.done !== "boolean") throw new ApiError(400, "invalid_request", "Informe done: true para marcar ou false para desmarcar.");
  let photo: string | null = null;
  if (data.photo_document_id !== undefined && data.photo_document_id !== null) {
    if (typeof data.photo_document_id !== "string") throw new ApiError(400, "invalid_request", "Foto inválida.");
    const document = await one(ctx.env, "SELECT id,mime_type FROM os_documents WHERE profile_id=? AND order_id=? AND id=? AND state='ready' AND archived_at IS NULL",
      ctx.profile, row.id, data.photo_document_id);
    if (!document) throw new ApiError(404, "photo_not_found", "A foto não está nos documentos desta ordem. Anexe a foto em Documentos e escolha de novo.");
    if (!String(document.mime_type).startsWith("image/")) throw new ApiError(422, "photo_required", "O documento escolhido não é uma foto. Escolha uma imagem (JPG ou PNG).");
    photo = document.id;
  }
  if (data.done && item.photo_required && !photo) throw new ApiError(422, "photo_required", `"${item.label}" pede foto: anexe a foto em Documentos e escolha-a ao marcar.`);
  const marks = checklistMarks(row);
  marks[stage.id] = { ...(marks[stage.id] ?? {}), [item.id]: { done: data.done, photo_document_id: data.done ? photo : null, by: actor.id, at: Date.now() } };
  const note = `Checklist (${stage.label}): ${item.label} ${data.done ? "feito" : "desmarcado"}${data.done && photo ? " · com foto" : ""}`;
  return commitOrderMutation(ctx, row, { checklist_json: JSON.stringify(marks) }, actor.id, "os.checklist_marked", ["checklist"], key, note.slice(0, 500));
}
