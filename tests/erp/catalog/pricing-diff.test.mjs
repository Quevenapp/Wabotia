// Diferencial aleatório das listas de preço (semente fixa: falha
// reproduzível). Sequência de inclusões, alterações, itens, reajustes,
// planilhas, cópias e exclusões, com entradas boas e ruins, e as consultas
// (lista, preços, listas do produto, aplicáveis) no meio. Cada chamada roda
// nos dois motores; divergência de resposta, erro ou tabela falha o teste.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { productsFixture } from "../fagoo/catalog-products-fixture.mjs";

let f;
before(async () => {
  f = await productsFixture();
});
after(async () => f?.close());

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Resultado por RPC: ok ou o código do erro (o teste exige caminho feliz em cada um). */
const tally = new Map();
const count = (name, outcome) => {
  const t = tally.get(name) ?? {};
  t[outcome] = (t[outcome] ?? 0) + 1;
  tally.set(name, t);
};

/** Erro esperado do RPC (código do Postgres); divergência ou falha do teste sobe. */
let last = "?";
const rpc = (name, args) => {
  last = name;
  return f.rpc(name, args);
};
async function attempt(promise, name = last) {
  try {
    const out = await promise;
    count(name, out?.saved === false ? `ok:${out.reason}` : "ok");
    return out;
  } catch (e) {
    if (!e.code || e.code === "ERR_ASSERTION") throw e;
    count(name, `${e.code}:${e.message}`);
    return null;
  }
}

test("CHECKs pendentes da paridade garantidos em TS: fator 0 na customizada e preço reajustado acima de 10^14", async () => {
  const admin = f.users.admin;
  const data = {
    name: "Check fator", category: "other", list_type: "custom", factor: "0", factor_unit: "percent", direction: "increase",
    considers_datetime: false, contacts: [], regions: [],
  };
  const save = (d) => f.rpc("erp_pricing_list_save", { p_user_id: admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: d });
  await assert.rejects(save(data), (e) => e.code === "23514" && /price_list_factor_check/.test(e.message));
  const list = (await save({ ...data, factor: null })).list;
  const big = await f.product({ name: "Caro", price: "99999999999999.9999" });
  const items = (version, change) =>
    f.rpc("erp_pricing_list_items", { p_user_id: admin, p_id: list.id, p_expected_version: version, p_command_id: randomUUID(), p_change: change });
  const v = (await items(1, { add: [big.id] })).list.version;
  await assert.rejects(
    items(v, { adjust: { action: "increase", unit: "percent", value: "10" } }),
    (e) => e.code === "23514" && /price_list_item_custom_price_check/.test(e.message),
  );
  // Nome repetido decide antes da gravação: não chega ao CHECK.
  assert.equal((await save(data)).reason, "duplicate_name");
  assert.equal((await items(v, { adjust: { action: "discount", unit: "percent", value: "10" } })).list.version, v + 1);
});

