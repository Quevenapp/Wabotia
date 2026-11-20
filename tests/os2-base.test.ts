import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, now, uid, type Env as AppEnv } from "../src/types";
import { perform, settingsRevision } from "../src/service";
import { hmac, setSecret } from "../src/security";
import { modulesApi } from "../src/modules/api";
import { validateExtra, validateField, validateObjectType, validateObjectValues, validateWorkType, validateWorkTypeChanges, isFieldFilled } from "../src/modules/os/validation";
import { resolveWorkFields, makeSnapshot, snapshotType } from "../src/modules/os/work-types";
import { projectObjectViewForCustomer } from "../src/modules/os/privacy";
import { createOrder, listOrders, loadOrder } from "../src/modules/os/store";
import { requestStageApproval } from "../src/modules/os/stages";
import { withOs2Adapters, publicObjectLabel, type Os2Adapters } from "../src/modules/os/os2-ports";
import type { ServiceObjectType, ServiceObjectSnapshot, WorkField } from "../src/modules/os/contracts";
import { integrationFixture, customerConversation } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2CountingEnv, os2DomainBudget } from "./os2-d1-counter";
import { os2Harness, withOs2Time } from "./os2-fixture";
import baseline from "./os2-baseline.json";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const harness = (adapters: Partial<Os2Adapters> = {}) => os2Harness(env, runtime, adapters);
const field = (id: string, kind: WorkField["kind"], extra: Record<string, unknown> = {}): WorkField => ({ id, kind, label: id, help: "", required: false, client_visible: true, sensitive: false, ...extra }) as WorkField;
const objectType = (): ServiceObjectType => ({ schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", fields: [field("placa", "text", { max_length: 10, multiline: false })], retired_field_ids: [] });
async function setup(h = harness(), useObject = false) {
  const f = await integrationFixture(h);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  const type = motorWorkType();
  if (useObject) type.object_type_id = "veiculo";
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], ...(useObject ? { os_object_types: [objectType()] } : {}), settings_revision: await settingsRevision(env, f.profile) }, uid());
  return { ...f, h, type, ctx: modulesApi(env, f.profile, "os") };
}
async function contact(profile: string) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','cliente','panel','test','test',?,?)", id, profile, now(), now());
  return id;
}
const opening = (type_id = "projeto") => ({ type_id, phone: "5511960010203", item: "Revisão", problem: "Conferir", notify: false });

