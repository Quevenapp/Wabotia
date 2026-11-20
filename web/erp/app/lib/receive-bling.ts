import {
  BLING_ERROR_CODES, BlingError,
  type BlingEntity, type BlingErrorCode, type BlingFailure, type BlingGlobalState,
  type BlingOperationMap, type BlingOperationName, type BlingReceipt, type ResourceDescriptor,
} from '../../../../src/erp/bling/contracts.ts';
import { BLING_OPERATIONS, parseBlingOperationInput } from '../../../../src/erp/bling/schema.ts';
import { erpPorts } from '../../ports.ts';
import { requirementEnabled } from '../../blocks.ts';
import type { AccessController } from './real-access.ts';

export type ReceiveBlingOperation = Exclude<BlingOperationName, 'erp_bling_oauth_callback'>;
export type BlingCommandOperation = {
  [K in ReceiveBlingOperation]: BlingOperationMap[K]['input'] extends { command_id: string } ? K : never
}[ReceiveBlingOperation];
export interface ReceiveBlingClient {
  execute<K extends ReceiveBlingOperation>(name: K, input: BlingOperationMap[K]['input'], signal?: AbortSignal): Promise<BlingOperationMap[K]['output']>;
  /** Revalida inclusive um resultado já confirmado em memória, sem fazer I/O. */
  assertAccess?(name: ReceiveBlingOperation): void;
  /** Invalida respostas atrasadas; a criação do cliente não assina eventos. */
  dispose?(): void;
  journal?: BlingCommandJournal;
}
export interface BlingPendingCommand { operation: BlingCommandOperation; command_id: string; expected_revision: string }
export interface BlingCommandJournal { read(): BlingPendingCommand | null; write(value: BlingPendingCommand | null): void }

/** Só uma recusa anterior ao despacho comprova ausência de efeito sem consultar recibo. */
class BlingRequestError extends BlingError {
  readonly definitive: boolean;
  constructor(code: BlingErrorCode, definitive = false, retry_at?: number) {
    super(code, { retry_at }); this.definitive = definitive;
  }
}
const invalid = () => new BlingRequestError('BLING_RESPONSE_INVALID');
const cancelled = () => new DOMException('Operação cancelada.', 'AbortError');
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export function safeBlingFailure(error: unknown): BlingFailure {
  if (error && typeof error === 'object') {
    const fields = Object.getOwnPropertyDescriptors(error);
    const code: unknown = fields.code?.value, retry: unknown = fields.retry_at?.value;
    if (typeof code === 'string' && (BLING_ERROR_CODES as readonly string[]).includes(code))
      return new BlingError(code as BlingErrorCode, { retry_at: typeof retry === 'number' ? retry : undefined }).toJSON();
  }
  return new BlingError('BLING_RETRY_WAIT').toJSON();
}

async function boundedBytes(response: Response, limit: number, check: () => void): Promise<Uint8Array> {
  const length = response.headers.get('Content-Length');
  if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    try { await response.body?.cancel(); } catch { /* Nunca registrar conteúdo recebido. */ }
    throw invalid();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      check(); const result = await reader.read(); check();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw invalid();
      chunks.push(result.value);
    }
    if (length !== null && Number(length) !== size) throw invalid();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { try { await reader.cancel(); } catch { /* Sem exceção remota na tela. */ } reader.releaseLock(); }
}
async function digest(value: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
  return Array.from(new Uint8Array(hash), item => item.toString(16).padStart(2, '0')).join('');
}
export async function checklistHash(value: unknown): Promise<string> {
  return digest(new TextEncoder().encode(JSON.stringify(value)));
}
function publicCallback(value: string, area: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/api/public/erp-bling/' + area + '/callback';
  } catch { return false; }
}
function authorizationUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch { return false; }
}

