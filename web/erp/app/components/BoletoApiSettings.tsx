import { useEffect, useId, useState } from 'react';
import {
  BOLETO_PRODUCTION_WARNING, boletoAccount, boletoApiAvailable, boletoBanks, certificateText, saveBoletoAccount, saveBoletoBank,
  type BoletoAccountConfig, type BoletoBank, type BoletoBanks, type BoletoBankSwitch,
} from '../lib/boleto-api';
import './boleto-api.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';
const when = (at: number | null) => at ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)) : null;

/** Preferências › Finanças › Contas a receber: o interruptor de cada banco de boleto por API (nasce desligado, em homologação). */
export function BoletoBankSwitches() {
  const [banks, setBanks] = useState<BoletoBanks | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [asking, setAsking] = useState<BoletoBank | null>(null);
  useEffect(() => {
    if (!boletoApiAvailable()) return;
    const request = new AbortController();
    boletoBanks(request.signal).then(setBanks, reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, []);
  if (!boletoApiAvailable()) return null;
  const save = async (bank: BoletoBankSwitch, body: Parameters<typeof saveBoletoBank>[1]) => {
    setBusy(bank.banco); setError('');
    try { setBanks(await saveBoletoBank(bank.banco, body)); setAsking(null); } catch (reason) { setError(message(reason) || 'A mudança não foi salva.'); } finally { setBusy(''); }
  };
  return <section className="boleto-api-preference" aria-label="Boleto pela API do banco">
    <h2>Boleto pela API do banco</h2>
    <p>Com o banco ligado, a conta financeira dele pode registrar boleto direto no banco (com linha digitável, Pix do boleto e aviso de pagamento), em vez da remessa CNAB. Cada banco nasce desligado e em homologação.</p>
    {!banks && !error && <p role="status">Carregando…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {banks && <ul className="boleto-api-banks">{banks.bancos.map(bank => <li key={bank.banco}>
      <p><strong>{bank.nome}</strong> ({bank.codigo}) · {bank.ligado ? `ligado em ${bank.ambiente === 'producao' ? 'produção' : 'homologação'}${bank.ligado_em ? ` desde ${when(bank.ligado_em)}` : ''}` : 'desligado'}</p>
      <p className="real-help">{certificateText(bank.certificado)} {bank.aviso_por_webhook ? 'Avisa o pagamento na hora.' : 'O pagamento chega pela consulta periódica (algumas vezes por dia).'} {bank.hibrido === 'sempre' ? 'Boleto sempre com Pix.' : bank.hibrido === 'opcional' ? 'Boleto com Pix opcional.' : ''}</p>
      {banks.pode_mudar ? <div className="boleto-api-actions">
        {bank.ligado ? <>
          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void save(bank, { ligado: false })}>Desligar</button>
          {bank.ambiente === 'sandbox'
            ? <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setAsking(bank.banco)}>Passar para produção</button>
            : <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void save(bank, { ambiente: 'sandbox' })}>Voltar para homologação</button>}
        </> : <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void save(bank, { ligado: true, ambiente: 'sandbox' })}>Ligar em homologação</button>}
      </div> : null}
      {asking === bank.banco && <div className="real-alert" role="alertdialog" aria-label="Aviso">
        <p>{BOLETO_PRODUCTION_WARNING}</p>
        <div className="boleto-api-actions">
          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setAsking(null)}>Cancelar</button>
          <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void save(bank, { ligado: true, ambiente: 'producao', confirmo: true })}>Entendi, passar para produção</button>
        </div></div>}
    </li>)}</ul>}
    {banks && !banks.pode_mudar && <p className="real-help">Só o administrador da área liga e desliga os bancos.</p>}
  </section>;
}

/**
 * Conta financeira › Emissão de Boleto: escolher remessa CNAB (como antes) ou a API do banco, e guardar as credenciais e o
 * certificado digitados (vão para o cofre; a tela mostra só "guardado"). Só o administrador muda.
 */
