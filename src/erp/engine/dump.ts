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
const DUMP_TABLES: readonly string[] = [...Object.keys(ERP_TABLES), ...ERP_ENGINE_TABLES.map((t) => t.table)];
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../schema/ddl.ts";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

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

/** Retrato de todas as tabelas do ERP (só as que têm linhas). */
export function dumpAll(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const files: { table: string; body: string }[] = [];
  const manifest: DumpManifest = {
    format: 1,
    schema_version: ERP_DDL_VERSION,
    schema_hash: ERP_DDL_HASH,
    created_at: new Date().toISOString(),
    tables: [],
  };
  for (const table of DUMP_TABLES) {
    const cols = columns(sql, table);
    const select = cols
      .map((c) => (c.integer ? `CAST(${q(c.name)} AS TEXT)` : c.blob ? `hex(${q(c.name)})` : q(c.name)))
      .join(",");
    const rows: unknown[][] = Array.from(sql.exec(`SELECT ${select} FROM ${q(table)} ORDER BY rowid`).raw());
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
) {
  if (manifest.schema_hash !== ERP_DDL_HASH)
    throw new Error(`Backup de outro esquema (${manifest.schema_hash}); este é ${ERP_DDL_HASH}.`);
  const sql = storage.sql;
  let rows = 0;
  storage.transactionSync(() => {
    sql.exec("PRAGMA defer_foreign_keys = ON");
    const triggers = sql
      .exec("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .toArray() as { name: string; sql: string }[];
    for (const g of triggers) sql.exec(`DROP TRIGGER ${q(g.name)}`);
    // Tabelas que já têm linhas (semeadura) e não estão no backup ficam vazias.
    for (const table of DUMP_TABLES) sql.exec(`DELETE FROM ${q(table)}`);
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
    for (const g of triggers) sql.exec(g.sql);
    const broken = sql.exec("PRAGMA foreign_key_check").toArray();
    if (broken.length) throw new Error("Backup com FK quebrada: " + JSON.stringify(broken[0]));
  });
  return { tables: manifest.tables.length, rows };
}

const gzip = async (text: string) =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
const gunzip = async (bytes: ArrayBuffer) =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

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

export async function readBackup(bucket: R2Bucket, prefix: string) {
  const manifestObject = await bucket.get(prefix + "manifest.json");
  if (!manifestObject) throw new Error("Backup sem manifesto.");
  const manifest = (await manifestObject.json()) as DumpManifest;
  const files = new Map<string, string>();
  for (const t of manifest.tables) {
    const object = await bucket.get(prefix + t.table + ".ndjson.gz");
    if (!object) throw new Error(`Backup sem a tabela ${t.table}.`);
    files.set(t.table, await gunzip(await object.arrayBuffer()));
  }
  return { manifest, files };
}
