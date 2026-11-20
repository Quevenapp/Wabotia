// B1: os escritores pequenos do Documentos e a prévia da cópia.
// - erp_document_custom_field_save/_delete (campos customizados da OS, 287);
// - erp_document_discount_approval_save (situações de aprovação do desconto);
// - erp_document_list_view_save (colunas e situações da lista);
// - erp_document_numbering_set (próximo número);
// - erp_document_occurrence_remove (ocorrência removida, 267);
// - erp_document_print_header_save (cabeçalho de impressão);
// - erp_document_signature_save (assinatura da proposta);
// - erp_document_copy_preview (o formulário da cópia, sem gravar).
import { createHash } from "node:crypto";
import { linkedDocumentGuard } from "../module-policy.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgLower } from "../../../engine/text.ts";
import { saoPauloParts } from "../../../engine/time.ts";
import { unitPriceNumeric, validNow } from "../../catalog/public.ts";
import { documentDto, preference, projectDocument, situationAdopted, situationKeyValid, textValue } from "../internal.ts";
import { guardEffect, requireVisible } from "../mirror.ts";
import { hasCommercialData, richText } from "../normalize.ts";
import { transitions } from "../preferences.ts";
import { withoutUnavailableLinks } from "../save-checks.ts";
import { contactUsable, requireAccess } from "../reads-g.ts";
import { carrierUsable, categoryUsable, commandReplay, fieldText } from "../save-checks.ts";
import { customFieldItem, listViewColumns, listViewDto, numberingDto, occurrenceJson, printHeaderView, signatureView } from "../views.ts";
import { erpDocumentDiscountApproval } from "./reads-config.ts";

type Data = Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const has = (o: unknown, k: string) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = { data_mode: "erp_native", operational_effects: false };
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const isAdmin = (db: SqlDriver, user: string) => !!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user);
const receipt = (ctx: RpcContext, command: string, actor: string, hash: string, result: unknown) =>
  ctx.db.exec('INSERT INTO "erp_documents__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)', command, actor, hash, JSON.stringify(result), ctx.clock.next().toString());
const now = (ctx: RpcContext) => ctx.clock.next().toString();
/** O JSON do argumento jsonb (undefined e null são o NULL do SQL). */
const jarg = (v: unknown) => (v === undefined || v === null ? null : jsonbArg(v));

// ---------------------------------------------------------------- campos customizados

/** erp_documents.custom_field_input(p_data, p_current): o campo validado. */
function customFieldInput(data: unknown, current: Data | null) {
  const bad = () => raise("22023", "erp_document_custom_field_input_invalid");
  const KEYS = ["field_type", "name", "hint", "info", "required", "min_length", "max_length", "width", "options", "active"];
  if (data === null || jsonType(data) !== "object" || Object.keys(data as Data).length !== 10 || !KEYS.every((k) => has(data, k))) bad();
  const d = data as Data;
  const type = typeof d.field_type === "string" ? d.field_type : null;
  if (type === null || !["integer", "decimal", "list", "text", "long_text", "boolean", "date"].includes(type) || (current !== null && type !== current.field_type)) bad();
  if (jsonType(d.required) !== "boolean" || jsonType(d.active) !== "boolean" || jsonType(d.width) !== "string" || !["small", "medium", "large", "extra_large"].includes(String(d.width)) || jsonType(d.options) !== "array")
    bad();
  const size = ({ integer: 19, decimal: 22, text: 255, long_text: 4000 } as Record<string, number>)[type!] ?? null;
  const length = (v: unknown): number | null => {
    if (v === null) return null;
    if (size === null || jsonType(v) !== "number" || !/^[1-9][0-9]{0,3}$/.test(jsonbText(v)) || Number(v) > size) bad();
    return Number(v);
  };
  const min = length(d.min_length);
  const max = length(d.max_length);
  if (min !== null && max !== null && min > max) bad();
  const list = d.options as unknown[];
  if ((type === "list") !== (list.length >= 1 && list.length <= 50)) bad();
  const currentOptions = current === null ? [] : (JSON.parse(String(current.options)) as Data[]);
  const ids: string[] = [];
  const labels: string[] = [];
  const options: Data[] = [];
  for (const o of list) {
    if (jsonType(o) !== "object" || Object.keys(o as Data).length !== 2 || !has(o, "id") || !has(o, "label")) bad();
    const label = textValue((o as Data).label, 60, true)!;
    if (labels.includes(pgLower(label))) bad();
    labels.push(pgLower(label));
    let id: string;
    if ((o as Data).id === null) id = crypto.randomUUID();
    else {
      id = pgLower(textValue((o as Data).id, 36, true)!);
      if (!UUID.test(id) || ids.includes(id) || current === null || !currentOptions.some((c) => (c?.id === undefined ? null : typeof c.id === "string" ? c.id : jsonbText(c.id)) === id)) bad();
    }
    ids.push(id);
    options.push({ id, label });
  }
  return {
    field_type: type!, name: textValue(d.name, 60, true)!, hint: textValue(d.hint, 100), info: textValue(d.info, 300, false, true),
    required: d.required as boolean, min_length: min, max_length: max, width: String(d.width), options, active: d.active as boolean,
  };
}

