/** Fatia C: pacote do contador do período antigo. Por mês, os XML das notas
 * emitidas no Bling num arquivo compactado (ZIP sem compressão, que qualquer
 * computador abre) com um índice em planilha (CSV). É montado aos poucos, no
 * alarme: cada unidade lê poucas notas, grava uma parte no R2 e registra onde
 * cada arquivo ficou; no fim grava o índice e o diretório do ZIP. O download
 * junta as partes na ordem. Nenhuma dependência nova. */
import { createHash } from "node:crypto";
import type { SqlDriver } from "../engine/driver.ts";
import { BlingAdoptionError, type BlingAdoptionOperationMap } from "./adoption-contracts.ts";
import type { BlingCutoverPackage } from "./cutover-contracts.ts";
import { command, type AdoptionCall } from "./adoption.ts";
import { centsOf, dateOf } from "./adoption-documents.ts";
import { clip, text, type Json } from "./adoption-store.ts";
import { saveItem } from "./cutover.ts";
import { verifiedXmlOf } from "./xml.ts";

export interface PackageMedia {
  put(key: string, bytes: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete?(key: string): Promise<unknown>;
}
/** Poucas notas e poucos bytes por unidade: cabe numa acordada do alarme. */
export const PACKAGE_UNIT = Object.freeze({ notes: 25, bytes: 4 * 1024 * 1024, wall_ms: 2500 });
const MAX_ENTRIES = 65_000;
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// ZIP (método 0, sem compressão)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
interface Entry { name: string; crc: number; size: number; offset: number; date: string }
function dosDate(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return ((Math.max(1980, y) - 1980) << 9) | (m << 5) | d;
}
function localHeader(entry: Entry): Uint8Array {
  const name = encoder.encode(entry.name), out = new Uint8Array(30 + name.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
  v.setUint16(10, 0, true); v.setUint16(12, dosDate(entry.date), true); v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.size, true); v.setUint32(22, entry.size, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
  out.set(name, 30);
  return out;
}
function centralHeader(entry: Entry): Uint8Array {
  const name = encoder.encode(entry.name), out = new Uint8Array(46 + name.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true);
  v.setUint16(12, 0, true); v.setUint16(14, dosDate(entry.date), true); v.setUint32(16, entry.crc, true); v.setUint32(20, entry.size, true);
  v.setUint32(24, entry.size, true); v.setUint16(28, name.length, true); v.setUint32(42, entry.offset, true);
  out.set(name, 46);
  return out;
}
function endOfDirectory(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22), v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true); v.setUint32(12, size, true); v.setUint32(16, offset, true);
  return out;
}
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

// ---------------------------------------------------------------------------
// Índice (CSV para planilha: ponto e vírgula e acentos em UTF-8 com BOM)

