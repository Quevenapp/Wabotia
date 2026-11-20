import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, now, uid, type Env as AppEnv } from "../src/types";
import { settingsRevision } from "../src/service";
import { validateAreaTemplate } from "../src/area-templates";
import { planObjectUpgrade } from "../src/area-templates/object-upgrades";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { clinicaVeterinariaTemplate } from "../src/area-templates/models/clinica-veterinaria";
import { engenheirosTemplate } from "../src/area-templates/models/engenheiros";
import { arquitetosTemplate } from "../src/area-templates/models/arquitetos";
import { construtorasTemplate } from "../src/area-templates/models/construtoras";
import { festasEventosTemplate } from "../src/area-templates/models/festas-eventos";
import { imobiliariaTemplate } from "../src/area-templates/models/exemplos";
import { makeSnapshot, resolveWorkFields } from "../src/modules/os/work-types";
import { isFieldFilled, jsonBytes, validateExtra, validateObjectType, validateObjectValues } from "../src/modules/os/validation";
import type { AreaTemplate, AreaTemplateSelection, CustomWorkType, ExtraValues, ServiceObjectSnapshot, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import type { ChildStatement } from "../src/modules/os/public";
import type { Os2Adapters } from "../src/modules/os/os2-ports";
import { customerConversation, grantSensitive, integrationFixture, type IntegrationFixture } from "./os-integration-fixture";
import { os2Harness, type Os2Harness } from "./os2-fixture";
import { os2DomainBudget } from "./os2-d1-counter";
import { motorWorkType } from "./os-motor-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const changedModels = [oficinaMecanicaTemplate, assistenciaTecnicaTemplate, clinicaVeterinariaTemplate, engenheirosTemplate, arquitetosTemplate, construtorasTemplate, festasEventosTemplate];
const selection = (manifest: AreaTemplate, ids = manifest.work_types.map(type => type.id)): AreaTemplateSelection => ({
  work_type_ids: ids, module_ids: ["os"], menus: false, departments: false, ticket_categories: false,
  vocabulary: false, texts: false, bot_suggestions: false,
});
const config = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);
const globalId = (manifest: AreaTemplate, localId: string) => `area_${manifest.id}__${localId}`;
async function apply(f: IntegrationFixture, manifest: AreaTemplate, ids?: string[], registered = true) {
  const input = { ...(registered ? { template_id: manifest.id } : { manifest }), selection: selection(manifest, ids) };
  const before = await config(f.profile);
  const preview = await f.call("/area-templates/preview", "POST", input);
  expect(preview.conflicts).toEqual([]);
  expect(preview.can_apply).toBe(true);
  expect(await config(f.profile)).toEqual(before);
  const body = { ...input, preview_hash: preview.preview_hash }, key = uid();
  const applied = await f.call("/area-templates/apply", "POST", body, key);
  expect(await f.call("/area-templates/apply", "POST", body, key)).toEqual(applied);
  return applied;
}
async function contact(profile: string, name: string) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team',?,?,'panel','test','test',?,?)", id, profile, name, name.toLowerCase(), now(), now());
  return id;
}
function sample(fields: WorkField[]): ExtraValues {
  return Object.fromEntries(fields.filter(field => !field.sensitive).map(field => {
    switch (field.kind) {
      case "text": return [field.id, "Exemplo".slice(0, field.max_length)];
      case "choice": return [field.id, field.options[0].id];
      case "date": return [field.id, field.min ?? field.max ?? "2026-11-20"];
      case "boolean": return [field.id, false];
      default: return [field.id, Math.max(field.min, Math.min(field.max, 0))];
    }
  }));
}

/** As folhas de objetos/regras ainda são paralelas. Simulam-se apenas suas portas;
 * validação, comandos HTTP, Coordinator, snapshot, CAS e batch são os reais. */
