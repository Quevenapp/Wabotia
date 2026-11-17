// Diferencial dos relatórios, do histórico e da prévia de conversão (sessão
// L, B0: reads-reports.ts, reads-history.ts e reads-proposal.ts) nos dois
// motores. Casos que forçam o oráculo: valores iguais na curva ABC (desempate
// por lower(descrição) e chave), item livre com descrição em caixa diferente,
// total nulo, percentuais que arredondam; romaneio com volume "007", peso
// numérico, transportador em maiúsculas, endereço de entrega e filtros
// estragados; OS com itens de serviço e peça pelo grupo e pelo tipo do
// produto, condições com coluna nula; ocorrências com hora e removidas;
// histórico com títulos vencidos, consulta e limite; proposta com parcelas,
// outros itens em texto rico, desconto percentual, modelo e já convertida.
// Os dados são gravados direto no Postgres e espelhados.
//   node --test tests/erp/documents/reads-reports-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, customer, other, products, carrier, docs, sale, os, proposals;
const sql = async (text, args = []) => (await f.db.query(text, args)).rows;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (/divergem/.test(e.message)) throw e;
    return { error: e.code };
  }
};
const roles = () => [f.users.admin, f.users.consulta, f.users.vendas, f.users.vendedor, f.users.financeiro, f.users.estoque, f.users.fiscal, null];

