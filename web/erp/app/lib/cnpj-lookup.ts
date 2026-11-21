// Consulta de CNPJ para o cadastro de contato: /api/v1/profiles/<área>/erp-cnpj/<cnpj> (src/erp/cnpj/routes.ts).
// O servidor consulta as bases públicas da Receita; aqui só se pede e se mapeia para os campos do formulário.
import { erpPorts } from '../../ports.ts';

export interface CnpjData {
  cnpj: string; razao_social: string | null; nome_fantasia: string | null; situacao: string | null; ativa: boolean | null; abertura: string | null;
  cep: string | null; uf: string | null; cidade: string | null; bairro: string | null; endereco: string | null; numero: string | null; complemento: string | null;
  telefone: string | null; email: string | null; inscricao_estadual: string | null; simples: boolean | null; mei: boolean | null; atividade: string | null;
}

export class CnpjLookupError extends Error {}

export function cnpjLookupBase(): string | null {
  const ports = erpPorts();
  if (!ports?.embedded || ports.demo || !/\/erp$/.test(ports.apiUrl)) return null;
  return ports.apiUrl.replace(/\/erp$/, '/erp-cnpj');
}

export const cnpjDigits = (value: string) => value.replace(/[.\-/\s]/g, '').toUpperCase();

/** CNPJ só de números com os dígitos verificadores certos (o com letras ainda não está nas bases públicas). */
export function searchableCnpj(value: string): boolean {
  const d = cnpjDigits(value);
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const n = [...d].map(Number);
  const dv = (len: number) => { const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = w.reduce((sum, x, i) => sum + n[i]! * x, 0) % 11; return s < 2 ? 0 : 11 - s; };
  return dv(12) === n[12] && dv(13) === n[13];
}

export async function lookupCnpj(cnpj: string, signal?: AbortSignal): Promise<CnpjData> {
  const base = cnpjLookupBase();
  if (!base) throw new CnpjLookupError('A busca na Receita só funciona no painel da área.');
  let response: Response;
  try { response = await globalThis.fetch(`${base}/${encodeURIComponent(cnpjDigits(cnpj))}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new CnpjLookupError('Sem resposta do servidor. Confira a conexão e tente de novo.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as any;
    const error = body?.error ?? body ?? {};
    throw new CnpjLookupError(typeof error.message === 'string' ? error.message : `A busca na Receita falhou (${response.status}).`);
  }
  return await response.json() as CnpjData;
}

/** Valores do formulário a partir da Receita. `force`: sobrescreve; senão, só preenche o que está vazio. */
export function cnpjFormValues(data: CnpjData, current: Record<string, string>, force: boolean): Record<string, string> {
  const crt = data.mei ? '4' : data.simples === true ? '1' : data.simples === false ? '3' : '';
  const map: Record<string, string | null> = {
    person_type: 'J', name: data.razao_social, trade_name: data.nome_fantasia, postal_code: data.cep, state: data.uf, city: data.cidade,
    district: data.bairro, street: data.endereco, number: data.numero, complement: data.complemento, phone: data.telefone, email: data.email,
    crt: crt || null, ie: current.ie_exempt === 'true' ? null : data.inscricao_estadual,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!value) continue;
    if (force || !(current[key] ?? '').trim()) out[key] = value;
  }
  if (out.ie && !(current.taxpayer ?? '').trim()) out.taxpayer = '1';
  return out;
}
