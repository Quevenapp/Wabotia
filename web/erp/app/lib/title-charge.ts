// Cobrança de conta a receber por Pix ou link (src/erp/conversa/charges.ts), pelas rotas
// /api/v1/profiles/<área>/erp-conversa/conta/:id/cobranca e /financeiro/preferencias. O servidor confere tudo (parte
// Financeiro ligada, papel no ERP, Cobrança configurada). Fora do painel da área e na demonstração não aparece.
import { conversaCall, newKey, whatsappBase } from './whatsapp-send.ts';

export type ChargeMethod = 'pix' | 'link';
export interface TitleChargeRecord {
  id: string; conta: string; forma: ChargeMethod; valor: string | null; descricao: string; situacao: string; baixa: string; baixa_rotulo: string;
  motivo: string | null; pix_copia_e_cola: string | null; pix_qr: string | null; link: string | null; vence_em: number | null; pago_em: number | null;
  criada_em: number; pode_confirmar_baixa: boolean;
}
export interface TitleChargeContext {
  conta: { id: string; aberta: boolean; saldo_centavos: string | null };
  cobranca_pronta: boolean; falta: string | null; codigo_falta: string | null; baixa_automatica: boolean; cobrancas: TitleChargeRecord[];
}
export interface ChargeOption { id: string; nome: string; ativa: boolean }
export interface ChargePreferences {
  baixar_sozinho: boolean; conta_financeira: string | null; forma_pagamento: string | null; ligada_em: number | null; pode_mudar: boolean;
  cobranca_pronta: boolean; falta: string | null; contas: ChargeOption[]; formas: ChargeOption[];
}

export const titleChargeAvailable = () => whatsappBase() !== null;
const path = (id: string) => `/conta/${encodeURIComponent(id)}/cobranca`;
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newKey() } });

export const titleChargeContext = (id: string, signal?: AbortSignal) => conversaCall<TitleChargeContext>(path(id), { signal });
export const generateTitleCharge = (id: string, forma: ChargeMethod) => conversaCall<{ cobranca: TitleChargeRecord; nova: boolean }>(path(id), post({ forma }));
export const confirmTitleSettlement = (id: string, charge: string, choice: { conta_financeira?: string | null; forma_pagamento?: string | null } = {}) =>
  conversaCall<{ cobranca: TitleChargeRecord }>(`${path(id)}/${encodeURIComponent(charge)}/baixar`, post(choice));
export const chargePreferences = (signal?: AbortSignal) => conversaCall<ChargePreferences>('/financeiro/preferencias', { signal });
export const saveChargePreferences = (body: { baixar_sozinho?: boolean; conta_financeira?: string | null; forma_pagamento?: string | null; confirmo?: boolean }) =>
  conversaCall<ChargePreferences>('/financeiro/preferencias', post(body));

/** "data:image/png;base64,…" do QR do Pix (o provedor manda o PNG em base64), ou null. */
export const pixQrSource = (value: string | null) => value && /^[A-Za-z0-9+/=]+$/.test(value) ? `data:image/png;base64,${value}` : null;
export const AUTO_SETTLE_WARNING = 'Com a opção ligada, o Financeiro baixa a conta a receber sozinho, sem uma pessoa conferir, assim que o provedor confirmar o pagamento do Pix ou do link. A baixa sai em seu nome, na conta financeira escolhida, e fica registrada. Conta que alguém já baixou ou mudou à mão não é mexida: vira pendência.';
