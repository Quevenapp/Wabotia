// Importação por planilha da versão 28: dados fiscais dos produtos, naturezas
// de operação com as regras fiscais e saldos iniciais das contas financeiras.
// Contrato (prévia do navegador e captura estrita do Worker, pacote e cópia do
// motor) e o motor no SQLite: prévia sem gravar, gravação pelas RPCs dos
// domínios, idempotência do lote, tipo real do lote, natureza padrão só com
// confirmação, combinações recusadas e as partes desligadas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import * as panel from "../../../packages/erp-domain/src/spreadsheet-import.mjs";
import * as motor from "../../../src/erp/fagoo/packages/erp-domain/src/spreadsheet-import.mjs";

const sheet = (lib, kind, rows) => lib.templateRows(kind, [lib.IMPORT_TEMPLATES[kind].columns.map((c) => c.label), ...rows.map((r) => lib.IMPORT_TEMPLATES[kind].columns.map((c) => r[c.label] ?? ""))]);

for (const [name, lib] of [["pacote do painel", panel], ["cópia do motor", motor]]) {
  test(`${name}: planilha fiscal normaliza NCM, CEST e códigos e confere as combinações`, () => {
    const out = sheet(lib, "product_taxes", [
      { "Código": "P1", NCM: "6109.10.00", CEST: "28.063.00", "Natureza de operação": "Venda", "ICMS: CST/CSOSN": "102", "Alíquota ICMS (%)": "18,5", "Benefício fiscal (cBenef)": "sp070001", "GTIN/EAN tributável": "sem gtin" },
      { "Código": "P2", NCM: "6109100" },
      { "Código": "P3", "Alíquota PIS (%)": "1,65" },
      { "Código": "P4", "Natureza de operação": "Venda" },
      { NCM: "61091000" },
      { "Código": "P6", "IPI: CST": "60" },
    ]);
    assert.deepEqual(out.items[0].data, { code: "P1", ncm: "61091000", cest: "2806300", gtin_tax: "SEM GTIN", nature: "Venda", icms_situation: "102", icms_rate: "18.5", benefit_code: "SP070001" });
    assert.deepEqual(out.items[0].problems, []);
    assert.deepEqual(out.items[1].problems, ["NCM: 8 dígitos"]);
    assert.deepEqual(out.items[2].problems, ["Alíquota PIS (%): informe também PIS: CST"]);
    assert.deepEqual(out.items[3].problems, ["Natureza de operação: informe o CST de ao menos um imposto"]);
    assert.deepEqual(out.items[4].problems, ["Código: informe o Código ou o GTIN/EAN do produto"]);
    assert.match(out.items[5].problems[0], /^IPI: CST: /);
  });

  test(`${name}: naturezas agrupam as regras pelo nome e conferem Padrão para e as regras`, () => {
    const out = sheet(lib, "natures", [
      { "Natureza de operação": "Venda", Tipo: "Saída", "Regime tributário": "Simples Nacional", "Padrão para": "S, VJ", Imposto: "ICMS", "CST/CSOSN": "102", CFOP: "5102", "Destinos (UF)": "sp; RJ", NCMs: "61.09" },
      { "Natureza de operação": "Venda", Imposto: "PIS", "CST/CSOSN": "49" },
      { "Natureza de operação": "Compra", Tipo: "Entrada", "Padrão para": "VF", Imposto: "IPI", "CST/CSOSN": "T", CFOP: "1102" },
    ]);
    assert.deepEqual(out.items[0].lines, [2, 3]);
    assert.deepEqual(out.items[0].data, { description: "Venda", direction: "1", crt: "1", default_for: ["S", "VJ"],
      items: [{ tax: "icms", situation: "102", cfop: "5102", destinations: ["SP", "RJ"], ncms: ["6109"] }, { tax: "pis", situation: "49" }] });
    assert.deepEqual(out.items[0].problems, []);
    assert.deepEqual(out.items[1].problems, ["Padrão para: Padrão venda física não vale para uma natureza de entrada", "Linha 4: CFOP só no ICMS", "Linha 4: CST/CSOSN de 2 dígitos no IPI"]);
  });

  test(`${name}: saldos iniciais aceitam saldo negativo e a captura do Worker é estrita`, () => {
    const out = sheet(lib, "opening_balances", [{ "Conta financeira": "Caixa", Data: "31/12/2025", Saldo: "-1.500,25" }]);
    assert.deepEqual(out.items[0].data, { account: "Caixa", date: "2025-12-31", balance: "-1500.25" });
    const body = (kind, data, lines = [2]) => ({ command_id: null, job_id: null, file_name: "a.csv", total_rows: 1, dry_run: true, items: [{ row: 2, lines, data }] });
    assert.doesNotThrow(() => lib.captureImportBatch("opening_balances", body("opening_balances", out.items[0].data)));
    assert.doesNotThrow(() => lib.captureImportBatch("product_taxes", body("product_taxes", { gtin: "7891234567895", ncm: "61091000" })));
    assert.doesNotThrow(() => lib.captureImportBatch("natures", body("natures", { description: "V", direction: "1", confirm_default: true, items: [{}] })));
    for (const [kind, data, lines] of [
      ["opening_balances", { account: "Caixa", date: "31/12/2025", balance: "1" }],
      ["product_taxes", { code: "P1", icms_rate: "18" }],
      ["product_taxes", { code: "P1", ncm: "6109.10.00" }],
      ["product_taxes", { code: "P1", icms_situation: "1020" }],
      ["natures", { description: "V", direction: "1", default_for: ["E"], items: [{}] }],
      ["natures", { description: "V", direction: "1", items: [{ tax: "icms" }] }],
      ["natures", { description: "V", direction: "1", items: [{}, {}] }],
      ["natures", { description: "V", direction: "1", default_for: [], items: [{}] }],
    ]) assert.throws(() => lib.captureImportBatch(kind, body(kind, data, lines)), (e) => e instanceof lib.ImportContractError, `${kind} ${JSON.stringify(data)}`);
  });

  test(`${name}: modelos com instruções em português na primeira aba`, () => {
    for (const kind of ["product_taxes", "natures", "opening_balances"]) {
      const rows = lib.templateInstructions(kind);
      assert.equal(rows[0][0], lib.IMPORT_TEMPLATES[kind].title);
      assert.deepEqual(rows[4], ["Coluna", "Obrigatória", "Tipo", "Como preencher", "Exemplo"]);
      assert.equal(rows.length, 5 + lib.IMPORT_TEMPLATES[kind].columns.length);
      assert.ok(lib.IMPORT_PREVIEW_KINDS.includes(kind));
    }
  });
}

