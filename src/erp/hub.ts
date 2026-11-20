// ERP (Fagoo) dentro do Wabotia: a instância "erp:<área>" da classe
// Coordinator (sem classe nova de Durable Object, como as antigas instâncias
// do vínculo externo). Os dados do ERP ficam no SQLite do
// objeto (ctx.storage.sql). Fase 0: docs/ERP-FASE0.md.
//
// Regras da instância compartilhada:
// - nunca grava a chave "profile" do KV (a da área): grava kind="erp" e
//   erp_profile, e recusa chamada de outra área;
// - o Coordinator desvia "/erp-*" no topo do fetch e o alarme por kind, antes
//   de qualquer coisa da área (pipeline do WhatsApp, D1);
// - nunca chama a instância da área de forma síncrona.
import type { Env } from "../types";
import { applyErpPartsSnapshot, requireCurrentErpParts, ErpPartsControlError, currentErpParts, handleErpParts, ERP_PARTS_KEY } from "./parts-control.ts";
import { ERP_PARTS_DENIED_HEADER, ERP_PARTS_TTL_MS, readErpPartsSnapshot } from "./parts.ts";
import { decodeIdentity, IDENTITY_HEADER, SYSTEM_HEADER } from "./engine/identity.ts";
import { prepareBlingDispatch, blingFailureResponse } from "./bling/assembly.ts";
import { BLING_RECEIPTED_OPERATIONS, getBlingOperation } from "./bling/schema.ts";
import { BACKUP_ACTIVE_KV, backupFence, backupJobActive, backupJobStatus, fencedResponse, readBackupJob, restoreSwapping, restoreSwappingResponse } from "./engine/backup-state.ts";

/** A troca da restauração pediu a volta à marca: o objeto reinicia para a volta valer (backup-swap.ts). */
const isRestoreRestart = (error: unknown) => (error as { code?: unknown } | null)?.code === "erp_restore_restart";

/** Backup/restauração em páginas: quanto uma rota avança antes de responder 202 e deixar o resto ao alarme. */
const BACKUP_INLINE = { budgetMs: 10_000, maxUnits: 128 };
/** Cada acordada do alarme com trabalho de backup: orçamento e intervalo até a próxima. */
const BACKUP_ALARM = { budgetMs: 10_000, maxUnits: 128 };
const BACKUP_CONTINUE_MS = 100;
const BACKUP_RETRY_MS = 5_000;

/**
 * Motor e esquema por import dinâmico: o bundle os traz, mas só são avaliados
 * na primeira chamada do ERP (prova 7: partida do Worker de quem não liga o
 * ERP).
 */
let engineModule: Promise<typeof import("./hub-engine.ts")> | null = null;
const engine = () => (engineModule ??= import("./hub-engine.ts"));

export const ERP_KIND = "erp";
/** Instância "erp-cron" do Coordinator: só continua os lotes do cron (src/erp/scheduler/cron.ts). */
const ERP_CRON_KIND = "erp-cron";
const ERP_CRON_INSTANCE_NAME = "erp-cron";
const ERP_CRON_CONTINUE_DELAY_MS = 1_000;
export const ERP_PROFILE_HEADER = "x-erp-profile";
/** Compatibilidade de imports antigos; o wake não recebe autorização por blocos. */
export const ERP_OPTIONAL_BLOCKS = ["erp-fiscal", "erp-cobranca", "erp-pdv"] as const;

/** Stub da instância ERP da área (localização preferida: América do Sul). */
export function erpStub(env: Env, profile: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:" + profile), {
    locationHint: "sam",
  });
}

/** Chamada interna Worker → objeto ERP. */
export function erpFetch(
  env: Env,
  profile: string,
  path: `/erp-${string}`,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set(ERP_PROFILE_HEADER, profile);
  return erpStub(env, profile).fetch("https://coordinator" + path, {
    ...init,
    headers,
  });
}

// Somente persistência de evidência de uma operação já reivindicada. O motor
// exige novamente emissão, comando e token; esta exceção não faz envio/efeito.
const commercialEvidenceRpcs = new Set(["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"]);
export const isCommercialNfeEvidenceRequest = (path: string, request: Request): boolean =>
  request.method === "POST" && request.headers.get(SYSTEM_HEADER) === "1" &&
  commercialEvidenceRpcs.has(path.slice("/erp-rpc/".length)) && path.startsWith("/erp-rpc/");

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

