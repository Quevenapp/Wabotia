import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { moduleCommand, moduleView, moduleById } from "../src/modules/registry";
import * as parts from "../src/modules/erp/parts-state";
import { planSettings, commitSettingsPlan } from "../src/service";
import { activationStatements, eventEpochOpen, readIntegrationActivation } from "../src/integrations/activation";
import { acquireIntegrationLease, aliasStatements, confirmIntegrationResult, findIntegrationEvent, integrationStatements, persistPreparedRequest, readPreparedRequest, renewIntegrationLease } from "../src/integrations/outbox";
import { applyErpRequest, closeErpCommand, prepareErpRequest } from "../src/integrations/erp-adapter";
import { closureRequest, drainIntegrationOutbox, retryDelay } from "../src/integrations/consumer";
import { canonical, commandId, hash, uuid5 } from "../src/integrations/keys";
import { integrationProducer } from "../src/integrations/registry";
import { IntegrationError, logIntegrationError, validateEvent } from "../src/integrations/privacy";
import { ensureCommercialPolicy, patchCommercialPolicy, validatePolicyReferences } from "../src/integrations/policy";
import * as policy from "../src/integrations/policy";
import * as identity from "../src/modules/erp/identity";
import * as local from "../src/erp/api/local-fetch";
import * as hub from "../src/erp/hub";
import { erpBridge } from "../src/customer/ports";
import { ensureConsumer } from "../src/integrations/customer-adapter";
import { getErpOrigin, manualApplyErpRequest, prepareManualErpRequest } from "../src/integrations/erp-adapter";
import { runModuleSchedules } from "../src/modules/schedule";
import * as hooks from "../src/modules/hooks";
import * as approvals from "../src/approvals";
import { integrationCommand, integrationSourceView } from "../src/integrations/routes";
import { commercialReceiptStatements, allocationStatements, manualReceiptKey } from "../src/integrations/receipts";
import type { IntegrationEvent } from "../src/integrations/contracts";
import { f3Fixture, installFakeErp, installFixtureProducer, enqueue, due, delivery, setParts } from "./helpers/f3-fixtures";

