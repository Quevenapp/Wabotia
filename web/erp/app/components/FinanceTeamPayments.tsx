import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { blockEnabled } from '../../blocks';
import { todaySP } from '../lib/real-finance-model';
import { PAY_KINDS, REPORTS_UNAVAILABLE, TITLE_STATUS, brDate, c, centsToReais, exportCsv, failureText, money, payKindLabel, periodOf, ratePercent, reportsAvailable, reportsGet, reportsPost, t,
  type PayKind, type TeamCommission, type TeamPerson, type TeamReport } from '../lib/erp-reports';
import { Icon } from './Icon';
import './real-finance.css';
import './report-chart.css';

type Tab = 'lancar' | 'comissoes' | 'relatorio';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const personKey = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;

/**
 * Financeiro › Pagamento da equipe: lançar salário, comissão, adiantamento ou vale de um funcionário ou vendedor como conta a pagar
 * (categoria Pessoal e equipe, com a pessoa e o período ligados); calcular a comissão dos vendedores pelas vendas faturadas no período
 * e lançar com um clique depois de conferir; e ver o que foi lançado por pessoa e período.
 */
export default function FinanceTeamPayments() {
  const today = todaySP(), month = periodOf('mes', today), available = reportsAvailable(), sales = blockEnabled('erp-vendas');
  const [tab, setTab] = useState<Tab>('lancar'), [people, setPeople] = useState<TeamPerson[] | null>(null), [peopleError, setPeopleError] = useState('');
  const [period, setPeriod] = useState(month), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!available) return; const control = new AbortController();
    void reportsGet<{ items: TeamPerson[] }>('/equipe/pessoas', {}, control.signal).then(v => { if (!control.signal.aborted) setPeople(v.items); })
      .catch(failure => { if (!aborted(failure)) setPeopleError(failureText(failure)); });
    return () => control.abort();
  }, [available]);
  if (!available) return <section className="real-state-panel"><h1>Pagamento da equipe</h1><p>{REPORTS_UNAVAILABLE}</p></section>;
  const tabs: [Tab, string][] = [['lancar', 'Lançar pagamento'], ...(sales ? [['comissoes', 'Comissão dos vendedores'] as [Tab, string]] : []), ['relatorio', 'Pagamentos por pessoa']];
  return <section className="report-screen">
    <header className="real-heading"><div><h1>Pagamento da equipe</h1><p>Salário, comissão, adiantamento e vale como conta a pagar, com a pessoa ligada.</p></div></header>
    <nav className="cnab-tabs report-tabs" aria-label="Pagamento da equipe">{tabs.map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setNotice(''); }}>{label}</button>)}</nav>
    {!sales && <p className="real-help">A comissão dos vendedores pelas vendas faturadas aparece com Vendas ligado em Gestão → Módulos.</p>}
    <div className="report-filters">
      <label className="form-field">Período de<input type="date" value={period.from} onChange={event => setPeriod({ ...period, from: event.target.value })} /></label>
      <label className="form-field">até<input type="date" value={period.to} onChange={event => setPeriod({ ...period, to: event.target.value })} /></label>
    </div>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {peopleError && <p className="real-alert" role="alert">{peopleError}</p>}
    {tab === 'lancar' && <PayForm people={people} period={period} today={today} onDone={text => { setNotice(text); setReload(x => x + 1); }} />}
    {tab === 'comissoes' && sales && <Commissions period={period} today={today} reload={reload} onDone={text => { setNotice(text); setReload(x => x + 1); }} />}
    {tab === 'relatorio' && <Report period={period} people={people} reload={reload} />}
  </section>;
}

