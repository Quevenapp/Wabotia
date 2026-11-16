// Atividade (erp_activity_list e erp_activity_detail) nos dois motores, com
// alterações de vários domínios: cadastro, empresa, estoque e preferências.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

const f = await dualFixture();
test.after(() => f.close());
const { users } = f;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (e.code === "ERR_ASSERTION") throw e;
    return { error: e.code };
  }
};
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const list = (o = {}) =>
  f.rpc("erp_activity_list", {
    p_user_id: users.admin, p_from: today, p_to: today, p_module: null, p_operation: null, p_actor: null, p_query: null, p_limit: 20, p_offset: 0, ...o,
  });

test("linha do tempo com cadastro, empresa, estoque e preferências; filtros, busca, páginas e detalhe", async () => {
  // Alterações em vários domínios (os não portados rodam no oráculo e são espelhados).
  const product = await f.catalog("products", { name: "Parafuso de atividade", code: "ATV-1", unit: "UN", kind: "P" });
  const warehouse = await f.catalog("warehouses", { name: "Depósito de atividade" });
  await f.rpc("erp_company_save_identity", {
    p_user_id: users.admin, p_expected_version: 0, p_command_id: randomUUID(), p_reason: null,
    p_data: { legal_name: "Empresa da atividade", trade_name: null, cnpj: "11222333000181", ie: null, postal_code: "13400000", street: "Rua A", number: "1", complement: null, district: "Centro", city: "Piracicaba", municipality_code: "3538709", state: "SP", phone: null, email: null },
  });
  await f.rpc("erp_stock_post", {
    p_user_id: users.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: today, p_reason: "Entrada para a atividade",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "2", expected_version: 0 }], p_reference: "REF-ATV",
  });
  await f.rpc("erp_preferences_save", {
    p_user_id: users.admin, p_command_id: randomUUID(), p_page: "cadastros-produtos",
    p_changes: [{ key: "produtos.cadastro_auto_vendas", expected_version: 0, value: true }],
  });
  const all = await list();
  assert.ok(all.total >= 5, JSON.stringify(all.items.map((i) => i.source)));
  for (const o of [
    { p_module: "produtos" }, { p_module: "estoque" }, { p_operation: "criacao" }, { p_actor: users.estoque }, { p_query: "parafuso" },
    { p_query: "  ATV  " }, { p_query: "nada disso" }, { p_limit: 2 }, { p_limit: 2, p_offset: 2 }, { p_module: "x" }, { p_limit: 0 },
    { p_from: "2026-01-01", p_to: "2027-06-01" }, { p_user_id: users.vendas },
  ])
    await outcome(list(o));
  for (const item of all.items)
    await outcome(f.rpc("erp_activity_detail", { p_user_id: users.admin, p_source: item.source, p_entry_id: item.id }));
  for (const [source, id] of [["catalog", "999999"], ["catalog", "abc"], ["x", "1"], ["stock", "abc-1"], [null, "1"]])
    await outcome(f.rpc("erp_activity_detail", { p_user_id: users.admin, p_source: source, p_entry_id: id }));
});