// O console da Cloudflare devolve métodos ligados por um Proxy; reler
// console.error perde a propriedade .mock. Conservar o espião original.
let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  installFixtureProducer();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("F3: contratos, lote indivisível e identidade", () => {
  it("usa UUIDv5 padrão, codificação não ambígua e hash canônico", async () => {
    expect(uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.widgets.com")).toBe("21f7f8de-8051-5b89-8680-0195ef798b6a");
    const f = await f3Fixture();
    expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }));
    expect(commandId({ ...f.source, component: "other" }, 1)).toBe(f.event.command_id);
    expect(commandId({ ...f.source, source_id: `${f.source.source_id}:2` }, 1)).not.toBe(commandId(f.source, 2));
  });
  it("reverte a mutação local e todos os eventos se o CAS perdeu", async () => {
    const f = await f3Fixture(); await enqueue(f);
    await expect(batch(f.env, [
      ["UPDATE profiles SET name='Não deve persistir' WHERE id=?", [f.profile]],
      ...integrationStatements({ source: f.source, expected_revision: 0, events: [f.event], next_state: { snapshot: f.event.snapshot } }),
    ])).rejects.toThrow();
    expect((await one(f.env, "SELECT name FROM profiles WHERE id=?", f.profile)).name).toBe("Área F3");
    expect(await all(f.env, "SELECT id FROM module_erp_events WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await findIntegrationEvent(f.env, f.profile, f.event.event_key, f.event)).toEqual(f.event);
    await expect(findIntegrationEvent(f.env, f.profile, f.event.event_key, { ...f.event, reason_code: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("queda antes do commit não deixa saída órfã; depois do commit permite retomar", async () => {
    const f = await f3Fixture(); const remote = installFakeErp();
    await expect(batch(f.env, [...integrationStatements({ source: f.source, expected_revision: 0, events: [f.event], next_state: {} }), ["SELECT json('falha_controlada')", []]])).rejects.toThrow();
    expect(await one(f.env, "SELECT * FROM module_erp_events WHERE id=?", f.event.id)).toBeNull();
    await enqueue(f); await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).state).toBe("done"); expect(remote.mutations).toHaveLength(1);
  });
  it("mantém evento, pedido, recebimento e alocação imutáveis", async () => {
    const f = await f3Fixture(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), token);
    const key = manualReceiptKey(f.profile, "os", "receipt");
    await batch(f.env, [...commercialReceiptStatements({ profile_id: f.profile, receipt_key: key, owner_module: "os", source_id: f.source.source_id, kind: "receive", evidence: "manual", reverses_key: null, amount_cents: 1000, method: "cash", occurred_ms: Date.now(), actor_id: f.actor.id, evidence_hash: hash("evidence") }), ...allocationStatements(f.source, key, "main", 1000)]);
    for (const [table, condition, args] of [
      ["module_erp_events", "id=?", [f.event.id]], ["module_erp_requests", "event_id=?", [f.event.id]],
      ["module_commercial_receipts", "profile_id=?", [f.profile]], ["module_erp_allocations", "profile_id=?", [f.profile]],
    ] as const) {
      await expect(exec(f.env, `DELETE FROM ${table} WHERE ${condition}`, ...args)).rejects.toThrow();
    }
    await expect(exec(f.env, "UPDATE module_erp_events SET occurred_ms=occurred_ms+1 WHERE id=?", f.event.id)).rejects.toThrow();
    await expect(exec(f.env, "UPDATE module_erp_requests SET actor_id='other' WHERE event_id=?", f.event.id)).rejects.toThrow();
  });
  it("alias não muda com associação ou agrupamento posterior", async () => {
    const f = await f3Fixture(); await enqueue(f);
    await batch(f.env, aliasStatements(f.source, "order", "record"));
    await batch(f.env, aliasStatements(f.source, "order", "record"));
    await expect(batch(f.env, aliasStatements({ ...f.source, component: "different" }, "order", "record"))).rejects.toThrow();
  });
  it("um módulo sem produtor falha fechado", async () => {
    expect(() => integrationProducer("suporte")).toThrowError(expect.objectContaining({ code: "integration_not_implemented" }));
    const f = await f3Fixture(), remote = installFakeErp();
    const source = { ...f.source, module: "suporte" as const };
    const { os, ...epochs } = f.event.epochs;
    const event = { ...f.event, source, epochs: { ...epochs, suporte: os }, command_id: commandId(source, 1), snapshot: { ...f.event.snapshot, source } };
    await enqueue(f, event); await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).error_code).toBe("integration_not_implemented"); expect(remote.apply).not.toHaveBeenCalled();
  });
});

