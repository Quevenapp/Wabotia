// Leituras do B2 do Documentos (sessão L): o documento, as situações do tipo,
// as ocorrências e o frete pago (leitura e gravação, com recibo próprio).
// Portado de public.erp_document_get, _situations, _occurrence_list,
// _freight_paid_get e _freight_paid_save com os mesmos nomes. O núcleo
// (documentView, situações) é da O em ../internal.ts; situações, transições e
// "Meu Negócio" vêm do domínio 11 (preferences/shared.ts).
// erp_document_mirror.require_visible abre cada leitura, como no oráculo
// (mirrorRequireVisible; ERP-PORTE.md, "Origin fora não é sem efeito").
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { formatScaled, fromColumn, toParam, toScaled } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength } from "../../../engine/text.ts";
import { bizCostVisible, bizFreight, bizRole, situationList, transitionList } from "../../preferences/shared.ts";
import { documentSituationJson, documentView, preference, situationAdopted } from "../internal.ts";
import { allowed, contactUsable, mirrorRequireVisible, requireAccess } from "../public.ts";
import { occurrenceJson } from "../views.ts";

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;

/** public.erp_document_get(p_user_id, p_kind, p_id) */
export function erpDocumentGet(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_id);
  mirrorRequireVisible(ctx.db, user, id, false);
  requireAccess(ctx.db, user, kind, false);
  const d = id === null || kind === null ? null : one(ctx.db, 'SELECT contact_id FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!d || !contactUsable(ctx.db, user, str(d.contact_id))) raise("P0002", "erp_document_not_found");
  return { kind, document: documentView(ctx, id!), ...NATIVE };
}

/** public.erp_document_situations(p_user_id, p_kind): situações e transições do tipo, quando adotadas. */
export function erpDocumentSituations(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind);
  requireAccess(ctx.db, user, kind, false);
  const adopted = situationAdopted(ctx.db, kind);
  const situations = adopted
    ? situationList(ctx.db, kind!)
        .sort(
          (x, y) =>
            x.ordinal - y.ordinal ||
            Number(y.is_default) - Number(x.is_default) ||
            (x.created_at === y.created_at ? 0 : x.created_at === null ? 1 : y.created_at === null ? -1 : x.created_at < y.created_at ? -1 : 1) ||
            pgCompareText(x.key, y.key),
        )
        .map((s) => ({ key: s.key, base_status: s.base_status, name: s.name, color: s.color, default: s.is_default, active: s.active }))
    : [];
  const transitions = adopted
    ? transitionList(ctx.db, kind!)
        .sort((x, y) => pgCompareText(x.from_ord, y.from_ord) || pgCompareText(x.to_ord, y.to_ord))
        .map((t) => ({ from: t.from_key, to: t.to_key, active: t.active, actions: t.actions }))
    : [];
  return {
    kind,
    adopted,
    situations,
    transitions,
    occurrence_date_editable: preference(ctx.db, "empresa.editar_data_ocorrencia") === true,
    ...NATIVE,
  };
}

