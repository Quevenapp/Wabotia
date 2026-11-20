import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Env as AppEnv } from "../src/types";
import { MOBILE_TOKEN_PREFIX, sha } from "../src/security";
import { perform, settingsRevision } from "../src/service";
import { planObjectUpgrade } from "../src/area-templates/object-upgrades";
import type { CustomWorkType, ServiceObjectType, WorkField } from "../src/modules/os/contracts";
import { createWorkApi } from "../web/modules/os/work-api";
import { FieldsEditor } from "../web/modules/os/types/FieldsEditor";
import { ResourcesEditor } from "../web/modules/os/types/ResourcesEditor";
import { ObjectTypesEditor } from "../web/modules/os/object-types/ObjectTypesEditor";
import { FieldLocationEditor } from "../web/modules/os/object-types/FieldLocationEditor";
import { StandardObjectUpgrade, standardUpgradePreview } from "../web/modules/os/object-types/StandardObjectUpgrade";
import { FieldIndexConfiguration, WorkTypesPage } from "../web/modules/os/types/WorkTypesPage";
import { Button, Field } from "../web/ui";
import {
  exportConfiguration, messageMarkers, messagePreview, moveFieldLocation,
  newObjectType, newWorkType, parseConfigurationImport, prepareConfigurationSave,
  prepareObjectTypeSave, prepareTypeSave, renameStage, validateConfigurationDraft,
  type WorkFieldDraft,
} from "../web/modules/os/types/type-draft";
import { integrationFixture } from "./os-integration-fixture";
import { os2Harness, withOs2Time } from "./os2-fixture";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
// Mesmo método de callbacks adotado em os-web-review; SSR continua usando React real.
const uiRuntime = vi.hoisted(() => ({
  current: null as { slots: any[]; index: number } | null,
  app: {} as any, route: {} as any, api: {} as any,
  resources: new Map<string, any>(), pending: [] as Promise<unknown>[], navigate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: any) => {
    const owner = uiRuntime.current;
    if (!owner) return actual.useState(initial);
    const index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (next: any) => { owner.slots[index] = typeof next === "function" ? next(owner.slots[index]) : next; }];
  } };
});
vi.mock("../web/app/AppContext", async (original) => ({
  ...await original<typeof import("../web/app/AppContext")>(), useApp: () => uiRuntime.app,
}));
vi.mock("../web/app/hooks", async (original) => ({
  ...await original<typeof import("../web/app/hooks")>(), useUnsavedGuard: vi.fn(),
  useAction: () => ({ busy: false, run: (run: () => any) => {
    const promise = Promise.resolve(run()); uiRuntime.pending.push(promise); return promise;
  } }),
}));
vi.mock("../web/lib/routes", async (original) => ({
  ...await original<typeof import("../web/lib/routes")>(), useRoute: () => uiRuntime.route, navigate: uiRuntime.navigate,
}));
vi.mock("../web/modules/os/work-hooks", async (original) => ({
  ...await original<typeof import("../web/modules/os/work-hooks")>(),
  useWorkApi: () => uiRuntime.api,
  useWorkResource: (key: string) => uiRuntime.resources.get(key) ?? { data: undefined, loading: false, reload: vi.fn() },
}));
const instance = () => ({ slots: [] as any[], index: 0 });
function draw<T>(owner: ReturnType<typeof instance>, render: () => T): T {
  const previous = uiRuntime.current;
  owner.index = 0; uiRuntime.current = owner;
  try { return render(); } finally { uiRuntime.current = previous; }
}
function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...nodes((tree.props as any).children)];
}
function nodeText(tree: any): string {
  if (Array.isArray(tree)) return tree.map(nodeText).join("");
  if (React.isValidElement(tree)) return nodeText((tree.props as any).children);
  return tree == null ? "" : String(tree);
}
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === Button && nodeText(node).includes(label));
async function drainActions() {
  for (let index = 0; index < uiRuntime.pending.length; index++) await uiRuntime.pending[index];
  uiRuntime.pending = [];
}
const runtime = {
  context: createExecutionContext, drain: waitOnExecutionContext,
  inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn),
};
const textField = (id: string, extra: Partial<Extract<WorkField, { kind: "text" }>> = {}): WorkField => ({
  id, label: id, help: "", required: false, client_visible: true, sensitive: false,
  kind: "text", multiline: false, max_length: 120, ...extra,
});
const objectType = (): ServiceObjectType => ({
  schema_version: 1, id: "veiculo", revision: 1, archived: false,
  labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "nome",
  fields: [textField("nome")], retired_field_ids: [],
});
const workType = (): CustomWorkType => ({
  ...newWorkType(), id: "oficina", labels: { ...newWorkType().labels, singular: "Revisão", plural: "Revisões" },
  fields: [textField("placa"), { id: "km", label: "Quilometragem", help: "Por visita", kind: "integer", min: 0, max: 1000000, required: false, client_visible: true, sensitive: false }],
});
const settingsIn = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);

