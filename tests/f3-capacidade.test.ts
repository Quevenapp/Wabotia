import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec } from "../src/db";
import { canonical, hash } from "../src/integrations/keys";
import type { PreparedErpRequest } from "../src/integrations/contracts";
import { enqueue, f3Fixture, installFixtureProducer, setParts } from "./helpers/f3-fixtures";
import { verifyModuleTransport, readModuleEvidence, MODULE_RPCS, moduleSystemUser, originScope, withModuleExecution } from "../src/erp/engine/module-origin";
import { GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, decodeIdentity, encodeIdentity, type IdentityPort } from "../src/erp/engine/identity";
import { handleRpc } from "../src/erp/engine/rpc-endpoint";
import { inTransaction } from "../src/erp/engine/registry";
import { systemActorsOf, systemUserId } from "../src/modules/erp/identity";

beforeEach(() => installFixtureProducer());
afterEach(() => vi.restoreAllMocks());

async function prepared() {
  const f = await f3Fixture(); await enqueue(f);
  const actorId = moduleSystemUser("os");
  const request: PreparedErpRequest = { schema: 1, command_id: f.event.command_id, actor_id: actorId, source: f.source,
    seq: f.event.seq, event_hash: hash(f.event), expected: {}, body: { operation: f.event.operation, route: "work", snapshot: f.event.snapshot,
      policy: f.policy, eligible: f.event.eligible, requested: { document: true, stock: true, finance: true }, epochs: f.event.epochs,
      occurred_ms: f.event.occurred_ms, receipt: null, reason_code: null, mode: "system" } };
  await exec(f.env, "INSERT INTO module_erp_requests(event_id,actor_id,request_hash,expected_json,body_json,prepared_ms) VALUES(?,?,?,?,?,?)",
    f.event.id, actorId, hash(request), "{}", canonical(request.body), Date.now());
  const evidence = { profile: f.profile, module: "os" as const, source_id: f.source.source_id, seq: 1, event_id: f.event.id,
    command_id: request.command_id, event_hash: request.event_hash, request_hash: hash(request), mode: "system" as const };
  const identity: IdentityPort = { actor: { user_id: actorId, name: "Sistema · Ordem de Serviço", email: null, erp_role: "vendas", verified_factor: false, session_id: null, aal: "aal1", is_agent: true },
    people: null, module_execution: evidence };
  const args = { p_user_id: actorId, p_request: request, p_evidence: evidence };
  return { ...f, request, evidence, identity, args };
}

describe("F3: fronteira D1 e identidade", () => {
  it("confere pedido persistido e não muda autoria, UUID ou corpo ao renovar partes", async () => {
    const f = await prepared();
    const proof = await verifyModuleTransport(f.env.DB, f.profile, "erp_module_apply", f.args, f.identity);
    expect(proof.request).toEqual(f.request); expect(proof.open).toEqual({ document: true, stock: true, finance: true });
    await setParts(f.profile, { "erp-financeiro": false });
    const off = await verifyModuleTransport(f.env.DB, f.profile, "erp_module_origin_get", f.args, f.identity);
    expect(off.open.finance).toBe(false); expect(off.request).toEqual(proof.request);
    await setParts(f.profile, { "erp-financeiro": true });
    const reopened = await verifyModuleTransport(f.env.DB, f.profile, "erp_module_apply", f.args, f.identity);
    expect(reopened.open.finance).toBe(false);
  });

  it.each(["profile", "module", "source_id", "seq", "event_id", "command_id", "event_hash", "request_hash"])("recusa evidência com %s trocado", async key => {
    const f = await prepared(), evidence = { ...f.evidence, [key]: key === "seq" ? 2 : key.endsWith("hash") ? "0".repeat(64) : key === "module" ? "pedido" : crypto.randomUUID() };
    await expect(verifyModuleTransport(f.env.DB, f.profile, "erp_module_apply", { ...f.args, p_evidence: evidence }, { ...f.identity, module_execution: evidence } as IdentityPort))
      .rejects.toMatchObject({ code: "42501", message: "module_origin_denied" });
  });

  it.each(["body", "actor_id", "expected", "source"])("recusa pedido com %s substituído depois de persistido", async key => {
    const f = await prepared(), request = { ...f.request, [key]: key === "actor_id" ? crypto.randomUUID() : { injected: true } };
    await expect(verifyModuleTransport(f.env.DB, f.profile, "erp_module_apply", { ...f.args, p_request: request }, f.identity)).rejects.toMatchObject({ code: "42501" });
  });

  it("preserva o cadastro da fase 1 e valida o formato da marca F3", async () => {
    const f = await prepared(), contact = crypto.randomUUID();
    const envelope = { ...f.identity, customer_privacy: { restricted_contact_ids: [contact] } };
    const decoded = decodeIdentity(encodeIdentity(envelope));
    expect(decoded.module_execution).toEqual(f.evidence); expect(decoded.customer_privacy).toEqual(envelope.customer_privacy);
    expect(readModuleEvidence({ ...f.evidence, seq: -1 })).toBeUndefined();
    expect(decodeIdentity(encodeIdentity({ ...envelope, module_execution: { ...f.evidence, mode: "admin" } })).actor).toBeNull();
    expect(await systemUserId("os")).toBe(moduleSystemUser("os"));
    const actors = systemActorsOf([{ id: "os", name: "Trabalhos" }, { id: "pedido", name: "Pedido" }], { erp: true, os: true, pedido: true });
    expect(actors.map(([, a]) => a.role)).toEqual(["vendas", "vendas"]);
  });

  it.each(MODULE_RPCS)("%s não aceita cabeçalho de navegador ou prova sem D1", async name => {
    const f = await prepared();
    const headers = { [IDENTITY_HEADER]: encodeIdentity(f.identity), [GATE_HEADER]: "1", "Content-Type": "application/json" };
    const state = {} as DurableObjectState;
    const body = canonical({ ...f.args, ...(name.endsWith("close") ? { p_reason_code: "replace_request" } : {}) });
    const outside = await handleRpc(state, f.profile, name, new Request("https://internal/", { method: "POST", headers, body }), undefined, f.env.DB);
    expect(outside.status).toBe(403);
    const withoutD1 = await handleRpc(state, f.profile, name, new Request("https://internal/", { method: "POST", headers: { ...headers, [SYSTEM_HEADER]: "1" }, body }));
    expect(withoutD1.status).toBe(403); expect(await withoutD1.json()).toMatchObject({ message: "module_origin_denied" });
  });

  it("objeto desserializado, inclusive cópia de prova real, não cria capacidade", async () => {
    const f = await prepared(), proof = await verifyModuleTransport(f.env.DB, f.profile, "erp_module_apply", f.args, f.identity);
    const db = { exec: (sql: string) => ({ rows: sql.includes("erp_access__membership") ? [{ active: 1 }] : [], rowsRead: 0, rowsWritten: 0 }), transaction: <T>(fn: () => T) => fn() };
    inTransaction(db, ctx => {
      expect(() => withModuleExecution(ctx, "erp_module_apply", f.args, structuredClone(proof), () => null)).toThrow("module_origin_denied");
      expect(originScope(ctx)).toBeUndefined();
      expect(() => withModuleExecution(ctx, "erp_module_apply", f.args, proof, () => { throw new Error("interrupted"); })).toThrow("interrupted");
      expect(originScope(ctx)).toBeUndefined();
    }, undefined, { identity: f.identity });
  });
});