export function createReceiveBlingClient(options: {
  apiUrl: string; fetch: typeof fetch;
  assertAccess?: (name: ReceiveBlingOperation) => void;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
}): ReceiveBlingClient {
  // Apenas um endereço de área da aplicação. Nenhum endpoint remoto é aceito.
  const base = options.apiUrl.replace(/\/$/, '');
  if (!/^\/api\/v1\/profiles\/[A-Za-z0-9_%.-]+\/erp$/.test(base)) throw invalid();
  const assertAccess = (name: ReceiveBlingOperation) => {
    if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled();
    options.assertAccess?.(name);
  };
  return {
    assertAccess,
    async execute<K extends ReceiveBlingOperation>(name: K, input: BlingOperationMap[K]['input'], signal?: AbortSignal): Promise<BlingOperationMap[K]['output']> {
      if (!Object.hasOwn(BLING_OPERATIONS, name) || name as string === 'erp_bling_oauth_callback') throw invalid();
      const definition = BLING_OPERATIONS[name];
      const selected = parseBlingOperationInput(name, input) as Record<string, unknown>;
      const combined = AbortSignal.any([...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
      const check = () => {
        if (combined.aborted) throw cancelled();
        assertAccess(name);
      };
      let path: string = definition.path === '/' ? '' : definition.path;
      const query = new URLSearchParams();
      if (definition.method === 'GET') {
        for (const [key, value] of Object.entries(selected)) {
          const placeholder = ':' + (key === 'object_id' ? 'objectId' : key);
          if (path.includes(placeholder)) path = path.replace(placeholder, encodeURIComponent(String(value)));
          else if (value !== undefined) query.set(key, String(value));
        }
      }
      if (path.includes(':')) throw invalid();
      const url = base + '/v1/receber-bling' + path + (query.size ? '?' + query.toString() : '');
      let received: Response | undefined, dispatched = false;
      try {
        check();
        dispatched = true;
        const response = await options.fetch(url, {
          method: definition.method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: combined,
          headers: { Accept: name === 'erp_bling_xml_get' ? 'application/xml' : 'application/json',
            ...(definition.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            ...(typeof selected.command_id === 'string' ? { 'Idempotency-Key': selected.command_id } : {}),
          },
          ...(definition.method === 'POST' ? { body: JSON.stringify(selected) } : {}),
        });
        received = response;
        check();
        if (!response.ok) {
          let code: BlingErrorCode = response.status === 403 ? 'BLING_ADMIN_REQUIRED' : 'BLING_RETRY_WAIT';
          let retryAt: number | undefined;
          try {
            const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response, 8192, check)));
            if (payload && typeof payload.error === 'object') {
              if (BLING_ERROR_CODES.includes(payload.error.code)) code = payload.error.code;
              if (Number.isSafeInteger(payload.error.retry_at) && payload.error.retry_at >= 0) retryAt = payload.error.retry_at;
            }
          } catch (error) { if (isAbort(error)) throw error; }
          check();
          // Uma recusa após o despacho não é um recibo terminal. Pode seguir uma
          // mudança de permissão ou uma resposta perdida: conservar o comando.
          throw new BlingRequestError(code, false, retryAt);
        }
        const xml = name === 'erp_bling_xml_get';
        const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
        if (mime !== (xml ? 'application/xml' : 'application/json')) throw invalid();
        const bytes = await boundedBytes(response, xml ? 16 * 1024 * 1024 : 24 * 1024 * 1024, check);
        let value: unknown;
        if (xml) {
          const sha256 = response.headers.get('X-Content-SHA256');
          const disposition = response.headers.get('Content-Disposition') ?? '';
          const filename = /^attachment;\s*filename="([A-Za-z0-9_.-]+\.xml)"$/i.exec(disposition)?.[1];
          if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256) || !filename || filename.includes('..') || await digest(bytes) !== sha256) throw invalid();
          check(); value = { bytes, sha256, filename, content_type: 'application/xml' };
        } else {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          // A configuração do aplicativo é write-only, inclusive em uma resposta corrompida.
          if (name === 'erp_bling_app_save' && [selected.client_id, selected.client_secret].some(secret => typeof secret === 'string' && text.includes(secret))) throw invalid();
          value = JSON.parse(text);
        }
        const parsed = definition.output.safeParse(value);
        if (!parsed.success) throw invalid();
        if (name === 'erp_bling_app_save' && !publicCallback((parsed.data as BlingOperationMap['erp_bling_app_save']['output']).callback_url, base.split('/')[4])) throw invalid();
        if (name === 'erp_bling_status') {
          const callback = (parsed.data as BlingOperationMap['erp_bling_status']['output']).callback_url;
          if (callback && !publicCallback(callback, base.split('/')[4])) throw invalid();
        }
        if (name === 'erp_bling_oauth_start' && !authorizationUrl((parsed.data as BlingOperationMap['erp_bling_oauth_start']['output']).authorization_url)) throw invalid();
        check(); return parsed.data as BlingOperationMap[K]['output'];
      } catch (error) {
        if (combined.aborted || options.isCurrent?.() === false || isAbort(error)) throw cancelled();
        if (error instanceof BlingError) throw new BlingRequestError(error.code, !dispatched, error.retry_at);
        throw new BlingRequestError('BLING_RETRY_WAIT');
      } finally { try { await received?.body?.cancel(); } catch { /* O leitor pode já ter sido encerrado. */ } }
    },
  };
}

