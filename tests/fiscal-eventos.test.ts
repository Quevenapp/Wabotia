import { describe, expect, it } from "vitest";
import { commercialNfeRoute, NFE_EVENT_OPERATIONS, COM1_MODULE_CONTRACT } from "../src/erp/commercial-nfe/routes.ts";
import { NFCE_OPERATIONS } from "../src/erp/commercial-nfe/nfce-metadata.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import { ERP_BOT_OPERATIONS } from "../src/modules/erp/bot-access.ts";
import { COM1_TEST_IDS, com1Actor, com1Identity, com1NoIoEnv, com1RouteDependencies } from "./com1-support";

const op = (name: string) => NFE_EVENT_OPERATIONS.find(item => item.name === name)!;
const request = (name: string, body: Record<string, unknown> = {}, query = "") => {
  const operation = op(name);
  const path = operation.path.replace(":id", COM1_TEST_IDS.emission);
  return new Request(`https://wabotia.invalid/api/v1/profiles/com1/erp-comercial-nfe/${path}${query}`, {
    method: operation.method, ...(operation.method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
};
const correction = { command_id: COM1_TEST_IDS.command, text: "Endereço de entrega: Rua das Acácias, 45" };

describe("carta de correção, inutilização e devolução: rota, partes e papel", () => {
  it("com a parte Fiscal desligada, recusa com parte desligada e diz qual módulo ligar", async () => {
    const actor = com1Actor();
    const response = await commercialNfeRoute(com1NoIoEnv, request("nfe.carta_correcao", correction), "com1", actor,
      com1RouteDependencies({ identity: com1Identity(actor, { fiscal: false }) }));
    expect(response.status).toBe(409);
    const body = await response.json() as { code: string; message: string };
    expect(body.code).toBe("module_disabled");
    expect(body.message).toMatch(/parte Fiscal/);
  });

  it("não exige Vendas nem Produtos (inutilização e carta não dependem do pedido)", async () => {
    const actor = com1Actor();
    const restore = installCommercialNfeHttp(async context => Response.json({ operation: context.operation.name }));
    try {
      const response = await commercialNfeRoute(com1NoIoEnv, request("nfe.inutilizacao", { command_id: COM1_TEST_IDS.command, model: "nfce", environment: "homologacao",
        series: 1, first: 5, last: 6, justification: "Números pulados por queda de energia" }), "com1", actor,
        com1RouteDependencies({ identity: com1Identity(actor, { sales: false, products: false, stock: false, finance: false }) }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ operation: "nfe.inutilizacao" });
    } finally { restore(); }
  });

  it("papel de consulta lê os eventos mas não envia carta nem devolução", async () => {
    const actor = com1Actor();
    const identity = com1Identity(actor);
    identity.actor = { ...identity.actor!, erp_role: "consulta" };
    const restore = installCommercialNfeHttp(async () => Response.json({ ok: true }));
    try {
      expect((await commercialNfeRoute(com1NoIoEnv, request("nfe.eventos"), "com1", actor, com1RouteDependencies({ identity }))).status).toBe(200);
      const denied = await commercialNfeRoute(com1NoIoEnv, request("nfe.devolucao", { command_id: COM1_TEST_IDS.command, items: [{ item: 0, quantity: "1" }], finance_option: "credito" }),
        "com1", actor, com1RouteDependencies({ identity }));
      expect(denied.status).toBe(403);
    } finally { restore(); }
  });

  it("recusa formato inválido antes do motor (itens, opção e sequência)", async () => {
    const actor = com1Actor();
    for (const [name, body, query] of [
      ["nfe.devolucao", { command_id: COM1_TEST_IDS.command, items: [{ item: 0, quantity: "-1" }], finance_option: "credito" }, ""],
      ["nfe.devolucao", { command_id: COM1_TEST_IDS.command, items: [{ item: 0, quantity: "1" }], finance_option: "dinheiro" }, ""],
      ["nfe.carta_correcao.pdf", {}, "?sequence=21"],
      ["nfe.inutilizacao", { command_id: COM1_TEST_IDS.command, model: "nfse", environment: "homologacao", series: 1, first: 1, last: 1, justification: "Motivo com mais de quinze letras" }, ""],
    ] as const) {
      const response = await commercialNfeRoute(com1NoIoEnv, request(name, body as Record<string, unknown>, query), "com1", actor, com1RouteDependencies());
      expect(response.status, `${name} ${JSON.stringify(body)}${query}`).toBe(400);
    }
  });
});

describe("carta de correção, inutilização e devolução: inventário dos bots e catálogo comum", () => {
  it("entram no grupo nfe com nome estável, descrição em português e escrita sensível (nota fiscal)", () => {
    for (const name of ["nfe.carta_correcao", "nfe.inutilizacao", "nfe.devolucao"]) {
      const item = ERP_BOT_OPERATIONS.find(entry => entry.id === name)!;
      expect(item).toMatchObject({ group: "nfe", sensitive: true });
      expect(item.description).toMatch(/Mexe na nota fiscal/);
      expect(item.path.startsWith("erp-comercial-nfe/")).toBe(true);
      expect(COM1_MODULE_CONTRACT.definition.bot.sensitive).toContain(name);
    }
    expect(ERP_BOT_OPERATIONS.find(entry => entry.id === "nfe.eventos")).toMatchObject({ group: "nfe", sensitive: false });
    expect(ERP_BOT_OPERATIONS.find(entry => entry.id === "nfe.devolucao")!.params.required).toEqual(["id", "command_id", "items", "finance_option"]);
  });

  it("o catálogo comum publica também as operações nfce.* que existiam fora dele", () => {
    for (const operation of NFCE_OPERATIONS) {
      const path = `/profiles/{profile}/erp-comercial-nfe/${operation.path.replace(":id", "{id}")}`;
      expect(COM1_MODULE_CONTRACT.openapi.paths[path]?.[operation.method.toLowerCase()]?.operationId, operation.name).toBe(operation.name);
      if (operation.sensitive) expect(COM1_MODULE_CONTRACT.definition.bot.sensitive).toContain(operation.name);
    }
    expect(COM1_MODULE_CONTRACT.operations).toEqual(["com1.", "nfce.", "nfe."]);
  });
});
