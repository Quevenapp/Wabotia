import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ERP_MAINTENANCE_ACTIONS, type ErpMaintenanceAction } from '../../../../src/erp/parts-requirements';
import { blockEnabled, REENABLED_AUTOMATION_NOTICE } from '../../blocks';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

export const MAINTENANCE_PATH = '/v1/sistema/manutencao-efeitos';
type Row = Record<string, unknown>;
type Origin = { type: string; id: string };
export interface MaintenanceView {
  origin: Origin;
  links: Record<string, Row[]>;
  operations: ErpMaintenanceAction[];
  blockers: { kind: string; count: number }[];
  origin_version?: number;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const ORIGINS: Record<string, string> = {
  sales_orders: 'Pedido de venda', sales_proposals: 'Proposta', service_orders: 'Ordem de serviço', purchase_orders: 'Pedido de compra',
  nfe: 'NF-e', nfce: 'NFC-e', receivables: 'Conta a receber', payables: 'Conta a pagar', pos_sale: 'Venda do PDV',
  grouped_billing: 'Faturamento agrupado', remittance: 'Remessa', return_file: 'Retorno bancário',
};
const LABELS: Partial<Record<ErpMaintenanceAction, string>> = {
  document_stock_reverse: 'Estornar estoque do documento', document_finance_reverse: 'Estornar financeiro do documento',
  invoice_stock_reverse: 'Estornar estoque da nota', invoice_finance_reverse: 'Estornar financeiro da nota',
  reservation_release: 'Liberar reserva', purchase_receipt_reverse: 'Estornar recebimento', grouped_billing_delete: 'Desfazer faturamento agrupado',
  settlement_reverse: 'Estornar baixa', remittance_exclude: 'Excluir remessa', return_exclude: 'Excluir retorno', pos_sale_cancel: 'Cancelar venda do PDV',
};
const FAMILIES: Record<string, string> = { stock: 'Estoque', finance: 'Financeiro', reservations: 'Reservas', receipts: 'Recebimentos',
  grouped_billing: 'Faturamentos agrupados', settlements: 'Baixas', billing: 'Cobrança bancária' };
export function readMaintenance(value: unknown, origin: Origin): MaintenanceView {
  if (!object(value) || !object(value.origin) || value.origin.type !== origin.type || value.origin.id !== origin.id ||
    !object(value.links) || Object.values(value.links).some(rows => !Array.isArray(rows) || rows.some(row => !object(row))) ||
    !Array.isArray(value.operations) || value.operations.some(action => typeof action !== 'string' || !Object.hasOwn(ERP_MAINTENANCE_ACTIONS, action)) ||
    !Array.isArray(value.blockers) || value.blockers.some(item => !object(item) || typeof item.kind !== 'string' || !Number.isSafeInteger(item.count) || Number(item.count) < 0))
    throw new Error('Não foi possível conferir os vínculos históricos.');
  return value as unknown as MaintenanceView;
}
export type MaintenanceChoice = { action: ErpMaintenanceAction; target: Row; label: string };
export function maintenanceChoices(view: MaintenanceView): MaintenanceChoice[] {
  const family: Partial<Record<ErpMaintenanceAction, string>> = {
    document_stock_reverse: 'stock', document_finance_reverse: 'finance', invoice_stock_reverse: 'stock', invoice_finance_reverse: 'finance',
    reservation_release: 'reservations', purchase_receipt_reverse: 'receipts', settlement_reverse: 'settlements',
  };
  return view.operations.flatMap(action => {
    const label = LABELS[action]; if (!label) return [];
    const targets = family[action] ? view.links[family[action]!] ?? [] : [{ id: view.origin.id, version: view.origin_version }];
    return targets.filter(target => uuid(target.id) && (target.state === undefined || target.state === 'active') &&
      (action !== 'settlement_reverse' || target.kind === 'payment')).map(target => ({ action, target, label }));
  });
}

/** Somente argumentos das operações originais. Nenhum RPC ou argumento livre vem do formulário. */
export function maintenanceArgs(view: MaintenanceView, choice: MaintenanceChoice, input: { reason: string; day: string; originVersion?: number }, preview?: Row): Row {
  if (!view.operations.includes(choice.action) || !maintenanceChoices(view).some(item => item.action === choice.action && item.target.id === choice.target.id))
    throw new Error('A operação não está liberada para este vínculo. Atualize a consulta.');
  if (input.reason.trim().length < 3 || input.reason.length > 500) throw new Error('Informe um motivo de 3 a 500 caracteres.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new Error('Informe a data do estorno.');
  const action = choice.action, target = choice.target, origin = view.origin;
  const requireVersion = (value: unknown) => { if (!version(value)) throw new Error('A consulta não informou a versão atual necessária. Abra a manutenção pelo registro atualizado.'); return value; };
  const args: Row = {};
  if (action.startsWith('document_') || action === 'reservation_release' || action === 'purchase_receipt_reverse') {
    args.p_document_id = origin.id; args.p_expected_version = requireVersion(view.origin_version ?? input.originVersion);
    if (action.startsWith('document_')) args.p_kind = origin.type;
  }
  if (action.startsWith('document_') || action === 'invoice_stock_reverse') {
    args.p_posting_id = target.id; args.p_posting_version = requireVersion(target.version);
    if (action === 'invoice_stock_reverse') args.p_invoice_id = origin.id;
  }
  if (action === 'reservation_release') { args.p_reservation_id = target.id; args.p_reservation_version = requireVersion(target.version); args.p_ignored_item_ids = null; }
  if (action === 'purchase_receipt_reverse') { args.p_receipt_id = target.id; args.p_confirm = true; }
  if (['document_stock_reverse', 'reservation_release', 'purchase_receipt_reverse'].includes(action)) {
    args.p_occurred_on = input.day; args.p_reason = input.reason.trim();
  }
  if (action === 'document_finance_reverse') {
    args.p_reason = input.reason.trim();
    if (preview) {
      if (!Array.isArray(preview.titles) || preview.titles.some(item => !object(item) || !uuid(item.id) || !version(item.version))) throw new Error('A prévia não informou as versões dos títulos.');
      args.p_title_versions = preview.titles.map(item => ({ id: item.id, version: item.version }));
    }
  }
  if (action === 'invoice_finance_reverse') {
    const titles = target.titles;
    if (!Array.isArray(titles) || !titles.length || titles.some(item => !object(item) || !uuid(item.id) || !version(item.version)))
      throw new Error('A consulta não informou as versões atuais dos títulos da nota. A manutenção financeira não pode ser confirmada.');
    args.p_data = { invoice_id: origin.id, posting_id: target.id, expected_version: requireVersion(target.version), titles: titles.map(item => ({ id: item.id, version: item.version })), reason: input.reason.trim() };
  }
  if (action === 'settlement_reverse') args.p_data = { id: origin.id, expected_version: requireVersion(view.origin_version ?? input.originVersion), settlement_id: target.id, posted_on: input.day, note: input.reason.trim() };
  if (action === 'grouped_billing_delete') args.p_data = { id: origin.id, expected_version: requireVersion(view.origin_version ?? input.originVersion) };
  if (action === 'pos_sale_cancel') args.p_data = { sale_id: origin.id, expected_version: requireVersion(view.origin_version ?? input.originVersion), reason: input.reason.trim() };
  if (action === 'remittance_exclude') {
    if (typeof target.sequence !== 'string') throw new Error('A consulta não informou a sequência atual da remessa. A exclusão não pode ser confirmada.');
    args.p_data = { id: origin.id, sequence: target.sequence };
  }
  if (action === 'return_exclude') args.p_data = { id: origin.id };
  if (preview) { if (typeof preview.preview_hash !== 'string' || !/^[a-f0-9]{64}$/.test(preview.preview_hash)) throw new Error('Prévia inválida. Consulte novamente.'); args.p_preview_hash = preview.preview_hash; }
  return args;
}
type Prepared = { choice: MaintenanceChoice; args: Row; preview: Row | null; command: string; origin: Origin; uncertain: boolean };
export default function ErpEffectMaintenance({ controller }: { controller: AccessController }) {
  const location = useLocation(), query = new URLSearchParams(location.search);
  const [type, setType] = useState(query.get('tipo') ?? 'sales_orders'), [id, setId] = useState(query.get('id') ?? '');
  const [view, setView] = useState<MaintenanceView | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [reason, setReason] = useState(''), [day, setDay] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()));
  const [busy, setBusy] = useState(false), [prepared, setPrepared] = useState<Prepared | null>(null);
  const pending = useRef<AbortController | null>(null), alive = useRef(true);
  const guard = useUnsavedChanges(!!prepared, busy);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, [controller]);
  const execute = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || !blockEnabled('erp')) return;
    const request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try { await work(request.signal); }
    catch (failure) { if (alive.current && !request.signal.aborted) setError(failure instanceof AccessError ? failure.status === 403 ? 'Seu acesso original não permite esta operação.' : failure.status === 409 ? 'Existe um impedimento ou uma versão mudou. Consulte novamente antes de confirmar.' : 'Não foi possível concluir a consulta ou operação.' : failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.'); }
    finally { if (pending.current === request) { pending.current = null; if (alive.current) setBusy(false); } }
  };
  const inspect = () => {
    if (!Object.hasOwn(ORIGINS, type) || !uuid(id)) { setError('Selecione a origem e informe um identificador válido.'); return; }
    void execute(async signal => {
      setView(null); setPrepared(null); setNotice(''); const origin = { type, id: id.toLowerCase() };
      const result = readMaintenance(await controller.maintenance(`${MAINTENANCE_PATH}?${new URLSearchParams({ type, id: origin.id })}`, { signal }), origin);
      if (!signal.aborted && alive.current) setView(result);
    });
  };
  const review = (choice: MaintenanceChoice) => void execute(async signal => {
    if (!view) return;
    const input = { reason, day, originVersion: query.get('id') === view.origin.id ? Number(query.get('versao')) : undefined };
    const args = maintenanceArgs(view, choice, input);
    const previewAction = `${choice.action}_preview` as ErpMaintenanceAction;
    let preview: Row | null = null;
    if (Object.hasOwn(ERP_MAINTENANCE_ACTIONS, previewAction)) {
      if (!view.operations.includes(previewAction)) throw new Error('A prévia desta operação não está liberada.');
      const response = await controller.maintenance(MAINTENANCE_PATH, { method: 'POST', body: { origin: view.origin, action: previewAction, args }, signal });
      if (!object(response) || !object(response.preview)) throw new Error('A prévia não pôde ser conferida.');
      preview = response.preview;
      if (Array.isArray(preview.blockers) && preview.blockers.length) throw new Error('A prévia informou impedimentos. Resolva os vínculos e consulte novamente.');
    }
    if (signal.aborted || !alive.current) return;
    setPrepared({ choice, args: preview ? maintenanceArgs(view, choice, input, preview) : args, preview, origin: { ...view.origin }, command: crypto.randomUUID(), uncertain: false });
  });
  const confirm = () => {
    const command = prepared; if (!command) return;
    void execute(async signal => {
      // A captura é mantida byte a byte após resultado incerto, mesmo se as partes forem religadas.
      try {
        const result = await controller.maintenance(MAINTENANCE_PATH, { method: 'POST', signal,
          body: { origin: command.origin, action: command.choice.action, args: { ...command.args, p_command_id: command.command } } });
        if (signal.aborted || !alive.current) return;
        if (!object(result) || result.error || result.data_mode !== 'erp_native' || typeof result.replayed !== 'boolean') throw new Error('Recibo não confirmado.');
        setPrepared(null); setView(null); setNotice(`Operação confirmada. Comando: ${command.command}. Consulte novamente os vínculos antes de outra operação.`);
      } catch (failure) {
        if (alive.current && !signal.aborted) setPrepared(failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status) && !command.uncertain ? null : { ...command, uncertain: true });
        throw failure;
      }
    });
  };
  const choices = view ? maintenanceChoices(view) : [];
  return <section className="real-editor"><h1>Manutenção de efeitos</h1>
    <p>Partes desligadas suspendem novas operações. Aqui você consulta e desfaz efeitos históricos com suas permissões originais. Resolva baixas, reservas e vínculos protegidos antes de cancelar a origem.</p>
    <p className="real-help">{REENABLED_AUTOMATION_NOTICE}</p>
    <fieldset disabled={busy || !!prepared}><legend>Consultar origem</legend><label>Tipo<select value={type} onChange={event => { setType(event.target.value); setView(null); }}>{Object.entries(ORIGINS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Identificador<input value={id} onChange={event => { setId(event.target.value); setView(null); }} /></label><button type="button" onClick={inspect}>Consultar vínculos</button></fieldset>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {view && <><h2>Vínculos históricos</h2>{Object.entries(view.links).map(([kind, rows]) => <section key={kind}><h3>{FAMILIES[kind] ?? 'Outros vínculos'}</h3>
      <ul>{rows.map((row, index) => <li key={String(row.id ?? index)}>{String(row.id ?? row.billing_id ?? 'Vínculo registrado')}{row.state === 'active' ? ' · ativo' : row.state === 'reversed' ? ' · estornado' : ''}</li>)}</ul></section>)}
      <h2>Impedimentos a resolver</h2><ul>{view.blockers.map(item => <li key={item.kind}>{FAMILIES[item.kind] ?? 'Vínculos'}: {item.count}</li>)}</ul>
      {!view.blockers.length && <p>Nenhum vínculo bloqueador informado nesta consulta. A operação revalida versões e saldo.</p>}
      <fieldset disabled={busy || !!prepared}><legend>Preparar operação</legend><label>Motivo<textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label><label>Data<input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
        {choices.map(choice => <p key={`${choice.action}:${choice.target.id}`}><button type="button" onClick={() => review(choice)}>{choice.label}</button> · {String(choice.target.id)}</p>)}</fieldset>
      {!choices.length && <p>Nenhuma operação reversa foi liberada para seu acesso nesta origem.</p>}</>}
    {prepared && <section aria-label="Confirmar operação"><h2>{prepared.choice.label}</h2><p>Origem: {ORIGINS[prepared.origin.type]} · {prepared.origin.id}</p><p>Vínculo: {String(prepared.choice.target.id)}</p><p>Motivo: {reason} · Data: {day}</p>
      {prepared.preview && <PreviewRows preview={prepared.preview} />}
      <p>A confirmação desfaz o efeito selecionado. As demais operações continuam protegidas por suas regras originais.</p>
      <button type="button" disabled={busy} onClick={confirm}>{prepared.uncertain ? 'Conferir resultado do mesmo comando' : 'Confirmar esta operação'}</button>
      {!prepared.uncertain && <button type="button" disabled={busy} onClick={() => guard.confirmLeave(() => setPrepared(null))}>Voltar à revisão</button>}
    </section>}
  </section>;
}
function PreviewRows({ preview }: { preview: Row }) {
  const rows = Array.isArray(preview.positions) ? preview.positions : Array.isArray(preview.titles) ? preview.titles : [];
  return <><h3>Prévia conferida</h3><ul>{rows.filter(object).map((row, index) => <li key={String(row.id ?? row.product_id ?? index)}>
    {String(row.product_name ?? row.name ?? row.id ?? row.product_id ?? 'Item')}
    {row.quantity !== undefined && <> · Quantidade: {String(row.quantity)}</>}
    {row.balance_before !== undefined && <> · Saldo anterior: {String(row.balance_before)}</>}
    {row.balance_after !== undefined && <> · Saldo após estorno: {String(row.balance_after)}</>}
    {row.amount !== undefined && <> · Valor: {String(row.amount)}</>}
  </li>)}</ul></>;
}