/** public.erp_document_occurrence_list(p_user_id, p_kind, p_document_id): as 500 ocorrências mais novas, sem as removidas. */
export function erpDocumentOccurrenceList(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  mirrorRequireVisible(db, user, id, false);
  requireAccess(db, user, kind, false);
  const m = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  const d = id === null || kind === null ? null : one(db, 'SELECT id, kind, number, status, version, contact_id FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!d || !contactUsable(db, user, str(d.contact_id))) raise("P0002", "erp_document_not_found");
  const rows = db
    .exec(
      `SELECT x.*, CAST(x.recorded_at AS TEXT) recorded_at FROM "erp_documents__occurrence" x
        WHERE x.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_documents__occurrence_removal" r WHERE r.occurrence_id=x.id)`,
      id,
    )
    .rows.sort((x, y) => Number(y.sequence) - Number(x.sequence));
  const items = rows.slice(0, 500).map((o) => {
    const p = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', o.actor_id);
    return { ...occurrenceJson(o), actor_name: p ? pgLeft(String(p.name), 120) : null };
  });
  return {
    kind,
    document: {
      id: d.id,
      kind: d.kind,
      number: d.number === null ? null : String(d.number),
      status: d.status,
      version: Number(d.version),
      situation: documentSituationJson(db, id!),
    },
    items,
    has_more: rows.length > 500,
    can_write: allowed(m ? String(m.role) : null, kind, true),
    date_editable: preference(db, "empresa.editar_data_ocorrencia") === true,
    ...NATIVE,
  };
}

/** erp_documents.freight_paid_view(p_document): frete cobrado (do corpo), frete pago e os custos aplicados aos itens. */
export function freightPaidView(db: SqlDriver, id: string) {
  const d = one(db, 'SELECT id, kind, body FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  const f = one(db, 'SELECT amount, note, version FROM "erp_documents__freight_paid" WHERE document_id=?', id);
  const costs = db
    .exec('SELECT item_id, product_id, unit_cost, basis, applied_on, CAST(applied_at AS TEXT) applied_at FROM "erp_documents__item_cost_applied" WHERE document_id=?', id)
    .rows.sort((x, y) => {
      const a = BigInt(String(x.applied_at)),
        b = BigInt(String(y.applied_at));
      return a < b ? -1 : a > b ? 1 : pgCompareText(str(x.item_id), str(y.item_id));
    })
    .map((c) => ({ item_id: c.item_id, product_id: c.product_id, unit_cost: str(c.unit_cost), basis: c.basis, applied_on: str(c.applied_on) }));
  return {
    document_id: d.id,
    kind: d.kind,
    freight_charged: formatScaled(bizFreight(JSON.parse(String(d.body))), 2),
    freight_paid: f ? formatScaled(fromColumn(f.amount), 2) : null,
    note: f ? f.note : null,
    version: f ? Number(f.version) : 0,
    applied_costs: costs,
  };
}

/** public.erp_document_freight_paid_get(p_user_id, p_kind, p_document_id) */
export function erpDocumentFreightPaidGet(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  mirrorRequireVisible(ctx.db, user, id, false);
  if (kind !== "sales_orders" || id === null) raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, false);
  if (!bizCostVisible(bizRole(ctx.db, user))) raise("42501", "erp_document_access_denied");
  if (!one(ctx.db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind)) raise("P0002", "erp_document_not_found");
  return { entity: "freight_paid", kind, ...NATIVE, item: freightPaidView(ctx.db, id) };
}

const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

/** public.erp_document_freight_paid_save(p_user_id, p_kind, p_document_id, p_expected_version, p_command_id, p_data): o frete pago do pedido. */
export function erpDocumentFreightPaidSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id),
    expected = a.p_expected_version === null || a.p_expected_version === undefined ? null : Number(a.p_expected_version),
    command = str(a.p_command_id),
    data = a.p_data as Record<string, unknown> | null | undefined;
  mirrorRequireVisible(db, user, id, true);
  const isObj = data !== null && data !== undefined && jsonType(data) === "object";
  const typeOk = (v: unknown) => v === null || typeof v === "string";
  if (
    kind !== "sales_orders" ||
    id === null ||
    command === null ||
    expected === null ||
    expected < 0 ||
    expected > 2147483646 ||
    !isObj ||
    Object.keys(data!).some((k) => k !== "amount" && k !== "note") ||
    !("amount" in data! && "note" in data!) ||
    !typeOk(data!.amount) ||
    !typeOk(data!.note) ||
    (data!.amount !== null && !MONEY.test(String(data!.amount)))
  )
    raise("22023", "erp_document_input_invalid");
  requireAccess(db, user, kind, true);
  if (!bizCostVisible(bizRole(db, user))) raise("42501", "erp_document_access_denied");
  const amount = data!.amount === null ? null : toScaled(String(data!.amount), 2);
  const note = data!.note === null || pgBtrim(String(data!.note)) === "" ? null : pgBtrim(String(data!.note));
  if (note !== null && (pgLength(note) > 200 || pgHasCntrl.test(note))) raise("22023", "erp_document_input_invalid");
  const hash = createHash("sha256")
    .update(jsonbText({ profile: "erp-document-freight-paid-v1", actor: user, document: id, version: expected, data }), "utf8")
    .digest("hex");
  const done = one(db, 'SELECT actor, request_hash, result FROM "erp_documents__freight_paid_command" WHERE command_id=?', command);
  if (done) {
    if (done.actor !== user || done.request_hash !== hash) raise("40001", "erp_document_command_conflict");
    return { ...JSON.parse(String(done.result)), replayed: true };
  }
  if (!one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind)) raise("P0002", "erp_document_not_found");
  const row = one(db, 'SELECT amount, version FROM "erp_documents__freight_paid" WHERE document_id=?', id);
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_document_version_conflict");
  if (amount === null) {
    if (row) raise("22023", "erp_document_input_invalid");
  } else if (!row)
    db.exec(
      'INSERT INTO "erp_documents__freight_paid"(document_id, amount, note, version, updated_by, updated_at) VALUES (?,?,?,1,?,?)',
      id,
      toParam(amount),
      note,
      user,
      ctx.clock.next().toString(),
    );
  else
    db.exec(
      'UPDATE "erp_documents__freight_paid" SET amount=?, note=?, version=version+1, updated_by=?, updated_at=? WHERE document_id=?',
      toParam(amount),
      note,
      user,
      ctx.clock.next().toString(),
      id,
    );
  db.exec(
    'INSERT INTO "erp_documents__freight_paid_audit"(id, document_id, actor, command_id, before_amount, after_amount, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__freight_paid_audit", "id"),
    id,
    user,
    command,
    row ? toParam(fromColumn(row.amount)) : null,
    amount === null ? null : toParam(amount),
    note,
    ctx.clock.next().toString(),
  );
  const result = { entity: "freight_paid", kind, ...NATIVE, replayed: false, item: freightPaidView(db, id!) };
  db.exec(
    'INSERT INTO "erp_documents__freight_paid_command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)',
    command,
    user,
    hash,
    jsonbText(result),
    ctx.clock.next().toString(),
  );
  return result;
}

registerRpc("erp_document_get", erpDocumentGet);
registerRpc("erp_document_situations", erpDocumentSituations);
registerRpc("erp_document_occurrence_list", erpDocumentOccurrenceList);
registerRpc("erp_document_freight_paid_get", erpDocumentFreightPaidGet);
registerRpc("erp_document_freight_paid_save", erpDocumentFreightPaidSave);
