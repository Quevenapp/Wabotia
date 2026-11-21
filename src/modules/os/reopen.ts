// OS6: reabrir o orçamento aprovado que já gerou documento no ERP
// (docs/ORDEM-DE-SERVICO.md, "Reabrir orçamento").
//
// O ERP não volta um documento aprovado para análise (aprovado só segue para
// execução ou cancelamento, src/erp/domains/documents/module-policy.ts). Então
// reabrir com documento no ERP é a compensação da fase 3: a ordem atual é
// cancelada com o motivo (o evento "cancel" da fila cancela o pedido não
// faturado e as contas em aberto no ERP, e estorna o que a ordem lançou) e o
// orçamento continua numa ordem nova, em análise, ligada à antiga
// (os_order_links, migração 0191). Com nota autorizada, conta paga,
// recebimento registrado, cobrança em aberto ou envio com pendência, não
// reabre e diz em palavras o que fazer antes. Nada fica pela metade: o
// cancelamento é um lote só; a ordem nova sai com chave fixa e, se cair no
// meio, repetir o mesmo pedido termina o que faltou.
import { all, batch, one } from "../../db";
import { ApiError, type Actor, type Conversation, json, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { QuoteReopenPreview } from "./contracts";
import { money } from "./model";
import { authorizedOrder } from "./public";
import { checkVersion, mutationHistory } from "./mutations";
import { createOrder, loadOrder, moveOrder, reopenQuote, saveQuote } from "./store";
import { effectiveStage, snapshotType, workOrderAdditions } from "./work-types";
import { readWorkIntegration, stableQuoteItems } from "./commercial/projection";
import { receivedCents } from "./commercial/receipts";
import { requireCommercialWriter } from "./commercial/routes";
import { orderCancelled } from "./maintenance/schedule";

/** Situação de nota que ainda pode virar (ou já é) nota válida. */
const NOTE_DONE = ["cancelada", "rejeitada", "denegada"];
const NOTE_LABEL = { nfse: "nota de serviço (NFS-e)", nfe: "nota de peças (NF-e)" } as const;
/** Ordem antes do serviço ou em execução: depois de pronta, mudar é cancelar. */
const REOPENABLE = ["approved", "in_progress"];

/** O que existe no ERP para a ordem e o que reabrir faria. Só leitura (D1 da área). */
export async function reopenFacts(ctx: ModuleContext, row: any): Promise<QuoteReopenPreview> {
  const integration = await readWorkIntegration(ctx, row);
  const links = json(integration.source?.links_json, []) as Array<{ kind: string; id: string }>;
  const document = integration.linked || integration.events.some(e => JSON.parse(e.payload_json).eligible?.document);
  const titles = links.filter(l => l.kind === "title").length, settlements = links.filter(l => l.kind === "settlement").length;
  const open = integration.events.filter(e => e.state !== "done");
  const troubled = open.filter(e => ["uncertain", "waiting_manual"].includes(e.state) || e.unresolved || e.error_code);
  const [notes, received, charges] = await Promise.all([
    all(ctx.env, "SELECT kind,status,number FROM os_fiscal_notes WHERE profile_id=? AND order_id=? ORDER BY kind", ctx.profile, row.id),
    receivedCents(ctx, row.id),
    one(ctx.env, "SELECT count(*) n FROM payments WHERE profile_id=? AND module_id='os' AND ref_id=? AND status='created'", ctx.profile, row.id),
  ]);
  const blockers: string[] = [], effects: string[] = [];
  if (row.status !== "approved" && !(document && row.status === "in_progress"))
    blockers.push(row.status === "in_progress"
      ? "O serviço já começou e esta ordem não tem documento no ERP: para mudar o combinado, cancele a ordem com o motivo e abra uma nova."
      : "Só um orçamento aprovado (antes de iniciar o serviço, ou em execução com documento no ERP) pode ser reaberto.");
  // Sem documento no ERP, reabrir volta a mesma ordem para análise (como antes).
  if (document) {
    for (const note of notes) {
      const label = NOTE_LABEL[note.kind as "nfse" | "nfe"] ?? "nota fiscal";
      if (note.status === "autorizada") blockers.push(`Há ${label} autorizada${note.number ? ` (nº ${note.number})` : ""}: cancele a nota no bloco Notas fiscais da ordem antes de reabrir.`);
      else if (!NOTE_DONE.includes(note.status)) blockers.push(`A ${label} está em emissão (situação: ${note.status}): abra o bloco Notas fiscais, espere terminar e, se autorizar, cancele antes de reabrir.`);
    }
    if (settlements > 0) blockers.push("A conta a receber desta ordem já tem pagamento baixado no Financeiro: estorne o recebimento (Orçamento e recebimento → Estornar) antes de reabrir.");
    else if (received > 0) blockers.push(`Esta ordem tem ${money(received)} recebidos: estorne o recebimento (Orçamento e recebimento → Estornar) antes de reabrir.`);
    if (Number(charges?.n ?? 0) > 0) blockers.push("Há Pix ou link de pagamento em aberto desta ordem: espere vencer ou cancele a cobrança antes de reabrir, para o cliente não pagar a ordem antiga.");
    if (troubled.length) blockers.push("Um envio desta ordem para o ERP está com pendência: resolva no bloco Integração da ordem (tentar de novo) antes de reabrir.");
  }
  if (document) {
    effects.push("A ordem atual é cancelada com o seu motivo, e o documento dela no ERP é cancelado junto.");
    if (titles) effects.push(`${titles === 1 ? "A conta a receber em aberto" : `As ${titles} contas a receber em aberto`} desta ordem no Financeiro ${titles === 1 ? "é cancelada" : "são canceladas"}.`);
    if (integration.active.stock) effects.push("A baixa de estoque das peças desta ordem é estornada no ERP.");
    effects.push("O orçamento volta para análise numa ordem nova, ligada a esta, para enviar e aprovar de novo.");
  } else effects.push("O orçamento volta para análise nesta mesma ordem e precisa ser enviado e aprovado de novo.");
  const mode = blockers.length ? "blocked" : document ? "erp" : "local";
  return { id: row.id, version: row.row_version ?? 1, mode, can_reopen: !blockers.length,
    erp: { document: !!document, document_number: null, titles, stock_posted: integration.active.stock, settlements, pending_sends: open.length },
    notes: notes.map(n => ({ kind: n.kind, status: n.status, number: n.number ?? null })),
    received_cents: received, open_charges: Number(charges?.n ?? 0), effects, blockers };
}

/** GET service-orders/:id/quote/reopen */
export async function reopenPreview(ctx: ModuleContext, actor: Actor, id: string) {
  const { row } = await authorizedOrder(ctx, actor, id);
  return reopenFacts(ctx, row);
}

const reasonText = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(422, "reason_required", "Informe o motivo para reabrir o orçamento. Ele fica no histórico da ordem.");
  return Array.from(value.trim()).slice(0, 400).join("");
};