describe("F3: concessão, repetição e confirmação", () => {
  it("dois consumidores fazem um único efeito e respeitam a sequência", async () => {
    const f = await f3Fixture(), remote = installFakeErp();
    const next = { ...f.event, id: crypto.randomUUID(), seq: 2, command_id: commandId(f.source, 2), event_key: `${f.event.event_key}:lifecycle`, operation: "lifecycle" as const };
    await batch(f.env, integrationStatements({ source: f.source, expected_revision: 0, events: [f.event, next], next_state: { snapshot: f.event.snapshot } }));
    expect(await acquireIntegrationLease(f.env, next.id)).toBeNull();
    await Promise.all([drainIntegrationOutbox(f.env, f.profile), drainIntegrationOutbox(f.env, f.profile)]);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toEqual([f.event.command_id, next.command_id]);
    expect((await one(f.env, "SELECT applied_seq FROM module_erp_sources WHERE profile_id=?", f.profile)).applied_seq).toBe(2);
  });
  it("só o detentor confirma/renova; quem perdeu repete o pedido persistido", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    const first = (await acquireIntegrationLease(f.env, f.event.id))!;
    const prepared = await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), first);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", f.event.id);
    const second = (await acquireIntegrationLease(f.env, f.event.id))!;
    expect(second).not.toBe(first); expect(await renewIntegrationLease(f.env, f.event.id, first)).toBe(false);
    const winner = await persistPreparedRequest(f.env, f.event, { ...prepared, body: { ...prepared.body, reason_code: "must_not_win" } }, second);
    expect(winner).toEqual(prepared);
    const result = await applyErpRequest(f.env, winner);
    await expect(confirmIntegrationResult(f.env, f.event, first, result)).rejects.toThrow();
    expect((await one(f.env, "SELECT applied_seq FROM module_erp_sources WHERE profile_id=?", f.profile)).applied_seq).toBe(0);
    await confirmIntegrationResult(f.env, f.event, second, result);
    expect(remote.mutations).toHaveLength(1);
  });
  it("persiste corpo antes do envio, recupera commit remoto perdido e conserva autoria", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f); remote.loseNextReply();
    await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).state).toBe("pending");
    const prepared = await readPreparedRequest(f.env, f.event);
    await exec(f.env, "UPDATE module_erp_policy SET version=version+1,config_json=json_set(config_json,'$.revenue_category_id',?) WHERE profile_id=?", crypto.randomUUID(), f.profile);
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(await readPreparedRequest(f.env, f.event)).toEqual(prepared);
    expect((await delivery(f)).state).toBe("done"); expect(remote.mutations).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ component: "module-integration", code: "integration_unavailable" }));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("conteúdo privado");
  });
  it("queda após preparação conserva corpo mesmo que política mude", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    const request = await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), token);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", f.event.id);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.requests.get(f.event.command_id)).toBe(hash(request));
  });
  it("fechamento e aplicação disputam a mesma identidade sem declarar falso estorno", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    const request = await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), token);
    const [applied, closed] = await Promise.all([applyErpRequest(f.env, request), closeErpCommand(f.env, request, "correction")]);
    expect(closed.outcome).toBe(applied.outcome); expect(remote.mutations.length).toBeLessThanOrEqual(1);
    const f2 = await f3Fixture(); await enqueue(f2);
    const token2 = (await acquireIntegrationLease(f2.env, f2.event.id))!;
    const request2 = await persistPreparedRequest(f2.env, f2.event, await closureRequest(f2.env, f2.event), token2);
    await closeErpCommand(f2.env, request2, "correction");
    expect((await applyErpRequest(f2.env, request2)).outcome).toBe("closed");
  });
  it("origem bloqueada não bloqueia outra; falha transitória chega a 12 tentativas", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    remote.apply.mockRejectedValue(new IntegrationError("integration_unavailable", 503));
    for (let i = 0; i < 12; i++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    expect(await delivery(f)).toMatchObject({ state: "failed", attempts: 12 });
    expect(retryDelay(1)).toBe(5000); expect(retryDelay(12)).toBe(3600000);
    const source = { ...f.source, source_id: crypto.randomUUID() };
    const another: IntegrationEvent = { ...f.event, id: crypto.randomUUID(), source, event_key: `${f.event.event_key}:other`, command_id: commandId(source, 1), snapshot: { ...f.event.snapshot, source } };
    await enqueue(f, another);
    remote.apply.mockResolvedValue({ command_id: another.command_id, seq: 1, replayed: false, outcome: "applied", links: [], effects: { stock: "not_requested", finance: "not_requested" }, reason_code: null });
    await drainIntegrationOutbox(f.env, f.profile); expect((await delivery(f, another.id)).state).toBe("done");
  });
});

