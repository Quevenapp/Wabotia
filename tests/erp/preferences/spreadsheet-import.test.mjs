// Importações de planilha: última definição do oráculo (228/265/283/300).
// O diferencial compara resposta, erros por linha e todas as tabelas tocadas.
// Fiscal fica em sua frente; contatos e financeiro aqui exercitam somente o
// adaptador de planilhas, sem alterar os importadores próprios desses módulos.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { callRpc, isPorted } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

const RPC = "erp_preferences_import_batch";
let f, metrics;
const measured = [];
const entry = (row, data, lines = [row]) => ({ row, lines, data });
const args = (kind, rows, extra = {}) => ({
  p_user_id: f.users.admin, p_command_id: randomUUID(), p_job_id: randomUUID(),
  p_kind: kind, p_file_name: `${kind}.csv`, p_total_rows: rows.length,
  p_dry_run: false, p_rows: rows, ...extra,
});
const call = async (input) => {
  metrics = { queries: 0, reads: 0, max_params: 0, max_terms: 1 };
  const result = await f.rpc(RPC, input);
  measured.push({ kind: input.p_kind, dry_run: input.p_dry_run, rows: input.p_rows.length, replayed: result.replayed, ...metrics });
  return result;
};
const count = (table) => f.scalar(`select count(*)::integer from ${table}`);
const effects = async () => Object.fromEntries(await Promise.all([
  "erp_stock.movement", "erp_finance.title", "erp_finance.settlement", "erp_documents.document",
].map(async (table) => [table, await count(table)])));
const rejection = (message, code) => (error) => error.message === message && (!code || error.code === code);

before(async () => {
  assert.equal(isPorted(RPC), true, "o teste exige o RPC registrado, nunca espelhado silenciosamente");
  f = await dualFixture();
  const exec = f.driver.exec.bind(f.driver);
  f.driver.exec = (sql, ...params) => {
    const terms = 1 + (sql.match(/\bUNION\s+ALL\b/gi)?.length ?? 0);
    assert.ok(terms <= 5, `limite do Coordinator: ${terms} termos em ${sql.slice(0, 160)}`);
    if (metrics) {
      metrics.queries++;
      if (/^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i.test(sql)) metrics.reads++;
      metrics.max_params = Math.max(metrics.max_params, params.length);
      metrics.max_terms = Math.max(metrics.max_terms, terms);
    }
    return exec(sql, ...params);
  };
});
after(async () => {
  if (f) {
    const families = [...new Set(measured.filter((item) => item.rows === 3).map((item) => item.kind))];
    console.log("planilhas: SQLs (leituras) para 2 linhas válidas + 1 inválida; prévia / confirmação / repetição");
    for (const kind of families) {
      const rows = measured.filter((item) => item.kind === kind && item.rows === 3);
      const format = (item) => item ? `${item.queries} (${item.reads})` : "não concluiu";
      console.log(`${kind}: ${format(rows.find((item) => item.dry_run))} / ${format(rows.find((item) => !item.dry_run && !item.replayed))} / ${format(rows.find((item) => item.replayed))}`);
    }
    console.log(`diferencial: ${f.stats.ported} chamadas, ${f.stats.compared_tables} tabelas comparadas; máximo SQL ${Math.max(0, ...measured.map((item) => item.max_params))} parâmetros / ${Math.max(0, ...measured.map((item) => item.max_terms))} termos UNION ALL`);
  }
  await f?.close();
});

