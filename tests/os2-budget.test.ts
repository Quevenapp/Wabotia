// Custo D1 da parte 2 medido em Worker e em cada Coordinator reais. A linha de
// base comparável é o mesmo cenário com as portas OS2 neutralizadas (sem D1):
// a diferença entre as duas execuções é exatamente o custo acrescentado pelas
// folhas conectadas no caminho sem objeto. Relatório em task.meta.os2Budget.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Env as AppEnv } from "../src/types";
import { conversation, perform, settingsRevision } from "../src/service";
import { hmac, setSecret } from "../src/security";
import { resolveCustomer } from "../src/customer/ports";
import { modulesApi } from "../src/modules/api";
import { listOrders, loadOrder } from "../src/modules/os/store";
import { requestStageApproval } from "../src/modules/os/stages";
import { os2Command, os2Read, queryOrdersByField, type Os2Adapters } from "../src/modules/os/os2-ports";
import { resolveFieldIndexDefinition } from "../src/modules/os/field-rules/index-store";
import { makeSnapshot } from "../src/modules/os/work-types";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import type { AreaTemplate, CustomWorkType, FieldIndexState, ServiceObjectType } from "../src/modules/os/contracts";
import { customerConversation, integrationFixture } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2CountingEnv, os2DomainBudget, type Os2D1Count } from "./os2-d1-counter";
import { os2Harness, withOs2Time, type Os2Harness, type Os2Invocation } from "./os2-fixture";
import baseline from "./os2-baseline.json";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const ZERO = { statements: 0, rows_read: 0, rows_written: 0 };
const globalId = (manifest: AreaTemplate, localId: string) => `area_${manifest.id}__${localId}`;
const config = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);
/** Portas neutras: nenhuma leitura/gravação, nenhum plano. Só válidas no caminho sem objeto. */
const NEUTRAL: Partial<Os2Adapters> = {
  prepareOrderRulesMutation: async () => ({ before: [], after: [] }),
  planOrderFieldIndex: async () => [],
  projectObjectSnapshot: () => undefined,
  projectObjectForActor: async () => undefined,
  projectObjectPage: async () => new Map(),
  publicObjectLabel: () => "",
  getWorkObjectContext: () => undefined,
  prepareObjectWebStepCompletion: async () => null,
  resumeObjectWebStepCompletion: async () => undefined,
};
const vehicle = (): ServiceObjectType => ({ schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" },
  identifier_field_id: "placa", retired_field_ids: [], fields: [{ id: "placa", label: "Placa", help: "", kind: "text", multiline: false, max_length: 10, required: false, client_visible: true, sensitive: false }] });
const shape = (measured: Os2D1Count) => ({ statements: measured.statements, sql: measured.sql, rows_written: measured.rows_written });

