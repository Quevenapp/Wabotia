import { describe, expect, it } from "vitest";
import type { Actor } from "../src/types";
import type { CommercialSettings, EffectView, EmissionView, FiscalBlocker, PedidoNfe } from "../src/erp/commercial-nfe/contracts.ts";
import { COM1_OPERATIONS, commercialNfeRoute, type CommercialNfeHttpContext, type CommercialNfeRouteDependencies } from "../src/erp/commercial-nfe/routes.ts";
import { installCommercialNfeHttp } from "../src/erp/commercial-nfe/slots.ts";
import { commercialNfePublicDto } from "../src/erp/commercial-nfe/http.ts";
import { engineActor } from "../src/security";
import {
  CommercialNfeError, createCommercialNfePort, createCommandIntent, emissionCanEmit,
  type CommercialNfeAccess, type CommercialNfePort,
} from "../web/erp/commercial-nfe.ts";
import { COM1_TEST_IDS as ids, com1Actor, com1Identity, com1NoIoEnv, com1RouteDependencies } from "./com1-support";

const hash = "a".repeat(64), time = "1795089600000000";
const secondCommand = "77777777-7777-4777-8777-777777777777";
const access: CommercialNfeAccess = {
  ready: true, role: "admin", permissions: null,
  parts: { base: true, products: true, sales: true, fiscal: true, stock: true, finance: true },
};
const address = { logradouro: "Praça da Sé", numero: "100", bairro: "Sé", codigoMunicipio: "3550308", municipio: "São Paulo", uf: "SP" as const, cep: "01001000" };
/** Corpo simulado PRODUZIDO PELO SERVIDOR. O teste nunca o envia pela porta do painel. */
const body: PedidoNfe = {
  ambiente: "homologacao", referencia: `wb.${ids.document}.v1`, naturezaOperacao: "Venda nacional de mercadorias",
  tipo: "saida", finalidade: "normal", presenca: "presencial", consumidorFinal: true, destinoOperacao: "interna",
  emitente: { cnpj: "11222333000181", nome: "Empresa de Ensaio", inscricaoEstadual: "110042490114", regime: "simples_nacional", endereco: address },
  destinatario: { cnpj: "19131243000197", nome: "Cliente do Ensaio", indicadorIe: "nao_contribuinte", endereco: { ...address, numero: "200" } },
  itens: [{ codigo: "TESTE", descricao: "Mercadoria de ensaio", ncm: "84713012", cfop: "5102", unidade: "UN", quantidade: 2, valorUnitario: 25.5, impostos: { icms: { origem: 0, csosn: "102" } } }],
  pagamentos: [{ forma: "01", valor: 51, indicador: "a_vista" }],
};
const settings: CommercialSettings = {
  id: 1, version: 1, environment: "homologacao", stock_timing: "on_authorization", finance_timing: "on_authorization",
  series_homologacao: 1, series_producao: null, connection_fingerprint: hash,
  connection_public: { provider: "nfapi", origin: "https://cofre-simulado.invalid", issuer_cnpj: "11222333000181",
    version: "0.12.0", checked_at: time, compatible: true, environments: ["homologacao"],
    series: [{ environment: "homologacao", series: 1 }] },
  production_enabled_at: null, production_enabled_by: null, tax_limits_acknowledged_at: time,
  tax_limits_acknowledged_by: ids.user, updated_at: time, updated_by: ids.user,
};
function effect(axis: "stock" | "finance", overrides: Partial<EffectView> = {}): EffectView {
  return { emission_id: ids.emission, axis, state: "aplicado", origin: "document", ids: { posting_id: `${axis}-posting-1` },
    fingerprint: hash, reason: null, responsible_role: axis === "stock" ? "estoque" : "financeiro", person_id: ids.user,
    command_id: ids.command, result: null, compensation_state: null, compensation_command_id: null,
    compensation_result: null, updated_at: time, ...overrides };
}
function emission(status: EmissionView["status"] = "autorizada"): EmissionView {
  const authorized = status === "autorizada" || status === "cancelada";
  return {
    id: ids.emission, document_id: ids.document, fiscal_version: 1, environment: "homologacao", environment_confirmed: authorized,
    connection_fingerprint: hash, reference: body.referencia!, current_body_revision: 1, status, version: 1,
    provider_id: authorized ? "cofre-emissao-1" : null, provider_status: authorized ? "autorizada" : null,
    messages: [], series: authorized ? 1 : null, number: authorized ? 15 : null,
    access_key: authorized ? "1".repeat(44) : null, protocol: authorized ? "135260000000001" : null,
    issued_at: authorized ? time : null, authorized_at: authorized ? time : null,
    total: "5100", created_at: time, created_by: ids.user, updated_at: time,
    revision: { emission_id: ids.emission, body_revision: 1, source_document_version: 1,
      snapshot: { document: { id: ids.document, version: 1, total: "51.00" }, items: [{ description: "Mercadoria de ensaio", quantity: "2" }],
        company: { name: "Empresa de Ensaio" }, recipient: { name: "Cliente do Ensaio" }, products: [], nature: { id: ids.nature }, payments: [{ amount: "51.00" }], transport: { mode: "9" }, sources: [] },
      tax_sources: {}, commercial_hash: hash, source_fingerprint: hash, body: structuredClone(body), body_hash: hash,
      calculation: { totals: { products: "51.00", invoice: "51.00" }, items: [{ icms: { csosn: "102", value: "0.00" } }] },
      blockers: [], prepared_by: ids.user, prepared_at: time },
    effects: authorized ? [effect("stock"), effect("finance")] : [],
    cancellation: status === "cancelada" ? { emission_id: ids.emission, justification: "Cancelamento de venda de ensaio.",
      command_id: ids.command, state: "registrado", messages: [], protocol: "135260000000002", event_at: time,
      repeated: false, xml_status: "disponivel", xml_hash: hash } : null,
  };
}
const emitInput = { emission_id: ids.emission, command_id: ids.command, expected_version: 1, body_revision: 1, body_hash: hash };
const prepareInput = { document_id: ids.document, command_id: ids.command, expected_document_version: 1,
  choices: { nature_id: ids.nature, presence: "presencial", final_consumer: true } };
