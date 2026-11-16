// erp_preferences_report_run e as 25 bases do report_source na fixture dupla. Adaptados do Fagoo:
// - reports-labels-sql.test.mjs "149 relatórios…" (a parte do run: linhas, filtros, página, totais e recusas);
// - preferences-d-sql.test.mjs "230 PRF-241…" (notas de saída, entrada e NFC-e).
// Depois, cada base roda com todas as colunas nos dois motores sobre os mesmos dados (pedidos, propostas, OS, compras,
// títulos, notas, pessoas de contato e ocorrências das transições), comparados pelo diferencial.
// Adaptações: os pedidos entram por erp_document_save/erp_document_transition; títulos, baixas, pessoas de contato e
// ocorrências por SQL direto, copiados (f.sync). Fora, declarado: GRANT/has_function_privilege.
// Sem linhas nestes dados (rodam vazias nos dois motores): recebimentos, pagamentos, comissoes e caixa (baixas, comissões e o
// extrato vêm do Financeiro, coberto pelos testes dele) e venda_parcela/transporte_venda com corpo de parcelas e frete.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { captureReportRun, parseReportRows } from "../../../src/erp/fagoo/packages/erp-domain/src/reports-labels.mjs";
import { REPORT_CATALOG } from "../../../src/erp/domains/preferences/report-catalog.ts";

const fails = (fn, code) => assert.rejects(fn, (e) => e.code === code);

async function documentOf(f, kind, { contact, date = "2026-10-15", items, statuses = [], body = {} }) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date, contact_id: contact, ...body, items: items.map((i) => ({ unit: "UN", ...i })) },
    })
  ).document;
  for (const s of statuses)
    d = (
      await f.rpc("erp_document_transition", {
        p_user_id: f.users.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: "Transição sintética",
      })
    ).document;
  return d;
}

async function seed(f) {
  const ana = await f.catalog("contacts", { name: "Ana Sintética", city: "Campinas", state: "SP" }),
    bia = await f.catalog("contacts", { name: "Bia Sintética", city: "Santos", state: "SP" });
  const p = await f.catalog("products", { name: "Caneta azul", code: "CAN-1", unit: "UN", kind: "P", format: "S", price: "2.5", gtin: "7891234567895" });
  await f.catalog("products", { name: "Borracha", code: "BOR-1", unit: "UN", kind: "P", format: "S", price: "1.25" });
  const orders = [];
  for (const [contact, qty] of [[ana, "2"], [bia, "4"], [ana, "1"]])
    orders.push(await documentOf(f, "sales_orders", { contact: contact.id, items: [{ product_id: p.id, description: "Caneta azul", quantity: qty, unit_price: "2.5" }] }));
  await f.db.query(
    "insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents) values($1,1,2,'receivable',$2,'Parcela sintética','2026-10-01','2026-10-10',15000,5000),($3,1,1,'payable',$2,'Conta sintética','2026-10-01','2099-12-31',1000,0)",
    [randomUUID(), ana.id, randomUUID()],
  );
  await f.sync();
  return { ana, bia, p, orders };
}

const run = async (f, def, user) => {
  const r = captureReportRun({ filters: [], view_limit: 2000, offset: 0, page: 20, ...def });
  return parseReportRows(
    await f.rpc("erp_preferences_report_run", {
      p_user_id: user ?? f.users.admin, p_base: r.base, p_columns: r.columns, p_filters: r.filters, p_view_limit: r.view_limit, p_offset: r.offset, p_page: r.page,
    }),
    r,
  );
};

