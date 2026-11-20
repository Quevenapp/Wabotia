import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, now, uid, type Env as AppEnv } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { perform, settingsRevision } from "../src/service";
import { createOrder, loadOrder } from "../src/modules/os/store";
import type { ServiceObjectSnapshot, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import type { Os2Adapters } from "../src/modules/os/os2-ports";
import { objectAdapters } from "../src/modules/os/objects/ports";
import { customerConversation, grantSensitive, integrationFixture } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2DomainBudget } from "./os2-d1-counter";
import { os2Harness, withOs2Time } from "./os2-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, run: any) => (runInDurableObject as any)(stub, run) };
const harness = (overrides: Partial<Os2Adapters> = {}) => os2Harness(env, runtime, { ...objectAdapters, ...overrides });
const textField = (id: string, overrides: Partial<WorkField> = {}): WorkField => ({ id, label: id, help: "", kind: "text", max_length: 120, multiline: false, required: false, client_visible: true, sensitive: false, ...overrides }) as WorkField;
const objectType = (): ServiceObjectType => ({ schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", fields: [textField("placa"), textField("cor"), textField("interno", { client_visible: false }), textField("privado", { sensitive: true, client_visible: false })], retired_field_ids: [] });
const opening = (contact_id?: string) => ({ type_id: "projeto", item: "Revisão", problem: "Conferir", phone: "5511960010203", notify: false, ...(contact_id ? { contact_id } : {}) });

async function contact(profile: string, namespace = "team") {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,?,'Cliente','cliente','panel','test','test',?,?)", id, profile, namespace, now(), now());
  return id;
}
async function setup(options: { object?: boolean; overrides?: Partial<Os2Adapters> } = {}) {
  const h = harness(options.overrides), f = await integrationFixture(h), type = motorWorkType();
  if (options.object !== false) type.object_type_id = "veiculo";
  type.fields.push({ id: "quilometragem", label: "Quilometragem", help: "", kind: "integer", min: 0, max: 9999999, required: false, client_visible: true, sensitive: false });
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], os_object_types: [objectType()], settings_revision: await settingsRevision(env, f.profile) }, uid());
  return { ...f, h, type, ctx: modulesApi(env, f.profile, "os"), owner: await contact(f.profile) };
}
async function seedObjects(profile: string, owner: string, count: number, archived = false) {
  const type = objectType();
  await env.DB.batch(Array.from({ length: count }, () => env.DB.prepare("INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,archived,created_by,updated_by,created,updated) VALUES(?,?,?,'veiculo',1,?,'{}',?,'test','test',?,?)").bind(uid(), profile, owner, JSON.stringify(type), Number(archived), now(), now())));
}
const savedCount = async (table: string, profile: string) => (await one<{ n: number }>(env, `SELECT COUNT(*) n FROM ${table} WHERE profile_id=?`, profile))!.n;