describe("OS2 configuração: preparação, localização e limites", () => {
  it("mantém o payload sem objeto e não cria propriedades novas no modelo legado", () => {
    const legacy = workType(), previous = { os_work_types: [legacy] };
    const saved = prepareConfigurationSave([legacy], undefined, previous, "revisao-legada");
    expect(saved).toEqual({ os_work_types: [legacy], settings_revision: "revisao-legada" });
    expect(saved.os_work_types[0]).not.toHaveProperty("object_type_id");
    expect(saved.os_work_types[0]).not.toHaveProperty("stage_field_rules");
    expect(saved.os_work_types[0]).not.toHaveProperty("list_fields");
    expect(prepareTypeSave(legacy, legacy)).toEqual(legacy);
    expect(exportConfiguration(legacy, [])).toEqual(legacy);
    expect(parseConfigurationImport(JSON.stringify(legacy))).toEqual({ work_type: legacy });
    expect(messageMarkers(legacy).has("objeto")).toBe(true);
    expect(messagePreview("Ordem {numero}: {objeto}", legacy)).toBe("Ordem 123: ");
    const duplicate = { ...legacy, id: "duplicada", revision: 1 };
    expect(prepareConfigurationSave([legacy, duplicate], undefined, previous, "r").os_work_types).toHaveLength(2);
  });

  it("prepara um identificador conservador e aposenta IDs sem revisões extras", () => {
    const created = newObjectType(["objeto"]);
    expect(created.revision).toBe(1);
    expect(created.fields.find(field => field.id === created.identifier_field_id)).toMatchObject({
      kind: "text", required: false, multiline: false, sensitive: false, client_visible: false,
    });
    const before = { ...objectType(), fields: [...objectType().fields, textField("serie")], retired_field_ids: ["antigo"] };
    const removed = prepareObjectTypeSave({ ...before, fields: before.fields.slice(0, 1) }, before);
    expect(removed.retired_field_ids).toEqual(["antigo", "serie"]);
    expect(removed.revision).toBe(2);
    expect(prepareObjectTypeSave(removed, removed)).toEqual(removed);
    const { retired_field_ids, ...rest } = removed;
    const reordered = { retired_field_ids, ...rest };
    expect(prepareObjectTypeSave(reordered, removed).revision).toBe(2);
    expect(validateConfigurationDraft([], [{ ...removed, fields: [...removed.fields, textField("serie")] }], { os_object_types: [removed] })).not.toEqual([]);
  });

  it("move explicitamente sem valores, aposenta a origem e qualifica as referências", () => {
    const before: CustomWorkType = { ...workType(), object_type_id: "veiculo" };
    before.list_fields = [{ ref: { scope: "order", field_id: "placa" }, column: true, filter: true }];
    const original = structuredClone(before), originalObject = objectType();
    const moved = moveFieldLocation(before, originalObject, "order", "placa");
    expect(before).toEqual(original);
    expect(originalObject).toEqual(objectType());
    expect(moved.work_type.fields.map(field => field.id)).toEqual(["km"]);
    expect(moved.work_type.retired_field_ids).toContain("placa");
    expect(moved.object_type.fields.map(field => field.id)).toEqual(["nome", "placa"]);
    expect(moved.work_type.list_fields).toEqual([{ ref: { scope: "object", field_id: "placa" }, column: true, filter: true }]);
    expect(moved.work_type).not.toHaveProperty("values");
    expect(moved.object_type).not.toHaveProperty("values");
    const another = { ...workType(), id: "outro", object_type_id: "veiculo" };
    expect(() => moveFieldLocation(another, moved.object_type, "order", "placa")).toThrow();
    const shared = moveFieldLocation(another, moved.object_type, "order", "placa", "placa");
    expect(shared.object_type.fields.filter(field => field.id === "placa")).toHaveLength(1);
    expect(shared.work_type.object_type_id).toBe(moved.object_type.id);
    expect(() => moveFieldLocation({ ...another, stage_field_rules: [{ field_id: "placa", required_on_exit: [another.initial_stage] }] }, objectType(), "order", "placa")).toThrow();
    expect(() => moveFieldLocation(another, { ...objectType(), retired_field_ids: ["placa"] }, "order", "placa")).toThrow();
    expect(() => moveFieldLocation({ ...another, fields: [textField("placa", { sensitive: true, client_visible: false })] }, moved.object_type, "order", "placa", "placa")).toThrow();
    expect(() => moveFieldLocation(moved.work_type, moved.object_type, "object", "nome")).toThrow();
  });

  it("valida todos os modelos compartilhados e conserva suas revisões quando só o objeto muda", () => {
    const object = objectType(), a = { ...workType(), object_type_id: object.id };
    const b = { ...a, id: "inspecao", list_fields: [{ ref: { scope: "object" as const, field_id: "nome" }, filter: true }] };
    const previous = { os_work_types: [a, b], os_object_types: [object] };
    const revised = { ...object, labels: { singular: "Carro", plural: "Carros" } };
    const body = prepareConfigurationSave([a, b], [revised], previous, "r");
    expect(body.os_object_types?.[0].revision).toBe(2);
    expect(body.os_work_types.map(type => type.revision)).toEqual([1, 1]);
    const invalid = { ...object, fields: [textField("nome", { max_length: 300 })], identifier_field_id: "placa" };
    invalid.fields.push(textField("placa"));
    expect(() => prepareConfigurationSave([a, b], [invalid], previous, "r")).toThrow();
    expect(prepareConfigurationSave(body.os_work_types, body.os_object_types, body, "r2").os_object_types?.[0].revision).toBe(2);
  });

  it("normaliza espaços antes de comparar revisões de modelos e objetos", () => {
    const object = objectType(), type = { ...workType(), object_type_id: object.id };
    const previous = { os_work_types: [type], os_object_types: [object] };
    const paddedType = { ...type,
      labels: { ...type.labels, singular: `  ${type.labels.singular}  `, plural: ` ${type.labels.plural} ` },
      fields: type.fields.map(field => ({ ...field, label: ` ${field.label} `, help: `  ${field.help}  ` })),
    };
    const paddedObject = { ...object,
      labels: { singular: ` ${object.labels.singular} `, plural: `  ${object.labels.plural}  ` },
      fields: object.fields.map(field => ({ ...field, label: `  ${field.label}  `, help: ` ${field.help} ` })),
    };
    const unchanged = prepareConfigurationSave([paddedType], [paddedObject], previous, "r");
    expect(unchanged).toEqual({ ...previous, settings_revision: "r" });
    expect(unchanged.os_work_types[0].revision).toBe(1);
    expect(unchanged.os_object_types?.[0].revision).toBe(1);
    const changed = prepareConfigurationSave(
      [{ ...paddedType, labels: { ...paddedType.labels, singular: "  Revisão técnica  " } }],
      [{ ...paddedObject, labels: { ...paddedObject.labels, singular: "  Automóvel  " } }],
      previous, "r",
    );
    expect(changed.os_work_types[0]).toMatchObject({ revision: 2, labels: { singular: "Revisão técnica" } });
    expect(changed.os_object_types?.[0]).toMatchObject({ revision: 2, labels: { singular: "Automóvel" } });
  });

  it("rejeita exigências do objeto, regras sensíveis e referências inexistentes", () => {
    const object = objectType(), base = { ...workType(), object_type_id: object.id };
    for (const change of [
      { stage_field_rules: [{ field_id: "nome", required_from_stage: "delivered" }] },
      { stage_field_rules: [{ field_id: "km", required_on_exit: ["inexistente"] }] },
      { list_fields: [{ ref: { scope: "object", field_id: "inexistente" }, filter: true }] },
      { fields: [textField("privado", { sensitive: true, client_visible: false })], stage_field_rules: [{ field_id: "privado", required_from_stage: "delivered" }] },
      { fields: [textField("privado", { sensitive: true, client_visible: false })], list_fields: [{ ref: { scope: "order", field_id: "privado" }, column: true }] },
    ]) expect(() => prepareConfigurationSave([{ ...base, ...change } as CustomWorkType], [object], {}, "r")).toThrow();
    const staged = { ...base, stage_field_rules: [{ field_id: "km", required_from_stage: "delivered", required_on_exit: ["received"] }] };
    const renamed = renameStage(staged, 0, "entrada", "Entrada");
    expect(renamed.stage_field_rules?.[0].required_on_exit).toEqual(["entrada"]);
    expect(prepareConfigurationSave([renamed], [object], {}, "r").os_work_types[0].stage_field_rules).toEqual(renamed.stage_field_rules);
  });

  it("aplica quatro filtros, quatro colunas e 24 campos combinados, inclusive em outros modelos", () => {
    const fields = Array.from({ length: 5 }, (_, index) => textField(`campo_${index}`));
    const base = { ...workType(), fields };
    for (const flag of ["column", "filter"] as const) {
      const list_fields = fields.map(field => ({ ref: { scope: "order" as const, field_id: field.id }, [flag]: true }));
      expect(() => prepareConfigurationSave([{ ...base, list_fields }], undefined, {}, "r")).toThrow();
      expect(prepareConfigurationSave([{ ...base, list_fields: list_fields.slice(0, 4) }], undefined, {}, "r").os_work_types).toHaveLength(1);
    }
    for (const extra of [{ max_length: 241 }, { multiline: true }])
      expect(() => prepareConfigurationSave([{ ...base, fields: [textField("texto", extra)], list_fields: [{ ref: { scope: "order", field_id: "texto" }, filter: true }] }], undefined, {}, "r")).toThrow();
    const object = objectType();
    const full = { ...base, object_type_id: object.id, fields: Array.from({ length: 23 }, (_, index) => textField(`campo_${index}`)) };
    expect(prepareConfigurationSave([full], [object], {}, "r").os_work_types).toHaveLength(1);
    expect(() => prepareConfigurationSave([{ ...full, fields: [...full.fields, textField("excesso")] }], [object], {}, "r")).toThrow();
    expect(() => prepareConfigurationSave([], Array.from({ length: 21 }, (_, index) => ({ ...object, id: `objeto_${index}` })), {}, "r")).toThrow();
    expect(() => prepareConfigurationSave([base], [{ ...object, fields: [textField("nome", { max_length: 121 })] }], {}, "r")).toThrow();
  });

  it("exporta apenas a definição referenciada, importa o conjunto e mantém exemplos de mensagens públicos", () => {
    const object = objectType(), type = { ...workType(), object_type_id: object.id };
    const unrelated = { ...object, id: "outra_area", labels: { singular: "Não exportar", plural: "Não exportar" } };
    const exported = exportConfiguration(type, [object, unrelated]);
    expect(exported).toMatchObject({ work_type: type, object_types: [object] });
    expect(JSON.stringify(exported)).not.toContain("outra_area");
    expect(parseConfigurationImport(JSON.stringify(exported))).toEqual({ work_type: type, object_types: [object] });
    expect(() => parseConfigurationImport(JSON.stringify({ ...exported, object_types: [] }))).toThrow();
    expect(messagePreview("{objeto}", type)).not.toBe("");
    expect(messagePreview("{objeto}", workType())).toBe("");
    expect(messageMarkers({ ...type, fields: [textField("privado", { sensitive: true, client_visible: false })] }).has("campo_privado")).toBe(false);
    const choice: WorkFieldDraft = { id: "categoria", label: "Categoria", help: "", kind: "choice", required: false, client_visible: true, sensitive: false,
      options: [], options_text: "leve: Leve\npesado: Pesado" };
    const edited = exportConfiguration({ ...type, fields: [...type.fields, choice] }, [{ ...object, fields: [...object.fields, { ...choice, id: "classe" }] }]);
    expect(JSON.stringify(edited)).not.toContain("options_text");
    const imported = parseConfigurationImport(JSON.stringify(edited));
    expect(imported.work_type.fields.find(field => field.id === "categoria")).toMatchObject({ options: [{ id: "leve", label: "Leve" }, { id: "pesado", label: "Pesado" }] });
    expect(imported.object_types?.[0].fields.find(field => field.id === "classe")).toMatchObject({ options: [{ id: "leve", label: "Leve" }, { id: "pesado", label: "Pesado" }] });
  });
});

