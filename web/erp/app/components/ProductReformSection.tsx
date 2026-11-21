import { useEffect, useState } from 'react';
import { REFORM_CLASSES, REFORM_CSTS, SELECTIVE_CSTS } from '../../../../src/erp/domains/fiscal/reform-table.ts';
import { formatRate, reformAvailable, reformErrorText, reformGet, reformPost, type ReformProductView } from '../lib/reform';

type Draft = { cst: string; cclasstrib: string; nbs: string; selective: boolean; is_cst: string; is_cclasstrib: string; is_rate: string };
const toDraft = (view: ReformProductView): Draft => ({
  cst: view.classification?.cst ?? '', cclasstrib: view.classification?.cclasstrib ?? '', nbs: view.classification?.nbs ?? '',
  selective: !!view.selective, is_cst: view.selective?.cst ?? '000', is_cclasstrib: view.selective?.cclasstrib ?? '000001', is_rate: view.selective?.rate ?? '',
});

/**
 * Produto › Tributação › Reforma tributária (IBS/CBS): CST e classificação
 * tributária (cClassTrib) da tabela embutida, NBS do serviço e o Imposto
 * Seletivo (a partir de 2027). Vence a classificação padrão da natureza.
 * Grava à parte do produto (rota erp-reforma); só com o produto já salvo e a
 * parte Fiscal ligada. Quem não é do papel Fiscal ou Administrador só vê.
 */
export default function ProductReformSection({ productId }: { productId: string }) {
  const [view, setView] = useState<ReformProductView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!reformAvailable()) return;
    const request = new AbortController();
    reformGet<ReformProductView>(`/produtos/${productId}`, {}, request.signal)
      .then(value => { if (!request.signal.aborted) { setView(value); setDraft(toDraft(value)); setError(''); } })
      .catch(e => { if (!request.signal.aborted) setError(reformErrorText(e)); });
    return () => request.abort();
  }, [productId]);
  if (!reformAvailable()) return null;
  if (error && !view) return <div className="product-banner"><strong>Reforma tributária (IBS/CBS)</strong> — {error}</div>;
  if (!view || !draft) return <p className="real-help">Carregando a classificação de IBS/CBS…</p>;
  const locked = !view.writable || busy;
  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setNotice(''); };
  const classes = REFORM_CLASSES.filter(entry => entry.cst === draft.cst);
  const known = classes.some(entry => entry.code === draft.cclasstrib);
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await reformPost<ReformProductView>(`/produtos/${productId}`, {
        hash: view.expected_hash,
        classificacao: draft.cst ? { cst: draft.cst, cclasstrib: draft.cclasstrib, nbs: draft.nbs || null } : null,
        seletivo: draft.selective ? { cst: draft.is_cst, cclasstrib: draft.is_cclasstrib, rate: draft.is_rate.replace(',', '.') } : null,
      });
      setView(saved); setDraft(toDraft(saved));
      setNotice(saved.classification ? 'Classificação de IBS/CBS salva. Ela vale nas próximas propostas, pedidos e notas.' : 'Classificação removida: o produto segue a natureza de operação.');
    } catch (e) { setError(reformErrorText(e)); }
    finally { setBusy(false); }
  };
  return <fieldset className="real-editor-fields" disabled={locked} aria-label="Reforma tributária (IBS/CBS)">
    <legend>Reforma tributária (IBS/CBS)</legend>
    <p className="real-help real-field-wide">Classificação do IBS e da CBS deste produto. Em branco, vale a classificação padrão da natureza de operação. Em 2026 os valores só informam: não mudam o preço nem o total da nota.</p>
    <div className="form-field"><label htmlFor="reform-cst">CST do IBS/CBS</label>
      <select id="reform-cst" value={draft.cst} onChange={e => { const cst = e.target.value; set({ cst, cclasstrib: REFORM_CLASSES.find(c => c.cst === cst)?.code ?? (cst ? `${cst}001` : '') }); }}>
        <option value="">Usar a natureza de operação</option>
        {REFORM_CSTS.map(c => <option key={c.cst} value={c.cst}>{c.cst} — {c.description}</option>)}
      </select></div>
    {draft.cst && <div className="form-field"><label htmlFor="reform-class">Classificação tributária (cClassTrib)</label>
      <select id="reform-class" value={known ? draft.cclasstrib : 'outra'} onChange={e => set({ cclasstrib: e.target.value === 'outra' ? '' : e.target.value })}>
        {classes.map(c => <option key={c.code} value={c.code}>{c.code} — {c.description}{Number(c.cbs_reduction) > 0 ? ` (redução de ${formatRate(c.cbs_reduction)})` : ''}</option>)}
        <option value="outra">Outra (digitar o código)</option>
      </select></div>}
    {draft.cst && !known && <div className="form-field"><label htmlFor="reform-class-code">Código da classificação</label>
      <input id="reform-class-code" inputMode="numeric" maxLength={6} placeholder={`${draft.cst}001`} value={draft.cclasstrib} onChange={e => set({ cclasstrib: e.target.value.replace(/\D/g, '') })} />
      <p className="real-help">Seis dígitos começando por {draft.cst}. Fora da tabela embutida o ERP não sabe a redução: a nota leva só o CST e o código.</p></div>}
    {draft.cst && <div className="form-field"><label htmlFor="reform-nbs">NBS (só serviço)</label>
      <input id="reform-nbs" inputMode="numeric" maxLength={9} value={draft.nbs} onChange={e => set({ nbs: e.target.value.replace(/\D/g, '') })} /></div>}
    <label className="preference-check real-field-wide"><input type="checkbox" checked={draft.selective} onChange={e => set({ selective: e.target.checked })} /> Produto com Imposto Seletivo (a partir de 2027: bebidas, cigarros, veículos e outros prejudiciais à saúde ou ao meio ambiente)</label>
    {draft.selective && <>
      <div className="form-field"><label htmlFor="reform-is-cst">CST do Imposto Seletivo</label>
        <select id="reform-is-cst" value={draft.is_cst} onChange={e => set({ is_cst: e.target.value, is_cclasstrib: `${e.target.value}001` })}>
          {SELECTIVE_CSTS.map(c => <option key={c.cst} value={c.cst}>{c.cst} — {c.description}</option>)}
        </select></div>
      <div className="form-field"><label htmlFor="reform-is-class">Classificação do Imposto Seletivo</label>
        <input id="reform-is-class" inputMode="numeric" maxLength={6} value={draft.is_cclasstrib} onChange={e => set({ is_cclasstrib: e.target.value.replace(/\D/g, '') })} /></div>
      <div className="form-field"><label htmlFor="reform-is-rate">Alíquota do Imposto Seletivo (%)</label>
        <input id="reform-is-rate" inputMode="decimal" value={draft.is_rate} onChange={e => set({ is_rate: e.target.value })} /></div>
    </>}
    {error && <p className="real-alert real-field-wide" role="alert">{error}</p>}
    {notice && <p className="real-notice real-field-wide" role="status">{notice}</p>}
    {view.writable
      ? <div className="real-field-wide"><button type="button" className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar classificação de IBS/CBS'}</button></div>
      : <p className="real-help real-field-wide">Só quem tem o papel Fiscal ou Administrador no ERP muda a classificação.</p>}
  </fieldset>;
}
