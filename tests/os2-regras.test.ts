import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { json, now, uid, type Actor, type Env as AppEnv } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { perform, settingsRevision } from "../src/service";
import { seal, unseal } from "../src/security";
import { makeSnapshot } from "../src/modules/os/work-types";
import { loadOrder, listOrders } from "../src/modules/os/store";
import { commitOrderMutation } from "../src/modules/os/mutations";
import { prepareOrderRulesMutation, orderRequirements } from "../src/modules/os/field-rules/requirements";
import { fieldRulesAdapters } from "../src/modules/os/field-rules/ports";
import { planOrderFieldIndex, projectOrderFields, resolveFieldIndexDefinition, normalizeIndexValue } from "../src/modules/os/field-rules/index-store";
import { queryOrdersByField } from "../src/modules/os/field-rules/query";
import type { CustomWorkType, FieldIndexState, OrderFieldFilter, ServiceObjectSnapshot, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import type { WorkOrderRow } from "../src/modules/os/public";
import type { Os2Adapters } from "../src/modules/os/os2-ports";
import { integrationFixture, customerConversation } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2CountingEnv, os2DomainBudget } from "./os2-d1-counter";
import { os2Harness, withOs2Time } from "./os2-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, run: any) => (runInDurableObject as any)(stub, run) };
const harness = (adapters: Partial<Os2Adapters> = {}) => os2Harness(env, runtime, { ...fieldRulesAdapters, ...adapters });
const field = (id: string, kind: WorkField["kind"], properties: Record<string, unknown> = {}): WorkField => ({ id, kind, label: id, help: "", required: false, client_visible: true, sensitive: false, ...properties }) as WorkField;
const textField = (id: string, label = id) => field(id, "text", { label, multiline: false, max_length: 80 });
const opening = (extra: Record<string, unknown> = {}) => ({ type_id: "projeto", phone: "5511960010203", item: "Atendimento", problem: "Conferir", notify: false, ...extra });
const equal = (field_id: string, value: string | number | boolean, scope: "order" | "object" = "order"): OrderFieldFilter => ({ ref: { scope, field_id }, operator: "eq", value });
const range = (field_id: string, from: number | string, to: number | string): OrderFieldFilter => ({ ref: { scope: "order", field_id }, operator: "range", from, to });
const filterQuery = (filter: OrderFieldFilter, extra: Record<string, string> = {}) => ({ type_id: "projeto", field_filter: JSON.stringify(filter), ...extra });
const queryPath = (filter: OrderFieldFilter, extra: Record<string, string> = {}) => "/service-orders?" + new URLSearchParams(filterQuery(filter, extra));

function ruledType() {
  const type = motorWorkType();
  type.fields.push(field("km", "integer", { label: "Quilometragem", min: 0, max: 10000000 }), field("conferido", "boolean"), textField("executado", "Serviço executado"), textField("interno", "Conferência interna"));
  type.fields.find(entry => entry.id === "interno")!.client_visible = false;
  type.stage_field_rules = [
    { field_id: "km", required_on_exit: ["entrada"] },
    { field_id: "conferido", required_from_stage: "execucao" },
    { field_id: "executado", required_from_stage: "entregue" },
    { field_id: "interno", required_from_stage: "revisao" },
  ];
  type.transitions.push({ id: "retornar", from: "execucao", to: "entrada", label: "Retornar", kind: "manual" });
  return type;
}
function indexedType() {
  const type = motorWorkType();
  type.features.tasks = false;
  type.fields.push(field("km", "integer", { min: 0, max: 10000000 }), field("conferido", "boolean"), field("dia", "date", { min: null, max: null }));
  type.list_fields = ["referencia", "km", "conferido", "dia"].map(field_id => ({ ref: { scope: "order" as const, field_id }, filter: true, column: true }));
  return type;
}
async function setup(type = ruledType(), h = harness()) {
  const f = await integrationFixture(h);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) }, uid());
  return { ...f, h, type, ctx: modulesApi(env, f.profile, "os") };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function row(f: Fixture, id: string) { return loadOrder(f.ctx, id) as Promise<WorkOrderRow>; }
async function effects(f: Fixture, id: string) {
  return {
    order: await row(f, id),
    history: await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=? ORDER BY id", f.profile, id),
    index: await all(env, "SELECT * FROM os_order_field_index WHERE profile_id=? AND order_id=? ORDER BY field_key", f.profile, id),
    outbox: await all(env, "SELECT * FROM outbox WHERE profile_id=? ORDER BY id", f.profile),
  };
}
async function build(f: Fixture) {
  let state: FieldIndexState = await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", {});
  for (let commands = 0; state.status !== "ready"; commands++) {
    expect(commands).toBeLessThan(20);
    state = await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", { generation: state.generation, cursor_number: state.cursor_number });
  }
  return state;
}

