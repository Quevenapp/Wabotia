// Ensaio de uma planilha inteira; a paridade dos lotes de 50 itens e os
// tetos acima do limite estão em spreadsheet-import.test.mjs. Sem oráculo
// nesta medição, para não incluir seu scan de todas as tabelas por lote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

test("escala SQLite: 10.000 produtos novos em 200 lotes retomáveis, sem duplicar ao repetir", { timeout: 240_000 }, () => {
  const lite = freshLite(), driver = nodeDriver(lite), job = randomUUID(), user = randomUUID();
  const now = "1795089600000000";
  driver.exec("INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,'admin',1,?,?)", user, now, now);
  driver.exec("INSERT INTO erp_access__profile(user_id,name,version,updated_by,updated_at) VALUES(?,'Admin escala',1,?,?)", user, user, now);
  const exec = driver.exec.bind(driver);
  let stamp = BigInt(now);
  const clock = { next: () => ++stamp, get latest() { return stamp; } };
  let queryCount = 0, maxParams = 0, maxTerms = 0;
  driver.exec = (sql, ...params) => {
    const terms = 1 + (sql.match(/\bUNION\s+ALL\b/gi)?.length ?? 0);
    assert.ok(terms <= 5, "máximo de cinco termos por composição SQL");
    queryCount++;
    maxParams = Math.max(maxParams, params.length);
    maxTerms = Math.max(maxTerms, terms);
    return exec(sql, ...params);
  };
  const started = performance.now(), commands = [];
  try {
    for (let offset = 0; offset < 10000; offset += 50) {
      const input = {
        p_user_id: user, p_command_id: randomUUID(), p_job_id: job, p_kind: "products",
        p_file_name: "escala.csv", p_total_rows: 10000, p_dry_run: false,
        p_rows: Array.from({ length: 50 }, (_, index) => ({ row: offset + index + 2, lines: [offset + index + 2], data: {
          code: `ESCALA-${offset + index}`, name: `Produto escala ${offset + index}`, unit: "UN", price: "1.25",
        } })),
      };
      commands.push(input);
      const result = callRpc(driver, "erp_preferences_import_batch", input, clock, { parts: normalizeErpParts() });
      assert.equal(result.job.rows_done, offset + 50);
      assert.equal(result.job.created, offset + 50);
      assert.equal(result.job.invalid, 0);
      assert.equal(result.job.status, offset === 9950 ? "concluida" : "em_andamento");
    }
    const replay = callRpc(driver, "erp_preferences_import_batch", commands[0], clock, { parts: normalizeErpParts() });
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.rows_done, 10000);
    assert.equal(lite.prepare("SELECT count(*) n FROM erp_catalog__record WHERE code LIKE 'ESCALA-%'").get().n, 10000);
    console.log(`planilha máxima: 10000 produtos, 200 lotes; ${Math.round(performance.now() - started)} ms, ${queryCount} SQLs, máximo ${maxParams} parâmetros e ${maxTerms} termos UNION ALL`);
  } finally { lite.close(); }
});
