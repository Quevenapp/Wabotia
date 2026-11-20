import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { BlingAccessPolicy, BlingEntity, BlingOperationMap, BlingPage, BlingPurgePreview, BlingPurgeScope, BlingRecordMetadata, BlingRecordView, BlingSelection, BlingStatus, BlingXmlSummary, ResourceDescriptor } from '../../../../src/erp/bling/contracts';
import { BlingError, type BlingReceipt } from '../../../../src/erp/bling/contracts';
import { BLING_CHECKLIST, ENTITY_LABELS, STATE_LABELS, BlingCommandSession, checklistHash, createPanelBlingClient, dateMeaning, resourceSelectable, safeBlingFailure, type ReceiveBlingClient } from '../lib/receive-bling';
import { receiveBlingCapability } from '../lib/integration-capabilities';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import './receive-bling.css';
import { AdoptBling } from './AdoptBling';
import { HistoryBling } from './HistoryBling';
import type { AdoptBlingClient } from './adopt-bling-client';
import type { BlingAdoptionB2Entity } from '../../../../src/erp/bling/adoption-contracts';

const TABS = ['Configuração', 'Progresso e cobertura', 'Acervo', 'Histórico fiscal', 'Adotar cadastros', 'Histórico do Bling'] as const;
const HISTORICAL = 'Consulta histórica — não opera no ERP';
const time = (value: string | number | null) => value === null || !Number.isFinite(new Date(value).getTime()) ? 'Desconhecido' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const bytes = (value: number) => `${new Intl.NumberFormat('pt-BR').format(value)} bytes`;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const resourceLabel = (resource: ResourceDescriptor) => resource.key === 'fiscal_xml' ? 'XML de NF-e/NFC-e' : ENTITY_LABELS[resource.entity];
type Resources = BlingOperationMap['erp_bling_resources']['output'];
type CommandName = { [K in keyof BlingOperationMap]: BlingOperationMap[K]['input'] extends { command_id: string } ? K : never }[keyof BlingOperationMap];
const receiptFailure = (receipt: BlingReceipt | null | undefined) => receipt?.state === 'rejected' ? new BlingError(receipt.error?.code ?? 'BLING_RESPONSE_INVALID') : receipt?.state === 'superseded' ? new BlingError('BLING_GENERATION_RETIRED') : null;