test("pacote do painel e cópia do motor são o mesmo arquivo", async () => {
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(new URL("../../../packages/erp-domain/src/spreadsheet-import.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../../src/erp/fagoo/packages/erp-domain/src/spreadsheet-import.mjs", import.meta.url), "utf8"));
});

function fixture(parts) {
  const lite = freshLite(), driver = nodeDriver(lite), admin = randomUUID(), clerk = randomUUID(), now = "1795089600000000";
  for (const [user, role, name] of [[admin, "admin", "Admin fiscal"], [clerk, "fiscal", "Fiscal"]]) {
    driver.exec("INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,?,1,?,?)", user, role, now, now);
    driver.exec("INSERT INTO erp_access__profile(user_id,name,version,updated_by,updated_at) VALUES(?,?,1,?,?)", user, name, user, now);
  }
  let stamp = BigInt(now);
  const clock = { next: () => ++stamp, get latest() { return stamp; } };
  const rpc = (name, args, user = admin, on = parts) => callRpc(driver, name, { p_user_id: user, ...args }, clock, { parts: normalizeErpParts(on) });
  const batch = (kind, rows, { dry = false, job = randomUUID(), command = randomUUID(), file = `${kind}.csv`, user = admin, on } = {}) =>
    rpc("erp_preferences_import_batch", { p_command_id: dry ? null : command, p_job_id: dry ? null : job, p_kind: kind, p_file_name: file, p_total_rows: rows.length,
      p_dry_run: dry, p_rows: rows.map((data, i) => ({ row: i + 2, lines: data.items ? data.items.map((_, j) => i + 2 + j) : [i + 2], data })) }, user, on);
  return { lite, driver, admin, clerk, rpc, batch };
}