test("famílias: prévia sem escrita, erro na linha intermediária, confirmação e repetição", { timeout: 240_000 }, async (t) => {
  const product = async (code, data = {}) => (await f.rpc("erp_catalog_product_save", {
    p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_data: { code, name: `Produto ${code}`, kind: "P", format: "S", unit: "UN", price: "10", ...data }, p_acknowledged: null,
  })).record;
  const p1 = await product("IMPORT-A"), p2 = await product("IMPORT-B");
  await product("IMPORT-KIT-A"); await product("IMPORT-KIT-B");
  await product("IMPORT-LOTE", { lot_control: true });
  await f.catalog("contacts", { name: "Fornecedor Planilha", roles: ["supplier", "customer"], document: "12345678000190" });
  await f.catalog("warehouses", { name: "Depósito Planilha" });
  await f.rpc("erp_catalog_custom_field_save", {
    p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_data: { field_type: "text", name: "Campo planilha" },
  });
  const order = (number) => ({ number, date: "2026-10-10", contact_name: "Fornecedor Planilha", items: [{ code: "IMPORT-A", quantity: "2" }] });
  const title = (description) => ({ description, contact_name: "Fornecedor Planilha", issued_on: "2026-10-10", due_on: "2026-11-10", amount: "25.50" });
  const families = [
    ["products", { code: "NOVO-A", name: "Novo A", unit: "UN", price: "3.5" }, { code: "INVALIDO" }, { code: "NOVO-B", name: "Novo B" }, "erp_catalog_name_required"],
    ["contacts", { name: "Contato novo A" }, { name: "" }, { name: "Contato novo B" }, "erp_catalog_name_required"],
    ["product_suppliers", { code: "IMPORT-A", supplier_name: "Fornecedor Planilha", purchase_price: "3.5" }, { code: "IMPORT-A", supplier_name: "Não existe" }, { code: "IMPORT-B", supplier_document: "12345678000190", cost_price: "2" }, "erp_preferences_import_not_found:supplier_name"],
    ["compositions", { code: "IMPORT-KIT-A", stock_type: "virtual", items: [{ code: "IMPORT-A", quantity: "2" }] }, { code: "IMPORT-KIT-A", stock_type: "virtual", items: [{ code: "Não existe", quantity: "2" }] }, { code: "IMPORT-KIT-B", stock_type: "physical", post_mode: "product", items: [{ code: "IMPORT-B", quantity: "3" }] }, "erp_preferences_import_not_found:item_code"],
    ["custom_fields", { code: "IMPORT-A", items: [{ field: "Campo planilha", value: "Valor A" }] }, { code: "IMPORT-A", items: [{ field: "Não existe", value: "x" }] }, { code: "IMPORT-B", items: [{ field: "Campo planilha", value: "Valor B" }] }, "erp_preferences_import_not_found:item_field"],
    ["lots", { code: "IMPORT-LOTE", lot: "LOTE-A", manufactured_on: "2026-01-01", expires_on: "2027-01-01" }, { code: "IMPORT-A", lot: "SEM-CONTROLE" }, { code: "IMPORT-LOTE", lot: "LOTE-B", note: "Observação" }, "erp_stock_lot_control_off"],
    ["purchase_orders", order("C-1"), { ...order("C-2"), contact_name: "Não existe" }, order("C-3"), "erp_preferences_import_not_found:contact_name"],
    ["sales_orders", order("V-1"), { ...order("V-2"), contact_name: "Não existe" }, order("V-3"), "erp_preferences_import_not_found:contact_name"],
    ["stock_movements", { code: "IMPORT-A", warehouse: "Depósito Planilha", movement: "receipt", quantity: "5", date: "2026-10-10" }, { code: "Não existe", warehouse: "Depósito Planilha", movement: "receipt", quantity: "5" }, { code: "IMPORT-B", warehouse: "Depósito Planilha", movement: "balance", quantity: "7", date: "2026-10-10" }, "erp_preferences_import_not_found:code"],
    ["receivables", title("Receber A"), { ...title("Inválida"), contact_name: "Não existe" }, title("Receber B"), "erp_preferences_import_not_found:contact_name"],
    ["payables", title("Pagar A"), { ...title("Inválida"), contact_name: "Não existe" }, title("Pagar B"), "erp_preferences_import_not_found:contact_name"],
  ];
  for (const [kind, first, invalid, last, reason] of families) await t.test(kind, async () => {
    const input = args(kind, [entry(4, last), entry(3, invalid), entry(2, first)]);
    const initial = await effects(), jobs = await count("erp_preferences.import_job"), records = await count("erp_catalog.record");
    const preview = await call({ ...input, p_dry_run: true });
    assert.equal(preview.job, null);
    assert.deepEqual(preview.items.map((item) => item.status), ["valid", "invalid", "valid"]);
    assert.equal(preview.items[1].reason, reason);
    assert.ok(preview.items.every((item) => item.record_id === null && item.reference === null));
    assert.deepEqual(await effects(), initial);
    assert.equal(await count("erp_preferences.import_job"), jobs);
    assert.equal(await count("erp_catalog.record"), records);
    const confirmed = await call(input);
    assert.equal(confirmed.job.status, "concluida");
    assert.equal(confirmed.job.rows_done, 3);
    assert.equal(confirmed.job.invalid, 1);
    assert.equal(confirmed.items[1].reason, reason);
    assert.equal(confirmed.items[1].action, null);
    assert.deepEqual(confirmed.items.map((item) => item.row), [2, 3, 4]);
    assert.ok(confirmed.items.filter((item) => item.status !== "invalid").every((item) => item.record_id));
    const final = await effects();
    assert.equal(final["erp_stock.movement"] - initial["erp_stock.movement"], kind === "stock_movements" ? 2 : 0);
    assert.equal(final["erp_finance.title"] - initial["erp_finance.title"], ["receivables", "payables"].includes(kind) ? 2 : 0);
    assert.equal(final["erp_finance.settlement"], initial["erp_finance.settlement"]);
    assert.equal(final["erp_documents.document"] - initial["erp_documents.document"], ["purchase_orders", "sales_orders"].includes(kind) ? 2 : 0);
    const replay = await call(input);
    assert.deepEqual(replay, { ...confirmed, replayed: true });
    assert.deepEqual(await effects(), final);
    const errors = await f.rpc("erp_preferences_import_job", {
      p_user_id: f.users.admin, p_job_id: input.p_job_id, p_errors: true, p_limit: 50, p_offset: 0,
    });
    assert.equal(errors.total, 1);
    assert.deepEqual(errors.items, [confirmed.items[1]]);
    await assert.rejects(call({ ...input, p_file_name: "arquivo-outro.csv" }), rejection("erp_preferences_import_command_conflict", "40001"));
  });
  assert.ok(p1.id && p2.id);
});

