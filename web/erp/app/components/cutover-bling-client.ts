import { BLING_ADOPTION_OPERATIONS, adoptionErrorMessage } from '../../../../src/erp/bling/adoption-contracts.ts';
import { erpPorts } from '../../ports.ts';
import { AdoptBlingFailure } from './adopt-bling-client';

/** Valor digitado pela pessoa ("1.234,56", "-10", "10,5") em centavos; null se não for valor. */
export function centsFromText(value: string): string | null {
  const t = value.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  const m = /^(-)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const cents = BigInt(m[2].replace(/\./g, '')) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return (m[1] && cents !== 0n ? '-' : '') + cents.toString();
}
export const brl = (cents: string | null | undefined) => cents === null || cents === undefined ? '—'
  : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents) / 100);
export const centsText = (cents: string | null) => {
  if (cents === null) return '';
  const negative = cents.startsWith('-'), digits = cents.replace('-', '').padStart(3, '0');
  return `${negative ? '-' : ''}${Number(digits.slice(0, -2)).toLocaleString('pt-BR')},${digits.slice(-2)}`;
};
export const brDay = (value: string | null) => value === null ? '—' : value.split('-').reverse().join('/');

/** Baixa um arquivo já recebido, sem abrir outra janela. */
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Pacote do contador: o download devolve o arquivo compactado, não JSON. */
export async function downloadCutoverPackage(month: string, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const ports = erpPorts();
  if (!ports) throw new AdoptBlingFailure('forbidden', adoptionErrorMessage('BLING_ADOPTION_ADMIN_REQUIRED'));
  const base = ports.apiUrl.replace(/\/$/, '');
  const path = BLING_ADOPTION_OPERATIONS.erp_bling_cutover_package_download.path;
  let response: Response;
  try {
    response = await ports.fetch(`${base}/v1/receber-bling${path}?${new URLSearchParams({ month })}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AdoptBlingFailure('network', 'Não conseguimos falar com o servidor. Confira a conexão e tente de novo.');
  }
  if (!response.ok) {
    let detail = '';
    try { const body = await response.json() as { error?: { message?: string; detail?: string } }; detail = [body.error?.message, body.error?.detail].filter(Boolean).join(' '); } catch { /* sem corpo */ }
    throw new AdoptBlingFailure(String(response.status), detail || 'O pacote não pôde ser baixado agora. Atualize a tela e tente de novo.');
  }
  return { blob: await response.blob(), filename: `contador-bling-${month}.zip` };
}
