// Leituras avulsas do domínio 11: public.erp_preferences_import_job e
// _import_jobs (acompanhamento da importação de planilhas), erp_history_backups
// e erp_read_records (cópias e espelho do Origin: as tabelas existem e ficam
// vazias com o Origin fora), erp_files_list_v2 (Arquivos: tudo o que foi
// anexado) e erp_wabotia_state (o pareamento com o Wabotia, como no Fagoo).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { activityRequireAdmin, actorLabel, clean, period, requireHistoryRole, resourcesForRole, scalarText } from "../../access/public.ts";
import { bool, date, int, text, uuid } from "../args.ts";
import { nowMicros } from "../platform.ts";
import { compareText } from "../order.ts";

const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));

/** Membro ativo administrador? null quando não é membro ativo. */
function importAdmin(db: SqlDriver, user: string | null): boolean {
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r) raise("42501", "erp_preferences_import_denied");
  return r.role === "admin";
}

/** erp_preferences.import_job_dto */
function importJobDto(db: SqlDriver, id: string) {
  const j = one(
    db,
    `SELECT id, kind, file_name, total_rows, rows_done, created, updated, unchanged, invalid, status, actor,
     CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at, CAST(finished_at AS TEXT) finished_at
     FROM "erp_preferences__import_job" WHERE id=?`,
    id,
  )!;
  return {
    id: j.id,
    kind: j.kind,
    file_name: j.file_name,
    total_rows: Number(j.total_rows),
    rows_done: Number(j.rows_done),
    created: Number(j.created),
    updated: Number(j.updated),
    unchanged: Number(j.unchanged),
    invalid: Number(j.invalid),
    status: j.status,
    actor: { user_id: j.actor, label: actorLabel(db, String(j.actor)) },
    created_at: ts(j.created_at),
    updated_at: ts(j.updated_at),
    finished_at: ts(j.finished_at),
  };
}

export function erpPreferencesImportJob(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const job = uuid(a, "p_job_id");
  const errors = bool(a, "p_errors");
  const limit = int(a, "p_limit");
  const offset = int(a, "p_offset");
  const db = ctx.db;
  const admin = importAdmin(db, user);
  if (job === null || errors === null || limit === null || limit < 1 || limit > 200 || offset === null || offset < 0 || offset > 10000)
    raise("22023", "erp_preferences_import_invalid");
  if (!one(db, 'SELECT 1 x FROM "erp_preferences__import_job" WHERE id=? AND (? OR actor=?)', job, admin ? 1 : 0, user))
    raise("P0002", "erp_preferences_import_job_not_found");
  const where = `job_id=? ${errors ? "AND status='invalid'" : ""}`;
  const total = Number(one(db, `SELECT count(*) n FROM "erp_preferences__import_row" WHERE ${where}`, job)!.n);
  const items = db
    .exec(`SELECT row, status, action, reason, field, record_id, reference FROM "erp_preferences__import_row" WHERE ${where} ORDER BY row LIMIT ? OFFSET ?`, job, limit, offset)
    .rows.map((r) => ({ row: Number(r.row), status: r.status, action: r.action, reason: r.reason, field: r.field, record_id: r.record_id, reference: r.reference }));
  return {
    scope: "import_job",
    data_mode: "erp_native",
    job: importJobDto(db, job!),
    errors,
    limit,
    offset,
    total,
    has_more: offset! + items.length < total,
    items,
  };
}

