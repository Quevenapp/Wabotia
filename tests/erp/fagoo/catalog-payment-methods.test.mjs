// Formas de pagamento na fixture dupla:
// - subteste "formas de pagamento" de workers/erp-api/test/contacts-lane-sql.test.mjs;
// - workers/erp-api/test/financeiro-h-payment-defaults-sql.test.mjs (371), sem
//   as chamadas HTTP do Worker (f.call), que são a prova da rota.
// Fora: GRANT/RLS/SECURITY DEFINER (o motor não tem papéis do Postgres).
// erp_finance_payment_methods ainda não é portado: roda só no Postgres e o
// estado é espelhado. Mais um diferencial aleatório de formulário e ações.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

const METHOD = {
  description: "Dinheiro", payment_type: "01", condition: null, destination: "caixa", account_id: null, business_days: false,
  applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
  auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null,
  settlement_days: null,
};
/** Erro do domínio (código do Postgres) segue; divergência do diferencial ou erro sem código sobe. */
const domainError = (e) => {
  if (!e.code || e.code === "ERR_ASSERTION") throw e;
};
const fails = (promise, code) => assert.rejects(promise, (e) => e.code === code || e.message === code);

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

async function account(name, active = true) {
  const id = (await f.db.query("insert into erp_finance.account(name,kind,active) values($1,'bank',$2) returning id::text v", [name, active])).rows[0].v;
  await f.sync();
  return id;
}

test("formas de pagamento: sections by payment type, Forma padrão swapped atomically, Inativar, Excluir and roles", async () => {
  const acc = await account("Banco sintético");
  const save = (data, { id = null, version = 0, user = f.users.financeiro } = {}) =>
    f.rpc("erp_catalog_payment_method_save", { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_data: data });
  const card = (
    await save({
      ...METHOD, description: "Cartão de Crédito", payment_type: "03", destination: "contas", account_id: acc, applicable: "recebimentos",
      card_brand: "01", card_integration: "2", card_cnpj: "11.222.333/0001-81", fee_rate: "2.5", settlement_days: 30, condition: "30 60",
    })
  ).item;
  assert.deepEqual([card.card_cnpj, card.fee_rate, card.account_name, card.is_default], ["11222333000181", "2.5000", "Banco sintético", false]);
  for (const data of [
    { ...METHOD, card_brand: "01" }, { ...METHOD, interest_rate: "1" }, { ...METHOD, pix_integration: "sem" },
    { ...METHOD, destination: "ficha", account_id: acc }, { ...METHOD, payment_type: "03", card_cnpj: "11.222.333/0001-82" },
    { ...METHOD, fee_type: "aliquota", fee_fixed: "1" }, { ...METHOD, condition: "3 2 1" }, { ...METHOD, description: " " },
    { ...METHOD, extra: 1 },
  ])
    await fails(save(data), "22023");
  await fails(save(METHOD, { user: f.users.vendas }), "42501");
  const boleto = (await save({ ...METHOD, description: "Boleto Bancário", payment_type: "15", destination: "contas", interest_rate: "1", fine_rate: "2" })).item;
  const action = (item, act, user = f.users.admin) =>
    f.rpc("erp_catalog_payment_method_action", { p_user_id: user, p_id: item.id, p_expected_version: item.version, p_command_id: randomUUID(), p_action: act });
  const first = await action(card, "default");
  assert.equal(first.item.is_default, true);
  const second = await action(boleto, "default");
  assert.equal(second.item.is_default, true);
  assert.equal(second.previous_default, card.id);
  assert.equal(await f.scalar("select count(*)::int v from erp_catalog.payment_method where is_default"), 1);
  const off = await action(second.item, "inactivate");
  assert.deepEqual([off.item.active, off.item.is_default], [false, false]);
  const listed = await f.rpc("erp_catalog_payment_method_page", { p_user_id: f.users.vendas, p_applicable: "pagamentos" });
  assert.deepEqual(listed.items.map((i) => i.description), [], "Boleto is inactive and the card only receives");
  assert.deepEqual(
    (await f.rpc("erp_catalog_payment_method_page", { p_user_id: f.users.vendas, p_applicable: "recebimentos", p_active: null })).items.map((i) => i.description),
    ["Boleto Bancário", "Cartão de Crédito"],
  );
  assert.equal((await f.rpc("erp_catalog_payment_method_page", { p_user_id: f.users.consulta, p_account_id: acc })).items.length, 1);
  const removed = await action((await f.rpc("erp_catalog_payment_method_get", { p_user_id: f.users.admin, p_id: card.id })).item, "delete");
  assert.equal(removed.item, null);
  await fails(f.rpc("erp_catalog_payment_method_get", { p_user_id: f.users.admin, p_id: card.id }), "P0002");
  await fails(f.rpc("erp_catalog_payment_method_page", { p_user_id: f.users.estoque }), "42501");
  assert.equal(await f.scalar("select count(*)::int v from erp_catalog.auxiliary_audit where subject='payment_method'"), 6);
});

