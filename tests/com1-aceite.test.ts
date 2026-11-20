import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/types";
declare global { namespace Cloudflare { interface Env extends WorkerEnv {} } }
import { describe, expect, it } from "vitest";
import "../src/erp/domains/index.ts";
import { storageDriver } from "../src/erp/engine/driver.ts";
import { callRpc, type RpcArgs } from "../src/erp/engine/registry.ts";
import { Clock } from "../src/erp/engine/time.ts";
import { migrate } from "../src/erp/schema/migrate.ts";
import { normalizeErpParts, type ErpParts } from "../src/erp/parts.ts";
import { createCommercialNfeService, freezeCommercialVaultSession } from "../src/erp/commercial-nfe/service.ts";
import { installCommercialNfeSlots } from "../src/erp/commercial-nfe/slots.ts";
import type { CommercialNfeBridge } from "../src/erp/commercial-nfe/bridge.ts";
import type { CommercialNfeHttpContext } from "../src/erp/commercial-nfe/routes.ts";
import { commercialNfePreparationSlots } from "../src/erp/domains/fiscal/comnfe/prepare.ts";
import { recapturePreparationFingerprint } from "../src/erp/domains/fiscal/comnfe/source.ts";
import { createCommercialNfeLifecycle } from "../src/erp/domains/fiscal/comnfe/lifecycle.ts";
import { commercialNfeReadSlots } from "../src/erp/domains/fiscal/comnfe/reads.ts";
import { applyEffects, reverseEffects } from "../src/erp/domains/fiscal/comnfe/effects.ts";
import { installCommercialConnectionResolver } from "../src/erp/domains/fiscal/comnfe/settings.ts";
import { com1Sha256 } from "../src/erp/domains/fiscal/comnfe/store.ts";
import { fiscalConnectionFingerprint, saveEmissor, testEmissor } from "../src/erp/emissor/config.ts";
import { createNfapiProvider } from "../src/erp/emissor/nfapi-provider.ts";
import type { PedidoNfe } from "../src/erp/emissor/contract/types.generated.ts";
import contract from "../src/erp/emissor/contract/openapi.json";
import { FAKE_PDF, createFakeVault } from "./erp/emissor/fake-vault";
import { vaultArea, VAULT_URL } from "./erp/emissor/helpers";
import { com1Actor, com1Identity } from "./com1-support";
import { fixture, bearer } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const day = "2026-11-19";
const issuerCnpj = "11222333000181";
const alphaCnpj = "12ABC34501DE35";
class AcceptanceClock extends Clock {
  private micros = 1795089600000000n;
  override next() { return ++this.micros; }
  override get latest() { return this.micros; }
  advance(ms: number) { this.micros += BigInt(ms) * 1000n; }
}

/** Motor SQLite do Coordinator, mapper, provedor NFapi e fake oficial juntos.
 * Só o transporte interno de RPC é adaptado para o armazenamento do teste. */