export function erpPreferencesImportJobs(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const status = text(a, "p_status");
  const limit = int(a, "p_limit");
  const offset = int(a, "p_offset");
  const db = ctx.db;
  const admin = importAdmin(db, user);
  if (
    (status !== null && !["em_andamento", "concluida"].includes(status)) ||
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    offset === null ||
    offset < 0 ||
    offset > 100000
  )
    raise("22023", "erp_preferences_import_invalid");
  const where = "(? OR actor=?) AND (? IS NULL OR status=?)";
  const args = [admin ? 1 : 0, user, status, status];
  const total = Number(one(db, `SELECT count(*) n FROM "erp_preferences__import_job" WHERE ${where}`, ...args)!.n);
  const ids = db
    .exec(`SELECT id, created_at FROM "erp_preferences__import_job" WHERE ${where}`, ...args)
    .rows.sort((x, y) => Number(BigInt(y.created_at as number) - BigInt(x.created_at as number)) || compareText(String(x.id), String(y.id)))
    .slice(offset!, offset! + limit!);
  const items = ids.map((r) => importJobDto(db, String(r.id)));
  return {
    scope: "import_jobs",
    data_mode: "erp_native",
    status,
    limit,
    offset,
    total,
    has_more: offset! + items.length < total,
    all_users: admin,
    items,
  };
}

/** (texto)::integer do Postgres: aparado, com sinal; o resto recusa como o cast. */
function intCast(v: string | null): number | null {
  if (v === null) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(v)) raise("22P02", `invalid input syntax for type integer: "${v}"`);
  const n = Number(v.trim());
  if (n > 2147483647 || n < -2147483648) raise("22003", `value "${v}" is out of range for type integer`);
  return n;
}
const pathText = (o: unknown, ...keys: string[]): string | null => {
  let v: unknown = o;
  for (const k of keys) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Record<string, unknown>)[k];
  }
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
};

export function erpHistoryBackups(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireHistoryRole(db, uuid(a, "p_user_id"));
  const items = db
    .exec(`SELECT backup_sha, manifest, status, CAST(created_at AS TEXT) created_at, CAST(finished_at AS TEXT) finished_at FROM "origin_backup__batch"`)
    .rows.sort((x, y) => {
      const d = BigInt(String(y.created_at)) - BigInt(String(x.created_at));
      return d < 0n ? -1 : d > 0n ? 1 : compareText(String(x.backup_sha), String(y.backup_sha));
    })
    .slice(0, 100)
    .map((b) => {
      const m = JSON.parse(String(b.manifest));
      return {
        id: b.backup_sha,
        status: b.status,
        created_at: ts(b.created_at),
        finished_at: ts(b.finished_at),
        xml_occurrences: intCast(pathText(m, "counts", "xml")) ?? 0,
        issues: intCast(pathText(m, "counts", "issue")) ?? 0,
        available: ["stored", "stored_with_issues"].includes(String(b.status)),
      };
    });
  return { items, data_mode: "backup_readonly" };
}

const get = (o: unknown, key: string) => (o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[key] : undefined);
const st = (v: unknown, max = 200) => (v === undefined ? null : scalarText(v, max));
const leftText = (v: string | null, n: number) => (v === null ? null : [...v].slice(0, n).join(""));

/** erp_access.record_summary */
function recordSummary(entity: string, id: string, payload: unknown, contact: unknown, seenAt: string) {
  const people = ["contacts", "products"].includes(entity);
  const money = ["receivables", "payables"].includes(entity);
  const amount =
    entity === "products"
      ? get(payload, "preco")
      : money
        ? get(payload, "valor")
        : ["nfe", "nfce"].includes(entity)
          ? get(payload, "valorNota")
          : ["sales_orders", "purchase_orders", "sales_proposals"].includes(entity)
            ? get(payload, "total")
            : undefined;
  return {
    id,
    entity,
    name: people ? st(get(payload, "nome")) : null,
    code: people ? st(get(payload, "codigo")) : null,
    number: st(get(payload, "numero")),
    date: leftText(st(get(payload, [...["receivables", "payables", "nfe", "nfce"]].includes(entity) ? "dataEmissao" : "data")), 10),
    due_date: money ? leftText(st(get(payload, "vencimento")), 10) : null,
    status: st(get(get(payload, "situacao"), "id")) ?? st(get(payload, "situacao")),
    amount: st(amount),
    balance: money ? st(get(payload, "saldo")) : null,
    counterparty_id: entity === "purchase_orders" ? st(get(get(payload, "fornecedor"), "id")) : !people ? st(get(get(payload, "contato"), "id")) : null,
    counterparty_name: !people ? (st(get(get(payload, "contato"), "nome")) ?? st(get(contact, "nome"))) : null,
    model: entity === "nfe" ? "55" : entity === "nfce" ? "65" : null,
    series: ["nfe", "nfce"].includes(entity) ? st(get(payload, "serie")) : null,
    direction: entity === "nfe" ? st(get(payload, "tipo")) : null,
    last_seen_at: jsonTimestamp(seenAt),
  };
}