function simulatedLeaves(): Partial<Os2Adapters> {
  const adapters: Partial<Os2Adapters> = {
    async prepareObjectOpening(ctx, opening) {
      const contactId = opening.input.contact_id ?? opening.contact_id;
      const owner = await one(ctx.env, "SELECT id FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'", contactId, ctx.profile);
      if (!owner) throw new ApiError(404, "not_found", "Cliente não disponível.");
      const cfg = await ctx.settings();
      const type = (cfg.os_object_types as ServiceObjectType[]).find(type => type.id === opening.type.object_type_id)!;
      const request = opening.input.object!;
      const before: ChildStatement[] = [];
      let snapshot: ServiceObjectSnapshot;
      if (request.mode === "existing") {
        const object = await one(ctx.env, "SELECT * FROM os_objects WHERE id=? AND profile_id=? AND contact_id=? AND type_id=?", request.id, ctx.profile, contactId, type.id);
        if (!object) throw new ApiError(404, "not_found", "Objeto não disponível.");
        if (object.archived || object.row_version !== request.version) throw new ApiError(409, "version_conflict", "Objeto alterado.");
        snapshot = { schema_version: 1, object_id: object.id, object_version: object.row_version, captured_at: opening.at, origin: "opening", type: json(object.type_snapshot_json), values: json(object.values_json) };
        before.push(["SELECT CASE WHEN EXISTS(SELECT 1 FROM os_objects WHERE id=? AND profile_id=? AND contact_id=? AND type_id=? AND archived=0 AND row_version=?) THEN 1 ELSE json('os_version_conflict') END", [object.id, ctx.profile, contactId, type.id, request.version]]);
      } else {
        if (request.type_id !== type.id) throw new ApiError(400, "invalid_fields", "Tipo de objeto inválido.");
        snapshot = { schema_version: 1, object_id: uid(), object_version: 1, captured_at: opening.at, origin: "opening", type, values: validateObjectValues(type, request.values) };
        before.push(["INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [snapshot.object_id, ctx.profile, contactId, type.id, type.revision, JSON.stringify(type), JSON.stringify(snapshot.values), opening.input.actor, opening.input.actor, opening.at, opening.at]]);
      }
      resolveWorkFields(opening.type, snapshot.type);
      const after: ChildStatement[] = [["INSERT INTO os2_receipts(profile_id,actor_key,operation,request_id,payload_hash,object_id,order_id,result_version,created) VALUES(?,?,?,?,?,?,?,1,?)", [ctx.profile, opening.input.actor, "os.create", opening.input.sourceKey, "simulated-model-leaf", snapshot.object_id, opening.order_id, opening.at]]];
      return { contact_id: contactId!, object_id: snapshot.object_id, snapshot, before, after };
    },
    async reauthorizeObjectOpening(ctx, row, input) {
      if (row.profile_id !== ctx.profile || row.contact_id !== input.contact_id) throw new ApiError(404, "not_found", "Objeto não disponível.");
      if (!await one(ctx.env, "SELECT id FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'", row.contact_id, ctx.profile)) throw new ApiError(404, "not_found", "Cliente não disponível.");
    },
    projectObjectSnapshot(row, audience) {
      if (!row.object_id) return undefined;
      const snapshot: ServiceObjectSnapshot = json(row.object_snapshot_json);
      const fields = snapshot.type.fields.filter(field => !field.sensitive && (audience.kind === "staff" || field.client_visible));
      const identifier = fields.some(field => field.id === snapshot.type.identifier_field_id)
        ? String(snapshot.values[snapshot.type.identifier_field_id] ?? snapshot.type.labels.singular) : snapshot.type.labels.singular;
      return { schema_version: 1, object_id: snapshot.object_id, object_version: snapshot.object_version, captured_at: snapshot.captured_at, origin: snapshot.origin, identifier,
        type: { schema_version: 1, id: snapshot.type.id, revision: snapshot.type.revision, labels: snapshot.type.labels, identifier_field_id: snapshot.type.identifier_field_id, fields },
        values: Object.fromEntries(fields.filter(field => Object.hasOwn(snapshot.values, field.id)).map(field => [field.id, snapshot.values[field.id]])) };
    },
    async projectObjectForActor(ctx, actor, row) { return ctx.mayRead(actor, "contacts") ? adapters.projectObjectSnapshot!(row, { kind: "staff" }) : undefined; },
    async projectObjectPage(ctx, actor, rows) {
      const projections = new Map();
      if (ctx.mayRead(actor, "contacts")) for (const row of rows) {
        const projected = adapters.projectObjectSnapshot!(row, { kind: "staff" });
        if (projected) projections.set(row.id, projected);
      }
      return projections;
    },
    publicObjectLabel(row) { return adapters.projectObjectSnapshot!(row, { kind: "customer" })?.identifier ?? ""; },
    async prepareOrderRulesMutation(_ctx, input) {
      const required = new Set<string>(json(input.row.stage_required_json, []));
      if (input.sets.status === "cancelled") return { before: [], after: [] };
      const destination = String(input.sets.stage ?? input.row.stage);
      for (const rule of input.type.stage_field_rules ?? []) {
        if (rule.required_from_stage === destination || (!input.opening && destination !== input.row.stage && rule.required_on_exit?.includes(String(input.row.stage)))) required.add(rule.field_id);
      }
      const values = json(input.sets.extra_json ?? input.row.extra_json, {});
      if ([...required].some(id => !isFieldFilled(values, id))) throw new ApiError(409, "missing_fields", "Complete os campos da etapa.");
      return { before: [], after: [], ...(!input.preview && required.size ? { stage_required: [...required] } : {}) };
    },
    // Índices pertencem a os2-regras; aqui só se confere a definição exportada.
    planOrderFieldIndex: async () => [],
  };
  return adapters;
}

describe("OS2 modelos: definições declarativas e limites", () => {
  it("todos os exemplos cabem nos limites e mantêm referências, namespaces e privacidade válidos", () => {
    for (const manifest of changedModels) {
      const original = structuredClone(manifest), checked = validateAreaTemplate(manifest);
      expect(manifest).toEqual(original);
      expect(jsonBytes(checked)).toBeLessThanOrEqual(128 * 1024);
      expect(checked.object_types!.length).toBeLessThanOrEqual(20);
      for (const object of checked.object_types!) {
        expect(validateObjectType(object)).toEqual(object);
        expect(jsonBytes(object)).toBeLessThanOrEqual(8 * 1024);
        expect(jsonBytes(validateObjectValues(object, sample(object.fields)))).toBeLessThanOrEqual(16 * 1024);
      }
      for (const type of checked.work_types) {
        const object = checked.object_types!.find(object => object.id === type.object_type_id);
        const fields = resolveWorkFields(type, object);
        expect(fields.order.length + fields.object.length).toBeLessThanOrEqual(24);
        expect(jsonBytes(makeSnapshot(type))).toBeLessThanOrEqual(16 * 1024);
        expect((type.list_fields ?? []).filter(rule => rule.filter).length).toBeLessThanOrEqual(4);
        expect((type.list_fields ?? []).filter(rule => rule.column).length).toBeLessThanOrEqual(4);
        for (const rule of type.stage_field_rules ?? []) expect(type.fields.find(field => field.id === rule.field_id)?.sensitive).toBe(false);
        if (object) expect(jsonBytes({ schema_version: 1, object_id: "test", object_version: 1, captured_at: 0, origin: "opening", type: object, values: sample(object.fields) })).toBeLessThanOrEqual(32 * 1024);
      }
    }
  });

  it("recusa excesso de campos combinados, tipos, bytes e referências de etapas/objetos", () => {
    const invalid = structuredClone(festasEventosTemplate), type = invalid.work_types[0];
    const object = invalid.object_types![0];
    for (let index = type.fields.length; index < 25 - object.fields.length; index++) type.fields.push({ id: `extra_${index}`, label: "Extra", help: "", kind: "boolean", required: false, client_visible: true, sensitive: false });
    expect(() => validateAreaTemplate(invalid)).toThrowError(expect.objectContaining({ code: "invalid_template" }));
    const tooMany = { ...festasEventosTemplate, object_types: Array.from({ length: 21 }, (_, index) => ({ ...object, id: `objeto_${index}` })) };
    expect(() => validateAreaTemplate(tooMany)).toThrow();
    const large = { ...object, fields: Array.from({ length: 24 }, (_, index) => ({ id: index ? `campo_${index}` : object.identifier_field_id, label: "Á".repeat(80), help: "Á".repeat(240), kind: "text", multiline: false, max_length: 80, required: false, client_visible: true, sensitive: false })) };
    expect(() => validateObjectType(large)).toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => validateAreaTemplate({ ...festasEventosTemplate, object_types: [] })).toThrow();
    const badStage = structuredClone(festasEventosTemplate);
    badStage.work_types[0].stage_field_rules = [{ field_id: "servico_executado", required_from_stage: "ausente" }];
    expect(() => validateAreaTemplate(badStage)).toThrow();
  });

  it("separa combustível, medição e manutenção do veículo e mantém Animal/Imóvel compartilhados somente no manifesto", () => {
    for (const manifest of [oficinaMecanicaTemplate, assistenciaTecnicaTemplate]) {
      const type = manifest.work_types.find(type => type.id === "at_veiculos")!;
      const object = manifest.object_types!.find(object => object.id === type.object_type_id)!;
      expect(object.fields.map(field => field.id)).toEqual(expect.arrayContaining(["placa", "marca_modelo", "ano", "cor", "tipo_combustivel"]));
      for (const id of ["quilometragem", "combustivel", "ultima_manutencao", "avarias_entrada", "pecas_previstas", "servico_executado"]) {
        expect(type.fields.some(field => field.id === id)).toBe(true);
        expect(object.fields.some(field => field.id === id)).toBe(false);
      }
      const fuel = type.fields.find(field => field.id === "combustivel")!;
      expect(fuel).toMatchObject({ kind: "choice" });
      const halfTank = manifest.id === "assistencia_tecnica" ? "opcao_3" : "metade";
      expect(validateExtra([fuel], { combustivel: halfTank })).toEqual({ combustivel: halfTank });
      expect(fuel.kind === "choice" && fuel.options.find(option => option.id === halfTank)?.label).toBe("1/2");
      expect(() => validateExtra([fuel], { combustivel: "gasolina" })).toThrow();
      expect(type.fields.find(field => field.id === "ultima_manutencao")?.label).toBe("Última manutenção informada pelo cliente");
      expect(type.stage_field_rules).toContainEqual({ field_id: "quilometragem", required_on_exit: [type.initial_stage] });
      expect(type.stage_field_rules!.some(rule => rule.field_id === "servico_executado" && !!rule.required_from_stage)).toBe(true);
      expect(type.retired_field_ids).toEqual(expect.arrayContaining(["placa", "marca_modelo", "ano", "cor"]));
    }
    expect(new Set(clinicaVeterinariaTemplate.work_types.map(type => type.object_type_id))).toEqual(new Set(["animal"]));
    for (const manifest of [engenheirosTemplate, arquitetosTemplate, construtorasTemplate]) {
      expect(new Set(manifest.work_types.map(type => type.object_type_id))).toEqual(new Set(["imovel"]));
      expect(manifest.object_types).toHaveLength(1);
      const address = manifest.object_types![0].fields.find(field => field.id === "endereco")!;
      expect(address).toMatchObject({ sensitive: true, client_visible: false, required: false });
      expect(() => validateExtra([address], { endereco: "ENDERECO_PRIVADO" })).toThrow();
    }
    const electronics = assistenciaTecnicaTemplate.object_types!.find(object => object.id === "equipamento_eletronico")!;
    const serial = electronics.fields.find(field => field.id === "numero_serie")!;
    expect(serial).toMatchObject({ sensitive: true, client_visible: false, required: false });
    expect(electronics.identifier_field_id).not.toBe("numero_serie");
    expect(() => validateExtra([serial], { numero_serie: "SERIE_PRIVADA" })).toThrow();
    const appliance = assistenciaTecnicaTemplate.object_types!.find(object => object.id === "eletrodomestico")!;
    expect(appliance.fields.find(field => field.id === "numero_serie")).toMatchObject({ sensitive: false, client_visible: false, required: false });
    expect(imobiliariaTemplate.object_types).toBeUndefined();
    expect(imobiliariaTemplate.work_types.every(type => !type.object_type_id)).toBe(true);
    expect(imobiliariaTemplate.work_types[0].labels.customer_singular).toBe("Interessado");
    expect(festasEventosTemplate.work_types[0].features.tasks).toBe(true);
    expect(festasEventosTemplate.modules.agenda).toBe(false);
    expect(festasEventosTemplate.modules.reserva).toBe(false);
  });
});

describe("OS2 modelos: Worker e Coordinator reais", () => {
  it.each(changedModels)("aplica e exporta $id com referências locais remapeadas e sem criar dados de clientes", async manifest => {
    const h = os2Harness(env, runtime), f = await integrationFixture(h);
    const catalog = await f.call("/area-templates");
    expect(catalog.data).toContainEqual(expect.objectContaining({ id: manifest.id, version: manifest.version }));
    expect(await f.call(`/area-templates/${manifest.id}`)).toEqual(validateAreaTemplate(manifest));
    expect((await apply(f, manifest)).applied).toBe(true);
    const cfg = await config(f.profile);
    expect(cfg.os_work_types).toHaveLength(manifest.work_types.length);
    const required = new Set(manifest.work_types.flatMap(type => type.object_type_id ? [type.object_type_id] : []));
    expect(cfg.os_object_types).toHaveLength(required.size);
    for (const source of manifest.work_types) {
      const installed = cfg.os_work_types.find((type: CustomWorkType) => type.id === globalId(manifest, source.id));
      expect(installed).toEqual({ ...source, id: globalId(manifest, source.id), ...(source.object_type_id ? { object_type_id: globalId(manifest, source.object_type_id) } : {}) });
    }
    const exported: AreaTemplate = await f.call("/area-templates/export", "POST", { id: "reutilizavel", name: "Modelo reutilizável", type_ids: cfg.os_work_types.map((type: CustomWorkType) => type.id) });
    expect(validateAreaTemplate(exported)).toEqual(exported);
    expect(exported.object_types).toHaveLength(required.size);
    for (const [index, type] of exported.work_types.entries()) {
      expect(type.id).toBe(`tipo_${index + 1}`);
      expect(type.stage_field_rules).toEqual(manifest.work_types[index].stage_field_rules);
      expect(type.list_fields).toEqual(manifest.work_types[index].list_fields);
      if (type.object_type_id) expect(exported.object_types!.some(object => object.id === type.object_type_id)).toBe(true);
    }
    expect((await apply(f, manifest)).applied).toBe(false);
    expect(await config(f.profile)).toEqual(cfg);
    for (const table of ["os_objects", "os_orders", "os2_receipts"]) expect(await one(env, `SELECT COUNT(*) n FROM ${table} WHERE profile_id=?`, f.profile)).toEqual({ n: 0 });
    expect(h.report.some(invocation => invocation.worker_invoked && invocation.coordinators.length > 0)).toBe(true);
  }, 180000);

  it("seleciona modelos parcialmente, compartilha Animal, importa/exporta e preserva personalizações entre áreas", async () => {
    const h = os2Harness(env, runtime), first = await integrationFixture(h), second = await integrationFixture(h);
    const manifest = clinicaVeterinariaTemplate, selected = manifest.work_types[0];
    await apply(first, manifest, [selected.id]);
    let cfg = await config(first.profile);
    expect(cfg.os_work_types).toHaveLength(1);
    expect(cfg.os_object_types).toHaveLength(1);
    const object = cfg.os_object_types[0] as ServiceObjectType;
    object.labels.singular = "Animal da família"; object.revision++;
    cfg.os_work_types[0].labels.singular = "Atendimento da equipe";
    cfg.os_work_types[0].revision++;
    await first.call("/settings", "PUT", { os_work_types: cfg.os_work_types, os_object_types: cfg.os_object_types, settings_revision: await settingsRevision(env, first.profile) });
    await apply(first, manifest);
    cfg = await config(first.profile);
    expect(cfg.os_work_types).toHaveLength(3);
    expect(cfg.os_object_types).toHaveLength(1);
    expect(cfg.os_work_types[0].labels.singular).toBe("Atendimento da equipe");
    expect(cfg.os_object_types[0]).toEqual(object);
    const partial: AreaTemplate = await first.call("/area-templates/export", "POST", { id: "animal_reutilizavel", name: "Animal reutilizável", type_ids: [cfg.os_work_types[0].id] });
    expect(partial.work_types).toHaveLength(1);
    expect(partial.object_types).toHaveLength(1);
    expect(partial.work_types[0].object_type_id).toBe("objeto_1");
    await second.call("/area-templates/export", "POST", { id: "incorreto", name: "Outra área", type_ids: [cfg.os_work_types[0].id] }, uid(), 404);
    await apply(second, partial, undefined, false);
    const imported = await config(second.profile);
    expect(imported.os_work_types[0].labels.singular).toBe("Atendimento da equipe");
    expect(imported.os_object_types[0].labels.singular).toBe("Animal da família");
    expect(imported.os_work_types[0].object_type_id).toBe("area_animal_reutilizavel__objeto_1");
    expect(imported.os_object_types[0].id).not.toBe(object.id);
    await apply(second, manifest, [selected.id]);
    expect((await config(second.profile)).os_object_types).toHaveLength(2);
    expect(await config(first.profile)).toEqual(cfg);
  }, 180000);

  it("a seleção de roupas na assistência não instala tipos de objeto que o modelo não usa", async () => {
    const h = os2Harness(env, runtime), f = await integrationFixture(h);
    await apply(f, assistenciaTecnicaTemplate, ["at_roupas"]);
    const cfg = await config(f.profile);
    expect(cfg.os_work_types).toHaveLength(1);
    expect(cfg.os_work_types[0].object_type_id).toBeUndefined();
    expect(cfg.os_object_types ?? []).toEqual([]);
    const exported = await f.call("/area-templates/export", "POST", { id: "roupas", name: "Roupas", type_ids: [cfg.os_work_types[0].id] });
    expect(exported.object_types).toBeUndefined();
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
  }, 180000);

  it("abre visitas para clientes distintos, reusa o Evento e repete comandos sem duplicar objetos ou ordens", async () => {
    const h = os2Harness(env, runtime, simulatedLeaves()), f = await integrationFixture(h), other = await integrationFixture(h);
    await apply(f, festasEventosTemplate);
    await apply(other, festasEventosTemplate);
    const cfg = await config(f.profile), type: CustomWorkType = cfg.os_work_types[0], object: ServiceObjectType = cfg.os_object_types[0];
    const owner = await contact(f.profile, "Contratante A"), another = await contact(f.profile, "Contratante B"), foreign = await contact(other.profile, "Outro contratante");
    const values = { ...sample(object.fields), [object.identifier_field_id]: "Evento de novembro" };
    const extra = Object.fromEntries(type.fields.filter(field => field.required).map(field => [field.id, sample([field])[field.id]]));
    const body = { type_id: type.id, contact_id: owner, phone: "5511970001001", item: "Decoração", problem: "Escopo combinado", notify: false, extra, object: { mode: "new", type_id: object.id, values } };
    const key = uid(), order = await f.call("/service-orders", "POST", body, key);
    expect((await f.call("/service-orders", "POST", body, key)).id).toBe(order.id);
    const row = (await one(env, "SELECT * FROM os_orders WHERE id=?", order.id))!;
    expect(row.contact_id).toBe(owner);
    expect(json(row.object_snapshot_json).values).toEqual(values);
    expect(json(row.extra_json)).toEqual(extra);
    await f.call("/service-orders", "POST", { ...body, problem: "Mudou o pedido" }, key, 409);
    const existing = { mode: "existing", id: row.object_id, version: 1 };
    await f.call("/service-orders", "POST", { ...body, contact_id: another, object: existing }, uid(), 404);
    await f.call("/service-orders", "POST", { ...body, contact_id: foreign }, uid(), 404);
    await other.call("/service-orders", "POST", { ...body, contact_id: foreign, object: existing }, uid(), 404);
    const complement = await f.call("/service-orders", "POST", { ...body, item: "Complementação", object: existing });
    expect(complement.object.object_id).toBe(row.object_id);
    expect(complement.id).not.toBe(order.id);
    const sameIdentifier = await f.call("/service-orders", "POST", { ...body, contact_id: another, phone: "5511970001002" });
    expect(sameIdentifier.object.object_id).not.toBe(row.object_id);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 2 });
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 3 });
    expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", other.profile)).toEqual({ n: 0 });
    const exported = await f.call("/area-templates/export", "POST", { id: "evento_exportado", name: "Evento exportado", type_ids: [type.id] });
    for (const value of ["Evento de novembro", owner, another, row.object_id, order.id]) expect(JSON.stringify(exported)).not.toContain(value);
  }, 180000);

  it("usa as regras declaradas na recepção e conclusão sem criar tarefas automáticas", async () => {
    const h = os2Harness(env, runtime, simulatedLeaves()), f = await integrationFixture(h);
    await apply(f, oficinaMecanicaTemplate);
    await apply(f, festasEventosTemplate);
    const cfg = await config(f.profile), owner = await contact(f.profile, "Cliente");
    const workshop: CustomWorkType = cfg.os_work_types.find((type: CustomWorkType) => type.id === globalId(oficinaMecanicaTemplate, "at_veiculos"));
    const vehicle: ServiceObjectType = cfg.os_object_types.find((type: ServiceObjectType) => type.id === workshop.object_type_id);
    const created = await f.call("/service-orders", "POST", { type_id: workshop.id, contact_id: owner, phone: "5511970002001", item: "Revisão", problem: "Conferir", notify: false, extra: { combustivel: "metade", ultima_manutencao: "2025-01-10" }, object: { mode: "new", type_id: vehicle.id, values: sample(vehicle.fields) } });
    const reception = workshop.transitions.find(transition => transition.from === workshop.initial_stage && workshop.stages.find(stage => stage.id === transition.to)!.base_status !== "cancelled")!;
    expect((await f.call(`/service-orders/${created.id}/stage`, "POST", { version: created.version, transition_id: reception.id }, uid(), 409)).error.code).toBe("missing_fields");
    const filled = await f.call(`/service-orders/${created.id}`, "PATCH", { version: created.version, extra: { quilometragem: 0 } });
    const moved = await f.call(`/service-orders/${created.id}/stage`, "POST", { version: filled.version, transition_id: reception.id });
    await f.call(`/service-orders/${created.id}`, "PATCH", { version: moved.version, extra: { quilometragem: null } }, uid(), 409);
    expect(json((await one(env, "SELECT extra_json FROM os_orders WHERE id=?", created.id))!.extra_json)).toMatchObject({ quilometragem: 0, combustivel: "metade", ultima_manutencao: "2025-01-10" });
    const event: CustomWorkType = cfg.os_work_types.find((type: CustomWorkType) => type.id === globalId(festasEventosTemplate, "festa_evento"));
    const eventObject: ServiceObjectType = cfg.os_object_types.find((type: ServiceObjectType) => type.id === event.object_type_id);
    const required = event.stage_field_rules!.find(rule => rule.field_id === "servico_executado")!.required_from_stage!;
    const queue: Array<{ stage: string; path: string[] }> = [{ stage: event.initial_stage, path: [] }], visited = new Set<string>();
    let path: string[] | undefined;
    while (queue.length) {
      const current = queue.shift()!;
      if (current.stage === required) { path = current.path; break; }
      if (visited.has(current.stage)) continue;
      visited.add(current.stage);
      for (const transition of event.transitions.filter(transition => transition.from === current.stage && transition.kind === "manual")) queue.push({ stage: transition.to, path: [...current.path, transition.id] });
    }
    expect(path?.length).toBeGreaterThan(0);
    let order = await f.call("/service-orders", "POST", { type_id: event.id, contact_id: owner, phone: "5511970002001", item: "Decoração", problem: "Montagem", notify: false, extra: Object.fromEntries(event.fields.filter(field => field.required).map(field => [field.id, sample([field])[field.id]])), object: { mode: "new", type_id: eventObject.id, values: sample(eventObject.fields) } });
    for (const transition of path!.slice(0, -1)) order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: transition });
    const before = await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id);
    await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: path!.at(-1) }, uid(), 409);
    expect(await all(env, "SELECT id FROM os_history WHERE order_id=?", order.id)).toEqual(before);
    order = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { servico_executado: "Decoração montada e conferida" } });
    order = await f.call(`/service-orders/${order.id}/stage`, "POST", { version: order.version, transition_id: path!.at(-1) });
    expect(order.stage).toBe(required);
    expect(await one(env, "SELECT COUNT(*) n FROM os_tasks WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
  }, 180000);

  it("preserva placa sensível antiga e combustível na ordem, sem conversão automática nem alteração do snapshot", async () => {
    const h = os2Harness(env, runtime), f = await integrationFixture(h);
    const source = oficinaMecanicaTemplate, legacy = structuredClone(source), work = legacy.work_types[0];
    const vehicle = legacy.object_types!.find(object => object.id === work.object_type_id)!;
    const moved = vehicle.fields.filter(field => ["placa", "marca_modelo", "ano", "cor"].includes(field.id));
    work.fields.push(...structuredClone(moved));
    Object.assign(work.fields.find(field => field.id === "placa")!, { sensitive: true, client_visible: false });
    work.retired_field_ids = work.retired_field_ids.filter(id => !moved.some(field => field.id === id));
    delete work.object_type_id; delete work.stage_field_rules; delete work.list_fields; delete legacy.object_types;
    legacy.version--;
    await apply(f, legacy, undefined, false);
    await grantSensitive(h, f);
    const opened = await f.call("/service-orders", "POST", { type_id: globalId(legacy, work.id), phone: "5511970003001", item: "Visita antiga", problem: "Conferir", notify: false, extra: { combustivel: "metade", quilometragem: 60000, ultima_manutencao: "2024-03-20" } });
    await f.call(`/service-orders/${opened.id}/private-fields`, "PATCH", { version: opened.version, extra: { placa: "SIGILO123" } });
    const before = await one(env, "SELECT type_snapshot_json,extra_json,object_id,object_snapshot_json FROM os_orders WHERE id=?", opened.id);
    const planned = planObjectUpgrade({ current: work, previous_standard: work, standard: source.work_types[0], object_type: source.object_types![0] });
    expect(planned.can_apply).toBe(false);
    expect(planned.conflicts).toContainEqual(expect.objectContaining({ code: "sensitive_field" }));
    expect(planned.moved_fields).not.toContain("placa");
    expect(planned.work_type.fields.find(field => field.id === "placa")).toMatchObject({ sensitive: true, client_visible: false });
    expect(planned.retained_fields).toEqual(expect.arrayContaining(["combustivel", "quilometragem", "ultima_manutencao"]));
    const personalized = structuredClone(work);
    const brand = personalized.fields.find(field => field.id === "marca_modelo")!;
    if (brand.kind !== "text") throw new Error("Marca/modelo precisa continuar textual.");
    brand.max_length = 100;
    const conflict = planObjectUpgrade({ current: personalized, previous_standard: work, standard: source.work_types[0], object_type: source.object_types![0], resolutions: { placa: "keep" } });
    expect(conflict.conflicts).toContainEqual(expect.objectContaining({ code: "personalized_field" }));
    expect(conflict.moved_fields).not.toContain("marca_modelo");
    const kept = planObjectUpgrade({ current: personalized, previous_standard: work, standard: source.work_types[0], object_type: source.object_types![0], resolutions: { placa: "keep", marca_modelo: "keep" } });
    expect(kept.can_apply, JSON.stringify(kept.conflicts)).toBe(true);
    expect(kept.work_type.fields.find(field => field.id === "marca_modelo")).toMatchObject({ max_length: 100 });
    await apply(f, source);
    const cfg = await config(f.profile);
    expect(cfg.os_work_types[0].object_type_id).toBeUndefined();
    expect(cfg.os_work_types[0].fields.find((field: WorkField) => field.id === "placa")).toMatchObject({ sensitive: true, client_visible: false });
    expect(await one(env, "SELECT type_snapshot_json,extra_json,object_id,object_snapshot_json FROM os_orders WHERE id=?", opened.id)).toEqual(before);
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    expect(JSON.stringify(await f.call(`/service-orders/${opened.id}`))).not.toContain("SIGILO123");
    const exported = await f.call("/area-templates/export", "POST", { id: "legado_privado", name: "Legado privado", type_ids: [cfg.os_work_types[0].id] });
    expect(exported.work_types[0].fields.find((field: WorkField) => field.id === "placa").sensitive).toBe(true);
    expect(JSON.stringify(exported)).not.toContain("SIGILO123");
    expect(exported.object_types).toBeUndefined();
  }, 180000);

  it("importa manifesto antigo de consultoria e conserva abertura, edição, lista e conversa sem objeto", async ({ task }) => {
    const work = motorWorkType();
    work.labels.singular = "Consultoria"; work.labels.plural = "Consultorias";
    const manifest: AreaTemplate = { schema_version: 1, id: "consultoria", version: 1, name: "Consultoria", description: "Consultoria sem objeto.", work_types: [work], modules: { os: true }, vocabulary: { collection_label: "Consultorias", customer_singular: "Cliente", customer_plural: "Clientes" }, departments: [], ticket_categories: [], menus: [], texts: {}, bot: { instructions: "", allowed_operations: [], denied_operations: [], suggested_roles: [] }, manual_steps: [] };
    const h: Os2Harness = os2Harness(env, runtime), f = await integrationFixture(h), other = await integrationFixture(h);
    await apply(f, manifest, undefined, false);
    await apply(f, festasEventosTemplate);
    await apply(other, manifest, undefined, false);
    const conversation = await customerConversation(h, f, "5511970004001"), another = await customerConversation(h, f, "5511970004002");
    h.report.length = 0;
    const body = { type_id: globalId(manifest, work.id), conversation_id: conversation, item: "Consultoria", problem: "Revisão de escopo", extra: { referencia: "Solicitação A" }, notify: false };
    const key = uid(), order = await f.call("/service-orders", "POST", body, key);
    expect(order.object).toBeUndefined();
    expect((await f.call("/service-orders", "POST", body, key)).id).toBe(order.id);
    const edited = await f.call(`/service-orders/${order.id}`, "PATCH", { version: order.version, extra: { referencia: "Escopo conferido" } });
    expect(edited.object).toBeUndefined();
    const list = await f.call(`/service-orders?type_id=${body.type_id}`);
    expect(list.data.map((entry: { id: string }) => entry.id)).toEqual([order.id]);
    expect(list.data[0].object).toBeUndefined();
    expect((await f.call(`/service-orders/conversation/${conversation}`)).data.map((entry: { id: string }) => entry.id)).toEqual([order.id]);
    expect((await f.call(`/service-orders/conversation/${another}`)).data).toEqual([]);
    await other.call(`/service-orders/${order.id}`, "GET", undefined, uid(), 404);
    const classic = await f.call("/service-orders", "POST", { phone: "5511970004003", item: "Serviço clássico", problem: "Conferir", notify: false });
    expect(classic.type_id).toBe("service_order");
    expect(classic.object).toBeUndefined();
    for (const invocation of h.report) for (const count of [invocation.worker, ...invocation.coordinators]) expect(os2DomainBudget(count)).toEqual({ statements: 0, rows_read: 0, rows_written: 0 });
    (task.meta as Record<string, unknown>).os2Modelos = { scenario: "consultoria_sem_objeto", dependency_adapters: "none", invocations: h.report };
    const exported = await f.call("/area-templates/export", "POST", { id: "consultoria_exportada", name: "Consultoria exportada", type_ids: [body.type_id] });
    expect(exported.object_types).toBeUndefined();
    expect(exported.work_types[0].object_type_id).toBeUndefined();
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
  }, 180000);
});