describe("OS2 regras: barreira única e efeitos atômicos", () => {
  it("permite rascunho, cobra saída/entrada, aceita zero/false e conserva ativação em retornos e repetição", async () => {
    const f = await setup();
    let order = await f.call("/service-orders", "POST", opening());
    const before = await effects(f, order.id);
    const missing = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "iniciar" }, uid(), 409);
    expect(missing.code ?? missing.error?.code ?? missing.error).toBe("missing_fields");
    expect(await effects(f, order.id)).toEqual(before);
    const requirements = await f.call(`/service-orders/${order.id}/requirements?transition_id=iniciar`);
    expect(requirements).toMatchObject({ id: order.id, version: order.version });
    expect(requirements.missing.map((entry: any) => entry.field_id).sort()).toEqual(["conferido", "km"]);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { referencia: "Preenchimento parcial" } });
    expect(order.stage).toBe("entrada");
    expect(json((await row(f, order.id)).stage_required_json, [])).toEqual([]);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { km: 0, conferido: false } });
    const key = uid(), change = { version: order.version, transition_id: "iniciar" };
    order = await f.call(`/service-orders/${order.id}/stage`, "POST", change, key);
    const committed = await effects(f, order.id);
    expect(json(committed.order.stage_required_json, []).sort()).toEqual(["conferido", "km"]);
    expect(await f.call(`/service-orders/${order.id}/stage`, "POST", change, key)).toEqual(order);
    expect(await effects(f, order.id)).toEqual(committed);
    await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { km: null } }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(committed);
    await expect(f.h.run(() => commitOrderMutation(f.ctx, committed.order,
      { extra_json: JSON.stringify({ ...json(committed.order.extra_json), km: null }) }, "integration:test",
      "os.updated", ["km"], uid()))).rejects.toMatchObject({ code: "missing_fields" });
    expect(await effects(f, order.id)).toEqual(committed);
    order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "retornar" });
    const returned = await effects(f, order.id);
    await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { conferido: null } }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(returned);
    expect(json(returned.order.stage_required_json, []).sort()).toEqual(["conferido", "km"]);
    order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "iniciar" });
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { interno: "Conferido" } });
    order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "revisar" });
    const beforeDelivery = await effects(f, order.id);
    await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "entregar" }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(beforeDelivery);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { executado: "Revisão concluída" } });
    expect((await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "entregar" })).status).toBe("delivered");
    expect(f.h.report.some(call => call.worker_invoked && call.coordinators.length > 0)).toBe(true);
  }, 120000);

  it("aplica /status, exige etapa inicial e permite cancelar sem ativar campos", async () => {
    const f = await setup();
    const order = await f.call("/service-orders", "POST", opening());
    const before = await effects(f, order.id);
    await f.call(`/service-orders/${order.id}/status`, "POST", { status: "in_progress", version: order.version }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(before);
    const cancelled = await f.call(`/service-orders/${order.id}/status`, "POST", { status: "cancelled", version: order.version });
    expect(cancelled.status).toBe("cancelled");
    expect(json((await row(f, order.id)).stage_required_json, [])).toEqual([]);
    const initial = ruledType();
    initial.stage_field_rules!.push({ field_id: "referencia", required_from_stage: "entrada" });
    const g = await setup(initial);
    await g.call("/service-orders", "POST", opening(), uid(), 409);
    expect(await one(env, "SELECT count(*) n FROM os_orders WHERE profile_id=?", g.profile)).toEqual({ n: 0 });
    expect(await one(env, "SELECT last FROM os_counters WHERE profile_id=?", g.profile)).toBeNull();
    const key = uid(), data = opening({ extra: { referencia: "Inicial" } });
    const created = await g.call("/service-orders", "POST", data, key);
    expect(await g.call("/service-orders", "POST", data, key)).toEqual(created);
    expect(json((await row(g, created.id)).stage_required_json, [])).toContain("referencia");
    expect(await one(env, "SELECT count(*) n FROM os_orders WHERE profile_id=?", g.profile)).toEqual({ n: 1 });
  }, 120000);

  it("valida valores resultantes antes de gravar e não revela pendências internas ao cliente", async () => {
    const f = await setup();
    const order = await f.call("/service-orders", "POST", opening());
    const current = await row(f, order.id);
    const plan = await prepareOrderRulesMutation(f.ctx, { row: current, type: f.type, sets: { stage: "execucao", status: "in_progress", extra_json: JSON.stringify({ km: 0, conferido: false }) }, actor: f.actor.id });
    expect(plan.stage_required?.sort()).toEqual(["conferido", "km"]);
    expect(plan.before).toEqual([]); expect(plan.after).toEqual([]);
    expect(await row(f, order.id)).toEqual(current);
    const next = { ...current, stage: "execucao", status: "in_progress" as const, extra_json: JSON.stringify({ km: 0, conferido: false }), stage_required_json: JSON.stringify(["km", "conferido"]) };
    const requirements = await orderRequirements(f.ctx, f.actor, { row: next, type: f.type }, "revisar", { customer: true });
    expect(requirements.internal_missing).toBe(true);
    expect(JSON.stringify(requirements)).not.toContain("Conferência interna");
    expect(requirements.missing).toEqual([]);
    await expect(prepareOrderRulesMutation(f.ctx, { row: next, type: f.type, sets: { stage: "revisao", status: "in_progress" }, actor: "customer:5511960010203" })).rejects.toMatchObject({ code: "missing_fields", message: "A equipe precisa completar os dados desta etapa." });
    const foreign = await setup();
    await foreign.call(`/service-orders/${order.id}/requirements?transition_id=iniciar`, "GET", undefined, uid(), 404);
    const ownConversation = await customerConversation(f.h, f);
    const otherConversation = await customerConversation(f.h, f, "5511979990402");
    const owned = await f.call("/service-orders", "POST", opening({ conversation_id: ownConversation }));
    const outside = await f.call(`/service-orders/conversation/${otherConversation}`);
    expect(outside.data.map((entry: any) => entry.id)).not.toContain(owned.id);
  }, 120000);

  it("confere aprovação antes da solicitação e novamente na decisão, sem alterar decisão ou enviar aviso ao recusar", async () => {
    await withOs2Time(1900000000000, async () => {
      const type = ruledType();
      type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 24, request_text: "Autoriza iniciar?" };
      const f = await setup(type), conversation = await customerConversation(f.h, f);
      let order = await f.call("/service-orders", "POST", opening({ conversation_id: conversation }));
      const before = await effects(f, order.id);
      await f.call(`/service-orders/${order.id}/stage-approval`, "POST", { version: order.version, transition_id: "iniciar" }, uid(), 409);
      expect(await effects(f, order.id)).toEqual(before);
      order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { km: 0, conferido: false } });
      order = await f.call(`/service-orders/${order.id}/stage-approval`, "POST", { version: order.version, transition_id: "iniciar" });
      const pending = await row(f, order.id), approval = json(pending.stage_approval_json);
      expect(json(pending.stage_required_json, [])).toEqual([]);
      // Simula escrita concorrente antiga, anterior à barreira. A decisão ainda deve conferir o formulário.
      await exec(env, "UPDATE os_orders SET extra_json='{}' WHERE profile_id=? AND id=?", f.profile, order.id);
      const incomplete = await effects(f, order.id);
      const decision = { version: order.version, approval_version: approval.version, decision: "approve" };
      await f.call(`/service-orders/${order.id}/stage-approval/decision`, "POST", decision, uid(), 409);
      expect(await effects(f, order.id)).toEqual(incomplete);
      await exec(env, "UPDATE os_orders SET extra_json=? WHERE profile_id=? AND id=?", pending.extra_json, f.profile, order.id);
      const key = uid();
      const approved = await f.call(`/service-orders/${order.id}/stage-approval/decision`, "POST", decision, key);
      expect(approved.stage).toBe("execucao");
      const done = await effects(f, order.id);
      expect(await f.call(`/service-orders/${order.id}/stage-approval/decision`, "POST", decision, key)).toEqual(approved);
      expect(await effects(f, order.id)).toEqual(done);
    });
  }, 120000);

  it("orçamento e aprovação obedecem às mesmas exigências e rejeição não grava orçamento nem índice", async () => {
    const type = motorWorkType();
    type.fields.push(textField("para_enviar"), textField("para_aprovar"), textField("para_editar"));
    type.stages.push(...[
      ["analise", "Análise", "analyzing"], ["orcamento", "Orçamento", "quoted"], ["aceito", "Aceito", "approved"], ["recusado", "Recusado", "declined"],
    ].map(([id, label, base_status]) => ({ id, label, base_status: base_status as any, message: "" })));
    type.features.quote = { default_valid_days: 3, source_stages: ["entrada", "analise", "orcamento", "recusado"], sent_stage: "orcamento", approved_stage: "aceito", declined_stage: "recusado", edited_stage: "analise" };
    for (const from of ["analise", "aceito", "recusado"]) {
      type.transitions.push({ id: `iniciar_${from}`, from, to: "execucao", label: "Iniciar", kind: "manual" });
      type.transitions.push({ id: `cancelar_${from}`, from, to: "cancelado", label: "Cancelar", kind: "manual" });
    }
    type.transitions.push({ id: "cancelar_orcamento", from: "orcamento", to: "cancelado", label: "Cancelar", kind: "manual" });
    type.stage_field_rules = [{ field_id: "para_enviar", required_from_stage: "orcamento" }, { field_id: "para_aprovar", required_from_stage: "aceito" }, { field_id: "para_editar", required_from_stage: "analise" }];
    const f = await setup(type);
    let order = await f.call("/service-orders", "POST", opening());
    order = await f.call(`/service-orders/${order.id}/quote`, "PUT", { items: [{ description: "Serviço", unit_cents: 100 }] });
    let before = await effects(f, order.id);
    await f.call(`/service-orders/${order.id}/quote/send`, "POST", { notify: false }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(before);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { para_enviar: "Conferido" } });
    order = await f.call(`/service-orders/${order.id}/quote/send`, "POST", { notify: false });
    before = await effects(f, order.id);
    await f.call(`/service-orders/${order.id}/decision`, "POST", { decision: "approve", quote_version: before.order.quote_version }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(before);
    await f.call(`/service-orders/${order.id}/quote`, "PUT", { items: [{ description: "Alterado", unit_cents: 200 }] }, uid(), 409);
    expect(await effects(f, order.id)).toEqual(before);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { para_aprovar: "Conferido" } });
    expect((await f.call(`/service-orders/${order.id}/decision`, "POST", { decision: "approve", quote_version: (await row(f, order.id)).quote_version })).stage).toBe("aceito");
  }, 120000);

  it("modelo sem objeto nem adesão mantém formato, consultas e repetição legados", async ({ task }) => {
    const f = await setup(motorWorkType());
    const key = uid(), input = opening();
    const created = await f.call("/service-orders", "POST", input, key);
    const first = await effects(f, created.id);
    expect(await f.call("/service-orders", "POST", input, key)).toEqual(created);
    expect(await effects(f, created.id)).toEqual(first);
    expect(created.object).toBeUndefined();
    const counted = os2CountingEnv(env);
    const legacy = await f.h.run(() => listOrders(modulesApi(counted.env, f.profile, "os"), { type_id: f.type.id, facets: "1" }, f.actor));
    expect(legacy.counts).not.toBeNull();
    expect(legacy).not.toHaveProperty("counts_scope");
    expect(os2DomainBudget(counted.count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
    for (const invocation of f.h.report) for (const count of [invocation.worker, ...invocation.coordinators]) expect(os2DomainBudget(count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "modelo_sem_objeto_sem_adesao", invocations: f.h.report, list: counted.count };
  }, 120000);
});

describe("OS2 índice: geração, reconstrução e consistência", () => {
  it("normaliza os seis tipos sem indexar nulos nem ausentes", () => {
    expect(normalizeIndexValue(textField("texto"), "  A\u0301RVORE  ")).toMatchObject({ text: "árvore" });
    expect(normalizeIndexValue(field("numero", "integer", { min: 0, max: 10 }), 0)).toMatchObject({ number: 0 });
    expect(normalizeIndexValue(field("decimal", "decimal", { min: 0, max: 10, scale: 2 }), 1.25)).toMatchObject({ number: 1.25 });
    expect(normalizeIndexValue(field("booleano", "boolean"), false)).toMatchObject({ number: 0 });
    expect(normalizeIndexValue(field("dia", "date", { min: null, max: null }), "2026-11-20")).toMatchObject({ text: "2026-11-20" });
    expect(normalizeIndexValue(field("opcao", "choice", { options: [{ id: "sim", label: "Sim" }] }), "sim")).toMatchObject({ text: "sim" });
    for (const empty of [undefined, null, "", "   "]) expect(normalizeIndexValue(textField("texto"), empty)).toBeNull();
  });

  it("reconstrói cinco por comando, retoma repetição, mantém escrita concorrente e exclui snapshot incompatível", async ({ task }) => {
    const f = await setup(indexedType());
    const ids: string[] = [];
    for (let number = 0; number < 7; number++) ids.push((await f.call("/service-orders", "POST", opening({ extra: { referencia: "ÁRVORE", km: number, conferido: false } }))).id);
    await f.call(queryPath(equal("referencia", "árvore")), "GET", undefined, uid(), 409);
    // A definição antiga é independente da configuração atual e não pode ser reinterpretada.
    const old = structuredClone(f.type);
    old.fields.find(entry => entry.id === "referencia")!.sensitive = true;
    old.fields.find(entry => entry.id === "referencia")!.client_visible = false;
    old.list_fields = old.list_fields!.filter(entry => entry.ref.field_id !== "referencia");
    await exec(env, "UPDATE os_orders SET type_snapshot_json=? WHERE profile_id=? AND id=?", JSON.stringify(makeSnapshot(old)), f.profile, ids[0]);
    const start = await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", {}) as FieldIndexState;
    expect(start).toMatchObject({ status: "building", cursor_number: 0, ceiling_number: 7 });
    const command = { generation: start.generation, cursor_number: start.cursor_number }, key = uid();
    const first = await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", command, key) as FieldIndexState;
    expect(first).toMatchObject({ cursor_number: 5, status: "building" });
    expect(first.excluded_count).toBeGreaterThanOrEqual(1);
    const entries = await all(env, "SELECT * FROM os_order_field_index WHERE profile_id=? ORDER BY field_key,order_id", f.profile);
    expect(await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", command, key)).toEqual(first);
    expect(await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", command)).toEqual(first);
    expect(await all(env, "SELECT * FROM os_order_field_index WHERE profile_id=? ORDER BY field_key,order_id", f.profile)).toEqual(entries);
    const current = await row(f, ids[6]);
    await f.call(`/service-orders/${current.id}`, "PATCH", { version: current.row_version, extra: { referencia: "Concorrente", km: 99 } });
    const ready = await f.call(`/service-orders/types/${f.type.id}/field-index/rebuild`, "POST", { generation: first.generation, cursor_number: first.cursor_number }) as FieldIndexState;
    expect(ready).toMatchObject({ status: "ready", cursor_number: 7 });
    const selected = await f.call(queryPath(equal("referencia", "CONCORRENTE")));
    expect(selected.data.map((entry: any) => entry.id)).toEqual([ids[6]]);
    expect(await one(env, "SELECT order_version,value_number FROM os_order_field_index WHERE profile_id=? AND order_id=? AND field_key='order:km'", f.profile, ids[6])).toEqual({ order_version: 2, value_number: 99 });
    const denied = await all(env, "SELECT order_id FROM os_order_field_index WHERE profile_id=? AND field_key='order:referencia' AND order_id=?", f.profile, ids[0]);
    expect(denied).toEqual([]);
    const builds = f.h.report.filter(invocation => invocation.name.includes("field-index/rebuild"));
    for (const invocation of builds) expect(invocation.worker.statements + invocation.coordinators.reduce((total, count) => total + count.statements, 0)).toBeLessThanOrEqual(50);
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "reconstrucao", start, first, ready, invocations: builds };
  }, 180000);

  it("falha depois do CAS reverte ordem, histórico e projeção; plano antigo nunca sobrepõe uma versão nova", async () => {
    const f = await setup(indexedType());
    const opened = await f.call("/service-orders", "POST", opening({ extra: { referencia: "Antes", km: 1 } }));
    await build(f);
    const previous = await row(f, opened.id), before = await effects(f, opened.id);
    await expect(f.h.run(() => commitOrderMutation(f.ctx, previous, { extra_json: JSON.stringify({ referencia: "Depois", km: 2 }) }, f.actor.id, "os.updated", ["extra"], uid(), "", [["SELECT json('falha_atomica_teste')", []]]))).rejects.toThrow();
    expect(await effects(f, opened.id)).toEqual(before);
    const stale = await planOrderFieldIndex(f.ctx, { row: previous, type: f.type, previous });
    await f.call(`/service-orders/${opened.id}`, "PATCH", { version: opened.version, extra: { referencia: "Atual", km: 3 } });
    const after = await effects(f, opened.id);
    try { await batch(env, stale); } catch { /* Recusa transacional também é uma resposta válida ao CAS antigo. */ }
    expect(await effects(f, opened.id)).toEqual(after);
    const observed = await row(f, opened.id);
    const oldConfiguration = await planOrderFieldIndex(f.ctx, { row: observed, type: f.type });
    const changed = { ...f.type, revision: f.type.revision + 1, list_fields: f.type.list_fields!.slice(1) };
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [changed], settings_revision: await settingsRevision(env, f.profile) }, uid());
    await expect(batch(env, oldConfiguration)).rejects.toThrow();
    expect(await effects(f, opened.id)).toEqual(after);
  }, 120000);

  it("geração ignora rótulos/mensagens e o campo do objeto usa exclusivamente a cópia da ordem", async () => {
    const f = await setup(indexedType());
    const before = await resolveFieldIndexDefinition(f.ctx, f.type.id);
    const renamed = structuredClone(f.type);
    renamed.revision++;
    renamed.fields[0].label = "Outro rótulo";
    renamed.stages[0].message = "Outra mensagem";
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [renamed], settings_revision: await settingsRevision(env, f.profile) }, uid());
    expect((await resolveFieldIndexDefinition(modulesApi(env, f.profile, "os"), f.type.id)).generation).toBe(before.generation);
    const objectType: ServiceObjectType = { schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", fields: [textField("placa")], retired_field_ids: [] };
    renamed.revision++;
    renamed.object_type_id = objectType.id;
    renamed.list_fields = [{ ref: { scope: "object", field_id: "placa" }, filter: true }];
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [renamed], os_object_types: [objectType], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const definition = await resolveFieldIndexDefinition(modulesApi(env, f.profile, "os"), renamed.id);
    const snapshot: ServiceObjectSnapshot = { schema_version: 1, object_id: uid(), object_version: 1, captured_at: now(), origin: "opening", type: objectType, values: { placa: "ABC1D23" } };
    const oldRow: WorkOrderRow = { id: uid(), profile_id: f.profile, number: 1, status: "received", stage: "entrada", conversation_id: null, phone: "", type_id: renamed.id, row_version: 1, type_snapshot_json: JSON.stringify(makeSnapshot(renamed)), extra_json: "{}", object_id: snapshot.object_id, object_snapshot_json: JSON.stringify(snapshot) };
    const projected = projectOrderFields(oldRow, definition);
    expect(JSON.stringify(projected)).toContain("abc1d23");
    expect(JSON.stringify(projected)).not.toContain("cadastro_atual");
    const incompatible = structuredClone(snapshot);
    incompatible.type.fields[0].sensitive = true;
    incompatible.type.fields[0].client_visible = false;
    expect(projectOrderFields({ ...oldRow, object_snapshot_json: JSON.stringify(incompatible) }, definition).values).toEqual([]);
    expect(projectOrderFields({ ...oldRow, object_snapshot_json: JSON.stringify(incompatible) }, definition).excluded_count).toBeGreaterThan(0);
    expect(projectOrderFields({ ...oldRow, object_snapshot_json: JSON.stringify({ ...snapshot, values: {} }) }, definition)).toEqual({ values: [], excluded_count: 0 });
    expect(projectOrderFields({ ...oldRow, profile_id: uid() }, definition).values).toEqual([]);
  }, 120000);
});

