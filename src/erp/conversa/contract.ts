// ERP pela conversa: enviar ao cliente, pelo WhatsApp da própria área, a
// proposta comercial, o pedido de venda, a nota fiscal autorizada (DANFE e,
// se pedido, o XML) e a cobrança de uma conta a receber em aberto.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP, para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts). Enviar é sensível: o bot propõe e a pessoa
// confirma. As rotas do Worker ficam em src/erp/conversa/routes.ts.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Segmento das rotas no Worker (módulo erp: desligado, 409 module_disabled). */
export const ERP_CONVERSA_ROUTE = "erp-conversa";

export type ErpConversaDocType = "proposta" | "pedido" | "nota" | "conta";
export const ERP_CONVERSA_DOC_TYPES: readonly ErpConversaDocType[] = Object.freeze(["proposta", "pedido", "nota", "conta"]);

/** Parte do ERP de cada documento (src/erp/parts.ts). */
export const ERP_CONVERSA_PARTS: Readonly<Record<ErpConversaDocType, "erp-vendas" | "erp-fiscal" | "erp-financeiro">> = Object.freeze({
  proposta: "erp-vendas", pedido: "erp-vendas", nota: "erp-fiscal", conta: "erp-financeiro",
});

export interface ErpConversaOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  body: readonly string[];
  required: readonly string[];
  query: readonly string[];
}

export const ERP_CONVERSA_OPERATIONS: readonly ErpConversaOperation[] = Object.freeze([
  {
    name: "erp.conversa.linhas", method: "GET", path: ERP_CONVERSA_ROUTE, sensitive: false,
    summary: "Ver as linhas de WhatsApp que podem enviar documentos do ERP",
    description: "Lista as linhas de WhatsApp ativas da área por onde a pessoa pode mandar documentos do ERP ao cliente. Sem linha, a tela diz para conectar uma em Conexões. Só consulta.",
    body: [], required: [], query: [],
  },
  {
    name: "erp.conversa.preparar", method: "GET", path: `${ERP_CONVERSA_ROUTE}/:tipo/:id`, sensitive: false,
    summary: "Preparar o envio de um documento do ERP pelo WhatsApp",
    description: "Mostra o cliente do documento e os telefones do cadastro dele, as linhas da área, a prévia da mensagem e do anexo e como o envio sai pela regra do WhatsApp (arquivo, link ou modelo aprovado; fora da janela de 24 horas sem modelo, só copiar o link). Tipos: proposta, pedido, nota e conta. Só consulta, sem enviar nada.",
    body: [], required: [], query: ["telefone", "linha", "xml"],
  },
  {
    name: "erp.conversa.envios", method: "GET", path: `${ERP_CONVERSA_ROUTE}/:tipo/:id/envios`, sensitive: false,
    summary: "Ver os envios de um documento do ERP pelo WhatsApp",
    description: "Lista quando o documento foi enviado pelo WhatsApp, a que número, por quem e o estado de entrega que a conversa conhece (enviado, entregue, lido ou falhou e por quê). Só consulta.",
    body: [], required: [], query: [],
  },
  {
    name: "erp.conversa.enviar", method: "POST", path: `${ERP_CONVERSA_ROUTE}/:tipo/:id/enviar`, sensitive: true,
    summary: "Enviar um documento do ERP ao cliente pelo WhatsApp",
    description: "Envia ao cliente, pela linha de WhatsApp escolhida, a proposta, o pedido, a nota fiscal autorizada (DANFE e, se pedido, o XML) ou a cobrança da conta a receber em aberto. Respeita a janela de 24 horas: dentro dela vai a mensagem com o arquivo; fora dela, só pelo modelo aprovado da área, com link seguro. Com acao=copiar_link não envia nada e devolve o link público de leitura para a pessoa copiar. Exige poder ver o documento no ERP e atender naquela linha. Pelo bot, o cliente só recebe documento que é dele, no telefone do cadastro e na conversa com identidade conferida; o bot propõe e a pessoa confirma.",
    body: ["telefone", "linha", "xml", "acao"], required: ["telefone", "linha"], query: [],
  },
]);