/** Cenários da linha de base (tests/os2-baseline.json), na mesma ordem. */
async function legacyScenarios(h: Os2Harness, clock: { advance: (milliseconds: number) => void }) {
  const f = await integrationFixture(h);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  const type = motorWorkType();
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) }, uid());
  const integration = uid(), account = uid(), secret = "os2-budget-fixture-secret";
  await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Fixture OS2',?,'zernio',?)", integration, f.profile, `os2:${integration}`, now());
  await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ account_id: account, zernio_workspace_id: integration, service: { mode: "human", menu_mode: "off" } }), f.line);
  await setSecret(env, `zernio-account:${integration}`, { api_key: "os2-fixture-key", webhook_secret: secret });
  const phone = "5511979990501", thread = uid();
  const message = async (name: string, text: string) => {
    clock.advance(1000);
    const body = JSON.stringify({ id: uid(), event: "message.received", timestamp: new Date(now()).toISOString(), account: { accountId: account, platform: "whatsapp" }, conversation: { id: thread, participantId: phone }, message: { platform: "whatsapp", platformMessageId: uid(), direction: "incoming", text, sentAt: new Date(now()).toISOString(), sender: { id: phone, name: "Cliente", phoneNumber: phone } } });
    const response = await h.fetch(new Request(`https://test/webhooks/zernio/${f.line}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Zernio-Signature": await hmac(secret, body) }, body }), name);
    expect(response.ok, await response.clone().text()).toBe(true);
    await h.alarm(f.profile);
    h.report[h.report.length - 1].name = name + ":alarm";
    expect(await one(env, "SELECT COUNT(*) n FROM inbox WHERE profile_id=? AND status!='done'", f.profile)).toEqual({ n: 0 });
  };
  const opening = (type_id: string) => ({ type_id, phone, item: "Revisão", problem: "Conferir", notify: false });
  h.report.length = 0;
  await message("common_message", "Olá");
  const conversation = (await one<{ id: string }>(env, "SELECT id FROM conversations WHERE profile_id=? AND connection_id=? AND external_id=?", f.profile, f.line, phone))!;
  clock.advance(1000);
  const classicKey = uid();
  const classic = await f.call("/service-orders", "POST", { ...opening("service_order"), conversation_id: conversation.id }, classicKey, 200, "classic_opening");
  // Repetição do mesmo comando: exatamente uma ordem.
  expect((await f.call("/service-orders", "POST", { ...opening("service_order"), conversation_id: conversation.id }, classicKey, 200, "classic_replay")).id).toBe(classic.id);
  const approval = { ...type, revision: 2, transitions: type.transitions.map(transition => transition.id === "iniciar" ? { ...transition, kind: "customer_approval" as const, valid_hours: 24, request_text: "Autoriza iniciar?" } : transition) };
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [approval], settings_revision: await settingsRevision(env, f.profile) }, uid());
  clock.advance(1000);
  const custom = await f.call("/service-orders", "POST", { ...opening("projeto"), conversation_id: conversation.id }, uid(), 200, "custom_opening_without_object");
  expect(classic.object).toBeUndefined(); expect(custom.object).toBeUndefined();
  clock.advance(1000);
  const tracked = await f.call(`/service-orders/conversation/${conversation.id}`, "GET", undefined, uid(), 200, "tracking");
  expect(tracked.data.map((order: { id: string }) => order.id).sort()).toEqual([classic.id, custom.id].sort());
  // Isolamento: outro cliente da mesma área não vê as ordens.
  const foreign = await customerConversation(h, f, "5511979990502");
  expect((await f.call(`/service-orders/conversation/${foreign}`, "GET", undefined, uid(), 200, "tracking_other_customer")).data).toEqual([]);
  const ctx = modulesApi(env, f.profile, "os");
  await h.run(async () => requestStageApproval(ctx, await loadOrder(ctx, custom.id), { transition_id: "iniciar", version: custom.version }, f.actor.id));
  await message("stage_reply", `APROVAR ETAPA ${custom.number}`);
  expect((await loadOrder(ctx, custom.id)).stage).toBe("execucao");
  await perform(env, f.actor, f.profile, "settings", { os_object_types: [vehicle()], settings_revision: await settingsRevision(env, f.profile) }, uid());
  await message("configured_objects_unused", "Olá novamente");
  expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 2 });
  return { f, scenarios: h.report.map(entry => ({ ...entry })) };
}

function byName(scenarios: Os2Invocation[]) {
  return new Map(scenarios.map(entry => [entry.name, entry]));
}

describe("OS2 orçamento: linha de base comparável e caminho sem objeto", () => {
  it("portas de produção acrescentam delta zero no Worker e em cada Coordinator no caminho sem objeto", async ({ task }) => {
    const report: Record<string, unknown> = { schema_version: 2, baseline_file: baseline.status, method: "neutral_ports_same_scenario",
      clock: "controlled", network: "stubbed_transport" };
    (task.meta as Record<string, unknown>).os2Budget = report;
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: { messageId: uid() } }));
    try {
      const run = (adapters: Partial<Os2Adapters>) => withOs2Time(1795000000000, clock => legacyScenarios(os2Harness(env, runtime, adapters), clock));
      await run({}); // aquecimento de caches do isolate; descartado
      const neutral = await run(NEUTRAL), production = await run({});
      report.neutral = neutral.scenarios; report.production = production.scenarios;
      const expected = baseline.scenarios.map(entry => entry.id);
      const neutralByName = byName(neutral.scenarios), productionByName = byName(production.scenarios);
      const deltas: Record<string, unknown> = {};
      report.deltas = deltas;
      for (const name of production.scenarios.map(entry => entry.name)) {
        const base = neutralByName.get(name)!, measured = productionByName.get(name)!;
        expect(base, name).toBeTruthy();
        expect(measured.coordinators.length, name).toBe(base.coordinators.length);
        deltas[name] = {
          worker: { statements: measured.worker.statements - base.worker.statements, rows_read: measured.worker.rows_read - base.worker.rows_read, rows_written: measured.worker.rows_written - base.worker.rows_written },
          coordinators: measured.coordinators.map((count, index) => ({ operation: count.operation,
            statements: count.statements - base.coordinators[index].statements, rows_read: count.rows_read - base.coordinators[index].rows_read,
            rows_written: count.rows_written - base.coordinators[index].rows_written })),
        };
        expect(shape(measured.worker), `${name}: Worker`).toEqual(shape(base.worker));
        measured.coordinators.forEach((count, index) => expect(shape(count), `${name}: Coordinator ${index}`).toEqual(shape(base.coordinators[index])));
        for (const count of [measured.worker, ...measured.coordinators]) {
          expect(count.metadata_missing, name).toBe(0);
          expect(os2DomainBudget(count), name).toEqual(ZERO);
        }
      }
      for (const id of expected) expect([...productionByName.keys()].some(name => name === id || name.startsWith(`${id}:`)), id).toBe(true);
    } finally { transport.mockRestore(); }
  }, 300000);
});

describe("OS2 orçamento: área mista, consultas limitadas e reconstrução", () => {
  async function mixedArea(h: Os2Harness) {
    const f = await integrationFixture(h);
    const input = { template_id: oficinaMecanicaTemplate.id, selection: { work_type_ids: oficinaMecanicaTemplate.work_types.map(type => type.id), module_ids: ["os"],
      menus: false, departments: false, ticket_categories: false, vocabulary: false, texts: false, bot_suggestions: false } };
    const preview = await f.call("/area-templates/preview", "POST", input);
    expect((await f.call("/area-templates/apply", "POST", { ...input, preview_hash: preview.preview_hash })).applied).toBe(true);
    const consultoria: CustomWorkType = { ...motorWorkType(), id: "consultoria" };
    const current = await config(f.profile);
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [...current.os_work_types, consultoria], settings_revision: await settingsRevision(env, f.profile) }, uid());
    return { f, typeId: globalId(oficinaMecanicaTemplate, "at_veiculos"), objectType: globalId(oficinaMecanicaTemplate, "veiculo"), ctx: modulesApi(env, f.profile, "os") };
  }

  it("modelo sem objeto em área com objetos não toca o domínio novo; colunas, ficha e histórico sem N+1", async ({ task }) => {
    const h = os2Harness(env, runtime), { f, typeId, objectType } = await mixedArea(h), other = await integrationFixture(h);
    const report: Record<string, unknown> = { scenario: "area_mista" };
    (task.meta as Record<string, unknown>).os2Budget = report;
    const client = await customerConversation(h, f, "5511979990601"), neighbour = await customerConversation(h, f, "5511979990602");
    h.report.length = 0;
    const body = { type_id: "consultoria", conversation_id: client, item: "Consultoria", problem: "Conferir", notify: false }, key = uid();
    const plain = await f.call("/service-orders", "POST", body, key, 200, "mixed_without_object");
    expect((await f.call("/service-orders", "POST", body, key, 200, "mixed_without_object_replay")).id).toBe(plain.id);
    await f.call(`/service-orders/${plain.id}/stage`, "POST", { version: plain.version, transition_id: "iniciar" }, uid(), 200, "mixed_stage");
    await f.call("/service-orders?type_id=consultoria", "GET", undefined, uid(), 200, "mixed_list");
    for (const invocation of h.report) for (const count of [invocation.worker, ...invocation.coordinators])
      expect(os2DomainBudget(count), invocation.name).toEqual(ZERO);
    report.without_object = h.report.map(entry => ({ ...entry }));
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=? AND type_id='consultoria'", f.profile)).toEqual({ n: 1 });

    // Ordens com objeto: colunas próprias vêm da linha/cópia já carregada.
    const contact = (await one<{ contact_id: string }>(env, "SELECT contact_id FROM os_orders WHERE id=?", plain.id))!.contact_id;
    const opening = { type_id: typeId, conversation_id: client, item: "Revisão", problem: "Conferir", notify: false, extra: { quilometragem: 1000 } };
    const firstVisit = await f.call("/service-orders", "POST", { ...opening, object: { mode: "new", type_id: objectType, values: { placa: "MIX1A23" } } });
    const objectId = firstVisit.object.object_id as string;
    const listCount = async () => {
      const counted = os2CountingEnv(env);
      const page = await listOrders(modulesApi(counted.env, f.profile, "os"), { type_id: typeId }, f.actor);
      return { page, count: counted.count };
    };
    const detailCount = async () => {
      const counted = os2CountingEnv(env);
      await h.run(() => os2Read(modulesApi(counted.env, f.profile, "os"), f.actor, "os.objects.get", { params: { object_id: objectId }, query: {} }));
      return counted.count;
    };
    const oneVisit = { list: await listCount(), detail: await detailCount() };
    for (let visit = 0; visit < 3; visit++)
      await f.call("/service-orders", "POST", { ...opening, extra: { quilometragem: 2000 + visit }, object: { mode: "existing", id: objectId, version: 1 } });
    const fourVisits = { list: await listCount(), detail: await detailCount() };
    expect(fourVisits.list.page.data).toHaveLength(4);
    expect(fourVisits.list.page.data.every((order: { object?: { object_id: string } }) => order.object?.object_id === objectId)).toBe(true);
    expect(fourVisits.list.count.statements).toBe(oneVisit.list.count.statements);
    expect(fourVisits.list.count.sql).toEqual(oneVisit.list.count.sql);
    expect(os2DomainBudget(fourVisits.list.count)).toEqual(ZERO);
    // Ficha: leitura da ficha, da última conclusão e de uma página de histórico, sem consulta por ordem.
    expect(fourVisits.detail.statements).toBe(oneVisit.detail.statements);
    expect(fourVisits.detail.sql).toEqual(oneVisit.detail.sql);
    expect(os2DomainBudget(fourVisits.detail).statements).toBeLessThanOrEqual(3);
    // Objetos de um contato: uma consulta paginada ao domínio após a autorização.
    const objects = os2CountingEnv(env);
    const page = await h.run(() => os2Read(modulesApi(objects.env, f.profile, "os"), f.actor, "os.objects.list", { params: {}, query: { contact_id: contact } })) as { data: Array<{ id: string }> };
    expect(page.data.map(entry => entry.id)).toEqual([objectId]);
    expect(os2DomainBudget(objects.count).statements).toBe(1);
    // Isolamento: outro cliente e outra área não alcançam o veículo.
    const neighbourContact = (await resolveCustomer(env, await conversation(env, neighbour, f.profile))).contactId!;
    expect((await f.call(`/service-orders/objects?contact_id=${neighbourContact}`)).data).toEqual([]);
    expect((await f.call(`/service-orders/conversation/${neighbour}/objects`)).data).toEqual([]);
    // A outra área tem o módulo ligado: a recusa vem do isolamento, não do módulo desligado.
    await perform(env, other.actor, other.profile, "module.set", { id: "os", enabled: true }, uid());
    await other.call(`/service-orders/objects/${objectId}`, "GET", undefined, uid(), 404);
    report.with_objects = { one_visit: { list: oneVisit.list.count, detail: oneVisit.detail }, four_visits: { list: fourVisits.list.count, detail: fourVisits.detail }, contact_objects: objects.count };
  }, 240000);

  it("filtro próprio usa índice tipado e até 1.000 rows_read sobre 5.000 ordens; reconstrução limitada e concorrente", async ({ task }) => {
    const h = os2Harness(env, runtime), { f, typeId, ctx } = await mixedArea(h);
    const measurements: unknown[] = [];
    const report: Record<string, unknown> = { scenario: "indice", orders: 5000, maximum_data_rows_read: 1000, measurements };
    (task.meta as Record<string, unknown>).os2Budget = report;
    const type = (await config(f.profile)).os_work_types.find((entry: CustomWorkType) => entry.id === typeId) as CustomWorkType;

    // Reconstrução: até cinco ordens por comando e no máximo 50 instruções por invocação.
    const seed = async (from: number, to: number) => exec(env, `WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x<?)
      INSERT INTO os_orders(id,profile_id,number,type_number,type_id,type_snapshot_json,stage,status,phone,item,problem,source,created_by,created,updated,extra_json)
      SELECT ? || ':' || x,?,x,x,?,?,'recebido','received','5511960010203','Veículo','Conferir','api','test',?,?,json_object('quilometragem',x*10) FROM n`,
      from, to, f.profile, f.profile, typeId, JSON.stringify(makeSnapshot(type)), now(), now());
    await seed(1, 12);
    let state: FieldIndexState = await f.call(`/service-orders/types/${typeId}/field-index/rebuild`, "POST", {}, uid(), 200, "rebuild_start");
    expect(state).toMatchObject({ status: "building", cursor_number: 0, ceiling_number: 12 });
    // Dois comandos simultâneos com a mesma posição: um lote só, sem somar exclusões duas vezes.
    const step = (requestId: string) => os2Command(ctx, f.actor, "os.field_index.rebuild", { type_id: typeId, generation: state.generation, cursor_number: 0 }, { requestId });
    const raced = await Promise.all([step(uid()), step(uid())]) as FieldIndexState[];
    expect(raced[0]).toEqual(raced[1]);
    expect(raced[0].cursor_number).toBe(5);
    state = raced[0];
    let commands = 0;
    while (state.status !== "ready") {
      expect(++commands).toBeLessThan(10);
      state = await f.call(`/service-orders/types/${typeId}/field-index/rebuild`, "POST", { generation: state.generation, cursor_number: state.cursor_number }, uid(), 200, "rebuild_step");
    }
    expect(commands).toBe(2);
    expect(await one(env, "SELECT COUNT(*) n FROM os_order_field_index WHERE profile_id=? AND field_key='order:quilometragem'", f.profile)).toEqual({ n: 12 });
    const rebuilds = h.report.filter(entry => entry.name.startsWith("rebuild_"));
    for (const invocation of rebuilds) expect(invocation.worker.statements + invocation.coordinators.reduce((total, count) => total + count.statements, 0), invocation.name).toBeLessThanOrEqual(50);
    report.rebuild = { state, invocations: rebuilds };

    // Massa grande já indexada (como deixada por uma reconstrução completa).
    await seed(13, 5000);
    const definition = await resolveFieldIndexDefinition(ctx, typeId);
    await exec(env, "UPDATE os_field_index_state SET status='ready',cursor_number=5000,ceiling_number=5000 WHERE profile_id=? AND type_id=?", f.profile, typeId);
    await exec(env, `INSERT INTO os_order_field_index(profile_id,type_id,generation,field_key,value_kind,value_text,value_number,order_id,order_number,order_version)
      SELECT profile_id,type_id,?,'order:quilometragem','integer',NULL,number*10,id,number,row_version FROM os_orders WHERE profile_id=? AND type_id=? AND number>12`, definition.generation, f.profile, typeId);
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=? AND type_id=?", f.profile, typeId)).toEqual({ n: 5000 });
    const filter = { ref: { scope: "order", field_id: "quilometragem" }, operator: "range", from: 1000, to: 20000 };
    async function measured(query: Record<string, string>) {
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
      const page = await h.run(() => queryOrdersByField(modulesApi({ ...counted.env, DB }, f.profile, "os"), { type_id: typeId, field_filter: JSON.stringify(filter), ...query }, f.actor));
      const data = counted.count.queries.filter(entry => /\b(?:os_order_field_index|os_orders|os_tasks)\b/.test(entry.sql) && !/\bos_field_index_state\b/.test(entry.sql));
      const candidate = captured.find(entry => /\bFROM os_order_field_index\b/i.test(entry.sql));
      const plan = candidate ? await all(env, "EXPLAIN QUERY PLAN " + candidate.sql, ...candidate.bindings) : [];
      measurements.push({ query, data, other: counted.count.queries.filter(entry => !data.includes(entry)), plan });
      expect(data.reduce((total, entry) => total + entry.rows_read, 0)).toBeLessThanOrEqual(1000);
      expect(data.every(entry => entry.metadata)).toBe(true);
      expect(data.map(entry => entry.sql).join(" ")).not.toMatch(/\bOFFSET\b|json_extract|count\(\*\)\s+FROM\s+os_orders|GROUP BY/i);
      expect(JSON.stringify(plan)).toMatch(/os_order_field_number/);
      expect(JSON.stringify(plan)).not.toMatch(/SCAN os_orders|USE TEMP B-TREE/);
      expect(page).toMatchObject({ counts: null, counts_scope: "not_computed", order_by: "field_value_asc" });
      return page;
    }
    const first = await measured({ limit: "50" });
    expect(first.data.map(order => order.number)).toEqual(Array.from({ length: 50 }, (_, index) => 100 + index));
    const second = await measured({ limit: "50", cursor: first.next_cursor! });
    expect(second.data[0].number).toBe(150);
    // Isolamento: o cursor selado não vale em outra área.
    const other = await mixedArea(h);
    expect(await other.f.call(`/service-orders/types/${typeId}/field-index/rebuild`, "POST", {})).toMatchObject({ status: "ready", ceiling_number: 0 });
    await other.f.call("/service-orders?" + new URLSearchParams({ type_id: typeId, field_filter: JSON.stringify(filter), cursor: first.next_cursor! }), "GET", undefined, uid(), 400);
  }, 300000);
});
