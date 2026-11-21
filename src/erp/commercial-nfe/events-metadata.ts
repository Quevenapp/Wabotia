import type { CommercialNfeOperation } from "./metadata.ts";

/** Depois da NF-e autorizada: carta de correção, inutilização e devolução de
 * venda, na mesma rota erp-comercial-nfe. Nomes estáveis (grupo "nfe" dos
 * bots): as escritas são da categoria sensível "nota fiscal" (o bot propõe,
 * a pessoa com o papel fiscal confirma; o administrador pode liberar).
 * Exigem a parte Fiscal ligada; estoque e financeiro da devolução respeitam
 * as próprias partes (desligada, o efeito fica pendente com o motivo). */
export const NFE_EVENT_OPERATIONS: readonly CommercialNfeOperation[] = Object.freeze([
  { name: "nfe.eventos", method: "GET", path: "emissoes/:id/eventos", summary: "Consultar cartas de correção, devoluções e prazos de uma NF-e de venda", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfe.carta_correcao", method: "POST", path: "emissoes/:id/carta-correcao", summary: "Enviar pelo cofre uma carta de correção (CC-e) da NF-e autorizada", action: "emit", sensitive: true,
    body: ["command_id", "text"], required: ["command_id", "text"] },
  { name: "nfe.carta_correcao.consultar", method: "POST", path: "emissoes/:id/carta-correcao/consultar", summary: "Consultar no cofre uma carta de correção sem resposta, sem enviar outra", action: "resume", sensitive: true,
    body: ["command_id", "correction_id"], required: ["command_id", "correction_id"] },
  { name: "nfe.carta_correcao.pdf", method: "GET", path: "emissoes/:id/carta-correcao/pdf", summary: "Obter o PDF da carta de correção registrada", action: "read", sensitive: false, body: [], required: [], query: ["sequence"] },
  { name: "nfe.carta_correcao.xml", method: "GET", path: "emissoes/:id/carta-correcao/xml", summary: "Obter o XML do evento da carta de correção registrada", action: "read", sensitive: false, body: [], required: [], query: ["sequence"] },
  { name: "nfe.devolucao", method: "POST", path: "emissoes/:id/devolucao", summary: "Gerar e emitir pelo cofre a NF-e de devolução de venda, com entrada no estoque e efeito nas contas", action: "emit", sensitive: true,
    body: ["command_id", "items", "finance_option"], required: ["command_id", "items", "finance_option"] },
  { name: "nfe.devolucao.get", method: "GET", path: "devolucoes/:id", summary: "Consultar uma devolução de venda: nota, itens, estoque e contas", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfe.devolucao.retomar", method: "POST", path: "devolucoes/:id/retomar", summary: "Consultar a mesma NF-e de devolução no cofre e lançar estoque e contas pendentes", action: "resume", sensitive: true,
    body: ["command_id"], required: ["command_id"] },
  { name: "nfe.devolucao.danfe", method: "GET", path: "devolucoes/:id/danfe", summary: "Obter o DANFE da NF-e de devolução gerado pelo cofre", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfe.devolucao.xml", method: "GET", path: "devolucoes/:id/xml", summary: "Obter o XML da NF-e de devolução no cofre", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfe.inutilizacoes", method: "GET", path: "inutilizacoes", summary: "Listar as inutilizações de numeração e se o cofre as oferece", action: "read", sensitive: false, body: [], required: [], query: ["environment", "model"] },
  { name: "nfe.inutilizacao", method: "POST", path: "inutilizacoes", summary: "Inutilizar pelo cofre uma faixa de numeração de NF-e ou NFC-e, com justificativa", action: "emit", sensitive: true,
    body: ["command_id", "model", "environment", "series", "first", "last", "justification"], required: ["command_id", "model", "environment", "series", "first", "last", "justification"] },
]);

/** Arquivos (o bot recebe só o vínculo autenticado; a pessoa baixa o arquivo). */
export const NFE_EVENT_FILES: Readonly<Record<string, "application/pdf" | "application/xml">> = Object.freeze({
  "nfe.carta_correcao.pdf": "application/pdf", "nfe.carta_correcao.xml": "application/xml",
  "nfe.devolucao.danfe": "application/pdf", "nfe.devolucao.xml": "application/xml",
});

/** Parâmetros para o catálogo dos bots e o OpenAPI. */
export const NFE_EVENT_PROPERTIES: Readonly<Record<string, unknown>> = Object.freeze({
  command_id: { type: "string", format: "uuid" }, correction_id: { type: "string", format: "uuid" },
  text: { type: "string", minLength: 15, maxLength: 1000, description: "Texto da carta (todas as correções: a carta nova substitui as anteriores). Não corrige valores, impostos, destinatário nem data." },
  items: { type: "array", minItems: 1, maxItems: 990, items: { type: "object", additionalProperties: false, required: ["item", "quantity"],
    properties: { item: { type: "integer", minimum: 0, description: "Posição do item na nota (0 é o primeiro)." }, quantity: { type: "string", pattern: "^\\d{1,11}(\\.\\d{1,4})?$" } } } },
  finance_option: { type: "string", enum: ["credito", "pagar"], description: "O que fazer com o valor já recebido: crédito do cliente ou conta a pagar de devolução." },
  model: { type: "string", enum: ["nfe", "nfce"] }, environment: { type: "string", enum: ["homologacao", "producao"] },
  series: { type: "integer", minimum: 0, maximum: 889 }, first: { type: "integer", minimum: 1, maximum: 999999999 }, last: { type: "integer", minimum: 1, maximum: 999999999 },
  justification: { type: "string", minLength: 15, maxLength: 255 }, sequence: { type: "integer", minimum: 1, maximum: 20 },
});
