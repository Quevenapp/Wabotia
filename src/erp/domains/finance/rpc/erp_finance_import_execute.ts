// Importação de registros financeiros (SQL 138): public.erp_finance_import_execute
// (records_import) e public.erp_finance_import_preview (records_import_preview),
// com erp_finance.import_rows_check e erp_finance.import_resolve.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { intIn } from "../../../engine/args.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  field,
  flushDeferred,
  hasKey,
  insertAudit,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  sha256,
  txt,
  updateAccount,
  uuidArg,
} from "../internal.ts";
import { cashAccount, cashPost, insertCashEntry } from "../cash.ts";
import { insertTitle } from "../titles.ts";

const ROW_KEYS = ["line", "issued_on", "due_on", "competence_on", "amount_cents", "side", "description", "contact_name", "contact_document", "category", "account", "document"];
/** p_row->>k: string crua; outro valor JSON pelo texto do jsonb; null se falta ou é null */
const textOf = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));
/** p_row->k como jsonb (a chave ausente vira null no jsonb_build_object) */
const jsonOf = (v: unknown) => (v === undefined ? null : v);
const nullIfBlank = (v: string | null) => (v === null || btrim(v) === "" ? null : v);
const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/** erp_finance.import_rows_check */
function importRowsCheck(data: unknown) {
  keys(data, ["kind", "file_name", "rows"]);
  const kind = txt(data, "kind", 20, true)!;
  if (!["receivable", "payable", "cash"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
  const rows = field(data, "rows");
  if (CNTRL.test(txt(data, "file_name", 200, true)!) || jsonType(rows) !== "array" || (rows as unknown[]).length < 1 || (rows as unknown[]).length > 1000)
    raise("22023", "erp_finance_invalid_items");
  return kind;
}

/** min(x::text)::uuid de uma lista de ids */
const minId = (ids: string[]) => (ids.length ? [...ids].sort(cmpText)[0] : null);

/** erp_finance.import_resolve: erros por linha, o hash canônico e o que a linha resolve. */
function importResolve(db: SqlDriver, kind: string, row: unknown) {
  if (jsonType(row) !== "object" || Object.keys(row as object).some((k) => !ROW_KEYS.includes(k))) raise("22023", "erp_finance_invalid_items");
  const errors: string[] = [];
  const issued = attempt(() => day(field(row, "issued_on"))) ?? null;
  if (issued === null) errors.push("data");
  let due: string | null = null;
  if (kind !== "cash") {
    due = attempt(() => day(field(row, "due_on"))) ?? null;
    if (due === null) errors.push("vencimento");
  }
  let competence: string | null = issued;
  const competenceValue = hasKey(row, "competence_on") && field(row, "competence_on") !== null;
  if (competenceValue) {
    const c = attempt(() => day(field(row, "competence_on")));
    if (c === undefined) {
      errors.push("competencia");
      competence = null;
    } else competence = c;
  }
  const amount = attempt(() => cents(field(row, "amount_cents"), false)) ?? null;
  if (amount === null) errors.push("valor");
  let side: string | null = null;
  if (kind === "cash") {
    side = textOf(field(row, "side"));
    if (side === null || !["in", "out"].includes(side)) errors.push("tipo");
  }
  if (due !== null && issued !== null && due < issued) errors.push("vencimento");
  const description = textOf(field(row, "description"));
  if (nullIfBlank(description) === null || charLength(description!) > (kind === "cash" ? 2000 : 240) || CNTRL.test(description!)) errors.push("historico");
  const doc = (textOf(field(row, "contact_document")) ?? "").replace(/[^0-9]/g, "") || null;
  const contactName = textOf(field(row, "contact_name"));
  let contact: string | null = null;
  let count: number;
  if (doc !== null) {
    const ids = db
      .exec('SELECT c.record_id, c.document FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE r.active=1')
      .rows.filter((c) => String(c.document ?? "").replace(/[^0-9]/g, "") === doc)
      .map((c) => String(c.record_id));
    count = ids.length;
    contact = minId(ids);
  } else if (nullIfBlank(contactName) !== null) {
    const name = pgLower(btrim(contactName!));
    const ids = db
      .exec('SELECT c.record_id, r.name FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE r.active=1')
      .rows.filter((c) => pgLower(String(c.name)) === name)
      .map((c) => String(c.record_id));
    count = ids.length;
    contact = minId(ids);
  } else {
    count = kind === "cash" ? 1 : 0;
    contact = null;
  }
  if (count !== 1) {
    errors.push("contato");
    contact = null;
  }
  const categoryKind = kind === "cash" ? (side === "in" ? "receivable" : "payable") : kind;
  const categoryText = textOf(field(row, "category"));
  let category: string | null = null;
  if (nullIfBlank(categoryText) !== null) {
    const name = pgLower(btrim(categoryText!));
    const ids = db
      .exec('SELECT id, name FROM "erp_finance__category" WHERE kind=? AND active=1 AND deleted_at IS NULL', categoryKind)
      .rows.filter((c) => pgLower(String(c.name)) === name)
      .map((c) => String(c.id));
    category = minId(ids);
    if (ids.length !== 1) errors.push("categoria");
  }
  const accountText = textOf(field(row, "account"));
  let account: string | null = null;
  if (nullIfBlank(accountText) !== null) {
    const name = pgLower(btrim(accountText!));
    const ids = db
      .exec('SELECT id, name FROM "erp_finance__account" WHERE active=1 AND deleted_at IS NULL')
      .rows.filter((c) => pgLower(String(c.name)) === name)
      .map((c) => String(c.id));
    account = minId(ids);
    if (ids.length !== 1) errors.push("conta");
  } else if (kind === "cash") errors.push("conta");
  const document = textOf(field(row, "document"));
  if (document !== null && charLength(document) > 200) errors.push("documento");
  const canonical = {
    kind,
    issued_on: jsonOf(field(row, "issued_on")),
    due_on: jsonOf(field(row, "due_on")),
    competence_on: jsonOf(field(row, "competence_on")),
    amount_cents: jsonOf(field(row, "amount_cents")),
    side: jsonOf(field(row, "side")),
    description: btrim(description ?? ""),
    contact: doc ?? pgLower(btrim(contactName ?? "")),
    category: pgLower(btrim(categoryText ?? "")),
    account: pgLower(btrim(accountText ?? "")),
    document: btrim(document ?? ""),
  };
  return {
    line: jsonOf(field(row, "line")),
    errors,
    hash: sha256(jsonbText(canonical)),
    contact_id: contact,
    category_id: category,
    account_id: account,
    issued_on: issued,
    due_on: due,
    competence_on: competence,
    amount_cents: amount === null ? null : String(amount),
    side,
    description,
    document,
  };
}

export function erpFinanceImportExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  if (command === null || data === null || jsonType(data) !== "object" || jsonBytes(data) > 1048576) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, "records_import", data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;
  const kind = importRowsCheck(data);
  const fileName = textOf(field(data, "file_name"));
  let created = 0;
  let skipped = 0;
  for (const row of field(data, "rows") as unknown[]) {
    const r = importResolve(db, kind, row);
    if (r.errors.length > 0) raise("22023", "erp_finance_import_invalid_row");
    if (one(db, 'SELECT 1 x FROM "erp_finance__import_row" WHERE row_hash=?', r.hash)) {
      skipped++;
      continue;
    }
    const lineText = textOf(field(row, "line"));
    const description = btrim(r.description ?? "");
    if (kind === "cash") {
      const account = cashAccount(db, r.account_id!);
      const entry = insertCashEntry(ctx, {
        account_id: account.id, kind: r.side, amount_cents: Number(r.amount_cents), posted_on: r.issued_on, competence_on: r.competence_on,
        contact_id: r.contact_id, note: description, origin: "import", actor: user, command_id: command,
      });
      cashPost(ctx, entry, r.category_id, user, command);
      updateAccount(ctx, String(account.id), {});
      insertImportRow(ctx, { row_hash: r.hash, import_kind: kind, entry_id: entry.id, file_name: fileName, line: lineText === null ? 0 : Number(intIn(lineText, "integer")), actor: user, command_id: command });
    } else {
      const reference = btrim(r.document ?? "");
      const id = insertTitle(ctx, {
        group_id: crypto.randomUUID(), installment: 1, installments: 1, kind, contact_id: r.contact_id, category_id: r.category_id, description,
        source_reference: reference === "" ? null : reference, issued_on: r.issued_on, due_on: r.due_on, amount_cents: Number(r.amount_cents),
        competence_on: r.competence_on, account_id: r.account_id,
      });
      insertImportRow(ctx, { row_hash: r.hash, import_kind: kind, title_id: id, file_name: fileName, line: lineText === null ? 0 : Number(intIn(lineText, "integer")), actor: user, command_id: command });
    }
    created++;
  }
  requireAccess(db, user, true);
  const result = { entity: "financial_import", kind, created, skipped, action: "records_import", data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, "records_import", null, result);
  flushDeferred(ctx);
  return result;
}

function insertImportRow(ctx: RpcContext, r: Record<string, unknown>) {
  ctx.db.exec(
    'INSERT INTO "erp_finance__import_row"(row_hash, import_kind, title_id, entry_id, file_name, line, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    r.row_hash, r.import_kind, r.title_id ?? null, r.entry_id ?? null, r.file_name, r.line, r.actor, r.command_id, ctx.clock.next().toString(),
  );
}

export function erpFinanceImportPreview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  const kind = importRowsCheck(data);
  const resolved = (field(data, "rows") as unknown[]).map((row) => importResolve(db, kind, row));
  const seen = new Map<string, number>();
  const rows = resolved.map((r) => {
    let status: string;
    if (r.errors.length > 0) status = "error";
    else {
      const repeat = (seen.get(r.hash) ?? 0) + 1;
      seen.set(r.hash, repeat);
      status = repeat > 1 || one(db, 'SELECT 1 x FROM "erp_finance__import_row" WHERE row_hash=?', r.hash) ? "duplicate" : "new";
    }
    return { line: r.line, errors: r.errors, status };
  });
  return { entity: "financial_import", kind, rows, data_mode: "erp_native" };
}

registerRpc("erp_finance_import_execute", erpFinanceImportExecute);
registerRpc("erp_finance_import_preview", erpFinanceImportPreview);
