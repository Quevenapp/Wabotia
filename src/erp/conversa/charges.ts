// Cobrança de conta a receber do ERP: "Gerar cobrança" cria um Pix (copia e
// cola e QR) ou um link de pagamento pela Cobrança da área (src/payments.ts,
// docs/COBRANCA.md), sem conversa; o envio pela conversa (./routes.ts) usa a
// mesma cobrança. A confirmação é só a do provedor (webhook assinado e
// consulta na API) e chega aqui pelo gancho do módulo 'erp'.
//
// O gancho só grava no D1 (o que falta fazer); quem mexe no Financeiro é o
// alarme da área (registerSchedule "erp"), pelas rotas do próprio ERP:
//   - baixa automática ligada (Preferências do Financeiro, administrador):
//     a conta é baixada em nome do administrador que ligou a opção, na conta
//     financeira escolhida, com o comprovante do provedor na observação;
//   - desligada (o padrão): vira sugestão de baixa, que a pessoa confirma
//     com um clique (a baixa sai em nome dela, com o papel dela no ERP);
//   - conta baixada ou mudada à mão depois da cobrança: não mexe, vira
//     pendência para a pessoa;
//   - estorno no provedor depois da baixa: o alarme estorna a baixa desta
//     cobrança e a conta reabre, com registro.
// O comando de baixa no ERP tem id derivado da cobrança: o mesmo aviso do
// provedor duas vezes (ou o alarme repetindo) nunca baixa duas vezes.
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { actorForUser, sha } from "../../security";
import { registerPaymentHook, registerSchedule } from "../../modules/hooks";
import { moduleStates } from "../../modules/registry";
import { createDetachedPayment, modulePayment, paymentsMissing, type PaymentMethod } from "../../payments";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { erpCall } from "./documents.ts";
import { day, money } from "./rules.ts";

export const ERP_CHARGE_MODULE = "erp";
/** Estados do que falta fazer no Financeiro (migrations/0165_erp_title_charges.sql). */
export type SettleState = "aguardando" | "baixar" | "sugestao" | "baixada" | "pendencia" | "estornar" | "reaberta" | "encerrada";
export const SETTLE_LABELS: Record<SettleState, string> = {
  aguardando: "Aguardando pagamento", baixar: "Pago: baixando a conta", sugestao: "Pago: confirme a baixa",
  baixada: "Pago e baixado", pendencia: "Pago: confira a conta", estornar: "Estornado: reabrindo a conta",
  reaberta: "Estornado: conta reaberta", encerrada: "Encerrada sem pagamento",
};
const MAX_ATTEMPTS = 12;