/** Massa explícita: não mede carregamento da fixture como custo de página. */
async function seedMass(f: Fixture, count = 5000) {
  const definition = await resolveFieldIndexDefinition(f.ctx, f.type.id);
  await exec(env, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO os_orders(id,profile_id,number,type_number,type_id,type_snapshot_json,stage,status,phone,item,problem,source,created_by,created,updated,extra_json)
    SELECT ? || ':' || x,?,x,x,?,?,'entrada','received','5511960010203','Atendimento','Conferir','api','test',?,?,
      json_object('referencia','ÁRVORE','km',x,'conferido',json('false'),'dia','2026-11-20') FROM n`, count, f.profile, f.profile, f.type.id, JSON.stringify(makeSnapshot(f.type)), now(), now());
  await exec(env, "INSERT INTO os_field_index_state(profile_id,type_id,generation,status,cursor_number,ceiling_number,excluded_count,updated) VALUES(?,?,?,'ready',?,?,0,?)", f.profile, f.type.id, definition.generation, count, count, now());
  for (const [fieldKey, kind, valueText, expression] of [
    ["order:referencia", "text", "árvore", "NULL"], ["order:km", "integer", null, "number"], ["order:conferido", "boolean", null, "0"], ["order:dia", "date", "2026-11-20", "NULL"],
  ] as const) await exec(env, `INSERT INTO os_order_field_index(profile_id,type_id,generation,field_key,value_kind,value_text,value_number,order_id,order_number,order_version)
    SELECT profile_id,type_id,?,?,?,?,${expression},id,number,row_version FROM os_orders WHERE profile_id=?`, definition.generation, fieldKey, kind, valueText, f.profile);
  return definition;
}

describe("OS2 consulta: candidatos limitados e cursor selado", () => {
  it("autoriza IA pela configuração e mantém os novos requisitos/filtros no titular da conversa", async () => {
    const type = indexedType();
    type.fields.find(entry => entry.id === "referencia")!.client_visible = false;
    type.stage_field_rules = [{ field_id: "referencia", required_from_stage: "execucao" }];
    const f = await setup(type), own = await customerConversation(f.h, f), stranger = await customerConversation(f.h, f, "5511979990402");
    const first = await f.call("/service-orders", "POST", opening({ conversation_id: own, extra: { referencia: "Interno", km: 1 } }));
    const incomplete = await f.call("/service-orders", "POST", opening({ conversation_id: own, extra: { km: 1 } }));
    const foreign = await f.call("/service-orders", "POST", opening({ conversation_id: stranger, phone: "5511979990402", extra: { referencia: "Interno", km: 1 } }));
    await build(f);
    const botId = uid(), runId = uid();
    await exec(env, "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,input,created,updated) VALUES(?,?,?,?,?,'teste',?,?)", runId, f.profile, botId, f.actor.id, own, now(), now());
    const via = { kind: "bot" as const, bot_id: botId, run_id: runId, masked: true };
    const ai: Actor = { ...f.actor, via };
    await expect(f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("km", 1)), ai))).rejects.toMatchObject({ status: 403 });
    const configure = async (internal: boolean) => perform(env, f.actor, f.profile, "settings", { os2_ai_access: { enabled: true, internal, sensitive: false }, settings_revision: await settingsRevision(env, f.profile) }, uid());
    await configure(false);
    await expect(f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("referencia", "Interno")), ai))).rejects.toMatchObject({ status: 403 });
    const publicAi = await f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("km", 1)), ai));
    expect(publicAi.data).toHaveLength(3);
    expect(publicAi.data.every(entry => !Object.hasOwn(entry.extra ?? {}, "referencia"))).toBe(true);
    await configure(true);
    const internalAi = await f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("referencia", "Interno")), ai));
    expect(internalAi.data.map(entry => entry.id).sort()).toEqual([first.id, foreign.id].sort());
    const bound: Actor = { ...f.actor, id: "bot:cliente", kind: "app", role: "service", scopes: ["conversations:read", "contacts:read", "conversations:bound"], bots: [botId], via };
    const ownPage = await f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("km", 1), { conversation_id: own }), bound));
    expect(ownPage.data.map(entry => entry.id).sort()).toEqual([first.id, incomplete.id].sort());
    await expect(f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("km", 1), { conversation_id: stranger }), bound))).rejects.toMatchObject({ status: 404 });
    await expect(f.h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("referencia", "Interno"), { conversation_id: own }), bound))).rejects.toMatchObject({ status: 403 });
    const read = (id: string) => f.h.run(() => fieldRulesAdapters.read!(f.ctx, bound, "os.requirements", { params: { id }, query: { conversation_id: own, transition_id: "iniciar" } }));
    const requirements = await read(incomplete.id);
    expect(requirements).toMatchObject({ missing: [], internal_missing: true });
    expect(JSON.stringify(requirements)).not.toContain("referencia");
    await expect(read(foreign.id)).rejects.toMatchObject({ status: 404 });
  }, 180000);

  it("filtra snapshot do objeto, sem consultar o cadastro atual nem misturar áreas", async () => {
    const projection = (row: WorkOrderRow) => {
      if (!row.object_id) return undefined;
      const snapshot = json(row.object_snapshot_json) as ServiceObjectSnapshot;
      return { ...snapshot, identifier: String(snapshot.values.placa), values: { ...snapshot.values } };
    };
    const h = harness({ projectObjectSnapshot: projection, projectObjectPage: async (_ctx, _actor, rows) => new Map(rows.filter(row => row.object_id).map(row => [row.id, projection(row)!])) });
    const f = await setup(indexedType(), h);
    const objectType: ServiceObjectType = { schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", fields: [textField("placa")], retired_field_ids: [] };
    const type = { ...f.type, revision: 2, object_type_id: objectType.id, list_fields: [{ ref: { scope: "object" as const, field_id: "placa" }, filter: true }] };
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], os_object_types: [objectType], settings_revision: await settingsRevision(env, f.profile) }, uid());
    f.type = type;
    const contact = uid(), object = uid(), id = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','cliente','panel','test','test',?,?)", contact, f.profile, now(), now());
    await exec(env, "INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,?,'test','test',?,?)", object, f.profile, contact, objectType.id, JSON.stringify(objectType), JSON.stringify({ placa: "CADASTRO_ATUAL" }), now(), now());
    const snapshot: ServiceObjectSnapshot = { schema_version: 1, object_id: object, object_version: 1, captured_at: now(), origin: "opening", type: objectType, values: { placa: "ABC1D23" } };
    await exec(env, "INSERT INTO os_orders(id,profile_id,number,type_number,type_id,type_snapshot_json,stage,status,contact_id,phone,item,problem,source,created_by,created,updated,object_id,object_snapshot_json) VALUES(?,?,1,1,?,?,'entrada','received',?,'5511960010203','Veículo','Conferir','api','test',?,?,?,?)", id, f.profile, type.id, JSON.stringify(makeSnapshot(type)), contact, now(), now(), object, JSON.stringify(snapshot));
    await build(f);
    const counted = os2CountingEnv(env);
    const page = await h.run(() => queryOrdersByField(modulesApi(counted.env, f.profile, "os"), filterQuery(equal("placa", "abc1d23", "object")), f.actor));
    expect(page.data.map(entry => entry.id)).toEqual([id]);
    expect(counted.count.sql.join(" ")).not.toMatch(/\bFROM os_objects\b|\bJOIN os_objects\b/);
    expect((await h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("placa", "CADASTRO_ATUAL", "object")), f.actor))).data).toEqual([]);
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE profile_id=? AND id=?", f.profile, contact);
    expect((await h.run(() => queryOrdersByField(f.ctx, filterQuery(equal("placa", "abc1d23", "object")), f.actor))).data).toEqual([]);
  }, 120000);

  it("mede planos e até 1.000 rows_read de dados em 5.000 ordens, sem perder candidatos entre páginas", async ({ task }) => {
    const f = await setup(indexedType());
    await seedMass(f);
    expect(await one(env, "SELECT count(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 5000 });
    const measurements: unknown[] = [];
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "pagina_indexada", orders: 5000, maximum_data_rows_read: 1000, measurements };
    async function measured(filter: OrderFieldFilter, query: Record<string, string> = {}) {
      const captured: Array<{ sql: string; bindings: unknown[] }> = [];
      const counted = os2CountingEnv(env);
      const DB = new Proxy(counted.env.DB, { get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, { get(prepared, method) {
            if (method === "bind") return (...bindings: unknown[]) => { captured.push({ sql, bindings }); return prepared.bind(...bindings); };
            const value = Reflect.get(prepared, method); return typeof value === "function" ? value.bind(prepared) : value;
          } });
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const page = await f.h.run(() => queryOrdersByField(modulesApi({ ...counted.env, DB }, f.profile, "os"), filterQuery(filter, query), f.actor));
      const data = counted.count.queries.filter(entry => /\b(?:os_order_field_index|os_orders|os_tasks)\b/.test(entry.sql) && !/\bos_field_index_state\b/.test(entry.sql));
      const candidate = captured.find(entry => /\bFROM os_order_field_index\b/i.test(entry.sql));
      const plan = candidate ? await all(env, "EXPLAIN QUERY PLAN " + candidate.sql, ...candidate.bindings) : [];
      // Preserve a medição também quando o teto ou o plano falhar no ambiente externo.
      measurements.push({ filter, data, other: counted.count.queries.filter(entry => !data.includes(entry)), plan });
      expect(data.reduce((total, entry) => total + entry.rows_read, 0)).toBeLessThanOrEqual(1000);
      expect(data.every(entry => entry.metadata)).toBe(true);
      expect(data.map(entry => entry.sql).join(" ")).not.toMatch(/\bOFFSET\b|json_extract|count\(\*\)\s+FROM\s+os_orders|GROUP BY/i);
      expect(candidate).toBeTruthy();
      expect(JSON.stringify(plan)).toMatch(/os_order_field_(?:text|number)/);
      expect(JSON.stringify(plan)).not.toMatch(/SCAN os_orders|USE TEMP B-TREE/);
      expect(page).toMatchObject({ counts: null, counts_scope: "not_computed" });
      expect(page).not.toHaveProperty("facets");
      return page;
    }
    const first = await measured(equal("referencia", "  A\u0301RVORE  "), { limit: "3", facets: "1" });
    expect(first.data.map(entry => entry.number)).toEqual([5000, 4999, 4998]);
    expect(first.order_by).toBe("number_desc");
    const second = await measured(equal("referencia", "árvore"), { limit: "3", cursor: first.next_cursor! });
    expect(second.data.map(entry => entry.number)).toEqual([4997, 4996, 4995]);
    const interval = await measured(range("km", 100, 5000), { limit: "2" });
    expect(interval.data.map(entry => entry.number)).toEqual([100, 101]);
    expect(interval.order_by).toBe("field_value_asc");
    const continued = await measured(range("km", 100, 5000), { limit: "2", cursor: interval.next_cursor! });
    expect(continued.data.map(entry => entry.number)).toEqual([102, 103]);
    expect((await measured(equal("conferido", false), { limit: "1" })).data[0].number).toBe(5000);
    const datePage = await measured(range("dia", "2026-11-20", "2026-11-20"), { limit: "1" });
    expect(datePage.data[0].number).toBe(5000);
    // Posição que resultaria de consumir 4.900 empates. A chave de teste sela
    // o mesmo contexto para medir o seek tardio sem executar 98 páginas prévias.
    const lateEnvelope = await unseal(env, atob(datePage.next_cursor!));
    const lateCursor = btoa(await seal(env, { ...lateEnvelope, after: { order_id: `${f.profile}:100`, order_number: 100, value: "2026-11-20" } }));
    const late = await measured(range("dia", "2026-11-20", "2026-11-20"), { limit: "2", cursor: lateCursor });
    expect(late.data.map(entry => entry.number)).toEqual([99, 98]);
    // Um só lote de 200 candidatos: resultado menor é válido e continua no candidato consumido.
    await exec(env, "UPDATE os_orders SET status='cancelled' WHERE profile_id=? AND number>4800", f.profile);
    const small = await measured(equal("referencia", "árvore"), { open: "1", limit: "50" });
    expect(small.data).toEqual([]); expect(small.next_cursor).toBeTruthy();
    const resumed = await measured(equal("referencia", "árvore"), { open: "1", limit: "2", cursor: small.next_cursor! });
    expect(resumed.data.map(entry => entry.number)).toEqual([4800, 4799]);
    await f.call(queryPath(equal("referencia", "outra"), { cursor: first.next_cursor! }), "GET", undefined, uid(), 400);
    await f.call(queryPath(equal("referencia", "árvore"), { cursor: first.next_cursor!.slice(0, -3) + "bad" }), "GET", undefined, uid(), 400);
    await expect(f.h.run(() => queryOrdersByField(f.ctx,
      filterQuery(equal("referencia", "árvore"), { cursor: first.next_cursor! }),
      { ...f.actor, id: f.memberId }))).rejects.toMatchObject({ code: "invalid_cursor" });
    await f.call(queryPath(equal("referencia", "árvore"), { limit: "51" }), "GET", undefined, uid(), 400);
    await f.call(queryPath({ ...equal("referencia", ""), value: null } as any), "GET", undefined, uid(), 400);
    await f.call(queryPath(range("referencia", "a", "z")), "GET", undefined, uid(), 400);
    const other = await setup(indexedType());
    await build(other);
    await other.call(queryPath(equal("referencia", "árvore"), { cursor: first.next_cursor! }), "GET", undefined, uid(), 400);
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "pagina_indexada", orders: 5000, maximum_data_rows_read: 1000, measurements };
  }, 180000);
});
