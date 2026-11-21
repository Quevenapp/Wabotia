// O arquivo (SPED Fiscal, EFD-Contribuições ou SINTEGRA) montado aos poucos
// no alarme do objeto da área, no mesmo desenho do pacote do contador
// (src/erp/contador/package.ts): cada unidade lê poucas notas, normaliza e
// guarda; o fecho lê tudo, monta o texto, confere linha a linha contra o
// layout e grava as partes no R2. O download junta as partes na ordem.
//
// Etapas:
// 1. emitidas: as notas do emissor (cofre) com data de emissão no período:
//    o XML de cada NF-e e NFC-e (e da NFS-e, na EFD-Contribuições);
// 2. inutilizacoes: as faixas inutilizadas no período (SPED Fiscal e SINTEGRA);
// 3. recebidas: as notas recebidas com entrada ativa no ERP, pelo dia da
//    entrada (XML do R2 da área, conferido pelo SHA-256), com o produto que a
//    entrada ligou a cada item;
// 4. fechamento: cadastros, inventário (se pedido), montagem, conferência e gravação.
// Pendência que impede (XML ilegível, nota recebida sem XML, dado obrigatório)
// para o arquivo em "com pendências", com a lista; nada sai em silêncio.
// O mesmo período (tipo, ambiente, de, ate) tem um arquivo só: pedir de novo
// devolve o mesmo; refazer gera outro e as partes antigas vão para a limpeza.
// Nada é transmitido ao governo.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SqlDriver } from "../engine/driver.ts";
import type { ContadorSource, PackageMedia } from "../contador/package.ts";
import { buildSpedFile, spedFilename } from "./build.ts";
import {
  emptySpedCounts, SPED_KIND_LABELS, spedPeriodLabel, type SpedCounts, type SpedEnvironment, type SpedFileState, type SpedFileView, type SpedKind, type SpedProblem,
} from "./contract.ts";
import { conference, readCompany, readInventory, readProducts, readSpedSettings } from "./data.ts";
import { latin1 } from "./format.ts";
import type { SpedDocument, SpedInput } from "./model.ts";
import { asReceived, cancelled, parseNfeXml, parseNfseXml } from "./xml.ts";

export const T_FILE = "erp_sped__file";
export const T_DOC = "erp_sped__doc";
/** Poucas notas por unidade: cabe numa acordada do alarme. */
export const SPED_UNIT = Object.freeze({ issued: 10, received: 15, part_bytes: 8 * 1024 * 1024 });
const MAX_ATTEMPTS = 12;

export type SpedSource = Pick<ContadorSource, "issued" | "xml" | "voidRanges">;
export interface SpedDependencies {
  db: SqlDriver;
  profile: string;
  media: PackageMedia | null;
  /** null: a área não tem emissor configurado (as emitidas ficam de fora, com aviso). */
  source: (() => Promise<SpedSource>) | null;
  now(): number;
  random?(): string;
}

type Phase = "emitidas" | "inutilizacoes" | "recebidas" | "fechamento";
interface Cursor { page?: number; after?: string | null }
interface FileRow {
  id: string; kind: SpedKind; environment: SpedEnvironment; period_from: string; period_to: string; inventory_on: string | null;
  options: { previous_credit?: number }; state: SpedFileState; run: string; phase: Phase; cursor: Cursor; counts: SpedCounts;
  problems: SpedProblem[]; warnings: string[]; docs: number; parts: number; lines: number; bytes: number; sha256: string | null; filename: string | null;
  summary: Record<string, number | string> | null; error: string | null; attempts: number; retry_at: number; stale: string[];
  requested_by: string | null; created_at: number; updated_at: number; finished_at: number | null;
}