export interface ChargeRow {
  id: string; profile_id: string; title_id: string; title_version: number | null; method: PaymentMethod; amount_cents: number;
  description: string; settle_state: SettleState; settlement_id: string | null; note: string | null; attempts: number;
  next_at: number | null; actor: string; confirmed_by: string | null; created: number; updated: number;
}
export interface ChargeSettings {
  auto_settle: boolean; account_id: string | null; payment_method_id: string | null;
  enabled_by: string | null; enabled_at: number | null; updated_by: string | null; updated: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const digits = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;

/** UUID estável a partir de um texto: o id do comando no ERP (repetir não baixa de novo). */
export async function commandId(seed: string): Promise<string> {
  const h = await sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Data (AAAA-MM-DD) no horário de Brasília. */
export const brDate = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

async function audit(env: Env, profile: string, charge: string | null, action: string, actor: string, detail: Record<string, unknown> = {}) {
  await exec(env, "INSERT INTO erp_title_charge_audit(id,profile_id,charge_id,action,actor,detail,created) VALUES(?,?,?,?,?,?,?)",
    uid(), profile, charge, action, actor, JSON.stringify(detail), now());
}

/** A parte Financeiro do ERP ligada; desligada, 409 com o que ligar. */
export async function requireFinance(env: Env, profile: string) {
  const off = erpPartOffMessage("erp-financeiro", erpRequirement("erp-financeiro"), await moduleStates(env, profile));
  if (off) throw new ApiError(409, "module_disabled", `${off} Sem ela, as contas a receber não geram cobrança.`);
}

// ---------------------------------------------------------------------------
// Preferência do Financeiro

export async function chargeSettings(env: Env, profile: string): Promise<ChargeSettings> {
  const row = await one(env, "SELECT * FROM erp_title_charge_settings WHERE profile_id=?", profile);
  return { auto_settle: row?.auto_settle === 1, account_id: row?.account_id ?? null, payment_method_id: row?.payment_method_id ?? null,
    enabled_by: row?.enabled_by ?? null, enabled_at: row?.enabled_at ?? null, updated_by: row?.updated_by ?? null, updated: row?.updated ?? null };
}

/** Só o administrador. Ligar exige a conta financeira e a confirmação do aviso. */
export async function saveChargeSettings(env: Env, actor: Actor, profile: string, body: Record<string, unknown>): Promise<ChargeSettings> {
  if (actor.kind !== "user" || actor.role !== "admin" || actor.via)
    throw new ApiError(403, "admin_required", "Só o administrador da área muda esta preferência do Financeiro.");
  const current = await chargeSettings(env, profile);
  const auto = body.baixar_sozinho === undefined ? current.auto_settle : body.baixar_sozinho;
  if (typeof auto !== "boolean") throw new ApiError(400, "invalid_request", "baixar_sozinho: use verdadeiro ou falso.");
  const pick = (key: string, fallback: string | null) => {
    const value = body[key];
    if (value === undefined) return fallback;
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", `${key}: escolha um item da lista.`);
    return value.toLowerCase();
  };
  const account = pick("conta_financeira", current.account_id), method = pick("forma_pagamento", current.payment_method_id);
  if (auto && !account)
    throw new ApiError(422, "erp_charge_account_required", "Escolha a conta financeira onde as baixas automáticas entram antes de ligar a opção.");
  const turningOn = auto && !current.auto_settle;
  if (turningOn && body.confirmo !== true)
    throw new ApiError(422, "erp_charge_confirm_required", "Confirme o aviso: com a opção ligada, o Financeiro baixa a conta sem uma pessoa conferir, assim que o provedor confirmar o pagamento.");
  const at = now();
  await exec(env, `INSERT INTO erp_title_charge_settings(profile_id,auto_settle,account_id,payment_method_id,enabled_by,enabled_at,updated_by,updated)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET auto_settle=excluded.auto_settle,account_id=excluded.account_id,
      payment_method_id=excluded.payment_method_id,enabled_by=excluded.enabled_by,enabled_at=excluded.enabled_at,updated_by=excluded.updated_by,updated=excluded.updated`,
    profile, auto ? 1 : 0, account, method, auto ? (turningOn ? actor.id : current.enabled_by ?? actor.id) : null,
    auto ? (turningOn ? at : current.enabled_at ?? at) : null, actor.id, at);
  await audit(env, profile, null, turningOn ? "auto_settle_on" : auto !== current.auto_settle ? "auto_settle_off" : "settings_changed", actor.id,
    { by: actor.name || actor.id, account_id: account, payment_method_id: method, before: { auto_settle: current.auto_settle, account_id: current.account_id, payment_method_id: current.payment_method_id } });
  return chargeSettings(env, profile);
}

// ---------------------------------------------------------------------------
// Gerar cobrança

async function readTitle(env: Env, profile: string, actor: Actor, id: string) {
  const body = await erpCall(env, profile, actor, "GET", `/v1/financeiro/titles/${id}/detalhe`, undefined, "esta conta a receber");
  const title = object(body?.record);
  if (title.kind !== "receivable") throw new ApiError(404, "not_found", "Não achamos esta conta a receber no ERP.");
  return title;
}
const isOpen = (title: Record<string, any>) => title.cancelled !== true && ["open", "partial"].includes(title.status);

export async function chargeView(env: Env, row: ChargeRow) {
  const payment = await modulePayment(env, row.profile_id, ERP_CHARGE_MODULE, row.id);
  return {
    id: row.id, conta: row.title_id, forma: row.method, valor_centavos: String(row.amount_cents), valor: money(row.amount_cents),
    descricao: row.description, situacao: payment?.status ?? "created", baixa: row.settle_state, baixa_rotulo: SETTLE_LABELS[row.settle_state],
    motivo: row.note, pix_copia_e_cola: payment?.status === "created" ? payment.pix_code ?? null : null,
    pix_qr: payment?.status === "created" ? payment.pix_qr ?? null : null, link: payment?.status === "created" ? payment.url ?? null : null,
    vence_em: payment?.expires_at ?? null, pago_em: payment?.paid_at ?? null, criada_em: row.created,
    pode_confirmar_baixa: row.settle_state === "sugestao",
  };
}

/** Cobranças da conta, a mais nova primeiro. */
export async function titleCharges(env: Env, profile: string, titleId: string) {
  const rows = await all<ChargeRow>(env, "SELECT * FROM erp_title_charges WHERE profile_id=? AND title_id=? ORDER BY created DESC LIMIT 20", profile, titleId.toLowerCase());
  return Promise.all(rows.map(row => chargeView(env, row)));
}

/** O que a tela mostra antes de gerar: o que falta na Cobrança e a preferência. */
export async function chargeContext(env: Env, actor: Actor, profile: string, titleId: string) {
  await requireFinance(env, profile);
  const title = await readTitle(env, profile, actor, titleId);
  const missing = await paymentsMissing(env, profile);
  const settings = await chargeSettings(env, profile);
  return {
    conta: { id: titleId.toLowerCase(), aberta: isOpen(title), saldo_centavos: digits(title.balance_cents) },
    cobranca_pronta: !missing, falta: missing?.message ?? null, codigo_falta: missing?.code ?? null,
    baixa_automatica: settings.auto_settle,
    cobrancas: await titleCharges(env, profile, titleId),
  };
}

/**
 * Gera (ou devolve a que já está aberta) a cobrança de uma conta a receber em
 * aberto, pelo saldo dela. A mesma conta, forma, saldo e versão devolvem a
 * mesma cobrança: clicar duas vezes não cobra duas vezes.
 */
export async function generateCharge(env: Env, actor: Actor, profile: string, titleId: string, method: unknown) {
  if (method !== "pix" && method !== "link") throw new ApiError(400, "invalid_request", "forma: use pix ou link.");
  await requireFinance(env, profile);
  const id = titleId.toLowerCase();
  const title = await readTitle(env, profile, actor, id);
  if (!isOpen(title)) throw new ApiError(409, "erp_title_not_open", "Só conta a receber em aberto gera cobrança. Esta já foi paga ou cancelada.");
  const balance = digits(title.balance_cents);
  if (!balance || balance === "0") throw new ApiError(409, "erp_title_not_open", "Esta conta não tem saldo em aberto para cobrar.");
  if (BigInt(balance) > 10_000_000n)
    throw new ApiError(422, "erp_charge_amount", "A Cobrança aceita até R$ 100.000,00 por cobrança. Divida a conta em parcelas menores para cobrar por Pix ou link.");
  const missing = await paymentsMissing(env, profile);
  if (missing) throw new ApiError(409, missing.code, missing.message);
  let email: string | null = null;
  if (typeof title.contact_id === "string" && UUID.test(title.contact_id)) {
    try {
      const read = await erpCall(env, profile, actor, "GET", `/v1/cadastros/contacts/${title.contact_id}`, undefined, "o cadastro do cliente");
      const contact = object(read?.record ?? read?.data ?? read);
      email = typeof contact.email === "string" ? contact.email.trim() : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "erp_customer_restricted") throw error;
    }
  }
  const installment = Number.isInteger(title.installment) && Number.isInteger(title.installments) && title.installments > 1 ? ` (parcela ${title.installment}/${title.installments})` : "";
  const description = `${typeof title.description === "string" && title.description.trim() ? title.description.trim().slice(0, 100) : "Conta"}${installment}`;
  const version = Number.isSafeInteger(title.version) ? Number(title.version) : null;
  const { payment, created } = await createDetachedPayment(env, {
    profile, method, amount_cents: Number(balance), description, module: ERP_CHARGE_MODULE, ref: id, actor: actor.id,
    sourceKey: `erp-title:${profile}:${id}:${method}:${balance}:${version ?? ""}`, payerEmail: email,
    // Até o fim do vencimento, entre 1 dia e 30 dias (o Pix do provedor vale no máximo isso).
    expiresMinutes: expiresFor(typeof title.due_on === "string" ? title.due_on : null),
  });
  const at = now();
  await exec(env, `INSERT OR IGNORE INTO erp_title_charges(id,profile_id,title_id,title_version,method,amount_cents,description,settle_state,actor,created,updated)
    VALUES(?,?,?,?,?,?,?,'aguardando',?,?,?)`, payment.id, profile, id, version, method, payment.amount_cents, description, actor.id, at, at);
  if (created) await audit(env, profile, payment.id, "charge_created", actor.id, { title_id: id, method, amount_cents: payment.amount_cents });
  const row = await one<ChargeRow>(env, "SELECT * FROM erp_title_charges WHERE id=?", payment.id);
  return { cobranca: await chargeView(env, row!), nova: created };
}

function expiresFor(dueOn: string | null): number {
  const day = 24 * 60, max = 30 * day;
  const end = dueOn ? Date.parse(`${dueOn}T23:59:59-03:00`) : NaN;
  if (!Number.isFinite(end)) return 3 * day;
  return Math.max(day, Math.min(max, Math.round((end - Date.now()) / 60000)));
}

/** A cobrança aberta da conta, enviada pela conversa, passa a ser dela (só a que ainda não tem conversa). */
export async function attachChargesToConversation(env: Env, profile: string, titleId: string, conversationId: string) {
  await exec(env, `UPDATE payments SET conversation_id=?,updated=? WHERE profile_id=? AND module_id=? AND ref_id=? AND conversation_id='' AND status='created'`,
    conversationId, now(), profile, ERP_CHARGE_MODULE, titleId.toLowerCase());
}

// ---------------------------------------------------------------------------
// Confirmação do provedor (gancho) e efeito no Financeiro (alarme)

/** Só D1: o que a confirmação pede. Idempotente (UPDATE condicionado ao estado). */
export async function onChargeUpdated(env: Env, profile: string, payment: { id: string; status: string }) {
  const row = await one<ChargeRow>(env, "SELECT * FROM erp_title_charges WHERE id=? AND profile_id=?", payment.id, profile);
  if (!row) return;
  const at = now();
  if (payment.status === "paid") {
    const settings = await chargeSettings(env, profile);
    const next = settings.auto_settle && settings.enabled_by && settings.account_id ? "baixar" : "sugestao";
    await exec(env, "UPDATE erp_title_charges SET settle_state=?,next_at=?,attempts=0,note=NULL,updated=? WHERE id=? AND settle_state IN ('aguardando','encerrada')",
      next, at, at, row.id);
  } else if (payment.status === "refunded") {
    await exec(env, `UPDATE erp_title_charges SET settle_state=CASE WHEN settle_state='baixada' THEN 'estornar' ELSE 'encerrada' END,
      note=CASE WHEN settle_state='baixada' THEN NULL ELSE 'O pagamento foi estornado no provedor antes da baixa; a conta continua em aberto.' END,
      next_at=?,attempts=0,updated=? WHERE id=? AND settle_state IN ('aguardando','baixar','sugestao','baixada','pendencia')`, at, at, row.id);
  } else if (payment.status === "expired" || payment.status === "cancelled") {
    await exec(env, "UPDATE erp_title_charges SET settle_state='encerrada',note=?,updated=? WHERE id=? AND settle_state='aguardando'",
      payment.status === "expired" ? "A cobrança venceu sem pagamento." : "A cobrança foi cancelada.", at, row.id);
  }
}

registerPaymentHook(ERP_CHARGE_MODULE, async (env: Env, profile: string, payment: any) => {
  await onChargeUpdated(env, profile, payment);
});

/** Por que a baixa não pode sair: null se a conta está como na cobrança. */
export function settleConflict(row: Pick<ChargeRow, "title_version" | "amount_cents">, title: Record<string, any>): string | null {
  if (!isOpen(title)) return "A conta já estava baixada ou cancelada quando o pagamento chegou. Confira se o cliente pagou duas vezes e devolva o valor a mais, se for o caso.";
  if (row.title_version !== null && Number(title.version) !== row.title_version)
    return "A conta foi mudada à mão depois que a cobrança foi gerada (baixa parcial, valor ou vencimento). Confira e dê a baixa à mão.";
  const balance = digits(title.balance_cents);
  if (!balance || BigInt(balance) < BigInt(row.amount_cents)) return "O saldo da conta ficou menor que o valor pago. Confira e dê a baixa à mão.";
  return null;
}

async function paymentNote(env: Env, row: ChargeRow, methodName: string | null) {
  const payment = await one(env, "SELECT provider,provider_payment_id,paid_at FROM payments WHERE id=?", row.id);
  const when = payment?.paid_at ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(payment.paid_at)) : null;
  const provider = payment?.provider === "mercadopago" ? "Mercado Pago" : payment?.provider ?? "provedor";
  return [`Pago ${row.method === "pix" ? "por Pix" : "pelo link de pagamento"} da Cobrança${when ? ` em ${when}` : ""}.`,
    methodName ? `Forma: ${methodName}.` : "",
    `Comprovante: ${provider}, pagamento nº ${payment?.provider_payment_id ?? "?"}; cobrança ${row.id}.`].filter(Boolean).join(" ").slice(0, 500);
}

