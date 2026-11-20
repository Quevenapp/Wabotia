import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Sem Worker simulado: SQL de autorização de produção contra as
// migrações D1 completas. O adaptador só traduz a interface D1 para SQLite.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({ stdin: { resolveDir: root, contents: `
  export * from './src/modules/erp/bot-access.ts';
` }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const runtime = mkdtempSync(root + ".bot-grants-runtime-");
const cleanup = () => rmSync(runtime, { recursive: true, force: true });
after(cleanup);
process.on("exit", cleanup);
writeFileSync(runtime + "/runtime.mjs", built.outputFiles[0].text);
const api = await import(runtime + "/runtime.mjs");
const migrations = readdirSync(root + "migrations").filter(name => name.endsWith(".sql")).sort()
  .map(name => readFileSync(root + "migrations/" + name, "utf8"));
const readOperation = "erp.business.goals";
const writeOperation = "erp_preferences_import_batch";
const at = Date.UTC(2026, 10, 19, 15);

function fixture(t, operations = [readOperation, writeOperation, "com1.get", "com1.prepare"]) {
  const local = new DatabaseSync(":memory:");
  t.after(() => local.close());
  for (const sql of migrations) local.exec(sql);
  const prepare = (sql, args = []) => ({
    bind: (...values) => prepare(sql, values),
    async first(key) {
      const row = local.prepare(sql).get(...args) ?? null;
      return key ? row?.[key] ?? null : row && { ...row };
    },
    async all() { return { success: true, results: local.prepare(sql).all(...args).map(row => ({ ...row })) }; },
  });
  const env = { DB: { prepare } };
  const profile = randomUUID(), person = randomUUID(), connection = randomUUID(), bot = randomUUID();
  const run = randomUUID(), chat = randomUUID(), proposal = randomUUID();
  const actor = { id: person, kind: "user", name: "Pessoa", role: "member", access: ["erp:vendas"], profiles: [profile],
    scopes: [], bots: [], rate: 0, runLimit: 0, aal: 2, mfa: { factor: true, policy: "financial" }, sessionId: randomUUID(),
    via: { kind: "bot", bot_id: bot, run_id: run, masked: true } };
  local.prepare("INSERT INTO profiles(id,name,enabled,created) VALUES(?,'Área',1,?)").run(profile, at);
  local.prepare("INSERT INTO profiles(id,name,enabled,created) VALUES('outra-area','Outra área',1,?)").run(at);
  local.prepare("INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,'Pessoa','test','member',?,?,?)")
    .run(person, `${person}@example.test`, JSON.stringify([profile]), JSON.stringify(actor.access), at);
  local.prepare("INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Bot','ai','direct','active',?,?)")
    .run(connection, profile, JSON.stringify({ bot_options: { default: { erp_operations: operations } } }), at);
  local.prepare("INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bot',1)")
    .run(bot, profile, connection);
  local.prepare("INSERT INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)")
    .run(chat, profile, person, `bot:${bot}`, at, at);
  local.prepare("INSERT INTO bot_runs(id,profile_id,bot_id,actor,status,input,context,created,updated) VALUES(?,?,?,?,'running','Pedido',?,?,?)")
    .run(run, profile, bot, person, JSON.stringify({ internal_chat_id: chat }), at, at);
  const proposalPath = "erp/v1/importacoes/:tipo/lote";
  local.prepare(`INSERT INTO bot_proposals(id,profile_id,mode,actor,bot_id,run_id,chat_id,operation,method,path,params,summary,sensitive,status,expires_at,decided_at,created,updated)
    VALUES(?,?,'team',?,?,?,?,?,'POST',?,?,'Confirmar importação',1,'running',?,?,?,?)`)
    .run(proposal, profile, person, bot, run, chat, writeOperation, proposalPath, JSON.stringify({ tipo: "contatos" }), at + 60000, at, at, at);
  const path = relative => `/api/v1/profiles/${encodeURIComponent(profile)}/${relative}`;
  const readPath = path("erp/v1/meu-negocio/metas"), writePath = path("erp/v1/importacoes/contatos/lote");
  const confirmed = { ...actor, via: { ...actor.via, proposal_id: proposal } };
  return { local, env, profile, person, connection, bot, run, chat, proposal, actor, confirmed, path, readPath, writePath,
    read: (subject = actor, destination = readPath) => api.erpBotDelegation(env, subject, profile, "GET", destination),
    write: (subject = confirmed, destination = writePath) => api.erpBotDelegation(env, subject, profile, "POST", destination) };
}

test("concessão nominal aceita somente operações conhecidas e sem repetições", () => {
  assert.deepEqual(api.erpBotOperationsInput([]), []);
  assert.deepEqual(api.erpBotOperationsInput([readOperation, writeOperation, "com1.prepare"]), [readOperation, writeOperation, "com1.prepare"]);
  for (const value of [null, {}, "*", ["*"], ["erp.unknown"], [readOperation, readOperation], [123]])
    assert.throws(() => api.erpBotOperationsInput(value), error => error.status === 400 && error.code === "invalid_request");
});

test("padrão sem configuração mantém leitura e escrita fora da delegação, inclusive via forjado", async t => {
  const f = fixture(t, []);
  assert.equal(await f.read(), false);
  assert.equal(await f.write(), false);
  assert.equal(await f.read({ ...f.actor, via: { ...f.actor.via, erp_operations: [readOperation], granted: true } }), false);
});

test("leitura configurada exige pessoa em conversa interna pelo bot", async t => {
  const f = fixture(t);
  assert.equal(await f.read(), true);
  assert.equal(await f.read({ ...f.actor, kind: "app" }), false);
  assert.equal(await f.read({ ...f.actor, id: `customer:${randomUUID()}` }), false);
});

test("área, rota e operação continuam nominais mesmo com bot configurado", async t => {
  const f = fixture(t);
  assert.equal(await f.read(f.actor, `/api/v1/profiles/${randomUUID()}/erp/v1/meu-negocio/metas`), false);
  assert.equal(await f.read(f.actor, f.path("erp/v1/meu-negocio/metas/extra")), false);
  assert.equal(await f.read(f.actor, f.path("erp/v1/registro-atividades")), false);
  assert.equal(await f.read({ ...f.actor, via: undefined }), false);
  assert.equal(await api.erpBotDelegation(f.env, f.actor, f.profile, "DELETE", f.readPath), false);
  assert.equal(await api.erpBotDelegation(f.env, f.actor, f.profile, "GET"), false);
});

const brokenLinks = [
  ["conexão inativa", "UPDATE connections SET status='paused'"],
  ["bot desabilitado", "UPDATE bots SET enabled=0"],
  ["concessão revogada", "UPDATE connections SET config='{}'"],
  ["configuração de outro perfil remoto", "UPDATE bots SET remote_profile='outro'"],
  ["execução de outra pessoa", "UPDATE bot_runs SET actor='outra-pessoa'"],
  ["execução de outro bot", "UPDATE bot_runs SET bot_id='outro-bot'"],
  ["execução de outra área", "UPDATE bot_runs SET profile_id='outra-area'"],
  ["conexão de outra área", "UPDATE connections SET profile_id='outra-area'"],
  ["bot de outra área", "UPDATE bots SET profile_id='outra-area'"],
  ["conversa interna de outra área", "UPDATE internal_chats SET profile_id='outra-area'"],
  ["conversa interna sem a pessoa", "UPDATE internal_chats SET member_a='outra-pessoa'"],
  ["conversa interna sem o bot", "UPDATE internal_chats SET member_b='bot:outro'"],
  ["execução sem conversa interna", "UPDATE bot_runs SET context='{}'"],
  ["origem externa WhatsApp mesmo com telefone de membro", "UPDATE bot_runs SET conversation_id='whatsapp-da-pessoa'"],
];
for (const [reason, sql] of brokenLinks) test(`${reason} retira imediatamente a delegação`, async t => {
  const f = fixture(t);
  assert.equal(await f.read(), true);
  assert.equal(await f.write(), true);
  f.local.exec(sql);
  assert.equal(await f.read(), false);
  assert.equal(await f.write(), false);
});

test("ordem invertida dos membros da conversa interna mantém a concessão", async t => {
  const f = fixture(t);
  f.local.prepare("UPDATE internal_chats SET member_a=?,member_b=?").run(`bot:${f.bot}`, f.person);
  assert.equal(await f.read(), true);
});

test("escrita exige proposta confirmada em execução e a sessão da pessoa", async t => {
  const f = fixture(t);
  assert.equal(await f.write(), true);
  assert.equal(await f.write(f.actor), false);
  assert.equal(await f.write({ ...f.confirmed, sessionId: undefined }), false);
  assert.equal(await f.write({ ...f.confirmed, via: { ...f.confirmed.via, proposal_id: randomUUID() } }), false);
  assert.equal(await f.write(f.confirmed, f.path("erp/v1/importacoes/produtos/lote")), false);
  for (const [name, sql] of [
    ["pendente", "UPDATE bot_proposals SET status='pending'"],
    ["já executada", "UPDATE bot_proposals SET status='done'"],
    ["não decidida", "UPDATE bot_proposals SET decided_at=NULL"],
    ["modo externo", "UPDATE bot_proposals SET mode='customer'"],
    ["outra pessoa", "UPDATE bot_proposals SET actor='outra-pessoa'"],
    ["outro bot", "UPDATE bot_proposals SET bot_id='outro-bot'"],
    ["outra execução", "UPDATE bot_proposals SET run_id='outra-execucao'"],
    ["outra área", "UPDATE bot_proposals SET profile_id='outra-area'"],
    ["outro método", "UPDATE bot_proposals SET method='PUT'"],
    ["outra rota", "UPDATE bot_proposals SET path='erp/v1/preferencias'"],
  ]) {
    f.local.exec("SAVEPOINT proposal_case");
    f.local.exec(sql);
    assert.equal(await f.write(), false, name);
    f.local.exec("ROLLBACK TO proposal_case; RELEASE proposal_case");
  }
  assert.equal(await f.write(), true);
});

test("catálogo fiscal aplica a mesma concessão nominal e a mesma confirmação", async t => {
  const f = fixture(t), id = randomUUID();
  const fiscalRead = f.path(`erp-comercial-nfe/emissoes/${id}`), fiscalWrite = f.path(`erp-comercial-nfe/pedidos/${id}/preparar`);
  assert.equal(await f.read(f.actor, fiscalRead), true);
  assert.equal(await f.write(f.confirmed, fiscalWrite), false);
  f.local.prepare("UPDATE bot_proposals SET operation='com1.prepare',path='erp-comercial-nfe/pedidos/:id/preparar',params=?")
    .run(JSON.stringify({ id }));
  assert.equal(await f.write(f.confirmed, fiscalWrite), true);
  f.local.exec("UPDATE connections SET config='{}'");
  assert.equal(await f.read(f.actor, fiscalRead), false);
  assert.equal(await f.write(f.confirmed, fiscalWrite), false);
});
