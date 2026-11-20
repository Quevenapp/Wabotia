import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, now, uid, type Actor, type Env as AppEnv } from "../src/types";
import { conversation, perform, settingsRevision } from "../src/service";
import { modulesApi } from "../src/modules/api";
import { resolveCustomer } from "../src/customer/ports";
import { createChannelAdapters } from "../src/modules/os/channel-ports";
import { customOpenForm, openingAnswers } from "../src/modules/os/forms";
import { sendOpenForm } from "../src/modules/os/os";
import { customerObjectsRead } from "../src/modules/os/customer-objects";
import { publicObjectLabel, getWorkObjectContext, projectChannelObjectSnapshot } from "../src/modules/os/object-messages";
import { validateObjectValues } from "../src/modules/os/validation";
import type { Os2Adapters } from "../src/modules/os/os2-ports";
import type { ChildStatement, ServiceObjectRow, WorkOrderRow } from "../src/modules/os/public";
import type { ServiceObjectSnapshot, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import { integrationFixture, customerConversation } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2CountingEnv, os2DomainBudget } from "./os2-d1-counter";
import { os2Harness, withOs2Time, type Os2Harness } from "./os2-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const secret = "OS2_CANAIS_PRIVADO_NAO_VAZAR";
// src/index.ts: "invalid" (forma HTML) responde 422; "rejected" (módulo) responde 409.
const malformed = 422, refused = 409;
const field = (id: string, kind: WorkField["kind"], extra: Record<string, unknown> = {}): WorkField => ({ id, kind, label: id, help: "", required: false, client_visible: true, sensitive: false, ...extra }) as WorkField;
const objectType = (): ServiceObjectType => ({ schema_version: 1, id: "veiculo", revision: 1, archived: false,
  labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", retired_field_ids: [], fields: [
    field("placa", "text", { multiline: false, max_length: 120, required: true }),
    field("ano", "integer", { min: 0, max: 2100, required: true }),
    field("peso", "decimal", { min: 0, max: 10000, scale: 2 }),
    field("revisado", "boolean", { required: true }),
    field("data", "date", { min: null, max: null }),
    field("choice", "choice", { options: [{ id: "a", label: "Igual" }, { id: "b", label: "Igual" }] }),
    field("interno", "text", { multiline: false, max_length: 120, client_visible: false }),
    field("privado", "text", { multiline: false, max_length: 120, sensitive: true, client_visible: false }),
  ] });

/** Só a folha de objetos é simulada; formulário, autorização, Worker,
 * Coordinator, validação compartilhada e batch D1 são os reais. */
