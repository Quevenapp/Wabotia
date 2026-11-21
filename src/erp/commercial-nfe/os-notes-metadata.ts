import type { CommercialNfeOperation } from "./metadata.ts";

/** Notas da ordem de serviço (OS, parte 5): nota de serviço (NFS-e) e nota de
 * peças (NF-e modelo 55) emitidas a partir da ordem, na mesma rota
 * erp-comercial-nfe (prefixo os/<ordem>/notas). `:id` é o id da ordem. Tudo
 * exige a parte Fiscal ligada e o cofre configurado; a nota de peças exige
 * também Vendas e Produtos (o motor confere). Emitir, consultar, cancelar e
 * configurar são sensíveis: no bot, a pessoa com o papel fiscal confirma. */
export const OS_NOTE_OPERATIONS: readonly CommercialNfeOperation[] = Object.freeze([
  { name: "osnota.list", method: "GET", path: "os/:id/notas", summary: "Consultar as notas fiscais da ordem de serviço e o que pode ser emitido agora", action: "read", sensitive: false, body: [], required: [] },
  { name: "osnota.emit", method: "POST", path: "os/:id/notas/emitir", summary: "Emitir a nota de serviço (NFS-e) ou a nota de peças (NF-e) da ordem de serviço pelo cofre", action: "emit", sensitive: true,
    body: ["command_id", "kind"], required: ["command_id", "kind"] },
  { name: "osnota.consult", method: "POST", path: "os/:id/notas/consultar", summary: "Consultar e retomar no cofre a nota da ordem de serviço com resultado incerto, sem reenviar às cegas", action: "resume", sensitive: true,
    body: ["command_id", "kind"], required: ["command_id", "kind"] },
  { name: "osnota.cancel", method: "POST", path: "os/:id/notas/cancelar", summary: "Cancelar a nota da ordem de serviço com justificativa, dentro do que a prefeitura ou a SEFAZ permitem", action: "cancel", sensitive: true,
    body: ["command_id", "kind", "justification", "reason"], required: ["command_id", "kind", "justification"] },
  { name: "osnota.xml", method: "GET", path: "os/:id/notas/xml", summary: "Baixar o XML da nota autorizada da ordem de serviço, guardado no cofre", action: "read", sensitive: false, body: [], required: [], query: ["kind"] },
  { name: "osnota.pdf", method: "GET", path: "os/:id/notas/pdf", summary: "Baixar o PDF (DANFE) da nota de peças da ordem de serviço, gerado pelo cofre", action: "read", sensitive: false, body: [], required: [], query: ["kind"] },
  { name: "osnota.cancel.xml", method: "GET", path: "os/:id/notas/cancelamento-xml", summary: "Baixar o XML do cancelamento da nota da ordem de serviço", action: "read", sensitive: false, body: [], required: [], query: ["kind"] },
  { name: "nfse.config.get", method: "GET", path: "nfse/config", summary: "Consultar o cadastro fiscal do serviço e o que o cofre informa para a NFS-e", action: "read", sensitive: false, body: [], required: [] },
  { name: "nfse.config.save", method: "PUT", path: "nfse/config", summary: "Salvar o código de tributação, a alíquota e a retenção do ISS dos serviços e a natureza da nota de peças", action: "configure", sensitive: true,
    body: ["command_id", "expected_version", "national_code", "municipal_code", "nbs", "iss_rate", "iss_withheld", "simples_apportionment", "municipality_code", "parts_nature_id", "items"],
    required: ["command_id", "expected_version"] },
]);
export const OS_NOTE_KINDS = ["nfse", "nfe"] as const;
