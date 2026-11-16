// Semântica de texto do motor (src/erp/engine/text.ts) contra o oráculo:
// lower/upper em todo o Unicode, frases com sigma final e as classes \s e
// [[:cntrl:]] no plano básico.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oracleDb } from "../../scripts/erp/oracle-db.mjs";
import { pgHasCntrl, pgHasSpace, pgLower, pgUpper } from "../../src/erp/engine/text.ts";

test("lower e upper caractere a caractere, e frases", async () => {
  const db = await oracleDb();
  try {
    let checked = 0;
    for (let start = 1; start <= 0x10ffff; start += 0x10000) {
      const rows = (
        await db.query(
          "select c, 'x'||lower(chr(c)) l, 'x'||upper(chr(c)) u from generate_series($1::int,$2::int) c where c not between 55296 and 57343",
          [start, Math.min(start + 0xffff, 0x10ffff)],
        )
      ).rows;
      for (const r of rows) {
        const ch = String.fromCodePoint(r.c);
        r.l = r.l.slice(1);
        r.u = r.u.slice(1);
        assert.equal(pgLower(ch), r.l, `lower U+${r.c.toString(16)}`);
        assert.equal(pgUpper(ch), r.u, `upper U+${r.c.toString(16)}`);
        checked++;
      }
    }
    assert.ok(checked > 1_000_000);
    for (const text of ["ΟΔΟΣ ΣΣ ΟΔΟΣ.", "İSTANBUL", "straße", "Ação Ñandu", "ǅungla ǈ"]) {
      const r = (await db.query("select lower($1) l, upper($1) u", [text])).rows[0];
      assert.deepEqual([pgLower(text), pgUpper(text)], [r.l, r.u], text);
    }
  } finally {
    await db.close();
  }
});

test("\\s, [[:space:]] e [[:cntrl:]] no plano básico", async () => {
  const db = await oracleDb();
  try {
    const rows = (
      await db.query(
        "select c, chr(c) ~ '\\s' s, chr(c) ~ '[[:space:]]' sp, chr(c) ~ '[[:cntrl:]]' ct from generate_series(1,65535) c where c not between 55296 and 57343",
      )
    ).rows;
    for (const r of rows) {
      const ch = String.fromCharCode(r.c);
      assert.equal(pgHasSpace.test(ch), r.s, `\\s U+${r.c.toString(16)}`);
      assert.equal(r.s, r.sp);
      assert.equal(pgHasCntrl.test(ch), r.ct, `cntrl U+${r.c.toString(16)}`);
    }
  } finally {
    await db.close();
  }
});