test("149 relatórios: a page carries rows, totals and the limit; filters and refusals", async () => {
  const f = await dualFixture();
  try {
    await seed(f);
    const all = await run(f, { base: "vendas", columns: ["contato", "total", "numero"] });
    assert.deepEqual(all.rows.map((r) => r[0]), ["Ana Sintética", "Bia Sintética", "Ana Sintética"]);
    assert.deepEqual(all.rows.map((r) => r[1]), ["5.00", "10.00", "2.50"]);
    assert.deepEqual(all.totals, { total: "17.50" });
    assert.equal(all.total_rows, 3);
    const ana = await run(f, { base: "vendas", columns: ["numero", "total"], filters: [{ column: "contato", value: "ana" }] });
    assert.deepEqual(ana.rows.map((r) => r[1]), ["5.00", "2.50"]);
    assert.deepEqual(ana.totals, { total: "7.50" });
    const exact = await run(f, { base: "vendas", columns: ["total"], filters: [{ column: "total", value: "10" }] });
    assert.deepEqual(exact.rows, [["10.00"]]);
    const limited = await run(f, { base: "vendas", columns: ["total"], view_limit: 2, page: 1, offset: 1 });
    assert.deepEqual([limited.rows, limited.total_rows, limited.truncated, limited.totals], [[["10.00"]], 2, true, { total: "15.00" }]);
    const products = await run(f, { base: "produtos", columns: ["descricao", "preco", "gtin"] });
    assert.deepEqual(products.rows.map((r) => r[0]), ["Borracha", "Caneta azul"]);
    const titles = await run(f, { base: "contas_receber", columns: ["contato", "parcela", "valor", "saldo", "situacao"] }, f.users.financeiro);
    assert.deepEqual(titles.rows, [["Ana Sintética", "1/2", "150.00", "100.00", "Parcial"]]);
    assert.deepEqual((await run(f, { base: "contas_pagar", columns: ["situacao"] })).rows, [["Em aberto"]]);
    assert.deepEqual((await run(f, { base: "contatos", columns: ["nome", "cidade", "uf"] })).rows, [["Ana Sintética", "Campinas", "SP"], ["Bia Sintética", "Santos", "SP"]]);
    await fails(() => run(f, { base: "contas_receber", columns: ["valor"] }, f.users.vendas), "42501");
    for (const bad of [{ p_columns: ["inexistente"] }, { p_columns: [] }, { p_columns: ["numero", "numero"] }, { p_filters: [{ column: "total", value: "dez" }] },
      { p_filters: [{ column: "contato", value: " x" }] }, { p_view_limit: 2001 }, { p_page: 201 }, { p_offset: 5, p_view_limit: 5 }])
      await fails(
        () => f.rpc("erp_preferences_report_run", { p_user_id: f.users.admin, p_base: "vendas", p_columns: ["numero"], p_filters: [], p_view_limit: 2000, p_offset: 0, p_page: 20, ...bad }),
        "22023",
      );
    await fails(() => f.rpc("erp_preferences_report_run", { p_user_id: f.users.admin, p_base: "x", p_columns: ["numero"], p_filters: [], p_view_limit: 10, p_offset: 0, p_page: 20 }), "42501");
    await fails(() => f.rpc("erp_preferences_report_run", { p_user_id: f.users.inactive, p_base: "vendas", p_columns: ["numero"], p_filters: [], p_view_limit: 10, p_offset: 0, p_page: 20 }), "42501");
  } finally {
    await f.close();
  }
});

test("todas as bases com todas as colunas: o mesmo resultado nos dois motores", async () => {
  const f = await dualFixture();
  try {
    const { ana, bia, p } = await seed(f);
    await documentOf(f, "sales_orders", {
      contact: bia.id, statuses: ["cancelled"], items: [{ product_id: p.id, description: "Caneta azul", quantity: "9", unit_price: "1" }],
    });
    await documentOf(f, "sales_proposals", { contact: ana.id, items: [{ product_id: p.id, description: "Caneta azul", quantity: "1", unit_price: "1" }] });
    await documentOf(f, "service_orders", { contact: bia.id, items: [{ description: "Serviço sintético", quantity: "1", unit_price: "50" }] });
    await documentOf(f, "purchase_orders", { contact: ana.id, items: [{ product_id: p.id, description: "Caneta azul", quantity: "10", unit_price: "1.1" }] });
    // Pessoas de contato, uma baixa com tarifa e um título devolvido.
    const person = await f.catalog("contacts", { name: "Pessoa de contato", email: "pessoa@sintetico.test" });
    await f.db.query("insert into erp_catalog.contact_person(contact_id,person_id,position) values($1,$2,1)", [ana.id, person.id]);
    await f.sync();
    for (const base of REPORT_CATALOG) {
      const columns = base.columns.map((c) => c.id);
      for (const user of [f.users.admin, f.users.financeiro, f.users.vendas, f.users.fiscal])
        await f
          .rpc("erp_preferences_report_run", { p_user_id: user, p_base: base.base, p_columns: columns, p_filters: [], p_view_limit: 2000, p_offset: 0, p_page: 200 })
          .catch((e) => {
            if (e.code !== "42501") throw e;
          });
      const text = base.columns.find((c) => c.type === "text");
      if (text)
        await f.rpc("erp_preferences_report_run", {
          p_user_id: f.users.admin, p_base: base.base, p_columns: columns, p_filters: [{ column: text.id, value: "a" }], p_view_limit: 1, p_offset: 0, p_page: 1,
        });
    }
    const abc = await run(f, { base: "curva_abc", columns: ["classe", "codigo", "quantidade", "valor", "percentual", "acumulado", "pedidos"] });
    assert.deepEqual(abc.rows, [["A", "CAN-1", "7", "17.50", "100.00", "100.00", "3"]]);
    const pessoas = await run(f, { base: "pessoas_contato", columns: ["contato", "nome", "email"] });
    assert.deepEqual(pessoas.rows, [["Ana Sintética", "Pessoa de contato", "pessoa@sintetico.test"]]);
  } finally {
    await f.close();
  }
});

