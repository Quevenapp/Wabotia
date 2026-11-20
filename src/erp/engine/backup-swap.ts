// Troca da restauração em etapas (engine/backup-pages.ts chama): o conteúdo
// conferido no estágio entra no banco em transações pequenas, com checkpoint
// a cada uma, em várias invocações. docs/ERP-PORTE.md, "Backup lógico em
// páginas".
//
// Por que em etapas: a troca numa transação só esgota a memória do objeto na
// Cloudflare (SQLITE_NOMEM medido com 248 MiB). Cada transação daqui apaga ou
// insere no máximo RESTORE_SWAP_TXN_BYTES de texto, por faixas de rowid.
//
// O banco fica incoerente no meio: a área fica parada para o ERP do início
// ao fim da troca (backup-state.ts, restoreSwapping), e a volta atrás é a
// recuperação no tempo do próprio objeto: a marca é gravada antes da primeira
// transação (RestoreBookmarks) e, se a troca não terminar, o objeto volta a
// ela e reinicia.
//
// Chaves estrangeiras valem por transação (defer_foreign_keys não atravessa
// o commit), então a ordem importa: apaga dos filhos para os pais e insere
// dos pais para os filhos, pelo grafo das FKs (restorePlan). Três casos:
// - tabela que aponta para si mesma (movimento que estorna outro): ordem de
//   rowid; se uma referência cair fora da transação, ela cresce até fechar;
// - ciclo entre tabelas com coluna anulável sem CHECK (a tentativa atual de
//   uma origem): a coluna entra nula e é completada depois, pela chave;
// - ciclo sem coluna assim (as duas pontas obrigatórias): o grupo vai numa
//   transação só, de propósito.
import { ALL_TABLES, RestoreTableWriter, applyRestoreRules, columns, q, recreateRestoreTriggers, tablePlan, type RestoreTrigger } from "./dump.ts";
import { Sha256 } from "./sha256-state.ts";
import type { BackupJob, RestoreSwapCursor } from "./backup-state.ts";

/** Texto (bytes de NDJSON ou de dados apagados) por transação da troca. */
export const RESTORE_SWAP_TXN_BYTES = 8 * 1024 * 1024;
/** Teto do crescimento de uma transação para fechar uma referência da própria tabela. */
export const RESTORE_SWAP_GROW_MAX_BYTES = 256 * 1024 * 1024;
/**
 * Prazo da troca, contado do começo dela (a conferência do estágio tem o
 * prazo da barreira). Passou, o objeto volta à marca. 60 min cobrem a troca
 * de alguns GiB; medir na Cloudflare.
 */
export const RESTORE_SWAP_MAX_MS = 60 * 60_000;
/** Invocações seguidas sem nenhuma transação confirmada na troca: o erro se repete, volta à marca. */
export const RESTORE_SWAP_MAX_STALLS = 3;
/** Tabelas por unidade na conferência das chaves estrangeiras. */
const CHECK_TABLES_PER_UNIT = 8;
const PAGE_ROWS = 256;

export const STAGE_KEY = "wb_restore_chunk:";
export const TRIGGER_KEY = "wb_restore_trigger:";
export const CARRY_KEY = "wb_restore_carry";
const pad = (n: number, width: number) => String(n).padStart(width, "0");
export const stagePrefix = (seq: number) => `${STAGE_KEY}${pad(seq, 7)}:`;
export const stageKey = (seq: number, chunk: number) => stagePrefix(seq) + pad(chunk, 6);
/** Fim lexicográfico de um prefixo de chave (":" + 1 = ";"). */
export const prefixEnd = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * A recuperação no tempo do objeto, atrás de uma interface pequena: no
 * objeto, ctx.storage (getCurrentBookmark e onNextSessionRestoreBookmark);
 * nos testes, uma falsa. Depois de pedir a volta, quem chamou reinicia o
 * objeto (ErpRestoreRestartError; o hub chama ctx.abort).
 */
export interface RestoreBookmarks {
  current(): Promise<string>;
  restoreOnNextSession(bookmark: string): Promise<void>;
}

