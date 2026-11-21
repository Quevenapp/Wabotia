// Maquininha integrada ao caixa: o pagamento aprovado na maquininha entra na
// conciliação de cartões já casado com a venda do PDV
// (erp_reconciliation_card_terminal; sem tabela nova, sem mudar o esquema).
// Repetir não duplica; valor que não confere com as parcelas da forma é
// recusado; venda em aberto é recusada; Financeiro ou PDV desligados recusam
// antes de ler. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE, com1Fixture } from "../comnfe/fixtures.mjs";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { ENGINE_SIGNATURES } from "../../../src/erp/engine/signatures-engine.ts";

const CREDIT = "9a8b7c6d-2222-4222-8333-444455556666";
const code = (c) => (e) => e.code === c || e.message === c || String(e.message).startsWith(`${c}:`);

function fixture(t) {
  const f = com1Fixture(t);
  const at = Date.now() * 1000;
  f.db.exec(`INSERT INTO "erp_catalog__payment_method"(id, description, payment_type, destination, applicable, card_brand, created_by, updated_by, created_at, updated_at)
    VALUES(?, 'Cartão de crédito na maquininha', '03', 'contas', 'recebimentos', NULL, ?, ?, ?, ?)`, CREDIT, f.identity.actor.user_id, f.identity.actor.user_id, at, at);
  f.sale = (action, payments) => f.rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: action, p_data: {
    sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: null, cash_session_id: null, contact_id: f.customer.id, price_list_id: null,
    document: { date: COM1_DATE, items: [{ product_id: f.product.id, description: "Mercadoria do Ensaio", unit: "UN", quantity: "3", unit_price: "10.00", discount_percent: "0" }] },
    payments, destination_account_id: null, to_ledger: false, cash_received_cents: null,
  } }).record;
  f.terminal = (args, command = randomUUID(), env) => f.rpc("erp_reconciliation_card_terminal", { p_command_id: command, p_args: {
    payment_method_id: CREDIT, acquirer: "mercadopago", product: "credit", brand: "mastercard", installments: 3, gross_cents: "3000", fee_cents: "120",
    nsu: "998877", authorization: "A1B2C3", reference: randomUUID(), ...args } }, env);
  return f;
}

test("classificado na parte Financeiro com o PDV, com assinatura do motor", () => {
  assert.equal(ERP_RPC_RULES.erp_reconciliation_card_terminal, "reconciliation_terminal");
  assert.deepEqual(ENGINE_SIGNATURES.erp_reconciliation_card_terminal.map(([name]) => name), ["p_user_id", "p_command_id", "p_args"]);
});

test("pagamento aprovado entra já casado com as contas da venda, com bandeira, NSU, autorização e tarifa; repetir não duplica", (t) => {
  const f = fixture(t);
  const sale = f.sale("sale_finish", [30, 60, 90].map((days) => ({ payment_method_id: CREDIT, days, amount_cents: "1000", note: "Maquininha Mercado Pago · Mastercard crédito 3x" })));
  const reference = randomUUID();
  const result = f.terminal({ sale_id: sale.id, reference });
  assert.equal(result.state, "matched");
  assert.match(result.note, /já casado com a venda/);
  const line = f.db.exec(`SELECT * FROM "erp_reconciliation__card_line" WHERE id=?`, result.line_id).rows[0];
  const groups = f.db.exec(`SELECT DISTINCT t.group_id FROM "erp_pos__sale_payment" p JOIN "erp_finance__title" t ON t.id=p.title_id WHERE p.sale_id=?`, sale.id).rows;
  assert.equal(groups.length, 1);
  assert.deepEqual([line.kind, line.acquirer, line.state, line.group_id, line.title_id, line.confidence, line.brand, line.product, line.installments, line.gross_cents, line.fee_cents, line.net_cents, line.nsu, line.authorization],
    ["sale", "mercadopago", "matched", groups[0].group_id, null, 100, "mastercard", "credit", 3, 3000, 120, 2880, "998877", "A1B2C3"]);
  const view = f.rpc("erp_reconciliation_card_lines", { p_args: { kind: "sale" } }).lines.find((l) => l.id === result.line_id);
  assert.equal(view.state, "matched");
  assert.equal(view.group.id, groups[0].group_id);
  assert.match(f.db.exec(`SELECT file_name FROM "erp_reconciliation__card_import" WHERE id=?`, line.import_id).rows[0].file_name, /^Maquininha Mercado Pago — venda do PDV nº /);
  // O mesmo pagamento outra vez (outro comando): a mesma linha.
  const again = f.terminal({ sale_id: sale.id, reference });
  assert.equal(again.line_id, result.line_id);
  assert.equal(again.replayed, true);
  assert.equal(Number(f.db.exec(`SELECT count(*) n FROM "erp_reconciliation__card_line"`).rows[0].n), 1);
});

test("débito à vista com uma conta: casado com a conta", (t) => {
  const f = fixture(t);
  const sale = f.sale("sale_finish", [{ payment_method_id: CREDIT, days: 1, amount_cents: "3000", note: null }]);
  const result = f.terminal({ sale_id: sale.id, product: "debit", installments: 1, brand: "visa" });
  const line = f.db.exec(`SELECT title_id, state FROM "erp_reconciliation__card_line" WHERE id=?`, result.line_id).rows[0];
  const title = f.db.exec(`SELECT title_id FROM "erp_pos__sale_payment" WHERE sale_id=?`, sale.id).rows[0].title_id;
  assert.deepEqual([line.state, line.title_id], ["matched", title]);
});

test("recusa: valor diferente das parcelas da forma, venda em aberto, débito parcelado, dados inválidos", (t) => {
  const f = fixture(t);
  const sale = f.sale("sale_finish", [{ payment_method_id: CREDIT, days: 30, amount_cents: "3000", note: null }]);
  assert.throws(() => f.terminal({ sale_id: sale.id, gross_cents: "2999" }), code("erp_reconciliation_terminal_amount"));
  assert.throws(() => f.terminal({ sale_id: sale.id, product: "debit" }), code("erp_reconciliation_invalid"));
  assert.throws(() => f.terminal({ sale_id: sale.id, acquirer: "outra" }), code("erp_reconciliation_acquirer_invalid"));
  assert.throws(() => f.terminal({ sale_id: sale.id, fee_cents: "3001" }), code("erp_reconciliation_invalid"));
  assert.throws(() => f.terminal({ sale_id: sale.id, extra: 1 }), code("erp_reconciliation_invalid"));
  const open = f.sale("sale_save", [{ payment_method_id: CREDIT, days: 30, amount_cents: "3000", note: null }]);
  assert.throws(() => f.terminal({ sale_id: open.id }), code("erp_pos_sale_state"));
  assert.throws(() => f.terminal({ sale_id: randomUUID() }), code("erp_pos_not_found"));
  assert.equal(Number(f.db.exec(`SELECT count(*) n FROM "erp_reconciliation__card_line"`).rows[0].n), 0);
});

test("Financeiro ou Caixa / PDV desligados: recusa antes de ler", (t) => {
  const f = fixture(t);
  const disabled = (e) => e.code === "module_disabled";
  assert.throws(() => f.terminal({ sale_id: randomUUID() }, randomUUID(), { parts: { pos: false } }), disabled);
  assert.throws(() => f.terminal({ sale_id: randomUUID() }, randomUUID(), { parts: { finance: false, billing: false, pos: false } }), disabled);
});
