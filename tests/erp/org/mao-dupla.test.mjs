// Mão dupla com o Bling, depois do corte: interruptores desligados por padrão,
// coleta aplicada no ERP pelas funções da adoção, fila de saída retomável com
// conferência por GET, conflito que vira pendência e retomada depois de queda.
// Só SQLite em memória, RPCs do próprio ERP e o Bling simulado (fake-bling.mjs
// com escrita ligada); nenhuma rede, cofre ou Bling de verdade.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation } from "../../../src/erp/bling/adoption-api.ts";
import { runAdoptionUnit, systemIdentity, transaction } from "../../../src/erp/bling/adoption.ts";
import { invokeRpc } from "../../../src/erp/engine/registry.ts";
import { BLING_ADOPTION_B2_ENTITIES, BLING_ADOPTION_OPERATIONS, BLING_ADOPTION_RECORD_ENTITIES, getAdoptionOperation } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_TWO_WAY_ENTITIES, BLING_TWO_WAY_NEVER } from "../../../src/erp/bling/two-way-contracts.ts";
import { runTwoWayLocalUnit, runTwoWayOutboundUnit } from "../../../src/erp/bling/two-way.ts";
import { createBlingWriter, isWritablePath } from "../../../src/erp/bling/writer.ts";
import { FakeBling, FakeClock } from "./fake-bling.mjs";

const bundle = await build({ entryPoints: ["src/modules/erp/bot-access.ts"], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
const { ERP_BOT_OPERATIONS } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

function sqliteStorage(db) {
  let depth = 0;
  return {
    sql: {
      get databaseSize() { return 0; },
      exec(sql, ...params) {
        const statement = db.prepare(sql);
        const columns = statement.columns();
        if (columns.length) {
          statement.setReturnArrays(true);
          const raw = statement.all(...params);
          const rows = raw.map(values => Object.fromEntries(columns.map((column, index) => [column.name, values[index]])));
          return { toArray: () => rows, raw: () => raw, rowsRead: rows.length, rowsWritten: 0 };
        }
        const result = statement.run(...params);
        return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(result.changes) };
      },
    },
    transactionSync(fn) {
      const name = `mao_dupla_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

const area = "mao-dupla", admin = "c7400000-0000-4000-8000-000000000001";
const person = (user_id, erp_role) => ({ user_id, name: "Dona da loja", email: null, erp_role, verified_factor: true });
const identityOf = (agent = false) => ({ actor: { ...person(admin, "admin"), session_id: agent ? null : "sessao-0001", aal: "aal2", is_agent: agent }, people: [person(admin, "admin")] });
let sequence = 0;
const commandId = () => `mao-comando-${++sequence}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - 86_400_000));

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const storage = sqliteStorage(sqlite); migrate(storage);
  const db = storageDriver(storage);
  const parts = normalizeErpParts({});
  const snapshot = () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts });
  sqlite.prepare("INSERT INTO wb_bling_control(id,account_id,credential_status,updated_at) VALUES(1,'conta','ready',?)").run(Date.now());
  const versions = new Map();
  /** Uma versão nova no acervo, como a coleta incremental gravaria. */
  function seed(entity, payload, id = payload.id) {
    const text = JSON.stringify(payload), hash = createHash("sha256").update(text).digest("hex");
    const version = (versions.get(entity + id) ?? 0) + 1; versions.set(entity + id, version);
    const at = Date.now() + version;
    sqlite.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(entity, at);
    sqlite.prepare(`INSERT INTO origin_sync__raw_record(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload, version_hash=excluded.version_hash, version=excluded.version, changed_at=excluded.changed_at`).run(entity, String(id), entity, text, hash, version, at, at, at);
  }
  async function call(name, input, agent = false) {
    const response = await handleAdoptionOperation({ name, identity: identityOf(agent), profile: area, input, authorization: null }, { storage, readSnapshot: async () => snapshot() });
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input) {
    const result = await call(name, input);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  function drain() {
    for (let i = 0; i < 400; i++) if (!runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more) return;
    assert.fail("o lote não terminou");
  }
  // Bling simulado com escrita ligada e o mesmo relógio da fila.
  const clock = new FakeClock(Date.now());
  const fake = new FakeBling({ clock, writes: true });
  const writer = createBlingWriter({ fetch: fake.fetch, baseUrl: fake.baseUrl, accessToken: async () => "token-simulado" });
  const ctx = { profile: area, clock, identity: { actor: null, people: null }, origin: "internal" };
  /** Uma acordada local (entrada e varredura), até acabar. */
  function local() {
    for (let i = 0; i < 50; i++) {
      clock.advance(61_000);
      const result = runTwoWayLocalUnit({ db, profile: area, now: clock.now, parts });
      if (!result.more) return result;
    }
    assert.fail("a varredura não terminou");
  }
  /** Uma acordada da fila de saída (uma chamada HTTP no máximo). */
  async function outbound(w = writer) {
    clock.advance(61_000);
    return runTwoWayOutboundUnit({ db, profile: area, now: clock.now, parts, writer: w, ctx, deadline: clock.now() + 4000 });
  }
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  const one = (sql, ...params) => sqlite.prepare(sql).get(...params);
  return { sqlite, db, storage, seed, call, ok, drain, count, one, clock, fake, writer, local, outbound, parts };
}