const parse = <T>(value: unknown, fallback: T): T => { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } };
function rowOf(r: Record<string, unknown>): FileRow {
  return {
    id: String(r.id), kind: String(r.kind) as SpedKind, environment: String(r.environment) as SpedEnvironment, period_from: String(r.period_from), period_to: String(r.period_to),
    inventory_on: r.inventory_on == null ? null : String(r.inventory_on), options: parse(r.options, {}), state: String(r.state) as SpedFileState, run: String(r.run),
    phase: String(r.phase) as Phase, cursor: parse(r.cursor, {}), counts: { ...emptySpedCounts(), ...parse(r.counts, {}) }, problems: parse(r.problems, []),
    warnings: parse(r.warnings, []), docs: Number(r.docs), parts: Number(r.parts), lines: Number(r.lines), bytes: Number(r.bytes), sha256: r.sha256 == null ? null : String(r.sha256),
    filename: r.filename == null ? null : String(r.filename), summary: r.summary == null ? null : parse(r.summary, null), error: r.error == null ? null : String(r.error),
    attempts: Number(r.attempts), retry_at: Number(r.retry_at), stale: parse(r.stale, []), requested_by: r.requested_by == null ? null : String(r.requested_by),
    created_at: Number(r.created_at), updated_at: Number(r.updated_at), finished_at: r.finished_at == null ? null : Number(r.finished_at),
  };
}
export function readFile(db: SqlDriver, id: string): FileRow | null {
  try { const r = db.exec(`SELECT * FROM "${T_FILE}" WHERE id=?`, id).rows[0]; return r ? rowOf(r) : null; } catch { return null; }
}
function save(db: SqlDriver, f: FileRow) {
  db.exec(`UPDATE "${T_FILE}" SET state=?, run=?, phase=?, cursor=?, counts=?, problems=?, warnings=?, docs=?, parts=?, lines=?, bytes=?, sha256=?, filename=?, summary=?, error=?,
      attempts=?, retry_at=?, stale=?, requested_by=?, inventory_on=?, options=?, updated_at=?, finished_at=? WHERE id=?`,
  f.state, f.run, f.phase, JSON.stringify(f.cursor), JSON.stringify(f.counts), JSON.stringify(f.problems.slice(0, 200)), JSON.stringify(f.warnings.slice(0, 30)), f.docs, f.parts,
  f.lines, f.bytes, f.sha256, f.filename, f.summary ? JSON.stringify(f.summary) : null, f.error ? f.error.slice(0, 500) : null, f.attempts, f.retry_at,
  JSON.stringify(f.stale.slice(-400)), f.requested_by, f.inventory_on, JSON.stringify(f.options), f.updated_at, f.finished_at, f.id);
}

const iso = (ms: number) => new Date(ms).toISOString();
export function fileView(f: FileRow): SpedFileView {
  return {
    id: f.id, kind: f.kind, kind_label: SPED_KIND_LABELS[f.kind], environment: f.environment, from: f.period_from, to: f.period_to, label: spedPeriodLabel(f.period_from, f.period_to),
    inventory_on: f.inventory_on, state: f.state, phase: f.phase, counts: f.counts, problems: f.problems, warnings: f.warnings, lines: f.state === "done" ? f.lines : 0,
    bytes: f.state === "done" ? f.bytes : 0, sha256: f.state === "done" ? f.sha256 : null, filename: f.state === "done" ? f.filename : null, summary: f.summary,
    error: f.error, requested_by: f.requested_by, created_at: iso(f.created_at), updated_at: iso(f.updated_at), finished_at: f.finished_at === null ? null : iso(f.finished_at),
  };
}
const objectPrefix = (profile: string, id: string, run: string) => `erp/${profile}/sped/${id}/${run}`;

export function spedRunning(db: SqlDriver): boolean {
  try { return db.exec(`SELECT 1 AS x FROM "${T_FILE}" WHERE state='running' LIMIT 1`).rows.length > 0; } catch { return false; }
}
export function spedNextWake(db: SqlDriver): number | null {
  try { const r = db.exec(`SELECT min(retry_at) AS due FROM "${T_FILE}" WHERE state='running'`).rows[0]; return r?.due == null ? null : Number(r.due); } catch { return null; }
}
export function listFiles(db: SqlDriver, limit = 60): SpedFileView[] {
  try { return db.exec(`SELECT * FROM "${T_FILE}" ORDER BY period_from DESC, kind, created_at DESC LIMIT ?`, limit).rows.map((r) => fileView(rowOf(r))); } catch { return []; }
}

/**
 * Pede o arquivo. O mesmo período devolve o mesmo (reused), salvo refazer ou
 * arquivo que falhou ou ficou com pendências. A conferência dos cadastros vem
 * antes: o que impede já fica na lista, sem ler nota nenhuma.
 */
