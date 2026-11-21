// Campos próprios de contato (esquema do ERP versão 20): definição, valores,
// campo sensível (liberação com aviso e registro), coluna e filtro da lista,
// importação, papéis do ERP e a parte Cadastros sozinha. Só o motor (SQLite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { ENGINE_SIGNATURES } from "../../../src/erp/engine/signatures-engine.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { ERP_STRUCTURAL } from "../../../src/erp/schema/structural.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { contactFieldValue } from "../../../src/erp/domains/catalog/contact-fields.ts";

const person = (user_id, erp_role, name) => ({ user_id, erp_role, name, email: null, verified_factor: false, aal: "aal1", session_id: null, is_agent: false });
const admin = person("11111111-1111-4111-8111-111111111111", "admin", "Ana Admin");
const sales = person("22222222-2222-4222-8222-222222222222", "vendas", "Vera Vendas");
const viewer = person("33333333-3333-4333-8333-333333333333", "consulta", "Caio Consulta");
const people = [admin, sales, viewer];
// Só Cadastros ligado: nada aqui pode pedir Produtos, Vendas ou Financeiro.
const ONLY_BASE = { products: false, stock: false, finance: false, purchases: false, sales: false, fiscal: false, billing: false, pos: false };
const RPCS = ["erp_catalog_contact_fields", "erp_catalog_contact_field_save", "erp_catalog_contact_field_delete", "erp_catalog_contact_field_values",
  "erp_catalog_contact_field_values_save", "erp_catalog_contact_field_bulk", "erp_catalog_contact_field_bulk_save", "erp_catalog_contact_field_page"];

function fixture(t) {
  const lite = freshLite(), db = nodeDriver(lite);
  t.after(() => lite.close());
  const rpc = (name, args = {}, who = admin, { agent = false, parts = ONLY_BASE } = {}) =>
    callRpc(db, name, { p_user_id: who.user_id, ...args }, undefined, { identity: { actor: { ...who, is_agent: agent }, people }, parts });
  const contact = (data) => callRpc(db, "erp_catalog_contact_save", { p_user_id: admin.user_id, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_data: { person_type: "J", ...data } }, undefined, { identity: { actor: admin, people }, parts: ONLY_BASE }).record;
  const field = (data, who = admin) => rpc("erp_catalog_contact_field_save", { p_command_id: randomUUID(), p_data: data }, who);
  const save = (contactId, values, who = admin, opts) => rpc("erp_catalog_contact_field_values_save", { p_contact_id: contactId, p_command_id: randomUUID(), p_values: values }, who, opts);
  const count = (sql, ...args) => Number(lite.prepare(sql).get(...args).n);
  return { lite, db, rpc, contact, field, save, count };
}

test("esquema: versão 20, três tabelas novas só aditivas, estrutura declarada e RPCs classificados na parte Cadastros", () => {
  assert.equal(ERP_DDL_VERSION, 20);
  const mine = ERP_ENGINE_TABLES.filter(t => t.since === 20).map(t => t.table).sort();
  assert.deepEqual(mine, ["erp_catalog__contact_field", "erp_catalog__contact_field_audit", "erp_catalog__contact_field_value"]);
  assert.ok(ERP_ENGINE_TABLES.filter(t => t.since === 20).every(t => ERP_STRUCTURAL.some(s => s.id === t.structural)));
  for (const name of RPCS) { assert.equal(ERP_RPC_RULES[name], "base", name); assert.ok(ENGINE_SIGNATURES[name], name); }
});

test("subida de uma instância na versão 16 cria as tabelas da 20 sem mexer no resto", () => {
  const lite = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(sql, ...params) {
      const st = lite.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) { const rows = st.all(...params); return { toArray: () => rows, rowsWritten: 0 }; }
      const r = st.run(...params); return { toArray: () => [], rowsWritten: Number(r.changes) };
    } },
    transactionSync(fn) { lite.exec("BEGIN"); try { const out = fn(); lite.exec("COMMIT"); return out; } catch (e) { lite.exec("ROLLBACK"); throw e; } },
  };
  assert.equal(migrate(storage).status, "applied");
  for (const t of ERP_ENGINE_TABLES.filter(t => t.since === 20)) lite.exec(`DROP TABLE "${t.table}"`);
  lite.exec("UPDATE erp_meta SET value='16' WHERE key='schema_version'");
  const out = migrate(storage);
  assert.equal(out.status, "applied");
  assert.equal(out.version, 20);
  const tables = lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'erp_catalog__contact_field%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ["erp_catalog__contact_field", "erp_catalog__contact_field_audit", "erp_catalog__contact_field_value"]);
  lite.close();
});

