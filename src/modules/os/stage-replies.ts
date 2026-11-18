import { all, one } from "../../db";
import { ApiError, json, type Conversation } from "../../types";
import type { ModuleContext } from "../api";
import { phoneDigits } from "./model";
import { menuOpenSince } from "./store";
import { decideStageApproval } from "./stages";
import { resumeOrderEffects } from "./motor-routes";
import { mutationHistory } from "./mutations";

export async function handleStageReply(ctx: ModuleContext, c: Conversation, turn: { text: string; replyId?: string | null; rowId: string }) {
  if (c.chat_type === "group") return false;
  const button = /^os:stage:([^:]+):(\d+):(approve|decline)$/.exec(turn.replyId ?? "");
  if (turn.replyId && !turn.replyId.startsWith("os:stage:")) return false;
  const word = /^(aprovar|aprovo|aprovado|recusar|recuso|recusado)(?:\s+(etapa))?(?:\s+(?:a\s+)?(?:ordem\s+)?(?:n[o°º]?\s*)?(\d{1,10}))?[.!]*$/i.exec(turn.text.trim());
  const digit = /^[12]$/.test(turn.text.trim()) ? turn.text.trim() : null;
  if (!button && !word && !digit && !turn.replyId?.startsWith("os:stage:")) return false;
  const say = (text: string) => ctx.sendMessage(c, { text }, { key: `stage-reply:${turn.rowId}` });
  if (turn.replyId && !button) { await say("Esta aprovação não está mais disponível."); return true; }
  let row: any;
  if (button) row = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=? AND conversation_id=?", ctx.profile, button[1], c.id);
  else if (word?.[3]) {
    row = await one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND number=? AND (conversation_id=? OR (phone<>'' AND phone=?))", ctx.profile, Number(word[3]), c.id, phoneDigits(ctx.verifiedPhone(c) || ""));
    if (json(row?.stage_approval_json, null)?.state !== "pending" && !word[2]) return false;
  } else {
    const pending = await all(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND conversation_id=? AND (status='quoted' OR json_extract(stage_approval_json,'$.state')='pending') ORDER BY number", ctx.profile, c.id);
    const stages = pending.filter(r => json(r.stage_approval_json, null)?.state === "pending");
    if (!stages.length) return false;
    const menuSince = menuOpenSince(c);
    if (digit && menuSince !== null && menuSince > json(stages[0].stage_approval_json).requested_at) return false;
    const decisions = stages.length + (word?.[2] ? 0 : pending.filter(r => r.status === "quoted").length);
    if (decisions !== 1) {
      await say("Identifique a decisão: APROVAR ETAPA <número global> ou RECUSAR ETAPA <número global>. Para o orçamento, use o botão da proposta."); return true;
    }
    row = stages[0];
  }
  if (!row) { await say("Não encontramos este trabalho para esta conversa."); return true; }
  const approval = json(row.stage_approval_json, null);
  if (!button && !word?.[2] && row.status === "quoted" && approval?.state === "pending") {
    await say("Há orçamento e etapa aguardando resposta. Use o botão da proposta para o orçamento ou APROVAR ETAPA <número global> / RECUSAR ETAPA <número global> para a etapa.");
    return true;
  }
  const decision = button ? button[3] : digit ? digit === "1" ? "approve" : "decline" : word![1].toLowerCase().startsWith("aprov") ? "approve" : "decline";
  const key = `stage-reply:${c.id}:${turn.rowId}`;
  const previous = await mutationHistory(ctx, key);
  if (previous) { await resumeOrderEffects(ctx, previous, row); return true; }
  try {
    await decideStageApproval(ctx, row, { decision, approval_version: button ? Number(button[2]) : approval?.version, version: row.row_version }, `customer:${c.id}`, key);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await say(error.code === "approval_expired" ? "Esta aprovação venceu. Peça uma nova solicitação à equipe." : "Esta aprovação não está mais pendente. Consulte a mensagem mais recente.");
  }
  return true;
}
