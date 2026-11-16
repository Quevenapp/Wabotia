// Divisão do ERP em arquivos (PLANO-FAGOO-PAINEL.md, B): sem agrupar, o Vite
// gera ~155 arquivos JS pequenos para o Fagoo. Aqui cada módulo do ERP vai
// para o grupo do item de menu que o usa (cadastros, documentos, estoque,
// financeiro…), telas e modelos em arquivos separados, o que dá 30 a 50
// arquivos (web/erp/build.test.mjs confere). Nada daqui entra no pacote
// inicial do painel: só módulos de web/erp/app e packages/ têm grupo.

/**
 * Arquivos com "origin" no nome que só imitam o visual do sistema antigo (menu,
 * barra, listas, ações em lote) ou que a barra sempre carrega: núcleo.
 */
const CORE =
  /^(origin-menu|OriginTopBar|origin-top-bar|OriginList|origin-list|origin-batch|OriginSyncButton|origin-sync-model|integration-capabilities)$/;
/**
 * Partes de um bloco embutidas em telas do núcleo, importadas por elas sem
 * carga sob demanda (o painel do espelho Origin no editor de contato, o lote
 * fiscal na lista de documentos, o resumo do PDV no controle de caixa…). Vão
 * com o núcleo; as telas próprias de cada bloco continuam nos arquivos dele.
 * Lista conferida por web/erp/build.test.mjs.
 */
export const EMBEDDED = new Set([
  "OriginCatalogSync",
  "OriginMirrorPanel",
  "FiscalOrderTaxEstimate",
  "PartialInvoiceDialog",
  "FiscalOrderBatch",
  "DocumentXmlImport",
  "DocumentMirrorView",
  "DocumentOriginTotals",
  "PdvOrderOrigin",
  "StockOriginMirror",
  "FinanceReturns",
  "FinanceRemittances",
  "PdvCashSummary",
  "HomeNewInvoices",
  "FiscalNumberingSummary",
]);

/**
 * Grupo pelo nome do arquivo: primeira regra que casar. Os blocos opcionais
 * (pdv, cobranca, fiscal; PLANO-FAGOO.md, itens 16 e 17) vêm antes, para
 * que quem não liga um bloco nunca baixe as telas dele.
 */
const groups: [string, RegExp][] = [
  ["pdv", /pdv|(^|[-_/])pos([-_.]|$)|cash-register/i],
  ["cobranca", /cnab|boleto|remittance|net-credit|FinanceReturns/i],
  ["financeiro", /^finance/i],
  [
    "fiscal",
    /fiscal|ReceiptCheckin|receipt-checkin|InvoiceStock|invoice-stock|danfe|nfe|nfce|sefaz|(^|[-_/])a1[-_.]|wsdl|dfe|operation-?nature|invoice|xml/i,
  ],
  [
    "financeiro",
    /financ|due-date|due-report|ofx|reconcil|commission|grouped-billing|account|ficha/i,
  ],
  ["estoque", /stock|warehouse|receipt|inventory|deposit|checkin|lot/i],
  [
    "documentos",
    /document|proposal|order|sales|purchase|romaneio|checkout|service|shipping|freight/i,
  ],
  [
    "cadastros",
    /catalog|contact|product|price|taxonomy|custom-field|tag|label|seller|employee|payment-method|reference|registry|unit|cep/i,
  ],
  ["inicio", /home|business|dashboard|goal|report/i],
  [
    "preferencias",
    /preference|settings|users?[-.]|security|mfa|activity|system|update|wabotia|company|export|files?|help|notification|platform|list-preferences/i,
  ],
];

/** Módulos pequenos do núcleo dividem o arquivo com o vizinho de menu. */
const merged: Record<string, string> = {
  inicio: "preferencias",
};

export function erpChunk(id: string): string | undefined {
  const path = id.replaceAll("\\", "/");
  // Pacotes do Fagoo: um arquivo por família.
  const pkg = /\/packages\/([^/]+)\//.exec(path);
  if (pkg) {
    const name = pkg[1];
    if (/^(cnab|boleto)/.test(name)) return "erp-cobranca";
    if (/^fiscal/.test(name)) return "erp-fiscal";
    return "erp-dominio";
  }
  const app = /\/web\/erp\/app\/(components|lib|hooks)\/([^?]+)$/.exec(path);
  if (!app) return undefined;
  const [, folder, file] = app;
  if (folder === "hooks") return "erp-nucleo";
  const base = file.replace(/\.(tsx?|css)$/, "");
  // Estilos: um arquivo só. Soltos, uma folha usada por uma tela do núcleo e
  // por uma do Fiscal caía no arquivo do Fiscal e o núcleo passava a baixá-lo.
  if (/\.css$/.test(file)) return "erp-estilos";
  // Telas (components) e modelos (lib) em arquivos separados: quem abre uma
  // lista não baixa os formulários de outro módulo que só usa o modelo.
  const kind = folder === "components" ? "telas" : "modelos";
  if (CORE.test(base) || EMBEDDED.has(base)) return `erp-nucleo-${kind}`;
  for (const [name, test] of groups)
    if (test.test(base)) return `erp-${merged[name] ?? name}-${kind}`;
  // O resto (acesso, navegação, componentes de base) é o núcleo do ERP.
  return `erp-nucleo-${kind}`;
}