describe("F3: épocas, partes e automações", () => {
  it("repete escolha sem incrementar época e preserva primeiro corte", async () => {
    const f = await f3Fixture(); const before = await readIntegrationActivation(f.env, f.profile, "os");
    await setParts(f.profile, { "erp-financeiro": true });
    expect((await readIntegrationActivation(f.env, f.profile, "os")).epochs).toEqual(before.epochs);
    await setParts(f.profile, { "erp-financeiro": false });
    await setParts(f.profile, { "erp-financeiro": true });
    const after = await readIntegrationActivation(f.env, f.profile, "os");
    expect(after.epochs["erp-financeiro"]).toBe(before.epochs["erp-financeiro"] + 2);
    expect(after.activations["erp-financeiro"].first_enabled_ms).toBe(before.activations["erp-financeiro"].first_enabled_ms);
    expect(eventEpochOpen(f.event, after.activations, ["erp-financeiro"])).toBe(false);
  });
  it("cascata grava módulos e épocas juntos sem enfraquecer revisão parts", async () => {
    const f = await f3Fixture();
    vi.spyOn(parts, "syncErpParts").mockImplementation(async () => ({ revision: "1", delivered_revision: "0", status: "pending" }));
    const before = await parts.readErpPartsState(f.env, f.profile);
    await moduleCommand(f.env, f.actor, f.profile, "module.set", { id: "erp", enabled: false, cascade: true });
    const after = await readIntegrationActivation(f.env, f.profile, "os");
    for (const id of ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"]) expect(after.activations[id]).toMatchObject({ enabled: 0, epoch: 2, enabled_since_ms: null });
    expect(BigInt(after.snapshot.revision)).toBeGreaterThan(BigInt(before.snapshot.revision));
  });
  it("modelos/configurações atualizam épocas no lote; erro de procedência reverte tudo", async () => {
    const f = await f3Fixture();
    vi.spyOn(parts, "syncErpParts").mockResolvedValue({ revision: "1", delivered_revision: "0", status: "pending" });
    const plan = await planSettings(f.env, f.actor, f.profile, {}, { modules: { "erp-financeiro": false } });
    await expect(commitSettingsPlan(f.env, f.actor, plan, [["SELECT json('rollback_fixture')", []]])).rejects.toThrow();
    expect((await readIntegrationActivation(f.env, f.profile, "os")).epochs["erp-financeiro"]).toBe(1);
    await commitSettingsPlan(f.env, f.actor, plan);
    expect((await readIntegrationActivation(f.env, f.profile, "os")).activations["erp-financeiro"]).toMatchObject({ epoch: 2, enabled: 0 });
  });
  it("corte de padrão sem linha é o instante atual, nunca o passado presumido", async () => {
    const f = await f3Fixture();
    await exec(f.env, "DELETE FROM module_erp_activation WHERE profile_id=? AND module_id='os'", f.profile);
    const at = Date.now(), state = await readIntegrationActivation(f.env, f.profile, "os");
    expect(state.activations.os.enabled_since_ms).toBeGreaterThanOrEqual(at);
    expect(eventEpochOpen({ ...f.event, occurred_ms: at - 1 }, state.activations, [])).toBe(false);
  });
  it("Base desligada faz zero chamadas, preserva a pendência e retoma recibo após religar", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    await setParts(f.profile, { erp: false });
    const forbidden = vi.fn(() => { throw new Error("ERP não pode ser aberto"); });
    await drainIntegrationOutbox({ ...f.env, COORDINATOR: { get: forbidden, idFromName: forbidden } } as any, f.profile);
    expect(forbidden).not.toHaveBeenCalled(); expect(remote.apply).not.toHaveBeenCalled(); expect(remote.close).not.toHaveBeenCalled(); expect(remote.get).not.toHaveBeenCalled();
    expect((await delivery(f)).state).toBe("pending");
    await setParts(f.profile, { erp: true }); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(0); expect((await delivery(f)).state).toBe("done"); expect(remote.close).toHaveBeenCalledOnce();
  });
  it("recupera resposta perdida antes de decidir por desligamento do destino", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f); remote.loseNextReply();
    await drainIntegrationOutbox(f.env, f.profile);
    await setParts(f.profile, { "erp-financeiro": false }); await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(JSON.parse((await delivery(f)).receipt_json).outcome).toBe("applied");
    expect(remote.close).not.toHaveBeenCalled(); expect(remote.mutations).toHaveLength(1);
  });
  it("desligar entre preparação e envio fecha comando sem efeitos novos", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), token);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", f.event.id);
    await setParts(f.profile, { "erp-financeiro": false }); await drainIntegrationOutbox(f.env, f.profile);
    expect(JSON.parse((await delivery(f)).receipt_json).outcome).toBe("closed"); expect(remote.apply).not.toHaveBeenCalled();
  });
  it("automação desligada conserva escolha e proposta, sem consumir tentativas", async () => {
    const f = await f3Fixture(), remote = installFakeErp();
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { finance: false } }, "off");
    const event = { ...f.event, eligible: { document: false, stock: false, finance: true } };
    await enqueue(f, event); await drainIntegrationOutbox(f.env, f.profile);
    expect(await delivery(f)).toMatchObject({ state: "waiting_manual", attempts: 0 }); expect(remote.apply).not.toHaveBeenCalled();
    await setParts(f.profile, { "erp-financeiro": false }); await setParts(f.profile, { "erp-financeiro": true });
    expect((await ensureCommercialPolicy(f.env, f.profile)).auto_post.finance).toBe(false);
  });
  it("Financeiro sozinho prepara documento interno com itens livres", async () => {
    const f = await f3Fixture();
    await setParts(f.profile, { "erp-produtos": false, "erp-vendas": false, "erp-estoque": false });
    const state = await readIntegrationActivation(f.env, f.profile, "os");
    const event: IntegrationEvent = { ...f.event, epochs: state.epochs, occurred_ms: Date.now(), eligible: { document: true, stock: false, finance: true }, snapshot: { ...f.event.snapshot, items: f.event.snapshot.items.map(i => ({ ...i, product_id: crypto.randomUUID() })) } };
    await enqueue(f, event);
    const request = await prepareErpRequest(f.env, event);
    expect((request.body.snapshot as any).items[0]).toMatchObject({ product_id: null, kind: "free" });
    expect(request.body.requested).toEqual({ document: true, stock: false, finance: true });
  });
  it("pagamento de obrigação antiga sem vínculo não cria dívida retroativa", async () => {
    const f = await f3Fixture(), remote = installFakeErp();
    const event = { ...f.event, operation: "receive" as const, receipt_key: "new-payment" };
    await enqueue(f, event); await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).error_code).toBe("historical_origin_unlinked"); expect(remote.apply).not.toHaveBeenCalled();
  });
});

