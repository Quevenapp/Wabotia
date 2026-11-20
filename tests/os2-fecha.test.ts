// Aceite integrado da parte 2: nenhum adaptador é instalado pelo teste. As
// portas usadas são as de produção (objetos, requisitos/índices e canais).
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Env as AppEnv } from "../src/types";
import { conversation, perform, settingsRevision } from "../src/service";
import { resolveCustomer } from "../src/customer/ports";
import { modulesApi } from "../src/modules/api";
import { createOrder } from "../src/modules/os/store";
import { createProductionOs2Adapters } from "../src/modules/os/os2-production";
import { getWorkObjectContext, planStageTasks, publicObjectLabel, type Os2Adapters } from "../src/modules/os/os2-ports";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import { festasEventosTemplate } from "../src/area-templates/models/festas-eventos";
import type { AreaTemplate, CustomWorkType, ExtraValues, FieldIndexState, ServiceObjectSnapshot, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import type { WorkOrderRow } from "../src/modules/os/public";
import { customerConversation, grantSensitive, integrationFixture, type IntegrationFixture } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2DomainBudget, os2DomainSql } from "./os2-d1-counter";
import { os2Harness, type Os2Harness } from "./os2-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const field = (id: string, kind: WorkField["kind"], extra: Record<string, unknown> = {}): WorkField => ({ id, kind, label: id, help: "", required: false, client_visible: true, sensitive: false, ...extra }) as WorkField;
const globalId = (manifest: AreaTemplate, localId: string) => `area_${manifest.id}__${localId}`;
const config = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);
const count = async (table: string, profile: string, where = "") => (await one<{ n: number }>(env, `SELECT COUNT(*) n FROM ${table} WHERE profile_id=? ${where}`, profile))!.n;
const ADAPTER_KEYS: Array<keyof Os2Adapters> = [
  "openObjectForm", "prepareObjectOpening", "reauthorizeObjectOpening", "prepareLegacyObjectLink", "projectObjectSnapshot",
  "projectObjectForActor", "projectObjectPage", "prepareOrderRulesMutation", "planOrderFieldIndex", "queryOrdersByField",
  "objectCustomerContribution", "prepareObjectWebStepCompletion", "resumeObjectWebStepCompletion", "publicObjectLabel",
  "getWorkObjectContext", "planObjectContactMerge", "planStageTasks", "read", "command",
];

async function apply(f: IntegrationFixture, manifest: AreaTemplate) {
  const input = { template_id: manifest.id, selection: {
    work_type_ids: manifest.work_types.map(type => type.id), module_ids: ["os"], menus: false, departments: false,
    ticket_categories: false, vocabulary: false, texts: false, bot_suggestions: false,
  } };
  const preview = await f.call("/area-templates/preview", "POST", input);
  expect(preview.conflicts).toEqual([]);
  const applied = await f.call("/area-templates/apply", "POST", { ...input, preview_hash: preview.preview_hash });
  expect(applied.applied).toBe(true);
}
async function area(h: Os2Harness, manifests: AreaTemplate[] = []) {
  const f = await integrationFixture(h);
  for (const manifest of manifests) await apply(f, manifest);
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://test',?)", now());
  return f;
}
async function customer(h: Os2Harness, f: IntegrationFixture, phone: string) {
  const id = await customerConversation(h, f, phone), c = await conversation(env, id, f.profile);
  const ref = await resolveCustomer(env, c);
  expect(ref.state).toBe("ready");
  return { id, c, contactId: ref.contactId! };
}
const move = (f: IntegrationFixture, order: { id: string; version: number }, transition_id: string, status = 200) =>
  f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id }, uid(), status);
const patchExtra = (f: IntegrationFixture, order: { id: string; version: number }, extra: Record<string, unknown>, status = 200) =>
  f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra }, uid(), status);