function PayForm({ people, period, today, onDone }: { people: TeamPerson[] | null; period: { from: string; to: string }; today: string; onDone: (text: string) => void }) {
  const [person, setPerson] = useState(''), [kind, setKind] = useState<PayKind>('salario'), [value, setValue] = useState(''), [due, setDue] = useState(today), [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const chosen = people?.find(p => personKey(p) === person) ?? null;
  const kinds = PAY_KINDS.filter(k => k.id !== 'comissao' || chosen?.kind === 'seller');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!chosen || busy) return; setBusy(true); setError('');
    try {
      const result = await reportsPost<{ record: { description: string; amount_cents: string; due_on: string } }>('/equipe/pagamentos', {
        pessoa_tipo: chosen.kind === 'seller' ? 'vendedor' : 'funcionario', pessoa: chosen.id, tipo: kind, valor: value.replace(/\./g, '').replace(',', '.'), vencimento: due,
        periodo_de: period.from, periodo_ate: period.to, ...(description.trim() ? { descricao: description.trim() } : {}),
      });
      setValue(''); setDescription('');
      onDone(`Conta a pagar lançada: ${result.record.description}, ${money(result.record.amount_cents)}, vence em ${brDate(result.record.due_on)}. Ela está em Financeiro › Contas a pagar.`);
    } catch (failure) { setError(failureText(failure)); } finally { setBusy(false); }
  };
  return <form className="report-filters" onSubmit={submit} aria-label="Lançar pagamento">
    <label className="form-field">Pessoa<select required value={person} onChange={event => { setPerson(event.target.value); const next = people?.find(p => personKey(p) === event.target.value);
      if (kind === 'comissao' && next?.kind !== 'seller') setKind('salario'); if (kind === 'salario' && next?.salary_cents && !value) setValue(centsToReais(next.salary_cents).replace('.', ',')); }}>
      <option value="">{people ? 'Escolha a pessoa' : 'Carregando…'}</option>
      {people?.map(p => <option key={personKey(p)} value={personKey(p)}>{p.name} · {p.kind === 'seller' ? 'vendedor' : p.job_title ?? 'funcionário'}{p.active ? '' : ' (inativo)'}</option>)}</select></label>
    <label className="form-field">Tipo<select value={kind} onChange={event => setKind(event.target.value as PayKind)}>{kinds.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
    <label className="form-field">Valor (R$)<input required inputMode="decimal" pattern="[0-9.]*([,][0-9]{1,2})?" placeholder="0,00" value={value} onChange={event => setValue(event.target.value)} /></label>
    <label className="form-field">Vencimento<input type="date" required value={due} onChange={event => setDue(event.target.value)} /></label>
    <label className="form-field">Descrição (opcional)<input maxLength={240} value={description} placeholder={chosen ? `${payKindLabel(kind)} · ${chosen.name}` : ''} onChange={event => setDescription(event.target.value)} /></label>
    <button type="submit" className="primary-button" disabled={busy || !chosen || (chosen.kind === 'employee' && !chosen.contact_id)}>{busy ? 'Lançando…' : 'Lançar conta a pagar'}</button>
    {chosen?.kind === 'employee' && !chosen.contact_id && <p className="real-alert" role="note">{chosen.name} ainda não tem um contato com o mesmo CPF. Cadastre em <Link to="/cadastros-reais?cadastro=contacts">Cadastros › Contatos</Link> (com o CPF do funcionário) para lançar a conta a pagar.</p>}
    {kind === 'comissao' && <p className="real-help">Para comissão pelas vendas do período, use a aba Comissão dos vendedores: ela calcula e confere antes de lançar.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    <p className="real-help">A conta entra na categoria Pessoal e equipe › {payKindLabel(kind)}s, com competência no início do período ({brDate(period.from)}).</p>
  </form>;
}

function Commissions({ period, today, reload, onDone }: { period: { from: string; to: string }; today: string; reload: number; onDone: (text: string) => void }) {
  const [view, setView] = useState<TeamCommission | null>(null), [error, setError] = useState(''), [checked, setChecked] = useState<string | null>(null), [busy, setBusy] = useState('');
  const [detail, setDetail] = useState<TeamCommission['items'][number] | null>(null), [due, setDue] = useState(today);
  useEffect(() => {
    const control = new AbortController(); setView(null); setError(''); setChecked(null);
    void reportsGet<TeamCommission>('/equipe/comissoes', { de: period.from, ate: period.to }, control.signal).then(v => { if (!control.signal.aborted) setView(v); })
      .catch(failure => { if (!aborted(failure)) setError(failureText(failure)); });
    return () => control.abort();
  }, [period.from, period.to, reload]);
  useEffect(() => {
    if (!checked) { setDetail(null); return; } const control = new AbortController();
    void reportsGet<TeamCommission>('/equipe/comissoes', { de: period.from, ate: period.to, vendedor: checked }, control.signal).then(v => { if (!control.signal.aborted) setDetail(v.items[0] ?? null); })
      .catch(failure => { if (!aborted(failure)) setError(failureText(failure)); });
    return () => control.abort();
  }, [checked]);
  const launch = async (item: TeamCommission['items'][number]) => {
    setBusy(item.seller_id); setError('');
    try {
      await reportsPost('/equipe/pagamentos', { pessoa_tipo: 'vendedor', pessoa: item.seller_id, tipo: 'comissao', valor: centsToReais(item.commission_cents!), vencimento: due, periodo_de: period.from, periodo_ate: period.to });
      onDone(`Comissão de ${item.name} lançada como conta a pagar: ${money(item.commission_cents)}.`);
    } catch (failure) { setError(failureText(failure)); } finally { setBusy(''); }
  };
  return <>
    <p className="real-help">Vendas faturadas: pedidos de venda atendidos{view?.fiscal_included === false ? '' : ' ou com nota fiscal'}, pela data do pedido; a base é a soma dos itens, sem frete. O percentual vem de Cadastros › Vendedores.</p>
    <label className="form-field">Vencimento da comissão<input type="date" value={due} onChange={event => setDue(event.target.value)} /></label>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!view && !error && <p role="status">Calculando…</p>}
    {view && (view.items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Vendedor</th><th className="numeric">Pedidos</th><th className="numeric">Base</th><th className="numeric">Percentual</th><th className="numeric">Comissão</th><th>Situação</th><th /></tr></thead>
      <tbody>{view.items.map(item => <tr key={item.seller_id}><td>{item.name}</td><td className="numeric">{item.order_count}</td><td className="numeric">{money(item.base_cents)}</td><td className="numeric">{ratePercent(item.rate)}</td>
        <td className="numeric">{money(item.commission_cents)}</td>
        <td>{item.generated.length ? `Lançada (${item.generated.map(g => money(g.amount_cents)).join(', ')})` : item.rate === null ? 'Sem percentual no cadastro' : 'A lançar'}</td>
        <td className="report-actions"><button type="button" className="text-button" onClick={() => setChecked(checked === item.seller_id ? null : item.seller_id)}>{checked === item.seller_id ? 'Fechar' : 'Conferir pedidos'}</button>
          {!item.generated.length && item.commission_cents !== null && item.commission_cents !== '0' && checked === item.seller_id &&
            <button type="button" className="primary-button" disabled={busy !== ''} onClick={() => void launch(item)}>{busy === item.seller_id ? 'Lançando…' : 'Lançar conta a pagar'}</button>}</td></tr>)}</tbody></table></div>
      : <p className="real-help">Nenhuma venda faturada com vendedor no período.</p>)}
    {detail && <section className="real-notice" aria-label={`Pedidos de ${detail.name}`}><h3>Pedidos de {detail.name} no período</h3>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Pedido</th><th>Data</th><th>Faturado por</th><th className="numeric">Base</th></tr></thead>
        <tbody>{detail.orders.map(o => <tr key={o.id}><td>Nº {o.number}</td><td>{brDate(o.on)}</td><td>{o.invoiced ? 'Nota fiscal' : 'Pedido atendido'}</td><td className="numeric">{money(o.base_cents)}</td></tr>)}</tbody></table></div>
      <p className="real-help">Conferiu? Use Lançar conta a pagar na linha do vendedor. Se as vendas mudarem antes, o lançamento é recusado e a conta é refeita.</p></section>}
  </>;
}

