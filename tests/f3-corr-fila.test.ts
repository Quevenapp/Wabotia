import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/modules/runtime";
import { all, batch, exec, one } from "../src/db";
import * as adapter from "../src/integrations/erp-adapter";
import * as hub from "../src/erp/hub";
import * as customers from "../src/integrations/customer-adapter";
import * as producers from "../src/integrations/registry";
import { erpIdentity } from "../src/modules/erp/identity";
import { GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, encodeIdentity } from "../src/erp/engine/identity";
import { drainIntegrationOutbox, retryDelay } from "../src/integrations/consumer";
import { integrationSourceView, integrationCommand, registerIntegrationRoutes } from "../src/integrations/routes";
import { acquireIntegrationLease, integrationStatements, persistPreparedRequest } from "../src/integrations/outbox";
import { patchCommercialPolicy } from "../src/integrations/policy";
import { effectiveSourceState } from "../src/integrations/state";
import { canonical, commandId } from "../src/integrations/keys";
import { IntegrationError } from "../src/integrations/privacy";
import { modulesApi } from "../src/modules/api";
import { createOrder, loadOrder, saveQuote, sendQuote, decide, changeStatus } from "../src/modules/os/store";
import { patchWorkCommercial } from "../src/modules/os/commercial/routes";
import { runModuleSchedules } from "../src/modules/schedule";
import { uid } from "../src/types";
import { Hono } from "hono";
import { delivery, due, enqueue, f3Fixture, installFakeErp, installFixtureProducer, setParts } from "./helpers/f3-fixtures";

// Casos de transporte usam a porta controlada só no ponto de falha. O cenário
// de Trabalho abaixo atravessa produtor, D1, adaptador e Coordinator reais.
afterEach(() => vi.restoreAllMocks());
const quiet = { notify: false };
async function transport() { installFixtureProducer(); vi.spyOn(console, "error").mockImplementation(() => {}); return f3Fixture(); }