async function build(f: IntegrationFixture, typeId: string) {
  let state: FieldIndexState = await f.call(`/service-orders/types/${typeId}/field-index/rebuild`, "POST", {});
  for (let commands = 0; state.status !== "ready"; commands++) {
    expect(commands).toBeLessThan(20);
    state = await f.call(`/service-orders/types/${typeId}/field-index/rebuild`, "POST", { generation: state.generation, cursor_number: state.cursor_number });
  }
  return state;
}
const filtered = (typeId: string, filter: unknown) => "/service-orders?" + new URLSearchParams({ type_id: typeId, field_filter: JSON.stringify(filter) });
async function openLink(f: IntegrationFixture, conversationId: string, typeId: string) {
  const step = await f.call(`/conversations/${conversationId}/actions`, "POST", { action: "service_order", send_form: true, type_id: typeId });
  const row = await one(env, "SELECT * FROM web_steps WHERE id=?", step.id);
  expect(row).toBeTruthy();
  const messages = await all(env, "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created DESC,rowid DESC", conversationId);
  const code = messages.map(message => /\/api\/w\/([A-Za-z0-9]{16})/.exec(message.payload)?.[1]).find(Boolean)!;
  expect(code).toBeTruthy();
  return { code, step, spec: json(row!.spec) };
}
function submit(h: Os2Harness, code: string, answers: Record<string, string>, label = "form_post") {
  return h.fetch(new Request(`https://test/api/w/${code}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://test" },
    body: new URLSearchParams(Object.entries(answers).map(([key, value]) => [`f_${key}`, value])).toString() }), label);
}
const vehicleSnapshot = (values: ExtraValues): ServiceObjectSnapshot => ({
  schema_version: 1, object_id: "opaque7d2a91", object_version: 1, captured_at: 100, origin: "opening",
  type: structuredClone(oficinaMecanicaTemplate.object_types![0]), values,
});

describe("OS2 fecha: integração estática, sem stubs", () => {
  it("compõe todas as portas de produção e as rotas/OpenAPI respondem sem instalação pelo teste", async () => {
    const production = createProductionOs2Adapters();
    for (const key of ADAPTER_KEYS) expect(typeof production[key], key).toBe("function");
    // Fora de qualquer harness a porta central já é a de produção; antes o stub lançava 501.
    const row: WorkOrderRow = { id: "ordem", profile_id: "area", number: 1, status: "received", conversation_id: null, phone: "",
      object_id: "opaque7d2a91", object_snapshot_json: JSON.stringify(vehicleSnapshot({ placa: "ABC1D23", cor: "Prata" })) };
    expect(publicObjectLabel(row)).toBe("ABC1D23");
    expect(getWorkObjectContext(row, { kind: "customer" })).toMatchObject({ identifier: "ABC1D23", object_version: 1 });
    expect(publicObjectLabel({ ...row, object_id: null, object_snapshot_json: null })).toBe("");
    // Checklist automático é contrato reservado da parte 3; nunca é chamado nesta parte.
    await expect(planStageTasks({} as never, {} as never)).rejects.toMatchObject({ status: 501 });

    const h = os2Harness(env, runtime), f = await area(h, [oficinaMecanicaTemplate]);
    const typeId = globalId(oficinaMecanicaTemplate, "at_veiculos");
    const types = await f.call("/service-orders/object-types");
    expect(types.data.map((type: ServiceObjectType) => type.id)).toEqual([globalId(oficinaMecanicaTemplate, "veiculo")]);
    expect(types.settings_revision).toBe(await settingsRevision(env, f.profile));
    expect(await f.call(`/service-orders/types/${typeId}/field-index`)).toMatchObject({ type_id: typeId, status: "building" });
    await f.call("/service-orders/objects", "GET", undefined, uid(), 400);
    await f.call(`/service-orders/objects/${uid()}`, "GET", undefined, uid(), 404);
    await f.call(`/service-orders/${uid()}/requirements`, "GET", undefined, uid(), 404);
    const spec = await (await h.fetch(new Request("https://test/api/openapi.json"), "openapi")).json() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    for (const suffix of ["/service-orders/object-types", "/service-orders/objects", "/service-orders/objects/{object_id}",
      "/service-orders/objects/{object_id}/private-fields", "/service-orders/objects/{object_id}/orders", "/service-orders/objects/{object_id}/archive",
      "/service-orders/{id}/object-link", "/service-orders/{id}/requirements", "/service-orders/types/{type_id}/field-index",
      "/service-orders/types/{type_id}/field-index/rebuild", "/service-orders/conversation/{id}/objects", "/service-orders/conversation/{id}/objects/{object_id}"])
      expect(paths.some(path => path.endsWith(suffix)), suffix).toBe(true);
    // A ficha do contato recebe a coleção do módulo pelo provedor de produção.
    const owner = await customer(h, f, "5511971000001");
    const object = await f.call("/service-orders/objects", "POST", { contact_id: owner.contactId, type_id: globalId(oficinaMecanicaTemplate, "veiculo"), values: { placa: "FICHA01" } });
    expect(object.version).toBe(1);
    const collection = await f.call(`/contacts/${owner.contactId}/modules/os/collections/objects`);
    expect(JSON.stringify(collection)).toContain(object.id);
  }, 180000);
});

describe("OS2 fecha: oficina, festa e consultoria", () => {
  it("oficina: veículo inline, duas visitas, requisito por etapa, edição do cadastro, último atendimento e filtro", async ({ task }) => {
    const h = os2Harness(env, runtime), f = await area(h, [oficinaMecanicaTemplate]), other = await area(h, [oficinaMecanicaTemplate]);
    const typeId = globalId(oficinaMecanicaTemplate, "at_veiculos"), vehicleType = globalId(oficinaMecanicaTemplate, "veiculo");
    const owner = await customer(h, f, "5511971000101"), neighbour = await customer(h, f, "5511971000102");
    const vehicle = { placa: "ABC1D23", marca_modelo: "Fiat Uno", ano: 2015, cor: "Prata", tipo_combustivel: "flex" };
    const first = { type_id: typeId, conversation_id: owner.id, item: "Revisão", problem: "Barulho no freio", notify: false,
      extra: { combustivel: "metade" }, object: { mode: "new", type_id: vehicleType, values: vehicle } };
    const key = uid();
    let visit1 = await f.call("/service-orders", "POST", first, key, 200, "oficina_abertura_inline");
    expect(visit1.object).toMatchObject({ identifier: "ABC1D23", origin: "opening", object_version: 1 });
    // Repetição: mesmo comando, mesma ordem e mesmo veículo.
    expect((await f.call("/service-orders", "POST", first, key)).id).toBe(visit1.id);
    await f.call("/service-orders", "POST", { ...first, problem: "Outro pedido" }, key, 409);
    const objectId = (await one<{ object_id: string }>(env, "SELECT object_id FROM os_orders WHERE id=?", visit1.id))!.object_id;
    const raceInput = { ...first, conversation: owner.c, object: { mode: "existing" as const, id: objectId, version: 1 }, extra: { quilometragem: 72000 },
      source: "panel" as const, actor: f.actor.id, authority: f.actor, sourceKey: uid() };
    const ctx = modulesApi(env, f.profile, "os");
    const race = await h.run(() => Promise.all([createOrder(ctx, raceInput), createOrder(ctx, raceInput)]));
    expect(race[0].order.id).toBe(race[1].order.id);
    expect(race.filter(result => result.created)).toHaveLength(1);
    const visit2Id = race[0].order.id;
    expect(await count("os_objects", f.profile)).toBe(1);
    expect(await count("os_orders", f.profile)).toBe(2);
    expect(await count("os2_receipts", f.profile, "AND operation='os.object.open'")).toBe(2);

    // Quilometragem é exigida ao sair da recepção; o rascunho parcial fica salvo sem avançar.
    const before = await all(env, "SELECT id FROM os_history WHERE order_id=?", visit1.id);
    expect((await move(f, visit1, "avaliar", 409)).error.code).toBe("missing_fields");
    expect(await all(env, "SELECT id FROM os_history WHERE order_id=?", visit1.id)).toEqual(before);
    expect((await f.call(`/service-orders/${visit1.id}/requirements?transition_id=avaliar`)).missing.map((entry: { field_id: string }) => entry.field_id)).toEqual(["quilometragem"]);
    visit1 = await patchExtra(f, visit1, { avarias_entrada: "Risco na porta" });
    visit1 = await patchExtra(f, visit1, { quilometragem: 60000 });
    visit1 = await move(f, visit1, "avaliar");
    expect(visit1.stage).toBe("analise");
    expect((await patchExtra(f, visit1, { quilometragem: null }, 409)).error.code).toBe("missing_fields");

    // Edição do cadastro atual não altera as cópias das visitas.
    const edited = await f.call(`/service-orders/objects/${objectId}`, "PATCH", { version: 1, values: { cor: "Azul" } });
    expect(edited.version).toBe(2);
    for (const id of [visit1.id, visit2Id]) {
      const row = (await one(env, "SELECT object_snapshot_json,extra_json FROM os_orders WHERE id=?", id))!;
      expect(json(row.object_snapshot_json).values).toMatchObject({ placa: "ABC1D23", cor: "Prata" });
    }
    expect(json((await one(env, "SELECT extra_json FROM os_orders WHERE id=?", visit1.id))!.extra_json)).toMatchObject({ quilometragem: 60000, combustivel: "metade" });
    expect(json((await one(env, "SELECT extra_json FROM os_orders WHERE id=?", visit2Id))!.extra_json)).toMatchObject({ quilometragem: 72000 });
    expect((await f.call(`/service-orders/${visit1.id}`)).object.values.cor).toBe("Prata");
    // Seleção com a versão antiga do cadastro é conflito, nunca captura silenciosa.
    await f.call("/service-orders", "POST", { ...first, object: { mode: "existing", id: objectId, version: 1 } }, uid(), 409);

    // Orçamento, aprovação e conclusão passam pela mesma barreira de requisitos.
    visit1 = await f.call(`/service-orders/${visit1.id}/quote`, "PUT", { items: [{ description: "Pastilhas", unit_cents: 25000 }] });
    visit1 = await f.call(`/service-orders/${visit1.id}/quote/send`, "POST", { notify: false });
    expect(visit1.stage).toBe("orcamento");
    const quoteVersion = (await one<{ quote_version: number }>(env, "SELECT quote_version FROM os_orders WHERE id=?", visit1.id))!.quote_version;
    visit1 = await f.call(`/service-orders/${visit1.id}/decision`, "POST", { decision: "approve", quote_version: quoteVersion });
    expect(visit1.stage).toBe("aprovado");
    visit1 = await move(f, visit1, "executar");
    expect((await move(f, visit1, "finalizar", 409)).error.code).toBe("missing_fields");
    visit1 = await patchExtra(f, visit1, { servico_executado: "Troca das pastilhas dianteiras" });
    visit1 = await move(f, visit1, "finalizar");
    visit1 = await move(f, visit1, "entregar");
    expect(visit1.status).toBe("delivered");

    const detail = await f.call(`/service-orders/objects/${objectId}`);
    expect(detail).toMatchObject({ id: objectId, version: 2, identifier: "ABC1D23" });
    expect(detail.values.cor).toBe("Azul");
    expect(detail.latest_completed).toMatchObject({ id: visit1.id, number: visit1.number });
    expect(detail.orders.data.map((order: { id: string }) => order.id).sort()).toEqual([visit1.id, visit2Id].sort());

    // Filtro próprio: índice construído por comandos explícitos e cópia da ordem, não o cadastro atual.
    await f.call(filtered(typeId, { ref: { scope: "order", field_id: "quilometragem" }, operator: "range", from: 70000, to: 80000 }), "GET", undefined, uid(), 409);
    const state = await build(f, typeId);
    expect(state.status).toBe("ready");
    const byKm = await f.call(filtered(typeId, { ref: { scope: "order", field_id: "quilometragem" }, operator: "range", from: 70000, to: 80000 }), "GET", undefined, uid(), 200, "oficina_filtro_km");
    expect(byKm.data.map((order: { id: string }) => order.id)).toEqual([visit2Id]);
    expect(byKm).toMatchObject({ counts: null, counts_scope: "not_computed" });
    const byPlate = await f.call(filtered(typeId, { ref: { scope: "object", field_id: "placa" }, operator: "eq", value: "abc1d23" }));
    expect(byPlate.data.map((order: { id: string }) => order.id).sort()).toEqual([visit1.id, visit2Id].sort());
    const list = await f.call(`/service-orders?type_id=${typeId}`);
    expect(list.data.find((order: { id: string }) => order.id === visit2Id).object.values.cor).toBe("Prata");

    // Isolamento entre clientes e áreas; placa nunca é prova de propriedade.
    await f.call("/service-orders", "POST", { ...first, conversation_id: neighbour.id, object: { mode: "existing", id: objectId, version: 2 } }, uid(), 404);
    expect((await f.call(`/service-orders/objects?contact_id=${neighbour.contactId}`)).data).toEqual([]);
    const samePlate = await f.call("/service-orders", "POST", { ...first, conversation_id: neighbour.id });
    expect(samePlate.object.object_id).not.toBe(objectId);
    await other.call(`/service-orders/objects/${objectId}`, "GET", undefined, uid(), 404);
    await other.call(`/service-orders/${visit1.id}`, "GET", undefined, uid(), 404);
    expect(await count("os_objects", other.profile)).toBe(0);
    // Cliente na conversa: só os próprios objetos e somente campos públicos da cópia.
    const own = await f.call(`/service-orders/conversation/${owner.id}/objects`);
    expect(own.data.map((entry: { id: string }) => entry.id)).toEqual([objectId]);
    const neighbourObjects = await f.call(`/service-orders/conversation/${neighbour.id}/objects`);
    expect(neighbourObjects.data.map((entry: { id: string }) => entry.id)).toEqual([samePlate.object.object_id]);
    const tracked = await f.call(`/service-orders/conversation/${owner.id}`);
    expect(tracked.data.map((order: { id: string }) => order.id).sort()).toEqual([visit1.id, visit2Id].sort());
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "oficina", invocations: h.report.filter(entry => entry.name.startsWith("oficina_")) };
  }, 240000);

  it("festa: Evento pelo formulário, decoração extra, conclusão condicionada e reutilização do evento", async () => {
    const h = os2Harness(env, runtime), f = await area(h, [festasEventosTemplate]);
    const typeId = globalId(festasEventosTemplate, "festa_evento");
    const owner = await customer(h, f, "5511971000201"), stranger = await customer(h, f, "5511971000202");
    const first = await openLink(f, owner.id, typeId);
    const page = await h.fetch(new Request(`https://test/api/w/${first.code}`), "festa_form_get");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Informar outro");
    expect(first.spec.fields.length).toBeLessThanOrEqual(30);
    const answers = { item: "Decoração", problem: "Festa infantil", terms: "on", service_object_choice: "Informar outro",
      object_nome: "Festa de novembro", object_data_festa: "2026-12-05", object_tema: "Circo", object_local: "Salão A",
      extra_escopo_solicitado: "Decoração completa do salão", extra_decoracao_extra: "Arco de balões dourados" };
    expect((await submit(h, first.code, answers, "festa_form_post")).status).toBe(200);
    expect(await one(env, "SELECT status FROM web_steps WHERE id=?", first.step.id)).toEqual({ status: "completed" });
    // Repetir o envio não cria outra ordem nem outro evento.
    expect((await submit(h, first.code, answers)).status).not.toBe(200);
    const rows = await all(env, "SELECT * FROM os_orders WHERE profile_id=?", f.profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_id).toBe(owner.contactId);
    expect(json(rows[0].object_snapshot_json).values).toEqual({ nome: "Festa de novembro", data_festa: "2026-12-05", tema: "Circo", local: "Salão A" });
    expect(json(rows[0].extra_json)).toEqual({ escopo_solicitado: "Decoração completa do salão", decoracao_extra: "Arco de balões dourados" });
    expect(await count("os_objects", f.profile)).toBe(1);

    // A conclusão exige o serviço executado; cancelar continuaria possível sem ele.
    let order = await f.call(`/service-orders/${rows[0].id}`);
    order = await move(f, order, "definir");
    order = await move(f, order, "executar");
    const before = await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id);
    expect((await move(f, order, "concluir", 409)).error.code).toBe("missing_fields");
    expect(await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id)).toEqual(before);
    order = await patchExtra(f, order, { servico_executado: "Salão decorado e conferido com o contratante" });
    order = await move(f, order, "concluir");
    expect(order).toMatchObject({ stage: "concluido", status: "delivered" });

    // Reutilização: o segundo formulário oferece o evento do titular e não recadastra.
    const second = await openLink(f, owner.id, typeId);
    const choice = second.spec.fields.find((entry: { id: string }) => entry.id === "service_object_choice");
    expect(choice.options).toHaveLength(2);
    const existing = choice.options.find((option: string) => option !== "Informar outro");
    expect((await submit(h, second.code, { item: "Complemento", problem: "Mesa de doces", terms: "on", service_object_choice: existing,
      extra_escopo_solicitado: "Mesa de doces temática" }, "festa_reuso")).status).toBe(200);
    const orders = await all(env, "SELECT object_id FROM os_orders WHERE profile_id=? ORDER BY number", f.profile);
    expect(orders.map(entry => entry.object_id)).toEqual([rows[0].object_id, rows[0].object_id]);
    expect(await count("os_objects", f.profile)).toBe(1);
    expect(await one(env, "SELECT row_version FROM os_objects WHERE id=?", rows[0].object_id)).toEqual({ row_version: 1 });
    // Outro contratante não vê o evento, nem pela conversa nem pelo formulário.
    expect((await f.call(`/service-orders/conversation/${stranger.id}/objects`)).data).toEqual([]);
    const strangerLink = await openLink(f, stranger.id, typeId);
    expect(strangerLink.spec.fields.find((entry: { id: string }) => entry.id === "service_object_choice").options).toEqual(["Informar outro"]);
    await f.call(`/service-orders/conversation/${stranger.id}/objects/${rows[0].object_id}`, "GET", undefined, uid(), 404);
  }, 240000);

  it("consultoria: sem objeto, exigência opcional por etapa e entrega, sem consultar o domínio de objetos", async ({ task }) => {
    const h = os2Harness(env, runtime), f = await area(h, [oficinaMecanicaTemplate]);
    const type: CustomWorkType = { ...motorWorkType(), id: "consultoria", revision: 1,
      labels: { ...motorWorkType().labels, singular: "Consultoria", plural: "Consultorias" },
      stage_field_rules: [{ field_id: "referencia", required_on_exit: ["entrada"] }] };
    const current = await config(f.profile);
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [...current.os_work_types, type], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const client = await customer(h, f, "5511971000301"), other = await customer(h, f, "5511971000302");
    h.report.length = 0;
    const body = { type_id: "consultoria", conversation_id: client.id, item: "Consultoria", problem: "Revisão de contrato", notify: false };
    await f.call("/service-orders", "POST", { ...body, object: { mode: "new", type_id: globalId(oficinaMecanicaTemplate, "veiculo"), values: {} } }, uid(), 400);
    const key = uid();
    let order = await f.call("/service-orders", "POST", body, key, 200, "consultoria_abertura");
    expect(order.object).toBeUndefined();
    expect((await f.call("/service-orders", "POST", body, key)).id).toBe(order.id);
    expect((await move(f, order, "iniciar", 409)).error.code).toBe("missing_fields");
    order = await patchExtra(f, order, { referencia: "Contrato 12/2026" });
    order = await move(f, order, "iniciar");
    order = await move(f, order, "revisar");
    order = await move(f, order, "entregar");
    expect(order.status).toBe("delivered");
    expect(order.object).toBeUndefined();
    expect((await f.call(`/service-orders?type_id=consultoria`)).data.map((entry: { id: string; object?: unknown }) => [entry.id, entry.object])).toEqual([[order.id, undefined]]);
    expect((await f.call(`/service-orders/conversation/${other.id}`)).data).toEqual([]);
    const classic = await f.call("/service-orders", "POST", { phone: "5511971000303", item: "Serviço clássico", problem: "Conferir", notify: false });
    expect(classic.type_id).toBe("service_order");
    expect(classic.object).toBeUndefined();
    for (const invocation of h.report) for (const measured of [invocation.worker, ...invocation.coordinators]) {
      expect(os2DomainBudget(measured), invocation.name).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
      expect(measured.sql.some(sql => os2DomainSql(sql)), invocation.name).toBe(false);
    }
    expect(await count("os_objects", f.profile)).toBe(0);
    expect(await count("os2_receipts", f.profile)).toBe(0);
    (task.meta as Record<string, unknown>).os2Budget = { scenario: "consultoria_sem_objeto", invocations: h.report };
  }, 240000);
});