function storedCommand(value: unknown): BlingPendingCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'command_id,expected_revision,operation' || typeof row.operation !== 'string' || !Object.hasOwn(BLING_OPERATIONS, row.operation)) return null;
  const definition = BLING_OPERATIONS[row.operation as BlingOperationName];
  if (definition.method !== 'POST' || row.operation === 'erp_bling_purge_preview' || typeof row.command_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.command_id) || typeof row.expected_revision !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(row.expected_revision)) return null;
  return { operation: row.operation as BlingCommandOperation, command_id: row.command_id, expected_revision: row.expected_revision };
}
function sessionJournal(key: string): BlingCommandJournal {
  return {
    read() { try { return storedCommand(JSON.parse(sessionStorage.getItem(key) ?? 'null')); } catch { return null; } },
    write(value) { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Memória conserva a trava se o navegador bloquear armazenamento. */ } },
  };
}

export function createPanelBlingClient(controller: AccessController): ReceiveBlingClient {
  const ports = erpPorts(), initial = controller.getSnapshot();
  if (!ports || initial.phase !== 'ready' || !initial.membership) throw new BlingError('BLING_ADMIN_REQUIRED');
  const user = initial.membership.user_id, role = initial.membership.role;
  const lifetime = new AbortController();
  const isCurrent = () => {
    const state = controller.getSnapshot();
    return !lifetime.signal.aborted && erpPorts() === ports && state.phase === 'ready' && state.membership?.user_id === user && state.membership.role === role;
  };
  const client = createReceiveBlingClient({ apiUrl: ports.apiUrl, fetch: ports.fetch, signal: lifetime.signal, isCurrent,
    assertAccess(name) {
      const state = controller.getSnapshot();
      if (state.phase !== 'ready' || state.membership?.user_id !== user || state.membership.role !== role) throw cancelled();
      if (!requirementEnabled({ all: ['erp'] })) throw new BlingError('BLING_DISABLED');
      if (BLING_OPERATIONS[name].permission === 'admin' && state.membership.role !== 'admin') throw new BlingError('BLING_ADMIN_REQUIRED');
    },
  });
  const execute = client.execute;
  client.execute = async <K extends ReceiveBlingOperation>(name: K, input: BlingOperationMap[K]['input'], signal?: AbortSignal) => {
    // React pode descartar uma renderização: a assinatura só existe enquanto
    // há I/O, e cada chamada a retira no seu próprio finally.
    const unsubscribe = controller.subscribe(() => { if (!isCurrent()) lifetime.abort(); });
    try { return await execute(name, input, signal); }
    finally { unsubscribe(); }
  };
  client.dispose = () => { lifetime.abort(); };
  client.journal = sessionJournal('receive-bling:' + ports.apiUrl + ':' + user);
  return client;
}