test("motor: dados fiscais do produto com prévia, regra só do produto na natureza e lote idempotente", { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const product = f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_data: { code: "FIS-1", name: "Camiseta", kind: "P", format: "S", unit: "UN", price: "10", gtin: "7891234567895" }, p_acknowledged: null }).record;
    f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { code: "FIS-2", name: "Bermuda", kind: "P", format: "S", unit: "UN", price: "10" }, p_acknowledged: null });
    const nature = f.rpc("erp_fiscal_nature_execute", { p_command_id: randomUUID(), p_action: "create", p_data: { nature: { description: "Venda de mercadoria", direction: "1", crt: "1",
      rules: [{ tax: "icms", data: { situation: "102", cfop: "5102" } }] } } }).nature;
    f.rpc("erp_fiscal_nature_execute", { p_command_id: randomUUID(), p_action: "set_default", p_data: { id: nature.id, expected_version: nature.version, code: "S" } });
    const rows = [
      { code: "FIS-1", ncm: "61091000", cest: "2806300", origin: "2", gtin_tax: "SEM GTIN", icms_situation: "500", icms_cfop: "5405", icms_rate: "18", benefit_code: "SP070001", pis_situation: "49" },
      { gtin: "7891234567895", tax_unit: "un" },
      { code: "FIS-2", cest: "2806300" },
      { code: "FIS-2", ncm: "61091000", nature: "Venda de mercadoria", icms_situation: "00" },
      { code: "FIS-2", ipi_situation: "00" },
      { code: "FIS-2", tax_unit: "KG" },
      { code: "NAO-EXISTE", ncm: "61091000" },
      { code: "FIS-2", nature: "Outra", pis_situation: "49" },
    ];
    const preview = f.batch("product_taxes", rows, { dry: true });
    assert.deepEqual(preview.items.map((i) => [i.status, i.reason]), [["valid", null], ["valid", null], ["invalid", "erp_preferences_import_cest_without_ncm:cest"],
      ["invalid", "erp_preferences_import_icms_regime:icms_situation"], ["invalid", "erp_preferences_import_ipi_direction:ipi_situation"],
      ["invalid", "erp_preferences_import_tax_unit:tax_unit"], ["invalid", "erp_preferences_import_not_found:code"], ["invalid", "erp_preferences_import_not_found:nature"]]);
    assert.equal(preview.items[0].reference, "FIS-1: NCM 61091000 · CEST 2806300 · Origem 0→2 · GTIN tributável SEM GTIN · ICMS, PIS em Venda de mercadoria");
    assert.equal(preview.items[1].reference, "FIS-1: sem alteração");
    // A prévia não grava nada.
    assert.equal(f.lite.prepare("SELECT ncm FROM erp_catalog__product WHERE record_id=?").get(product.id).ncm, null);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_fiscal_invoices__nature_rule WHERE nature_id=?").get(nature.id).n, 1);

    const job = randomUUID(), command = randomUUID();
    const done = f.batch("product_taxes", rows.slice(0, 2), { job, command });
    assert.deepEqual(done.items.map((i) => i.status), ["updated", "unchanged"]);
    assert.equal(done.job.kind, "product_taxes");
    const saved = f.lite.prepare("SELECT ncm, cest, origin, gtin_tax FROM erp_catalog__product WHERE record_id=?").get(product.id);
    assert.deepEqual({ ...saved }, { ncm: "61091000", cest: "2806300", origin: "2", gtin_tax: "SEM GTIN" });
    const rules = f.rpc("erp_fiscal_nature_get", { p_id: nature.id }).nature.rules;
    assert.deepEqual(rules.map((r) => [r.tax, r.product_scope, r.product_ids, r.data]), [
      ["icms", "any", [], { situation: "102", cfop: "5102" }],
      ["icms", "products", [product.id], { situation: "500", cfop: "5405", rate: "18.0000", benefit_code: "SP070001" }],
      ["pis", "products", [product.id], { situation: "49" }],
    ]);
    // O mesmo comando devolve o recibo; outro lote com o mesmo conteúdo não muda nada.
    assert.equal(f.batch("product_taxes", rows.slice(0, 2), { job, command }).replayed, true);
    const again = f.batch("product_taxes", rows.slice(0, 1));
    assert.deepEqual(again.items.map((i) => [i.status, i.reference]), [["unchanged", "FIS-1: sem alteração"]]);
    // O tipo real do lote vale nas leituras, com o tipo de apoio só na tabela original.
    assert.equal(f.lite.prepare("SELECT kind FROM erp_preferences__import_job WHERE id=?").get(job).kind, "products");
    assert.equal(f.lite.prepare("SELECT kind FROM erp_preferences__import_job_kind WHERE job_id=?").get(job).kind, "product_taxes");
    const page = f.rpc("erp_preferences_import_job", { p_job_id: job, p_errors: false, p_limit: 100, p_offset: 0 });
    assert.equal(page.job.kind, "product_taxes");
    assert.ok(f.rpc("erp_preferences_import_jobs", { p_status: null, p_limit: 25, p_offset: 0 }).items.some((j) => j.id === job && j.kind === "product_taxes"));
    // O registro de atividades conta a importação pelo tipo real.
    const activity = f.rpc("erp_activity_list", { p_from: "2026-11-01", p_to: "2026-11-30", p_limit: 50, p_offset: 0, p_module: null, p_operation: null, p_actor: null, p_query: null });
    const descriptions = JSON.stringify(activity);
    assert.match(descriptions, /Importação de planilha de dados fiscais dos produtos · product_taxes\.csv/);
    // Outro tipo no mesmo lote é recusado.
    assert.throws(() => f.batch("natures", [{ description: "X", direction: "1", items: [{}] }], { job }), /erp_preferences_import_job_mismatch/);
  } finally { f.lite.close(); }
});

