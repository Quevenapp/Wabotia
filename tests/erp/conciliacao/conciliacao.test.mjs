// Conciliação bancária e de cartões (Wabotia, sem função no oráculo; versão 30,
// parte Financeiro): OFX e planilha sem duplicar, sugestões com confiança
// (lançamento existente, conta em aberto pelo valor, vencimento e nome, regra
// da pessoa), conciliar, baixar, lançar pela regra, ignorar com motivo,
// desfazer, saldo do banco x sistema por dia; extrato da adquirente casado com
// as contas de cartão, taxa cobrada x contratada, o que vai cair e o
// recebimento na conta com a taxa; parte desligada recusando antes de ler.
// Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE, com1Fixture } from "../comnfe/fixtures.mjs";
import { todaySaoPaulo } from "../../../src/erp/engine/time.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { addDays } from "../../../src/erp/domains/reconciliation/model.ts";

const code = (c) => (e) => e.code === c || e.message === c || String(e.message).startsWith(`${c}:`);
const disabled = (e) => e.code === "module_disabled";
const count = (f, sql, ...args) => Number(f.db.exec(sql, ...args).rows[0].n);
const TODAY = todaySaoPaulo();
const D = (n) => addDays(TODAY, n);
const ofxDay = (d) => d.replaceAll("-", "");

function fixture(t) {
  const f = com1Fixture(t);
  f.read = (name, args = {}, env) => f.rpc(name, { p_args: args }, env);
  f.write = (name, args = {}, env) => f.rpc(name, { p_command_id: randomUUID(), p_args: args }, env);
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: "checking", institution_code: "341", institution_name: "Itaú", agency: "1234", account_number: "12345", account_digit: "6",
      name: "Banco do Ensaio", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.category = (name, kind) => f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind, parent_id: null, name, dre_group: null } }).record;
  f.title = (kind, amount, due, extra = {}) => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind, contact_id: f.customer.id, category_id: null, description: extra.description ?? "Conta do ensaio", source_reference: extra.reference ?? null, issued_on: extra.issued ?? D(-20),
    total_cents: String(extra.parts ? extra.parts.reduce((s, p) => s + Number(p), 0) : amount), installments: (extra.parts ?? [amount]).map((p, i) => ({ amount_cents: String(p), due_on: extra.dues?.[i] ?? due })),
  } });
  f.entry = (kind, amount, day, note) => f.rpc("erp_finance_cash_execute", { p_command_id: randomUUID(), p_action: "entry_save", p_data: {
    id: null, expected_version: 0, account_id: f.account.id, kind, amount_cents: String(amount), posted_on: day, competence_on: day, category_id: null, contact_id: null, note } });
  f.lines = (state = "pending", env) => f.read("erp_reconciliation_bank_lines", { account_id: f.account.id, state }, env);
  return f;
}

