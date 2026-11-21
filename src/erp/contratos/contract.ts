// Contratos de serviço, em /api/v1/profiles/:profile/erp-contratos.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP (Financeiro › Contratos), para a API e para o inventário de
// concessões dos bots (src/modules/erp/bot-access.ts), no assunto Contratos.
// Consultar contratos, faturas, avisos, índices e a prévia do reajuste é
// leitura comum; ativar, suspender, reajustar e encerrar são sensíveis (o bot
// propõe, uma pessoa confirma). As demais ficam só na tela. As rotas do
// Worker ficam em ./routes.ts; cada operação exige a parte Contratos (e o
// Financeiro, de que ela depende): desligada, 409 module_disabled e qual ligar.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp-contratos: desligado, 409 module_disabled). */
export const ERP_CONTRATOS_ROUTE = "erp-contratos";
export const ERP_CONTRATOS_PART: ErpModuleId = "erp-contratos";

export interface ErpContractOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
  /** O corpo é o PDF (envio do anexo), não JSON. */
  file?: boolean;
}

const R = ERP_CONTRATOS_ROUTE;
const CONTRACT_FIELDS = ["cliente", "objeto", "inicio", "fim", "prazo_meses", "periodicidade", "dia_vencimento", "forma_pagamento", "categoria", "vendedor",
  "itens", "reajuste", "aviso_renovacao_dias", "observacoes"] as const;