/** Simula somente a folha de objetos: validação de valores continua sendo a real. */
function objectAdapters(failAfter = false): Partial<Os2Adapters> {
  const adapters: Partial<Os2Adapters> = {
    async prepareObjectOpening(ctx, opening) {
      const contactId = opening.input.contact_id ?? opening.contact_id;
      const owner = await one(ctx.env, "SELECT id FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'", contactId, ctx.profile);
      if (!owner) throw new ApiError(404, "not_found", "Cliente não disponível.");
      const request = opening.input.object!;
      const type = objectType();
      let snapshot: ServiceObjectSnapshot;
      const before: import("../src/modules/os/public").ChildStatement[] = [];
      if (request.mode === "existing") {
        const object = await one(ctx.env, "SELECT * FROM os_objects WHERE id=? AND profile_id=? AND contact_id=?", request.id, ctx.profile, contactId);
        if (!object) throw new ApiError(404, "not_found", "Objeto não disponível.");
        if (object.archived || object.row_version !== request.version) throw new ApiError(409, "version_conflict", "Objeto alterado.");
        snapshot = { schema_version: 1, object_id: object.id, object_version: object.row_version, captured_at: opening.at, origin: "opening", type: json(object.type_snapshot_json), values: json(object.values_json) };
        before.push(["SELECT CASE WHEN EXISTS(SELECT 1 FROM os_objects WHERE id=? AND profile_id=? AND contact_id=? AND type_id=? AND archived=0 AND row_version=?) THEN 1 ELSE json('os_version_conflict') END", [object.id, ctx.profile, contactId, type.id, request.version]]);
      } else {
        if (request.type_id !== type.id) throw new ApiError(400, "invalid_fields", "Tipo de objeto inválido.");
        snapshot = { schema_version: 1, object_id: uid(), object_version: 1, captured_at: opening.at, origin: "opening", type, values: validateObjectValues(type, request.values) };
        before.push(["INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [snapshot.object_id, ctx.profile, contactId, type.id, 1, JSON.stringify(type), JSON.stringify(snapshot.values), opening.input.actor, opening.input.actor, opening.at, opening.at]]);
      }
      const after: import("../src/modules/os/public").ChildStatement[] = [["INSERT INTO os2_receipts(profile_id,actor_key,operation,request_id,payload_hash,object_id,order_id,result_version,created) VALUES(?,?,?,?,?,?,?,1,?)", [ctx.profile, opening.input.actor, "os.create", opening.input.sourceKey, "simulated-leaf", snapshot.object_id, opening.order_id, opening.at]]];
      if (failAfter) after.push(["SELECT json('os2_forced_rollback')", []]);
      return { contact_id: contactId!, object_id: snapshot.object_id, snapshot, before, after };
    },
    async reauthorizeObjectOpening(ctx, row, input) {
      if (row.profile_id !== ctx.profile || row.contact_id !== input.contact_id) throw new ApiError(404, "not_found", "Objeto não disponível.");
    },
    projectObjectSnapshot(row, audience) {
      if (!row.object_id) return undefined;
      const snapshot = json(row.object_snapshot_json, null) as ServiceObjectSnapshot;
      const fields = snapshot.type.fields.filter(field => !field.sensitive && (audience.kind === "staff" || field.client_visible));
      return { schema_version: 1, object_id: snapshot.object_id, object_version: snapshot.object_version, captured_at: snapshot.captured_at, origin: snapshot.origin,
        type: { schema_version: 1, id: snapshot.type.id, revision: snapshot.type.revision, labels: { ...snapshot.type.labels }, fields, identifier_field_id: snapshot.type.identifier_field_id },
        identifier: String(snapshot.values.placa ?? "Veículo"), values: Object.fromEntries(fields.filter(field => Object.hasOwn(snapshot.values, field.id)).map(field => [field.id, snapshot.values[field.id]])) };
    },
    async projectObjectForActor(ctx, actor, row) {
      if (!ctx.mayRead(actor, "contacts")) return undefined;
      return adapters.projectObjectSnapshot!(row, { kind: "staff" });
    },
    async projectObjectPage(ctx, actor, rows) {
      const result = new Map<string, NonNullable<ReturnType<Os2Adapters["projectObjectSnapshot"]>>>();
      if (!ctx.mayRead(actor, "contacts")) return result;
      for (const row of rows) {
        const projected = adapters.projectObjectSnapshot!(row, { kind: "staff" });
        if (projected) result.set(row.id, projected);
      }
      return result;
    },
    publicObjectLabel: () => "Veículo",
  };
  return adapters;
}

describe("OS2: contratos compartilhados e compatibilidade", () => {
  it("reutiliza os seis tipos, preenchimento e privacidade sem alterar modelo sem objeto", () => {
    const fields = [field("texto", "text", { multiline: false, max_length: 10 }), field("inteiro", "integer", { min: 0, max: 9, required: true }), field("decimal", "decimal", { min: 0, max: 9, scale: 2 }), field("booleano", "boolean", { required: true }), field("data", "date", { min: null, max: null }), field("opcao", "choice", { options: [{ id: "a", label: "A" }] })].map(value => validateField(value));
    const values = { texto: "  Olá  ", inteiro: 0, decimal: 0.25, booleano: false, data: "2024-02-29", opcao: "a" };
    const type = { ...objectType(), fields: [objectType().fields[0], ...fields] };
    expect(validateObjectValues(type, values)).toEqual(validateExtra(fields, values));
    expect(isFieldFilled(values, "inteiro")).toBe(true);
    expect(isFieldFilled(values, "booleano")).toBe(true);
    for (const invalid of [{ inteiro: null }, { decimal: 0.001 }, { booleano: "false" }, { data: "2024-02-30" }, { opcao: "A" }, { texto: "texto muito longo" }])
      expect(() => validateObjectValues(type, { ...values, ...invalid })).toThrow();
    const secret = field("segredo", "text", { multiline: false, max_length: 30, sensitive: true, client_visible: false });
    expect(() => validateObjectValues({ ...type, fields: [...type.fields, secret] }, { ...values, segredo: "SIGILO" })).toThrow();
    expect(validateObjectValues({ ...type, fields: [...type.fields, secret] }, { segredo: "SIGILO" }, { mode: "private", partial: true })).toEqual({ segredo: "SIGILO" });
    const old = motorWorkType();
    expect(validateWorkType(old)).toEqual(old);
    expect(resolveWorkFields(old)).toEqual({ order: old.fields, object: [] });
    expect(snapshotType({ type_id: old.id, type_snapshot_json: JSON.stringify(makeSnapshot(old)) })).toEqual(old);
  });

  it("valida referências qualificadas, limites, revisões e classificação sem misturar namespaces", () => {
    const object = objectType(), work = motorWorkType();
    work.object_type_id = object.id;
    work.fields.push(field("placa", "text", { max_length: 10, multiline: false }));
    work.stage_field_rules = [{ field_id: "referencia", required_on_exit: ["entrada"] }];
    work.list_fields = [{ ref: { scope: "object", field_id: "placa" }, column: true, filter: true }, { ref: { scope: "order", field_id: "placa" }, column: true }];
    expect(() => validateWorkTypeChanges({}, { os_work_types: [work], os_object_types: [object] })).not.toThrow();
    expect(resolveWorkFields(work, object).order.find(f => f.id === "placa")).not.toBe(object.fields[0]);
    for (const bad of [{ ...object, identifier_field_id: "ausente" }, { ...object, fields: [field("placa", "integer", { min: 0, max: 9 })] }, { ...object, fields: [field("placa", "text", { multiline: false, max_length: 121 })] }]) expect(() => validateObjectType(bad)).toThrow();
    expect(() => validateWorkTypeChanges({}, { os_work_types: [work] })).toThrow();
    expect(() => validateWorkType({ ...work, stage_field_rules: [{ field_id: "segredo", required_from_stage: "execucao" }] })).toThrow();
    expect(() => validateWorkType({ ...work, stage_field_rules: [{ field_id: "referencia", required_from_stage: "ausente" }] })).toThrow();
    expect(() => validateWorkType({ ...work, list_fields: [{ ref: { scope: "order", field_id: "segredo" }, column: true }] })).toThrow();
    const previous = { os_object_types: [object] };
    expect(() => validateWorkTypeChanges(previous, { os_object_types: [{ ...object, labels: { ...object.labels, singular: "Carro" } }] })).toThrow();
    expect(() => validateWorkTypeChanges(previous, { os_object_types: [] })).toThrow();
    const secret = field("privado", "text", { multiline: false, max_length: 30, sensitive: true, client_visible: false });
    const secretType = { ...object, fields: [...object.fields, secret] };
    expect(() => validateWorkTypeChanges({ os_object_types: [secretType] }, { os_object_types: [{ ...secretType, revision: 2, fields: [...object.fields, { ...secret, sensitive: false }] }] })).toThrow();
    expect(() => resolveWorkFields({ ...work, fields: Array.from({ length: 24 }, (_, i) => field(`campo${i}`, "boolean")) }, object)).toThrow();
  });

  it("projeta a cópia explicitamente e oculta identificador interno e valores privados do cliente", () => {
    const type = objectType();
    type.fields[0].client_visible = false;
    type.fields.push(field("segredo", "text", { multiline: false, max_length: 30, sensitive: true, client_visible: false }));
    const view = projectObjectViewForCustomer({ schema_version: 1, object_id: "opaque7d2a91", object_version: 1, captured_at: 100, origin: "opening", type: { ...type }, values: { placa: "INTERNO", segredo: "SIGILO" }, identifier: "INTERNO" });
    expect(view.identifier).toBe("Veículo · 7D2A91");
    expect(JSON.stringify(view)).not.toMatch(/INTERNO|SIGILO|segredo|placa/);
    expect(view.values).toEqual({});
  });
});

describe("OS2: migrations e planos no D1 real", () => {
  it.each([false, true])("aplica SQL aditivo em esquema isolado com ordem antiga=%s", async legacy => {
    // A infraestrutura entrega um único binding. Um namespace de tabelas no
    // D1 real permite aplicar os SQL originais sem remover o esquema da suíte.
    const prefix = `os2case_${uid().replace(/[^a-z0-9]/gi, "").toLowerCase()}_`;
    const table = (name: string) => prefix + name;
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE ${table("profiles")}(id TEXT PRIMARY KEY)`),
      env.DB.prepare(`CREATE TABLE ${table("contacts")}(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,UNIQUE(id,profile_id))`),
      env.DB.prepare(`CREATE TABLE ${table("os_orders")}(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,type_id TEXT NOT NULL DEFAULT 'service_order',status TEXT NOT NULL DEFAULT 'received',created INTEGER NOT NULL,number INTEGER NOT NULL,delivered_at INTEGER,UNIQUE(profile_id,id))`),
      env.DB.prepare(`INSERT INTO ${table("profiles")} VALUES('area')`),
      env.DB.prepare(`INSERT INTO ${table("contacts")} VALUES('cliente','area')`),
    ]);
    if (legacy) await env.DB.prepare(`INSERT INTO ${table("os_orders")}(id,profile_id,created,number) VALUES('antiga','area',1,1)`).run();
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.filter(migration => /^015[01]_/.test(migration.name));
    expect(migrations.map(migration => migration.name)).toHaveLength(2);
    for (const migration of migrations) for (const query of migration.queries) {
      const sql = query.replace(/\b(profiles|contacts|os_orders\w*|os_objects\w*|os_object_history\w*|os2_receipts|os_field_index_state|os_order_field_\w*)\b/g, name => table(name));
      await env.DB.prepare(sql).run();
    }
    if (legacy) expect(await env.DB.prepare(`SELECT object_id,object_snapshot_json,stage_required_json FROM ${table("os_orders")} WHERE id='antiga'`).first()).toEqual({ object_id: null, object_snapshot_json: null, stage_required_json: "[]" });
    const insert = env.DB.prepare(`INSERT INTO ${table("os_objects")}(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,'test','test',1,1)`);
    await insert.bind("objeto", "area", "cliente", "veiculo", JSON.stringify(objectType())).run();
    await expect(insert.bind("cruzado", "outra", "cliente", "veiculo", JSON.stringify(objectType())).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE ${table("os_objects")} SET values_json='[]' WHERE id='objeto'`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO ${table("os_orders")}(id,profile_id,created,number,object_id,object_snapshot_json) VALUES('classica','area',1,2,'objeto','{}')`).run()).rejects.toThrow();
  });

  it("settings aplica tipos e objetos no mesmo CAS e adaptadores de produção recusam aberturas incompletas", async () => {
    const f = await setup(), revision = await settingsRevision(env, f.profile);
    const response = await f.call("/settings", "PUT", { os_object_types: [objectType()], settings_revision: revision });
    expect(response).toBeTruthy();
    await f.call("/settings", "PUT", { os_object_types: [], settings_revision: revision }, uid(), 409);
    const configured = json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings);
    expect(configured.os_object_types).toEqual([objectType()]);
    const updated = { ...f.type, revision: 2, object_type_id: "veiculo" };
    await f.call("/settings", "PUT", { os_work_types: [updated], settings_revision: await settingsRevision(env, f.profile) });
    await f.call("/service-orders", "POST", opening(), uid(), 409);
    // Sem stubs: sem contato confirmado, a folha de objetos recusa antes de gravar.
    await f.call("/service-orders", "POST", { ...opening(), object: { mode: "new", type_id: "veiculo", values: {} } }, uid(), 409);
    expect(await one(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile)).toBeNull();
    expect(await one(env, "SELECT id FROM os_objects WHERE profile_id=?", f.profile)).toBeNull();
  }, 60000);

  it("instala a folha nos Coordinators, confirma lote único e reautoriza sem duplicar objetos/ordens", async () => {
    const h = harness(objectAdapters()), f = await setup(h, true);
    const owner = await contact(f.profile), other = await contact(f.profile);
    const key = uid(), request = { ...opening(), contact_id: owner, object: { mode: "new", type_id: "veiculo", values: { placa: "ABC1D23" } } };
    const first = await f.call("/service-orders", "POST", request, key);
    expect(first.item).toBe("Revisão");
    const replay = await h.fetch(f.request("/service-orders", "POST", request, key));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Content-Type")).toContain("application/json");
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const repeated = await replay.json() as { id: string; item: string };
    expect(repeated.id).toBe(first.id);
    expect(repeated.item).toBe(first.item);
    const saved = await loadOrder(f.ctx, first.id);
    // O recibo de domínio compara valores normalizados. O recibo HTTP externo
    // ainda compara o corpo original e pertence à integração subsequente.
    const normalizedReplay = await h.run(() => createOrder(f.ctx, { ...request,
      object: { mode: "new", type_id: "veiculo", values: { placa: " ABC1D23 " } },
      source: "panel", actor: f.actor.id, authority: f.actor,
      sourceKey: saved.source_key.slice(`motor:${f.profile}:`.length),
    }));
    expect(normalizedReplay.created).toBe(false);
    expect(normalizedReplay.order.id).toBe(first.id);
    expect((await all(env, "SELECT id FROM os_objects WHERE profile_id=?", f.profile))).toHaveLength(1);
    expect((await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile))).toHaveLength(1);
    expect((await all(env, "SELECT order_id FROM os2_receipts WHERE profile_id=?", f.profile))).toHaveLength(1);
    const row = await one(env, "SELECT object_id FROM os_orders WHERE id=?", first.id);
    await f.call("/service-orders", "POST", { ...opening(), contact_id: other, object: { mode: "existing", id: row!.object_id, version: 1 } }, uid(), 404);
    const foreign = await integrationFixture(h);
    await f.call("/service-orders", "POST", { ...request, contact_id: await contact(foreign.profile) }, uid(), 404);
    await f.call("/service-orders", "POST", { ...request, problem: "Pedido diferente" }, key, 409);
    expect(h.report.some(invocation => invocation.coordinators.some(count => count.queries.some(query => query.domain === "os2")))).toBe(true);
    expect((await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile))).toHaveLength(1);
  }, 60000);

  it("falha depois da ordem reverte objeto, numeração, histórico e recibos do plano", async () => {
    const h = harness(objectAdapters(true)), f = await setup(h, true), owner = await contact(f.profile);
    await f.call("/service-orders", "POST", { ...opening(), contact_id: owner, object: { mode: "new", type_id: "veiculo", values: {} } }, uid(), 409);
    for (const table of ["os_orders", "os_objects", "os_history", "os2_receipts", "os_counters", "os_type_counters"])
      expect(await one(env, `SELECT 1 AS present FROM ${table} WHERE profile_id=?`, f.profile)).toBeNull();
    const clean = harness(objectAdapters());
    const response = await clean.fetch(f.request("/service-orders", "POST", { ...opening(), contact_id: owner, object: { mode: "new", type_id: "veiculo", values: {} } }));
    expect(response.status).toBe(200);
    expect((await response.json() as { number: number }).number).toBe(1);
  }, 60000);

  it("pré-conclusão v2 recusada mantém o link sem consumo e sem ordem", async () => {
    let attempts = 0;
    const h = harness({ prepareObjectWebStepCompletion: async (_ctx, _step, _answers, options) => {
      if (options?.resumeOnly) return null;
      attempts++; throw new ApiError(409, "version_conflict", "O objeto mudou. Atualize a seleção.");
    } });
    const f = await setup(h), conversationId = await customerConversation(h, f), id = uid(), definition = uid();
    const ref = { schema_version: 2, definition_id: definition, type_id: "projeto", revision: 1 };
    await exec(env, "INSERT INTO os_open_definitions(profile_id,id,type_id,type_revision,snapshot_json,created) VALUES(?,?,?,1,?,?)", f.profile, definition, "projeto", JSON.stringify({ schema_version: 2, type: f.type, object_type: objectType(), choices: [] }), now());
    await exec(env, "INSERT INTO web_steps(id,profile_id,conversation_id,module_id,kind,ref_id,code_hash,status,title,spec,trigger,actor,source_key,expires_at,created,updated) VALUES(?,?,?,'os','open',?,'hash','sent','Abrir',?,'menu','customer',?,?,?,?)", id, f.profile, conversationId, JSON.stringify(ref), JSON.stringify({ page: "form", title: "Abrir", fields: [], return_message: "module" }), uid(), now() + 3600000, now(), now());
    const call = () => h.coordinator(f.profile, new Request("https://coordinator/web-step", { method: "POST", body: JSON.stringify({ profile: f.profile, id, answers: {} }) }), "object_web_step_refusal");
    for (let repeat = 0; repeat < 2; repeat++) expect(await (await call()).json()).toMatchObject({ ok: false, reason: "rejected" });
    expect(attempts).toBe(2);
    expect(await one(env, "SELECT status,completed_at,result FROM web_steps WHERE id=?", id)).toMatchObject({ status: "sent", completed_at: null, result: null });
    expect(await one(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile)).toBeNull();
  }, 60000);

  it("compõe requisitos e índice no CAS sem objeto; recusa e rollback não avançam etapa", async () => {
    let failIndex = false;
    const h = harness({
      prepareOrderRulesMutation: async (_ctx, input) => {
        const active: string[] = json(input.row.stage_required_json, []);
        const cancel = input.sets.status === "cancelled";
        const exits = input.sets.stage && input.sets.stage !== input.row.stage && input.type.stage_field_rules?.some(rule => rule.required_on_exit?.includes(String(input.row.stage)));
        const required = !cancel && (active.includes("referencia") || exits);
        const values = json(input.sets.extra_json ?? input.row.extra_json, {});
        if (required && !isFieldFilled(values, "referencia")) throw new ApiError(409, "missing_fields", "Complete Referência antes de avançar.");
        return { before: [], after: [], ...(!input.preview && required ? { stage_required: ["referencia"] } : {}) };
      },
      planOrderFieldIndex: async (_ctx, input) => failIndex && input.row.stage === "execucao" ? [["SELECT json('os2_index_rollback')", []]] : [],
    });
    const f = await setup(h);
    const type = { ...f.type, revision: 2, stage_field_rules: [{ field_id: "referencia", required_on_exit: ["entrada"] }] };
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const order = await f.call("/service-orders", "POST", opening());
    expect(order.object).toBeUndefined();
    const initialHistory = await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id);
    await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: "iniciar" }, uid(), 409);
    expect(await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id)).toEqual(initialHistory);
    const filled = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { referencia: "Conferida" } });
    failIndex = true;
    await f.call(`/service-orders/${order.id}/stage`, "POST", { version: filled.version, transition_id: "iniciar" }, uid(), 409);
    expect(await one(env, "SELECT stage,row_version,stage_required_json FROM os_orders WHERE id=?", order.id)).toEqual({ stage: "entrada", row_version: filled.version, stage_required_json: "[]" });
    failIndex = false;
    const moved = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: filled.version, transition_id: "iniciar" });
    expect(await one(env, "SELECT stage_required_json FROM os_orders WHERE id=?", order.id)).toEqual({ stage_required_json: '["referencia"]' });
    await f.call(`/service-orders/${order.id}`, "PATCH", { version: moved.version, extra: { referencia: "" } }, uid(), 409);
    expect(await one(env, "SELECT extra_json,row_version FROM os_orders WHERE id=?", order.id)).toEqual({ extra_json: '{"referencia":"Conferida"}', row_version: moved.version });
    expect(await one(env, "SELECT id FROM os_objects WHERE profile_id=?", f.profile)).toBeNull();
  }, 60000);
});

describe("OS2: harness isolado e orçamento verificável", () => {
  it("mantém adaptadores isolados inclusive em operações assíncronas simultâneas", async () => {
    const row = { id: "ordem", profile_id: "area", number: 1, status: "received" as const, conversation_id: null, phone: "" };
    const result = await Promise.all(["primeiro", "segundo"].map(label => withOs2Adapters({ publicObjectLabel: () => label }, async () => {
      await Promise.resolve();
      return publicObjectLabel(row);
    })));
    expect(result).toEqual(["primeiro", "segundo"]);
    expect(publicObjectLabel(row)).toBe("");
  });

  it("captura metadados reais inclusive first/raw/batch sem consultas de medição adicionais", async () => {
    const measured = os2CountingEnv(env);
    expect(await measured.env.DB.prepare("SELECT 42 AS answer").first("answer")).toBe(42);
    expect(await measured.env.DB.prepare("SELECT 0 AS zero,1 AS one").raw()).toEqual([[0, 1]]);
    await measured.env.DB.batch([measured.env.DB.prepare("SELECT 1 AS a"), measured.env.DB.prepare("SELECT 2 AS b")]);
    expect(measured.count.calls).toBe(3);
    expect(measured.count.statements).toBe(4);
    expect(measured.count.queries).toHaveLength(4);
    expect(measured.count.metadata_missing).toBe(0);
    expect(measured.count.rows_written).toBe(0);
  });

  it("mede Worker/Coordinators reais sem acesso ao domínio novo no caminho sem objeto", async ({ task }) => {
    await withOs2Time(1795000000000, async clock => {
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: { messageId: uid() } }));
      const h = harness();
      const budget: Record<string, unknown> = {
        schema_version: 1, base_commit: baseline.base_commit, baseline_status: baseline.status,
        comparison: "pending_external_baseline", clock: "controlled", network: "stubbed_transport", scenarios: h.report,
      };
      (task.meta as Record<string, unknown>).os2Budget = budget;
      try {
        const f = await setup(h), integration = uid(), account = uid(), secret = "os2-whatsapp-fixture-secret";
        await exec(env, "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Fixture OS2',?,'zernio',?)", integration, f.profile, `os2:${integration}`, now());
        await exec(env, "UPDATE connections SET config=? WHERE id=?", JSON.stringify({ account_id: account, zernio_workspace_id: integration, service: { mode: "human", menu_mode: "off" } }), f.line);
        await setSecret(env, `zernio-account:${integration}`, { api_key: "os2-fixture-key", webhook_secret: secret });
        const phone = "5511979990401", thread = uid();
        const message = async (name: string, text: string) => {
          clock.advance(1000);
          const body = JSON.stringify({ id: uid(), event: "message.received", timestamp: new Date(now()).toISOString(), account: { accountId: account, platform: "whatsapp" }, conversation: { id: thread, participantId: phone }, message: { platform: "whatsapp", platformMessageId: uid(), direction: "incoming", text, sentAt: new Date(now()).toISOString(), sender: { id: phone, name: "Cliente", phoneNumber: phone } } });
          const response = await h.fetch(new Request(`https://test/webhooks/zernio/${f.line}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Zernio-Signature": await hmac(secret, body) }, body }), name);
          expect(response.ok, await response.clone().text()).toBe(true);
          await h.alarm(f.profile);
          h.report[h.report.length - 1].name = name + ":alarm";
          expect(await one(env, "SELECT COUNT(*) n FROM inbox WHERE profile_id=? AND status!='done'", f.profile)).toEqual({ n: 0 });
        };
        h.report.length = 0;
        await message("common_message", "Olá");
        const conversation = await one(env, "SELECT id FROM conversations WHERE profile_id=? AND connection_id=? AND external_id=?", f.profile, f.line, phone);
        expect(conversation).toBeTruthy();
        const classic = await f.call("/service-orders", "POST", { ...opening("service_order"), phone, conversation_id: conversation!.id }, uid(), 200, "classic_opening");
        const type = { ...f.type, revision: 2, transitions: f.type.transitions.map(transition => transition.id === "iniciar" ? { ...transition, kind: "customer_approval" as const, valid_hours: 24, request_text: "Autoriza iniciar?" } : transition) };
        await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) }, uid());
        const custom = await f.call("/service-orders", "POST", { ...opening(), phone, conversation_id: conversation!.id }, uid(), 200, "custom_opening_without_object");
        expect(classic.object).toBeUndefined(); expect(custom.object).toBeUndefined();
        const tracked = await f.call(`/service-orders/conversation/${conversation!.id}`, "GET", undefined, uid(), 200, "tracking");
        expect(tracked.data.map((order: { id: string }) => order.id).sort()).toEqual([classic.id, custom.id].sort());
        const foreignConversation = await customerConversation(h, f, "5511979990402");
        expect((await f.call(`/service-orders/conversation/${foreignConversation}`, "GET", undefined, uid(), 200, "tracking_other_customer")).data).toEqual([]);
        const beforeApproval = await loadOrder(f.ctx, custom.id);
        await h.run(() => requestStageApproval(f.ctx, beforeApproval, { transition_id: "iniciar", version: custom.version }, f.actor.id));
        await message("stage_reply", `APROVAR ETAPA ${custom.number}`);
        expect((await loadOrder(f.ctx, custom.id)).stage).toBe("execucao");
        await perform(env, f.actor, f.profile, "settings", { os_object_types: [objectType()], settings_revision: await settingsRevision(env, f.profile) }, uid());
        await message("configured_objects_unused", "Olá novamente");
        const counted = os2CountingEnv(env);
        await listOrders(modulesApi(counted.env, f.profile, "os"), { type_id: type.id }, f.actor);
        const afterColumns = { ...type, revision: 3, list_fields: [{ ref: { scope: "order" as const, field_id: "referencia" }, column: true }] };
        await perform(env, f.actor, f.profile, "settings", { os_work_types: [afterColumns], settings_revision: await settingsRevision(env, f.profile) }, uid());
        const columnsCounted = os2CountingEnv(env);
        await listOrders(modulesApi(columnsCounted.env, f.profile, "os"), { type_id: type.id }, f.actor);
        expect(columnsCounted.count.statements).toBe(counted.count.statements);
        expect(columnsCounted.count.sql).toEqual(counted.count.sql);
        expect(os2DomainBudget(columnsCounted.count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
        for (const invocation of h.report) for (const count of [invocation.worker, ...invocation.coordinators]) {
          expect(count.metadata_missing).toBe(0);
          expect(os2DomainBudget(count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
        }
        budget.list_columns = { before: counted.count, after: columnsCounted.count };
      } finally { transport.mockRestore(); }
    });
  }, 180000);
});