test("diferencial aleatório: listas de preço, itens, planilha, cópia, exclusão e consultas", async () => {
  const r = rng(20261116);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const maybe = (p) => r() < p;
  const admin = f.users.admin;

  // Cadastros de apoio (no Postgres, copiados para o SQLite).
  const prices = [null, "10", "10.1250", "0.3333333333", "0.005", "0.015", "99999999999999.9999", "1", "2.5", "0", "123.4567891234"];
  const products = [];
  const names = ["Parafuso", "parafuso inox", "Ábaco", "Çedilha", "Ωmega", "Zíper", "Arruela", "arruela", "Porca 10", "Ñandu", "ﬁo", "Égua"];
  for (let i = 0; i < 18; i++) {
    const p = await f.product({
      name: `${pick(names)} ${i}`,
      code: pick([`C-${i}`, `c-${i}`, `X${i}`, null]) ?? undefined,
      price: prices[i % prices.length] ?? undefined,
    });
    products.push(p.id);
  }
  // Códigos repetidos sem caixa (ambíguos na planilha) e um excluído.
  await f.product({ name: "Dup A", code: "DUP", price: "1" });
  await f.product({ name: "Dup B", code: "dup", price: "2" });
  const gone = await f.product({ name: "Excluído", code: "GONE", price: "3" });
  await f.setDeleted(gone.id, gone.version, true);
  const contacts = [];
  for (const [name, state] of [["Cliente SP", "sp"], ["Cliente RJ", "RJ"], ["Sem UF", null], ["Ünal MG", "MG"], ["Estrangeiro", "EX"]])
    contacts.push((await f.contact({ name, ...(state ? { state } : {}) })).id);
  const sellers = [];
  for (const name of ["Vendedora Ana", "Vendedor Ávila"]) {
    const c = await f.contact({ name });
    sellers.push(await f.write("insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v", [c.id, admin]));
  }
  const methods = [];
  for (const d of ["Pix", "Boleto", "Cartão"])
    methods.push(
      await f.write(
        "insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values($1,'17','contas','recebimentos',$2,$2) returning id v",
        [d, admin],
      ),
    );

  const lists = new Map(); // id → versão
  const listNames = ["Atacado", "atacado", "Varejo", "Black Friday", "Ásia", "asia", "Clientes VIP", "Ωmega", "  espaços  ", "Revenda"];
  const factors = ["10", "0.5", "100", "15.25", "0.0001", "99999999999.9999", "5", "1.23456", "0", "101", "-1", "1,5", 7, null];
  const dates = [null, "2020-01-01", "2026-01-01", "2026-12-31", "2099-12-31", "2026-02-30", "1899-12-31", "2026-1-1"];
  const times = [null, "08:00", "22:00", "00:00", "23:59", "24:00", "8:00"];
  const users = [admin, admin, admin, admin, admin, admin, f.users.estoque, f.users.vendas, f.users.inactive];

  /** Lista válida; em 30% das vezes um campo estragado (o erro também é comparado). */
  function listData(listType = pick(["rates", "rates", "period", "custom"])) {
    const category = pick(["other", "other", "contact", "seller", "payment_method", "region"]);
    const unit = pick(["percent", "amount"]);
    const direction = pick(["increase", "discount"]);
    const considers = maybe(0.3);
    const day = pick(["2020-01-01", "2026-01-01", "2026-11-16", "2099-12-31"]);
    const d = {
      name: pick(listNames) + (maybe(0.7) ? ` ${Math.floor(r() * 60)}` : ""),
      category,
      list_type: listType,
      factor: listType === "custom" && maybe(0.6) ? null : pick(["10", "0.5", "15.25", "0.0001", "5", "33.3333", unit === "amount" ? "99999999999.9999" : "100"]),
      factor_unit: unit,
      direction,
      considers_datetime: considers,
      starts_on: listType === "period" || maybe(0.2) ? (maybe(0.5) ? "2026-01-01" : day) : null,
      ends_on: listType === "period" || maybe(0.2) ? pick(["2099-12-31", day]) : null,
      start_time: considers && maybe(0.7) ? pick(["00:00", "08:00", "23:59"]) : null,
      end_time: considers && maybe(0.7) ? pick(["08:00", "22:00", "23:59"]) : null,
      contacts: category === "contact" ? contacts.filter(() => maybe(0.5)) : [],
      regions: category === "region" ? pick([["SP"], ["SP", "MG"], ["RJ"]]) : [],
    };
    if (d.starts_on && d.ends_on && d.starts_on > d.ends_on) [d.starts_on, d.ends_on] = [d.ends_on, d.starts_on];
    if (category === "seller" || maybe(0.1)) d.sellers = category === "seller" ? sellers.filter(() => maybe(0.6)) : [];
    if (category === "payment_method" || maybe(0.1)) d.payment_methods = category === "payment_method" ? methods.filter(() => maybe(0.5)) : [];
    if (maybe(0.3)) {
      const [key, value] = pick([
        ["name", pick(["", "x".repeat(121), "a\u0001", 7])], ["category", pick(["store", null])], ["list_type", "x"],
        ["factor", pick(["0", "101", "1.23456", "-1", "1,5", 7, null])], ["factor_unit", "pct"], ["direction", "up"],
        ["considers_datetime", "sim"], ["starts_on", pick(["2026-02-30", "1899-12-31", "2026-1-1"])], ["start_time", pick(["24:00", "8:00", "10:00"])],
        ["contacts", pick([null, [contacts[0]], ["x"], [contacts[0], contacts[0]], [contacts[0].toUpperCase()]])],
        ["regions", pick([["XX"], ["SP", "SP"], [1], null])], ["sellers", pick([[randomUUID()], null, sellers])],
        ["payment_methods", pick([["nao-uuid"], [methods[0], methods[0]], Array.from({ length: 31 }, () => randomUUID())])], ["extra", 1],
      ]);
      d[key] = value;
    }
    return d;
  }  const types = new Map();
  const versionOf = (id) => lists.get(id) ?? 1;
  const track = (out) => {
    if (out?.list?.id) {
      lists.set(out.list.id, out.list.version);
      types.set(out.list.id, out.list.list_type);
    }
  };
  const anyList = () => (lists.size && maybe(0.92) ? pick([...lists.keys()]) : randomUUID());
  const anyProduct = () => (maybe(0.9) ? pick(products) : pick([gone.id, randomUUID()]));

  for (let i = 0; i < 320; i++) {
    const op = pick(["create", "create", "update", "items", "items", "adjust", "import", "clone", "delete", "read", "read", "read"]);
    const user = pick(users);
    if (op === "create") {
      const data = listData();
      if (maybe(0.4)) data.add_products = products.filter(() => maybe(0.3)).concat(maybe(0.05) ? [gone.id] : []);
      track(await attempt(rpc("erp_pricing_list_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })));
    } else if (op === "update" && lists.size) {
      const id = anyList();
      const command = randomUUID();
      const type = types.get(id);
      const args = { p_user_id: user, p_id: id, p_expected_version: maybe(0.85) ? versionOf(id) : versionOf(id) + 1, p_command_id: command, p_data: listData(maybe(0.9) && type ? type : undefined) };
      track(await attempt(rpc("erp_pricing_list_save", args)));
      if (maybe(0.2)) track(await attempt(rpc("erp_pricing_list_save", args))); // repetição do mesmo comando
    } else if (op === "items" && lists.size) {
      const id = anyList();
      const change = {};
      if (maybe(0.7)) change.add = products.filter(() => maybe(0.25)).concat(maybe(0.05) ? [anyProduct()] : []);
      if (maybe(0.3)) change.remove = products.filter(() => maybe(0.2));
      if (maybe(0.4))
        change.prices = products
          .filter(() => maybe(0.3))
          .map((p) => ({ product_id: p, custom_price: pick(["9.995", "1", null, "0.0000000001", "12345678901234", "1,5", "-1", 3, ""]) }));
      if (maybe(0.03)) change.nope = 1;
      track(
        await attempt(rpc("erp_pricing_list_items", { p_user_id: user, p_id: id, p_expected_version: versionOf(id), p_command_id: randomUUID(), p_change: change }),
        ),
      );
    } else if (op === "adjust" && lists.size) {
      const id = anyList();
      const adjust = {
        action: pick(["increase", "discount", "fix", "x"]),
        unit: pick(["percent", "amount"]),
        value: pick(["10", "0.3333", "2", "100", "150", "0", "1,5", "99999999999.9999"]),
      };
      if (maybe(0.4)) adjust.products = products.filter(() => maybe(0.3));
      const change = maybe(0.05) ? { adjust: null } : { adjust };
      track(
        await attempt(rpc("erp_pricing_list_items", { p_user_id: user, p_id: id, p_expected_version: versionOf(id), p_command_id: randomUUID(), p_change: change }),
        ),
      );
    } else if (op === "import" && lists.size) {
      const id = anyList();
      const codes = ["C-1", "c-1", " C-2 ", "X3", "x4", "DUP", "GONE", "NAO-EXISTE", "C-10", "", "A\tB", "ﬁ"];
      const rows = Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
        const row = { code: pick(codes) };
        if (maybe(0.4)) row.price = pick(["7.5", "", " 8 ", "1,5", null, "0.00001", 3]);
        return row;
      });
      track(
        await attempt(rpc("erp_pricing_list_import", { p_user_id: user, p_id: id, p_expected_version: versionOf(id), p_command_id: randomUUID(), p_rows: rows }),
        ),
      );
    } else if (op === "clone" && lists.size) {
      track(
        await attempt(rpc("erp_pricing_list_clone", { p_user_id: user, p_id: anyList(), p_command_id: randomUUID(), p_name: pick(listNames) + ` cópia ${i}` }),
        ),
      );
    } else if (op === "delete" && lists.size && maybe(0.4)) {
      const id = anyList();
      const out = await attempt(rpc("erp_pricing_list_delete", { p_user_id: user, p_id: id, p_expected_version: versionOf(id), p_command_id: randomUUID() }),
      );
      if (out?.deleted) lists.delete(id);
    } else {
      const reader = pick([admin, f.users.vendas, f.users.consulta, f.users.financeiro, f.users.estoque]);
      const kind = pick(["get", "get", "lists", "prices", "prices", "product", "applicable", "applicable2"]);
      if (kind === "get" && lists.size)
        await attempt(rpc("erp_pricing_list_get", {
            p_user_id: reader, p_id: anyList(), p_query: pick([null, null, "", "par", "PARAFUSO 1", "c-1", "1", "ábaco", "ωmega", "fi", "x".repeat(121)]),
            p_offset: pick([0, 0, 0, 2, -1]), p_limit: pick([100, 100, 5, 1, 101]),
          }),
        );
      else if (kind === "lists")
        await attempt(rpc("erp_pricing_lists", {
            p_user_id: reader, p_list_type: pick([null, "rates", "custom", "period", "x"]), p_query: pick([null, null, "atacado", "ASIA", "vip 1", "a\u0001"]),
            p_category: pick([null, null, "other", "region", "x"]), p_product_id: maybe(0.3) ? anyProduct() : null,
            p_from: pick([null, null, "2026-01-01", "1800-01-01"]), p_to: pick([null, null, "2099-12-31", "2020-01-01"]),
          }),
        );
      else if (kind === "prices" && lists.size)
        await attempt(rpc("erp_pricing_list_prices", {
            p_user_id: reader, p_id: anyList(), p_product_ids: pick([products.slice(0, 5), products.slice(5, 18), [products[0], products[0]], [], [randomUUID(), products[3]]]),
          }),
        );
      else if (kind === "product") await attempt(rpc("erp_pricing_product_lists", { p_user_id: reader, p_product_id: anyProduct() }));
      else if (kind === "applicable")
        await attempt(rpc("erp_pricing_applicable_lists", {
            p_user_id: reader, p_contact_id: maybe(0.6) ? pick(contacts) : null, p_seller_id: maybe(0.4) ? pick(sellers) : null,
            p_payment_method_id: maybe(0.4) ? pick(methods) : null, p_state: pick([null, null, "SP", "RJ", "sp", "XX"]),
          }),
        );
      else if (kind === "applicable2")
        await attempt(rpc("erp_pricing_applicable_lists_v2", {
            p_user_id: reader, p_contact_id: maybe(0.6) ? pick(contacts) : null, p_seller_id: maybe(0.4) ? pick(sellers) : null,
            p_payment_method_ids: pick([null, methods.slice(0, 2), [methods[2]], [], [methods[0], methods[0]]]), p_state: pick([null, "MG", "XX"]),
          }),
        );
    }
  }
  for (const [name, t] of [...tally].sort()) console.log(name, JSON.stringify(t));
  for (const name of ["erp_pricing_list_save", "erp_pricing_list_items", "erp_pricing_list_import", "erp_pricing_list_clone", "erp_pricing_list_get"])
    assert.ok((tally.get(name)?.ok ?? 0) >= 5, `${name}: poucas chamadas com sucesso ${JSON.stringify(tally.get(name))}`);
  assert.ok(lists.size > 5, `poucas listas criadas: ${lists.size}`);
  assert.ok(f.stats.ported > 200, `poucas chamadas comparadas: ${f.stats.ported}`);
});
