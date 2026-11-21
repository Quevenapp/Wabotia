// Rotas da régua de cobrança e das recorrências automáticas, em
// /api/v1/profiles/:profile/erp-regua (operações em ./contract.ts).
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a leitura
// concedida), módulo ERP ligado e a parte Financeiro ligada (desligada: 409
// module_disabled e qual ligar). Ligar, desligar e mudar a régua: só o
// administrador da área, pela tela, com a confirmação do aviso ao ligar. O
// motor confere de novo papel, permissão, horário de acesso e segundo fator.
import { exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import {
  ERP_REGUA_PART, ERP_REGUA_ROUTE, REGUA_DEFAULTS, REGUA_WARNING, ReguaArgsError, engineConfig, erpReguaOperationFor, nextSettings, reguaIds, reguaUuid,
  type ReguaSettings,
} from "./contract.ts";
import { reguaEmailReady } from "./email-hook.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
const OFF = "A régua de cobrança e as contas recorrentes fazem parte do Financeiro, que está desligado nesta área. Ligue Financeiro em Gestão → Módulos.";

/** Motivos conhecidos do motor, em palavras de quem usa. */
export const REGUA_REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_finance_access_denied: [403, "forbidden", "Seu papel no ERP não alcança o Financeiro. A régua é de quem tem o papel Financeiro ou Administrador (Consulta só vê). Peça ao administrador em Pessoas e acessos."],
  erp_finance_not_found: [404, "not_found", "A conta recorrente não foi encontrada. Atualize a lista."],
  erp_dunning_send_requires_auto: [400, "invalid_request", "Para enviar a cobrança ao gerar, marque também “Gerar sozinha”."],
  erp_dunning_send_receivable_only: [400, "invalid_request", "Só conta a receber envia cobrança ao cliente. Nas contas a pagar, use só “Gerar sozinha”."],
  erp_dunning_invalid_config: [400, "invalid_request", "Confira o horário comercial e os canais da régua."],
  erp_dunning_invalid_args: [400, "invalid_request", "Confira os dados e tente de novo."],
  erp_finance_invalid_id: [400, "invalid_request", "Identificador inválido. Atualize a tela e tente de novo."],
  erp_dunning_step_not_found: [404, "not_found", "Este envio da régua não foi encontrado."],
};

