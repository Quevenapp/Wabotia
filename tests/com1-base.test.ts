import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COM1_MODULE_CONTRACT, COM1_OPERATIONS, NFCE_OPERATIONS, NFE_EVENT_OPERATIONS, commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { commercialNfeSlots, installCommercialNfeHttp, installCommercialNfeSlots, com1NotReady } from "../src/erp/commercial-nfe/slots.ts";
import { COM1_TEST_IDS, com1Actor, com1Identity, com1NoIoEnv, com1Request, com1RouteDependencies } from "./com1-support";
import { engineActor } from "../src/security";
import { handleRpc, COM1_INTERNAL_RPCS } from "../src/erp/engine/rpc-endpoint.ts";
import { COM1_AUTHORITY_HEADER } from "../src/erp/domains/fiscal/comnfe/access.ts";

describe("base comercial: fronteira HTTP e política sensível", () => {
  // A integração instala os handlers reais. Este bloco conserva a prova de
  // falha fechada de uma instalação incompleta, com stubs explícitos e locais.
  let restoreSlots: () => void;
  beforeEach(() => {
    restoreSlots = installCommercialNfeSlots(Object.fromEntries(
      Object.keys(commercialNfeSlots()).map(name => [name, com1NotReady]),
    ));
  });
  afterEach(() => restoreSlots());
  for (const operation of COM1_OPERATIONS) {
    it(`${operation.name}: bot confirmado alcança o mesmo encaixe e o stub recusa`, async () => {
      const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-configurado", run_id: "run-teste", proposal_id: "proposal-confirmada", masked: true } });
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor, com1RouteDependencies());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "com1_not_ready" });
    });

    it(`${operation.name}: bot sem papel/configuração não alcança o encaixe`, async () => {
      const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-sem-acesso", run_id: "run-teste", masked: true } });
      const identity = com1Identity(actor);
      identity.actor!.erp_role = "vendas";
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor, com1RouteDependencies({ identity }));
      expect(response.status).toBe(403);
    });

    it(`${operation.name}: origem externa não alcança o encaixe`, async () => {
      const actor = com1Actor();
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
        com1RouteDependencies({ authority: { origin: "external", autonomous: true } }));
      expect(response.status).toBe(403);
    });

    it(`${operation.name}: atores reais do atendimento externo são recusados antes de resolver identidade`, async () => {
      for (const actor of [engineActor("com1", "bot-cliente"), com1Actor({ id: "bot:cliente", kind: "app", role: "service",
        scopes: ["conversations:read", "conversations:write", "conversations:bound"],
        via: { kind: "bot", bot_id: "cliente", run_id: "run-cliente", masked: true } })]) {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
          { resolveIdentity: async () => { throw new Error("Não deveria resolver identidade ERP da origem externa."); } });
        expect(response.status).toBe(403);
      }
    });
  }

  it("metadados únicos têm nomes estáveis, parâmetros e escritas sensíveis", () => {
    expect(new Set(COM1_OPERATIONS.map(op => op.name)).size).toBe(12);
    for (const operation of COM1_OPERATIONS) {
      expect(operation.summary.length).toBeGreaterThan(20);
      if (operation.method !== "GET") expect(COM1_MODULE_CONTRACT.definition.bot.sensitive).toContain(operation.name);
      const path = `/profiles/{profile}/erp-comercial-nfe/${operation.path.replace(":id", "{id}")}`;
      expect(COM1_MODULE_CONTRACT.openapi.paths[path]).toBeDefined();
      const endpoint = COM1_MODULE_CONTRACT.openapi.paths[path][operation.method.toLowerCase()];
      expect(endpoint.responses["200"].content).toBeDefined();
    }
    const serialized = JSON.stringify(COM1_MODULE_CONTRACT.openapi);
    for (const reference of serialized.matchAll(/#\/components\/schemas\/(Com1\w+)/g))
      expect(COM1_MODULE_CONTRACT.openapi.components.schemas[reference[1]], reference[1]).toBeDefined();
  });

  it("não aceita evidência fiscal ou autoridade no corpo do navegador", async () => {
    const operation = COM1_OPERATIONS.find(op => op.name === "com1.emit")!;
    for (const extra of [{ status: "autorizada" }, { access_key: "1".repeat(44) }, { protocol: "123" }, { authority: { autonomous: true } }, { token: "forjado" }]) {
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, extra), "com1", com1Actor(), com1RouteDependencies());
      expect(response.status).toBe(400);
    }
  });

  it("bot sem confirmação é recusado e concessão autônoma explícita pode ser instalada", async () => {
    const operation = COM1_OPERATIONS.find(op => op.name === "com1.emit")!;
    const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-fiscal", run_id: "run-teste", masked: true } });
    const denied = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor, com1RouteDependencies());
    expect(denied.status).toBe(403);
    const allowed = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
      com1RouteDependencies({ authority: { origin: "application", autonomous: true, proposed_by: "bot-fiscal" } }));
    expect(allowed.status).toBe(409);
    expect(await allowed.json()).toMatchObject({ code: "com1_not_ready" });
  });

  it("partes vizinhas desligadas permitem história; preparar exige vendas e produtos", async () => {
    const actor = com1Actor();
    const identity = com1Identity(actor, { stock: false, finance: false, sales: false, products: false });
    const read = COM1_OPERATIONS.find(op => op.name === "com1.get")!;
    const prepare = COM1_OPERATIONS.find(op => op.name === "com1.prepare")!;
    expect((await commercialNfeRoute(com1NoIoEnv, com1Request(read), "com1", actor, com1RouteDependencies({ identity }))).status).toBe(409);
    const denied = await commercialNfeRoute(com1NoIoEnv, com1Request(prepare), "com1", actor, com1RouteDependencies({ identity }));
    expect(await denied.json()).toMatchObject({ code: "module_disabled" });
  });

  it("encaixe instalado recebe autoria confirmada e privacidade com resposta privada", async () => {
    const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-fiscal", run_id: "run-teste", proposal_id: "proposal-confirmada", masked: true } });
    const restore = installCommercialNfeHttp(async context => {
      expect(context.authority).toMatchObject({ proposed_by: "bot-fiscal", confirmed_by: COM1_TEST_IDS.user, confirmation_id: "proposal-confirmada" });
      expect(context.identity.actor?.is_agent).toBe(false);
      expect(context.identity.customer_privacy).toEqual({ restricted_contact_ids: [] });
      return Response.json({ ready_for_test: true });
    });
    try {
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(COM1_OPERATIONS[0]), "com1", actor, com1RouteDependencies());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    } finally { restore(); }
  });

  it("todos os stubs internos recusam e nunca declaram autorização ou efeito", () => {
    for (const stub of Object.values(commercialNfeSlots())) expect(() => (stub as (...args: unknown[]) => unknown)({}, {})).toThrow("com1_not_ready");
  });

  it("RPCs internos e autoridade não podem ser escolhidos pelo navegador", async () => {
    const noStorage = new Proxy({} as DurableObjectState, { get() { throw new Error("Não deve acessar armazenamento."); } });
    // 5 da NF-e do pedido + 7 da carta de correção, inutilização e devolução (pedido ao cofre, resultado e efeitos).
    expect(COM1_INTERNAL_RPCS.size).toBe(12);
    for (const name of COM1_INTERNAL_RPCS) {
      const response = await handleRpc(noStorage, "com1", name, new Request(`https://internal/erp-rpc/${name}`, {
        method: "POST", body: JSON.stringify({ p_input: { status: "autorizada", claim_token: "forjado" } }),
      }));
      expect(response.status, name).toBe(403);
      expect(await response.json()).toMatchObject({ code: "42501", message: "erp_rpc_system_only" });
    }
    const forged = await handleRpc(noStorage, "com1", "erp_com1_config_get", new Request("https://internal/erp-rpc/erp_com1_config_get", {
      method: "POST", headers: { [COM1_AUTHORITY_HEADER]: JSON.stringify({ origin: "application", autonomous: true }) },
      body: JSON.stringify({ p_user_id: COM1_TEST_IDS.user }),
    }));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ message: "com1_authority_internal_only" });
  });
});


