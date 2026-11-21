// ERP pela conversa, a parte que roda no Coordinator da área (comando
// erp.conversa.enviar, chamado pela rota ./routes.ts depois das conferências
// do ERP): acha ou abre a conversa do número, confere de novo a regra do
// WhatsApp e põe a mensagem na fila de entrega de sempre (enqueue). O link
// público é o passo web do atendimento (src/web-steps.ts, página "track"),
// com validade e código que não se adivinha, e mostra só aquele documento.
// Carregado por src/modules/runtime.ts.
import { all, exec, one } from "../../db";
import { ApiError, json, now, type Actor, type Env } from "../../types";
import { registerCommand, registerWebStepPage } from "../../modules/hooks";
import { moduleStates } from "../../modules/registry";
import { conversation, conversationByPhone, enqueue, message, perform } from "../../service";
import { openWebStep, publicOrigin } from "../../web-steps";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ERP_CONVERSA_PARTS, type ErpConversaDocType } from "./contract.ts";
import { erpPath, formatPhone, LINK_TTL_MINUTES, withLink, type SendMode } from "./rules.ts";
import { assertCanWrite, decisionFor, lineConversation, sendView, whatsappLine, type SendRow } from "./service.ts";
import { attachChargesToConversation } from "./charges.ts";

const STEP_KIND = "documento";

async function mediaOf(env: Env, row: SendRow) {
  const ids: string[] = json(row.media_ids, []);
  if (!ids.length) return [];
  const rows = await all(env, "SELECT id,name,type,size FROM media WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))", row.profile_id, JSON.stringify(ids));
  return ids.map(id => rows.find(item => item.id === id)).filter(Boolean) as { id: string; name: string; type: string; size: number }[];
}

const modeOf = (mode: SendMode) => mode === "mensagem" ? "arquivo" : mode;

async function deliverSend(env: Env, actor: Actor, profile: string, row: SendRow, ttl: number, requestId: string) {
  const line = await whatsappLine(env, profile, row.connection_id);
  let c = await lineConversation(env, profile, row.phone, line.id);
  await assertCanWrite(env, actor, c);
  const media = await mediaOf(env, row);
  const purpose = row.doc_type === "conta" ? "billing" : "order";
  const decision = await decisionFor(env, profile, line, c, media.map(item => ({ size: Number(item.size) || 1 })), purpose, now());
  if (row.mode === "link_copiado" ? !decision.can_copy_link : decision.mode === "bloqueado" || modeOf(decision.mode) !== row.mode)
    throw new ApiError(409, "erp_conversa_changed", decision.mode === "bloqueado" && decision.reason ? decision.reason
      : "A conversa mudou desde a prévia (a janela de 24 horas abriu ou fechou). Abra o envio de novo para ver como ele sai agora.");
  if (!c) {
    // Conversa nova com o número, na linha oficial, atribuída a quem envia.
    c = await conversationByPhone(env, profile, row.phone, { open: true, connectionId: line.id, module: "erp" });
    if (!c) throw new ApiError(409, "erp_conversa_blocked", "Não deu para abrir a conversa com este número nesta linha.");
    if (!c.owner) await perform(env, actor, profile, "conversation.action", { id: c.id, action: "claim" }, `erp-conversa:${row.id}:claim`);
    c = await conversation(env, c.id, profile);
  }
  const dedupe = `erp-conversa:${row.id}`;
  let url = null as string | null, stepId = null as string | null;
  const step = async (deliver: boolean) => {
    const opened = await openWebStep(env, {
      conversation: c!, module: "erp", kind: STEP_KIND, ref: row.id, spec: { title: row.doc_label.slice(0, 120), fields: [], page: "track" },
      trigger: actor.via ? "bot" : "agent", actor: actor.id, sourceKey: dedupe, ttlMinutes: Math.min(LINK_TTL_MINUTES, Math.max(5, ttl || LINK_TTL_MINUTES)),
      text: row.text, button: "Ver documento", deliver,
    });
    stepId = opened.step.id;
    url = opened.url;
    return opened;
  };
  if (row.mode === "arquivo") await enqueue(env, c, actor.id, "text", { text: row.text, attachments: media.map(item => item.id) }, dedupe);
  else if (row.mode === "link") await step(true);
  else if (row.mode === "modelo") {
    // Fora da janela: o modelo de aviso da área ({{1}} e {{2}}), com o link
    // no texto e a finalidade do consentimento do cliente.
    const link = (await step(false)).url;
    if (!link) throw new ApiError(409, "erp_conversa_changed", "O link deste envio já foi criado. Abra o envio de novo.");
    await enqueue(env, c, actor.id, "notification", { text: withLink(row.text, link), consent_purpose: purpose }, dedupe);
  } else await step(false);
  // Cobrança da conta (Pix ou link da Cobrança): passa a ser desta conversa (nota e "Pagamento recebido").
  if (row.doc_type === "conta") await attachChargesToConversation(env, profile, row.doc_id, c.id);
  const at = now();
  await exec(env, "UPDATE erp_whatsapp_sends SET status=?,conversation_id=?,web_step_id=?,updated=? WHERE id=? AND status='preparado'",
    row.mode === "link_copiado" ? "link" : "enviado", c.id, stepId, at, row.id);
  // Na conversa, só para a equipe: o documento e o atalho para abri-lo no ERP
  // (o ERP confere a permissão de quem clicar).
  const origin = await publicOrigin(env);
  const shortcut = origin ? ` Abrir no ERP: ${origin}/app/erp${erpPath(row.doc_type as ErpConversaDocType, row.doc_id)}` : "";
  const did = row.mode === "link_copiado" ? "teve o link de leitura copiado" : "foi enviado pelo ERP";
  await message(env, c, "note", actor.id,
    `${row.doc_label} ${did} para ${formatPhone(row.phone)}${row.outside_record ? " (número fora do cadastro)" : ""}.${shortcut}`, [], `erp-conversa:${row.id}`);
  const saved = await one<SendRow>(env, "SELECT * FROM erp_whatsapp_sends WHERE id=?", row.id);
  return { envio: await sendView(env, saved!), url };
}

