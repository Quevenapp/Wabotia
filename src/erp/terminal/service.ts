// Maquininha integrada ao caixa: o PDV manda o valor das parcelas de cartão
// da venda para a maquininha do caixa pela nuvem do provedor (Mercado Pago
// Point primeiro), mostra "Aguardando pagamento na maquininha" e finaliza a
// venda quando o pagamento é aprovado, com bandeira, parcelas, autorização e
// NSU na observação da parcela. Recusado ou cancelado, a venda continua
// aberta e a tela diz o motivo.
//
// Regras:
// - nasce desligada; só o administrador liga, escolhe a credencial (a mesma
//   conta do Mercado Pago da Cobrança ou um Access Token próprio, no cofre do
//   núcleo), as formas de pagamento de débito e crédito e o terminal de cada
//   caixa;
// - uma venda nunca tem duas cobranças em andamento: pedir de novo consulta a
//   que existe e devolve a mesma; resposta incerta (o pedido pode ter
//   chegado) é consultada no provedor antes de qualquer reenvio, e o reenvio
//   só sai quando a cobrança não está lá e a pessoa confirma;
// - o resultado vale só pela consulta autenticada ao provedor: o aviso
//   (webhook) só faz o Vinki consultar;
// - aprovado, a tela finaliza a venda pelo PDV de sempre (o mesmo comando do
//   botão Finalizar) e avisa aqui; o pagamento entra na conciliação de
//   cartões já casado com a venda (erp_reconciliation_card_terminal).
//
// Segredos (Access Token, assinatura do aviso) só no cofre (secrets, cifrados
// com a MASTER_KEY); nunca em log, auditoria ou resposta.
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { secret, setSecret, sha } from "../../security";
import { moduleStates } from "../../modules/registry";
import { erpIdentity } from "../../modules/erp/identity";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { localFetch } from "../api/local-fetch.ts";
import { erpCall } from "../conversa/documents.ts";
import { TerminalError, type TerminalCharge, type TerminalContext, type TerminalCredentials, type TerminalHttp, type TerminalProvider } from "./adapter.ts";
import { TERMINAL_ADAPTERS } from "./providers/index.ts";
import { terminalTransport } from "./transport.ts";
import {
  ERP_TERMINAL_PART, TERMINAL_BRAND_LABELS, TERMINAL_KIND_LABELS, TERMINAL_MAX_INSTALLMENTS, TERMINAL_OPEN_STATUSES, TERMINAL_PROVIDERS, TERMINAL_PROVIDER_INFO,
  TERMINAL_STATUS_LABELS, terminalPaymentNote,
  type TerminalBrand, type TerminalCardKind, type TerminalInstallmentsCost, type TerminalProviderId, type TerminalStatus,
} from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, max = 200) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/** Consulta ao provedor no máximo a cada 2 segundos por cobrança (a tela pergunta de 2 em 2). */
const CHECK_EVERY_MS = 2_000;
/** "Enviando" parado há mais que isso (o Worker caiu no meio): vira incerto e é consultado. */
const SENDING_STALE_MS = 60_000;
const NOT_FOUND = "Não achamos a cobrança no Mercado Pago. Olhe a maquininha: se ela não mostrou a cobrança, use “Não apareceu na maquininha, enviar de novo”; se mostrou, espere o resultado.";

export interface SettingsRow {
  profile_id: string; enabled: number; provider: TerminalProviderId; credential: "cobranca" | "propria"; debit_method_id: string | null; credit_method_id: string | null;
  max_installments: number; installments_cost: TerminalInstallmentsCost; webhook_hash: string | null; enabled_by: string | null; enabled_at: number | null;
  updated_by: string; updated: number;
}
interface CashierRow { profile_id: string; account_id: string; provider: TerminalProviderId; device_id: string; device_name: string; updated_by: string; updated: number }
export interface TerminalPaymentRow {
  id: string; profile_id: string; sale_id: string; sale_number: string | null; account_id: string; provider: TerminalProviderId; device_id: string; payment_method_id: string;
  kind: TerminalCardKind; installments: number; amount_cents: number; reference: string; provider_ref: string | null; provider_payment_id: string | null;
  status: TerminalStatus; reason: string | null; brand: TerminalBrand | null; authorization_code: string | null; nsu: string | null; card_last4: string | null;
  fee_cents: number | null; paid_at: number | null; sale_finished_at: number | null; reconcile_state: string | null; reconcile_note: string | null;
  command_id: string; actor: string; attempts: number; checked_at: number | null; created: number; updated: number;
}

// ---------------------------------------------------------------------------
// Portas (os testes trocam: provedor simulado no lugar da rede; ERP simulado)

let transportFor: (env: Env, provider: TerminalProviderId) => TerminalHttp = () => terminalTransport();
/** Só para os testes: o provedor simulado no lugar da rede. */
export function setTerminalTransport(factory: ((env: Env, provider: TerminalProviderId) => TerminalHttp) | null) { transportFor = factory ?? (() => terminalTransport()); }

/** O que o serviço lê e grava no ERP (como a pessoa). */
export interface TerminalSale {
  id: string; number: string | null; state: "open" | "finished" | "cancelled" | string; account_id: string | null;
  payments: { position: number; payment_method_id: string; amount_cents: string; title_id: string | null; note: string | null }[];
}
export interface TerminalErpContext {
  stores: { id: string; name: string }[];
  methods: { id: string; description: string; payment_type: string }[];
  permissions: { payments: boolean; finish: boolean };
}
export interface TerminalReconcileArgs {
  sale_id: string; payment_method_id: string; acquirer: string; product: "debit" | "credit"; brand: TerminalBrand; installments: number; gross_cents: string;
  fee_cents: string; nsu: string | null; authorization: string | null; reference: string; command_id: string;
}
export interface TerminalErp {
  context(env: Env, actor: Actor, profile: string): Promise<TerminalErpContext>;
  sale(env: Env, actor: Actor, profile: string, id: string): Promise<TerminalSale>;
  reconcile(env: Env, actor: Actor, profile: string, args: TerminalReconcileArgs): Promise<{ state: "matched" | "pending"; note: string }>;
}

