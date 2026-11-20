import {
  BLING_ADOPTION_ERROR_CODES, BLING_ADOPTION_OPERATIONS, adoptionErrorMessage, adoptionOutputs, parseAdoptionInput,
  type BlingAdoptionErrorCode, type BlingAdoptionOperationMap, type BlingAdoptionOperationName,
} from '../../../../src/erp/bling/adoption-contracts.ts';
import { erpPorts } from '../../ports.ts';
import type { AccessController } from '../lib/real-access.ts';

/** Cliente das operações de adoção do Bling: só os nomes do contrato, na área da sessão. */
export interface AdoptBlingClient {
  execute<K extends BlingAdoptionOperationName>(name: K, input: BlingAdoptionOperationMap[K]['input'], signal?: AbortSignal): Promise<BlingAdoptionOperationMap[K]['output']>;
}

/** Falha mostrada na tela: o que aconteceu e o que fazer. */
export class AdoptBlingFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'AdoptBlingFailure'; }
}
const offline = () => new AdoptBlingFailure('network', 'Não conseguimos falar com o servidor. Confira a conexão e tente de novo.');

export function createAdoptBlingClient(options: { apiUrl: string; fetch: typeof fetch }): AdoptBlingClient {
  const base = options.apiUrl.replace(/\/$/, '');
  if (!/^\/api\/v1\/profiles\/[A-Za-z0-9_%.-]+\/erp$/.test(base)) throw new AdoptBlingFailure('invalid', 'Endereço da área inválido. Recarregue a página.');
  return {
    async execute(name, input, signal) {
      const definition = BLING_ADOPTION_OPERATIONS[name];
      if (!definition) throw new AdoptBlingFailure('invalid', adoptionErrorMessage('BLING_ADOPTION_INVALID'));
      const selected = parseAdoptionInput(name, input) as Record<string, unknown>;
      const query = new URLSearchParams();
      if (definition.method === 'GET') for (const [key, value] of Object.entries(selected)) if (value !== undefined) query.set(key, String(value));
      let response: Response;
      try {
        response = await options.fetch(base + '/v1/receber-bling' + definition.path + (query.size ? '?' + query : ''), {
          method: definition.method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
          headers: { Accept: 'application/json', ...(definition.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(definition.method === 'POST' ? { body: JSON.stringify(selected) } : {}),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw offline();
      }
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* corpo ausente ou inválido */ }
      if (!response.ok) throw failureOf(response.status, payload);
      const parsed = adoptionOutputs[name].safeParse(payload);
      if (!parsed.success) throw new AdoptBlingFailure('invalid', 'A resposta do servidor veio num formato inesperado. Atualize a tela.');
      return parsed.data as BlingAdoptionOperationMap[typeof name]['output'];
    },
  };
}

function failureOf(status: number, payload: unknown): AdoptBlingFailure {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : body;
  const code = typeof error.code === 'string' ? error.code : '';
  const detail = typeof error.detail === 'string' ? error.detail : '';
  if ((BLING_ADOPTION_ERROR_CODES as readonly string[]).includes(code))
    return new AdoptBlingFailure(code, [adoptionErrorMessage(code as BlingAdoptionErrorCode), detail].filter(Boolean).join(' '));
  if (code === 'module_disabled' || code === 'BLING_DISABLED') return new AdoptBlingFailure(code, adoptionErrorMessage('BLING_ADOPTION_DISABLED'));
  if (status === 403) return new AdoptBlingFailure('forbidden', adoptionErrorMessage('BLING_ADOPTION_ADMIN_REQUIRED'));
  if (status === 503 && code === 'erp_backup_running') return new AdoptBlingFailure(code, 'Um backup da área está em andamento. Espere terminar e tente de novo.');
  return new AdoptBlingFailure(code || 'unknown', 'O servidor não concluiu o pedido. Atualize a tela e tente de novo; se continuar, avise o suporte.');
}

export function createPanelAdoptBlingClient(controller: AccessController): AdoptBlingClient {
  const ports = erpPorts(), state = controller.getSnapshot();
  if (!ports || state.phase !== 'ready' || !state.membership) throw new AdoptBlingFailure('forbidden', adoptionErrorMessage('BLING_ADOPTION_ADMIN_REQUIRED'));
  return createAdoptBlingClient({ apiUrl: ports.apiUrl, fetch: ports.fetch });
}

export function adoptionFailureText(error: unknown): string {
  return error instanceof AdoptBlingFailure ? error.message : 'O servidor não concluiu o pedido. Atualize a tela e tente de novo.';
}
