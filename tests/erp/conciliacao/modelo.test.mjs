// Conciliação, contas puras: OFX (SGML e XML, sem FITID, saldo final), valores
// e datas como os bancos escrevem, planilha do banco (valor com sinal, crédito
// e débito, saldo do dia, rodapés), planilha da adquirente (taxa em valor ou
// em %), identidade estável das linhas, taxa contratada e notas de confiança.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReconciliationFileError, balancesFromEnd, brl, cardDedupSource, cardScore, chargedRateBp, detectSeparator, expectedFee, movementScore, nameMatch, normalizeBrand,
  normalizeProduct, parseBankCsv, parseCardCsv, parseCents, parseCsv, parseDay, parseInstallment, parseOfx, parseRateBp, rateFor, ruleMatches, titleScore,
} from "../../../src/erp/domains/reconciliation/model.ts";

const fileError = (code) => (e) => e instanceof ReconciliationFileError && e.code === code;

test("valores e datas como os bancos escrevem", () => {
  assert.equal(parseCents("R$ -1.234,56"), -123456n);
  assert.equal(parseCents("1234.56"), 123456n);
  assert.equal(parseCents("1.234"), 123400n, "um ponto com três casas depois da vírgula ausente: milhar");
  assert.equal(parseCents("12.5"), 1250n);
  assert.equal(parseCents("(12,00)"), -1200n);
  assert.equal(parseCents("12,00 D"), -1200n);
  assert.equal(parseCents("12,00-"), -1200n);
  assert.equal(parseCents("1,234.56"), 123456n);
  assert.equal(parseCents("abc"), null);
  assert.equal(parseCents("1,234"), null, "três casas depois da vírgula decimal: não é valor em reais");
  assert.equal(parseDay("21/11/2026"), "2026-11-21");
  assert.equal(parseDay("21-11-26"), "2026-11-21");
  assert.equal(parseDay("2026-11-21T10:00:00"), "2026-11-21");
  assert.equal(parseDay("20261121120000[-3:BRT]"), "2026-11-21");
  assert.equal(parseDay("31/02/2026"), null);
  assert.equal(parseDay("11/21/2026", "mdy"), "2026-11-21");
  assert.equal(parseRateBp("1,99%"), 199);
  assert.equal(parseRateBp("0,0199"), 199);
  assert.equal(parseRateBp("2.5"), 250);
  assert.equal(brl(-123456n), "-1.234,56");
});

test("OFX SGML: lançamentos, linha sem FITID com identificador estável, saldo final por dia", () => {
  const text = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>001<ACCTID>9-1</BANKACCTFROM><BANKTRANLIST><DTSTART>20261101<DTEND>20261110
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261102<TRNAMT>150.00<FITID>X1<MEMO>PIX RECEBIDO</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-12.90<MEMO>TARIFA &amp; CESTA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-12.90<MEMO>TARIFA &amp; CESTA</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20261110</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const file = parseOfx(text);
  assert.equal(file.period_from, "2026-11-01");
  assert.equal(file.lines.length, 3);
  assert.equal(file.lines[1].memo, "TARIFA & CESTA");
  assert.notEqual(file.lines[1].fitid, file.lines[2].fitid, "as duas tarifas iguais são duas linhas");
  assert.deepEqual(parseOfx(text).lines.map((l) => l.fitid), file.lines.map((l) => l.fitid), "o mesmo arquivo dá os mesmos identificadores");
  assert.deepEqual(file.balances, [
    { day: "2026-11-02", balance_cents: "102580" }, { day: "2026-11-03", balance_cents: "100000" }, { day: "2026-11-10", balance_cents: "100000" },
  ]);
  assert.throws(() => parseOfx("nada"), fileError("ofx_invalid"));
  assert.deepEqual(balancesFromEnd([], 500n, "2026-11-10"), [{ day: "2026-11-10", balance_cents: "500" }]);
});

test("OFX XML (2.x) também é lido", () => {
  const file = parseOfx(`<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>10,50</TRNAMT><FITID>Z9</FITID><NAME>JOAO</NAME></STMTTRN></BANKTRANLIST></OFX>`);
  assert.deepEqual(file.lines, [{ fitid: "Z9", posted_on: "2026-11-05", amount_cents: "1050", memo: "JOAO", trntype: "CREDIT" }]);
});

test("planilha do banco: separador, cabeçalho depois do título, crédito e débito, saldo, rodapé e modelo pelo nome da coluna", () => {
  assert.equal(detectSeparator("a;b;c\n1;2;3"), ";");
  assert.equal(detectSeparator("a,b,c\n1,2,3"), ",");
  assert.deepEqual(parseCsv('"Data";"Descrição ""x""";"Valor"\n01/11/2026;"PIX; JOAO";"1.000,00"\n'), [["Data", 'Descrição "x"', "Valor"], ["01/11/2026", "PIX; JOAO", "1.000,00"]]);
  const csv = `Banco do Ensaio - extrato\nData;Histórico;Crédito (R$);Débito (R$);Saldo (R$)\n01/11/2026;SALDO ANTERIOR;;;500,00\n02/11/2026;PIX JOAO;100,00;;600,00\n03/11/2026;TARIFA;;10,00;590,00\nTotal;;100,00;10,00;\n`;
  const file = parseBankCsv(csv, { columns: { credit: "Crédito (R$)", debit: "Débito (R$)", balance: "Saldo (R$)" } });
  assert.deepEqual(file.lines.map((l) => [l.posted_on, l.amount_cents, l.memo]), [["2026-11-02", "10000", "PIX JOAO"], ["2026-11-03", "-1000", "TARIFA"]]);
  assert.deepEqual(file.balances.map((b) => [b.day, b.balance_cents]), [["2026-11-01", "50000"], ["2026-11-02", "60000"], ["2026-11-03", "59000"]]);
  const signed = parseBankCsv("Data;Descrição;Valor;Tipo\n02/11/2026;PIX;100,00;C\n03/11/2026;BOLETO;50,00;D\n");
  assert.deepEqual(signed.lines.map((l) => l.amount_cents), ["10000", "-5000"]);
  const inverted = parseBankCsv("Data;Descrição;Valor\n02/11/2026;COMPRA;50,00\n", { columns: {}, invert: true });
  assert.equal(inverted.lines[0].amount_cents, "-5000");
  const byIndex = parseBankCsv("x;y;z\n02/11/2026;PIX;7,00\n", { columns: { date: "#1", description: "#2", amount: "#3" } });
  assert.equal(byIndex.lines[0].amount_cents, "700");
  assert.throws(() => parseBankCsv("a;b\n1;2\n"), fileError("csv_columns"));
});

