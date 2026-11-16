// public.erp_finance_list: a lista por cursor do 010 (contas, categorias,
// títulos, baixas de um título, movimentos de uma conta), sobre o DTO.
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { dateArgError } from "../../../engine/time.ts";
import { btrim, charLength, cmpText, pgLower, requireAccess, uuidArg } from "../internal.ts";
import { dto } from "../titles.ts";

const TABLES: Record<string, string> = {
  accounts: `SELECT id FROM "erp_finance__account" WHERE deleted_at IS NULL`,
  categories: `SELECT id FROM "erp_finance__category" WHERE deleted_at IS NULL`,
  titles: `SELECT id FROM "erp_finance__title"`,
  settlements: `SELECT id FROM "erp_finance__settlement" WHERE title_id=?`,
  movements: `SELECT id FROM "erp_finance__movement" WHERE account_id=?`,
};

function dateArg(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const bad = dateArgError(String(v));
  if (bad) raise(bad.code, bad.message);
  return String(v);
}

export function erpFinanceList(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const after = uuidArg(a.p_after);
  const from = dateArg(a.p_from);
  const to = dateArg(a.p_to);
  const parent = uuidArg(a.p_parent_id);
  const entity = (a.p_entity as string | null) ?? null;
  const limit = (a.p_limit as number | null);
  const query = (a.p_query as string | null) ?? null;
  const status = (a.p_status as string | null) ?? null;
  const kind = (a.p_kind as string | null) ?? null;
  requireAccess(db, user, false);
  if (
    entity === null || !(entity in TABLES) ||
    limit === null || limit < 1 || limit > 100 ||
    (query !== null && charLength(query) > 120) ||
    (status !== null && !["open", "partial", "paid", "cancelled", "overdue"].includes(status)) ||
    (kind !== null && !["receivable", "payable", "both", "bank", "cash", "other", "payment", "reversal", "opening"].includes(kind)) ||
    (from !== null && (from < "1900-01-01" || from > "2100-12-31")) ||
    (to !== null && (to < "1900-01-01" || to > "2100-12-31")) ||
    (from !== null && to !== null && from > to) ||
    (["settlements", "movements"].includes(entity) && parent === null)
  )
    raise("22023", "erp_finance_invalid_query");
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  const text = (item: Record<string, unknown>, key: string) => {
    const v = item[key];
    return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
  };
  const ids = db
    .exec(TABLES[entity], ...(["settlements", "movements"].includes(entity) ? [parent] : []))
    .rows.map((r) => String(r.id))
    .filter((id) => after === null || id > after)
    .sort(cmpText);
  const page: Record<string, unknown>[] = [];
  for (const id of ids) {
    const item = dto(db, entity, id)!;
    if (
      needle !== null &&
      !pgLower(["name", "description", "contact_name", "source_reference"].map((k) => text(item, k)).filter((v) => v !== null).join(" ")).includes(needle)
    )
      continue;
    if (status !== null && !(text(item, "status") === status || (status === "overdue" && text(item, "overdue") === "true"))) continue;
    if (kind !== null && text(item, "kind") !== kind) continue;
    const day = text(item, "due_on") ?? text(item, "posted_on");
    if (from !== null && !(day !== null && day >= from)) continue;
    if (to !== null && !(day !== null && day <= to)) continue;
    page.push(item);
    if (page.length > limit) break;
  }
  const more = page.length > limit;
  const items = more ? page.slice(0, limit) : page;
  return {
    entity,
    items,
    limit,
    has_more: more,
    next_cursor: more ? (items[limit - 1].id as string) : null,
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_list", erpFinanceList);
