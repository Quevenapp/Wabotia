// Estado durável do backup e da restauração em páginas (engine/backup-pages.ts)
// e a barreira de escrita que faz do backup um retrato de um instante.
// Leve de propósito: o hub (src/erp/hub.ts) lê o trabalho e a barreira sem
// importar o motor, e o /erp-rpc confere a barreira antes de gravar.
//
// O trabalho mora na erp_meta (chave/valor, fora do DDL gerado e do backup):
// nada de tabela nova nem de mudança de esquema. Um trabalho por área.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { Sha256State } from "./sha256-state.ts";

export const BACKUP_JOB_KEY = "wb_backup_job";
/**
 * Marca no KV do objeto: há (ou pode haver) trabalho de backup. O caminho de
 * controle (/erp-parts, /erp-wake, alarme sem trabalho) só lê o KV e nunca
 * toca o SQL; com a marca, o hub confere o trabalho na erp_meta.
 */
export const BACKUP_ACTIVE_KV = "erp_backup_active";

/** Sem progresso por este tempo, a barreira cai sozinha (queda sem retomada). */
export const BACKUP_BARRIER_LEASE_MS = 120_000;
/**
 * Prazo absoluto da barreira desde o início do trabalho. Medido na Cloudflare
 * (20/11/2026): o backup em páginas leva cerca de 5 min por GiB de NDJSON
 * (496 MiB em 165 s; no Node, 1 GiB em 36 s; ver docs/ERP-PORTE.md, "Backup
 * lógico em páginas"); 60 min equivalem a ~10 GiB de NDJSON, perto do teto de
 * 10 GB da área (antes, no Node, pareciam ~100 GiB).
 * Passou do prazo, o trabalho falha, as partes são limpas e as escritas voltam.
 */
export const BACKUP_BARRIER_MAX_MS = 60 * 60_000;

export type BackupJobKind = "backup" | "restore";
/**
 * Restauração: "stage" (confere e guarda o texto; banco intacto), "swap" (a
 * troca em etapas; a área fica parada para o ERP), "rollback" (a troca não
 * terminou: o objeto volta à marca gravada antes dela e reinicia).
 */
export type BackupJobPhase = "export" | "publish" | "stage" | "swap" | "rollback" | "cleanup" | "done" | "failed";

export interface BackupJobError { code: string; message: string }

export interface BackupJobCursor {
  /** Backup: tabela atual (índice em DUMP_TABLES), último rowid exportado e parte da tabela. */
  table_index: number;
  after_rowid: string | null;
  table_part: number;
  table_rows: number;
  /** Hash da tabela inteira (o mesmo NDJSON do formato 1), retomável entre invocações. */
  table_sha: Sha256State | null;
  /** Cabeçalho (colunas JSON) da tabela atual, para conferir as partes seguintes. */
  table_header: string | null;
  /** Backup: próxima parte (ordem global). Restauração: próxima parte a conferir. */
  part_seq: number;
  /** Restauração: SHA-256 do manifesto lido no início (não pode mudar no meio). */
  manifest_sha: string | null;
  /** Restauração: a troca em etapas, depois de gravada a marca de volta. Ausente antes. */
  swap?: RestoreSwapCursor | null;
}

export type RestoreSwapStep = "delete" | "insert" | "verify" | "check" | "finish";

/** Onde a troca em etapas está; cada transação pequena grava o próximo ponto junto. */
export interface RestoreSwapCursor {
  /** Marca da recuperação no tempo gravada antes da primeira transação da troca. */
  bookmark: string;
  started_at: number;
  /** Prazo da troca: passou, o objeto volta à marca. */
  deadline: number;
  step: RestoreSwapStep;
  /** Grupo de tabelas (ordem das chaves estrangeiras) e tabela dentro dele. */
  group: number;
  table: number;
  /** Inserção: 0 grava as linhas; 1 completa as referências que fecham um ciclo. */
  pass: number;
  /** Inserção: parte da tabela e pedaço do estágio; o resto de linha fica em erp_meta. */
  part: number;
  chunk: number;
  header: string | null;
  header_seen: boolean;
  /** Conferência: último rowid lido, linhas e hash retomável da tabela. */
  after_rowid: string | null;
  rows: number;
  sha: Sha256State | null;
  /** Linhas inseridas até aqui (todas as tabelas). */
  rows_done: number;
  /** Controle da coleta antes da troca (as regras do fim avançam as revisões a partir dele). */
  control: Record<string, unknown> | null;
  /** Pedidos de volta à marca já feitos (se a volta não se confirmar, o objeto continua parado). */
  rollbacks: number;
  /** Erro que se repete: invocações seguidas que começaram no mesmo ponto sem confirmar nada. */
  stall_step: number | null;
  stalls: number;
}