/** As marcas do próprio armazenamento, se ele as oferece. */
export function storageBookmarks(storage: DurableObjectStorage): RestoreBookmarks | null {
  const s = storage as Partial<Pick<DurableObjectStorage, "getCurrentBookmark" | "onNextSessionRestoreBookmark">>;
  if (typeof s.getCurrentBookmark !== "function" || typeof s.onNextSessionRestoreBookmark !== "function") return null;
  return {
    current: () => s.getCurrentBookmark!.call(storage),
    restoreOnNextSession: async bookmark => { await s.onNextSessionRestoreBookmark!.call(storage, bookmark); },
  };
}

/** A volta à marca foi pedida: o objeto precisa reiniciar agora (nada mais roda nesta sessão). */
export class ErpRestoreRestartError extends Error {
  readonly code = "erp_restore_restart";
  constructor() {
    super("A restauração não terminou; o ERP desta área volta ao estado de antes e o objeto reinicia.");
    this.name = "ErpRestoreRestartError";
  }
}

/** A conferência do fim (linhas, hash, chaves estrangeiras) não bateu. */
export class ErpRestoreCheckError extends Error {
  readonly code = "erp_restore_check_failed";
  constructor(message: string) {
    super(message);
    this.name = "ErpRestoreCheckError";
  }
}

export const isForeignKeyError = (error: unknown) => error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);

/** Um grupo de tabelas na ordem das FKs: um componente do grafo (ciclo) ou uma tabela. */
export interface SwapGroup {
  /** Pais antes dos filhos dentro do grupo. */
  tables: string[];
  /** Ciclo sem coluna anulável: apagar e inserir o grupo numa transação. */
  atomic: boolean;
  /** Colunas que entram nulas e são completadas depois, por tabela. */
  fill: Record<string, string[]>;
}

interface ForeignKey { id: number; table: string; from: string }

/** Colunas citadas num CHECK da tabela (não podem ficar nulas de passagem). */
function checkedColumns(sql: SqlStorage, table: string): string {
  const row = sql.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).toArray()[0] as { sql?: string } | undefined;
  const text = row?.sql ?? "";
  let out = "";
  for (let at = text.search(/\bCHECK\s*\(/i); at >= 0; ) {
    let depth = 0, end = text.indexOf("(", at);
    for (let i = end; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) { end = i; break; }
    }
    out += text.slice(at, end + 1) + "\n";
    const next = text.slice(end + 1).search(/\bCHECK\s*\(/i);
    at = next < 0 ? -1 : end + 1 + next;
  }
  return out;
}
const mentions = (text: string, column: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])"?${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?([^A-Za-z0-9_]|$)`).test(text);

/** Ordem topológica (pais primeiro) de `nodes` com as arestas filho → pais; null se houver ciclo. */
function topo(nodes: string[], parents: (table: string) => Iterable<string>): string[] | null {
  const inGroup = new Set(nodes), state = new Map<string, 1 | 2>(), out: string[] = [];
  const visit = (node: string): boolean => {
    const s = state.get(node);
    if (s === 2) return true;
    if (s === 1) return false;
    state.set(node, 1);
    for (const parent of parents(node)) if (parent !== node && inGroup.has(parent) && !visit(parent)) return false;
    state.set(node, 2);
    out.push(node);
    return true;
  };
  for (const node of nodes) if (!visit(node)) return null;
  return out;
}

/**
 * O plano da troca: grupos em ordem de pais para filhos. Determinístico (a
 * ordem de ALL_TABLES e das FKs do esquema), recalculado a cada invocação.
 */