const configInput = { command_id: ids.command, expected_version: 1, environment: "homologacao" as const,
  stock_timing: "on_authorization" as const, finance_timing: "on_authorization" as const };
const cancelInput = { emission_id: ids.emission, command_id: ids.command, expected_version: 1, justification: "Cancelamento de venda de ensaio." };

function successfulResponse(context: CommercialNfeHttpContext): Response {
  switch (context.operation.name) {
    case "com1.config.get": case "com1.config.save": return Response.json(settings);
    case "com1.prepare": return Response.json({ emission: emission("preparada"), blockers: [], effects_preview: [], replayed: false });
    case "com1.list": return Response.json({ items: [emission()], page: 1, per_page: 25, total: 1 });
    case "com1.effects": return Response.json(effect(context.input.axis === "finance" ? "finance" : "stock"));
    case "com1.cancel": return Response.json(emission("cancelada"));
    case "com1.danfe": return new Response(`%PDF-1.4\nDANFE simulado do cofre: ${context.params.id}`, { headers: { "Content-Type": "application/pdf" } });
    case "com1.xml": case "com1.cancel.xml": return new Response(`<arquivo emissao="${context.params.id}" tipo="${context.operation.name}"/>`, { headers: { "Content-Type": "application/xml" } });
    default: return Response.json(emission());
  }
}
function invoke(port: CommercialNfePort, name: string): Promise<unknown> {
  switch (name) {
    case "com1.config.get": return port.config();
    case "com1.config.save": return port.saveConfig(configInput);
    case "com1.prepare": return port.prepare(prepareInput);
    case "com1.list": return port.list({ environment: "homologacao", document_id: ids.document });
    case "com1.get": return port.read(ids.emission);
    case "com1.emit": return port.emit(emitInput);
    case "com1.resume": return port.resume(emitInput);
    case "com1.effects": return port.effects({ emission_id: ids.emission, command_id: ids.command, expected_version: 1, axis: "stock", intent: "apply" });
    case "com1.cancel": return port.cancel(cancelInput);
    case "com1.danfe": return port.artifact(ids.emission, "danfe");
    case "com1.xml": return port.artifact(ids.emission, "xml");
    case "com1.cancel.xml": return port.artifact(ids.emission, "cancellation_xml");
    default: throw new Error(`Operação sem prova do painel: ${name}`);
  }
}
function linkedPort(actor: Actor = com1Actor(), dependencies: CommercialNfeRouteDependencies = com1RouteDependencies(), after?: (response: Response, request: Request) => Promise<Response>): CommercialNfePort {
  const transport: typeof fetch = async (url, init) => {
    const request = new Request(new URL(String(url), "https://wabotia.invalid"), init);
    const response = await commercialNfeRoute(com1NoIoEnv, request, "com1", actor, dependencies);
    return after ? after(response, request) : response;
  };
  // A porta acredita no acesso ativo. Os casos de negativa provam que o servidor
  // revalida a identidade mesmo diante de uma tela desatualizada ou manipulada.
  return createCommercialNfePort("com1", { access: () => access, fetch: transport });
}

