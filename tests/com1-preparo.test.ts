import { describe, expect, it } from "vitest";
import { COM1_MODULE_CONTRACT, COM1_OPERATIONS, commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import { requireCom1SensitivePolicy } from "../src/erp/domains/fiscal/comnfe/access.ts";
import { com1Actor, com1Identity, com1NoIoEnv, com1Request, com1RouteDependencies } from "./com1-support";

const operation = COM1_OPERATIONS.find(value => value.name === "com1.prepare")!;

describe("preparação comercial: fronteira do Worker", () => {
  it("documenta a operação compartilhada por painel e bots como sensível", () => {
    expect(operation.action).toBe("prepare");
    expect(operation.summary).toContain("pedido salvo");
    expect(COM1_MODULE_CONTRACT.definition.bot.sensitive).toContain(operation.name);
    expect(operation.body).toEqual(["command_id", "expected_document_version", "choices", "new_fiscal_version", "expected_emission_version"]);
  });

  it("bot confirmado alcança o mesmo encaixe com identidade e autoria da confirmação", async ({ task }) => {
    let calls = 0;
    const actor = com1Actor({ via: { kind: "bot", bot_id: "fiscal-configurado", run_id: "preparo", proposal_id: "aprovacao-fiscal", masked: true } });
    const restore = installCommercialNfeHttp(async context => {
      calls++;
      expect(context.operation.name).toBe("com1.prepare");
      expect(context.identity.actor?.user_id).toBe(actor.id);
      expect(context.authority).toMatchObject({ proposed_by: "fiscal-configurado", confirmed_by: actor.id, confirmation_id: "aprovacao-fiscal" });
      requireCom1SensitivePolicy(context.identity.actor!, "prepare", context.authority);
      return Response.json({ blockers: [{ code: "fiscal_product_incomplete", field: "items.0.ncm", message: "Complete o NCM do produto.", correction: { screen: "products", field: "ncm" } }] });
    });
    try {
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor, com1RouteDependencies());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ blockers: [{ code: "fiscal_product_incomplete" }] });
      expect(calls).toBe(1);
      task.meta.preparo = { calls, confirmed: true, network: false };
    } finally { restore(); }
  });

  it("recusa bot sem configuração, pessoa sem papel e origem externa antes do encaixe", async () => {
    let calls = 0;
    const restore = installCommercialNfeHttp(async () => { calls++; return Response.json({}); });
    try {
      const bot = com1Actor({ via: { kind: "bot", bot_id: "sem-concessao", run_id: "preparo", masked: true } });
      expect((await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", bot, com1RouteDependencies())).status).toBe(403);
      const actor = com1Actor(), identity = com1Identity(actor);
      identity.actor!.erp_role = "vendas";
      expect((await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor, com1RouteDependencies({ identity }))).status).toBe(403);
      expect((await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
        com1RouteDependencies({ authority: { origin: "external", autonomous: true } }))).status).toBe(403);
      expect(calls).toBe(0);
    } finally { restore(); }
  });

  it("recusa imposto, autorização e referência fornecidos pelo navegador", async () => {
    let calls = 0;
    const restore = installCommercialNfeHttp(async () => { calls++; return Response.json({}); });
    try {
      for (const extra of [{ impostos: { icms: { valor: 0 } } }, { emitente: {} }, { status: "autorizada" }, { protocolo: "123" }, { referencia: "nova" }, { body_hash: "a".repeat(64) }]) {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, extra), "com1", com1Actor(), com1RouteDependencies());
        expect(response.status).toBe(400);
      }
      expect(calls).toBe(0);
    } finally { restore(); }
  });

  it("estoque/financeiro desligados permitem preparar; Fiscal/Produtos/Vendas/Base recusam", async () => {
    let calls = 0;
    const restore = installCommercialNfeHttp(async () => { calls++; return Response.json({ blockers: [] }); });
    try {
      const actor = com1Actor();
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
        com1RouteDependencies({ identity: com1Identity(actor, { stock: false, finance: false }) }));
      expect(response.status).toBe(200);
      for (const part of ["customers", "products", "sales", "fiscal"] as const) {
        const denied = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", actor,
          com1RouteDependencies({ identity: com1Identity(actor, { [part]: false }) }));
        expect(await denied.json()).toMatchObject({ code: "module_disabled" });
      }
      expect(calls).toBe(1);
    } finally { restore(); }
  });
});