function Report({ period, people, reload }: { period: { from: string; to: string }; people: TeamPerson[] | null; reload: number }) {
  const [person, setPerson] = useState(''), [view, setView] = useState<TeamReport | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const control = new AbortController(), chosen = people?.find(p => personKey(p) === person); setView(null); setError('');
    void reportsGet<TeamReport>('/equipe/pagamentos', { de: period.from, ate: period.to, ...(chosen ? { pessoa_tipo: chosen.kind === 'seller' ? 'vendedor' : 'funcionario', pessoa: chosen.id } : {}) }, control.signal)
      .then(v => { if (!control.signal.aborted) setView(v); }).catch(failure => { if (!aborted(failure)) setError(failureText(failure)); });
    return () => control.abort();
  }, [period.from, period.to, person, reload]);
  const csv = () => view && exportCsv(`pagamentos-equipe-${period.from}-${period.to}`, ['Pessoa', 'Tipo', 'Período de', 'Período até', 'Descrição', 'Vencimento', 'Valor', 'Pago', 'Situação'],
    view.items.map(i => [t(i.name), t(payKindLabel(i.pay_kind)), t(i.period_from), t(i.period_to), t(i.description), t(i.due_on), c(i.amount_cents), c(i.settled_cents), t(TITLE_STATUS[i.status] ?? i.status)]));
  return <>
    <div className="report-filters"><label className="form-field">Pessoa<select value={person} onChange={event => setPerson(event.target.value)}><option value="">Todas</option>
      {people?.map(p => <option key={personKey(p)} value={personKey(p)}>{p.name}</option>)}</select></label>
      <button type="button" className="secondary-button" disabled={!view?.items.length} onClick={csv}><Icon name="file-lines" size={14} />Exportar CSV</button></div>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!view && !error && <p role="status">Carregando…</p>}
    {view && <>
      {view.people.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Pessoa</th>{PAY_KINDS.map(k => <th key={k.id} className="numeric">{k.label}</th>)}<th className="numeric">Total</th><th className="numeric">Pago</th><th className="numeric">Em aberto</th></tr></thead>
        <tbody>{view.people.map(p => <tr key={`${p.person_kind}:${p.person_id}`}><td>{p.name}</td>{PAY_KINDS.map(k => <td key={k.id} className="numeric">{money(p.by_kind[k.id])}</td>)}
          <td className="numeric">{money(p.total_cents)}</td><td className="numeric">{money(p.paid_cents)}</td><td className="numeric">{money(p.open_cents)}</td></tr>)}</tbody></table></div>
        : <p className="real-help">Nenhum pagamento da equipe no período.</p>}
      {view.items.length > 0 && <><h3>Lançamentos</h3><div className="table-scroll"><table className="data-table"><thead><tr><th>Pessoa</th><th>Tipo</th><th>Referente a</th><th>Descrição</th><th>Vencimento</th><th className="numeric">Valor</th><th>Situação</th></tr></thead>
        <tbody>{view.items.map(i => <tr key={i.id}><td>{i.name}</td><td>{payKindLabel(i.pay_kind)}</td><td>{brDate(i.period_from)} a {brDate(i.period_to)}</td><td>{i.description}</td><td>{brDate(i.due_on)}</td>
          <td className="numeric">{money(i.amount_cents)}</td><td>{TITLE_STATUS[i.status] ?? i.status}</td></tr>)}</tbody></table></div></>}
      {view.truncated && <p className="real-help">Há mais lançamentos que os 2.000 mostrados. Escolha um período menor.</p>}
    </>}
  </>;
}
