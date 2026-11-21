import { lazy, type ComponentType } from 'react';

// Wabotia: cada módulo do menu carrega as suas telas juntas, e os blocos opcionais (Fiscal, Cobrança, PDV) em arquivos próprios; as telas do Origin saíram (PLANO-FAGOO.md, item 17) (web/erp/screens/<módulo>.ts), em vez de um import() por tela;
// o ERP fica em 30 a 50 arquivos (web/erp/chunks.ts). Original do Fagoo em web/erp/ORIGEM.json.
const cadastros = () => import('../../screens/cadastros');
const documentos = () => import('../../screens/documentos');
const pdv = () => import('../../screens/pdv');
const estoque = () => import('../../screens/estoque');
const financeiro = () => import('../../screens/financeiro');
const cobranca = () => import('../../screens/cobranca');
const fiscal = () => import('../../screens/fiscal');
const preferencias = () => import('../../screens/preferencias');
const receberBling = () => import('../../screens/receber-bling');
const pick = <M extends Record<K, ComponentType<any>>, K extends string>(load: () => Promise<M>, name: K) => () => load().then(module => ({ default: module[name] as M[K] }));

// Wabotia: primeira visita. O arquivo da tela do endereço começa a baixar quando o ERP monta (web/erp/mount.tsx), junto com o
// /v1/me, e não só depois dele; o lazy() da rota reaproveita o mesmo import(). Endereço sem tela conhecida não baixa nada.
const SCREEN_FILES: [RegExp, () => Promise<unknown>][] = [
  [/^\/receber-bling$/, receberBling],
  [/^\/frente-caixa-empresa$/, pdv],
  [/^\/(cobranca-empresa|cobranca-operacional|retornos-operacionais)$/, cobranca],
  [/^\/(financeiro-empresa|relatorio-vencimentos)$/, financeiro],
  [/^\/(historico-fiscal|notas-bling|notas-entrada|naturezas-operacao|inutilizacoes-nfe|cartas-correcao|numeracao-fiscal|notas-recebidas|emissor-fiscal|certificado-a1|conexao-sefaz|checkin-recebimentos)$/, fiscal],
  [/^\/(estoque-empresa|estoque-abertura|conferencia-estoque-empresa|relatorios-estoque|painel-produtos-empresa)$/, estoque],
  [/^\/documentos-empresa$/, documentos],
  [/^\/(cadastros-reais|categorias-produtos|grupos-produtos|tags|grupos-tags|exportacao-produtos|listas-precos|campos-customizados|tipos-contatos-empresa|vendedores-empresa|formas-pagamento-empresa|funcionarios-empresa|importar-contatos|numeracao-contatos)$/, cadastros],
  [/^\/(|acesso|empresa-configuracoes|preferencias(\/.*)?)$/, preferencias],
];
export function preloadScreen(pathname: string, search = '') {
  const load = pathname === '/cadastros-reais' && new URLSearchParams(search).get('cadastro') === 'warehouses' ? estoque : SCREEN_FILES.find(([path]) => path.test(pathname))?.[1];
  void load?.().catch(() => { /* A rota tenta de novo pelo lazy() e mostra o erro dela. */ });
}

// Stable component identities: loading a route never recreates its controller or editor.
export const Catalog = lazy(pick(cadastros, 'RealCatalog'));
// Produtos (202610200119-120): categorias, grupos de produtos, tags e grupos de tags; exportação de produtos.
export const ProductTaxonomy = lazy(pick(cadastros, 'ProductTaxonomy'));
export const ProductExport = lazy(pick(cadastros, 'ProductExport'));
export const PriceLists = lazy(pick(cadastros, 'PriceLists'));
// Campos customizados de produtos (202610200156).
export const CustomFields = lazy(pick(cadastros, 'CustomFields'));
export const RealDocuments = lazy(pick(documentos, 'RealDocuments'));
export const RealStock = lazy(pick(estoque, 'RealStock'));
export const RealFinance = lazy(pick(financeiro, 'RealFinance'));
export const FinanceBorderos = lazy(pick(financeiro, 'FinanceBorderos'));
export const FinanceScreens = lazy(pick(financeiro, 'FinanceScreens'));
export const RealCnab = lazy(pick(cobranca, 'RealCnab'));
export const CompanySettings = lazy(pick(preferencias, 'CompanySettings'));
export const RealHome = lazy(pick(preferencias, 'RealHome'));
export const RealFiscalDrafts = lazy(pick(fiscal, 'RealFiscalDrafts'));
export const DueDateReport = lazy(pick(financeiro, 'DueDateReport'));

export const RealCnabOperational = lazy(pick(cobranca, 'RealCnabOperational'));
export const RealCnabOperationalReturns = lazy(pick(cobranca, 'RealCnabOperationalReturns'));
export const CertificateA1 = lazy(pick(fiscal, 'CertificateA1'));

export const RealReceivedDfe = lazy(pick(fiscal, 'RealReceivedDfe'));
export const RealFiscalNumbering = lazy(pick(fiscal, 'RealFiscalNumbering'));

export const SefazConnection = lazy(pick(fiscal, 'SefazConnection'));




export const RealStockOpening = lazy(pick(estoque, 'RealStockOpening'));

// Estoque lane (migrations 105-107).
export const StockWarehouses = lazy(pick(estoque, 'StockWarehouses'));
export const StockCount = lazy(pick(estoque, 'StockCount'));
export const StockDashboards = lazy(pick(estoque, 'StockDashboards'));
export const ReceiptCheckin = lazy(pick(fiscal, 'ReceiptCheckin'));
export const StockReports = lazy(pick(estoque, 'StockReports'));

// Notas fiscais no padrão Origin (202610200111-114).
export const RealFiscalInvoices = lazy(pick(fiscal, 'RealFiscalInvoices'));
export const RealOperationNatures = lazy(pick(fiscal, 'RealOperationNatures'));
export const FiscalEventList = lazy(pick(fiscal, 'FiscalEventList'));
// Receber o Bling, fatia C: notas emitidas no Bling, só consulta.
export const BlingInvoices = lazy(pick(fiscal, 'BlingInvoices'));

// Vendas › Frente de caixa (202610200204-206), em tela cheia.
export const RealPdv = lazy(pick(pdv, 'RealPdv'));

export const CompanyPreferences = lazy(pick(preferencias, 'CompanyPreferences'));
export const ReceiveBling = lazy(pick(receberBling, 'ReceiveBling'));
