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
import { BLING_RECEIPTED_OPERATIONS } from "./bling/schema.ts";

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
    const { ERP_SCHEMA_VERSION, migrate, backupToR2, dumpAll, handleRpc, readBackup, restoreAll, handleBlingOperation,
      ErpBackupTooLargeError, ErpRestoreBusyError, beginArchiveRestore, endArchiveRestore } = await engine();
    if (gated) {
      // O import cede a vez: expiração ou revisão nova também bloqueiam a migração.
      const denied = await authorize(false);
      if (denied) return denied;
    }
    const applied = migrate(this.ctx.storage);
    if (applied.status === "newer")
      return fail(503, "erp_schema_newer", `O esquema gravado (${applied.version}) é mais novo que o do código (${ERP_SCHEMA_VERSION}).`);
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
    // Exceção deliberada de recuperação: /erp-backup e /erp-restore só têm
    // chamadores internos pelo binding do Coordinator (e testes); não há
    // encaminhamento no Worker nem em api/local-fetch.ts. Precisam funcionar
    // sem fotografia, inclusive em instância nova ou com ERP suspenso.
    // Restaurar troca o conteúdo inteiro. Não expor estas rotas na API pública.
    if (path === "/erp-backup") {
      let dump;
      // Mede antes de materializar; acima do teto, nenhum arquivo nem manifesto.
      try { dump = dumpAll(this.ctx.storage); }
      catch (error) { if (error instanceof ErpBackupTooLargeError) return fail(413, error.code, error.message); throw error; }
      const saved = await backupToR2(this.env.MEDIA, profile, dump);
      return Response.json({ ...saved, manifest: dump.manifest });
    }
    if (path === "/erp-restore") {
      const { prefix } = await request.json<{ prefix: string }>();
      if (typeof prefix !== "string" || !prefix.startsWith("erp-backups/"))
        return fail(400, "erp_backup_invalid", "Informe o prefixo do backup.");
      // Exclusão/gravação de XML viva recusa o início; depois de começar,
      // nenhum novo I/O de XML ou de apagamento inicia até o fim da troca.
      const busy = new ErpRestoreBusyError();
      if (!beginArchiveRestore(profile)) return fail(409, busy.code, busy.message);
      try {
        const { manifest, files } = await readBackup(this.env.MEDIA, prefix);
        return Response.json(restoreAll(this.ctx.storage, manifest, files, { profile }));
      } catch (error) {
        if (error instanceof ErpRestoreBusyError || error instanceof ErpBackupTooLargeError)
          return fail(error instanceof ErpRestoreBusyError ? 409 : 413, error.code, error.message);
        throw error;
      } finally { endArchiveRestore(profile); }
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

  /** Serializa a decisão de alarme com as entregas: desligamento nunca perde para um wake antigo. */
  private schedule(profile: string, target: number | null, previousRevision?: string) {
    return this.ctx.storage.transaction(async tx => {
      const saved = await tx.get(ERP_PARTS_KEY);
      const current = await tx.getAlarm();
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
