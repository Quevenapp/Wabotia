// Depois da NF-e autorizada (versão 18): carta de correção, inutilização e
// devolução de venda no motor, com SQLite real e sem cofre (o serviço é
// testado em eventos-servico.test.mjs). Nenhuma rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE } from "./fixtures.mjs";
import { accessKey, authorizedResult, balance, connection, count, eventsFixture, returnKey, row } from "./eventos-fixture.mjs";
import { getStoredEmission, claimStoredCancellation, recordCancellationEvidence } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { buildReturnBody, correctionText } from "../../../src/erp/domains/fiscal/comnfe/events.ts";
import { nfeEventRules, returnCfop } from "../../../src/erp/commercial-nfe/events-contracts.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";

const error = message => e => e.message === message || e.message?.startsWith?.(message);
const events = f => f.rpc("erp_com1_events_get", { p_input: { emission_id: f.emission.id } });
// A montagem (eventsFixture) fica em eventos-fixture.mjs, compartilhada com o teste do serviço.

test("esquema: versão 18 cria as três tabelas dos eventos, só acréscimo", () => {
  assert.equal(ERP_DDL_VERSION, 18);
  assert.deepEqual(ERP_ENGINE_TABLES.filter(t => t.since === 18).map(t => t.table).sort(),
    ["erp_fiscal_vault__order_correction", "erp_fiscal_vault__order_return", "erp_fiscal_vault__void_range"]);
  assert.equal(ERP_ENGINE_TABLES.filter(t => t.since === 17).length, 0);
});

test("regras em palavras: prazo de cancelamento, carta depois de cancelada e devolução de nota cancelada", () => {
  const authorizedAt = String(Date.parse("2026-11-19T12:00:01Z") * 1000);
  const base = { model: "nfe", status: "autorizada", authorized_at: authorizedAt, corrections_registered: 0, corrections_in_flight: false, returnable: true };
  const inside = nfeEventRules({ ...base, now: BigInt(authorizedAt) + 3_600_000_000n });
  assert.equal(inside.cancel.allowed, true);
  const late = nfeEventRules({ ...base, now: BigInt(authorizedAt) + 25n * 3_600_000_000n });
  assert.equal(late.cancel.code, "nfe_cancel_deadline");
  assert.match(late.cancel.reason, /24 horas/);
  assert.match(late.cancel.reason, /devolução/);
  assert.equal(late.correction.allowed, true);
  const cancelled = nfeEventRules({ ...base, status: "cancelada", now: BigInt(authorizedAt) });
  assert.equal(cancelled.correction.code, "nfe_correction_cancelled");
  assert.match(cancelled.correction.reason, /cancelada/);
  assert.equal(cancelled.return.code, "nfe_return_cancelled");
  assert.equal(nfeEventRules({ ...base, corrections_registered: 20, now: BigInt(authorizedAt) }).correction.code, "nfe_correction_limit");
  assert.equal(nfeEventRules({ ...base, model: "nfce", now: 0n }).correction.code, "nfe_event_model");
  assert.equal(returnCfop("5102"), "1202");
  assert.equal(returnCfop("6102"), "2202");
  assert.equal(returnCfop("5405"), "1411");
  assert.equal(returnCfop("5933"), null);
});

