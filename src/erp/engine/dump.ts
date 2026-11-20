// Backup lógico do ERP: uma tabela por arquivo NDJSON (primeira linha: as
// colunas; depois uma linha por registro, com todo inteiro como texto exato),
// gzip, no R2 em erp-backups/<área>/<instante>/, e um manifesto com a versão
// do esquema e, por tabela, linhas e SHA-256 do NDJSON. Fase 0, prova 8.
//
// Este é o caminho na memória (formato 1): o dump é lido de forma síncrona
// numa invocação só e é um retrato consistente. Serve aos testes e a bancos
// pequenos. As rotas /erp-backup e /erp-restore usam o caminho em páginas
// (engine/backup-pages.ts, formato 2), que lê, grava e restaura em partes,
// com barreira de escrita e checkpoint durável, sem o teto de 16 MiB (a
// restauração tem o teto da troca, ERP_RESTORE_SWAP_LIMIT_BYTES; o backup sai
// em qualquer tamanho e declara se passa dele).
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ERP_TABLES } from "../schema/columns.generated.ts";
import { ERP_ENGINE_TABLES } from "../schema/engine-tables.ts";

/** Tabelas do retrato: as do esquema gerado e as só do motor (schema/engine-tables.ts). */
export const ALL_TABLES: readonly string[] = [...Object.keys(ERP_TABLES), ...ERP_ENGINE_TABLES.map((t) => t.table)];
/** Nunca exportar o cofre legado ou um estado transitório de autorização. */
const AUTHORIZATION_TABLES = new Set(["origin_sync__credentials", "origin_sync__oauth_state"]);
export const DUMP_TABLES = ALL_TABLES.filter(table => !AUTHORIZATION_TABLES.has(table));
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../schema/ddl.ts";
import { archiveRestoreActive, hasPendingXmlObjectDelete } from "../bling/xml.ts";

export const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Bytes UTF-8 sem copiar o texto (o retrato inteiro já está na memória). */
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Teto do caminho na memória (dumpAll/readBackup), em bytes de NDJSON (o texto
 * exportado, antes do gzip). Nesse caminho o retrato inteiro é materializado
 * no isolado de 128 MB: as linhas da maior tabela, todos os corpos NDJSON e o
 * gzip de um arquivo coexistem; acima disto ele falha cedo, antes de
 * materializar ou de publicar manifesto. As rotas não usam mais este caminho:
 * o backup em páginas (engine/backup-pages.ts) não tem este teto. Backup e
 * leitura medem em bytes UTF-8 do NDJSON: dumpAll confere os bytes reais.
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
/** O que ocupa o acervo de XML da área e impede a restauração de começar. */
export type ErpRestoreBusyReason = "delete" | "xml" | "restore";
const BUSY_TEXT: Record<ErpRestoreBusyReason, { what: string; wait: string }> = {
  delete: { what: "uma exclusão de XML do acervo no armazenamento de arquivos", wait: "Espere a coleta do Bling em curso terminar esse passo (leva segundos; no máximo, o prazo de posse do passo mais um minuto)" },
  xml: { what: "uma busca ou gravação de XML do acervo pela coleta do Bling", wait: "Espere a coleta do Bling em curso terminar esse passo (leva segundos; no máximo, o prazo de posse do passo mais um minuto)" },
  restore: { what: "outra restauração", wait: "Espere a restauração em curso terminar" },
};
/** Exclusão ou gravação de XML do acervo de fato no ar (ou outra restauração). */
export class ErpRestoreBusyError extends Error {
  readonly code = "erp_restore_archive_busy";
  readonly reason: ErpRestoreBusyReason;
  constructor(reason: ErpRestoreBusyReason = "xml") {
    const text = BUSY_TEXT[reason];
    super(`A restauração não começou: há ${text.what} em andamento nesta área. ${text.wait} e tente de novo; nada foi alterado.`);
    this.name = "ErpRestoreBusyError";
    this.reason = reason;
  }
}
/** A recusa por I/O vivo na memória desta instância (ou por outra restauração). */
export function archiveMemoryBusyError(profile: string): ErpRestoreBusyError {
  if (archiveRestoreActive(profile)) return new ErpRestoreBusyError("restore");
  return new ErpRestoreBusyError(hasPendingXmlObjectDelete(profile) ? "delete" : "xml");
}
/**
 * Margem sobre o prazo de posse gravado: uma unidade cuja posse venceu há
 * menos que isto ainda conta como no ar (relógio e término tardio do passo).
 */