test("atualizações preservam vazios, lotes iguais ficam sem alteração e produtos não duplicam", async () => {
  const same = args("products", [entry(2, { code: "NOVO-A" })]);
  const result = await call(same);
  assert.equal(result.items[0].status, "unchanged");
  const edited = await call(args("products", [entry(2, { code: "NOVO-A", name: "Novo A atualizado", price: "4.25" })]));
  assert.equal(edited.items[0].status, "updated");
  assert.equal(await f.scalar("select count(*)::integer from erp_catalog.record where code='NOVO-A'"), 1);
  const lot = await call(args("lots", [entry(2, { code: "IMPORT-LOTE", lot: "LOTE-A", note: "Atualizado" })]));
  assert.equal(lot.items[0].status, "updated");
  const unchanged = await call(args("lots", [entry(2, { code: "IMPORT-LOTE", lot: "LOTE-A" })]));
  assert.equal(unchanged.items[0].status, "unchanged");
  assert.equal(await f.scalar("select expires_on::text from erp_stock.lot where id=$1", [lot.items[0].record_id]), "2027-01-01");
});

test("retomada usa linhas gravadas; total, identidade do trabalho e comando são imutáveis", async () => {
  const first = args("products", [entry(2, { code: "RETOMADA-A", name: "Retomada A" })], { p_total_rows: 2 });
  const opened = await call(first);
  assert.equal(opened.job.status, "em_andamento");
  const resumed = await call({ ...first, p_command_id: randomUUID(), p_rows: [entry(2, { code: "IGNORADO", name: "Não grava" }), entry(3, { code: "RETOMADA-B", name: "Retomada B" })] });
  assert.equal(resumed.job.status, "concluida");
  assert.equal(resumed.job.created, 2);
  assert.deepEqual(resumed.items[0], opened.items[0]);
  assert.equal(await f.scalar("select count(*)::integer from erp_catalog.record where code='IGNORADO'"), 0);
  await assert.rejects(call({ ...first, p_command_id: randomUUID() }), rejection("erp_preferences_import_job_finished", "40001"));
  const next = args("products", [entry(2, { code: "RETOMADA-C", name: "Retomada C" })], { p_total_rows: 2 });
  await call(next);
  await assert.rejects(call({ ...next, p_command_id: randomUUID(), p_total_rows: 3 }), rejection("erp_preferences_import_job_mismatch", "22023"));
  const over = args("products", [entry(2, { code: "ROLLBACK-A", name: "Volta A" }), entry(3, { code: "ROLLBACK-B", name: "Volta B" })], { p_total_rows: 1 });
  await assert.rejects(call(over), rejection("erp_preferences_import_total_exceeded", "22023"));
  assert.equal(await f.scalar("select count(*)::integer from erp_catalog.record where code like 'ROLLBACK-%'"), 0);
});