async function methodName(env: Env, profile: string, actor: Actor, id: string | null) {
  if (!id) return null;
  try {
    const body = await erpCall(env, profile, actor, "GET", "/v1/financeiro/formas-pagamento?kind=receivable", undefined, "as formas de pagamento");
    const list = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
    const found = list.find((item: any) => item?.id === id);
    return typeof found?.description === "string" ? found.description : null;
  } catch { return null; }
}

/** Baixa a conta pela cobrança paga, como `actor`. Devolve o novo estado. */
export async function settleCharge(env: Env, actor: Actor, row: ChargeRow, accountId: string, methodId: string | null): Promise<{ state: SettleState; note: string | null }> {
  const title = await readTitle(env, row.profile_id, actor, row.title_id);
  const conflict = settleConflict(row, title);
  if (conflict) return { state: "pendencia", note: conflict };
  const payment = await one(env, "SELECT paid_at FROM payments WHERE id=?", row.id);
  const postedOn = brDate(payment?.paid_at ?? now());
  const result = await erpCall(env, row.profile_id, actor, "POST", "/v1/financeiro/actions/settle", {
    command_id: await commandId(`erp-charge-settle:${row.id}`),
    data: { id: row.title_id, expected_version: Number(title.version), account_id: accountId,
      posted_on: postedOn < String(title.issued_on ?? "") ? String(title.issued_on) : postedOn,
      principal_cents: String(row.amount_cents), note: await paymentNote(env, row, await methodName(env, row.profile_id, actor, methodId)) },
  }, "a baixa desta conta");
  const settlement = object(result?.settlement ?? result?.result?.settlement);
  await exec(env, "UPDATE erp_title_charges SET settlement_id=? WHERE id=?", typeof settlement.id === "string" ? settlement.id : null, row.id);
  return { state: "baixada", note: null };
}