export class ErpHub {
  constructor(
    private env: Env,
    private ctx: DurableObjectState,
  ) {}

  /** Esta instância é do ERP (ou a da continuação do cron)? KV do objeto; barato e em memória. */
  async isErp() {
    const kind = await this.ctx.storage.get<string>("kind");
    return kind === ERP_KIND || kind === ERP_CRON_KIND;
  }

  /**
   * POST /erp-cron-continue?window=<início>: só a instância "erp-cron" aceita.
   * Guarda a janela mais recente e agenda o próximo lote. Cada alarme é uma
   * invocação própria com o mesmo limite de áreas do cron.
   */
  private async cronContinue(request: Request) {
    const name = (this.ctx.id as { name?: string }).name;
    if (request.method !== "POST" || name !== undefined && name !== ERP_CRON_INSTANCE_NAME)
      return fail(409, "erp_wrong_instance", "Esta instância não continua o cron do ERP.");
    const window = Number(new URL(request.url).searchParams.get("window"));
    if (!Number.isSafeInteger(window) || window <= 0) return fail(400, "erp_cron_invalid", "Janela inválida.");
    const storage = this.ctx.storage;
    return storage.transaction(async tx => {
      const [kind, profile] = await Promise.all([tx.get<string>("kind"), tx.get("profile")]);
      if (profile || kind !== undefined && kind !== ERP_CRON_KIND) return fail(409, "erp_wrong_instance", "Instância de outro uso.");
      const saved = await tx.get<number>("cron_window");
      await tx.put({ kind: ERP_CRON_KIND, cron_window: Math.max(saved ?? 0, window) });
      const current = await tx.getAlarm(), target = Date.now() + ERP_CRON_CONTINUE_DELAY_MS;
      if (current === null || current > target) await tx.setAlarm(target);
      return Response.json({ ok: true });
    });
  }

  /** Um lote da continuação; reagenda enquanto houver áreas não tentadas na janela. */
  private async cronAlarm() {
    const storage = this.ctx.storage;
    const window = await storage.get<number>("cron_window");
    // Janela além da validade da fotografia: o próximo cron recomeça.
    if (!window || Date.now() - window > ERP_PARTS_TTL_MS) return;
    const { continueErpAreas } = await import("./scheduler/cron.ts");
    const { more } = await continueErpAreas(this.env, window);
    if (more) await storage.setAlarm(Date.now() + ERP_CRON_CONTINUE_DELAY_MS);
  }

  /**
   * Amarra a instância à área na primeira chamada; recusa outra área depois.
   * Só KV: controle e wake não carregam o motor nem aplicam esquema.
   */
  private async bind(profile: string) {
    const storage = this.ctx.storage;
    const [kind, bound] = await Promise.all([
      storage.get<string>("kind"),
      storage.get<string>("erp_profile"),
    ]);
    // O objeto conhece o próprio nome (idFromName): só "erp:<área>" atende o
    // ERP daquela área. Sem nome (runtime que não o expõe), vale a reserva:
    // instância que já gravou o perfil da área nunca vira ERP.
    const name = (this.ctx.id as { name?: string }).name;
    if (name !== undefined && name !== "erp:" + profile)
      return fail(409, "erp_wrong_instance", "Esta instância não é o ERP desta área.");
    if (!kind) {
      if (await storage.get("profile"))
        return fail(409, "erp_wrong_instance", "Instância de área, não do ERP.");
      await storage.put({ kind: ERP_KIND, erp_profile: profile });
    } else if (kind !== ERP_KIND || bound !== profile)
      return fail(409, "erp_profile_mismatch", "Instância do ERP de outra área.");
    return null;
  }

