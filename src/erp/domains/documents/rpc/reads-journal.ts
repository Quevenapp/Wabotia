// Diário da ordem de serviço (sessão L, bloco B0): erp_service_journal_get,
// _list e _append (escritor, com recibo próprio em
// erp_documents.service_journal_command). Portado com os mesmos nomes.
// erp_document_mirror.require_visible abre o service_journal_context, como no
// oráculo (lá ele também abre cada RPC, com o mesmo p_write ou mais fraco: a
// segunda chamada não muda nada). O lock consultivo por comando não tem
// equivalente no objeto (uma transação por vez).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { valueJson } from "../../../engine/row-json.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { ERP_TABLES } from "../../../schema/columns.generated.ts";
import { allowed, contactUsable, mirrorRequireVisible, requireAccess } from "../public.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const RECORDED = ERP_TABLES.erp_documents__service_journal_entry.columns.recorded_at;

/** erp_documents.service_journal_context(p_user_id, p_document_id, p_write): a OS visível e se o usuário pode escrever. */
export function serviceJournalContext(db: SqlDriver, user: string | null, document: string | null, write = false) {
  mirrorRequireVisible(db, user, document, write);
  requireAccess(db, user, "service_orders", write);
  const d = document === null ? null : one(db, `SELECT id, version, contact_id, authority FROM "erp_documents__document" WHERE id=? AND kind='service_orders'`, document);
  if (!d || !contactUsable(db, user, str(d.contact_id))) raise("P0002", "erp_journal_not_found");
  const r = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  return {
    scope: "service_order_journal",
    document_id: d.id,
    document_version: Number(d.version),
    can_write: d.authority !== "origin" && allowed(r ? String(r.role) : null, "service_orders", true),
    data_mode: "erp_native",
    operational_effects: false,
  };
}

/** erp_documents.service_journal_item(e) */
export const serviceJournalItem = (e: Row) => ({
  id: e.id,
  document_id: e.document_id,
  sequence: String(e.sequence),
  document_version: Number(e.document_version),
  text: e.text,
  actor_id: e.actor_id,
  recorded_at: valueJson(RECORDED, e.recorded_at),
});

const ENTRY = 'SELECT id, document_id, sequence, document_version, text, actor_id, CAST(recorded_at AS TEXT) recorded_at FROM "erp_documents__service_journal_entry"';

/** public.erp_service_journal_get(p_user_id, p_document_id, p_entry_id) */
export function erpServiceJournalGet(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    document = str(a.p_document_id),
    entry = str(a.p_entry_id);
  const context = serviceJournalContext(ctx.db, user, document);
  const e = entry === null ? null : one(ctx.db, `${ENTRY} WHERE document_id=? AND id=?`, document, entry);
  if (!e) raise("P0002", "erp_journal_not_found");
  return { ...context, entry: serviceJournalItem(e) };
}

/** public.erp_service_journal_list(p_user_id, p_document_id, p_limit, p_before): do mais novo ao mais velho, com cursor. */
export function erpServiceJournalList(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    document = str(a.p_document_id),
    limit = a.p_limit === null || a.p_limit === undefined ? null : Number(a.p_limit),
    before = str(a.p_before);
  const context = serviceJournalContext(ctx.db, user, document);
  if (limit === null || limit < 1 || limit > 100 || (before !== null && !/^[1-9][0-9]{0,9}$/.test(before))) raise("22023", "erp_journal_invalid_query");
  const rows = ctx.db
    .exec(`${ENTRY} WHERE document_id=?${before === null ? "" : " AND sequence<?"}`, ...(before === null ? [document] : [document, before]))
    .rows.sort((x, y) => Number(y.sequence) - Number(x.sequence))
    .slice(0, limit + 1);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    ...context,
    items: page.map(serviceJournalItem),
    limit,
    has_more: more,
    next_before: more ? String(Math.min(...page.map((r) => Number(r.sequence)))) : null,
  };
}

const utf8 = new TextEncoder();
const NOT_BLANK = /[^ \t\r\n]/;

/** public.erp_service_journal_append(p_user_id, p_document_id, p_expected_document_version, p_command_id, p_text): uma anotação no diário. */
export function erpServiceJournalAppend(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    document = str(a.p_document_id),
    expected = a.p_expected_document_version === null || a.p_expected_document_version === undefined ? null : Number(a.p_expected_document_version),
    command = str(a.p_command_id),
    raw = str(a.p_text);
  serviceJournalContext(ctx.db, user, document, true);
  const text = raw === null ? null : pgBtrim(raw);
  if (
    command === null ||
    expected === null ||
    expected < 1 ||
    text === null ||
    pgLength(text) > 4000 ||
    utf8.encode(raw!).length > 32768 ||
    !NOT_BLANK.test(text) ||
    pgHasCntrl.test(text.replace(/[\n\r\t]/g, ""))
  )
    raise("22023", "erp_journal_invalid_input");
  const hash = createHash("sha256").update(jsonbText({ actor: user, document, version: expected, text: raw }), "utf8").digest("hex");
  const c = one(ctx.db, 'SELECT actor_id, request_hash, entry_id FROM "erp_documents__service_journal_command" WHERE command_id=?', command);
  if (c) {
    if (c.actor_id !== user || c.request_hash !== hash) raise("40001", "erp_journal_command_conflict");
    return { ...erpServiceJournalGet(ctx, { p_user_id: user, p_document_id: document, p_entry_id: c.entry_id }), replayed: true };
  }
  const d = one(ctx.db, `SELECT version FROM "erp_documents__document" WHERE id=? AND kind='service_orders'`, document);
  if (!d) raise("P0002", "erp_journal_not_found");
  if (Number(d.version) !== expected) raise("40001", "erp_journal_document_changed");
  const sequence = Number(one(ctx.db, 'SELECT coalesce(max(sequence),0) m FROM "erp_documents__service_journal_entry" WHERE document_id=?', document)!.m) + 1;
  if (sequence > 9999999999) raise("22023", "erp_journal_limit");
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  ctx.db.exec(
    'INSERT INTO "erp_documents__service_journal_entry"(id, document_id, sequence, document_version, text, actor_id, recorded_at) VALUES (?,?,?,?,?,?,?)',
    id,
    document,
    sequence,
    Number(d.version),
    text,
    user,
    now,
  );
  ctx.db.exec(
    'INSERT INTO "erp_documents__service_journal_command"(command_id, actor_id, request_hash, entry_id, created_at) VALUES (?,?,?,?,?)',
    command,
    user,
    hash,
    id,
    now,
  );
  const e = one(ctx.db, `${ENTRY} WHERE id=?`, id)!;
  return { ...serviceJournalContext(ctx.db, user, document, true), entry: serviceJournalItem(e), replayed: false };
}

registerRpc("erp_service_journal_get", erpServiceJournalGet);
registerRpc("erp_service_journal_list", erpServiceJournalList);
registerRpc("erp_service_journal_append", erpServiceJournalAppend);