test("limites: 50 itens, 10.000 linhas declaradas, 250 linhas agrupadas e 256 KiB", { timeout: 120_000 }, async () => {
  const rows = Array.from({ length: 50 }, (_, index) => entry(index + 2, { code: `LIMITE-${index}`, name: `Limite ${index}`, unit: "UN", kind: "P", format: "S" }));
  const limit = args("products", rows, { p_total_rows: 10000 });
  const preview = await call({ ...limit, p_dry_run: true });
  assert.equal(preview.items.length, 50);
  const confirmed = await call(limit);
  assert.equal(confirmed.job.rows_done, 50);
  assert.equal(confirmed.job.total_rows, 10000);
  assert.ok(confirmed.items.every((item) => item.status === "created"));
  for (const patch of [
    { p_rows: [...rows, entry(52, { code: "EXCESSO", name: "Excesso" })] },
    { p_total_rows: 10001 }, { p_total_rows: 0 }, { p_rows: [] },
    { p_rows: [entry(10002, { code: "FORA", name: "Fora" })] },
    { p_rows: [entry(2, { code: "EXCESSO", name: "Excesso" }, Array.from({ length: 251 }, (_, i) => i + 2))] },
    { p_rows: [entry(2, { name: "x".repeat(262144) })] },
    { p_rows: [entry(2, { name: "Repetida" }), entry(2, { name: "Repetida" })] },
  ]) await assert.rejects(call({ ...limit, ...patch, p_command_id: randomUUID() }), rejection("erp_preferences_import_invalid", "22023"));
  const grouped = await call(args("products", [entry(10001, { code: "AGRUPADO", name: "Agrupado" }, [10001, ...Array.from({ length: 249 }, (_, i) => i + 2)])], { p_dry_run: true }));
  assert.equal(grouped.items[0].status, "valid");
});

test("papéis insuficientes: a recusa é do lote inteiro antes de gravar", async () => {
  for (const role of ["consulta", "vendas", "financeiro", "estoque", "fiscal", "inactive"]) {
    await assert.rejects(call(args("products", [entry(2, { name: "Não deve gravar" })], { p_user_id: f.users[role] })), rejection("erp_preferences_import_denied", "42501"));
  }
  for (const kind of ["contacts", "product_suppliers", "compositions", "custom_fields", "lots", "purchase_orders", "sales_orders", "stock_movements", "receivables", "payables"])
    await assert.rejects(call(args(kind, [entry(2, {})], { p_user_id: f.users.consulta })), rejection("erp_preferences_import_denied", "42501"));
  for (const kind of [null, "desconhecida"]) {
    await assert.rejects(call(args(kind, [entry(2, {})])), rejection("erp_preferences_import_invalid", "22023"));
    await assert.rejects(call(args(kind, [entry(2, {})], { p_user_id: f.users.consulta })), rejection("erp_preferences_import_denied", "42501"));
  }
});

