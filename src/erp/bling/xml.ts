/** Acervo fiscal consultivo. O journal antecede o PUT; a confirmação exige GET e hash. */
import { BlingError, type BlingContext, type BlingExpectedState, type BlingOperationMap, type BlingReceipt, type BlingUnit, type BlingXmlSummary, type JsonObject } from "./contracts.ts";
import type { BlingXmlArchiveInput } from "./ports.ts";
import { authorizeBlingOperation, sha256Schema, unitSchema } from "./schema.ts";
import { one, type Row, type SqlDriver } from "../engine/driver.ts";
// @ts-expect-error O parser original é JavaScript puro, compartilhado com o coletor.
import { archiveKey, inspectArchivedXml, decodeArchivedDocuments, XML_ARCHIVE_LIMITS } from "../fagoo/packages/fiscal-xml/src/archive.mjs";
// @ts-expect-error O parser lexical preserva números antes de materializá-los.
import { parseSelectedPriceJson } from "../fagoo/workers/origin-sync/src/price-json-parser.mjs";

export interface BlingXmlMedia {
  put(key: string, bytes: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export interface BlingXmlDependencies {
  profile: string;
  db: SqlDriver;
  media: BlingXmlMedia;
  hash(bytes: Uint8Array): Promise<string>;
  randomId(): string;
  /** Confere Base, instalação, seleção, conta, revisões e partes antes/depois de I/O. */
  revalidate(ctx: BlingContext, expected: BlingExpectedState): Promise<void>;
  /** Reconsulta permissões de leitura após I/O; não depende de collect_enabled. */
  requireRead?(ctx: BlingContext, operation: "erp_bling_xml_list" | "erp_bling_xml_get", input: unknown): void;
}
export type BlingXmlManifestInput = Omit<BlingXmlArchiveInput, "bytes" | "expected_sha256"> & { documents: { bytes: Uint8Array; expected_sha256: string }[] };
// Compartilhado por factories do mesmo runtime. O journal/lease cobre restart;
// esta barreira cobre PUT vivo que ultrapassou seu lease sem poder ser cancelado.
const pendingXmlWrites = new Map<string, number>();
const pendingWriteKey = (profile: string, workId: string) => JSON.stringify([profile, workId]);
export function hasPendingXmlWrite(profile: string, workId: string): boolean {
  return (pendingXmlWrites.get(pendingWriteKey(profile, workId)) ?? 0) > 0;
}
/** Uma exclusão (órfã ou do apagamento) pode ultrapassar seu lease; purgar,
 * confirmar e restaurar devem esperá-la. Contagem: duas exclusões da mesma chave. */
const pendingObjectDeletes = new Map<string, number>();
export function markXmlObjectDelete(profile: string, key: string, pending: boolean): void {
  const marker = JSON.stringify([profile, key]), count = (pendingObjectDeletes.get(marker) ?? 0) + (pending ? 1 : -1);
  if (count > 0) pendingObjectDeletes.set(marker, count); else pendingObjectDeletes.delete(marker);
}
export function hasPendingXmlObjectDelete(profile: string, key?: string): boolean {
  return key === undefined ? [...pendingObjectDeletes.keys()].some(marker => JSON.parse(marker)[0] === profile) : pendingObjectDeletes.has(JSON.stringify([profile, key]));
}
/** Restauração em curso por área: nenhum PUT, GET ou DELETE de XML começa. */
const restoringProfiles = new Set<string>();
export function archiveRestoreActive(profile: string): boolean { return restoringProfiles.has(profile); }
/** Gravação ou exclusão de XML viva nesta instância, inclusive além do prazo da acordada. */
export function archiveIoInFlight(profile: string): boolean {
  return [...pendingXmlWrites.keys()].some(marker => JSON.parse(marker)[0] === profile) || hasPendingXmlObjectDelete(profile);
}
/** Síncrono: conferir e marcar não têm await entre si, nem com o início de cada I/O. */
export function beginArchiveRestore(profile: string): boolean {
  if (restoringProfiles.has(profile) || archiveIoInFlight(profile)) return false;
  restoringProfiles.add(profile);
  return true;
}
export function endArchiveRestore(profile: string): void { restoringProfiles.delete(profile); }
export function assertNoArchiveRestore(ctx: BlingContext, profile: string): void {
  if (restoringProfiles.has(profile)) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 1000 });
}
/** Libera a acordada no deadline sem fingir que um PUT remoto foi cancelado.
 * O chamador conserva a barreira até a Promise original efetivamente terminar. */
export async function waitArchiveIo<T>(ctx: BlingContext, deadline: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new BlingError("BLING_RETRY_WAIT",{retry_at:ctx.clock.now()+700})),Math.max(0,deadline-ctx.clock.now()));
  });
  try { return await Promise.race([pending,timeout]); }
  finally { if(timer!==undefined)clearTimeout(timer); }
}
export interface XmlCandidate {
  entity: "nfe" | "nfce";
  source_id: string;
  direction: "input" | "output" | "unknown";
  fingerprint: string;
  last_fingerprint: string | null;
  last_checked_at: number | null;
  next_attempt_at: number | null;
  verified_manifest: boolean;
  blocked?: boolean;
}
/** A direção desconhecida possui sua própria vez; falhas em espera não monopolizam. */
export function selectXmlCandidates(candidates: readonly XmlCandidate[], options: { now: number; limit?: number; after_group?: string }) {
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 10)));
  const groups = ["nfe:input", "nfce:input", "nfe:output", "nfce:output", "nfe:unknown", "nfce:unknown"];
  const start = options.after_group ? (groups.indexOf(options.after_group) + 1) % groups.length : 0;
  // O fingerprint é o último sucesso, não necessariamente a última tentativa.
  // Diferir dele não autoriza furar o backoff de uma falha ainda em espera.
  const pools = new Map(groups.map(group => [group, candidates.filter(c => `${c.entity}:${c.direction}` === group && !c.blocked && (c.next_attempt_at ?? 0) <= options.now && (!c.verified_manifest || c.fingerprint !== c.last_fingerprint || c.next_attempt_at !== null && c.next_attempt_at <= options.now)).sort((a, b) => (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0) || a.source_id.localeCompare(b.source_id))]));
  const result: XmlCandidate[] = [];
  let last = options.after_group ?? null;
  while (result.length < limit) {
    let added = false;
    for (let offset = 0; offset < groups.length && result.length < limit; offset++) {
      const group = groups[(start + offset) % groups.length], candidate = pools.get(group)!.shift();
      if (candidate) { result.push(candidate); last = group; added = true; }
    }
    if (!added) break;
  }
  return { items: result, next_group: last };
}

