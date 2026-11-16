// Documentos (escrito pela G para o domínio 11; dono: Documentos): erp_documents.os_permitted, require_role, require_access
// e contact_usable, e erp_document_mirror.visible, require_visible e report_coverage (documents/reads-g.ts) contra o oráculo.
// O espelho do Origin saiu: os documentos aqui são nativos (authority 'brufap', origin_mirror vazia), o único caso que a
// instalação do Wabotia tem; o ramo do espelho não é portado.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  contactUsable,
  mirrorRequireVisible,
  mirrorVisible,
  osPermitted,
  reportCoverage,
  requireAccess,
  requireRole,
} from "../../../src/erp/domains/documents/public.ts";

const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};
const KINDS = ["sales_proposals", "sales_orders", "purchase_orders", "service_orders", "x", null];

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));
const pg = (sql, args) => async () => (await f.db.query(sql, args)).rows[0].v;
// f.dual compara o erro dos dois motores e o relança: a recusa esperada (42501) vira o texto da mensagem.
const denied = (p) => p.then(() => "ok", (e) => (e.code === "42501" ? e.message : Promise.reject(e)));
const users = () => [f.users.admin, f.users.consulta, f.users.vendas, f.users.vendedor, f.users.financeiro, f.users.estoque, f.users.fiscal, f.users.inactive, randomUUID(), null];

async function checkAccess() {
  for (const user of users())
    for (const kind of KINDS)
      for (const write of [false, true]) {
        await denied(f.dual("require_role", pg("select erp_documents.require_role($1,$2,$3)::text v", [user, kind, write]), lite((db) => (requireRole(db, user, kind, write), ""))));
        await denied(f.dual("require_access", pg("select erp_documents.require_access($1,$2,$3)::text v", [user, kind, write]), lite((db) => (requireAccess(db, user, kind, write), ""))));
      }
  for (const user of users().filter((u) => u !== null))
    for (const key of [null, "ie", "x"])
      await f.dual("os_permitted", pg("select erp_documents.os_permitted($1,$2) v", [user, key]), lite((db) => osPermitted(db, user, key)));
}

test("os_permitted, require_role e require_access: papel, cartão do documento e o .ie para gravar", async () => {
  await checkAccess();
  // Permissões por usuário (Sistema › Usuários): vendas sem o cartão de pedidos; estoque sem o .ie de compras; fiscal sem OS.
  const control = (user, permissions) =>
    f.db.query(
      "insert into erp_access.user_control(user_id,permissions,version,updated_at,updated_by) values($1,$2,1,now(),$3) on conflict(user_id) do update set permissions=excluded.permissions",
      [user, permissions, f.users.admin],
    );
  await control(f.users.vendas, ["vendas", "vendas.propostas", "vendas.propostas.ie", "servicos", "servicos.ordem_servico"]);
  await control(f.users.estoque, ["suprimentos", "suprimentos.pedidos_compra"]);
  await control(f.users.consulta, []);
  await f.sync();
  await checkAccess();
});

test("contact_usable, visible, require_visible e report_coverage: carteira do vendedor, consumidor do PDV e documento nativo", async () => {
  const seller = await f.rpc("erp_catalog_seller_save", {
    p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_contact: { name: "Vendedor dos documentos" }, p_settings: { ...SETTINGS, user_id: f.users.vendedor },
  });
  const mine = (await f.save({ name: "Cliente da carteira" })).record;
  const other = (await f.save({ name: "Cliente de ninguém" })).record;
  const consumer = (await f.save({ name: "Consumidor final" })).record;
  await f.rpc("erp_catalog_contact_set_seller", {
    p_user_id: f.users.admin, p_id: mine.id, p_expected_version: mine.version, p_command_id: randomUUID(), p_seller_id: seller.seller.id,
  });
  await f.db.query(
    "insert into erp_pos.settings(singleton,consumer_contact_id,version,updated_by,updated_at) values(true,$1,1,$2,now()) on conflict(singleton) do update set consumer_contact_id=excluded.consumer_contact_id",
    [consumer.id, f.users.admin],
  );
  await f.sync();
  const doc = async (contact) =>
    (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
        p_body: { date: "2026-10-20", contact_id: contact, items: [{ unit: "UN", description: "Item sintético", quantity: "1", unit_price: "10" }] },
      })
    ).document.id;
  const docs = [await doc(mine.id), await doc(other.id), await doc(consumer.id), randomUUID(), null];
  const contacts = [mine.id, other.id, consumer.id, randomUUID(), null];
  const check = async () => {
    for (const user of [f.users.vendedor, f.users.admin, f.users.consulta, f.users.inactive, null]) {
      for (const contact of contacts)
        await f.dual("contact_usable", pg("select erp_documents.contact_usable($1,$2) v", [user, contact]), lite((db) => contactUsable(db, user, contact)));
      for (const id of docs) {
        await f.dual("visible", pg("select erp_document_mirror.visible($1,$2) v", [user, id]), lite((db) => mirrorVisible(db, user, id)));
        for (const write of [false, true])
          await f.dual(
            "require_visible",
            pg("select erp_document_mirror.require_visible($1,$2,$3)::text v", [user, id, write]),
            lite((db) => (mirrorRequireVisible(db, user, id, write), "")),
          );
      }
      for (const kind of [null, "sales_orders", "service_orders"])
        for (const contact of [null, mine.id])
          await f.dual(
            "report_coverage",
            pg("select erp_document_mirror.report_coverage($1,$2,$3,$4,$5) v", [user, kind, null, "2026-12-31", contact]),
            () => reportCoverage(),
          );
    }
  };
  await check();
  await f.preference("contatos.acesso_vendedor", true);
  try {
    await check();
    const usable = await inTransaction(f.driver, (ctx) => [mine.id, other.id, consumer.id].map((c) => contactUsable(ctx.db, f.users.vendedor, c)));
    assert.deepEqual(usable, [true, false, true], "a carteira e o consumidor do PDV");
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
});
