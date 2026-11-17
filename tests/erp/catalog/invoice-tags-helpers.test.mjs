// Etiquetas de nota, funções sem o Fiscal (catalog/invoice-tags.ts, sessão B, bloco C) contra
// o oráculo: invoice_tag_key_valid, invoice_tag_ids, invoice_tags_data, invoice_tag_target
// (nota nativa e nota espelhada do Origin em origin_sync.raw_record) e invoice_tag_bump.
// Os RPCs invoice_tags e _save esperam o export do Fiscal da G no tronco.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import {
  invoiceTagBump,
  invoiceTagIds,
  invoiceTagKeyValid,
  invoiceTagTarget,
  invoiceTagsData,
} from "../../../src/erp/domains/catalog/public.ts";
import { auxFixture } from "./aux-fixture.mjs";

let f, tags;
const HASH = "b".repeat(64);
before(async () => {
  f = await auxFixture();
  const group = (await f.taxonomySave("tag_groups", { name: "Grupo de notas", tag_type: "invoices" })).item;
  tags = [];
  for (const [name, parent] of [["Zeta", null], ["álamo", group.id], ["Beta", null]])
    tags.push((await f.taxonomySave("tags", parent ? { name, parent_id: parent } : { name, tag_type: "invoices" })).item.id);
  // Nota espelhada do Origin (NF-e 123) e as etiquetas dela, sem gatilhos, nos dois motores.
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(
      `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','notas/nfe','123','{"id":123}'::jsonb,$1)`,
      [HASH],
    );
    for (const tag of tags) await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin','55','123',$1)`, [tag]);
    await f.db.query(
      `insert into erp_catalog.invoice_tag_state(origin,model,invoice_id,version,updated_by,updated_at) values('origin','55','123',3,$1,now())`,
      [f.users.admin],
    );
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
});
after(async () => f?.close());

const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx));
const pg = (sql, args) => async () => (await f.db.query(sql, args)).rows[0].v;

test("invoice_tag_key_valid: modelo e chave por origem", async () => {
  for (const origin of ["origin", "brufap", "outra", null])
    for (const model of ["55", "65", "57", null])
      for (const id of ["123", "0".repeat(41), randomUUID(), randomUUID().toUpperCase(), "", null])
        await f.dual("invoice_tag_key_valid", pg("select erp_catalog.invoice_tag_key_valid($1,$2,$3) v", [origin, model, id]), () =>
          invoiceTagKeyValid(origin, model, id),
        );
});

test("invoice_tag_ids e invoice_tags_data: ordem de texto e de nome, grupo, versão", async () => {
  for (const [origin, model, id] of [["origin", "55", "123"], ["origin", "65", "123"], ["brufap", "55", randomUUID()]]) {
    await f.dual("invoice_tag_ids", pg("select erp_catalog.invoice_tag_ids($1,$2,$3) v", [origin, model, id]), lite((ctx) => invoiceTagIds(ctx.db, origin, model, id)));
    await f.dual("invoice_tags_data", pg("select erp_catalog.invoice_tags_data($1,$2,$3) v", [origin, model, id]), lite((ctx) => invoiceTagsData(ctx.db, origin, model, id)));
  }
  const data = (await f.db.query("select erp_catalog.invoice_tags_data('origin','55','123') v")).rows[0].v;
  assert.equal(data.version, 3);
  assert.deepEqual(data.tags.map((t) => t.name), ["álamo", "Beta", "Zeta"]);
  assert.equal(data.tags[0].group_name, "Grupo de notas");
});

test("invoice_tag_target: nota espelhada do Origin (raw_record) e nota nativa inexistente", async () => {
  for (const [origin, model, id] of [["origin", "55", "123"], ["origin", "65", "123"], ["origin", "55", "999"], ["brufap", "55", randomUUID()], ["outra", "55", "123"]])
    await f.dual("invoice_tag_target", pg("select erp_catalog.invoice_tag_target($1,$2,$3) v", [origin, model, id]), lite((ctx) => invoiceTagTarget(ctx.db, origin, model, id)));
  assert.equal((await f.db.query("select erp_catalog.invoice_tag_target('origin','55','123') v")).rows[0].v, true, "a nota espelhada é alvo");
});

test("invoice_tag_bump: cria a versão 1, sobe e recusa no teto", async () => {
  const bump = (origin, model, id) =>
    f.dual(
      "invoice_tag_bump",
      async () => (await f.db.query("select erp_catalog.invoice_tag_bump($1,$2,$3,$4)", [f.users.admin, origin, model, id]), null),
      lite((ctx) => (invoiceTagBump(ctx, f.users.admin, origin, model, id), null)),
    );
  await bump("origin", "55", "123");
  await bump("origin", "65", "777");
  await bump("origin", "65", "777");
  assert.equal(await f.scalar("select version v from erp_catalog.invoice_tag_state where origin='origin' and model='65' and invoice_id='777'"), 2);
  await f.db.query("update erp_catalog.invoice_tag_state set version=2147483647 where origin='origin' and model='65' and invoice_id='777'");
  await f.sync();
  await assert.rejects(bump("origin", "65", "777"), (e) => e.code === "40001");
});
