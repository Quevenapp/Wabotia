// Início: gráficos, favoritos, notificações e produtos a vencer, na fixture dupla. Adaptados do Fagoo:
// - home-company-c-sql.test.mjs: "189 home charts…" e "189 favorites…" (sem os f.migrate: o oráculo já tem o catálogo 305);
// - system-profile-sql.test.mjs: "151 Notificações…";
// - notifications-c-sql.test.mjs: "187 daily notifications…", "187 Produtos próximos da validade…" e "187 Certificado A1…".
// SQL direto (títulos, validade, custódia do A1, papel) passa pela cópia (f.sync).
// Fora, declarados: GRANT/has_function_privilege; as escritas diretas que provam os gatilhos de imutabilidade e o CHECK de
// tipo da notificação (no motor as linhas só mudam pelos RPCs); committedBlock/generatedBlock (gerador do Fagoo).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import {
  parseHomeCharts,
  parseHomeChartsResult,
  captureHomeChartsSave,
  parseNotifications,
  parseExpiring,
  captureNotificationsQuery,
  parseNotificationsRead,
  captureNotificationsRead,
} from "../../../src/erp/fagoo/packages/erp-domain/src/system-profile.mjs";
import { homeShortcutsResponse, homeShortcutBase } from "../../../src/erp/fagoo/workers/erp-api/src/home.mjs";

const fails = (assert, fn, code) => assert.rejects(fn, (e) => e.code === code);
const write = async (f, sql, args = []) => {
  await f.db.query(sql, args);
  await f.sync();
};
/** Grava uma preferência da empresa pela versão atual (o f.preference das fixtures do Fagoo). */
async function preference(f, page, key, value) {
  const current = (await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page })).items.find((i) => i.key === key);
  return f.rpc("erp_preferences_save", {
    p_user_id: f.users.admin,
    p_command_id: randomUUID(),
    p_page: page,
    p_changes: [{ key, expected_version: current.version, value }],
  });
}
const day = async (f, offset = 0) => f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date+$1::integer)::text v", [offset]);