describe("OS2 configuração: plano puro do padrão", () => {
  it("exige decisões explícitas quando a versão anterior do padrão não está disponível", () => {
    const current = workType(), object = { ...objectType(), fields: [...objectType().fields, textField("placa")] };
    const standard = { ...current, object_type_id: object.id, fields: current.fields.filter(field => field.id !== "placa"),
      stage_field_rules: [{ field_id: "km", required_on_exit: ["received"] }] };
    const props = { current, standard, objectType: object };
    const unreviewed = standardUpgradePreview(props);
    expect(unreviewed.can_apply).toBe(false);
    expect(unreviewed.moved_fields).toEqual([]);
    expect(unreviewed.conflicts.map(conflict => conflict.path)).toEqual(expect.arrayContaining(["fields.placa", "rules"]));
    const reviewed = standardUpgradePreview(props, { placa: "move" }, "standard");
    expect(reviewed.can_apply).toBe(true);
    expect(reviewed.moved_fields).toEqual(["placa"]);
    expect(reviewed.work_type.stage_field_rules).toEqual(standard.stage_field_rules);
    const html = renderToStaticMarkup(React.createElement(StandardObjectUpgrade, { ...props, onApply: () => {} }));
    expect(html).toContain("O modelo padrão mudou: revisar e aplicar");
    expect(html).toContain("Ordens existentes");
    expect(html).toMatch(/disabled=""[^>]*>Aplicar atualização revisada/);
  });

  it("mostra efeitos concretos sem alterar ordens, entrada, personalizações ou definições originais", () => {
    const before = workType(), object = { ...objectType(), fields: [...objectType().fields, textField("placa")] };
    const standard = { ...before, object_type_id: object.id, fields: before.fields.filter(field => field.id !== "placa"),
      stage_field_rules: [{ field_id: "km", required_on_exit: ["received"] }],
      list_fields: [{ ref: { scope: "object" as const, field_id: "placa" }, column: true, filter: true }] };
    const original = JSON.stringify({ before, standard, object });
    const plan = planObjectUpgrade({ current: before, previous_standard: before, standard, object_type: object });
    expect(plan.can_apply).toBe(true);
    expect(plan.object_action).toBe("create");
    expect(plan.moved_fields).toEqual(["placa"]);
    expect(plan.retained_fields).toEqual(["km"]);
    expect(plan.work_type.retired_field_ids).toContain("placa");
    expect(plan.work_type.stage_field_rules).toEqual(standard.stage_field_rules);
    expect(plan.work_type.list_fields).toEqual(standard.list_fields);
    expect(plan.notice).toContain("Ordens existentes");
    expect(JSON.stringify({ before, standard, object })).toBe(original);
    const personalized = { ...before, fields: [textField("placa", { max_length: 60 }), before.fields[1]] };
    const conflicted = planObjectUpgrade({ current: personalized, previous_standard: before, standard, object_type: object });
    expect(conflicted.can_apply).toBe(false);
    expect(conflicted.conflicts.some(conflict => conflict.code === "personalized_field")).toBe(true);
    const kept = planObjectUpgrade({ current: personalized, previous_standard: before, standard, object_type: object, resolutions: { placa: "keep" } });
    expect(kept.can_apply).toBe(true);
    expect(kept.work_type.fields.find(field => field.id === "placa")).toEqual(personalized.fields[0]);
    const secret = { ...before, fields: [textField("placa", { sensitive: true, client_visible: false }), before.fields[1]] };
    const denied = planObjectUpgrade({ current: secret, previous_standard: before, standard, object_type: object, resolutions: { placa: "move" } });
    expect(denied.can_apply).toBe(false);
    expect(denied.moved_fields).toEqual([]);
    expect(denied.conflicts.some(conflict => conflict.code === "sensitive_field")).toBe(true);
    const safe = planObjectUpgrade({ current: secret, previous_standard: before, standard, object_type: object, resolutions: { placa: "keep" } });
    expect(safe.can_apply).toBe(true);
    expect(safe.work_type.fields[0].sensitive).toBe(true);
    expect(safe.object_type.fields.find(field => field.id === "placa")?.sensitive).toBe(false);
  });
});