  async handle(path: string, request: Request): Promise<Response> {
    if (path === "/erp-cron-continue") return this.cronContinue(request);
    const profile = request.headers.get(ERP_PROFILE_HEADER) || "";
    if (!profile) return fail(400, "erp_profile_required", "Área ausente.");
    const refused = await this.bind(profile);
    if (refused) return refused;
    if (path === "/erp-parts") {
      const previous = await currentErpParts(this.ctx.storage, profile);
      const response = await handleErpParts(this.ctx.storage, profile, request);
      // A entrega, inclusive desligamento, reconcilia o alarme no mesmo KV.
      if (response.ok) await this.schedule(profile, Date.now() + 1_000, previous?.revision);
      return response;
    }
    if (path === "/erp-wake") return this.wake(profile, request);
    // Identidade e controle são leves: nenhuma importação do motor, SQL ou
    // migração pode preceder a recusa de uma fotografia ausente ou superada.
    const rpc = path.startsWith("/erp-rpc/");
    const evidence = rpc && isCommercialNfeEvidenceRequest(path, request);
    const bling = path.startsWith("/erp-bling/");
    const identity = rpc || bling ? decodeIdentity(request.headers.get(IDENTITY_HEADER)) : null;
    // Só a evidência fiscal já reivindicada (NF-e) dispensa a fotografia de partes; o Bling sempre confere.
    const gated = (rpc && !evidence) || bling;
    const input = identity && { ...identity.partsControl, parts: identity.parts };
    const authorize = async (apply: boolean) => {
      try {
        const snapshot = apply
          ? await applyErpPartsSnapshot(this.ctx.storage, profile, input)
          : await requireCurrentErpParts(this.ctx.storage, profile, input);
        if (!snapshot.parts.customers) {
          const error = { code: "module_disabled", message: "Esta rotina depende de uma parte desligada." };
          return Response.json({ ...error, error }, { status: 409, headers: { [ERP_PARTS_DENIED_HEADER]: error.code } });
        }
        return null;
      } catch (error) {
        if (!(error instanceof ErpPartsControlError)) throw error;
        return Response.json({ code: error.code, message: error.message, error: { code: error.code, message: error.message } },
          { status: error.status, headers: { [ERP_PARTS_DENIED_HEADER]: error.code } });
      }
    };
    if (gated) {
      const denied = await authorize(true);
      if (denied) return denied;
    }
    // O despachante administrativo valida identidade e entrada antes do motor.
    // Reserva/commit nunca são nomes públicos aceitos por esta costura.
    let blingCall;
    if (bling) {
      try { blingCall = await prepareBlingDispatch(profile, path, request, identity!); }
      catch (error) { return blingFailureResponse(error); }
    }
    const { ERP_SCHEMA_VERSION, migrate, handleRpc, handleBlingOperation, ErpRestoreBusyError,
      startBackup, startRestore, runBackupJob, ErpBackupJobError } = await engine();
    if (gated) {
      // O import cede a vez: expiração ou revisão nova também bloqueiam a migração.
      const denied = await authorize(false);
      if (denied) return denied;
    }
    // Troca da restauração em curso: o banco pode estar pela metade, e a área
    // fica inteira parada para o ERP (leituras e escritas), sem migração.
    if ((rpc || bling || path.startsWith("/erp-probe/")) && restoreSwapping(readBackupJob(this.ctx.storage))) {
      await this.continueBackup();
      return restoreSwappingResponse();
    }
    const applied = migrate(this.ctx.storage);
    if (applied.status === "newer")
      return fail(503, "erp_schema_newer", `O esquema gravado (${applied.version}) é mais novo que o do código (${ERP_SCHEMA_VERSION}).`);
    // Barreira do backup/restauração em páginas: escritas da coleta (POST e
    // retorno do OAuth) e sondas esperam; consultas do acervo continuam.
    const fence = backupFence(this.ctx.storage);
    if (fence && blingCall && (getBlingOperation(blingCall.name)?.method !== "GET" || blingCall.name === "erp_bling_oauth_callback"))
      return fencedResponse(fence);
    if (fence && path.startsWith("/erp-probe/")) return fencedResponse(fence);
    if (blingCall) {
      const response = await handleBlingOperation(blingCall, { env: this.env, storage: this.ctx.storage,
        readParts: async () => (await currentErpParts(this.ctx.storage, profile))?.parts ?? null,
        readSnapshot: () => currentErpParts(this.ctx.storage, profile), profile });
      if (response.ok) await this.schedule(profile, Date.now() + 1_000);
      // Escrita com recibo já gravada: devolve o feito, com o recibo. Uma
      // revisão de partes que chegou durante a operação só impede trabalho
      // novo (o próximo pedido é conferido no começo). Leitura continua
      // reconferida antes de entregar o que leu.
      if (BLING_RECEIPTED_OPERATIONS.has(blingCall.name)) return response;
      const denied = await authorize(false);
      return denied ?? response;
    }
    if (path === "/erp-ping")
      return Response.json({
        kind: ERP_KIND,
        profile,
        schema_version: ERP_SCHEMA_VERSION,
        database_size: this.ctx.storage.sql.databaseSize,
      });
    // Exceção deliberada de recuperação: /erp-backup e /erp-restore precisam
    // funcionar sem fotografia, inclusive em instância nova ou com ERP
    // suspenso. Chamadores: o binding do Coordinator, e o Worker só pelas
    // rotas de administrador de src/erp/api/backup-routes.ts (papel, segundo
    // fator e módulo conferidos lá). Restaurar troca o conteúdo inteiro.
    // Operações: engine/backup-operations.ts (nomes estáveis, sensíveis).
    // Em páginas (engine/backup-pages.ts): a rota avança o que cabe e devolve
    // 200 com o resultado; se não terminar, 202 com o progresso, e o alarme
    // continua. /erp-backup-status mostra o progresso a quem pediu.
    if (path === "/erp-backup-status") {
      const job = readBackupJob(this.ctx.storage);
      // Depois de uma volta à marca o alarme pode ter voltado junto: quem acompanha o progresso o reagenda.
      if (backupJobActive(job)) {
        if (!(await this.ctx.storage.get(BACKUP_ACTIVE_KV))) await this.ctx.storage.put(BACKUP_ACTIVE_KV, true);
        await this.continueBackup();
      }
      return Response.json(backupJobStatus(job));
    }
    if (path === "/erp-backup" || path === "/erp-restore") {
      if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
      const storage = this.ctx.storage;
      let job;
      try {
        if (path === "/erp-backup") job = startBackup(storage, profile);
        else {
          const body = await request.json<{ prefix?: unknown }>().catch(() => ({ prefix: undefined }));
          // Exclusão/gravação de XML de fato no ar recusa o início, com o motivo;
          // depois de começar, a barreira e o alarme impedem I/O novo de XML.
          job = await startRestore(storage, this.env.MEDIA, profile, body?.prefix as string);
        }
      } catch (error) {
        if (error instanceof ErpRestoreBusyError) return fail(409, error.code, error.message);
        if (error instanceof ErpBackupJobError) return fail(error.status, error.code, error.message);
        throw error;
      }
      // A marca no KV leva o alarme e o schedule() a conferir o trabalho.
      await storage.put(BACKUP_ACTIVE_KV, true);
      let run;
      try { run = await runBackupJob(storage, this.env.MEDIA, BACKUP_INLINE); }
      catch (error) {
        if (isRestoreRestart(error)) { await this.continueBackup(1_000); this.restartSoon(); }
        run = { job: readBackupJob(storage), more: true, manifest: undefined };
      }
      const current = run.job?.id === job.id ? run.job : readBackupJob(storage);
      const status = backupJobStatus(current);
      if (current?.id === job.id && current.phase === "done") {
        await this.backupFinished(profile);
        if (current.kind === "restore") return Response.json({ ...current.result, ...status });
        let manifest = run.manifest;
        if (!manifest) manifest = await (await this.env.MEDIA.get(current.prefix + "manifest.json"))?.json();
        return Response.json({ prefix: current.prefix, bytes: current.result?.bytes ?? 0, manifest, ...status });
      }
      if (current?.id === job.id && current.phase === "failed") {
        await this.backupFinished(profile);
        const error = current.error ?? { code: "erp_backup_failed", message: "O trabalho de backup falhou." };
        return Response.json({ error, ...status }, { status: error.code === "erp_restore_archive_busy" ? 409 : 422 });
      }
      await this.continueBackup();
      return Response.json(status, { status: 202 });
    }
    // Sondas da instalação de teste (src/erp/probe.ts); o Worker só encaminha
    // com ERP_PROBES=1 e administrador (src/erp/api/local-fetch.ts).
    if (path.startsWith("/erp-probe/")) {
      const { probe } = await import("./probe.ts");
      const body = await request.json<Record<string, unknown>>().catch(() => ({}));
      return Response.json(await probe(this.ctx, path.slice("/erp-probe/".length), body));
    }
    if (path.startsWith("/erp-rpc/"))
      return handleRpc(this.ctx, profile, path.slice("/erp-rpc/".length), request, this.env.MEDIA, this.env.DB);
    return fail(404, "not_found", "Rota do ERP desconhecida.");
  }