const finiteDate = (d: string | null) => d === null || (!/infinity/.test(d) && d >= "1900-01-01" && d <= "2100-12-31");

export function erpReadRecords(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const entity = text(a, "p_entity");
  const limit = int(a, "p_limit");
  const offset = int(a, "p_offset");
  const query = text(a, "p_query");
  const status = text(a, "p_status");
  const from = date(a, "p_from");
  const to = date(a, "p_to");
  const db = ctx.db;
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r || entity === null || !resourcesForRole(String(r.role)).includes(entity)) raise("42501", "erp_access_denied");
  if (
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    offset === null ||
    offset < 0 ||
    offset > 100000 ||
    (query !== null && pgLength(query) > 120) ||
    (status !== null && pgLength(status) > 80) ||
    !finiteDate(from) ||
    !finiteDate(to) ||
    (from !== null && to !== null && from > to)
  )
    raise("22023", "erp_invalid_query");
  const contacts = new Map(
    db.exec(`SELECT source_id, payload FROM "origin_sync__raw_record" WHERE entity='contacts'`).rows.map((c) => [String(c.source_id), JSON.parse(String(c.payload))]),
  );
  const q = query === null ? "" : pgBtrim(query);
  const all = db
    .exec(`SELECT source_id, payload, CAST(last_seen_at AS TEXT) last_seen_at FROM "origin_sync__raw_record" WHERE entity=?`, entity)
    .rows.map((row) => {
      const payload = JSON.parse(String(row.payload));
      const link =
        entity === "purchase_orders"
          ? st(get(get(payload, "fornecedor"), "id"))
          : !["contacts", "products"].includes(entity!)
            ? st(get(get(payload, "contato"), "id"))
            : null;
      const contact = link === null ? null : (contacts.get(link) ?? null);
      return { source_id: String(row.source_id), item: recordSummary(entity!, String(row.source_id), payload, contact, String(row.last_seen_at)) };
    })
    .filter(({ item }) => {
      if (q !== "") {
        const hay = [item.name, item.code, item.number, item.counterparty_name].filter((x) => x !== null).join(" ");
        if (!pgLower(hay).includes(pgLower(q))) return false;
      }
      if (status !== null && status !== "" && item.status !== status) return false;
      if (from !== null && !(item.date !== null && item.date >= from)) return false;
      if (to !== null && !(item.date !== null && item.date <= to)) return false;
      return true;
    })
    .sort((x, y) => compareText(x.source_id, y.source_id));
  const total = all.length;
  return {
    entity,
    items: all.slice(offset!, offset! + limit!).map((x) => x.item),
    limit,
    offset,
    total,
    has_more: total > offset! + limit!,
    next_offset: total > offset! + limit! ? offset! + limit! : null,
    data_mode: "staging_readonly",
  };
}

interface FileRow {
  id: string;
  origin: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  actor: string;
  at_time: bigint;
  source_kind: string;
  source_id: string;
  source_code: string | null;
  source_label: string | null;
}

