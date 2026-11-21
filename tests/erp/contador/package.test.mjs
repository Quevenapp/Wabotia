// Pacote do contador (src/erp/contador/package.ts) num objeto ERP de verdade
// (node:sqlite com o migrate da versão 22), emissor e R2 simulados, nenhuma
// rede. Prova: o ZIP montado aos poucos abre e traz as pastas e a planilha;
// o mesmo período não monta duas vezes; refazer limpa as partes antigas;
// falha passageira volta sem gravar parte; emissor ausente deixa as emitidas
// de fora com aviso; erro definitivo para com a mensagem.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import {
  contadorNextWake, contadorRunning, listPackages, packageFiles, readPackage, runPackageUnit, startPackage, xmlFacts,
} from "../../../src/erp/contador/package.ts";
import { contadorPackageId, contadorPeriod, previousMonth, periodLabel } from "../../../src/erp/contador/contract.ts";
import { readStoredZip } from "../../../src/erp/contador/zip.ts";

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
  assert.equal(migrate(s).version, 22);
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
const KEY = (n) => `3526111122223333444455${String(n).padStart(22, "0")}`.slice(0, 44);
const nfeXml = (n, cfop = "5102", nat = "Venda de mercadoria") => `<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><natOp>${nat}</natOp><nNF>${n}</nNF></ide><det nItem="1"><prod><CFOP>${cfop}</CFOP></prod></det></infNFe></NFe></nfeProc>`;
const pdf = (text) => ({ content_type: "application/pdf", size: text.length, body: new TextEncoder().encode(`%PDF-1.4 ${text}`) });
const note = (n, extra = {}) => ({ provider_ref: `ref${n}`, kind: "nfe", environment: "producao", reference: null, series: "1", number: String(n), dps_number: null,
  status: "authorized", access_key: KEY(n), protocol: "1", issued_at: "2026-10-1" + (n % 9) + "T12:00:00-03:00", total: 100 + n, recipient: { document: "11222333000181", name: `Cliente ${n}` },
  xml_available: true, ...extra });

function fakeSource(notes, options = {}) {
  const calls = [];
  const fail = (what) => { if (options.failOn?.(what)) throw Object.assign(new Error("fora do ar"), { status: 503 }); };
  return {
    calls,
    source: {
      async issued(filter) { calls.push(["issued", filter.page]); fail("issued"); const start = (filter.page - 1) * filter.per_page; return { items: notes.slice(start, start + filter.per_page), total: notes.length, amount: 0, page: filter.page, per_page: filter.per_page }; },
      async get(kind, ref) { calls.push(["get", ref]); return { corrections: notes.find((n) => n.provider_ref === ref)?.corrections ?? 0 }; },
      async xml(kind, ref) { calls.push(["xml", ref]); fail("xml"); if (options.stop) throw Object.assign(new Error("velho"), { status: 409, code: "vault_outdated", message: "Cofre desatualizado." }); return nfeXml(ref.slice(3)); },
      async cancellationXml(kind, ref) { return `<procEventoNFe><tpEvento>110111</tpEvento><ref>${ref}</ref></procEventoNFe>`; },
      async correctionXml(ref, seq) { return `<procEventoNFe><tpEvento>110110</tpEvento><nSeqEvento>${seq}</nSeqEvento></procEventoNFe>`; },
      async danfe(ref) { return pdf(ref); },
      async danfce(ref) { return pdf(ref); },
      async voidRanges() {
        return [
          { provider_ref: "inu1", kind: "nfe", environment: "producao", series: 1, first: 50, last: 52, protocol: "p", created_at: "2026-10-20T15:00:00Z", justification: "Pulou numeração", xml_available: true, repeated: null },
          { provider_ref: "inu2", kind: "nfe", environment: "producao", series: 1, first: 60, last: 60, protocol: "p", created_at: "2026-09-20T15:00:00Z", justification: "Fora do período", xml_available: true, repeated: null },
        ];
      },
      async voidRangeXml(ref) { return `<procInutNFe><id>${ref}</id></procInutNFe>`; },
      async receivedDanfe(ref) { return pdf(`recebida-${ref}`); },
    },
  };
}