  /** Reinicia o objeto logo depois de responder: a volta à marca pedida vale na próxima sessão. */
  private restartSoon() {
    setTimeout(() => this.ctx.abort("restauração do ERP voltando à marca"), 50);
  }

  /** Trabalho de backup/restauração ativo: o alarme volta logo (nunca é apagado nem adiado). */
  private async continueBackup(delay = BACKUP_CONTINUE_MS) {
    const storage = this.ctx.storage, target = Date.now() + delay;
    const current = await storage.getAlarm();
    if (current === null || current > target) await storage.setAlarm(target);
  }

  /** Uma acordada com trabalho de backup: só ele roda; coleta, fila e arquivos esperam a barreira. */
  private async backupAlarm(profile: string) {
    const { migrate, runBackupJob } = await engine();
    // Código mais antigo que o esquema (volta de versão): não mexe; a barreira
    // cai pelo prazo e o código novo, quando voltar, descarta o trabalho.
    if (migrate(this.ctx.storage).status === "newer") { await this.continueBackup(60_000); return; }
    let more = true;
    try { more = (await runBackupJob(this.ctx.storage, this.env.MEDIA, BACKUP_ALARM)).more; }
    catch (error) {
      // R2 ou SQLite indisponível: o checkpoint durável fica; tenta de novo.
      // Sem progresso, a barreira cai pelo prazo e o trabalho é descartado
      // (na troca da restauração, volta à marca).
      await this.continueBackup(BACKUP_RETRY_MS);
      if (isRestoreRestart(error)) this.ctx.abort("restauração do ERP voltando à marca");
      return;
    }
    if (more) await this.continueBackup();
    else await this.backupFinished(profile);
  }