export const ARCHIVE_IO_LEASE_MARGIN_MS = 60_000;
/**
 * Durável: o I/O de arquivo que pode estar de fato no ar, isto é, uma unidade
 * com dono e posse ainda viva (com a margem): exclusão no R2 (r2_delete) ou
 * passo de XML na fase de busca/gravação (xml_* em 'fetching'). Unidade em
 * espera, com progresso ou erro gravados, não tem envio em curso e não trava:
 * a troca de revisão da restauração a aposenta. Quem caiu no meio deixa a
 * posse vencer e deixa de travar. O que está só na memória (chamada viva além
 * do prazo da posse) é conferido pela instância (beginArchiveRestore).
 * Parâmetro: o instante de agora (ms).
 */
export const ARCHIVE_IO_LIVE = `SELECT CASE WHEN kind='r2_delete' THEN 'delete' ELSE 'xml' END AS reason FROM wb_bling_unit
  WHERE phase NOT IN ('committed','superseded') AND owner IS NOT NULL AND lease_until > ?
    AND (kind='r2_delete' OR (substr(kind,1,4)='xml_' AND phase='fetching'))
  ORDER BY kind='r2_delete' DESC LIMIT 1`;
/** I/O de XML no ar segundo o banco, ou nulo. */
export function archiveIoLiveError(sql: SqlStorage, now: number): ErpRestoreBusyError | null {
  const row = sql.exec(ARCHIVE_IO_LIVE, now - ARCHIVE_IO_LEASE_MARGIN_MS).toArray()[0] as { reason?: ErpRestoreBusyReason } | undefined;
  return row ? new ErpRestoreBusyError(row.reason === "delete" ? "delete" : "xml") : null;
}

export interface DumpManifest {
  format: 1;
  schema_version: number;
  schema_hash: string;
  created_at: string;
  tables: { table: string; rows: number; sha256: string }[];
}

