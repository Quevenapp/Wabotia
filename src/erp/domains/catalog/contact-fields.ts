// Campos próprios de contato (Wabotia, esquema do ERP versão 20; structural.ts,
// "campos-contato"): a definição em Preferências › Cadastros, o valor de cada
// contato, coluna e filtro da lista, exportação e importação, a ficha do
// atendimento e as operações dos bots.
//
// Campo sensível: só aparece no cadastro do contato (quem edita). Listagens,
// colunas, filtros, exportação, a ficha do atendimento, a IA e os bots só o
// recebem depois que o administrador libera aquele campo (exposed), com
// aviso na tela e registro (contact_field_audit, 'expose').
//
// Público de cada leitura (p_audience):
//   admin  — Preferências › Cadastros: todas as definições, com o uso;
//   panel  — o cadastro do contato no painel: campos ativos, sensíveis inclusive;
//   card   — a ficha do atendimento (só leitura): sensível só se liberado;
//   list   — colunas, filtros e exportação: sensível só se liberado;
//   agent  — IA, bots e aplicações: sensível só se liberado. Identidade de
//            agente no envelope (is_agent) vale agent, seja qual for o pedido.
// Nada aqui depende de Produtos, Vendas ou Financeiro: só da parte Cadastros.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { activeRole } from "../access/public.ts";
import { requireAccess } from "./access.ts";
import { requestHash } from "./command.ts";
import { contactRequireVisible, contactScope, contactVisibleTo } from "./contact.ts";
import { fold } from "./internal.ts";

