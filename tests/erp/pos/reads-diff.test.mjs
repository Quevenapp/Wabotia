// PDV, bloco P1 (sessão L): as leituras e as configurações da frente de caixa nos dois
// motores, com os casos de borda que os testes do Fagoo não cobrem: filtros, busca e
// página da lista de vendas, recusas de consulta, papéis, chaves Pix, favoritos e o
// resumo do caixa com grupos de produto. A venda (erp_pos_sale_execute) ainda roda
// só no oráculo e é espelhada no SQLite; cada f.rpc de um RPC portado compara
// resposta e tabelas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { posLaneFixture, today } from "../fagoo/documents-lanes-fixture.mjs";

let f, sales, session;
before(async () => {
  f = await posLaneFixture();
  await f.receive(f.product.id, "50");
  await f.receive(f.other.id, "20");
  const version = Number(await f.scalar("select version v from erp_pos.settings"));
  await f.rpc("erp_pos_settings_execute", {
    p_user_id: f.users.admin,
    p_command_id: randomUUID(),
    p_action: "settings_save",
    p_data: { expected_version: version, consumer_contact_id: f.consumer.id, pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null },
  });
  // Grupo de produto para o resumo do caixa.
  const group = (await f.db.query("insert into erp_catalog.taxonomy(kind,name) values('product_groups','Papelaria sintética') returning id")).rows[0].id;
  await f.db.query(
    "insert into erp_catalog.product_detail(record_id,product_group_id) values($2,$1) on conflict(record_id) do update set product_group_id=excluded.product_group_id",
    [group, f.product.id],
  );
  await f.sync();
  session = (await f.rpc("erp_finance_cash_session_execute", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "session_open", p_data: { account_id: f.store.id, change_cents: "0" } })).record;
  const item = (p, quantity, price) => ({ id: randomUUID(), product_id: p.id, description: p.name, code: p.code ?? null, unit: "UN", quantity, unit_price: price, discount_percent: "0", detailed_description: null });
  const sale = (extra, items, cents, method = f.methods.dinheiro, action = "sale_finish") =>
    f.call(`/v1/frente-caixa/actions/${action}`, "POST", {
      command_id: randomUUID(),
      data: {
        sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: f.store.id, cash_session_id: null, contact_id: null, price_list_id: null,
        document: { date: today(), warehouse_id: f.warehouse.id, items, discount_mode: "amount", discount_value: "0", freight: "0", other_expenses: "0", notes: null, internal_notes: null, seller_id: null, category_id: null },
        payments: action === "sale_save" ? [] : [{ payment_method_id: method, days: 0, amount_cents: cents, note: null }],
        destination_account_id: null, to_ledger: false, cash_received_cents: null, ...extra,
      },
    });
  const done = async (r) => {
    assert.equal(r.status, 200, JSON.stringify(r.value));
    return r.value.record;
  };
  sales = [
    await done(await sale({ cash_session_id: session.id }, [item(f.product, "2", "10"), item(f.other, "1", "25.50")], "4550")),
    await done(await sale({ cash_session_id: session.id, contact_id: f.contact.id }, [item(f.service, "3", "5")], "1500", f.methods.pix)),
    await done(await sale({}, [item(f.product, "1", "10")], "1000", f.methods.cartao)),
    await done(await sale({}, [item(f.other, "1", "25.50")], null, null, "sale_save")),
  ];
});
after(() => f?.close());

