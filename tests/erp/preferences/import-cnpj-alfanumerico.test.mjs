// Importações de planilha com CNPJ alfanumérico (12 [0-9A-Z] + 2 dígitos), o
// mesmo aceito pelo cadastro de contatos (validCnpj): a prévia do navegador e a
// captura do Worker (pacote e cópia do motor) aceitam o documento com máscara e
// minúsculas, normalizado em maiúsculas; dígito verificador errado é recusado; a
// busca do contato no motor normaliza os dois lados (documento salvo e da linha).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import * as panel from "../../../packages/erp-domain/src/spreadsheet-import.mjs";
import * as motor from "../../../src/erp/fagoo/packages/erp-domain/src/spreadsheet-import.mjs";

const CNPJ = "12ABC34501DE35"; // sintético, dígitos verificadores conferidos
const TYPED = "12.abc.345/01de-35";
const WRONG = "12ABC34501DE36";
const DOCUMENT_COLUMNS = [["purchase_orders", "contact_document"], ["sales_orders", "contact_document"], ["nfe", "contact_document"],
  ["receivables", "contact_document"], ["payables", "contact_document"], ["product_suppliers", "supplier_document"]];

for (const [name, lib] of [["pacote do painel", panel], ["cópia do motor", motor]]) {
  test(`${name}: a coluna CPF/CNPJ normaliza e confere o CNPJ alfanumérico`, () => {
    for (const [kind, key] of DOCUMENT_COLUMNS) {
      const column = lib.IMPORT_TEMPLATES[kind].columns.find((c) => c.key === key);
      assert.deepEqual(lib.normalizeCell(column, TYPED), { value: CNPJ }, `${kind}.${key}`);
      assert.deepEqual(lib.normalizeCell(column, ` ${CNPJ} `), { value: CNPJ });
      assert.ok(lib.normalizeCell(column, WRONG).problem, `${kind}: dígito verificador errado`);
      assert.ok(lib.normalizeCell(column, "12ABC34501DE3X").problem);
      assert.ok(lib.normalizeCell(column, "12ABC345").problem);
      // CPF continua só com 11 dígitos; o documento numérico segue como antes.
      assert.ok(lib.normalizeCell(column, "1234567890A").problem);
      assert.deepEqual(lib.normalizeCell(column, "123.456.789-01"), { value: "12345678901" });
      assert.deepEqual(lib.normalizeCell(column, "12.345.678/0001-90"), { value: "12345678000190" });
    }
    // Outras colunas de dígitos não aceitam letras.
    const gtin = lib.IMPORT_TEMPLATES.products.columns.find((c) => c.key === "gtin");
    assert.ok(lib.normalizeCell(gtin, CNPJ).problem);
  });

  test(`${name}: a captura estrita do Worker aceita o CNPJ canônico e recusa o resto`, () => {
    const body = (data) => ({ command_id: randomUUID(), job_id: randomUUID(), file_name: "planilha.csv", total_rows: 1, dry_run: false,
      items: [{ row: 2, lines: [2], data }] });
    const order = (document) => ({ number: "1", date: "2026-10-10", contact_document: document, items: [{ code: "P", quantity: "1" }] });
    const title = (document) => ({ contact_document: document, description: "Título", issued_on: "2026-10-10", due_on: "2026-11-10", amount: "10" });
    const supplier = (document) => ({ code: "P", supplier_document: document });
    for (const [kind, data] of [["sales_orders", order], ["purchase_orders", order], ["receivables", title], ["payables", title], ["product_suppliers", supplier]]) {
      assert.doesNotThrow(() => lib.captureImportBatch(kind, body(data(CNPJ))), kind);
      for (const bad of [WRONG, TYPED, CNPJ.toLowerCase(), "12ABC34501DE3"])
        assert.throws(() => lib.captureImportBatch(kind, body(data(bad))), (e) => e instanceof lib.ImportContractError, `${kind}: ${bad}`);
    }
  });
}

test("motor: venda, conta a receber e fornecedor de produto encontram o contato com CNPJ alfanumérico", { timeout: 120_000 }, () => {
  const lite = freshLite(), driver = nodeDriver(lite), user = randomUUID(), now = "1795089600000000";
  driver.exec("INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,'admin',1,?,?)", user, now, now);
  driver.exec("INSERT INTO erp_access__profile(user_id,name,version,updated_by,updated_at) VALUES(?,'Admin CNPJ',1,?,?)", user, user, now);
  let stamp = BigInt(now);
  const clock = { next: () => ++stamp, get latest() { return stamp; } };
  const rpc = (name, args) => callRpc(driver, name, { p_user_id: user, ...args }, clock, { parts: normalizeErpParts() });
  try {
    // Salvo com máscara, como o formulário permite.
    const contact = rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_data: { name: "Empresa Alfanumérica", person_type: "J", document: "12.ABC.345/01DE-35", roles: ["customer", "supplier"] } }).record;
    rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_data: { code: "ALFA-1", name: "Produto alfa", kind: "P", format: "S", unit: "UN", price: "10" }, p_acknowledged: null });
    const sheet = (kind, data, document = CNPJ) => {
      const column = panel.IMPORT_TEMPLATES[kind].columns.find((c) => c.key === Object.keys(data).find((k) => k.endsWith("_document")));
      const value = panel.normalizeCell(column, TYPED).value;
      assert.equal(value, CNPJ);
      return rpc("erp_preferences_import_batch", { p_command_id: randomUUID(), p_job_id: randomUUID(), p_kind: kind, p_file_name: `${kind}.csv`,
        p_total_rows: 1, p_dry_run: false, p_rows: [{ row: 2, lines: [2], data: { ...data, [column.key]: document } }] });
    };
    const order = sheet("sales_orders", { number: "V-1", date: "2026-10-10", contact_document: null, items: [{ code: "ALFA-1", quantity: "2" }] });
    assert.deepEqual(order.items.map((i) => [i.status, i.reason]), [["created", null]], JSON.stringify(order.items));
    const doc = lite.prepare("SELECT contact_id FROM erp_documents__document WHERE id=?").get(order.items[0].record_id);
    assert.equal(doc.contact_id, contact.id);
    const title = sheet("receivables", { contact_document: null, description: "Receber alfa", issued_on: "2026-10-10", due_on: "2026-11-10", amount: "25.50" });
    assert.deepEqual(title.items.map((i) => [i.status, i.reason]), [["created", null]], JSON.stringify(title.items));
    const supplier = sheet("product_suppliers", { code: "ALFA-1", supplier_document: null, purchase_price: "3.5" });
    assert.deepEqual(supplier.items.map((i) => [i.status, i.reason]), [["created", null]], JSON.stringify(supplier.items));
    const missing = sheet("payables", { contact_document: null, description: "Pagar", issued_on: "2026-10-10", due_on: "2026-11-10", amount: "1" }, "11ABC34501DE35");
    assert.deepEqual(missing.items.map((i) => [i.status, i.reason]), [["invalid", "erp_preferences_import_not_found:contact_document"]]);
  } finally { lite.close(); }
});