test("189 home charts: Origin defaults, per user list with CAS and replay, Top 5 only for readers of sales orders and products, audited", async () => {
  const f = await dualFixture();
  try {
    const charts = async (user, body) => {
      const sent = captureHomeChartsSave(body);
      return parseHomeChartsResult(
        await f.rpc("erp_home_charts_save", { p_user_id: user, p_command_id: sent.command_id, p_expected_version: sent.expected_version, p_charts: sent.charts }),
        sent,
      );
    };
    const start = parseHomeCharts(await f.rpc("erp_home_charts_get", { p_user_id: f.users.vendas }));
    assert.deepEqual([start.version, start.customized, start.charts], [0, false, ["resumo", "ticket_medio", "valor_faturado", "quantidade_pedidos", "top_skus"]]);
    const finance = parseHomeCharts(await f.rpc("erp_home_charts_get", { p_user_id: f.users.financeiro }));
    assert.deepEqual(finance.available, ["resumo", "ticket_medio", "valor_faturado", "quantidade_pedidos"]);
    const body = { command_id: randomUUID(), expected_version: 0, charts: ["top_skus", "resumo"] };
    const saved = await charts(f.users.vendas, body);
    assert.deepEqual([saved.version, saved.charts, saved.replayed], [1, ["top_skus", "resumo"], false]);
    assert.equal((await charts(f.users.vendas, body)).replayed, true);
    await fails(assert, () => charts(f.users.vendas, { command_id: randomUUID(), expected_version: 0, charts: ["resumo"] }), "40001");
    await fails(assert, () => charts(f.users.financeiro, { command_id: randomUUID(), expected_version: 0, charts: ["top_skus"] }), "42501");
    await fails(assert, () => f.rpc("erp_home_charts_save", { p_user_id: f.users.vendas, p_command_id: randomUUID(), p_expected_version: 1, p_charts: ["resumo", "resumo"] }), "22023");
    await fails(assert, () => f.rpc("erp_home_charts_save", { p_user_id: f.users.inactive, p_command_id: randomUUID(), p_expected_version: 0, p_charts: [] }), "42501");
    for (const bad of [{ p_charts: ["x"] }, { p_charts: [1] }, { p_charts: {} }, { p_expected_version: -1 }, { p_charts: ["resumo", "ticket_medio", "valor_faturado", "quantidade_pedidos", "top_skus", "resumo"] }])
      await fails(assert, () => f.rpc("erp_home_charts_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_expected_version: 0, p_charts: ["resumo"], ...bad }), "22023");
    // Another user keeps the defaults; the audit is the one of the favorites (Registro de atividades: Página inicial).
    assert.equal(parseHomeCharts(await f.rpc("erp_home_charts_get", { p_user_id: f.users.admin })).version, 0);
    assert.deepEqual((await f.db.query("select after_data->'charts' v from erp_home.shortcut_audit where after_data?'charts'")).rows.map((r) => r.v), [["top_skus", "resumo"]]);
    const second = await charts(f.users.vendas, { command_id: randomUUID(), expected_version: 1, charts: [] });
    assert.deepEqual([second.version, second.charts], [2, []]);
  } finally {
    await f.close();
  }
});

test("189 favorites with Nome and Link: a menu screen with more filters, named; unknown screens, repeated keys and other roles refused", async () => {
  const f = await dualFixture();
  try {
    const link = "/documentos-empresa?tipo=sales_orders&situacao=open";
    assert.equal(homeShortcutBase(link), "/documentos-empresa?tipo=sales_orders");
    const start = await f.rpc("erp_home_shortcuts_get", { p_user_id: f.users.vendas });
    assert.deepEqual([start.version, start.customized], [0, false]);
    for (const bad of ["/documentos-empresa?tipo=sales_orders&tipo=purchase_orders", "/documentos-empresa?tipo=sales_orders&x=<script>", "/inexistente?x=1", "/estoque-empresa?a=1&a=2"]) {
      assert.equal(homeShortcutBase(bad), null, bad);
      await fails(assert, () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_expected_version: 0, p_shortcuts: [bad] }), "22023");
    }
    const operation = { type: "save", args: { p_expected_version: 0, p_shortcuts: ["/estoque-empresa", link], p_labels: { [link]: "Vendas em aberto" } } };
    const command = randomUUID();
    const saved = await f.rpc("erp_home_shortcuts_save", {
      p_user_id: f.users.vendas,
      p_command_id: command,
      p_expected_version: 0,
      p_shortcuts: ["/estoque-empresa", link],
      p_labels: { [link]: "Vendas em aberto" },
    });
    assert.deepEqual(homeShortcutsResponse(saved, operation).labels, { [link]: "Vendas em aberto" });
    const again = await f.rpc("erp_home_shortcuts_save", {
      p_user_id: f.users.vendas,
      p_command_id: command,
      p_expected_version: 0,
      p_shortcuts: ["/estoque-empresa", link],
      p_labels: { [link]: "Vendas em aberto" },
    });
    assert.equal(again.replayed, true);
    await fails(assert, () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.vendas, p_command_id: command, p_expected_version: 0, p_shortcuts: ["/estoque-empresa"] }), "40001");
    const read = homeShortcutsResponse(await f.rpc("erp_home_shortcuts_get", { p_user_id: f.users.vendas }), { type: "get" });
    assert.deepEqual([read.shortcuts, read.labels], [["/estoque-empresa", link], { [link]: "Vendas em aberto" }]);
    // Without names the command is the one of 097: the worker sends no p_labels.
    const plain = await f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_expected_version: 0, p_shortcuts: ["/estoque-empresa"] });
    assert.deepEqual(plain.labels, {});
    await fails(
      assert,
      () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.vendas, p_command_id: randomUUID(), p_expected_version: 1, p_shortcuts: [link], p_labels: { "/estoque-empresa": "Fora da lista" } }),
      "22023",
    );
    await fails(assert, () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.vendas, p_command_id: randomUUID(), p_expected_version: 1, p_shortcuts: [link], p_labels: { [link]: " x" } }), "22023");
    await fails(assert, () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.vendas, p_command_id: randomUUID(), p_expected_version: 0, p_shortcuts: [link] }), "40001");
    await fails(
      assert,
      () => f.rpc("erp_home_shortcuts_save", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_expected_version: 0, p_shortcuts: ["/estoque-empresa?produto=1"] }),
      "42501",
    );
    // A role that loses the screen no longer sees the favorite nor its name.
    await f.rpc("erp_home_shortcuts_save", {
      p_user_id: f.users.estoque,
      p_command_id: randomUUID(),
      p_expected_version: 0,
      p_shortcuts: ["/estoque-empresa?deposito=principal"],
      p_labels: { "/estoque-empresa?deposito=principal": "Depósito principal" },
    });
    await write(f, "update erp_access.membership set role='financeiro' where user_id=$1", [f.users.estoque]);
    const hidden = await f.rpc("erp_home_shortcuts_get", { p_user_id: f.users.estoque });
    assert.deepEqual([hidden.shortcuts, hidden.labels], [[], {}]);
    assert.deepEqual(
      (await f.db.query("select after_data->'labels' v from erp_home.shortcut_audit where after_data->'labels'<>'{}'::jsonb order by id")).rows.map((r) => r.v),
      [{ [link]: "Vendas em aberto" }, { "/estoque-empresa?deposito=principal": "Depósito principal" }],
    );
    await fails(assert, () => f.rpc("erp_home_shortcuts_get", { p_user_id: f.users.inactive }), "42501");
  } finally {
    await f.close();
  }
});