describe("F3 correção da fila", () => {
  it("abre sem orçamento, orça, aprova e executa no motor real sem lacuna remota", async () => {
    const f = await f3Fixture(); f.actor.sessionId = uid();
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const identity = await erpIdentity(f.env, f.actor, f.profile, "POST");
      const response = await hub.erpFetch(f.env, f.profile, `/erp-rpc/${name}`, {
        method: "POST", headers: { "Content-Type": "application/json", [GATE_HEADER]: "1", [SYSTEM_HEADER]: "1", [IDENTITY_HEADER]: encodeIdentity(identity) },
        body: JSON.stringify({ p_user_id: f.actor.id, ...args }),
      });
      const result = await response.json<any>(); expect(response.status, JSON.stringify(result)).toBe(200); return result;
    };
    const customer = (await rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: { name: "Cliente", person_type: "J", roles: ["customer"] } })).record;
    const category = (await rpc("erp_finance_category_execute", { p_command_id: uid(), p_action: "category_create", p_data: { kind: "receivable", name: "Serviços" } })).record;
    const warehouse = (await rpc("erp_catalog_save", { p_entity: "warehouses", p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: { name: "Depósito" } })).record;
    await exec(f.env, "UPDATE contacts SET erp_contact_id=? WHERE id=?", customer.id, f.local);
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',?,'$.warehouse_id',?) WHERE profile_id=?", category.id, warehouse.id, f.profile);
    const ctx = { ...modulesApi(f.env, f.profile, "os"), publish: vi.fn(async () => 1), sendMessage: vi.fn(async () => "sent"), sendInteractive: vi.fn(async () => "sent"), note: vi.fn(async () => undefined) };
    let row = (await createOrder(ctx, { item: "Notebook", problem: "Não liga", customer_name: "Cliente", phone: "5511999999988", source: "panel", sourceKey: uid(), actor: f.actor.id, notify: false })).order;
    const opening = await one(f.env, "SELECT e.seq,d.state FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.source_id=?", row.id);
    expect(opening).toEqual({ seq: null, state: "done" });
    await patchWorkCommercial(ctx, f.actor, row.id, { version: row.row_version, customer_ref: f.local }, uid());
    row = await saveQuote(ctx, await loadOrder(ctx, row.id), { items: [{ description: "Reparo", quantity: 1, unit_cents: 1000, kind: "free" }] }, f.actor.id, uid());
    row = await sendQuote(ctx, row, f.actor.id, quiet);
    row = await decide(ctx, row, "approve", f.actor.id, "panel", "", quiet);
    await changeStatus(ctx, row, "in_progress", f.actor.id, "", quiet);
    for (let i = 0; i < 10; i++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    const rows = await all(f.env, "SELECT e.seq,d.state,d.error_code FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.source_id=? ORDER BY e.seq", row.id);
    expect(rows.every(d => d.state === "done"), JSON.stringify(rows)).toBe(true);
    expect(rows.filter(d => d.seq !== null).map(d => d.seq)).toEqual([1, 2, 3, 4]);
    const counts = await runInDurableObject(hub.erpStub(f.env, f.profile), (_: unknown, state: DurableObjectState) => ({
      documents: state.storage.sql.exec("SELECT count(*) n FROM erp_documents__document").toArray()[0].n,
      titles: state.storage.sql.exec("SELECT count(*) n FROM erp_finance__title").toArray()[0].n,
    }));
    expect(counts).toEqual({ documents: 1, titles: 1 });
  });

  it("encerra fato inelegível no lote, inclusive atrás de um comando pendente", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    const local = { ...f.event, seq: 2, id: uid(), command_id: commandId(f.source, 2), event_key: uid(), source_revision: 2,
      snapshot: { ...f.event.snapshot, source_revision: 2 }, eligible: { document: false, stock: false, finance: false } };
    await enqueue(f, local);
    const row = await one(f.env, "SELECT e.*,d.state FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.event_key=?", local.event_key);
    expect(row.seq).toBeNull(); expect(JSON.parse(row.payload_json).seq).toBeNull(); expect(row.state).toBe("done");
    await setParts(f.profile, { "erp-financeiro": false }); await setParts(f.profile, { "erp-financeiro": true });
    await drainIntegrationOutbox(f.env, f.profile); await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.apply).not.toHaveBeenCalled(); expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("falha de preparação conta e recua até intervenção visível", async () => {
    const f = await transport(); await enqueue(f);
    vi.spyOn(customers, "resolveCommercialCustomer").mockRejectedValue(new IntegrationError("integration_unavailable", 503));
    for (let n = 1; n <= 12; n++) { await due(f); const start = Date.now(); await drainIntegrationOutbox(f.env, f.profile);
      const d = await delivery(f); expect(d.preparation_attempts).toBe(n); expect(d.attempts).toBe(0); expect(d.next_attempt_ms).toBeGreaterThanOrEqual(start + retryDelay(n)); }
    expect((await delivery(f)).state).toBe("failed");
  });

  it("falha de consulta com pedido preparado também tem limite", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    const token = (await acquireIntegrationLease(f.env, f.event.id))!;
    await persistPreparedRequest(f.env, f.event, await adapter.prepareErpRequest(f.env, f.event), token);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", f.event.id);
    remote.get.mockRejectedValue(new IntegrationError("integration_unavailable", 503));
    for (let n = 0; n < 12; n++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    expect(await delivery(f)).toMatchObject({ lookup_attempts: 12, attempts: 0, state: "failed" });
    await due(f); await drainIntegrationOutbox(f.env, f.profile); expect(remote.get).toHaveBeenCalledTimes(12);
  });

  it("último envio sem resposta consulta o recibo e nunca envia uma décima terceira aplicação", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    await exec(f.env, "UPDATE module_erp_delivery SET attempts=11 WHERE event_id=?", f.event.id);
    remote.loseNextReply(); await drainIntegrationOutbox(f.env, f.profile);
    expect(await delivery(f)).toMatchObject({ state: "uncertain", attempts: 12, unresolved: 1 });
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect((await delivery(f)).state).toBe("done"); expect(remote.mutations).toHaveLength(1); expect(remote.apply).toHaveBeenCalledTimes(1);
  });

  it("esgotar consultas de envio incerto mantém a incerteza e retry conserva a identidade e o limite de envios", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    await exec(f.env, "UPDATE module_erp_delivery SET attempts=11 WHERE event_id=?", f.event.id);
    remote.apply.mockRejectedValue(new IntegrationError("integration_unavailable", 503));
    await drainIntegrationOutbox(f.env, f.profile);
    for (let n = 0; n < 12; n++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    expect(await delivery(f)).toMatchObject({ state: "uncertain", attempts: 12, lookup_attempts: 12 });
    expect(remote.apply).toHaveBeenCalledTimes(1);
    await integrationCommand(f.env, f.actor, f.profile, "integration.retry", { module: "os", id: f.source.source_id, event_id: f.event.id }, uid());
    await drainIntegrationOutbox(f.env, f.profile); expect(remote.apply).toHaveBeenCalledTimes(1);
    expect(await delivery(f)).toMatchObject({ state: "uncertain", attempts: 12, lookup_attempts: 1 });
  });

  it("prazo global limita chamada em curso e a rodada dos módulos não drena ERP", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    remote.apply.mockImplementation(() => new Promise(() => {}));
    const start = Date.now(); await drainIntegrationOutbox(f.env, f.profile, { budget_ms: 150 }); expect(Date.now() - start).toBeLessThan(1500);
    expect(await delivery(f)).toMatchObject({ state: "pending", unresolved: 1, lease_token: null });
    remote.apply.mockClear(); await due(f); await runModuleSchedules(f.env, f.profile, Date.now()); expect(remote.apply).not.toHaveBeenCalled();
  });

  it("corte de automação conserva o nascimento por destino", async () => {
    const f = await transport(); const remote = installFakeErp();
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { finance: false } }, uid());
    await enqueue(f);
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 2, auto_post: { finance: true } }, uid());
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.apply.mock.calls[0][1].body.requested).toEqual({ document: true, stock: true, finance: false });
    expect(await integrationSourceView(f.env, f.actor, f.source)).toMatchObject({ state: "skipped", skipped_reason: "automation_off", manual_destinations: ["finance"] });
    await expect(exec(f.env, "UPDATE module_erp_event_automation SET authorization_json='{}' WHERE event_id=?", f.event.id)).rejects.toThrow();
  });

  it("recusa sucessores e projeção inválida antes de fechar ou confirmar o original", async () => {
    const f = await transport(); const remote = installFakeErp(); await enqueue(f);
    const next = { ...f.event, id: uid(), seq: 2, command_id: commandId(f.source, 2), event_key: uid(), source_revision: 2, snapshot: { ...f.event.snapshot, source_revision: 2 } };
    await enqueue(f, next);
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.replace", { module: "os", id: f.source.source_id, event_id: f.event.id, reason_code: "correction" }, uid())).rejects.toMatchObject({ code: "replacement_successors" });
    expect(remote.close).not.toHaveBeenCalled(); expect((await delivery(f)).state).toBe("pending");
    const g = await f3Fixture(); await enqueue(g);
    vi.spyOn(producers.integrationProducer("os"), "project").mockResolvedValue({ ...g.event.snapshot, total_cents: 3 });
    await expect(integrationCommand(g.env, g.actor, g.profile, "integration.replace", { module: "os", id: g.source.source_id, event_id: g.event.id, reason_code: "correction" }, uid())).rejects.toMatchObject({ code: "total_mismatch" });
    expect(remote.close).not.toHaveBeenCalled(); expect((await delivery(g)).state).toBe("pending");
  });

  it("manutenção envia contact_id=null e omite auto_post, inclusive lifecycle vinculado", async () => {
    const f = await transport(); await enqueue(f);
    await exec(f.env, "UPDATE module_erp_sources SET links_json=? WHERE profile_id=?", canonical([{ slot: "document", kind: "document", id: uid(), version: 1 }]), f.profile);
    for (const operation of ["cancel", "lifecycle"] as const) {
      const request = await adapter.prepareErpRequest(f.env, { ...f.event, operation });
      expect((request.body.snapshot as any).contact_id).toBeNull(); expect(request.body.policy).not.toHaveProperty("auto_post");
    }
  });

  it("auto_post desligado não suspende manutenção marcada manual por produtor antigo", async () => {
    const f = await transport(); const remote = installFakeErp();
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { stock: false, finance: false } }, uid());
    const event = { ...f.event, operation: "cancel" as const, reason_code: "manual_requested" };
    await enqueue(f, event);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.apply).toHaveBeenCalledTimes(1);
    expect(remote.apply.mock.calls[0][1].body.policy).not.toHaveProperty("auto_post");
  });

  it("API de política projeta por papel, sem referências financeiras para Estoque", async () => {
    const f = await transport(); const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("actor", { ...f.actor, role: "operator", access: ["erp:estoque"] }); await next(); });
    registerIntegrationRoutes(app, async () => Response.json({}));
    const response = await app.request(`/api/v1/profiles/${f.profile}/integrations/commercial-policy`, {}, f.env);
    expect(response.status).toBe(200); const value = await response.json<any>();
    expect(value.auto_post).toEqual({ stock: true });
    for (const field of ["revenue_category_id", "payment_method_id", "settlement_accounts", "consumer_contact_id"]) expect(value).not.toHaveProperty(field);
  });

  it("mapeia divergência de restauração sem expor a mensagem bruta nem tentar novamente", async () => {
    const f = await transport(); await enqueue(f);
    vi.spyOn(hub, "erpFetch").mockResolvedValue(Response.json({ code: "40001", message: "module_sequence_conflict", detail: "SEGREDO" }, { status: 409 }));
    await drainIntegrationOutbox(f.env, f.profile);
    expect(await delivery(f)).toMatchObject({ state: "blocked", error_code: "integration_divergent", error_message: "ERP e fila divergentes (restauração?)" });
    expect(JSON.stringify(await integrationSourceView(f.env, f.actor, f.source))).not.toContain("SEGREDO");
    await due(f); await drainIntegrationOutbox(f.env, f.profile); expect(hub.erpFetch).toHaveBeenCalledTimes(1);
  });

  it("estado público só diz done quando houve confirmação com destino aplicado", () => {
    expect(effectiveSourceState([])).toMatchObject({ state: "none", applied: [] });
    expect(effectiveSourceState([{ state: "done", error_code: "part_disabled" }])).toMatchObject({ state: "skipped", skipped_reason: "part_disabled" });
    expect(effectiveSourceState([{ state: "sending" }])).toMatchObject({ state: "pending" });
    expect(effectiveSourceState([{ state: "uncertain" }])).toMatchObject({ state: "uncertain" });
  });
});
