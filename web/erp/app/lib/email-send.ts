// "Enviar por e-mail" dos documentos do ERP (proposta, pedido de venda, pedido de compra, NF-e, NFC-e e conta a receber) pelo e-mail
// da instalação: a rota /api/v1/profiles/<área>/erp-email (src/erp/email/routes.ts). O servidor confere tudo de novo (papel no ERP,
// parte ligada, privacidade, e-mail configurado); aqui só se monta o pedido e se mostra a resposta. Fora do painel embutido ou na
// demonstração, o envio não está disponível.
import { useEffect, useState } from 'react';
import { erpPorts } from '../../ports.ts';
import { blockEnabled } from '../../blocks.ts';

export type EmailDocType = 'proposta' | 'pedido' | 'compra' | 'nota' | 'nfce' | 'conta';
const PARTS: Record<EmailDocType, readonly string[]> = { proposta: ['erp-vendas'], pedido: ['erp-vendas'], compra: ['erp-compras'], nota: ['erp-fiscal'], nfce: ['erp-fiscal', 'erp-pdv'], conta: ['erp-financeiro'] };
export const EMAIL_SETUP_HINT = 'O e-mail desta instalação ainda não está configurado. O administrador configura em Gestão → Sistema → E-mail.';

export type EmailPayment = 'pix' | 'link' | 'boleto' | 'sem';
export const EMAIL_PAYMENT_LABELS: Record<EmailPayment, string> = { pix: 'Pix copia e cola (confirma sozinho)', link: 'Link de pagamento (confirma sozinho)', boleto: 'Boleto em PDF', sem: 'Só o aviso, sem forma de pagar' };
export interface EmailSituation { configurado: boolean; remetente: string | null; nome: string | null; onde_configurar: string | null; aviso: string | null }
export interface EmailSendRecord {
  id: string; resumo: string; para: string; copias: string[]; assunto: string; anexos: { nome: string; tipo: string; tamanho: number }[];
  estado: 'enviando' | 'enviado' | 'na_fila' | 'devolvido' | 'falhou'; estado_rotulo: string; motivo: string | null; automatico: boolean; reenvio_de: string | null; pelo_bot: boolean; em: number;
}
export interface EmailPreparation {
  documento: { tipo: EmailDocType; id: string; titulo: string; cliente: string | null; rotulo: string };
  email: EmailSituation;
  para: string | null; cadastro: string[]; sem_email_no_cadastro: string | null;
  copias: string[]; responder_para: string | null; remetente: string | null;
  modelo: { assunto: string; mensagem: string; variaveis: string[] };
  previa: { assunto: string; mensagem: string };
  anexos: { nome: string; tipo: string; tamanho: number | null }[];
  xml_opcional: boolean;
  pagamento: { escolha: EmailPayment; opcoes: EmailPayment[]; avisos: string[] } | null;
  envios: EmailSendRecord[];
}
export interface EmailSendResult { envio: EmailSendRecord; repetido: boolean }

export class EmailSendError extends Error {
  readonly code: string;
  constructor(message: string, code = 'erp_email_failed') { super(message); this.name = 'EmailSendError'; this.code = code; }
}

