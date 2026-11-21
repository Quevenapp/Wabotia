import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoiceLabelProducts, type PurchaseLabels } from '../lib/document-labels-model';
import { ProductLabels } from './ProductLabels';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import CommercialNfe from '../../CommercialNfe';
import { erpPorts } from '../../ports';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { listPage as checkListPage, invoiceRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import {
  CUSTOM_FILTER_LABELS, FISCAL_BASE, FISCAL_PAGE_SIZE, LIST_IDS, PERSON_LABELS, SCREENS, UFS, brDay, columnLayout, defaultColumns, deletePlan, emptyFilters, filterChips, filtersFromPreference,
  danfeReady, filtersToPreference, fiscalColumns, fiscalListQuery, formatDocument, invoiceNumber, isImported, linkLabel, noteLabel, orderIndicators, pageCount, rowActions, statusClass, statusLabel, type CustomFilter, type DeleteItem,
  deleteRefusalText, type DeleteEffects,
  // Espelho lane (wave H): Categoria, Loja/Filial not applicable, fiscal state apart from the DANFE and the source of each note.
  NOT_APPLICABLE_FILTERS, fiscalStateText, sourceLabel,
  type FiscalColumn, type FiscalFilters, type FiscalOrder, type FiscalScreen, type ListPage, type ListRow, type RowAction,
  financeIndicator, type InvoiceFinanceState,
} from '../lib/fiscal-invoice-list-model';
// Financeiro lane (SQL 247): ⋮ Lançar contas / Estornar contas / Emitir boletos and the letra C of the notes of the Brufap.
import FiscalInvoiceFinance from './FiscalInvoiceFinance';
import { readCategoryChoices, type CategoryOption } from '../lib/document-category-model';
import { invoiceFlags, type InvoiceFlags } from '../lib/fiscal-invoice-finance';
import { useListPreferences } from '../hooks/useListPreferences';
import ListPreferencesBar from './ListPreferencesBar';
import { selectRange, opensInNewTab } from '../lib/origin-list';
import type { BatchResult } from '../lib/origin-batch';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { AppliedChips, OriginListHeader, OriginPagination, IndicatorLetter, ListControls, PeriodPicker, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import NativeListLayout from './NativeListLayout';
import FiscalInvoiceForm, { type FormOpening } from './FiscalInvoiceForm';
import { CancelDialog, CorrectionDialog, InutilizationDialog } from './FiscalEventDialogs';
import { FiscalListPrint, FiscalMirrorPrint } from './FiscalInvoicePrint';
import DocumentLabelsPrint from './DocumentLabelsPrint';
import type { AddressLabel } from '../lib/document-list-export';
import FiscalOrderLinkDialog from './FiscalOrderLinkDialog';
import FiscalImportDialog from './FiscalImportDialog';
import FiscalXmlExportDialog from './FiscalXmlExportDialog';
import FiscalReturnDialog from './FiscalReturnDialog';
import FiscalPricingDialog from './FiscalPricingDialog';
import { pricingStates, pricingTitle, type PricingState } from '../lib/fiscal-invoice-pricing';
import FiscalDanfePrint, { type DanfeDocument, type DanfeLayout } from './FiscalDanfe';
import FiscalAccountantPackage from './FiscalAccountantPackage';
// Notas lane (wave F): "Gerar PDF DANFE" of the panel as a background task (up to 1.000 notes, one PDF or a ZIP).
import FiscalDanfePdfJob from './FiscalDanfePdfJob';
import { DANFE_JOB_MAX, danfeJobFile, newDanfeJob, type DanfeFileFormat, type DanfeJobState } from '../lib/danfe-pdf-job';
// Notas lane (wave F, 202610200273): "Validar" and "Gerar XML (suporte)" of a note of the Brufap (native XML, not signed).
import FiscalNativeXmlDialog from './FiscalNativeXmlDialog';
import { nativeXmlBlock, nativeXmlPath, nativeXmlResult, type NativeXmlResult } from '../lib/fiscal-native-xml';
import { DEFAULT_DANFE_SETTINGS, DanfeError, danfeData, danfeErrorText, danfeSettings, type DanfeSettings } from '../lib/danfe';
import { importedXml, saveFile, xmlFileName } from '../lib/fiscal-invoice-xml';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './fiscal-invoices.css';
// Estoque lane (184): ⋮ Check-in de Recebimentos opens the conferência of the note.
import { CHECKIN_READERS, checkinHref } from '../lib/receipt-checkin-model';
// Produtos lane (202610200236): Marcadores (tags) of the notes, "Editar tags" and the Tags filter.
import { InvoiceTagCell, InvoiceTagFilter, InvoiceTagsOverlay, useInvoiceTags } from './InvoiceTags';
// Estoque lane (259): letter E and ⋮ Lançar estoque / Estornar estoque of a Brufap note.
import InvoiceStockDialog, { useInvoiceStockFlags } from './InvoiceStock';
import { invoiceStockLetter } from '../lib/invoice-stock-model';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const known = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';

const failureText = (error: unknown) => error instanceof AccessError ? error.detail ? error.detail : error.status === 409 ? 'A nota mudou ou a situação atual não permite esta ação. Recarregue a listagem e confira.'
  : error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 404 ? 'Nota não encontrada. Recarregue a listagem.' : error.status === 400 ? 'O servidor recusou os dados informados.'
    : 'Não foi possível concluir a operação. Tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
type Dialog = { type: 'delete'; rows: ListRow[] } | { type: 'inutilization' } | { type: 'cancel'; record: InvoiceRecord } | { type: 'correction'; record: InvoiceRecord }
  | { type: 'other'; row: ListRow } | { type: 'xml'; row: ListRow; text: string } | { type: 'notice'; title: string; text: string } | { type: 'link'; row: ListRow; mode: 'link' | 'unlink' } | { type: 'import' }
  | { type: 'export'; rows: ListRow[] } | { type: 'certificate'; text: string } | { type: 'pricing'; row: ListRow } | { type: 'danfe_pdf' }
  | { type: 'native'; mode: 'validate' | 'support'; result: NativeXmlResult }
  // "Devolução de produto" (202610200220): quantities to return before the return note opens.
  | { type: 'return'; record: InvoiceRecord } | null;

/** O percurso comercial e o acervo anterior nunca compartilham o formulário fiscal. */
export function HostedFiscalInvoices(props: { controller: AccessController; screen: FiscalScreen; backup?: ReactNode }) {
  return erpPorts()?.commercialNfe && props.screen !== 'entrada'
    ? <CommercialFiscalInvoices {...props} /> : <RealFiscalInvoices {...props} />;
}

function CommercialFiscalInvoices({ controller, screen, backup }: { controller: AccessController; screen: FiscalScreen; backup?: ReactNode }) {
  const location = useLocation(), params = new URLSearchParams(location.search);
  const archive = params.get('acervo') === 'legado' || (params.has('nota') && params.get('nota') !== 'nova');
  const unsupported = (params.get('pedido') ?? '').includes(',') || params.has('parcial');
  return <>
    <nav className="origin-list-tabs" aria-label="Históricos fiscais">
      <Link to="/historico-fiscal?modelo=55" aria-current={screen === 'nfe' && !archive ? 'page' : undefined}>NF-e comercial</Link>
      <Link to={`/historico-fiscal?${new URLSearchParams({ modelo: screen === 'nfce' ? '65' : '55', acervo: 'legado' })}`} aria-current={archive ? 'page' : undefined}>Acervo legado · somente consulta</Link>
    </nav>
    {screen === 'nfe' && !archive && !unsupported ? <CommercialNfe controller={controller} /> : <>
      {(screen === 'nfce' || unsupported) && <p className="real-notice" role="status">{screen === 'nfce' ? 'A NFC-e sai pela frente de caixa (Vendas › Frente de caixa), com o cupom do emissor de notas. Aqui ficam as notas do acervo legado.' : 'Emissão parcial e agrupada não são feitas aqui: prepare a NF-e integral de um pedido de venda. A NFC-e sai pela frente de caixa e a nota da ordem de serviço, pela própria ordem.'}</p>}
      <LegacyFiscalArchive key={screen} controller={controller} screen={screen} />
    </>}
  </>;
}

/** Leitor isolado: não monta formulários, XML, DANFE, numeração ou efeitos locais. */
function LegacyFiscalArchive({ controller, screen }: { controller: AccessController; screen: FiscalScreen }) {
  const location = useLocation(), config = SCREENS[screen];
  const requested = new URLSearchParams(location.search).get('nota');
  const selected = requested && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requested) ? requested : null;
  const [page, setPage] = useState<ListPage | null>(null), [pageNumber, setPageNumber] = useState(1);
  const [record, setRecord] = useState<InvoiceRecord | null>(null), [recordRow, setRecordRow] = useState<ListRow | null>(null);
  const [reading, setReading] = useState<string | null>(selected), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => { setReading(selected); setRecordRow(null); }, [selected]);
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    const filters = { ...emptyFilters(config), query: search };
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, filters, { page: pageNumber })}`, { signal: request.signal })).then(value => {
      if (!request.signal.aborted) setPage(checkListPage(value, { origin: 'brufap', model: config.model, direction: config.direction, page: pageNumber, limit: FISCAL_PAGE_SIZE, order: 'date_desc' }));
    }).catch(problem => { if (!request.signal.aborted) setError(failureText(problem)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [controller, screen, search, pageNumber, reload]);
  useEffect(() => {
    setRecord(null);
    if (!reading) return;
    const request = new AbortController(); setError('');
    void controller.fiscalInvoices(`${FISCAL_BASE}/${encodeURIComponent(reading)}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return;
      const next = invoiceRecord((value as { invoice: unknown }).invoice);
      if (next.id !== reading || next.model !== config.model || next.direction !== config.direction) throw new Error('Resposta fiscal incompatível.');
      setRecord(next);
    }).catch(problem => { if (!request.signal.aborted) setError(failureText(problem)); });
    return () => request.abort();
  }, [controller, reading, screen, reload]);
  return <section className="fiscal-invoices" aria-labelledby="legacy-fiscal-title">
    <h1 id="legacy-fiscal-title">Acervo legado · {config.title}</h1>
    <p className="real-notice">Consulta dos registros anteriores e XMLs já importados. Este acervo não contém as novas emissões comerciais do cofre e não participa de seus totais. Emissão, alteração, numeração e efeitos por nota legada estão fechados.</p>
    {requested === 'nova' && <p className="real-alert" role="alert">A inclusão fiscal legada está encerrada. A emissão disponível é a NF-e integral de um pedido de venda.</p>}
    <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setPageNumber(1); }}>
      <label htmlFor="legacy-fiscal-search">Pesquisar no acervo legado</label>{' '}
      <input id="legacy-fiscal-search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} />{' '}
      <button type="submit" className="secondary-button" disabled={loading}>Pesquisar</button>{' '}
      <button type="button" className="text-button" disabled={loading} onClick={() => setReload(value => value + 1)}>Atualizar</button>
    </form>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {loading && <p role="status">Consultando o acervo…</p>}
    {page && <><p>{page.total_count} registro(s). O ambiente está identificado em cada linha; os valores não são somados.</p>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Nota</th><th>Ambiente</th><th>Cliente ou fornecedor</th><th>Situação registrada</th><th>Valor</th><th>Consulta</th></tr></thead><tbody>
        {page.items.map(row => <tr key={row.id}><td>{invoiceNumber(row)}</td><td>{sourceLabel(row)}</td><td>{row.name ?? 'Não informado'}</td><td>{statusLabel(row, config.model)}</td><td>{row.total_known ? decimalMoney(row.total) : 'Não informado'}</td><td><button type="button" className="text-button" onClick={() => { setRecordRow(row); setReading(row.id); }}>Consultar registro</button></td></tr>)}
      </tbody></table></div>
      {!page.items.length && <p>Nenhum registro encontrado.</p>}
      <div className="origin-pagination"><button type="button" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}>Anterior</button><span> Página {pageNumber} </span><button type="button" disabled={loading || !page.has_more} onClick={() => setPageNumber(value => value + 1)}>Próxima</button></div>
    </>}
    {record && record.id === reading && <section aria-label="Registro fiscal legado"><h2>Consulta da nota {record.number ?? 'sem número'} · série {record.series}</h2>
      <p>{recordRow ? sourceLabel(recordRow) : record.environment === '2' ? 'Homologação · sem valor fiscal de produção' : 'Ambiente não informado no registro'}</p>
      <dl><dt>Destinatário</dt><dd>{String(record.recipient.name ?? 'Não informado')}</dd><dt>Natureza</dt><dd>{record.nature_description}</dd><dt>Chave registrada</dt><dd>{record.access_key ?? 'Não informada'}</dd><dt>Protocolo registrado</dt><dd>{record.protocol ?? 'Não informado'}</dd></dl>
      <table className="data-table"><thead><tr><th>Item</th><th>Quantidade</th><th>Valor unitário</th><th>Total</th></tr></thead><tbody>{record.items.map(item => <tr key={item.position}><td>{item.description}</td><td>{item.quantity}</td><td>{decimalMoney(item.unit_price)}</td><td>{decimalMoney(item.total)}</td></tr>)}</tbody></table>
      <button type="button" className="text-button" onClick={() => { setRecord(null); setReading(null); }}>Fechar consulta</button>
    </section>}
  </section>;
}