const ofx = (lines, ledger) => `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>341<ACCTID>12345</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${ofxDay(D(-10))}<DTEND>${ofxDay(D(0))}
${lines.map((l) => `<STMTTRN><TRNTYPE>${l.amount < 0 ? "DEBIT" : "CREDIT"}<DTPOSTED>${ofxDay(l.day)}120000[-3:BRT]<TRNAMT>${(l.amount / 100).toFixed(2)}${l.fitid ? `<FITID>${l.fitid}` : ""}<MEMO>${l.memo}</STMTTRN>`).join("\n")}
</BANKTRANLIST>${ledger === undefined ? "" : `<LEDGERBAL><BALAMT>${(ledger / 100).toFixed(2)}<DTASOF>${ofxDay(D(0))}</LEDGERBAL>`}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test("esquema: versão 30 só com tabelas novas e os RPCs na parte Financeiro", () => {
  assert.equal(ERP_DDL_VERSION, 30);
  const mine = ERP_ENGINE_TABLES.filter((t) => t.since === 30).map((t) => t.table).sort();
  assert.deepEqual(mine, ["erp_reconciliation__audit", "erp_reconciliation__bank_balance", "erp_reconciliation__bank_line", "erp_reconciliation__card_import",
    "erp_reconciliation__card_line", "erp_reconciliation__card_rate", "erp_reconciliation__command", "erp_reconciliation__layout", "erp_reconciliation__rule"]);
  for (const t of ERP_ENGINE_TABLES.filter((x) => x.since === 30)) for (const s of t.ddl) assert.doesNotMatch(s, /ALTER|DROP/);
  for (const name of ["erp_reconciliation_overview", "erp_reconciliation_preview", "erp_reconciliation_bank_import", "erp_reconciliation_bank_lines", "erp_reconciliation_bank_action",
    "erp_reconciliation_bank_candidates", "erp_reconciliation_rule_save", "erp_reconciliation_layout_save", "erp_reconciliation_card_import", "erp_reconciliation_card_lines",
    "erp_reconciliation_card_candidates", "erp_reconciliation_card_action", "erp_reconciliation_card_receive", "erp_reconciliation_card_rate_save"])
    assert.equal(ERP_RPC_RULES[name], "reconciliation", name);
});

test("OFX: importa sem duplicar (mesmo arquivo, FITID e linha sem FITID) e guarda o saldo do banco por dia", (t) => {
  const f = fixture(t);
  const file = ofx([
    { day: D(-3), amount: 15000, fitid: "A1", memo: "PIX RECEBIDO CLIENTE DO ENSAIO" },
    { day: D(-2), amount: -1290, fitid: "A2", memo: "TARIFA BANCARIA PACOTE" },
    { day: D(-1), amount: 5000, memo: "DEPOSITO SEM ID" },
  ], 17710);
  const first = f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "ofx", file_name: "extrato.ofx", content: file });
  assert.equal(first.new_lines, 3);
  assert.equal(first.balances, 4);
  const again = f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "ofx", file_name: "extrato.ofx", content: file });
  assert.equal(again.duplicate_file, true);
  assert.equal(again.new_lines, 0);
  // Outro arquivo com as mesmas linhas (e uma nova): só a nova entra.
  const other = ofx([{ day: D(-3), amount: 15000, fitid: "A1", memo: "PIX RECEBIDO CLIENTE DO ENSAIO" }, { day: D(-1), amount: 5000, memo: "DEPOSITO SEM ID" },
    { day: D(0), amount: 700, fitid: "A4", memo: "RENDIMENTO" }]);
  const second = f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "ofx", file_name: "extrato2.ofx", content: other });
  assert.equal(second.new_lines, 1);
  assert.equal(second.skipped, 2);
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_finance__bank_statement_line" WHERE account_id=?', f.account.id), 4);
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_reconciliation__bank_line"'), 4);
  const page = f.lines();
  assert.equal(page.counts.pending, 4);
  const last = page.balances.find((b) => b.day === D(0));
  assert.equal(last.bank_cents, "17710");
  assert.equal(last.system_cents, "0");
  assert.equal(last.difference_cents, "17710", "nada lançado no sistema: a diferença é o saldo do banco");
  // A planilha do mesmo extrato (sem identificador) não duplica a linha que veio por OFX sem FITID.
  const csv = `Data;Histórico;Valor\n${D(-1).split("-").reverse().join("/")};DEPOSITO SEM ID;50,00\n${D(-1).split("-").reverse().join("/")};DEPOSITO SEM ID;50,00\n`;
  const third = f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "csv", file_name: "extrato.csv", content: csv });
  assert.equal(third.new_lines, 1, "a repetida no arquivo é outro depósito; a primeira já existia");
});

test("planilha: modelo de colunas salvo pelo banco, crédito e débito separados e saldo do dia", (t) => {
  const f = fixture(t);
  const csv = `Extrato conta corrente\nDt. movimento;Descrição;Entrada;Saída;Saldo do dia\n${D(-2).split("-").reverse().join("/")};PIX JOAO;1.234,56;;1.234,56\n${D(-1).split("-").reverse().join("/")};BOLETO LUZ;;200,00;1.034,56\nTotal;;1.234,56;200,00;\n`;
  const preview = f.read("erp_reconciliation_preview", { target: "bank", format: "csv", content: csv });
  assert.equal(preview.total, 0 + 2);
  assert.equal(preview.credits_cents, "123456");
  assert.equal(preview.debits_cents, "20000");
  const result = f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "csv", file_name: "banco.csv", content: csv,
    mapping: { columns: { date: "Dt. movimento", description: "Descrição", credit: "Entrada", debit: "Saída", balance: "Saldo do dia" } }, save_layout: { name: "Banco do Ensaio" } });
  assert.equal(result.new_lines, 2);
  assert.equal(result.layout.name, "Banco do Ensaio");
  const overview = f.read("erp_reconciliation_overview");
  assert.equal(overview.layouts.length, 1);
  assert.equal(overview.layouts[0].mapping.columns.credit, "Entrada");
  const page = f.lines();
  assert.deepEqual(page.lines.map((l) => [l.amount_cents, l.source]), [["123456", "csv"], ["-20000", "csv"]]);
  assert.equal(page.balances.find((b) => b.day === D(-1)).bank_cents, "103456");
  // Sem as colunas: o erro diz o que fazer.
  assert.throws(() => f.read("erp_reconciliation_preview", { target: "bank", format: "csv", content: "a;b\n1;2\n" }), code("erp_reconciliation_file"));
});

test("sugestões: lançamento existente, conta em aberto pelo valor, vencimento e nome, regra; conciliar, baixar, lançar, ignorar e desfazer", (t) => {
  const f = fixture(t);
  const fees = f.category("Despesas bancárias", "payable");
  f.entry("in", 7000, D(-4), "Venda no balcão");
  const open = f.title("receivable", 15000, D(-3)).items[0];
  const file = ofx([
    { day: D(-3), amount: 15000, fitid: "B1", memo: `PIX RECEBIDO ${f.customer.name.toUpperCase()}` },
    { day: D(-2), amount: -1290, fitid: "B2", memo: "TARIFA BANCARIA PACOTE" },
    { day: D(-4), amount: 7000, fitid: "B3", memo: "DEPOSITO" },
    { day: D(-1), amount: 999, fitid: "B4", memo: "ESTORNO DESCONHECIDO" },
  ]);
  f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "ofx", file_name: "x.ofx", content: file });
  const rule = f.write("erp_reconciliation_rule_save", { name: "Tarifa do banco", pattern: "tarifa bancaria", direction: "out", category_id: fees.id }).rule;
  assert.equal(rule.category_name, "Despesas bancárias");
  assert.throws(() => f.write("erp_reconciliation_rule_save", { name: "Errada", pattern: "pix", direction: "in", category_id: fees.id }), code("erp_reconciliation_rule_category_kind"));
  const page = f.lines();
  const by = (memo) => page.lines.find((l) => l.memo.startsWith(memo));
  const pix = by("PIX"), fee = by("TARIFA"), deposit = by("DEPOSITO"), unknown = by("ESTORNO");
  assert.equal(pix.suggestions[0].type, "title");
  assert.ok(pix.suggestions[0].confidence >= 90, `confiança ${pix.suggestions[0].confidence}`);
  assert.equal(pix.suggestions[0].titles[0].id, open.id);
  assert.equal(fee.suggestions[0].type, "rule");
  assert.equal(deposit.suggestions[0].type, "movement");
  assert.equal(deposit.suggestions[0].level, "alta");
  assert.equal(unknown.suggestions.length, 0);

  // Baixar a conta sugerida pela linha do extrato.
  const settled = f.write("erp_reconciliation_bank_action", { line_id: pix.id, expected_version: pix.version, action: "settle", titles: pix.suggestions[0].titles.map(({ id, version }) => ({ id, expected_version: version })) });
  assert.equal(settled.line.state, "reconciled");
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_finance__title" WHERE id=? AND settled_cents=amount_cents', open.id), 1);
  // Lançar pela regra.
  const ruled = f.write("erp_reconciliation_bank_action", { line_id: fee.id, expected_version: fee.version, action: "rule_entry", rule_id: rule.id });
  assert.equal(ruled.line.state, "reconciled");
  assert.equal(ruled.line.links[0].category_name, "Despesas bancárias");
  // Confirmar o lançamento existente com um clique.
  const confirmed = f.write("erp_reconciliation_bank_action", { line_id: deposit.id, expected_version: deposit.version, action: "confirm", links: deposit.suggestions[0].links });
  assert.equal(confirmed.line.state, "reconciled");
  // Ignorar pede motivo; o motivo aparece; voltar para a fila.
  assert.throws(() => f.write("erp_reconciliation_bank_action", { line_id: unknown.id, expected_version: unknown.version, action: "ignore", reason: "" }), code("erp_reconciliation_reason_required"));
  const ignored = f.write("erp_reconciliation_bank_action", { line_id: unknown.id, expected_version: unknown.version, action: "ignore", reason: "Estorno do próprio banco, já devolvido" });
  assert.equal(ignored.line.state, "ignored");
  assert.equal(f.lines("ignored").lines[0].ignored_reason, "Estorno do próprio banco, já devolvido");
  const back = f.write("erp_reconciliation_bank_action", { line_id: unknown.id, expected_version: ignored.line.version, action: "unignore" });
  assert.equal(back.line.state, "pending");
  // Desfazer: a baixa continua (sem estorno) ou é estornada junto.
  const undone = f.write("erp_reconciliation_bank_action", { line_id: deposit.id, expected_version: confirmed.line.version, action: "undo" });
  assert.equal(undone.line.state, "pending");
  const undoSettle = f.write("erp_reconciliation_bank_action", { line_id: pix.id, expected_version: settled.line.version, action: "undo", reverse: true });
  assert.equal(undoSettle.line.state, "pending");
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_finance__title" WHERE id=? AND settled_cents=0', open.id), 1, "a baixa foi estornada");
  // Versão velha recusa; o mesmo comando repete o resultado.
  assert.throws(() => f.write("erp_reconciliation_bank_action", { line_id: deposit.id, expected_version: deposit.version, action: "confirm", links: deposit.suggestions[0].links }),
    code("erp_reconciliation_version_conflict"));
  const command = randomUUID();
  const args = { line_id: deposit.id, expected_version: undone.line.version, action: "confirm", links: deposit.suggestions[0].links };
  const once = f.rpc("erp_reconciliation_bank_action", { p_command_id: command, p_args: args });
  const twice = f.rpc("erp_reconciliation_bank_action", { p_command_id: command, p_args: args });
  assert.equal(twice.replayed, true);
  assert.equal(twice.line.state, once.line.state);
  // Saldo do sistema por dia acompanha o que foi conciliado e lançado.
  const balances = f.lines("all").balances;
  assert.ok(balances.length > 0);
  // Consulta lê; não grava.
  assert.throws(() => f.write("erp_reconciliation_bank_action", { line_id: unknown.id, expected_version: back.line.version, action: "ignore", reason: "teste" }, { role: "consulta" }),
    code("erp_finance_access_denied"));
  assert.equal(f.lines("pending", { role: "consulta" }).can_write, false);
});

test("parte desligada: Financeiro desligado recusa antes de ler", (t) => {
  const f = fixture(t);
  assert.throws(() => f.read("erp_reconciliation_overview", {}, { parts: { finance: false, billing: false, pos: false } }), disabled);
  assert.throws(() => f.write("erp_reconciliation_card_rate_save", { acquirer: "cielo", brand: "visa", product: "credit", rate_bp: 199 }, { parts: { finance: false, billing: false, pos: false } }), disabled);
});

function cardFixture(t) {
  const f = fixture(t);
  const at = Date.now() * 1000;
  f.db.exec(`INSERT INTO "erp_catalog__payment_method"(id, description, payment_type, destination, applicable, card_brand, created_by, updated_by, created_at, updated_at)
    VALUES(?, 'Cartão de crédito Visa', '03', 'contas', 'recebimentos', '01', ?, ?, ?, ?)`, "9a8b7c6d-1111-4222-8333-444455556666", f.identity.actor.user_id, f.identity.actor.user_id, at, at);
  f.cardTitle = (parts, issued, reference) => {
    const group = f.title("receivable", 0, null, { parts, issued, dues: parts.map((_, i) => addDays(issued, 30 * (i + 1))), reference, description: "Venda no cartão" });
    f.db.exec('UPDATE "erp_finance__title" SET payment_method_id=? WHERE group_id=?', "9a8b7c6d-1111-4222-8333-444455556666", group.group_id);
    return group;
  };
  return f;
}

test("cartão: a venda do PDV no cartão (a forma fica no pagamento da venda) é achada e aparece como venda do PDV", (t) => {
  const f = cardFixture(t);
  const method = "9a8b7c6d-1111-4222-8333-444455556666";
  const sale = f.rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_finish", p_data: {
    sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: null, cash_session_id: null, contact_id: f.customer.id, price_list_id: null,
    document: { date: COM1_DATE, items: [{ product_id: f.product.id, description: "Mercadoria do Ensaio", unit: "UN", quantity: "1", unit_price: "10.00", discount_percent: "0" }] },
    payments: [{ payment_method_id: method, days: 30, amount_cents: "1000", note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: null,
  } }).record;
  const title = f.db.exec('SELECT p.title_id, t.payment_method_id FROM "erp_pos__sale_payment" p JOIN "erp_finance__title" t ON t.id=p.title_id WHERE p.sale_id=?', sale.id).rows[0];
  assert.ok(title, "a venda gerou a conta a receber");
  assert.equal(title.payment_method_id, null, "a forma do PDV não vai para a conta");
  const br = COM1_DATE.split("-").reverse().join("/");
  f.write("erp_reconciliation_card_import", { acquirer: "stone", kind: "sales", file_name: "stone.csv",
    content: `Data da venda;Bandeira;Produto;Parcelas;Valor bruto;Valor líquido\n${br};Visa;Crédito;1;10,00;9,80\n` });
  const line = f.read("erp_reconciliation_card_lines", { kind: "sale" }).lines[0];
  assert.equal(line.title.id, title.title_id);
  assert.match(line.title.origin, /^Venda do PDV nº /);
  assert.ok(line.confidence >= 90, `confiança ${line.confidence}`);
});

test("cartão: importa vendas e recebíveis sem duplicar, casa com as contas de cartão, compara a taxa e recebe na conta com a taxa", (t) => {
  const f = cardFixture(t);
  const sold = D(-60);
  const one = f.cardTitle([10000], sold, "NSU 123456");
  const three = f.cardTitle([10000, 10000, 10000], sold);
  f.write("erp_reconciliation_card_rate_save", { acquirer: "cielo", brand: "visa", product: "credit", installments_from: 1, installments_to: 1, rate_bp: 199, settle_days: 30 });
  f.write("erp_reconciliation_card_rate_save", { acquirer: "cielo", brand: "visa", product: "credit", installments_from: 2, installments_to: 6, rate_bp: 249, settle_days: 30 });
  assert.throws(() => f.write("erp_reconciliation_card_rate_save", { acquirer: "cielo", brand: "visa", product: "credit", installments_from: 3, installments_to: 12, rate_bp: 299 }),
    code("erp_reconciliation_rate_overlap"));
  const br = (d) => d.split("-").reverse().join("/");
  const sales = `Data da venda;Bandeira;Produto;Parcelas;Valor bruto;Valor da taxa;Valor líquido;NSU;Código de autorização
