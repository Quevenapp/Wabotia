// Produção (ordem de produção), em /api/v1/profiles/:profile/erp-producao.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP (Estoque › Produção), para a API e para o inventário de concessões
// dos bots (src/modules/erp/bot-access.ts), no assunto Produção. Consultar
// ordens e sugestões é leitura comum; criar, concluir e estornar são sensíveis
// (o bot propõe, uma pessoa confirma). As demais ficam só na tela. As rotas do
// Worker ficam em ./routes.ts; cada operação exige as partes do ERP dela
// (desligada: 409 module_disabled e qual ligar).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp-producao: desligado, 409 module_disabled). */
export const ERP_PRODUCAO_ROUTE = "erp-producao";

export interface ErpProductionOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  /** Partes do ERP que a operação exige (a dona primeiro). */
  parts: readonly ErpModuleId[];
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_PRODUCAO_ROUTE;
const P: readonly ErpModuleId[] = ["erp-producao"];
const ORDER_FIELDS = ["produto", "quantidade", "deposito_insumos", "deposito_acabado", "data_prevista", "responsavel", "observacoes", "insumos"] as const;
export const ERP_PRODUCTION_OPERATIONS: readonly ErpProductionOperation[] = Object.freeze([
  {
    name: "erp.producao.ordens", method: "GET", path: `${R}/ordens`, sensitive: false, parts: P, rpc: "erp_production_list",
    summary: "Consultar as ordens de produção",
    description: "Lista as ordens de produção com o produto, a quantidade, quanto já foi produzido, a data prevista, o responsável e a situação (rascunho, liberada, em produção, concluída ou cancelada). Filtra por situação (abertas, ou uma delas), período da data prevista e busca por produto, número ou responsável. Só consulta.",
    query: ["situacao", "busca", "de", "ate", "produto", "pagina"], body: [], required: [],
  },
  {
    name: "erp.producao.ordem", method: "GET", path: `${R}/ordens/:id`, sensitive: false, parts: P, rpc: "erp_production_get",
    summary: "Ver uma ordem de produção",
    description: "Mostra a ordem de produção com os insumos (quanto por unidade, perda prevista, quanto falta consumir e o saldo no depósito dos insumos) e os apontamentos (quantidade, lote, custo e estornos). Só consulta.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.producao.sugestoes", method: "GET", path: `${R}/planejamento`, sensitive: false, parts: P, rpc: "erp_production_plan",
    summary: "Ver as sugestões de produção pelos pedidos de venda",
    description: "Sugere ordens de produção para os produtos com composição cujo estoque não cobre os pedidos de venda em aberto (descontando o que já está em ordens abertas), com o que falta de cada insumo, e a lista de compras dos insumos que faltam. Precisa de Vendas ligado para ler os pedidos. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.producao.criar", method: "POST", path: `${R}/ordens`, sensitive: true, parts: P, rpc: "erp_production_save",
    summary: "Criar uma ordem de produção",
    description: "Cria uma ordem de produção do produto acabado na quantidade informada, com os insumos da composição do produto (ou a lista informada), o depósito dos insumos e o do acabado (o padrão, se não informar), a data prevista, o responsável e observações. Não mexe no estoque: o bot propõe e a pessoa confirma.",
    query: [], body: [...ORDER_FIELDS, "situacao", "comando"], required: ["produto", "quantidade"],
  },
  {
    name: "erp.producao.editar", method: "POST", path: `${R}/ordens/:id`, sensitive: true, parts: P, rpc: "erp_production_save",
    summary: "Editar uma ordem de produção",
    description: "Altera os dados e os insumos de uma ordem que ainda não foi concluída nem cancelada (troca de insumo, perda prevista, quantidade, depósitos, data e responsável). Pela tela.",
    query: [], body: ["versao", ...ORDER_FIELDS, "comando"], required: ["id", "versao"], bot: false,
  },
  {
    name: "erp.producao.situacao", method: "POST", path: `${R}/ordens/:id/situacao`, sensitive: true, parts: P, rpc: "erp_production_status",
    summary: "Mudar a situação de uma ordem de produção",
    description: "Libera, volta para rascunho, começa a produção, encerra (com o que já foi produzido) ou cancela (com motivo, sem apontamento ativo) uma ordem de produção. Pela tela.",
    query: [], body: ["versao", "acao", "motivo", "comando"], required: ["id", "versao", "acao"], bot: false,
  },
  {
    name: "erp.producao.previa", method: "GET", path: `${R}/ordens/:id/previa`, sensitive: false, parts: P, rpc: "erp_production_complete_preview",
    summary: "Conferir um apontamento antes de concluir",
    description: "Mostra o que um apontamento consumiria de cada insumo, o saldo no depósito dos insumos, o que falta, o custo dos insumos e o custo unitário do acabado, e se o Estoque permite concluir com saldo negativo. Só consulta.",
    query: ["quantidade", "custo_adicional", "consumo"], body: [], required: ["id"],
  },
  {
    name: "erp.producao.concluir", method: "POST", path: `${R}/ordens/:id/concluir`, sensitive: true, parts: P, rpc: "erp_production_complete",
    summary: "Concluir (apontar) a produção de uma ordem",
    description: "Aponta a quantidade produzida (total ou parcial): dá baixa dos insumos no depósito dos insumos e entrada do acabado no depósito do acabado, numa transação, com o custo dos insumos mais o custo adicional (mão de obra, energia), que atualiza o custo médio. Com lote no acabado quando o produto controla lote. Mexe no estoque: o bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "quantidade", "consumo", "custo_adicional", "lote", "observacao", "encerrar", "comando"], required: ["id", "versao", "quantidade"],
  },
  {
    name: "erp.producao.estornar", method: "POST", path: `${R}/apontamentos/:id/estorno`, sensitive: true, parts: P, rpc: "erp_production_reverse",
    summary: "Estornar um apontamento de produção",
    description: "Estorna um apontamento com motivo: devolve os insumos e tira o acabado do estoque, pelas guardas do Estoque. Não estorna se o acabado já saiu do depósito (venda, transferência ou outro uso). Mexe no estoque: o bot propõe e a pessoa confirma.",
    query: [], body: ["versao", "motivo", "comando"], required: ["id", "versao", "motivo"],
  },
  {
    name: "erp.producao.gerar", method: "POST", path: `${R}/planejamento/ordens`, sensitive: true, parts: P, rpc: "erp_production_plan_generate",
    summary: "Gerar as ordens sugeridas pelo planejamento",
    description: "Cria, como rascunho, as ordens de produção conferidas na tela de planejamento, ligadas aos pedidos de venda que as motivaram. Pela tela.",
    query: [], body: ["itens", "deposito_insumos", "deposito_acabado", "comando"], required: ["itens"], bot: false,
  },
  {
    name: "erp.producao.comprar", method: "POST", path: `${R}/planejamento/compras`, sensitive: true, parts: ["erp-producao", "erp-compras"], rpc: "erp_production_purchase",
    summary: "Transformar a lista de compras em pedido de compra",
    description: "Cria um pedido de compra por fornecedor com os insumos que faltam (o fornecedor padrão do produto, ou o escolhido). Precisa de Compras ligado. Pela tela.",
    query: [], body: ["itens", "comando"], required: ["itens"], bot: false,
  },
  {
    name: "erp.producao.opcoes", method: "GET", path: `${R}/opcoes`, sensitive: false, parts: P, rpc: "erp_production_options",
    summary: "Ver depósitos e regras da produção",
    description: "Depósitos, o depósito padrão, se o Estoque permite saldo negativo e quem pode gravar. Pela tela.",
    query: [], body: [], required: [], bot: false,
  },
  {
    name: "erp.producao.produtos", method: "GET", path: `${R}/produtos`, sensitive: false, parts: P, rpc: "erp_production_products",
    summary: "Procurar produto para fabricar ou insumo",
    description: "Procura produtos ativos pelo nome, código ou código de barras, para o produto acabado (com o motivo quando não pode ser fabricado) ou para insumo. Pela tela.",
    query: ["busca", "finalidade", "exceto"], body: [], required: ["busca"], bot: false,
  },
  {
    name: "erp.producao.composicao", method: "GET", path: `${R}/composicao`, sensitive: false, parts: P, rpc: "erp_production_composition",
    summary: "Ver os insumos da composição de um produto",
    description: "Mostra se o produto pode ser fabricado e os insumos da composição dele × a quantidade, com o saldo no depósito dos insumos. Pela tela.",
    query: ["produto", "quantidade", "deposito"], body: [], required: ["produto"], bot: false,
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpProductionOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_PRODUCTION_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const uuid = { type: "string", format: "uuid" };
const quantity = { type: "string", pattern: "^[0-9]{1,12}([.,][0-9]{1,6})?$", description: "Quantidade, como 10 ou 2.5." };
const money = { type: "string", pattern: "^[0-9]{1,13}([.,][0-9]{1,10})?$", description: "Valor em reais, como 35.50." };
const input = { type: "object", properties: { produto: uuid, por_unidade: quantity, perda: { ...quantity, description: "Perda prevista em %, como 5." } }, required: ["produto", "por_unidade"] };
/** Esquema de cada parâmetro (consulta, caminho e corpo). */
export const ERP_PRODUCTION_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  id: uuid, produto: uuid, quantidade: quantity, deposito_insumos: uuid, deposito_acabado: uuid, deposito: uuid, exceto: uuid,
  data_prevista: { type: "string", format: "date" }, de: { type: "string", format: "date" }, ate: { type: "string", format: "date" },
  responsavel: { type: "string", maxLength: 120 }, observacoes: { type: "string", maxLength: 2000 }, observacao: { type: "string", maxLength: 500 },
  insumos: { type: "array", maxItems: 100, items: input, description: "Insumos da ordem; sem eles, vêm da composição do produto." },
  situacao: { type: "string", enum: ["abertas", "todas", "rascunho", "liberada", "em_producao", "concluida", "cancelada"] },
  busca: { type: "string", maxLength: 120 }, pagina: { type: "integer", minimum: 1 }, versao: { type: "integer", minimum: 1 },
  acao: { type: "string", enum: ["liberar", "voltar_rascunho", "iniciar", "encerrar", "cancelar"] }, motivo: { type: "string", minLength: 3, maxLength: 400 },
  custo_adicional: money, encerrar: { type: "boolean", description: "Encerra a ordem com o que já foi produzido." },
  consumo: { type: "array", maxItems: 100, items: { type: "object", properties: { produto: uuid, quantidade: quantity }, required: ["produto", "quantidade"] },
    description: "Quantidade consumida de cada insumo, quando difere da prevista." },
  lote: { type: "object", properties: { codigo: { type: "string", maxLength: 60 }, fabricacao: { type: "string", format: "date" }, validade: { type: "string", format: "date" } }, required: ["codigo"] },
  finalidade: { type: "string", enum: ["acabado", "insumo"] },
  itens: { type: "array", maxItems: 100, items: { type: "object" } }, comando: uuid,
});

/** Parâmetros (caminho, consulta e corpo) num objeto, para o inventário dos bots. */
export function erpProductionParams(operation: ErpProductionOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_PRODUCTION_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...operation.required],
  };
}

