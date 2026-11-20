import type { CommercialNfeOperation } from "./metadata.ts";

/** Balcão com NFC-e: as operações do cupom da venda do caixa, na mesma rota
 * erp-comercial-nfe (prefixo nfce/). Inventário próprio: as doze da NF-e do
 * pedido continuam as mesmas. Exigem Caixa / PDV e Fiscal ligados. */
export const NFCE_OPERATIONS: readonly CommercialNfeOperation[] = Object.freeze([
  { name: "nfce.config.get", method: "GET", path: "nfce/config", summary: "Consultar o que o cofre informa para a NFC-e e a natureza do cupom", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfce.config.save", method: "PUT", path: "nfce/config", summary: "Escolher a natureza de operação usada no cupom fiscal do caixa", action: "configure", sensitive: true,
    body: ["command_id", "expected_version", "nature_id"], required: ["command_id", "expected_version", "nature_id"] },
  { name: "nfce.sales", method: "GET", path: "nfce/vendas", summary: "Listar as vendas do caixa com a situação do cupom fiscal e os pendentes", action: "read", sensitive: false, body: [], required: [],
    query: ["environment", "cash_session_id", "from", "to", "pending_only", "page", "per_page"] },
  { name: "nfce.get", method: "GET", path: "nfce/vendas/:id", summary: "Consultar a situação do cupom fiscal de uma venda do caixa", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfce.emit", method: "POST", path: "nfce/vendas/:id/emitir", summary: "Emitir (ou tentar de novo) o cupom fiscal NFC-e de uma venda do caixa pelo cofre", action: "emit", sensitive: true,
    body: ["command_id", "consumer_document"], required: ["command_id"] },
  { name: "nfce.consult", method: "POST", path: "nfce/vendas/:id/consultar", summary: "Consultar no cofre o cupom fiscal com resultado incerto, sem reenviar às cegas", action: "resume", sensitive: true,
    body: ["command_id"], required: ["command_id"] },
  { name: "nfce.coupon", method: "GET", path: "nfce/vendas/:id/cupom", summary: "Obter o cupom fiscal (DANFCE de 80 mm) gerado pelo cofre para imprimir", action: "read", sensitive: false, body: [], required: [], query: ["via"] },
  { name: "nfce.cancel", method: "POST", path: "nfce/vendas/:id/cancelar", summary: "Cancelar o cupom fiscal no prazo e, depois, a venda do caixa com estoque e contas", action: "cancel", sensitive: true,
    body: ["command_id", "justification", "physical_return_confirmed"], required: ["command_id", "justification"] },
]);

/** Quem chega a cada ação do cupom (o motor revalida papel e permissões do PDV). */
export const NFCE_ROLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ["admin", "consulta", "fiscal", "vendas", "financeiro"],
  configure: ["admin"],
  emit: ["admin", "fiscal", "vendas"], resume: ["admin", "fiscal", "vendas"], cancel: ["admin", "fiscal", "vendas"], prepare: ["admin", "fiscal", "vendas"],
});

/** Prazo de cancelamento da NFC-e contado da autorização (regra nacional; a SEFAZ decide). */
export const NFCE_CANCEL_MINUTES = 30;
