// Exportação completa da empresa (migração 331): public.erp_platform_export_request,
// _exports, _link, _plan, _complete, _expired e _removed; internas export_dto,
// exports_view, export_held e export_tables. O arquivo (ZIP) é montado fora
// da transação pela tarefa company_export (erp-api, platform.mjs) e guardado
// no R2; aqui ficam o pedido, o plano, a confirmação e a limpeza.
// O gatilho export_guard é cumprido aqui (só estes caminhos mudam a linha).
import { ERP_TABLES } from "../../../schema/columns.generated.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { rowJson, rowJsonSelect } from "../../../engine/row-json.ts";
import { pgLeft, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { accessRequireAdmin, readAdmin } from "../../access/public.ts";
import { compareText } from "../order.ts";
import { int, json, text, uuid } from "../args.ts";
import { MINUTE, enqueue, nowMicros, taskById, taskHeld } from "../platform.ts";

const DAY = 1440n * MINUTE;
const invalid = (): never => raise("22023", "erp_platform_export_input_invalid");
const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));

interface Export {
  id: string;
  command_id: string;
  requested_by: string;
  task_id: string;
  object_key: string | null;
  size_bytes: number | null;
  sha256: string | null;
  manifest: Record<string, unknown> | null;
  created_at: string;
  ready_at: string | null;
  expires_at: string | null;
  removed_at: string | null;
}
const COLUMNS = `id, command_id, requested_by, task_id, object_key, CAST(size_bytes AS TEXT) size_bytes, sha256, manifest,
  CAST(created_at AS TEXT) created_at, CAST(ready_at AS TEXT) ready_at, CAST(expires_at AS TEXT) expires_at, CAST(removed_at AS TEXT) removed_at`;
const toExport = (r: Record<string, unknown>): Export =>
  ({
    ...r,
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    manifest: r.manifest === null ? null : JSON.parse(String(r.manifest)),
  }) as Export;
const exportWhere = (db: SqlDriver, where: string, ...params: unknown[]) =>
  db.exec(`SELECT ${COLUMNS} FROM "erp_platform__export" ${where}`, ...params).rows.map(toExport);

/** erp_platform.export_dto(e) */
function exportDto(db: SqlDriver, e: Export) {
  const task = taskById(db, e.task_id);
  const now = nowMicros();
  const expired = e.removed_at !== null || (e.expires_at !== null && BigInt(e.expires_at) <= now);
  const profile = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', e.requested_by);
  return {
    id: e.id,
    created_at: ts(e.created_at),
    ready_at: ts(e.ready_at),
    expires_at: ts(e.expires_at),
    size_bytes: e.size_bytes,
    sha256: e.sha256,
    status: expired
      ? "expired"
      : e.ready_at !== null
        ? "ready"
        : task?.status === "failed"
          ? "failed"
          : task?.status === "running"
            ? "running"
            : task
              ? "queued"
              : null,
    error_code: task?.status === "failed" ? task.error_code : null,
    attempts: task?.attempts ?? null,
    summary: e.manifest && "summary" in e.manifest ? e.manifest.summary : null,
    requested_by_name: profile ? pgLeft(String(profile.name), 120) : null,
    links: Number(one(db, 'SELECT count(*) n FROM "erp_platform__export_link" WHERE export_id=?', e.id)!.n),
  };
}

/** erp_platform.exports_view() */
function exportsView(db: SqlDriver) {
  return {
    scope: "platform_exports",
    data_mode: "erp_native",
    retention_days: 7,
    link_seconds: 120,
    items: exportWhere(db, "ORDER BY created_at DESC, id LIMIT 20").map((e) => exportDto(db, e)),
  };
}

/** erp_platform.export_held(p_task, p_lease): a exportação da tarefa company_export em execução. */
function exportHeld(db: SqlDriver, task: string | null, lease: string | null): Export {
  const t = taskHeld(db, task, lease);
  if (t.purpose !== "company_export") raise("22023", "erp_platform_task_input_invalid");
  const e = exportWhere(db, "WHERE task_id=?", t.id)[0];
  if (!e) raise("P0002", "erp_platform_export_not_found");
  return e;
}

/**
 * erp_platform.export_tables(): as tabelas da empresa que vão no pacote
 * ("schema.tabela"), sem credenciais, segredos nem posses.
 */
export function exportTables() {
  const schemas = [
    "erp_catalog", "erp_documents", "erp_finance", "erp_stock", "erp_fiscal_invoices", "erp_fiscal_drafts", "erp_company", "erp_preferences",
    "erp_home", "erp_pos", "erp_pricing", "erp_purchase_receipts", "erp_attachments", "erp_activity", "erp_cnab", "erp_list_preferences", "erp_dfe",
  ];
  return Object.values(ERP_TABLES)
    .filter(
      (t) =>
        (schemas.includes(t.schema) || (t.schema === "origin_sync" && t.table === "raw_record")) &&
        !/(credential|secret|token|oauth|vault|custody|certificate|password|private|lease)/.test(t.table),
    )
    .map((t) => ({ name: `${t.schema}.${t.table}`, schema: t.schema, table: t.table }))
    .sort((a, b) => compareText(a.name, b.name));
}

