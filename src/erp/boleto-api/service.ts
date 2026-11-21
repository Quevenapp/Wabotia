// Boleto registrado pela API do banco: a conta a receber do ERP vira boleto no
// banco da conta financeira (Banco Inter, Sicoob, Banco do Brasil ou Itaú),
// com a linha digitável, o código de barras e o Pix do boleto híbrido
// gravados no título (erp_boleto_api_titles, ligado à conta pelo id). A
// remessa e o retorno CNAB continuam como estão: a conta financeira escolhe
// API ou CNAB (erp_boleto_api_accounts; sem escolha, CNAB).
//
// Liquidação: o aviso do banco (webhook) ou a consulta periódica (alarme da
// área) só marcam o que falta fazer; o pagamento vale só depois de o Wabotia
// consultar o banco (o corpo do aviso nunca basta). Pago no banco:
//   - baixa automática ligada (a mesma opção do Pix e do link, desligada por
//     padrão): o alarme baixa em nome do administrador que ligou a opção, na
//     conta financeira do boleto, com o comprovante do banco na observação;
//   - desligada: vira sugestão de baixa, que a pessoa confirma com um clique;
//   - conta baixada ou mudada à mão depois do registro: pendência, sem baixa.
// O comando de baixa no ERP tem id derivado do boleto: o mesmo aviso duas
// vezes nunca baixa duas vezes.
//
// Segredos (Client Secret, certificado, chave, tokens) só no cofre do núcleo
// (secrets, cifrados com a MASTER_KEY); nunca em log, auditoria ou resposta.
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { actorForUser, secret, setSecret, sha } from "../../security";
import { moduleStates } from "../../modules/registry";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { erpCall } from "../conversa/documents.ts";
import { brDate, chargeSettings, commandId, settleConflict } from "../conversa/charges.ts";
import { day, money } from "../conversa/rules.ts";
import { BankError, onlyDigits, type BankContext, type BankEnvironment, type BankHttp, type BoletoRecord, type BoletoRequest } from "./adapter.ts";
import { BOLETO_ADAPTERS } from "./banks/index.ts";
import { bbOurNumber } from "./banks/bb.ts";
import { bankTransport } from "./transport.ts";
import {
  BOLETO_BANK_INFO, BOLETO_BANKS, BOLETO_SETTLE_LABELS, BOLETO_STATUS_LABELS, ERP_BOLETO_PART, bankByCode,
  type BoletoBank, type BoletoSettleState, type BoletoStatus,
} from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, max = 200) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const digitsOf = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
const parse = (value: unknown) => { try { return object(JSON.parse(String(value ?? "{}"))); } catch { return {}; } };
const MAX_ATTEMPTS = 12;
const HOUR = 3_600_000;

export interface BoletoRow {
  id: string; profile_id: string; title_id: string; title_version: number | null; account_id: string; bank: BoletoBank; environment: BankEnvironment;
  seu_numero: string; bank_ref: string | null; our_number: string | null; barcode: string | null; digitable_line: string | null;
  pix_code: string | null; pix_txid: string | null; amount_cents: number; due_on: string; issued_on: string; payer: string;
  status: BoletoStatus; settle_state: BoletoSettleState; settlement_id: string | null; paid_cents: number | null; paid_on: string | null;
  paid_via: string | null; receipt: string | null; note: string | null; attempts: number; next_poll_at: number | null; next_at: number | null;
  actor: string; confirmed_by: string | null; created: number; updated: number;
}
interface AccountRow {
  profile_id: string; account_id: string; mode: "cnab" | "api"; bank: BoletoBank | null; hybrid: number; settings: string; secret_fields: string;
  webhook_hash: string | null; next_number: number; checked_at: number | null; check_note: string | null; updated_by: string; updated: number;
}
interface BankRow { profile_id: string; bank: BoletoBank; enabled: number; environment: BankEnvironment; enabled_by: string | null; enabled_at: number | null }

// ---------------------------------------------------------------------------
// Transporte (os testes trocam pelo banco simulado)

let transportFor: (env: Env, bank: BoletoBank) => BankHttp = bankTransport;
/** Só para os testes: o banco simulado no lugar da rede. */
export function setBoletoTransport(factory: ((env: Env, bank: BoletoBank) => BankHttp) | null) { transportFor = factory ?? bankTransport; }

const vaultId = (profile: string, account: string) => `erp-boleto-api:${profile}:${account.toLowerCase()}`;

async function audit(env: Env, profile: string, boleto: string | null, action: string, actor: string, detail: Record<string, unknown> = {}) {
  await exec(env, "INSERT INTO erp_boleto_api_audit(id,profile_id,boleto_id,action,actor,detail,created) VALUES(?,?,?,?,?,?,?)",
    uid(), profile, boleto, action, actor, JSON.stringify(detail), now());
}

/** A Cobrança bancária (e o Financeiro) ligadas; desligada, 409 com o que ligar. */
export async function requireBilling(env: Env, profile: string) {
  const off = erpPartOffMessage(ERP_BOLETO_PART, erpRequirement(ERP_BOLETO_PART), await moduleStates(env, profile));
  if (off) throw new ApiError(409, "module_disabled", `${off} Sem ela, as contas a receber não viram boleto pelo banco.`);
}
async function billingOn(env: Env, profile: string) {
  return !erpPartOffMessage(ERP_BOLETO_PART, erpRequirement(ERP_BOLETO_PART), await moduleStates(env, profile));
}

const requireAdmin = (actor: Actor, what: string) => {
  if (actor.kind !== "user" || actor.role !== "admin" || actor.via) throw new ApiError(403, "admin_required", `Só o administrador da área ${what}.`);
};

/** Pode registrar, alterar e baixar boleto: o papel de remessas da cobrança no ERP. */
async function requireBoletoWriter(env: Env, actor: Actor, profile: string) {
  const access = object(await erpCall(env, profile, actor, "GET", "/v1/financeiro", undefined, "o seu acesso ao Financeiro"));
  const permitted = Array.isArray(access.permitted) ? access.permitted : [];
  if (access.write !== true || !permitted.includes("financas.remessas.ie"))
    throw new ApiError(403, "erp_finance_permission_denied", "Seu papel no ERP não permite registrar nem mudar boletos no banco (permissão de remessas da cobrança). Peça ao administrador em Pessoas e acessos.");
}

// ---------------------------------------------------------------------------
// Interruptor de cada banco (área)

async function bankRow(env: Env, profile: string, bank: BoletoBank): Promise<BankRow | null> {
  return one<BankRow>(env, "SELECT * FROM erp_boleto_api_banks WHERE profile_id=? AND bank=?", profile, bank);
}

export async function bankSwitches(env: Env, actor: Actor, profile: string) {
  const rows = await all<BankRow>(env, "SELECT * FROM erp_boleto_api_banks WHERE profile_id=?", profile);
  return {
    pode_mudar: actor.kind === "user" && actor.role === "admin" && !actor.via,
    bancos: BOLETO_BANKS.map(id => {
      const info = BOLETO_BANK_INFO[id], row = rows.find(item => item.bank === id);
      return { banco: id, nome: info.name, codigo: info.code, ligado: row?.enabled === 1, ambiente: row?.environment ?? "sandbox", ligado_em: row?.enabled_at ?? null,
        certificado: info.certificate, homologacao: info.sandbox, aviso_por_webhook: info.webhook, hibrido: info.hybrid,
        campos: info.fields.map(field => ({ chave: field.key, rotulo: field.label, segredo: field.secret, obrigatorio: field.required, dica: field.hint ?? null, varias_linhas: field.multiline === true })) };
    }),
  };
}