/** Apenas operações públicas do acervo; nenhum comando operacional é exposto aqui. */
export function ReceiveBling({ controller, administrator, client: injected, adoptionClient }: { controller: AccessController; administrator: boolean; client?: ReceiveBlingClient; adoptionClient?: AdoptBlingClient }) {
  const client = useMemo(() => injected ?? createPanelBlingClient(controller), [injected, controller]);
  const commands = useMemo(() => new BlingCommandSession(client), [client]);
  const [tab, setTab] = useState(0), [status, setStatus] = useState<BlingStatus | null>(null), [resources, setResources] = useState<Resources | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const alive = useRef(true), lock = useRef(false), life = useRef(new AbortController());
  const [selections, setSelections] = useState<BlingSelection[]>([]), [limit, setLimit] = useState(20000), [access, setAccess] = useState<BlingAccessPolicy | null>(null), [dirty, setDirty] = useState(false);
  const [checks, setChecks] = useState<boolean[]>(BLING_CHECKLIST.map(() => false)), [aiAck, setAiAck] = useState(false);
  const [appId, setAppId] = useState(''), [appSecret, setAppSecret] = useState(''), [callback, setCallback] = useState('');
  const [purgeScope, setPurgeScope] = useState('all'), [preview, setPreview] = useState<{ scope: BlingPurgeScope; data: BlingPurgePreview } | null>(null), [purgeConfirm, setPurgeConfirm] = useState(false), [purgeHash, setPurgeHash] = useState('');
  const [entity, setEntity] = useState<BlingEntity>('contacts'), [records, setRecords] = useState<BlingPage<BlingRecordMetadata> | null>(null), [record, setRecord] = useState<BlingRecordView | null>(null), [versions, setVersions] = useState<BlingPage<BlingRecordMetadata> | null>(null);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [deleted, setDeleted] = useState(false);
  const [xmlEntity, setXmlEntity] = useState<'' | 'nfe' | 'nfce'>(''), [xml, setXml] = useState<BlingPage<BlingXmlSummary> | null>(null);
  const [xmlFrom, setXmlFrom] = useState(''), [xmlTo, setXmlTo] = useState('');
  const [historyEntity, setHistoryEntity] = useState<BlingAdoptionB2Entity | undefined>(undefined);
  const guard = useUnsavedChanges(dirty || !!appId || !!appSecret, busy || !!commands.pending);
  const current = () => alive.current && !life.current.signal.aborted;
  const admin = () => administrator && controller.getSnapshot().phase === 'ready' && controller.getSnapshot().membership?.role === 'admin';
  const fail = (caught: unknown) => { if (current()) { const failure = safeBlingFailure(caught); setError(failure.message); if (failure.code === 'BLING_ADMIN_REQUIRED' || failure.code === 'BLING_SCOPE_REQUIRED') { setStatus(null); setRecords(null); setRecord(null); setVersions(null); setXml(null); } } };
  async function reload(reset = true) {
    const signal = life.current.signal;
    const [next, list] = await Promise.all([client.execute('erp_bling_status', {}, signal), client.execute('erp_bling_resources', {}, signal)]);
    if (!current() || signal.aborted || signal !== life.current.signal) return;
    setStatus(next); setResources(list); if (next.callback_url) setCallback(next.callback_url);
    if (reset) { setSelections(next.configuration.selections); setLimit(next.configuration.daily_call_limit); setAccess(structuredClone(next.configuration.access)); setDirty(false); setChecks(BLING_CHECKLIST.map(() => false)); setAiAck(false); }
    setPreview(null); setPurgeConfirm(false); setPurgeHash('');
  }
  useEffect(() => {
    alive.current = true; life.current = new AbortController();
    void reload().catch(fail).finally(() => { if (current()) setLoading(false); });
    return () => { alive.current = false; life.current.abort(); };
  }, [client]);
  async function task(action: () => Promise<void>) {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { fail(caught); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  /** Recusa terminal por revisão antiga: sem pendência, recarrega o estado atual e mostra o motivo. */
  async function stale(caught: unknown): Promise<never> {
    if (safeBlingFailure(caught).code === 'BLING_REVISION_CONFLICT' && !commands.pending && current()) await reload().catch(() => undefined);
    throw caught;
  }
  async function command<K extends CommandName>(name: K, input: Omit<BlingOperationMap[K]['input'], 'command_id' | 'expected_revision'>) {
    if (!admin() || !status || commands.pending) return;
    await task(async () => {
      const result = await commands.run(name, { ...input, command_id: crypto.randomUUID(), expected_revision: status.configuration.revision } as BlingOperationMap[K]['input'], life.current.signal).catch(stale);
      if (!current()) return;
      const refusal = receiptFailure('receipt' in result ? result.receipt : null);
      if (refusal) { await reload(); throw refusal; }
      if (name === 'erp_bling_app_save') setCallback((result as BlingOperationMap['erp_bling_app_save']['output']).callback_url);
      if (name === 'erp_bling_oauth_start') {
        const url = (result as BlingOperationMap['erp_bling_oauth_start']['output']).authorization_url;
        // O cliente valida o destino HTTPS retornado pelo servidor. Não há fetch ao provedor.
        window.location.assign(url); return;
      }
      if (name === 'erp_bling_disconnect') setNotice('Conta desconectada. Revogue também o acesso no aplicativo autorizado dentro do Bling. O acervo permanece.');
      else setNotice(name === 'erp_bling_purge_apply' ? 'Apagamento solicitado. Aguarde a conclusão verificada no servidor.' : 'Solicitação registrada. Confira o estado atualizado abaixo.');
      await reload(name !== 'erp_bling_app_save' || !dirty);
    });
  }
  const blocked = busy || !!commands.pending || !administrator;
  const purging = status?.state === 'purging';
  const configBlocked = blocked || purging || !receiveBlingCapability(status, 'configured');
  // Cadastrar o aplicativo é o passo que produz "configured": só exige o
  // estado carregado, sem operação pendente nem apagamento em curso.
  const appBlocked = blocked || purging || loading || !status;
  const selected = selections.filter(item => item.selected);
  const confirmed = selected.length > 0 && selected.every(item => resources?.resources.some(resource => resource.key === item.key && resourceSelectable(resource)));
  const editSelection = (resource: ResourceDescriptor, patch: Partial<BlingSelection>) => {
    if (configBlocked || !resourceSelectable(resource)) return;
    setSelections(previous => { const found = previous.find(item => item.key === resource.key); return [...previous.filter(item => item.key !== resource.key), { key: resource.key, selected: false, from: null, to: null, ...found, ...patch }]; });
    setDirty(true); setChecks(BLING_CHECKLIST.map(() => false));
  };
  const editAccess = (next: BlingAccessPolicy) => { if (!configBlocked) { setAccess(next); setDirty(true); setAiAck(false); } };
  const queryRecords = async (cursor?: string) => {
    if (!receiveBlingCapability(status, 'archive')) return;
    const page = await client.execute('erp_bling_records_list', { entity, limit: 50, ...(cursor ? { cursor } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(deleted ? { deleted: true } : {}) }, life.current.signal);
    if (current()) { setRecords(page); setRecord(null); setVersions(null); }
  };
  async function openRecord(row: BlingRecordMetadata, historical = false) {
    const [detail, history] = await Promise.all([
      client.execute('erp_bling_record_get', { entity: row.identity.entity, id: row.identity.source_id, ...(historical ? { version: row.version } : {}) }, life.current.signal),
      client.execute('erp_bling_versions_list', { entity: row.identity.entity, id: row.identity.source_id, limit: 50 }, life.current.signal),
    ]);
    if (current()) { setRecord(detail); setVersions(history); }
  }
  async function queryXml(cursor?: string) {
    if (!receiveBlingCapability(status, 'xml')) return;
    const page = await client.execute('erp_bling_xml_list', { ...(xmlEntity ? { entity: xmlEntity } : {}), ...(cursor ? { cursor } : {}), ...(xmlFrom ? { from: xmlFrom } : {}), ...(xmlTo ? { to: xmlTo } : {}), limit: 50 }, life.current.signal);
    if (current()) setXml(page);
  }
  function switchTab(index: number) {
    setTab(index); setError('');
    if (index === 2 && !records) void task(() => queryRecords());
    if (index === 3 && !xml) void task(() => queryXml());
  }
  const scope = (): BlingPurgeScope => purgeScope === 'all' ? { all: true, entities: [] } : { all: false, entities: [...new Set((resources?.resources ?? []).filter(r => selected.some(s => s.key === r.key)).map(r => r.entity))] };
  return <section className="receive-bling" aria-label="Receber dados do Bling" aria-busy={busy || loading}>
    <header className="rb-heading"><div><h1>Receber dados do Bling</h1><p>{HISTORICAL}</p></div><button type="button" disabled={busy || loading} onClick={() => guard.confirmLeave(() => void task(() => reload()))}>Atualizar dados</button></header>
    <p className="rb-intro">O bruto preserva os dados recebidos. O espelho apresenta uma interpretação histórica. Receber não cria cadastros, pedidos, títulos, saldos, notas ou efeitos no ERP e só consulta a API de dados. Transformar contatos, produtos e demais cadastros, e as propostas, pedidos e contas em aberto no Bling, em registros do ERP é uma etapa separada, com revisão, na aba Adotar cadastros. O que já está encerrado no Bling fica na aba Histórico do Bling, só para consulta.</p>
    <div role="status" aria-live="polite">{loading ? 'Carregando configuração…' : status ? `Estado: ${STATE_LABELS[status.state]}. Próximo horário: ${time(status.next_wake)}.` : 'Função indisponível nesta instalação. Nenhuma coleta foi iniciada.'}{notice && <p>{notice}</p>}</div>
    {error && <p role="alert">{error}</p>}
    {commands.pending && <aside className="rb-warning" role="status"><p>Há uma solicitação sem resultado confirmado. Consulte o recibo antes de qualquer novo comando.</p><p>Comando: <code>{commands.pending.command_id}</code></p><button type="button" disabled={busy} onClick={() => void task(async () => { const result = await commands.resume(life.current.signal); if (current()) { await reload(); const refusal = receiptFailure(result.receipt); if (refusal) throw refusal; setNotice(result.receipt ? 'Recibo consultado. Confira o estado atual.' : result.phase === 'absent' ? 'Nenhuma reserva ou recibo deste comando foi encontrado. Aguarde e consulte novamente; a solicitação não foi repetida.' : 'Solicitação ainda pendente; nenhum comando foi repetido.'); } })}>Consultar recibo e retomar</button></aside>}
    <nav role="tablist" aria-label="Receber dados do Bling">{TABS.map((label, index) => <button key={label} id={`bling-tab-${index}`} type="button" role="tab" aria-selected={tab === index} aria-controls={`bling-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => switchTab(index)} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null; if (next !== null) { event.preventDefault(); switchTab(next); document.getElementById(`bling-tab-${next}`)?.focus(); } }}>{label}</button>)}</nav>
    <section role="tabpanel" id={`bling-panel-${tab}`} aria-labelledby={`bling-tab-${tab}`} tabIndex={0}>
      {tab === 0 && <>
        {!administrator && <p>Os controles administrativos exigem um administrador. Sua permissão de consulta é conferida no servidor.</p>}
        <section className="rb-card"><h2>Aplicativo, retorno e empresa</h2>
          <p>Aplicativo: {status?.configuration.credential.configured ? 'Configurado; credenciais protegidas no cofre.' : 'Ainda não configurado.'} Conta: {status?.configuration.credential.authorized ? 'Autorizada' : 'Autorização necessária'}.</p>
          <p>Empresa vinculada: {status?.configuration.account?.name ?? 'A conferir'} · identificação: {status?.configuration.account?.id ?? 'A conferir'} · conferida em: {time(status?.configuration.account?.confirmed_at ?? null)}.</p>
          <p>Autorização válida até: {time(status?.configuration.credential.expires_at ?? null)}. {status?.configuration.credential.uncertain && 'Autorização incerta: autorize novamente.'}</p>
          <p>Escopos concedidos: {status?.configuration.credential.scopes.join(', ') || 'A conferir'}. Somente escopos de leitura devem ser aprovados nesta etapa.</p>
          <label htmlFor="bling-callback">Retorno HTTPS exato, confirmado pelo servidor</label><input id="bling-callback" readOnly value={callback} placeholder="Disponível ao salvar o aplicativo" />
          <button type="button" disabled={!callback} onClick={() => void task(async () => { await navigator.clipboard.writeText(callback); if (current()) setNotice('Endereço de retorno copiado.'); })}>Copiar retorno</button>
          {!callback && <p>Salve o aplicativo para obter o retorno público validado pela instalação. Não deduza o endereço a partir de outro ambiente.</p>}
          {administrator && <form onSubmit={event => { event.preventDefault(); const input = { client_id: appId, client_secret: appSecret }; setAppId(''); setAppSecret(''); void command('erp_bling_app_save', input); }}><fieldset disabled={appBlocked}><legend>Aplicativo próprio registrado no Bling</legend>
            <label htmlFor="bling-client-id">Identificador do aplicativo</label><input id="bling-client-id" type="password" autoComplete="off" value={appId} onChange={e => setAppId(e.target.value)} required />
            <label htmlFor="bling-client-secret">Segredo do aplicativo</label><input id="bling-client-secret" type="password" autoComplete="new-password" value={appSecret} onChange={e => setAppSecret(e.target.value)} required />
            <button type="submit" disabled={!appId || !appSecret}>Salvar aplicativo</button>
          </fieldset></form>}
        </section>
        <section className="rb-card"><h2>Recursos, período e limite</h2><p>Horário de São Paulo. As passagens continuam após a coleta inicial, com sobreposição de quinze minutos. Um período escolhido não certifica cobertura completa.</p>
          <fieldset disabled={configBlocked}><legend>Seleção para receber</legend>{resources?.resources.map(resource => { const selection = selections.find(s => s.key === resource.key); return <div className="rb-resource" key={resource.key}>
            <label><input id={`bling-resource-${resource.key}`} type="checkbox" checked={selection?.selected ?? false} disabled={!resourceSelectable(resource)} onChange={e => editSelection(resource, { selected: e.target.checked })} />{resourceLabel(resource)} · {resource.key}</label>
            <p>{resource.confirmation === 'oficial_confirmado' ? 'Referência oficial confirmada' : resource.confirmation === 'original_conferido' ? 'Implementação local conferida; referência oficial a conferir. Seleção desabilitada.' : 'Recurso não confirmado; acesso e identidade a conferir. Seleção desabilitada.'}</p>
            {resource.key === 'fiscal_xml' && <p>Seleção própria para arquivar XML das fontes fiscais recebidas. Selecione também NF-e/NFC-e ou use fontes já existentes no acervo.</p>}
            <p>{dateMeaning(resource)} Escopos de leitura: {resource.scopeRequirements.join(', ') || 'A conferir'}.</p>
            {resource.officialEvidence && <p>Referência: <a href={resource.officialEvidence.url} target="_blank" rel="noreferrer">Consultar documentação oficial conferida</a> · {time(resource.officialEvidence.checked_at)}</p>}
            <label htmlFor={`bling-from-${resource.key}`}>A partir de</label><input id={`bling-from-${resource.key}`} type="date" value={selection?.from ?? ''} disabled={!resourceSelectable(resource) || resource.dateFilter?.kind === 'U'} onChange={e => editSelection(resource, { from: e.target.value || null })} />
            <label htmlFor={`bling-to-${resource.key}`}>Até</label><input id={`bling-to-${resource.key}`} type="date" value={selection?.to ?? ''} disabled={!resourceSelectable(resource) || resource.dateFilter?.kind === 'U'} onChange={e => editSelection(resource, { to: e.target.value || null })} />
          </div>; })}
          <label htmlFor="bling-daily-limit">Limite local de chamadas de dados por dia (1 a 20.000)</label><input id="bling-daily-limit" type="number" min={1} max={20000} step={1} value={limit} onChange={e => { setLimit(Number(e.target.value)); setDirty(true); }} />
          </fieldset><p>Proteção local, sem certificação do limite oficial do Bling. Intervalo mínimo: {status?.configuration.min_interval_ms ?? 700} ms. Uma coleta pode levar dias e pode não caber inteira.</p>
        </section>
        {access && <AccessEditor value={access} disabled={configBlocked} onChange={editAccess} />}
        {administrator && <><label className="rb-check"><input id="bling-ai-ack" type="checkbox" disabled={configBlocked} checked={aiAck} onChange={e => setAiAck(e.target.checked)} />Revisei a entrega ao provedor de IA: dados das entidades e escopos habilitados poderão ser enviados. A alteração deve ser registrada na auditoria do servidor.</label><button type="button" disabled={configBlocked || !dirty || !access || !Number.isInteger(limit) || limit < 1 || limit > 20000 || (!!access?.bots.length && !aiAck)} onClick={() => access && void command('erp_bling_configure', { selections, daily_call_limit: limit, access, ai_disclosure_acknowledged: aiAck })}>Salvar configuração</button></>}
        <Capacity status={status} />
        <section className="rb-card"><h2>Conferência antes da primeira coleta</h2><p>Referências oficiais, identificação da empresa e disponibilidade real continuam a conferir até haver evidência. Testes automatizados não fazem essa conferência.</p><fieldset disabled={configBlocked}><legend>Confirmação consciente</legend>{BLING_CHECKLIST.map((label, index) => <label className="rb-check" key={index}><input id={`bling-check-${index}`} type="checkbox" checked={checks[index]} onChange={e => setChecks(previous => previous.map((checked, position) => position === index ? e.target.checked : checked))} />{label}</label>)}</fieldset></section>
        {administrator && <section className="rb-card"><h2>Administrar recebimento</h2><p>Ligar permite solicitar autorização. Autorizar vincula a empresa à área. Desligar interrompe novas chamadas e invalida a gravação em curso; desconectar também remove a credencial. Ambos preservam o acervo.</p><div className="rb-actions">
          <button type="button" disabled={configBlocked || dirty || !confirmed || !checks.every(Boolean) || status?.configuration.collect_enabled || !status?.configuration.credential.configured} onClick={() => void task(async () => { if (!admin() || !status || commands.pending) return; const hash = await checklistHash({ checklist: BLING_CHECKLIST, selections, daily_call_limit: limit, revision: status.configuration.revision }); const result = await commands.run('erp_bling_enable', { command_id: crypto.randomUUID(), expected_revision: status.configuration.revision, warning_confirmed: true, checklist_hash: hash }, life.current.signal).catch(stale); await reload(); const refusal = receiptFailure(result.receipt); if (refusal) throw refusal; })}>Ligar recebimento</button>
          <button type="button" disabled={configBlocked || !status?.configuration.collect_enabled || !status?.configuration.credential.configured} onClick={() => void command('erp_bling_oauth_start', {})}>Autorizar conta</button>
          <button type="button" disabled={blocked || !status?.configuration.collect_enabled} onClick={() => void command('erp_bling_disable', {})}>Desligar recebimento</button>
          <button type="button" disabled={blocked || purging || !status?.configuration.credential.configured} onClick={() => void command('erp_bling_disconnect', {})}>Desconectar conta</button>
          <button type="button" disabled={blocked || dirty || purging || !status?.configuration.collect_enabled || !status?.configuration.credential.authorized || !status?.configuration.account?.confirmed_at || !confirmed || !receiveBlingCapability(status, 'collect')} onClick={() => void command('erp_bling_collect_request', { resource_keys: selected.map(s => s.key) })}>Pedir nova coleta</button>
        </div><p>A nova coleta respeita o próximo horário permitido. Para revogar no Bling, use o aplicativo autorizado dentro da sua conta; não há revogação remota automática.</p></section>}
        {administrator && <section className="rb-card rb-danger"><h2>Apagar acervo</h2><p>Apagar é diferente de desligar ou desconectar. A prévia identifica exatamente a geração, os registros e os arquivos. Conteúdo referenciado por adoção, vínculo operacional ou envio em revisão impede o apagamento. A conclusão exige conferência do banco e dos arquivos.</p>
          <label htmlFor="bling-purge-scope">Conteúdo da prévia</label><select id="bling-purge-scope" disabled={blocked || purging} value={purgeScope} onChange={e => { setPurgeScope(e.target.value); setPreview(null); setPurgeConfirm(false); setPurgeHash(''); }}><option value="all">Todo o acervo da área</option><option value="selected">Entidades da seleção salva</option></select>
          <button type="button" disabled={blocked || purging || dirty || !receiveBlingCapability(status, 'purge') || (purgeScope !== 'all' && !selected.length)} onClick={() => void task(async () => { if (!admin() || !status) return; const chosen = scope(); const data = await client.execute('erp_bling_purge_preview', { scope: chosen, generation: status.configuration.generation }, life.current.signal); if (current()) { setPreview({ scope: chosen, data }); setPurgeConfirm(false); setPurgeHash(''); } })}>Preparar prévia de apagamento</button>
          {preview && <div role="region" aria-label="Prévia exata de apagamento"><p>Geração: {preview.data.generation}. Escopo: {preview.scope.all ? 'Todo o acervo da área' : preview.scope.entities.map(e => ENTITY_LABELS[e]).join(', ')}.</p><dl>{Object.entries(preview.data.counts).map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count}</dd></div>)}<div><dt>Arquivos</dt><dd>{preview.data.files}</dd></div><div><dt>Referências impeditivas</dt><dd>{preview.data.blocked_references}</dd></div></dl><p>Hash da prévia: <code>{preview.data.preview_hash}</code></p>
            <label className="rb-check"><input id="bling-purge-confirm" type="checkbox" disabled={blocked || preview.data.blocked_references > 0} checked={purgeConfirm} onChange={e => setPurgeConfirm(e.target.checked)} />Confirmo apagar exatamente o conteúdo e a geração desta prévia, preservando apenas recibo mínimo e auditoria.</label>
            <label htmlFor="bling-purge-hash">Digite o hash da prévia para confirmar o conteúdo exato</label><input id="bling-purge-hash" autoComplete="off" disabled={blocked || preview.data.blocked_references > 0} value={purgeHash} onChange={e => setPurgeHash(e.target.value)} />
            <button type="button" disabled={blocked || !purgeConfirm || purgeHash !== preview.data.preview_hash || preview.data.blocked_references !== 0 || preview.data.generation !== status?.configuration.generation} onClick={() => void command('erp_bling_purge_apply', { scope: preview.scope, generation: preview.data.generation, preview_hash: preview.data.preview_hash, confirmed: true })}>Apagar conteúdo da prévia</button>
          </div>}
        </section>}
      </>}
      {tab === 1 && <><h2>Progresso e cobertura</h2><p>Passagem inicial e coleta contínua preservam observações. Um último GET, uma página curta ou uma passagem concluída não provam que a conta está atualizada.</p>
        <dl className="rb-metrics"><div><dt>Itens observados</dt><dd>{status?.coverage.observed ?? 'Desconhecido'}</dd></div><div><dt>Itens alterados</dt><dd>{status?.coverage.changed ?? 'Desconhecido'}</dd></div><div><dt>Pendências</dt><dd>{status?.coverage.pending ?? 'Desconhecido'}</dd></div><div><dt>Frescor comprovado</dt><dd>{time(status?.coverage.freshness_at ?? null)}</dd></div><div><dt>Início da última passagem</dt><dd>{time(status?.coverage.last_pass_started_at ?? null)}</dd></div><div><dt>Última passagem concluída</dt><dd>{time(status?.coverage.last_pass_completed_at ?? null)}</dd></div></dl>
        <p>Próxima tentativa: {time(status?.next_wake ?? status?.last_error?.retry_at ?? null)}. Última falha: {status?.last_error ? `${status.last_error.code}: ${safeBlingFailure(status.last_error).message}` : 'Nenhuma informada'}.</p>
        <p>Estimativa de duração: desconhecida. Grau de confiança: sem evidência suficiente. Chamadas de dados no dia registrado {status?.progress?.calls_day ?? '(ainda não iniciado)'}: {status?.progress?.calls_today ?? 'Desconhecidas'}.</p>
        <div className="rb-scroll" role="region" aria-label="Cobertura por recurso e pista" tabIndex={0}><table><thead><tr><th>Recurso</th><th>Pistas declaradas</th><th>Seleção</th><th>Progresso por pista</th></tr></thead><tbody>{resources?.resources.map(r => {
          const keys = new Set([r.key, ...r.variants.map(variant => variant.key)]);
          const lanes = status?.progress?.lanes.filter(lane => keys.has(lane.resource_key)) ?? [];
          return <tr key={r.key}><td>{resourceLabel(r)}</td><td>{r.variants.length ? r.variants.map(v => v.key).join(', ') : r.path ? r.key : 'A conferir'}</td><td>{status?.configuration.selections.some(s => s.key === r.key && s.selected) ? 'Selecionado' : 'Desligado'}</td><td>{lanes.length ? lanes.map(lane => <p key={lane.resource_key}>{lane.resource_key}: {lane.observed ?? 'Desconhecido'} observados, {lane.changed ?? 'Desconhecido'} alterados. Passagem concluída: {time(lane.pass_completed_at)}. Frescor: {time(lane.freshness_at)}. Próxima tentativa: {time(lane.next_attempt_at)}.</p>) : r.key === 'fiscal_xml' ? 'Progresso pelos manifestos confirmados no Histórico fiscal; contadores por pista de XML desconhecidos.' : 'Sem métricas disponíveis'}</td></tr>;
        })}</tbody></table></div><Capacity status={status} /><Coverage limitations={[...(resources?.limitations ?? []), ...(status?.coverage.limitations ?? [])]} />
      </>}
      {tab === 2 && <><h2>Acervo</h2><p>{HISTORICAL}. Bruto e espelho usam a mesma permissão. IDs e valores preservam a precisão recebida.</p>
        {!receiveBlingCapability(status, 'archive') ? <p role="status">Consulta do acervo indisponível para este acesso.</p> : <><form className="rb-filters" onSubmit={e => { e.preventDefault(); void task(() => queryRecords()); }}><label htmlFor="bling-entity">Entidade</label><select id="bling-entity" value={entity} disabled={busy} onChange={e => { setEntity(e.target.value as BlingEntity); setRecords(null); setRecord(null); setVersions(null); }}>{Object.entries(ENTITY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label htmlFor="bling-acervo-from">Data inicial do filtro</label><input id="bling-acervo-from" type="date" disabled={busy} value={from} onChange={e => { setFrom(e.target.value); setRecords(null); }} /><label htmlFor="bling-acervo-to">Data final do filtro</label><input id="bling-acervo-to" type="date" disabled={busy} value={to} onChange={e => { setTo(e.target.value); setRecords(null); }} /><label><input type="checkbox" disabled={busy} checked={deleted} onChange={e => { setDeleted(e.target.checked); setRecords(null); }} />Somente exclusões comprovadas</label><button disabled={busy} type="submit">Consultar acervo</button></form>
          {records && <><p role="status">{records.items.length} registro(s) nesta página. Cobertura incompleta.</p><div className="rb-scroll" role="region" aria-label="Registros históricos" tabIndex={0}><table><thead><tr><th>ID recebido</th><th>Versão</th><th>Data da fonte</th><th>Data da coleta</th><th>Exclusão comprovada</th><th>Consulta</th></tr></thead><tbody>{records.items.map(row => <tr key={row.identity.source_id}><td>{row.identity.source_id}</td><td>{row.version}</td><td>{row.source_updated_at ?? 'Desconhecida'} ({row.source_time_quality === 'remote' ? 'Remota' : 'Sem prova de atualização remota'})</td><td>{time(row.last_observed_at)}</td><td>{row.deleted ? 'Sim' : 'Não'}</td><td><button type="button" disabled={busy} onClick={() => void task(() => openRecord(row))}>Ver bruto e espelho {row.identity.source_id}</button></td></tr>)}</tbody></table></div><button type="button" disabled={busy || !records.next_cursor} onClick={() => void task(() => queryRecords(records.next_cursor!))}>Próxima página do acervo</button><button type="button" disabled={busy} onClick={() => void task(() => queryRecords())}>Voltar ao início do acervo</button></>}
          {record && <article className="rb-card"><h3>{HISTORICAL}</h3><p>{ENTITY_LABELS[record.raw.identity.entity]} · ID {record.raw.identity.source_id} · versão {record.raw.version} · hash <code>{record.raw.semantic_hash}</code></p><p>Data da fonte: {record.raw.source_updated_at ?? 'Desconhecida'} · coleta: {time(record.raw.observed_at)} · exclusão comprovada: {record.raw.deleted ? 'Sim' : 'Não'}.</p>{record.raw.deletion_evidence && <p>Evidência: {record.raw.deletion_evidence}</p>}
            <details open><summary>Espelho histórico</summary><pre>{pretty(record.historical.fields)}</pre></details><details><summary>Bruto recebido (texto com precisão preservada)</summary><pre>{record.raw.payload_text}</pre></details><details><summary>Campos sem destino</summary><pre>{pretty(record.historical.unmapped_fields)}</pre></details><details><summary>Referências não resolvidas</summary><pre>{pretty(record.historical.unresolved_references)}</pre></details><details><summary>Vínculos existentes e referências documentais</summary><pre>{pretty({ vinculos: record.existing_links, referencias: record.raw.document_links })}</pre></details><p>Prova de captura precisa: {record.raw.capture ? `revisão ${record.raw.capture.revision}` : 'Não disponível'}.</p>
            <h4>Versões e observações</h4>{versions?.items.map(row => <p key={row.version}><button type="button" disabled={busy} onClick={() => void task(() => openRecord(row, true))}>Consultar versão {row.version}</button> · {time(row.last_observed_at)} · <code>{row.semantic_hash}</code></p>)}<button type="button" disabled={busy || !versions?.next_cursor} onClick={() => void task(async () => { const page = await client.execute('erp_bling_versions_list', { entity: record.raw.identity.entity, id: record.raw.identity.source_id, cursor: versions!.next_cursor!, limit: 50 }, life.current.signal); if (current()) setVersions(page); })}>Mais versões</button><Coverage limitations={record.historical.coverage.limitations} />
          </article>}</>}
      </>}
      {tab === 3 && <><h2>Histórico fiscal</h2><p>{HISTORICAL}. NF-e e NFC-e mantêm identidades separadas, inclusive em produção e homologação.</p><p>XML estruturalmente conferido quando disponível: a conferência de estrutura e integridade não certifica assinatura criptográfica nem autorização fiscal. URLs de anexos não significam bytes arquivados.</p>
        {!receiveBlingCapability(status, 'xml') ? <p role="status">Consulta de XML indisponível para este acesso.</p> : <><form className="rb-filters" onSubmit={e => { e.preventDefault(); void task(() => queryXml()); }}><label htmlFor="bling-xml-entity">Modelo de documento</label><select id="bling-xml-entity" disabled={busy} value={xmlEntity} onChange={e => { setXmlEntity(e.target.value as typeof xmlEntity); setXml(null); }}><option value="">NF-e e NFC-e</option><option value="nfe">NF-e</option><option value="nfce">NFC-e</option></select><label htmlFor="bling-xml-from">Data inicial</label><input id="bling-xml-from" type="date" disabled={busy} value={xmlFrom} onChange={e => { setXmlFrom(e.target.value); setXml(null); }} /><label htmlFor="bling-xml-to">Data final</label><input id="bling-xml-to" type="date" disabled={busy} value={xmlTo} onChange={e => { setXmlTo(e.target.value); setXml(null); }} /><button type="submit" disabled={busy}>Consultar histórico fiscal</button></form>
          {xml && <><p role="status">{xml.items.length} arquivo(s) nesta página. A disponibilidade não certifica cobertura completa.</p>{xml.items.map(row => <article key={row.object_id} className="rb-card"><h3>{row.entity === 'nfe' ? 'NF-e' : 'NFC-e'} · modelo {row.model} · {row.environment === 'production' ? 'Produção' : row.environment === 'test' ? 'Homologação' : 'Ambiente desconhecido'}</h3><p>{HISTORICAL}</p><p>Chave: <code>{row.access_key}</code> · ID {row.source_id} · versão {row.version}.</p><p>Número/série, situação, protocolo e eventos observados: consulte a ficha histórica; não são informados no resumo de XML.</p><p>XML: {row.available ? 'Disponível, estruturalmente conferido' : 'Indisponível'} · {bytes(row.bytes)} · SHA-256: <code>{row.sha256}</code>.</p><Coverage limitations={row.coverage} />
            <button type="button" disabled={busy || !receiveBlingCapability(status, 'archive')} onClick={() => void task(async () => { const [detail, history] = await Promise.all([client.execute('erp_bling_record_get', { entity: row.entity, id: row.source_id }, life.current.signal), client.execute('erp_bling_versions_list', { entity: row.entity, id: row.source_id, limit: 50 }, life.current.signal)]); if (current()) { setEntity(row.entity); setRecords(null); setRecord(detail); setVersions(history); setTab(2); } })}>Consultar nota histórica {row.source_id}</button>
            <button type="button" disabled={busy || !row.available} onClick={() => void task(async () => { const file = await client.execute('erp_bling_xml_get', { object_id: row.object_id }, life.current.signal); if (!current()) return; if (file.sha256 !== row.sha256 || file.bytes.byteLength !== row.bytes) throw new Error(); const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: 'application/xml' })); const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click(); URL.revokeObjectURL(url); })}>Baixar XML {row.source_id}</button>
          </article>)}<button type="button" disabled={busy || !xml.next_cursor} onClick={() => void task(() => queryXml(xml.next_cursor!))}>Próxima página fiscal</button><button type="button" disabled={busy} onClick={() => void task(() => queryXml())}>Voltar ao início fiscal</button></>}
        </>}
      </>}
      {tab === 4 && <AdoptBling controller={controller} administrator={administrator} client={adoptionClient} onHistory={entity => { setHistoryEntity(entity); switchTab(5); }} />}
      {tab === 5 && <HistoryBling controller={controller} administrator={administrator} client={adoptionClient} entity={historyEntity} />}
    </section>
  </section>;
}

function Coverage({ limitations }: { limitations: string[] }) {
  return <aside className="rb-warning"><h3>Limites da cobertura</h3><p>Cobertura incompleta. Marketplace, anúncios, lojas virtuais e canais de venda ficam fora. Imagens e anexos podem existir apenas como referências; XML depende de disponibilidade e conferência.</p>{limitations.length > 0 && <ul>{[...new Set(limitations)].map((item, index) => <li key={index}>{item}</li>)}</ul>}</aside>;
}
function Capacity({ status }: { status: BlingStatus | null }) {
  const occupancy = status?.occupancy;
  return <section className="rb-card"><h2>Capacidade e duração</h2><p>Banco total real: {occupancy ? bytes(occupancy.database_bytes) : 'Desconhecido'}. Acervo estimado: {occupancy ? bytes(occupancy.archive_estimated_bytes) : 'Desconhecido'}. XML no armazenamento de arquivos, separado: {occupancy ? bytes(occupancy.xml_bytes) : 'Desconhecido'}.</p><p>Teto conservador: 10.000.000.000 bytes. Aviso em 70%; parada preventiva em 80% ou antes de a próxima gravação ultrapassar esse limite. Versões não são apagadas automaticamente.</p><p>Backup lógico: feito em partes e com memória fixa, e gravado inteiro em qualquer tamanho. Enquanto ele lê o banco, as alterações do ERP ficam suspensas e as consultas continuam: medido na Cloudflare, cerca de 5 min por GiB de dados exportados. A restauração confere cada parte e troca o banco numa transação só: ou fica igual ao backup, ou como estava. Nesta versão ela cobre até 67.108.864 bytes de dados exportados (64 MiB), porque a troca esbarra na memória do objeto na Cloudflare; um backup maior avisa disso ao terminar, e para voltar a ele use a recuperação no tempo do objeto da área. A restauração de backups maiores virá numa próxima versão, sem mudar o formato do backup. Os XML ficam no armazenamento de arquivos e não entram no backup lógico.</p>{occupancy && <><meter min={0} max={occupancy.ceiling_bytes} low={occupancy.ceiling_bytes * .7} high={occupancy.ceiling_bytes * .8} optimum={0} value={occupancy.database_bytes} aria-label="Ocupação do banco" /><p role="status">{occupancy.database_bytes >= occupancy.ceiling_bytes * .8 ? 'Parada preventiva por capacidade.' : occupancy.database_bytes >= occupancy.ceiling_bytes * .7 ? 'Aviso: ocupação acima de 70%.' : 'Ocupação abaixo do aviso de 70%.'}</p></>}<p>Projeção inicial: {occupancy?.projected_bytes === null || !occupancy ? 'desconhecida' : bytes(occupancy.projected_bytes)}. Intervalo de incerteza, crescimento diário e médias por entidade: desconhecidos, sem métricas suficientes. A coleta pode durar dias e apresentar lacunas. R2 acessível para XML: a conferir.</p><Coverage limitations={status?.coverage.limitations ?? []} /></section>;
}
function AccessEditor({ value, disabled, onChange }: { value: BlingAccessPolicy; disabled: boolean; onChange(value: BlingAccessPolicy): void }) {
  const updateBot = (index: number, patch: Partial<BlingAccessPolicy['bots'][number]>) => onChange({ ...value, bots: value.bots.map((bot, position) => position === index ? { ...bot, ...patch } : bot) });
  return <section className="rb-card"><h2>Permissões de consulta e IA</h2><p>Inicialmente, consulta restrita a administradores e IA desligada. Cada bot respeita a pessoa que representa, a área, as entidades e os escopos configurados. Dados pessoais começam mascarados; dados sensíveis começam desligados. Comandos administrativos vindos de fora do aplicativo não recebem acesso de equipe.</p><fieldset disabled={disabled}><legend>Acessos desta área</legend><label htmlFor="bling-readers">IDs das pessoas autorizadas a consultar, separados por vírgula</label><input id="bling-readers" value={value.reader_user_ids.join(', ')} onChange={e => onChange({ ...value, reader_user_ids: e.target.value.trim() ? e.target.value.split(',').map(v => v.trim()) : [] })} />
    {value.bots.map((bot, index) => <fieldset key={index}><legend>Bot {index + 1}</legend><label htmlFor={`bling-bot-${index}`}>ID do bot</label><input id={`bling-bot-${index}`} value={bot.bot_id} onChange={e => updateBot(index, { bot_id: e.target.value })} />
      <p>As operações permitidas são configuradas no acesso ERP do bot nesta área. Aqui você configura quais dados podem ir à IA e a confirmação de ações sensíveis.</p>
      <details><summary>Entidades disponíveis à IA</summary>{Object.entries(ENTITY_LABELS).map(([entity, label]) => <label className="rb-check" key={entity}><input type="checkbox" checked={bot.entities.includes(entity as BlingEntity)} onChange={e => updateBot(index, { entities: e.target.checked ? [...bot.entities, entity as BlingEntity] : bot.entities.filter(key => key !== entity) })} />{label}</label>)}</details>
      {(['public', 'personal', 'sensitive', 'raw', 'xml'] as const).map(scope => <label className="rb-check" key={scope}><input type="checkbox" checked={bot.data_scopes.includes(scope)} onChange={e => updateBot(index, { data_scopes: e.target.checked ? [...bot.data_scopes, scope] : bot.data_scopes.filter(key => key !== scope) })} />{{ public: 'Metadados públicos', personal: 'Dados pessoais', sensitive: 'Dados sensíveis', raw: 'Bruto completo', xml: 'Arquivos XML' }[scope]}</label>)}
      <label className="rb-check"><input type="checkbox" checked={bot.mask_personal} onChange={e => updateBot(index, { mask_personal: e.target.checked })} />Mascarar dados pessoais</label><label className="rb-check"><input type="checkbox" checked={bot.allow_sensitive} onChange={e => updateBot(index, { allow_sensitive: e.target.checked })} />Liberar ações sensíveis sem confirmação humana para este bot nesta área</label><p>Sem essa liberação, ações sensíveis usam proposta e confirmação humana vinculada ao comando. A integração com o catálogo de bots depende da montagem do servidor.</p><button type="button" onClick={() => onChange({ ...value, bots: value.bots.filter((_, position) => position !== index) })}>Remover acesso do bot {index + 1}</button>
    </fieldset>)}<button type="button" onClick={() => onChange({ ...value, bots: [...value.bots, { bot_id: '', operations: [], entities: [], data_scopes: ['public'], allow_sensitive: false, mask_personal: true }] })}>Configurar acesso de um bot</button>
    <label className="rb-check"><input id="bling-customer-enabled" type="checkbox" checked={value.customer_delivery.enabled} onChange={e => onChange({ ...value, customer_delivery: { ...value.customer_delivery, enabled: e.target.checked } })} />Habilitar entrega dos próprios dados ao cliente com identidade verificada</label><details><summary>Entidades permitidas para entrega ao próprio cliente</summary>{Object.entries(ENTITY_LABELS).map(([entity, label]) => <label className="rb-check" key={entity}><input type="checkbox" checked={value.customer_delivery.entities.includes(entity as BlingEntity)} onChange={e => onChange({ ...value, customer_delivery: { ...value.customer_delivery, entities: e.target.checked ? [...value.customer_delivery.entities, entity as BlingEntity] : value.customer_delivery.entities.filter(key => key !== entity) } })} />{label}</label>)}</details><p>A identidade verificada é obrigatória. Habilitar esta opção não concede acesso a dados de outras pessoas nem a comandos de equipe.</p>
  </fieldset></section>;
}