export async function startFile(deps: Pick<SpedDependencies, "db" | "profile" | "now" | "random">, input: {
  id: string; kind: SpedKind; environment: SpedEnvironment; from: string; to: string; inventory: string | null; previousCredit: number; redo: boolean; actor: string | null;
}): Promise<{ file: SpedFileView; reused: boolean }> {
  const { db } = deps, now = deps.now();
  const previous = readFile(db, input.id);
  if (previous && !input.redo && previous.state !== "failed" && previous.state !== "blocked"
    && previous.inventory_on === input.inventory && (previous.options.previous_credit ?? 0) === input.previousCredit)
    return { file: fileView(previous), reused: true };
  const checked = await conference(db, { kind: input.kind, environment: input.environment, from: input.from, to: input.to, inventory: input.inventory });
  const blocking = checked.problems.filter((p) => p.blocking);
  const warnings = [checked.notice, ...checked.problems.filter((p) => !p.blocking).map((p) => p.message)].filter((w): w is string => !!w);
  const random = deps.random ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 16));
  const run = random();
  const state: SpedFileState = blocking.length ? "blocked" : "running";
  return db.transaction(() => {
    const old = readFile(db, input.id);
    const stale = old ? [...old.stale, ...(old.state === "done" ? Array.from({ length: old.parts }, (_, i) => `${objectPrefix(deps.profile, old.id, old.run)}/parte-${String(i + 1).padStart(5, "0")}`) : [])] : [];
    if (old) db.exec(`DELETE FROM "${T_DOC}" WHERE file_id=?`, input.id);
    else db.exec(`INSERT INTO "${T_FILE}"(id, kind, environment, period_from, period_to, inventory_on, options, state, run, phase, created_at, updated_at)
        VALUES(?,?,?,?,?,?,'{}','running',?,'emitidas',?,?)`, input.id, input.kind, input.environment, input.from, input.to, input.inventory, run, now, now);
    const base = readFile(db, input.id)!;
    const fresh: FileRow = { ...base, state, run, phase: "emitidas", cursor: {}, counts: emptySpedCounts(), problems: blocking, warnings, docs: 0, parts: 0, lines: 0, bytes: 0,
      sha256: null, filename: null, summary: null, error: blocking.length ? "Faltam dados para gerar o arquivo. Corrija a lista e gere de novo." : null, attempts: 0, retry_at: now,
      stale, requested_by: input.actor, inventory_on: input.inventory, options: { previous_credit: input.previousCredit }, updated_at: now, finished_at: blocking.length ? now : null };
    save(db, fresh);
    return { file: fileView(fresh), reused: false };
  });
}

/** As chaves do R2, na ordem, de um arquivo pronto. */
export function fileParts(db: SqlDriver, profile: string, id: string): { file: SpedFileView; keys: string[]; bytes: number; filename: string } | null {
  const f = readFile(db, id);
  if (!f || f.state !== "done") return null;
  const keys = Array.from({ length: f.parts }, (_, i) => `${objectPrefix(profile, f.id, f.run)}/parte-${String(i + 1).padStart(5, "0")}`);
  return { file: fileView(f), keys, bytes: f.bytes, filename: f.filename ?? `${f.kind}_${f.period_from}.txt` };
}

// ---------------------------------------------------------------------------
// Erros do emissor (como no pacote do contador)

interface SourceProblem { status?: number; code?: string; message?: string; retryable?: boolean }
const transient = (error: unknown) => { const e = error as SourceProblem; return typeof e?.status !== "number" || e.status >= 500 || e.status === 429 || e.retryable === true; };
const missing = (error: unknown) => { const e = error as SourceProblem; return e?.status === 404 || e?.code === "fiscal_xml_unavailable"; };
class Transient extends Error {}
class Stop extends Error {}
async function fetchOr<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error) {
    if (missing(error)) return null;
    if (transient(error)) throw new Transient();
    const e = error as SourceProblem;
    throw new Stop(e?.code === "vault_outdated" ? "O emissor de notas precisa de atualização para gerar o arquivo. Atualize o cofre e gere de novo."
      : e?.message ? `O emissor recusou a leitura: ${e.message}` : "O emissor recusou a leitura das notas. Confira o emissor em Fiscal › Certificado e emissor.");
  }
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const saoPauloDay = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
const NUMBER = (n: string | null) => n ?? "?";

