import { ApiError } from "../types";
import { moduleById } from "../modules/registry";
import { OS_STATUSES, QUOTABLE } from "../modules/os/model";
import type { AreaTemplate, AreaTemplateSelection, AreaSetup, CustomWorkType } from "../modules/os/contracts";

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
function date(value: unknown, path: string): string | null {
  if (value === null) return null;
  invalid(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), path);
  const parsed = new Date(`${value}T00:00:00Z`);
  invalid(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, path);
  return value;
}

/** Validação do manifesto isolado; revisões contra a área passam também pelo planejador de M/F0. */
export function validateTemplateWorkType(value: unknown, path = "work_type"): CustomWorkType {
  const v = object(value, ["schema_version", "kind", "id", "revision", "archived", "labels", "number_prefix", "terms", "fields", "retired_field_ids", "stages", "retired_stage_ids", "initial_stage", "transitions", "features", "pickup_reminder_text"], path);
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
    const common = ["id", "label", "help", "required", "client_visible", "sensitive", "kind"];
    const variants: Record<string, string[]> = { text: ["multiline", "max_length"], integer: ["min", "max"], decimal: ["min", "max", "scale"], boolean: [], date: ["min", "max"], choice: ["options"] };
    invalid(field && Object.hasOwn(variants, field.kind), `${p}.kind`);
    const f = object(field, [...common, ...variants[field.kind]], p);
    f.id = identifier(f.id, 32, `${p}.id`);
    f.label = string(f.label, 80, `${p}.label`);
    f.help = string(f.help, 240, `${p}.help`, true);
    for (const key of ["required", "client_visible", "sensitive"]) boolean(f[key], `${p}.${key}`);
    invalid(!f.sensitive || (!f.required && !f.client_visible), p);
    if (f.kind === "text") {
      boolean(f.multiline, `${p}.multiline`);
      integer(f.max_length, 1, 2000, `${p}.max_length`);
    } else if (f.kind === "integer" || f.kind === "decimal") {
      invalid(typeof f.min === "number" && typeof f.max === "number" && Number.isFinite(f.min) && Number.isFinite(f.max) && f.min <= f.max, p);
      if (f.kind === "integer") invalid(Number.isSafeInteger(f.min) && Number.isSafeInteger(f.max), p);
      else integer(f.scale, 0, 6, `${p}.scale`);
    } else if (f.kind === "date") {
      f.min = date(f.min, `${p}.min`); f.max = date(f.max, `${p}.max`);
      invalid(f.min === null || f.max === null || f.min <= f.max, p);
    } else if (f.kind === "choice") {
      f.options = unique(list(f.options, 32, `${p}.options`, (option, q) => {
        const o = object(option, ["id", "label"], q);
        return { id: identifier(o.id, 32, `${q}.id`), label: string(o.label, 80, `${q}.label`) };
      }), `${p}.options`);
      invalid(f.options.length > 0, `${p}.options`);
    }
    return f as CustomWorkType["fields"][number];
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
  const markers = new Set(["numero", "item", "estado", "total", "validade", "garantia", "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador",
    ...t.fields.filter((field) => field.client_visible && !field.sensitive).map((field) => `campo_${field.id}`)]);
  for (const message of [t.pickup_reminder_text, ...t.stages.map((s) => s.message), ...t.transitions.flatMap((tr) => tr.kind === "customer_approval" ? [tr.request_text] : [])]) {
    invalid([...message.matchAll(/\{([^{}]*)\}/g)].every((match) => markers.has(match[1])) && !/[{}]/.test(message.replace(/\{[^{}]*\}/g, "")), `${path}.messages`);
  }
  invalid(bytes(t) <= 12 * 1024, path);
  return t;
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
  const v = object(JSON.parse(raw), ["schema_version", "id", "version", "name", "description", "work_types", "modules", "vocabulary", "departments", "ticket_categories", "menus", "texts", "bot", "manual_steps"], "manifest");
  invalid(v.schema_version === 1, "schema_version");
  v.id = identifier(v.id, 32, "id");
  v.version = integer(v.version, 1, Number.MAX_SAFE_INTEGER, "version");
  v.name = string(v.name, 80, "name");
  v.description = string(v.description, 2000, "description", true);
  v.work_types = unique(list(v.work_types, 20, "work_types", validateTemplateWorkType), "work_types");
  for (const type of v.work_types) {
    invalid(type.revision === 1, `work_types.${type.id}.revision`);
    invalid(`area_${v.id}__${type.id}`.length <= 64, `work_types.${type.id}.id`);
    invalid(bytes({ ...type, id: `area_${v.id}__${type.id}` }) <= 12 * 1024, `work_types.${type.id}`);
  }
  object(v.modules, ["os", "queue", "forms", "agenda", "reserva", "pedido", "mensalidade", "suporte", "mesas", "entrega", "payments", "erp"], "modules");
  for (const [id, enabled] of Object.entries(v.modules)) { invalid(moduleById(id), `modules.${id}`); boolean(enabled, `modules.${id}`); }
  v.vocabulary = vocabulary(v.vocabulary, "vocabulary");
  for (const key of ["departments", "ticket_categories"]) v[key] = unique(list(v[key], 100, key, (entry, p) => {
    const item = object(entry, ["id", "name", "enabled", ...(key === "departments" ? ["members"] : [])], p);
    invalid(item.enabled === true, `${p}.enabled`);
    if (key === "departments") invalid(Array.isArray(item.members) && item.members.length === 0, `${p}.members`);
    return { ...item, id: identifier(item.id, 64, `${p}.id`), name: string(item.name, 80, `${p}.name`) };
  }), key);
  v.menus = unique(list(v.menus, 200, "menus", (entry, p) => {
    const extra: Record<string, string[]> = { os_open: ["type_id"], os_track: ["type_id"], human: ["department_id"], message: ["content"] };
    invalid(entry && Object.hasOwn(extra, entry.type), `${p}.type`);
    const menu = object(entry, ["id", "label", "type", ...extra[entry.type]], p);
    menu.id = identifier(menu.id, 64, `${p}.id`);
    menu.label = string(menu.label, 80, `${p}.label`);
    if (menu.type === "message") menu.content = string(menu.content, 3500, `${p}.content`);
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
  const modules = ids(v.module_ids, 12, "selection.module_ids").sort();
  invalid(work.every((id) => id === "service_order" || manifest.work_types.some((t) => t.id === id)), "selection.work_type_ids");
  invalid(modules.every((id) => Object.hasOwn(manifest.modules, id) && moduleById(id)), "selection.module_ids");
  for (const key of ["menus", "departments", "ticket_categories", "vocabulary", "texts", "bot_suggestions"]) boolean(v[key], `selection.${key}`);
  return { ...v, work_type_ids: work, module_ids: modules } as AreaTemplateSelection;
}
