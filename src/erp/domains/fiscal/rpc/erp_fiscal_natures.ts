// Fiscal, bloco F1: naturezas de operação (versões finais no oráculo).
// public.erp_fiscal_nature_execute (create, update, clone, set_active,
// set_default, delete), _get, _list e _review_confirm.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLeft, pgLength, pgLower } from "../../../engine/text.ts";
import { commandHash, commandReplay, finishCommand, requireRead, requireWrite, uuidInput, versionInput, type Json } from "../core.ts";
import { insertNature, natureDefaults, natureInput, natureRecord, natureReviewRecord, natureRow, replaceRules } from "../natures.ts";

const ACTIONS = ["create", "update", "clone", "set_active", "set_default", "delete"];
const DEFAULT_CODES = ["S", "E", "VF", "VJ", "CF", "CJ", "C", "DE", "DS"];
const KEYS: Record<string, string[]> = {
  create: ["nature"], update: ["id", "expected_version", "nature"], clone: ["id", "expected_version"], set_active: ["id", "expected_version", "active"],
  delete: ["id", "expected_version"], set_default: ["id", "expected_version", "code"],
};
const str = (v: unknown) => (typeof v === "string" ? v : null);
const NATURE = "erp_fiscal_invoices__nature";

export function erpFiscalNatureExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const commandId = str(a.p_command_id);
  const action = str(a.p_action);
  const data = jsonbArg(a.p_data);
  requireWrite(db, user);
  if (
    commandId === null || action === null || !ACTIONS.includes(action) || data === null || jsonType(data) !== "object" ||
    new TextEncoder().encode(jsonbText(data)).length > 262144
  )
    raise("22023", "erp_fiscal_command_invalid");
  const d = data as Json;
  const keys = KEYS[action!];
  if (Object.keys(d).some((k) => !keys.includes(k)) || keys.some((k) => !Object.prototype.hasOwnProperty.call(d, k))) raise("22023", "erp_fiscal_unknown_field");
  const input = action === "create" || action === "update" ? natureInput(db, d.nature) : null;
  let id: string | null = null;
  let expected = 0;
  if (action !== "create") {
    id = uuidInput(d.id);
    expected = versionInput(d.expected_version);
  }
  if (action === "set_active" && jsonType(d.active) !== "boolean") raise("22023", "erp_fiscal_command_invalid");
  let code: string | null = null;
  if (action === "set_default") {
    code = d.code === null || d.code === undefined ? null : typeof d.code === "string" ? d.code : jsonbText(d.code);
    if (jsonType(d.code) !== "string" || !DEFAULT_CODES.includes(code!)) raise("22023", "erp_fiscal_command_invalid");
  }
  const hash = commandHash(user, "nature", action!, data);
  const replay = commandReplay(db, commandId!, user!, "nature", hash);
  if (replay) return replay;
  let n: Json | null = null;
  if (action !== "create") {
    n = natureRow(db, id);
    if (!n || n.deleted_at !== null) raise("P0002", "erp_fiscal_nature_not_found");
    if (n!.version !== expected || n!.version === 2147483647) raise("40001", "erp_fiscal_nature_version_conflict");
  }
  if (action === "update" && input!.direction !== n!.direction) raise("22023", "erp_fiscal_nature_direction_immutable");
  let bumped = true;
  const now = () => ctx.clock.next().toString();
  if (action === "create") {
    id = insertNature(ctx, input!, user!);
    replaceRules(db, id, input!.rules as Json[]);
  } else if (action === "update") {
    const i = input!;
    db.exec(
      `UPDATE "${NATURE}" SET description=?, series=?, crt=?, presence=?, invoiced=?, final_consumer=?, return_operation=?, update_last_purchase_price=?,
         include_freight_ipi_base=?, others=?, retentions=?, additional_info=?, fiscal_info=?, version=version+1, updated_by=?, updated_at=?, description__fold=? WHERE id=?`,
      i.description, i.series, i.crt, i.presence, i.invoiced ? 1 : 0, i.final_consumer ? 1 : 0, i.return_operation ? 1 : 0, i.update_last_purchase_price ? 1 : 0,
      i.include_freight_ipi_base ? 1 : 0, JSON.stringify(i.others), JSON.stringify(i.retentions), i.additional_info, i.fiscal_info, user, now(), pgLower(String(i.description)), id,
    );
    replaceRules(db, id!, i.rules as Json[]);
  } else if (action === "clone") {
    const src = n!;
    const copy = id;
    id = insertNature(ctx, { ...src, description: pgLeft(`Cópia de ${src.description}`, 60) }, user!);
    db.exec(
      `INSERT INTO "erp_fiscal_invoices__nature_rule"(nature_id, tax, position, destinations, product_scope, ncms, product_ids, group_ids, data, additional_info, fiscal_info)
         SELECT ?, tax, position, destinations, product_scope, ncms, product_ids, group_ids, data, additional_info, fiscal_info FROM "erp_fiscal_invoices__nature_rule" WHERE nature_id=?`,
      id, copy,
    );
  } else if (action === "set_active") {
    const active = d.active as boolean;
    if (n!.active === active) raise("40001", "erp_fiscal_nature_state_conflict");
    db.exec(`UPDATE "${NATURE}" SET active=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`, active ? 1 : 0, user, now(), id);
    if (!active) db.exec('DELETE FROM "erp_fiscal_invoices__nature_default" WHERE nature_id=?', id);
  } else if (action === "delete") {
    // Exclusão lógica: as notas guardam a descrição e as revisões, as regras.
    db.exec('DELETE FROM "erp_fiscal_invoices__nature_default" WHERE nature_id=?', id);
    const t = now();
    db.exec(`UPDATE "${NATURE}" SET active=0, deleted_at=?, deleted_by=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`, t, user, user, t, id);
  } else {
    if (n!.active !== true) raise("40001", "erp_fiscal_nature_inactive");
    if ((["S", "VF", "VJ", "C", "DS"].includes(code!) ? "1" : "0") !== n!.direction) raise("22023", "erp_fiscal_nature_default_direction");
    if (one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__nature_default" WHERE code=? AND nature_id=?', code, id)) raise("40001", "erp_fiscal_nature_state_conflict");
    db.exec(
      'INSERT INTO "erp_fiscal_invoices__nature_default"(code, nature_id, updated_at) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET nature_id=excluded.nature_id, updated_at=excluded.updated_at',
      code, id, now(),
    );
    bumped = false;
  }
  const rec = natureRecord(db, id)!;
  if (bumped) db.exec('INSERT INTO "erp_fiscal_invoices__nature_revision"(nature_id, version, record) VALUES(?,?,?)', id, rec.version, JSON.stringify(rec));
  const result = { nature: rec, action, replayed: false, data_mode: "erp_native" };
  return finishCommand(ctx, { commandId: commandId!, actor: user!, scope: "nature", hash, result, entity: id, version: rec.version as number, action: action!, reason: code });
}