registerCommand("erp.conversa.enviar", async (env: Env, actor: Actor, profile: string, data: any, requestId: string) => {
  const row = typeof data?.envio_id === "string"
    ? await one<SendRow>(env, "SELECT * FROM erp_whatsapp_sends WHERE id=? AND profile_id=?", data.envio_id, profile) : null;
  // Só o envio que a rota preparou para esta mesma pessoa.
  if (!row || row.actor !== actor.id) throw new ApiError(404, "not_found", "Envio não encontrado. Abra o envio pelo documento no ERP.");
  if (row.status !== "preparado") return { envio: await sendView(env, row), url: null };
  try {
    return await deliverSend(env, actor, profile, row, Number(data.ttl_minutes) || LINK_TTL_MINUTES, requestId);
  } catch (error) {
    const reason = error instanceof ApiError ? error.message : "O envio não entrou na fila da conversa.";
    await exec(env, "UPDATE erp_whatsapp_sends SET status='falhou',error=?,updated=? WHERE id=? AND status='preparado'", reason.slice(0, 500), now(), row.id);
    throw error;
  }
});

/** O envio de um passo web do ERP, enquanto o link e a parte do documento valem. */
async function stepSend(env: Env, step: { id: string; profile_id?: string; module_id: string; kind: string; status: string; expires_at: number }, profile: string) {
  if (step.module_id !== "erp" || step.kind !== STEP_KIND || !["sent", "opened"].includes(step.status) || step.expires_at <= Date.now()) return null;
  const row = await one<SendRow>(env, "SELECT * FROM erp_whatsapp_sends WHERE profile_id=? AND web_step_id=?", profile, step.id);
  if (!row) return null;
  const part = ERP_CONVERSA_PARTS[row.doc_type as ErpConversaDocType];
  if (!part || erpPartOffMessage(part, erpRequirement(part), await moduleStates(env, profile))) return null;
  return row;
}

// Página pública do link: só o título, a situação, linhas curtas do próprio
// documento e o download dos arquivos dele. Nenhum outro dado da empresa ou
// do cliente (sem telefone, endereço ou outros documentos).
registerWebStepPage("erp", async (env: Env, profile: string, step: any) => {
  const row = await stepSend(env, step, profile);
  if (!row) return null;
  const page = json(row.page, {});
  const media = await mediaOf(env, row);
  return {
    title: String(page.title || row.doc_label), status_label: String(page.status_label || "Documento"),
    headline: typeof page.headline === "string" ? page.headline : null,
    lines: Array.isArray(page.lines) ? page.lines.filter((line: unknown) => typeof line === "string").slice(0, 6) : [],
    refresh_seconds: 0,
    links: media.map((item, index) => ({ label: item.type === "application/xml" ? "Baixar o XML" : "Baixar o documento (PDF)", href: `/api/w/{code}/arquivo/${index}` })),
  };
});

/** Arquivo do envio para GET /api/w/:code/arquivo/:n (src/index.ts), ou null. */
export async function erpConversaPublicFile(env: Env, step: any, index: number) {
  if (!step || !Number.isSafeInteger(index) || index < 0) return null;
  const row = await stepSend(env, step, step.profile_id);
  if (!row) return null;
  const id = json(row.media_ids, [])[index];
  return typeof id === "string" ? one(env, "SELECT * FROM media WHERE id=? AND profile_id=?", id, row.profile_id) : null;
}
