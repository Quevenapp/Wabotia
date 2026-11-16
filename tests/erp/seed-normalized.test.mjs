// Semeadura (seed.generated.ts): as colunas que o motor calcula (__fold e
// calculadas) vêm preenchidas, com o mesmo valor que a escrita do motor
// grava. Antes ficavam NULL nas linhas semeadas (tipos de contato do sistema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERP_SEED } from "../../src/erp/schema/seed.generated.ts";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { fold } from "../../src/erp/domains/catalog/internal.ts";
import { pgLower } from "../../src/erp/engine/text.ts";

test("semeadura: coluna normalizada presente e preenchida quando a origem não é NULL", () => {
  let checked = 0;
  for (const t of ERP_SEED) {
    const info = ERP_TABLES[t.table];
    for (const [name, spec] of Object.entries(info.columns)) {
      if (!["fold", "computed"].includes(spec.codec)) continue;
      assert.ok(t.columns.includes(name), `${t.table}.${name} fora da semeadura`);
      const at = t.columns.indexOf(name);
      for (const row of t.rows) {
        const source = spec.of ? row[t.columns.indexOf(spec.of)] : undefined;
        if (spec.of && source === null) continue;
        assert.notEqual(row[at], null, `${t.table}.${name} NULL com ${spec.of ?? "origem"} preenchida`);
        // O mesmo ajudante da escrita: erp_catalog.fold → fold (catalog), lower → pgLower (engine/text.ts).
        if (/^erp_catalog\.fold\(/.test(spec.generated_by)) assert.equal(row[at], fold(source), `${t.table}.${name}`);
        else if (/^lower\(/.test(spec.generated_by)) assert.equal(row[at], pgLower(source), `${t.table}.${name}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, "nenhuma linha semeada com coluna normalizada: o teste não confere nada");
});
