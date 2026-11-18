// Verificação offline limitada: algoritmo, DDL e codificação dos arquivos novos.
// Não substitui a suíte Vitest/Cloudflare executada pelo integrador.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import ts from "typescript";

const bundled = await build({ entryPoints: ["src/modules/juridico/calculation.ts"], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
const { calculate, localInstant } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const calendar = { name: "Teste", jurisdiction: "Unidade de teste", from: "2026-01-01", to: "2027-12-31", timezone: "America/Sao_Paulo", weekend: [0, 6], events: [] };
const rule = { start_date: "2026-11-16", days: 5, include_start: false, start_non_working: "next", due_non_working: "next", due_time: "18:00", alert_days: 2, alert_time: "09:00" };
assert.equal(calculate(calendar, rule).due_date, "2026-11-23");
const event = { id: "f", name: "Suspensão", from: "2026-11-18", to: "2026-11-19", kind: "suspension", effect: "all", source: "Fonte de teste" };
assert.equal(calculate({ ...calendar, events: [event] }, rule).due_date, "2026-11-25");
assert.equal(calculate(calendar, { ...rule, include_start: true }).due_date, "2026-11-20");
assert.throws(() => calculate({ ...calendar, to: "2026-11-17" }, rule));
assert.throws(() => localInstant("2026-11-01", "01:30", "America/New_York"));
assert.throws(() => localInstant("2026-03-08", "02:30", "America/New_York"));
assert.equal(localInstant("2026-11-16", "18:00", "America/Sao_Paulo"), Date.parse("2026-11-16T21:00Z"));
console.log("Cálculo: dias úteis, suspensão, inclusão do início, cobertura e fuso aprovados.");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const name of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) {
  try { db.exec(readFileSync(`migrations/${name}`, "utf8")); }
  catch (error) { throw new Error(`Migração ${name}: ${error.message}`); }
}
for (const table of ["jur_calendars", "jur_calendar_versions", "jur_deadlines", "jur_calculations", "jur_alerts"]) {
  assert(db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === "profile_id"));
}
db.prepare("INSERT INTO profiles(id,name,settings,enabled,created) VALUES('jur-test','Teste','{}',1,1)").run();
// Usa as colunas obrigatórias reais do motor, sem modificar o schema nos testes.
db.prepare(`INSERT INTO os_orders(id,profile_id,number,phone,item,problem,source,created_by,created,updated)
  VALUES('order-test','jur-test',1,'5511000000000','Teste','Teste','panel','user-test',1,1)`).run();
db.prepare("INSERT INTO jur_calendars VALUES('jur-test','cal-test',1,'Teste',1,1)").run();
db.prepare("INSERT INTO jur_calendar_versions VALUES('jur-test','cal-test',1,'{}',0,'user-test',1,'key-test')").run();
db.prepare(`INSERT INTO os_tasks(id,profile_id,order_id,title,assignee,audience,due_at,sensitive,created_by,created,updated,juridico_revision)
  VALUES('task-test','jur-test','order-test','Prazo jurídico','user-test','staff',100,1,'user-test',1,1,1)`).run();
db.prepare(`INSERT INTO jur_deadlines(profile_id,id,order_id,task_id,calendar_id,calendar_revision,title,assignee,rule_json,due_at,calculated_due_at,alert_at,review,created_by,created,updated)
  VALUES('jur-test','deadline-test','order-test','task-test','cal-test',1,'Teste','user-test','{}',100,100,90,'pending','user-test',1,1)`).run();
assert.throws(() => db.prepare("UPDATE os_tasks SET due_at=200 WHERE profile_id='jur-test' AND id='task-test'").run(), /juridico_task_protected/);
assert.throws(() => db.prepare("UPDATE os_tasks SET sensitive=0 WHERE profile_id='jur-test' AND id='task-test'").run(), /juridico_task_protected/);
db.prepare("UPDATE os_tasks SET due_at=200,juridico_revision=juridico_revision+1 WHERE profile_id='jur-test' AND id='task-test'").run();
db.prepare("UPDATE os_tasks SET state='done' WHERE profile_id='jur-test' AND id='task-test'").run();
assert.throws(() => db.prepare("UPDATE os_tasks SET state='open' WHERE profile_id='jur-test' AND id='task-test'").run(), /juridico_task_protected/);
assert.throws(() => db.prepare("DELETE FROM os_tasks WHERE profile_id='jur-test' AND id='task-test'").run(), /juridico_task_protected/);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
db.close();
console.log("SQLite em memória: migrações, chaves compostas e proteção de tarefas aprovadas.");

const files = [
  ...["src/modules/juridico", "web/modules/juridico"].flatMap(dir => readdirSync(dir).map(name => `${dir}/${name}`)),
  ...readdirSync("migrations").filter(name => /^010[678]_/.test(name)).map(name => `migrations/${name}`),
  ...readdirSync("tests").filter(name => /^juridico-.*\.test\.ts$/.test(name)).map(name => `tests/${name}`),
  "scripts/juridico-check.mjs", "docs/JURIDICO.md",
];
for (const file of files) {
  const bytes = readFileSync(file);
  assert(!bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), `${file}: BOM`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert(!text.includes("\r"), `${file}: CRLF`);
  assert(!text.includes("\uFFFD"), `${file}: substituição inválida`);
  if (/\.tsx?$/.test(file)) {
    const result = ts.transpileModule(text, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
    assert.equal(result.diagnostics?.length ?? 0, 0, `${file}: diagnóstico de sintaxe`);
  }
}
console.log(`${files.length} arquivos novos: UTF-8 sem BOM, LF e sintaxe TypeScript aprovados.`);
