import { describe, expect, it } from "vitest";
import { normalizeErpParts } from "../src/erp/parts.ts";
import {
  BLING_ENTITIES, BLING_OPERATION_NAMES, BlingError,
  type BlingContext, type BlingDataScope, type BlingOperationMap, type BlingOperationName,
  type BlingPublicConfiguration, type BlingRecordView,
} from "../src/erp/bling/contracts.ts";
import type { BlingApiPort } from "../src/erp/bling/ports.ts";
import { BLING_OPERATIONS, BLING_MODULE_CONTRACT } from "../src/erp/bling/schema.ts";
import { authorizeOperation, protectOperationOutput, sanitizeBlingError } from "../src/erp/bling/permissions.ts";
import {
  BLING_OPERATION_DESCRIPTORS, BLING_OPENAPI, matchPublicBlingRoute,
  handlePublicBlingRequest, handlePublicBlingCallback,
} from "../src/erp/bling/routes.ts";

const area = "org-api";
const userId = "b7000000-0000-4000-8000-000000000001";
const sessionId = "b7000000-0000-4000-8000-000000000002";
const now = Date.UTC(2026, 10, 19, 15);
const at = new Date(now).toISOString();
const requestHash = "a".repeat(64);
const otherHash = "b".repeat(64);
const parts = normalizeErpParts({ products: false, sales: false, purchases: false, stock: false, finance: false, fiscal: false, billing: false, pos: false });

function configuration(): BlingPublicConfiguration {
  return {
    revision: "1", generation: "1", authorization_revision: "1", collect_enabled: true,
    account: { id: "account-1", name: "Empresa", confirmed_at: at }, selections: [],
    daily_call_limit: 20000, min_interval_ms: 700,
    access: {
      reader_user_ids: [],
      bots: [{ bot_id: "bot-equipe", operations: [...BLING_OPERATION_NAMES], entities: [...BLING_ENTITIES],
        data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: true, mask_personal: false }],
      customer_delivery: { enabled: false, entities: [], require_verified_identity: true },
    },
    approval: { approved_at: at, approved_by: userId, checklist_hash: requestHash },
    credential: { configured: true, authorized: true, revision: "1", expires_at: now + 3600000, scopes: [], uncertain: false },
  };
}

function context(bot = true): BlingContext {
  return {
    profile: area, origin: "app", clock: { now: () => now },
    identity: {
      actor: { user_id: userId, name: "Pessoa", email: null, erp_role: "admin", session_id: sessionId,
        aal: "aal2", verified_factor: true, is_agent: bot },
      people: [], parts, partsControl: { profile: area, revision: "1", expires_at: now + 120000 },
    },
    authorization: {
      request_hash: requestHash,
      ...(bot ? { bot: { id: "bot-equipe", allowed_operations: [...BLING_OPERATION_NAMES], allowed_entities: [...BLING_ENTITIES],
        data_scopes: ["public", "personal", "sensitive", "raw", "xml"] as BlingDataScope[], allow_sensitive: true } } : {}),
    },
  };
}

function inputFor(name: BlingOperationName): BlingOperationMap[BlingOperationName]["input"] {
  const command = { command_id: "command-1", expected_revision: "1" };
  switch (name) {
    case "erp_bling_status": case "erp_bling_resources": return {};
    case "erp_bling_configure": return { ...command, selections: [], daily_call_limit: 20000, access: configuration().access, ai_disclosure_acknowledged: true };
    case "erp_bling_app_save": return { ...command, client_id: crypto.randomUUID(), client_secret: crypto.randomUUID() };
    case "erp_bling_enable": return { ...command, warning_confirmed: true, checklist_hash: requestHash };
    case "erp_bling_disable": case "erp_bling_oauth_start": case "erp_bling_disconnect": return command;
    case "erp_bling_oauth_callback": return { state: crypto.randomUUID(), code: crypto.randomUUID(), browser_nonce: crypto.randomUUID(), callback_url: `https://instalacao.invalid/api/public/erp-bling/${area}/callback` };
    case "erp_bling_collect_request": return { ...command, resource_keys: ["products"] };
    case "erp_bling_records_list": return { entity: "products", limit: 50 };
    case "erp_bling_record_get": return { entity: "products", id: "90071992547409931234" };
    case "erp_bling_versions_list": return { entity: "products", id: "90071992547409931234", limit: 50 };
    case "erp_bling_xml_list": return { entity: "nfe", limit: 50 };
    case "erp_bling_xml_get": return { object_id: "xml-1" };
    case "erp_bling_purge_preview": return { generation: "1", scope: { all: true, entities: [] } };
    case "erp_bling_purge_apply": return { ...command, generation: "1", scope: { all: true, entities: [] }, preview_hash: requestHash, confirmed: true };
    case "erp_bling_command_get": return { id: "command-1" };
  }
}

