// Vinki (junção): "Boleto já baixado no banco". A conta a receber numa remessa operacional viva só cancela quando alguém declara,
// com motivo, que o boleto já foi baixado no banco (title_bank_writeoff). O ERP não manda instrução ao banco. Lógica pura, sem tela.
import { financePermitted, titlePermission, type FinanceAccess, type FinanceTitle } from './real-finance-model.ts';

export const BANK_WRITEOFF_PATH = '/v1/financeiro/actions/title_bank_writeoff';
export const BANK_WRITEOFF_LABEL = 'Boleto já baixado no banco';
export const BANK_WRITEOFF_TEXT = 'Este boleto está numa remessa ao banco. Confirme que ele já foi baixado no banco para cancelar a conta.';
export const BANK_WRITEOFF_WARNING = 'O Vinki não envia a baixa ao banco: faça a baixa no banco antes de confirmar.';
export const BANK_WRITEOFF_REASON_MIN = 3, BANK_WRITEOFF_REASON_MAX = 500;
/** Partes do ERP de que a declaração depende (web/erp/blocks.ts). */
export const BANK_WRITEOFF_BLOCKS = ['erp-financeiro', 'erp-cobranca'] as const;

/** Recusa da API sem depender da classe AccessError ({ status, code, field }; field: finance.mjs financeRefusal). */
type Refusal = { status: number; code?: string; field?: string };
const refusal = (error: unknown): Refusal | null => error && typeof error === 'object' && typeof (error as Refusal).status === 'number' ? error as Refusal : null;

/** Motivo como o servidor conta: sem espaços nas pontas, de 3 caracteres até 500 (a rota também limita a 500 unidades de texto). */
export function bankWriteoffReason(text: string): string {
  const reason = String(text ?? '').trim(), size = [...reason].length;
  if (size < BANK_WRITEOFF_REASON_MIN) throw new Error('Informe o motivo com pelo menos 3 caracteres, por exemplo: baixado no internet banking em 20/11, protocolo 123.');
  if (size > BANK_WRITEOFF_REASON_MAX || reason.length > BANK_WRITEOFF_REASON_MAX) throw new Error('O motivo aceita até 500 caracteres.');
  return reason;
}
/** Corpo de POST /v1/financeiro/actions/title_bank_writeoff com a versão da conta mostrada na tela. */
export function bankWriteoffBody(title: Pick<FinanceTitle, 'id' | 'version'>, reason: string, commandId: string) {
  return { command_id: commandId, data: { id: title.id, expected_version: title.version, reason: bankWriteoffReason(reason) } };
}
/** O cancelamento comum foi recusado porque o boleto está numa remessa ao banco: a tela abre a declaração. */
export const opensBankWriteoff = (error: unknown) => { const r = refusal(error); return Boolean(r && r.status === 409 && r.field === 'billed_locked'); };

/** A ação aparece na conta a receber aberta, sem baixa, que está numa remessa, com Financeiro e Cobrança ligados e a permissão de cancelar. */
export function bankWriteoffAvailable(title: Pick<FinanceTitle, 'kind' | 'cancelled' | 'settled_cents' | 'deleted_at'> & { remittance?: { id: string } | null; imported?: boolean },
  access: (Pick<FinanceAccess, 'permitted' | 'write'>) | null | undefined, enabled: (block: typeof BANK_WRITEOFF_BLOCKS[number]) => boolean): boolean {
  return title.kind === 'receivable' && !title.cancelled && !title.deleted_at && title.settled_cents === '0' && Boolean(title.remittance) && Boolean(access?.write)
    && financePermitted(access, titlePermission('receivable', 'cancelar')) && BANK_WRITEOFF_BLOCKS.every(block => enabled(block));
}

const BLOCK_NAMES: Readonly<Record<typeof BANK_WRITEOFF_BLOCKS[number], string>> = { 'erp-financeiro': 'Financeiro', 'erp-cobranca': 'Cobrança bancária' };
/** Com uma das partes desligada a declaração não abre: diz qual módulo ligar (como a tela de parte desligada); ligadas, null. */
export function bankWriteoffBlocked(enabled: (block: typeof BANK_WRITEOFF_BLOCKS[number]) => boolean): string | null {
  const off = BANK_WRITEOFF_BLOCKS.filter(block => !enabled(block)).map(block => BLOCK_NAMES[block]);
  return off.length ? `Esta conta tem boleto numa remessa ao banco. Para declarar o boleto baixado no banco e cancelar a conta, ligue ${off.join(' e ')} em Gestão → Módulos.` : null;
}

