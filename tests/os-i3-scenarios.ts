import assert from "node:assert/strict";
import { all, exec, one, withReadCache } from "../src/db";
import { now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { inbound } from "../src/service";
import { startFlow } from "../src/modules/suporte/flow";
import { runTaskDue, TASK_DUE_SQL_RESERVE } from "../src/modules/os/tasks/reminders";
import { handleStageReply } from "../src/modules/os/stage-replies";
import { catalogFor, resetCatalogCache, searchCatalog } from "../src/bot-actions/catalog";
import { authorizedOrder } from "../src/modules/os/public";
import { projectOrderForBot, projectOrderForCustomer } from "../src/modules/os/privacy";
import { validateExtra, validateObjectValues, validateWorkType } from "../src/modules/os/validation";
import { workOrderAdditions } from "../src/modules/os/work-types";
import { condominiosTemplate } from "../src/area-templates/models/condominios";
import { construtorasTemplate } from "../src/area-templates/models/construtoras";
import { escolasTemplate } from "../src/area-templates/models/escolas";
import { professoresTemplate } from "../src/area-templates/models/professores";
import { countingEnv } from "./d1-counter";
import { motorWorkType } from "./os-motor-fixture";
import { customerConversation, integrationFixture, type IntegrationHarness } from "./os-integration-fixture";

function budget(size = 200) {
  let remaining = size;
  return { get remaining() { return remaining; }, consume(n: number) {
    assert(n >= 0 && n <= remaining); remaining -= n;
  } };
}

async function fixture(h: IntegrationHarness, custom = true) {
  const f = await integrationFixture(h);
  await f.call("/modules/os", "PUT", { enabled: true });
  const type = motorWorkType();
  if (custom) {
    const catalog = await f.call("/service-orders/types");
    await f.call("/settings", "PUT", { settings_revision: catalog.settings_revision, os_work_types: [type] });
  }
  const c = await customerConversation(h, f);
  const order = await f.call("/service-orders", "POST", {
    ...(custom ? { type_id: type.id } : {}), conversation_id: c, item: "Item", problem: "Conferir", notify: false,
  });
  return { f, type, order, ctx: modulesApi(h.env, f.profile, "os"), c };
}

export async function taskPrivacyRecheck(h: IntegrationHarness) {
  const { f, order, ctx } = await fixture(h), at = now();
  // Intercalar depois da seleção, durante a última leitura da conversa.
  // Sem depender do gate do Coordinator: o agendador também verifica a linha atual.
  for (const change of [
    "version=version+1, title='Texto novo'",
    "sensitive=1,client_visible=0,audience='staff'",
    "client_visible=0,audience='staff'", "audience='staff'",
    "state='done'", "state='cancelled'", "archived_at=1", "notified_at=1",
    null,
  ]) {
    const task = await f.call(`/service-orders/${order.id}/tasks`, "POST", {
      title: "Lembrete", audience: "customer", due_at: at, remind_at: at, sensitive: false, client_visible: true,
    });
    let sent = 0;
    const result = await runTaskDue(ctx, { now: at, limit: 10, budget: budget() }, (env, profile, module) => {
      const fresh = modulesApi(env, profile, module);
      return { ...fresh, conversation: async (id) => {
        const conversation = await fresh.conversation(id);
        if (change) await exec(h.env, `UPDATE os_tasks SET ${change} WHERE profile_id=? AND order_id=? AND id=?`, f.profile, order.id, task.id);
        return conversation;
      }, sendMessage: async () => { sent++; return "sent"; } };
    });
    assert.equal(sent, change ? 0 : 1, `envio após ${change}`);
    assert.equal(result.processed, change ? 0 : 1);
    const row = await one(h.env, "SELECT notified_at FROM os_tasks WHERE profile_id=? AND id=?", f.profile, task.id);
    if (change && change !== "notified_at=1") assert.equal(row!.notified_at, null);
    await exec(h.env, "UPDATE os_tasks SET archived_at=1 WHERE profile_id=? AND id=?", f.profile, task.id);
  }
}

export async function taskCursorD1(h: IntegrationHarness) {
  const { f, order, ctx } = await fixture(h), at = now();
  const missing = await f.call("/service-orders", "POST", { type_id: order.type_id, phone: "5511988881111", item: "Sem conversa", problem: "Conferir", notify: false });
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) {
    ids.push(uid());
    await exec(h.env, `INSERT INTO os_tasks(id,profile_id,order_id,title,audience,due_at,remind_at,client_visible,sensitive,created_by,created,updated)
      VALUES(?,?,?,'Lembrete','customer',?,?,1,0,?,?,?)`, ids[i], f.profile, i < 10 ? missing.id : order.id, at, at - 20 + i, f.actor.id, at, at);
  }
  let sent = 0;
  const measured = countingEnv({ ...h.env, MEDIA: new Proxy(h.env.MEDIA, { get() { throw Error("Cursor de tarefa não deve usar R2"); } }) });
  const run = async (size = 200) => {
    const before = measured.count.statements, allowance = budget(size);
    const result = await runTaskDue({ ...ctx, env: measured.env }, { now: at, limit: 10, budget: allowance }, (env, profile, module) => ({
      ...modulesApi(env, profile, module), sendMessage: async () => { sent++; return "sent"; },
    }));
    assert.equal(size - allowance.remaining, measured.count.statements - before);
    return result;
  };
  assert.equal((await run()).processed, 0);
  assert.equal(sent, 0);
  assert.deepEqual(await one(h.env, "SELECT remind_at,task_id FROM os_task_reminder_cursors WHERE profile_id=?", f.profile), { remind_at: at - 11, task_id: ids[9] });
  // Contexto novo simula outra rodada/instância: precisa alcançar o 11º.
  assert.equal((await run()).processed, 1);
  assert.equal(sent, 1);
  assert.deepEqual((await all(h.env, "SELECT id FROM os_tasks WHERE profile_id=? AND notified_at IS NOT NULL", f.profile)).map(r => r.id), [ids[10]]);
  assert.equal((await all(h.env, "SELECT * FROM os_task_reminder_cursors WHERE profile_id=?", f.profile)).length, 1);
  assert.equal((await run(TASK_DUE_SQL_RESERVE - 1)).processed, 0);
  const other = await fixture(h);
  await runTaskDue(other.ctx, { now: at, limit: 10, budget: budget() });
  assert.equal(await one(h.env, "SELECT * FROM os_task_reminder_cursors WHERE profile_id=?", other.f.profile), null);
  // Ao terminar a volta, os dez impedidos voltam a ser elegíveis e cabem no orçamento.
  await exec(h.env, "UPDATE os_orders SET conversation_id=?,phone=? WHERE profile_id=? AND id=?", order.customer.conversation_id, order.customer.phone, f.profile, missing.id);
  const real = countingEnv(h.env), allowance = budget();
  assert.equal((await runTaskDue(modulesApi(real.env, f.profile, "os"), { now: at, limit: 10, budget: allowance })).processed, 10);
  assert.equal(200 - allowance.remaining, real.count.statements);
  // Mesmo um serviço que esgote a rodada deixa uma instrução para o checkpoint.
  await exec(h.env, "UPDATE os_tasks SET notified_at=NULL WHERE profile_id=?", f.profile);
  const exhausted = countingEnv(h.env), small = budget(50);
  let attempted = false;
  const stopped = await runTaskDue(modulesApi(exhausted.env, f.profile, "os"), { now: at, limit: 10, budget: small }, (env, profile, module) => ({
    ...modulesApi(env, profile, module), sendMessage: async () => {
      attempted = true;
      while (true) await one(env, "SELECT 1");
    },
  }));
  assert(attempted);
  assert.equal(stopped.processed, 0);
  assert.equal(small.remaining, 0);
  assert.equal(exhausted.count.statements, 50);
  assert.equal((await one(h.env, "SELECT task_id FROM os_task_reminder_cursors WHERE profile_id=?", f.profile))!.task_id, ids[0]);
}

