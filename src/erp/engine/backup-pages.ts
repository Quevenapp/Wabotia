// Backup lógico do ERP em páginas (formato 2) e restauração em fluxo, para um
// banco de qualquer tamanho dentro do teto da área. docs/ERP-PORTE.md, "Backup
// lógico em páginas".
//
// Backup: tabela por tabela (DUMP_TABLES, a mesma lista do formato 1), páginas
// por rowid (chave estável), partes de ~1 MiB de NDJSON comprimidas e enviadas
// ao R2 uma a uma. Cada parte confirmada grava, numa transação, a entrada da
// parte e o checkpoint (rowid, hash retomável da tabela). Queda: a retomada
// refaz só a parte não confirmada, com a mesma chave (sobrescreve a órfã).
// O manifesto só é publicado no fim; trabalho que falha limpa as partes.
//
// Retrato de um instante: uma barreira de escrita (engine/backup-state.ts)
// vale da abertura até a última parte. Escritas do ERP da área voltam 503 com
// código próprio; leituras continuam. A barreira tem prazo renovável e prazo
// absoluto e é solta em qualquer saída.
//
// Restauração: confere cada parte (tamanho, hash, linhas e o hash da tabela)
// e a guarda na erp_meta em pedaços (estágio), em várias invocações; o banco
// não muda e as escritas ficam suspensas. Depois, a troca em etapas
// (engine/backup-swap.ts): transações pequenas, retomáveis, com a área
// inteira parada para o ERP; antes da primeira, a marca da recuperação no
// tempo é gravada, e se a troca não terminar o objeto volta a ela. Ou o banco
// fica igual ao backup, ou fica como estava. Backups do formato 1 (um arquivo
// por tabela) entram pelo mesmo caminho, cada arquivo como uma parte.
import { createHash } from "node:crypto";
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../schema/ddl.ts";
import { ALL_TABLES, DUMP_TABLES, ErpRestoreBusyError, archiveIoLiveError, archiveMemoryBusyError, beginRestoreSwap, q, tablePlan } from "./dump.ts";
import { beginArchiveRestore, endArchiveRestore } from "../bling/xml.ts";
import { Sha256 } from "./sha256-state.ts";
import {
  BACKUP_BARRIER_LEASE_MS, BACKUP_BARRIER_MAX_MS, backupJobActive, backupJobStatus, readBackupJob, writeBackupJob,
  type BackupJob, type BackupJobError,
} from "./backup-state.ts";
import {
  CARRY_KEY, ErpRestoreCheckError, ErpRestoreRestartError, RESTORE_SWAP_GROW_MAX_BYTES, RESTORE_SWAP_MAX_STALLS, RESTORE_SWAP_TXN_BYTES, STAGE_KEY, TRIGGER_KEY,
  initialSwapCursor, isForeignKeyError, prefixEnd, restorePlan, saveTriggers, stageKey, stagePrefix, storageBookmarks, swapUnit,
  type RestoreBookmarks, type SwapContext, type SwapGroup,
} from "./backup-swap.ts";
export { ErpRestoreRestartError, storageBookmarks, type RestoreBookmarks } from "./backup-swap.ts";

/** Texto (NDJSON) por parte. A memória do backup é proporcional a isto, não ao banco. */
export const BACKUP_PART_TARGET_BYTES = 1024 * 1024;
/** Linhas por SELECT ao montar uma parte. */
export const BACKUP_PAGE_ROWS = 256;
/** Caracteres por pedaço do estágio da restauração (cabe no limite de 2 MB por linha do SQLite do objeto). */
export const RESTORE_STAGE_CHUNK_CHARS = 256 * 1024;
/**
 * Disco do objeto da área: o SQLite de um Durable Object vai até 10 GB na
 * Cloudflare. A restauração em etapas não tem teto de memória; o que a limita
 * é caber no disco os dados atuais mais o estágio.
 */
export const ERP_OBJECT_DISK_LIMIT_BYTES = 10_000_000_000;
/** Folga do disco além do cálculo (índices, páginas livres, erp_meta). */
export const ERP_RESTORE_DISK_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * Disco que a restauração precisa: o estágio (o texto do backup) ao lado dos
 * dados atuais; os dados restaurados ocupam o lugar dos apagados e do estágio
 * consumido, mas podem passar dele (cerca de 1,5 × o texto com índices).
 */
export const restoreDiskNeeded = (databaseBytes: number, textBytes: number) =>
  Math.max(databaseBytes + textBytes, Math.ceil(textBytes * 1.5)) + ERP_RESTORE_DISK_MARGIN_BYTES;
/**
 * Maior backup (bytes UTF-8 do NDJSON, somados por parte) que a restauração
 * traz de volta num objeto vazio: o que cabe no disco, já com a folga. A
 * restauração confere, além disto, o disco com os dados atuais da área
 * (restoreDiskNeeded). Antes (troca numa transação só) eram 64 MiB, pela
 * memória do objeto. O backup não para neste teto: sai inteiro e declara no
 * manifesto e no estado se passa dele (logical_restore). `swapLimitBytes`
 * nas opções troca este valor (testes e o arnês de medição).
 */
export const ERP_RESTORE_SWAP_LIMIT_BYTES = Math.floor((ERP_OBJECT_DISK_LIMIT_BYTES - ERP_RESTORE_DISK_MARGIN_BYTES) / 1.5);
/** Cobertura da restauração lógica desta versão, declarada pelo backup em páginas. */
export interface LogicalRestoreCoverage { limit_bytes: number; exceeds_limit: boolean }
export const logicalRestoreCoverage = (textBytes: number, limit = ERP_RESTORE_SWAP_LIMIT_BYTES): LogicalRestoreCoverage =>
  ({ limit_bytes: limit, exceeds_limit: textBytes > limit });
/** Aviso do backup que passa do que a restauração lógica traz de volta. */
export const logicalRestoreWarning = (textBytes: number, limit = ERP_RESTORE_SWAP_LIMIT_BYTES) =>
  `O backup foi gravado inteiro (${textBytes} bytes de dados exportados), mas a restauração lógica cobre até ${limit} bytes, o que cabe no disco do objeto da área. Para voltar a este ponto, use a recuperação no tempo do objeto da área.`;