async function invoiceSetup(f) {
  await f.db.query(
    "insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict(singleton) do nothing",
    [f.users.admin],
  );
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict(singleton) do nothing", [f.users.admin]);
  await f.sync();
  const nature = (
    await f.rpc("erp_fiscal_nature_execute", {
      p_user_id: f.users.admin,
      p_command_id: randomUUID(),
      p_action: "create",
      p_data: { nature: { description: "Venda sintética", direction: "1", crt: "1", presence: "1" } },
    })
  ).nature;
  const product = await f.catalog("products", { name: "Peça sintética", code: "P-1", unit: "UN", kind: "P", format: "S", price: "50", ncm: "84713012", gtin: "7891234567895" });
  const contact = await f.catalog("contacts", { name: "Cliente Sintético", document: "11222333000181" });
  const item = (over = {}) => ({
    product_id: product.id,
    description: "Peça sintética",
    code: "P-1",
    unit: "UN",
    quantity: "2.5",
    unit_price: "40",
    ncm: "84713012",
    cfop: "5102",
    icms: { origin: "0", situation: "102" },
    ...over,
  });
  const invoice = (
    await f.rpc("erp_fiscal_invoice_execute", {
      p_user_id: f.users.admin,
      p_command_id: randomUUID(),
      p_action: "create",
      p_data: {
        invoice: {
          model: "55",
          direction: "1",
          issue_type: "N",
          series: "1",
          nature_id: nature.id,
          issue_date: "2026-10-20",
          crt: "1",
          purpose: "1",
          presence: "1",
          final_consumer: false,
          recipient: { contact_id: contact.id, name: "Cliente Sintético", person_type: "J", document: "11222333000181", state: "SP", city: "Campinas", street: "Rua Sintética", number: "10" },
          items: [item(), item({ product_id: undefined, code: "AV-1", description: "Item avulso", quantity: "1", unit_price: "20" })],
        },
      },
    })
  ).invoice;
  return { product, contact, invoice };
}

test("230 PRF-241 Relatórios customizados: NF-e de saída, NF-e de entrada and NFC-e, for the readers of the notes", async () => {
  const f = await dualFixture();
  try {
    const { invoice } = await invoiceSetup(f);
    const bases = async (user) => (await f.rpc("erp_preferences_reports", { p_user_id: user })).bases.map((b) => b.base).filter((b) => /notas|nfce/.test(b));
    assert.deepEqual(await bases(f.users.fiscal), ["notas_saida", "notas_entrada", "nfce"]);
    assert.deepEqual(await bases(f.users.vendas), []);
    const columns = ["numero", "serie", "emissao", "contato", "documento", "uf", "natureza", "situacao", "total", "chave"];
    const rows = await run(f, { base: "notas_saida", columns }, f.users.consulta);
    assert.deepEqual(rows.rows, [[null, "1", "2026-10-20", "Cliente Sintético", "11222333000181", "SP", "Venda sintética", "Pendente", "120.00", null]]);
    assert.equal(rows.totals.total, "120.00");
    await fails(() => run(f, { base: "notas_saida", columns }, f.users.vendas), "42501");
    assert.deepEqual((await run(f, { base: "notas_entrada", columns: ["numero"], view_limit: 10 })).rows, []);
    const transport = REPORT_CATALOG.find((b) => b.base === "transporte_nota").columns.map((c) => c.id);
    assert.equal((await run(f, { base: "transporte_nota", columns: transport })).rows.length, 1);
    // A deleted note leaves the report.
    await f.rpc("erp_fiscal_invoice_execute", {
      p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "delete", p_data: { id: invoice.id, expected_version: invoice.version, reason: "Exclusão sintética" },
    });
    assert.deepEqual((await run(f, { base: "notas_saida", columns })).rows, []);
  } finally {
    await f.close();
  }
});