test("H 371: one default per purpose, kept to the purpose and to active formas; the gavetas mark the default of the kind", async () => {
  await f.db.query("update erp_catalog.payment_method set deleted_at=clock_timestamp(),deleted_by=$1,default_receipt=false,default_payment=false,default_return=false,is_default=false where deleted_at is null", [f.users.admin]);
  await f.sync();
  const DATA = { ...METHOD, destination: "contas" };
  delete DATA.description;
  delete DATA.applicable;
  const fail = (fn, code) => fails(fn(), code);
  const save = async (description, applicable) =>
    (await f.rpc("erp_catalog_payment_method_save", { p_user_id: f.users.financeiro, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { ...DATA, description, applicable } })).item;
  const act = async (method, action, user = f.users.financeiro) =>
    (await f.rpc("erp_catalog_payment_method_action", { p_user_id: user, p_id: method.id, p_expected_version: method.version, p_command_id: randomUUID(), p_action: action })).item;
  const get = async (id) => (await f.rpc("erp_catalog_payment_method_get", { p_user_id: f.users.consulta, p_id: id })).item;
  const flags = (m) => [m.is_default, m.default_receipt, m.default_payment, m.default_return];
  let pix = await save("Pix sintético", "ambos"),
    boleto = await save("Boleto sintético", "recebimentos"),
    ted = await save("TED sintética", "pagamentos");
  pix = await act(pix, "default_recebimentos");
  assert.deepEqual(flags(pix), [true, true, false, false], "is_default stays the default of recebimentos");
  ted = await act(ted, "default_pagamentos");
  boleto = await act(boleto, "default_devolucoes");
  boleto = await act(boleto, "default_recebimentos");
  pix = await get(pix.id);
  assert.deepEqual([flags(boleto), flags(pix)], [[true, true, false, true], [false, false, false, false]]);
  await fail(() => act(ted, "default_recebimentos"), "22023");
  await fail(() => act(ted, "default_devolucoes"), "22023");
  await fail(() => act(boleto, "default_pagamentos"), "22023");
  await fail(() => act(pix, "default_pagamentos", f.users.consulta), "42501");
  const kinds = async (kind) =>
    (await f.rpc("erp_finance_payment_methods", { p_user_id: f.users.consulta, p_kind: kind })).items.filter((i) => i.is_default).map((i) => i.description);
  assert.deepEqual([await kinds("receivable"), await kinds("payable")], [["Boleto sintético"], ["TED sintética"]]);
  boleto = await act(boleto, "clear_devolucoes");
  assert.deepEqual(flags(boleto), [true, true, false, false]);
  boleto = await act(boleto, "inactivate");
  assert.deepEqual(flags(boleto), [false, false, false, false]);
  await fail(() => act(boleto, "default_recebimentos"), "22023");
  pix = await act(pix, "default_pagamentos");
  ted = await get(ted.id);
  assert.equal(ted.default_payment, false);
  pix = (
    await f.rpc("erp_catalog_payment_method_save", {
      p_user_id: f.users.financeiro, p_id: pix.id, p_expected_version: pix.version, p_command_id: randomUUID(),
      p_data: { ...DATA, description: "Pix sintético", applicable: "recebimentos" },
    })
  ).item;
  assert.deepEqual(flags(pix), [false, false, false, false]);
  ted = await act(ted, "default");
  assert.deepEqual(flags(ted), [false, false, true, false]);
});