/** Contatos e produtos adotados, corte confirmado e o Bling simulado com os mesmos registros. */
async function prepared(extra = () => {}) {
  const f = fixture();
  const ana = { id: "100", nome: "Ana Souza", tipo: "F", situacao: "A", numeroDocumento: "52998224725", tiposContato: [{ descricao: "Cliente" }] };
  const sul = { id: "101", nome: "Distribuidora Sul", tipo: "J", situacao: "A", numeroDocumento: "11222333000181", tiposContato: [{ descricao: "Fornecedor" }] };
  const cafe = { id: "300", nome: "Café 500 g", codigo: "CAFE500", preco: 19.9, unidade: "UN", tipo: "P", formato: "S", situacao: "A" };
  f.seed("contacts", ana); f.seed("contacts", sul); f.seed("products", cafe);
  f.fake.resource("/contatos", [ana, sul]).resource("/produtos", [cafe]);
  extra(f);
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_RECORD_ENTITIES, ...BLING_ADOPTION_B2_ENTITIES] });
  f.drain();
  await f.ok("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: today, acknowledged: true });
  f.ana = () => f.one("SELECT l.record_id AS id, r.name FROM wb_bling_adoption_link l JOIN erp_catalog__record r ON r.id=l.record_id WHERE l.entity='contacts' AND l.source_id='100'");
  /** A pessoa muda o nome no ERP (a detecção não depende de gatilho: compara o que seria enviado). */
  f.renameInErp = name => f.sqlite.prepare("UPDATE erp_catalog__record SET name=?, version=version+1 WHERE id=?").run(name, f.ana().id);
  f.turn = (entity, direction, enabled = true) => f.ok("erp_bling_twoway_switch", { command_id: commandId(), entity, direction, enabled, ...(enabled ? { acknowledged: true } : {}) });
  return f;
}

