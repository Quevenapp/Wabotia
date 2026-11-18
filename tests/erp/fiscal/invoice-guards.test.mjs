// Gatilhos no modelo guardNature: UPDATE/DELETE desfeitos no PG, guarda no inTransaction;
// AFTER INSERT executado de verdade nos dois lados e estado comparado pelo harness.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { guardInvoice, invoiceRow, invoiceSourceRecord } from "../../../src/erp/domains/fiscal/invoices.ts";
import { invoice, seed, refused } from "./invoice-fixture.mjs";
let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
function attempt(id, patch = {}, op = "UPDATE") {
  return f.dual(
    "guard_invoice",
    async () => {
      await f.db.exec("begin");
      try {
        if (op === "DELETE") await f.db.query("delete from erp_fiscal_invoices.invoice where id=$1", [id]);
        else {
          const change = { version: 2, ...patch };
          await f.db.query(
            `update erp_fiscal_invoices.invoice set ${Object.keys(change)
              .map((k, i) => `${k}=$${i + 2}`)
              .join(",")} where id=$1`,
            [id, ...Object.values(change)],
          );
        }
        return "ok";
      } finally {
        await f.db.exec("rollback");
      }
    },
    () =>
      inTransaction(f.driver, (ctx) => {
        const old = invoiceRow(ctx.db, id);
        guardInvoice(op, old, op === "DELETE" ? null : { ...old, version: 2, ...patch });
        return "ok";
      }),
  );
}
test("guard_invoice: identidade, incremento exato, limite de versão, nota excluída e DELETE", async () => {
  const id = await invoice(f);
  await attempt(id, { nature_description: "Alterada" });
  for (const patch of [
    { version: 1 },
    { version: 3 },
    { id: randomUUID() },
    { model: "65" },
    { direction: "0" },
    { created_at: "2026-11-13T00:00:00Z" },
    { created_by: f.users.fiscal },
    { environment: "1" },
  ])
    await assert.rejects(attempt(id, patch), refused("40001", "erp_fiscal_invoice_immutable_identity"));
  await assert.rejects(attempt(id, {}, "DELETE"), refused("42501", "erp_fiscal_invoice_no_delete"));
  const deleted = await invoice(f, { deleted_at: "2026-11-13T00:00:00Z", deleted_by: f.users.admin, delete_reason: "Excluída" });
  await assert.rejects(attempt(deleted), refused("40001", "erp_fiscal_invoice_immutable_identity"));
  const max = await invoice(f, { version: 2147483647 });
  await assert.rejects(attempt(max, { version: 2147483647 }), refused("40001", "erp_fiscal_invoice_immutable_identity"));
});
test("guard_invoice: protocolo, autorização e chave; chave pode mudar nos tipos T/S/X", async () => {
  const id = await invoice(f);
  for (const patch of [{ protocol: "1".repeat(15) }, { authorized_at: "2026-11-13T00:00:00Z" }, { access_key: "1".repeat(44) }])
    await assert.rejects(attempt(id, patch), refused("42501", "erp_fiscal_invoice_authorization_immutable"));
  for (const issue_type of ["T", "S", "X"]) {
    const imported = await invoice(f, { issue_type, direction: issue_type === "X" ? "0" : "1", environment: null });
    await attempt(imported, { access_key: "2".repeat(44) });
  }
});
async function insertXml(id, xml) {
  const sha = createHash("sha256").update(xml).digest("hex"),
    size = Buffer.byteLength(xml);
  return f.dual(
    "invoice_source_record",
    async () => {
      await f.db.query(
        `insert into erp_fiscal_invoices.invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by) values($1,$2,$3,$4,true,'100',$5)`,
        [id, sha, size, xml, f.users.admin],
      );
      return "ok";
    },
    () =>
      inTransaction(f.driver, (ctx) => {
        ctx.db.exec(
          `insert into erp_fiscal_invoices__invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by,imported_at) values(?,?,?,?,1,'100',?,?)`,
          id,
          sha,
          size,
          xml,
          f.users.admin,
          ctx.clock.next().toString(),
        );
        invoiceSourceRecord(ctx, { invoice_id: id, sha256: sha, content: xml });
        return "ok";
      }),
  );
}
test("invoice_source_record: ambientes iguais, diferentes, ausentes, multiline e primeira fonte imutável", async () => {
  for (const [xml, environment] of [
    ['<ide><tpAmb>1</tpAmb></ide><infProt Id="x"><tpAmb>1</tpAmb></infProt>', "1"],
    ["<ide>\n<tpAmb>2</tpAmb>\n</ide><infProt>\n<tpAmb>2</tpAmb>\n</infProt>", "2"],
    ["<ide><tpAmb>1</tpAmb></ide><infProt><tpAmb>2</tpAmb></infProt>", null],
    ["<ide><tpAmb>1</tpAmb></ide>", null],
    ["<n:ide><tpAmb>1</tpAmb></n:ide><infProt><tpAmb>1</tpAmb></infProt>", null],
  ]) {
    const id = await invoice(f, { issue_type: "S", environment: null });
    await insertXml(id, xml);
    assert.equal(await f.scalar("select source_environment from erp_fiscal_invoices.invoice_source where invoice_id=$1", [id]), environment);
  }
  const id = await invoice(f, { issue_type: "S", environment: null });
  await seed(f, "insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment) values($1,$2,'1')", [id, "a".repeat(64)]);
  await insertXml(id, "<ide><tpAmb>2</tpAmb></ide><infProt><tpAmb>2</tpAmb></infProt>");
  assert.equal(await f.scalar("select xml_sha256 from erp_fiscal_invoices.invoice_source where invoice_id=$1", [id]), "a".repeat(64));
});
