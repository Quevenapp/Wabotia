// Envio da régua de cobrança no alarme da área (registerSchedule
// "erp-financeiro"; src/modules/schedule.ts roda a cada minuto, no mínimo a
// cada 5 minutos pelo cron). Carregado por src/modules/runtime.ts.
//
// Cada rodada: a configuração do D1 (desligada: nada sai), o administrador
// que ligou a régua (as mensagens saem em nome dele; sem ele ativo, nada
// sai), a rodada do motor (arruma a fila, planeja as etapas do dia e toma as
// que podem sair agora, no horário comercial) e, para cada etapa tomada, o
// envio de conta que já existe na conversa (src/erp/conversa/routes.ts):
// a prévia diz o telefone do cadastro, a linha e como sai (janela de 24 horas
// ou modelo com o consentimento do cliente); bloqueado, a etapa fica como
// falha com o motivo. A chave do envio é a da etapa: repetir depois de uma
// resposta perdida não manda duas vezes. O e-mail sai pela função registrada
// em ./email-hook.ts, quando existir.
import { exec } from "../../db";
import { ApiError, type Actor, type Env } from "../../types";
import { actorForUser } from "../../security";
import { registerSchedule } from "../../modules/hooks";
import { moduleStates } from "../../modules/registry";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { erpConversaRoute } from "../conversa/routes.ts";
import { ERP_REGUA_PART, engineConfig, type ReguaPayment } from "./contract.ts";
import { reguaRpc, reguaSettings } from "./routes.ts";
import { reguaEmailReady, reguaEmailSender, type ReguaEmailStep } from "./email-hook.ts";

/** Etapas por rodada (cada uma é uma ida à conversa). */
export const REGUA_BATCH = 5;
/** Sem nada a enviar no horário: a próxima rodada. */
export const REGUA_IDLE_MS = 15 * 60_000;
/** Com fila no horário: a próxima rodada logo em seguida. */
export const REGUA_BUSY_MS = 60_000;
/** Sem quem envie (administrador inativo) ou com o motor fora: espera mais. */
export const REGUA_BLOCKED_MS = 60 * 60_000;

export type Outcome = { outcome: "sent" | "failed" | "retry" | "skipped"; reason: string | null; ref: string | null };
type ConversaCall = (request: Request) => Promise<Response>;

const message = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : "O envio não saiu.";
/** Falha que passa sozinha (ERP ou conversa fora, mudança no meio): tenta de novo; o resto fica como falha com o motivo. */
const transient = (error: unknown) => error instanceof ApiError
  ? error.status >= 500 || ["dependency_unavailable", "erp_unavailable", "erp_conversa_changed", "erp_parts_stale", "erp_busy"].includes(error.code)
  : true;
const failure = (error: unknown): Outcome => ({ outcome: transient(error) ? "retry" : "failed", reason: message(error).slice(0, 500), ref: null });

/** Pela conversa, como a pessoa que ligou a régua: a prévia (destino e modo) e o envio. */
export async function sendByWhatsapp(call: ConversaCall, profile: string, step: { id: string; title_id: string }, payment: ReguaPayment): Promise<Outcome> {
  const base = `https://wabotia.internal/api/v1/profiles/${encodeURIComponent(profile)}/erp-conversa/conta/${step.title_id}`;
  const choice = payment === "auto" ? null : payment;
  const read = async (response: Response) => {
    const body = await response.json<any>().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? body?.code ?? "erp_conversa_failed", body?.error?.message ?? body?.message ?? "O envio pela conversa não saiu.");
    return body;
  };
  try {
    const prepared = await read(await call(new Request(choice ? `${base}?pagamento=${choice}` : base)));
    const destination = prepared?.destino;
    if (!destination) return { outcome: "failed", ref: null, reason: prepared?.conectar
      ? "A área não tem linha de WhatsApp ativa. Conecte uma em Conexões."
      : "O cliente não tem telefone no cadastro. Inclua o celular no cadastro do contato." };
    if (destination.modo === "bloqueado") return { outcome: "failed", ref: null, reason: String(destination.motivo ?? "Esta mensagem não pode sair pelo WhatsApp agora.").slice(0, 500) };
    const sent = await read(await call(new Request(`${base}/enviar`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `regua:${step.id}` },
      body: JSON.stringify({ telefone: destination.digitos, linha: destination.linha, ...(choice ? { pagamento: choice } : {}) }),
    })));
    const ref = typeof sent?.envio?.id === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(sent.envio.id) ? sent.envio.id : null;
    return { outcome: "sent", reason: null, ref };
  } catch (error) {
    return failure(error);
  }
}