/** Estorna a baixa feita por esta cobrança (estorno no provedor). */
export async function reverseCharge(env: Env, actor: Actor, row: ChargeRow): Promise<{ state: SettleState; note: string | null }> {
  if (!row.settlement_id) return { state: "pendencia", note: "O pagamento foi estornado no provedor, mas não achamos a baixa desta cobrança. Estorne a baixa da conta à mão." };
  const title = await readTitle(env, row.profile_id, actor, row.title_id);
  await erpCall(env, row.profile_id, actor, "POST", "/v1/financeiro/actions/reverse", {
    command_id: await commandId(`erp-charge-reverse:${row.id}`),
    data: { id: row.title_id, expected_version: Number(title.version), settlement_id: row.settlement_id, posted_on: brDate(now()),
      note: `Estorno do pagamento no provedor (cobrança ${row.id}). A conta voltou a ficar em aberto.` },
  }, "o estorno da baixa desta conta");
  return { state: "reaberta", note: "O pagamento foi estornado no provedor; a baixa foi estornada e a conta voltou a ficar em aberto." };
}

const permanent = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
const reason = (error: unknown) => error instanceof ApiError ? error.message : "O ERP não respondeu.";

/** Alarme: baixas automáticas e estornos pendentes. Falha permanente vira sugestão ou pendência. */
export async function processCharges(env: Env, profile: string) {
  const rows = await all<ChargeRow>(env, `SELECT * FROM erp_title_charges WHERE profile_id=? AND settle_state IN ('baixar','estornar')
    AND coalesce(next_at,0)<=? ORDER BY updated LIMIT 10`, profile, now());
  if (!rows.length) return;
  if (erpPartOffMessage("erp-financeiro", erpRequirement("erp-financeiro"), await moduleStates(env, profile))) return;
  const settings = await chargeSettings(env, profile);
  for (const row of rows) {
    const reverse = row.settle_state === "estornar";
    // Baixa automática: em nome do administrador que ligou a opção. Estorno:
    // em nome de quem baixou (o administrador ou quem confirmou a sugestão).
    const who = reverse ? row.confirmed_by ?? settings.enabled_by : settings.enabled_by;
    const actor = who ? await actorForUser(env, who) : null;
    let outcome: { state: SettleState; note: string | null };
    try {
      if (!actor) throw new ApiError(403, "erp_charge_actor_missing", reverse
        ? "Quem baixou a conta não está mais ativo na área. Estorne a baixa à mão."
        : "A baixa automática está desligada ou o administrador que a ligou não está mais ativo. Confirme a baixa à mão.");
      if (!reverse && (!settings.auto_settle || !settings.account_id))
        throw new ApiError(409, "erp_charge_auto_off", "A baixa automática foi desligada depois do pagamento. Confirme a baixa à mão.");
      outcome = reverse ? await reverseCharge(env, actor, row) : await settleCharge(env, actor, row, settings.account_id!, settings.payment_method_id);
    } catch (error) {
      if (!permanent(error) && row.attempts + 1 < MAX_ATTEMPTS) {
        await exec(env, "UPDATE erp_title_charges SET attempts=attempts+1,next_at=?,note=?,updated=? WHERE id=? AND settle_state=?",
          now() + Math.min(60_000 * 2 ** row.attempts, 3_600_000), reason(error).slice(0, 500), now(), row.id, row.settle_state);
        continue;
      }
      // Sem conseguir baixar sozinho: a pessoa confirma (ou estorna) à mão.
      outcome = reverse ? { state: "pendencia", note: `O pagamento foi estornado no provedor, mas a baixa não pôde ser estornada sozinha: ${reason(error)} Estorne a baixa da conta à mão.` }
        : { state: "sugestao", note: `A baixa automática não saiu: ${reason(error)}` };
    }
    const changed = await exec(env, "UPDATE erp_title_charges SET settle_state=?,note=?,next_at=NULL,updated=? WHERE id=? AND settle_state=?",
      outcome.state, outcome.note?.slice(0, 500) ?? null, now(), row.id, row.settle_state);
    if (changed.meta?.changes) await audit(env, profile, row.id, reverse ? `reverse_${outcome.state}` : `auto_${outcome.state}`, who ?? "system",
      { title_id: row.title_id, amount_cents: row.amount_cents, note: outcome.note });
  }
}

