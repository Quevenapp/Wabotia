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

/**
 * Motor e esquema por import dinâmico: o bundle os traz, mas só são avaliados
 * na primeira chamada do ERP (prova 7: partida do Worker de quem não liga o
 * ERP).
 */
let engineModule: Promise<typeof import("./hub-engine.ts")> | null = null;
const engine = () => (engineModule ??= import("./hub-engine.ts"));

export const ERP_KIND = "erp";
export const ERP_PROFILE_HEADER = "x-erp-profile";
/** Blocos opcionais do ERP que o wake informa ao agendador. */
export const ERP_OPTIONAL_BLOCKS = ["erp-fiscal", "erp-cobranca", "erp-pdv"] as const;
/** Chave do KV do objeto com os blocos ligados (gravada pelo /erp-wake). */
const ERP_BLOCKS_KEY = "erp_blocks";

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
   * Aplica o esquema na versão do código.
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
    const { migrate, ERP_SCHEMA_VERSION } = await engine();
    const applied = migrate(this.ctx.storage);
    if (applied.status === "newer")
      return fail(
        503,
        "erp_schema_newer",
        `O esquema gravado (${applied.version}) é mais novo que o do código (${ERP_SCHEMA_VERSION}).`,
      );
    return null;
  }

  async handle(path: string, request: Request): Promise<Response> {
    const profile = request.headers.get(ERP_PROFILE_HEADER) || "";
    if (!profile) return fail(400, "erp_profile_required", "Área ausente.");
    const refused = await this.bind(profile);
    if (refused) return refused;
    const { ERP_SCHEMA_VERSION, backupToR2, dumpAll, handleRpc, readBackup, restoreAll } = await engine();
    if (path === "/erp-ping")
      return Response.json({
        kind: ERP_KIND,
        profile,
        schema_version: ERP_SCHEMA_VERSION,
        database_size: this.ctx.storage.sql.databaseSize,
      });
    // Acorda o agendador do ERP (docs/ERP-AGENDADOR.md): o mais cedo vence.
    if (path === "/erp-wake") return this.wake(request);
    // Backup lógico no R2 e restauração (prova 8). Restaurar é só numa
    // instância nova ou para recuperar: troca o conteúdo inteiro.
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
      return handleRpc(this.ctx, profile, path.slice("/erp-rpc/".length), request, this.env.MEDIA);
    return fail(404, "not_found", "Rota do ERP desconhecida.");
  }

  /**
   * POST /erp-wake {blocks?, at?}: guarda os blocos ligados no KV do objeto
   * (o objeto nunca lê o D1) e antecipa o alarme para `at` (padrão: agora). O
   * mais cedo vence: o wake nunca adia um alarme já agendado.
   */
  private async wake(request: Request) {
    const invalid = () => fail(400, "erp_wake_invalid", "Corpo do wake inválido.");
    const text = await request.text();
    let body: { blocks?: unknown; at?: unknown } = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return invalid();
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
    }
    const { blocks, at } = body;
    if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) return invalid();
    if (blocks !== undefined) {
      if (!blocks || typeof blocks !== "object" || Array.isArray(blocks)) return invalid();
      for (const [k, v] of Object.entries(blocks))
        if (!(ERP_OPTIONAL_BLOCKS as readonly string[]).includes(k) || typeof v !== "boolean") return invalid();
      await this.ctx.storage.put(ERP_BLOCKS_KEY, { blocks, at: Date.now() });
    }
    const now = Date.now();
    const target = Math.max(now + 1, (at as number | undefined) ?? now + 1);
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= target) return Response.json({ ok: true, alarm: current });
    await this.ctx.storage.setAlarm(target);
    return Response.json({ ok: true, alarm: target });
  }

  /**
   * Alarme da instância ERP: uma rodada do agendador (src/erp/scheduler/),
   * cedendo a vez entre as unidades, e o próximo alarme. Nunca toca a área
   * nem o D1.
   */
  async alarm() {
    const { CONTINUE_AFTER_MS, FILE_PURPOSES, engineClock, migrate, runFileTasks, runRound, storageDriver } = await engine();
    const storage = this.ctx.storage;
    if (migrate(storage).status === "newer") return;
    const [saved, profile] = await Promise.all([
      storage.get<{ blocks: Record<string, boolean> }>(ERP_BLOCKS_KEY),
      storage.get<string>("erp_profile"),
    ]);
    const report = await runRound(storageDriver(storage), {
      blocks: saved?.blocks ?? {},
      clock: engineClock(this.ctx),
      filePurposes: FILE_PURPOSES,
    });
    let next = report.nextWake ?? Date.now() + 3_600_000;
    // Tarefa com arquivo (exportação, limpeza): não retoma em outra acordada,
    // então vai sozinha, numa acordada em que a rodada não fez mais nada; se
    // fez, a próxima acordada (1 s) é dela. Cede a vez a cada ida ao R2.
    if (report.fileDue && !report.more && profile) {
      if (!report.routines.length && !report.tasks.length) await runFileTasks(this.env, this.ctx, profile);
      next = Date.now() + CONTINUE_AFTER_MS;
    }
    storage.sql.exec(
      "INSERT INTO erp_meta(key,value) VALUES('last_alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(Date.now()),
    );
    // Um wake que chegou durante a rodada pode ter agendado mais cedo: fica o mais cedo.
    const current = await storage.getAlarm();
    if (current === null || current > next) await storage.setAlarm(next);
  }
}