/** O journal contém somente identidade de comando. Nunca conserva corpo, aplicativo ou autorização. */
export class BlingCommandSession {
  private current: BlingPendingCommand | null;
  private flight: { id: string; body: string; promise: Promise<unknown> } | null = null;
  private completed: { id: string; operation: BlingCommandOperation; hash: string; value: unknown } | null = null;
  private readonly client: ReceiveBlingClient;
  private readonly journal?: BlingCommandJournal;
  constructor(client: ReceiveBlingClient, journal: BlingCommandJournal | undefined = client.journal) {
    this.client = client; this.journal = journal; this.current = storedCommand(journal?.read());
  }
  get pending(): BlingPendingCommand | null { return this.current ? { ...this.current } : null; }
  private setPending(value: BlingPendingCommand | null) { this.current = value; this.journal?.write(value); }
  run<K extends BlingCommandOperation>(name: K, input: BlingOperationMap[K]['input'], signal?: AbortSignal): Promise<BlingOperationMap[K]['output']> {
    let selected: BlingOperationMap[K]['input'];
    if (!Object.hasOwn(BLING_OPERATIONS, name) || BLING_OPERATIONS[name].method !== 'POST' || ['erp_bling_purge_preview', 'erp_bling_oauth_callback'].includes(name)) return Promise.reject(invalid());
    try {
      if (signal?.aborted) throw cancelled();
      this.client.assertAccess?.(name);
      selected = parseBlingOperationInput(name, input);
    } catch (error) { return Promise.reject(error); }
    const body = JSON.stringify(selected);
    if (this.flight) return this.flight.id === selected.command_id && this.current?.operation === name && this.flight.body === body
      ? this.flight.promise as Promise<BlingOperationMap[K]['output']> : Promise.reject(new BlingError('BLING_COMMAND_CONFLICT'));
    if (this.completed?.id === selected.command_id) {
      const result = this.completed;
      return checklistHash(selected).then(hash => {
        if (signal?.aborted) throw cancelled();
        this.client.assertAccess?.(name);
        if (result.operation !== name || result.hash !== hash) throw new BlingError('BLING_COMMAND_CONFLICT');
        return structuredClone(result.value) as BlingOperationMap[K]['output'];
      });
    }
    if (this.current) return Promise.reject(new BlingError('BLING_COMMAND_CONFLICT'));
    this.setPending({ operation: name, command_id: selected.command_id, expected_revision: selected.expected_revision });
    const promise = Promise.resolve().then(async () => {
      let dispatched = false;
      try {
        const hash = await checklistHash(selected);
        if (signal?.aborted) throw cancelled();
        this.client.assertAccess?.(name);
        dispatched = true;
        const value = await this.client.execute(name, selected, signal);
        const receipt = 'receipt' in value ? value.receipt : undefined;
        if (receipt && (receipt.command_id !== selected.command_id || receipt.operation !== name)) throw invalid();
        if (receipt || name === 'erp_bling_oauth_start') {
          this.completed = { id: selected.command_id, operation: name, hash, value: structuredClone(value) }; this.setPending(null);
        }
        return value;
      } catch (error) {
        if (!dispatched || error instanceof BlingRequestError && error.definitive) this.setPending(null);
        throw error;
      } finally { this.flight = null; }
    });
    this.flight = { id: selected.command_id, body, promise };
    return promise;
  }
  async resume(signal?: AbortSignal): Promise<BlingOperationMap['erp_bling_command_get']['output']> {
    if (!this.current) throw new BlingError('BLING_COMMAND_CONFLICT');
    if (this.flight) throw new BlingError('BLING_RETRY_WAIT');
    const pending = this.current;
    const value = await this.client.execute('erp_bling_command_get', { id: pending.command_id }, signal);
    const receipt: BlingReceipt | null = value.receipt;
    if (receipt) {
      if (receipt.command_id !== pending.command_id || receipt.operation !== pending.operation) throw invalid();
      if (this.current?.command_id === pending.command_id) this.setPending(null);
    }
    return value;
  }
}