describe("F3: dados obrigatórios, privacidade e autorização", () => {
  it("cliente sem nome e categoria ausente ficam bloqueados sem envio", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    await exec(f.env, "UPDATE contacts SET name='' WHERE id=?", f.local);
    await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).error_code).toBe("customer_required"); expect(remote.apply).not.toHaveBeenCalled();
    await exec(f.env, "UPDATE contacts SET name='Cliente' WHERE id=?", f.local);
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',NULL) WHERE profile_id=?", f.profile);
    await integrationCommand(f.env, f.actor, f.profile, "integration.retry", { module: "os", id: f.source.source_id, event_id: f.event.id }, "retry");
    await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).error_code).toBe("category_required"); expect(remote.apply).not.toHaveBeenCalled();
  });
  it("padrão inativo não é aceito e nenhuma lista escolhe automaticamente o primeiro", async () => {
    const f = await f3Fixture();
    vi.spyOn(identity, "erpIdentity").mockResolvedValue({ actor: { user_id: f.actor.id } as any, people: [] });
    vi.spyOn(local, "localFetch").mockReturnValue((async () => Response.json({ items: [{ id: f.policy.warehouse_id, active: false }, { id: crypto.randomUUID(), active: true }] })) as any);
    await expect(validatePolicyReferences(f.env, f.actor, f.policy)).rejects.toMatchObject({ code: "default_inactive" });
    const disabled = { ...f.policy, warehouse_id: null, revenue_category_id: null, payment_method_id: null, settlement_accounts: {} };
    await validatePolicyReferences(f.env, f.actor, disabled);
    await exec(f.env, "DELETE FROM module_erp_policy WHERE profile_id=?", f.profile);
    const policyRow = await ensureCommercialPolicy(f.env, f.profile);
    expect(policyRow).toMatchObject({ warehouse_id: null, revenue_category_id: null, payment_method_id: null, consumer_contact_id: null });
  });
  it("total divergente e conteúdo sensível são recusados antes do lote", async () => {
    const f = await f3Fixture();
    const bad = { ...f.event, snapshot: { ...f.event.snapshot, total_cents: 1001 } };
    expect(() => validateEvent(bad)).toThrowError(expect.objectContaining({ code: "total_mismatch" }));
    const sensitive = { ...f.event, snapshot: { ...f.event.snapshot, privacy: "adult_payer_only" as const, description: "conteúdo clínico privado" } };
    expect(() => integrationStatements({ source: f.source, expected_revision: 0, events: [sensitive], next_state: {} })).toThrow();
    const extra = { ...f.event, snapshot: { ...f.event.snapshot, notes: "menor privado" } };
    expect(() => validateEvent(extra)).toThrow();
    logIntegrationError(new Error("prontuário privado"));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ component: "module-integration", code: "integration_unavailable" }));
    expect(canonical(consoleError.mock.calls)).not.toContain("prontuário");
    expect(await all(f.env, "SELECT * FROM module_erp_events WHERE profile_id=?", f.profile)).toEqual([]);
  });
  it("quantidade decimal usa arredondamento inteiro e soma exata de parcelas", async () => {
    const f = await f3Fixture();
    const event = { ...f.event, snapshot: { ...f.event.snapshot, items: [{ ...f.event.snapshot.items[0], quantity: "0.5", unit_cents: 3 }], total_cents: 2, installments: [{ ...f.event.snapshot.installments[0], amount_cents: 2 }] } };
    expect(() => validateEvent(event)).not.toThrow();
    event.snapshot.installments[0].amount_cents = 1;
    expect(() => validateEvent(event)).toThrowError(expect.objectContaining({ code: "total_mismatch" }));
  });
  it("outra área, bot e identidade técnica não ampliam acesso", async () => {
    const f = await f3Fixture(), other = await f3Fixture(); await enqueue(f);
    await expect(integrationSourceView(f.env, { ...other.actor, role: "operator" }, f.source)).rejects.toMatchObject({ status: 404 });
    await expect(integrationCommand(f.env, { ...f.actor, kind: "connector" }, f.profile, "integration.retry", {}, "key")).rejects.toMatchObject({ status: 403 });
    const operator = { ...f.actor, role: "operator" as const, access: ["os"] };
    const result = await integrationSourceView(f.env, operator, f.source);
    expect(result.deliveries[0]).not.toHaveProperty("error_code");
    await expect(patchCommercialPolicy(f.env, operator, f.profile, { version: 1 }, "key")).rejects.toMatchObject({ status: 403 });
  });
  it("retry idêntico conserva pedido; mesma chave com outro corpo conflita", async () => {
    const f = await f3Fixture(); await enqueue(f);
    const args = { module: "os", id: f.source.source_id, event_id: f.event.id };
    const first = await integrationCommand(f.env, f.actor, f.profile, "integration.retry", args, "repeat");
    expect(await integrationCommand(f.env, f.actor, f.profile, "integration.retry", args, "repeat")).toEqual(first);
    await expect(patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { stock: false } }, "policy-key")).resolves.toMatchObject({ version: 2 });
    await expect(patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { stock: true } }, "policy-key")).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("metadado esconde OS do ERP quando o trabalho está ligado", () => {
    const item = moduleView(moduleById("erp-vendas")!, true).management.find(i => i.id === "erp.service-orders");
    expect(item?.hidden_when_modules_enabled).toEqual(["os"]);
  });
});

