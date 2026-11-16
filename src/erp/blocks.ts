// Bloco de cada rota da erp-api (PLANO-FAGOO.md, itens 16 e 17): o núcleo
// `erp` e os opcionais `erp-fiscal`, `erp-cobranca`, `erp-pdv`, cada um com
// chave própria no sistema de módulos. "externo" é o que sai da instalação
// principal (Origin, migração do Bling, autoatualização e MCP do Fagoo):
// responde 404. Regra: caminho já normalizado por new URL(), o prefixo mais
// longo vence, sem prefixo é núcleo. Classificação das 764 rotas e
// divergências com o painel: docs/ERP-FASE0.md, "Blocos do ERP".

export type ErpBlock = "erp" | "erp-fiscal" | "erp-cobranca" | "erp-pdv" | "externo";

export const ERP_BLOCK_PREFIXES: Record<Exclude<ErpBlock, "erp">, readonly string[]> = {
  externo: [
    "/integracao-externa", "/admin", "/oauth", "/mcp", "/v1/system", "/v1/importacao-cadastros",
    "/v1/importacao-financeira-origin", "/v1/conferencia-financeira-origin", "/v1/importacao-orcamentos-origin",
    "/v1/importacao-orcamentos-origin-v2", "/v1/historico-vendas-origin", "/v1/vendas-origin-prontidao",
    "/v1/compras-origin-prontidao", "/v1/integracao-origin", "/v1/preparacao-virada", "/v1/depositos-origin",
    "/v1/estoque-origin-observado", "/v1/saldo-abertura-estoque", "/v1/sincronizacao-origin", "/v1/espelho-origin",
    "/v1/xmls-sincronizados", "/v1/cobrancas-legadas-itau", "/v1/backup-import", "/v1/history",
    "/v1/estoque/espelho", "/v1/notas-fiscais/origin",
  ],
  "erp-pdv": ["/v1/frente-caixa", "/v1/preferencias/vendas-frente-caixa"],
  "erp-cobranca": [
    "/v1/cnab", "/v1/cobranca-operacional", "/v1/cobranca-operacional-v2", "/v1/retornos-operacionais",
    "/v1/conferencia-retornos", "/v1/boletos-itau", "/v1/retornos-itau109", "/v1/financeiro/remessa-candidatos",
    "/v1/financeiro/remessas", "/v1/financeiro/retornos", "/v1/financeiro/actions/remittance_exclude",
    "/v1/financeiro/actions/return_exclude",
  ],
  "erp-fiscal": [
    "/v1/notas-fiscais", "/v1/rascunhos-fiscais", "/v1/preparacao-itens-fiscais", "/v1/preparacao-tributaria",
    "/v1/numeracao-fiscal", "/v1/complemento-fiscal", "/v1/notas-recebidas", "/v1/documentos/sales_orders/notas-fiscais",
    "/v1/cadastros/notas-fiscais", "/v1/estoque/notas-fiscais", "/v1/estoque/checkin",
    "/v1/estoque/relatorios/notas-entrada", "/v1/financeiro/notas-contas", "/v1/financeiro/notas",
    "/v1/financeiro/actions/invoice_finance_post", "/v1/financeiro/actions/invoice_finance_reverse",
    "/v1/preferencias/notas-nfce", "/v1/preferencias/notas-nfe", "/v1/preferencias/certificado-digital",
    "/v1/importacoes/notas-fiscais", "/v1/sistema/etiquetas/nota", "/v1/plataforma/novas-nfes", "/v1/records/nfe",
    "/v1/records/nfce",
  ],
};

const ORDERED = Object.entries(ERP_BLOCK_PREFIXES)
  .flatMap(([block, list]) => list.map((prefix) => ({ prefix, block: block as ErpBlock })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

/** Bloco de um caminho da erp-api (depois de /erp, sem a consulta). */
export function erpBlockOf(pathname: string): ErpBlock {
  for (const { prefix, block } of ORDERED)
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return block;
  return "erp";
}