const PART_KEY = "wb_backup_part:";
const TABLE_KEY = "wb_backup_table:";
const pad = (n: number, width: number) => String(n).padStart(width, "0");
const partRowKey = (seq: number) => PART_KEY + pad(seq, 7);
const tableRowKey = (index: number) => TABLE_KEY + pad(index, 5);
/**
 * Registro, no R2, de uma troca que voltou à marca: a volta desfaz também o
 * estado do trabalho no objeto, então o motivo fica fora dele. Ao acordar
 * depois da volta, o trabalho lê este registro e termina como falho.
 */
export const RESTORE_ROLLBACK_DIR = "_restauracoes/";
export const restoreRollbackKey = (job: Pick<BackupJob, "profile" | "id">) => `erp-backups/${job.profile}/${RESTORE_ROLLBACK_DIR}${job.id}.json`;

/** Linhas da área que apontam para bytes no R2 (XML do acervo e anexos). */
const ATTACHMENT_TABLES = [
  "erp_attachments__attachment", "erp_attachments__contact_file", "erp_attachments__employee_file",
  "erp_company__file", "erp_company__logo", "erp_finance__file", "erp_catalog__product_stored_image", "erp_platform__export",
];
export const BACKUP_STORAGE_NOTE = "Os bytes dos XML do acervo e dos anexos continuam no armazenamento de arquivos (R2) e não entram neste backup lógico. As contagens são das linhas do banco que os referenciam; preservar esses objetos é parte da cópia da área.";

export interface PagedPart {
  table: string;
  /** Ordem global no backup. */
  seq: number;
  /** Ordem dentro da tabela. */
  index: number;
  /** Nome do objeto, relativo ao prefixo. */
  key: string;
  rows: number;
  /** Bytes do objeto compactado (gzip). */
  bytes: number;
  /** Bytes do NDJSON da parte (cabeçalho + linhas). */
  text_bytes: number;
  /** SHA-256 do NDJSON da parte. */
  sha256: string;
}

export interface PagedManifest {
  format: 2;
  schema_version: number;
  schema_hash: string;
  created_at: string;
  /** Por tabela, como no formato 1: linhas e SHA-256 do NDJSON inteiro da tabela. */
  tables: { table: string; rows: number; sha256: string }[];
  parts: PagedPart[];
  totals: { tables: number; rows: number; parts: number; bytes: number; text_bytes: number };
  external_objects: Record<string, unknown>;
  job: { id: string; started_at: number; barrier_held_ms: number; invocations: number };
  /** Se a restauração lógica desta versão cobre o backup. Manifesto antigo pode não ter; a restauração confere text_bytes. */
  logical_restore?: LogicalRestoreCoverage;
}

export class ErpBackupJobError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ErpBackupJobError";
    this.code = code;
    this.status = status;
  }
}

export interface BackupHooks {
  /**
   * Pontos de queda simulada nos testes: lançar aqui é o mesmo que o isolado
   * cair naquele instante (nada depois dele roda; o estado durável fica).
   */
  at?: (point: string, job: BackupJob) => void | Promise<void>;
}

export interface BackupRunOptions {
  now?: () => number;
  /** Orçamento de relógio desta invocação. */
  budgetMs?: number;
  /** Teto de unidades desta invocação (protege quando o relógio não anda). */
  maxUnits?: number;
  hooks?: BackupHooks;
  /**
   * Teto da restauração lógica que o backup declara (logical_restore); o
   * backup não para nele. Padrão ERP_RESTORE_SWAP_LIMIT_BYTES; nos testes, menor.
   */
  swapLimitBytes?: number;
  /**
   * Marca da recuperação no tempo para a troca. Padrão: a do próprio
   * armazenamento (storageBookmarks); sem marca, a troca não começa.
   */
  bookmarks?: RestoreBookmarks | null;
  /** Texto por transação da troca. Padrão RESTORE_SWAP_TXN_BYTES (8 MiB); nos testes, menor. */
  swapTxnBytes?: number;
}

const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const utf8Length = (text: string) => new TextEncoder().encode(text).length;
const meta = (storage: DurableObjectStorage, key: string) =>
  (storage.sql.exec("SELECT value FROM erp_meta WHERE key=?", key).toArray()[0] as { value?: string } | undefined)?.value ?? null;
