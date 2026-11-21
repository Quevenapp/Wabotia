// Preferências › Vendas › Frente de caixa › Maquininha integrada: ligar a integração (nasce desligada), a credencial (a mesma
// conta do Mercado Pago da Cobrança ou um Access Token próprio, guardado no cofre; a tela mostra só "guardado"), as formas de
// pagamento de débito e de crédito que vão para a maquininha, o parcelamento e a maquininha de cada caixa. Só o administrador muda.
import { useEffect, useId, useState } from 'react';
import {
  saveCashierTerminal, saveTerminalSettings, terminalApiAvailable, terminalDevices, terminalSettings,
  type TerminalDevice, type TerminalSettings,
} from './maquininha-api.ts';
import './maquininha.css';

const message = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '';

export function TerminalPreference() {
  const [settings, setSettings] = useState<TerminalSettings | null>(null), [error, setError] = useState(''), [saved, setSaved] = useState(''), [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<TerminalDevice[] | null>(null);
  const [credential, setCredential] = useState<'cobranca' | 'propria'>('cobranca'), [token, setToken] = useState(''), [webhookSecret, setWebhookSecret] = useState('');
  const [debit, setDebit] = useState(''), [credit, setCredit] = useState(''), [max, setMax] = useState(12), [cost, setCost] = useState<'loja' | 'cliente'>('loja');
  const ids = { credential: useId(), token: useId(), secret: useId(), debit: useId(), credit: useId(), max: useId(), cost: useId() };
  const load = (value: TerminalSettings) => {
    setSettings(value); setCredential(value.credencial); setDebit(value.forma_debito ?? ''); setCredit(value.forma_credito ?? ''); setMax(value.parcelas_max); setCost(value.juros_parcelado);
    setToken(''); setWebhookSecret('');
  };
  useEffect(() => {
    if (!terminalApiAvailable()) return;
    const request = new AbortController();
    terminalSettings(request.signal).then(load, reason => { if (!request.signal.aborted) setError(message(reason)); });
    return () => request.abort();
  }, []);
  if (!terminalApiAvailable()) return null;
  const run = async (action: () => Promise<TerminalSettings>, done: string, fallback: string) => {
    setBusy(true); setError(''); setSaved('');
    try { load(await action()); setSaved(done); } catch (reason) { setError(message(reason) || fallback); } finally { setBusy(false); }
  };
  const save = (ligado?: boolean) => run(() => saveTerminalSettings({ ...(ligado === undefined ? {} : { ligado }), credencial: credential, ...(token.trim() ? { access_token: token.trim() } : {}),
    ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}), forma_debito: debit || null, forma_credito: credit || null, parcelas_max: max, juros_parcelado: cost }),
  ligado === true ? 'Maquininha integrada ligada.' : ligado === false ? 'Maquininha integrada desligada: o caixa volta a registrar o cartão à mão.' : 'Salvo.', 'A configuração não foi salva.');
  const findDevices = async () => {
    setBusy(true); setError('');
    try { setDevices((await terminalDevices()).terminais); } catch (reason) { setError(message(reason) || 'Não deu para listar as maquininhas.'); } finally { setBusy(false); }
  };
  const editable = Boolean(settings?.pode_mudar) && !busy;
  const debitOptions = settings?.formas.filter(item => item.tipo !== 'credito') ?? [], creditOptions = settings?.formas.filter(item => item.tipo !== 'debito') ?? [];

  return <section className="maquininha-preferencia" aria-label="Maquininha integrada">
    <h2>Maquininha integrada (cartão)</h2>
    <p>Com a integração ligada, o caixa manda o valor do cartão direto para a maquininha (débito, crédito à vista ou parcelado) e a venda só é finalizada quando o pagamento é aprovado, com bandeira, parcelas, autorização e NSU gravados. Nasce desligada; sem ela, o cartão continua registrado à mão.</p>
    {!settings && !error && <p role="status">Carregando…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {settings && <>
      <p><strong>{settings.ligado ? 'Ligada' : 'Desligada'}</strong> · {settings.provedores.find(item => item.id === settings.provedor)?.nome ?? 'Mercado Pago'} ({settings.provedores.find(item => item.id === settings.provedor)?.terminal})</p>
      {settings.leitura_pdv && <p className="real-alert" role="alert">{settings.leitura_pdv}</p>}
      <label htmlFor={ids.credential}>Conta do Mercado Pago
        <select id={ids.credential} value={credential} disabled={!editable} onChange={event => setCredential(event.target.value as 'cobranca' | 'propria')}>
          <option value="cobranca" disabled={!settings.conta_cobranca}>A mesma da Cobrança (Gestão → Automação → Cobrança){settings.conta_cobranca ? '' : ': não configurada'}</option>
          <option value="propria">Outra conta: colar o Access Token aqui</option>
        </select></label>
      {credential === 'propria' && <label htmlFor={ids.token}>Access Token de produção (começa com APP_USR-)
        <input id={ids.token} type="password" autoComplete="off" disabled={!editable} value={token} placeholder={settings.segredos_guardados.includes('access_token') ? 'Guardado. Cole de novo só para trocar.' : ''} onChange={event => setToken(event.target.value)} /></label>}
      <label htmlFor={ids.secret}>Assinatura secreta do aviso da maquininha (opcional)
        <input id={ids.secret} type="password" autoComplete="off" disabled={!editable} value={webhookSecret} placeholder={settings.segredos_guardados.includes('webhook_secret') ? 'Guardada. Cole de novo só para trocar.' : credential === 'cobranca' ? 'Vazio: usa a da Cobrança.' : ''} onChange={event => setWebhookSecret(event.target.value)} />
        <small className="real-help">Sem o aviso, o caixa pergunta ao Mercado Pago de 2 em 2 segundos enquanto espera: funciona do mesmo jeito.</small></label>
      <label htmlFor={ids.debit}>Forma de pagamento que vai para a maquininha no débito
        <select id={ids.debit} value={debit} disabled={!editable} onChange={event => setDebit(event.target.value)}>
          <option value="">Nenhuma (débito registrado à mão)</option>
          {debitOptions.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
        </select></label>
      <label htmlFor={ids.credit}>Forma de pagamento que vai para a maquininha no crédito
        <select id={ids.credit} value={credit} disabled={!editable} onChange={event => setCredit(event.target.value)}>
          <option value="">Nenhuma (crédito registrado à mão)</option>
          {creditOptions.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
        </select></label>
      {!settings.formas.length && <p className="real-help">Nenhuma forma de cartão ativa. Cadastre “Cartão de débito” e “Cartão de crédito” em Cadastros → Formas de pagamento.</p>}
      <label htmlFor={ids.max}>Até quantas parcelas no crédito
        <select id={ids.max} value={max} disabled={!editable} onChange={event => setMax(Number(event.target.value))}>
          {Array.from({ length: 12 }, (_, index) => index + 1).map(n => <option key={n} value={n}>{n === 1 ? 'Só à vista' : `${n}x`}</option>)}
        </select></label>
      <label htmlFor={ids.cost}>Juros do parcelado
        <select id={ids.cost} value={cost} disabled={!editable} onChange={event => setCost(event.target.value as 'loja' | 'cliente')}>
          <option value="loja">A loja paga (parcelado sem juros para o cliente)</option>
          <option value="cliente">O cliente paga (parcelado com juros)</option>
        </select></label>
      {settings.pode_mudar ? <div className="maquininha-acoes">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar'}</button>
        {settings.ligado ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(false)}>Desligar a integração</button>
          : <button type="button" className="primary-button" disabled={busy} onClick={() => void save(true)}>Ligar a integração</button>}
      </div> : <p className="real-help">Só o administrador da área muda a maquininha integrada.</p>}
      {saved && <p role="status">{saved}</p>}
      {settings.falta.length > 0 && <p className="real-help">Falta: {settings.falta.join(', ')}.</p>}

      <h2>Maquininha de cada caixa</h2>
      <p className="real-help">Cada loja da frente de caixa usa uma maquininha. Caixa sem maquininha continua registrando o cartão à mão.</p>
      {settings.pode_mudar && <div className="maquininha-acoes"><button type="button" className="secondary-button" disabled={busy} onClick={() => void findDevices()}>Buscar as maquininhas da conta</button></div>}
      {devices && !devices.length && <p className="real-help">Nenhuma maquininha ligada a esta conta do Mercado Pago. Vincule a maquininha no aplicativo do Mercado Pago e busque de novo.</p>}
      <ul className="maquininha-caixas">{settings.caixas.map(store => <li key={store.id}>
        <p><strong>{store.nome}</strong> · {store.terminal ? `maquininha ${store.terminal_nome ?? store.terminal}` : 'sem maquininha'}</p>
        {settings.pode_mudar && <div className="maquininha-acoes">
          {devices?.map(device => <button key={device.id} type="button" className="secondary-button" disabled={busy || device.id === store.terminal} title={device.aviso ?? undefined}
            onClick={() => void run(() => saveCashierTerminal(store.id, device.id), `Maquininha ${device.nome} ligada a ${store.nome}.`, 'A maquininha não foi ligada ao caixa.')}>Usar {device.nome}{device.pronto ? '' : ' (passa para o modo integrado)'}</button>)}
          {store.terminal && <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => saveCashierTerminal(store.id, null), `${store.nome} ficou sem maquininha.`, 'A mudança não foi salva.')}>Tirar a maquininha</button>}
        </div>}
      </li>)}</ul>
      {!settings.caixas.length && <p className="real-help">Nenhuma loja na frente de caixa. Cadastre uma conta do tipo caixa no Financeiro.</p>}
      {settings.aviso_url && <label>Endereço do aviso (cadastre no Mercado Pago, em Webhooks, com o evento de integrações Point, se usa uma aplicação só para a maquininha)
        <input readOnly value={settings.aviso_url} onFocus={event => event.currentTarget.select()} /></label>}
    </>}
  </section>;
}
