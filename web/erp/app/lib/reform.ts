// Reforma tributária (IBS, CBS e IS) no painel do ERP, pela rota
// /api/v1/profiles/<área>/erp-reforma (src/erp/reforma/routes.ts). O servidor
// confere tudo de novo (papel, permissão, parte Fiscal ligada); aqui só se
// monta o pedido. O cálculo do bloco das propostas e pedidos é o mesmo da NF-e
// (src/erp/domains/fiscal/reform-calc.ts). Fora do painel da área
// (demonstração) não há esta rota: os blocos somem.
import { useEffect, useState } from 'react';
import { erpPorts } from '../../ports.ts';
import type { ReformCompanySettings, ReformItemStatus, ReformRatesView, ReformResult, ReformSelectiveInput } from '../../../../src/erp/domains/fiscal/reform-calc.ts';

export class ReformError extends Error {
  readonly code: string; readonly status: number;
  constructor(message: string, code = 'erp_reforma_failed', status = 0) { super(message); this.name = 'ReformError'; this.code = code; this.status = status; }
}

/** /api/v1/profiles/<área>/erp-reforma, ou null na demonstração e fora do painel da área. */
export function reformBase(): string | null {
  const ports = erpPorts();
  if (!ports || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-reforma');
}
export const reformAvailable = () => reformBase() !== null;
export const REFORM_UNAVAILABLE = 'A reforma tributária abre no painel da área (não na demonstração).';

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
async function reformCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = reformBase();
  if (!base) throw new ReformError(REFORM_UNAVAILABLE, 'erp_reforma_unavailable');
  let response: Response;
  try { response = await globalThis.fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ReformError(init.method === 'POST' ? 'A resposta não chegou. Atualize a tela para ver se a alteração entrou antes de tentar de novo.' : 'Sem resposta do servidor. Confira a conexão e tente de novo.', 'erp_reforma_network');
  }
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new ReformError(typeof error.message === 'string' ? error.message : `O servidor recusou o pedido (${response.status}). Tente de novo.`, typeof error.code === 'string' ? error.code : 'erp_reforma_failed', response.status);
  }
  return body as T;
}
export const reformGet = <T,>(path: string, query: Record<string, string | null | undefined> = {}, signal?: AbortSignal) => {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  const search = params.toString();
  return reformCall<T>(`${path}${search ? `?${search}` : ''}`, { signal });
};
export const reformPost = <T,>(path: string, body: unknown) =>
  reformCall<T>(path, { method: 'POST', body: JSON.stringify({ comando: newKey(), ...(body as object) }), headers: { 'Content-Type': 'application/json' } });
export const reformErrorText = (error: unknown) => error instanceof Error ? error.message : 'Algo deu errado. Atualize a tela e tente de novo.';
export const reformCsvUrl = (from: string, to: string, environment: string) => {
  const base = reformBase();
  return base ? `${base}/relatorio?${new URLSearchParams({ de: from, ate: to, ambiente: environment, formato: 'csv' })}` : null;
};

export interface ReformVaultView { known: boolean; ibs_cbs: boolean; selective: boolean; credit_debit: boolean; purposes: string[] }
export interface ReformSettingsView {
  settings: ReformCompanySettings; version: number; updated_at: string | null; writable: boolean; crt: string | null;
  regime: ReformResult['regime']; table: { version: string; source: string }; years: ReformRatesView[]; vault: ReformVaultView;
}
export interface ReformProductView {
  product_id: string; classification: { cst: string; cclasstrib: string; nbs: string | null } | null; selective: ReformSelectiveInput | null;
  expected_hash: string; writable: boolean;
}
export interface ReformNatureRule { position?: number; product_scope: 'any' | 'ncm' | 'products' | 'groups'; ncms: string[]; product_ids: string[]; group_ids: string[]; cst: string; cclasstrib: string }
export interface ReformNatureView { nature_id: string; rules: ReformNatureRule[]; expected_hash: string; writable: boolean }
export interface ReformDocumentContext {
  crt: string | null; regime: ReformResult['regime']; settings: ReformCompanySettings; nature: { id: string; description: string | null } | null;
  products: { id: string; ncm: string | null; classification: { cst: string; cclasstrib: string; nbs: string | null; source: string } | null; selective: ReformSelectiveInput | null }[];
  vault: ReformVaultView; year: number;
}
export interface ReformReportView {
  from: string; to: string; environment: string; without_reform: number;
  lines: { month: string; cst: string; cclasstrib: string; description: string; notes: number; items: number; base: string; cbs: string; ibs_uf: string; ibs_mun: string; ibs: string; selective: string }[];
  totals: { notes: number; base: string; cbs: string; ibs_uf: string; ibs_mun: string; ibs: string; selective: string };
}

/**
 * O que o cofre aceita da reforma (como o preparo da NF-e vê), ou null quando
 * não deu para ler (demonstração, sem a parte Fiscal ou sem permissão): quem
 * usa trata null como "não aceita".
 */
export function useReformVault(enabled = true): ReformVaultView | null {
  const [vault, setVault] = useState<ReformVaultView | null>(null);
  useEffect(() => {
    if (!enabled || !reformAvailable()) { setVault(null); return; }
    const request = new AbortController();
    reformGet<ReformSettingsView>('/configuracao', {}, request.signal)
      .then(value => { if (!request.signal.aborted) setVault(value.vault); })
      .catch(() => { if (!request.signal.aborted) setVault(null); });
    return () => request.abort();
  }, [enabled]);
  return vault;
}

/** Situação de cada item, em palavras de quem usa. */
export const REFORM_STATUS_TEXT: Record<ReformItemStatus, string> = {
  calculated: 'Calculado',
  exempt: 'Isento, imune ou sem incidência',
  manual: 'Regime específico (fica com o contador)',
  unclassified: 'Sem classificação',
  unknown_class: 'Classificação fora da tabela',
  class_mismatch: 'Classificação não é do CST',
  simples: 'Simples Nacional: não destaca',
  rates_unpublished: 'Alíquotas do ano não publicadas',
  out_of_range: 'Valor fora do formato',
};

export const formatRate = (value: string | null | undefined) => value == null ? '—' : `${value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',')}%`;

const cents = (value: string) => { const negative = value.startsWith('-'); const [whole, fraction = ''] = value.replace('-', '').split('.'); const c = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2)); return negative ? -c : c; };
const money = (value: bigint) => { const negative = value < 0n; const v = negative ? -value : value; return `${negative ? '-' : ''}${v / 100n}.${String(v % 100n).padStart(2, '0')}`; };

/**
 * Base de cada item de uma proposta ou pedido para a estimativa: o total do
 * item mais a parte proporcional do frete e das outras despesas, menos a do
 * desconto do documento (o último item fica com o resto do arredondamento).
 * Não desconta ICMS, PIS e COFINS (a NF-e desconta, com o cálculo da nota).
 */
export function documentItemBases(totals: { items: { total: string }[]; discount: string; freight: string; other_expenses: string }): string[] {
  const lines = totals.items.map(item => cents(item.total));
  const sum = lines.reduce((a, b) => a + b, 0n);
  const extra = cents(totals.freight) + cents(totals.other_expenses) - cents(totals.discount);
  let given = 0n;
  return lines.map((line, index) => {
    const share = index === lines.length - 1 ? extra - given : sum === 0n ? 0n : (extra * line) / sum;
    given += share;
    const base = line + share;
    return money(base < 0n ? 0n : base);
  });
}