export const CF_FIELD = "erp_catalog__contact_field";
export const CF_VALUE = "erp_catalog__contact_field_value";
export const CF_AUDIT = "erp_catalog__contact_field_audit";
export const CONTACT_FIELD_TYPES = ["text", "number", "date", "list", "boolean"] as const;
export const CONTACT_FIELD_ROLES = ["customer", "supplier", "seller", "carrier"] as const;
export const CONTACT_FIELD_AUDIENCES = ["admin", "panel", "card", "list", "agent"] as const;
export const CONTACT_FIELDS_LIMIT = 60;
export const CONTACT_FIELD_TEXT_MAX = 255;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];
export type ContactFieldAudience = (typeof CONTACT_FIELD_AUDIENCES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const NUMBER = /^-?(0|[1-9]\d{0,14})(?:[.,](\d{1,6}))?$/;
const MAX_VERSION = 2147483647;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
/** Chave de nome: sem acento, sem caixa e com espaços simples (nome repetido). */
export const nameKey = (name: string) => (fold(name) ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

export interface ContactFieldRow {
  id: string; name: string; field_type: ContactFieldType; required: boolean; roles: string[]; options: { id: string; label: string }[];
  sensitive: boolean; exposed: boolean; exposed_at: string | null; exposed_by: string | null; list_column: boolean; list_filter: boolean;
  position: number; active: boolean; version: number; created_at: string; updated_at: string;
}

function rowOf(r: Json): ContactFieldRow {
  return {
    id: String(r.id), name: String(r.name), field_type: String(r.field_type) as ContactFieldType, required: !!Number(r.required),
    roles: JSON.parse(String(r.roles)), options: JSON.parse(String(r.options)), sensitive: !!Number(r.sensitive), exposed: !!Number(r.exposed),
    exposed_at: r.exposed_at === null || r.exposed_at === undefined ? null : jsonTimestamp(String(r.exposed_at)),
    exposed_by: (r.exposed_by as string | null) ?? null, list_column: !!Number(r.list_column), list_filter: !!Number(r.list_filter),
    position: Number(r.position), active: !!Number(r.active), version: Number(r.version),
    created_at: jsonTimestamp(String(r.created_at)), updated_at: jsonTimestamp(String(r.updated_at)),
  };
}
const SELECT = `SELECT id, name, field_type, required, roles, options, sensitive, exposed, CAST(exposed_at AS TEXT) exposed_at, exposed_by,
  list_column, list_filter, position, active, version, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at FROM "${CF_FIELD}"`;

export function contactFieldRows(db: SqlDriver): ContactFieldRow[] {
  return db.exec(`${SELECT} ORDER BY position, name_key, id`).rows.map(rowOf);
}
export function contactFieldRow(db: SqlDriver, id: string): ContactFieldRow | null {
  const r = one(db, `${SELECT} WHERE id=?`, id);
  return r ? rowOf(r) : null;
}

/** O campo chega a este público? Sensível só no cadastro (panel) e para o administrador, salvo liberado. */
export const contactFieldVisible = (field: Pick<ContactFieldRow, "sensitive" | "exposed">, audience: ContactFieldAudience) =>
  audience === "admin" || audience === "panel" || !field.sensitive || field.exposed;

/** Público efetivo: identidade de agente (IA, bot, aplicação) nunca vê como pessoa. */
export function contactFieldAudience(ctx: RpcContext, raw: unknown, allowed: readonly ContactFieldAudience[]): ContactFieldAudience {
  const asked = raw === undefined || raw === null ? allowed[0]! : String(raw);
  if (!(allowed as readonly string[]).includes(asked)) raise("22023", "erp_contact_field_invalid_audience");
  if (ctx.identity.actor?.is_agent) return "agent";
  return asked as ContactFieldAudience;
}

/** Só o administrador do ERP define, altera, exclui e libera campos. */
export function contactFieldCanManage(db: SqlDriver, user: string | null): boolean {
  return user !== null && activeRole(db, user) === "admin";
}
export function requireContactFieldManager(db: SqlDriver, user: string | null) {
  if (!contactFieldCanManage(db, user)) raise("42501", "erp_contact_field_permission");
}

const personName = (ctx: RpcContext, id: string | null) =>
  id === null ? null : ctx.identity.people?.find((p) => p.user_id === id)?.name ?? null;

/** O que cada público recebe da definição (o administrador vê o uso e quem liberou). */
export function contactFieldItem(ctx: RpcContext, field: ContactFieldRow, audience: ContactFieldAudience): Json {
  const base: Json = {
    id: field.id, name: field.name, field_type: field.field_type, required: field.required, roles: [...field.roles],
    options: field.options.map((o) => ({ id: o.id, label: o.label })), sensitive: field.sensitive, exposed: field.exposed,
    list_column: field.list_column && contactFieldVisible(field, "list"), list_filter: field.list_filter && contactFieldVisible(field, "list"),
    active: field.active, version: field.version,
  };
  if (audience !== "admin") return base;
  const used = one(ctx.db, `SELECT CAST(count(*) AS TEXT) n FROM "${CF_VALUE}" WHERE field_id=?`, field.id)!;
  return {
    ...base, list_column: field.list_column, list_filter: field.list_filter, position: field.position,
    exposed_at: field.exposed_at, exposed_by: field.exposed_by, exposed_by_name: personName(ctx, field.exposed_by),
    created_at: field.created_at, updated_at: field.updated_at, contacts: Number(used.n),
  };
}

/** Papéis do contato para os campos: cliente, fornecedor, transportadora (roles) e vendedor (cadastro de vendedor). */
export function contactFieldRoles(db: SqlDriver, contactId: string): string[] {
  const c = one(db, 'SELECT roles FROM "erp_catalog__contact" WHERE record_id=?', contactId);
  if (!c) return [];
  const roles = (JSON.parse(String(c.roles)) as string[]).filter((r) => (CONTACT_FIELD_ROLES as readonly string[]).includes(r));
  if (one(db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE contact_id=?', contactId)) roles.push("seller");
  return CONTACT_FIELD_ROLES.filter((r) => roles.includes(r));
}
export const contactFieldApplies = (field: Pick<ContactFieldRow, "roles">, roles: readonly string[]) => field.roles.some((r) => roles.includes(r));

function requireContact(db: SqlDriver, id: unknown): string {
  if (typeof id !== "string" || !UUID_ANY.test(id)) raise("22023", "erp_contact_field_invalid_contact");
  const contact = id.toLowerCase();
  if (!one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, contact)) raise("P0002", "erp_catalog_not_found");
  return contact;
}

// ---- Valores ----
const validDay = (value: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! && value >= "1900-01-01" && value <= "2100-12-31";
};
const brDay = (value: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
};
const TRUE = ["true", "sim", "s", "1", "x", "yes"], FALSE = ["false", "nao", "não", "n", "0", "no"];

export type ValueProblem = "text" | "number" | "date" | "list" | "boolean" | "required";
/**
 * Valor guardado (texto canônico) ou o problema. null e texto vazio limpam.
 * Número: até 15 dígitos e 6 casas, vírgula ou ponto. Data: AAAA-MM-DD ou
 * DD/MM/AAAA. Lista: o id da opção ou o nome dela. Sim/não: true/false, Sim/Não.
 */
export function contactFieldValue(field: Pick<ContactFieldRow, "field_type" | "options">, raw: unknown): { value: string | null } | { problem: ValueProblem } {
  if (raw === null || raw === undefined) return { value: null };
  if (field.field_type === "boolean" && typeof raw === "boolean") return { value: raw ? "true" : "false" };
  if (field.field_type === "number" && typeof raw === "number") raw = Number.isFinite(raw) ? String(raw) : "x";
  if (typeof raw !== "string") return { problem: field.field_type };
  const text = raw.trim();
  if (!text) return { value: null };
  switch (field.field_type) {
    case "text":
      return text.length > CONTACT_FIELD_TEXT_MAX || CONTROL.test(text) ? { problem: "text" } : { value: text };
    case "number": {
      const m = NUMBER.exec(text);
      if (!m) return { problem: "number" };
      let value = text.replace(",", ".");
      if (value.includes(".")) value = value.replace(/0+$/, "").replace(/\.$/, "");
      return { value: value === "-0" ? "0" : value };
    }
    case "date": {
      const value = brDay(text);
      return validDay(value) ? { value } : { problem: "date" };
    }
    case "list": {
      const lower = text.toLowerCase();
      const option = field.options.find((o) => o.id === lower) ?? field.options.find((o) => nameKey(o.label) === nameKey(text));
      return option ? { value: option.id } : { problem: "list" };
    }
    case "boolean": {
      const key = nameKey(text);
      return TRUE.includes(key) ? { value: "true" } : FALSE.includes(key) ? { value: "false" } : { problem: "boolean" };
    }
  }
}

/** Valores guardados do contato, por id do campo. */
export function contactFieldStored(db: SqlDriver, contactId: string): Map<string, string> {
  return new Map(db.exec(`SELECT field_id, value FROM "${CF_VALUE}" WHERE contact_id=?`, contactId).rows.map((r) => [String(r.field_id), String(r.value)]));
}

/** O contato com os campos que este público vê: definições aplicáveis e valores. */
export function contactFieldView(ctx: RpcContext, contactId: string, audience: ContactFieldAudience) {
  const roles = contactFieldRoles(ctx.db, contactId);
  const all = contactFieldRows(ctx.db).filter((f) => f.active && contactFieldApplies(f, roles));
  const fields = all.filter((f) => contactFieldVisible(f, audience));
  const stored = contactFieldStored(ctx.db, contactId);
  const values: Record<string, string> = {};
  for (const f of fields) { const v = stored.get(f.id); if (v !== undefined) values[f.id] = v; }
  return {
    scope: "contact_fields", contact_id: contactId, audience, roles,
    fields: fields.map((f) => contactFieldItem(ctx, f, audience)), values,
    // Quantos campos sensíveis ficaram de fora (sem dizer quais nem os valores).
    hidden: all.length - fields.length, data_mode: "erp_native",
  };
}

export interface ValueError { field_id: string; name: string | null; code: ValueProblem | "unknown" | "not_applicable" | "inactive" }

/**
 * Confere e grava os valores de um contato (sem comando: quem chama cuida do
 * recibo). `complete`: o formulário inteiro do painel; obrigatório vale para
 * todo campo aplicável. Sem `complete`, só o que veio (bots, importação), e
 * obrigatório não pode ser limpo. Erro: nada é gravado.
 */
export function contactFieldWrite(ctx: RpcContext, user: string, command: string | null, contactId: string, input: unknown, audience: ContactFieldAudience, complete: boolean):
  { errors: ValueError[]; changed: string[] } {
  if (!isObject(input) || Object.keys(input).length > CONTACT_FIELDS_LIMIT || Object.keys(input).some((k) => !UUID_ANY.test(k))) raise("22023", "erp_contact_field_invalid_values");
  const roles = contactFieldRoles(ctx.db, contactId);
  const fields = new Map(contactFieldRows(ctx.db).map((f) => [f.id, f]));
  const stored = contactFieldStored(ctx.db, contactId);
  const errors: ValueError[] = [], next = new Map(stored), touched = new Set<string>();
  for (const [rawId, raw] of Object.entries(input)) {
    const id = rawId.toLowerCase(), field = fields.get(id);
    // Campo sensível que este público não vê é tratado como desconhecido: não revela que existe.
    if (!field || !contactFieldVisible(field, audience)) { errors.push({ field_id: id, name: null, code: "unknown" }); continue; }
    if (!field.active) { errors.push({ field_id: id, name: field.name, code: "inactive" }); continue; }
    if (!contactFieldApplies(field, roles)) { errors.push({ field_id: id, name: field.name, code: "not_applicable" }); continue; }
    const checked = contactFieldValue(field, raw);
    if ("problem" in checked) { errors.push({ field_id: id, name: field.name, code: checked.problem }); continue; }
    touched.add(id);
    if (checked.value === null) next.delete(id); else next.set(id, checked.value);
  }
  for (const field of fields.values()) {
    if (!field.required || !field.active || !contactFieldApplies(field, roles) || !contactFieldVisible(field, audience)) continue;
    if ((complete || touched.has(field.id)) && !next.has(field.id) && !errors.some((e) => e.field_id === field.id))
      errors.push({ field_id: field.id, name: field.name, code: "required" });
  }
  if (errors.length) return { errors, changed: [] };
  const at = ctx.clock.next().toString(), changed: string[] = [];
  for (const id of touched) {
    const before = stored.get(id), after = next.get(id);
    if (before === after) continue;
    changed.push(id);
    if (after === undefined) ctx.db.exec(`DELETE FROM "${CF_VALUE}" WHERE contact_id=? AND field_id=?`, contactId, id);
    else ctx.db.exec(
      `INSERT INTO "${CF_VALUE}"(contact_id, field_id, value, updated_by, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(contact_id, field_id) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      contactId, id, after, user, at);
  }
  // O registro guarda quais campos mudaram, nunca os valores (o campo pode ser sensível).
  if (changed.length) contactFieldAudit(ctx, { actor: user, command, contact: contactId, field: null, action: "values", after: { fields: changed.sort(), audience } });
  return { errors: [], changed };
}

export function contactFieldAudit(ctx: RpcContext, a: { actor: string; command: string | null; contact: string | null; field: string | null; action: string; before?: unknown; after?: unknown }) {
  ctx.db.exec(
    `INSERT INTO "${CF_AUDIT}"(field_id, contact_id, actor, command_id, action, before_data, after_data, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    a.field, a.contact, a.actor, a.command, a.action,
    a.before === undefined ? null : jsonbText(a.before), a.after === undefined ? null : jsonbText(a.after), ctx.clock.next().toString());
}

// ---- Recibo de comando (erp_catalog.command, a mesma chave dos cadastros) ----
export function contactFieldReplay(ctx: RpcContext, command: string, actor: string, hash: string): Json | null {
  const row = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_catalog__command" WHERE command_id=?', command);
  if (!row) return null;
  if (row.actor !== actor || row.request_hash !== hash) raise("40001", "erp_catalog_command_conflict");
  return { ...(JSON.parse(String(row.result)) as Json), replayed: true };
}
export function contactFieldStore(ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) {
  ctx.db.exec('INSERT INTO "erp_catalog__command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)',
    command, actor, hash, jsonbText(result), ctx.clock.next().toString());
}
export const contactFieldHash = (request: Json) => requestHash(request);

export function commandArg(v: unknown): string {
  if (typeof v !== "string" || !UUID_ANY.test(v)) raise("22023", "erp_contact_field_invalid_command");
  return v.toLowerCase();
}
export function userArg(v: unknown): string {
  if (typeof v !== "string" || !UUID_ANY.test(v)) raise("42501", "erp_catalog_access_denied");
  return v.toLowerCase();
}

// ---- Definição (Preferências › Cadastros) ----
const KEYS = ["name", "field_type", "required", "roles", "options", "sensitive", "exposed", "exposure_ack", "list_column", "list_filter", "active"];
export interface FieldDraft {
  name: string; field_type: ContactFieldType; required: boolean; roles: string[]; options: { id: string | null; label: string }[];
  sensitive: boolean; exposed: boolean; list_column: boolean; list_filter: boolean; active: boolean;
}

/** p_data da definição sobre o que já existe; formato errado: 22023 com o motivo. */
export function contactFieldDraft(data: unknown, current: ContactFieldRow | null): { draft: FieldDraft; ack: boolean } {
  if (!isObject(data) || Object.keys(data).some((k) => !KEYS.includes(k))) raise("22023", "erp_contact_field_invalid_data");
  const bad = (what: string): never => raise("22023", `erp_contact_field_invalid:${what}`);
  const bool = (k: string, fallback: boolean) => {
    if (!Object.hasOwn(data, k)) return fallback;
    if (typeof data[k] !== "boolean") bad(k);
    return data[k] as boolean;
  };
  let name = current?.name ?? null;
  if (Object.hasOwn(data, "name")) {
    if (typeof data.name !== "string") bad("name");
    name = (data.name as string).trim().replace(/\s+/g, " ");
  }
  if (!name || name.length > 60 || CONTROL.test(name)) bad("name");
  let type = current?.field_type ?? null;
  if (Object.hasOwn(data, "field_type")) {
    if (!(CONTACT_FIELD_TYPES as readonly unknown[]).includes(data.field_type)) bad("field_type");
    type = data.field_type as ContactFieldType;
  }
  if (!type) bad("field_type");
  let roles = current?.roles ?? null;
  if (Object.hasOwn(data, "roles")) {
    const list = data.roles;
    if (!Array.isArray(list) || !list.length || list.length > 4 || list.some((r) => !(CONTACT_FIELD_ROLES as readonly unknown[]).includes(r)) || new Set(list).size !== list.length) bad("roles");
    roles = CONTACT_FIELD_ROLES.filter((r) => (list as string[]).includes(r));
  }
  if (!roles?.length) bad("roles");
  let options: { id: string | null; label: string }[] = type === current?.field_type ? current!.options : [];
  if (Object.hasOwn(data, "options")) {
    const list = data.options;
    if (!Array.isArray(list) || list.length > 50) bad("options");
    options = (list as unknown[]).map((o) => {
      if (!isObject(o) || Object.keys(o).some((k) => k !== "id" && k !== "label") || typeof o.label !== "string") bad("options");
      const opt = o as Json, label = (opt.label as string).trim().replace(/\s+/g, " ");
      const id = opt.id === undefined || opt.id === null ? null : typeof opt.id === "string" && UUID_ANY.test(opt.id) ? opt.id.toLowerCase() : bad("options");
      if (!label || label.length > 60 || CONTROL.test(label)) bad("options");
      return { id, label };
    });
    const keys = options.map((o) => nameKey(o.label)), ids = options.filter((o) => o.id).map((o) => o.id);
    if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length) bad("options_repeated");
  }
  if (type === "list" ? !options.length : options.length) bad("options");
  const sensitive = bool("sensitive", current?.sensitive ?? false);
  let exposed = bool("exposed", current?.exposed ?? false);
  if (!sensitive) exposed = false;
  const ack = bool("exposure_ack", false);
  let listColumn = bool("list_column", current?.list_column ?? false), listFilter = bool("list_filter", current?.list_filter ?? false);
  // Sensível sem liberação não vira coluna nem filtro.
  if (sensitive && !exposed) { listColumn = false; listFilter = false; }
  return {
    draft: { name: name!, field_type: type!, required: bool("required", current?.required ?? false), roles: roles!, options, sensitive, exposed,
      list_column: listColumn, list_filter: listFilter, active: bool("active", current?.active ?? true) },
    ack,
  };
}

/** erp_catalog_contact_field_save: cria ou altera; nome repetido, limite, tipo e opção em uso respondem saved=false sem gravar. */
export function contactFieldSave(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id), command = commandArg(a.p_command_id);
  const id = a.p_id === undefined || a.p_id === null ? null : typeof a.p_id === "string" && UUID_ANY.test(a.p_id) ? a.p_id.toLowerCase() : raise("22023", "erp_contact_field_invalid_id");
  const expected = Number(a.p_expected_version ?? 0);
  requireContactFieldManager(db, user);
  const hash = contactFieldHash({ id, expected_version: expected, data: a.p_data ?? null });
  const replay = contactFieldReplay(ctx, command, user, hash);
  if (replay) return replay;
  const current = id === null ? null : contactFieldRow(db, id);
  if (id !== null && !current) raise("P0002", "erp_contact_field_not_found");
  if (!Number.isSafeInteger(expected) || (current ? expected !== current.version : expected !== 0)) raise("40001", "erp_contact_field_conflict");
  const { draft, ack } = contactFieldDraft(a.p_data, current);
  const refuse = (reason: string, extra: Json = {}) => ({ saved: false, reason, ...extra, data_mode: "erp_native" });
  const key = nameKey(draft.name);
  if (one(db, `SELECT 1 x FROM "${CF_FIELD}" WHERE name_key=? AND id<>?`, key, id ?? "")) return refuse("duplicate_name");
  if (!current && Number(one(db, `SELECT count(*) n FROM "${CF_FIELD}"`)!.n) >= CONTACT_FIELDS_LIMIT) return refuse("limit");
  const used = current ? Number(one(db, `SELECT count(*) n FROM "${CF_VALUE}" WHERE field_id=?`, current.id)!.n) : 0;
  if (current && draft.field_type !== current.field_type && used > 0) return refuse("type_in_use", { contacts: used });
  // Opções: as mantidas conservam o id; a que sai não pode estar em uso.
  const options = draft.options.map((o) => ({ id: o.id ?? crypto.randomUUID(), label: o.label }));
  if (current?.field_type === "list" && draft.field_type === "list") {
    if (draft.options.some((d) => d.id !== null && !current.options.some((c) => c.id === d.id))) raise("22023", "erp_contact_field_invalid:options");
    const removed = current.options.filter((c) => !options.some((o) => o.id === c.id)).map((c) => c.id);
    if (removed.length) {
      const n = Number(one(db, `SELECT count(*) n FROM "${CF_VALUE}" WHERE field_id=? AND value IN (SELECT value FROM json_each(?))`, current.id, JSON.stringify(removed))!.n);
      if (n > 0) return refuse("option_in_use", { contacts: n });
    }
  } else if (draft.options.some((o) => o.id !== null)) raise("22023", "erp_contact_field_invalid:options");
  // Liberar um campo sensível pede a confirmação do aviso (exposure_ack) e fica registrado.
  const exposing = draft.exposed && !current?.exposed;
  if (exposing && !ack) raise("22023", "erp_contact_field_exposure_ack");
  const at = ctx.clock.next().toString();
  const fieldId = current?.id ?? crypto.randomUUID();
  const exposedAt = draft.exposed ? (exposing ? at : one(db, `SELECT CAST(exposed_at AS TEXT) v FROM "${CF_FIELD}" WHERE id=?`, fieldId)!.v) : null;
  const exposedBy = draft.exposed ? (exposing ? user : current!.exposed_by) : null;
  const values = [draft.name, key, draft.field_type, draft.required ? 1 : 0, JSON.stringify(draft.roles), JSON.stringify(options), draft.sensitive ? 1 : 0,
    draft.exposed ? 1 : 0, exposedAt, exposedBy, draft.list_column ? 1 : 0, draft.list_filter ? 1 : 0, draft.active ? 1 : 0];
  if (!current) {
    const position = Number(one(db, `SELECT coalesce(max(position), 0) + 1 n FROM "${CF_FIELD}"`)!.n);
    db.exec(`INSERT INTO "${CF_FIELD}"(name, name_key, field_type, required, roles, options, sensitive, exposed, exposed_at, exposed_by, list_column, list_filter, active,
      id, position, version, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      ...values, fieldId, position, user, user, at, at);
  } else {
    if (current.version >= MAX_VERSION) raise("54000", "erp_contact_field_version_limit");
    db.exec(`UPDATE "${CF_FIELD}" SET name=?, name_key=?, field_type=?, required=?, roles=?, options=?, sensitive=?, exposed=?, exposed_at=?, exposed_by=?,
      list_column=?, list_filter=?, active=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`, ...values, user, at, fieldId);
  }
  const saved = contactFieldRow(db, fieldId)!;
  const plain = (f: ContactFieldRow | null) => f && { name: f.name, field_type: f.field_type, required: f.required, roles: f.roles, options: f.options,
    sensitive: f.sensitive, exposed: f.exposed, list_column: f.list_column, list_filter: f.list_filter, active: f.active };
  contactFieldAudit(ctx, { actor: user, command, contact: null, field: fieldId, action: current ? "update" : "create", before: plain(current) ?? undefined, after: plain(saved) });
  if (exposing) contactFieldAudit(ctx, { actor: user, command, contact: null, field: fieldId, action: "expose", after: { name: saved.name } });
  if (current?.exposed && !saved.exposed) contactFieldAudit(ctx, { actor: user, command, contact: null, field: fieldId, action: "unexpose", after: { name: saved.name } });
  const result = { saved: true, field: contactFieldItem(ctx, saved, "admin"), data_mode: "erp_native" };
  contactFieldStore(ctx, command, user, hash, result);
  return result;
}

/** erp_catalog_contact_field_delete: só sem valores guardados (com valores, inative o campo). */
export function contactFieldDelete(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id), command = commandArg(a.p_command_id);
  const id = typeof a.p_id === "string" && UUID_ANY.test(a.p_id) ? a.p_id.toLowerCase() : raise("22023", "erp_contact_field_invalid_id");
  requireContactFieldManager(db, user);
  const hash = contactFieldHash({ id, expected_version: a.p_expected_version ?? null, delete: true });
  const replay = contactFieldReplay(ctx, command, user, hash);
  if (replay) return replay;
  const current = contactFieldRow(db, id);
  if (!current) raise("P0002", "erp_contact_field_not_found");
  if (Number(a.p_expected_version) !== current.version) raise("40001", "erp_contact_field_conflict");
  const used = Number(one(db, `SELECT count(*) n FROM "${CF_VALUE}" WHERE field_id=?`, id)!.n);
  if (used > 0) return { id, deleted: false, reason: "in_use", contacts: used, data_mode: "erp_native" };
  db.exec(`DELETE FROM "${CF_FIELD}" WHERE id=?`, id);
  contactFieldAudit(ctx, { actor: user, command, contact: null, field: id, action: "delete", before: { name: current.name, field_type: current.field_type } });
  const result = { id, deleted: true, contacts: 0, data_mode: "erp_native" };
  contactFieldStore(ctx, command, user, hash, result);
  return result;
}

/** erp_catalog_contact_fields: as definições que este público vê. */
export function contactFieldList(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id);
  const audience = contactFieldAudience(ctx, a.p_audience, ["panel", "admin", "card", "list", "agent"]);
  requireAccess(db, user, "contacts", false);
  const manage = audience !== "agent" && contactFieldCanManage(db, user);
  if (audience === "admin" && !manage) raise("42501", "erp_contact_field_permission");
  const fields = contactFieldRows(db).filter((f) => (audience === "admin" || f.active) && contactFieldVisible(f, audience));
  return { scope: "contact_fields", audience, items: fields.map((f) => contactFieldItem(ctx, f, audience)), limit: CONTACT_FIELDS_LIMIT,
    permissions: { manage }, data_mode: "erp_native" };
}

/** erp_catalog_contact_field_values: os campos de um contato para o cadastro, a ficha ou o bot. */
export function contactFieldValues(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id);
  const audience = contactFieldAudience(ctx, a.p_audience, ["panel", "card", "agent"]);
  requireAccess(db, user, "contacts", false);
  const contact = requireContact(db, a.p_contact_id);
  contactRequireVisible(db, user, contact);
  return contactFieldView(ctx, contact, audience);
}

/** erp_catalog_contact_field_values_save: grava os campos de um contato (painel ou bot), com recibo. */
export function contactFieldValuesSave(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id), command = commandArg(a.p_command_id);
  const audience = contactFieldAudience(ctx, a.p_audience, ["panel", "agent"]);
  requireAccess(db, user, "contacts", true);
  const contact = requireContact(db, a.p_contact_id);
  contactRequireVisible(db, user, contact);
  const hash = contactFieldHash({ contact, values: a.p_values ?? null, audience });
  const replay = contactFieldReplay(ctx, command, user, hash);
  if (replay) return replay;
  const { errors, changed } = contactFieldWrite(ctx, user, command, contact, a.p_values, audience, audience === "panel");
  if (errors.length) return { saved: false, errors, data_mode: "erp_native" };
  const result = { saved: true, changed, ...contactFieldView(ctx, contact, audience) };
  contactFieldStore(ctx, command, user, hash, result);
  return result;
}

const idList = (v: unknown, max: number, what: string): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !UUID_ANY.test(x))) raise("22023", `erp_contact_field_invalid_${what}`);
  const ids = (v as string[]).map((x) => x.toLowerCase());
  if (new Set(ids).size !== ids.length) raise("22023", `erp_contact_field_invalid_${what}`);
  return ids;
};

/** erp_catalog_contact_field_bulk: valores de até 100 contatos para colunas da lista e exportação (sensível só liberado). */
export function contactFieldBulk(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id);
  const audience = contactFieldAudience(ctx, a.p_audience, ["list", "agent"]);
  requireAccess(db, user, "contacts", false);
  const ids = idList(a.p_ids, 100, "ids");
  const scope = contactScope(db, user);
  const fields = contactFieldRows(db).filter((f) => f.active && contactFieldVisible(f, audience));
  const visible = new Set(fields.map((f) => f.id));
  const items = ids.filter((id) => contactVisibleTo(db, scope, id) && one(db, `SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?`, id)).map((id) => {
    const values: Record<string, string> = {};
    for (const [field, value] of contactFieldStored(db, id)) if (visible.has(field)) values[field] = value;
    return { id, values };
  });
  return { scope: "contact_fields_bulk", audience, fields: fields.map((f) => contactFieldItem(ctx, f, audience)), items, data_mode: "erp_native" };
}

/** erp_catalog_contact_field_bulk_save: valores da importação, até 50 contatos por comando; cada linha passa ou fica de fora sozinha. */
export function contactFieldBulkSave(ctx: RpcContext, a: Json) {
  const db = ctx.db, user = userArg(a.p_user_id), command = commandArg(a.p_command_id);
  const audience = contactFieldAudience(ctx, a.p_audience, ["panel", "agent"]);
  requireAccess(db, user, "contacts", true);
  const list = a.p_items;
  if (!Array.isArray(list) || !list.length || list.length > 50) raise("22023", "erp_contact_field_invalid_items");
  const hash = contactFieldHash({ items: list, audience });
  const replay = contactFieldReplay(ctx, command, user, hash);
  if (replay) return replay;
  const seen = new Set<string>();
  const items = (list as unknown[]).map((item) => {
    if (!isObject(item) || typeof item.contact_id !== "string" || !UUID_ANY.test(item.contact_id) || !isObject(item.values)) raise("22023", "erp_contact_field_invalid_items");
    const contact = item.contact_id.toLowerCase();
    if (seen.has(contact)) raise("22023", "erp_contact_field_invalid_items");
    seen.add(contact);
    if (!one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, contact)) return { contact_id: contact, saved: false, errors: [{ field_id: null, name: null, code: "not_found" }] };
    try { contactRequireVisible(db, user, contact); }
    catch { return { contact_id: contact, saved: false, errors: [{ field_id: null, name: null, code: "not_visible" }] }; }
    const { errors, changed } = contactFieldWrite(ctx, user, command, contact, item.values, audience, false);
    return errors.length ? { contact_id: contact, saved: false, errors } : { contact_id: contact, saved: true, changed };
  });
  const result = { scope: "contact_fields_import", items, data_mode: "erp_native" };
  contactFieldStore(ctx, command, user, hash, result);
  return result;
}

// ---- Filtro da lista ----
export interface ContactFieldFilter { field_id: string; value?: string; from?: string; to?: string }
/**
 * Condição a mais do contactPage (aliases r, c, cp) para os filtros dos campos
 * próprios. Só campo ativo, marcado como filtro e que a lista pode ver.
 */
export function contactFieldCondition(db: SqlDriver, raw: unknown): { sql: string; params: unknown[] } | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 10) raise("22023", "erp_catalog_invalid_query");
  if (!raw.length) return null;
  const fields = new Map(contactFieldRows(db).map((f) => [f.id, f]));
  const parts: string[] = [], params: unknown[] = [], seen = new Set<string>();
  const exists = (extra: string) => `EXISTS(SELECT 1 FROM "${CF_VALUE}" v WHERE v.contact_id=r.id AND v.field_id=? ${extra})`;
  for (const item of raw as unknown[]) {
    if (!isObject(item) || Object.keys(item).some((k) => !["field_id", "value", "from", "to"].includes(k)) || typeof item.field_id !== "string") raise("22023", "erp_catalog_invalid_query");
    const id = item.field_id.toLowerCase(), field = fields.get(id);
    if (seen.has(id) || !field || !field.active || !field.list_filter || !contactFieldVisible(field, "list")) raise("22023", "erp_contact_field_filter_unavailable");
    seen.add(id);
    const text = (k: string) => { const v = item[k]; if (v === undefined || v === null || v === "") return null; if (typeof v !== "string" || v.length > 255 || CONTROL.test(v)) raise("22023", "erp_catalog_invalid_query"); return v.trim(); };
    if (field.field_type === "text") {
      const v = text("value"); if (v === null) raise("22023", "erp_catalog_invalid_query");
      parts.push(exists("AND instr(lower(v.value), lower(?)) > 0")); params.push(id, v);
    } else if (field.field_type === "list") {
      const v = text("value"), checked = v === null ? null : contactFieldValue(field, v);
      if (!checked || "problem" in checked || checked.value === null) raise("22023", "erp_catalog_invalid_query");
      parts.push(exists("AND v.value=?")); params.push(id, checked.value);
    } else if (field.field_type === "boolean") {
      const v = text("value"), checked = v === null ? null : contactFieldValue(field, v);
      if (!checked || "problem" in checked || checked.value === null) raise("22023", "erp_catalog_invalid_query");
      // Sem valor guardado conta como Não.
      if (checked.value === "true") { parts.push(exists("AND v.value='true'")); params.push(id); }
      else { parts.push(`NOT ${exists("AND v.value='true'")}`); params.push(id); }
    } else {
      const from = text("from"), to = text("to");
      if (from === null && to === null) raise("22023", "erp_catalog_invalid_query");
      const norm = (v: string | null) => { if (v === null) return null; const c = contactFieldValue(field, v); if ("problem" in c || c.value === null) raise("22023", "erp_catalog_invalid_query"); return c.value; };
      const lo = norm(from), hi = norm(to);
      if (field.field_type === "number") {
        if (lo !== null && hi !== null && Number(lo) > Number(hi)) raise("22023", "erp_catalog_invalid_query");
        parts.push(exists(`${lo !== null ? "AND CAST(v.value AS REAL) >= CAST(? AS REAL)" : ""} ${hi !== null ? "AND CAST(v.value AS REAL) <= CAST(? AS REAL)" : ""}`));
      } else {
        if (lo !== null && hi !== null && lo > hi) raise("22023", "erp_catalog_invalid_query");
        parts.push(exists(`${lo !== null ? "AND v.value >= ?" : ""} ${hi !== null ? "AND v.value <= ?" : ""}`));
      }
      params.push(id, ...[lo, hi].filter((v) => v !== null));
    }
  }
  return { sql: parts.join(" AND "), params };
}
export const contactFieldUuid = (v: string) => UUID.test(v);