export async function legacyCatalogSearch(h: IntegrationHarness) {
  const { f } = await fixture(h, false);
  resetCatalogCache();
  const result = searchCatalog(await catalogFor(h.env, f.actor, f.profile), "ordem de serviço");
  assert(result.length <= 10);
  assert(result.some(op => op.name === "os.create"), result.map(op => op.name).join(", "));
  assert(result.some(op => op.name === "consulta:service-orders"));
}

export async function legacyStageReplyBudget(h: IntegrationHarness) {
  const { f, ctx, c } = await fixture(h, false), conversation = await ctx.conversation(c);
  const measured = countingEnv(h.env), cached = modulesApi(withReadCache(measured.env), f.profile, "os");
  await cached.settings();
  const before = measured.count.statements;
  for (const text of ["1", "2", "APROVAR"])
    assert.equal(await handleStageReply(cached, conversation, { text, rowId: uid() }), false);
  assert.equal(measured.count.statements - before, 0, "área só com embutido não consulta os_orders");
}

export async function legacyAlarmBudget(h: IntegrationHarness) {
  const f = await integrationFixture(h);
  for (const id of ["queue", "forms", "payments", "agenda", "os", "reserva", "pedido", "mensalidade", "suporte", "mesas"])
    await f.call(`/modules/${id}`, "PUT", { enabled: true });
  const phone = "5511979990001";
  const c = await customerConversation(h, f, phone);
  const other = await customerConversation(h, f, "5511979990002");
  const ctx = modulesApi(h.env, f.profile, "suporte");
  await startFlow(ctx, await ctx.conversation(c), uid());
  await ctx.sendMessage(await ctx.conversation(other), { text: "Mensagem anterior" }, { key: uid() });
  const pending = await all(h.env, "SELECT id FROM outbox WHERE profile_id=? AND status='pending'", f.profile);
  assert.equal(pending.length, 2);
  // Mesmo caminho do orçamento legado: duas entregas de épocas antigas e
  // uma resposta ao Suporte, ainda atrás da entrega anterior dessa conversa.
  await exec(h.env, "UPDATE conversations SET epoch=epoch+1 WHERE profile_id=?", f.profile);
  await inbound(h.env, f.profile, { external_id: phone, phone, message_id: uid(), text: "2" }, `channel:${f.line}`, f.line);
  const count = await h.alarm(f.profile);
  assert.equal((await one(h.env, "SELECT status FROM inbox WHERE profile_id=? ORDER BY created DESC,rowid DESC LIMIT 1", f.profile))!.status, "done");
  for (const row of pending)
    assert.equal((await one(h.env, "SELECT status FROM outbox WHERE id=?", row.id))!.status, "cancelled");
  assert.equal((await one(h.env, "SELECT attempts FROM suporte_sessions WHERE profile_id=? AND conversation_id=?", f.profile, c))!.attempts, 1);
  assert(count.statements <= 71, `alarme legado: ${count.statements} instruções (teto 71)\n${count.sql.join("\n")}`);
  assert.equal(count.sql.filter(sql => sql.startsWith("SELECT p.*,(SELECT json_group_object")).length, 1);
  assert.equal(count.sql.filter(sql => sql.startsWith("SELECT module_id,enabled FROM profile_modules")).length, 1);
  return count.statements;
}

