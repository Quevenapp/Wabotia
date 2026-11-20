import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, now, uid, type Env as AppEnv } from "../src/types";
import { perform, settingsRevision } from "../src/service";
import { validateObjectValues, isFieldFilled } from "../src/modules/os/validation";
import { authorizedOrder, type WorkOrderRow } from "../src/modules/os/public";
import { commitOrderMutation, mutationHistory } from "../src/modules/os/mutations";
import { listOrders, orderViewForActor } from "../src/modules/os/store";
import type { Os2Adapters } from "../src/modules/os/os2-ports";
import type { ServiceObjectType, ServiceObjectSnapshot, ServiceObjectSnapshotView, ServiceObjectView, Order, WorkField, OrderFieldFilter } from "../src/modules/os/contracts";
import { integrationFixture } from "./os-integration-fixture";
import { motorWorkType } from "./os-motor-fixture";
import { os2Harness, withOs2Time } from "./os2-fixture";
import type { Api } from "../web/lib/api";
import { createWorkApi } from "../web/modules/os/work-api";
import { ExtraFields } from "../web/modules/os/components/ExtraFields";
import { WorkFormDialog, changeOpeningContact, requiresCanonicalContact } from "../web/modules/os/work/WorkFormDialog";
import { WorkPage, workListFields, workColumnValue, makeWorkFieldFilter, workListCountLabel } from "../web/modules/os/work/WorkListPage";
import { ObjectPicker, parseObjectOpening } from "../web/modules/os/objects/ObjectPicker";
import { ObjectSnapshot } from "../web/modules/os/objects/ObjectSnapshot";
import { LegacyObjectLinkDialog, legacyObjectPreview } from "../web/modules/os/objects/LegacyObjectLinkDialog";
import { ServiceObjectsPage, ObjectLastCompleted } from "../web/modules/os/objects/ServiceObjectsPage";
import { WorkDetailPage, loadWorkRequirements } from "../web/modules/os/work/WorkDetailPage";
import { Pager } from "../web/admin/shared";
import { Button, Field } from "../web/ui";
import { targetHref } from "../web/contact-profile/registry";
import { href, parseRoute } from "../web/lib/routes";
import { createOs2DemoApi } from "../web/lib/demo";

declare global { namespace Cloudflare { interface Env extends AppEnv {} } }

