// Pacote do contador, a parte que roda no objeto da área (src/erp/hub.ts):
// o pedido, a montagem aos poucos no alarme e a lista de partes para o
// download. Reaproveita o desenho do pacote do Bling
// (src/erp/bling/cutover-package.ts): cada unidade lê poucas notas, grava
// uma parte do ZIP no R2 e registra onde cada arquivo ficou; o fecho grava a
// planilha de índice e o diretório do ZIP; o download junta as partes na
// ordem, sem montar tudo na memória.
//
// O que entra, por etapa:
// 1. emitidas: as notas do emissor (cofre) com data de emissão no período
//    (NF-e, NFC-e e NFS-e): XML, PDF (DANFE e DANFCE; a NFS-e não tem PDF no
//    emissor), XML do cancelamento e das cartas de correção;
// 2. inutilizacoes: as faixas inutilizadas no período (XML);
// 3. recebidas: as notas recebidas com entrada ativa no ERP, pela data da
//    entrada (XML guardado no R2 da área, conferido pelo SHA-256; DANFE do
//    emissor quando a nota veio do cofre);
// 4. bling: as notas do acervo do Bling do período, marcadas como tal;
// 5. fechamento: a planilha (CSV) e o diretório do ZIP.
// A nota sem XML (rejeitada, ainda sem resposta) aparece só na planilha.
//
// O mesmo período (ambiente, de, ate) tem um pacote só: pedir de novo
// devolve o mesmo, pronto ou em montagem; "refazer" monta outro, e as partes
// antigas vão para a limpeza.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SqlDriver } from "../engine/driver.ts";
import type {
  FiscalEnvironment, FiscalFile, FiscalIssuedFilter, FiscalIssuedPage, FiscalKind, FiscalVoidResult,
} from "../emissor/provider.ts";
import {
  emptyCounts, periodLabel, type ContadorCounts, type ContadorEnvironment, type ContadorPackageState, type ContadorPackageView,
} from "./contract.ts";
import { concat, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, ZipPart, zipClosing, type ZipEntry } from "./zip.ts";

export const T_PACKAGE = "erp_contador__package";
export const T_PART = "erp_contador__part";

/** Poucas notas e poucos bytes por unidade: cabe numa acordada do alarme. */
export const CONTADOR_UNIT = Object.freeze({ issued: 5, received: 10, bling: 25, bytes: 6 * 1024 * 1024, wall_ms: 2500 });
/** Falhas passageiras seguidas antes de o pacote parar com a mensagem. */
const MAX_ATTEMPTS = 12;
const encoder = new TextEncoder();
/** Marca UTF-8 no começo do CSV: a planilha abre os acentos certos. */
const BOM_CHAR = String.fromCharCode(0xfeff);