export const PRODUCTION_WARNING = "Em produção, o boleto registrado vale de verdade: o cliente pode pagar e o banco cobra as tarifas do contrato de cobrança. Confira antes, na homologação, um registro, uma consulta, a alteração de vencimento e a baixa.";

/** Só o administrador. Ligar em produção pede a confirmação do aviso. */
export async function saveBankSwitch(env: Env, actor: Actor, profile: string, bank: string, body: Record<string, unknown>) {
  requireAdmin(actor, "liga ou desliga os bancos de boleto");
  if (!BOLETO_BANKS.includes(bank as BoletoBank)) throw new ApiError(404, "not_found", "Banco desconhecido: use inter, sicoob, bb ou itau.");
  const current = await bankRow(env, profile, bank as BoletoBank);
  const enabled = body.ligado === undefined ? current?.enabled === 1 : body.ligado;
  if (typeof enabled !== "boolean") throw new ApiError(400, "invalid_request", "ligado: use verdadeiro ou falso.");
  const environment = body.ambiente === undefined ? current?.environment ?? "sandbox" : body.ambiente;
  if (environment !== "sandbox" && environment !== "producao") throw new ApiError(400, "invalid_request", "ambiente: use sandbox (homologação) ou producao.");
  if (enabled && environment === "producao" && (current?.enabled !== 1 || current.environment !== "producao") && body.confirmo !== true)
    throw new ApiError(422, "erp_boleto_confirm_required", `Confirme o aviso: ${PRODUCTION_WARNING}`);
  const at = now(), turningOn = enabled && current?.enabled !== 1;
  await exec(env, `INSERT INTO erp_boleto_api_banks(profile_id,bank,enabled,environment,enabled_by,enabled_at,updated_by,updated) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(profile_id,bank) DO UPDATE SET enabled=excluded.enabled,environment=excluded.environment,enabled_by=excluded.enabled_by,
      enabled_at=excluded.enabled_at,updated_by=excluded.updated_by,updated=excluded.updated`,
    profile, bank, enabled ? 1 : 0, environment, enabled ? (turningOn ? actor.id : current?.enabled_by ?? actor.id) : null,
    enabled ? (turningOn ? at : current?.enabled_at ?? at) : null, actor.id, at);
  await audit(env, profile, null, turningOn ? "bank_on" : enabled !== (current?.enabled === 1) ? "bank_off" : "bank_changed", actor.id,
    { bank, environment, before: { enabled: current?.enabled === 1, environment: current?.environment ?? null } });
  return bankSwitches(env, actor, profile);
}

// ---------------------------------------------------------------------------
// Conta financeira: API ou CNAB, credenciais no cofre

async function accountRow(env: Env, profile: string, account: string) {
  return one<AccountRow>(env, "SELECT * FROM erp_boleto_api_accounts WHERE profile_id=? AND account_id=?", profile, account.toLowerCase());
}

/** A conta financeira no ERP (lida como a pessoa). */
async function erpAccount(env: Env, actor: Actor, profile: string, account: string) {
  const body = await erpCall(env, profile, actor, "GET", "/v1/financeiro/accounts", undefined, "as contas financeiras");
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const found = items.map(object).find((item: Record<string, any>) => String(item.id ?? "").toLowerCase() === account.toLowerCase());
  if (!found) throw new ApiError(404, "not_found", "Não achamos esta conta financeira no ERP.");
  return found as Record<string, any>;
}

