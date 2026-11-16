// SqlDriver (src/erp/engine/driver.ts) sobre node:sqlite, para os testes do
// motor fora do workerd. Mesmo contrato do objeto: execução síncrona,
// transação aninhada como savepoint, inteiro lido como número.
import { DatabaseSync } from "node:sqlite";
import { ERP_DDL } from "../../../src/erp/schema/ddl.ts";
import { ERP_SEED } from "../../../src/erp/schema/seed.generated.ts";

const READS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;

export function nodeDriver(db) {
  let depth = 0;
  return {
    db,
    exec(sql, ...params) {
      for (const p of params)
        if (typeof p === "bigint" || typeof p === "boolean")
          throw new TypeError(`Parâmetro ${typeof p} não é aceito pelo objeto (use texto ou 0/1).`);
      if (params.length > 100) throw new Error("too many SQL variables");
      const st = db.prepare(sql);
      if (READS.test(sql)) {
        const rows = st.all(...params);
        return { rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const r = st.run(...params);
      return { rows: [], rowsRead: 0, rowsWritten: Number(r.changes) };
    },
    transaction(fn) {
      const name = `erp_sp_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/** Banco SQLite novo com o esquema gerado e a semeadura. */
export function freshLite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const s of ERP_DDL) db.exec(s);
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys=ON");
  const q = (id) => `"${id.replace(/"/g, '""')}"`;
  for (const t of ERP_SEED) {
    const ins = db.prepare(`INSERT INTO ${q(t.table)} (${t.columns.map(q).join(",")}) VALUES (${t.columns.map(() => "?").join(",")})`);
    for (const r of t.rows) ins.run(...r);
  }
  db.exec("COMMIT");
  return db;
}