const propertySchemas: Record<string, Record<string, unknown>> = {
  tipo: { type: "string", enum: [...ERP_CONVERSA_DOC_TYPES], description: "proposta, pedido, nota (NF-e comercial) ou conta (conta a receber)." },
  id: { type: "string", format: "uuid", description: "Documento no ERP (para nota, a emissão da NF-e comercial)." },
  telefone: { type: "string", minLength: 8, maxLength: 30, description: "Telefone com DDD (e DDI fora do Brasil). Fora do cadastro do cliente fica registrado como tal." },
  linha: { type: "string", minLength: 1, maxLength: 100, description: "Linha de WhatsApp da área (id da conexão)." },
  xml: { type: "boolean", description: "Nota fiscal: anexar também o XML." },
  acao: { type: "string", enum: ["enviar", "copiar_link"], default: "enviar", description: "copiar_link não envia: devolve o link de leitura para copiar." },
};

/** Parâmetros (caminho, consulta e corpo) num objeto, para o catálogo do bot. */
export function erpConversaParams(operation: ErpConversaOperation) {
  const keys = [...(operation.path.match(/:[a-z_]+/g) ?? []).map(key => key.slice(1)), ...operation.query, ...operation.body];
  const required = [...(operation.path.match(/:[a-z_]+/g) ?? []).map(key => key.slice(1)), ...operation.required];
  return { type: "object" as const, properties: Object.fromEntries(keys.map(key => [key, propertySchemas[key]])), required };
}

export const erpConversaOperation = (name: string) => ERP_CONVERSA_OPERATIONS.find(operation => operation.name === name) ?? null;

/** A operação de uma rota do Worker (caminho depois de /api/v1/profiles/:profile/). */
export function erpConversaOperationFor(method: string, path: string): { operation: ErpConversaOperation; params: Record<string, string> } | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const parts = path.replace(/\/$/, "").split("/");
  for (const operation of ERP_CONVERSA_OPERATIONS) {
    if (operation.method !== verb) continue;
    const pattern = operation.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((segment, index) => segment.startsWith(":") ? (params[segment.slice(1)] = parts[index]!, parts[index] !== "") : segment === parts[index]))
      return { operation, params };
  }
  return null;
}

/** Contrato leve: rotas e operações do módulo erp, catálogo dos bots e OpenAPI. */
export const ERP_CONVERSA_MODULE_CONTRACT = {
  routes: [ERP_CONVERSA_ROUTE], operations: ["erp.conversa."],
  definition: { bot: { sensitive: ERP_CONVERSA_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(ERP_CONVERSA_OPERATIONS.map(op => [op.name, op.summary])) } },
  openapi: { paths: Object.fromEntries([...new Set(ERP_CONVERSA_OPERATIONS.map(op => op.path))].map(path => [
    `/profiles/{profile}/${path.replace(/:([a-z_]+)/g, "{$1}")}`,
    Object.fromEntries(ERP_CONVERSA_OPERATIONS.filter(op => op.path === path).map(op => [op.method.toLowerCase(), {
      operationId: op.name, summary: op.summary,
      description: `${op.description} Permissão: erp e conversas. ${op.sensitive ? "Categoria sensível; por padrão o bot propõe e a pessoa confirma." : "Leitura comum."}`,
      parameters: [{ name: "profile", in: "path", required: true, schema: { type: "string" } },
        ...(path.match(/:[a-z_]+/g) ?? []).map(key => ({ name: key.slice(1), in: "path", required: true, schema: propertySchemas[key.slice(1)] })),
        ...op.query.map(name => ({ name, in: "query", required: false, schema: name === "xml" ? { type: "string", enum: ["1", "0"] } : propertySchemas[name] }))],
      ...(op.method === "GET" ? {} : { requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(op.body.map(key => [key, propertySchemas[key]])), required: [...op.required] } } } } }),
      responses: { "200": { description: "Resultado" }, "403": { description: "Sem permissão no ERP ou na linha, ou dado restrito" },
        "404": { description: "Documento não encontrado" }, "409": { description: "Parte desligada, janela de 24 horas ou linha indisponível" } },
    }])),
  ])) },
};