export const ERP_PRODUCAO_MODULE_CONTRACT = {
  routes: [ERP_PRODUCAO_ROUTE], operations: ["erp.producao."],
  definition: { bot: { sensitive: ERP_PRODUCTION_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_PRODUCTION_OPERATIONS.map((op) => [op.name, op.summary])) } },
};

// ---------------------------------------------------------------------------
// Argumentos dos RPCs a partir da consulta, do caminho e do corpo.

/** Pedido com dado inválido (a rota responde 400 invalid_request com a mensagem). */
export class ProductionArgsError extends Error {}
const bad = (message: string): never => { throw new ProductionArgsError(message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidArg = (value: unknown, name: string, required = false): string | null => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: informe o identificador.`) : null;
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
};
const STATUS: Record<string, string> = { abertas: "open", todas: "all", rascunho: "draft", liberada: "released", em_producao: "in_progress", concluida: "done", cancelada: "cancelled" };
const ACTION: Record<string, string> = { liberar: "release", voltar_rascunho: "back_to_draft", iniciar: "start", encerrar: "finish", cancelar: "cancel" };
const list = (value: unknown, name: string): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== "object" || Array.isArray(v))) return bad(`${name}: envie uma lista.`);
  return value as Record<string, unknown>[];
};
const pick = (o: Record<string, unknown>, keys: readonly string[], name: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${name}: campo não aceito: ${extra.join(", ")}.`);
};
const inputs = (value: unknown) => list(value, "insumos").map((i) => {
  pick(i, ["produto", "por_unidade", "perda"], "insumos");
  return { product_id: uuidArg(i.produto, "insumos.produto", true), per_unit: i.por_unidade, ...(i.perda === undefined ? {} : { loss_percent: i.perda }) };
});
const consumptionArg = (value: unknown) => list(value, "consumo").map((i) => {
  pick(i, ["produto", "quantidade"], "consumo");
  return { product_id: uuidArg(i.produto, "consumo.produto", true), quantity: i.quantidade };
});
function orderData(body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const map: Record<string, string> = { produto: "product_id", quantidade: "quantity", deposito_insumos: "source_warehouse_id", deposito_acabado: "target_warehouse_id",
    data_prevista: "planned_on", responsavel: "responsible", observacoes: "notes" };
  for (const [from, to] of Object.entries(map)) if (body[from] !== undefined)
    data[to] = ["produto", "deposito_insumos", "deposito_acabado"].includes(from) ? uuidArg(body[from], from, from === "produto") : body[from];
  if (body.insumos !== undefined) data.inputs = inputs(body.insumos);
  return data;
}
const version = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : bad("versao: informe a versão da ordem que você conferiu."));

