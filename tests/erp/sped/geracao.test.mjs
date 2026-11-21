// Obrigações em arquivo (src/erp/sped/job.ts) num objeto ERP de verdade
// (node:sqlite com o migrate da versão 29), emissor e R2 simulados, nenhuma
// rede. Prova: a conferência acha o que falta (IE, contador, NCM, nota sem
// XML) e o arquivo fica "com pendências" sem gerar nada; com os cadastros
// certos, o SPED sai aos poucos no alarme, confere com o layout e fica no R2;
// o mesmo período não gera duas vezes; refazer limpa as partes antigas; a
// nota recebida usa o produto ligado na entrada; o pacote do contador leva o
// arquivo pronto na pasta obrigacoes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { fileParts, readFile, runSpedUnit, spedRunning, startFile, spedPackageExtras } from "../../../src/erp/sped/job.ts";
import { conference, saveSpedSettings } from "../../../src/erp/sped/data.ts";
import { applySettings, DEFAULT_SETTINGS } from "../../../src/erp/sped/settings.ts";
import { spedFileId } from "../../../src/erp/sped/contract.ts";
import { fromLatin1 } from "../../../src/erp/sped/format.ts";
import { validateSped } from "../../../src/erp/sped/validate.ts";
import { EFD_ICMS_IPI_LAYOUT, BLOCK_ORDER } from "../../../src/erp/sped/layout.ts";
import { runPackageUnit, startPackage, packageFiles } from "../../../src/erp/contador/package.ts";
import { readStoredZip, concat } from "../../../src/erp/contador/zip.ts";