function objectAdapters(control: { failBatch?: boolean } = {}): Partial<Os2Adapters> {
  return {
    async prepareObjectOpening(ctx, opening) {
      const contactId = opening.input.contact_id ?? opening.contact_id;
      const owner = await one(ctx.env, "SELECT id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'", ctx.profile, contactId);
      if (!owner || (opening.contact_id && opening.contact_id !== contactId)) throw new ApiError(404, "not_found", "Cliente indisponível.");
      const request = opening.input.object!;
      let snapshot: ServiceObjectSnapshot;
      const before: ChildStatement[] = [];
      if (request.mode === "existing") {
        const object = await one<ServiceObjectRow>(ctx.env, "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND id=? AND type_id=?", ctx.profile, contactId, request.id, opening.type.object_type_id);
        if (!object) throw new ApiError(404, "not_found", "Objeto indisponível.");
        if (object.archived) throw new ApiError(409, "object_archived", "Objeto arquivado.");
        if (object.row_version !== request.version) throw new ApiError(409, "version_conflict", "Objeto alterado.");
        snapshot = { schema_version: 1, object_id: object.id, object_version: object.row_version, captured_at: opening.at, origin: "opening", type: json(object.type_snapshot_json), values: json(object.values_json) };
      } else {
        const type = objectType();
        if (request.type_id !== opening.type.object_type_id || request.type_id !== type.id) throw new ApiError(400, "invalid_fields", "Tipo incompatível.");
        snapshot = { schema_version: 1, object_id: uid(), object_version: 1, captured_at: opening.at, origin: "opening", type,
          values: validateObjectValues(type, request.values, { mode: "customer" }) };
        before.push(["INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,?,?,?,?,?)",
          [snapshot.object_id, ctx.profile, contactId, type.id, JSON.stringify(type), JSON.stringify(snapshot.values), opening.input.actor, opening.input.actor, opening.at, opening.at]]);
      }
      const after: ChildStatement[] = [["INSERT INTO os2_receipts(profile_id,actor_key,operation,request_id,payload_hash,object_id,order_id,result_version,created) VALUES(?,?,'os.create',?,?,?, ?,1,?)",
        [ctx.profile, opening.input.actor, opening.input.sourceKey, "simulated-object-leaf", snapshot.object_id, opening.order_id, opening.at]]];
      if (control.failBatch) after.push(["SELECT json('os_version_conflict')", []]);
      return { contact_id: contactId!, object_id: snapshot.object_id, snapshot, before, after };
    },
    async reauthorizeObjectOpening(ctx, row, input) {
      if (ctx.profile !== row.profile_id || input.contact_id !== row.contact_id) throw new ApiError(404, "not_found", "Objeto indisponível.");
    },
    projectObjectSnapshot: projectChannelObjectSnapshot,
    async projectObjectForActor(_ctx, _actor, row) { return projectChannelObjectSnapshot(row, { kind: "customer" }); },
    async projectObjectPage(_ctx, _actor, rows) {
      return new Map(rows.flatMap(row => { const view = projectChannelObjectSnapshot(row, { kind: "customer" }); return view ? [[row.id, view] as const] : []; }));
    },
  };
}
const harness = (control: { failBatch?: boolean } = {}) => os2Harness(env, runtime, createChannelAdapters(objectAdapters(control)));