// Mesmo padrão local de os-web-review: callbacks reais, estado controlado, sem
// DOM, rede ou dependência nova. Os testes abaixo usam o transporte real do
// Worker/Coordinator; somente as folhas paralelas são adaptadores simulados.
const ui = vi.hoisted(() => ({ current: null as any, app: {} as any, route: {} as any, navigate: vi.fn(), pending: [] as Promise<unknown>[] }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const owner = ui.current, index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (value: any) => { owner.slots[index] = typeof value === "function" ? value(owner.slots[index]) : value; }];
  };
  return { ...actual, useState, useRef: (value: any) => useState(() => ({ current: value }))[0],
    useMemo: (compute: () => any, deps: any[]) => {
      const owner = ui.current, index = owner.index++, previous = owner.slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) owner.slots[index] = { deps, value: compute() };
      return owner.slots[index].value;
    },
    useCallback: (callback: any) => callback,
    useEffect: (effect: () => any, deps: any[]) => {
      const owner = ui.current, index = owner.index++, previous = owner.slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) owner.effects.push(() => {
        previous?.cleanup?.(); owner.slots[index] = { deps, cleanup: effect() };
      });
    },
  };
});
vi.mock("../web/app/AppContext", async original => ({ ...await original<typeof import("../web/app/AppContext")>(), useApp: () => ui.app }));
vi.mock("../web/app/hooks", async original => ({ ...await original<typeof import("../web/app/hooks")>(), useUnsavedGuard: () => () => {}, useAction: () => ({ busy: false, run: (fn: () => any) => { const promise = Promise.resolve().then(fn); ui.pending.push(promise); return promise; } }) }));
vi.mock("../web/lib/routes", async original => ({ ...await original<typeof import("../web/lib/routes")>(), useRoute: () => ui.route, navigate: ui.navigate }));
const instance = () => ({ slots: [] as any[], index: 0, effects: [] as (() => void)[] });
function render<T>(owner: ReturnType<typeof instance>, draw: () => T): T {
  owner.index = 0; owner.effects = []; ui.current = owner;
  const tree = draw(); owner.effects.forEach(effect => effect()); return tree;
}
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return React.isValidElement(tree) ? [tree, ...elements((tree.props as any).children)] : [];
}
const component = (tree: any, type: any) => elements(tree).find(node => node.type === type);
const input = (tree: any, label: string) => elements(tree).find(node => node.type === Field && node.props.label === label);
function textOf(tree: any): string {
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  return React.isValidElement(tree) ? textOf((tree.props as any).children) : tree == null ? "" : String(tree);
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const runtime = { context: createExecutionContext, drain: waitOnExecutionContext, inside: (stub: DurableObjectStub, fn: any) => (runInDurableObject as any)(stub, fn) };
const textField = (id: string, label = id, changes: Partial<WorkField> = {}): WorkField => ({ id, label, kind: "text", required: false, client_visible: true, sensitive: false, help: "", multiline: false, max_length: 80, ...changes }) as WorkField;
const vehicleType = (): ServiceObjectType => ({ schema_version: 1, id: "veiculo", revision: 1, archived: false, labels: { singular: "Veículo", plural: "Veículos" }, identifier_field_id: "placa", fields: [textField("placa", "Placa"), textField("cor", "Cor"), textField("reservado", "NOME_PRIVADO", { sensitive: true, client_visible: false })], retired_field_ids: [] });
const workType = (withObject = true) => ({ ...motorWorkType(), ...(withObject ? { object_type_id: "veiculo" } : {}), fields: [...motorWorkType().fields, { id: "quilometragem", label: "Quilometragem", kind: "integer" as const, min: 0, max: 10000000, help: "", required: false, sensitive: false, client_visible: true }] });
const snapshot = (origin: ServiceObjectSnapshot["origin"] = "opening"): ServiceObjectSnapshotView => ({ schema_version: 1, object_id: "objeto/1", object_version: 1, captured_at: 1795000000000, origin, type: vehicleType(), values: { placa: "ABC1D23", cor: "Azul", reservado: "VALOR_PRIVADO" }, identifier: "ABC1D23" });

/** A folha é simulada, mas o lote, CAS, DTO, autenticação e repetição são reais. */
function adapters(): Partial<Os2Adapters> {
  const project = (row: WorkOrderRow): ServiceObjectSnapshotView | undefined => {
    if (!row.object_id) return undefined;
    const value = json(row.object_snapshot_json) as ServiceObjectSnapshot;
    const fields = value.type.fields.filter(field => !field.sensitive);
    return { ...value, type: { ...value.type, fields }, values: Object.fromEntries(fields.filter(field => Object.hasOwn(value.values, field.id)).map(field => [field.id, value.values[field.id]])), identifier: String(value.values.placa || "Veículo") };
  };
  const owner = async (ctx: Parameters<Os2Adapters["read"]>[0], id: unknown) => {
    const contact = await one(ctx.env, "SELECT * FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'", id ?? "", ctx.profile);
    if (!contact) throw new ApiError(404, "not_found", "Cliente indisponível.");
    return contact;
  };
  const object = async (ctx: Parameters<Os2Adapters["read"]>[0], id: unknown, contactId?: unknown) => {
    const row = await one(ctx.env, "SELECT * FROM os_objects WHERE id=? AND profile_id=?", id ?? "", ctx.profile);
    if (!row || (contactId !== undefined && row.contact_id !== contactId)) throw new ApiError(404, "not_found", "Objeto indisponível.");
    await owner(ctx, row.contact_id); return row;
  };
  const view = async (ctx: Parameters<Os2Adapters["read"]>[0], row: any): Promise<ServiceObjectView> => {
    const type = json(row.type_snapshot_json) as ServiceObjectType, values = json(row.values_json);
    const fields = type.fields.filter(field => !field.sensitive);
    const latest = await one(ctx.env, "SELECT id,number,delivered_at FROM os_orders WHERE profile_id=? AND object_id=? AND status='delivered' ORDER BY delivered_at DESC,number DESC,id DESC LIMIT 1", ctx.profile, row.id);
    return { id: row.id, contact_id: row.contact_id, type_id: row.type_id, type_revision: row.type_revision, type: { ...type, fields }, values: Object.fromEntries(fields.filter(field => Object.hasOwn(values, field.id)).map(field => [field.id, values[field.id]])), identifier: String(values.placa ?? "Veículo"), version: row.row_version, archived: !!row.archived, created: row.created, updated: row.updated, latest_completed: latest as ServiceObjectView["latest_completed"] };
  };
  const result: Partial<Os2Adapters> = {
    async prepareObjectOpening(ctx, opening) {
      const contactId = opening.input.contact_id || opening.contact_id;
      if (!contactId) throw new ApiError(409, "customer_required", "Selecione o contato.");
      await owner(ctx, contactId);
      const selection = opening.input.object!;
      const type = vehicleType();
      const before: import("../src/modules/os/public").ChildStatement[] = [];
      let captured: ServiceObjectSnapshot;
      if (selection.mode === "new") {
        if (selection.type_id !== type.id) throw new ApiError(400, "invalid_fields", "Tipo incompatível.");
        captured = { schema_version: 1, object_id: uid(), object_version: 1, origin: "opening", captured_at: opening.at, type, values: validateObjectValues(type, selection.values) };
        before.push(["INSERT INTO os_objects(id,profile_id,contact_id,type_id,type_revision,type_snapshot_json,values_json,created_by,updated_by,created,updated) VALUES(?,?,?,?,1,?,?,?,?,?,?)", [captured.object_id, ctx.profile, contactId, type.id, JSON.stringify(type), JSON.stringify(captured.values), opening.input.actor, opening.input.actor, opening.at, opening.at]]);
      } else {
        const existing = await object(ctx, selection.id, contactId);
        if (existing.archived) throw new ApiError(409, "object_archived", "Objeto arquivado.");
        if (existing.row_version !== selection.version) throw new ApiError(409, "version_conflict", "Recarregue o objeto.");
        captured = { schema_version: 1, object_id: existing.id, object_version: existing.row_version, origin: "opening", captured_at: opening.at, type: json(existing.type_snapshot_json), values: json(existing.values_json) };
      }
      return { contact_id: contactId, object_id: captured.object_id, snapshot: captured, before, after: [["INSERT INTO os2_receipts(profile_id,actor_key,operation,request_id,payload_hash,object_id,order_id,result_version,created) VALUES(?,?,?,?,?,?,?,1,?)", [ctx.profile, opening.input.actor, "os.create", opening.input.sourceKey, "fixture-telas", captured.object_id, opening.order_id, opening.at]]] };
    },
    async reauthorizeObjectOpening(ctx, row, input) { await object(ctx, row.object_id, input.contact_id); },
    projectObjectSnapshot: project,
    async projectObjectForActor(ctx, actor, row) { return ctx.mayRead(actor, "contacts") ? project(row) : undefined; },
    async projectObjectPage(ctx, actor, rows) {
      return new Map(ctx.mayRead(actor, "contacts") ? rows.flatMap(row => { const value = project(row); return value ? [[row.id, value] as const] : []; }) : []);
    },
    publicObjectLabel: row => project(row)?.identifier ?? "",
    async prepareOrderRulesMutation(_ctx, input) {
      const required = new Set<string>(json(input.row.stage_required_json, []));
      const targetStage = input.sets.stage ?? input.row.stage;
      if (input.sets.status !== "cancelled") for (const rule of input.type.stage_field_rules ?? []) {
        const leaving = targetStage !== input.row.stage && rule.required_on_exit?.includes(String(input.row.stage));
        const entering = rule.required_from_stage !== undefined && rule.required_from_stage === targetStage;
        if (leaving || entering) required.add(rule.field_id);
      }
      const values = json(input.sets.extra_json ?? input.row.extra_json, {});
      if (input.sets.status !== "cancelled" && [...required].some(id => !isFieldFilled(values, id))) throw new ApiError(409, "missing_fields", "Mensagem livre que a interface não deve analisar.");
      return { before: [], after: [], ...(required.size ? { stage_required: [...required] } : {}) };
    },
    planOrderFieldIndex: async () => [],
    async read(ctx, actor, operation, { params, query }) {
      if (!ctx.mayRead(actor, "contacts")) throw new ApiError(404, "not_found", "Cadastro indisponível.");
      if (operation === "os.object_types.list") return { data: [vehicleType()], settings_revision: "fixture" };
      if (operation === "os.objects.list") {
        await owner(ctx, query.contact_id);
        const rows = await all(ctx.env, "SELECT * FROM os_objects WHERE profile_id=? AND contact_id=? AND (?='' OR type_id=?) AND (?='1' OR archived=0) ORDER BY created DESC,id DESC LIMIT 30", ctx.profile, query.contact_id, query.type_id ?? "", query.type_id ?? "", query.include_archived ?? "0");
        return { data: await Promise.all(rows.map(row => view(ctx, row))), next_cursor: null };
      }
      if (operation === "os.requirements") {
        const authorized = await authorizedOrder(ctx, actor, params.id);
        const transition = authorized.type.transitions.find(entry => entry.id === query.transition_id);
        const ids = new Set<string>(json(authorized.row.stage_required_json, []));
        const targetStage = transition?.to ?? authorized.row.stage;
        for (const rule of authorized.type.stage_field_rules ?? []) {
          const leaving = !!transition && targetStage !== authorized.row.stage && rule.required_on_exit?.includes(String(authorized.row.stage));
          const entering = rule.required_from_stage !== undefined && rule.required_from_stage === targetStage;
          if (leaving || entering) ids.add(rule.field_id);
        }
        const required = authorized.type.fields.filter(field => field.required || ids.has(field.id)).map(field => ({ field_id: field.id, label: field.label }));
        return { id: params.id, version: authorized.row.row_version, transition_id: query.transition_id, required, missing: required.filter(field => !isFieldFilled(json(authorized.row.extra_json), field.field_id)), internal_missing: false };
      }
      const selected = await object(ctx, params.object_id);
      if (operation === "os.objects.get") return view(ctx, selected);
      if (operation === "os.objects.orders") {
        const rows = await all(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND object_id=? ORDER BY created DESC,number DESC,id DESC", ctx.profile, selected.id);
        return { data: await Promise.all(rows.map(row => orderViewForActor(ctx, actor, row))), next_cursor: null };
      }
      throw new ApiError(501, "not_implemented", "Fora deste adaptador de teste.");
    },
    async command(ctx, actor, operation, data, meta) {
      if (operation !== "os.object.link") throw new ApiError(501, "not_implemented", "Fora deste adaptador de teste.");
      const authorized = await authorizedOrder(ctx, actor, String(data.id), { write: true });
      const key = `telas-link:${actor.id}:${meta.requestId}`;
      if (await mutationHistory(ctx, key)) return orderViewForActor(ctx, actor, authorized.row);
      if (authorized.row.object_id || authorized.type.kind !== "custom" || authorized.row.row_version !== data.version) throw new ApiError(409, "version_conflict", "Recarregue a ordem.");
      const selection = data.object as { mode: string; id: string; version: number };
      const selected = await object(ctx, selection.id, authorized.row.contact_id);
      if (selected.row_version !== selection.version || selected.archived) throw new ApiError(409, "version_conflict", "Recarregue o objeto.");
      const captured: ServiceObjectSnapshot = { schema_version: 1, object_id: selected.id, object_version: selected.row_version, origin: "legacy_link", captured_at: now(), type: json(selected.type_snapshot_json), values: json(selected.values_json) };
      const changed = await commitOrderMutation(ctx, authorized.row, { object_id: selected.id, object_snapshot_json: JSON.stringify(captured) }, actor.id, "os.object.linked", ["object_id"], key);
      return orderViewForActor(ctx, actor, changed);
    },
    async queryOrdersByField(ctx, query, actor) {
      // Simulação da folha de índices; o teste verifica transporte, cursor e DTO,
      // não substitui a prova de plano/rows_read pertencente à folha de regras.
      const filter = JSON.parse(query.field_filter) as OrderFieldFilter;
      const scope = `${ctx.profile}:${actor.id}:${query.type_id}:${query.field_filter}`;
      let offset = 0;
      if (query.cursor) { const cursor = JSON.parse(atob(query.cursor)); if (cursor.scope !== scope) throw new ApiError(400, "invalid_cursor", "Cursor inválido."); offset = cursor.offset; }
      const page = await listOrders(ctx, { type_id: query.type_id, open: "0", limit: "50" }, actor);
      const matching = page.data.filter(row => {
        const value = filter.ref.scope === "object" ? row.object?.values[filter.ref.field_id] : row.extra[filter.ref.field_id];
        return filter.operator === "eq" ? String(value).trim().toLocaleLowerCase() === String(filter.value).trim().toLocaleLowerCase() : value != null && value >= filter.from && value <= filter.to;
      });
      const limit = Math.min(50, Number(query.limit) || 50), next = offset + limit;
      return { data: matching.slice(offset, next), next_cursor: next < matching.length ? btoa(JSON.stringify({ scope, offset: next })) : null, counts: null, counts_scope: "not_computed", order_by: filter.operator === "range" ? "field_value_asc" : "number_desc" };
    },
  };
  return result;
}
async function contact(profile: string) {
  const id = uid();
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','cliente','panel','test','test',?,?)", id, profile, now(), now()); return id;
}
async function setup(withObject = true) {
  const h = os2Harness(env, runtime, adapters()), f = await integrationFixture(h), type = workType(withObject);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], os_object_types: [vehicleType()], settings_revision: await settingsRevision(env, f.profile) }, uid());
  const transport: Api = async (path, method = "GET", body, _signal, key) => {
    const response = await h.fetch(f.request(path.slice((`v1/profiles/${f.profile}`).length), method, body, key as ReturnType<typeof uid> | undefined));
    const result: any = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message), { status: response.status, code: result.error?.code });
    return result;
  };
  return { ...f, h, type, contactId: await contact(f.profile), transport, api: createWorkApi(transport, `v1/profiles/${f.profile}`) };
}
const opening = (contactId: string) => ({ type_id: "projeto", contact_id: contactId, item: "Revisão", problem: "Conferir", notify: false, extra: { quilometragem: 60000 }, object: { mode: "new" as const, type_id: "veiculo", values: { placa: "ABC1D23", cor: "Azul" } } });