test("carta de correção: texto de 15 a 1.000, uma linha, mesmo comando não gera duas cartas", t => {
  const f = eventsFixture(t, { effects: false });
  assert.throws(() => correctionText("curto demais"), error("nfe_correction_text_invalid"));
  assert.throws(() => correctionText("x".repeat(1001)), error("nfe_correction_text_invalid"));
  assert.equal(correctionText("  Endereço de entrega:\nRua das Acácias, 45  "), "Endereço de entrega: Rua das Acácias, 45");
  const command = randomUUID(), text = "Endereço de entrega: Rua das Acácias, 45, sala 2";
  const first = f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: command, text } });
  assert.equal(first.disposition, "send");
  assert.equal(first.correction.expected_sequence, 1);
  // Repetir o comando antes da resposta: retoma a mesma carta, sem outra linha.
  const again = f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: command, text } });
  assert.equal(again.disposition, "resume");
  assert.equal(again.correction.id, first.correction.id);
  assert.throws(() => f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: command, text: `${text} e mais` } }), error("fiscal_command_conflict"));
  // Outra carta enquanto esta não tem resposta: recusada em palavras.
  assert.throws(() => f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), text: "Outra correção qualquer do texto" } }), error("nfe_correction_in_flight"));
  const recorded = f.rpc("erp_com1_correction_record", { p_input: { correction_id: first.correction.id, command_id: command, state: "registrado", sequence: 1,
    protocol: "135260000000010", event_at: "2026-11-19T13:00:00Z" } });
  assert.equal(recorded.state, "registrado");
  assert.equal(recorded.sequence, 1);
  // Clique duplo com outro comando e o mesmo texto: devolve a carta já registrada.
  const dup = f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), text } });
  assert.equal(dup.disposition, "replay");
  assert.equal(dup.correction.id, first.correction.id);
  assert.equal(count(f, "erp_fiscal_vault__order_correction"), 1);
  const second = f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), text: `${text}; CEP 01001-000` } });
  assert.equal(second.correction.expected_sequence, 2);
  const view = events(f);
  assert.equal(view.corrections.length, 2);
  assert.equal(view.rules.correction.code, "nfe_correction_in_flight");
  // Registrada não muda de texto nem de sequência.
  assert.throws(() => f.db.exec("UPDATE erp_fiscal_vault__order_correction SET sequence=3 WHERE id=?", first.correction.id), /nfe_correction_immutable/);
  // Papel sem fiscal não envia carta.
  assert.throws(() => f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), text } }, { role: "estoque" }), error("fiscal_forbidden"));
});

test("carta de correção: nota cancelada recusa com o motivo", t => {
  const f = eventsFixture(t, { effects: false });
  const emission = f.transaction(ctx => getStoredEmission(ctx, f.emission.id));
  const c = f.transaction(ctx => claimStoredCancellation(ctx, { emission_id: emission.id, command_id: randomUUID(), expected_version: emission.version,
    justification: "Cancelamento do ensaio de eventos.", connection_fingerprint: connection }));
  f.transaction(ctx => recordCancellationEvidence(ctx, { emission_id: emission.id, command_id: c.command.id, claim_token: c.command.token,
    connection_fingerprint: connection, state: "registrado", result: authorizedResult(emission.reference, { status: "cancelled" }),
    event_protocol: "135260000000099", event_at: "1795089660000000" }));
  const view = events(f);
  assert.equal(view.rules.correction.code, "nfe_correction_cancelled");
  assert.equal(view.rules.return.code, "nfe_return_cancelled");
  assert.throws(() => f.rpc("erp_com1_correction_claim", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), text: "Correção depois de cancelada" } }), error("nfe_correction_cancelled"));
  assert.throws(() => f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "1" }], finance_option: "credito" } }), error("nfe_return_cancelled"));
});

test("inutilização: faixa, justificativa, repetição e número já usado", t => {
  const f = eventsFixture(t, { effects: false });
  const input = (changes = {}) => ({ command_id: randomUUID(), model: "nfe", environment: "homologacao", series: 1, first: 10, last: 12,
    justification: "Números pulados por falha no sistema anterior", ...changes });
  assert.throws(() => f.rpc("erp_com1_void_claim", { p_input: input({ justification: "curta" }) }), error("nfe_void_justification_invalid"));
  assert.throws(() => f.rpc("erp_com1_void_claim", { p_input: input({ first: 12, last: 10 }) }), error("nfe_void_range_invalid"));
  // A nota autorizada usa o número 1 da série 1.
  assert.throws(() => f.rpc("erp_com1_void_claim", { p_input: input({ first: 1, last: 3 }) }), error("nfe_void_number_used"));
  const value = input(), claim = f.rpc("erp_com1_void_claim", { p_input: value });
  assert.equal(claim.disposition, "send");
  assert.equal(f.rpc("erp_com1_void_claim", { p_input: value }).void.id, claim.void.id);
  const done = f.rpc("erp_com1_void_record", { p_input: { void_id: claim.void.id, command_id: value.command_id, state: "registrado", provider_ref: "inut_1", protocol: "135260000000020" } });
  assert.equal(done.state, "registrado");
  assert.equal(f.rpc("erp_com1_void_claim", { p_input: value }).disposition, "replay");
  assert.equal(f.rpc("erp_com1_void_list", { p_input: { environment: "homologacao" } }).items.length, 1);
  assert.equal(count(f, "erp_fiscal_vault__void_range"), 1);
});