function missingFields(bank: BoletoBank, settings: Record<string, string>, secrets: readonly string[], environment: BankEnvironment): string[] {
  const info = BOLETO_BANK_INFO[bank];
  return info.fields.filter(field => {
    const needed = field.required || (field.key === "token_sandbox" && environment === "sandbox") ||
      ((field.key === "certificado" || field.key === "chave_privada") && (info.certificate === "obrigatorio" || (info.certificate === "producao" && environment === "producao")));
    if (bank === "sicoob" && environment === "sandbox" && (field.key === "certificado" || field.key === "chave_privada")) return false;
    return needed && !(field.secret ? secrets.includes(field.key) : settings[field.key]);
  }).map(field => field.label.replace(/ \(.*$/, "").toLowerCase());
}

/** O endereço do aviso de pagamento (webhook) desta conta: só para o administrador. */
const webhookUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/webhooks/boleto/${token}`;

export async function accountConfig(env: Env, actor: Actor, profile: string, account: string, origin: string) {
  await requireBilling(env, profile);
  const erp = await erpAccount(env, actor, profile, account);
  const row = await accountRow(env, profile, account);
  const suggested = bankByCode(erp.institution_code);
  const bank = row?.bank ?? suggested;
  const settings = parse(row?.settings) as Record<string, string>, secrets = JSON.parse(row?.secret_fields ?? "[]") as string[];
  const switchRow = bank ? await bankRow(env, profile, bank) : null;
  const environment = switchRow?.environment ?? "sandbox";
  const admin = actor.kind === "user" && actor.role === "admin" && !actor.via;
  let webhook: string | null = null;
  if (admin && bank && BOLETO_BANK_INFO[bank].webhook && row?.webhook_hash) {
    const stored = await secret(env, vaultId(profile, account));
    if (typeof stored.webhook_token === "string") webhook = webhookUrl(origin, stored.webhook_token);
  }
  return {
    conta: { id: String(erp.id).toLowerCase(), nome: String(erp.name ?? erp.description ?? ""), instituicao: erp.institution_code ?? null, agencia: erp.agency ?? null, numero: erp.account_number ?? null },
    modo: row?.mode ?? "cnab", banco: bank, banco_sugerido: suggested, hibrido: row ? row.hybrid === 1 : true,
    campos: Object.fromEntries(Object.entries(settings).filter(([key]) => bank && BOLETO_BANK_INFO[bank].fields.some(field => field.key === key && !field.secret))),
    segredos_guardados: secrets,
    falta: bank ? missingFields(bank, settings, secrets, environment) : [],
    banco_ligado: switchRow?.enabled === 1, ambiente: environment,
    aviso_url: webhook, conferido_em: row?.checked_at ?? null, conferencia: row?.check_note ?? null,
    pode_mudar: admin,
  };
}

const PEM_CERT = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;
const PEM_KEY = /^-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----\s*$/;

/** Só o administrador. Os segredos vão para o cofre; vazio mantém o guardado. */
export async function saveAccountConfig(env: Env, actor: Actor, profile: string, account: string, body: Record<string, unknown>, origin: string) {
  requireAdmin(actor, "configura o boleto pela API na conta financeira");
  await requireBilling(env, profile);
  const id = account.toLowerCase();
  const erp = await erpAccount(env, actor, profile, id);
  const row = await accountRow(env, profile, id);
  const mode = body.modo === undefined ? row?.mode ?? "cnab" : body.modo;
  if (mode !== "cnab" && mode !== "api") throw new ApiError(400, "invalid_request", "modo: use api (pelo banco) ou cnab (remessa e retorno).");
  const bankInput = body.banco === undefined ? row?.bank ?? bankByCode(erp.institution_code) : body.banco;
  if (bankInput !== null && !BOLETO_BANKS.includes(bankInput as BoletoBank)) throw new ApiError(400, "invalid_request", "banco: use inter, sicoob, bb ou itau.");
  const bank = bankInput as BoletoBank | null;
  const institution = bankByCode(erp.institution_code);
  if (mode === "api" && !bank) throw new ApiError(422, "erp_boleto_bank_required", "Escolha o banco que registra os boletos desta conta.");
  if (mode === "api" && institution && bank && institution !== bank)
    throw new ApiError(422, "erp_boleto_bank_mismatch", `Esta conta financeira é do ${BOLETO_BANK_INFO[institution].name}; o boleto pela API sai pelo banco da própria conta.`);
  if (body.hibrido !== undefined && typeof body.hibrido !== "boolean") throw new ApiError(400, "invalid_request", "hibrido: use verdadeiro ou falso.");
  const fields = object(body.campos);
  const info = bank ? BOLETO_BANK_INFO[bank] : null;
  const unknown = Object.keys(fields).filter(key => !info?.fields.some(field => field.key === key));
  if (unknown.length) throw new ApiError(400, "invalid_request", `Campos desconhecidos para este banco: ${unknown.join(", ")}.`);
  const sameBank = row?.bank === bank;
  const settings: Record<string, string> = sameBank ? parse(row?.settings) as Record<string, string> : {};
  const stored = sameBank ? await secret(env, vaultId(profile, id)) : {};
  const vault: Record<string, unknown> = { ...stored };
  for (const field of info?.fields ?? []) {
    const value = fields[field.key];
    if (value === undefined || value === "") continue;
    if (value !== null && typeof value !== "string") throw new ApiError(400, "invalid_request", `${field.label}: digite um texto.`);
    const clean = value === null ? null : field.multiline ? value.replace(/\r\n/g, "\n").trim() : value.trim();
    if (clean !== null && clean.length > 20_000) throw new ApiError(400, "invalid_request", `${field.label}: texto longo demais.`);
    if (clean !== null && field.pattern && !new RegExp(field.pattern).test(clean)) throw new ApiError(400, "invalid_request", `${field.label}: confira o valor digitado.`);
    if (clean !== null && field.key === "certificado" && !PEM_CERT.test(clean))
      throw new ApiError(400, "invalid_request", "O certificado precisa estar em texto (PEM), de -----BEGIN CERTIFICATE----- até -----END CERTIFICATE-----. Se o banco entregou um arquivo .pfx, converta antes, como explicado em docs/BOLETO-API.md.");
    if (clean !== null && field.key === "chave_privada" && !PEM_KEY.test(clean))
      throw new ApiError(400, "invalid_request", "A chave privada precisa estar em texto (PEM), de -----BEGIN PRIVATE KEY----- até -----END PRIVATE KEY-----.");
    if (field.secret) { if (clean === null) delete vault[field.key]; else vault[field.key] = clean; }
    else if (clean === null) delete settings[field.key]; else settings[field.key] = clean;
  }
  const secrets = (info?.fields ?? []).filter(field => field.secret && typeof vault[field.key] === "string").map(field => field.key);
  const switchRow = bank ? await bankRow(env, profile, bank) : null;
  const environment = switchRow?.environment ?? "sandbox";
  if (mode === "api" && bank) {
    const missing = missingFields(bank, settings, secrets, environment);
    if (missing.length) throw new ApiError(422, "erp_boleto_fields_required", `Para emitir boleto pela API do ${BOLETO_BANK_INFO[bank].name}, falta: ${missing.join(", ")}.`);
  }
  // Código do endereço do aviso de pagamento: um por conta, no cofre; aqui só o hash.
  if (typeof vault.webhook_token !== "string") vault.webhook_token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
  await setSecret(env, vaultId(profile, id), vault);
  const at = now();
  await exec(env, `INSERT INTO erp_boleto_api_accounts(profile_id,account_id,mode,bank,hybrid,settings,secret_fields,webhook_hash,updated_by,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,account_id) DO UPDATE SET mode=excluded.mode,bank=excluded.bank,hybrid=excluded.hybrid,
      settings=excluded.settings,secret_fields=excluded.secret_fields,webhook_hash=excluded.webhook_hash,updated_by=excluded.updated_by,updated=excluded.updated,
      checked_at=CASE WHEN erp_boleto_api_accounts.bank IS excluded.bank THEN erp_boleto_api_accounts.checked_at ELSE NULL END,
      check_note=CASE WHEN erp_boleto_api_accounts.bank IS excluded.bank THEN erp_boleto_api_accounts.check_note ELSE NULL END`,
    profile, id, mode, bank, (body.hibrido ?? (row ? row.hybrid === 1 : true)) ? 1 : 0, JSON.stringify(settings), JSON.stringify(secrets),
    await sha(String(vault.webhook_token)), actor.id, at);
  // Só os nomes dos campos mudados, nunca os valores.
  await audit(env, profile, null, row?.mode !== mode ? `account_mode_${mode}` : "account_changed", actor.id,
    { account_id: id, bank, mode, fields: Object.keys(fields).filter(key => fields[key] !== undefined && fields[key] !== "") });
  if (body.testar === true && mode === "api" && bank) await checkAccount(env, actor, profile, id, origin);
  return accountConfig(env, actor, profile, id, origin);
}

/** Confere as credenciais no banco (com o banco ligado) e, se o banco aceita, cadastra o aviso de pagamento. */
async function checkAccount(env: Env, actor: Actor, profile: string, account: string, origin: string) {
  let note: string;
  try {
    const { ctx, adapter } = await bankContext(env, profile, account);
    await adapter.check(ctx);
    note = "Credenciais conferidas: o banco aceitou a entrada na API.";
    if (adapter.registerWebhook) {
      const stored = await secret(env, vaultId(profile, account));
      try { await adapter.registerWebhook(ctx, webhookUrl(origin, String(stored.webhook_token))); note += " O aviso de pagamento foi cadastrado no banco."; }
      catch (error) { note += ` O aviso de pagamento não foi cadastrado (${error instanceof BankError ? error.message : "sem resposta"}); os pagamentos chegam pela consulta periódica.`; }
    }
  } catch (error) {
    note = error instanceof BankError || error instanceof ApiError ? error.message : "O banco não respondeu à conferência.";
  }
  await exec(env, "UPDATE erp_boleto_api_accounts SET checked_at=?,check_note=? WHERE profile_id=? AND account_id=?", now(), note.slice(0, 500), profile, account);
  await audit(env, profile, null, "account_checked", actor.id, { account_id: account, note: note.slice(0, 300) });
}

/** O contexto do banco de uma conta financeira em modo API, com o banco ligado. */
async function bankContext(env: Env, profile: string, account: string, tokens = new Map<string, string>()) {
  const row = await accountRow(env, profile, account);
  if (!row || row.mode !== "api" || !row.bank)
    throw new ApiError(409, "erp_boleto_account_cnab", "Esta conta financeira emite boleto pela remessa CNAB. Para registrar pela API, escolha \"Pela API do banco\" na conta financeira (Emissão de Boleto).");
  const switchRow = await bankRow(env, profile, row.bank);
  if (switchRow?.enabled !== 1)
    throw new ApiError(409, "erp_boleto_bank_off", `O boleto pela API do ${BOLETO_BANK_INFO[row.bank].name} está desligado nesta área. O administrador liga em Preferências → Finanças → Contas a receber → Boleto pela API do banco.`);
  const vault = await secret(env, vaultId(profile, account));
  const fields: Record<string, string> = { ...parse(row.settings) as Record<string, string> };
  for (const [key, value] of Object.entries(vault)) if (typeof value === "string" && key !== "webhook_token") fields[key] = value;
  const ctx: BankContext = { bank: row.bank, http: transportFor(env, row.bank), environment: switchRow.environment, fields, hybrid: row.hybrid === 1, tokens };
  return { ctx, adapter: BOLETO_ADAPTERS[row.bank], row, environment: switchRow.environment };
}

/** As contas financeiras que registram boleto pela API, prontas ou não. */
async function apiAccounts(env: Env, profile: string) {
  const rows = await all<AccountRow>(env, "SELECT * FROM erp_boleto_api_accounts WHERE profile_id=? AND mode='api' AND bank IS NOT NULL ORDER BY updated DESC", profile);
  const switches = await all<BankRow>(env, "SELECT * FROM erp_boleto_api_banks WHERE profile_id=?", profile);
  return rows.map(row => {
    const sw = switches.find(item => item.bank === row.bank);
    const missing = missingFields(row.bank!, parse(row.settings) as Record<string, string>, JSON.parse(row.secret_fields) as string[], sw?.environment ?? "sandbox");
    const off = sw?.enabled !== 1;
    return { id: row.account_id, banco: row.bank!, banco_nome: BOLETO_BANK_INFO[row.bank!].name, ambiente: sw?.environment ?? "sandbox",
      pronta: !off && !missing.length,
      falta: off ? `O ${BOLETO_BANK_INFO[row.bank!].name} está desligado (Preferências → Finanças → Contas a receber → Boleto pela API do banco).` : missing.length ? `Falta na conta financeira: ${missing.join(", ")}.` : null };
  });
}

// ---------------------------------------------------------------------------
// O boleto da conta a receber

const formatLine = (line: string) =>
  `${line.slice(0, 5)}.${line.slice(5, 10)} ${line.slice(10, 15)}.${line.slice(15, 21)} ${line.slice(21, 26)}.${line.slice(26, 32)} ${line[32]} ${line.slice(33)}`;

export function boletoView(row: BoletoRow) {
  return {
    id: row.id, conta: row.title_id, conta_financeira: row.account_id, banco: row.bank, banco_nome: BOLETO_BANK_INFO[row.bank].name,
    homologacao: row.environment === "sandbox", situacao: row.status, situacao_rotulo: BOLETO_STATUS_LABELS[row.status],
    baixa: row.settle_state, baixa_rotulo: BOLETO_SETTLE_LABELS[row.settle_state], motivo: row.note,
    nosso_numero: row.our_number, linha_digitavel: row.digitable_line ? formatLine(row.digitable_line) : null, codigo_barras: row.barcode,
    pix_copia_e_cola: row.status === "registrado" ? row.pix_code : null,
    valor_centavos: String(row.amount_cents), valor: money(row.amount_cents), vencimento: row.due_on,
    pago_em: row.paid_on, valor_pago: row.paid_cents === null ? null : money(row.paid_cents), pago_por: row.paid_via, comprovante: row.receipt,
    criado_em: row.created,
    pode_confirmar_baixa: row.settle_state === "sugestao",
    pode_mudar: row.status === "registrado",
    pdf: row.status === "registrado" && !!row.barcode,
  };
}

async function readTitle(env: Env, profile: string, actor: Actor, id: string) {
  const body = await erpCall(env, profile, actor, "GET", `/v1/financeiro/titles/${id}/detalhe`, undefined, "esta conta a receber");
  const title = object(body?.record);
  if (title.kind !== "receivable") throw new ApiError(404, "not_found", "Não achamos esta conta a receber no ERP.");
  return title;
}
const isOpen = (title: Record<string, any>) => title.cancelled !== true && ["open", "partial"].includes(title.status);

/** O boleto vivo (registrando, incerto ou registrado) ou o mais recente da conta. */
async function currentBoleto(env: Env, profile: string, titleId: string) {
  return one<BoletoRow>(env, `SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND title_id=?
    ORDER BY CASE WHEN status IN ('registrando','incerto','registrado') THEN 0 WHEN status='pago' THEN 1 ELSE 2 END, created DESC LIMIT 1`, profile, titleId.toLowerCase());
}

/** O que a tela mostra: o boleto da conta, as contas financeiras pela API e o que falta. */
export async function boletoContext(env: Env, actor: Actor, profile: string, titleId: string) {
  await requireBilling(env, profile);
  const id = titleId.toLowerCase();
  const title = await readTitle(env, profile, actor, id);
  const rows = await all<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND title_id=? ORDER BY created DESC LIMIT 10", profile, id);
  const current = await currentBoleto(env, profile, id);
  const accounts = await apiAccounts(env, profile);
  return {
    conta: { id, aberta: isOpen(title), saldo_centavos: digitsOf(title.balance_cents), vencimento: text(title.due_on, 10) },
    contas_financeiras: accounts,
    falta: accounts.length ? null : "Nenhuma conta financeira emite boleto pela API do banco. Escolha \"Pela API do banco\" em Finanças → Caixas e bancos → a conta → Emissão de Boleto.",
    boleto: current ? boletoView(current) : null,
    historico: rows.filter(row => row.id !== current?.id).map(boletoView),
  };
}

/** Endereço numa linha e campos do pagador, do cadastro do cliente. */
function payerOf(contact: Record<string, any>, title: Record<string, any>) {
  const name = text(contact.name, 100) ?? text(title.contact_name, 100);
  const document = onlyDigits(contact.document ?? contact.cpf_cnpj);
  const zip = onlyDigits(contact.postal_code ?? contact.zip ?? contact.cep);
  const state = text(contact.state, 2)?.toUpperCase() ?? null;
  const payer = {
    name: name ?? "", document: document ?? "", street: text(contact.address ?? contact.street, 100), number: text(contact.number ?? contact.address_number, 10),
    district: text(contact.neighborhood ?? contact.district, 60), city: text(contact.city, 60), state: state && /^[A-Z]{2}$/.test(state) ? state : null,
    zip: zip && zip.length === 8 ? zip : null,
  };
  const missing: string[] = [];
  if (!payer.name) missing.push("o nome do cliente");
  if (payer.document.length !== 11 && payer.document.length !== 14) missing.push("o CPF ou CNPJ do cliente no cadastro");
  if (!payer.street || !payer.city || !payer.state || !payer.zip) missing.push("o endereço do cliente (rua, cidade, UF e CEP) no cadastro");
  return { payer, missing };
}

/** Nosso número escolhido pelo Wabotia (Banco do Brasil e Itaú): a próxima da sequência da conta. */
async function nextOurNumber(env: Env, profile: string, account: string, bank: BoletoBank, settings: Record<string, string>): Promise<string | null> {
  if (bank !== "bb" && bank !== "itau") return null;
  const row = await one<{ next_number: number }>(env, "UPDATE erp_boleto_api_accounts SET next_number=next_number+1 WHERE profile_id=? AND account_id=? RETURNING next_number", profile, account);
  const sequence = Number(row?.next_number ?? 1);
  return bank === "bb" ? bbOurNumber(settings.convenio ?? "", sequence) : String(sequence % 100_000_000).padStart(8, "0");
}

function bankApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof BankError) {
    const status = error.kind === "indisponivel" || error.kind === "incerto" ? 503 : error.kind === "credencial" ? 424 : 422;
    return new ApiError(status, `erp_boleto_bank_${error.kind}`, error.message);
  }
  return new ApiError(503, "erp_boleto_bank_indisponivel", "O banco não respondeu. Tente de novo em alguns minutos.");
}

/**
 * Registra a conta a receber em aberto como boleto pela API do banco da conta
 * financeira. A mesma conta com boleto registrado devolve o mesmo boleto.
 */
export async function registerBoleto(env: Env, actor: Actor, profile: string, titleId: string, body: Record<string, unknown>) {
  await requireBilling(env, profile);
  const id = titleId.toLowerCase();
  const title = await readTitle(env, profile, actor, id);
  await requireBoletoWriter(env, actor, profile);
  let row = await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND title_id=? AND status IN ('registrando','incerto','registrado')", profile, id);
  if (row?.status === "registrado") return { boleto: boletoView(row), novo: false };
  if (row?.status === "registrando" && now() - row.updated < 2 * 60_000)
    throw new ApiError(409, "erp_boleto_in_progress", "O registro deste boleto já está em andamento. Espere um minuto e confira de novo.");
  if (!isOpen(title)) throw new ApiError(409, "erp_title_not_open", "Só conta a receber em aberto vira boleto. Esta já foi paga ou cancelada.");
  const balance = digitsOf(title.balance_cents);
  if (!balance || balance === "0") throw new ApiError(409, "erp_title_not_open", "Esta conta não tem saldo em aberto para cobrar.");
  const dueOn = text(title.due_on, 10), today = brDate(now());
  if (!dueOn || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) throw new ApiError(422, "erp_boleto_incomplete", "A conta não tem vencimento. Informe o vencimento da conta antes de registrar o boleto.");
  if (!row && dueOn < today) throw new ApiError(422, "erp_boleto_due_past", "O vencimento desta conta já passou. Mude o vencimento da conta no Financeiro antes de registrar o boleto.");
  const account = row?.account_id ?? (typeof body.conta_financeira === "string" && UUID.test(body.conta_financeira) ? body.conta_financeira.toLowerCase() : null)
    ?? (await apiAccounts(env, profile)).find(item => item.pronta)?.id ?? null;
  if (!account) throw new ApiError(422, "erp_boleto_account_required", "Nenhuma conta financeira está pronta para emitir boleto pela API do banco. Configure em Finanças → Caixas e bancos → a conta → Emissão de Boleto.");
  const { ctx, adapter, row: accountConfigRow, environment } = await bankContext(env, profile, account);
  let contact: Record<string, any> = {};
  if (typeof title.contact_id === "string" && UUID.test(title.contact_id)) {
    try { const read = await erpCall(env, profile, actor, "GET", `/v1/cadastros/contacts/${title.contact_id}`, undefined, "o cadastro do cliente"); contact = object(read?.record ?? read?.data ?? read); }
    catch (error) { if (error instanceof ApiError && error.code === "erp_customer_restricted") throw error; }
  }
  const { payer, missing } = payerOf(contact, title);
  if (missing.length) throw new ApiError(422, "erp_boleto_incomplete", `O boleto não foi registrado: falta ${missing.join(", ")}. Complete o cadastro do cliente e tente de novo.`);
  const at = now();
  if (!row) {
    const boletoId = uid();
    const settings = parse(accountConfigRow.settings) as Record<string, string>;
    const seu = (await sha(`erp-boleto:${profile}:${boletoId}`)).replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
    const ourNumber = await nextOurNumber(env, profile, account, accountConfigRow.bank!, settings);
    try {
      await exec(env, `INSERT INTO erp_boleto_api_titles(id,profile_id,title_id,title_version,account_id,bank,environment,seu_numero,our_number,amount_cents,
          due_on,issued_on,payer,status,settle_state,actor,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'registrando','aguardando',?,?,?)`,
        boletoId, profile, id, Number.isSafeInteger(title.version) ? Number(title.version) : null, account, accountConfigRow.bank, environment, seu, ourNumber,
        Number(balance), dueOn, today, JSON.stringify(payer), actor.id, at, at);
    } catch {
      // Outro clique registrou ao mesmo tempo (um boleto vivo por conta).
      const live = await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND title_id=? AND status IN ('registrando','incerto','registrado')", profile, id);
      if (live) return { boleto: boletoView(live), novo: false };
      throw new ApiError(409, "erp_boleto_in_progress", "O registro deste boleto já está em andamento. Confira de novo em instantes.");
    }
    row = (await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", boletoId))!;
  } else {
    // Nova tentativa depois de "sem resposta": o mesmo seu número e nosso número (o banco recusa duplicado).
    await exec(env, "UPDATE erp_boleto_api_titles SET status='registrando',updated=? WHERE id=?", at, row.id);
  }
  const request: BoletoRequest = {
    seu_numero: row.seu_numero, our_number: row.our_number, amount_cents: String(row.amount_cents), due_on: row.due_on, issued_on: row.issued_on,
    payer: parse(row.payer) as BoletoRequest["payer"],
    instructions: ["Não receber após 60 dias do vencimento.", "Em caso de dúvida, fale com o beneficiário."],
  };
  let record: BoletoRecord;
  try { record = await adapter.register(ctx, request); }
  catch (error) {
    const uncertain = error instanceof BankError && error.kind === "incerto";
    const message = error instanceof BankError || error instanceof ApiError ? error.message : "O banco não respondeu.";
    await exec(env, "UPDATE erp_boleto_api_titles SET status=?,note=?,updated=? WHERE id=?", uncertain ? "incerto" : "falhou", message.slice(0, 500), now(), row.id);
    await audit(env, profile, row.id, uncertain ? "register_uncertain" : "register_failed", actor.id, { title_id: id, bank: row.bank, note: message.slice(0, 300) });
    throw bankApiError(error);
  }
  await exec(env, `UPDATE erp_boleto_api_titles SET status='registrado',bank_ref=?,our_number=?,barcode=?,digitable_line=?,pix_code=?,pix_txid=?,note=NULL,
      next_poll_at=?,updated=? WHERE id=?`,
    record.bank_ref || row.our_number, record.our_number ?? row.our_number, record.barcode, record.digitable_line, record.pix_code, record.pix_txid,
    now() + 6 * HOUR, now(), row.id);
  await audit(env, profile, row.id, "registered", actor.id, { title_id: id, bank: row.bank, environment: row.environment, amount_cents: row.amount_cents, due_on: row.due_on });
  let fresh = (await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", row.id))!;
  if (record.status !== "registrado") fresh = await applyRecord(env, profile, fresh, record, actor.id);
  return { boleto: boletoView(fresh), novo: true };
}

/** O que o banco disse (consulta confirmada) aplicado ao boleto. Idempotente. */
export async function applyRecord(env: Env, profile: string, row: BoletoRow, record: BoletoRecord, who: string): Promise<BoletoRow> {
  const at = now();
  // Dados do boleto que o banco completou (o Inter só devolve a linha na consulta).
  await exec(env, `UPDATE erp_boleto_api_titles SET barcode=coalesce(?,barcode),digitable_line=coalesce(?,digitable_line),pix_code=coalesce(?,pix_code),
      pix_txid=coalesce(?,pix_txid),our_number=coalesce(?,our_number),bank_ref=coalesce(bank_ref,?),due_on=coalesce(?,due_on),updated=? WHERE id=?`,
    record.barcode, record.digitable_line, record.pix_code, record.pix_txid, record.our_number, record.bank_ref || null,
    record.status === "registrado" ? record.due_on : null, at, row.id);
  if (record.status === "pago") {
    const settings = await chargeSettings(env, profile);
    const next: BoletoSettleState = settings.auto_settle && settings.enabled_by ? "baixar" : "sugestao";
    const paid = record.paid_cents && /^\d+$/.test(record.paid_cents) ? Number(record.paid_cents) : row.amount_cents;
    const changed = await exec(env, `UPDATE erp_boleto_api_titles SET status='pago',paid_cents=?,paid_on=?,paid_via=?,receipt=?,
        settle_state=CASE WHEN settle_state IN ('aguardando','encerrada') THEN ? ELSE settle_state END,next_at=?,attempts=0,next_poll_at=NULL,
        note=CASE WHEN ? IS NULL THEN 'O banco não informou o valor pago; vale o valor do boleto.' ELSE NULL END,updated=?
      WHERE id=? AND status<>'pago'`,
      paid, record.paid_on ?? brDate(at), record.paid_via, record.receipt?.slice(0, 200) ?? null, next, at, record.paid_cents, at, row.id);
    if (changed.meta?.changes) await audit(env, profile, row.id, `paid_${next}`, who, { title_id: row.title_id, paid_cents: paid, paid_on: record.paid_on });
  } else if (record.status === "baixado") {
    const changed = await exec(env, `UPDATE erp_boleto_api_titles SET status='baixado',next_poll_at=NULL,
        settle_state=CASE WHEN settle_state='aguardando' THEN 'encerrada' ELSE settle_state END,
        note=coalesce(note,'O boleto foi baixado no banco sem pagamento.'),updated=? WHERE id=? AND status IN ('registrado','incerto','registrando')`, at, row.id);
    if (changed.meta?.changes) await audit(env, profile, row.id, "closed_by_bank", who, { title_id: row.title_id });
  } else if (row.status === "incerto" || row.status === "registrando") {
    await exec(env, "UPDATE erp_boleto_api_titles SET status='registrado',note=NULL,updated=? WHERE id=? AND status IN ('incerto','registrando')", at, row.id);
  }
  return (await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", row.id))!;
}

async function liveRow(env: Env, profile: string, titleId: string, what: string) {
  const row = await currentBoleto(env, profile, titleId);
  if (!row) throw new ApiError(404, "erp_boleto_not_found", "Esta conta a receber não tem boleto registrado pela API do banco.");
  if (what !== "consultar" && row.status !== "registrado")
    throw new ApiError(409, "erp_boleto_not_registered", `Só boleto registrado (em aberto no banco) pode ${what}. Este está: ${BOLETO_STATUS_LABELS[row.status].toLowerCase()}.`);
  return row;
}

/** Pergunta ao banco a situação do boleto (pago vira sugestão de baixa ou a baixa automática). */
export async function consultBoleto(env: Env, actor: Actor, profile: string, titleId: string) {
  await requireBilling(env, profile);
  await readTitle(env, profile, actor, titleId.toLowerCase());
  const row = await liveRow(env, profile, titleId, "consultar");
  if (!row.bank_ref && !row.our_number) throw new ApiError(409, "erp_boleto_not_registered", "O banco ainda não confirmou o registro deste boleto. Registre de novo para conferir.");
  const { ctx, adapter } = await bankContext(env, profile, row.account_id);
  let record: BoletoRecord;
  try { record = await adapter.consult(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }); }
  catch (error) { throw bankApiError(error); }
  const fresh = await applyRecord(env, profile, row, record, actor.id);
  await exec(env, "UPDATE erp_boleto_api_titles SET next_poll_at=CASE WHEN status='registrado' THEN ? ELSE NULL END WHERE id=?", now() + 6 * HOUR, row.id);
  return { boleto: boletoView(fresh) };
}

/** Novo vencimento no banco (a conta no Financeiro não muda). */
export async function changeBoletoDue(env: Env, actor: Actor, profile: string, titleId: string, body: Record<string, unknown>) {
  await requireBilling(env, profile);
  await readTitle(env, profile, actor, titleId.toLowerCase());
  await requireBoletoWriter(env, actor, profile);
  const due = body.vencimento;
  if (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T12:00:00Z`)))
    throw new ApiError(400, "invalid_request", "vencimento: informe a data no formato AAAA-MM-DD.");
  if (due < brDate(now())) throw new ApiError(422, "erp_boleto_due_past", "O novo vencimento precisa ser de hoje em diante.");
  const row = await liveRow(env, profile, titleId, "mudar de vencimento");
  if (due === row.due_on) return { boleto: boletoView(row) };
  const { ctx, adapter } = await bankContext(env, profile, row.account_id);
  try { await adapter.changeDue(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }, due); }
  catch (error) { throw bankApiError(error); }
  const before = row.due_on;
  // A linha digitável muda com o vencimento (fator de vencimento): a nova vem da consulta.
  await exec(env, "UPDATE erp_boleto_api_titles SET due_on=?,barcode=NULL,digitable_line=NULL,updated=? WHERE id=?", due, now(), row.id);
  await audit(env, profile, row.id, "due_changed", actor.id, { title_id: row.title_id, before, after: due });
  let fresh = (await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", row.id))!;
  try { fresh = await applyRecord(env, profile, fresh, await adapter.consult(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }), actor.id); }
  catch { /* A linha nova chega na próxima consulta. */ }
  return { boleto: boletoView(fresh) };
}

