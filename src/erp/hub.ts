// ERP (Fagoo) dentro do Wabotia: a instância "erp:<área>" da classe
// Coordinator (sem classe nova de Durable Object; mesmo precedente de
// "hermes-link:" em src/hermes-link.ts). Os dados do ERP ficam no SQLite do
// objeto (ctx.storage.sql). Fase 0: docs/ERP-FASE0.md.
//
// Regras da instância compartilhada:
// - nunca grava a chave "profile" do KV (a da área): grava kind="erp" e
//   erp_profile, e recusa chamada de outra área;
// - o Coordinator desvia "/erp-*" no topo do fetch e o alarme por kind, antes
//   de qualquer coisa da área (pipeline do WhatsApp, D1);
// - nunca chama a instância da área de forma síncrona.
import type { Env } from "../types";
import { ERP_SCHEMA_VERSION, migrate } from "./schema/migrate.ts";
import { handleRpc } from "./engine/rpc-endpoint.ts";
import { backupToR2, dumpAll, readBackup, restoreAll } from "./engine/dump.ts";

export const ERP_KIND = "erp";
export const ERP_PROFILE_HEADER = "x-erp-profile";

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
    if (path === "/erp-ping")
      return Response.json({
        kind: ERP_KIND,
        profile,
        schema_version: ERP_SCHEMA_VERSION,
        database_size: this.ctx.storage.sql.databaseSize,
      });
    // Acorda o alarme do ERP (fila de saída, tarefas). Também usado nos testes.
    if (path === "/erp-wake") {
      await this.ctx.storage.setAlarm(Date.now() + 1);
      return Response.json({ ok: true });
    }
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
    if (path.startsWith("/erp-rpc/"))
      return handleRpc(this.ctx, profile, path.slice("/erp-rpc/".length), request);
    return fail(404, "not_found", "Rota do ERP desconhecida.");
  }

  /**
   * Alarme da instância ERP. Fase 0: só registra a rodada (prova de que o
   * pipeline da área não roda aqui). Depois: drena a fila de saída do ERP e as
   * tarefas em fatias.
   */
  async alarm() {
    migrate(this.ctx.storage);
    this.ctx.storage.sql.exec(
      "INSERT INTO erp_meta(key,value) VALUES('last_alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      String(Date.now()),
    );
  }
}