export const ERP_CONTRACT_OPERATIONS: readonly ErpContractOperation[] = Object.freeze([
  {
    name: "erp.contratos.lista", method: "GET", path: `${R}/contratos`, sensitive: false, rpc: "erp_contract_list",
    summary: "Consultar os contratos de serviço",
    description: "Lista os contratos de serviço com o cliente, o objeto, a vigência, a periodicidade, o dia de vencimento, o valor por período, a situação (rascunho, ativo, suspenso ou encerrado) e se a cobrança recorrente está ligada. Filtra por situação, cliente, busca e contratos que terminam nos próximos dias. Só consulta.",
    query: ["situacao", "busca", "cliente", "pagina", "vencendo_em"], body: [], required: [],
  },
  {
    name: "erp.contratos.ver", method: "GET", path: `${R}/contratos/:id`, sensitive: false, rpc: "erp_contract_get",
    summary: "Ver um contrato de serviço",
    description: "Mostra o contrato com os itens e o valor por período, a cobrança recorrente (ligada ou não, próximo período e vencimento), o reajuste (índice, mês de aniversário e próximo reajuste), as faturas geradas, os avisos pendentes, os anexos e o histórico (aditivos, reajustes, renovações). Só consulta.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.contratos.faturas", method: "GET", path: `${R}/faturas`, sensitive: false, rpc: "erp_contract_invoices",
    summary: "Consultar as faturas dos contratos",
    description: "Lista as contas a receber geradas pelos contratos, período a período, com o vencimento, o valor, a situação no Financeiro (em aberto, vencida, paga ou cancelada), se a cobrança pelo WhatsApp foi enviada e a situação da nota de serviço. Filtra por contrato, situação e período de vencimento. Só consulta.",
    query: ["contrato", "situacao", "de", "ate", "pagina"], body: [], required: [],
  },
  {
    name: "erp.contratos.avisos", method: "GET", path: `${R}/avisos`, sensitive: false, rpc: "erp_contract_notices",
    summary: "Ver os avisos dos contratos",
    description: "Lista os avisos pendentes dos contratos: renovação perto do fim da vigência, mês de reajuste chegando e a mensagem de reajuste para o cliente. Só consulta.",
    query: ["situacao"], body: [], required: [],
  },
  {
    name: "erp.contratos.indices", method: "GET", path: `${R}/indices`, sensitive: false, rpc: "erp_contract_rates",
    summary: "Ver a tabela de índices de reajuste",
    description: "Mostra os percentuais de IPCA, IGP-M e INPC que a empresa informou mês a mês (o sistema não busca índice na internet). Só consulta.",
    query: ["indice"], body: [], required: [],
  },
  {
    name: "erp.contratos.reajuste_previa", method: "GET", path: `${R}/contratos/:id/reajuste`, sensitive: false, rpc: "erp_contract_adjust_preview",
    summary: "Conferir o próximo reajuste de um contrato",
    description: "Mostra o mês de referência do próximo reajuste, o percentual (o do índice na tabela ou o fixo do contrato), os itens antes e depois e o valor novo por período. Se o índice do mês ainda não foi informado, diz qual falta. Só consulta.",
    query: ["a_partir_de"], body: [], required: ["id"],
  },
  {
    name: "erp.contratos.ativar", method: "POST", path: `${R}/contratos/:id/ativar`, sensitive: true, rpc: "erp_contract_status",
    summary: "Ativar um contrato de serviço",
    description: "Passa o contrato de rascunho para ativo. A cobrança recorrente continua como está (nasce desligada): ativar não gera conta sozinho. O bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "comando"], required: ["id", "versao"],
  },
  {
    name: "erp.contratos.suspender", method: "POST", path: `${R}/contratos/:id/suspender`, sensitive: true, rpc: "erp_contract_status",
    summary: "Suspender um contrato de serviço",
    description: "Suspende o contrato ativo: enquanto estiver suspenso, nenhuma conta é gerada e os períodos da suspensão não são cobrados depois. O bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "motivo", "comando"], required: ["id", "versao"],
  },
  {
    name: "erp.contratos.reativar", method: "POST", path: `${R}/contratos/:id/reativar`, sensitive: true, rpc: "erp_contract_status",
    summary: "Reativar um contrato suspenso",
    description: "Volta o contrato suspenso para ativo; a cobrança, se ligada, recomeça no período de hoje. Pela tela.",
    query: [], body: ["versao", "comando"], required: ["id", "versao"], bot: false,
  },
  {
    name: "erp.contratos.encerrar", method: "POST", path: `${R}/contratos/:id/encerrar`, sensitive: true, rpc: "erp_contract_status",
    summary: "Encerrar um contrato de serviço",
    description: "Encerra o contrato com o motivo e a data: nenhuma conta nova é gerada; as já geradas continuam no Financeiro. O bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "motivo", "data", "comando"], required: ["id", "versao", "motivo"],
  },
  {
    name: "erp.contratos.reajustar", method: "POST", path: `${R}/contratos/:id/reajuste`, sensitive: true, rpc: "erp_contract_adjust",
    summary: "Aplicar o reajuste de um contrato",
    description: "Aplica o reajuste conferido na prévia (mês de referência e percentual iguais aos da prévia): os itens ganham o valor novo a partir da data, com histórico; as faturas já geradas não mudam. Se a opção estiver ligada, prepara a mensagem de aviso ao cliente. O bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "mes", "percentual", "a_partir_de", "comando"], required: ["id", "versao", "mes", "percentual"],
  },
  {
    name: "erp.contratos.opcoes", method: "GET", path: `${R}/opcoes`, sensitive: false, rpc: "erp_contract_options",
    summary: "Ver as opções do cadastro de contrato",
    description: "Categorias de receita, formas de recebimento, vendedores, periodicidades e índices; com busca, procura cliente ou serviço do catálogo. Pela tela.",
    query: ["busca", "tipo"], body: [], required: [], bot: false,
  },
  {
    name: "erp.contratos.criar", method: "POST", path: `${R}/contratos`, sensitive: true, rpc: "erp_contract_save",
    summary: "Criar um contrato de serviço",
    description: "Cria o contrato em rascunho com o cliente, o objeto, os itens, a vigência, a periodicidade, o dia de vencimento, a forma de pagamento, a categoria, o vendedor e o reajuste. Pela tela.",
    query: [], body: [...CONTRACT_FIELDS, "comando"], required: ["cliente", "objeto", "inicio", "periodicidade", "dia_vencimento", "itens"], bot: false,
  },
  {
    name: "erp.contratos.editar", method: "POST", path: `${R}/contratos/:id`, sensitive: true, rpc: "erp_contract_save",
    summary: "Editar um contrato de serviço",
    description: "Altera os dados do contrato. Em rascunho, tudo; depois de ativo, cliente, início, fim, periodicidade e itens só mudam por aditivo ou renovação. Pela tela.",
    query: [], body: ["versao", ...CONTRACT_FIELDS, "comando"], required: ["id", "versao"], bot: false,
  },
  {
    name: "erp.contratos.cobranca", method: "POST", path: `${R}/contratos/:id/cobranca`, sensitive: true, rpc: "erp_contract_billing",
    summary: "Ligar ou desligar a cobrança recorrente de um contrato",
    description: "Liga (a partir do período escolhido, ou do período de hoje) ou desliga a geração da conta a receber de cada período, com as opções de deixar a cobrança pelo WhatsApp para enviar e de marcar a NFS-e para emitir. Pela tela.",
    query: [], body: ["versao", "ligada", "enviar_whatsapp", "emitir_nfse", "a_partir_de", "comando"], required: ["id", "versao", "ligada"], bot: false,
  },
  {
    name: "erp.contratos.faturar", method: "POST", path: `${R}/contratos/:id/faturar`, sensitive: true, rpc: "erp_contract_bill_now",
    summary: "Gerar agora a conta de um período",
    description: "Gera já a conta a receber de um período do contrato ativo (uma só por período), sem esperar o alarme. Pela tela.",
    query: [], body: ["versao", "periodo", "comando"], required: ["id", "versao", "periodo"], bot: false,
  },
  {
    name: "erp.contratos.fatura_marcar", method: "POST", path: `${R}/faturas/:id/marcar`, sensitive: true, rpc: "erp_contract_invoice_mark",
    summary: "Marcar a cobrança ou a nota de uma fatura",
    description: "Marca a cobrança da fatura como enviada, a enviar ou dispensada, ou a NFS-e como emitida. Pela tela.",
    query: [], body: ["acao", "comando"], required: ["id", "acao"], bot: false,
  },
  {
    name: "erp.contratos.indice_salvar", method: "POST", path: `${R}/indices`, sensitive: true, rpc: "erp_contract_rate_save",
    summary: "Informar o percentual de um índice no mês",
    description: "Grava (ou apaga, com percentual vazio) o percentual acumulado do IPCA, IGP-M ou INPC de um mês, para os reajustes. Pela tela.",
    query: [], body: ["indice", "mes", "percentual", "comando"], required: ["indice", "mes"], bot: false,
  },
  {
    name: "erp.contratos.aditivo", method: "POST", path: `${R}/contratos/:id/aditivo`, sensitive: true, rpc: "erp_contract_amend",
    summary: "Registrar um aditivo no contrato",
    description: "Muda os itens ou o valor a partir de uma data, ou o fim da vigência, com o motivo e histórico; as faturas já geradas não mudam. Pela tela.",
    query: [], body: ["versao", "a_partir_de", "itens", "fim", "motivo", "comando"], required: ["id", "versao", "a_partir_de", "motivo"], bot: false,
  },
  {
    name: "erp.contratos.renovar", method: "POST", path: `${R}/contratos/:id/renovar`, sensitive: true, rpc: "erp_contract_renew",
    summary: "Renovar um contrato",
    description: "Estende a vigência pelo prazo do contrato (ou até a data informada), com histórico. Pela tela.",
    query: [], body: ["versao", "fim", "comando"], required: ["id", "versao"], bot: false,
  },
  {
    name: "erp.contratos.aviso_fechar", method: "POST", path: `${R}/avisos/:id`, sensitive: false, rpc: "erp_contract_notice_close",
    summary: "Dar um aviso por resolvido",
    description: "Marca o aviso como feito ou dispensado. Pela tela.",
    query: [], body: ["acao", "comando"], required: ["id", "acao"], bot: false,
  },
  {
    name: "erp.contratos.anexo_enviar", method: "POST", path: `${R}/contratos/:id/anexos`, sensitive: true, rpc: "erp_contract_attachment_add",
    summary: "Anexar o contrato assinado em PDF",
    description: "Guarda o PDF (até 10 MB) no armazenamento da área e o liga ao contrato. Pela tela.",
    query: ["nome"], body: [], required: ["id", "nome"], bot: false, file: true,
  },
  {
    name: "erp.contratos.anexo_baixar", method: "GET", path: `${R}/anexos/:id`, sensitive: false, rpc: "erp_contract_attachment_get",
    summary: "Baixar um anexo do contrato",
    description: "Devolve o PDF anexado ao contrato. Pela tela.",
    query: [], body: [], required: ["id"], bot: false, file: true,
  },
  {
    name: "erp.contratos.anexo_retirar", method: "POST", path: `${R}/anexos/:id/retirar`, sensitive: true, rpc: "erp_contract_attachment_remove",
    summary: "Retirar um anexo do contrato",
    description: "Tira o anexo da lista do contrato (fica no histórico). Pela tela.",
    query: [], body: ["comando"], required: ["id"], bot: false,
  },
  {
    name: "erp.contratos.bling", method: "GET", path: `${R}/bling`, sensitive: false, rpc: "erp_contract_bling_list",
    summary: "Ver os contratos do Bling para adotar",
    description: "Prévia dos contratos coletados do Bling como contrato de serviço: cliente, vigência, periodicidade, itens e o que impede a adoção. Pela tela.",
    query: ["cursor"], body: [], required: [], bot: false,
  },
  {
    name: "erp.contratos.bling_adotar", method: "POST", path: `${R}/bling/:fonte/adotar`, sensitive: true, rpc: "erp_contract_bling_adopt",
    summary: "Adotar um contrato do Bling como contrato de serviço",
    description: "Cria o contrato de serviço em rascunho, com a cobrança desligada, a partir do contrato do Bling conferido na prévia. Pela tela.",
    query: [], body: ["versao_bling", "periodicidade", "dia_vencimento", "categoria", "forma_pagamento", "comando"], required: ["fonte", "versao_bling"], bot: false,
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpContractOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_CONTRACT_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const uuid = { type: "string", format: "uuid" };
const date = { type: "string", format: "date" };
const money = { type: "string", pattern: "^[0-9]{1,11}([.,][0-9]{1,2})?$", description: "Valor em reais, como 350.00." };
const percent = { type: "string", pattern: "^-?[0-9]{1,3}([.,][0-9]{1,4})?$", description: "Percentual, como 4.56 (para 4,56%)." };
const item = { type: "object", properties: { servico: uuid, descricao: { type: "string", maxLength: 400 }, quantidade: { type: "string" }, valor: money }, required: ["valor"] };
/** Esquema de cada parâmetro (consulta, caminho e corpo). */
export const ERP_CONTRACT_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  id: uuid, cliente: uuid, contrato: uuid, forma_pagamento: uuid, categoria: uuid, vendedor: uuid, comando: uuid,
  situacao: { type: "string", description: "Contratos: abertos, todos, rascunho, ativo, suspenso ou encerrado. Faturas: todas, em_aberto, vencidas, pagas, canceladas, cobranca_a_enviar ou nfse_a_emitir. Avisos: pendentes ou todos." },
  busca: { type: "string", maxLength: 120 }, pagina: { type: "integer", minimum: 1 }, vencendo_em: { type: "integer", minimum: 0, maximum: 3650, description: "Dias até o fim da vigência." },
  de: date, ate: date, inicio: date, fim: { type: ["string", "null"], format: "date", description: "Fim da vigência; vazio: prazo indeterminado." }, data: date, a_partir_de: date, periodo: date,
  mes: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", description: "Mês de referência, como 2027-03." },
  percentual: { ...percent, type: ["string", "null"] }, indice: { type: "string", enum: ["ipca", "igpm", "inpc"] },
  versao: { type: "integer", minimum: 1 }, motivo: { type: "string", minLength: 3, maxLength: 400 },
  objeto: { type: "string", maxLength: 4000 }, observacoes: { type: "string", maxLength: 4000 }, prazo_meses: { type: ["integer", "null"], minimum: 1, maximum: 600 },
  periodicidade: { type: "string", enum: ["mensal", "bimestral", "trimestral", "semestral", "anual"] }, dia_vencimento: { type: "integer", minimum: 1, maximum: 31 },
  itens: { type: "array", maxItems: 50, items: item },
  reajuste: { type: ["object", "null"], properties: { indice: { type: "string", enum: ["ipca", "igpm", "inpc", "fixo"] }, percentual: percent, mes: { type: "integer", minimum: 1, maximum: 12 }, avisar_cliente: { type: "boolean" } } },
  aviso_renovacao_dias: { type: "integer", minimum: 0, maximum: 365 }, ligada: { type: "boolean" }, enviar_whatsapp: { type: "boolean" }, emitir_nfse: { type: "boolean" },
  acao: { type: "string" }, nome: { type: "string", maxLength: 200 }, cursor: { type: "string" }, fonte: { type: "string" }, versao_bling: { type: "string" }, tipo: { type: "string", enum: ["clientes", "servicos"] },
});

/** Parâmetros (caminho, consulta e corpo) num objeto, para o inventário dos bots. */
export function erpContractParams(operation: ErpContractOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_CONTRACT_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_CONTRATOS_MODULE_CONTRACT = {
  routes: [ERP_CONTRATOS_ROUTE], operations: ["erp.contratos."],
  definition: { bot: { sensitive: ERP_CONTRACT_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_CONTRACT_OPERATIONS.map((op) => [op.name, op.summary])) } },
};

// ---------------------------------------------------------------------------
// Argumentos dos RPCs a partir da consulta, do caminho e do corpo.

/** Pedido com dado inválido (a rota responde 400 invalid_request com a mensagem). */
export class ContractArgsError extends Error {}
const bad = (message: string): never => { throw new ContractArgsError(message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidArg = (value: unknown, name: string, required = false): string | null => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: informe o identificador.`) : null;
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
};
export const PERIODICITY_ARG: Readonly<Record<string, string>> = { mensal: "monthly", bimestral: "bimonthly", trimestral: "quarterly", semestral: "semiannual", anual: "annual" };
const INDEX_ARG: Record<string, string> = { ipca: "ipca", igpm: "igpm", inpc: "inpc", fixo: "fixed" };
const CONTRACT_STATUS: Record<string, string> = { abertos: "open", todos: "all", rascunho: "draft", ativo: "active", suspenso: "suspended", encerrado: "ended" };
const INVOICE_STATUS: Record<string, string> = { todas: "all", em_aberto: "open", vencidas: "overdue", pagas: "paid", canceladas: "cancelled", cobranca_a_enviar: "charge_pending", nfse_a_emitir: "nfse_pending" };
const MARK: Record<string, string> = { cobranca_enviada: "charge_sent", cobranca_a_enviar: "charge_pending", dispensar_cobranca: "charge_none", nfse_emitida: "nfse_issued" };
const pick = (o: Record<string, unknown>, keys: readonly string[], name: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${name}: campo não aceito: ${extra.join(", ")}.`);
};
const version = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : bad("versao: informe a versão do contrato que você conferiu."));
const textValue = (value: unknown) => (typeof value === "number" ? String(value) : value);
function itemsArg(value: unknown) {
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== "object" || Array.isArray(v))) return bad("itens: envie a lista de itens.");
  return (value as Record<string, unknown>[]).map((i) => {
    pick(i, ["servico", "descricao", "quantidade", "valor"], "itens");
    return { ...(i.servico ? { product_id: uuidArg(i.servico, "itens.servico") } : {}), ...(i.descricao !== undefined ? { description: i.descricao } : {}),
      ...(i.quantidade !== undefined ? { quantity: textValue(i.quantidade) } : {}), unit_price: textValue(i.valor) };
  });
}
function adjustmentArg(value: unknown) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("reajuste: envie índice, mês e, no fixo, o percentual.");
  const r = value as Record<string, unknown>;
  pick(r, ["indice", "percentual", "mes", "avisar_cliente"], "reajuste");
  const index = typeof r.indice === "string" && Object.hasOwn(INDEX_ARG, r.indice) ? INDEX_ARG[r.indice] : bad("reajuste.indice: use ipca, igpm, inpc ou fixo.");
  return { index, month: r.mes, ...(r.percentual !== undefined && r.percentual !== null ? { percent: textValue(r.percentual) } : {}),
    ...(r.avisar_cliente !== undefined ? { notify: r.avisar_cliente } : {}) };
}
function contractData(body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const map: Record<string, string> = { objeto: "object", inicio: "starts_on", fim: "ends_on", prazo_meses: "term_months", dia_vencimento: "due_day",
    aviso_renovacao_dias: "renewal_notice_days", observacoes: "notes" };
  for (const [from, to] of Object.entries(map)) if (body[from] !== undefined) data[to] = body[from] === "" ? null : body[from];
  const refs: Record<string, string> = { cliente: "contact_id", forma_pagamento: "payment_method_id", categoria: "category_id", vendedor: "seller_id" };
  for (const [from, to] of Object.entries(refs)) if (body[from] !== undefined) data[to] = uuidArg(body[from], from, from === "cliente");
  if (body.periodicidade !== undefined) data.periodicity = typeof body.periodicidade === "string" && Object.hasOwn(PERIODICITY_ARG, body.periodicidade)
    ? PERIODICITY_ARG[body.periodicidade] : bad("periodicidade: use mensal, bimestral, trimestral, semestral ou anual.");
  if (body.itens !== undefined) data.items = itemsArg(body.itens);
  if (body.reajuste !== undefined) data.adjustment = adjustmentArg(body.reajuste);
  return data;
}
const STATUS_ACTION: Record<string, string> = { "erp.contratos.ativar": "activate", "erp.contratos.suspender": "suspend", "erp.contratos.reativar": "resume", "erp.contratos.encerrar": "end" };