const encoder = new TextEncoder();
const invalid = (): never => { throw new BlingError("BLING_RESPONSE_INVALID"); };
const json = (value: unknown): Record<string, any> => {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid(); return parsed; } catch { return invalid(); }
};
export function blingXmlObjectKey(profile: string, sha256: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(profile) || !sha256Schema.safeParse(sha256).success) return invalid();
  return `erp/${profile}/bling/xml/${sha256}`;
}
/** A URL não participa: trocar URL sem mudar a nota não exige outro arquivo. */
export async function xmlFingerprint(payloadText: string, hash: BlingXmlDependencies["hash"]): Promise<string> {
  try {
    const { result } = await parseSelectedPriceJson(payloadText, encoder.encode(payloadText), (path: (string | number)[]) => [0, "/" + path.join("/")]);
    const names = ["chaveAcesso", "situacao", "tipo", "numero", "serie", "dataEmissao", "dataOperacao", "valorNota"];
    return await hash(encoder.encode(JSON.stringify(names.map(name => [name, Object.hasOwn(result, name) ? result[name] : { absent: true }]))));
  } catch { return invalid(); }
}

export async function validateXmlBytes(input: { bytes: Uint8Array; entity: "nfe" | "nfce"; access_key: string; model: "55" | "65"; expected_sha256: string }, hash: BlingXmlDependencies["hash"]) {
  try {
    const bytes = Uint8Array.from(input.bytes);
    if (bytes.length < 1 || bytes.length > XML_ARCHIVE_LIMITS.xml || !sha256Schema.safeParse(input.expected_sha256).success || input.model !== (input.entity === "nfe" ? "55" : "65")) return invalid();
    archiveKey(input.access_key, input.entity);
    const metadata = inspectArchivedXml(bytes, { key: input.access_key, entity: input.entity });
    if (await hash(bytes) !== input.expected_sha256) return invalid();
    return { bytes, metadata: metadata as JsonObject };
  } catch { return invalid(); }
}

/** O adaptador HTTP entrega somente o envelope recebido; gzip/base64 nunca vão ao SQL. */
export async function decodeXmlDocuments(data: unknown, input: { access_key: string; entity: "nfe" | "nfce"; deadline: number; now(): number; signal?: AbortSignal }): Promise<{ hash: string; size: number; bytes: Uint8Array; [key: string]: unknown }[]> {
  try { return await decodeArchivedDocuments(data, { key: input.access_key, entity: input.entity, deadline: input.deadline, now: input.now, signal: input.signal }); } catch { return invalid(); }
}

type XmlDocumentJournal = { phase: "put_pending" | "stored" | "verified" | "needs_fetch"; key: string; sha256: string; size: number; metadata: JsonObject };
type XmlJournal = {
  phase: "put_pending" | "stored" | "needs_fetch"; key: string; sha256: string; size: number;
  source: string; attempt: string; manifest_hash: string; source_hash: string; source_version: number;
  fingerprint: string; access_key: string; entity: "nfe" | "nfce"; source_id: string; metadata: JsonObject;
  documents: XmlDocumentJournal[];
};

