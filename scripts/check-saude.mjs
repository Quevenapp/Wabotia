// Verificação local sem rede, Vitest, Wrangler ou arquivos temporários.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const files = [
  ...["src/modules/saude", "web/modules/saude"].flatMap(dir => readdirSync(dir).map(name => `${dir}/${name}`)),
  ...readdirSync("tests").filter(name => name.startsWith("saude-")).map(name => `tests/${name}`),
  ...readdirSync("migrations").filter(name => /^(0109|0110|0111)_saude/.test(name)).map(name => `migrations/${name}`),
  "docs/SAUDE.md", "scripts/check-saude.mjs",
];
for (const file of files) {
  const bytes = readFileSync(file);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${file}: BOM`);
  assert(!text.includes("\r"), `${file}: CRLF`);
  if (/\.tsx?$/.test(file)) {
    const result = ts.transpileModule(text, { fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
    assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, `${file}: sintaxe TS`);
  }
}
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE profiles(id TEXT PRIMARY KEY); CREATE TABLE os_orders(profile_id TEXT,id TEXT,PRIMARY KEY(profile_id,id)); INSERT INTO profiles VALUES('a'),('b'); INSERT INTO os_orders VALUES('a','order-a'),('b','order-b');");
for (const file of files.filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(file, "utf8"));
db.exec("INSERT INTO saude_policy VALUES('a',1,1,1); INSERT INTO saude_subjects(profile_id,id,kind,payload_enc,created,last_activity,retain_until) VALUES('a','patient','human','cipher',1,1,1),('b','foreign','human','cipher',1,1,NULL); INSERT INTO saude_episodes VALUES('a','episode','patient','order-a',1);");
assert.throws(() => db.exec("INSERT INTO saude_episodes VALUES('a','bad','patient','order-b',1)"), /FOREIGN KEY/);
db.exec("INSERT INTO saude_records(profile_id,id,subject_id,episode_id,kind,payload_enc,author,created,signed_at,digest) VALUES('a','record','patient','episode','evolution','cipher','author',1,2,'hash');");
assert.throws(() => db.exec("UPDATE saude_records SET payload_enc='changed' WHERE profile_id='a' AND id='record'"), /saude_signed_immutable/);
assert.throws(() => db.exec("DELETE FROM saude_records WHERE profile_id='a' AND id='record'"), /saude_retention/);
assert.throws(() => db.exec("UPDATE saude_subjects SET state='deleting' WHERE profile_id='b' AND id='foreign'"), /saude_retention/);
db.exec("UPDATE saude_subjects SET legal_hold=1 WHERE profile_id='a' AND id='patient'");
assert.throws(() => db.exec("UPDATE saude_subjects SET state='deleting' WHERE profile_id='a' AND id='patient'"), /saude_retention/);
db.exec("UPDATE saude_subjects SET legal_hold=0,retain_until=9999999999999 WHERE profile_id='a' AND id='patient'");
assert.throws(() => db.exec("UPDATE saude_subjects SET state='deleting' WHERE profile_id='a' AND id='patient'"), /saude_retention/);
db.exec("INSERT INTO saude_access_audit VALUES('a','audit','patient','author','record.read','[\"record\"]',1)");
assert.throws(() => db.exec("DELETE FROM saude_access_audit WHERE profile_id='a'"), /saude_audit_immutable/);
assert.throws(() => db.exec("UPDATE saude_access_audit SET actor='other' WHERE profile_id='a'"), /saude_audit_immutable/);
db.exec("INSERT INTO saude_attachments(profile_id,id,subject_id,episode_id,payload_enc,mime_type,expected_bytes,created,author) VALUES('a','doc','patient','episode','cipher','text/plain',3,1,'author')");
assert.throws(() => db.exec("UPDATE saude_attachments SET sensitive=0 WHERE profile_id='a' AND id='doc'"), /CHECK/);
assert.throws(() => db.exec("UPDATE saude_attachments SET client_visible=1 WHERE profile_id='a' AND id='doc'"), /CHECK/);
db.exec("UPDATE saude_subjects SET retain_until=1 WHERE profile_id='a' AND id='patient'; UPDATE saude_subjects SET state='deleting' WHERE profile_id='a' AND id='patient'; DELETE FROM saude_records WHERE profile_id='a' AND subject_id='patient'; DELETE FROM saude_attachments WHERE profile_id='a' AND subject_id='patient'; DELETE FROM saude_episodes WHERE profile_id='a' AND subject_id='patient'; UPDATE saude_subjects SET payload_enc=NULL,state='deleted' WHERE profile_id='a' AND id='patient';");
assert.equal(db.prepare("SELECT count(*) AS n FROM saude_access_audit WHERE profile_id='a'").get().n, 1);
assert.throws(() => db.exec("DELETE FROM saude_subjects WHERE profile_id='a' AND id='patient'"), /saude_tombstone_required/);
// O guard de CAS aborta o lote completo quando a alteração principal perdeu a corrida.
db.exec("BEGIN");
try {
  db.exec("UPDATE saude_subjects SET version=version+1 WHERE profile_id='b' AND id='missing'; INSERT INTO saude_assert(profile_id,ok) VALUES('b',changes())");
  assert.fail("CAS deveria recusar ausência de alteração");
} catch (error) {
  assert.match(String(error), /CHECK/); db.exec("ROLLBACK");
}
db.close();
console.log(`Saúde: ${files.length} arquivos UTF-8/LF, sintaxe TS e migrações/guardas SQLite aprovados. Não executa a suíte Vitest.`);
