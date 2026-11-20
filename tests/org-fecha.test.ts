import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { storageDriver, type SqlDriver } from "../src/erp/engine/driver.ts";
import { migrate } from "../src/erp/schema/migrate.ts";
import { normalizeErpParts } from "../src/erp/parts.ts";
import { createMountedBlingAssembly, nextBlingWake, runBlingWake } from "../src/erp/bling/assembly.ts";
import { createBlingVault } from "../src/erp/bling/vault.ts";
import { BLING_RESOURCES, BLING_XML_RESOURCE } from "../src/erp/bling/resources.ts";
import type { BlingContext, ResourceDescriptor } from "../src/erp/bling/contracts.ts";
// @ts-ignore Simuladores em memória: não há socket nem fetch global.
import { FakeBling, FakeClock } from "./erp/org/fake-bling.mjs";
// @ts-ignore OAuth falso é uma porta separada do servidor GET.
import { FakeOAuth } from "./erp/org/fake-oauth.mjs";
// @ts-ignore A mesma allowlist protege o teste integrado Node e o Worker.
import { COLLECTION_WRITE_TABLES, guardCollectionDriver } from "./erp/org/contract-checks.mjs";

const fixedNow = Date.UTC(2026, 10, 19, 12);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function snapshot(db: SqlDriver, names: string[]) {
  return Object.fromEntries(names.map(name => [name, db.exec(`SELECT * FROM ${quote(name)}`).rows.map(row => JSON.stringify(row)).sort()]));
}
const opaque = () => crypto.randomUUID() + crypto.randomUUID();
const privateAbsent = (value: unknown, values: string[]) => {
  const text = JSON.stringify(value);
  for (const secret of values) expect(text.includes(secret)).toBe(false);
};

