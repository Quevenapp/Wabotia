// Backup lógico do ERP: uma tabela por arquivo NDJSON (primeira linha: as
// colunas; depois uma linha por registro, com todo inteiro como texto exato),
// gzip, no R2 em erp-backups/<área>/<instante>/, e um manifesto com a versão
// do esquema e, por tabela, linhas e SHA-256 do NDJSON. Fase 0, prova 8.
//
// O dump é lido de forma síncrona numa invocação só: é um retrato
// consistente (nenhuma escrita entra no meio). Para bancos grandes, em
// fatias por alarme, com manutenção ligada (escritas 503) — fase 3.
import { createHash } from "node:crypto";
import { ERP_TABLES } from "../schema/columns.generated.ts";
import { ERP_ENGINE_TABLES } from "../schema/engine-tables.ts";

/** Tabelas do retrato: as do esquema gerado e as só do motor (schema/engine-tables.ts). */
const ALL_TABLES: readonly string[] = [...Object.keys(ERP_TABLES), ...ERP_ENGINE_TABLES.map((t) => t.table)];
/** Nunca exportar o cofre legado ou um estado transitório de autorização. */
const AUTHORIZATION_TABLES = new Set(["origin_sync__credentials", "origin_sync__oauth_state"]);
const DUMP_TABLES = ALL_TABLES.filter(table => !AUTHORIZATION_TABLES.has(table));
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../schema/ddl.ts";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Teto do backup lógico, em bytes de NDJSON (o texto exportado, antes do
 * gzip). O retrato inteiro é materializado no isolado de 128 MB: as linhas da
 * maior tabela, todos os corpos NDJSON e o gzip de um arquivo coexistem. Acima
 * disto o backup e a restauração falham cedo, antes de materializar ou de
 * publicar manifesto; a cópia do banco passa a ser a da plataforma
 * (recuperação no tempo do Durable Object). docs/RECEBER-BLING.md.
 * Medição (Node, heap mínimo em que backup + restauração completam): cerca de
 * 3,6 × o NDJSON + 12 MB; 17 MB → 72 MB, 25 MB → 96 MB, 34 MB → 128 MB.
 * 16 MiB deixa por volta de metade do isolado para o restante do Worker.
 */
export const ERP_LOGICAL_BACKUP_LIMIT_BYTES = 16 * 1024 * 1024;
export class ErpBackupTooLargeError extends Error {
  readonly code = "erp_backup_too_large";
  readonly limit: number;
  constructor(limit = ERP_LOGICAL_BACKUP_LIMIT_BYTES) {
    super(`O acervo passa de ${limit} bytes de dados exportados: o backup lógico não cobre este tamanho. Use a recuperação no tempo da plataforma.`);
    this.name = "ErpBackupTooLargeError";
    this.limit = limit;
  }
}
/** Exclusão ou gravação externa de XML em voo ou ainda não reconciliada. */
export class ErpRestoreBusyError extends Error {
  readonly code = "erp_restore_archive_busy";
  constructor() {
    super("Há exclusão ou gravação de XML do acervo em andamento ou sem conferência. A restauração não começou; tente de novo depois que terminar.");
    this.name = "ErpRestoreBusyError";
  }
}
/** Durável: o que sobrevive a uma queda do isolado. O que está só na memória
 * (chamada viva além do prazo da acordada) é conferido pela instância. */
const ARCHIVE_IO_UNRECONCILED = `SELECT 1 AS busy FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded') AND (
  (kind='r2_delete' AND (owner IS NOT NULL OR error_code IS NOT NULL OR json_extract(progress,'$.deleted') IS NOT NULL))
  OR (substr(kind,1,4)='xml_' AND (phase='fetching' OR json_type(progress,'$.xml') IS NOT NULL))) LIMIT 1`;

export interface DumpManifest {
  format: 1;
  schema_version: number;
  schema_hash: string;
  created_at: string;
  tables: { table: string; rows: number; sha256: string }[];
}

