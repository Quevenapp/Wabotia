import { ApiError } from "../types";
import { moduleById, modules as registeredModules } from "../modules/registry";
import { OS_STATUSES, QUOTABLE } from "../modules/os/model";
import { validateField, validateObjectTypes, validateWorkType, validateWorkTypeChanges } from "../modules/os/validation";
import type { AreaTemplate as WorkAreaTemplate, AreaTemplateSelection as WorkAreaTemplateSelection, AreaSetup, CustomWorkType } from "../modules/os/contracts";

// O contrato compartilhado ainda enumera apenas os módulos anteriores à fase 2.
// A lista aceita em runtime vem exclusivamente do registro de módulos embutidos.
/**
 * Itens de menu que abrem a tela real de um módulo pelo WhatsApp (sem campos
 * extras). Só entram quando o módulo dono está ligado no próprio manifesto:
 * nenhum menu promete o que o modelo não liga.
 */
export const TEMPLATE_MODULE_MENU_TYPES = [
  "agenda", "agenda_mine", "mensalidade_list", "mensalidade_copy", "reserva", "reserva_mine",
  "pedido_cardapio", "pedido_acompanhar", "ensino_boletim", "cond_unit", "entrega_onde", "queue",
] as const;
export type TemplateModuleMenuType = typeof TEMPLATE_MODULE_MENU_TYPES[number];
export type AreaTemplateMenu = WorkAreaTemplate["menus"][number] | { id: string; label: string; type: TemplateModuleMenuType };
export const isModuleMenuType = (type: unknown): type is TemplateModuleMenuType =>
  (TEMPLATE_MODULE_MENU_TYPES as readonly unknown[]).includes(type);
/** Módulo dono de um tipo de menu de módulo. */
export const moduleOfMenuType = (type: string) =>
  registeredModules.find((module) => module.menu_item_types.some((item) => item.type === type))?.id ?? null;
export type AreaTemplate = Omit<WorkAreaTemplate, "modules" | "menus"> & { modules: Partial<Record<string, boolean>>; menus: AreaTemplateMenu[] };
export type AreaTemplateSelection = Omit<WorkAreaTemplateSelection, "module_ids"> & { module_ids: string[] };
const allowedModules = () => registeredModules.filter((module) => module.builtin).map((module) => module.id);
function moduleIdentifier(value: unknown, path: string): string {
  const id = string(value, 64, path);
  invalid(/^[a-z][a-z0-9_-]*$/.test(id) && moduleById(id)?.builtin, path);
  return id;
}

