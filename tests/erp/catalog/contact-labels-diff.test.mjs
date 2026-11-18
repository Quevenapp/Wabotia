// erp_catalog_contact_labels nos dois motores: modelos padrão de contato e os
// salvos (ordem lower(descrição), id), valores de cada contato (endereço com e
// sem complemento, cidade/UF, campos vazios), ordem pedida, trilha, carteira
// do vendedor e recusas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

async function same(name, args) {
  try {
    return await f.rpc(name, args);
  } catch (e) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return { error: `${e.code}:${e.message}` };
  }
}

test("etiquetas de contato", async () => {
  const full = (
    await f.save({
      name: "  Contato  completo ", person_type: "J", trade_name: "Fantasia  Ltda", phone: "(19) 3434-0000", postal_code: "13400-000",
      street: "Rua das Flores", number: "12", complement: "  sala 3 ", district: "Centro", city: "Piracicaba", state: "SP", types: ["customer"],
    })
  ).record;
  const bare = (await f.save({ name: "Só nome" })).record;
  const noNumber = (await f.save({ name: "Sem número", street: "Avenida", complement: "   ", city: "Campinas" })).record;
  await f.db.exec("set session_replication_role = replica");
  try {
    for (const description of ["zeta modelo", "Álamo", "alfa", "Beta"])
      await f.db.query(
        `insert into erp_preferences.label_template(id,type,description,config,version,created_at,created_by,updated_at,updated_by,command_id)
         values($1,'contato',$2,'{"label":{"width":"50"}}'::jsonb,3,now(),$3,now(),$3,$4)`,
        [randomUUID(), description, f.users.admin, randomUUID()],
      );
    await f.db.query(
      `insert into erp_preferences.label_template(id,type,description,config,version,created_at,created_by,updated_at,updated_by,command_id)
       values($1,'produto','De produto','{}'::jsonb,1,now(),$2,now(),$2,$3)`,
      [randomUUID(), f.users.admin, randomUUID()],
    );
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
  const r = await same("erp_catalog_contact_labels", { p_user_id: f.users.admin, p_ids: [noNumber.id, full.id, bare.id] });
  assert.deepEqual(r.items.map((i) => i.id), [noNumber.id, full.id, bare.id]);
  assert.equal(r.templates.length, 5);
  for (const user of [f.users.consulta, f.users.vendas, f.users.vendedor])
    await same("erp_catalog_contact_labels", { p_user_id: user, p_ids: [full.id] });
  await f.preference("contatos.acesso_vendedor", true);
  try {
    await same("erp_catalog_contact_labels", { p_user_id: f.users.vendedor, p_ids: [full.id] });
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
  for (const [ids, code] of [
    [null, /22023/], [[], /22023/], [[full.id, full.id], /22023/], [[full.id, null], /22023/],
    [Array.from({ length: 101 }, () => randomUUID()), /22023/], [[randomUUID()], /P0002/],
  ])
    assert.match((await same("erp_catalog_contact_labels", { p_user_id: f.users.admin, p_ids: ids })).error, code);
  assert.match((await same("erp_catalog_contact_labels", { p_user_id: f.users.inactive, p_ids: [full.id] })).error, /42501/);
});
