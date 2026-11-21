import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { CSV_TYPE, XLSX_TYPE, downloadFile, toCsv, toXlsx } from '../lib/spreadsheet-export';
import { EXPORT_LIMIT, longCells, sheetRows, type ContactListState, type ContactTypeItem } from '../lib/contact-list-model';
import { ExportTooLarge, fetchContactRows } from '../lib/contact-export-request';
import { saoPauloToday } from '../lib/contact-form-model';
import { Modal } from './Modal';
import { aborted, errorText } from './catalog-shared';
import { textCell } from '../lib/spreadsheet-export';
import { contactFieldSheetColumns, contactFieldValuesFor, contactFieldsAvailable, matchesFieldFilters, type ContactFieldFilter } from '../lib/contact-fields';

// Painel "Exportar para a planilha" (Origin CL-18): Formato CSV | XLS, Tipo dos campos Padrão | Customizado | Ambos e os
// avisos do Origin. Os campos customizados ainda não existem no Brufap, então só "Padrão" fica disponível. A planilha
// usa o mesmo cabeçalho do modelo de importação e é montada no navegador; nada é enviado.
// Wabotia: "Customizado" e "Ambos" levam os campos próprios de contato (uma coluna com o nome de cada campo; campo sensível só
// depois de liberado pelo administrador). Com filtro de campo próprio na lista, só os contatos que passam por ele.
export function ContactExportDialog({ controller, state, types, total, fieldFilters = [], onClose }: { controller: AccessController; state: Omit<ContactListState, 'page'>; types: readonly ContactTypeItem[]; total: number; fieldFilters?: readonly ContactFieldFilter[]; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'xls'>('csv'), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [done, setDone] = useState('');
  const [kind, setKind] = useState<'padrao' | 'customizado' | 'ambos'>('padrao');
  const custom = contactFieldsAvailable();
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => () => request.current?.abort(), []);
  const tooMany = total > EXPORT_LIMIT;
  const run = async () => {
    if (busy || tooMany) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setDone(''); setProgress('Lendo os contatos…');
    try {
      let rows = await fetchContactRows(controller, 'contacts', state, { signal: current.signal, onProgress: (count, all) => setProgress(`Lendo os contatos: ${count} de ${all}`) });
      if (current.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      let sheet = sheetRows(rows, types);
      if (kind !== 'padrao' || fieldFilters.length) {
        setProgress('Lendo os campos próprios…');
        const { fields, values } = await contactFieldValuesFor(rows.map(row => row.id), current.signal);
        if (current.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
        if (fieldFilters.length) { rows = rows.filter(row => matchesFieldFilters(fields, fieldFilters, values.get(row.id) ?? {})); sheet = sheetRows(rows, types); }
        const extra = contactFieldSheetColumns(fields);
        if (kind === 'ambos') sheet = sheet.map((line, index) => [...line, ...(index === 0 ? extra.header : extra.cells(values.get(rows[index - 1]!.id)))]);
        if (kind === 'customizado') sheet = [[textCell('Código'), textCell('Nome'), textCell('CPF/CNPJ'), ...extra.header],
          ...rows.map(row => [textCell(typeof row.code === 'string' ? row.code : ''), textCell(String(row.name ?? '')), textCell(typeof row.document === 'string' ? row.document : ''), ...extra.cells(values.get(row.id))])];
      }
      const stamp = saoPauloToday();
      if (format === 'csv') downloadFile(`contatos-${stamp}.csv`, toCsv(sheet), CSV_TYPE);
      else {
        const long = longCells(sheet);
        if (long) { setError(`${long} ${long === 1 ? 'célula passa' : 'células passam'} de 30 mil caracteres, o limite do XLS. Exporte em CSV para não perder texto.`); return; }
        downloadFile(`contatos-${stamp}.xlsx`, toXlsx('Contatos', sheet) as BlobPart, XLSX_TYPE);
      }
      setDone(`${rows.length} ${rows.length === 1 ? 'contato exportado' : 'contatos exportados'}.`);
    } catch (failure) {
      if (current.signal.aborted || aborted(failure)) return;
      setError(failure instanceof ExportTooLarge ? 'A exportação é limitada a 10.000 contatos. Refine os filtros e tente de novo.'
        : failure instanceof Error && failure.message === 'EXPORT_CHANGED' ? 'Os contatos mudaram durante a exportação. Nada foi baixado; tente de novo.' : errorText(failure));
    } finally { if (request.current === current) { request.current = null; setBusy(false); setProgress(''); } }
  };
  return <Modal title="Exportar para a planilha" onClose={() => { request.current?.abort(); onClose(); }} actions={<><button type="button" className="secondary-button" onClick={() => { request.current?.abort(); onClose(); }}>{done ? 'Fechar' : 'Cancelar'}</button>
    <button type="button" className="primary-button" disabled={busy || tooMany || !total} onClick={() => void run()}>{busy ? 'Exportando…' : 'Exportar'}</button></>}>
    <div className="contact-export">
      <fieldset disabled={busy}><legend>Formato de arquivo</legend>
        <label><input type="radio" name="contact-export-format" checked={format === 'csv'} onChange={() => setFormat('csv')} />CSV</label>
        <label><input type="radio" name="contact-export-format" checked={format === 'xls'} onChange={() => setFormat('xls')} />XLS</label></fieldset>
      <fieldset disabled={busy}><legend>Tipo dos campos</legend>
        <label><input type="radio" name="contact-export-fields" checked={kind === 'padrao'} onChange={() => setKind('padrao')} />Padrão</label>
        <label title={custom ? 'Código, nome, CPF/CNPJ e os campos próprios de contato.' : 'Os campos próprios de contato funcionam no painel da área.'}><input type="radio" name="contact-export-fields" checked={kind === 'customizado'} disabled={!custom} onChange={() => setKind('customizado')} />Customizado</label>
        <label title={custom ? 'Os campos padrão seguidos dos campos próprios de contato.' : 'Os campos próprios de contato funcionam no painel da área.'}><input type="radio" name="contact-export-fields" checked={kind === 'ambos'} disabled={!custom} onChange={() => setKind('ambos')} />Ambos</label></fieldset>
      {kind !== 'padrao' && <p className="real-help">Os campos próprios saem numa coluna com o nome de cada campo. Campo sensível só sai se o administrador o liberou.</p>}
      {fieldFilters.length > 0 && <p className="real-help">Com o filtro de campo próprio, saem só os contatos que passam por ele.</p>}
      <p className="real-help">O formato XLS tem limite de 30 mil caracteres por célula. Para textos longos, recomendamos o CSV.</p>
      <p className="real-help">Para reimportar a planilha, exporte os campos Padrão e Customizado separadamente.</p>
      <p className="real-help">Serão exportados {total} {total === 1 ? 'contato' : 'contatos'} com os filtros atuais (limite de 10.000).</p>
      {tooMany && <p className="real-alert" role="alert">A listagem tem mais de 10.000 contatos. Refine os filtros para exportar.</p>}
      {progress && <p role="status">{progress}</p>}{done && <p className="real-success" role="status">{done}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