export function restorePlan(sql: SqlStorage): SwapGroup[] {
  const known = new Set(ALL_TABLES);
  const fks = new Map<string, ForeignKey[]>();
  for (const table of ALL_TABLES)
    fks.set(table, (sql.exec(`PRAGMA foreign_key_list(${q(table)})`).toArray() as unknown as ForeignKey[]).filter(fk => known.has(fk.table)));
  const parentsOf = (table: string) => new Set((fks.get(table) ?? []).map(fk => fk.table));
  // Componentes fortemente conexos (Tarjan): cada um sai depois dos que ele
  // alcança, isto é, os pais saem antes dos filhos.
  let counter = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (node: string) => {
    index.set(node, counter); low.set(node, counter); counter++;
    stack.push(node); onStack.add(node);
    for (const parent of parentsOf(node)) {
      if (parent === node) continue;
      if (!index.has(parent)) { connect(parent); low.set(node, Math.min(low.get(node)!, low.get(parent)!)); }
      else if (onStack.has(parent)) low.set(node, Math.min(low.get(node)!, index.get(parent)!));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== node);
      components.push(component.sort((a, b) => ALL_TABLES.indexOf(a) - ALL_TABLES.indexOf(b)));
    }
  };
  for (const table of ALL_TABLES) if (!index.has(table)) connect(table);
  return components.map(component => {
    if (component.length === 1) return { tables: component, atomic: false, fill: {} };
    // Ciclo entre tabelas: as FKs internas anuláveis, fora de CHECK e de chave
    // primária, numa tabela com chave, entram nulas e são completadas depois.
    const members = new Set(component), fill: Record<string, string[]> = {}, kept = new Map<string, Set<string>>();
    for (const table of component) {
      const info = sql.exec(`PRAGMA table_info(${q(table)})`).toArray() as { name: string; notnull: number; pk: number }[];
      const hasKey = info.some(c => c.pk > 0), checks = checkedColumns(sql, table);
      const byId = new Map<number, ForeignKey[]>();
      for (const fk of fks.get(table) ?? []) byId.set(fk.id, [...(byId.get(fk.id) ?? []), fk]);
      const parents = new Set<string>();
      for (const group of byId.values()) {
        const target = group[0].table;
        const deferrable = members.has(target) && target !== table && hasKey && group.every(fk => {
          const column = info.find(c => c.name === fk.from);
          return !!column && !column.notnull && !column.pk && !mentions(checks, fk.from);
        });
        if (deferrable) fill[table] = [...new Set([...(fill[table] ?? []), ...group.map(fk => fk.from)])];
        else parents.add(target);
      }
      kept.set(table, parents);
    }
    const order = topo(component, table => kept.get(table) ?? []);
    return order ? { tables: order, atomic: false, fill } : { tables: component, atomic: true, fill: {} };
  });
}

/** Ponto inicial da troca, com a marca já gravada. */
export function initialSwapCursor(plan: SwapGroup[], bookmark: string, now: number, control: Record<string, unknown> | null): RestoreSwapCursor {
  return {
    bookmark, started_at: now, deadline: now + RESTORE_SWAP_MAX_MS, step: "delete",
    group: plan.length - 1, table: (plan.at(-1)?.tables.length ?? 1) - 1, pass: 0,
    part: 0, chunk: 0, header: null, header_seen: false, after_rowid: null, rows: 0, sha: null, rows_done: 0,
    control, rollbacks: 0, stall_step: null, stalls: 0,
  };
}

export const triggerKey = (index: number) => TRIGGER_KEY + pad(index, 5);
export function saveTriggers(sql: SqlStorage, triggers: RestoreTrigger[]) {
  for (const [i, trigger] of triggers.entries()) putMeta(sql, triggerKey(i), JSON.stringify(trigger));
}

const getMeta = (sql: SqlStorage, key: string) =>
  (sql.exec("SELECT value FROM erp_meta WHERE key=?", key).toArray()[0] as { value?: string } | undefined)?.value ?? null;