/** Os argumentos do RPC (p_args/p_data e p_command_id) a partir do pedido. */
export async function contractRpcArgs(operation: ErpContractOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined,
  command: (body: Record<string, unknown>) => Promise<string>): Promise<Record<string, unknown>> {
  for (const key of query.keys()) if (!operation.query.includes(key) || query.getAll(key).length !== 1) bad(`Parâmetro não aceito: ${key}. Use ${operation.query.join(", ") || "nenhum"}.`);
  const q = (key: string) => { const v = query.get(key); return v === null || v === "" ? undefined : v; };
  const b = body ?? {};
  const write = async (data: Record<string, unknown>) => ({ p_command_id: await command(b), p_data: data });
  const page = () => { const p = q("pagina"); if (p !== undefined && !/^[1-9][0-9]{0,4}$/.test(p)) bad("pagina: use um número a partir de 1."); return p ? { page: Number(p) } : {}; };
  const id = () => uuidArg(params.id, "id", true);
  switch (operation.name) {
    case "erp.contratos.lista": {
      const status = q("situacao");
      if (status !== undefined && !Object.hasOwn(CONTRACT_STATUS, status)) bad(`situacao: use ${Object.keys(CONTRACT_STATUS).join(", ")}.`);
      const ending = q("vencendo_em");
      if (ending !== undefined && !/^[0-9]{1,4}$/.test(ending)) bad("vencendo_em: informe o número de dias.");
      return { p_args: { ...(status ? { status: CONTRACT_STATUS[status] } : {}), ...(q("busca") ? { q: q("busca") } : {}),
        ...(q("cliente") ? { contact_id: uuidArg(q("cliente"), "cliente") } : {}), ...(ending ? { ending_within: Number(ending) } : {}), ...page() } };
    }
    case "erp.contratos.ver": return { p_args: { id: id() } };
    case "erp.contratos.faturas": {
      const status = q("situacao");
      if (status !== undefined && !Object.hasOwn(INVOICE_STATUS, status)) bad(`situacao: use ${Object.keys(INVOICE_STATUS).join(", ")}.`);
      return { p_args: { ...(q("contrato") ? { contract_id: uuidArg(q("contrato"), "contrato") } : {}), ...(status ? { status: INVOICE_STATUS[status] } : {}),
        ...(q("de") ? { from: q("de") } : {}), ...(q("ate") ? { to: q("ate") } : {}), ...page() } };
    }
    case "erp.contratos.avisos": {
      const status = q("situacao");
      if (status !== undefined && !["pendentes", "todos"].includes(status)) bad("situacao: use pendentes ou todos.");
      return { p_args: status === "todos" ? { status: "all" } : {} };
    }
    case "erp.contratos.indices": {
      const index = q("indice");
      if (index !== undefined && !["ipca", "igpm", "inpc"].includes(index)) bad("indice: use ipca, igpm ou inpc.");
      return { p_args: index ? { index } : {} };
    }
    case "erp.contratos.reajuste_previa": return { p_args: { id: id(), ...(q("a_partir_de") ? { effective_on: q("a_partir_de") } : {}) } };
    case "erp.contratos.opcoes": {
      const busca = q("busca"), tipo = q("tipo");
      if (busca === undefined) return { p_args: {} };
      if (tipo !== "clientes" && tipo !== "servicos") bad("tipo: use clientes ou servicos.");
      return { p_args: { search: busca, kind: tipo === "clientes" ? "contacts" : "services" } };
    }
    case "erp.contratos.criar": return write(contractData(b));
    case "erp.contratos.editar": return write({ id: id(), expected_version: version(b.versao), ...contractData(b) });
    case "erp.contratos.ativar": case "erp.contratos.suspender": case "erp.contratos.reativar": case "erp.contratos.encerrar":
      return write({ id: id(), expected_version: version(b.versao), action: STATUS_ACTION[operation.name],
        ...(b.motivo !== undefined ? { reason: b.motivo } : {}), ...(b.data !== undefined ? { ended_on: b.data } : {}) });
    case "erp.contratos.cobranca":
      return write({ id: id(), expected_version: version(b.versao), enabled: b.ligada, ...(b.enviar_whatsapp !== undefined ? { send_whatsapp: b.enviar_whatsapp } : {}),
        ...(b.emitir_nfse !== undefined ? { emit_nfse: b.emitir_nfse } : {}), ...(b.a_partir_de ? { from: b.a_partir_de } : {}) });
    case "erp.contratos.faturar": return write({ id: id(), expected_version: version(b.versao), period_start: b.periodo });
    case "erp.contratos.fatura_marcar": {
      const action = typeof b.acao === "string" && Object.hasOwn(MARK, b.acao) ? MARK[b.acao] : bad(`acao: use ${Object.keys(MARK).join(", ")}.`);
      return write({ id: id(), action });
    }
    case "erp.contratos.indice_salvar":
      return write({ index: b.indice, month: b.mes, percent: b.percentual === undefined || b.percentual === "" ? null : textValue(b.percentual) });
    case "erp.contratos.reajustar":
      return write({ id: id(), expected_version: version(b.versao), month: b.mes, percent: textValue(b.percentual), ...(b.a_partir_de ? { effective_on: b.a_partir_de } : {}) });
    case "erp.contratos.aditivo":
      return write({ id: id(), expected_version: version(b.versao), effective_on: b.a_partir_de, reason: b.motivo,
        ...(b.itens !== undefined ? { items: itemsArg(b.itens) } : {}), ...(b.fim !== undefined ? { ends_on: b.fim === "" ? null : b.fim } : {}) });
    case "erp.contratos.renovar": return write({ id: id(), expected_version: version(b.versao), ...(b.fim ? { ends_on: b.fim } : {}) });
    case "erp.contratos.aviso_fechar": {
      const action = b.acao === "feito" ? "done" : b.acao === "dispensar" ? "dismissed" : bad("acao: use feito ou dispensar.");
      return write({ id: id(), action });
    }
    case "erp.contratos.anexo_baixar": return { p_args: { id: id() } };
    case "erp.contratos.anexo_retirar": return write({ id: id() });
    case "erp.contratos.bling": {
      const cursor = q("cursor");
      if (cursor !== undefined && !/^[1-9][0-9]{0,39}$/.test(cursor)) bad("cursor: inválido.");
      return { p_args: cursor ? { cursor } : {} };
    }
    case "erp.contratos.bling_adotar": {
      if (!/^[1-9][0-9]{0,39}$/.test(params.fonte ?? "")) bad("fonte: contrato do Bling inválido.");
      return write({ source_id: params.fonte, version: String(b.versao_bling ?? ""),
        ...(b.periodicidade !== undefined ? { periodicity: typeof b.periodicidade === "string" && Object.hasOwn(PERIODICITY_ARG, b.periodicidade) ? PERIODICITY_ARG[b.periodicidade] : bad("periodicidade: use mensal, bimestral, trimestral, semestral ou anual.") } : {}),
        ...(b.dia_vencimento !== undefined ? { due_day: b.dia_vencimento } : {}),
        ...(b.categoria ? { category_id: uuidArg(b.categoria, "categoria") } : {}), ...(b.forma_pagamento ? { payment_method_id: uuidArg(b.forma_pagamento, "forma_pagamento") } : {}) });
    }
  }
  return bad("Operação desconhecida.");
}