/** Baixa (cancela) o boleto no banco; a conta continua em aberto no Financeiro. */
export async function cancelBoleto(env: Env, actor: Actor, profile: string, titleId: string, body: Record<string, unknown>) {
  await requireBilling(env, profile);
  await readTitle(env, profile, actor, titleId.toLowerCase());
  await requireBoletoWriter(env, actor, profile);
  const reason = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (reason.length < 3 || reason.length > 200) throw new ApiError(400, "invalid_request", "motivo: escreva de 3 a 200 caracteres.");
  const row = await liveRow(env, profile, titleId, "ser baixado");
  const { ctx, adapter } = await bankContext(env, profile, row.account_id);
  try { await adapter.cancel(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }, reason); }
  catch (error) { throw bankApiError(error); }
  await exec(env, `UPDATE erp_boleto_api_titles SET status='baixado',settle_state=CASE WHEN settle_state='aguardando' THEN 'encerrada' ELSE settle_state END,
    note=?,next_poll_at=NULL,updated=? WHERE id=? AND status='registrado'`, `Baixado no banco: ${reason}`.slice(0, 500), now(), row.id);
  await audit(env, profile, row.id, "cancelled", actor.id, { title_id: row.title_id, reason });
  return { boleto: boletoView((await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", row.id))!) };
}

// ---------------------------------------------------------------------------
// Baixa no Financeiro

function receiptNote(row: BoletoRow) {
  const when = row.paid_on ? day(row.paid_on) : null;
  const paid = row.paid_cents ?? row.amount_cents;
  return [`Pago por boleto ${row.paid_via === "pix" ? "(pelo Pix do boleto) " : ""}do ${BOLETO_BANK_INFO[row.bank].name}${when ? ` em ${when}` : ""}: ${money(paid)}.`,
    `Comprovante do banco: ${row.receipt ?? `nosso número ${row.our_number ?? row.bank_ref ?? "?"}`}; boleto ${row.id}.`].join(" ").slice(0, 500);
}

/** Por que a baixa não pode sair: a conta mudou desde o registro ou o valor pago é menor. */
export function boletoSettleConflict(row: Pick<BoletoRow, "title_version" | "amount_cents" | "paid_cents">, title: Record<string, any>): string | null {
  const conflict = settleConflict({ title_version: row.title_version, amount_cents: row.amount_cents }, title);
  if (conflict) return conflict.replace("depois que a cobrança foi gerada", "depois que o boleto foi registrado");
  if (row.paid_cents !== null && row.paid_cents < row.amount_cents)
    return `O banco informou pagamento de ${money(row.paid_cents)}, menor que o boleto (${money(row.amount_cents)}). Confira e dê a baixa à mão.`;
  return null;
}

/** Baixa a conta pelo boleto pago, como `actor`. Devolve o novo estado. */
export async function settleBoleto(env: Env, actor: Actor, row: BoletoRow): Promise<{ state: BoletoSettleState; note: string | null }> {
  const title = await readTitle(env, row.profile_id, actor, row.title_id);
  const conflict = boletoSettleConflict(row, title);
  if (conflict) return { state: "pendencia", note: conflict };
  const paid = row.paid_cents ?? row.amount_cents;
  const postedOn = row.paid_on && /^\d{4}-\d{2}-\d{2}$/.test(row.paid_on) ? row.paid_on : brDate(now());
  const result = await erpCall(env, row.profile_id, actor, "POST", "/v1/financeiro/actions/settle", {
    command_id: await commandId(`erp-boleto-settle:${row.id}`),
    data: { id: row.title_id, expected_version: Number(title.version), account_id: row.account_id,
      posted_on: postedOn < String(title.issued_on ?? "") ? String(title.issued_on) : postedOn,
      principal_cents: String(row.amount_cents), ...(paid > row.amount_cents ? { interest_cents: String(paid - row.amount_cents) } : {}),
      note: receiptNote(row) },
  }, "a baixa desta conta");
  const settlement = object(result?.settlement ?? result?.result?.settlement);
  await exec(env, "UPDATE erp_boleto_api_titles SET settlement_id=? WHERE id=?", typeof settlement.id === "string" ? settlement.id : null, row.id);
  return { state: "baixada", note: null };
}

/** Um clique: a pessoa confirma a sugestão de baixa (com o papel dela no ERP). */
export async function confirmBoletoSettlement(env: Env, actor: Actor, profile: string, titleId: string) {
  await requireBilling(env, profile);
  const row = await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND title_id=? AND status='pago' ORDER BY updated DESC LIMIT 1", profile, titleId.toLowerCase());
  if (!row) throw new ApiError(404, "erp_boleto_not_found", "Esta conta a receber não tem boleto pago pelo banco.");
  if (row.settle_state === "baixada") return { boleto: boletoView(row), repetido: true };
  if (row.settle_state !== "sugestao")
    throw new ApiError(409, "erp_boleto_not_suggested", `Este boleto não tem baixa a confirmar (${BOLETO_SETTLE_LABELS[row.settle_state].toLowerCase()}).`);
  const outcome = await settleBoleto(env, actor, row);
  await exec(env, "UPDATE erp_boleto_api_titles SET settle_state=?,note=?,confirmed_by=?,updated=? WHERE id=? AND settle_state='sugestao'",
    outcome.state, outcome.note, outcome.state === "baixada" ? actor.id : null, now(), row.id);
  await audit(env, profile, row.id, `confirm_${outcome.state}`, actor.id, { title_id: row.title_id, note: outcome.note });
  if (outcome.state !== "baixada") throw new ApiError(409, "erp_boleto_conflict", outcome.note ?? "A conta mudou desde o registro do boleto. Confira e dê a baixa à mão.");
  return { boleto: boletoView((await one<BoletoRow>(env, "SELECT * FROM erp_boleto_api_titles WHERE id=?", row.id))!), repetido: false };
}

const permanent = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
const reason = (error: unknown) => error instanceof ApiError || error instanceof BankError ? error.message : "O ERP não respondeu.";

/** Alarme da área: baixas automáticas pendentes e a consulta periódica dos boletos em aberto. */
export async function processBoletos(env: Env, profile: string) {
  const work = await all<BoletoRow>(env, `SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND settle_state='baixar' AND coalesce(next_at,0)<=? ORDER BY updated LIMIT 10`, profile, now());
  // Também o "sem resposta" com nosso número conhecido (Banco do Brasil e Itaú): a consulta confirma se o registro chegou.
  const polls = await all<BoletoRow>(env, `SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND status IN ('registrado','incerto')
    AND (bank_ref IS NOT NULL OR our_number IS NOT NULL) AND coalesce(next_poll_at,0)<=? ORDER BY next_poll_at LIMIT 5`, profile, now());
  if (!work.length && !polls.length) return;
  if (!await billingOn(env, profile)) return;
  const tokens = new Map<string, string>();
  for (const row of polls) {
    try {
      const { ctx, adapter } = await bankContext(env, profile, row.account_id, tokens);
      const fresh = await applyRecord(env, profile, row, await adapter.consult(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }), "system");
      // Perto do vencimento e depois dele, consulta mais vezes; 60 dias depois, uma vez por dia.
      const due = Date.parse(`${row.due_on}T23:59:59-03:00`), at = now();
      const next = at < due - 2 * 86_400_000 ? 12 * HOUR : at < due + 5 * 86_400_000 ? 2 * HOUR : at < due + 60 * 86_400_000 ? 12 * HOUR : 24 * HOUR;
      await exec(env, "UPDATE erp_boleto_api_titles SET next_poll_at=CASE WHEN status='registrado' THEN ? ELSE NULL END WHERE id=?", at + next, fresh.id);
    } catch {
      // Banco fora do ar, desligado ou credencial vencida: tenta de novo depois, sem barulho.
      await exec(env, "UPDATE erp_boleto_api_titles SET next_poll_at=? WHERE id=?", now() + 3 * HOUR, row.id);
    }
  }
  if (!work.length) return;
  const settings = await chargeSettings(env, profile);
  for (const row of (await all<BoletoRow>(env, `SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND settle_state='baixar' AND coalesce(next_at,0)<=? ORDER BY updated LIMIT 10`, profile, now()))) {
    const who = settings.enabled_by;
    const actor = who ? await actorForUser(env, who) : null;
    let outcome: { state: BoletoSettleState; note: string | null };
    try {
      if (!actor) throw new ApiError(403, "erp_boleto_actor_missing", "A baixa automática está desligada ou o administrador que a ligou não está mais ativo. Confirme a baixa à mão.");
      if (!settings.auto_settle) throw new ApiError(409, "erp_boleto_auto_off", "A baixa automática foi desligada depois do pagamento. Confirme a baixa à mão.");
      outcome = await settleBoleto(env, actor, row);
    } catch (error) {
      if (!permanent(error) && row.attempts + 1 < MAX_ATTEMPTS) {
        await exec(env, "UPDATE erp_boleto_api_titles SET attempts=attempts+1,next_at=?,note=?,updated=? WHERE id=? AND settle_state='baixar'",
          now() + Math.min(60_000 * 2 ** row.attempts, HOUR), reason(error).slice(0, 500), now(), row.id);
        continue;
      }
      outcome = { state: "sugestao", note: `A baixa automática não saiu: ${reason(error)}` };
    }
    const changed = await exec(env, "UPDATE erp_boleto_api_titles SET settle_state=?,note=?,next_at=NULL,updated=? WHERE id=? AND settle_state='baixar'",
      outcome.state, outcome.note?.slice(0, 500) ?? null, now(), row.id);
    if (changed.meta?.changes) await audit(env, profile, row.id, `auto_${outcome.state}`, who ?? "system", { title_id: row.title_id, note: outcome.note });
  }
}

// ---------------------------------------------------------------------------
// Aviso do banco (webhook)

/**
 * POST /webhooks/boleto/:codigo. O código do endereço identifica a conta
 * financeira (só o hash fica no D1). O corpo só diz quais boletos consultar:
 * o pagamento vale depois da consulta ao banco. Resposta sem dado do boleto.
 */
export async function boletoWebhook(env: Env, token: string, body: unknown): Promise<{ received: true; consultados: number }> {
  if (!/^[0-9a-f]{48}$/.test(token)) throw new ApiError(404, "not_found", "Endereço desconhecido.");
  const account = await one<AccountRow>(env, "SELECT * FROM erp_boleto_api_accounts WHERE webhook_hash=? AND mode='api'", await sha(token));
  if (!account?.bank) throw new ApiError(404, "not_found", "Endereço desconhecido.");
  const { webhookRefs } = await import("./adapter.ts");
  const refs = webhookRefs(body);
  if (!refs.length || !await billingOn(env, account.profile_id)) return { received: true, consultados: 0 };
  const marks = refs.map(() => "?").join(",");
  const rows = await all<BoletoRow>(env, `SELECT * FROM erp_boleto_api_titles WHERE profile_id=? AND account_id=? AND status IN ('registrado','incerto')
    AND (bank_ref IN (${marks}) OR our_number IN (${marks}) OR pix_txid IN (${marks})) LIMIT 20`, account.profile_id, account.account_id, ...refs, ...refs, ...refs);
  if (!rows.length) return { received: true, consultados: 0 };
  const { ctx, adapter } = await bankContext(env, account.profile_id, account.account_id);
  for (const row of rows) {
    // Falha ao consultar: erro para o banco reenviar o aviso.
    let record: BoletoRecord;
    try { record = await adapter.consult(ctx, { bank_ref: row.bank_ref ?? row.our_number!, our_number: row.our_number }); }
    catch (error) { throw bankApiError(error); }
    await applyRecord(env, account.profile_id, row, record, "bank");
  }
  return { received: true, consultados: rows.length };
}

// ---------------------------------------------------------------------------
// PDF do boleto (tela e conversa)

/** Os dados do PDF (layout FEBRABAN) a partir do boleto registrado; ou o que falta. */
export async function boletoPdfData(env: Env, actor: Actor, profile: string, row: BoletoRow) {
  const { boletoMissing } = await import("../conversa/boleto.ts");
  let company: Record<string, any> = {};
  try { company = object(object(object(await erpCall(env, profile, actor, "GET", "/v1/empresa/identidade", undefined, "os dados da empresa")).record).data); } catch { /* falta abaixo */ }
  const account = await accountRow(env, profile, row.account_id);
  const settings = parse(account?.settings) as Record<string, string>;
  let erpAcc: Record<string, any> = {};
  try { erpAcc = await erpAccount(env, actor, profile, row.account_id); } catch { /* sem agência no PDF */ }
  const payer = parse(row.payer);
  const address = (p: Record<string, any>) => [[p.street, p.number].filter(Boolean).join(", "), p.district, p.city && p.state ? `${p.city}/${p.state}` : p.city,
    p.zip ? `CEP ${String(p.zip).replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : null].filter(Boolean).join(" - ") || null;
  const agency = [text(erpAcc.agency, 10), [text(erpAcc.account_number, 20), text(erpAcc.account_digit, 2)].filter(Boolean).join("-")].filter(Boolean).join(" / ");
  const companyAddress = [[text(company.address ?? company.street), text(company.number ?? company.address_number)].filter(Boolean).join(", "), text(company.neighborhood ?? company.district),
    text(company.city) && text(company.state) ? `${company.city}/${company.state}` : text(company.city)].filter(Boolean).join(" - ") || null;
  const data = {
    bank: BOLETO_BANK_INFO[row.bank].code, barcode: row.barcode ?? "", digitable_line: row.digitable_line ?? "", amount_cents: String(row.amount_cents), due_on: row.due_on,
    our_number: row.our_number ?? row.bank_ref ?? "", document_number: row.seu_numero, issued_on: row.issued_on,
    beneficiary: { name: text(company.legal_name) ?? text(company.trade_name), document: text(company.cnpj) ? `CNPJ ${company.cnpj}` : null, address: companyAddress },
    payer: { name: text(payer.name), document: typeof payer.document === "string" && payer.document ? `${payer.document.length === 14 ? "CNPJ" : "CPF"} ${payer.document}` : null, address: address(payer) },
    instructions: ["Não receber após 60 dias do vencimento.", "Em caso de dúvida, fale com o beneficiário pelo WhatsApp."],
    agency_code: agency || null, wallet: settings.carteira ?? null, pix_code: row.pix_code,
    sandbox: row.environment === "sandbox",
  };
  const missing = boletoMissing(data);
  if (!row.barcode || !row.digitable_line) missing.unshift("a linha digitável que o banco devolve (use \"Consultar no banco\")");
  return { data, missing: [...new Set(missing)] };
}

/** O PDF do boleto da conta (tela): 422 com o que falta. */
export async function boletoPdfFor(env: Env, actor: Actor, profile: string, titleId: string) {
  await requireBilling(env, profile);
  await readTitle(env, profile, actor, titleId.toLowerCase());
  const row = await currentBoleto(env, profile, titleId);
  if (!row) throw new ApiError(404, "erp_boleto_not_found", "Esta conta a receber não tem boleto registrado pela API do banco.");
  if (row.status !== "registrado") throw new ApiError(409, "erp_boleto_not_registered", `O PDF sai só do boleto em aberto no banco. Este está: ${BOLETO_STATUS_LABELS[row.status].toLowerCase()}.`);
  const { data, missing } = await boletoPdfData(env, actor, profile, row);
  if (missing.length) throw new ApiError(422, "erp_boleto_incomplete", `O PDF do boleto não foi gerado: falta ${missing.join(", ")}.`);
  const { boletoPdf } = await import("../conversa/boleto.ts");
  return { bytes: boletoPdf(data), name: `Boleto-${row.our_number ?? row.seu_numero}.pdf` };
}

/**
 * Boleto pela API para o envio pela conversa (src/erp/conversa/documents.ts):
 * null se a conta não tem boleto registrado pela API (vale o CNAB).
 */
export async function conversaBoleto(env: Env, actor: Actor, profile: string, titleId: string, light: boolean) {
  if (!await billingOn(env, profile)) return null;
  const row = await currentBoleto(env, profile, titleId);
  if (!row || row.status !== "registrado") return null;
  const { data, missing } = await boletoPdfData(env, actor, profile, row);
  if (missing.length) return { file: null, missing, line: null, pix: null };
  const { boletoPdf, formatDigitable } = await import("../conversa/boleto.ts");
  return {
    file: { name: `Boleto-${String(row.our_number ?? row.seu_numero).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`, type: "application/pdf", bytes: light ? new Uint8Array(0) : boletoPdf(data) },
    missing: [] as string[], line: formatDigitable(data.digitable_line), pix: row.pix_code as string | null,
  };
}