async function setup(h = harness(), useObject = true) {
  const f = await integrationFixture(h);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  const type = motorWorkType();
  type.fields.push(field("placa", "text", { multiline: false, max_length: 120 }));
  type.stages[0].message = "Recebemos {identificador}: {objeto}.";
  if (useObject) type.object_type_id = "veiculo";
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], ...(useObject ? { os_object_types: [objectType()] } : {}), settings_revision: await settingsRevision(env, f.profile) }, uid());
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://test',?)", now());
  const conversationId = await customerConversation(h, f);
  const c = await conversation(env, conversationId, f.profile);
  const owner = await resolveCustomer(env, c);
  expect(owner.state).toBe("ready");
  return { ...f, h, type, c, contactId: owner.contactId!, ctx: modulesApi(env, f.profile, "os") };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function insertObject(f: Fixture, values: Record<string, unknown> = {}, owner = f.contactId, archived = false) {
  const id = uid(), at = now();
  await exec(env, "INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,archived,created_by,updated_by,created,updated) VALUES(?,?,?,'veiculo',1,?,?,?,'test','test',?,?)",
    id, f.profile, owner, JSON.stringify(objectType()), JSON.stringify({ placa: "ABC1D23", ano: 2024, revisado: false, privado: secret, interno: "SOMENTE_EQUIPE", ...values }), Number(archived), at, at);
  return id;
}
async function otherCustomer(f: Fixture, phone = "5511960010299") {
  const id = await customerConversation(f.h, f, phone), c = await conversation(env, id, f.profile);
  return { c, contactId: (await resolveCustomer(env, c)).contactId! };
}
async function openLink(f: Fixture, key = uid()) {
  const step = await f.call(`/conversations/${f.c.id}/actions`, "POST", { action: "service_order", send_form: true, type_id: f.type.id }, key);
  const row = await one(env, "SELECT * FROM web_steps WHERE id=?", step.id);
  expect(row).toBeTruthy();
  const messages = await all(env, "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created DESC,rowid DESC", f.c.id);
  const code = messages.map(message => /\/api\/w\/([A-Za-z0-9]{16})/.exec(message.payload)?.[1]).find(Boolean)!;
  expect(code).toBeTruthy();
  return { code, row: row!, step, key, spec: json(row!.spec) };
}
function submit(h: Os2Harness, code: string, answers: Record<string, string>, label = "object_form_post") {
  return h.fetch(new Request(`https://test/api/w/${code}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://test" },
    body: new URLSearchParams(Object.entries(answers).map(([key, value]) => [`f_${key}`, value])).toString() }), label);
}
const answers = () => ({ item: "Revisão", problem: "Conferir o motor", service_object_choice: "Informar outro", object_placa: " ABC1D23 ", object_ano: "0", object_peso: "0.25", object_revisado: "Não", object_data: "2024-02-29", object_choice: "2. Igual", extra_placa: "Medição da visita" });
async function expectEmpty(f: Fixture) {
  expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
  expect(await one(env, "SELECT COUNT(*) n FROM os2_receipts WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
}
function attachBudget(task: { meta: object }, h: Os2Harness, extra: Record<string, unknown> = {}) {
  (task.meta as Record<string, unknown>).os2Budget = { schema_version: 1, scenarios: h.report, runtime: "Worker e Coordinator reais", ...extra };
}

describe("OS2 canais: formulário e confirmação atômica", () => {
  it("GET/POST reais cadastram os seis tipos, separam objeto/ordem e repetem menu, ação e POST sem duplicar", async ({ task }) => {
    const f = await setup(); attachBudget(task, f.h);
    const key = uid(), menuKey = `menu:${uid()}`;
    const menu = await f.h.run(() => sendOpenForm(f.ctx, f.c, { trigger: "menu", actor: "system", sourceKey: menuKey, type_id: f.type.id }));
    const repeatedMenu = await f.h.run(() => sendOpenForm(f.ctx, f.c, { trigger: "menu", actor: "system", sourceKey: menuKey, type_id: f.type.id }));
    expect(repeatedMenu.step.id).toBe(menu.step.id);
    const link = await openLink(f, key);
    const repeatedAction = await f.call(`/conversations/${f.c.id}/actions`, "POST", { action: "service_order", send_form: true, type_id: f.type.id }, key);
    expect(repeatedAction.id).toBe(link.step.id);
    const page = await f.h.fetch(new Request(`https://test/api/w/${link.code}`), "object_form_get");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Qual veículo?");
    expect(html).toContain("Informar outro");
    expect(html).not.toMatch(/object_privado|object_interno|OS2_CANAIS_PRIVADO/);
    expect(link.spec.fields.filter((entry: any) => entry.id.startsWith("object_")).every((entry: any) => !entry.required)).toBe(true);
    expect(link.spec.fields.length).toBeLessThanOrEqual(30);
    expect(new Set(link.spec.fields.map((entry: any) => entry.id)).size).toBe(link.spec.fields.length);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    expect((await submit(f.h, link.code, answers())).status).toBe(200);
    const rows = await all(env, "SELECT * FROM os_orders WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    const snapshot = json(rows[0].object_snapshot_json);
    expect(snapshot.values).toEqual({ placa: "ABC1D23", ano: 0, peso: 0.25, revisado: false, data: "2024-02-29", choice: "b" });
    expect(json(rows[0].extra_json)).toEqual({ placa: "Medição da visita" });
    expect(await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id)).toEqual({ status: "completed" });
    expect((await submit(f.h, link.code, answers())).status).not.toBe(200);
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    expect(await one(env, "SELECT COUNT(*) n FROM os2_receipts WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
    const events = await all(env, "SELECT kind,payload FROM events WHERE profile_id=?", f.profile);
    expect(events.filter(event => event.kind === "web_step.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("ABC1D23");
    expect(f.h.report.some(invocation => invocation.worker_invoked && invocation.coordinators.length > 0)).toBe(true);
  }, 120000);

  it("lista até 30 escolhas públicas e seleciona existente sem recadastrar ou editar", async ({ task }) => {
    const f = await setup(); attachBudget(task, f.h);
    const own = await insertObject(f, { placa: "X".repeat(120) });
    const other = await otherCustomer(f);
    await insertObject(f, { placa: "OUTRO_CLIENTE" }, other.contactId);
    await insertObject(f, { placa: "ARQUIVADO" }, f.contactId, true);
    const link = await openLink(f);
    const choice = link.spec.fields.find((entry: any) => entry.id === "service_object_choice");
    expect(choice.options).toHaveLength(2);
    expect(Array.from(choice.options[0]).length).toBeLessThanOrEqual(100);
    const html = await (await f.h.fetch(new Request(`https://test/api/w/${link.code}`))).text();
    expect(html).not.toMatch(/OUTRO_CLIENTE|ARQUIVADO|SOMENTE_EQUIPE|OS2_CANAIS_PRIVADO/);
    const request = { item: "Visita", problem: "Conferir", service_object_choice: choice.options[0] };
    expect((await submit(f.h, link.code, { ...request, object_placa: "Outra placa" })).status).toBe(refused);
    await expectEmpty(f);
    expect((await submit(f.h, link.code, request)).status).toBe(200);
    expect(await one(env, "SELECT object_id FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ object_id: own });
    expect(await one(env, "SELECT row_version FROM os_objects WHERE id=?", own)).toEqual({ row_version: 1 });
    const tracked = await f.call(`/service-orders/conversation/${f.c.id}`);
    expect(tracked.data[0].object.identifier).toBe("X".repeat(120));
    expect(JSON.stringify(tracked)).not.toMatch(/SOMENTE_EQUIPE|OS2_CANAIS_PRIVADO/);
  }, 120000);

  it("campos inválidos, obrigatórios vazios, seleção alheia e privado forjado não consomem o link", async () => {
    const f = await setup(), other = await otherCustomer(f), objectId = await insertObject(f, { placa: "OUTRO_CLIENTE" }, other.contactId);
    const link = await openLink(f);
    // 422: a forma HTML persistida recusa; 409: o servidor do módulo recusa.
    const invalid: Array<[Record<string, string>, number]> = [
      [{ object_placa: "" }, refused], [{ object_ano: "" }, refused], [{ object_ano: "1.5" }, refused], [{ object_ano: "1e2" }, refused],
      [{ object_peso: "0.001" }, refused], [{ object_data: "2024-02-30" }, malformed], [{ object_revisado: "false" }, malformed], [{ object_choice: "b" }, malformed],
      [{ service_object_choice: objectId }, malformed], [{ service_object_choice: "OUTRO_CLIENTE" }, malformed],
      [{ object_privado: secret }, refused], [{ extra_segredo: secret }, refused], [{ contact_id: other.contactId }, refused],
    ];
    for (const [changed, status] of invalid) {
      const response = await submit(f.h, link.code, { ...answers(), ...changed });
      expect(response.status, JSON.stringify(changed)).toBe(status);
      expect(await response.text()).not.toContain(secret);
      expect((await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id))!.status).not.toBe("completed");
    }
    await expectEmpty(f);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
  }, 120000);

  it("revalida versão, arquivamento e titular depois da emissão, sem revelar objetos de outra área", async () => {
    const f = await setup(), own = await insertObject(f), other = await otherCustomer(f), foreign = await setup();
    const foreignObject = await insertObject(foreign, { placa: "AREA_EXTERNA" });
    const link = await openLink(f);
    const selected = link.spec.fields.find((entry: any) => entry.id === "service_object_choice").options[0];
    const request = { item: "Visita", problem: "Conferir", service_object_choice: selected };
    await exec(env, "UPDATE os_objects SET row_version=2 WHERE id=?", own);
    expect((await submit(f.h, link.code, request)).status).toBe(refused);
    await exec(env, "UPDATE os_objects SET row_version=1,archived=1 WHERE id=?", own);
    expect((await submit(f.h, link.code, request)).status).toBe(refused);
    await exec(env, "UPDATE os_objects SET archived=0,contact_id=? WHERE id=?", other.contactId, own);
    expect((await submit(f.h, link.code, request)).status).toBe(refused);
    await f.call(`/service-orders/conversation/${f.c.id}/objects/${own}`, "GET", undefined, uid(), 404);
    await f.call(`/service-orders/conversation/${f.c.id}/objects/${foreignObject}`, "GET", undefined, uid(), 404);
    await expectEmpty(f);
    await exec(env, "UPDATE conversations SET customer_link_state='ambiguous' WHERE id=?", f.c.id);
    expect((await submit(f.h, link.code, answers())).status).toBe(refused);
    await expect(f.h.run(() => customOpenForm(f.ctx, f.c, f.type, { trigger: "menu", actor: "system", sourceKey: uid() }))).rejects.toMatchObject({ code: "customer_required" });
  }, 120000);

  it("falha do lote não deixa objeto órfão nem número consumido; reenvio confirma a mesma abertura", async () => {
    const control = { failBatch: true }, h = harness(control), f = await setup(h), link = await openLink(f);
    expect((await submit(h, link.code, answers())).status).toBe(refused);
    await expectEmpty(f);
    for (const table of ["os_objects", "os_history", "os_counters", "os_type_counters"])
      expect(await one(env, `SELECT 1 present FROM ${table} WHERE profile_id=?`, f.profile)).toBeNull();
    control.failBatch = false;
    expect((await submit(h, link.code, answers())).status).toBe(200);
    expect(await one(env, "SELECT number FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ number: 1 });
  }, 120000);

  it("recupera respostas aceitas após commit, expiração e edição posterior sem reabrir ou duplicar", async ({ task }) => {
    await withOs2Time(1795000000000, async clock => {
      const adapters = createChannelAdapters(objectAdapters()), complete = adapters.prepareObjectWebStepCompletion!;
      let fail = true;
      adapters.prepareObjectWebStepCompletion = async (...args) => {
        const result = await complete(...args);
        if (result && !args[3]?.resumeOnly && fail) { fail = false; throw new Error("Falha depois do commit"); }
        return result;
      };
      const h = os2Harness(env, runtime, adapters), f = await setup(h), link = await openLink(f);
      attachBudget(task, h, { clock: "controlled" });
      expect((await submit(h, link.code, answers())).status).toBe(refused);
      const committed = await one(env, "SELECT * FROM os_orders WHERE profile_id=?", f.profile);
      expect(committed).toBeTruthy();
      expect((await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id))!.status).not.toBe("completed");
      await exec(env, "UPDATE os_orders SET item='Editado pela equipe',extra_json='{}',row_version=2 WHERE id=?", committed!.id);
      await exec(env, "UPDATE os_objects SET archived=1,row_version=2 WHERE id=?", committed!.object_id);
      const archivedType = { ...f.type, archived: true, revision: 2 };
      await perform(env, f.actor, f.profile, "settings", { os_work_types: [archivedType], settings_revision: await settingsRevision(env, f.profile) }, uid());
      clock.advance(2 * 86400000);
      // Marca explicitamente expirado, como o alarme; não depende de espera real.
      await exec(env, "UPDATE web_steps SET status='expired' WHERE id=?", link.step.id);
      expect((await submit(h, link.code, { item: "Pedido diferente" })).status).toBe(200);
      const saved = await one(env, "SELECT status,result FROM web_steps WHERE id=?", link.step.id);
      expect(saved!.status).toBe("completed");
      expect(json(saved!.result)).toMatchObject({ item: "Revisão", object_placa: "ABC1D23", extra_placa: "Medição da visita" });
      expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
      expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
      expect(await one(env, "SELECT COUNT(*) n FROM events WHERE profile_id=? AND kind='os.opened'", f.profile)).toEqual({ n: 1 });
    });
  }, 120000);

  it("sem recibo o link expirado recusa a abertura; após commit o titular revogado também é recusado", async () => {
    await withOs2Time(1795000000000, async clock => {
      const f = await setup(), link = await openLink(f);
      clock.advance(2 * 86400000);
      expect((await submit(f.h, link.code, answers())).status).not.toBe(200);
      await expectEmpty(f);
      expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    });
    const adapters = createChannelAdapters(objectAdapters()), complete = adapters.prepareObjectWebStepCompletion!;
    adapters.prepareObjectWebStepCompletion = async (...args) => { const result = await complete(...args); if (result && !args[3]?.resumeOnly) throw new Error("Falha após commit"); return result; };
    const h = os2Harness(env, runtime, adapters), f = await setup(h), link = await openLink(f);
    expect((await submit(h, link.code, answers())).status).toBe(refused);
    await exec(env, "UPDATE conversations SET customer_link_state='blocked' WHERE id=?", f.c.id);
    expect((await submit(h, link.code, answers())).status).toBe(refused);
    expect((await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id))!.status).not.toBe("completed");
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
  }, 120000);
});

describe("OS2 canais: consulta pública e custo legado", () => {
  it("bot só consulta seu titular; lista também objetos sem ordem e a paginação não cruza contexto", async ({ task }) => {
    const f = await setup(); attachBudget(task, f.h);
    const first = await insertObject(f), second = await insertObject(f, { placa: "SEGUNDO" });
    const other = await otherCustomer(f), foreign = await insertObject(f, { placa: "OUTRO" }, other.contactId);
    const page = await f.call(`/service-orders/conversation/${f.c.id}/objects?limit=1`);
    expect(page.data).toHaveLength(1); expect(page.next_cursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toMatch(/SOMENTE_EQUIPE|OS2_CANAIS_PRIVADO|OUTRO/);
    const next = await f.call(`/service-orders/conversation/${f.c.id}/objects?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`);
    expect([page.data[0].id, next.data[0].id].sort()).toEqual([first, second].sort());
    await f.call(`/service-orders/conversation/${other.c.id}/objects?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`, "GET", undefined, uid(), 400);
    await f.call(`/service-orders/conversation/${f.c.id}/objects?contact_id=${other.contactId}`, "GET", undefined, uid(), 400);
    const bot = uid(), run = uid();
    await exec(env, "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,input,created,updated) VALUES(?,?,?,'system',?,'consulta',?,?)", run, f.profile, bot, f.c.id, now(), now());
    const actor: Actor = { ...f.actor, kind: "app", id: `bot:${bot}`, scopes: ["conversations:read", "conversations:bound", "contacts:read"], bots: [bot], via: { kind: "bot", bot_id: bot, run_id: run, masked: false } };
    const read = (id: string, object_id?: string) => f.h.run(() => customerObjectsRead(f.ctx, actor,
      object_id ? "os.conversation.objects.get" : "os.conversation.objects.list", { params: { id, ...(object_id ? { object_id } : {}) }, query: {} }));
    const allowed = await read(f.c.id, first);
    expect(JSON.stringify(allowed)).not.toMatch(/SOMENTE_EQUIPE|OS2_CANAIS_PRIVADO/);
    await expect(read(other.c.id)).rejects.toMatchObject({ status: 404 });
    await expect(read(f.c.id, foreign)).rejects.toMatchObject({ status: 404 });
    const differentArea = await setup();
    await expect(read(differentArea.c.id)).rejects.toMatchObject({ status: 404 });
  }, 120000);

  it("identificação usa somente a cópia autorizada e sem objeto retorna vazio sem D1", () => {
    const row: WorkOrderRow = { id: "ordem", profile_id: "area", number: 1, status: "received", conversation_id: null, phone: "" };
    expect(publicObjectLabel(row)).toBe(""); expect(getWorkObjectContext(row, { kind: "customer" })).toBeUndefined();
    const type = objectType();
    const snapshot = { schema_version: 1, object_id: "opaque7d2a91", object_version: 1, captured_at: 100, origin: "opening", type, values: { placa: "ABC1D23", privado: secret, interno: "SOMENTE_EQUIPE" } };
    const linked = { ...row, object_id: snapshot.object_id, object_snapshot_json: JSON.stringify(snapshot) };
    expect(publicObjectLabel(linked)).toBe("ABC1D23");
    expect(JSON.stringify(getWorkObjectContext(linked, { kind: "bot" }))).not.toMatch(/SOMENTE_EQUIPE|OS2_CANAIS_PRIVADO/);
    type.fields[0].client_visible = false;
    linked.object_snapshot_json = JSON.stringify(snapshot);
    expect(publicObjectLabel(linked)).toBe("Veículo · 7D2A91");
    expect(JSON.stringify(getWorkObjectContext(linked, { kind: "customer" }))).not.toContain("ABC1D23");
  });

  it("modelo sem objeto conserva HTML, parsing, resultados e medições com tipos de objeto configurados", async ({ task }) => {
    const f = await setup(harness(), false);
    const measurements: Array<{ open: ReturnType<typeof os2CountingEnv>["count"]; parse: ReturnType<typeof os2CountingEnv>["count"] }> = [];
    const specs: unknown[] = [], parsed: unknown[] = [];
    attachBudget(task, f.h, { measurements, comparison: "mesma área, mesmo modelo sem objeto, antes/depois de configurar objetos" });
    for (const configured of [false, true]) {
      if (configured) await perform(env, f.actor, f.profile, "settings", { os_object_types: [objectType()], settings_revision: await settingsRevision(env, f.profile) }, uid());
      const counted = os2CountingEnv(env), ctx = modulesApi(counted.env, f.profile, "os");
      const link = await f.h.run(() => customOpenForm(ctx, f.c, f.type, { trigger: "menu", actor: "system", sourceKey: uid() }));
      const row = await one(env, "SELECT spec,ref_id FROM web_steps WHERE id=?", link.step.id);
      specs.push(json(row!.spec)); expect(json(row!.ref_id).schema_version).toBeUndefined();
      const reading = os2CountingEnv(env);
      parsed.push(await openingAnswers(modulesApi(reading.env, f.profile, "os"), link.step, { item: "Visita", problem: "Conferir", extra_placa: "Informação da ordem" }));
      measurements.push({ open: counted.count, parse: reading.count });
      const code = /\/api\/w\/([A-Za-z0-9]{16})/.exec(link.url!)![1];
      expect((await f.h.fetch(new Request(`https://test/api/w/${code}`), "legacy_get")).status).toBe(200);
      expect((await submit(f.h, code, { item: "Visita", problem: "Conferir", extra_placa: "Informação da ordem" }, "legacy_post")).status).toBe(200);
    }
    expect(specs[1]).toEqual(specs[0]); expect(parsed[1]).toEqual(parsed[0]);
    for (const phase of ["open", "parse"] as const) {
      expect(measurements[1][phase].sql).toEqual(measurements[0][phase].sql);
      expect(measurements[1][phase].statements).toBe(measurements[0][phase].statements);
      expect(measurements[1][phase].rows_written).toBe(measurements[0][phase].rows_written);
      for (const measurement of measurements) expect(os2DomainBudget(measurement[phase])).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
    }
    for (const invocation of f.h.report.filter(entry => entry.name.startsWith("legacy_")))
      for (const count of [invocation.worker, ...invocation.coordinators]) {
        expect(count.metadata_missing).toBe(0);
        expect(os2DomainBudget(count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
      }
    const orders = await all(env, "SELECT object_id,object_snapshot_json,extra_json FROM os_orders WHERE profile_id=?", f.profile);
    expect(orders).toHaveLength(2); expect(orders[0]).toEqual(orders[1]);
    expect(orders[0]).toMatchObject({ object_id: null, object_snapshot_json: null });
  }, 120000);
});