test("tudo desligado por padrão: com mudança no ERP e o alarme rodando, nenhuma escrita sai", async () => {
  const f = await prepared();
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.equal(status.cutover.confirmed, true);
  assert.deepEqual(status.entities.map(e => e.entity), [...BLING_TWO_WAY_ENTITIES]);
  assert.ok(status.entities.every(e => !e.inbound.enabled && !e.outbound.enabled), "todos os interruptores começam desligados");
  assert.match(status.texts.never, /Notas fiscais e ordens de serviço nunca/);
  f.renameInErp("Ana Souza Lima");
  f.seed("contacts", { id: "101", nome: "Distribuidora Sul Ltda", tipo: "J", situacao: "A", numeroDocumento: "11222333000181" });
  for (let i = 0; i < 5; i++) { f.local(); await f.outbound(); }
  assert.equal(f.fake.mutationAttempts, 0, "nenhuma tentativa de escrita no Bling");
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox"), 0);
  assert.equal(f.one("SELECT name FROM erp_catalog__record r JOIN wb_bling_adoption_link l ON l.record_id=r.id WHERE l.entity='contacts' AND l.source_id='101'").name, "Distribuidora Sul", "entrada desligada: o ERP não muda sozinho");
});

test("ligar pede o aviso e fica registrado; ligar e o ritmo não vão para os bots", async () => {
  const f = await prepared();
  const refused = await f.call("erp_bling_twoway_switch", { command_id: commandId(), entity: "contacts", direction: "outbound", enabled: true });
  assert.equal(refused.status, 400, "sem o aviso confirmado não liga");
  await f.turn("contacts", "outbound");
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.equal(status.entities.find(e => e.entity === "contacts").outbound.enabled, true);
  assert.match(status.audit[0].detail, /Ligou "Escrever no Bling" para contatos .*aviso confirmado/);
  assert.equal(status.audit[0].by, "Dona da loja");
  // Bots: consultar e resolver sim (grupo bling); ligar e ritmo não.
  const bling = new Map(ERP_BOT_OPERATIONS.filter(op => op.group === "bling").map(op => [op.id, op]));
  for (const name of ["erp_bling_twoway_status", "erp_bling_twoway_queue", "erp_bling_twoway_issues", "erp_bling_twoway_resolve"]) assert.ok(bling.has(name), name);
  assert.equal(bling.get("erp_bling_twoway_status").sensitive, false);
  assert.equal(bling.get("erp_bling_twoway_resolve").sensitive, true);
  for (const name of ["erp_bling_twoway_switch", "erp_bling_twoway_pace"]) {
    assert.ok(!ERP_BOT_OPERATIONS.some(op => op.id === name), `${name} fica fora dos bots`);
    assert.ok(!Object.hasOwn(BLING_ADOPTION_OPERATIONS, name));
    assert.ok(getAdoptionOperation(name), "mas existe para a tela");
    const bot = await f.call(name, name.endsWith("switch") ? { command_id: commandId(), entity: "contacts", direction: "outbound", enabled: false } : { command_id: commandId(), minutes: 30 }, true);
    assert.equal(bot.status, 403); assert.equal(bot.body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  }
  const pace = await f.ok("erp_bling_twoway_pace", { command_id: commandId(), minutes: 30 });
  assert.equal(pace.minutes, 30);
  assert.equal((await f.ok("erp_bling_twoway_status", {})).pace_minutes, 30);
});

test("nunca nota fiscal nem ordem de serviço", async () => {
  const f = await prepared();
  for (const entity of BLING_TWO_WAY_NEVER) {
    assert.ok(!BLING_TWO_WAY_ENTITIES.includes(entity));
    assert.equal((await f.call("erp_bling_twoway_switch", { command_id: commandId(), entity, direction: "outbound", enabled: true, acknowledged: true })).status, 400);
  }
  for (const path of ["/nfe", "/nfce", "/ordens-servico", "/nfe/123"]) { assert.equal(isWritablePath("POST", path), false, path); assert.equal(isWritablePath("PUT", path), false, path); }
  assert.equal((await f.writer.send({ profile: area, clock: f.clock, identity: { actor: null, people: null }, origin: "internal" }, { method: "POST", path: "/nfe", body: {}, deadline: f.clock.now() + 3000 })).kind, "rejected");
  assert.equal(f.fake.mutationAttempts, 0);
});

test("mudança no ERP vai ao Bling; resposta incerta é conferida por GET antes de qualquer reenvio", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  f.local(); // primeira varredura: o ERP de agora vale como ponto de partida, nada sai
  await f.outbound();
  assert.equal(f.fake.mutationAttempts, 0, "ligar não reenvia o que já está igual");
  // 1) O Bling grava mas a conexão cai antes da resposta: incerto, conferido, sem repetir.
  f.renameInErp("Ana Souza Lima");
  f.local();
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state='pending'"), 1);
  f.fake.queue({ method: "PUT", path: "/contatos/100", apply: true, throw: true });
  await f.outbound();
  let item = f.one("SELECT * FROM wb_bling_twoway_outbox");
  assert.equal(item.state, "uncertain");
  assert.match(item.error_text, /confere no Bling se a mudança entrou/);
  assert.equal(f.fake.mutationAttempts, 1);
  await f.outbound();
  item = f.one("SELECT * FROM wb_bling_twoway_outbox");
  assert.equal(item.state, "done", "a conferência achou a mudança no Bling");
  assert.equal(f.fake.mutationAttempts, 1, "nenhuma repetição às cegas");
  assert.deepEqual(f.fake.calls.slice(-2).map(c => `${c.method} ${c.path}`), ["PUT /contatos/100", "GET /contatos/100"]);
  assert.equal(f.fake.record("/contatos", "100").nome, "Ana Souza Lima");
  assert.equal(f.fake.record("/contatos", "100").tiposContato?.[0]?.descricao, "Cliente", "PUT parte do detalhe do Bling: o que o ERP não guarda continua lá");
  // 2) A conexão cai sem gravar: a conferência vê que não entrou e só então reenvia.
  f.renameInErp("Ana S. Lima");
  f.local();
  f.fake.queue({ method: "PUT", path: "/contatos/100", apply: false, throw: true });
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox WHERE state<>'done'").state, "uncertain");
  await f.outbound(); // GET: não entrou → volta para a fila
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox WHERE state<>'done'").state, "pending");
  await f.outbound(); // agora sim, envia de novo
  assert.deepEqual(f.fake.calls.slice(-3).map(c => `${c.method} ${c.path}`), ["PUT /contatos/100", "GET /contatos/100", "PUT /contatos/100"]);
  assert.equal(f.fake.record("/contatos", "100").nome, "Ana S. Lima");
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state='done'"), 2);
  // O eco da nossa escrita, trazido pela coleta, não vira conflito nem reenvio.
  await f.turn("contacts", "inbound");
  f.seed("contacts", f.fake.record("/contatos", "100"));
  f.local();
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_issue WHERE state='open'"), 0);
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state='pending'"), 0);
  assert.equal(f.ana().name, "Ana S. Lima");
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.equal(status.last_out.counts.confirmed, 2);
  assert.ok(status.last_out.at);
});

