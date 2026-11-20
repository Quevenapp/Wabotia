// Fixtures locais da fatia comercial. Não importam Vitest, não usam rede e
// instalam dados pelos RPCs existentes; os cenários podem sobrescrever fontes.
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

export const COM1_DATE = "2026-11-19";
export const COM1_NOW = Date.parse("2026-11-19T12:00:00.000Z");
export const COM1_PARTS = normalizeErpParts();
export const COM1_PEOPLE = Object.freeze(Object.fromEntries(
  ["admin", "fiscal", "estoque", "financeiro", "vendas", "consulta"].map((role, index) => [role, Object.freeze({
    user_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Pessoa ${role}`, email: `${role}@com1.invalid`, erp_role: role,
    verified_factor: true, session_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    aal: "aal2", is_agent: false,
  })]),
));

/** Um relógio para motor (microssegundos) e serviço (milissegundos); nenhuma espera real. */
export class Com1Clock extends Clock {
  constructor(now = COM1_NOW) { super(); this.micros = BigInt(now) * 1000n; }
  next() { this.micros += 1n; return this.micros; }
  get latest() { return this.micros; }
  now() { return Number(this.micros / 1000n); }
  advance(milliseconds) { this.micros += BigInt(milliseconds) * 1000n; }
  async sleep(milliseconds) { this.advance(milliseconds); }
}

export const com1Identity = (role = "admin", overrides = {}) => ({
  actor: { ...COM1_PEOPLE[role], ...overrides }, people: Object.values(COM1_PEOPLE),
});
export const com1Company = (overrides = {}) => ({
  legal_name: "Empresa de Ensaio Comercial Ltda.", trade_name: "Ensaio Comercial", cnpj: "11222333000181",
  ie: "110042490114", postal_code: "01001000", street: "Praça da Sé", number: "100", complement: null,
  district: "Sé", city: "São Paulo", municipality_code: "3550308", state: "SP", phone: "1130000000",
  email: "fiscal@com1.invalid", ...overrides,
});
export const com1Customer = (overrides = {}) => ({
  name: "Cliente do Ensaio", person_type: "J", document: "19131243000197", roles: ["customer"],
  taxpayer: "9", postal_code: "01001000", street: "Praça da Sé", number: "200", district: "Sé",
  city: "São Paulo", state: "SP", email: "cliente@com1.invalid", ...overrides,
});
export const com1Product = (overrides = {}) => ({
  name: "Mercadoria do Ensaio", unit: "UN", kind: "P", format: "S", price: "25.50", ncm: "84713012", origin: "0", ...overrides,
});
export const com1Nature = (overrides = {}) => ({
  description: "Venda nacional de mercadorias", direction: "1", crt: "1", presence: "1", final_consumer: true,
  rules: [
    { tax: "icms", data: { situation: "102", cfop: "5102" } },
    { tax: "pis", data: { situation: "07" } },
    { tax: "cofins", data: { situation: "07" } },
  ], ...overrides,
});
export const com1Order = (contactId, productId, overrides = {}) => ({
  date: COM1_DATE, contact_id: contactId,
  items: [{ product_id: productId, description: "Mercadoria do Ensaio", unit: "UN", quantity: "2", unit_price: "25.50", discount_percent: "0" }],
  installments: [{ due_date: "2026-12-19", amount: "51.00" }], ...overrides,
});

/**
 * com1Fixture(t?, options?) -> { lite, db, clock, rpc, transaction, identity,
 * parts, people, company, customer/contact, product, nature, order, close }.
 * rpc(name,args,{role,actor,parts}) executa a mesma transação usada pelo motor.
 * O serviço/cofre é instalado separadamente pelos slots, sempre simulado.
 */
export function com1Fixture(t, options = {}) {
  const lite = freshLite(), db = nodeDriver(lite), clock = new Com1Clock(options.now);
  let closed = false;
  const close = () => { if (!closed) { closed = true; lite.close(); } };
  t?.after(close);
  const parts = normalizeErpParts(options.parts);
  const env = (overrides = {}) => ({
    identity: com1Identity(overrides.role ?? "admin", overrides.actor),
    parts: normalizeErpParts({ ...parts, ...overrides.parts }),
  });
  const rpc = (name, args = {}, overrides = {}) => {
    const environment = env(overrides);
    return callRpc(db, name, { p_user_id: environment.identity.actor.user_id, ...args }, clock, environment);
  };
  const transaction = (run, overrides) => inTransaction(db, run, clock, env(overrides));
  const catalog = (entity, data) => rpc("erp_catalog_save", {
    p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data,
  }).record;
  // A semeadura é feita com as partes ligadas. O teste pode desligá-las para
  // executar a operação posterior sem perder o histórico já existente.
  const seed = (name, args) => rpc(name, args, { parts: COM1_PARTS });
  const company = com1Company(options.company);
  seed("erp_company_save_identity", { p_expected_version: 0, p_command_id: randomUUID(), p_data: company });
  seed("erp_company_confirm_fiscal", { p_expected_version: 1, p_expected_identity_version: 1,
    p_command_id: randomUUID(), p_crt: "1", p_confirmed: true, p_reason: "Conferência fictícia do ensaio" });
  const seedCatalog = (entity, data) => seed("erp_catalog_save", {
    p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data,
  }).record;
  const customer = seed("erp_catalog_contact_save", { p_id: null, p_expected_version: 0,
    p_command_id: randomUUID(), p_data: com1Customer(options.customer), p_acknowledged: null }).record;
  const product = seedCatalog("products", com1Product(options.product));
  const nature = seed("erp_fiscal_nature_execute", { p_command_id: randomUUID(), p_action: "create", p_data: { nature: com1Nature(options.nature) } }).nature;
  const orderBody = com1Order(customer.id, product.id, options.order);
  const order = seed("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0,
    p_command_id: randomUUID(), p_body: orderBody }).document;
  return { lite, db, clock, rpc, transaction, env, identity: env().identity, parts, people: COM1_PEOPLE,
    company, customer, contact: customer, product, nature, order, orderBody, catalog, close };
}