describe("privacidade do DTO fiscal comercial", () => {
  const customerName = "Álvaro & Filhos (Matriz)", customerCnpj = "12ABC34501DE35";
  function privateView() {
    const view = emission("bloqueada");
    const note = `Conferir ${customerName}, CNPJ 12.abc.345/01de-35 (${customerCnpj}).`;
    view.revision.snapshot.recipient = { name: customerName, document: customerCnpj, nfe_email: "fiscal@cliente.invalid" };
    view.revision.snapshot.company = { legal_name: "Emitente Privado Ltda.", trade_name: "Loja Privada" };
    view.revision.snapshot.document.notes = note;
    view.revision.body!.destinatario!.nome = customerName;
    view.revision.body!.destinatario!.cnpj = customerCnpj;
    view.revision.body!.informacoesComplementares = note;
    view.messages = [{ code: "cadastro_incompleto", description: note }];
    view.revision.blockers = [{ code: "fiscal_recipient_incomplete", field: "recipient.document", entity_id: ids.user,
      message: `O cliente ${customerName}, CNPJ ${customerCnpj}, está sem endereço.`, correction: { screen: "contacts", id: ids.user, field: "document" } }];
    return view;
  }
  const context = (actor: Actor, name = "com1.get"): CommercialNfeHttpContext => ({
    env: com1NoIoEnv, request: new Request("https://wabotia.invalid/api/v1/profiles/ensaio/erp-comercial-nfe/emissoes"),
    profile: "ensaio", actor, identity: com1Identity(actor), operation: COM1_OPERATIONS.find(op => op.name === name)!,
    params: { id: ids.emission }, input: {}, authority: { origin: "application" }, fetch: globalThis.fetch,
  });
  const bot = (masked = true) => com1Actor({ via: { kind: "bot", bot_id: "bot-fiscal", run_id: "privacidade", proposal_id: "proposta-confirmada", masked } });

  it("mascara nomes e CNPJ alfanumérico em bloqueios, mensagens e observações, inclusive na lista", () => {
    const view = privateView(), projected = commercialNfePublicDto(context(bot()), view) as EmissionView;
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(customerName);
    expect(serialized).not.toContain(customerCnpj);
    expect(serialized).not.toContain("12.abc.345/01de-35");
    expect(serialized).not.toContain("Emitente Privado Ltda.");
    expect(serialized).not.toContain("Loja Privada");
    expect(projected.revision.blockers[0].message).toContain("[dado pessoal oculto]");
    expect(projected.revision.snapshot.document).toMatchObject({ id: ids.document });
    expect(projected.revision.body!.destinatario!.endereco).toEqual(expect.objectContaining({ logradouro: "[dado pessoal oculto]" }));
    expect(projected.reference).toBe(view.reference);
    expect(projected.revision.body_hash).toBe(view.revision.body_hash);
    expect(projected.revision.blockers[0]).toMatchObject({ code: "fiscal_recipient_incomplete", field: "recipient.document", entity_id: ids.user,
      correction: { screen: "contacts", id: ids.user, field: "document" } });
    const listed = commercialNfePublicDto(context(bot(true), "com1.list"), { items: [view], page: 1, per_page: 25, total: 1 });
    expect(JSON.stringify(listed)).not.toContain(customerName);
    expect(JSON.stringify(listed)).not.toContain(customerCnpj);
    expect(JSON.stringify(listed)).not.toContain("12.abc.345/01de-35");
  });

  it("preserva dados para pessoa e concessão explícita sem máscara, sem alterar o original", () => {
    const view = privateView(), before = structuredClone(view);
    for (const actor of [com1Actor(), bot(false)]) {
      const projected = commercialNfePublicDto(context(actor), view) as EmissionView;
      expect(projected.revision.snapshot.recipient.name).toBe(customerName);
      expect(projected.revision.body!.destinatario!.cnpj).toBe(customerCnpj);
      expect(projected.revision.blockers[0].message).toContain(customerName);
      expect(projected.revision.body!.informacoesComplementares).toContain("12.abc.345/01de-35");
    }
    commercialNfePublicDto(context(bot()), view);
    expect(view).toEqual(before);
  });
});