describe("OS2: manifestos e atualização explícita de padrões", () => {
  const manifest = (withObjects = false): import("../src/modules/os/contracts").AreaTemplate => {
    const first = motorWorkType();
    const second = { ...motorWorkType(), id: "complemento", labels: { ...first.labels, singular: "Complemento", plural: "Complementos" } };
    if (withObjects) { first.object_type_id = "veiculo"; second.object_type_id = "veiculo"; }
    return {
      schema_version: 1, id: "os2_modelo", version: 1, name: "Modelo OS2", description: "Definições para teste.",
      work_types: withObjects ? [first, second] : [first],
      ...(withObjects ? { object_types: [{ ...objectType(), fields: [...objectType().fields, field("reserva_privada", "text", { max_length: 100, multiline: false, sensitive: true, client_visible: false })] }] } : {}),
      modules: { os: true }, vocabulary: { collection_label: "Ordens", customer_singular: "Cliente", customer_plural: "Clientes" },
      departments: [], ticket_categories: [], menus: [], texts: {},
      bot: { instructions: "", allowed_operations: [], denied_operations: [], suggested_roles: [] }, manual_steps: [],
    };
  };
  const selection = (source: import("../src/modules/os/contracts").AreaTemplate) => ({
    work_type_ids: source.work_types.map(type => type.id), module_ids: ["os"],
    menus: false, departments: false, ticket_categories: false, vocabulary: false, texts: false, bot_suggestions: false,
  });

  it("preserva manifestos sem objeto e recusa referências inválidas sem alterar a entrada", async () => {
    const { validateAreaTemplate } = await import("../src/area-templates/validation");
    const legacy = manifest(), original = structuredClone(legacy);
    expect(validateAreaTemplate(legacy)).toEqual(legacy);
    expect(validateAreaTemplate(legacy).object_types).toBeUndefined();
    expect(legacy).toEqual(original);
    const shared = manifest(true);
    expect(validateAreaTemplate(shared).object_types).toHaveLength(1);
    const invalid = structuredClone(shared);
    invalid.work_types[1].object_type_id = "outro";
    expect(() => validateAreaTemplate(invalid)).toThrowError(expect.objectContaining({ code: "invalid_template" }));
    expect(() => validateAreaTemplate({ ...shared, object_types: [shared.object_types![0], shared.object_types![0]] })).toThrow();
    expect(shared.work_types.every(type => type.object_type_id === "veiculo")).toBe(true);
  });

  it("aplica e exporta um objeto compartilhado, preservando edições, repetição e isolamento entre áreas", async () => {
    const { previewAreaTemplate, applyAreaTemplate, exportAreaTemplate } = await import("../src/area-templates/engine");
    const h = harness(), f = await integrationFixture(h), other = await integrationFixture(h);
    const source = manifest(true), input = { manifest: source, selection: selection(source) };
    const preview = await previewAreaTemplate(env, f.actor, f.profile, input);
    expect(preview.conflicts).toEqual([]);
    const requestId = uid(), request = { ...input, preview_hash: preview.preview_hash };
    const applied = await applyAreaTemplate(env, f.actor, f.profile, request, [], requestId);
    expect(applied.applied).toBe(true);
    expect(await applyAreaTemplate(env, f.actor, f.profile, request, [], requestId)).toEqual(applied);
    const settings = json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings);
    const typeIds = settings.os_work_types.map((type: { id: string }) => type.id);
    expect(settings.os_object_types).toHaveLength(1);
    expect(settings.os_object_types[0].id).toBe("area_os2_modelo__veiculo");
    expect(settings.os_work_types.map((type: { object_type_id: string }) => type.object_type_id)).toEqual(["area_os2_modelo__veiculo", "area_os2_modelo__veiculo"]);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    const customized = structuredClone(settings.os_work_types);
    customized[0].labels.singular = "Nome escolhido pela equipe"; customized[0].revision++;
    await perform(env, f.actor, f.profile, "settings", { os_work_types: customized, settings_revision: await settingsRevision(env, f.profile) }, uid());
    const again = await previewAreaTemplate(env, f.actor, f.profile, input);
    expect(again.can_apply).toBe(true);
    expect((await applyAreaTemplate(env, f.actor, f.profile, { ...input, preview_hash: again.preview_hash }, [], uid())).applied).toBe(false);
    const owner = await contact(f.profile), objectId = uid(), privateValue = "OS2_VALOR_PRIVADO_NAO_EXPORTAR";
    await exec(env, "INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,?, 'test','test',?,?)",
      objectId, f.profile, owner, settings.os_object_types[0].id, JSON.stringify(settings.os_object_types[0]), JSON.stringify({ placa: "ABC1234", reserva_privada: privateValue }), now(), now());
    const exported = await exportAreaTemplate(env, f.actor, f.profile, { id: "exportado", name: "Exportado", type_ids: typeIds });
    expect(exported.object_types).toHaveLength(1);
    expect(exported.object_types![0].id).toBe("objeto_1");
    expect(exported.work_types.map(type => type.object_type_id)).toEqual(["objeto_1", "objeto_1"]);
    expect(exported.work_types[0].labels.singular).toBe("Nome escolhido pela equipe");
    for (const value of [privateValue, "ABC1234", objectId, owner, f.profile]) expect(JSON.stringify(exported)).not.toContain(value);
    expect(exported.object_types![0].fields.find(entry => entry.id === "reserva_privada")?.sensitive).toBe(true);
    await expect(exportAreaTemplate(env, other.actor, other.profile, { id: "outro", name: "Outro", type_ids: typeIds })).rejects.toMatchObject({ status: 404 });
    const imported = { manifest: exported, selection: selection(exported) };
    const otherPreview = await previewAreaTemplate(env, other.actor, other.profile, imported);
    expect(otherPreview.conflicts).toEqual([]);
    await applyAreaTemplate(env, other.actor, other.profile, { ...imported, preview_hash: otherPreview.preview_hash }, [], uid());
    const otherSettings = json((await one(env, "SELECT settings FROM profiles WHERE id=?", other.profile))!.settings);
    expect(otherSettings.os_object_types).toHaveLength(1);
    expect(otherSettings.os_object_types[0].id).toBe("area_exportado__objeto_1");
    expect(otherSettings.os_work_types.every((type: { object_type_id: string }) => type.object_type_id === "area_exportado__objeto_1")).toBe(true);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", other.profile)).toEqual({ n: 0 });
    expect(await one(env, "SELECT contact_id,values_json FROM os_objects WHERE id=?", objectId)).toEqual({ contact_id: owner, values_json: JSON.stringify({ placa: "ABC1234", reserva_privada: privateValue }) });
  }, 120000);

  it("planeja a mudança de localização sem alterar snapshots, quilometragem ou valores privados", async () => {
    const { planObjectUpgrade } = await import("../src/area-templates/object-upgrades");
    const current = motorWorkType();
    current.fields.push(...objectType().fields, field("quilometragem", "integer", { min: 0, max: 10000000 }));
    const oldSnapshot = makeSnapshot(current), oldValues = { placa: "ABC1234", quilometragem: 60000, segredo: "SIGILO_HISTORICO" };
    const before = JSON.stringify({ current, oldSnapshot, oldValues });
    const standard = { ...structuredClone(current), object_type_id: "veiculo", fields: current.fields.filter(entry => entry.id !== "placa"), retired_field_ids: ["placa"],
      stage_field_rules: [{ field_id: "quilometragem", required_on_exit: ["entrada"] }], list_fields: [{ ref: { scope: "object" as const, field_id: "placa" }, column: true }] };
    const input = { current, previous_standard: current, standard, object_type: objectType() };
    const plan = planObjectUpgrade(input);
    expect(plan.can_apply, JSON.stringify(plan.conflicts)).toBe(true);
    expect(plan.work_type.revision).toBe(current.revision + 1);
    expect(plan.moved_fields).toEqual(["placa"]);
    expect(plan.work_type.retired_field_ids).toContain("placa");
    expect(plan.retained_fields).toContain("quilometragem");
    expect(plan.work_type.fields.find(entry => entry.id === "segredo")?.sensitive).toBe(true);
    expect(plan.work_type.stage_field_rules).toEqual(standard.stage_field_rules);
    expect(JSON.stringify({ current, oldSnapshot, oldValues })).toBe(before);
    expect(JSON.stringify(plan)).not.toContain("SIGILO_HISTORICO");
    expect(JSON.stringify(plan)).not.toContain("ABC1234");
    const privateCurrent = structuredClone(current);
    Object.assign(privateCurrent.fields.find(entry => entry.id === "placa")!, { sensitive: true, client_visible: false });
    const blocked = planObjectUpgrade({ ...input, current: privateCurrent });
    expect(blocked.can_apply).toBe(false);
    expect(blocked.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "sensitive_field" })]));
    expect(blocked.moved_fields).not.toContain("placa");
    expect(blocked.work_type.fields.find(entry => entry.id === "placa")?.sensitive).toBe(true);
    const preserved = planObjectUpgrade({ ...input, current: privateCurrent, resolutions: { placa: "keep" } });
    expect(preserved.can_apply, JSON.stringify(preserved.conflicts)).toBe(true);
    expect(preserved.moved_fields).toEqual([]);
    expect(preserved.work_type.fields.find(entry => entry.id === "placa")?.sensitive).toBe(true);
  });
});