const putMeta = (storage: DurableObjectStorage, key: string, value: string) =>
  storage.sql.exec("INSERT INTO erp_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);

async function gzipText(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

function countRows(storage: DurableObjectStorage, table: string): number {
  const { filter } = tablePlan(storage.sql, table);
  return Number((storage.sql.exec(`SELECT count(*) AS n FROM ${q(table)}${filter}`).toArray()[0] as { n: unknown }).n);
}

/** Contagem das linhas que referenciam objetos no R2 (retrato do mesmo instante). */
function externalObjects(storage: DurableObjectStorage): Record<string, unknown> {
  const count = (table: string) => {
    try { return Number((storage.sql.exec(`SELECT count(*) AS n FROM ${q(table)}`).toArray()[0] as { n: unknown }).n); }
    catch { return 0; }
  };
  const attachments: Record<string, number> = {};
  for (const table of ATTACHMENT_TABLES) { const n = count(table); if (n) attachments[table] = n; }
  return {
    included: false,
    note: BACKUP_STORAGE_NOTE,
    xml_objects: count("origin_fiscal__object"),
    attachment_rows: Object.values(attachments).reduce((a, b) => a + b, 0),
    attachments_by_table: attachments,
  };
}

const emptyCursor = () => ({ table_index: 0, after_rowid: null, table_part: 0, table_rows: 0, table_sha: null, table_header: null, part_seq: 0, manifest_sha: null });

/** Escritor único por objeto: o alarme e uma rota nunca avançam o mesmo trabalho juntos. */
const running = new WeakMap<DurableObjectStorage, Promise<unknown>>();

/**
 * Abre um backup: grava o trabalho e a barreira numa transação (o instante do
 * retrato). Se já há um backup ativo, devolve-o; restauração ativa recusa.
 */
export function startBackup(storage: DurableObjectStorage, profile: string, options: { now?: () => number } = {}): BackupJob {
  const now = (options.now ?? Date.now)();
  return storage.transactionSync(() => {
    const current = readBackupJob(storage);
    if (backupJobActive(current)) {
      if (current.kind === "backup" && current.profile === profile) return current;
      throw new ErpBackupJobError("erp_backup_job_running", "Já há uma restauração em andamento nesta área.");
    }
    clearJobRows(storage);
    const createdAt = new Date(now).toISOString();
    const rowsTotal = DUMP_TABLES.reduce((sum, table) => sum + countRows(storage, table), 0);
    const job: BackupJob = {
      id: crypto.randomUUID(), kind: "backup", phase: "export", profile,
      prefix: `erp-backups/${profile}/${createdAt.replace(/[:.]/g, "-")}/`,
      schema_hash: ERP_DDL_HASH, created_at: createdAt, started_at: now, updated_at: now, finished_at: null,
      barrier_until: now + BACKUP_BARRIER_LEASE_MS, barrier_deadline: now + BACKUP_BARRIER_MAX_MS, barrier_released_at: null,
      step: 0, invocations: 0, cursor: emptyCursor(),
      progress: { tables_total: DUMP_TABLES.length, tables_done: 0, rows_total: rowsTotal, rows_done: 0, parts_total: null, parts_done: 0, bytes: 0, text_bytes: 0 },
      external_objects: externalObjects(storage), result: null, error: null,
    };
    writeBackupJob(storage, job);
    return job;
  });
}

/** Linhas auxiliares de um trabalho anterior (entradas de partes, tabelas, estágio). */
function clearJobRows(storage: DurableObjectStorage, limit?: number): number {
  let removed = 0;
  for (const prefix of [PART_KEY, TABLE_KEY, STAGE_KEY, TRIGGER_KEY, CARRY_KEY]) {
    const where = "key >= ? AND key < ?";
    if (limit === undefined) {
      removed += storage.sql.exec(`DELETE FROM erp_meta WHERE ${where}`, prefix, prefixEnd(prefix)).rowsWritten;
    } else {
      removed += storage.sql.exec(`DELETE FROM erp_meta WHERE key IN (SELECT key FROM erp_meta WHERE ${where} ORDER BY key LIMIT ?)`,
        prefix, prefixEnd(prefix), limit).rowsWritten;
      if (removed >= limit) return removed;
    }
  }
  return removed;
}

interface ManifestEntryPart { table: string; seq: number; index: number; key: string; rows: number; bytes: number | null; text_bytes: number | null; sha256: string; last: boolean; table_sha256: string }
interface ManifestView { format: 1 | 2; tables: { table: string; rows: number; sha256: string }[]; parts: ManifestEntryPart[]; raw: Record<string, unknown> }

const SHA_RE = /^[0-9a-f]{64}$/;
const invalidBackup = (message: string) => new ErpBackupJobError("erp_backup_invalid", message, 422);

/** Valida o manifesto (formatos 1 e 2) e devolve a lista de partes a conferir. */
export function readManifest(text: string): ManifestView {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { throw invalidBackup("Manifesto do backup ilegível."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidBackup("Manifesto do backup ilegível.");
  if (raw.schema_hash !== ERP_DDL_HASH)
    throw new ErpBackupJobError("erp_backup_schema_mismatch", `Backup de outro esquema (${String(raw.schema_hash)}); este é ${ERP_DDL_HASH}.`, 409);
  const tables = raw.tables as ManifestView["tables"];
  if (!Array.isArray(tables)) throw invalidBackup("Manifesto sem tabelas.");
  const allowed = new Set(DUMP_TABLES), seen = new Set<string>();
  for (const entry of tables) {
    if (!entry || typeof entry.table !== "string" || !allowed.has(entry.table) || seen.has(entry.table)) throw invalidBackup("Tabela não permitida no backup.");
    if (!Number.isSafeInteger(entry.rows) || entry.rows < 1 || typeof entry.sha256 !== "string" || !SHA_RE.test(entry.sha256)) throw invalidBackup("Entrada de tabela inválida no manifesto.");
    seen.add(entry.table);
  }
  if (raw.format === 1) {
    return { format: 1, tables, raw, parts: tables.map((t, seq) => ({
      table: t.table, seq, index: 0, key: `${t.table}.ndjson.gz`, rows: t.rows, bytes: null, text_bytes: null,
      sha256: t.sha256, last: true, table_sha256: t.sha256,
    })) };
  }
  if (raw.format !== 2 || !Array.isArray(raw.parts)) throw invalidBackup("Formato de backup desconhecido.");
  const parts: ManifestEntryPart[] = [];
  const byTable = new Map(tables.map(t => [t.table, t]));
  let tableCursor = -1, index = 0, rows = 0;
  const closeTable = () => {
    if (tableCursor < 0) return;
    const table = tables[tableCursor];
    if (rows !== table.rows) throw invalidBackup(`Contagem de linhas das partes não confere: ${table.table}.`);
    parts[parts.length - 1].last = true;
  };
  for (const [seq, part] of (raw.parts as PagedPart[]).entries()) {
    const table = byTable.get(part?.table);
    if (!table || part.seq !== seq || !Number.isSafeInteger(part.rows) || part.rows < 1 || !Number.isSafeInteger(part.bytes) || part.bytes < 1
        || !Number.isSafeInteger(part.text_bytes) || part.text_bytes < 1 || typeof part.sha256 !== "string" || !SHA_RE.test(part.sha256)
        || !Number.isSafeInteger(part.index) || part.key !== `${part.table}.${pad(part.index, 5)}.ndjson.gz`)
      throw invalidBackup("Parte inválida no manifesto.");
    if (tableCursor < 0 || tables[tableCursor].table !== part.table) {
      closeTable();
      tableCursor++;
      if (tables[tableCursor]?.table !== part.table) throw invalidBackup("Partes fora da ordem das tabelas.");
      index = 0; rows = 0;
    }
    if (part.index !== index) throw invalidBackup("Partes fora de ordem.");
    index++; rows += part.rows;
    parts.push({ ...part, last: false, table_sha256: table.sha256 });
  }
  closeTable();
  if (tableCursor !== tables.length - 1) throw invalidBackup("Tabela sem partes no manifesto.");
  return { format: 2, tables, parts, raw };
}

async function fetchManifest(bucket: R2Bucket, prefix: string) {
  const object = await bucket.get(prefix + "manifest.json");
  if (!object) throw new ErpBackupJobError("erp_backup_not_found", "Backup sem manifesto.", 404);
  const text = await object.text();
  return { text, sha: sha256Text(text), view: readManifest(text) };
}

/**
 * Abre uma restauração: lê e valida o manifesto e, numa transação, confere
 * que não há I/O de XML de fato no ar (archiveIoLiveError), grava o trabalho e liga a
 * barreira. O banco ainda não muda.
 */
export async function startRestore(storage: DurableObjectStorage, bucket: R2Bucket, profile: string, prefix: string, options: { now?: () => number; swapLimitBytes?: number; diskLimitBytes?: number } = {}): Promise<BackupJob> {
  if (typeof prefix !== "string" || !/^erp-backups\/[^?#\\]+\/$/.test(prefix) || prefix.includes("/../") || prefix.includes("/./"))
    throw new ErpBackupJobError("erp_backup_invalid", "Informe o prefixo do backup.", 400);
  const current = readBackupJob(storage);
  if (backupJobActive(current)) {
    if (current.kind === "restore" && current.prefix === prefix && current.profile === profile) return current;
    throw new ErpBackupJobError("erp_backup_job_running", current.kind === "backup" ? "Há um backup em andamento nesta área." : "Já há uma restauração em andamento nesta área.");
  }
  const manifest = await fetchManifest(bucket, prefix);
  const textBytes = manifest.view.parts.reduce((sum, part) => sum + (part.text_bytes ?? 0), 0);
  const limit = options.swapLimitBytes ?? ERP_RESTORE_SWAP_LIMIT_BYTES;
  if (textBytes > limit)
    throw new ErpBackupJobError("erp_restore_too_large", `O backup tem ${textBytes} bytes de dados exportados; esta versão restaura pelo caminho lógico até ${limit} bytes. Acima disso, use a recuperação no tempo do objeto da área. Nada foi alterado.`, 413);
  // O estágio fica ao lado dos dados atuais até a troca: tem de caber no disco do objeto.
  const disk = options.diskLimitBytes ?? ERP_OBJECT_DISK_LIMIT_BYTES;
  const databaseBytes = Number(storage.sql.databaseSize ?? 0);
  const needed = restoreDiskNeeded(databaseBytes, textBytes);
  if (needed > disk) {
    const gb = (bytes: number) => (bytes / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " GB";
    throw new ErpBackupJobError("erp_restore_too_large", `A restauração não cabe no disco do ERP desta área: precisa de cerca de ${gb(needed)} (o banco atual tem ${gb(databaseBytes)} e o backup, ${gb(textBytes)} de dados exportados), e o limite é ${gb(disk)}. Nada foi alterado. Para voltar a este ponto, use a recuperação no tempo do objeto da área, ou fale com o suporte.`, 413);
  }
  const now = (options.now ?? Date.now)();
  // Síncrono do teste ao registro: um XML que começasse entre os dois passaria.
  if (!beginArchiveRestore(profile)) throw archiveMemoryBusyError(profile);
  try {
    return storage.transactionSync(() => {
      const again = readBackupJob(storage);
      if (backupJobActive(again)) throw new ErpBackupJobError("erp_backup_job_running", "Já há um trabalho de backup em andamento nesta área.");
      const busy = archiveIoLiveError(storage.sql, now);
      if (busy) throw busy;
      clearJobRows(storage);
      const job: BackupJob = {
        id: crypto.randomUUID(), kind: "restore", phase: "stage", profile, prefix,
        schema_hash: ERP_DDL_HASH, created_at: String(manifest.view.raw.created_at ?? ""), started_at: now, updated_at: now, finished_at: null,
        barrier_until: now + BACKUP_BARRIER_LEASE_MS, barrier_deadline: now + BACKUP_BARRIER_MAX_MS, barrier_released_at: null,
        step: 0, invocations: 0, cursor: { ...emptyCursor(), manifest_sha: manifest.sha },
        progress: { tables_total: manifest.view.tables.length, tables_done: 0, rows_total: manifest.view.tables.reduce((s, t) => s + t.rows, 0), rows_done: 0,
          parts_total: manifest.view.parts.length, parts_done: 0, bytes: 0, text_bytes: 0 },
        external_objects: (manifest.view.raw.external_objects as Record<string, unknown> | undefined) ?? null, result: null, error: null,
      };
      writeBackupJob(storage, job);
      return job;
    });
  } finally { endArchiveRestore(profile); }
}

/** Confirma uma unidade: só se o trabalho gravado é o mesmo e não andou (troca condicional). */
function commit(storage: DurableObjectStorage, job: BackupJob, now: number, apply: (next: BackupJob) => void, renew = true): BackupJob {
  return storage.transactionSync(() => {
    const saved = readBackupJob(storage);
    if (!saved || saved.id !== job.id || saved.step !== job.step || saved.phase !== job.phase)
      throw new ErpBackupJobError("erp_backup_job_moved", "O trabalho de backup mudou durante a unidade.");
    const next: BackupJob = structuredClone(saved);
    next.step++;
    next.updated_at = now;
    // Só progresso renova a barreira (uma unidade confirmada).
    if (renew && next.barrier_until > 0) next.barrier_until = Math.min(now + BACKUP_BARRIER_LEASE_MS, next.barrier_deadline);
    apply(next);
    writeBackupJob(storage, next);
    return next;
  });
}

/** O trabalho falha: a barreira cai já (o retrato não vale mais) e a limpeza segue. */
function fail(storage: DurableObjectStorage, job: BackupJob, now: number, error: BackupJobError): BackupJob {
  return commit(storage, job, now, next => {
    next.phase = "cleanup"; next.error = error;
    if (next.barrier_until > 0) { next.barrier_until = 0; next.barrier_released_at = now; }
  }, false);
}

/** Uma parte do backup: lê páginas da tabela atual até ~1 MiB, comprime, envia e confirma. */
async function exportUnit(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, now: () => number, hooks: BackupHooks): Promise<BackupJob> {
  const c = job.cursor;
  // Tabelas que terminam nesta unidade sem parte nova (vazias, ou no fim de
  // uma página cheia): fecham no mesmo commit da próxima parte.
  const finished: { index: number; table: string; rows: number; sha256: string }[] = [];
  let index = c.table_index, after = c.after_rowid, tablePart = c.table_part, tableRows = c.table_rows, tableState = c.table_sha;
  let produced: { table: string; header: string; lines: string[]; ended: boolean } | null = null;
  while (index < DUMP_TABLES.length) {
    const table = DUMP_TABLES[index];
    const { cols, values, filter } = tablePlan(storage.sql, table);
    const select = values.map((value, i) => `${value} AS ${q(cols[i].name)}`).join(",");
    const lines: string[] = [];
    let size = 0, ended = false;
    while (size < BACKUP_PART_TARGET_BYTES) {
      const where = after === null ? filter : `${filter ? filter + " AND" : " WHERE"} rowid > CAST(? AS INTEGER)`;
      const params = after === null ? [BACKUP_PAGE_ROWS] : [after, BACKUP_PAGE_ROWS];
      let read = 0, full = false;
      for (const row of storage.sql.exec(`SELECT CAST(rowid AS TEXT) AS "__wb_rowid",${select} FROM ${q(table)}${where} ORDER BY rowid LIMIT ?`, ...params).raw()) {
        const record = row as unknown[];
        after = String(record[0]);
        const line = JSON.stringify(record.slice(1));
        lines.push(line);
        size += line.length + 1;
        read++;
        // Parte cheia no meio da página: para aqui; a próxima continua deste rowid.
        if (size >= BACKUP_PART_TARGET_BYTES) { full = true; break; }
      }
      if (full) break;
      if (read < BACKUP_PAGE_ROWS) { ended = true; break; }
    }
    if (lines.length) { produced = { table, header: JSON.stringify(cols.map(col => col.name)), lines, ended }; break; }
    if (tableRows) finished.push({ index, table, rows: tableRows, sha256: new Sha256(tableState).digest() });
    index++; after = null; tablePart = 0; tableRows = 0; tableState = null;
  }
  const close = (next: BackupJob) => {
    for (const t of finished) putMeta(storage, tableRowKey(t.index), JSON.stringify({ table: t.table, rows: t.rows, sha256: t.sha256 }));
    next.progress.tables_done += index - c.table_index;
  };
  if (!produced) {
    // Fim da última tabela: a barreira cai aqui; o manifesto vem do que já está gravado.
    return commit(storage, job, now(), next => {
      close(next);
      next.cursor = { ...next.cursor, table_index: index, after_rowid: null, table_part: 0, table_rows: 0, table_sha: null, table_header: null };
      next.phase = "publish"; next.barrier_until = 0; next.barrier_released_at = now();
      next.progress.parts_total = next.progress.parts_done;
    });
  }
  const { table, header, lines, ended } = produced;
  const body = header + "\n" + lines.join("\n") + "\n";
  const tableSha = new Sha256(tableState);
  tableSha.update(tablePart === 0 ? body : body.slice(header.length + 1));
  const part: PagedPart = {
    table, seq: c.part_seq, index: tablePart, key: `${table}.${pad(tablePart, 5)}.ndjson.gz`,
    rows: lines.length, bytes: 0, text_bytes: utf8Length(body), sha256: sha256Text(body),
  };
  const gz = await gzipText(body);
  part.bytes = gz.byteLength;
  // Mesma chave na retomada: uma parte órfã de uma queda é sobrescrita, não duplicada.
  await bucket.put(job.prefix + part.key, gz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { sha256: part.sha256, rows: String(part.rows), job: job.id },
  });
  await hooks.at?.("export:after-put", job);
  return commit(storage, job, now(), next => {
    close(next);
    putMeta(storage, partRowKey(part.seq), JSON.stringify(part));
    next.progress.parts_done++;
    next.progress.rows_done += part.rows;
    next.progress.bytes += part.bytes;
    next.progress.text_bytes += part.text_bytes;
    next.cursor = { ...next.cursor, table_index: index, after_rowid: after, table_part: tablePart + 1, table_rows: tableRows + part.rows,
      table_sha: tableSha.state(), table_header: header, part_seq: c.part_seq + 1 };
    if (ended) {
      putMeta(storage, tableRowKey(index), JSON.stringify({ table, rows: tableRows + part.rows, sha256: tableSha.digest() }));
      next.progress.tables_done++;
      next.cursor = { ...next.cursor, table_index: index + 1, after_rowid: null, table_part: 0, table_rows: 0, table_sha: null, table_header: null };
    }
  });
}

function rowsWithPrefix<T>(storage: DurableObjectStorage, prefix: string): T[] {
  return (storage.sql.exec("SELECT value FROM erp_meta WHERE key >= ? AND key < ? ORDER BY key", prefix, prefixEnd(prefix)).toArray() as { value: string }[])
    .map(row => JSON.parse(row.value) as T);
}

function buildManifest(storage: DurableObjectStorage, job: BackupJob, restoreLimit: number): PagedManifest {
  const tables = rowsWithPrefix<PagedManifest["tables"][number]>(storage, TABLE_KEY);
  const parts = rowsWithPrefix<PagedPart>(storage, PART_KEY);
  const textBytes = parts.reduce((s, p) => s + p.text_bytes, 0);
  return {
    format: 2, schema_version: ERP_DDL_VERSION, schema_hash: job.schema_hash, created_at: job.created_at,
    tables, parts,
    totals: { tables: tables.length, rows: tables.reduce((s, t) => s + t.rows, 0), parts: parts.length,
      bytes: parts.reduce((s, p) => s + p.bytes, 0), text_bytes: textBytes },
    external_objects: job.external_objects ?? externalObjects(storage),
    job: { id: job.id, started_at: job.started_at, barrier_held_ms: Math.max(0, (job.barrier_released_at ?? job.updated_at) - job.started_at), invocations: job.invocations },
    logical_restore: logicalRestoreCoverage(textBytes, restoreLimit),
  };
}

async function publishUnit(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, now: () => number, hooks: BackupHooks, restoreLimit: number) {
  const manifest = buildManifest(storage, job, restoreLimit);
  const coverage = manifest.logical_restore!;
  // Os totais vão também nos metadados: a lista de backups da tela lê só o cabeçalho do objeto.
  await bucket.put(job.prefix + "manifest.json", JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" },
    customMetadata: { format: "2", created_at: manifest.created_at, rows: String(manifest.totals.rows), bytes: String(manifest.totals.bytes),
      text_bytes: String(manifest.totals.text_bytes), tables: String(manifest.totals.tables), schema_hash: manifest.schema_hash } });
  await hooks.at?.("publish:after-put", job);
  const done = commit(storage, job, now(), next => {
    next.phase = "done"; next.finished_at = now();
    const result: Record<string, unknown> = { prefix: job.prefix, bytes: manifest.totals.bytes, text_bytes: manifest.totals.text_bytes,
      tables: manifest.totals.tables, rows: manifest.totals.rows, parts: manifest.totals.parts, logical_restore: coverage };
    // O backup sai em qualquer tamanho; acima do teto, quem pediu fica sabendo como voltar a este ponto.
    if (coverage.exceeds_limit) result.warning = logicalRestoreWarning(manifest.totals.text_bytes, coverage.limit_bytes);
    next.result = result;
    clearJobRows(storage);
  });
  return { job: done, manifest };
}

/** Lê o NDJSON de uma parte em fluxo: hash, contagem e estágio em pedaços, sem montar o texto inteiro. */
async function stageUnit(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, view: ManifestView, now: () => number, hooks: BackupHooks): Promise<BackupJob> {
  const seq = job.cursor.part_seq;
  if (seq >= view.parts.length) {
    return commit(storage, job, now(), next => { next.phase = "swap"; });
  }
  const part = view.parts[seq];
  // Resto de uma queda no meio desta parte: recomeça a parte do zero.
  storage.sql.exec("DELETE FROM erp_meta WHERE key >= ? AND key < ?", stagePrefix(seq), prefixEnd(stagePrefix(seq)));
  const object = await bucket.get(job.prefix + part.key);
  if (!object) return fail(storage, job, now(), { code: "erp_backup_part_missing", message: `Backup sem a parte ${part.key}.` });
  if (part.bytes !== null && object.size !== part.bytes) {
    try { await object.body?.cancel(); } catch { /* Sem leitura. */ }
    return fail(storage, job, now(), { code: "erp_backup_part_corrupt", message: `Parte com tamanho diferente do manifesto: ${part.key}.` });
  }
  const first = part.index === 0;
  const tableSha = new Sha256(first ? null : job.cursor.table_sha);
  const partSha = createHash("sha256");
  const decoder = new TextDecoder();
  const reader = object.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  let newlines = 0, textBytes = 0, chunk = 0, pending = "", headerDone = false, header = "";
  const headerDecoder = new TextDecoder();
  const limit = part.text_bytes ?? Number.MAX_SAFE_INTEGER;
  const flush = (force: boolean) => {
    while (pending.length >= RESTORE_STAGE_CHUNK_CHARS || (force && pending.length)) {
      const piece = pending.slice(0, RESTORE_STAGE_CHUNK_CHARS);
      pending = pending.slice(piece.length);
      putMeta(storage, stageKey(seq, chunk++), piece);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      textBytes += value.byteLength;
      if (textBytes > limit) return fail(storage, job, now(), { code: "erp_backup_part_corrupt", message: `Parte maior que o manifesto: ${part.key}.` });
      partSha.update(value);
      let start = 0;
      const headerWasDone = headerDone;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== 10) continue;
        newlines++;
        if (!headerDone) { headerDone = true; start = i + 1; }
      }
      if (!headerWasDone) {
        header += headerDecoder.decode(headerDone ? value.subarray(0, start - 1) : value, { stream: !headerDone });
        if (header.length > 1024 * 1024) return fail(storage, job, now(), { code: "erp_backup_part_corrupt", message: `Cabeçalho inválido na parte ${part.key}.` });
      }
      // Hash da tabela: a primeira parte inteira; nas seguintes, sem o cabeçalho repetido.
      if (first) tableSha.update(value);
      else if (headerDone && start < value.length) tableSha.update(value.subarray(start));
      pending += decoder.decode(value, { stream: true });
      flush(false);
    }
  } finally { try { await reader.cancel(); } catch { /* Já encerrado. */ } }
  pending += decoder.decode();
  flush(true);
  const corrupt = (message: string) => fail(storage, job, now(), { code: "erp_backup_part_corrupt", message });
  if (partSha.digest("hex") !== part.sha256) return corrupt(`Hash da parte não confere: ${part.key}.`);
  if (newlines !== part.rows + 1) return corrupt(`Contagem de linhas da parte não confere: ${part.key}.`);
  if (!first && header !== job.cursor.table_header) return corrupt(`Cabeçalho da parte não confere: ${part.key}.`);
  if (part.last && tableSha.digest() !== part.table_sha256) return corrupt(`Hash da tabela não confere: ${part.table}.`);
  await hooks.at?.("stage:after-chunks", job);
  return commit(storage, job, now(), next => {
    next.progress.parts_done++;
    next.progress.rows_done += part.rows;
    next.progress.bytes += object.size;
    next.progress.text_bytes += textBytes;
    if (part.last) next.progress.tables_done++;
    next.cursor = { ...next.cursor, part_seq: seq + 1, table_sha: part.last ? null : tableSha.state(), table_header: part.last ? null : header };
  });
}

/**
 * Começo da troca. Se uma troca anterior deste trabalho voltou à marca (o
 * registro no R2 diz), o banco já está como antes: o trabalho termina como
 * falho. Senão: grava a marca da recuperação no tempo e, na primeira
 * transação da troca, confere XML no ar, guarda o controle da coleta e os
 * gatilhos e tira os gatilhos. Sem marca disponível a troca não começa.
 */
async function startSwap(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, plan: SwapGroup[], now: () => number, hooks: BackupHooks, bookmarks: RestoreBookmarks | null): Promise<BackupJob> {
  await hooks.at?.("swap:before", job);
  const marker = await bucket.get(restoreRollbackKey(job));
  if (marker) {
    const saved = await marker.json<{ error?: BackupJobError | null }>().catch(() => null);
    const error = saved?.error ?? { code: "erp_restore_failed", message: "A restauração não terminou." };
    return fail(storage, job, now(), { code: error.code, message: `${error.message} O ERP desta área voltou ao estado de antes da restauração.`.slice(0, 600) });
  }
  // Ainda sem troca (banco intacto): sem progresso dentro do prazo, a barreira já caiu.
  if (now() > job.barrier_until || now() > job.barrier_deadline)
    return fail(storage, job, now(), { code: "erp_backup_expired", message: "O prazo da barreira de escrita acabou antes do fim; o trabalho foi descartado." });
  if (!bookmarks)
    return fail(storage, job, now(), { code: "erp_restore_no_rollback", message: "Este ambiente não oferece a recuperação no tempo do objeto, que a restauração usa para voltar atrás se algo der errado. A troca não começou e nada foi alterado." });
  const bookmark = await bookmarks.current();
  // XML em voo nesta instância: a troca não começa (o trabalho falha sem mudar o banco).
  if (!beginArchiveRestore(job.profile)) return fail(storage, job, now(), { code: "erp_restore_archive_busy", message: archiveMemoryBusyError(job.profile).message });
  try {
    return commit(storage, job, now(), next => {
      storage.sql.exec("PRAGMA defer_foreign_keys = ON");
      const { control, triggers } = beginRestoreSwap(storage.sql, now());
      saveTriggers(storage.sql, triggers);
      const swap = initialSwapCursor(plan, bookmark, now(), control);
      next.cursor.swap = swap;
      next.barrier_deadline = Math.max(next.barrier_deadline, swap.deadline);
    });
  } catch (error) {
    // A transação foi desfeita: o banco está como antes.
    if (error instanceof ErpRestoreBusyError) return fail(storage, job, now(), { code: error.code, message: error.message });
    throw error;
  } finally { endArchiveRestore(job.profile); }
}

/**
 * Uma transação pequena da troca. Falhou por uma referência da própria
 * tabela que caiu fora da faixa, a mesma transação cresce até fechá-la; outro
 * erro sobe e o trabalho volta à marca.
 */
function swapStep(storage: DurableObjectStorage, job: BackupJob, view: ManifestView, plan: SwapGroup[], now: () => number, txnBytes = RESTORE_SWAP_TXN_BYTES): { job: BackupJob; finished: boolean } {
  const partsByTable = new Map<string, number[]>();
  for (const part of view.parts) partsByTable.set(part.table, [...(partsByTable.get(part.table) ?? []), part.seq]);
  const ctx: SwapContext = { plan, tables: view.tables, partsByTable, profile: job.profile, budget: txnBytes };
  // XML em voo nesta instância (não deveria haver: a área está parada): não grava nada.
  if (!beginArchiveRestore(job.profile)) throw archiveMemoryBusyError(job.profile);
  try {
    for (;;) {
      let finished = false;
      try {
        const done = commit(storage, job, now(), next => {
          finished = swapUnit(storage, next, ctx);
          if (!finished) return;
          if (next.cursor.swap!.rows_done !== job.progress.rows_total)
            throw new ErpRestoreCheckError("A conferência final não bateu: a contagem restaurada difere do manifesto.");
          const rows = next.cursor.swap!.rows_done;
          clearJobRows(storage);
          next.phase = "done"; next.finished_at = now(); next.barrier_until = 0; next.barrier_released_at = now();
          next.result = { tables: view.tables.length, rows };
        });
        return { job: done, finished };
      } catch (error) {
        const step = job.cursor.swap?.step;
        if (isForeignKeyError(error) && (step === "delete" || step === "insert") && ctx.budget < RESTORE_SWAP_GROW_MAX_BYTES) { ctx.budget *= 2; continue; }
        throw error;
      }
    }
  } finally { endArchiveRestore(job.profile); }
}

/**
 * A troca não pode terminar: registra o motivo no R2 (a volta desfaz o
 * estado do objeto), pede a volta à marca e reinicia o objeto. Ao acordar,
 * o banco está como antes da troca e o trabalho termina como falho. Se a volta
 * não se confirmar (o trabalho acorda ainda em "rollback"), pede de novo; a
 * área continua parada, nunca atende meio restaurada.
 */
async function rollbackUnit(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, now: () => number, bookmarks: RestoreBookmarks | null, error: BackupJobError | null): Promise<never> {
  const marked = commit(storage, job, now(), next => {
    next.phase = "rollback";
    if (error) next.error = error;
    next.cursor.swap!.rollbacks++;
  }, false);
  await bucket.put(restoreRollbackKey(marked), JSON.stringify({ job: marked.id, prefix: marked.prefix, error: marked.error, at: now() }),
    { httpMetadata: { contentType: "application/json" } });
  if (!bookmarks) throw new ErpBackupJobError("erp_restore_no_rollback", "A restauração não terminou e este ambiente não oferece a recuperação no tempo do objeto. O ERP da área continua parado; fale com o suporte.", 503);
  await bookmarks.restoreOnNextSession(marked.cursor.swap!.bookmark);
  throw new ErpRestoreRestartError();
}

const swapErrorCode = (error: unknown) =>
  error instanceof ErpRestoreCheckError || error instanceof ErpRestoreBusyError || error instanceof ErpBackupJobError ? error.code : "erp_restore_failed";

/** Limpeza de um trabalho que falhou: partes órfãs no R2 (backup) e estágio (restauração), em lotes. */
async function cleanupUnit(storage: DurableObjectStorage, bucket: R2Bucket, job: BackupJob, now: () => number, hooks: BackupHooks): Promise<BackupJob> {
  if (job.kind === "backup") {
    const listed = await bucket.list({ prefix: job.prefix, limit: 1000 });
    const keys = listed.objects.map(o => o.key);
    if (keys.length) {
      await bucket.delete(keys);
      await hooks.at?.("cleanup:after-delete", job);
      return commit(storage, job, now(), () => {});
    }
  }
  const removed = clearJobRows(storage, 2000);
  if (removed) return commit(storage, job, now(), () => {});
  return commit(storage, job, now(), next => {
    next.phase = "failed"; next.finished_at = now(); next.barrier_until = 0; next.barrier_released_at ??= now();
  });
}

export interface BackupRunResult {
  job: BackupJob | null;
  /** Manifesto publicado nesta invocação (o backup terminou aqui). */
  manifest?: PagedManifest;
  /** Ainda há trabalho: agendar outra invocação. */
  more: boolean;
}

/**
 * Avança o trabalho da área por unidades, até terminar ou acabar o orçamento
 * desta invocação. Uma execução por objeto; a outra devolve o estado.
 */
export async function runBackupJob(storage: DurableObjectStorage, bucket: R2Bucket, options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const active = running.get(storage);
  if (active) { const job = readBackupJob(storage); return { job, more: backupJobActive(job) }; }
  const work = drive(storage, bucket, options);
  running.set(storage, work);
  try { return await work; } finally { running.delete(storage); }
}

async function drive(storage: DurableObjectStorage, bucket: R2Bucket, options: BackupRunOptions): Promise<BackupRunResult> {
  const now = options.now ?? Date.now, hooks = options.hooks ?? {};
  const started = now(), budget = options.budgetMs ?? 10_000, maxUnits = options.maxUnits ?? 400;
  const bookmarks = options.bookmarks === undefined ? storageBookmarks(storage) : options.bookmarks;
  let job = readBackupJob(storage);
  if (!backupJobActive(job)) return { job, more: false };
  // Contar a invocação não é progresso: não renova a barreira. Na troca, uma
  // invocação que começa no mesmo ponto da anterior conta como erro repetido.
  const before = job.step;
  job = commit(storage, job, now(), next => {
    next.invocations++;
    const swap = next.cursor.swap;
    if (next.phase === "swap" && swap) {
      swap.stalls = swap.stall_step === before ? swap.stalls + 1 : 0;
      swap.stall_step = next.step;
    }
  }, false);
  let manifest: PagedManifest | undefined;
  // Restauração: o manifesto é lido uma vez por invocação e tem de ser o mesmo do início.
  let view: ManifestView | null = null, plan: SwapGroup[] | null = null;
  const restoreManifest = async (current: BackupJob) => {
    if (view) return view;
    const fetched = await fetchManifest(bucket, current.prefix);
    if (fetched.sha !== current.cursor.manifest_sha) throw new ErpBackupJobError("erp_backup_invalid", "O manifesto do backup mudou durante a restauração.", 422);
    return view = fetched.view;
  };
  const swapPlan = () => plan ??= restorePlan(storage.sql);
  // Erro de uma transação da troca (dado, FK, conferência): volta à marca. Outro erro na troca (R2 fora) tenta de novo.
  let swapError: unknown = null;
  for (let units = 0; backupJobActive(job) && units < maxUnits && now() - started < budget; units++) {
    const at = now();
    // Troca começada: o banco pode estar incoerente; qualquer saída que não seja o fim volta à marca.
    const swapping = job.phase === "swap" && !!job.cursor.swap;
    if (job.phase === "rollback") await rollbackUnit(storage, bucket, job, now, bookmarks, null);
    if (swapping) {
      const swap = job.cursor.swap!;
      const reason: BackupJobError | null = at > swap.deadline ? { code: "erp_restore_expired", message: "A troca da restauração passou do prazo." }
        : swap.stalls >= RESTORE_SWAP_MAX_STALLS ? { code: "erp_restore_failed", message: "A troca da restauração parou no mesmo ponto em várias tentativas seguidas." }
          : job.schema_hash !== ERP_DDL_HASH ? { code: "erp_backup_schema_changed", message: "O esquema do ERP mudou durante a restauração." } : null;
      if (reason) await rollbackUnit(storage, bucket, job, now, bookmarks, reason);
    } else if ((job.phase === "export" || job.phase === "stage") && (at > job.barrier_until || at > job.barrier_deadline)) {
      // Sem progresso dentro do prazo, a barreira já caiu: o retrato não vale mais.
      job = fail(storage, job, at, { code: "erp_backup_expired", message: "O prazo da barreira de escrita acabou antes do fim; o trabalho foi descartado." });
      continue;
    }
    if (!swapping && job.schema_hash !== ERP_DDL_HASH && job.phase !== "cleanup") {
      job = fail(storage, job, at, { code: "erp_backup_schema_changed", message: "O esquema do ERP mudou durante o trabalho." });
      continue;
    }
    try {
      if (job.phase === "export") job = await exportUnit(storage, bucket, job, now, hooks);
      else if (job.phase === "publish") ({ job, manifest } = await publishUnit(storage, bucket, job, now, hooks, options.swapLimitBytes ?? ERP_RESTORE_SWAP_LIMIT_BYTES));
      else if (job.phase === "stage") job = await stageUnit(storage, bucket, job, await restoreManifest(job), now, hooks);
      else if (job.phase === "swap" && !job.cursor.swap) job = await startSwap(storage, bucket, job, swapPlan(), now, hooks, bookmarks);
      else if (job.phase === "swap") {
        const parts = await restoreManifest(job);
        let step;
        try { step = swapStep(storage, job, parts, swapPlan(), now, options.swapTxnBytes); }
        catch (error) { swapError = error; throw error; }
        job = step.job;
        await hooks.at?.(step.finished ? "swap:after" : "swap:unit", job);
      } else if (job.phase === "cleanup") job = await cleanupUnit(storage, bucket, job, now, hooks);
    } catch (error) {
      if (error instanceof ErpBackupJobError && error.code === "erp_backup_job_moved") return { job: readBackupJob(storage), more: true };
      if (error instanceof ErpRestoreRestartError) throw error;
      // Erro de dado (parte, FK): o trabalho falha e limpa; na troca, volta
      // à marca. Erro de infraestrutura (R2 fora, queda): o estado durável
      // fica e a próxima invocação retoma do checkpoint.
      const saved = readBackupJob(storage);
      if (!saved || saved.id !== job.id || !backupJobActive(saved)) throw error;
      if (saved.phase === "swap" && saved.cursor.swap && (error === swapError || error instanceof ErpBackupJobError || error instanceof ErpRestoreBusyError)) {
        const detail = error instanceof Error ? error.message : String(error);
        await rollbackUnit(storage, bucket, saved, now, bookmarks, { code: swapErrorCode(error), message: `A troca da restauração falhou: ${detail}`.slice(0, 400) });
      }
      if (error instanceof ErpBackupJobError || error instanceof ErpRestoreBusyError) {
        job = fail(storage, saved, now(), { code: error.code, message: error.message.slice(0, 300) });
        continue;
      }
      throw error;
    }
  }
  return { job, manifest, more: backupJobActive(job) };
}

export { backupJobStatus, readBackupJob };
export const PAGED_BACKUP_TABLES: readonly string[] = DUMP_TABLES;
export const PAGED_RESTORE_TABLES: readonly string[] = ALL_TABLES;