export function BoletoApiAccountSettings({ accountId }: { accountId: string }) {
  const [config, setConfig] = useState<BoletoAccountConfig | null>(null), [banks, setBanks] = useState<BoletoBanks | null>(null), [error, setError] = useState('');
  const [saved, setSaved] = useState(''), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'cnab' | 'api'>('cnab'), [bank, setBank] = useState<BoletoBank | ''>(''), [hybrid, setHybrid] = useState(true), [fields, setFields] = useState<Record<string, string>>({});
  const modeId = useId(), bankId = useId(), hybridId = useId();
  const load = (value: BoletoAccountConfig) => { setConfig(value); setMode(value.modo); setBank(value.banco ?? ''); setHybrid(value.hibrido); setFields({ ...value.campos }); };
  useEffect(() => {
    if (!boletoApiAvailable()) return;
    const request = new AbortController();
    Promise.all([boletoAccount(accountId, request.signal), boletoBanks(request.signal)]).then(([value, list]) => { load(value); setBanks(list); },
      reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, [accountId]);
  if (!boletoApiAvailable()) return null;
  const info = banks?.bancos.find(item => item.banco === bank) ?? null;
  const save = async (testar: boolean) => {
    setBusy(true); setError(''); setSaved('');
    try {
      const typed = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ''));
      const value = await saveBoletoAccount(accountId, { modo: mode, banco: bank || null, campos: typed, hibrido: hybrid, testar });
      load(value); setSaved(testar ? 'Salvo. Veja o resultado da conferência abaixo.' : 'Salvo.');
    } catch (reason) { setError(message(reason) || 'A configuração não foi salva.'); } finally { setBusy(false); }
  };
  const editable = Boolean(config?.pode_mudar) && !busy;
  // Dentro do formulário da conta financeira: Enter num campo daqui não grava a conta.
  return <div className="boleto-api-account" onKeyDown={event => { if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') event.preventDefault(); }}>
    <h3>Como esta conta emite boleto</h3>
    {!config && !error && <p role="status">Carregando…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {config && <>
      <label htmlFor={modeId}>Emissão
        <select id={modeId} value={mode} disabled={!editable} onChange={event => setMode(event.target.value as 'cnab' | 'api')}>
          <option value="cnab">Pela remessa CNAB (arquivo de remessa e retorno)</option>
          <option value="api">Pela API do banco (registro na hora, com aviso de pagamento)</option>
        </select></label>
      {mode === 'api' && <>
        <label htmlFor={bankId}>Banco
          <select id={bankId} value={bank} disabled={!editable} onChange={event => { setBank(event.target.value as BoletoBank); setFields({}); }}>
            <option value="">Escolha o banco</option>
            {banks?.bancos.map(item => <option key={item.banco} value={item.banco} disabled={Boolean(config.banco_sugerido) && item.banco !== config.banco_sugerido}>{item.nome}</option>)}
          </select></label>
        {info && !info.ligado && <p className="real-help">O {info.nome} está desligado nesta área. O administrador liga em Preferências → Finanças → Contas a receber → Boleto pela API do banco.</p>}
        {info && info.ligado && <p className="real-help">{info.nome} em {info.ambiente === 'producao' ? 'produção' : 'homologação (boletos sem valor)'}.</p>}
        {info?.hibrido === 'opcional' && <label className="finance-drawer-switch" htmlFor={hybridId}><input id={hybridId} type="checkbox" role="switch" checked={hybrid} disabled={!editable} onChange={event => setHybrid(event.target.checked)} />Boleto com Pix (o cliente paga pelo código de barras ou pelo Pix)</label>}
        {info?.campos.map(field => {
          const stored = config.banco === bank && config.segredos_guardados.includes(field.chave);
          const id = `${accountId}-boleto-${field.chave}`;
          return <label key={field.chave} htmlFor={id}>{field.rotulo}{field.obrigatorio ? ' *' : ''}
            {field.varias_linhas
              ? <textarea id={id} rows={4} spellCheck={false} autoComplete="off" disabled={!editable} placeholder={stored ? 'Guardado. Cole de novo só para trocar.' : ''} value={fields[field.chave] ?? ''} onChange={event => setFields(previous => ({ ...previous, [field.chave]: event.target.value }))} />
              : <input id={id} type={field.segredo ? 'password' : 'text'} autoComplete="off" disabled={!editable} placeholder={stored ? 'Guardado. Digite de novo só para trocar.' : ''} value={fields[field.chave] ?? ''} onChange={event => setFields(previous => ({ ...previous, [field.chave]: event.target.value }))} />}
            {field.dica && <small className="real-help">{field.dica}</small>}
          </label>;
        })}
        {config.falta.length > 0 && config.banco === bank && <p className="real-help">Falta: {config.falta.join(', ')}.</p>}
        {config.aviso_url && <><span className="boleto-api-label">Endereço do aviso de pagamento (cadastre no banco, se ele não aceitar pela API)</span><input readOnly value={config.aviso_url} aria-label="Endereço do aviso de pagamento" onFocus={event => event.currentTarget.select()} /></>}
        {config.conferencia && <p className="real-help">{config.conferencia}{config.conferido_em ? ` (${when(config.conferido_em)})` : ''}</p>}
      </>}
      {config.pode_mudar ? <div className="boleto-api-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(false)}>{busy ? 'Salvando…' : 'Salvar emissão de boleto'}</button>
        {mode === 'api' && info?.ligado && <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(true)}>Salvar e conferir no banco</button>}
      </div> : <p className="real-help">Só o administrador da área muda a emissão de boleto e as credenciais do banco.</p>}
      {saved && <p role="status">{saved}</p>}
    </>}
  </div>;
}