test("151 Notificações: one digest per type and day for the recipients who read the module; marking read is a recorded command", async () => {
  const f = await dualFixture();
  try {
    const today = await day(f),
      c = await f.catalog("contacts", { name: "Cliente atrasado" });
    await write(
      f,
      "insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents) values($1,1,1,'receivable',$2,'Título sintético',$3::date-30,$3::date-5,15000,2500),($4,1,1,'payable',$2,'Conta sintética',$3::date-30,$3::date-1,1000,0),($5,1,1,'receivable',$2,'Em dia',$3::date,$3::date+5,500,0)",
      [randomUUID(), c.id, today, randomUUID(), randomUUID()],
    );
    const p = await f.catalog("products", { name: "Caneta mínima", code: "MIN-1", unit: "UN", kind: "P", format: "S", price: "1", stock_min: "5" });
    let d = (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin,
        p_kind: "sales_proposals",
        p_id: null,
        p_expected_version: 0,
        p_command_id: randomUUID(),
        p_body: { date: today, contact_id: c.id, next_contact: today, items: [{ unit: "UN", product_id: p.id, description: "Caneta mínima", quantity: "1", unit_price: "1" }] },
      })
    ).document;
    d = (
      await f.rpc("erp_document_transition", {
        p_user_id: f.users.admin,
        p_kind: d.kind,
        p_id: d.id,
        p_expected_version: d.version,
        p_command_id: randomUUID(),
        p_status: "open",
        p_reason: "Transição sintética",
      })
    ).document;
    const admin = parseNotifications(await f.rpc("erp_home_notifications", { p_user_id: f.users.admin, p_tab: "nao_lidas" }), { tab: "nao_lidas" });
    assert.deepEqual(admin.items.map((n) => [n.type, n.quantity, n.amount]).sort(), [
      ["contas_pagar_atrasadas", 1, "10.00"],
      ["contas_receber_atrasadas", 1, "125.00"],
      ["estoque_abaixo_minimo", 1, null],
      ["proximo_contato", 1, null],
    ]);
    assert.equal(admin.unread, 4);
    // Opening again the same day does not create more; consulta is not a recipient until the Central lists it.
    assert.equal((await f.rpc("erp_home_notifications", { p_user_id: f.users.admin, p_tab: "todas" })).items.length, 4);
    assert.equal((await f.rpc("erp_home_notifications", { p_user_id: f.users.consulta, p_tab: "nao_lidas" })).items.length, 0);
    await preference(f, "central-notificacoes", "notificacoes.contas_receber_atrasadas", [f.users.vendas, f.users.consulta].sort());
    assert.deepEqual((await f.rpc("erp_home_notifications", { p_user_id: f.users.consulta, p_tab: "nao_lidas" })).items.map((n) => n.type), ["contas_receber_atrasadas"]);
    assert.equal((await f.rpc("erp_home_notifications", { p_user_id: f.users.vendas, p_tab: "nao_lidas" })).items.length, 0, "vendas does not read finanças");
    // Marking one, then all; the same command replays; another body under the same id conflicts.
    const one = captureNotificationsRead({ command_id: randomUUID(), ids: [admin.items[0].id] });
    const r1 = parseNotificationsRead(await f.rpc("erp_home_notifications_read", { p_user_id: f.users.admin, p_command_id: one.command_id, p_ids: one.ids }), one);
    assert.equal(r1.receipt.marked, 1);
    assert.equal(r1.view.unread, 3);
    assert.equal((await f.rpc("erp_home_notifications_read", { p_user_id: f.users.admin, p_command_id: one.command_id, p_ids: one.ids })).replayed, true);
    await fails(assert, () => f.rpc("erp_home_notifications_read", { p_user_id: f.users.admin, p_command_id: one.command_id, p_ids: null }), "40001");
    const all = captureNotificationsRead({ command_id: randomUUID(), ids: null });
    const r2 = parseNotificationsRead(await f.rpc("erp_home_notifications_read", { p_user_id: f.users.admin, p_command_id: all.command_id, p_ids: null }), all);
    assert.deepEqual([r2.receipt.marked, r2.view.unread], [3, 0]);
    await fails(assert, () => f.rpc("erp_home_notifications_read", { p_user_id: f.users.consulta, p_command_id: randomUUID(), p_ids: [admin.items[1].id] }), "P0002");
    await fails(assert, () => f.rpc("erp_home_notifications", { p_user_id: f.users.admin, p_tab: "x" }), "22023");
    for (const ids of [[], ["0"], [1], {}, ["01"]])
      await fails(assert, () => f.rpc("erp_home_notifications_read", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_ids: ids }), "22023");
    await fails(assert, () => f.rpc("erp_home_notifications", { p_user_id: f.users.inactive, p_tab: "todas" }), "42501");
  } finally {
    await f.close();
  }
});