test("definição: tipos, papéis, opções, nome repetido, versão e só o administrador define", t => {
  const f = fixture(t);
  const color = f.field({ name: "Cor preferida", field_type: "list", roles: ["customer"], options: [{ label: "Azul" }, { label: "Verde" }], list_column: true, list_filter: true });
  assert.equal(color.saved, true);
  assert.equal(color.field.options.length, 2);
  assert.equal(color.field.contacts, 0);
  assert.deepEqual(f.field({ name: "  cor   PREFERIDA ", field_type: "text", roles: ["supplier"] }), { saved: false, reason: "duplicate_name", data_mode: "erp_native" });
  assert.throws(() => f.field({ name: "Sem papel", field_type: "text", roles: [] }), /erp_contact_field_invalid:roles/);
  assert.throws(() => f.field({ name: "Lista vazia", field_type: "list", roles: ["customer"] }), /erp_contact_field_invalid:options/);
  assert.throws(() => f.field({ name: "Tipo novo", field_type: "cpf", roles: ["customer"] }), /erp_contact_field_invalid:field_type/);
  assert.throws(() => f.field({ name: "Do vendedor", field_type: "text", roles: ["customer"] }, sales), e => e.code === "42501" && e.message === "erp_contact_field_permission");
  // Versão: alterar com a versão antiga é conflito.
  const renamed = f.rpc("erp_catalog_contact_field_save", { p_id: color.field.id, p_expected_version: 1, p_command_id: randomUUID(), p_data: { name: "Cor favorita" } });
  assert.equal(renamed.field.version, 2);
  assert.throws(() => f.rpc("erp_catalog_contact_field_save", { p_id: color.field.id, p_expected_version: 1, p_command_id: randomUUID(), p_data: { required: true } }), e => e.code === "40001");
  // Comando repetido devolve o mesmo resultado sem gravar de novo.
  const command = randomUUID();
  const first = f.rpc("erp_catalog_contact_field_save", { p_command_id: command, p_data: { name: "Aniversário da loja", field_type: "date", roles: ["customer", "seller"] } });
  const again = f.rpc("erp_catalog_contact_field_save", { p_command_id: command, p_data: { name: "Aniversário da loja", field_type: "date", roles: ["customer", "seller"] } });
  assert.equal(again.replayed, true);
  assert.equal(again.field.id, first.field.id);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field"), 2);
  // Quem consulta contatos lê as definições; Preferências (admin) é só do administrador.
  assert.equal(f.rpc("erp_catalog_contact_fields", {}, viewer).items.length, 2);
  assert.equal(f.rpc("erp_catalog_contact_fields", {}, viewer).permissions.manage, false);
  assert.throws(() => f.rpc("erp_catalog_contact_fields", { p_audience: "admin" }, viewer), e => e.code === "42501");
});

test("valores: validação por tipo, obrigatório, tipo de contato, vendedor e registro sem os valores", t => {
  const f = fixture(t);
  const client = f.contact({ name: "Cliente Um", roles: ["customer"] });
  const supplier = f.contact({ name: "Fornecedor Um", roles: ["supplier"] });
  const sellerContact = f.contact({ name: "Vendedor Um", roles: [] });
  f.lite.prepare(`INSERT INTO erp_catalog__seller(id, contact_id, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,1,1)`).run(randomUUID(), sellerContact.id, admin.user_id, admin.user_id);
  const code = f.field({ name: "Código no cliente", field_type: "text", roles: ["customer"], required: true }).field;
  const limit = f.field({ name: "Limite combinado", field_type: "number", roles: ["customer", "supplier"] }).field;
  const visit = f.field({ name: "Última visita", field_type: "date", roles: ["customer", "seller"] }).field;
  const vip = f.field({ name: "Cliente VIP", field_type: "boolean", roles: ["customer"] }).field;
  const size = f.field({ name: "Porte", field_type: "list", roles: ["customer"], options: [{ label: "Pequeno" }, { label: "Grande" }] }).field;

  // O painel salva o formulário inteiro: obrigatório vale.
  const missing = f.save(client.id, { [limit.id]: "10" });
  assert.equal(missing.saved, false);
  assert.deepEqual(missing.errors.map(e => [e.name, e.code]), [["Código no cliente", "required"]]);
  const wrong = f.save(client.id, { [code.id]: "A1", [limit.id]: "1.2.3", [visit.id]: "31/02/2026", [vip.id]: "talvez", [size.id]: "Médio" });
  assert.deepEqual(wrong.errors.map(e => e.code).sort(), ["boolean", "date", "list", "number"]);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field_value"), 0, "erro em um campo: nada é gravado");
  const ok = f.save(client.id, { [code.id]: " A1 ", [limit.id]: "1500,50", [visit.id]: "05/11/2026", [vip.id]: "Sim", [size.id]: "grande" });
  assert.equal(ok.saved, true);
  assert.deepEqual(ok.values, { [code.id]: "A1", [limit.id]: "1500.5", [visit.id]: "2026-11-05", [vip.id]: "true", [size.id]: size.options[1].id });
  // Campo de outro tipo de contato não se aplica.
  assert.deepEqual(f.save(supplier.id, { [code.id]: "X" }).errors.map(e => e.code), ["not_applicable"]);
  assert.deepEqual(f.rpc("erp_catalog_contact_field_values", { p_contact_id: supplier.id }).fields.map(x => x.id), [limit.id]);
  // Vendedor é o contato com cadastro de vendedor.
  const sellerView = f.rpc("erp_catalog_contact_field_values", { p_contact_id: sellerContact.id });
  assert.deepEqual(sellerView.roles, ["seller"]);
  assert.deepEqual(sellerView.fields.map(x => x.id), [visit.id]);
  // O registro diz quais campos mudaram, nunca os valores.
  const audit = f.lite.prepare("SELECT action, after_data FROM erp_catalog__contact_field_audit WHERE action='values'").all();
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0].after_data, /A1|1500/);
  // Quem só consulta não grava; o cadastro do contato (versão) não muda.
  assert.throws(() => f.save(client.id, { [code.id]: "B2" }, viewer), e => e.code === "42501");
  assert.equal(Number(f.lite.prepare("SELECT version v FROM erp_catalog__record WHERE id=?").get(client.id).v), client.version);
  assert.equal(contactFieldValue({ field_type: "number", options: [] }, "-0,000").value, "0");
});