export function createXmlArchive(deps: BlingXmlDependencies) {
  const { db } = deps;
  const area = (ctx: BlingContext) => { if (ctx.profile !== deps.profile) throw new BlingError("BLING_SCOPE_REQUIRED"); };
  const control = () => one(db, "SELECT * FROM wb_bling_control WHERE id=1");
  function requireObjectAvailable(sha256: string) {
    if (hasPendingXmlObjectDelete(deps.profile, blingXmlObjectKey(deps.profile, sha256)) || one(db,"SELECT id FROM wb_bling_unit WHERE kind='r2_delete' AND profile=? AND phase NOT IN ('committed','superseded') AND json_extract(plan,'$.sha256')=? LIMIT 1",deps.profile,sha256)) throw new BlingError("BLING_RETRY_WAIT");
  }
  function guard(ctx: BlingContext, unit: BlingUnit): Row {
    area(ctx);
    if (ctx.origin === "external" || !ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED");
    const c = control();
    if (!c || String(c.generation) !== unit.expected.generation) throw new BlingError("BLING_GENERATION_RETIRED");
    if (!c.collect_enabled || c.state === "purging" || !c.approved_by) throw new BlingError("BLING_DISABLED");
    if (c.account_id !== unit.expected.account_id) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    if (String(c.authorization_revision) !== unit.expected.authorization_revision || String(c.credential_revision) !== unit.expected.credential_revision || String(c.revision) !== unit.expected.configuration_revision) throw new BlingError("BLING_REVISION_CONFLICT");
    const row = one(db, "SELECT * FROM wb_bling_unit WHERE id=?", unit.work_id);
    if (!row || row.attempt_id !== unit.attempt_id || row.command_id !== unit.command_id || row.request_hash !== unit.request_hash || String(row.generation) !== unit.expected.generation || row.kind !== unit.kind || row.entity !== unit.entity || row.source_id !== unit.source_id || String(row.authorization_revision) !== unit.expected.authorization_revision || String(row.credential_revision) !== unit.expected.credential_revision || String(row.configuration_revision) !== unit.expected.configuration_revision || row.account_id !== unit.expected.account_id || row.parts_revision !== unit.expected.parts_revision) throw new BlingError("BLING_COMMAND_CONFLICT");
    if (!unit.lease || row.owner !== unit.lease.owner || row.fence !== unit.lease.fence || Number(row.lease_until) <= ctx.clock.now() || unit.lease.expires_at <= ctx.clock.now()) throw new BlingError("BLING_LEASE_LOST");
    if (["superseded", "blocked"].includes(String(row.phase))) throw new BlingError("BLING_LEASE_LOST");
    return row;
  }
  function receipt(ctx: BlingContext, unit: BlingUnit): BlingXmlSummary | null {
    area(ctx);
    if (ctx.origin === "external") throw new BlingError("BLING_SCOPE_REQUIRED");
    const r = one(db, "SELECT * FROM wb_bling_receipt WHERE command_id=?", unit.command_id);
    if (!r) return null;
    if (r.request_hash !== unit.request_hash || String(r.generation) !== unit.expected.generation) throw new BlingError("BLING_COMMAND_CONFLICT");
    if (String(control()?.generation) !== unit.expected.generation) throw new BlingError("BLING_GENERATION_RETIRED");
    const result=json(r.result),summary = result.references?.xml ?? result.xml;
    if (!summary || r.operation !== "xml_archive" || r.state !== "committed") return invalid();
    return summary as BlingXmlSummary;
  }
  function sourceRaw(entity: string, id: string) {
    const raw = one(db, "SELECT payload,version_hash,version FROM origin_sync__raw_record WHERE entity=? AND source_id=?", entity, id);
    if (!raw) throw new BlingError("BLING_REVISION_CONFLICT");
    return raw;
  }
  function journalOf(row: Row): XmlJournal {
    const journal = json(row.progress).xml;
    if (!journal || !["put_pending", "stored", "needs_fetch"].includes(journal.phase) || journal.key !== blingXmlObjectKey(deps.profile, journal.sha256) || journal.metadata?.profile !== deps.profile || !Array.isArray(journal.documents) || journal.documents.length < 1 || journal.documents.length > 10 || journal.documents.some((d: XmlDocumentJournal) => !["put_pending", "stored", "verified", "needs_fetch"].includes(d.phase) || d.key !== blingXmlObjectKey(deps.profile, d.sha256) || d.metadata?.profile !== deps.profile) || new Set(journal.documents.map((d: XmlDocumentJournal) => d.sha256)).size !== journal.documents.length) return invalid();
    return journal as XmlJournal;
  }
  function checkSource(j: XmlJournal) {
    const raw = sourceRaw(j.entity, j.source_id);
    if (raw.version_hash !== j.source_hash || raw.version !== j.source_version) throw new BlingError("BLING_REVISION_CONFLICT");
    const source = one(db, "SELECT * FROM origin_fiscal__source WHERE id=?", j.source);
    if (!source || source.entity !== j.entity || source.source_id !== j.source_id || source.access_key !== j.access_key || source.current_attempt !== j.attempt) throw new BlingError("BLING_REVISION_CONFLICT");
    return source;
  }
  function metadataSummary(j: XmlJournal, objectId: string, revision: number): BlingXmlSummary {
    return { object_id: objectId, entity: j.entity, source_id: j.source_id, access_key: j.access_key, model: j.entity === "nfe" ? "55" : "65", environment: j.metadata.environment === "1" ? "production" : j.metadata.environment === "2" ? "test" : "unknown", version: String(revision), sha256: j.sha256, bytes: j.size, available: true, coverage: [...(Array.isArray(j.metadata.issues) ? j.metadata.issues.map(String) : []), "Estrutura e integridade verificadas; assinatura criptográfica e autorização fiscal não certificadas."] };
  }
  /** Reserva fiscal antes do GET de dados. Nenhum token, URL ou XML entra no journal. */
  async function beginXml(ctx: BlingContext, input: Omit<BlingXmlArchiveInput, "bytes" | "expected_sha256">, options: { deadline?: number } = {}) {
    const deadline = Math.min(ctx.clock.now() + 4_000, options.deadline ?? Infinity);
    const budget = () => { if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 }); };
    budget();
    area(ctx);
    if (!unitSchema.safeParse(input.unit).success || input.identity.profile !== deps.profile || input.identity.account_id !== input.unit.expected.account_id || !["nfe", "nfce"].includes(input.identity.entity) || input.unit.entity !== input.identity.entity || input.unit.source_id !== input.identity.source_id || !input.unit.kind.startsWith("xml_") || input.model !== (input.identity.entity === "nfe" ? "55" : "65")) return invalid();
    const replay = receipt(ctx, input.unit);
    if (replay) {
      const saved=journalOf(one(db,"SELECT progress FROM wb_bling_unit WHERE id=?",input.unit.work_id)!);
      if (saved.fingerprint!==input.fingerprint || replay.entity!==input.identity.entity || replay.source_id!==input.identity.source_id || replay.access_key!==input.access_key || replay.model!==input.model) throw new BlingError("BLING_COMMAND_CONFLICT");
      return { attempt_id: input.unit.attempt_id, stored: true };
    }
    await deps.revalidate(ctx, input.unit.expected); budget(); guard(ctx, input.unit);
    try { archiveKey(input.access_key, input.identity.entity); } catch { return invalid(); }
    const raw = sourceRaw(input.identity.entity, input.identity.source_id);
    if (json(raw.payload).chaveAcesso !== input.access_key || await xmlFingerprint(String(raw.payload), deps.hash) !== input.fingerprint) throw new BlingError("BLING_REVISION_CONFLICT");
    budget();
    await deps.revalidate(ctx, input.unit.expected);
    budget();
    return db.transaction(() => {
      const row = guard(ctx, input.unit), latest = sourceRaw(input.identity.entity, input.identity.source_id);
      if (latest.version_hash !== raw.version_hash || latest.version !== raw.version) throw new BlingError("BLING_REVISION_CONFLICT");
      let source = one(db, "SELECT * FROM origin_fiscal__source WHERE entity=? AND source_id=? AND access_key=?", input.identity.entity, input.identity.source_id, input.access_key);
      if (!source) {
        const id = deps.randomId();
        db.exec("INSERT INTO origin_fiscal__source(id,entity,source_id,access_key) VALUES(?,?,?,?)", id, input.identity.entity, input.identity.source_id, input.access_key);
        source = one(db, "SELECT * FROM origin_fiscal__source WHERE id=?", id)!;
      }
      const previous = source.current_attempt ? one(db, "SELECT * FROM origin_fiscal__attempt WHERE id=?", source.current_attempt) : null;
      if (previous?.state === "pending" && previous.id === input.unit.attempt_id && previous.fingerprint === input.fingerprint && previous.source_hash === raw.version_hash && json(previous.result ?? "{}").work_id === input.unit.work_id) {
        db.exec("UPDATE origin_fiscal__attempt SET owner=?,fence=? WHERE id=? AND state='pending'", input.unit.lease!.owner, input.unit.lease!.fence, previous.id);
      } else {
        if (previous?.state === "pending" && one(db, "SELECT id FROM wb_bling_unit WHERE owner=? AND fence=? AND lease_until>? AND phase IN ('reserved','fetching','waiting') AND (json_extract(progress,'$.xml.attempt')=? OR json_extract(progress,'$.xml_intent.attempt')=?)", previous.owner, previous.fence, ctx.clock.now(), previous.id, previous.id)) throw new BlingError("BLING_LEASE_LOST");
        if (previous?.state === "pending") db.exec("UPDATE origin_fiscal__attempt SET state='superseded',finished_at=? WHERE id=? AND state='pending'", ctx.clock.now(), previous.id);
        const status = json(raw.payload).situacao;
        db.exec("INSERT INTO origin_fiscal__attempt(id,source,owner,fence,fingerprint,source_hash,source_version,source_status,started_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)", input.unit.attempt_id, source.id, input.unit.lease!.owner, input.unit.lease!.fence, input.fingerprint, raw.version_hash, raw.version, typeof status === "string" || typeof status === "number" ? String(status).slice(0, 100) : null, ctx.clock.now(), JSON.stringify({ work_id: input.unit.work_id }));
      }
      const intent = { source: source.id, attempt: input.unit.attempt_id, fingerprint: input.fingerprint, source_hash: raw.version_hash, source_version: raw.version, access_key: input.access_key, entity: input.identity.entity, source_id: input.identity.source_id };
      db.exec("UPDATE origin_fiscal__source SET current_attempt=?,last_checked_at=? WHERE id=?", input.unit.attempt_id, ctx.clock.now(), source.id);
      db.exec("UPDATE wb_bling_unit SET phase='fetching',progress=?,updated_at=? WHERE id=?", JSON.stringify({ ...json(row.progress), xml_intent: intent }), ctx.clock.now(), input.unit.work_id);
      return { attempt_id: input.unit.attempt_id, stored: false };
    });
  }
  function manifestReceipt(ctx: BlingContext, unit: BlingUnit): BlingXmlSummary[] | null {
    const first = receipt(ctx, unit);
    if (!first) return null;
    const result = json(one(db, "SELECT result FROM wb_bling_receipt WHERE command_id=?", unit.command_id)!.result);
    const summaries=result.references?.xmls ?? result.xmls;
    return Array.isArray(summaries) ? summaries as BlingXmlSummary[] : [first];
  }
  /** Sinaliza somente o término do PUT, inclusive após desligamento/purge.
   * O fence protege contra outra tomada. Não confirma bytes nem revive unidade.
   */
  function settlePut(ctx: BlingContext, unit: BlingUnit): void {
    db.transaction(() => {
      const row = one(db, "SELECT * FROM wb_bling_unit WHERE id=?", unit.work_id);
      if (!row || row.phase !== "fetching" || row.attempt_id !== unit.attempt_id || row.command_id !== unit.command_id || row.request_hash !== unit.request_hash || row.owner !== unit.lease?.owner || row.fence !== unit.lease?.fence) return;
      db.exec("UPDATE wb_bling_unit SET phase='waiting',not_before=?,updated_at=? WHERE id=? AND fence=? AND phase='fetching'", ctx.clock.now() + 700, ctx.clock.now(), unit.work_id, unit.lease!.fence);
    });
  }
  /** O conjunto de documentos mudou entre a primeira leitura e a retomada.
   * A tentativa e a unidade terminam como superadas, conservando o journal:
   * a limpeza de órfãos reconcilia os objetos já gravados (só apaga o que
   * nenhum manifesto confirmado referencia) e a pista cria outra unidade
   * para o conjunto novo. */
  function retireDivergent(ctx: BlingContext, unit: BlingUnit): void {
    if (hasPendingXmlWrite(deps.profile, unit.work_id)) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    db.transaction(() => {
      const row = guard(ctx, unit), prior = journalOf(row);
      db.exec("UPDATE origin_fiscal__attempt SET state='superseded',finished_at=? WHERE id=? AND state='pending'", ctx.clock.now(), prior.attempt);
      db.exec("UPDATE wb_bling_unit SET phase='superseded',error_code='BLING_REVISION_CONFLICT',finished_at=?,updated_at=?,owner=NULL,fence=NULL,lease_until=NULL WHERE id=? AND phase NOT IN ('committed','superseded')", ctx.clock.now(), ctx.clock.now(), unit.work_id);
      db.exec("UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE resource='fiscal_xml' AND lease_token=?", ctx.clock.now(), unit.lease!.fence);
    });
  }
  /** Até dez arquivos. Cada chamada grava no máximo um; o mesmo envelope retoma os demais. */
  async function archiveXmlManifest(ctx: BlingContext, input: BlingXmlManifestInput, options: { deadline?: number } = {}): Promise<BlingXmlSummary[]> {
    const deadline = Math.min(ctx.clock.now() + 4_000, options.deadline ?? Infinity);
    const budget = () => { if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 }); };
    area(ctx);
    if (!unitSchema.safeParse(input.unit).success || input.identity.profile !== deps.profile || input.identity.account_id !== input.unit.expected.account_id || !["nfe", "nfce"].includes(input.identity.entity) || input.unit.entity !== input.identity.entity || input.unit.source_id !== input.identity.source_id || !input.unit.kind.startsWith("xml_")) return invalid();
    if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 10 || input.documents.reduce((size, d) => size + d.bytes.byteLength, 0) > XML_ARCHIVE_LIMITS.total) return invalid();
    const entity = input.identity.entity as "nfe" | "nfce";
    const validated: { bytes: Uint8Array; metadata: JsonObject; sha256: string }[] = [];
    for (const document of input.documents) {
      budget();
      const checked = await validateXmlBytes({ ...document, entity, access_key: input.access_key, model: input.model }, deps.hash);
      if (!validated.some(d => d.sha256 === document.expected_sha256)) validated.push({ ...checked, sha256: document.expected_sha256 });
    }
    validated.sort((a, b) => a.sha256.localeCompare(b.sha256));
    const replay = manifestReceipt(ctx, input.unit);
    if (replay) {
      const saved = journalOf(one(db, "SELECT progress FROM wb_bling_unit WHERE id=?", input.unit.work_id)!);
      if (saved.fingerprint !== input.fingerprint || JSON.stringify(replay.map(d => d.sha256).sort()) !== JSON.stringify(validated.map(d => d.sha256)) || replay.some(d => d.access_key !== input.access_key || d.entity !== entity || d.source_id !== input.identity.source_id)) throw new BlingError("BLING_COMMAND_CONFLICT");
      return replay;
    }
    await deps.revalidate(ctx, input.unit.expected); guard(ctx,input.unit); budget();
    const initial = guard(ctx, input.unit);
    if (["committed", "blocked"].includes(String(initial.phase))) throw new BlingError("BLING_LEASE_LOST");
    const raw = sourceRaw(entity, input.identity.source_id);
    if (await xmlFingerprint(String(raw.payload), deps.hash) !== input.fingerprint) throw new BlingError("BLING_REVISION_CONFLICT");
    const payload = json(raw.payload);
    if (payload.chaveAcesso !== input.access_key) throw new BlingError("BLING_REVISION_CONFLICT");
    const manifestHash = await deps.hash(encoder.encode(JSON.stringify(validated.map(d => ({ hash: d.sha256, size: d.bytes.length })))));
    budget();
    const journal = db.transaction((): XmlJournal | null => {
      const row = guard(ctx, input.unit), current = sourceRaw(entity, input.identity.source_id);
      if (current.version_hash !== raw.version_hash || current.version !== raw.version) throw new BlingError("BLING_REVISION_CONFLICT");
      if (json(row.progress).xml) {
        const prior = journalOf(row);
        if (prior.fingerprint !== input.fingerprint || prior.source_hash !== raw.version_hash) throw new BlingError("BLING_COMMAND_CONFLICT");
        // Mesma fonte, outro conjunto de documentos: esta tentativa não pode
        // mais terminar. Aposentá-la abaixo; repetir a mesma unidade prende a pista.
        if (prior.manifest_hash !== manifestHash) return null;
        return prior;
      }
      let source = one(db, "SELECT * FROM origin_fiscal__source WHERE entity=? AND source_id=? AND access_key=?", entity, input.identity.source_id, input.access_key);
      if (!source) {
        const id = deps.randomId();
        db.exec("INSERT INTO origin_fiscal__source(id,entity,source_id,access_key) VALUES(?,?,?,?)", id, entity, input.identity.source_id, input.access_key);
        source = one(db, "SELECT * FROM origin_fiscal__source WHERE id=?", id)!;
      }
      const prior = source.current_attempt ? one(db, "SELECT * FROM origin_fiscal__attempt WHERE id=?", source.current_attempt) : null;
      let attempt = input.unit.attempt_id;
      if (prior?.state === "pending" && prior.fingerprint === input.fingerprint && prior.source_hash === raw.version_hash && prior.source_version === raw.version && json(prior.result ?? "{}").work_id === input.unit.work_id) {
        attempt = String(prior.id);
        db.exec("UPDATE origin_fiscal__attempt SET owner=?,fence=? WHERE id=? AND state='pending'", input.unit.lease!.owner, input.unit.lease!.fence, attempt);
      } else {
        if (prior?.state === "pending" && one(db, "SELECT id FROM wb_bling_unit WHERE owner=? AND fence=? AND lease_until>? AND phase IN ('reserved','fetching','waiting') AND json_extract(progress,'$.xml.attempt')=?", prior.owner, prior.fence, ctx.clock.now(), prior.id)) throw new BlingError("BLING_LEASE_LOST");
        if (prior?.state === "pending") db.exec("UPDATE origin_fiscal__attempt SET state='superseded',finished_at=? WHERE id=? AND state='pending'", ctx.clock.now(), prior.id);
        db.exec("INSERT INTO origin_fiscal__attempt(id,source,owner,fence,fingerprint,source_hash,source_version,source_status,started_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)", attempt, source.id, input.unit.lease!.owner, input.unit.lease!.fence, input.fingerprint, raw.version_hash, raw.version, typeof payload.situacao === "string" || typeof payload.situacao === "number" ? String(payload.situacao) : null, ctx.clock.now(), JSON.stringify({ work_id: input.unit.work_id }));
      }
      const documents: XmlDocumentJournal[] = validated.map(d => ({ phase: "put_pending", key: blingXmlObjectKey(deps.profile, d.sha256), sha256: d.sha256, size: d.bytes.length, metadata: { ...d.metadata, profile: deps.profile, generation: input.unit.expected.generation } }));
      const j: XmlJournal = { ...documents[0], phase: "put_pending", source: String(source.id), attempt, manifest_hash: manifestHash, source_hash: String(raw.version_hash), source_version: Number(raw.version), fingerprint: input.fingerprint, access_key: input.access_key, entity, source_id: input.identity.source_id, documents };
      db.exec("UPDATE origin_fiscal__source SET current_attempt=?,last_checked_at=? WHERE id=?", attempt, ctx.clock.now(), source.id);
      db.exec("UPDATE wb_bling_unit SET phase='waiting',progress=?,updated_at=? WHERE id=?", JSON.stringify({ ...json(row.progress), xml: j }), ctx.clock.now(), input.unit.work_id);
      return j;
    });
    if (!journal) {
      retireDivergent(ctx, input.unit);
      throw new BlingError("BLING_REVISION_CONFLICT", { retry_at: ctx.clock.now() + 700 });
    }
    const pending = journal.documents.find(d => d.phase === "put_pending" || d.phase === "needs_fetch");
    if (!pending) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    requireObjectAvailable(pending.sha256);
    await deps.revalidate(ctx, input.unit.expected); budget(); guard(ctx, input.unit);
    assertNoArchiveRestore(ctx, deps.profile);
    // Nenhum await separa a marca durável do início do PUT. O purge conserva
    // este journal enquanto fetching: o objeto pode aparecer mesmo após revogação.
    db.transaction(() => {
      guard(ctx, input.unit); checkSource(journal);
      db.exec("UPDATE wb_bling_unit SET phase='fetching',updated_at=? WHERE id=?", ctx.clock.now(), input.unit.work_id);
    });
    const writeKey = pendingWriteKey(deps.profile, input.unit.work_id);
    pendingXmlWrites.set(writeKey, (pendingXmlWrites.get(writeKey) ?? 0) + 1);
    const writing=Promise.resolve().then(()=>deps.media.put(pending.key, validated.find(d => d.sha256 === pending.sha256)!.bytes)).then(()=>false,()=>true).finally(()=>{
      const remaining = (pendingXmlWrites.get(writeKey) ?? 1) - 1;
      if (remaining > 0) pendingXmlWrites.set(writeKey, remaining); else pendingXmlWrites.delete(writeKey);
      if (remaining === 0) settlePut(ctx, input.unit);
    });
    const putFailed=await waitArchiveIo(ctx,deadline,writing);
    if (putFailed) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    await deps.revalidate(ctx, input.unit.expected); guard(ctx,input.unit); budget();
    db.transaction(() => {
      const row = guard(ctx, input.unit); checkSource(journal);
      const latest = journalOf(row);
      const documents = latest.documents.map(d => d.sha256 === pending.sha256 ? { ...d, phase: "stored" } : d);
      db.exec("UPDATE wb_bling_unit SET phase=?,progress=?,not_before=?,updated_at=? WHERE id=?", hasPendingXmlWrite(deps.profile, input.unit.work_id) ? "fetching" : "waiting", JSON.stringify({ ...json(row.progress), xml: { ...latest, phase: "stored", documents } }), ctx.clock.now() + 700, ctx.clock.now(), input.unit.work_id);
    });
    throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
  }
  async function archiveXml(ctx: BlingContext, input: BlingXmlArchiveInput): Promise<BlingXmlSummary> {
    return (await archiveXmlManifest(ctx, { ...input, documents: [{ bytes: input.bytes, expected_sha256: input.expected_sha256 }] }))[0];
  }

  /** Uma operação R2 por chamada. Recupera inclusive PUT concluído sem atualização SQL. */
  async function resumeXmlManifest(ctx: BlingContext, unit: BlingUnit, options: { deadline?: number } = {}): Promise<BlingXmlSummary[]> {
    const deadline = Math.min(ctx.clock.now() + 4_000, options.deadline ?? Infinity);
    const budget = () => { if (ctx.clock.now() >= deadline) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 }); };
    const replay = manifestReceipt(ctx, unit); if (replay) return replay;
    if (hasPendingXmlWrite(deps.profile, unit.work_id)) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    await deps.revalidate(ctx, unit.expected); budget();
    let j = db.transaction(() => {
      const row = guard(ctx, unit), journal = journalOf(row); checkSource(journal);
      const attempt = one(db, "SELECT * FROM origin_fiscal__attempt WHERE id=?", journal.attempt);
      if (!attempt || attempt.state !== "pending" || json(attempt.result ?? "{}").work_id !== unit.work_id) throw new BlingError("BLING_LEASE_LOST");
      // A tomada do mesmo trabalho após expiração conserva a tentativa e troca seu fence.
      db.exec("UPDATE origin_fiscal__attempt SET owner=?,fence=? WHERE id=? AND state='pending'", unit.lease!.owner, unit.lease!.fence, journal.attempt);
      return journal;
    });
    const document = j.documents.find(d => d.phase === "stored" || d.phase === "put_pending");
    if (document) {
      assertNoArchiveRestore(ctx, deps.profile);
      let stored: Awaited<ReturnType<BlingXmlMedia["get"]>>;
      try { stored = await waitArchiveIo(ctx,deadline,deps.media.get(document.key)); } catch { throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 }); }
      await deps.revalidate(ctx, unit.expected); budget(); guard(ctx, unit);
      if (!stored) {
        db.transaction(() => {
          const row = guard(ctx, unit), current = journalOf(row); checkSource(current);
          const documents = current.documents.map(d => d.sha256 === document.sha256 ? { ...d, phase: "needs_fetch" } : d);
          db.exec("UPDATE wb_bling_unit SET phase='queued',progress=?,not_before=?,updated_at=? WHERE id=?", JSON.stringify({ ...json(row.progress), xml: { ...current, phase: "needs_fetch", documents } }), ctx.clock.now() + 700, ctx.clock.now(), unit.work_id);
        });
        throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
      }
      if (stored.size !== undefined && (stored.size !== document.size || stored.size > XML_ARCHIVE_LIMITS.xml)) return invalid();
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await waitArchiveIo(ctx,deadline,stored.arrayBuffer())); } catch { throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 }); }
      const checked = await validateXmlBytes({ bytes, entity: j.entity, access_key: j.access_key, model: j.entity === "nfe" ? "55" : "65", expected_sha256: document.sha256 }, deps.hash);
      if (bytes.length !== document.size || JSON.stringify(checked.metadata) !== JSON.stringify(Object.fromEntries(Object.entries(document.metadata).filter(([k]) => !["profile", "generation"].includes(k))))) return invalid();
      await deps.revalidate(ctx, unit.expected); budget();
      j = db.transaction(() => {
        const row = guard(ctx, unit), current = journalOf(row); checkSource(current);
        const documents: XmlDocumentJournal[] = current.documents.map(d => d.sha256 === document.sha256 ? { ...d, phase: "verified" } : d);
        const updated: XmlJournal = { ...current, documents };
        db.exec("UPDATE wb_bling_unit SET progress=?,updated_at=? WHERE id=?", JSON.stringify({ ...json(row.progress), xml: updated }), ctx.clock.now(), unit.work_id);
        return updated;
      });
    }
    if (j.documents.some(d => d.phase !== "verified")) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    await deps.revalidate(ctx, unit.expected); budget();
    return db.transaction(() => {
      const prior = manifestReceipt(ctx, unit); if (prior) return prior;
      if (hasPendingXmlWrite(deps.profile, unit.work_id)) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
      guard(ctx, unit); const source = checkSource(j);
      const attempt = one(db, "SELECT * FROM origin_fiscal__attempt WHERE id=?", j.attempt);
      if (!attempt || attempt.state !== "pending" || attempt.fingerprint !== j.fingerprint || attempt.source_hash !== j.source_hash || attempt.owner !== unit.lease!.owner || attempt.fence !== unit.lease!.fence) throw new BlingError("BLING_REVISION_CONFLICT");
      for (const d of j.documents) {
        requireObjectAvailable(d.sha256);
        const object = one(db, "SELECT * FROM origin_fiscal__object WHERE hash=?", d.sha256);
        if (object && (object.size !== d.size || json(object.metadata).profile !== deps.profile || json(object.metadata).key !== j.access_key)) return invalid();
        if (!object) {
          db.exec("INSERT INTO origin_fiscal__object(hash,size,metadata,created_at) VALUES(?,?,?,?)", d.sha256, d.size, JSON.stringify({ ...d.metadata, verified_at: ctx.clock.now(), storage_key: d.key }), ctx.clock.now());
          db.exec("UPDATE wb_bling_control SET xml_bytes=xml_bytes+?,updated_at=? WHERE id=1", d.size, ctx.clock.now());
        }
      }
      let revision = one(db, "SELECT * FROM origin_fiscal__revision WHERE source=? AND manifest_hash=?", j.source, j.manifest_hash);
      if (!revision) {
        const id = deps.randomId();
        db.exec("INSERT INTO origin_fiscal__revision(id,source,revision,manifest_hash,source_status,collected_at) VALUES(?,?,?,?,?,?)", id, j.source, source.next_revision, j.manifest_hash, attempt.source_status, ctx.clock.now());
        for (const d of j.documents) db.exec("INSERT INTO origin_fiscal__item(id,revision,object_hash) VALUES(?,?,?)", deps.randomId(), id, d.sha256);
        db.exec("UPDATE origin_fiscal__source SET next_revision=next_revision+1 WHERE id=?", j.source);
        revision = one(db, "SELECT * FROM origin_fiscal__revision WHERE id=?", id)!;
      }
      const summaries = j.documents.map(d => {
        const item = one(db, "SELECT * FROM origin_fiscal__item WHERE revision=? AND object_hash=?", revision.id, d.sha256);
        if (!item) return invalid();
        return metadataSummary({ ...j, ...d } as XmlJournal, String(item.id), Number(revision.revision));
      });
      db.exec("UPDATE origin_fiscal__attempt SET state='stored',finished_at=?,manifest_hash=?,result=? WHERE id=? AND state='pending'", ctx.clock.now(), j.manifest_hash, JSON.stringify({ revision_id: revision.id, objects: j.documents.map(d => ({ hash: d.sha256, size: d.size })) }), j.attempt);
      db.exec("UPDATE origin_fiscal__source SET state='stored',current_revision=?,last_fingerprint=?,last_checked_at=?,last_success_at=?,next_attempt_at=?,last_error=NULL,failures=0 WHERE id=?", revision.id, j.fingerprint, ctx.clock.now(), ctx.clock.now(), ctx.clock.now() + 86_400_000, j.source);
      const result: BlingReceipt={command_id:unit.command_id,request_hash:unit.request_hash,generation:unit.expected.generation,operation:"xml_archive",state:"committed",committed_at:new Date(ctx.clock.now()).toISOString(),references:{xml:summaries[0] as unknown as JsonObject,xmls:summaries as unknown as JsonObject[],object_ids:summaries.map(s=>s.object_id),manifest_hash:j.manifest_hash},counts:{files:summaries.length,bytes:summaries.reduce((total,s)=>total+s.bytes,0)},error:null};
      db.exec("INSERT INTO wb_bling_receipt(command_id,operation,request_hash,generation,unit_id,attempt_id,state,result,references_json,created_at) VALUES(?,'xml_archive',?,?,?,?,'committed',?,?,?)", unit.command_id, unit.request_hash, unit.expected.generation, unit.work_id, unit.attempt_id, JSON.stringify(result), JSON.stringify(result.references), ctx.clock.now());
      db.exec("UPDATE wb_bling_unit SET phase='committed',finished_at=?,updated_at=? WHERE id=?", ctx.clock.now(), ctx.clock.now(), unit.work_id);
      return summaries;
    });
  }
  async function resumeXml(ctx: BlingContext, unit: BlingUnit): Promise<BlingXmlSummary> { return (await resumeXmlManifest(ctx, unit))[0]; }

  function failXml(ctx: BlingContext, unit: BlingUnit, options: { blocked: boolean; retry_at: number; code: "XML_INVALID" | "XML_UNAVAILABLE" | "XML_HASH_MISMATCH" | "XML_SCOPE_REQUIRED" }) {
    if (!["XML_INVALID", "XML_UNAVAILABLE", "XML_HASH_MISMATCH", "XML_SCOPE_REQUIRED"].includes(options.code) || !Number.isSafeInteger(options.retry_at) || options.retry_at < ctx.clock.now()) return invalid();
    area(ctx);
    if (ctx.origin === "external") throw new BlingError("BLING_SCOPE_REQUIRED");
    if (hasPendingXmlWrite(deps.profile, unit.work_id)) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 700 });
    const terminal = one(db, "SELECT * FROM wb_bling_unit WHERE id=?", unit.work_id);
    if (terminal?.phase === "superseded") {
      if (terminal.command_id !== unit.command_id || terminal.request_hash !== unit.request_hash || String(terminal.generation) !== unit.expected.generation) throw new BlingError("BLING_COMMAND_CONFLICT");
      return;
    }
    if (receipt(ctx, unit)) return;
    db.transaction(() => {
      const row = guard(ctx, unit), progress = json(row.progress), j = progress.xml ? journalOf(row) : progress.xml_intent;
      if (!j || typeof j.attempt !== "string" || typeof j.source !== "string") return invalid();
      const attempt = one(db, "SELECT state,owner,fence FROM origin_fiscal__attempt WHERE id=?", j.attempt);
      if (attempt?.state !== "pending") return;
      if (attempt.owner !== unit.lease!.owner || attempt.fence !== unit.lease!.fence) throw new BlingError("BLING_LEASE_LOST");
      // O bloqueio fica vinculado à credencial vigente: uma reautorização
      // posterior (nova revisão de credencial) libera uma nova tentativa.
      db.exec("UPDATE origin_fiscal__attempt SET state=?,finished_at=?,error_code=?,result=CASE WHEN ?=1 THEN json_set(coalesce(result,'{}'),'$.blocked_credential_revision',CAST(? AS INTEGER)) ELSE result END WHERE id=? AND state='pending'", options.blocked ? "blocked" : "retry", ctx.clock.now(), options.code, options.blocked ? 1 : 0, unit.expected.credential_revision, j.attempt);
      db.exec("UPDATE origin_fiscal__source SET state=?,next_attempt_at=?,last_error=?,failures=failures+1,last_checked_at=? WHERE id=? AND current_attempt=?", options.blocked ? "blocked" : "retry", options.retry_at, options.code, ctx.clock.now(), j.source, j.attempt);
      // A observação fiscal é terminal. A pista reserva outro comando quando vencer
      // next_attempt_at; a unidade antiga conserva seu journal para limpeza R2.
      db.exec("UPDATE wb_bling_unit SET phase='superseded',not_before=?,error_code=?,finished_at=?,updated_at=? WHERE id=?", options.retry_at, options.code, ctx.clock.now(), ctx.clock.now(), unit.work_id);
    });
  }

  const selection = `SELECT i.id AS object_id,s.entity,s.source_id,s.access_key,r.revision,r.collected_at,r.manifest_hash,o.hash,o.size,o.metadata FROM origin_fiscal__item i JOIN origin_fiscal__revision r ON r.id=i.revision JOIN origin_fiscal__source s ON s.id=r.source JOIN origin_fiscal__object o ON o.hash=i.object_hash WHERE json_extract(o.metadata,'$.profile')=? AND json_extract(o.metadata,'$.verified_at') IS NOT NULL AND EXISTS(SELECT 1 FROM origin_fiscal__attempt a WHERE a.source=s.id AND a.manifest_hash=r.manifest_hash AND a.state='stored' AND EXISTS(SELECT 1 FROM json_each(a.result,'$.objects') f WHERE json_extract(f.value,'$.hash')=o.hash AND json_extract(f.value,'$.size')=o.size))`;
  function rowSummary(r: Row): BlingXmlSummary {
    const m = json(r.metadata);
    return metadataSummary({ entity: r.entity, source_id: r.source_id, access_key: r.access_key, sha256: r.hash, size: r.size, metadata: m } as XmlJournal, String(r.object_id), Number(r.revision));
  }
  function listXml(ctx: BlingContext, input: BlingOperationMap["erp_bling_xml_list"]["input"]) {
    area(ctx); authorizeBlingOperation(ctx, "erp_bling_xml_list", input);
    deps.requireRead?.(ctx, "erp_bling_xml_list", input);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || input.entity && !["nfe", "nfce"].includes(input.entity)) return invalid();
    const clauses: string[] = [], params: unknown[] = [deps.profile];
    if (input.entity) { clauses.push("s.entity=?"); params.push(input.entity); }
    if (input.from) { const time = Date.parse(input.from); if (!Number.isFinite(time)) return invalid(); clauses.push("r.collected_at>=?"); params.push(time); }
    if (input.to) { const time = Date.parse(input.to); if (!Number.isFinite(time)) return invalid(); clauses.push("r.collected_at<=?"); params.push(time + 86_399_999); }
    const c = control();
    const filter = JSON.stringify([deps.profile, c?.account_id ?? null, String(c?.generation ?? ""), input.entity ?? null, input.from ?? null, input.to ?? null]);
    if (input.cursor) {
      if (input.cursor.length > 2048) return invalid();
      try { const cursor = JSON.parse(atob(input.cursor)); if (cursor.filter !== filter || typeof cursor.id !== "string" || cursor.id.length > 128) return invalid(); clauses.push("i.id>?"); params.push(cursor.id); } catch { return invalid(); }
    }
    const rows = db.exec(selection + (clauses.length ? " AND " + clauses.join(" AND ") : "") + " ORDER BY i.id LIMIT ?", ...params, limit + 1).rows;
    const items = rows.slice(0, limit).map(rowSummary);
    return { items, next_cursor: rows.length > limit ? btoa(JSON.stringify({ filter, id: items[items.length - 1].object_id })) : null };
  }
  async function readXml(ctx: BlingContext, objectId: string) {
    area(ctx);
    if (typeof objectId !== "string" || objectId.length > 128) return invalid();
    const row = one(db, selection + " AND i.id=?", deps.profile, objectId);
    if (!row) return invalid();
    const summary = rowSummary(row), key = blingXmlObjectKey(deps.profile, String(row.hash));
    const authInput = { object_id: objectId, entity: summary.entity };
    authorizeBlingOperation(ctx, "erp_bling_xml_get", authInput); deps.requireRead?.(ctx, "erp_bling_xml_get", authInput);
    if (json(row.metadata).storage_key !== key) return invalid();
    let bytes: Uint8Array;
    try { const object = await deps.media.get(key); if (!object || object.size !== undefined && object.size !== row.size) return invalid(); bytes = new Uint8Array(await object.arrayBuffer()); } catch { return invalid(); }
    await validateXmlBytes({ bytes, entity: summary.entity, access_key: summary.access_key, model: summary.model, expected_sha256: summary.sha256 }, deps.hash);
    area(ctx); authorizeBlingOperation(ctx, "erp_bling_xml_get", authInput); deps.requireRead?.(ctx, "erp_bling_xml_get", authInput);
    if (bytes.length !== row.size || !one(db, selection + " AND i.id=? AND o.hash=?", deps.profile, objectId, row.hash)) return invalid();
    return { bytes, sha256: summary.sha256, filename: `${summary.entity}-${summary.access_key}-${summary.sha256.slice(0, 12)}.xml`, content_type: "application/xml" as const };
  }
  function xmlStatus(ctx: BlingContext) {
    area(ctx); authorizeBlingOperation(ctx, "erp_bling_status", {});
    const totals = one(db, "SELECT COUNT(*) AS objects,COALESCE(SUM(size),0) AS bytes FROM origin_fiscal__object WHERE json_extract(metadata,'$.profile')=?", deps.profile)!;
    return {
      objects: Number(totals.objects), bytes: Number(totals.bytes), complete: false as const,
      states: db.exec("SELECT state,COUNT(*) AS count,MAX(last_success_at) AS last_success_at,MIN(next_attempt_at) AS next_attempt_at FROM origin_fiscal__source GROUP BY state ORDER BY state").rows,
      errors: db.exec("SELECT last_error AS code,COUNT(*) AS count FROM origin_fiscal__source WHERE last_error IN ('XML_INVALID','XML_UNAVAILABLE','XML_HASH_MISMATCH','XML_SCOPE_REQUIRED') GROUP BY last_error ORDER BY last_error").rows,
      limitations: ["O estado armazenado não certifica integridade; cada download confere os bytes e o hash.", "Assinatura criptográfica e autorização fiscal não certificadas."],
    };
  }
  return { beginXml, archiveXml, archiveXmlManifest, resumeXml, resumeXmlManifest, failXml, listXml, readXml, xmlStatus };
}
