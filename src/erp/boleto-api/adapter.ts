// Interface comum dos bancos de boleto por API: registrar, consultar, alterar
// o vencimento, baixar (cancelar) e ler o aviso de liquidação (webhook). Cada
// banco (./banks/*.ts) só monta os pedidos HTTP e lê as respostas; quem
// chama o banco é o transporte (`BankHttp`), que nos testes é um banco
// simulado e no Worker é ./transport.ts. Sem rede e sem D1 aqui: os testes do
// Node importam este arquivo.
//
// Segurança: credenciais e certificado só entram no pedido; nenhuma mensagem
// de erro leva o pedido, o cabeçalho ou o corpo do banco inteiro (só o texto
// curto do motivo, sem números longos).
import type { BoletoBank } from "./contract.ts";

export type BankEnvironment = "sandbox" | "producao";

export interface BankHttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** O banco exige o certificado do cliente (mTLS) neste pedido. */
  mtls: boolean;
}
export interface BankHttpResponse { status: number; body: unknown }
export type BankHttp = (request: BankHttpRequest) => Promise<BankHttpResponse>;

/** Tudo o que a pessoa digitou (segredos do cofre e dados comuns) e o ambiente. */
export interface BankContext {
  bank: BoletoBank;
  http: BankHttp;
  environment: BankEnvironment;
  fields: Readonly<Record<string, string>>;
  /** Boleto híbrido (com Pix), quando o banco oferece. */
  hybrid: boolean;
  /** Token do OAuth guardado durante uma rodada (nunca no D1). */
  tokens?: Map<string, string>;
}

export interface BoletoPayer {
  name: string;
  /** CPF (11) ou CNPJ (14), só dígitos. */
  document: string;
  street: string | null;
  number: string | null;
  district: string | null;
  city: string | null;
  /** UF, duas letras. */
  state: string | null;
  /** CEP, 8 dígitos. */
  zip: string | null;
}

export interface BoletoRequest {
  /** "Seu número" no banco (até 15 caracteres): o mesmo em cada nova tentativa. */
  seu_numero: string;
  /** Nosso número escolhido pelo Wabotia, para os bancos que pedem (Banco do Brasil e Itaú). */
  our_number: string | null;
  amount_cents: string;
  due_on: string;
  issued_on: string;
  payer: BoletoPayer;
  instructions: readonly string[];
}

/** Referência do boleto no banco (o que volta do registro). */
export interface BoletoRef { bank_ref: string; our_number: string | null }

export interface BoletoRecord extends BoletoRef {
  status: "registrado" | "pago" | "baixado";
  barcode: string | null;
  digitable_line: string | null;
  pix_code: string | null;
  pix_txid: string | null;
  due_on: string | null;
  amount_cents: string | null;
  /** Pagamento confirmado pelo banco. */
  paid_cents: string | null;
  paid_on: string | null;
  paid_via: "boleto" | "pix" | null;
  /** Identificação do pagamento no banco (autenticação, txid, código), para o comprovante. */
  receipt: string | null;
}

export type BankErrorKind = "recusado" | "credencial" | "indisponivel" | "incerto" | "configuracao";
export class BankError extends Error {
  kind: BankErrorKind;
  status: number | null;
  constructor(kind: BankErrorKind, message: string, status: number | null = null) { super(message); this.name = "BankError"; this.kind = kind; this.status = status; }
}

