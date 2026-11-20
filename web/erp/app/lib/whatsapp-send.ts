// "Enviar pelo WhatsApp" dos documentos do ERP (proposta, pedido, nota fiscal e conta a receber) pela linha de WhatsApp da própria área:
// a rota /api/v1/profiles/<área>/erp-conversa (src/erp/conversa/routes.ts). O servidor confere tudo de novo (papel no ERP, parte ligada,
// privacidade, linha, janela de 24 horas); aqui só se monta o pedido e se mostra a resposta. Fora do painel embutido ou na demonstração,
// o envio não está disponível.
import { useEffect, useState } from 'react';
import { erpPorts } from '../../ports.ts';
import { blockEnabled } from '../../blocks.ts';

export type WhatsappDocType = 'proposta' | 'pedido' | 'nota' | 'conta';
const PARTS: Record<WhatsappDocType, 'erp-vendas' | 'erp-fiscal' | 'erp-financeiro'> = { proposta: 'erp-vendas', pedido: 'erp-vendas', nota: 'erp-fiscal', conta: 'erp-financeiro' };
export const NO_LINE = 'Conecte uma linha de WhatsApp em Conexões';

export interface WhatsappLine { id: string; nome: string; numero: string | null; tipo: 'oficial' | 'qr'; gerenciada: boolean; permite_atendente: boolean }
export type WhatsappMode = 'arquivo' | 'mensagem' | 'link' | 'modelo' | 'bloqueado';
export interface WhatsappSendRecord { id: string; resumo: string; estado: string; estado_rotulo: string; motivo: string | null; modo: string; fora_do_cadastro: boolean; pelo_bot: boolean }
export interface WhatsappPreparation {
  documento: { tipo: WhatsappDocType; id: string; titulo: string; cliente: string | null; abrir_no_erp: string };
  telefones: { digitos: string; numero: string }[];
  linhas: WhatsappLine[];
  conectar: string | null;
  destino: null | { telefone: string; digitos: string; fora_do_cadastro: boolean; linha: string; conversa: { id: string } | null; janela: 'aberta' | 'fechada' | 'sem_janela';
    modo: WhatsappMode; motivo: string | null; modelo: string | null; pode_copiar_link: boolean; conversa_nova: boolean };
  previa: { texto: string; anexos: { nome: string; tipo: string; tamanho: number | null }[]; xml_opcional: boolean };
  envios: WhatsappSendRecord[];
}
export interface WhatsappSendResult { envio: WhatsappSendRecord; url: string | null }

export class WhatsappSendError extends Error {
  readonly code: string;
  constructor(message: string, code = 'erp_conversa_failed') { super(message); this.name = 'WhatsappSendError'; this.code = code; }
}

/** /api/v1/profiles/<área>/erp-conversa, ou null fora do painel embutido e na demonstração. */
export function whatsappBase(): string | null {
  const ports = erpPorts();
  if (!ports?.embedded || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-conversa');
}
/** A parte do ERP do documento está ligada (sem ela, o botão não aparece). */
export const whatsappPartEnabled = (type: WhatsappDocType) => blockEnabled(PARTS[type]);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = whatsappBase();
  if (!base) throw new WhatsappSendError('O envio pelo WhatsApp só funciona no painel da área (não na demonstração).', 'erp_conversa_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new WhatsappSendError(init.method === 'POST' ? 'A resposta não chegou. Confira o registro de envios do documento antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'erp_conversa_network');
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new WhatsappSendError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}).`, typeof error.code === 'string' ? error.code : 'erp_conversa_failed');
  }
  return body as T;
}

let linesCache: { base: string; at: number; value: Promise<{ linhas: WhatsappLine[]; conectar: string | null }> } | null = null;
/** Linhas de WhatsApp da área (consulta guardada por um minuto). */
export function whatsappLines(): Promise<{ linhas: WhatsappLine[]; conectar: string | null }> {
  const base = whatsappBase();
  if (!base) return Promise.reject(new WhatsappSendError('Envio pelo WhatsApp indisponível aqui.', 'erp_conversa_unavailable'));
  if (!linesCache || linesCache.base !== base || Date.now() - linesCache.at > 60_000) {
    const value = call<{ linhas: WhatsappLine[]; conectar: string | null }>('');
    linesCache = { base, at: Date.now(), value };
    value.catch(() => { if (linesCache?.value === value) linesCache = null; });
  }
  return linesCache.value;
}

export type LinesState = { phase: 'unavailable' } | { phase: 'loading' } | { phase: 'ready'; count: number } | { phase: 'error'; message: string };
/** Estado das linhas para o botão: sem linha, desabilitado com o recado de Conexões. */
export function useWhatsappLines(): LinesState {
  const [state, setState] = useState<LinesState>(() => whatsappBase() ? { phase: 'loading' } : { phase: 'unavailable' });
  useEffect(() => {
    if (!whatsappBase()) return;
    let alive = true;
    whatsappLines().then(value => { if (alive) setState({ phase: 'ready', count: value.linhas.length }); },
      error => { if (alive) setState({ phase: 'error', message: error instanceof Error ? error.message : 'Não deu para consultar as linhas.' }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/** Botão ou item de menu: null quando não se oferece (fora do painel ou parte desligada). */
export function whatsappButtonState(type: WhatsappDocType, lines: LinesState, reason?: string | null): { disabled: boolean; title: string } | null {
  if (lines.phase === 'unavailable' || !whatsappPartEnabled(type)) return null;
  if (reason) return { disabled: true, title: reason };
  if (lines.phase === 'ready' && lines.count === 0) return { disabled: true, title: NO_LINE };
  return { disabled: false, title: 'Envia ao cliente pela linha de WhatsApp da área, com prévia antes de confirmar.' };
}

const path = (type: WhatsappDocType, id: string) => `/${type}/${encodeURIComponent(id)}`;
export function prepareWhatsapp(type: WhatsappDocType, id: string, choice: { telefone?: string | null; linha?: string | null; xml?: boolean }, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (choice.telefone) query.set('telefone', choice.telefone);
  if (choice.linha) query.set('linha', choice.linha);
  if (choice.xml) query.set('xml', '1');
  return call<WhatsappPreparation>(`${path(type, id)}${query.size ? `?${query}` : ''}`, { signal });
}
export function sendWhatsapp(type: WhatsappDocType, id: string, body: { telefone: string; linha: string; xml?: boolean; acao?: 'enviar' | 'copiar_link' }, key: string) {
  return call<WhatsappSendResult>(`${path(type, id)}/enviar`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
}
export const whatsappHistory = (type: WhatsappDocType, id: string, signal?: AbortSignal) => call<{ envios: WhatsappSendRecord[] }>(`${path(type, id)}/envios`, { signal });

export const MODE_LABELS: Record<WhatsappMode, string> = {
  arquivo: 'Vai a mensagem com o arquivo anexado.', mensagem: 'Vai a mensagem com a cobrança.', link: 'Vai a mensagem com um link seguro para o cliente abrir o documento.',
  modelo: 'Vai pelo modelo aprovado da área, com o link seguro no texto.', bloqueado: 'Não dá para enviar agora por esta linha.',
};
export const WINDOW_LABELS = { aberta: 'O cliente escreveu nas últimas 24 horas.', fechada: 'Fora da janela de 24 horas do WhatsApp.', sem_janela: 'Linha pelo QR: sem janela de 24 horas.' } as const;
export const sizeLabel = (bytes: number | null) => bytes === null ? 'tamanho conferido no envio' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
export const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
