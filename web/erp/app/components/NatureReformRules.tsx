import { useEffect, useState } from 'react';
import { REFORM_CLASSES, REFORM_CSTS } from '../../../../src/erp/domains/fiscal/reform-table.ts';
import { reformAvailable, reformErrorText, reformGet, reformPost, type ReformNatureRule, type ReformNatureView } from '../lib/reform';

type Row = { scope: ReformNatureRule['product_scope']; ncms: string; cst: string; cclasstrib: string; product_ids: string[]; group_ids: string[] };
const toRows = (rules: ReformNatureRule[]): Row[] => rules.map(r => ({ scope: r.product_scope, ncms: r.ncms.join(', '), cst: r.cst, cclasstrib: r.cclasstrib, product_ids: r.product_ids, group_ids: r.group_ids }));
const classLabel = (code: string) => REFORM_CLASSES.find(c => c.code === code)?.description ?? 'fora da tabela embutida';

function ClassPicker({ id, row, disabled, onChange }: { id: string; row: Row; disabled: boolean; onChange: (patch: Partial<Row>) => void }) {
  const classes = REFORM_CLASSES.filter(c => c.cst === row.cst);
  return <>
    <select id={`${id}-cst`} aria-label="CST do IBS/CBS" disabled={disabled} value={row.cst} onChange={e => onChange({ cst: e.target.value, cclasstrib: REFORM_CLASSES.find(c => c.cst === e.target.value)?.code ?? `${e.target.value}001` })}>
      {REFORM_CSTS.map(c => <option key={c.cst} value={c.cst}>{c.cst} — {c.description}</option>)}
    </select>
    <input id={`${id}-class`} aria-label="Classificação tributária (cClassTrib)" list={`${id}-classes`} inputMode="numeric" maxLength={6} disabled={disabled} value={row.cclasstrib}
      onChange={e => onChange({ cclasstrib: e.target.value.replace(/\D/g, '') })} title={classLabel(row.cclasstrib)} />
    <datalist id={`${id}-classes`}>{classes.map(c => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist>
  </>;
}

/**
 * Natureza de operação › Reforma (IBS/CBS): a classificação padrão dos itens
 * vendidos com esta natureza e as exceções por NCM (o NCM de prefixo mais
 * longo vence; a classificação do produto vence todas). Exceções por produto
 * ou grupo já gravadas são mantidas. Grava à parte da natureza (rota
 * erp-reforma), com a versão lida: se outra pessoa mudou, pede para atualizar.
 */
export default function NatureReformRules({ natureId, writable }: { natureId: string; writable: boolean }) {
  const [view, setView] = useState<ReformNatureView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!reformAvailable()) return;
    const request = new AbortController();
    reformGet<ReformNatureView>(`/naturezas/${natureId}`, {}, request.signal)
      .then(value => { if (!request.signal.aborted) { setView(value); setRows(toRows(value.rules)); } })
      .catch(e => { if (!request.signal.aborted) setError(reformErrorText(e)); });
    return () => request.abort();
  }, [natureId]);
  if (!reformAvailable()) return <p className="real-help">A reforma tributária abre no painel da área.</p>;
  if (error && !view) return <p className="real-alert" role="alert">{error}</p>;
  if (!view) return <p className="real-help">Carregando a classificação de IBS/CBS…</p>;
  const locked = !writable || !view.writable || busy;
  const fallback = rows.find(r => r.scope === 'any');
  const exceptions = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.scope !== 'any');
  const change = (index: number, patch: Partial<Row>) => { setRows(rows.map((r, i) => i === index ? { ...r, ...patch } : r)); setNotice(''); };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const regras = rows.map(r => r.scope === 'any' ? { cst: r.cst, cclasstrib: r.cclasstrib }
        : r.scope === 'ncm' ? { product_scope: 'ncm', ncms: r.ncms.split(/[,\s;]+/).map(n => n.replace(/\D/g, '')).filter(Boolean), cst: r.cst, cclasstrib: r.cclasstrib }
        : r.scope === 'products' ? { product_scope: 'products', product_ids: r.product_ids, cst: r.cst, cclasstrib: r.cclasstrib }
        : { product_scope: 'groups', group_ids: r.group_ids, cst: r.cst, cclasstrib: r.cclasstrib });
      const saved = await reformPost<ReformNatureView>(`/naturezas/${natureId}`, { regras, hash: view.expected_hash });
      setView(saved); setRows(toRows(saved.rules)); setNotice('Classificação de IBS/CBS da natureza salva.');
    } catch (e) { setError(reformErrorText(e)); }
    finally { setBusy(false); }
  };
  return <div className="document-grid">
    <p className="real-help fiscal-wide">Classificação do IBS e da CBS dos itens vendidos com esta natureza. A classificação do produto (Produto › Tributação) vence a da natureza. Em 2026 os valores só informam.</p>
    <div className="form-field fiscal-wide"><label htmlFor="reform-default-cst">Classificação padrão</label>
      {fallback
        ? <div className="product-inline"><ClassPicker id="reform-default" row={fallback} disabled={locked} onChange={patch => change(rows.indexOf(fallback), patch)} />
          <button type="button" className="text-button" disabled={locked} onClick={() => setRows(rows.filter(r => r !== fallback))}>Remover padrão</button></div>
        : <button type="button" className="secondary-button" disabled={locked} onClick={() => setRows([{ scope: 'any', ncms: '', cst: '000', cclasstrib: '000001', product_ids: [], group_ids: [] }, ...rows])}>Definir padrão (tributação integral)</button>}
      {fallback && <p className="real-help">{fallback.cclasstrib}: {classLabel(fallback.cclasstrib)}</p>}
    </div>
    <div className="fiscal-wide">
      <h3>Exceções</h3>
      {exceptions.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Vale para</th><th>CST e classificação</th><th /></tr></thead><tbody>
        {exceptions.map(({ row, index }) => <tr key={index}>
          <td>{row.scope === 'ncm'
            ? <input aria-label="NCMs (separe por vírgula)" disabled={locked} value={row.ncms} placeholder="ex.: 3004, 30049099" onChange={e => change(index, { ncms: e.target.value })} />
            : row.scope === 'products' ? `${row.product_ids.length} produto(s) escolhido(s)` : `${row.group_ids.length} grupo(s) de produtos`}</td>
          <td><div className="product-inline"><ClassPicker id={`reform-rule-${index}`} row={row} disabled={locked} onChange={patch => change(index, patch)} /></div></td>
          <td><button type="button" className="text-button" disabled={locked} onClick={() => setRows(rows.filter((_, i) => i !== index))}>Remover</button></td>
        </tr>)}</tbody></table></div> : <p className="real-help">Nenhuma exceção.</p>}
      <button type="button" className="secondary-button" disabled={locked || rows.length >= 50} onClick={() => setRows([...rows, { scope: 'ncm', ncms: '', cst: '200', cclasstrib: '200034', product_ids: [], group_ids: [] }])}>Adicionar exceção por NCM</button>
    </div>
    {error && <p className="real-alert fiscal-wide" role="alert">{error}</p>}
    {notice && <p className="real-success fiscal-wide" role="status">{notice}</p>}
    {view.writable && writable
      ? <div className="fiscal-wide"><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar classificação de IBS/CBS'}</button>
        <p className="real-help">Grava só a classificação da reforma (o botão Salvar do topo grava o resto da natureza).</p></div>
      : <p className="real-help fiscal-wide">Só quem tem o papel Fiscal ou Administrador no ERP muda a classificação.</p>}
  </div>;
}
