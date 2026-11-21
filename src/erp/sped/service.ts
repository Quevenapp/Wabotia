// Obrigações em arquivo, a parte do Worker: a conversa com o objeto do ERP da
// área (./do.ts), o download das partes do R2 e o envio ao contador pelo
// mesmo envio do pacote do contador (src/erp/contador/service.ts): o arquivo
// pronto entra no pacote do período e o link de 7 dias vai ao contador. Se o
// pacote precisa ser montado de novo com o arquivo dentro, o pedido de envio
// fica no D1 (erp_sped_pending_sends, migração 0240) e o agendador do módulo
// ERP manda assim que o pacote fica pronto. Nada vai ao governo.
import { all, exec } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { audit } from "../../events";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { contadorPackageId, type ContadorChannel, type ContadorPackageView } from "../contador/contract.ts";
import { SPED_OFF_MESSAGE, spedPeriodLabel, type SpedFileView } from "./contract.ts";

/** Chama o objeto do ERP da área: com a pessoa (identidade) ou sem (o envio que espera o pacote). */
export async function spedDo<T = any>(env: Env, profile: string, op: string, body: Record<string, unknown>, identity: IdentityPort | null): Promise<T> {
  let response: Response;
  try {
    const { erpFetch } = await import("../hub.ts");
    response = await erpFetch(env, profile, identity ? `/erp-sped/${op}` : `/erp-sped/sistema/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(identity ? { [IDENTITY_HEADER]: encodeIdentity(identity) } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  }
  const data = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = data?.error ?? data ?? {};
    const code = typeof error.code === "string" ? error.code : "";
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "module_disabled") throw new ApiError(409, "module_disabled", SPED_OFF_MESSAGE);
    if (code === "erp_parts_stale") throw new ApiError(409, "erp_parts_stale", "O estado dos módulos mudou agora. Tente de novo.");
    if (code === "erp_backup_fence" || response.status === 423) throw new ApiError(409, "erp_busy", "O ERP está fazendo backup agora. Tente de novo em alguns minutos.");
    if (response.status === 404) throw new ApiError(404, "not_found", message || "Arquivo não encontrado.");
    if (response.status === 400) throw new ApiError(400, "invalid_request", message || "Confira o período e tente de novo.");
    if (response.status === 403) throw new ApiError(403, code || "forbidden", message || "Seu papel no ERP não alcança SPED e SINTEGRA.");
    throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  }
  return data as T;
}

/** O arquivo texto: as partes do R2 na ordem, sem montar tudo na memória. */
export function textResponse(env: Env, files: { keys: string[]; bytes: number; filename: string }): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= files.keys.length) { controller.close(); return; }
      const object = await env.MEDIA.get(files.keys[index++]);
      if (!object) { controller.error(new Error("parte do arquivo ausente")); return; }
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=iso-8859-1", "Content-Length": String(files.bytes),
    "Content-Disposition": `attachment; filename="${files.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" } });
}

// ---------------------------------------------------------------------------
// Envio ao contador

export interface PendingRow {
  id: string; profile_id: string; file_id: string; package_id: string; period_from: string; period_to: string; channel: string | null; actor: string; actor_name: string;
  via_bot: string | null; status: string; error: string | null; send_id: string | null; attempts: number; created: number; updated: number;
}
export const pendingView = (r: PendingRow) => ({
  id: r.id, arquivo: r.file_id, pacote: r.package_id, periodo: spedPeriodLabel(r.period_from, r.period_to), canal: r.channel, situacao: r.status, erro: r.error,
  envio: r.send_id, por: r.actor_name, pelo_bot: !!r.via_bot, pedido_em: r.created, atualizado_em: r.updated,
});
export async function listPending(env: Env, profile: string, limit = 50) {
  try { return (await all<PendingRow>(env, "SELECT * FROM erp_sped_pending_sends WHERE profile_id=? ORDER BY created DESC LIMIT ?", profile, limit)).map(pendingView); }
  catch { return []; } // Instalação sem a migração 0240.
}

/** Prazo para o pacote ficar pronto antes de o pedido de envio desistir. */
const PENDING_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Envia o arquivo ao contador pelo envio do pacote: o pacote do mesmo período
 * já pronto depois do arquivo sai na hora; senão o pacote é montado de novo
 * (com o arquivo dentro) e o envio fica esperando.
 */