describe("integração comercial: catálogo, OpenAPI e ponte", () => {
  it("publica as doze operações no catálogo global, incluindo arquivos e escritas sensíveis", async () => {
    await import("../src/modules/runtime");
    const { fullCatalog, resetCatalogCache } = await import("../src/bot-actions/catalog");
    const { requireOperationAccess } = await import("../src/access");
    resetCatalogCache();
    const entries = fullCatalog().filter(op => op.path.startsWith("erp-comercial-nfe/"));
    // O catálogo comum também publica o cupom do balcão (nfce.*) e carta de correção, inutilização e devolução (nfe.*).
    expect(entries).toHaveLength(COM1_OPERATIONS.length + NFCE_OPERATIONS.length + NFE_EVENT_OPERATIONS.length);
    const fiscal = com1Actor({ role: "operator", access: ["erp:fiscal"] });
    for (const operation of COM1_OPERATIONS) {
      const entry = entries.find(item => item.path === `erp-comercial-nfe/${operation.path}` && item.method === operation.method)!;
      expect(entry.summary).toBe(operation.summary);
      expect(entry.module).toBe("erp-fiscal");
      expect(entry.sensitive).toBe(operation.sensitive);
      if (operation.method !== "GET") {
        expect(entry.name).toBe(operation.name);
        expect(() => requireOperationAccess(fiscal, entry.name)).not.toThrow();
        expect(() => requireOperationAccess(com1Actor({ role: "operator", access: ["team"] }), entry.name)).toThrow();
      }
    }
  });

  for (const name of ["com1.danfe", "com1.xml", "com1.cancel.xml"]) {
    it(`${name}: bot recebe vínculo autenticado e pessoa conserva download binário`, async () => {
      const operation = COM1_OPERATIONS.find(op => op.name === name)!;
      const type = name === "com1.danfe" ? "application/pdf" : "application/xml";
      const file = name === "com1.danfe" ? "%PDF-1.4 dado fiscal restrito" : "<xml>dado fiscal restrito</xml>";
      let validated = 0;
      const dependencies = { ...com1RouteDependencies(), handle: async () => {
        validated++;
        return new Response(file, { headers: { "Content-Type": type, "Content-Length": String(new TextEncoder().encode(file).byteLength) } });
      } };
      const bot = com1Actor({ via: { kind: "bot", bot_id: "fiscal", run_id: "ensaio", masked: true } });
      const request = () => new Request(com1Request(operation), { headers: { Accept: "application/json" } });
      const response = await commercialNfeRoute(com1NoIoEnv, request(), "com1", bot, dependencies);
      const metadata = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(metadata).toMatchObject({ emission_id: COM1_TEST_IDS.emission, content_type: type, authentication_required: true,
        download_url: new URL(request().url).pathname });
      expect(JSON.stringify(metadata)).not.toContain("dado fiscal restrito");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(validated).toBe(1);
      const human = await commercialNfeRoute(com1NoIoEnv, request(), "com1", com1Actor(), dependencies);
      expect(human.headers.get("Content-Type")).toBe(type);
      expect(await human.text()).toBe(file);
      const download = await commercialNfeRoute(com1NoIoEnv,
        new Request(com1Request(operation), { headers: { Accept: type } }), "com1", bot, dependencies);
      expect(download.headers.get("Content-Type")).toBe(type);
      expect(await download.text()).toBe(file);
      expect(validated).toBe(3);
    });
  }

  it("descreve a revisão resumida da lista sem exigir os corpos omitidos", () => {
    const schemas = COM1_MODULE_CONTRACT.openapi.components.schemas as Record<string, any>;
    expect(schemas.Com1EmissionPage.properties.items.items.$ref).toContain("Com1EmissionSummary");
    for (const field of ["snapshot", "tax_sources", "body", "calculation"])
      expect(schemas.Com1RevisionSummary.required).not.toContain(field);
    expect(schemas.Com1ImmutableRevision.required).toContain("body");
  });

  it("renova partes depois do cofre sem revalidar papel para registrar evidência", async () => {
    const { createCommercialNfeBridge } = await import("../src/erp/commercial-nfe/bridge.ts");
    const { decodeIdentity, IDENTITY_HEADER, SYSTEM_HEADER, GATE_HEADER } = await import("../src/erp/engine/identity.ts");
    const { isCommercialNfeEvidenceRequest } = await import("../src/erp/hub.ts");
    const operation = COM1_OPERATIONS.find(op => op.name === "com1.emit")!;
    const identity = com1Identity();
    const disabled = com1Identity(undefined, { customers: false, fiscal: false }).parts!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
    let calls = 0;
    const bridge = createCommercialNfeBridge({ env: com1NoIoEnv, request: com1Request(operation), profile: "com1", actor: com1Actor(),
      identity, operation, params: {}, input: {}, authority: { origin: "application" } }, {
      resolveIdentity: async () => { throw new Error("evidência não requer reabrir identidade"); },
      partsEnvelope: async () => ({ parts: disabled, partsControl: { profile: "com1", revision: "2", issued_at: 1_800_000_000_000, expires_at: 1_800_000_060_000 } }),
      rpcFetch: async (_env, _profile, path, init) => {
        calls++;
        const request = new Request(`https://coordinator${path}`, init);
        expect(isCommercialNfeEvidenceRequest(path, request)).toBe(true);
        expect(request.headers.get(SYSTEM_HEADER)).toBe("1");
        expect(request.headers.get(GATE_HEADER)).toBeNull();
        const renewed = decodeIdentity(request.headers.get(IDENTITY_HEADER));
        expect(renewed.actor).toBeNull();
        expect(renewed.parts?.customers).toBe(false);
        expect(renewed.partsControl?.revision).toBe("2");
        expect(await request.json()).not.toHaveProperty("p_user_id");
        return Response.json({ persisted: true });
      },
    });
    await bridge.call("erp_com1_record", { emission_id: COM1_TEST_IDS.emission, command_id: COM1_TEST_IDS.command,
      claim_token: "capacidade-conferida-pelo-motor", connection_fingerprint: "a".repeat(64), result: {} } as any);
    expect(calls).toBe(1);
    for (const name of ["erp_com1_claim", "erp_com1_cancel_claim", "erp_com1_effect_apply", "erp_com1_prepare"])
      expect(isCommercialNfeEvidenceRequest(`/erp-rpc/${name}`, new Request(`https://coordinator/erp-rpc/${name}`, {
        method: "POST", headers: { [SYSTEM_HEADER]: "1" },
      }))).toBe(false);
    expect(isCommercialNfeEvidenceRequest("/erp-rpc/erp_com1_record", new Request("https://coordinator/erp-rpc/erp_com1_record", { method: "POST" }))).toBe(false);
    } finally { clock.mockRestore(); }
  });
});