function requireCustomFieldAdmin(db: SqlDriver, user: string, kind: string | null) {
  if (kind !== "service_orders") raise("22023", "erp_document_query_invalid");
  requireAccess(db, user, kind, false);
  if (!isAdmin(db, user)) raise("42501", "erp_document_access_denied");
}

function customFieldAudit(ctx: RpcContext, user: string, command: string, field: string, action: string, before: unknown, after: unknown) {
  ctx.db.exec(
    'INSERT INTO "erp_documents__custom_field_audit"(id, actor, command_id, field_id, action, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__custom_field_audit", "id"), user, command, field, action, json(before), json(after), now(ctx),
  );
}

/** public.erp_document_custom_field_save */
export function erpDocumentCustomFieldSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const data = jarg(a.p_data);
  requireCustomFieldAdmin(db, user, kind);
  if (expected === null || expected < 0 || (id === null) !== (expected === 0)) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "custom_field_save", actor: user, kind, id, version: expected, data }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  let current: Data | null = null;
  let before: unknown = null;
  if (id !== null) {
    current = one(db, 'SELECT * FROM "erp_documents__custom_field" WHERE id=? AND kind=?', id, kind) ?? null;
    if (!current) raise("P0002", "erp_document_custom_field_not_found");
    if (current!.version !== expected || current!.version === 2147483647) raise("40001", "erp_document_version_conflict");
    before = customFieldItem(db, id, true);
  } else if (Number(one(db, 'SELECT count(*) n FROM "erp_documents__custom_field" WHERE kind=?', kind)!.n) >= 60) raise("22023", "erp_document_custom_field_limit");
  const input = customFieldInput(data, current);
  if (db.exec('SELECT id, name FROM "erp_documents__custom_field" WHERE kind=?', kind).rows.some((f) => pgLower(String(f.name)) === pgLower(input.name) && f.id !== id))
    raise("22023", "erp_document_custom_field_duplicate");
  // Uma opção que sai da lista não pode ser o valor de nenhuma OS.
  if (current !== null) {
    const kept = new Set(input.options.map((o) => o.id));
    const removed = (JSON.parse(String(current.options)) as Data[])
      .map((o) => (o?.id === undefined || o?.id === null ? null : typeof o.id === "string" ? o.id : jsonbText(o.id)))
      .filter((o) => !kept.has(o as string));
    if (removed.length) {
      const used = db.exec('SELECT body FROM "erp_documents__document" WHERE kind=?', kind).rows.some((d) => {
        const cf = (JSON.parse(String(d.body)) as Data)?.custom_fields;
        if (cf === null || typeof cf !== "object" || Array.isArray(cf) || !has(cf, id!)) return false;
        const v = (cf as Data)[id!];
        const text = v === null ? null : typeof v === "string" ? v : jsonbText(v);
        return text !== null && removed.includes(text);
      });
      if (used) raise("22023", "erp_document_custom_field_option_in_use");
    }
  }
  let fieldId: string;
  const t = now(ctx);
  if (id === null) {
    fieldId = crypto.randomUUID();
    db.exec(
      `INSERT INTO "erp_documents__custom_field"(id, kind, field_type, name, hint, info, required, min_length, max_length, width, options, active, version, created_by, updated_by, created_at, updated_at, name__fold)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      fieldId, kind, input.field_type, input.name, input.hint, input.info, input.required ? 1 : 0, input.min_length, input.max_length, input.width,
      JSON.stringify(input.options), input.active ? 1 : 0, user, user, t, t, pgLower(input.name),
    );
  } else {
    fieldId = id;
    db.exec(
      `UPDATE "erp_documents__custom_field" SET name=?, hint=?, info=?, required=?, min_length=?, max_length=?, width=?, options=?, active=?, version=version+1, updated_by=?, updated_at=?, name__fold=? WHERE id=?`,
      input.name, input.hint, input.info, input.required ? 1 : 0, input.min_length, input.max_length, input.width, JSON.stringify(input.options), input.active ? 1 : 0, user, t, pgLower(input.name), id,
    );
  }
  const result = { kind, field: customFieldItem(db, fieldId, true), replayed: false, ...NATIVE };
  customFieldAudit(ctx, user, command!, fieldId, id === null ? "create" : "update", before, result.field);
  receipt(ctx, command!, user, hash, result);
  return result;
}

/** public.erp_document_custom_field_delete */
export function erpDocumentCustomFieldDelete(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const id = (a.p_id as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  requireCustomFieldAdmin(db, user, kind);
  if (id === null || expected === null || expected < 1) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "custom_field_delete", actor: user, kind, id, version: expected }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const current = one(db, 'SELECT * FROM "erp_documents__custom_field" WHERE id=? AND kind=?', id, kind);
  if (!current) raise("P0002", "erp_document_custom_field_not_found");
  if (current!.version !== expected) raise("40001", "erp_document_version_conflict");
  if (
    db.exec('SELECT body FROM "erp_documents__document" WHERE kind=?', kind).rows.some((d) => {
      const cf = (JSON.parse(String(d.body)) as Data)?.custom_fields;
      return cf !== null && typeof cf === "object" && !Array.isArray(cf) && has(cf, id!);
    })
  )
    raise("22023", "erp_document_custom_field_in_use");
  const before = customFieldItem(db, id!, true);
  db.exec('DELETE FROM "erp_documents__custom_field" WHERE id=?', id);
  const result = { kind, deleted: id, replayed: false, ...NATIVE };
  customFieldAudit(ctx, user, command!, id!, "delete", before, null);
  receipt(ctx, command!, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- aprovação do desconto

/** public.erp_document_discount_approval_save */
export function erpDocumentDiscountApprovalSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const situations = jarg(a.p_situations);
  requireAccess(db, user, "sales_orders", false);
  if (!isAdmin(db, user)) raise("42501", "erp_document_access_denied");
  const list = situations as unknown[];
  if (
    expected === null || expected < 0 || expected > 2147483646 || situations === null || jsonType(situations) !== "array" || list.length > 5 ||
    list.some((x) => typeof x !== "string" || !UUID.test(x)) || new Set(list).size !== list.length
  )
    raise("22023", "erp_document_discount_approval_invalid");
  const hash = sha256(jsonbText({ op: "discount_approval", actor: user, version: expected, situations }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const ids = list as string[];
  if (ids.some((i) => !one(db, `SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind='sales_orders' AND base_status='draft' AND active=1`, i)))
    raise("22023", "erp_document_discount_approval_invalid");
  const row = one(db, 'SELECT * FROM "erp_documents__discount_approval" WHERE singleton=1')!;
  if (row.version !== expected) raise("40001", "erp_document_version_conflict");
  db.exec('UPDATE "erp_documents__discount_approval" SET situation_ids=?, version=version+1, updated_by=?, updated_at=? WHERE singleton=1', JSON.stringify(ids), user, now(ctx));
  db.exec(
    'INSERT INTO "erp_documents__discount_approval_audit"(id, actor, command_id, before_ids, after_ids, version, created_at) VALUES(?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__discount_approval_audit", "id"), user, command, row.situation_ids, JSON.stringify(ids), Number(row.version) + 1, now(ctx),
  );
  const result = { ...(erpDocumentDiscountApproval(ctx, { p_user_id: user }) as Data), replayed: false };
  receipt(ctx, command!, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- lista

/** public.erp_document_list_view_save */
export function erpDocumentListViewSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const custom = (a.p_custom_view as boolean | null) ?? null;
  const columns = (a.p_columns as (string | null)[] | null) ?? null;
  const statuses = (a.p_default_statuses as (string | null)[] | null) ?? null;
  requireAccess(db, user, kind, false);
  const validStatus = (s: string) =>
    situationAdopted(db, kind) ? situationKeyValid(db, kind, s) : has((transitions() as Data)[kind!], s);
  if (
    !["sales_proposals", "sales_orders", "service_orders"].includes(kind!) || expected === null || expected < 0 || custom === null || columns === null || statuses === null ||
    columns.includes(null) || statuses.includes(null) || columns.length > 8 || (kind === "sales_orders" && custom && columns.length === 0) ||
    (kind !== "sales_orders" && (custom || columns.length > 0)) || columns.some((c) => !listViewColumns(kind).includes(c!)) || new Set(columns).size !== columns.length ||
    statuses.length > 20 || statuses.some((s) => !validStatus(s!)) || new Set(statuses).size !== statuses.length
  )
    raise("22023", "erp_document_list_view_invalid");
  const hash = sha256(jsonbText({ op: "list_view", actor: user, kind, version: expected, custom_view: custom, columns, statuses }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const row = one(db, 'SELECT version FROM "erp_documents__list_view" WHERE user_id=? AND kind=?', user, kind);
  if (row) {
    if (row.version !== expected || row.version === 2147483647) raise("40001", "erp_document_version_conflict");
    db.exec(
      'UPDATE "erp_documents__list_view" SET custom_view=?, columns=?, default_statuses=?, version=version+1, updated_at=? WHERE user_id=? AND kind=?',
      custom ? 1 : 0, JSON.stringify(columns), JSON.stringify(statuses), now(ctx), user, kind,
    );
  } else {
    if (expected !== 0) raise("40001", "erp_document_version_conflict");
    db.exec(
      'INSERT INTO "erp_documents__list_view"(user_id, kind, custom_view, columns, default_statuses, version, updated_at) VALUES(?,?,?,?,?,1,?)',
      user, kind, custom ? 1 : 0, JSON.stringify(columns), JSON.stringify(statuses), now(ctx),
    );
  }
  const result = { ...listViewDto(db, user, kind), replayed: false };
  receipt(ctx, command!, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- numeração

/** public.erp_document_numbering_set */
export function erpDocumentNumberingSet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const expectedNext = (a.p_expected_next_number as string | null) ?? null;
  const nextArg = (a.p_next_number as string | null) ?? null;
  requireAccess(db, user, kind, true);
  if (!isAdmin(db, user)) raise("42501", "erp_document_access_denied");
  const NUM = /^[1-9][0-9]{0,9}$/;
  if (command === null || expectedNext === null || !NUM.test(expectedNext) || nextArg === null || !NUM.test(nextArg)) raise("22023", "erp_document_numbering_invalid");
  const hash = sha256(jsonbText({ op: "numbering", actor: user, kind, expected: expectedNext, next: nextArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const row = one(db, 'SELECT last_number FROM "erp_documents__numbering" WHERE kind=?', kind);
  if (!row) raise("22023", "erp_document_query_invalid");
  const last = Number(row!.last_number);
  if (last + 1 !== Number(expectedNext)) raise("40001", "erp_document_numbering_conflict");
  const next = Number(nextArg);
  const max = Number(one(db, 'SELECT coalesce(max(number),0) m FROM "erp_documents__document" WHERE kind=?', kind)!.m);
  if (next <= max) raise("23505", "erp_document_number_taken");
  if (next === last + 1) raise("22023", "erp_document_numbering_unchanged");
  db.exec('UPDATE "erp_documents__numbering" SET last_number=? WHERE kind=?', next - 1, kind);
  db.exec(
    'INSERT INTO "erp_documents__numbering_audit"(id, kind, actor, command_id, before_last, after_last, created_at) VALUES(?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__numbering_audit", "id"), kind, user, command, last, next - 1, now(ctx),
  );
  const result = { ...numberingDto(db, kind)!, replayed: false };
  receipt(ctx, command, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- ocorrência removida

/** public.erp_document_occurrence_remove */
export function erpDocumentOccurrenceRemove(ctx: RpcContext, a: RpcArgs) {
  linkedDocumentGuard(ctx.db, a.p_document_id);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const documentId = (a.p_document_id as string | null) ?? null;
  const occurrenceId = (a.p_occurrence_id as string | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  requireVisible(db, user, documentId, true);
  requireAccess(db, user, kind, true);
  if (documentId === null || occurrenceId === null) raise("22023", "erp_document_occurrence_invalid");
  const hash = sha256(jsonbText({ op: "occurrence_remove", actor: user, kind, id: documentId, occurrence: occurrenceId }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const row = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', documentId, kind);
  if (!row) raise("P0002", "erp_document_not_found");
  // 267: documento de contato que o usuário não vê não existe para ele.
  if (!contactUsable(db, user, row!.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  const occurrence = one(db, 'SELECT * FROM "erp_documents__occurrence" WHERE id=? AND document_id=?', occurrenceId, documentId);
  if (!occurrence || one(db, 'SELECT 1 x FROM "erp_documents__occurrence_removal" WHERE occurrence_id=?', occurrenceId)) raise("P0002", "erp_document_occurrence_not_found");
  const role = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role ?? null;
  guardEffect(db, documentId); // aa_mirror_authority
  db.exec(
    'INSERT INTO "erp_documents__occurrence_removal"(occurrence_id, document_id, actor_id, actor_role, command_id, removed_at) VALUES(?,?,?,?,?,?)',
    occurrenceId, documentId, user, role ?? "desconhecido", command, now(ctx),
  );
  db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), user, command, documentId, "occurrence_remove", null, JSON.stringify(occurrenceJson(occurrence!)), null, now(ctx),
  );
  const result = {
    kind, document: { id: row!.id, kind: row!.kind, number: row!.number === null ? null : String(row!.number), status: row!.status, version: row!.version },
    removed_id: occurrenceId, replayed: false, ...NATIVE,
  };
  receipt(ctx, command!, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- cabeçalho de impressão

/** public.erp_document_print_header_save */
export function erpDocumentPrintHeaderSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const contentArg = jarg(a.p_content);
  requireAccess(db, user, kind, false);
  if (!isAdmin(db, user)) raise("42501", "erp_document_access_denied");
  if (command === null || expected === null || expected < 0) raise("22023", "erp_document_version_invalid");
  const hash = sha256(jsonbText({ op: "print_header", actor: user, kind, version: expected, content: contentArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const content = richText(contentArg);
  const current = one(db, 'SELECT content, version FROM "erp_documents__print_header" WHERE kind=?', kind);
  if ((current ? Number(current.version) : 0) !== expected) raise("40001", "erp_document_version_conflict");
  if (!current) db.exec('INSERT INTO "erp_documents__print_header"(kind, content, version, updated_by, updated_at) VALUES(?,?,1,?,?)', kind, json(content), user, now(ctx));
  else db.exec('UPDATE "erp_documents__print_header" SET content=?, version=version+1, updated_by=?, updated_at=? WHERE kind=?', json(content), user, now(ctx), kind);
  db.exec(
    'INSERT INTO "erp_documents__print_header_audit"(id, kind, actor, command_id, version, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__print_header_audit", "id"), kind, user, command, expected + 1, current ? current.content : null, json(content), now(ctx),
  );
  const result = { ...printHeaderView(db, kind, user), replayed: false };
  receipt(ctx, command, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- assinatura

/** public.erp_document_signature_save */
export function erpDocumentSignatureSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const expected = (a.p_expected_version as number | null) ?? null;
  const command = (a.p_command_id as string | null) ?? null;
  const greetingArg = (a.p_greeting as string | null) ?? null;
  const departmentArg = (a.p_department as string | null) ?? null;
  requireAccess(db, user, "sales_proposals", true);
  if (command === null || expected === null || expected < 0 || expected > 2147483646) raise("22023", "erp_document_signature_invalid");
  const hash = sha256(jsonbText({ op: "signature", actor: user, version: expected, greeting: greetingArg, department: departmentArg }));
  const replay = commandReplay(ctx, user, command, hash);
  if (replay !== null) return replay;
  const greeting = textValue(greetingArg, 200);
  const department = textValue(departmentArg, 100);
  const row = one(db, 'SELECT version FROM "erp_documents__user_signature" WHERE user_id=?', user);
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_document_version_conflict");
  const before = row ? signatureView(db, user) : null;
  if (!row) db.exec('INSERT INTO "erp_documents__user_signature"(user_id, greeting, department, version, updated_at) VALUES(?,?,?,1,?)', user, greeting, department, now(ctx));
  else db.exec('UPDATE "erp_documents__user_signature" SET greeting=?, department=?, version=version+1, updated_at=? WHERE user_id=?', greeting, department, now(ctx), user);
  const result = { ...signatureView(db, user), replayed: false };
  db.exec(
    'INSERT INTO "erp_documents__user_signature_audit"(id, user_id, command_id, before_data, after_data, created_at) VALUES(?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__user_signature_audit", "id"), user, command, json(before), JSON.stringify(result), now(ctx),
  );
  receipt(ctx, command, user, hash, result);
  return result;
}

// ---------------------------------------------------------------- prévia da cópia

const arrowOrNull = (o: Data | null, k: string) => (o !== null && has(o, k) ? o[k] : null);

/** public.erp_document_copy_preview: o formulário do documento copiado, sem gravar. */
export function erpDocumentCopyPreview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = (a.p_kind as string | null) ?? null;
  const sourceId = (a.p_source_id as string | null) ?? null;
  requireVisible(db, user, sourceId, true);
  requireAccess(db, user, kind, false);
  requireAccess(db, user, kind, true);
  const s = sourceId === null ? undefined : one(db, 'SELECT * FROM "erp_documents__document" WHERE id=? AND kind=?', sourceId, kind);
  if (!s) raise("P0002", "erp_document_not_found");
  // 267: documento de contato que o usuário não vê não existe para ele.
  if (!contactUsable(db, user, s!.contact_id as string | null)) raise("P0002", "erp_document_not_found");
  const body = JSON.parse(String(s!.body)) as Data;
  const keepDate = kind === "purchase_orders" && preference(db, "compras.clonagem_data") === "data_original";
  let items: Data[] = db
    .exec('SELECT product_id, data, quantity, unit_price, discount_percent FROM "erp_documents__item" WHERE document_id=? ORDER BY position', sourceId)
    .rows.map((i) => {
      const d = JSON.parse(String(i.data)) as Data;
      const out: Data = {
        id: null, product_id: i.product_id ?? null, description: arrowOrNull(d, "description"), code: arrowOrNull(d, "code"), unit: arrowOrNull(d, "unit"),
        quantity: i.quantity === null ? null : formatScaled(fromColumn(i.quantity), 6), unit_price: unitPriceNumeric(i.unit_price, 10),
        discount_percent: i.discount_percent === null ? null : formatScaled(fromColumn(i.discount_percent), 4),
      };
      if (has(d, "detailed_description")) out.detailed_description = d.detailed_description;
      if (has(d, "list_price")) out.list_price = d.list_price;
      if (has(d, "supplier_code")) out.supplier_code = d.supplier_code;
      // 267/268: Peças / Serviços executados da OS, com Orçar e OK do serviço.
      if (has(d, "group")) Object.assign(out, { group: d.group, quote: has(d, "quote") ? d.quote : false, done: has(d, "done") ? d.done : false });
      // 287: Garantia do item (OS) e IPI % do item (pedido de compra).
      if (has(d, "warranty_days")) out.warranty_days = d.warranty_days;
      if (has(d, "ipi_rate")) out.ipi_rate = d.ipi_rate;
      return out;
    });
  const date = (k: string) => (fieldText(body, k) === null ? null : fieldText(body, k));
  let data: Data = {
    date: keepDate ? date("date") : saoPauloParts(ctx.clock.next()).date,
    contact_id: s!.contact_id ?? null, warehouse_id: s!.warehouse_id ?? null, expected_date: keepDate ? date("expected_date") : null, valid_until: null,
    next_contact: null, template: false, items, installments: [], equipment: null, serial_number: null, technician: null, defect: null, solution: null,
  };
  for (const f of ["discount_mode", "discount_value", "freight", "other_expenses", "payment_terms", "delivery_terms", "notes", "internal_notes"]) data[f] = arrowOrNull(body, f);
  if (kind !== "purchase_orders" && fieldText(body, "seller_id") !== null) data.seller_id = body.seller_id;
  // 168: a cópia mantém a categoria e o transportador enquanto ainda podem ser escolhidos.
  if (ctx.parts.finance && categoryUsable(db, kind!, fieldText(body, "category_id"))) data.category_id = body.category_id;
  if (carrierUsable(db, fieldText(body, "carrier_id"))) data.carrier_id = body.carrier_id;
  // 196: Lista de preço (válida agora), Destino (conta ativa), Detalhes de pagamento e os impostos.
  const listId = fieldText(body, "price_list_id");
  const list = listId === null ? undefined : one(db, 'SELECT starts_on, ends_on, considers_datetime, start_time, end_time FROM "erp_pricing__price_list" WHERE id=?', listId);
  if (
    list &&
    validNow({
      starts_on: (list.starts_on as string | null) ?? null, ends_on: (list.ends_on as string | null) ?? null, considers_datetime: Number(list.considers_datetime) === 1,
      start_time: (list.start_time as string | null) ?? null, end_time: (list.end_time as string | null) ?? null,
    } as Parameters<typeof validNow>[0])
  )
    data.price_list_id = body.price_list_id;
  const accountId = fieldText(body, "payment_account_id");
  if (ctx.parts.finance && accountId !== null && one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1', accountId)) data.payment_account_id = body.payment_account_id;
  // 270: Outros itens ou serviços e Condições comerciais da proposta.
  for (const f of ["payment_means", "payment_indicator", "tax_ipi", "tax_icms_st", "other_items", "commercial_conditions"]) if (has(body, f)) data[f] = body[f];
  // 287: os campos customizados da OS cujo campo segue ativo.
  if (kind === "service_orders" && jsonType(body.custom_fields) === "object") {
    const fields: Data = {};
    for (const [k, v] of Object.entries(body.custom_fields as Data))
      if (one(db, 'SELECT 1 x FROM "erp_documents__custom_field" WHERE id=? AND kind=? AND active=1', k, kind)) fields[k] = v;
    if (Object.keys(fields).length) data.custom_fields = fields;
  }
  if (hasCommercialData(documentDto(ctx, sourceId!))) {
    items = items.map((i) => ({ ...i, detailed_description: has(i, "detailed_description") ? i.detailed_description : null }));
    data = { ...data, commercial: arrowOrNull(body, "commercial"), items };
  } else if (has(body, "commercial")) data.commercial = body.commercial;
  // A prévia é uma resposta pública. Metadados de disponibilidade ficam fora
  // do corpo editável, que deve continuar aceito por erp_document_copy.
  const { unavailable_parts, ...copyData } = projectDocument(ctx, withoutUnavailableLinks(ctx, data));
  // Este formulário cria um documento novo: referências suspensas são
  // explicitamente limpas, sem devolver os valores guardados na origem.
  if (!ctx.parts.stock) copyData.warehouse_id = null;
  if (!ctx.parts.finance) { copyData.category_id = null; copyData.payment_account_id = null; }
  return {
    source: { id: s!.id, kind: s!.kind, number: s!.number === null ? null : String(s!.number), version: s!.version },
    data: copyData,
    ...(unavailable_parts ? { unavailable_parts } : {}),
    reset_fields: keepDate
      ? ["valid_until", "next_contact", "installments", "template", "equipment", "serial_number", "technician", "defect", "solution"]
      : ["date", "expected_date", "valid_until", "next_contact", "installments", "template", "equipment", "serial_number", "technician", "defect", "solution"],
    persisted: false,
    ...NATIVE,
  };
}

registerRpc("erp_document_custom_field_save", erpDocumentCustomFieldSave);
registerRpc("erp_document_custom_field_delete", erpDocumentCustomFieldDelete);
registerRpc("erp_document_discount_approval_save", erpDocumentDiscountApprovalSave);
registerRpc("erp_document_list_view_save", erpDocumentListViewSave);
registerRpc("erp_document_numbering_set", erpDocumentNumberingSet);
registerRpc("erp_document_occurrence_remove", erpDocumentOccurrenceRemove);
registerRpc("erp_document_print_header_save", erpDocumentPrintHeaderSave);
registerRpc("erp_document_signature_save", erpDocumentSignatureSave);
registerRpc("erp_document_copy_preview", erpDocumentCopyPreview);
