// Fixtures da compra pela nota recebida: um XML de NF-e de fornecedor feito à
// mão (nenhum dado real, nenhuma chamada a cofre ou governo) e o caminho do
// Worker (ler o XML, gravar o índice) reproduzido sem R2: o hash vem dos bytes.
import { createHash, randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { parseInboundXml } from "../../../src/erp/recebidas/xml.ts";

import { SUPPLIER_CNPJ } from "./xml-fixture.mjs";
export { SUPPLIER_CNPJ, COMPANY_CNPJ, accessKey, nfeXml } from "./xml-fixture.mjs";

/** Área de ensaio com fornecedor, dois produtos (um com lote), depósito e categoria de despesa. */
export function inboundFixture(t, options = {}) {
  const f = com1Fixture(t, options);
  const supplier = f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { name: "Fornecedor Sintetico Ltda", person_type: "J", document: SUPPLIER_CNPJ, roles: ["supplier"] } }).record;
  const biscuit = f.catalog("products", { name: "Biscoito de polvilho", unit: "UN", kind: "P", format: "S", price: "15", gtin: "7891234567895" });
  const milk = f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { name: "Leite integral", unit: "UN", kind: "P", format: "S", price: "8", lot_control: true } }).record;
  const warehouse = f.catalog("warehouses", { name: "Depósito da loja" });
  const category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "payable", name: "Compras de mercadoria" } }).record;
  /** Faz o que o Worker faz: lê o XML, calcula o hash e grava o índice (importação à mão). */
  const register = (xml, overrides = {}) => {
    const parsed = parseInboundXml(xml);
    const sha256 = createHash("sha256").update(xml, "utf8").digest("hex");
    const note = f.rpc("erp_inbound_register", { p_input: { note: parsed.summary, xml: { key: `erp/teste/recebidas/xml/${sha256}.xml`, sha256, size: Buffer.byteLength(xml) } } }, overrides);
    return { note, parsed, sha256 };
  };
  const input = (registered, extra = {}) => ({ id: registered.note.id, xml_sha256: registered.sha256, note: registered.parsed.note, ...extra });
  const review = (registered, choices = {}, overrides = {}) => f.rpc("erp_inbound_review", { p_input: input(registered, { choices }) }, overrides);
  const enter = (registered, choices = {}, overrides = {}, command = randomUUID()) =>
    f.rpc("erp_inbound_enter", { p_input: input(registered, { choices, command_id: command }) }, overrides);
  const reverse = (registered, reason = "Nota lançada por engano", overrides = {}, command = randomUUID()) =>
    f.rpc("erp_inbound_reverse", { p_input: { id: registered.note.id, reason, command_id: command } }, overrides);
  const balance = (product) => {
    const row = f.lite.prepare("SELECT CAST(quantity AS TEXT) q FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?").get(product, warehouse.id);
    // Quantidade guardada na escala de 6 casas (inteiro).
    return row ? String(Number(row.q) / 1e6) : null;
  };
  const count = (table, where = "1=1", ...args) => f.lite.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get(...args).n;
  return { ...f, supplier, biscuit, milk, warehouse, category, register, review, enter, reverse, balance, count };
}
