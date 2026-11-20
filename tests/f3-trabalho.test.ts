import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import * as db from "../src/db";
import { ApiError, uid, type Actor } from "../src/types";
import type { ModuleContext } from "../src/modules/api";
import type { CustomWorkType } from "../src/modules/os/contracts";
import type { IntegrationEvent } from "../src/integrations/contracts";
import { createOrder, saveQuote, sendQuote, decide, changeStatus, moveOrder, updateOrder, loadOrder, orderView } from "../src/modules/os/store";
import { commitOrderMutation } from "../src/modules/os/mutations";
import { changeStage } from "../src/modules/os/stages";
import { builtinWorkType } from "../src/modules/os/work-types";
import { validateWorkType } from "../src/modules/os/validation";
import { quoteTotal, validateQuoteItems } from "../src/modules/os/model";
import { osModule } from "../src/modules/os/definition";
import { commercialOf, documentStatus, stableQuoteItems, workProducer, readWorkIntegration } from "../src/modules/os/commercial/projection";
import { prepareWorkMutation } from "../src/modules/os/commercial/mutations";
import { patchWorkCommercial, workCommercialView } from "../src/modules/os/commercial/routes";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import { hash } from "../src/integrations/keys";
import { validateEvent } from "../src/integrations/privacy";
import { acquireIntegrationLease, confirmIntegrationResult, persistPreparedRequest, readPreparedRequest } from "../src/integrations/outbox";
import { prepareErpRequest } from "../src/integrations/erp-adapter";
import { f3Fixture, installFakeErp, setParts, due } from "./helpers/f3-fixtures";