const defaultErp: TerminalErp = {
  async context(env, actor, profile) {
    const body = object(await erpCall(env, profile, actor, "GET", "/v1/frente-caixa", undefined, "a frente de caixa"));
    const permissions = object(body.permissions);
    return {
      stores: (Array.isArray(body.stores) ? body.stores : []).map(object).map(item => ({ id: String(item.id).toLowerCase(), name: String(item.name ?? "") })),
      methods: (Array.isArray(body.methods) ? body.methods : []).map(object).map(item => ({ id: String(item.id).toLowerCase(), description: String(item.description ?? ""), payment_type: String(item.payment_type ?? "") })),
      permissions: { payments: permissions.payments === true, finish: permissions.finish === true },
    };
  },
  async sale(env, actor, profile, id) {
    const body = object(await erpCall(env, profile, actor, "GET", `/v1/frente-caixa/vendas/${encodeURIComponent(id)}`, undefined, "a venda do PDV"));
    const record = object(body.record);
    return {
      id: String(record.id ?? "").toLowerCase(), number: record.number == null ? null : String(record.number), state: String(record.state ?? ""),
      account_id: typeof record.account_id === "string" ? record.account_id.toLowerCase() : null,
      payments: (Array.isArray(record.payments) ? record.payments : []).map(object).map(item => ({ position: Number(item.position), payment_method_id: String(item.payment_method_id ?? "").toLowerCase(),
        amount_cents: String(item.amount_cents ?? "0"), title_id: typeof item.title_id === "string" ? item.title_id : null, note: typeof item.note === "string" ? item.note : null })),
    };
  },
  async reconcile(env, actor, profile, args) {
    const pathname = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-maquininha`;
    const identity = await erpIdentity(env, actor, profile, "POST", pathname);
    const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
    const { command_id, ...rest } = args;
    const response = await localFetch(env, profile, actor, identity, { read: false, gate, trackCustomers: false })(
      "https://erp.wabotia.invalid/rest/v1/rpc/erp_reconciliation_card_terminal",
      { method: "POST", body: JSON.stringify({ p_user_id: identity.actor!.user_id, p_command_id: command_id, p_args: rest }) });
    const body = object(await response.json().catch(() => null));
    if (gate.partsDenied === "module_disabled" || body.code === "module_disabled") throw new TerminalReconcileSkip("A conciliação de cartões faz parte do Financeiro, que está desligado.");
    if (gate.denied) throw new TerminalReconcileSkip("Fora do horário de acesso ao ERP ou sem o segundo fator: a conciliação fica para depois.");
    if (!response.ok) throw new TerminalReconcileSkip(`O ERP não pôs o pagamento na conciliação (${typeof body.message === "string" ? body.message.slice(0, 80) : response.status}).`);
    return { state: body.state === "matched" ? "matched" : "pending", note: typeof body.note === "string" ? body.note : "" };
  },
};
let erp: TerminalErp = defaultErp;
/** Só para os testes: o ERP simulado (contexto da frente de caixa, venda e conciliação). */
export function setTerminalErp(port: TerminalErp | null) { erp = port ?? defaultErp; }
export class TerminalReconcileSkip extends Error {}

const vaultId = (profile: string) => `erp-maquininha:${profile}`;

async function audit(env: Env, profile: string, payment: string | null, action: string, actor: string, detail: Record<string, unknown> = {}) {
  await exec(env, "INSERT INTO erp_terminal_audit(id,profile_id,payment_id,action,actor,detail,created) VALUES(?,?,?,?,?,?,?)",
    uid(), profile, payment, action, actor, JSON.stringify(detail), now());
}

/** O Caixa / PDV (com Vendas, Financeiro e Estoque) ligado; desligado, 409 com o que ligar. */
export async function requirePdv(env: Env, profile: string) {
  const off = erpPartOffMessage(ERP_TERMINAL_PART, erpRequirement(ERP_TERMINAL_PART), await moduleStates(env, profile));
  if (off) throw new ApiError(409, "module_disabled", `${off} Sem ele, a maquininha não fica integrada ao caixa.`);
}

const isAdmin = (actor: Actor) => actor.kind === "user" && actor.role === "admin" && !actor.via;
const requireAdmin = (actor: Actor, what: string) => {
  if (!isAdmin(actor)) throw new ApiError(403, "admin_required", `Só o administrador da área ${what}.`);
};

export async function settingsRow(env: Env, profile: string) {
  return one<SettingsRow>(env, "SELECT * FROM erp_terminal_settings WHERE profile_id=?", profile);
}

/** A conta do Mercado Pago da Cobrança da área, se houver. */
async function chargeAccount(env: Env, profile: string) {
  return one<{ id: string; provider: string; enabled: number }>(env, "SELECT id,provider,enabled FROM payment_accounts WHERE profile_id=?", profile);
}

async function credentialsOf(env: Env, profile: string, settings: SettingsRow): Promise<TerminalCredentials> {
  const own = await secret(env, vaultId(profile));
  if (settings.credential === "cobranca") {
    const account = await chargeAccount(env, profile);
    if (!account || account.provider !== settings.provider)
      throw new TerminalError("configuracao", "A área não tem a conta do Mercado Pago na Cobrança. Configure em Gestão → Automação → Cobrança, ou cole um Access Token próprio na maquininha integrada.");
    const { accountCredentials } = await import("../../payments");
    const keys = await accountCredentials(env, account.id);
    // A assinatura do aviso da maquininha pode ser outra (aplicação própria para a maquininha).
    return { access_token: keys.access_token, webhook_secret: String(own.webhook_secret || keys.webhook_secret || "") };
  }
  return { access_token: String(own.access_token || ""), webhook_secret: String(own.webhook_secret || "") };
}

async function contextOf(env: Env, profile: string, settings: SettingsRow): Promise<{ adapter: TerminalProvider; ctx: TerminalContext }> {
  const adapter = TERMINAL_ADAPTERS[settings.provider];
  return { adapter, ctx: { http: transportFor(env, settings.provider), credentials: await credentialsOf(env, profile, settings) } };
}

const terminalProblem = (error: unknown, status = 502): never => {
  if (error instanceof TerminalError) {
    const code = error.kind === "configuracao" ? 422 : error.kind === "ocupado" ? 409 : error.kind === "credencial" ? 502 : status;
    throw new ApiError(code, `erp_terminal_${error.kind}`, error.message);
  }
  throw error;
};

// ---------------------------------------------------------------------------
// Configuração (Preferências › Vendas › Frente de caixa)

export async function terminalSettings(env: Env, actor: Actor, profile: string, origin: string) {
  await requirePdv(env, profile);
  const row = await settingsRow(env, profile);
  const cashiers = await all<CashierRow>(env, "SELECT * FROM erp_terminal_cashiers WHERE profile_id=? ORDER BY account_id", profile);
  const own = await secret(env, vaultId(profile));
  const account = await chargeAccount(env, profile);
  const admin = isAdmin(actor);
  let context: TerminalErpContext | null = null, contextError: string | null = null;
  try { context = await erp.context(env, actor, profile); } catch (error) { contextError = error instanceof ApiError ? error.message : "Não deu para ler a frente de caixa agora."; }
  const credential = row?.credential ?? (account ? "cobranca" : "propria");
  const tokenReady = credential === "cobranca" ? Boolean(account && account.provider === (row?.provider ?? "mercadopago")) : Boolean(own.access_token);
  const methodName = (id: string | null) => context?.methods.find(item => item.id === id)?.description ?? null;
  const falta: string[] = [];
  if (!tokenReady) falta.push(credential === "cobranca" ? "a conta do Mercado Pago na Cobrança" : "o Access Token do Mercado Pago");
  if (!row?.debit_method_id && !row?.credit_method_id) falta.push("a forma de pagamento de débito ou de crédito");
  if (!cashiers.length) falta.push("a maquininha de um caixa");
  return {
    ligado: row?.enabled === 1, ligado_em: row?.enabled_at ?? null,
    provedor: row?.provider ?? "mercadopago", provedores: TERMINAL_PROVIDERS.map(id => ({ id, nome: TERMINAL_PROVIDER_INFO[id].name, terminal: TERMINAL_PROVIDER_INFO[id].device })),
    credencial: credential, conta_cobranca: Boolean(account && account.provider === "mercadopago"),
    segredos_guardados: [own.access_token ? "access_token" : null, own.webhook_secret ? "webhook_secret" : null].filter(Boolean),
    forma_debito: row?.debit_method_id ?? null, forma_debito_nome: methodName(row?.debit_method_id ?? null),
    forma_credito: row?.credit_method_id ?? null, forma_credito_nome: methodName(row?.credit_method_id ?? null),
    parcelas_max: row?.max_installments ?? TERMINAL_MAX_INSTALLMENTS, juros_parcelado: row?.installments_cost ?? "loja",
    caixas: (context?.stores ?? []).map(store => {
      const found = cashiers.find(item => item.account_id === store.id);
      return { id: store.id, nome: store.name, terminal: found?.device_id ?? null, terminal_nome: found?.device_name ?? null };
    }).concat(cashiers.filter(item => !context?.stores.some(store => store.id === item.account_id)).map(item => ({ id: item.account_id, nome: "Caixa não encontrado no PDV", terminal: item.device_id, terminal_nome: item.device_name }))),
    formas: (context?.methods ?? []).filter(item => ["03", "04", "99"].includes(item.payment_type)).map(item => ({ id: item.id, nome: item.description, tipo: item.payment_type === "04" ? "debito" : item.payment_type === "03" ? "credito" : "outro" })),
    falta, pronto: row?.enabled === 1 && falta.length === 0, leitura_pdv: contextError,
    aviso_url: admin && row?.webhook_hash && typeof own.webhook_token === "string" ? `${origin.replace(/\/$/, "")}/webhooks/maquininha/${own.webhook_token}` : null,
    pode_mudar: admin,
  };
}

const methodIdOf = (value: unknown, label: string) => {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", `${label}: escolha uma forma de pagamento da lista.`);
  return value.toLowerCase();
};

/** Só o administrador. Os segredos vão para o cofre; vazio mantém o guardado. */
export async function saveTerminalSettings(env: Env, actor: Actor, profile: string, body: Record<string, unknown>, origin: string) {
  requireAdmin(actor, "configura a maquininha integrada");
  await requirePdv(env, profile);
  const current = await settingsRow(env, profile);
  const enabled = body.ligado === undefined ? current?.enabled === 1 : body.ligado;
  if (typeof enabled !== "boolean") throw new ApiError(400, "invalid_request", "ligado: use verdadeiro ou falso.");
  const provider = body.provedor === undefined ? current?.provider ?? "mercadopago" : body.provedor;
  if (!TERMINAL_PROVIDERS.includes(provider as TerminalProviderId)) throw new ApiError(400, "invalid_request", "provedor: por enquanto só mercadopago.");
  const account = await chargeAccount(env, profile);
  const credential = body.credencial === undefined ? current?.credential ?? (account ? "cobranca" : "propria") : body.credencial;
  if (credential !== "cobranca" && credential !== "propria") throw new ApiError(400, "invalid_request", "credencial: use cobranca (a conta da Cobrança) ou propria.");
  const debit = body.forma_debito === undefined ? current?.debit_method_id ?? null : methodIdOf(body.forma_debito, "Forma de débito");
  const credit = body.forma_credito === undefined ? current?.credit_method_id ?? null : methodIdOf(body.forma_credito, "Forma de crédito");
  if (debit && credit && debit === credit) throw new ApiError(400, "invalid_request", "Use formas de pagamento diferentes para débito e crédito.");
  const max = body.parcelas_max === undefined ? current?.max_installments ?? TERMINAL_MAX_INSTALLMENTS : body.parcelas_max;
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > TERMINAL_ADAPTERS[provider as TerminalProviderId].maxInstallments)
    throw new ApiError(400, "invalid_request", `parcelas_max: de 1 a ${TERMINAL_ADAPTERS[provider as TerminalProviderId].maxInstallments}.`);
  const cost = body.juros_parcelado === undefined ? current?.installments_cost ?? "loja" : body.juros_parcelado;
  if (cost !== "loja" && cost !== "cliente") throw new ApiError(400, "invalid_request", "juros_parcelado: use loja ou cliente.");
  for (const [key, label] of [["access_token", "o Access Token"], ["webhook_secret", "a assinatura secreta do aviso"]] as const)
    if (body[key] !== undefined && body[key] !== "" && (typeof body[key] !== "string" || (body[key] as string).trim().length < 8 || (body[key] as string).length > 500))
      throw new ApiError(400, "invalid_request", `Confira ${label}.`);
  if (credential === "cobranca" && (!account || account.provider !== provider))
    throw new ApiError(422, "erp_terminal_configuracao", "A área não tem a conta do Mercado Pago na Cobrança. Configure em Gestão → Automação → Cobrança, ou escolha usar um Access Token próprio.");
  // Formas conferidas na frente de caixa: débito e crédito de verdade (tipos 04 e 03), ativas para recebimento.
  if (debit || credit) {
    const context = await erp.context(env, actor, profile);
    for (const [id, type, label] of [[debit, "04", "débito"], [credit, "03", "crédito"]] as const) {
      if (!id) continue;
      const method = context.methods.find(item => item.id === id);
      if (!method) throw new ApiError(422, "erp_terminal_configuracao", `A forma de ${label} escolhida não está ativa para recebimentos no PDV. Confira em Cadastros → Formas de pagamento.`);
      if (method.payment_type !== type && method.payment_type !== "99")
        throw new ApiError(422, "erp_terminal_configuracao", `A forma “${method.description}” não é de cartão de ${label}. Escolha uma forma do tipo cartão de ${label}.`);
    }
  }
  const own = await secret(env, vaultId(profile));
  const keys = {
    access_token: text(body.access_token, 500) ?? String(own.access_token || ""),
    webhook_secret: text(body.webhook_secret, 500) ?? String(own.webhook_secret || ""),
    webhook_token: typeof own.webhook_token === "string" ? own.webhook_token : Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join(""),
  };
  if (enabled && credential === "propria" && !keys.access_token) throw new ApiError(422, "erp_terminal_configuracao", "Cole o Access Token de produção do Mercado Pago para ligar a maquininha.");
  if (enabled && !debit && !credit) throw new ApiError(422, "erp_terminal_configuracao", "Escolha a forma de pagamento de débito ou de crédito que vai para a maquininha.");
  await setSecret(env, vaultId(profile), keys);
  const at = now(), turningOn = enabled && current?.enabled !== 1;
  await exec(env, `INSERT INTO erp_terminal_settings(profile_id,enabled,provider,credential,debit_method_id,credit_method_id,max_installments,installments_cost,webhook_hash,enabled_by,enabled_at,updated_by,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET enabled=excluded.enabled,provider=excluded.provider,credential=excluded.credential,
      debit_method_id=excluded.debit_method_id,credit_method_id=excluded.credit_method_id,max_installments=excluded.max_installments,installments_cost=excluded.installments_cost,
      webhook_hash=excluded.webhook_hash,enabled_by=excluded.enabled_by,enabled_at=excluded.enabled_at,updated_by=excluded.updated_by,updated=excluded.updated`,
    profile, enabled ? 1 : 0, provider, credential, debit, credit, max, cost, await sha(keys.webhook_token),
    enabled ? (turningOn ? actor.id : current?.enabled_by ?? actor.id) : null, enabled ? (turningOn ? at : current?.enabled_at ?? at) : null, actor.id, at);
  await audit(env, profile, null, turningOn ? "settings_on" : !enabled && current?.enabled === 1 ? "settings_off" : "settings_changed", actor.id,
    { provider, credential, debit, credit, max_installments: max, installments_cost: cost, token_changed: Boolean(text(body.access_token, 500)), webhook_secret_changed: Boolean(text(body.webhook_secret, 500)) });
  return terminalSettings(env, actor, profile, origin);
}

/** As maquininhas da conta no provedor (só o administrador). */
export async function listTerminals(env: Env, actor: Actor, profile: string) {
  requireAdmin(actor, "escolhe as maquininhas");
  await requirePdv(env, profile);
  const row = await settingsRow(env, profile);
  if (!row) throw new ApiError(422, "erp_terminal_configuracao", "Salve antes a credencial do Mercado Pago na maquininha integrada.");
  const { adapter, ctx } = await contextOf(env, profile, row).catch(terminalProblem);
  const devices = await adapter.listDevices(ctx).catch(terminalProblem);
  return { provedor: row.provider, terminais: devices.map(item => ({ id: item.id, nome: item.name, pronto: item.ready, modo: item.mode, aviso: item.note })) };
}

/** A maquininha de um caixa (só o administrador); terminal vazio tira a maquininha do caixa. */
export async function saveCashier(env: Env, actor: Actor, profile: string, account: string, body: Record<string, unknown>, origin: string) {
  requireAdmin(actor, "escolhe a maquininha de cada caixa");
  await requirePdv(env, profile);
  const row = await settingsRow(env, profile);
  if (!row) throw new ApiError(422, "erp_terminal_configuracao", "Salve antes a credencial do Mercado Pago na maquininha integrada.");
  const context = await erp.context(env, actor, profile);
  if (!context.stores.some(store => store.id === account)) throw new ApiError(404, "not_found", "Este caixa não está entre as lojas da frente de caixa.");
  const device = body.terminal === null || body.terminal === "" ? null : text(body.terminal, 80);
  if (body.terminal !== undefined && body.terminal !== null && body.terminal !== "" && (!device || !/^[A-Za-z0-9_.:-]{1,80}$/.test(device)))
    throw new ApiError(400, "invalid_request", "terminal: escolha uma maquininha da lista.");
  if (!device) {
    await exec(env, "DELETE FROM erp_terminal_cashiers WHERE profile_id=? AND account_id=?", profile, account);
    await audit(env, profile, null, "cashier_cleared", actor.id, { account });
    return terminalSettings(env, actor, profile, origin);
  }
  const { adapter, ctx } = await contextOf(env, profile, row).catch(terminalProblem);
  const devices = await adapter.listDevices(ctx).catch(terminalProblem);
  const found = devices.find(item => item.id === device);
  if (!found) throw new ApiError(422, "erp_terminal_configuracao", "Esta maquininha não está ligada à conta do Mercado Pago. Confira se ela está vinculada à conta e tente de novo.");
  if (!found.ready) await adapter.prepareDevice(ctx, device).catch(terminalProblem);
  const name = text(body.nome, 60) ?? found.name;
  await exec(env, `INSERT INTO erp_terminal_cashiers(profile_id,account_id,provider,device_id,device_name,updated_by,updated) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(profile_id,account_id) DO UPDATE SET provider=excluded.provider,device_id=excluded.device_id,device_name=excluded.device_name,updated_by=excluded.updated_by,updated=excluded.updated`,
    profile, account, row.provider, device, name, actor.id, now());
  await audit(env, profile, null, "cashier_set", actor.id, { account, device, prepared: !found.ready });
  return terminalSettings(env, actor, profile, origin);
}

// ---------------------------------------------------------------------------
// Pagamentos

export function paymentView(row: TerminalPaymentRow) {
  const approved = row.status === "aprovado";
  return {
    id: row.id, venda: row.sale_id, venda_numero: row.sale_number, caixa: row.account_id, terminal: row.device_id,
    provedor: row.provider, provedor_nome: TERMINAL_PROVIDER_INFO[row.provider]?.name ?? row.provider, forma: row.payment_method_id,
    tipo: row.kind, tipo_rotulo: TERMINAL_KIND_LABELS[row.kind], parcelas: row.installments, valor_centavos: String(row.amount_cents),
    situacao: row.status, situacao_rotulo: TERMINAL_STATUS_LABELS[row.status], motivo: row.reason,
    em_andamento: TERMINAL_OPEN_STATUSES.includes(row.status),
    bandeira: row.brand, bandeira_rotulo: row.brand ? TERMINAL_BRAND_LABELS[row.brand] : null, autorizacao: row.authorization_code, nsu: row.nsu, final_cartao: row.card_last4,
    pago_em: row.paid_at,
    /** Texto da observação da parcela da venda (bandeira, parcelas, autorização e NSU). */
    observacao: approved ? terminalPaymentNote({ provider: row.provider, kind: row.kind, installments: row.installments, brand: row.brand, authorization: row.authorization_code, nsu: row.nsu, last4: row.card_last4 }) : null,
    venda_concluida: row.sale_finished_at !== null, conciliacao: row.reconcile_state, conciliacao_nota: row.reconcile_note,
    pode_cancelar: ["aguardando", "incerto", "enviando"].includes(row.status),
    pode_reenviar: row.status === "incerto" && !row.provider_ref,
    criado_em: row.created, atualizado_em: row.updated,
  };
}

const paymentRow = (env: Env, profile: string, id: string) =>
  one<TerminalPaymentRow>(env, "SELECT * FROM erp_terminal_payments WHERE profile_id=? AND id=?", profile, id.toLowerCase());

async function update(env: Env, row: TerminalPaymentRow, changes: Partial<TerminalPaymentRow>): Promise<TerminalPaymentRow> {
  const keys = Object.keys(changes) as (keyof TerminalPaymentRow)[];
  if (!keys.length) return row;
  const at = now();
  await exec(env, `UPDATE erp_terminal_payments SET ${keys.map(key => `${key}=?`).join(",")},updated=? WHERE id=?`, ...keys.map(key => changes[key] ?? null), at, row.id);
  return { ...row, ...changes, updated: at };
}

/** Aplica o que o provedor respondeu. A cobrança que não confere com a venda (valor, referência) nunca vale como pagamento. */
async function applyCharge(env: Env, row: TerminalPaymentRow, charge: TerminalCharge, checkedAt: number): Promise<TerminalPaymentRow> {
  if ((charge.reference && charge.reference !== row.reference) || (charge.amount_cents !== null && charge.amount_cents !== row.amount_cents)) {
    const next = await update(env, row, { status: "erro", reason: "A cobrança no Mercado Pago não confere com a venda (valor ou referência diferentes). Confira na maquininha e no painel do Mercado Pago antes de cobrar de novo.", checked_at: checkedAt, provider_ref: charge.ref });
    await audit(env, row.profile_id, row.id, "provider_mismatch", "system", { amount: charge.amount_cents });
    return next;
  }
  const status: TerminalStatus = charge.state;
  const changes: Partial<TerminalPaymentRow> = {
    status, reason: charge.reason, checked_at: checkedAt, provider_ref: charge.ref, provider_payment_id: charge.payment_id ?? row.provider_payment_id,
    brand: charge.brand ?? row.brand, authorization_code: charge.authorization ?? row.authorization_code, nsu: charge.nsu ?? row.nsu, card_last4: charge.last4 ?? row.card_last4,
    fee_cents: charge.fee_cents ?? row.fee_cents, paid_at: charge.paid_at ?? row.paid_at,
    installments: charge.kind === "credito" && charge.installments ? charge.installments : row.installments,
  };
  const next = await update(env, row, changes);
  if (status !== row.status) await audit(env, row.profile_id, row.id, `status_${status}`, "system", { from: row.status, brand: next.brand, installments: next.installments });
  return next;
}

/** Consulta o provedor quando a cobrança ainda está em andamento (ou incerta). Falha de consulta deixa como está. */
async function refresh(env: Env, row: TerminalPaymentRow, force = false): Promise<TerminalPaymentRow> {
  if (!TERMINAL_OPEN_STATUSES.includes(row.status)) return row;
  const at = now();
  if (row.status === "enviando" && at - row.created < SENDING_STALE_MS && !force) return row;
  if (!force && row.checked_at && at - row.checked_at < CHECK_EVERY_MS) return row;
  const settings = await settingsRow(env, row.profile_id);
  if (!settings) return row;
  try {
    const { adapter, ctx } = await contextOf(env, row.profile_id, settings);
    const charge = row.provider_ref ? await adapter.getCharge(ctx, row.provider_ref)
      : await adapter.findCharge(ctx, { reference: row.reference, device_id: row.device_id, since: row.created });
    if (!charge) return update(env, row, { status: "incerto", reason: NOT_FOUND, checked_at: at });
    return applyCharge(env, row, charge, at);
  } catch (error) {
    if (!(error instanceof TerminalError)) throw error;
    // Sem resposta agora: continua como estava; a próxima consulta tenta de novo.
    return update(env, row, { checked_at: at, ...(row.status === "enviando" ? { status: "incerto" as const } : {}),
      reason: row.status === "incerto" || row.status === "enviando" ? `${error.message} A cobrança continua sem confirmação: não envie outra antes de conferir.` : row.reason });
  }
}

const kindOf = (value: unknown): TerminalCardKind => {
  if (value === "debito" || value === "credito") return value;
  throw new ApiError(400, "invalid_request", "tipo: use debito ou credito.");
};

/**
 * Envia a cobrança das parcelas de cartão da venda (já salva e em aberto) à maquininha do caixa. Pedir de novo (o mesmo comando,
 * ou outra cobrança para a mesma venda) consulta e devolve a que existe; nunca há duas em andamento.
 */
export async function chargeTerminal(env: Env, actor: Actor, profile: string, body: Record<string, unknown>) {
  await requirePdv(env, profile);
  const settings = await settingsRow(env, profile);
  if (!settings || settings.enabled !== 1)
    throw new ApiError(409, "erp_terminal_off", "A maquininha integrada está desligada. O administrador liga em Preferências → Vendas → Frente de caixa → Maquininha integrada.");
  const saleId = typeof body.venda === "string" && UUID.test(body.venda) ? body.venda.toLowerCase() : null;
  const account = typeof body.caixa === "string" && UUID.test(body.caixa) ? body.caixa.toLowerCase() : null;
  if (!saleId) throw new ApiError(400, "invalid_request", "Salve a venda antes de cobrar na maquininha.");
  if (!account) throw new ApiError(400, "invalid_request", "Escolha a loja (caixa) da venda antes de cobrar na maquininha.");
  const kind = kindOf(body.tipo);
  const installments = body.parcelas === undefined || body.parcelas === null ? 1 : body.parcelas;
  if (!Number.isSafeInteger(installments) || (installments as number) < 1 || (installments as number) > (kind === "debito" ? 1 : settings.max_installments))
    throw new ApiError(400, "invalid_request", kind === "debito" ? "No débito a cobrança é à vista (1 parcela)." : `Parcelas: de 1 a ${settings.max_installments}.`);
  const command = body.comando === undefined || body.comando === null ? uid() : typeof body.comando === "string" && UUID.test(body.comando) ? body.comando.toLowerCase() : null;
  if (!command) throw new ApiError(400, "invalid_request", "comando: identificador inválido.");

  // O mesmo comando outra vez: a mesma cobrança, consultada.
  const repeated = await one<TerminalPaymentRow>(env, "SELECT * FROM erp_terminal_payments WHERE profile_id=? AND command_id=?", profile, command);
  if (repeated) {
    if (repeated.sale_id !== saleId) throw new ApiError(409, "erp_terminal_command_conflict", "Este comando já foi usado em outra venda. Recarregue o caixa.");
    return { pagamento: paymentView(await refresh(env, repeated)), nova: false };
  }
  // Outra cobrança desta venda em andamento, incerta ou aprovada e não usada: consulta antes, nunca envia por cima.
  for (const existing of await all<TerminalPaymentRow>(env, `SELECT * FROM erp_terminal_payments WHERE profile_id=? AND sale_id=?
      AND (status IN ('enviando','aguardando','processando','incerto') OR (status='aprovado' AND sale_finished_at IS NULL)) ORDER BY created DESC`, profile, saleId)) {
    const current = await refresh(env, existing, true);
    if (TERMINAL_OPEN_STATUSES.includes(current.status) || current.status === "aprovado") return { pagamento: paymentView(current), nova: false };
  }

  const cashier = await one<CashierRow>(env, "SELECT * FROM erp_terminal_cashiers WHERE profile_id=? AND account_id=?", profile, account);
  if (!cashier) throw new ApiError(422, "erp_terminal_no_device", "Este caixa ainda não tem maquininha. O administrador escolhe em Preferências → Vendas → Frente de caixa → Maquininha integrada.");
  const method = kind === "debito" ? settings.debit_method_id : settings.credit_method_id;
  if (!method) throw new ApiError(422, "erp_terminal_configuracao", `A forma de pagamento de ${kind === "debito" ? "débito" : "crédito"} da maquininha não foi escolhida. O administrador escolhe nas Preferências da frente de caixa.`);
  const context = await erp.context(env, actor, profile);
  if (!context.permissions.payments || !context.permissions.finish)
    throw new ApiError(403, "erp_pos_finish_denied", "Seu papel no ERP não registra o pagamento nem finaliza a venda: envie a pré-venda para o caixa.");
  const sale = await erp.sale(env, actor, profile, saleId);
  if (sale.id !== saleId) throw new ApiError(404, "not_found", "Venda não encontrada.");
  if (sale.state !== "open") throw new ApiError(409, "erp_terminal_sale_state", "A venda não está mais em aberto (já foi finalizada ou cancelada). Recarregue o caixa.");
  if (sale.account_id !== account) throw new ApiError(409, "erp_terminal_sale_store", "A venda foi salva em outra loja (caixa). Salve a venda nesta loja antes de cobrar na maquininha.");
  const amount = sale.payments.filter(item => item.payment_method_id === method).reduce((sum, item) => sum + BigInt(item.amount_cents), 0n);
  const methodName = context.methods.find(item => item.id === method)?.description ?? (kind === "debito" ? "débito" : "crédito");
  if (amount <= 0n) throw new ApiError(422, "erp_terminal_no_amount", `A venda salva não tem parcela na forma “${methodName}”. Escolha essa forma no pagamento e tente de novo.`);
  if (amount > 99_999_999n) throw new ApiError(422, "erp_terminal_amount", "Valor alto demais para uma cobrança na maquininha. Divida o pagamento.");

  const id = uid(), at = now(), reference = id.replace(/-/g, "");
  const inserted = await exec(env, `INSERT INTO erp_terminal_payments(id,profile_id,sale_id,sale_number,account_id,provider,device_id,payment_method_id,kind,installments,amount_cents,reference,
      status,command_id,actor,created,updated)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'enviando',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM erp_terminal_payments WHERE profile_id=? AND sale_id=? AND status IN ('enviando','aguardando','processando','incerto'))`,
    id, profile, saleId, sale.number, account, settings.provider, cashier.device_id, method, kind, installments, Number(amount), reference, command, actor.id, at, at, profile, saleId);
  if (!inserted.meta?.changes) {
    // Outro caixa enviou a cobrança desta venda ao mesmo tempo: devolve a dele.
    const other = await one<TerminalPaymentRow>(env, "SELECT * FROM erp_terminal_payments WHERE profile_id=? AND sale_id=? ORDER BY created DESC LIMIT 1", profile, saleId);
    if (other) return { pagamento: paymentView(other), nova: false };
    throw new ApiError(409, "erp_terminal_busy", "Outra cobrança desta venda acabou de ser enviada. Recarregue o caixa.");
  }
  const row = (await paymentRow(env, profile, id))!;
  await audit(env, profile, id, "charge_sent", actor.id, { sale: saleId, kind, installments, amount: Number(amount), device: cashier.device_id });
  return { pagamento: paymentView(await send(env, row, settings, kind, installments as number)), nova: true };
}

async function send(env: Env, row: TerminalPaymentRow, settings: SettingsRow, kind: TerminalCardKind, installments: number): Promise<TerminalPaymentRow> {
  try {
    const { adapter, ctx } = await contextOf(env, row.profile_id, settings);
    const created = await adapter.createCharge(ctx, { reference: row.reference, device_id: row.device_id, amount_cents: row.amount_cents, kind, installments,
      installments_cost: settings.installments_cost, description: `Venda ${row.sale_number ? `nº ${row.sale_number}` : "do caixa"}` });
    return update(env, row, { status: "aguardando", provider_ref: created.ref, reason: "A cobrança foi para a maquininha: o cliente passa o cartão.", checked_at: now() });
  } catch (error) {
    if (!(error instanceof TerminalError)) {
      // Erro inesperado depois de a cobrança sair: tratada como incerta (consulta antes de qualquer reenvio).
      await update(env, row, { status: "incerto", reason: "A resposta do Mercado Pago não chegou inteira. O Vinki confere antes de enviar outra." });
      throw error;
    }
    if (error.kind === "incerto") return update(env, row, { status: "incerto", reason: error.message, checked_at: now() });
    return update(env, row, { status: "erro", reason: error.message, checked_at: now() });
  }
}

/** Uma cobrança, consultada no provedor se ainda está em andamento. Leitura (o bot pode consultar). */
export async function terminalPayment(env: Env, actor: Actor, profile: string, id: string) {
  await requirePdv(env, profile);
  const row = await paymentRow(env, profile, id);
  if (!row) throw new ApiError(404, "not_found", "Pagamento da maquininha não encontrado.");
  return { pagamento: paymentView(await refresh(env, row)) };
}

/** Lista (de uma venda ou de um período), sem chamar o provedor. */
export async function terminalPayments(env: Env, actor: Actor, profile: string, query: URLSearchParams) {
  await requirePdv(env, profile);
  const sale = query.get("venda"), from = query.get("desde"), to = query.get("ate");
  if (sale !== null && !UUID.test(sale)) throw new ApiError(400, "invalid_request", "venda: identificador inválido.");
  for (const [key, value] of [["desde", from], ["ate", to]] as const) if (value !== null && !DAY.test(value)) throw new ApiError(400, "invalid_request", `${key}: use AAAA-MM-DD.`);
  const start = from ? Date.parse(`${from}T00:00:00-03:00`) : sale ? 0 : now() - 7 * 86_400_000;
  const end = to ? Date.parse(`${to}T23:59:59.999-03:00`) : now() + 60_000;
  const rows = await all<TerminalPaymentRow>(env, `SELECT * FROM erp_terminal_payments WHERE profile_id=? AND (? IS NULL OR sale_id=?) AND created BETWEEN ? AND ?
    ORDER BY created DESC LIMIT 200`, profile, sale?.toLowerCase() ?? null, sale?.toLowerCase() ?? null, start, end);
  return { pagamentos: rows.map(paymentView) };
}

/** Tira da maquininha a cobrança que ainda não foi paga. */
export async function cancelTerminalPayment(env: Env, actor: Actor, profile: string, id: string) {
  await requirePdv(env, profile);
  let row = await paymentRow(env, profile, id);
  if (!row) throw new ApiError(404, "not_found", "Pagamento da maquininha não encontrado.");
  row = await refresh(env, row, true);
  if (!["aguardando", "incerto", "enviando"].includes(row.status)) return { pagamento: paymentView(row) };
  if (!row.provider_ref) {
    // Conferido no provedor e não está lá: nada a cancelar na maquininha.
    row = await update(env, row, { status: "cancelado", reason: "Cancelada no caixa: o Mercado Pago não tinha a cobrança." });
    await audit(env, profile, row.id, "charge_cancelled", actor.id, { remote: false });
    return { pagamento: paymentView(row) };
  }
  const settings = (await settingsRow(env, profile))!;
  try {
    const { adapter, ctx } = await contextOf(env, profile, settings);
    await adapter.cancelCharge(ctx, { ref: row.provider_ref, device_id: row.device_id });
  } catch (error) {
    if (!(error instanceof TerminalError)) throw error;
    throw new ApiError(error.kind === "ocupado" ? 409 : 502, `erp_terminal_${error.kind}`, error.message);
  }
  await audit(env, profile, row.id, "charge_cancelled", actor.id, { remote: true });
  row = await refresh(env, { ...row, checked_at: null }, true);
  if (TERMINAL_OPEN_STATUSES.includes(row.status)) row = await update(env, row, { status: "cancelado", reason: "Cobrança cancelada no caixa." });
  return { pagamento: paymentView(row) };
}

/** Depois de resposta incerta: consulta de novo e só reenvia se a cobrança não está no provedor e a pessoa confirma. */
export async function resendTerminalPayment(env: Env, actor: Actor, profile: string, id: string, body: Record<string, unknown>) {
  await requirePdv(env, profile);
  if (body.confirmo !== true) throw new ApiError(422, "erp_terminal_confirm_required", "Confirme que a cobrança não apareceu na maquininha antes de enviar de novo.");
  let row = await paymentRow(env, profile, id);
  if (!row) throw new ApiError(404, "not_found", "Pagamento da maquininha não encontrado.");
  row = await refresh(env, row, true);
  if (row.status !== "incerto" || row.provider_ref) return { pagamento: paymentView(row), reenviado: false };
  const settings = await settingsRow(env, profile);
  if (!settings || settings.enabled !== 1) throw new ApiError(409, "erp_terminal_off", "A maquininha integrada foi desligada. Use outra forma de pagamento.");
  const sale = await erp.sale(env, actor, profile, row.sale_id);
  if (sale.state !== "open") throw new ApiError(409, "erp_terminal_sale_state", "A venda não está mais em aberto. Recarregue o caixa.");
  const amount = sale.payments.filter(item => item.payment_method_id === row!.payment_method_id).reduce((sum, item) => sum + BigInt(item.amount_cents), 0n);
  if (amount !== BigInt(row.amount_cents)) throw new ApiError(409, "erp_terminal_amount_changed", "As parcelas de cartão da venda mudaram. Cancele esta cobrança e cobre de novo.");
  row = await update(env, row, { status: "enviando", attempts: row.attempts + 1, reason: null });
  await audit(env, profile, row.id, "charge_resent", actor.id, { attempts: row.attempts });
  return { pagamento: paymentView(await send(env, row, settings, row.kind, row.installments)), reenviado: true };
}

/** A venda paga na maquininha foi finalizada: confere e põe o pagamento na conciliação de cartões já casado com a venda. */
export async function terminalSaleFinished(env: Env, actor: Actor, profile: string, id: string) {
  await requirePdv(env, profile);
  let row = await paymentRow(env, profile, id);
  if (!row) throw new ApiError(404, "not_found", "Pagamento da maquininha não encontrado.");
  if (row.status !== "aprovado") throw new ApiError(409, "erp_terminal_not_approved", "Este pagamento não foi aprovado na maquininha.");
  const sale = await erp.sale(env, actor, profile, row.sale_id);
  if (sale.state !== "finished") throw new ApiError(409, "erp_terminal_sale_state", "A venda ainda não foi finalizada. Finalize a venda no caixa.");
  if (row.sale_finished_at === null) {
    row = await update(env, row, { sale_finished_at: now() });
    await audit(env, profile, row.id, "sale_finished", actor.id, { sale: row.sale_id });
  }
  if (row.reconcile_state === "matched") return { pagamento: paymentView(row) };
  try {
    const result = await erp.reconcile(env, actor, profile, {
      sale_id: row.sale_id, payment_method_id: row.payment_method_id, acquirer: TERMINAL_PROVIDER_INFO[row.provider].acquirer, product: row.kind === "debito" ? "debit" : "credit",
      brand: row.brand ?? "outros", installments: row.installments, gross_cents: String(row.amount_cents), fee_cents: String(Math.min(row.fee_cents ?? 0, row.amount_cents)),
      nsu: row.nsu, authorization: row.authorization_code, reference: row.id, command_id: await commandFor(row.id),
    });
    row = await update(env, row, { reconcile_state: result.state, reconcile_note: result.note || null });
  } catch (error) {
    if (!(error instanceof TerminalReconcileSkip) && !(error instanceof ApiError)) throw error;
    row = await update(env, row, { reconcile_state: "skipped", reconcile_note: error.message.slice(0, 300) });
  }
  return { pagamento: paymentView(row) };
}

/** Comando estável da conciliação deste pagamento (repetir não duplica). */
async function commandFor(payment: string) {
  const hash = await sha(`wabotia-erp-maquininha-conciliacao-v1:${payment}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16]!, 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Aviso do provedor (webhook): só faz consultar

/** POST /webhooks/maquininha/:código. O código identifica a área; a assinatura é conferida; o resultado sai da consulta. */
export async function terminalWebhook(env: Env, token: string, input: { headers: Headers; query: URLSearchParams; body: unknown }) {
  if (!/^[0-9a-f]{48}$/.test(token)) throw new ApiError(404, "not_found", "Aviso desconhecido.");
  const settings = await one<SettingsRow>(env, "SELECT * FROM erp_terminal_settings WHERE webhook_hash=?", await sha(token));
  if (!settings) throw new ApiError(404, "not_found", "Aviso desconhecido.");
  const own = await secret(env, vaultId(settings.profile_id));
  if (own.webhook_token !== token) throw new ApiError(404, "not_found", "Aviso desconhecido.");
  let refs: string[];
  try {
    const { adapter, ctx } = await contextOf(env, settings.profile_id, settings);
    ({ refs } = await adapter.verifyWebhook(ctx, input));
  } catch (error) {
    if (error instanceof TerminalError) throw new ApiError(401, "invalid_signature", error.message);
    throw error;
  }
  let checked = 0;
  for (const ref of refs.slice(0, 5)) {
    for (const row of await all<TerminalPaymentRow>(env, "SELECT * FROM erp_terminal_payments WHERE profile_id=? AND provider_ref=? LIMIT 3", settings.profile_id, ref)) {
      await refresh(env, row, true);
      checked++;
    }
  }
  return { received: true, checked };
}
