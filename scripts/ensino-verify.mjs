// Verificação local sem rede, Vitest, Wrangler, arquivos temporários ou escrita no repositório.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const compile = (source, fileName = "module.ts") => ts.transpileModule(source, { fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const types = url(compile(await readFile("src/types.ts", "utf8")).outputText);
const model = await import(url(compile((await readFile("src/modules/ensino/model.ts", "utf8")).replace('"../../types"', JSON.stringify(types))).outputText));
const mark = (score, extra = {}) => ({ id: "a", title: "Prova", max_score: 10, weight: 1, kind: "regular", status: "graded", score, ...extra });
assert.equal(model.calculate([mark(7.5), mark(90, { max_score: 100 })], model.defaultRule).final, 8.3);
assert.equal(model.calculate([mark(1), mark(1.01)], { ...model.defaultRule, decimals: 2 }).final, 1.01);
assert.equal(model.calculate([mark(5), mark(9, { weight: 3 })], { ...model.defaultRule, method: "weighted" }).final, 8);
assert.equal(model.calculate([mark(0)], model.defaultRule).final, 0);
assert.equal(model.calculate([mark(null, { status: "absent" })], model.defaultRule).final, null);
assert.equal(model.calculate([mark(4), mark(8, { kind: "recovery" })], { ...model.defaultRule, recovery: { mode: "weighted", base_weight: 1, recovery_weight: 3, cap: 10 } }).final, 7);
assert.equal(model.frequency([{ status: "held", attendance: null }, { status: "cancelled", attendance: "absent" }], false).pending, 1);
assert.throws(() => model.periods([{ id: "p", name: "P", start: "2025-02-30", end: "2025-03-01" }], "2025-01-01", "2025-12-31"));

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
// Pais mínimos com as chaves reais; os DDL novos são aplicados sem adaptação.
db.exec("CREATE TABLE os_orders(profile_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(profile_id,id)); CREATE TABLE os_people(profile_id TEXT NOT NULL,order_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(profile_id,order_id,id));");
for (const file of ["0112_ensino_turmas.sql", "0113_ensino_diario.sql", "0114_ensino_comunicados.sql"]) db.exec(await readFile(`migrations/${file}`, "utf8"));
db.exec("INSERT INTO os_orders VALUES('p','o'),('other','foreign'); INSERT INTO ensino_classes VALUES('p','c','Turma','2025','2025-01-01','2025-12-31','teacher','matricula',1,'[]','[]','{}',0,1,0);");
db.exec("INSERT INTO ensino_enrollments VALUES('p','e','c','o','2025-01-01','2025-12-31',0)");
assert.throws(() => db.exec("INSERT INTO ensino_enrollments VALUES('p','e2','c','foreign','2025-01-01','2025-12-31',0)"), /ensino_capacity/);
db.exec("UPDATE ensino_classes SET capacity=2 WHERE profile_id='p' AND id='c'");
assert.throws(() => db.exec("INSERT INTO ensino_enrollments VALUES('p','e2','c','foreign','2025-01-01','2025-12-31',0)"), /FOREIGN KEY/);
db.exec("BEGIN; UPDATE ensino_classes SET version=version+1 WHERE profile_id='p' AND id='c' AND version=99;");
assert.throws(() => db.exec("INSERT INTO ensino_audit VALUES('p','x','c','e','test','actor',100,'hash',changes(),0)"), /CHECK/);
db.exec("ROLLBACK");
assert.equal(db.prepare("SELECT version FROM ensino_classes WHERE profile_id=? AND id=?").get("p", "c").version, 1);
assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ensino_%'").all())
  assert(db.prepare(`PRAGMA table_info(${name})`).all().some(c => c.name === "profile_id" && c.notnull === 1));
db.close();

const files = [];
async function walk(dir) { for (const item of await readdir(dir, { withFileTypes: true })) { const path = `${dir}/${item.name}`; if (item.isDirectory()) await walk(path); else files.push(path); } }
await walk("src/modules/ensino"); await walk("web/modules/ensino");
for (const file of await readdir("tests")) if (file.startsWith("ensino-")) files.push(`tests/${file}`);
for (const file of await readdir("migrations")) if (/^011[234]_ensino_/.test(file)) files.push(`migrations/${file}`);
files.push("scripts/ensino-verify.mjs", "docs/ENSINO.md");
for (const file of files) {
  const bytes = await readFile(file), source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert(!bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), `${file}: BOM`);
  assert(!source.includes("\r"), `${file}: CRLF`);
  if (/\.tsx?$/.test(file)) assert.equal(compile(source, file).diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0, `${file}: sintaxe`);
}
console.log(`Ensino: cálculo, frequência, DDL 0112–0114, FKs, capacidade, CAS e UTF-8/LF de ${files.length} arquivos aprovados. Sem executar Vitest.`);
