import { describe, expect, it } from "vitest";
import { createCommercialNfeService } from "../src/erp/commercial-nfe/service.ts";
import { createCommercialNfeHttp } from "../src/erp/commercial-nfe/http.ts";
import type { CommercialNfeBridge } from "../src/erp/commercial-nfe/bridge.ts";
import type { CommercialNfeHttpContext } from "../src/erp/commercial-nfe/routes.ts";
import { COM1_OPERATIONS, commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import { commercialArtifact, parseCancellationXml } from "../src/erp/commercial-nfe/artifacts.ts";
import type { CommandReceipt, EffectView, EmissionView, FiscalResult, PedidoNfe } from "../src/erp/commercial-nfe/contracts.ts";
import { com1Hash, com1Json, com1Sha256 } from "../src/erp/domains/fiscal/comnfe/store.ts";
import { normalizeCommercialResult } from "../src/erp/domains/fiscal/comnfe/lifecycle.ts";
import { createNfapiProvider } from "../src/erp/emissor/nfapi-provider.ts";
import { FiscalError, type FiscalProvider } from "../src/erp/emissor/provider.ts";
import { FAKE_PDF } from "./erp/emissor/fake-vault";
import { example, vaultArea } from "./erp/emissor/helpers";
import { requestExample } from "./erp/emissor/schema";
import { COM1_TEST_IDS as IDs, com1Actor, com1Identity, com1NoIoEnv, com1Request, com1RouteDependencies } from "./com1-support";

const fingerprint = "f".repeat(64);
const stamp = "1795089600000000";
const nextCommand = (number: number) => `77777777-7777-4777-8777-${String(number).padStart(12, "0")}`;
const operation = (name: string) => COM1_OPERATIONS.find(op => op.name === name)!;
const eventXml = (key: string, environment = "2") => `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><retEvento versao="1.00"><infEvento><tpAmb>${environment}</tpAmb><chNFe>${key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>135260000000001</nProt><dhRegEvento>2026-11-19T12:01:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;

/** A ponte de ensaio registra as transações locais. A suíte node:test usa
 * SQLite real; aqui a falha de rede e o protocolo são do fake-vault comum. */
async function serviceFixture() {
  const area = await vaultArea();
  const original = createNfapiProvider({ delays: [0, 0], sleep: async () => {} });
  const provider: FiscalProvider = { ...original };
  const body = { ...example(requestExample("POST", "/v1/nfe")), ambiente: "homologacao",
    referencia: `wb.${IDs.document}.v1` } as PedidoNfe;
  const view: EmissionView & { cancellation_xml?: string | null } = {
    id: IDs.emission, document_id: IDs.document, fiscal_version: 1, environment: "homologacao",
    environment_confirmed: false, connection_fingerprint: fingerprint, reference: body.referencia!,
    current_body_revision: 1, status: "preparada", version: 1, provider_id: null, provider_status: null,
    messages: [], series: null, number: null, access_key: null, protocol: null, issued_at: null,
    authorized_at: null, total: null, created_at: stamp, created_by: IDs.user, updated_at: stamp,
    revision: { emission_id: IDs.emission, body_revision: 1, source_document_version: 1,
      snapshot: { document: { id: IDs.document }, items: [], company: {}, recipient: {}, products: [],
        nature: {}, payments: [], transport: {}, sources: [] }, tax_sources: {}, commercial_hash: "c".repeat(64),
      source_fingerprint: "d".repeat(64), body, body_hash: com1Hash(body), calculation: {}, blockers: [],
      prepared_by: IDs.user, prepared_at: stamp }, effects: [], cancellation: null,
  };
  const actor = com1Actor();
  const context: CommercialNfeHttpContext = { env: area.ctx.env, request: com1Request(operation("com1.emit")),
    profile: area.profile, actor, identity: com1Identity(actor), operation: operation("com1.emit"),
    params: { id: IDs.emission }, input: {}, authority: { origin: "application" }, fetch: area.vault.fetch };
  const calls: { name: string; input: any }[] = [];
  const commands = new Map<string, CommandReceipt>();
  let active: CommandReceipt | null = null;
  let effectFailure = false;
  let recordFailure = false;
  let sequence = 0;
  const copy = () => structuredClone(view);
  const pendingEffect = (axis: "stock" | "finance"): EffectView => ({ emission_id: view.id, axis, state: "pendente",
    origin: null, ids: {}, fingerprint: null, reason: "awaiting_effect", responsible_role: axis === "stock" ? "estoque" : "financeiro",
    person_id: null, command_id: null, result: null, compensation_state: null, compensation_command_id: null,
    compensation_result: null, updated_at: stamp });
  const bridge = { async call(name: string, input: any) {
    calls.push({ name, input: structuredClone(input) });
    if (name === "erp_com1_get") return copy();
    if (name === "erp_com1_config_get") return { environment: "homologacao", stock_timing: "on_authorization",
      finance_timing: "on_authorization", connection_fingerprint: fingerprint, connection_public: {}, version: 1 };
    if (name === "erp_com1_claim" || name === "erp_com1_cancel_claim") {
      const cancellation = name === "erp_com1_cancel_claim";
      const existing = commands.get(input.command_id);
      const response = (command: CommandReceipt, disposition: string) => cancellation
        ? { emission: copy(), cancellation: view.cancellation, command: structuredClone(command), disposition }
        : { emission: copy(), revision: copy().revision, command: structuredClone(command), disposition };
      if (existing) return response(existing, "replay");
      if (active) return response(active, "busy");
      if (view.revision.blockers.length) throw new FiscalError(422, "fiscal_preparation_blocked", "Corrija os dados fiscais.");
      const bodyText = cancellation ? com1Json({ justificativa: input.justification }) : com1Json(body);
      const command: CommandReceipt = { id: input.command_id, action: cancellation ? "cancel" : input.action,
        person_id: IDs.user, session_id: IDs.session, args_hash: com1Hash(input), emission_id: view.id,
        body_revision: 1, state: "claimed", token: nextCommand(900), lease_until: "1795089660000000",
        request: { kind: "nfe", environment: view.environment, reference: view.reference,
          connection_fingerprint: fingerprint, body_text: bodyText, body_hash: com1Sha256(bodyText),
          provider_id: view.provider_id, access_key: view.access_key, fiscal_version: 1, document_id: view.document_id },
        result: null, error: null, proposed_by: null, confirmed_by: null, created_at: stamp, updated_at: stamp };
      commands.set(command.id, command);
      active = command;
      if (cancellation) view.cancellation = { emission_id: view.id, command_id: command.id,
        justification: input.justification, state: "enviando", messages: [], protocol: null, event_at: null,
        repeated: false, xml_status: "pendente", xml_hash: null };
      else view.status = "enviando";
      view.version++;
      return response(command, input.action === "resume" ? "resume" : "send");
    }
    if (name === "erp_com1_record") {
      if (recordFailure) { recordFailure = false; throw new Error("queda antes do commit"); }
      const result = normalizeCommercialResult(input.result);
      const states = { authorized: "autorizada", rejected: "rejeitada", denied: "denegada", processing: "processando" } as const;
      view.status = result && result.reference === view.reference && result.environment === view.environment
        ? states[result.status as keyof typeof states] ?? "incerta" : "incerta";
      if (result) Object.assign(view, { provider_id: result.provider_ref, provider_status: result.status,
        environment_confirmed: true, access_key: result.access_key, protocol: result.protocol,
        series: Number(result.series), number: result.number, messages: result.messages });
      if (view.status === "autorizada") view.effects = [pendingEffect("stock"), pendingEffect("finance")];
      if (active) { active.state = view.status === "incerta" ? "pending" : "completed"; active.result = { status: view.status }; }
      active = null;
      view.version++;
      return copy();
    }
    if (name === "erp_com1_cancel_record") {
      const result = input.result as FiscalResult | null;
      if (result?.status === "cancelled") {
        view.status = "cancelada";
        view.cancellation!.state = input.event_protocol && input.event_at ? "registrado" : "incerto";
        view.cancellation!.protocol = input.event_protocol ?? null;
        view.cancellation!.event_at = input.event_at ?? null;
        view.cancellation!.repeated = result.event_repeated === true;
      } else view.cancellation!.state = input.state;
      active = null;
      view.version++;
      return copy();
    }
    if (name === "erp_com1_cancel_xml_record") {
      view.cancellation_xml = input.xml;
      view.cancellation!.xml_status = "disponivel";
      view.cancellation!.xml_hash = input.xml_hash;
      return structuredClone(view.cancellation);
    }
    if (name === "erp_com1_effect_apply" || name === "erp_com1_effect_reverse") {
      expect(["autorizada", "cancelada"]).toContain(view.status);
      if (effectFailure) throw new Error("efeito local indisponível");
      const effect = view.effects.find(effect => effect.axis === input.axis)!;
      if (name === "erp_com1_effect_apply") Object.assign(effect, { state: "aplicado", ids: { posting_id: `${input.axis}-posting` }, reason: null });
      else effect.compensation_state = "compensacao_pendente";
      return structuredClone(effect);
    }
    throw new Error(`RPC inesperado no ensaio: ${name}`);
  } } as unknown as CommercialNfeBridge;
  const service = createCommercialNfeService(context, { bridge,
    vault: async () => ({ provider, context: area.ctx, fingerprint }), uuid: () => nextCommand(++sequence) });
  const emitInput = (command = IDs.command) => ({ emission_id: view.id, command_id: command,
    expected_version: view.version, body_revision: view.current_body_revision, body_hash: view.revision.body_hash! });
  const cancelInput = (command = nextCommand(100)) => ({ emission_id: view.id, command_id: command,
    expected_version: view.version, justification: "Cancelamento de operação de ensaio." });
  return { ...area, context, service, provider, original, view, calls, commands, copy, emitInput, cancelInput,
    failEffects: () => { effectFailure = true; }, failRecord: () => { recordFailure = true; },
    expireLease: () => { active = null; } };
}

describe("NF-e comercial: protocolo entre transações locais e cofre simulado", () => {
  for (const [behavior, expected] of [["ok", "autorizada"], ["reject", "rejeitada"], ["deny", "denegada"],
    ["lose", "autorizada"], ["drop", "autorizada"], ["gateway", "autorizada"]] as const) {
    it(`${behavior}: persiste intenção antes da chamada e evidência antes dos efeitos`, async () => {
      const f = await serviceFixture();
      f.vault.plan.push(behavior);
      f.provider.emit = async (...args) => {
        const claim = f.calls.find(call => call.name === "erp_com1_claim");
        expect(claim).toBeDefined();
        const receipt = f.commands.get(claim!.input.command_id)!;
        expect(receipt.request?.body_text).toBe(com1Json(f.view.revision.body));
        expect(receipt.request?.body_hash).toBe(f.view.revision.body_hash);
        expect(receipt.request?.reference).toBe(f.view.reference);
        return f.original.emit(...args);
      };
      const result = await f.service.emit(f.emitInput());
      expect(result.status).toBe(expected);
      const names = f.calls.map(call => call.name);
      expect(names.indexOf("erp_com1_record")).toBeGreaterThan(names.indexOf("erp_com1_claim"));
      for (const effect of f.calls.filter(call => call.name === "erp_com1_effect_apply")) {
        expect(names.indexOf("erp_com1_record")).toBeLessThan(f.calls.indexOf(effect));
      }
      expect(f.vault.authorizedAtSefaz.length).toBe(expected === "autorizada" ? 1 : 0);
      expect(f.calls.find(call => call.name === "erp_com1_record")!.input.claim_token).toBeTruthy();
    });
  }

  it("bloqueio fiscal impede envio e aponta campo a corrigir", async () => {
    const f = await serviceFixture();
    f.view.revision.blockers.push({ code: "fiscal_product_incomplete", field: "items.0.ncm",
      message: "Complete o NCM do produto.", correction: { screen: "products", field: "ncm" } });
    await expect(f.service.emit(f.emitInput())).rejects.toMatchObject({ status: 422 });
    expect(f.vault.calls.filter(call => call.method === "POST")).toHaveLength(0);
  });

  it("duas abas e comandos distintos compartilham uma chamada externa", async () => {
    const f = await serviceFixture();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.provider.emit = async (...args) => { entered(); await hold; return f.original.emit(...args); };
    const firstInput = f.emitInput();
    const first = f.service.emit(firstInput);
    await started;
    const busy = await f.service.emit(f.emitInput(nextCommand(101)));
    expect(["enviando", "incerta"]).toContain(busy.status);
    release();
    expect((await first).status).toBe("autorizada");
    expect((await f.service.emit(firstInput)).status).toBe("autorizada");
    expect(f.vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe")).toHaveLength(1);
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
    expect(f.calls.filter(call => call.name === "erp_com1_effect_apply").map(call => call.input.axis)).toEqual(["stock", "finance"]);
  });

  it("timeout preserva referência e retomada usa a mesma revisão", async () => {
    const f = await serviceFixture();
    f.provider.emit = async () => { throw new FiscalError(504, "fiscal_timeout", "Tempo esgotado."); };
    expect((await f.service.emit(f.emitInput())).status).toBe("incerta");
    f.provider.emit = f.original.emit;
    const result = await f.service.resume({ emission_id: f.view.id, command_id: nextCommand(103),
      expected_version: f.view.version, body_revision: 1 });
    expect(["autorizada", "incerta"]).toContain(result.status);
    for (const receipt of f.commands.values()) expect(receipt.request?.reference).toBe(f.view.reference);
    expect(f.vault.authorizedAtSefaz.length).toBeLessThanOrEqual(1);
  });

  it("queda antes do commit recupera a autorização já aceita, sem nova nota", async () => {
    const f = await serviceFixture();
    f.failRecord();
    await expect(f.service.emit(f.emitInput())).rejects.toThrow();
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
    f.expireLease();
    const result = await f.service.resume({ emission_id: f.view.id, command_id: nextCommand(104),
      expected_version: f.view.version, body_revision: 1 });
    expect(result.status).toBe("autorizada");
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
  });

  it("falhas independentes dos efeitos conservam a autorização e as pendências", async () => {
    const f = await serviceFixture();
    f.failEffects();
    const result = await f.service.emit(f.emitInput());
    expect(result.status).toBe("autorizada");
    expect(result.effects.map(effect => effect.state)).toEqual(["pendente", "pendente"]);
    expect(f.calls.filter(call => call.name === "erp_com1_effect_apply").map(call => call.input.axis)).toEqual(["stock", "finance"]);
  });

  it("processamento não dispara efeitos nem inventa autorização", async () => {
    const f = await serviceFixture();
    f.provider.emit = async (...args) => ({ ...await f.original.emit(...args), status: "processing",
      protocol: null, access_key: null, authorized_at: null });
    const result = await f.service.emit(f.emitInput());
    expect(result.status).toBe("processando");
    expect(f.calls.some(call => call.name === "erp_com1_effect_apply")).toBe(false);
  });

  it("evidência de autorização dentro de erro é persistida", async () => {
    const f = await serviceFixture();
    f.provider.emit = async (...args) => {
      const emission = await f.original.emit(...args);
      throw new FiscalError(502, "fiscal_no_conclusive_answer", "Resposta interrompida.", { emission });
    };
    expect((await f.service.emit(f.emitInput())).status).toBe("autorizada");
    expect(f.calls.find(call => call.name === "erp_com1_record")?.input.result.status).toBe("authorized");
  });

  it("resposta malformada chega ao commit de evidência e não autoriza", async () => {
    const f = await serviceFixture();
    f.provider.emit = async () => ({ kind: "nfe", status: "authorized", protocol: "incompleto" } as FiscalResult);
    const result = await f.service.emit(f.emitInput());
    expect(result.status).toBe("incerta");
    expect(f.calls.find(call => call.name === "erp_com1_record")?.input.result).toMatchObject({ protocol: "incompleto" });
    expect(f.calls.some(call => call.name === "erp_com1_effect_apply")).toBe(false);
  });

  it("DANFE repassa bytes conhecidos pelo identificador persistido e sem cache", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    const response = await f.service.danfe({ emission_id: f.view.id });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FAKE_PDF);
    expect(f.vault.calls.some(call => call.path === `/v1/nfe/${f.view.provider_id}/danfe`)).toBe(true);
    expect(f.vault.calls.some(call => call.path.includes(f.view.reference))).toBe(false);
  });

  it("arquivo de outra conexão ou ambiente é recusado antes do download", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    let downloads = 0;
    f.provider.danfe = async (...args) => { downloads++; return f.original.danfe(...args); };
    await expect(commercialArtifact(f.view, { provider: f.provider, context: f.ctx, fingerprint: "a".repeat(64) }, "danfe"))
      .rejects.toMatchObject({ code: "fiscal_connection_changed" });
    f.provider.get = async (...args) => ({ ...await f.original.get(...args), environment: "producao" });
    await expect(f.service.danfe({ emission_id: f.view.id })).rejects.toMatchObject({ code: "fiscal_artifact_mismatch" });
    expect(downloads).toBe(0);
  });

  it("cancelamento fiscal sobrevive ao XML indisponível e à falha local", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    f.failEffects();
    f.provider.cancellationXml = async () => { throw new Error("XML ainda indisponível"); };
    const result = await f.service.cancel(f.cancelInput());
    expect(result.status).toBe("cancelada");
    expect(result.cancellation?.xml_status).toBe("pendente");
    const names = f.calls.map(call => call.name);
    expect(names.indexOf("erp_com1_cancel_claim")).toBeLessThan(names.indexOf("erp_com1_cancel_record"));
    expect(f.calls.some(call => call.name === "erp_com1_cancel_xml_record")).toBe(false);
  });

  it("cancelamento perdido é recuperado na mesma emissão", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    const providerId = f.view.provider_id;
    f.vault.plan.push("lose");
    const result = await f.service.cancel(f.cancelInput());
    expect(result.status).toBe("cancelada");
    expect(result.provider_id).toBe(providerId);
    expect(f.vault.calls.filter(call => call.method === "POST" && call.path.endsWith("/cancelar"))).toHaveLength(1);
  });

  it("XML válido arquiva protocolo do evento e repetição não cancela de novo", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    const xml = eventXml(f.view.access_key!);
    f.provider.cancellationXml = async () => xml;
    const input = f.cancelInput();
    const result = await f.service.cancel(input);
    expect(result.status).toBe("cancelada");
    expect(result.cancellation).toMatchObject({ state: "registrado", protocol: "135260000000001",
      event_at: "1795089660000000", xml_status: "disponivel", xml_hash: com1Sha256(xml) });
    const archive = f.calls.find(call => call.name === "erp_com1_cancel_xml_record")!;
    expect(archive.input.xml).toBe(xml);
    expect(archive.input.xml_hash).toBe(com1Sha256(xml));
    expect((await f.service.cancel(input)).status).toBe("cancelada");
    expect(f.vault.calls.filter(call => call.method === "POST" && call.path.endsWith("/cancelar"))).toHaveLength(1);
    const download = await f.service.cancellationXml({ emission_id: f.view.id });
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toBe(xml);
  });

  it("XML de outro evento, chave ou ambiente nunca completa o arquivamento", async () => {
    const f = await serviceFixture();
    await f.service.emit(f.emitInput());
    const valid = eventXml(f.view.access_key!);
    for (const xml of [eventXml("1".repeat(44)), eventXml(f.view.access_key!, "1"),
      valid.replace("110111", "110110"), valid.replace("<cStat>135</cStat>", "<cStat>573</cStat>"),
      valid.replace("<retEvento", "<!DOCTYPE a [<!ENTITY b SYSTEM 'file:///private'>]><retEvento")]) {
      expect(() => parseCancellationXml(xml, f.view)).toThrow();
    }
  });
});

describe("NF-e comercial: fronteira pública instalada", () => {
  it("bot confirmado chega ao mesmo handler e a resposta esconde capacidades internas", async () => {
    const f = await serviceFixture();
    const restore = installCommercialNfeHttp(createCommercialNfeHttp({ service: () => f.service }));
    try {
      const actor = com1Actor({ via: { kind: "bot", bot_id: "fiscal", run_id: "ensaio", proposal_id: "confirmada", masked: true } });
      const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation("com1.emit"), { body_hash: f.view.revision.body_hash }),
        "com1", actor, com1RouteDependencies());
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ status: "autorizada" });
      expect(body).not.toContain("claim_token");
      expect(body).not.toContain("body_text");
      expect(body).not.toContain(nextCommand(900));
    } finally { restore(); }
  });

  for (const name of ["com1.emit", "com1.resume", "com1.cancel", "com1.danfe", "com1.xml"]) {
    it(`${name}: origem externa e bot sem configuração não alcançam o serviço`, async () => {
      let called = false;
      const restore = installCommercialNfeHttp(async () => { called = true; return Response.json({}); });
      try {
        const actor = com1Actor({ via: { kind: "bot", bot_id: "sem-acesso", run_id: "ensaio", masked: true } });
        const identity = com1Identity(actor);
        identity.actor!.erp_role = "vendas";
        expect((await commercialNfeRoute(com1NoIoEnv, com1Request(operation(name)), "com1", actor,
          com1RouteDependencies({ identity }))).status).toBe(403);
        expect((await commercialNfeRoute(com1NoIoEnv, com1Request(operation(name)), "com1", com1Actor(),
          com1RouteDependencies({ authority: { origin: "external", autonomous: true } }))).status).toBe(403);
        expect(called).toBe(false);
      } finally { restore(); }
    });
  }

  it("browser não declara autorização, protocolo, corpo ou token de commit", async () => {
    let called = false;
    const restore = installCommercialNfeHttp(async () => { called = true; return Response.json({}); });
    try {
      for (const extra of [{ status: "autorizada" }, { protocol: "forjado" }, { body: {} }, { claim_token: nextCommand(900) },
        { connection_fingerprint: fingerprint }, { source_fingerprint: "d".repeat(64) }]) {
        const response = await commercialNfeRoute(com1NoIoEnv, com1Request(operation("com1.emit"), extra),
          "com1", com1Actor(), com1RouteDependencies());
        expect(response.status).toBe(400);
      }
      expect(called).toBe(false);
    } finally { restore(); }
  });
});