export interface PackageMedia {
  put(key: string, bytes: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete?(key: string): Promise<unknown>;
}

/** O que o pacote lê do emissor (cofre), já com o contexto da área. */
export interface ContadorSource {
  issued(filter: FiscalIssuedFilter): Promise<FiscalIssuedPage>;
  get(kind: FiscalKind, ref: string): Promise<{ corrections?: number }>;
  xml(kind: FiscalKind, ref: string): Promise<string>;
  cancellationXml(kind: FiscalKind, ref: string): Promise<string>;
  correctionXml(ref: string, sequence: number): Promise<string>;
  danfe(ref: string): Promise<FiscalFile>;
  danfce(ref: string): Promise<FiscalFile>;
  voidRanges(filter: { environment?: FiscalEnvironment }): Promise<FiscalVoidResult[]>;
  voidRangeXml(ref: string): Promise<string>;
  receivedDanfe(ref: string): Promise<FiscalFile>;
}

export interface PackageDependencies {
  db: SqlDriver;
  profile: string;
  media: PackageMedia | null;
  /** null: a área não tem emissor configurado (as emitidas ficam de fora, com aviso). */
  source: (() => Promise<ContadorSource>) | null;
  /** XML conferido do acervo do Bling (src/erp/bling/xml.ts, verifiedXmlOf). */
  blingXml?: (db: SqlDriver, profile: string, entity: string, sourceId: string) => { key: string; sha256: string; access_key: string } | null;
  /** Arquivos prontos de SPED e SINTEGRA do período (src/erp/sped/job.ts), no fecho; null: o R2 não respondeu agora. */
  extras?: (environment: string, from: string, to: string) => Promise<{ name: string; bytes: Uint8Array; date: string }[] | null>;
  now(): number;
  random?(): string;
}

// ---------------------------------------------------------------------------
// Estado

type Phase = "emitidas" | "inutilizacoes" | "recebidas" | "bling" | "fechamento";
const PHASES: readonly Phase[] = ["emitidas", "inutilizacoes", "recebidas", "bling", "fechamento"];
interface Cursor { page?: number; after?: string | null }
interface PackageRow {
  id: string; environment: ContadorEnvironment; period_from: string; period_to: string; state: ContadorPackageState; run: string; phase: Phase;
  cursor: Cursor; counts: ContadorCounts; warnings: string[]; zip_offset: number; parts: number; entries: number; bytes: number;
  filename: string | null; error: string | null; attempts: number; retry_at: number; stale: string[];
  requested_by: string | null; created_at: number; updated_at: number; finished_at: number | null;
}

const parse = <T>(value: unknown, fallback: T): T => { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } };
function rowOf(r: Record<string, unknown>): PackageRow {
  return {
    id: String(r.id), environment: String(r.environment) as ContadorEnvironment, period_from: String(r.period_from), period_to: String(r.period_to),
    state: String(r.state) as ContadorPackageState, run: String(r.run), phase: String(r.phase) as Phase, cursor: parse(r.cursor, {}),
    counts: { ...emptyCounts(), ...parse(r.counts, {}) }, warnings: parse(r.warnings, []), zip_offset: Number(r.zip_offset), parts: Number(r.parts),
    entries: Number(r.entries), bytes: Number(r.bytes), filename: r.filename == null ? null : String(r.filename), error: r.error == null ? null : String(r.error),
    attempts: Number(r.attempts), retry_at: Number(r.retry_at), stale: parse(r.stale, []), requested_by: r.requested_by == null ? null : String(r.requested_by),
    created_at: Number(r.created_at), updated_at: Number(r.updated_at), finished_at: r.finished_at == null ? null : Number(r.finished_at),
  };
}
export function readPackage(db: SqlDriver, id: string): PackageRow | null {
  const r = db.exec(`SELECT * FROM "${T_PACKAGE}" WHERE id=?`, id).rows[0];
  return r ? rowOf(r) : null;
}
function save(db: SqlDriver, p: PackageRow) {
  db.exec(`UPDATE "${T_PACKAGE}" SET state=?, run=?, phase=?, cursor=?, counts=?, warnings=?, zip_offset=?, parts=?, entries=?, bytes=?, filename=?, error=?,
      attempts=?, retry_at=?, stale=?, requested_by=?, updated_at=?, finished_at=? WHERE id=?`,
  p.state, p.run, p.phase, JSON.stringify(p.cursor), JSON.stringify(p.counts), JSON.stringify(p.warnings.slice(0, 20)), p.zip_offset, p.parts, p.entries,
  p.bytes, p.filename, p.error, p.attempts, p.retry_at, JSON.stringify(p.stale.slice(-400)), p.requested_by, p.updated_at, p.finished_at, p.id);
}

const iso = (ms: number) => new Date(ms).toISOString();
export function packageView(p: PackageRow): ContadorPackageView {
  return {
    id: p.id, environment: p.environment, from: p.period_from, to: p.period_to, label: periodLabel(p.period_from, p.period_to), state: p.state,
    phase: p.phase, counts: p.counts, bytes: p.state === "done" ? p.bytes : 0, filename: p.state === "done" ? p.filename : null, error: p.error,
    requested_by: p.requested_by, created_at: iso(p.created_at), updated_at: iso(p.updated_at), finished_at: p.finished_at === null ? null : iso(p.finished_at),
  };
}
const objectPrefix = (profile: string, id: string, run: string) => `erp/${profile}/contador/${id}/${run}`;

/** Há pacote em montagem? Sem a tabela (esquema antigo), não há. */
export function contadorRunning(db: SqlDriver): boolean {
  try { return db.exec(`SELECT 1 AS x FROM "${T_PACKAGE}" WHERE state='running' LIMIT 1`).rows.length > 0; } catch { return false; }
}
/** Próxima unidade devida (ms), ou null. */
export function contadorNextWake(db: SqlDriver): number | null {
  try {
    const r = db.exec(`SELECT min(retry_at) AS due FROM "${T_PACKAGE}" WHERE state='running'`).rows[0];
    return r?.due == null ? null : Number(r.due);
  } catch { return null; }
}