/** POST service-orders/:id/quote/reopen. undo_erp=true confirma desfazer no ERP. */
export async function reopenOrderQuote(ctx: ModuleContext, actor: Actor, id: string, data: any, key: string) {
  requireCommercialWriter(actor);
  ctx.access(actor, "conversations:write");
  const { row } = await authorizedOrder(ctx, actor, id, { write: true });
  if (data?.undo_erp !== true) return reopenQuote(ctx, row, data, actor.id, key);
  // Retomada: a ordem nova já existe.
  const done = await one(ctx.env, "SELECT other_id FROM os_order_links WHERE profile_id=? AND order_id=? AND kind='reopened_as'", ctx.profile, row.id);
  if (done) return loadOrder(ctx, done.other_id);
  const reason = reasonText(data.reason);
  let cancelled = row;
  if (row.status !== "cancelled") {
    checkVersion(row, data.version);
    const facts = await reopenFacts(ctx, row);
    if (facts.blockers.length) throw new ApiError(409, "quote_reopen_erp_blocked", `Não dá para reabrir agora. ${facts.blockers.join(" ")}`);
    if (facts.mode !== "erp") return reopenQuote(ctx, row, { version: data.version, reason }, actor.id, key);
    const type = snapshotType(row);
    const stage = type ? type.stages.find(s => s.base_status === "cancelled")?.id : undefined;
    if (type && !stage) throw new ApiError(409, "stage_required", "O modelo desta ordem não tem etapa de cancelamento: ajuste o modelo antes de reabrir.");
    // Mesmo caminho do cancelamento com motivo: o evento "cancel" da fila desfaz no ERP.
    cancelled = await moveOrder(ctx, row, "cancelled", actor.id, `Orçamento reaberto numa ordem nova: ${reason}`.slice(0, 500), {}, "status",
      { mutationKey: key, notify: false, stage, writeIntent: ["reopen_erp", reason] });
    await orderCancelled(ctx, row.id, actor.id).catch(error => console.warn("os6: cancelar agendamento", error));
  } else {
    const history = await mutationHistory(ctx, key);
    if (history?.order_id !== row.id) throw new ApiError(409, "quote_not_approved", "Esta ordem já está cancelada. Abra uma ordem nova para um novo orçamento.");
  }
  return continueInNewOrder(ctx, actor, cancelled, reason);
}

