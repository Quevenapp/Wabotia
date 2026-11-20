// O SQL distingue uma chave ausente (SQL NULL) de JSON null no envelope de
// uma linha. A API normaliza o envelope, mas o RPC mantém a definição 300.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { callRpc, isPorted } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

const RPC = "erp_preferences_import_batch";
let f;
const args = (row, extra = {}) => ({ p_user_id: f.users.admin, p_command_id: randomUUID(), p_job_id: randomUUID(),
  p_kind: "products", p_file_name: "formato.csv", p_total_rows: 1, p_dry_run: false, p_rows: [row], ...extra });
const rejects = (message, code) => (error) => error.message === message && error.code === code;
before(async () => { assert.equal(isPorted(RPC), true); f = await dualFixture(); });
after(async () => { await f?.close(); });

test("data ausente passa a regra ternária e produz recusa da linha, na prévia e confirmação", async () => {
  for (const dry of [true, false]) {
    const out = await f.rpc(RPC, args({ row: 2, lines: [2], extra: "chave adicional" }, { p_dry_run: dry }));
    assert.equal(out.items[0].status, "invalid");
    assert.equal(out.items[0].reason, "erp_catalog_invalid_command");
    assert.equal(out.job?.invalid ?? 0, dry ? 0 : 1);
  }
});

test("lines ausente: prévia válida, confirmação recusa o vetor vazio e reverte o produto", async () => {
  const row = { row: 2, data: { code: "SHAPE-SEM-LINHAS", name: "Sem linhas" }, extra: "chave adicional" };
  const out = await f.rpc(RPC, args(row, { p_dry_run: true }));
  assert.equal(out.items[0].status, "valid");
  await assert.rejects(f.rpc(RPC, args(row)), rejects('new row for relation "import_row" violates check constraint "import_row_check"', "23514"));
  assert.equal(await f.scalar("select count(*)::integer from erp_catalog.record where code='SHAPE-SEM-LINHAS'"), 0);
});

test("JSON null continua inválido no envelope", async () => {
  for (const dry of [false, true]) for (const row of [
    { row: 2, lines: [2], data: null }, { row: 2, lines: null, data: { name: "JSON null" } },
  ]) await assert.rejects(f.rpc(RPC, args(row, { p_dry_run: dry })), rejects("erp_preferences_import_invalid", "22023"));
});

test("família nula/desconhecida mantém o erro do RPC, mesmo com outra parte desligada", async () => {
  const row = { row: 2, lines: [2], data: { name: "Tipo inválido" } };
  for (const kind of [null, "desconhecida"]) {
    const input = args(row, { p_kind: kind });
    await assert.rejects(f.rpc(RPC, input), rejects("erp_preferences_import_invalid", "22023"));
    assert.throws(() => callRpc(f.driver, RPC, input, f.clock, { parts: normalizeErpParts({ finance: false }) }), rejects("erp_preferences_import_invalid", "22023"));
  }
});

test("lines usa o cast integer do PostgreSQL17 e falha fora da subtransação da linha", async () => {
  const valid = await f.rpc(RPC, args({ row: 2, lines: [2, "0xA", "0o7", "0b11", "1_000", "+8", null], data: { code: "SHAPE-CAST", name: "Casts" } }));
  assert.equal(valid.items[0].status, "created");
  const lines = await f.scalar("select array_to_json(lines) from erp_preferences.import_row where job_id=$1", [valid.job.id]);
  assert.deepEqual(lines, [2, 10, 7, 3, 1000, 8, null]);
  for (const [cast, code] of [["2.5", "22P02"], ["2147483648", "22003"], [{ row: 3 }, "22P02"]]) {
    const input = args({ row: 2, lines: [2, cast], data: { code: "SHAPE-CAST-ROLLBACK", name: "Reverter" } });
    await assert.rejects(f.rpc(RPC, input), (error) => error.code === code);
    assert.equal(await f.scalar("select count(*)::integer from erp_catalog.record where code='SHAPE-CAST-ROLLBACK'"), 0);
  }
});