test("motor: naturezas por planilha incluem, atualizam as regras e só trocam a padrão com confirmação", { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const old = f.rpc("erp_fiscal_nature_execute", { p_command_id: randomUUID(), p_action: "create", p_data: { nature: { description: "Venda antiga", direction: "1", crt: "1" } } }).nature;
    f.rpc("erp_fiscal_nature_execute", { p_command_id: randomUUID(), p_action: "set_default", p_data: { id: old.id, expected_version: old.version, code: "S" } });
    const row = { description: "Venda nova", direction: "1", crt: "1", series: "2", default_for: ["S", "VJ"],
      items: [{ tax: "icms", situation: "102", cfop: "5102", destinations: ["RJ", "SP"] }, { tax: "icms", situation: "500", ncms: ["6109"] }, { tax: "pis", situation: "49", rate: "0.65" }] };
    const preview = f.batch("natures", [row, { description: "Compra", direction: "0", items: [{ tax: "ipi", situation: "49" }] }], { dry: true });
    assert.deepEqual(preview.items.map((i) => [i.status, i.action, i.reason]), [["valid", "create", null], ["invalid", null, "erp_preferences_import_required:crt"]]);
    assert.equal(preview.items[0].reference, "Troca a natureza padrão: Padrão venda (hoje: Venda antiga) · Nova natureza · 3 regras · fica Padrão venda jurídica");
    // Sem confirmação a natureza entra e a padrão continua a de hoje.
    const first = f.batch("natures", [row]);
    assert.deepEqual(first.items.map((i) => i.status), ["created"]);
    assert.match(first.items[0].reference, /^Padrão mantido sem confirmação: Padrão venda \(hoje: Venda antiga\)/);
    const id = first.items[0].record_id;
    const defaults = () => Object.fromEntries(f.lite.prepare("SELECT code, nature_id FROM erp_fiscal_invoices__nature_default").all().map((d) => [d.code, d.nature_id]));
    assert.deepEqual(defaults(), { S: old.id, VJ: id });
    const created = f.rpc("erp_fiscal_nature_get", { p_id: id }).nature;
    assert.equal(created.series, 2);
    assert.deepEqual(created.rules.map((r) => [r.tax, r.product_scope, r.destinations, r.ncms, r.data]), [
      ["icms", "any", ["RJ", "SP"], [], { situation: "102", cfop: "5102" }], ["icms", "ncm", [], ["6109"], { situation: "500" }], ["pis", "any", [], [], { situation: "49", rate: "0.6500" }]]);
    // Com confirmação troca a padrão; as regras de ICMS da planilha substituem as gerais e a de PIS fica.
    const confirmed = f.batch("natures", [{ description: "venda NOVA", direction: "1", default_for: ["S"], confirm_default: true, items: [{ tax: "icms", situation: "103" }] }]);
    assert.deepEqual(confirmed.items.map((i) => [i.status, i.record_id]), [["updated", id]]);
    assert.deepEqual(defaults(), { S: id, VJ: id });
    assert.deepEqual(f.rpc("erp_fiscal_nature_get", { p_id: id }).nature.rules.map((r) => [r.tax, r.data.situation]), [["icms", "103"], ["pis", "49"]]);
    // O nome casa sem diferenciar maiúsculas e fica como na planilha; a mesma linha de novo não muda nada.
    assert.equal(f.rpc("erp_fiscal_nature_get", { p_id: id }).nature.description, "venda NOVA");
    assert.deepEqual(f.batch("natures", [{ description: "venda NOVA", direction: "1", default_for: ["S"], items: [{ tax: "icms", situation: "103" }] }]).items.map((i) => i.status), ["unchanged"]);
    // CST do Regime normal numa natureza do Simples é recusado com o campo.
    const wrong = f.batch("natures", [{ description: "Venda nova", direction: "1", items: [{ tax: "icms", situation: "00" }] }], { dry: true });
    assert.deepEqual(wrong.items.map((i) => [i.reason, i.field]), [["erp_preferences_import_icms_regime:item_situation", "item_situation"]]);
  } finally { f.lite.close(); }
});