// ---------------------------------------------------------------------------
// Uma unidade

interface Work { docs: { kind: string; data: SpedDocument }[]; counts: SpedCounts; problems: SpedProblem[]; warnings: string[]; cursor: Cursor; phase: Phase }
const addWarning = (work: Work, text: string) => { if (!work.warnings.includes(text) && work.warnings.length < 30) work.warnings.push(text); };

async function issuedUnit(f: FileRow, source: SpedSource, work: Work) {
  const page = f.cursor.page ?? 1;
  const listed = await fetchOr(() => source.issued({ from: f.period_from, to: f.period_to, environment: f.environment, page, per_page: SPED_UNIT.issued }));
  const items = listed?.items ?? [];
  for (const note of items) {
    if (note.kind === "nfse" && f.kind !== "efd_contribuicoes") continue;
    const valid = ["authorized", "cancelled", "contingency"].includes(note.status);
    if (!valid) continue; // rejeitada, em processamento, sem resposta: não é documento fiscal
    const label = `${note.kind === "nfce" ? "NFC-e" : note.kind === "nfse" ? "NFS-e" : "NF-e"} nº ${NUMBER(note.number)}`;
    if (!note.xml_available) { work.counts.without_xml++; addWarning(work, `A ${label} está sem XML no emissor e ficou de fora do arquivo.`); continue; }
    const xml = await fetchOr(() => source.xml(note.kind, note.provider_ref));
    if (!xml) { work.counts.without_xml++; addWarning(work, `A ${label} está sem XML no emissor e ficou de fora do arquivo.`); continue; }
    try {
      let doc = note.kind === "nfse" ? parseNfseXml(xml) : parseNfeXml(xml);
      if (note.status === "cancelled") { doc = cancelled(doc); work.counts.cancelled++; }
      work.docs.push({ kind: doc.kind, data: doc });
      if (doc.kind === "nfce") work.counts.nfce++; else if (doc.kind === "nfse") work.counts.nfse++; else work.counts.issued++;
    } catch (error) {
      work.problems.push({ kind: "nota", blocking: true, link: "/historico-fiscal",
        message: `O XML da ${label} não pôde ser lido (${error instanceof Error ? error.message : "formato desconhecido"}). Baixe o XML no emissor e confira.` });
    }
  }
  if (items.length < SPED_UNIT.issued) { work.phase = f.kind === "efd_contribuicoes" ? "recebidas" : "inutilizacoes"; work.cursor = {}; }
  else work.cursor = { page: page + 1 };
}

async function voidUnit(f: FileRow, source: SpedSource, work: Work) {
  const start = Date.parse(`${f.period_from}T00:00:00-03:00`), end = Date.parse(`${f.period_to}T00:00:00-03:00`) + 86_400_000;
  const ranges = (await fetchOr(() => source.voidRanges({ environment: f.environment }))) ?? [];
  for (const range of ranges) {
    const at = range.created_at ? Date.parse(range.created_at) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const model = range.kind === "nfce" ? "65" : "55";
    const doc: SpedDocument = {
      kind: "inutilizada", model, direction: "1", own: true, key: null, series: String(range.series), number: String(range.first), number_to: String(range.last),
      issued_on: saoPauloDay(at), io_on: null, situation: "05", finality: "1", nature: null, party: null, payment: "2", freight_mode: "9",
      totals: { doc: 0, products: 0, discount: 0, freight: 0, insurance: 0, other: 0, icms_base: 0, icms: 0, st_base: 0, st: 0, ipi: 0, pis: 0, cofins: 0 }, items: [], service: null, emitter_crt: null,
    };
    work.docs.push({ kind: "inutilizada", data: doc });
    work.counts.voided += range.last - range.first + 1;
  }
  work.phase = "recebidas"; work.cursor = {};
}