test("erro definitivo vira pendência com o motivo em palavras; tentar de novo depois de corrigir", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  f.local();
  f.renameInErp("RECUSAR");
  f.local();
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "failed");
  const issues = await f.ok("erp_bling_twoway_issues", {});
  assert.equal(issues.total, 1);
  assert.equal(issues.items[0].kind, "failed");
  assert.match(issues.items[0].reason, /O Bling recusou os dados\. Motivo informado pelo Bling: Não foi possível salvar o contato O nome informado não é aceito\./);
  assert.deepEqual(issues.items[0].actions.map(a => a.action), ["retry", "discard"]);
  assert.equal(f.fake.mutationAttempts, 1);
  await f.outbound();
  assert.equal(f.fake.mutationAttempts, 1, "recusado não é repetido sozinho");
  const resolved = await f.ok("erp_bling_twoway_resolve", { command_id: commandId(), key: issues.items[0].key, action: "discard" });
  assert.equal(resolved.outcome, "discarded");
  f.local();
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state='pending'"), 0, "deixar como está não reenfileira a mesma mudança");
});

test("conflito: mudou nos dois lados vira pendência com os dois valores; nada é sobrescrito", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  await f.turn("contacts", "inbound");
  f.local();
  // Sem conflito, a mais recente vence: só o Bling mudou → o ERP recebe.
  f.seed("contacts", { id: "101", nome: "Distribuidora Sul Ltda", tipo: "J", situacao: "A", numeroDocumento: "11222333000181", tiposContato: [{ descricao: "Fornecedor" }] });
  f.local();
  assert.equal(f.one("SELECT r.name FROM erp_catalog__record r JOIN wb_bling_adoption_link l ON l.record_id=r.id WHERE l.entity='contacts' AND l.source_id='101'").name, "Distribuidora Sul Ltda");
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox"), 0, "aplicar o que veio do Bling não volta para o Bling");
  // Agora os dois lados mudam o mesmo contato.
  f.renameInErp("Ana Souza (ERP)");
  f.seed("contacts", { id: "100", nome: "Ana Souza (Bling)", tipo: "F", situacao: "A", numeroDocumento: "52998224725", tiposContato: [{ descricao: "Cliente" }] });
  f.local();
  for (let i = 0; i < 3; i++) await f.outbound();
  assert.equal(f.fake.mutationAttempts, 0, "nada foi enviado ao Bling");
  assert.equal(f.ana().name, "Ana Souza (ERP)", "nada foi sobrescrito no ERP");
  const issues = await f.ok("erp_bling_twoway_issues", {});
  const conflict = issues.items.find(i => i.kind === "conflict");
  assert.ok(conflict);
  assert.equal(conflict.erp["Nome"], "Ana Souza (ERP)");
  assert.equal(conflict.bling["Nome"], "Ana Souza (Bling)");
  assert.deepEqual(conflict.actions.map(a => a.action), ["use_bling", "use_erp"]);
  // A pessoa escolhe a do ERP: vai para a fila e é gravada no Bling.
  const chosen = await f.ok("erp_bling_twoway_resolve", { command_id: commandId(), key: conflict.key, action: "use_erp" });
  assert.equal(chosen.outcome, "queued");
  await f.outbound();
  assert.equal(f.fake.record("/contatos", "100").nome, "Ana Souza (ERP)");
  assert.equal((await f.ok("erp_bling_twoway_issues", {})).total, 0);
});

