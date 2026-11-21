// Importações por planilha: definição final da migração 300 (228/265/283).
// Cada linha tem uma subtransação, inclusive na prévia. O lote e seu recibo
// pertencem à transação externa; outro lote retoma o mesmo job pelas linhas.
import { createHash, randomUUID } from "node:crypto";
import { intIn } from "../../../engine/args.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { fromSqlite, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLeft, pgLength, PG_CNTRL } from "../../../engine/text.ts";
import { bool, int, json, text, uuid } from "../args.ts";
import { importItem, type ImportItemResult } from "../import-items.ts";
import { IMPORT_JOB_KIND_SQL, importJobDto } from "./erp_preferences_reads.ts";

const KINDS = ["products", "contacts", "purchase_orders", "stock_movements", "receivables", "payables", "sales_orders", "nfe", "compositions", "custom_fields", "product_suppliers", "lots",
  "product_taxes", "natures", "opening_balances"];
// Versão 28: o CHECK de kind de import_job não aceita os tipos novos; o lote fica com um tipo de apoio e o
// tipo real em import_job_kind (as leituras usam o real). A validação desses tipos devolve a prévia em reference.
const CARRIER: Record<string, string> = { product_taxes: "products", natures: "nfe", opening_balances: "receivables" };
const LINE_ERRORS = new Set(["P0001", "22023", "22P02", "22003", "22007", "22008", "22001", "23505", "23503", "23502", "23514", "P0002", "40001"]);
const DRY_RUN = Symbol("erp_preferences_import_dry_run");
const invalid = (): never => raise("22023", "erp_preferences_import_invalid");
interface SheetRow { row: number; lines?: unknown[]; data?: Record<string, unknown> }

export function importRequireAdmin(db: SqlDriver, user: string | null) {
  if (user === null || !one(db, 'SELECT 1 ok FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role=\'admin\'', user))
    raise("42501", "erp_preferences_import_denied");
}