async function integrated(options: { missingNcm?: boolean; parts?: Partial<ErpParts> } = {}) {
  const clock = new AcceptanceClock();
  const area = await vaultArea({ issuerCnpj, now: () => Number(clock.latest / 1000n) });
  const fingerprint = await fiscalConnectionFingerprint({ provider: "nfapi", url: VAULT_URL, issuer_document: issuerCnpj });
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(`erp:aceite-${area.profile}`));
  const identity = com1Identity(com1Actor());
  const state = { parts: normalizeErpParts(), failRecord: false, failFinance: false };
  const slots = { ...commercialNfePreparationSlots, ...commercialNfeReadSlots,
    ...createCommercialNfeLifecycle({ sourceFingerprint: recapturePreparationFingerprint }), applyEffects, reverseEffects };
  const rpc = async (name: string, args: RpcArgs = {}): Promise<any> => runInDurableObject(stub, (_instance: unknown, durableState: DurableObjectState) => {
    migrate(durableState.storage);
    const restoreSlots = installCommercialNfeSlots(slots);
    const restoreConnection = installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://nfapi-cofre.fake-vault.test",
      issuer_cnpj: issuerCnpj, version: "0.12.0", checked_at: String(clock.latest), compatible: true,
      company_matches: true, company_complete: true, environments: ["homologacao"], series: [{ environment: "homologacao", series: 1 }] }));
    try { return callRpc(storageDriver(durableState.storage), name, args, clock, { identity, parts: state.parts }); }
    finally { restoreConnection(); restoreSlots(); }
  });
  const publicRpc = (name: string, args: RpcArgs = {}) => rpc(name, { p_user_id: identity.actor!.user_id, ...args });
  await publicRpc("erp_company_save_identity", { p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: {
    legal_name: "Empresa de Ensaio Comercial Ltda.", trade_name: "Ensaio Comercial", cnpj: issuerCnpj, ie: "110042490114",
    postal_code: "01001000", street: "Praça da Sé", number: "100", complement: null, district: "Sé", city: "São Paulo", municipality_code: "3550308", state: "SP", phone: "1130000000", email: "fiscal@aceite.invalid",
  } });
  await publicRpc("erp_company_confirm_fiscal", { p_expected_version: 1, p_expected_identity_version: 1, p_command_id: crypto.randomUUID(), p_crt: "1", p_confirmed: true, p_reason: "Conferência simulada" });
  const customer = (await publicRpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_acknowledged: null, p_data: {
    name: "Cliente e transportadora alfanuméricos", person_type: "J", document: alphaCnpj, roles: ["customer", "carrier"], taxpayer: "9",
    postal_code: "01001000", street: "Praça da Sé", number: "200", district: "Sé", city: "São Paulo", state: "SP", email: "cliente@aceite.invalid",
  } })).record;
  const catalog = async (entity: string, data: object) => (await publicRpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: data })).record;
  const product = await catalog("products", { name: "Mercadoria de ensaio", unit: "UN", kind: "P", format: "S", price: "25.50", ncm: options.missingNcm ? null : "84713012", origin: "0" });
  const warehouse = await catalog("warehouses", { name: "Depósito do ensaio" });
  const category = (await publicRpc("erp_finance_category_execute", { p_command_id: crypto.randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas do ensaio" } })).record;
  const account = (await publicRpc("erp_finance_account_execute", { p_command_id: crypto.randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa do ensaio", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const nature = (await publicRpc("erp_fiscal_nature_execute", { p_command_id: crypto.randomUUID(), p_action: "create", p_data: { nature: {
    description: "Venda nacional de mercadorias", direction: "1", crt: "1", presence: "1", final_consumer: true,
    rules: [{ tax: "icms", data: { situation: "102", cfop: "5102" } }, { tax: "pis", data: { situation: "07" } }, { tax: "cofins", data: { situation: "07" } }],
  } } })).nature;
  const body = { date: day, contact_id: customer.id, carrier_id: customer.id, warehouse_id: warehouse.id, category_id: category.id,
    payment_means: "15", payment_indicator: "1",
    commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
      transport: { freight_mode: "0", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } },
    items: [{ product_id: product.id, code: "P1", description: "Mercadoria de ensaio", unit: "UN", quantity: "2", unit_price: "25.50", discount_percent: "0" }],
    installments: [{ due_date: "2026-12-19", amount: "51.00" }],
  };
  let order = (await publicRpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_body: body })).document;
  await publicRpc("erp_stock_post", { p_command_id: crypto.randomUUID(), p_kind: "receipt", p_occurred_on: day, p_reason: "Saldo inicial do ensaio", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "100", expected_version: 0 }] });
  order = (await publicRpc("erp_document_transition", { p_kind: "sales_orders", p_id: order.id, p_expected_version: order.version, p_command_id: crypto.randomUUID(), p_status: "verified", p_reason: "Pedido conferido" })).document;
  await publicRpc("erp_com1_config_save", { p_input: { command_id: crypto.randomUUID(), expected_version: 1, environment: "homologacao", stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  state.parts = normalizeErpParts(options.parts);
  const bridge = { async call(name: string, input: any) {
    if (state.failRecord && name === "erp_com1_record") { state.failRecord = false; throw new Error("Queda antes do commit fiscal"); }
    if (state.failFinance && name === "erp_com1_effect_apply" && input.axis === "finance") throw new Error("Queda entre estoque e financeiro");
    const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name);
    return (evidence ? rpc : publicRpc)(name, name === "erp_com1_config_get" ? {} : { p_input: input });
  } } as CommercialNfeBridge;
  const provider = createNfapiProvider({ delays: [0, 0], sleep: async () => {} });
  const service = createCommercialNfeService({} as CommercialNfeHttpContext, { bridge,
    vault: async emission => freezeCommercialVaultSession({ ...area.ctx } as CommercialNfeHttpContext, emission, {
      provider, fingerprint, connection: { url: VAULT_URL, api_key: area.vault.apiKey }, fetch: area.vault.fetch,
    }) });
  const prepareInput = { document_id: order.id, expected_document_version: order.version, command_id: crypto.randomUUID(), choices: { nature_id: nature.id, presence: "presencial" as const, final_consumer: true } };
  const preparation = await service.prepare(prepareInput);
  const read = () => service.read({ emission_id: preparation.emission.id });
  const emitInput = async () => { const view = await read(); return { emission_id: view.id, command_id: crypto.randomUUID(), expected_version: view.version, body_revision: view.current_body_revision, body_hash: view.revision.body_hash! }; };
  const cancelInput = async () => { const view = await read(); return { emission_id: view.id, command_id: crypto.randomUUID(), expected_version: view.version, justification: "Cancelamento da venda de ensaio antes da entrega." }; };
  const inspect = () => runInDurableObject(stub, (_instance: unknown, durableState: DurableObjectState) => {
    const db = storageDriver(durableState.storage), count = (table: string) => Number(db.exec(`SELECT count(*) n FROM ${table}`).rows[0].n);
    return { emissions: count("erp_fiscal_vault__order_emission"), stock: count("erp_stock__document_posting"), finance: count("erp_finance__document_posting"), titles: count("erp_finance__title"),
      settlements: count("erp_finance__settlement"), title: db.exec("SELECT id, version, settled_cents, cancelled FROM erp_finance__title").rows[0] };
  });
  return { ...area, clock, state, service, provider, preparation, prepareInput, publicRpc, read, emitInput, cancelInput, inspect, account };
}

describe("aceite integrado com SQLite do Coordinator e cofre oficial simulado", () => {
  it("montagem pública real atravessa identidade, ponte e motor sem com1_not_ready", async () => {
    const f = await fixture(), token = await bearer(f.admin);
    await setModule(f.profile, "erp", true, f.admin.id);
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    const url = `https://test/api/v1/profiles/${f.profile}/erp-comercial-nfe`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await SELF.fetch(`${url}/config`, { headers });
    const config = await response.json<any>();
    expect(response.status, JSON.stringify(config)).toBe(200);
    expect(config).toMatchObject({ environment: "homologacao", stock_timing: "existing", finance_timing: "existing" });
    const vault = createFakeVault({ issuerCnpj, openapi: contract });
    await saveEmissor(env, f.admin, f.profile, { provider: "nfapi", url: VAULT_URL, api_key: vault.apiKey });
    const connection = await testEmissor(env, f.admin, f.profile, { fetch: vault.fetch });
    expect(connection.checked?.ok).toBe(true);
    expect(connection.checked?.contract).toMatchObject({ vault: "0.12.0", compatible: true, differences: [] });
    expect(connection.checked?.state?.certificate?.document).toEqual({ kind: "cnpj", id: issuerCnpj });
    const changed = await SELF.fetch(`${url}/config`, { method: "PUT", headers, body: JSON.stringify({
      command_id: crypto.randomUUID(), expected_version: config.version, environment: "homologacao", stock_timing: "on_authorization", finance_timing: "on_authorization",
    }) });
    const changedBody = await changed.json<any>();
    expect(changed.status, JSON.stringify(changedBody)).toBe(200);
    expect(changedBody.version).toBe(config.version + 1);
    expect(changedBody.connection_fingerprint).toBe(await fiscalConnectionFingerprint({ provider: "nfapi", url: VAULT_URL, issuer_document: issuerCnpj }));
    expect(changedBody.connection_public).toMatchObject({ issuer_cnpj: issuerCnpj, compatible: true, version: "0.12.0" });
    const history = await SELF.fetch(`${url}/emissoes?environment=homologacao`, { headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ items: [], total: 0 });
  });
  it("ciclo completo, CNPJ alfanumérico, recibos e recebimento preservado após cancelamento", async ({ task }) => {
    const f = await integrated();
    expect(f.preparation.blockers).toEqual([]);
    expect((await f.service.prepare(f.prepareInput)).replayed).toBe(true);
    const input = await f.emitInput(), view = await f.service.emit(input);
    (task.meta as Record<string, unknown>).commercialNfeEffects = view.effects;
    expect(view.status).toBe("autorizada");
    expect(view.total).toBe("5100");
    expect(f.vault.emissions.get(view.provider_id!)?.valor).toBe(51);
    expect(view.effects.map(effect => effect.state), JSON.stringify(view.effects)).toEqual(["aplicado", "aplicado"]);
    expect((await f.service.emit(input)).status).toBe("autorizada");
    const calls = f.vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.destinatario.cnpj).toBe(alphaCnpj);
    expect(calls[0].body.transporte.transportadora.cnpj).toBe(alphaCnpj);
    expect(calls[0].body.referencia).toBe(view.reference);
    const danfe = await f.service.danfe({ emission_id: view.id });
    expect(new Uint8Array(await danfe.arrayBuffer())).toEqual(FAKE_PDF);
    expect(f.vault.calls.some(call => call.path === `/v1/nfe/${view.provider_id}/danfe`)).toBe(true);
    const authorizedXml = await (await f.service.xml({ emission_id: view.id })).text();
    expect(authorizedXml).toContain(`Id="NFe${view.access_key}"`);
    expect(authorizedXml).toContain("<tpAmb>2</tpAmb>");
    const before = await f.inspect();
    expect(before).toMatchObject({ emissions: 1, stock: 1, finance: 1, titles: 1, settlements: 0 });
    const settlement = { p_command_id: crypto.randomUUID(), p_action: "settle", p_data: { id: before.title.id, expected_version: before.title.version, account_id: f.account.id, posted_on: day, principal_cents: "5100" } };
    await f.publicRpc("erp_finance_execute", settlement); await f.publicRpc("erp_finance_execute", settlement);
    const cancel = await f.cancelInput(), cancelled = await f.service.cancel(cancel);
    expect(cancelled.status).toBe("cancelada");
    expect(cancelled.cancellation).toMatchObject({ state: "registrado", xml_status: "disponivel" });
    const xml = await (await f.service.cancellationXml({ emission_id: view.id })).text();
    expect(com1Sha256(xml)).toBe(cancelled.cancellation!.xml_hash);
    expect(xml).toContain(view.access_key);
    expect(cancelled.effects.find(effect => effect.axis === "finance")?.compensation_state).toBe("compensacao_pendente");
    await f.service.cancel(cancel);
    const after = await f.inspect();
    expect(after).toMatchObject({ emissions: 1, stock: 1, finance: 1, titles: 1, settlements: 1, title: { settled_cents: 5100, cancelled: 0 } });
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
    (task.meta as Record<string, unknown>).commercial_nfe_acceptance = { simulated: true, environment: view.environment, counts: after, cancellation_xml_hash: cancelled.cancellation!.xml_hash };
  });

  it("cofre simulado atualiza o total ao corrigir rejeição na mesma referência", async () => {
    const f = await integrated();
    const body = structuredClone(f.preparation.emission.revision.body) as unknown as PedidoNfe;
    const key = { document_id: f.preparation.emission.document_id, version: 1 };
    f.vault.plan.push("reject");
    const rejected = await f.provider.emit(f.ctx, "nfe", body, key);
    expect(rejected).toMatchObject({ status: "rejected", total: 51 });
    body.itens[0].quantidade = 3;
    body.itens[0].valorTotal = 76.5;
    if (body.itens[0].tributavel) body.itens[0].tributavel.quantidade = 3;
    body.pagamentos[0].valor = 76.5;
    delete body.cobranca;
    const corrected = await f.provider.emit(f.ctx, "nfe", body, key);
    expect(corrected).toMatchObject({ status: "authorized", total: 76.5, reference: rejected.reference, provider_ref: rejected.provider_ref });
    expect(await f.provider.emit(f.ctx, "nfe", body, key)).toMatchObject({ total: 76.5, replayed: true, provider_ref: rejected.provider_ref });
    expect(f.vault.emissions.size).toBe(1);
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
  });

  it("dado fiscal ausente bloqueia antes da primeira chamada ao fake", async () => {
    const f = await integrated({ missingNcm: true });
    expect(f.preparation.blockers.some(blocker => blocker.code === "fiscal_product_incomplete")).toBe(true);
    await expect(f.service.emit(await f.emitInput())).rejects.toMatchObject({ status: 422 });
    expect(f.vault.calls).toHaveLength(0);
  });

  it("aceite externo antes do commit, duas abas e queda entre os efeitos preservam unicidades", async () => {
    const f = await integrated();
    const pause = f.vault.pauseNext({ method: "POST", path: "/v1/nfe", phase: "after" });
    f.state.failRecord = true;
    const pending = f.service.emit(await f.emitInput());
    await pause.reached;
    expect((await f.service.emit(await f.emitInput())).status).toBe("enviando");
    pause.release();
    await expect(pending).rejects.toThrow("Queda antes do commit fiscal");
    f.clock.advance(61_000); f.state.failFinance = true;
    let current = await f.read();
    expect((await f.service.resume({ emission_id: current.id, command_id: crypto.randomUUID(), expected_version: current.version, body_revision: current.current_body_revision })).status).toBe("autorizada");
    expect(await f.inspect()).toMatchObject({ stock: 1, finance: 0, titles: 0 });
    f.state.failFinance = false; current = await f.read();
    await f.service.effects({ emission_id: current.id, command_id: crypto.randomUUID(), expected_version: current.version, axis: "finance", intent: "apply" });
    expect(await f.inspect()).toMatchObject({ emissions: 1, stock: 1, finance: 1, titles: 1 });
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
    expect(f.vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe")).toHaveLength(1);
  });

  it("resposta perdida no fake é recuperada pela mesma referência", async () => {
    const f = await integrated(); f.vault.plan.push("lose");
    const result = await f.service.emit(await f.emitInput());
    expect(result.status).toBe("autorizada");
    expect(result.reference).toBe(f.preparation.emission.reference);
    expect(f.vault.authorizedAtSefaz).toHaveLength(1);
    expect(await f.inspect()).toMatchObject({ emissions: 1, stock: 1, finance: 1, titles: 1 });
  });

  it("título não recebido permite compensação financeira, sem presumir retorno físico", async () => {
    const f = await integrated(); await f.service.emit(await f.emitInput());
    const result = await f.service.cancel(await f.cancelInput());
    expect(result.status).toBe("cancelada");
    expect(result.effects.find(effect => effect.axis === "finance")?.compensation_state).toBe("revertido");
    expect(result.effects.find(effect => effect.axis === "stock")?.compensation_state).toBe("compensacao_pendente");
    expect(await f.inspect()).toMatchObject({ titles: 1, settlements: 0, title: { cancelled: 1 } });
  });

  it("estoque e financeiro desligados não bloqueiam nota e religar preserva o skip", async () => {
    const f = await integrated({ parts: { stock: false, finance: false, billing: false, pos: false } });
    let result = await f.service.emit(await f.emitInput());
    expect(result.status).toBe("autorizada");
    expect(result.effects.map(effect => ({ state: effect.state, reason: effect.reason }))).toEqual([{ state: "pulado", reason: "part_disabled" }, { state: "pulado", reason: "part_disabled" }]);
    f.state.parts = normalizeErpParts();
    result = await f.service.resume({ emission_id: result.id, command_id: crypto.randomUUID(), expected_version: result.version, body_revision: result.current_body_revision });
    expect(result.effects.every(effect => effect.state === "pulado")).toBe(true);
    expect(await f.inspect()).toMatchObject({ emissions: 1, stock: 0, finance: 0, titles: 0 });
  });
});