test("dados inválidos mantêm o erro por linha do PostgreSQL e não abortam o trabalho", async () => {
  for (const [kind, data] of [
    ["purchase_orders", { number: "X", date: "2026-10-10", contact_name: "Fornecedor Planilha", items: null }],
    ["sales_orders", { number: "X", date: "2026-10-10", contact_name: "Fornecedor Planilha", items: {} }],
    ["compositions", { code: "IMPORT-KIT-A", stock_type: "virtual", items: {} }],
    ["stock_movements", { code: "IMPORT-A", warehouse: "Depósito Planilha", movement: "receipt", quantity: null }],
    ["receivables", { contact_name: "Fornecedor Planilha", description: "Nulo", issued_on: "2026-10-10", due_on: "2026-11-10", amount: null }],
    ["payables", { contact_name: "Fornecedor Planilha", description: "Excesso", issued_on: "2026-10-10", due_on: "2026-11-10", amount: "92233720368547758.08" }],
  ]) {
    const result = await call(args(kind, [entry(2, data)]));
    assert.equal(result.items[0].status, "invalid", `${kind}: ${JSON.stringify(result.items)}`);
    assert.equal(result.job.status, "concluida");
  }
});

test("cada família respeita as partes desligadas no motor, inclusive na prévia", () => {
  const required = {
    products: ["products"], product_suppliers: ["products"], compositions: ["products", "stock"], custom_fields: ["products"],
    lots: ["products", "stock"], purchase_orders: ["purchases"], sales_orders: ["sales"],
    stock_movements: ["products", "stock"], receivables: ["finance"], payables: ["finance"], contacts: ["customers"],
  };
  for (const [kind, parts] of Object.entries(required)) for (const part of parts) for (const dry of [false, true]) {
    assert.throws(() => callRpc(f.driver, RPC, args(kind, [entry(2, {})], { p_dry_run: dry }), f.clock, {
      parts: normalizeErpParts({ [part]: false }),
    }), (error) => error.code === "module_disabled", `${kind}: ${part} desligada, dry_run=${dry}`);
  }
});

test("composição com 100 componentes passa sob os tetos SQL do Coordinator", { timeout: 120_000 }, async () => {
  await call(args("products", Array.from({ length: 50 }, (_, index) => entry(index + 2, {
    code: `COMPONENTE-${index}`, name: `Componente ${index}`, unit: "UN", kind: "P", format: "S", price: "1",
  }))));
  await call(args("products", [entry(2, { code: "KIT-LIMITE", name: "Kit de cem componentes", kind: "P", unit: "UN" })]));
  const items = [
    ...Array.from({ length: 50 }, (_, index) => ({ code: `LIMITE-${index}`, quantity: "1" })),
    ...Array.from({ length: 50 }, (_, index) => ({ code: `COMPONENTE-${index}`, quantity: "2" })),
  ];
  const input = args("compositions", [entry(2, { code: "KIT-LIMITE", stock_type: "virtual", items }, Array.from({ length: 100 }, (_, index) => index + 2))]);
  const preview = await call({ ...input, p_dry_run: true });
  assert.equal(preview.items[0].status, "valid", JSON.stringify(preview.items));
  const result = await call(input);
  assert.equal(result.items[0].status, "created");
  assert.equal(await f.scalar("select count(*)::integer from erp_stock.composition_item where product_id=$1", [result.items[0].record_id]), 100);
  const over = await call(args("compositions", [entry(2, { code: "KIT-LIMITE", stock_type: "virtual", items: [...items, { code: "IMPORT-A", quantity: "1" }] })]));
  assert.equal(over.items[0].status, "invalid");
});