describe("aceite da montagem no Coordinator", () => {
  it("alarme sem coleta nem limpeza pendente não lê D1/R2 nem monta transporte", async ({ task }) => {
    const profile = `org-fecha-idle-${crypto.randomUUID()}`;
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(`erp:${profile}`));
    const report = await runInDurableObject(stub, async (_instance, state) => {
      migrate(state.storage);
      const db = storageDriver(state.storage), clock = { now: () => fixedNow };
      const parts = normalizeErpParts({});
      const noIo = new Proxy({}, { get() { throw new Error("Alarme inativo não acessa dependências externas."); } });
      const dependencies = { env: noIo as typeof env, storage: state.storage, profile,
        readParts: async () => parts, readSnapshot: async () => ({ profile, revision: "1", expires_at: fixedNow + 120000, parts }) };
      const options = { eligible: true, nextOperationalAt: fixedNow + 60000, clock };
      expect(await nextBlingWake(profile, dependencies, fixedNow + 1000, clock)).toBeNull();
      expect(await runBlingWake(profile, dependencies, options)).toEqual({ worked: false, requests: 0, nextWake: null });
      db.exec("INSERT INTO wb_bling_control(updated_at) VALUES(?)", fixedNow);
      const baseline = snapshot(db, ["wb_bling_control", "wb_bling_unit", "wb_bling_audit"]);
      expect(await nextBlingWake(profile, dependencies, fixedNow + 1000, clock)).toBeNull();
      expect(await runBlingWake(profile, dependencies, options)).toEqual({ worked: false, requests: 0, nextWake: null });
      expect(snapshot(db, ["wb_bling_control", "wb_bling_unit", "wb_bling_audit"])).toEqual(baseline);
      return { checkedStates: ["absent", "off"], externalCalls: 0, scheduleChanged: false };
    });
    task.meta.orgFechaIdle = report;
  }, 120_000);

  it("API, OAuth/cofre, alarme e acervo reais completam uma coleta sem escrita operacional", async ({ task }) => {
    const profile = `org-fecha-${crypto.randomUUID()}`;
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(`erp:${profile}`));
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("HTTP fora do simulador."); });
    try {
      const report = await runInDurableObject(stub, async (_instance, state) => {
        migrate(state.storage);
        const rawDb = storageDriver(state.storage);
        const tables = rawDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map(row => String(row.name));
        const operational = tables.filter(name => !COLLECTION_WRITE_TABLES.includes(name));
        const baseline = snapshot(rawDb, operational);
        const writes: { operation: string; table: string }[] = [];
        const db = guardCollectionDriver(rawDb, writes) as SqlDriver;
        const clock = new FakeClock(fixedNow), fake = new FakeBling({ clock }), oauth = new FakeOAuth({ clock });
        fake.resource("/contatos", [{ id: "9007199254740993123", nome: "Contato simulado" }]);
        const parts = normalizeErpParts({ products: false, sales: false, stock: false, finance: false, fiscal: false, purchases: false, pos: false, billing: false });
        const partsSnapshot = { profile, revision: "1", expires_at: fixedNow + 120000, parts };
        const cookies: { name: string; value: string; max_age: number }[] = [];
        const identity = {
          actor: { user_id: crypto.randomUUID(), session_id: crypto.randomUUID(), name: "Dona", email: null, erp_role: "admin" as const, aal: "aal2" as const, verified_factor: true, is_agent: false },
          people: [], parts, partsControl: { profile, revision: "1", expires_at: partsSnapshot.expires_at },
        };
        const ctx: BlingContext = { profile, identity, origin: "app", clock, response: { setCookie: cookie => { cookies.push(cookie); } } };
        const evidence = { url: "https://official.invalid/simulated-evidence", checked_at: new Date(fixedNow).toISOString(), scopes_checked: true, identity_checked: true, limits_checked: true };
        const resources: ResourceDescriptor[] = [...BLING_RESOURCES, BLING_XML_RESOURCE].map(resource => resource.confirmation === "nao_confirmado" ? resource : { ...resource, confirmation: "oficial_confirmado", officialEvidence: evidence });
        const files = new Map<string, Uint8Array>();
        const vault = createBlingVault(env);
        const mounted = createMountedBlingAssembly({ profile, db, databaseSize: () => state.storage.sql.databaseSize,
          readParts: async () => partsSnapshot, session: async current => structuredClone(current.identity), vault, provider: oauth,
          accountProof: { evidence: { url: evidence.url, checked_at: evidence.checked_at, read_only: true }, identify: async () => ({ id: oauth.accountId, name: "Empresa simulada", confirmed_at: new Date(clock.now()).toISOString() }) },
          publicOrigin: "https://installation.invalid", authorizationEndpoint: "https://oauth.invalid/authorize", readScopes: [], resources,
          fetch: fake.fetch, baseUrl: fake.baseUrl,
          media: { put: async (key, bytes) => { files.set(key, bytes.slice()); }, get: async key => { const bytes = files.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer } : null; }, delete: async key => { files.delete(key); } },
        });
        const status = () => mounted.api.execute(ctx, "erp_bling_status", {});
        const command = async () => ({ command_id: crypto.randomUUID(), expected_revision: (await status()).configuration.revision });
        expect((await status()).state).toBe("off");
        const configure = await mounted.api.execute(ctx, "erp_bling_configure", { ...await command(),
          selections: [{ key: "contacts", selected: true, from: null, to: null }], daily_call_limit: 300,
          access: { reader_user_ids: [], bots: [{ bot_id: "bot-equipe", operations: ["erp_bling_record_get"], entities: ["contacts"], data_scopes: ["public", "personal", "sensitive", "raw"], allow_sensitive: false, mask_personal: false }], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } }, ai_disclosure_acknowledged: true });
        expect(configure.configuration.collect_enabled).toBe(false);
        const application = { client_id: opaque(), client_secret: opaque() };
        const saved = await mounted.api.execute(ctx, "erp_bling_app_save", { ...await command(), ...application });
        expect(saved.callback_url).toBe(`https://installation.invalid/api/public/erp-bling/${profile}/callback`);
        const enabled = await mounted.api.execute(ctx, "erp_bling_enable", { ...await command(), warning_confirmed: true, checklist_hash: "a".repeat(64) });
        expect(enabled.configuration.collect_enabled).toBe(true);
        const started = await mounted.api.execute(ctx, "erp_bling_oauth_start", await command());
        const code = opaque(), browser = cookies.at(-1)!;
        expect(browser.max_age).toBe(600);
        const callback = await mounted.api.callback(ctx, { state: new URL(started.authorization_url).searchParams.get("state")!, code, browser_nonce: browser.value, callback_url: saved.callback_url });
        expect(callback).toEqual({ state: "authorized", redirect: "/receber-bling", clear_cookie: true });
        expect(oauth.callCount).toBe(1);
        const collectInput = { ...await command(), resource_keys: ["contacts"] };
        const collection = await mounted.api.execute(ctx, "erp_bling_collect_request", collectInput);
        const internal: BlingContext = { profile, origin: "internal", clock, identity: { actor: null, people: [] } };
        const dependencies = { env, storage: state.storage, readParts: async () => parts };
        const beforePriority = fake.callCount;
        const priority = await runBlingWake(profile, dependencies, { eligible: false, nextOperationalAt: clock.now() + 100, clock }, mounted.wake);
        expect(priority.worked).toBe(false);
        expect(fake.callCount).toBe(beforePriority);
        let wakes = 0;
        while (!rawDb.exec("SELECT source_id FROM origin_sync__raw_record WHERE entity='contacts'").rows.length && wakes < 30) {
          const due = await mounted.wake.nextWake(internal);
          expect(due).not.toBeNull();
          clock.set(Math.max(clock.now(), due!));
          const before = fake.callCount;
          const result = await mounted.wake.runOne(internal, { deadline: clock.now() + 4000, nextOperationalAt: null, maxGets: 1 });
          expect(fake.callCount - before).toBeLessThanOrEqual(1);
          expect(result.requests).toBeLessThanOrEqual(1);
          clock.advance(1000); wakes++;
        }
        expect(wakes).toBeLessThan(30);
        const record = await mounted.api.execute(ctx, "erp_bling_record_get", { entity: "contacts", id: "9007199254740993123" });
        expect(record.raw.payload_text).toContain("Contato simulado");
        expect(record.historical.label).toBe("Consulta histórica — não opera no ERP");
        const checkpoints = snapshot(rawDb, ["origin_sync__resource_state"]);
        expect((await mounted.api.execute(ctx, "erp_bling_collect_request", collectInput)).receipt).toEqual(collection.receipt);
        expect(snapshot(rawDb, ["origin_sync__resource_state"])).toEqual(checkpoints);
        const bot: BlingContext = { ...ctx, identity: { ...identity, actor: { ...identity.actor, is_agent: true } }, authorization: { bot: { id: "bot-equipe", allowed_operations: ["erp_bling_record_get"], allowed_entities: ["contacts"], data_scopes: ["public", "personal", "sensitive", "raw"], allow_sensitive: false } } };
        const args = { entity: "contacts" as const, id: "9007199254740993123" };
        expect((await mounted.api.execute(bot, "erp_bling_record_get", args)).raw.payload_text).toBe(record.raw.payload_text);
        await expect(mounted.api.execute({ ...bot, authorization: undefined }, "erp_bling_record_get", args)).rejects.toMatchObject({ code: "BLING_SCOPE_REQUIRED" });
        await expect(mounted.api.execute({ ...bot, origin: "external" }, "erp_bling_record_get", args)).rejects.toMatchObject({ code: "BLING_ADMIN_REQUIRED" });
        await expect(mounted.api.execute({ ...ctx, profile: "outra-area" }, "erp_bling_record_get", args)).rejects.toMatchObject({ code: "BLING_SCOPE_REQUIRED" });
        await expect(mounted.api.execute({ ...ctx, identity: { ...identity, actor: { ...identity.actor, erp_role: "consulta" } } }, "erp_bling_disable", await command())).rejects.toMatchObject({ code: "BLING_ADMIN_REQUIRED" });
        await mounted.api.execute(ctx, "erp_bling_disable", await command());
        const calls = fake.callCount;
        expect((await mounted.wake.runOne(internal, { deadline: clock.now() + 4000, nextOperationalAt: null, maxGets: 1 })).requests).toBe(0);
        expect(fake.callCount).toBe(calls);
        expect(snapshot(rawDb, operational)).toEqual(baseline);
        expect(rawDb.exec("PRAGMA foreign_key_check").rows).toEqual([]);
        expect(writes.length).toBeGreaterThan(0);
        fake.assertReadOnly();
        const credential = (await vault.read(profile)).value.credential!;
        privateAbsent([snapshot(rawDb, tables), saved, collection, callback, record, await status(), fake.calls],
          [application.client_id, application.client_secret, credential.access_token, credential.refresh_token, code, browser.value]);
        return { wakes, calls: fake.callCount, oauthExchanges: oauth.callCount, mutations: fake.mutations, operationalTables: operational.length,
          operationalContentUnchanged: true, configuredBot: true, externalDenied: true, disabledRequests: 0 };
      });
      expect(report.calls).toBeGreaterThan(0);
      expect(globalFetch).not.toHaveBeenCalled();
      task.meta.orgFecha = report;
    } finally { globalFetch.mockRestore(); }
  }, 120_000);
});