const apiStub = (execute: (...args: any[]) => any, callback?: (...args: any[]) => any) => ({ execute, callback: callback ?? (() => { throw new Error("Callback inesperado."); }) }) as BlingApiPort;
const publicUrl = (suffix = "") => `https://instalacao.invalid/api/v1/profiles/${area}/erp/v1/receber-bling${suffix}`;

describe("operações e permissões do recebimento do Bling", () => {
  for (const name of BLING_OPERATION_NAMES) {
    it(`${name}: permite bot configurado, recusa ausência de configuração e origem externa`, () => {
      const ctx = context(), config = configuration(), input = inputFor(name);
      expect(BLING_OPERATIONS[name].input.safeParse(input).success).toBe(true);
      expect(() => authorizeOperation(ctx, name, input, config, requestHash)).not.toThrow();
      const disabled = context(); disabled.authorization!.bot!.allowed_operations = [];
      expect(() => authorizeOperation(disabled, name, input, config, requestHash)).toThrow();
      const withoutEnvelope = context(); delete withoutEnvelope.authorization!.bot;
      expect(() => authorizeOperation(withoutEnvelope, name, input, config, requestHash)).toThrow();
      expect(() => authorizeOperation({ ...ctx, origin: "external" }, name, input, config, requestHash)).toThrow();
      if (BLING_OPERATIONS[name].permission !== "archive_read") {
        const lower = context(); lower.identity.actor!.erp_role = "consulta";
        expect(() => authorizeOperation(lower, name, input, config, requestHash)).toThrow();
      }
    });
  }

  it("a confirmação humana se vincula à operação, comando, hash, pessoa e validade", () => {
    const name = "erp_bling_disable", input = inputFor(name), cfg = configuration(), ctx = context();
    cfg.access.bots[0].allow_sensitive = false;
    ctx.authorization!.bot!.allow_sensitive = false;
    expect(() => authorizeOperation(ctx, name, input, cfg, requestHash)).toThrow();
    const confirmation = { operation: name as typeof name, command_id: "command-1", request_hash: requestHash, confirmed_by: userId, expires_at: now + 60000 };
    ctx.authorization!.confirmation = confirmation;
    expect(() => authorizeOperation(ctx, name, input, cfg, requestHash)).not.toThrow();
    for (const changed of [
      { operation: "erp_bling_enable" }, { command_id: "another-command" }, { request_hash: otherHash },
      { confirmed_by: sessionId }, { expires_at: now },
    ]) {
      ctx.authorization!.confirmation = { ...confirmation, ...changed } as typeof confirmation;
      expect(() => authorizeOperation(ctx, name, input, cfg, requestHash)).toThrow();
    }
    ctx.authorization!.confirmation = confirmation;
    expect(() => authorizeOperation(ctx, name, input, cfg, otherHash)).toThrow();
    ctx.authorization!.bot!.allow_sensitive = true;
    delete ctx.authorization!.confirmation;
    expect(() => authorizeOperation(ctx, name, input, cfg, requestHash)).toThrow();
    cfg.access.bots[0].allow_sensitive = true;
    expect(() => authorizeOperation(ctx, name, input, cfg, requestHash)).not.toThrow();
  });

  it("prévia e callback também aceitam proposta confirmada pelo hash integral", () => {
    for (const name of ["erp_bling_purge_preview", "erp_bling_oauth_callback"] as const) {
      const cfg = configuration(), ctx = context();
      cfg.access.bots[0].allow_sensitive = false; ctx.authorization!.bot!.allow_sensitive = false;
      ctx.authorization!.confirmation = { operation: name, command_id: requestHash, request_hash: requestHash,
        confirmed_by: userId, expires_at: now + 60000 };
      expect(() => authorizeOperation(ctx, name, inputFor(name), cfg, requestHash)).not.toThrow();
      ctx.authorization!.confirmation.command_id = otherHash;
      expect(() => authorizeOperation(ctx, name, inputFor(name), cfg, requestHash)).toThrow();
    }
  });

  it("leitura exige concessão persistida e a pessoa continua sendo teto do bot", () => {
    const cfg = configuration(), ctx = context(false);
    ctx.identity.actor!.erp_role = "consulta";
    ctx.authorization!.read_granted = true;
    expect(() => authorizeOperation(ctx, "erp_bling_records_list", { entity: "products" }, cfg, requestHash)).toThrow();
    cfg.access.reader_user_ids = [userId];
    expect(() => authorizeOperation(ctx, "erp_bling_records_list", { entity: "products" }, cfg, requestHash)).not.toThrow();
    const bot = context(); bot.identity.actor!.erp_role = "consulta";
    expect(() => authorizeOperation(bot, "erp_bling_records_list", { entity: "products" }, cfg, requestHash)).not.toThrow();
    expect(() => authorizeOperation(bot, "erp_bling_disable", inputFor("erp_bling_disable"), cfg, requestHash)).toThrow();
    cfg.access.bots[0].entities = ["contacts"];
    expect(() => authorizeOperation(bot, "erp_bling_records_list", { entity: "products" }, cfg, requestHash)).toThrow();
    cfg.access.bots[0].entities = [...BLING_ENTITIES];
    bot.authorization!.bot!.allowed_entities = ["contacts"];
    expect(() => authorizeOperation(bot, "erp_bling_records_list", { entity: "products" }, cfg, requestHash)).toThrow();
  });

  it("recusa área trocada, Base desligada e concessão ou sessão vencida/ausente", () => {
    const cfg = configuration();
    const mutations: ((ctx: BlingContext) => void)[] = [
      ctx => { ctx.profile = "outra-area"; },
      ctx => { ctx.identity.parts = { ...parts, customers: false }; },
      ctx => { ctx.identity.partsControl!.expires_at = now; },
      ctx => { ctx.identity.actor!.session_id = null; },
      ctx => { delete ctx.identity.partsControl; },
    ];
    for (const mutate of mutations) {
      const ctx = context(false); mutate(ctx);
      expect(() => authorizeOperation(ctx, "erp_bling_status", {}, cfg, requestHash)).toThrow();
    }
  });

  it("IA recebe bruto e espelho sob a mesma política; máscara preserva apenas metadados", () => {
    const cfg = configuration(), ctx = context();
    const identity = { profile: area, account_id: "account-1", entity: "products" as const, source_id: "1" };
    const privateText = crypto.randomUUID();
    const view: BlingRecordView = {
      raw: { identity, version: "1", semantic_hash: requestHash, payload_text: JSON.stringify({ observacoes: privateText }),
        document_links: [{ text: privateText }], observed_at: at, source_updated_at: null, source_time_quality: "observed", deleted: false, deletion_evidence: null, capture: null },
      metadata: { identity, version: "1", semantic_hash: requestHash, payload_bytes: 100, first_observed_at: at, last_observed_at: at,
        source_updated_at: null, source_time_quality: "observed", deleted: false, mapper_version: "v1", capture_revision: null },
      historical: { label: "Consulta histórica — não opera no ERP", kind: "products", fields: { observacoes: privateText },
        unresolved_references: [{ text: privateText }], unmapped_fields: [privateText],
        coverage: { complete: false, observed: 1, changed: 1, pending: 0, last_pass_started_at: null, last_pass_completed_at: null, freshness_at: null, limitations: [] } },
      existing_links: [{ text: privateText }],
    };
    expect(JSON.stringify(protectOperationOutput(ctx, "erp_bling_record_get", view, cfg))).toContain(privateText);
    cfg.access.bots[0].mask_personal = true;
    const masked = protectOperationOutput(ctx, "erp_bling_record_get", view, cfg);
    expect(JSON.stringify(masked)).not.toContain(privateText);
    expect(masked.metadata.identity).toEqual(identity);
    expect(BLING_OPERATIONS.erp_bling_record_get.output.safeParse(masked).success).toBe(true);
    expect(view.raw.payload_text).toContain(privateText);
    cfg.access.bots[0].mask_personal = false;
    cfg.access.bots[0].data_scopes = ["public", "raw"];
    expect(JSON.stringify(protectOperationOutput(ctx, "erp_bling_record_get", view, cfg))).not.toContain(privateText);
    expect(() => authorizeOperation(ctx, "erp_bling_xml_get", { object_id: "xml-1" }, cfg, requestHash)).toThrow();
  });

  it("publica os mesmos descritores e OpenAPI sem rotas de adoção, envio ou commit", () => {
    expect(BLING_OPERATION_DESCRIPTORS).toBe(BLING_OPERATIONS);
    expect(BLING_OPENAPI).toBe(BLING_MODULE_CONTRACT.openapi);
    const documented = Object.values(BLING_OPENAPI.paths).flatMap(path => Object.values(path)) as Record<string, unknown>[];
    expect(documented).toHaveLength(18);
    expect(documented.map(operation => operation.operationId).sort()).toEqual([...BLING_OPERATION_NAMES].sort());
    for (const operation of Object.values(BLING_OPERATION_DESCRIPTORS)) {
      expect(operation.requirement.all).toEqual(["erp"]);
      expect(operation.summary).not.toMatch(/Fagoo|Origin/);
      expect(operation.bot.configurable).toBe(true);
      if (operation.name === "erp_bling_oauth_callback") continue;
      const suffix = operation.path === "/" ? "" : operation.path.replace(/:[A-Za-z_]+/g, "exemplo");
      expect(matchPublicBlingRoute(operation.method, new URL(publicUrl(suffix)).pathname, area)?.name).toBe(operation.name);
    }
    for (const suffix of ["/stage", "/commit", "/adotar", "/enviar", "/claim", "/ack", "/reservar"])
      for (const method of ["GET", "POST"])
        expect(matchPublicBlingRoute(method, new URL(publicUrl(suffix)).pathname, area)).toBeNull();
    expect(matchPublicBlingRoute("GET", new URL(publicUrl()).pathname, "outra-area")).toBeNull();
  });

  it("HTTP valida entrada inteira, não aceita autoridade do corpo e não chama a porta na recusa", async () => {
    const seen: unknown[] = [];
    const api = apiStub(async (_ctx, name, input) => { seen.push({ name, input }); return { items: [], next_cursor: null }; });
    const response = await handlePublicBlingRequest(new Request(publicUrl("/acervo?entity=products&limit=50&deleted=false")), context(false), api);
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ name: "erp_bling_records_list", input: { entity: "products", limit: 50, deleted: false } }]);
    for (const suffix of ["/acervo?entity=products&limit=51", "/acervo?entity=products&limit=1&limit=2", "/acervo?entity=products&profile=outra-area"]) {
      expect((await handlePublicBlingRequest(new Request(publicUrl(suffix)), context(false), api)).status).not.toBe(200);
    }
    for (const authority of [{ actor: userId }, { profile: "outra-area" }, { read_granted: true }]) {
      const request = new Request(publicUrl("/desligar"), { method: "POST", body: JSON.stringify({ ...inputFor("erp_bling_disable"), ...authority }) });
      expect((await handlePublicBlingRequest(request, context(false), api)).status).not.toBe(200);
    }
    expect(seen).toHaveLength(1);
  });

  it("HTTP saneia exceção de porta, saída inválida e mensagem adulterada sem vazar segredo", async ({ task }) => {
    const secret = crypto.randomUUID();
    const tainted = new BlingError("BLING_AUTH_REQUIRED"); tainted.message = secret;
    for (const error of [new Error(secret), tainted, { message: secret, code: "BLING_AUTH_REQUIRED" }]) {
      const clean = sanitizeBlingError(error);
      expect(clean.message).not.toContain(secret);
      const response = await handlePublicBlingRequest(new Request(publicUrl()), context(false), apiStub(async () => { throw error; }));
      expect([403, 409, 503]).toContain(response.status);
      expect(await response.text()).not.toContain(secret);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    const invalid = await handlePublicBlingRequest(new Request(publicUrl("/comandos/command-1")), context(false),
      apiStub(async () => ({ phase: "queued", receipt: null, access_token: secret })));
    expect(invalid.status).not.toBe(200);
    expect(await invalid.text()).not.toContain(secret);
    task.meta.orgApi = { sanitizedExceptions: 3, rejectedOutput: true, networkCalls: 0 };
  });

  it("XML sai como bytes e cookie da autorização fica fora do JSON", async () => {
    const bytes = new TextEncoder().encode("<xml>simulado</xml>");
    const xml = await handlePublicBlingRequest(new Request(publicUrl("/xml/xml-1")), context(false), apiStub(async () => ({
      bytes, sha256: requestHash, filename: "nota.xml", content_type: "application/xml",
    })));
    expect(xml.status).toBe(200);
    expect(xml.headers.get("Content-Type")).toContain("application/xml");
    expect(xml.headers.get("X-Content-SHA256")).toBe(requestHash);
    expect(new Uint8Array(await xml.arrayBuffer())).toEqual(bytes);
    const nonce = crypto.randomUUID();
    const oauth = await handlePublicBlingRequest(new Request(publicUrl("/autorizar"), {
      method: "POST", body: JSON.stringify(inputFor("erp_bling_oauth_start")),
    }), context(false), apiStub(async (ctx: BlingContext) => {
      ctx.response!.setCookie({ name: "__Host-bling-org-api", value: nonce, max_age: 600 });
      return { authorization_url: "https://provider.invalid/authorize", expires_at: now + 600000 };
    }));
    expect(oauth.status).toBe(200);
    expect(oauth.headers.get("Set-Cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(await oauth.text()).not.toContain(nonce);
  });

  it("callback usa retorno e cookie confiáveis, redireciona sem código e não expõe exceção", async () => {
    const code = crypto.randomUUID(), state = crypto.randomUUID(), browser = crypto.randomUUID();
    const callbackUrl = `https://instalacao.invalid/api/public/erp-bling/${area}/callback`;
    const options = { callback_url: callbackUrl, cookie_name: "__Host-bling-org-api" as const };
    let received: unknown;
    const request = () => new Request(`${callbackUrl}?state=${state}&code=${code}`, { headers: { Cookie: `${options.cookie_name}=${browser}` } });
    const api = apiStub(() => { throw new Error("Despacho comum inesperado."); }, async (_ctx, input) => {
      received = input; return { redirect: "/receber-bling", state: "authorized", clear_cookie: true };
    });
    const response = await handlePublicBlingCallback(request(), context(false), api, options);
    expect(response.status).toBe(302);
    expect(received).toEqual({ state, code, browser_nonce: browser, callback_url: callbackUrl });
    expect(response.headers.get("Location")).toBe("/receber-bling");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await response.text()).not.toContain(code);
    const bad = await handlePublicBlingCallback(request(), context(false), apiStub(() => {}, async () => { throw new Error(code); }), options);
    expect(await bad.text()).not.toContain(code);
  });
});