describe("F3: correção segura, configuração e adaptador HTTP", () => {
  it("substitui só depois do fechamento; queda na projeção pode ser retomada", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    const producer = integrationProducer("os"), project = producer.project;
    vi.spyOn(producer, "project").mockRejectedValueOnce(new IntegrationError("integration_unavailable", 503)).mockImplementation(project);
    const data = { module: "os", id: f.source.source_id, event_id: f.event.id, reason_code: "correction" };
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.replace", data, "replace")).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse((await delivery(f)).receipt_json).outcome).toBe("closed");
    const next = await integrationCommand(f.env, f.actor, f.profile, "integration.replace", data, "replace");
    expect(next.event_id).not.toBe(f.event.id);
    expect(await integrationCommand(f.env, f.actor, f.profile, "integration.replace", data, "replace")).toEqual(next);
    expect(await all(f.env, "SELECT seq FROM module_erp_events WHERE profile_id=? ORDER BY seq", f.profile)).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(remote.mutations).toHaveLength(0);
    await drainIntegrationOutbox(f.env, f.profile); expect(remote.mutations).toHaveLength(1);
  });
  it("se aplicação venceu, replace recupera resultado e não inventa outro lançamento", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f); remote.loseNextReply();
    await drainIntegrationOutbox(f.env, f.profile);
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.replace", { module: "os", id: f.source.source_id, event_id: f.event.id, reason_code: "correction" }, "replace")).rejects.toMatchObject({ code: "version_conflict" });
    expect(await all(f.env, "SELECT id FROM module_erp_events WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await delivery(f)).state).toBe("done"); expect(remote.mutations).toHaveLength(1);
  });
  it("Consumidor é único por área, criado pela ponte sem dados fictícios", async () => {
    const f = await f3Fixture(), erpId = crypto.randomUUID();
    const bridge = vi.spyOn(erpBridge, "apply").mockImplementation(async (env, command) => {
      const row = await one(env, "SELECT name,phone,email,document FROM contacts WHERE profile_id=? AND id=?", command.profileId, command.contactId);
      expect(row).toMatchObject({ name: "Consumidor", phone: "", email: "", document: null });
      await exec(env, "UPDATE contacts SET erp_contact_id=?,erp_version=1 WHERE profile_id=? AND id=?", erpId, command.profileId, command.contactId);
      return { status: "applied", replayed: false, snapshot: { erpId, erpVersion: 1, mirror: { name: "Consumidor", phones: [], email: "", document: null, personType: null } } };
    });
    expect(await ensureConsumer(f.env, f.profile, f.actor)).toBe(erpId);
    expect(await ensureConsumer(f.env, f.profile, f.actor)).toBe(erpId);
    expect(bridge).toHaveBeenCalledOnce();
    expect((await ensureCommercialPolicy(f.env, f.profile)).consumer_contact_id).toBe(erpId);
    const f2 = await f3Fixture(); await setParts(f2.profile, { erp: false });
    await expect(ensureConsumer(f2.env, f2.profile, f2.actor)).rejects.toMatchObject({ code: "part_disabled" });
    expect(bridge).toHaveBeenCalledOnce();
  });
  it("recibos e alocações não aceitam outra evidência nem valor excedente", async () => {
    const f = await f3Fixture(); await enqueue(f);
    const receipt = { profile_id: f.profile, receipt_key: "receipt", owner_module: "os" as const, source_id: f.source.source_id, kind: "receive" as const, evidence: "manual" as const, reverses_key: null, amount_cents: 1000, method: "cash" as const, occurred_ms: Date.now(), actor_id: f.actor.id, evidence_hash: hash("evidence") };
    await batch(f.env, commercialReceiptStatements(receipt)); await batch(f.env, commercialReceiptStatements(receipt));
    await expect(batch(f.env, commercialReceiptStatements({ ...receipt, amount_cents: 2000 }))).rejects.toThrow();
    await expect(batch(f.env, allocationStatements(f.source, receipt.receipt_key, "too-much", 1001))).rejects.toThrow();
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(0);
    await batch(f.env, allocationStatements(f.source, receipt.receipt_key, "exact", 1000));
    await batch(f.env, allocationStatements(f.source, receipt.receipt_key, "exact", 1000));
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });
  it("o agendador drena a fila mesmo sem ganchos de módulo", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    vi.spyOn(hooks, "scheduledModules").mockReturnValue([]);
    vi.spyOn(approvals, "expireApprovals").mockResolvedValue(undefined);
    await runModuleSchedules(f.env, f.profile, Date.now()); expect(remote.mutations).toHaveLength(1);
  });
  it("os quatro RPCs têm nomes fixos, evidência D1, portão e fotografia parts", async () => {
    const f = await f3Fixture(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    const request = await persistPreparedRequest(f.env, f.event, await prepareErpRequest(f.env, f.event), token);
    const state = await parts.readErpPartsState(f.env, f.profile);
    const envelope = { actor: { user_id: request.actor_id, name: "Sistema", email: null, erp_role: "vendas" as const, verified_factor: false, session_id: null, aal: "aal1" as const, is_agent: true }, people: [], parts: state.snapshot.parts, partsControl: { profile: f.profile, revision: state.snapshot.revision, expires_at: state.snapshot.expires_at } };
    vi.spyOn(identity, "erpSystemIdentity").mockResolvedValue(envelope);
    vi.spyOn(identity, "erpIdentity").mockResolvedValue({ ...envelope, actor: { ...envelope.actor, user_id: f.actor.id, is_agent: false, erp_role: "admin" } });
    const calls: string[] = [];
    vi.spyOn(hub, "erpFetch").mockImplementation(async (_env, profile, path, init) => {
      calls.push(path);
      const headers = new Headers(init?.headers), args = JSON.parse(String(init?.body));
      expect(profile).toBe(f.profile); expect(headers.get("x-erp-gate")).toBe("1"); expect(headers.get("x-erp-system")).toBe("1");
      expect(headers.get("x-erp-identity")).toBeTruthy();
      expect(args.p_evidence.request_hash).toBe(hash(args.p_request));
      const row = await one(f.env, "SELECT request_hash FROM module_erp_requests WHERE event_id=?", args.p_evidence.event_id);
      expect(row.request_hash).toBe(args.p_evidence.request_hash);
      const result = { command_id: args.p_request.command_id, seq: args.p_request.seq, replayed: false, outcome: path.endsWith("close") ? "closed" : "applied", links: [], effects: { stock: "not_requested", finance: "not_requested" }, reason_code: null };
      return Response.json(path.endsWith("origin_get") ? { receipt: null } : result);
    });
    await applyErpRequest(f.env, request); await getErpOrigin(f.env, request); await closeErpCommand(f.env, request, "correction");
    await expect(applyErpRequest(f.env, { ...request, actor_id: f.actor.id })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const f2 = { ...f, source: { ...f.source, source_id: crypto.randomUUID() } };
    const event = { ...f.event, id: crypto.randomUUID(), source: f2.source, command_id: commandId(f2.source, 1), event_key: `${f.event.event_key}:manual`, snapshot: { ...f.event.snapshot, source: f2.source } };
    await enqueue(f, event);
    const token2 = (await acquireIntegrationLease(f.env, event.id))!;
    const manual = await persistPreparedRequest(f.env, event, await prepareManualErpRequest(f.env, event, f.actor, ["finance"]), token2);
    await manualApplyErpRequest(f.env, manual, f.actor);
    expect(calls).toEqual(["/erp-rpc/erp_module_apply", "/erp-rpc/erp_module_origin_get", "/erp-rpc/erp_module_command_close", "/erp-rpc/erp_module_manual_apply"]);
  });
});