export const TEMPLATE_BYTES = 128 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function invalid(condition: unknown, path: string): asserts condition {
  if (!condition) throw new ApiError(400, "invalid_template", `Modelo inválido em ${path}.`);
}
export function object(value: unknown, keys: string[], path: string): Record<string, any> {
  invalid(value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), path);
  invalid(Object.keys(value).every((key) => keys.includes(key)), path);
  return value as Record<string, any>;
}
export function string(value: unknown, max: number, path: string, empty = false): string {
  invalid(typeof value === "string", path);
  const result = value.trim();
  invalid((empty || result.length > 0) && Array.from(result).length <= max, path);
  // Texto declarativo: nunca recebe HTML nem uma URL que execute código.
  invalid(!/<\/?[a-z!][^>]*>|(?:javascript|vbscript)\s*:|data\s*:\s*(?:text\/html|image\/svg\+xml)/i.test(result), path);
  return result;
}
export function identifier(value: unknown, max: number, path: string): string {
  const id = string(value, max, path);
  invalid(/^[a-z][a-z0-9_]*$/.test(id) && !["constructor", "prototype", "__proto__"].includes(id), path);
  return id;
}
function integer(value: unknown, min: number, max: number, path: string): number {
  invalid(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, path);
  return value;
}
function boolean(value: unknown, path: string): boolean {
  invalid(typeof value === "boolean", path);
  return value;
}
export function list<T>(value: unknown, max: number, path: string, read: (v: any, p: string) => T): T[] {
  invalid(Array.isArray(value) && value.length <= max, path);
  return value.map((v, i) => read(v, `${path}[${i}]`));
}
function unique<T extends { id: string }>(items: T[], path: string): T[] {
  invalid(new Set(items.map((item) => item.id)).size === items.length, path);
  return items;
}
const ids = (value: unknown, max: number, path: string, length = 32) => {
  const result = list(value, max, path, (v, p) => identifier(v, length, p));
  invalid(new Set(result).size === result.length, path);
  return result;
};
const statuses: readonly string[] = OS_STATUSES;
const quotable: readonly string[] = QUOTABLE;
const terminal = (status: string) => status === "delivered" || status === "cancelled";
/** Validação do manifesto isolado; revisões contra a área passam também pelo planejador de M/F0. */
export function validateTemplateWorkType(value: unknown, path = "work_type"): CustomWorkType {
  const v = object(value, ["schema_version", "kind", "id", "revision", "archived", "labels", "number_prefix", "terms", "fields", "retired_field_ids", "stages", "retired_stage_ids", "initial_stage", "transitions", "features", "pickup_reminder_text", "object_type_id", "stage_field_rules", "list_fields"], path);
  invalid(v.schema_version === 1 && v.kind === "custom", path);
  v.id = identifier(v.id, 64, `${path}.id`);
  invalid(v.id !== "service_order", `${path}.id`);
  integer(v.revision, 1, Number.MAX_SAFE_INTEGER, `${path}.revision`);
  boolean(v.archived, `${path}.archived`);
  const labels = object(v.labels, ["singular", "plural", "item", "problem", "customer_singular", "customer_plural"], `${path}.labels`);
  for (const key of ["singular", "plural", "item", "problem", "customer_singular", "customer_plural"])
    labels[key] = string(labels[key], 80, `${path}.labels.${key}`);
  v.number_prefix = string(v.number_prefix, 12, `${path}.number_prefix`, true);
  if (v.terms !== null) v.terms = string(v.terms, 1400, `${path}.terms`, true);
  v.fields = unique(list(v.fields, 24, `${path}.fields`, (field, p) => {
    try { return validateField(field, p); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw new ApiError(error.status, "invalid_template", `Modelo inválido em ${p}. ${error.message}`);
    }
  }), `${path}.fields`);
  v.retired_field_ids = ids(v.retired_field_ids, 12 * 1024, `${path}.retired_field_ids`);
  v.retired_stage_ids = ids(v.retired_stage_ids, 12 * 1024, `${path}.retired_stage_ids`);
  v.stages = unique(list(v.stages, 32, `${path}.stages`, (stage, p) => {
    const s = object(stage, ["id", "label", "base_status", "message"], p);
    invalid(statuses.includes(s.base_status), `${p}.base_status`);
    return { id: identifier(s.id, 32, `${p}.id`), label: string(s.label, 80, `${p}.label`), base_status: s.base_status, message: string(s.message, 900, `${p}.message`, true) };
  }), `${path}.stages`);
  const t = v as CustomWorkType;
  invalid(t.fields.every((f) => !t.retired_field_ids.includes(f.id)) && t.stages.every((s) => !t.retired_stage_ids.includes(s.id)), path);
  const stage = (id: unknown) => t.stages.find((s) => s.id === id);
  invalid(stage(v.initial_stage)?.base_status === "received", `${path}.initial_stage`);
  v.transitions = unique(list(v.transitions, 128, `${path}.transitions`, (transition, p) => {
    const tr = object(transition, ["id", "from", "to", "label", "kind", ...(transition?.kind === "customer_approval" ? ["valid_hours", "request_text"] : [])], p);
    tr.id = identifier(tr.id, 32, `${p}.id`);
    tr.label = string(tr.label, 80, `${p}.label`);
    invalid(["manual", "customer_approval"].includes(tr.kind) && stage(tr.from) && stage(tr.to) && tr.from !== tr.to && !terminal(stage(tr.from)!.base_status), p);
    if (tr.kind === "customer_approval") {
      integer(tr.valid_hours, 1, 720, `${p}.valid_hours`);
      tr.request_text = string(tr.request_text, 900, `${p}.request_text`);
    }
    return tr as CustomWorkType["transitions"][number];
  }), `${path}.transitions`);
  const f = object(v.features, ["customer_open", "tasks", "people", "documents", "entries", "quote", "warranty_days", "pickup_reminder_days", "stale_days"], `${path}.features`);
  for (const key of ["customer_open", "tasks", "people", "documents", "entries"]) boolean(f[key], `${path}.features.${key}`);
  integer(f.warranty_days, 0, 3650, `${path}.features.warranty_days`);
  for (const key of ["pickup_reminder_days", "stale_days"]) integer(f[key], 0, 365, `${path}.features.${key}`);
  invalid(!f.customer_open || t.fields.every((field) => !field.required || (field.client_visible && !field.sensitive)), `${path}.fields`);
  invalid(!f.pickup_reminder_days || t.stages.some((s) => s.base_status === "ready"), `${path}.features.pickup_reminder_days`);
  const edges = t.transitions.map((tr) => [tr.from, tr.to]);
  if (f.quote === null) invalid(t.stages.every((s) => !["quoted", "approved", "declined"].includes(s.base_status)), `${path}.features.quote`);
  else {
    const q = object(f.quote, ["default_valid_days", "source_stages", "sent_stage", "approved_stage", "declined_stage", "edited_stage"], `${path}.features.quote`);
    integer(q.default_valid_days, 1, 365, `${path}.features.quote.default_valid_days`);
    q.source_stages = ids(q.source_stages, 32, `${path}.features.quote.source_stages`);
    invalid(q.source_stages.length > 0 && q.source_stages.every((id: string) => quotable.includes(stage(id)?.base_status || "")), `${path}.features.quote.source_stages`);
    for (const [key, status] of [["sent_stage", "quoted"], ["approved_stage", "approved"], ["declined_stage", "declined"], ["edited_stage", "analyzing"]])
      invalid(stage(q[key])?.base_status === status, `${path}.features.quote.${key}`);
    invalid(t.transitions.every((tr) => !["quoted", "approved", "declined"].includes(stage(tr.to)!.base_status) &&
      (tr.from !== q.sent_stage || stage(tr.to)!.base_status === "cancelled")), `${path}.transitions`);
    for (const id of q.source_stages) if (id !== q.sent_stage) edges.push([id, q.sent_stage]);
    edges.push([q.sent_stage, q.approved_stage], [q.sent_stage, q.declined_stage], [q.sent_stage, q.edited_stage]);
  }
  const reachable = (start: string) => {
    const seen = new Set([start]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [from, to] of edges) if (seen.has(from) && !seen.has(to)) { seen.add(to); changed = true; }
    }
    return seen;
  };
  const reached = reachable(t.initial_stage);
  invalid(t.stages.every((s) => reached.has(s.id)), `${path}.stages`);
  for (const s of t.stages.filter((s) => !terminal(s.base_status))) {
    const exits = reachable(s.id);
    invalid(["delivered", "cancelled"].every((status) => t.stages.some((end) => end.base_status === status && exits.has(end.id))), `${path}.stages`);
  }
  v.pickup_reminder_text = string(v.pickup_reminder_text, 900, `${path}.pickup_reminder_text`, true);
  const markers = new Set(["numero", "item", "estado", "total", "validade", "garantia", "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador", "objeto",
    ...t.fields.filter((field) => field.client_visible && !field.sensitive).map((field) => `campo_${field.id}`)]);
  for (const message of [t.pickup_reminder_text, ...t.stages.map((s) => s.message), ...t.transitions.flatMap((tr) => tr.kind === "customer_approval" ? [tr.request_text] : [])]) {
    invalid([...message.matchAll(/\{([^{}]*)\}/g)].every((match) => markers.has(match[1])) && !/[{}]/.test(message.replace(/\{[^{}]*\}/g, "")), `${path}.messages`);
  }
  invalid(bytes(t) <= 12 * 1024, path);
  try { return validateWorkType(t); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(error.status, "invalid_template", `Modelo inválido em ${path}. ${error.message}`);
  }
}