/** Componente portado: usado por Compras e hospedeiros sem o percurso comercial. */
export default function RealFiscalInvoices({ controller, screen, backup }: { controller: AccessController; screen: FiscalScreen; backup?: ReactNode }) {
  const config = SCREENS[screen];
  const location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const role = roleOf(controller), writable = ['admin', 'fiscal'].includes(role);
  const entryOnly = Boolean(erpPorts()?.commercialNfe) && screen === 'entrada';
  const closedExit = 'Notas de saída usam o acompanhamento comercial. Conversão de entrada para saída e devolução fiscal ainda não são atendidas.';
  const exitAction = (id: string) => entryOnly && ['clone_invert', 'return', 'nfe_from_nfce'].includes(id);
  // Vinki: Origin fora (motor 91213b8): a lista mostra sempre os registros do FAGOO; saíram o seletor "Notas do Origin" × "Registros do
  // FAGOO", o parâmetro ?origem= e a nota do Origin aberta em leitura.
  const opened = params.get('nota'), backupTab = Boolean(backup) && params.get('aba') === 'backup';
  // "Gerar nota fiscal" / "Gerar NFC-e" of a pedido opens a new note filled from it (?nota=nova&pedido=<id>, migration 202610200176);
  // "Conciliar produtos" opens the imported note on the Itens tab (?secao=itens).
  const fromOrder = opened === 'nova' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.get('pedido') ?? '') ? params.get('pedido')!.toLowerCase() : null;
  // "Gerar nota fiscal agrupando" (ordens de serviço): ?pedido=<id>,<id>,… with 2 to 20 distinct documents.
  const groupedIds = opened === 'nova' && !fromOrder ? (params.get('pedido') ?? '').toLowerCase().split(',').filter(Boolean) : [];
  const fromGroup = groupedIds.length >= 2 && groupedIds.length <= 20 && new Set(groupedIds).size === groupedIds.length && groupedIds.every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) ? groupedIds : null;
  const section = params.get('secao') === 'itens' ? 'itens' as const : undefined;
  const [formHeld, setFormHeld] = useState(false);
  useEffect(() => { if (!opened) setFormHeld(false); else if (writable) setFormHeld(true); }, [opened, writable]);
  const [filters, setFilters] = useState<FiscalFilters>(() => emptyFilters(config));
  const [draft, setDraft] = useState<FiscalFilters>(() => emptyFilters(config));
  const [listPage, setListPage] = useState(1), [order, setOrder] = useState<FiscalOrder>('date_desc'), [reload, setReload] = useState(0);
  const [page, setPage] = useState<ListPage | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [anchor, setAnchor] = useState<string | null>(null), [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null), [notice, setNotice] = useState(''), [actionError, setActionError] = useState('');
  const [opening, setOpening] = useState<FormOpening | null>(null), [mirror, setMirror] = useState<InvoiceRecord | null>(null), [printRows, setPrintRows] = useState<ListRow[] | null>(null);
  const [printing, setPrinting] = useState(false), [reason, setReason] = useState(''), [customOpen, setCustomOpen] = useState(false), [labels, setLabels] = useState<AddressLabel[] | null>(null);
  const [productQuery, setProductQuery] = useState(''), [products, setProducts] = useState<CatalogRecord[]>([]);
  // DANFE (wave E): the preview with the notes read so far, the progress and what stayed out.
  const [danfe, setDanfe] = useState<{ title: string; layout: DanfeLayout; documents: DanfeDocument[]; settings: DanfeSettings; progress?: string; problems: string[]; pdf: boolean } | null>(null);
  const [pdfMode, setPdfMode] = useState<'selected' | 'period'>('selected'), [pdfFrom, setPdfFrom] = useState(''), [pdfTo, setPdfTo] = useState('');
  const [pdfFormat, setPdfFormat] = useState<DanfeFileFormat>('single'), [pdfJob, setPdfJob] = useState<DanfeJobState | null>(null), pdfJobRequest = useRef<AbortController | null>(null);
  // Filtro Vendedor (202610200215) through the cadastro de vendedores.
  const [sellerQuery, setSellerQuery] = useState(''), [sellers, setSellers] = useState<{ id: string; name: string; code: string | null }[]>([]);
  // Espelho lane (202610210358): Categoria of the contas lançadas by the note (categorias de receita, the ones of the pedidos de venda).
  const [categories, setCategories] = useState<CategoryOption[] | null>(null), [categoryError, setCategoryError] = useState('');
  const lifetime = useRef(new AbortController()), detail = useRef<AbortController | null>(null), batchActor = useRef<string | null>(null), printRequest = useRef<AbortController | null>(null);
  // Produtos lane (202610200236): Marcadores of the page; an unconfirmed "Editar tags" is protected like a form.
  const invoiceTags = useInvoiceTags(controller, 'brufap', config.model, page?.items ?? [], writable);
  // Leaving the screen while the PDF task reads the XMLs asks first (the file would be lost).
  const guard = useUnsavedChanges(Boolean(invoiceTags.pending?.uncertain) || Boolean(pdfJob?.running), printing || Boolean(pdfJob?.running) || Boolean(invoiceTags.pending?.busy || invoiceTags.pending?.uncertain));
  // "Listagem customizada" and "Tornar padrão" per user (migration 116); Número and Situação stay fixed.
  const columnCatalog = fiscalColumns(config);
  const prefs = useListPreferences(controller, LIST_IDS[screen], { available: columnCatalog.map(c => c.id), defaults: defaultColumns(config) });
  const prefsApplied = useRef(false);
  useEffect(() => { const life = lifetime.current; return () => { life.abort(); detail.current?.abort(); printRequest.current?.abort(); pdfJobRequest.current?.abort(); }; }, []);
  // A new screen or profile restarts filters, selection and dialogs.
  const scope = useRef(screen);
  useEffect(() => {
    if (scope.current === screen) return;
    scope.current = screen;
    setFilters(emptyFilters(config)); setDraft(emptyFilters(config)); setListPage(1); setOrder('date_desc'); setSelected(new Set()); setDialog(null); setNotice(''); setActionError('');
  }, [screen]);
  useEffect(() => {
    if (opened || backupTab) return;
    const request = new AbortController(); setLoading(true); setError('');
    let query: URLSearchParams;
    try { query = fiscalListQuery(config, filters, { page: listPage, order }); } catch (problem) { setError((problem as Error).message); setLoading(false); return () => request.abort(); }
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}?${query}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const checked = checkListPage(value, { origin: 'brufap', model: config.model, direction: config.direction, page: listPage, limit: FISCAL_PAGE_SIZE, order });
      if (checked.total_count > 0 && !checked.items.length && listPage > pageCount(checked.total_count)) { setListPage(pageCount(checked.total_count)); return; }
      setPage(checked); setLoading(false);
    }).catch(problem => { if (request.signal.aborted || aborted(problem)) return; setPage(null); setLoading(false); setError(problem instanceof AccessError ? failureText(problem) : 'A resposta da listagem não pôde ser conferida. Recarregue a página.'); });
    return () => request.abort();
  }, [controller, screen, filters, listPage, order, reload, opened, backupTab]);
  useEffect(() => { setSelected(new Set()); setAnchor(null); setMenu(null); }, [page]);
  // "P" Preços atualizados (202610200252): the price formation recorded on the Brufap entry notes of the page.
  const [pricing, setPricing] = useState<Record<string, PricingState>>({});
  useEffect(() => {
    const ids = screen === 'entrada' ? (page?.items ?? []).map(row => row.id) : [];
    setPricing({});
    if (!ids.length) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/precos?${new URLSearchParams({ ids: ids.join(',') })}`, { signal: request.signal })).then(value => {
      if (!request.signal.aborted) setPricing(Object.fromEntries(pricingStates(value, ids).map(state => [state.invoice_id, state])));
    }).catch(() => { if (!request.signal.aborted) setPricing({}); });
    return () => request.abort();
  }, [controller, screen, page]);
  // Saved default filters apply once, on the first load of the screen.
  useEffect(() => {
    if (prefsApplied.current || prefs.loading) return;
    prefsApplied.current = true;
    const saved = filtersFromPreference(config, prefs.filters);
    if (saved) { setFilters(saved); setDraft(saved); setListPage(1); }
  }, [prefs.loading, prefs.filters]);
  useEffect(() => {
    const q = productQuery.trim();
    if (q.length < 2) { setProducts([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: '25', q })}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setProducts((value as CatalogPage).items ?? []); }).catch(() => { if (!request.signal.aborted) setProducts([]); }); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, productQuery]);
  useEffect(() => {
    const q = sellerQuery.trim();
    if (q.length < 2 || !config.sellerFilter) { setSellers([]); return; }
    const request = new AbortController();
    const timer = setTimeout(() => { void controller.catalog(`/v1/cadastros/vendedores/opcoes?${new URLSearchParams({ q })}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return;
      const items = (value as { items?: unknown }).items;
      setSellers(Array.isArray(items) ? items.filter((s): s is { id: string; name: string; code: string | null } => typeof s?.id === 'string' && typeof s.name === 'string').slice(0, 25) : []);
    }).catch(() => { if (!request.signal.aborted) setSellers([]); }); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, sellerQuery, config.sellerFilter]);
  useEffect(() => {
    if (!customOpen || !config.categoryFilter || categories) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.documents('/v1/documentos/sales_orders/categorias', { signal: request.signal })).then(value => { if (!request.signal.aborted) { setCategories(readCategoryChoices(value).items); setCategoryError(''); } })
      .catch(() => { if (!request.signal.aborted) setCategoryError('Não foi possível carregar as categorias financeiras.'); });
    return () => request.abort();
  }, [controller, customOpen, config.categoryFilter, categories]);

  const rows = page?.items ?? [], keyOf = (row: ListRow) => `${row.origin}:${row.id}`, ids = rows.map(keyOf), selectedRows = rows.filter(row => selected.has(keyOf(row)));
  // Letra C: the contas lançadas by the notes of the Brufap of this page (one read of up to 100, ignored when it fails).
  const [financeFlags, setFinanceFlags] = useState<{ key: string; value: InvoiceFlags | null }>({ key: '', value: null }), [financeRow, setFinanceRow] = useState<ListRow | null>(null), [financeReload, setFinanceReload] = useState(0);
  const nativeIds = rows.map(row => row.id), flagsKey = `${nativeIds.join(',')}:${financeReload}:${role}`;
  useEffect(() => {
    if (!nativeIds.length || typeof controller.finance !== 'function') return; const request = new AbortController();
    void controller.finance(`/v1/financeiro/notas-contas?${new URLSearchParams({ ids: nativeIds.join(',') })}`, { signal: request.signal })
      .then(value => { if (!request.signal.aborted) setFinanceFlags({ key: flagsKey, value: invoiceFlags(value, nativeIds) }); })
      .catch(() => { if (!request.signal.aborted) setFinanceFlags({ key: flagsKey, value: null }); });
    return () => request.abort();
  }, [controller, flagsKey]);
  const flags = financeFlags.key === flagsKey ? financeFlags.value : null;
  const financeState = (row: ListRow): InvoiceFinanceState => !flags ? null : { writable: ['admin', 'financeiro'].includes(role), posted: Boolean(flags.get(row.id)?.posted), grouped: Boolean(flags.get(row.id)?.grouped) };
  // Estoque lane (259): the stock state of the Brufap notes of the page (letter E and the ⋮ stock actions).
  const [stockReload, setStockReload] = useState(0), [stockDialog, setStockDialog] = useState<{ row: ListRow; mode: 'post' | 'reverse' } | null>(null);
  const stockFlags = useInvoiceStockFlags(controller, rows.map(row => row.id), reload + stockReload);
  const rowStock = (row: ListRow) => { const value = stockFlags.flags?.get(row.id);
    return value ? { flag: value.flag, reference: value.reference?.number ?? null, manage: ['admin', 'estoque'].includes(role) } : null; };
  const setParam = (changes: Record<string, string | null>, replace = false) => { const next = new URLSearchParams(location.search); for (const [k, v] of Object.entries(changes)) v === null ? next.delete(k) : next.set(k, v); navigate(`${location.pathname}?${next}`, { replace }); };
  const rowPath = (row: ListRow) => { const next = new URLSearchParams(location.search); next.set('nota', row.id); return `${location.pathname}?${next}`; };
  const open = (row: ListRow, event: { ctrlKey?: boolean; metaKey?: boolean; button?: number } = {}) => {
    if (opensInNewTab(event)) { globalThis.window?.open(rowPath(row), '_blank', 'noopener'); return; }
    guard.confirmLeave(() => { setOpening(null); setParam({ nota: row.id }); });
  };
  const apply = (next: FiscalFilters) => { try { fiscalListQuery(config, next); } catch (problem) { setError((problem as Error).message); return; } setError(''); setFilters(next); setDraft(next); setListPage(1); setNotice(''); setActionError(''); };
  const submit = (event: FormEvent) => { event.preventDefault(); apply({ ...draft, query: draft.query.trim() }); };
  const readRecord = async (id: string, signal: AbortSignal) => {
    const value = await controller.fiscalInvoices(`${FISCAL_BASE}/${id}`, { signal }) as { invoice: unknown };
    const record = invoiceRecord(value?.invoice);
    if (record.id !== id || entryOnly && record.direction !== '0') throw new AccessError(502);
    return record;
  };
  const withRecord = (row: ListRow, then: (record: InvoiceRecord) => void) => {
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError('');
    void readRecord(row.id, request.signal).then(record => { if (!request.signal.aborted && detail.current === request) then(record); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setActionError(failureText(problem)); }).finally(() => { if (detail.current === request) detail.current = null; });
  };
  const startForm = (value: FormOpening) => {
    if (exitAction(value.kind)) { setActionError(closedExit); return; }
    guard.confirmLeave(() => { setOpening(value); setParam({ nota: 'nova' }); });
  };
  // "Incluir NFC-e" without an active A1 asks first, like Origin: "Sem a configuração do certificado não é possível emitir a NFC-e".
  const addNote = async () => {
    if (config.model !== '65') { startForm({ kind: 'new' }); return; }
    let active = false;
    try { const value = await controller.a1?.('/v1/a1', { signal: lifetime.current.signal }) as { state?: string; time_valid_now?: boolean } | { current?: { state?: string; time_valid_now?: boolean } } | undefined;
      const current = (value && 'current' in value ? value.current : value) as { state?: string; time_valid_now?: boolean } | undefined;
      active = current?.state === 'configured_offline' && current.time_valid_now === true; } catch { active = false; }
    if (lifetime.current.signal.aborted) return;
    if (active) startForm({ kind: 'new' });
    else setDialog({ type: 'certificate', text: 'Sem a configuração do certificado não é possível emitir a NFC-e, deseja prosseguir mesmo assim?' });
  };
  const runAction = (row: ListRow, action: RowAction) => {
    setMenu(null);
    if (!action.enabled) return;
    if (exitAction(action.id)) { setActionError(closedExit); return; }
    if (action.id === 'edit' || action.id === 'view') { open(row); return; }
    if (action.id === 'other') { setDialog({ type: 'other', row }); return; }
    if (action.id === 'xml') { void showXml(row, true); return; }
    if (action.id === 'support_xml') { void openNativeXml(row, 'support'); return; }
    if (action.id === 'cancel' || action.id === 'correction') { withRecord(row, record => setDialog({ type: action.id as 'cancel', record })); return; }
    if (action.id === 'mirror') { withRecord(row, record => setMirror(record)); return; }
    if (action.id === 'pricing') { setDialog({ type: 'pricing', row }); return; }
    if (action.id === 'danfe' || action.id === 'danfe_simple' || action.id === 'pdf') { void printDanfe([row], action.id === 'danfe_simple' ? 'simple' : config.model === '65' ? 'nfce' : 'a4', action.id === 'pdf'); return; }
    if (action.id === 'checkin') { guard.confirmLeave(() => navigate(checkinHref(row.id))); return; }
    if (action.id === 'stock' || action.id === 'stock_reverse') { setNotice(''); setStockDialog({ row, mode: action.id === 'stock' ? 'post' : 'reverse' }); return; }
    if (action.id === 'labels') { guard.confirmLeave(() => navigate(`/preferencias/sistema/etiquetas-customizadas?nota=${row.id}`)); return; }
    if (action.id === 'finance' || action.id === 'boleto') { setFinanceRow(row); return; }
    const clone = (kind: 'clone' | 'clone_invert' | 'nfe_from_nfce' | 'complementary' | 'return') => {
      withRecord(row, record => kind !== 'return' ? startForm({ kind, record }) : record.access_key ? setDialog({ type: 'return', record }) : setActionError('A devolução precisa da chave de acesso da nota.'));
    };
    if (['clone', 'clone_invert', 'nfe_from_nfce', 'complementary', 'return'].includes(action.id)) clone(action.id as 'clone');
  };
  // "Devolução de produto" (wave E): another note found inside the modal by the Nº do pedido or the number / access key (barcode reader).
  const findReturnSource = async ({ order, note }: { order: string; note: string }): Promise<string | null> => {
    detail.current?.abort(); const request = new AbortController(); detail.current = request;
    const digits = note.replace(/\D/g, '');
    if (note && (!digits || (digits.length !== 44 && digits.length > 9))) return 'Informe o número da nota (até 9 dígitos) ou a chave de acesso (44 dígitos).';
    try {
      const filters = { ...emptyFilters(config), ...(note ? { query: digits } : { custom: { order_number: order } }) };
      const found = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, filters, { page: 1 })}`, { signal: request.signal }),
        { origin: 'brufap', model: config.model, direction: config.direction, page: 1, limit: FISCAL_PAGE_SIZE, order: 'date_desc' }).items
        .filter(row => !note || (digits.length === 44 ? row.access_key === digits : row.number === Number(digits)));
      if (request.signal.aborted) return null;
      const row = found.find(r => r.access_key && (r.status === 6 || r.status === 7 || r.status === 8));
      if (!row) return found.length ? 'A nota encontrada não tem chave de acesso autorizada para a devolução.' : `Nenhuma nota encontrada em Registros do ERP com ${note ? 'esse número ou chave' : 'esse número de pedido'}.`;
      const record = await readRecord(row.id, request.signal); if (!request.signal.aborted) setDialog({ type: 'return', record });
      return null;
    } catch (problem) { return request.signal.aborted || aborted(problem) ? null : problem instanceof AccessError ? failureText(problem) : 'Não foi possível buscar a nota.'; }
    finally { if (detail.current === request) detail.current = null; }
  };
  const menuItems = (row: ListRow): RowMenuItem[] => rowActions(config, row, { writable, checkin: CHECKIN_READERS.includes(role), labels: role === 'admin', finance: financeState(row), stock: rowStock(row) }).map(action => ({ label: action.label, icon: action.icon, separatorBefore: action.separatorBefore,
    disabled: !action.enabled || exitAction(action.id), title: exitAction(action.id) ? closedExit : action.enabled ? undefined : action.reason, onClick: () => runAction(row, action) }));
  // Vinki: Origin fora (motor 91213b8): o XML de uma nota do FAGOO é o importado; o acervo sincronizado do Origin (xml_id) saiu.
  const hasXml = (row: ListRow) => isImported(row);
  const showXml = async (row: ListRow, download: boolean) => {
    if (!hasXml(row)) return;
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError('');
    try {
      // Imported notes keep their XML in Brufap (checked by size, SHA-256 and access key).
      const file = await importedXml(controller, row.id, request.signal), text = file.xml; if (download && !request.signal.aborted) saveFile(xmlFileName(file.access_key), file.xml, 'application/xml');
      if (!request.signal.aborted && !download) setDialog({ type: 'xml', row, text });
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setActionError('Não foi possível conferir o XML. Nenhum arquivo foi entregue.'); }
  };
  // "Validar" / "Gerar XML (suporte)": the Worker builds the XML from the saved note and checks it; a late answer, another row action,
  // another user or a profile that no longer writes notes never shows it.
  const openNativeXml = async (row: ListRow, mode: 'validate' | 'support') => {
    const block = nativeXmlBlock(row, writable);
    if (block) { setActionError(block); return; }
    detail.current?.abort(); const request = new AbortController(); detail.current = request; setActionError(''); const actor = actorOf(controller);
    try {
      const result = await nativeXmlResult(await controller.fiscalInvoices(nativeXmlPath(row.id), { signal: request.signal }), row.id);
      if (request.signal.aborted || detail.current !== request) return;
      if (actorOf(controller) !== actor || !['admin', 'fiscal'].includes(roleOf(controller))) { setActionError('A sessão ou o perfil mudou. Abra a nota de novo.'); return; }
      setDialog({ type: 'native', mode, result });
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      setActionError(problem instanceof AccessError && problem.status === 422 ? 'Não foi possível gerar o XML desta nota com os dados salvos. Confira a nota e tente de novo.'
        : problem instanceof AccessError ? failureText(problem) : 'A resposta do XML gerado não pôde ser conferida. Nenhum arquivo foi entregue.');
    } finally { if (detail.current === request) detail.current = null; }
  };
  const copyKey = async (key: string) => { try { await globalThis.navigator?.clipboard?.writeText(key); setNotice('Chave de acesso copiada.'); } catch { setActionError('Não foi possível copiar a chave de acesso.'); } };
  // ---- Batch deletion (Brufap notes only) ----
  // The lançamentos already read for the page (letters C and E): a note that cannot be deleted is listed with the reason before asking.
  const deleteEffects = (row: ListRow): DeleteEffects | null => ({ finance: financeState(row), stock: rowStock(row) });
  const openDelete = () => { if (!selectedRows.length) return; batchActor.current = actorOf(controller); setReason(''); setDialog({ type: 'delete', rows: selectedRows.slice() }); };
  const runDelete = async ({ row }: DeleteItem) => {
    if (lifetime.current.signal.aborted || actorOf(controller) !== batchActor.current || !['admin', 'fiscal'].includes(roleOf(controller))) throw new Error('A sessão ou o perfil mudou. Esta nota não foi excluída.');
    const body = { command_id: crypto.randomUUID(), expected_version: row.version, reason: reason.trim() };
    const send = () => controller.fiscalInvoices(`${FISCAL_BASE}/${row.id}/excluir`, { method: 'POST', body, signal: lifetime.current.signal });
    const verify = (value: unknown) => { const record = invoiceRecord((value as { invoice: unknown })?.invoice); if (record.id !== row.id || !record.deleted_at) throw new AccessError(502); };
    try { verify(await send()); return { message: 'Nota excluída. O XML e o histórico ficam preservados.' }; }
    catch (first) {
      // Notas lane (wave F): a note with contas (247) or stock (259) posted by it says which estorno comes first.
      if (known(first)) throw new Error((first instanceof AccessError && first.status === 409 ? deleteRefusalText(first.field, deleteEffects(row)) : null) ?? failureText(first));
      const unconfirmed = { uncertain: true, message: `Resultado não confirmado. Confira a nota ${invoiceNumber(row)} antes de repetir.` };
      if (lifetime.current.signal.aborted || actorOf(controller) !== batchActor.current) return unconfirmed;
      try { verify(await send()); return { message: 'Nota excluída (confirmada ao repetir o mesmo comando).' }; } catch { return unconfirmed; }
    }
  };
  const closeDelete = (results: BatchResult[] | null) => { setDialog(null); if (results?.some(r => r.outcome === 'ok' || r.outcome === 'uncertain')) setReload(n => n + 1); };
  // ---- Print listing: every page of the current filter, up to 1.000 notes ----
  const printList = async () => {
    if (printing || !page) return;
    // Another row action still cancels the gathering (detail), but only the print request decides when "printing" ends.
    const request = new AbortController(); detail.current?.abort(); detail.current = request; printRequest.current = request; setPrinting(true); setActionError('');
    try {
      const all: ListRow[] = [], pages = Math.min(10, pageCount(page.total_count));
      for (let n = 1; n <= pages; n++) {
        const query = fiscalListQuery(config, filters, { page: n, order });
        const value = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${query}`, { signal: request.signal }), { origin: 'brufap', model: config.model, direction: config.direction, page: n, limit: FISCAL_PAGE_SIZE, order });
        if (request.signal.aborted) return; all.push(...value.items);
      }
      setPrintRows(all);
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setActionError('Não foi possível reunir a listagem para impressão.'); }
    finally { if (detail.current === request) detail.current = null; if (printRequest.current === request) { printRequest.current = null; setPrinting(false); } }
  };

  // ---- DANFE from the checked XML of each note (imported XML), at most 50 notes per preview ----
  const danfeDocument = async (row: ListRow, signal: AbortSignal): Promise<DanfeDocument> => {
    const xml = (await importedXml(controller, row.id, signal)).xml;
    const data = danfeData(xml);
    if ((row.access_key && data.key !== row.access_key) || data.model !== config.model) throw new DanfeError('DANFE_KEY_INVALID');
    return { data, status: row.status === 3 ? 'cancelled' : row.status === 10 ? 'denied' : null };
  };
  const printDanfe = async (rows: ListRow[], layout: DanfeLayout, pdf = false) => {
    if (printing || !rows.length) return;
    const request = new AbortController(); detail.current?.abort(); detail.current = request; printRequest.current = request; setPrinting(true); setActionError('');
    const ready = rows.filter(danfeReady), problems = rows.filter(row => !danfeReady(row)).map(row => `Nota ${invoiceNumber(row)}: sem XML autorizado para o DANFE.`);
    const chosen = ready.slice(0, 50); if (ready.length > 50) problems.push(`${ready.length - 50} nota(s) além das 50 primeiras ficaram para outra impressão.`);
    const title = layout === 'simple' ? 'DANFE Simplificado' : layout === 'nfce' ? 'DANFE NFC-e' : pdf ? 'Gerar PDF DANFE' : 'Imprimir DANFE';
    let settings = DEFAULT_DANFE_SETTINGS;
    try {
      try { settings = danfeSettings((await controller.preferences('/v1/preferencias/notas-nfe', { signal: request.signal }) as { items?: { key: string; value: unknown }[] })?.items); } catch (problem) { if (request.signal.aborted) return; void problem; }
      const documents: DanfeDocument[] = [];
      setDanfe({ title, layout, documents: [], settings, progress: chosen.length ? `Lendo o XML 1 de ${chosen.length}…` : undefined, problems: [...problems], pdf });
      for (const [index, row] of chosen.entries()) {
        try { documents.push(await danfeDocument(row, request.signal)); }
        catch (problem) { if (request.signal.aborted) return; problems.push(`Nota ${invoiceNumber(row)}: ${problem instanceof DanfeError ? danfeErrorText(problem) : 'não foi possível conferir o XML.'}`); }
        if (request.signal.aborted) return;
        setDanfe({ title, layout, documents: [...documents], settings, progress: index + 1 < chosen.length ? `Lendo o XML ${index + 2} de ${chosen.length}…` : undefined, problems: [...problems], pdf });
      }
    } finally { if (detail.current === request) detail.current = null; if (printRequest.current === request) { printRequest.current = null; setPrinting(false); } }
  };
  const closeDanfe = () => { printRequest.current?.abort(); setDanfe(null); };
  // "Gerar PDF DANFE" of the panel (Selecionadas | Período): a background task of the list that reads the checked XML of each note, up to
  // 1.000, and ends with one PDF or a ZIP with one PDF per note. Row actions never cancel it; Cancelar, leaving the screen or another user do.
  const startPdfJob = async (source: { rows: ListRow[] } | { from: string; to: string }) => {
    if (pdfJob?.running) return;
    const request = new AbortController(), actor = actorOf(controller), format = pdfFormat;
    pdfJobRequest.current?.abort(); pdfJobRequest.current = request; setDialog(null); setActionError('');
    let state = newDanfeJob(format);
    const publish = (next: Partial<DanfeJobState>) => { state = { ...state, ...next }; if (pdfJobRequest.current === request && !request.signal.aborted) setPdfJob(state); };
    publish({});
    try {
      let rows: ListRow[] = [], beyond = 0;
      if ('rows' in source) rows = source.rows;
      else {
        const scoped = { ...filters, from: source.from, to: source.to };
        for (let n = 1; n <= Math.ceil(DANFE_JOB_MAX / FISCAL_PAGE_SIZE); n++) {
          const value = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, scoped, { page: n, order })}`, { signal: request.signal }), { origin: 'brufap', model: config.model, direction: config.direction, page: n, limit: FISCAL_PAGE_SIZE, order });
          if (request.signal.aborted) return;
          rows.push(...value.items); if (n === 1) beyond = Math.max(0, value.total_count - DANFE_JOB_MAX); if (!value.has_more) break;
        }
        if (!rows.length) { publish({ running: false, error: 'Nenhuma nota no período escolhido.' }); return; }
      }
      const ready = rows.filter(danfeReady), chosen = ready.slice(0, DANFE_JOB_MAX);
      const problems = rows.filter(row => !danfeReady(row)).map(row => `Nota ${invoiceNumber(row)}: sem XML autorizado para o DANFE.`);
      beyond += ready.length - chosen.length;
      let settings = DEFAULT_DANFE_SETTINGS;
      try { settings = danfeSettings((await controller.preferences('/v1/preferencias/notas-nfe', { signal: request.signal }) as { items?: { key: string; value: unknown }[] })?.items); } catch (problem) { if (request.signal.aborted) return; void problem; }
      publish({ total: chosen.length, beyond, problems: [...problems] });
      const documents: DanfeDocument[] = [];
      for (const [index, row] of chosen.entries()) {
        if (request.signal.aborted) return;
        // The file is built for the user who asked for it: another session or a profile without the list stops the task.
        if (actorOf(controller) !== actor || !['admin', 'consulta', 'fiscal'].includes(roleOf(controller))) { publish({ running: false, error: 'A sessão ou o perfil mudou. O PDF DANFE não foi gerado.' }); request.abort(); return; }
        try { documents.push(await danfeDocument(row, request.signal)); }
        catch (problem) { if (request.signal.aborted) return; problems.push(`Nota ${invoiceNumber(row)}: ${problem instanceof DanfeError ? danfeErrorText(problem) : 'não foi possível conferir o XML.'}`); }
        publish({ done: index + 1, documents: documents.length, problems: [...problems] });
      }
      if (!documents.length) { publish({ running: false, error: 'Nenhuma nota tem XML autorizado conferido para o DANFE. Nenhum arquivo foi gerado.' }); return; }
      publish({ running: false, file: danfeJobFile(documents, settings, format) });
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) publish({ running: false, error: 'Não foi possível gerar o PDF DANFE. Nenhum arquivo foi gerado.' }); }
  };
  const cancelPdfJob = () => { pdfJobRequest.current?.abort(); setPdfJob(current => current && current.running ? { ...current, running: false, cancelled: true } : current); };
  const closePdfJob = () => { pdfJobRequest.current?.abort(); pdfJobRequest.current = null; setPdfJob(null); };

  // Leva H (NFE-209): the products of the selected Brufap entry notes for the product labels.
  const [productLabels, setProductLabels] = useState<PurchaseLabels | null>(null);
  const printProductLabels = async () => {
    if (printing) return;
    const rows = selectedRows.slice(0, 60); if (!rows.length) return;
    const request = new AbortController(); detail.current?.abort(); detail.current = request; printRequest.current = request; setPrinting(true); setActionError('');
    try {
      const records = [];
      for (const row of rows) { records.push(await readRecord(row.id, request.signal)); if (request.signal.aborted) return; }
      const labels = invoiceLabelProducts(records as unknown as { items: Record<string, unknown>[] }[]);
      if (!labels.products.length) setActionError('As notas selecionadas não têm produtos cadastrados para etiqueta.'); else setProductLabels(labels);
    } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setActionError('Não foi possível ler as notas selecionadas para as etiquetas.'); }
    finally { if (detail.current === request) detail.current = null; if (printRequest.current === request) { printRequest.current = null; setPrinting(false); } }
  };
  // "Etiquetas selecionadas": each selected note is read (Brufap record) and printed as an A4 address label.
  const printLabels = async () => {
    if (printing || !selectedRows.length) return;
    const request = new AbortController(); detail.current?.abort(); detail.current = request; printRequest.current = request; setPrinting(true); setActionError('');
    try {
      const out: AddressLabel[] = [];
      for (const row of selectedRows.slice(0, 100)) {
        const record = await readRecord(row.id, request.signal); out.push(noteLabel(row, record.recipient, record.transport.delivery));
        if (request.signal.aborted) return;
      }
      setLabels(out);
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setActionError('Não foi possível reunir os endereços das notas selecionadas.'); }
    finally { if (detail.current === request) detail.current = null; if (printRequest.current === request) { printRequest.current = null; setPrinting(false); } }
  };

  if (opened) {
    const back = () => { setOpening(null); setParam({ nota: null, pedido: null, secao: null }); setReload(n => n + 1); };
    if (opened !== 'nova' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opened)) return <section className="real-state-panel"><h1>Nota não encontrada</h1><button type="button" className="secondary-button" onClick={back}>Voltar à listagem</button></section>;
    // Like the emitter: a same-actor role loss hides the form but keeps a pending command for when access returns.
    const denied = <section className="real-state-panel"><h1>Nota do ERP não liberada</h1><p>Somente administradores e o perfil fiscal abrem as notas de homologação do ERP. Uma confirmação pendente fica preservada até o acesso voltar.</p><button type="button" className="secondary-button" onClick={back}>Voltar à listagem</button></section>;
    if (!writable && !formHeld) return denied;
    return <>{!writable && denied}<div hidden={!writable} inert={!writable} aria-hidden={!writable}><FiscalInvoiceForm key={`${opened}:${opening ? 'copy' : fromOrder ? `pedido:${fromOrder}` : fromGroup ? `grupo:${fromGroup.join(',')}` : 'plain'}`} controller={controller} config={config} directionOnly={entryOnly ? '0' : undefined} id={opened === 'nova' ? null : opened}
      opening={opened === 'nova' ? opening ?? (fromOrder ? { kind: 'order', documentId: fromOrder } : fromGroup ? { kind: 'order', documentId: fromGroup[0]!, documentIds: fromGroup } : { kind: 'new' }) : null} today={today()} initialTab={section}
      onBack={back} onSaved={record => {
        setOpening(null);
        // "Clonar para entrada/saída" and "Gerar NF-e" save a note of another list: open it where Origin lists it.
        const path = record.direction === '0' ? '/notas-entrada' : '/historico-fiscal';
        if (path === location.pathname && (path === '/notas-entrada' || record.model === config.model)) setParam({ nota: record.id, pedido: null, secao: null }, true);
        else navigate(`${path}?${new URLSearchParams({ ...(path === '/historico-fiscal' ? { modelo: record.model } : {}), nota: record.id })}`, { replace: true });
      }} /></div></>;
  }

  const backupTabs = backup && <nav className="origin-list-tabs fiscal-entry-tabs" role="tablist" aria-label="Origem das notas fiscais">
    <button type="button" role="tab" aria-selected={!backupTab} onClick={() => guard.confirmLeave(() => setParam({ aba: null }))}>Notas fiscais</button>
    <button type="button" role="tab" aria-selected={backupTab} onClick={() => guard.confirmLeave(() => setParam({ aba: 'backup', nota: null }))}>Arquivo do backup importado</button></nav>;
  if (backupTab) return <section className="fiscal-invoices">{backupTabs}{backup}</section>;
  const total = page?.total_count ?? 0;
  const chips = filterChips(config, filters).map(chip => ({ label: chip.label, onRemove: () => apply(chip.key === 'query' ? { ...filters, query: '' } : chip.key === 'status' ? { ...filters, status: '' } : chip.key === 'product' ? { ...filters, product: null }
    : chip.key === 'seller' ? { ...filters, seller: null } : chip.key === 'tag' ? { ...filters, tag: null } : chip.key === 'category' ? { ...filters, category: null }
    : chip.key === 'state' ? { ...filters, state: '' } : { ...filters, custom: { ...filters.custom, [chip.key.slice(7)]: '' } }) }));
  const dateLabel = config.dateTypes.find(type => type.value === filters.dateType)?.label;
  // Origin: Marcadores (fixo) right after Valor; on Notas de compra the Vinculação badge comes after the Marcadores.
  const linkLast = screen === 'entrada' && prefs.columns.includes('link'), layout = columnLayout(prefs.columns).filter(column => !linkLast || column !== 'link');
  const cell = (row: ListRow, column: FiscalColumn | 'status'): ReactNode => {
    switch (column) {
      case 'date': return brDay(screen === 'entrada' && filters.dateType !== 'issue' ? row.entry_date ?? row.issue_date : row.issue_date);
      case 'issue_date': return brDay(row.issue_date);
      case 'entry_date': case 'exit_date': return brDay(row.entry_date);
      case 'series': return row.series ?? '—';
      case 'order_numbers': return row.orders.map(o => o.number).join(', ') || '—';
      case 'nature': return row.nature ?? '—';
      case 'name': return row.name ?? '—';
      case 'document': return formatDocument(row.document);
      case 'state': return row.state ?? '—';
      case 'link': return <span className={`status-badge ${row.orders.length ? 'status-success' : 'status-neutral'}`}>{linkLabel(row)}</span>;
      case 'total': return row.total_known ? decimalMoney(row.total) : '—';
      case 'status': return config.plainStatus ? <span className="fiscal-plain-status" title={fiscalStateText(row)}>{statusLabel(row, config.model)}</span> : <span className={statusClass(row, config.model)} title={fiscalStateText(row)}>{statusLabel(row, config.model)}</span>;
    }
  };
  const homologationNotice = <p className="real-notice fiscal-homologation-notice">Registros próprios e XMLs importados no ERP. Os testes marcados como Homologação são sem valor fiscal. O ambiente de cada documento aparece na linha. Salvar um rascunho não envia, não lança estoque nem contas.</p>;
  return <section className="fiscal-invoices">
    {backupTabs}
    {screen === 'entrada' && <nav className="origin-list-tabs fiscal-entry-tabs" role="tablist" aria-label="Notas fiscais de entrada"><button type="button" role="tab" aria-selected={true}>Notas de compra</button><button type="button" role="tab" aria-selected={false} onClick={() => guard.confirmLeave(() => navigate('/notas-recebidas'))}>Notas recebidas</button></nav>}
    <OriginListHeader title={config.title}
      primary={writable ? <button type="button" className="primary-button" title="Abre um rascunho técnico em homologação, sem valor fiscal, na área do ERP." onClick={() => void addNote()}><Icon name="plus" size={12} /> {config.addLabel}</button> : undefined} />
    {homologationNotice}
    <form onSubmit={submit} aria-label="Filtros das notas fiscais">
      <NativeListLayout filters={<>
        <div className="form-field"><label htmlFor="fiscal-status">Situação</label><select id="fiscal-status" value={draft.status} onChange={event => { const value = event.target.value; setDraft(d => ({ ...d, status: value })); }}>{config.statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="fiscal-product-search">Produto</label>{draft.product ? <span className="documents-picked"><span>{draft.product.name}</span><button type="button" className="text-button" onClick={() => setDraft(d => ({ ...d, product: null }))}>Trocar</button></span>
          : <><input id="fiscal-product-search" type="search" maxLength={120} placeholder="Pesquise por código ou descrição" value={productQuery} onChange={event => setProductQuery(event.target.value)} />
            <select id="fiscal-product" aria-label="Selecionar produto" value="" disabled={!products.length} onChange={event => { const found = products.find(p => p.id === event.target.value); if (found) { setDraft(d => ({ ...d, product: { id: found.id, name: found.name, code: found.code } })); setProductQuery(''); } }}><option value="">{products.length ? 'Selecione o produto' : 'Digite ao menos 2 letras'}</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}{p.code ? ` · ${p.code}` : ''}</option>)}</select></>}</div>
        {config.sellerFilter && <div className="form-field"><label htmlFor="fiscal-seller-search">Vendedor</label>{draft.seller ? <span className="documents-picked"><span>{draft.seller.name}</span><button type="button" className="text-button" onClick={() => setDraft(d => ({ ...d, seller: null }))}>Trocar</button></span>
          : <><input id="fiscal-seller-search" type="search" maxLength={120} placeholder="Pesquise pelo nome do vendedor" value={sellerQuery} onChange={event => setSellerQuery(event.target.value)} />
            <select id="fiscal-seller" aria-label="Selecionar vendedor" value="" disabled={!sellers.length} onChange={event => { const found = sellers.find(s => s.id === event.target.value); if (found) { setDraft(d => ({ ...d, seller: { id: found.id, name: found.name, code: found.code } })); setSellerQuery(''); } }}><option value="">{sellers.length ? 'Selecione o vendedor' : 'Digite ao menos 2 letras'}</option>{sellers.map(s => <option key={s.id} value={s.id}>{s.name}{s.code ? ` · ${s.code}` : ''}</option>)}</select></>}</div>}
        <InvoiceTagFilter state={invoiceTags} value={draft.tag ?? null} onChange={tag => setDraft(d => ({ ...d, tag }))} />
        <div className="form-field"><label htmlFor="fiscal-state">UF</label><select id="fiscal-state" value={draft.state} onChange={event => { const value = event.target.value; setDraft(d => ({ ...d, state: value })); }}><option value="">UF ...</option>{UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
        <div className="fiscal-custom-search"><button type="button" className="text-button" aria-expanded={customOpen} onClick={() => setCustomOpen(v => !v)}><Icon name="plus" size={10} /> Adicionar filtros</button>
          {customOpen && config.customFilters.map((key: CustomFilter) => <div className="form-field" key={key}><label htmlFor={`fiscal-custom-${key}`}>{CUSTOM_FILTER_LABELS[key]}</label>{key === 'person_type'
            ? <select id={`fiscal-custom-${key}`} value={draft.custom[key] ?? ''} onChange={event => { const value = event.target.value; setDraft(d => ({ ...d, custom: { ...d.custom, [key]: value } })); }}><option value="">Todos</option>{(['J', 'F', 'E'] as const).map(v => <option key={v} value={v}>{PERSON_LABELS[v]}</option>)}</select>
            : <input id={`fiscal-custom-${key}`} maxLength={key === 'series' ? 3 : 120} value={draft.custom[key] ?? ''} onChange={event => { const value = event.target.value; setDraft(d => ({ ...d, custom: { ...d.custom, [key]: value } })); }} />}</div>)}
          {customOpen && config.categoryFilter && <div className="form-field"><label htmlFor="fiscal-custom-category">Categoria</label>
            <select id="fiscal-custom-category" value={draft.category?.id ?? ''} disabled={!categories} onChange={event => { const found = categories?.find(c => c.id === event.target.value); setDraft(d => ({ ...d, category: found ? { id: found.id, name: found.name } : null })); }}>
              <option value="">{categories ? 'Todas' : 'Carregando categorias…'}</option>{(categories ?? []).map(c => <option key={c.id} value={c.id}>{`${' '.repeat((c.depth - 1) * 2)}${c.name}`}</option>)}</select>
            <small className="real-help">{categoryError || 'Categoria financeira das contas lançadas pela nota.'}</small></div>}
          {customOpen && <p className="real-help">{NOT_APPLICABLE_FILTERS}</p>}</div>
        <button type="submit" className="primary-button" disabled={loading}>Filtrar</button>
      </>} actions={<>
        <div className="documents-panel-actions">
          {writable && <button type="button" className="origin-action" title="Rascunho do ERP, sem valor fiscal." onClick={() => void addNote()}><Icon name="plus" size={15} /><span>{config.addLabel}</span></button>}
          <button type="button" className="origin-action" disabled title="O envio à SEFAZ das notas do ERP ainda não está ligado nesta tela."><Icon name="paper-plane" size={15} /><span>{config.model === '65' ? 'Autorizar NFC-es selecionadas' : 'Enviar NF-es selecionadas'}</span></button>
          {config.model === '55' && <button type="button" className="origin-action" disabled={!selectedRows.length || printing} title={selectedRows.length ? 'DANFE das notas selecionadas com XML autorizado (até 50).' : 'Selecione as notas.'} onClick={() => void printDanfe(selectedRows.slice(), 'a4')}><Icon name="print" size={15} /><span>Imprimir NF-es selecionadas</span></button>}
          {config.model === '55' && <button type="button" className="origin-action" disabled={!page || printing || Boolean(pdfJob?.running)} title={pdfJob?.running ? 'Um PDF DANFE já está sendo gerado.' : undefined} onClick={() => { setPdfMode(selectedRows.length ? 'selected' : 'period'); setPdfFrom(filters.from); setPdfTo(filters.to); setDialog({ type: 'danfe_pdf' }); }}><Icon name="file-pdf" size={15} /><span>Gerar PDF DANFE</span></button>}
          <button type="button" className="origin-action" disabled={!page} onClick={() => setDialog({ type: 'export', rows: selectedRows.slice() })}><Icon name="file-export" size={15} /><span>Exportar XML</span></button>
          {config.model === '55' && <button type="button" className="origin-action" disabled={!selectedRows.length || printing} title={selectedRows.length ? 'DANFE Simplificado - Etiqueta das notas selecionadas (até 50).' : 'Selecione as notas.'} onClick={() => void printDanfe(selectedRows.slice(), 'simple')}><Icon name="print" size={15} /><span>Imprimir DANFE Simplificado em lote</span></button>}
        </div>
        <div className="origin-more-group fiscal-more"><h3>Mais ações</h3>
          {config.model === '55' && (() => {
            // 202610200167 Origin "Importar › Pedido XML": opens the pedido (venda na saída, compra na entrada) built from the XML, for the profiles that include it.
            const kind = screen === 'entrada' ? 'purchase_orders' : 'sales_orders', allowed = (kind === 'purchase_orders' ? ['admin', 'estoque'] : ['admin', 'vendas']).includes(role);
            return <button type="button" disabled={!allowed} title={allowed ? `Monta um pedido de ${kind === 'purchase_orders' ? 'compra' : 'venda'} a partir do XML de uma NF-e autorizada, para conferir e salvar` : kind === 'purchase_orders' ? 'Somente administrador e estoque incluem pedidos de compra.' : 'Somente administrador e vendas incluem pedidos de venda.'}
              onClick={() => guard.confirmLeave(() => navigate(`/documentos-empresa?tipo=${kind}&acao=xml`))}>Importar Pedido XML</button>;
          })()}
          {config.model === '55' ? <button type="button" disabled={!writable} title={writable ? undefined : 'Somente administrador e fiscal importam XML.'} onClick={() => setDialog({ type: 'import' })}>Importar XML NF-e</button>
            : <button type="button" disabled={!writable} title={writable ? 'NFC-e autorizada emitida pela empresa (202610200274).' : 'Somente administrador e fiscal importam XML.'} onClick={() => setDialog({ type: 'import' })}>Importar XML</button>}
          <button type="button" disabled={!writable} title={!writable ? 'Somente administrador e fiscal.' : undefined} onClick={() => setDialog({ type: 'inutilization' })}>Inutilizar numeração</button>
          {config.model === '55' && <button type="button" disabled title="A emissão em produção continua desligada no ERP.">Mover para ambiente de produção</button>}
          {screen === 'nfe' && <><h4>Imprimir</h4>
            <button type="button" disabled title="As etiquetas de transporte das transportadoras são logística, fora do escopo do ERP.">Etiquetas de transporte</button>
            <button type="button" disabled title="A etiqueta de transporte é logística, fora do escopo do ERP. O DANFE Simplificado sozinho fica em Imprimir DANFE Simplificado em lote.">DANFE Simplificado + Etiqueta de transporte</button>
            <button type="button" disabled={!selectedRows.length || printing} title={selectedRows.length ? 'Etiquetas de endereço das notas selecionadas (o endereço de entrega tem prioridade).' : 'Selecione as notas.'} onClick={() => void printLabels()}>Etiquetas selecionadas</button></>}
          {/* Leva H (NFE-209): the product labels of the selected FAGOO entry notes (Cadastros › Produtos labels). */}
          {screen === 'entrada' && <><h4>Imprimir</h4><button type="button" disabled={!selectedRows.length || printing} title={selectedRows.length ? 'Etiquetas dos produtos das notas de entrada do ERP selecionadas (uma por quantidade).' : 'Selecione notas de entrada do ERP.'} onClick={() => void printProductLabels()}>Imprimir etiquetas selecionadas</button></>}
          {screen === 'entrada' && (['link', 'unlink'] as const).map(mode => {
            // "Vincular à pedido de compra" works on one note of Brufap at a time.
            const one = selectedRows.length === 1 ? selectedRows[0]! : null, reason = !writable ? 'Somente administrador e fiscal.' : !one ? 'Selecione uma nota por vez.'
              : mode === 'unlink' && !one.orders.length ? 'A nota não está vinculada a pedido de compra.' : null;
            return <button key={mode} type="button" disabled={Boolean(reason)} title={reason ?? undefined} onClick={() => one && setDialog({ type: 'link', row: one, mode })}>{mode === 'link' ? 'Vincular à pedido de compra' : 'Desvincular pedido compra'}</button>;
          })}
        </div>
        <div className="native-list-summary"><h3>Informações</h3>
          {/* "Exibir totais em listas de Notas Fiscais" (Preferências › Configurações de NF-e). */}
          {(!page || page.show_totals) && <><dl className="native-list-stat"><dt>{config.countLabel}</dt><dd>{page ? total.toLocaleString('pt-BR') : '—'}</dd></dl>
            <dl className="native-list-stat"><dt>Valor total</dt><dd>{decimalMoney(page?.total_amount ?? null)}</dd></dl></>}
          {selectedRows.length > 0 && <dl className="native-list-stat"><dt>selecionados</dt><dd>{selectedRows.length}</dd></dl>}
          {page && page.amount_unknown > 0 && <p className="real-help">{page.amount_unknown} nota(s) sem valor informado.</p>}
          <p className="real-help">Informações baseadas nos filtros aplicados.</p></div>
        <div className="origin-support"><h3>Ferramentas de apoio</h3>{/* Leva H (NFE-187): the FAGOO help, not the Origin manual. */}<button type="button" className="text-button" onClick={() => guard.confirmLeave(() => navigate('/ajuda/notas-fiscais'))}>Manual de notas fiscais</button><button type="button" className="text-button" onClick={() => guard.confirmLeave(() => navigate(config.model === '65' ? '/preferencias/notas-fiscais/nfce' : '/preferencias/notas-fiscais/nfe'))}>Acesse os parâmetros de nota fiscal</button></div>
      </>}>
        <div className="native-list-toolbar fiscal-toolbar"><div className="form-field"><label htmlFor="fiscal-search" className="sr-only">Pesquisar na listagem</label><input id="fiscal-search" type="search" maxLength={120} value={draft.query} placeholder={config.searchPlaceholder} onChange={event => { const value = event.target.value; setDraft(d => ({ ...d, query: value })); }} />
          {draft.query && <button type="button" className="icon-button" title="Limpar o campo" aria-label="Limpar o campo" onClick={() => apply({ ...filters, query: '' })}><Icon name="xmark" size={11} /></button>}</div>
          <button type="submit" className="secondary-button" aria-label="Pesquisar" title="Pesquisar" disabled={loading}><Icon name="search" size={16} /></button>
          <PeriodPicker key={`${screen}:${filters.dateType}`} from={filters.from} to={filters.to} today={today()} dateType={dateLabel} dateTypes={config.dateTypes.map(t => t.label)} prefixLabel={Boolean(config.dateTypes.length)}
            onApply={range => apply({ ...filters, from: range.from, to: range.to, dateType: config.dateTypes.find(t => t.label === range.dateType)?.value ?? filters.dateType })} />
          <ToolButton icon="print" title="Imprimir listagem de notas" disabled={!page || !total || printing} onClick={() => void printList()} />
          <ToolButton icon="trash-can" title={config.deleteLabel} disabled={!writable || !selectedRows.length} onClick={openDelete} />
        </div>
        <AppliedChips chips={chips} onClear={() => apply({ ...emptyFilters(config), from: filters.from, to: filters.to, dateType: filters.dateType })} />
        <ListPreferencesBar prefs={prefs} columns={columnCatalog} currentFilters={filtersToPreference(config, filters)} />
        {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
        {notice && <p className="real-success" role="status">{notice}</p>}
        {pdfJob && <FiscalDanfePdfJob state={pdfJob} onCancel={cancelPdfJob} onClose={closePdfJob} />}
        {actionError && <p className="real-alert" role="alert">{actionError}</p>}
        <InvoiceTagsOverlay controller={controller} state={invoiceTags} />
        <ListControls checked={rows.length > 0 && rows.every(row => selected.has(keyOf(row)))} onToggleAll={() => setSelected(rows.every(row => selected.has(keyOf(row))) ? new Set() : new Set(ids))} onRefresh={() => setReload(n => n + 1)} />
        <div className="real-result-status" role="status">{loading ? 'Carregando notas…' : page ? `${total.toLocaleString('pt-BR')} ${total === 1 ? 'nota encontrada' : 'notas encontradas'}${selectedRows.length ? ` · ${selectedRows.length} selecionados` : ''}` : ''}</div>
        {page && rows.length > 0 && <div className="table-scroll" tabIndex={0} aria-label={config.title}><table className="data-table real-table origin-table fiscal-table"><thead><tr><th className="checkbox-cell"><span className="sr-only">Seleção</span></th>
          <th aria-sort={order.startsWith('number') ? order.endsWith('desc') ? 'descending' : 'ascending' : undefined}><button type="button" className="documents-sort" disabled={loading} onClick={() => { setOrder(order === 'number_desc' ? 'number_asc' : 'number_desc'); setListPage(1); }}>Número</button></th>
          {layout.map(column => column === 'date' ? <th key={column} aria-sort={order.startsWith('date') ? order.endsWith('desc') ? 'descending' : 'ascending' : undefined}><button type="button" className="documents-sort" disabled={loading} onClick={() => { setOrder(order === 'date_desc' ? 'date_asc' : 'date_desc'); setListPage(1); }}>{screen === 'entrada' && filters.dateType === 'issue' ? 'Data de emissão' : config.dateColumn}</button></th>
            : column === 'status' ? <th key={column}>Situação</th> : <th key={column} className={column === 'total' ? 'numeric' : undefined}>{columnCatalog.find(c => c.id === column)?.label}</th>)}
          <th><span className="sr-only">Marcadores</span></th>{linkLast && <th>{columnCatalog.find(c => c.id === 'link')?.label}</th>}<th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
          <tbody>{rows.map(row => { const key = keyOf(row), priced = pricing[row.id], letter = invoiceStockLetter(stockFlags.flags?.get(row.id)), indicators = [...orderIndicators(row), ...financeIndicator(flags?.get(row.id)?.posted), ...(letter ? [letter] : []), ...(priced ? [{ text: 'P', color: 'red', title: pricingTitle(priced) }] : [])]; return <tr key={key} className={`fiscal-row${selected.has(key) ? ' selected' : ''}`} onClick={event => open(row, event)} onAuxClick={event => { if (event.button === 1) open(row, event); }}>
            <td className="checkbox-cell" onClick={event => event.stopPropagation?.()}><input type="checkbox" aria-label={`Selecionar nota ${invoiceNumber(row)}`} checked={selected.has(key)} onClick={event => { const result = selectRange(ids, selected, anchor, key, Boolean(event.shiftKey)); setSelected(result.selected); setAnchor(result.anchor); }} onChange={() => undefined} /></td>
            <td title={sourceLabel(row)}>{invoiceNumber(row)}<span className="origin-tag fiscal-homologation-tag">{row.source_environment === '2' ? 'Homologação · sem valor fiscal' : 'Origem ERP'}</span><small className="fiscal-source-line">{sourceLabel(row)}</small></td>
            {layout.map(column => <td key={column} className={column === 'total' ? 'numeric' : undefined}>{cell(row, column)}</td>)}
            <td><span className="origin-indicators">{indicators.map(indicator => <IndicatorLetter key={indicator.text} text={indicator.text} color={indicator.color} title={indicator.title} />)}</span><InvoiceTagCell state={invoiceTags} row={row} label={invoiceNumber(row)} /></td>
            {linkLast && <td>{cell(row, 'link')}</td>}
            <td className="row-actions" onClick={event => event.stopPropagation?.()}><RowMenu label={`nota ${invoiceNumber(row)}`} items={menuItems(row)} open={menu === key} onToggle={() => setMenu(v => v === key ? null : key)} /></td>
          </tr>; })}</tbody></table></div>}
        {page && !rows.length && <div className="empty-state"><h2>Nenhuma nota encontrada</h2><p>Inclua uma nota de teste ou ajuste os filtros.</p></div>}
        {page && total > 0 && <OriginPagination page={listPage} pages={pageCount(total)} size={FISCAL_PAGE_SIZE} total={total} onPage={value => { if (!loading && value !== listPage) setListPage(value); }} />}
      </NativeListLayout>
    </form>
    {dialog?.type === 'delete' && <BatchDialog title={config.deleteLabel} confirmLabel="Excluir" plan={deletePlan(dialog.rows, deleteEffects)} canConfirm={reason.trim().length >= 3} run={runDelete} onClose={closeDelete}
      description={<div className="fiscal-delete"><p className="real-notice">{config.deleteWarning}</p><div className="form-field"><label htmlFor="fiscal-delete-reason">Motivo da exclusão</label><input id="fiscal-delete-reason" maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></div>
        <p className="real-help">A exclusão é lógica: a nota sai da listagem, mas a versão, o motivo e o usuário ficam no histórico.</p></div>} />}
    {dialog?.type === 'inutilization' && <InutilizationDialog controller={controller} model={config.model} onClose={done => { setDialog(null); if (done) setNotice('Pedido de inutilização registrado em homologação. A transmissão à SEFAZ ainda não está disponível no ERP.'); }} />}
    {dialog?.type === 'cancel' && <CancelDialog controller={controller} record={dialog.record} onClose={done => { setDialog(null); if (done) { setNotice('Pedido de cancelamento registrado em homologação. A transmissão à SEFAZ ainda não está disponível no ERP.'); setReload(n => n + 1); } }} />}
    {dialog?.type === 'correction' && <CorrectionDialog controller={controller} record={dialog.record} onClose={done => { setDialog(null); if (done) setNotice('Carta de correção registrada em homologação. A transmissão à SEFAZ ainda não está disponível no ERP.'); }} />}
    {dialog?.type === 'other' && <Modal title="O que deseja fazer com essa nota" onClose={() => setDialog(null)} actions={<button type="button" className="secondary-button" onClick={() => setDialog(null)}>Fechar</button>}>
      <div className="fiscal-other-options">
        <button type="button" className="secondary-button" disabled={Boolean(nativeXmlBlock(dialog.row, writable))} title={nativeXmlBlock(dialog.row, writable) ?? 'Gera o XML da nota com o número previsto (sem reservar) e confere o leiaute e as regras.'}
          onClick={() => { const row = dialog.row; setDialog(null); void openNativeXml(row, 'validate'); }}>Validar</button>
        <button type="button" className="secondary-button" disabled={!hasXml(dialog.row)} title={hasXml(dialog.row) ? undefined : 'Sem XML coletado para esta nota.'} onClick={() => void showXml(dialog.row, false)}>Ver o XML da nota</button>
        <button type="button" className="secondary-button" disabled={!hasXml(dialog.row)} title={hasXml(dialog.row) ? undefined : 'Sem XML coletado para esta nota.'} onClick={() => void showXml(dialog.row, true)}>Baixar XML</button>
        <button type="button" className="secondary-button" disabled={!dialog.row.access_key} title={dialog.row.access_key ? undefined : 'A nota ainda não tem chave de acesso.'} onClick={() => void copyKey(dialog.row.access_key!)}>Copiar chave de acesso</button>
        <button type="button" className="secondary-button" disabled title="As cartas de correção do ERP ainda não foram transmitidas.">Baixar XML carta de correção</button>
      </div></Modal>}
    {dialog?.type === 'native' && <FiscalNativeXmlDialog mode={dialog.mode} result={dialog.result} onClose={() => setDialog(null)} />}
    {dialog?.type === 'xml' && <Modal title={`XML da nota ${invoiceNumber(dialog.row)}`} onClose={() => setDialog(null)} actions={<button type="button" className="secondary-button" onClick={() => setDialog(null)}>Fechar</button>}>
      <pre className="fiscal-xml-view" tabIndex={0}>{dialog.text}</pre></Modal>}
    {labels && <DocumentLabelsPrint labels={labels} onClose={() => setLabels(null)} />}
    {productLabels && <ProductLabels products={productLabels.products} initialQuantities={productLabels.quantities} onClose={() => setProductLabels(null)} />}
    {params.get('acao') === 'pacote-contador' && <FiscalAccountantPackage controller={controller} writable={writable} onClose={() => setParam({ acao: null }, true)} />}
    {danfe && <FiscalDanfePrint title={danfe.title} layout={danfe.layout} documents={danfe.documents} settings={danfe.settings} progress={danfe.progress} problems={danfe.problems} pdf={danfe.pdf} onClose={closeDanfe} />}
    {dialog?.type === 'danfe_pdf' && <Modal title="Gerar PDF DANFE" onClose={() => setDialog(null)} actions={<><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancelar</button>
      <button type="button" className="primary-button" disabled={Boolean(pdfJob?.running) || (pdfMode === 'selected' ? !selectedRows.length : !pdfFrom || !pdfTo || pdfFrom > pdfTo)} onClick={() => void startPdfJob(pdfMode === 'selected' ? { rows: selectedRows.slice() } : { from: pdfFrom, to: pdfTo })}>Gerar</button></>}>
      <fieldset className="fiscal-pdf-choice"><legend className="sr-only">Notas</legend>
        <label><input type="radio" name="fiscal-pdf-mode" checked={pdfMode === 'selected'} disabled={!selectedRows.length} onChange={() => setPdfMode('selected')} /> Selecionadas ({selectedRows.length})</label>
        <label><input type="radio" name="fiscal-pdf-mode" checked={pdfMode === 'period'} onChange={() => setPdfMode('period')} /> Período</label></fieldset>
      {pdfMode === 'period' && <div className="document-grid"><div className="form-field"><label htmlFor="fiscal-pdf-from">Data inicial</label><input id="fiscal-pdf-from" type="date" value={pdfFrom} onChange={event => setPdfFrom(event.target.value)} /></div>
        <div className="form-field"><label htmlFor="fiscal-pdf-to">Data final</label><input id="fiscal-pdf-to" type="date" value={pdfTo} onChange={event => setPdfTo(event.target.value)} /></div></div>}
      <fieldset className="fiscal-pdf-choice"><legend>Arquivo</legend>
        <label><input type="radio" name="fiscal-pdf-format" checked={pdfFormat === 'single'} onChange={() => setPdfFormat('single')} /> Um PDF com todas as notas</label>
        <label><input type="radio" name="fiscal-pdf-format" checked={pdfFormat === 'zip'} onChange={() => setPdfFormat('zip')} /> Um PDF por nota (ZIP)</label></fieldset>
      <p className="real-help">O PDF do DANFE é montado no navegador, em segundo plano, a partir do XML autorizado de cada nota: até {DANFE_JOB_MAX.toLocaleString('pt-BR')} notas por vez, com os filtros da listagem no período. A listagem continua disponível enquanto o arquivo é gerado.</p>
    </Modal>}
    {printRows && <FiscalListPrint title={config.title} rows={printRows} total={page?.total_count ?? printRows.length} amount={page?.total_amount ?? '0.00'} period={filters.from || filters.to ? `${brDay(filters.from || null)} até ${brDay(filters.to || null)}` : 'Todo o período'} model={config.model} onClose={() => setPrintRows(null)} />}
    {mirror && <FiscalMirrorPrint record={mirror} onClose={() => setMirror(null)} />}
    {stockDialog && <InvoiceStockDialog controller={controller} invoiceId={stockDialog.row.id} mode={stockDialog.mode} onClose={() => setStockDialog(null)} onDone={message => { setStockDialog(null); setNotice(message); setStockReload(value => value + 1); }} />}
    {dialog?.type === 'pricing' && <FiscalPricingDialog controller={controller} row={dialog.row} onClose={() => setDialog(null)}
      onPriced={mark => setPricing(current => ({ ...current, [mark.invoice_id]: { invoice_id: mark.invoice_id, recorded_at: mark.recorded_at, products: mark.products, count: Math.max(1, (current[mark.invoice_id]?.count ?? 0) + (mark.replayed ? 0 : 1)) } }))} />}
    {financeRow && <FiscalInvoiceFinance key={financeRow.id} controller={controller} invoiceId={financeRow.id} onClose={() => setFinanceRow(null)} onChanged={() => setFinanceReload(value => value + 1)} />}
    {dialog?.type === 'return' && dialog.record.access_key && <FiscalReturnDialog key={dialog.record.access_key} controller={controller} accessKey={dialog.record.access_key} onFind={findReturnSource}
      number={dialog.record.number ?? null} contactName={(dialog.record.recipient.name as string | undefined) ?? null}
      direction={(dialog.record.direction ?? config.direction) as '0' | '1'}
      items={dialog.record.items.map(i => ({ description: String(i.description), code: typeof i.code === 'string' ? i.code : null, product_id: typeof i.product_id === 'string' ? i.product_id : null, quantity: i.quantity }))}
      onClose={() => setDialog(null)} onConfirm={quantities => { const source = dialog; setDialog(null); startForm({ kind: 'return', record: source.record, quantities }); }} />}
    {dialog?.type === 'export' && <FiscalXmlExportDialog controller={controller} config={config} filters={filters} order={order} selected={dialog.rows} onClose={() => setDialog(null)} />}
    {dialog?.type === 'certificate' && <Modal title="Certificado digital" onClose={() => setDialog(null)} actions={<><button type="button" className="primary-button" onClick={() => { setDialog(null); startForm({ kind: 'new' }); }}>Prosseguir</button>
      <button type="button" className="secondary-button" onClick={() => { setDialog(null); guard.confirmLeave(() => navigate('/certificado-a1')); }}>Configurar certificado digital</button></>}>
      <p>{dialog.text}</p><p className="real-help">As NFC-e do ERP ficam em homologação, sem valor fiscal; a emissão com o certificado ainda não está ligada nesta tela.</p></Modal>}
    {dialog?.type === 'import' && <FiscalImportDialog controller={controller} model={config.model} entryOnly={entryOnly} onClose={changed => { setDialog(null); if (changed) { setReload(n => n + 1); setFinanceReload(n => n + 1); } }}
      onOpen={(noteId, direction, reconcile, noteModel) => { setDialog(null);
        // An imported note opens in the list where Origin shows it: entry notes in Notas de entrada, exit notes in Notas fiscais de saída
        // (an imported NFC-e in NFC-e); "Conciliar produtos" opens it on the Itens tab, where the reconciliation panel is.
        const path = direction === '0' ? '/notas-entrada' : direction === '1' ? '/historico-fiscal' : location.pathname;
        navigate(`${path}?${new URLSearchParams({ ...(path === '/historico-fiscal' ? { modelo: noteModel === '65' ? '65' : '55' } : {}), nota: noteId, ...(reconcile ? { secao: 'itens' } : {}) })}`); }} />}
    {dialog?.type === 'link' && <FiscalOrderLinkDialog controller={controller} row={dialog.row} mode={dialog.mode} onClose={changed => { setDialog(null); if (changed) setReload(n => n + 1); }} />}
  </section>;
}