${br(sold)};VISA;Crédito à vista;1;100,00;1,99;98,01;123456;A1B2C3
${br(sold)};VISA;Crédito parcelado loja;3;300,00;9,00;291,00;654321;D4E5F6
`;
  const imported = f.write("erp_reconciliation_card_import", { acquirer: "cielo", kind: "sales", file_name: "vendas.csv", content: sales, save_layout: { name: "Cielo vendas" } });
  assert.equal(imported.new_lines, 2);
  assert.equal(imported.suggested, 2);
  assert.equal(f.write("erp_reconciliation_card_import", { acquirer: "cielo", kind: "sales", file_name: "vendas.csv", content: sales }).duplicate_file, true);
  const salesPage = f.read("erp_reconciliation_card_lines", { kind: "sale" });
  const single = salesPage.lines.find((l) => l.installments === 1), parcel = salesPage.lines.find((l) => l.installments === 3);
  assert.equal(single.title.id, one.items[0].id);
  assert.ok(single.confidence >= 90, `confiança ${single.confidence}`);
  assert.equal(parcel.group.id, three.group_id);
  assert.equal(single.fee.contracted_rate_bp, 199);
  assert.equal(single.fee.expected_cents, "199");
  assert.equal(single.fee.above_contract, false);
  assert.equal(parcel.fee.expected_cents, "747");
  assert.equal(parcel.fee.above_contract, true, "9,00 cobrados contra 7,47 contratados");
  assert.equal(f.read("erp_reconciliation_card_lines", { kind: "sale", divergent: true }).lines.length, 1);

  // Recebíveis: duas parcelas pagas (uma no passado) e uma que ainda vai cair.
  const receivables = `Data de pagamento;Data da venda;Bandeira;Produto;Parcela;Valor bruto;Valor da taxa;Valor líquido;NSU
