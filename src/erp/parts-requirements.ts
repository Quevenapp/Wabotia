import { erpBlockOf, erpRouteExists } from "./blocks.ts";
import { erpRequirement, type ErpModuleId, type ErpRequirement } from "./parts.ts";
export { erpRequirement, erpRequirementMet } from "./parts.ts";
const B = "erp", P = "erp-produtos", S = "erp-vendas", C = "erp-compras", E = "erp-estoque", F = "erp-financeiro", N = "erp-fiscal", K = "erp-cobranca", V = "erp-pdv";
const groups = (entries: readonly [ErpModuleId, string][]): Readonly<Record<string, ErpModuleId>> => Object.freeze(Object.fromEntries(entries.flatMap(([id, names]) => names.split(" ").map(n => [n, id]))));
export const ERP_ENTITY_PARTS = groups([
  [B, "contacts contatos contato employees funcionarios sellers vendedores payment_methods formas-pagamento tags tag_groups contact_types empresa categorias-contatos grupos-contatos"],
  [P, "products produtos produto categories product_categories product_groups categorias-produtos grupos-produtos price_lists listas-precos compositions product_suppliers custom_fields campos-customizados"],
  [S, "sales_orders sales_proposals service_orders pedido_venda ordem_servico vendas propostas ordens_servico"], [C, "purchase_orders pedidos_compra"],
  [E, "warehouses lotes lots estoque stock_movements"], [F, "receivables payables contas_receber contas_pagar"], [N, "nfe nfce nota_fiscal invoices notas_saida notas_entrada"],
]);
export const erpEntityRequirement = (entity: unknown): ErpRequirement | null => typeof entity === "string" && Object.hasOwn(ERP_ENTITY_PARTS, entity) ? erpRequirement(ERP_ENTITY_PARTS[entity]) : null;
/** A planilha exige as partes dos cadastros/efeitos que grava, inclusive em simulação. */
export const ERP_IMPORT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  produtos: "products", contatos: "contacts", "pedidos-compra": "purchase_orders", "movimentacoes-estoque": "stock_movements",
  "contas-receber": "receivables", "contas-pagar": "payables", vendas: "sales_orders", "notas-fiscais": "nfe",
  composicoes: "compositions", "campos-customizados": "custom_fields", "fornecedores-produtos": "product_suppliers", lotes: "lots",
});
export function erpImportRequirement(kind: unknown): ErpRequirement | null {
  if (typeof kind !== "string" || !Object.values(ERP_IMPORT_KINDS).includes(kind)) return null;
  return kind === "lots" || kind === "compositions" ? erpRequirement(P, E) : erpEntityRequirement(kind);
}
export const ERP_PREFERENCE_PARTS = groups([
  [B, "empresa-geral empresa-armazenamento sistema-interface cadastros-contatos central-notificacoes"],
  [P, "cadastros-produtos"], [S, "vendas-vendas vendas-propostas servicos-os meu-negocio"], [C, "suprimentos-compras"],
  [E, "cadastros-lotes suprimentos-estoque"], [F, "financas-pagar financas-receber contabilidade-contador"],
  [N, "notas-nfe notas-nfce certificado-digital"], [V, "vendas-frente-caixa"],
]);
export const erpPreferenceRequirement = (page: unknown): ErpRequirement | null => typeof page === "string" && Object.hasOwn(ERP_PREFERENCE_PARTS, page) ? erpRequirement(ERP_PREFERENCE_PARTS[page]) : null;
export const ERP_REPORT_PARTS = groups([
  [B, "contatos pessoas_contato"], [P, "produtos"], [C, "pedidos_compra"],
  [S, "vendas propostas ordens_servico curva_abc ocorrencias_propostas ocorrencias_os ocorrencias_vendas transporte_venda venda_parcela comissoes"],
  [F, "contas_receber contas_pagar recebimentos pagamentos caixa ficha_receber ficha_pagar"], [N, "notas_saida notas_entrada nfce transporte_nota"],
]);
/** Campos mistos: requisito para consultar/alterar, não para reenviar valor preservado. */
export const ERP_FIELD_REQUIREMENTS: Readonly<Record<string, readonly ErpModuleId[]>> = Object.freeze({
  account: [F], account_id: [F], category: [F], category_id: [F], financial_category: [F], fee: [F], fee_id: [F], commission: [F], commission_rate: [F],
  auto_finance: [F], finance_action: [F], credit_limit: [F], bank_account: [F], financial_account_id: [F],
  warehouse: [E], warehouse_id: [E], lot: [E], lot_id: [E], lots: [E], component_id: [P, E], components: [P, E], composition: [P, E], composition_sync: [P, E], stock_action: [E], initial_stock: [P, E], initial_balance: [P, E],
  stock: [E], balance: [E], available: [E], reserved: [S, E], forecast: [S, E], coverage: [S, E],
  cost: [S, C, E], applied_cost: [S, C, E], margin: [S, C, E], profit: [S, C, E],
  boleto: [F, K], fiscal_emission: [N], invoice: [N], product: [P], product_id: [P],
});
export function erpFieldRequirement(field: string, owner?: ErpModuleId): ErpRequirement {
  if (owner === P && ["category", "category_id"].includes(field)) return erpRequirement(P);
  return erpRequirement(...(owner ? [owner] : []), ...(ERP_FIELD_REQUIREMENTS[field] ?? []));
}
export function erpReportRequirement(base: unknown, columns: readonly unknown[] = [], filters: readonly unknown[] = []): ErpRequirement | null {
  if (typeof base !== "string" || !Object.hasOwn(ERP_REPORT_PARTS, base)) return null;
  if (!Array.isArray(columns) || !Array.isArray(filters)) return null;
  const extra = [...columns, ...filters.map(f => typeof f === "object" && f ? (f as { column?: unknown }).column : f)]
    .flatMap(c => typeof c === "string" ? erpFieldRequirement(c).all : []);
  return erpRequirement(ERP_REPORT_PARTS[base], ...(["venda_parcela", "comissoes"].includes(base) ? [F] : []) as ErpModuleId[], ...extra);
}
export const ERP_NOTIFICATION_PARTS = groups([
  [F, "contas_pagar_atrasadas contas_receber_atrasadas pagamento_efetuado pagamento_recebido"],
  [E, "estoque_abaixo_minimo estoque_maximo estoque_zerado lote_vencimento"], [P, "validade"], [S, "proximo_contato"], [B, "cliente_visitado"], [N, "certificado_a1"],
]);
export const erpNotificationRequirement = (type: unknown): ErpRequirement | null => typeof type === "string" && Object.hasOwn(ERP_NOTIFICATION_PARTS, type) ? erpRequirement(ERP_NOTIFICATION_PARTS[type]) : null;
export const ERP_OPERATION_REQUIREMENTS = {
  cash: erpRequirement(F), pos: erpRequirement(V), purchase_receipt: erpRequirement(C, E), reservation: erpRequirement(S, E),
  composition: erpRequirement(P, E), purchase_suggestion: erpRequirement(C, E), forecast: erpRequirement(S, E),
  margin: erpRequirement(S, C, E), billing: erpRequirement(F, K), product_opening: erpRequirement(P, E),
} as const;
export type ErpOperation = keyof typeof ERP_OPERATION_REQUIREMENTS;
export const erpOperationRequirement = (op: ErpOperation) => ERP_OPERATION_REQUIREMENTS[op];
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
/** Só requisitos conhecidos antes do objeto; IDs e definições são revalidados pelo motor. */
export function erpRouteRequirement(method: string, url: URL, body?: unknown): ErpRequirement | "externo" | null {
  const path = url.pathname.replace(/\/$/, ""), block = erpBlockOf(path);
  if (!block || block === "externo") return block;
  if (!erpRouteExists(method, path)) return null;
  const input = { ...Object.fromEntries(url.searchParams), ...record(body) };
  const ids: ErpModuleId[] = [block];
  const add = (r: ErpRequirement | null) => { if (r) ids.push(...r.all); return !!r; };
  const family = /^\/v1\/(?:documentos|duplicacao-documentos|records)\/([^/]+)/.exec(path);
  if (family && family[1] !== "sacola-vendas" && !add(erpEntityRequirement(family[1]))) return null;
  const physical = /^\/v1\/documentos-estoque\/([^/]+)/.exec(path);
  if (physical && !add(erpEntityRequirement(physical[1]))) return null;
  const cad = /^\/v1\/cadastros\/taxonomias\/([^/]+)/.exec(path);
  if (cad && !add(erpEntityRequirement(cad[1])) && !["tags", "grupos-tags", "tipos-contato"].includes(cad[1])) return null;
  const pref = /^\/v1\/preferencias\/([^/]+)/.exec(path);
  if (pref && ERP_PREFERENCE_PARTS[pref[1]]) add(erpPreferenceRequirement(pref[1]));
  const imported = /^\/v1\/importacoes\/([^/]+)\/lote$/.exec(path);
  if (imported && !add(erpImportRequirement(ERP_IMPORT_KINDS[imported[1]]))) return null;
  for (const key of ["entity", "tipo", "document_type"]) if (input[key] !== undefined && /\/(documentos|duplicacao-documentos|records|anexos|importacoes)/.test(path)) {
    if (!add(erpEntityRequirement(input[key]))) return null;
  }
  if (/\/(documentos|duplicacao-documentos)\//.test(path)) {
    if (/\/(financeiro|categorias|comissao|comissoes)(\/|$)/.test(path)) ids.push(F);
    if (/\/(estoque|lotes|componentes)(\/|$)/.test(path)) ids.push(E);
    if (/xml/.test(path)) ids.push(N, P);
  }
  if (/recebimentos-compras|estoque\/(compras|(?:painel\/)?sugestao)|sugestao-compra/.test(path)) ids.push(C, E);
  if (/reservas-estoque/.test(path) && !/disponibilidade/.test(path)) ids.push(S, E);
  if (/estoque\/(notas-fiscais|checkin|relatorios\/notas-entrada)/.test(path)) ids.push(N, E);
  if (/financeiro\/(notas|actions\/invoice_finance)/.test(path)) ids.push(N, F);
  if (input.purchase_order || input.purchase_order_id || input.order_id && /checkin|nota/.test(path)) ids.push(C);
  if (/\/(composicoes|componentes)/.test(path)) ids.push(P, E);
  if (/cadastros\/products\/compras/.test(path)) ids.push(C);
  if (/cadastros\/products/.test(path) && !["GET", "HEAD"].includes(method.toUpperCase()) &&
      ["initial_stock", "initial_balance", "stock", "composition", "composition_sync", "components"].some(k => input[k] != null || record(input.data)[k] != null)) ids.push(P, E);
  if (/cadastros\/products|\/documentos\//.test(path) && ["GET", "HEAD"].includes(method.toUpperCase())) {
    if (["stock", "warehouse_id", "component_id", "lots"].some(k => input[k] != null && input[k] !== "")) ids.push(E);
    if (["composition", "no_composition"].includes(input.type) || input.format === "E") ids.push(E);
  }
  if (/notas-fiscais|cadastros\/notas-fiscais/.test(path) && input.category_id != null) ids.push(F);
  if (/notas-fiscais|cadastros\/notas-fiscais/.test(path) && input.product_id != null) ids.push(P);
  if ((input.action === "account_set_default" || path.endsWith("/account_set_default")) && input.target === "boleto") ids.push(F, K);
  if (/cadastros\/(?:contatos|contacts)\/[^/]+\/historico$/.test(path)) {
    if (!add(erpEntityRequirement(input.kind ?? input.type ?? "sales_orders"))) return null;
  }
  if (input.section || input.history_type) if (!add(erpEntityRequirement(input.section ?? input.history_type))) return null;
  if (/margem|margin/.test(String(input.painel ?? input.panel ?? ""))) ids.push(S, C, E);
  if (path === "/v1/meu-negocio/margem-pedido") ids.push(S, C, E);
  if (path === "/v1/meu-negocio/previsao-estoque") ids.push(S, E);
  if (/previsao|cobertura/.test(String(input.painel ?? ""))) ids.push(S, E);
  if (/\/sistema\/(situacoes|transicoes)(\/|$)/.test(path) && input.kind !== undefined && !add(erpEntityRequirement(input.kind))) return null;
  if (/\/sistema\/etiquetas(?:\/registros)?$/.test(path) && (input.type ?? input.data?.type) !== undefined && !add(erpEntityRequirement(input.type ?? input.data?.type))) return null;
  if (input.base && /relatorio/.test(path) && !add(erpReportRequirement(input.base, input.columns, input.filters))) return null;
  const list = /^\/v1\/preferencias-listas\/([^/]+)$/.exec(path);
  if (list && !add(erpListRequirement(list[1]))) return null;
  return erpRequirement(...ids);
}
export const ERP_PREFERENCE_DESTINATIONS: Readonly<Record<string, string>> = {
  "/preferencias/sistema/central-notificacoes": "central-notificacoes",
  "/preferencias/cadastros/produtos": "cadastros-produtos",
  "/preferencias/vendas/frente-caixa": "vendas-frente-caixa",
  "/preferencias/contabilidade/meu-contador": "contabilidade-contador",
  "/preferencias/notas-fiscais/nfe": "notas-nfe",
  "/preferencias/notas-fiscais/nfce": "notas-nfce",
  "/preferencias/servicos/ordens-servico": "servicos-os",
  "/preferencias/financas/contas-pagar": "financas-pagar",
  "/preferencias/cadastros/clientes-fornecedores": "cadastros-contatos",
  "/preferencias/vendas/propostas-comerciais": "vendas-propostas",
  "/preferencias/suprimentos/pedidos-compra": "suprimentos-compras",
  "/preferencias/meu-negocio/ajustes": "meu-negocio",
  "/preferencias/suprimentos/estoque": "suprimentos-estoque",
  "/preferencias/certificado/configuracoes": "certificado-digital",
  "/preferencias/financas/contas-receber": "financas-receber",
  "/preferencias/empresa/armazenamento": "empresa-armazenamento",
  "/preferencias/vendas/vendas": "vendas-vendas",
  "/preferencias/cadastros/lotes": "cadastros-lotes",
  "/preferencias/empresa/geral": "empresa-geral",
  "/preferencias/sistema/interface": "sistema-interface"
};
export interface ErpDestinationRequirement { owner: ErpModuleId; requirement: ErpRequirement }
/** Destinos do painel e atalhos salvos compartilham o mesmo mapa puro. */
export function erpDestinationRequirement(value: URL | string): ErpDestinationRequirement | null {
  const url = value instanceof URL ? value : new URL(value, "https://erp.invalid");
  const path = url.pathname, q = url.searchParams;
  let owner: ErpModuleId | undefined; const extra: ErpModuleId[] = [];
  const preference = Object.keys(ERP_PREFERENCE_DESTINATIONS).find(prefix => path === prefix || path.startsWith(prefix + "/"));
  if (preference) owner = ERP_PREFERENCE_PARTS[ERP_PREFERENCE_DESTINATIONS[preference]];
  else if (["/preferencias/sistema/registro-atividades", "/preferencias/sistema/consulta-exclusoes"].includes(path)) owner = B;
  else if (path.startsWith("/ajuda/")) owner = B;
  else if (["/acesso", "/visao-geral", "/cadastros-empresa", "/preferencias", "/empresa-configuracoes", "/ajuda", "/importacoes", "/relatorios-customizados", "/etiquetas", "/transicoes", "/arquivos", "/manutencao-efeitos"].includes(path)) owner = B;
  else if (path === "/cadastros-reais") owner = ERP_ENTITY_PARTS[q.get("cadastro") ?? ""];
  else if (path === "/documentos-empresa") owner = ERP_ENTITY_PARTS[q.get("tipo") ?? ""];
  else if (["/estoque-empresa", "/estoque-abertura", "/conferencia-estoque-empresa", "/relatorios-estoque", "/painel-produtos-empresa"].includes(path)) { owner = E; if (q.get("painel") === "sugestao" || q.get("relatorio") === "compras") extra.push(C); }
  else if (["/financeiro-empresa", "/relatorio-vencimentos"].includes(path)) owner = ["remessas", "retornos"].includes(q.get("area") ?? "") ? K : F;
  else if (["/cobranca-empresa", "/cobranca-operacional", "/retornos-operacionais"].includes(path)) owner = K;
  else if (["/historico-fiscal", "/notas-entrada", "/notas-recebidas", "/numeracao-fiscal", "/naturezas-operacao", "/inutilizacoes-nfe", "/cartas-correcao", "/certificado-a1", "/conexao-sefaz", "/emissor-fiscal"].includes(path)) owner = N;
  else if (path === "/checkin-recebimentos") { owner = N; extra.push(E); if (q.get("order_id")) extra.push(C); }
  else if (path === "/frente-caixa-empresa") owner = V;
  else if (path === "/meu-negocio") { owner = S; if (q.get("painel")?.includes("margem")) extra.push(C, E); if (/previsao|cobertura/.test(q.get("painel") ?? "")) extra.push(E); }
  else if (/^\/(tipos-contatos-empresa|vendedores-empresa|formas-pagamento-empresa|funcionarios-empresa|importar-contatos|numeracao-contatos|tipos-contato|numeros-contato|importacao-contatos|vendedores|funcionarios|formas-pagamento|tags|grupos-tags)$/.test(path)) owner = B;
  else if (/^\/(categorias-produtos|grupos-produtos|exportacao-produtos|listas-precos|campos-customizados)$/.test(path)) owner = P;
  return owner ? { owner, requirement: erpRequirement(owner, ...extra) } : null;
}