  /** Há trabalho de backup ativo? Sem a marca no KV, nem consulta o SQL. */
  private async backupActive(): Promise<boolean> {
    const storage = this.ctx.storage;
    if (!(await storage.get(BACKUP_ACTIVE_KV))) return false;
    if (backupJobActive(readBackupJob(storage))) return true;
    await storage.delete(BACKUP_ACTIVE_KV);
    return false;
  }

  /** Fim do trabalho: solta a marca e devolve o alarme às rotinas e à coleta. */
  private async backupFinished(profile: string) {
    if (await this.backupActive()) { await this.continueBackup(); return; }
    await this.schedule(profile, Date.now() + 1_000);
  }

  /** Serializa a decisão de alarme com as entregas: desligamento nunca perde para um wake antigo. */
  private schedule(profile: string, target: number | null, previousRevision?: string) {
    return this.ctx.storage.transaction(async tx => {
      const saved = await tx.get(ERP_PARTS_KEY);
      const current = await tx.getAlarm();
      // Backup/restauração em andamento não depende das partes: o alarme fica.
      if (await tx.get(BACKUP_ACTIVE_KV) && backupJobActive(readBackupJob(this.ctx.storage))) {
        const soon = Date.now() + 1_000;
        if (current === null || current > soon) await tx.setAlarm(soon);
        return current === null ? soon : Math.min(current, soon);
      }
      const snapshot = readErpPartsSnapshot(saved, profile);
      if (!snapshot?.parts.customers) {
        await tx.deleteAlarm();
        return null;
      }
      // Uma entrega/wake que chegou durante a rodada mantém sua antecipação.
      if (target === null || previousRevision === snapshot.revision && current !== null) return current;
      const next = current === null ? target : Math.min(current, target);
      await tx.setAlarm(next);
      return next;
    });
  }

