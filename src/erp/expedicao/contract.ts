// Expedição do ERP (parte erp-expedicao, depende de Vendas e Estoque), em
// /api/v1/profiles/:profile/erp-expedicao.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP, para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts, assunto Expedição). Consultar a expedição é
// leitura comum; gerar separação, marcar expedido e registrar devolução são
// sensíveis (o bot propõe e a pessoa confirma). As outras gravações são só da
// tela. As rotas ficam em ./routes.ts; com a parte desligada a rota responde
// 409 module_disabled dizendo o que ligar.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp-expedicao). */
export const ERP_EXPEDICAO_ROUTE = "erp-expedicao";
/** A parte dona; as dependências (Vendas, Estoque) vêm do contrato das partes. */
export const ERP_EXPEDICAO_PART: ErpModuleId = "erp-expedicao";

export interface ErpShippingOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  /** O RPC do motor; a entrega local chama dois (preparo e registro) e o módulo Entrega entre eles. */
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_EXPEDICAO_ROUTE;
export const ERP_SHIPPING_OPERATIONS: readonly ErpShippingOperation[] = Object.freeze([
  {
    name: "erp.expedicao.pedidos", method: "GET", path: `${R}/pedidos`, sensitive: false, rpc: "erp_shipping_overview",
    summary: "Ver os pedidos na expedição",
    description: "Lista os pedidos de venda na expedição com a situação (a separar, em separação, separado, embalado ou expedido), filtrados por data do pedido, transportadora e depósito, com as listas de separação abertas e quantos pedidos há em cada situação. Só consulta.",
    query: ["situacao", "de", "ate", "transportadora", "deposito", "busca"], body: [], required: [],
  },
  {
    name: "erp.expedicao.pedido", method: "GET", path: `${R}/pedidos/:id`, sensitive: false, rpc: "erp_shipping_order_get",
    summary: "Ver a expedição de um pedido",
    description: "Mostra um pedido de venda na expedição: destinatário e endereço, transportadora, itens, pendências da separação, volumes com pesos e medidas, devoluções e, com Fiscal ligado, a nota do pedido. Só consulta.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.expedicao.separacao", method: "GET", path: `${R}/separacoes/:id`, sensitive: false, rpc: "erp_shipping_pick_get",
    summary: "Ver uma lista de separação",
    description: "Mostra a lista de separação com os itens somados por produto e endereço/depósito, quanto já foi separado e de quais pedidos. Só consulta.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.expedicao.embalagens", method: "GET", path: `${R}/embalagens`, sensitive: false, rpc: "erp_shipping_packages",
    summary: "Ver as embalagens cadastradas",
    description: "Lista as embalagens da expedição com medidas (cm) e peso vazio (kg). Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.expedicao.romaneio", method: "GET", path: `${R}/romaneio`, sensitive: false, rpc: "erp_shipping_manifest",
    summary: "Ver o romaneio de expedição por transportadora",
    description: "Lista os pedidos expedidos no período, por transportadora, com volumes, peso e código de rastreio. Só consulta.",
    query: ["de", "ate", "transportadora"], body: [], required: [],
  },
  {
    name: "erp.expedicao.etiquetas", method: "GET", path: `${R}/etiquetas`, sensitive: false, rpc: "erp_shipping_labels",
    summary: "Dados das etiquetas de volume", bot: false,
    description: "Destinatário, endereço, pedido, volume N de M e código de barras de cada volume dos pedidos, para imprimir as etiquetas. Pela tela.",
    query: ["pedidos"], body: [], required: ["pedidos"],
  },
  {
    name: "erp.expedicao.separacao.gerar", method: "POST", path: `${R}/separacoes`, sensitive: true, rpc: "erp_shipping_pick_create",
    summary: "Gerar uma lista de separação",
    description: "Junta os pedidos de venda escolhidos (todos a separar) numa lista de separação, com os itens somados por produto e endereço; os pedidos passam a em separação. O bot propõe e a pessoa confirma.",
    query: [], body: ["pedidos", "filtros", "comando"], required: ["pedidos"],
  },
  {
    name: "erp.expedicao.separacao.marcar", method: "POST", path: `${R}/separacoes/:id/marcar`, sensitive: true, rpc: "erp_shipping_pick_mark", bot: false,
    summary: "Marcar quanto foi separado de um item",
    description: "Grava a quantidade separada de uma linha da lista (dividida entre os pedidos, do mais antigo para o mais novo). Pela tela, com ou sem leitura de código de barras.",
    query: [], body: ["versao", "linha", "separado"], required: ["versao", "linha", "separado"],
  },
  {
    name: "erp.expedicao.separacao.concluir", method: "POST", path: `${R}/separacoes/:id/concluir`, sensitive: true, rpc: "erp_shipping_pick_finish", bot: false,
    summary: "Concluir a separação",
    description: "Encerra a lista: o que faltou vira pendência e ocorrência no pedido, e os pedidos ficam separados. Pela tela.",
    query: [], body: ["versao", "comando"], required: ["versao"],
  },
  {
    name: "erp.expedicao.separacao.cancelar", method: "POST", path: `${R}/separacoes/:id/cancelar`, sensitive: true, rpc: "erp_shipping_pick_cancel", bot: false,
    summary: "Cancelar a lista de separação",
    description: "Desfaz a lista aberta; os pedidos voltam para a separar. Pela tela.",
    query: [], body: ["versao", "comando"], required: ["versao"],
  },
  {
    name: "erp.expedicao.pendencia.resolver", method: "POST", path: `${R}/pendencias/:id/resolver`, sensitive: true, rpc: "erp_shipping_pending_resolve", bot: false,
    summary: "Dar uma pendência da separação por resolvida",
    description: "Marca a falta da separação como resolvida, com uma observação. Pela tela.",
    query: [], body: ["observacao", "comando"], required: [],
  },
  {
    name: "erp.expedicao.embalagem.salvar", method: "POST", path: `${R}/embalagens`, sensitive: true, rpc: "erp_shipping_package_save", bot: false,
    summary: "Cadastrar ou alterar uma embalagem",
    description: "Grava nome, medidas (cm) e peso vazio (kg) de uma embalagem. Pela tela.",
    query: [], body: ["id", "versao", "nome", "comprimento", "largura", "altura", "peso_vazio", "ativa", "comando"], required: ["nome"],
  },
  {
    name: "erp.expedicao.volumes", method: "POST", path: `${R}/pedidos/:id/volumes`, sensitive: true, rpc: "erp_shipping_pack", bot: false,
    summary: "Montar os volumes do pedido",
    description: "Grava quais itens vão em cada embalagem, com medidas e pesos calculados; o pedido fica embalado. Com Fiscal ligado, a quantidade de volumes e o peso bruto vão para o transporte do pedido (a nota usa esses dados quando for emitida). Pela tela.",
    query: [], body: ["versao", "volumes", "comando"], required: ["versao", "volumes"],
  },
  {
    name: "erp.expedicao.expedir", method: "POST", path: `${R}/expedir`, sensitive: true, rpc: "erp_shipping_ship",
    summary: "Marcar pedidos como expedidos",
    description: "Marca como expedidos os pedidos já embalados (com o código de rastreio, quando for um pedido só). O bot propõe e a pessoa confirma.",
    query: [], body: ["pedidos", "rastreio", "comando"], required: ["pedidos"],
  },
  {
    name: "erp.expedicao.entrega_local", method: "POST", path: `${R}/pedidos/:id/entrega-local`, sensitive: true, rpc: "erp_shipping_delivery_prepare", bot: false,
    summary: "Criar a entrega local do pedido",
    description: "Cria, no módulo Entrega, a entrega do pedido expedido com entrega própria (uma por pedido). Exige o módulo Entrega ligado. Pela tela.",
    query: [], body: ["entregador"], required: [],
  },
  {
    name: "erp.expedicao.devolucao", method: "POST", path: `${R}/pedidos/:id/devolucoes`, sensitive: true, rpc: "erp_shipping_return_create",
    summary: "Registrar a devolução física de um pedido",
    description: "Registra a mercadoria que voltou do pedido (itens, motivo e estado: volta ao estoque, avariado ou descarte); o que volta ao estoque entra no depósito. Não emite nota: com Fiscal ligado e nota autorizada, a resposta traz o atalho para a devolução fiscal. O bot propõe e a pessoa confirma.",
    query: [], body: ["motivo", "deposito", "itens", "comando"], required: ["motivo", "itens"],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpShippingOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_SHIPPING_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const date = { type: "string", format: "date" };
const uuid = { type: "string", format: "uuid" };
const decimal = (what: string) => ({ type: "string", pattern: "^[0-9]{1,12}([.,][0-9]{1,6})?$", description: what });
/** Esquema de cada parâmetro (consulta, caminho e corpo). */
export const ERP_SHIPPING_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  id: uuid, de: date, ate: date, deposito: uuid, comando: uuid,
  situacao: { type: "string", enum: ["a_separar", "em_separacao", "separado", "embalado", "expedido", "todas"] },
  transportadora: { type: "string", description: "Transportadora (uuid) ou \"sem\" para os pedidos sem transportadora." },
  busca: { type: "string", maxLength: 100, description: "Número do pedido ou parte do nome do cliente." },
  pedidos: { type: "array", minItems: 1, maxItems: 100, items: uuid },
  filtros: { type: "object", description: "Os filtros usados para escolher os pedidos (só para registro)." },
  rastreio: { type: "string", maxLength: 200 },
  motivo: { type: "string", minLength: 3, maxLength: 500 },
  itens: { type: "array", minItems: 1, maxItems: 250, items: { type: "object", required: ["linha", "quantidade", "estado"], properties: {
    linha: { type: "string", description: "A linha do item no pedido (campo key da expedição do pedido)." }, quantidade: decimal("Quantidade que voltou."),
    estado: { type: "string", enum: ["volta_ao_estoque", "avariado", "descarte"] } } } },
  versao: { type: "integer", minimum: 0 }, linha: { type: "string" }, separado: decimal("Quantidade separada da linha."),
  observacao: { type: "string", maxLength: 500 }, nome: { type: "string", minLength: 1, maxLength: 80 },
  comprimento: decimal("Centímetros."), largura: decimal("Centímetros."), altura: decimal("Centímetros."), peso_vazio: decimal("Quilos."), ativa: { type: "boolean" },
  volumes: { type: "array", minItems: 1, maxItems: 999 }, entregador: { type: "string", description: "Pessoa com o papel de entregador, ou \"me\"." },
});

/** Parâmetros (caminho, consulta e corpo) num objeto, para o inventário dos bots. */
export function erpShippingParams(operation: ErpShippingOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_SHIPPING_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...new Set([...(operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1)), ...operation.required])],
  };
}

export const ERP_EXPEDICAO_MODULE_CONTRACT = {
  routes: [ERP_EXPEDICAO_ROUTE], operations: ["erp.expedicao."],
  definition: { bot: { sensitive: ERP_SHIPPING_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_SHIPPING_OPERATIONS.map((op) => [op.name, op.summary])) } },
};