/** A chamada à rota da conversa no mesmo Worker, como a pessoa (o erro vira resposta, como no app). */
const conversaCall = (env: Env, profile: string, actor: Actor): ConversaCall => async (request) => {
  try { return await erpConversaRoute(env, request, profile, actor); }
  catch (error) {
    if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    throw error;
  }
};

async function sendByEmail(env: Env, profile: string, actor: Actor, step: ReguaEmailStep, payment: ReguaPayment): Promise<Outcome> {
  const send = reguaEmailSender();
  if (!send) return { outcome: "skipped", ref: null, reason: "O envio por e-mail ainda não está disponível nesta instalação." };
  try {
    const result = await send(env, profile, actor, step, payment);
    return result.ok ? { outcome: "sent", reason: null, ref: result.ref ?? null }
      : { outcome: result.retry ? "retry" : "failed", reason: result.reason.slice(0, 500), ref: null };
  } catch (error) { return failure(error); }
}

/** A próxima rodada e o resultado desta (sem motivo: rodou). */
const later = (env: Env, profile: string, now: number, next: number, error: string | null = null) =>
  exec(env, "UPDATE erp_regua_settings SET next_round=?, last_round=?, last_error=? WHERE profile_id=?", next, now, error ? error.slice(0, 500) : null, profile);
const NO_SENDER = "Quem ligou a régua não é mais administrador ativo desta área, e as mensagens saem em nome dessa pessoa. Um administrador precisa desligar e ligar a régua de novo.";

/** Uma rodada da régua da área. */
export async function runRegua(env: Env, profile: string, at: number, options: { call?: ConversaCall } = {}) {
  const settings = await reguaSettings(env, profile);
  if (!settings.enabled) return { status: "off" as const, sent: 0, failed: 0 };
  if (settings.next_round && settings.next_round > at) return { status: "waiting" as const, sent: 0, failed: 0 };
  if (erpPartOffMessage(ERP_REGUA_PART, erpRequirement(ERP_REGUA_PART), await moduleStates(env, profile))) return { status: "part_off" as const, sent: 0, failed: 0 };
  // As mensagens saem em nome de quem ligou a régua, enquanto ele for administrador ativo.
  const actor = settings.enabled_by ? await actorForUser(env, settings.enabled_by) : null;
  if (!actor || actor.role !== "admin") { await later(env, profile, at, at + REGUA_BLOCKED_MS, NO_SENDER); return { status: "no_sender" as const, sent: 0, failed: 0 }; }
  let round: any;
  try {
    round = await reguaRpc(env, profile, actor, "POST", "erp_finance_dunning_round", {
      p_args: { config: engineConfig(settings), email_ready: reguaEmailReady(), limit: REGUA_BATCH },
    });
  } catch (error) {
    // Recusa que não passa sozinha (segundo fator, papel, horário de acesso): espera mais e diz o motivo na tela.
    const reason = `A régua não conseguiu falar com o ERP: ${message(error)}`;
    await later(env, profile, at, at + (transient(error) ? REGUA_BUSY_MS * 5 : REGUA_BLOCKED_MS), reason);
    return { status: "erp_error" as const, sent: 0, failed: 0 };
  }
  const call = options.call ?? conversaCall(env, profile, actor);
  let sent = 0, failed = 0;
  for (const step of round.claimed ?? []) {
    const result = step.channel === "email" ? await sendByEmail(env, profile, actor, step, settings.payment) : await sendByWhatsapp(call, profile, step, settings.payment);
    if (result.outcome === "sent") sent++; else failed++;
    try {
      await reguaRpc(env, profile, actor, "POST", "erp_finance_dunning_report", { p_data: { id: step.id, outcome: result.outcome, reason: result.reason, send_ref: result.ref } });
    } catch { /* A posse vence e a etapa volta; a chave do envio evita a mensagem repetida. */ }
  }
  const claimed = (round.claimed ?? []).length;
  const next = round.in_hours
    ? at + (claimed >= REGUA_BATCH || round.waiting > 0 ? REGUA_BUSY_MS : REGUA_IDLE_MS)
    : Math.min(at + REGUA_IDLE_MS * 4, Math.max(at + REGUA_BUSY_MS, Date.parse(round.next_opening)));
  await later(env, profile, at, next);
  return { status: "ran" as const, sent, failed };
}

// Alarme da área com o Financeiro ligado. Falha de uma área não para as outras nem o agendador.
registerSchedule(ERP_REGUA_PART, async (env: Env, profile: string, at: number) => {
  try { await runRegua(env, profile, typeof at === "number" ? at : Date.now()); } catch { /* tenta de novo na próxima passada */ }
});