export async function sendSpedFile(env: Env, profile: string, input: { actor: Actor; identity: IdentityPort; fileId: string; channel?: ContadorChannel }) {
  const { arquivo } = await spedDo<{ arquivo: SpedFileView }>(env, profile, "ver", { id: input.fileId }, input.identity);
  if (arquivo.state !== "done") throw new ApiError(409, "sped_file_not_ready", arquivo.state === "running"
    ? "O arquivo ainda está sendo gerado. Espere ficar pronto e envie de novo."
    : "O arquivo não ficou pronto (tem pendências ou falhou). Corrija o que está na lista, gere de novo e envie.");
  const { configuracao } = await spedDo<{ configuracao: { no_pacote: boolean } }>(env, profile, "configuracao", {}, input.identity);
  if (!configuracao.no_pacote) throw new ApiError(409, "sped_package_off",
    "O envio ao contador vai dentro do pacote do contador, e a opção de incluir os arquivos no pacote está desligada. Ligue em Obrigações em arquivo › Configuração, ou baixe o arquivo e mande você mesmo.");
  const { readSettings, contadorDo, sendToAccountant } = await import("../contador/service.ts");
  const settings = await readSettings(env, profile);
  const channel = input.channel ?? settings.channel;
  if (!(channel === "email" ? settings.email : settings.phone))
    throw new ApiError(409, "contador_missing", channel === "email"
      ? "Cadastre o e-mail do contador em Fiscal › Para o contador › Contador e envios, e envie de novo."
      : "Cadastre o WhatsApp do contador em Fiscal › Para o contador › Contador e envios, e envie de novo.");
  const packageId = await contadorPackageId(arquivo.environment, arquivo.from, arquivo.to);
  const fileDone = Date.parse(arquivo.finished_at ?? arquivo.updated_at);
  let pkg: ContadorPackageView | null = null;
  try { pkg = (await contadorDo<{ pacote: ContadorPackageView }>(env, profile, "ver", { id: packageId }, input.identity)).pacote; }
  catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  const fresh = (p: ContadorPackageView | null) => p?.state === "done" && p.finished_at !== null && Date.parse(p.finished_at) >= fileDone;
  if (!fresh(pkg)) {
    const asked = await contadorDo<{ pacote: ContadorPackageView }>(env, profile, "pedir",
      { id: packageId, environment: arquivo.environment, from: arquivo.from, to: arquivo.to, redo: !!pkg }, input.identity);
    pkg = asked.pacote;
  }
  if (fresh(pkg)) {
    const envio = await sendToAccountant(env, profile, { actor: input.actor, packageId, channel, identity: input.identity });
    await audit(env, input.actor, profile, "erp_sped.send", `${arquivo.id} ${packageId} ${channel}`, uid());
    return { envio, aguardando: false, pacote: pkg };
  }
  const at = now(), id = uid();
  await exec(env, `INSERT INTO erp_sped_pending_sends(id,profile_id,file_id,package_id,period_from,period_to,channel,actor,actor_name,via_bot,status,attempts,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,'esperando',0,?,?)`,
  id, profile, arquivo.id, packageId, arquivo.from, arquivo.to, input.channel ?? null, input.actor.id, input.actor.name ?? "Pessoa da área", input.actor.via?.bot_id ?? null, at, at);
  await audit(env, input.actor, profile, "erp_sped.send_queued", `${arquivo.id} ${packageId}`, uid());
  return { envio: null, aguardando: true, pedido: id, pacote: pkg,
    mensagem: `O pacote do contador de ${spedPeriodLabel(arquivo.from, arquivo.to)} está sendo montado de novo, já com o arquivo dentro. O envio sai sozinho assim que ele ficar pronto; acompanhe em Para o contador.` };
}

/**
 * Uma passada do agendador do módulo ERP (por área): os pedidos de envio que
 * esperam o pacote. Pronto depois do pedido, envia; falhou, registra; passou
 * do prazo, desiste com o motivo.
 */
export async function runPendingSends(env: Env, profile: string, at: number): Promise<number> {
  let rows: PendingRow[] = [];
  try { rows = await all<PendingRow>(env, "SELECT * FROM erp_sped_pending_sends WHERE profile_id=? AND status='esperando' ORDER BY created LIMIT 5", profile); }
  catch { return 0; }
  if (!rows.length) return 0;
  const { fiscalOffMessage, contadorDo, sendToAccountant, systemActor } = await import("../contador/service.ts");
  if (await fiscalOffMessage(env, profile)) return 0;
  let sent = 0;
  for (const row of rows) {
    const set = (status: string, error: string | null, sendId: string | null = null) =>
      exec(env, "UPDATE erp_sped_pending_sends SET status=?,error=?,send_id=?,attempts=attempts+1,updated=? WHERE id=? AND status='esperando'",
        status, error ? error.slice(0, 500) : null, sendId, now(), row.id);
    let pkg: ContadorPackageView | null = null;
    try { pkg = (await contadorDo<{ pacote: ContadorPackageView }>(env, profile, "ver", { id: row.package_id }, null)).pacote; }
    catch (error) { if (error instanceof ApiError && error.status === 404) { await set("falhou", "O pacote do contador foi apagado ou refeito. Envie o arquivo de novo."); } continue; }
    if (pkg.state === "failed") { await set("falhou", `O pacote do contador não pôde ser montado: ${pkg.error ?? "erro desconhecido"}`); continue; }
    if (pkg.state !== "done" || !pkg.finished_at || Date.parse(pkg.finished_at) < row.created) {
      if (at - row.created > PENDING_MS) await set("falhou", "O pacote do contador não ficou pronto a tempo. Envie o arquivo de novo.");
      continue;
    }
    const claimed = await exec(env, "UPDATE erp_sped_pending_sends SET status='enviando',updated=? WHERE id=? AND status='esperando'", now(), row.id);
    if (!claimed?.meta?.changes) continue;
    const actor = { ...systemActor(profile), id: row.actor, name: row.actor_name } as Actor;
    try {
      const envio = await sendToAccountant(env, profile, { actor, packageId: row.package_id, channel: (row.channel as ContadorChannel | null) ?? undefined, identity: null });
      await exec(env, "UPDATE erp_sped_pending_sends SET status='enviado',send_id=?,updated=? WHERE id=?", envio.id, now(), row.id);
      sent++;
    } catch (error) {
      await exec(env, "UPDATE erp_sped_pending_sends SET status='falhou',error=?,updated=? WHERE id=?",
        (error instanceof ApiError ? error.message : "O envio não saiu. Tente de novo.").slice(0, 500), now(), row.id);
    }
  }
  return sent;
}
