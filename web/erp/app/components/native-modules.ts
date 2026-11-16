import { lazy, type ComponentType } from 'react';

// Wabotia: cada módulo do menu carrega as suas telas juntas, e os blocos opcionais (Fiscal, Cobrança, PDV, Origin) em arquivos próprios (web/erp/screens/<módulo>.ts), em vez de um import() por tela;
// o ERP fica em 30 a 50 arquivos (web/erp/chunks.ts). Original do Fagoo em web/erp/ORIGEM.json.
const cadastros = () => import('../../screens/cadastros');
const documentos = () => import('../../screens/documentos');
const pdv = () => import('../../screens/pdv');
const estoque = () => import('../../screens/estoque');
const financeiro = () => import('../../screens/financeiro');
const cobranca = () => import('../../screens/cobranca');
const fiscal = () => import('../../screens/fiscal');
const origin = () => import('../../screens/origin');
const preferencias = () => import('../../screens/preferencias');
const pick = <M extends Record<K, ComponentType<any>>, K extends string>(load: () => Promise<M>, name: K) => () => load().then(module => ({ default: module[name] as M[K] }));

// Stable component identities: loading a route never recreates its controller or editor.
export const Catalog = lazy(pick(cadastros, 'RealCatalog'));
// Produtos (202610200119-120): categorias, grupos de produtos, tags e grupos de tags; exportação de produtos.
export const ProductTaxonomy = lazy(pick(cadastros, 'ProductTaxonomy'));
export const ProductExport = lazy(pick(cadastros, 'ProductExport'));
export const PriceLists = lazy(pick(cadastros, 'PriceLists'));
// Campos customizados de produtos (202610200156).
export const CustomFields = lazy(pick(cadastros, 'CustomFields'));
export const HistoryView = lazy(pick(fiscal, 'HistoryView'));
export const RealDocuments = lazy(pick(documentos, 'RealDocuments'));
export const RealStock = lazy(pick(estoque, 'RealStock'));
export const RealFinance = lazy(pick(financeiro, 'RealFinance'));
export const FinanceBorderos = lazy(pick(cobranca, 'FinanceBorderos'));
export const FinanceScreens = lazy(pick(financeiro, 'FinanceScreens'));
export const RealCnab = lazy(pick(cobranca, 'RealCnab'));
export const CompanySettings = lazy(pick(preferencias, 'CompanySettings'));
export const RealImportCatalog = lazy(pick(origin, 'RealImportCatalog'));
export const RealHome = lazy(pick(preferencias, 'RealHome'));
export const CutoverReadiness = lazy(pick(origin, 'CutoverReadiness'));
export const RealFiscalDrafts = lazy(pick(fiscal, 'RealFiscalDrafts'));
export const DueDateReport = lazy(pick(financeiro, 'DueDateReport'));
export const SyncedXmlHistory = lazy(pick(origin, 'SyncedXmlHistory'));
export const IntegrationProgress = lazy(pick(origin, 'IntegrationProgress'));

export const RealCnabOperational = lazy(pick(cobranca, 'RealCnabOperational'));
export const RealCnabOperationalReturns = lazy(pick(cobranca, 'RealCnabOperationalReturns'));
export const CertificateA1 = lazy(pick(fiscal, 'CertificateA1'));

export const RealReceivedDfe = lazy(pick(fiscal, 'RealReceivedDfe'));
export const RealFiscalNumbering = lazy(pick(fiscal, 'RealFiscalNumbering'));

export const SefazConnection = lazy(pick(fiscal, 'SefazConnection'));

export const OriginPurchaseReadiness = lazy(pick(origin, 'OriginPurchaseReadiness'));
export const OriginSalesReadiness = lazy(pick(origin, 'OriginSalesReadiness'));
export const OriginSalesHistory = lazy(pick(origin, 'OriginSalesHistory'));
export const ItauLegacyReadiness = lazy(pick(origin, 'ItauLegacyReadiness'));
export const RealImportProposals = lazy(pick(origin, 'RealImportProposals'));

export const OriginWarehouseImport = lazy(pick(origin, 'OriginWarehouseImport'));

export const OriginStockObservations = lazy(pick(origin, 'OriginStockObservations'));

export const RealStockOpening = lazy(pick(estoque, 'RealStockOpening'));

// Estoque lane (migrations 105-107).
export const StockWarehouses = lazy(pick(estoque, 'StockWarehouses'));
export const StockCount = lazy(pick(estoque, 'StockCount'));
export const StockDashboards = lazy(pick(estoque, 'StockDashboards'));
export const ReceiptCheckin = lazy(pick(estoque, 'ReceiptCheckin'));
export const StockReports = lazy(pick(estoque, 'StockReports'));

// Notas fiscais no padrão Origin (202610200111-114).
export const RealFiscalInvoices = lazy(pick(fiscal, 'RealFiscalInvoices'));
export const RealOperationNatures = lazy(pick(fiscal, 'RealOperationNatures'));
export const FiscalEventList = lazy(pick(fiscal, 'FiscalEventList'));

// Vendas › Frente de caixa (202610200204-206), em tela cheia.
export const RealPdv = lazy(pick(pdv, 'RealPdv'));

export const CompanyPreferences = lazy(pick(preferencias, 'CompanyPreferences'));