export function listPackages(db: SqlDriver, limit = 60): ContadorPackageView[] {
  return db.exec(`SELECT * FROM "${T_PACKAGE}" ORDER BY period_from DESC, created_at DESC LIMIT ?`, limit).rows.map((r) => packageView(rowOf(r)));
}

/** Pede o pacote. O mesmo período devolve o mesmo pacote (reused), salvo refazer ou pacote que falhou. */
export function startPackage(deps: Pick<PackageDependencies, "db" | "profile" | "now" | "random">, input: {
  id: string; environment: ContadorEnvironment; from: string; to: string; redo: boolean; actor: string | null;
}): { package: ContadorPackageView; reused: boolean } {
  const { db } = deps, now = deps.now();
  const random = deps.random ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 16));
  return db.transaction(() => {
    const previous = readPackage(db, input.id);
    if (previous && !input.redo && previous.state !== "failed") return { package: packageView(previous), reused: true };
    const run = random();
    if (!previous) {
      db.exec(`INSERT INTO "${T_PACKAGE}"(id, environment, period_from, period_to, state, run, phase, cursor, counts, warnings, zip_offset, parts, entries, bytes,
          attempts, retry_at, stale, requested_by, created_at, updated_at) VALUES(?,?,?,?,'running',?,'emitidas','{}',?,'[]',0,0,0,0,0,?,'[]',?,?,?)`,
      input.id, input.environment, input.from, input.to, run, JSON.stringify(emptyCounts()), now, input.actor, now, now);
      return { package: packageView(readPackage(db, input.id)!), reused: false };
    }
    // Refazer: as partes antigas saem do registro e os arquivos vão para a limpeza.
    const old = db.exec(`SELECT object_key FROM "${T_PART}" WHERE package_id=? AND object_key IS NOT NULL`, input.id).rows.map((r) => String(r.object_key));
    if (previous.state === "done") old.push(`${objectPrefix(deps.profile, previous.id, previous.run)}/final`);
    db.exec(`DELETE FROM "${T_PART}" WHERE package_id=?`, input.id);
    const fresh: PackageRow = { ...previous, state: "running", run, phase: "emitidas", cursor: {}, counts: emptyCounts(), warnings: [], zip_offset: 0, parts: 0,
      entries: 0, bytes: 0, filename: null, error: null, attempts: 0, retry_at: now, stale: [...previous.stale, ...old], requested_by: input.actor,
      updated_at: now, finished_at: null };
    save(db, fresh);
    return { package: packageView(fresh), reused: false };
  });
}

/** As chaves do R2, na ordem, para o download de um pacote pronto. */
export function packageFiles(db: SqlDriver, profile: string, id: string): { package: ContadorPackageView; keys: string[]; bytes: number; filename: string } | null {
  const p = readPackage(db, id);
  if (!p || p.state !== "done") return null;
  const keys = db.exec(`SELECT object_key FROM "${T_PART}" WHERE package_id=? AND run=? AND object_key IS NOT NULL ORDER BY seq`, id, p.run).rows.map((r) => String(r.object_key));
  keys.push(`${objectPrefix(profile, p.id, p.run)}/final`);
  return { package: packageView(p), keys, bytes: p.bytes, filename: p.filename ?? `contador-${p.period_from}.zip` };
}

// ---------------------------------------------------------------------------
// Planilha de índice (CSV para planilha: ponto e vírgula, UTF-8 com BOM)

export const INDEX_HEADER = ["Origem", "Modelo", "Série", "Número", "Chave de acesso", "Data", "Destinatário ou emitente", "CPF/CNPJ", "CFOP principal",
  "Natureza da operação", "Valor", "Situação", "Arquivos no pacote"];
