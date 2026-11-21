// Maquininha integrada ao caixa: chamadas a /api/v1/profiles/<área>/erp-maquininha (src/erp/terminal/routes.ts). O servidor
// confere tudo de novo (Caixa / PDV ligado, papel no PDV, administrador, maquininha ligada, venda em aberto e o valor); aqui só se
// monta o pedido e se mostra a resposta. Fora do painel da área, na demonstração ou com o Caixa / PDV desligado, não aparece.
import { erpPorts } from './ports.ts';
import { blockEnabled } from './blocks.ts';

export type TerminalKind = 'debito' | 'credito';
export type TerminalStatus = 'enviando' | 'aguardando' | 'processando' | 'aprovado' | 'recusado' | 'cancelado' | 'incerto' | 'erro';
export interface TerminalSettings {
  ligado: boolean; ligado_em: number | null; provedor: 'mercadopago'; provedores: { id: string; nome: string; terminal: string }[];
  credencial: 'cobranca' | 'propria'; conta_cobranca: boolean; segredos_guardados: string[];
  forma_debito: string | null; forma_debito_nome: string | null; forma_credito: string | null; forma_credito_nome: string | null;
  parcelas_max: number; juros_parcelado: 'loja' | 'cliente';
  caixas: { id: string; nome: string; terminal: string | null; terminal_nome: string | null }[];
  formas: { id: string; nome: string; tipo: 'debito' | 'credito' | 'outro' }[];
  falta: string[]; pronto: boolean; leitura_pdv: string | null; aviso_url: string | null; pode_mudar: boolean;
}
export interface TerminalDevice { id: string; nome: string; pronto: boolean; modo: string | null; aviso: string | null }
export interface TerminalPayment {
  id: string; venda: string; venda_numero: string | null; caixa: string; terminal: string; provedor: string; provedor_nome: string; forma: string;
  tipo: TerminalKind; tipo_rotulo: string; parcelas: number; valor_centavos: string; situacao: TerminalStatus; situacao_rotulo: string; motivo: string | null;
  em_andamento: boolean; bandeira: string | null; bandeira_rotulo: string | null; autorizacao: string | null; nsu: string | null; final_cartao: string | null;
  pago_em: number | null; observacao: string | null; venda_concluida: boolean; conciliacao: string | null; conciliacao_nota: string | null;
  pode_cancelar: boolean; pode_reenviar: boolean; criado_em: number; atualizado_em: number;
}

export class TerminalApiError extends Error {
  code: string;
  /** A resposta não chegou: a cobrança pode ter saído; consulte antes de repetir. */
  uncertain: boolean;
  constructor(message: string, code: string, uncertain = false) { super(message); this.name = 'TerminalApiError'; this.code = code; this.uncertain = uncertain; }
}

export function terminalApiBase(): string | null {
  const ports = erpPorts();
  if (!ports?.embedded || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-maquininha');
}
/** Aparece só no painel da área, com o Caixa / PDV ligado. */
export const terminalApiAvailable = () => terminalApiBase() !== null && blockEnabled('erp-pdv');

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = terminalApiBase();
  if (!base) throw new TerminalApiError('A maquininha integrada só funciona no painel da área (não na demonstração).', 'erp_terminal_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new TerminalApiError(init.method === 'POST' ? 'A resposta não chegou. A cobrança pode ter ido para a maquininha: confira antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.',
      'erp_terminal_network', init.method === 'POST');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as any;
    const error = body?.error ?? body ?? {};
    throw new TerminalApiError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}).`, typeof error.code === 'string' ? error.code : 'erp_terminal_failed',
      init.method === 'POST' && response.status >= 500);
  }
  return response.json() as Promise<T>;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const payment = (id: string) => `/pagamentos/${encodeURIComponent(id)}`;

export const terminalSettings = (signal?: AbortSignal) => call<TerminalSettings>('/configuracao', { signal });
export const saveTerminalSettings = (body: Partial<{ ligado: boolean; credencial: 'cobranca' | 'propria'; access_token: string; webhook_secret: string; forma_debito: string | null;
  forma_credito: string | null; parcelas_max: number; juros_parcelado: 'loja' | 'cliente' }>) => call<TerminalSettings>('/configuracao', post(body));
export const terminalDevices = (signal?: AbortSignal) => call<{ provedor: string; terminais: TerminalDevice[] }>('/terminais', { signal });
export const saveCashierTerminal = (account: string, terminal: string | null, nome?: string) =>
  call<TerminalSettings>(`/caixas/${encodeURIComponent(account)}`, post(nome ? { terminal, nome } : { terminal }));
export const chargeTerminal = (body: { venda: string; caixa: string; tipo: TerminalKind; parcelas: number; comando: string }) =>
  call<{ pagamento: TerminalPayment; nova: boolean }>('/cobrar', post(body));
export const terminalPayment = (id: string, signal?: AbortSignal) => call<{ pagamento: TerminalPayment }>(payment(id), { signal });
export const terminalSalePayments = (sale: string, signal?: AbortSignal) => call<{ pagamentos: TerminalPayment[] }>(`/pagamentos?${new URLSearchParams({ venda: sale })}`, { signal });
export const cancelTerminalPayment = (id: string) => call<{ pagamento: TerminalPayment }>(`${payment(id)}/cancelar`, post({}));
export const resendTerminalPayment = (id: string) => call<{ pagamento: TerminalPayment; reenviado: boolean }>(`${payment(id)}/reenviar`, post({ confirmo: true }));
export const terminalSaleFinished = (id: string) => call<{ pagamento: TerminalPayment }>(`${payment(id)}/venda-concluida`, post({}));

/** Parcelas da venda que vão para a maquininha: as da forma de débito ou de crédito configurada. */
export function terminalRows<T extends { payment_method_id: string; amount_cents: string }>(rows: readonly T[], settings: Pick<TerminalSettings, 'forma_debito' | 'forma_credito'>) {
  const debit = rows.filter(row => settings.forma_debito && row.payment_method_id === settings.forma_debito);
  const credit = rows.filter(row => settings.forma_credito && row.payment_method_id === settings.forma_credito);
  const sum = (list: readonly T[]) => list.reduce((total, row) => total + BigInt(row.amount_cents || '0'), 0n);
  return { debit: sum(debit), credit: sum(credit), kind: (debit.length && !credit.length ? 'debito' : credit.length && !debit.length ? 'credito' : debit.length ? 'ambos' : null) as TerminalKind | 'ambos' | null };
}
