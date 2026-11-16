// Divisão do ERP em arquivos (PLANO-FAGOO-PAINEL.md, B): sem agrupar, o Vite
// gera ~155 arquivos JS pequenos para o Fagoo. Aqui cada módulo do ERP vai
// para o grupo do item de menu que o usa (cadastros, documentos, estoque,
// financeiro…), telas e modelos em arquivos separados, o que dá 30 a 50
// arquivos (web/erp/build.test.mjs confere). Nada daqui entra no pacote
// inicial do painel: só módulos de web/erp/app e packages/ têm grupo.

/** Grupo pelo nome do arquivo: primeira regra que casar. */
const groups: [string, RegExp][] = [
  ["pdv", /pdv|(^|[-_/])pos([-_.]|$)|cash-register/i],
  [
    "origin",
    /origin|cutover|itau-legacy|integration|mirror|synced-xml|backup-import|warehouse-import|stock-opening|proposal-import|financial-import|import-failure/i,
  ],
  [
    "fiscal",
    /fiscal|danfe|nfe|nfce|sefaz|(^|[-_/])a1[-_.]|wsdl|dfe|operation-nature|invoice|xml/i,
  ],
  ["cobranca", /cnab|boleto|remittance|bordero|net-credit/i],
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

/** Módulos pequenos dividem o arquivo com o vizinho de menu. */
const merged: Record<string, string> = {
  cobranca: "financeiro",
  pdv: "documentos",
  inicio: "preferencias",
};

export function erpChunk(id: string): string | undefined {
  const path = id.replaceAll("\\", "/");
  // Pacotes do Fagoo: um arquivo por família.
  const pkg = /\/packages\/([^/]+)\//.exec(path);
  if (pkg) {
    const name = pkg[1];
    if (/^(cnab|boleto)/.test(name)) return "erp-financeiro";
    if (/^fiscal/.test(name)) return "erp-fiscal";
    return "erp-dominio";
  }
  const app = /\/web\/erp\/app\/(components|lib|hooks)\/([^?]+)$/.exec(path);
  if (!app) return undefined;
  const [, folder, file] = app;
  if (folder === "hooks") return "erp-nucleo";
  const base = file.replace(/\.(tsx?|css)$/, "");
  // Arquivos de estilo seguem quem os importa.
  if (/\.css$/.test(file)) return undefined;
  // Telas (components) e modelos (lib) em arquivos separados: quem abre uma
  // lista não baixa os formulários de outro módulo que só usa o modelo.
  const kind = folder === "components" ? "telas" : "modelos";
  for (const [name, test] of groups)
    if (test.test(base)) return `erp-${merged[name] ?? name}-${kind}`;
  // O resto (acesso, navegação, componentes de base) é o núcleo do ERP.
  return `erp-nucleo-${kind}`;
}