export interface BoletoAdapter {
  bank: BoletoBank;
  /** Confere as credenciais (entra na API, sem registrar nada). */
  check(ctx: BankContext): Promise<void>;
  register(ctx: BankContext, request: BoletoRequest): Promise<BoletoRecord>;
  consult(ctx: BankContext, ref: BoletoRef): Promise<BoletoRecord>;
  changeDue(ctx: BankContext, ref: BoletoRef, dueOn: string): Promise<void>;
  cancel(ctx: BankContext, ref: BoletoRef, reason: string): Promise<void>;
  /** Pede ao banco para avisar neste endereço (quando o banco aceita cadastro pela API). */
  registerWebhook?(ctx: BankContext, url: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ajudantes comuns dos bancos

export const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
export const onlyDigits = (value: unknown): string | null => { const text = str(value); const digits = text?.replace(/\D/g, "") ?? ""; return digits ? digits : null; };
/** "123.45" ou 123.45 em centavos (texto); null se não for valor. */
export function reaisToCents(value: unknown): string | null {
  const text = typeof value === "number" ? value.toFixed(2) : str(value);
  if (!text || !/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [int, frac = ""] = text.split(".");
  return String(BigInt(int!) * 100n + BigInt((frac + "00").slice(0, 2)));
}
/** Centavos (texto) em reais com ponto: "12345" → "123.45". */
export const centsToReais = (cents: string) => { const value = BigInt(cents); return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; };
/** "dd.mm.aaaa" ou "dd/mm/aaaa" ou "aaaa-mm-dd[...]" em "aaaa-mm-dd". */
export function isoDate(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(text);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
export const dotDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const barcodeOf = (value: unknown) => { const digits = onlyDigits(value); return digits && digits.length === 44 ? digits : null; };
export const lineOf = (value: unknown) => { const digits = onlyDigits(value); return digits && digits.length === 47 ? digits : null; };

/** Motivo curto do banco (sem números longos, que podem ser dados do cliente). */
function bankReason(body: unknown): string | null {
  const b = object(body);
  const candidates = [b.message, b.mensagem, b.detail, b.title, b.error_description, object(list(b.violacoes)[0]).razao, object(list(b.erros)[0]).mensagem,
    object(list(b.errors)[0]).message, object(list(b.mensagens)[0]).mensagem, object(list(b.campos)[0]).mensagem, object(list(b.violations)[0]).message];
  const text = candidates.map(str).find(Boolean);
  return text ? text.replace(/\d{6,}/g, "…").slice(0, 160) : null;
}

/** Erro do banco pelo status HTTP, em português. */
export function bankFailure(bankName: string, status: number, body: unknown, what: string): BankError {
  const reason = bankReason(body);
  if (status === 401 || status === 403)
    return new BankError("credencial", `O ${bankName} recusou as credenciais ao ${what}${reason ? ` (${reason})` : ""}. Confira o Client ID, o Client Secret e o certificado na conta financeira.`, status);
  if (status === 429 || status >= 500)
    return new BankError("indisponivel", `O ${bankName} não respondeu ao ${what} (erro ${status}). Tente de novo em alguns minutos.`, status);
  return new BankError("recusado", `O ${bankName} recusou ${what}${reason ? `: ${reason}` : ` (erro ${status})`}. Confira os dados da conta e do cliente.`, status);
}

/** Chama o banco; falha de rede vira "incerto" (pode ter chegado) ou "indisponível". */
export async function call(ctx: BankContext, bankName: string, request: BankHttpRequest, what: string, uncertain = false): Promise<BankHttpResponse> {
  let response: BankHttpResponse;
  try { response = await ctx.http(request); }
  catch (error) {
    if (error instanceof BankError) throw error;
    throw uncertain
      ? new BankError("incerto", `O ${bankName} não respondeu ao ${what}. O pedido pode ter chegado: confira antes de tentar de novo.`)
      : new BankError("indisponivel", `O ${bankName} não respondeu ao ${what}. Tente de novo em alguns minutos.`);
  }
  if (response.status >= 400) throw bankFailure(bankName, response.status, response.body, what);
  return response;
}

const form = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");

/** OAuth client_credentials (guardado em ctx.tokens durante a rodada). */
export async function oauthToken(ctx: BankContext, bankName: string, options: { url: string; values: Record<string, string>; headers?: Record<string, string>; mtls: boolean }): Promise<string> {
  const key = `${ctx.bank}:${ctx.environment}:${options.url}:${ctx.fields.client_id ?? ""}`;
  const cached = ctx.tokens?.get(key);
  if (cached) return cached;
  const response = await call(ctx, bankName, {
    method: "POST", url: options.url, mtls: options.mtls, body: form(options.values),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(options.headers ?? {}) },
  }, "entrar na API");
  const token = str(object(response.body).access_token);
  if (!token) throw new BankError("credencial", `O ${bankName} não devolveu a autorização da API. Confira as credenciais na conta financeira.`);
  ctx.tokens?.set(key, token);
  return token;
}

/** O campo digitado, ou erro de configuração dizendo qual falta. */
export function need(ctx: BankContext, key: string, label: string): string {
  const value = ctx.fields[key]?.trim();
  if (!value) throw new BankError("configuracao", `Falta ${label} na configuração da conta financeira.`);
  return value;
}

export const json = (value: unknown) => JSON.stringify(value);
/** Tipo de pessoa pelo documento. */
export const personKind = (document: string) => document.length === 14 ? "J" : "F";

/** Referências citadas num aviso de banco (webhook): só textos dos campos conhecidos, sem repetir. */
export function webhookRefs(body: unknown): string[] {
  const keys = new Set(["codigoSolicitacao", "id", "numeroTituloCliente", "nossoNumero", "nosso_numero", "numero_nosso_numero", "id_boleto", "idBoleto", "txid"]);
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || found.size >= 50) return;
    if (Array.isArray(value)) { value.slice(0, 50).forEach(item => visit(item, depth + 1)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key) && (typeof item === "string" || typeof item === "number")) { const text = String(item).trim(); if (/^[A-Za-z0-9-]{1,64}$/.test(text)) found.add(text); }
      else if (item && typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(body, 0);
  return [...found];
}
