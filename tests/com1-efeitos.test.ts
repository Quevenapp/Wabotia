// Fronteira HTTP no Worker. A porta de efeitos é simulada explicitamente;
// persistência, postagens e compensações reais estão em erp/comnfe/efeitos.test.mjs.
// Nenhum cenário chama governo ou cofre real e nenhuma espera usa tempo real.
import { describe, expect, it } from "vitest";
import { COM1_MODULE_CONTRACT, COM1_OPERATIONS, commercialNfeRoute, type CommercialNfeHttpContext } from "../src/erp/commercial-nfe/routes.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import type { EffectAxis, EffectInput, EffectView } from "../src/erp/commercial-nfe/contracts.ts";
import { COM1_TEST_IDS, com1Actor, com1Identity, com1NoIoEnv, com1Request, com1RouteDependencies } from "./com1-support";
import { createFakeVault } from "./erp/emissor/fake-vault";
import { engineActor } from "../src/security";

const operation = COM1_OPERATIONS.find(item => item.name === "com1.effects")!;
const roleFor = (axis: EffectAxis) => axis === "stock" ? "estoque" as const : "financeiro" as const;
const intents: EffectInput["intent"][] = ["reconcile", "apply", "apply_skipped", "reverse"];

function pending(axis: EffectAxis): EffectView {
  return {
    emission_id: COM1_TEST_IDS.emission, axis, state: "pendente", origin: null,
    ids: {}, fingerprint: null, reason: "fixture_effect_port", responsible_role: roleFor(axis),
    person_id: COM1_TEST_IDS.user, command_id: COM1_TEST_IDS.command, result: null,
    compensation_state: null, compensation_command_id: null, compensation_result: null,
    updated_at: "1795089600000000",
  };
}