// Alarme da área com o ERP ligado: baixas e estornos das cobranças e o
// financeiro de exemplo dos modelos de ramo que espera o ERP ficar de pé.
registerSchedule(ERP_CHARGE_MODULE, async (env: Env, profile: string) => {
  try { await processCharges(env, profile); }
  finally {
    const { mountPendingErpExamples } = await import("../../area-templates/erp-examples");
    await mountPendingErpExamples(env, profile);
  }
});

/** Um clique: a pessoa confirma a sugestão de baixa (com o papel dela no ERP). */
export async function confirmSuggestion(env: Env, actor: Actor, profile: string, titleId: string, chargeId: string, body: Record<string, unknown>) {
  await requireFinance(env, profile);
  const row = await one<ChargeRow>(env, "SELECT * FROM erp_title_charges WHERE id=? AND profile_id=? AND title_id=?", chargeId, profile, titleId.toLowerCase());
  if (!row) throw new ApiError(404, "not_found", "Cobrança não encontrada nesta conta.");
  if (row.settle_state === "baixada") return { cobranca: await chargeView(env, row), repetido: true };
  if (row.settle_state !== "sugestao")
    throw new ApiError(409, "erp_charge_not_suggested", row.settle_state === "aguardando" ? "O provedor ainda não confirmou o pagamento desta cobrança." : `Esta cobrança não tem baixa a confirmar (${SETTLE_LABELS[row.settle_state].toLowerCase()}).`);
  const settings = await chargeSettings(env, profile);
  const account = typeof body.conta_financeira === "string" && UUID.test(body.conta_financeira) ? body.conta_financeira.toLowerCase() : settings.account_id;
  if (!account) throw new ApiError(422, "erp_charge_account_required", "Escolha a conta financeira onde o pagamento entrou.");
  const method = typeof body.forma_pagamento === "string" && UUID.test(body.forma_pagamento) ? body.forma_pagamento.toLowerCase() : settings.payment_method_id;
  const outcome = await settleCharge(env, actor, row, account, method);
  await exec(env, "UPDATE erp_title_charges SET settle_state=?,note=?,confirmed_by=?,updated=? WHERE id=? AND settle_state='sugestao'",
    outcome.state, outcome.note, outcome.state === "baixada" ? actor.id : null, now(), row.id);
  await audit(env, profile, row.id, `confirm_${outcome.state}`, actor.id, { title_id: row.title_id, account_id: account, note: outcome.note });
  const fresh = await one<ChargeRow>(env, "SELECT * FROM erp_title_charges WHERE id=?", row.id);
  if (outcome.state !== "baixada") throw new ApiError(409, "erp_charge_conflict", outcome.note ?? "A conta mudou desde a cobrança. Confira e dê a baixa à mão.");
  return { cobranca: await chargeView(env, fresh!), repetido: false, data: day(brDate(now())) };
}