${br(D(-30))};${br(sold)};VISA;Crédito;1/1;100,00;1,99;98,01;123456
${br(D(-30))};${br(sold)};VISA;Crédito parcelado;1/3;100,00;3,00;97,00;654321
${br(D(30))};${br(sold)};VISA;Crédito parcelado;3/3;100,00;3,00;97,00;654321
`;
  const rec = f.write("erp_reconciliation_card_import", { acquirer: "cielo", kind: "receivables", file_name: "recebiveis.csv", content: receivables });
  assert.equal(rec.new_lines, 3);
  const page = f.read("erp_reconciliation_card_lines", { kind: "receivable" });
  assert.equal(page.summary.coming.length, 1);
  assert.equal(page.summary.coming[0].net_cents, "9700");
  const paid = page.lines.filter((l) => l.expected_on === D(-30));
  assert.ok(paid.every((l) => l.title), "as duas parcelas pagas acharam a conta");
  const confirmAll = f.write("erp_reconciliation_card_action", { action: "confirm_all", min_confidence: 70 });
  assert.ok(confirmAll.confirmed >= 2);
  // O depósito da adquirente no banco: soma dos líquidos do dia.
  f.write("erp_reconciliation_bank_import", { account_id: f.account.id, format: "ofx", file_name: "banco.ofx",
    content: ofx([{ day: D(-30), amount: 19501, fitid: "C1", memo: "CIELO CREDITO" }]) });
  const bankLine = f.lines().lines[0];
  const received = f.write("erp_reconciliation_card_receive", { line_ids: paid.map((l) => l.id), account_id: f.account.id, bank_line_id: bankLine.id });
  assert.equal(received.received, 2);
  assert.equal(received.net_cents, "19501");
  assert.equal(received.bank_line.state, "reconciled");
  const fee = f.db.exec('SELECT sum(fee_cents) fee, sum(principal_cents) principal FROM "erp_finance__settlement" WHERE kind=\'payment\'').rows[0];
  assert.equal(Number(fee.principal), 20000);
  assert.equal(Number(fee.fee), 499);
  // Desfazer o recebimento com a linha do banco conciliada: desfaça lá antes.
  const line = f.read("erp_reconciliation_card_lines", { state: "received" }).lines[0];
  assert.throws(() => f.write("erp_reconciliation_card_action", { action: "unreceive", line_id: line.id, expected_version: line.version }), code("erp_reconciliation_card_bank_linked"));
  // Ignorar com motivo; casar à mão com a lista de candidatas.
  const coming = f.read("erp_reconciliation_card_lines", { kind: "receivable", state: "open" }).lines.find((l) => l.expected_on === D(30));
  const candidates = f.read("erp_reconciliation_card_candidates", { line_id: coming.id }).candidates;
  assert.ok(candidates.length >= 1);
  const ignored = f.write("erp_reconciliation_card_action", { action: "ignore", line_id: coming.id, expected_version: coming.version, reason: "Cancelada na maquininha" });
  assert.equal(ignored.line.state, "ignored");
});