const putMeta = (sql: SqlStorage, key: string, value: string) =>
  sql.exec("INSERT INTO erp_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
const changes = (sql: SqlStorage) => Number((sql.exec("SELECT changes() AS n").toArray()[0] as { n: unknown }).n);

export interface SwapContext {
  plan: SwapGroup[];
  /** Tabelas do manifesto (linhas e hash) e partes de cada uma, em ordem. */
  tables: readonly { table: string; rows: number; sha256: string }[];
  partsByTable: ReadonlyMap<string, readonly number[]>;
  profile: string;
  /** Texto desta transação; cresce só para fechar referência da própria tabela. */
  budget: number;
}

/** Faixa do topo da tabela (maiores rowids) com até `budget` bytes de dados. */
function topRange(sql: SqlStorage, table: string, budget: number): { from: string; bytes: number } | null {
  const size = columns(sql, table).map(c => `coalesce(length(CAST(${q(c.name)} AS BLOB)),0)`).join("+") || "0";
  let from: string | null = null, bytes = 0;
  for (;;) {
    const rows = sql.exec(`SELECT CAST(rowid AS TEXT) AS r, (${size}) AS n FROM ${q(table)}${from === null ? "" : " WHERE rowid < CAST(? AS INTEGER)"} ORDER BY rowid DESC LIMIT ${PAGE_ROWS}`,
      ...(from === null ? [] : [from])).toArray() as { r: string; n: unknown }[];
    for (const row of rows) {
      from = row.r;
      bytes += Number(row.n) + 16;
      if (bytes >= budget) return { from, bytes };
    }
    if (rows.length < PAGE_ROWS) return from === null ? null : { from, bytes };
  }
}

const UNLINK_ROWS = 2_000;

/** Apagar: grupos dos filhos para os pais; num ciclo, as referências completáveis primeiro viram nulas. */
function deleteStep(sql: SqlStorage, s: RestoreSwapCursor, ctx: SwapContext, left: number): number {
  const group = ctx.plan[s.group];
  const nextGroup = () => {
    s.group--; s.pass = 0;
    if (s.group < 0) Object.assign(s, { step: "insert", group: 0, table: 0, pass: 0, part: 0, chunk: 0, header: null, header_seen: false });
    else s.table = ctx.plan[s.group].tables.length - 1;
  };
  if (group.atomic) {
    for (const table of [...group.tables].reverse()) sql.exec(`DELETE FROM ${q(table)}`);
    nextGroup();
    return left;
  }
  if (s.pass === 0) {
    for (const [table, cols] of Object.entries(group.fill)) {
      const linked = cols.map(c => `${q(c)} IS NOT NULL`).join(" OR ");
      sql.exec(`UPDATE ${q(table)} SET ${cols.map(c => `${q(c)}=NULL`).join(",")} WHERE rowid IN (SELECT rowid FROM ${q(table)} WHERE ${linked} LIMIT ${UNLINK_ROWS})`);
      if (changes(sql) >= UNLINK_ROWS) return UNLINK_ROWS * 64;
    }
    s.pass = 1;
    return 1;
  }
  const table = group.tables[s.table];
  const range = topRange(sql, table, left);
  if (!range) {
    if (--s.table < 0) nextGroup();
    return 1;
  }
  sql.exec(`DELETE FROM ${q(table)} WHERE rowid >= CAST(? AS INTEGER)`, range.from);
  return range.bytes;
}

/**
 * Lê o estágio de uma tabela a partir do cursor, pedaço por pedaço, até o
 * orçamento: cada linha vai ao gravador; o cabeçalho das partes seguintes é
 * pulado (já conferido no estágio). Sem `keep`, apaga o pedaço lido (o disco
 * não dobra). Devolve os bytes lidos e se a tabela acabou.
 */
function readStage(sql: SqlStorage, s: RestoreSwapCursor, table: string, seqs: readonly number[], left: number, open: (header: string) => RestoreTableWriter, keep: boolean): { bytes: number; done: boolean; writer: RestoreTableWriter | null } {
  let writer = s.header ? open(s.header) : null;
  let carry = getMeta(sql, CARRY_KEY) ?? "", bytes = 0;
  while (s.part < seqs.length && bytes < left) {
    const key = stageKey(seqs[s.part], s.chunk);
    const value = getMeta(sql, key);
    if (value === null) {
      if (carry) throw new Error(`Parte do estágio sem quebra de linha final: ${table}.`);
      s.part++; s.chunk = 0; s.header_seen = false;
      continue;
    }
    const lines = (carry + value).split("\n");
    carry = lines.pop()!;
    for (const line of lines) {
      if (!s.header_seen) {
        s.header_seen = true;
        if (s.part === 0) { s.header = line; writer = open(line); }
        continue;
      }
      if (!writer) throw new Error(`Estágio sem cabeçalho: ${table}.`);
      writer.push(line);
    }
    if (!keep) sql.exec("DELETE FROM erp_meta WHERE key=?", key);
    s.chunk++;
    bytes += value.length;
  }
  writer?.flush();
  if (carry) putMeta(sql, CARRY_KEY, carry); else sql.exec("DELETE FROM erp_meta WHERE key=?", CARRY_KEY);
  const done = s.part >= seqs.length;
  if (done) Object.assign(s, { part: 0, chunk: 0, header: null, header_seen: false });
  return { bytes: Math.max(bytes, 1), done, writer };
}

/** Inserir: grupos dos pais para os filhos; num ciclo, a segunda passada completa as referências. */
function insertStep(sql: SqlStorage, s: RestoreSwapCursor, ctx: SwapContext, left: number): number {
  const group = ctx.plan[s.group];
  const nextGroup = () => {
    Object.assign(s, { group: s.group + 1, table: 0, pass: 0 });
    if (s.group >= ctx.plan.length) Object.assign(s, { step: "verify", table: 0, after_rowid: null, rows: 0, sha: null });
  };
  if (!group) { nextGroup(); return 1; }
  if (group.atomic) {
    let bytes = 0;
    for (const table of group.tables) {
      for (;;) {
        const read = readStage(sql, s, table, ctx.partsByTable.get(table) ?? [], Number.MAX_SAFE_INTEGER, header => new RestoreTableWriter(sql, table, header), false);
        s.rows_done += read.writer?.rows ?? 0;
        bytes += read.bytes;
        if (read.done) break;
      }
    }
    nextGroup();
    return Math.max(bytes, left);
  }
  const table = group.tables[s.table];
  if (table === undefined) {
    if (s.pass === 0 && Object.keys(group.fill).length) Object.assign(s, { pass: 1, table: 0 });
    else nextGroup();
    return 1;
  }
  const fill = group.fill[table];
  if (s.pass === 1 && !fill) { s.table++; return 1; }
  const read = readStage(sql, s, table, ctx.partsByTable.get(table) ?? [], left,
    header => new RestoreTableWriter(sql, table, header, { nullColumns: fill, mode: s.pass === 1 ? "fill" : "insert" }),
    s.pass === 0 && !!fill);
  if (s.pass === 0) s.rows_done += read.writer?.rows ?? 0;
  if (read.done) s.table++;
  return read.bytes;
}

/** Conferir: cada tabela do manifesto relida como o backup a exporta; linhas e hash iguais. */
function verifyStep(sql: SqlStorage, s: RestoreSwapCursor, ctx: SwapContext, left: number): number {
  if (s.table >= ctx.tables.length) {
    // Tabela fora do manifesto tem de estar vazia (as regras do fim ainda não rodaram).
    const listed = new Set(ctx.tables.map(t => t.table));
    for (const table of ALL_TABLES) {
      if (listed.has(table)) continue;
      if (sql.exec(`SELECT 1 AS x FROM ${q(table)} LIMIT 1`).toArray().length)
        throw new ErpRestoreCheckError(`A conferência final não bateu: a tabela ${table} devia estar vazia.`);
    }
    Object.assign(s, { step: "check", table: 0, after_rowid: null, rows: 0, sha: null });
    return 1;
  }
  const entry = ctx.tables[s.table];
  const { cols, values, filter } = tablePlan(sql, entry.table);
  const select = values.map((value, i) => `${value} AS ${q(cols[i].name)}`).join(",");
  const sha = new Sha256(s.sha);
  if (!s.sha) sha.update(JSON.stringify(cols.map(c => c.name)) + "\n");
  let bytes = 0, ended = false;
  while (bytes < left) {
    const where = s.after_rowid === null ? filter : `${filter ? filter + " AND" : " WHERE"} rowid > CAST(? AS INTEGER)`;
    const params = s.after_rowid === null ? [PAGE_ROWS] : [s.after_rowid, PAGE_ROWS];
    let read = 0;
    for (const row of sql.exec(`SELECT CAST(rowid AS TEXT) AS "__wb_rowid",${select} FROM ${q(entry.table)}${where} ORDER BY rowid LIMIT ?`, ...params).raw()) {
      const record = row as unknown[];
      s.after_rowid = String(record[0]);
      const line = JSON.stringify(record.slice(1)) + "\n";
      sha.update(line);
      bytes += line.length;
      read++;
    }
    s.rows += read;
    if (read < PAGE_ROWS) { ended = true; break; }
  }
  if (!ended) { s.sha = sha.state(); return bytes; }
  if (s.rows !== entry.rows)
    throw new ErpRestoreCheckError(`A conferência final não bateu: ${entry.table} ficou com ${s.rows} linhas; o backup tem ${entry.rows}.`);
  if (sha.digest() !== entry.sha256)
    throw new ErpRestoreCheckError(`A conferência final não bateu: o conteúdo de ${entry.table} difere do backup.`);
  Object.assign(s, { table: s.table + 1, after_rowid: null, rows: 0, sha: null });
  return Math.max(bytes, 1);
}

/** Chaves estrangeiras de todas as tabelas, poucas por unidade (só leitura). */
function checkStep(sql: SqlStorage, s: RestoreSwapCursor): number {
  for (let n = 0; n < CHECK_TABLES_PER_UNIT && s.table < ALL_TABLES.length; n++, s.table++) {
    const broken = sql.exec(`PRAGMA foreign_key_check(${q(ALL_TABLES[s.table])})`).toArray();
    if (broken.length) throw new ErpRestoreCheckError("A conferência final não bateu: chave estrangeira quebrada " + JSON.stringify(broken[0]).slice(0, 200) + ".");
  }
  if (s.table >= ALL_TABLES.length) Object.assign(s, { step: "finish", table: 0 });
  return 1;
}

/** Fim: as regras de sempre, os gatilhos de volta e as FKs das tabelas que as regras tocam. */
function finishStep(sql: SqlStorage, s: RestoreSwapCursor, ctx: SwapContext) {
  applyRestoreRules(sql, s.control, ctx.profile);
  const triggers = (sql.exec("SELECT value FROM erp_meta WHERE key >= ? AND key < ? ORDER BY key", TRIGGER_KEY, prefixEnd(TRIGGER_KEY)).toArray() as { value: string }[])
    .map(row => JSON.parse(row.value) as RestoreTrigger);
  recreateRestoreTriggers(sql, triggers);
  for (const table of ["wb_bling_unit", "wb_bling_control", "origin_sync__resource_state"]) {
    const broken = sql.exec(`PRAGMA foreign_key_check(${q(table)})`).toArray();
    if (broken.length) throw new ErpRestoreCheckError("A conferência final não bateu: chave estrangeira quebrada " + JSON.stringify(broken[0]).slice(0, 200) + ".");
  }
}

/**
 * Uma transação da troca (roda dentro do commit de backup-pages.ts): avança
 * o cursor até gastar o orçamento. Devolve true quando a troca terminou (o
 * banco está igual ao backup, com as regras e os gatilhos).
 */
export function swapUnit(storage: DurableObjectStorage, next: BackupJob, ctx: SwapContext): boolean {
  const sql = storage.sql, s = next.cursor.swap!;
  sql.exec("PRAGMA defer_foreign_keys = ON");
  let spent = 0;
  while (spent < ctx.budget) {
    const left = ctx.budget - spent;
    if (s.step === "delete") spent += deleteStep(sql, s, ctx, left);
    else if (s.step === "insert") spent += insertStep(sql, s, ctx, left);
    else if (s.step === "verify") spent += verifyStep(sql, s, ctx, left);
    else if (s.step === "check") { spent += checkStep(sql, s); break; }
    else { finishStep(sql, s, ctx); return true; }
  }
  return false;
}