const CSV_HEADER = ["Modelo", "Chave de acesso", "Número", "Série", "Data de emissão", "Valor", "Situação", "XML no pacote"];
const cell = (v: string | null) => { const t = (v ?? "").replace(/[\r\n]+/g, " "); return /[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const SITUATIONS: Record<string, string> = { "1": "Pendente", "2": "Cancelada", "3": "Aguardando recibo", "4": "Rejeitada", "5": "Autorizada", "6": "Emitida DANFE",
  "7": "Registrada", "8": "Aguardando protocolo", "9": "Denegada", "10": "Consulta situação", "11": "Bloqueada" };

// ---------------------------------------------------------------------------
// Estado do pacote

interface PackageData extends Json {
  run: string; after: string | null; offset: number; parts: number; notes: number; with_xml: number; without_xml: number; bytes: number;
  error: string | null; filename: string | null; stale: string[];
}
const objectPrefix = (profile: string, month: string, run: string) => `erp/${profile}/bling/contador/${month}/${run}`;
function readPackage(db: SqlDriver, month: string): { state: string; data: PackageData; updated_at: number } | null {
  const r = db.exec("SELECT state, data, updated_at FROM wb_bling_cutover_item WHERE kind='package' AND key=?", month).rows[0];
  return r ? { state: String(r.state), data: JSON.parse(String(r.data)) as PackageData, updated_at: Number(r.updated_at) } : null;
}
function publicPackage(month: string, row: { state: string; data: PackageData; updated_at: number }): BlingCutoverPackage {
  return { month, state: row.state as BlingCutoverPackage["state"], notes: row.data.notes, with_xml: row.data.with_xml, without_xml: row.data.without_xml,
    bytes: row.data.bytes, parts: row.data.parts, updated_at: new Date(row.updated_at).toISOString(), error: row.data.error, filename: row.state === "done" ? row.data.filename : null };
}
export function packageRunning(db: SqlDriver): boolean {
  try { return db.exec("SELECT 1 AS x FROM wb_bling_cutover_item WHERE kind='package' AND state='running' LIMIT 1").rows.length > 0; } catch { return false; }
}

export function packageList(call: Pick<AdoptionCall, "db" | "parts">): BlingAdoptionOperationMap["erp_bling_cutover_packages"]["output"] {
  const rows = call.db.exec("SELECT key FROM wb_bling_cutover_item WHERE kind='package' ORDER BY key DESC LIMIT 400").rows;
  return { items: rows.map(r => publicPackage(String(r.key), readPackage(call.db, String(r.key))!)) };
}

export function packageStart(call: AdoptionCall, input: BlingAdoptionOperationMap["erp_bling_cutover_package_start"]["input"], cutoverOn: string) {
  return command(call, "erp_bling_cutover_package_start", input.command_id, ctx => {
    const db = ctx.db, now = call.now(), actor = call.identity.actor!.user_id;
    if (input.month > cutoverOn.slice(0, 7)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", `O pacote do contador é do período antigo: escolha um mês até ${cutoverOn.slice(5, 7)}/${cutoverOn.slice(0, 4)}, o mês da data de corte.`);
    const previous = readPackage(db, input.month);
    // Refazer: as partes antigas saem do registro e os arquivos dela vão para a limpeza.
    const old = db.exec("SELECT data FROM wb_bling_cutover_item WHERE kind='package_part' AND key LIKE ?", input.month + ":%").rows
      .map(r => text((JSON.parse(String(r.data)) as Json).key)).filter((k): k is string => !!k);
    if (previous?.data.filename && previous.state === "done") old.push(`${objectPrefix(call.profile, input.month, previous.data.run)}/final`);
    db.exec("DELETE FROM wb_bling_cutover_item WHERE kind='package_part' AND key LIKE ?", input.month + ":%");
    const run = createHash("sha256").update(input.command_id).digest("hex").slice(0, 16);
    const data: PackageData = { run, after: null, offset: 0, parts: 0, notes: 0, with_xml: 0, without_xml: 0, bytes: 0, error: null, filename: null,
      stale: [...(previous?.data.stale ?? []), ...old].slice(-400) };
    saveItem(db, "package", input.month, "running", data, null, actor, now);
    return { package: publicPackage(input.month, readPackage(db, input.month)!) };
  });
}

/** Notas do mês, na ordem do pacote (modelo, id). */
function monthNotes(db: SqlDriver, month: string, after: string | null, limit: number) {
  const [ae, as] = after ? after.split(":") : [null, null];
  return db.exec(`SELECT r.entity, r.source_id, CAST(json_extract(r.payload,'$.numero') AS TEXT) AS numero, CAST(json_extract(r.payload,'$.serie') AS TEXT) AS serie,
      CAST(json_extract(r.payload,'$.chaveAcesso') AS TEXT) AS chave, substr(coalesce(json_extract(r.payload,'$.dataEmissao'), json_extract(r.payload,'$.dataOperacao')),1,10) AS emissao,
      CAST(coalesce(json_extract(r.payload,'$.valorNota'), json_extract(r.payload,'$.valor')) AS TEXT) AS valor,
      CAST(coalesce(json_extract(r.payload,'$.situacao.id'), json_extract(r.payload,'$.situacao.valor'), json_extract(r.payload,'$.situacao')) AS TEXT) AS situacao
    FROM origin_sync__raw_record r WHERE r.entity IN ('nfe','nfce') AND substr(coalesce(json_extract(r.payload,'$.dataEmissao'), json_extract(r.payload,'$.dataOperacao')),1,7)=?
      AND (? IS NULL OR r.entity>? OR (r.entity=? AND (length(r.source_id)>length(?) OR (length(r.source_id)=length(?) AND r.source_id>?))))
    ORDER BY r.entity, length(r.source_id), r.source_id LIMIT ?`, month, ae, ae, ae, as, as, as, limit).rows;
}
const money = (v: unknown) => { const c = centsOf(v); if (typeof c !== "bigint") return ""; const neg = c < 0n, a = neg ? -c : c; return `${neg ? "-" : ""}${a / 100n},${String(a % 100n).padStart(2, "0")}`; };

/** Uma unidade do alarme: no máximo um pacote, poucas notas, uma parte no R2. */
export async function runPackageUnit(options: { db: SqlDriver; profile: string; media: PackageMedia | null; now(): number }): Promise<{ worked: boolean; more: boolean }> {
  const { db, profile, media, now } = options;
  const job = db.exec("SELECT key FROM wb_bling_cutover_item WHERE kind='package' AND state='running' ORDER BY updated_at, key LIMIT 1").rows[0];
  if (!job) return { worked: false, more: false };
  const month = String(job.key), current = readPackage(db, month)!, run = current.data.run, started = now();
  const fail = (message: string) => { db.transaction(() => { const c = readPackage(db, month); if (c?.state === "running" && c.data.run === run) saveItem(db, "package", month, "failed", { ...c.data, error: message }, null, "sistema", now()); }); return { worked: true, more: false }; };
  if (!media) return fail("O armazenamento de arquivos não está disponível nesta instalação.");
  // Limpeza dos arquivos de um pacote refeito (melhor esforço).
  if (current.data.stale.length && media.delete) {
    const key = current.data.stale[0];
    try { await media.delete(key); } catch { /* fica para a próxima */ }
    db.transaction(() => { const c = readPackage(db, month); if (c?.data.run === run) saveItem(db, "package", month, c.state, { ...c.data, stale: c.data.stale.filter(k => k !== key) }, null, "sistema", now()); });
  }
  const rows = monthNotes(db, month, current.data.after, PACKAGE_UNIT.notes);
  const prefix = objectPrefix(profile, month, run);
  if (rows.length) {
    if (current.data.notes + rows.length > MAX_ENTRIES) return fail("O mês tem notas demais para um só arquivo. Avise o suporte.");
    const chunks: Uint8Array[] = [], entries: Entry[] = [], csv: string[] = [];
    let offset = current.data.offset, size = 0, withXml = 0, withoutXml = 0, last: string | null = null;
    for (const r of rows) {
      if (size > PACKAGE_UNIT.bytes || now() - started > PACKAGE_UNIT.wall_ms) break;
      const entity = String(r.entity), day = dateOf(r.emissao) ?? `${month}-01`, model = entity === "nfe" ? "NF-e" : "NFC-e";
      const found = verifiedXmlOf(db, profile, entity, String(r.source_id));
      let included = "não coletado";
      if (found) {
        let bytes: Uint8Array | null = null;
        try { const object = await media.get(found.key); bytes = object ? new Uint8Array(await object.arrayBuffer()) : null; }
        catch { return { worked: true, more: true }; } // Falha passageira: a mesma unidade volta na próxima acordada.
        if (bytes && createHash("sha256").update(bytes).digest("hex") === found.sha256) {
          const entry: Entry = { name: `${month}/${entity === "nfe" ? "NFe" : "NFCe"}-${(found.access_key || String(r.source_id)).replace(/[^0-9A-Za-z]/g, "")}.xml`, crc: crc32(bytes), size: bytes.length, offset, date: day };
          const header = localHeader(entry);
          chunks.push(header, bytes); entries.push(entry); offset += header.length + bytes.length; size += header.length + bytes.length;
          included = "sim"; withXml++;
        } else included = "não confere com o hash";
      }
      if (included !== "sim") withoutXml++;
      const situation = text(r.situacao);
      csv.push([model, text(r.chave), text(r.numero), text(r.serie), dateOf(r.emissao)?.split("-").reverse().join("/") ?? null, money(r.valor),
        situation ? SITUATIONS[situation] ?? `código ${situation}` : null, included].map(cell).join(";"));
      last = `${entity}:${r.source_id}`;
    }
    if (!last) return { worked: false, more: true };
    const seq = current.data.parts + 1, partKey = `${prefix}/parte-${String(seq).padStart(5, "0")}`;
    if (entries.length) {
      try { await media.put(partKey, concat(chunks)); } catch { return { worked: true, more: true }; }
    }
    let stillOurs = true;
    db.transaction(() => {
      const c = readPackage(db, month);
      if (c?.state !== "running" || c.data.run !== run || c.data.after !== current.data.after) { stillOurs = false; return; }
      saveItem(db, "package_part", `${month}:${run}:${String(seq).padStart(5, "0")}`, "stored", { key: entries.length ? partKey : null, size, entries, csv }, null, "sistema", now());
      saveItem(db, "package", month, "running", { ...c.data, after: last, offset, parts: seq, notes: c.data.notes + csv.length, with_xml: c.data.with_xml + withXml,
        without_xml: c.data.without_xml + withoutXml, bytes: offset }, null, "sistema", now());
    });
    // Pacote refeito enquanto esta parte era gravada: o arquivo vai para a limpeza.
    if (!stillOurs && entries.length && media.delete) { try { await media.delete(partKey); } catch { /* órfão sem referência */ } }
    return { worked: true, more: true };
  }
  // Fim: índice, diretório e o fecho do ZIP.
  const parts = db.exec("SELECT data FROM wb_bling_cutover_item WHERE kind='package_part' AND key LIKE ? ORDER BY key", `${month}:${run}:%`).rows.map(r => JSON.parse(String(r.data)) as { entries: Entry[]; csv: string[] });
  const all = parts.flatMap(p => p.entries);
  const csvBytes = encoder.encode("﻿" + [CSV_HEADER.join(";"), ...parts.flatMap(p => p.csv)].join("\r\n") + "\r\n");
  const index: Entry = { name: `${month}/indice-notas-${month}.csv`, crc: crc32(csvBytes), size: csvBytes.length, offset: current.data.offset, date: `${month}-01` };
  const indexHeader = localHeader(index);
  const directory = concat([...all, index].map(centralHeader));
  const directoryOffset = current.data.offset + indexHeader.length + csvBytes.length;
  const final = concat([indexHeader, csvBytes, directory, endOfDirectory(all.length + 1, directory.length, directoryOffset)]);
  try { await media.put(`${prefix}/final`, final); } catch { return { worked: true, more: true }; }
  db.transaction(() => {
    const c = readPackage(db, month);
    if (c?.state !== "running" || c.data.run !== run) return;
    saveItem(db, "package", month, "done", { ...c.data, bytes: c.data.offset + final.length, filename: `contador-bling-${month}.zip`, error: null }, null, "sistema", now());
  });
  return { worked: true, more: packageRunning(db) };
}

/** O arquivo do mês: as partes na ordem e o fecho, sem montar tudo na memória. */
export async function packageDownload(db: SqlDriver, profile: string, media: PackageMedia | null, month: string): Promise<Response> {
  const row = readPackage(db, month);
  if (!row || row.state !== "done") throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "O pacote deste mês ainda não está pronto. Gere o pacote e espere terminar.");
  if (!media) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE", "O armazenamento de arquivos não está disponível agora. Tente de novo mais tarde.");
  const keys = db.exec("SELECT data FROM wb_bling_cutover_item WHERE kind='package_part' AND key LIKE ? ORDER BY key", `${month}:${row.data.run}:%`).rows
    .map(r => text((JSON.parse(String(r.data)) as Json).key)).filter((k): k is string => !!k);
  keys.push(`${objectPrefix(profile, month, row.data.run)}/final`);
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= keys.length) { controller.close(); return; }
      const object = await media.get(keys[index++]);
      if (!object) { controller.error(new Error("parte do pacote ausente")); return; }
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/zip", "Content-Length": String(row.data.bytes),
    "Content-Disposition": `attachment; filename="${clip(row.data.filename ?? `contador-bling-${month}.zip`, 120)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