async function receivedUnit(f: FileRow, deps: SpedDependencies, work: Work) {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = deps.db.exec(`SELECT n.number, n.access_key, n.xml_key, n.xml_sha256, n.emitter_name, e.id AS entry_id, e.snapshot,
        coalesce(json_extract(e.result,'$.day'), n.issued_on) AS day
      FROM erp_purchase_inbound__note n JOIN erp_purchase_inbound__entry e ON e.note_id=n.id AND e.state='active'
      WHERE n.environment=? AND n.situation='autorizada' AND coalesce(json_extract(e.result,'$.day'), n.issued_on) BETWEEN ? AND ? AND e.id>? ORDER BY e.id LIMIT ?`,
    f.environment, f.period_from, f.period_to, f.cursor.after ?? "", SPED_UNIT.received).rows;
  } catch { rows = []; } // Esquema sem a compra pela nota recebida.
  for (const r of rows) {
    work.cursor = { after: String(r.entry_id) };
    const label = `nota recebida nº ${NUMBER(r.number == null ? null : String(r.number))} de ${String(r.emitter_name ?? "fornecedor")}`;
    let xml: string | null = null;
    if (r.xml_key && deps.media) {
      let bytes: Uint8Array | null = null;
      try { const object = await deps.media.get(String(r.xml_key)); bytes = object ? new Uint8Array(await object.arrayBuffer()) : null; }
      catch { throw new Transient(); }
      if (bytes && await sha256Hex(bytes) === String(r.xml_sha256)) xml = new TextDecoder().decode(bytes);
    }
    if (!xml) {
      work.problems.push({ kind: "nota", blocking: true, link: "/notas-recebidas-compras",
        message: `A ${label} não tem o XML guardado (ou o arquivo não confere): sem ele o arquivo não tem os itens. Importe o XML de novo em Compras › Notas recebidas.` });
      continue;
    }
    try {
      const doc = asReceived(parseNfeXml(xml), xml, String(r.day));
      // Itens ligados a produto na entrada: o código e a quantidade do cadastro.
      const snap = parse<{ lines?: { position?: number; product_id?: string | null; stock_quantity?: string | null }[] }>(r.snapshot, {});
      for (const line of snap.lines ?? []) {
        const item = doc.items.find((i) => i.n === Number(line.position));
        if (!item || typeof line.product_id !== "string") continue;
        item.product_id = line.product_id;
        if (typeof line.stock_quantity === "string" && /^\d+(\.\d+)?$/.test(line.stock_quantity)) item.qty = line.stock_quantity;
      }
      if (!doc.items.length) work.problems.push({ kind: "nota", blocking: true, link: "/notas-recebidas-compras", message: `A ${label} não tem itens no XML. Confira o arquivo da nota.` });
      work.docs.push({ kind: "entrada", data: doc });
      work.counts.received++;
    } catch (error) {
      work.problems.push({ kind: "nota", blocking: true, link: "/notas-recebidas-compras",
        message: `O XML da ${label} não pôde ser lido (${error instanceof Error ? error.message : "formato desconhecido"}).` });
    }
  }
  if (rows.length < SPED_UNIT.received) { work.phase = "fechamento"; work.cursor = {}; }
}

