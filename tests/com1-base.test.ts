import { describe, expect, it } from "vitest";
import { COM1_MODULE_CONTRACT, COM1_OPERATIONS, commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { commercialNfeSlots, installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import { COM1_TEST_IDS, com1Actor, com1Identity, com1NoIoEnv, com1Request, com1RouteDependencies } from "./com1-support";
import { engineActor } from "../src/security";
import { handleRpc, COM1_INTERNAL_RPCS } from "../src/erp/engine/rpc-endpoint.ts";
import { COM1_AUTHORITY_HEADER } from "../src/erp/domains/fiscal/comnfe/access.ts";

describe("base comercial: fronteira HTTP e política sensível", () => {
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
    expect(COM1_INTERNAL_RPCS.size).toBe(5);
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