test("conflito resolvido pela versão do Bling aplica no ERP e descarta o envio parado", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  await f.turn("contacts", "inbound");
  f.local();
  f.renameInErp("Ana do ERP");
  f.local(); // envio na fila
  f.seed("contacts", { id: "100", nome: "Ana do Bling", tipo: "F", situacao: "A", numeroDocumento: "52998224725", tiposContato: [{ descricao: "Cliente" }] });
  f.local(); // a coleta trouxe a mudança do Bling: conflito, envio parado
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "held");
  await f.outbound();
  assert.equal(f.fake.mutationAttempts, 0);
  const key = (await f.ok("erp_bling_twoway_issues", {})).items[0].key;
  assert.equal((await f.ok("erp_bling_twoway_resolve", { command_id: commandId(), key, action: "use_bling" })).outcome, "applied");
  assert.equal(f.ana().name, "Ana do Bling");
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "superseded");
  f.local(); await f.outbound();
  assert.equal(f.fake.mutationAttempts, 0, "a versão do Bling não volta para o Bling");
});

test("retomada depois de queda: o item que ficou enviando é conferido no Bling, não reenviado", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  f.local();
  f.renameInErp("Ana depois da queda");
  f.local();
  // O objeto cai depois de o Bling gravar e antes de registrar a resposta.
  const crashing = { send: async (ctx, request) => { await f.writer.send(ctx, request); throw new Error("queda do objeto"); }, read: f.writer.read };
  await assert.rejects(f.outbound(crashing), /queda do objeto/);
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "sending");
  assert.equal(f.fake.mutationAttempts, 1);
  await f.outbound(); // retomada: vira conferência, sem HTTP
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "uncertain");
  await f.outbound(); // GET
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "done");
  assert.equal(f.fake.mutationAttempts, 1, "a mudança entrou uma vez só");
  assert.deepEqual(f.fake.calls.map(c => c.method), ["PUT", "GET"]);
});

