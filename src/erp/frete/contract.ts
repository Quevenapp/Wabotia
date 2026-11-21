// Frete e transportadoras da Expedição (parte erp-expedicao), em
// /api/v1/profiles/:profile/erp-expedicao/frete. A rota da Expedição entrega
// estes caminhos ao serviço de frete (./routes.ts): o módulo e a parte são os
// da Expedição, e a parte desligada recusa com 409 module_disabled.
//
// Para os bots (src/modules/erp/bot-access.ts, assunto "Frete e rastreio"):
// ver o frete do pedido, cotar e consultar o rastreio são leitura; contratar e
// cancelar o envio são sensíveis (o bot propõe e a pessoa confirma). Escolher
// o serviço na tela, baixar a etiqueta, atualizar o rastreio à mão e
// configurar os provedores são só da tela.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { ERP_EXPEDICAO_ROUTE } from "../expedicao/contract.ts";

/** Depois de /api/v1/profiles/:profile/. */
export const ERP_FRETE_ROUTE = `${ERP_EXPEDICAO_ROUTE}/frete`;

export interface ErpFreightOperation {
  name: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
  /** Só o administrador do ERP (configuração dos provedores). */
  admin?: boolean;
}

const R = ERP_FRETE_ROUTE;
export const ERP_FREIGHT_OPERATIONS: readonly ErpFreightOperation[] = Object.freeze([
  {
    name: "erp.expedicao.frete.pedido", method: "GET", path: `${R}/pedidos/:id`, sensitive: false,
    summary: "Ver o frete e o rastreio de um pedido",
    description: "Mostra o serviço de frete escolhido para o pedido de venda (provedor, preço e prazo), o envio contratado com o código de rastreio e a linha do tempo do rastreio. Só consulta.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.expedicao.frete.cotar", method: "GET", path: `${R}/pedidos/:id/cotacao`, sensitive: false,
    summary: "Cotar o frete de um pedido",
    description: "Cota o frete do pedido de venda nos provedores ligados (Correios e Melhor Envio), do CEP da loja ao CEP do cliente com os volumes da expedição, e lista os serviços com preço e prazo. Não grava nada no pedido.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.expedicao.frete.escolher", method: "POST", path: `${R}/pedidos/:id/escolha`, sensitive: true, bot: false,
    summary: "Escolher o serviço de frete do pedido",
    description: "Grava no pedido o serviço escolhido da cotação, com o valor do frete e o prazo. Pela tela.",
    query: [], body: ["cotacao", "servico"], required: ["cotacao", "servico"],
  },
  {
    name: "erp.expedicao.frete.contratar", method: "POST", path: `${R}/pedidos/:id/envio`, sensitive: true,
    summary: "Contratar o envio e gerar a etiqueta oficial",
    description: "Contrata o envio do pedido no provedor do serviço escolhido (ou no serviço informado da cotação), gera a etiqueta oficial e grava o código de rastreio no pedido. Pode cobrar do contrato ou da carteira do provedor. O bot propõe e a pessoa confirma.",
    query: [], body: ["cotacao", "servico"], required: [],
  },
  {
    name: "erp.expedicao.frete.cancelar", method: "POST", path: `${R}/pedidos/:id/envio/cancelar`, sensitive: true,
    summary: "Cancelar o envio contratado",
    description: "Cancela no provedor o envio contratado do pedido (quando o provedor ainda permite, em geral antes da postagem) e tira o código de rastreio do pedido. O bot propõe e a pessoa confirma.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.expedicao.frete.etiqueta", method: "GET", path: `${R}/pedidos/:id/etiqueta`, sensitive: false, bot: false,
    summary: "Baixar a etiqueta oficial em PDF",
    description: "A etiqueta oficial do provedor, em PDF, do envio contratado do pedido. Pela tela.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.expedicao.frete.rastrear", method: "POST", path: `${R}/pedidos/:id/rastreio`, sensitive: true, bot: false,
    summary: "Atualizar o rastreio agora",
    description: "Consulta o rastreio no provedor agora (sem esperar a rodada automática) e acrescenta os eventos novos à linha do tempo. Pela tela.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.expedicao.frete.provedores", method: "GET", path: `${R}/provedores`, sensitive: false, bot: false, admin: true,
    summary: "Ver os provedores de frete",
    description: "Lista os provedores de frete (Correios e Melhor Envio), se estão ligados, em sandbox ou produção, quais credenciais já estão no cofre (sem mostrá-las), o último teste e os ajustes da área. Pela tela.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.expedicao.frete.provedor.salvar", method: "POST", path: `${R}/provedores/:provedor`, sensitive: true, bot: false, admin: true,
    summary: "Configurar um provedor de frete",
    description: "Liga ou desliga o provedor, escolhe sandbox ou produção, guarda as credenciais digitadas no cofre e as opções. Só o administrador do ERP. Pela tela.",
    query: [], body: ["ligado", "sandbox", "credenciais", "opcoes"], required: [],
  },
  {
    name: "erp.expedicao.frete.provedor.testar", method: "POST", path: `${R}/provedores/:provedor/testar`, sensitive: true, bot: false, admin: true,
    summary: "Testar a conexão com um provedor de frete",
    description: "Confere as credenciais no provedor (no modo escolhido) e guarda o resultado. Só o administrador do ERP. Pela tela.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.expedicao.frete.ajustes", method: "POST", path: `${R}/ajustes`, sensitive: true, bot: false, admin: true,
    summary: "Ajustes do frete da área",
    description: "O aviso ao cliente pelo WhatsApp a cada mudança no rastreio (desligado por padrão) e o CEP de origem, quando não for o da empresa. Só o administrador do ERP. Pela tela.",
    query: [], body: ["avisar_whatsapp", "cep_origem"], required: [],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpFreightOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_FREIGHT_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const uuid = { type: "string", format: "uuid" };
export const ERP_FREIGHT_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  id: uuid, cotacao: { ...uuid, description: "A cotação (campo id da resposta de cotar)." },
  servico: { type: "string", maxLength: 80, description: "O serviço da cotação (campo option de cada serviço, como \"correios:03220\")." },
  provedor: { type: "string", enum: ["correios", "melhorenvio"] },
  ligado: { type: "boolean" }, sandbox: { type: "boolean" }, credenciais: { type: "object" }, opcoes: { type: "object" },
  avisar_whatsapp: { type: "boolean" }, cep_origem: { type: "string", pattern: "^[0-9]{5}-?[0-9]{3}$" },
});

/** Parâmetros (caminho e corpo) num objeto, para o inventário dos bots. */
export function erpFreightParams(operation: ErpFreightOperation) {
  const path = (operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1));
  const keys = [...path, ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_FREIGHT_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...new Set([...path, ...operation.required])],
  };
}