/** Colunas da tabela no objeto (inclusive as normalizadas pelo motor). */
export function columns(sql: SqlStorage, table: string) {
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
export function tablePlan(sql: SqlStorage, table: string) {
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
 * Tamanho do NDJSON do retrato em bytes UTF-8 (a mesma unidade de
 * readBackup), somado pelo SQLite tabela a tabela, sem trazer linhas ao
 * isolado. Conta os bytes de cada valor (nulo como "null"), aspas,
 * separadores e o escape de aspas e barras; não conta escape de caracteres de
 * controle, por isso é só a recusa cedo: dumpAll confere os bytes reais antes
 * de devolver o retrato. Para no primeiro total acima do teto.
 */
export function measureDump(storage: DurableObjectStorage, limit = ERP_LOGICAL_BACKUP_LIMIT_BYTES): number {
  const sql = storage.sql;
  let total = 0;
  for (const table of DUMP_TABLES) {
    const { cols, values, filter } = tablePlan(sql, table);
    const bytes = (text: string) => `length(CAST(${text} AS BLOB))`;
    const sizes = values.map(value => {
      const text = `CAST(${value} AS TEXT)`;
      return `coalesce(2*${bytes(text)}-${bytes(`replace(replace(${text},'"',''),'\\','')`)},4)`;
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
  // Bytes reais (UTF-8, com todo escape), contados como readBackup conta:
  // nunca sai um retrato que a restauração recusaria por tamanho.
  let bytes = 0;
  for (const table of DUMP_TABLES) {
    const { cols, values, filter } = tablePlan(sql, table);
    const select = values.map((value, index) => `${value} AS ${q(cols[index].name)}`).join(",");
    const rows: unknown[][] = Array.from(sql.exec(`SELECT ${select} FROM ${q(table)}${filter} ORDER BY rowid`).raw());
    if (!rows.length) continue;
    const body = [JSON.stringify(cols.map((c) => c.name)), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
    bytes += utf8Bytes(body);
    if (bytes > limit) throw new ErpBackupTooLargeError(limit);
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
  options: { profile?: string; now?: number } = {},
) {
  if (manifest.schema_hash !== ERP_DDL_HASH)
    throw new Error(`Backup de outro esquema (${manifest.schema_hash}); este é ${ERP_DDL_HASH}.`);
  const allowed = new Set(DUMP_TABLES);
  const seen = new Set<string>();
  for (const entry of manifest.tables) {
    if (!allowed.has(entry.table) || seen.has(entry.table)) throw new Error("Tabela não permitida no backup.");
    seen.add(entry.table);
  }
  let rows = 0;
  storage.transactionSync(() => {
    rows = applyRestoreInTransaction(storage, manifest.tables.map(t => ({
      table: t.table,
      lines: () => {
        const body = files.get(t.table);
        if (body === undefined || sha(body) !== t.sha256) throw new Error(`Arquivo do backup corrompido: ${t.table}`);
        return body.trimEnd().split("\n");
      },
    })), options);
  });
  return { tables: manifest.tables.length, rows };
}

/** Linhas por INSERT na troca, e caracteres de JSON por parâmetro (abaixo do limite de 2 MB por valor do SQLite do objeto). */
const RESTORE_BATCH_ROWS = 500;
const RESTORE_BATCH_CHARS = 512 * 1024;

/** Uma tabela do retrato lida em fluxo: a primeira linha é o cabeçalho (colunas JSON). */
export interface RestoreTableSource {
  table: string;
  lines: () => Iterable<string>;
}

/**
 * A troca do conteúdo, comum ao caminho na memória (restoreAll) e ao em
 * páginas (backup-pages.ts). Tem de rodar dentro de storage.transactionSync:
 * qualquer erro desfaz tudo (o banco fica como estava). As linhas chegam por
 * iterador, em lotes de até 100 parâmetros; nada exige o retrato inteiro na
 * memória. Devolve o número de linhas inseridas.
 */
export function applyRestoreInTransaction(storage: DurableObjectStorage, tables: Iterable<RestoreTableSource>, options: { profile?: string; now?: number } = {}): number {
  const sql = storage.sql;
  let rows = 0;
  {
    // Um DELETE/PUT de XML no ar pode terminar depois da troca e apagar um
    // arquivo que o retrato volta a referenciar: não começar.
    const busy = archiveIoLiveError(sql, options.now ?? Date.now());
    if (busy) throw busy;
    sql.exec("PRAGMA defer_foreign_keys = ON");
    const previousControl = sql.exec("SELECT revision,authorization_revision,credential_revision,updated_at FROM wb_bling_control WHERE id=1").toArray()[0];
    const triggers = sql
      .exec("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .toArray() as { name: string; sql: string }[];
    for (const g of triggers) sql.exec(`DROP TRIGGER ${q(g.name)}`);
    // Tabelas que já têm linhas (semeadura) e não estão no backup ficam vazias.
    for (const table of ALL_TABLES) sql.exec(`DELETE FROM ${q(table)}`);
    for (const t of tables) {
      let cols: string[] | null = null, blobs = new Set<string>(), fromJson = "";
      // As linhas vão ao SQLite como um arranjo JSON (json_each): o parse é do
      // SQLite, não do isolado. Os valores exportados são texto ou nulo (todo
      // inteiro sai como texto exato), e o json_extract devolve o mesmo texto
      // que o bind devolveria; a coluna STRICT converte como antes. Cada linha
      // precisa ter exatamente uma posição por coluna.
      let batch: string[] = [], batchChars = 0;
      const flush = () => {
        if (!batch.length || !cols) return;
        sql.exec(fromJson, "[" + batch.join(",") + "]");
        const inserted = Number((sql.exec("SELECT changes() AS n").toArray()[0] as { n: unknown }).n);
        if (inserted !== batch.length) throw new Error(`Linha do backup com colunas a mais ou a menos: ${t.table}`);
        rows += batch.length;
        batch = []; batchChars = 0;
      };
      for (const line of t.lines()) {
        if (!cols) {
          cols = JSON.parse(line) as string[];
          if (!Array.isArray(cols) || !cols.length || cols.some(c => typeof c !== "string")) throw new Error(`Cabeçalho inválido no backup: ${t.table}`);
          blobs = new Set(columns(sql, t.table).filter((c) => c.blob).map((c) => c.name));
          const header = cols;
          const select = header.map((c, i) => blobs.has(c) ? `unhex(json_extract(value,'$[${i}]'))` : `json_extract(value,'$[${i}]')`).join(",");
          fromJson = `INSERT INTO ${q(t.table)} (${header.map(q).join(",")}) SELECT ${select} FROM json_each(?) WHERE json_type(value)='array' AND json_array_length(value)=${header.length} ORDER BY key`;
          continue;
        }
        if (line.length > RESTORE_BATCH_CHARS) {
          // Linha enorme (perto do limite de 2 MB por linha): valores por bind, um a um.
          flush();
          const values = JSON.parse(line) as unknown[];
          if (!Array.isArray(values) || values.length !== cols.length) throw new Error(`Linha do backup com colunas a mais ou a menos: ${t.table}`);
          const header = cols;
          sql.exec(`INSERT INTO ${q(t.table)} (${header.map(q).join(",")}) VALUES (${header.map(c => blobs.has(c) ? "unhex(?)" : "?").join(",")})`, ...values);
          rows++;
          continue;
        }
        batch.push(line);
        batchChars += line.length + 1;
        if (batch.length >= RESTORE_BATCH_ROWS || batchChars >= RESTORE_BATCH_CHARS) flush();
      }
      flush();
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
  }
  return rows;
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