afterEach(() => vi.restoreAllMocks());
const item = (description = "Reparo", unit_cents = 1200) => ({ description, quantity: 1, unit_cents });
const quiet = { notify: false };
function customWorkType(): CustomWorkType {
  const builtin = builtinWorkType({ service_orders: { warranty_days: 0 } });
  return validateWorkType({
    ...builtin, kind: "custom", id: "repair", number_prefix: "REP",
    // No tipo personalizado, a edição de orçamento enviado usa
    // features.quote.edited_stage; não é uma transição manual.
    transitions: builtin.transitions.filter(t => t.id !== "quoted_analyzing"),
  });
}
async function fixture(enabled = true, custom = false) {
  const f = await f3Fixture();
  if (!enabled) await setParts(f.profile, { erp: false });
  const type = customWorkType();
  // OS3: personalizado deixou de ser reservado por padrão; os casos de
  // privacidade continuam valendo para a área sensível (Saúde aplicada).
  const settings = { service_orders: { warranty_days: 0 }, os_work_types: custom ? [type] : [],
    ...(custom ? { os_area_setup: [{ template_id: "clinica_medica", bot: { instructions: "", allowed_operations: [], denied_operations: [], suggested_roles: [] }, manual_steps: [] }] } : {}) };
  await exec(f.env, "UPDATE profiles SET settings=? WHERE id=?", JSON.stringify(settings), f.profile);
  const ctx = {
    env: f.env, profile: f.profile, settings: async () => settings,
    access: (actor: Actor) => { if (!actor.profiles.includes(f.profile)) throw new ApiError(404, "not_found", "Trabalho não encontrado."); },
    requireEnabled: async () => {}, mayRead: () => true,
    publish: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}), sendInteractive: vi.fn(async () => {}),
  } as unknown as ModuleContext;
  const input = { item: "Notebook", problem: "Não liga", phone: "5511999999988", customer_name: "Cliente",
    source: "panel" as const, sourceKey: uid(), actor: f.actor.id, type_id: custom ? type.id : "service_order", notify: false };
  const opened = await createOrder(ctx, input);
  await patchWorkCommercial(ctx, f.actor, opened.order.id, { version: opened.order.row_version, customer_ref: f.local,
    ...(custom ? { adult_payer_confirmed: true } : {}) }, uid());
  return { ...f, ctx, input, type, settings, row: await loadOrder(ctx, opened.order.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function events(f: Fixture) {
  return (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND source_id=? ORDER BY source_revision,seq", f.profile, f.row.id)).map(r => JSON.parse(r.payload_json) as IntegrationEvent);
}
async function approved(f: Fixture, material = false) {
  const quoted = await sendQuote(f.ctx, await saveQuote(f.ctx, f.row, { items: [{ ...item(), kind: material ? "material" : "free" }] }, f.actor.id, uid()), f.actor.id, { ...quiet, mutationKey: uid() });
  return decide(f.ctx, quoted, "approve", f.actor.id, "panel", "", { ...quiet, quote_version: quoted.quote_version, mutationKey: uid() });
}
async function drainAll(f: Fixture) {
  for (let i = 0; i < 20; i++) {
    await due(f);
    const before = await one(f.env, "SELECT applied_seq,enqueued_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, f.row.id);
    if (before.applied_seq === before.enqueued_seq) return;
    await drainIntegrationOutbox(f.env, f.profile);
    const after = await one(f.env, "SELECT applied_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, f.row.id);
    if (after.applied_seq === before.applied_seq) return;
  }
}

describe("F3 trabalho: contrato e conteúdo comercial", () => {
  it("reserva a edição de orçamento enviado ao protocolo do tipo personalizado", () => {
    const type = customWorkType();
    expect(type.features.quote).toMatchObject({ sent_stage: "quoted", edited_stage: "analyzing" });
    const manualReturn = builtinWorkType().transitions.find(t => t.id === "quoted_analyzing")!;
    expect(manualReturn).toBeDefined();
    expect(() => validateWorkType({ ...type, transitions: [...type.transitions, manualReturn] }))
      .toThrow("Trabalho: transitions.quote inválido.");
  });
  it("declara produtor work com papel vendas e mapa completo de estados", async () => {
    expect(osModule).toMatchObject({ erp_role: "vendas", integration: { route: "work" } });
    expect(documentStatus).toEqual({ received: "open", analyzing: "open", quoted: "quoted", approved: "approved", declined: "rejected", in_progress: "in_progress", ready: "service_done", delivered: "finalized", cancelled: "cancelled" });
    const f = await fixture();
    await expect(workProducer.authorizeSource(f.ctx, f.actor, { profile: "outra", module: "os", source_id: f.row.id, component: "main" }, true)).rejects.toMatchObject({ status: 404 });
  });
  it("mantém orçamento legado, IDs estáveis na reordenação e cálculo decimal exato", async () => {
    const f = await fixture(false);
    const saved = await saveQuote(f.ctx, f.row, { items: [item("Peça"), item("Serviço", 1800)] }, f.actor.id, "save");
    const first = orderView(saved).quote!;
    expect(first.total_cents).toBe(3000);
    expect(first.items.every(i => /^[0-9a-f-]{36}$/.test(i.id!))).toBe(true);
    const reordered = await saveQuote(f.ctx, saved, { items: [item("Serviço", 1800), item("Peça")] }, f.actor.id, "reorder");
    expect(orderView(reordered).quote!.items.map(i => i.id)).toEqual(first.items.map(i => i.id).reverse());
    expect(quoteTotal(validateQuoteItems([{ ...item("Porção", 101), quantity: 1.5 }]))).toBe(152);
    expect(() => validateQuoteItems([{ ...item(), id: first.items[0].id }, { ...item(), id: first.items[0].id }])).toThrow();
    const legacy = { ...f.row, quote_items: JSON.stringify([item("Legado"), item("Legado")]) };
    expect(stableQuoteItems(legacy)).toEqual(stableQuoteItems(legacy));
    expect(new Set(stableQuoteItems(legacy).map(i => i.id)).size).toBe(2);
  });
  it("material livre avisa; vínculo explícito não muda o preço nem cria produto", async () => {
    const f = await fixture();
    const id = uid(), product = uid();
    const row = await saveQuote(f.ctx, f.row, { items: [{ ...item("Peça", 777), id, kind: "material", unit: "UN" }] }, f.actor.id);
    expect((await workCommercialView(f.ctx, f.actor, row.id)).warnings).toHaveLength(1);
    await exec(f.env, "INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,'os','quote_item',?,?,?,?,?)", f.profile, row.id, id, product, Date.now(), f.actor.id);
    const linked = await saveQuote(f.ctx, row, { items: [{ ...item("Peça", 777), id, kind: "material", product_id: product }] }, f.actor.id);
    expect((await events(f)).at(-1)!.snapshot.items[0]).toMatchObject({ id, product_id: product, unit_cents: 777, kind: "material" });
    expect(linked.quote_items).not.toContain(product);
    await setParts(f.profile, { "erp-produtos": false, "erp-estoque": false, "erp-vendas": false });
    await saveQuote(f.ctx, linked, { items: [{ ...item("Peça", 777), id, kind: "material" }] }, f.actor.id);
    expect((await events(f)).at(-1)!.snapshot.items[0]).toMatchObject({ kind: "free", product_id: null });
  });
  it("bloqueia total divergente, parcela inconsistente e cliente incompleto sem usar Consumidor", async () => {
    const f = await fixture();
    await expect(commitOrderMutation(f.ctx, f.row, { quote_items: JSON.stringify([item()]), quote_total_cents: 1 }, f.actor.id, "os.quote_saved", ["quote"])).rejects.toMatchObject({ code: "total_mismatch" });
    await expect(patchWorkCommercial(f.ctx, f.actor, f.row.id, { version: f.row.row_version, items: [item()], installments: [{ key: "a", due_on: "2026-11-19", amount_cents: 1, payment_method_id: null }] }, uid())).rejects.toMatchObject({ code: "total_mismatch" });
    await exec(f.env, "UPDATE contacts SET name='' WHERE id=?", f.local);
    const row = await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id);
    const event = (await events(f)).at(-1)!;
    expect(event.snapshot).toMatchObject({ customer_ref: f.local, contact_id: null });
    await expect(prepareErpRequest(f.env, event)).rejects.toMatchObject({ code: "customer_required" });
    expect(row.status).toBe("received");
  });
});

describe("F3 trabalho: autorização, primeira execução e manutenção", () => {
  for (const enabled of [true, false]) it(`assistência completa, ERP ${enabled ? "ligado" : "desligado"}, uma origem e um lançamento`, async () => {
    const f = await fixture(enabled), remote = installFakeErp();
    const row = await approved(f, true);
    expect((await events(f)).some(e => e.operation === "execute")).toBe(false);
    const key = uid();
    const running = await changeStatus(f.ctx, row, "in_progress", f.actor.id, "", { ...quiet, mutationKey: key });
    await changeStatus(f.ctx, row, "in_progress", f.actor.id, "", { ...quiet, mutationKey: key });
    const first = commercialOf(running).first_execution_at;
    expect(first).toBeGreaterThan(0);
    const ready = await changeStatus(f.ctx, running, "ready", f.actor.id, "", quiet);
    const again = await changeStatus(f.ctx, ready, "in_progress", f.actor.id, "Revisão do reparo", quiet);
    expect(commercialOf(again).first_execution_at).toBe(first);
    const delivered = await changeStatus(f.ctx, await changeStatus(f.ctx, again, "ready", f.actor.id, "", quiet), "delivered", f.actor.id, "", quiet);
    expect(delivered.delivered_at).toBeGreaterThan(0); expect(delivered.warranty_until).toBeNull();
    const out = await events(f);
    expect(out.filter(e => e.operation === "execute")).toHaveLength(1);
    expect(out.filter(e => e.operation === "execute")[0].eligible).toEqual({ document: enabled, stock: enabled, finance: enabled });
    expect(new Set(out.map(e => e.source.source_id))).toEqual(new Set([row.id]));
    out.forEach(validateEvent);
    await drainAll(f);
    expect(remote.mutations.length > 0).toBe(enabled);
    expect([...remote.receipts.values()].filter(r => r.effects.finance === "posted")).toHaveLength(enabled ? 1 : 0);
    expect(new Set([...remote.receipts.values()].flatMap(r => r.links.map(l => l.id))).size).toBe(enabled ? 1 : 0);
    await expect(changeStatus(f.ctx, delivered, "in_progress", f.actor.id, "Reabrir", quiet)).rejects.toMatchObject({ code: "invalid_transition" });
  });
  it("exige preço fixo explícito e invalida autorização após alteração de valor", async () => {
    const f = await fixture(false);
    const row = await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id);
    await expect(changeStatus(f.ctx, row, "in_progress", f.actor.id, "", quiet)).rejects.toMatchObject({ code: "commercial_authorization_required" });
    await patchWorkCommercial(f.ctx, f.actor, row.id, { version: row.row_version, authorize_fixed_price: true }, "fixed");
    const fixed = await loadOrder(f.ctx, row.id);
    expect(commercialOf(fixed).authorization?.kind).toBe("fixed_price");
    const changed = await saveQuote(f.ctx, fixed, { items: [item("Novo", 2300)] }, f.actor.id);
    await expect(changeStatus(f.ctx, changed, "in_progress", f.actor.id, "", quiet)).rejects.toMatchObject({ code: "commercial_authorization_required" });
    await patchWorkCommercial(f.ctx, f.actor, row.id, { version: changed.row_version, authorize_fixed_price: true }, "fixed-new");
    const running = await changeStatus(f.ctx, await loadOrder(f.ctx, row.id), "in_progress", f.actor.id, "", quiet);
    expect(commercialOf(running).first_execution_at).toBeGreaterThan(0);
  });
  it("recusa aprovação vencida/antiga e preserva recusa seguida de retirada sem cobrança", async () => {
    const f = await fixture();
    const sent = await sendQuote(f.ctx, await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id), f.actor.id, quiet);
    await expect(decide(f.ctx, sent, "approve", f.actor.id, "panel", "", { quote_version: sent.quote_version - 1 })).rejects.toMatchObject({ code: "quote_version_conflict" });
    await expect(decide(f.ctx, { ...sent, quote_valid_until: Date.now() - 1 }, "approve", f.actor.id, "panel")).rejects.toMatchObject({ code: "quote_expired" });
    const declined = await decide(f.ctx, sent, "decline", f.actor.id, "panel", "", quiet);
    const ready = await changeStatus(f.ctx, declined, "ready", f.actor.id, "", quiet);
    await changeStatus(f.ctx, ready, "delivered", f.actor.id, "", quiet);
    expect((await events(f)).some(e => e.operation === "execute" || e.eligible.stock || e.eligible.finance)).toBe(false);
    expect(commercialOf(await loadOrder(f.ctx, f.row.id)).first_execution_at).toBeUndefined();
  });
  it("execução antiga e religamento nunca fazem novo lançamento", async () => {
    const f = await fixture(false);
    const running = await changeStatus(f.ctx, await approved(f), "in_progress", f.actor.id, "", quiet);
    await setParts(f.profile, { erp: true });
    const ready = await changeStatus(f.ctx, running, "ready", f.actor.id, "", quiet);
    await changeStatus(f.ctx, ready, "in_progress", f.actor.id, "Revisão", quiet);
    expect((await events(f)).filter(e => e.eligible.finance || e.eligible.stock)).toHaveLength(0);
    const legacy = await fixture();
    await exec(legacy.env, "UPDATE os_orders SET status='ready',stage='ready',commercial_json='{}' WHERE id=?", legacy.row.id);
    const next = await changeStatus(legacy.ctx, await loadOrder(legacy.ctx, legacy.row.id), "in_progress", legacy.actor.id, "Revisão de trabalho antigo", quiet);
    expect(commercialOf(next).historical_execution).toBe(true);
    expect((await events(legacy)).at(-1)!.operation).toBe("lifecycle");
  });
  it("congela dados após efeitos e mantém cancelamento operacional pendente com bloqueio remoto", async () => {
    const f = await fixture(), remote = installFakeErp();
    const running = await changeStatus(f.ctx, await approved(f), "in_progress", f.actor.id, "", quiet);
    await drainAll(f);
    expect((await readWorkIntegration(f.ctx, running)).active.finance).toBe(true);
    await expect(updateOrder(f.ctx, running, { phone: "5511999999977" }, f.actor.id)).rejects.toMatchObject({ code: "commercial_frozen" });
    await expect(patchWorkCommercial(f.ctx, f.actor, running.id, { version: running.row_version, installments: [] }, uid())).rejects.toMatchObject({ code: "commercial_frozen" });
    await expect(changeStatus(f.ctx, running, "cancelled", f.actor.id, "", quiet)).rejects.toMatchObject({ code: "reason_required" });
    remote.apply.mockRejectedValue(new ApiError(409, "version_conflict", "Texto remoto que não deve vazar"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cancelled = await changeStatus(f.ctx, running, "cancelled", f.actor.id, "Cliente desistiu", quiet);
    await drainAll(f);
    expect(cancelled.status).toBe("cancelled");
    expect(await workCommercialView(f.ctx, f.actor, cancelled.id)).toMatchObject({ state: "blocked", cancellation_pending: true });
    expect((await events(f)).at(-1)).toMatchObject({ operation: "cancel", reason_code: "work_cancelled" });
    expect((await events(f)).some(e => e.operation === "reverse" || e.operation === "receive")).toBe(false);
  });
  it("preserva vínculo histórico com Produtos desligado depois do efeito", async () => {
    const f = await fixture(), remote = installFakeErp(), line = uid(), product = uid();
    await exec(f.env, "INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,'os','quote_item',?,?,?,?,?)", f.profile, f.row.id, line, product, Date.now(), f.actor.id);
    const saved = await saveQuote(f.ctx, f.row, { items: [{ ...item(), id: line, kind: "material", product_id: product }] }, f.actor.id);
    const sent = await sendQuote(f.ctx, saved, f.actor.id, quiet);
    const running = await changeStatus(f.ctx, await decide(f.ctx, sent, "approve", f.actor.id, "panel", "", quiet), "in_progress", f.actor.id, "", quiet);
    await drainAll(f);
    await setParts(f.profile, { "erp-produtos": false, "erp-estoque": false, "erp-vendas": false });
    await changeStatus(f.ctx, running, "ready", f.actor.id, "", quiet);
    expect((await events(f)).at(-1)!.snapshot.items[0].product_id).toBe(product);
    expect(remote.mutations.length).toBeGreaterThan(0);
  });
  it("confirma reversão apenas pelo recibo remoto e não fabrica devolução de dinheiro", async () => {
    const f = await fixture(), remote = installFakeErp();
    const original = remote.apply.getMockImplementation()!;
    remote.apply.mockImplementation(async (env, request) => {
      const receipt = await original(env, request);
      if (request.body.operation !== "cancel") return receipt;
      const reversed = { ...receipt, effects: { stock: "reversed" as const, finance: "reversed" as const } };
      remote.receipts.set(request.command_id, reversed);
      return reversed;
    });
    const running = await changeStatus(f.ctx, await approved(f), "in_progress", f.actor.id, "", quiet);
    await drainAll(f);
    const cancelled = await changeStatus(f.ctx, running, "cancelled", f.actor.id, "Desistência antes do serviço", quiet);
    expect((await workCommercialView(f.ctx, f.actor, cancelled.id)).cancellation_pending).toBe(true);
    await drainAll(f);
    expect((await workCommercialView(f.ctx, f.actor, cancelled.id)).cancellation_pending).toBe(false);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(0);
  });
});

describe("F3 trabalho: privacidade, personalização e rotas", () => {
  it("usa BaseStatus de etapa personalizada e filtra Saúde/Ensino antes da fila", async () => {
    const f = await fixture(true, true);
    const secret = "SEGREDO_CLINICO_MENOR_991";
    const saved = await saveQuote(f.ctx, f.row, { items: [item(secret)], note: secret }, f.actor.id);
    const sent = await sendQuote(f.ctx, saved, f.actor.id, quiet);
    const accepted = await decide(f.ctx, sent, "approve", f.actor.id, "panel", secret, quiet);
    const running = await changeStage(f.ctx, accepted, { version: accepted.row_version, transition_id: "approved_in_progress" }, f.actor.id, quiet);
    const cancelled = await changeStage(f.ctx, running, { version: running.row_version, transition_id: "in_progress_cancelled", note: secret }, f.actor.id, quiet);
    expect(cancelled.stage).toBe("cancelled");
    const output = await events(f);
    expect(JSON.stringify(output)).not.toContain(secret);
    for (const e of output) {
      expect(e.snapshot.technical).toBeNull();
      expect(e.snapshot.description).toBe("Serviço contratado");
      expect(e.snapshot.customer_ref).toBe(e.source_revision === 1 ? null : f.local);
    }
    const audit = await all(f.env, "SELECT note FROM os_history WHERE profile_id=?", f.profile);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify((f.ctx.publish as any).mock.calls)).not.toContain(secret);
  });
  it("exige pagador adulto, impede técnico sensível e bots alterando preço", async () => {
    const f = await fixture(true, true);
    await patchWorkCommercial(f.ctx, f.actor, f.row.id, { version: f.row.row_version, adult_payer_confirmed: false }, uid());
    const row = await saveQuote(f.ctx, await loadOrder(f.ctx, f.row.id), { items: [item()] }, f.actor.id);
    expect((await events(f)).at(-1)!.snapshot).toMatchObject({ customer_ref: null, contact_id: null, technical: null });
    await expect(patchWorkCommercial(f.ctx, f.actor, row.id, { version: row.row_version, technical: { defect: "privado" } }, uid())).rejects.toMatchObject({ code: "technical_not_allowed" });
    await expect(patchWorkCommercial(f.ctx, { ...f.actor, id: "bot:teste" }, row.id, { version: row.row_version, items: [item()] }, uid())).rejects.toMatchObject({ status: 403 });
    await expect(workCommercialView(f.ctx, { ...f.actor, profiles: [] }, row.id)).rejects.toMatchObject({ status: 404 });
  });
  it("PATCH comercial é idempotente e conflito não troca o corpo persistido", async () => {
    const f = await fixture(false), key = uid();
    const data = { version: f.row.row_version, items: [item()], authorize_fixed_price: true };
    const first = await patchWorkCommercial(f.ctx, f.actor, f.row.id, data, key);
    const before = await events(f);
    expect(await patchWorkCommercial(f.ctx, f.actor, f.row.id, data, key)).toEqual(first);
    await expect(patchWorkCommercial(f.ctx, f.actor, f.row.id, { ...data, items: [item("Outro", 3000)] }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await events(f)).toEqual(before);
  });
});

describe("F3 trabalho: lote atômico, quedas e repetição", () => {
  for (const enabled of [true, false]) for (const custom of [true, false]) {
    it(`caminhos de gravação ${custom ? "centrais" : "legados"}, ERP ${enabled}: queda antes do lote e repetição`, async () => {
      const f = await fixture(enabled, custom);
      let row = f.row;
      const cases: Array<(row: any, key: string) => Promise<any>> = [
        (r, key) => updateOrder(f.ctx, r, { item: "Equipamento conferido" }, f.actor.id, key),
        (r, key) => saveQuote(f.ctx, r, { items: [item()] }, f.actor.id, key),
        (r, key) => sendQuote(f.ctx, r, f.actor.id, { ...quiet, mutationKey: key }),
        (r, key) => saveQuote(f.ctx, r, { items: [item("Revisado", 1300)] }, f.actor.id, key),
        (r, key) => sendQuote(f.ctx, r, f.actor.id, { ...quiet, mutationKey: key }),
        (r, key) => decide(f.ctx, r, "approve", f.actor.id, "panel", "", { ...quiet, mutationKey: key }),
        (r, key) => changeStage(f.ctx, r, { version: r.row_version, transition_id: "approved_in_progress" }, f.actor.id, { ...quiet, mutationKey: key }),
        (r, key) => moveOrder(f.ctx, r, "ready", f.actor.id, "", {}, "status", { ...quiet, mutationKey: key, ...(custom ? { stage: "ready" } : {}) }),
      ];
      for (const write of cases) {
        const key = uid(), before = await events(f), previous = row;
        const original = db.batch;
        const fault = vi.spyOn(db, "batch").mockImplementation(async (env, statements) => {
          if (statements.some(([sql]) => sql.includes("UPDATE os_orders"))) throw new Error("queda antes do lote");
          return original(env, statements);
        });
        await expect(write(previous, key)).rejects.toThrow("queda antes do lote");
        fault.mockRestore();
        expect(await events(f)).toEqual(before);
        const plan = await prepareWorkMutation(f.ctx, row, { stage: row.stage }, f.actor.id, Date.now());
        await expect(batch(f.env, [["UPDATE os_orders SET notes='não confirmar' WHERE id=?", [row.id]], ...plan.statements, ["SELECT json('queda_no_lote')", []]])).rejects.toThrow();
        expect(await events(f)).toEqual(before);
        expect((await loadOrder(f.ctx, row.id)).notes).not.toBe("não confirmar");
        const lostReply = vi.spyOn(db, "batch").mockImplementation(async (env, statements) => {
          const result = await original(env, statements);
          if (statements.some(([sql]) => sql.includes("UPDATE os_orders"))) throw new Error("resposta D1 perdida");
          return result;
        });
        await expect(write(previous, key)).rejects.toThrow("resposta D1 perdida");
        lostReply.mockRestore();
        row = await loadOrder(f.ctx, previous.id);
        const committed = await events(f);
        expect(committed.length).toBe(before.length + 1);
        expect((await write(previous, key)).id).toBe(row.id);
        expect(await events(f)).toEqual(committed);
      }
    });
  }
  it("queda após commit D1 e publicação não perde a saída; abertura repetida não duplica", async () => {
    const f = await fixture();
    const before = await events(f);
    (f.ctx.publish as any).mockRejectedValueOnce(new Error("publicação indisponível"));
    const key = uid();
    await expect(commitOrderMutation(f.ctx, f.row, { quote_items: JSON.stringify([item()]), quote_total_cents: 1200 }, f.actor.id, "os.quote_saved", ["quote"], key)).rejects.toThrow();
    expect(await events(f)).toHaveLength(before.length + 1);
    await commitOrderMutation(f.ctx, f.row, { quote_items: JSON.stringify([item()]), quote_total_cents: 1200 }, f.actor.id, "os.quote_saved", ["quote"], key);
    expect(await events(f)).toHaveLength(before.length + 1);
    const opened = await createOrder(f.ctx, f.input);
    expect(opened.created).toBe(false); expect(opened.order.id).toBe(f.row.id);
    await expect(createOrder(f.ctx, { ...f.input, item: "Outra abertura" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(commitOrderMutation(f.ctx, f.row, { quote_items: JSON.stringify([item()]), quote_total_cents: 600 }, f.actor.id, "os.quote_saved", ["quote"], key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await events(f)).toHaveLength(before.length + 1);
  });
  it("resposta ERP perdida conserva pedido e recupera uma única aplicação", async () => {
    const f = await fixture(), remote = installFakeErp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id);
    const event = (await events(f)).at(-1)!;
    remote.loseNextReply();
    await drainIntegrationOutbox(f.env, f.profile);
    const prepared = await readPreparedRequest(f.env, event);
    expect(prepared).not.toBeNull();
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(await readPreparedRequest(f.env, event)).toEqual(prepared);
    expect(remote.mutations).toHaveLength(1);
    expect((await one(f.env, "SELECT applied_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, f.row.id)).applied_seq).toBe(event.seq);
  });
  it("queda entre preparação e envio, dois consumidores e recibo D1 repetido", async () => {
    const f = await fixture(), remote = installFakeErp();
    await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id);
    const event = (await events(f)).at(-1)!;
    const token = (await acquireIntegrationLease(f.env, event.id))!;
    const request = await persistPreparedRequest(f.env, event, await prepareErpRequest(f.env, event), token);
    expect(await acquireIntegrationLease(f.env, event.id)).toBeNull();
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", event.id);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.requests.get(event.command_id)).toBe(hash(request));
    await expect(confirmIntegrationResult(f.env, event, token, remote.receipts.get(event.command_id)!)).rejects.toThrow();
    expect(remote.mutations).toHaveLength(1);
  });
  it("desligar após commit ERP recupera o recibo ao religar e não reaplica", async () => {
    const f = await fixture(), remote = installFakeErp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await saveQuote(f.ctx, f.row, { items: [item()] }, f.actor.id);
    remote.loseNextReply(); await drainIntegrationOutbox(f.env, f.profile);
    await setParts(f.profile, { erp: false });
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(1);
    await setParts(f.profile, { erp: true }); await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(1);
    expect((await readWorkIntegration(f.ctx, f.row)).source.applied_seq).toBe((await events(f)).at(-1)!.seq);
  });
  it("encerra a época depois da preparação sem lançar efeitos novos", async () => {
    const f = await fixture(), remote = installFakeErp();
    const accepted = await approved(f);
    await drainAll(f);
    await changeStatus(f.ctx, accepted, "in_progress", f.actor.id, "", quiet);
    const event = (await events(f)).at(-1)!;
    const token = (await acquireIntegrationLease(f.env, event.id))!;
    const request = await persistPreparedRequest(f.env, event, await prepareErpRequest(f.env, event), token);
    await setParts(f.profile, { "erp-financeiro": false });
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", event.id);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(await readPreparedRequest(f.env, event)).toEqual(request);
    expect(remote.receipts.get(event.command_id)?.outcome).toBe("closed");
    expect([...remote.receipts.values()].some(r => r.effects.finance === "posted")).toBe(false);
    await setParts(f.profile, { "erp-financeiro": true });
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).not.toContain(event.command_id);
  });
});