export interface BackupJobProgress {
  tables_total: number;
  tables_done: number;
  rows_total: number;
  rows_done: number;
  parts_total: number | null;
  parts_done: number;
  /** Bytes compactados (gzip) gravados ou lidos no R2. */
  bytes: number;
  /** Bytes de NDJSON (texto exportado, antes do gzip). */
  text_bytes: number;
}

export interface BackupJob {
  id: string;
  kind: BackupJobKind;
  phase: BackupJobPhase;
  profile: string;
  prefix: string;
  schema_hash: string;
  created_at: string;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  /** Escritas do ERP recusadas até este instante (renovado a cada unidade); 0 = solta. */
  barrier_until: number;
  barrier_deadline: number;
  barrier_released_at: number | null;
  /** Contador de unidades confirmadas: troca condicional entre execuções concorrentes. */
  step: number;
  invocations: number;
  cursor: BackupJobCursor;
  progress: BackupJobProgress;
  external_objects: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: BackupJobError | null;
}

const ACTIVE: ReadonlySet<BackupJobPhase> = new Set(["export", "publish", "stage", "swap", "rollback", "cleanup"]);
export const backupJobActive = (job: BackupJob | null): job is BackupJob => !!job && ACTIVE.has(job.phase);

/**
 * A troca da restauração está em curso (ou voltando à marca): o banco pode
 * estar incoerente, e a área fica inteira parada para o ERP, leituras
 * inclusive, sem depender do prazo da barreira. Só o fim da troca (concluída,
 * ou de volta à marca) solta.
 */
export const restoreSwapping = (job: BackupJob | null): job is BackupJob =>
  !!job && job.kind === "restore" && (job.phase === "swap" || job.phase === "rollback");
export const ERP_RESTORE_SWAPPING_CODE = "erp_restore_swapping";
export const ERP_RESTORE_SWAPPING_MESSAGE = "O ERP desta área está sendo restaurado. Volte em alguns minutos.";

/** Recusa de qualquer pedido ao ERP da área durante a troca. */
export function restoreSwappingResponse(): Response {
  const code = ERP_RESTORE_SWAPPING_CODE, message = ERP_RESTORE_SWAPPING_MESSAGE;
  return Response.json({ code, message, error: { code, message } }, { status: 503, headers: { "Retry-After": "60" } });
}

/** O trabalho gravado; null em instância sem erp_meta (nunca migrada) ou sem trabalho. */
export function readBackupJob(storage: DurableObjectStorage): BackupJob | null {
  try {
    const row = storage.sql.exec("SELECT value FROM erp_meta WHERE key=?", BACKUP_JOB_KEY).toArray()[0] as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? JSON.parse(row.value) as BackupJob : null;
  } catch {
    return null;
  }
}