test("condições, taxas, CNPJ, recibo e argumentos batem nos dois motores", async () => {
  const save = (data, opts = {}) =>
    f.rpc("erp_catalog_payment_method_save", {
      p_user_id: opts.user ?? f.users.admin, p_id: opts.id ?? null, p_expected_version: opts.version ?? 0,
      p_command_id: opts.command ?? randomUUID(), p_data: data,
    });
  for (const condition of ["30 60 90", "30,60;90/120", "3x", "3 X", "15 + 2x", "15+2x", "0 x", "121x", "3651", "  ", "30　60", "30 60", "1 ".repeat(60)])
    await save({ ...METHOD, description: `Condição ${condition.length}`, condition }).catch((e) => assert.equal(e.code, "22023"));
  for (const v of ["100", "100.0001", "0.0001", "99.9999", "1.00000", "01"])
    await save({ ...METHOD, description: "Taxa", fee_rate: v }).catch((e) => assert.equal(e.code, "22023"));
  for (const cnpj of ["12.ABC.345/01DE-35", "12abc34501de35", "00.000.000/0000-00", "11222333000181"])
    await save({ ...METHOD, description: "Cartão", payment_type: "04", card_cnpj: cnpj }).catch((e) => assert.equal(e.code, "22023"));
  const command = randomUUID();
  const created = await save({ ...METHOD, description: "Recibo" }, { command });
  assert.equal((await save({ ...METHOD, description: "Recibo" }, { command })).replayed, true);
  await fails(save({ ...METHOD, description: "Outro" }, { command }), "40001");
  const again = await save({ ...METHOD, description: "Recibo" }, { id: created.item.id, version: 1 });
  assert.equal(again.item.version, 2, "o formulário sempre difere da ficha (default_*): o Fagoo sobe a versão");
  await fails(save(METHOD, { id: created.item.id, version: 1 }), "40001");
  await fails(save(METHOD, { id: randomUUID(), version: 1 }), "P0002");
  const inactive = await account("Conta inativa", false);
  await fails(save({ ...METHOD, destination: "contas", account_id: inactive }), "22023");
  await fails(save({ ...METHOD, destination: "contas", account_id: inactive.toUpperCase() }), "22023");
  await fails(f.rpc("erp_catalog_payment_method_action", { p_user_id: f.users.admin, p_id: created.item.id, p_expected_version: 2, p_command_id: randomUUID(), p_action: "padrao" }), "22023");
  await fails(f.rpc("erp_catalog_payment_method_page", { p_user_id: f.users.admin, p_applicable: "x" }), "22023");
});

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("diferencial aleatório: formulário, ações e listas", async () => {
  const r = rng(371);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const accounts = [await account("Ágil conta"), await account("banco B"), await account("Caixa"), await account("ágil 2", false)];
  const items = [];
  for (let i = 0; i < 90; i++) {
    const type = pick(["01", "03", "04", "15", "17", "20", "99", "07"]);
    const card = ["03", "04"].includes(type), pix = ["17", "20"].includes(type), boleto = type === "15";
    const destination = pick(["contas", "caixa", "ficha"]);
    const fee_type = pick(["aliquota", "fixa", "aliquota_fixa"]);
    const data = {
      ...METHOD,
      description: pick(["Pix", "Cartão Ágil", "boleto", "Dinheiro", "TED 2", "  Vale  ", "ﬁado"]) + " " + i,
      payment_type: type,
      condition: pick([null, "30 60", "3x", "10 + 3x", "", "60 30"]),
      destination,
      account_id: destination !== "ficha" && r() < 0.5 ? pick(accounts) : null,
      business_days: r() < 0.5,
      applicable: pick(["pagamentos", "recebimentos", "ambos"]),
      interest_rate: boleto && r() < 0.6 ? pick(["1", "2.5", "100"]) : null,
      fine_rate: boleto && r() < 0.6 ? pick(["0", "2.25"]) : null,
      card_brand: card && r() < 0.6 ? pick(["01", "99"]) : null,
      card_integration: card && r() < 0.5 ? pick(["1", "2"]) : null,
      card_cnpj: card && r() < 0.4 ? pick(["11.222.333/0001-81", "11222333000181"]) : null,
      auto_settle: card && r() < 0.3,
      pix_integration: pix && r() < 0.5 ? "sem" : null,
      pix_cnpj: pix && r() < 0.3 ? "11.222.333/0001-81" : null,
      fee_type,
      fee_rate: fee_type !== "fixa" && r() < 0.5 ? pick(["2.5", "0.0001"]) : null,
      fee_fixed: fee_type !== "aliquota" && r() < 0.5 ? pick(["1", "0.99", "10.5"]) : null,
      settlement_days: pick([null, 0, 30, 365, 366]),
    };
    const user = pick([f.users.admin, f.users.financeiro, f.users.financeiro, f.users.vendas]);
    if (items.length && r() < 0.45) {
      const it = pick(items);
      const out = await f
        .rpc("erp_catalog_payment_method_action", {
          p_user_id: user, p_id: it.id, p_expected_version: it.version, p_command_id: randomUUID(),
          p_action: pick(["default", "default_recebimentos", "default_pagamentos", "default_devolucoes", "clear_devolucoes", "activate", "inactivate", "delete"]),
        })
        .catch((e) => (domainError(e), null));
      if (out?.item) Object.assign(it, out.item);
      else if (out) items.splice(items.indexOf(it), 1);
    } else if (items.length && r() < 0.3) {
      const it = pick(items);
      const out = await f
        .rpc("erp_catalog_payment_method_save", { p_user_id: user, p_id: it.id, p_expected_version: it.version, p_command_id: randomUUID(), p_data: data })
        .catch((e) => (domainError(e), null));
      if (out) Object.assign(it, out.item);
    } else {
      const out = await f
        .rpc("erp_catalog_payment_method_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })
        .catch((e) => (domainError(e), null));
      if (out) items.push(out.item);
    }
  }
  assert.ok(items.length > 15, `poucas formas: ${items.length}`);
  for (let i = 0; i < 30; i++)
    await f.rpc("erp_catalog_payment_method_page", {
      p_user_id: pick([f.users.admin, f.users.consulta, f.users.vendas]),
      p_page: pick([1, 1, 2]),
      p_size: pick([3, 10, 100]),
      p_query: pick([null, "pix", "agil", "Ágil", "2", "vale 1", "fi"]),
      p_applicable: pick([null, "pagamentos", "recebimentos", "ambos"]),
      p_account_id: pick([null, null, ...accounts]),
      p_active: pick([true, false, null]),
    });
});