/** Uma unidade do alarme: no máximo um arquivo, uma etapa curta. */
export async function runSpedUnit(deps: SpedDependencies): Promise<{ worked: boolean; more: boolean }> {
  const { db, media } = deps;
  let job: Record<string, unknown> | undefined;
  try { job = db.exec(`SELECT id FROM "${T_FILE}" WHERE state='running' AND retry_at<=? ORDER BY retry_at, updated_at, id LIMIT 1`, deps.now()).rows[0]; }
  catch { return { worked: false, more: false }; }
  if (!job) return { worked: false, more: spedRunning(db) };
  const f = readFile(db, String(job.id))!;
  const ours = () => { const c = readFile(db, f.id); return c?.state === "running" && c.run === f.run && c.phase === f.phase && JSON.stringify(c.cursor) === JSON.stringify(f.cursor) ? c : null; };
  const fail = (message: string) => {
    db.transaction(() => { const c = ours(); if (c) save(db, { ...c, state: "failed", error: message, updated_at: deps.now(), finished_at: deps.now() }); });
    return { worked: true, more: spedRunning(db) };
  };
  if (!media) return fail("O armazenamento de arquivos não está disponível nesta instalação. Avise o suporte.");
  if (f.stale.length && media.delete) {
    const key = f.stale[0];
    try { await media.delete(key); } catch { /* fica para a próxima */ }
    db.transaction(() => { const c = readFile(db, f.id); if (c) save(db, { ...c, stale: c.stale.filter((k) => k !== key) }); });
  }
  if (f.phase === "fechamento") return closeFile(deps, f);
  const work: Work = { docs: [], counts: { ...f.counts }, problems: [...f.problems], warnings: [...f.warnings], cursor: f.cursor, phase: f.phase };
  try {
    let source: SpedSource | null = null;
    if (f.phase !== "recebidas" && deps.source) {
      try { source = await deps.source(); }
      catch (error) { if ((error as SourceProblem)?.status !== 409) throw new Transient(); source = null; }
    }
    if ((f.phase === "emitidas" || f.phase === "inutilizacoes") && !source) {
      addWarning(work, "As notas emitidas ficaram de fora: a área não tem o emissor de notas configurado (Fiscal › Certificado e emissor).");
      work.phase = "recebidas"; work.cursor = {};
    } else if (f.phase === "emitidas") await issuedUnit(f, source!, work);
    else if (f.phase === "inutilizacoes") await voidUnit(f, source!, work);
    else if (f.phase === "recebidas") await receivedUnit(f, deps, work);
  } catch (error) {
    if (error instanceof Stop) return fail(error.message);
    const attempts = f.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return fail("O emissor de notas não respondeu depois de várias tentativas. Gere o arquivo de novo mais tarde.");
    db.transaction(() => { const c = ours(); if (c) save(db, { ...c, attempts, retry_at: deps.now() + Math.min(5 * 60_000, 1_000 * 2 ** attempts), updated_at: deps.now() }); });
    return { worked: true, more: true };
  }
  db.transaction(() => {
    const c = ours();
    if (!c) return;
    let seq = c.docs;
    for (const d of work.docs) db.exec(`INSERT INTO "${T_DOC}"(file_id, run, seq, kind, data) VALUES(?,?,?,?,?)`, c.id, c.run, ++seq, d.kind, JSON.stringify(d.data));
    save(db, { ...c, phase: work.phase, cursor: work.cursor, counts: work.counts, problems: work.problems, warnings: work.warnings, docs: seq, attempts: 0, retry_at: deps.now(), updated_at: deps.now() });
  });
  return { worked: true, more: true };
}

/** Os dados do arquivo para os geradores: notas guardadas, empresa, configuração, produtos e inventário. */
export async function fileInput(db: SqlDriver, f: FileRow): Promise<SpedInput | { problems: SpedProblem[] }> {
  const company = readCompany(db);
  if (!company) return { problems: [{ kind: "empresa", blocking: true, link: "/empresa-configuracoes", message: "Os dados da empresa não estão cadastrados. Preencha em Empresa › Dados da empresa." }] };
  const documents = db.exec(`SELECT data FROM "${T_DOC}" WHERE file_id=? AND run=? ORDER BY seq`, f.id, f.run).rows.map((r) => parse<SpedDocument>(r.data, null as unknown as SpedDocument)).filter(Boolean);
  const ids = [...new Set(documents.flatMap((d) => d.items.map((i) => i.product_id).filter((v): v is string => !!v)))];
  const catalog = readProducts(db, ids);
  const products: SpedInput["products"] = {};
  for (const d of documents) for (const item of d.items) {
    const p = item.product_id ? catalog.get(item.product_id) : undefined;
    if (!p) { item.product_id = null; continue; }
    item.code = p.code;
    if (p.unit) item.unit = p.unit;
    products[p.code] = { description: p.name, unit: p.unit, ncm: p.ncm, gtin: p.gtin, cest: p.cest };
  }
  const inventory = f.inventory_on && f.kind !== "efd_contribuicoes" ? { day: f.inventory_on, items: await readInventory(db, f.inventory_on) } : null;
  return { kind: f.kind, from: f.period_from, to: f.period_to, company, settings: readSpedSettings(db), documents, inventory,
    previous_credit: Math.round(f.options.previous_credit ?? 0), products };
}