function storage(db) {
  return {
    sql: {
      exec(sql, ...params) {
        const st = db.prepare(sql);
        if (/^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i.test(sql)) {
          const rows = st.all(...params);
          return { toArray: () => rows, raw: () => rows.map((row) => Object.values(row)), rowsRead: rows.length, rowsWritten: 0 };
        }
        const r = st.run(...params);
        return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
      },
    },
    transactionSync(fn) {
      db.exec("SAVEPOINT t");
      try { const out = fn(); db.exec("RELEASE t"); return out; } catch (e) { db.exec("ROLLBACK TO t"); db.exec("RELEASE t"); throw e; }
    },
  };
}
function area() {
  const db = new DatabaseSync(":memory:");
  const s = storage(db);
  assert.equal(migrate(s).version, ERP_DDL_VERSION);
  assert.equal(ERP_DDL_VERSION, 29);
  db.exec("PRAGMA foreign_keys=OFF");
  return { db, driver: storageDriver(s) };
}
function media() {
  const objects = new Map(), deleted = [];
  return {
    objects, deleted,
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const v = objects.get(key); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
    async delete(key) { deleted.push(key); objects.delete(key); },
  };
}
const KEY = (n, emit = "11222333000181") => `352610${emit}55001${String(n).padStart(9, "0")}1${String(n).padStart(8, "0")}0`;
const nfeXml = (n, { emit = "11222333000181", emitName = "Loja Exemplo", date = "2026-10-05", cfop = "5102", amount = "100.00" } = {}) => `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe${KEY(n, emit)}">
<ide><natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>${date}T10:00:00-03:00</dhEmi><tpNF>1</tpNF><finNFe>1</finNFe></ide>
<emit><CNPJ>${emit}</CNPJ><xNome>${emitName}</xNome><enderEmit><cMun>3550308</cMun><UF>SP</UF></enderEmit><IE>123456789012</IE><CRT>3</CRT></emit>
<dest><CNPJ>44555666000199</CNPJ><xNome>Cliente</xNome><enderDest><xLgr>Av</xLgr><nro>1</nro><xBairro>B</xBairro><cMun>3550308</cMun><UF>SP</UF></enderDest><IE>87654321</IE></dest>
<det nItem="1"><prod><cProd>X1</cProd><xProd>Item</xProd><NCM>61091000</NCM><CFOP>${cfop}</CFOP><uCom>CX</uCom><qCom>1.0000</qCom><vUnCom>${amount}</vUnCom><vProd>${amount}</vProd></prod>
<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${amount}</vBC><pICMS>18.00</pICMS><vICMS>${(Number(amount) * 0.18).toFixed(2)}</vICMS></ICMS00></ICMS></imposto></det>
<total><ICMSTot><vBC>${amount}</vBC><vICMS>${(Number(amount) * 0.18).toFixed(2)}</vICMS><vProd>${amount}</vProd><vNF>${amount}</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp>
</infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const note = (n, extra = {}) => ({ provider_ref: `ref${n}`, kind: "nfe", environment: "producao", reference: null, series: "1", number: String(n), dps_number: null,
  status: "authorized", access_key: KEY(n), protocol: "1", issued_at: "2026-10-05T12:00:00-03:00", total: 100, recipient: { document: "44555666000199", name: "Cliente" }, xml_available: true, ...extra });
function fakeSource(notes, options = {}) {
  const calls = [];
  return {
    calls,
    source: {
      async issued(filter) { calls.push(["issued", filter.page]); if (options.fail?.()) throw Object.assign(new Error("fora"), { status: 503 }); const s = (filter.page - 1) * filter.per_page; return { items: notes.slice(s, s + filter.per_page), total: notes.length, amount: 0, page: filter.page, per_page: filter.per_page }; },
      async xml(kind, ref) { calls.push(["xml", ref]); return nfeXml(Number(ref.slice(3))); },
      async voidRanges() { return [{ provider_ref: "inu", kind: "nfe", environment: "producao", series: 1, first: 90, last: 91, protocol: "p", created_at: "2026-10-20T15:00:00Z", justification: "Pulou", xml_available: true, repeated: null }]; },
    },
  };
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function seedCompany(db, { ie = "123456789012" } = {}) {
  db.prepare(`INSERT INTO "erp_company__identity"(singleton, version, data, created_at, updated_at, updated_by) VALUES(1,1,?,0,0,'u')`).run(JSON.stringify({
    legal_name: "Loja Exemplo Ltda", trade_name: "Loja Exemplo", cnpj: "11222333000181", ie, postal_code: "01001000", street: "Rua A", number: "10", complement: null,
    district: "Centro", city: "São Paulo", municipality_code: "3550308", state: "SP", phone: "1133334444", email: "loja@exemplo.com.br" }));
  db.prepare(`INSERT INTO "erp_company__fiscal"(singleton, version, crt, confirmed_at, confirmed_by, updated_at) VALUES(1,1,'3',0,'u',0)`).run();
}
function seedAccountant(driver) {
  const settings = applySettings(DEFAULT_SETTINGS, { contador: { nome: "Contadora", cpf: "123.456.789-09", crc: "SP123456O1", email: "c@exemplo.com.br" }, codigo_receita_icms: "046-2" });
  saveSpedSettings(driver, settings, "u", 0);
}
function seedProduct(db, id, { code = "CAM-01", ncm = "61091000", unit = "UN" } = {}) {
  db.prepare(`INSERT INTO "erp_catalog__record"(id, entity, name, code, active, version, human_edited, created_at, updated_at) VALUES(?, 'products', 'Camiseta', ?, 1, 1, 0, 0, 0)`).run(id, code);
  db.prepare(`INSERT INTO "erp_catalog__product"(record_id, unit, ncm) VALUES(?,?,?)`).run(id, unit, ncm);
}
async function seedReceived(db, m, { withXml = true, productId = null } = {}) {
  const xml = nfeXml(7001, { emit: "99888777000166", emitName: "Fornecedor", date: "2026-10-02", cfop: "5102", amount: "50.00" });
  const bytes = new TextEncoder().encode(xml), hash = sha(bytes), key = `erp/area/recebidas/xml/${hash}.xml`;
  if (withXml) await m.put(key, bytes);
  db.prepare(`INSERT INTO erp_purchase_inbound__note(id, source, environment, access_key, emitter_document, emitter_name, series, number, issued_on, total_cents, situation, cfops, xml_key, xml_sha256, xml_size, created_at, updated_at)
    VALUES('n1','manual','producao',?,?, 'Fornecedor', 1, 7001, '2026-10-02', 5000, 'autorizada', '["5102"]', ?, ?, ?, 0, 0)`)
    .run(KEY(7001, "99888777000166"), "99888777000166", withXml ? key : null, withXml ? hash : null, withXml ? bytes.length : null);
  db.prepare(`INSERT INTO erp_purchase_inbound__entry(id, note_id, command_id, state, stock_status, finance_status, snapshot, result, actor, created_at)
    VALUES('e1','n1','c1','active','done','nothing',?,?, 'u', 1)`).run(JSON.stringify({ lines: [{ position: 1, code: "X1", product_id: productId, stock_quantity: "12.000000" }] }), JSON.stringify({ day: "2026-10-03" }));
}
async function runAll(deps, max = 50) {
  let n = 0;
  while (spedRunning(deps.db) && n++ < max) await runSpedUnit(deps);
  assert.ok(n < max, "o arquivo não terminou");
}

test("conferência lista o que falta e o arquivo fica com pendências, sem ler nota", async () => {
  const { db, driver } = area();
  seedCompany(db, { ie: null });
  const m = media();
  await seedReceived(db, m, { withXml: false, productId: "p1" });
  seedProduct(db, "p1", { ncm: null });
  const checked = await conference(driver, { kind: "efd_icms_ipi", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null });
  const text = checked.problems.map((p) => p.message).join("\n");
  assert.match(text, /inscrição estadual/);
  assert.match(text, /contador \(0100\)/);
  assert.match(text, /entrou sem o XML/);
  assert.match(text, /Camiseta \(CAM-01\) está sem NCM/);
  assert.ok(checked.problems.find((p) => /NCM/.test(p.message)).link.includes("registro=p1"));
  const { source, calls } = fakeSource([note(1)]);
  const deps = { db: driver, profile: "area", media: m, source: async () => source, now: () => 1000 };
  const id = await spedFileId("efd_icms_ipi", "producao", "2026-10-01", "2026-10-31");
  const started = await startFile(deps, { id, kind: "efd_icms_ipi", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null, previousCredit: 0, redo: false, actor: "u" });
  assert.equal(started.file.state, "blocked");
  assert.ok(started.file.problems.length >= 4);
  assert.equal(spedRunning(driver), false);
  assert.equal(calls.length, 0);
  // SINTEGRA não pede o contador; EFD-Contribuições não pede a IE.
  const sint = await conference(driver, { kind: "sintegra", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null });
  assert.ok(!sint.problems.some((p) => p.kind === "contador"));
  const contrib = await conference(driver, { kind: "efd_contribuicoes", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null });
  assert.ok(!contrib.problems.some((p) => /inscrição estadual/.test(p.message)));
});

test("SPED Fiscal sai aos poucos no alarme, confere com o layout e entra no pacote do contador", async () => {
  const { db, driver } = area();
  seedCompany(db);
  seedAccountant(driver);
  const m = media();
  seedProduct(db, "p1");
  await seedReceived(db, m, { productId: "p1" });
  const notes = Array.from({ length: 12 }, (_, i) => note(i + 1)).concat([note(50, { status: "cancelled" }), note(51, { status: "rejected", xml_available: false }), note(52, { kind: "nfse" })]);
  const { source, calls } = fakeSource(notes);
  let clock = 1000;
  const deps = { db: driver, profile: "area", media: m, source: async () => source, now: () => clock };
  const id = await spedFileId("efd_icms_ipi", "producao", "2026-10-01", "2026-10-31");
  const started = await startFile(deps, { id, kind: "efd_icms_ipi", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null, previousCredit: 0, redo: false, actor: "u" });
  assert.equal(started.file.state, "running", JSON.stringify(started.file.problems));
  await runAll(deps);
  const f = readFile(driver, id);
  assert.equal(f.state, "done", JSON.stringify([f.error, f.problems]));
  assert.equal(f.counts.issued, 13); assert.equal(f.counts.cancelled, 1); assert.equal(f.counts.received, 1); assert.equal(f.counts.voided, 2); assert.equal(f.counts.nfse, 0);
  assert.ok(!calls.some(([k, ref]) => k === "xml" && (ref === "ref51" || ref === "ref52")), "rejeitada e NFS-e não são lidas no SPED Fiscal");
  const parts = fileParts(driver, "area", id);
  const bytes = concat(parts.keys.map((k) => m.objects.get(k)));
  assert.equal(bytes.length, parts.bytes); assert.equal(sha(bytes), f.sha256);
  const lines = fromLatin1(bytes).trimEnd().split("\r\n");
  assert.deepEqual(validateSped(lines, EFD_ICMS_IPI_LAYOUT, BLOCK_ORDER.efd_icms_ipi), []);
  assert.equal(parts.filename, "SPED-EFD-ICMS-IPI_11222333000181_202610.txt");
  // A entrada usa o produto ligado: código, unidade e quantidade do cadastro.
  const c170 = lines.find((l) => l.startsWith("|C170|")).split("|");
  assert.equal(c170[3], "CAM-01"); assert.equal(c170[5], "12,00000"); assert.equal(c170[6], "UN");
  assert.ok(lines.some((l) => l.startsWith("|0200|CAM-01|Camiseta|")));
  // E110: 12 vendas de 18,00 de ICMS (a cancelada não conta), crédito de 9,00.
  const e110 = lines.find((l) => l.startsWith("|E110|")).split("|");
  assert.equal(e110[2], "216,00"); assert.equal(e110[6], "9,00"); assert.equal(e110[13], "207,00");
  assert.ok(lines.some((l) => l === "|E116|000|207,00|10112026|046-2|||||102026|"), "E116 com o vencimento no dia 10 do mês seguinte");
  assert.equal(db.prepare(`SELECT count(*) AS n FROM erp_sped__doc`).get().n, 0, "as notas guardadas saem quando o arquivo fica pronto");
  // O mesmo período devolve o mesmo arquivo.
  const again = await startFile(deps, { id, kind: "efd_icms_ipi", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null, previousCredit: 0, redo: false, actor: "u" });
  assert.equal(again.reused, true);

  // Pacote do contador do mesmo mês: o arquivo vai na pasta obrigacoes.
  const extras = await spedPackageExtras(driver, "area", m, "producao", "2026-10-01", "2026-10-31");
  assert.equal(extras.length, 1);
  assert.equal(extras[0].name, "obrigacoes/SPED-EFD-ICMS-IPI_11222333000181_202610.txt");
  const pkgDeps = { db: driver, profile: "area", media: m, source: null, now: () => clock, extras: (env, from, to) => spedPackageExtras(driver, "area", m, env, from, to) };
  startPackage(pkgDeps, { id: "0123456789abcdef", environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: "u" });
  for (let i = 0; i < 20; i++) await runPackageUnit(pkgDeps);
  const located = packageFiles(driver, "area", "0123456789abcdef");
  assert.ok(located, "o pacote ficou pronto");
  const zip = concat(located.keys.map((k) => m.objects.get(k)));
  assert.equal(zip.length, located.bytes);
  const entries = readStoredZip(zip);
  const sped = entries.find((e) => e.name === "obrigacoes/SPED-EFD-ICMS-IPI_11222333000181_202610.txt");
  assert.ok(sped, entries.map((e) => e.name).join(","));
  assert.equal(sha(sped.data), f.sha256);
  assert.ok(entries.some((e) => e.name.startsWith("indice-notas_")));

  // Refazer: partes antigas vão para a limpeza.
  clock += 10_000;
  const redo = await startFile(deps, { id, kind: "efd_icms_ipi", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null, previousCredit: 0, redo: true, actor: "u" });
  assert.equal(redo.reused, false);
  await runAll(deps);
  assert.ok(m.deleted.includes(parts.keys[0]));
  assert.equal(readFile(driver, id).state, "done");
});

test("falha passageira do emissor volta com espera; sem emissor, as emitidas ficam de fora com aviso", async () => {
  const { db, driver } = area();
  seedCompany(db);
  seedAccountant(driver);
  const m = media();
  let failing = true;
  const { source } = fakeSource([note(1)], { fail: () => failing });
  let clock = 1000;
  const deps = { db: driver, profile: "area", media: m, source: async () => source, now: () => clock };
  const id = await spedFileId("sintegra", "producao", "2026-10-01", "2026-10-31");
  await startFile(deps, { id, kind: "sintegra", environment: "producao", from: "2026-10-01", to: "2026-10-31", inventory: null, previousCredit: 0, redo: false, actor: "u" });
  await runSpedUnit(deps);
  const waiting = readFile(driver, id);
  assert.equal(waiting.attempts, 1); assert.ok(waiting.retry_at > clock); assert.equal(waiting.phase, "emitidas");
  failing = false; clock = waiting.retry_at;
  await runAll(deps);
  assert.equal(readFile(driver, id).state, "done");

  const none = { db: driver, profile: "area", media: m, source: async () => { throw Object.assign(new Error("sem emissor"), { status: 409 }); }, now: () => clock };
  const id2 = await spedFileId("sintegra", "producao", "2026-09-01", "2026-09-30");
  await startFile(none, { id: id2, kind: "sintegra", environment: "producao", from: "2026-09-01", to: "2026-09-30", inventory: null, previousCredit: 0, redo: false, actor: "u" });
  await runAll(none);
  const f2 = readFile(driver, id2);
  assert.equal(f2.state, "done");
  assert.ok(f2.warnings.some((w) => /emissor de notas configurado/.test(w)));
});

test("configuração confere CPF, e-mail e escolhas", () => {
  assert.throws(() => applySettings(DEFAULT_SETTINGS, { contador: { cpf: "111.111.111-11" } }), /CPF do contador inválido/);
  assert.throws(() => applySettings(DEFAULT_SETTINGS, { perfil: "D" }), /Perfil/);
  assert.throws(() => applySettings(DEFAULT_SETTINGS, { dia_vencimento_icms: 40 }), /vencimento/);
  const s = applySettings(DEFAULT_SETTINGS, { perfil: "B", pis_cofins: { incidencia: "2" }, no_pacote: false });
  assert.equal(s.profile, "B"); assert.equal(s.pis_cofins.incidence, "2"); assert.equal(s.in_package, false);
});
