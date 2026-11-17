// public.erp_finance_bordero_execute (baixa em lote, agrupada ou não, e
// exclusão do borderô com o estorno das baixas ativas), erp_finance_bordero_get
// e erp_finance_bordero_page.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { dateArgError } from "../../../engine/time.ts";
import {
  accountRow,
  
  bool,
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  expected,
  field,
  insertAudit,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  setFlag,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
} from "../internal.ts";
import { borderoActive, borderoDto, deleteBordero, settlementText } from "../borderos.ts";
import { insertBordero, insertSettlement, postSettlementMovements } from "../settlements.ts";
import { activeCategory, dto, updateTitle } from "../titles.ts";

const UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function erpFinanceBorderoExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);

  requireAccess(db, user, true);
  if (command === null || action === null || !["settle_batch", "bordero_delete"].includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 65536) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let result: Record<string, unknown>;
  let before: unknown = null;
  const rows: unknown[] = [];

  if (action === "settle_batch") {
    keys(data, ["kind", "grouped", "account_id", "category_id", "note", "items"]);
    const kind = txt(data, "kind", 20, true)!;
    if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    if (jsonType(field(data, "grouped")) !== "boolean") raise("22023", "erp_finance_invalid_data");
    const grouped = field(data, "grouped") as boolean;
    // 249: o Histórico da baixa vai até 2.000; borderô e movimento guardam os primeiros 500.
    const { note, history } = settlementText(data);
    const items = field(data, "items");
    if (jsonType(items) !== "array" || (items as unknown[]).length < 1 || (items as unknown[]).length > 100)
      raise("22023", "erp_finance_invalid_items");
    const list = items as unknown[];
    const destination = uuidValue(field(data, "account_id"), false);
    const topCategory = uuidValue(field(data, "category_id"), false);
    if (grouped && (list.length < 2 || destination === null)) raise("22023", "erp_finance_invalid_grouping");
    if (!grouped && (destination !== null || topCategory !== null)) raise("22023", "erp_finance_invalid_grouping");
    const ids = list.map((item) => uuidValue(field(item, "id"))!).sort(cmpText);
    if (new Set(ids).size !== list.length) raise("22023", "erp_finance_invalid_items");
    let accountId: string | null = null;
    if (grouped) {
      const account = accountRow(db, destination!);
      if (!account || !bool(account.active)) raise("22023", "erp_finance_invalid_account");
      accountId = destination;
      if (topCategory !== null) activeCategory(db, topCategory, kind);
    }
    const ordered = [...list].sort((x, y) => cmpText(uuidValue(field(x, "id"))!, uuidValue(field(y, "id"))!));
    let borderoId: string | null = null;
    let groupDay: string | null = null;
    const borderos: string[] = [];
    for (const item of ordered) {
      keys(item, ["id", "expected_version", "account_id", "category_id", "posted_on", "principal_cents", "interest_cents", "penalty_cents", "discount_cents", "fee_cents"]);
      const id = uuidValue(field(item, "id"))!;
      const title = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
      if (!title) raise("P0002", "erp_finance_not_found");
      if (title.version !== expected(field(item, "expected_version"))) raise("40001", "erp_finance_version_conflict");
      if (title.kind !== kind) raise("22023", "erp_finance_invalid_kind");
      if (bool(title.cancelled)) raise("40001", "erp_finance_cancelled_title");
      const postedOn = day(field(item, "posted_on"), true);
      if (postedOn < String(title.issued_on)) raise("22023", "erp_finance_payment_before_issue");
      if (grouped) {
        if (uuidValue(field(item, "account_id")) !== destination || (groupDay !== null && postedOn !== groupDay))
          raise("22023", "erp_finance_invalid_grouping");
        groupDay = postedOn;
      } else {
        accountId = uuidValue(field(item, "account_id"))!;
        const account = accountRow(db, accountId);
        if (!account || !bool(account.active)) raise("22023", "erp_finance_invalid_account");
      }
      if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND kind='opening' AND posted_on>? LIMIT 1`, accountId, postedOn))
        raise("22023", "erp_finance_payment_before_opening");
      const category = uuidValue(field(item, "category_id"), false);
      if (category !== null) activeCategory(db, category, kind);
      const principal = cents(field(item, "principal_cents"), false);
      const interest = cents(field(item, "interest_cents"));
      const penalty = cents(field(item, "penalty_cents"));
      const discount = cents(field(item, "discount_cents"));
      const fee = cents(field(item, "fee_cents"));
      if (principal > Number(title.amount_cents) - Number(title.settled_cents)) raise("40001", "erp_finance_overpayment");
      const net = principal + interest + penalty - discount + (kind === "payable" ? fee : -fee);
      if (net < 0 || net > 999999999999999 || discount > principal + interest + penalty) raise("22023", "erp_finance_invalid_net_cash");
      if (grouped) {
        if (borderoId === null) {
          borderoId = insertBordero(ctx, { kind, posted_on: postedOn, account_id: destination!, category_id: topCategory, note, grouped: true, actor: user, command_id: command });
          borderos.push(borderoId);
        }
      } else {
        borderoId = insertBordero(ctx, { kind, posted_on: postedOn, account_id: accountId!, category_id: category, note, actor: user, command_id: command });
        borderos.push(borderoId);
      }
      setFlag(ctx, "erp_finance.bordero_id", borderoId!);
      setFlag(ctx, "erp_finance.bordero_category", category ?? "");
      const settlement = insertSettlement(ctx, {
        title_id: id,
        account_id: accountId!,
        kind: "payment",
        posted_on: postedOn,
        principal_cents: principal,
        interest_cents: interest,
        penalty_cents: penalty,
        discount_cents: discount,
        fee_cents: fee,
        net_cash_cents: net,
        note,
        history,
        actor: user,
        command_id: command,
      });
      setFlag(ctx, "erp_finance.bordero_id", "");
      setFlag(ctx, "erp_finance.bordero_category", "");
      updateTitle(ctx, id, { settled_cents: Number(title.settled_cents) + principal, version: Number(title.version) + 1, updated_at: ctx.clock.next().toString() });
      postSettlementMovements(ctx, settlement, kind === "receivable" ? net : -net);
      updateAccount(ctx, accountId!, {});
      if (!grouped) borderoId = null;
      rows.push({
        title: dto(db, "titles", id),
        settlement: dto(db, "settlements", settlement),
        bordero_id: one(db, 'SELECT bordero_id FROM "erp_finance__bordero_item" WHERE settlement_id=?', settlement)?.bordero_id ?? null,
      });
    }
    result = {
      entity: "borderos",
      items: rows,
      borderos: [...borderos].sort(cmpText).map((b) => borderoDto(db, b, false)),
    };
  } else {
    keys(data, ["id", "expected_version", "posted_on", "note"]);
    const id = uuidValue(field(data, "id"))!;
    const bordero = one(db, 'SELECT * FROM "erp_finance__bordero" WHERE id=?', id);
    if (!bordero) raise("P0002", "erp_finance_not_found");
    if (bordero.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    if (bordero.deleted_at !== null || !borderoActive(db, id)) raise("40001", "erp_finance_bordero_inactive");
    const postedOn = day(field(data, "posted_on"), true);
    const note = txt(data, "note", 500, true);
    before = borderoDto(db, id, true);
    // Cada baixa ativa é estornada como no "Estornar baixa" do 010.
    const originals = db
      .exec(
        `SELECT s.* FROM "erp_finance__bordero_item" i JOIN "erp_finance__settlement" s ON s.id=i.settlement_id
          WHERE i.bordero_id=? AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id)`,
        id,
      )
      .rows.sort((x, y) => cmpText(String(x.title_id), String(y.title_id)) || cmpText(String(x.id), String(y.id)));
    for (const original of originals) {
      const title = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', original.title_id)!;
      if (bool(title.cancelled)) raise("40001", "erp_finance_cancelled_title");
      if (postedOn < String(original.posted_on)) raise("22023", "erp_finance_invalid_reversal_date");
      const accountId = String(original.account_id);
      const settlement = insertSettlement(ctx, {
        title_id: String(title.id),
        account_id: accountId,
        kind: "reversal",
        reverses_id: String(original.id),
        posted_on: postedOn,
        principal_cents: Number(original.principal_cents),
        interest_cents: Number(original.interest_cents),
        penalty_cents: Number(original.penalty_cents),
        discount_cents: Number(original.discount_cents),
        fee_cents: Number(original.fee_cents),
        net_cash_cents: Number(original.net_cash_cents),
        note,
        actor: user,
        command_id: command,
      });
      const fresh = one(db, 'SELECT settled_cents, version FROM "erp_finance__title" WHERE id=?', title.id)!;
      updateTitle(ctx, String(title.id), {
        settled_cents: Number(fresh.settled_cents) - Number(original.principal_cents),
        version: Number(fresh.version) + 1,
        updated_at: ctx.clock.next().toString(),
      });
      postSettlementMovements(ctx, settlement, title.kind === "receivable" ? -Number(original.net_cash_cents) : Number(original.net_cash_cents));
      updateAccount(ctx, accountId, {});
      rows.push({ title: dto(db, "titles", String(title.id)), settlement: dto(db, "settlements", settlement), bordero_id: id });
    }
    if (rows.length === 0) raise("40001", "erp_finance_bordero_inactive");
    deleteBordero(ctx, id, user, note);
    result = { entity: "borderos", items: rows, borderos: [borderoDto(db, id, false)], note };
  }

  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

export function erpFinanceBorderoGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const id = uuidArg(a.p_id);
  requireAccess(ctx.db, user, false);
  if (id === null) raise("22023", "erp_finance_invalid_query");
  const v = borderoDto(ctx.db, id, true);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { entity: "borderos", record: v, data_mode: "erp_native" };
}

function dateArg(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const bad = dateArgError(String(v));
  if (bad) raise(bad.code, bad.message);
  return String(v);
}

export function erpFinanceBorderoPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const account = uuidArg(a.p_account);
  const from = dateArg(a.p_from);
  const to = dateArg(a.p_to);
  const titleId = uuidArg(a.p_title);
  const kind = (a.p_kind as string | null) ?? null;
  const page = (a.p_page as number | null);
  const limit = (a.p_limit as number | null);
  const query = (a.p_query as string | null) ?? null;
  const categories = (a.p_categories as string[] | null) ?? null;
  const amount = (a.p_amount_cents as number | string | null) ?? null;
  const amountN = amount === null ? null : Number(amount);
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    kind === null || !["receivable", "payable"].includes(kind) ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (amountN !== null && (amountN < 1 || amountN > 999999999999999)) ||
    (from !== null && (from < "1900-01-01" || from > "2100-12-31")) ||
    (to !== null && (to < "1900-01-01" || to > "2100-12-31")) ||
    (from !== null && to !== null && from > to) ||
    (categories !== null &&
      (categories.length < 1 || categories.length > 50 || categories.includes(null as unknown as string) ||
        new Set(categories.map((c) => pgLower(c))).size !== categories.length ||
        categories.some((c) => c !== "none" && !UUID_I.test(c))))
  )
    raise("22023", "erp_finance_invalid_query");
  const none = categories !== null && categories.includes("none");
  const catIds = categories === null ? null : categories.filter((c) => c !== "none").map((c) => c.toLowerCase());
  const candidates = db
    .exec(`SELECT id, posted_on, account_id, category_id, note FROM "erp_finance__bordero" WHERE kind=? AND deleted_at IS NULL`, kind)
    .rows.filter((b) => {
      const id = String(b.id);
      if (!borderoActive(db, id)) return false;
      if (account !== null && b.account_id !== account) return false;
      if (from !== null && String(b.posted_on) < from) return false;
      if (to !== null && String(b.posted_on) > to) return false;
      if (catIds !== null) {
        const items = db.exec('SELECT category_id FROM "erp_finance__bordero_item" WHERE bordero_id=?', id).rows;
        if (!items.some((i) => {
          const c = (i.category_id ?? b.category_id) as string | null;
          return (none && c === null) || (c !== null && catIds.includes(c));
        }))
          return false;
      }
      if (titleId !== null && !one(db, 'SELECT 1 x FROM "erp_finance__bordero_item" i JOIN "erp_finance__settlement" s ON s.id=i.settlement_id WHERE i.bordero_id=? AND s.title_id=? LIMIT 1', id, titleId))
        return false;
      if (needle !== null) {
        const inNote = pgLower(String(b.note ?? "")).includes(needle);
        const inTitles = db
          .exec(
            `SELECT r.name, t.description, t.source_reference FROM "erp_finance__bordero_item" i JOIN "erp_finance__settlement" s ON s.id=i.settlement_id
               JOIN "erp_finance__title" t ON t.id=s.title_id JOIN "erp_catalog__record" r ON r.id=t.contact_id WHERE i.bordero_id=?`,
            id,
          )
          .rows.some((r) => pgLower([r.name, r.description, r.source_reference].filter((v) => v !== null).join(" ")).includes(needle));
        if (!inNote && !inTitles) return false;
      }
      return true;
    })
    .map((b) => ({ id: String(b.id), posted_on: String(b.posted_on), dto: borderoDto(db, String(b.id), false)! }))
    .filter((b) => amountN === null || Number((b.dto.totals as Record<string, string>).paid_cents) === amountN)
    .sort((x, y) => cmpText(y.posted_on, x.posted_on) || cmpText(y.id, x.id));
  const total = (k: string) => String(candidates.reduce((s, b) => s + Number((b.dto.totals as Record<string, string>)[k]), 0));
  return {
    entity: "borderos",
    kind,
    items: candidates.slice((page - 1) * limit, (page - 1) * limit + limit).map((b) => b.dto),
    page,
    limit,
    total: candidates.length,
    totals: {
      count: candidates.length,
      paid_cents: total("paid_cents"),
      penalty_cents: total("penalty_cents"),
      discount_cents: total("discount_cents"),
      interest_cents: total("interest_cents"),
      fee_cents: total("fee_cents"),
    },
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_bordero_execute", erpFinanceBorderoExecute);
registerRpc("erp_finance_bordero_get", erpFinanceBorderoGet);
registerRpc("erp_finance_bordero_page", erpFinanceBorderoPage);