export function erpPlatformExportRequest(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  if (command === null) invalid();
  const existing = exportWhere(db, "WHERE command_id=?", command)[0];
  if (existing) {
    if (existing.requested_by !== user) raise("40001", "erp_platform_export_command_conflict");
    return { export: exportDto(db, existing), replayed: true, view: exportsView(db), data_mode: "erp_native" };
  }
  if (
    one(
      db,
      `SELECT 1 x FROM "erp_platform__export" x JOIN "erp_platform__task" k ON k.id=x.task_id WHERE k.status IN ('queued','running')`,
    )
  )
    raise("55000", "erp_platform_export_in_progress");
  const id = crypto.randomUUID();
  const t = enqueue(ctx, "company_export", `exportacao:${command}`, user, { export_id: id }, 3);
  db.exec(
    'INSERT INTO "erp_platform__export"(id, command_id, requested_by, task_id, created_at) VALUES (?,?,?,?,?)',
    id,
    command,
    user,
    t.id,
    ctx.clock.next().toString(),
  );
  return { export: exportDto(db, exportWhere(db, "WHERE id=?", id)[0]), replayed: false, view: exportsView(db), data_mode: "erp_native" };
}

export function erpPlatformExports(ctx: RpcContext, a: RpcArgs) {
  readAdmin(ctx.db, uuid(a, "p_user_id"));
  return exportsView(ctx.db);
}

const linkFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** to_char(ready_at at time zone 'America/Sao_Paulo','YYYY-MM-DD-HH24MI') */
function stamp(micros: string) {
  const p = Object.fromEntries(linkFormat.formatToParts(new Date(Number(BigInt(micros) / 1000n))).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`;
}

export function erpPlatformExportLink(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_export_id");
  const db = ctx.db;
  accessRequireAdmin(db, user, true);
  const e = id === null ? undefined : exportWhere(db, "WHERE id=?", id)[0];
  if (!e) raise("P0002", "erp_platform_export_not_found");
  if (e.ready_at === null || e.removed_at !== null || BigInt(e.expires_at!) <= nowMicros()) raise("55000", "erp_platform_export_unavailable");
  db.exec('INSERT INTO "erp_platform__export_link"(export_id, actor, created_at) VALUES (?,?,?)', e.id, user, ctx.clock.next().toString());
  return {
    scope: "platform_export_link",
    data_mode: "erp_native",
    export_id: e.id,
    bucket: "brufap-exports",
    object_key: e.object_key,
    size_bytes: e.size_bytes,
    sha256: e.sha256,
    expires_in: 120,
    // Desvio exportacao-wabotia (schema/deviations.ts): o Fagoo usa 'brufap-exportacao-'.
    filename: `wabotia-exportacao-${stamp(e.ready_at)}.zip`,
  };
}

/** public.erp_platform_export_plan: as tabelas e os arquivos (do armazenamento, listados antes da transação). */
export function erpPlatformExportPlan(ctx: RpcContext, a: RpcArgs) {
  const e = exportHeld(ctx.db, uuid(a, "p_task"), uuid(a, "p_lease"));
  const files = ctx
    .listing()
    .filter((o) => o.bucket === "erp-attachments")
    .sort((x, y) => compareText(x.name, y.name))
    .map((o) => ({ key: o.name, size: o.size !== null && o.size !== undefined && /^[0-9]{1,9}$/.test(String(o.size)) ? Number(o.size) : null }));
  return {
    scope: "platform_export_plan",
    data_mode: "erp_native",
    export_id: e.id,
    as_of: jsonTimestamp(nowMicros().toString()),
    datasets: exportTables().map((t) => t.name),
    files,
    excluded: ["auth.users", "erp_access", "origin_sync.credentials", "certificado A1 (cofre)", "erp_platform"],
  };
}

export function erpPlatformExportComplete(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const e = exportHeld(db, uuid(a, "p_task"), uuid(a, "p_lease"));
  const sha = text(a, "p_sha256");
  const key = text(a, "p_object_key");
  const size = int(a, "p_size_bytes");
  const manifest = json(a, "p_manifest");
  if (
    sha === null ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    key !== `exports/${e.id}/${sha}.zip` ||
    size === null ||
    size < 22 ||
    size > 52428800 ||
    manifest === null ||
    jsonType(manifest) !== "object" ||
    pgLength(jsonbText(manifest)) > 16384
  )
    invalid();
  if (e.ready_at !== null) {
    if (e.object_key !== key) raise("40001", "erp_platform_export_command_conflict");
    return { export: exportDto(db, e), replayed: true, data_mode: "erp_native" };
  }
  const at = ctx.clock.next();
  db.exec(
    'UPDATE "erp_platform__export" SET object_key=?, size_bytes=?, sha256=?, manifest=?, ready_at=?, expires_at=? WHERE id=?',
    key,
    size,
    sha,
    jsonbText(manifest),
    at.toString(),
    (at + 7n * DAY).toString(),
    e.id,
  );
  return { export: exportDto(db, exportWhere(db, "WHERE id=?", e.id)[0]), replayed: false, data_mode: "erp_native" };
}

function cleanupHeld(db: SqlDriver, a: RpcArgs) {
  const t = taskHeld(db, uuid(a, "p_task"), uuid(a, "p_lease"));
  if (t.purpose !== "export_cleanup") raise("22023", "erp_platform_task_input_invalid");
  return t;
}

export function erpPlatformExportExpired(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  cleanupHeld(db, a);
  const items = exportWhere(
    db,
    "WHERE ready_at IS NOT NULL AND removed_at IS NULL AND expires_at<=? ORDER BY expires_at LIMIT 50",
    nowMicros().toString(),
  ).map((e) => ({ id: e.id, object_key: e.object_key }));
  return { scope: "platform_export_expired", data_mode: "erp_native", items };
}

export function erpPlatformExportRemoved(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  cleanupHeld(db, a);
  const id = uuid(a, "p_export_id");
  const e = id === null ? undefined : exportWhere(db, "WHERE id=?", id)[0];
  if (!e) raise("P0002", "erp_platform_export_not_found");
  if (e.ready_at === null || BigInt(e.expires_at!) > nowMicros()) raise("55000", "erp_platform_export_unavailable");
  if (e.removed_at === null) db.exec('UPDATE "erp_platform__export" SET removed_at=? WHERE id=?', ctx.clock.next().toString(), e.id);
  return { export: exportDto(db, exportWhere(db, "WHERE id=?", e.id)[0]), data_mode: "erp_native" };
}

/** Colunas da chave primária, na ordem (o DDL gerado mantém a ordem do Postgres). */
const primaryKey = (db: SqlDriver, table: string) =>
  db
    .exec("SELECT name, pk FROM pragma_table_info(?) WHERE pk>0", table)
    .rows.sort((x, y) => Number(x.pk) - Number(y.pk))
    .map((r) => String(r.name));

/**
 * public.erp_platform_export_chunk(p_task, p_lease, p_dataset, p_offset, p_limit):
 * uma fatia da tabela como to_jsonb(t), na ordem da chave primária, até
 * p_limit linhas ou ~700 kB de texto; renova a posse da tarefa.
 */
export function erpPlatformExportChunk(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const e = exportHeld(db, uuid(a, "p_task"), uuid(a, "p_lease"));
  const dataset = text(a, "p_dataset");
  const offset = int(a, "p_offset");
  const limit = int(a, "p_limit");
  if (offset === null || offset < 0 || limit === null || limit < 1 || limit > 1000) invalid();
  const found = exportTables().find((t) => t.name === dataset);
  if (!found) raise("22023", "erp_platform_export_dataset_invalid");
  const table = `${found.schema}__${found.table}`;
  const pk = primaryKey(db, table);
  const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
  let rows: Record<string, unknown>[];
  if (pk.length)
    rows = db
      .exec(`SELECT ${rowJsonSelect(table)} FROM ${q(table)} ORDER BY ${pk.map(q).join(", ")} LIMIT ? OFFSET ?`, limit! + 1, offset)
      .rows.map((r) => rowJson(table, r));
  else
    // Sem chave primária: a ordem do texto do to_jsonb(t) (collation C).
    rows = db
      .exec(`SELECT ${rowJsonSelect(table)} FROM ${q(table)}`)
      .rows.map((r) => rowJson(table, r))
      .sort((x, y) => compareText(jsonbText(x), jsonbText(y)))
      .slice(offset!, offset! + limit! + 1);
  const out: unknown[] = [];
  let bytes = 0;
  let more = false;
  for (const r of rows) {
    const size = pgLength(jsonbText(r));
    if (out.length === limit || (out.length > 0 && bytes + size > 700000)) {
      more = true;
      break;
    }
    out.push(r);
    bytes += size;
  }
  db.exec('UPDATE "erp_platform__task" SET lease_until=? WHERE id=?', (ctx.clock.next() + 5n * MINUTE).toString(), e.task_id);
  return {
    scope: "platform_export_chunk",
    data_mode: "erp_native",
    dataset,
    offset,
    rows: out,
    next_offset: more ? offset! + out.length : null,
  };
}

registerRpc("erp_platform_export_chunk", erpPlatformExportChunk);
// Cria a tarefa company_export: o agendador acorda em 1 s (docs/ERP-AGENDADOR.md).
registerRpc("erp_platform_export_request", erpPlatformExportRequest, { wake: true });
registerRpc("erp_platform_exports", erpPlatformExports);
registerRpc("erp_platform_export_link", erpPlatformExportLink);
registerRpc("erp_platform_export_plan", erpPlatformExportPlan, { listing: true });
registerRpc("erp_platform_export_complete", erpPlatformExportComplete);
registerRpc("erp_platform_export_expired", erpPlatformExportExpired);
registerRpc("erp_platform_export_removed", erpPlatformExportRemoved);