test("campos customizados: números, datas, booleanos e opções seguem a conversão original", async () => {
  const fields = [];
  for (const data of [
    { name: "Número importado", field_type: "decimal" }, { name: "Data importada", field_type: "date" },
    { name: "Marcado importado", field_type: "boolean" }, { name: "Cor importada", field_type: "list", options: [{ label: "Azul" }, { label: "Verde" }] },
  ]) fields.push((await f.rpc("erp_catalog_custom_field_save", {
    p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data,
  })).field);
  const input = args("custom_fields", [entry(2, { code: "IMPORT-A", items: [
    { field: "Número importado", value: "1.234,50" }, { field: "Data importada", value: "19/11/2026" },
    { field: "Marcado importado", value: "Não" }, { field: "Cor importada", value: "aZUL" },
  ] }, [2, 3, 4, 5])]);
  const saved = await call(input);
  assert.equal(saved.items[0].status, "updated");
  const values = (await f.db.query("select field_id::text, value from erp_catalog.product_custom_value where record_id=$1", [saved.items[0].record_id])).rows;
  const value = (index) => values.find((row) => row.field_id === fields[index].id)?.value;
  assert.deepEqual([value(0), value(1), value(2), value(3)], ["1234.5", "2026-11-19", "false", fields[3].options[0].id]);
  for (const item of [
    { field: "Cor importada", value: "Vermelho" }, { field: "Marcado importado", value: "Talvez" },
    { field: "Número importado", value: "" }, { field: "Data importada", value: "31/02/2026" },
  ]) assert.equal((await call(args("custom_fields", [entry(2, { code: "IMPORT-A", items: [item] })]))).items[0].status, "invalid");
});

test("preferências: atualizar componente recalcula kits; pedido importado continua sem estoque ou títulos", async () => {
  const preference = async (page, values) => {
    const current = await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page });
    const changes = Object.entries(values).map(([key, value]) => ({ key, value, expected_version: current.items.find((item) => item.key === key).version }));
    await f.rpc("erp_preferences_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: page, p_changes: changes });
  };
  await preference("cadastros-produtos", { "produtos.composicao_preco": true, "produtos.composicao_peso": true });
  const price = async () => Number(await f.scalar("select p.price from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where r.code='IMPORT-KIT-A'"));
  const previous = await price();
  const input = args("products", [entry(2, { code: "IMPORT-A", price: "15", net_weight: "3", gross_weight: "4" })]);
  assert.equal((await call({ ...input, p_dry_run: true })).items[0].status, "valid");
  assert.equal(await price(), previous, "a prévia também reverte os kits recalculados");
  assert.equal((await call(input)).items[0].status, "updated");
  assert.equal(await price(), 30);
  assert.equal(Number(await f.scalar("select p.net_weight from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where r.code='IMPORT-KIT-A'")), 6);
  await preference("cadastros-produtos", { "produtos.composicao_preco": false, "produtos.composicao_peso": false });
  await preference("suprimentos-compras", { "compras.automacao_contas_pagar": true });
  const initial = await effects();
  const purchase = await call(args("purchase_orders", [entry(2, { number: "AUTO-1", date: "2026-10-10", contact_name: "Fornecedor Planilha", items: [{ code: "IMPORT-A", quantity: "2" }] })]));
  assert.equal(purchase.items[0].status, "created");
  const final = await effects();
  assert.equal(final["erp_finance.title"], initial["erp_finance.title"], "a planilha não fornece parcelas para o lançamento automático");
  assert.equal(final["erp_stock.movement"], initial["erp_stock.movement"]);
  await preference("suprimentos-compras", { "compras.automacao_contas_pagar": false });
});