const cell = (v: string | number | null | undefined) => {
  const t = String(v ?? "").replace(/[\r\n]+/g, " ");
  // Planilha não executa fórmula vinda de dado de terceiro.
  const safe = /^[=+\-@\t]/.test(t) && !/^-?\d+(,\d+)?$/.test(t) ? `'${t}` : t;
  return /[;"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const csvLine = (values: readonly (string | number | null | undefined)[]) => values.map(cell).join(";");
const money = (reais: number | null | undefined) => {
  if (reais == null || !Number.isFinite(reais)) return "";
  const cents = Math.round(reais * 100), neg = cents < 0, a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}`;
};
const moneyCents = (cents: number | null) => cents == null ? "" : money(cents / 100);
const brDate = (day: string | null) => day ? day.slice(0, 10).split("-").reverse().join("/") : "";
const STATUS_LABELS: Record<string, string> = {
  authorized: "Autorizada", cancelled: "Cancelada", rejected: "Rejeitada", denied: "Denegada", processing: "Em processamento", error: "Erro na emissão",
  undetermined: "Sem resposta do governo", contingency: "Em contingência", autorizada: "Autorizada", cancelada: "Cancelada", denegada: "Denegada",
};
const BLING_SITUATIONS: Record<string, string> = { "1": "Pendente", "2": "Cancelada", "3": "Aguardando recibo", "4": "Rejeitada", "5": "Autorizada",
  "6": "Emitida DANFE", "7": "Registrada", "8": "Aguardando protocolo", "9": "Denegada", "10": "Consulta situação", "11": "Bloqueada" };
const MODEL: Record<string, string> = { nfe: "NF-e", nfce: "NFC-e", nfse: "NFS-e" };
const FOLDER: Record<string, string> = { nfe: "NFe", nfce: "NFCe", nfse: "NFSe" };

/** CFOP do primeiro item e a natureza da operação, lidos do XML (NFS-e: o código de tributação). */
export function xmlFacts(xml: string): { cfop: string | null; nature: string | null } {
  const tag = (name: string) => new RegExp(`<(?:[A-Za-z0-9]+:)?${name}>\\s*([^<]{1,200}?)\\s*</(?:[A-Za-z0-9]+:)?${name}>`).exec(xml)?.[1] ?? null;
  const unescape = (v: string | null) => v && v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return { cfop: tag("CFOP"), nature: unescape(tag("natOp") ?? tag("xTribNac") ?? tag("cTribNac")) };
}

const safeName = (value: string) => value.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 60) || "sem-chave";
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Período em ms (São Paulo, UTC−3, sem horário de verão desde 2019): início do primeiro dia e fim do último. */
const periodMs = (from: string, to: string) => ({ start: Date.parse(`${from}T00:00:00-03:00`), end: Date.parse(`${to}T00:00:00-03:00`) + 86_400_000 });
const saoPauloDay = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Erros do emissor

interface SourceProblem { status?: number; code?: string; message?: string; retryable?: boolean }
/** Falha passageira (rede, 5xx, limite): a mesma unidade volta mais tarde. */
const transient = (error: unknown) => {
  const e = error as SourceProblem;
  return typeof e?.status !== "number" || e.status >= 500 || e.status === 429 || e.retryable === true;
};
/** O arquivo não existe para esta nota (404, ainda sem XML): segue sem ele. */
const missing = (error: unknown) => { const e = error as SourceProblem; return e?.status === 404 || e?.code === "fiscal_xml_unavailable" || e?.status === 409 && /xml|arquivo/i.test(String(e.code ?? "")); };
class Transient extends Error {}
class Stop extends Error {}

/** Lê um arquivo do emissor: passageiro sobe (a unidade volta); ausente devolve null; outro erro para o pacote com a mensagem. */
async function fetchOr<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error) {
    if (missing(error)) return null;
    if (transient(error)) throw new Transient();
    const e = error as SourceProblem;
    throw new Stop(e?.code === "vault_outdated" ? "O emissor de notas precisa de atualização para montar o pacote. Atualize o cofre e peça o pacote de novo."
      : e?.message ? `O emissor recusou a leitura: ${e.message}` : "O emissor recusou a leitura das notas. Confira o emissor em Fiscal › Certificado e emissor.");
  }
}

// ---------------------------------------------------------------------------
// Uma unidade

interface UnitWork { part: ZipPart; rows: string[]; counts: ContadorCounts; cursor: Cursor; phase: Phase; warnings: string[] }

async function issuedUnit(p: PackageRow, source: ContadorSource, work: UnitWork) {
  const page = p.cursor.page ?? 1;
  const listed = await fetchOr(() => source.issued({ from: p.period_from, to: p.period_to, environment: p.environment, page, per_page: CONTADOR_UNIT.issued }));
  const items = listed?.items ?? [];
  for (const note of items) {
    const kind = note.kind, folder = `emitidas/${FOLDER[kind] ?? kind}`, day = (note.issued_at ?? p.period_from).slice(0, 10);
    const base = safeName(note.access_key || (kind === "nfse" && note.number ? `nfse-${note.number}` : note.provider_ref));
    const files: string[] = [];
    let facts: { cfop: string | null; nature: string | null } = { cfop: null, nature: null };
    const hasXml = note.xml_available && ["authorized", "cancelled", "contingency"].includes(note.status);
    if (hasXml) {
      const xml = await fetchOr(() => source.xml(kind, note.provider_ref));
      if (xml) { facts = xmlFacts(xml); files.push(work.part.add(`${folder}/xml/${base}.xml`, encoder.encode(xml), day)); work.counts.xml++; }
      if (note.status === "cancelled") {
        const cancel = await fetchOr(() => source.cancellationXml(kind, note.provider_ref));
        if (cancel) { files.push(work.part.add(`${folder}/eventos/${base}-cancelamento.xml`, encoder.encode(cancel), day)); work.counts.events++; }
      }
      if (kind === "nfe") {
        const detail = await fetchOr(() => source.get(kind, note.provider_ref));
        const corrections = Math.min(20, Math.max(0, Number(detail?.corrections ?? 0)));
        for (let sequence = 1; sequence <= corrections; sequence++) {
          const letter = await fetchOr(() => source.correctionXml(note.provider_ref, sequence));
          if (letter) { files.push(work.part.add(`${folder}/eventos/${base}-carta-correcao-${String(sequence).padStart(2, "0")}.xml`, encoder.encode(letter), day)); work.counts.events++; }
        }
      }
      // PDF quando o emissor oferece (DANFE e DANFCE; a NFS-e não tem PDF no emissor).
      const pdf = kind === "nfe" ? await fetchOr(() => source.danfe(note.provider_ref)) : kind === "nfce" ? await fetchOr(() => source.danfce(note.provider_ref)) : null;
      if (pdf?.body?.length) { files.push(work.part.add(`${folder}/pdf/${base}.pdf`, new Uint8Array(pdf.body), day)); work.counts.pdf++; }
    }
    if (!files.some((f) => f.endsWith(".xml") && f.includes("/xml/"))) work.counts.without_xml++;
    work.counts.issued++;
    work.rows.push(csvLine(["Emitida", MODEL[kind] ?? kind, note.series, note.number ?? (note.dps_number != null ? `DPS ${note.dps_number}` : ""), note.access_key ?? "",
      brDate(note.issued_at), note.recipient?.name ?? "", note.recipient?.document ?? "", facts.cfop ?? "", facts.nature ?? "", money(note.total),
      STATUS_LABELS[note.status] ?? note.status, files.join(" | ") || "só na planilha"]));
  }
  // Página incompleta: acabaram as emitidas do período.
  if (items.length < CONTADOR_UNIT.issued) { work.phase = "inutilizacoes"; work.cursor = {}; }
  else work.cursor = { page: page + 1 };
}

async function voidUnit(p: PackageRow, source: ContadorSource, work: UnitWork) {
  const { start, end } = periodMs(p.period_from, p.period_to);
  const ranges = (await fetchOr(() => source.voidRanges({ environment: p.environment }))) ?? [];
  for (const range of ranges) {
    const at = range.created_at ? Date.parse(range.created_at) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const day = saoPauloDay(at), model = range.kind === "nfce" ? "NFCe" : "NFe";
    let file = "";
    if (range.xml_available) {
      const xml = await fetchOr(() => source.voidRangeXml(range.provider_ref));
      if (xml) { file = work.part.add(`emitidas/inutilizacoes/${model}-serie${range.series}-${range.first}-a-${range.last}.xml`, encoder.encode(xml), day); work.counts.events++; }
    }
    work.counts.void_ranges++;
    work.rows.push(csvLine(["Inutilização", range.kind === "nfce" ? "NFC-e" : "NF-e", range.series, `${range.first} a ${range.last}`, "", brDate(day), "", "", "",
      range.justification ?? "", "", "Inutilizada", file || "só na planilha"]));
  }
  work.phase = "recebidas"; work.cursor = {};
}

async function receivedUnit(p: PackageRow, deps: PackageDependencies, source: ContadorSource | null, work: UnitWork) {
  const { start, end } = periodMs(p.period_from, p.period_to);
  let rows: Record<string, unknown>[] = [];
  try {
    rows = deps.db.exec(`SELECT n.source, n.received_id, n.access_key, n.emitter_document, n.emitter_name, n.series, n.number, n.issued_on, n.total_cents,
        n.situation, n.nature, n.cfops, n.xml_key, n.xml_sha256, e.id AS entry_id, e.created_at AS entry_at
      FROM erp_purchase_inbound__note n JOIN erp_purchase_inbound__entry e ON e.note_id=n.id AND e.state='active'
      WHERE n.environment=? AND e.created_at>=? AND e.created_at<? AND e.id>? ORDER BY e.id LIMIT ?`,
    p.environment, start, end, p.cursor.after ?? "", CONTADOR_UNIT.received).rows;
  } catch { rows = []; } // Esquema sem a compra pela nota recebida: nada a incluir.
  for (const r of rows) {
    const key = String(r.access_key), day = saoPauloDay(Number(r.entry_at)), files: string[] = [];
    if (r.xml_key && deps.media) {
      let bytes: Uint8Array | null = null;
      try { const object = await deps.media.get(String(r.xml_key)); bytes = object ? new Uint8Array(await object.arrayBuffer()) : null; }
      catch { throw new Transient(); }
      if (bytes && await sha256Hex(bytes) === String(r.xml_sha256)) { files.push(work.part.add(`recebidas/xml/${safeName(key)}.xml`, bytes, day)); work.counts.xml++; }
    }
    const ref = typeof r.received_id === "string" && r.received_id.startsWith("rcb_") ? r.received_id.slice(4) : null;
    if (ref && source && files.length) {
      const pdf = await fetchOr(() => source.receivedDanfe(ref)).catch((error) => { if (error instanceof Stop) return null; throw error; });
      if (pdf?.body?.length) { files.push(work.part.add(`recebidas/pdf/${safeName(key)}.pdf`, new Uint8Array(pdf.body), day)); work.counts.pdf++; }
    }
    if (!files.length) work.counts.without_xml++;
    work.counts.received++;
    const cfops = parse<string[]>(r.cfops, []);
    work.rows.push(csvLine(["Recebida (com entrada)", "NF-e", r.series as number | null, r.number as number | null, key, brDate(String(r.issued_on ?? "")),
      String(r.emitter_name ?? ""), String(r.emitter_document ?? ""), cfops[0] ?? "", String(r.nature ?? ""), moneyCents(r.total_cents == null ? null : Number(r.total_cents)),
      STATUS_LABELS[String(r.situation)] ?? String(r.situation), files.join(" | ") || "só na planilha"]));
    work.cursor = { after: String(r.entry_id) };
    if (work.part.size > CONTADOR_UNIT.bytes) return;
  }
  if (rows.length < CONTADOR_UNIT.received) { work.phase = "bling"; work.cursor = {}; }
}

async function blingUnit(p: PackageRow, deps: PackageDependencies, work: UnitWork) {
  let rows: Record<string, unknown>[] = [];
  const after = p.cursor.after ?? "";
  try {
    rows = deps.db.exec(`SELECT r.entity, r.source_id, CAST(json_extract(r.payload,'$.numero') AS TEXT) AS numero, CAST(json_extract(r.payload,'$.serie') AS TEXT) AS serie,
        CAST(json_extract(r.payload,'$.chaveAcesso') AS TEXT) AS chave, substr(coalesce(json_extract(r.payload,'$.dataEmissao'), json_extract(r.payload,'$.dataOperacao')),1,10) AS emissao,
        CAST(coalesce(json_extract(r.payload,'$.valorNota'), json_extract(r.payload,'$.valor')) AS TEXT) AS valor,
        CAST(coalesce(json_extract(r.payload,'$.situacao.id'), json_extract(r.payload,'$.situacao.valor'), json_extract(r.payload,'$.situacao')) AS TEXT) AS situacao,
        CAST(json_extract(r.payload,'$.contato.nome') AS TEXT) AS nome, CAST(json_extract(r.payload,'$.contato.numeroDocumento') AS TEXT) AS documento
      FROM origin_sync__raw_record r WHERE r.entity IN ('nfe','nfce')
        AND substr(coalesce(json_extract(r.payload,'$.dataEmissao'), json_extract(r.payload,'$.dataOperacao')),1,10) BETWEEN ? AND ?
        AND (r.entity || ':' || printf('%020d', length(r.source_id)) || r.source_id) > ?
      ORDER BY r.entity, length(r.source_id), r.source_id LIMIT ?`, p.period_from, p.period_to, after, CONTADOR_UNIT.bling).rows;
  } catch { rows = []; } // Sem acervo do Bling nesta área.
  for (const r of rows) {
    const entity = String(r.entity), day = String(r.emissao ?? p.period_from).slice(0, 10), files: string[] = [];
    const found = deps.blingXml?.(deps.db, deps.profile, entity, String(r.source_id)) ?? null;
    if (found && deps.media) {
      let bytes: Uint8Array | null = null;
      try { const object = await deps.media.get(found.key); bytes = object ? new Uint8Array(await object.arrayBuffer()) : null; }
      catch { throw new Transient(); }
      if (bytes && await sha256Hex(bytes) === found.sha256) {
        files.push(work.part.add(`acervo-bling/${FOLDER[entity]}/${safeName(found.access_key || String(r.chave ?? "") || String(r.source_id))}.xml`, bytes, day));
        work.counts.xml++;
      }
    }
    if (!files.length) work.counts.without_xml++;
    work.counts.bling++;
    const valor = r.valor == null ? null : Number(String(r.valor).replace(",", "."));
    const situation = r.situacao == null ? "" : BLING_SITUATIONS[String(r.situacao)] ?? `código ${r.situacao}`;
    work.rows.push(csvLine(["Acervo do Bling", MODEL[entity], r.serie as string | null, r.numero as string | null, String(r.chave ?? ""), brDate(day),
      String(r.nome ?? ""), String(r.documento ?? ""), "", "", money(valor), situation, files.join(" | ") || "só na planilha"]));
    work.cursor = { after: `${entity}:${String(String(r.source_id).length).padStart(20, "0")}${r.source_id}` };
    if (work.part.size > CONTADOR_UNIT.bytes) return;
  }
  if (rows.length < CONTADOR_UNIT.bling) { work.phase = "fechamento"; work.cursor = {}; }
}

/** Uma unidade do alarme: no máximo um pacote, uma etapa curta, uma parte no R2. */
export async function runPackageUnit(deps: PackageDependencies): Promise<{ worked: boolean; more: boolean }> {
  const { db, profile, media } = deps;
  let job: Record<string, unknown> | undefined;
  try { job = db.exec(`SELECT id FROM "${T_PACKAGE}" WHERE state='running' AND retry_at<=? ORDER BY retry_at, updated_at, id LIMIT 1`, deps.now()).rows[0]; }
  catch { return { worked: false, more: false }; }
  if (!job) return { worked: false, more: contadorRunning(db) };
  const p = readPackage(db, String(job.id))!;
  const ours = () => { const c = readPackage(db, p.id); return c?.state === "running" && c.run === p.run && c.phase === p.phase && JSON.stringify(c.cursor) === JSON.stringify(p.cursor) ? c : null; };
  const fail = (message: string) => {
    db.transaction(() => { const c = ours(); if (c) save(db, { ...c, state: "failed", error: message, updated_at: deps.now(), finished_at: deps.now() }); });
    return { worked: true, more: contadorRunning(db) };
  };
  if (!media) return fail("O armazenamento de arquivos não está disponível nesta instalação. Avise o suporte.");
  // Limpeza dos arquivos de um pacote refeito (melhor esforço, um por unidade).
  if (p.stale.length && media.delete) {
    const key = p.stale[0];
    try { await media.delete(key); } catch { /* fica para a próxima */ }
    db.transaction(() => { const c = readPackage(db, p.id); if (c) save(db, { ...c, stale: c.stale.filter((k) => k !== key) }); });
  }
  const prefix = objectPrefix(profile, p.id, p.run);
  if (p.phase === "fechamento") return closePackage(deps, p, prefix);
  const work: UnitWork = { part: new ZipPart(p.zip_offset), rows: [], counts: { ...p.counts }, cursor: p.cursor, phase: p.phase, warnings: [...p.warnings] };
  try {
    let source: ContadorSource | null = null;
    if (deps.source) {
      try { source = await deps.source(); }
      // 409: a área não tem emissor (as emitidas ficam de fora, com aviso); outra falha volta mais tarde.
      catch (error) { if ((error as SourceProblem)?.status !== 409) throw new Transient(); source = null; }
    }
    if ((p.phase === "emitidas" || p.phase === "inutilizacoes") && !source) {
      const warning = "As notas emitidas ficaram de fora: a área não tem o emissor de notas configurado (Fiscal › Certificado e emissor).";
      if (!work.warnings.includes(warning)) work.warnings.push(warning);
      work.phase = "recebidas"; work.cursor = {};
    } else if (p.phase === "emitidas") await issuedUnit(p, source!, work);
    else if (p.phase === "inutilizacoes") await voidUnit(p, source!, work);
    else if (p.phase === "recebidas") await receivedUnit(p, deps, source, work);
    else if (p.phase === "bling") await blingUnit(p, deps, work);
  } catch (error) {
    if (error instanceof Stop) return fail(error.message);
    // Passageira: a mesma unidade volta mais tarde, com espera crescente.
    const attempts = p.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return fail("O emissor de notas não respondeu depois de várias tentativas. Peça o pacote de novo mais tarde.");
    db.transaction(() => { const c = ours(); if (c) save(db, { ...c, attempts, retry_at: deps.now() + Math.min(5 * 60_000, 1_000 * 2 ** attempts), updated_at: deps.now() }); });
    return { worked: true, more: true };
  }
  if (p.entries + work.part.entries.length + 1 > ZIP_MAX_ENTRIES || work.part.offset > ZIP_MAX_BYTES)
    return fail("O período tem arquivos demais para um só pacote. Escolha um período menor (por exemplo, meio mês).");
  const seq = p.parts + 1, partKey = `${prefix}/parte-${String(seq).padStart(5, "0")}`;
  if (work.part.entries.length) {
    try { await media.put(partKey, work.part.bytes()); } catch { return { worked: true, more: true }; }
  }
  let stillOurs = true;
  db.transaction(() => {
    const c = ours();
    if (!c) { stillOurs = false; return; }
    if (work.part.entries.length || work.rows.length)
      db.exec(`INSERT INTO "${T_PART}"(package_id, run, seq, object_key, size, entries, "rows", created_at) VALUES(?,?,?,?,?,?,?,?)`,
        p.id, p.run, seq, work.part.entries.length ? partKey : null, work.part.size, JSON.stringify(work.part.entries), JSON.stringify(work.rows), deps.now());
    save(db, { ...c, phase: work.phase, cursor: work.cursor, counts: work.counts, warnings: work.warnings, zip_offset: work.part.offset,
      parts: work.part.entries.length || work.rows.length ? seq : c.parts, entries: c.entries + work.part.entries.length, bytes: work.part.offset,
      attempts: 0, retry_at: deps.now(), updated_at: deps.now() });
  });
  // Pacote refeito enquanto esta parte era gravada: o arquivo vai para a limpeza.
  if (!stillOurs && work.part.entries.length && media.delete) { try { await media.delete(partKey); } catch { /* órfão sem referência */ } }
  return { worked: true, more: true };
}

async function closePackage(deps: PackageDependencies, p: PackageRow, prefix: string): Promise<{ worked: boolean; more: boolean }> {
  const { db, media } = deps;
  const parts = db.exec(`SELECT entries, "rows" FROM "${T_PART}" WHERE package_id=? AND run=? ORDER BY seq`, p.id, p.run).rows
    .map((r) => ({ entries: parse<ZipEntry[]>(r.entries, []), rows: parse<string[]>(r.rows, []) }));
  const lines = [csvLine(INDEX_HEADER), ...parts.flatMap((part) => part.rows)];
  if (p.warnings.length) lines.push("", ...p.warnings.map((w) => csvLine(["Aviso", w])));
  const csv = encoder.encode(BOM_CHAR + lines.join("\r\n") + "\r\n");
  const slug = `${p.period_from}_a_${p.period_to}`;
  // Obrigações em arquivo do período (SPED e SINTEGRA prontos), na mesma parte final.
  const extras = deps.extras ? await deps.extras(p.environment, p.period_from, p.period_to).catch(() => null) : [];
  if (extras === null) return { worked: true, more: true };
  const extraPart = new ZipPart(p.zip_offset, parts.flatMap((part) => part.entries.map((e) => e.name)));
  for (const file of extras) extraPart.add(file.name, file.bytes, file.date);
  const closing = zipClosing([...parts.flatMap((part) => part.entries), ...extraPart.entries], extraPart.offset, { name: `indice-notas_${slug}.csv`, bytes: csv, date: p.period_to });
  const final = extras.length ? concat([extraPart.bytes(), closing.bytes]) : closing.bytes;
  try { await media!.put(`${prefix}/final`, final); } catch { return { worked: true, more: true }; }
  db.transaction(() => {
    const c = readPackage(db, p.id);
    if (c?.state !== "running" || c.run !== p.run || c.phase !== "fechamento") return;
    save(db, { ...c, state: "done", bytes: c.zip_offset + final.length, entries: closing.entries, filename: `contador_${slug}.zip`, error: null,
      updated_at: deps.now(), finished_at: deps.now() });
  });
  return { worked: true, more: contadorRunning(db) };
}

export { PHASES as CONTADOR_PHASES };