export function erpFilesListV2(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const query = text(a, "p_query");
  const from = date(a, "p_from");
  const to = date(a, "p_to");
  const order = text(a, "p_order");
  const origin = text(a, "p_origin");
  const limit = int(a, "p_limit");
  const offset = int(a, "p_offset");
  const db = ctx.db;
  activityRequireAdmin(db, user);
  const range = from === null && to === null ? null : period(from, to);
  if (
    (from === null) !== (to === null) ||
    order === null ||
    !["data", "nome", "tamanho"].includes(order) ||
    (origin !== null && !["documentos", "contatos", "financeiro", "produtos", "empresa"].includes(origin)) ||
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    offset === null ||
    offset < 0 ||
    offset > 100000 ||
    (query !== null && (pgLength(query) > 120 || /[\x01-\x1f\x7f]/.test(query)))
  )
    raise("22023", "erp_activity_input_invalid");
  const lowered = pgLower(pgBtrim(query ?? ""));
  const q = lowered === "" ? null : lowered;
  const want = (o: string) => origin === null || origin === o;
  const at = "CAST(coalesce(x.finished_at, x.created_at) AS TEXT) at_time";
  const base = "x.id, x.filename, x.mime_type, x.size_bytes, x.sha256, x.actor";
  const rows: FileRow[] = [];
  const push = (originName: string, list: Record<string, unknown>[], map: (r: Record<string, unknown>) => Partial<FileRow>) => {
    for (const r of list)
      rows.push({
        id: String(r.id),
        origin: originName,
        filename: String(r.filename),
        mime_type: String(r.mime_type),
        size_bytes: Number(r.size_bytes),
        sha256: String(r.sha256),
        actor: String(r.actor),
        at_time: BigInt(String(r.at_time)),
        source_kind: "",
        source_id: "",
        source_code: null,
        source_label: null,
        ...map(r),
      });
  };
  if (want("documentos"))
    push(
      "documentos",
      db.exec(
        `SELECT ${base}, ${at}, d.kind, d.id doc_id, CAST(d.number AS TEXT) number, json_extract(d.contact_snapshot, '$.name') contact_name
         FROM "erp_attachments__attachment" x JOIN "erp_documents__document" d ON d.id=x.document_id WHERE x.status='ready' AND x.deleted_at IS NULL`,
      ).rows,
      (r) => ({
        source_kind: String(r.kind),
        source_id: String(r.doc_id),
        source_code: r.number === null ? null : String(r.number),
        source_label: clean(typeof r.contact_name === "string" ? r.contact_name : r.contact_name === null ? null : String(r.contact_name), 200),
      }),
    );
  if (want("contatos"))
    push(
      "contatos",
      db.exec(
        `SELECT ${base}, ${at}, x.purpose, x.contact_id, r.code, r.name FROM "erp_attachments__contact_file" x JOIN "erp_catalog__record" r ON r.id=x.contact_id
         WHERE x.status='ready' AND x.deleted_at IS NULL`,
      ).rows,
      (r) => ({
        source_kind: r.purpose === "photo" ? "contact_photo" : "contact",
        source_id: String(r.contact_id),
        source_code: clean(r.code as string | null, 120),
        source_label: clean(r.name as string | null, 200),
      }),
    );
  if (want("financeiro"))
    push(
      "financeiro",
      db.exec(
        `SELECT ${base}, ${at}, x.owner_kind, x.owner_id, coalesce(t.description, e.note) label FROM "erp_finance__file" x
         LEFT JOIN "erp_finance__title" t ON t.id=x.title_id LEFT JOIN "erp_finance__cash_entry" e ON e.id=x.cash_entry_id
         WHERE x.status='ready' AND x.deleted_at IS NULL`,
      ).rows,
      (r) => ({ source_kind: String(r.owner_kind), source_id: String(r.owner_id), source_code: null, source_label: clean(r.label as string | null, 200) }),
    );
  if (want("produtos"))
    push(
      "produtos",
      db.exec(
        `SELECT ${base}, ${at}, x.product_id, r.code, r.name FROM "erp_catalog__product_stored_image" x JOIN "erp_catalog__record" r ON r.id=x.product_id
         WHERE x.status='ready' AND x.deleted_at IS NULL`,
      ).rows,
      (r) => ({ source_kind: "product", source_id: String(r.product_id), source_code: clean(r.code as string | null, 120), source_label: clean(r.name as string | null, 200) }),
    );
  if (want("empresa")) {
    push(
      "empresa",
      db.exec(
        `SELECT x.id, CASE x.mime_type WHEN 'image/png' THEN 'logo.png' ELSE 'logo.jpg' END filename, x.mime_type, x.size_bytes, x.sha256, x.actor, ${at}
         FROM "erp_company__logo" x WHERE x.status='ready' AND x.deleted_at IS NULL`,
      ).rows,
      (r) => ({ source_kind: "logo", source_id: String(r.id), source_label: "Logo da empresa" }),
    );
    push(
      "empresa",
      db.exec(`SELECT ${base}, ${at} FROM "erp_company__file" x WHERE x.status='ready' AND x.deleted_at IS NULL`).rows,
      (r) => ({ source_kind: "company_file", source_id: String(r.id), source_label: "Arquivo da empresa" }),
    );
  }
  const picked = rows.filter((f) => (range === null || (f.at_time >= range.from && f.at_time < range.to)) && (q === null || pgLower(f.filename).includes(q)));
  picked.sort(
    (x, y) =>
      (order === "nome" ? compareText(pgLower(x.filename), pgLower(y.filename)) : 0) ||
      (order === "tamanho" ? y.size_bytes - x.size_bytes : 0) ||
      (x.at_time > y.at_time ? -1 : x.at_time < y.at_time ? 1 : 0) ||
      compareText(x.id, y.id),
  );
  const items = picked.slice(offset!, offset! + limit!).map((x) => ({
    id: x.id,
    origin: x.origin,
    filename: x.filename,
    mime_type: x.mime_type,
    size_bytes: x.size_bytes,
    sha256: x.sha256,
    created_at: jsonTimestamp(x.at_time.toString()),
    owner: { user_id: x.actor, label: actorLabel(db, x.actor) },
    source: { kind: x.source_kind, id: x.source_id, code: x.source_code, label: x.source_label },
  }));
  return {
    scope: "files",
    data_mode: "erp_native",
    query: q,
    from,
    to,
    order,
    origin,
    limit,
    offset,
    total: picked.length,
    total_bytes: picked.reduce((s, f) => s + BigInt(f.size_bytes), 0n).toString(),
    has_more: offset! + items.length < picked.length,
    items,
  };
}

