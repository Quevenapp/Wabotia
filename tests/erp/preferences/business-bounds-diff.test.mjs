// O limite é aplicado no SQL antes de materializar metas; a ordem continua
// a collation C do oráculo e o total inclui as metas fora da primeira página.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

test("metas: ordem e limite de 200 iguais ao PostgreSQL, sem materializar a tabela inteira", async () => {
  const f = await dualFixture();
  try {
    const command = randomUUID();
    await f.db.query("INSERT INTO erp_home.goal_command(id,actor,request_hash,result) VALUES($1,$2,repeat('a',64),'{}')", [command, f.users.admin]);
    await f.db.query(`INSERT INTO erp_home.goal(id,name,start_on,end_on,segment,seller,target,active,version,created_by,created_at,updated_by,updated_at,command_id)
      SELECT gen_random_uuid(),'Meta '||lpad(n::text,3,'0'),'2026-01-01','2026-01-31','geral',null,100,false,1,$1,'2026-01-01T03:00:00Z',$1,'2026-01-01T03:00:00Z',$2
      FROM generate_series(1,205) n`, [f.users.admin, command]);
    await f.sync();
    const exec = f.driver.exec.bind(f.driver), goalReads = [];
    f.driver.exec = (sql, ...args) => {
      const result = exec(sql, ...args);
      if (/FROM "erp_home__goal"/.test(sql)) goalReads.push({ sql, rows: result.rows.length, args });
      return result;
    };
    const value = await f.rpc("erp_home_business_panel", { p_user_id: f.users.admin, p_panel: "metas", p_args: { p_tab: "inativas" } });
    assert.equal(value.total, 205);
    assert.equal(value.items.length, 200);
    assert.equal(value.items[0].name, "Meta 001");
    assert.equal(value.items.at(-1).name, "Meta 200");
    assert.ok(goalReads.some(r => r.rows === 200 && /ORDER BY end_on,start_on,name,id LIMIT \?/.test(r.sql)));
    assert.ok(goalReads.every(r => r.rows <= 200));
  } finally { await f.close(); }
});

test("metas: vendedores distintos, Unicode e limite de 200 iguais ao PostgreSQL", async () => {
  const f = await dualFixture();
  try {
    const contact = await f.catalog("contacts", { name: "Cliente de teste" });
    const saved = await f.rpc("erp_document_save", { p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null,
      p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: "2026-11-01", contact_id: contact.id,
        items: [{ description: "Serviço", unit: "UN", quantity: "1", unit_price: "1" }] } });
    const labels = ["Ana", "Zeca", "Ágata", "Érica", "Íris", "😀 Anônimo", "A".repeat(79) + " " + "B", "Ana", null];
    const insert = async (values, start) => f.db.query(`INSERT INTO erp_documents.document(id,kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)
      SELECT gen_random_uuid(),d.kind,$3+n,d.status,d.contact_id,d.contact_snapshot,
        jsonb_set(d.body,'{commercial}',jsonb_build_object('seller_reference',jsonb_build_object('system','origin','source_id','7','label',labels.label))),
        d.total,d.created_by,d.updated_by FROM erp_documents.document d,
        jsonb_array_elements($2::jsonb) WITH ORDINALITY labels(label,n) WHERE d.id=$1`, [saved.document.id, JSON.stringify(values), start]);
    await insert(labels, 1000);
    await f.sync();
    const args = { p_user_id: f.users.admin, p_panel: "metas", p_args: { p_tab: "andamento" } };
    const first = await f.rpc("erp_home_business_panel", args);
    assert.deepEqual(first.sellers, ["A".repeat(79), "Ana", "Vendedor 7", "Zeca", "Ágata", "Érica", "Íris", "😀 Anônimo"]);
    await insert(Array.from({ length: 205 }, (_, i) => "Vendedor " + String(i).padStart(3, "0")), 2000);
    await f.sync();
    const exec = f.driver.exec.bind(f.driver), reads = [];
    f.driver.exec = (sql, ...args) => {
      const result = exec(sql, ...args);
      if (/SELECT DISTINCT coalesce\(/.test(sql)) reads.push({ sql, size: result.rows.length });
      return result;
    };
    assert.equal((await f.rpc("erp_home_business_panel", args)).sellers.length, 200);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].size, 200);
    assert.match(reads[0].sql, /ORDER BY seller LIMIT 200/);
  } finally { await f.close(); }
});