export function erpFiscalNatureGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireRead(db, str(a.p_user_id));
  const id = str(a.p_id);
  if (id === null) raise("22023", "erp_fiscal_query_invalid");
  if (one(db, `SELECT 1 x FROM "${NATURE}" WHERE id=? AND deleted_at IS NOT NULL`, id)) raise("P0002", "erp_fiscal_nature_not_found");
  const r = natureRecord(db, id);
  if (!r) raise("P0002", "erp_fiscal_nature_not_found");
  return { nature: r, writable: ["admin", "fiscal"].includes(role), data_mode: "erp_native" };
}

export function erpFiscalNatureList(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireRead(db, str(a.p_user_id));
  const active = a.p_active as boolean | null;
  const query = str(a.p_query);
  const direction = str(a.p_direction);
  const crt = str(a.p_crt);
  const page = a.p_page as number | null;
  const limit = a.p_limit as number | null;
  const q = query === null ? null : pgBtrim(query) || null;
  if (
    active === null || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 || (query !== null && pgLength(query) > 120) ||
    (query !== null && pgHasCntrl.test(query)) || (direction !== null && !["0", "1"].includes(direction)) || (crt !== null && !["1", "2", "3", "4"].includes(crt))
  )
    raise("22023", "erp_fiscal_query_invalid");
  const rows = db
    .exec(
      `SELECT id, description, series, direction, crt, presence, invoiced, final_consumer, return_operation, active, version FROM "${NATURE}"
        WHERE deleted_at IS NULL AND active=? AND (? IS NULL OR direction=?) AND (? IS NULL OR crt=?)`,
      active ? 1 : 0, direction, direction, crt, crt,
    )
    .rows.map((n) => ({ n, key: pgLower(String(n.description)) }))
    .filter((x) => q === null || x.key.includes(pgLower(q)))
    .sort((x, y) => pgCompareText(x.key, y.key) || pgCompareText(String(x.n.id), String(y.n.id)));
  const items = rows.slice((page! - 1) * limit!, (page! - 1) * limit! + limit!).map(({ n }) => ({
    id: n.id, description: n.description, series: n.series ?? null, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced === 1,
    final_consumer: n.final_consumer === 1, return_operation: n.return_operation === 1, active: n.active === 1, version: Number(n.version),
    defaults: natureDefaults(db, String(n.id)),
    rule_count: Number(one(db, 'SELECT count(*) n FROM "erp_fiscal_invoices__nature_rule" WHERE nature_id=?', n.id)!.n),
  }));
  return {
    items, page, limit, total_count: rows.length, writable: ["admin", "fiscal"].includes(role), review: natureReviewRecord(db), data_mode: "erp_native",
  };
}

export function erpFiscalNatureReviewConfirm(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const commandId = str(a.p_command_id);
  const expected = a.p_expected_version as number | null;
  requireWrite(db, user);
  if (commandId === null || expected === null || expected < 0 || expected > 2147483646) raise("22023", "erp_fiscal_command_invalid");
  const hash = commandHash(user, "nature", "confirm_review", { expected_version: expected });
  const replay = commandReplay(db, commandId!, user!, "nature", hash);
  if (replay) return replay;
  const r = one(db, 'SELECT version FROM "erp_fiscal_invoices__nature_review" WHERE singleton=1');
  if ((r ? Number(r.version) : 0) !== expected) raise("40001", "erp_fiscal_nature_review_version_conflict");
  const version = r ? Number(r.version) + 1 : 1;
  db.exec(
    `INSERT INTO "erp_fiscal_invoices__nature_review"(singleton, version, confirmed_by, confirmed_at) VALUES(1,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET version=excluded.version, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at`,
    version, user, ctx.clock.next().toString(),
  );
  const result = { review: natureReviewRecord(db), action: "confirm_review", replayed: false, data_mode: "erp_native" };
  return finishCommand(ctx, { commandId: commandId!, actor: user!, scope: "nature", hash, result, entity: null, version, action: "confirm_review" });
}

registerRpc("erp_fiscal_nature_execute", erpFiscalNatureExecute);
registerRpc("erp_fiscal_nature_get", erpFiscalNatureGet);
registerRpc("erp_fiscal_nature_list", erpFiscalNatureList);
registerRpc("erp_fiscal_nature_review_confirm", erpFiscalNatureReviewConfirm);