test("campo sensível: fora da ficha, da lista e dos bots até o administrador liberar com aviso e registro", t => {
  const f = fixture(t);
  const client = f.contact({ name: "Cliente Sigiloso", roles: ["customer"] });
  const plain = f.field({ name: "Apelido", field_type: "text", roles: ["customer"], list_column: true, list_filter: true }).field;
  const secret = f.field({ name: "Saúde", field_type: "text", roles: ["customer"], sensitive: true, list_column: true, list_filter: true }).field;
  assert.equal(secret.list_column, false, "sensível sem liberação não vira coluna");
  assert.equal(secret.list_filter, false);
  f.save(client.id, { [plain.id]: "Zé", [secret.id]: "Alergia" });
  // O cadastro (quem edita) vê; ficha, lista e bot não.
  assert.ok(f.rpc("erp_catalog_contact_field_values", { p_contact_id: client.id }).fields.some(x => x.id === secret.id));
  const card = f.rpc("erp_catalog_contact_field_values", { p_contact_id: client.id, p_audience: "card" });
  assert.deepEqual(card.fields.map(x => x.id), [plain.id]);
  assert.equal(card.hidden, 1);
  assert.equal(card.values[secret.id], undefined);
  // Identidade de agente vale agent mesmo pedindo o cadastro.
  const bot = f.rpc("erp_catalog_contact_field_values", { p_contact_id: client.id, p_audience: "panel" }, admin, { agent: true });
  assert.equal(bot.audience, "agent");
  assert.deepEqual(Object.keys(bot.values), [plain.id]);
  assert.deepEqual(f.save(client.id, { [secret.id]: "Outra" }, admin, { agent: true }).errors.map(e => e.code), ["unknown"]);
  assert.deepEqual(f.rpc("erp_catalog_contact_fields", {}, admin, { agent: true }).items.map(x => x.id), [plain.id]);
  const bulk = f.rpc("erp_catalog_contact_field_bulk", { p_ids: [client.id] });
  assert.deepEqual(bulk.items[0].values, { [plain.id]: "Zé" });
  assert.throws(() => f.rpc("erp_catalog_contact_field_page", { p_situation: "all", p_fields: [{ field_id: secret.id, value: "Alergia" }] }), /erp_contact_field_filter_unavailable/);
  // Liberar sem confirmar o aviso é recusado; confirmado, fica registrado com quem e quando.
  assert.throws(() => f.rpc("erp_catalog_contact_field_save", { p_id: secret.id, p_expected_version: secret.version, p_command_id: randomUUID(), p_data: { exposed: true } }), /erp_contact_field_exposure_ack/);
  const exposed = f.rpc("erp_catalog_contact_field_save", { p_id: secret.id, p_expected_version: secret.version, p_command_id: randomUUID(),
    p_data: { exposed: true, exposure_ack: true, list_column: true, list_filter: true } }).field;
  assert.equal(exposed.exposed, true);
  assert.equal(exposed.exposed_by, admin.user_id);
  assert.equal(exposed.exposed_by_name, "Ana Admin");
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field_audit WHERE action='expose' AND field_id=?", secret.id), 1);
  assert.deepEqual(Object.keys(f.rpc("erp_catalog_contact_field_bulk", { p_ids: [client.id] }).items[0].values).sort(), [plain.id, secret.id].sort());
  assert.equal(f.rpc("erp_catalog_contact_field_page", { p_situation: "all", p_fields: [{ field_id: secret.id, value: "alerg" }] }).total, 1);
  // Recolher também fica registrado e volta a esconder.
  f.rpc("erp_catalog_contact_field_save", { p_id: secret.id, p_expected_version: exposed.version, p_command_id: randomUUID(), p_data: { exposed: false } });
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field_audit WHERE action='unexpose'"), 1);
  assert.equal(f.rpc("erp_catalog_contact_field_values", { p_contact_id: client.id, p_audience: "card" }).hidden, 1);
  // O registro é imutável.
  assert.throws(() => f.lite.exec("DELETE FROM erp_catalog__contact_field_audit"), /immutable/);
});