/** /api/v1/profiles/<área>/erp-email, ou null fora do painel embutido e na demonstração. */
export function emailBase(): string | null {
  const ports = erpPorts();
  if (!ports?.embedded || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-email');
}
/** As partes do ERP do documento estão ligadas (sem elas, o botão não aparece). */
export const emailPartEnabled = (type: EmailDocType) => PARTS[type].every(part => blockEnabled(part as Parameters<typeof blockEnabled>[0]));

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = emailBase();
  if (!base) throw new EmailSendError('O envio por e-mail só funciona no painel da área (não na demonstração).', 'erp_email_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new EmailSendError(init.method === 'POST' ? 'A resposta não chegou. Confira o registro de envios do documento antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'erp_email_network');
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new EmailSendError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}).`, typeof error.code === 'string' ? error.code : 'erp_email_failed');
  }
  return body as T;
}

let situationCache: { base: string; at: number; value: Promise<EmailSituation> } | null = null;
/** O e-mail da instalação está configurado? (consulta guardada por um minuto). */
export function emailSituation(): Promise<EmailSituation> {
  const base = emailBase();
  if (!base) return Promise.reject(new EmailSendError('Envio por e-mail indisponível aqui.', 'erp_email_unavailable'));
  if (!situationCache || situationCache.base !== base || Date.now() - situationCache.at > 60_000) {
    const value = call<EmailSituation>('');
    situationCache = { base, at: Date.now(), value };
    value.catch(() => { if (situationCache?.value === value) situationCache = null; });
  }
  return situationCache.value;
}

export type EmailState = { phase: 'unavailable' } | { phase: 'loading' } | { phase: 'ready'; configured: boolean; hint: string | null } | { phase: 'error'; message: string };
/** Estado do e-mail da instalação para o botão: sem configuração, o botão abre e diz onde configurar. */
export function useEmailSituation(): EmailState {
  const [state, setState] = useState<EmailState>(() => emailBase() ? { phase: 'loading' } : { phase: 'unavailable' });
  useEffect(() => {
    if (!emailBase()) return;
    let alive = true;
    emailSituation().then(value => { if (alive) setState({ phase: 'ready', configured: value.configurado, hint: value.aviso }); },
      error => { if (alive) setState({ phase: 'error', message: error instanceof Error ? error.message : 'Não deu para consultar o e-mail da instalação.' }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/** Botão ou item de menu: null quando não se oferece (fora do painel ou parte desligada). */
export function emailButtonState(type: EmailDocType, state: EmailState, reason?: string | null): { disabled: boolean; title: string } | null {
  if (state.phase === 'unavailable' || !emailPartEnabled(type)) return null;
  if (reason) return { disabled: true, title: reason };
  if (state.phase === 'ready' && !state.configured) return { disabled: false, title: state.hint ?? EMAIL_SETUP_HINT };
  return { disabled: false, title: 'Envia por e-mail com o arquivo anexado, com prévia do destinatário, das cópias e do texto antes de confirmar.' };
}

const path = (type: EmailDocType, id: string) => `/${type}/${encodeURIComponent(id)}`;
export function prepareEmail(type: EmailDocType, id: string, choice: { pagamento?: EmailPayment | null }, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (choice.pagamento) query.set('pagamento', choice.pagamento);
  return call<EmailPreparation>(`${path(type, id)}${query.size ? `?${query}` : ''}`, { signal });
}
export interface EmailSendBody { para: string; copias?: string[]; assunto?: string; mensagem?: string; xml?: boolean; pagamento?: EmailPayment }
export function sendEmail(type: EmailDocType, id: string, body: EmailSendBody, key: string) {
  return call<EmailSendResult>(`${path(type, id)}/enviar`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
}
export function resendEmail(type: EmailDocType, id: string, sendId: string, key: string) {
  return call<EmailSendResult>(`${path(type, id)}/envios/${encodeURIComponent(sendId)}/reenviar`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
}
export const emailHistory = (type: EmailDocType, id: string, signal?: AbortSignal) => call<{ envios: EmailSendRecord[] }>(`${path(type, id)}/envios`, { signal });

const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
/** Endereços digitados ("a@x.com, b@y.com"): os válidos, minúsculos, sem repetir, e os inválidos à parte. */
export function parseAddresses(text: string): { valid: string[]; invalid: string[] } {
  const items = text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
  const valid = [...new Set(items.filter(item => ADDRESS.test(item)).map(item => item.toLowerCase()))];
  return { valid, invalid: items.filter(item => !ADDRESS.test(item)) };
}
export const validAddress = (text: string) => ADDRESS.test(text.trim());
export const newEmailKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const emailSize = (bytes: number | null) => bytes === null || bytes === 0 ? 'tamanho conferido no envio' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
