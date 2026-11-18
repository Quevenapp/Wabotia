// Validação declarativa do motor. Erros identificam caminhos, nunca valores.
import { ApiError } from "../../types";
import type { CustomWorkType, ExtraValues, OsVocabulary, WorkField } from "./contracts";
import { CLOSED, isStatus, QUOTABLE } from "./model";

function check(ok: unknown, path: string, code = "invalid_request"): asserts ok {
  if (!ok) throw new ApiError(400, code, `Trabalho: ${path} inválido.`);
}
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function object(value: any, keys: string[], path: string) {
  check(value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), path);
  for (const key of Object.keys(value)) check(keys.includes(key), `${path}.${key}`);
  return value;
}
function text(value: unknown, max: number, path: string, empty = false): string {
  check(typeof value === "string", path);
  const out = value.trim();
  check((empty || out.length) && Array.from(out).length <= max, path);
  check(!/<\/?[a-z!]|(?:javascript|vbscript)\s*:|data\s*:\s*(?:text\/html|image\/svg\+xml|application\/(?:javascript|xhtml\+xml))|\$\{|\{\{/i.test(out), path);
  return out;
}
function id(value: unknown, path: string, max = 32, fieldId = false) {
  const out = text(value, max, path);
  check(/^[a-z][a-z0-9_]*$/.test(out) && (path !== "type.id" || out !== "service_order") && (!fieldId || !["constructor", "prototype", "__proto__"].includes(out)), path);
  return out;
}
function integer(value: unknown, min: number, max: number, path: string): number {
  check(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, path);
  return value as number;
}
function bool(value: unknown, path: string): boolean {
  check(typeof value === "boolean", path);
  return value;
}
function array(value: any, max: number, path: string): any[] {
  check(Array.isArray(value) && value.length <= max, path);
  return value;
}
function unique(values: string[], path: string) { check(new Set(values).size === values.length, path); }
export function civilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const d = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function scaleFits(value: number, scale: number) {
  const [mantissa, exp = "0"] = String(value).toLowerCase().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exp)) <= scale;
}
function field(raw: any, path: string): WorkField {
  const variants: Record<string, string[]> = { text: ["multiline", "max_length"], integer: ["min", "max"], decimal: ["min", "max", "scale"], boolean: [], date: ["min", "max"], choice: ["options"] };
  check(raw && Object.hasOwn(variants, raw.kind), path);
  object(raw, ["id", "label", "help", "required", "client_visible", "sensitive", "kind", ...variants[raw.kind]], path);
  const out: any = { ...raw, id: id(raw.id, path + ".id", 32, true), label: text(raw.label, 80, path + ".label"), help: text(raw.help, 240, path + ".help", true) };
  for (const key of ["required", "client_visible", "sensitive"]) out[key] = bool(raw[key], path + "." + key);
  check(!out.sensitive || (!out.required && !out.client_visible), path + ".sensitive");
  switch (out.kind) {
    case "text":
      out.multiline = bool(out.multiline, path + ".multiline");
      out.max_length = integer(out.max_length, 1, 2000, path + ".max_length"); break;
    case "integer":
      integer(out.min, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, path + ".min");
      integer(out.max, out.min, Number.MAX_SAFE_INTEGER, path + ".max"); break;
    case "decimal":
      integer(out.scale, 0, 6, path + ".scale");
      check(typeof out.min === "number" && typeof out.max === "number" && Number.isFinite(out.min) && Number.isFinite(out.max) && out.min <= out.max, path); break;
    case "date":
      check((out.min === null || civilDate(out.min)) && (out.max === null || civilDate(out.max)) && (!out.min || !out.max || out.min <= out.max), path); break;
    case "choice":
      out.options = array(out.options, 32, path + ".options").map((o: any) => {
        object(o, ["id", "label"], path + ".options");
        return { id: id(o.id, path + ".options.id"), label: text(o.label, 80, path + ".options.label") };
      });
      check(out.options.length > 0, path + ".options");
      unique(out.options.map((o: any) => o.id), path + ".options");
  }
  return out;
}
const markers = ["numero", "item", "estado", "total", "validade", "garantia", "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador"];
function message(raw: any, fields: WorkField[], path: string) {
  const value = text(raw, 900, path, true);
  const allowed = new Set([...markers, ...fields.filter(f => f.client_visible && !f.sensitive).map(f => `campo_${f.id}`)]);
  check(!value.replace(/\{([^{}]+)\}/g, (_, marker) => { check(allowed.has(marker), path); return ""; }).match(/[{}]/), path);
  return value;
}
export function validateWorkType(raw: unknown): CustomWorkType {
  const r = object(raw, ["schema_version", "kind", "id", "revision", "archived", "labels", "number_prefix", "terms", "fields", "retired_field_ids", "stages", "retired_stage_ids", "initial_stage", "transitions", "features", "pickup_reminder_text"], "type");
  check(r.schema_version === 1 && r.kind === "custom", "type.schema_version");
  const labels = object(r.labels, ["singular", "plural", "item", "problem", "customer_singular", "customer_plural"], "labels");
  const normalizedLabels: any = {};
  for (const key of ["singular", "plural", "item", "problem", "customer_singular", "customer_plural"]) normalizedLabels[key] = text(labels[key], 80, `labels.${key}`);
  const fields = array(r.fields, 24, "fields").map((f, i) => field(f, `fields.${i}`));
  unique(fields.map(f => f.id), "fields");
  const retired = (value: any, active: string[], path: string) => {
    const ids = array(value, 4096, path).map(v => id(v, path, 32, path === "retired_field_ids"));
    unique(ids, path); check(ids.every(v => !active.includes(v)), path); return ids;
  };
  const stages = array(r.stages, 32, "stages").map(s => {
    object(s, ["id", "label", "base_status", "message"], "stages");
    check(isStatus(s.base_status), "stages.base_status");
    return { id: id(s.id, "stages.id"), label: text(s.label, 80, "stages.label"), base_status: s.base_status, message: message(s.message, fields, "stages.message") };
  });
  unique(stages.map(s => s.id), "stages");
  const stage = (name: any) => stages.find(s => s.id === name);
  const initial = id(r.initial_stage, "initial_stage");
  check(stage(initial)?.base_status === "received", "initial_stage");
  const transitions = array(r.transitions, 128, "transitions").map(t => {
    check(t && ["manual", "customer_approval"].includes(t.kind), "transitions.kind");
    object(t, ["id", "from", "to", "label", "kind", ...(t.kind === "customer_approval" ? ["valid_hours", "request_text"] : [])], "transitions");
    check(stage(t.from) && stage(t.to) && t.from !== t.to && !CLOSED.includes(stage(t.from)!.base_status), "transitions.from/to");
    // Entradas reservadas e retorno de orçamento enviado exigem o protocolo.
    check(!["quoted", "approved", "declined"].includes(stage(t.to)!.base_status) && !(stage(t.from)!.base_status === "quoted" && stage(t.to)!.base_status !== "cancelled"), "transitions.quote");
    return { ...t, id: id(t.id, "transitions.id"), label: text(t.label, 80, "transitions.label"), ...(t.kind === "customer_approval" ? { valid_hours: integer(t.valid_hours, 1, 720, "transitions.valid_hours"), request_text: message(t.request_text, fields, "transitions.request_text") } : {}) };
  });
  unique(transitions.map(t => t.id), "transitions");
  const features = { ...object(r.features, ["customer_open", "tasks", "people", "documents", "entries", "quote", "warranty_days", "pickup_reminder_days", "stale_days"], "features") };
  for (const key of ["customer_open", "tasks", "people", "documents", "entries"]) features[key] = bool(features[key], `features.${key}`);
  integer(features.warranty_days, 0, 3650, "features.warranty_days");
  integer(features.pickup_reminder_days, 0, 365, "features.pickup_reminder_days");
  integer(features.stale_days, 0, 365, "features.stale_days");
  check(!features.customer_open || fields.every(f => !f.required || (f.client_visible && !f.sensitive)), "features.customer_open");
  check(!features.pickup_reminder_days || stages.some(s => s.base_status === "ready"), "features.pickup_reminder_days");
  const edges = transitions.map(t => [t.from, t.to]);
  if (features.quote !== null) {
    const q = { ...object(features.quote, ["default_valid_days", "source_stages", "sent_stage", "approved_stage", "declined_stage", "edited_stage"], "features.quote") };
    integer(q.default_valid_days, 1, 90, "features.quote.default_valid_days");
    for (const [key, base] of Object.entries({ sent_stage: "quoted", approved_stage: "approved", declined_stage: "declined", edited_stage: "analyzing" })) check(stage(q[key])?.base_status === base, `features.quote.${key}`);
    q.source_stages = array(q.source_stages, 32, "features.quote.source_stages");
    unique(q.source_stages, "features.quote.source_stages");
    check(q.source_stages.length && q.source_stages.every((s: string) => stage(s) && QUOTABLE.includes(stage(s)!.base_status)), "features.quote.source_stages");
    check(stages.every(s => !["quoted", "approved", "declined"].includes(s.base_status) || [q.sent_stage, q.approved_stage, q.declined_stage].includes(s.id)), "features.quote.stages");
    edges.push(...q.source_stages.map((s: string) => [s, q.sent_stage]), [q.sent_stage, q.approved_stage], [q.sent_stage, q.declined_stage], [q.sent_stage, q.edited_stage]);
    features.quote = q;
  } else check(stages.every(s => !["quoted", "approved", "declined"].includes(s.base_status)), "features.quote");
  const reachable = (start: string) => { const seen = new Set([start]); for (const s of seen) for (const [a, b] of edges) if (a === s) seen.add(b); return seen; };
  check(stages.every(s => reachable(initial).has(s.id)), "stages.unreachable");
  for (const s of stages.filter(s => !CLOSED.includes(s.base_status))) {
    const seen = reachable(s.id);
    for (const end of CLOSED) check(stages.some(t => t.base_status === end && seen.has(t.id)), "stages.termination");
  }
  const out: CustomWorkType = { ...r, id: id(r.id, "type.id", 64), revision: integer(r.revision, 1, Number.MAX_SAFE_INTEGER, "revision"), archived: bool(r.archived, "archived"), labels: normalizedLabels, number_prefix: text(r.number_prefix, 12, "number_prefix", true), terms: r.terms === null ? null : text(r.terms, 1400, "terms", true), fields, stages, transitions, features: features as CustomWorkType["features"], initial_stage: initial, retired_field_ids: retired(r.retired_field_ids, fields.map(f => f.id), "retired_field_ids"), retired_stage_ids: retired(r.retired_stage_ids, stages.map(s => s.id), "retired_stage_ids"), pickup_reminder_text: message(r.pickup_reminder_text, fields, "pickup_reminder_text") };
  if (jsonBytes(out) > 12 * 1024) throw new ApiError(413, "payload_too_large", "Definição de tipo excede 12 KiB.");
  return out;
}
export function validateWorkTypes(raw: unknown): CustomWorkType[] {
  const out = array(raw, 20, "os_work_types").map(validateWorkType);
  unique(out.map(t => t.id), "os_work_types"); return out;
}
export function validateVocabulary(raw: unknown): OsVocabulary {
  const r = object(raw, ["collection_label", "customer_singular", "customer_plural"], "os_vocabulary");
  return { collection_label: text(r.collection_label, 80, "collection_label"), customer_singular: text(r.customer_singular, 80, "customer_singular"), customer_plural: text(r.customer_plural, 80, "customer_plural") };
}
const canonical = (v: any): string => JSON.stringify(v && typeof v === "object" ? Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : v);
export function validateWorkTypeChanges(previous: Readonly<Record<string, any>>, next: Readonly<Record<string, any>>, context?: { modules: Readonly<Record<string, boolean>> }) {
  const types = validateWorkTypes(next.os_work_types ?? []);
  for (const old of (previous.os_work_types ?? []) as CustomWorkType[]) check(types.some(t => t.id === old.id), "os_work_types.archive_required");
  for (const type of types) {
    const old: CustomWorkType | undefined = previous.os_work_types?.find((t: CustomWorkType) => t.id === type.id);
    if (!old) { check(type.revision === 1, "revision"); continue; }
    const same = canonical({ ...old, revision: 0 }) === canonical({ ...type, revision: 0 });
    if (type.revision !== old.revision + (same ? 0 : 1)) throw new ApiError(409, "settings_conflict", "Revisão do tipo desatualizada.");
    for (const [active, retired] of [["fields", "retired_field_ids"], ["stages", "retired_stage_ids"]] as const) {
      check(old[retired].every(v => type[retired].includes(v)), retired);
      for (const entry of old[active]) check(type[active].some(e => e.id === entry.id) || type[retired].includes(entry.id), retired);
      check(type[active].every(e => !old[retired].includes(e.id)), retired);
    }
    for (const f of old.fields.filter(f => f.sensitive)) check(!type.fields.some(n => n.id === f.id && !n.sensitive), "fields.sensitive");
  }
  if (next.os_vocabulary !== undefined) validateVocabulary(next.os_vocabulary);
  for (const m of next.menus ?? []) {
    if (!["os_open", "os_track"].includes(m.type) || (m.type_id ?? "service_order") === "service_order") continue;
    const type = types.find(t => t.id === m.type_id);
    check(type, "menus.type_id");
    if (m.type === "os_open" && m.enabled !== false && context?.modules.os !== false) check(!type.archived && type.features.customer_open, "menus.type_id.archived");
  }
}

export function validateExtra(fields: WorkField[], value: unknown, options: { mode?: "staff" | "customer" | "private"; partial?: boolean; previous?: ExtraValues } = {}): ExtraValues {
  const mode = options.mode ?? "staff";
  let raw: any;
  try { raw = object(value, fields.map(f => f.id), "extra"); }
  catch { throw new ApiError(400, "invalid_fields", "Objeto de campos extras inválido."); }
  const out: ExtraValues = { ...(options.previous ?? {}) };
  for (const [key, original] of Object.entries(raw)) {
    const f = fields.find(f => f.id === key)!;
    check(mode === "private" ? f.sensitive : !f.sensitive && (mode !== "customer" || f.client_visible), `extra.${key}`, "invalid_fields");
    let v = original;
    if (typeof v === "string") v = v.trim();
    if (v !== null) {
      let valid = false;
      switch (f.kind) {
        case "text": valid = typeof v === "string" && Array.from(v).length <= f.max_length; break;
        case "boolean": valid = typeof v === "boolean"; break;
        case "integer": valid = Number.isSafeInteger(v) && (v as number) >= f.min && (v as number) <= f.max; break;
        case "decimal": valid = typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max && scaleFits(v, f.scale); break;
        case "date": valid = civilDate(v) && (!f.min || v >= f.min) && (!f.max || v <= f.max); break;
        case "choice": valid = typeof v === "string" && f.options.some(o => o.id === v); break;
      }
      check(valid, `extra.${key}`, "invalid_fields");
    }
    out[key] = v as ExtraValues[string];
  }
  if (!options.partial) for (const f of fields.filter(f => f.required)) check(Object.hasOwn(out, f.id) && out[f.id] !== null && out[f.id] !== "", `extra.${f.id}`, "invalid_fields");
  if (jsonBytes(out) > 16 * 1024) throw new ApiError(413, "payload_too_large", "Valores extras excedem 16 KiB.");
  return out;
}