/** Colunas da tabela no objeto (inclusive as normalizadas pelo motor). */
function columns(sql: SqlStorage, table: string) {
  return (sql.exec(`PRAGMA table_info(${q(table)})`).toArray() as { name: string; type: string }[]).map((c) => ({
    name: c.name,
    integer: c.type === "INTEGER",
    blob: c.type === "BLOB",
  }));
}

/** O backup não transporta aprovação da instalação nem uma posse reutilizável. */
function backupExpression(table: string, column: string): string {
  if (table === "wb_bling_control") {
    if (["collect_enabled", "app_configured"].includes(column)) return "0";
    if (column === "state") return "'off'";
    if (column === "credential_status") return "'missing'";
    if (column === "credential_scopes") return "'[]'";
    if (["approved_by", "approved_at", "approval_hash", "credential_expires_at"].includes(column)) return "NULL";
  }
  if (table === "wb_bling_unit") {
    if (["owner", "fence", "lease_until"].includes(column)) return "NULL";
    if (column === "phase") return "CASE WHEN phase IN ('reserved','fetching') THEN 'waiting' ELSE phase END";
  }
  if (table === "origin_sync__resource_state" && ["lease_owner", "lease_token", "lease_expires_at"].includes(column)) return "NULL";
  return q(column);
}

/** Expressões exportadas de uma tabela: as mesmas na medição e no retrato. */
function tablePlan(sql: SqlStorage, table: string) {
  const cols = columns(sql, table);
  const values = cols.map(c => {
    const expression = backupExpression(table, c.name);
    return c.integer ? `CAST(${expression} AS TEXT)` : c.blob ? `hex(${expression})` : expression;
  });
  // OAuth usa unidades próprias; nem os hashes de estado e navegador vão ao retrato.
  const filter = table === "wb_bling_unit" ? " WHERE substr(kind,1,6) <> 'oauth_'" : "";
  return { cols, values, filter };
}

/**
 * Tamanho do NDJSON do retrato, somado pelo SQLite tabela a tabela, sem trazer
 * linhas ao isolado. Conta o texto de cada valor (nulo como "null"), aspas,
 * separadores e o escape de aspas e barras; não conta escape de caracteres de
 * controle. Para no primeiro total acima do teto.
 */
export function measureDump(storage: DurableObjectStorage, limit = ERP_LOGICAL_BACKUP_LIMIT_BYTES): number {
  const sql = storage.sql;
  let total = 0;
  for (const table of DUMP_TABLES) {
    const { cols, values, filter } = tablePlan(sql, table);
    const sizes = values.map(value => {
      const text = `CAST(${value} AS TEXT)`;
      return `coalesce(2*length(${text})-length(replace(replace(${text},'"',''),'\\','')),4)`;
    }).join("+");
    const row = sql.exec(`SELECT coalesce(sum(${sizes}),0) AS chars,count(*) AS n FROM ${q(table)}${filter}`).toArray()[0] as { chars: unknown; n: unknown };
    const n = Number(row.n);
    if (!n) continue;
    total += Number(row.chars) + n * (3 + cols.length * 3) + JSON.stringify(cols.map(c => c.name)).length + 1;
    if (total > limit) throw new ErpBackupTooLargeError(limit);
  }
  return total;
}