const both = async (name, args) => {
  try {
    return { ok: await f.rpc(name, args) };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};

test("erp_pos_context por papel e para quem não opera", async () => {
  for (const user of [...Object.values(f.users), randomUUID(), null]) await both("erp_pos_context", { p_user_id: user });
  await f.setPreference("vendas-frente-caixa", "pdv.usuarios_caixa_unico", [f.users.admin]);
  try {
    for (const user of [f.users.admin, f.users.vendas]) await both("erp_pos_context", { p_user_id: user });
  } finally {
    await f.setPreference("vendas-frente-caixa", "pdv.usuarios_caixa_unico", []);
  }
});

test("erp_pos_sales: situação, página, período, forma, caixa, busca e recusas", async () => {
  const base = { p_user_id: f.users.consulta };
  const day = today();
  const cases = [
    {}, { p_state: "open" }, { p_state: "finished" }, { p_state: "cancelled" }, { p_state: "x" }, { p_state: null },
    { p_page: 2, p_limit: 1 }, { p_page: 3, p_limit: 2 }, { p_page: 0 }, { p_page: 10001 }, { p_limit: 51 }, { p_limit: 0 }, { p_page: null },
    { p_from: day }, { p_to: day }, { p_from: day, p_to: day }, { p_from: "2099-01-01" }, { p_from: day, p_to: "2000-01-01" }, { p_from: "1899-12-31" }, { p_to: "2101-01-01" },
    { p_method: f.methods.dinheiro }, { p_method: f.methods.pix }, { p_method: randomUUID() }, { p_session: session.id }, { p_session: randomUUID() },
    { p_query: "cliente" }, { p_query: "CLIENTE SINTÉTICO" }, { p_query: "  consumidor  " }, { p_query: "   " }, { p_query: "" }, { p_query: String(sales[0].number) },
    { p_query: "x".repeat(120) }, { p_query: "x".repeat(121) }, { p_query: "a\u0001b" }, { p_query: "a\u0085b" }, { p_query: "sintético" },
  ];
  for (const c of cases) await both("erp_pos_sales", { ...base, ...c });
  await both("erp_pos_sales", { p_user_id: f.users.estoque });
});

test("erp_pos_sale_get e erp_pos_order: venda existente, aberta, desconhecida e nula", async () => {
  for (const s of sales) {
    await both("erp_pos_sale_get", { p_user_id: f.users.financeiro, p_id: s.id });
    await both("erp_pos_order", { p_user_id: f.users.vendas, p_document_id: s.document_id });
  }
  for (const id of [randomUUID(), null]) {
    await both("erp_pos_sale_get", { p_user_id: f.users.admin, p_id: id });
    await both("erp_pos_order", { p_user_id: f.users.admin, p_document_id: id });
  }
  await both("erp_pos_sale_get", { p_user_id: f.users.fiscal, p_id: sales[0].id });
});

test("erp_pos_favorites e erp_pos_settings_execute: favoritos com e sem depósito, recusas e repetição", async () => {
  const act = (action, data, user = f.users.admin, command = randomUUID()) =>
    both("erp_pos_settings_execute", { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
  for (const p of [f.product, f.other, f.service]) await act("favorite_add", { product_id: p.id }, f.users.vendas);
  await act("favorite_add", { product_id: f.product.id.toUpperCase() });
  for (const data of [{ product_id: randomUUID() }, { product_id: "x" }, { product_id: null }, {}, { product_id: f.product.id, extra: 1 }, [], "x"])
    await act("favorite_add", data);
  for (const warehouse of [null, f.warehouse.id, randomUUID()]) await both("erp_pos_favorites", { p_user_id: f.users.consulta, p_warehouse_id: warehouse });
  await act("favorite_remove", { product_id: f.service.id });
  await act("favorite_remove", { product_id: randomUUID() });
  await both("erp_pos_favorites", { p_user_id: f.users.admin });
  await act("favorite_add", { product_id: f.other.id }, f.users.consulta);
  await act("other", { product_id: f.other.id });
  await act("favorite_add", { product_id: f.other.id, pad: "x".repeat(9000) });
  const command = randomUUID();
  await act("favorite_add", { product_id: f.other.id }, f.users.admin, command);
  await act("favorite_add", { product_id: f.other.id }, f.users.admin, command);
  await act("favorite_add", { product_id: f.product.id }, f.users.admin, command);
  await act("favorite_add", { product_id: f.other.id }, f.users.vendas, command);
});

test("erp_pos_settings_execute: cliente padrão e chave Pix de cada tipo, com versão e só o administrador", async () => {
  const version = async () => Number(await f.scalar("select version v from erp_pos.settings"));
  const save = async (extra, user = f.users.admin) =>
    both("erp_pos_settings_execute", {
      p_user_id: user,
      p_command_id: randomUUID(),
      p_action: "settings_save",
      p_data: { expected_version: await version(), consumer_contact_id: f.consumer.id, pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null, ...extra },
    });
  const pix = (type, key, name = "LOJA SINTETICA", city = "SAO PAULO") => ({ pix_key_type: type, pix_key: key, pix_merchant_name: name, pix_merchant_city: city });
  const cases = [
    pix("cpf", "12345678901"), pix("cpf", "1234567890"), pix("cnpj", "12345678000190"), pix("cnpj", "1234567800019"), pix("email", "pix@sintetico.test"),
    pix("email", "sem-arroba"), pix("email", "a b@c.d"), pix("email", "x".repeat(70) + "@a.b.c"), pix("phone", "+5511999999999"), pix("phone", "5511999999999"),
    pix("random", "123e4567-e89b-42d3-a456-426614174000"), pix("random", "123E4567-E89B-42D3-A456-426614174000"), pix("chave", "x"), pix(null, "x"), pix("cpf", null),
    pix("cpf", " 12345678901 "), pix("cpf", "12345678901", null), pix("cpf", "12345678901", "N".repeat(26)), pix("cpf", "12345678901", "LOJA", "C".repeat(16)),
    pix("cpf", "12345678901", "Lojinha ", "São Paulo"), pix("cpf", "12345678901", "a\u0001"), pix("cpf", 12345678901),
    { consumer_contact_id: null }, { consumer_contact_id: randomUUID() }, { consumer_contact_id: f.contact.id }, { consumer_contact_id: f.product.id }, { consumer_contact_id: "x" },
    { expected_version: 999 }, { expected_version: "1" }, { expected_version: -1 }, { expected_version: 1.5 }, { extra: 1 },
  ];
  for (const c of cases) await save(c);
  await save({}, f.users.vendas);
  const data = { expected_version: await version(), consumer_contact_id: f.consumer.id, pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null };
  const { pix_key: _k, ...missing } = data;
  await both("erp_pos_settings_execute", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "settings_save", p_data: missing });
  await both("erp_pos_settings_execute", { p_user_id: f.users.admin, p_command_id: null, p_action: "settings_save", p_data: data });
  await both("erp_pos_settings_execute", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: null, p_data: data });
  await both("erp_pos_context", { p_user_id: f.users.vendas });
});

test("erp_pos_cash_summary: situações, Dinheiro e Cheque, grupos e recusas", async () => {
  const summary = () => both("erp_pos_cash_summary", { p_user_id: f.users.financeiro, p_session: session.id });
  const first = await summary();
  // Dois grupos (o produto no grupo e o resto em "Sem grupo"), com percentual.
  assert.deepEqual(
    first.ok.groups.map((g) => g.name).sort(),
    ["Papelaria sintética", "Sem grupo"],
    JSON.stringify(first),
  );
  // A preferência só aceita lista não vazia de "atendido" e "verificado", na ordem das opções
  // (erp_preferences_input_invalid).
  for (const statuses of [["verificado"], ["atendido"]]) {
    await f.setPreference("vendas-frente-caixa", "pdv.situacoes_fechamento", statuses);
    await summary();
  }
  await f.setPreference("vendas-frente-caixa", "pdv.situacoes_fechamento", ["atendido", "verificado"]);
  await f.setPreference("vendas-frente-caixa", "pdv.dinheiro_cheque", true);
  try {
    await summary();
  } finally {
    await f.setPreference("vendas-frente-caixa", "pdv.dinheiro_cheque", false);
  }
  for (const s of [randomUUID(), null]) await both("erp_pos_cash_summary", { p_user_id: f.users.admin, p_session: s });
  await both("erp_pos_cash_summary", { p_user_id: f.users.estoque, p_session: session.id });
});