  /** POST /erp-wake {at?}: só antecipa usando autorização completa já entregue. */
  private async wake(profile: string, request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const invalid = () => fail(400, "erp_wake_invalid", "Corpo do wake inválido.");
    const text = await request.text();
    let body: { at?: unknown } = {};
    try { if (text) body = JSON.parse(text); } catch { return invalid(); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "at")) return invalid();
    if (body.at !== undefined && (typeof body.at !== "number" || !Number.isSafeInteger(body.at))) return invalid();
    const alarm = await this.schedule(profile, Math.max(Date.now() + 1, (body.at as number | undefined) ?? Date.now() + 1));
    if (alarm === null) return fail(503, "erp_parts_unavailable", "Estado das partes indisponível.");
    return Response.json({ ok: true, alarm });
  }

  /** Uma rodada, com KV revalidado antes do motor, depois de I/O e entre unidades. */
  async alarm() {
    const storage = this.ctx.storage;
    if ((await storage.get<string>("kind")) === ERP_CRON_KIND) return this.cronAlarm();
    const profile = await storage.get<string>("erp_profile");
    if (!profile) { await storage.deleteAlarm(); return; }
    // Backup ou restauração em páginas: roda antes de tudo e sem depender das
    // partes (como as rotas internas). A coleta do Bling, os arquivos e as
    // rotinas não rodam enquanto ele está ativo; voltam na acordada seguinte.
    if (await this.backupActive()) return this.backupAlarm(profile);
    const readParts = async () => {
      const snapshot = await currentErpParts(storage, profile);
      return snapshot?.parts.customers ? snapshot.parts : null;
    };
    let parts = await readParts();
    if (!parts) { await this.schedule(profile, null); return; }
    const { CONTINUE_AFTER_MS, FILE_PURPOSES, ROUTINES, TASK_HANDLERS, nextWake, engineClock, migrate, runFileTasks, runRound, storageDriver, runBlingWake, nextBlingWake } = await engine();
    parts = await readParts();
    if (!parts) { await this.schedule(profile, null); return; }
    if (migrate(storage).status === "newer") return;
    const db = storageDriver(storage);
    const report = await runRound(db, { parts, readParts, clock: engineClock(this.ctx), filePurposes: FILE_PURPOSES });
    parts = await readParts();
    if (!parts) { await this.schedule(profile, null); return; }
    let next = report.nextWake;
    if (report.fileDue && !report.more) {
      if (!report.routines.length && !report.tasks.length) {
        await runFileTasks(this.env, this.ctx, profile, { parts, readParts });
        parts = await readParts();
        if (!parts) { await this.schedule(profile, null); return; }
        // A última tarefa não pede uma acordada vazia só para descobrir que acabou.
        next = nextWake(db, ROUTINES, parts, [...Object.keys(TASK_HANDLERS), ...FILE_PURPOSES], Date.now());
        if (next !== null && next <= Date.now() + 1) next = Date.now() + CONTINUE_AFTER_MS;
      } else next = Date.now() + CONTINUE_AFTER_MS;
    }
    // Uma unidade externa só cabe numa acordada sem trabalho operacional.
    // O executor recebe o vencimento existente e preserva 250 ms de margem.
    const blingDependencies = { env: this.env, storage, readParts, profile, readSnapshot: () => currentErpParts(storage, profile) };
    let blingNext: number | null;
    try {
      blingNext = !report.more && !report.fileDue && !report.routines.length && !report.tasks.length
        ? (await runBlingWake(profile, blingDependencies, { eligible: true, nextOperationalAt: next, clock: { now: () => Date.now() } })).nextWake
        : await nextBlingWake(profile, blingDependencies, Date.now() + CONTINUE_AFTER_MS);
    } catch {
      // Falha de infraestrutura da coleta não pode apagar/adiar o vencimento
      // operacional. Não registrar exceção de cofre/HTTP nos logs do alarme.
      blingNext = Date.now() + 60_000;
    }
    parts = await readParts();
    if (!parts) { await this.schedule(profile, null); return; }
    if (blingNext !== null) next = next === null ? blingNext : Math.min(next, blingNext);
    storage.sql.exec(
      "INSERT INTO erp_meta(key,value) VALUES('last_alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(Date.now()),
    );
    await this.schedule(profile, next);
  }
}