/** Retrato de todas as tabelas não secretas do ERP (só as que têm linhas). */
export function dumpAll(storage: DurableObjectStorage, limit = ERP_LOGICAL_BACKUP_LIMIT_BYTES) {
  const sql = storage.sql;
  // Mede antes de materializar: acima do teto, falha sem estourar a memória.
  measureDump(storage, limit);
  const files: { table: string; body: string }[] = [];
  const manifest: DumpManifest = {
    format: 1,
    schema_version: ERP_DDL_VERSION,
    schema_hash: ERP_DDL_HASH,
    created_at: new Date().toISOString(),
    tables: [],
  };
  for (const table of DUMP_TABLES) {
    const { cols, values, filter } = tablePlan(sql, table);
    const select = values.map((value, index) => `${value} AS ${q(cols[index].name)}`).join(",");
    const rows: unknown[][] = Array.from(sql.exec(`SELECT ${select} FROM ${q(table)}${filter} ORDER BY rowid`).raw());
    if (!rows.length) continue;
    const body = [JSON.stringify(cols.map((c) => c.name)), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
    files.push({ table, body });
    manifest.tables.push({ table, rows: rows.length, sha256: sha(body) });
  }
  return { manifest, files };
}

/**
 * Restaura um retrato numa instância com o mesmo esquema: troca o conteúdo
 * das tabelas do manifesto (a semeadura inclusive) numa transação. Gatilhos
 * de imutabilidade saem durante a carga e voltam iguais; FKs adiadas e
 * conferidas antes do fim (prova 1).
 */
export function restoreAll(
  storage: DurableObjectStorage,
  manifest: DumpManifest,
  files: Map<string, string>,
  options: { profile?: string } = {},
) {
  if (manifest.schema_hash !== ERP_DDL_HASH)
    throw new Error(`Backup de outro esquema (${manifest.schema_hash}); este é ${ERP_DDL_HASH}.`);
  const allowed = new Set(DUMP_TABLES);
  const seen = new Set<string>();
  for (const entry of manifest.tables) {
    if (!allowed.has(entry.table) || seen.has(entry.table)) throw new Error("Tabela não permitida no backup.");
    seen.add(entry.table);
  }
  const sql = storage.sql;
  let rows = 0;
  storage.transactionSync(() => {
    // Um DELETE/PUT de XML enviado e não conferido pode terminar depois da troca
    // e apagar um arquivo que o retrato volta a referenciar: não começar.
    if (sql.exec(ARCHIVE_IO_UNRECONCILED).toArray().length) throw new ErpRestoreBusyError();
    sql.exec("PRAGMA defer_foreign_keys = ON");
    const previousControl = sql.exec("SELECT revision,authorization_revision,credential_revision,updated_at FROM wb_bling_control WHERE id=1").toArray()[0];
    const triggers = sql
      .exec("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .toArray() as { name: string; sql: string }[];
    for (const g of triggers) sql.exec(`DROP TRIGGER ${q(g.name)}`);
    // Tabelas que já têm linhas (semeadura) e não estão no backup ficam vazias.
    for (const table of ALL_TABLES) sql.exec(`DELETE FROM ${q(table)}`);
    for (const t of manifest.tables) {
      const body = files.get(t.table);
      if (body === undefined || sha(body) !== t.sha256) throw new Error(`Arquivo do backup corrompido: ${t.table}`);
      const [head, ...lines] = body.trimEnd().split("\n");
      const cols: string[] = JSON.parse(head);
      const blobs = new Set(columns(sql, t.table).filter((c) => c.blob).map((c) => c.name));
      const per = Math.max(1, Math.floor(100 / cols.length));
      for (let i = 0; i < lines.length; i += per) {
        const part = lines.slice(i, i + per).map((l) => JSON.parse(l) as unknown[]);
        const values = part.map(() => `(${cols.map((c) => (blobs.has(c) ? "unhex(?)" : "?")).join(",")})`).join(",");
        sql.exec(`INSERT INTO ${q(t.table)} (${cols.map(q).join(",")}) VALUES ${values}`, ...part.flat());
        rows += part.length;
      }
    }
    // Mesmo um backup fabricado com o hash atual não reativa uma autorização.
    // As revisões avançam; resultados de I/O anteriores não podem ressuscitá-la.
    sql.exec("DELETE FROM wb_bling_unit WHERE substr(kind,1,6) = 'oauth_'");
    if (previousControl) sql.exec("INSERT OR IGNORE INTO wb_bling_control(id,updated_at) VALUES(1,?)", previousControl.updated_at);
    sql.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off',revision=max(revision,?)+1,authorization_revision=max(authorization_revision,?)+1,credential_revision=max(credential_revision,?)+1,approved_by=NULL,approved_at=NULL,approval_hash=NULL,app_configured=0,credential_status='missing',credential_expires_at=NULL,credential_scopes='[]',next_allowed_at=NULL",
      Number(previousControl?.revision ?? 0), Number(previousControl?.authorization_revision ?? 0), Number(previousControl?.credential_revision ?? 0));
    sql.exec("UPDATE wb_bling_unit SET owner=NULL,fence=NULL,lease_until=NULL,phase=CASE WHEN phase IN ('reserved','fetching') THEN 'waiting' ELSE phase END");
    sql.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL");
    // Um apagamento em curso no retrato não pode terminar: o controle volta
    // desligado e a geração dele não confere. Aposentá-lo; um novo apagamento
    // exige nova prévia e confirmação. As exclusões R2 que ele já enfileirou
    // passam à limpeza de órfãos desta área, que só apaga objeto que nenhum
    // item restaurado referencia; de outra área, ficam só registradas.
    const now = Date.now();
    sql.exec(`UPDATE wb_bling_unit SET plan=json_set(plan,'$.orphan_work_id',json_extract(plan,'$.purge_work_id')),error_code=NULL,not_before=?,updated_at=?
      WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded') AND json_extract(plan,'$.purge_work_id') IS NOT NULL
        AND json_extract(plan,'$.orphan_work_id') IS NULL AND json_extract(plan,'$.profile') IS ?`, now, now, options.profile ?? null);
    sql.exec(`UPDATE wb_bling_unit SET phase='superseded',error_code='BLING_GENERATION_RETIRED',finished_at=?,updated_at=?
      WHERE phase NOT IN ('committed','superseded') AND (kind='purge' OR (kind='r2_delete' AND json_extract(plan,'$.orphan_work_id') IS NULL))`, now, now);
    for (const g of triggers) sql.exec(g.sql);
    const broken = sql.exec("PRAGMA foreign_key_check").toArray();
    if (broken.length) throw new Error("Backup com FK quebrada: " + JSON.stringify(broken[0]));
  });
  return { tables: manifest.tables.length, rows };
}

const gzip = async (text: string) =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

/** Grava o retrato no R2: erp-backups/<área>/<instante>/ (manifesto por último). */
export async function backupToR2(bucket: R2Bucket, profile: string, dump: ReturnType<typeof dumpAll>) {
  const prefix = `erp-backups/${profile}/${dump.manifest.created_at.replace(/[:.]/g, "-")}/`;
  let bytes = 0;
  for (const f of dump.files) {
    const body = await gzip(f.body);
    bytes += body.byteLength;
    await bucket.put(prefix + f.table + ".ndjson.gz", body, { httpMetadata: { contentType: "application/gzip" } });
  }
  await bucket.put(prefix + "manifest.json", JSON.stringify(dump.manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  return { prefix, bytes };
}

/** Descompacta em fluxo, contando os bytes: para assim que o teto é ultrapassado. */
async function gunzipWithin(bytes: ArrayBuffer, budget: { left: number; limit: number }) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.left -= value.byteLength;
      if (budget.left < 0) throw new ErpBackupTooLargeError(budget.limit);
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally { try { await reader.cancel(); } catch { /* Leitor já encerrado. */ } }
  parts.push(decoder.decode());
  return parts.join("");
}

export async function readBackup(bucket: R2Bucket, prefix: string, limit = ERP_LOGICAL_BACKUP_LIMIT_BYTES) {
  const manifestObject = await bucket.get(prefix + "manifest.json");
  if (!manifestObject) throw new Error("Backup sem manifesto.");
  const manifest = (await manifestObject.json()) as DumpManifest;
  const files = new Map<string, string>();
  // O tamanho é medido antes de materializar: o compactado pelo R2, antes de
  // ler o corpo; o descompactado, enquanto sai do fluxo.
  const budget = { left: limit, limit };
  let compressed = 0;
  for (const t of manifest.tables) {
    const object = await bucket.get(prefix + t.table + ".ndjson.gz");
    if (!object) throw new Error(`Backup sem a tabela ${t.table}.`);
    compressed += Number(object.size ?? 0);
    if (compressed > limit) { try { await object.body?.cancel(); } catch { /* Sem leitura. */ } throw new ErpBackupTooLargeError(limit); }
    files.set(t.table, await gunzipWithin(await object.arrayBuffer(), budget));
  }
  return { manifest, files };
}