test("devolução: corpo com finalidade devolução, nota referenciada, entrada e CFOP de devolução, valores proporcionais", t => {
  const f = eventsFixture(t, { effects: false });
  const emission = f.transaction(ctx => getStoredEmission(ctx, f.emission.id));
  const view = f.rpc("erp_com1_get", { p_input: { emission_id: emission.id } });
  const built = buildReturnBody(view, [{ item: 0, quantity: 10000n }], "wb.00000000-0000-4000-8000-000000000001.v1");
  assert.equal(built.body.finalidade, "devolucao");
  assert.equal(built.body.tipo, "entrada");
  assert.equal(built.body.naturezaOperacao, "Devolução de venda");
  assert.deepEqual(built.body.notasReferenciadas, [accessKey]);
  assert.equal(built.body.itens[0].cfop, "1202");
  assert.equal(built.body.itens[0].quantidade, 1);
  assert.equal(built.body.itens[0].valorTotal, 25.5);
  assert.equal(built.body.itens[0].impostos.cofins.baseCalculo, 25.5);
  assert.equal(built.body.itens[0].impostos.cofins.aliquota, 3);
  assert.equal(built.body.itens[0].impostos.cofins.valor, 0.77);
  assert.deepEqual(built.body.pagamentos, [{ forma: "90", valor: 0 }]);
  assert.equal(built.total, 2550n);
});

test("devolução parcial: estoque volta e conta em aberto é abatida, sem efeito duplicado se o aviso do cofre chegar duas vezes", t => {
  const f = eventsFixture(t);
  assert.equal(balance(f), "98.000000");
  const command = randomUUID();
  const prepared = f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: command, items: [{ item: 0, quantity: "1" }], finance_option: "credito" } });
  assert.equal(prepared.status, "preparada");
  assert.equal(prepared.total, "2550");
  // Mesmo comando: a mesma devolução.
  assert.equal(f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: command, items: [{ item: 0, quantity: "1" }], finance_option: "credito" } }).id, prepared.id);
  // Mais do que sobra (2 - 1 em andamento): recusado.
  assert.throws(() => f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "1.5" }], finance_option: "credito" } }), error("nfe_return_quantity_exceeded"));
  const claim = f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } });
  assert.equal(claim.disposition, "send");
  const body = JSON.parse(claim.body_text);
  assert.equal(body.referencia, prepared.reference);
  const result = authorizedResult(prepared.reference, { provider_ref: "nfe_devolucao", number: 2, access_key: returnKey, protocol: "135260000000030", total: 25.5 });
  const recordInput = { return_id: prepared.id, command_id: claim.return.command_id, result };
  assert.equal(f.rpc("erp_com1_return_record", { p_input: recordInput }).status, "autorizada");
  // Aviso repetido: nada muda.
  assert.equal(f.rpc("erp_com1_return_record", { p_input: recordInput }).status, "autorizada");
  const effect = axis => f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis } });
  assert.equal(effect("stock").stock.state, "aplicado");
  assert.equal(balance(f), "99.000000");
  const finance = effect("finance").finance;
  assert.equal(finance.state, "aplicado", JSON.stringify(finance.result));
  assert.equal(finance.result.abated[0].amount_cents, "2550");
  assert.equal(finance.result.payable, null);
  // Segundo aviso do cofre (e clique duplo): estoque e contas não mudam de novo.
  effect("stock"); effect("finance");
  assert.equal(balance(f), "99.000000");
  assert.equal(count(f, "erp_finance__settlement"), 1);
  const title = row(f, "SELECT CAST(amount_cents AS TEXT) a, CAST(settled_cents AS TEXT) s FROM erp_finance__title WHERE id=?", finance.result.abated[0].title_id);
  assert.deepEqual([title.a, title.s], ["5100", "2550"]);
  const view = events(f);
  assert.equal(view.lines[0].returned, "1");
  assert.equal(view.lines[0].remaining, "1");
  assert.throws(() => f.db.exec("UPDATE erp_fiscal_vault__order_return SET stock_state='pendente' WHERE id=?", prepared.id), /nfe_return_immutable/);
});