function receivedWithEntry(db, files, { key = KEY(900), at = Date.parse("2026-10-15T14:00:00-03:00"), active = true } = {}) {
  const xml = new TextEncoder().encode(`<nfeProc><chNFe>${key}</chNFe></nfeProc>`);
  const sha = createHash("sha256").update(xml).digest("hex");
  const xmlKey = `erp/area/recebidas/xml/${sha}.xml`;
  files.objects.set(xmlKey, xml);
  const noteId = `n-${key.slice(-6)}`;
  db.prepare(`INSERT INTO erp_purchase_inbound__note(id, source, received_id, environment, access_key, emitter_document, emitter_name, series, number, issued_on, total_cents,
    situation, nature, cfops, xml_key, xml_sha256, xml_size, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(noteId, "cofre", `rcb_rec${key.slice(-6)}`, "producao", key, "44555666000181", "Fornecedor; Ltda", 1, 77, "2026-10-14", 31250, "autorizada", "Compra para revenda", '["1102"]', xmlKey, sha, xml.length, at, at);
  db.prepare(`INSERT INTO erp_purchase_inbound__entry(id, note_id, command_id, state, stock_status, finance_status, snapshot, result, actor, created_at${active ? "" : ", reversed_at, reversed_by, reversal_reason, reversal_command_id, reversal"})
    VALUES(?,?,?,?,?,?,?,?,?,?${active ? "" : ",?,?,?,?,?"})`)
    .run(`e-${key.slice(-6)}`, noteId, `c-${key.slice(-6)}`, active ? "active" : "reversed", "done", "done", "{}", "{}", "pessoa", at, ...(active ? [] : [at, "p", "motivo do estorno", "rc", "{}"]));
}

async function runAll(deps, limit = 60) {
  let clock = deps.clock;
  for (let i = 0; i < limit; i++) {
    const p = listPackages(deps.db).find((x) => x.state === "running");
    if (!p) return;
    clock.t += 10_000;
    await runPackageUnit(deps);
  }
  throw new Error("o pacote não terminou");
}
const csvOf = (zip) => new TextDecoder().decode(zip.find((e) => e.name.endsWith(".csv")).data).replace(/^\uFEFF/, "");
function zipOf(driver, files, profile, id) {
  const f = packageFiles(driver, profile, id);
  const parts = f.keys.map((k) => files.objects.get(k));
  const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
  assert.equal(bytes.length, f.bytes, "Content-Length = soma das partes");
  return readStoredZip(bytes);
}

test("período: conferência, mês anterior, rótulo e id estável", async () => {
  assert.deepEqual(contadorPeriod("2026-10-01", "2026-10-31"), { from: "2026-10-01", to: "2026-10-31" });
  assert.match(contadorPeriod("2026-10-31", "2026-10-01"), /vem depois/);
  assert.match(contadorPeriod("2026-02-30", "2026-03-01"), /primeiro dia/);
  assert.match(contadorPeriod("2025-01-01", "2026-03-01"), /366 dias/);
  assert.deepEqual(previousMonth("2026-01-05"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(previousMonth("2028-03-10"), { from: "2028-02-01", to: "2028-02-29" });
  assert.equal(periodLabel("2026-10-01", "2026-10-31"), "10/2026");
  assert.equal(periodLabel("2026-10-01", "2026-10-15"), "01/10/2026 a 15/10/2026");
  const a = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, await contadorPackageId("producao", "2026-10-01", "2026-10-31"));
  assert.notEqual(a, await contadorPackageId("homologacao", "2026-10-01", "2026-10-31"));
  assert.deepEqual(xmlFacts(nfeXml(1, "6108", "Venda &amp; remessa")), { cfop: "6108", nature: "Venda & remessa" });
});

test("monta o ZIP aos poucos: emitidas com eventos e PDFs, inutilizações do período, recebidas com entrada e a planilha", async () => {
  const { db, driver } = area();
  const files = media();
  const notes = [
    note(1), note(2, { status: "cancelled" }), note(3, { corrections: 2 }), note(4, { kind: "nfce" }),
    note(5, { kind: "nfse", access_key: null, number: "88" }), note(6, { status: "rejected", xml_available: false, access_key: null }), note(7, { total: 1234.5 }),
  ];
  const fake = fakeSource(notes);
  receivedWithEntry(db, files);
  receivedWithEntry(db, files, { key: KEY(901), active: false }); // estornada: fora
  receivedWithEntry(db, files, { key: KEY(902), at: Date.parse("2026-11-02T10:00:00-03:00") }); // entrada fora do período
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const deps = { db: driver, profile: "area", media: files, source: async () => fake.source, now: () => clock.t, clock, random: () => "run0000000000001" };
  const id = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  const started = startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: "pessoa" });
  assert.equal(started.reused, false);
  assert.equal(started.package.state, "running");
  assert.equal(contadorRunning(driver), true);
  assert.ok(contadorNextWake(driver) <= clock.t);
  await runAll(deps);
  const done = readPackage(driver, id);
  assert.equal(done.state, "done", done.error ?? "");
  assert.equal(done.filename, "contador_2026-10-01_a_2026-10-31.zip");
  assert.deepEqual({ ...done.counts }, { issued: 7, received: 1, bling: 0, void_ranges: 1, events: 4, xml: 7, pdf: 6, without_xml: 1 });
  // Uma parte por página de 5 emitidas: a montagem foi aos poucos.
  assert.deepEqual(fake.calls.filter((c) => c[0] === "issued").map((c) => c[1]), [1, 2]);
  const zip = zipOf(driver, files, "area", id);
  const names = zip.map((e) => e.name);
  for (const name of [
    `emitidas/NFe/xml/${KEY(1)}.xml`, `emitidas/NFe/pdf/${KEY(1)}.pdf`, `emitidas/NFe/eventos/${KEY(2)}-cancelamento.xml`,
    `emitidas/NFe/eventos/${KEY(3)}-carta-correcao-01.xml`, `emitidas/NFe/eventos/${KEY(3)}-carta-correcao-02.xml`,
    `emitidas/NFCe/xml/${KEY(4)}.xml`, `emitidas/NFCe/pdf/${KEY(4)}.pdf`, "emitidas/NFSe/xml/nfse-88.xml",
    "emitidas/inutilizacoes/NFe-serie1-50-a-52.xml", `recebidas/xml/${KEY(900)}.xml`, `recebidas/pdf/${KEY(900)}.pdf`,
    "indice-notas_2026-10-01_a_2026-10-31.csv",
  ]) assert.ok(names.includes(name), `falta ${name} em ${names.join(", ")}`);
  assert.ok(!names.some((n) => n.includes("NFSe/pdf")), "NFS-e sem PDF no emissor");
  assert.ok(!names.some((n) => n.includes("60-a-60") || n.includes(KEY(901)) || n.includes(KEY(902))));
  const csv = csvOf(zip).split("\r\n");
  assert.equal(csv[0], "Origem;Modelo;Série;Número;Chave de acesso;Data;Destinatário ou emitente;CPF/CNPJ;CFOP principal;Natureza da operação;Valor;Situação;Arquivos no pacote");
  assert.ok(csv.some((l) => l.startsWith(`Emitida;NF-e;1;7;${KEY(7)};1`) && l.includes(";5102;Venda de mercadoria;1234,50;Autorizada;")));
  assert.ok(csv.some((l) => l.startsWith("Emitida;NF-e;1;6;;") && l.includes(";Rejeitada;só na planilha")));
  assert.ok(csv.some((l) => l.startsWith("Inutilização;NF-e;1;50 a 52;") && l.includes("Pulou numeração;;Inutilizada;")));
  assert.ok(csv.some((l) => l.startsWith(`Recebida (com entrada);NF-e;1;77;${KEY(900)};14/10/2026;"Fornecedor; Ltda";44555666000181;1102;Compra para revenda;312,50;Autorizada;`)));
  // O mesmo período de novo: o mesmo pacote, sem montar de novo.
  const again = startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: "outra" });
  assert.equal(again.reused, true);
  assert.equal(again.package.state, "done");
  // Refazer: outra montagem; as partes antigas e o fecho vão para a limpeza.
  const oldKeys = packageFiles(driver, "area", id).keys;
  const redo = startPackage({ ...deps, random: () => "run0000000000002" }, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: true, actor: "pessoa" });
  assert.equal(redo.reused, false);
  assert.equal(packageFiles(driver, "area", id), null, "em montagem não baixa");
  await runAll(deps);
  for (const key of oldKeys) assert.ok(files.deleted.includes(key), `apagou ${key}`);
  assert.equal(readPackage(driver, id).state, "done");
  assert.equal(zipOf(driver, files, "area", id).length, zip.length);
});

test("falha passageira do emissor: a unidade volta mais tarde, sem parte gravada; depois segue", async () => {
  const { driver } = area();
  const files = media();
  let down = true;
  const fake = fakeSource([note(1)], { failOn: (what) => down && what === "xml" });
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const deps = { db: driver, profile: "area", media: files, source: async () => fake.source, now: () => clock.t, clock };
  const id = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: null });
  await runPackageUnit(deps);
  const waiting = readPackage(driver, id);
  assert.equal(waiting.state, "running");
  assert.equal(waiting.attempts, 1);
  assert.ok(waiting.retry_at > clock.t, "espera antes de tentar de novo");
  assert.equal(files.objects.size, 0);
  assert.deepEqual(await runPackageUnit(deps), { worked: false, more: true }, "antes da hora, nada");
  down = false;
  await runAll(deps);
  assert.equal(readPackage(driver, id).state, "done");
  assert.equal(readPackage(driver, id).counts.xml, 1);
});

test("sem emissor configurado: as emitidas ficam de fora com aviso; recebidas entram", async () => {
  const { db, driver } = area();
  const files = media();
  receivedWithEntry(db, files);
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const deps = { db: driver, profile: "area", media: files, source: async () => { throw Object.assign(new Error("sem emissor"), { status: 409, code: "fiscal_provider_not_configured" }); }, now: () => clock.t, clock };
  const id = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: null });
  await runAll(deps);
  const done = readPackage(driver, id);
  assert.equal(done.state, "done");
  assert.equal(done.counts.issued, 0);
  assert.equal(done.counts.received, 1);
  assert.match(done.warnings[0], /emissor de notas configurado/);
  assert.match(csvOf(zipOf(driver, files, "area", id)), /Aviso;As notas emitidas ficaram de fora/);
});

test("erro definitivo do emissor para o pacote com a mensagem; sem R2, também", async () => {
  const { driver } = area();
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const fake = fakeSource([note(1)], { stop: true });
  const deps = { db: driver, profile: "area", media: media(), source: async () => fake.source, now: () => clock.t, clock };
  const id = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: null });
  await runPackageUnit(deps);
  const failed = readPackage(driver, id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /precisa de atualização/);
  // Pacote que falhou: pedir de novo monta outro (não reaproveita a falha).
  assert.equal(startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: null }).reused, false);
  await runPackageUnit({ ...deps, media: null });
  assert.match(readPackage(driver, id).error, /armazenamento de arquivos/);
});

test("acervo do Bling: as notas do período entram marcadas, com o XML conferido pelo hash", async () => {
  const { db, driver } = area();
  const files = media();
  const xml = new TextEncoder().encode(`<nfeProc><chNFe>${KEY(500)}</chNFe></nfeProc>`);
  const sha = createHash("sha256").update(xml).digest("hex");
  files.objects.set(`erp/area/bling/xml/${sha}`, xml);
  const raw = db.prepare(`INSERT INTO origin_sync__raw_record(entity, last_resource, source_id, payload, version_hash, first_seen_at, last_seen_at, changed_at) VALUES(?,?,?,?,?,?,?,?)`);
  const payload = (n, day, extra = {}) => JSON.stringify({ numero: n, serie: 1, chaveAcesso: KEY(n), dataEmissao: `${day} 10:00:00`, valorNota: 99.9, situacao: { id: 5 },
    contato: { nome: "Cliente do Bling", numeroDocumento: "12345678909" }, ...extra });
  raw.run("nfe", "nfe", "1001", payload(500, "2026-10-03"), "h", 1, 1, 1);
  raw.run("nfe", "nfe", "1002", payload(501, "2026-10-04", { situacao: { id: 2 } }), "h", 1, 1, 1);
  raw.run("nfce", "nfce", "77", payload(502, "2026-09-30"), "h", 1, 1, 1); // fora do período
  const clock = { t: Date.parse("2026-11-05T12:00:00Z") };
  const deps = { db: driver, profile: "area", media: files, source: null, now: () => clock.t, clock,
    blingXml: (_db, profile, entity, sourceId) => entity === "nfe" && sourceId === "1001" ? { key: `erp/${profile}/bling/xml/${sha}`, sha256: sha, access_key: KEY(500) }
      : entity === "nfe" && sourceId === "1002" ? { key: `erp/${profile}/bling/xml/${sha}`, sha256: "0".repeat(64), access_key: KEY(501) } : null };
  const id = await contadorPackageId("producao", "2026-10-01", "2026-10-31");
  startPackage(deps, { id, environment: "producao", from: "2026-10-01", to: "2026-10-31", redo: false, actor: null });
  await runAll(deps);
  const done = readPackage(driver, id);
  assert.equal(done.state, "done");
  assert.equal(done.counts.bling, 2);
  const zip = zipOf(driver, files, "area", id);
  assert.ok(zip.some((e) => e.name === `acervo-bling/NFe/${KEY(500)}.xml`));
  assert.ok(!zip.some((e) => e.name.includes(KEY(501))), "XML que não confere com o hash não entra");
  const csv = csvOf(zip);
  assert.match(csv, new RegExp(`Acervo do Bling;NF-e;1;500;${KEY(500)};03/10/2026;Cliente do Bling;12345678909;;;99,90;Autorizada;acervo-bling/NFe/`));
  assert.match(csv, new RegExp(`Acervo do Bling;NF-e;1;501;${KEY(501)};04/10/2026;.*;Cancelada;só na planilha`));
  assert.doesNotMatch(csv, new RegExp(KEY(502)));
});