async function product(f, name, offset) {
  const p = await f.catalog("products", { name, unit: "UN", kind: "P", format: "S", price: "10" });
  if (offset !== null)
    await write(
      f,
      "insert into erp_catalog.product_detail(record_id,expiry_date) values($1,$2::date) on conflict(record_id) do update set expiry_date=excluded.expiry_date",
      [p.id, await day(f, offset)],
    );
  return p;
}
const bell = async (f, user) => parseNotifications(await f.rpc("erp_home_notifications", { p_user_id: user, p_tab: "todas" }), captureNotificationsQuery({ aba: "todas" }));

test("187 daily notifications: products expiring within the days of Configurações de produtos and contacts to visit today, to the right roles", async () => {
  const f = await dualFixture();
  try {
    await preference(f, "cadastros-produtos", "produtos.dias_aviso_validade", 10);
    await product(f, "Iogurte sintético", 5);
    await product(f, "Leite sintético", 0);
    await product(f, "Queijo vencido", -3);
    await product(f, "Arroz distante", 40);
    await product(f, "Sem validade", null);
    const removed = await product(f, "Excluído sintético", 2);
    await f.rpc("erp_catalog_product_set_deleted", { p_user_id: f.users.admin, p_id: removed.id, p_expected_version: removed.version, p_command_id: randomUUID(), p_deleted: true });
    const contact = await f.catalog("contacts", { name: "Cliente a visitar" });
    await write(f, "insert into erp_catalog.contact_profile(record_id,next_visit) values($1,$2::date) on conflict(record_id) do update set next_visit=excluded.next_visit", [
      contact.id,
      await day(f),
    ]);
    const admin = await bell(f, f.users.admin);
    const byType = Object.fromEntries(admin.items.map((n) => [n.type, n]));
    assert.equal(byType.validade.quantity, 2, "only today .. today+10, active and not deleted");
    assert.equal(byType.validade.amount, null);
    assert.equal(byType.cliente_visitado.quantity, 1);
    // Recipients: nobody chosen means the administradores; a chosen recipient who reads the module receives it.
    await preference(f, "central-notificacoes", "notificacoes.validade", [f.users.estoque, f.users.financeiro].sort());
    assert.ok((await bell(f, f.users.estoque)).items.some((n) => n.type === "validade"));
    assert.ok(!(await bell(f, f.users.financeiro)).items.some((n) => n.type === "validade"), "financeiro does not read products");
    assert.ok(!(await bell(f, f.users.vendas)).items.some((n) => n.type === "cliente_visitado"), "not a chosen recipient");
    await preference(f, "central-notificacoes", "notificacoes.cliente_visitado", [f.users.financeiro]);
    assert.ok((await bell(f, f.users.financeiro)).items.some((n) => n.type === "cliente_visitado"));
    // Once per type and day.
    await bell(f, f.users.admin);
    assert.equal(await f.scalar("select count(*)::integer v from erp_home.notification where user_id=$1 and type='validade'", [f.users.admin]), 1);
  } finally {
    await f.close();
  }
});

