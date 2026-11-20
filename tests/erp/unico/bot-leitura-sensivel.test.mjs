// Revisão de acesso, achado B1: leitura do ERP marcada como sensível só roda
// pelo bot com proposta confirmada, salvo a opção explícita do administrador
// (erp_autonomous_operations, desligada por padrão). Leitura comum não muda.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({ stdin: { resolveDir: root, contents: `
  export * from './src/modules/erp/bot-access.ts';
` }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const runtime = mkdtempSync(root + ".bot-leitura-sensivel-runtime-");
const cleanup = () => rmSync(runtime, { recursive: true, force: true });
after(cleanup);
process.on("exit", cleanup);
writeFileSync(runtime + "/runtime.mjs", built.outputFiles[0].text);
const api = await import(runtime + "/runtime.mjs");
const migrations = readdirSync(root + "migrations").filter(name => name.endsWith(".sql")).sort()
  .map(name => readFileSync(root + "migrations/" + name, "utf8"));
const sensitiveRead = "erp.activity.list";
const plainRead = "erp.business.goals";
const at = Date.UTC(2026, 10, 20, 15);

function fixture(t, options = { erp_operations: [sensitiveRead, plainRead] }) {
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
  const actor = { id: person, kind: "user", name: "Pessoa", role: "admin", access: null, profiles: [profile],
    scopes: [], bots: [], rate: 0, runLimit: 0, aal: 2, mfa: { factor: true, policy: "financial" }, sessionId: randomUUID(),
    via: { kind: "bot", bot_id: bot, run_id: run, masked: true } };
  local.prepare("INSERT INTO profiles(id,name,enabled,created) VALUES(?,'Área',1,?)").run(profile, at);
  local.prepare("INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,'Pessoa','test','admin',?,NULL,?)")
    .run(person, `${person}@example.test`, JSON.stringify([profile]), at);
  local.prepare("INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Bot','ai','direct','active',?,?)")
    .run(connection, profile, JSON.stringify({ bot_options: { default: options } }), at);
  local.prepare("INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bot',1)")
    .run(bot, profile, connection);
  local.prepare("INSERT INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(?,?,?,?,?,?)")
    .run(chat, profile, person, `bot:${bot}`, at, at);
  local.prepare("INSERT INTO bot_runs(id,profile_id,bot_id,actor,status,input,context,created,updated) VALUES(?,?,?,?,'running','Pedido',?,?,?)")
    .run(run, profile, bot, person, JSON.stringify({ internal_chat_id: chat }), at, at);
  local.prepare(`INSERT INTO bot_proposals(id,profile_id,mode,actor,bot_id,run_id,chat_id,operation,method,path,params,summary,sensitive,status,expires_at,decided_at,created,updated)
    VALUES(?,?,'team',?,?,?,?,?,'GET','erp/v1/registro-atividades',?,'Consultar registro de atividades',1,'running',?,?,?,?)`)
    .run(proposal, profile, person, bot, run, chat, sensitiveRead, JSON.stringify({ de: "2026-11-01", ate: "2026-11-20" }), at + 60000, at, at, at);
  const path = relative => `/api/v1/profiles/${encodeURIComponent(profile)}/${relative}`;
  const confirmed = { ...actor, via: { ...actor.via, proposal_id: proposal } };
  const read = (subject, relative, method = "GET") => api.erpBotDelegation(env, subject, profile, method, path(relative));
  return { local, env, profile, actor, confirmed, proposal, read };
}

test("B1: o inventário guarda a marca sensível das operações", () => {
  const byId = Object.fromEntries(api.ERP_BOT_OPERATIONS.map(op => [op.id, op]));
  for (const id of ["erp.activity.list", "erp.activity.detail", "erp_cnab_operational_return_file"]) assert.equal(byId[id].sensitive, true, id);
  assert.equal(byId[plainRead].sensitive, false);
  assert.ok(api.ERP_BOT_SENSITIVE_READS.includes(sensitiveRead));
  assert.ok(!api.ERP_BOT_SENSITIVE_READS.includes(plainRead));
});

test("B1: leitura sensível com só a concessão é recusada; leitura comum continua", async t => {
  const f = fixture(t);
  assert.equal(await f.read(f.actor, "erp/v1/registro-atividades"), false);
  assert.equal(await f.read(f.actor, "erp/v1/registro-atividades", "HEAD"), false);
  assert.equal(await f.read(f.actor, "erp/v1/meu-negocio/metas"), true);
});

test("B1: leitura sensível passa pela proposta reclamada e confirmada", async t => {
  const f = fixture(t);
  assert.equal(await f.read(f.confirmed, "erp/v1/registro-atividades"), true);
  // Proposta ainda não decidida, de outra pessoa ou sem sessão não vale.
  assert.equal(await f.read({ ...f.confirmed, sessionId: undefined }, "erp/v1/registro-atividades"), false);
  f.local.prepare("UPDATE bot_proposals SET status='pending', decided_at=NULL WHERE id=?").run(f.proposal);
  assert.equal(await f.read(f.confirmed, "erp/v1/registro-atividades"), false);
});

test("B1: a opção do administrador libera a leitura sensível sem proposta, só com a concessão e na origem interna", async t => {
  const f = fixture(t, { erp_operations: [sensitiveRead], erp_autonomous_operations: [sensitiveRead] });
  assert.equal(await f.read(f.actor, "erp/v1/registro-atividades"), true);
  // Sem a concessão nominal, a opção sozinha não vale.
  const g = fixture(t, { erp_operations: [], erp_autonomous_operations: [sensitiveRead] });
  assert.equal(await g.read(g.actor, "erp/v1/registro-atividades"), false);
  // Origem externa (execução ligada a conversa do WhatsApp) não alcança.
  f.local.exec("UPDATE bot_runs SET conversation_id='whatsapp-da-pessoa'");
  assert.equal(await f.read(f.actor, "erp/v1/registro-atividades"), false);
});

test("B1: a opção só aceita leituras sensíveis conhecidas", () => {
  assert.deepEqual(api.erpBotAutonomousInput([]), []);
  assert.deepEqual(api.erpBotAutonomousInput([sensitiveRead]), [sensitiveRead]);
  for (const value of [null, "*", [plainRead], ["erp_preferences_import_batch"], ["erp_bling_disable"], [sensitiveRead, sensitiveRead]])
    assert.throws(() => api.erpBotAutonomousInput(value), error => error.status === 400);
});