async function closeFile(deps: SpedDependencies, f: FileRow): Promise<{ worked: boolean; more: boolean }> {
  const { db, media } = deps;
  const finish = (patch: Partial<FileRow>) => {
    db.transaction(() => {
      const c = readFile(db, f.id);
      if (c?.state !== "running" || c.run !== f.run || c.phase !== "fechamento") return;
      save(db, { ...c, ...patch, updated_at: deps.now(), finished_at: deps.now() });
      if (patch.state === "done" || patch.state === "blocked") db.exec(`DELETE FROM "${T_DOC}" WHERE file_id=? AND run=?`, c.id, c.run);
    });
    return { worked: true, more: spedRunning(db) };
  };
  const input = await fileInput(db, f);
  if ("problems" in input) return finish({ state: "blocked", problems: [...f.problems, ...input.problems], error: "Faltam dados para gerar o arquivo. Corrija a lista e gere de novo." });
  const built = buildSpedFile(input);
  const counts = { ...f.counts, inventory_items: input.inventory?.items.length ?? 0 };
  const warnings = [...f.warnings, ...built.warnings].slice(0, 30);
  if (input.inventory && input.inventory.items.some((i) => i.amount === 0)) warnings.push("Há produtos no inventário sem custo médio: entraram com valor zero. Confira os custos no Estoque.");
  const problems = [...f.problems, ...built.problems];
  if (built.validation.length)
    problems.push({ kind: "conferencia", blocking: true, link: null,
      message: `A conferência do layout achou ${built.validation.length} problema(s) e o arquivo não foi gravado: ${built.validation.slice(0, 3).join("; ")}. Avise o suporte com esta mensagem.` });
  if (problems.some((p) => p.blocking) || built.text === null)
    return finish({ state: "blocked", problems, warnings, counts, summary: built.summary, error: "O arquivo não saiu: corrija o que está na lista e gere de novo." });
  const bytes = latin1(built.text);
  const prefix = objectPrefix(deps.profile, f.id, f.run);
  const parts = Math.max(1, Math.ceil(bytes.length / SPED_UNIT.part_bytes));
  try {
    for (let i = 0; i < parts; i++) await media!.put(`${prefix}/parte-${String(i + 1).padStart(5, "0")}`, bytes.subarray(i * SPED_UNIT.part_bytes, (i + 1) * SPED_UNIT.part_bytes));
  } catch { return { worked: true, more: true }; } // R2 fora: o fecho volta na próxima acordada.
  return finish({ state: "done", problems, warnings, counts, summary: built.summary, parts, lines: built.lines, bytes: bytes.length, sha256: await sha256Hex(bytes),
    filename: spedFilename(f.kind, input.company.cnpj, f.period_from, f.period_to), error: null });
}

/**
 * Os arquivos prontos que entram no pacote do contador do período
 * (src/erp/contador/package.ts, no fecho): mesmo ambiente, dentro do período
 * do pacote, com a opção "no pacote" ligada. null: o R2 não respondeu agora.
 */
export async function spedPackageExtras(db: SqlDriver, profile: string, media: PackageMedia | null, environment: string, from: string, to: string):
Promise<{ name: string; bytes: Uint8Array; date: string }[] | null> {
  if (!readSpedSettings(db).in_package || !media) return [];
  let files: FileRow[] = [];
  try {
    files = db.exec(`SELECT * FROM "${T_FILE}" WHERE state='done' AND environment=? AND period_from>=? AND period_to<=? ORDER BY kind, period_from`, environment, from, to).rows.map(rowOf);
  } catch { return []; }
  const out: { name: string; bytes: Uint8Array; date: string }[] = [];
  for (const f of files) {
    const located = fileParts(db, profile, f.id)!;
    const chunks: Uint8Array[] = [];
    for (const key of located.keys) {
      let object;
      try { object = await media.get(key); } catch { return null; }
      if (!object) { chunks.length = 0; break; }
      chunks.push(new Uint8Array(await object.arrayBuffer()));
    }
    if (!chunks.length) continue;
    const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    out.push({ name: `obrigacoes/${located.filename}`, bytes, date: f.period_to });
  }
  return out;
}