export const ERP_MAINTENANCE_HEADER = "x-erp-maintenance";
export const ERP_MAINTENANCE_ACTIONS = {
  document_stock_reverse: { rpc: "erp_document_stock_reverse" },
  document_stock_reverse_preview: { rpc: "erp_document_stock_reverse_preview" },
  document_finance_reverse: { rpc: "erp_document_finance_reverse" },
  document_finance_reverse_preview: { rpc: "erp_document_finance_reverse_preview" },
  invoice_stock_reverse: { rpc: "erp_stock_invoice_reverse" },
  invoice_stock_reverse_preview: { rpc: "erp_stock_invoice_reverse_preview" },
  invoice_finance_reverse: { rpc: "erp_finance_invoice_finance_reverse" },
  reservation_release: { rpc: "erp_stock_reservation_apply", action: "release" },
  reservation_release_preview: { rpc: "erp_stock_reservation_preview", action: "release" },
  purchase_receipt_reverse: { rpc: "erp_purchase_receipts_reverse" },
  purchase_receipt_reverse_preview: { rpc: "erp_purchase_receipts_reverse_preview" },
  grouped_billing_delete: { rpc: "erp_finance_grouped_billing_execute", action: "grouped_billing_delete" },
  settlement_reverse: { rpc: "erp_finance_execute", action: "reverse" },
  remittance_exclude: { rpc: "erp_cnab_remittance_exclude" },
  return_exclude: { rpc: "erp_cnab_return_exclude" },
  pos_sale_cancel: { rpc: "erp_pos_sale_execute", action: "sale_cancel" },
} as const;
export type ErpMaintenanceAction = keyof typeof ERP_MAINTENANCE_ACTIONS;
export interface ErpMaintenanceRequest {
  origin: { type: string; id: string };
  action: ErpMaintenanceAction | "inspect";
}
export function readErpMaintenance(value: unknown): ErpMaintenanceRequest | null {
  const v = record(value), origin = record(v.origin);
  if (Object.keys(v).some(k => !["action", "origin"].includes(k)) || Object.keys(origin).some(k => !["type", "id"].includes(k)) ||
      typeof origin.type !== "string" || typeof origin.id !== "string" || !/^[0-9a-f-]{36}$/i.test(origin.id) ||
      !(v.action === "inspect" || Object.hasOwn(ERP_MAINTENANCE_ACTIONS, v.action))) return null;
  return { action: v.action, origin: { type: origin.type, id: origin.id.toLowerCase() } };
}
export function maintenanceReadRpc(origin: ErpMaintenanceRequest["origin"]): { rpc: string; args: Record<string, unknown> } | null {
  if (["sales_orders", "sales_proposals", "service_orders", "purchase_orders"].includes(origin.type))
    return { rpc: "erp_document_get", args: { p_kind: origin.type, p_id: origin.id } };
  if (["nfe", "nfce"].includes(origin.type)) return { rpc: "erp_fiscal_invoice_get", args: { p_id: origin.id } };
  if (["receivables", "payables"].includes(origin.type)) return { rpc: "erp_finance_title_detail", args: { p_id: origin.id } };
  if (origin.type === "pos_sale") return { rpc: "erp_pos_sale_get", args: { p_id: origin.id } };
  // Os próprios RPCs de exclusão validam os acessos a cobrança/grupos.
  if (["remittance", "return_file", "grouped_billing"].includes(origin.type)) return { rpc: "erp_access_me", args: {} };
  return null;
}