describe("F3: pendências por destino", () => {
  it("postagem automática de um destino conserva ação manual do outro", async () => {
    const f = await f3Fixture(), remote = installFakeErp();
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { finance: false } }, "manual-finance");
    await enqueue(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(1);
    const request = await readPreparedRequest(f.env, f.event);
    expect(request?.body.requested).toEqual({ document: true, stock: true, finance: false });
    expect(await integrationSourceView(f.env, f.actor, f.source)).toMatchObject({ state: "waiting_manual", pending: true, manual_destinations: ["finance"] });
  });
  it("validação e acesso falham imediatamente; 429 repete com atraso", async () => {
    const f = await f3Fixture(), remote = installFakeErp(); await enqueue(f);
    remote.apply.mockRejectedValueOnce(new IntegrationError("forbidden", 403));
    await drainIntegrationOutbox(f.env, f.profile);
    expect(await delivery(f)).toMatchObject({ state: "failed", attempts: 1, error_code: "forbidden" });
    await integrationCommand(f.env, f.actor, f.profile, "integration.retry", { module: "os", id: f.source.source_id, event_id: f.event.id }, "retry-429");
    remote.apply.mockRejectedValueOnce(new IntegrationError("integration_unavailable", 429));
    await drainIntegrationOutbox(f.env, f.profile);
    expect(await delivery(f)).toMatchObject({ state: "pending", attempts: 1 });
    expect((await delivery(f)).next_attempt_ms).toBeGreaterThan(Date.now());
  });
});