const PERMISSION = 'Falta a permissão de cancelar conta a receber. Peça ao administrador para liberar “Cancelar” em Contas a receber, em Preferências › Sistema › Usuários › Permissões.';
const MFA = 'Esta operação exige o segundo fator. Confirme que é você com o código do aplicativo autenticador (em “Confirme que é você”) e tente de novo. Ainda não cadastrou o aplicativo? Cadastre em Minha conta.';
/** Texto das recusas conhecidas do cancelamento e da declaração; null quando a causa não é conhecida (a tela usa a mensagem geral). */
export function cancelRefusalText(error: unknown): string | null {
  const r = refusal(error); if (!r) return null;
  if (r.status === 403 && r.code === 'ERP_MFA_REQUIRED') return MFA;
  if (r.status === 409 && r.code === 'module_disabled') return 'Esta ação depende do Financeiro e da Cobrança bancária, e um deles está desligado. Ligue os dois em Gestão → Módulos.';
  switch (r.field) {
    case 'billed_locked': return 'Esta conta tem boleto numa remessa ao banco e não cancela pelo cancelamento comum. Abra o menu da conta e use “Boleto já baixado no banco”.';
    case 'bank_writeoff_not_applicable': return 'Este boleto já não está numa remessa ao banco. Use o cancelamento comum da conta.';
    case 'version_conflict': return 'A conta mudou desde que foi aberta. Recarregue a listagem e abra a conta de novo antes de confirmar.';
    case 'command_conflict': return 'Esta confirmação já foi usada com outros dados. Recarregue a listagem e abra a conta de novo.';
    case 'permission_denied': return PERMISSION;
    case 'access_denied': return 'Seu papel no ERP só consulta o financeiro. Peça ao administrador o papel financeiro ou administrador em Gestão › Pessoas e acessos.';
    case 'cancelled_title': return 'Esta conta já está cancelada. Recarregue a listagem.';
    case 'deleted_title': return 'Esta conta foi excluída. Recarregue a listagem.';
    case 'active_payments': return 'Esta conta tem baixa registrada. Estorne a baixa antes de cancelar.';
    case 'reason_required': return 'Informe o motivo com 3 a 500 caracteres.';
    default: return null;
  }
}
/** Mensagem de uma recusa da declaração (inclui o 403 sem motivo, que é a falta de permissão). */
export function bankWriteoffFailure(error: unknown): string {
  const known = cancelRefusalText(error); if (known) return known;
  const r = refusal(error);
  if (r?.status === 403) return PERMISSION;
  if (r?.status === 409) return 'A conta mudou desde que foi aberta. Recarregue a listagem e abra a conta de novo antes de confirmar.';
  if (r?.status === 404) return 'A conta não foi encontrada. Recarregue a listagem.';
  if (r?.status === 400) return 'O pedido não foi aceito. Confira o motivo (3 a 500 caracteres) e tente de novo.';
  return 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma declaração; ela não será duplicada.';
}

export interface BankWriteoff { billing_title_id: string; remittance_id: string; reason: string; declared_by: string; declared_by_name: string | null; declared_at: string }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
/** bank_writeoff do detalhe da conta (GET /v1/financeiro/titles/{id}/detalhe): só na conta cancelada pela declaração; ausente, null. */
export function titleBankWriteoff(value: unknown): BankWriteoff | null {
  const w = value && typeof value === 'object' ? (value as { bank_writeoff?: unknown }).bank_writeoff : undefined;
  if (w === undefined || w === null) return null;
  const x = w as Record<string, unknown>;
  if (typeof w !== 'object' || !uuid(x.billing_title_id) || !uuid(x.remittance_id) || !uuid(x.declared_by) || typeof x.reason !== 'string' || !x.reason.trim()
    || (x.declared_by_name !== null && x.declared_by_name !== undefined && typeof x.declared_by_name !== 'string') || typeof x.declared_at !== 'string' || !Number.isFinite(Date.parse(x.declared_at)))
    throw new Error('Não foi possível conferir os dados da conta. Feche e abra a conta novamente.');
  return { billing_title_id: x.billing_title_id, remittance_id: x.remittance_id, reason: x.reason, declared_by: x.declared_by, declared_by_name: (x.declared_by_name as string | null | undefined) ?? null, declared_at: x.declared_at };
}
/** Data e hora de São Paulo, como o painel mostra (20/11/2026, 12:00). */
export const bankWriteoffWhen = (at: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(at));
/** Quem declarou: o nome da pessoa no ERP; sem nome, o começo do identificador. */
export const bankWriteoffWho = (w: Pick<BankWriteoff, 'declared_by' | 'declared_by_name'>) => w.declared_by_name?.trim() || `Usuário ${w.declared_by.slice(0, 8)}`;
