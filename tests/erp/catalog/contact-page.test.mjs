// erp_catalog_contact_page nos dois motores: ordens, filtros de texto (busca,
// UF, cidade, telefone, e-mail), tipos, situação, períodos e "Sem compras no
// período" (documents/catalog-p.ts salesInPeriodCondition), inclusive pedido
// com body->>'date' nulo e lista de status; e um diferencial aleatório.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

const page = (args = {}, user = f.users.admin) => f.rpc("erp_catalog_contact_page", { p_user_id: user, p_size: 100, ...args });

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("contatos variados, pedidos de venda e o filtro sem compras", async () => {
  const r = rng(124);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const data = {
      name: pick(["Ána Ábaco", "Bruno", "çedilha", "Zé", "ana", "ΑΣ Grego", "İzmir", "Loja ABC"]) + " " + i,
      code: r() < 0.6 ? pick(["", "A-" + i, String(i), "z" + i, "Ç" + i]) : null,
      trade_name: r() < 0.4 ? "Fantasia " + i : null,
      person_type: pick([null, "F", "J"]),
      email: r() < 0.5 ? `contato${i}@exemplo.com.br` : null,
      phone: r() < 0.5 ? `(19) 3434-${1000 + i}` : null,
      mobile: r() < 0.3 ? `19 9${8000 + i}-0000` : null,
      city: pick([null, "São Carlos", "SAO CARLOS", "Piracicaba", "campinas"]),
      state: pick([null, "SP", "sp", "MG"]),
      types: pick([["customer"], ["supplier"], [], ["customer", "accountant"]]),
      next_visit: r() < 0.3 ? pick(["2026-10-20", "2026-10-31", "2026-11-05"]) : null,
    };
    if (data.code === "") delete data.code;
    if (data.person_type === null) delete data.person_type;
    if (data.person_type !== "J") delete data.trade_name;
    const saved = (await f.save(data)).record;
    ids.push(saved.id);
    if (r() < 0.2)
      await f.rpc("erp_catalog_contact_set_situation", {
        p_user_id: f.users.admin, p_id: saved.id, p_expected_version: saved.version, p_command_id: randomUUID(), p_situation: pick(["I", "S", "E"]),
      });
  }
  const product = await f.catalog("products", { name: "Produto da venda", unit: "UN", kind: "P", format: "S", price: "1" });
  const orders = [];
  const buyers = [];
  for (const name of ["Comprador outubro", "Comprador fim do mês", "Comprador novembro", "Comprador sem data"])
    buyers.push((await f.save({ name, types: ["customer"] })).record.id);
  for (const [contact, date] of [[buyers[0], "2026-10-10"], [buyers[1], "2026-10-31"], [buyers[2], "2026-11-01"], [buyers[3], "2026-10-15"]]) {
    const order = (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_body: { date, contact_id: contact, items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "1", unit_price: "10" }] },
      })
    ).document;
    orders.push(order);
  }
  // Pedido com body->>'date' nulo: não conta como compra em período nenhum.
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query("update erp_documents.document set body=body-'date' where id=$1", [orders[3].id]);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
  const status = orders[0].status;
  for (const args of [
    {}, { p_sort: "name_asc" }, { p_sort: "name_desc" }, { p_sort: "code_asc" }, { p_sort: "code_desc" }, { p_sort: "created_desc", p_page: 2, p_size: 7 },
    { p_situation: "all" }, { p_situation: "E" }, { p_situation: "I" }, { p_situation: "S" }, { p_situation: "A" },
    { p_query: "ana" }, { p_query: "ábaco 1" }, { p_query: "3434" }, { p_query: "ασ" }, { p_query: "izmir" }, { p_query: "  " },
    { p_state: "SP" }, { p_city: "sao" }, { p_city: " São Carlos " }, { p_phone: "3434-10" }, { p_phone: "19 9" }, { p_email: "CONTATO1" },
    { p_type: "customer" }, { p_type: "accountant" }, { p_type: "none" }, { p_person_type: "J" },
    { p_period: "next_visit", p_from: "2026-10-20", p_to: "2026-10-31" }, { p_period: "next_visit", p_to: "2026-11-01" },
    { p_period: "created", p_from: "2026-01-01" }, { p_period: "updated", p_to: "2100-12-31" },
    { p_period: "no_purchases", p_from: "2026-10-01", p_to: "2026-10-31" },
    { p_period: "no_purchases", p_from: "2026-10-31" },
    { p_period: "no_purchases", p_to: "2026-10-31" },
    { p_period: "no_purchases", p_from: "2026-10-01", p_to: "2026-12-31", p_sale_statuses: [status] },
    { p_period: "no_purchases", p_from: "2026-10-01", p_to: "2026-12-31", p_sale_statuses: ["fulfilled", "cancelled"] },
    { p_query: "ana", p_sort: "code_desc", p_page: 1, p_size: 3 },
  ])
    await page(args);
  for (const args of [
    { p_sale_statuses: [] }, { p_period: "no_purchases", p_from: "2026-10-01", p_sale_statuses: [] }, { p_period: "no_purchases" },
    { p_sale_statuses: ["open"] }, { p_state: "sp" }, { p_phone: "abc" }, { p_size: 101 }, { p_sort: "id" }, { p_type: "inexistente" },
    { p_period: "created", p_from: "2026-10-02", p_to: "2026-10-01" }, { p_query: "x".repeat(121) },
  ])
    await assert.rejects(page(args), (e) => e.code === "22023");
});

test("carteira do vendedor e acesso", async () => {
  await f.preference("contatos.acesso_vendedor", true);
  try {
    await page({}, f.users.vendas);
    await page({ p_situation: "all" }, f.users.vendedor);
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
  await assert.rejects(page({}, f.users.inactive), (e) => e.code === "42501");
});