export async function legacyCounterLineChoice(h: IntegrationHarness) {
  const f = await integrationFixture(h), at = now();
  // Mesmo milissegundo e UUIDs em ordem inversa à inserção: sem depender do relógio.
  const suffix = f.line.slice(-12);
  const first = `ffffffff-ffff-4fff-8fff-${suffix}`;
  const second = `00000000-0000-4000-8000-${suffix}`;
  await exec(h.env, "UPDATE connections SET id=?,created=? WHERE id=?", first, at, f.line);
  const qr = uid(), paused = uid();
  for (const [id, kind, status, created] of [
    [second, "zernio", "active", at],
    [qr, "qr", "active", at - 1],
    [paused, "zernio", "paused", at - 1],
  ]) await exec(h.env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct',?,'{}',?)",
    id, f.profile, id, kind, status, created);
  const other = await integrationFixture(h);
  await exec(h.env, "UPDATE connections SET created=? WHERE id=?", at - 2, other.line);
  await f.call("/modules/pedido", "PUT", { enabled: true });
  const category = await f.call("/pedido/categories", "POST", { name: "Bebidas" });
  const item = await f.call("/pedido/items", "POST", { category_id: category.id, name: "Suco", price_cents: 800 });
  const body = { customer_name: "Cliente no balcão", phone: "(11) 96666-2222", fulfillment: "pickup", payment_method: "cash", items: [{ item_id: item.id, quantity: 1 }] };
  const plain = await f.call("/pedido/orders", "POST", body);
  assert.equal(plain.customer.conversation_id, null);
  assert.equal(await one(h.env, "SELECT id FROM conversations WHERE profile_id=?", f.profile), null);
  await f.call("/pedido/orders", "POST", { ...body, whatsapp_notices: true }, uid(), 400);
  const key = uid();
  const input = { ...body, whatsapp_notices: true, notices_evidence: "Ficha assinada no balcão" };
  const noticed = await f.call("/pedido/orders", "POST", input, key);
  const c = await one(h.env, "SELECT * FROM conversations WHERE id=?", noticed.customer.conversation_id);
  assert(c);
  assert.equal(c.connection_id, first, "empate em created deve preservar a primeira linha cadastrada");
  assert.equal(c.phone, "5511966662222");
  assert.equal(c.last_customer, 0);
  assert.deepEqual(await one(h.env, "SELECT purpose,source FROM consents WHERE conversation_id=?", c.id), { purpose: "order", source: "panel" });
  const sent = await all(h.env, "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid", c.id);
  assert.equal(JSON.parse(sent.at(-1)!.payload).consent_purpose, "order");
  assert.deepEqual(await f.call("/pedido/orders", "POST", input, key), noticed);
  assert.equal((await all(h.env, "SELECT id FROM conversations WHERE profile_id=?", f.profile)).length, 1);
  // O desempate não substitui a ordem por data, a linha explícita ou a conversa existente.
  const ctx = modulesApi(h.env, f.profile, "pedido");
  assert.equal((await ctx.conversationByPhone("5511966664444", { open: true, connection_id: second }))!.connection_id, second);
  await exec(h.env, "UPDATE connections SET created=? WHERE id=?", at - 1, second);
  assert.equal((await ctx.conversationByPhone("5511966665555", { open: true }))!.connection_id, second);
  assert.equal((await ctx.conversationByPhone(body.phone, { open: true }))!.id, c.id);
  for (const id of [qr, paused, other.line])
    await assert.rejects(() => ctx.conversationByPhone("5511966667777", { open: true, connection_id: id }), /linha oficial/);
  await exec(h.env, "UPDATE connections SET status='paused' WHERE profile_id=? AND kind='zernio'", f.profile);
  await assert.rejects(() => ctx.conversationByPhone("5511966667777", { open: true }), /linha oficial/);
}

