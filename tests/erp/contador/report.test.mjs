// Para o contador: relatórios fiscais (src/erp/contador/report.ts), as
// operações com nome estável no inventário dos bots (assunto NF-e; enviar é
// sensível e exige a proposta confirmada) e a parte Fiscal que elas exigem.
// Sem rede: o relatório do emissor é um objeto montado aqui.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { annexMap, buildReport, reportCsv } from "../../../src/erp/contador/report.ts";
import { ERP_CONTADOR_OPERATIONS, contadorOperationFor } from "../../../src/erp/contador/contract.ts";

const taxes = (over = {}) => ({ total: 0, products: 0, services: 0, discount: 0, freight: 0, insurance: 0, other: 0, icms: 0, icms_st: 0, fcp: 0, ipi: 0, pis: 0, cofins: 0,
  ii: 0, iss: 0, ibs: 0, cbs: 0, is: 0, ...over });
const vault = (over = {}) => ({
  environment: "producao", period: { from: "2026-10-01", to: "2026-10-31" }, pending_reads: 0, complete: true, retry_after_ms: null,
  warnings: [{ code: "nfse_ibs_cbs_not_read", message: "IBS e CBS da NFS-e ainda não são lidos." }],
  issued: {
    by_status: [{ kind: "nfe", status: "authorized", count: 3, amount: 3000 }, { kind: "nfe", status: "cancelled", count: 1, amount: 50 }],
    authorized: { count: 3, amount: 3000, taxes: taxes({ icms: 180.004, icms_st: 12, ipi: 30, pis: 19.5, cofins: 90, iss: 0 }) },
    by_day: [],
    by_cfop: [{ cfop: "5102", count: 2, amount: 1000 }, { cfop: "5405", count: 1, amount: 2000 }],
    by_nature: [{ nature: "Venda de mercadoria", count: 2, amount: 1000 }, { nature: "Revenda com ST", count: 1, amount: 1500 }, { nature: "Prestação de serviço", count: 1, amount: 500 }],
    by_recipient: [],
  },
  received: {
    by_status: [{ status: "authorized", count: 2, amount: 800 }],
    authorized: { count: 2, amount: 800, with_xml: 2, taxes: taxes({ icms: 96 }) }, as_third_party: 1,
    by_cfop: [{ cfop: "1102", count: 2, amount: 800 }], by_issuer: [],
  },
  ...over,
});
const received = { by_nature: [{ nature: "Compra para revenda", count: 2, amount: 800 }], by_cfop: [], by_status: [], with_entry: { count: 1, amount: 500 } };

test("relatório: por CFOP, natureza e situação; impostos destacados; Simples por anexo conforme a natureza", () => {
  const r = buildReport({ environment: "producao", from: "2026-10-01", to: "2026-10-31", vault: vault(), received, crt: "1",
    annexes: { "venda de mercadoria": "I", "Revenda com ST": "I", "Outra": "IX" } });
  assert.equal(r.period.label, "10/2026");
  assert.equal(r.regime.label, "Simples Nacional");
  assert.deepEqual(r.issued.by_cfop.map((l) => l.key), ["5405", "5102"], "maior valor primeiro");
  assert.deepEqual(r.issued.by_status.map((l) => l.label), ["NF-e autorizada", "NF-e cancelada"]);
  assert.deepEqual(r.issued.taxes, { icms: 180, icms_st: 12, ipi: 30, pis: 19.5, cofins: 90, iss: 0 });
  assert.equal(r.received.by_nature[0].label, "Compra para revenda");
  assert.equal(r.received.as_third_party, 1);
  assert.deepEqual(r.simples.by_annex.map((g) => [g.key, g.amount, g.count]), [["I", 2500, 3]]);
  assert.deepEqual(r.simples.unassigned, { amount: 500, count: 1, natures: ["Prestação de serviço"] });
  assert.equal(r.simples.total, 3000);
  assert.ok(r.notices.some((n) => /natureza sem anexo/.test(n)));
  assert.ok(r.notices.some((n) => /IBS e CBS/.test(n)));
  assert.ok(r.notices.some((n) => /não calculam guia/.test(n)));
  // Anexo inválido é ignorado; chave sem acento e caixa.
  assert.deepEqual([...annexMap({ "Prestação de Serviço": "III", x: "IX", y: 3 })], [["prestacao de servico", "III"]]);
  const csv = reportCsv(r);
  assert.ok(csv.startsWith("\uFEFFRelatórios fiscais para o contador;10/2026"));
  assert.match(csv, /\r\nICMS;180,00\r\n/);
  assert.match(csv, /\r\n5405;1;2000,00\r\n/);
  assert.match(csv, /Anexo I \(comércio\);3;2500,00;Revenda com ST, Venda de mercadoria/);
  assert.match(csv, /Sem anexo informado;1;500,00;Prestação de serviço/);
});