const NEG_INFINITY = "-9223372036854775808";
const LOCK = 30_000_000n;

export function erpWabotiaState(ctx: RpcContext, a: RpcArgs) {
  const action = text(a, "p_action");
  const lock = uuid(a, "p_lock");
  const cipher = text(a, "p_cipher");
  const db = ctx.db;
  const row = () => one(db, 'SELECT cipher, lock_id, CAST(lock_until AS TEXT) lock_until FROM "public__erp_wabotia_pairing" WHERE id=1');
  if (action === "read") return { cipher: row()?.cipher ?? null };
  if (action === "reserve" && lock !== null) {
    const r = row();
    const now = nowMicros();
    if (r && BigInt(String(r.lock_until)) < now) {
      db.exec('UPDATE "public__erp_wabotia_pairing" SET lock_id=?, lock_until=? WHERE id=1', lock, (now + LOCK).toString());
      return { acquired: true, cipher: r.cipher };
    }
    return { acquired: false, cipher: null };
  }
  if (action === "save") {
    const r = row();
    if (!r || lock === null || r.lock_id !== lock || !(BigInt(String(r.lock_until)) > nowMicros())) raise("P0001", "pairing lock expired");
    db.exec('UPDATE "public__erp_wabotia_pairing" SET cipher=? WHERE id=1', cipher);
  } else if (action === "release") {
    if (lock !== null) db.exec('UPDATE "public__erp_wabotia_pairing" SET lock_id=NULL, lock_until=? WHERE id=1 AND lock_id=?', NEG_INFINITY, lock);
  } else raise("P0001", "invalid pairing operation");
  return { ok: true };
}

registerRpc("erp_preferences_import_job", erpPreferencesImportJob);
registerRpc("erp_preferences_import_jobs", erpPreferencesImportJobs);
registerRpc("erp_history_backups", erpHistoryBackups);
registerRpc("erp_read_records", erpReadRecords);
registerRpc("erp_files_list_v2", erpFilesListV2);
registerRpc("erp_wabotia_state", erpWabotiaState);
