import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { storageDriver } from "../src/erp/engine/driver.ts";
import { migrate } from "../src/erp/schema/migrate.ts";
import { normalizeErpParts } from "../src/erp/parts.ts";
import type { BlingContext, BlingRawRecord, BlingUnit } from "../src/erp/bling/contracts.ts";
import { BLING_LEGACY_ENTITIES } from "../src/erp/bling/contracts.ts";
import { BLING_RESOURCES } from "../src/erp/bling/resources.ts";
import { parseBlingResponse, createBlingDataClient } from "../src/erp/bling/client.ts";
import { createCollectionStore, semanticHash } from "../src/erp/bling/repository.ts";
// @ts-ignore Simulador puro da fatia; não abre socket nem chama fetch global.
import { FakeBling, FakeClock } from "./erp/org/fake-bling.mjs";

const fixedNow = Date.UTC(2026, 10, 19, 12);
const expected = { generation: "1", authorization_revision: "1", credential_revision: "1", configuration_revision: "1", account_id: "account", parts_revision: "1" };
const parts = normalizeErpParts({ products: false, sales: false, purchases: false, stock: false, finance: false, fiscal: false, billing: false, pos: false });

describe("coleta no runtime Worker", () => {
  it("captura lexical original conserva precisão e IDs antes de materializar números", async ({ task }) => {
    const text = '{"data":{"id":90071992547409931234567890,"preco":12345678901234567890.123456789}}';
    const parsed = await parseBlingResponse("products", "/produtos/90071992547409931234567890", new TextEncoder().encode(text));
    expect(parsed.items[0].id).toBe("90071992547409931234567890");
    expect(parsed.items[0].payload_text).toContain("12345678901234567890.123456789");
    expect(parsed.items[0].capture?.values).toContainEqual({ path: "/preco", lexeme: "12345678901234567890.123456789" });
    expect(BLING_RESOURCES.filter(resource => BLING_LEGACY_ENTITIES.includes(resource.entity as typeof BLING_LEGACY_ENTITIES[number]))).toHaveLength(18);
    task.meta.orgColeta = { lexicalPreserved: true, legacyEntities: 18, calls: 0, mutations: 0 };
  });

  it("uma chamada de dados é GET e erro remoto nunca devolve a credencial", async ({ task }) => {
    const clock = new FakeClock(fixedNow), fake = new FakeBling({ clock });
    const secret = crypto.randomUUID();
    const ctx: BlingContext = { profile: "org-coleta", origin: "internal", clock, identity: { actor: null, people: [] } };
    const resources = BLING_RESOURCES.map(resource => resource.confirmation === "nao_confirmado" ? resource : { ...resource, confirmation: "oficial_confirmado" as const, officialEvidence: { url: "https://example.invalid/evidence", checked_at: new Date(fixedNow).toISOString(), scopes_checked: true, identity_checked: true, limits_checked: true } });
    const client = createBlingDataClient({ fetch: fake.fetch, baseUrl: fake.baseUrl, resources, revalidate: async () => {}, authorization: {
      privateCredential: async () => ({ client_id: crypto.randomUUID(), client_secret: crypto.randomUUID(), access_token: secret, refresh_token: crypto.randomUUID(), expires_at: fixedNow + 3600_000, scopes: [] }),
    } });
    fake.queue({ status: 503, body: JSON.stringify({ message: secret }) });
    const result = await client.get(ctx, { method: "GET", resource_key: "contacts", path: "/contatos/1", query: {}, expected, deadline: fixedNow + 3000 });
    expect(result.kind).toBe("retry");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fake.callCount).toBe(1);
    expect(fake.calls.every((call: { method: string }) => call.method === "GET")).toBe(true);
    fake.assertReadOnly();
    task.meta.orgColeta = { calls: fake.callCount, mutations: fake.mutations, sanitized: true };
  });

  it("SQLite do Coordinator confirma histórico/inbox/checkpoint/recibo atomicamente e reapresenta recibo", async ({ task }) => {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(`erp:org-coleta-${crypto.randomUUID()}`));
    const report = await runInDurableObject(stub, (_instance, state) => {
      migrate(state.storage);
      const db = storageDriver(state.storage);
      const clock = { now: () => fixedNow };
      const ctx: BlingContext = { profile: "org-coleta", origin: "internal", clock, identity: { actor: null, people: [], parts, partsControl: { profile: "org-coleta", revision: "1", expires_at: fixedNow + 120000 } } };
      db.exec(`INSERT INTO wb_bling_control(id,revision,generation,authorization_revision,credential_revision,collect_enabled,state,account_id,selection,approved_by,approved_at,approval_hash,credential_status,updated_at)
        VALUES(1,1,1,1,1,1,'ready','account',?,'administrator',?,?,'ready',?)`, JSON.stringify([{ key: "contacts", selected: true, from: null, to: null }]), fixedNow, "a".repeat(64), fixedNow);
      let serial = 0;
      const writes: string[] = [];
      const store = createCollectionStore({ db: { ...db, exec(sql, ...params) {
        if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
        return db.exec(sql, ...params);
      } }, randomId: () => `unit-${++serial}`, databaseSize: () => state.storage.sql.databaseSize });
      const identity = { profile: ctx.profile, account_id: "account", entity: "contacts" as const, source_id: "1" };
      const apply = (name: string) => {
        const previous = store.readCurrent(ctx, identity), checkpoint = store.checkpoint("contacts"), suffix = ++serial;
        const queued: BlingUnit = { work_id: `work-${suffix}`, attempt_id: `attempt-${suffix}`, command_id: `command-${suffix}`, request_hash: String(suffix).padStart(64, "0"), kind: "detail", entity: "contacts", source_id: "1", resource_key: "contacts", phase: "queued", expected, checkpoint, lease: null, not_before: fixedNow, plan: {}, page: null, progress: {} };
        const unit = store.markFetching(ctx, store.reserve(ctx, { unit: queued, owner: "worker", lease_until: fixedNow + 4000 }).unit);
        const payload_text = JSON.stringify({ id: "1", nome: name });
        const record: BlingRawRecord = { identity, payload_text, semantic_hash: semanticHash(payload_text, []), version: String(Number(previous?.version ?? 0) + 1), document_links: [], observed_at: new Date(fixedNow).toISOString(), source_updated_at: null, source_time_quality: "unknown", deleted: false, deletion_evidence: null, capture: null };
        const input = { unit, expected, fence: unit.lease!.fence, request_hash: unit.request_hash, records: [record], next_checkpoint: { ...checkpoint, revision: String(Number(checkpoint.revision) + 1), cursor: { suffix } }, source_expectations: [{ identity, version: previous?.version ?? null, semantic_hash: previous?.semantic_hash ?? null }], counts: { observed: 1 } };
        const receipt = store.commitBatch(ctx, input);
        expect(store.commitBatch(ctx, input)).toEqual(receipt);
      };
      apply("A"); apply("B"); apply("A");
      expect(store.readCurrent(ctx, identity)?.version).toBe("3");
      const history = db.exec("SELECT source_version,payload FROM erp_document_mirror__source_version WHERE entity='contacts' AND source_id='1' ORDER BY source_version").rows;
      expect(history.map(row => JSON.parse(String(row.payload)).nome)).toEqual(["A", "B"]);
      expect(db.exec("SELECT COUNT(*) AS n FROM erp_sync__inbox WHERE entity='contacts' AND source_id='1'").rows[0].n).toBe(1);
      expect(db.exec("SELECT observed_count FROM wb_bling_control").rows[0].observed_count).toBe(3);
      expect(writes.every(sql => !/erp_sync__(?:link|outbox)|erp_document__|erp_finance__|erp_stock__/i.test(sql))).toBe(true);
      return { currentVersion: 3, historicalVersions: history.length, inbox: 1, receiptsReplayed: 3, calls: 0, mutations: 0 };
    });
    expect(report.historicalVersions).toBe(2);
    task.meta.orgColeta = report;
  });
});
