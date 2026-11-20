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
import { ERP_PARTS_DENIED_HEADER, readErpPartsSnapshot } from "./parts.ts";
import { decodeIdentity, IDENTITY_HEADER, SYSTEM_HEADER } from "./engine/identity.ts";
import { prepareBlingDispatch, blingFailureResponse } from "./bling/assembly.ts";

/**
 * Motor e esquema por import dinâmico: o bundle os traz, mas só são avaliados
 * na primeira chamada do ERP (prova 7: partida do Worker de quem não liga o
 * ERP).
 */
let engineModule: Promise<typeof import("./hub-engine.ts")> | null = null;
const engine = () => (engineModule ??= import("./hub-engine.ts"));

export const ERP_KIND = "erp";
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

  /** Esta instância é do ERP? (lido do KV do objeto; barato e em memória) */
  async isErp() {
    return (await this.ctx.storage.get<string>("kind")) === ERP_KIND;
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
    const { ERP_SCHEMA_VERSION, migrate, backupToR2, dumpAll, handleRpc, readBackup, restoreAll, handleBlingOperation } = await engine();
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
      const dump = dumpAll(this.ctx.storage);
      const saved = await backupToR2(this.env.MEDIA, profile, dump);
      return Response.json({ ...saved, manifest: dump.manifest });
    }
    if (path === "/erp-restore") {
      const { prefix } = await request.json<{ prefix: string }>();
      if (typeof prefix !== "string" || !prefix.startsWith("erp-backups/"))
        return fail(400, "erp_backup_invalid", "Informe o prefixo do backup.");
      const { manifest, files } = await readBackup(this.env.MEDIA, prefix);
      return Response.json(restoreAll(this.ctx.storage, manifest, files));
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