describe("OS2 fecha: legado, falhas e retomada", () => {
  it("ordem antiga continua igual, sem conversão; vínculo manual é atômico, idempotente e não copia o privado", async () => {
    const h = os2Harness(env, runtime), f = await area(h), other = await area(h);
    for (const fixture of [f, other]) await perform(env, fixture.actor, fixture.profile, "module.set", { id: "os", enabled: true }, uid());
    const legacy = motorWorkType();
    legacy.fields.push(field("placa", "text", { label: "Placa", multiline: false, max_length: 10, sensitive: true, client_visible: false }),
      field("quilometragem", "integer", { label: "Quilometragem", min: 0, max: 9999999 }));
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [legacy], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const client = await customer(h, f, "5511971000401");
    let old = await f.call("/service-orders", "POST", { type_id: "projeto", conversation_id: client.id, item: "Visita antiga", problem: "Conferir", notify: false, extra: { quilometragem: 50000 } });
    await grantSensitive(h, f);
    await f.call(`/service-orders/${old.id}/private-fields`, "PATCH", { version: old.version, extra: { placa: "SIGILO123" } });
    old = await f.call(`/service-orders/${old.id}`);
    const classic = await f.call("/service-orders", "POST", { conversation_id: client.id, item: "Clássica", problem: "Conferir", notify: false });
    const columns = "type_snapshot_json,extra_json,object_id,object_snapshot_json,stage_required_json,row_version";
    const before = await one(env, `SELECT ${columns} FROM os_orders WHERE id=?`, old.id);
    expect(before).toMatchObject({ object_id: null, object_snapshot_json: null, stage_required_json: "[]" });

    // O modelo passa a usar objeto: nenhuma ordem existente é convertida.
    const vehicle: ServiceObjectType = { schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" },
      identifier_field_id: "placa", retired_field_ids: [], fields: [field("placa", "text", { label: "Placa", multiline: false, max_length: 10 }), field("cor", "text", { label: "Cor", multiline: false, max_length: 40 })] };
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [{ ...legacy, revision: 2, object_type_id: "veiculo" }], os_object_types: [vehicle], settings_revision: await settingsRevision(env, f.profile) }, uid());
    expect(await one(env, `SELECT ${columns} FROM os_orders WHERE id=?`, old.id)).toEqual(before);
    expect((await f.call(`/service-orders/${old.id}`)).object).toBeUndefined();
    expect(await count("os_objects", f.profile)).toBe(0);
    old = await patchExtra(f, old, { referencia: "Edição continua" });
    expect(old.object).toBeUndefined();

    // Prévia: placa privada antiga nunca é candidata ao identificador público.
    const preview = await f.call(`/service-orders/${old.id}/object-link`, "POST", { version: old.version, preview: true, object: { mode: "new", type_id: "veiculo", values: {} } });
    expect(preview.compatible_values).toEqual({});
    expect(JSON.stringify(preview)).not.toContain("SIGILO123");
    const beforeLink = (await one(env, "SELECT extra_json FROM os_orders WHERE id=?", old.id))!;
    const link = { version: old.version, object: { mode: "new", type_id: "veiculo", values: { placa: "NOV1A23" } } }, key = uid();
    const linked = await f.call(`/service-orders/${old.id}/object-link`, "POST", link, key);
    expect(await f.call(`/service-orders/${old.id}/object-link`, "POST", link, key)).toEqual(linked);
    await f.call(`/service-orders/${old.id}/object-link`, "POST", { ...link, version: old.version + 1 }, uid(), 409);
    const after = (await one(env, `SELECT ${columns} FROM os_orders WHERE id=?`, old.id))!;
    // O vínculo não move quilometragem nem o valor privado da visita.
    expect(after.extra_json).toBe(beforeLink.extra_json);
    expect(json(after.extra_json)).toMatchObject({ quilometragem: 50000, placa: "SIGILO123", referencia: "Edição continua" });
    expect(after.type_snapshot_json).toBe(before!.type_snapshot_json);
    const snapshot = json(after.object_snapshot_json) as ServiceObjectSnapshot;
    expect(snapshot).toMatchObject({ origin: "legacy_link", values: { placa: "NOV1A23" } });
    expect(JSON.stringify(snapshot)).not.toContain("SIGILO123");
    expect(await count("os_objects", f.profile)).toBe(1);
    expect(JSON.stringify(await f.call(`/service-orders/${old.id}`))).not.toContain("SIGILO123");
    // A clássica continua sem objeto e outra área não alcança a ordem.
    await f.call(`/service-orders/${classic.id}/object-link`, "POST", { version: classic.version, object: link.object }, uid(), 400);
    await other.call(`/service-orders/${old.id}/object-link`, "POST", link, uid(), 404);
    expect(await count("os_objects", f.profile)).toBe(1);
  }, 240000);

  it("falha injetada no lote da abertura não deixa órfão nem consome número; a repetição confirma uma vez", async () => {
    const production = createProductionOs2Adapters(), control = { fail: true };
    const h = os2Harness(env, runtime, {
      planOrderFieldIndex: async (ctx, input) => [...await production.planOrderFieldIndex(ctx, input),
        ...(control.fail ? [["SELECT json('os2_falha_injetada')", []] as [string, unknown[]]] : [])],
    });
    const f = await area(h, [oficinaMecanicaTemplate]), client = await customer(h, f, "5511971000501");
    const body = { type_id: globalId(oficinaMecanicaTemplate, "at_veiculos"), conversation_id: client.id, item: "Revisão", problem: "Conferir", notify: false,
      object: { mode: "new", type_id: globalId(oficinaMecanicaTemplate, "veiculo"), values: { placa: "FALHA01" } } }, key = uid();
    await f.call("/service-orders", "POST", body, key, 409);
    for (const table of ["os_orders", "os_objects", "os_object_history", "os2_receipts", "os_history", "os_counters", "os_type_counters", "os_order_field_index"])
      expect(await count(table, f.profile), table).toBe(0);
    control.fail = false;
    // O Coordinator fecha o recibo da chave com a resposta de erro: a mesma
    // chave devolve o mesmo 409 e continua sem efeito.
    await f.call("/service-orders", "POST", body, key, 409);
    for (const table of ["os_orders", "os_objects", "os2_receipts", "os_counters"])
      expect(await count(table, f.profile), table).toBe(0);
    // A retomada é uma intenção nova; ela confirma uma vez e usa o número 1.
    const retry = uid();
    const order = await f.call("/service-orders", "POST", body, retry);
    expect(order.number).toBe(1);
    expect((await f.call("/service-orders", "POST", body, retry)).id).toBe(order.id);
    expect(await count("os_objects", f.profile)).toBe(1);
    expect(await count("os_orders", f.profile)).toBe(1);
    expect(await count("os2_receipts", f.profile)).toBe(1);
  }, 180000);

  it("falha entre o commit da ordem e a conclusão do passo web é retomada pelo recibo, sem duplicar", async () => {
    const production = createProductionOs2Adapters();
    let fail = true;
    const h = os2Harness(env, runtime, {
      prepareObjectWebStepCompletion: async (...args) => {
        const result = await production.prepareObjectWebStepCompletion(...args);
        if (result && !args[3]?.resumeOnly && fail) { fail = false; throw new Error("Falha injetada depois do commit"); }
        return result;
      },
    });
    const f = await area(h, [festasEventosTemplate]), client = await customer(h, f, "5511971000601");
    const link = await openLink(f, client.id, globalId(festasEventosTemplate, "festa_evento"));
    const answers = { item: "Decoração", problem: "Evento", terms: "on", service_object_choice: "Informar outro", object_nome: "Evento retomado", extra_escopo_solicitado: "Montagem" };
    expect((await submit(h, link.code, answers)).status).toBe(409);
    expect(await count("os_orders", f.profile)).toBe(1);
    expect((await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id))!.status).not.toBe("completed");
    expect((await submit(h, link.code, answers)).status).toBe(200);
    expect(await one(env, "SELECT status FROM web_steps WHERE id=?", link.step.id)).toEqual({ status: "completed" });
    expect(await count("os_orders", f.profile)).toBe(1);
    expect(await count("os_objects", f.profile)).toBe(1);
    expect(await count("events", f.profile, "AND kind='os.opened'")).toBe(1);
  }, 180000);
});