/** Requisitos adicionais de campos mistos de preferência, preserváveis quando ocultos. */
export const ERP_PREFERENCE_FIELD_REQUIREMENTS: Readonly<Record<string, readonly ErpModuleId[]>> = Object.freeze({
  "produtos.composicao_custo": [P, E], "produtos.estoque_relatorio_preco": [E],
  "vendas.ver_contas_receber": [F], "vendas.contas_automaticas_nota": [F, N], "vendas.contas_automaticas_pedido": [F],
  "vendas.base_comissao": [F], "vendas.numero_documento_conta": [F], "vendas.estoque_negativo": [E],
  "compras.automacao_contas_pagar": [F], "compras.ver_contas_pagar": [F],
  "os.data_contas": [F], "os.numero_documento_conta": [F],
  "nfe.base_comissao_total": [F], "nfe.bloquear_edicao_contas": [F], "nfe.contas_pagar_entrada": [F, C],
  "nfe.lancar_contas": [F], "nfe.email_boleto": [F, K], "nfe.bloquear_edicao_estoque": [E], "nfe.estoque_checkin": [E], "nfe.lancar_estoque": [E],
  "nfce.lancar_contas": [F], "nfce.lancar_estoque": [E],
  "estoque.reserva_por_deposito": [S], "estoque.reserva_por_situacao": [S], "estoque.reserva_situacoes": [S], "estoque.nf_estoque_negativo": [N],
  "financas.comissoes_contas_pagar": [F], "financas.boletos_dias_antes": [K], "financas.boletos_dias_apos": [K],
  "financas.boletos_formas": [K], "financas.boletos_no_vencimento": [K], "financas.boletos_vinculo": [K],
  "financas.cobranca_boleto_assunto": [K], "financas.cobranca_boleto_mensagem": [K], "financas.retorno_taxas": [K],
});
export function erpPreferenceFieldRequirement(page: string, field: string): ErpRequirement | null {
  const owner = erpPreferenceRequirement(page); if (!owner) return null;
  const notification = /^notificacoes\.([a-z_]+)(?:\.|$)/.exec(field);
  const extra = notification ? erpNotificationRequirement(notification[1]) : erpRequirement(...(ERP_PREFERENCE_FIELD_REQUIREMENTS[field] ?? []));
  return extra ? erpRequirement(...owner.all, ...extra.all) : null;
}
export function erpCommissionRequirement(origin: string): ErpRequirement | null {
  const owner = erpEntityRequirement(origin); return owner ? erpRequirement(F, ...owner.all) : null;
}
export function erpGroupedBillingRequirement(origins: readonly string[]): ErpRequirement | null {
  const requirements = origins.map(erpEntityRequirement);
  return requirements.some(r => !r) ? null : erpRequirement(F, ...requirements.flatMap(r => r!.all));
}
export const erpInvoiceRequirement = (destination: "stock" | "finance", purchaseOrder = false) => erpRequirement(N, destination === "stock" ? E : F, ...(purchaseOrder ? [C] : []) as ErpModuleId[]);
export function erpXmlRequirement(origin: string): ErpRequirement | null {
  const owner = erpEntityRequirement(origin); return owner ? erpRequirement(N, P, ...owner.all) : null;
}
export const ERP_LIST_PARTS = groups([
  [B, "cadastros.contatos"], [P, "cadastros.produtos"],
  [S, "documentos.sales_orders documentos.sales_proposals documentos.service_orders"], [C, "documentos.purchase_orders"],
  [F, "financeiro.contas_receber financeiro.contas_pagar"], [N, "fiscal.nfe fiscal.nfce fiscal.entrada"],
]);
export const erpListRequirement = (list: unknown): ErpRequirement | null => typeof list === "string" && Object.hasOwn(ERP_LIST_PARTS, list) ? erpRequirement(ERP_LIST_PARTS[list]) : null;
/** Agendador: desconhecido permanece inelegível; exportação administrativa exige só Base. */
export function erpTaskRequirement(purpose: unknown, payload?: unknown): ErpRequirement | null {
  if (["company_export", "export_cleanup", "exports_cleanup", "retention", "schedule", "cleanup"].includes(String(purpose))) return erpRequirement(B);
  if (purpose === "notifications_generate" || purpose === "notification_digest" || purpose === "notifications") {
    const data = record(payload);
    return data.type ? erpNotificationRequirement(data.type) : erpRequirement(B); // Digest misto filtra cada tipo antes do cálculo.
  }
  return erpNotificationRequirement(purpose);
}