describe("painel comercial: porta ligada à fronteira HTTP real, com servidor simulado", () => {
  for (const operation of COM1_OPERATIONS) {
    it(`${operation.name}: bot confirmado usa a mesma operação; sem configuração e externo são recusados`, async () => {
      let calls = 0;
      const restore = installCommercialNfeHttp(async context => {
        calls++;
        expect(context.operation.name).toBe(operation.name);
        expect(context.authority).toMatchObject({ proposed_by: "bot-fiscal", confirmed_by: ids.user, confirmation_id: "proposta-confirmada" });
        expect(context.identity.actor).toMatchObject({ user_id: ids.user, is_agent: false });
        expect(context.identity.customer_privacy).toEqual({ restricted_contact_ids: [] });
        expect(Object.keys(context.input).every(key => [...operation.body, ...(operation.query ?? [])].includes(key))).toBe(true);
        return successfulResponse(context);
      });
      try {
        const confirmed = com1Actor({ via: { kind: "bot", bot_id: "bot-fiscal", run_id: "run-teste", proposal_id: "proposta-confirmada", masked: true } });
        await invoke(linkedPort(confirmed, com1RouteDependencies(), async response => {
          expect(response.headers.get("Cache-Control")).toBe("private, no-store");
          expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
          return response;
        }), operation.name);
        expect(calls).toBe(1);

        const unconfigured = com1Actor({ via: { kind: "bot", bot_id: "bot-sem-acesso", run_id: "run-teste", masked: true } });
        const identity = com1Identity(unconfigured); identity.actor!.erp_role = "vendas";
        await expect(invoke(linkedPort(unconfigured, com1RouteDependencies({ identity })), operation.name)).rejects.toMatchObject({ status: 403 });
        await expect(invoke(linkedPort(engineActor("com1", "bot-cliente"), {
          resolveIdentity: async () => { throw new Error("Origem externa não deve resolver identidade fiscal."); },
        }), operation.name)).rejects.toMatchObject({ status: 403, code: "fiscal_external_origin_forbidden" });
        expect(calls).toBe(1);
      } finally { restore(); }
    });
  }

  it("bloqueios completos impedem a ação e o servidor simulado também recusa o envio", async () => {
    const blockers: FiscalBlocker[] = [
      { code: "fiscal_recipient_incomplete", field: "recipient.document", entity_id: ids.user, message: "O cliente está sem documento. Corrija em Clientes e fornecedores.", correction: { screen: "contacts", id: ids.user, field: "document" } },
      { code: "fiscal_product_incomplete", field: "items.0.ncm", item_id: ids.nature, message: "O produto está sem NCM, necessário para esta operação.", correction: { screen: "products", id: ids.nature, field: "ncm" } },
    ];
    let sends = 0;
    const restore = installCommercialNfeHttp(async context => {
      if (context.operation.name === "com1.emit") return Response.json({ code: "fiscal_blocked", message: "Corrija os dados fiscais antes de emitir.", blockers }, { status: 422 });
      if (context.operation.name !== "com1.prepare") { sends++; throw new Error("Não deveria emitir."); }
      const view = emission("bloqueada"); view.revision.blockers = blockers; view.revision.body = null; view.revision.body_hash = null;
      return Response.json({ emission: view, blockers, effects_preview: [], replayed: false });
    });
    try {
      const port = linkedPort(), prepared = await port.prepare(prepareInput);
      expect(prepared.blockers).toEqual(blockers);
      expect(emissionCanEmit(prepared.emission, access)).toBe(false);
      await expect(port.emit(emitInput)).rejects.toMatchObject({ status: 422, code: "fiscal_blocked", blockers, uncertain: false });
      expect(sends).toBe(0);
    } finally { restore(); }
  });

  it("resposta perdida, duplo clique, retry e duas abas preservam emissão e efeitos únicos", async () => {
    const received: Record<string, unknown>[] = [], receipts = new Map<string, EmissionView>();
    let authorizations = 0, localEffects = 0, persisted: EmissionView | null = null, loseResponse = true;
    const restore = installCommercialNfeHttp(async context => {
      if (context.operation.name === "com1.emit") {
        received.push(context.input);
        const command = String(context.input.command_id);
        if (!persisted) { persisted = emission(); authorizations++; localEffects += 2; }
        if (!receipts.has(command)) receipts.set(command, persisted);
        return Response.json(receipts.get(command));
      }
      if (context.operation.name === "com1.resume" || context.operation.name === "com1.get") {
        expect(context.params.id).toBe(ids.emission);
        return Response.json(persisted);
      }
      throw new Error("Operação inesperada.");
    });
    try {
      const port = linkedPort(com1Actor(), com1RouteDependencies(), async (response, request) => {
        if (request.url.endsWith("/emitir") && loseResponse) { loseResponse = false; throw new TypeError("Resposta perdida após persistência."); }
        return response;
      });
      const intent = createCommandIntent(() => ids.command), { command_id: _command, ...args } = emitInput;
      const first = intent.run(args, input => port.emit(input));
      const doubleClick = intent.run(args, input => port.emit(input));
      expect(doubleClick).toBe(first);
      await expect(first).rejects.toMatchObject({ code: "fiscal_response_lost", uncertain: true });
      expect(intent.commandId).toBe(ids.command);
      const retried = await intent.run(args, input => port.emit(input));
      const resumed = await port.resume({ ...emitInput, command_id: secondCommand });
      const otherTab = await linkedPort().emit({ ...emitInput, command_id: secondCommand });
      expect(received.slice(0, 2)).toEqual([received[0], received[0]]);
      expect([retried.id, resumed.id, otherTab.id]).toEqual([ids.emission, ids.emission, ids.emission]);
      expect(new Set([retried.reference, resumed.reference, otherTab.reference]).size).toBe(1);
      expect(authorizations).toBe(1); expect(localEffects).toBe(2);
      expect(otherTab.effects.map(value => value.ids)).toEqual(retried.effects.map(value => value.ids));
    } finally { restore(); }
  });

  it("202 mantém situação incerta e retoma o mesmo vínculo, sem inventar autorização", async () => {
    const requests: string[] = [];
    const restore = installCommercialNfeHttp(async context => {
      requests.push(context.operation.name);
      expect(context.params.id).toBe(ids.emission);
      return Response.json(emission(context.operation.name === "com1.resume" ? "processando" : "incerta"), { status: 202 });
    });
    try {
      const port = linkedPort(), read = await port.read(ids.emission), resumed = await port.resume(emitInput);
      expect(read.status).toBe("incerta"); expect(read.protocol).toBeNull();
      expect(resumed.status).toBe("processando"); expect(resumed.reference).toBe(read.reference);
      expect(emissionCanEmit(read, access)).toBe(false); expect(emissionCanEmit(resumed, access)).toBe(false);
      expect(requests).toEqual(["com1.get", "com1.resume"]);
    } finally { restore(); }
  });

  it("autorização sobrevive às partes vizinhas desligadas; os skips ficam explícitos", async () => {
    const identity = com1Identity(com1Actor(), { stock: false, finance: false, products: false, sales: false });
    const restore = installCommercialNfeHttp(async () => {
      const view = emission(); view.effects = [effect("stock", { state: "pulado", reason: "part_disabled", ids: {} }), effect("finance", { state: "pulado", reason: "part_disabled", ids: {} })];
      return Response.json(view);
    });
    try {
      const port = linkedPort(com1Actor(), com1RouteDependencies({ identity }));
      const view = await port.read(ids.emission);
      expect(view.status).toBe("autorizada"); expect(view.protocol).toBeTruthy();
      expect(view.effects.map(value => [value.axis, value.state, value.reason])).toEqual([["stock", "pulado", "part_disabled"], ["finance", "pulado", "part_disabled"]]);
      await expect(port.prepare(prepareInput)).rejects.toMatchObject({ status: 409, code: "module_disabled" });
    } finally { restore(); }
  });

  it("DANFE e XML usam somente o vínculo da emissão, com conteúdo fornecido pelo cofre simulado", async () => {
    const paths: string[] = [];
    const restore = installCommercialNfeHttp(async context => {
      expect(context.params.id).toBe(ids.emission); expect(context.input).toEqual({}); paths.push(new URL(context.request.url).pathname);
      return successfulResponse(context);
    });
    try {
      const port = linkedPort(), danfe = await port.artifact(ids.emission, "danfe"), xml = await port.artifact(ids.emission, "xml"), event = await port.artifact(ids.emission, "cancellation_xml");
      expect(danfe.type).toBe("application/pdf"); expect(await danfe.text()).toContain(`DANFE simulado do cofre: ${ids.emission}`);
      expect(xml.type).toBe("application/xml"); expect(await xml.text()).toContain(`emissao="${ids.emission}"`);
      expect(await event.text()).toContain('tipo="com1.cancel.xml"');
      expect(paths.map(path => path.split(`/emissoes/${ids.emission}/`)[1])).toEqual(["danfe", "xml", "cancelamento/xml"]);
      expect(paths.some(path => path.includes("cofre-emissao-1") || path.includes(body.referencia!))).toBe(false);
    } finally { restore(); }
  });

  it("cancelamento preserva XML pendente, título recebido e compensação local pendente", async () => {
    const restore = installCommercialNfeHttp(async context => {
      if (context.operation.name === "com1.cancel.xml") return Response.json({ code: "fiscal_cancellation_xml_pending", message: "Nota cancelada; XML do evento pendente de arquivamento." }, { status: 202 });
      expect(context.input.justification).toBe(cancelInput.justification);
      const view = emission("cancelada"); view.cancellation!.xml_status = "pendente"; view.cancellation!.xml_hash = null;
      view.effects = [effect("stock", { compensation_state: "compensacao_pendente", reason: "physical_return_not_confirmed" }),
        effect("finance", { compensation_state: "compensacao_pendente", reason: "title_received", compensation_result: { received: true, action: "Revisar recebimento no Financeiro; pagamento preservado." } })];
      return Response.json(view);
    });
    try {
      const port = linkedPort(), view = await port.cancel(cancelInput);
      expect(view.status).toBe("cancelada"); expect(view.cancellation).toMatchObject({ state: "registrado", xml_status: "pendente", protocol: "135260000000002" });
      expect(view.effects[1]).toMatchObject({ state: "aplicado", responsible_role: "financeiro", compensation_state: "compensacao_pendente", reason: "title_received" });
      await expect(port.artifact(ids.emission, "cancellation_xml")).rejects.toMatchObject({ status: 202, code: "fiscal_cancellation_xml_pending" });
    } finally { restore(); }
  });

  it("recusa do servidor é apresentada mesmo quando o acesso do navegador está desatualizado", async () => {
    const identity = com1Identity(); identity.actor!.erp_role = "consulta";
    const restore = installCommercialNfeHttp(async () => { throw new Error("Sem papel fiscal não deve alcançar o serviço."); });
    try {
      await expect(linkedPort(com1Actor(), com1RouteDependencies({ identity })).emit(emitInput)).rejects.toMatchObject({ status: 403, code: "fiscal_forbidden", uncertain: false });
    } finally { restore(); }
  });

  it("ações sensíveis exigem confirmação por padrão e aceitam concessão autônoma explícita", async () => {
    const actor = com1Actor({ via: { kind: "bot", bot_id: "bot-fiscal", run_id: "run-teste", masked: true } });
    let calls = 0;
    const restore = installCommercialNfeHttp(async context => { calls++; return successfulResponse(context); });
    try {
      const withoutConfirmation = linkedPort(actor);
      await expect(withoutConfirmation.emit(emitInput)).rejects.toMatchObject({ status: 403, code: "fiscal_confirmation_required" });
      await expect(withoutConfirmation.saveConfig({ ...configInput, environment: "producao", enable_production: true })).rejects.toMatchObject({ status: 403, code: "fiscal_confirmation_required" });
      expect(calls).toBe(0);
      const configured = linkedPort(actor, com1RouteDependencies({ authority: { origin: "application", proposed_by: "bot-fiscal", autonomous: true } }));
      expect((await configured.emit(emitInput)).status).toBe("autorizada");
      expect(calls).toBe(1);
    } finally { restore(); }
  });

  it("efeitos revalidam o papel de cada eixo e não herdam o privilégio fiscal", async () => {
    const restore = installCommercialNfeHttp(async context => successfulResponse(context));
    const input = { emission_id: ids.emission, command_id: ids.command, expected_version: 1, intent: "reconcile" as const };
    try {
      for (const role of ["fiscal", "estoque", "financeiro"] as const) {
        const identity = com1Identity(); identity.actor!.erp_role = role;
        const port = linkedPort(com1Actor(), com1RouteDependencies({ identity }));
        for (const axis of ["stock", "finance"] as const) {
          const attempt = port.effects({ ...input, axis });
          if ((role === "estoque" && axis === "stock") || (role === "financeiro" && axis === "finance"))
            expect((await attempt).axis).toBe(axis);
          else await expect(attempt).rejects.toMatchObject({ status: 403, code: "fiscal_forbidden" });
        }
      }
    } finally { restore(); }
  });

  it("resposta incompleta não recebe etiqueta de autorizada", async () => {
    const restore = installCommercialNfeHttp(async () => Response.json({ ...emission(), protocol: null }));
    try {
      await expect(linkedPort().read(ids.emission)).rejects.toBeInstanceOf(CommercialNfeError);
      await expect(linkedPort().read(ids.emission)).rejects.toMatchObject({ code: "fiscal_invalid_response", uncertain: true });
    } finally { restore(); }
  });
});