/** Chama o RPC no objeto erp: da área, como a pessoa (com o portão de horário e segundo fator). */
export async function reguaRpc(env: Env, profile: string, actor: Actor, method: "GET" | "POST", rpc: string, args: Record<string, unknown>) {
  const pathname = `/api/v1/profiles/${encodeURIComponent(profile)}/${ERP_REGUA_ROUTE}`;
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read: method === "GET", gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", OFF);
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "O acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || (response.status === 409 && /parte desligada/.test(code))) throw new ApiError(409, "module_disabled", OFF);
    const known = REGUA_REASONS[code];
    if (known) throw new ApiError(known[0], known[1], known[2]);
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta ação no Financeiro. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

// ---------------------------------------------------------------------------
// Configuração no D1

export async function reguaSettings(env: Env, profile: string): Promise<ReguaSettings & { next_round: number | null; last_round: number | null; last_error: string | null }> {
  const row = await one(env, "SELECT * FROM erp_regua_settings WHERE profile_id=?", profile);
  if (!row) return { ...REGUA_DEFAULTS, next_round: null, last_round: null, last_error: null };
  return {
    enabled: row.enabled === 1, whatsapp: row.whatsapp === 1, email: row.email === 1, payment: row.payment ?? "auto",
    before: row.days_before ?? null, on_due: row.on_due === null || row.on_due === undefined ? null : row.on_due === 1, after: row.days_after ?? null,
    hour_from: Number(row.hour_from), hour_to: Number(row.hour_to), business_days: row.business_days === 1,
    enabled_by: row.enabled_by ?? null, enabled_at: row.enabled_at ?? null, updated_by: row.updated_by ?? null, updated: row.updated ?? null,
    next_round: row.next_round ?? null, last_round: row.last_round ?? null, last_error: row.last_error ?? null,
  };
}

async function saveSettings(env: Env, profile: string, actor: Actor, current: ReguaSettings, next: ReguaSettings) {
  const at = now();
  const turningOn = next.enabled && !current.enabled;
  const enabledBy = next.enabled ? (turningOn ? actor.id : current.enabled_by ?? actor.id) : null;
  const enabledAt = next.enabled ? (turningOn ? at : current.enabled_at ?? at) : null;
  await exec(env, `INSERT INTO erp_regua_settings(profile_id,enabled,days_before,on_due,days_after,whatsapp,email,payment,hour_from,hour_to,business_days,
      enabled_by,enabled_at,updated_by,updated,next_round)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET enabled=excluded.enabled,days_before=excluded.days_before,
      on_due=excluded.on_due,days_after=excluded.days_after,whatsapp=excluded.whatsapp,email=excluded.email,
      payment=excluded.payment,hour_from=excluded.hour_from,hour_to=excluded.hour_to,business_days=excluded.business_days,enabled_by=excluded.enabled_by,
      enabled_at=excluded.enabled_at,updated_by=excluded.updated_by,updated=excluded.updated,next_round=excluded.next_round`,
  profile, next.enabled ? 1 : 0, next.before, next.on_due === null ? null : next.on_due ? 1 : 0, next.after,
  next.whatsapp ? 1 : 0, next.email ? 1 : 0, next.payment, next.hour_from, next.hour_to, next.business_days ? 1 : 0,
  enabledBy, enabledAt, actor.id, at, at);
  // Ligar de novo (outro administrador, por exemplo) recomeça sem o motivo da última rodada.
  if (turningOn) await exec(env, "UPDATE erp_regua_settings SET last_error=NULL WHERE profile_id=?", profile);
  const action = turningOn ? "regua_on" : current.enabled && !next.enabled ? "regua_off" : "settings_changed";
  await exec(env, "INSERT INTO erp_regua_audit(id,profile_id,action,actor,detail,created) VALUES(?,?,?,?,?,?)", uid(), profile, action, actor.id,
    JSON.stringify({ by: actor.name || actor.id, before: engineConfig(current), after: engineConfig(next), payment: next.payment }), at);
}

/** Quem ligou a régua, e se ainda pode mandar em nome da área (administrador ativo). */
async function senderView(env: Env, id: string | null) {
  if (!id) return null;
  const row = await one(env, "SELECT name, role, disabled FROM users WHERE id=?", id);
  return { nome: row?.name ?? "Pessoa removida", ativo: !!row && row.disabled === 0 && row.role === "admin" };
}

async function overview(env: Env, profile: string, actor: Actor) {
  const settings = await reguaSettings(env, profile);
  const engine = await reguaRpc(env, profile, actor, "GET", "erp_finance_dunning_overview", { p_args: { config: engineConfig(settings), email_ready: reguaEmailReady() } });
  const sender = await senderView(env, settings.enabled_by);
  return {
    regua: {
      ligada: settings.enabled, whatsapp: settings.whatsapp, email: settings.email, pagamento: settings.payment,
      dias_antes: settings.before, no_vencimento: settings.on_due, dias_depois: settings.after,
      hora_inicio: settings.hour_from, hora_fim: settings.hour_to, so_dias_uteis: settings.business_days,
      ligada_em: settings.enabled_at, ligada_por: sender?.nome ?? null,
      remetente_ativo: settings.enabled ? sender?.ativo === true : null,
      ultima_rodada: settings.last_round, ultimo_erro: settings.enabled ? settings.last_error : null,
    },
    email_disponivel: reguaEmailReady(),
    pode_mudar: actor.role === "admin" && !actor.via,
    aviso: REGUA_WARNING,
    ...engine,
  };
}

/** GET/POST /api/v1/profiles/:profile/erp-regua[/…]. */
export async function erpReguaRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpReguaOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "A régua de cobrança atende uma pessoa da área (ou o bot, só para consultar).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  // Parte desligada antes de qualquer outra conferência: diz qual módulo ligar.
  const off = erpPartOffMessage(ERP_REGUA_PART, erpRequirement(ERP_REGUA_PART), await moduleStates(env, profile));
  if (off) throw new ApiError(409, "module_disabled", off);
  if (actor.via && operation.bot === false) throw new ApiError(403, "erp_bot_grant_required", "Esta operação da régua é só pela tela, não pelo bot.");
  if (operation.admin && (actor.role !== "admin" || actor.via))
    throw new ApiError(403, "admin_required", "Só o administrador da área liga, desliga ou muda a régua de cobrança.");
  for (const key of url.searchParams.keys()) if (!operation.query.includes(key)) bad(`Parâmetro não aceito: ${key}.`);
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  if (actor.via && !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body))
    throw new ApiError(403, "erp_bot_grant_required", "Esta consulta da régua não foi liberada para este bot.");
  try {
    switch (operation.name) {
      case "erp.regua.ver":
        return json(await overview(env, profile, actor));
      case "erp.regua.configurar": {
        const current = await reguaSettings(env, profile);
        const next = nextSettings(current, body!);
        if (next.enabled && !current.enabled) {
          if (body!.confirmo !== true) throw new ApiError(422, "erp_regua_confirm_required", `Confirme o aviso para ligar a régua: ${REGUA_WARNING}`);
          // Quem liga precisa escrever no Financeiro do ERP: a régua roda em nome dele.
          await reguaRpc(env, profile, actor, "POST", "erp_finance_dunning_round", { p_args: { config: { ...engineConfig(next), enabled: false }, limit: 0 } });
        }
        await saveSettings(env, profile, actor, current, next);
        return json(await overview(env, profile, actor));
      }
      case "erp.regua.recorrentes":
        return json(await reguaRpc(env, profile, actor, "GET", "erp_finance_recurrence_auto_list", { p_args: { ...(reguaIds(url.searchParams.get("ids")) ? { ids: reguaIds(url.searchParams.get("ids")) } : {}) } }));
      case "erp.regua.recorrente_automatica": {
        const automatic = typeof body!.automatica === "boolean" ? body!.automatica : bad("automatica: use verdadeiro ou falso.");
        const send = body!.enviar_cobranca === undefined ? false : typeof body!.enviar_cobranca === "boolean" ? body!.enviar_cobranca : bad("enviar_cobranca: use verdadeiro ou falso.");
        return json(await reguaRpc(env, profile, actor, "POST", "erp_finance_recurrence_auto_set", { p_data: { id: reguaUuid(params.id, "id"), auto_generate: automatic, send_charge: send } }));
      }
    }
  } catch (error) {
    if (error instanceof ReguaArgsError) throw new ApiError(400, "invalid_request", error.message);
    throw error;
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