describe("OS2 objetos: comandos e planos reais", () => {
  it("cadastra isoladamente, repete sem duplicar e não usa placa como identidade ou autorização", async ({ task }) => {
    const f = await setup(), key = uid(), data = { contact_id: f.owner, type_id: "veiculo", values: { placa: "ABC1D23", cor: "Azul" } };
    const first = await f.call("/service-orders/objects", "POST", data, key);
    expect(first).toMatchObject({ id: expect.any(String), version: 1 });
    expect(await f.call("/service-orders/objects", "POST", data, key)).toEqual(first);
    await f.call("/service-orders/objects", "POST", { ...data, values: { placa: "OUTRA" } }, key, 409);
    await f.call("/service-orders/objects", "POST", { ...data, values: { placa: "ABC\n1D23" } }, uid(), 400);
    const samePlate = await f.call("/service-orders/objects", "POST", data);
    expect(samePlate.id).not.toBe(first.id);
    const receipt = await one<{ request_id: string }>(env, "SELECT request_id FROM os2_receipts WHERE profile_id=? AND object_id=? AND operation='os.objects.create'", f.profile, first.id);
    const normalized = await f.h.run(() => objectAdapters.command!(f.ctx, f.actor, "os.objects.create", { contact_id: f.owner, type_id: "veiculo", values: { cor: " Azul ", placa: " ABC1D23 " } }, { requestId: receipt!.request_id }));
    expect(normalized).toMatchObject({ id: first.id, version: 1 });
    const raceKey = uid(), run = () => objectAdapters.command!(f.ctx, f.actor, "os.objects.create", data, { requestId: raceKey });
    const raced = await f.h.run(() => Promise.all([run(), run()]));
    expect(raced[0]).toEqual(raced[1]);
    const anotherOwner = await contact(f.profile), foreign = await integrationFixture(f.h);
    await f.call("/service-orders/objects", "POST", { ...data, contact_id: await contact(foreign.profile) }, uid(), 404);
    await f.call("/service-orders/objects", "POST", { ...data, contact_id: await contact(f.profile, "app:outro") }, uid(), 404);
    await f.call("/service-orders", "POST", { ...opening(anotherOwner), object: { mode: "existing", id: first.id, version: 1 } }, uid(), 404);
    expect((await f.call(`/service-orders/objects?contact_id=${anotherOwner}`)).data).toEqual([]);
    expect(await savedCount("os_objects", f.profile)).toBe(3);
    expect(await savedCount("os_object_history", f.profile)).toBe(3);
    expect(await savedCount("os_orders", f.profile)).toBe(0);
    const audit = await all(env, "SELECT changed_fields_json FROM os_object_history WHERE profile_id=?", f.profile);
    expect(JSON.stringify(audit)).not.toMatch(/ABC1D23|Azul/);
    expect(f.h.report.some(report => report.coordinators.length > 0)).toBe(true);
    (task.meta as Record<string, unknown>).os2Budget = { scenarios: f.h.report };
  }, 120000);

  it("faz CAS de valores comuns/privados, arquiva e reautoriza cada repetição", async () => {
    const f = await setup(), create = { contact_id: f.owner, type_id: "veiculo", values: { placa: "PRIMEIRA" } };
    const object = await f.call("/service-orders/objects", "POST", create), route = `/service-orders/objects/${object.id}`;
    const updateKey = uid(), updated = await f.call(route, "PATCH", { version: 1, values: { cor: "Verde" } }, updateKey);
    expect(updated.version).toBe(2);
    await f.call(route, "PATCH", { version: 1, values: { cor: "Amarela" } }, uid(), 409);
    await f.call(route, "PATCH", { version: 2, contact_id: await contact(f.profile), values: {} }, uid(), 400);
    await f.call(`${route}/private-fields`, "GET", undefined, uid(), 403);
    await f.call(route, "PATCH", { version: 2, values: { privado: "SIGILO_OBJETO" } }, uid(), 400);
    await grantSensitive(f.h, f);
    const privateWrite = await f.call(`${route}/private-fields`, "PATCH", { version: 2, values: { privado: "SIGILO_OBJETO" } });
    expect(privateWrite.version).toBe(3);
    expect(privateWrite.changed_fields).toEqual(["privado"]);
    expect((await f.call(`${route}/private-fields`)).values).toEqual({ privado: "SIGILO_OBJETO" });
    expect(JSON.stringify(await f.call(route))).not.toContain("SIGILO_OBJETO");
    const archived = await f.call(`${route}/archive`, "POST", { version: 3, archived: true });
    expect(archived.version).toBe(4);
    expect((await f.call(`/service-orders/objects?contact_id=${f.owner}`)).data).toEqual([]);
    expect((await f.call(`/service-orders/objects?contact_id=${f.owner}&include_archived=1`)).data).toHaveLength(1);
    await f.call("/service-orders", "POST", { ...opening(f.owner), object: { mode: "existing", id: object.id, version: 4 } }, uid(), 409);
    expect(await f.call(route, "PATCH", { version: 1, values: { cor: "Verde" } }, updateKey)).toEqual(updated);
    const receipt = await one<{ request_id: string }>(env, "SELECT request_id FROM os2_receipts WHERE profile_id=? AND operation='os.objects.update' AND result_version=2", f.profile);
    const repeated = await f.h.run(() => objectAdapters.command!(f.ctx, f.actor, "os.objects.update", { object_id: object.id, version: 1, values: { cor: "Verde" } }, { requestId: receipt!.request_id }));
    expect(repeated).toMatchObject({ id: object.id, version: 4, mutation: { id: object.id, version: 2 } });
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=? AND profile_id=?", f.owner, f.profile);
    await expect(f.h.run(() => objectAdapters.command!(f.ctx, f.actor, "os.objects.update", { object_id: object.id, version: 1, values: { cor: "Verde" } }, { requestId: receipt!.request_id }))).rejects.toMatchObject({ status: 404 });
    await f.call("/service-orders/objects", "POST", create, uid(), 404);
    await f.call(route, "GET", undefined, uid(), 404);
    expect(await savedCount("os_object_history", f.profile)).toBe(4);
  }, 120000);

  it("abre inline em lote único, recupera resposta perdida e resolve corrida sem duplicar", async () => {
    const f = await setup(), request = { ...opening(f.owner), extra: { quilometragem: 60000 }, object: { mode: "new" as const, type_id: "veiculo", values: { placa: "INLINE" } } };
    const key = uid(), first = await f.call("/service-orders", "POST", request, key);
    const again = await f.call("/service-orders", "POST", request, key);
    expect(again.id).toBe(first.id);
    expect(again.object.object_id).toBe(first.object.object_id);
    const input = { ...request, source: "panel" as const, actor: f.actor.id, authority: f.actor, sourceKey: uid() };
    const race = await f.h.run(() => Promise.all([createOrder(f.ctx, input), createOrder(f.ctx, input)]));
    expect(race[0].order.id).toBe(race[1].order.id);
    expect(race.filter(result => result.created)).toHaveLength(1);
    expect(await savedCount("os_objects", f.profile)).toBe(2);
    expect(await savedCount("os_orders", f.profile)).toBe(2);
    expect(await savedCount("os2_receipts", f.profile)).toBe(2);
    expect((await all(env, "SELECT number FROM os_orders WHERE profile_id=? ORDER BY number", f.profile)).map(row => row.number)).toEqual([1, 2]);
    // Repetição aceita não é uma nova seleção, mesmo após arquivamento.
    await f.call(`/service-orders/objects/${first.object.object_id}/archive`, "POST", { version: 1, archived: true });
    expect((await f.call("/service-orders", "POST", request, key)).id).toBe(first.id);
  }, 120000);

  it("falha posterior ao plano reverte objeto, ordem, históricos, recibo e numeração", async () => {
    const f = await setup({ overrides: { prepareObjectOpening: async (ctx, input) => {
      const plan = await objectAdapters.prepareObjectOpening!(ctx, input);
      return { ...plan, after: [...plan.after, ["SELECT json('os2_object_test_rollback')", []] as [string, unknown[]]] };
    } } });
    const request = { ...opening(f.owner), object: { mode: "new", type_id: "veiculo", values: { placa: "ROLLBACK" } } };
    await f.call("/service-orders", "POST", request, uid(), 409);
    for (const table of ["os_objects", "os_object_history", "os_orders", "os_history", "os2_receipts", "os_counters", "os_type_counters"])
      expect(await savedCount(table, f.profile), table).toBe(0);
    const clean = harness(), response = await clean.fetch(f.request("/service-orders", "POST", request));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json() as { number: number }).number).toBe(1);
  }, 120000);

  it("confere novamente a versão do objeto existente dentro do lote da abertura", async () => {
    const f = await setup({ overrides: { prepareObjectOpening: async (ctx, input) => {
      const plan = await objectAdapters.prepareObjectOpening!(ctx, input);
      await exec(ctx.env, "UPDATE os_objects SET row_version=row_version+1,values_json=? WHERE profile_id=? AND id=?", '{"placa":"ALTERADA"}', ctx.profile, plan.object_id);
      return plan;
    } } });
    const object = await f.call("/service-orders/objects", "POST", { contact_id: f.owner, type_id: "veiculo", values: { placa: "ANTES" } });
    await f.call("/service-orders", "POST", { ...opening(f.owner), object: { mode: "existing", id: object.id, version: 1 } }, uid(), 409);
    expect(await savedCount("os_orders", f.profile)).toBe(0);
    expect(await savedCount("os_counters", f.profile)).toBe(0);
    expect((await f.call(`/service-orders/objects/${object.id}`)).values.placa).toBe("ALTERADA");
  }, 120000);

  it("recupera o recibo de cadastro depois de falhar antes de devolver a resposta", async () => {
    const f = await setup();
    let lost = false;
    const context = { ...f.ctx, publish: async (...args: Parameters<typeof f.ctx.publish>) => {
      if (args[0] === "os.object.created" && !lost) { lost = true; throw new ApiError(503, "response_lost", "Falha simulada após confirmar o cadastro."); }
      return f.ctx.publish(...args);
    } };
    const request = { contact_id: f.owner, type_id: "veiculo", values: { placa: "RECUPERAR" } }, key = uid();
    // O recibo da folha é testado diretamente. A classificação recuperável e
    // a reautorização do recibo HTTP do Coordinator pertencem à integração.
    const attempt = () => f.h.run(() => objectAdapters.command!(context, f.actor, "os.objects.create", request, { requestId: key }));
    await expect(attempt()).rejects.toMatchObject({ status: 503, code: "response_lost" });
    expect(await savedCount("os_objects", f.profile)).toBe(1);
    expect(await attempt()).toMatchObject({ version: 1 });
    expect(await savedCount("os_object_history", f.profile)).toBe(1);
    expect(await savedCount("os2_receipts", f.profile)).toBe(1);
  }, 120000);

  it("confere limites dentro do lote, inclusive criação concorrente e desarquivamento", async () => {
    const f = await setup();
    await seedObjects(f.profile, f.owner, 29);
    const command = (requestId: string) => objectAdapters.command!(f.ctx, f.actor, "os.objects.create", { contact_id: f.owner, type_id: "veiculo", values: { placa: requestId.slice(-6) } }, { requestId });
    const results = await f.h.run(() => Promise.allSettled([command(uid()), command(uid())]));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: "object_limit" });
    expect(await savedCount("os_objects", f.profile)).toBe(30);
    await seedObjects(f.profile, f.owner, 1, true);
    const archived = await one(env, "SELECT id FROM os_objects WHERE profile_id=? AND archived=1", f.profile);
    await f.call(`/service-orders/objects/${archived!.id}/archive`, "POST", { version: 1, archived: false }, uid(), 409);
    expect(await one(env, "SELECT archived,row_version FROM os_objects WHERE id=?", archived!.id)).toEqual({ archived: 1, row_version: 1 });
    const fullOwner = await contact(f.profile);
    await seedObjects(f.profile, fullOwner, 100, true);
    await f.call("/service-orders/objects", "POST", { contact_id: fullOwner, type_id: "veiculo", values: {} }, uid(), 409);
    expect((await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=? AND contact_id=?", f.profile, fullOwner))!.n).toBe(100);
  }, 120000);
});