test("187 Produtos próximos da validade on the home: expired included, earliest first, at most 20 with the total, product readers only", async () => {
  const f = await dualFixture();
  try {
    const empty = parseExpiring(await f.rpc("erp_home_expiring", { p_user_id: f.users.admin }));
    assert.deepEqual([empty.days, empty.total, empty.items], [0, 0, []]);
    await preference(f, "cadastros-produtos", "produtos.dias_aviso_validade", 7);
    await product(f, "Iogurte sintético", 5);
    await product(f, "Queijo vencido", -3);
    await product(f, "Leite sintético", 0);
    await product(f, "Arroz distante", 8);
    for (let i = 0; i < 20; i++) await product(f, `Lote sintético ${String(i).padStart(2, "0")}`, 6);
    const v = parseExpiring(await f.rpc("erp_home_expiring", { p_user_id: f.users.vendas }));
    assert.equal(v.days, 7);
    assert.equal(v.total, 23);
    assert.equal(v.items.length, 20);
    assert.deepEqual(v.items.slice(0, 3).map((p) => [p.name, p.expired]), [
      ["Queijo vencido", true],
      ["Leite sintético", false],
      ["Iogurte sintético", false],
    ]);
    assert.equal(v.business_date, await day(f));
    for (const role of ["financeiro", "inactive"]) await fails(assert, () => f.rpc("erp_home_expiring", { p_user_id: f.users[role] }), "42501");
    // The contract refuses an item past the limit or out of order.
    const raw = await f.rpc("erp_home_expiring", { p_user_id: f.users.admin });
    assert.throws(() => parseExpiring({ ...raw, items: [...raw.items].reverse() }));
    assert.throws(() => parseExpiring({ ...raw, days: 0 }));
  } finally {
    await f.close();
  }
});

// The A1 in custody, written straight into the tables of 041 (only the validity of the metadata matters here).
async function custody(f, notAfter) {
  const id = randomUUID(),
    hash = randomUUID().replace(/-/g, "").repeat(2);
  await f.db.query(
    "insert into erp_a1.credential(id,context,metadata,actor) values($1,'{}'::jsonb,jsonb_build_object('not_before','2026-01-01T00:00:00Z','not_after',$2::text),$3)",
    [id, notAfter, f.users.admin],
  );
  await f.db.query("insert into erp_a1.sealed_object(hash,credential_id,size_bytes,key_id) values($1,$2,10,'k1')", [hash, id]);
  await write(f, "update erp_a1.head set version=version+1,credential_id=$1,object_hash=$2", [id, hash]);
}
const notAfter = async (f, offset) =>
  f.scalar(
    "select to_char((((clock_timestamp() at time zone 'America/Sao_Paulo')::date+$1::integer)::timestamp+interval '12 hours') at time zone 'America/Sao_Paulo' at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') v",
    [offset],
  );
test("187 Certificado A1 próximo do vencimento: within 30 days or already ended, only to administrador and fiscal", async () => {
  const f = await dualFixture();
  try {
    const types = async (user) => (await bell(f, user)).items.map((n) => n.type);
    await custody(f, await notAfter(f, 45));
    assert.ok(!(await types(f.users.fiscal)).includes("certificado_a1"), "45 days away");
    await custody(f, await notAfter(f, 30));
    const admin = (await bell(f, f.users.admin)).items.find((n) => n.type === "certificado_a1");
    assert.deepEqual([admin.quantity, admin.amount], [1, null]);
    await preference(f, "central-notificacoes", "notificacoes.certificado_a1", [f.users.fiscal, f.users.vendas].sort());
    assert.ok((await types(f.users.fiscal)).includes("certificado_a1"));
    assert.ok(!(await types(f.users.vendas)).includes("certificado_a1"), "vendas does not handle the certificate");
  } finally {
    await f.close();
  }
});