test("relatório: regime normal sem Simples; emissor ainda lendo; sem emissor, só o que o ERP tem", () => {
  const normal = buildReport({ environment: "producao", from: "2026-10-01", to: "2026-10-31", vault: vault({ complete: false, pending_reads: 4, retry_after_ms: 1500 }), received, crt: "3", annexes: {} });
  assert.equal(normal.simples, null);
  assert.equal(normal.complete, false);
  assert.equal(normal.retry_after_ms, 1500);
  assert.ok(normal.notices.some((n) => /lendo 4 nota/.test(n)));
  const none = buildReport({ environment: "producao", from: "2026-10-01", to: "2026-10-31", vault: null, vaultProblem: "A área não tem o emissor de notas configurado.", received, crt: null, annexes: {} });
  assert.equal(none.vault, false);
  assert.equal(none.complete, true);
  assert.equal(none.issued.authorized.count, 0);
  assert.equal(none.received.by_nature.length, 1);
  assert.equal(none.notices[0], "A área não tem o emissor de notas configurado.");
  assert.equal(none.regime.label, "Regime não informado no cadastro da empresa");
  // Fórmula de terceiro não vira fórmula na planilha.
  const tricky = buildReport({ environment: "producao", from: "2026-10-01", to: "2026-10-31", vault: null, received: { ...received, by_nature: [{ nature: "=HYPERLINK(1)", count: 1, amount: 1 }] }, crt: null, annexes: {} });
  assert.match(reportCsv(tricky), /\r\n'=HYPERLINK\(1\);1;1,00\r\n/);
});

test("operações com nome estável: rotas, assunto NF-e e só enviar é sensível", () => {
  const forBots = ERP_CONTADOR_OPERATIONS.filter((op) => op.bot !== false);
  assert.deepEqual(forBots.map((op) => op.name), ["nfe.contador.pacotes", "nfe.contador.pacote", "nfe.contador.relatorio", "nfe.contador.enviar"]);
  assert.deepEqual(forBots.filter((op) => op.sensitive).map((op) => op.name), ["nfe.contador.enviar"]);
  assert.ok(ERP_CONTADOR_OPERATIONS.every((op) => op.group === "nfe" && op.path.startsWith("erp-contador/")));
  assert.equal(contadorOperationFor("POST", "erp-contador/envios").operation.name, "nfe.contador.enviar");
  assert.deepEqual(contadorOperationFor("GET", "erp-contador/pacotes/0123456789abcdef/arquivo").params, { id: "0123456789abcdef" });
  assert.equal(contadorOperationFor("DELETE", "erp-contador/pacotes"), null);
});

test("inventário dos bots: as operações do contador, parte Fiscal, e enviar exige a proposta confirmada pela pessoa", async () => {
  const bundle = await build({ entryPoints: ["src/modules/erp/bot-access.ts"], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
  const { ERP_BOT_OPERATIONS, erpBotModules, erpBotDelegation } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
  for (const name of ["nfe.contador.pacotes", "nfe.contador.pacote", "nfe.contador.relatorio", "nfe.contador.enviar"]) {
    const op = ERP_BOT_OPERATIONS.filter((entry) => entry.id === name);
    assert.equal(op.length, 1, name);
    assert.equal(op[0].group, "nfe");
    assert.deepEqual([...erpBotModules(op[0])].sort(), ["erp", "erp-fiscal"]);
  }
  assert.equal(ERP_BOT_OPERATIONS.find((op) => op.id === "nfe.contador.enviar").sensitive, true);
  assert.ok(!ERP_BOT_OPERATIONS.some((op) => op.id === "nfe.contador.cadastro.salvar"), "só pela tela");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE bots(id,profile_id,remote_profile,connection_id,enabled); CREATE TABLE connections(id,profile_id,status,config);
    CREATE TABLE bot_runs(id,profile_id,bot_id,actor,conversation_id,context); CREATE TABLE internal_chats(id,profile_id,member_a,member_b);
    CREATE TABLE bot_proposals(id,profile_id,actor,bot_id,run_id,mode,status,method,decided_at,path,params);
    INSERT INTO bots VALUES('bot-1','area','default','connection-1',1);
    INSERT INTO connections VALUES('connection-1','area','active','{"bot_options":{"default":{"erp_operations":["nfe.contador.relatorio","nfe.contador.enviar"]}}}');
    INSERT INTO bot_runs VALUES('run-1','area','bot-1','person-1',NULL,'{"internal_chat_id":"chat-1"}');
    INSERT INTO internal_chats VALUES('chat-1','area','person-1','bot:bot-1');`);
  const env = { DB: { prepare(sql) { return { bind(...args) { return { async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; } }; } }; } } };
  const actor = { kind: "user", id: "person-1", sessionId: "s1", via: { kind: "bot", bot_id: "bot-1", run_id: "run-1" } };
  const base = "/api/v1/profiles/area/erp-contador";
  assert.equal(await erpBotDelegation(env, actor, "area", "GET", `${base}/relatorio`), true, "leitura concedida");
  assert.equal(await erpBotDelegation(env, actor, "area", "POST", `${base}/pacotes`, { de: "2026-10-01", ate: "2026-10-31" }), false, "montar não concedido");
  const body = { pacote: "0123456789abcdef" };
  assert.equal(await erpBotDelegation(env, actor, "area", "POST", `${base}/envios`, body), false, "sem proposta, não envia");
  db.prepare("INSERT INTO bot_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("prop-1", "area", "person-1", "bot-1", "run-1", "team", "running", "POST", 1, "erp-contador/envios", JSON.stringify(body));
  assert.equal(await erpBotDelegation(env, { ...actor, via: { ...actor.via, proposal_id: "prop-1" } }, "area", "POST", `${base}/envios`, body), true, "proposta confirmada");
  assert.equal(await erpBotDelegation(env, { ...actor, via: { ...actor.via, proposal_id: "prop-1" } }, "area", "POST", `${base}/envios`, { pacote: "fedcba9876543210" }), false, "outro pacote");
});