test("desligar depois de enfileirar: o pendente não sai", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  f.local();
  f.renameInErp("Ana fila parada");
  f.local();
  await f.turn("contacts", "outbound", false);
  for (let i = 0; i < 3; i++) await f.outbound();
  assert.equal(f.fake.mutationAttempts, 0);
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "pending");
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.match(status.audit[0].detail, /Desligou "Escrever no Bling" para contatos/);
});

test("contato criado no ERP depois do corte é criado no Bling; a coleta liga, sem adotar de novo", async () => {
  const f = await prepared();
  await f.turn("contacts", "outbound");
  await f.turn("contacts", "inbound");
  f.local();
  // Contato novo no ERP (pela tela, aqui direto nas tabelas do cadastro).
  const id = "0c7400aa-0000-4000-8000-000000000001", micros = BigInt(Date.now() + 5_000) * 1000n;
  f.sqlite.prepare("INSERT INTO erp_catalog__record(id,entity,name,code,active,version,human_edited,created_at,updated_at) VALUES(?,'contacts','Bruno Novo',NULL,1,1,1,?,?)").run(id, micros.toString(), micros.toString());
  f.sqlite.prepare("INSERT INTO erp_catalog__contact(record_id,person_type,document,roles) VALUES(?,'F','39053344705','[\"customer\"]')").run(id);
  f.local();
  const item = f.one("SELECT op, state FROM wb_bling_twoway_outbox");
  assert.deepEqual({ ...item }, { op: "create", state: "pending" });
  // O POST grava, mas a resposta não chega: a conferência procura pelo CPF.
  f.fake.queue({ method: "POST", path: "/contatos", apply: true, status: 502 });
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "uncertain");
  await f.outbound();
  const done = f.one("SELECT state, remote_id FROM wb_bling_twoway_outbox");
  assert.equal(done.state, "done");
  assert.equal(f.fake.mutationAttempts, 1);
  assert.equal(f.fake.calls.at(-1).path, "/contatos");
  assert.equal(f.fake.calls.at(-1).query.numeroDocumento, "39053344705");
  assert.equal(f.one("SELECT source_id FROM wb_bling_twoway_state WHERE entity='contacts' AND record_id=?", id).source_id, done.remote_id);
  // A coleta traz o contato que nós criamos: liga ao mesmo cadastro, não cria outro.
  const contactsBefore = f.count("SELECT count(*) AS n FROM erp_catalog__record WHERE entity='contacts'");
  f.seed("contacts", f.fake.record("/contatos", done.remote_id));
  f.local();
  assert.equal(f.count("SELECT count(*) AS n FROM erp_catalog__record WHERE entity='contacts'"), contactsBefore);
  assert.equal(f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id=?", done.remote_id).record_id, id);
  assert.equal(f.fake.mutationAttempts, 1);
});

