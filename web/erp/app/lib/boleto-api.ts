// Boleto registrado pela API do banco (Banco Inter, Sicoob, Banco do Brasil e Itaú): chamadas a
// /api/v1/profiles/<área>/erp-boleto (src/erp/boleto-api/routes.ts). O servidor confere tudo de novo (parte Cobrança bancária ligada,
// papel no ERP, administrador, banco ligado); aqui só se monta o pedido e se mostra a resposta. Fora do painel da área, na
// demonstração ou com a Cobrança bancária desligada, não aparece.
import { erpPorts } from '../../ports.ts';
import { blockEnabled } from '../../blocks.ts';

export type BoletoBank = 'inter' | 'sicoob' | 'bb' | 'itau';
export interface BoletoBankField { chave: string; rotulo: string; segredo: boolean; obrigatorio: boolean; dica: string | null; varias_linhas: boolean }
export interface BoletoBankSwitch {
  banco: BoletoBank; nome: string; codigo: string; ligado: boolean; ambiente: 'sandbox' | 'producao'; ligado_em: number | null;
  certificado: 'obrigatorio' | 'producao' | 'nao'; homologacao: boolean; aviso_por_webhook: boolean; hibrido: 'sempre' | 'opcional' | 'nao'; campos: BoletoBankField[];
}
export interface BoletoBanks { pode_mudar: boolean; bancos: BoletoBankSwitch[] }
export interface BoletoAccountConfig {
  conta: { id: string; nome: string; instituicao: string | null; agencia: string | null; numero: string | null };
  modo: 'cnab' | 'api'; banco: BoletoBank | null; banco_sugerido: BoletoBank | null; hibrido: boolean; campos: Record<string, string>;
  segredos_guardados: string[]; falta: string[]; banco_ligado: boolean; ambiente: 'sandbox' | 'producao'; aviso_url: string | null;
  conferido_em: number | null; conferencia: string | null; pode_mudar: boolean;
}
export interface BoletoRecord {
  id: string; conta: string; conta_financeira: string; banco: BoletoBank; banco_nome: string; homologacao: boolean; situacao: string; situacao_rotulo: string;
  baixa: string; baixa_rotulo: string; motivo: string | null; nosso_numero: string | null; linha_digitavel: string | null; codigo_barras: string | null;
  pix_copia_e_cola: string | null; valor_centavos: string; valor: string | null; vencimento: string; pago_em: string | null; valor_pago: string | null;
  pago_por: string | null; comprovante: string | null; criado_em: number; pode_confirmar_baixa: boolean; pode_mudar: boolean; pdf: boolean;
}
export interface BoletoApiAccount { id: string; banco: BoletoBank; banco_nome: string; ambiente: 'sandbox' | 'producao'; pronta: boolean; falta: string | null }
export interface BoletoContext {
  conta: { id: string; aberta: boolean; saldo_centavos: string | null; vencimento: string | null };
  contas_financeiras: BoletoApiAccount[]; falta: string | null; boleto: BoletoRecord | null; historico: BoletoRecord[];
}

export class BoletoApiError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.name = 'BoletoApiError'; this.code = code; }
}

export function boletoApiBase(): string | null {
  const ports = erpPorts();
  if (!ports?.embedded || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-boleto');
}
/** Aparece só no painel da área, com a Cobrança bancária (e o Financeiro) ligada. */
export const boletoApiAvailable = () => boletoApiBase() !== null && blockEnabled('erp-cobranca');

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const base = boletoApiBase();
  if (!base) throw new BoletoApiError('O boleto pelo banco só funciona no painel da área (não na demonstração).', 'erp_boleto_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new BoletoApiError(init.method === 'POST' ? 'A resposta não chegou. Abra a conta de novo para conferir antes de tentar outra vez.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'erp_boleto_network');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as any;
    const error = body?.error ?? body ?? {};
    throw new BoletoApiError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}).`, typeof error.code === 'string' ? error.code : 'erp_boleto_failed');
  }
  return response;
}
const call = async <T,>(path: string, init: RequestInit = {}) => (await request(path, init)).json() as Promise<T>;
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const title = (id: string) => `/conta/${encodeURIComponent(id)}`;

export const boletoBanks = (signal?: AbortSignal) => call<BoletoBanks>('/bancos', { signal });
export const saveBoletoBank = (bank: BoletoBank, body: { ligado?: boolean; ambiente?: 'sandbox' | 'producao'; confirmo?: boolean }) => call<BoletoBanks>(`/bancos/${bank}`, post(body));
export const boletoAccount = (account: string, signal?: AbortSignal) => call<BoletoAccountConfig>(`/contas-financeiras/${encodeURIComponent(account)}`, { signal });
export const saveBoletoAccount = (account: string, body: { modo?: 'cnab' | 'api'; banco?: BoletoBank | null; campos?: Record<string, string>; hibrido?: boolean; testar?: boolean }) =>
  call<BoletoAccountConfig>(`/contas-financeiras/${encodeURIComponent(account)}`, post(body));
export const boletoContext = (id: string, signal?: AbortSignal) => call<BoletoContext>(title(id), { signal });
export const registerBoleto = (id: string, account: string | null) => call<{ boleto: BoletoRecord; novo: boolean }>(`${title(id)}/registrar`, post(account ? { conta_financeira: account } : {}));
export const askBank = (id: string) => call<{ boleto: BoletoRecord }>(`${title(id)}/banco`);
export const changeBoletoDue = (id: string, vencimento: string) => call<{ boleto: BoletoRecord }>(`${title(id)}/vencimento`, post({ vencimento }));
export const cancelBoleto = (id: string, motivo: string) => call<{ boleto: BoletoRecord }>(`${title(id)}/baixar`, post({ motivo }));
export const confirmBoletoSettlement = (id: string) => call<{ boleto: BoletoRecord }>(`${title(id)}/confirmar-baixa`, post({}));
/** O PDF do boleto (o servidor diz o que falta quando não dá para gerar). */
export const boletoPdf = async (id: string) => (await request(`${title(id)}/pdf`, { headers: { Accept: 'application/pdf' } })).blob();

export const BOLETO_PRODUCTION_WARNING = 'Em produção, o boleto registrado vale de verdade: o cliente pode pagar e o banco cobra as tarifas do contrato de cobrança. Confira antes, na homologação, um registro, uma consulta, a alteração de vencimento e a baixa.';
export const certificateText = (value: BoletoBankSwitch['certificado']) =>
  value === 'obrigatorio' ? 'Pede certificado da API em todas as chamadas.' : value === 'producao' ? 'Pede certificado da API em produção.' : 'Não pede certificado.';