describe("OS2 configuração: Worker e Coordinator reais", () => {
  it("salva objetos e modelos em um CAS, repete sem novas revisões e preserva os dados de cada área e cliente", async ({ task }) => {
    await withOs2Time(1795000000000, async () => {
      const h = os2Harness(env, runtime), f = await integrationFixture(h), other = await integrationFixture(h);
      (task.meta as Record<string, unknown>).os2Budget = { scenario: "configuration_settings", invocations: h.report };
      await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
      const initial = workType(), legacy = { ...workType(), id: "sem_objeto" };
      const first = prepareConfigurationSave([initial, legacy], undefined, {}, await settingsRevision(env, f.profile));
      await f.call("/settings", "PUT", first);
      const opened = await f.call("/service-orders", "POST", { type_id: initial.id, phone: "5511960010203", item: "Carro", problem: "Revisão", extra: { placa: "ABC1D23", km: 60000 }, notify: false });
      const orderBefore = await one(env, "SELECT * FROM os_orders WHERE id=?", opened.id);
      const areaBefore = await settingsIn(other.profile);
      const previous = await settingsIn(f.profile), object = objectType();
      const moved = moveFieldLocation({ ...initial, object_type_id: object.id }, object, "order", "placa");
      const sibling = { ...moved.work_type, id: "inspecao", list_fields: [{ ref: { scope: "object" as const, field_id: "nome" }, filter: true }] };
      const configured = prepareConfigurationSave([moved.work_type, sibling, legacy], [moved.object_type], previous, await settingsRevision(env, f.profile));
      const key = uid();
      const accepted = await f.call("/settings", "PUT", configured, key);
      const stored = await settingsIn(f.profile), revision = await settingsRevision(env, f.profile);
      expect(stored.os_work_types.find((type: CustomWorkType) => type.id === initial.id).revision).toBe(2);
      expect(stored.os_work_types.find((type: CustomWorkType) => type.id === legacy.id)).toEqual(legacy);
      expect(stored.os_work_types.filter((type: CustomWorkType) => type.object_type_id === object.id)).toHaveLength(2);
      expect(stored.os_object_types).toEqual(configured.os_object_types);
      const replay = await h.fetch(f.request("/settings", "PUT", configured, key));
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await replay.json()).toEqual(accepted);
      expect(await settingsRevision(env, f.profile)).toBe(revision);
      expect(await one(env, "SELECT * FROM os_orders WHERE id=?", opened.id)).toEqual(orderBefore);
      expect(await settingsIn(other.profile)).toEqual(areaBefore);
      expect(await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile)).toHaveLength(1);
      expect(await all(env, "SELECT id FROM os_objects WHERE profile_id=?", f.profile)).toEqual([]);
      await f.call("/settings", "PUT", { ...configured, os_work_types: [legacy] }, key, 409);
      await f.call("/settings", "PUT", configured, uid(), 409);
      expect(await settingsIn(f.profile)).toEqual(stored);
      const invalid = { ...configured, settings_revision: revision, os_object_types: [{ ...configured.os_object_types![0], revision: 2, identifier_field_id: "ausente" }] };
      await f.call("/settings", "PUT", invalid, uid(), 400);
      expect(await settingsRevision(env, f.profile)).toBe(revision);
      // A configuração jamais adota definições ou valores das fichas existentes.
      const contacts = [uid(), uid()], objects = [uid(), uid()];
      for (let index = 0; index < 2; index++) {
        await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team',?,'cliente','panel','test','test',?,?)", contacts[index], f.profile, `Cliente ${index}`, now(), now());
        await exec(env, "INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,?,'test','test',?,?)", objects[index], f.profile, contacts[index], object.id, JSON.stringify(configured.os_object_types![0]), JSON.stringify({ nome: `Cliente ${index}`, placa: `PLACA_${index}` }), now(), now());
      }
      const objectsBefore = await all(env, "SELECT * FROM os_objects WHERE profile_id=? ORDER BY id", f.profile);
      const objectChanged = { ...configured.os_object_types![0], labels: { singular: "Veículo revisado", plural: "Veículos revisados" } };
      const next = prepareConfigurationSave(stored.os_work_types, [objectChanged], stored, revision);
      await f.call("/settings", "PUT", { ...next, os2_ai_access: { enabled: true, internal: true, sensitive: true } });
      expect((await settingsIn(f.profile)).os2_ai_access).toEqual({ enabled: true, internal: true, sensitive: true });
      expect(await all(env, "SELECT * FROM os_objects WHERE profile_id=? ORDER BY id", f.profile)).toEqual(objectsBefore);
      expect(await one(env, "SELECT * FROM os_orders WHERE id=?", opened.id)).toEqual(orderBefore);
      const plainOrder = await f.call("/service-orders", "POST", { type_id: legacy.id, phone: "5511960010204", item: "Atendimento sem objeto", problem: "Conferir", notify: false });
      expect(plainOrder).not.toHaveProperty("object");
      expect(await all(env, "SELECT id FROM os_objects WHERE profile_id=?", f.profile)).toHaveLength(2);
      expect(h.report.some(invocation => invocation.worker_invoked && invocation.coordinators.length > 0)).toBe(true);
    });
  }, 120000);

  it("não aceita configuração sem administrador nem reutiliza o escopo de outra área", async () => {
    const h = os2Harness(env, runtime), f = await integrationFixture(h), other = await integrationFixture(h);
    const token = MOBILE_TOKEN_PREFIX + uid() + uid();
    await exec(env, "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used) VALUES(?,?,?,'bearer',?,'OS2 configuração',?)", await sha(token), f.memberId, now() + 3600000, now(), now());
    const payload = prepareConfigurationSave([workType()], [objectType()], {}, await settingsRevision(env, f.profile));
    const before = await settingsIn(f.profile), foreignBefore = await settingsIn(other.profile);
    const response = await h.fetch(f.request("/settings", "PUT", payload, uid(), { Authorization: `Bearer ${token}` }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "admin_required" } });
    const foreign = await h.fetch(new Request(`https://test${other.root}/settings`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": uid() }, body: JSON.stringify(payload) }));
    // A área fora do escopo fica oculta antes de conferir o papel de administrador.
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "not_found" } });
    const unauthenticated = await h.fetch(new Request(`https://test${f.root}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
    expect(unauthenticated.status).toBe(401);
    expect(await settingsIn(f.profile)).toEqual(before);
    expect(await settingsIn(other.profile)).toEqual(foreignBefore);
    for (const profile of [f.profile, other.profile]) {
      expect(await all(env, "SELECT id FROM os_objects WHERE profile_id=?", profile)).toEqual([]);
      expect(await all(env, "SELECT id FROM os_orders WHERE profile_id=?", profile)).toEqual([]);
    }
  }, 120000);

  it("o cliente do painel envia modelos e objetos na mesma operação com revisão", async () => {
    const request = vi.fn(async () => ({})), api = createWorkApi(request as any, "v1/profiles/area_atual");
    const types = [{ ...workType(), object_type_id: "veiculo" }], objects = [objectType()];
    await api.saveTypes(types, "revisao", objects);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(expect.arrayContaining(["v1/profiles/area_atual/settings", "PUT", { os_work_types: types, os_object_types: objects, settings_revision: "revisao" }]));
    request.mockClear();
    await api.saveTypes([workType()], "antiga");
    expect(request.mock.calls[0][2]).toEqual({ os_work_types: [workType()], settings_revision: "antiga" });
  });
});

describe("OS2 configuração: textos e controles do painel", () => {
  it("acompanha o identificador ao renomear um campo novo do objeto", () => {
    const object = newObjectType(), type = { ...workType(), object_type_id: object.id };
    const changed = vi.fn();
    const tree = draw(instance(), () => ObjectTypesEditor({ type, objectTypes: [object], workTypes: [type], onChange: changed }));
    const fields = nodes(tree).find(node => node.type === FieldsEditor && node.props.location === "Do objeto · Objeto");
    fields.props.onChange([{ ...object.fields[0], id: "placa", label: "Placa" }]);
    const [next, objects] = changed.mock.calls[0];
    expect(objects[0].identifier_field_id).toBe("placa");
    expect(prepareConfigurationSave([next], objects, {}, "r").os_object_types?.[0].identifier_field_id).toBe("placa");
    expect(object.identifier_field_id).toBe("identificacao");
  });

  it("apresenta acesso à IA desligado, permite escopos explícitos e desliga todos juntos", () => {
    const changed = vi.fn(), type = workType();
    let tree = ResourcesEditor({ type, onChange: () => {}, onAiAccessChange: changed });
    const aiInputs = () => nodes(nodes(tree).find(node => node.props.className === "os2-ai-access")).filter(node => node.type === "input");
    expect(aiInputs().map(node => node.props.checked)).toEqual([false, false, false]);
    expect(aiInputs().slice(1).every(node => node.props.disabled)).toBe(true);
    aiInputs()[0].props.onChange({ target: { checked: true } });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, internal: false, sensitive: false });
    tree = ResourcesEditor({ type, onChange: () => {}, aiAccess: { enabled: true, internal: false, sensitive: false }, onAiAccessChange: changed });
    expect(aiInputs().slice(1).every(node => !node.props.disabled)).toBe(true);
    aiInputs()[2].props.onChange({ target: { checked: true } });
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, internal: false, sensitive: true });
    tree = ResourcesEditor({ type, onChange: () => {}, aiAccess: { enabled: true, internal: true, sensitive: true }, onAiAccessChange: changed });
    aiInputs()[0].props.onChange({ target: { checked: false } });
    expect(changed).toHaveBeenLastCalledWith({ enabled: false, internal: false, sensitive: false });
    expect(nodeText(tree)).toContain("dados autorizados do próprio cliente");
    const legacy = renderToStaticMarkup(React.createElement(ResourcesEditor, { type, onChange: () => {} }));
    expect(legacy).not.toContain("os2-ai-access");
  });

  it("exige revisão de referências compartilhadas e confirma todos os modelos no mesmo callback", () => {
    const object = { ...objectType(), fields: [...objectType().fields, textField("serie")] };
    const type = { ...workType(), object_type_id: object.id };
    const sibling: CustomWorkType = { ...type, id: "inspecao", labels: { ...type.labels, singular: "Inspeção" },
      list_fields: [{ ref: { scope: "object", field_id: "serie" }, column: true, filter: true }] };
    const changed = vi.fn(), owner = instance();
    const render = () => ObjectTypesEditor({ type, objectTypes: [object], workTypes: [type, sibling], previousObjectTypes: [object], previousType: type, onChange: changed });
    let tree = draw(owner, render);
    const objectFields = () => nodes(tree).find(node => node.type === FieldsEditor && node.props.location === "Do objeto · Veículo");
    objectFields().props.onChange(object.fields.filter(field => field.id !== "serie"));
    expect(changed).not.toHaveBeenCalled();
    tree = draw(owner, render);
    expect(nodeText(tree)).toContain("Revisar modelos afetados");
    expect(nodeText(tree)).toContain("Inspeção: serie");
    button(tree, "Cancelar mudança").props.onClick();
    tree = draw(owner, render);
    expect(changed).not.toHaveBeenCalled();
    objectFields().props.onChange(object.fields.filter(field => field.id !== "serie"));
    tree = draw(owner, render);
    button(tree, "Confirmar alterações nos modelos afetados").props.onClick();
    expect(changed).toHaveBeenCalledTimes(1);
    const [current, objects, affected] = changed.mock.calls[0];
    expect(current).toEqual(type);
    expect(objects[0].retired_field_ids).toContain("serie");
    expect(affected).toHaveLength(1);
    expect(affected[0].id).toBe(sibling.id);
    expect(affected[0].fields).toEqual(sibling.fields);
    expect(affected[0]).not.toHaveProperty("list_fields");
    const payload = prepareConfigurationSave([current, ...affected], objects, { os_work_types: [type, sibling], os_object_types: [object] }, "r");
    expect(payload.os_object_types?.[0].revision).toBe(2);
    expect(payload.os_work_types.map(model => model.revision)).toEqual([1, 2]);
  });

  it("retoma o índice com geração e cursor observados e bloqueia configuração não salva", async () => {
    const type = { ...workType(), list_fields: [{ ref: { scope: "order" as const, field_id: "placa" }, filter: true }] };
    const request = vi.fn(async (..._args: unknown[]) => ({})), reload = vi.fn();
    uiRuntime.app = { root: "v1/profiles/area_indice", api: request };
    uiRuntime.api = createWorkApi(request as any, uiRuntime.app.root);
    const state = { type_id: type.id, generation: "geracao_observada", status: "building", cursor_number: 5, ceiling_number: 24, excluded_count: 3, updated: 1 };
    uiRuntime.resources.set(`${uiRuntime.app.root}/field-index-configuration/${type.id}`, { data: state, reload });
    let tree = draw(instance(), () => FieldIndexConfiguration({ type, dirty: false }));
    expect(nodeText(tree)).toContain("5 / 24");
    expect(nodeText(tree)).toContain("Versões excluídas por incompatibilidade ou privacidade: 3");
    button(tree, "Iniciar ou retomar construção").props.onClick();
    await drainActions();
    expect(request.mock.calls[0]).toEqual(expect.arrayContaining([
      `v1/profiles/area_indice/service-orders/types/${type.id}/field-index/rebuild`, "POST",
      { generation: state.generation, cursor_number: 5 },
    ]));
    expect(reload).toHaveBeenCalledOnce();
    tree = draw(instance(), () => FieldIndexConfiguration({ type, dirty: true }));
    expect(button(tree, "Iniciar ou retomar construção").props.disabled).toBe(true);
    expect(nodeText(tree)).toContain("Salve as alterações");
    uiRuntime.resources.set(`${uiRuntime.app.root}/field-index-configuration/${type.id}`, { data: { ...state, status: "ready" }, reload });
    tree = draw(instance(), () => FieldIndexConfiguration({ type, dirty: false }));
    expect(nodeText(tree)).toContain("Filtros prontos");
    expect(button(tree, "Iniciar ou retomar construção").props.disabled).toBe(true);
    request.mockClear();
    uiRuntime.resources.set(`${uiRuntime.app.root}/field-index-configuration/${type.id}`, { error: { code: "not_found" }, reload });
    tree = draw(instance(), () => FieldIndexConfiguration({ type, dirty: false }));
    button(tree, "Iniciar construção").props.onClick();
    await drainActions();
    expect(request.mock.calls[0][2]).toEqual({});
  });

  it.each([false, true])("o formulário envia objetos, modelos e escolha de IA (%s) no mesmo PUT da área", async (enableAi) => {
    vi.stubGlobal("location", new URL("https://painel.example/app/gestao/modelos/oficina"));
    try {
      const object = { ...objectType(), fields: [...objectType().fields, textField("serie")] };
      const type = { ...workType(), object_type_id: object.id };
      const sibling: CustomWorkType = { ...type, id: "inspecao", list_fields: [{ ref: { scope: "object", field_id: "serie" }, filter: true }] };
      const request = vi.fn(async (..._args: unknown[]) => ({})), reload = vi.fn();
      uiRuntime.app = { root: "v1/profiles/area_editor", api: request, refresh: vi.fn(async () => {}) };
      uiRuntime.api = createWorkApi(request as any, uiRuntime.app.root);
      uiRuntime.route = { area: "admin", page: "work-types", typeId: type.id };
      const settings = { settings: { os_work_types: [type, sibling], os_object_types: [object] }, settings_revision: "revisao_observada" };
      uiRuntime.resources.set(uiRuntime.app.root + "/type-settings", { data: settings, reload });
      uiRuntime.resources.set(uiRuntime.app.root + "/model-examples", { data: [], reload: vi.fn() });
      const page: any = draw(instance(), WorkTypesPage), editorOwner = instance();
      const render = () => page.type(page.props);
      let tree = draw(editorOwner, render);
      button(tree, "Campos extras").props.onClick();
      tree = draw(editorOwner, render);
      const editor = nodes(tree).find(node => node.type === ObjectTypesEditor);
      const affected = { ...sibling }; delete affected.list_fields;
      editor.props.onChange(type, [{ ...object, fields: object.fields.slice(0, 1), retired_field_ids: ["serie"] }], [affected]);
      tree = draw(editorOwner, render);
      button(tree, "Recursos").props.onClick();
      tree = draw(editorOwner, render);
      const resources = nodes(tree).find(node => node.type === ResourcesEditor);
      expect(resources.props.aiAccess).toEqual({ enabled: false, internal: false, sensitive: false });
      if (enableAi) resources.props.onAiAccessChange({ enabled: true, internal: true, sensitive: true });
      tree = draw(editorOwner, render);
      nodes(tree).find(node => node.type === "form").props.onSubmit({ preventDefault: () => {} });
      await drainActions();
      expect(request).toHaveBeenCalledTimes(1);
      const [url, method, payload] = request.mock.calls[0] as [string, string, any];
      expect(url).toBe("v1/profiles/area_editor/settings");
      expect(method).toBe("PUT");
      expect(payload.settings_revision).toBe("revisao_observada");
      if (enableAi) expect(payload.os2_ai_access).toEqual({ enabled: true, internal: true, sensitive: true });
      else expect(payload).not.toHaveProperty("os2_ai_access");
      expect(payload.os_object_types[0]).toMatchObject({ revision: 2, retired_field_ids: ["serie"] });
      expect(payload.os_work_types.map((model: CustomWorkType) => [model.id, model.revision])).toEqual([[type.id, 1], [sibling.id, 2]]);
      expect(payload.os_work_types[1]).not.toHaveProperty("list_fields");
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("reutiliza o editor de campos e preserva os rótulos do modelo sem objeto", () => {
    const legacy = workType();
    const html = renderToStaticMarkup(React.createElement(ObjectTypesEditor, { type: legacy, objectTypes: [], workTypes: [legacy], onChange: () => {} }));
    expect(html).toContain("Objeto do serviço");
    expect(html).toContain("Sem objeto");
    expect(html).toContain("Quilometragem");
    expect(html).not.toContain("Fagoo");
    const fields = renderToStaticMarkup(React.createElement(FieldsEditor, { fields: legacy.fields, locked: legacy.fields.map(field => field.id), retired: ["antigo"], onChange: () => {} }));
    expect(fields).toContain("Identificador");
    expect(fields).toContain("Aposentar campo");
  });

  it("identifica o objeto compartilhado e explica limites, requisitos e rascunho sem dados de clientes", () => {
    const object = objectType(), type = { ...workType(), object_type_id: object.id };
    const sibling = { ...type, id: "inspecao", labels: { ...type.labels, singular: "Inspeção", plural: "Inspeções" } };
    const html = renderToStaticMarkup(React.createElement(ObjectTypesEditor, { type, objectTypes: [object], workTypes: [type, sibling], previousObjectTypes: [object], previousType: type, onChange: () => {} }));
    expect(html).toContain("Veículo");
    expect(html).toContain("Inspe");
    expect(html).toMatch(/compartilhad/i);
    expect(html).toMatch(/[Rr]ascunho/);
    expect(html).toMatch(/abertura/);
    expect(html).toMatch(/saída/);
    expect(html).toMatch(/4/);
    expect(html).not.toContain("PLACA_0");
    expect(html).not.toContain("PLACA_1");
  });

  it("não oferece exigências tardias no objeto e desabilita uso sensível em listas", () => {
    const object = objectType(), type = { ...workType(), object_type_id: object.id };
    const objectHtml = renderToStaticMarkup(React.createElement(FieldLocationEditor, { type, objectType: object, field: object.fields[0], scope: "object", onChange: () => {} }));
    expect(objectHtml).toContain("Obrigatoriedade apenas no cadastro do objeto");
    expect(objectHtml).not.toContain("os2-requirements");
    const secret = textField("privado", { sensitive: true, client_visible: false });
    const secretHtml = renderToStaticMarkup(React.createElement(FieldLocationEditor, { type, objectType: object, field: secret, scope: "order", onChange: () => {} }));
    expect(secretHtml).toMatch(/class="os2-requirements" disabled=""/);
    expect(secretHtml).toMatch(/class="os2-list-options" disabled=""/);
    const fixed = renderToStaticMarkup(React.createElement(FieldsEditor, { fields: [secret], locked: [secret.id], sensitiveLocked: [secret.id], onChange: () => {} }));
    expect(fixed).toMatch(/type="checkbox" disabled="" checked=""/);
    const long = textField("longo", { max_length: 241 });
    const limited = renderToStaticMarkup(React.createElement(FieldLocationEditor, { type, field: long, scope: "order", onChange: () => {} }));
    expect(limited).toContain("até 240 caracteres");
    expect(limited).toMatch(/type="checkbox" disabled=""[^>]*\/>Filtro próprio/);
  });
});