test("motor: saldo inicial lança a diferença no caixa e reimportar não lança de novo", { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa loja", start_on: "2025-01-01", opening_cents: "1000" } }).record;
    const rows = [{ account: "caixa LOJA", date: "2025-12-31", balance: "1500.25", note: "Sistema antigo" }, { account: "Caixa loja", date: "2024-12-31", balance: "0" }, { account: "Banco X", date: "2025-12-31", balance: "1" }];
    const preview = f.batch("opening_balances", rows, { dry: true });
    assert.deepEqual(preview.items.map((i) => [i.status, i.reason]), [["valid", null], ["invalid", "erp_preferences_import_before_start:date"], ["invalid", "erp_preferences_import_not_found:account"]]);
    assert.equal(preview.items[0].reference, "Caixa loja: em 31/12/2025 R$ 10,00 → R$ 1.500,25 (entrada de R$ 1.490,25)");
    const balance = () => f.lite.prepare("SELECT sum(delta_cents) b FROM erp_finance__movement WHERE account_id=?").get(account.id).b;
    assert.equal(balance(), 1000);
    const done = f.batch("opening_balances", rows.slice(0, 1));
    assert.deepEqual(done.items.map((i) => i.status), ["created"]);
    assert.equal(balance(), 150025);
    const entry = f.lite.prepare("SELECT kind, amount_cents, posted_on, note FROM erp_finance__cash_entry WHERE id=?").get(done.items[0].record_id);
    assert.deepEqual({ ...entry }, { kind: "in", amount_cents: 149025, posted_on: "2025-12-31", note: "Saldo inicial importado da planilha opening_balances.csv · Sistema antigo" });
    assert.deepEqual(f.batch("opening_balances", rows.slice(0, 1)).items.map((i) => i.status), ["unchanged"]);
    assert.equal(balance(), 150025);
    // Saldo menor vira saída.
    const lower = f.batch("opening_balances", [{ account: "Caixa loja", date: "2025-12-31", balance: "-10" }]);
    assert.match(lower.items[0].reference, /saída de R\$ 1\.510,25\)$/);
    assert.equal(balance(), -1000);
  } finally { f.lite.close(); }
});

test("motor: só o administrador importa e a parte desligada recusa o tipo", { timeout: 120_000 }, () => {
  const f = fixture();
  try {
    assert.throws(() => f.batch("opening_balances", [{ account: "Caixa", date: "2025-12-31", balance: "1" }], { dry: true, user: f.clerk }), /erp_preferences_import_denied/);
    assert.throws(() => f.batch("natures", [{ description: "V", direction: "1", items: [{}] }], { dry: true, on: { fiscal: false } }), (e) => e.code === "module_disabled");
    assert.throws(() => f.batch("opening_balances", [{ account: "Caixa", date: "2025-12-31", balance: "1" }], { dry: true, on: { finance: false } }), (e) => e.code === "module_disabled");
    assert.throws(() => f.batch("product_taxes", [{ code: "P", ncm: "61091000" }], { dry: true, on: { fiscal: false } }), (e) => e.code === "module_disabled");
    // Com o Fiscal ligado e o Financeiro desligado, a planilha fiscal continua disponível.
    assert.deepEqual(f.batch("product_taxes", [{ code: "P", ncm: "61091000" }], { dry: true, on: { finance: false } }).items.map((i) => i.reason), ["erp_preferences_import_not_found:code"]);
  } finally { f.lite.close(); }
});