beforeEach(() => {
  vi.clearAllMocks();
  ui.pending.length = 0;
  vi.stubGlobal("location", new URL("https://test/app/erp/modulos/trabalhos?demo=1"));
  ui.current = instance();
  ui.route = { area: "erp", page: "work", typeId: "projeto" };
  ui.app = { root: "v1/profiles/a", profile: "a", api: vi.fn(async () => ({ data: [], next_cursor: null })), status: { settings_revision: "1" }, settings: { os_work_types: [workType()], os_object_types: [vehicleType()] }, names: {}, me: { access: ["os", "contacts"] } };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("OS2 telas: cliente HTTP com Worker e Coordinator reais", () => {
  it("abre inline e existente, preserva a cópia, recupera resposta perdida sem duplicar e isola clientes/áreas", async ({ task }) => {
    await withOs2Time(1795000000000, async clock => {
      const f = await setup(), foreign = await setup(), otherContact = await contact(f.profile);
      let loseResponse = true;
      const requests: Array<{ body: unknown; key?: string }> = [];
      const api = createWorkApi(async (...args) => {
        requests.push({ body: args[2], key: args[4] });
        const result = await f.transport(...args);
        if (loseResponse) { loseResponse = false; throw Object.assign(new Error("Resposta perdida"), { status: 0 }); }
        return result;
      }, `v1/profiles/${f.profile}`);
      await expect(api.create(opening(f.contactId))).rejects.toThrow("Resposta perdida");
      const first = await api.create(opening(f.contactId));
      expect(requests[0].key).toBe(requests[1].key);
      expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
      expect(await one(env, "SELECT COUNT(*) n FROM os_orders WHERE profile_id=?", f.profile)).toEqual({ n: 1 });
      const selection = { mode: "existing" as const, id: first.object!.object_id, version: 1 };
      clock.advance(1000);
      const second = await f.api.create({ ...opening(f.contactId), extra: { quilometragem: 65000 }, object: selection });
      expect(second.object?.object_id).toBe(first.object?.object_id);
      await exec(env, "UPDATE os_objects SET values_json=?,row_version=2 WHERE id=?", JSON.stringify({ placa: "ABC1D23", cor: "Prata", reservado: "SIGILO" }), selection.id);
      expect((await f.api.object(selection.id)).values.cor).toBe("Prata");
      expect((await f.api.order(first.id)).object?.values.cor).toBe("Azul");
      expect((await f.api.order(first.id)).extra.quilometragem).toBe(60000);
      expect((await f.api.order(second.id)).extra.quilometragem).toBe(65000);
      expect(JSON.stringify(await f.api.object(selection.id))).not.toContain("SIGILO");
      await expect(f.api.create({ ...opening(otherContact), object: { ...selection, version: 2 } })).rejects.toMatchObject({ code: "not_found" });
      await expect(foreign.api.create({ ...opening(foreign.contactId), object: { ...selection, version: 2 } })).rejects.toMatchObject({ code: "not_found" });
      await expect(foreign.api.object(selection.id)).rejects.toMatchObject({ code: "not_found" });
      expect((await f.api.objects({ contact_id: otherContact, type_id: "veiculo" })).data).toEqual([]);
      await expect(f.api.create({ ...opening(f.contactId), object: selection })).rejects.toMatchObject({ code: "version_conflict" });
      await exec(env, "UPDATE os_objects SET archived=1 WHERE id=?", selection.id);
      await expect(f.api.create({ ...opening(f.contactId), object: { ...selection, version: 2 } })).rejects.toMatchObject({ code: "object_archived" });
      expect((await f.api.objects({ contact_id: f.contactId })).data).toEqual([]);
      expect((await f.api.objects({ contact_id: f.contactId, include_archived: "1" })).data).toHaveLength(1);
      (task.meta as Record<string, unknown>).os2Telas = { fixtures: "folhas simuladas; Worker e Coordinator reais", invocations: f.h.report.map(entry => ({ name: entry.name, worker: entry.worker_invoked, coordinators: entry.coordinators.length })) };
      expect(f.h.report.some(entry => entry.worker_invoked && entry.coordinators.length > 0)).toBe(true);
    });
  }, 120000);

  it("consulta requisitos estruturados, salva sem avançar e repete a transição com versão e intenção novas", async () => {
    const f = await setup();
    const type = { ...f.type, revision: 2, stage_field_rules: [{ field_id: "referencia", required_on_exit: ["entrada"] }] };
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const order = await f.api.create(opening(f.contactId));
    expect(order).toMatchObject({ stage: "entrada", version: 1 });
    expect(order.extra.referencia).toBeUndefined();
    expect(await f.api.requirements(order.id)).toMatchObject({ version: order.version, required: [], missing: [] });
    const count = await one(env, "SELECT COUNT(*) n FROM os_history WHERE order_id=?", order.id);
    await expect(f.api.stage(order.id, { version: order.version, transition_id: "iniciar" })).rejects.toMatchObject({ code: "missing_fields" });
    expect(await one(env, "SELECT COUNT(*) n FROM os_history WHERE order_id=?", order.id)).toEqual(count);
    expect(await f.api.order(order.id)).toMatchObject({ stage: "entrada", version: order.version, extra: order.extra });
    expect(await one(env, "SELECT stage_required_json FROM os_orders WHERE id=?", order.id)).toEqual({ stage_required_json: "[]" });
    const partial = await f.api.update(order.id, { version: order.version, extra: { ...order.extra, quilometragem: 61000 } });
    expect(partial).toMatchObject({ stage: "entrada", version: order.version + 1, extra: { quilometragem: 61000 } });
    expect(partial.extra.referencia).toBeUndefined();
    const { requirements } = await loadWorkRequirements(f.api, order.id, "iniciar");
    expect(requirements).toMatchObject({ version: partial.version, missing: [{ field_id: "referencia", label: "Referência" }] });
    const filled = await f.api.update(order.id, { version: requirements.version, extra: { ...partial.extra, referencia: "Conferida" } });
    expect(filled.stage).toBe("entrada");
    expect(filled.version).toBe(partial.version + 1);
    const moved = await f.api.stage(order.id, { version: filled.version, transition_id: "iniciar" });
    expect(moved.stage).toBe("execucao");
    expect(moved.version).toBe(filled.version + 1);
    expect(await f.api.requirements(order.id)).toMatchObject({ version: moved.version, required: [{ field_id: "referencia", label: "Referência" }], missing: [] });
    await expect(f.api.update(order.id, { version: moved.version, extra: { referencia: "" } })).rejects.toMatchObject({ code: "missing_fields" });
    expect(await f.api.order(order.id)).toMatchObject({ stage: "execucao", version: moved.version, extra: { referencia: "Conferida", quilometragem: 61000 } });
  }, 120000);

  it("mantém o modelo sem objeto e vincula legado encerrado sem reabrir, copiar privados ou mudar valores da ordem", async () => {
    const f = await setup(false);
    const plain = await f.api.create({ type_id: "projeto", phone: "5511960010203", item: "Consultoria", problem: "Escopo", notify: false, extra: { quilometragem: 42000 } });
    expect(plain.object).toBeUndefined();
    expect(plain.customer.contact_id).toBeFalsy();
    expect(await one(env, "SELECT COUNT(*) n FROM os_objects WHERE profile_id=?", f.profile)).toEqual({ n: 0 });
    await expect(f.api.create(opening(f.contactId))).rejects.toMatchObject({ code: "invalid_fields" });
    // Preparação de legado, não uma operação pública: contato já confirmado e
    // ordem encerrada antes da adoção do modelo com objeto.
    await exec(env, "UPDATE os_orders SET contact_id=?,status='delivered',stage='entregue',delivered_at=NULL WHERE id=?", f.contactId, plain.id);
    await perform(env, f.actor, f.profile, "settings", { os_work_types: [{ ...workType(), revision: 2 }], settings_revision: await settingsRevision(env, f.profile) }, uid());
    const current = await f.api.create(opening(f.contactId));
    const key = uid(), body = { version: plain.version, object: { mode: "existing", id: current.object!.object_id, version: 1 } };
    const linked = await f.call(`/service-orders/${plain.id}/object-link`, "POST", body, key);
    expect(linked).toMatchObject({ status: "delivered", extra: { quilometragem: 42000 }, object: { origin: "legacy_link" } });
    expect(await f.call(`/service-orders/${plain.id}/object-link`, "POST", body, key)).toMatchObject({ id: plain.id, version: linked.version });
    const detail = await f.api.object(current.object!.object_id);
    expect(detail.latest_completed).toMatchObject({ id: plain.id, delivered_at: null });
    const history = await f.api.objectOrders(current.object!.object_id);
    expect(history.data.map(row => row.id)).toEqual([current.id, plain.id]);
    expect(history.data.map(row => row.extra.quilometragem)).toEqual([60000, 42000]);
  }, 120000);

  it("transporta filtro próprio e cursor sem inventar total nem aceitar cursor de outra área", async () => {
    const f = await setup(), other = await setup();
    const first = await f.api.create(opening(f.contactId));
    await f.api.create({ ...opening(f.contactId), object: { mode: "existing", id: first.object!.object_id, version: 1 } });
    const filter: OrderFieldFilter = { ref: { scope: "object", field_id: "placa" }, operator: "eq", value: "abc1d23" };
    const page = await f.api.filteredOrders({ type_id: "projeto", field_filter: filter, limit: "1" });
    expect(page).toMatchObject({ counts: null, counts_scope: "not_computed", order_by: "number_desc" });
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    const next = await f.api.filteredOrders({ type_id: "projeto", field_filter: filter, limit: "1", cursor: page.next_cursor! });
    expect(next.data).toHaveLength(1);
    expect(next.data[0].id).not.toBe(page.data[0].id);
    expect(next.next_cursor).toBeNull();
    await expect(other.api.filteredOrders({ type_id: "projeto", field_filter: filter, limit: "1", cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  }, 120000);
});

describe("OS2 telas: formulário, cópias, navegação e apresentação", () => {
  it("conserva o formulário anterior para modelo sem objeto e exige contato apenas na nova abertura com objeto", () => {
    const plain = workType(false), tree: any = render(instance(), () => WorkFormDialog({ type: plain, onClose: vi.fn(), onSaved: vi.fn() }));
    expect(input(tree, "Cliente")).toBeDefined();
    expect(input(tree, "Telefone (WhatsApp)").props.required).toBe(true);
    expect(component(tree, ObjectPicker)).toBeUndefined();
    expect(ui.app.api).not.toHaveBeenCalled();
    expect(requiresCanonicalContact(plain)).toBe(false);
    expect(requiresCanonicalContact(workType())).toBe(true);
    expect(requiresCanonicalContact(workType(), { id: "legado" } as Order)).toBe(false);
  });

  it("confirma troca de titular, limpa seleção/inline e preserva os dados da visita", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const owner = instance(), draw = () => WorkFormDialog({ type: workType(), onClose: vi.fn(), onSaved: vi.fn() });
    let tree: any = render(owner, draw);
    const contactPicker = (value: any) => elements(value).find(node => node.type?.name === "OpeningContactPicker");
    contactPicker(tree).props.onChange({ id: "cliente-a", name: "Ana" });
    tree = render(owner, draw);
    input(tree, "Objeto").props.onChange("Revisão completa");
    component(tree, ExtraFields).props.onChange({ quilometragem: 65000 });
    component(tree, ObjectPicker).props.onType(vehicleType());
    component(tree, ObjectPicker).props.onChange({ mode: "new", type_id: "veiculo", values: { placa: "ABC1D23" } });
    tree = render(owner, draw);
    contactPicker(tree).props.onChange({ id: "cliente-b", name: "Bruno" });
    tree = render(owner, draw);
    expect(confirm).toHaveBeenCalledOnce();
    expect(component(tree, ObjectPicker).props.contactId).toBe("cliente-a");
    expect(component(tree, ObjectPicker).props.value.values.placa).toBe("ABC1D23");
    confirm.mockReturnValue(true);
    contactPicker(tree).props.onChange({ id: "cliente-b", name: "Bruno" });
    tree = render(owner, draw);
    expect(component(tree, ObjectPicker).props.contactId).toBe("cliente-b");
    expect(component(tree, ObjectPicker).props.value).toBeUndefined();
    expect(input(tree, "Objeto").props.value).toBe("Revisão completa");
    expect(component(tree, ExtraFields).props.values).toEqual({ quilometragem: 65000 });
    const source = { ...opening("cliente-a"), object: { mode: "existing" as const, id: "carro-a", version: 2 } };
    expect(changeOpeningContact(source, { id: "cliente-a" }).object).toEqual(source.object);
    expect(changeOpeningContact(source, { id: "cliente-b" }).object).toBeUndefined();
    expect(source.object.id).toBe("carro-a");
  });

  it("envia dados do objeto separados e bloqueia duplo clique enquanto a mesma intenção está em andamento", async () => {
    let resolve: (value: any) => void = () => {};
    ui.app.api = vi.fn(() => new Promise(done => { resolve = done; }));
    const saved = vi.fn(), owner = instance(), draw = () => WorkFormDialog({ type: workType(), onClose: vi.fn(), onSaved: saved });
    let tree: any = render(owner, draw);
    await expect(tree.props.onSubmit()).rejects.toThrow("contato");
    elements(tree).find(node => node.type?.name === "OpeningContactPicker").props.onChange({ id: "cliente-a", name: "Ana" });
    tree = render(owner, draw);
    input(tree, "Objeto").props.onChange("Revisão");
    input(tree, "Escopo").props.onChange("Conferir");
    component(tree, ObjectPicker).props.onType(vehicleType());
    component(tree, ObjectPicker).props.onChange({ mode: "new", type_id: "veiculo", values: { placa: " ABC1D23 ", cor: "Azul" } });
    component(tree, ExtraFields).props.onChange({ quilometragem: "65000" });
    tree = render(owner, draw);
    const pending = tree.props.onSubmit();
    await tree.props.onSubmit();
    expect(ui.app.api).toHaveBeenCalledOnce();
    expect(ui.app.api.mock.calls[0][2]).toMatchObject({ contact_id: "cliente-a", extra: { quilometragem: 65000 }, object: { mode: "new", values: { placa: " ABC1D23 ", cor: "Azul" } } });
    expect(ui.app.api.mock.calls[0][2].extra).not.toHaveProperty("placa");
    resolve({ id: "ordem", version: 1 });
    await pending;
    expect(saved).toHaveBeenCalledOnce();
  });

  it("recarrega conflito sem descartar o formulário nem escolher silenciosamente outra versão do objeto", async () => {
    ui.app.api = vi.fn(async () => { throw Object.assign(new Error("Alterado"), { status: 409, code: "version_conflict" }); });
    const owner = instance(), draw = () => WorkFormDialog({ type: workType(), onClose: vi.fn(), onSaved: vi.fn() });
    let tree: any = render(owner, draw);
    elements(tree).find(node => node.type?.name === "OpeningContactPicker").props.onChange({ id: "cliente" });
    tree = render(owner, draw);
    input(tree, "Objeto").props.onChange("Rascunho preservado");
    input(tree, "Escopo").props.onChange("Conferir");
    component(tree, ObjectPicker).props.onChange({ mode: "existing", id: "carro", version: 1 });
    tree = render(owner, draw);
    await expect(tree.props.onSubmit()).rejects.toMatchObject({ code: "version_conflict" });
    tree = render(owner, draw);
    expect(tree.props.disabled).toBe(true);
    expect(input(tree, "Objeto").props.value).toBe("Rascunho preservado");
    expect(component(tree, ObjectPicker).props.value).toEqual({ mode: "existing", id: "carro", version: 1 });
    const reload = elements(tree).find(node => node.props?.children === "Recarregar versão atual");
    await reload.props.onClick();
    tree = render(owner, draw);
    expect(tree.props.disabled).toBe(false);
    expect(component(tree, ObjectPicker).props.refreshKey).toBe(1);
    expect(component(tree, ObjectPicker).props.value.version).toBe(1);
  });

  it("oferece apenas objetos ativos do contato/tipo consultado e não reutiliza escolhas ao trocar contato", async () => {
    const object = { id: "a", contact_id: "cliente-a", type_id: "veiculo", type_revision: 1, type: vehicleType(), values: {}, identifier: "ABC1D23", archived: false, version: 3 };
    ui.app.identityKey = "area-a";
    ui.app.api = vi.fn(async (path: string) => path.includes("/object-types") ? { data: [vehicleType()] } : { data: path.includes("cliente-b") ? [] : [object, { ...object, id: "estranho", contact_id: "cliente-b" }, { ...object, id: "arquivado", archived: true }], next_cursor: null });
    const owner = instance(), onChange = vi.fn();
    let contactId = "cliente-a";
    const draw = () => ObjectPicker({ contactId, typeId: "veiculo", onChange });
    render(owner, draw); await tick();
    let tree = render(owner, draw);
    expect(input(tree, "Selecionar veículo").props.options.map((value: any) => value.id)).toEqual(["a", "__new"]);
    input(tree, "Selecionar veículo").props.onChange("a");
    expect(onChange).toHaveBeenLastCalledWith({ mode: "existing", id: "a", version: 3 });
    contactId = "cliente-b";
    tree = render(owner, draw);
    expect(input(tree, "Selecionar veículo")).toBeUndefined();
    await tick(); tree = render(owner, draw);
    expect(input(tree, "Selecionar veículo").props.options.map((value: any) => value.id)).toEqual(["__new"]);
    expect(ui.app.api.mock.calls.some((call: any[]) => call[0].includes("contact_id=cliente-b&type_id=veiculo"))).toBe(true);
    expect(parseObjectOpening({ mode: "existing", id: "a", version: 3 })).toEqual({ mode: "existing", id: "a", version: 3 });
    expect(() => parseObjectOpening({ mode: "new", type_id: "outro", values: {} }, vehicleType())).toThrow("Recarregue");
  });

  it("renderiza cópia somente leitura, vínculo posterior e destino atual sem dados sensíveis", () => {
    const html = renderToStaticMarkup(React.createElement(ObjectSnapshot, { snapshot: snapshot() }));
    expect(html).toContain("Veículo na abertura");
    expect(html).toContain("somente leitura");
    expect(html).toContain("Azul");
    expect(html).toContain("Ver cadastro atual e histórico");
    expect(html).toContain("/app/erp/modulos/objetos-de-servico/objeto%2F1");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("VALOR_PRIVADO");
    expect(html).not.toContain("NOME_PRIVADO");
    const later = renderToStaticMarkup(React.createElement(ObjectSnapshot, { snapshot: snapshot("legacy_link") }));
    expect(later).toContain("Vinculado posteriormente");
    expect(later).not.toContain("Capturado na abertura");
    expect(ui.app.api).not.toHaveBeenCalled();
  });

  it("limita a prévia de legado a definições compatíveis comuns e não copia dados da visita", () => {
    const type = vehicleType();
    type.fields.push(textField("quilometragem"), textField("combustivel"), textField("ultima_manutencao"));
    const source = { fields: [...type.fields], extra: { placa: "ABC1D23", cor: "Azul", reservado: "SIGILO", quilometragem: "65000", combustivel: "Metade", ultima_manutencao: "2020" } };
    expect(legacyObjectPreview(source, type).values).toEqual({ placa: "ABC1D23", cor: "Azul" });
    const privatePlate = { ...source, fields: source.fields.map(field => field.id === "placa" ? { ...field, sensitive: true } : field) };
    expect(legacyObjectPreview(privatePlate, type).values).not.toHaveProperty("placa");
    const changed = { ...type, fields: type.fields.map(field => field.id === "cor" ? textField("cor", "Cor", { max_length: 5 }) : field) };
    expect(legacyObjectPreview(source, changed).values).not.toHaveProperty("cor");
    const legacy = { id: "antiga", version: 2, type_id: "projeto", customer: { name: "Ana", contact_id: "cliente" }, ...source } as unknown as Order;
    const dialog: any = render(instance(), () => LegacyObjectLinkDialog({ order: legacy, type: workType(), onClose: vi.fn(), onSaved: vi.fn() }));
    expect(dialog.props.disabled).toBe(true);
    expect(component(dialog, ObjectPicker).props.contactId).toBe("cliente");
    expect(ui.app.api).not.toHaveBeenCalled();
  });

  it("mostra colunas pela cópia compatível, total indisponível e filtro tipado com zero/falso", () => {
    const type = { ...workType(), list_fields: [
      { ref: { scope: "object" as const, field_id: "cor" }, column: true, filter: true },
      { ref: { scope: "order" as const, field_id: "quilometragem" }, column: true, filter: true },
      { ref: { scope: "object" as const, field_id: "reservado" }, column: true },
    ] };
    const columns = workListFields(type, [vehicleType()]);
    expect(columns).toHaveLength(2);
    expect(workListFields()).toEqual([]);
    const order = { object: snapshot(), fields: type.fields, extra: { quilometragem: 60000 } } as unknown as Order;
    expect(workColumnValue(order, columns[0])).toBe("Azul");
    expect(workColumnValue({ ...order, object: undefined }, columns[0])).toBe("—");
    expect(workColumnValue({ ...order, object: { ...snapshot(), type: { ...snapshot().type, id: "outro_tipo" } } }, columns[0])).toBe("—");
    expect(workColumnValue({ ...order, object: { ...snapshot(), type: { ...snapshot().type, fields: [textField("cor", "Cor", { max_length: 4 })] } } }, columns[0])).toBe("—");
    expect(makeWorkFieldFilter(columns[1].ref, columns[1].field, "range", "0", "65000")).toEqual({ ref: columns[1].ref, operator: "range", from: 0, to: 65000 });
    expect(() => makeWorkFieldFilter(columns[1].ref, columns[1].field, "range", "20", "10")).toThrow();
    const boolean: WorkField = { id: "aceito", label: "Aceito", kind: "boolean", required: false, sensitive: false, client_visible: true, help: "" };
    expect(makeWorkFieldFilter({ scope: "order", field_id: "aceito" }, boolean, "eq", "false")).toMatchObject({ value: false });
    expect(workListCountLabel({ data: [], next_cursor: "continua", counts: null, counts_scope: "not_computed", order_by: "number_desc" })).toBe("Resultados paginados · total não calculado");
  });

  it("mostra data de conclusão ausente como indisponível e rejeita requisitos de versão desatualizada", async () => {
    const html = renderToStaticMarkup(React.createElement(ObjectLastCompleted, { completed: { id: "antiga", number: 7, delivered_at: null } }));
    expect(html).toContain("Ordem #7");
    expect(html).toContain("Data de conclusão indisponível");
    const none = renderToStaticMarkup(React.createElement(ObjectLastCompleted, { completed: null }));
    expect(none).toContain("Nenhuma ordem concluída registrada");
    const request = vi.fn(async (path: string) => path.includes("requirements")
      ? { id: "o", version: 1, required: [], missing: [{ field_id: "referencia", label: "Referência" }], internal_missing: false }
      : { id: "o", version: 2 });
    await expect(loadWorkRequirements(createWorkApi(request, "v1/profiles/a"), "o", "iniciar")).rejects.toThrow("mudou durante");
    expect(request.mock.calls[0][0]).toContain("requirements?transition_id=iniciar");
  });

  it("abre preenchimento de requisitos no detalhe e tenta novamente com versão e intenção novas", async () => {
    const transport = createOs2DemoApi(), api = createWorkApi(transport, "v1/profiles/demo");
    const order = await api.order("os-17");
    ui.app.root = "v1/profiles/demo"; ui.app.api = vi.fn(transport);
    const page = instance(), drawPage = () => WorkDetailPage({ workId: order.id });
    render(page, drawPage); await tick();
    const loaded: any = render(page, drawPage), detail = instance(), drawDetail = () => loaded.type(loaded.props);
    let tree = render(detail, drawDetail); await tick(); tree = render(detail, drawDetail);
    const next = order.next_stages.find(row => row.transition_id === "finalizar")!;
    const advance = elements(tree).find(node => node.type === Button && textOf(node).includes(next.stage_label));
    advance.props.onClick();
    await Promise.all(ui.pending.splice(0));
    tree = render(detail, drawDetail);
    const required = elements(tree).find(node => node.type?.name === "RequirementsDialog");
    expect(required).toBeDefined();
    expect(required.props.initial.requirements.missing).toEqual(expect.arrayContaining([expect.objectContaining({ field_id: "servico_executado" })]));
    expect(ui.app.api.mock.calls.some((call: any[]) => call[0].includes("requirements?transition_id=finalizar"))).toBe(true);
    const dialog = instance(), drawDialog = () => required.type(required.props);
    let form: any = render(dialog, drawDialog);
    component(form, ExtraFields).props.onChange({ ...order.extra, servico_executado: "Revisão concluída e conferida." });
    form = render(dialog, drawDialog);
    await form.props.onSubmit();
    const stages = ui.app.api.mock.calls.filter((call: any[]) => call[0].endsWith("/stage"));
    expect(stages).toHaveLength(2);
    expect(stages[1][2].version).toBeGreaterThan(stages[0][2].version);
    expect(stages[1][4]).not.toBe(stages[0][4]);
    expect((await api.order(order.id)).stage).toBe(next.stage);
  });

  it("pagina a lista filtrada mesmo com página vazia e remove filtro ao trocar modelo sem lookup por linha", async () => {
    const model = { ...workType(), list_fields: [{ ref: { scope: "object" as const, field_id: "placa" }, column: true, filter: true }] };
    const filter = { ref: { scope: "object" as const, field_id: "placa" }, operator: "eq" as const, value: "ABC1D23" };
    ui.app.settings.os_work_types = [model];
    ui.route.filters = { field_filter: JSON.stringify(filter), open: "0" };
    ui.app.api = vi.fn(async (path: string) => path.includes("/types") ? { data: [model], settings_revision: "1" }
      : { data: [], next_cursor: path.includes("cursor=pagina2") ? null : "pagina2", counts: null, counts_scope: "not_computed", order_by: "number_desc" });
    const page = instance(); render(page, WorkPage); await tick();
    const loaded: any = render(page, WorkPage), list = instance(), draw = () => loaded.type(loaded.props);
    render(list, draw); await tick();
    let tree = render(list, draw);
    expect(textOf(tree)).toContain("total não calculado");
    expect(component(tree, Pager).props.nextCursor).toBe("pagina2");
    component(tree, Pager).props.setCursor("pagina2");
    render(list, draw); await tick(); tree = render(list, draw);
    const request = ui.app.api.mock.calls.find((call: any[]) => call[0].includes("cursor=pagina2"));
    expect(request).toBeDefined();
    expect(JSON.parse(new URL("https://test/" + request[0]).searchParams.get("field_filter")!)).toEqual(filter);
    expect(component(tree, Pager).props.nextCursor).toBeNull();
    input(tree, "Modelo").props.onChange("");
    expect(ui.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ filters: expect.objectContaining({ field_filter: "", type_id: "", stage: "" }) }));
    expect(ui.app.api.mock.calls.some((call: any[]) => call[0].includes("/objects/"))).toBe(false);
  });

  it("resolve ficha do contato para objeto e ordem, preservando IDs opacos e rota única", () => {
    vi.stubGlobal("location", new URL("https://test/app/contatos/cliente?q=nao-propagar"));
    const objectHref = targetHref({ module: "os", resource: "objects", id: "objeto/1" });
    expect(objectHref).toBe("/app/erp/modulos/objetos-de-servico/objeto%2F1");
    expect(parseRoute(objectHref!)).toMatchObject({ area: "erp", page: "service-objects", id: "objeto/1" });
    expect(href({ area: "erp", page: "service-objects", id: "objeto/1" })).toBe(objectHref);
    expect(targetHref({ module: "os", resource: "orders", id: "ordem/1" })).toContain("ordem%2F1");
    for (const resource of ["service-orders", "works", "orders"]) {
      const orderHref = targetHref({ module: "os", resource, id: "ordem/1" });
      expect(orderHref).toBe("/app/erp/modulos/trabalhos/_/ordem%2F1");
      expect(parseRoute(orderHref!)).toMatchObject({ area: "erp", page: "work", typeId: "_", id: "ordem/1" });
    }
    vi.stubGlobal("location", new URL("https://test/app/contatos/cliente?demo=1&pair=teste&q=nao-propagar"));
    const demoObjectHref = targetHref({ module: "os", resource: "objects", id: "objeto/1" });
    expect(demoObjectHref).toBe(objectHref + "?demo=1&pair=teste");
    expect(href({ area: "erp", page: "service-objects", id: "objeto/1" })).toBe(demoObjectHref);
    expect(parseRoute(demoObjectHref!)).toMatchObject({ area: "erp", page: "service-objects", id: "objeto/1" });
    for (const resource of ["service-orders", "works", "orders"]) {
      const orderHref = targetHref({ module: "os", resource, id: "ordem/1" });
      expect(orderHref).toBe("/app/erp/modulos/trabalhos/_/ordem%2F1?demo=1&pair=teste");
      expect(parseRoute(orderHref!)).toMatchObject({ area: "erp", page: "work", typeId: "_", id: "ordem/1" });
    }
    expect(typeof ServiceObjectsPage).toBe("function");
  });
});

// A demonstração prova a consistência dos DTOs e cenários de apresentação. A
// autorização é exercitada separadamente acima, no Worker real.
describe("OS2 telas: demonstração completa", () => {
  it("oferece oficina, evento, consultoria, arquivo, histórico e última conclusão sem confundir a ficha atual", async () => {
    const demo = createWorkApi(createOs2DemoApi(), "v1/profiles/demo");
    const current = await demo.object("demo-vehicle-1");
    expect(current.values.cor).toBe("Azul");
    const history = await demo.objectOrders(current.id);
    expect(history.data.map(order => order.extra.quilometragem)).toEqual(expect.arrayContaining([60000, 65000]));
    expect(history.data.every(order => order.object?.values.cor === "Prata")).toBe(true);
    expect(current.latest_completed?.id).toBe("os-18");
    expect(current.latest_completed?.delivered_at).toBeTruthy();
    expect((await demo.object("demo-vehicle-archived")).archived).toBe(true);
    expect((await demo.objects({ contact_id: "contact-demo-1", type_id: current.type_id })).data.every(object => !object.archived)).toBe(true);
    expect((await demo.objects({ contact_id: "contact-demo-2", type_id: current.type_id })).data).toEqual([]);
    expect((await demo.order("os-19")).object?.object_id).toBe("demo-event-1");
    expect((await demo.order("os-20")).object).toBeUndefined();
    const missing = await demo.requirements("os-17", "finalizar");
    expect(missing.missing.map(field => field.field_id)).toContain("servico_executado");
    const order = await demo.order("os-17");
    await expect(demo.stage(order.id, { transition_id: "finalizar", version: order.version })).rejects.toMatchObject({ code: "missing_fields" });
  });

  it("pagina filtro próprio sem total e conserva idempotência do cadastro inline simulado", async () => {
    const transport = createOs2DemoApi(), demo = createWorkApi(transport, "v1/profiles/demo");
    const query = { type_id: "area_oficina_mecanica__at_veiculos", field_filter: { ref: { scope: "object" as const, field_id: "placa" }, operator: "eq" as const, value: "ABC1D23" }, limit: "1" };
    const first = await demo.filteredOrders(query);
    expect(first).toMatchObject({ counts: null, counts_scope: "not_computed" });
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    const next = await demo.filteredOrders({ ...query, cursor: first.next_cursor! });
    expect(next.data).toHaveLength(1);
    expect(next.data[0].id).not.toBe(first.data[0].id);
    const type = (await demo.object("demo-vehicle-1")).type_id;
    const body = { ...opening("contact-demo-1"), type_id: query.type_id, object: { mode: "new" as const, type_id: type, values: { placa: "XYZ9A87" } }, extra: {} };
    const path = "v1/profiles/demo/service-orders";
    const opened = await transport(path, "POST", body, undefined, "telas-demo-replay");
    expect(await transport(path, "POST", body, undefined, "telas-demo-replay")).toMatchObject({ id: opened.id, object: { object_id: opened.object.object_id } });
    const choices = await demo.objects({ contact_id: "contact-demo-1", type_id: type });
    expect(choices.data.filter(object => object.id === opened.object.object_id)).toHaveLength(1);
  });
});