export function writeBackupJob(storage: DurableObjectStorage, job: BackupJob): void {
  storage.sql.exec("INSERT INTO erp_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    BACKUP_JOB_KEY, JSON.stringify(job));
}

/** Barreira em vigor: dentro do prazo renovável e do prazo absoluto. */
export function barrierHeld(job: BackupJob | null, now: number): boolean {
  return backupJobActive(job) && job.barrier_until > 0 && now <= job.barrier_until && now <= job.barrier_deadline;
}

export interface BackupFence {
  code: "erp_backup_running" | "erp_restore_running";
  message: string;
  /** Quando tentar de novo, no máximo (a barreira é renovada enquanto há progresso). */
  retry_at: number;
}

/** A barreira que vale para esta área agora, ou null. */
export function backupFence(storage: DurableObjectStorage, now = Date.now()): BackupFence | null {
  const job = readBackupJob(storage);
  if (!job || !barrierHeld(job, now)) return null;
  return job.kind === "backup"
    ? { code: "erp_backup_running", message: "Backup do ERP em andamento: alterações ficam suspensas até ele terminar. Tente de novo em alguns minutos.", retry_at: Math.min(job.barrier_until, job.barrier_deadline) }
    : { code: "erp_restore_running", message: "Restauração do ERP em andamento: alterações ficam suspensas até ela terminar. Tente de novo em alguns minutos.", retry_at: Math.min(job.barrier_until, job.barrier_deadline) };
}

/** Escrita recusada pela barreira; nada foi gravado (a transação foi desfeita). */
export class ErpBackupFencedError extends Error {
  readonly code: BackupFence["code"];
  readonly status = 503;
  readonly retryAt: number;
  constructor(fence: BackupFence) {
    super(fence.message);
    this.name = "ErpBackupFencedError";
    this.code = fence.code;
    this.retryAt = fence.retry_at;
  }
}

const totalChanges = (storage: DurableObjectStorage) =>
  Number((storage.sql.exec("SELECT total_changes() AS n").toArray()[0] as { n: unknown }).n);

/**
 * Roda fn; com a barreira em vigor, dentro de uma transação que é desfeita se
 * fn gravou qualquer linha (total_changes conta inclusive gatilhos). Leitura
 * passa; escrita volta como ErpBackupFencedError, sem efeito. Não depende de
 * classificar cada RPC como leitura ou escrita.
 */
export function fencedWrite<T>(storage: DurableObjectStorage, fence: BackupFence | null, fn: () => T): T {
  if (!fence) return fn();
  return storage.transactionSync(() => {
    const before = totalChanges(storage);
    const result = fn();
    if (totalChanges(storage) !== before) throw new ErpBackupFencedError(fence);
    return result;
  });
}

/** Resposta HTTP da recusa: curta, com código próprio e quando tentar de novo. */
export function fencedResponse(fence: BackupFence | ErpBackupFencedError): Response {
  const code = fence.code, message = fence.message;
  const retryAt = fence instanceof ErpBackupFencedError ? fence.retryAt : fence.retry_at;
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return Response.json({ code, message, error: { code, message } }, { status: 503, headers: { "Retry-After": String(Math.min(seconds, 120)) } });
}

/** O que quem pediu vê: fase, progresso, barreira e resultado, sem caminhos internos. */
export function backupJobStatus(job: BackupJob | null, now = Date.now()) {
  if (!job) return { job: null };
  const p = job.progress;
  const swap = job.cursor.swap ?? null;
  // Restauração: conferir e guardar as partes é a primeira metade; a troca, a segunda.
  const staged = p.parts_total ? p.parts_done / p.parts_total : 0;
  const swapped = !swap ? 0
    : swap.step === "delete" ? 0.1
      : swap.step === "insert" ? 0.1 + 0.6 * (p.rows_total ? Math.min(1, swap.rows_done / p.rows_total) : 1)
        : swap.step === "verify" ? 0.75 : 0.9;
  const fraction = job.phase === "done" ? 1
    : job.kind === "backup"
      ? (p.rows_total ? p.rows_done / p.rows_total : p.tables_total ? p.tables_done / p.tables_total : 0)
      : job.phase === "swap" ? 0.5 + swapped / 2 : staged / 2;
  const held = barrierHeld(job, now);
  const releasedAt = job.barrier_released_at ?? (held ? null : job.finished_at ?? job.updated_at);
  return {
    job: {
      id: job.id, kind: job.kind, phase: job.phase, prefix: job.prefix,
      created_at: job.created_at, started_at: job.started_at, updated_at: job.updated_at, finished_at: job.finished_at,
      invocations: job.invocations, units: job.step,
      percent: Math.max(0, Math.min(100, Math.floor(fraction * 1000) / 10)),
      progress: { ...p },
      barrier: { active: held, until: held ? job.barrier_until : null, deadline: job.barrier_deadline,
        held_ms: releasedAt ? Math.max(0, releasedAt - job.started_at) : Math.max(0, now - job.started_at) },
      /** A área está parada para o ERP (troca da restauração em curso). */
      blocked: restoreSwapping(job),
      swap: swap && { step: swap.step, started_at: swap.started_at, deadline: swap.deadline, rows_done: swap.rows_done },
      external_objects: job.external_objects,
      result: job.result,
      error: job.error,
    },
  };
}