describe("OS2 objetos: cópias, histórico e autorização de leitura", () => {
  it("preserva duas visitas e adota revisão explicitamente sem reescrever cópias", async () => {
    await withOs2Time(1795000000000, async clock => {
      const f = await setup(), object = await f.call("/service-orders/objects", "POST", { contact_id: f.owner, type_id: "veiculo", values: { placa: "VISITAS", cor: "Azul" } });
      const first = await f.call("/service-orders", "POST", { ...opening(f.owner), extra: { quilometragem: 60000 }, object: { mode: "existing", id: object.id, version: 1 } });
      const original = (await loadOrder(f.ctx, first.id)).object_snapshot_json;
      clock.advance(1000);
      await f.call(`/service-orders/objects/${object.id}`, "PATCH", { version: 1, values: { cor: "Vermelha" } });
      const second = await f.call("/service-orders", "POST", { ...opening(f.owner), extra: { quilometragem: 65000 }, object: { mode: "existing", id: object.id, version: 2 } });
      expect(first.object.values.cor).toBe("Azul");
      expect(second.object.values.cor).toBe("Vermelha");
      for (const order of [second, first]) {
        let moved = order;
        for (const transition_id of ["iniciar", "revisar", "entregar"]) {
          clock.advance(1000);
          moved = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: moved.version, transition_id });
        }
      }
      const detail = await f.call(`/service-orders/objects/${object.id}`);
      expect(detail.latest_completed).toMatchObject({ id: first.id, number: first.number, delivered_at: now() });
      const history = await f.call(`/service-orders/objects/${object.id}/orders`);
      expect(history.data.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
      expect(history.data.map((row: { extra: { quilometragem: number } }) => row.extra.quilometragem)).toEqual([65000, 60000]);
      const revised = { ...objectType(), revision: 2, fields: objectType().fields.map(field => field.id === "cor" ? { ...field, label: "Cor atual" } : field) };
      await f.call("/settings", "PUT", { os_object_types: [revised], settings_revision: await settingsRevision(env, f.profile) });
      const preview = await f.call(`/service-orders/objects/${object.id}`, "PATCH", { version: 2, adopt_revision: 2, preview: true });
      expect(preview.preview).toBe(true);
      expect((await f.call(`/service-orders/objects/${object.id}`)).type_revision).toBe(1);
      const adopted = await f.call(`/service-orders/objects/${object.id}`, "PATCH", { version: 2, adopt_revision: 2 });
      expect(adopted.version).toBe(3);
      expect((await f.call(`/service-orders/objects/${object.id}`)).type_revision).toBe(2);
      expect((await loadOrder(f.ctx, first.id)).object_snapshot_json).toBe(original);
      expect(json((await loadOrder(f.ctx, second.id)).object_snapshot_json).type.revision).toBe(1);
      // Registros encerrados legados sem data não inventam uma conclusão.
      await exec(env, "UPDATE os_orders SET delivered_at=NULL WHERE profile_id=? AND object_id=?", f.profile, object.id);
      expect((await f.call(`/service-orders/objects/${object.id}`)).latest_completed.delivered_at).toBeNull();
    });
  }, 120000);

  it("vincula ordem antiga encerrada sem mover medições ou copiar placa privada", async () => {
    await withOs2Time(1795001000000, async clock => {
      const f = await setup({ object: false });
      f.type.fields.push(textField("placa", { sensitive: true, client_visible: false }));
      f.type.revision++;
      await f.call("/settings", "PUT", { os_work_types: [f.type], settings_revision: await settingsRevision(env, f.profile) });
      await grantSensitive(f.h, f);
      let order = await f.call("/service-orders", "POST", { ...opening(), extra: { quilometragem: 60000 } });
      // O legado já possuía contato canônico; não o infere pela placa/telefone.
      await exec(env, "UPDATE os_orders SET contact_id=? WHERE id=? AND profile_id=?", f.owner, order.id, f.profile);
      await f.call(`/service-orders/${order.id}/private-fields`, "PATCH", { version: order.version, extra: { placa: "PLACA_PRIVADA_ANTIGA" } });
      order = await f.call(`/service-orders/${order.id}`);
      for (const transition_id of ["iniciar", "revisar", "entregar"]) order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id });
      const before = await loadOrder(f.ctx, order.id);
      f.type.revision++; f.type.object_type_id = "veiculo";
      await f.call("/settings", "PUT", { os_work_types: [f.type], settings_revision: await settingsRevision(env, f.profile) });
      clock.advance(5000);
      const key = uid(), request = { version: order.version, object: { mode: "new", type_id: "veiculo", values: {} } };
      const preview = await f.call(`/service-orders/${order.id}/object-link`, "POST", { ...request, preview: true });
      expect(preview).toMatchObject({ preview: true, order_id: order.id, version: order.version, compatible_values: {} });
      expect(preview.compatible_values).not.toHaveProperty("placa");
      expect(preview.compatible_values).not.toHaveProperty("quilometragem");
      expect(JSON.stringify(preview)).not.toContain("PLACA_PRIVADA_ANTIGA");
      expect(await savedCount("os_objects", f.profile)).toBe(0);
      expect(await savedCount("os2_receipts", f.profile)).toBe(0);
      const afterPreview = await loadOrder(f.ctx, order.id);
      expect(afterPreview.object_snapshot_json).toBe(before.object_snapshot_json);
      expect(afterPreview.type_snapshot_json).toBe(before.type_snapshot_json);
      expect(afterPreview.extra_json).toBe(before.extra_json);
      expect(afterPreview.row_version).toBe(before.row_version);
      const linked = await f.call(`/service-orders/${order.id}/object-link`, "POST", request, key);
      expect(await f.call(`/service-orders/${order.id}/object-link`, "POST", request, key)).toEqual(linked);
      const after = await loadOrder(f.ctx, order.id), captured = json(after.object_snapshot_json) as ServiceObjectSnapshot;
      expect(after.status).toBe("delivered");
      expect(after.extra_json).toBe(before.extra_json);
      expect(after.type_snapshot_json).toBe(before.type_snapshot_json);
      expect(captured.origin).toBe("legacy_link");
      expect(captured.captured_at).toBe(now());
      expect(captured.values).toEqual({});
      expect(JSON.stringify(await f.call(`/service-orders/objects/${after.object_id}`))).not.toContain("PLACA_PRIVADA_ANTIGA");
      expect(await savedCount("os_objects", f.profile)).toBe(1);
      await f.call(`/service-orders/${order.id}/object-link`, "POST", { ...request, version: after.row_version }, uid(), 409);
      const classic = await f.call("/service-orders", "POST", { ...opening(), type_id: "service_order" });
      await f.call(`/service-orders/${classic.id}/object-link`, "POST", { version: classic.version, object: { mode: "existing", id: after.object_id, version: 1 } }, uid(), 400);
    });
  }, 120000);

  it("sela a paginação da ficha e restringe conversa ao titular antes de listar", async () => {
    const f = await setup(), conversation = await customerConversation(f.h, f), c = await f.ctx.conversation(conversation, f.actor), ref = await f.ctx.customer(c);
    expect(ref.state).toBe("ready");
    if (ref.state !== "ready") throw new Error("Contato da conversa não confirmado pela fixture.");
    const owner = ref.contactId, foreignContact = await contact(f.profile);
    const objects = [];
    for (const plate of ["PUBLICA_A", "PUBLICA_B"]) objects.push(await f.call("/service-orders/objects", "POST", { contact_id: owner, type_id: "veiculo", values: { placa: plate, interno: "APENAS_EQUIPE" } }));
    const alien = await f.call("/service-orders/objects", "POST", { contact_id: foreignContact, type_id: "veiculo", values: { placa: "OUTRO_TITULAR" } });
    const first = await f.call(`/service-orders/objects?contact_id=${owner}&limit=1`);
    expect(first.data).toHaveLength(1); expect(first.next_cursor).toEqual(expect.any(String));
    const next = await f.call(`/service-orders/objects?contact_id=${owner}&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(new Set([...first.data, ...next.data].map(row => row.id)).size).toBe(2);
    await f.call(`/service-orders/objects?contact_id=${foreignContact}&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`, "GET", undefined, uid(), 400);
    const contribution = await f.call(`/contacts/${owner}/modules/os/collections/objects?limit=1`);
    expect(contribution.items).toHaveLength(1);
    expect(contribution.items[0].target.resource).toBe("service-objects");
    expect(contribution.nextCursor).toEqual(expect.any(String));
    await f.call(`/contacts/${foreignContact}/modules/os/collections/objects?limit=1&cursor=${encodeURIComponent(contribution.nextCursor)}`, "GET", undefined, uid(), 400);
    await f.call(`/service-orders/conversation/${conversation}/objects?contact_id=${foreignContact}`, "GET", undefined, uid(), 400);
    const publicList = await f.call(`/service-orders/conversation/${conversation}/objects`);
    expect(publicList.data.map((row: { id: string }) => row.id).sort()).toEqual(objects.map(row => row.id).sort());
    expect(JSON.stringify(publicList)).not.toMatch(/APENAS_EQUIPE|OUTRO_TITULAR|interno/);
    await f.call(`/service-orders/conversation/${conversation}/objects/${alien.id}`, "GET", undefined, uid(), 404);
    await grantSensitive(f.h, f);
    await f.call(`/service-orders/objects/${objects[0].id}/private-fields`, "PATCH", { version: 1, values: { privado: "SIGILO_AI_OPT_IN" } });
    const bot = { ...f.actor, via: { kind: "bot" as const, bot_id: uid(), run_id: uid(), masked: true } };
    const botRead = () => f.h.run(() => objectAdapters.read!(f.ctx, bot, "os.objects.get", { params: { object_id: objects[0].id }, query: {} }));
    await expect(botRead()).rejects.toMatchObject({ status: 404 });
    await f.call("/settings", "PUT", { os2_ai_access: { enabled: true, internal: true, sensitive: true }, settings_revision: await settingsRevision(env, f.profile) });
    expect(JSON.stringify(await botRead())).toContain("SIGILO_AI_OPT_IN");
    const customerRead = await f.h.run(() => objectAdapters.read!(f.ctx, bot, "os.conversation.objects.get", { params: { id: conversation, object_id: objects[0].id }, query: {} }));
    expect(JSON.stringify(customerRead)).not.toMatch(/SIGILO_AI_OPT_IN|APENAS_EQUIPE/);
    await expect(f.h.run(() => objectAdapters.command!(f.ctx, bot, "os.objects.private.update", { object_id: objects[0].id, conversation_id: conversation, version: 2, values: { privado: "NAO_AUTORIZADO" } }, { requestId: uid() }))).rejects.toMatchObject({ status: 403, code: "sensitive_forbidden" });
    const foreign = await setup();
    await foreign.call(`/service-orders/objects/${objects[0].id}`, "GET", undefined, uid(), 404);
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", owner);
    await f.call(`/service-orders/objects?contact_id=${owner}&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`, "GET", undefined, uid(), 404);
  }, 120000);

  it("projeta contexto comercial por lista explícita e IA conservadora sem consulta", () => {
    const snapshot: ServiceObjectSnapshot = { schema_version: 1, object_id: "objeto7d2a91", object_version: 3, captured_at: 1234, origin: "opening", type: objectType(), values: { placa: "PUBLICA", cor: "Azul", interno: "INTERNO", privado: "SIGILO" } };
    const row = { id: "ordem", profile_id: "area", number: 1, status: "received" as const, conversation_id: null, phone: "", object_id: snapshot.object_id, object_snapshot_json: JSON.stringify(snapshot) };
    const before = JSON.stringify(row);
    const staff = objectAdapters.getWorkObjectContext!(row, { kind: "staff" });
    expect(staff?.identifier).toBe("PUBLICA");
    expect(JSON.stringify(staff)).toContain("INTERNO");
    expect(JSON.stringify(staff)).not.toContain("SIGILO");
    const customer = objectAdapters.getWorkObjectContext!(row, { kind: "customer" });
    expect(JSON.stringify(customer)).not.toMatch(/INTERNO|SIGILO/);
    expect(JSON.stringify(objectAdapters.getWorkObjectContext!(row, { kind: "bot" }))).not.toMatch(/INTERNO|SIGILO/);
    const granted = objectAdapters.getWorkObjectContext!(row, { kind: "bot", ai_access: { enabled: true, internal: true, sensitive: true } });
    expect(JSON.stringify(granted)).toContain("SIGILO");
    const commercial = objectAdapters.getWorkObjectContext!(row, { kind: "commercial", allowed_field_ids: ["cor"] });
    expect(commercial?.allowed_fields.map(entry => entry.field.id)).toEqual(["cor"]);
    expect(JSON.stringify(commercial)).not.toMatch(/PUBLICA|INTERNO|SIGILO|object_snapshot_json/);
    expect(commercial?.equipment_text).toContain("Azul");
    expect(JSON.stringify(row)).toBe(before);
    expect(objectAdapters.getWorkObjectContext!({ ...row, object_id: null, object_snapshot_json: null }, { kind: "staff" })).toBeUndefined();
  });

  it("planeja junção sem commit próprio e preserva IDs e cópias no lote do chamador", async () => {
    const f = await setup(), target = await contact(f.profile);
    const order = await f.call("/service-orders", "POST", { ...opening(f.owner), object: { mode: "new", type_id: "veiculo", values: { placa: "JUNCAO" } } });
    const before = await loadOrder(f.ctx, order.id), input = { profile_id: f.profile, source_contact_id: f.owner, target_contact_id: target, namespace: "team" as const, actor: f.actor, merge_key: uid() };
    const plan = await f.h.run(() => objectAdapters.planObjectContactMerge!(f.ctx, input));
    expect(plan.object_ids).toEqual([before.object_id]);
    expect((await one(env, "SELECT contact_id FROM os_objects WHERE id=?", before.object_id))!.contact_id).toBe(f.owner);
    await expect(env.DB.batch([...plan.before, ...plan.after].map(([sql, args]) => env.DB.prepare(sql).bind(...args)))).rejects.toThrow();
    expect((await one(env, "SELECT contact_id FROM os_objects WHERE id=?", before.object_id))!.contact_id).toBe(f.owner);
    const commit = async (value: typeof plan) => env.DB.batch([
      ...value.before.map(([sql, args]) => env.DB.prepare(sql).bind(...args)),
      env.DB.prepare("UPDATE os_orders SET contact_id=? WHERE profile_id=? AND contact_id=?").bind(target, f.profile, f.owner),
      ...value.after.map(([sql, args]) => env.DB.prepare(sql).bind(...args)),
    ]);
    await commit(plan);
    const historyCount = await savedCount("os_object_history", f.profile);
    const replay = await f.h.run(() => objectAdapters.planObjectContactMerge!(f.ctx, input));
    await commit(replay);
    expect(await savedCount("os_object_history", f.profile)).toBe(historyCount);
    expect((await one(env, "SELECT contact_id FROM os_objects WHERE id=?", before.object_id))!.contact_id).toBe(target);
    const after = await loadOrder(f.ctx, order.id);
    expect(after.contact_id).toBe(target);
    expect(after.object_id).toBe(before.object_id);
    expect(after.object_snapshot_json).toBe(before.object_snapshot_json);
    const foreign = await integrationFixture(f.h);
    await expect(f.h.run(() => objectAdapters.planObjectContactMerge!(f.ctx, { ...input, target_contact_id: foreign.actor.id, merge_key: uid() }))).rejects.toMatchObject({ status: 404 });
  }, 120000);

  it("mantém modelo sem objeto e clássica sem consultas novas, inclusive repetição", async ({ task }) => {
    const f = await setup({ object: false });
    f.h.report.length = 0;
    for (const type_id of ["projeto", "service_order"]) {
      const key = uid(), input = { ...opening(), type_id };
      const created = await f.call("/service-orders", "POST", input, key);
      expect(created.object).toBeUndefined();
      expect((await f.call("/service-orders", "POST", input, key)).id).toBe(created.id);
      expect((await f.call(`/service-orders/${created.id}`)).object).toBeUndefined();
    }
    await f.call("/service-orders");
    for (const invocation of f.h.report) for (const count of [invocation.worker, ...invocation.coordinators])
      expect(os2DomainBudget(count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
    (task.meta as Record<string, unknown>).os2Budget = { scenarios: f.h.report, objects_configured: true, object_free_domain_delta: 0 };
    await f.call("/service-orders", "POST", { ...opening(), object: { mode: "new", type_id: "veiculo", values: {} } }, uid(), 400);
    expect(await savedCount("os_objects", f.profile)).toBe(0);
  }, 120000);
});