describe("efeitos comerciais: autorização e contrato HTTP no Worker", () => {
  for (const axis of ["stock", "finance"] as const) for (const intent of intents) {
    it(`${axis}/${intent}: proposta confirmada chega à mesma operação com o papel local`, async () => {
      const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-da-equipe", run_id: "execucao-efeitos", proposal_id: "confirmacao-local", masked: true } });
      const identity = com1Identity(actor);
      identity.actor!.erp_role = roleFor(axis);
      const seen: CommercialNfeHttpContext[] = [];
      const vault = createFakeVault();
      const restore = installCommercialNfeHttp(async context => {
        seen.push(context);
        return Response.json(pending(axis));
      });
      try {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis, intent }), "com1", actor,
          com1RouteDependencies({ identity, fetch: vault.fetch }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ axis, state: "pendente", responsible_role: roleFor(axis) });
        expect(seen).toHaveLength(1);
        expect(seen[0].operation.name).toBe("com1.effects");
        expect(seen[0].params.id).toBe(COM1_TEST_IDS.emission);
        expect(seen[0].input).toEqual({ command_id: COM1_TEST_IDS.command, expected_version: 1, axis, intent });
        expect(seen[0].identity.actor).toMatchObject({ user_id: COM1_TEST_IDS.user, erp_role: roleFor(axis), is_agent: false });
        expect(seen[0].authority).toEqual({ origin: "application", proposed_by: "bot-da-equipe", confirmed_by: COM1_TEST_IDS.user, confirmation_id: "confirmacao-local" });
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(vault.calls).toEqual([]);
      } finally { restore(); }
    });

    it(`${axis}/${intent}: sem confirmação, sem papel ou com origem externa não chega ao efeito`, async () => {
      const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-sem-concessao", run_id: "execucao-negada", masked: true } });
      let reached = 0;
      const restore = installCommercialNfeHttp(async () => { reached++; return Response.json(pending(axis)); });
      try {
        const local = com1Identity(actor); local.actor!.erp_role = roleFor(axis);
        const noConfirmation = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis, intent }), "com1", actor,
          com1RouteDependencies({ identity: local }));
        expect(noConfirmation.status).toBe(403);
        expect(await noConfirmation.json()).toMatchObject({ code: "fiscal_confirmation_required" });

        const fiscal = com1Identity(actor); fiscal.actor!.erp_role = "fiscal";
        const noLocalRole = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis, intent }), "com1", actor,
          com1RouteDependencies({ identity: fiscal, authority: { origin: "application", autonomous: true } }));
        expect(noLocalRole.status).toBe(403);
        expect(await noLocalRole.json()).toMatchObject({ code: "fiscal_forbidden" });

        const external = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis, intent }), "com1", actor,
          com1RouteDependencies({ identity: local, authority: { origin: "external", autonomous: true } }));
        expect(external.status).toBe(403);
        expect(await external.json()).toMatchObject({ code: "fiscal_external_origin_forbidden" });
        expect(reached).toBe(0);
      } finally { restore(); }
    });
  }

  it("concessão autônoma conferida alcança efeitos, sem bloqueio fixo por ser bot", async () => {
    const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-configurado", run_id: "execucao-configurada", masked: true } });
    let reached = 0;
    const restore = installCommercialNfeHttp(async context => {
      reached++;
      expect(context.authority).toMatchObject({ autonomous: true, proposed_by: "bot-configurado" });
      return Response.json(pending("finance"));
    });
    try {
      const identity = com1Identity(actor); identity.actor!.erp_role = "financeiro";
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis: "finance" }), "com1", actor,
        com1RouteDependencies({ identity, authority: { origin: "application", autonomous: true, proposed_by: "bot-configurado" } }));
      expect(response.status).toBe(200);
      expect(reached).toBe(1);
    } finally { restore(); }
  });

  it("atendimento externo é recusado antes de carregar identidade ERP", async () => {
    let identities = 0;
    for (const intent of ["apply", "reverse"]) {
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { intent }), "com1", engineActor("com1", "bot-cliente"), {
        resolveIdentity: async () => { identities++; throw new Error("Origem externa não carrega identidade da equipe."); },
      });
      expect(response.status).toBe(403);
    }
    expect(identities).toBe(0);
  });

  it("retorno físico só é encaminhado quando explicitamente informado, com tipo booleano", async () => {
    const seen: Record<string, unknown>[] = [];
    const restore = installCommercialNfeHttp(async context => { seen.push(context.input); return Response.json(pending("stock")); });
    try {
      for (const explicit of [undefined, false, true]) {
        const input = { intent: "reverse", ...(explicit === undefined ? {} : { physical_return_confirmed: explicit }) };
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, input), "com1", com1Actor(), com1RouteDependencies());
        expect(response.status).toBe(200);
      }
      expect(Object.hasOwn(seen[0], "physical_return_confirmed")).toBe(false);
      expect(seen[1].physical_return_confirmed).toBe(false);
      expect(seen[2].physical_return_confirmed).toBe(true);
      for (const invalid of ["true", 1, null]) {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { intent: "reverse", physical_return_confirmed: invalid }),
          "com1", com1Actor(), com1RouteDependencies());
        expect(response.status).toBe(400);
      }
      expect(seen).toHaveLength(3);
    } finally { restore(); }
  });

  it("eixo desligado chega ao motor para registrar skip ou tratar manutenção; Fiscal desligada recusa", async () => {
    let reached = 0;
    const restore = installCommercialNfeHttp(async context => { reached++; return Response.json(pending(context.input.axis as EffectAxis)); });
    try {
      for (const axis of ["stock", "finance"] as const) for (const intent of ["apply", "reverse"]) {
        const identity = com1Identity(com1Actor(), { [axis]: false, sales: false, products: false });
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, { axis, intent }), "com1", com1Actor(),
          com1RouteDependencies({ identity }));
        expect(response.status).toBe(200);
      }
      const disabled = await commercialNfeRoute(com1NoIoEnv, com1Request(operation), "com1", com1Actor(),
        com1RouteDependencies({ identity: com1Identity(com1Actor(), { fiscal: false }) }));
      expect(disabled.status).toBe(409);
      expect(await disabled.json()).toMatchObject({ code: "module_disabled" });
      expect(reached).toBe(4);
    } finally { restore(); }
  });

  it("browser e bot não podem fabricar resultado, autoridade ou argumentos locais", async () => {
    let reached = 0;
    const restore = installCommercialNfeHttp(async () => { reached++; return Response.json(pending("stock")); });
    try {
      for (const extra of [
        { status: "autorizada" }, { posting_id: COM1_TEST_IDS.document }, { title_ids: [COM1_TEST_IDS.document] },
        { person_id: COM1_TEST_IDS.user }, { authority: { autonomous: true } }, { document_version: 7 },
        { preview_hash: "a".repeat(64) }, { axis: "both" }, { intent: "receive" }, { expected_version: 0 },
      ]) {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation, extra), "com1", com1Actor(), com1RouteDependencies());
        expect(response.status).toBe(400);
      }
      expect(reached).toBe(0);
    } finally { restore(); }
  });

  it("contrato dos bots descreve eixo, intenção, confirmação física e categoria sensível", () => {
    expect(COM1_MODULE_CONTRACT.definition.bot.sensitive).toContain(operation.name);
    const path = `/profiles/{profile}/erp-comercial-nfe/${operation.path.replace(":id", "{id}")}`;
    const endpoint = COM1_MODULE_CONTRACT.openapi.paths[path].post;
    expect(endpoint.operationId).toBe("com1.effects");
    expect(endpoint.summary).toContain("sem emitir nota");
    const schema = endpoint.requestBody!.content["application/json"].schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.axis).toEqual({ type: "string", enum: ["stock", "finance"] });
    expect(schema.properties.intent).toEqual({ type: "string", enum: ["apply", "apply_skipped", "reconcile", "reverse"] });
    expect(schema.properties.physical_return_confirmed).toEqual({ type: "boolean" });
    expect(schema.required).toEqual(["command_id", "expected_version", "axis", "intent"]);
  });
});
