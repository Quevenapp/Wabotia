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
  /** Assunto no inventário de concessões dos bots (padrão: conversa). */
  group?: "conversa" | "financeiro";
  /** false: só pela tela (preferência do administrador), fora do inventário dos bots. */
  bot?: boolean;
  /** Pede acesso às conversas (o envio); a cobrança da conta não. */
  conversations?: boolean;
  /** Campos aceitos a mais (no corpo ou na consulta), só pela tela: conta a receber, como o cliente paga. */
  optional?: readonly string[];
}

/** Cobrança de conta a receber (src/erp/conversa/charges.ts), no mesmo segmento de rota; casadas antes das rotas com :tipo. */
export const ERP_CHARGE_OPERATIONS: readonly ErpConversaOperation[] = Object.freeze([
  {
    name: "erp.financeiro.cobranca.preferencias", method: "GET", path: `${ERP_CONVERSA_ROUTE}/financeiro/preferencias`, sensitive: false,
    summary: "Ver a preferência de baixa das contas pagas por Pix ou link",
    description: "Mostra se o Financeiro baixa sozinho as contas a receber pagas por Pix ou link da Cobrança, a conta financeira e a forma de pagamento das baixas. Só consulta.",
    body: [], required: [], query: [], group: "financeiro", bot: false, conversations: false,
  },
  {
    name: "erp.financeiro.cobranca.preferencias.salvar", method: "POST", path: `${ERP_CONVERSA_ROUTE}/financeiro/preferencias`, sensitive: true,
    summary: "Mudar a preferência de baixa das contas pagas por Pix ou link",
    description: "Liga ou desliga \"Baixar sozinho as contas pagas por Pix ou link\" e escolhe a conta financeira e a forma de pagamento das baixas. Só o administrador; ligar pede a confirmação do aviso e fica registrado.",
    body: ["baixar_sozinho", "conta_financeira", "forma_pagamento", "confirmo"], required: [], query: [], group: "financeiro", bot: false, conversations: false,
  },
  {
    name: "erp.financeiro.cobranca.ver", method: "GET", path: `${ERP_CONVERSA_ROUTE}/conta/:id/cobranca`, sensitive: false,
    summary: "Ver as cobranças por Pix ou link de uma conta a receber",
    description: "Mostra as cobranças por Pix ou link geradas para a conta a receber, a situação de cada uma (aguardando, paga, baixada, sugestão de baixa ou pendência) e o que falta configurar na Cobrança. Só consulta.",
    body: [], required: [], query: [], group: "financeiro", conversations: false,
  },
  {
    name: "erp.financeiro.cobranca.gerar", method: "POST", path: `${ERP_CONVERSA_ROUTE}/conta/:id/cobranca`, sensitive: true,
    summary: "Gerar cobrança por Pix ou link de uma conta a receber",
    description: "Cria, pela Cobrança configurada na área, um Pix (copia e cola e QR) ou um link de pagamento com o saldo da conta a receber em aberto. Quando o provedor confirma o pagamento, a conta é baixada sozinha (se o administrador ligou a opção) ou vira sugestão de baixa. Gerar de novo com a conta igual devolve a mesma cobrança. O bot propõe e a pessoa confirma.",
    body: ["forma"], required: ["forma"], query: [], group: "financeiro", conversations: false,
  },
  {
    name: "erp.financeiro.cobranca.confirmar_baixa", method: "POST", path: `${ERP_CONVERSA_ROUTE}/conta/:id/cobranca/:cobranca/baixar`, sensitive: true,
    summary: "Confirmar a sugestão de baixa de uma conta paga por Pix ou link",
    description: "Baixa a conta a receber pelo pagamento que o provedor confirmou, na conta financeira escolhida, com o comprovante do provedor na observação. Exige o papel de baixar contas a receber no ERP. Se a conta foi baixada ou mudada à mão depois da cobrança, não baixa e avisa. O bot propõe e a pessoa confirma.",
    body: ["conta_financeira", "forma_pagamento"], required: [], query: [], group: "financeiro", conversations: false,
  },
]);

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
    body: [], required: [], query: ["telefone", "linha", "xml"], optional: ["pagamento"],
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
    body: ["telefone", "linha", "xml", "acao"], required: ["telefone", "linha"], query: [], optional: ["pagamento"],
  },
]);

const propertySchemas: Record<string, Record<string, unknown>> = {
  tipo: { type: "string", enum: [...ERP_CONVERSA_DOC_TYPES], description: "proposta, pedido, nota (NF-e comercial) ou conta (conta a receber)." },
  id: { type: "string", format: "uuid", description: "Documento no ERP (para nota, a emissão da NF-e comercial)." },
  telefone: { type: "string", minLength: 8, maxLength: 30, description: "Telefone com DDD (e DDI fora do Brasil). Fora do cadastro do cliente fica registrado como tal." },
  linha: { type: "string", minLength: 1, maxLength: 100, description: "Linha de WhatsApp da área (id da conexão)." },
  xml: { type: "boolean", description: "Nota fiscal: anexar também o XML." },
  acao: { type: "string", enum: ["enviar", "copiar_link"], default: "enviar", description: "copiar_link não envia: devolve o link de leitura para copiar." },
  forma: { type: "string", enum: ["pix", "link"], description: "pix (copia e cola e QR) ou link de pagamento." },
  pagamento: { type: "string", enum: ["pix", "link", "boleto", "sem"], description: "Conta a receber: como o cliente paga (Pix ou link da Cobrança, que confirmam sozinhos; boleto em PDF, se a conta tem boleto; sem: só o aviso)." },
  cobranca: { type: "string", minLength: 1, maxLength: 64, description: "Cobrança da conta (id devolvido ao gerar)." },
  conta_financeira: { type: ["string", "null"], format: "uuid", description: "Conta financeira do ERP onde o pagamento entra." },
  forma_pagamento: { type: ["string", "null"], format: "uuid", description: "Forma de pagamento do ERP registrada na baixa." },
  baixar_sozinho: { type: "boolean", description: "Baixar sozinho as contas pagas por Pix ou link (nasce desligado)." },
  confirmo: { type: "boolean", description: "Confirma o aviso ao ligar a baixa automática." },
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
  for (const operation of [...ERP_CHARGE_OPERATIONS, ...ERP_CONVERSA_OPERATIONS]) {
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
      description: `${op.description} Permissão: ${op.conversations === false ? "erp e o Financeiro do ERP" : "erp e conversas"}. ${op.sensitive ? "Categoria sensível; por padrão o bot propõe e a pessoa confirma." : "Leitura comum."}`,
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
