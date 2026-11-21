// Relatórios do ERP (DRE gerencial, gráficos, lotes vencendo e pagamento da equipe) pela rota
// /api/v1/profiles/<área>/erp-relatorios (src/erp/relatorios/routes.ts). O servidor confere tudo de novo (papel no ERP,
// permissão, partes ligadas, horário e segundo fator); aqui só se monta o pedido, o período e a exportação.
// Fora do painel da área (demonstração) não há esta rota.
import { erpPorts } from '../../ports.ts';
import { CSV_TYPE, downloadFile, numberCell, textCell, toCsv, type SheetCell } from './spreadsheet-export';

export class ReportsError extends Error {
  readonly code: string; readonly status: number;
  constructor(message: string, code = 'erp_relatorios_failed', status = 0) { super(message); this.name = 'ReportsError'; this.code = code; this.status = status; }
}

/** /api/v1/profiles/<área>/erp-relatorios, ou null na demonstração e fora do painel da área. */
export function reportsBase(): string | null {
  const ports = erpPorts();
  if (!ports || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-relatorios');
}
export const reportsAvailable = () => reportsBase() !== null;
export const REPORTS_UNAVAILABLE = 'Os relatórios do ERP abrem no painel da área (não na demonstração).';

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
export async function reportsCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = reportsBase();
  if (!base) throw new ReportsError(REPORTS_UNAVAILABLE, 'erp_relatorios_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ReportsError(init.method === 'POST' ? 'A resposta não chegou. Confira em Pagamentos da equipe se o lançamento entrou antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'erp_relatorios_network');
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new ReportsError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}). Tente de novo.`, typeof error.code === 'string' ? error.code : 'erp_relatorios_failed', response.status);
  }
  return body as T;
}
export const reportsGet = <T,>(path: string, query: Record<string, string | null | undefined>, signal?: AbortSignal) => {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  const search = params.toString();
  return reportsCall<T>(`${path}${search ? `?${search}` : ''}`, { signal });
};
export const reportsPost = <T,>(path: string, body: unknown) =>
  reportsCall<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newKey() } });
export const failureText = (error: unknown) => error instanceof Error ? error.message : 'Não deu para gerar o relatório. Tente de novo.';

/** Categorias de despesa marcadas como Custos no DRE (tela de categorias); fora do painel da área, null (a opção não aparece). */
export const loadDreCosts = (signal?: AbortSignal): Promise<ReadonlySet<string> | null> =>
  reportsAvailable() ? reportsGet<{ category_ids: string[] }>('/dre/custos', {}, signal).then(v => new Set(v.category_ids)) : Promise.resolve(null);
export const saveDreCost = (category: string, cost: boolean) => reportsPost('/dre/custos', { categoria: category, custos: cost });

// ---------- períodos ----------
export type PeriodKind = 'mes' | 'trimestre' | 'ano' | 'intervalo';
export const PERIOD_KINDS: readonly { id: PeriodKind; label: string }[] = [{ id: 'mes', label: 'Mês' }, { id: 'trimestre', label: 'Trimestre' }, { id: 'ano', label: 'Ano' }, { id: 'intervalo', label: 'Intervalo' }];
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
/** O período que contém o dia (mês, trimestre ou ano); no intervalo, o mês do dia. */
export function periodOf(kind: PeriodKind, day: string) {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1;
  if (kind === 'ano') return { from: iso(y, 0, 1), to: iso(y, 11, 31) };
  if (kind === 'trimestre') { const q = Math.floor(m / 3) * 3; return { from: iso(y, q, 1), to: iso(y, q + 3, 0) }; }
  return { from: iso(y, m, 1), to: iso(y, m + 1, 0) };
}
/** O período seguinte ou anterior do mesmo tamanho (mês, trimestre ou ano). */
export function shiftPeriod(kind: PeriodKind, from: string, step: number) {
  const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)) - 1, months = kind === 'ano' ? 12 : kind === 'trimestre' ? 3 : 1;
  return periodOf(kind, iso(y, m + step * months, 1));
}
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const brDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—';
/** "nov/2026", "4º tri/2026", "2026" ou "01/11/2026 a 15/11/2026". */
export function periodLabel(from: string, to: string) {
  const a = periodOf('mes', from), q = periodOf('trimestre', from), y = periodOf('ano', from);
  if (a.from === from && a.to === to) return `${MONTHS[Number(from.slice(5, 7)) - 1]}/${from.slice(0, 4)}`;
  if (q.from === from && q.to === to) return `${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1}º tri/${from.slice(0, 4)}`;
  if (y.from === from && y.to === to) return from.slice(0, 4);
  return `${brDate(from)} a ${brDate(to)}`;
}
/** Rótulo curto da faixa do gráfico (dia, semana ou mês). */
export function bucketLabel(start: string, end: string, group: 'day' | 'week' | 'month') {
  if (group === 'month') return `${MONTHS[Number(start.slice(5, 7)) - 1]}/${start.slice(2, 4)}`;
  if (group === 'week') return `${start.slice(8, 10)}/${start.slice(5, 7)}–${end.slice(8, 10)}/${end.slice(5, 7)}`;
  return `${start.slice(8, 10)}/${start.slice(5, 7)}`;
}

// ---------- valores ----------
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Centavos (texto, com sinal) em reais. */
export const money = (cents: string | null | undefined) => cents === null || cents === undefined ? '—' : BRL.format(Number(cents) / 100);
/** Centavos em "1234.56" para a planilha. */
export const decimalCents = (cents: string | null | undefined) => {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(cents)) return '';
  const negative = cents.startsWith('-'), digits = (negative ? cents.slice(1) : cents).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
/** Quantidade (escala 6) sem zeros à direita, em pt-BR. */
export const quantity = (value: string | null | undefined) => value === null || value === undefined ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
/** Variação em relação ao anterior: "+12,5%", "−3,0%", "novo" ou "—". */
export function variation(current: string, previous: string | null) {
  if (previous === null) return '—';
  const a = Number(current), b = Number(previous);
  if (b === 0) return a === 0 ? '—' : 'novo';
  const pct = ((a - b) / Math.abs(b)) * 100;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ---------- exportação ----------
export type CsvValue = { text: string | null } | { cents: string | null } | { number: string | null };
const cell = (value: CsvValue): SheetCell => 'cents' in value ? numberCell(decimalCents(value.cents)) : 'number' in value ? numberCell(value.number) : textCell(value.text);
/** Monta e baixa a planilha CSV (cabeçalho e linhas). */
export function exportCsv(name: string, header: readonly string[], rows: readonly (readonly CsvValue[])[]) {
  const file = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'relatorio';
  downloadFile(`${file}.csv`, toCsv([header.map(textCell), ...rows.map(row => row.map(cell))]), CSV_TYPE);
}
export const t = (text: string | null | undefined): CsvValue => ({ text: text ?? '' });
export const c = (cents: string | null | undefined): CsvValue => ({ cents: cents ?? null });
export const n = (number: string | number | null | undefined): CsvValue => ({ number: number === null || number === undefined ? null : String(number) });

// ---------- respostas ----------
export type DreBasis = 'caixa' | 'competencia';
export interface DreCategory { category_id: string | null; name: string; path: string; deleted: boolean; amount_cents: string; previous_cents: string | null }
export interface DreGroupRow { key: string; amount_cents: string; previous_cents: string | null; categories: DreCategory[] }
export interface DreView {
  basis: 'cash' | 'competence'; from: string; to: string; previous: { from: string; to: string } | null;
  groups: DreGroupRow[]; lines: { key: string; amount_cents: string; previous_cents: string | null }[];
  unclassified: Omit<DreGroupRow, 'key'>; hidden: Omit<DreGroupRow, 'key'>;
}
export interface DreDetail {
  category: { id: string | null; name: string; path: string; group: string }; page: number; limit: number; total: number; amount_cents: string;
  items: { source: 'settlement' | 'reversal' | 'entry' | 'title'; id: string; title_id: string | null; on: string; description: string; contact_name: string | null; amount_cents: string }[];
}
/** A ordem do DRE: grupo (G) ou subtotal (L), com o rótulo de tela. */
export const DRE_LAYOUT: readonly { kind: 'G' | 'L'; key: string; label: string }[] = [
  { kind: 'G', key: 'gross_revenue', label: 'Receita bruta' },
  { kind: 'G', key: 'revenue_deductions', label: '(−) Deduções da receita' },
  { kind: 'L', key: 'net_revenue', label: '= Receita líquida' },
  { kind: 'G', key: 'costs', label: '(−) Custos' },
  { kind: 'L', key: 'gross_profit', label: '= Lucro bruto' },
  { kind: 'G', key: 'operating_expenses', label: '(−) Despesas operacionais' },
  { kind: 'L', key: 'operating_result', label: '= Resultado operacional' },
  { kind: 'G', key: 'financial_revenue', label: 'Receitas financeiras' },
  { kind: 'G', key: 'financial_expenses', label: '(−) Despesas financeiras' },
  { kind: 'G', key: 'other_revenue', label: 'Outras receitas' },
  { kind: 'G', key: 'other_expenses', label: '(−) Outras despesas' },
  { kind: 'L', key: 'before_taxes', label: '= Resultado antes do IR e da CSLL' },
  { kind: 'G', key: 'income_taxes', label: '(−) IR e CSLL' },
  { kind: 'L', key: 'net_result', label: '= Resultado líquido' },
];
export const DRE_SOURCES: Readonly<Record<string, string>> = { settlement: 'Baixa', reversal: 'Estorno de baixa', entry: 'Lançamento de caixa', title: 'Conta' };

export type ChartGroup = 'day' | 'week' | 'month';
export interface SalesChart { report: 'period' | 'seller' | 'product'; group: ChartGroup; total_cents: string; order_count?: number; seller_count?: number; product_count?: number; seller_scope: boolean;
  items: { start_on?: string; end_on?: string; orders?: number; seller_id?: string | null; product_id?: string | null; name?: string; code?: string | null; unit?: string | null; quantity?: string; amount_cents: string }[] }
export interface CashFlowChart { report: 'cash_flow'; group: ChartGroup; opening_cents: string; items: { start_on: string; end_on: string; forecast_in_cents: string; forecast_out_cents: string; realized_in_cents: string; realized_out_cents: string; balance_cents: string }[];
  totals: { forecast_in_cents: string; forecast_out_cents: string; realized_in_cents: string; realized_out_cents: string; closing_cents: string } }
export interface DueChart { report: 'due'; today: string; items: { key: string; from_on: string | null; to_on: string | null; receivable_count: number; receivable_cents: string; payable_count: number; payable_cents: string }[]; totals: { receivable_cents: string; payable_cents: string } }
export const DUE_LABELS: Readonly<Record<string, string>> = {
  overdue_31: 'Vencidas há mais de 30 dias', overdue_30: 'Vencidas há até 30 dias', today: 'Vencem hoje', next_7: 'Próximos 7 dias',
  next_30: 'De 8 a 30 dias', next_60: 'De 31 a 60 dias', next_90: 'De 61 a 90 dias', later: 'Depois de 90 dias',
};
export interface WarehouseChart { report: 'warehouses'; items: { warehouse_id: string; name: string; active: boolean; ignored: boolean; products: number; negative_positions: number; quantity: string }[] }
export interface TurnoverChart { report: 'turnover'; from: string; to: string; total: number; warehouses: { id: string; name: string; active: boolean; ignored: boolean }[];
  items: { product_id: string; name: string; code: string | null; unit: string | null; out_quantity: string; start_quantity: string; end_quantity: string; average_quantity: string; turnover: string | null; cover_days: number | null }[] }
export interface LotRow { lot_id: string; code: string; expires_on: string; days_left: number; product_id: string; product_name: string; product_code: string | null; unit: string | null; warehouse_id: string; warehouse_name: string; quantity: string }
export interface LotsExpiring { today: string; until: string; days: number; days_source: 'preference' | 'default' | 'request'; preference_days: number; warehouse_id: string | null; limit: number;
  expiring: { total: number; lots: number; items: LotRow[] }; expired: { total: number; lots: number; items: LotRow[] }; warehouses: { id: string; name: string; ignored: boolean }[] }

export type PayKind = 'salario' | 'comissao' | 'adiantamento' | 'vale';
export const PAY_KINDS: readonly { id: PayKind; label: string }[] = [{ id: 'salario', label: 'Salário' }, { id: 'comissao', label: 'Comissão' }, { id: 'adiantamento', label: 'Adiantamento' }, { id: 'vale', label: 'Vale' }];
export const payKindLabel = (id: string) => PAY_KINDS.find(kind => kind.id === id)?.label ?? id;
export interface TeamPerson { kind: 'employee' | 'seller'; id: string; name: string; contact_id: string | null; contact_name: string | null; active: boolean; rate: string | null; salary_cents: string | null; job_title: string | null }
export interface TeamReport { from: string; to: string; truncated: boolean;
  people: { person_kind: 'employee' | 'seller'; person_id: string; name: string; total_cents: string; paid_cents: string; open_cents: string; by_kind: Record<PayKind, string> }[];
  items: { id: string; title_id: string; person_kind: 'employee' | 'seller'; person_id: string; name: string; pay_kind: PayKind; period_from: string; period_to: string; description: string; due_on: string; amount_cents: string; settled_cents: string; status: string; base_cents: string | null; rate: string | null }[] }
export interface TeamCommission { from: string; to: string; fiscal_included: boolean;
  items: { seller_id: string; name: string; contact_id: string; active: boolean; rate: string | null; order_count: number; base_cents: string; commission_cents: string | null;
    generated: { id: string; title_id: string; period_from: string; period_to: string; amount_cents: string }[]; orders: { id: string; number: number; on: string; base_cents: string; invoiced: boolean }[] }[] }
export const TITLE_STATUS: Readonly<Record<string, string>> = { open: 'Em aberto', partial: 'Pago em parte', paid: 'Pago', overdue: 'Atrasado', cancelled: 'Cancelado' };
/** Percentual guardado com 4 casas ("5.0000") em "5%" / "2,5%". */
export const ratePercent = (rate: string | null) => rate === null ? '—' : `${Number(rate).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
/** Centavos em "1500.00" (o valor que a rota recebe). */
export const centsToReais = (cents: string) => decimalCents(cents);