export async function literalStageFilters(h: IntegrationHarness) {
  const { f, type } = await fixture(h);
  const rename = (id: string) => id === "entrada" ? "open" : id === "entregue" ? "all" : id;
  const special = { ...type, id: "filtros", initial_stage: "open", stages: type.stages.map(s => ({ ...s, id: rename(s.id) })), transitions: type.transitions.map(t => ({ ...t, from: rename(t.from), to: rename(t.to) })) };
  await f.call("/settings", "PUT", { settings_revision: (await f.call("/service-orders/types")).settings_revision, os_work_types: [type, special] });
  const orders = [];
  for (const item of ["Aberto", "Concluído"]) orders.push(await f.call("/service-orders", "POST", { type_id: special.id, phone: "5511999991122", item, problem: "Teste", notify: false }));
  await exec(h.env, "UPDATE os_orders SET stage='all',status='delivered' WHERE profile_id=? AND id=?", f.profile, orders[1].id);
  const base = `/service-orders?type_id=${special.id}`;
  const ids = async (query: string) => (await f.call(base + query)).data.map((x: any) => x.id);
  assert.deepEqual(await ids("&stage=open"), [orders[0].id]);
  assert.deepEqual(await ids("&stage=all"), [orders[1].id]);
  assert.deepEqual(await ids("&open=1"), [orders[0].id]);
  assert.deepEqual(new Set(await ids("")), new Set(orders.map(x => x.id)));
  await f.call("/service-orders?stage=all", "GET", undefined, uid(), 400);
}