/** Os argumentos do RPC (p_args/p_data e p_command_id) a partir do pedido. */
export async function productionRpcArgs(operation: ErpProductionOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined,
  command: (body: Record<string, unknown>) => Promise<string>): Promise<Record<string, unknown>> {
  for (const key of query.keys()) if (!operation.query.includes(key) || query.getAll(key).length !== 1) bad(`Parâmetro não aceito: ${key}. Use ${operation.query.join(", ") || "nenhum"}.`);
  const q = (key: string) => { const v = query.get(key); return v === null || v === "" ? undefined : v; };
  const b = body ?? {};
  const write = async (data: Record<string, unknown>) => ({ p_command_id: await command(b), p_data: data });
  switch (operation.name) {
    case "erp.producao.ordens": {
      const status = q("situacao");
      if (status !== undefined && !Object.hasOwn(STATUS, status)) bad(`situacao: use ${Object.keys(STATUS).join(", ")}.`);
      const page = q("pagina");
      if (page !== undefined && !/^[1-9][0-9]{0,4}$/.test(page)) bad("pagina: use um número a partir de 1.");
      return { p_args: { ...(status ? { status: STATUS[status] } : {}), ...(q("busca") ? { q: q("busca") } : {}), ...(q("de") ? { from: q("de") } : {}),
        ...(q("ate") ? { to: q("ate") } : {}), ...(q("produto") ? { product_id: uuidArg(q("produto"), "produto") } : {}), ...(page ? { page: Number(page) } : {}) } };
    }
    case "erp.producao.ordem": return { p_args: { id: uuidArg(params.id, "id", true) } };
    case "erp.producao.sugestoes": case "erp.producao.opcoes": return { p_args: {} };
    case "erp.producao.produtos": {
      const purpose = q("finalidade") ?? "acabado";
      if (!["acabado", "insumo"].includes(purpose)) bad("finalidade: use acabado ou insumo.");
      return { p_args: { q: q("busca") ?? bad("busca: informe o nome, o código ou o código de barras."), purpose: purpose === "insumo" ? "input" : "finished",
        ...(q("exceto") ? { exclude: uuidArg(q("exceto"), "exceto") } : {}) } };
    }
    case "erp.producao.composicao":
      return { p_args: { product_id: uuidArg(q("produto"), "produto", true), ...(q("quantidade") ? { quantity: q("quantidade") } : {}),
        ...(q("deposito") ? { source_warehouse_id: uuidArg(q("deposito"), "deposito") } : {}) } };
    case "erp.producao.previa": {
      let consumption: unknown;
      if (q("consumo")) { try { consumption = consumptionArg(JSON.parse(q("consumo")!)); } catch (e) { if (e instanceof ProductionArgsError) throw e; bad("consumo: envie a lista em JSON."); } }
      return { p_args: { id: uuidArg(params.id, "id", true), ...(q("quantidade") ? { quantity: q("quantidade") } : {}),
        ...(q("custo_adicional") ? { extra_cost: q("custo_adicional") } : {}), ...(consumption ? { inputs: consumption } : {}) } };
    }
    case "erp.producao.criar": {
      const status = b.situacao === undefined ? undefined : b.situacao === "rascunho" ? "draft" : b.situacao === "liberada" ? "released" : bad("situacao: use rascunho ou liberada.");
      return write({ ...orderData(b), ...(status ? { status } : {}) });
    }
    case "erp.producao.editar": return write({ id: uuidArg(params.id, "id", true), expected_version: version(b.versao), ...orderData(b) });
    case "erp.producao.situacao": {
      const action = typeof b.acao === "string" && Object.hasOwn(ACTION, b.acao) ? ACTION[b.acao] : bad(`acao: use ${Object.keys(ACTION).join(", ")}.`);
      return write({ id: uuidArg(params.id, "id", true), expected_version: version(b.versao), action, ...(b.motivo !== undefined ? { reason: b.motivo } : {}) });
    }
    case "erp.producao.concluir": {
      let lot: Record<string, unknown> | undefined;
      if (b.lote !== undefined && b.lote !== null) {
        if (typeof b.lote !== "object" || Array.isArray(b.lote)) bad("lote: envie código, fabricação e validade.");
        const l = b.lote as Record<string, unknown>;
        pick(l, ["codigo", "fabricacao", "validade"], "lote");
        lot = { code: l.codigo, ...(l.fabricacao ? { manufactured_on: l.fabricacao } : {}), ...(l.validade ? { expires_on: l.validade } : {}) };
      }
      if (b.encerrar !== undefined && typeof b.encerrar !== "boolean") bad("encerrar: use verdadeiro ou falso.");
      return write({ id: uuidArg(params.id, "id", true), expected_version: version(b.versao), quantity: b.quantidade,
        ...(b.consumo !== undefined ? { inputs: consumptionArg(b.consumo) } : {}), ...(b.custo_adicional !== undefined ? { extra_cost: b.custo_adicional } : {}),
        ...(lot ? { lot } : {}), ...(b.observacao !== undefined ? { note: b.observacao } : {}), ...(b.encerrar !== undefined ? { finish: b.encerrar } : {}) });
    }
    case "erp.producao.estornar": return write({ completion_id: uuidArg(params.id, "id", true), expected_version: version(b.versao), reason: b.motivo });
    case "erp.producao.gerar":
      return write({ items: list(b.itens, "itens").map((i) => {
        pick(i, ["produto", "quantidade", "pedidos"], "itens");
        return { product_id: uuidArg(i.produto, "itens.produto", true), quantity: i.quantidade, ...(i.pedidos !== undefined ? { sales_order_ids: i.pedidos } : {}) };
      }), ...(b.deposito_insumos ? { source_warehouse_id: uuidArg(b.deposito_insumos, "deposito_insumos") } : {}),
        ...(b.deposito_acabado ? { target_warehouse_id: uuidArg(b.deposito_acabado, "deposito_acabado") } : {}) });
    case "erp.producao.comprar":
      return write({ items: list(b.itens, "itens").map((i) => {
        pick(i, ["produto", "quantidade", "fornecedor"], "itens");
        return { product_id: uuidArg(i.produto, "itens.produto", true), quantity: i.quantidade, ...(i.fornecedor ? { supplier_id: uuidArg(i.fornecedor, "itens.fornecedor") } : {}) };
      }) });
  }
  return bad("Operação desconhecida.");
}