test("planilha da adquirente: vendas e recebíveis, taxa em valor ou em %, parcelas e bandeiras", () => {
  const sales = parseCardCsv(`Data da venda;Bandeira;Produto;Parcelas;Valor bruto;Taxa;NSU\n01/11/2026;Mastercard;Crédito parcelado;3;300,00;2,49%;777\n01/11/2026;Elo;Débito;1;50,00;0,50;888\nTotal;;;;350,00;;\n`, "sales");
  assert.equal(sales.lines.length, 2);
  assert.equal(sales.skipped, 1);
  assert.deepEqual(sales.lines.map((l) => [l.brand, l.product, l.installments, l.gross_cents, l.fee_cents, l.net_cents, l.nsu]),
    [["mastercard", "credit", 3, "30000", "747", "29253", "777"], ["elo", "debit", 1, "5000", "50", "4950", "888"]]);
  const rec = parseCardCsv(`Data de pagamento;Data da venda;Bandeira;Parcela;Valor bruto;Valor líquido\n01/12/2026;01/11/2026;VISA;2/3;100,00;97,51\n`, "receivables");
  assert.deepEqual([rec.lines[0].kind, rec.lines[0].installment, rec.lines[0].installments, rec.lines[0].fee_cents, rec.lines[0].expected_on], ["receivable", 2, 3, "249", "2026-12-01"]);
  assert.deepEqual(parseInstallment("02 de 10"), [2, 10]);
  assert.deepEqual(parseInstallment("1", "6"), [1, 6]);
  assert.equal(normalizeBrand("AMERICAN EXPRESS"), "amex");
  assert.equal(normalizeBrand("Banricompras"), "outros");
  assert.equal(normalizeProduct("Maestro"), "debit");
  // A mesma linha em outro arquivo tem a mesma identidade; duas iguais sem NSU no mesmo arquivo são duas.
  const a = cardDedupSource(sales.lines[0], new Map()), b = cardDedupSource(sales.lines[0], new Map());
  assert.equal(a, b);
  const seen = new Map(), noId = { ...sales.lines[1], nsu: null, authorization: null };
  assert.notEqual(cardDedupSource(noId, seen), cardDedupSource(noId, seen));
  assert.throws(() => parseCardCsv("a;b\n1;2\n", "sales"), fileError("csv_columns"));
});

test("taxa contratada, taxa cobrada e notas de confiança", () => {
  const rates = [
    { acquirer: "cielo", brand: "visa", product: "credit", installments_from: 1, installments_to: 1, rate_bp: 199, fixed_cents: 0, settle_days: 30 },
    { acquirer: "cielo", brand: "outros", product: "credit", installments_from: 1, installments_to: 12, rate_bp: 299, fixed_cents: 10, settle_days: 30 },
  ];
  assert.equal(rateFor(rates, "cielo", "visa", "credit", 1).rate_bp, 199);
  assert.equal(rateFor(rates, "cielo", "elo", "credit", 3).rate_bp, 299, "a bandeira \"outras\" vale para as não cadastradas");
  assert.equal(rateFor(rates, "rede", "visa", "credit", 1), null);
  assert.equal(expectedFee(10000n, 199, 0), 199n);
  assert.equal(expectedFee(33333n, 299, 10), 1007n);
  assert.equal(chargedRateBp(10000n, 249n), 249);
  assert.equal(nameMatch("PIX RECEBIDO MARIA DA SILVA", "Maria da Silva ME"), 1);
  assert.equal(nameMatch("TED JOSE", "Maria Souza"), 0);
  assert.ok(movementScore(0, 0) > movementScore(3, 0));
  assert.ok(titleScore(true, 0, 1) >= 90);
  assert.ok(titleScore(true, 30, 0) < 70);
  assert.equal(titleScore(false, 0, 1), 0);
  assert.ok(ruleMatches("TARIFA BANCÁRIA PACOTE", "tarifa bancaria"));
  assert.ok(!ruleMatches("PIX", "tarifa"));
  const base = { amountEqual: true, amountNear: false, days: 0, brandKnown: true, brandEqual: true, installmentsEqual: true, installmentEqual: true, productEqual: true, referenceEqual: false };
  assert.ok(cardScore(base) >= 90);
  assert.ok(cardScore({ ...base, installmentsEqual: false }) < cardScore(base) - 20);
  assert.equal(cardScore({ ...base, amountEqual: false }), 0);
});
