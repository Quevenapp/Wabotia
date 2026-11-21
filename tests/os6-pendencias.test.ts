// OS6: as pontas da ordem de serviço (docs/ORDEM-DE-SERVICO.md): reabrir
// orçamento que já gerou documento no ERP, estorno do recebimento, checklist
// por etapa, motivo em cancelar e voltar etapa, ordem antiga do ERP e bots.
// Contra o ERP simulado da fase 3; nenhuma chamada a provedor, banco ou rede.
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, uid, type Actor } from "../src/types";
import type { ModuleContext } from "../src/modules/api";
import type { CustomWorkType } from "../src/modules/os/contracts";
import type { IntegrationEvent } from "../src/integrations/contracts";
import { createOrder, saveQuote, sendQuote, decide, changeStatus, loadOrder } from "../src/modules/os/store";
import { builtinWorkType } from "../src/modules/os/work-types";
import { validateWorkType } from "../src/modules/os/validation";
import { isBackward, needsMoveReason } from "../src/modules/os/model";
import { osModule } from "../src/modules/os/definition";
import { changeStage, requireMoveReason } from "../src/modules/os/stages";
import { patchWorkCommercial } from "../src/modules/os/commercial/routes";
import { paymentsView, recordManualReceipt, reverseOrderReceipt } from "../src/modules/os/commercial/receipts";
import { reopenFacts, reopenOrderQuote } from "../src/modules/os/reopen";
import { checklistCustomerSummary, markChecklist, orderChecklist } from "../src/modules/os/checklist";
import { erpLegacyPreview, importErpLegacy } from "../src/modules/os/erp-legacy";
import * as policy from "../src/integrations/policy";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

afterEach(() => vi.restoreAllMocks());
const quiet = { notify: false };

function checklistType(): CustomWorkType {
  const builtin = builtinWorkType({ service_orders: { warranty_days: 0 } });
  return validateWorkType({
    ...builtin, kind: "custom", id: "oficina", number_prefix: "OF",
    transitions: builtin.transitions.filter(t => t.id !== "quoted_analyzing"),
    features: { ...builtin.features, documents: true, checklist_customer_summary: true },
    stages: builtin.stages.map(stage => stage.id !== "in_progress" ? stage : { ...stage, checklist: [
      { id: "foto_painel", label: "Foto do painel", required: true, photo_required: true },
      { id: "teste_final", label: "Teste final", required: true, photo_required: false },
      { id: "limpeza", label: "Limpeza", required: false, photo_required: false },
    ] }),
  });
}