test("saldo de estoque: o do ERP vai como balanço e é conferido; o do Bling entra como ajuste", async () => {
  const f = await prepared();
  f.seed("warehouses", { id: "400", descricao: "Loja" });
  await f.ok("erp_bling_adoption_adopt_one", { command_id: commandId(), entity: "warehouses", source_id: "400" });
  const product = f.one("SELECT record_id AS id FROM wb_bling_adoption_link WHERE entity='products' AND source_id='300'").id;
  const warehouse = f.one("SELECT record_id AS id FROM wb_bling_adoption_link WHERE entity='warehouses' AND source_id='400'").id;
  const balance = () => Number(f.one("SELECT quantity FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse)?.quantity ?? 0) / 1e6;
  f.fake.setStock("300", "400", 5);
  await f.turn("stock_balances", "inbound");
  // A coleta trouxe 7 no Bling: o ERP é ajustado para 7.
  f.seed("stock_balances", { produto: { id: "300" }, depositos: [{ id: "400", saldoFisico: 7 }] }, "300");
  f.local();
  assert.equal(balance(), 7);
  await f.turn("stock_balances", "outbound");
  f.local(); // ponto de partida
  // Venda no ERP: o saldo cai para 4 e o balanço vai ao Bling.
  const version = Number(f.one("SELECT version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse).version);
  f.sqlite.prepare("UPDATE erp_stock__balance SET quantity=?, version=? WHERE product_id=? AND warehouse_id=?").run(4_000000, version + 1, product, warehouse);
  f.local();
  f.fake.queue({ method: "POST", path: "/estoques", apply: true, throw: true });
  await f.outbound();
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox WHERE op='stock'").state, "done");
  assert.equal(f.fake.stock("300", "400"), 4);
  assert.equal(f.fake.mutationAttempts, 1, "balanço conferido, não repetido");
  assert.equal(f.fake.calls.at(-1).path, "/estoques/saldos");
});

test("baixa feita no ERP vai ao Bling como baixa da conta; incerta, é conferida pelo saldo", async () => {
  const receivable = { id: "6001", situacao: 1, vencimento: "2026-12-01", valor: 100, saldo: 100, dataEmissao: "2026-11-01", numeroDocumento: "NF 1", contato: { id: "100" }, categoria: { id: "600" }, portador: { id: "700" } };
  const f = await prepared(f => {
    f.seed("financial_categories", { id: "600", descricao: "Vendas", tipo: 2 });
    f.seed("ledger_accounts", { id: "700", descricao: "Caixa da loja" });
    f.seed("receivables", receivable);
    f.fake.resource("/contas/receber", [receivable]);
  });
  const title = f.one("SELECT record_id AS id FROM wb_bling_adoption_doc_link WHERE entity='receivables' AND source_id='6001'").id;
  const account = f.one("SELECT record_id AS id FROM wb_bling_adoption_link WHERE entity='ledger_accounts' AND source_id='700'").id;
  await f.turn("receivables", "outbound");
  f.local(); // ponto de partida da conta
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox"), 0);
  // Recebimento parcial de R$ 40,00 no ERP, pela RPC da tela.
  const version = Number(f.one("SELECT version FROM erp_finance__title WHERE id=?", title).version);
  const posted = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  transaction(f.db, area, ctx => invokeRpc(ctx, "erp_finance_execute", { p_user_id: admin, p_command_id: "0c7400bb-0000-4000-8000-000000000001", p_action: "settle",
    p_data: { id: title, expected_version: version, account_id: account, posted_on: posted, principal_cents: "4000" } }), { identity: systemIdentity(admin), parts: f.parts });
  f.local();
  const queued = f.one("SELECT op, state, request FROM wb_bling_twoway_outbox");
  assert.equal(queued.op, "settle");
  const request = JSON.parse(queued.request);
  assert.equal(request.path, "/contas/receber/6001/baixar");
  assert.equal(request.body.valorRecebido, 40);
  assert.equal(request.body.portador.id, 700);
  f.fake.queue({ method: "POST", path: "/contas/receber/6001/baixar", apply: true, throw: true });
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "uncertain");
  await f.outbound();
  assert.equal(f.one("SELECT state FROM wb_bling_twoway_outbox").state, "done", "o saldo no Bling já mostra a baixa");
  assert.equal(f.fake.record("/contas/receber", "6001").saldo, 60);
  assert.equal(f.fake.mutationAttempts, 1, "a baixa não foi repetida");
  f.local();
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_twoway_outbox WHERE state='pending'"), 0, "a mesma baixa não volta para a fila");
});
