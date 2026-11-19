import type { ErpPart } from "../../src/modules/erp/panel-menu.ts";

// Chaves do ERP em Gestão → Módulos (PLANO-FAGOO.md, itens 16 e 17): `erp`,
// e os opcionais `erp-fiscal`, `erp-cobranca` e `erp-pdv`. Desligados de
// fábrica: enquanto o servidor não declarar um desses ids (GET /status, campo
// modules), ele conta como desligado. Os outros módulos do painel seguem a
// regra antiga (desconhecido = ligado, web/workspace-navigation.ts).
//
// Desenvolvimento: `localStorage.setItem("wabotia:erp-dev", "1")` liga todos os
// ids que o servidor não informa (só em `npm run web`; o build ignora). A
// demonstração declara os seus (web/lib/demo.ts).

export const ERP_MODULES = [
  "erp",
  "erp-fiscal",
  "erp-cobranca",
  "erp-pdv",
] as const;
export type ErpModule = (typeof ERP_MODULES)[number];

function devOverride() {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem("wabotia:erp-dev") === "1";
  } catch {
    return false;
  }
}

/** Ligado só quando o servidor diz que está ligado (ou a chave de desenvolvimento). */
export function erpModuleOn(
  modules: Record<string, boolean> | undefined,
  id: ErpModule,
) {
  const declared = modules?.[id];
  return declared === undefined ? devOverride() : declared === true;
}

export type ErpBlock = ErpModule;

const FISCAL = new Set([
  "/historico-fiscal",
  // O check-in sempre parte de uma nota de entrada; o recebimento pelo pedido de compra é do núcleo.
  "/checkin-recebimentos",
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
// Borderôs são baixas em lote do financeiro (erp_finance_bordero_*), sem CNAB: núcleo.
const COBRANCA_AREAS = new Set(["remessas", "retornos"]);
const PDV = new Set([
  "/frente-caixa-empresa",
  "/preferencias/vendas/frente-caixa",
]);

/** Bloco de um endereço do ERP (caminho sem o /app/erp, com ou sem ?consulta). */
export function blockOf(target: string): ErpBlock {
  const { pathname: path, search: query } = new URL(target, "https://erp.invalid");
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
  if (PDV.has(path) || under("/preferencias/vendas/frente-caixa")) return "erp-pdv";
  return "erp";
}

/** Única decisão de ativação: partes do núcleo legado e opcionais por destino. */
export function erpPartEnabled(
  part: ErpPart,
  modules: Readonly<Record<string, boolean>>,
  to: string,
): boolean {
  // Partes futuras precisam de uma decisão explícita; uma chave desconhecida não herda o núcleo.
  if (!["cadastro", "catalogo", "vendas", "compras", "estoque", "financeiro",
    "fiscal", "cobranca", "pdv", "servicos", "resultados", "sistema"].includes(part)) return false;
  const block = blockOf(to);
  return modules.erp === true && (block === "erp" || modules[block] === true);
}
