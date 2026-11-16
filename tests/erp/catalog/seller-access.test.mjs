// erp_catalog.seller_access_allowed contra o oráculo: janela de horário do
// vendedor em São Paulo, com as viradas do horário de verão de 2018
// (fim em 18/02/2018, início em 04/11/2018) e de 2019.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { sellerAccessAllowed } from "../../../src/erp/domains/catalog/public.ts";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

const seller = (name, settings) =>
  f.rpc("erp_catalog_seller_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_contact: { name }, p_settings: { ...SETTINGS, ...settings },
  });

test("janela do vendedor: dia e hora de São Paulo, horário de verão de 2018", async () => {
  const windows = [
    { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    { start: "00:30", end: "01:59", days: [0] },
    { start: "23:00", end: "23:59", days: [6] },
  ];
  await seller("Vendedor com horário", { user_id: f.users.vendas, access_hours_enabled: true, access_windows: windows });
  await seller("Vendedor sem horário ligado", { user_id: f.users.vendedor, access_hours_enabled: false, access_windows: windows });
  await seller("Vendedor sem janela", { user_id: f.users.estoque, access_hours_enabled: true, access_windows: [] });
  const instants = [
    // Início do horário de verão: 04/11/2018 00:00 vira 01:00 (domingo).
    "2018-11-04T02:59:59Z", "2018-11-04T03:00:00Z", "2018-11-04T03:29:00Z", "2018-11-04T03:30:00Z", "2018-11-04T04:59:00Z",
    // Fim: 18/02/2018 00:00 (-02) volta a 17/02 23:00 (-03, sábado).
    "2018-02-18T01:59:59Z", "2018-02-18T02:00:00Z", "2018-02-18T02:59:59Z", "2018-02-18T03:00:00Z",
    // Dentro do verão (-02) e fora (-03): 08:00 e 18:00 nas bordas.
    "2018-12-10T09:59:59Z", "2018-12-10T10:00:00Z", "2018-12-10T20:00:59Z", "2018-12-10T20:01:00Z",
    "2018-07-10T10:59:59Z", "2018-07-10T11:00:00Z", "2018-07-10T21:00:59Z", "2018-07-10T21:01:00Z",
    // 2019 (fim em 17/02) e hoje, sem horário de verão.
    "2019-02-17T01:30:00Z", "2019-02-17T02:30:00Z", "2026-11-16T11:00:00Z", "2026-11-14T02:30:00Z", "2026-11-15T03:45:00Z",
  ];
  const users = [f.users.vendas, f.users.vendedor, f.users.estoque, f.users.admin, randomUUID(), null];
  const seen = new Set();
  for (const iso of instants)
    for (const user of users) {
      const at = BigInt(Date.parse(iso)) * 1000n;
      const v = await f.dual(
        "seller_access_allowed",
        async () => (await f.db.query("select erp_catalog.seller_access_allowed($1, $2::timestamptz) v", [user, iso])).rows[0].v,
        () => inTransaction(f.driver, (ctx) => sellerAccessAllowed(ctx.db, user, at)),
      );
      if (user === f.users.vendas) seen.add(v);
    }
  assert.deepEqual([...seen].sort(), [false, true], "o vendedor com horário entra e é barrado");
});