test("lista: filtro por campo próprio com a mesma página da lista portada; colunas pelos valores em lote", t => {
  const f = fixture(t);
  const a = f.contact({ name: "Alfa", roles: ["customer"] }), b = f.contact({ name: "Beta", roles: ["customer"] }), c = f.contact({ name: "Gama", roles: ["customer"] });
  const vip = f.field({ name: "VIP", field_type: "boolean", roles: ["customer"], list_filter: true, list_column: true }).field;
  const score = f.field({ name: "Pontos", field_type: "number", roles: ["customer"], list_filter: true }).field;
  const city = f.field({ name: "Bairro de entrega", field_type: "text", roles: ["customer"], list_filter: true }).field;
  const hiddenFilter = f.field({ name: "Sem filtro", field_type: "text", roles: ["customer"] }).field;
  f.save(a.id, { [vip.id]: true, [score.id]: "10", [city.id]: "Centro" });
  f.save(b.id, { [vip.id]: false, [score.id]: "200", [city.id]: "Jardim Centro" });
  const page = filters => f.rpc("erp_catalog_contact_field_page", { p_situation: "all", p_sort: "name_asc", p_fields: filters });
  assert.deepEqual(page([{ field_id: vip.id, value: "Sim" }]).items.map(x => x.name), ["Alfa"]);
  assert.deepEqual(page([{ field_id: vip.id, value: "Não" }]).items.map(x => x.name), ["Beta", "Gama"], "sem valor conta como Não");
  assert.deepEqual(page([{ field_id: score.id, from: "50" }]).items.map(x => x.name), ["Beta"]);
  assert.deepEqual(page([{ field_id: city.id, value: "centro" }, { field_id: score.id, to: "100" }]).items.map(x => x.name), ["Alfa"]);
  assert.equal(page([]).total, 3);
  assert.throws(() => page([{ field_id: hiddenFilter.id, value: "x" }]), /erp_contact_field_filter_unavailable/);
  assert.throws(() => page([{ field_id: score.id, from: "9", to: "1" }]), /erp_catalog_invalid_query/);
  const bulk = f.rpc("erp_catalog_contact_field_bulk", { p_ids: [a.id, b.id, c.id] });
  assert.deepEqual(bulk.items.map(x => x.values[vip.id] ?? null), ["true", "false", null]);
});

test("importação: cada linha passa ou fica de fora sozinha, com o comando repetível", t => {
  const f = fixture(t);
  const a = f.contact({ name: "Importado A", roles: ["customer"] }), b = f.contact({ name: "Importado B", roles: ["customer"] });
  const level = f.field({ name: "Nível", field_type: "list", roles: ["customer"], options: [{ label: "Ouro" }, { label: "Prata" }] }).field;
  const command = randomUUID();
  const items = [{ contact_id: a.id, values: { [level.id]: "Ouro" } }, { contact_id: b.id, values: { [level.id]: "Bronze" } }];
  const out = f.rpc("erp_catalog_contact_field_bulk_save", { p_command_id: command, p_items: items });
  assert.deepEqual(out.items.map(x => x.saved), [true, false]);
  assert.equal(out.items[1].errors[0].code, "list");
  assert.equal(f.rpc("erp_catalog_contact_field_bulk_save", { p_command_id: command, p_items: items }).replayed, true);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field_value"), 1);
  // Com valores, o campo não se exclui (inativar); sem valores, sim.
  assert.equal(f.rpc("erp_catalog_contact_field_delete", { p_id: level.id, p_expected_version: level.version, p_command_id: randomUUID() }).reason, "in_use");
  const loose = f.field({ name: "Solto", field_type: "text", roles: ["carrier"] }).field;
  assert.equal(f.rpc("erp_catalog_contact_field_delete", { p_id: loose.id, p_expected_version: loose.version, p_command_id: randomUUID() }).deleted, true);
  // Opção em uso não sai da lista.
  assert.equal(f.rpc("erp_catalog_contact_field_save", { p_id: level.id, p_expected_version: level.version, p_command_id: randomUUID(),
    p_data: { options: [{ id: level.options[1].id, label: "Prata" }] } }).reason, "option_in_use");
});