export const ENTITY_LABELS: Record<BlingEntity, string> = {
  contacts: 'Contatos', products: 'Produtos', sales_orders: 'Pedidos de venda', sales_proposals: 'Propostas comerciais', purchase_orders: 'Pedidos de compra', receivables: 'Contas a receber', payables: 'Contas a pagar', nfe: 'NF-e', nfce: 'NFC-e', payment_methods: 'Formas de pagamento', sellers: 'Vendedores', service_orders: 'Ordens de serviço', warehouses: 'Depósitos', product_categories: 'Categorias de produtos', financial_categories: 'Categorias financeiras', ledger_accounts: 'Contas contábeis', cash_entries: 'Lançamentos de caixa', stock_balances: 'Saldos de estoque', contracts: 'Contratos', production_orders: 'Ordens de produção', price_lists: 'Listas de preços', operation_natures: 'Naturezas de operação', custom_fields: 'Campos personalizados', bordereaux: 'Borderôs', service_invoices: 'NFS-e', product_structures: 'Estruturas de produtos', product_suppliers: 'Fornecedores de produtos', product_lots: 'Lotes de produtos', product_lot_movements: 'Movimentos de lotes', product_variations: 'Variações de produtos', product_groups: 'Grupos de produtos', contact_types: 'Tipos de contato', statuses: 'Situações', status_modules: 'Módulos de situações', status_transitions: 'Transições de situações', logistics: 'Logísticas', logistics_services: 'Serviços logísticos', logistics_objects: 'Objetos logísticos', logistics_shipments: 'Remessas logísticas', companies: 'Empresas', users: 'Usuários',
};
export const STATE_LABELS: Record<BlingGlobalState, string> = { off: 'Desligado', needs_authorization: 'Aguardando autorização', ready: 'Pronto para receber', running: 'Recebendo dados', waiting_rate: 'Aguardando limite de chamadas', waiting_retry: 'Aguardando nova tentativa', blocked_scope: 'Bloqueado por escopo', blocked_capacity: 'Parado por falta de espaço', purging: 'Apagamento em andamento' };
export function resourceSelectable(resource: ResourceDescriptor): boolean {
  return resource.confirmation === 'oficial_confirmado' && !!resource.path && !!resource.pagination && !!resource.dateFilter && !!resource.parser && resource.identityRule.kind !== 'unconfirmed' && !!resource.officialEvidence?.scopes_checked && resource.officialEvidence.identity_checked && resource.officialEvidence.limits_checked;
}
export function dateMeaning(resource: ResourceDescriptor): string {
  const meanings = {
    M: 'Data de alteração, com hora.', D: 'Período de data inicial e final; não comprova a data de alteração.', E: 'Data de emissão, sem hora; títulos antigos podem exigir recaptura.', EH: 'Data de emissão, com hora.', U: 'Sem filtro temporal: a data escolhida não limita este recurso.',
  };
  return resource.dateFilter ? meanings[resource.dateFilter.kind] + ' Fuso de São Paulo; varreduras contínuas e sobreposição de quinze minutos.' : 'Filtro de datas a conferir na referência oficial.';
}
export const BLING_CHECKLIST = [
  'Registrei meu próprio aplicativo no Bling e o retorno HTTPS exatamente igual ao mostrado.',
  'Conferi a referência oficial, os escopos de leitura e os limites de cada recurso selecionado.',
  'Conferi a empresa vinculada à área e o mecanismo oficial de identificação da conta.',
  'Entendi a seleção, as datas, os recursos sem filtro temporal e as varreduras contínuas.',
  'Entendi que a API da empresa receberá chamadas, a coleta pode durar dias e pode conter lacunas.',
  'Conferi espaço e armazenamento de XML: aviso em 70% e parada preventiva em 80%, ou antes pela projeção.',
  'Entendi bruto e espelho histórico; a adoção operacional será uma etapa futura.',
  'Entendi que não serão criados cadastros, títulos, pedidos, saldos, notas ou efeitos operacionais.',
  'Revisei as permissões de consulta e IA; o acesso de bots e a entrega ao cliente começam desligados.',
  'Entendi a diferença entre desligar, desconectar e revogar no Bling, e apagar o acervo após uma prévia.',
] as const;