/** A ordem nova: mesmo cliente, objeto, campos e orçamento (em análise). */
async function continueInNewOrder(ctx: ModuleContext, actor: Actor, old: any, reason: string) {
  const type = snapshotType(old);
  const conversation = old.conversation_id ? await ctx.conversation(old.conversation_id).catch(() => null) as Conversation | null : null;
  const object = old.object_id ? await one(ctx.env, "SELECT id,row_version FROM os_objects WHERE profile_id=? AND id=? AND archived=0", ctx.profile, old.object_id) : null;
  if (old.object_id && !object) throw new ApiError(409, "object_required", "O objeto do serviço da ordem antiga foi arquivado: reative o objeto e repita Reabrir para terminar.");
  const fields = (type?.fields ?? []).filter(f => !f.sensitive).map(f => f.id), extra = json(old.extra_json, {}) as Record<string, unknown>;
  const { order } = await createOrder(ctx, {
    conversation: conversation && conversation.chat_type !== "group" ? conversation : null,
    type_id: old.type_id ?? "service_order",
    ...(object ? { object: { mode: "existing" as const, id: object.id, version: Number(object.row_version) } } : {}),
    contact_id: old.contact_id ?? undefined, authority: actor,
    extra: Object.fromEntries(Object.entries(extra).filter(([k]) => fields.includes(k))),
    customer_name: old.customer_name || undefined, phone: conversation ? undefined : old.phone || undefined,
    item: old.item, problem: old.problem, notes: old.notes || undefined, assignee: old.assignee || undefined, due_at: old.due_at || undefined,
    source: "panel", sourceKey: `reopen:${old.id}`, actor: actor.id, notify: false,
  });
  const display = workOrderAdditions(old).display_number;
  const at = now();
  await batch(ctx.env, [
    ["INSERT OR IGNORE INTO os_order_links(profile_id,order_id,kind,other_id,reason,actor,created) VALUES(?,?,'reopened_as',?,?,?,?)", [ctx.profile, old.id, order.id, reason, actor.id, at]],
    ["INSERT OR IGNORE INTO os_order_links(profile_id,order_id,kind,other_id,reason,actor,created) VALUES(?,?,'reopened_from',?,?,?,?)", [ctx.profile, order.id, old.id, reason, actor.id, at]],
    // Vínculos de catálogo seguem o id da linha, que a ordem nova conserva.
    [`INSERT OR IGNORE INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,version,updated_ms,updated_by)
      SELECT profile_id,module_id,record_kind,?,component,erp_item_id,1,?,? FROM module_erp_catalog_links WHERE profile_id=? AND module_id='os' AND record_kind='quote_item' AND record_id=?`,
      [order.id, at, actor.id, ctx.profile, old.id]],
    ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'quote',status,status,?,?,? FROM os_orders WHERE profile_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM os_history WHERE profile_id=? AND order_id=? AND kind='quote' AND note LIKE 'Orçamento reaberto da ordem %')",
      [uid(), ctx.profile, order.id, actor.id, `Orçamento reaberto da ordem ${display}: ${reason}`.slice(0, 500), at, ctx.profile, order.id, ctx.profile, order.id]],
  ]);
  const fresh = await loadOrder(ctx, order.id);
  if (!old.quote_items || fresh.quote_items) return fresh;
  const policy = snapshotType(fresh)?.features.quote;
  if (policy && !policy.source_stages.includes(effectiveStage(fresh))) return fresh;
  const items = stableQuoteItems(old).map(({ product_id: _, ...item }) => item);
  return saveQuote(ctx, fresh, { items, discount_cents: Number(old.quote_discount_cents ?? 0), valid_days: old.quote_valid_days ?? null, note: old.quote_note ?? "" },
    actor.id, `reopen-quote:${old.id}`, { notify: false, human: actor.kind === "user" });
}