before(async () => {
  f = await dualFixture();
  const { admin } = f.users;
  customer = await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer"] });
  other = await f.catalog("contacts", { name: "Outro Cliente", roles: ["customer"] });
  carrier = await f.catalog("contacts", { name: "Transportadora Rápida", roles: ["carrier"] });
  products = [];
  for (const name of ["Parafuso", "Serviço de montagem", "Arruela"]) products.push((await f.catalog("products", { name })).id);
  docs = [];
  await f.db.exec("set session_replication_role = replica");
  try {
    let n = 0;
    const doc = async (kind, contact, body, items, extra = {}) => {
      const id = randomUUID();
      docs.push(id);
      n++;
      await sql(
        "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority,source_proposal_id) values($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$9,now(),now(),'brufap','brufap',$10)",
        [id, kind, n, extra.status ?? "open", contact, extra.total ?? "100.00", JSON.stringify({ name: extra.name ?? "Cliente Sintético", phone: " 11 9999 ", street: "Rua do Cliente", city: "São Paulo", state: "SP" }), JSON.stringify(body), admin, extra.source ?? null],
      );
      for (const [pos, prod, q, total, data, snap] of items)
        await sql("insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,discount_percent,total,data,product_snapshot) values($1,$2,$3,$4,$5,'12.3400000001',2.5,$6,$7,$8)", [
          randomUUID(), id, pos, prod, q, total, JSON.stringify(data), snap ? JSON.stringify(snap) : null,
        ]);
      return id;
    };
    sale = await doc("sales_orders", customer.id, {
      date: "2026-10-05", expected_date: "2026-10-20", carrier_id: carrier.id.toUpperCase(),
      commercial: { transport: { freight_mode: 1, volume_count: "007", gross_weight: 1.5 } },
      delivery_address: { street: " Rua da Entrega ", city: "Campinas", state: "SPX", postal_code: "13000-000000" },
    }, [
      [1, products[0], "2", "50.00", { description: "Parafuso", code: " P1 ", unit: "UN" }],
      [2, null, "1", "50.00", { description: "Frete Avulso" }],
      [3, null, "1", "50.00", { description: "frete avulso" }],
      [4, products[2], "1.5", null, { description: "Arruela" }],
    ]);
    await doc("sales_orders", other.id, { date: "2026-10-06", commercial: { transport: { volume_count: 2, gross_weight: "0.25" } } }, [
      [1, products[0], "1", "33.33", { description: "parafuso", code: "P0" }],
      [2, products[2], "3", "16.67", { description: "Arruela" }],
    ]);
    await doc("sales_orders", customer.id, { date: "2026-10-07" }, [[1, products[0], "9", "1000.00", {}]], { status: "cancelled" });
    await doc("sales_orders", customer.id, { date: "2025-01-01" }, [[1, products[0], "1", "1.00", {}]]);
    await doc("sales_orders", customer.id, {}, [[1, products[0], "1", "1.00", {}]]);
    os = await doc("service_orders", customer.id, { date: "2026-10-10" }, [
      [1, products[1], "1", "120.00", { group: "service" }, { kind: "S" }],
      [2, products[0], "4", "8.00", {}, { kind: "P" }],
      [3, products[1], "1", "30.00", {}, { kind: "S" }],
      [4, null, "1", "5.00", { group: null }],
      [5, null, "1", "7.00", { group: "part" }],
    ], { total: "170.00" });
    await doc("service_orders", other.id, { date: "2026-10-11" }, [], { total: "0.00", status: "quoted" });
    // Ocorrências da OS (uma removida).
    for (const [seq, day, time, before, afterS] of [[1, "2026-10-10", "09:00", "open", "quoted"], [2, "2026-10-10", "10:30", "quoted", null], [3, "2026-10-12", "08:00", "quoted", "approved"]]) {
      const id = randomUUID();
      await sql(
        "insert into erp_documents.occurrence(id,document_id,sequence,occurred_on,occurred_time,text,status_before,status_after,actor_id,actor_role,command_id,document_version,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'admin',$10,1,now())",
        [id, os, seq, day, time, `Ocorrência ${seq}`, before, afterS, admin, randomUUID()],
      );
      if (seq === 2)
        await sql("insert into erp_documents.occurrence_removal(occurrence_id,document_id,actor_id,actor_role,command_id,removed_at) values($1,$2,$3,'admin',$4,now())", [id, os, admin, randomUUID()]);
    }
    // Propostas para a prévia de conversão.
    const rich = { blocks: [{ runs: [{ text: "Linha " }, { text: "um" }] }, { runs: [] }, { runs: [{ text: "Linha 3" }] }] };
    proposals = {
      open: await doc("sales_proposals", customer.id, {
        date: "2026-10-01", installments: [{ position: 1, due_days: 30, percent: "100" }], valid_until: "2026-12-01", template: false,
        other_items: { total: "15.50", content: rich }, discount_mode: "percent", totals: { discount: "3.21" },
        commercial: { transport: { delivery_days: "10" } }, price_list_id: randomUUID(),
      }, [
        [2, products[1], "1", "120.00", { description: "Montagem", detailed_description: { blocks: [] }, list_price: null }, { kind: "S" }],
        [1, products[0], "2.5", "25.00", { description: "Parafuso", code: "P1", unit: "UN" }, { kind: "P" }],
      ]),
      template: await doc("sales_proposals", customer.id, { date: "2026-10-01", template: "yes" }, []),
      cancelled: await doc("sales_proposals", customer.id, { date: "2026-10-01" }, [], { status: "cancelled" }),
      converted: await doc("sales_proposals", customer.id, { date: "2026-10-01", other_items: { total: "0" } }, []),
    };
    await doc("sales_orders", customer.id, { date: "2026-10-02" }, [], { source: proposals.converted });
    // Títulos a receber do cliente (um vencido, um pago, um cancelado).
    for (const [due, amount, settled, cancelled] of [["2026-01-10", 10000, 2500, false], ["2099-01-10", 5000, 0, false], ["2026-02-10", 3000, 3000, false], ["2026-03-10", 7000, 0, true]])
      await sql(
        `insert into erp_finance.title(id,group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents,cancelled,version,created_at,updated_at,competence_on,interest_month_bp,penalty_bp,original_due_on,seller_none)
         values($1,$2,1,1,'receivable',$3,$4,'2026-01-01',$5,$6,$7,$8,1,now(),now(),'2026-01-01',0,0,$5,false)`,
        [randomUUID(), randomUUID(), customer.id, "Título " + due, due, amount, settled, cancelled],
      );
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
});
after(async () => f?.close());

test("curva ABC: empates, item livre, total nulo e período", async () => {
  for (const user of roles()) await outcome(f.rpc("erp_document_sales_abc", { p_user_id: user, p_from: "2026-10-01", p_to: "2026-10-31" }));
  for (const [from, to] of [["2025-01-01", "2026-12-31"], ["2026-10-31", "2026-10-01"], ["2025-10-01", "2026-10-02"], ["2026-02-30", "2026-03-01"], [null, "2026-10-01"], ["2026-10-06", "2026-10-06"]])
    await outcome(f.rpc("erp_document_sales_abc", { p_user_id: f.users.admin, p_from: from, p_to: to }));
  const r = await f.rpc("erp_document_sales_abc", { p_user_id: f.users.admin, p_from: "2026-10-01", p_to: "2026-10-31" });
  assert.ok(r.items.length >= 3);
});

test("romaneio: filtros, datas, situações e transportador", async () => {
  const base = { from: "2026-10-01", to: "2026-10-31" };
  const filters = [
    base, { ...base, date_type: "expected_date" }, { ...base, date_type: "ship_date" }, { ...base, date_type: "x" }, { ...base, date_type: null }, { ...base, date_type: 1 },
    { ...base, statuses: ["open"] }, { ...base, statuses: ["cancelled", "open", "open"] }, { ...base, statuses: [] }, { ...base, statuses: ["nada"] }, { ...base, statuses: null },
    { ...base, carrier_id: carrier.id }, { ...base, carrier_id: "x" }, { ...base, contact_id: other.id }, { ...base, extra: 1 }, { from: "2026-10-01" }, [], null,
  ];
  for (const filter of filters) await outcome(f.rpc("erp_document_sales_romaneio", { p_user_id: f.users.admin, p_filters: filter }));
  for (const user of roles()) await outcome(f.rpc("erp_document_sales_romaneio", { p_user_id: user, p_filters: base }));
  const r = await f.rpc("erp_document_sales_romaneio", { p_user_id: f.users.admin, p_filters: base });
  assert.equal(r.totals.volumes, "9");
});

test("ordens de serviço e ocorrências: condições e situações", async () => {
  const conditions = [
    [], [{ column: "name", value: " sintético " }], [{ column: "number", value: "6" }], [{ column: "parts", value: "20" }], [{ column: "services", value: "150.00" }],
    [{ column: "total", value: "170" }], [{ column: "status", value: "quoted" }], [{ column: "date", value: "2026-10-10" }], [{ column: "date", value: "2026-02-30" }],
    [{ column: null, value: "open" }], [{ column: "x", value: "1" }], [{ column: "name", value: "" }], [{ column: "name", value: 1 }], [{ column: "name" }], [1], {}, null,
    Array.from({ length: 11 }, () => ({ column: "name", value: "a" })),
  ];
  for (const c of conditions) await outcome(f.rpc("erp_document_service_report", { p_user_id: f.users.admin, p_conditions: c }));
  for (const user of roles()) await outcome(f.rpc("erp_document_service_report", { p_user_id: user, p_conditions: [] }));
  for (const status of [null, "quoted", "approved", "nada"])
    for (const [from, to] of [["2026-10-01", "2026-10-31"], ["2026-10-31", "2026-10-01"]])
      await outcome(f.rpc("erp_document_service_occurrence_report", { p_user_id: f.users.admin, p_from: from, p_to: to, p_status: status }));
  for (const user of roles()) await outcome(f.rpc("erp_document_service_occurrence_report", { p_user_id: user, p_from: "2026-10-01", p_to: "2026-10-31", p_status: null }));
});

test("histórico: vendas do contato, compras do produto, consulta, limite e financeiro", async () => {
  for (const user of roles())
    for (const kind of ["sales_orders", "service_orders", "purchase_orders", "sales_proposals", null])
      await outcome(f.rpc("erp_document_history", { p_user_id: user, p_kind: kind, p_contact_id: customer.id, p_product_id: null, p_query: null, p_limit: 50 }));
  for (const [contact, product, query, limit] of [
    [customer.id, products[0], null, 50], [customer.id, null, " PARAF ", 50], [customer.id, null, "frete", 1], [customer.id, null, "", 2], [null, null, null, 50],
    [customer.id, null, "a\u0001", 50], [customer.id, null, "x".repeat(121), 50], [customer.id, null, null, 0], [customer.id, null, null, 51], [randomUUID(), null, null, 50],
  ])
    await outcome(f.rpc("erp_document_history", { p_user_id: f.users.admin, p_kind: "sales_orders", p_contact_id: contact, p_product_id: product, p_query: query, p_limit: limit }));
  for (const product of [products[0], null]) await outcome(f.rpc("erp_document_history", { p_user_id: f.users.admin, p_kind: "purchase_orders", p_contact_id: null, p_product_id: product, p_query: null, p_limit: 5 }));
  const r = await f.rpc("erp_document_history", { p_user_id: f.users.admin, p_kind: "sales_orders", p_contact_id: customer.id, p_product_id: null, p_query: null, p_limit: 50 });
  assert.equal(r.finance.open_count, 2);
});

test("prévia de conversão: pedido e OS, parcelas, outros itens e recusas", async () => {
  for (const user of roles())
    for (const kind of ["sales_orders", "service_orders", "sales_proposals", null])
      for (const id of [...Object.values(proposals), randomUUID(), null]) await outcome(f.rpc("erp_document_conversion_preview", { p_user_id: user, p_kind: kind, p_proposal_id: id }));
  const r = await f.rpc("erp_document_conversion_preview", { p_user_id: f.users.admin, p_kind: "service_orders", p_proposal_id: proposals.open });
  assert.equal(r.data.items.length, 3);
  assert.equal(r.data.items[2].detailed_description, "Linha um\n\nLinha 3");
});
