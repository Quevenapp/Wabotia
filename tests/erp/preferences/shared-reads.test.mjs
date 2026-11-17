// Leituras do domínio 11 que outros domínios usam (preferences/public.ts), contra o oráculo:
// erp_preferences.situation_base_label/_color, situation_bases, situation_list, situation_of, transition_allowed,
// transition_list e transition_rule; erp_home.biz_role, biz_cost_visible, biz_freight e biz_unit_cost.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  bizCostVisible,
  bizFreight,
  bizRole,
  bizUnitCost,
  situationBaseColor,
  situationBaseLabel,
  situationBases,
  situationList,
  situationOf,
  transitionAllowed,
  transitionList,
  transitionRule,
} from "../../../src/erp/domains/preferences/public.ts";

const KINDS = ["sales_orders", "purchase_orders", "service_orders", "sales_proposals", "x"];
const STATUSES = ["draft", "open", "verified", "in_progress", "agency_sale", "checkout_partial", "partially_fulfilled", "fulfilled", "cancelled", "quoted", "no_repair", "x_y", "a"];

let f;
test.before(async () => {
  f = await dualFixture();
});
test.after(() => f?.close());
const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));
const pg = (sql, args = []) => async () => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const pgRows = (sql, args = []) => async () => (await f.db.query(sql, args)).rows;

test("situações: rótulos, cores, bases, lista e situação por chave", async () => {
  for (const kind of KINDS) {
    for (const status of STATUSES)
      await f.dual("situation_base_label", pg("select erp_preferences.situation_base_label($1,$2) v", [kind, status]), () => situationBaseLabel(kind, status));
    await f.dual(
      "situation_bases",
      pgRows("select status,label,color,ordinal from erp_preferences.situation_bases($1) order by status", [kind]),
      () => situationBases(kind).sort((a, b) => (a.status < b.status ? -1 : 1)).map((b) => ({ status: b.status, label: b.label, color: b.color, ordinal: b.ordinal })),
    );
  }
  for (const status of STATUSES) await f.dual("situation_base_color", pg("select erp_preferences.situation_base_color($1) v", [status]), () => situationBaseColor(status));
  const save = (kind, data) =>
    f.rpc("erp_preferences_situation_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: kind, p_situation: null, p_expected_version: 0, p_data: data });
  const a = (await save("purchase_orders", { base_status: "open", name: "Aguardando NF", color: "#ff8800", active: true })).receipt.target;
  const b = (await save("purchase_orders", { base_status: "fulfilled", name: "Recebido conferido", color: "#00aa00", active: true })).receipt.target;
  for (const kind of ["sales_orders", "purchase_orders", "service_orders"])
    await f.dual(
      "situation_list",
      pgRows("select key,base_status,name,color,is_default,active,version,ordinal from erp_preferences.situation_list($1) order by key", [kind]),
      lite((db) =>
        situationList(db, kind)
          .sort((x, y) => (x.key < y.key ? -1 : 1))
          .map((s) => ({ key: s.key, base_status: s.base_status, name: s.name, color: s.color, is_default: s.is_default, active: s.active, version: s.version, ordinal: s.ordinal })),
      ),
    );
  for (const key of ["open", "fulfilled", a, b, "x", randomUUID()])
    await f.dual("situation_of", pg("select erp_preferences.situation_of('purchase_orders',$1) v", [key]), lite((db) => situationOf(db, "purchase_orders", key)));
  for (const from of ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled", "x"])
    for (const to of ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled", "x"])
      await f.dual("transition_allowed", pg("select erp_preferences.transition_allowed('purchase_orders',$1,$2) v", [from, to]), () => transitionAllowed("purchase_orders", from, to));
  // Transições: padrão desativada, personalizada e situação desativada.
  const transition = (from, to, data) =>
    f.rpc("erp_preferences_transition_save", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: "purchase_orders", p_from: from, p_to: to, p_expected_version: 0, p_data: data });
  await transition("fulfilled", "open", { active: false, actions: [] });
  await transition("open", a, { active: true, actions: [] });
  await transition(a, "in_progress", { active: true, actions: [] });
  await f.rpc("erp_preferences_situation_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: "purchase_orders", p_situation: b, p_expected_version: 1,
    p_data: { base_status: "fulfilled", name: "Recebido conferido", color: "#00aa00", active: false },
  });
  const keys = ["open", "in_progress", "partially_fulfilled", "fulfilled", "cancelled", a, b, "x", null];
  for (const from of keys)
    for (const to of keys)
      await f.dual("transition_rule", pg("select erp_preferences.transition_rule('purchase_orders',$1,$2) v", [from, to]), lite((db) => transitionRule(db, "purchase_orders", from, to)));
  await f.dual(
    "transition_list",
    pgRows("select from_key,to_key,is_default,active,actions,version from erp_preferences.transition_list('purchase_orders') order by from_ord,to_ord"),
    lite((db) => transitionList(db, "purchase_orders").map((t) => ({ from_key: t.from_key, to_key: t.to_key, is_default: t.is_default, active: t.active, actions: t.actions, version: t.version }))),
  );
});

test("Meu Negócio: papel, custo visível, frete do corpo e o custo da última compra", async () => {
  for (const user of [...Object.values(f.users), randomUUID(), null])
    await f.dual(
      "biz_role",
      pg("select erp_home.biz_role($1) v", [user]),
      lite((db) => bizRole(db, user)),
    ).catch((e) => {
      if (e.code !== "42501") throw e;
    });
  for (const role of ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal", "x", null])
    await f.dual("biz_cost_visible", pg("select erp_home.biz_cost_visible($1) v", [role]), () => bizCostVisible(role));
  // biz_freight devolve numeric; o motor devolve centavos: o valor exato bate com o do oráculo.
  for (const body of [{ freight: "5" }, { freight: "5.5" }, { freight: "12.34" }, { freight: "5.555" }, { freight: 7 }, { freight: "-1" }, { freight: "01" }, { freight: null }, { freight: "x" }, {}, { freight: "999999999999" }, { freight: "1000000000000" }])
    assert.equal(
      bizFreight(body),
      BigInt(Math.round(Number(await pg("select (erp_home.biz_freight($1::jsonb)*100)::bigint::text v", [JSON.stringify(body)])()))),
      JSON.stringify(body),
    );
  const contact = await f.catalog("contacts", { name: "Fornecedor do custo" });
  const p = await f.catalog("products", { name: "Produto do custo", unit: "UN", kind: "P", format: "S", price: "9" });
  const order = async (date, price, cancel = false) => {
    let d = (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_body: { date, contact_id: contact.id, items: [{ unit: "UN", product_id: p.id, description: "Produto do custo", quantity: "1", unit_price: price }] },
      })
    ).document;
    if (cancel)
      d = (
        await f.rpc("erp_document_transition", {
          p_user_id: f.users.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: "cancelled", p_reason: "Cancelamento sintético",
        })
      ).document;
    return d;
  };
  const cost = () => f.dual("biz_unit_cost", pg("select erp_home.biz_unit_cost($1)::text v", [p.id]), lite((db) => bizUnitCost(db, p.id)));
  assert.equal(await cost(), null);
  await order("2026-10-01", "1.25");
  assert.equal(Number(await cost()), 1.25);
  await order("2026-10-05", "1.5");
  await order("2026-09-01", "0.9");
  await order("2026-10-20", "2", true);
  assert.equal(Number(await cost()), 1.5, "a mais recente não cancelada");
  await f.dual("biz_unit_cost", pg("select erp_home.biz_unit_cost($1)::text v", [randomUUID()]), lite((db) => bizUnitCost(db, randomUUID())));
});