function vocabulary(value: unknown, path: string) {
  const v = object(value, ["collection_label", "customer_singular", "customer_plural"], path);
  return { collection_label: string(v.collection_label, 80, path), customer_singular: string(v.customer_singular, 80, path), customer_plural: string(v.customer_plural, 80, path) };
}
function bot(value: unknown, path: string): AreaSetup["bot"] {
  const v = object(value, ["instructions", "allowed_operations", "denied_operations", "suggested_roles"], path);
  const strings = (key: string) => list(v[key], 200, `${path}.${key}`, (entry, p) => string(entry, 120, p));
  return { instructions: string(v.instructions, 16000, `${path}.instructions`, true), allowed_operations: strings("allowed_operations"), denied_operations: strings("denied_operations"), suggested_roles: strings("suggested_roles") };
}
const steps = (value: unknown, path: string) => list(value, 100, path, (entry, p) => string(entry, 2000, p));

export function validateAreaSetup(value: unknown): AreaSetup[] {
  const result = list(value, 100, "os_area_setup", (entry, p) => {
    const v = object(entry, ["template_id", "bot", "manual_steps"], p);
    return { template_id: identifier(v.template_id, 32, `${p}.template_id`), bot: bot(v.bot, `${p}.bot`), manual_steps: steps(v.manual_steps, `${p}.manual_steps`) };
  });
  invalid(new Set(result.map((entry) => entry.template_id)).size === result.length, "os_area_setup");
  return result;
}

