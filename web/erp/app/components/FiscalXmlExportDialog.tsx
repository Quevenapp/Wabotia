import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import { listPage as checkListPage } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE, FISCAL_PAGE_SIZE, fiscalListQuery, invoiceNumber, isImported, pageCount, type FiscalFilters, type FiscalOrder, type ListRow, type ScreenConfig } from '../lib/fiscal-invoice-list-model';
import { importedXml, saveFile } from '../lib/fiscal-invoice-xml';
import { zipStore } from '../lib/spreadsheet-export';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const MAX_NOTES = 1000;
type Progress = { done: number; total: number; files: number; skipped: string[] };

/**
 * Gaveta "Exportação de XML NFe" (Origin): notas selecionadas ou de um período, Notas e/ou Cartas de correção, num ZIP gerado no
 * navegador. Cada XML é conferido (tamanho e SHA-256) antes de entrar no arquivo; notas sem XML ficam listadas como não exportadas.
 */
// Vinki: Origin fora (motor 91213b8): só os registros do FAGOO (XML importado); saíram a origem "Notas do Origin", o acervo
// sincronizado (/v1/xmls-sincronizados) e as cartas de correção coletadas do Origin.
export default function FiscalXmlExportDialog({ controller, config, filters, order, selected, onClose }: {
  controller: AccessController; config: ScreenConfig; filters: FiscalFilters; order: FiscalOrder; selected: ListRow[]; onClose: () => void;
}) {
  const [scope, setScope] = useState<'selected' | 'period'>(selected.length ? 'selected' : 'period'), [from, setFrom] = useState(filters.from), [to, setTo] = useState(filters.to);
  const [notes, setNotes] = useState(true), [progress, setProgress] = useState<Progress | null>(null), [running, setRunning] = useState(false), [error, setError] = useState('');
  // Notes beyond the 1.000 of one export are named, never dropped silently.
  const [beyond, setBeyond] = useState(0);
  const life = useRef(new AbortController());
  useEffect(() => { const current = life.current; return () => current.abort(); }, []);
  const gather = async (signal: AbortSignal): Promise<ListRow[]> => {
    if (scope === 'selected') { setBeyond(Math.max(0, selected.length - MAX_NOTES)); return selected.slice(0, MAX_NOTES); }
    const query = { ...filters, from, to };
    const first = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, query, { page: 1, order })}`, { signal }), { origin: 'brufap', model: config.model, direction: config.direction, page: 1, limit: FISCAL_PAGE_SIZE, order });
    const rows = [...first.items], pages = Math.min(Math.ceil(MAX_NOTES / FISCAL_PAGE_SIZE), pageCount(first.total_count));
    setBeyond(Math.max(0, first.total_count - MAX_NOTES));
    for (let n = 2; n <= pages; n++) {
      const page = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, query, { page: n, order })}`, { signal }), { origin: 'brufap', model: config.model, direction: config.direction, page: n, limit: FISCAL_PAGE_SIZE, order });
      rows.push(...page.items);
    }
    return rows.slice(0, MAX_NOTES);
  };
  const run = async () => {
    if (running || !notes) return;
    if (scope === 'period' && (!from || !to || from > to)) { setError('Informe a data inicial e a data final do período.'); return; }
    setRunning(true); setError(''); setBeyond(0); const signal = life.current.signal;
    try {
      const rows = await gather(signal), encoder = new TextEncoder(), files: { name: string; data: Uint8Array }[] = [], skipped: string[] = [];
      setProgress({ done: 0, total: rows.length, files: 0, skipped });
      for (const [index, row] of rows.entries()) {
        if (signal.aborted) return;
        const label = `Nota ${invoiceNumber(row)}`;
        try {
          if (isImported(row)) { const file = await importedXml(controller, row.id, signal); files.push({ name: `NFe${file.access_key}.xml`, data: encoder.encode(file.xml) }); }
          else skipped.push(`${label}: sem XML guardado no ERP.`);
        } catch (problem) { if (signal.aborted || aborted(problem)) return; skipped.push(`${label}: o XML não pôde ser conferido.`); }
        setProgress({ done: index + 1, total: rows.length, files: files.length, skipped: [...skipped] });
      }
      if (!files.length) { setError('Nenhum XML foi exportado.'); return; }
      saveFile(`notas-fiscais-${config.model}-xml.zip`, zipStore(files) as Uint8Array<ArrayBuffer>, 'application/zip');
    } catch (problem) { if (!signal.aborted && !aborted(problem)) setError(problem instanceof Error && problem.message.startsWith('Informe') ? problem.message : 'Não foi possível reunir as notas para exportar.'); }
    finally { if (!signal.aborted) setRunning(false); }
  };
  return <Modal title={config.model === '65' ? 'Exportação de XML NFC-e' : 'Exportação de XML NFe'} onClose={onClose}
    actions={<><button type="button" className="primary-button" disabled={running || !notes || (scope === 'selected' && !selected.length)} onClick={() => void run()}>{running ? 'Exportando…' : 'Exportar'}</button>
      <button type="button" className="secondary-button" onClick={onClose}>{running ? 'Cancelar' : 'Fechar'}</button></>}>
    <div className="fiscal-xml-export">
      <fieldset className="fiscal-group"><legend>Notas</legend>
        <label htmlFor="fiscal-export-selected"><input id="fiscal-export-selected" type="radio" name="fiscal-export-scope" disabled={!selected.length || running} checked={scope === 'selected'} onChange={() => setScope('selected')} /> {config.model === '65' ? 'NFC-es selecionadas' : 'NF-es selecionadas'} ({selected.length})</label>
        <label htmlFor="fiscal-export-period"><input id="fiscal-export-period" type="radio" name="fiscal-export-scope" disabled={running} checked={scope === 'period'} onChange={() => setScope('period')} /> Período</label>
        {scope === 'period' && <div className="document-grid"><div className="form-field"><label htmlFor="fiscal-export-from">Data inicial</label><input id="fiscal-export-from" type="date" disabled={running} value={from} onChange={event => setFrom(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="fiscal-export-to">Data final</label><input id="fiscal-export-to" type="date" disabled={running} value={to} onChange={event => setTo(event.target.value)} /></div></div>}
      </fieldset>
      <fieldset className="fiscal-group"><legend>Exportar</legend>
        <label htmlFor="fiscal-export-notes"><input id="fiscal-export-notes" type="checkbox" disabled={running} checked={notes} onChange={event => setNotes(event.target.checked)} /> Notas</label>
        {config.model === '55' && <label htmlFor="fiscal-export-letters"><input id="fiscal-export-letters" type="checkbox" disabled title="As cartas de correção do ERP ainda não foram transmitidas." checked={false} readOnly /> Cartas de correção</label>}
      </fieldset>
      <p className="real-help">Até {MAX_NOTES.toLocaleString('pt-BR')} notas por exportação, com os filtros aplicados na lista. Os arquivos são conferidos antes de entrar no ZIP.</p>
      {progress && <p role="status">{progress.done} de {progress.total} notas exportadas · {progress.files} arquivo(s)</p>}
      {progress && beyond > 0 && <p className="real-notice" role="status">O filtro tem {(progress.total + beyond).toLocaleString('pt-BR')} notas: este ZIP leva as {MAX_NOTES.toLocaleString('pt-BR')} primeiras na ordem da lista e {beyond.toLocaleString('pt-BR')} ficam de fora. Reduza o período para exportar as demais.</p>}
      {progress && progress.skipped.length > 0 && <details><summary>{progress.skipped.length} nota(s) não exportada(s)</summary><ul>{progress.skipped.slice(0, 100).map(text => <li key={text}>{text}</li>)}</ul></details>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      <p className="real-help"><Link to="/preferencias/sistema/consulta-exclusoes">Registro de exclusões por período</Link> · <Link to="/preferencias/sistema/registro-atividades">Notas excluídas por usuário</Link></p>
    </div>
  </Modal>;
}
