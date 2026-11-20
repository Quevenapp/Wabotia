import { describe, expect, it, vi, afterEach } from "vitest";
import { ErpHub, ERP_PROFILE_HEADER } from "../src/erp/hub.ts";
import { decodeIdentity, encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../src/erp/engine/identity.ts";
import { normalizeErpParts } from "../src/erp/parts.ts";
import { erpDestinationRequirement, erpRouteRequirement } from "../src/erp/parts-requirements.ts";
import { erpBlockOf, erpRouteExists } from "../src/erp/blocks.ts";
import { createBlingAssembly, forwardBlingOperation, prepareBlingDispatch, handleBlingCallback, handleBlingOperation, runBlingWake, blingFailureResponse, matchBlingOperation } from "../src/erp/bling/assembly.ts";
import { BLING_OPERATIONS, authorizeBlingOperation } from "../src/erp/bling/schema.ts";
import { BLING_ENTITIES, BlingError, type BlingContext, type BlingPublicConfiguration } from "../src/erp/bling/contracts.ts";
import { authorizeOperation } from "../src/erp/bling/permissions.ts";
import type { BlingWakePort } from "../src/erp/bling/ports.ts";
// @ts-ignore Parser original puro, inclusive JSON.rawJSON no workerd.
import { parsePriceJson } from "../src/erp/fagoo/workers/origin-sync/src/price-json.mjs";

const area = "org-base";
const person = "b6000000-0000-4000-8000-000000000001";
const session = "b6000000-0000-4000-8000-000000000002";
const fixedNow = Date.UTC(2026, 10, 19, 15);
const parts = normalizeErpParts({ products: false, sales: false, stock: false, finance: false, fiscal: false, billing: false, pos: false, purchases: false });
const identity = (admin = true, bot = false): IdentityPort => ({
  actor: { user_id: person, name: "Pessoa", email: null, erp_role: admin ? "admin" : "consulta", verified_factor: true, session_id: session, aal: "aal2", is_agent: bot },
  people: [], parts, partsControl: { profile: area, revision: "1", expires_at: fixedNow + 120_000 },
});
const noIo = new Proxy({}, { get() { throw new Error("I/O não autorizado neste teste de fronteira."); } });
const dependencies = { env: noIo as any, storage: noIo as any, readParts: async () => parts };
const context = (bot = false): BlingContext => ({ profile: area, identity: identity(true, bot), origin: "app", clock: { now: () => fixedNow } });

afterEach(() => vi.useRealTimers());

describe("base Receber dados do Bling", () => {
  it("recusa não administrador e partes ausentes antes de qualquer SQL/migração", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(fixedNow);
    const kv = new Map<string, unknown>([["kind", "erp"], ["erp_profile", area]]);
    const storage: any = { get: async (key: string) => kv.get(key), put: async (key: string, value: unknown) => kv.set(key, value),
      transaction: async (fn: any) => fn(storage), get sql() { throw new Error("Não pode carregar/migrar o motor."); } };
    const hub = new ErpHub(noIo as any, { storage, id: { name: `erp:${area}` } } as any);
    const request = (port: IdentityPort) => new Request("https://coordinator/erp-bling/operations/erp_bling_disable", {
      method: "POST", headers: { [ERP_PROFILE_HEADER]: area, [IDENTITY_HEADER]: encodeIdentity(port) },
      body: JSON.stringify({ command_id: "command-disable", expected_revision: "0" }),
    });
    const denied = await hub.handle("/erp-bling/operations/erp_bling_disable", request(identity(false)));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "BLING_ADMIN_REQUIRED" } });
    const absent = identity(); delete absent.partsControl;
    expect((await hub.handle("/erp-bling/operations/erp_bling_disable", request(absent))).status).toBe(503);
    const disabled = identity(); disabled.parts = { ...parts, customers: false }; disabled.partsControl!.revision = "2";
    expect((await hub.handle("/erp-bling/operations/erp_bling_disable", request(disabled))).status).toBe(409);
  });

  for (const operation of Object.values(BLING_OPERATIONS).filter(op => op.name !== "erp_bling_oauth_callback")) {
    it(`${operation.name}: bot configurado usa a política comum; sem configuração e origem externa são recusados`, () => {
      const allowed = context(true);
      allowed.authorization = { request_hash: "a".repeat(64), read_granted: true,
        bot: { id: "bot-equipe", allowed_operations: [operation.name], allowed_entities: ["contacts"], data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: true } };
      const input = { entity: "contacts", command_id: "command-test" };
      expect(() => authorizeBlingOperation(allowed, operation.name, input)).not.toThrow();
      expect(() => authorizeBlingOperation(context(true), operation.name, input)).toThrow();
      expect(() => authorizeBlingOperation({ ...allowed, origin: "external" }, operation.name, input)).toThrow();
      const lowered = { ...allowed, identity: identity(false, true) };
      if (operation.permission === "admin") expect(() => authorizeBlingOperation(lowered, operation.name, input)).toThrow();
    });
  }

  it("as rotas exatas e a tela dependem somente da Base, inclusive XML", () => {
    expect(erpDestinationRequirement("/receber-bling")?.requirement.all).toEqual(["erp"]);
    for (const operation of Object.values(BLING_OPERATIONS)) {
      if (operation.name === "erp_bling_oauth_callback") continue;
      const suffix = operation.path === "/" ? "" : operation.path.replace(/:[A-Za-z_]+/g, "exemplo");
      const path = "/v1/receber-bling" + suffix;
      expect(erpBlockOf(path)).toBe("erp");
      expect(erpRouteExists(operation.method, path)).toBe(true);
      expect(erpRouteRequirement(operation.method, new URL(path + "?entity=nfe", "https://local"))).toEqual({ all: ["erp"] });
      expect(matchBlingOperation(operation.method, path)?.operation.name).toBe(operation.name);
    }
    expect(erpRouteRequirement("POST", new URL("https://local/v1/receber-bling/reservar"))).toBeNull();
    expect(erpRouteRequirement("GET", new URL("https://local/v1/sincronizacao-origin"))).toBe("externo");
  });

  it("montagem incompleta é indisponível; callback e erros nunca devolvem material recebido", async () => {
    await expect(createBlingAssembly()).rejects.toMatchObject({ code: "BLING_DISABLED", status: 503 });
    await expect(createBlingAssembly(dependencies)).rejects.toMatchObject({ code: "BLING_DISABLED", status: 503 });
    const response = await handleBlingOperation({ context: context(), name: "erp_bling_status", input: {} }, dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BLING_DISABLED" } });
    const opaque = crypto.randomUUID();
    const callback = await handleBlingCallback(noIo as any, area, new Request(`https://local/api/public/erp-bling/${area}/callback?code=${opaque}`));
    expect(callback.status).toBe(503);
    expect(await callback.text()).not.toContain(opaque);
    const error = blingFailureResponse(new Error(opaque));
    expect(await error.text()).not.toContain(opaque);
    await expect(runBlingWake(area, dependencies, { eligible: true, nextOperationalAt: null, clock: { now: () => fixedNow } })).rejects.toMatchObject({ code: "BLING_DISABLED", status: 503 });
  });

  it("prévia encaminha confirmação pelo hash; sem confirmação a política no servidor recusa", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(fixedNow);
    const actor: any = { id: person, kind: "user", role: "admin", scopes: [], sessionId: session, via: { bot_id: "bot-equipe", run_id: "run-equipe", proposal_id: "proposta-confirmada" } };
    const persisted = { access: { reader_user_ids: [], bots: [{ bot_id: "bot-equipe", operations: ["erp_bling_purge_preview"],
      entities: [...BLING_ENTITIES], data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: false, mask_personal: true }],
      customer_delivery: { enabled: false, entities: [], require_verified_identity: true } } } as BlingPublicConfiguration;
    let forwarded = 0, granted = true, claimed = true;
    const preview = { scope: { all: true, entities: [] }, generation: "1" };
    const env: any = { DB: { prepare(sql: string) { return { bind(...args: unknown[]) { return { async first() {
      if (sql.includes("SELECT b.remote_profile")) {
        expect(args.slice(0, 4)).toEqual(["bot-equipe", area, "run-equipe", person]);
        return { remote_profile: "default", config: JSON.stringify({ bot_options: { default: { erp_operations: granted ? ["erp_bling_purge_preview"] : [] } } }) };
      }
      if (sql.includes("SELECT path,params FROM bot_proposals")) {
        expect(args).toEqual(["proposta-confirmada", area, person, "bot-equipe", "run-equipe", "POST"]);
        return claimed ? { path: "erp/v1/receber-bling/apagar/previa", params: JSON.stringify(preview) } : null;
      }
      throw new Error("Consulta inesperada.");
    } }; } }; } }, COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch: async (url: string, init: RequestInit) => {
      forwarded++;
      const request = new Request(url, init);
      const call = await prepareBlingDispatch(area, new URL(url).pathname, request, decodeIdentity(request.headers.get(IDENTITY_HEADER)));
      if (forwarded === 1) {
        expect(call.context.authorization?.confirmation?.command_id).toBe(call.context.authorization?.request_hash);
        expect(call.context.authorization?.confirmation?.command_id).toMatch(/^[a-f0-9]{64}$/);
      } else expect(call.context.authorization?.confirmation).toBeUndefined();
      return handleBlingOperation(call, dependencies, { execute: async (ctx, name, input) => {
        // A fronteira não presume a política persistida. A porta verifica a
        // interseção: a concessão do núcleo não supera allow_sensitive=false.
        authorizeOperation(ctx, name, input, persisted, ctx.authorization?.request_hash ?? "b".repeat(64));
        throw new BlingError("BLING_DISABLED", { status: 503 });
      }, callback: async () => { throw new Error("Callback não pertence à prévia."); } });
    } }) } };
    const req = () => new Request(`https://local/api/v1/profiles/${area}/erp/v1/receber-bling/apagar/previa`, {
      method: "POST", body: JSON.stringify({ scope: { all: true, entities: [] }, generation: "1" }),
    });
    const response = await forwardBlingOperation(env, area, actor, identity(true, true), req());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BLING_DISABLED" } });
    expect(forwarded).toBe(1);
    claimed = false;
    expect((await forwardBlingOperation(env, area, actor, identity(true, true), req())).status).toBe(403);
    expect(forwarded).toBe(1);
    claimed = true; granted = false;
    expect((await forwardBlingOperation(env, area, actor, identity(true, true), req())).status).toBe(403);
    expect(forwarded).toBe(1);
    granted = true;
    delete actor.via.proposal_id;
    expect((await forwardBlingOperation(env, area, actor, identity(true, true), req())).status).toBe(403);
    expect(forwarded).toBe(2);
  });

  it("transporte mantém cookie OAuth protegido fora do JSON e serve XML como bytes", async () => {
    const nonce = crypto.randomUUID();
    const api: any = { execute: async (ctx: BlingContext) => {
      ctx.response!.setCookie({ name: "__Host-bling-test", value: nonce, max_age: 600 });
      return { authorization_url: "https://provider.invalid/authorize", expires_at: fixedNow + 600_000 };
    } };
    const response = await handleBlingOperation({ context: context(), name: "erp_bling_oauth_start", input: { command_id: "oauth-command", expected_revision: "0" } }, dependencies, api);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
    expect(await response.text()).not.toContain(nonce);
    const bytes = new TextEncoder().encode("<xml>estrutura simulada</xml>");
    const download = await handleBlingOperation({ context: context(), name: "erp_bling_xml_get", input: { object_id: "object-test" } }, dependencies,
      { execute: async () => ({ bytes, sha256: "a".repeat(64), filename: "nota.xml", content_type: "application/xml" }) } as any);
    expect(download.headers.get("Content-Type")).toBe("application/xml");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("orçamento adia coleta após trabalho operacional e reserva margem antes do vencimento", async () => {
    const seen: unknown[] = [];
    const wake: BlingWakePort = { nextWake: async () => fixedNow, runOne: async (_ctx, options) => {
      seen.push(options); return { worked: true, requests: 1, nextWake: fixedNow + 700 };
    } };
    const options = { eligible: false, nextOperationalAt: fixedNow + 5_000, clock: { now: () => fixedNow } };
    expect((await runBlingWake(area, dependencies, options, wake)).nextWake).toBe(fixedNow + 1_000);
    await runBlingWake(area, dependencies, { ...options, eligible: true, nextOperationalAt: fixedNow + 1_249 }, wake);
    expect(seen).toEqual([]);
    await runBlingWake(area, dependencies, { ...options, eligible: true, nextOperationalAt: fixedNow + 2_000 }, wake);
    expect(seen).toEqual([{ deadline: fixedNow + 1_750, nextOperationalAt: fixedNow + 2_000, maxGets: 1 }]);
    const off = { ...dependencies, readParts: async () => ({ ...parts, customers: false }) };
    await runBlingWake(area, off, { ...options, eligible: true }, { nextWake: async () => { throw new Error("Base desligada não examina trabalho."); }, runOne: wake.runOne });
  });

  it("parser lexical original funciona no Worker com JSON.rawJSON e preserva precisão", async ({ task }) => {
    const lexical = '{"data":{"id":"9007199254740993123","preco":12345678901234567890.123456789}}';
    const parsed = await parsePriceJson(lexical, new TextEncoder().encode(lexical), "product_detail");
    expect(JSON.stringify(parsed)).toBe(lexical);
    task.meta.orgBase = { lexicalPreserved: true, calls: 0, mutations: 0 };
  });
});