export async function residentialFields(h: IntegrationHarness) {
  const types = [...condominiosTemplate.work_types];
  const value = "Bloco B, unidade 302";
  // Parte 2: no pós-obra da construtora, a unidade pertence ao objeto Imóvel,
  // com a mesma classificação pública; o endereço do imóvel continua sensível.
  const postWork = construtorasTemplate.work_types.find(t => t.id === "construtora_pos_obra")!;
  assert.deepEqual(validateWorkType(postWork), postWork);
  assert.equal(postWork.fields.some(f => f.id === "unidade"), false);
  assert(postWork.retired_field_ids.includes("unidade"));
  const property = construtorasTemplate.object_types!.find(o => o.id === postWork.object_type_id)!;
  const propertyUnit = property.fields.find(f => f.id === "unidade")!;
  assert.equal(propertyUnit.sensitive, false);
  assert.equal(propertyUnit.client_visible, true);
  for (const mode of ["staff", "customer"] as const)
    assert.deepEqual(validateObjectValues(property, { unidade: value, municipio: "Campinas/SP" }, { mode }), { unidade: value, municipio: "Campinas/SP" });
  assert(property.fields.some(f => f.sensitive && !f.client_visible));
  for (const type of types) {
    assert.deepEqual(validateWorkType(type), type);
    const field = type.fields.find(f => f.id === "unidade")!;
    assert.equal(field.sensitive, false, type.id);
    assert.equal(field.client_visible, true, type.id);
    for (const mode of ["staff", "customer"] as const)
      assert.deepEqual(validateExtra([field], { unidade: value }, { mode }), { unidade: value });
    const projection = workOrderAdditions({ number: 1, status: "received", stage: type.initial_stage, extra_json: JSON.stringify({ unidade: value }) }, type);
    assert.equal(projection.extra.unidade, value);
    // A decisão não reclassifica nenhum outro campo reservado destes modelos.
    assert(type.fields.some(f => f.sensitive && !f.client_visible));
  }
  for (const type of [...escolasTemplate.work_types, ...professoresTemplate.work_types]) {
    assert.equal(type.fields.find(f => f.id === "nome_aluno")!.sensitive, true);
    assert.equal(type.fields.find(f => f.id === "nome_aluno")!.client_visible, false);
  }
  // Conferência por projeções reais, incluindo bot e mensagens ao titular.
  const { f, ctx, order, type } = await fixture(h);
  const unit = types[0].fields.find(f => f.id === "unidade")!;
  const fixedType = { ...type, fields: [unit], stages: type.stages.map(s => ({ ...s, message: "Unidade {campo_unidade}" })) };
  await exec(h.env, "UPDATE os_orders SET extra_json=?,type_snapshot_json=? WHERE profile_id=? AND id=?", JSON.stringify({ unidade: value }), JSON.stringify({ schema_version: 1, type: fixedType }), f.profile, order.id);
  const authorized = await authorizedOrder(ctx, f.actor, order.id);
  for (const view of [projectOrderForCustomer(ctx, f.actor, authorized), projectOrderForBot(ctx, f.actor, authorized), await f.call(`/service-orders/${order.id}`)])
    assert.equal(view.extra.unidade, value);
  const { notify } = await import("../src/modules/os/store");
  let message = "";
  await notify({ ...ctx, sendMessage: async (_c, input) => { message = input.text ?? ""; return "sent"; } }, authorized.row, "opened", uid());
  assert(message.includes(value));
}