test("devolução de nota já recebida: o restante vira crédito do cliente ou conta a pagar, conforme a escolha", t => {
  for (const option of ["credito", "pagar"]) {
    const f = eventsFixture(t);
    const titleId = JSON.parse(row(f, "SELECT ids FROM erp_fiscal_vault__order_effect WHERE emission_id=? AND axis='finance'", f.emission.id).ids).title_ids[0];
    const title = row(f, "SELECT version FROM erp_finance__title WHERE id=?", titleId);
    f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: titleId, expected_version: title.version, account_id: f.account.id,
      posted_on: COM1_DATE, principal_cents: "5100" } });
    const prepared = f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "2" }], finance_option: option } });
    const claim = f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } });
    f.rpc("erp_com1_return_record", { p_input: { return_id: prepared.id, command_id: claim.return.command_id,
      result: authorizedResult(prepared.reference, { provider_ref: `nfe_dev_${option}`, number: 2, access_key: returnKey, protocol: "135260000000031" }) } });
    const finance = f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "finance" } }).finance;
    assert.equal(finance.state, "aplicado", JSON.stringify(finance.result));
    assert.deepEqual(finance.result.abated, []);
    assert.equal(finance.result.payable.kind, option);
    assert.equal(finance.result.payable.amount_cents, "5100");
    const payable = row(f, "SELECT kind,description,CAST(amount_cents AS TEXT) a FROM erp_finance__title WHERE id=?", finance.result.payable.title_ids[0]);
    assert.equal(payable.kind, "payable");
    assert.equal(payable.a, "5100");
    assert.match(payable.description, option === "credito" ? /^Crédito do cliente/ : /^Devolução a pagar/);
    f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "finance" } });
    assert.equal(count(f, "erp_finance__title", "kind='payable'"), 1);
  }
});

test("devolução: efeitos respeitam papel e parte desligada (pendente com o motivo)", t => {
  const f = eventsFixture(t);
  const prepared = f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "2" }], finance_option: "pagar" } });
  const claim = f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } });
  f.rpc("erp_com1_return_record", { p_input: { return_id: prepared.id, command_id: claim.return.command_id,
    result: authorizedResult(prepared.reference, { provider_ref: "nfe_dev_papel", number: 2, access_key: returnKey, protocol: "135260000000032" }) } });
  const fiscal = f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "stock" } }, { role: "fiscal" });
  assert.equal(fiscal.stock.state, "pendente");
  assert.equal(fiscal.stock.result.reason, "local_role_required");
  const off = f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "finance" } }, { parts: { finance: false, billing: false } });
  assert.equal(off.finance.state, "pendente");
  assert.equal(off.finance.result.reason, "part_disabled");
  assert.equal(f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "stock" } }).stock.state, "aplicado");
  assert.equal(balance(f), "100.000000");
});

test("devolução: sem efeito da venda, estoque e contas ficam pulados com a explicação", t => {
  const f = eventsFixture(t, { effects: false });
  const prepared = f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "2" }], finance_option: "credito" } });
  const claim = f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } });
  f.rpc("erp_com1_return_record", { p_input: { return_id: prepared.id, command_id: claim.return.command_id,
    result: authorizedResult(prepared.reference, { provider_ref: "nfe_dev_sem", number: 2, access_key: returnKey, protocol: "135260000000033" }) } });
  const stock = f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "stock" } }).stock;
  assert.equal(stock.state, "pulado");
  assert.equal(stock.result.reason, "sale_without_stock_posting");
  const finance = f.rpc("erp_com1_return_effects", { p_input: { return_id: prepared.id, command_id: randomUUID(), axis: "finance" } }).finance;
  assert.equal(finance.state, "pulado");
  // Tudo devolvido: a regra explica.
  assert.equal(events(f).rules.return.code, "nfe_return_nothing_left");
});

test("devolução: resultado de outra referência é recusado e rejeição libera as quantidades", t => {
  const f = eventsFixture(t, { effects: false });
  const prepared = f.rpc("erp_com1_return_prepare", { p_input: { emission_id: f.emission.id, command_id: randomUUID(), items: [{ item: 0, quantity: "2" }], finance_option: "credito" } });
  const claim = f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } });
  assert.throws(() => f.rpc("erp_com1_return_record", { p_input: { return_id: prepared.id, command_id: claim.return.command_id, result: authorizedResult("wb.outra.v1") } }), error("fiscal_result_mismatch"));
  f.rpc("erp_com1_return_record", { p_input: { return_id: prepared.id, command_id: claim.return.command_id,
    result: authorizedResult(prepared.reference, { status: "rejected", access_key: null, protocol: null, number: 0, messages: [{ code: "539", description: "Duplicidade" }] }) } });
  assert.equal(events(f).returns[0].status, "rejeitada");
  assert.equal(events(f).lines[0].remaining, "2");
  assert.equal(f.rpc("erp_com1_return_claim", { p_input: { return_id: prepared.id, command_id: randomUUID() } }).disposition, "send");
});
