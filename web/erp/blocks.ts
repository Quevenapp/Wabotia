// Blocos do ERP (PLANO-FAGOO.md, item 16): o núcleo `erp` e quatro opcionais
// com chave própria no sistema de módulos do Wabotia. Cada endereço do ERP
// pertence a um bloco; menu, rotas e divisão em arquivos seguem esta regra.
// Mapa comentado: sessao-M-erp-painel.md (notas da orquestração).

export type ErpBlock = "erp" | "erp-fiscal" | "erp-cobranca" | "erp-pdv";

export const ERP_BLOCK_LABELS: Record<ErpBlock, string> = {
  erp: "ERP",
  "erp-fiscal": "Fiscal",
  "erp-cobranca": "Cobrança bancária",
  "erp-pdv": "Caixa / PDV",
};

const FISCAL = new Set([
  "/historico-fiscal",
  "/notas-recebidas",
  "/numeracao-fiscal",
  "/notas-entrada",
  "/naturezas-operacao",
  "/inutilizacoes-nfe",
  "/cartas-correcao",
  "/certificado-a1",
  "/conexao-sefaz",
  "/emissor-fiscal",
  "/preferencias/importacoes/notas-fiscais",
]);
const COBRANCA = new Set([
  "/cobranca-empresa",
  "/cobranca-operacional",
  "/retornos-operacionais",
]);
const COBRANCA_AREAS = new Set(["remessas", "retornos", "borderos"]);
const PDV = new Set([
  "/frente-caixa-empresa",
  "/preferencias/vendas/frente-caixa",
]);

/** Bloco de um endereço do ERP (caminho sem o /app/erp, com ou sem ?consulta). */
export function blockOf(target: string): ErpBlock {
  const [path, query = ""] = target.split("?");
  const under = (prefix: string) =>
    path === prefix || path.startsWith(prefix + "/");
  if (
    FISCAL.has(path) ||
    under("/preferencias/notas-fiscais") ||
    under("/preferencias/certificado")
  )
    return "erp-fiscal";
  if (
    COBRANCA.has(path) ||
    (path === "/financeiro-empresa" &&
      COBRANCA_AREAS.has(new URLSearchParams(query).get("area") ?? ""))
  )
    return "erp-cobranca";
  if (PDV.has(path)) return "erp-pdv";
  return "erp";
}

/** Blocos ligados na área; sem registro (testes do Fagoo), todos ligados. */
let enabled: Partial<Record<ErpBlock, boolean>> | null = null;
export function setErpBlocks(next: Partial<Record<ErpBlock, boolean>> | null) {
  enabled = next;
}
export const blockEnabled = (block: ErpBlock) =>
  !enabled || enabled[block] !== false;
export const targetEnabled = (target: string) => blockEnabled(blockOf(target));
