import { describe, expect, it } from "vitest";
import { createNfapiProvider, fiscalReference } from "../src/erp/emissor/nfapi-provider.ts";
import type { FiscalBlocker } from "../src/erp/commercial-nfe/contracts.ts";
import type { FiscalContext, FiscalResult } from "../src/erp/emissor/provider.ts";
import { COM1_OPERATIONS, commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import type { Actor } from "../src/types";
import { uid } from "../src/types";
import { fiscalConnectionFingerprint, saveEmissor } from "../src/erp/emissor/config.ts";
import { com1Actor, com1Identity, com1Request, com1RouteDependencies, com1WorkerClock } from "./com1-support";
import { example, VAULT_URL, vaultArea } from "./erp/emissor/helpers";
import { requestExample } from "./erp/emissor/schema";
import { FAKE_CNPJ, FAKE_PDF } from "./erp/emissor/fake-vault";

const emitOperation = COM1_OPERATIONS.find(operation => operation.name === "com1.emit")!;
const fiscalBody = () => ({ ...example(requestExample("POST", "/v1/nfe")), ambiente: "homologacao" });
const timeoutSignal = () => new AbortController().signal;

/**
 * Só a fronteira e o transporte são reais nesta prova. Preparação e efeitos,
 * pertencentes às tarefas paralelas, são portas simuladas com identidade
 * persistida. A idempotência durável comercial é provada pelas respectivas
 * suítes do motor; este adaptador não substitui aquelas implementações.
 */
function installBoundary(ctx: FiscalContext, blockers: FiscalBlocker[] = []) {
  const clock = com1WorkerClock();
  const provider = createNfapiProvider({ delays: [0, 10, 20], sleep: clock.sleep, timeoutSignal });
  const key = { document_id: uid(), version: 1 };
  const body = fiscalBody();
  const applied = new Set<string>();
  let effectApplications = 0;
  let invocations = 0;
  const restore = installCommercialNfeHttp(async context => {
    invocations++;
    if (blockers.length) return Response.json({ blockers }, { status: 422 });
    const result = await provider.emit(ctx, "nfe", body, key);
    const effectsEnabled = context.identity.parts!.stock && context.identity.parts!.finance;
    // Porta vizinha simulada: reconhece o mesmo resultado externo por ID.
    if (effectsEnabled && result.status === "authorized" && !applied.has(result.provider_ref)) {
      applied.add(result.provider_ref);
      effectApplications++;
    }
    return Response.json({ result, authority: context.authority,
      effects: effectsEnabled ? "reconhecido" : "pulado/part_disabled" });
  });
  return { provider, key, body, clock, restore, applied,
    get invocations() { return invocations; },
    get effectApplications() { return effectApplications; } };
}

function dispatch(ctx: FiscalContext, actor: Actor, options: Parameters<typeof com1RouteDependencies>[0] = {}, command = uid()) {
  const original = com1Request(emitOperation, { command_id: command });
  const request = new Request(original.url.replace("/profiles/com1/", `/profiles/${ctx.profile}/`), original);
  return commercialNfeRoute(ctx.env, request, ctx.profile, { ...actor, profiles: [ctx.profile] },
    com1RouteDependencies({ ...options, fetch: ctx.fetch }));
}

describe("cofre comercial: contrato-base e transporte isolado", () => {
  it("bloqueio fiscal recebido da preparação impede invocação do provedor", async () => {
    const { ctx, vault } = await vaultArea();
    const blockers: FiscalBlocker[] = [{ code: "fiscal_product_incomplete", field: "ncm",
      message: "O produto está sem NCM.", correction: { screen: "products", field: "ncm" } }];
    const boundary = installBoundary(ctx, blockers);
    try {
      const response = await dispatch(ctx, com1Actor());
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ blockers });
      expect(vault.calls).toEqual([]);
      expect(boundary.effectApplications).toBe(0);
    } finally { boundary.restore(); }
  });

  it("pessoa sem papel fiscal é recusada antes do cliente", async () => {
    const { ctx, vault } = await vaultArea();
    const actor = com1Actor();
    const identity = com1Identity(actor);
    identity.actor!.erp_role = "vendas";
    const boundary = installBoundary(ctx);
    try {
      expect((await dispatch(ctx, actor, { identity })).status).toBe(403);
      expect(boundary.invocations).toBe(0);
      expect(vault.calls).toEqual([]);
    } finally { boundary.restore(); }
  });

  it("bot confirmado emite; sem configuração ou com origem externa não chega ao cliente", async () => {
    const { ctx, vault } = await vaultArea();
    const boundary = installBoundary(ctx);
    const via = { kind: "bot" as const, bot_id: "bot-fiscal", run_id: "ensaio", masked: true };
    try {
      expect((await dispatch(ctx, com1Actor({ via }))).status).toBe(403);
      expect((await dispatch(ctx, com1Actor({ via }), { authority: { origin: "external", autonomous: true } })).status).toBe(403);
      expect(vault.calls).toEqual([]);
      const actor = com1Actor({ via: { ...via, proposal_id: "confirmacao-fiscal" } });
      const response = await dispatch(ctx, actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { status: "authorized" },
        authority: { proposed_by: "bot-fiscal", confirmed_by: actor.id, confirmation_id: "confirmacao-fiscal" } });
      expect(vault.emissions.size).toBe(1);
    } finally { boundary.restore(); }
  });

  it("partes vizinhas desligadas preservam a referência e permitem autorização", async () => {
    const { ctx, vault } = await vaultArea();
    const boundary = installBoundary(ctx);
    const actor = com1Actor();
    try {
      const identity = com1Identity(actor, { stock: false, finance: false, billing: false, purchases: false, pos: false });
      const response = await dispatch(ctx, actor, { identity });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: {
        status: "authorized", reference: fiscalReference(boundary.key), environment: "homologacao",
      }, effects: "pulado/part_disabled" });
      expect(vault.emissions.size).toBe(1);
      expect(boundary.effectApplications).toBe(0);
    } finally { boundary.restore(); }
  });

  it("duas abas e duplo clique reaproveitam uma nota e um efeito simulado", async () => {
    const clock = com1WorkerClock();
    const { ctx, vault } = await vaultArea({ now: clock.now });
    const boundary = installBoundary(ctx);
    const actor = com1Actor();
    const command = uid();
    const held = vault.pauseNext({ method: "POST", path: "/v1/nfe", phase: "after" });
    let first: Promise<Response> | undefined;
    try {
      first = dispatch(ctx, actor, {}, command);
      await held.reached;
      const otherTab = await dispatch(ctx, actor);
      expect(otherTab.status).toBe(200);
      const second = await otherTab.json() as { result: FiscalResult };
      held.release();
      expect(await (await first).json()).toMatchObject({ result: { provider_ref: second.result.provider_ref } });
      expect(await (await dispatch(ctx, actor, {}, command)).json()).toMatchObject({ result: {
        provider_ref: second.result.provider_ref, reference: fiscalReference(boundary.key), replayed: true,
      } });
      expect(vault.emissions.size).toBe(1);
      expect(vault.authorizedAtSefaz).toHaveLength(1);
      expect(boundary.effectApplications).toBe(1);
    } finally {
      held.release();
      try { await first; } finally { boundary.restore(); }
    }
  });

  it("resposta perdida conserva identidade e arquivos de emissão e cancelamento", async () => {
    const clock = com1WorkerClock();
    const { ctx, vault } = await vaultArea({ now: clock.now });
    const provider = createNfapiProvider({ delays: [0, 10, 20], sleep: clock.sleep, timeoutSignal });
    const key = { document_id: uid(), version: 1 };
    vault.plan.push("lose");
    const result = await provider.emit(ctx, "nfe", fiscalBody(), key);
    expect(result).toMatchObject({ status: "authorized", replayed: true, reference: fiscalReference(key) });
    expect(await provider.find(ctx, "nfe", key, "homologacao")).toMatchObject({ provider_ref: result.provider_ref });
    expect(await provider.find(ctx, "nfe", key, "producao")).toBeNull();
    expect((await provider.danfe(ctx, result.provider_ref)).body).toEqual(FAKE_PDF);
    expect(await provider.xml(ctx, "nfe", result.provider_ref)).toContain(result.access_key!);
    vault.plan.push("lose");
    const input = { justification: "Cancelamento do ensaio comercial." };
    expect(await provider.cancel(ctx, "nfe", result.provider_ref, input)).toMatchObject({ status: "cancelled" });
    expect(await provider.cancel(ctx, "nfe", result.provider_ref, input)).toMatchObject({ status: "cancelled", event_repeated: true });
    expect(await provider.cancellationXml(ctx, "nfe", result.provider_ref)).toBe(vault.cancellationXml(result.provider_ref));
    expect(await provider.cancellationXml(ctx, "nfe", result.provider_ref)).toContain(result.access_key!);
    expect(vault.authorizedAtSefaz).toHaveLength(1);
  });

  it("timeout depois do aceite retoma a mesma referência sem relógio real", async () => {
    const clock = com1WorkerClock();
    const { ctx, vault } = await vaultArea({ now: clock.now });
    const provider = createNfapiProvider({ delays: [0, 10], sleep: clock.sleep, timeoutSignal });
    const key = { document_id: uid(), version: 1 };
    const gate = vault.pauseNext({ method: "POST", path: "/v1/nfe", phase: "after" });
    const pending = provider.emit(ctx, "nfe", fiscalBody(), key);
    await gate.reached;
    gate.fail();
    const result = await pending;
    expect(result).toMatchObject({ status: "authorized", replayed: true, reference: fiscalReference(key) });
    expect(vault.emissionSends.get(vault.sefazKey("nfe", "homologacao", fiscalReference(key)))).toBe(1);
    expect(vault.emissions.size).toBe(1);
  });

  it("rotação de chave retoma o vínculo; troca de origem o recusa antes de buscar a nota", async () => {
    const { ctx, vault } = await vaultArea();
    const provider = createNfapiProvider({ delays: [0], sleep: async () => {}, timeoutSignal });
    ctx.connection_fingerprint = await fiscalConnectionFingerprint({
      provider: "nfapi", url: VAULT_URL, issuer_document: FAKE_CNPJ,
    });
    const key = { document_id: uid(), version: 1 };
    const result = await provider.emit(ctx, "nfe", fiscalBody(), key);
    const actor = com1Actor({ profiles: [ctx.profile] });
    vault.rotateApiKey("nfapi_chave_rotacionada_0123456789");
    await saveEmissor(ctx.env, actor, ctx.profile, { url: VAULT_URL, api_key: vault.apiKey });
    expect(await provider.find(ctx, "nfe", key, "homologacao")).toMatchObject({ provider_ref: result.provider_ref });
    const callsBefore = vault.calls.length;
    await saveEmissor(ctx.env, actor, ctx.profile, { url: "https://outro-cofre.invalid", api_key: vault.apiKey });
    await expect(provider.find(ctx, "nfe", key, "homologacao")).rejects.toMatchObject({ code: "fiscal_connection_changed" });
    expect(vault.calls.slice(callsBefore).map(call => call.path)).toEqual(["/v1/cofre"]);
    expect(vault.emissions.size).toBe(1);
  });
});