/** Aceita somente JSON, limita bytes e clona antes de normalizar o manifesto. */
export function validateAreaTemplate(input: unknown): AreaTemplate {
  // Recusa também toJSON/getters em chamadas internas, antes de JSON.stringify.
  const ancestors = new Set<object>();
  const jsonOnly = (value: unknown, depth: number): void => {
    invalid(depth <= 32, "manifest");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") { invalid(Number.isFinite(value), "manifest"); return; }
    invalid(value && typeof value === "object" && !ancestors.has(value), "manifest");
    invalid(Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype) || Object.getPrototypeOf(value) === null, "manifest");
    invalid(Object.getOwnPropertySymbols(value).length === 0, "manifest");
    ancestors.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === "length") continue;
      invalid("value" in descriptor && descriptor.enumerable, "manifest");
      jsonOnly(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  jsonOnly(input, 0);
  let raw: string;
  try { raw = JSON.stringify(input, (_key, value) => {
    invalid(value !== undefined && typeof value !== "function" && typeof value !== "symbol" && typeof value !== "bigint" &&
      (typeof value !== "number" || Number.isFinite(value)), "manifest");
    return value;
  }); } catch { throw new ApiError(400, "invalid_template", "Informe um manifesto JSON declarativo."); }
  invalid(typeof raw === "string", "manifest");
  if (new TextEncoder().encode(raw).length > TEMPLATE_BYTES)
    throw new ApiError(413, "template_too_large", "O manifesto deve ter até 128 KiB em UTF-8.");
  const v = object(JSON.parse(raw), ["schema_version", "id", "version", "name", "description", "work_types", "object_types", "modules", "vocabulary", "departments", "ticket_categories", "menus", "texts", "bot", "manual_steps"], "manifest");
  invalid(v.schema_version === 1, "schema_version");
  v.id = identifier(v.id, 32, "id");
  v.version = integer(v.version, 1, Number.MAX_SAFE_INTEGER, "version");
  v.name = string(v.name, 80, "name");
  v.description = string(v.description, 2000, "description", true);
  v.work_types = unique(list(v.work_types, 20, "work_types", validateTemplateWorkType), "work_types");
  if (Object.hasOwn(v, "object_types")) {
    try { v.object_types = validateObjectTypes(v.object_types); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw new ApiError(error.status, "invalid_template", `Tipos de objeto inválidos. ${error.message}`);
    }
    for (const type of v.object_types) {
      invalid(type.revision === 1, `object_types.${type.id}.revision`);
      invalid(`area_${v.id}__${type.id}`.length <= 64, `object_types.${type.id}.id`);
      invalid(bytes({ ...type, id: `area_${v.id}__${type.id}` }) <= 8 * 1024, `object_types.${type.id}`);
    }
  }
  try { validateWorkTypeChanges({}, { os_work_types: v.work_types, os_object_types: v.object_types ?? [] }); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(error.status, "invalid_template", `Referências de campos inválidas. ${error.message}`);
  }
  for (const type of v.work_types) {
    invalid(type.revision === 1, `work_types.${type.id}.revision`);
    invalid(`area_${v.id}__${type.id}`.length <= 64, `work_types.${type.id}.id`);
    invalid(bytes({ ...type, id: `area_${v.id}__${type.id}`, ...(type.object_type_id ? { object_type_id: `area_${v.id}__${type.object_type_id}` } : {}) }) <= 12 * 1024, `work_types.${type.id}`);
  }
  object(v.modules, allowedModules(), "modules");
  for (const [id, enabled] of Object.entries(v.modules)) {
    moduleIdentifier(id, `modules.${id}`);
    boolean(enabled, `modules.${id}`);
  }
  // Cada módulo ligado declara seus requisitos ligados no próprio manifesto.
  // Conferir todas as entradas também exige o fechamento transitivo completo.
  for (const [id, enabled] of Object.entries(v.modules)) if (enabled)
    for (const required of moduleById(id)!.requires || [])
      invalid(v.modules[required] === true, `modules.${id}.requires.${required}`);
  v.vocabulary = vocabulary(v.vocabulary, "vocabulary");
  for (const key of ["departments", "ticket_categories"]) v[key] = unique(list(v[key], 100, key, (entry, p) => {
    const item = object(entry, ["id", "name", "enabled", ...(key === "departments" ? ["members"] : [])], p);
    invalid(item.enabled === true, `${p}.enabled`);
    if (key === "departments") invalid(Array.isArray(item.members) && item.members.length === 0, `${p}.members`);
    return { ...item, id: identifier(item.id, 64, `${p}.id`), name: string(item.name, 80, `${p}.name`) };
  }), key);
  v.menus = unique(list(v.menus, 200, "menus", (entry, p) => {
    const extra: Record<string, string[]> = { os_open: ["type_id"], os_track: ["type_id"], human: ["department_id"], message: ["content"],
      ...Object.fromEntries(TEMPLATE_MODULE_MENU_TYPES.map((type) => [type, []])) };
    invalid(entry && typeof entry.type === "string" && Object.hasOwn(extra, entry.type), `${p}.type`);
    const menu = object(entry, ["id", "label", "type", ...extra[entry.type]], p);
    menu.id = identifier(menu.id, 64, `${p}.id`);
    menu.label = string(menu.label, 80, `${p}.label`);
    if (isModuleMenuType(menu.type)) invalid(v.modules[moduleOfMenuType(menu.type) ?? ""] === true, `${p}.type`);
    else if (menu.type === "message") menu.content = string(menu.content, 3500, `${p}.content`);
    else if (menu.type === "human") invalid(menu.department_id === null || v.departments.some((d: any) => d.id === menu.department_id), `${p}.department_id`);
    else invalid(menu.type_id === "service_order" || v.work_types.some((t: CustomWorkType) => t.id === menu.type_id), `${p}.type_id`);
    return menu as AreaTemplate["menus"][number];
  }), "menus");
  for (const key of ["departments", "ticket_categories", "menus"]) for (const item of v[key])
    invalid(`area_${v.id}__${item.id}`.length <= 100, `${key}.${item.id}.id`);
  object(v.texts, ["instructions", "menu_greeting", "protocol_confirmation"], "texts");
  for (const [key, max] of [["instructions", 16000], ["menu_greeting", 900], ["protocol_confirmation", 1500]] as const)
    if (Object.hasOwn(v.texts, key)) v.texts[key] = string(v.texts[key], max, `texts.${key}`, true);
  v.bot = bot(v.bot, "bot");
  v.manual_steps = steps(v.manual_steps, "manual_steps");
  return v as AreaTemplate;
}

export function validateSelection(input: unknown, manifest: AreaTemplate): AreaTemplateSelection {
  const v = object(input, ["work_type_ids", "module_ids", "menus", "departments", "ticket_categories", "vocabulary", "texts", "bot_suggestions"], "selection");
  const work = ids(v.work_type_ids, 21, "selection.work_type_ids", 64).sort();
  const modules = list(v.module_ids, allowedModules().length, "selection.module_ids", moduleIdentifier).sort();
  invalid(new Set(modules).size === modules.length, "selection.module_ids");
  invalid(work.every((id) => id === "service_order" || manifest.work_types.some((t) => t.id === id)), "selection.work_type_ids");
  invalid(modules.every((id) => Object.hasOwn(manifest.modules, id)), "selection.module_ids");
  for (const key of ["menus", "departments", "ticket_categories", "vocabulary", "texts", "bot_suggestions"]) boolean(v[key], `selection.${key}`);
  return { ...v, work_type_ids: work, module_ids: modules } as AreaTemplateSelection;
}