async function fixture(options: { erp?: boolean; custom?: boolean } = {}) {
  const f = await f3Fixture();
  if (options.erp === false) await setParts(f.profile, { erp: false });
  const type = checklistType();
  const settings: Record<string, unknown> = { service_orders: { warranty_days: 0 }, os_work_types: options.custom ? [type] : [] };
  await exec(f.env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(settings), f.profile);
  const ctx = {
    env: f.env, profile: f.profile, settings: async () => settings,
    access: (actor: Actor) => { if (!actor.profiles.includes(f.profile)) throw new ApiError(404, "not_found", "Trabalho não encontrado."); },
    requireEnabled: async () => {}, mayRead: () => true,
    publish: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}), sendInteractive: vi.fn(async () => {}),
    conversation: vi.fn(async () => { throw new ApiError(404, "not_found", "Conversa não encontrada."); }),
    paymentsReady: async () => ({ ready: false, reason: "payments_disabled", message: "O módulo Cobrança está desligado.", methods: [] }),
  } as unknown as ModuleContext;
  const opened = await createOrder(ctx, { item: "Fiat Uno 2010", problem: "Barulho no freio", phone: "5511999999988", customer_name: "Cliente",
    source: "panel", sourceKey: uid(), actor: f.actor.id, type_id: options.custom ? type.id : "service_order", notify: false });
  await patchWorkCommercial(ctx, f.actor, opened.order.id, { version: opened.order.row_version, customer_ref: f.local }, uid());
  return { ...f, ctx, type, settings, row: await loadOrder(ctx, opened.order.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const events = async (f: Fixture, id = f.row.id) => (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND source_id=? ORDER BY source_revision,seq", f.profile, id))
  .map(r => JSON.parse(r.payload_json) as IntegrationEvent);
const piece = { description: "Pastilha de freio dianteira", quantity: 2, unit_cents: 8000 };
const labor = { description: "Troca das pastilhas", quantity: 1, unit_cents: 12000 };
async function approved(f: Fixture, row = f.row) {
  const saved = await saveQuote(f.ctx, row, { items: [piece, labor] }, f.actor.id, uid(), { human: true });
  const sent = await sendQuote(f.ctx, saved, f.actor.id, { ...quiet, mutationKey: uid() });
  return decide(f.ctx, sent, "approve", f.actor.id, "panel", "", { ...quiet, quote_version: sent.quote_version, mutationKey: uid(),
    detail: { by_name: "Maria", at: Date.now() - 60_000, channel: "phone" } });
}

describe("OS6 reabrir orçamento com documento no ERP", () => {
  it("mostra o que existe, pede confirmação e desfaz pela compensação numa ordem nova", async () => {
    const f = await fixture();
    const ok = await approved(f);
    const facts = await reopenFacts(f.ctx, ok);
    expect(facts).toMatchObject({ mode: "erp", can_reopen: true, erp: { document: true } });
    expect(facts.effects.join(" ")).toContain("ordem nova");
    // Sem confirmar desfazer no ERP continua recusando, como antes.
    await expect(reopenOrderQuote(f.ctx, f.actor, ok.id, { version: ok.row_version, reason: "Mudou" }, uid())).rejects.toMatchObject({ code: "quote_reopen_blocked" });
    await expect(reopenOrderQuote(f.ctx, f.actor, ok.id, { version: ok.row_version, reason: " ", undo_erp: true }, uid())).rejects.toMatchObject({ code: "reason_required" });
    const key = uid();
    const next = await reopenOrderQuote(f.ctx, f.actor, ok.id, { version: ok.row_version, reason: "Cliente pediu peça original", undo_erp: true }, key);
    expect(next.id).not.toBe(ok.id);
    expect(next.status).toBe("received");
    expect(JSON.parse(next.quote_items).map((i: any) => i.description)).toEqual([piece.description, labor.description]);
    const old = await loadOrder(f.ctx, ok.id);
    expect(old.status).toBe("cancelled");
    expect((await events(f)).at(-1)).toMatchObject({ operation: "cancel", reason_code: "work_cancelled" });
    const notes = await all(f.env, "SELECT note FROM os_history WHERE profile_id=? AND order_id IN (?,?)", f.profile, ok.id, next.id);
    expect(notes.map(n => n.note).join("\n")).toContain("Orçamento reaberto numa ordem nova: Cliente pediu peça original");
    expect(notes.map(n => n.note).join("\n")).toContain("Orçamento reaberto da ordem");
    expect(await all(f.env, "SELECT order_id,kind,other_id FROM os_order_links WHERE profile_id=? ORDER BY kind", f.profile)).toEqual([
      { order_id: ok.id, kind: "reopened_as", other_id: next.id }, { order_id: next.id, kind: "reopened_from", other_id: ok.id }]);
    // Repetir o mesmo pedido termina sem criar outra ordem.
    const again = await reopenOrderQuote(f.ctx, f.actor, ok.id, { version: old.row_version, reason: "Cliente pediu peça original", undo_erp: true }, key);
    expect(again.id).toBe(next.id);
  });

  it("não reabre com recebimento ou nota autorizada e diz o que fazer antes", async () => {
    const f = await fixture();
    const ok = await approved(f);
    await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 5000, method: "cash" }, uid());
    await exec(f.env, "INSERT INTO os_fiscal_notes(profile_id,order_id,kind,emission_id,status,number,environment,updated) VALUES(?,?,'nfse',?,'autorizada','77','homologacao',?)", f.profile, ok.id, uid(), Date.now());
    const row = await loadOrder(f.ctx, ok.id);
    const facts = await reopenFacts(f.ctx, row);
    expect(facts.mode).toBe("blocked");
    expect(facts.blockers.join(" ")).toContain("estorne o recebimento");
    expect(facts.blockers.join(" ")).toContain("cancele a nota");
    await expect(reopenOrderQuote(f.ctx, f.actor, ok.id, { version: row.row_version, reason: "Mudou", undo_erp: true }, uid())).rejects.toMatchObject({ code: "quote_reopen_erp_blocked" });
    expect((await loadOrder(f.ctx, ok.id)).status).toBe("approved");
    expect((await events(f)).some(e => e.operation === "cancel")).toBe(false);
  });

  it("sem documento no ERP, volta para análise na mesma ordem", async () => {
    const f = await fixture({ erp: false });
    const ok = await approved(f);
    expect((await reopenFacts(f.ctx, ok)).mode).toBe("local");
    const reopened = await reopenOrderQuote(f.ctx, f.actor, ok.id, { version: ok.row_version, reason: "Trocar peça", undo_erp: true }, uid());
    expect(reopened).toMatchObject({ id: ok.id, status: "analyzing", decision: null });
  });
});

describe("OS6 estorno do recebimento", () => {
  it("estorna com motivo, volta o saldo e não estorna duas vezes", async () => {
    const f = await fixture();
    const ok = await approved(f);
    const paid = await recordManualReceipt(f.ctx, f.actor, ok.id, { amount_cents: 28000, method: "pix" }, uid());
    expect(paid.balance_cents).toBe(0);
    const key = paid.receipts[0].receipt_key;
    await expect(reverseOrderReceipt(f.ctx, f.actor, ok.id, { receipt_key: key, reason: "" }, uid())).rejects.toMatchObject({ code: "reason_required" });
    const operator: Actor = { ...f.actor, id: uid(), role: "operator", access: [] };
    await expect(reverseOrderReceipt(f.ctx, operator, ok.id, { receipt_key: key, reason: "Pix devolvido" }, uid())).rejects.toMatchObject({ status: 403 });
    const view = await reverseOrderReceipt(f.ctx, f.actor, ok.id, { receipt_key: key, reason: "Pix devolvido ao cliente" }, uid());
    expect(view).toMatchObject({ received_cents: 0, balance_cents: 28000 });
    expect(view.receipts.find(r => r.receipt_key === key)).toMatchObject({ reversed: true });
    expect(view.receipts.find(r => r.kind === "reverse")).toMatchObject({ reverses_key: key, amount_cents: 28000 });
    await expect(reverseOrderReceipt(f.ctx, f.actor, ok.id, { receipt_key: key, reason: "De novo" }, uid())).rejects.toMatchObject({ code: "already_reversed" });
    const history = await all(f.env, "SELECT note FROM os_history WHERE order_id=? AND kind='os.receipt_recorded'", ok.id);
    expect(history.at(-1)!.note).toContain("Estorno de R$ 280,00");
    expect(history.at(-1)!.note).toContain("Pix devolvido ao cliente");
  });

  it("com a conta a receber no ERP, o estorno da baixa segue pela fila da ordem", async () => {
    const f = await fixture();
    const ok = await approved(f);
    const running = await changeStatus(f.ctx, ok, "in_progress", f.actor.id, "", quiet);
    const paid = await recordManualReceipt(f.ctx, f.actor, running.id, { amount_cents: 10000, method: "cash" }, uid());
    await reverseOrderReceipt(f.ctx, f.actor, running.id, { receipt_key: paid.receipts[0].receipt_key, reason: "Lançado em dobro" }, uid());
    const out = await events(f);
    const reverse = out.find(e => e.operation === "reverse")!;
    expect(reverse).toMatchObject({ eligible: { finance: true }, reverses_receipt_key: paid.receipts[0].receipt_key });
    expect((await paymentsView(f.ctx, f.actor, running.id)).balance_cents).toBe(28000);
  });
});

describe("OS6 checklist por etapa", () => {
  it("valida o modelo: foto pede Documentos e etapa encerrada não tem checklist", () => {
    const type = checklistType();
    expect(type.stages.find(s => s.id === "in_progress")!.checklist).toHaveLength(3);
    expect(type.stages.find(s => s.id === "received")!.checklist).toBeUndefined();
    expect(() => validateWorkType({ ...type, features: { ...type.features, documents: false } })).toThrow(/photo_required/);
    expect(() => validateWorkType({ ...type, stages: type.stages.map(s => s.id === "delivered" ? { ...s, checklist: [{ id: "a", label: "A", required: true, photo_required: false }] } : s) })).toThrow(/closed/);
  });

  it("só avança com os obrigatórios (e a foto), fica no histórico e no resumo do cliente", async () => {
    const f = await fixture({ erp: false, custom: true });
    const ok = await approved(f);
    const running = await changeStage(f.ctx, ok, { version: ok.row_version, transition_id: "approved_in_progress" }, f.actor.id, quiet);
    await expect(changeStage(f.ctx, running, { version: running.row_version, transition_id: "in_progress_ready" }, f.actor.id, quiet))
      .rejects.toMatchObject({ code: "checklist_required", message: expect.stringContaining("Teste final") });
    let row = await markChecklist(f.ctx, f.actor, running.id, { version: running.row_version, item_id: "teste_final", done: true }, uid());
    await expect(markChecklist(f.ctx, f.actor, row.id, { version: row.row_version, item_id: "foto_painel", done: true }, uid())).rejects.toMatchObject({ code: "photo_required" });
    const photo = uid();
    await exec(f.env, `INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,byte_length,sha256,r2_key,state,upload_expires_at,created_by,created,updated)
      VALUES(?,?,?,'painel.jpg','image/jpeg',10,10,'abc',?,'ready',?,?,?,?)`, photo, f.profile, row.id, `r2/${photo}`, Date.now() + 60_000, f.actor.id, Date.now(), Date.now());
    row = await markChecklist(f.ctx, f.actor, row.id, { version: row.row_version, item_id: "foto_painel", done: true, photo_document_id: photo }, uid());
    const stage = orderChecklist(row).find(s => s.stage_id === "in_progress")!;
    expect(stage).toMatchObject({ current: true, missing: [] });
    expect(checklistCustomerSummary(row)).toContain("2 de 3 itens feitos");
    const ready = await changeStage(f.ctx, row, { version: row.row_version, transition_id: "in_progress_ready" }, f.actor.id, quiet);
    expect(ready.status).toBe("ready");
    const notes = (await all(f.env, "SELECT note FROM os_history WHERE order_id=? AND kind='os.checklist_marked'", row.id)).map(h => h.note);
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining("Teste final feito"), expect.stringContaining("Foto do painel feito · com foto")]));
  });

  it("cancelar não espera o checklist", async () => {
    const f = await fixture({ erp: false, custom: true });
    const ok = await approved(f);
    const running = await changeStage(f.ctx, ok, { version: ok.row_version, transition_id: "approved_in_progress" }, f.actor.id, quiet);
    const cancelled = await changeStage(f.ctx, running, { version: running.row_version, transition_id: "in_progress_cancelled", note: "Cliente desistiu" }, f.actor.id, quiet);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("OS6 motivo em cancelar e voltar etapa", () => {
  it("pessoas e bots informam o motivo; aplicações autorizadas não são obrigadas", async () => {
    expect(needsMoveReason("in_progress", "cancelled")).toBe(true);
    expect(needsMoveReason("ready", "in_progress")).toBe(true);
    expect(needsMoveReason("approved", "analyzing")).toBe(true);
    expect(needsMoveReason("received", "in_progress")).toBe(false);
    expect(isBackward("declined", "ready")).toBe(false);
    const f = await fixture({ erp: false });
    const row = await loadOrder(f.ctx, f.row.id);
    expect(() => requireMoveReason(f.actor, row, { status: "cancelled" })).toThrow(ApiError);
    expect(() => requireMoveReason(f.actor, row, { transition_id: "received_cancelled", note: "  " })).toThrow(/motivo do cancelamento/);
    expect(() => requireMoveReason(f.actor, row, { transition_id: "received_cancelled", note: "Desistiu" })).not.toThrow();
    expect(() => requireMoveReason(f.actor, row, { status: "in_progress" })).not.toThrow();
    expect(() => requireMoveReason({ ...f.actor, kind: "app" }, row, { status: "cancelled" })).not.toThrow();
    const ready = { ...row, status: "ready", stage: "ready" };
    expect(() => requireMoveReason(f.actor, ready, { transition_id: "ready_in_progress" })).toThrow(/voltar a etapa/);
  });
});

describe("OS6 ordem antiga do ERP", () => {
  const documentId = "0b6f9a39-6a51-4b8e-9f63-2f3d2e8b1c11";
  const erpDocument = (f: Fixture, status = "open") => ({ kind: "service_orders", document: { kind: "service_orders", id: documentId, number: "12", status,
    date: "2026-10-01", contact_id: f.customer, equipment: "Celular A54", defect: "Tela quebrada",
    items: [{ description: "Troca de tela", quantity: "1", unit_price: "150.00", unit: "UN" }, { description: "Película", quantity: "2", unit_price: "10.50", unit: "UN" }] } });

  it("prévia, traz uma vez com cliente, itens e situação, e liga as duas", async () => {
    const f = await fixture({ erp: false });
    await exec(f.env, "UPDATE contacts SET phone='5511988887777' WHERE id=?", f.local);
    vi.spyOn(policy, "humanReferenceRpc").mockResolvedValue(erpDocument(f));
    const preview = await erpLegacyPreview(f.ctx, f.actor, documentId);
    expect(preview).toMatchObject({ can_import: true, status_label: "Em aberto", total_cents: 17100, customer: { found: true }, item: "Celular A54" });
    const order = await importErpLegacy(f.ctx, f.actor, documentId, {});
    expect(order).toMatchObject({ item: "Celular A54", problem: "Tela quebrada", quote_total_cents: 17100 });
    expect(order.notes).toContain("situação no ERP: Em aberto");
    expect(await one(f.env, "SELECT order_id FROM os_order_links WHERE profile_id=? AND kind='erp_document' AND other_id=?", f.profile, documentId)).toEqual({ order_id: order.id });
    expect((await importErpLegacy(f.ctx, f.actor, documentId, {})).id).toBe(order.id);
    expect((await erpLegacyPreview(f.ctx, f.actor, documentId))).toMatchObject({ can_import: false, migrated: { order_id: order.id } });
  });

  it("encerrada no ERP fica só para consulta; o bot não traz", async () => {
    const f = await fixture({ erp: false });
    await exec(f.env, "UPDATE contacts SET phone='5511988887777' WHERE id=?", f.local);
    vi.spyOn(policy, "humanReferenceRpc").mockResolvedValue(erpDocument(f, "finalized"));
    await expect(importErpLegacy(f.ctx, f.actor, documentId, {})).rejects.toMatchObject({ code: "erp_legacy_blocked" });
    await expect(erpLegacyPreview(f.ctx, { ...f.actor, id: "bot:x" }, documentId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("OS6 bots", () => {
  it("reabrir e estornar são sensíveis; marcar checklist não", () => {
    const sensitive = osModule.bot?.sensitive ?? [];
    expect(sensitive).toEqual(expect.arrayContaining(["os.quote.reopen", "os.receipt.reverse"]));
    expect(sensitive.some(name => "os.checklist.mark".startsWith(name))).toBe(false);
    expect(osModule.events).toContain("os.checklist_marked");
  });
});