/** md5('erp-import-item:' || command || ':' || row)::uuid, como no original. */
export function importItemCommand(command: string, row: number): string {
  const h = createHash("md5").update(`erp-import-item:${command}:${row}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function importReason(message: string, state: string): string {
  if (/^erp_[a-z0-9_]{1,80}(:[a-z0-9_]{1,40})?$/.test(message)) return message;
  return state === "23505" ? "erp_preferences_import_duplicate"
    : state === "40001" ? "erp_preferences_import_conflict"
    : state === "P0002" ? "erp_preferences_import_not_found" : "erp_preferences_import_refused";
}

export function importField(reason: string): string | null {
  if (reason.includes(":")) return /^[a-z_]{1,40}$/.test(reason.split(":")[1]) ? reason.split(":")[1] : null;
  return reason === "erp_catalog_name_required" ? "name" : null;
}

function rowValid(value: unknown): value is SheetRow {
  if (jsonType(value) !== "object") return false;
  const row = value as SheetRow;
  // Na expressão WHERE original, uma chave ausente produz SQL NULL e não
  // torna a linha inválida. JSON null tem tipo 'null' e é recusado. O número
  // continua obrigatório pelo count(distinct row) da validação do lote.
  return Object.keys(row).length === 3 && typeof row.row === "number" && /^[1-9][0-9]{0,4}$/.test(String(row.row)) && row.row >= 2 && row.row <= 10001
    && (row.lines === undefined || Array.isArray(row.lines) && row.lines.length >= 1 && row.lines.length <= 250 && row.lines[0] === row.row)
    && (row.data === undefined || jsonType(row.data) === "object");
}

/** Restaura também o estado transacional que vive em TS, além do savepoint SQL. */
function lineTransaction(ctx: RpcContext, dry: boolean, run: () => ImportItemResult): ImportItemResult {
  const settings = new Map(ctx.settings);
  const deferred = ctx.deferred.length;
  let out: ImportItemResult | undefined;
  try {
    ctx.db.transaction(() => {
      out = run();
      if (dry) throw DRY_RUN;
    });
  } catch (error) {
    const deferredFks = ctx.settings.has("__engine.fk_deferred") && !settings.has("__engine.fk_deferred");
    ctx.settings.clear();
    for (const [key, value] of settings) ctx.settings.set(key, value);
    ctx.deferred.length = deferred;
    if (deferredFks) ctx.db.exec("PRAGMA defer_foreign_keys = OFF");
    // As sequências NÃO voltam: nextval também é consumido pela prévia no PG.
    if (error !== DRY_RUN) throw error;
  }
  return out!;
}

export function erpPreferencesImportBatch(ctx: RpcContext, args: RpcArgs) {
  const user = uuid(args, "p_user_id"), command = uuid(args, "p_command_id"), job = uuid(args, "p_job_id");
  const kind = text(args, "p_kind"), file = text(args, "p_file_name"), total = int(args, "p_total_rows"), dry = bool(args, "p_dry_run");
  const input = json(args, "p_rows");
  const seed = command ?? randomUUID();
  const db = ctx.db;
  importRequireAdmin(db, user);
  if (kind === null || !KINDS.includes(kind) || dry === null || (!dry && (command === null || job === null))
    || file === null || pgLength(file) < 1 || pgLength(file) > 200 || pgHasCntrl.test(file) || pgBtrim(file) !== file
    || total === null || total < 1 || total > 10000 || !Array.isArray(input) || input.length < 1 || input.length > 50
    || new TextEncoder().encode(jsonbText(input)).length > 262144 || !input.every(rowValid)
    || new Set(input.map(row => row.row)).size !== input.length) invalid();
  const rows = input as SheetRow[];
  let hash: string | null = null;
  let savedJob: Record<string, unknown> | null = null;
  if (!dry) {
    hash = createHash("sha256").update(jsonbText({ profile: "erp-import-v1", actor: user, kind, job, file, total, items: rows }), "utf8").digest("hex");
    const receipt = one(db, 'SELECT actor, job_id, request_hash, result FROM "erp_preferences__import_command" WHERE command_id=?', command);
    if (receipt) {
      if (receipt.actor !== user || receipt.request_hash !== hash) raise("40001", "erp_preferences_import_command_conflict");
      return { ...JSON.parse(String(receipt.result)), replayed: true, job: importJobDto(db, String(receipt.job_id)) };
    }
    savedJob = one(db, `SELECT actor, ${IMPORT_JOB_KIND_SQL} kind, file_name, total_rows, rows_done, status FROM "erp_preferences__import_job" WHERE id=?`, job);
    if (!savedJob) {
      db.exec('INSERT INTO "erp_preferences__import_job"(id, kind, actor, file_name, total_rows, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
        job, CARRIER[kind!] ?? kind, user, file, total, ctx.clock.next().toString(), ctx.clock.next().toString());
      if (CARRIER[kind!]) db.exec('INSERT INTO "erp_preferences__import_job_kind"(job_id, kind, created_at) VALUES(?,?,?)', job, kind, ctx.clock.next().toString());
      savedJob = { rows_done: 0 };
    } else if (savedJob.actor !== user) raise("42501", "erp_preferences_import_job_denied");
    else if (savedJob.kind !== kind || savedJob.file_name !== file || savedJob.total_rows !== total) raise("22023", "erp_preferences_import_job_mismatch");
    else if (savedJob.status === "concluida") raise("40001", "erp_preferences_import_job_finished");
  }
  const items: Record<string, unknown>[] = [];
  let count = 0, created = 0, updated = 0, unchanged = 0, invalidCount = 0;
  for (const item of [...rows].sort((a, b) => a.row - b.row)) {
    if (!dry) {
      const done = one(db, 'SELECT row, status, action, reason, field, record_id, reference FROM "erp_preferences__import_row" WHERE job_id=? AND row=?', job, item.row);
      if (done) { items.push({ ...done }); continue; }
    }
    let out: ImportItemResult | null = null, reason: string | null = null;
    try {
      out = lineTransaction(ctx, dry!, () => importItem(ctx, user!, kind!, importItemCommand(seed, item.row), file!, item.data, dry!));
    } catch (error) {
      const e = fromSqlite(error);
      if (!LINE_ERRORS.has(e.code)) throw e;
      reason = importReason(e.message, e.code);
    }
    const status = reason !== null ? "invalid" : dry ? "valid" : out?.action === "create" ? "created" : out?.unchanged ? "unchanged" : "updated";
    const entry = {
      row: item.row, status, action: reason === null ? out?.action ?? null : null, reason,
      field: reason === null ? null : importField(reason),
      record_id: ["created", "updated", "unchanged"].includes(status) ? out?.record_id ?? null : null,
      reference: reason === null && (!dry || Boolean(CARRIER[kind!])) && out?.reference != null ? pgLeft(out.reference.replace(new RegExp(PG_CNTRL, "gu"), " "), 120) || null : null,
    };
    items.push(entry);
    if (!dry) {
      // Cast da lista ocorre fora da subtransação da linha, como no INSERT PG.
      const lines = (item.lines ?? []).map(value => {
        if (value === null) return null;
        const text = typeof value === "string" ? value : jsonbText(value);
        return intIn(text, "integer") as number;
      });
      // CHECK cardinality(lines) BETWEEN 1 AND 250 AND lines[1]=row:
      // o DDL não traduz esta expressão de vetor; chave ausente vira {} no PG.
      if (lines.length === 0) raise("23514", 'new row for relation "import_row" violates check constraint "import_row_check"');
      db.exec('INSERT INTO "erp_preferences__import_row"(job_id,row,lines,command_id,status,action,reason,field,record_id,reference,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        job, item.row, JSON.stringify(lines), command, status, entry.action, reason, entry.field, entry.record_id, entry.reference, ctx.clock.next().toString());
      count++;
      if (status === "created") created++;
      else if (status === "updated") updated++;
      else if (status === "unchanged") unchanged++;
      else invalidCount++;
    }
  }
  importRequireAdmin(db, user);
  if (!dry) {
    const done = Number(savedJob!.rows_done) + count;
    if (done > total!) raise("22023", "erp_preferences_import_total_exceeded");
    db.exec(`UPDATE "erp_preferences__import_job" SET rows_done=rows_done+?,created=created+?,updated=updated+?,unchanged=unchanged+?,invalid=invalid+?,
      status=CASE WHEN ?=total_rows THEN 'concluida' ELSE status END,finished_at=?,updated_at=? WHERE id=?`,
      count, created, updated, unchanged, invalidCount, done, done === total ? ctx.clock.next().toString() : null, ctx.clock.next().toString(), job);
  }
  const result = { scope: "import_batch", data_mode: "erp_native", kind, dry_run: dry, replayed: false, job: dry ? null : importJobDto(db, job!), items };
  if (!dry) {
    const { job: _job, ...receipt } = result;
    db.exec('INSERT INTO "erp_preferences__import_command"(command_id,actor,job_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?)',
      command, user, job, hash, JSON.stringify(receipt), ctx.clock.next().toString());
  }
  return result;
}

registerRpc("erp_preferences_import_batch", erpPreferencesImportBatch);
